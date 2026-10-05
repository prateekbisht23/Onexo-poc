// The gateway for a user follows from how they logged in (`/login`): "onexo" → the OneXO AI
// gateway, "anthropic" → Anthropic directly. Adding a gateway = a provider file + a login method.
import type { LoginMethod } from "../db";
import { anthropicGateway } from "./anthropic";
import { connectraGateway } from "./connectra";
import type { GatewayProvider } from "./types";

const BY_LOGIN: Record<LoginMethod, GatewayProvider> = {
  onexo: connectraGateway,
  anthropic: anthropicGateway,
};

export function gatewayForLogin(method: LoginMethod): GatewayProvider {
  return BY_LOGIN[method];
}

export function describeGateways(): string {
  return Object.values(BY_LOGIN).map((g) => g.describe()).join(" | ");
}

export { GATEWAY_TOKEN_PATH, handleGatewayTokenRequest, openBrokeredSession, type BrokeredSession, type HarnessGatewayConn } from "./broker";
export type { CredentialKind, GatewayProvider, Vantage, WireProtocol } from "./types";
