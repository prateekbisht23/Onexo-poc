// Persistent Claude Code sessions inside CubeSandbox microVMs.
//
// One conversation = one microVM: created on the first message, killed when the
// socket closes or the conversation switches. Claude runs inside the VM as user
// "user" (bypassPermissions refuses root) with stream-json stdio carried over
// envd's connect-RPC API (:49983), reached through the SSH tunnel + CubeProxy
// Host-header routing — same trick as sandbox.ts, but with a long-lived stream.
//
// Transcript continuity: after each turn the session .jsonl is downloaded from
// the VM into ~/.claude/projects/vm-claude/, where the existing history API
// finds it; resuming uploads it back into the fresh VM before `--resume`.
import { join, normalize } from "path";
import { mkdirSync } from "fs";

export type FsEntry = { name: string; path: string; dir: boolean; size: number; modifiedTime?: string };
export type FsChangeKind = "created" | "modified" | "deleted";
const FS_EVENT_MAP: Record<string, FsChangeKind> = {
  EVENT_TYPE_CREATE: "created",
  EVENT_TYPE_WRITE: "modified",
  EVENT_TYPE_CHMOD: "modified",
  EVENT_TYPE_REMOVE: "deleted",
  EVENT_TYPE_RENAME: "deleted",
};

const E2B_API_URL = process.env.E2B_API_URL ?? "http://localhost:3000";
const CUBE_PROXY_URL = process.env.CUBE_PROXY_URL ?? "http://localhost:3080";
const CLAUDE_TEMPLATE = process.env.CLAUDE_VM_TEMPLATE ?? "claude-code";
const SANDBOX_DOMAIN = process.env.CUBE_SANDBOX_DOMAIN ?? "cube.app";
const SESSION_TIMEOUT_S = Number(process.env.SANDBOX_SESSION_TIMEOUT_S ?? 7200);
const CLAUDE_DIR = process.env.CLAUDE_DIR ?? join(process.env.HOME ?? "/", ".claude");
const LOCAL_TRANSCRIPT_DIR = join(CLAUDE_DIR, "projects", "vm-claude");
// claude's cwd inside the VM; its transcripts land under this munged name
const VM_CWD = "/home/user/projects";
const VM_PROJECT_DIR = "/home/user/.claude/projects/-home-user-projects";
const ENVD_AUTH = "Basic " + btoa("user:");
const HEARTBEAT_MARK = "__cube_hb__";

const CREATE_RETRIES = 5;
const CREATE_RETRY_DELAY_MS = 5000;

function envdHost(sandboxId: string): string {
  return `49983-${sandboxId}.${SANDBOX_DOMAIN}`;
}

function envelope(json: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(json));
  const buf = new Uint8Array(5 + payload.length);
  new DataView(buf.buffer).setUint32(1, payload.length);
  buf.set(payload, 5);
  return buf;
}

async function* frames(body: ReadableStream<Uint8Array>) {
  let buf = new Uint8Array(0);
  for await (const chunk of body) {
    const merged = new Uint8Array(buf.length + chunk.length);
    merged.set(buf);
    merged.set(chunk, buf.length);
    buf = merged;
    while (buf.length >= 5) {
      const len = new DataView(buf.buffer, buf.byteOffset).getUint32(1);
      if (buf.length < 5 + len) break;
      yield { flags: buf[0], json: JSON.parse(new TextDecoder().decode(buf.slice(5, 5 + len))) };
      buf = buf.slice(5 + len);
    }
  }
}

export type VmClaudeOpts = {
  claudeArgs: string[]; // args after the binary name
  resumeSessionId: string | null;
  onLine: (line: string) => void; // one stdout line (stream-json event)
  onExit: (detail: { code: number; stderrTail: string }) => void;
  log: (...parts: unknown[]) => void;
  // Persistent S3 volume for this conversation's files (mounted at VM_CWD).
  // Server-minted, stable across resumes; created on demand, reused thereafter.
  volumeName?: string;
  // The user's MCP config JSON (from their stored servers), uploaded to the VM
  // and referenced by `--mcp-config /home/user/mcp.json` in claudeArgs.
  mcpConfigJson?: string;
  // Model-access env + extra args for claude (gateway URL, token helper),
  // resolved at launch. No credentials are ever uploaded into the VM or onto the volume.
  harnessLaunch: () => Promise<{ env: Record<string, string>; args: string[] }>;
};

export const VM_MCP_CONFIG_PATH = "/home/user/mcp.json";

// Create an S3 volume by name (idempotent-ish: a duplicate name is harmless —
// volumeID == name, so re-creating just returns/So keeps the same volume).
export async function ensureVolume(name: string): Promise<void> {
  const res = await fetch(`${E2B_API_URL}/volumes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, driver: "s3" }),
    signal: AbortSignal.timeout(15_000),
  });
  // 201 created, or an already-exists conflict — both are fine.
  if (res.status >= 300 && res.status !== 409) {
    throw new Error(`volume create ${name} failed: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
  }
}

// Destroy a volume and all its data (called on "delete conversation").
export async function destroyVolume(name: string): Promise<void> {
  await fetch(`${E2B_API_URL}/volumes/${encodeURIComponent(name)}`, {
    method: "DELETE",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {});
}

export class VmClaudeSession {
  sandboxId: string | null = null;
  private pid = 0;
  private pending: string[] = [];
  private dead = false;
  private stderrTail = "";
  private abort = new AbortController();
  private opts: VmClaudeOpts;

  constructor(opts: VmClaudeOpts) {
    this.opts = opts;
    this.init().catch((err) => {
      this.opts.log(`vm session failed to start: ${err}`);
      this.destroy();
      this.opts.onExit({ code: 1, stderrTail: String(err?.message ?? err) });
    });
  }

  private async api(path: string, init: RequestInit = {}) {
    return fetch(`${E2B_API_URL}${path}`, init);
  }

  private async envd(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    return fetch(`${CUBE_PROXY_URL}${path}`, {
      ...init,
      headers: {
        Host: envdHost(this.sandboxId!),
        Authorization: ENVD_AUTH,
        ...(init.headers ?? {}),
      },
    });
  }

  private async init() {
    // 0. ensure this conversation's persistent volume exists (files survive VM death)
    if (this.opts.volumeName) await ensureVolume(this.opts.volumeName);
    const volumeMounts = this.opts.volumeName
      ? [{ name: this.opts.volumeName, path: VM_CWD }]
      : undefined;

    // 1. create the microVM (retries: capacity frees ~10s after a kill)
    let lastError = "";
    for (let attempt = 1; attempt <= CREATE_RETRIES && !this.sandboxId; attempt++) {
      const res = await this.api("/sandboxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: CLAUDE_TEMPLATE, timeout: SESSION_TIMEOUT_S, ...(volumeMounts ? { volumeMounts } : {}) }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.text();
      if (res.ok) {
        this.sandboxId = JSON.parse(body).sandboxID ?? null;
      } else {
        lastError = `sandbox create failed (${res.status}): ${body.slice(0, 200)}`;
        if (attempt < CREATE_RETRIES) await Bun.sleep(CREATE_RETRY_DELAY_MS);
      }
    }
    if (!this.sandboxId) throw new Error(lastError || "sandbox create failed");
    if (this.dead) return void this.destroy();
    this.opts.log(`vm session sandbox=${this.sandboxId}${this.opts.resumeSessionId ? ` resume=${this.opts.resumeSessionId}` : ""}`);

    // 2. wait for envd (the template probe usually makes this instant)
    let healthy = false;
    for (let i = 0; i < 20 && !healthy; i++) {
      try {
        const h = await this.envd("/health", { signal: AbortSignal.timeout(2000) });
        healthy = h.status < 400;
      } catch {}
      if (!healthy) await Bun.sleep(1000);
    }
    if (!healthy) throw new Error("envd in the sandbox never became healthy");

    // 2b. the S3 volume mounts root-owned; claude runs as `user`, so make it
    //     writable. Run as ROOT (envd runs as root when NO auth header is sent).
    //     The chown persists on the volume.
    if (this.opts.volumeName) {
      const chown = await fetch(`${CUBE_PROXY_URL}/process.Process/Start`, {
        method: "POST",
        headers: {
          Host: envdHost(this.sandboxId!),
          "Content-Type": "application/connect+json",
          "Connect-Protocol-Version": "1",
        },
        body: envelope({ process: { cmd: "/bin/bash", args: ["-c", `chown user:user ${VM_CWD}`], envs: {} } }) as unknown as BodyInit,
        signal: this.abort.signal,
      });
      if (chown.status === 200 && chown.body) {
        for await (const f of frames(chown.body)) {
          if ((f.json as any)?.event?.end) break; // wait for chown to finish
        }
      } else {
        this.opts.log(`volume chown returned HTTP ${chown.status}`);
      }
    }

    // 3. inject config (+ transcript when resuming). Model auth is env-only (step 4).
    await this.uploadFile(
      "/home/user/.claude.json",
      JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true }),
    );
    if (this.opts.mcpConfigJson) {
      await this.uploadFile(VM_MCP_CONFIG_PATH, this.opts.mcpConfigJson);
    }
    if (this.opts.resumeSessionId) {
      const local = Bun.file(join(LOCAL_TRANSCRIPT_DIR, `${this.opts.resumeSessionId}.jsonl`));
      if (await local.exists()) {
        await this.uploadFile(`${VM_PROJECT_DIR}/${this.opts.resumeSessionId}.jsonl`, await local.text());
      } else {
        this.opts.log(`vm resume: no local transcript for ${this.opts.resumeSessionId}, starting fresh`);
      }
    }
    if (this.dead) return void this.destroy();

    // 4. start claude under a heartbeat wrapper (keeps the stream alive
    //    through nginx/tunnel idle timeouts while the user is thinking)
    const script = [
      `(while true; do sleep 25; printf '${HEARTBEAT_MARK}\\n' >&2; done) &`,
      `hb=$!`,
      `claude "$@"`,
      `code=$?`,
      `kill $hb 2>/dev/null`,
      `exit $code`,
    ].join("\n");
    const launch = await this.opts.harnessLaunch();
    if (this.dead) return void this.destroy();
    const args = ["-c", script, "claude-wrapper", ...this.opts.claudeArgs, ...launch.args];
    const claudeEnv: Record<string, string> = { HOME: "/home/user", MCP_TIMEOUT: "60000", ...launch.env };
    const res = await this.envd("/process.Process/Start", {
      method: "POST",
      headers: { "Content-Type": "application/connect+json", "Connect-Protocol-Version": "1" },
      body: envelope({ process: { cmd: "/bin/bash", args, envs: claudeEnv, cwd: VM_CWD } }) as unknown as BodyInit,
      signal: this.abort.signal,
    });
    if (res.status !== 200 || !res.body) {
      throw new Error(`claude start failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    this.consumeStream(res.body);
  }

  private async consumeStream(body: ReadableStream<Uint8Array>) {
    let stdoutBuf = "";
    let exitCode = 0;
    try {
      for await (const frame of frames(body)) {
        const event = frame.json.event ?? {};
        if (frame.flags === 2 && frame.json.error) {
          this.stderrTail += `\nRPC error: ${JSON.stringify(frame.json.error)}`;
        }
        if (event.start?.pid) {
          this.pid = event.start.pid;
          for (const line of this.pending.splice(0)) this.sendStdin(line);
        }
        if (event.data?.stdout) {
          stdoutBuf += Buffer.from(event.data.stdout, "base64").toString("utf-8");
          let nl: number;
          while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
            const line = stdoutBuf.slice(0, nl).trim();
            stdoutBuf = stdoutBuf.slice(nl + 1);
            if (line) this.opts.onLine(line);
          }
        }
        if (event.data?.stderr) {
          const text = Buffer.from(event.data.stderr, "base64").toString("utf-8");
          for (const line of text.split("\n")) {
            if (line && !line.includes(HEARTBEAT_MARK)) {
              this.stderrTail = (this.stderrTail + line + "\n").slice(-4000);
            }
          }
        }
        if (event.end) {
          exitCode = event.end.status?.includes("exit status 0") || event.end.exited === true ? 0 : 1;
          if (typeof event.end.exitCode === "number") exitCode = event.end.exitCode;
        }
      }
    } catch (err) {
      if (!this.dead) {
        this.stderrTail += `\nstream dropped: ${err}`;
        exitCode = exitCode || 1;
      }
    }
    const wasDead = this.dead;
    this.destroy();
    if (!wasDead) this.opts.onExit({ code: exitCode, stderrTail: this.stderrTail });
  }

  private async uploadFile(path: string, content: string) {
    const form = new FormData();
    form.append("file", new Blob([content]), path.split("/").pop()!);
    const res = await this.envd(`/files?path=${encodeURIComponent(path)}&username=user`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300) throw new Error(`upload ${path} failed: HTTP ${res.status}`);
  }

  private async sendStdin(data: string) {
    try {
      await this.envd("/process.Process/SendInput", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
        body: JSON.stringify({
          process: { pid: this.pid },
          input: { stdin: Buffer.from(data, "utf-8").toString("base64") },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      this.opts.log(`vm stdin write failed: ${err}`);
    }
  }

  /** Write one stream-json line to claude's stdin (buffered until it's up). */
  writeLine(line: string) {
    const data = line.endsWith("\n") ? line : line + "\n";
    if (this.pid) this.sendStdin(data);
    else this.pending.push(data);
  }

  // ---- view-only file surface (envd Filesystem API, scoped to VM_CWD) ----
  // Resolve a path and refuse anything that escapes the project dir — every
  // file access from a browser flows through here, so this is the tenant guard.
  private safePath(rel: string): string {
    const abs = rel.startsWith("/") ? normalize(rel) : normalize(join(VM_CWD, rel));
    if (abs !== VM_CWD && !abs.startsWith(VM_CWD + "/")) {
      throw new Error(`path outside project dir: ${rel}`);
    }
    return abs;
  }

  /** List a directory inside the VM. ListDir is plain-JSON (not enveloped). */
  async listDir(rel: string): Promise<FsEntry[]> {
    if (!this.sandboxId || this.dead) return [];
    const path = this.safePath(rel);
    const res = await this.envd("/filesystem.Filesystem/ListDir", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
      body: JSON.stringify({ path }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== 200) throw new Error(`ListDir ${path} failed: HTTP ${res.status}`);
    const data: any = await res.json();
    return (data.entries ?? []).map((e: any) => ({
      name: e.name as string,
      path: e.path as string,
      dir: e.type === "FILE_TYPE_DIRECTORY",
      size: Number(e.size ?? 0),
      modifiedTime: e.modifiedTime as string | undefined,
    }));
  }

  /** Read one file's contents (reuses the /files GET endpoint). */
  async readFile(rel: string): Promise<string> {
    if (!this.sandboxId || this.dead) throw new Error("sandbox not available");
    const path = this.safePath(rel);
    const res = await this.envd(
      `/files?path=${encodeURIComponent(path)}&username=user`,
      { signal: AbortSignal.timeout(20_000) },
    );
    if (res.status !== 200) throw new Error(`read ${path} failed: HTTP ${res.status}`);
    return res.text();
  }

  /** Read a background sub-agent's JSONL transcript file (…/tasks/<id>.output). */
  async readAgentOutput(path: string): Promise<string | null> {
    if (!this.sandboxId || this.dead) return null;
    if (!/\/tasks\/[A-Za-z0-9_-]+\.output$/.test(path)) throw new Error("not an agent output path");
    const res = await this.envd(`/files?path=${encodeURIComponent(path)}&username=user`, { signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) return null;
    return res.text();
  }

  /**
   * Watch VM_CWD recursively; calls onEvent with paths relative to VM_CWD.
   * Returns a stop function. WatchDir is the enveloped connect stream.
   */
  startWatch(onEvent: (ev: { path: string; kind: FsChangeKind }) => void): () => void {
    if (!this.sandboxId || this.dead) return () => {};
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`${CUBE_PROXY_URL}/filesystem.Filesystem/WatchDir`, {
          method: "POST",
          headers: {
            Host: envdHost(this.sandboxId!),
            Authorization: ENVD_AUTH,
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "1",
          },
          body: envelope({ path: VM_CWD, recursive: true }) as unknown as BodyInit,
          signal: ctrl.signal,
        });
        if (res.status !== 200 || !res.body) {
          this.opts.log(`WatchDir failed: HTTP ${res.status}`);
          return;
        }
        for await (const frame of frames(res.body)) {
          const fs = (frame.json as any)?.filesystem;
          if (!fs?.name) continue;
          const kind = FS_EVENT_MAP[fs.type as string];
          if (kind) onEvent({ path: fs.name as string, kind });
        }
      } catch (err) {
        if (!ctrl.signal.aborted && !this.dead) this.opts.log(`watch stream dropped: ${err}`);
      }
    })();
    return () => ctrl.abort();
  }

  /** Push the sandbox hard-deadline out again (called at each turn start). */
  refreshTimeout() {
    if (!this.sandboxId || this.dead) return;
    this.api(`/sandboxes/${this.sandboxId}/timeout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: SESSION_TIMEOUT_S }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  /** Download the session transcript from the VM so history + resume survive it. */
  async syncTranscript(sessionId: string) {
    if (!this.sandboxId || this.dead) return;
    try {
      const res = await this.envd(
        `/files?path=${encodeURIComponent(`${VM_PROJECT_DIR}/${sessionId}.jsonl`)}&username=user`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (res.status !== 200) return;
      mkdirSync(LOCAL_TRANSCRIPT_DIR, { recursive: true });
      await Bun.write(join(LOCAL_TRANSCRIPT_DIR, `${sessionId}.jsonl`), await res.arrayBuffer());
    } catch (err) {
      this.opts.log(`transcript sync failed for ${sessionId}: ${err}`);
    }
  }

  /** Kill the microVM. Idempotent. */
  kill() {
    this.dead = true;
    this.destroy();
  }

  private destroyed = false;
  private destroy() {
    this.dead = true;
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    const id = this.sandboxId;
    if (id) {
      this.api(`/sandboxes/${id}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) })
        .then(() => this.opts.log(`vm session sandbox=${id} destroyed`))
        .catch(() => {});
    }
  }
}
