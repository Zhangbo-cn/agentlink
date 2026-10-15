#!/usr/bin/env node
// agentlink-admin: manage accounts on your AgentLink server.
//   AGENTLINK_URL=https://relay.example.com AGENTLINK_ADMIN_TOKEN=... agentlink-admin <command>
const url = (process.env.AGENTLINK_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const token = process.env.AGENTLINK_ADMIN_TOKEN;
const [cmd, ...args] = process.argv.slice(2);

const usage = `Usage:
  agentlink-admin accounts                          List accounts
  agentlink-admin create <email|name>               Create an account (invite-only servers); prints a device code
  agentlink-admin invite <email> [--days N]          Pre-approve an email to sign up by itself
  agentlink-admin invites                           List pending invitations
  agentlink-admin uninvite <email>                  Revoke an invitation
  agentlink-admin code <account-id>                 New one-time device code for an account
  agentlink-admin quota <account-id> <json|reset>   Per-account fair-use override, e.g. '{"monthlyMessages":0}'
  agentlink-admin disable <account-id>              Disable account and disconnect it
  agentlink-admin enable <account-id>               Re-enable account
  agentlink-admin usage <account-id>                Usage, devices and online agents

Env: AGENTLINK_URL (default http://localhost:8787), AGENTLINK_ADMIN_TOKEN (required)`;

async function call(method, path, body) {
  const res = await fetch(url + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    console.error(`Error ${res.status}: ${data.message ?? res.statusText}`);
    process.exit(1);
  }
  return data;
}

if (!cmd || cmd === "help" || cmd === "--help") { console.log(usage); process.exit(0); }
if (!token) { console.error("AGENTLINK_ADMIN_TOKEN is required"); process.exit(1); }

switch (cmd) {
  case "invite": {
    if (!args[0]) { console.log(usage); process.exit(1); }
    const days = Number(args[args.indexOf("--days") + 1]) || 7;
    const r = await call("POST", "/admin/invites", { email: args[0], ttlSec: Math.round(days * 86400) });
    console.log(`Invited ${r.email} until ${new Date(r.expiresAt).toISOString()}`);
    console.log(`They can now sign up themselves: agentlink login ${url} --email ${r.email}`);
    break;
  }
  case "invites": {
    const { invites } = await call("GET", "/admin/invites");
    if (!invites.length) console.log("(no pending invitations)");
    for (const i of invites) console.log(`${i.email}  until ${new Date(i.expires_at).toISOString()}${i.expires_at < Date.now() ? "  EXPIRED" : ""}`);
    break;
  }
  case "uninvite": {
    const r = await call("DELETE", `/admin/invites/${encodeURIComponent(args[0] ?? "")}`);
    console.log(r.removed ? `Revoked invitation for ${args[0]}` : `No invitation for ${args[0]}`);
    break;
  }
  case "accounts": {
    const { accounts } = await call("GET", "/admin/accounts");
    for (const a of accounts) console.log(`${a.id}  ${a.disabled ? "DISABLED " : ""}${String(a.devices).padStart(3)} dev  ${a.email ?? "-"}  ${a.name}`);
    break;
  }
  case "create": {
    if (!args[0]) { console.log(usage); process.exit(1); }
    const isEmail = args[0].includes("@");
    const r = await call("POST", "/admin/accounts", isEmail ? { email: args[0], name: args[0].split("@")[0] } : { name: args[0] });
    console.log(`Account ${r.account.id} (${r.account.name}${r.account.email ? `, ${r.account.email}` : ""})`);
    if (isEmail) console.log(`They can now sign in with: agentlink login ${url} --email ${r.account.email}`);
    console.log(`Or add a device with code ${r.enrollment.code}: agentlink join ${url} ${r.enrollment.code}`);
    break;
  }
  case "code": {
    const r = await call("POST", `/admin/accounts/${args[0]}/enrollments`, {});
    console.log(`Device code: ${r.code}  (expires ${new Date(r.expiresAt).toISOString()})\n  agentlink join ${url} ${r.code}`);
    break;
  }
  case "quota": {
    const q = args[1] === "reset" ? null : JSON.parse(args[1] ?? "{}");
    console.log((await call("PATCH", `/admin/accounts/${args[0]}`, { quotas: q })).account);
    break;
  }
  case "disable": console.log((await call("PATCH", `/admin/accounts/${args[0]}`, { disabled: true })).account); break;
  case "enable": console.log((await call("PATCH", `/admin/accounts/${args[0]}`, { disabled: false })).account); break;
  case "usage": console.log(JSON.stringify(await call("GET", `/admin/accounts/${args[0]}/usage`), null, 2)); break;
  default: console.log(usage); process.exit(1);
}
