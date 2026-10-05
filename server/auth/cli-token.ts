// GET /internal/cli-token — lets a terminal `claude` on this machine use the POC user's
// OneXO login (`/login` → OneXO) through its apiKeyHelper (scripts/onexo-token.sh). The POC
// server stays the ONLY process that refreshes the login: OneXO revokes the whole login if a
// rotated-away refresh token is reused, so a second refresher would log the user out.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { timingSafeEqual } from "crypto";
import { loginMethod, onexoAccessToken, type PocIdentity } from "./logins";

export const CLI_TOKEN_PATH = "/internal/cli-token";
// Next to the server (not $HOME, which the POC is often run with pointed at a scratch dir).
export const CLI_SECRET_FILE = process.env.POC_CLI_SECRET_FILE ?? join(import.meta.dir, "..", ".cli-secret");

function loadOrCreateSecret(): string {
  if (existsSync(CLI_SECRET_FILE)) return readFileSync(CLI_SECRET_FILE, "utf8").trim();
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  writeFileSync(CLI_SECRET_FILE, secret + "\n", { mode: 0o600 });
  chmodSync(CLI_SECRET_FILE, 0o600);
  return secret;
}

const SECRET = loadOrCreateSecret();

function sameSecret(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Plain-text OneXO access token on 200; a one-line reason (for the helper's stderr) otherwise. */
export async function handleCliTokenRequest(req: Request, remoteAddress: string | undefined, identity: PocIdentity): Promise<Response> {
  if (!remoteAddress || !LOOPBACK.has(remoteAddress)) return new Response("cli-token is local-only", { status: 403 });
  const presented = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!presented || !sameSecret(presented)) return new Response("bad or missing cli secret (server/.cli-secret)", { status: 401 });
  if (loginMethod(identity) !== "onexo") {
    return new Response(`POC user "${identity.user}" is not logged in with OneXO — type /login in the POC chat and choose OneXO`, { status: 409 });
  }
  try {
    const token = await onexoAccessToken(identity);
    console.log(`[${new Date().toISOString()}] cli token issued user=${identity.user}`);
    return new Response(token, { headers: { "content-type": "text/plain" } });
  } catch (err) {
    return new Response(err instanceof Error ? err.message : String(err), { status: 502 });
  }
}
