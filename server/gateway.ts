// OneXO AI gateway (Kong → Connectra) as the ONLY model path for the harness.
// The POC never holds a provider key. Each claude session gets a random helper
// key; claude's apiKeyHelper trades it at THIS server's /internal/gateway-token
// for a short-lived OneXO token (client_credentials, delegated via act_user_id),
// re-calling it on a timer and on any 401 — so turns longer than the token TTL
// keep going without a restart. The client secret never leaves this process.
// Which model serves a call is the gateway's decision; GATEWAY_MODEL overrides.

// Where THIS server mints tokens (Kong's public token route).
const ONEXO_AUTH_URL = (process.env.ONEXO_AUTH_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
// As seen from inside the VM (reverse tunnels): the gateway root (…/llm) and this server.
const ONEXO_LLM_URL = (process.env.ONEXO_LLM_URL ?? "").replace(/\/$/, "");
const POC_URL_FROM_VM = (process.env.POC_URL_FROM_VM ?? "").replace(/\/$/, "");
const CLIENT_ID = process.env.SANDBOX_HARNESS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SANDBOX_HARNESS_CLIENT_SECRET ?? "";
const GATEWAY_MODEL = process.env.GATEWAY_MODEL ?? "";
const GATEWAY_SMALL_MODEL = process.env.GATEWAY_SMALL_MODEL ?? "";
// Proactive refresh period; must stay below the token TTL (OneXO default 900s).
const HELPER_TTL_MS = Number(process.env.GATEWAY_TOKEN_REFRESH_S ?? 600) * 1000;

export const GATEWAY_TOKEN_PATH = "/internal/gateway-token";

// POC identity (org/user strings) → OneXO user + tenant public ids.
// ONEXO_IDENTITY_MAP='{"poc-user":{"userId":"…","tenantId":"…"}}', else the defaults.
type OnexoIdentity = { userId: string; tenantId: string };
const IDENTITY_MAP: Record<string, OnexoIdentity> = JSON.parse(process.env.ONEXO_IDENTITY_MAP ?? "{}");
const DEFAULT_IDENTITY: OnexoIdentity = {
  userId: process.env.ONEXO_ACT_USER_ID ?? "",
  tenantId: process.env.ONEXO_ACT_TENANT_ID ?? "",
};

// The helper runs inside the VM/container: curl where present (docker image), node otherwise (VM template).
const HELPER_CMD =
  `curl -sf -H "authorization: Bearer $ONEXO_HELPER_KEY" "$ONEXO_TOKEN_URL" || ` +
  `node -e 'fetch(process.env.ONEXO_TOKEN_URL,{headers:{authorization:"Bearer "+process.env.ONEXO_HELPER_KEY}})` +
  `.then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())},()=>process.exit(1))'`;

export type GatewaySession = {
  key: string; // the helper's bearer — scoped to one POC user, valid until close()
  pocUser: string;
  llmBaseUrl: string;
  tokenUrl: string;
  correlationId: string;
  close: () => void;
};

const sessions = new Map<string, GatewaySession>();

export function gatewayConfigSummary(): string {
  const missing = [
    !ONEXO_LLM_URL && "ONEXO_LLM_URL",
    !POC_URL_FROM_VM && "POC_URL_FROM_VM",
    !CLIENT_ID && "SANDBOX_HARNESS_CLIENT_ID",
    !CLIENT_SECRET && "SANDBOX_HARNESS_CLIENT_SECRET",
    !DEFAULT_IDENTITY.userId && !Object.keys(IDENTITY_MAP).length && "ONEXO_ACT_USER_ID",
  ].filter(Boolean);
  return `auth=${ONEXO_AUTH_URL} llm=${ONEXO_LLM_URL || "(unset)"} model=${GATEWAY_MODEL || "(gateway decides)"} refresh=${HELPER_TTL_MS / 1000}s` +
    (missing.length ? `  MISSING (VM backend): ${missing.join(", ")}` : "");
}

function resolveIdentity(pocUser: string): OnexoIdentity {
  const id = IDENTITY_MAP[pocUser] ?? DEFAULT_IDENTITY;
  if (!id.userId || !id.tenantId) {
    throw new Error(`no OneXO user/tenant mapped for POC user "${pocUser}" (set ONEXO_ACT_USER_ID/ONEXO_ACT_TENANT_ID or ONEXO_IDENTITY_MAP)`);
  }
  return id;
}

async function mintToken(pocUser: string): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) throw new Error("SANDBOX_HARNESS_CLIENT_ID/SECRET are not set");
  const { userId, tenantId } = resolveIdentity(pocUser);
  const res = await fetch(`${ONEXO_AUTH_URL}/public/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      act_user_id: userId,
      act_tenant_id: tenantId,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || typeof body?.access_token !== "string") {
    throw new Error(`gateway token mint failed: ${body?.error_description ?? body?.error ?? `HTTP ${res.status}`}`);
  }
  return body.access_token;
}

/**
 * Open a gateway session for one harness process. Mints once up front so bad
 * config fails the launch instead of the first turn. Callers must close() it
 * when the harness goes away — that revokes the helper key.
 */
export async function openGatewaySession(
  pocUser: string,
  where: { llmBaseUrl?: string; pocUrl?: string } = {},
): Promise<GatewaySession> {
  const llmBaseUrl = where.llmBaseUrl ?? ONEXO_LLM_URL;
  const pocUrl = where.pocUrl ?? POC_URL_FROM_VM;
  if (!llmBaseUrl) throw new Error("ONEXO_LLM_URL is not set — the harness has no gateway to call");
  if (!pocUrl) throw new Error("POC_URL_FROM_VM is not set — the harness can't refresh its gateway token");
  await mintToken(pocUser);
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const session: GatewaySession = {
    key,
    pocUser,
    llmBaseUrl,
    tokenUrl: `${pocUrl}${GATEWAY_TOKEN_PATH}`,
    correlationId: `poc-${crypto.randomUUID()}`,
    close: () => void sessions.delete(key),
  };
  sessions.set(key, session);
  return session;
}

/** GET /internal/gateway-token — the apiKeyHelper's endpoint. Plain-text token on 200. */
export async function handleGatewayTokenRequest(req: Request): Promise<Response> {
  const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const session = key ? sessions.get(key) : undefined;
  if (!session) return new Response("unknown or closed session", { status: 401 });
  try {
    return new Response(await mintToken(session.pocUser), { headers: { "content-type": "text/plain" } });
  } catch (err) {
    return new Response(String(err instanceof Error ? err.message : err), { status: 502 });
  }
}

/** Claude CLI env for a gateway session. No token here — the apiKeyHelper supplies it. */
export function claudeGatewayEnv(s: GatewaySession): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${s.llmBaseUrl}/anthropic`,
    ANTHROPIC_CUSTOM_HEADERS: `X-Onexo-Correlation-Id: ${s.correlationId}`,
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: String(HELPER_TTL_MS),
    // the gateway is the only egress: no telemetry/update/feedback calls to anthropic.com
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ONEXO_TOKEN_URL: s.tokenUrl,
    ONEXO_HELPER_KEY: s.key,
  };
  if (GATEWAY_MODEL) env.ANTHROPIC_MODEL = GATEWAY_MODEL;
  if (GATEWAY_SMALL_MODEL) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = GATEWAY_SMALL_MODEL;
  return env;
}

/** Extra claude args: the apiKeyHelper, inline via --settings (never written to a settings file). */
export function claudeGatewayArgs(): string[] {
  return ["--settings", JSON.stringify({ apiKeyHelper: HELPER_CMD })];
}
