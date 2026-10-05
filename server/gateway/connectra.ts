// OneXO AI gateway (Kong → Connectra → Bifrost) for users logged in with "OneXO (AI gateway)".
// The bearer is the user's OWN OneXO token (scope ai:i ∩ their role, tenant chosen at login),
// so Connectra meters, limits and policies each call as that user. Which model serves a call
// is the gateway's decision.
import { onexoAccessToken } from "../auth/logins";
import type { GatewayProvider, Vantage } from "./types";

// Optional: unset = Connectra's routing/fallback chain resolves the harness's default model
// names; set = pinned, so fallbacks are switched off for this harness (X-Onexo-Fallbacks).
const MODELS = { main: process.env.CONNECTRA_MODEL || undefined, small: process.env.CONNECTRA_SMALL_MODEL || undefined };

// The gateway root (…/llm) per vantage: VMs come through the reverse tunnel.
const LLM_ROOT: Record<Vantage, string> = {
  vm: process.env.ONEXO_LLM_URL ?? "",
  container: process.env.ONEXO_LLM_URL_CONTAINER ?? "http://host.docker.internal:8000/llm",
  host: process.env.ONEXO_LLM_URL_HOST ?? "http://127.0.0.1:8000/llm",
};

export const connectraGateway: GatewayProvider = {
  name: "connectra",
  protocols: ["anthropic", "openai"],
  describe() {
    return `connectra llm(vm)=${LLM_ROOT.vm || "(unset — needed for VMs)"} model=${MODELS.main ?? "(gateway decides)"}`;
  },
  async open(identity, vantage) {
    const root = LLM_ROOT[vantage].replace(/\/$/, "");
    if (!root) throw new Error(`no OneXO gateway URL for vantage "${vantage}" (ONEXO_LLM_URL for VMs)`);
    await onexoAccessToken(identity); // fail the launch on a dead login, not the first turn
    const correlationId = `poc-${crypto.randomUUID()}`;
    return {
      credential: "bearer",
      baseUrls: { anthropic: `${root}/anthropic`, openai: `${root}/v1` },
      models: MODELS,
      mint: () => onexoAccessToken(identity),
      headers: {
        "X-Onexo-Correlation-Id": correlationId,
        // a pinned model must run or fail visibly — never be swapped by the org fallback chain
        ...(MODELS.main ? { "X-Onexo-Fallbacks": "off" } : {}),
      },
      correlationId,
    };
  },
};
