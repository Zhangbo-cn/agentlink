/**
 * AgentLink — agent-to-agent messaging for pi.
 * Connects this pi session to an AgentLink relay so agents on other machines, networks and
 * services (pi, Claude Code / Codex / Cursor via MCP, scripts, webhooks) can message it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import path from "node:path";
import {
  AgentLinkClient, AgentLinkError, Rest, enroll, signup, readCredentials, writeCredentials, clearCredentials,
  startEmailLogin, verifyEmailLogin, serverInfo,
  type ConnState, type Credentials, type Identity, type WireMessage, type Profile, type Transport,
} from "../sdk/client.ts";
import { Inbox, formatDelivery, type Delivery } from "./inbox.ts";

const MESSAGE_TYPE = "agentlink-message";
const MAX_FILES = 5;
const DEFAULT_SERVER = process.env.AGENTLINK_DEFAULT_SERVER ?? "http://localhost:8787";

// Survives session switches inside one pi process so the agent keeps its identity.
const G = globalThis as typeof globalThis & { __agentlinkCredential?: string; __agentlinkStopped?: boolean; __agentlinkPendingEmail?: { server: string; email: string } };

export default function agentlink(pi: ExtensionAPI) {
  pi.registerFlag("agentlink-name", { type: "string", description: "Persistent AgentLink name for this agent (e.g. prod-server). Default: random ephemeral name." });
  pi.registerFlag("agentlink-describe", { type: "string", description: "One-line description other agents see (what this agent is for)" });
  pi.registerFlag("agentlink-caps", { type: "string", description: "Comma-separated capability tags, e.g. repo:api,deploy,gpu" });
  pi.registerFlag("agentlink-off", { type: "boolean", default: false, description: "Do not connect to AgentLink automatically" });

  let client: AgentLinkClient | null = null;
  let ctxRef: ExtensionContext | null = null;
  let busy = false;
  const inbox = new Inbox(deliver);

  const flag = (n: string) => { const v = pi.getFlag(n); return typeof v === "string" && v.trim() ? v.trim() : undefined; };
  const agentName = () => (flag("agentlink-name") ?? process.env.AGENTLINK_NAME)?.toLowerCase();

  function profile(): Profile {
    const caps = (flag("agentlink-caps") ?? process.env.AGENTLINK_CAPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const description = flag("agentlink-describe") ?? process.env.AGENTLINK_DESCRIBE;
    const cwd = ctxRef?.cwd ?? process.cwd();
    return { framework: "pi", host: os.hostname(), project: path.basename(cwd), ...(description ? { description } : {}), ...(caps.length ? { capabilities: caps } : {}) };
  }

  function deliver(d: Delivery): void {
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: formatDelivery(d), display: true, details: { messageIds: d.messages.map((m) => m.messageId), from: [...new Set(d.messages.map((m) => m.from.name))] } },
      { triggerTurn: true, deliverAs: d.deliverAs },
    );
    // The message is in the session now; ack so the server stops redelivering.
    client?.ack(d.messages.map((m) => m.messageId));
  }

  function statusText(s: ConnState, c: AgentLinkClient, err?: AgentLinkError): string | undefined {
    switch (s) {
      case "online": return `⇄ ${c.identity?.name}${c.mode === "http" ? " (http)" : ""}`;
      case "connecting": return "⇄ connecting…";
      case "reconnecting": return "⇄ reconnecting…";
      case "blocked": return `⇄ blocked: ${err?.code ?? "error"}`;
      default: return undefined;
    }
  }

  function connect(ctx: ExtensionContext | null): AgentLinkClient {
    if (client && client.state !== "stopped") return client;
    const creds = readCredentials();
    if (!creds) throw new AgentLinkError("not_configured", "AgentLink is not set up. Run /agentlink_login <email> (or /agentlink_join <server> <code>).");
    ctxRef = ctx ?? ctxRef;
    const c = new AgentLinkClient({ credentials: creds, name: agentName(), credential: G.__agentlinkCredential, profile: profile(), transport: (process.env.AGENTLINK_TRANSPORT as Transport) ?? "auto" });
    c.onIdentity = (id: Identity) => { G.__agentlinkCredential = id.credential; };
    c.onState = (s, err) => {
      ctxRef?.ui.setStatus("agentlink", statusText(s, c, err));
      if (s === "blocked" && err) ctxRef?.ui.notify(`AgentLink: ${err.message}`, "error");
      if (s === "online") c.setActivity(busy ? "busy" : "idle");
    };
    c.onMessage = (m: WireMessage) => inbox.push(m);
    c.onEvent = (type, p) => {
      if (type === "pair_added") ctxRef?.ui.notify(`AgentLink: now paired with ${p.name} (${p.account})`, "info");
      if (type === "pair_removed") ctxRef?.ui.notify(`AgentLink: ${p.name} removed the pairing`, "warning");
    };
    client = c;
    c.start();
    return c;
  }

  async function online(): Promise<AgentLinkClient> {
    const c = connect(ctxRef);
    await c.ready(15_000);
    return c;
  }

  function rest(): Rest {
    const creds = readCredentials();
    if (!creds) throw new AgentLinkError("not_configured", "AgentLink is not set up. Run /agentlink_login <email>.");
    return new Rest(creds);
  }

  function saveAndConnect(c: Credentials, ctx: ExtensionContext): string {
    const file = writeCredentials(c);
    client?.stop(); client = null;
    G.__agentlinkStopped = false;
    G.__agentlinkCredential = undefined;
    connect(ctx);
    return file;
  }

  const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });
  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // ------------------------------------------------------------ lifecycle

  pi.on("session_start", async (_e, ctx) => {
    ctxRef = ctx;
    busy = false;
    if (pi.getFlag("agentlink-off") || G.__agentlinkStopped || !readCredentials()) return;
    try { connect(ctx); } catch { /* not configured */ }
  });

  pi.on("session_shutdown", async () => {
    inbox.stop();
    client?.stop();
    client = null;
    ctxRef?.ui.setStatus("agentlink", undefined);
    ctxRef = null;
  });

  pi.on("agent_start", async () => {
    busy = true;
    inbox.setBusy(true);
    client?.setActivity("busy");
  });

  pi.on("agent_settled", async (_e, ctx) => {
    busy = !ctx.isIdle();
    inbox.setBusy(busy);
    client?.setActivity(busy ? "busy" : "idle");
  });

  // ------------------------------------------------------------ model-facing tools

  pi.registerTool({
    name: "agentlink_agents",
    label: "AgentLink Agents",
    description: "List agents you can message over AgentLink — other pi sessions, Claude Code/Codex/Cursor (via MCP), scripts and services on other machines or accounts — with state, framework, description and capabilities. Optionally filter by capability.",
    parameters: Type.Object({ capability: Type.Optional(Type.String({ description: "Only agents advertising this capability, e.g. deploy, gpu, repo:api" })) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id, p) {
      const c = await online();
      const l = await c.listAgents(p.capability);
      const fmt = (a: any) =>
        `- ${a.external ? a.agentId : a.name}${a.external ? ` "${a.name}" (account ${a.account})` : ""}${a.deviceName ? ` on ${a.deviceName}` : ""}: ${a.activity}` +
        `${a.framework ? ` [${a.framework}]` : ""}${a.persistent || a.external ? "" : " (ephemeral)"}${a.description ? ` — ${a.description}` : ""}${a.capabilities?.length ? ` {${a.capabilities.join(", ")}}` : ""}`;
      const lines = [`You are "${l.self.name}" on ${c.identity!.device.name}.`];
      lines.push(l.same.length ? `Same account:\n${l.same.map(fmt).join("\n")}` : `Same account: no other agents${p.capability ? ` with "${p.capability}"` : ""}.`);
      if (l.paired.length) lines.push(`Paired external (address by id):\n${l.paired.map(fmt).join("\n")}`);
      return text(lines.join("\n"), l as any);
    },
  });

  pi.registerTool({
    name: "agentlink_send",
    label: "AgentLink Send",
    description:
      "Send a message to another agent by name (same account) or agent id (paired). Returns immediately; the reply arrives later as a new AgentLink message. " +
      "Offline persistent agents receive it when they reconnect.",
    promptSnippet: "agentlink_send: message or delegate to another agent (other machine, repo, server, framework or account)",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name or agent id" }),
      message: Type.String({ description: "Self-contained message: goal, context, constraints, what to send back" }),
      files: Type.Optional(Type.Array(Type.String({ description: "Local file path" }), { maxItems: MAX_FILES, description: "Files to attach" })),
      replyTo: Type.Optional(Type.String({ description: "messageId you are answering" })),
      deliverAs: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")], { description: "followUp (default) waits until the recipient is free. steer interrupts: only for urgent corrections." })),
    }),
    annotations: { openWorldHint: true, destructiveHint: false },
    async execute(_id, p, signal) {
      const c = await online();
      const files = p.files ?? [];
      if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} attachments`);
      const uploaded: string[] = [];
      for (const f of files) {
        if (signal?.aborted) throw new Error("Cancelled");
        uploaded.push((await rest().upload(path.resolve(ctxRef?.cwd ?? process.cwd(), f))).attachmentId);
      }
      const res = await c.send(p.to, p.message, { deliverAs: p.deliverAs, attachments: uploaded, replyTo: p.replyTo });
      const where = res.status === "delivered"
        ? `Delivered to ${res.recipient.name} (${res.recipient.activity}${res.recipient.via && res.recipient.via !== "ws" ? ` via ${res.recipient.via}` : ""})`
        : `Queued for ${res.recipient.name} (offline; held until ${new Date(res.expiresAt).toISOString()})`;
      return text(`${where}${uploaded.length ? ` with ${uploaded.length} attachment(s)` : ""}. messageId=${res.messageId}. Do not poll; the reply will arrive as a message.`, { ...res, attachments: uploaded.length });
    },
  });

  pi.registerTool({
    name: "agentlink_status",
    label: "AgentLink Status",
    description: "Check one agent's state (busy/idle/offline). Use once if a reply is late; do not poll.",
    parameters: Type.Object({ to: Type.String({ description: "Agent name or id" }) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute(_id, p) {
      const s = await (await online()).status(p.to);
      return text(`${s.name}: ${s.activity}${s.via ? ` (via ${s.via})` : ""}`, s as any);
    },
  });

  pi.registerTool({
    name: "agentlink_download",
    label: "AgentLink Download",
    description: "Download an attachment from a received AgentLink message by fileCode. Saves into the working directory unless a path is given. Never overwrites existing files.",
    parameters: Type.Object({
      fileCode: Type.String(),
      path: Type.Optional(Type.String({ description: "Target directory or file path" })),
    }),
    annotations: { openWorldHint: true, destructiveHint: false },
    async execute(_id, p) {
      const cwd = ctxRef?.cwd ?? process.cwd();
      const r = await rest().download(p.fileCode, p.path ? path.resolve(cwd, p.path) : cwd + path.sep);
      return text(`Saved ${r.bytes} bytes to ${r.path} (sha256 ${r.sha256.slice(0, 12)}…)`, r);
    },
  });

  // ------------------------------------------------------------ user commands

  const cmd = (name: string, description: string, fn: (args: string, ctx: ExtensionContext) => Promise<string | void>) =>
    pi.registerCommand(name, {
      description,
      handler: async (args, ctx) => {
        ctxRef = ctx;
        try {
          const msg = await fn(args.trim(), ctx);
          if (msg) ctx.ui.notify(msg, "info");
        } catch (e) {
          ctx.ui.notify(`AgentLink: ${errMsg(e)}`, "error");
        }
      },
    });

  cmd("agentlink_login", "Sign in or create an account: /agentlink_login <email> [server]  then  /agentlink_code <6 digits>", async (args, ctx) => {
    const [email, serverArg] = args.split(/\s+/).filter(Boolean);
    if (!email) return "Usage: /agentlink_login <email> [server-url]";
    const server = serverArg ?? readCredentials()?.serverUrl ?? DEFAULT_SERVER;
    const r = await startEmailLogin(server, email);
    G.__agentlinkPendingEmail = { server, email: r.email };
    if (ctx.hasUI) {
      const code = await ctx.ui.input(`AgentLink code sent to ${r.email}`, "6-digit code");
      if (code) {
        const c = await verifyEmailLogin(server, r.email, code, os.hostname());
        G.__agentlinkPendingEmail = undefined;
        const file = saveAndConnect(c, ctx);
        return `${c.created ? "Account created" : "Signed in"} as ${c.email}. Device "${c.deviceName}" saved to ${file}.`;
      }
    }
    return `${r.newAccount ? "New account: " : ""}code sent to ${r.email}${r.delivery === "log" ? " (server has no SMTP; see server log)" : ""}. Run /agentlink_code <code>.`;
  });

  cmd("agentlink_code", "Finish email sign-in: /agentlink_code <6 digits>", async (args, ctx) => {
    const pending = G.__agentlinkPendingEmail;
    if (!pending) return "Run /agentlink_login <email> first.";
    if (!args) return "Usage: /agentlink_code <6 digits>";
    const c = await verifyEmailLogin(pending.server, pending.email, args, os.hostname());
    G.__agentlinkPendingEmail = undefined;
    const file = saveAndConnect(c, ctx);
    return `${c.created ? "Account created" : "Signed in"} as ${c.email}. Device "${c.deviceName}" saved to ${file}.`;
  });

  cmd("agentlink_join", "Add this device with a one-time code: /agentlink_join <server> <code> [device-name]", async (args, ctx) => {
    const [url, code, ...rest_] = args.split(/\s+/);
    if (!url || !code) return "Usage: /agentlink_join <server> <code> [device-name]";
    const c = await enroll(url, code, rest_.join(" ") || os.hostname());
    const file = saveAndConnect(c, ctx);
    return `Device "${c.deviceName}" joined account "${c.accountName}". Credentials saved to ${file}.`;
  });

  cmd("agentlink_signup", "Unverified signup (only servers with AGENTLINK_SIGNUP=open): /agentlink_signup <server> <account-name>", async (args, ctx) => {
    const [url, ...name] = args.split(/\s+/);
    if (!url || !name.length) return "Usage: /agentlink_signup <server> <account-name>";
    const c = await signup(url, name.join(" "), os.hostname());
    const file = saveAndConnect(c, ctx);
    return `Account "${c.accountName}" created; credentials saved to ${file}.`;
  });

  cmd("agentlink_status", "Show AgentLink connection, identity and usage", async () => {
    const c = readCredentials();
    if (!c) return "Not set up. Run /agentlink_login <email>.";
    const lines = [`Server: ${c.serverUrl}`, `Account: ${c.email ?? c.accountName ?? "?"}  Device: ${c.deviceName ?? c.deviceId}`, `Connection: ${client?.state ?? "off"}${client?.state === "online" ? ` (${client.mode})` : ""}`];
    if (client?.identity) lines.push(`Agent: ${client.identity.name}${client.identity.persistent ? " (persistent)" : " (ephemeral)"}  id ${client.identity.agentId}`);
    if (client?.lastError && client.state !== "online") lines.push(`Last error: ${client.lastError.message}`);
    try {
      const me = await rest().get("/v1/me");
      lines.push(`Messages this month: ${me.usage.used}${me.usage.limit > 0 ? `/${me.usage.limit}` : ""}  Online agents: ${me.onlineAgents}`);
      const info = await serverInfo(c.serverUrl);
      lines.push(`Server ${info.version}, signup=${info.signup}`);
    } catch (e) { lines.push(`Server: ${errMsg(e)}`); }
    return lines.join("\n");
  });

  cmd("agentlink_agents", "List reachable agents", async () => {
    const l = await (await online()).listAgents();
    const all = [...l.same.map((a) => `${a.name}${a.framework ? ` [${a.framework}]` : ""}${a.deviceName ? ` (${a.deviceName})` : ""}: ${a.activity}`), ...l.paired.map((a) => `${a.name} [${a.account}] ${a.agentId}: ${a.activity}`)];
    return all.length ? all.join("\n") : "No other agents.";
  });

  cmd("agentlink_online", "Connect to AgentLink", async (_a, ctx) => {
    G.__agentlinkStopped = false;
    const c = connect(ctx);
    await c.ready();
    return `Online as ${c.identity!.name} (${c.mode})`;
  });

  cmd("agentlink_offline", "Disconnect from AgentLink for this pi process", async (_a, ctx) => {
    G.__agentlinkStopped = true;
    client?.stop(); client = null;
    ctx.ui.setStatus("agentlink", undefined);
    return "Offline. Persistent agents still receive queued messages when back online.";
  });

  cmd("agentlink_invite_device", "One-time code to add another device to this account", async () => {
    const r = await rest().post("/v1/enrollments");
    const c = readCredentials()!;
    return `On the other device:\n  pi: /agentlink_join ${c.serverUrl} ${r.code}\n  shell: npx agentlink-pi join ${c.serverUrl} ${r.code}\n(or just sign in there with the same email)\nExpires ${new Date(r.expiresAt).toLocaleString()}.`;
  });

  cmd("agentlink_devices", "List devices in this account", async () => {
    const r = await rest().get("/v1/devices");
    return r.devices.map((d: any) => `${d.name}${d.current ? " (this device)" : ""}  ${d.id}  last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}`).join("\n");
  });

  cmd("agentlink_revoke_device", "Revoke a device: /agentlink_revoke_device <device-id>", async (args, ctx) => {
    if (!args) return "Usage: /agentlink_revoke_device <device-id>";
    if (ctx.hasUI && !(await ctx.ui.confirm("Revoke device?", `Device ${args} will be disconnected and must sign in again.`))) return "Cancelled.";
    await rest().del(`/v1/devices/${encodeURIComponent(args)}`);
    return `Revoked ${args}.`;
  });

  cmd("agentlink_pair_code", "Create a pair code so an agent on another account can talk to this agent", async () => {
    const r = await (await online()).createPairCode();
    return `Pair code: ${r.code}\nThe other side runs: /agentlink_pair ${r.code}\n(expires ${new Date(r.expiresAt).toLocaleTimeString()})`;
  });

  cmd("agentlink_pair", "Accept a pair code from another account: /agentlink_pair <code>", async (args) => {
    if (!args) return "Usage: /agentlink_pair <code>";
    const r = await (await online()).acceptPairCode(args);
    return `Paired with ${r.name} (account ${r.account}). Address it as ${r.agentId}.`;
  });

  cmd("agentlink_unpair", "Remove a pairing: /agentlink_unpair <agent-id>", async (args) => {
    if (!args) return "Usage: /agentlink_unpair <agent-id>";
    const r = await (await online()).unpair(args);
    return r.removed ? "Pairing removed." : "No such pairing.";
  });

  cmd("agentlink_logout", "Forget this device's credentials", async (_a, ctx) => {
    if (ctx.hasUI && !(await ctx.ui.confirm("Log out of AgentLink?", "This device's credentials will be deleted locally."))) return "Cancelled.";
    client?.stop(); client = null;
    clearCredentials();
    G.__agentlinkCredential = undefined;
    ctx.ui.setStatus("agentlink", undefined);
    return "Logged out. Revoke the device from another device if it was lost.";
  });
}
