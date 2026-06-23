# mcp-server-tool-authoring.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/mcp-server-tool-authoring.md

Key requirements captured for this build:

- MCP config sources normalize to canonical MCP servers, are deduped by server name, and become runtime MCP server configs.
- MCP Manager connects and lists tools.
- MCP tools are bridged into agent-callable tools named like `mcp__<server>__<tool>` after sanitization.
- Prefer `.omp/mcp.json` or user `~/.omp/agent/mcp.json` for explicit control.
- Root `mcp.json` or `.mcp.json` is fallback compatibility.
- Use explicit `type` to avoid accidental stdio defaults.
- Keep server names globally unique.
