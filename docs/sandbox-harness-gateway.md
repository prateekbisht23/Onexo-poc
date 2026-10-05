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
| Model auth | One shared personal claude.ai login (OAuth `/login`) or a raw `ANTHROPIC_API_KEY` uploaded into each VM | **`/login` with two options per user**: **OneXO (AI gateway)** — the user's own short-lived OneXO token — or **Anthropic account** — the user's own claude.ai subscription. No shared key, nothing written into the VM |
| Model path | Claude CLI → `api.anthropic.com` directly | OneXO login: Claude CLI → OneXO **Kong `/llm/anthropic`** → **Connectra** → **Bifrost** → provider (Bedrock today). Anthropic login: Claude CLI → Anthropic directly |
| Metering / budgets / policy | None | Every call is an `ai_usage_event` row for that user + tenant; OneXO AI policies and limits apply |
| Model choice | Hard-wired in the CLI | **The gateway decides** (Connectra routing). The POC sets no model unless a gateway pins one |
| Swappability | Claude + CubeSandbox + Anthropic welded together | `SANDBOX` × `HARNESS` from env; **the gateway per user from `/login`**; each plug is one file + one registry line |
| Long turns | n/a | Tokens refresh mid-turn (every 10 min and on any 401), so a turn can outlive the 15-min token |
| Failure visibility | n/a | A gateway refusal (403 "model not allowed" / AI policy) ends the turn with a clear error in ~5 s instead of minutes of silent retries |

Verified live on a laptop against local OneXO: a chat from the POC UI produced
`ai_usage_event` #659 (user `f623d89d0182713c`, client `onexo-sandbox-harness-7c31e5`,
`POST /llm/anthropic/v1/messages`, 200, streamed) with the same correlation id the POC logged.

---

## 2. Architecture

```
Browser chat ─/login─┬─ OneXO:     OneXO sign-in (GitHub, PKCE) ─▶ /auth/onexo/callback ─▶ tenant pick
                     └─ Anthropic: claude.ai copy/paste code
     │ WS
     ▼
POC backend (plugs + logins + token broker) ─start/stdio─▶ CubeSandbox microVM: claude -p
     ▲                                                          │
     └── apiKeyHelper → /internal/gateway-token ◀───────────────┤  (reverse tunnel :18091)
     │     returns the user's own OneXO token                   │
     └─ refresh_token + tenant_id (rotating, one at a time) ─▶ OneXO auth
                                                                ▼  (reverse tunnel :18000)
                          OneXO Kong /llm/anthropic ─▶ Connectra ─▶ Bifrost ─▶ Bedrock
                          (onexo-auth JWT, ai:i, tid)  (policy, limits, metering as the user, fallback)

Anthropic-account login instead: claude -p ─CLAUDE_CODE_OAUTH_TOKEN─▶ api.anthropic.com (no OneXO)
```

**The plugs** (`server/`):

| Plug | Env | Options | Owns |
|---|---|---|---|
| Sandbox | `SANDBOX` | `cubesandbox` (default), `docker`, `local` | Where the CLI process runs; the address it uses to reach the gateway ("vantage") |
| Harness | `HARNESS` | `claude-cli` | CLI flags, stdin/stdout format, how it's pointed at a gateway, setup files, transcript path |
| Gateway | `/login` (per user) | `connectra` (OneXO login), `anthropic` (Anthropic-account login) | Credential kind, base URLs per wire protocol, how a token is minted, required headers, model hints |

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

### Phase 8 — `/login` with two options: OneXO (AI gateway) or Anthropic account
- **`/login`** shows a card with **OneXO (AI gateway)** ("Continue with GitHub", from OneXO's own
  enabled providers) and **Anthropic account**; the header chip shows the current login;
  `/logout` signs out; a user who hasn't logged in gets "Run /login first".
- **OneXO login** = OneXO's authorization code + PKCE for an external app (OneXO
  `seed-poc-login-client.ts`, client `onexo-poc-login-3b9d41`, redirect
  `http://localhost:8091/auth/onexo/callback`, scope `ai:i`): sign in on OneXO → `/auth/onexo/callback`
  exchanges the code, checks the user has `ai:i`, lists tenants → `/auth/onexo/tenant` picker (if
  more than one) → token re-issued for that tenant (`/llm` requires `tid`). The harness then uses
  **the user's own token** — role scopes enforced — instead of a delegated service token. The
  `ai:dg` delegation client and the `ONEXO_ACT_*` env mapping were removed (the old client row is
  deactivated, its audit history kept).
- **Refresh safety:** OneXO rotates refresh tokens and revokes the whole login if a rotated-away
  token is reused, so `auth/logins.ts` refreshes **one at a time per user** and always persists
  the newest; a dead login surfaces as "OneXO session expired — run /login again".
- **Anthropic login** = the original copy/paste claude.ai OAuth, now **per POC user** (not one
  shared file); the token reaches Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`, refreshed server-side
  at each launch. Calls go to Anthropic directly — no OneXO metering or policy.
- **Gateway per user:** the login method selects the gateway (`onexo` → `connectra`,
  `anthropic` → `anthropic`), replacing the server-wide `GATEWAY=`; the dev-only `bifrost`
  gateway was removed (the real per-login swap supersedes it).
- **Conformance** now runs per login method using the login saved by `/login`, copying it into
  each isolated scenario and writing rotated tokens back.
- Verified without a browser: login gate, `/login` options (GitHub), OneXO accepts the
  authorize URL (302 → GitHub), Anthropic link. The GitHub sign-in itself needs a real browser.

---

## 4. Code changes, file by file

### 4.1 The call path in code (how one chat message reaches the gateway)

1. **`server/index.ts` → `createConv()`** — the first chat message creates a VM conversation;
   its `launch()` callback runs once the VM is up.
2. **`server/gateway/broker.ts` → `openBrokeredSession()`** — asks the selected gateway
   provider to open an upstream, mints a random per-session **helper key**, and returns a
   protocol-level `HarnessGatewayConn` (base URLs, headers, token URL, helper key, refresh period).
3. **`server/gateway/connectra.ts` → `open()`** (chosen because the user's `/login` method is
   `onexo`) — its `mint()` is `auth/logins.ts` → `onexoAccessToken(identity)`: the user's stored
   OneXO access token, refreshed via `POST <Kong>/public/auth/token` `grant_type=refresh_token` +
   `tenant_id` when near expiry (serialized per user; the rotated refresh token is persisted).
   Returns base URLs `…/llm/anthropic` and `…/llm/v1`, the `X-Onexo-Correlation-Id` header (+
   `X-Onexo-Fallbacks: off` when `CONNECTRA_MODEL` pins a model), and optional model hints.
   (Login itself: `/login` → `auth/onexo.ts` `authorizeUrl()` → OneXO sign-in →
   `/auth/onexo/callback` → `exchangeCode()` → tenant pick → `refreshTokens(…, tenantId)` →
   `saveOnexoLogin()`.)
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
   upstream's `mint()` for the user's current OneXO JWT, returns it as plain text; logs
   `gateway token issued corr=… n=…`; trips the storm guard on ≥4 calls in 30 s.
8. **Claude CLI** — sends `POST $ANTHROPIC_BASE_URL/v1/messages` with `Authorization: Bearer
   <OneXO JWT>` + the custom headers (tunnel `:18000`) → Kong (`onexo-auth`, `ai:i`) →
   Connectra (policy, limits, metering into `ai_usage_event`, fallback chain unless
   `x-onexo-fallbacks: off`) → Bifrost → provider. Every 600 s, and after any 401, step 6 repeats.
9. **Teardown** — `finalizeConv()` calls the session's `close()`: the helper key stops working.

### 4.2 POC repo (`onexo-poc`)

| File | Change | Why |
|---|---|---|
| `server/gateway/types.ts` | **New.** `GatewayProvider` (`open(identity, vantage)`), `GatewayUpstream` (`credential`, `baseUrls`, `mint`, `models`, `headers`), `CredentialKind` (`bearer`/`claude-oauth`), `Vantage`, `WireProtocol` | The gateway plug's contract — knows nothing about the harness |
| `server/gateway/connectra.ts` | **New.** OneXO provider: `mint()` = the logged-in user's own OneXO token (`auth/logins.ts`), per-vantage `/llm` root, correlation header, optional `CONNECTRA_MODEL` + `X-Onexo-Fallbacks: off` | The actual Claude-CLI → OneXO-gateway integration |
| `server/gateway/anthropic.ts` | **New (phase 8).** Direct-Anthropic provider for Anthropic-account logins (`claude-oauth` credential) | The second `/login` option |
| `server/auth/onexo.ts` | **New (phase 8).** OneXO sign-in for an external app: providers, PKCE, `authorizeUrl`, `exchangeCode`, `refreshTokens(…, tenantId)`, `/auth/me`, `/auth/tenants` | "Login with OneXO" |
| `server/auth/anthropic.ts` | **New (phase 8)**, restored from the baseline `oauth.ts` + refresh | "Log in with Anthropic" |
| `server/auth/logins.ts` | **New (phase 8).** Per-user login store, status, serialized refresh with rotation persistence | Tokens stay valid without logging users out |
| `server/db.ts` | **Phase 8.** Migration 7: `logins (org, user, method, data_json)` + CRUD | Per-user login storage |
| `server/gateway/broker.ts` | **New.** Per-session helper keys, `/internal/gateway-token` handler, token-issue logging, token-storm guard, `GATEWAY_TEST_REJECT_FIRST_TOKEN` conformance hook | Fresh tokens for long turns; client secret never leaves the backend |
| `server/gateway/bifrost.ts` | Added in phase 5, **removed in phase 8** | Superseded by the real per-login gateway swap |
| `server/gateway/index.ts` | **New.** `gatewayForLogin(method)` | Login method → gateway |
| `server/harness/types.ts` | **New.** `HarnessAdapter` (`args`, `gatewayConfig`, `encodeUserMessage`, `decodeLine`, `setupFiles`, `transcriptPath`) | The harness plug's contract — knows nothing about OneXO |
| `server/harness/claude-cli.ts` | **New.** Claude Code adapter: stream-json flags; `bearer` → `ANTHROPIC_*` env + inline `--settings` `apiKeyHelper` (curl, node fallback); `claude-oauth` → `CLAUDE_CODE_OAUTH_TOKEN`; transcript path | Everything Claude-specific in one file |
| `server/harness/index.ts` | **New.** `selectHarness()` (`HARNESS=`) | Registry |
| `server/sandbox/cubesandbox.ts` | **Moved** from `vmclaude.ts`. Removed `.credentials.json` upload/sync and `ANTHROPIC_API_KEY`; launch now comes from a `launch()` callback (bin, args, env, files); transcript path from the harness; `readAgentOutput` → generic `readHomeFile` | VM holds no credentials; sandbox no longer hard-codes `claude` |
| `server/sandbox/local.ts` | **New.** `docker` and `local` sandboxes (`docker exec -e KEY` so tokens never land in argv); creates `PROJECTS_DIR` for `local` | Same harness/gateway on non-VM sandboxes |
| `server/index.ts` | Wires the plugs; VM and docker/local launches go through the broker + harness adapter with the **gateway chosen from the user's login**; `/internal/gateway-token`, `/auth/onexo/callback`, `/auth/onexo/tenant` routes; `/login` (options, Anthropic code, OneXO URL), `/logout`, `login_status`; "Run /login first" gate; storm guard ends the turn visibly | Single orchestration path |
| `server/oauth.ts` | Deleted in phase 2; its code returns as `server/auth/anthropic.ts` in phase 8 | — |
| `web/src/App.tsx`, `web/src/app.css` | Phase 2 removed the old login card; phase 8 adds the two-option `/login` card, Anthropic code step, OneXO sign-in step, header login chip, `/logout`; rebuilt `server/public/` | The login UX |
| `server/scripts/conformance.ts` | **New.** sandbox × login-method matrix (plain, tool, long-turn, rejected-token, unknown-model) + OneXO metering check; uses the saved `/login` and writes rotated tokens back | Repeatable proof |
| `server/.env.example` | **New** (was ignored by mistake). All gateway/plug variables | Config reference; real `server/.env` stays gitignored |
| `server/tsconfig.json`, `.gitignore` | Typecheck `scripts/`; ignore `logs/`, `.env`, `*.pem`, `*.db` | Hygiene |
| `docker-compose.yml` | Dropped `ANTHROPIC_API_KEY` | Container gets gateway env per launch |
| `README.md`, `SETUP.md`, `USE-CASES.md`, `architecture.html`, `docs/aws-cubesandbox.md`, `docs/persistent-sessions.md` | Model access, plugs, config table, tunnels, conformance | Docs match the code |
| `docs/egress-lockdown.md` | **New.** EC2 lockdown runbook | Network-level "no direct path" |
| `docs/sandbox-harness-gateway.md`, `docs/diagrams/*.html` | **New.** This write-up + two diagrams | — |

### 4.3 OneXO repo (`onexo_v1`)

| File | Change | Why |
|---|---|---|
| `scripts/seed-sandbox-harness-client.ts` | Added in `4afb77fc` (delegation client, `ai:i ai:dg`); **replaced in `e6e2fc62`** | Superseded by the user's own token |
| `scripts/seed-poc-login-client.ts` | **New** (`e6e2fc62`). Dev-only "Login with OneXO" client `onexo-poc-login-3b9d41`: authorization code + PKCE, `token_delivery: body`, exact redirect URI, scope `ai:i` | The POC's OneXO sign-in |
| `docs/scripts.md` | Entry for the seed script (now the login client) | Keep-in-sync rule |
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
| 1 | OneXO (dev DB) | Run `bun scripts/seed-poc-login-client.ts [redirect_uri]`; put the printed id/secret in the POC `server/.env` | The "Login with OneXO" client (PKCE, exact redirect, `ai:i`) |
| 2 | OneXO | Each user who picks OneXO needs a role with **`ai:i`** and membership in a tenant whose **AI policy allows the models** the gateway will serve; at least one sign-in provider (GitHub) enabled for the client | Otherwise login is refused ("No AI access") or every call is a 403 (now a visible error) |
| 3 | OneXO / Bifrost | At least one working provider + models in Bifrost (today: Bedrock `global.anthropic.claude-sonnet-5`), and a **fallback chain** that resolves Claude CLI's default model names | The POC sends no model; Connectra's routing must land on a servable one |
| 4 | EC2 | `GatewayPorts clientspecified` in `/etc/ssh/sshd_config` | Lets the reverse tunnels bind where VMs can reach them |
| 5 | Laptop | SSH with `-R 0.0.0.0:18000:localhost:8000 -R 0.0.0.0:18091:localhost:8091` (+ the existing `-L` ports) | VM → Kong `/llm` and VM → token broker |
| 6 | POC | `ONEXO_LLM_URL=http://<vm-gateway-ip>:18000/llm`, `POC_URL_FROM_VM=http://<vm-gateway-ip>:18091` | The addresses as seen from inside a VM |
| 7 | EC2 security group | Keep `18000`/`18091` **closed** to the internet | They're tunnel ports for VMs only |
| 8 | EC2 | Egress lockdown per `docs/egress-lockdown.md` (template without `--allow-internet-access`, or host iptables) | Makes "no direct path to Anthropic" a network fact, not just a missing key |
| 9 | OneXO | Restart Connectra and `@bot/agent` on the phase 7 code | They don't hot-reload; the header only works on the new code |
| 10 | Anthropic option | VMs must reach `api.anthropic.com` for users who log in with an Anthropic account — conflicts with the strict lockdown (see `docs/egress-lockdown.md`) | Direct calls can't go through the tunnel |

### 5b. To make it a real (shared/staging/production) capability

| # | Area | Requirement |
|---|---|---|
| 1 | **Networking** | Replace the laptop SSH tunnels with private networking: the CubeSandbox hosts reach OneXO Kong over the VPC (peering / Transit Gateway / PrivateLink), and the POC backend runs as a service next to them. Security groups: CubeSandbox → Kong `:443` `/llm/*` + `/public/auth/token` only |
| 2 | **POC sessions** | The OneXO identity now comes from `/login`, but the POC's own user is still a stub (`getIdentity()` → `poc-user` per browser). Give the POC real sessions (cookie per browser) so each person's login is theirs |
| 3 | **Login client** | Register a production "Login with OneXO" client (not the dev seed) with an **HTTPS** redirect URI on the POC's real hostname, scope `ai:i`; its secret in the secret manager; rotate like other clients |
| 4 | **Token TTL** | Keep the 900 s access TTL with the helper refresh (600 s), or set a client-specific TTL; refresh must stay below TTL |
| 5 | **Kong limits** | `llm-anthropic`/`llm-openai` allow 600 req/min and a 60-s SSE idle window; size the rate limit for N concurrent harnesses (key it per user, not per client) and raise the `/llm` read timeout if long silent tool runs get cut |
| 6 | **Models & policy** | Per-tenant AI policies that include the harness's models; per-user budgets/limits in Connectra for the harness population |
| 7 | **Egress** | Egress lockdown on every CubeSandbox host; if agents need npm/pip/git, an allowlist proxy on the host instead of open internet |
| 8 | **Anthropic-account option** | Decide whether shared deployments offer it at all: it bypasses OneXO metering/policy and needs `api.anthropic.com` egress from VMs; personal-subscription use is for individual testing, not other users |
| 9 | **Observability** | Dashboards/alerts on `ai_usage_event` by `client_id=onexo-poc-login-*`, POC broker token-storm log lines, POC `login ok`/`OneXO session expired` lines, and Bifrost per-call logs (correlation id joins them) |
| 10 | **Decision** | The 403 → 400 proposal for policy denials (`feature/connectra-policy-denial-status.md`), so every harness — not just this POC's storm guard — fails fast |

---

## 6. How to verify

- Local, no EC2: `SANDBOX=local HOME=/tmp/poc-home PROJECTS_DIR=/tmp/poc-projects bun run index.ts`
  in `server/`, type `/login` → OneXO → Continue with GitHub → pick a tenant, send a chat, then look
  up the logged `corr=poc-…` in OneXO's `ai_usage_event` (its `user_id` is the account you signed in with).
- Automated: `ONEXO_DATABASE_URL=… bun scripts/conformance.ts` (expect 9 PASS + 1 WARN before
  phase 7, 10 PASS after).
- VM path: tunnels up, then `bun scripts/conformance.ts --sandboxes cubesandbox --gateways connectra`.

## 7. Known gaps

- The **CubeSandbox VM path and the docker sandbox were not run** end to end after the
  refactor (no EC2 access from the dev machine); the laptop (`local`) path is fully verified.
- Connectra records `prompt_tokens=0` on some streamed, cached CLI calls (output tokens are
  recorded) — check before relying on input-token budgets.
- The full OneXO sign-in (GitHub step) and the Anthropic-account login were not run end to end by
  me — both need a real browser; everything up to OneXO's 302 to GitHub was verified.
- The POC's own user is still a stub (`poc-user`), so everyone using one POC server shares one
  login slot until the POC gets real sessions.
- An Anthropic-account session can't outlive its claude.ai access token (it's passed as an env
  var at launch); a new VM/launch picks up a refreshed one.
- Codex as a second harness was deferred (it needs an event translator to the UI's format and
  a VM template rebuild).
- Phase 7 needs Connectra and `@bot/agent` restarted on the new code before the
  `x-onexo-fallbacks` header takes effect locally.
