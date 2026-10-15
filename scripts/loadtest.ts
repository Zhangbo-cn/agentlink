// Rough throughput check: N agents in one account, each sends M messages to a random peer.
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { startServer } from "../server/src/server.ts";
import { AgentLinkClient, enroll } from "../extension/src/client.ts";
const N = Number(process.env.N ?? 50), M = Number(process.env.M ?? 40);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "al-load-"));
const s = await startServer({ port: 0, host: "127.0.0.1", dataDir: dir, adminToken: "x", logLevel: "silent", limits: { httpBurst: 1e6, httpPerSec: 1e6, helloBurst: 1e6, helloPerSec: 1e6 } as any,
  plans: { free: { name: "free", monthlyMessages: 1e9, maxDevices: 1e4, maxOnlineAgents: 1e4, maxAttachmentBytes: 1, queueTtlSec: 3600 } } });
const acc = await (await fetch(s.url + "/admin/accounts", { method: "POST", headers: { authorization: "Bearer x" }, body: JSON.stringify({ name: "load" }) })).json() as any;
const clients: AgentLinkClient[] = []; let received = 0;
for (let i = 0; i < N; i++) {
  const code = i === 0 ? acc.enrollment.code : (await (await fetch(s.url + `/admin/accounts/${acc.account.id}/enrollments`, { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" })).json() as any).code;
  const c = new AgentLinkClient({ credentials: await enroll(s.url, code, `d${i}`), name: `agent-${i}` });
  c.onMessage = (m) => { received++; c.ack([m.messageId]); };
  c.start(); clients.push(c);
}
await Promise.all(clients.map((c) => c.ready()));
const t0 = performance.now(); const lat: number[] = [];
await Promise.all(clients.map(async (c, i) => {
  for (let j = 0; j < M; j++) { const t = performance.now(); await c.send(`agent-${(i + 1 + j) % N}`, `msg ${j}`); lat.push(performance.now() - t); await new Promise((r) => setTimeout(r, 100)); }
}));
while (received < N * M) await new Promise((r) => setTimeout(r, 20));
const secs = (performance.now() - t0) / 1000; lat.sort((a, b) => a - b);
console.log(JSON.stringify({ agents: N, messages: N * M, seconds: +secs.toFixed(2), msgPerSec: Math.round(N * M / secs), sendP50ms: +lat[lat.length >> 1].toFixed(1), sendP99ms: +lat[Math.floor(lat.length * 0.99)].toFixed(1) }));
for (const c of clients) c.stop(); await s.close(); fs.rmSync(dir, { recursive: true, force: true });
