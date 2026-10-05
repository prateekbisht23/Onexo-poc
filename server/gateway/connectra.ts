// OneXO AI gateway (Kong → Connectra → Bifrost). Tokens are client_credentials as
// the sandbox-harness client, delegated via act_user_id/act_tenant_id so spend is
// metered to the real OneXO user. Which model serves a call is the gateway's decision.
import type { GatewayProvider, Vantage } from "./types";

// Where THIS server mints tokens (Kong's public token route).
const ONEXO_AUTH_URL = (process.env.ONEXO_AUTH_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const CLIENT_ID = process.env.SANDBOX_HARNESS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.SANDBOX_HARNESS_CLIENT_SECRET ?? "";
// Optional: unset = Connectra's routing/fallback chain resolves the harness's default model
// names; set = pinned, so fallbacks are switched off for this harness (X-Onexo-Fallbacks).
const MODELS = { main: process.env.CONNECTRA_MODEL || undefined, small: process.env.CONNECTRA_SMALL_MODEL || undefined };

// The gateway root (…/llm) per vantage: VMs come through the reverse tunnel.
const LLM_ROOT: Record<Vantage, string> = {
  vm: process.env.ONEXO_LLM_URL ?? "",
  container: process.env.ONEXO_LLM_URL_CONTAINER ?? "http://host.docker.internal:8000/llm",
  host: process.env.ONEXO_LLM_URL_HOST ?? "http://127.0.0.1:8000/llm",
};

// POC identity → OneXO user + tenant public ids.
// ONEXO_IDENTITY_MAP='{"poc-user":{"userId":"…","tenantId":"…"}}', else the defaults.
type OnexoIdentity = { userId: string; tenantId: string };
const IDENTITY_MAP: Record<string, OnexoIdentity> = JSON.parse(process.env.ONEXO_IDENTITY_MAP ?? "{}");
const DEFAULT_IDENTITY: OnexoIdentity = {
  userId: process.env.ONEXO_ACT_USER_ID ?? "",
  tenantId: process.env.ONEXO_ACT_TENANT_ID ?? "",
};

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

export const connectraGateway: GatewayProvider = {
  name: "connectra",
  protocols: ["anthropic", "openai"],
  describe() {
    const missing = [
      !CLIENT_ID && "SANDBOX_HARNESS_CLIENT_ID",
      !CLIENT_SECRET && "SANDBOX_HARNESS_CLIENT_SECRET",
      !DEFAULT_IDENTITY.userId && !Object.keys(IDENTITY_MAP).length && "ONEXO_ACT_USER_ID",
      !LLM_ROOT.vm && "ONEXO_LLM_URL (vm only)",
    ].filter(Boolean);
    return `connectra auth=${ONEXO_AUTH_URL} llm(vm)=${LLM_ROOT.vm || "(unset)"} model=${MODELS.main ?? "(gateway decides)"}` + (missing.length ? `  MISSING: ${missing.join(", ")}` : "");
  },
  async open(pocUser, vantage) {
    const root = LLM_ROOT[vantage].replace(/\/$/, "");
    if (!root) throw new Error(`no OneXO gateway URL for vantage "${vantage}" (ONEXO_LLM_URL for VMs)`);
    await mintToken(pocUser); // fail the launch on bad config, not the first turn
    const correlationId = `poc-${crypto.randomUUID()}`;
    return {
      baseUrls: { anthropic: `${root}/anthropic`, openai: `${root}/v1` },
      models: MODELS,
      mint: () => mintToken(pocUser),
      headers: {
        "X-Onexo-Correlation-Id": correlationId,
        // a pinned model must run or fail visibly — never be swapped by the org fallback chain
        ...(MODELS.main ? { "X-Onexo-Fallbacks": "off" } : {}),
      },
      correlationId,
    };
  },
};
