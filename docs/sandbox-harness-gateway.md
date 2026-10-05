# Claude CLI harness through the OneXO AI gateway

How the CubeSandbox chat POC was changed so that **Claude Code CLI is the harness** and
**every model call goes through OneXO's AI gateway** (Kong → Connectra → Bifrost), with the
gateway, harness and sandbox as independent, swappable plugs.

- **Diagrams:** [`diagrams/architecture.html`](diagrams/architecture.html) (system + trust
  zones) and [`diagrams/token-flow.html`](diagrams/token-flow.html) (token mint, call, recovery).
- **Branches:** `feat/sandbox-harness-gateway` in this repo and in `onexo_v1`.
- **Jump to:** [§4 code changes, file by file](#4-code-changes-file-by-file) ·
  [§5 infra requirements](#5-infra-requirements) · [§6 how to verify](#6-how-to-verify)

---

## 1. Result

| | Before | After |
|---|---|---|
| Model auth | Personal claude.ai login (OAuth `/login`) or a raw `ANTHROPIC_API_KEY` uploaded into each VM | No login, no provider key. A short-lived **OneXO token**, delegated to the real OneXO user |
| Model path | Claude CLI → `api.anthropic.com` directly | Claude CLI → OneXO **Kong `/llm/anthropic`** → **Connectra** → **Bifrost** → provider (Bedrock today) |
| Metering / budgets / policy | None | Every call is an `ai_usage_event` row for that user + tenant; OneXO AI policies and limits apply |
| Model choice | Hard-wired in the CLI | **The gateway decides** (Connectra routing). The POC sets no model unless a gateway pins one |
| Swappability | Claude + CubeSandbox + Anthropic welded together | `SANDBOX` × `HARNESS` × `GATEWAY` chosen by env; each is one file + one registry line |
| Long turns | n/a | Tokens refresh mid-turn (every 10 min and on any 401), so a turn can outlive the 15-min token |
| Failure visibility | n/a | A gateway refusal (403 "model not allowed" / AI policy) ends the turn with a clear error in ~5 s instead of minutes of silent retries |

Verified live on a laptop against local OneXO: a chat from the POC UI produced
`ai_usage_event` #659 (user `f623d89d0182713c`, client `onexo-sandbox-harness-7c31e5`,
`POST /llm/anthropic/v1/messages`, 200, streamed) with the same correlation id the POC logged.

---

## 2. Architecture

```
Browser chat ─WS─▶ POC backend (plugs + token broker) ─start/stdio─▶ CubeSandbox microVM: claude -p
                        ▲                                                  │
                        └──── apiKeyHelper → /internal/gateway-token ◀─────┤   (reverse tunnel :18091)
                        │                                                  │
                        └─ mint: /public/auth/token (client_credentials,   │
                             act_user_id/act_tenant_id) ─▶ OneXO auth      │
                                                                           ▼   (reverse tunnel :18000)
                                           OneXO Kong /llm/anthropic ─▶ Connectra ─▶ Bifrost ─▶ Bedrock
                                           (onexo-auth JWT, ai:i)      (policy, limits,
                                                                        metering, fallback)
VM → api.anthropic.com : blocked (no key in the VM; egress lockdown closes it at the network)
```

**The plugs** (`server/`):

| Plug | Env | Options | Owns |
|---|---|---|---|
| Sandbox | `SANDBOX` | `cubesandbox` (default), `docker`, `local` | Where the CLI process runs; the address it uses to reach the gateway ("vantage") |
| Harness | `HARNESS` | `claude-cli` | CLI flags, stdin/stdout format, how it's pointed at a gateway, setup files, transcript path |
| Gateway | `GATEWAY` | `connectra` (default), `bifrost` (dev comparison) | Base URLs per wire protocol, how a token is minted, required headers, model hints |

The only contract between a harness and a gateway is protocol-level: base URL per wire
protocol (Anthropic Messages / OpenAI), extra headers, a token-helper URL + key, a refresh
period, and optional model ids. Neither side knows which concrete other side it's paired with.

---

## 3. What was done, phase by phase

### Phase 1 — OneXO setup (local)
- Added `onexo_v1/scripts/seed-sandbox-harness-client.ts` (+ `docs/scripts.md`): a dev-only
  OAuth client `onexo-sandbox-harness-7c31e5` with scopes **`ai:i`** (invoke models) and
  **`ai:dg`** (mint tokens on behalf of a user via `act_user_id`/`act_tenant_id`).
- Verified token minting through Kong `/public/auth/token` and a real Anthropic-format call
  through Kong `/llm/anthropic` with usage metered per user.
- Findings: the Default tenant's AI policy only allows Gemini (the POC uses the **Gateway
  Test** tenant `4721391d31b93cb8`); Connectra's fallback chain silently serves a different
  model when the requested one fails.

### Phase 2 — Claude CLI → gateway (`d01b496`)
- Claude gets only env: `ANTHROPIC_BASE_URL=<llm root>/anthropic`, the OneXO bearer,
  `ANTHROPIC_CUSTOM_HEADERS: X-Onexo-Correlation-Id`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Removed the `/login` OAuth flow (server + UI), `.credentials.json` injection and sync, and
  the `ANTHROPIC_API_KEY` path. Nothing secret is written into the VM or onto the volume.
- POC user → OneXO user/tenant mapping via `ONEXO_ACT_USER_ID`/`ONEXO_ACT_TENANT_ID`
  (or `ONEXO_IDENTITY_MAP`).

### Phase 3 — Token refresh without restarts (`d5dee18`)
- Planned "restart claude with `--resume` before expiry" was replaced: it can't save a single
  turn longer than the 15-min token.
- Instead Claude's **`apiKeyHelper`** (passed inline with `--settings`, never written to a
  settings file) fetches a fresh token from the POC's **token broker**
  (`/internal/gateway-token`) using a random per-session key. Claude re-runs it every
  `GATEWAY_TOKEN_REFRESH_S` (600 s) and after any 401. The client secret never leaves the POC
  backend; closing the session revokes the key.
- Verified: one 89-s turn with a 20-s refresh fetched 4 tokens and finished; a deliberately
  bad token is recovered automatically; a closed session's key gets 401.

### Phase 4 — Plugs (`141cc7c`)
- `server/gateway/` (provider interface, `connectra.ts`, provider-agnostic `broker.ts`),
  `server/harness/` (`claude-cli.ts`), `server/sandbox/` (`cubesandbox.ts`, formerly
  `vmclaude.ts`, now harness-agnostic; `local.ts` for docker/local).
- Renamed config: `CLAUDE_BACKEND` → `SANDBOX`, `CLAUDE_CONTAINER` → `DOCKER_CONTAINER`
  (local = `SANDBOX=local`), `CLAUDE_VM_TEMPLATE` → `VM_TEMPLATE`.

### Phase 5 — Gateway swap (`942299c`)
- Added `GATEWAY=bifrost` (Bifrost directly with one virtual key, no OneXO identity/metering)
  as a comparison point. The same harness and chat ran unchanged against both gateways.
- Model choice moved into the gateway plug: Connectra leaves it unset (its routing decides);
  Bifrost requires explicit ids (`BIFROST_MODEL`). `GATEWAY_MODEL` → `CONNECTRA_MODEL`.
- Codex as a second harness was deferred.

### Phase 6 — Conformance + storm guard (`81fd8e7`)
- `server/scripts/conformance.ts`: every sandbox × gateway pair through **plain**, **tool**,
  **long-turn**, **rejected-token**, **unknown-model**, driven over `/ws` like the browser,
  with optional OneXO metering checks. Local result: 9 PASS, 1 WARN (Connectra silent fallback).
- It found that a gateway **403** ("model not allowed" / AI policy) makes Claude treat its
  token as bad and retry for minutes in silence. The broker now detects a **token storm**
  (≥4 helper calls in 30 s), refuses further tokens, and the server ends the turn with a
  visible `Model gateway: …` error.
- `docs/egress-lockdown.md`: the EC2 runbook to restrict VMs to the tunnel ports only.

### Phase 7 — Pinned models are never silently swapped (OneXO `c739bed5`)
- **Connectra** honours request header **`x-onexo-fallbacks: off`**: it skips its org
  fallback-chain injection, so a pinned model runs or fails visibly. Never forwarded to Bifrost.
- **`@bot/agent`** switched from rewriting the request body (`fallbacks: []`) to the same
  header — one mechanism for every harness. A dead leftover field was removed.
- **POC:** the Connectra plug sends the header whenever `CONNECTRA_MODEL` pins a model.
- Tests: 1142 pass / 0 fail across `modules/connectra` + `modules/agent`; docs, `docs/api.md`
  and a Bruno request updated.
- Backend gate: typecheck and scripts tests pass. One full module-test run had 54 failures, none
  in Connectra: 6 are identical on untouched `main` (pre-existing), the rest pass when their files
  run on their own (load/order flakes during a 37-min run next to a live OneXO stack).
- **Proposal only** (`onexo_v1/feature/connectra-policy-denial-status.md`): answer policy
  denials with a non-auth status (400) on the model routes so CLI harnesses don't retry them
  as bad tokens.

---

## 4. Code changes, file by file

### 4.1 The call path in code (how one chat message reaches the gateway)

1. **`server/index.ts` → `createConv()`** — the first chat message creates a VM conversation;
   its `launch()` callback runs once the VM is up.
2. **`server/gateway/broker.ts` → `openBrokeredSession()`** — asks the selected gateway
   provider to open an upstream, mints a random per-session **helper key**, and returns a
   protocol-level `HarnessGatewayConn` (base URLs, headers, token URL, helper key, refresh period).
3. **`server/gateway/connectra.ts` → `open()` / `mintToken()`** — `POST <Kong>/public/auth/token`
   with `grant_type=client_credentials`, `client_id/secret` of `onexo-sandbox-harness-7c31e5`,
   and `act_user_id`/`act_tenant_id` (from `ONEXO_ACT_*` / `ONEXO_IDENTITY_MAP`). Returns base
   URLs `…/llm/anthropic` and `…/llm/v1`, the `X-Onexo-Correlation-Id` header (+
   `X-Onexo-Fallbacks: off` when `CONNECTRA_MODEL` pins a model), and optional model hints.
4. **`server/harness/claude-cli.ts` → `gatewayConfig()`** — turns that into Claude CLI env:
   `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_CODE_API_KEY_HELPER_TTL_MS`,
   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `ONEXO_TOKEN_URL`, `ONEXO_HELPER_KEY`
   (+ `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_HAIKU_MODEL` only if the gateway gives hints), and
   the extra arg `--settings '{"apiKeyHelper": "curl … || node -e …"}'`.
5. **`server/sandbox/cubesandbox.ts` → `init()`** — uploads the harness's setup files (claude:
   `~/.claude.json` onboarding only — no credentials) and starts `claude -p … --settings …` via
   envd `process.Process/Start` with that env, as user `user`, cwd `/home/user/projects`.
6. **Inside the VM** — before each model call, Claude runs the `apiKeyHelper`, which does
   `GET $ONEXO_TOKEN_URL` with `Authorization: Bearer $ONEXO_HELPER_KEY` (tunnel `:18091`).
7. **`server/gateway/broker.ts` → `handleGatewayTokenRequest()`** (route
   `/internal/gateway-token` in `server/index.ts`) — looks up the helper key, calls the
   upstream's `mint()` for a fresh OneXO JWT, returns it as plain text; logs
   `gateway token issued corr=… n=…`; trips the storm guard on ≥4 calls in 30 s.
8. **Claude CLI** — sends `POST $ANTHROPIC_BASE_URL/v1/messages` with `Authorization: Bearer
   <OneXO JWT>` + the custom headers (tunnel `:18000`) → Kong (`onexo-auth`, `ai:i`) →
   Connectra (policy, limits, metering into `ai_usage_event`, fallback chain unless
   `x-onexo-fallbacks: off`) → Bifrost → provider. Every 600 s, and after any 401, step 6 repeats.
9. **Teardown** — `finalizeConv()` calls the session's `close()`: the helper key stops working.

### 4.2 POC repo (`onexo-poc`)

| File | Change | Why |
|---|---|---|
| `server/gateway/types.ts` | **New.** `GatewayProvider`, `GatewayUpstream` (`baseUrls`, `mint`, `models`, `headers`), `Vantage` (`vm`/`container`/`host`), `WireProtocol` | The gateway plug's contract — knows nothing about the harness |
| `server/gateway/connectra.ts` | **New.** OneXO provider: token mint via `/public/auth/token` (client_credentials + `act_user_id`/`act_tenant_id`), per-vantage `/llm` root, correlation header, optional `CONNECTRA_MODEL` + `X-Onexo-Fallbacks: off` | The actual Claude-CLI → OneXO-gateway integration |
| `server/gateway/broker.ts` | **New.** Per-session helper keys, `/internal/gateway-token` handler, token-issue logging, token-storm guard, `GATEWAY_TEST_REJECT_FIRST_TOKEN` conformance hook | Fresh tokens for long turns; client secret never leaves the backend |
| `server/gateway/bifrost.ts` | **New.** Direct-Bifrost provider (one virtual key, explicit `BIFROST_MODEL`) | Proves the gateway is swappable; dev-only |
| `server/gateway/index.ts` | **New.** `selectGateway()` (`GATEWAY=`) | Registry |
| `server/harness/types.ts` | **New.** `HarnessAdapter` (`args`, `gatewayConfig`, `encodeUserMessage`, `decodeLine`, `setupFiles`, `transcriptPath`) | The harness plug's contract — knows nothing about OneXO |
| `server/harness/claude-cli.ts` | **New.** Claude Code adapter: stream-json flags, `ANTHROPIC_*` env, inline `--settings` `apiKeyHelper` (curl, node fallback), transcript path | Everything Claude-specific in one file |
| `server/harness/index.ts` | **New.** `selectHarness()` (`HARNESS=`) | Registry |
| `server/sandbox/cubesandbox.ts` | **Moved** from `vmclaude.ts`. Removed `.credentials.json` upload/sync and `ANTHROPIC_API_KEY`; launch now comes from a `launch()` callback (bin, args, env, files); transcript path from the harness; `readAgentOutput` → generic `readHomeFile` | VM holds no credentials; sandbox no longer hard-codes `claude` |
| `server/sandbox/local.ts` | **New.** `docker` and `local` sandboxes (`docker exec -e KEY` so tokens never land in argv); creates `PROJECTS_DIR` for `local` | Same harness/gateway on non-VM sandboxes |
| `server/index.ts` | Wires the plugs (`SANDBOX`/`HARNESS`/`GATEWAY`); VM and docker/local launches go through the broker + harness adapter; `/internal/gateway-token` route; storm guard ends the turn with a visible error; removed `/login`, `buildClaudeArgs`, `CLAUDE_BACKEND`/`CLAUDE_CONTAINER` | Single orchestration path, no Claude/OneXO specifics |
| `server/oauth.ts` | **Deleted** | No claude.ai login anymore |
| `web/src/App.tsx`, `web/src/app.css` | Removed the `/login` command and login card; rebuilt `server/public/` | UI had a dead flow |
| `server/scripts/conformance.ts` | **New.** sandbox × gateway matrix (plain, tool, long-turn, rejected-token, unknown-model) + OneXO metering check | Repeatable proof |
| `server/.env.example` | **New** (was ignored by mistake). All gateway/plug variables | Config reference; real `server/.env` stays gitignored |
| `server/tsconfig.json`, `.gitignore` | Typecheck `scripts/`; ignore `logs/`, `.env`, `*.pem`, `*.db` | Hygiene |
| `docker-compose.yml` | Dropped `ANTHROPIC_API_KEY` | Container gets gateway env per launch |
| `README.md`, `SETUP.md`, `USE-CASES.md`, `architecture.html`, `docs/aws-cubesandbox.md`, `docs/persistent-sessions.md` | Model access, plugs, config table, tunnels, conformance | Docs match the code |
| `docs/egress-lockdown.md` | **New.** EC2 lockdown runbook | Network-level "no direct path" |
| `docs/sandbox-harness-gateway.md`, `docs/diagrams/*.html` | **New.** This write-up + two diagrams | — |

### 4.3 OneXO repo (`onexo_v1`)

| File | Change | Why |
|---|---|---|
| `scripts/seed-sandbox-harness-client.ts` | **New** (committed `4afb77fc`). Dev-only OAuth client `onexo-sandbox-harness-7c31e5`, scopes `ai:i ai:dg`, idempotent, refuses `NODE_ENV=production` | The identity the POC mints delegated tokens with |
| `docs/scripts.md` | Entry for the seed script | Keep-in-sync rule |
| `modules/connectra/src/proxy.ts` | **Phase 7** (`c739bed5`). `fallbacksDisabledByHeader()` — recognizes `x-onexo-fallbacks: off` | A header any CLI harness can send (they can't rewrite bodies) |
| `modules/connectra/src/app.ts` | **Phase 7.** Skips fallback-chain injection when that header is present | Pinned model runs or fails visibly |
| `modules/agent/src/provider.ts` | **Phase 7.** Sends the same header for an explicit model pick instead of rewriting the body to `fallbacks: []` | One mechanism for every harness |
| `modules/agent/src/connectra.ts` | **Phase 7.** Removed the unused `ConnectraRequestBody.fallbacks` field | No dual paths |
| `modules/connectra/src/{app,proxy}.test.ts`, `modules/agent/src/provider.test.ts` | **Phase 7.** Header honored/ignored cases, never forwarded upstream, body untouched | 1142 pass / 0 fail |
| `docs/modules/connectra.md`, `docs/modules/agent.md`, `docs/api.md`, `api_collection/connectra/anthropic-messages-fallbacks-off.bru`, `feature/agent-model-picker.md` | **Phase 7.** Header documented; old body mechanism marked superseded | Keep-in-sync rule |
| `feature/connectra-policy-denial-status.md` | **New, proposal only.** 403 → 400 for policy denials | Decision pending |

No OneXO schema, migration, Kong route, or `@bot/contracts` change was needed.

---

## 5. Infra requirements

### 5a. To run it as built today (local OneXO + CubeSandbox EC2)

| # | Owner | Requirement | Why |
|---|---|---|---|
| 1 | OneXO (dev DB) | Run `bun scripts/seed-sandbox-harness-client.ts`; put the printed id/secret in the POC `server/.env` | The client the POC mints tokens with (`ai:i` + `ai:dg`) |
| 2 | OneXO | Map the POC user to a real OneXO user + a tenant whose **AI policy allows the models** the gateway will serve | Otherwise every call is a 403 (now a visible error) |
| 3 | OneXO / Bifrost | At least one working provider + models in Bifrost (today: Bedrock `global.anthropic.claude-sonnet-5`), and a **fallback chain** that resolves Claude CLI's default model names | The POC sends no model; Connectra's routing must land on a servable one |
| 4 | EC2 | `GatewayPorts clientspecified` in `/etc/ssh/sshd_config` | Lets the reverse tunnels bind where VMs can reach them |
| 5 | Laptop | SSH with `-R 0.0.0.0:18000:localhost:8000 -R 0.0.0.0:18091:localhost:8091` (+ the existing `-L` ports) | VM → Kong `/llm` and VM → token broker |
| 6 | POC | `ONEXO_LLM_URL=http://<vm-gateway-ip>:18000/llm`, `POC_URL_FROM_VM=http://<vm-gateway-ip>:18091` | The addresses as seen from inside a VM |
| 7 | EC2 security group | Keep `18000`/`18091` **closed** to the internet | They're tunnel ports for VMs only |
| 8 | EC2 | Egress lockdown per `docs/egress-lockdown.md` (template without `--allow-internet-access`, or host iptables) | Makes "no direct path to Anthropic" a network fact, not just a missing key |
| 9 | OneXO | Restart Connectra and `@bot/agent` after phase 7 is merged | They don't hot-reload; the header only works on the new code |

### 5b. To make it a real (shared/staging/production) capability

| # | Area | Requirement |
|---|---|---|
| 1 | **Networking** | Replace the laptop SSH tunnels with private networking: the CubeSandbox hosts reach OneXO Kong over the VPC (peering / Transit Gateway / PrivateLink), and the POC backend runs as a service next to them. Security groups: CubeSandbox → Kong `:443` `/llm/*` + `/public/auth/token` only |
| 2 | **Identity** | Replace the POC's stub `getIdentity()` with OneXO auth (the user's session/JWT), so `act_user_id`/`act_tenant_id` come from the logged-in user, not env |
| 3 | **Auth client** | Register a dedicated production client (not the dev seed) with only `ai:i ai:dg`; store its secret in the secret manager the POC backend reads; rotate it like other service clients |
| 4 | **Token TTL** | Keep the 900 s access TTL with the helper refresh (600 s), or set a client-specific TTL; refresh must stay below TTL |
| 5 | **Kong limits** | `llm-anthropic`/`llm-openai` allow 600 req/min and a 60-s SSE idle window; size the rate limit for N concurrent harnesses (key it per user, not per client) and raise the `/llm` read timeout if long silent tool runs get cut |
| 6 | **Models & policy** | Per-tenant AI policies that include the harness's models; per-user budgets/limits in Connectra for the harness population |
| 7 | **Egress** | Egress lockdown on every CubeSandbox host; if agents need npm/pip/git, an allowlist proxy on the host instead of open internet |
| 8 | **Bifrost** | If `GATEWAY=bifrost` is ever used beyond local comparison, a **dedicated virtual key** (today it borrows Connectra's), and never ship that key into a shared VM |
| 9 | **Observability** | Dashboards/alerts on `ai_usage_event` by `client_id=onexo-sandbox-harness-*`, POC broker token-storm log lines, and Bifrost per-call logs (correlation id joins all three) |
| 10 | **Decision** | The 403 → 400 proposal for policy denials (`feature/connectra-policy-denial-status.md`), so every harness — not just this POC's storm guard — fails fast |

---

## 6. How to verify

- Local, no EC2: `SANDBOX=local HOME=/tmp/poc-home PROJECTS_DIR=/tmp/poc-projects bun run index.ts`
  in `server/`, send a chat, then look up the logged `corr=poc-…` in OneXO's `ai_usage_event`.
- Automated: `ONEXO_DATABASE_URL=… bun scripts/conformance.ts` (expect 9 PASS + 1 WARN before
  phase 7, 10 PASS after).
- VM path: tunnels up, then `bun scripts/conformance.ts --sandboxes cubesandbox --gateways connectra`.

## 7. Known gaps

- The **CubeSandbox VM path and the docker sandbox were not run** end to end after the
  refactor (no EC2 access from the dev machine); the laptop (`local`) path is fully verified.
- Connectra records `prompt_tokens=0` on some streamed, cached CLI calls (output tokens are
  recorded) — check before relying on input-token budgets.
- Codex as a second harness was deferred (it needs an event translator to the UI's format and
  a VM template rebuild).
- Phase 7 needs Connectra and `@bot/agent` restarted on the new code before the
  `x-onexo-fallbacks` header takes effect locally.
