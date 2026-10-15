import { DatabaseSync, type StatementSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// Append-only migrations. Each runs once, in order, inside a transaction.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE,
    disabled INTEGER NOT NULL DEFAULT 0,
    quota_override TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE email_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    window_count INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );
  CREATE INDEX devices_account ON devices(account_id);
  CREATE TABLE enrollments (
    code_hash TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    name TEXT NOT NULL,
    persistent INTEGER NOT NULL,
    cred_hash TEXT NOT NULL,
    profile TEXT NOT NULL DEFAULT '{}',
    webhook_url TEXT,
    webhook_secret TEXT,
    webhook_failures INTEGER NOT NULL DEFAULT 0,
    webhook_next_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(account_id, name)
  );
  CREATE TABLE pairs (
    a TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    b TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (a, b)
  );
  CREATE INDEX pairs_b ON pairs(b);
  CREATE TABLE pair_invites (
    code_hash TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    body TEXT NOT NULL,
    deliver_as TEXT NOT NULL,
    attachments TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT,
    idem_key TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE UNIQUE INDEX messages_idem ON messages(from_agent, idem_key) WHERE idem_key IS NOT NULL;
  CREATE INDEX messages_pending ON messages(to_agent, delivered_at, seq);
  CREATE INDEX messages_expiry ON messages(expires_at);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    file_code TEXT NOT NULL UNIQUE,
    account_id TEXT NOT NULL,
    device_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_expiry ON attachments(expires_at);
  CREATE TABLE usage (
    account_id TEXT NOT NULL,
    period TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, period)
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    account_id TEXT,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT
  );
  CREATE INDEX audit_account ON audit(account_id, at);
  `,
  // v2: an administrator can pre-approve an email address for self-service sign-up, so a server
  // can stay invite-only while invited people still register themselves with a mailed code.
  `
  CREATE TABLE email_invites (
    email TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    note TEXT
  );
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const row = this.raw.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
    let version = row?.version ?? 0;
    if (!row) this.raw.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
    while (version < MIGRATIONS.length) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[version]);
        this.raw.prepare("UPDATE schema_version SET version = ?").run(version + 1);
      });
      version++;
    }
  }

  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) { s = this.raw.prepare(sql); this.cache.set(sql, s); }
    return s;
  }

  get<T>(sql: string, ...params: any[]): T | undefined { return this.stmt(sql).get(...params) as T | undefined; }
  all<T>(sql: string, ...params: any[]): T[] { return this.stmt(sql).all(...params) as T[]; }
  run(sql: string, ...params: any[]): { changes: number } {
    return { changes: Number(this.stmt(sql).run(...params).changes) };
  }

  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (error) {
      if (error && (error as any).constructor?.name === "CommitThenThrow") {
        this.raw.exec("COMMIT");
        throw (error as any).error;
      }
      this.raw.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }

  close(): void { this.raw.close(); }
}
