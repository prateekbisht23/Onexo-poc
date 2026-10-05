// "/login → OneXO (AI gateway)": OneXO's authorization_code + PKCE flow for an external
// app (client onexo-poc-login-3b9d41, onexo_v1 scripts/seed-poc-login-client.ts). The
// user's own token — scope ai:i intersected with their role — is what the harness sends
// to Kong /llm/*. /llm requires a tenant (tid), chosen via refresh_token + tenant_id.
import { createHash, randomBytes } from "crypto";

// Kong as reached from this server and from the user's browser (same laptop in the POC).
const ONEXO_AUTH_URL = (process.env.ONEXO_AUTH_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const CLIENT_ID = process.env.POC_LOGIN_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.POC_LOGIN_CLIENT_SECRET ?? "";
const PORT = process.env.PORT ?? "8091";
export const ONEXO_REDIRECT_URI = process.env.POC_LOGIN_REDIRECT_URI ?? `http://localhost:${PORT}/auth/onexo/callback`;

export type OnexoLogin = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
};

export type OnexoTokens = { accessToken: string; refreshToken: string; expiresAt: number };

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");

function requireClient() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("POC_LOGIN_CLIENT_ID/SECRET are not set (onexo_v1: bun scripts/seed-poc-login-client.ts)");
  }
}

export function onexoConfigSummary(): string {
  return `auth=${ONEXO_AUTH_URL} client=${CLIENT_ID || "(unset)"} redirect=${ONEXO_REDIRECT_URI}`;
}

export async function listProviders(): Promise<string[]> {
  requireClient();
  const res = await fetch(`${ONEXO_AUTH_URL}/public/auth/providers?client_id=${encodeURIComponent(CLIENT_ID)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.providers)) throw new Error(`OneXO providers lookup failed (HTTP ${res.status})`);
  return body.providers;
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

/** The OneXO page the browser opens to sign in with a provider (GitHub, …). */
export function authorizeUrl(provider: string, state: string, challenge: string): string {
  requireClient();
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: ONEXO_REDIRECT_URI,
    state,
    scope: "ai:i",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `${ONEXO_AUTH_URL}/public/auth/${encodeURIComponent(provider)}?${params.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<OnexoTokens> {
  requireClient();
  const res = await fetch(`${ONEXO_AUTH_URL}/public/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
    signal: AbortSignal.timeout(15_000),
  });
  const t: any = await res.json().catch(() => null);
  if (!res.ok || typeof t?.access_token !== "string" || typeof t?.refresh_token !== "string") {
    throw new Error(`OneXO token request failed: ${t?.error_description ?? t?.error ?? `HTTP ${res.status}`}`);
  }
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + Number(t.expires_in ?? 900) * 1000 };
}

export function exchangeCode(code: string, verifier: string): Promise<OnexoTokens> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: ONEXO_REDIRECT_URI, code_verifier: verifier });
}

/** Rotating refresh: the returned refresh token replaces the presented one — persist it. */
export function refreshTokens(refreshToken: string, tenantId?: string): Promise<OnexoTokens> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken, ...(tenantId ? { tenant_id: tenantId } : {}) });
}

async function getJson(path: string, accessToken: string): Promise<any> {
  const res = await fetch(`${ONEXO_AUTH_URL}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`OneXO ${path} failed: ${body?.error?.message ?? `HTTP ${res.status}`}`);
  return body;
}

export async function me(accessToken: string): Promise<{ id: string; email: string; scopes: string[] }> {
  const b = await getJson("/auth/me", accessToken);
  return { id: b.id, email: b.email, scopes: b.scopes ?? [] };
}

export async function tenants(accessToken: string): Promise<Array<{ publicId: string; name: string }>> {
  return (await getJson("/auth/tenants", accessToken)).tenants ?? [];
}
