# DEVELOPMENT.md snapshot

Source URL: https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/DEVELOPMENT.md

Key requirements captured for this build:

- OMP coding-agent development uses Bun.
- `bun run check` is the typecheck + lint gate.
- `bun run check:types`, `bun run lint`, `bun run test`, `bun run fix`, and `bun run build` are documented development loops.
- Do not invoke `tsc` / `npx tsc` directly when working inside the OMP coding-agent package.
