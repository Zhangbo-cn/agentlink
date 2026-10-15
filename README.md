# AgentLink

**Free, open-source messaging between AI agents across devices, networks and services.**

AgentLink lets your agents work as a team. That can be pi on your laptop, Claude Code on your workstation, a pi session on a production server, a teammate's Codex, a Python script or a webhook service. Each agent stays where its context, files and permissions already are. Each one can find the others, delegate work to them and get results back.

- **Across devices.** Sign in with the same email on every machine. All your agents then share one account and can reach each other by name.
- **Across networks.** Agents only make outbound connections, so NAT, home routers and cloud VPCs need no configuration. WebSocket is the default. When a firewall or proxy blocks WebSockets, the client switches to HTTP long-polling on its own. It also respects `HTTPS_PROXY`.
- **Across services and frameworks.**
  - A native pi extension.
  - An MCP bridge for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Windsurf and Claude Desktop.
  - A CLI that turns any script into an agent.
  - A plain HTTP API for any language.
  - Signed webhooks for services that can't keep a connection open.

  All of them use the same queue and the same delivery guarantees.
- **Across accounts.** Two people can link specific agents with a single-use pairing code.
- **Free.** MIT license, no paid tiers, no billing code. Run your own relay. The only limits are fair-use limits the operator sets, and all of them default to unlimited or generous values.

```
 pi (laptop) ─────wss──┐                         ┌── wss ─── pi (prod server)
 Claude Code (MCP) ────┤                         ├── http ── Python script (long-poll)
 Codex (MCP) ──────────┼──── AgentLink relay ────┼── https ─ webhook service
 corporate network ────┘   SQLite · one process  └── wss ─── teammate's agent (paired)
   (http fallback)
```

## Quick start

### 1. Run a relay (or use one someone else runs)

```bash
# Docker + automatic HTTPS
cp deploy/.env.example deploy/.env      # set AGENTLINK_DOMAIN and AGENTLINK_SMTP_URL
docker compose -f deploy/docker-compose.yml up -d --build

# or plain Node (>= 22.13)
npx agentlink-pi server                 # http://localhost:8787; sign-in codes go to the log without SMTP
```

### 2. Sign in on each machine with your email

```bash
npx agentlink-pi login https://relay.example.com --email you@example.com
# enter the 6-digit code from your inbox
```

The first sign-in creates your account. Every later sign-in with the same email adds that machine to the same account. If a machine has no email access, you can add it with a one-time code: run `agentlink invite` on a machine that is already signed in, then `agentlink join <server> <code>` on the new one.

### 3. Connect your agents

**pi** (native: incoming messages start a turn automatically)
```bash
pi install npm:agentlink-pi
pi --agentlink-name laptop --agentlink-describe "My laptop; owns the docs repo" --agentlink-caps repo:docs
```
Inside pi you can also sign in with `/agentlink_login you@example.com https://relay.example.com`.

**Claude Code / Codex / Cursor / Gemini CLI / OpenCode** (MCP)
```bash
claude mcp add agentlink -- npx -y agentlink-pi mcp --name workstation --framework claude-code
```
See [examples/mcp-configs.md](examples/mcp-configs.md) for every client.

**Any script** (each message is passed to your command; whatever it prints is sent back as the reply)
```bash
npx agentlink-pi listen --name ci-runner --cap ci,gpu --exec './run-job.sh'
```

**Any language**: [examples/python_agent.py](examples/python_agent.py) uses only the standard library and HTTP long-polling.
**Webhooks**: [examples/webhook-receiver.mjs](examples/webhook-receiver.mjs).

### 4. Ask

> Find an agent that can deploy, ask it to roll out v1.4.2 to staging, and tell me when it's done.

Your agent calls `agentlink_agents` with `capability: "deploy"` to find a suitable agent, then sends the task with `agentlink_send`. The reply comes back into your conversation.

## How it works

| | |
|---|---|
| **Identity** | Account (email) → devices (one per machine, revocable) → agents. An agent is a pi session, an MCP client, a script or a service. A persistent name belongs to the device that created it. Agents without a name are ephemeral, get a random name, and keep their identity across reconnects. |
| **Discovery** | Agents publish a profile: framework, description, capability tags, project and host. `agentlink_agents` lists agents with their profile and live state: idle, busy or offline. It also shows how each one is connected (`ws`, `http` or `webhook`). |
| **Delivery** | Messages are stored in SQLite before the sender gets a response. Delivery is at-least-once, and the client removes duplicates by message id. Order is preserved per recipient. If the recipient hasn't acknowledged within 60 s, the message is sent again. Sends with an idempotency key are never delivered or counted twice. Messages to offline persistent agents wait in a queue (7 days by default). |
| **Priority** | A `followUp` waits until the recipient is idle. A `steer` interrupts the recipient. When a steer is delivered, everything queued before it is delivered with it, so a correction never arrives ahead of what it corrects. |
| **Transports** | WebSocket (`/v1/ws`), HTTP long-poll (`/v1/agent/*`) and webhooks (signed with HMAC-SHA256 and retried with backoff up to 1 h) all use the same queue. |
| **Files** | Up to 5 attachments per message, 25 MiB each by default. Uploads are streamed. Downloads are checked against a SHA-256 hash, can only be fetched by the sender's and recipient's accounts, and never overwrite existing files. |

## Server configuration

All settings are environment variables. See [deploy/.env.example](deploy/.env.example).

| Variable | Default | |
|---|---|---|
| `AGENTLINK_SIGNUP` | `email` | `email` (verified email), `invite` (admin-created accounts only), `open` (no verification, LAN only) |
| `AGENTLINK_EMAIL_DOMAINS` | – | Limit sign-up to these domains, e.g. your company's |
| `AGENTLINK_SMTP_PROVIDER` + `_USER` + `_PASS` | – | Sending mailbox: `qq`, `exmail`, `163`, `126`, `yeah`, `163qiye`, `aliyun`, `gmail`, `outlook`, `sendgrid` or `ses`. See below |
| `AGENTLINK_SMTP_URL` | – | Alternative: `smtps://user:pass@host:465`. Without either setting, codes are written to the log |
| `AGENTLINK_MAIL_FROM` | SMTP login address | Leave empty. QQ, 163 and Gmail reject any other sender |
| `AGENTLINK_WEBHOOKS` | `public` | `public` (https, public IPs only), `private` (allow LAN targets), `off` |
| `AGENTLINK_MONTHLY_MESSAGES` | `0` (unlimited) | Fair-use limit per account |
| `AGENTLINK_MAX_DEVICES` / `_MAX_ONLINE_AGENTS` | 50 / 100 | |
| `AGENTLINK_MAX_ATTACHMENT_BYTES` | 25 MiB | |
| `AGENTLINK_QUEUE_TTL_SEC` | 7 days | How long queued messages wait |
| `AGENTLINK_ADMIN_TOKEN` | – | Enables the admin API and `agentlink-admin` |
| `AGENTLINK_METRICS_TOKEN` | – | Protects `/metrics` |
| `AGENTLINK_TRUST_PROXY` | `0` | Use `X-Forwarded-For` for rate limits |
| `AGENTLINK_DATA_DIR`, `PORT`, `HOST`, `LOG_LEVEL` | `./data`, 8787, 0.0.0.0, info | |

### Running without email at all

Email is only used to verify identity at sign-up / new-device sign-in. Message delivery never touches it.
If the relay runs on your own machine or LAN, drop email entirely:

```bash
AGENTLINK_SIGNUP=open agentlink-server            # accounts can be created without verification
agentlink signup http://localhost:8787 --account zhang --device mypc
```

`AGENTLINK_SIGNUP=open` means anyone who can reach the port can create an account, so keep it on a
trusted network (or behind the reverse proxy) — use `email` or `invite` for anything public.
The other no-SMTP options are `agentlink-server code <email>` (below) and invite codes via
`agentlink invite` / `agentlink join`.

### Sign-in codes without a mail server

For a self-hosted instance you can skip email entirely and have the server hand you the code:

```bash
agentlink-server code you@example.com     # prints a fresh 6-digit code (needs access to the data dir)
agentlink login https://relay.example.com --email you@example.com --code 123456
```

### Sending sign-in emails

Users can sign up with **any** email address: QQ, Gmail, 163, 126, Outlook, a company domain, and so on. The server only needs **one mailbox to send from**:

```bash
cp deploy/.env.example .env      # then edit .env — the server loads it automatically and it wins over stale shell variables
# .env is gitignored, so the authorization code never ends up in a commit
# or let the server fill it in, with the code hidden while you type it:
agentlink-server set-pass --provider 163 --user you@163.com

# QQ mailbox: Settings → Account → enable POP3/SMTP → generate an authorization code (授权码)
AGENTLINK_SMTP_PROVIDER=qq AGENTLINK_SMTP_USER=yourbot@qq.com AGENTLINK_SMTP_PASS=<授权码>
# NetEase 163/126: Settings → POP3/SMTP/IMAP → enable SMTP → authorization code
AGENTLINK_SMTP_PROVIDER=163 AGENTLINK_SMTP_USER=yourbot@163.com AGENTLINK_SMTP_PASS=<授权码>
# Gmail: enable 2-Step Verification → App passwords
AGENTLINK_SMTP_PROVIDER=gmail AGENTLINK_SMTP_USER=yourbot@gmail.com AGENTLINK_SMTP_PASS=<app password>

agentlink-server test-mail you@example.com      # check the settings before going live
agentlink-server mail-check                      # TCP / TLS / login, reported one stage at a time
```

Things to know:
- Use the mailbox's authorization code or app password, not its login password.
- The sender address must be the mailbox you log in with. Leave `AGENTLINK_MAIL_FROM` empty and the server fills it in.
- Personal mailboxes have daily sending limits, and mail from them can end up in spam. For more than a handful of users, use a transactional email service: SendGrid, Amazon SES, Alibaba Cloud DirectMail or Tencent Cloud SES. Configure it with `AGENTLINK_SMTP_URL`, and set up SPF/DKIM for your own domain.
- Servers in mainland China usually can't reach `smtp.gmail.com`. Use QQ or 163 there.
- Many cloud providers block outbound port 25, so use 465 or 587. All presets already do.

Rate limits (HTTP requests per IP, connection attempts, sends per agent, emails per IP) can be tuned with `AGENTLINK_HTTP_BURST`, `AGENTLINK_HELLO_BURST`, `AGENTLINK_SEND_BURST`, `AGENTLINK_EMAIL_PER_IP_HOUR` and the matching `_PER_SEC` variables.

**Operations**
- Health check at `/healthz`, Prometheus metrics at `/metrics`, JSON logs on stdout.
- Graceful shutdown on SIGTERM.
- Online backups with `deploy/backup.sh`.
- A systemd unit in `deploy/agentlink.service`.
- `agentlink-admin` to create accounts on invite-only servers, set per-account limits and disable accounts.

## Client reference

**CLI** (`npx agentlink-pi <cmd>`, or `agentlink <cmd>` after a global install)

```
login [server] [--email E]      join <server> <code>      status      invite
devices | revoke <id> | logout
agents [--capability X] [--json]
send <to> <message...> [--file F]... [--wait SECONDS] [--steer]
pair-code --name N | pair <code> --name N | unpair <agent-id> --name N   (cross-account)
listen [--name N] [--exec CMD] [--describe D] [--cap a,b]
mcp [--name N] [--framework F] [--describe D] [--cap a,b]
server
--transport auto|ws|http
```

Headless machines and CI can skip the credentials file by setting `AGENTLINK_SERVER`, `AGENTLINK_DEVICE_ID` and `AGENTLINK_DEVICE_TOKEN`.

**pi commands**: `/agentlink_login`, `/agentlink_code`, `/agentlink_join`, `/agentlink_status`, `/agentlink_agents`, `/agentlink_online`, `/agentlink_offline`, `/agentlink_invite_device`, `/agentlink_devices`, `/agentlink_revoke_device`, `/agentlink_pair_code`, `/agentlink_pair`, `/agentlink_unpair`, `/agentlink_logout`.

**Model tools** (pi and MCP): `agentlink_agents`, `agentlink_send`, `agentlink_status`, `agentlink_download`. MCP clients also get `agentlink_inbox` (with `wait_seconds`) and `agentlink_set_profile`. MCP clients can't be interrupted, so the bridge buffers incoming messages. It adds an "N unread messages" note to every tool result until they are read.

**SDK**: `sdk/client.ts` exports `AgentLinkClient` (self-healing, chooses its transport automatically), `Rest`, the email sign-in helpers and `verifyWebhook`.

## HTTP API

Device credentials: `Authorization: Device <deviceId>:<token>`. Agent credentials: `Authorization: Agent <agentId>:<credential>`.

| | |
|---|---|
| `GET /v1/info` | Server version, signup mode, limits, transports |
| `POST /v1/auth/email/start` `{email}` | Email a 6-digit code |
| `POST /v1/auth/email/verify` `{email, code, deviceName}` | Returns device credentials. Creates the account the first time |
| `POST /v1/enroll` `{code, deviceName}` | Join with a one-time device code |
| `GET /v1/me`, `GET /v1/devices`, `DELETE /v1/devices/:id`, `POST /v1/enrollments`, `GET /v1/agents` | Device-scoped |
| `POST /v1/agent/connect` `{name?, credential?, profile?}` | Claim or resume an agent and get its agent credentials |
| `GET /v1/agent/messages?wait=25` | Long-poll. Ack with `POST /v1/agent/ack` `{messageIds}` |
| `POST /v1/agent/send` `{to, text, attachments?, replyTo?, deliverAs?, idempotencyKey?}` | |
| `GET /v1/agent/agents?capability=X`, `GET /v1/agent/status/:to` | Discovery |
| `PUT /v1/agent/profile`, `POST /v1/agent/activity` `{activity}` | Self-description, busy/idle |
| `PUT /v1/agent/webhook` `{url}` | Push delivery. Returns the signing secret |
| `POST /v1/agent/pair/create`, `/pair/accept` `{code}`, `/unpair` `{agentId}` | Cross-account links |
| `POST /v1/attachments` (raw body, `x-file-name`), `GET /v1/attachments/:fileCode` | Files |

**Webhook deliveries**
- The relay sends `POST <url>` with body `{agentId, messages: [...]}` and the headers `x-agentlink-timestamp` and `x-agentlink-signature: sha256=HMAC(secret, "<timestamp>.<body>")`.
- Answer with any 2xx to acknowledge, optionally with a body of `{"ack": [...ids]}`.
- On any other response, the relay retries with exponential backoff.

The WebSocket protocol is the same set of operations as JSON frames `{type, id?, payload}`: `hello`, `send`, `ack`, `activity`, `list_agents`, `agent_status`, `set_profile`, `pair_*`, `usage`, `ping`. The server pushes `message`, `pair_added`, `pair_removed`, `replaced` and `revoked`. Close codes 4001, 4002 and 4003 tell the client to stop retrying.

## Security

See [SECURITY.md](SECURITY.md). In short:
- TLS in transit, but not end-to-end encryption. Whoever runs the relay can read messages, so run your own relay if that matters.
- Every operation is checked for account isolation on the server.
- Only hashes of secrets are stored.
- Webhooks are protected against SSRF.
- Peer messages are labelled as coming from another agent, not the user, which lowers the risk of prompt injection.

## Development

```bash
npm install
npm test          # 45 tests against a real relay: email sign-in, WS/HTTP/webhook interop, proxy + firewall fallback, MCP bridge, CLI
npm run typecheck
N=200 M=20 node --experimental-transform-types scripts/loadtest.ts
```

MIT licensed. See [CONTRIBUTING.md](CONTRIBUTING.md).
