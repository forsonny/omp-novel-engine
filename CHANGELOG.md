# Changelog

## 0.5.9 - 2026-06-23

- Changed OMP command acknowledgements to local UI notifications so slash commands do not replay corrupted session history through provider turns.
- Added runtime smoke coverage that fails if command acknowledgements use synthetic model-message dispatch.

## 0.5.8 - 2026-06-23

- Fixed OMP command selection prompts to pass string options for `/novel:new`, serial arc planning, and serial recap generation.
- Routed OMP command continuations through user-message turns to avoid empty or provider-incompatible custom message continuations.
- Added runtime smoke coverage for the `/novel:new` UI selection and command-continuation path.

## 0.5.7 - 2026-06-23

- Reworked the README into a public-facing setup, architecture, command, configuration, and troubleshooting guide.

## 0.5.6 - 2026-06-23

- Moved the local OMP start prompt out of the published repository surface.

## 0.5.5 - 2026-06-23

- Moved local planning, implementation checklist, decision ledger, and captured reference snapshot files out of the published repository surface.
- Removed shipped skill and schema references to the local build specification.

## 0.5.4 - 2026-06-23

- Tightened ignore rules for local agent notes and generated demo story diagram artifacts while keeping the tracked demo fixture visible.

## 0.5.3 - 2026-06-23

- Bound Story OS MCP and Qdrant Docker ports to loopback by default and routed service lifecycle through a workspace-aware wrapper.
- Added workspace identity, schema version, Qdrant configuration state, and gate nonce state to Story OS health responses.
- Added non-local mutation authorization, gate decision confirmation nonces, invalid JSON rejection, explicit project-create parameters, and mapped API error statuses.
- Added structured MCP tool input schemas and protocol smoke coverage for non-empty advertised schemas.
- Added server static build checks to package scripts and CI.
- Added database indexes for project, scope, gate, chapter, graph, serial, and audit query paths.
- Updated setup docs and ignore rules for generated demo runtime artifacts.
- Removed unimplemented batch draft/export script stubs from the shipped script list.

## 0.5.2 - 2026-06-23

- Reworked onboarding for GitHub clone/download setup across Windows, macOS, and Linux.
- Added cross-platform setup doctor, service readiness wait, POSIX setup/service scripts, and package scripts for offline/server smoke checks.
- Fixed Docker build input handling and aligned Bun runtime versions across local, Docker, and CI paths.
- Added GitHub Actions smoke workflow, editor metadata, Git attributes, security policy, contribution guide, and license placeholder.
- Hardened repository hygiene for generated stories, logs, backups, archives, local agent state, Docker runtime data, and private reference uploads.
- Replaced archive/build-kit documentation with clone-based setup, first-run OMP workflow, troubleshooting, command behavior, verification, and publishing guidance.
- Recorded the public GitHub repository URL in package metadata.
