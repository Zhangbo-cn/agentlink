import { test } from "node:test";
import assert from "node:assert/strict";
import { Inbox, formatDelivery, type Delivery } from "../extension/src/inbox.ts";
import type { WireMessage } from "../extension/src/client.ts";

let seq = 0;
const m = (text: string, deliverAs: "steer" | "followUp" = "followUp", from = "a"): WireMessage => ({
  messageId: `m${++seq}`, seq, episodeId: "e", from: { agentId: `ag_${from}`, name: from }, text, deliverAs, attachments: [], sentAt: Date.now(),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("idle: batches messages arriving within the window", async () => {
  const out: Delivery[] = [];
  const ib = new Inbox((d) => out.push(d), 10);
  ib.push(m("1")); ib.push(m("2"));
  await sleep(30);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].messages.map((x) => x.text), ["1", "2"]);
  assert.equal(out[0].deliverAs, "followUp");
});

test("busy: followUps wait; steer drains ordered prefix; rest flush when idle", async () => {
  const out: Delivery[] = [];
  const ib = new Inbox((d) => out.push(d), 5);
  ib.setBusy(true);
  ib.push(m("f1")); ib.push(m("s1", "steer")); ib.push(m("f2"));
  await sleep(20);
  assert.equal(out.length, 1);
  assert.equal(out[0].deliverAs, "steer");
  assert.deepEqual(out[0].messages.map((x) => x.text), ["f1", "s1"]);
  ib.setBusy(false);
  await sleep(20);
  assert.deepEqual(out[1].messages.map((x) => x.text), ["f2"]);
});

test("reorders by server seq", async () => {
  const out: Delivery[] = [];
  const ib = new Inbox((d) => out.push(d), 10);
  const a = m("first"), b = m("second");
  ib.push(b); ib.push(a);
  await sleep(30);
  assert.deepEqual(out[0].messages.map((x) => x.text), ["first", "second"]);
});

test("formatting labels sender, fences content, lists attachments", () => {
  const msg = m("do X");
  msg.attachments = [{ attachmentId: "att_1", fileCode: "f_abc", fileName: "log.txt", byteSize: 2048, sha256: "00" }];
  const ext = m("hi", "steer", "partner");
  ext.from = { agentId: "ag_p", name: "partner", account: "Acme", external: true };
  const s = formatDelivery({ messages: [msg, ext], deliverAs: "steer" });
  assert.match(s, /from a\]/);
  assert.match(s, /fileCode=f_abc/);
  assert.match(s, /external agent, account "Acme"/);
  assert.match(s, /Reply with agentlink_send to "ag_p"/);
  assert.match(s, /\[steer/);
});
