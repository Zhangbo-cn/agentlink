import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { WebSocketServer } from "ws";
import { Db } from "./db.ts";
import { Store, ApiError, type Device, type Account, type AgentRow } from "./store.ts";
import { Hub, PROTOCOL_VERSION } from "./hub.ts";
import { loadConfig, type Config } from "./config.ts";
import { createMailer, loginEmail, type Mailer } from "./mailer.ts";
import { Logger, Metrics, RateLimiter, safeEqual } from "./util.ts";

export const VERSION = "2.0.0";

export type Server = {
  url: string;
  port: number;
  store: Store;
  hub: Hub;
  metrics: Metrics;
  close(): Promise<void>;
};

export async function startServer(overrides: Partial<Config> & { mailer?: Mailer } = {}, env = process.env): Promise<Server> {
  const { mailer: mailerOverride, ...cfgOverrides } = overrides;
  const cfg = loadConfig(env, cfgOverrides);
  const log = new Logger(cfg.logLevel);
  const metrics = new Metrics();
  fs.mkdirSync(path.join(cfg.dataDir, "blobs"), { recursive: true });
  const db = new Db(path.join(cfg.dataDir, "agentlink.db"));
  const store = new Store(db, cfg);
  const hub = new Hub(store, cfg, log, metrics);
  const mailer = mailerOverride ?? createMailer(cfg, log);
  const httpLimiter = new RateLimiter(cfg.limits.httpBurst, cfg.limits.httpPerSec);
  const emailLimiter = new RateLimiter(cfg.limits.emailPerIpPerHour, cfg.limits.emailPerIpPerHour / 3600);
  const blobPath = (attId: string) => path.join(cfg.dataDir, "blobs", attId);

  const clientIp = (req: http.IncomingMessage): string => {
    if (cfg.trustProxy) {
      const xf = req.headers["x-forwarded-for"];
      if (typeof xf === "string" && xf) return xf.split(",")[0].trim();
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
    res.end(data);
  };

  const readJson = async (req: http.IncomingMessage, max = 128 * 1024): Promise<any> => {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > max) throw new ApiError("too_large", "Request body too large", 413);
      chunks.push(chunk as Buffer);
    }
    if (!size) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ApiError("invalid_json", "Body must be JSON"); }
  };

  /** Authorization: Device <id>:<token>  |  Agent <id>:<credential> (agents are scoped to their device+account) */
  const auth = (req: http.IncomingMessage): { device: Device; account: Account; agent?: AgentRow } => {
    const h = req.headers.authorization ?? "";
    let m = /^Device\s+([^:\s]+):(\S+)$/.exec(h);
    if (m) return store.authDevice(m[1], m[2]);
    m = /^Agent\s+([^:\s]+):(\S+)$/.exec(h);
    if (m) return store.authAgent(m[1], m[2]);
    throw new ApiError("unauthorized", "Use Authorization: Device <deviceId>:<token> or Agent <agentId>:<credential>", 401);
  };

  const agentAuth = (req: http.IncomingMessage) => {
    const a = auth(req);
    if (!a.agent) throw new ApiError("agent_required", "This endpoint needs Authorization: Agent <agentId>:<credential> (from POST /v1/agent/connect)", 401);
    return a as { device: Device; account: Account; agent: AgentRow };
  };

  const adminAuth = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    if (!cfg.adminToken || !h.startsWith("Bearer ") || !safeEqual(h.slice(7), cfg.adminToken)) throw new ApiError("unauthorized", "Admin token required", 401);
  };

  type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: string[], url: URL) => Promise<void> | void;
  const routes: { method: string; re: RegExp; fn: Handler }[] = [];
  const route = (method: string, pattern: string, fn: Handler) => {
    routes.push({ method, re: new RegExp("^" + pattern.replace(/:[a-z]+/gi, "([^/]+)") + "$"), fn });
  };
  const deviceOut = (r: { account: Account; device: Device; deviceToken: string }) => ({
    account: { id: r.account.id, name: r.account.name, email: r.account.email },
    device: { id: r.device.id, name: r.device.name },
    deviceToken: r.deviceToken,
  });

  // ---------------------------------------------------------------- public

  route("GET", "/healthz", (_q, res) => {
    db.get("SELECT 1");
    json(res, 200, { ok: true, version: VERSION, protocol: PROTOCOL_VERSION });
  });

  route("GET", "/v1/info", (_q, res) => {
    json(res, 200, {
      ok: true, version: VERSION, protocol: PROTOCOL_VERSION, signup: cfg.signup, emailDomains: cfg.emailDomains,
      emailDelivery: mailer.kind, webhooks: cfg.webhooks, quotas: cfg.quotas, transports: ["ws", "http-longpoll", "webhook"],
    });
  });

  route("GET", "/metrics", (req, res) => {
    if (cfg.metricsToken) {
      const h = req.headers.authorization ?? "";
      if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7), cfg.metricsToken)) throw new ApiError("unauthorized", "Metrics token required", 401);
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(metrics.render());
  });

  // Email sign-in / sign-up: step 1 sends a 6-digit code; step 2 verifies it and returns device credentials.
  route("POST", "/v1/auth/email/start", async (req, res) => {
    if (cfg.signup === "open" && !cfg.smtpUrl && !mailerOverride) log.warn("email sign-in used without SMTP; codes go to the log");
    const b = await readJson(req);
    if (!emailLimiter.take(clientIp(req))) throw new ApiError("rate_limited", "Too many sign-in emails from this address. Try again later.", 429, { retryAfterMs: 60_000 });
    const { email, code, isNew } = store.startEmailLogin(String(b.email ?? ""));
    const mail = loginEmail(code, cfg);
    try {
      await mailer.send(email, mail.subject, mail.text);
    } catch (error) {
      log.error("mail.send_failed", { email, err: String((error as Error)?.message ?? error) });
      throw new ApiError("mail_failed", "Could not send the email. Try again later.", 502);
    }
    metrics.inc("email_codes_sent");
    json(res, 200, { ok: true, email, newAccount: isNew, expiresInSec: 600, delivery: mailer.kind });
  });

  route("POST", "/v1/auth/email/verify", async (req, res) => {
    const b = await readJson(req);
    const r = store.verifyEmailLogin(String(b.email ?? ""), String(b.code ?? ""), String(b.deviceName ?? "device"));
    metrics.inc(r.created ? "accounts_created" : "email_logins");
    json(res, r.created ? 201 : 200, { ok: true, created: r.created, ...deviceOut(r) });
  });

  route("POST", "/v1/enroll", async (req, res) => {
    const b = await readJson(req);
    json(res, 201, { ok: true, ...deviceOut(store.enroll(String(b.code ?? ""), String(b.deviceName ?? "device"))) });
  });

  route("POST", "/v1/signup", async (req, res) => {
    const b = await readJson(req);
    json(res, 201, { ok: true, ...deviceOut(store.openSignup(String(b.accountName ?? ""), String(b.deviceName ?? "device"))) });
  });

  // ---------------------------------------------------------------- device-authenticated

  route("GET", "/v1/me", (req, res) => {
    const { device, account, agent } = auth(req);
    json(res, 200, {
      ok: true, account: { id: account.id, name: account.name, email: account.email }, device: { id: device.id, name: device.name },
      ...(agent ? { agent: { agentId: agent.id, name: agent.name } } : {}),
      usage: store.usage(account), quotas: store.quotas(account), onlineAgents: hub.onlineCount(account.id),
    });
  });

  route("GET", "/v1/devices", (req, res) => {
    const { device, account } = auth(req);
    json(res, 200, { ok: true, devices: store.listDevices(account.id).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, current: d.id === device.id })) });
  });

  route("DELETE", "/v1/devices/:id", (req, res, [deviceId]) => {
    const { device, account } = auth(req);
    store.revokeDevice(account.id, deviceId, device.id);
    hub.disconnectDevice(deviceId, "revoked");
    json(res, 200, { ok: true });
  });

  route("POST", "/v1/enrollments", (req, res) => {
    const { device, account } = auth(req);
    json(res, 201, { ok: true, ...store.createEnrollment(account.id, device.id) });
  });

  route("GET", "/v1/agents", (req, res) => {
    const { account } = auth(req);
    json(res, 200, { ok: true, agents: store.listAccountAgents(account.id).map((a) => hub.describe(a, account.id)) });
  });

  route("DELETE", "/v1/agents/:name", (req, res, [name]) => {
    const { device, account } = auth(req);
    store.forgetAgent(account.id, decodeURIComponent(name), device.id);
    json(res, 200, { ok: true });
  });

  // ---------------------------------------------------------------- agent HTTP API (MCP bridge, scripts, services)

  /** Claim or resume an agent identity over HTTP. Device-authenticated. */
  route("POST", "/v1/agent/connect", async (req, res) => {
    const { device, account } = auth(req);
    const b = await readJson(req);
    const { agent, credential } = hub.claim(device, account, b);
    hub.touchHttp(agent);
    log.info("agent.online", { agent: agent.id, name: agent.name, device: device.id, account: account.id, via: "http" });
    json(res, 200, { ok: true, ...hub.identity(agent, credential, device, account) });
  });

  route("GET", "/v1/agent/messages", async (req, res, _p, url) => {
    const { agent } = agentAuth(req);
    const wait = Math.max(0, Math.min(Number(url.searchParams.get("wait") ?? 0), 55)) * 1000;
    const ac = new AbortController();
    res.on("close", () => ac.abort());
    const messages = await hub.poll(agent, wait, ac.signal);
    if (!res.writableEnded && !res.destroyed) json(res, 200, { ok: true, messages });
  });

  route("POST", "/v1/agent/ack", async (req, res) => {
    const { agent } = agentAuth(req);
    const b = await readJson(req);
    json(res, 200, { ok: true, acked: hub.ack(agent, b.messageIds) });
  });

  route("POST", "/v1/agent/send", async (req, res) => {
    const { agent } = agentAuth(req);
    hub.touchHttp(agent);
    json(res, 200, { ok: true, ...hub.send(agent, await readJson(req)) });
  });

  route("GET", "/v1/agent/agents", (req, res, _p, url) => {
    const { agent } = agentAuth(req);
    hub.touchHttp(agent);
    json(res, 200, { ok: true, ...hub.listAgents(agent, url.searchParams.get("capability") ?? undefined) });
  });

  route("GET", "/v1/agent/status/:to", (req, res, [to]) => {
    const { agent } = agentAuth(req);
    json(res, 200, { ok: true, ...hub.status(agent, decodeURIComponent(to)) });
  });

  route("POST", "/v1/agent/activity", async (req, res) => {
    const { agent } = agentAuth(req);
    const b = await readJson(req);
    hub.touchHttp(agent, b.activity === "busy" ? "busy" : "idle");
    json(res, 200, { ok: true });
  });

  route("PUT", "/v1/agent/profile", async (req, res) => {
    const { agent } = agentAuth(req);
    json(res, 200, { ok: true, ...hub.setProfile(agent, await readJson(req)) });
  });

  route("PUT", "/v1/agent/webhook", async (req, res) => {
    const { agent } = agentAuth(req);
    const b = await readJson(req);
    if (b.url === null || b.url === "") {
      store.setWebhook(agent.id, null);
      return json(res, 200, { ok: true, webhook: null });
    }
    const url = await hub.validateWebhookUrl(String(b.url ?? ""));
    const secret = store.setWebhook(agent.id, url);
    hub.wake(agent.id);
    json(res, 200, { ok: true, webhook: { url, secret, signature: "x-agentlink-signature: sha256=HMAC(secret, `${x-agentlink-timestamp}.${body}`)" } });
  });

  route("POST", "/v1/agent/pair/create", (req, res) => {
    const { agent } = agentAuth(req);
    json(res, 200, { ok: true, ...hub.pairCreate(agent) });
  });

  route("POST", "/v1/agent/pair/accept", async (req, res) => {
    const { agent } = agentAuth(req);
    const b = await readJson(req);
    json(res, 200, { ok: true, ...hub.pairAccept(agent, String(b.code ?? "")) });
  });

  route("POST", "/v1/agent/unpair", async (req, res) => {
    const { agent } = agentAuth(req);
    const b = await readJson(req);
    json(res, 200, { ok: true, ...hub.unpair(agent, String(b.agentId ?? "")) });
  });

  // ---------------------------------------------------------------- attachments

  route("POST", "/v1/attachments", async (req, res) => {
    const { device, account } = auth(req);
    const max = store.quotas(account).maxAttachmentBytes;
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared <= 0) throw new ApiError("length_required", "Content-Length is required", 411);
    if (max > 0 && declared > max) throw new ApiError("too_large", `Attachment exceeds the limit of ${max} bytes`, 413);
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
    const tmp = path.join(cfg.dataDir, "blobs", `.upload-${crypto.randomUUID()}`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > declared || (max > 0 && size > max)) return cb(new ApiError("too_large", "Attachment larger than declared or allowed", 413));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, fs.createWriteStream(tmp, { mode: 0o600 }));
      if (size !== declared) throw new ApiError("length_mismatch", "Body length does not match Content-Length");
      const att = store.createAttachment(device, name, size, hash.digest("hex"));
      fs.renameSync(tmp, blobPath(att.id));
      metrics.inc("attachments_uploaded");
      metrics.inc("attachment_bytes_uploaded", size);
      json(res, 201, { ok: true, attachmentId: att.id, fileCode: att.file_code, fileName: att.name, byteSize: att.size, sha256: att.sha256 });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  route("GET", "/v1/attachments/:code", async (req, res, [code]) => {
    const { account } = auth(req);
    const att = store.attachmentForDownload(account.id, decodeURIComponent(code));
    const file = blobPath(att.id);
    if (!fs.existsSync(file)) throw new ApiError("not_found", "Attachment blob missing", 404);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": att.size,
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(att.name)}`,
      "x-sha256": att.sha256,
      "x-file-name": encodeURIComponent(att.name),
    });
    await pipeline(fs.createReadStream(file), res);
  });

  // ---------------------------------------------------------------- admin

  route("GET", "/admin/accounts", (req, res) => { adminAuth(req); json(res, 200, { ok: true, accounts: store.listAccounts() }); });

  route("POST", "/admin/accounts", async (req, res) => {
    adminAuth(req);
    const b = await readJson(req);
    const acc = store.createAccount(String(b.name ?? b.email ?? ""), b.email ? String(b.email) : undefined);
    const enrollment = store.createEnrollment(acc.id, "admin", Number(b.enrollmentTtlSec) || 24 * 3600);
    json(res, 201, { ok: true, account: acc, enrollment });
  });

  route("PATCH", "/admin/accounts/:id", async (req, res, [accountId]) => {
    adminAuth(req);
    const b = await readJson(req);
    const acc = store.updateAccount(accountId, { disabled: b.disabled, name: b.name, quotas: b.quotas });
    if (acc.disabled) hub.disconnectAccount(acc.id, "account_disabled");
    json(res, 200, { ok: true, account: acc });
  });

  route("POST", "/admin/accounts/:id/enrollments", async (req, res, [accountId]) => {
    adminAuth(req);
    const b = await readJson(req);
    json(res, 201, { ok: true, ...store.createEnrollment(accountId, "admin", Number(b.ttlSec) || 24 * 3600) });
  });

  route("GET", "/admin/accounts/:id/usage", (req, res, [accountId]) => {
    adminAuth(req);
    const acc = store.account(accountId);
    if (!acc) throw new ApiError("not_found", "Account not found", 404);
    json(res, 200, { ok: true, usage: store.usage(acc), devices: store.listDevices(acc.id), onlineAgents: hub.onlineCount(acc.id) });
  });

  // ---------------------------------------------------------------- server

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://x");
    try {
      const exempt = url.pathname === "/healthz" || url.pathname === "/metrics" || url.pathname === "/v1/agent/messages";
      if (!exempt && !httpLimiter.take(clientIp(req))) throw new ApiError("rate_limited", "Too many requests", 429, { retryAfterMs: 2000 });
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { await r.fn(req, res, m.slice(1), url); return; }
      }
      throw new ApiError("not_found", "Not found", 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      if (error instanceof ApiError) {
        json(res, error.status, { ok: false, code: error.code, message: error.message, ...error.extra });
      } else {
        log.error("http.error", { path: url.pathname, err: String((error as Error)?.stack ?? error) });
        json(res, 500, { ok: false, code: "internal", message: "Internal server error" });
      }
    } finally {
      metrics.inc("http_requests");
      log.debug("http", { method: req.method, path: url.pathname, status: res.statusCode, ms: Date.now() - started });
    }
  });
  server.requestTimeout = 120_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 65_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.limits.maxFrameBytes });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/v1/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, clientIp(req)));
  });

  const ticker = setInterval(() => {
    try { hub.tick(); } catch (e) { log.error("tick", { err: String(e) }); }
  }, 5_000);
  const sweeper = setInterval(() => {
    try {
      const { messages, attachments } = store.sweepExpired();
      for (const a of attachments) fs.rmSync(blobPath(a), { force: true });
      const agents = store.gcAgents(hub.isLive);
      httpLimiter.sweep(); emailLimiter.sweep();
      if (messages || attachments.length || agents) log.info("sweep", { messages, attachments: attachments.length, agents });
    } catch (e) { log.error("sweep", { err: String(e) }); }
  }, 60_000);

  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const port = (server.address() as { port: number }).port;
  log.info("server.listening", { port, version: VERSION, dataDir: cfg.dataDir, signup: cfg.signup, mail: mailer.kind, webhooks: cfg.webhooks });
  if (cfg.signup === "email" && mailer.kind === "log") log.warn("No AGENTLINK_SMTP_URL set: sign-in codes are written to this log instead of emailed");
  if (cfg.signup === "open") log.warn("AGENTLINK_SIGNUP=open: accounts can be created without email verification. Use only on trusted networks.");

  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port, store, hub, metrics,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(ticker); clearInterval(sweeper);
      hub.shutdown();
      for (const c of wss.clients) c.terminate();
      server.closeIdleConnections?.();
      await new Promise<void>((r) => { server.close(() => r()); setTimeout(() => { server.closeAllConnections?.(); }, 200).unref(); });
      db.close();
    },
  };
}
