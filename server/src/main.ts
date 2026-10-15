#!/usr/bin/env node
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { Logger } from "./util.ts";
import fs from "node:fs";
import { createMailer, explainSmtpError, loginEmail, resolveSmtp, smtpSettingsFromConfig, smtpConfigWarnings, SMTP_PRESETS } from "./mailer.ts";

// Load settings from a .env file so they don't have to be exported (and mistyped) in every terminal.
// Real environment variables win; AGENTLINK_ENV_FILE overrides the search path.
for (const f of [process.env.AGENTLINK_ENV_FILE, ".env", "deploy/.env"].filter(Boolean) as string[]) {
  try {
    if (!fs.existsSync(f)) continue;
    process.loadEnvFile(f);
    console.log(`Loaded settings from ${f}`);
    break;
  } catch (e) {
    console.error(`Ignoring ${f}: ${(e as Error).message}`);
  }
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "test-mail") {
  // agentlink-server test-mail you@example.com   — verify SMTP settings without starting the server.
  const cfg = loadConfig();
  const r = resolveSmtp(smtpSettingsFromConfig(cfg));
  if (!r) { console.error("No SMTP configured. Set AGENTLINK_SMTP_URL or AGENTLINK_SMTP_PROVIDER + AGENTLINK_SMTP_USER + AGENTLINK_SMTP_PASS."); process.exit(1); }
  if (!arg) { console.error("Usage: agentlink-server test-mail <recipient>"); process.exit(1); }
  console.log(`SMTP: ${r.label}  From: ${r.from}`);
  for (const w of smtpConfigWarnings(cfg)) console.error(`⚠ ${w}`);
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

if (cmd === "set-pass") {
  // agentlink-server set-pass [--provider 163] [--user me@163.com] [--pass CODE]
  // Writes into .env with the prompt hidden, so the authorization code never touches shell history.
  const flag = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const file = process.env.AGENTLINK_ENV_FILE ?? (fs.existsSync(".env") ? ".env" : "deploy/.env");
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch { text = fs.readFileSync("deploy/.env.example", "utf8"); }
  const put = (key: string, value: string) => {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : text.trimEnd() + "\n" + line + "\n";
  };
  const provider = flag("provider") ?? process.env.AGENTLINK_SMTP_PROVIDER;
  const user = flag("user") ?? process.env.AGENTLINK_SMTP_USER;
  if (provider) put("AGENTLINK_SMTP_PROVIDER", provider);
  if (user) put("AGENTLINK_SMTP_USER", user);
  if (provider || user) console.log(`Updating ${file}`);
  let pass = flag("pass");
  if (pass === undefined) {
    const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) (rl as any)._writeToOutput = () => {}; // never echo the code
    pass = (await rl.question("授权码/App Password（输入时不显示）: ")).trim();
    rl.close();
    process.stdout.write("\n");
  }
  if (pass) {
    const bad = [...pass].filter((c) => /[\s'"“”]/.test(c)).length;
    if (bad) { console.error(`✗ 输入里含 ${bad} 个空格/引号，授权码只由字母和数字组成，请重新运行。`); process.exit(1); }
    put("AGENTLINK_SMTP_PASS", pass);
  }
  fs.writeFileSync(file, text);
  console.log(`✓ 已写入 ${file}（密码长度 ${pass?.length ?? 0}）。下一步：node bin/agentlink-server.mjs test-mail 你的另一个邮箱`);
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
