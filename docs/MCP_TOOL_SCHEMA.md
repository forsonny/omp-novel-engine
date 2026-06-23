# Story OS MCP Tool Schema Draft

Phase 2 must implement these as real MCP tools exposed through OMP as `mcp__novel_story_os__...` names.

## Required tool groups

See `BUILD_SPEC.md`, section 8.

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

No MCP mutation tool may mark a gate approved unless the input includes a human decision recorded from an OMP UI confirmation. Model-generated approval is invalid.
