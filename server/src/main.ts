#!/usr/bin/env node
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { Logger } from "./util.ts";
import { createMailer, explainSmtpError, loginEmail, resolveSmtp, smtpSettingsFromConfig, SMTP_PRESETS } from "./mailer.ts";

const [cmd, arg] = process.argv.slice(2);

if (cmd === "test-mail") {
  // agentlink-server test-mail you@example.com   — verify SMTP settings without starting the server.
  const cfg = loadConfig();
  const r = resolveSmtp(smtpSettingsFromConfig(cfg));
  if (!r) { console.error("No SMTP configured. Set AGENTLINK_SMTP_URL or AGENTLINK_SMTP_PROVIDER + AGENTLINK_SMTP_USER + AGENTLINK_SMTP_PASS."); process.exit(1); }
  if (!arg) { console.error("Usage: agentlink-server test-mail <recipient>"); process.exit(1); }
  console.log(`SMTP: ${r.label}  From: ${r.from}`);
  const mailer = createMailer(cfg, new Logger("silent"));
  try {
    await mailer.verify?.();
    console.log("✓ connected and authenticated");
    const m = loginEmail("123456", cfg);
    await mailer.send(arg, `[test] ${m.subject}`, m.text, m.html);
    console.log(`✓ test mail sent to ${arg} (check spam folder too)`);
    process.exit(0);
  } catch (e) {
    console.error(`✗ ${explainSmtpError(e)}`);
    process.exit(1);
  }
}

if (cmd === "smtp-presets") {
  for (const [k, v] of Object.entries(SMTP_PRESETS)) console.log(`${k.padEnd(9)} ${v.host}:${v.port}  ${v.note}`);
  process.exit(0);
}

const server = await startServer();

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "server.stopping", signal }) + "\n");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("unhandledRejection", (e) => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "unhandledRejection", err: String((e as Error)?.stack ?? e) }) + "\n");
});
