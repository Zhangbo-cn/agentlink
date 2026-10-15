/**
 * AgentLink — agent-to-agent messaging for pi.
 * Connects this pi session to an AgentLink relay so other agents (other machines, repos,
 * servers, or paired accounts) can message it, and it can message them.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  AgentLinkClient, AgentLinkError, Rest, enroll, signup, readCredentials, writeCredentials, clearCredentials,
  type ConnState, type Credentials, type Identity, type WireMessage,
} from "./src/client.ts";
import { Inbox, formatDelivery, type Delivery } from "./src/inbox.ts";

const MESSAGE_TYPE = "agentlink-message";
const MAX_FILES = 5;

// Survives session switches inside one pi process so the agent keeps its name.
const G = globalThis as typeof globalThis & { __agentlinkCredential?: string; __agentlinkStopped?: boolean };

export default function agentlink(pi: ExtensionAPI) {
  pi.registerFlag("agentlink-name", { type: "string", description: "Persistent AgentLink name for this agent (e.g. prod-server). Default: random ephemeral name." });
  pi.registerFlag("agentlink-off", { type: "boolean", default: false, description: "Do not connect to AgentLink automatically" });

  let client: AgentLinkClient | null = null;
  let creds: Credentials | null = null;
  let ctxRef: ExtensionContext | null = null;
  let busy = false;
  const inbox = new Inbox(deliver);

  function agentName(): string | undefined {
    const flag = pi.getFlag("agentlink-name");
    const v = (typeof flag === "string" && flag) || process.env.AGENTLINK_NAME || "";
    return v.trim().toLowerCase() || undefined;
  }

  function deliver(d: Delivery): void {
    pi.sendMessage(
      { customType: MESSAGE_TYPE, content: formatDelivery(d), display: true, details: { messageIds: d.messages.map((m) => m.messageId), from: [...new Set(d.messages.map((m) => m.from.name))] } },
      { triggerTurn: true, deliverAs: d.deliverAs },
    );
    // The message is now in the session; acknowledge so the server stops redelivering.
    client?.ack(d.messages.map((m) => m.messageId));
  }

  function statusText(s: ConnState, id?: Identity, err?: AgentLinkError): string | undefined {
    switch (s) {
      case "online": return `⇄ ${id?.name}`;
      case "connecting": return "⇄ connecting…";
      case "reconnecting": return "⇄ reconnecting…";
      case "blocked": return `⇄ blocked: ${err?.code ?? "error"}`;
      default: return undefined;
    }
  }

  function connect(ctx: ExtensionContext | null): AgentLinkClient {
    if (client && client.state !== "stopped") return client;
    creds = readCredentials();
    if (!creds) throw new AgentLinkError("not_configured", "AgentLink is not set up. Run /agentlink_setup <server-url> <enrollment-code> (or /agentlink_signup).");
    const c = new AgentLinkClient({ credentials: creds, name: agentName(), credential: G.__agentlinkCredential });
    c.onIdentity = (id) => { G.__agentlinkCredential = id.credential; };
    c.onState = (s, err) => {
      ctxRef?.ui.setStatus("agentlink", statusText(s, c.identity, err));
      if (s === "blocked" && err) ctxRef?.ui.notify(`AgentLink: ${err.message}`, "error");
      if (s === "online") c.setActivity(busy ? "busy" : "idle");
    };
    c.onMessage = (m: WireMessage) => inbox.push(m);
    c.onEvent = (type, p) => {
      if (type === "pair_added") ctxRef?.ui.notify(`AgentLink: now paired with ${p.name} (${p.account})`, "info");
      if (type === "pair_removed") ctxRef?.ui.notify(`AgentLink: ${p.name} removed the pairing`, "warning");
    };
    client = c;
    ctxRef = ctx ?? ctxRef;
    c.start();
    return c;
  }

  async function online(): Promise<AgentLinkClient> {
    const c = connect(ctxRef);
    await c.ready(10_000);
    return c;
  }

  function rest(): Rest {
    creds = creds ?? readCredentials();
    if (!creds) throw new AgentLinkError("not_configured", "AgentLink is not set up. Run /agentlink_setup <server-url> <enrollment-code>.");
    return new Rest(creds);
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

  // ------------------------------------------------------------ tools (model-facing)

  pi.registerTool({
    name: "agentlink_agents",
    label: "AgentLink Agents",
    description: "List agents this agent can message over AgentLink (same account and paired external agents), with online/busy/idle state.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async execute() {
      const c = await online();
      const { same, paired } = await c.listAgents();
      const fmt = (a: any) => `- ${a.account ? a.agentId : a.name}${a.account ? ` "${a.name}" (account ${a.account})` : ""}${a.deviceName ? ` on ${a.deviceName}` : ""}: ${a.activity}${a.persistent ? "" : a.account ? "" : " (ephemeral)"}`;
      const lines = [`You are "${c.identity!.name}" on ${c.identity!.device.name}.`];
      lines.push(same.length ? `Same account:\n${same.map(fmt).join("\n")}` : "Same account: no other agents.");
      if (paired.length) lines.push(`Paired external (address by id):\n${paired.map(fmt).join("\n")}`);
      return text(lines.join("\n"), { same, paired });
    },
  });

  pi.registerTool({
    name: "agentlink_send",
    label: "AgentLink Send",
    description:
      "Send a message to another agent by name (same account) or agent id (paired external). Returns immediately; any reply arrives later as a new AgentLink message. " +
      "Messages to persistent agents that are offline are queued and delivered when they reconnect.",
    promptSnippet: "agentlink_send: message another pi agent on a different machine/repo/server",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient agent name or agent id" }),
      message: Type.String({ description: "Self-contained message: goal, context, constraints, what to send back" }),
      files: Type.Optional(Type.Array(Type.String({ description: "Local file path" }), { maxItems: MAX_FILES, description: "Files to attach" })),
      deliverAs: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")], { description: "followUp (default) waits until the recipient is free. steer interrupts: only for urgent corrections." })),
    }),
    annotations: { openWorldHint: true, destructiveHint: false },
    async execute(_id, p, signal) {
      const c = await online();
      const files = p.files ?? [];
      if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} attachments`);
      const r = rest();
      const uploaded: string[] = [];
      for (const f of files) {
        if (signal?.aborted) throw new Error("Cancelled");
        const abs = path.resolve(ctxRef?.cwd ?? process.cwd(), f);
        uploaded.push((await r.upload(abs)).attachmentId);
      }
      const res = await c.send(p.to, p.message, { deliverAs: p.deliverAs, attachments: uploaded });
      const where = res.status === "delivered" ? "Delivered" : `Queued (recipient offline; held until ${new Date(res.expiresAt).toISOString()})`;
      return text(`${where} to ${res.recipient.name}${uploaded.length ? ` with ${uploaded.length} attachment(s)` : ""}. Do not poll; a reply will arrive as a message.`, { ...res, attachments: uploaded.length });
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
      return text(`${s.name}: ${s.activity}`, s as any);
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
      const target = p.path ? path.resolve(cwd, p.path) : cwd + path.sep;
      const r = await rest().download(p.fileCode, target);
      return text(`Saved ${r.bytes} bytes to ${r.path} (sha256 ${r.sha256.slice(0, 12)}…)`, r);
    },
  });

  // ------------------------------------------------------------ commands (user-facing)

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

  cmd("agentlink_setup", "Enroll this device: /agentlink_setup <server-url> <enrollment-code> [device-name]", async (args, ctx) => {
    const [url, code, ...rest_] = args.split(/\s+/);
    if (!url || !code) return "Usage: /agentlink_setup <server-url> <enrollment-code> [device-name]";
    const c = await enroll(url.replace(/\/+$/, ""), code, rest_.join(" ") || os.hostname());
    const file = writeCredentials(c);
    client?.stop(); client = null; G.__agentlinkStopped = false;
    connect(ctx);
    return `Device "${c.deviceName}" enrolled in account "${c.accountName}". Credentials saved to ${file}.`;
  });

  cmd("agentlink_signup", "Create an account on an open-signup server: /agentlink_signup <server-url> <account-name>", async (args, ctx) => {
    const [url, ...name] = args.split(/\s+/);
    if (!url || !name.length) return "Usage: /agentlink_signup <server-url> <account-name>";
    const c = await signup(url.replace(/\/+$/, ""), name.join(" "), os.hostname());
    const file = writeCredentials(c);
    client?.stop(); client = null; G.__agentlinkStopped = false;
    connect(ctx);
    return `Account "${c.accountName}" created; this device is enrolled. Credentials saved to ${file}.`;
  });

  cmd("agentlink_status", "Show AgentLink connection, identity and usage", async () => {
    const c = readCredentials();
    if (!c) return "Not set up. Run /agentlink_setup <server-url> <enrollment-code>.";
    const lines = [`Server: ${c.serverUrl}`, `Account: ${c.accountName ?? "?"}  Device: ${c.deviceName ?? c.deviceId}`, `Connection: ${client?.state ?? "off"}`];
    if (client?.identity) lines.push(`Agent: ${client.identity.name}${client.identity.persistent ? " (persistent)" : " (ephemeral)"}  id ${client.identity.agentId}`);
    if (client?.lastError && client.state !== "online") lines.push(`Last error: ${client.lastError.message}`);
    try {
      const me = await rest().get("/v1/me");
      lines.push(`Plan: ${me.account.plan}  Messages this month: ${me.usage.used}/${me.usage.limit}  Online agents: ${me.onlineAgents}/${me.limits.maxOnlineAgents}`);
    } catch (e) { lines.push(`Server: ${errMsg(e)}`); }
    return lines.join("\n");
  });

  cmd("agentlink_agents", "List reachable agents", async () => {
    const { same, paired } = await (await online()).listAgents();
    const all = [...same.map((a) => `${a.name}${a.deviceName ? ` (${a.deviceName})` : ""}: ${a.activity}`), ...paired.map((a) => `${a.name} [${a.account}] ${a.agentId}: ${a.activity}`)];
    return all.length ? all.join("\n") : "No other agents.";
  });

  cmd("agentlink_online", "Connect to AgentLink", async (_a, ctx) => {
    G.__agentlinkStopped = false;
    const c = connect(ctx);
    await c.ready();
    return `Online as ${c.identity!.name}`;
  });

  cmd("agentlink_offline", "Disconnect from AgentLink for this pi process", async (_a, ctx) => {
    G.__agentlinkStopped = true;
    client?.stop(); client = null;
    ctx.ui.setStatus("agentlink", undefined);
    return "Offline. Persistent agents will receive queued messages when back online.";
  });

  cmd("agentlink_invite_device", "Create a one-time code to enroll another device into this account", async () => {
    const r = await rest().post("/v1/enrollments");
    const c = readCredentials()!;
    return `On the other device run:\n/agentlink_setup ${c.serverUrl} ${r.code}\n(expires ${new Date(r.expiresAt).toLocaleString()})`;
  });

  cmd("agentlink_devices", "List devices in this account", async () => {
    const r = await rest().get("/v1/devices");
    return r.devices.map((d: any) => `${d.name}${d.current ? " (this device)" : ""}  ${d.id}  last seen ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never"}`).join("\n");
  });

  cmd("agentlink_revoke_device", "Revoke a device: /agentlink_revoke_device <device-id>", async (args, ctx) => {
    if (!args) return "Usage: /agentlink_revoke_device <device-id>";
    if (ctx.hasUI && !(await ctx.ui.confirm("Revoke device?", `Device ${args} will be disconnected and must re-enroll.`))) return "Cancelled.";
    await rest().del(`/v1/devices/${encodeURIComponent(args)}`);
    return `Revoked ${args}.`;
  });

  cmd("agentlink_pair_code", "Create a pair code so an agent on another account can talk to this agent", async () => {
    const r = await (await online()).createPairCode();
    return `Pair code: ${r.code}\nThe other agent's user runs: /agentlink_pair ${r.code}\n(expires ${new Date(r.expiresAt).toLocaleTimeString()})`;
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
    return "Logged out. The device stays listed until revoked from another device or by an admin.";
  });

  void fs;
}
