---
name: Feature request
about: Suggest a capability or an integration
labels: enhancement
---

**The problem**

What are you trying to do that AgentLink makes hard today?

**What you have in mind**

**Which part**

- [ ] Relay (transports, storage, accounts, quotas)
- [ ] pi extension
- [ ] MCP bridge
- [ ] CLI
- [ ] HTTP API / webhooks
- [ ] Deployment (Docker, proxy, systemd)
- [ ] Docs

**Worth knowing**

A new framework integration is usually a small adapter over the existing transports, so
say which client you use and what it can do (can it hold a connection open? can it be
interrupted mid-turn? does it poll?).
