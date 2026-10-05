// The gateway plug: WHERE model calls go and HOW a token for them is minted.
// A provider knows nothing about the harness (claude/codex/…) or the sandbox —
// the only contract is wire protocol + credential + correlation header.
import type { PocIdentity } from "../auth/logins";

/** Where the harness process runs — decides which address reaches the gateway/this server. */
export type Vantage = "vm" | "container" | "host";

export type WireProtocol = "anthropic" | "openai";

/** "bearer": a gateway token the harness fetches through the broker's helper (refreshed
 *  mid-turn). "claude-oauth": a claude.ai subscription token, handed to Claude Code itself. */
export type CredentialKind = "bearer" | "claude-oauth";

export type GatewayUpstream = {
  credential: CredentialKind;
  /** Base URLs per wire protocol, as reachable from the given vantage. */
  baseUrls: Partial<Record<WireProtocol, string>>;
  /** A fresh credential. "bearer": called on every helper refresh and after any 401. */
  mint: () => Promise<string>;
  /** Model ids to request. Unset = let the gateway route the harness's own default names. */
  models: { main?: string; small?: string };
  /** Extra request headers every call must carry (e.g. the correlation id). */
  headers: Record<string, string>;
  correlationId: string;
};

export interface GatewayProvider {
  name: string;
  protocols: WireProtocol[];
  describe(): string;
  /** Validate config/login and open an upstream for one harness process. Throws if unusable. */
  open(identity: PocIdentity, vantage: Vantage): Promise<GatewayUpstream>;
}
