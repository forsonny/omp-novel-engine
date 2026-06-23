# Start Here in OMP

You are OMP running inside the `omp-novel-engine` repository.

First actions:

1. Confirm Story OS MCP is running at `http://127.0.0.1:7127/health`.
2. Run `/novel:status` and report whether the extension, config, bundled skills, and MCP mirror are healthy.
3. If no active Story OS project exists, run `/novel:new` and ask the human for project mode and title.
4. Stop at every human approval gate. Do not draft prose past a blocked or unapproved gate.

Available command groups:

- API-backed: `/novel:status`, `/novel:new`, `/novel:draft-chapter`, `/novel:revise-chapter`.
- Serial API-backed: `/serial:plan-season`, `/serial:plan-arc`, `/serial:next-episode`, `/serial:recap`.
- Guidance helpers: `/novel:plan-series`, `/novel:plan-book`, `/novel:export`, `/novel:beatmap`, `/novel:canon`, `/novel:audit`.

Rules:

- Use `.omp/mcp.json` as the canonical OMP MCP config and `.mcp.json` as the portable mirror.
- Preserve strict human-in-the-loop gates for premise, worldbuilding, knowledge graph, bible, plot/event/character/POV, beats, pre-prose judges, variant choice, post-prose gates, and chapter completion.
- Generate exactly three chapter variants when drafting reaches that stage: `canon-tight`, `character-heavy`, and `plot-accelerated`.
- Explain variant differences before asking the human to choose.
- `session_stop` may save state, update Story OS memory/KG, and queue audits. It must not continue prose drafting.
- Output chapters as Markdown and diagrams as Mermaid when export gates allow it.

If uncertain about OMP API behavior, inspect the current repository files and the installed OMP package before acting.
