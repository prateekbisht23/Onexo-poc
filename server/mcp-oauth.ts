// Generic MCP OAuth (the "/mcp → authenticate" experience): discover a hosted
// MCP server's OAuth (RFC 9728 protected-resource → RFC 8414 auth-server
// metadata), dynamically register a client (RFC 7591), run Authorization Code +
// PKCE, and exchange for a bearer token to attach to that server's requests.
import { createHash, randomBytes } from "crypto";

const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
export const newVerifier = () => b64url(randomBytes(32));
const challengeOf = (verifier: string) => b64url(createHash("sha256").update(verifier).digest());

export type McpAuthMeta = {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  scopesSupported?: string[];
};

async function jget(url: string): Promise<any> {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}

// Walk 401 → protected-resource metadata → authorization-server metadata.
export async function discover(serverUrl: string): Promise<McpAuthMeta> {
  let resourceMetaUrl: string | undefined;
  try {
    const r = await fetch(serverUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "onexo", version: "0" } } }),
      signal: AbortSignal.timeout(12_000),
    });
    const wa = r.headers.get("www-authenticate") ?? "";
    resourceMetaUrl = wa.match(/resource_metadata="([^"]+)"/)?.[1];
  } catch {}
  if (!resourceMetaUrl) resourceMetaUrl = new URL(serverUrl).origin + "/.well-known/oauth-protected-resource";

  const prm = await jget(resourceMetaUrl);
  const resource: string = prm.resource ?? serverUrl;
  const asBase = String(prm.authorization_servers?.[0] ?? new URL(serverUrl).origin).replace(/\/$/, "");

  let asm: any;
  for (const w of [asBase + "/.well-known/oauth-authorization-server", asBase + "/.well-known/openid-configuration"]) {
    try { asm = await jget(w); break; } catch {}
  }
  if (!asm?.authorization_endpoint || !asm?.token_endpoint) throw new Error("authorization server metadata not found");
  return {
    resource,
    authorizationEndpoint: asm.authorization_endpoint,
    tokenEndpoint: asm.token_endpoint,
    registrationEndpoint: asm.registration_endpoint,
    scopesSupported: asm.scopes_supported,
  };
}

export async function register(registrationEndpoint: string, redirectUri: string): Promise<{ clientId: string; clientSecret?: string }> {
  const r = await fetch(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Onexo Chat",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!r.ok) throw new Error(`dynamic client registration failed (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return { clientId: j.client_id, clientSecret: j.client_secret };
}

export function authorizeUrl(meta: McpAuthMeta, clientId: string, redirectUri: string, verifier: string, state: string, scope?: string): string {
  const p = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
    state,
    resource: meta.resource,
  });
  const s = scope ?? meta.scopesSupported?.join(" ");
  if (s) p.set("scope", s);
  return `${meta.authorizationEndpoint}?${p.toString()}`;
}

type Tokens = { accessToken: string; refreshToken?: string; expiresAt: number };

async function tokenRequest(meta: McpAuthMeta, clientId: string, clientSecret: string | undefined, form: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: clientId, resource: meta.resource, ...form });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (clientSecret) headers.authorization = "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const r = await fetch(meta.tokenEndpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`token endpoint (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
}

export const exchangeCode = (meta: McpAuthMeta, clientId: string, clientSecret: string | undefined, code: string, verifier: string, redirectUri: string) =>
  tokenRequest(meta, clientId, clientSecret, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });

export const refresh = (meta: McpAuthMeta, clientId: string, clientSecret: string | undefined, refreshToken: string) =>
  tokenRequest(meta, clientId, clientSecret, { grant_type: "refresh_token", refresh_token: refreshToken });
