import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { resolveSmtp, explainSmtpError, SMTP_PRESETS } from "../server/src/mailer.ts";
import { startServer } from "../server/src/server.ts";
import { startEmailLogin, verifyEmailLogin, AgentLinkError } from "../sdk/client.ts";

test("provider presets: QQ / 163 / 126 / Gmail resolve to implicit TLS on 465 with From = login user", () => {
  for (const [p, host] of [["qq", "smtp.qq.com"], ["163", "smtp.163.com"], ["126", "smtp.126.com"], ["gmail", "smtp.gmail.com"]]) {
    const r = resolveSmtp({ provider: p, user: `bot@${p}.example`, pass: "code" })!;
    assert.equal(r.transport.host, host);
    assert.equal(r.transport.port, 465);
    assert.equal(r.transport.secure, true);
    assert.equal(r.from, `AgentLink <bot@${p}.example>`);
  }
  assert.equal(resolveSmtp({ provider: "outlook", user: "a@b.c", pass: "x" })!.transport.requireTLS, true);
  assert.equal(resolveSmtp({ url: "smtps://bot%40qq.com:x@smtp.qq.com:465" })!.from, "AgentLink <bot@qq.com>");
  assert.throws(() => resolveSmtp({ provider: "nope", user: "a", pass: "b" }), /Unknown AGENTLINK_SMTP_PROVIDER/);
  assert.throws(() => resolveSmtp({ provider: "qq" }), /SMTP_USER and AGENTLINK_SMTP_PASS are required/);
  assert.equal(resolveSmtp({}), null);
  assert.ok(Object.keys(SMTP_PRESETS).length >= 10);
});

test("SMTP error hints", () => {
  assert.match(explainSmtpError(new Error("Invalid login: 535 Login fail")), /授权码/);
  assert.match(explainSmtpError(new Error("501 Mail from address must be same as authorization user")), /AGENTLINK_MAIL_FROM/);
  assert.match(explainSmtpError(new Error("connect ETIMEDOUT")), /465\/587/);
});

test("end-to-end: real SMTP over implicit TLS with AUTH; codes reach qq/gmail/163/126/outlook recipients and sign-up completes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlink-smtp-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
  const inbox: { to: string; from: string; subject: string; text: string; html: boolean }[] = [];
  // Behaves like smtp.qq.com: TLS on connect, AUTH required, From must equal the authenticated user.
  const smtp = new SMTPServer({
    secure: true, key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")), authOptional: false, logger: false,
    onAuth(a, _s, cb) { a.username === "bot@qq.com" && a.password === "authcode" ? cb(null, { user: a.username }) : cb(Object.assign(new Error("Login fail"), { responseCode: 535 })); },
    onMailFrom(addr, s, cb) { addr.address === s.user ? cb() : cb(Object.assign(new Error("Mail from address must be same as authorization user"), { responseCode: 501 })); },
    onData(stream, _s, cb) { simpleParser(stream).then((m) => { inbox.push({ to: (m.to as any).text, from: (m.from as any).text, subject: m.subject ?? "", text: m.text ?? "", html: !!m.html }); cb(); }, cb); },
  });
  await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
  const port = (smtp.server.address() as any).port;

  const s = await startServer({
    port: 0, host: "127.0.0.1", dataDir: dir, logLevel: "silent",
    smtp: { host: "127.0.0.1", port, secure: true, insecureTls: true, user: "bot@qq.com", pass: "authcode" },
    limits: { emailPerIpPerHour: 1000 } as any,
  });
  try {
    for (const email of ["alice@qq.com", "bob@gmail.com", "carol@163.com", "dave@126.com", "eve@outlook.com", "frank@foxmail.com"]) {
      const r = await startEmailLogin(s.url, email);
      assert.equal(r.delivery, "smtp");
      const mail = inbox.find((m) => m.to === email)!;
      assert.ok(mail, `mail for ${email}`);
      assert.equal(mail.from, '"AgentLink" <bot@qq.com>');
      assert.ok(mail.html);
      const code = /code is: (\d{6})/.exec(mail.text)![1];
      assert.ok(mail.subject.includes(code));
      const c = await verifyEmailLogin(s.url, email, code, "laptop");
      assert.equal(c.created, true);
      assert.equal(c.email, email);
    }
  } finally {
    await s.close();
  }

  // Misconfigured From: the user gets a clean error, not a hang.
  const s2 = await startServer({
    port: 0, host: "127.0.0.1", dataDir: dir + "-2", logLevel: "silent", mailFrom: "x <no-reply@localhost>",
    smtp: { host: "127.0.0.1", port, secure: true, insecureTls: true, user: "bot@qq.com", pass: "authcode" },
  });
  await assert.rejects(startEmailLogin(s2.url, "x@qq.com"), (e: AgentLinkError) => e.code === "mail_failed");
  await s2.close();
  await new Promise<void>((r) => smtp.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(dir + "-2", { recursive: true, force: true });
});
