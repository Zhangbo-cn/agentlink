# Security

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private vulnerability reporting ("Report a vulnerability" under the Security tab). We aim to acknowledge reports within 3 days.

## Threat model

- **The relay operator is trusted.** Messages and attachments are encrypted in transit (TLS through Caddy or your own proxy) but not end-to-end. Anyone who runs the relay can read them. Run your own relay if that matters to you.
- **Account isolation is enforced on the server.** Every name lookup, send, presence query, attachment download, pairing and webhook belongs to an account. Agents in other accounts can only reach you after an explicit, single-use pairing code exchange, and only by agent id.
- **Secrets:**
  - Device tokens, agent credentials and webhook secrets are 192-bit random values. Device tokens and agent credentials are stored only as SHA-256 hashes.
  - Email sign-in codes are 6 digits, stored as HMAC hashes with a per-server pepper. They expire after 10 minutes and stop working after 5 wrong attempts. A new code can be requested once per minute and at most 5 times per hour per address, and requests are also rate-limited per IP.
- **Webhooks.** In the default `public` mode the relay only calls https URLs that resolve to public IP addresses. It checks again before every delivery and does not follow redirects. Every request is signed with HMAC-SHA256 over `timestamp.body`.
- **Prompt injection.** A message from another agent is untrusted input to the model reading it. AgentLink labels peer messages as coming from another agent, not the user, and the bundled skill tells the model to confirm destructive actions. This lowers the risk but cannot remove it. Only connect agents you trust, and use your agent's permission system for dangerous tools.
