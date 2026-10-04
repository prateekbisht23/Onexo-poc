// Token broker: the one endpoint every harness's token helper calls. Each harness
// process gets a random key bound to one upstream's mint(); the provider's own
// credentials never leave this process. close() revokes the key.
import type { GatewayProvider, GatewayUpstream, Vantage, WireProtocol } from "./types";

export const GATEWAY_TOKEN_PATH = "/internal/gateway-token";

// Proactive refresh period for helpers; must stay below the provider's token TTL.
const REFRESH_MS = Number(process.env.GATEWAY_TOKEN_REFRESH_S ?? 600) * 1000;
const PORT = process.env.PORT ?? "8091";
// PROTOTYPE: conformance hook — the first token each session's helper receives is invalid,
// to exercise the harness's 401 → re-run helper → continue path (scripts/conformance.ts).
const REJECT_FIRST_TOKEN = process.env.GATEWAY_TEST_REJECT_FIRST_TOKEN === "1";
// Token storm: a harness re-runs its helper on every 401/403 — but a 403 for "model not
// allowed"/policy is not a token problem, so it would retry for minutes in silence. This many
// helper calls inside the window means the gateway is refusing for another reason.
const STORM_CALLS = 4;
const STORM_WINDOW_MS = 30_000;

// This server as seen by the harness's token helper, per vantage.
const POC_URL: Record<Vantage, string> = {
  vm: process.env.POC_URL_FROM_VM ?? "",
  container: `http://host.docker.internal:${PORT}`,
  host: `http://127.0.0.1:${PORT}`,
};

/** Everything a harness adapter needs to point itself at the gateway. Protocol-level only. */
export type HarnessGatewayConn = {
  baseUrls: Partial<Record<WireProtocol, string>>;
  models: { main?: string; small?: string };
  headers: Record<string, string>;
  tokenUrl: string;
  helperKey: string;
  refreshMs: number;
};

export type BrokeredSession = { conn: HarnessGatewayConn; correlationId: string; close: () => void };

type LiveSession = {
  upstream: GatewayUpstream;
  provider: string;
  issued: number;
  recent: number[]; // helper-call timestamps inside the storm window
  stormed: boolean;
  onStorm?: (reason: string) => void;
};
const live = new Map<string, LiveSession>();

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export async function openBrokeredSession(
  provider: GatewayProvider,
  protocol: WireProtocol,
  pocUser: string,
  vantage: Vantage,
  onStorm?: (reason: string) => void,
): Promise<BrokeredSession> {
  if (!provider.protocols.includes(protocol)) {
    throw new Error(`gateway "${provider.name}" does not serve the ${protocol} protocol this harness speaks`);
  }
  const pocUrl = POC_URL[vantage].replace(/\/$/, "");
  if (!pocUrl) throw new Error("POC_URL_FROM_VM is not set — the harness can't refresh its gateway token");
  const upstream = await provider.open(pocUser, vantage);
  const helperKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  live.set(helperKey, { upstream, provider: provider.name, issued: 0, recent: [], stormed: false, onStorm });
  log(`gateway session open gateway=${provider.name} corr=${upstream.correlationId} user=${pocUser} vantage=${vantage}`);
  return {
    conn: {
      baseUrls: upstream.baseUrls,
      models: upstream.models,
      headers: upstream.headers,
      tokenUrl: `${pocUrl}${GATEWAY_TOKEN_PATH}`,
      helperKey,
      refreshMs: REFRESH_MS,
    },
    correlationId: upstream.correlationId,
    close: () => {
      if (live.delete(helperKey)) log(`gateway session closed corr=${upstream.correlationId}`);
    },
  };
}

/** GET /internal/gateway-token — plain-text bearer on 200, for the session's helper key only. */
export async function handleGatewayTokenRequest(req: Request): Promise<Response> {
  const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const session = key ? live.get(key) : undefined;
  if (!session) return new Response("unknown or closed session", { status: 401 });
  const n = ++session.issued;
  const corr = session.upstream.correlationId;
  const now = Date.now();
  session.recent = [...session.recent.filter((t) => now - t < STORM_WINDOW_MS), now];
  if (session.stormed || session.recent.length >= STORM_CALLS) {
    if (!session.stormed) {
      session.stormed = true;
      const reason =
        `the ${session.provider} gateway rejected ${session.recent.length} fresh tokens within ${STORM_WINDOW_MS / 1000}s — ` +
        `it is refusing the request itself (e.g. 403 model not allowed / AI policy), not the token`;
      log(`gateway token storm corr=${corr}: ${reason}`);
      session.onStorm?.(reason);
    }
    return new Response("gateway token storm — refusing further tokens for this session", { status: 429 });
  }
  if (REJECT_FIRST_TOKEN && n === 1) {
    log(`gateway token issued corr=${corr} n=${n} (test: deliberately invalid)`);
    return new Response("invalid.conformance.token", { headers: { "content-type": "text/plain" } });
  }
  try {
    const token = await session.upstream.mint();
    log(`gateway token issued corr=${corr} n=${n}`);
    return new Response(token, { headers: { "content-type": "text/plain" } });
  } catch (err) {
    log(`gateway token mint failed corr=${corr} n=${n}: ${err}`);
    return new Response(String(err instanceof Error ? err.message : err), { status: 502 });
  }
}
