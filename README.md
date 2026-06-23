# OMP Novel Engine

OMP Novel Engine is an Oh My Pi (OMP) workspace for planning, drafting, auditing, and exporting standalone novels, finite series, and indefinite serials.

It includes:

- an OMP extension under `.omp/extensions/novel-engine/`
- bundled OMP skills and story rules under `.omp/skills/` and `.omp/rules/story/`
- Story OS MCP server code under `docker/story-os-mcp/`
- Docker Compose for Story OS MCP and Qdrant
- setup, backup, restore, reset, quality-scan, and smoke-test scripts
- a small demo story scaffold under `stories/demo/`

## Current status

Implemented and smoke-covered:

- extension loading, config loading, skill discovery, MCP mirror checks, and `/novel:status`
- Story OS MCP JSON-RPC, HTTP health, project, canon, KG, planning, gate, chapter, audit, export, and serial APIs
- backup, restore, demo reset, and quality scan utilities
- Phase 3-6 smoke scripts

Command behavior:

| Command | Behavior |
|---|---|
| `/novel:status` | API-backed health/config/project status check. |
| `/novel:new` | API-backed project creation with a human approval gate. |
| `/novel:draft-chapter` | API-backed chapter workflow continuation; does not bypass gates. |
| `/novel:revise-chapter` | API-backed revision workflow continuation; does not bypass gates. |
| `/serial:plan-season` | API-backed serial season planning. |
| `/serial:plan-arc` | API-backed serial arc planning. |
| `/serial:next-episode` | API-backed serial episode initialization. |
| `/serial:recap` | API-backed reader/private recap generation. |
| `/novel:plan-series`, `/novel:plan-book`, `/novel:export`, `/novel:beatmap`, `/novel:canon`, `/novel:audit` | Guidance helpers that send next-step instructions; they are not fully automated flows. |

## Requirements

| Requirement | Minimum | Why it is needed |
|---|---:|---|
| Operating system | Windows 10/11, macOS, or Linux | OMP runs locally; Docker runs Story OS MCP/Qdrant. |
| CPU | x64 or arm64 | Bun and Docker images must support the architecture. |
| Memory | 8 GB recommended | Docker Desktop plus OMP and Qdrant need headroom. |
| Disk | 5 GB free recommended | Docker images, Qdrant volume, story data, and backups. |
| Network | Internet for first setup | GitHub clone/download, Bun install, Docker image pull. |
| Ports | `127.0.0.1:7127` and `127.0.0.1:6333` free | Story OS MCP and Qdrant bind these ports. |
| Bun | 1.3.14 or newer | Runs TypeScript scripts and local smoke checks. |
| Docker | Docker Desktop or Docker Engine with Compose v2 | Runs Story OS MCP and Qdrant. |
| OMP | `omp` CLI on `PATH` | Loads and uses the extension. |
| Git | Optional | Needed for `git clone`; Download ZIP works without Git. |

Install links:

- Git: https://git-scm.com/downloads
- Bun: https://bun.sh/docs/installation
- Docker Desktop: https://docs.docker.com/desktop/
- Oh My Pi: https://github.com/can1357/oh-my-pi

## Get the repository

With Git:

```sh
git clone https://github.com/forsonny/omp-novel-engine.git omp-novel-engine
cd omp-novel-engine
```

Without Git:

1. Open the GitHub repository in a browser.
2. Click **Code**.
3. Click **Download ZIP**.
4. Extract it to a folder named `omp-novel-engine`.
5. Open a terminal in that folder.

## Setup on Windows

Use PowerShell from the repository root.

```powershell
.\scripts\setup.ps1
.\scripts\docker-up.ps1
bun run smoke:offline
bun run mcp:smoke
```

If PowerShell blocks the script:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

Stop services when finished:

```powershell
.\scripts\docker-down.ps1
```

## Setup on macOS or Linux

Use a POSIX shell from the repository root.

```sh
sh scripts/setup.sh
sh scripts/docker-up.sh
bun run smoke:offline
bun run mcp:smoke
```

Stop services when finished:

```sh
sh scripts/docker-down.sh
```

## Cross-platform Bun commands

These commands work after Bun is installed:

```sh
bun run doctor
bun run services:up
bun run smoke:offline
bun run mcp:smoke
bun run services:down
```

Use `bun run services:up` before any smoke command that talks to `127.0.0.1:7127`.
The service wrapper binds Story OS MCP and Qdrant to `127.0.0.1` by default and assigns a workspace-specific Docker Compose project name.

## Verify setup

Health check: open `http://127.0.0.1:7127/health` in a browser, or run:

```sh
curl http://127.0.0.1:7127/health
```

Expected shape:

```json
{"ok":true,"service":"story-os-mcp","time":"...","version":"...","schemaVersion":"...","workspaceId":"...","qdrantUrlConfigured":true}
```

Smoke commands:

| Command | Requires Docker services | Expected result |
|---|---:|---|
| `bun run doctor` | No | Required tools pass; services may be reported as not running. |
| `bun run smoke:offline` | No | Extension/config/MCP mirror checks print `OK` lines and exit 0. |
| `bun run mcp:smoke` | Yes | MCP config and protocol checks print `OK` lines and exit 0. |
| `bun run smoke:server` | Yes | Protocol plus Phase 3-6 workflow smoke checks exit 0. |

## Use in OMP

1. Start services:

   ```sh
   bun run services:up
   ```

2. Start OMP from the repository root:

   ```sh
   omp
   ```

   If your OMP install uses a different startup command, open this folder as the active workspace.

3. In OMP, run:

   ```text
   /novel:status
   ```

4. If status is online, create a project:

   ```text
   /novel:new
   ```

5. Follow the human approval gates. Do not continue drafting when OMP reports a blocked, rejected, or unapproved gate.

6. For serial projects, use:

   ```text
   /serial:plan-season
   /serial:plan-arc
   /serial:next-episode
   /serial:recap
   ```

Story data is written under `stories/<project-slug>/`. Local story data is ignored by Git except for the small `stories/demo` scaffold.

## Utility commands

```sh
bun run backup -- --project demo
bun run backup:demo
bun run backup:list
bun run restore -- --backup backups/<backup-folder> --project demo --yes
bun run reset-demo
bun run quality-scan -- --project demo
bun run quality-scan:strict -- --project demo
```

Backup and restore commands reject unsafe paths outside the workspace. Restore and demo reset require `--yes` because they replace story project directories.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `bun: command not found` | Bun is not installed or not on `PATH`. | Install Bun, restart the terminal, run `bun --version`. |
| `docker: command not found` | Docker CLI is not installed or not on `PATH`. | Install Docker Desktop or Docker Engine, then run `docker --version`. |
| `Cannot connect to the Docker daemon` | Docker Desktop/daemon is stopped. | Start Docker and rerun setup. |
| `port is already allocated` for 7127 or 6333 | Another process is using Story OS MCP or Qdrant ports. | Stop the other process or set `STORY_OS_HOST_PORT` or `QDRANT_HOST_PORT` before running `bun run services:up`. |
| `services:wait` times out while `/health` responds | A service from another workspace is answering on the configured port. | Run `bun run services:down` in that workspace or choose a different `STORY_OS_HOST_PORT`. |
| PowerShell refuses to run `setup.ps1` | Execution policy blocks local scripts. | Run the bypass command shown in the Windows setup section. |
| `/novel:status` says MCP is unreachable | Services are stopped or health failed. | Run `bun run services:up`, then open `http://127.0.0.1:7127/health`. |
| `mcp:smoke` fails immediately | Story OS MCP is not running. | Run `bun run services:up` first. |
| Smoke tests leave `stories/phase*` folders | Smoke tests create runtime projects. | They are ignored by Git; remove them if you do not need local test data. |
| OMP does not see the extension | Wrong workspace root or OMP config not loaded. | Start OMP from this repository root and rerun `/novel:status`. |

## Repository hygiene

Do not commit:

- `.codex/`, `.agents/`, logs, pids, or session HTML
- backups or generated archive files
- local `stories/<project>/` data
- Docker runtime story data under `docker/story-os-mcp/stories/`
- copied PDFs, private uploads, manuscript drafts, or third-party references under `references/uploaded/`

`references/uploaded/` is for local-only files that you own or have permission to use. The public repository keeps only `references/uploaded/README.md`.

## Publishing checklist

Before inviting other users:

1. Replace `LICENSE` with the intended license terms.
2. Confirm no private story data, local logs, backups, archives, or copied reference files are staged.
3. Run `bun run smoke:offline`.
4. Run `bun run services:up`, `bun run smoke:server`, and `bun run services:down`.

## License

This repository is currently marked `UNLICENSED`. No third-party license is granted until the owner replaces `LICENSE` with explicit terms.
