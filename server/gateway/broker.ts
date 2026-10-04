// Token broker: the one endpoint every harness's token helper calls. Each harness
// process gets a random key bound to one upstream's mint(); the provider's own
// credentials never leave this process. close() revokes the key.
import type { GatewayProvider, GatewayUpstream, Vantage, WireProtocol } from "./types";

export const GATEWAY_TOKEN_PATH = "/internal/gateway-token";

// Proactive refresh period for helpers; must stay below the provider's token TTL.
const REFRESH_MS = Number(process.env.GATEWAY_TOKEN_REFRESH_S ?? 600) * 1000;
const PORT = process.env.PORT ?? "8091";

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

const live = new Map<string, GatewayUpstream>();

export async function openBrokeredSession(
  provider: GatewayProvider,
  protocol: WireProtocol,
  pocUser: string,
  vantage: Vantage,
): Promise<BrokeredSession> {
  if (!provider.protocols.includes(protocol)) {
    throw new Error(`gateway "${provider.name}" does not serve the ${protocol} protocol this harness speaks`);
  }
  const pocUrl = POC_URL[vantage].replace(/\/$/, "");
  if (!pocUrl) throw new Error("POC_URL_FROM_VM is not set — the harness can't refresh its gateway token");
  const upstream = await provider.open(pocUser, vantage);
  const helperKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  live.set(helperKey, upstream);
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
    close: () => void live.delete(helperKey),
  };
}

/** GET /internal/gateway-token — plain-text bearer on 200, for the session's helper key only. */
export async function handleGatewayTokenRequest(req: Request): Promise<Response> {
  const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const upstream = key ? live.get(key) : undefined;
  if (!upstream) return new Response("unknown or closed session", { status: 401 });
  try {
    return new Response(await upstream.mint(), { headers: { "content-type": "text/plain" } });
  } catch (err) {
    return new Response(String(err instanceof Error ? err.message : err), { status: 502 });
  }
}
