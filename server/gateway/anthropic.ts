// Anthropic directly, for users logged in with "Anthropic account": their own claude.ai
// subscription token goes to Claude Code as CLAUDE_CODE_OAUTH_TOKEN. No OneXO identity,
// metering, limits or policy apply. Only harnesses that accept a claude-oauth credential
// (claude-cli) can use it.
import { anthropicAccessToken } from "../auth/logins";
import type { GatewayProvider } from "./types";

export const anthropicGateway: GatewayProvider = {
  name: "anthropic",
  protocols: ["anthropic"],
  describe: () => "anthropic (direct, user's claude.ai login)",
  async open(identity) {
    await anthropicAccessToken(identity); // refreshes if near expiry; throws without a login
    return {
      credential: "claude-oauth",
      baseUrls: { anthropic: "https://api.anthropic.com" },
      models: {},
      mint: () => anthropicAccessToken(identity),
      headers: {},
      correlationId: `poc-${crypto.randomUUID()}`,
    };
  },
};
