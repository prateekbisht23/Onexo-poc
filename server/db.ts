import { Database } from "bun:sqlite";
import { join } from "path";

// POC store: conversations are just pointers (session_id + title). The actual
// message history lives in claude's own transcript files under
// ~/.claude/projects/<project>/<session-id>.jsonl and is rebuilt from there.
const db = new Database(process.env.DB_PATH ?? join(import.meta.dir, "chats.db"));

const MIGRATIONS: string[] = [
  // 001 — conversations table
  `CREATE TABLE conversations (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL UNIQUE,
     title      TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  // 002 — persistent-storage identity: the S3 volume that holds this
  // conversation's files, plus tenant scoping. volume_id is server-minted at
  // conversation creation (before claude's session_id exists), so it's stable
  // across resumes. org/user come from the identity seam (stubbed in the PoC).
  `ALTER TABLE conversations ADD COLUMN volume_id TEXT`,
  `ALTER TABLE conversations ADD COLUMN org TEXT`,
  `ALTER TABLE conversations ADD COLUMN user TEXT`,
  // 005 — per-user MCP servers, materialized into --mcp-config at session start.
  // config_json holds the server body: {command,args,env} for stdio, or
  // {url,headers} for http/sse. Secrets live here (encrypt for production).
  `CREATE TABLE mcp_servers (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     org         TEXT NOT NULL,
     user        TEXT NOT NULL,
     name        TEXT NOT NULL,
     transport   TEXT NOT NULL,
     config_json TEXT NOT NULL,
     enabled     INTEGER NOT NULL DEFAULT 1,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(org, user, name)
   )`,
  // 006 — OAuth-connected MCP servers store their token + refresh metadata here
  // (clientId, tokenEndpoint, resource, accessToken, refreshToken, expiresAt).
  // Kept out of config_json so it's easy to strip before sending to the browser.
  `ALTER TABLE mcp_servers ADD COLUMN oauth_json TEXT`,
  // 007 — how each POC user logs in for model access (`/login`): 'anthropic' = their own
  // claude.ai account (direct), 'onexo' = OneXO login (AI gateway). data_json holds that
  // method's tokens (refresh tokens rotate — always overwrite with the newest).
  `CREATE TABLE logins (
     org        TEXT NOT NULL,
     user       TEXT NOT NULL,
     method     TEXT NOT NULL CHECK (method IN ('anthropic', 'onexo')),
     data_json  TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (org, user)
   )`,
];

export function migrate() {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const row = db.query(`SELECT MAX(version) AS v FROM schema_migrations`).get() as { v: number | null };
  const current = row?.v ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.run(MIGRATIONS[v]);
    db.run(`INSERT INTO schema_migrations (version) VALUES (?)`, [v + 1]);
    console.log(`[db] applied migration ${v + 1}`);
  }
}

export type Conversation = {
  id: number;
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  volume_id: string | null;
  org: string | null;
  user: string | null;
};

export function listConversations(org?: string, user?: string): Conversation[] {
  // Tenant-scoped when identity is provided (production); full list otherwise (PoC stub).
  if (org && user) {
    return db
      .query(`SELECT * FROM conversations WHERE org = ? AND user = ? ORDER BY updated_at DESC LIMIT 100`)
      .all(org, user) as Conversation[];
  }
  return db
    .query(`SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100`)
    .all() as Conversation[];
}

export function getConversation(sessionId: string): Conversation | null {
  return (db.query(`SELECT * FROM conversations WHERE session_id = ?`).get(sessionId) as Conversation) ?? null;
}

export function touchConversation(
  sessionId: string,
  title: string,
  meta?: { volumeId?: string; org?: string; user?: string },
) {
  db.run(
    // keep the first title; fill volume/org/user once they're known (COALESCE keeps existing)
    `INSERT INTO conversations (session_id, title, volume_id, org, user) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       updated_at = datetime('now'),
       volume_id  = COALESCE(conversations.volume_id, excluded.volume_id),
       org        = COALESCE(conversations.org, excluded.org),
       user       = COALESCE(conversations.user, excluded.user)`,
    [sessionId, title, meta?.volumeId ?? null, meta?.org ?? null, meta?.user ?? null],
  );
}

export function deleteConversation(sessionId: string) {
  db.run(`DELETE FROM conversations WHERE session_id = ?`, [sessionId]);
}

// ---- MCP servers (per user) ----
export type McpServer = {
  id: number;
  org: string;
  user: string;
  name: string;
  transport: string; // stdio | http | sse
  config_json: string;
  enabled: number;
  created_at: string;
  oauth_json: string | null;
};

export function listMcpServers(org: string, user: string): McpServer[] {
  return db
    .query(`SELECT * FROM mcp_servers WHERE org = ? AND user = ? ORDER BY name`)
    .all(org, user) as McpServer[];
}

export function addMcpServer(org: string, user: string, name: string, transport: string, config: unknown) {
  db.run(
    `INSERT INTO mcp_servers (org, user, name, transport, config_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org, user, name) DO UPDATE SET transport = excluded.transport, config_json = excluded.config_json, enabled = 1`,
    [org, user, name, transport, JSON.stringify(config)],
  );
}

// Insert/replace an OAuth-connected MCP server (transport http) with its token blob.
export function upsertOAuthServer(org: string, user: string, name: string, url: string, oauth: unknown) {
  db.run(
    `INSERT INTO mcp_servers (org, user, name, transport, config_json, oauth_json, enabled) VALUES (?, ?, ?, 'http', ?, ?, 1)
     ON CONFLICT(org, user, name) DO UPDATE SET transport='http', config_json=excluded.config_json, oauth_json=excluded.oauth_json, enabled=1`,
    [org, user, name, JSON.stringify({ url }), JSON.stringify(oauth)],
  );
}

export function updateMcpOAuth(id: number, oauth: unknown) {
  db.run(`UPDATE mcp_servers SET oauth_json = ? WHERE id = ?`, [JSON.stringify(oauth), id]);
}

export function setMcpEnabled(org: string, user: string, id: number, enabled: boolean) {
  db.run(`UPDATE mcp_servers SET enabled = ? WHERE id = ? AND org = ? AND user = ?`, [enabled ? 1 : 0, id, org, user]);
}

export function deleteMcpServer(org: string, user: string, id: number) {
  db.run(`DELETE FROM mcp_servers WHERE id = ? AND org = ? AND user = ?`, [id, org, user]);
}


// Resuming can mint a new session id; keep the row instead of duplicating it.
export function renameSession(oldId: string, newId: string) {
  db.run(
    `UPDATE conversations SET session_id = ?, updated_at = datetime('now') WHERE session_id = ?`,
    [newId, oldId],
  );
}

// ---- model-access logins (per POC user) ----
export type LoginMethod = "anthropic" | "onexo";
export type LoginRow = { org: string; user: string; method: LoginMethod; data_json: string; updated_at: string };

export function getLogin(org: string, user: string): LoginRow | null {
  return (db.query(`SELECT * FROM logins WHERE org = ? AND user = ?`).get(org, user) as LoginRow) ?? null;
}

export function saveLogin(org: string, user: string, method: LoginMethod, data: unknown) {
  db.run(
    `INSERT INTO logins (org, user, method, data_json) VALUES (?, ?, ?, ?)
     ON CONFLICT(org, user) DO UPDATE SET method = excluded.method, data_json = excluded.data_json, updated_at = datetime('now')`,
    [org, user, method, JSON.stringify(data)],
  );
}

export function deleteLogin(org: string, user: string) {
  db.run(`DELETE FROM logins WHERE org = ? AND user = ?`, [org, user]);
}
