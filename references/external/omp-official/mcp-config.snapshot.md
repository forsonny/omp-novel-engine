# mcp-config.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/docs/mcp-config.md

Key requirements captured for this build:

- Preferred OMP-native project MCP config is `.omp/mcp.json`.
- Preferred user MCP config is `~/.omp/agent/mcp.json` or profile-specific equivalent.
- OMP also accepts root `mcp.json` and `.mcp.json` as fallback standalone files.
- Use `.omp/mcp.json` when OMP should own the config; root `.mcp.json` is best as portable fallback.
- Top-level file shape uses `$schema`, `mcpServers`, and optional `disabledServers`.
- Supported transports are `stdio`, `http`, and `sse`.
- HTTP transport requires `type: "http"` and `url`.
- Validation rejects both `command` and `url` on the same server and requires explicit URL for HTTP/SSE.
