import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { WebSocketServer } from "ws";
import { Db } from "./db.ts";
import { Store, ApiError, type Device, type Account } from "./store.ts";
import { Hub, PROTOCOL_VERSION } from "./hub.ts";
import { loadConfig, type Config } from "./config.ts";
import { Logger, Metrics, RateLimiter, safeEqual } from "./util.ts";

export const VERSION = "1.0.0";

export type Server = {
  url: string;
  port: number;
  store: Store;
  hub: Hub;
  metrics: Metrics;
  close(): Promise<void>;
};

export async function startServer(overrides: Partial<Config> = {}, env = process.env): Promise<Server> {
  const cfg = loadConfig(env, overrides);
  const log = new Logger(cfg.logLevel);
  const metrics = new Metrics();
  fs.mkdirSync(path.join(cfg.dataDir, "blobs"), { recursive: true });
  const db = new Db(path.join(cfg.dataDir, "agentlink.db"));
  const store = new Store(db, cfg);
  const hub = new Hub(store, cfg, log, metrics);
  const httpLimiter = new RateLimiter(cfg.limits.httpBurst, cfg.limits.httpPerSec);
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

  const readJson = async (req: http.IncomingMessage, max = 64 * 1024): Promise<any> => {
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

  const deviceAuth = (req: http.IncomingMessage): { device: Device; account: Account } => {
    const h = req.headers.authorization ?? "";
    const m = /^Device\s+([^:\s]+):(\S+)$/.exec(h);
    if (!m) throw new ApiError("unauthorized", "Use Authorization: Device <deviceId>:<token>", 401);
    return store.authDevice(m[1], m[2]);
  };

  const adminAuth = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? "";
    if (!cfg.adminToken || !h.startsWith("Bearer ") || !safeEqual(h.slice(7), cfg.adminToken)) throw new ApiError("unauthorized", "Admin token required", 401);
  };

  type Handler = (req: http.IncomingMessage, res: http.ServerResponse, params: string[]) => Promise<void> | void;
  const routes: { method: string; re: RegExp; fn: Handler }[] = [];
  const route = (method: string, pattern: string, fn: Handler) => {
    routes.push({ method, re: new RegExp("^" + pattern.replace(/:[a-z]+/gi, "([^/]+)") + "$"), fn });
  };

  // ---------- public ----------
  route("GET", "/healthz", (_q, res) => {
    db.get("SELECT 1");
    json(res, 200, { ok: true, version: VERSION, protocol: PROTOCOL_VERSION });
  });

  route("GET", "/metrics", (req, res) => {
    if (cfg.metricsToken) {
      const h = req.headers.authorization ?? "";
      if (!h.startsWith("Bearer ") || !safeEqual(h.slice(7), cfg.metricsToken)) throw new ApiError("unauthorized", "Metrics token required", 401);
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(metrics.render());
  });

  route("POST", "/v1/signup", async (req, res) => {
    if (!cfg.openSignup) throw new ApiError("signup_closed", "Self-service signup is disabled on this server; ask an admin for an enrollment code", 403);
    const b = await readJson(req);
    const r = store.signup(String(b.accountName ?? ""), String(b.deviceName ?? "device"));
    json(res, 201, { ok: true, account: { id: r.account.id, name: r.account.name, plan: r.account.plan }, device: { id: r.device.id, name: r.device.name }, deviceToken: r.deviceToken });
  });

  route("POST", "/v1/enroll", async (req, res) => {
    const b = await readJson(req);
    const r = store.enroll(String(b.code ?? ""), String(b.deviceName ?? "device"));
    json(res, 201, { ok: true, account: { id: r.account.id, name: r.account.name, plan: r.account.plan }, device: { id: r.device.id, name: r.device.name }, deviceToken: r.deviceToken });
  });

  // ---------- device-authenticated ----------
  route("GET", "/v1/me", (req, res) => {
    const { device, account } = deviceAuth(req);
    json(res, 200, { ok: true, account: { id: account.id, name: account.name, plan: account.plan }, device: { id: device.id, name: device.name }, usage: store.usage(account), limits: store.plan(account), onlineAgents: hub.onlineCount(account.id) });
  });

  route("GET", "/v1/devices", (req, res) => {
    const { device, account } = deviceAuth(req);
    json(res, 200, { ok: true, devices: store.listDevices(account.id).map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastSeenAt: d.last_seen_at, current: d.id === device.id })) });
  });

  route("DELETE", "/v1/devices/:id", (req, res, [deviceId]) => {
    const { device, account } = deviceAuth(req);
    store.revokeDevice(account.id, deviceId, device.id);
    hub.disconnectDevice(deviceId, "revoked");
    json(res, 200, { ok: true });
  });

  route("POST", "/v1/enrollments", (req, res) => {
    const { device, account } = deviceAuth(req);
    json(res, 201, { ok: true, ...store.createEnrollment(account.id, device.id) });
  });

  route("DELETE", "/v1/agents/:name", (req, res, [name]) => {
    const { device, account } = deviceAuth(req);
    store.forgetAgent(account.id, decodeURIComponent(name), device.id);
    json(res, 200, { ok: true });
  });

  route("POST", "/v1/attachments", async (req, res) => {
    const { device, account } = deviceAuth(req);
    const max = store.plan(account).maxAttachmentBytes;
    const declared = Number(req.headers["content-length"]);
    if (!Number.isFinite(declared) || declared <= 0) throw new ApiError("length_required", "Content-Length is required", 411);
    if (declared > max) throw new ApiError("too_large", `Attachment exceeds plan limit of ${max} bytes`, 413);
    const name = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
    const tmp = path.join(cfg.dataDir, "blobs", `.upload-${crypto.randomUUID()}`);
    const hash = crypto.createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new ApiError("too_large", `Attachment exceeds plan limit of ${max} bytes`, 413));
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
    const { device } = deviceAuth(req);
    const att = store.attachmentForDownload(device, decodeURIComponent(code));
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

  // ---------- admin ----------
  route("GET", "/admin/accounts", (req, res) => { adminAuth(req); json(res, 200, { ok: true, accounts: store.listAccounts() }); });

  route("POST", "/admin/accounts", async (req, res) => {
    adminAuth(req);
    const b = await readJson(req);
    const acc = store.createAccount(String(b.name ?? ""), b.plan ? String(b.plan) : "free");
    const enrollment = store.createEnrollment(acc.id, "admin", Number(b.enrollmentTtlSec) || 24 * 3600);
    json(res, 201, { ok: true, account: acc, enrollment });
  });

  route("PATCH", "/admin/accounts/:id", async (req, res, [accountId]) => {
    adminAuth(req);
    const b = await readJson(req);
    const acc = store.updateAccount(accountId, { plan: b.plan, disabled: b.disabled, name: b.name });
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

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (url.pathname !== "/healthz" && url.pathname !== "/metrics" && !httpLimiter.take(clientIp(req))) {
        throw new ApiError("rate_limited", "Too many requests", 429, { retryAfterMs: 2000 });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (m) { await r.fn(req, res, m.slice(1)); return; }
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.limits.maxFrameBytes });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/v1/ws") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, req, clientIp(req)));
  });

  const ticker = setInterval(() => {
    try { hub.tick(); } catch (e) { log.error("tick", { err: String(e) }); }
  }, 5_000);
  const sweeper = setInterval(() => {
    try {
      const { messages, attachments } = store.sweepExpired();
      for (const a of attachments) fs.rmSync(blobPath(a), { force: true });
      const agents = store.gcAgents(hub.isOnline);
      httpLimiter.sweep();
      if (messages || attachments.length || agents) log.info("sweep", { messages, attachments: attachments.length, agents });
    } catch (e) { log.error("sweep", { err: String(e) }); }
  }, 60_000);

  await new Promise<void>((resolve) => server.listen(cfg.port, cfg.host, resolve));
  const port = (server.address() as { port: number }).port;
  log.info("server.listening", { port, version: VERSION, dataDir: cfg.dataDir, openSignup: cfg.openSignup });
  if (!cfg.adminToken) log.warn("AGENTLINK_ADMIN_TOKEN is not set; admin API is disabled");

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
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      db.close();
    },
  };
}
