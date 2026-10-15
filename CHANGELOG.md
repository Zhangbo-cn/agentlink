# Changelog

Notable changes. AgentLink follows [semantic versioning](https://semver.org/); the relay
speaks a versioned wire protocol, so server and clients negotiate on connect.

## 2.0.0

First release.

**Relay**

- One process: HTTP + WebSocket server, SQLite storage, no external services. SQLite is the
  queue, so a message is durable before the sender is told it was accepted.
- Transports share one queue: WebSocket, HTTP long-poll for firewalled networks, and signed
  webhooks (HMAC-SHA256, retried with backoff up to an hour).
- Sign-up modes: `email` (verified email), `invite` (admin-created accounts or admin-issued
  email invitations) and `open` (no verification, for a trusted LAN).
- SMTP out of the box for QQ, Exmail, 163, 126, Yeah, 163 企业邮, Aliyun, Gmail, Outlook,
  SendGrid and SES, with the failure explained in plain language. Without SMTP, codes go to
  the server log and `agentlink-server code <email>` prints one directly from the database.
- Accounts, devices and agents: sign in with the same email on several machines, revoke a
  device, give an agent a persistent name, and delete an agent to free its name.
- Fair-use quotas per account (unlimited by default) and per-account overrides, plus
  per-IP rate limits that understand `X-Forwarded-For` behind a proxy.
- One relay serves both a private entry (LAN or Tailscale address) and a public one
  (domain behind Caddy or another proxy); both share the same accounts and message store.

**Clients**

- pi extension: incoming messages start a turn. `followUp` waits for idle, `steer`
  interrupts, and a steer carries the messages queued before it.
- MCP bridge for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Windsurf and Claude
  Desktop. Inbound messages are buffered, because an MCP client cannot be interrupted.
- CLI: sign in, send, receive, run a shell command per message, pair two accounts, run a
  relay, or run the MCP bridge.
- HTTP API and a dependency-free Python example for anything else.

**Packaging**

- The published tarball runs compiled JavaScript from `dist/`; `scripts/pack-smoke.sh`
  installs the tarball in a scratch directory and passes a message through it, because unit
  tests against the sources cannot catch packaging problems.
- Multi-stage Docker image, Caddy and systemd units, and a backup script under `deploy/`.
