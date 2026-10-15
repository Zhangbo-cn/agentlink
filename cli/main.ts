#!/usr/bin/env node
/**
 * agentlink CLI
 *   agentlink login [server] [--email you@x.com]     Sign in / sign up with an emailed code
 *   agentlink join <server> <code>                    Enroll with a one-time device code
 *   agentlink status | whoami                         Show account, device, usage
 *   agentlink agents [--capability X]                 List reachable agents
 *   agentlink send <to> <message...> [--file F]...    Send a message (as agent --name, default "cli")
 *   agentlink listen [--name N] [--exec CMD]          Stream incoming messages (JSON lines), optionally run CMD per message
 *   agentlink mcp [--name N]                          Run the MCP stdio bridge (for Claude Code, Codex, Cursor, ...)
 *   agentlink invite                                  One-time code to add another device to this account
 *   agentlink devices | revoke <device-id>            Manage devices
 *   agentlink logout
 *   agentlink server                                  Run a relay server (same as agentlink-server)
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import {
  AgentLinkClient, AgentLinkError, Rest, enroll, readCredentials, writeCredentials, clearCredentials, serverInfo, configDir,
  startEmailLogin, verifyEmailLogin, type WireMessage, type Transport,
} from "../sdk/client.ts";
import { runMcpBridge } from "./mcp.ts";

export const DEFAULT_SERVER = process.env.AGENTLINK_DEFAULT_SERVER ?? "http://localhost:8787";

type Flags = { _: string[]; [k: string]: string | string[] | boolean | undefined };
function parseArgs(argv: string[]): Flags {
  const f: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { f._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      const next = argv[i + 1];
      const val = v ?? (next !== undefined && !next.startsWith("--") ? (i++, next) : true);
      const prev = f[k];
      f[k] = prev === undefined ? val : Array.isArray(prev) ? [...prev, String(val)] : [String(prev), String(val)];
    } else f._.push(a);
  }
  return f;
}
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

function die(msg: string, code = 1): never {
  process.stderr.write(msg + "\n");
  process.exit(code);
}

function needCreds() {
  const c = readCredentials();
  if (!c) die("Not logged in. Run: agentlink login");
  return c;
}

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

const help = `agentlink — connect AI agents across devices, networks and services

Account
  login [server] [--email E] [--code C] [--device NAME]   Sign in or create an account with an emailed code
  join <server> <code> [--device NAME]                    Add this device with a one-time code from another device
  status                                                  Account, device, usage
  invite                                                  Create a one-time code to add another device
  devices | revoke <device-id> | logout

Messaging
  agents [--capability X]                                 Agents you can reach
  send <to> <message...> [--file F]... [--name N]         Send a message
  listen [--name N] [--exec CMD] [--describe D] [--cap C]...
                                                          Receive messages as JSON lines; with --exec, run CMD
                                                          per message (message JSON on stdin, stdout sent back as reply)

Cross-account
  pair-code --name N                                      One-time code letting another account talk to agent N
  pair <code> --name N                                    Accept a code; agent N can then message the other agent by id
  unpair <agent-id> --name N

Integrations
  mcp [--name N] [--describe D] [--cap C]...              MCP stdio server for Claude Code, Codex, Cursor, Gemini CLI, ...
  server                                                  Run a relay server

Common flags: --transport auto|ws|http  (http = long-poll, for networks that block WebSockets)
Env: AGENTLINK_CONFIG_DIR, AGENTLINK_SERVER + AGENTLINK_DEVICE_ID + AGENTLINK_DEVICE_TOKEN (headless), HTTPS_PROXY`;

function profileFrom(f: Flags, framework: string) {
  const caps = list(f.cap).concat(list(f.capability)).flatMap((c) => c.split(",")).map((c) => c.trim()).filter(Boolean);
  const description = str(f.describe);
  return { framework, host: os.hostname(), project: path.basename(process.cwd()), ...(description ? { description } : {}), ...(caps.length ? { capabilities: caps } : {}) };
}

function liveClient(f: Flags, defaultName: string | undefined, framework: string) {
  const name = (str(f.name) ?? defaultName)?.toLowerCase();
  const c = new AgentLinkClient({
    credentials: needCreds(),
    name,
    credential: name ? agentCreds()[name] : undefined,
    profile: profileFrom(f, framework),
    transport: (str(f.transport) as Transport) ?? "auto",
  });
  if (name) c.onIdentity = (id) => saveAgentCred(id.name, id.credential);
  return c;
}

// Credentials of named agents used from this device, so repeated CLI invocations resume the same identity.
function agentCreds(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(path.join(configDir(), "agents.json"), "utf8")); } catch { return {}; }
}
function saveAgentCred(name: string, credential: string): void {
  const all = agentCreds();
  if (all[name] === credential) return;
  all[name] = credential;
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir(), "agents.json"), JSON.stringify(all, null, 2), { mode: 0o600 });
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const f = parseArgs(argv);
  const [cmd, ...rest] = f._;

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      console.log(help);
      return;

    case "login": {
      const server = rest[0] ?? str(f.server) ?? readCredentials()?.serverUrl ?? DEFAULT_SERVER;
      const info = await serverInfo(server).catch((e) => die(`Cannot reach ${server}: ${e.message}`));
      if (info.signup === "invite" && !f.email) process.stderr.write("This server is invite-only: your email must already have an account.\n");
      const email = str(f.email) ?? (await prompt("Email: "));
      if (!f.code) {
        const r = await startEmailLogin(server, email);
        process.stderr.write(`${r.newAccount ? "Creating a new account. " : ""}A 6-digit code was sent to ${r.email}${r.delivery === "log" ? " (this server has no SMTP: the code is in the server log)" : ""}.\n`);
      }
      const code = str(f.code) ?? (await prompt("Code: "));
      const c = await verifyEmailLogin(server, email, code, str(f.device) ?? os.hostname());
      const file = writeCredentials(c);
      console.log(`${c.created ? "Account created" : "Signed in"} as ${c.email}. Device "${c.deviceName}" saved to ${file}`);
      return;
    }

    case "join": {
      const [server, code] = rest;
      if (!server || !code) die("Usage: agentlink join <server> <code>");
      const c = await enroll(server, code, str(f.device) ?? os.hostname());
      console.log(`Joined account "${c.accountName}" as device "${c.deviceName}". Saved to ${writeCredentials(c)}`);
      return;
    }

    case "status":
    case "whoami": {
      const c = needCreds();
      const me = await new Rest(c).get("/v1/me");
      const lim = (n: number) => (n > 0 ? String(n) : "unlimited");
      console.log([
        `Server:   ${c.serverUrl}`,
        `Account:  ${me.account.name}${me.account.email ? ` <${me.account.email}>` : ""}`,
        `Device:   ${me.device.name} (${me.device.id})`,
        `Online:   ${me.onlineAgents} agent(s)`,
        `Messages: ${me.usage.used} this month (limit ${lim(me.usage.limit)})`,
      ].join("\n"));
      return;
    }

    case "invite": {
      const c = needCreds();
      const r = await new Rest(c).post("/v1/enrollments");
      console.log(`On the other device run:\n  agentlink join ${c.serverUrl} ${r.code}\nor in pi:\n  /agentlink_join ${c.serverUrl} ${r.code}\nExpires ${new Date(r.expiresAt).toLocaleString()}.`);
      return;
    }

    case "devices": {
      const r = await new Rest(needCreds()).get("/v1/devices");
      for (const d of r.devices) console.log(`${d.id}  ${d.name}${d.current ? " (this device)" : ""}  last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}`);
      return;
    }

    case "revoke": {
      if (!rest[0]) die("Usage: agentlink revoke <device-id>");
      await new Rest(needCreds()).del(`/v1/devices/${encodeURIComponent(rest[0])}`);
      console.log("Revoked.");
      return;
    }

    case "logout":
      clearCredentials();
      console.log("Local credentials removed.");
      return;

    case "agents": {
      const c = liveClient(f, str(f.name) ?? "cli", "cli");
      try {
        const l = await c.listAgents(str(f.capability));
        if (f.json) { console.log(JSON.stringify(l, null, 2)); return; }
        const row = (a: any) => `${(a.external ? a.agentId : a.name).padEnd(24)} ${a.activity.padEnd(8)} ${(a.framework ?? "").padEnd(12)} ${a.deviceName ?? a.account ?? ""}${a.description ? `  ${a.description}` : ""}`;
        for (const a of l.same) console.log(row(a));
        for (const a of l.paired) console.log(row(a) + "  [paired]");
        if (!l.same.length && !l.paired.length) console.log("No other agents.");
      } finally { c.stop(); }
      return;
    }

    case "send": {
      const [to, ...words] = rest;
      let text = words.join(" ");
      if (!to) die("Usage: agentlink send <to> <message...> [--file F]");
      if (!text && !process.stdin.isTTY) { const chunks: Buffer[] = []; for await (const ch of process.stdin) chunks.push(ch as Buffer); text = Buffer.concat(chunks).toString("utf8"); }
      const c = liveClient(f, "cli", "cli");
      try {
        const ids: string[] = [];
        for (const file of list(f.file)) ids.push((await c.deviceRest().upload(path.resolve(file))).attachmentId);
        const r = await c.send(to, text, { attachments: ids, deliverAs: f.steer ? "steer" : "followUp" });
        console.log(`${r.status} → ${r.recipient.name} (${r.messageId})`);
        if (f.wait) {
          const secs = Number(f.wait === true ? 300 : f.wait);
          const reply = await new Promise<WireMessage | null>((resolve) => {
            const t = setTimeout(() => resolve(null), secs * 1000);
            c.onMessage = (m) => { if (m.from.agentId === r.recipient.agentId) { clearTimeout(t); c.ack([m.messageId]); resolve(m); } };
          });
          if (!reply) die(`No reply within ${secs}s`, 2);
          console.log(reply.text);
        }
      } finally { c.stop(); }
      return;
    }

    case "listen": {
      const c = liveClient(f, undefined, str(f.framework) ?? (f.exec ? "service" : "cli"));
      const exec = str(f.exec);
      c.onIdentity = (id) => process.stderr.write(`listening as "${id.name}" (${id.account.name}/${id.device.name})${exec ? `, running: ${exec}` : ""}\n`);
      c.onState = (s, e) => { if (s !== "online") process.stderr.write(`[${s}]${e ? ` ${e.message}` : ""}\n`); };
      let chain = Promise.resolve();
      c.onMessage = (m) => {
        chain = chain.then(async () => {
          if (!exec) { console.log(JSON.stringify(m)); c.ack([m.messageId]); return; }
          const out = await runHandler(exec, m);
          c.ack([m.messageId]);
          if (out.trim()) await c.send(m.from.external ? m.from.agentId : m.from.name, out.trim(), { replyTo: m.messageId }).catch((e) => process.stderr.write(`reply failed: ${e.message}\n`));
        });
      };
      c.start();
      await new Promise<void>((resolve) => { process.on("SIGINT", resolve); process.on("SIGTERM", resolve); });
      c.stop();
      return;
    }

    case "pair-code": {
      // Cross-account: one-time code for agent --name (works even while that agent is online elsewhere).
      const name = str(f.name);
      if (!name) die("Usage: agentlink pair-code --name <your-agent-name>");
      const r = await new Rest(needCreds()).post(`/v1/agents/${encodeURIComponent(name)}/pair-code`);
      console.log(`Pair code for "${name}": ${r.code}  (expires ${new Date(r.expiresAt).toLocaleTimeString()})\nOn the other account run:\n  agentlink pair ${r.code} --name <their-agent-name>`);
      return;
    }

    case "pair": {
      const name = str(f.name);
      if (!rest[0] || !name) die("Usage: agentlink pair <code> --name <your-agent-name>");
      const creds = needCreds();
      // Make sure the agent exists (register or resume it).
      const name_ = name.toLowerCase();
      const id = await new Rest(creds).post("/v1/agent/connect", { name: name_, credential: agentCreds()[name_], profile: profileFrom(f, "cli") }).catch((e) => { if (e.code !== "name_in_use") throw e; return null; });
      if (id) saveAgentCred(id.name, id.credential);
      const r = await new Rest(creds).post(`/v1/agents/${encodeURIComponent(name)}/pair`, { code: rest[0] });
      console.log(`Paired "${name}" with ${r.name} (account ${r.account}).\nAddress it by id: ${r.agentId}`);
      return;
    }

    case "unpair": {
      const name = str(f.name);
      if (!rest[0] || !name) die("Usage: agentlink unpair <agent-id> --name <your-agent-name>");
      const r = await new Rest(needCreds()).post(`/v1/agents/${encodeURIComponent(name)}/unpair`, { agentId: rest[0] });
      console.log(r.removed ? "Pairing removed." : "No such pairing.");
      return;
    }

    case "mcp":
      await runMcpBridge({ name: str(f.name), profile: profileFrom(f, str(f.framework) ?? "mcp"), transport: (str(f.transport) as Transport) ?? "auto" });
      return;

    case "server": {
      await import("../server/src/main.ts");
      return;
    }

    default:
      die(`Unknown command: ${cmd}\n\n${help}`);
  }
}

/** Run a shell command with the message JSON on stdin and AGENTLINK_* env; resolves to its stdout. */
function runHandler(cmd: string, m: WireMessage): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, AGENTLINK_FROM: m.from.name, AGENTLINK_FROM_ID: m.from.agentId, AGENTLINK_MESSAGE_ID: m.messageId, AGENTLINK_TEXT: m.text },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; if (out.length > 60_000) out = out.slice(0, 60_000); });
    const t = setTimeout(() => child.kill("SIGTERM"), 15 * 60_000);
    child.on("close", (code) => { clearTimeout(t); resolve(code === 0 ? out : `${out}\n[handler exited with code ${code}]`); });
    child.stdin.end(JSON.stringify(m));
  });
}

const isMain = process.argv[1] && /agentlink(\.m?[jt]s)?$|cli[\\/]main\.ts$/.test(process.argv[1]);
if (isMain) {
  main().catch((e) => die(e instanceof AgentLinkError ? `Error (${e.code}): ${e.message}` : String(e?.stack ?? e)));
}
