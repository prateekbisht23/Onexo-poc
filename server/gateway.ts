// OneXO AI gateway (Kong → Connectra) as the ONLY model path for the harness.
// The POC never holds a provider key: per session it mints a short-lived OneXO
// token (client_credentials, delegated to the OneXO user via act_user_id) and
// hands the harness the gateway URL + token. Which model actually serves a call
// is the gateway's decision; GATEWAY_MODEL / GATEWAY_SMALL_MODEL only override.

// Where THIS server mints tokens (Kong's public token route).
const ONEXO_AUTH_URL = (process.env.ONEXO_AUTH_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
// The gateway root (…/llm) as seen by the harness — from inside a VM this is the tunnel.
const ONEXO_LLM_URL = (process.env.ONEXO_LLM_URL ?? "").replace(/\/$/, "");
const CLIENT_ID = process.env.SANDBOX_HARNESS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SANDBOX_HARNESS_CLIENT_SECRET ?? "";
const GATEWAY_MODEL = process.env.GATEWAY_MODEL ?? "";
const GATEWAY_SMALL_MODEL = process.env.GATEWAY_SMALL_MODEL ?? "";

// POC identity (org/user strings) → OneXO user + tenant public ids.
// ONEXO_IDENTITY_MAP='{"poc-user":{"userId":"…","tenantId":"…"}}', else the defaults.
type OnexoIdentity = { userId: string; tenantId: string };
const IDENTITY_MAP: Record<string, OnexoIdentity> = JSON.parse(process.env.ONEXO_IDENTITY_MAP ?? "{}");
const DEFAULT_IDENTITY: OnexoIdentity = {
  userId: process.env.ONEXO_ACT_USER_ID ?? "",
  tenantId: process.env.ONEXO_ACT_TENANT_ID ?? "",
};

export type GatewaySession = {
  llmBaseUrl: string; // gateway root, e.g. http://10.0.0.1:18000/llm
  token: string;
  expiresAt: number; // epoch ms
  correlationId: string;
};

export function gatewayConfigSummary(): string {
  const missing = [
    !ONEXO_LLM_URL && "ONEXO_LLM_URL",
    !CLIENT_ID && "SANDBOX_HARNESS_CLIENT_ID",
    !CLIENT_SECRET && "SANDBOX_HARNESS_CLIENT_SECRET",
    !DEFAULT_IDENTITY.userId && !Object.keys(IDENTITY_MAP).length && "ONEXO_ACT_USER_ID",
  ].filter(Boolean);
  return `auth=${ONEXO_AUTH_URL} llm=${ONEXO_LLM_URL || "(unset)"} model=${GATEWAY_MODEL || "(gateway decides)"}` +
    (missing.length ? `  MISSING: ${missing.join(", ")}` : "");
}

function resolveIdentity(pocUser: string): OnexoIdentity {
  const id = IDENTITY_MAP[pocUser] ?? DEFAULT_IDENTITY;
  if (!id.userId || !id.tenantId) {
    throw new Error(`no OneXO user/tenant mapped for POC user "${pocUser}" (set ONEXO_ACT_USER_ID/ONEXO_ACT_TENANT_ID or ONEXO_IDENTITY_MAP)`);
  }
  return id;
}

/** Mint a fresh gateway session. Call per harness launch — never cache across launches. */
export async function gatewaySession(pocUser: string, llmBaseUrl = ONEXO_LLM_URL): Promise<GatewaySession> {
  if (!llmBaseUrl) throw new Error("ONEXO_LLM_URL is not set — the harness has no gateway to call");
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
  return {
    llmBaseUrl,
    token: body.access_token,
    expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
    correlationId: `poc-${crypto.randomUUID()}`,
  };
}

/** Claude CLI's env for a gateway session (Anthropic Messages on {root}/anthropic). */
export function claudeGatewayEnv(s: GatewaySession): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `${s.llmBaseUrl}/anthropic`,
    ANTHROPIC_AUTH_TOKEN: s.token,
    ANTHROPIC_CUSTOM_HEADERS: `X-Onexo-Correlation-Id: ${s.correlationId}`,
    // the gateway is the only egress: no telemetry/update/feedback calls to anthropic.com
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  if (GATEWAY_MODEL) env.ANTHROPIC_MODEL = GATEWAY_MODEL;
  if (GATEWAY_SMALL_MODEL) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = GATEWAY_SMALL_MODEL;
  return env;
}
