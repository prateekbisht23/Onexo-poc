// GATEWAY=<name> picks the provider. Adding one = a new file + an entry here.
import { bifrostGateway } from "./bifrost";
import { connectraGateway } from "./connectra";
import type { GatewayProvider } from "./types";

const PROVIDERS: Record<string, GatewayProvider> = {
  [connectraGateway.name]: connectraGateway,
  [bifrostGateway.name]: bifrostGateway,
};

export function selectGateway(name = process.env.GATEWAY ?? "connectra"): GatewayProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`unknown GATEWAY "${name}" (known: ${Object.keys(PROVIDERS).join(", ")})`);
  return p;
}

export { GATEWAY_TOKEN_PATH, handleGatewayTokenRequest, openBrokeredSession, type BrokeredSession, type HarnessGatewayConn } from "./broker";
export type { GatewayProvider, Vantage, WireProtocol } from "./types";
