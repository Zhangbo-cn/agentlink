#!/usr/bin/env node
import { startServer } from "./server.ts";
import { loadConfig } from "./config.ts";
import { Logger } from "./util.ts";
import fs from "node:fs";
import { parseEnv } from "node:util";
import { createMailer, explainSmtpError, loginEmail, resolveSmtp, smtpSettingsFromConfig, smtpConfigWarnings, SMTP_PRESETS } from "./mailer.ts";

// Load settings from a .env file so they don't have to be exported (and mistyped) in every terminal.
// Real environment variables win; AGENTLINK_ENV_FILE overrides the search path.
let envFileUsed = "";
for (const f of [process.env.AGENTLINK_ENV_FILE, ".env", "deploy/.env"].filter(Boolean) as string[]) {
  try {
    if (!fs.existsSync(f)) continue;
    const fromFile = parseEnv(fs.readFileSync(f, "utf8"));
    // Values already exported in this shell take precedence and are a common source of stale settings.
    const shadowed = Object.keys(fromFile).filter((k) => process.env[k] !== undefined && process.env[k] !== fromFile[k]);
    process.loadEnvFile(f);
    envFileUsed = f;
    console.log(`Loaded settings from ${f}`);
    if (shadowed.length) console.log(`⚠ ${shadowed.join(", ")} 已在当前终端 export，其值优先于 ${f}；要用文件里的值请先 unset ${shadowed.join(" ")}`);
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

if (cmd === "code") {
  // agentlink-server code you@example.com
  // Local operator shortcut: issue a fresh sign-in code and print it, with no email involved.
  // Needs access to the server's data dir, so it only works on the machine running the relay.
  const { Db } = await import("./db.ts");
  const { Store } = await import("./store.ts");
  const cfg = loadConfig();
  if (!arg) { console.error("Usage: agentlink-server code <email>"); process.exit(1); }
  const store = new Store(new Db(`${cfg.dataDir}/agentlink.db`), cfg);
  try {
    const r = store.startEmailLogin(arg);
    console.log(`${r.email} 的登录验证码：${r.code}\n（10 分钟内有效；${r.isNew ? "将创建新账号" : "已有账号"}）`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

if (cmd === "mail-check") {
  // agentlink-server mail-check — report each stage separately, so it's obvious whether the
  // problem is the network, the mailbox settings, or the authorization code itself.
  const cfg = loadConfig();
  const r = resolveSmtp(smtpSettingsFromConfig(cfg));
  const mask = (v?: string) => {
    if (!v) return "(empty)";
    const kinds = [/[a-z]/.test(v) && "小写", /[A-Z]/.test(v) && "大写", /[0-9]/.test(v) && "数字", /[^A-Za-z0-9]/.test(v) && "符号"].filter(Boolean).join("+");
    return `长度 ${v.length}，字符类别 ${kinds}`;
  };
  console.log(`配置文件: ${envFileUsed || "（未使用 .env，全部来自环境变量）"}`);
  console.log(`发件账号: ${cfg.smtp.user ?? "(empty)"}   授权码: ${mask(cfg.smtp.pass)}`);
  for (const w of smtpConfigWarnings(cfg)) console.log(`⚠ ${w}`);
  if (!r) { console.log("✗ 还没有配置 SMTP"); process.exit(1); }
  console.log(`服务器:   ${r.label}  From: ${r.from}`);

  const net = await import("node:net");
  const tls = await import("node:tls");
  const t = r.transport as { host: string; port: number; secure?: boolean };
  const tcp = await new Promise<string>((res) => {
    const s = net.connect({ host: t.host, port: t.port, timeout: 10_000 }, () => res("ok"));
    s.on("timeout", () => { s.destroy(); res("TIMEOUT"); });
    s.on("error", (e) => res((e as NodeJS.ErrnoException).code ?? e.message));
    s.on("connect", () => s.destroy());
  });
  console.log(tcp === "ok" ? `✓ 1/3 TCP 连通 ${t.host}:${t.port}` : `✗ 1/3 连不上 ${t.host}:${t.port}（${tcp}）：检查网络/防火墙`);
  if (tcp !== "ok") process.exit(1);

  const banner = await new Promise<string>((res) => {
    const s = tls.connect({ host: t.host, port: t.port, servername: t.host, timeout: 10_000 });
    let buf = "";
    s.on("data", (d) => { buf += d; if (buf.includes("\n")) { s.destroy(); res(buf.split("\n")[0].trim().slice(0, 80)); } });
    s.on("timeout", () => { s.destroy(); res("TIMEOUT"); });
    s.on("error", (e) => res(`ERR ${(e as Error).message}`));
  });
  console.log(banner.startsWith("220") ? `✓ 2/3 TLS 握手正常：${banner}` : `✗ 2/3 TLS/握手异常：${banner}`);

  const mailer = createMailer(cfg, new Logger("silent"));
  try {
    await mailer.verify?.();
    console.log("✓ 3/3 登录成功（授权码可用）");
    process.exit(0);
  } catch (e) {
    console.log(`✗ 3/3 登录失败：${explainSmtpError(e)}`);
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
    // Read keys with readline's output pointed at a sink: in raw mode readline is the one echoing,
    // so a sink means the typed authorization code never appears on screen.
    const { createInterface } = await import("node:readline/promises");
    const { Writable } = await import("node:stream");
    const sink = new Writable({ write(_c, _e, cb) { cb(); } });
    const rl = createInterface({ input: process.stdin, output: sink as unknown as NodeJS.WritableStream, terminal: process.stdin.isTTY });
    process.stdout.write("授权码/App Password（输入时不显示）: ");
    try { pass = (await rl.question("")).trim(); } finally { rl.close(); process.stdout.write("\n"); }
  }
  if (pass) {
    const bad = [...pass].filter((c) => /[\s'"“”]/.test(c)).length;
    if (bad) { console.error(`✗ 输入里含 ${bad} 个空格/引号，授权码只由字母和数字组成，请重新运行。`); process.exit(1); }
    put("AGENTLINK_SMTP_PASS", pass);
  }
  fs.writeFileSync(file, text);
  const shadow = process.env.AGENTLINK_SMTP_PASS !== undefined && process.env.AGENTLINK_SMTP_PASS !== pass;
  console.log(`✓ 已写入 ${file}（密码长度 ${pass?.length ?? 0}）`);
  if (shadow) console.log(`⚠ 当前终端里还 export 着旧的 AGENTLINK_SMTP_PASS（长度 ${process.env.AGENTLINK_SMTP_PASS!.length}），它的优先级高于 ${file}。\n  请先执行：unset AGENTLINK_SMTP_PASS`);
  console.log(`下一步：node bin/agentlink-server.mjs test-mail 你的另一个邮箱`);
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
