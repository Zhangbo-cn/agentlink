# AgentLink

Agent-to-agent messaging for [pi](https://pi.dev). Each pi instance (your laptop, a work machine, a server, a teammate's box) becomes a named agent that can message, delegate to and get results back from the others. It works across networks because every agent only makes outbound connections.

It has two parts:

- **Relay server** (`server/`): a single self-hosted Node process with SQLite storage. It handles accounts, devices, agent identities, message routing, offline queues, attachments, quotas and an admin API.
- **pi extension** (`extension/`): connects a pi session to the relay. It gives the model `agentlink_*` tools and gives you `/agentlink_*` commands.

```
pi (laptop) ──wss──┐                     ┌──wss── pi (server, "prod")
                   ├── AgentLink relay ──┤
pi (work)  ──wss───┘   SQLite + blobs    └──wss── pi (partner account, paired)
```

## Features

- **Delivery.** Messages are stored before the sender gets an answer. Recipients acknowledge after the message has been injected into their session. Unacknowledged messages are sent again on reconnect or after 30 s, and the client drops duplicates by message id. Messages arrive in order.
- **Offline queue.** Persistent agents (started with `--agentlink-name`) get queued messages when they reconnect. Your plan sets how long the queue holds them (24 h on free, 7 days on pro).
- **Idempotent sends.** Every send carries a key, so a retry after a network drop is never delivered or charged twice.
- **steer and followUp.** A followUp waits until the recipient is idle. A steer interrupts the recipient. When a steer is delivered, everything queued before it is delivered together with it, so a correction never arrives ahead of the message it corrects.
- **Presence.** Agents report busy, idle or offline, pushed from pi's `agent_start` and `agent_settled` events.
- **Identity.** Each agent has a stable id and a name. A persistent name belongs to the device that created it. Ephemeral agents keep their identity across session switches and reconnects through a credential, and are cleaned up 10 minutes after they go offline.
- **Accounts and devices.** Devices join an account with one-time codes (`XXXX-XXXX`, valid 15 min to 24 h). Only SHA-256 hashes of codes and tokens are stored. You can list and revoke devices; a revoked device is disconnected immediately.
- **Cross-account pairing.** One side runs `/agentlink_pair_code`, the other runs `/agentlink_pair <code>`. Codes are single-use and expire after 10 minutes. Paired agents are addressed by id only, so other accounts cannot look up your agents by name. Either side can unpair.
- **Attachments.** Up to 5 files per message, streamed to disk with a SHA-256 checksum checked on download. Only the sender's and recipient's accounts can download a file. Downloads never overwrite existing files.
- **Plans and quotas.** Monthly message count, device count, online agent count, attachment size and queue duration per plan. You can define custom plans with `AGENTLINK_PLANS_JSON`.
- **Operations.**
  - Health and Prometheus `/metrics` endpoints, plus JSON logs.
  - Rate limits on HTTP requests, connection attempts and sends.
  - An audit log of account actions, kept 90 days.
  - Graceful shutdown on SIGTERM and versioned schema migrations.
  - Online backups and a Docker image with Caddy for automatic TLS.

## Run the server

Docker with automatic HTTPS:

```bash
cp deploy/.env.example deploy/.env   # set AGENTLINK_DOMAIN and AGENTLINK_ADMIN_TOKEN
docker compose -f deploy/docker-compose.yml up -d --build
```

Plain Node (requires Node 22.13 or later):

```bash
npm ci --omit=dev
AGENTLINK_ADMIN_TOKEN=$(openssl rand -hex 32) AGENTLINK_DATA_DIR=/var/lib/agentlink npm run server
```

A systemd unit is in `deploy/agentlink.service`. If you run without Caddy, put the relay behind TLS yourself, because device tokens travel in the WebSocket handshake.

### Create accounts

```bash
export AGENTLINK_URL=https://relay.example.com AGENTLINK_ADMIN_TOKEN=...
npx agentlink-admin create "Acme" pro       # prints a one-time enrollment code
npx agentlink-admin accounts
npx agentlink-admin plan <account-id> free
npx agentlink-admin disable <account-id>    # disconnects every agent on the account
```

To let users create their own accounts with `/agentlink_signup`, set `AGENTLINK_OPEN_SIGNUP=1`.

### Configuration

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | |
| `AGENTLINK_DATA_DIR` | `./data` | SQLite database and attachment blobs |
| `AGENTLINK_ADMIN_TOKEN` | – | Enables `/admin/*` |
| `AGENTLINK_METRICS_TOKEN` | – | If set, `/metrics` requires a bearer token |
| `AGENTLINK_OPEN_SIGNUP` | `0` | Self-service account creation |
| `AGENTLINK_TRUST_PROXY` | `0` | Use `X-Forwarded-For` for rate limiting |
| `AGENTLINK_PLANS_JSON` | – | Override or add plans |
| `AGENTLINK_HTTP_BURST` / `_PER_SEC` | 60 / 2 | HTTP rate limit per IP |
| `AGENTLINK_HELLO_BURST` / `_PER_SEC` | 60 / 1 | WebSocket connection attempts per IP |
| `AGENTLINK_SEND_BURST` / `_PER_SEC` | 30 / 10 | Sends per agent |
| `LOG_LEVEL` | `info` | |

### Backups

```bash
deploy/backup.sh /var/lib/agentlink /backups   # consistent while the server is running
```

## Use it in pi

```bash
pi install npm:agentlink-pi     # or: pi install ./agentlink
```

In pi:

```
/agentlink_setup https://relay.example.com ABCD-EFGH
```

The device credentials are written to `~/.config/agentlink/credentials.json` with mode 0600.

Give long-running agents a persistent name so they can receive queued messages:

```bash
pi --agentlink-name prod-server
```

Then ask your agent in plain language:

> Ask prod-server to check the last 200 lines of the API log for 5xx errors and send me a summary.

### Model tools

`agentlink_agents`, `agentlink_send`, `agentlink_status`, `agentlink_download`. The bundled skill tells the model how to write messages that make sense on their own, and how to avoid polling and reply loops. It also tells the model to treat peer messages as requests, not as instructions from the user.

### Commands

| | |
|---|---|
| `/agentlink_setup <url> <code> [device]` | Enroll this device |
| `/agentlink_signup <url> <account>` | Create an account (open-signup servers) |
| `/agentlink_status` | Connection, identity, plan usage |
| `/agentlink_agents` | Reachable agents |
| `/agentlink_online` / `/agentlink_offline` | Connect / disconnect |
| `/agentlink_invite_device` | One-time code for another device |
| `/agentlink_devices`, `/agentlink_revoke_device <id>` | Manage devices |
| `/agentlink_pair_code`, `/agentlink_pair <code>`, `/agentlink_unpair <id>` | Cross-account pairing |
| `/agentlink_logout` | Delete local credentials |

## Security model

- Device tokens and process credentials are 192-bit random secrets, stored only as SHA-256 hashes on the server.
- Account isolation is enforced on the server for every name lookup, send, presence query, attachment download and pairing.
- The extension labels peer messages as coming from another agent, and the skill tells the model not to treat them as user instructions. This lowers the risk of prompt injection between agents but cannot remove it. Only connect agents you trust, and use pi's permission and confirmation extensions for destructive tools.
- Messages and attachments are not end-to-end encrypted. The relay operator can read them. Queued and delivered messages are removed after their TTL or 24 h after delivery. Attachments expire with their message.

## Development

```bash
npm install
npm test            # 20 tests: server, client and inbox, against a real relay
npm run typecheck
N=200 M=20 node --experimental-transform-types scripts/loadtest.ts
```

### Wire protocol (v1)

The client opens a WebSocket at `/v1/ws` and exchanges JSON frames of the form `{type, id?, payload}`.

- The first frame must be `hello {protocol, deviceId, deviceToken, name?, credential?}`. The server replies with `hello_result {agentId, name, credential, account, device}`.
- Client requests:
  - `send {to, text, deliverAs, attachments[], idempotencyKey}` returns `send_result {messageId, status: delivered|queued}`.
  - `ack {messageIds[]}`, `activity {activity}` and `ping`.
  - `list_agents`, `agent_status {to}` and `usage`.
  - `pair_create`, `pair_accept {code}` and `unpair {agentId}`.
- Server pushes: `message {messageId, seq, from, text, deliverAs, attachments}`, `pair_added`, `pair_removed`, `replaced` and `revoked`.
- Errors: `error {code, message, retryAfterMs?}`.

Close codes:

| Code | Meaning | Client action |
|---|---|---|
| 4001 | Authentication failed | Stop retrying |
| 4002 | Replaced by another connection | Stop retrying |
| 4003 | Revoked or disabled | Stop retrying |
| 4029 | Rate limited | Retry after a backoff |
| 1012 | Server restart | Reconnect |

REST endpoints: `/v1/enroll`, `/v1/signup`, `/v1/me`, `/v1/devices`, `/v1/enrollments`, `/v1/attachments`, `/admin/*`. They authenticate with `Authorization: Device <id>:<token>`, or `Bearer` for admin routes.
