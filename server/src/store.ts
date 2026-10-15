import { Db } from "./db.ts";
import type { Config, Plan } from "./config.ts";
import { hashSecret, id, normalizeCode, now, period, periodEnd, randomName, secret, shortCode, NAME_RE } from "./util.ts";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) { super(message); }
}

export type Account = { id: string; name: string; plan: string; disabled: number; created_at: number };
export type Device = { id: string; account_id: string; name: string; created_at: number; last_seen_at: number | null; revoked_at: number | null };
export type AgentRow = { id: string; account_id: string; device_id: string; name: string; persistent: number; cred_hash: string; created_at: number; last_seen_at: number };
export type MessageRow = { id: string; seq: number; from_agent: string; to_agent: string; episode_id: string; body: string; deliver_as: string; attachments: string; created_at: number; expires_at: number; delivered_at: number | null };
export type AttachmentRow = { id: string; file_code: string; account_id: string; device_id: string; name: string; size: number; sha256: string; message_id: string | null; created_at: number; expires_at: number };

export type AttachmentRef = { attachmentId: string; fileCode: string; fileName: string; byteSize: number; sha256: string };

/** All persistent state and business rules. No networking here. */
export class Store {
  private seq: number;

  constructor(readonly db: Db, readonly cfg: Config) {
    const row = db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM messages");
    this.seq = row?.s ?? 0;
  }

  plan(account: Account): Plan {
    return this.cfg.plans[account.plan] ?? this.cfg.plans.free;
  }

  audit(accountId: string | null, actor: string, action: string, detail?: unknown): void {
    this.db.run("INSERT INTO audit (at, account_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)", now(), accountId, actor, action, detail === undefined ? null : JSON.stringify(detail));
  }

  // ---------- accounts ----------
  createAccount(name: string, plan = "free"): Account {
    if (!name.trim() || name.length > 100) throw new ApiError("invalid_name", "Account name must be 1-100 characters");
    if (!this.cfg.plans[plan]) throw new ApiError("invalid_plan", `Unknown plan ${plan}`);
    const acc: Account = { id: id("acc"), name: name.trim(), plan, disabled: 0, created_at: now() };
    this.db.run("INSERT INTO accounts (id, name, plan, disabled, created_at) VALUES (?, ?, ?, 0, ?)", acc.id, acc.name, acc.plan, acc.created_at);
    this.audit(acc.id, "admin", "account.create", { name, plan });
    return acc;
  }

  account(accountId: string): Account | undefined {
    return this.db.get<Account>("SELECT * FROM accounts WHERE id = ?", accountId);
  }

  listAccounts(): (Account & { devices: number })[] {
    return this.db.all("SELECT a.*, (SELECT COUNT(*) FROM devices d WHERE d.account_id = a.id AND d.revoked_at IS NULL) AS devices FROM accounts a ORDER BY created_at");
  }

  updateAccount(accountId: string, patch: { plan?: string; disabled?: boolean; name?: string }): Account {
    const acc = this.account(accountId);
    if (!acc) throw new ApiError("not_found", "Account not found", 404);
    if (patch.plan !== undefined && !this.cfg.plans[patch.plan]) throw new ApiError("invalid_plan", `Unknown plan ${patch.plan}`);
    this.db.run("UPDATE accounts SET plan = COALESCE(?, plan), disabled = COALESCE(?, disabled), name = COALESCE(?, name) WHERE id = ?",
      patch.plan ?? null, patch.disabled === undefined ? null : patch.disabled ? 1 : 0, patch.name ?? null, accountId);
    this.audit(accountId, "admin", "account.update", patch);
    return this.account(accountId)!;
  }

  // ---------- devices & enrollment ----------
  createEnrollment(accountId: string, createdBy: string, ttlSec = 15 * 60): { code: string; expiresAt: number } {
    const acc = this.account(accountId);
    if (!acc) throw new ApiError("not_found", "Account not found", 404);
    if (this.activeDeviceCount(accountId) >= this.plan(acc).maxDevices) throw new ApiError("device_limit", `Plan ${acc.plan} allows ${this.plan(acc).maxDevices} devices`, 403);
    const code = shortCode();
    const expiresAt = now() + ttlSec * 1000;
    this.db.run("INSERT INTO enrollments (code_hash, account_id, created_by, expires_at) VALUES (?, ?, ?, ?)", hashSecret(code), accountId, createdBy, expiresAt);
    this.audit(accountId, createdBy, "enrollment.create");
    return { code, expiresAt };
  }

  enroll(code: string, deviceName: string): { account: Account; device: Device; deviceToken: string } {
    const name = deviceName.trim().slice(0, 64) || "device";
    return this.db.tx(() => {
      const row = this.db.get<{ account_id: string; expires_at: number; used_at: number | null }>("SELECT account_id, expires_at, used_at FROM enrollments WHERE code_hash = ?", hashSecret(normalizeCode(code)));
      if (!row || row.used_at || row.expires_at < now()) throw new ApiError("invalid_code", "Enrollment code is invalid, used or expired", 401);
      const acc = this.account(row.account_id)!;
      if (acc.disabled) throw new ApiError("account_disabled", "Account is disabled", 403);
      if (this.activeDeviceCount(acc.id) >= this.plan(acc).maxDevices) throw new ApiError("device_limit", `Plan ${acc.plan} allows ${this.plan(acc).maxDevices} devices`, 403);
      this.db.run("UPDATE enrollments SET used_at = ? WHERE code_hash = ?", now(), hashSecret(normalizeCode(code)));
      const deviceToken = secret("aldt");
      const device: Device = { id: id("dev"), account_id: acc.id, name, created_at: now(), last_seen_at: null, revoked_at: null };
      this.db.run("INSERT INTO devices (id, account_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", device.id, acc.id, name, hashSecret(deviceToken), device.created_at);
      this.audit(acc.id, device.id, "device.enroll", { name });
      return { account: acc, device, deviceToken };
    });
  }

  signup(accountName: string, deviceName: string): { account: Account; device: Device; deviceToken: string } {
    return this.db.tx(() => {
      const acc = this.createAccount(accountName);
      const { code } = this.createEnrollment(acc.id, "signup");
      return this.enroll(code, deviceName);
    });
  }

  authDevice(deviceId: string | undefined, token: string | undefined): { device: Device; account: Account } {
    if (!deviceId || !token) throw new ApiError("unauthorized", "Missing device credentials", 401);
    const device = this.db.get<Device & { token_hash: string }>("SELECT * FROM devices WHERE id = ?", deviceId);
    if (!device || device.token_hash !== hashSecret(token)) throw new ApiError("unauthorized", "Invalid device credentials", 401);
    if (device.revoked_at) throw new ApiError("revoked", "This device has been revoked", 401);
    const account = this.account(device.account_id)!;
    if (account.disabled) throw new ApiError("account_disabled", "Account is disabled", 403);
    this.db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", now(), deviceId);
    const { token_hash: _omit, ...pub } = device;
    return { device: pub, account };
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

  // ---------- agents ----------
  /**
   * Resolve the identity for a connecting agent.
   * - credential matches an existing agent  -> resume it (same id and name)
   * - requested persistent name owned by this device -> take it over, rotate credential
   * - requested name free -> create
   * - no name -> ephemeral agent with a generated name
   */
  claimAgent(device: Device, opts: { name?: string; credential?: string; isOnline: (agentId: string) => boolean }): { agent: AgentRow; credential: string } {
    return this.db.tx(() => {
      if (opts.credential) {
        const existing = this.db.get<AgentRow>("SELECT * FROM agents WHERE cred_hash = ? AND account_id = ?", hashSecret(opts.credential), device.account_id);
        if (existing && (!opts.name || opts.name === existing.name)) {
          this.db.run("UPDATE agents SET last_seen_at = ?, device_id = ? WHERE id = ?", now(), device.id, existing.id);
          return { agent: { ...existing, device_id: device.id }, credential: opts.credential };
        }
      }
      const credential = secret("alpc");
      if (opts.name) {
        const name = opts.name.toLowerCase();
        if (!NAME_RE.test(name)) throw new ApiError("invalid_name", "Agent names are 3-32 chars: lowercase letters, digits, hyphens");
        const owner = this.db.get<AgentRow>("SELECT * FROM agents WHERE account_id = ? AND name = ?", device.account_id, name);
        if (owner) {
          if (owner.device_id !== device.id) throw new ApiError("name_taken", `Agent name "${name}" belongs to another device`, 409);
          if (opts.isOnline(owner.id)) throw new ApiError("name_in_use", `Agent "${name}" is already online on this device`, 409);
          this.db.run("UPDATE agents SET cred_hash = ?, persistent = 1, last_seen_at = ? WHERE id = ?", hashSecret(credential), now(), owner.id);
          return { agent: { ...owner, persistent: 1 }, credential };
        }
        return { agent: this.insertAgent(device, name, true, credential), credential };
      }
      for (let i = 0; i < 20; i++) {
        const name = i < 10 ? randomName() : `${randomName()}-${Math.floor(Math.random() * 100)}`;
        if (!this.db.get("SELECT 1 FROM agents WHERE account_id = ? AND name = ?", device.account_id, name)) {
          return { agent: this.insertAgent(device, name, false, credential), credential };
        }
      }
      throw new ApiError("name_exhausted", "Could not allocate an agent name", 503);
    });
  }

  private insertAgent(device: Device, name: string, persistent: boolean, credential: string): AgentRow {
    const row: AgentRow = { id: id("ag"), account_id: device.account_id, device_id: device.id, name, persistent: persistent ? 1 : 0, cred_hash: hashSecret(credential), created_at: now(), last_seen_at: now() };
    this.db.run("INSERT INTO agents (id, account_id, device_id, name, persistent, cred_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      row.id, row.account_id, row.device_id, row.name, row.persistent, row.cred_hash, row.created_at, row.last_seen_at);
    return row;
  }

  agent(agentId: string): AgentRow | undefined { return this.db.get<AgentRow>("SELECT * FROM agents WHERE id = ?", agentId); }

  touchAgent(agentId: string): void { this.db.run("UPDATE agents SET last_seen_at = ? WHERE id = ?", now(), agentId); }

  /** Agents the caller may address: same account, plus explicitly paired agents. */
  resolveTarget(from: AgentRow, to: string): AgentRow | undefined {
    const t = to.trim();
    const sameName = this.db.get<AgentRow>("SELECT * FROM agents WHERE account_id = ? AND name = ?", from.account_id, t.toLowerCase());
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

  /** Remove ephemeral agents that have been offline past the grace period (and their queued mail). */
  gcAgents(isOnline: (agentId: string) => boolean): number {
    const cutoff = now() - this.cfg.limits.ephemeralGraceSec * 1000;
    const stale = this.db.all<{ id: string }>("SELECT id FROM agents WHERE persistent = 0 AND last_seen_at < ?", cutoff).filter((a) => !isOnline(a.id));
    for (const a of stale) {
      this.db.tx(() => {
        this.db.run("DELETE FROM messages WHERE to_agent = ? AND delivered_at IS NULL", a.id);
        this.db.run("DELETE FROM agents WHERE id = ?", a.id);
      });
    }
    return stale.length;
  }

  forgetAgent(accountId: string, name: string, actor: string): void {
    const r = this.db.run("DELETE FROM agents WHERE account_id = ? AND name = ?", accountId, name);
    if (!r.changes) throw new ApiError("not_found", "Agent not found", 404);
    this.audit(accountId, actor, "agent.forget", { name });
  }

  // ---------- pairing (cross-account) ----------
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
      if (peer.account_id === agent.account_id) throw new ApiError("same_account", "Agents on the same account can already talk; pairing is for other accounts");
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

  // ---------- quota ----------
  usage(account: Account): { plan: string; limit: number; used: number; remaining: number; periodEndsAt: number } {
    const used = this.db.get<{ messages: number }>("SELECT messages FROM usage WHERE account_id = ? AND period = ?", account.id, period())?.messages ?? 0;
    const limit = this.plan(account).monthlyMessages;
    return { plan: account.plan, limit, used, remaining: Math.max(0, limit - used), periodEndsAt: periodEnd() };
  }

  // ---------- messages ----------
  /**
   * Persist a message (idempotent per sender+key) and charge the sender's quota.
   * Returns the stored row and whether it was newly created.
   */
  enqueueMessage(from: AgentRow, to: AgentRow, input: { text: string; deliverAs: "steer" | "followUp"; idempotencyKey?: string; attachmentIds: string[] }): { message: MessageRow; created: boolean; attachments: AttachmentRef[] } {
    const L = this.cfg.limits;
    if (Buffer.byteLength(input.text) > L.maxTextBytes) throw new ApiError("too_large", `Message text exceeds ${L.maxTextBytes} bytes`);
    if (!input.text.trim() && !input.attachmentIds.length) throw new ApiError("empty", "Message is empty");
    if (input.attachmentIds.length > L.maxAttachmentsPerMessage) throw new ApiError("too_many_attachments", `At most ${L.maxAttachmentsPerMessage} attachments`);
    if (input.idempotencyKey && input.idempotencyKey.length > 128) throw new ApiError("invalid_key", "idempotencyKey too long");

    return this.db.tx(() => {
      if (input.idempotencyKey) {
        const dup = this.db.get<MessageRow>("SELECT * FROM messages WHERE from_agent = ? AND idem_key = ?", from.id, input.idempotencyKey);
        if (dup) return { message: dup, created: false, attachments: JSON.parse(dup.attachments) };
      }
      const account = this.account(from.account_id)!;
      const plan = this.plan(account);
      const p = period();
      const used = this.db.get<{ messages: number }>("SELECT messages FROM usage WHERE account_id = ? AND period = ?", account.id, p)?.messages ?? 0;
      if (used >= plan.monthlyMessages) throw new ApiError("quota_exceeded", `Monthly message limit (${plan.monthlyMessages}) reached`, 429, { periodEndsAt: periodEnd() });

      const refs: AttachmentRef[] = [];
      for (const aid of input.attachmentIds) {
        const att = this.db.get<AttachmentRow>("SELECT * FROM attachments WHERE id = ?", aid);
        if (!att || att.account_id !== from.account_id || att.expires_at < now()) throw new ApiError("invalid_attachment", `Attachment ${aid} not found`);
        if (att.message_id) throw new ApiError("attachment_used", `Attachment ${aid} is already attached to a message`);
        refs.push({ attachmentId: att.id, fileCode: att.file_code, fileName: att.name, byteSize: att.size, sha256: att.sha256 });
      }

      const msg: MessageRow = {
        id: id("msg"), seq: ++this.seq, from_agent: from.id, to_agent: to.id,
        episode_id: `ep_${[from.id, to.id].sort().join("~").replace(/ag_/g, "")}`,
        body: input.text, deliver_as: input.deliverAs, attachments: JSON.stringify(refs),
        created_at: now(), expires_at: now() + plan.queueTtlSec * 1000, delivered_at: null,
      };
      this.db.run(`INSERT INTO messages (id, seq, from_agent, to_agent, episode_id, body, deliver_as, attachments, idem_key, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        msg.id, msg.seq, msg.from_agent, msg.to_agent, msg.episode_id, msg.body, msg.deliver_as, msg.attachments, input.idempotencyKey ?? null, msg.created_at, msg.expires_at);
      for (const r of refs) this.db.run("UPDATE attachments SET message_id = ?, expires_at = MAX(expires_at, ?) WHERE id = ?", msg.id, msg.expires_at, r.attachmentId);
      this.db.run("INSERT INTO usage (account_id, period, messages) VALUES (?, ?, 1) ON CONFLICT(account_id, period) DO UPDATE SET messages = messages + 1", account.id, p);
      return { message: msg, created: true, attachments: refs };
    });
  }

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

  // ---------- attachments ----------
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

  /** A device may download an attachment if its account owns the sender or recipient agent of the message. */
  attachmentForDownload(device: Device, fileCode: string): AttachmentRow {
    const att = this.db.get<AttachmentRow>("SELECT * FROM attachments WHERE file_code = ?", fileCode);
    if (!att || att.expires_at < now()) throw new ApiError("not_found", "Attachment not found or expired", 404);
    if (att.account_id === device.account_id) return att;
    if (att.message_id) {
      const ok = this.db.get(
        `SELECT 1 FROM messages m JOIN agents t ON t.id = m.to_agent WHERE m.id = ? AND t.account_id = ?`, att.message_id, device.account_id);
      if (ok) return att;
    }
    throw new ApiError("not_found", "Attachment not found or expired", 404);
  }

  /** Delete expired rows; returns attachment ids whose blobs should be removed. */
  sweepExpired(): { messages: number; attachments: string[] } {
    const t = now();
    const atts = this.db.all<{ id: string }>("SELECT id FROM attachments WHERE expires_at < ?", t).map((r) => r.id);
    const m = this.db.run("DELETE FROM messages WHERE expires_at < ? OR (delivered_at IS NOT NULL AND delivered_at < ?)", t, t - 24 * 3600 * 1000).changes;
    this.db.run("DELETE FROM attachments WHERE expires_at < ?", t);
    this.db.run("DELETE FROM enrollments WHERE expires_at < ?", t - 24 * 3600 * 1000);
    this.db.run("DELETE FROM pair_invites WHERE expires_at < ?", t);
    this.db.run("DELETE FROM audit WHERE at < ?", t - 90 * 24 * 3600 * 1000);
    return { messages: m, attachments: atts };
  }
}
