# Claude Code Chat POC

Browser chat UI → Bun/TypeScript backend on the host → headless Claude Code running **inside a KVM microVM per conversation** (self-hosted CubeSandbox on AWS EC2). A Docker-container backend remains available as a fallback.

```
Browser — React chat
   │  http://localhost:5173 (vite dev)  or  http://localhost:8091 (built)
   ▼
Bun backend on the HOST — port 8091 (WebSocket + serves the web build)
   │
   │  SANDBOX=cubesandbox (default)                 SANDBOX=docker
   │  one microVM per conversation                  shared local container
   ▼                                                 ▼
SSH tunnel → AWS EC2 (Mumbai)                 docker exec -i claude-poc claude …
   │  :3000 Cube API — create/kill VM
   │  :3080 CubeProxy nginx — envd stdio via Host-header routing
   ▼
┌─ KVM microVM (template "claude-code", own Linux kernel) ──────┐
│  claude -p --input-format stream-json … (persistent, as user) │
│  full tool access (Bash, file edits) — isolated by the VM     │
│  created on the 1st message · destroyed when the chat ends    │
└───────────────────────────────────────────────────────────────┘
```

**Gateway integration write-up:** [docs/sandbox-harness-gateway.md](docs/sandbox-harness-gateway.md) · diagrams: [architecture](docs/diagrams/architecture.html), [token flow](docs/diagrams/token-flow.html), token journey [1 · login](docs/diagrams/token-journey-login.html) / [2 · each call](docs/diagrams/token-journey-use.html).

### Plugs: sandbox × harness × gateway
Three independent seams; none knows which of the others it is paired with. Sandbox and harness come from env; **the gateway is chosen per user by how they `/login`**:

| Plug | Env | Options | Code |
|---|---|---|---|
| **Sandbox** — where the agent runs | `SANDBOX` | `cubesandbox` (default), `docker`, `local` | `server/sandbox/` |
| **Harness** — the coding-agent CLI running the loop | `HARNESS` | `claude-cli` (default) | `server/harness/` |
| **Gateway** — where model calls go | `/login` | `connectra` (OneXO login), `anthropic` (own Anthropic account) | `server/gateway/` |

The only contract between a harness and a gateway is protocol-level (`HarnessGatewayConn`: credential kind, base URL per wire protocol, extra headers, the token-helper URL + key, refresh period). A gateway provider implements `open(identity, vantage)` → base URLs + `mint()`; a harness adapter implements its CLI's args, stdio encoding and `gatewayConfig(conn)`; the sandbox runs "a binary with args + env + setup files" and never knows it's claude. Adding a gateway or harness is one file plus one registry entry.

**Gateway swap per user:** the same claude-cli harness runs against either gateway depending on the user's login — `connectra` (Kong → Connectra → Bifrost with the user's own OneXO token: metered as an `ai_usage_event`, policy-checked, Connectra's routing picks the model) or `anthropic` (Claude Code straight to Anthropic on the user's own claude.ai subscription: no OneXO metering or policy).

Per-conversation flow: the first message creates a fresh microVM (~0.3 s) **with a persistent S3 volume mounted at `/home/user/projects`**, injects auth, and starts a persistent claude with stream-json stdio carried over envd's streaming RPC through the tunnel. After every turn the transcript `.jsonl` is downloaded into `~/.claude/projects/vm-claude/`, so the sidebar history works and reopening a conversation later re-mounts the same volume into a new VM and `--resume`s — claude keeps both its memory **and its files** even though the old VM is gone.

### Persistent storage (S3 volumes)
Each conversation gets its own CubeSandbox **S3 volume** (`vol-<org>-<user>-<id>`), created on first message and mounted at `/home/user/projects`. Files written by Claude persist there, survive VM teardown, and are restored when the conversation is reopened in a fresh VM. The volume is created via `POST /volumes {name,driver:"s3"}` and attached with `volumeMounts:[{name,path}]` on sandbox create; because it mounts root-owned, the backend runs a one-time `chown user:user` (as root, via envd with no auth header) at startup so Claude (running as `user`) can write. Lifecycle: **idle timeout ~5 min** and **LRU eviction** at capacity tear the VM down losslessly (files are on the volume); the **"End session" button** in the chat header kills the current conversation's VM immediately but keeps the volume (next message restarts it); "Delete conversation" also `Volume.destroy()`s it. The header button is enabled only when a live VM exists for the open conversation and no turn is running. Volume id/tenant are stored in `conversations` (migration 002).

### Model access: `/login` — OneXO (AI gateway) or your Anthropic account
Type **`/login`** in the chat. The card offers two ways for Claude to make its model calls; the choice is stored per POC user (`logins` table) and decides the gateway for that user's conversations. Until a user logs in, messages get "Run /login first"; `/logout` signs out; the header chip shows the current login.

| `/login` option | Flow | Model calls go | Credential in the harness |
|---|---|---|---|
| **OneXO (AI gateway)** | "Continue with GitHub" → OneXO's sign-in page (authorization code + PKCE, client `onexo-poc-login-3b9d41`) → back to `/auth/onexo/callback` → tenant picker if you belong to several → `/auth/onexo/tenant` | claude → Kong `/llm/anthropic` → Connectra → provider; metered, limited and policy-checked **as you** | **Your own OneXO token** (scope `ai:i` ∩ your role, tenant chosen at login), fetched by Claude's `apiKeyHelper` from this server's `/internal/gateway-token` |
| **Anthropic account** | claude.ai OAuth copy/paste: open the link, approve, paste the code (`server/auth/anthropic.ts`) | Claude Code → `api.anthropic.com` directly | Your claude.ai token as `CLAUDE_CODE_OAUTH_TOKEN`, refreshed server-side at each launch |

OneXO tokens (`server/auth/logins.ts` + `server/gateway/{broker,connectra}.ts`): each claude launch opens a gateway session with a random **helper key** scoped to that POC user. Claude's `apiKeyHelper` (passed inline via `--settings`, never written to a settings file) trades the key for the user's current OneXO access token; the server refreshes it with the stored refresh token **one refresh at a time per user** (OneXO rotates refresh tokens and revokes the whole login if a rotated-away one is reused) and always persists the newest. Claude re-runs the helper every `GATEWAY_TOKEN_REFRESH_S` (600s, below the 900s TTL) **and on any 401**, so a turn longer than the token's lifetime keeps going. Closing the session revokes the key. A OneXO login lasts as long as its refresh token (7 days), then `/login` again. Env injected for OneXO: `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS` (`X-Onexo-Correlation-Id`), `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `ONEXO_TOKEN_URL`, `ONEXO_HELPER_KEY`. Nothing is written into the VM or onto the volume. **Which model serves a call is the gateway's decision** (`CONNECTRA_MODEL` pins one and switches fallbacks off).

VMs reach both Kong and this server through reverse SSH tunnels: `-R 0.0.0.0:18000:localhost:8000` (`ONEXO_LLM_URL`) and `-R 0.0.0.0:18091:localhost:8091` (`POC_URL_FROM_VM`). Config: `server/.env.example`.

Each WebSocket connection gets **one persistent claude process** (`claude -p --input-format stream-json`): user messages are written to its stdin as JSON lines and responses stream from its stdout, so follow-up turns skip process startup entirely. `--resume <session-id>` is only used when a conversation is reopened (new tab, reconnect, or picked from the sidebar) — the transcript on disk makes that seamless. Streaming JSON events are relayed to the browser over the WebSocket as they arrive (token-by-token via `--include-partial-messages`).

**Token storm guard** (`server/gateway/broker.ts`): a harness re-runs its token helper on every 401/403, but a gateway's 403 for "model not allowed" / AI policy is not a token problem — claude would retry with backoff for minutes, silently. When one session asks for ≥4 tokens within 30s the broker refuses further tokens and the server ends the turn with a visible `Model gateway: …` error (a VM conversation's VM is released; files stay on the volume).

### Conformance (`server/scripts/conformance.ts`)
Runs every sandbox × login method through the same scenarios, using the login saved by `/login` in the real POC (copied into each isolated scenario DB; rotated OneXO refresh tokens are written back — stop the real POC server while it runs). Scenarios on a fresh, isolated POC server driven over `/ws` like the browser: **plain** reply · **tool** call (Bash) · **long-turn** longer than the token refresh (asserts ≥2 tokens + streamed partials) · **rejected-token** (first token deliberately invalid via `GATEWAY_TEST_REJECT_FIRST_TOKEN=1`; asserts recovery) · **unknown-model** (must fail visibly, not hang; a success is a WARN = silent model swap). With `ONEXO_DATABASE_URL`, Connectra runs must also show `ai_usage_event` rows for their correlation id.
```bash
cd server
ONEXO_DATABASE_URL=<onexo db url> bun scripts/conformance.ts                # local × your saved login
bun scripts/conformance.ts --sandboxes cubesandbox --logins onexo           # needs the tunnels
bun scripts/conformance.ts --only plain,tool                                # subset
```
Report: printed table + `logs/conformance-<ts>.json`; exit 1 on any FAIL. Last local run: 9 PASS, 1 WARN (Connectra silently served another model for an unknown one — OneXO-side fix tracked separately).

VM egress lockdown (VMs may reach only the tunnel ports): [docs/egress-lockdown.md](docs/egress-lockdown.md).

## Quickstart

```bash
# 1. Container (Claude runtime)
docker compose up -d --build

# 2. Login config: copy server/.env.example → server/.env and fill it in
#    (needs local OneXO running; client id/secret from onexo_v1's scripts/seed-poc-login-client.ts)
#    then type /login in the chat

# 3. Backend on the host
cd server && bun install && bun run dev          # port 8091

# 4. Frontend
cd web && bun install && bun run dev             # port 5173, /ws proxied to 8091

# 5. Sandbox tunnel — REQUIRED for the default microVM backend
#    (without it, set SANDBOX=docker to use the local container)
ssh -i ~/.ssh/onexo-poc-mumbai.pem -N \
  -L 3000:localhost:3000 -L 3080:localhost:80 -L 12088:localhost:12088 \
  ubuntu@<EC2_PUBLIC_IP>
```

Open http://localhost:5173. Alternatively `bun run build` in `web/` and open http://localhost:8091 — the backend serves the built page itself.

Requires `~/projects` on the host (bind-mounted as Claude's working directory).

## Configuration (env vars for `server/index.ts`)

| var | default | meaning |
|---|---|---|
| `PORT` | `8091` | backend port (8080 is unusable on this machine — held by another container) |
| `DOCKER_CONTAINER` | `claude-poc` | container to `docker exec` into (`SANDBOX=docker`) |
| `CONTAINER_WORKDIR` | `/home/onexo/projects` | claude's cwd inside the container |
| `PROJECTS_DIR` | `~/projects` | claude's cwd in local mode |
| `CLAUDE_BIN` | `claude` | claude binary name/path |
| `SANDBOX` | `cubesandbox` | `cubesandbox` = one microVM per conversation; `docker` = shared local container; `local` = this host |
| `HARNESS` | `claude-cli` | coding-agent CLI adapter (`server/harness/`) |
| `VM_TEMPLATE` | `claude-code` | CubeSandbox template holding node + the harness CLI + envd |
| `ONEXO_AUTH_URL` | `http://127.0.0.1:8000` | OneXO Kong, as reached from this server and the user's browser (sign-in, token, tenants) |
| `POC_LOGIN_CLIENT_ID` / `_SECRET` | _(required for OneXO login)_ | the "Login with OneXO" client (`onexo_v1/scripts/seed-poc-login-client.ts`) |
| `POC_LOGIN_REDIRECT_URI` | `http://localhost:<PORT>/auth/onexo/callback` | must equal the redirect URI registered for that client |
| `ONEXO_LLM_URL` | _(required)_ | gateway root (`…/llm`) as seen from inside the VM — the reverse tunnel |
| `POC_URL_FROM_VM` | _(required)_ | this server as seen from inside the VM — the token helper's endpoint (second reverse tunnel) |
| `GATEWAY_TOKEN_REFRESH_S` | `600` | how often claude's token helper refreshes (keep below the 900s token TTL) |
| `ONEXO_LLM_URL_CONTAINER` / `ONEXO_LLM_URL_HOST` | `http://host.docker.internal:8000/llm` / `http://127.0.0.1:8000/llm` | gateway root for `SANDBOX=docker` / `local` |
| `CONNECTRA_MODEL` / `CONNECTRA_SMALL_MODEL` | _(unset)_ | OneXO login only: optional model pin; unset = Connectra's routing decides |
| `SANDBOX_SESSION_TIMEOUT_S` | `7200` | microVM hard lifetime (safety net if a kill is missed) |
| `VM_IDLE_TTL_S` | `300` | release a conversation's VM after this long idle (resume re-mounts the volume) |
| `MAX_LIVE_VMS` | `3` | live-VM ceiling per node; new sessions past it evict the LRU idle VM |
| `POC_ORG` / `POC_USER` | `poc` / `poc-user` | stub identity for the PoC (replace with JWT/SSO in `getIdentity()`) |
| `E2B_API_URL` | `http://localhost:3000` | Cube API through the SSH tunnel |
| `CUBE_PROXY_URL` | `http://localhost:3080` | CubeProxy (nginx :80 on the instance) through the tunnel |
| `CUBE_TEMPLATE_ID` | `tpl-4c59e8b4667f4d4682ddd65d` | sandbox template (code-interpreter image) |
| `CUBE_SANDBOX_DOMAIN` | `cube.app` | sandbox routing domain (Host header) |
| `SANDBOX_EXEC_TIMEOUT_MS` | `90000` | per-execution time limit |

Frontend: `VITE_WS_TARGET` overrides where vite proxies `/ws` (default `ws://127.0.0.1:8091`).

## Auth

Model auth comes from `/login` (above) — OneXO or the user's own Anthropic account; there is no shared `ANTHROPIC_API_KEY` and no Keychain use. "Run /login first" means the POC user hasn't chosen yet; "OneXO session expired — run /login again" means the OneXO refresh token is gone (7 days, revoked, or reused). The startup lines `gateways:` / `onexo login:` show the active config.

## WebSocket protocol (`/ws` on the backend)

Client → server:

```json
{ "type": "chat", "text": "hi", "sessionId": "uuid?", "tempId": "uuid?" }
{ "type": "watch", "sessionId": "uuid?" }
```

`chat` sends a message; on a brand-new conversation omit `sessionId` and pass a `tempId` so the minted session id can be matched back to the right open tab. `watch` (VM backend) subscribes this socket to a conversation's live stream without sending a message — used when opening a conversation from the sidebar; an in-flight turn is replayed.

Server → client (VM-backend messages carry a `sessionId` so a client tracking several conversations can route them; `tempId` echoes back until the id is minted):

| message | meaning |
|---|---|
| `{"type":"ready"}` | socket accepted |
| `{"type":"live","sessions":[{sessionId,busy}]}` | which conversations have a live VM and whether each is generating (drives the sidebar dots) |
| `{"type":"session","sessionId":"...","tempId?","prev?"}` | the conversation's claude session id (matched via `tempId` for new chats or `prev` on resume) |
| `{"type":"turn_user","sessionId","text"}` | replay of the in-flight user message when you join a busy conversation |
| `{"type":"claude_event","sessionId?","event":{...}}` | one raw `stream-json` line from Claude Code (init / stream_event / assistant / result / …) |
| `{"type":"done","sessionId?","code":0}` | the turn finished (`stderr` included when code ≠ 0) |
| `{"type":"error","sessionId?","error":"..."}` | bad input, or a message sent to a conversation that's already busy |
| `{"type":"fs_tree","sessionId","path","entries":[...],"changed":[...]}` | directory listing for the Files panel (reply to a `fs_tree` request) |
| `{"type":"fs_file","sessionId","path","content"}` | one file's contents (reply to `fs_open`) |
| `{"type":"fs_change","sessionId","path","kind":"created\|modified\|deleted"}` | pushed live as Claude edits files in the VM |

VM-backend file requests (view-only): `{type:"fs_tree", sessionId, path?}` and `{type:"fs_open", sessionId, path}`. Both require the socket to currently be watching that `sessionId`, and paths are resolved server-side and rejected if they escape `/home/user/projects`.

## Expandable tool calls

Every tool call (Bash, Write/Edit, MCP calls, sub-agent `Task`/`Agent` launches, …) renders as a 🔧 badge that **expands on click** to show the call's **input** and **result**. The frontend (`web/src/App.tsx`, `ToolChip`) creates the badge at the tool_use `content_block_start` (name + `tool_use_id`), then fills in the full input from the completed `assistant` event and the result from the following `user` `tool_result`, matched by id. It formats common tools specially (Bash → the command, Write/Edit → path + content, `Task`/`Agent` → the sub-agent's description + prompt) and falls back to pretty-printed JSON.

### Persistence (details survive the VM)
Badge details are **not** lost when the sandbox dies. Tool inputs and results are reconstructed from the persisted main transcript (`~/.claude/projects/vm-claude/<session>.jsonl`, already synced per turn) — `reconstructTranscript` now emits `{name, id, input, result, isError, agentId}` per tool, matched by `tool_use_id`, and the history endpoint returns them so reopened conversations show full badge detail. Sub-agent transcripts (which live in the VM's `/tmp`) are synced out too: the backend records each agent's `output_file` path (from its tool result), and `persistAgentOutputs` / the live watcher copy the JSONL to `~/.claude/projects/vm-claude/agents/<session>/<agentId>.output`; `GET /api/agents/:session/:agentId` serves it. On expand, a badge streams live from the VM when it's up (`agent_watch`), and otherwise fetches the persisted copy.

### Sub-agent activity (live)
Background agents launched by the `Agent` tool run in the VM and write their full JSONL transcript to `…/tasks/<agentId>.output` — they do **not** appear in the main stream. Expanding a sub-agent badge streams that transcript live: the backend polls the file (`readHomeFile` in `sandbox/cubesandbox.ts`, `startAgentWatch` in `index.ts`), parses it (skipping only meta/attachment noise — sub-agent entries are all `isSidechain:true`, which is expected), and pushes a compact `agent_update` (the agent's text + its own tool calls with results). The panel shows the agent's steps as they happen and marks it done when the file stops growing; collapsing the badge stops the poll. Verified end-to-end (a launched agent's `Bash` call + final finding streamed to the UI).

## Interactive questions (ask_user)

Claude can ask the user single/multi-select questions instead of asking in prose. Via `--append-system-prompt`, the backend instructs claude to end such replies with:

```
<ask_user>
{"questions":[{"question":"Which language?","header":"Language","multiSelect":false,
  "options":[{"label":"TypeScript","description":"..."},{"label":"Python","description":"..."}]}]}
</ask_user>
```

The frontend hides the raw block from the transcript, renders an option card (radio for single-select, checkboxes for `multiSelect: true`, plus a free-text **Other…** and a **Skip** button), and sends the selection back as the next chat message on the same session, e.g. `My answer:\n- Language: TypeScript`. The question ends a turn; the answer starts the next one over the persistent process's stdin.

Try it: *"create a hello-world file but ask me which language first"*.

## Per-conversation microVMs (the default backend)

With `SANDBOX=cubesandbox`, the harness itself runs inside a hardware-isolated KVM microVM on the AWS box (`server/sandbox/cubesandbox.ts`), not in the local container:

- **Lifecycle**: first message → `POST /sandboxes` (template `claude-code`, readiness-probed on envd :49983) → the harness's setup files (claude: `~/.claude.json`) uploaded, no credentials → persistent `claude -p --input-format stream-json …` started as user `user`. Conversation switch, tab close, or socket drop kills the VM. Nothing persists between conversations.
- **Stdio transport**: envd's `process.Process/Start` connect-RPC stream (stdout out) + `SendInput` (stdin in), through the tunnel with the same Host-header trick as `run_code`. A tiny heartbeat wrapper prints to stderr every 25 s so nginx/tunnel idle timeouts never cut the stream while you think.
- **Transcripts**: synced out of the VM after every turn into `~/.claude/projects/vm-claude/<session>.jsonl` — the sidebar and resume work exactly as before; resuming uploads the transcript into the fresh VM and passes `--resume`.
- **Isolation**: claude gets `bypassPermissions` and full tools (Bash, file edits, network) because the blast radius is one throwaway VM with its own kernel. The MCP `run_code` tool is intentionally not wired into VM sessions — claude's own Bash already runs sandboxed.
- **Sessions outlive the browser**: conversations and their VMs are owned by the server (a registry in `index.ts`), not by the WebSocket. Close the tab mid-task and the VM keeps running to completion; reopen the conversation later (or from another device) and the server replays the in-flight turn and streams the rest. WebSockets are just viewers that `watch` one conversation at a time. An idle VM is released after `VM_IDLE_TTL_S` (default 15 min); resuming it recreates the VM and `--resume`s from the synced transcript.
- **Draft while running**: the composer stays editable while Claude is working — you can type your next message; only **Send** is disabled for a busy conversation (a conversation runs one turn at a time), and pressing Enter keeps your draft rather than clearing it.
- **Survives reload / tab close**: closing or reloading the browser does **not** stop the run (the VM is server-owned in the cloud). The last-open conversation is remembered (`localStorage`) and reopened on reload, re-attaching to the in-flight turn. A conversation is written to the sidebar the moment its session id is minted (not only when the turn finishes), so a chat started and immediately abandoned still appears and isn't lost.
- **Concurrent conversations**: because each conversation has its own VM, you can switch conversations mid-generation and run several at once (bounded by VM capacity). The sidebar shows a pulsing amber dot for a conversation that's generating and a green dot for an idle-but-live VM. Sending a message to a conversation that's already busy is rejected with a clear error rather than queued.
- **See what Claude changes on the VM** (view-only): the header **Files** button opens a live file panel for the current conversation — a browsable tree, a "Changed" list that fills in as Claude edits, and a per-file **before/after diff**. It's served entirely through the backend: `server/sandbox/cubesandbox.ts` calls envd's Filesystem API (`ListDir`, `/files` read, streaming `WatchDir`) over the tunnel, and `server/index.ts` fans change events to the conversation's viewers (`fs_tree` / `fs_open` / pushed `fs_change`). All reads are scoped to `/home/user/projects` and to the caller's own conversation — users never get direct network access to a VM, which is what makes it safe to scale to a multi-tenant, many-user setup. This is deliberately view-only; for a full editable IDE against a VM, run code-server in the template and expose its port via CubeProxy (documented in [docs/aws-cubesandbox.md](docs/aws-cubesandbox.md)) — not wired up here.
- **The template** (`claude-code`): node:22-slim + `@anthropic-ai/claude-code` + git/ripgrep/python3, with `/usr/bin/envd` copied from the stock `sandbox-code` image and started as the VM's CMD. Crucial discovery: the platform does **not** inject envd — the image must ship and start it itself, and the image must stay `USER root` (envd drops to `user` per request via Basic auth). Rebuild instructions in [docs/aws-cubesandbox.md](docs/aws-cubesandbox.md).
- **Capacity**: ~3–4 concurrent conversations (each VM reserves 2 vCPU / 3 GB of the t3.xlarge). Creation retries on `no more resource`; a clear error reaches the chat if the tunnel is down.

## Code execution sandbox (run_code via CubeSandbox)

In **docker/local** sessions (`SANDBOX=docker` or `local`), claude has an MCP tool **`run_code`** for executing code in hardware-isolated KVM microVMs, backed by the same self-hosted [CubeSandbox](https://github.com/TencentCloud/CubeSandbox) (see [docs/aws-cubesandbox.md](docs/aws-cubesandbox.md) for the instance runbook). VM-backend sessions don't need it — their Bash is already sandboxed.

## MCP servers (configured from the chat)

The **MCP** button in the chat header opens a manager to add MCP servers Claude can use. They're stored **per user** (DB table `mcp_servers`, keyed by `getIdentity()`), and every new VM session gets them materialized into a `--mcp-config` file (`server/db.ts` `buildMcpConfig` → uploaded to `/home/user/mcp.json`, referenced in `buildClaudeArgs`). Two transports:
- **http / sse** (remote): just a URL + optional headers; reached via the VM's egress. No in-VM install.
- **stdio** (in-VM): a command like `npx -y @modelcontextprotocol/server-github` with args + optional env; runs inside the microVM (its binary is fetched via egress on first use, so the first turn is slower — `MCP_TIMEOUT` is raised to 60s).

Open it with the **MCP** header button or by typing **`/mcp`** in the composer. Add/enable/remove happen over WebSocket (`mcp_add` / `mcp_toggle` / `mcp_remove` / `mcp_list` → `mcp_servers`); changes apply to the **next** session. Secrets (headers/env) are stored in the row (encrypt for production) and injected at launch, never written to the persistent volume. Verified end-to-end: a configured `everything` server's `echo` tool was called by Claude in the VM.

### One-click OAuth "Connect" (like Claude Code's `/mcp`)
For hosted servers that use OAuth, the MCP panel's **Connect** flow has a **dropdown of providers whose dynamic client registration is verified to work end-to-end** (Notion, Linear, Sentry, Asana, PayPal, Square, Vercel, Webflow, Wix, Canva) plus a **Custom…** option for any other URL; picking one needs no manual token. Note: some servers advertise OAuth but **can't** be auto-connected — GitHub omits dynamic registration entirely, Figma gates it (403), Stripe doesn't expose the metadata — so they're excluded from the dropdown and must be added under **Advanced** with a token/PAT (e.g. `Authorization: Bearer …`). The Connect flow surfaces an actionable error if a Custom URL hits this. The backend (`server/mcp-oauth.ts`) implements the MCP authorization spec: on `mcp_connect` it discovers the server's OAuth (401 → RFC 9728 protected-resource metadata → RFC 8414 auth-server metadata), does **dynamic client registration** (RFC 7591) with redirect `http://localhost:<PORT>/mcp/oauth/callback`, and returns a PKCE authorize URL. The browser opens it, the user approves, the provider redirects to the callback, and the backend exchanges the code for a token, stores it in `mcp_servers.oauth_json` (never sent to the browser), and injects `Authorization: Bearer …` into that server's config at session start (refreshing when near expiry). Verified through the authorize-URL step against Notion/Linear (DCR with a localhost redirect is accepted); the final token exchange completes on the user's real browser approval. Try it: *"run some python to check if 2^61-1 is prime"* — the tool call shows up as a 🔧 chip in the chat.

How it's wired (`server/sandbox.ts` + the `/mcp` endpoint in `server/index.ts`):

- The backend itself serves a minimal **MCP streamable-HTTP endpoint** at `/mcp` and passes `--mcp-config` to claude pointing at `http://host.docker.internal:8091/mcp` — so the tool needs no extra process and no SDK inside the container.
- Each `run_code` call creates a **fresh microVM** (E2B-compatible `POST /sandboxes` on the tunneled Cube API), executes via CubeProxy, and kills the VM. Nothing persists between calls.
- Code execution reaches the right microVM through a **Host-header trick**: nginx on the instance routes `49999-<sandboxID>.cube.app`, which doesn't resolve on this machine — so the client POSTs to the tunneled nginx port (`:3080`) and sets the `Host` header manually. No DNS or TLS setup needed locally.
- The instance fits ~3 concurrent sandboxes (2 vCPU / 2 GB each) and frees capacity **asynchronously** (~10 s after a kill), so creation retries up to 5× on "no more resource".
- If the tunnel is down, the tool returns a clear "Sandbox unavailable" error to claude instead of hanging the turn.

Note: the official `e2b` JS SDK (v2+) does **not** work against this deployment — it calls `POST /v2/sandboxes`, which CubeSandbox doesn't implement (405). `sandbox.ts` speaks the v1 REST API directly instead.

## Conversation history (sidebar)

The sidebar lists past conversations and starts new chats. Storage is deliberately minimal: a SQLite db (`server/chats.db`, Bun's built-in `bun:sqlite`, tiny versioned migration in `server/db.ts`) stores only **session_id + title + timestamps**. The messages themselves are never stored — claude already persists every session as a transcript at `~/.claude/projects/<project>/<session-id>.jsonl` (the mounted host `~/.claude`), and the backend rebuilds the full history from that file on demand:

- `GET /api/conversations` — sidebar list (newest first)
- `GET /api/conversations/:sessionId/messages` — parses the JSONL transcript into `{role: user|assistant|tool, text}` messages (skips subagent sidechains and meta entries)

Clicking a conversation loads its history and continues it — the next message just `--resume`s that session id.

## Observing claude launches

The backend logs every lifecycle (`spawn pid=… new session/resume=… prompt=…`, `session <id>`, `exit code=… in Ns`). To watch the process inside the container: `docker exec -it claude-poc watch -n 0.5 "ps aux | grep 'claude -p' | grep -v grep"`. Session transcripts land in the mounted `~/.claude/projects/`.

## Notes

- Claude runs with `--permission-mode bypassPermissions` — sandboxed by the container, which can only touch the two mounts. With `SANDBOX=local` that applies to your machine, so point `PROJECTS_DIR` somewhere disposable if unsure.
- **docker backend**: one persistent claude process per WebSocket; one turn at a time — concurrent sends get an `error` reply. Switching conversations replaces the process (respawned with `--resume`). Closing the tab kills the process. (The VM backend behaves differently — see the microVM section: conversations are server-owned, survive the tab, and run concurrently.)
- Container code changes need `docker compose up -d --build`; backend/frontend changes just need a process restart.
