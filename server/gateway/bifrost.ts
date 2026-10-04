// Bifrost directly (no Kong, no Connectra): the gateway-swap proof. One static
// virtual key — no per-user identity, metering or policy, and no fallback chain,
// so explicit model ids are required (BIFROST_MODEL). PROTOTYPE: dev/local only.
import type { GatewayProvider, Vantage } from "./types";

const VK = process.env.BIFROST_VK ?? "";
const MODELS = { main: process.env.BIFROST_MODEL || undefined, small: process.env.BIFROST_SMALL_MODEL || undefined };
const ROOT: Record<Vantage, string> = {
  vm: process.env.BIFROST_URL_VM ?? "",
  container: process.env.BIFROST_URL_CONTAINER ?? "http://host.docker.internal:8080",
  host: process.env.BIFROST_URL_HOST ?? "http://127.0.0.1:8080",
};

export const bifrostGateway: GatewayProvider = {
  name: "bifrost",
  protocols: ["anthropic", "openai"],
  describe() {
    const missing = [!VK && "BIFROST_VK", !MODELS.main && "BIFROST_MODEL", !ROOT.vm && "BIFROST_URL_VM (vm only)"].filter(Boolean);
    return `bifrost host=${ROOT.host} model=${MODELS.main ?? "(unset)"}` + (missing.length ? `  MISSING: ${missing.join(", ")}` : "");
  },
  async open(_pocUser, vantage) {
    const root = ROOT[vantage].replace(/\/$/, "");
    if (!root) throw new Error(`no Bifrost URL for vantage "${vantage}" (BIFROST_URL_VM for VMs)`);
    if (!VK) throw new Error("BIFROST_VK is not set");
    if (!MODELS.main) throw new Error("BIFROST_MODEL is not set — Bifrost has no fallback chain to resolve default model names");
    const correlationId = `poc-${crypto.randomUUID()}`;
    return {
      baseUrls: { anthropic: `${root}/anthropic`, openai: `${root}/v1` },
      models: MODELS,
      mint: async () => VK,
      headers: { "x-correlation-id": correlationId }, // Bifrost rejects calls without it
      correlationId,
    };
  },
};
