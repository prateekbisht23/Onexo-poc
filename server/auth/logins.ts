// Per-POC-user model-access login (`/login`): which method they chose and fresh tokens for
// it. Refreshes are serialized per user — OneXO rotates refresh tokens and revokes the whole
// family when a rotated-away one is reused, so two concurrent refreshes would log the user out.
import { deleteLogin, getLogin, saveLogin, type LoginMethod } from "../db";
import * as anthropic from "./anthropic";
import * as onexo from "./onexo";

export type PocIdentity = { org: string; user: string };
export type LoginStatus =
  | { method: null }
  | { method: "anthropic"; label: string }
  | { method: "onexo"; label: string; email: string; tenant: string };

// Refresh this long before expiry so a token handed to a harness is never about to lapse.
const REFRESH_MARGIN_MS = 120_000;
const locks = new Map<string, Promise<unknown>>();

function key(id: PocIdentity) {
  return `${id.org}\u0000${id.user}`;
}

function serialized<T>(id: PocIdentity, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key(id)) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key(id), next);
  return next.finally(() => {
    if (locks.get(key(id)) === next) locks.delete(key(id));
  });
}

export function loginMethod(id: PocIdentity): LoginMethod | null {
  return getLogin(id.org, id.user)?.method ?? null;
}

export function loginStatus(id: PocIdentity): LoginStatus {
  const row = getLogin(id.org, id.user);
  if (!row) return { method: null };
  if (row.method === "anthropic") {
    const d = JSON.parse(row.data_json) as anthropic.AnthropicLogin;
    return { method: "anthropic", label: `Anthropic${d.subscriptionType ? ` (${d.subscriptionType})` : ""}` };
  }
  const d = JSON.parse(row.data_json) as onexo.OnexoLogin;
  return { method: "onexo", label: `OneXO · ${d.email} · ${d.tenantName}`, email: d.email, tenant: d.tenantName };
}

export function saveAnthropicLogin(id: PocIdentity, login: anthropic.AnthropicLogin) {
  saveLogin(id.org, id.user, "anthropic", login);
}

export function saveOnexoLogin(id: PocIdentity, login: onexo.OnexoLogin) {
  saveLogin(id.org, id.user, "onexo", login);
}

export function logout(id: PocIdentity) {
  deleteLogin(id.org, id.user);
}

/** A fresh claude.ai OAuth access token for a user logged in with "Anthropic account". */
export function anthropicAccessToken(id: PocIdentity): Promise<string> {
  return serialized(id, async () => {
    const row = getLogin(id.org, id.user);
    if (row?.method !== "anthropic") throw new Error("not logged in with an Anthropic account — run /login");
    let d = JSON.parse(row.data_json) as anthropic.AnthropicLogin;
    if (d.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
      d = await anthropic.refresh(d);
      saveLogin(id.org, id.user, "anthropic", d);
    }
    return d.accessToken;
  });
}

/** A fresh OneXO access token (with tid) for a user logged in with "OneXO (AI gateway)". */
export function onexoAccessToken(id: PocIdentity): Promise<string> {
  return serialized(id, async () => {
    const row = getLogin(id.org, id.user);
    if (row?.method !== "onexo") throw new Error("not logged in with OneXO — run /login");
    const d = JSON.parse(row.data_json) as onexo.OnexoLogin;
    if (d.expiresAt - Date.now() >= REFRESH_MARGIN_MS) return d.accessToken;
    try {
      const t = await onexo.refreshTokens(d.refreshToken, d.tenantId);
      saveLogin(id.org, id.user, "onexo", { ...d, ...t });
      return t.accessToken;
    } catch (err) {
      // A dead refresh token (expired after 7 days, revoked, or reused) can't recover — make /login the obvious fix.
      throw new Error(`OneXO session expired — run /login again (${err instanceof Error ? err.message : err})`);
    }
  });
}
