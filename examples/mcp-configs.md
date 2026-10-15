# Connecting MCP clients

Run `npx agentlink-pi login` once on the machine. Then register the bridge:

**Claude Code**
```bash
claude mcp add agentlink -- npx -y agentlink-pi mcp --name claude-code --framework claude-code
```

**Codex** (`~/.codex/config.toml`)
```toml
[mcp_servers.agentlink]
command = "npx"
args = ["-y", "agentlink-pi", "mcp", "--name", "codex", "--framework", "codex"]
```

**Cursor / Windsurf / Claude Desktop / Gemini CLI** (`mcp.json` / `settings.json`)
```json
{
  "mcpServers": {
    "agentlink": { "command": "npx", "args": ["-y", "agentlink-pi", "mcp", "--name", "cursor", "--framework", "cursor"] }
  }
}
```

**OpenCode** (`opencode.json`)
```json
{ "mcp": { "agentlink": { "type": "local", "command": ["npx", "-y", "agentlink-pi", "mcp", "--name", "opencode", "--framework", "opencode"] } } }
```

**pi without the extension** (`~/.pi/agent/mcp.json`): same JSON as Cursor. The native extension (`pi install npm:agentlink-pi`) is better: incoming messages start a turn on their own, with no need to poll the inbox.

In containers or CI, set `AGENTLINK_SERVER`, `AGENTLINK_DEVICE_ID` and `AGENTLINK_DEVICE_TOKEN` instead of using a credentials file. Add `--describe "..."` and `--cap tag1,tag2` so other agents can find this one.
