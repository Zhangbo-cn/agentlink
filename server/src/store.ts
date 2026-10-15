import crypto from "node:crypto";
import { Db } from "./db.ts";
import { within, type Config, type Quotas } from "./config.ts";
import { hashSecret, id, normalizeCode, now, period, periodEnd, randomName, secret, shortCode, NAME_RE } from "./util.ts";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export type Account = { id: string; name: string; email: string | null; disabled: number; quota_override: string | null; created_at: number };
export type Device = { id: string; account_id: string; name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null };
export type AgentRow = {
  id: string; account_id: string; device_id: string; name: string; persistent: number; cred_hash: string; profile: string;
  webhook_url: string | null; webhook_secret: string | null; webhook_failures: number; webhook_next_at: number;
  created_at: number; last_seen_at: number;
};
export type MessageRow = { id: string; seq: number; from_agent: string; to_agent: string; episode_id: string; body: string; deliver_as: string; attachments: string; reply_to: string | null; created_at: number; expires_at: number; delivered_at: number | null };
export type AttachmentRow = { id: string; file_code: string; account_id: string; device_id: string; name: string; size: number; sha256: string; message_id: string | null; created_at: number; expires_at: number };
export type AttachmentRef = { attachmentId: string; fileCode: string; fileName: string; byteSize: number; sha256: string };

/** What an agent tells others about itself: lets agents discover who can do what. */
export type Profile = { description?: string; capabilities?: string[]; framework?: string; project?: string; host?: string };

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const CAP_RE = /^[a-z0-9][a-z0-9._:/-]{0,39}$/;

export function cleanProfile(input: unknown): Profile {
  const p = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
  const caps = Array.isArray(p.capabilities)
    ? [...new Set(p.capabilities.filter((c): c is string => typeof c === "string").map((c) => c.trim().toLowerCase()).filter((c) => CAP_RE.test(c)))].slice(0, 30)
    : undefined;
  const out: Profile = {};
  const description = str(p.description, 500); if (description) out.description = description;
  if (caps?.length) out.capabilities = caps;
  const framework = str(p.framework, 40); if (framework) out.framework = framework;
  const project = str(p.project, 80); if (project) out.project = project;
  const host = str(p.host, 80); if (host) out.host = host;
  return out;
}

/** All persistent state and business rules. No networking here. */
export class Store {
  private seq: number;
  private readonly pepper: string;

  constructor(readonly db: Db, readonly cfg: Config) {
    this.seq = db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM messages")?.s ?? 0;
    let pepper = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'pepper'")?.value;
    if (!pepper) {
      pepper = crypto.randomBytes(32).toString("hex");
      db.run("INSERT INTO meta (key, value) VALUES ('pepper', ?)", pepper);
    }
    this.pepper = pepper;
  }

  quotas(account: Account): Quotas {
    if (!account.quota_override) return this.cfg.quotas;
    try { return { ...this.cfg.quotas, ...JSON.parse(account.quota_override) }; } catch { return this.cfg.quotas; }
  }

  audit(accountId: string | null, actor: string, action: string, detail?: unknown): void {
    this.db.run("INSERT INTO audit (at, account_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)", now(), accountId, actor, action, detail === undefined ? null : JSON.stringify(detail));
  }

  // ---------------------------------------------------------------- accounts

  createAccount(name: string, email?: string, actor = "admin"): Account {
    const n = name.trim();
    if (!n || n.length > 100) throw new ApiError("invalid_name", "Account name must be 1-100 characters");
    const e = email ? this.normalizeEmail(email) : null;
    if (e && this.db.get("SELECT 1 FROM accounts WHERE email = ?", e)) throw new ApiError("email_taken", "An account with this email already exists", 409);
    const acc: Account = { id: id("acc"), name: n, email: e, disabled: 0, quota_override: null, created_at: now() };
    this.db.run("INSERT INTO accounts (id, name, email, disabled, created_at) VALUES (?, ?, ?, 0, ?)", acc.id, acc.name, acc.email, acc.created_at);
    this.audit(acc.id, actor, "account.create", { name: n, email: e });
    return acc;
  }

  account(accountId: string): Account | undefined {
    return this.db.get<Account>("SELECT * FROM accounts WHERE id = ?", accountId);
  }

  listAccounts(): (Account & { devices: number })[] {
    return this.db.all("SELECT a.*, (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices FROM accounts a ORDER BY created_at");
  }

  updateAccount(accountId: string, patch: { disabled?: boolean; name?: string; quotas?: Partial<Quotas> | null }): Account {
    const acc = this.account(accountId);
    if (!acc) throw new ApiError("not_found", "Account not found", 404);
    const override = patch.quotas === undefined ? acc.quota_override : patch.quotas === null ? null : JSON.stringify(patch.quotas);
    this.db.run("UPDATE accounts SET disabled = COALESCE(?, disabled), name = COALESCE(?, name), quota_override = ? WHERE id = ?",
      patch.disabled === undefined ? null : patch.disabled ? 1 : 0, patch.name ?? null, override, accountId);
    this.audit(accountId, "admin", "account.update", patch);
    return this.account(accountId)!;
  }

  // ---------------------------------------------------------------- email sign-in

  normalizeEmail(email: string): string {
    const e = String(email).trim().toLowerCase();
    if (!EMAIL_RE.test(e) || e.length > 254) throw new ApiError("invalid_email", "Enter a valid email address");
    return e;
  }

  private codeHash(email: string, code: string): string {
    return crypto.createHmac("sha256", this.pepper).update(`${email}:${code}`).digest("hex");
  }

  /** Create a 6-digit code for the email. Returns null if the caller must wait (no new code issued). */
  startEmailLogin(rawEmail: string): { email: string; code: string; isNew: boolean } {
    const email = this.normalizeEmail(rawEmail);
    const existing = this.db.get<{ id: string }>("SELECT id FROM accounts WHERE email = ?", email);
    if (!existing) {
      if (this.cfg.signup === "invite") throw new ApiError("signup_closed", "This server only allows invited accounts. Ask the administrator to add your email.", 403);
      const domain = email.split("@")[1];
      if (this.cfg.emailDomains.length && !this.cfg.emailDomains.includes(domain)) throw new ApiError("domain_not_allowed", `Sign-up is limited to: ${this.cfg.emailDomains.join(", ")}`, 403);
    }
    const t = now();
    const row = this.db.get<{ sent_at: number; window_start: number; window_count: number }>("SELECT sent_at, window_start, window_count FROM email_codes WHERE email = ?", email);
    if (row && t - row.sent_at < 60_000) throw new ApiError("too_soon", "A code was sent less than a minute ago. Check your inbox (and spam folder).", 429, { retryAfterMs: 60_000 - (t - row.sent_at) });
    const inWindow = row && t - row.window_start < 3600_000;
    if (inWindow && row.window_count >= 5) throw new ApiError("too_many_codes", "Too many codes requested for this email. Try again later.", 429, { retryAfterMs: 3600_000 - (t - row.window_start) });
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    this.db.run(
      `INSERT INTO email_codes (email, code_hash, expires_at, attempts, sent_at, window_start, window_count) VALUES (?, ?, ?, 0, ?, ?, 1)
       ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at,
         window_start = CASE WHEN ? THEN window_start ELSE excluded.window_start END,
         window_count = CASE WHEN ? THEN window_count + 1 ELSE 1 END`,
      email, this.codeHash(email, code), t + 10 * 60_000, t, t, inWindow ? 1 : 0, inWindow ? 1 : 0);
    return { email, code, isNew: !existing };
  }

  /** Verify the code; sign in to (or create) the account and enroll a new device. */
  verifyEmailLogin(rawEmail: string, code: string, deviceName: string): { account: Account; device: Device; deviceToken: string; created: boolean } {
    const email = this.normalizeEmail(rawEmail);
    const clean = String(code).replace(/\D/g, "");
    return this.db.tx(() => {
      const row = this.db.get<{ code_hash: string; expires_at: number; attempts: number }>("SELECT code_hash, expires_at, attempts FROM email_codes WHERE email = ?", email);
      if (!row || row.expires_at < now() || row.attempts >= 5) throw new ApiError("invalid_code", "Code is invalid or expired. Request a new one.", 401);
      if (!crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(this.codeHash(email, clean)))) {
        this.db.run("UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?", email);
        // Commit the attempt counter even though we fail.
        throw new CommitThenThrow(new ApiError("invalid_code", `Wrong code (${4 - row.attempts} attempts left)`, 401));
      }
      this.db.run("UPDATE email_codes SET expires_at = 0 WHERE email = ?", email);
      let account = this.db.get<Account>("SELECT * FROM accounts WHERE email = ?", email);
      let created = false;
      if (!account) {
        if (this.cfg.signup === "invite") throw new ApiError("signup_closed", "This server only allows invited accounts.", 403);
        account = this.createAccount(email.split("@")[0], email, "email");
        created = true;
      }
      if (account.disabled) throw new ApiError("account_disabled", "Account is disabled", 403);
      const r = this.addDevice(account, deviceName, `email:${email}`);
      return { ...r, account, created };
    });
  }

  // ---------------------------------------------------------------- devices & enrollment codes

  private addDevice(account: Account, deviceName: string, actor: string): { device: Device; deviceToken: string } {
    if (!within(this.activeDeviceCount(account.id), this.quotas(account).maxDevices)) {
      throw new ApiError("device_limit", `This account already has the maximum of ${this.quotas(account).maxDevices} devices. Revoke one first.`, 403);
    }
    const name = deviceName.trim().slice(0, 64) || "device";
    const deviceToken = secret("aldt");
    const device: Device = { id: id("dev"), account_id: account.id, name, created_at: now(), last_seen_at: null, revoked_at: null };
    this.db.run("INSERT INTO devices (id, account_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", device.id, account.id, name, hashSecret(deviceToken), device.created_at);
    this.audit(account.id, actor, "device.add", { deviceId: device.id, name });
    return { device, deviceToken };
  }

  createEnrollment(accountId: string, createdBy: string, ttlSec = 15 * 60): { code: string; expiresAt: number } {
    const acc = this.account(accountId);
    if (!acc) throw new ApiError("not_found", "Account not found", 404);
    const code = shortCode();
    const expiresAt = now() + ttlSec * 1000;
    this.db.run("INSERT INTO enrollments (code_hash, account_id, created_by, expires_at) VALUES (?, ?, ?, ?)", hashSecret(code), accountId, createdBy, expiresAt);
    this.audit(accountId, createdBy, "enrollment.create");
    return { code, expiresAt };
  }

  enroll(code: string, deviceName: string): { account: Account; device: Device; deviceToken: string } {
    return this.db.tx(() => {
      const h = hashSecret(normalizeCode(code));
      const row = this.db.get<{ account_id: string; expires_at: number; used_at: number | null }>("SELECT account_id, expires_at, used_at FROM enrollments WHERE code_hash = ?", h);
      if (!row || row.used_at || row.expires_at < now()) throw new ApiError("invalid_code", "Enrollment code is invalid, used or expired", 401);
      const acc = this.account(row.account_id)!;
      if (acc.disabled) throw new ApiError("account_disabled", "Account is disabled", 403);
      this.db.run("UPDATE enrollments SET used_at = ? WHERE code_hash = ?", now(), h);
      return { account: acc, ...this.addDevice(acc, deviceName, "enrollment") };
    });
  }

  /** Unverified signup. Only for signup=open (LAN / development). */
  openSignup(accountName: string, deviceName: string): { account: Account; device: Device; deviceToken: string } {
    if (this.cfg.signup !== "open") throw new ApiError("signup_closed", "Unverified signup is disabled; sign in with your email instead", 403);
    return this.db.tx(() => {
      const account = this.createAccount(accountName, undefined, "signup");
      return { account, ...this.addDevice(account, deviceName, "signup") };
    });
  }

  authDevice(deviceId: string | undefined, token: string | undefined): { device: Device; account: Account } {
    if (!deviceId || !token) throw new ApiError("unauthorized", "Missing device credentials", 401);
    const device = this.db.get<Device & { token_hash: string }>("SELECT * FROM devices WHERE id = ?", deviceId);
    if (!device || device.token_hash !== hashSecret(token)) throw new ApiError("unauthorized", "Invalid device credentials", 401);
    if (device.revoked_at) throw new ApiError("revoked", "This device has been revoked", 401);
    const account = this.account(device.account_id)!;
    if (account.disabled) throw new ApiError("account_disabled", "Account is disabled", 403);
    if (!device.last_seen_at || now() - device.last_seen_at > 60_000) this.db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", now(), deviceId);
    const { token_hash: _omit, ...pub } = device;
    return { device: pub, account };
  }

  device(deviceId: string): Device | undefined {
    return this.db.get<Device>("SELECT id, account_id, name, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?", deviceId);
  }

  listDevices(accountId: string): Device[] {
    return this.db.all("SELECT id, account_id, name, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at", accountId);
  }

  revokeDevice(accountId: string, deviceId: string, actor: string): void {
    const r = this.db.run("UPDATE devices SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at IS NULL", now(), deviceId, accountId);
    if (!r.changes) throw new ApiError("not_found", "Device not found", 404);
    this.audit(accountId, actor, "device.revoke", { deviceId });
  }

  private activeDeviceCount(accountId: string): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND revoked_at IS NULL", accountId)!.n;
  }

  // ---------------------------------------------------------------- agents

  /**
   * Resolve the identity for a connecting agent.
   * - credential matches an existing agent -> resume it
   * - requested name owned by this device -> take it over (rotates credential) unless it is live elsewhere
   * - requested name free -> create a persistent agent
   * - no name -> ephemeral agent with a generated name
   */
  claimAgent(device: Device, opts: { name?: string; credential?: string; profile?: Profile; isLive: (agentId: string) => boolean }): { agent: AgentRow; credential: string } {
    const profile = JSON.stringify(opts.profile ?? {});
    return this.db.tx(() => {
      if (opts.credential) {
        const existing = this.db.get<AgentRow>("SELECT * FROM agents WHERE cred_hash = ? AND account_id = ?", hashSecret(opts.credential), device.account_id);
        if (existing && (!opts.name || opts.name.toLowerCase() === existing.name)) {
          this.db.run("UPDATE agents SET last_seen_at = ?, device_id = ?, profile = ? WHERE id = ?", now(), device.id, opts.profile ? profile : existing.profile, existing.id);
          return { agent: this.agent(existing.id)!, credential: opts.credential };
        }
      }
      const credential = secret("alpc");
      if (opts.name) {
        const name = opts.name.toLowerCase();
        if (!NAME_RE.test(name)) throw new ApiError("invalid_name", "Agent names are 3-32 chars: lowercase letters, digits, hyphens");
        const owner = this.db.get<AgentRow>("SELECT * FROM agents WHERE account_id = ? AND name = ?", device.account_id, name);
        if (owner) {
          if (owner.device_id !== device.id) throw new ApiError("name_taken", `Agent name "${name}" belongs to another device in this account`, 409);
          if (opts.isLive(owner.id)) throw new ApiError("name_in_use", `Agent "${name}" is already online on this device`, 409);
          this.db.run("UPDATE agents SET cred_hash = ?, persistent = 1, last_seen_at = ?, profile = ? WHERE id = ?", hashSecret(credential), now(), opts.profile ? profile : owner.profile, owner.id);
          return { agent: this.agent(owner.id)!, credential };
        }
        return { agent: this.insertAgent(device, name, true, credential, profile), credential };
      }
      for (let i = 0; i < 20; i++) {
        const name = i < 10 ? randomName() : `${randomName()}-${crypto.randomInt(100)}`;
        if (!this.db.get("SELECT 1 FROM agents WHERE account_id = ? AND name = ?", device.account_id, name)) {
          return { agent: this.insertAgent(device, name, false, credential, profile), credential };
        }
      }
      throw new ApiError("name_exhausted", "Could not allocate an agent name", 503);
    });
  }

  private insertAgent(device: Device, name: string, persistent: boolean, credential: string, profile: string): AgentRow {
    const t = now();
    this.db.run("INSERT INTO agents (id, account_id, device_id, name, persistent, cred_hash, profile, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id("ag"), device.account_id, device.id, name, persistent ? 1 : 0, hashSecret(credential), profile, t, t);
    return this.db.get<AgentRow>("SELECT * FROM agents WHERE account_id = ? AND name = ?", device.account_id, name)!;
  }

  /** Authenticate an HTTP agent: Authorization: Agent <agentId>:<credential>. */
  authAgent(agentId: string | undefined, credential: string | undefined): { agent: AgentRow; device: Device; account: Account } {
    if (!agentId || !credential) throw new ApiError("unauthorized", "Missing agent credentials", 401);
    const agent = this.agent(agentId);
    if (!agent || agent.cred_hash !== hashSecret(credential)) throw new ApiError("unauthorized", "Invalid agent credentials", 401);
    const device = this.device(agent.device_id);
    if (!device || device.revoked_at) throw new ApiError("revoked", "The device that owns this agent has been revoked", 401);
    const account = this.account(agent.account_id)!;
    if (account.disabled) throw new ApiError("account_disabled", "Account is disabled", 403);
    return { agent, device, account };
  }

  agent(agentId: string): AgentRow | undefined { return this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", agentId); }

  agentByName(accountId: string, name: string): AgentRow | undefined {
    return this.db.get<AgentRow>("SELECT * FROM agents WHERE account_id = ? AND name = ?", accountId, name.toLowerCase());
  }

  touchAgent(agentId: string): void { this.db.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", now(), agentId); }

  setProfile(agentId: string, profile: Profile): void {
    this.db.run("UPDATE agents SET profile = ? WHERE id = ?", JSON.stringify(profile), agentId);
  }

  /** Same account: by name or id. Other accounts: by id, only when paired. */
  resolveTarget(from: AgentRow, to: string): AgentRow | undefined {
    const t = to.trim();
    const sameName = this.agentByName(from.account_id, t);
    if (sameName) return sameName;
    const byId = this.agent(t);
    if (!byId) return undefined;
    if (byId.account_id === from.account_id || this.isPaired(from.id, byId.id)) return byId;
    return undefined;
  }

  knownAgents(from: AgentRow): { same: AgentRow[]; paired: (AgentRow & { account_name: string })[] } {
    const same = this.db.all<AgentRow>("SELECT * FROM agents WHERE account_id = ? AND id != ? ORDER BY name", from.account_id, from.id);
    const paired = this.db.all<AgentRow & { account_name: string }>(
      `SELECT ag.*, ac.name AS account_name FROM pairs p
       JOIN agents ag ON ag.id = CASE WHEN p.a = ? THEN p.b ELSE p.a END
       JOIN accounts ac ON ac.id = ag.account_id
       WHERE p.a = ? OR p.b = ? ORDER BY ag.name`, from.id, from.id, from.id);
    return { same, paired };
  }

  listAccountAgents(accountId: string): AgentRow[] {
    return this.db.all<AgentRow>("SELECT * FROM agents WHERE account_id = ? ORDER BY name", accountId);
  }

  gcAgents(isLive: (agentId: string) => boolean): number {
    const cutoff = now() - this.cfg.limits.ephemeralGraceSec * 1000;
    const stale = this.db.all<{ id: string }>("SELECT id FROM agents WHERE persistent = 0 AND last_seen_at < ?", cutoff).filter((a) => !isLive(a.id));
    for (const a of stale) {
      this.db.tx(() => {
        this.db.run("DELETE FROM messages WHERE to_agent = ? AND delivered_at IS NULL", a.id);
        this.db.run("DELETE FROM agents WHERE id = ?", a.id);
      });
    }
    return stale.length;
  }

  forgetAgent(accountId: string, name: string, actor: string): void {
    const r = this.db.run("DELETE FROM agents WHERE account_id = ? AND name = ?", accountId, name.toLowerCase());
    if (!r.changes) throw new ApiError("not_found", "Agent not found", 404);
    this.audit(accountId, actor, "agent.forget", { name });
  }

  // ---------------------------------------------------------------- webhooks

  setWebhook(agentId: string, url: string | null): string | null {
    const s = url ? secret("whsec") : null;
    this.db.run("UPDATE agents SET webhook_url = ?, webhook_secret = ?, webhook_failures = 0, webhook_next_at = 0 WHERE id = ?", url, s, agentId);
    return s;
  }

  webhookDue(): AgentRow[] {
    return this.db.all<AgentRow>(
      `SELECT a.* FROM agents a WHERE a.webhook_url IS NOT NULL AND a.webhook_next_at <= ?
       AND EXISTS (SELECT 1 FROM messages m WHERE m.to_agent = a.id AND m.delivered_at IS NULL AND m.expires_at > ?)`, now(), now());
  }

  webhookResult(agentId: string, ok: boolean): number {
    if (ok) { this.db.run("UPDATE agents SET webhook_failures = 0, webhook_next_at = 0 WHERE id = ?", agentId); return 0; }
    const a = this.agent(agentId);
    const f = (a?.webhook_failures ?? 0) + 1;
    const delay = Math.min(3600_000, 5_000 * 2 ** Math.min(f - 1, 10));
    this.db.run("UPDATE agents SET webhook_failures = ?, webhook_next_at = ? WHERE id = ?", f, now() + delay, agentId);
    return f;
  }

  // ---------------------------------------------------------------- pairing (cross-account)

  createPairInvite(agent: AgentRow, ttlSec = 10 * 60): { code: string; expiresAt: number } {
    const code = shortCode();
    const expiresAt = now() + ttlSec * 1000;
    this.db.run("DELETE FROM pair_invites WHERE agent_id = ?", agent.id);
    this.db.run("INSERT INTO pair_invites (code_hash, agent_id, expires_at) VALUES (?, ?, ?)", hashSecret(code), agent.id, expiresAt);
    this.audit(agent.account_id, agent.id, "pair.invite");
    return { code, expiresAt };
  }

  acceptPairInvite(agent: AgentRow, code: string): AgentRow {
    return this.db.tx(() => {
      const h = hashSecret(normalizeCode(code));
      const inv = this.db.get<{ agent_id: string; expires_at: number }>("SELECT agent_id, expires_at FROM pair_invites WHERE code_hash = ?", h);
      if (!inv || inv.expires_at < now()) throw new ApiError("invalid_code", "Pair code is invalid or expired", 404);
      if (inv.agent_id === agent.id) throw new ApiError("self_pair", "Cannot pair with yourself");
      const peer = this.agent(inv.agent_id)!;
      if (peer.account_id === agent.account_id) throw new ApiError("same_account", "Agents in the same account can already talk; pairing is for other accounts");
      this.db.run("DELETE FROM pair_invites WHERE code_hash = ?", h);
      const [a, b] = [agent.id, peer.id].sort();
      this.db.run("INSERT OR IGNORE INTO pairs (a, b, created_at) VALUES (?, ?, ?)", a, b, now());
      this.audit(agent.account_id, agent.id, "pair.accept", { peer: peer.id });
      this.audit(peer.account_id, peer.id, "pair.accept", { peer: agent.id });
      return peer;
    });
  }

  isPaired(x: string, y: string): boolean {
    const [a, b] = [x, y].sort();
    return !!this.db.get("SELECT 1 FROM pairs WHERE a = ? AND b = ?", a, b);
  }

  unpair(agent: AgentRow, peerId: string): boolean {
    const [a, b] = [agent.id, peerId].sort();
    const r = this.db.run("DELETE FROM pairs WHERE a = ? AND b = ?", a, b);
    if (r.changes) this.audit(agent.account_id, agent.id, "pair.remove", { peer: peerId });
    return r.changes > 0;
  }

  // ---------------------------------------------------------------- usage

  usage(account: Account): { limit: number; used: number; remaining: number | null; periodEndsAt: number } {
    const used = this.db.get<{ messages: number }>("SELECT messages FROM usage WHERE account_id = ? AND period = ?", account.id, period())?.messages ?? 0;
    const limit = this.quotas(account).monthlyMessages;
    return { limit, used, remaining: limit > 0 ? Math.max(0, limit - used) : null, periodEndsAt: periodEnd() };
  }

  // ---------------------------------------------------------------- messages

  enqueueMessage(from: AgentRow, to: AgentRow, input: { text: string; deliverAs: "steer" | "followUp"; idempotencyKey?: string; attachmentIds: string[]; replyTo?: string }): { message: MessageRow; created: boolean } {
    const L = this.cfg.limits;
    if (Buffer.byteLength(input.text) > L.maxTextBytes) throw new ApiError("too_large", `Message text exceeds ${L.maxTextBytes} bytes; send large content as an attachment`);
    if (!input.text.trim() && !input.attachmentIds.length) throw new ApiError("empty", "Message is empty");
    if (input.attachmentIds.length > L.maxAttachmentsPerMessage) throw new ApiError("too_many_attachments", `At most ${L.maxAttachmentsPerMessage} attachments`);
    if (input.idempotencyKey && input.idempotencyKey.length > 128) throw new ApiError("invalid_key", "idempotencyKey too long");

    return this.db.tx(() => {
      if (input.idempotencyKey) {
        const dup = this.db.get<MessageRow>("SELECT * FROM messages WHERE from_agent = ? AND idem_key = ?", from.id, input.idempotencyKey);
        if (dup) return { message: dup, created: false };
      }
      const account = this.account(from.account_id)!;
      const q = this.quotas(account);
      const p = period();
      const used = this.db.get<{ messages: number }>("SELECT messages FROM usage WHERE account_id = ? AND period = ?", account.id, p)?.messages ?? 0;
      if (!within(used, q.monthlyMessages)) throw new ApiError("quota_exceeded", `This server's monthly fair-use limit (${q.monthlyMessages} messages) has been reached`, 429, { periodEndsAt: periodEnd() });

      const refs: AttachmentRef[] = [];
      for (const aid of input.attachmentIds) {
        const att = this.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", aid);
        if (!att || att.account_id !== from.account_id || att.expires_at < now()) throw new ApiError("invalid_attachment", `Attachment ${aid} not found`);
        if (att.message_id) throw new ApiError("attachment_used", `Attachment ${aid} is already attached to a message`);
        refs.push({ attachmentId: att.id, fileCode: att.file_code, fileName: att.name, byteSize: att.size, sha256: att.sha256 });
      }
      const ttl = this.quotas(this.account(to.account_id)!).queueTtlSec;
      const msg: MessageRow = {
        id: id("msg"), seq: ++this.seq, from_agent: from.id, to_agent: to.id,
        episode_id: `ep_${crypto.createHash("sha256").update([from.id, to.id].sort().join("~")).digest("base64url").slice(0, 16)}`,
        body: input.text, deliver_as: input.deliverAs, attachments: JSON.stringify(refs),
        reply_to: input.replyTo && /^msg_[\w-]{1,40}$/.test(input.replyTo) ? input.replyTo : null,
        created_at: now(), expires_at: now() + ttl * 1000, delivered_at: null,
      };
      this.db.run(`INSERT INTO messages (id, seq, from_agent, to_agent, episode_id, body, deliver_as, attachments, reply_to, idem_key, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.id, msg.seq, msg.from_agent, msg.to_agent, msg.episode_id, msg.body, msg.deliver_as, msg.attachments, msg.reply_to, input.idempotencyKey ?? null, msg.created_at, msg.expires_at);
      for (const r of refs) this.db.run("UPDATE attachments SET message_id = ?, expires_at = MAX(expires_at, ?) WHERE id = ?", msg.id, msg.expires_at, r.attachmentId);
      this.db.run("INSERT INTO usage (account_id, period, messages) VALUES (?, ?, 1) ON CONFLICT(account_id, period) DO UPDATE SET messages = messages + 1", account.id, p);
      return { message: msg, created: true };
    });
  }

  message(id: string): MessageRow | undefined { return this.db.get<MessageRow>("SELECT * FROM messages WHERE id = ?", id); }

  pendingFor(agentId: string, limit = 200): MessageRow[] {
    return this.db.all<MessageRow>("SELECT * FROM messages WHERE to_agent = ? AND delivered_at IS NULL AND expires_at > ? ORDER BY seq LIMIT ?", agentId, now(), limit);
  }

  ack(agentId: string, messageIds: string[]): number {
    let n = 0;
    this.db.tx(() => {
      for (const mid of messageIds.slice(0, 500)) n += this.db.run("UPDATE messages SET delivered_at = ? WHERE id = ? AND to_agent = ? AND delivered_at IS NULL", now(), mid, agentId).changes;
    });
    return n;
  }

  // ---------------------------------------------------------------- attachments

  createAttachment(device: Device, name: string, size: number, sha256: string): AttachmentRow {
    const row: AttachmentRow = {
      id: id("att"), file_code: id("f", 12), account_id: device.account_id, device_id: device.id,
      name: name.replace(/[\\/\0]/g, "_").slice(0, 200) || "file", size, sha256, message_id: null,
      created_at: now(), expires_at: now() + 24 * 3600 * 1000,
    };
    this.db.run("INSERT INTO attachments (id, file_code, account_id, device_id, name, size, sha256, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, row.file_code, row.account_id, row.device_id, row.name, row.size, row.sha256, row.created_at, row.expires_at);
    return row;
  }

  attachmentForDownload(accountId: string, fileCode: string): AttachmentRow {
    const att = this.db.get<AttachmentRow>("SELECT * FROM attachments WHERE file_code = ?", fileCode);
    if (!att || att.expires_at < now()) throw new ApiError("not_found", "Attachment not found or expired", 404);
    if (att.account_id === accountId) return att;
    if (att.message_id && this.db.get("SELECT 1 FROM messages m JOIN agents t ON t.id = m.to_agent WHERE m.id = ? AND t.account_id = ?", att.message_id, accountId)) return att;
    throw new ApiError("not_found", "Attachment not found or expired", 404);
  }

  sweepExpired(): { messages: number; attachments: string[] } {
    const t = now();
    const atts = this.db.all<{ id: string }>("SELECT id FROM attachments WHERE expires_at < ?", t).map((r) => r.id);
    const m = this.db.run("DELETE FROM messages WHERE expires_at < ? OR (delivered_at IS NOT NULL AND delivered_at < ?)", t, t - 24 * 3600 * 1000).changes;
    this.db.run("DELETE FROM attachments WHERE expires_at < ?", t);
    this.db.run("DELETE FROM enrollments WHERE expires_at < ?", t - 24 * 3600 * 1000);
    this.db.run("DELETE FROM pair_invites WHERE expires_at < ?", t);
    this.db.run("DELETE FROM email_codes WHERE window_start < ?", t - 24 * 3600 * 1000);
    this.db.run("DELETE FROM audit WHERE at < ?", t - 90 * 24 * 3600 * 1000);
    return { messages: m, attachments: atts };
  }
}

/** Thrown inside a transaction when the writes so far must be kept (e.g. failed-attempt counters). */
export class CommitThenThrow extends Error {
  constructor(readonly error: Error) { super(error.message); }
}
