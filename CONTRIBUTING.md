# Contributing

## Local checks

1. Install the prerequisites in `README.md`.
2. Run `bun run doctor`.
3. Run `bun run smoke:offline` before opening a pull request.
4. For Story OS MCP changes, run `bun run services:up`, `bun run smoke:server`, then `bun run services:down`.

## Pull requests

- Keep generated story data, logs, backups, archives, and private references out of commits.
- Update `README.md` when setup or user-facing commands change.
- Update `CHANGELOG.md` for user-visible changes.
- Do not bypass human approval gates in extension or MCP workflows.
- Do not commit secrets, manuscript drafts, local databases, or copied third-party reference files without redistribution rights.
