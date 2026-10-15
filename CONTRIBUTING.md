# Contributing

AgentLink is MIT-licensed and free. Contributions are welcome.

```bash
npm install          # also builds dist/ through `prepare`
npm test             # full suite (real relay, WebSocket, HTTP, webhooks, MCP bridge, CLI)
npm run check        # typecheck the server, SDK, CLI and the pi extension
npm run server       # local relay on :8787 (codes go to the log without SMTP)
bash scripts/pack-smoke.sh   # packs the tarball, installs it, passes a message through it
```

Guidelines:

- Node 22.13 or later. Sources are TypeScript and run directly with Node's type stripping, so
  there is no build step while developing. The published tarball ships compiled JavaScript in
  `dist/` because Node refuses to strip types for files inside `node_modules`.
- Keep runtime dependencies few (currently `ws`, `undici`, `https-proxy-agent` and `nodemailer`).
- Protocol changes must stay backward compatible within `PROTOCOL_VERSION`. Add new fields and do not repurpose existing ones.
- Every behaviour change needs a test in `test/`. If it can only break once the package is
  installed or built, put the check in `scripts/pack-smoke.sh` instead - the unit tests run
  against the sources and cannot see packaging problems.
