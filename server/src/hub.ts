import { WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { ApiError, type AgentRow, type MessageRow, type Store, type Device, type Account } from "./store.ts";
import type { Config } from "./config.ts";
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
  inflight: Set<string>; // message ids pushed on this connection but not yet acked
};

type Frame = { type: string; id?: string; payload?: any };

/** WebSocket session handling: authentication, presence, routing and delivery. */
export class Hub {
  private conns = new Set<Conn>();
  private online = new Map<string, Conn>(); // agentId -> conn
  private sendLimiter: RateLimiter;
  private frameLimiter = new RateLimiter(100, 20);
  private helloLimiter: RateLimiter;
  private closed = false;

  constructor(private store: Store, private cfg: Config, private log: Logger, private metrics: Metrics) {
    this.helloLimiter = new RateLimiter(cfg.limits.helloBurst, cfg.limits.helloPerSec);
    this.sendLimiter = new RateLimiter(cfg.limits.wsSendBurst, cfg.limits.wsSendPerSec);
    metrics.gauge("connections", () => this.conns.size);
    metrics.gauge("agents_online", () => this.online.size);
  }

  isOnline = (agentId: string): boolean => this.online.has(agentId);

  onlineCount(accountId: string): number {
    let n = 0;
    for (const c of this.online.values()) if (c.account?.id === accountId) n++;
    return n;
  }

  attach(ws: WebSocket, req: IncomingMessage, ip: string): void {
    const conn: Conn = { connId: id("c", 6), ws, ip, activity: "idle", lastFrameAt: now(), inflight: new Set() };
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
    void req;
  }

  private send(conn: Conn, type: string, payload: unknown, reqId?: string): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    conn.ws.send(JSON.stringify(reqId ? { type, id: reqId, payload } : { type, payload }));
  }

  private replyError(conn: Conn, reqId: string | undefined, error: unknown): void {
    if (error instanceof ApiError) {
      this.send(conn, "error", { code: error.code, message: error.message, ...error.extra }, reqId);
    } else {
      this.log.error("ws.handler_error", { err: String((error as Error)?.stack ?? error) });
      this.send(conn, "error", { code: "internal", message: "Internal server error" }, reqId);
    }
  }

  private handle(conn: Conn, f: Frame): void {
    const p = f.payload ?? {};
    if (!this.frameLimiter.take(conn.connId)) throw new ApiError("rate_limited", "Too many requests", 429, { retryAfterMs: 1000 });
    if (f.type === "hello") return this.hello(conn, f.id, p);
    if (f.type === "ping") return this.send(conn, "pong", { serverTime: now() }, f.id);
    const me = conn.agent;
    if (!me) throw new ApiError("no_hello", "Send hello first", 401);

    switch (f.type) {
      case "activity":
        conn.activity = p.activity === "busy" ? "busy" : "idle";
        return;
      case "list_agents": {
        const { same, paired } = this.store.knownAgents(me);
        const devName = new Map(this.store.listDevices(me.account_id).map((d) => [d.id, d.name]));
        return this.send(conn, "list_agents_result", {
          same: same.map((a) => ({ agentId: a.id, name: a.name, deviceName: devName.get(a.device_id), persistent: !!a.persistent, ...this.presence(a.id) })),
          paired: paired.map((a) => ({ agentId: a.id, name: a.name, account: a.account_name, ...this.presence(a.id) })),
        }, f.id);
      }
      case "send": return this.sendMessage(conn, me, f.id, p);
      case "ack": {
        const ids: string[] = Array.isArray(p.messageIds) ? p.messageIds.filter((x: unknown) => typeof x === "string") : [];
        const n = this.store.ack(me.id, ids);
        for (const mid of ids) conn.inflight.delete(mid);
        this.metrics.inc("messages_acked", n);
        if (f.id) this.send(conn, "ack_result", { acked: n }, f.id);
        return;
      }
      case "agent_status": {
        const target = this.store.resolveTarget(me, String(p.to ?? ""));
        if (!target) throw new ApiError("agent_unknown", `No agent named "${p.to}" is reachable`, 404);
        return this.send(conn, "agent_status_result", { agentId: target.id, name: target.name, ...this.presence(target.id), observedAt: now() }, f.id);
      }
      case "pair_create": {
        const inv = this.store.createPairInvite(me);
        return this.send(conn, "pair_create_result", inv, f.id);
      }
      case "pair_accept": {
        const peer = this.store.acceptPairInvite(me, String(p.code ?? ""));
        const peerConn = this.online.get(peer.id);
        if (peerConn) this.send(peerConn, "pair_added", { agentId: me.id, name: me.name, account: conn.account!.name });
        const acc = this.store.account(peer.account_id)!;
        return this.send(conn, "pair_accept_result", { agentId: peer.id, name: peer.name, account: acc.name }, f.id);
      }
      case "unpair": {
        const peerId = String(p.agentId ?? "");
        const removed = this.store.unpair(me, peerId);
        const peerConn = this.online.get(peerId);
        if (removed && peerConn) this.send(peerConn, "pair_removed", { agentId: me.id, name: me.name });
        return this.send(conn, "unpair_result", { removed }, f.id);
      }
      case "usage":
        return this.send(conn, "usage_result", this.store.usage(this.store.account(me.account_id)!), f.id);
      default:
        throw new ApiError("unknown_type", `Unknown frame type "${f.type}"`);
    }
  }

  private presence(agentId: string): { online: boolean; activity: "busy" | "idle" | "offline" } {
    const c = this.online.get(agentId);
    return c ? { online: true, activity: c.activity } : { online: false, activity: "offline" };
  }

  private hello(conn: Conn, reqId: string | undefined, p: any): void {
    if (conn.agent) throw new ApiError("already_authenticated", "hello already completed");
    if (!this.helloLimiter.take(conn.ip)) { this.replyError(conn, reqId, new ApiError("rate_limited", "Too many connection attempts", 429, { retryAfterMs: 5000 })); conn.ws.close(4029, "rate_limited"); return; }
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
    const plan = this.store.plan(account);

    const { agent, credential } = this.store.claimAgent(device, {
      name: typeof p.name === "string" && p.name ? p.name : undefined,
      credential: typeof p.credential === "string" ? p.credential : undefined,
      isOnline: this.isOnline,
    });

    // A resumed identity replaces any stale connection still holding it.
    const prev = this.online.get(agent.id);
    if (prev && prev !== conn) {
      this.send(prev, "replaced", {});
      prev.ws.close(4002, "replaced");
      this.online.delete(agent.id);
    }
    if (this.onlineCount(account.id) >= plan.maxOnlineAgents) {
      throw new ApiError("agent_limit", `Plan ${account.plan} allows ${plan.maxOnlineAgents} agents online at once`, 403);
    }

    conn.agent = agent; conn.device = device; conn.account = account;
    this.online.set(agent.id, conn);
    this.log.info("agent.online", { agent: agent.id, name: agent.name, device: device.id, account: account.id });
    this.send(conn, "hello_result", {
      protocol: PROTOCOL_VERSION, agentId: agent.id, name: agent.name, persistent: !!agent.persistent, credential,
      account: { id: account.id, name: account.name, plan: account.plan }, device: { id: device.id, name: device.name },
    }, reqId);
    this.flush(agent.id);
  }

  private sendMessage(conn: Conn, me: AgentRow, reqId: string | undefined, p: any): void {
    if (!this.sendLimiter.take(me.id)) throw new ApiError("rate_limited", "Sending too fast", 429, { retryAfterMs: 1000 });
    const target = this.store.resolveTarget(me, String(p.to ?? ""));
    if (!target) throw new ApiError("agent_unknown", `No agent named "${p.to}" is reachable. Use list_agents to see who you can message.`, 404);
    if (target.id === me.id) throw new ApiError("self_send", "Cannot message yourself");
    const { message, created } = this.store.enqueueMessage(me, target, {
      text: typeof p.text === "string" ? p.text : "",
      deliverAs: p.deliverAs === "steer" ? "steer" : "followUp",
      idempotencyKey: typeof p.idempotencyKey === "string" ? p.idempotencyKey : undefined,
      attachmentIds: Array.isArray(p.attachments) ? p.attachments.map(String) : [],
    });
    if (created) this.metrics.inc("messages_sent");
    const online = this.online.has(target.id);
    this.send(conn, "send_result", { messageId: message.id, status: online ? "delivered" : "queued", recipient: { agentId: target.id, name: target.name, persistent: !!target.persistent }, expiresAt: message.expires_at }, reqId);
    if (online) this.flush(target.id);
  }

  /** Push all pending (unacked, not already in flight on this connection) messages to an online agent, in order. */
  flush(agentId: string): void {
    const conn = this.online.get(agentId);
    if (!conn) return;
    const pending = this.store.pendingFor(agentId);
    if (!pending.length) return;
    const senders = new Map<string, { name: string; device?: string; account?: string; accountId: string }>();
    for (const m of pending) {
      if (conn.inflight.has(m.id)) continue;
      let s = senders.get(m.from_agent);
      if (!s) {
        const a = this.store.agent(m.from_agent);
        const acc = a ? this.store.account(a.account_id) : undefined;
        const dev = a ? this.store.listDevices(a.account_id).find((d) => d.id === a.device_id) : undefined;
        s = { name: a?.name ?? "deleted-agent", device: dev?.name, account: acc?.name, accountId: a?.account_id ?? "" };
        senders.set(m.from_agent, s);
      }
      conn.inflight.add(m.id);
      this.send(conn, "message", this.toWire(m, s, conn.account!.id));
      this.metrics.inc("messages_pushed");
    }
  }

  private toWire(m: MessageRow, s: { name: string; device?: string; account?: string; accountId: string }, recipientAccountId: string) {
    return {
      messageId: m.id, seq: m.seq, episodeId: m.episode_id,
      from: { agentId: m.from_agent, name: s.name, deviceName: s.device, ...(s.accountId !== recipientAccountId ? { account: s.account, external: true } : {}) },
      text: m.body, deliverAs: m.deliver_as, attachments: JSON.parse(m.attachments), sentAt: m.created_at,
    };
  }

  /** Called periodically: reap dead sockets, redeliver messages stuck in flight. */
  tick(): void {
    const t = now();
    for (const c of this.conns) {
      if (t - c.lastFrameAt > this.cfg.limits.idleTimeoutMs) { c.ws.terminate(); continue; }
      if (c.agent && c.inflight.size) {
        // If the client never acked within 30s, allow a re-push (client dedups by messageId).
        const stale = this.store.pendingFor(c.agent.id).filter((m) => c.inflight.has(m.id) && t - m.created_at > 30_000);
        if (stale.length) { for (const m of stale) c.inflight.delete(m.id); this.flush(c.agent.id); }
      }
    }
    this.sendLimiter.sweep();
    this.frameLimiter.sweep();
    this.helloLimiter.sweep();
  }

  disconnectDevice(deviceId: string, reason: string): void {
    for (const c of this.conns) if (c.device?.id === deviceId) { this.send(c, "revoked", { reason }); c.ws.close(4003, reason); }
  }

  disconnectAccount(accountId: string, reason: string): void {
    for (const c of this.conns) if (c.account?.id === accountId) { this.send(c, "revoked", { reason }); c.ws.close(4003, reason); }
  }

  shutdown(): void {
    for (const c of this.conns) if (c.agent) this.store.touchAgent(c.agent.id);
    this.closed = true;
    for (const c of this.conns) c.ws.close(1012, "server_restart");
  }
}
