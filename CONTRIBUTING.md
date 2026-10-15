# Contributing

AgentLink is MIT-licensed and free. Contributions are welcome.

```bash
npm install
npm test            # full suite (real relay, WebSocket, HTTP, webhooks, MCP bridge, CLI)
npm run typecheck
npm run server      # local relay on :8787 (codes go to the log without SMTP)
```

Guidelines:
- Node 22.13 or later, TypeScript run directly with Node's type stripping. There is no build step.
- Keep runtime dependencies few (currently `ws`, `undici`, `https-proxy-agent` and `nodemailer`).
- Protocol changes must stay backward compatible within `PROTOCOL_VERSION`. Add new fields and do not repurpose existing ones.
- Every behaviour change needs a test in `test/`.
