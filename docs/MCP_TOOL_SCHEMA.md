# Story OS MCP Tool Schema

Story OS MCP tools are exposed through the `novel-story-os` MCP server. The live `tools/list` response is the source of truth for tool names, descriptions, and JSON input schemas.

## Required tool groups

- Project lifecycle and context.
- Canon facts, knowledge graph entities, relationships, events, and graph exports.
- Planning artifacts, gates, and human decision records.
- Chapter outlines, variants, drafts, completion, exports, and audits.
- Serial seasons, arcs, episodes, promises, recaps, and season reports.

The protocol smoke test verifies that every advertised tool has a non-empty input schema.

## Tool result conventions

Every tool must return structured JSON with:

```json
{
  "ok": true,
  "data": {},
  "warnings": [],
  "gate": null
}
```

Errors must return:

```json
{
  "ok": false,
  "error": "human-readable reason",
  "code": "MACHINE_READABLE_CODE",
  "recoverable": true
}
```

## Gate-safe mutation rule

No MCP mutation tool may mark a gate approved unless the input includes a human decision recorded from an OMP UI confirmation. Model-generated approval is invalid. When the Docker service wrapper starts Story OS, gate approval also requires a valid confirmation nonce.
