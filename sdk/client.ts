/**
 * AgentLink client SDK. Used by the pi extension, the MCP bridge and the CLI.
 * Transports: WebSocket (default) with automatic fallback to HTTP long-poll when WebSockets are blocked.
 * Honors HTTPS_PROXY / HTTP_PROXY / NO_PROXY for both transports.
 */
import WebSocket from "ws";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { HttpsProxyAgent } from "https-proxy-agent";

export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "2.0.0";

export type DeliverAs = "steer" | "followUp";
export type AttachmentRef = { attachmentId: string; fileCode: string; fileName: string; byteSize: number; sha256: string };
export type WireMessage = {
  messageId: string;
  seq: number;
  episodeId: string;
  replyTo?: string;
  from: { agentId: string; name: string; deviceName?: string; account?: string; external?: boolean };
  text: string;
  deliverAs: DeliverAs;
  attachments: AttachmentRef[];
  sentAt: number;
};
export type Profile = { description?: string; capabilities?: string[]; framework?: string; project?: string; host?: string };
export type Identity = {
  agentId: string; name: string; persistent: boolean; credential: string; profile: Profile;
  account: { id: string; name: string; email: string | null }; device: { id: string; name: string };
};
export type AgentInfo = Profile & {
  agentId: string; name: string; deviceName?: string; account?: string; external?: boolean; persistent?: boolean;
  online: boolean; activity: "busy" | "idle" | "offline"; via?: "ws" | "http" | "webhook";
};
export type AgentList = { self: AgentInfo; same: AgentInfo[]; paired: AgentInfo[] };
export type SendResult = { messageId: string; status: "delivered" | "queued"; recipient: { agentId: string; name: string; persistent: boolean; activity: string; via?: string }; expiresAt: number };
export type ConnState = "idle" | "connecting" | "online" | "reconnecting" | "stopped" | "blocked";
export type Transport = "auto" | "ws" | "http";

export class AgentLinkError extends Error {
  constructor(readonly code: string, message: string, readonly retryAfterMs?: number) { super(message); }
}

// ---------------------------------------------------------------- networking (proxy aware)

const hasProxyEnv = () => !!(process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY);
let dispatcher: EnvHttpProxyAgent | undefined;

export function httpFetch(url: string | URL, init: any = {}): Promise<Response> {
  if (hasProxyEnv()) {
    dispatcher ??= new EnvHttpProxyAgent();
    return undiciFetch(url, { ...init, dispatcher }) as unknown as Promise<Response>;
  }
  return fetch(url, init);
}

function bypassProxy(host: string): boolean {
  const np = (process.env.NO_PROXY || process.env.no_proxy || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const h = host.toLowerCase();
  return np.some((p) => p === "*" || h === p.replace(/^\./, "") || h.endsWith(p.startsWith(".") ? p : `.${p}`));
}

function wsAgent(url: URL): HttpsProxyAgent<string> | undefined {
  const proxy = url.protocol === "wss:"
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY
    : process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY;
  if (!proxy || bypassProxy(url.hostname)) return undefined;
  return new HttpsProxyAgent(proxy);
}

// ---------------------------------------------------------------- credentials

export type Credentials = { serverUrl: string; deviceId: string; deviceToken: string; accountName?: string; email?: string | null; deviceName?: string };

export function configDir(): string {
  if (process.env.AGENTLINK_CONFIG_DIR) return process.env.AGENTLINK_CONFIG_DIR;
  if (process.platform === "win32" && process.env.APPDATA) return path.join(process.env.APPDATA, "agentlink");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agentlink");
}

/** Credentials come from AGENTLINK_SERVER/AGENTLINK_DEVICE_ID/AGENTLINK_DEVICE_TOKEN (containers, CI) or the config file. */
export function readCredentials(): Credentials | null {
  const e = process.env;
  if (e.AGENTLINK_SERVER && e.AGENTLINK_DEVICE_ID && e.AGENTLINK_DEVICE_TOKEN) {
    return { serverUrl: e.AGENTLINK_SERVER.replace(/\/+$/, ""), deviceId: e.AGENTLINK_DEVICE_ID, deviceToken: e.AGENTLINK_DEVICE_TOKEN };
  }
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

const normUrl = (u: string) => {
  const s = u.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
};

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<any> {
  return parse(await httpFetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
}

const toCreds = (serverUrl: string, b: any): Credentials => ({
  serverUrl, deviceId: b.device.id, deviceToken: b.deviceToken, accountName: b.account.name, email: b.account.email, deviceName: b.device.name,
});

export async function serverInfo(serverUrl: string): Promise<{ version: string; signup: "email" | "invite" | "open"; emailDelivery: string; emailDomains: string[]; quotas: any }> {
  return parse(await httpFetch(new URL("/v1/info", normUrl(serverUrl))));
}

/** Email sign-in step 1: the server emails a 6-digit code. Works for new and existing accounts. */
export async function startEmailLogin(serverUrl: string, email: string): Promise<{ email: string; newAccount: boolean; expiresInSec: number; delivery: string }> {
  return postJson(new URL("/v1/auth/email/start", normUrl(serverUrl)).toString(), { email });
}

/** Email sign-in step 2: verify the code and enroll this device. */
export async function verifyEmailLogin(serverUrl: string, email: string, code: string, deviceName: string): Promise<Credentials & { created: boolean }> {
  const base = normUrl(serverUrl);
  const b = await postJson(new URL("/v1/auth/email/verify", base).toString(), { email, code, deviceName });
  return { ...toCreds(base, b), created: !!b.created };
}

export async function enroll(serverUrl: string, code: string, deviceName: string): Promise<Credentials> {
  const base = normUrl(serverUrl);
  return toCreds(base, await postJson(new URL("/v1/enroll", base).toString(), { code, deviceName }));
}

export async function signup(serverUrl: string, accountName: string, deviceName: string): Promise<Credentials> {
  const base = normUrl(serverUrl);
  return toCreds(base, await postJson(new URL("/v1/signup", base).toString(), { accountName, deviceName }));
}

export class Rest {
  constructor(private c: Credentials, private agentAuth?: { agentId: string; credential: string }) {}
  withAgent(agentId: string, credential: string): Rest { return new Rest(this.c, { agentId, credential }); }
  private auth() {
    return { authorization: this.agentAuth ? `Agent ${this.agentAuth.agentId}:${this.agentAuth.credential}` : `Device ${this.c.deviceId}:${this.c.deviceToken}` };
  }
  private url(p: string) { return new URL(p, this.c.serverUrl); }
  async get(p: string, signal?: AbortSignal) { return parse(await httpFetch(this.url(p), { headers: this.auth(), signal })); }
  async post(p: string, body?: unknown) { return parse(await httpFetch(this.url(p), { method: "POST", headers: { ...this.auth(), "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })); }
  async put(p: string, body?: unknown) { return parse(await httpFetch(this.url(p), { method: "PUT", headers: { ...this.auth(), "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })); }
  async del(p: string) { return parse(await httpFetch(this.url(p), { method: "DELETE", headers: this.auth() })); }

  async upload(filePath: string): Promise<AttachmentRef> {
    const st = await fsp.stat(filePath);
    if (!st.isFile()) throw new AgentLinkError("not_a_file", `Not a regular file: ${filePath}`);
    const res = await httpFetch(this.url("/v1/attachments"), {
      method: "POST",
      headers: { ...this.auth(), "content-length": String(st.size), "x-file-name": encodeURIComponent(path.basename(filePath)), "content-type": "application/octet-stream" },
      body: Readable.toWeb(fs.createReadStream(filePath)) as any,
      duplex: "half",
    });
    const b = await parse(res);
    return { attachmentId: b.attachmentId, fileCode: b.fileCode, fileName: b.fileName, byteSize: b.byteSize, sha256: b.sha256 };
  }

  /** Download to a directory or explicit file path; verifies sha256; never overwrites. */
  async download(fileCode: string, target: string): Promise<{ path: string; bytes: number; sha256: string }> {
    const res = await httpFetch(this.url(`/v1/attachments/${encodeURIComponent(fileCode)}`), { headers: this.auth() });
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

// ---------------------------------------------------------------- live client

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export type ClientOptions = {
  credentials: Credentials;
  /** Persistent agent name. Omit for an ephemeral, auto-named agent. */
  name?: string;
  /** Credential from a previous session; resumes the same identity. */
  credential?: string;
  /** Self-description others see when discovering agents. */
  profile?: Profile;
  /** auto (default): WebSocket, falling back to HTTP long-poll if WebSockets fail. */
  transport?: Transport;
  backoffMs?: number[];
  heartbeatIdleMs?: number;
  requestTimeoutMs?: number;
  pollWaitSec?: number;
};

const FATAL = new Set(["unauthorized", "revoked", "account_disabled", "invalid_name", "name_taken", "name_in_use", "protocol_unsupported", "agent_limit", "replaced", "agent_required"]);

/**
 * Self-healing agent connection. start() keeps reconnecting with jittered backoff until stop()
 * or a non-retryable error (revoked device, name conflict, ...). Delivery is at-least-once;
 * the client de-duplicates by messageId and the caller must ack() after handling a message.
 */
export class AgentLinkClient {
  identity?: Identity;
  state: ConnState = "idle";
  lastError?: AgentLinkError;
  /** Transport currently in use. */
  mode: "ws" | "http" = "ws";

  onMessage: (m: WireMessage) => void = () => {};
  onState: (s: ConnState, err?: AgentLinkError) => void = () => {};
  onIdentity: (id: Identity) => void = () => {};
  onEvent: (type: string, payload: any) => void = () => {};

  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<string, Pending>();
  private attempt = 0;
  private wsFailures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastRx = 0;
  private seen = new Map<string, number>();
  private activity: "busy" | "idle" = "idle";
  private waiters: { resolve: () => void; reject: (e: Error) => void }[] = [];
  private credential?: string;
  private profile?: Profile;
  private readonly backoff: number[];
  private pollAbort: AbortController | null = null;
  private gen = 0;

  constructor(private opts: ClientOptions) {
    this.credential = opts.credential;
    this.profile = opts.profile;
    this.backoff = opts.backoffMs ?? [1_000, 3_000, 5_000, 10_000, 20_000, 40_000, 60_000];
    this.mode = opts.transport === "http" ? "http" : "ws";
  }

  private rest(): Rest {
    const r = new Rest(this.opts.credentials);
    return this.identity ? r.withAgent(this.identity.agentId, this.identity.credential) : r;
  }

  /** REST client authenticated as this device (for attachments, devices, ...). */
  deviceRest(): Rest { return new Rest(this.opts.credentials); }

  start(): void {
    if (this.state !== "idle" && this.state !== "stopped" && this.state !== "blocked") return;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.gen++;
    this.setState("stopped");
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new AgentLinkError("stopped", "Client stopped"));
    this.ws?.close(1000, "client_stop");
    this.ws = null;
    this.pollAbort?.abort();
    this.pollAbort = null;
    for (const w of this.waiters.splice(0)) w.reject(new AgentLinkError("stopped", "Client stopped"));
  }

  ready(timeoutMs = 15_000): Promise<void> {
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
    if (this.state !== "online") return;
    if (this.mode === "ws") this.fire("activity", { activity: a });
    else void this.rest().post("/v1/agent/activity", { activity: a }).catch(() => undefined);
  }

  ack(messageIds: string[]): void {
    if (!messageIds.length) return;
    if (this.mode === "ws") this.fire("ack", { messageIds });
    else void this.rest().post("/v1/agent/ack", { messageIds }).catch(() => undefined);
  }

  // ---- operations (same API regardless of transport)

  async listAgents(capability?: string): Promise<AgentList> {
    await this.ready();
    if (this.mode === "ws") return this.rawRequest("list_agents", capability ? { capability } : {});
    return this.rest().get(`/v1/agent/agents${capability ? `?capability=${encodeURIComponent(capability)}` : ""}`);
  }

  async status(to: string): Promise<AgentInfo & { observedAt: number }> {
    await this.ready();
    if (this.mode === "ws") return this.rawRequest("agent_status", { to });
    return this.rest().get(`/v1/agent/status/${encodeURIComponent(to)}`);
  }

  async usage(): Promise<{ limit: number; used: number; remaining: number | null; periodEndsAt: number }> {
    await this.ready();
    if (this.mode === "ws") return this.rawRequest("usage");
    return (await this.rest().get("/v1/me")).usage;
  }

  async setProfile(profile: Profile): Promise<Profile> {
    this.profile = profile;
    await this.ready();
    const r = this.mode === "ws" ? await this.rawRequest<any>("set_profile", { profile }) : await this.rest().put("/v1/agent/profile", profile);
    return r.profile;
  }

  async createPairCode(): Promise<{ code: string; expiresAt: number }> {
    await this.ready();
    return this.mode === "ws" ? this.rawRequest("pair_create") : this.rest().post("/v1/agent/pair/create");
  }

  async acceptPairCode(code: string): Promise<{ agentId: string; name: string; account: string }> {
    await this.ready();
    return this.mode === "ws" ? this.rawRequest("pair_accept", { code }) : this.rest().post("/v1/agent/pair/accept", { code });
  }

  async unpair(agentId: string): Promise<{ removed: boolean }> {
    await this.ready();
    return this.mode === "ws" ? this.rawRequest("unpair", { agentId }) : this.rest().post("/v1/agent/unpair", { agentId });
  }

  /** Idempotent send: safe to retry across reconnects with the same key. */
  async send(to: string, text: string, opts: { deliverAs?: DeliverAs; attachments?: string[]; idempotencyKey?: string; replyTo?: string } = {}): Promise<SendResult> {
    const payload = { to, text, deliverAs: opts.deliverAs ?? "followUp", attachments: opts.attachments ?? [], idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(), ...(opts.replyTo ? { replyTo: opts.replyTo } : {}) };
    const once = async () => {
      await this.ready();
      return this.mode === "ws" ? this.rawRequest<SendResult>("send", payload) : this.rest().post("/v1/agent/send", payload);
    };
    try {
      return await once();
    } catch (error) {
      if (error instanceof AgentLinkError && !["timeout", "disconnected", "offline"].includes(error.code)) throw error;
      return await once();
    }
  }

  /** Low-level WS request (used by tests and advanced callers). */
  async request<T = any>(type: string, payload?: unknown): Promise<T> {
    await this.ready();
    return this.rawRequest<T>(type, payload);
  }

  // ---- internals

  private setState(s: ConnState, err?: AgentLinkError): void {
    this.state = s;
    if (err) this.lastError = err;
    this.onState(s, err);
    if (s === "online") for (const w of this.waiters.splice(0)) w.resolve();
    if (s === "blocked") for (const w of this.waiters.splice(0)) w.reject(err ?? new AgentLinkError("blocked", "blocked"));
  }

  private helloPayload() {
    return {
      protocol: PROTOCOL_VERSION,
      client: { name: "agentlink-sdk", version: CLIENT_VERSION },
      deviceId: this.opts.credentials.deviceId,
      deviceToken: this.opts.credentials.deviceToken,
      ...(this.opts.name ? { name: this.opts.name } : {}),
      ...(this.credential ? { credential: this.credential } : {}),
      ...(this.profile ? { profile: this.profile } : {}),
    };
  }

  private onOnline(id: Identity): void {
    this.identity = id;
    this.credential = id.credential;
    this.attempt = 0;
    this.onIdentity(id);
    this.setState("online");
    if (this.activity === "busy") this.setActivity("busy");
  }

  private connect(): void {
    this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    if (this.mode === "http") return void this.connectHttp();
    this.connectWs();
  }

  private connectWs(): void {
    const url = new URL("/v1/ws", this.opts.credentials.serverUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, { handshakeTimeout: 10_000, maxPayload: 4 * 1024 * 1024, agent: wsAgent(url) });
    this.ws = ws;
    let opened = false;

    ws.on("open", () => {
      opened = true;
      this.lastRx = Date.now();
      this.rawRequest<Identity>("hello", this.helloPayload(), 15_000).then((id) => {
        if (this.ws !== ws) return;
        this.wsFailures = 0;
        this.startHeartbeat();
        this.onOnline(id);
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
      if (!opened) {
        this.wsFailures++;
        // WebSockets look blocked (corporate proxy, serverless platform...): switch to HTTP long-poll.
        if (this.opts.transport !== "ws" && this.wsFailures >= 2) {
          this.mode = "http";
          this.lastError = new AgentLinkError("ws_blocked", "WebSocket unavailable; using HTTP long-poll");
        }
      }
      this.scheduleRetry();
    });
    ws.on("error", (e) => { if (!opened) this.lastError = new AgentLinkError("connect_failed", (e as Error).message); });
  }

  private async connectHttp(): Promise<void> {
    const gen = this.gen;
    try {
      const id = await parse(await httpFetch(new URL("/v1/agent/connect", this.opts.credentials.serverUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Device ${this.opts.credentials.deviceId}:${this.opts.credentials.deviceToken}` },
        body: JSON.stringify(this.helloPayload()),
        signal: AbortSignal.timeout(15_000),
      })) as Identity;
      if (gen !== this.gen) return;
      this.onOnline(id);
      void this.pollLoop(gen);
    } catch (error) {
      if (gen !== this.gen) return;
      const e = error instanceof AgentLinkError ? error : new AgentLinkError("connect_failed", (error as Error).message);
      this.lastError = e;
      if (FATAL.has(e.code)) return this.setState("blocked", e);
      this.scheduleRetry();
    }
  }

  private async pollLoop(gen: number): Promise<void> {
    const wait = this.opts.pollWaitSec ?? 25;
    while (gen === this.gen && this.state === "online") {
      this.pollAbort = new AbortController();
      const timer = setTimeout(() => this.pollAbort?.abort(), (wait + 15) * 1000);
      try {
        const r = await this.rest().get(`/v1/agent/messages?wait=${wait}`, this.pollAbort.signal);
        for (const m of r.messages as WireMessage[]) this.receive(m);
      } catch (error) {
        if (gen !== this.gen) return;
        const e = error instanceof AgentLinkError ? error : new AgentLinkError("disconnected", (error as Error).message);
        this.lastError = e;
        if (FATAL.has(e.code)) return this.setState("blocked", e);
        this.scheduleRetry();
        return;
      } finally {
        clearTimeout(timer);
      }
    }
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
    // Server frames are ordered, so a frame sent in reaction to a pushed message always
    // arrives after our hello was accepted, even before our hello promise resolves.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type, payload }));
  }

  private rawRequest<T>(type: string, payload?: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 10_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new AgentLinkError("disconnected", "Not connected"));
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AgentLinkError("timeout", `Request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type, id, payload }));
    });
  }
}

/** Verify a webhook delivery from an AgentLink server. */
export function verifyWebhook(secret: string, timestamp: string, body: string, signatureHeader: string, toleranceSec = 300): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
  const a = Buffer.from(expected), b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
