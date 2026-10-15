import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { startServer, type Server } from "../server/src/server.ts";
import type { Mailer } from "../server/src/mailer.ts";
import {
  AgentLinkClient, AgentLinkError, Rest, startEmailLogin, verifyEmailLogin, verifyWebhook, writeCredentials,
  type Credentials, type WireMessage,
} from "../sdk/client.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(10); }
}

class TestMailer implements Mailer {
  readonly kind = "test";
  sent: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) { this.sent.push({ to, subject, text }); }
  codeFor(email: string): string {
    const m = [...this.sent].reverse().find((x) => x.to === email);
    return /code is: (\d{6})/.exec(m?.text ?? "")?.[1] ?? "";
  }
}

let srv: Server;
let dir: string;
const mailer = new TestMailer();

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-interop-"));
  srv = await startServer({
    port: 0, host: "127.0.0.1", dataDir: dir, logLevel: "silent", mailer, webhooks: "private",
    limits: { httpBurst: 10_000, httpPerSec: 1000, helloBurst: 10_000, helloPerSec: 1000, emailPerIpPerHour: 1000, redeliverAfterMs: 1000 } as any,
  });
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email: string, device = "dev"): Promise<Credentials> {
  await startEmailLogin(srv.url, email);
  return verifyEmailLogin(srv.url, email, mailer.codeFor(email.toLowerCase()), device);
}

function live(creds: Credentials, name?: string, transport: "auto" | "ws" | "http" = "auto", profile?: any) {
  const c = new AgentLinkClient({ credentials: creds, name, transport, profile, backoffMs: [50, 100], pollWaitSec: 2 });
  const inbox: WireMessage[] = [];
  c.onMessage = (m) => { inbox.push(m); c.ack([m.messageId]); };
  return { c, inbox };
}

// ------------------------------------------------------------------ email sign-in

test("email sign-up creates an account; signing in again from another device joins the same account", async () => {
  const r = await startEmailLogin(srv.url, "Alice@Example.com");
  assert.equal(r.email, "alice@example.com");
  assert.equal(r.newAccount, true);
  const code = mailer.codeFor("alice@example.com");
  assert.match(code, /^\d{6}$/);
  assert.match(mailer.sent.at(-1)!.subject, /sign-in code/);

  const laptop = await verifyEmailLogin(srv.url, "alice@example.com", code, "laptop");
  assert.equal(laptop.created, true);
  assert.equal(laptop.email, "alice@example.com");

  // Code is single-use.
  await assert.rejects(verifyEmailLogin(srv.url, "alice@example.com", code, "x"), (e: AgentLinkError) => e.code === "invalid_code");

  // Second device: same email → same account, new device.
  await sleep(10);
  srv.store.db.run("UPDATE email_codes SET sent_at = 0 WHERE email = ?", "alice@example.com"); // skip the 60 s resend wait
  const r2 = await startEmailLogin(srv.url, "alice@example.com");
  assert.equal(r2.newAccount, false);
  const server = await verifyEmailLogin(srv.url, "alice@example.com", mailer.codeFor("alice@example.com"), "server");
  assert.equal(server.created, false);
  const devices = await new Rest(server).get("/v1/devices");
  assert.deepEqual(devices.devices.map((d: any) => d.name).sort(), ["laptop", "server"]);
});

test("email codes: wrong attempts are limited, resend is throttled, bad emails rejected", async () => {
  await startEmailLogin(srv.url, "bob@example.com");
  await assert.rejects(startEmailLogin(srv.url, "bob@example.com"), (e: AgentLinkError) => e.code === "too_soon");
  for (let i = 0; i < 5; i++) await assert.rejects(verifyEmailLogin(srv.url, "bob@example.com", "000000", "d"), (e: AgentLinkError) => e.code === "invalid_code");
  // Even the right code no longer works after 5 failures.
  await assert.rejects(verifyEmailLogin(srv.url, "bob@example.com", mailer.codeFor("bob@example.com"), "d"), (e: AgentLinkError) => e.code === "invalid_code");
  await assert.rejects(startEmailLogin(srv.url, "not-an-email"), (e: AgentLinkError) => e.code === "invalid_email");
});

test("invite-only servers and domain allowlists", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-invite-"));
  const m = new TestMailer();
  const s = await startServer({ port: 0, host: "127.0.0.1", dataDir: d, logLevel: "silent", mailer: m, signup: "invite", adminToken: "adm" });
  await assert.rejects(startEmailLogin(s.url, "stranger@example.com"), (e: AgentLinkError) => e.code === "signup_closed");
  await fetch(s.url + "/admin/accounts", { method: "POST", headers: { authorization: "Bearer adm" }, body: JSON.stringify({ email: "member@corp.com" }) });
  await startEmailLogin(s.url, "member@corp.com");
  const c = await verifyEmailLogin(s.url, "member@corp.com", m.codeFor("member@corp.com"), "d");
  assert.equal(c.created, false);
  await s.close();

  const s2 = await startServer({ port: 0, host: "127.0.0.1", dataDir: d + "-2", logLevel: "silent", mailer: m, emailDomains: ["corp.com"] });
  await assert.rejects(startEmailLogin(s2.url, "x@gmail.com"), (e: AgentLinkError) => e.code === "domain_not_allowed");
  await startEmailLogin(s2.url, "y@corp.com");
  await s2.close();
  fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(d + "-2", { recursive: true, force: true });
});

test("server info advertises signup mode and transports", async () => {
  const info = await (await fetch(srv.url + "/v1/info")).json() as any;
  assert.equal(info.signup, "email");
  assert.deepEqual(info.transports, ["ws", "http-longpoll", "webhook"]);
  assert.equal(info.quotas.monthlyMessages, 0); // unlimited by default: free software, no paid tiers
});

// ------------------------------------------------------------------ transports interoperate

test("WebSocket agent and HTTP long-poll agent talk both ways, with profiles and capability discovery", async () => {
  const creds = await login("carol@example.com", "laptop");
  const ws = live(creds, "pi-laptop", "ws", { framework: "pi", description: "Works on the web repo", capabilities: ["repo:web"] });
  const hp = live(creds, "ci-runner", "http", { framework: "service", description: "Runs CI jobs", capabilities: ["ci", "gpu"] });
  ws.c.start(); hp.c.start();
  await Promise.all([ws.c.ready(), hp.c.ready()]);
  assert.equal(hp.c.mode, "http");

  const l = await ws.c.listAgents();
  const ci = l.same.find((a) => a.name === "ci-runner")!;
  assert.equal(ci.via, "http");
  assert.equal(ci.framework, "service");
  assert.deepEqual(ci.capabilities, ["ci", "gpu"]);
  assert.deepEqual((await ws.c.listAgents("gpu")).same.map((a) => a.name), ["ci-runner"]);
  assert.deepEqual((await hp.c.listAgents("repo:web")).same.map((a) => a.name), ["pi-laptop"]);
  assert.equal((await ws.c.listAgents("nothing-like-this")).same.length, 0);

  const sent = await ws.c.send("ci-runner", "run the test suite");
  assert.equal(sent.status, "delivered");
  await until(() => hp.inbox.length === 1);
  assert.equal(hp.inbox[0].from.name, "pi-laptop");

  await hp.c.send("pi-laptop", "all green", { replyTo: hp.inbox[0].messageId });
  await until(() => ws.inbox.length === 1);
  assert.equal(ws.inbox[0].replyTo, hp.inbox[0].messageId);

  hp.c.setActivity("busy");
  await sleep(100);
  assert.equal((await ws.c.status("ci-runner")).activity, "busy");
  ws.c.stop(); hp.c.stop();
});

test("HTTP agents: unacked long-poll messages are redelivered; agent credentials are scoped", async () => {
  const creds = await login("dave@example.com");
  const sender = live(creds, "sender", "ws");
  sender.c.start(); await sender.c.ready();
  // Register the receiver once over HTTP, then poll manually without acking.
  const id = await new Rest(creds).post("/v1/agent/connect", { name: "poller" });
  const agentRest = new Rest(creds).withAgent(id.agentId, id.credential);
  await sender.c.send("poller", "please ack me");
  const first = await agentRest.get("/v1/agent/messages?wait=1");
  assert.equal(first.messages.length, 1);
  const again = await agentRest.get("/v1/agent/messages?wait=0");
  assert.equal(again.messages.length, 0); // leased
  await sleep(1100); // redeliverAfterMs = 1000 in tests
  const redelivered = await agentRest.get("/v1/agent/messages?wait=0");
  assert.equal(redelivered.messages[0].messageId, first.messages[0].messageId);
  await agentRest.post("/v1/agent/ack", { messageIds: [first.messages[0].messageId] });
  await sleep(1100);
  assert.equal((await agentRest.get("/v1/agent/messages?wait=0")).messages.length, 0);

  // Agent credentials cannot be used for a different agent id.
  await assert.rejects(new Rest(creds).withAgent(id.agentId, "alpc_wrong").get("/v1/agent/agents"), (e: AgentLinkError) => e.code === "unauthorized");
  // Device credentials cannot call agent endpoints.
  await assert.rejects(new Rest(creds).get("/v1/agent/messages"), (e: AgentLinkError) => e.code === "agent_required");
  sender.c.stop();
});

test("long-poll wakes immediately when a message arrives", async () => {
  const creds = await login("erin@example.com");
  const id = await new Rest(creds).post("/v1/agent/connect", { name: "sleeper" });
  const r = new Rest(creds).withAgent(id.agentId, id.credential);
  const s = live(creds, "waker", "ws");
  s.c.start(); await s.c.ready();
  const t0 = Date.now();
  const p = r.get("/v1/agent/messages?wait=20");
  await sleep(200);
  await s.c.send("sleeper", "wake up");
  const res = await p;
  assert.equal(res.messages[0].text, "wake up");
  assert.ok(Date.now() - t0 < 3000, "long-poll should return as soon as the message arrives");
  s.c.stop();
});

test("auto transport falls back to HTTP long-poll when WebSockets are blocked (e.g. corporate proxy)", async () => {
  const creds = await login("frank@example.com");
  // A reverse proxy that forwards HTTP but refuses WebSocket upgrades.
  const target = new URL(srv.url);
  const proxy = http.createServer((req, res) => {
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  proxy.on("upgrade", (_req, socket) => socket.destroy());
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const via = { ...creds, serverUrl: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}` };

  const blocked = live(via, "behind-firewall", "auto");
  blocked.c.start();
  await blocked.c.ready(10_000);
  assert.equal(blocked.c.mode, "http");

  const direct = live(creds, "outside", "ws");
  direct.c.start(); await direct.c.ready();
  await direct.c.send("behind-firewall", "can you hear me?");
  await until(() => blocked.inbox.length === 1);
  await blocked.c.send("outside", "loud and clear");
  await until(() => direct.inbox.length === 1);
  blocked.c.stop(); direct.c.stop();
  proxy.closeAllConnections(); proxy.close();
});

test("clients work through an HTTP(S)_PROXY (forward proxy + CONNECT)", async () => {
  const creds = await login("gina@example.com");
  let forwarded = 0, tunnelled = 0;
  const proxy = http.createServer((req, res) => {
    forwarded++;
    const u = new URL(req.url!);
    const up = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  proxy.on("connect", (req, sock, head) => {
    tunnelled++;
    const [h, p] = req.url!.split(":");
    const up = net.connect(Number(p), h, () => { sock.write("HTTP/1.1 200 Connection Established\r\n\r\n"); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on("error", () => sock.destroy()); sock.on("error", () => up.destroy());
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`;
  const saved = { HTTP_PROXY: process.env.HTTP_PROXY, NO_PROXY: process.env.NO_PROXY };
  process.env.HTTP_PROXY = proxyUrl; process.env.NO_PROXY = "";
  try {
    const w = live(creds, "proxied-ws", "ws");
    w.c.start(); await w.c.ready();
    assert.ok(tunnelled >= 1, "WebSocket should tunnel through the proxy");
    const before = forwarded + tunnelled;
    const h = live(creds, "proxied-http", "http");
    h.c.start(); await h.c.ready();
    assert.ok(forwarded + tunnelled > before, "HTTP should go through the proxy");
    await w.c.send("proxied-http", "via proxy");
    await until(() => h.inbox.length === 1);
    w.c.stop(); h.c.stop();
  } finally {
    process.env.HTTP_PROXY = saved.HTTP_PROXY ?? ""; if (!saved.HTTP_PROXY) delete process.env.HTTP_PROXY;
    if (saved.NO_PROXY === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = saved.NO_PROXY;
    proxy.closeAllConnections(); proxy.close();
  }
});

// ------------------------------------------------------------------ webhooks (services that can't hold a connection)

test("webhook agents receive signed pushes, are retried on failure, and reply over HTTP", async () => {
  const creds = await login("hank@example.com");
  const id = await new Rest(creds).post("/v1/agent/connect", { name: "deploy-bot", profile: { framework: "service", capabilities: ["deploy"] } });
  const botRest = new Rest(creds).withAgent(id.agentId, id.credential);

  let fail = true;
  const got: any[] = [];
  let secret = "";
  const hook = http.createServer(async (req, res) => {
    let body = ""; for await (const c of req) body += c;
    const ok = verifyWebhook(secret, String(req.headers["x-agentlink-timestamp"]), body, String(req.headers["x-agentlink-signature"]));
    if (!ok) { res.writeHead(401).end(); return; }
    if (fail) { fail = false; res.writeHead(503).end(); return; }
    const payload = JSON.parse(body);
    got.push(...payload.messages);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ack: payload.messages.map((m: any) => m.messageId) }));
    for (const m of payload.messages) void botRest.post("/v1/agent/send", { to: m.from.name, text: `deployed: ${m.text}`, replyTo: m.messageId });
  });
  await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
  const wh = await botRest.put("/v1/agent/webhook", { url: `http://127.0.0.1:${(hook.address() as net.AddressInfo).port}/agentlink` });
  secret = wh.webhook.secret;
  assert.match(secret, /^whsec_/);

  const dev = live(creds, "dev", "ws");
  dev.c.start(); await dev.c.ready();
  const st = await dev.c.status("deploy-bot");
  assert.equal(st.via, "webhook");
  const r = await dev.c.send("deploy-bot", "v1.2.3");
  assert.equal(r.status, "delivered");
  // First push gets 503; the hub retries with backoff (5 s), driven by tick(). Speed it up for the test.
  await sleep(100);
  srv.store.db.run("UPDATE agents SET webhook_next_at = 0 WHERE id = ?", id.agentId);
  srv.hub.tick();
  await until(() => got.length === 1, 5000);
  assert.equal(got[0].text, "v1.2.3");
  await until(() => dev.inbox.length === 1);
  assert.equal(dev.inbox[0].text, "deployed: v1.2.3");
  assert.equal(dev.inbox[0].replyTo, r.messageId);
  dev.c.stop();
  hook.closeAllConnections(); hook.close();
});

test("public webhook mode rejects private addresses (SSRF protection)", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-ssrf-"));
  const m = new TestMailer();
  const s = await startServer({ port: 0, host: "127.0.0.1", dataDir: d, logLevel: "silent", mailer: m });
  await startEmailLogin(s.url, "ssrf@example.com");
  const creds = await verifyEmailLogin(s.url, "ssrf@example.com", m.codeFor("ssrf@example.com"), "d");
  const id = await new Rest(creds).post("/v1/agent/connect", { name: "hooky" });
  const r = new Rest(creds).withAgent(id.agentId, id.credential);
  for (const url of ["http://example.com/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://169.254.169.254/latest"]) {
    await assert.rejects(r.put("/v1/agent/webhook", { url }), (e: AgentLinkError) => e.code === "invalid_url", url);
  }
  await s.close();
  fs.rmSync(d, { recursive: true, force: true });
});

// ------------------------------------------------------------------ MCP bridge + CLI (Claude Code, Codex, Cursor, scripts)

function spawnCli(args: string[], cfgDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", path.join(ROOT, "cli/main.ts"), ...args], {
    env: { ...process.env, AGENTLINK_CONFIG_DIR: cfgDir }, stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
}

test("MCP bridge: initialize, list tools, discover, send, receive via inbox wait", async () => {
  const creds = await login("ivy@example.com", "workstation");
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-mcp-"));
  process.env.AGENTLINK_CONFIG_DIR = cfg; writeCredentials(creds); delete process.env.AGENTLINK_CONFIG_DIR;

  const pi = live(creds, "pi-agent", "ws", { framework: "pi" });
  pi.c.start(); await pi.c.ready();

  const mcp = spawnCli(["mcp", "--name", "claude-code", "--framework", "claude-code", "--describe", "Claude Code in the api repo", "--cap", "repo:api"], cfg);
  let buf = "";
  const responses = new Map<number, any>();
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) { const j = JSON.parse(line); if (j.id !== undefined) responses.set(j.id, j); } }
  });
  let stderr = ""; mcp.stderr.on("data", (d) => { stderr += d; });
  let nextId = 1;
  const rpc = async (method: string, params?: unknown) => {
    const id = nextId++;
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    await until(() => responses.has(id), 20_000);
    return responses.get(id);
  };
  const call = async (name: string, args: unknown = {}) => (await rpc("tools/call", { name, arguments: args })).result;

  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(init.result.serverInfo.name, "agentlink");
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await rpc("tools/list")).result.tools.map((t: any) => t.name);
    assert.deepEqual(tools.sort(), ["agentlink_agents", "agentlink_download", "agentlink_inbox", "agentlink_send", "agentlink_set_profile", "agentlink_status"]);

    await until(() => stderr.includes("online as"), 15_000);
    const agents = await call("agentlink_agents");
    assert.match(agents.content[0].text, /pi-agent/);

    // pi sees the MCP agent with its framework and capability.
    const fromPi = (await pi.c.listAgents("repo:api")).same;
    assert.equal(fromPi[0].name, "claude-code");
    assert.equal(fromPi[0].framework, "claude-code");

    // MCP → pi
    const s = await call("agentlink_send", { to: "pi-agent", message: "hello from claude code" });
    assert.match(s.content[0].text, /Delivered/);
    await until(() => pi.inbox.length === 1);
    assert.equal(pi.inbox[0].from.name, "claude-code");

    // pi → MCP, picked up by a waiting inbox call.
    const waiting = call("agentlink_inbox", { wait_seconds: 15 });
    await sleep(300);
    await pi.c.send("claude-code", "hi back from pi");
    const inbox = await waiting;
    assert.match(inbox.content[0].text, /hi back from pi/);
    assert.match(inbox.content[0].text, /not from the user/);

    // Unread hint on other tool results.
    await pi.c.send("claude-code", "another one");
    await sleep(300);
    const st = await call("agentlink_status", { to: "pi-agent" });
    assert.match(st.content[0].text, /1 unread AgentLink message/);

    const unknown = await call("agentlink_send", { to: "nobody-here", message: "x" });
    assert.equal(unknown.isError, true);
  } finally {
    mcp.kill(); pi.c.stop();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test("CLI: send --wait gets a reply from `listen --exec` (any script becomes an agent)", async () => {
  const creds = await login("jack@example.com", "box");
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-cli-"));
  process.env.AGENTLINK_CONFIG_DIR = cfg; writeCredentials(creds); delete process.env.AGENTLINK_CONFIG_DIR;
  const handler = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const m=JSON.parse(s);console.log('echo: '+m.text.toUpperCase()+' from '+process.env.AGENTLINK_FROM)})"`;
  const listener = spawnCli(["listen", "--name", "echo-bot", "--exec", handler, "--describe", "Echoes text"], cfg);
  let lerr = ""; listener.stderr.on("data", (d) => { lerr += d; });
  try {
    await until(() => lerr.includes("listening as"), 15_000);
    const sender = spawnCli(["send", "echo-bot", "ping", "pong", "--wait", "20", "--name", "cli-user"], cfg);
    let out = ""; sender.stdout.on("data", (d) => { out += d; });
    const code = await new Promise<number>((r) => sender.on("close", (c) => r(c ?? 1)));
    assert.equal(code, 0, out);
    assert.match(out, /echo: PING PONG from cli-user/);

    const ag = spawnCli(["agents", "--json", "--name", "cli-user"], cfg);
    let aout = ""; ag.stdout.on("data", (d) => { aout += d; });
    await new Promise((r) => ag.on("close", r));
    const parsed = JSON.parse(aout);
    assert.equal(parsed.same.find((a: any) => a.name === "echo-bot").description, "Echoes text");
  } finally {
    listener.kill();
    fs.rmSync(cfg, { recursive: true, force: true });
  }
});

test("headless credentials from environment variables", async () => {
  const creds = await login("kim@example.com", "container");
  const env = { ...process.env, AGENTLINK_SERVER: creds.serverUrl, AGENTLINK_DEVICE_ID: creds.deviceId, AGENTLINK_DEVICE_TOKEN: creds.deviceToken, AGENTLINK_CONFIG_DIR: "/nonexistent" };
  const p = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", path.join(ROOT, "cli/main.ts"), "status"], { env });
  let out = ""; p.stdout.on("data", (d) => { out += d; });
  const code = await new Promise<number>((r) => p.on("close", (c) => r(c ?? 1)));
  assert.equal(code, 0);
  assert.match(out, /kim@example.com/);
});

test("CLI cross-account pairing: pair-code while the agent is online elsewhere, pair, then send by id", async () => {
  const a = await login("pair-a@qq.com", "a-dev"), b = await login("pair-b@163.com", "b-dev");
  const cfgA = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-pa-")), cfgB = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-pb-"));
  process.env.AGENTLINK_CONFIG_DIR = cfgA; writeCredentials(a);
  process.env.AGENTLINK_CONFIG_DIR = cfgB; writeCredentials(b); delete process.env.AGENTLINK_CONFIG_DIR;
  const run = (args: string[], cfg: string) => new Promise<{ code: number; out: string }>((resolve) => {
    const p = spawnCli(args, cfg); let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
  const listener = spawnCli(["listen", "--name", "b-echo", "--exec", "cat"], cfgB);
  let lerr = ""; listener.stderr.on("data", (d) => { lerr += d; });
  try {
    await until(() => lerr.includes("listening as"), 15_000);
    const pc = await run(["pair-code", "--name", "b-echo"], cfgB);
    assert.equal(pc.code, 0, pc.out);
    const code = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(pc.out)![1];
    const pr = await run(["pair", code, "--name", "a-user"], cfgA);
    assert.equal(pr.code, 0, pr.out);
    const id = /(ag_[\w-]+)/.exec(pr.out)![1];
    const s = await run(["send", id, "cross-account hello", "--name", "a-user", "--wait", "20"], cfgA);
    assert.equal(s.code, 0, s.out);
    assert.match(s.out, /cross-account hello/);
    const s2 = await run(["send", id, "again", "--name", "a-user", "--wait", "20"], cfgA); // same named agent reused
    assert.equal(s2.code, 0, s2.out);
  } finally {
    listener.kill();
    fs.rmSync(cfgA, { recursive: true, force: true }); fs.rmSync(cfgB, { recursive: true, force: true });
  }
});
