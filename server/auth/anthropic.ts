// "/login → Anthropic account": Claude Code's own OAuth (Authorization Code + PKCE,
// copy/paste mode) so a POC user can run on their claude.ai subscription. Calls then go
// to Anthropic directly — no OneXO gateway, metering or policy. The client id and
// endpoints are Claude Code's (public, PKCE, no secret); isolated here so an upstream
// change is a one-file fix.
import { createHash, randomBytes } from "crypto";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPE = "org:create_api_key user:profile user:inference";

export type AnthropicLogin = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes: string[];
  subscriptionType?: string;
};

const b64url = (buf: Buffer | Uint8Array) => Buffer.from(buf).toString("base64url");

export function buildAuthorize(): { url: string; verifier: string } {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const params = new URLSearchParams({
    code: "true", // copy/paste mode: Anthropic shows a code instead of redirecting
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  return { url: `${AUTHORIZE_URL}?${params.toString()}`, verifier };
}

async function tokenRequest(body: Record<string, string>): Promise<AnthropicLogin> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, ...body }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Anthropic token request failed (${res.status}): ${text.slice(0, 200)}`);
  const t: any = JSON.parse(text);
  const accessToken = t.access_token ?? t.accessToken;
  const refreshToken = t.refresh_token ?? t.refreshToken ?? body.refresh_token;
  if (!accessToken || !refreshToken) throw new Error("Anthropic token response missing access/refresh token");
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + Number(t.expires_in ?? t.expiresIn ?? 3600) * 1000,
    scopes: (t.scope ?? SCOPE).split(" "),
    subscriptionType: t.subscription_type ?? t.subscriptionType,
  };
}

/** Exchange the pasted code (often "code#state") for tokens. */
export function exchange(pasted: string, verifier: string): Promise<AnthropicLogin> {
  const [code, state] = pasted.trim().split("#");
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    state: state ?? verifier,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
}

export function refresh(login: AnthropicLogin): Promise<AnthropicLogin> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: login.refreshToken });
}
