import WebSocket from "ws";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "1.0.0";

export type DeliverAs = "steer" | "followUp";
export type AttachmentRef = { attachmentId: string; fileCode: string; fileName: string; byteSize: number; sha256: string };
export type WireMessage = {
  messageId: string;
  seq: number;
  episodeId: string;
  from: { agentId: string; name: string; deviceName?: string; account?: string; external?: boolean };
  text: string;
  deliverAs: DeliverAs;
  attachments: AttachmentRef[];
  sentAt: number;
};
export type Identity = { agentId: string; name: string; persistent: boolean; credential: string; account: { id: string; name: string; plan: string }; device: { id: string; name: string } };
export type AgentInfo = { agentId: string; name: string; deviceName?: string; account?: string; persistent?: boolean; online: boolean; activity: "busy" | "idle" | "offline" };
export type SendResult = { messageId: string; status: "delivered" | "queued"; recipient: { agentId: string; name: string; persistent: boolean }; expiresAt: number };
export type ConnState = "idle" | "connecting" | "online" | "reconnecting" | "stopped" | "blocked";

export class AgentLinkError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs?: number) { super(message); }
}

// ---------------------------------------------------------------- credentials

export type Credentials = { serverUrl: string; deviceId: string; deviceToken: string; accountName?: string; deviceName?: string };

export function configDir(): string {
  if (process.env.AGENTLINK_CONFIG_DIR) return process.env.AGENTLINK_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "agentlink");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentlink");
}

export function readCredentials(): Credentials | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(configDir(), "credentials.json"), "utf8")) as Credentials;
    return c.serverUrl && c.deviceId && c.deviceToken ? c : null;
  } catch {
    return null;
  }
}

export function writeCredentials(c: Credentials): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "credentials.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function clearCredentials(): void {
  fs.rmSync(path.join(configDir(), "credentials.json"), { force: true });
}

// ---------------------------------------------------------------- REST

async function parse(res: Response): Promise<any> {
  let body: any = {};
  try { body = await res.json(); } catch { /* non-json */ }
  if (!res.ok || body.ok === false) throw new AgentLinkError(body.code ?? `http_${res.status}`, body.message ?? `HTTP ${res.status}`, body.retryAfterMs);
  return body;
}

export async function enroll(serverUrl: string, code: string, deviceName: string): Promise<Credentials> {
  const b = await parse(await fetch(new URL("/v1/enroll", serverUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, deviceName }) }));
  return { serverUrl, deviceId: b.device.id, deviceToken: b.deviceToken, accountName: b.account.name, deviceName: b.device.name };
}

export async function signup(serverUrl: string, accountName: string, deviceName: string): Promise<Credentials> {
  const b = await parse(await fetch(new URL("/v1/signup", serverUrl), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountName, deviceName }) }));
  return { serverUrl, deviceId: b.device.id, deviceToken: b.deviceToken, accountName: b.account.name, deviceName: b.device.name };
}

export class Rest {
  constructor(private c: Credentials) {}
  private auth() { return { authorization: `Device ${this.c.deviceId}:${this.c.deviceToken}` }; }
  async get(p: string) { return parse(await fetch(new URL(p, this.c.serverUrl), { headers: this.auth() })); }
  async post(p: string, body?: unknown) { return parse(await fetch(new URL(p, this.c.serverUrl), { method: "POST", headers: { ...this.auth(), "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })); }
  async del(p: string) { return parse(await fetch(new URL(p, this.c.serverUrl), { method: "DELETE", headers: this.auth() })); }

  async upload(filePath: string): Promise<AttachmentRef> {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new AgentLinkError("not_a_file", `Not a regular file: ${filePath}`);
    const res = await fetch(new URL("/v1/attachments", this.c.serverUrl), {
      method: "POST",
      headers: { ...this.auth(), "content-length": String(st.size), "x-file-name": encodeURIComponent(path.basename(filePath)), "content-type": "application/octet-stream" },
      body: Readable.toWeb(fs.createReadStream(filePath)) as any,
      duplex: "half",
    } as RequestInit);
    const b = await parse(res);
    return { attachmentId: b.attachmentId, fileCode: b.fileCode, fileName: b.fileName, byteSize: b.byteSize, sha256: b.sha256 };
  }

  /** Download to a directory or explicit file path; verifies sha256. Never overwrites existing files. */
  async download(fileCode: string, target: string): Promise<{ path: string; bytes: number; sha256: string }> {
    const res = await fetch(new URL(`/v1/attachments/${encodeURIComponent(fileCode)}`, this.c.serverUrl), { headers: this.auth() });
    if (!res.ok) await parse(res);
    const name = path.basename(decodeURIComponent(res.headers.get("x-file-name") ?? fileCode)).replace(/^\.+/, "_") || fileCode;
    let dest = target;
    const isDir = await fsp.stat(target).then((s) => s.isDirectory()).catch(() => target.endsWith(path.sep) || target.endsWith("/"));
    if (isDir) { await fsp.mkdir(target, { recursive: true }); dest = path.join(target, name); }
    else await fsp.mkdir(path.dirname(dest), { recursive: true });
    dest = await uniquePath(dest);
    const tmp = `${dest}.part-${crypto.randomBytes(4).toString("hex")}`;
    const hash = crypto.createHash("sha256");
    let bytes = 0;
    try {
      await pipeline(Readable.fromWeb(res.body as any), async function* (src) { for await (const c of src) { hash.update(c); bytes += c.length; yield c; } }, fs.createWriteStream(tmp, { flags: "wx" }));
      const digest = hash.digest("hex");
      const expected = res.headers.get("x-sha256");
      if (expected && expected !== digest) throw new AgentLinkError("checksum_mismatch", "Downloaded file failed integrity check");
      await fsp.rename(tmp, dest);
      return { path: dest, bytes, sha256: digest };
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }
}

async function uniquePath(p: string): Promise<string> {
  const exists = (x: string) => fsp.access(x).then(() => true, () => false);
  if (!(await exists(p))) return p;
  const ext = path.extname(p), base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 1000; i++) { const c = `${base} (${i})${ext}`; if (!(await exists(c))) return c; }
  throw new AgentLinkError("path_exists", `Cannot find a free file name near ${p}`);
}

// ---------------------------------------------------------------- WebSocket

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; type: string };

export type ClientOptions = {
  credentials: Credentials;
  /** Persistent agent name. Omit for an ephemeral, auto-named agent. */
  name?: string;
  /** Credential from a previous hello; resumes the same identity. */
  credential?: string;
  backoffMs?: number[];
  heartbeatIdleMs?: number;
  requestTimeoutMs?: number;
};

/**
 * Self-healing connection. Call start(); it keeps reconnecting with jittered backoff
 * until stop() or a non-retryable error (revoked device, invalid name, ...).
 */
export class AgentLinkClient {
  identity?: Identity;
  state: ConnState = "idle";
  lastError?: AgentLinkError;

  onMessage: (m: WireMessage) => void = () => {};
  onState: (s: ConnState, err?: AgentLinkError) => void = () => {};
  onIdentity: (id: Identity) => void = () => {};
  onEvent: (type: string, payload: any) => void = () => {};

  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastRx = 0;
  private seen = new Map<string, number>(); // messageId -> received at (dedup)
  private activity: "busy" | "idle" = "idle";
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private credential?: string;
  private readonly backoff: number[];

  constructor(private opts: ClientOptions) {
    this.credential = opts.credential;
    this.backoff = opts.backoffMs ?? [1_000, 3_000, 5_000, 10_000, 20_000, 40_000, 60_000];
  }

  start(): void {
    if (this.state !== "idle" && this.state !== "stopped" && this.state !== "blocked") return;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.setState("stopped");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new AgentLinkError("stopped", "Client stopped"));
    this.ws?.close(1000, "client_stop");
    this.ws = null;
    for (const w of this.waiters.splice(0)) w.reject(new AgentLinkError("stopped", "Client stopped"));
  }

  /** Resolve when online (or reject after timeout / non-retryable failure). */
  ready(timeoutMs = 10_000): Promise<void> {
    if (this.state === "online") return Promise.resolve();
    if (this.state === "blocked") return Promise.reject(this.lastError ?? new AgentLinkError("blocked", "Connection blocked"));
    if (this.state === "idle" || this.state === "stopped") this.start();
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => { clearTimeout(t); resolve(); },
        reject: (e: Error) => { clearTimeout(t); reject(e); },
      };
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        reject(this.lastError ?? new AgentLinkError("offline", "AgentLink server is unreachable"));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  setActivity(a: "busy" | "idle"): void {
    this.activity = a;
    if (this.state === "online") this.fire("activity", { activity: a });
  }

  ack(messageIds: string[]): void {
    if (messageIds.length) this.fire("ack", { messageIds });
  }

  async request<T = any>(type: string, payload?: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 10_000): Promise<T> {
    await this.ready(timeoutMs);
    return this.rawRequest<T>(type, payload, timeoutMs);
  }

  listAgents(): Promise<{ same: AgentInfo[]; paired: AgentInfo[] }> { return this.request("list_agents"); }
  status(to: string): Promise<AgentInfo & { observedAt: number }> { return this.request("agent_status", { to }); }
  usage(): Promise<{ plan: string; limit: number; used: number; remaining: number; periodEndsAt: number }> { return this.request("usage"); }
  createPairCode(): Promise<{ code: string; expiresAt: number }> { return this.request("pair_create"); }
  acceptPairCode(code: string): Promise<{ agentId: string; name: string; account: string }> { return this.request("pair_accept", { code }); }
  unpair(agentId: string): Promise<{ removed: boolean }> { return this.request("unpair", { agentId }); }

  /** Idempotent send: retries once across a reconnect with the same key. */
  async send(to: string, text: string, opts: { deliverAs?: DeliverAs; attachments?: string[]; idempotencyKey?: string } = {}): Promise<SendResult> {
    const payload = { to, text, deliverAs: opts.deliverAs ?? "followUp", attachments: opts.attachments ?? [], idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID() };
    try {
      return await this.request<SendResult>("send", payload);
    } catch (error) {
      if (error instanceof AgentLinkError && error.code !== "timeout" && error.code !== "disconnected") throw error;
      return await this.request<SendResult>("send", payload);
    }
  }

  // ---------------------------------------------------------------- internals

  private setState(s: ConnState, err?: AgentLinkError): void {
    this.state = s;
    if (err) this.lastError = err;
    this.onState(s, err);
    if (s === "online") for (const w of this.waiters.splice(0)) w.resolve();
    if (s === "blocked") for (const w of this.waiters.splice(0)) w.reject(err ?? new AgentLinkError("blocked", "blocked"));
  }

  private connect(): void {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    const url = new URL("/v1/ws", this.opts.credentials.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024 });
    this.ws = ws;

    ws.on("open", () => {
      this.lastRx = Date.now();
      this.rawRequest<Identity>("hello", {
        protocol: PROTOCOL_VERSION,
        client: { name: "agentlink-pi", version: CLIENT_VERSION },
        deviceId: this.opts.credentials.deviceId,
        deviceToken: this.opts.credentials.deviceToken,
        ...(this.opts.name ? { name: this.opts.name } : {}),
        ...(this.credential ? { credential: this.credential } : {}),
      }, 15_000).then((id) => {
        if (this.ws !== ws) return;
        this.identity = id;
        this.credential = id.credential;
        this.attempt = 0;
        this.startHeartbeat();
        this.onIdentity(id);
        this.setState("online");
        if (this.activity === "busy") this.fire("activity", { activity: "busy" });
      }).catch((error: AgentLinkError) => {
        if (this.ws !== ws) return;
        this.lastError = error;
        if (FATAL.has(error.code)) { this.setState("blocked", error); ws.close(1000); this.ws = null; }
        else ws.terminate();
      });
    });

    ws.on("message", (raw) => {
      this.lastRx = Date.now();
      let f: any;
      try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.id && this.pending.has(f.id)) {
        const p = this.pending.get(f.id)!;
        this.pending.delete(f.id);
        clearTimeout(p.timer);
        if (f.type === "error") p.reject(new AgentLinkError(f.payload?.code ?? "error", f.payload?.message ?? "Server error", f.payload?.retryAfterMs));
        else p.resolve(f.payload);
        return;
      }
      if (f.type === "message") return this.receive(f.payload as WireMessage);
      if (f.type === "revoked") { this.lastError = new AgentLinkError("revoked", `Disconnected by server: ${f.payload?.reason ?? "revoked"}`); return; }
      if (f.type === "replaced") { this.lastError = new AgentLinkError("replaced", "This agent identity was taken over by another connection"); return; }
      this.onEvent(f.type, f.payload);
    });

    ws.on("close", (code) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.teardown(new AgentLinkError("disconnected", "Connection lost"));
      if (this.state === "stopped" || this.state === "blocked") return;
      if (code === 4003 || code === 4002 || (code === 4001 && this.lastError && FATAL.has(this.lastError.code))) {
        this.setState("blocked", this.lastError ?? new AgentLinkError("revoked", "Disconnected by server"));
        return;
      }
      this.scheduleRetry();
    });
    ws.on("error", () => undefined);
  }

  private receive(m: WireMessage): void {
    const already = this.seen.has(m.messageId);
    this.seen.set(m.messageId, Date.now());
    if (this.seen.size > 5000) {
      const cutoff = Date.now() - 3600_000;
      for (const [k, t] of this.seen) if (t < cutoff || this.seen.size > 4000) this.seen.delete(k); else break;
    }
    if (already) { this.ack([m.messageId]); return; }
    this.onMessage(m);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const base = this.lastError?.retryAfterMs ?? this.backoff[Math.min(this.attempt, this.backoff.length - 1)];
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.attempt++;
    this.setState("reconnecting", this.lastError);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.state === "reconnecting") this.connect(); }, delay);
  }

  private startHeartbeat(): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    const idle = this.opts.heartbeatIdleMs ?? 20_000;
    this.hbTimer = setInterval(() => {
      if (Date.now() - this.lastRx < idle) return;
      const ws = this.ws;
      this.rawRequest("ping", undefined, 10_000).catch(() => { if (this.ws === ws) ws?.terminate(); });
    }, Math.min(5_000, idle / 2));
  }

  private teardown(err: Error): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  private fire(type: string, payload: unknown): void {
    // Server frames are ordered, so anything we send in response to a pushed message
    // arrives after our hello was accepted, even if our hello promise has not resolved yet.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, payload }));
  }

  private rawRequest<T>(type: string, payload: unknown, timeoutMs: number): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new AgentLinkError("disconnected", "Not connected"));
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentLinkError("timeout", `Request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, type });
      ws.send(JSON.stringify({ type, id, payload }));
    });
  }
}

const FATAL = new Set(["unauthorized", "revoked", "account_disabled", "invalid_name", "name_taken", "name_in_use", "protocol_unsupported", "agent_limit", "replaced"]);
