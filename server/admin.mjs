#!/usr/bin/env node
// agentlink-admin: manage accounts on an AgentLink server via the admin API.
//   AGENTLINK_URL=https://relay.example.com AGENTLINK_ADMIN_TOKEN=... agentlink-admin <command>
const url = (process.env.AGENTLINK_URL ?? "http://localhost:8787").replace(/\/+$/, "");
const token = process.env.AGENTLINK_ADMIN_TOKEN;
const [cmd, ...args] = process.argv.slice(2);

const usage = `Usage:
  agentlink-admin accounts                         List accounts
  agentlink-admin create <name> [plan]             Create account; prints a one-time enrollment code
  agentlink-admin code <account-id>                New enrollment code for an account
  agentlink-admin plan <account-id> <plan>         Change plan (free|pro|custom)
  agentlink-admin disable <account-id>             Disable account and disconnect it
  agentlink-admin enable <account-id>              Re-enable account
  agentlink-admin usage <account-id>               Usage, devices and online agents

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
  case "accounts": {
    const { accounts } = await call("GET", "/admin/accounts");
    for (const a of accounts) console.log(`${a.id}  ${a.plan.padEnd(6)} ${a.disabled ? "DISABLED " : ""}${a.devices} dev  ${a.name}`);
    break;
  }
  case "create": {
    if (!args[0]) { console.log(usage); process.exit(1); }
    const r = await call("POST", "/admin/accounts", { name: args[0], plan: args[1] });
    console.log(`Account ${r.account.id} (${r.account.name}, ${r.account.plan})`);
    console.log(`Enrollment code: ${r.enrollment.code}  (expires ${new Date(r.enrollment.expiresAt).toISOString()})`);
    console.log(`In pi: /agentlink_setup ${url} ${r.enrollment.code}`);
    break;
  }
  case "code": {
    const r = await call("POST", `/admin/accounts/${args[0]}/enrollments`, {});
    console.log(`Enrollment code: ${r.code}  (expires ${new Date(r.expiresAt).toISOString()})`);
    console.log(`In pi: /agentlink_setup ${url} ${r.code}`);
    break;
  }
  case "plan": console.log((await call("PATCH", `/admin/accounts/${args[0]}`, { plan: args[1] })).account); break;
  case "disable": console.log((await call("PATCH", `/admin/accounts/${args[0]}`, { disabled: true })).account); break;
  case "enable": console.log((await call("PATCH", `/admin/accounts/${args[0]}`, { disabled: false })).account); break;
  case "usage": console.log(JSON.stringify(await call("GET", `/admin/accounts/${args[0]}/usage`), null, 2)); break;
  default: console.log(usage); process.exit(1);
}
