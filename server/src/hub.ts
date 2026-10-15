import { WebSocket } from "ws";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import { ApiError, cleanProfile, type AgentRow, type MessageRow, type Store, type Device, type Account, type Profile } from "./store.ts";
import type { Config } from "./config.ts";
import { within } from "./config.ts";
import { Logger, Metrics, RateLimiter, id, now } from "./util.ts";

export const PROTOCOL_VERSION = 1;

type Activity = "busy" | "idle";
type Conn = {
  connId: string;
  ws: WebSocket;
  ip: string;
  agent?: AgentRow;
  device?: Device;
  account?: Account;
  activity: Activity;
  lastFrameAt: number;
  inflight: Map<string, number>; // messageId -> pushed at
};
type Frame = { type: string; id?: string; payload?: any };
type Poller = { resolve: () => void; timer: ReturnType<typeof setTimeout> };

export type Presence = { online: boolean; activity: "busy" | "idle" | "offline"; via?: "ws" | "http" | "webhook" };

/**
 * Sessions, presence, routing and delivery for every transport:
 *  - WebSocket (pi extension, long-lived agents)
 *  - HTTP long-poll (MCP bridge, scripts, any language)
 *  - Webhook push (services that cannot hold a connection)
 * All transports share the same durable queue and at-least-once + ack semantics.
 */
export class Hub {
  private conns = new Set<Conn>();
  private online = new Map<string, Conn>(); // agentId -> ws conn
  private httpSeen = new Map<string, { at: number; activity: Activity }>(); // agentId -> last poll
  private pollers = new Map<string, Poller>(); // agentId -> waiting long-poll
  private leases = new Map<string, number>(); // messageId -> leased until (http delivery)
  private webhookBusy = new Set<string>();
  private sendLimiter: RateLimiter;
  private helloLimiter: RateLimiter;
  private frameLimiter = new RateLimiter(100, 20);
  private closed = false;

  constructor(private store: Store, private cfg: Config, private log: Logger, private metrics: Metrics) {
    this.helloLimiter = new RateLimiter(cfg.limits.helloBurst, cfg.limits.helloPerSec);
    this.sendLimiter = new RateLimiter(cfg.limits.wsSendBurst, cfg.limits.wsSendPerSec);
    metrics.gauge("connections", () => this.conns.size);
    metrics.gauge("agents_online_ws", () => this.online.size);
    metrics.gauge("agents_online_http", () => [...this.httpSeen.values()].filter((s) => now() - s.at < cfg.limits.pollOnlineMs).length);
  }

  /** Live = currently holding a WS connection or polled recently. */
  isLive = (agentId: string): boolean => this.online.has(agentId) || this.httpLive(agentId);

  private httpLive(agentId: string): boolean {
    const s = this.httpSeen.get(agentId);
    return !!s && (now() - s.at < this.cfg.limits.pollOnlineMs || this.pollers.has(agentId));
  }

  presence(agent: AgentRow): Presence {
    const c = this.online.get(agent.id);
    if (c) return { online: true, activity: c.activity, via: "ws" };
    if (this.pollers.has(agent.id)) return { online: true, activity: this.httpSeen.get(agent.id)?.activity ?? "idle", via: "http" };
    if (agent.webhook_url) return { online: true, activity: this.httpSeen.get(agent.id)?.activity ?? "idle", via: "webhook" };
    if (this.httpLive(agent.id)) return { online: true, activity: this.httpSeen.get(agent.id)!.activity, via: "http" };
    return { online: false, activity: "offline" };
  }

  onlineCount(accountId: string): number {
    let n = 0;
    for (const c of this.online.values()) if (c.account?.id === accountId) n++;
    for (const [aid] of this.httpSeen) if (this.httpLive(aid) && !this.online.has(aid) && this.store.agent(aid)?.account_id === accountId) n++;
    return n;
  }

  // ================================================================ shared operations (WS + HTTP)

  describe(a: AgentRow, viewerAccountId: string, extra: Record<string, unknown> = {}) {
    const dev = this.store.device(a.device_id);
    let profile: Profile = {};
    try { profile = JSON.parse(a.profile); } catch { /* ignore */ }
    return {
      agentId: a.id, name: a.name, deviceName: dev?.name, persistent: !!a.persistent, ...profile, ...this.presence(a),
      ...(a.account_id !== viewerAccountId ? { external: true } : {}), ...extra,
    };
  }

  listAgents(me: AgentRow, capability?: string) {
    const { same, paired } = this.store.knownAgents(me);
    const cap = capability?.trim().toLowerCase();
    const match = (a: AgentRow) => {
      if (!cap) return true;
      try {
        const p = JSON.parse(a.profile) as Profile;
        return !!p.capabilities?.some((c) => c === cap || c.startsWith(cap + ":") || c.startsWith(cap + "/")) || !!p.description?.toLowerCase().includes(cap);
      } catch { return false; }
    };
    return {
      self: this.describe(me, me.account_id),
      same: same.filter(match).map((a) => this.describe(a, me.account_id)),
      paired: paired.filter(match).map((a) => this.describe(a, me.account_id, { account: a.account_name })),
    };
  }

  status(me: AgentRow, to: string) {
    const target = this.store.resolveTarget(me, to);
    if (!target) throw new ApiError("agent_unknown", `No agent named "${to}" is reachable`, 404);
    return { ...this.describe(target, me.account_id), observedAt: now() };
  }

  send(me: AgentRow, p: any) {
    if (!this.sendLimiter.take(me.id)) throw new ApiError("rate_limited", "Sending too fast", 429, { retryAfterMs: 1000 });
    const target = this.store.resolveTarget(me, String(p.to ?? ""));
    if (!target) throw new ApiError("agent_unknown", `No agent named "${p.to}" is reachable. List agents to see who you can message.`, 404);
    if (target.id === me.id) throw new ApiError("self_send", "Cannot message yourself");
    const { message, created } = this.store.enqueueMessage(me, target, {
      text: typeof p.text === "string" ? p.text : "",
      deliverAs: p.deliverAs === "steer" ? "steer" : "followUp",
      idempotencyKey: typeof p.idempotencyKey === "string" ? p.idempotencyKey : undefined,
      attachmentIds: Array.isArray(p.attachments) ? p.attachments.map(String) : [],
      replyTo: typeof p.replyTo === "string" ? p.replyTo : undefined,
    });
    if (created) this.metrics.inc("messages_sent");
    const pres = this.presence(target);
    if (created) this.wake(target.id);
    return {
      messageId: message.id,
      status: pres.online ? "delivered" : "queued",
      recipient: { agentId: target.id, name: target.name, persistent: !!target.persistent, activity: pres.activity, via: pres.via },
      expiresAt: message.expires_at,
    };
  }

  ack(me: AgentRow, ids: unknown): number {
    const list: string[] = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
    const n = this.store.ack(me.id, list);
    const c = this.online.get(me.id);
    for (const mid of list) { c?.inflight.delete(mid); this.leases.delete(mid); }
    this.metrics.inc("messages_acked", n);
    return n;
  }

  pairCreate(me: AgentRow) { return this.store.createPairInvite(me); }

  pairAccept(me: AgentRow, code: string) {
    const peer = this.store.acceptPairInvite(me, code);
    const meAcc = this.store.account(me.account_id)!;
    const peerAcc = this.store.account(peer.account_id)!;
    this.notify(peer.id, "pair_added", { agentId: me.id, name: me.name, account: meAcc.name });
    return { agentId: peer.id, name: peer.name, account: peerAcc.name };
  }

  unpair(me: AgentRow, peerId: string) {
    const removed = this.store.unpair(me, peerId);
    if (removed) this.notify(peerId, "pair_removed", { agentId: me.id, name: me.name });
    return { removed };
  }

  setProfile(me: AgentRow, p: unknown) {
    const profile = cleanProfile(p);
    this.store.setProfile(me.id, profile);
    me.profile = JSON.stringify(profile);
    return { profile };
  }

  private notify(agentId: string, type: string, payload: unknown): void {
    const c = this.online.get(agentId);
    if (c) this.sendFrame(c, type, payload);
  }

  /** Something arrived for this agent: push over WS, wake a long-poll, or trigger the webhook. */
  wake(agentId: string): void {
    if (this.online.has(agentId)) return this.flush(agentId);
    const p = this.pollers.get(agentId);
    if (p) { this.pollers.delete(agentId); clearTimeout(p.timer); p.resolve(); return; }
    const a = this.store.agent(agentId);
    if (a?.webhook_url) void this.deliverWebhook(a);
  }

  // ================================================================ WebSocket transport

  attach(ws: WebSocket, ip: string): void {
    const conn: Conn = { connId: id("c", 6), ws, ip, activity: "idle", lastFrameAt: now(), inflight: new Map() };
    this.conns.add(conn);
    this.metrics.inc("connections_total");
    const helloTimer = setTimeout(() => { if (!conn.agent) ws.close(4000, "hello_timeout"); }, this.cfg.limits.helloTimeoutMs);

    ws.on("message", (raw, isBinary) => {
      if (this.closed) return;
      conn.lastFrameAt = now();
      if (isBinary) return ws.close(1003, "binary_not_supported");
      let frame: Frame;
      try { frame = JSON.parse(raw.toString()); } catch { return ws.close(1007, "invalid_json"); }
      if (!frame || typeof frame.type !== "string") return ws.close(1007, "invalid_frame");
      try {
        this.handle(conn, frame);
      } catch (error) {
        this.replyError(conn, frame.id, error);
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.conns.delete(conn);
      if (conn.agent && this.online.get(conn.agent.id) === conn) {
        this.online.delete(conn.agent.id);
        if (!this.closed) this.store.touchAgent(conn.agent.id);
        this.log.info("agent.offline", { agent: conn.agent.id, name: conn.agent.name });
      }
    });
    ws.on("error", () => undefined);
  }

  private sendFrame(conn: Conn, type: string, payload: unknown, reqId?: string): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify(reqId ? { type, id: reqId, payload } : { type, payload }));
  }

  private replyError(conn: Conn, reqId: string | undefined, error: unknown): void {
    if (error instanceof ApiError) {
      this.sendFrame(conn, "error", { code: error.code, message: error.message, ...error.extra }, reqId);
    } else {
      this.log.error("ws.handler_error", { err: String((error as Error)?.stack ?? error) });
      this.sendFrame(conn, "error", { code: "internal", message: "Internal server error" }, reqId);
    }
  }

  private handle(conn: Conn, f: Frame): void {
    const p = f.payload ?? {};
    if (!this.frameLimiter.take(conn.connId)) throw new ApiError("rate_limited", "Too many requests", 429, { retryAfterMs: 1000 });
    if (f.type === "hello") return this.hello(conn, f.id, p);
    if (f.type === "ping") return this.sendFrame(conn, "pong", { serverTime: now() }, f.id);
    const me = conn.agent;
    if (!me) throw new ApiError("no_hello", "Send hello first", 401);
    const reply = (type: string, payload: unknown) => this.sendFrame(conn, type, payload, f.id);

    switch (f.type) {
      case "activity": conn.activity = p.activity === "busy" ? "busy" : "idle"; return;
      case "list_agents": return reply("list_agents_result", this.listAgents(me, typeof p.capability === "string" ? p.capability : undefined));
      case "send": return reply("send_result", this.send(me, p));
      case "ack": { const n = this.ack(me, p.messageIds); if (f.id) reply("ack_result", { acked: n }); return; }
      case "agent_status": return reply("agent_status_result", this.status(me, String(p.to ?? "")));
      case "set_profile": return reply("set_profile_result", this.setProfile(me, p.profile));
      case "pair_create": return reply("pair_create_result", this.pairCreate(me));
      case "pair_accept": return reply("pair_accept_result", this.pairAccept(me, String(p.code ?? "")));
      case "unpair": return reply("unpair_result", this.unpair(me, String(p.agentId ?? "")));
      case "usage": return reply("usage_result", this.store.usage(this.store.account(me.account_id)!));
      default: throw new ApiError("unknown_type", `Unknown frame type "${f.type}"`);
    }
  }

  /** Identity claim shared by WS hello and HTTP /v1/agent/connect. */
  claim(device: Device, account: Account, p: any): { agent: AgentRow; credential: string } {
    const { agent, credential } = this.store.claimAgent(device, {
      name: typeof p.name === "string" && p.name ? p.name : undefined,
      credential: typeof p.credential === "string" ? p.credential : undefined,
      profile: p.profile !== undefined ? cleanProfile(p.profile) : undefined,
      isLive: this.isLive,
    });
    const alreadyCounted = this.isLive(agent.id);
    if (!alreadyCounted && !within(this.onlineCount(account.id), this.store.quotas(account).maxOnlineAgents)) {
      throw new ApiError("agent_limit", `At most ${this.store.quotas(account).maxOnlineAgents} agents can be online at once on this account`, 403);
    }
    return { agent, credential };
  }

  identity(agent: AgentRow, credential: string, device: Device, account: Account) {
    let profile: Profile = {};
    try { profile = JSON.parse(agent.profile); } catch { /* ignore */ }
    return {
      protocol: PROTOCOL_VERSION, agentId: agent.id, name: agent.name, persistent: !!agent.persistent, credential, profile,
      account: { id: account.id, name: account.name, email: account.email }, device: { id: device.id, name: device.name },
    };
  }

  private hello(conn: Conn, reqId: string | undefined, p: any): void {
    if (conn.agent) throw new ApiError("already_authenticated", "hello already completed");
    if (!this.helloLimiter.take(conn.ip)) {
      this.replyError(conn, reqId, new ApiError("rate_limited", "Too many connection attempts", 429, { retryAfterMs: 5000 }));
      conn.ws.close(4029, "rate_limited");
      return;
    }
    if (p.protocol !== undefined && p.protocol !== PROTOCOL_VERSION) throw new ApiError("protocol_unsupported", `Server speaks protocol ${PROTOCOL_VERSION}`, 400);
    let auth: { device: Device; account: Account };
    try {
      auth = this.store.authDevice(p.deviceId, p.deviceToken);
    } catch (error) {
      this.replyError(conn, reqId, error);
      conn.ws.close(4001, (error as ApiError).code ?? "unauthorized");
      return;
    }
    const { device, account } = auth;
    const { agent, credential } = this.claim(device, account, p);

    const prev = this.online.get(agent.id);
    if (prev && prev !== conn) {
      this.sendFrame(prev, "replaced", {});
      prev.ws.close(4002, "replaced");
      this.online.delete(agent.id);
    }
    conn.agent = agent; conn.device = device; conn.account = account;
    this.online.set(agent.id, conn);
    this.log.info("agent.online", { agent: agent.id, name: agent.name, device: device.id, account: account.id, via: "ws" });
    this.sendFrame(conn, "hello_result", this.identity(agent, credential, device, account), reqId);
    this.flush(agent.id);
  }

  /** Push pending (unacked, not in flight) messages to a WS agent, in order. */
  flush(agentId: string): void {
    const conn = this.online.get(agentId);
    if (!conn) return;
    for (const m of this.store.pendingFor(agentId)) {
      if (conn.inflight.has(m.id)) continue;
      conn.inflight.set(m.id, now());
      this.sendFrame(conn, "message", this.toWire(m, conn.account!.id));
      this.metrics.inc("messages_pushed");
    }
  }

  private senderCache = new Map<string, { at: number; v: { name: string; deviceName?: string; account: string; accountId: string } }>();

  toWire(m: MessageRow, recipientAccountId: string) {
    let s = this.senderCache.get(m.from_agent);
    if (!s || now() - s.at > 30_000) {
      const a = this.store.agent(m.from_agent);
      const acc = a ? this.store.account(a.account_id) : undefined;
      const dev = a ? this.store.device(a.device_id) : undefined;
      s = { at: now(), v: { name: a?.name ?? "deleted-agent", deviceName: dev?.name, account: acc?.name ?? "", accountId: a?.account_id ?? "" } };
      this.senderCache.set(m.from_agent, s);
      if (this.senderCache.size > 10_000) this.senderCache.clear();
    }
    const v = s.v;
    return {
      messageId: m.id, seq: m.seq, episodeId: m.episode_id, ...(m.reply_to ? { replyTo: m.reply_to } : {}),
      from: { agentId: m.from_agent, name: v.name, deviceName: v.deviceName, ...(v.accountId !== recipientAccountId ? { account: v.account, external: true } : {}) },
      text: m.body, deliverAs: m.deliver_as, attachments: JSON.parse(m.attachments), sentAt: m.created_at,
    };
  }

  // ================================================================ HTTP transport (long-poll)

  touchHttp(agent: AgentRow, activity?: Activity): void {
    const prev = this.httpSeen.get(agent.id);
    this.httpSeen.set(agent.id, { at: now(), activity: activity ?? prev?.activity ?? "idle" });
  }

  /** Long-poll: returns leased messages; unacked messages are re-leased after redeliverAfterMs. */
  async poll(agent: AgentRow, waitMs: number, signal: AbortSignal): Promise<ReturnType<Hub["toWire"]>[]> {
    this.touchHttp(agent);
    const take = () => {
      const t = now();
      const out: MessageRow[] = [];
      for (const m of this.store.pendingFor(agent.id, 100)) {
        const until = this.leases.get(m.id);
        if (until && until > t) continue;
        this.leases.set(m.id, t + this.cfg.limits.redeliverAfterMs);
        out.push(m);
      }
      return out;
    };
    let msgs = take();
    if (!msgs.length && waitMs > 0 && !signal.aborted) {
      const old = this.pollers.get(agent.id);
      if (old) { clearTimeout(old.timer); old.resolve(); }
      await new Promise<void>((resolve) => {
        const done = () => { if (this.pollers.get(agent.id)?.resolve === resolveOnce) this.pollers.delete(agent.id); resolve(); };
        let called = false;
        const resolveOnce = () => { if (!called) { called = true; clearTimeout(timer); signal.removeEventListener("abort", resolveOnce); done(); } };
        const timer = setTimeout(resolveOnce, waitMs);
        signal.addEventListener("abort", resolveOnce, { once: true });
        this.pollers.set(agent.id, { resolve: resolveOnce, timer });
      });
      this.touchHttp(agent);
      if (!signal.aborted) msgs = take();
    }
    return msgs.map((m) => this.toWire(m, agent.account_id));
  }

  // ================================================================ webhook transport

  async validateWebhookUrl(raw: string): Promise<string> {
    let u: URL;
    try { u = new URL(raw); } catch { throw new ApiError("invalid_url", "Webhook URL is not a valid URL"); }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new ApiError("invalid_url", "Webhook URL must be http(s)");
    if (this.cfg.webhooks === "off") throw new ApiError("webhooks_disabled", "Webhooks are disabled on this server", 403);
    if (this.cfg.webhooks === "public") {
      if (u.protocol !== "https:") throw new ApiError("invalid_url", "Webhook URL must use https on this server");
      const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
      if (!addrs.length) throw new ApiError("invalid_url", "Webhook host does not resolve");
      if (addrs.some((a) => isPrivateIp(a.address))) throw new ApiError("invalid_url", "Webhook URL must not point to a private or loopback address");
    }
    return u.toString();
  }

  private async deliverWebhook(agent: AgentRow): Promise<void> {
    if (!agent.webhook_url || !agent.webhook_secret || this.webhookBusy.has(agent.id) || this.closed) return;
    this.webhookBusy.add(agent.id);
    try {
      const pending = this.store.pendingFor(agent.id, 50);
      if (!pending.length) return;
      if (this.cfg.webhooks === "public") await this.validateWebhookUrl(agent.webhook_url); // re-check: DNS may have changed
      const body = JSON.stringify({ agentId: agent.id, messages: pending.map((m) => this.toWire(m, agent.account_id)) });
      const ts = String(Math.floor(now() / 1000));
      const sig = crypto.createHmac("sha256", agent.webhook_secret).update(`${ts}.${body}`).digest("hex");
      const res = await fetch(agent.webhook_url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "agentlink-webhook/1", "x-agentlink-timestamp": ts, "x-agentlink-signature": `sha256=${sig}` },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status >= 200 && res.status < 300) {
        // 2xx acknowledges everything in the batch unless the receiver lists what it accepted.
        let acked = pending.map((m) => m.id);
        try { const j = await res.json() as any; if (Array.isArray(j?.ack)) acked = j.ack.filter((x: unknown) => typeof x === "string"); } catch { /* empty body */ }
        this.ack(agent, acked);
        this.store.webhookResult(agent.id, true);
        this.metrics.inc("webhook_ok");
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (error) {
      const f = this.store.webhookResult(agent.id, false);
      this.metrics.inc("webhook_fail");
      this.log.warn("webhook.failed", { agent: agent.id, failures: f, err: String((error as Error)?.message ?? error) });
    } finally {
      this.webhookBusy.delete(agent.id);
    }
  }

  // ================================================================ housekeeping

  tick(): void {
    const t = now();
    for (const c of this.conns) {
      if (t - c.lastFrameAt > this.cfg.limits.idleTimeoutMs) { c.ws.terminate(); continue; }
      if (c.agent && c.inflight.size) {
        let stale = false;
        for (const [mid, at] of c.inflight) if (t - at > this.cfg.limits.redeliverAfterMs) { c.inflight.delete(mid); stale = true; }
        if (stale) this.flush(c.agent.id);
      }
    }
    for (const [mid, until] of this.leases) if (until < t - 3600_000) this.leases.delete(mid);
    for (const [aid, s] of this.httpSeen) if (t - s.at > 3600_000 && !this.pollers.has(aid)) this.httpSeen.delete(aid);
    for (const a of this.store.webhookDue()) if (!this.online.has(a.id)) void this.deliverWebhook(a);
    this.sendLimiter.sweep(); this.helloLimiter.sweep(); this.frameLimiter.sweep();
  }

  disconnectDevice(deviceId: string, reason: string): void {
    for (const c of this.conns) if (c.device?.id === deviceId) { this.sendFrame(c, "revoked", { reason }); c.ws.close(4003, reason); }
  }

  disconnectAccount(accountId: string, reason: string): void {
    for (const c of this.conns) if (c.account?.id === accountId) { this.sendFrame(c, "revoked", { reason }); c.ws.close(4003, reason); }
  }

  shutdown(): void {
    for (const c of this.conns) if (c.agent) this.store.touchAgent(c.agent.id);
    this.closed = true;
    for (const p of this.pollers.values()) { clearTimeout(p.timer); p.resolve(); }
    this.pollers.clear();
    for (const c of this.conns) c.ws.close(1012, "server_restart");
  }
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isPrivateIp(x.slice(7));
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80");
}
