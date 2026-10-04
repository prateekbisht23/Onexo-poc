#!/usr/bin/env bun
// Conformance matrix for the plugs (README "Plugs"): every sandbox × gateway pair runs the
// same scenarios through a fresh POC server, driven over /ws exactly like the browser.
//
//   bun scripts/conformance.ts [--sandboxes local,docker,cubesandbox] [--gateways connectra,bifrost]
//                              [--only plain,tool,...]
//
// Run from server/ (Bun loads server/.env). Each scenario gets its own server process with
// an isolated HOME/DB/projects dir. ONEXO_DATABASE_URL (optional) adds the Connectra
// metering check. Report: printed table + logs/conformance-<ts>.json. Exit 1 on any FAIL.
import { SQL } from "bun";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Status = "PASS" | "WARN" | "FAIL" | "SKIP";

type TurnResult = {
  resultText: string | null;
  isError: boolean | null;
  doneCode: number | null;
  error: string | null;
  stderr: string;
  toolUses: string[];
  streamEvents: number;
  seconds: number;
  timedOut: boolean;
};

type RunCtx = { gateway: string; nonce: string };
type RunFacts = TurnResult & { correlationId: string | null; tokensIssued: number; meteredRows: number | null };

type Scenario = {
  id: string;
  what: string;
  env: (ctx: RunCtx) => Record<string, string>;
  prompt: (ctx: RunCtx) => string;
  timeoutS: number;
  judge: (r: RunFacts, ctx: RunCtx) => { status: Status; note: string };
};

const succeeded = (r: RunFacts) => !r.timedOut && !r.error && r.doneCode === 0 && r.isError === false;
const failNote = (r: RunFacts) =>
  r.timedOut ? "timed out" : r.error ?? (r.isError ? `harness error: ${r.resultText ?? ""}`.slice(0, 160) : `exit ${r.doneCode} ${r.stderr.slice(0, 120)}`);

const BOGUS_MODEL = "bedrock/conformance-no-such-model-v1:0";

const SCENARIOS: Scenario[] = [
  {
    id: "plain",
    what: "plain reply",
    env: () => ({}),
    prompt: ({ nonce }) => `Reply with exactly: plain-${nonce}`,
    timeoutS: 90,
    judge: (r, { nonce }) =>
      succeeded(r) && r.resultText?.includes(`plain-${nonce}`)
        ? { status: "PASS", note: `${r.seconds}s` }
        : { status: "FAIL", note: succeeded(r) ? `unexpected reply: ${r.resultText?.slice(0, 80)}` : failNote(r) },
  },
  {
    id: "tool",
    what: "tool call (Bash)",
    env: () => ({}),
    prompt: ({ nonce }) => `Use the Bash tool to run \`echo tool-${nonce}\`, then reply with only the command's output.`,
    timeoutS: 120,
    judge: (r, { nonce }) => {
      if (!succeeded(r)) return { status: "FAIL", note: failNote(r) };
      if (!r.toolUses.includes("Bash")) return { status: "FAIL", note: `no Bash tool_use (saw: ${r.toolUses.join(",") || "none"})` };
      return r.resultText?.includes(`tool-${nonce}`)
        ? { status: "PASS", note: `${r.seconds}s, tools=${r.toolUses.join(",")}` }
        : { status: "FAIL", note: `tool ran but reply lacks output: ${r.resultText?.slice(0, 80)}` };
    },
  },
  {
    id: "long-turn",
    what: "long streamed turn > token refresh",
    env: () => ({ GATEWAY_TOKEN_REFRESH_S: "20" }),
    prompt: ({ nonce }) =>
      `Run the bash command \`sleep 25\` two separate times, one after another, each as its own tool call. Then reply with exactly: long-${nonce}`,
    timeoutS: 240,
    judge: (r, { nonce }) => {
      if (!succeeded(r) || !r.resultText?.includes(`long-${nonce}`)) return { status: "FAIL", note: failNote(r) };
      if (r.streamEvents === 0) return { status: "FAIL", note: "no partial stream events reached the client" };
      if (r.tokensIssued < 2) return { status: "FAIL", note: `turn outlived the refresh period but only ${r.tokensIssued} token(s) issued` };
      return { status: "PASS", note: `${r.seconds}s, ${r.tokensIssued} tokens, ${r.streamEvents} stream events` };
    },
  },
  {
    id: "rejected-token",
    what: "rejected token → helper re-run → continues",
    env: () => ({ GATEWAY_TEST_REJECT_FIRST_TOKEN: "1" }),
    prompt: ({ nonce }) => `Reply with exactly: recovered-${nonce}`,
    timeoutS: 90,
    judge: (r, { nonce }) => {
      if (!succeeded(r) || !r.resultText?.includes(`recovered-${nonce}`)) return { status: "FAIL", note: failNote(r) };
      return r.tokensIssued >= 2
        ? { status: "PASS", note: `${r.tokensIssued} tokens (1st invalid)` }
        : { status: "FAIL", note: "succeeded without re-fetching — the invalid token was never used?" };
    },
  },
  {
    id: "unknown-model",
    what: "unknown model fails visibly (no hang, no silent swap)",
    env: ({ gateway }) => ({ [gateway === "bifrost" ? "BIFROST_MODEL" : "CONNECTRA_MODEL"]: BOGUS_MODEL }),
    prompt: ({ nonce }) => `Reply with exactly: model-${nonce}`,
    timeoutS: 150,
    judge: (r) => {
      if (r.timedOut) return { status: "FAIL", note: "hung — no answer and no error" };
      if (succeeded(r)) return { status: "WARN", note: "answered anyway: the gateway silently served another model (phase 7)" };
      return { status: "PASS", note: `failed visibly: ${failNote(r).slice(0, 100)}` };
    },
  },
];

function argList(flag: string, fallback: string[]): string[] {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1].split(",").map((s) => s.trim()).filter(Boolean) : fallback;
}

const SANDBOXES = argList("--sandboxes", ["local"]);
const GATEWAYS = argList("--gateways", ["connectra", "bifrost"]);
const ONLY = argList("--only", SCENARIOS.map((s) => s.id));
const PORT = Number(process.env.CONFORMANCE_PORT ?? 8097);
const SERVER_DIR = join(import.meta.dir, "..");
const onexoDb = process.env.ONEXO_DATABASE_URL ? new SQL(process.env.ONEXO_DATABASE_URL) : null;

async function startServer(sandbox: string, gateway: string, env: Record<string, string>, scratch: string) {
  const logPath = join(scratch, "server.log");
  const proc = Bun.spawn(["bun", "index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      ...env,
      PORT: String(PORT),
      SANDBOX: sandbox,
      GATEWAY: gateway,
      HOME: join(scratch, "home"),
      PROJECTS_DIR: join(scratch, "projects"),
      DB_PATH: join(scratch, "chats.db"),
    },
    stdout: Bun.file(logPath),
    stderr: Bun.file(join(scratch, "server.err")),
  });
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    const ok = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false);
    if (ok) return { proc, logPath };
    if (proc.exitCode !== null) break;
  }
  proc.kill();
  throw new Error(`server did not start: ${(await Bun.file(join(scratch, "server.err")).text()).slice(-400)}`);
}

function runTurn(prompt: string, timeoutS: number): Promise<TurnResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r: TurnResult = {
      resultText: null, isError: null, doneCode: null, error: null, stderr: "",
      toolUses: [], streamEvents: 0, seconds: 0, timedOut: false,
    };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const finish = () => {
      clearTimeout(timer);
      r.seconds = Math.round((Date.now() - t0) / 100) / 10;
      try { ws.close(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => { r.timedOut = true; finish(); }, timeoutS * 1000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "chat", text: prompt, tempId: crypto.randomUUID() }));
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.type === "error") { r.error = d.error; finish(); return; }
      if (d.type === "claude_event") {
        const e = d.event;
        if (e.type === "stream_event") r.streamEvents++;
        if (e.type === "assistant") {
          for (const b of e.message?.content ?? []) if (b.type === "tool_use" && !r.toolUses.includes(b.name)) r.toolUses.push(b.name);
        }
        if (e.type === "result") { r.resultText = e.result ?? null; r.isError = !!e.is_error; }
      }
      if (d.type === "done") { r.doneCode = d.code; r.stderr = d.stderr ?? ""; finish(); }
    };
    ws.onerror = () => { r.error = "websocket error"; finish(); };
  });
}

async function meteredRows(correlationId: string): Promise<number | null> {
  if (!onexoDb) return null;
  // Connectra writes the usage row after the stream closes — poll briefly.
  for (let i = 0; i < 10; i++) {
    const [{ n }] = await onexoDb`select count(*)::int as n from ai_usage_event where correlation_id = ${correlationId}`;
    if (n > 0) return n;
    await Bun.sleep(1000);
  }
  return 0;
}

type Row = { sandbox: string; gateway: string; scenario: string; status: Status; note: string; correlationId: string | null };
const rows: Row[] = [];
const root = mkdtempSync(join(tmpdir(), "poc-conformance-"));
console.log(`conformance: sandboxes=${SANDBOXES.join(",")} gateways=${GATEWAYS.join(",")} scratch=${root}\n`);

for (const sandbox of SANDBOXES) {
  for (const gateway of GATEWAYS) {
    for (const sc of SCENARIOS.filter((s) => ONLY.includes(s.id))) {
      const ctx: RunCtx = { gateway, nonce: crypto.randomUUID().slice(0, 8) };
      const scratch = join(root, `${sandbox}-${gateway}-${sc.id}`);
      mkdirSync(join(scratch, "home"), { recursive: true });
      mkdirSync(join(scratch, "projects"), { recursive: true });
      process.stdout.write(`  ${sandbox.padEnd(11)} ${gateway.padEnd(9)} ${sc.id.padEnd(15)} … `);
      let row: Row;
      try {
        const { proc, logPath } = await startServer(sandbox, gateway, sc.env(ctx), scratch);
        const turn = await runTurn(sc.prompt(ctx), sc.timeoutS);
        proc.kill();
        await proc.exited;
        const log = await Bun.file(logPath).text();
        const correlationId = log.match(/gateway session open .*?corr=(\S+)/)?.[1] ?? null;
        const tokensIssued = correlationId
          ? log.split("\n").filter((l) => l.includes(`gateway token issued corr=${correlationId} `)).length
          : 0;
        const metered = gateway === "connectra" && correlationId && succeeded({ ...turn, correlationId, tokensIssued, meteredRows: null })
          ? await meteredRows(correlationId)
          : null;
        const facts: RunFacts = { ...turn, correlationId, tokensIssued, meteredRows: metered };
        let { status, note } = sc.judge(facts, ctx);
        if (metered === 0 && status === "PASS") { status = "FAIL"; note += "; NOT metered in OneXO"; }
        else if (metered) note += `; metered rows=${metered}`;
        row = { sandbox, gateway, scenario: sc.id, status, note, correlationId };
      } catch (err) {
        row = { sandbox, gateway, scenario: sc.id, status: "FAIL", note: String(err instanceof Error ? err.message : err), correlationId: null };
      }
      rows.push(row);
      console.log(`${row.status}  ${row.note}`);
    }
  }
}

const counts = rows.reduce<Record<string, number>>((a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a), {});
console.log(`\n${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join("  ")}${onexoDb ? "" : "  (metering not checked: set ONEXO_DATABASE_URL)"}`);
const outDir = join(SERVER_DIR, "..", "logs");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `conformance-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, JSON.stringify({ sandboxes: SANDBOXES, gateways: GATEWAYS, rows }, null, 2));
console.log(`report: ${outPath}`);
await onexoDb?.close();
process.exit(rows.some((r) => r.status === "FAIL") ? 1 : 0);
