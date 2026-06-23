# OMP Novel Engine

OMP Novel Engine is a local-first Oh My Pi (OMP) workspace for planning, drafting, auditing, and exporting long-form fiction projects.

It combines an OMP extension with a Dockerized Story OS MCP server, SQLite/JSONL/Markdown story storage, and Qdrant vector storage. The workflow is built for standalone novels, finite series, and open-ended serials with strict human approval gates.

## Highlights

- OMP extension, skills, hooks, commands, and story rules under `.omp/`.
- Story OS MCP server with JSON-RPC and HTTP APIs under `docker/story-os-mcp/`.
- Docker Compose stack for Story OS MCP and Qdrant.
- Canon, knowledge graph, planning, gate, chapter, export, audit, and serial workflow tools.
- Three-variant chapter drafting flow: `canon-tight`, `character-heavy`, and `plot-accelerated`.
- Local backup, restore, demo reset, quality scan, setup doctor, and smoke-test scripts.
- Git hygiene defaults for local story data, generated reports, backups, copied references, and agent state.

## Architecture

```text
OMP workspace
  -> .omp extension commands, hooks, skills, and rules
  -> Story OS MCP at http://127.0.0.1:7127
  -> SQLite, graph JSONL, Markdown, and reports under stories/<project-slug>/
  -> Qdrant at http://127.0.0.1:6333
```

The service wrapper binds Story OS MCP and Qdrant to `127.0.0.1` by default. It also assigns a workspace-specific Docker Compose project name so multiple clones do not collide unless they reuse the same host ports.

## Requirements

| Requirement | Minimum |
|---|---|
| OS | Windows 10/11, macOS, or Linux |
| Bun | 1.3.14 or newer |
| Docker | Docker Desktop or Docker Engine with Compose v2 |
| OMP | `omp` CLI available on `PATH` |
| Memory | 8 GB recommended |
| Disk | 5 GB free recommended |
| Ports | `127.0.0.1:7127` and `127.0.0.1:6333` free by default |

Install links:

- Bun: https://bun.sh/docs/installation
- Docker Desktop: https://docs.docker.com/desktop/
- Git: https://git-scm.com/downloads
- Oh My Pi: https://github.com/can1357/oh-my-pi

## Quick Start

```sh
git clone https://github.com/forsonny/omp-novel-engine.git
cd omp-novel-engine
bun run doctor
bun run smoke:offline
bun run services:up
bun run smoke:server
```

Start OMP from the repository root:

```sh
omp
```

Then run:

```text
/novel:status
/novel:new
```

Stop the Docker services when you are done:

```sh
bun run services:down
```

## Platform Setup Helpers

The setup scripts check prerequisites and create the local runtime directories.

Windows PowerShell:

```powershell
.\scripts\setup.ps1
.\scripts\docker-up.ps1
```

If PowerShell blocks local scripts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

macOS or Linux:

```sh
sh scripts/setup.sh
sh scripts/docker-up.sh
```

The cross-platform Bun commands are the preferred maintenance interface:

```sh
bun run doctor
bun run services:up
bun run services:wait
bun run services:down
```

## OMP Commands

| Command | Purpose |
|---|---|
| `/novel:status` | Check extension, config, MCP, and project state. |
| `/novel:new` | Create a Story OS project and start the approval-gated workflow. |
| `/novel:draft-chapter` | Continue the chapter workflow without bypassing gates. |
| `/novel:revise-chapter` | Continue revision work through Story OS state. |
| `/serial:plan-season` | Create a serial season plan. |
| `/serial:plan-arc` | Create a season arc. |
| `/serial:next-episode` | Initialize the next serial episode and chapter record. |
| `/serial:recap` | Generate reader or private serial recaps. |
| `/novel:plan-series`, `/novel:plan-book`, `/novel:export`, `/novel:beatmap`, `/novel:canon`, `/novel:audit` | Guidance helpers for structured next steps. |

The workflow is intentionally gate-heavy. Do not continue downstream drafting when Story OS reports a blocked, rejected, or unapproved gate.

## Script Reference

| Command | Requires services | Purpose |
|---|---:|---|
| `bun run doctor` | No | Check local prerequisites and optional service health. |
| `bun run setup` | No | Alias for the setup doctor. |
| `bun run check` | No | Run static server checks. |
| `bun run smoke:offline` | No | Verify extension loading, runtime hooks, and MCP config files. |
| `bun run services:up` | No | Build, start, and wait for Story OS MCP and Qdrant. |
| `bun run services:wait` | Yes | Wait for running services to pass health checks. |
| `bun run mcp:smoke` | Yes | Verify MCP config and protocol behavior. |
| `bun run smoke:server` | Yes | Run MCP protocol plus Phase 3-6 workflow smoke tests. |
| `bun run services:down` | Yes | Stop the workspace Docker Compose stack. |
| `bun run backup -- --project <slug>` | No | Back up a local story project. |
| `bun run restore -- --backup <path> --project <slug> --yes` | No | Restore a story project from a backup. |
| `bun run reset-demo` | No | Recreate the tracked demo scaffold and local demo runtime folders. |
| `bun run quality-scan -- --project <slug>` | No | Write JSON and Markdown quality reports for local chapter prose. |

## Service Configuration

Default service URLs:

- Story OS MCP: `http://127.0.0.1:7127`
- Qdrant: `http://127.0.0.1:6333`

Useful environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `STORY_OS_HOST_BIND` | `127.0.0.1` | Host interface for Story OS MCP. |
| `STORY_OS_HOST_PORT` | `7127` | Host port for Story OS MCP. |
| `QDRANT_HOST_BIND` | `127.0.0.1` | Host interface for Qdrant. |
| `QDRANT_HOST_PORT` | `6333` | Host port for Qdrant. |
| `STORY_OS_AUTH_TOKEN` | Deterministic workspace token | Authorizes non-local mutation requests. |
| `STORY_OS_GATE_DECISION_SECRET` | Auth token | Signs gate decision confirmation nonces. |
| `COMPOSE_PROJECT_NAME` | Workspace-derived name | Overrides Docker Compose project isolation. |

Example alternate ports:

```sh
STORY_OS_HOST_PORT=8127 QDRANT_HOST_PORT=7333 bun run services:up
```

On PowerShell:

```powershell
$env:STORY_OS_HOST_PORT = "8127"
$env:QDRANT_HOST_PORT = "7333"
bun run services:up
```

## Repository Layout

| Path | Purpose |
|---|---|
| `.omp/config.yml` | OMP workspace configuration. |
| `.omp/mcp.json` and `.mcp.json` | MCP connection configuration. |
| `.omp/extensions/novel-engine/` | OMP extension source. |
| `.omp/skills/` | Bundled writing and review skills. |
| `.omp/rules/story/` | Story rules and review rubrics. |
| `docker/compose.yml` | Local Story OS MCP and Qdrant stack. |
| `docker/story-os-mcp/` | Story OS MCP server and schema. |
| `scripts/` | Setup, service, backup, quality, and smoke-test scripts. |
| `stories/demo/` | Minimal tracked demo scaffold. |
| `docs/MCP_TOOL_SCHEMA.md` | MCP result and schema conventions. |

## Local Data and Git Hygiene

Story projects write runtime data under `stories/<project-slug>/`. Git tracks only the minimal `stories/demo/` scaffold.

The repository ignores local-only artifacts, including:

- local story data, generated reports, exports, SQLite files, and graph JSONL
- Qdrant and Docker runtime data
- backups, archives, logs, pids, temp files, and coverage/build output
- local agent state
- copied private references and manuscript source material
- local planning notes and reference snapshots

Use `git status --ignored --short` when checking what will be excluded from a push.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `bun: command not found` | Install Bun, restart the terminal, and run `bun --version`. |
| `docker: command not found` | Install Docker Desktop or Docker Engine and confirm `docker --version`. |
| `Cannot connect to the Docker daemon` | Start Docker Desktop or the Docker daemon. |
| `port is already allocated` | Stop the conflicting service or set `STORY_OS_HOST_PORT` and `QDRANT_HOST_PORT`. |
| `services:wait` times out while `/health` responds | Another workspace may own the configured port. Run `bun run services:down` there or choose alternate ports. |
| `/novel:status` reports MCP unreachable | Run `bun run services:up`, then open `http://127.0.0.1:7127/health`. |
| `mcp:smoke` fails immediately | Start services first with `bun run services:up`. |
| OMP does not see the extension | Start OMP from the repository root. |

## Pre-Push Checks

```sh
bun run check
bun run smoke:offline
bun run services:up
bun run smoke:server
bun run services:down
git status --short --ignored
```
