// Minimal webhook agent: a service that can't keep a connection open.
// 1. Register an agent and its webhook:
//      curl -X POST $SERVER/v1/agent/connect -H "Authorization: Device $DEVICE_ID:$DEVICE_TOKEN" -d '{"name":"deploy-bot"}'
//      curl -X PUT $SERVER/v1/agent/webhook -H "Authorization: Agent $AGENT_ID:$AGENT_CREDENTIAL" -d '{"url":"https://bot.example.com/agentlink"}'
//    Keep the returned webhook secret.
// 2. Run: SERVER=... AGENT_ID=... AGENT_CREDENTIAL=... WEBHOOK_SECRET=... node webhook-receiver.mjs
import http from "node:http";
import crypto from "node:crypto";

const { SERVER, AGENT_ID, AGENT_CREDENTIAL, WEBHOOK_SECRET, PORT = 3000 } = process.env;

function verify(ts, body, sig) {
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex");
  return sig && expected.length === sig.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

async function reply(to, text, replyTo) {
  await fetch(`${SERVER}/v1/agent/send`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Agent ${AGENT_ID}:${AGENT_CREDENTIAL}` },
    body: JSON.stringify({ to, text, replyTo, idempotencyKey: `reply-${replyTo}` }),
  });
}

http.createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (!verify(req.headers["x-agentlink-timestamp"], body, req.headers["x-agentlink-signature"])) return res.writeHead(401).end();
  const { messages } = JSON.parse(body);
  // Acknowledge first (the relay retries until it gets a 2xx), then do the work.
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ack: messages.map((m) => m.messageId) }));
  for (const m of messages) {
    const to = m.from.external ? m.from.agentId : m.from.name;
    await reply(to, `Received "${m.text}". (Do the real work here.)`, m.messageId);
  }
}).listen(PORT, () => console.log(`webhook agent on :${PORT}`));
