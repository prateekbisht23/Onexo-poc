import type { ServerWebSocket, Subprocess } from "bun";
import { readdir } from "fs/promises";
import { join, normalize } from "path";
import { deleteConversation, getConversation, listConversations, migrate, renameSession, touchConversation } from "./db";
import { runCode, sandboxConfigSummary } from "./sandbox";
import { destroyVolume, VmHarnessSession, VM_CWD, VM_HOME, VM_MCP_CONFIG_PATH } from "./sandbox/cubesandbox";
import { dockerSandbox, hostSandbox, type LocalSandbox } from "./sandbox/local";
import { GATEWAY_TOKEN_PATH, handleGatewayTokenRequest, openBrokeredSession, selectGateway, type BrokeredSession } from "./gateway";
import { selectHarness } from "./harness";
import { addMcpServer, deleteMcpServer, listMcpServers, setMcpEnabled, updateMcpOAuth, upsertOAuthServer, type McpServer } from "./db";
import * as mcpOAuth from "./mcp-oauth";
import { mkdirSync, writeFileSync } from "fs";

// Identity seam — the ONE place that decides who the caller is. PoC: a stub
// (fixed org/user, overridable by header/env). Production: validate the JWT/SSO
// token and read org/user claims here. Same signature, so nothing downstream
// changes when auth lands.
type Identity = { org: string; user: string };
function getIdentity(req?: Request): Identity {
  const hdr = req?.headers.get("x-poc-user");
  return {
    org: req?.headers.get("x-poc-org") ?? process.env.POC_ORG ?? "poc",
    user: hdr ?? process.env.POC_USER ?? "poc-user",
  };
}

// Live-VM ceiling for this node (memory-bound). New sessions past this evict the
// least-recently-used idle VM (lossless — files are on the persistent volume).
const MAX_LIVE_VMS = Number(process.env.MAX_LIVE_VMS ?? 3);

migrate();

// 8091 because 127.0.0.1:8080 is held by another container on this machine.
const PORT = Number(process.env.PORT ?? 8091);
// The three plugs (README "Plugs"): which sandbox runs which harness against which gateway.
// cubesandbox = one microVM per conversation; docker = shared local container; local = this host.
const SANDBOX = process.env.SANDBOX ?? "cubesandbox";
const LOCAL_SANDBOXES: Record<string, LocalSandbox> = { docker: dockerSandbox, local: hostSandbox };
if (SANDBOX !== "cubesandbox" && !LOCAL_SANDBOXES[SANDBOX]) {
  throw new Error(`unknown SANDBOX "${SANDBOX}" (known: cubesandbox, docker, local)`);
}
const localSandbox = LOCAL_SANDBOXES[SANDBOX] ?? dockerSandbox;
const harness = selectHarness();
const gateway = selectGateway();
const PUBLIC_DIR = join(import.meta.dir, "public");

function log(...parts: unknown[]) {
  console.log(`[${new Date().toISOString()}]`, ...parts);
}

// Teaches claude to ask the user questions as a structured JSON block that the
// frontend renders as single/multi-select options. The answer comes back as the
// next chat message via --resume.
const ASK_USER_PROMPT = [
  "When you need to ask the user a clarifying question or offer them a choice, do NOT ask in plain prose.",
  "Instead, write any explanation first, then append this exact structure at the very end of your reply:",
  "<ask_user>",
  '{"questions":[{"question":"Full question text?","header":"Short label","multiSelect":false,"options":[{"label":"Option A","description":"what this choice means"},{"label":"Option B","description":"..."}]}]}',
  "</ask_user>",
  "Rules: valid JSON only between the tags; 2-4 options per question; set multiSelect to true only when several answers can apply at once; output nothing after the closing tag.",
  "The user's next message will contain their selection(s), a custom answer, or a note that they skipped the question.",
].join("\n");

// ---- MCP: exposes run_code (CubeSandbox microVM execution) to the harness ----
// Served by this process at /mcp (streamable-HTTP, JSON responses only — no
// SSE needed since the server never pushes). A docker/local harness only; a VM
// harness already IS the sandbox.
const MCP_URL = localSandbox.vantage === "container"
  ? `http://host.docker.internal:${PORT}/mcp`
  : `http://localhost:${PORT}/mcp`;
const MCP_CONFIG = JSON.stringify({
  mcpServers: { cubesandbox: { type: "http", url: MCP_URL } },
});

const RUN_CODE_TOOL = {
  name: "run_code",
  description:
    "Execute code in an isolated CubeSandbox microVM (hardware-isolated KVM VM on AWS). " +
    "A FRESH VM is created per call and destroyed afterwards — no files, variables, or installs persist between calls, " +
    "so each call must be self-contained. Python 3.12 by default. Returns stdout, stderr, and any error traceback. " +
    "Use this for running untrusted or user-requested code, calculations, and quick experiments.",
  inputSchema: {
    type: "object",
    properties: {
      code: { type: "string", description: "The code to execute (self-contained; ~90s time limit)" },
      language: { type: "string", enum: ["python", "js", "bash"], description: "Defaults to python" },
    },
    required: ["code"],
  },
};

function jsonRpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

async function serveMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405 });
  let rpc: any;
  try {
    rpc = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  }
  if (rpc.id === undefined || rpc.id === null) return new Response(null, { status: 202 }); // notifications
  switch (rpc.method) {
    case "initialize":
      return jsonRpcResult(rpc.id, {
        protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "cubesandbox", version: "0.1.0" },
      });
    case "ping":
      return jsonRpcResult(rpc.id, {});
    case "tools/list":
      return jsonRpcResult(rpc.id, { tools: [RUN_CODE_TOOL] });
    case "tools/call": {
      if (rpc.params?.name !== "run_code") {
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: `Unknown tool: ${rpc.params?.name}` } });
      }
      const { code, language } = rpc.params?.arguments ?? {};
      if (typeof code !== "string" || !code.trim()) {
        return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32602, message: "run_code requires a non-empty 'code' string" } });
      }
      log(`run_code (${language ?? "python"}, ${code.length} chars)`);
      try {
        const result = await runCode(code, language);
        const sections = [
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
          result.error && `error:\n${result.error}`,
        ].filter(Boolean);
        log(`run_code done sandbox=${result.sandboxId} ok=${!result.error}`);
        return jsonRpcResult(rpc.id, {
          content: [{ type: "text", text: sections.join("\n\n") || "(no output)" }],
          isError: Boolean(result.error),
        });
      } catch (err) {
        log(`run_code failed: ${err}`);
        return jsonRpcResult(rpc.id, {
          content: [{ type: "text", text: `Sandbox unavailable: ${err instanceof Error ? err.message : err}. Check the SSH tunnel to the CubeSandbox EC2 instance.` }],
          isError: true,
        });
      }
    }
    default:
      return Response.json({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: `Method not found: ${rpc.method}` } });
  }
}

type SocketData = {
  // docker backend only (legacy per-socket flow)
  proc: Subprocess<"pipe", "pipe", "pipe"> | null;
  procSessionId: string | null;
  lastSessionId: string | null;
  busy: boolean;
  lastPrompt: string;
  // vm backend: which conversation this socket is currently viewing
  watching: string | null;
  identity: Identity; // who this connection is (from the identity seam)
  gateway: BrokeredSession | null; // docker/local: the live harness's token-helper session
};

type ClientMessage =
  | { type: "chat"; text: string; sessionId?: string; tempId?: string }
  | { type: "watch"; sessionId?: string }
  | { type: "fs_tree"; sessionId?: string; path?: string }
  | { type: "fs_open"; sessionId?: string; path: string }
  | { type: "end_session"; sessionId: string } // close the VM, keep the volume
  | { type: "delete_conversation"; sessionId: string } // wipe VM + volume + row
  | { type: "agent_watch"; sessionId: string; toolUseId: string; path: string }
  | { type: "agent_unwatch"; sessionId: string; toolUseId: string }
  | { type: "mcp_list" }
  | { type: "mcp_add"; name: string; transport: string; config: Record<string, unknown> }
  | { type: "mcp_connect"; name: string; url: string } // OAuth "Connect" flow
  | { type: "mcp_remove"; id: number }
  | { type: "mcp_toggle"; id: number; enabled: boolean };

function sendJson(ws: ServerWebSocket<SocketData>, payload: unknown) {
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // socket already closed
  }
}

async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
  }
  const rest = buffer.trim();
  if (rest) onLine(rest);
}

// Shared stdout handler: session tracking, event relay, end-of-turn signal.
function makeHarnessLineHandler(
  ws: ServerWebSocket<SocketData>,
  label: () => string,
  onResult?: () => void,
) {
  return (line: string) => {
    const event = harness.decodeLine(line);
    if (!event) return;
    // Resuming can mint a NEW session id; always track and forward the latest.
    if (event.session_id && event.session_id !== ws.data.lastSessionId) {
      const previous = ws.data.lastSessionId;
      ws.data.lastSessionId = event.session_id;
      log(`session ${event.session_id} (${label()})`);
      if (previous) renameSession(previous, event.session_id);
      sendJson(ws, { type: "session", sessionId: event.session_id });
    }
    sendJson(ws, { type: "claude_event", sessionId: ws.data.lastSessionId ?? undefined, event });
    // Each turn ends with a result event — that's the FE's "done" signal.
    if (event.type === "result") {
      ws.data.busy = false;
      if (ws.data.lastSessionId) {
        touchConversation(
          ws.data.lastSessionId,
          ws.data.lastPrompt.length > 64 ? ws.data.lastPrompt.slice(0, 64) + "…" : ws.data.lastPrompt,
        );
      }
      log(`turn done (${label()}) subtype=${event.subtype}`);
      onResult?.();
      sendJson(ws, { type: "done", sessionId: ws.data.lastSessionId ?? undefined, code: 0 });
    }
  };
}

// ---- VM backend: server-owned conversation registry ----
// Conversations (and their microVMs) live independently of any WebSocket:
// closing the browser mid-task leaves the VM running to completion; sockets
// are just viewers that "watch" one conversation at a time. Several
// conversations can run turns concurrently (bounded by VM capacity).
// Short now that teardown is lossless (files persist on the S3 volume).
const VM_IDLE_TTL_MS = Number(process.env.VM_IDLE_TTL_S ?? 300) * 1000;

type Conv = {
  id: string; // claude session id, or "pending:<tempId>" until minted
  tempId: string | null;
  vm: VmHarnessSession;
  busy: boolean;
  lastPrompt: string;
  lastActivity: number; // for LRU eviction
  volumeName: string; // persistent S3 volume holding this conversation's files
  org: string;
  user: string;
  turnBuffer: unknown[]; // claude_events of the in-flight turn (for late viewers)
  subscribers: Set<ServerWebSocket<SocketData>>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  stopWatch: (() => void) | null; // one envd file-watcher per conv (lazy)
  changed: Set<string>; // paths changed this VM lifetime (for late viewers)
  agentOutputs: Map<string, string>; // agentId → transcript path in the VM (to persist)
  gateway: BrokeredSession | null; // closed in finalizeConv — revokes the VM's token helper key
};

const convs = new Map<string, Conv>();
const allSockets = new Set<ServerWebSocket<SocketData>>();

function convPublicId(conv: Conv): string | undefined {
  return conv.id.startsWith("pending:") ? undefined : conv.id;
}

function sendToSubs(conv: Conv, payload: unknown) {
  for (const ws of conv.subscribers) sendJson(ws, payload);
}

function liveSnapshot() {
  return {
    type: "live",
    sessions: [...convs.values()]
      .filter((c) => !c.id.startsWith("pending:"))
      .map((c) => ({ sessionId: c.id, busy: c.busy })),
  };
}

function broadcastLive() {
  const snap = liveSnapshot();
  for (const ws of allSockets) sendJson(ws, snap);
}

function scheduleIdleKill(conv: Conv) {
  if (conv.idleTimer) clearTimeout(conv.idleTimer);
  conv.idleTimer = setTimeout(async () => {
    log(`conv ${conv.id} idle ${VM_IDLE_TTL_MS / 1000}s → releasing VM (resume recreates it)`);
    await flushConv(conv);
    conv.vm.kill();
    finalizeConv(conv);
  }, VM_IDLE_TTL_MS);
}

function handleConvLine(conv: Conv, line: string) {
  const event = harness.decodeLine(line);
  if (!event) return;
  if (event.session_id && event.session_id !== conv.id) {
    const prev = conv.id;
    convs.delete(prev);
    conv.id = event.session_id;
    convs.set(conv.id, conv);
    // move subscribers' watch pointer from the pending/old id to the real one,
    // so the tenant-scope check (convForViewer) keeps matching
    for (const sub of conv.subscribers) {
      if (sub.data.watching === prev) sub.data.watching = conv.id;
    }
    log(`session ${conv.id} (vm=${conv.vm.sandboxId})`);
    if (!prev.startsWith("pending:")) renameSession(prev, conv.id);
    // Record the conversation in the sidebar NOW (not only when the turn ends),
    // so a just-started chat is findable even if the browser closes mid-run.
    touchConversation(
      conv.id,
      conv.lastPrompt.length > 64 ? conv.lastPrompt.slice(0, 64) + "…" : conv.lastPrompt || "New conversation",
      { volumeId: conv.volumeName, org: conv.org, user: conv.user },
    );
    sendToSubs(conv, {
      type: "session",
      sessionId: conv.id,
      ...(prev.startsWith("pending:") ? { tempId: conv.tempId } : { prev }),
    });
    broadcastLive();
  }
  // Note any sub-agent transcript files so we can persist them before the VM dies.
  if (event.type === "user" && Array.isArray(event.message?.content)) {
    for (const b of event.message.content) {
      if (b.type === "tool_result") {
        const txt = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("") : typeof b.content === "string" ? b.content : "";
        const agentId = txt.match(/agentId:\s*(\S+)/)?.[1];
        const path = txt.match(/output_file:\s*(\S+\.output)/)?.[1];
        if (agentId && path) conv.agentOutputs.set(agentId, path);
      }
    }
  }
  conv.turnBuffer.push(event);
  sendToSubs(conv, { type: "claude_event", sessionId: convPublicId(conv), event });
  if (event.type === "result") {
    conv.busy = false;
    conv.lastActivity = Date.now();
    if (convPublicId(conv)) {
      touchConversation(
        conv.id,
        conv.lastPrompt.length > 64 ? conv.lastPrompt.slice(0, 64) + "…" : conv.lastPrompt,
        { volumeId: conv.volumeName, org: conv.org, user: conv.user },
      );
      void conv.vm.syncTranscript(conv.id);
    }
    log(`turn done (conv=${conv.id} vm=${conv.vm.sandboxId}) subtype=${event.subtype}`);
    sendToSubs(conv, { type: "done", sessionId: convPublicId(conv), code: 0 });
    scheduleIdleKill(conv);
    broadcastLive();
  }
}

// Evict the least-recently-used IDLE conv when at capacity (lossless: files are
// on the volume, so the next prompt recreates + restores).
function evictIfAtCapacity() {
  if (convs.size < MAX_LIVE_VMS) return;
  const idle = [...convs.values()].filter((c) => !c.busy).sort((a, b) => a.lastActivity - b.lastActivity);
  if (idle.length) {
    log(`at capacity (${convs.size}/${MAX_LIVE_VMS}) → evicting LRU idle conv ${idle[0].id}`);
    void flushConv(idle[0]).finally(() => { idle[0].vm.kill(); finalizeConv(idle[0]); });
  } // if all busy, fall through: Vm create-retry handles the squeeze
}

function createConv(
  resumeSessionId: string | null,
  tempId: string | null,
  identity: Identity,
  volumeName: string,
  mcpConfigJson: string | undefined,
): Conv {
  evictIfAtCapacity();
  const key = resumeSessionId ?? `pending:${tempId ?? crypto.randomUUID()}`;
  const conv: Conv = {
    id: key,
    tempId,
    vm: null as unknown as VmHarnessSession,
    busy: false,
    lastPrompt: "",
    lastActivity: Date.now(),
    volumeName,
    org: identity.org,
    user: identity.user,
    turnBuffer: [],
    subscribers: new Set(),
    idleTimer: null,
    stopWatch: null,
    changed: new Set(),
    agentOutputs: new Map(),
    gateway: null,
  };
  conv.vm = new VmHarnessSession({
    resumeSessionId,
    volumeName,
    launch: async () => {
      conv.gateway = await openBrokeredSession(gateway, harness.protocol, identity.user, "vm", (reason) => {
        log(`conv ${conv.id}: ending turn — ${reason}`);
        sendToSubs(conv, { type: "error", sessionId: convPublicId(conv), error: `Model gateway: ${reason}` });
        conv.vm.kill(); // files persist on the volume; the next message starts a fresh VM
        if (conv.busy) {
          conv.busy = false;
          sendToSubs(conv, { type: "done", sessionId: convPublicId(conv), ...(conv.tempId ? { tempId: conv.tempId } : {}), code: 1, stderr: reason });
        }
        finalizeConv(conv);
      });
      const g = harness.gatewayConfig(conv.gateway.conn);
      const args = harness.args({
        resumeSessionId,
        systemPrompt: ASK_USER_PROMPT,
        mcpConfig: mcpConfigJson ? VM_MCP_CONFIG_PATH : undefined,
      });
      return {
        bin: harness.bin,
        args: [...args, ...g.args],
        env: g.env,
        files: { ...harness.setupFiles(VM_HOME), ...(mcpConfigJson ? { [VM_MCP_CONFIG_PATH]: mcpConfigJson } : {}) },
      };
    },
    transcriptPath: (sessionId) => harness.transcriptPath(VM_HOME, VM_CWD, sessionId),
    onLine: (line) => handleConvLine(conv, line),
    onExit: ({ code, stderrTail }) => {
      log(`conv ${conv.id} ended code=${code}`);
      if (conv.busy) {
        conv.busy = false;
        sendToSubs(conv, {
          type: "done",
          sessionId: convPublicId(conv),
          ...(conv.tempId ? { tempId: conv.tempId } : {}),
          code,
          ...(code !== 0 ? { stderr: stderrTail } : {}),
        });
      }
      finalizeConv(conv);
    },
    log,
  });
  convs.set(key, conv);
  return conv;
}

// Remove a conv from the registry + tear down its watcher. Idempotent. Must run
// for EXPLICIT kills too (idle/end/evict): an explicit kill() sets dead=true, so
// the VM's own onExit is suppressed and won't clean the registry on its own.
function finalizeConv(conv: Conv) {
  conv.gateway?.close();
  conv.gateway = null;
  if (conv.idleTimer) { clearTimeout(conv.idleTimer); conv.idleTimer = null; }
  conv.stopWatch?.();
  conv.stopWatch = null;
  if (convs.get(conv.id) === conv) convs.delete(conv.id);
  broadcastLive();
}

function watchConv(ws: ServerWebSocket<SocketData>, sessionId: string | null) {
  for (const c of convs.values()) c.subscribers.delete(ws);
  ws.data.watching = sessionId;
  if (!sessionId) return;
  const conv = convs.get(sessionId);
  if (!conv) return;
  conv.subscribers.add(ws);
  // late joiner: replay the in-flight turn so nothing is missed
  if (conv.busy) {
    sendJson(ws, { type: "turn_user", sessionId: conv.id, text: conv.lastPrompt });
    for (const event of conv.turnBuffer) {
      sendJson(ws, { type: "claude_event", sessionId: conv.id, event });
    }
  }
}

async function sendToVmConv(ws: ServerWebSocket<SocketData>, msg: Extract<ClientMessage, { type: "chat" }>) {
  const desired = msg.sessionId ?? null;
  let conv = desired ? convs.get(desired) : undefined;
  if (conv?.busy) {
    sendJson(ws, { type: "error", sessionId: desired ?? undefined, error: "This conversation is still working — wait for it to finish or start another one" });
    return;
  }
  if (!conv) {
    // Resume: reuse the stored volume + tenant. New: mint a fresh volume.
    const stored = desired ? getConversation(desired) : null;
    const identity: Identity = stored?.org && stored?.user ? { org: stored.org, user: stored.user } : ws.data.identity;
    const volumeName = stored?.volume_id ?? `vol-${identity.org}-${identity.user}-${crypto.randomUUID().slice(0, 12)}`;
    const mcpConfigJson = await materializeMcpConfig(identity.org, identity.user);
    conv = createConv(desired, desired ? null : (msg.tempId ?? crypto.randomUUID()), identity, volumeName, mcpConfigJson);
  }
  // talking to a conversation implies viewing it
  for (const c of convs.values()) c.subscribers.delete(ws);
  conv.subscribers.add(ws);
  ws.data.watching = convPublicId(conv) ?? conv.id;

  conv.busy = true;
  conv.lastActivity = Date.now();
  conv.lastPrompt = msg.text;
  conv.turnBuffer = [];
  if (conv.idleTimer) clearTimeout(conv.idleTimer);
  conv.vm.refreshTimeout();
  log(`turn start (conv=${conv.id} vm=${conv.vm.sandboxId ?? "booting"}) prompt=${JSON.stringify(msg.text.length > 60 ? msg.text.slice(0, 60) + "…" : msg.text)}`);
  conv.vm.writeLine(harness.encodeUserMessage(msg.text));
  broadcastLive();
}

// Persist transcript + agent outputs out of the VM before it dies. On-result
// sync covers the common case; this guards teardowns that race a just-finished
// turn (immediate end_session, fast idle kill).
async function flushConv(conv: Conv) {
  if (!convPublicId(conv)) return;
  await Promise.allSettled([conv.vm.syncTranscript(conv.id), persistAgentOutputs(conv)]);
}

// ---- MCP: config materialization + OAuth "Connect" flow ----
// Strip token blobs before anything reaches the browser.
function sanitizeServers(rows: McpServer[]) {
  return rows.map((r) => ({ id: r.id, name: r.name, transport: r.transport, enabled: r.enabled, config_json: r.config_json, connected: !!r.oauth_json }));
}
function sendMcpList(ws: ServerWebSocket<SocketData>) {
  sendJson(ws, { type: "mcp_servers", servers: sanitizeServers(listMcpServers(ws.data.identity.org, ws.data.identity.user)) });
}
function broadcastMcpList(org: string, user: string) {
  const servers = sanitizeServers(listMcpServers(org, user));
  for (const ws of allSockets) if (ws.data.identity.org === org && ws.data.identity.user === user) sendJson(ws, { type: "mcp_servers", servers });
}

// Build the --mcp-config JSON for a user's enabled servers, refreshing OAuth
// tokens that are about to expire (so injected bearer tokens are always valid).
async function materializeMcpConfig(org: string, user: string): Promise<string | undefined> {
  const rows = listMcpServers(org, user).filter((r) => r.enabled);
  const mcpServers: Record<string, any> = {};
  for (const r of rows) {
    try {
      const cfg = JSON.parse(r.config_json);
      if (r.oauth_json) {
        let o = JSON.parse(r.oauth_json);
        if (o.refreshToken && o.expiresAt && o.expiresAt < Date.now() + 60_000) {
          try {
            const meta = { resource: o.resource, authorizationEndpoint: "", tokenEndpoint: o.tokenEndpoint } as mcpOAuth.McpAuthMeta;
            const t = await mcpOAuth.refresh(meta, o.clientId, o.clientSecret, o.refreshToken);
            o = { ...o, ...t, refreshToken: t.refreshToken ?? o.refreshToken };
            updateMcpOAuth(r.id, o);
          } catch (e) { log(`mcp token refresh failed for ${r.name}: ${e}`); }
        }
        mcpServers[r.name] = { type: "http", url: cfg.url, headers: { Authorization: `Bearer ${o.accessToken}` } };
      } else {
        mcpServers[r.name] = { type: r.transport, ...cfg };
      }
    } catch {}
  }
  return Object.keys(mcpServers).length ? JSON.stringify({ mcpServers }) : undefined;
}

// Pending OAuth "connect" flows keyed by state; the browser redirect completes them.
const mcpPending = new Map<string, { verifier: string; clientId: string; clientSecret?: string; meta: mcpOAuth.McpAuthMeta; name: string; url: string; org: string; user: string; ts: number }>();
const MCP_REDIRECT = `http://localhost:${PORT}/mcp/oauth/callback`;

async function mcpConnect(ws: ServerWebSocket<SocketData>, name: string, url: string) {
  try {
    const meta = await mcpOAuth.discover(url);
    if (!meta.registrationEndpoint) throw new Error("this server doesn't support auto-registration (e.g. GitHub) — add it under “Advanced” with a token: header “Authorization: Bearer <token>”, or the npx server with its token env var");
    const { clientId, clientSecret } = await mcpOAuth.register(meta.registrationEndpoint, MCP_REDIRECT);
    const verifier = mcpOAuth.newVerifier();
    const state = crypto.randomUUID();
    mcpPending.set(state, { verifier, clientId, clientSecret, meta, name, url, org: ws.data.identity.org, user: ws.data.identity.user, ts: Date.now() });
    sendJson(ws, { type: "mcp_auth_url", name, url: mcpOAuth.authorizeUrl(meta, clientId, MCP_REDIRECT, verifier, state) });
  } catch (e) {
    sendJson(ws, { type: "mcp_connect_error", name, error: e instanceof Error ? e.message : String(e) });
  }
}

// ---- sub-agent activity: stream a background agent's JSONL transcript ----
// Async agents write their steps to …/tasks/<id>.output inside the VM (they do
// NOT appear in the main stream). We poll that file and push a parsed, compact
// transcript so the UI can show what the agent is doing under its badge.
type AgentItem =
  | { kind: "text"; text: string }
  | { kind: "tool"; id?: string; name: string; input?: unknown; result?: string };

function parseAgentTranscript(jsonl: string): AgentItem[] {
  const items: AgentItem[] = [];
  const toolById = new Map<string, Extract<AgentItem, { kind: "tool" }>>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    // NB: sub-agent entries are ALL isSidechain:true (they are the sidechain) —
    // don't skip those here, only meta/attachment noise.
    if (e.isMeta || e.type === "attachment") continue;
    if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", text: b.text });
        else if (b.type === "tool_use") { const t = { kind: "tool" as const, id: b.id, name: b.name, input: b.input }; items.push(t); if (b.id) toolById.set(b.id, t); }
      }
    } else if (e.type === "user") {
      for (const b of e.message?.content ?? []) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const t = toolById.get(b.tool_use_id);
          if (t) t.result = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : typeof b.content === "string" ? b.content : JSON.stringify(b.content);
        }
      }
    }
  }
  return items;
}

// Claude's background sub-agents write here; the browser may only ask for these files.
const AGENT_OUTPUT_PATH = /\/tasks\/[A-Za-z0-9_-]+\.output$/;

// key = `${sessionId}\u0000${toolUseId}` → poll timer
const agentWatchers = new Map<string, ReturnType<typeof setInterval>>();

function startAgentWatch(ws: ServerWebSocket<SocketData>, sessionId: string, toolUseId: string, path: string) {
  const conv = convForViewer(ws, sessionId);
  if (!conv) return;
  const key = `${sessionId}\u0000${toolUseId}`;
  if (agentWatchers.has(key)) return; // already watching
  let lastLen = -1;
  let stableTicks = 0;
  const tick = async () => {
    const c = convs.get(sessionId);
    if (!c) return stopAgentWatch(sessionId, toolUseId);
    let text: string | null = null;
    try { text = AGENT_OUTPUT_PATH.test(path) ? await c.vm.readHomeFile(path) : null; } catch (e) { log(`agent watch read failed: ${e}`); return stopAgentWatch(sessionId, toolUseId); }
    if (text == null) return; // not created yet
    const agentId = path.match(/\/tasks\/([A-Za-z0-9_-]+)\.output$/)?.[1];
    if (text.length === lastLen) {
      if (++stableTicks >= 10) {
        if (agentId) saveAgentOutput(sessionId, agentId, text); // persist final state
        sendToSubs(c, { type: "agent_update", sessionId, toolUseId, items: parseAgentTranscript(text), running: false });
        stopAgentWatch(sessionId, toolUseId);
      }
      return;
    }
    lastLen = text.length; stableTicks = 0;
    if (agentId) saveAgentOutput(sessionId, agentId, text); // persist as it grows
    sendToSubs(c, { type: "agent_update", sessionId, toolUseId, items: parseAgentTranscript(text), running: true });
  };
  agentWatchers.set(key, setInterval(tick, 3000));
  void tick();
}

// Persisted sub-agent transcripts live here so their detail survives VM death.
const AGENTS_DIR = () => join(CLAUDE_DIR, "projects", "vm-claude", "agents");
function agentOutputFile(sessionId: string, agentId: string) {
  return join(AGENTS_DIR(), sessionId, `${agentId}.output`);
}
function saveAgentOutput(sessionId: string, agentId: string, text: string) {
  try {
    mkdirSync(join(AGENTS_DIR(), sessionId), { recursive: true });
    writeFileSync(agentOutputFile(sessionId, agentId), text);
  } catch (e) { log(`persist agent output failed: ${e}`); }
}
// Pull every known sub-agent transcript out of the VM and save it (called on teardown).
async function persistAgentOutputs(conv: Conv) {
  const sid = convPublicId(conv);
  if (!sid) return;
  for (const [agentId, path] of conv.agentOutputs) {
    try { const t = await conv.vm.readHomeFile(path); if (t) saveAgentOutput(sid, agentId, t); } catch {}
  }
}

function stopAgentWatch(sessionId: string, toolUseId: string) {
  const key = `${sessionId}\u0000${toolUseId}`;
  const t = agentWatchers.get(key);
  if (t) { clearInterval(t); agentWatchers.delete(key); }
}

// End a session: kill the live VM but keep its volume (next prompt restores).
async function endSession(sessionId: string) {
  const conv = convs.get(sessionId);
  if (!conv) return;
  await flushConv(conv);
  conv.vm.kill();
  finalizeConv(conv);
}

// Delete a conversation entirely: kill VM, wipe the persistent volume, drop the row.
async function deleteConversationFully(sessionId: string) {
  const conv = convs.get(sessionId);
  const volumeName = conv?.volumeName ?? getConversation(sessionId)?.volume_id ?? null;
  if (conv) { conv.vm.kill(); finalizeConv(conv); }
  if (volumeName) {
    // volume can't be destroyed while a sandbox holds it (VolumeInUseError); the
    // kill above releases it, so give the teardown a moment.
    setTimeout(() => void destroyVolume(volumeName), 6000);
  }
  deleteConversation(sessionId);
}

// ---- view-only file channel (fs_tree / fs_open / pushed fs_change) ----
// A conversation the caller must be subscribed to: the socket's `watching` id
// is the tenant scope, so file reads can't cross conversations.
function convForViewer(ws: ServerWebSocket<SocketData>, sessionId?: string): Conv | null {
  if (!sessionId || sessionId !== ws.data.watching) return null;
  const conv = convs.get(sessionId);
  return conv && conv.subscribers.has(ws) ? conv : null;
}

// Start the single file-watcher for a conversation on first demand.
function ensureWatch(conv: Conv) {
  if (conv.stopWatch) return;
  conv.stopWatch = conv.vm.startWatch(({ path, kind }) => {
    if (kind === "deleted") conv.changed.delete(path);
    else conv.changed.add(path);
    sendToSubs(conv, { type: "fs_change", sessionId: convPublicId(conv), path, kind });
  });
}

// One PERSISTENT harness process per WebSocket connection: user messages go in
// over stdin, responses stream out over stdout. No per-message spawn, no resume
// between turns of the same connection — the process itself holds the
// conversation. Resume is only used to reopen an old conversation.
async function spawnLocalHarness(ws: ServerWebSocket<SocketData>, resumeSessionId: string | null) {
  ws.data.gateway?.close();
  ws.data.gateway = await openBrokeredSession(gateway, harness.protocol, ws.data.identity.user, localSandbox.vantage, (reason) => {
    log(`pid=${ws.data.proc?.pid}: ending turn — ${reason}`);
    sendJson(ws, { type: "error", error: `Model gateway: ${reason}` });
    ws.data.proc?.kill(); // its exit handler reports done (code≠0) for the interrupted turn
  });
  const g = harness.gatewayConfig(ws.data.gateway.conn);
  const args = [...harness.args({ resumeSessionId, systemPrompt: ASK_USER_PROMPT, mcpConfig: MCP_CONFIG }), ...g.args];

  const startedAt = Date.now();
  const proc = Bun.spawn(localSandbox.command(harness.bin, args, Object.keys(g.env)), {
    cwd: localSandbox.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...g.env },
  });
  ws.data.proc = proc;
  ws.data.procSessionId = resumeSessionId;
  ws.data.lastSessionId = resumeSessionId;
  log(
    `spawn persistent ${harness.name} pid=${proc.pid} (${localSandbox.name})` +
      (resumeSessionId ? ` resume=${resumeSessionId}` : " new session"),
  );

  let stderrTail = "";
  const stderrDone = streamLines(proc.stderr, (line) => {
    stderrTail = (stderrTail + line + "\n").slice(-4000);
  });

  streamLines(proc.stdout, makeHarnessLineHandler(ws, () => `pid=${proc.pid}`))
    .then(async () => {
      await stderrDone;
      const code = await proc.exited;
      const wasBusy = ws.data.busy;
      ws.data.proc = null;
      ws.data.busy = false;
      log(`exit persistent pid=${proc.pid} code=${code} after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      // Only surface an exit that interrupted a turn; a clean idle exit just
      // means the next message will respawn (transparently, via --resume).
      if (wasBusy) {
        sendJson(ws, { type: "done", code, ...(code !== 0 ? { stderr: stderrTail } : {}) });
      }
    })
    .catch((err) => {
      ws.data.proc = null;
      ws.data.busy = false;
      sendJson(ws, { type: "error", error: String(err) });
    });
}

// docker/local sandboxes: the per-socket persistent process.
async function sendToLocalHarness(ws: ServerWebSocket<SocketData>, text: string, sessionId?: string) {
  const desired = sessionId ?? null;
  // Conversation switched (new chat, or an old one opened from the sidebar):
  // the running process belongs to another session, so replace it.
  if (ws.data.proc && desired !== ws.data.lastSessionId) {
    log(`conversation switch → killing pid=${ws.data.proc.pid}`);
    ws.data.proc.kill();
    ws.data.proc = null;
  }
  ws.data.busy = true; // set before the async token mint so a second message can't race in
  if (!ws.data.proc) {
    try {
      await spawnLocalHarness(ws, desired);
    } catch (err) {
      ws.data.busy = false;
      sendJson(ws, { type: "error", error: `could not start ${harness.name}: ${err instanceof Error ? err.message : err}` });
      return;
    }
  }

  ws.data.lastPrompt = text;
  log(`turn start (pid=${ws.data.proc!.pid}) prompt=${JSON.stringify(text.length > 60 ? text.slice(0, 60) + "…" : text)}`);
  ws.data.proc!.stdin.write(harness.encodeUserMessage(text) + "\n");
  ws.data.proc!.stdin.flush();
}

// ---- Conversation history: rebuilt from claude's own transcript files ----
// (~/.claude/projects/<munged-cwd>/<session-id>.jsonl — the mounted host ~/.claude)
const CLAUDE_DIR = process.env.CLAUDE_DIR ?? join(process.env.HOME ?? "/", ".claude");

async function findTranscript(sessionId: string): Promise<string | null> {
  const projectsDir = join(CLAUDE_DIR, "projects");
  const dirs = await readdir(projectsDir).catch(() => [] as string[]);
  for (const dir of dirs) {
    const path = join(projectsDir, dir, `${sessionId}.jsonl`);
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

type HistoryTool = { name: string; id?: string; input?: unknown; result?: string; isError?: boolean; agentId?: string };
type HistoryMessage = { role: "user" | "assistant" | "tool"; text: string; tool?: HistoryTool };

// Rebuild a conversation from the persisted transcript, INCLUDING tool inputs and
// results (matched by tool_use_id) so badge details survive the VM's death.
function reconstructTranscript(jsonl: string): HistoryMessage[] {
  const messages: HistoryMessage[] = [];
  const toolById = new Map<string, HistoryTool>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isSidechain || entry.isMeta) continue; // subagent chatter / injected context
    if (entry.type === "user") {
      const content = entry.message?.content;
      if (Array.isArray(content)) {
        // fill tool results, in place, onto the matching tool badge
        for (const b of content) {
          if (b.type === "tool_result" && b.tool_use_id) {
            const t = toolById.get(b.tool_use_id);
            if (t) {
              const rtext = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : typeof b.content === "string" ? b.content : JSON.stringify(b.content);
              t.result = rtext;
              t.isError = !!b.is_error;
              const agentId = rtext.match(/agentId:\s*(\S+)/)?.[1];
              if (agentId) t.agentId = agentId;
            }
          }
        }
      }
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
            : "";
      if (text.trim() && !text.startsWith("<")) messages.push({ role: "user", text });
    } else if (entry.type === "assistant") {
      for (const block of entry.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) {
          messages.push({ role: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          const tool: HistoryTool = { name: block.name, id: block.id, input: block.input };
          toolById.set(block.id, tool);
          messages.push({ role: "tool", text: block.name, tool });
        }
      }
    }
  }
  return messages;
}

async function serveApi(url: URL, req: Request): Promise<Response | null> {
  if (url.pathname === "/api/conversations") {
    const { org, user } = getIdentity(req);
    return Response.json(listConversations(org, user));
  }
  const match = url.pathname.match(/^\/api\/conversations\/([0-9a-fA-F-]{8,})\/messages$/);
  if (match) {
    const path = await findTranscript(match[1]);
    if (!path) return Response.json({ error: "transcript not found" }, { status: 404 });
    return Response.json({ messages: reconstructTranscript(await Bun.file(path).text()) });
  }
  // Persisted sub-agent transcript (for reopened conversations whose VM is gone).
  const am = url.pathname.match(/^\/api\/agents\/([0-9a-fA-F-]{8,})\/([A-Za-z0-9_-]+)$/);
  if (am) {
    const f = Bun.file(agentOutputFile(am[1], am[2]));
    if (!(await f.exists())) return Response.json({ items: [], running: false });
    return Response.json({ items: parseAgentTranscript(await f.text()), running: false });
  }
  return null;
}

async function serveStatic(pathname: string): Promise<Response> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const safe = normalize(relative);
  if (safe.startsWith("..") || safe.startsWith("/")) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(join(PUBLIC_DIR, safe));
  if (await file.exists()) return new Response(file);
  return new Response("Not found (did you run `bun run build` in web/?)", { status: 404 });
}

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const upgraded = srv.upgrade(req, {
        data: {
          proc: null,
          procSessionId: null,
          lastSessionId: null,
          busy: false,
          lastPrompt: "",
          watching: null,
          identity: getIdentity(req),
          gateway: null,
        } satisfies SocketData,
      });
      if (upgraded) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    if (url.pathname === GATEWAY_TOKEN_PATH) {
      return handleGatewayTokenRequest(req);
    }
    if (url.pathname === "/health") {
      return Response.json({ ok: true, sandbox: SANDBOX, harness: harness.name, gateway: gateway.name });
    }
    if (url.pathname === "/mcp") {
      return serveMcp(req);
    }
    if (url.pathname === "/mcp/oauth/callback") {
      const html = (body: string, status = 200) =>
        new Response(`<!doctype html><meta charset=utf-8><body style="font:16px system-ui;padding:40px;background:#0f1115;color:#e6e8ee">${body}</body>`, { status, headers: { "content-type": "text/html" } });
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const p = state ? mcpPending.get(state) : undefined;
      if (!code || !p) return html("<h3>Login failed or expired.</h3><p>Close this tab and try Connect again.</p>", 400);
      mcpPending.delete(state!);
      try {
        const t = await mcpOAuth.exchangeCode(p.meta, p.clientId, p.clientSecret, code, p.verifier, MCP_REDIRECT);
        upsertOAuthServer(p.org, p.user, p.name, p.url, {
          clientId: p.clientId, clientSecret: p.clientSecret, tokenEndpoint: p.meta.tokenEndpoint, resource: p.meta.resource, ...t,
        });
        broadcastMcpList(p.org, p.user);
        log(`mcp oauth connected: ${p.name} for user=${p.user}`);
        return html(`<h3>✅ Connected “${p.name}”.</h3><p>You can close this tab and return to the chat.</p>`);
      } catch (e) {
        return html(`<h3>Token exchange failed.</h3><pre>${String(e).slice(0, 300)}</pre>`, 500);
      }
    }
    const api = await serveApi(url, req);
    if (api) return api;
    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws) {
      allSockets.add(ws);
      sendJson(ws, { type: "ready" });
      if (SANDBOX === "cubesandbox") sendJson(ws, liveSnapshot());
    },
    message(ws, raw) {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        sendJson(ws, { type: "error", error: "Invalid JSON" });
        return;
      }
      if (SANDBOX === "cubesandbox") {
        if (msg.type === "watch") {
          watchConv(ws, msg.sessionId ?? null);
          return;
        }
        if (msg.type === "end_session") {
          void endSession(msg.sessionId);
          return;
        }
        if (msg.type === "delete_conversation") {
          void deleteConversationFully(msg.sessionId);
          return;
        }
        if (msg.type === "agent_watch") {
          startAgentWatch(ws, msg.sessionId, msg.toolUseId, msg.path);
          return;
        }
        if (msg.type === "agent_unwatch") {
          stopAgentWatch(msg.sessionId, msg.toolUseId);
          return;
        }
        if (msg.type === "mcp_connect") {
          void mcpConnect(ws, msg.name, msg.url);
          return;
        }
        if (msg.type.startsWith("mcp_")) {
          const { org, user } = ws.data.identity;
          if (msg.type === "mcp_add") addMcpServer(org, user, msg.name, msg.transport, msg.config);
          else if (msg.type === "mcp_remove") deleteMcpServer(org, user, msg.id);
          else if (msg.type === "mcp_toggle") setMcpEnabled(org, user, msg.id, msg.enabled);
          sendMcpList(ws); // sanitized (no tokens)
          return;
        }
        if (msg.type === "fs_tree") {
          const conv = convForViewer(ws, msg.sessionId);
          if (!conv) return void sendJson(ws, { type: "error", sessionId: msg.sessionId, error: "not viewing that conversation" });
          ensureWatch(conv);
          conv.vm
            .listDir(msg.path ?? ".")
            .then((entries) =>
              sendJson(ws, {
                type: "fs_tree",
                sessionId: convPublicId(conv),
                path: msg.path ?? ".",
                entries,
                changed: [...conv.changed],
              }),
            )
            .catch((err) => sendJson(ws, { type: "error", sessionId: msg.sessionId, error: `list failed: ${err.message ?? err}` }));
          return;
        }
        if (msg.type === "fs_open") {
          const conv = convForViewer(ws, msg.sessionId);
          if (!conv) return void sendJson(ws, { type: "error", sessionId: msg.sessionId, error: "not viewing that conversation" });
          conv.vm
            .readFile(msg.path)
            .then((content) => sendJson(ws, { type: "fs_file", sessionId: convPublicId(conv), path: msg.path, content }))
            .catch((err) => sendJson(ws, { type: "error", sessionId: msg.sessionId, error: `open failed: ${err.message ?? err}` }));
          return;
        }
      }
      if (msg.type !== "chat" || typeof msg.text !== "string" || !msg.text.trim()) {
        sendJson(ws, { type: "error", error: "Expected {type:'chat', text, sessionId?} or {type:'watch', sessionId?}" });
        return;
      }
      if (SANDBOX === "cubesandbox") {
        void sendToVmConv(ws, msg);
        return;
      }
      if (ws.data.busy) {
        sendJson(ws, { type: "error", error: "A message is already being processed" });
        return;
      }
      void sendToLocalHarness(ws, msg.text, msg.sessionId);
    },
    close(ws) {
      allSockets.delete(ws);
      // VM conversations survive the socket — only detach the viewer.
      for (const c of convs.values()) c.subscribers.delete(ws);
      ws.data.proc?.kill();
      ws.data.proc = null;
      ws.data.gateway?.close();
      ws.data.gateway = null;
    },
  },
});

// Server going down takes its VMs with it (they'd be unreachable orphans
// otherwise; the sandbox hard timeout is only a fallback).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    for (const c of convs.values()) c.vm.kill();
    if (convs.size) await Bun.sleep(600);
    process.exit(0);
  });
}

console.log(`claude-poc server listening on http://localhost:${server.port}`);
console.log(`  plugs:        SANDBOX=${SANDBOX} HARNESS=${harness.name} GATEWAY=${gateway.name}`);
console.log(`  gateway:      ${gateway.describe()}`);
console.log(`  harness runs: ${SANDBOX === "cubesandbox"
  ? `inside a fresh CubeSandbox microVM per conversation (template "${process.env.VM_TEMPLATE ?? "claude-code"}")`
  : localSandbox.describe()}`);
console.log(`  sandbox tool: run_code via MCP at ${MCP_URL} (${sandboxConfigSummary()})`);
