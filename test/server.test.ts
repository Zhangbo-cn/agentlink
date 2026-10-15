import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type Server } from "../server/src/server.ts";
import { AgentLinkClient, Rest, enroll, AgentLinkError, type Credentials, type WireMessage } from "../sdk/client.ts";

const ADMIN = "admin-secret";
let srv: Server;
let dir: string;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error("timeout waiting for condition"); await sleep(10); }
}

async function admin(method: string, p: string, body?: unknown) {
  const r = await fetch(srv.url + p, { method, headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() as any };
}

const LIMITED = { monthlyMessages: 5, maxDevices: 2, maxOnlineAgents: 3, maxAttachmentBytes: 1024 };
async function newAccount(name: string, kind: "limited" | "default" = "default"): Promise<{ id: string; device: () => Promise<Credentials> }> {
  const r = await admin("POST", "/admin/accounts", { name });
  assert.equal(r.status, 201);
  if (kind === "limited") await admin("PATCH", `/admin/accounts/${r.body.account.id}`, { quotas: LIMITED });
  let first: string | undefined = r.body.enrollment.code;
  return {
    id: r.body.account.id,
    device: async () => {
      const code = first ?? (await admin("POST", `/admin/accounts/${r.body.account.id}/enrollments`, {})).body.code;
      first = undefined;
      return enroll(srv.url, code, `dev-${Math.random().toString(36).slice(2, 6)}`);
    },
  };
}

function client(creds: Credentials, name?: string, credential?: string) {
  const c = new AgentLinkClient({ credentials: creds, name, credential, backoffMs: [50, 100] });
  const inbox: WireMessage[] = [];
  c.onMessage = (m) => { inbox.push(m); c.ack([m.messageId]); };
  return { c, inbox };
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-test-"));
  srv = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, adminToken: ADMIN, logLevel: "silent", signup: "open", limits: { httpBurst: 10_000, httpPerSec: 1000, helloBurst: 10_000, helloPerSec: 1000 } as any,
    quotas: { monthlyMessages: 0, maxDevices: 10, maxOnlineAgents: 10, maxAttachmentBytes: 1024 * 1024, queueTtlSec: 3600 } });
});
after(async () => { await srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("health and admin auth", async () => {
  const h = await fetch(srv.url + "/healthz");
  assert.equal(h.status, 200);
  const r = await fetch(srv.url + "/admin/accounts", { headers: { authorization: "Bearer wrong" } });
  assert.equal(r.status, 401);
});

test("enrollment codes are single-use and device limit is enforced", async () => {
  const r = await admin("POST", "/admin/accounts", { name: "limits" });
  await admin("PATCH", `/admin/accounts/${r.body.account.id}`, { quotas: { maxDevices: 2 } });
  const code = r.body.enrollment.code;
  await enroll(srv.url, code.toLowerCase().replace("-", ""), "a"); // normalisation
  await assert.rejects(enroll(srv.url, code, "b"), (e: AgentLinkError) => e.code === "invalid_code");
  const code2 = (await admin("POST", `/admin/accounts/${r.body.account.id}/enrollments`, {})).body.code;
  await enroll(srv.url, code2, "b");
  const code3 = (await admin("POST", `/admin/accounts/${r.body.account.id}/enrollments`, {})).body.code;
  await assert.rejects(enroll(srv.url, code3, "c"), (e: AgentLinkError) => e.code === "device_limit");
});

test("same-account messaging, acks, presence and cross-account isolation", async () => {
  const acc = await newAccount("alice");
  const a = client(await acc.device(), "laptop");
  const b = client(await acc.device(), "server");
  const other = await newAccount("mallory");
  const m = client(await other.device());
  a.c.start(); b.c.start(); m.c.start();
  await Promise.all([a.c.ready(), b.c.ready(), m.c.ready()]);

  const list = await a.c.listAgents();
  assert.deepEqual(list.same.map((x) => x.name), ["server"]);
  assert.equal(list.same[0].activity, "idle");

  b.c.setActivity("busy");
  await sleep(30);
  assert.equal((await a.c.status("server")).activity, "busy");

  const r = await a.c.send("server", "please run tests", { deliverAs: "followUp" });
  assert.equal(r.status, "delivered");
  await until(() => b.inbox.length === 1);
  assert.equal(b.inbox[0].from.name, "laptop");
  assert.equal(b.inbox[0].text, "please run tests");

  // Mallory cannot address alice's agents by name or id.
  await assert.rejects(m.c.send("server", "hi"), (e: AgentLinkError) => e.code === "agent_unknown");
  await assert.rejects(m.c.send(b.c.identity!.agentId, "hi"), (e: AgentLinkError) => e.code === "agent_unknown");
  assert.equal((await m.c.listAgents()).same.length, 0);

  for (const x of [a, b, m]) x.c.stop();
});

test("idempotent send does not duplicate or double-charge", async () => {
  const acc = await newAccount("idem");
  const a = client(await acc.device(), "idem-a");
  const b = client(await acc.device(), "idem-b");
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);
  const r1 = await a.c.send("idem-b", "once", { idempotencyKey: "k-1" });
  const r2 = await a.c.send("idem-b", "once", { idempotencyKey: "k-1" });
  assert.equal(r1.messageId, r2.messageId);
  await sleep(100);
  assert.equal(b.inbox.length, 1);
  assert.equal((await a.c.usage()).used, 1);
  a.c.stop(); b.c.stop();
});

test("offline persistent agent receives queued messages in order after reconnect; unacked messages are redelivered", async () => {
  const acc = await newAccount("queue");
  const sender = client(await acc.device(), "sender");
  const devB = await acc.device();
  sender.c.start();
  await sender.c.ready();

  // Register "worker" once, then go offline.
  const w1 = client(devB, "worker");
  w1.c.start(); await w1.c.ready(); w1.c.stop();
  await sleep(50);

  const r = await sender.c.send("worker", "first");
  assert.equal(r.status, "queued");
  await sender.c.send("worker", "second");
  await sender.c.send("worker", "third", { deliverAs: "steer" });

  // Reconnect but do NOT ack: messages must come back on the next connection.
  const w2 = new AgentLinkClient({ credentials: devB, name: "worker", backoffMs: [50] });
  const got2: string[] = [];
  w2.onMessage = (m) => got2.push(m.text);
  w2.start(); await w2.ready();
  await until(() => got2.length === 3);
  assert.deepEqual(got2, ["first", "second", "third"]);
  w2.stop();
  await sleep(50);

  const w3 = client(devB, "worker");
  w3.c.start(); await w3.c.ready();
  await until(() => w3.inbox.length === 3);
  assert.deepEqual(w3.inbox.map((m) => m.text), ["first", "second", "third"]);
  assert.equal(w3.inbox[2].deliverAs, "steer");
  w3.c.stop();
  await sleep(50);

  // Acked: nothing on the next connect.
  const w4 = client(devB, "worker");
  w4.c.start(); await w4.c.ready();
  await sleep(150);
  assert.equal(w4.inbox.length, 0);
  w4.c.stop(); sender.c.stop();
});

test("persistent names are owned by their device", async () => {
  const acc = await newAccount("names");
  const d1 = await acc.device(), d2 = await acc.device();
  const a = client(d1, "builder");
  a.c.start(); await a.c.ready();
  const b = client(d2, "builder");
  b.c.start();
  await assert.rejects(b.c.ready(2000), (e: AgentLinkError) => e.code === "name_taken");
  assert.equal(b.c.state, "blocked");
  // Same device, same name, while online -> rejected, not silently stolen.
  const a2 = client(d1, "builder");
  a2.c.start();
  await assert.rejects(a2.c.ready(2000), (e: AgentLinkError) => e.code === "name_in_use");
  a.c.stop(); b.c.stop(); a2.c.stop();
});

test("ephemeral identity resumes with its credential across reconnects", async () => {
  const acc = await newAccount("resume");
  const d = await acc.device();
  const a = client(d);
  a.c.start(); await a.c.ready();
  const { agentId, name, credential } = a.c.identity!;
  a.c.stop();
  const b = client(d, undefined, credential);
  b.c.start(); await b.c.ready();
  assert.equal(b.c.identity!.agentId, agentId);
  assert.equal(b.c.identity!.name, name);
  b.c.stop();
});

test("client reconnects automatically after the socket drops", async () => {
  const acc = await newAccount("reconnect");
  const a = client(await acc.device(), "flaky");
  const b = client(await acc.device(), "steady");
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);
  const states: string[] = [];
  a.c.onState = (s) => states.push(s);
  (a.c as any).ws.terminate();
  await until(() => a.c.state === "online" && states.includes("reconnecting"));
  await b.c.send("flaky", "after reconnect");
  await until(() => a.inbox.some((m) => m.text === "after reconnect"));
  a.c.stop(); b.c.stop();
});

test("monthly quota", async () => {
  const acc = await newAccount("quota", "limited"); // 5 messages
  const a = client(await acc.device(), "q-a");
  const b = client(await acc.device(), "q-b");
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);
  for (let i = 0; i < 5; i++) await a.c.send("q-b", `m${i}`);
  await assert.rejects(a.c.send("q-b", "over"), (e: AgentLinkError) => e.code === "quota_exceeded");
  await admin("PATCH", `/admin/accounts/${acc.id}`, { quotas: null });
  await a.c.send("q-b", "after lifting the limit");
  a.c.stop(); b.c.stop();
});

test("cross-account pairing", async () => {
  const x = await newAccount("x-corp"), y = await newAccount("y-corp");
  const a = client(await x.device(), "x-agent");
  const b = client(await y.device(), "y-agent");
  const events: string[] = [];
  b.c.onEvent = (t) => events.push(t);
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);

  const { code } = await b.c.createPairCode();
  const peer = await a.c.acceptPairCode(code);
  assert.equal(peer.name, "y-agent");
  await until(() => events.includes("pair_added"));
  await assert.rejects(a.c.acceptPairCode(code), (e: AgentLinkError) => e.code === "invalid_code"); // single use

  // Name lookup is account-scoped; paired agents are addressed by id.
  await assert.rejects(a.c.send("y-agent", "hi"), (e: AgentLinkError) => e.code === "agent_unknown");
  await a.c.send(peer.agentId, "hello partner");
  await until(() => b.inbox.length === 1);
  assert.equal(b.inbox[0].from.external, true);
  assert.equal(b.inbox[0].from.account, "x-corp");
  assert.equal((await b.c.listAgents()).paired[0].agentId, a.c.identity!.agentId);

  await b.c.unpair(a.c.identity!.agentId);
  await assert.rejects(a.c.send(peer.agentId, "still there?"), (e: AgentLinkError) => e.code === "agent_unknown");
  a.c.stop(); b.c.stop();
});

test("attachments: upload, scoped download, checksum, size limit", async () => {
  const acc = await newAccount("files");
  const other = await newAccount("files-other");
  const da = await acc.device(), db = await acc.device(), dz = await other.device();
  const a = client(da, "file-a"), b = client(db, "file-b");
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);

  const src = path.join(dir, "report.txt");
  fs.writeFileSync(src, "hello attachment ".repeat(100));
  const ref = await new Rest(da).upload(src);
  await a.c.send("file-b", "see file", { attachments: [ref.attachmentId] });
  await until(() => b.inbox.length === 1);
  const fileCode = b.inbox[0].attachments[0].fileCode;

  const out = path.join(dir, "downloads");
  const r1 = await new Rest(db).download(fileCode, out + path.sep);
  assert.equal(fs.readFileSync(r1.path, "utf8"), fs.readFileSync(src, "utf8"));
  const r2 = await new Rest(db).download(fileCode, out + path.sep);
  assert.notEqual(r1.path, r2.path); // never overwrites

  await assert.rejects(new Rest(dz).download(fileCode, out + path.sep), (e: AgentLinkError) => e.code === "not_found");
  await assert.rejects(a.c.send("file-b", "reuse", { attachments: [ref.attachmentId] }), (e: AgentLinkError) => e.code === "attachment_used");

  // Limited account: 1 KiB.
  const small = await newAccount("files-small", "limited");
  const big = path.join(dir, "big.bin");
  fs.writeFileSync(big, Buffer.alloc(4096));
  await assert.rejects(new Rest(await small.device()).upload(big), (e: AgentLinkError) => e.code === "too_large");
  a.c.stop(); b.c.stop();
});

test("revoking a device disconnects it and blocks reconnect", async () => {
  const acc = await newAccount("revoke");
  const d1 = await acc.device(), d2 = await acc.device();
  const a = client(d1, "keeper"), b = client(d2, "victim");
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);
  await new Rest(d1).del(`/v1/devices/${d2.deviceId}`);
  await until(() => b.c.state === "blocked");
  const again = client(d2, "victim");
  again.c.start();
  await assert.rejects(again.c.ready(2000), (e: AgentLinkError) => e.code === "revoked");
  a.c.stop(); again.c.stop();
});

test("disabling an account disconnects all its agents", async () => {
  const acc = await newAccount("disable");
  const a = client(await acc.device(), "doomed");
  a.c.start(); await a.c.ready();
  await admin("PATCH", `/admin/accounts/${acc.id}`, { disabled: true });
  await until(() => a.c.state === "blocked");
});

test("state survives server restart (queued mail, identities, quota)", async () => {
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-restart-"));
  const opts = { port: 0, host: "127.0.0.1", dataDir: d2, adminToken: ADMIN, logLevel: "silent" as const };
  let s = await startServer(opts);
  const mk = await fetch(s.url + "/admin/accounts", { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ name: "durable" }) }).then((r) => r.json()) as any;
  const credA = await enroll(s.url, mk.enrollment.code, "a");
  const code2 = await fetch(s.url + `/admin/accounts/${mk.account.id}/enrollments`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}" }).then((r) => r.json()) as any;
  const credB = await enroll(s.url, code2.code, "b");
  const b0 = client(credB, "inbox-bot"); b0.c.start(); await b0.c.ready(); b0.c.stop();
  const a = client(credA, "poster"); a.c.start(); await a.c.ready();
  await a.c.send("inbox-bot", "survive the restart");
  a.c.stop();
  await s.close();

  s = await startServer({ ...opts, port: 0 });
  const fix = (c: Credentials) => ({ ...c, serverUrl: s.url });
  const b = client(fix(credB), "inbox-bot");
  b.c.start(); await b.c.ready();
  await until(() => b.inbox.length === 1);
  assert.equal(b.inbox[0].text, "survive the restart");
  assert.equal((await b.c.usage()).used, 1);
  b.c.stop();
  await s.close();
  fs.rmSync(d2, { recursive: true, force: true });
});

test("open signup (AGENTLINK_SIGNUP=open) creates an account and device", async () => {
  const r = await fetch(srv.url + "/v1/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountName: "self-serve", deviceName: "me" }) });
  assert.equal(r.status, 201);
  const b = await r.json() as any;
  const me = await new Rest({ serverUrl: srv.url, deviceId: b.device.id, deviceToken: b.deviceToken }).get("/v1/me");
  assert.equal(me.account.name, "self-serve");
});

test("rejects oversized text and unknown frame types", async () => {
  const acc = await newAccount("limits2");
  const a = client(await acc.device(), "lim-a"), b = client(await acc.device(), "lim-b");
  a.c.start(); b.c.start();
  await Promise.all([a.c.ready(), b.c.ready()]);
  await assert.rejects(a.c.send("lim-b", "x".repeat(70 * 1024)), (e: AgentLinkError) => e.code === "too_large");
  await assert.rejects(a.c.request("nonsense"), (e: AgentLinkError) => e.code === "unknown_type");
  await assert.rejects(a.c.send("lim-a", "me"), (e: AgentLinkError) => e.code === "self_send");
  a.c.stop(); b.c.stop();
});

test("HTTP rate limit returns 429 with retryAfterMs", async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-rl-"));
  const s = await startServer({ port: 0, host: "127.0.0.1", dataDir: d, logLevel: "silent", limits: { httpBurst: 3, httpPerSec: 0.001 } as any });
  const codes: number[] = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(s.url + "/v1/me")).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  assert.equal((await fetch(s.url + "/healthz")).status, 200); // health is exempt
  await s.close();
  fs.rmSync(d, { recursive: true, force: true });
});
