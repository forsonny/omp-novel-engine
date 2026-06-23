# Implementation Checklist

## Phase 1

- [x] OMP extension entrypoint exists at `.omp/extensions/novel-engine/index.ts`.
- [x] Slash command registration is covered by `scripts/extension-smoke-test.ts`.
- [x] `/novel:status` health-path wiring is covered by `scripts/extension-smoke-test.ts`.
- [x] Required skill discovery is covered by `scripts/extension-smoke-test.ts`.
- [x] `session_stop` posts `allowDrafting: false` and returns without drafting.

## Phase 2

- [x] Story OS MCP server exposes `/mcp`.
- [x] MCP tool listing is covered by `scripts/mcp-protocol-smoke-test.ts`.
- [x] Project, canon, gate, KG, arc, timeline, chapter, audit, export, and serial tools are implemented in `docker/story-os-mcp/src/server.ts`.
- [x] SQLite schema is included at `docker/story-os-mcp/schema.sql`.
- [x] Qdrant service is included in `docker/compose.yml`.
- [x] MCP initialize, ping, resources, prompts, and tool calls are covered by `scripts/mcp-protocol-smoke-test.ts`.

## Phase 3+

Follow `BUILD_SPEC.md` development phases.

## Local Smoke Coverage

- [x] Extension config, command registration, skill discovery, and MCP mirror checks pass with `scripts/extension-smoke-test.ts`.
- [x] MCP protocol initialize, ping, resources, prompts, tool listing, project, canon, KG, planning, gate, export, and serial tool listing checks pass with `scripts/mcp-protocol-smoke-test.ts`.
- [x] Phase 3 planning workflow passes with `scripts/phase3-planning-smoke-test.ts`.
- [x] Phase 4 chapter workflow passes with `scripts/phase4-chapter-workflow-smoke-test.ts`.
- [x] Phase 5 serial workflow passes with `scripts/phase5-serial-smoke-test.ts`.
- [x] Phase 6 hardening utilities pass with `scripts/phase6-hardening-smoke-test.ts`.

## Phase 5

- [x] Serial MCP tools list: season plan, arc plan, next episode, promise upsert/list, recap, and season report.
- [x] Serial projects expose serial status metadata, active season, next episode number, open promise counts, and unresolved promise count.
- [x] `/serial:plan-season` creates a season plan gate and requires human-confirmed OMP gate approval.
- [x] `/serial:plan-arc` creates a season arc, requires the season gate, and attaches the planned arc to the season report path.
- [x] Serial arc seven-point beats validate and are covered by project gate completion before chapter variant work.
- [x] Promise ledger supports reader, private, and both-audience visibility filters.
- [x] `/serial:next-episode` creates the serial episode, chapter record, and all pre-prose gates.
- [x] Reader recaps exclude private promise markers.
- [x] Private recaps include private promise markers.
- [x] Season completion reports include unresolved promise counts, incomplete episode counts, and valid planned-arc beat summaries.

## Phase 6

- [x] Project backup command copies story data and workspace config into a manifest-backed backup.
- [x] Project restore command requires explicit `--yes`, pre-backs up the current target, and restores under `stories/<slug>`.
- [x] Path guards reject unsafe slugs and paths outside the workspace.
- [x] Demo reset is restricted to `stories/demo`, requires `--yes`, and creates a backup before replacement.
- [x] Quality scan writes JSON and Markdown reports from source chapter prose.
- [x] Root package scripts expose backup, restore, quality scan, demo reset, extension smoke, MCP smoke, and Phase 3-6 smoke commands.
- [x] Windows and POSIX setup paths check Bun, Docker, OMP, service health, smoke commands, backup, restore, quality scan, and reset usage.
- [x] Public-repo hygiene ignores local agent state, generated story data, copied private references, logs, backups, and archives.
