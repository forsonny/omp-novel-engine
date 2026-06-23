import { Database } from "bun:sqlite";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type JsonScalar = string | number | boolean | null;
type JsonObject = { [key: string]: JsonValue };
type JsonValue = JsonScalar | JsonObject | JsonValue[];

type McpOkResult<T = JsonValue> = {
  ok: true;
  data: T;
  warnings: string[];
  gate: JsonObject | null;
};

type McpErrorResult = {
  ok: false;
  error: string;
  code: string;
  recoverable: boolean;
};

type McpToolResult = McpOkResult | McpErrorResult;
type McpCallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: McpToolResult;
  isError?: boolean;
};

const host = process.env.STORY_OS_HOST || "0.0.0.0";
const port = Number(process.env.STORY_OS_PORT || 7127);
const workspaceRoot = resolve(process.env.STORY_OS_WORKSPACE || process.cwd());
const storiesRoot = join(workspaceRoot, "stories");
const schemaFile = resolve(import.meta.dir ?? process.cwd(), "../schema.sql");
const qdrantUrl = process.env.QDRANT_URL || "";
const workspaceId = process.env.STORY_OS_WORKSPACE_ID?.trim() ||
  createHash("sha256").update(workspaceRoot.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);
const authToken = process.env.STORY_OS_AUTH_TOKEN?.trim() || "";
const gateDecisionSecret = process.env.STORY_OS_GATE_DECISION_SECRET?.trim() || authToken;

const MCP_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MCP_SCHEMA_VERSION = "schema.sql@v6";
const MCP_SERVER_VERSION = "0.5.9";
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const ALLOWED_GATE_DECISION_STATUSES = ["approved", "rejected", "needs_revision", "blocked_by_audit"] as const;
const BLOCKING_GATE_STATUSES = new Set<string>(["blocked_by_audit"]);
const NON_APPROVED_GATE_STATUSES = new Set<string>(["rejected", "needs_revision", "blocked_by_audit"]);
type GateDecisionStatus = (typeof ALLOWED_GATE_DECISION_STATUSES)[number];

const PLANNING_STAGES = [
  "premise",
  "worldbuilding",
  "knowledge_graph",
  "series_bible",
  "story_infrastructure",
  "beats",
  "mermaid_export"
] as const;

type PlanningStage = (typeof PLANNING_STAGES)[number];

const REQUIRED_BEAT_NAMES = [
  "Hook",
  "First Plot Point",
  "First Pinch",
  "Midpoint",
  "Second Pinch",
  "Second Plot Point",
  "Resolution"
] as const;

const CHAPTER_VARIANT_TYPES = ["canon-tight", "character-heavy", "plot-accelerated"] as const;
type ChapterVariantType = (typeof CHAPTER_VARIANT_TYPES)[number];
const CHAPTER_PRE_PROSE_GATES = ["structure_judge", "canon_continuity_judge", "character_genre_judge", "pre_prose_human_approval"] as const;
const CHAPTER_POST_PROSE_GATES = [
  "continuity_timeline_check",
  "canon_contradiction_check",
  "character_motivation_check",
  "chapter_goal_scene_job_check",
  "dialogue_naturalness_check",
  "narrator_distance_ban_scan",
  "plain_physical_prose_scan",
  "aiism_risk_report",
  "style_preservation_check"
] as const;
const CHAPTER_FINAL_APPROVAL_GATE = "human_final_approval";
const CHAPTER_VARIANT_CHOICE_GATE = "chapter_variant_choice";
const PROJECT_MODE_SERIAL = "serial";
const SERIAL_SEASON_STATUSES = ["planned", "active", "completed"] as const;
type SerialSeasonStatus = (typeof SERIAL_SEASON_STATUSES)[number];
const SERIAL_EPISODE_STATUSES = ["planned", "drafting", "in_progress", "active", "complete", "closed", "abandoned"] as const;
type SerialEpisodeStatus = (typeof SERIAL_EPISODE_STATUSES)[number];
const SERIAL_GATES = ["season_plan", "serial_arc_plan", "season_completion_review"] as const;
const SERIAL_SCOPES = ["serial_promise", "season", "book", "subplot", "major_character", "chapter", "episode"] as const;
const SERIAL_PROMISE_CATEGORIES = ["open_promise", "mystery", "foreshadowing", "payoff", "theme"] as const;
const SERIAL_PROMISE_STATUSES = ["open", "advanced", "deferred", "paid_off", "dropped"] as const;
const SERIAL_PROMISE_VISIBILITIES = ["reader", "private", "both"] as const;
const SERIAL_RECAP_AUDIENCES = ["reader", "private"] as const;
const OPEN_SERIAL_PROMISE_STATUSES = new Set<string>(["open", "advanced", "deferred"]);
type SerialScope = (typeof SERIAL_SCOPES)[number];
type SerialPromiseCategory = (typeof SERIAL_PROMISE_CATEGORIES)[number];
type SerialPromiseStatus = (typeof SERIAL_PROMISE_STATUSES)[number];
type SerialPromiseVisibility = (typeof SERIAL_PROMISE_VISIBILITIES)[number];
type SerialRecapAudience = (typeof SERIAL_RECAP_AUDIENCES)[number];

const MCP_TOOLS = [
  {
    name: "story_project_create",
    description: "Create or update a Story OS project and initialize planning gates.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_project_status",
    description: "Return Story OS project status and pending gates.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_canon_upsert_fact",
    description: "Insert or update a canon fact for a project.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_canon_search",
    description: "Search canon facts for a project.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_kg_upsert_entity",
    description: "Insert or update a knowledge-graph entity.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_kg_upsert_relationship",
    description: "Insert or update a knowledge-graph relationship.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_kg_export_jsonl",
    description: "Read and return project graph JSONL projections.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_kg_upsert_event",
    description: "Insert or update a canon event.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_kg_export_mermaid",
    description: "Export entity/relationship graph to Mermaid.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_event_graph_create",
    description: "Create an event-graph planning artifact marker.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_event_graph_upsert_node",
    description: "Insert or update an event graph node.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_event_graph_upsert_edge",
    description: "Insert or update a causal edge between events.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_event_graph_validate_causality",
    description: "Validate event graph causality for cycles/missing references.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_event_graph_export_mermaid",
    description: "Export event graph as Mermaid and persist .mmd.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_export_mermaid_diagrams",
    description: "Export all available Mermaid diagram artifacts for a project.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_gate_create",
    description: "Create a project gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_gate_status",
    description: "Return gate status rows for a scope.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_gate_record_human_decision",
    description: "Record an explicit human decision for a gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_gate_blockers",
    description: "Report what planning gates block progress for a scope.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_outline_record",
    description: "Record chapter outline metadata and create the chapter record.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_variant_create",
    description: "Create or update a chapter draft variant and persist variant report fields.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_variant_list",
    description: "List all variants for a chapter.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_variant_rank",
    description: "Rank all chapter variants after pre-prose judges.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_variant_select",
    description: "Select a variant using a human-approved chapter_variant_choice gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_draft_record",
    description: "Record a selected draft revision for a chapter variant.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_chapter_complete_mark",
    description: "Mark a chapter complete after required post-prose gates and human final approval.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_season_plan",
    description: "Create or update a serial season and pending season_plan gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_arc_plan",
    description: "Create or update a serial arc and pending serial_arc_plan gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_next_episode",
    description: "Create or resume the next serial episode and create a season chapter with pre-prose gates.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_promise_upsert",
    description: "Create or update a serial promise with public/private visibility and status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_promise_list",
    description: "List serial promises with status/scope/visibility filters.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_recap_generate",
    description: "Generate a serial recap scoped to episode/season and audience.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_serial_season_report",
    description: "Generate a serial season completion report and season_completion_review gate status.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_premise_record",
    description: "Record premise planning artifact and enforce prior gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_worldbuilding_record",
    description: "Record worldbuilding planning artifact and enforce prior gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_series_bible_record",
    description: "Record series bible planning artifact and enforce prior gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_pov_plan_record",
    description: "Record POV/structure planning artifact and enforce prior gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_beatmap_record",
    description: "Record seven-point beats for an arc and enforce prior gate.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_audit_run",
    description: "Create or complete a chapter or project audit run.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_audit_get_report",
    description: "Get an audit run and findings by chapter scope.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_audit_record_finding",
    description: "Record a finding for an existing audit run.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_audit_export_occurrence_inventory",
    description: "Export occurrence inventory for a chapter audit scope.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_export_markdown_chapter",
    description: "Persist and export a finalized chapter markdown file.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_arc_create",
    description: "Create an arc container and return its row.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_arc_get",
    description: "Return an arc row and its beats.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_arc_update",
    description: "Update arc metadata.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_arc_validate_seven_point",
    description: "Validate required seven-point beats for an arc.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_arc_list_by_scope",
    description: "List arcs for a scope.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  },
  {
    name: "story_arc_export_mermaid",
    description: "Export an arc beat map as Mermaid and persist .mmd.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: true
    }
  }
] as const;

const stringSchema = { type: "string" };
const numberSchema = { type: "number" };
const booleanSchema = { type: "boolean" };
const objectValueSchema = { type: "object", additionalProperties: true };
const arrayValueSchema = { type: "array", items: {} };

function inputSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true
  };
}

const projectSlugSchema = inputSchema({ projectSlug: stringSchema }, ["projectSlug"]);
const scopedProjectSchema = inputSchema({
  projectSlug: stringSchema,
  scopeType: stringSchema,
  scopeId: stringSchema,
  gateType: stringSchema
}, ["projectSlug"]);
const chapterSchema = inputSchema({
  projectSlug: stringSchema,
  chapterId: stringSchema
}, ["projectSlug", "chapterId"]);
const arcSchema = inputSchema({
  projectSlug: stringSchema,
  arcId: stringSchema
}, ["projectSlug", "arcId"]);

const TOOL_INPUT_SCHEMAS: Record<string, JsonObject> = {
  story_project_create: inputSchema({
    slug: stringSchema,
    title: stringSchema,
    mode: { type: "string", enum: ["standalone", "series", "serial"] }
  }, ["slug", "mode"]),
  story_project_status: inputSchema({ projectSlug: stringSchema }),
  story_canon_upsert_fact: inputSchema({
    projectSlug: stringSchema,
    entityId: stringSchema,
    factType: stringSchema,
    factText: stringSchema,
    sourceRef: stringSchema,
    confidence: numberSchema,
    locked: booleanSchema,
    supersedesFactId: stringSchema
  }, ["projectSlug", "factType", "factText", "sourceRef"]),
  story_canon_search: inputSchema({
    projectSlug: stringSchema,
    query: stringSchema,
    entityId: stringSchema,
    factType: stringSchema,
    limit: numberSchema
  }, ["projectSlug"]),
  story_kg_upsert_entity: inputSchema({
    projectSlug: stringSchema,
    id: stringSchema,
    type: stringSchema,
    name: stringSchema,
    aliases: arrayValueSchema,
    description: stringSchema,
    status: stringSchema,
    firstSeenRef: stringSchema,
    lastSeenRef: stringSchema
  }, ["projectSlug", "type", "name"]),
  story_kg_upsert_relationship: inputSchema({
    projectSlug: stringSchema,
    id: stringSchema,
    sourceEntityId: stringSchema,
    targetEntityId: stringSchema,
    relationshipType: stringSchema,
    state: stringSchema,
    sourceRef: stringSchema
  }, ["projectSlug", "sourceEntityId", "targetEntityId", "relationshipType"]),
  story_kg_export_jsonl: projectSlugSchema,
  story_kg_upsert_event: inputSchema({
    projectSlug: stringSchema,
    id: stringSchema,
    title: stringSchema,
    summary: stringSchema,
    eventType: stringSchema,
    timeLabel: stringSchema,
    chronologyIndex: numberSchema,
    sourceRef: stringSchema
  }, ["projectSlug", "title"]),
  story_kg_export_mermaid: projectSlugSchema,
  story_event_graph_create: inputSchema({
    projectSlug: stringSchema,
    title: stringSchema,
    artifactKey: stringSchema
  }, ["projectSlug"]),
  story_event_graph_upsert_node: inputSchema({
    projectSlug: stringSchema,
    eventId: stringSchema,
    title: stringSchema,
    summary: stringSchema,
    chronologyIndex: numberSchema,
    sourceRef: stringSchema
  }, ["projectSlug", "title"]),
  story_event_graph_upsert_edge: inputSchema({
    projectSlug: stringSchema,
    id: stringSchema,
    fromEventId: stringSchema,
    toEventId: stringSchema,
    edgeType: stringSchema,
    rationale: stringSchema
  }, ["projectSlug", "fromEventId", "toEventId", "edgeType"]),
  story_event_graph_validate_causality: projectSlugSchema,
  story_event_graph_export_mermaid: projectSlugSchema,
  story_export_mermaid_diagrams: projectSlugSchema,
  story_gate_create: inputSchema({
    projectSlug: stringSchema,
    scopeType: stringSchema,
    scopeId: stringSchema,
    gateType: stringSchema,
    status: stringSchema,
    required: booleanSchema
  }, ["projectSlug", "scopeType", "scopeId", "gateType"]),
  story_gate_status: scopedProjectSchema,
  story_gate_record_human_decision: inputSchema({
    projectSlug: stringSchema,
    gateId: stringSchema,
    scopeType: stringSchema,
    scopeId: stringSchema,
    gateType: stringSchema,
    decision: { type: "string", enum: [...ALLOWED_GATE_DECISION_STATUSES] },
    humanDecision: { type: "string", enum: [...ALLOWED_GATE_DECISION_STATUSES] },
    decisionSource: stringSchema,
    humanConfirmed: booleanSchema,
    confirmationNonce: stringSchema,
    notes: stringSchema,
    decidedBy: stringSchema,
    decisionMetadata: objectValueSchema
  }, ["projectSlug", "decisionSource", "humanConfirmed"]),
  story_gate_blockers: scopedProjectSchema,
  story_chapter_outline_record: inputSchema({
    projectSlug: stringSchema,
    chapterId: stringSchema,
    chapterNumber: numberSchema,
    title: stringSchema,
    containerType: stringSchema,
    containerId: stringSchema,
    outlineMarkdown: stringSchema,
    outlinePath: stringSchema
  }, ["projectSlug", "chapterId"]),
  story_chapter_variant_create: inputSchema({
    projectSlug: stringSchema,
    chapterId: stringSchema,
    variantType: { type: "string", enum: [...CHAPTER_VARIANT_TYPES] },
    purpose: stringSchema,
    markdownText: stringSchema,
    markdownPath: stringSchema,
    changedStructurally: stringSchema,
    changedEmotionally: stringSchema,
    changedInPacing: stringSchema,
    canonRisk: stringSchema,
    continuityRisk: stringSchema,
    bestUseCase: stringSchema,
    reasonToChoose: stringSchema,
    reasonNotToChoose: stringSchema
  }, ["projectSlug", "chapterId", "variantType", "purpose"]),
  story_chapter_variant_list: chapterSchema,
  story_chapter_variant_rank: chapterSchema,
  story_chapter_variant_select: inputSchema({
    projectSlug: stringSchema,
    chapterId: stringSchema,
    variantId: stringSchema,
    selectionReason: stringSchema
  }, ["projectSlug", "chapterId", "variantId"]),
  story_chapter_draft_record: inputSchema({
    projectSlug: stringSchema,
    chapterId: stringSchema,
    variantId: stringSchema,
    draftStage: stringSchema,
    status: stringSchema,
    markdownText: stringSchema,
    markdownPath: stringSchema,
    revisionNotes: stringSchema,
    provenance: objectValueSchema
  }, ["projectSlug", "chapterId", "variantId", "draftStage", "markdownText"]),
  story_chapter_complete_mark: inputSchema({
    projectSlug: stringSchema,
    chapterId: stringSchema,
    completionNotes: stringSchema
  }, ["projectSlug", "chapterId"]),
  story_serial_season_plan: inputSchema({
    projectSlug: stringSchema,
    seasonId: stringSchema,
    seasonNumber: numberSchema,
    title: stringSchema,
    status: { type: "string", enum: [...SERIAL_SEASON_STATUSES] },
    promiseSummary: stringSchema,
    arcId: stringSchema
  }, ["projectSlug", "title"]),
  story_serial_arc_plan: inputSchema({
    projectSlug: stringSchema,
    seasonId: stringSchema,
    arcId: stringSchema,
    title: stringSchema,
    beats: arrayValueSchema
  }, ["projectSlug"]),
  story_serial_next_episode: inputSchema({
    projectSlug: stringSchema,
    seasonId: stringSchema,
    episodeId: stringSchema,
    episodeNumber: numberSchema,
    chapterId: stringSchema,
    episodeTitle: stringSchema,
    releaseLabel: stringSchema
  }, ["projectSlug"]),
  story_serial_promise_upsert: inputSchema({
    projectSlug: stringSchema,
    id: stringSchema,
    title: stringSchema,
    category: { type: "string", enum: [...SERIAL_PROMISE_CATEGORIES] },
    status: { type: "string", enum: [...SERIAL_PROMISE_STATUSES] },
    visibility: { type: "string", enum: [...SERIAL_PROMISE_VISIBILITIES] },
    priority: numberSchema,
    sourceEpisodeId: stringSchema,
    targetScopeType: { type: "string", enum: [...SERIAL_SCOPES] },
    targetScopeId: stringSchema,
    payoffEpisodeId: stringSchema,
    notes: stringSchema,
    sourceRef: stringSchema
  }, ["projectSlug", "title"]),
  story_serial_promise_list: inputSchema({
    projectSlug: stringSchema,
    status: { type: "string", enum: [...SERIAL_PROMISE_STATUSES] },
    visibility: { type: "string", enum: [...SERIAL_PROMISE_VISIBILITIES] },
    scopeType: { type: "string", enum: [...SERIAL_SCOPES] },
    scopeId: stringSchema
  }, ["projectSlug"]),
  story_serial_recap_generate: inputSchema({
    projectSlug: stringSchema,
    scopeType: { type: "string", enum: ["episode", "season"] },
    scopeId: stringSchema,
    audience: { type: "string", enum: [...SERIAL_RECAP_AUDIENCES] },
    seasonId: stringSchema,
    episodeId: stringSchema
  }, ["projectSlug", "scopeType", "scopeId", "audience"]),
  story_serial_season_report: inputSchema({
    projectSlug: stringSchema,
    seasonId: stringSchema
  }, ["projectSlug"]),
  story_premise_record: scopedProjectSchema,
  story_worldbuilding_record: scopedProjectSchema,
  story_series_bible_record: scopedProjectSchema,
  story_pov_plan_record: scopedProjectSchema,
  story_beatmap_record: inputSchema({
    projectSlug: stringSchema,
    arcId: stringSchema,
    beats: arrayValueSchema,
    title: stringSchema,
    scopeType: stringSchema,
    scopeId: stringSchema
  }, ["projectSlug", "arcId", "beats"]),
  story_audit_run: inputSchema({
    projectSlug: stringSchema,
    auditRunId: stringSchema,
    scopeType: stringSchema,
    scopeId: stringSchema,
    auditType: stringSchema,
    status: stringSchema,
    summary: objectValueSchema,
    artifactPath: stringSchema,
    provenance: objectValueSchema
  }, ["projectSlug", "scopeType", "scopeId", "auditType"]),
  story_audit_get_report: inputSchema({
    projectSlug: stringSchema,
    auditRunId: stringSchema,
    scopeType: stringSchema,
    scopeId: stringSchema
  }, ["projectSlug"]),
  story_audit_record_finding: inputSchema({
    projectSlug: stringSchema,
    auditRunId: stringSchema,
    category: stringSchema,
    severity: stringSchema,
    quoteOrLocation: stringSchema,
    whyFlagged: stringSchema,
    fixStrategy: stringSchema,
    findingKey: stringSchema,
    evidence: objectValueSchema
  }, ["projectSlug", "auditRunId", "category", "severity", "quoteOrLocation", "whyFlagged", "fixStrategy"]),
  story_audit_export_occurrence_inventory: inputSchema({
    projectSlug: stringSchema,
    auditRunId: stringSchema,
    scopeType: stringSchema,
    scopeId: stringSchema
  }, ["projectSlug"]),
  story_export_markdown_chapter: inputSchema({
    projectSlug: stringSchema,
    chapterId: stringSchema,
    outputPath: stringSchema
  }, ["projectSlug", "chapterId"]),
  story_arc_create: inputSchema({
    projectSlug: stringSchema,
    scope: stringSchema,
    ownerId: stringSchema,
    title: stringSchema,
    status: stringSchema
  }, ["projectSlug", "scope", "title"]),
  story_arc_get: arcSchema,
  story_arc_update: inputSchema({
    projectSlug: stringSchema,
    arcId: stringSchema,
    title: stringSchema,
    status: stringSchema,
    scope: stringSchema,
    ownerId: stringSchema
  }, ["projectSlug", "arcId"]),
  story_arc_validate_seven_point: arcSchema,
  story_arc_list_by_scope: inputSchema({
    projectSlug: stringSchema,
    scope: stringSchema,
    ownerId: stringSchema
  }, ["projectSlug", "scope"]),
  story_arc_export_mermaid: arcSchema
};

for (const tool of MCP_TOOLS) {
  const schema = TOOL_INPUT_SCHEMAS[tool.name] ?? projectSlugSchema;
  (tool as { inputSchema: JsonObject }).inputSchema = schema;
}

type DbProject = {
  id: string;
  slug: string;
  title: string | null;
  mode: string;
  created_at: string;
  updated_at: string;
};

type DbGate = {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string;
  gate_type: string;
  status: string;
  required: number;
  blocker_reason: string | null;
  blocker_payload_json: string | null;
  created_at: string;
  resolved_at: string | null;
};

type DbGateDecision = {
  id: string;
  gate_id: string;
  project_id: string | null;
  decision: string;
  human_decision: string | null;
  human_confirmed: number;
  decision_source: string | null;
  notes: string | null;
  decided_by: string | null;
  decided_at: string;
  decision_metadata_json: string | null;
};

type DbCanonFact = {
  id: string;
  project_id: string;
  entity_id: string | null;
  fact_type: string;
  fact_text: string;
  source_ref: string;
  confidence: number;
  locked: number;
  supersedes_fact_id: string | null;
  created_at: string;
};

type DbEntity = {
  id: string;
  project_id: string;
  type: string;
  name: string;
  aliases_json: string | null;
  description: string | null;
  status: string | null;
  first_seen_ref: string | null;
  last_seen_ref: string | null;
  created_at: string;
  updated_at: string;
};

type DbRelationship = {
  id: string;
  project_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  state: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

type DbEvent = {
  id: string;
  project_id: string;
  title: string;
  summary: string | null;
  event_type: string | null;
  time_label: string | null;
  chronology_index: number | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

type DbEventEdge = {
  id: string;
  project_id: string;
  from_event_id: string;
  to_event_id: string;
  edge_type: string;
  rationale: string | null;
};

type DbArc = {
  id: string;
  project_id: string;
  scope: string;
  owner_id: string | null;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
};

type DbSerialSeason = {
  id: string;
  project_id: string;
  season_number: number;
  title: string;
  status: string;
  promise_summary: string | null;
  arc_id: string | null;
  gate_id: string | null;
  created_at: string;
  updated_at: string;
};

type DbSerialEpisode = {
  id: string;
  project_id: string;
  season_id: string;
  chapter_id: string;
  episode_number: number;
  serial_sequence: number;
  status: string;
  release_label: string | null;
  created_at: string;
  updated_at: string;
};

type DbSerialPromise = {
  id: string;
  project_id: string;
  title: string;
  category: string;
  status: string;
  visibility: string;
  priority: number;
  opened_episode_id: string | null;
  target_scope_type: string | null;
  target_scope_id: string | null;
  payoff_episode_id: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
};

type DbSerialPromiseEvent = {
  id: string;
  promise_id: string;
  event_type: string;
  episode_id: string | null;
  notes: string | null;
  source_ref: string | null;
  created_at: string;
};

type DbSerialRecap = {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string;
  audience: string;
  markdown_path: string;
  source_payload_json: string;
  created_at: string;
};

type DbSerialSeasonReport = {
  id: string;
  project_id: string;
  season_id: string;
  markdown_path: string;
  summary_json: string;
  unresolved_promise_count: number;
  incomplete_episode_count: number;
  gate_id: string | null;
  created_at: string;
};

type DbBeat = {
  id: string;
  arc_id: string;
  beat_name: string;
  beat_order: number;
  summary: string;
  evidence_ref: string | null;
  approved: number;
};

type DbChapter = {
  id: string;
  project_id: string;
  container_type: string;
  container_id: string;
  chapter_number: number;
  title: string | null;
  status: string;
  markdown_path: string | null;
  selected_variant_id: string | null;
  selected_draft_revision_id: string | null;
  approved_by_gate_id: string | null;
  approved_at: string | null;
  final_markdown_path: string | null;
  completion_notes: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

type DbChapterDraftRevision = {
  id: string;
  project_id: string;
  chapter_id: string;
  variant_id: string;
  draft_stage: string;
  status: string;
  markdown_path: string;
  revision_notes: string | null;
  is_selected: number;
  provenance_json: string | null;
  created_at: string;
  updated_at: string;
};

type DbChapterVariant = {
  id: string;
  chapter_id: string;
  variant_type: string;
  purpose: string;
  changed_structurally: string | null;
  changed_emotionally: string | null;
  changed_in_pacing: string | null;
  canon_risk: string | null;
  continuity_risk: string | null;
  best_use_case: string | null;
  reason_to_choose: string | null;
  reason_not_to_choose: string | null;
  markdown_path: string;
  rank_score: number | null;
  ranking_reason: string | null;
  selected: number;
  status: string;
  selection_reason: string | null;
  updated_at: string | null;
  created_at: string;
};

type DbAuditRun = {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string;
  audit_type: string;
  status: string;
  summary_json: string | null;
  artifact_type: string | null;
  artifact_id: string | null;
  artifact_path: string | null;
  provenance_json: string | null;
  completed_by: string | null;
  created_at: string;
  completed_at: string | null;
};

type DbAuditFinding = {
  id: string;
  audit_run_id: string;
  category: string;
  severity: string;
  quote_or_location: string;
  why_flagged: string;
  fix_strategy: string;
  finding_key: string | null;
  evidence_json: string | null;
  occurrence_count: number;
  resolved: number;
  resolved_at: string | null;
  resolution_notes: string | null;
  found_by: string | null;
  found_at: string | null;
};

type DbPlanningArtifact = {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string;
  artifact_type: string;
  artifact_key: string | null;
  title: string | null;
  payload_json: string;
  gate_id: string | null;
  created_at: string;
  updated_at: string;
};

type DbMermaidExport = {
  id: string;
  project_id: string;
  scope_type: string;
  scope_id: string | null;
  diagram_kind: string;
  artifact_type: string | null;
  artifact_id: string | null;
  file_path: string;
  mermaid_text: string | null;
  created_at: string;
};

type ProjectScanSummary = {
  slug: string;
  hasDatabase: boolean;
  project: DbProject | null;
  serialStatus: SerialProjectStatus | null;
  pendingGates: DbGate[];
  workflow: ProjectWorkflowState | null;
};

type SerialProjectStatus = {
  projectMode: string;
  activeSeasonId: string | null;
  activeSeasonNumber: number | null;
  nextEpisodeNumber: number;
  openPromiseCounts: Record<string, number>;
  unresolvedPromiseCount: number;
  pendingSerialGates: DbGate[];
};

type ProjectWorkflowState = {
  currentStage: PlanningStage;
  allowedNextAction: string;
  blockerGateType?: string | null;
  blockerGateId?: string | null;
  blockerGateStatus?: string | null;
};

let cachedSchemaStatements: string[] | null = null;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function statusForErrorCode(code: string | undefined): number {
  if (!code) return 500;
  if (code.includes("NOT_FOUND")) return 404;
  if (code.includes("CONFLICT") || code.includes("DUPLICATE")) return 409;
  if (
    code.includes("INVALID") ||
    code.includes("MISSING") ||
    code.includes("UNAUTHORIZED") ||
    code.includes("PATH_OUTSIDE")
  ) {
    return code.includes("UNAUTHORIZED") ? 403 : 400;
  }
  return 500;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(req: Request): Promise<JsonObject> {
  const rawText = await req.text();
  if (rawText.trim().length === 0) return {};

  try {
    const raw = JSON.parse(rawText) as unknown;
    return isObject(raw) ? raw : {};
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { code: "INVALID_JSON" });
  }
}

function createGateDecisionNonce(projectSlug: string, gateReference: string, gateStatus: string): string {
  return createHmac("sha256", gateDecisionSecret)
    .update(`${projectSlug}:${gateReference}:${gateStatus}`)
    .digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function gateDecisionReference(args: JsonObject): string {
  const gateId = typeof args.gateId === "string" ? args.gateId.trim() : "";
  if (gateId) return `gate:${gateId}`;
  const gateType = typeof args.gateType === "string" ? args.gateType.trim() : "";
  return gateType ? `type:${gateType}` : "";
}

function requireGateDecisionNonce(args: JsonObject, projectSlug: string, gateStatus: string): void {
  if (!gateDecisionSecret) return;
  const provided = typeof args.confirmationNonce === "string" ? args.confirmationNonce.trim() : "";
  const reference = gateDecisionReference(args);
  if (!provided || !reference) {
    throw Object.assign(new Error("Gate decisions require a valid confirmation nonce"), {
      code: "UNAUTHORIZED_GATE_DECISION"
    });
  }

  const expected = createGateDecisionNonce(projectSlug, reference, gateStatus);
  if (!constantTimeEqual(provided, expected)) {
    throw Object.assign(new Error("Gate decision confirmation nonce is invalid"), {
      code: "UNAUTHORIZED_GATE_DECISION"
    });
  }
}

function requestHostName(req: Request): string {
  const hostHeader = req.headers.get("host") || "";
  const host = hostHeader.split(":")[0]?.toLowerCase() || "";
  return host.replace(/^\[|\]$/g, "");
}

function isLocalRequest(req: Request): boolean {
  const hostName = requestHostName(req);
  return hostName === "127.0.0.1" || hostName === "localhost" || hostName === "::1";
}

function hasValidRequestAuth(req: Request): boolean {
  if (!authToken) return false;
  const authorization = req.headers.get("authorization") || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const headerToken = req.headers.get("x-story-os-token") || "";
  return constantTimeEqual(bearer || headerToken, authToken);
}

function rejectUnsafeExternalMutation(req: Request, url: URL): Response | null {
  if (req.method === "GET") return null;
  if (isLocalRequest(req)) return null;
  if ((url.pathname === "/mcp" || url.pathname.startsWith("/api/")) && hasValidRequestAuth(req)) return null;
  if (url.pathname === "/mcp" || url.pathname.startsWith("/api/")) {
    return json(mcpError("UNAUTHORIZED_REQUEST", "Non-local mutations require Story OS authorization", true), 403);
  }
  return null;
}

function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function validateSlug(raw: unknown, fallbackSource = "project"): string {
  const source = typeof raw === "string" ? raw.trim() : "";
  const slug = sanitizeSlug(source);
  if (!slug || !MCP_SLUG_RE.test(slug)) {
    throw Object.assign(new Error(`Invalid project slug: ${source || fallbackSource}`), { code: "INVALID_PROJECT_SLUG" });
  }
  return slug;
}

function projectDir(slug: string): string {
  if (!MCP_SLUG_RE.test(slug)) throw new Error("Unsafe project slug");
  return join(storiesRoot, slug);
}

function projectDbPath(slug: string): string {
  return join(projectDir(slug), "canon", "canon.db");
}

function projectGraphDir(slug: string): string {
  return join(projectDir(slug), "canon", "graph");
}

function projectDiagramsDir(slug: string): string {
  return join(projectDir(slug), "diagrams");
}

function projectChaptersDir(slug: string): string {
  return join(projectDir(slug), "chapters");
}

function assertPathWithinWorkspace(candidate: string): void {
  const normalizedRoot = resolve(workspaceRoot);
  const rel = relative(normalizedRoot, resolve(candidate));
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw Object.assign(new Error("Path outside workspace"), { code: "PATH_OUTSIDE_WORKSPACE" });
}

function now(): string {
  return new Date().toISOString();
}

function mcpOk<T extends JsonValue>(data: T, warnings: string[] = [], gate: JsonObject | null = null): McpOkResult<T> {
  return { ok: true, data, warnings, gate };
}

function mcpError(code: string, message: string, recoverable = true): McpErrorResult {
  return { ok: false, error: message, code, recoverable };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (isObject(value)) {
    const result: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = toJsonValue(v);
    }
    return result;
  }
  return String(value);
}

function safeJsonParse(raw: unknown): JsonValue {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return toJsonValue(parsed);
  } catch {
    return { raw };
  }
}

function formatPathSafe(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function hasTable(db: Database, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return Boolean(row);
}

function getTableColumns(db: Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const columns = getTableColumns(db, table);
  if (columns.has(column)) return;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function loadSchemaStatements(): string[] {
  if (cachedSchemaStatements) return cachedSchemaStatements;
  const text = readFileSync(schemaFile, "utf8");
  cachedSchemaStatements = text
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  return cachedSchemaStatements;
}

function applyCompatibilityMigrations(db: Database): void {
  const statements = loadSchemaStatements();
  db.run("BEGIN");
  try {
    for (const statement of statements) {
      db.run(statement);
    }

    ensureColumn(db, "gates", "blocker_reason", "TEXT");
    ensureColumn(db, "gates", "blocker_payload_json", "TEXT");

    ensureColumn(db, "gate_decisions", "project_id", "TEXT");
    ensureColumn(db, "gate_decisions", "decision", "TEXT");
    ensureColumn(db, "gate_decisions", "human_decision", "TEXT");
    ensureColumn(db, "gate_decisions", "human_confirmed", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "gate_decisions", "decision_source", "TEXT");
    ensureColumn(db, "gate_decisions", "notes", "TEXT");
    ensureColumn(db, "gate_decisions", "decided_by", "TEXT");
    ensureColumn(db, "gate_decisions", "decision_metadata_json", "TEXT");

    ensureColumn(db, "planning_artifacts", "artifact_key", "TEXT");
    ensureColumn(db, "planning_artifacts", "gate_id", "TEXT");
    ensureColumn(db, "mermaid_exports", "scope_id", "TEXT");
    ensureColumn(db, "mermaid_exports", "artifact_type", "TEXT");
    ensureColumn(db, "mermaid_exports", "artifact_id", "TEXT");
    ensureColumn(db, "mermaid_exports", "mermaid_text", "TEXT");

    ensureColumn(db, "chapters", "selected_variant_id", "TEXT");
    ensureColumn(db, "chapters", "selected_draft_revision_id", "TEXT");
    ensureColumn(db, "chapters", "approved_by_gate_id", "TEXT");
    ensureColumn(db, "chapters", "approved_at", "TEXT");
    ensureColumn(db, "chapters", "final_markdown_path", "TEXT");
    ensureColumn(db, "chapters", "completion_notes", "TEXT");
    ensureColumn(db, "chapters", "completed_at", "TEXT");

    ensureColumn(db, "chapter_variants", "changed_structurally", "TEXT");
    ensureColumn(db, "chapter_variants", "changed_emotionally", "TEXT");
    ensureColumn(db, "chapter_variants", "changed_in_pacing", "TEXT");
    ensureColumn(db, "chapter_variants", "canon_risk", "TEXT");
    ensureColumn(db, "chapter_variants", "continuity_risk", "TEXT");
    ensureColumn(db, "chapter_variants", "best_use_case", "TEXT");
    ensureColumn(db, "chapter_variants", "reason_to_choose", "TEXT");
    ensureColumn(db, "chapter_variants", "reason_not_to_choose", "TEXT");
    ensureColumn(db, "chapter_variants", "status", "TEXT NOT NULL DEFAULT 'draft'");
    ensureColumn(db, "chapter_variants", "selection_reason", "TEXT");
    ensureColumn(db, "chapter_variants", "updated_at", "TEXT");

    ensureColumn(db, "audit_runs", "artifact_type", "TEXT");
    ensureColumn(db, "audit_runs", "artifact_id", "TEXT");
    ensureColumn(db, "audit_runs", "artifact_path", "TEXT");
    ensureColumn(db, "audit_runs", "provenance_json", "TEXT");
    ensureColumn(db, "audit_runs", "completed_by", "TEXT");

    ensureColumn(db, "audit_findings", "finding_key", "TEXT");
    ensureColumn(db, "audit_findings", "evidence_json", "TEXT");
    ensureColumn(db, "audit_findings", "occurrence_count", "INTEGER NOT NULL DEFAULT 1");
    ensureColumn(db, "audit_findings", "resolved_at", "TEXT");
    ensureColumn(db, "audit_findings", "resolution_notes", "TEXT");
    ensureColumn(db, "audit_findings", "found_by", "TEXT");
    ensureColumn(db, "audit_findings", "found_at", "TEXT");

    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}

function ensureSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations(
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const already = db.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(MCP_SCHEMA_VERSION);
  if (!already) {
    applyCompatibilityMigrations(db);
    db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [MCP_SCHEMA_VERSION, now()]);
  } else {
    // Upgrade existing databases created by earlier phase builds.
    applyCompatibilityMigrations(db);
  }
}

function withProjectDb<T>(projectSlug: string, callback: (db: Database) => T): T {
  const dbPath = projectDbPath(projectSlug);
  assertPathWithinWorkspace(dbPath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    ensureSchema(db);
    return callback(db);
  } finally {
    db.close();
  }
}

function appendGraphLine(projectSlug: string, fileName: string, payload: JsonObject): void {
  const graphDir = projectGraphDir(projectSlug);
  mkdirSync(graphDir, { recursive: true });
  const target = join(graphDir, fileName);
  const record = { id: crypto.randomUUID(), ...payload, slug: projectSlug, emitted_at: now() };
  appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
}

function writeMermaidDiagram(projectSlug: string, fileName: string, mermaidText: string): string {
  const diagramDir = projectDiagramsDir(projectSlug);
  mkdirSync(diagramDir, { recursive: true });
  const file = formatPathSafe(fileName);
  const target = join(diagramDir, file.endsWith(".mmd") ? file : `${file}.mmd`);
  writeFileSync(target, mermaidText, "utf8");
  return target;
}

function getProjectDirEntries(): string[] {
  if (!existsSync(storiesRoot)) return [];
  return readdirSync(storiesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => MCP_SLUG_RE.test(name));
}

function scanProjectStatusBySlug(slug?: string): ProjectScanSummary[] {
  const targetSlugs = slug ? [slug] : getProjectDirEntries();
  const seen = new Set<string>();
  const resolved: ProjectScanSummary[] = [];

  for (const candidate of targetSlugs) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const dbPath = projectDbPath(candidate);
    const hasDatabase = existsSync(dbPath);

    if (!hasDatabase) {
      resolved.push({
        slug: candidate,
        hasDatabase: false,
        project: null,
        serialStatus: null,
        pendingGates: [],
        workflow: null
      });
      continue;
    }

    const entry = withProjectDb(candidate, (db) => {
      const project = db.prepare("SELECT id, slug, title, mode, created_at, updated_at FROM projects WHERE slug = ?").get(candidate) as
        | DbProject
        | undefined;
      if (!project) {
          return { slug: candidate, hasDatabase: true, project: null, serialStatus: null, pendingGates: [], workflow: null };
      }
      const pendingGates = db.prepare(
        "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE project_id = ? AND status = 'pending' ORDER BY created_at ASC",
      ).all(project.id) as DbGate[];
      const projectGates = collectProjectScopeAndGateRows(db, project.id, "project", project.id);
        const serialStatus = collectSerialStatus(db, project);
      return {
        slug: candidate,
        hasDatabase: true,
        project,
          serialStatus,
        pendingGates,
        workflow: computeProjectWorkflow(projectGates)
      };
    });

    resolved.push(entry);
  }

  return resolved;
}

function isSerialProject(project: DbProject): boolean {
  return project.mode === PROJECT_MODE_SERIAL;
}

function collectSerialStatus(db: Database, project: DbProject): SerialProjectStatus | null {
  if (!isSerialProject(project)) return null;

  const activeSeason = db
    .prepare("SELECT id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE project_id = ? AND status = 'active' ORDER BY season_number DESC LIMIT 1")
    .get(project.id) as DbSerialSeason | undefined;
  const latestSeason = db
    .prepare("SELECT id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE project_id = ? ORDER BY season_number DESC LIMIT 1")
    .get(project.id) as DbSerialSeason | undefined;

  const resolvedActiveSeason = activeSeason ?? latestSeason ?? null;
  const activeSeasonId = resolvedActiveSeason ? resolvedActiveSeason.id : null;
  const activeSeasonNumber = resolvedActiveSeason ? resolvedActiveSeason.season_number : null;

  const nextEpisode = resolvedActiveSeason
    ? (
      db
        .prepare("SELECT COALESCE(MAX(episode_number), 0) as value FROM serial_episodes WHERE project_id = ? AND season_id = ?")
        .get(project.id, resolvedActiveSeason.id) as { value: number } | undefined
    )
    : null;

  const unresolvedRows = db
    .prepare(
      `SELECT status, COUNT(*) AS count FROM serial_promises WHERE project_id = ? AND status IN ('open', 'advanced', 'deferred') GROUP BY status ORDER BY status`,
    )
    .all(project.id) as Array<{ status: string; count: number }>;
  const openCounts: Record<string, number> = {};
  let unresolvedTotal = 0;
  for (const row of unresolvedRows) {
    openCounts[row.status] = row.count;
    unresolvedTotal += row.count;
  }

  const pendingSerialGates = db
    .prepare(
      "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE project_id = ? AND gate_type IN (?, ?, ?) AND status = 'pending' ORDER BY created_at ASC LIMIT 20",
    )
    .all(project.id, ...SERIAL_GATES) as DbGate[];

  return {
    projectMode: project.mode,
    activeSeasonId,
    activeSeasonNumber,
    nextEpisodeNumber: resolvedActiveSeason && nextEpisode ? (nextEpisode.value + 1) : 1,
    openPromiseCounts: openCounts,
    unresolvedPromiseCount: unresolvedTotal,
    pendingSerialGates
  };
}

function resolveProjectSlugFromCwd(rawCwd: unknown): string | null {
  if (typeof rawCwd !== "string" || !rawCwd.trim()) return null;
  const cwd = resolve(rawCwd);
  const rel = relative(storiesRoot, cwd);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
  const slugCandidate = parts[0];
  if (!slugCandidate || !MCP_SLUG_RE.test(slugCandidate)) return null;
  return slugCandidate;
}

function ensureSerialProject(project: DbProject): void {
  if (project.mode !== PROJECT_MODE_SERIAL) {
    throw Object.assign(new Error("Project is not a serial project"), { code: "PROJECT_MODE_MISMATCH" });
  }
}

function validateSerialScopeValue(raw: unknown, field: string): SerialScope {
  if (typeof raw !== "string") {
    throw Object.assign(new Error(`Invalid ${field}`), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_SCOPES.includes(value as SerialScope)) {
    throw Object.assign(new Error(`Invalid ${field}: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value as SerialScope;
}

function validateSerialScopeOptional(raw: unknown, field: string): SerialScope | null {
  if (raw === undefined) return null;
  return validateSerialScopeValue(raw, field);
}

function validateSerialPromiseCategory(raw: unknown): SerialPromiseCategory {
  if (typeof raw !== "string") {
    throw Object.assign(new Error("Invalid category"), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_PROMISE_CATEGORIES.includes(value as SerialPromiseCategory)) {
    throw Object.assign(new Error(`Invalid category: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value as SerialPromiseCategory;
}

function validateSerialPromiseStatus(raw: unknown): SerialPromiseStatus {
  if (typeof raw !== "string") {
    throw Object.assign(new Error("Invalid status"), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_PROMISE_STATUSES.includes(value as SerialPromiseStatus)) {
    throw Object.assign(new Error(`Invalid status: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value as SerialPromiseStatus;
}

function validateSerialPromiseVisibility(raw: unknown): SerialPromiseVisibility {
  if (typeof raw !== "string") {
    throw Object.assign(new Error("Invalid visibility"), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_PROMISE_VISIBILITIES.includes(value as SerialPromiseVisibility)) {
    throw Object.assign(new Error(`Invalid visibility: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value as SerialPromiseVisibility;
}

function validateSerialRecapAudience(raw: unknown): SerialRecapAudience {
  if (typeof raw !== "string") {
    throw Object.assign(new Error("Invalid audience"), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_RECAP_AUDIENCES.includes(value as SerialRecapAudience)) {
    throw Object.assign(new Error(`Invalid audience: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value as SerialRecapAudience;
}

function parseInteger(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw Object.assign(new Error(`Invalid ${field}`), { code: "INVALID_PARAMS" });
  }
  return value;
}

function parsePositiveInteger(raw: unknown, field: string): number | null {
  const value = parseInteger(raw, field);
  if (value === null || value <= 0) {
    return null;
  }
  return value;
}

function parseNonNegativeInteger(raw: unknown, field: string): number {
  const value = parseInteger(raw, field);
  if (value === null || value < 0) {
    throw Object.assign(new Error(`Invalid ${field}`), { code: "INVALID_PARAMS" });
  }
  return value;
}

function serializeWhereIn(values: Array<string | number>): string {
  return values.map(() => "?").join(",");
}

function findSerialSeasonByNumber(db: Database, projectId: string, seasonNumber: number): DbSerialSeason | null {
  return db
    .prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE project_id = ? AND season_number = ?")
    .get(projectId, seasonNumber) as DbSerialSeason | undefined ?? null;
}

function getSerialSeasonById(db: Database, seasonId: string): DbSerialSeason | null {
  return db
    .prepare(
      "SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE id = ?",
    )
    .get(seasonId) as DbSerialSeason | undefined ?? null;
}

function getActiveSerialSeason(db: Database, projectId: string): DbSerialSeason | null {
  return db
    .prepare(
      "SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE project_id = ? AND status = 'active' ORDER BY season_number DESC LIMIT 1",
    )
    .get(projectId) as DbSerialSeason | undefined ?? null;
}

function getLatestSerialSeason(db: Database, projectId: string): DbSerialSeason | null {
  return db
    .prepare(
      "SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE project_id = ? ORDER BY season_number DESC LIMIT 1",
    )
    .get(projectId) as DbSerialSeason | undefined ?? null;
}

function getSerialEpisodeById(db: Database, projectId: string, episodeId: string): DbSerialEpisode | null {
  return db
    .prepare("SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at FROM serial_episodes WHERE id = ? AND project_id = ?")
    .get(episodeId, projectId) as DbSerialEpisode | undefined ?? null;
}

function getSerialEpisodeBySeasonAndNumber(db: Database, projectId: string, seasonId: string, episodeNumber: number): DbSerialEpisode | null {
  return db
    .prepare(
      "SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at FROM serial_episodes WHERE project_id = ? AND season_id = ? AND episode_number = ?",
    )
    .get(projectId, seasonId, episodeNumber) as DbSerialEpisode | undefined ?? null;
}

function getSerialEpisodeIdsForSeason(db: Database, projectId: string, seasonId: string): string[] {
  const rows = db.prepare("SELECT id FROM serial_episodes WHERE project_id = ? AND season_id = ?").all(projectId, seasonId) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function getNextSerialSequence(db: Database, projectId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(serial_sequence), 0) AS next FROM serial_episodes WHERE project_id = ?").get(projectId) as
    | { next: number }
    | undefined;
  return row ? row.next + 1 : 1;
}

function getNextSerialEpisodeNumberForSeason(db: Database, projectId: string, seasonId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(episode_number), 0) AS value FROM serial_episodes WHERE project_id = ? AND season_id = ?")
    .get(projectId, seasonId) as { value: number } | undefined;
  return row ? row.value + 1 : 1;
}

function validateSerialSeasonStatus(raw: unknown): string {
  if (typeof raw !== "string") {
    throw Object.assign(new Error("Invalid season status"), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_SEASON_STATUSES.includes(value as SerialSeasonStatus)) {
    throw Object.assign(new Error(`Invalid season status: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value;
}

function validateSerialEpisodeStatus(raw: unknown): string {
  if (typeof raw !== "string") {
    throw Object.assign(new Error("Invalid episode status"), { code: "INVALID_PARAMS" });
  }
  const value = raw.trim();
  if (!value || !SERIAL_EPISODE_STATUSES.includes(value as SerialEpisodeStatus)) {
    throw Object.assign(new Error(`Invalid episode status: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value;
}

function validateSerialAudience(raw: unknown): SerialRecapAudience {
  if (typeof raw !== "string") {
    return "reader";
  }
  const value = raw.trim();
  if (!value) return "reader";
  if (!SERIAL_RECAP_AUDIENCES.includes(value as SerialRecapAudience)) {
    throw Object.assign(new Error(`Invalid audience: ${value}`), { code: "INVALID_PARAMS" });
  }
  return value as SerialRecapAudience;
}

function resolveSerialScopeFromArgs(args: JsonObject): { scopeType: SerialScope | null; scopeId: string | null } {
  const scopeType = getOptionalString(args, "scopeType");
  if (!scopeType) return { scopeType: null, scopeId: null };
  const validatedScope = validateSerialScopeValue(scopeType, "scopeType");
  const scopeId = getOptionalString(args, "scopeId");
  if (scopeId === null) {
    return { scopeType: validatedScope, scopeId: null };
  }
  return { scopeType: validatedScope, scopeId };
}

function recordSerialPromiseEvent(
  db: Database,
  promiseId: string,
  eventType: string,
  episodeId: string | null = null,
  notes: string | null = null,
  sourceRef: string | null = null
): void {
  db.prepare(
    "INSERT INTO serial_promise_events(id, promise_id, event_type, episode_id, notes, source_ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    crypto.randomUUID(),
    promiseId,
    eventType,
    episodeId,
    notes,
    sourceRef,
    now(),
  );
}

function collectSerialHookState(db: Database, project: DbProject): JsonObject {
  const serialStatus = collectSerialStatus(db, project);
  const pendingGates = db
    .prepare(
      "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE project_id = ? ORDER BY created_at DESC LIMIT 20",
    )
    .all(project.id) as DbGate[];

  const recentPromises: DbSerialPromise[] = isSerialProject(project)
    ? db
      .prepare(
        `SELECT id, project_id, title, category, status, visibility, priority, opened_episode_id, target_scope_type, target_scope_id, payoff_episode_id, source_ref, created_at, updated_at
         FROM serial_promises WHERE project_id = ? AND status IN ('open', 'advanced', 'deferred') ORDER BY updated_at DESC LIMIT 20`,
      )
      .all(project.id) as DbSerialPromise[]
    : [];

  const recentEpisodes = isSerialProject(project)
    ? db
      .prepare(
        `SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at
         FROM serial_episodes WHERE project_id = ? ORDER BY serial_sequence DESC LIMIT 20`,
      )
      .all(project.id) as DbSerialEpisode[]
    : [];

  const serialState = serialStatus
    ? {
      projectMode: serialStatus.projectMode,
      activeSeasonId: serialStatus.activeSeasonId,
      activeSeasonNumber: serialStatus.activeSeasonNumber,
      nextEpisodeNumber: serialStatus.nextEpisodeNumber,
      openPromiseCounts: serialStatus.openPromiseCounts,
      unresolvedPromiseCount: serialStatus.unresolvedPromiseCount,
      pendingSerialGates: serialStatus.pendingSerialGates.map((gate) => toJsonValue(gate))
    }
    : null;

  return {
    project: toJsonValue(project),
    serialStatus: serialState,
    pendingGates: pendingGates.map((gate) => toJsonValue(gate)),
    openPromises: recentPromises.map((promise) => toJsonValue(promise)),
    recentEpisodes: recentEpisodes.map((episode) => toJsonValue(episode))
  };
}

function clampBoundedStateRows<T>(rows: T[], maxRows: number): T[] {
  return rows.slice(0, Math.max(0, Math.min(maxRows, 50)));
}

function isKnownPlanningStage(value: string): value is PlanningStage {
  return PLANNING_STAGES.includes(value as PlanningStage);
}

function computeProjectWorkflow(gates: DbGate[]): ProjectWorkflowState {
  const latestByStage = new Map<string, DbGate>();
  for (const gate of gates) {
    const current = latestByStage.get(gate.gate_type);
    if (!current || gate.created_at > current.created_at) latestByStage.set(gate.gate_type, gate);
  }

  for (const stage of PLANNING_STAGES) {
    const gate = latestByStage.get(stage);
    if (!gate) {
      return {
        currentStage: stage,
        allowedNextAction: `record_${stage}`
      };
    }

    if (gate.status === "pending") {
      return {
        currentStage: stage,
        allowedNextAction: "submit_gate_decision",
        blockerGateType: gate.gate_type,
        blockerGateId: gate.id,
        blockerGateStatus: gate.status
      };
    }

    if (BLOCKING_GATE_STATUSES.has(gate.status)) {
      return {
        currentStage: stage,
        allowedNextAction: "resolve_audit_block",
        blockerGateType: gate.gate_type,
        blockerGateId: gate.id,
        blockerGateStatus: gate.status
      };
    }

    if (NON_APPROVED_GATE_STATUSES.has(gate.status)) {
      return {
        currentStage: stage,
        allowedNextAction: "revise_and_retry",
        blockerGateType: gate.gate_type,
        blockerGateId: gate.id,
        blockerGateStatus: gate.status
      };
    }
  }

  return {
    currentStage: "mermaid_export",
    allowedNextAction: "complete_workflow"
  };
}

function collectPendingGate(projectSlug?: string): DbGate | null {
  if (projectSlug) {
    const rows = scanProjectStatusBySlug(projectSlug);
    if (rows.length === 0) return null;
    const candidate = rows.flatMap((row) => row.pendingGates).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    return candidate ?? null;
  }

  const allPending = scanProjectStatusBySlug().flatMap((row) => row.pendingGates).sort((a, b) => a.created_at.localeCompare(b.created_at));
  return allPending[0] ?? null;
}

function collectProjectScopeAndGateRows(db: Database, projectId: string, scopeType: string, scopeId: string, gateType?: string): DbGate[] {
  if (gateType) {
    return db
      .prepare(
        "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE project_id = ? AND scope_type = ? AND scope_id = ? AND gate_type = ? ORDER BY created_at ASC",
      )
      .all(projectId, scopeType, scopeId, gateType) as DbGate[];
  }

  return db
    .prepare(
      "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE project_id = ? AND scope_type = ? AND scope_id = ? ORDER BY created_at ASC",
    )
    .all(projectId, scopeType, scopeId) as DbGate[];
}

function getLatestGateForType(db: Database, projectId: string, scopeType: string, scopeId: string, gateType: string): DbGate | null {
  return db
    .prepare(
      "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE project_id = ? AND scope_type = ? AND scope_id = ? AND gate_type = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId, scopeType, scopeId, gateType) as DbGate | undefined ?? null;
}

function ensurePendingGate(db: Database, projectId: string, scopeType: string, scopeId: string, gateType: string): DbGate {
  const existing = getLatestGateForType(db, projectId, scopeType, scopeId, gateType);
  if (existing && existing.status === "pending") return existing;

  const nowValue = now();
  const gateId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO gates(id, project_id, scope_type, scope_id, gate_type, status, required, created_at) VALUES (?, ?, ?, ?, ?, 'pending', 1, ?)",
  ).run(gateId, projectId, scopeType, scopeId, gateType, nowValue);

  return db
    .prepare(
      "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE id = ?",
    )
    .get(gateId) as DbGate;
}

function ensureNextStageGateIfPossible(
  db: Database,
  projectId: string,
  scopeType: string,
  scopeId: string,
  currentStage: PlanningStage,
  currentStageStatus: string
): DbGate | null {
  const idx = PLANNING_STAGES.indexOf(currentStage);
  if (idx === -1 || idx === PLANNING_STAGES.length - 1) return null;
  if (currentStageStatus !== "approved") return null;

  const next = PLANNING_STAGES[idx + 1];
  const nextGate = ensurePendingGate(db, projectId, scopeType, scopeId, next);
  return nextGate;
}

function planningStageOrderIndex(stage: string): number {
  return PLANNING_STAGES.indexOf(stage as PlanningStage);
}

function enforcePriorGateApproved(db: Database, projectId: string, scopeType: string, scopeId: string, stage: PlanningStage): void {
  const idx = planningStageOrderIndex(stage);
  if (idx <= 0) return;
  const previous = PLANNING_STAGES[idx - 1];
  const gate = getLatestGateForType(db, projectId, scopeType, scopeId, previous);
  if (!gate) {
    throw Object.assign(new Error(`Missing required prerequisite gate: ${previous}`), { code: "MISSING_GATE" });
  }
  if (gate.status === "pending") {
    throw Object.assign(new Error(`Prerequisite gate not approved: ${previous}`), { code: "GATE_NOT_APPROVED" });
  }
  if (BLOCKING_GATE_STATUSES.has(gate.status)) {
    throw Object.assign(new Error(`Prerequisite gate blocked by audit: ${previous}`), { code: "GATE_BLOCKED" });
  }
  if (NON_APPROVED_GATE_STATUSES.has(gate.status)) {
    throw Object.assign(new Error(`Prerequisite gate not approved: ${previous}`), { code: "GATE_NOT_APPROVED" });
  }
  if (gate.status !== "approved") {
    throw Object.assign(new Error(`Prerequisite gate not approved: ${previous}`), { code: "GATE_NOT_APPROVED" });
  }
}

function ensureGateApproved(db: Database, projectId: string, scopeType: string, scopeId: string, gateType: string): DbGate {
  const gate = getLatestGateForType(db, projectId, scopeType, scopeId, gateType);
  if (!gate) {
    throw Object.assign(new Error(`Missing required gate: ${gateType}`), { code: "MISSING_GATE" });
  }
  if (gate.status === "pending") {
    throw Object.assign(new Error(`Required gate not approved: ${gateType}`), { code: "GATE_NOT_APPROVED" });
  }
  if (BLOCKING_GATE_STATUSES.has(gate.status)) {
    throw Object.assign(new Error(`Required gate blocked by audit: ${gateType}`), { code: "GATE_BLOCKED" });
  }
  if (NON_APPROVED_GATE_STATUSES.has(gate.status)) {
    throw Object.assign(new Error(`Required gate not approved: ${gateType}`), { code: "GATE_NOT_APPROVED" });
  }
  return gate;
}

function ensureProjectWorkflowComplete(db: Database, project: DbProject): void {
  for (const stage of PLANNING_STAGES) {
    ensureGateApproved(db, project.id, "project", project.id, stage);
  }
}

function getChapterRow(db: Database, project: DbProject, chapterId: string): DbChapter {
  const chapter = db.prepare("SELECT id, project_id, container_type, container_id, chapter_number, title, status, markdown_path, selected_variant_id, selected_draft_revision_id, approved_by_gate_id, approved_at, final_markdown_path, completion_notes, completed_at, created_at, updated_at FROM chapters WHERE id = ? AND project_id = ?").get(chapterId, project.id) as
    | DbChapter
    | undefined;
  if (!chapter) throw Object.assign(new Error(`Chapter not found: ${chapterId}`), { code: "CHAPTER_NOT_FOUND" });
  return chapter;
}

function ensureChapterExists(db: Database, project: DbProject, chapterId: string): DbChapter {
  return getChapterRow(db, project, chapterId);
}

function ensureChapterPreProseApproved(db: Database, projectId: string, chapterId: string): void {
  for (const gateType of CHAPTER_PRE_PROSE_GATES) {
    if (gateType === "pre_prose_human_approval") {
      ensureHumanApprovedGate(db, projectId, "chapter", chapterId, gateType);
    } else {
      ensureGateApproved(db, projectId, "chapter", chapterId, gateType);
    }
  }
}

function ensureChapterPostProseApproved(db: Database, projectId: string, chapterId: string): void {
  for (const gateType of CHAPTER_POST_PROSE_GATES) {
    ensureGateApproved(db, projectId, "chapter", chapterId, gateType);
  }
}

function ensureFinalHumanApproval(db: Database, projectId: string, chapterId: string): DbGate {
  return ensureHumanApprovedGate(db, projectId, "chapter", chapterId, CHAPTER_FINAL_APPROVAL_GATE);
}

function ensureVariantChoiceApprovedForVariant(db: Database, projectId: string, chapterId: string, variantId: string): DbGate {
  const gate = getLatestGateForType(db, projectId, "chapter", chapterId, CHAPTER_VARIANT_CHOICE_GATE);
  if (!gate) {
    throw Object.assign(new Error("Missing required gate: chapter_variant_choice"), { code: "MISSING_GATE" });
  }
  if (gate.status !== "approved") {
    throw Object.assign(new Error("chapter_variant_choice gate is not approved"), { code: "GATE_NOT_APPROVED" });
  }

  const decision = db
    .prepare("SELECT id, gate_id, project_id, decision, human_decision, human_confirmed, decision_source, notes, decided_by, decided_at, decision_metadata_json FROM gate_decisions WHERE gate_id = ? ORDER BY decided_at DESC LIMIT 1")
    .get(gate.id) as DbGateDecision | undefined;
  if (!decision) {
    throw Object.assign(new Error("chapter_variant_choice gate has no recorded human decision"), { code: "GATE_DECISION_MISSING" });
  }
  if (!decision.human_confirmed || decision.decision_source !== "omp_ui_confirmation") {
    throw Object.assign(new Error("chapter_variant_choice must be recorded via OMP UI confirmation"), { code: "UNAUTHORIZED_GATE_DECISION" });
  }
  const metadata = safeJsonParse(decision.decision_metadata_json);
  if (!isObject(metadata)) {
    throw Object.assign(new Error("chapter_variant_choice decision missing provenance metadata"), { code: "GATE_DECISION_ERROR" });
  }
  const selectedFromMetadata = typeof metadata.selectedVariantId === "string" ? metadata.selectedVariantId : null;
  const selectedFromVariant = typeof metadata.variantId === "string" ? metadata.variantId : null;
  const selectedVariantId = selectedFromMetadata ?? selectedFromVariant;
  if (!selectedVariantId) {
    throw Object.assign(new Error("chapter_variant_choice decision missing selected variant metadata"), { code: "GATE_DECISION_ERROR" });
  }
  if (selectedFromMetadata && selectedFromMetadata !== variantId) {
    throw Object.assign(new Error(`chapter_variant_choice gate does not reference selected variant ${variantId}`), { code: "GATE_DECISION_MISMATCH" });
  }
  if (selectedFromVariant && selectedFromVariant !== variantId) {
    throw Object.assign(new Error(`chapter_variant_choice gate does not reference selected variant ${variantId}`), { code: "GATE_DECISION_MISMATCH" });
  }
  return gate;
}

function ensureExactlyThreeVariants(db: Database, chapterId: string): Array<DbChapterVariant> {
  const variants = db.prepare(
    "SELECT id, chapter_id, variant_type, purpose, changed_structurally, changed_emotionally, changed_in_pacing, canon_risk, continuity_risk, best_use_case, reason_to_choose, reason_not_to_choose, markdown_path, rank_score, ranking_reason, selected, status, selection_reason, updated_at, created_at FROM chapter_variants WHERE chapter_id = ? ORDER BY created_at ASC",
  ).all(chapterId) as DbChapterVariant[];
  if (variants.length !== CHAPTER_VARIANT_TYPES.length) {
    throw Object.assign(
      new Error(`Expected exactly ${CHAPTER_VARIANT_TYPES.length} variants, found ${variants.length}`),
      { code: "INVALID_VARIANT_COUNT" },
    );
  }
  const uniqueTypes = new Set<string>(variants.map((variant) => variant.variant_type));
  if (CHAPTER_VARIANT_TYPES.some((variantType) => !uniqueTypes.has(variantType))) {
    throw Object.assign(new Error("Variant set missing required chapter variant types"), { code: "INVALID_VARIANT_TYPES" });
  }
  return variants;
}

function ensureSelectedDraftRevision(db: Database, chapter: DbChapter): DbChapterDraftRevision {
  if (!chapter.selected_draft_revision_id) {
    throw Object.assign(new Error("No selected draft revision found for chapter"), { code: "MISSING_SELECTED_DRAFT" });
  }
  const revision = db
    .prepare(
      "SELECT id, project_id, chapter_id, variant_id, draft_stage, status, markdown_path, revision_notes, is_selected, provenance_json, created_at, updated_at FROM chapter_draft_revisions WHERE id = ? AND chapter_id = ?",
    )
    .get(chapter.selected_draft_revision_id, chapter.id) as DbChapterDraftRevision | undefined;
  if (!revision) {
    throw Object.assign(new Error("Selected draft revision record missing"), { code: "MISSING_SELECTED_DRAFT" });
  }
  if (revision.is_selected !== 1) {
    throw Object.assign(new Error("Selected draft revision is not marked as selected"), { code: "INVALID_SELECTED_DRAFT" });
  }
  return revision;
}

function ensureHumanApprovedGate(db: Database, projectId: string, scopeType: string, scopeId: string, gateType: string): DbGate {
  const gate = getLatestGateForType(db, projectId, scopeType, scopeId, gateType);
  if (!gate) {
    throw Object.assign(new Error(`Missing required gate: ${gateType}`), { code: "MISSING_GATE" });
  }
  if (gate.status !== "approved") {
    throw Object.assign(new Error(`Required gate not approved: ${gateType}`), { code: "GATE_NOT_APPROVED" });
  }
  const decision = db
    .prepare("SELECT id, gate_id, project_id, decision, human_decision, human_confirmed, decision_source, notes, decided_by, decided_at, decision_metadata_json FROM gate_decisions WHERE gate_id = ? ORDER BY decided_at DESC LIMIT 1")
    .get(gate.id) as DbGateDecision | undefined;
  if (!decision) {
    throw Object.assign(new Error(`Gate ${gateType} missing human provenance`), { code: "GATE_DECISION_MISSING" });
  }
  if (!decision.human_confirmed || decision.decision_source !== "omp_ui_confirmation") {
    throw Object.assign(new Error(`Gate ${gateType} must be recorded via OMP UI confirmation`), { code: "UNAUTHORIZED_GATE_DECISION" });
  }
  return gate;
}

function parseChapterScope(args: JsonObject): { scopeType: string; scopeId: string } {
  const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType.trim() : "chapter";
  const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0 ? args.scopeId.trim() : "";
  return { scopeType, scopeId };
}

function writeProjectFile(projectSlug: string, relativePath: string, content: string): string {
  const normalizedRelative = relativePath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalizedRelative.length) {
    throw Object.assign(new Error("Missing relative file path"), { code: "INVALID_PARAMS" });
  }
  const baseDir = projectDir(projectSlug);
  const target = resolve(baseDir, normalizedRelative);
  const rel = relative(baseDir, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw Object.assign(new Error(`Invalid or unsafe file path: ${relativePath}`), { code: "INVALID_FILE_PATH" });
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, "utf8");
  return target;
}

function appendProjectMemoryLine(projectSlug: string, fileName: string, payload: JsonObject): string {
  const memoryDir = join(projectDir(projectSlug), "memory");
  mkdirSync(memoryDir, { recursive: true });
  const file = fileName.endsWith(".jsonl") ? fileName : `${fileName}.jsonl`;
  const target = join(memoryDir, file);
  const record = { id: crypto.randomUUID(), ...payload, slug: projectSlug, emitted_at: now() };
  appendFileSync(target, `${JSON.stringify(record)}\n`, "utf8");
  return target;
}

const HOOK_ARTIFACT_PATH_KEYS = [
  "artifactPath",
  "artifact_path",
  "filePath",
  "file_path",
  "finalMarkdownPath",
  "final_markdown_path",
  "graphDir",
  "graph_dir",
  "markdownPath",
  "markdown_path",
  "outlinePath",
  "outline_path",
  "path"
] as const;

const HOOK_PROJECT_KEYS = ["projectSlug", "project_slug"] as const;
const HOOK_CHAPTER_KEYS = ["chapterId", "chapter_id"] as const;
const HOOK_SCOPE_TYPE_KEYS = ["scopeType", "scope_type"] as const;
const HOOK_SCOPE_ID_KEYS = ["scopeId", "scope_id"] as const;

function uniqueStrings(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function collectHookFieldValues(value: unknown, fieldNames: readonly string[], depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) {
    const result: string[] = [];
    for (const item of value) result.push(...collectHookFieldValues(item, fieldNames, depth + 1));
    return result;
  }
  if (!isObject(value)) return [];

  const result: string[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (fieldNames.includes(key) && typeof entry === "string" && entry.trim().length > 0) {
      result.push(entry.trim());
    }
    result.push(...collectHookFieldValues(entry, fieldNames, depth + 1));
  }
  return result;
}

function firstHookField(value: unknown, fieldNames: readonly string[]): string {
  return uniqueStrings(collectHookFieldValues(value, fieldNames))[0] ?? "";
}

function validateHookArtifactPaths(value: unknown): JsonObject[] {
  const paths = uniqueStrings(collectHookFieldValues(value, HOOK_ARTIFACT_PATH_KEYS));
  const validated: JsonObject[] = [];
  for (const rawPath of paths) {
    if (/^[a-z]+:\/\//i.test(rawPath)) continue;
    const normalized = rawPath.replace(/\\/g, "/");
    const localPath = normalized.startsWith("/workspace/")
      ? join(workspaceRoot, normalized.slice("/workspace/".length))
      : normalized;
    const absolutePath = isAbsolute(localPath) ? resolve(localPath) : resolve(workspaceRoot, localPath);
    assertPathWithinWorkspace(absolutePath);
    validated.push({
      path: relative(workspaceRoot, absolutePath) || ".",
      exists: existsSync(absolutePath)
    });
  }
  return validated;
}

function resolveHookProjectSlug(body: JsonObject): string | null {
  const explicit = firstHookField(body, HOOK_PROJECT_KEYS);
  if (explicit) return validateSlug(explicit);
  return resolveRequestProjectSlug(body);
}

function recordToolResultArtifact(projectSlug: string, body: JsonObject): JsonObject {
  const toolName = typeof body.toolName === "string" ? body.toolName : "unknown";
  const isError = body.isError === true;
  const validatedPaths = validateHookArtifactPaths(body);

  const stored = withProjectDb(projectSlug, (db) => {
    const project = getProjectRowOrError(db, projectSlug);
    const chapterId = firstHookField(body, HOOK_CHAPTER_KEYS);
    const requestedScopeType = firstHookField(body, HOOK_SCOPE_TYPE_KEYS);
    const requestedScopeId = firstHookField(body, HOOK_SCOPE_ID_KEYS);
    const scopeType = chapterId ? "chapter" : requestedScopeType || "project";
    const scopeId = chapterId || requestedScopeId || project.id;
    const nowValue = now();
    const artifactId = crypto.randomUUID();
    const payload = {
      toolName,
      isError,
      details: body.details ?? null,
      validatedPaths
    };

    db.prepare(
      `INSERT INTO planning_artifacts(id, project_id, scope_type, scope_id, artifact_type, artifact_key, title, payload_json, gate_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      project.id,
      scopeType,
      scopeId,
      "hook_tool_result",
      toolName,
      toolName,
      JSON.stringify(toJsonValue(payload)),
      null,
      nowValue,
      nowValue,
    );

    return { artifactId, scopeType, scopeId };
  });

  const memoryPath = appendProjectMemoryLine(projectSlug, "tool_results", {
    action: "tool_result_recorded",
    toolName,
    isError,
    artifactId: stored.artifactId,
    validatedPaths
  });

  return {
    ...stored,
    projectSlug,
    persisted: true,
    memoryPath: relative(workspaceRoot, memoryPath),
    validatedPaths,
    artifactCount: validatedPaths.length
  };
}

function ensureMissingChapterGate(db: Database, projectId: string, chapterId: string, gateType: string, created: JsonObject[]): void {
  const existing = getLatestGateForType(db, projectId, "chapter", chapterId, gateType);
  if (existing) return;
  const gate = ensurePendingGate(db, projectId, "chapter", chapterId, gateType);
  created.push(toJsonValue(gate) as JsonObject);
}

function createTurnEndChapterGates(projectSlug: string, details: JsonObject): JsonObject[] {
  return withProjectDb(projectSlug, (db) => {
    const project = getProjectRowOrError(db, projectSlug);
    const requestedChapterId = firstHookField(details, HOOK_CHAPTER_KEYS);
    const chapters = requestedChapterId
      ? [getChapterRow(db, project, requestedChapterId)]
      : db
        .prepare("SELECT id, project_id, container_type, container_id, chapter_number, title, status, markdown_path, selected_variant_id, selected_draft_revision_id, approved_by_gate_id, approved_at, final_markdown_path, completion_notes, completed_at, created_at, updated_at FROM chapters WHERE project_id = ? AND status != 'complete'")
        .all(project.id) as DbChapter[];
    const created: JsonObject[] = [];

    for (const chapter of chapters) {
      if (chapter.markdown_path) {
        for (const gateType of CHAPTER_PRE_PROSE_GATES) {
          ensureMissingChapterGate(db, project.id, chapter.id, gateType, created);
        }
      }

      const variantCount = db
        .prepare("SELECT COUNT(*) AS count FROM chapter_variants WHERE chapter_id = ?")
        .get(chapter.id) as { count: number } | undefined;
      if ((variantCount?.count ?? 0) >= CHAPTER_VARIANT_TYPES.length) {
        ensureMissingChapterGate(db, project.id, chapter.id, CHAPTER_VARIANT_CHOICE_GATE, created);
      }

      if (chapter.selected_draft_revision_id) {
        for (const gateType of CHAPTER_POST_PROSE_GATES) {
          ensureMissingChapterGate(db, project.id, chapter.id, gateType, created);
        }
        ensureMissingChapterGate(db, project.id, chapter.id, CHAPTER_FINAL_APPROVAL_GATE, created);
      }
    }

    return created;
  });
}

function resolveChapterFilePath(projectSlug: string, candidatePath: string): string {
  const candidate = candidatePath.trim().replace(/\\/g, "/");
  if (!candidate) {
    throw Object.assign(new Error("Missing chapter file path"), { code: "INVALID_PARAMS" });
  }
  const baseDir = projectDir(projectSlug);
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(baseDir, candidate.replace(/^\/+/, ""));
  const rel = relative(baseDir, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw Object.assign(new Error(`Invalid or unsafe chapter file path: ${candidatePath}`), { code: "INVALID_FILE_PATH" });
  }
  return target;
}

function projectStatusData(projectSlug?: string): McpOkResult<JsonObject> | McpErrorResult {
  try {
    const slug = projectSlug ? validateSlug(projectSlug) : undefined;
    const projectRows = scanProjectStatusBySlug(slug);
    const pendingGates = projectRows.flatMap((entry) => entry.pendingGates);
    const workflow = projectRows.length === 1
      ? projectRows[0].workflow
      : null;
    return mcpOk({
      projects: projectRows,
      pendingGates,
      count: projectRows.length,
      workflow
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code ?? "PROJECT_STATUS_ERROR", err.message ?? "Unable to read project status", true);
  }
}

function getRequiredString(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw Object.assign(new Error(`Missing required parameter: ${name}`), { code: "INVALID_PARAMS" });
  }
  return value.trim();
}

function getOptionalBoolean(args: JsonObject, name: string, fallback = false): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return Boolean(value);
}

function normalizeGateDecision(value: unknown): GateDecisionStatus | null {
  if (typeof value === "boolean") {
    return value ? "approved" : "rejected";
  }

  if (typeof value === "number") {
    if (value === 1) return "approved";
    if (value === 0) return "rejected";
    return null;
  }

  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "approved" || normalized === "approve" || normalized === "accept" || normalized === "accepted") return "approved";
  if (normalized === "rejected" || normalized === "reject") return "rejected";
  if (normalized === "needs_revision" || normalized === "needs-revision" || normalized === "needs revision" || normalized === "needs" || normalized === "revise") {
    return "needs_revision";
  }
  if (normalized === "blocked_by_audit" || normalized === "blocked-by-audit") return "blocked_by_audit";

  return null;
}

function getProjectRowOrError(db: Database, projectSlug: string): DbProject {
  const project = db.prepare("SELECT id, slug, title, mode, created_at, updated_at FROM projects WHERE slug = ?").get(projectSlug) as
    | DbProject
    | undefined;
  if (!project) throw Object.assign(new Error(`Project not found: ${projectSlug}`), { code: "PROJECT_NOT_FOUND" });
  return project;
}

function normalizeScopeId(project: DbProject, args: JsonObject, scopeTypeFallback: string): { scopeType: string; scopeId: string } {
  const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType.trim() : scopeTypeFallback;
  const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0 ? args.scopeId.trim() : project.id;
  return { scopeType, scopeId };
}

function createOrUpdateProject(args: JsonObject): McpToolResult {
  try {
    if (typeof args.slug !== "string" || args.slug.trim().length === 0) {
      throw Object.assign(new Error("Missing required parameter: slug"), { code: "INVALID_PARAMS" });
    }
    if (typeof args.mode !== "string" || args.mode.trim().length === 0) {
      throw Object.assign(new Error("Missing required parameter: mode"), { code: "INVALID_PARAMS" });
    }
    const inputTitle = typeof args.title === "string" && args.title.trim().length > 0 ? args.title : args.slug;
    const candidateSlug = args.slug;
    const slug = validateSlug(candidateSlug, "project");
    const mode = args.mode.trim();

    const result = withProjectDb(slug, (db) => {
      const createdAt = now();
      const existing = db
        .prepare("SELECT id, slug, title, mode, created_at, updated_at FROM projects WHERE slug = ?")
        .get(slug) as DbProject | undefined;

      if (existing) {
        db.prepare("UPDATE projects SET title = ?, mode = ?, updated_at = ? WHERE slug = ?")
          .run(inputTitle, mode, createdAt, slug);
      } else {
        const projectId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO projects(id, slug, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(projectId, slug, inputTitle, mode, createdAt, createdAt);
      }

      const project = db
        .prepare("SELECT id, slug, title, mode, created_at, updated_at FROM projects WHERE slug = ?")
        .get(slug) as DbProject;

      const premiseGate = ensurePendingGate(db, project.id, "project", project.id, "premise");

      appendGraphLine(slug, "projects.jsonl", {
        kind: "project_created_or_updated",
        projectId: project.id,
        title: project.title,
        mode: project.mode
      });

      return { project, premiseGate };
    });

    return mcpOk({
      project: result.project,
      dbPath: projectDbPath(slug),
      graphDir: projectGraphDir(slug),
      gate: result.premiseGate
    }, [], result.premiseGate);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "PROJECT_CREATE_ERROR", err.message || "Unable to create project", true);
  }
}

function upsertCanonFact(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const factType = getRequiredString(args, "factType");
    const factText = getRequiredString(args, "factText");
    const sourceRef = typeof args.sourceRef === "string" && args.sourceRef.trim().length > 0 ? args.sourceRef : "story-os-mcp";
    const confidenceRaw = typeof args.confidence === "number" ? args.confidence : 1;
    const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 1;
    const entityId = typeof args.entityId === "string" && args.entityId.trim().length > 0 ? args.entityId : null;
    const locked = args.locked === true ? 1 : 0;
    const supersedes = typeof args.supersedesFactId === "string" && args.supersedesFactId.trim().length > 0
      ? args.supersedesFactId
      : null;
    const factId = typeof args.id === "string" && args.id.trim().length > 0 ? args.id : crypto.randomUUID();
    const createdAt = now();

    const fact = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      db.prepare(
        `INSERT INTO canon_facts(id, project_id, entity_id, fact_type, fact_text, source_ref, confidence, locked, supersedes_fact_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           entity_id = excluded.entity_id,
           fact_type = excluded.fact_type,
           fact_text = excluded.fact_text,
           source_ref = excluded.source_ref,
           confidence = excluded.confidence,
           locked = excluded.locked,
           supersedes_fact_id = excluded.supersedes_fact_id`,
      ).run(factId, project.id, entityId, factType, factText, sourceRef, confidence, locked, supersedes, createdAt);

      appendGraphLine(projectSlug, "canon_facts.jsonl", {
        action: "upsert_fact",
        factId,
        projectId: project.id,
        factType,
        factText,
        sourceRef,
        confidence,
        locked: Boolean(locked),
        supersedes
      });

      return db.prepare(
        "SELECT id, project_id, entity_id, fact_type, fact_text, source_ref, confidence, locked, supersedes_fact_id, created_at FROM canon_facts WHERE id = ?",
      ).get(factId) as DbCanonFact;
    });

    return mcpOk({ fact: toJsonValue(fact) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CANON_UPSERT_ERROR", err.message || "Unable to upsert canon fact", true);
  }
}

function searchCanonFacts(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    const factType = typeof args.factType === "string" ? args.factType.trim() : "";
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(200, Number(args.limit))) : 25;

    if (query.length === 0) {
      throw Object.assign(new Error("Missing required parameter: query"), { code: "INVALID_PARAMS" });
    }

    const facts = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const where: string[] = ["project_id = ?"];
      const params: (string | number)[] = [project.id];
      where.push("LOWER(fact_text) LIKE ?");
      params.push(`%${query}%`);
      if (factType.length > 0) {
        where.push("fact_type = ?");
        params.push(factType);
      }

      const rows = db.prepare(
        `SELECT id, project_id, entity_id, fact_type, fact_text, source_ref, confidence, locked, supersedes_fact_id, created_at
         FROM canon_facts
         WHERE ${where.join(" AND ")}
         ORDER BY created_at DESC
         LIMIT ?`,
      ).all(...params, limit) as DbCanonFact[];

      return rows.map((fact) => toJsonValue(fact));
    });

    return mcpOk({ query, total: facts.length, facts });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CANON_SEARCH_ERROR", err.message || "Unable to search canon facts", true);
  }
}

function upsertKgEntity(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const type = getRequiredString(args, "type");
    const name = getRequiredString(args, "name");
    const id = typeof args.id === "string" && args.id.trim().length > 0 ? args.id : crypto.randomUUID();
    const description = typeof args.description === "string" && args.description.trim().length > 0 ? args.description : null;
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status : null;
    const firstSeenRef = typeof args.firstSeenRef === "string" && args.firstSeenRef.trim().length > 0 ? args.firstSeenRef : null;
    const lastSeenRef = typeof args.lastSeenRef === "string" && args.lastSeenRef.trim().length > 0 ? args.lastSeenRef : null;
    const aliases = Array.isArray(args.aliases) ? args.aliases.filter((item) => typeof item === "string") : [];
    const aliasesJson = aliases.length > 0 ? JSON.stringify(aliases) : null;
    const nowValue = now();

    const entity = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const byId = db.prepare("SELECT * FROM entities WHERE id = ?").get(id) as DbEntity | undefined;
      const byIdentity = db
        .prepare("SELECT * FROM entities WHERE project_id = ? AND type = ? AND name = ?")
        .get(project.id, type, name) as DbEntity | undefined;
      const existing = byId ?? byIdentity;

      const targetId = existing?.id ?? id;
      if (existing) {
        db.prepare(
          `UPDATE entities
           SET type = ?, name = ?, aliases_json = ?, description = ?, status = ?, first_seen_ref = ?, last_seen_ref = ?, updated_at = ?
           WHERE id = ?`,
        ).run(type, name, aliasesJson, description, status, firstSeenRef, lastSeenRef, nowValue, targetId);
      } else {
        db.prepare(
          `INSERT INTO entities(id, project_id, type, name, aliases_json, description, status, first_seen_ref, last_seen_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(targetId, project.id, type, name, aliasesJson, description, status, firstSeenRef, lastSeenRef, nowValue, nowValue);
      }

      appendGraphLine(projectSlug, "entities.jsonl", {
        action: "upsert_entity",
        projectId: project.id,
        entityId: targetId,
        type,
        name
      });

      return db.prepare("SELECT * FROM entities WHERE id = ?").get(targetId) as DbEntity;
    });

    return mcpOk({ entity: toJsonValue(entity) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "KG_ENTITY_UPSERT_ERROR", err.message || "Unable to upsert entity", true);
  }
}

function upsertKgRelationship(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const sourceEntityId = getRequiredString(args, "sourceEntityId");
    const targetEntityId = getRequiredString(args, "targetEntityId");
    const relationshipType = getRequiredString(args, "relationshipType");
    const id = typeof args.id === "string" && args.id.trim().length > 0 ? args.id : crypto.randomUUID();
    const state = typeof args.state === "string" && args.state.trim().length > 0 ? args.state : null;
    const sourceRef = typeof args.sourceRef === "string" && args.sourceRef.trim().length > 0 ? args.sourceRef : null;
    const nowValue = now();

    const relationship = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);

      const sourceEntity = db
        .prepare("SELECT id FROM entities WHERE id = ? AND project_id = ?")
        .get(sourceEntityId, project.id) as { id: string } | undefined;
      if (!sourceEntity) {
        throw Object.assign(new Error(`Source entity not found: ${sourceEntityId}`), { code: "KG_ENTITY_NOT_FOUND" });
      }

      const targetEntity = db
        .prepare("SELECT id FROM entities WHERE id = ? AND project_id = ?")
        .get(targetEntityId, project.id) as { id: string } | undefined;
      if (!targetEntity) {
        throw Object.assign(new Error(`Target entity not found: ${targetEntityId}`), { code: "KG_ENTITY_NOT_FOUND" });
      }

      const existing = db.prepare(
        "SELECT id FROM relationships WHERE project_id = ? AND (id = ? OR (source_entity_id = ? AND target_entity_id = ? AND relationship_type = ?))",
      ).get(project.id, id, sourceEntityId, targetEntityId, relationshipType) as { id: string } | undefined;
      const targetId = existing?.id ?? id;

      const row = db.prepare("SELECT * FROM relationships WHERE id = ?").get(targetId) as DbRelationship | undefined;

      if (row) {
        db.prepare(
          `UPDATE relationships
           SET source_entity_id = ?, target_entity_id = ?, relationship_type = ?, state = ?, source_ref = ?, updated_at = ?
           WHERE id = ?`,
        ).run(sourceEntityId, targetEntityId, relationshipType, state, sourceRef, nowValue, targetId);
      } else {
        db.prepare(
          `INSERT INTO relationships(id, project_id, source_entity_id, target_entity_id, relationship_type, state, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(targetId, project.id, sourceEntityId, targetEntityId, relationshipType, state, sourceRef, nowValue, nowValue);
      }

      appendGraphLine(projectSlug, "relationships.jsonl", {
        action: "upsert_relationship",
        projectId: project.id,
        relationshipId: targetId,
        sourceEntityId,
        targetEntityId,
        relationshipType
      });

      return db.prepare("SELECT * FROM relationships WHERE id = ?").get(targetId) as DbRelationship;
    });

    return mcpOk({ relationship: toJsonValue(relationship) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "KG_RELATIONSHIP_UPSERT_ERROR", err.message || "Unable to upsert relationship", true);
  }
}

function exportKgJsonl(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const includeContent = args.includeContent !== false;

    const entries = withProjectDb(projectSlug, () => {
      const graphDir = projectGraphDir(projectSlug);
      if (!existsSync(graphDir)) {
        return { files: [], lines: [] as JsonObject[], count: 0 };
      }

      const files = readdirSync(graphDir).filter((name) => name.endsWith(".jsonl"));
      const lines: JsonObject[] = [];
      let count = 0;

      for (const fileName of files) {
        const fullPath = join(graphDir, fileName);
        const text = readFileSync(fullPath, "utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          count += 1;
          if (!includeContent) continue;
          try {
            const parsed = JSON.parse(trimmed);
            lines.push(isObject(parsed) ? toJsonValue(parsed) as JsonObject : { value: String(parsed), file: fileName });
          } catch {
            lines.push({ file: fileName, raw: trimmed });
          }
          lines[lines.length - 1]!.sourceFile = fileName;
        }
      }

      return { files, lines, count };
    });

    const count = entries.count;
    const data = includeContent
      ? { ...entries, totalLines: count, lines: entries.lines }
      : { files: entries.files, totalLines: count };

    return mcpOk({
      projectSlug,
      graphDir: projectGraphDir(projectSlug),
      data
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "KG_EXPORT_JSONL_ERROR", err.message || "Unable to export graph jsonl", true);
  }
}

function createGateTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const gateType = getRequiredString(args, "gateType");
    const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "project";
    const status = typeof args.status === "string" ? args.status.trim().toLowerCase() : "pending";
    if (status !== "pending") {
      throw Object.assign(new Error("new gates must be created with status 'pending'"), { code: "INVALID_GATE_STATUS" });
    }
    const required = args.required !== false;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0
        ? args.scopeId
        : project.id;
      const gateId = typeof args.id === "string" && args.id.trim().length > 0 ? args.id : crypto.randomUUID();
      const createdAt = now();

      db.prepare(
        "INSERT INTO gates(id, project_id, scope_type, scope_id, gate_type, status, required, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(gateId, project.id, scopeType, scopeId, gateType, status, required ? 1 : 0, createdAt);

      appendGraphLine(projectSlug, "gates.jsonl", {
        action: "create_gate",
        gateId,
        gateType,
        scopeType,
        scopeId,
        status
      });

      return db
        .prepare(
          "SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at FROM gates WHERE id = ?",
        )
        .get(gateId) as DbGate;
    });

    return mcpOk({ gate: toJsonValue(result) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "GATE_CREATE_ERROR", err.message || "Unable to create gate", true);
  }
}

function gateStatusTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "project";
    const gateType = typeof args.gateType === "string" && args.gateType.trim().length > 0 ? args.gateType : undefined;
    const scopeIdRaw = args.scopeId;

    const summary = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const scopeId = typeof scopeIdRaw === "string" && scopeIdRaw.trim().length > 0 ? scopeIdRaw : project.id;
      const rows = collectProjectScopeAndGateRows(db, project.id, scopeType, scopeId, gateType);
      const pending = rows.filter((row) => row.status === "pending");
      return {
        projectId: project.id,
        scopeType,
        scopeId,
        gates: rows.map((row) => toJsonValue(row)),
        pendingCount: pending.length
      };
    });

    return mcpOk(summary);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "GATE_STATUS_ERROR", err.message || "Unable to read gate status", true);
  }
}

function gateBlockersTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const stage = typeof args.stage === "string" && args.stage.trim().length > 0 ? args.stage : undefined;

    const blockers = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "project";
      const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0 ? args.scopeId : project.id;

      const gateSequence = scopeType === "chapter"
        ? [
          ...CHAPTER_PRE_PROSE_GATES,
          CHAPTER_VARIANT_CHOICE_GATE,
          ...CHAPTER_POST_PROSE_GATES,
          CHAPTER_FINAL_APPROVAL_GATE
        ]
        : [...PLANNING_STAGES];
      const targetIndex = stage ? gateSequence.indexOf(stage) : gateSequence.length;
      const relevant = gateSequence.slice(0, targetIndex === -1 ? gateSequence.length : targetIndex + 1);

      const rows = relevant.map((gateType) => {
        const gate = getLatestGateForType(db, project.id, scopeType, scopeId, gateType);
        return { gateType, gate };
      });

      const blocked = rows
        .filter((entry) => {
          if (!entry.gate) return true;
          if (entry.gate.required === 0) return false;
          return entry.gate.status !== "approved";
        })
        .map((entry) => ({
          gateType: entry.gateType,
          blocker: entry.gate ? {
            gateId: entry.gate.id,
            status: entry.gate.status,
            required: Boolean(entry.gate.required),
            createdAt: entry.gate.created_at
          } : { status: "missing" }
        }));

      return {
        projectId: project.id,
        scopeType,
        scopeId,
        blockers
      };
    });

    return mcpOk(blockers);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "GATE_BLOCKERS_ERROR", err.message || "Unable to compute gate blockers", true);
  }
}

function recordGateDecisionTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const decisionSource = typeof args.decisionSource === "string" ? args.decisionSource : "";
    const humanConfirmed = getOptionalBoolean(args, "humanConfirmed", false);
    if (decisionSource !== "omp_ui_confirmation" || !humanConfirmed) {
      throw Object.assign(new Error("Gate decisions must include decisionSource='omp_ui_confirmation' and humanConfirmed=true"), {
        code: "UNAUTHORIZED_GATE_DECISION"
      });
    }

    const decisionValue = args.decision;
    const humanDecisionValue = args.humanDecision;
    const normalizedDecision = decisionValue === undefined ? null : normalizeGateDecision(decisionValue);
    const normalizedHumanDecision = humanDecisionValue === undefined ? null : normalizeGateDecision(humanDecisionValue);
    const providedDecision = normalizedDecision ?? null;
    const providedHumanDecision = normalizedHumanDecision ?? null;

    if (providedDecision === null && providedHumanDecision === null) {
      throw Object.assign(new Error("Missing decision value. Expected approved, rejected, needs_revision, or blocked_by_audit."), {
        code: "INVALID_PARAMS"
      });
    }

    if (decisionValue !== undefined && providedDecision === null) {
      throw Object.assign(new Error("Invalid decision value. Expected approved, rejected, needs_revision, or blocked_by_audit."), {
        code: "INVALID_PARAMS"
      });
    }
    if (humanDecisionValue !== undefined && providedHumanDecision === null) {
      throw Object.assign(new Error("Invalid humanDecision value. Expected approved, rejected, needs_revision, or blocked_by_audit."), {
        code: "INVALID_PARAMS"
      });
    }

    const gateStatus = providedDecision ?? providedHumanDecision;
    if (gateStatus === null) {
      throw Object.assign(new Error("Missing decision value. Expected approved, rejected, needs_revision, or blocked_by_audit."), {
        code: "INVALID_PARAMS"
      });
    }
    requireGateDecisionNonce(args, projectSlug, gateStatus);
    const humanDecision = providedHumanDecision ?? gateStatus;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const gateId = typeof args.gateId === "string" && args.gateId.trim().length > 0
        ? args.gateId
        : (() => {
          const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "project";
          const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0 ? args.scopeId : project.id;
          const targetGateType = getRequiredString(args, "gateType");
          const gate = getLatestGateForType(db, project.id, scopeType, scopeId, targetGateType);
          if (!gate) throw Object.assign(new Error(`Gate not found: ${targetGateType}`), { code: "GATE_NOT_FOUND" });
          return gate.id;
        })();

      const gate = db.prepare("SELECT * FROM gates WHERE id = ?").get(gateId) as DbGate | undefined;
      if (!gate) {
        throw Object.assign(new Error(`Gate not found: ${gateId}`), { code: "GATE_NOT_FOUND" });
      }

      const resolvedAt = now();
      db.prepare("UPDATE gates SET status = ?, resolved_at = ? WHERE id = ?").run(gateStatus, resolvedAt, gateId);

      const decisionId = typeof args.decisionId === "string" && args.decisionId.trim().length > 0
        ? args.decisionId
        : crypto.randomUUID();

      const notes = typeof args.notes === "string" && args.notes.trim().length > 0 ? args.notes : null;
      const decidedBy = typeof args.decidedBy === "string" && args.decidedBy.trim().length > 0 ? args.decidedBy : null;
      const decisionMetadata = isObject(args.decisionMetadata)
        ? JSON.stringify(toJsonValue(args.decisionMetadata))
        : typeof args.decisionMetadata === "string"
          ? args.decisionMetadata
          : null;

      db.prepare(
        "INSERT INTO gate_decisions(id, gate_id, project_id, decision, human_decision, human_confirmed, decision_source, notes, decided_by, decision_metadata_json, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        decisionId,
        gate.id,
        project.id,
        gateStatus,
        humanDecision,
        1,
        decisionSource,
        notes,
        decidedBy,
        decisionMetadata,
        resolvedAt,
      );

      const decisionRow = db
        .prepare(
          "SELECT id, gate_id, project_id, decision, human_decision, human_confirmed, decision_source, notes, decided_by, decision_metadata_json, decided_at FROM gate_decisions WHERE id = ?",
        )
        .get(decisionId) as DbGateDecision;

      const currentStage = gate.gate_type;
      const nextGate = isKnownPlanningStage(currentStage)
        ? ensureNextStageGateIfPossible(db, gate.project_id, gate.scope_type, gate.scope_id, currentStage, gateStatus)
        : null;

      return { gate, decision: decisionRow, nextGate };
    });

    return mcpOk({
      gate: toJsonValue(result.gate) as JsonObject,
      decision: toJsonValue(result.decision) as JsonObject,
      nextGate: result.nextGate ? (toJsonValue(result.nextGate) as JsonObject) : null
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "GATE_DECISION_ERROR", err.message || "Unable to record gate decision", true);
  }
}

function createPlanningArtifact(
  project: DbProject,
  scopeType: string,
  scopeId: string,
  stage: PlanningStage,
  db: Database,
  args: JsonObject
): DbPlanningArtifact {
  enforcePriorGateApproved(db, project.id, scopeType, scopeId, stage);

  const gate = ensurePendingGate(db, project.id, scopeType, scopeId, stage);
  const nowValue = now();

  const artifactType = stage;
  const artifactId = typeof args.artifactId === "string" && args.artifactId.trim().length > 0
    ? args.artifactId
    : crypto.randomUUID();
  const artifactKey = typeof args.artifactKey === "string" && args.artifactKey.trim().length > 0 ? args.artifactKey : null;
  const title = typeof args.title === "string" && args.title.trim().length > 0 ? args.title : null;

  const payloadObj = { ...args } as JsonObject;
  delete payloadObj.projectSlug;
  delete payloadObj.stage;
  delete payloadObj.scopeType;
  delete payloadObj.scopeId;
  delete payloadObj.artifactId;
  delete payloadObj.artifactKey;

  const existing = db
    .prepare("SELECT id FROM planning_artifacts WHERE id = ? AND project_id = ?")
    .get(artifactId, project.id) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE planning_artifacts
       SET scope_type = ?, scope_id = ?, artifact_type = ?, artifact_key = ?, title = ?, payload_json = ?, gate_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      scopeType,
      scopeId,
      artifactType,
      artifactKey,
      title,
      JSON.stringify(toJsonValue(payloadObj)),
      gate.id,
      nowValue,
      artifactId,
    );
  } else {
    db.prepare(
      `INSERT INTO planning_artifacts(id, project_id, scope_type, scope_id, artifact_type, artifact_key, title, payload_json, gate_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      project.id,
      scopeType,
      scopeId,
      artifactType,
      artifactKey,
      title,
      JSON.stringify(toJsonValue(payloadObj)),
      gate.id,
      nowValue,
      nowValue,
    );
  }

  ensureNextStageGateIfPossible(db, project.id, scopeType, scopeId, stage, gate.status);

  const artifact = db.prepare("SELECT * FROM planning_artifacts WHERE id = ?").get(artifactId) as DbPlanningArtifact;

  appendGraphLine(project.slug, "planning_artifacts.jsonl", {
    action: "record_planning_artifact",
    artifactId,
    stage,
    artifactType,
    gateId: gate.id,
    projectId: project.id,
    scopeType,
    scopeId
  });

  return artifact;
}

function recordPlanningTool(args: JsonObject, stage: PlanningStage): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const { scopeType, scopeId } = normalizeScopeId(project, args, "project");
      const artifact = createPlanningArtifact(project, scopeType, scopeId, stage, db, args);
      const gate = getLatestGateForType(db, project.id, scopeType, scopeId, stage);
      return { artifact, gate };
    });

    return mcpOk(
      {
        artifact: toJsonValue(result.artifact) as JsonObject,
        stage
      },
      [],
      result.gate ? (toJsonValue(result.gate) as JsonObject) : null
    );
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "PLANNING_RECORD_ERROR", err.message || "Unable to record planning artifact", true);
  }
}

function upsertEventBase(args: JsonObject): { eventId: string; event: DbEvent } {
  const projectSlug = validateSlug(args.projectSlug);
  const eventId = typeof args.eventId === "string" && args.eventId.trim().length > 0 ? args.eventId : crypto.randomUUID();
  const title = getRequiredString(args, "title");
  const summary = typeof args.summary === "string" && args.summary.trim().length > 0 ? args.summary : null;
  const eventType = typeof args.eventType === "string" && args.eventType.trim().length > 0 ? args.eventType : null;
  const timeLabel = typeof args.timeLabel === "string" && args.timeLabel.trim().length > 0 ? args.timeLabel : null;
  const chronologyRaw = typeof args.chronologyIndex === "number" && Number.isFinite(args.chronologyIndex) ? args.chronologyIndex : null;
  const sourceRef = typeof args.sourceRef === "string" && args.sourceRef.trim().length > 0 ? args.sourceRef : null;

  const event = withProjectDb(projectSlug, (db) => {
    const project = getProjectRowOrError(db, projectSlug);
    enforcePriorGateApproved(db, project.id, "project", project.id, "knowledge_graph");
    const gate = ensurePendingGate(db, project.id, "project", project.id, "knowledge_graph");
    ensureNextStageGateIfPossible(db, project.id, "project", project.id, "knowledge_graph", gate.status);

    const nowValue = now();
    const existing = db.prepare("SELECT id FROM events WHERE id = ?").get(eventId) as { id: string } | undefined;
    if (existing) {
      db.prepare(
        `UPDATE events
         SET title = ?, summary = ?, event_type = ?, time_label = ?, chronology_index = ?, source_ref = ?, updated_at = ?
         WHERE id = ?`,
      ).run(title, summary, eventType, timeLabel, chronologyRaw, sourceRef, nowValue, eventId);
    } else {
      db.prepare(
        `INSERT INTO events(id, project_id, title, summary, event_type, time_label, chronology_index, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventId, project.id, title, summary, eventType, timeLabel, chronologyRaw, sourceRef, nowValue, nowValue);
    }

    appendGraphLine(projectSlug, "events.jsonl", {
      action: "upsert_event",
      projectId: project.id,
      eventId,
      title,
      eventType,
      timeLabel,
      chronology: chronologyRaw,
      gateId: gate.id
    });

    const row = db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as DbEvent;
    return row;
  });

  return { eventId, event };
}

function eventUpsertTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const upserted = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "knowledge_graph");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "knowledge_graph");
      ensureNextStageGateIfPossible(db, project.id, "project", project.id, "knowledge_graph", gate.status);

      const result = upsertEventToolInner(db, project, gate, args);
      return { ...result, gate };
    });

    return mcpOk({
      event: toJsonValue(upserted.event) as JsonObject,
      eventId: upserted.eventId
    }, [], toJsonValue(upserted.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "KG_EVENT_UPSERT_ERROR", err.message || "Unable to upsert event", true);
  }
}

function upsertEventToolInner(db: Database, project: DbProject, gate: DbGate, args: JsonObject): { eventId: string; event: DbEvent } {
  const eventId = typeof args.eventId === "string" && args.eventId.trim().length > 0 ? args.eventId : crypto.randomUUID();
  const title = getRequiredString(args, "title");
  const summary = typeof args.summary === "string" && args.summary.trim().length > 0 ? args.summary : null;
  const eventType = typeof args.eventType === "string" && args.eventType.trim().length > 0 ? args.eventType : null;
  const timeLabel = typeof args.timeLabel === "string" && args.timeLabel.trim().length > 0 ? args.timeLabel : null;
  const chronologyRaw = typeof args.chronologyIndex === "number" && Number.isFinite(args.chronologyIndex) ? args.chronologyIndex : null;
  const sourceRef = typeof args.sourceRef === "string" && args.sourceRef.trim().length > 0 ? args.sourceRef : null;
  const nowValue = now();

  const existing = db.prepare("SELECT id FROM events WHERE id = ? AND project_id = ?").get(eventId, project.id) as { id: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE events
       SET title = ?, summary = ?, event_type = ?, time_label = ?, chronology_index = ?, source_ref = ?, updated_at = ?
       WHERE id = ?`,
    ).run(title, summary, eventType, timeLabel, chronologyRaw, sourceRef, nowValue, eventId);
  } else {
    db.prepare(
      `INSERT INTO events(id, project_id, title, summary, event_type, time_label, chronology_index, source_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      project.id,
      title,
      summary,
      eventType,
      timeLabel,
      chronologyRaw,
      sourceRef,
      nowValue,
      nowValue,
    );
  }

  appendGraphLine(project.slug, "events.jsonl", {
    action: "upsert_event",
    projectId: project.id,
    gateId: gate.id,
    eventId,
    title
  });

  return {
    eventId,
    event: db.prepare("SELECT * FROM events WHERE id = ?").get(eventId) as DbEvent
  };
}

function eventGraphCreateTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "knowledge_graph");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "knowledge_graph");
      ensureNextStageGateIfPossible(db, project.id, "project", project.id, "knowledge_graph", gate.status);

      const artifact = createPlanningArtifact(project, "project", project.id, "knowledge_graph", db, args);
      return { artifact, gate };
    });

    return mcpOk({ artifact: toJsonValue(result.artifact) as JsonObject }, [], toJsonValue(result.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "EVENT_GRAPH_CREATE_ERROR", err.message || "Unable to create event graph marker", true);
  }
}

function eventGraphNodeTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "knowledge_graph");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "knowledge_graph");
      ensureNextStageGateIfPossible(db, project.id, "project", project.id, "knowledge_graph", gate.status);
      return upsertEventToolInner(db, project, gate, args);
    });

    return mcpOk({ event: toJsonValue(result.event) as JsonObject, eventId: result.eventId }, [], null);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "EVENT_GRAPH_NODE_UPSERT_ERROR", err.message || "Unable to upsert event graph node", true);
  }
}

function eventGraphEdgeTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "knowledge_graph");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "knowledge_graph");
      ensureNextStageGateIfPossible(db, project.id, "project", project.id, "knowledge_graph", gate.status);

      const fromEventId = getRequiredString(args, "fromEventId");
      const toEventId = getRequiredString(args, "toEventId");
      const edgeType = typeof args.edgeType === "string" && args.edgeType.trim().length > 0 ? args.edgeType : "causes";
      const rationale = typeof args.rationale === "string" && args.rationale.trim().length > 0 ? args.rationale : null;
      const id = typeof args.id === "string" && args.id.trim().length > 0 ? args.id : crypto.randomUUID();

      const from = db.prepare("SELECT id FROM events WHERE id = ? AND project_id = ?").get(fromEventId, project.id) as
        | { id: string }
        | undefined;
      if (!from) {
        throw Object.assign(new Error(`From event not found: ${fromEventId}`), { code: "EVENT_NOT_FOUND" });
      }

      const to = db.prepare("SELECT id FROM events WHERE id = ? AND project_id = ?").get(toEventId, project.id) as
        | { id: string }
        | undefined;
      if (!to) {
        throw Object.assign(new Error(`To event not found: ${toEventId}`), { code: "EVENT_NOT_FOUND" });
      }

      const existing = db
        .prepare(
          "SELECT id FROM event_edges WHERE project_id = ? AND (id = ? OR (from_event_id = ? AND to_event_id = ? AND edge_type = ?))",
        )
        .get(project.id, id, fromEventId, toEventId, edgeType) as { id: string } | undefined;

      const targetId = existing?.id ?? id;
      if (existing) {
        db.prepare(
          "UPDATE event_edges SET from_event_id = ?, to_event_id = ?, edge_type = ?, rationale = ? WHERE id = ?",
        ).run(fromEventId, toEventId, edgeType, rationale, targetId);
      } else {
        db.prepare(
          "INSERT INTO event_edges(id, project_id, from_event_id, to_event_id, edge_type, rationale) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(targetId, project.id, fromEventId, toEventId, edgeType, rationale);
      }

      appendGraphLine(project.slug, "event_edges.jsonl", {
        action: "upsert_event_edge",
        projectId: project.id,
        edgeId: targetId,
        fromEventId,
        toEventId,
        edgeType,
        gateId: gate.id
      });

      const edge = db.prepare("SELECT * FROM event_edges WHERE id = ?").get(targetId) as DbEventEdge;
      return edge;
    });

    return mcpOk({ edge: toJsonValue(result) as JsonObject }, [], null);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "EVENT_GRAPH_EDGE_UPSERT_ERROR", err.message || "Unable to upsert event graph edge", true);
  }
}

function escapeMermaidLabel(value: unknown): string {
  const text = String(value ?? "");
  return text.replace(/"/g, "\\\"").replace(/\n/g, "<br/>");
}

function validateCausalityTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "knowledge_graph");

      const events = db
        .prepare("SELECT id, chronology_index, title FROM events WHERE project_id = ? ORDER BY id ASC")
        .all(project.id) as Array<{ id: string; chronology_index: number | null; title: string }>;
      const edges = db
        .prepare("SELECT from_event_id, to_event_id FROM event_edges WHERE project_id = ?")
        .all(project.id) as Array<{ from_event_id: string; to_event_id: string }>;

      const eventSet = new Set<string>(events.map((event) => event.id));
      const missingTargets = edges
        .filter((edge) => !eventSet.has(edge.from_event_id) || !eventSet.has(edge.to_event_id))
        .map((edge) => ({ from: edge.from_event_id, to: edge.to_event_id }));

      const adjacency = new Map<string, string[]>();
      for (const event of events) {
        adjacency.set(event.id, []);
      }
      for (const edge of edges) {
        const list = adjacency.get(edge.from_event_id);
        if (list) list.push(edge.to_event_id);
      }

      const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited,1visiting,2done
      const path: string[] = [];
      const cycles: Array<string[]> = [];

      const dfs = (node: string): void => {
        const status = state.get(node) ?? 0;
        if (status === 1) {
          const start = path.indexOf(node);
          if (start >= 0) cycles.push(path.slice(start).concat(node));
          return;
        }
        if (status === 2) return;
        state.set(node, 1);
        path.push(node);
        const neighbors = adjacency.get(node) ?? [];
        for (const next of neighbors) {
          dfs(next);
        }
        path.pop();
        state.set(node, 2);
      };

      for (const event of events) {
        dfs(event.id);
      }

      const valid = cycles.length === 0 && missingTargets.length === 0;
      const eventCount = events.length;
      const edgeCount = edges.length;
      return {
        projectId: project.id,
        eventCount,
        edgeCount,
        valid,
        cycles,
        missingTargets
      };
    });

    return mcpOk(payload);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "EVENT_GRAPH_CAUSALITY_ERROR", err.message || "Unable to validate causality", true);
  }
}

function eventGraphExportMermaidTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const fileName = typeof args.fileName === "string" && args.fileName.trim().length > 0 ? args.fileName : "event-graph";

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "mermaid_export");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "mermaid_export");

      const events = db
        .prepare("SELECT id, title, summary, chronology_index FROM events WHERE project_id = ? ORDER BY COALESCE(chronology_index, 999999), title")
        .all(project.id) as DbEvent[];
      const edges = db
        .prepare("SELECT from_event_id, to_event_id, edge_type, rationale FROM event_edges WHERE project_id = ?")
        .all(project.id) as Array<DbEventEdge & { rationale: string | null }>; // sqlite driver shape

      const nodeById = new Map<string, string>();
      const lines: string[] = ["flowchart LR"];
      events.forEach((event, index) => {
        const nodeId = `E${index + 1}`;
        nodeById.set(event.id, nodeId);
        const summary = event.summary ? `\\n${escapeMermaidLabel(event.summary)}` : "";
        lines.push(`${nodeId}["${escapeMermaidLabel(event.title)}${summary}"]`);
      });

      for (const edge of edges) {
        const from = nodeById.get(edge.from_event_id);
        const to = nodeById.get(edge.to_event_id);
        if (!from || !to) {
          continue;
        }
        const label = edge.rationale ? `|${escapeMermaidLabel(edge.rationale)}|` : "";
        lines.push(`${from} -->${label} ${to}`);
      }

      const mermaidText = `${lines.join("\n")}\n`;
      const path = writeMermaidDiagram(projectSlug, `${formatPathSafe(fileName)}.mmd`, mermaidText);

      const exportId = crypto.randomUUID();
      const createdAt = now();
      db.prepare(
        "INSERT INTO mermaid_exports(id, project_id, scope_type, scope_id, diagram_kind, artifact_type, artifact_id, file_path, mermaid_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        exportId,
        project.id,
        "project",
        project.id,
        "event_graph",
        "event_graph",
        null,
        path,
        mermaidText,
        createdAt,
      );

      const record = db.prepare("SELECT * FROM mermaid_exports WHERE id = ?").get(exportId) as DbMermaidExport;
      return { path, mermaidText, gate, record };
    });

    return mcpOk({
      filePath: payload.path,
      mermaid: payload.mermaidText,
      export: toJsonValue(payload.record) as JsonObject
    }, [], toJsonValue(payload.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "EVENT_GRAPH_EXPORT_ERROR", err.message || "Unable to export event graph", true);
  }
}

function kgMermaidExportTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const fileName = typeof args.fileName === "string" && args.fileName.trim().length > 0 ? args.fileName : "knowledge-graph";

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "mermaid_export");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "mermaid_export");

      const entities = db.prepare("SELECT id, type, name, status FROM entities WHERE project_id = ?").all(project.id) as Array<
        DbEntity
      >;
      const edges = db
        .prepare(
          "SELECT source_entity_id, target_entity_id, relationship_type, source_ref FROM relationships WHERE project_id = ?",
        )
        .all(project.id) as Array<{ source_entity_id: string; target_entity_id: string; relationship_type: string; source_ref: string | null }>;

      const idToNode = new Map<string, string>();
      const lines: string[] = ["graph LR"];
      entities.forEach((entity, index) => {
        const node = `N${index + 1}`;
        idToNode.set(entity.id, node);
        const extra = entity.status ? `\\nstatus: ${escapeMermaidLabel(entity.status)}` : "";
        lines.push(`${node}["${escapeMermaidLabel(entity.type)}: ${escapeMermaidLabel(entity.name)}${extra}"]`);
      });

      for (const edge of edges) {
        const from = idToNode.get(edge.source_entity_id);
        const to = idToNode.get(edge.target_entity_id);
        if (!from || !to) continue;
        const label = edge.relationship_type ? `|${escapeMermaidLabel(edge.relationship_type)}|` : "";
        lines.push(`${from} -->${label} ${to}`);
      }

      const mermaidText = `${lines.join("\n")}\n`;
      const path = writeMermaidDiagram(projectSlug, `${formatPathSafe(fileName)}.mmd`, mermaidText);

      const exportId = crypto.randomUUID();
      const nowValue = now();
      db.prepare(
        "INSERT INTO mermaid_exports(id, project_id, scope_type, scope_id, diagram_kind, artifact_type, artifact_id, file_path, mermaid_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        exportId,
        project.id,
        "project",
        project.id,
        "knowledge_graph",
        "knowledge_graph",
        null,
        path,
        mermaidText,
        nowValue,
      );

      const record = db.prepare("SELECT * FROM mermaid_exports WHERE id = ?").get(exportId) as DbMermaidExport;
      return { path, mermaidText, gate, record };
    });

    return mcpOk({
      filePath: payload.path,
      mermaid: payload.mermaidText,
      export: toJsonValue(payload.record) as JsonObject
    }, [], toJsonValue(payload.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "KG_MERMAID_EXPORT_ERROR", err.message || "Unable to export KG mermaid", true);
  }
}

function arcCreateTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const title = getRequiredString(args, "title");
    const scope = validateSerialScopeValue(getRequiredString(args, "scope"), "scope");
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status : "draft";
    const ownerId = typeof args.ownerId === "string" && args.ownerId.trim().length > 0 ? args.ownerId : null;

    const arc = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const nowValue = now();
      const id = typeof args.arcId === "string" && args.arcId.trim().length > 0 ? args.arcId : crypto.randomUUID();
      db.prepare(
        "INSERT INTO arcs(id, project_id, scope, owner_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(id, project.id, scope, ownerId, title, status, nowValue, nowValue);
      appendGraphLine(project.slug, "arcs.jsonl", {
        action: "create_arc",
        arcId: id,
        title,
        scope
      });
      return db.prepare("SELECT * FROM arcs WHERE id = ?").get(id) as DbArc;
    });

    return mcpOk({ arc: toJsonValue(arc) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "ARC_CREATE_ERROR", err.message || "Unable to create arc", true);
  }
}

function arcGetTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const arcId = getRequiredString(args, "arcId");

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const arc = db.prepare("SELECT * FROM arcs WHERE id = ? AND project_id = ?").get(arcId, project.id) as DbArc | undefined;
      if (!arc) throw Object.assign(new Error(`Arc not found: ${arcId}`), { code: "ARC_NOT_FOUND" });
      const beats = db.prepare("SELECT * FROM seven_point_beats WHERE arc_id = ? ORDER BY beat_order ASC").all(arc.id) as DbBeat[];
      return { arc, beats };
    });

    return mcpOk({
      arc: toJsonValue(payload.arc) as JsonObject,
      beats: payload.beats.map((beat) => toJsonValue(beat) as JsonObject)
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "ARC_GET_ERROR", err.message || "Unable to get arc", true);
  }
}

function arcUpdateTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const arcId = getRequiredString(args, "arcId");
    const project = withProjectDb(projectSlug, (db) => getProjectRowOrError(db, projectSlug));
    const nowValue = now();
    const title = typeof args.title === "string" && args.title.trim().length > 0 ? args.title : undefined;
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status : undefined;
    const ownerId = typeof args.ownerId === "string" ? args.ownerId : undefined;
    const scope = typeof args.scope === "string" && args.scope.trim().length > 0
      ? validateSerialScopeValue(args.scope, "scope")
      : undefined;

    if (title === undefined && status === undefined && ownerId === undefined && scope === undefined) {
      return mcpError("INVALID_PARAMS", "No updatable fields supplied", true);
    }

    const result = withProjectDb(projectSlug, (db) => {
      const row = db.prepare("SELECT * FROM arcs WHERE id = ? AND project_id = ?").get(arcId, project.id) as DbArc | undefined;
      if (!row) throw Object.assign(new Error(`Arc not found: ${arcId}`), { code: "ARC_NOT_FOUND" });

      const setParts: string[] = [];
      const params: Array<string | null> = [];
      if (title !== undefined) {
        setParts.push("title = ?");
        params.push(title);
      }
      if (status !== undefined) {
        setParts.push("status = ?");
        params.push(status);
      }
      if (ownerId !== undefined) {
        setParts.push("owner_id = ?");
        params.push(ownerId || null);
      }
      if (scope !== undefined) {
        setParts.push("scope = ?");
        params.push(scope);
      }
      setParts.push("updated_at = ?");
      params.push(nowValue);
      params.push(arcId);

      db.prepare(`UPDATE arcs SET ${setParts.join(", ")} WHERE id = ?`).run(...params);
      appendGraphLine(project.slug, "arcs.jsonl", {
        action: "update_arc",
        arcId,
        title,
        status,
        ownerId,
        scope
      });

      return db.prepare("SELECT * FROM arcs WHERE id = ?").get(arcId) as DbArc;
    });

    return mcpOk({ arc: toJsonValue(result) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "ARC_UPDATE_ERROR", err.message || "Unable to update arc", true);
  }
}

function arcValidateSevenPointTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const arcId = getRequiredString(args, "arcId");

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const arc = db.prepare("SELECT id FROM arcs WHERE id = ? AND project_id = ?").get(arcId, project.id) as { id: string } | undefined;
      if (!arc) throw Object.assign(new Error(`Arc not found: ${arcId}`), { code: "ARC_NOT_FOUND" });

      const beats = db.prepare("SELECT beat_name, beat_order FROM seven_point_beats WHERE arc_id = ? ORDER BY beat_order ASC").all(arcId) as
        Array<{ beat_name: string; beat_order: number }>;
      const present = new Set<string>(beats.map((beat) => beat.beat_name.trim().toLowerCase()));
      const required = REQUIRED_BEAT_NAMES.map((name) => name.toLowerCase());
      const missing = required.filter((name) => !present.has(name));

      return {
        arcId,
        required,
        presentBeats: beats.map((beat) => beat.beat_name),
        missing,
        valid: missing.length === 0,
        beatCount: beats.length
      };
    });

    return mcpOk(result);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "ARC_VALIDATE_ERROR", err.message || "Unable to validate arc", true);
  }
}

function arcListByScopeTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const scope = validateSerialScopeValue(getRequiredString(args, "scope"), "scope");
    const ownerId = typeof args.ownerId === "string" && args.ownerId.trim().length > 0 ? args.ownerId : undefined;

    const rows = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      if (ownerId) {
        return db
          .prepare("SELECT * FROM arcs WHERE project_id = ? AND scope = ? AND owner_id = ? ORDER BY created_at ASC")
          .all(project.id, scope, ownerId) as DbArc[];
      }
      return db.prepare("SELECT * FROM arcs WHERE project_id = ? AND scope = ? ORDER BY created_at ASC").all(project.id, scope) as DbArc[];
    });

    return mcpOk({
      scope,
      count: rows.length,
      arcs: rows.map((arc) => toJsonValue(arc) as JsonObject)
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "ARC_LIST_ERROR", err.message || "Unable to list arcs", true);
  }
}

function arcExportMermaidTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const arcId = getRequiredString(args, "arcId");

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "mermaid_export");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "mermaid_export");

      const arc = db.prepare("SELECT * FROM arcs WHERE id = ? AND project_id = ?").get(arcId, project.id) as DbArc | undefined;
      if (!arc) throw Object.assign(new Error(`Arc not found: ${arcId}`), { code: "ARC_NOT_FOUND" });
      const beats = db.prepare("SELECT beat_name, beat_order, summary FROM seven_point_beats WHERE arc_id = ? ORDER BY beat_order ASC").all(arc.id) as Array<
        DbBeat
      >;

      const lines: string[] = ["flowchart TD"];
      if (beats.length === 0) {
        lines.push(`A(["${escapeMermaidLabel(arc.title)}"])`);
      } else {
        const nodes = beats.map((beat, index) => {
          const id = `B${index + 1}`;
          const summary = beat.summary ? `\\n${escapeMermaidLabel(beat.summary)}` : "";
          lines.push(`${id}["${escapeMermaidLabel(beat.beat_name)}${summary}"]`);
          return id;
        });
        for (let i = 0; i < nodes.length - 1; i += 1) {
          lines.push(`${nodes[i]} --> ${nodes[i + 1]}`);
        }
      }

      const mermaidText = `${lines.join("\n")}\n`;
      const file = writeMermaidDiagram(projectSlug, `arc-${formatPathSafe(arc.id)}.mmd`, mermaidText);
      const exportId = crypto.randomUUID();
      const nowValue = now();
      db.prepare(
        "INSERT INTO mermaid_exports(id, project_id, scope_type, scope_id, diagram_kind, artifact_type, artifact_id, file_path, mermaid_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        exportId,
        project.id,
        "project",
        project.id,
        "arc",
        "arc",
        arc.id,
        file,
        mermaidText,
        nowValue,
      );

      const record = db.prepare("SELECT * FROM mermaid_exports WHERE id = ?").get(exportId) as DbMermaidExport;

      return { file, mermaidText, gate, record };
    });

    return mcpOk(
      {
        filePath: result.file,
        mermaid: result.mermaidText,
        export: toJsonValue(result.record) as JsonObject
      },
      [],
      toJsonValue(result.gate) as JsonObject
    );
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "ARC_EXPORT_ERROR", err.message || "Unable to export arc mermaid", true);
  }
}

function beatmapRecordTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const arcId = getRequiredString(args, "arcId");
    const beats = Array.isArray(args.beats) ? args.beats : [];
    if (!Array.isArray(beats) || beats.length === 0) {
      return mcpError("INVALID_PARAMS", "beats must be a non-empty array", true);
    }

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "beats");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "beats");
      const arc = db.prepare("SELECT id FROM arcs WHERE id = ? AND project_id = ?").get(arcId, project.id) as { id: string } | undefined;
      if (!arc) {
        throw Object.assign(new Error(`Arc not found: ${arcId}`), { code: "ARC_NOT_FOUND" });
      }

      db.prepare("DELETE FROM seven_point_beats WHERE arc_id = ?").run(arcId);
      for (let index = 0; index < beats.length; index += 1) {
        const item = beats[index];
        if (!isObject(item)) continue;
        const beatName = getOptionalString(item, "beatName") || getOptionalString(item, "name") || `Beat ${index + 1}`;
        const summary = getRequiredString(item, "summary");
        const beatOrderRaw = isObject(item) && typeof item.order === "number" && Number.isFinite(item.order) ? item.order : index + 1;
        const evidenceRef = isObject(item) && typeof item.evidenceRef === "string" ? item.evidenceRef : null;
        const approvedRaw = isObject(item) && typeof item.approved === "boolean" ? item.approved : false;

        const beatId = typeof item.id === "string" && item.id.trim().length > 0 ? item.id : crypto.randomUUID();
        const nowValue = now();
        db.prepare(
          "INSERT INTO seven_point_beats(id, arc_id, beat_name, beat_order, summary, evidence_ref, approved) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
          beatId,
          arcId,
          beatName,
          beatOrderRaw,
          summary,
          evidenceRef,
          approvedRaw ? 1 : 0,
        );
      }

      const artifact = createPlanningArtifact(project, "project", project.id, "beats", db, args);
      return {
        gate,
        artifact
      };
    });

    return mcpOk({
      artifact: toJsonValue(payload.artifact) as JsonObject,
      arcId
    }, [], toJsonValue(payload.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "BEATMAP_RECORD_ERROR", err.message || "Unable to record beatmap", true);
  }
}

function upsertChapterOutlineRecord(
  db: Database,
  project: DbProject,
  chapterId: string,
  chapterNumber: number,
  containerType: string,
  containerId: string,
  title: string | null,
  status: string,
  outlineMarkdown: string | null,
  outlinePathArg: string | null,
  outlineArtifactId: string | null = null,
  skipWorkflow = false
): { chapter: DbChapter; artifactId: string } {
  if (!skipWorkflow) {
    ensureProjectWorkflowComplete(db, project);
  }

  const nowValue = now();
  const chapterPathBase = join("chapters", chapterId, "outline.md");
  const markdownPath = outlineMarkdown !== null
    ? writeProjectFile(project.slug, chapterPathBase, outlineMarkdown)
    : outlinePathArg
      ? resolveChapterFilePath(project.slug, outlinePathArg)
      : null;

  const existing = db
    .prepare("SELECT id FROM chapters WHERE id = ? AND project_id = ?")
    .get(chapterId, project.id) as { id: string } | undefined;

  if (existing) {
    db.prepare(
      `UPDATE chapters
       SET container_type = ?, container_id = ?, chapter_number = ?, title = ?, status = ?, markdown_path = ?, updated_at = ?
       WHERE id = ?`,
    ).run(containerType, containerId, chapterNumber, title, status, markdownPath, nowValue, chapterId);
  } else {
    db.prepare(
      `INSERT INTO chapters(id, project_id, container_type, container_id, chapter_number, title, status, markdown_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(chapterId, project.id, containerType, containerId, chapterNumber, title, status, markdownPath, nowValue, nowValue);
  }

  for (const gateType of CHAPTER_PRE_PROSE_GATES) {
    ensurePendingGate(db, project.id, "chapter", chapterId, gateType);
  }

  const chapter = db
    .prepare(
      "SELECT id, project_id, container_type, container_id, chapter_number, title, status, markdown_path, selected_variant_id, selected_draft_revision_id, approved_by_gate_id, approved_at, final_markdown_path, completion_notes, completed_at, created_at, updated_at FROM chapters WHERE id = ?",
    )
    .get(chapterId) as DbChapter;

  const artifactId = outlineArtifactId && outlineArtifactId.trim().length > 0 ? outlineArtifactId : crypto.randomUUID();
  const payload = {
    chapterId,
    status,
    containerType,
    containerId,
    chapterNumber,
    title,
    hasOutlineMarkdown: outlineMarkdown !== null,
    outlinePathArg,
  };
  const existingArtifact = db.prepare("SELECT id FROM planning_artifacts WHERE id = ? AND project_id = ?").get(artifactId, project.id) as
    | { id: string }
    | undefined;

  if (existingArtifact) {
    db.prepare(
      `UPDATE planning_artifacts
       SET scope_type = ?, scope_id = ?, artifact_type = ?, artifact_key = ?, title = ?, payload_json = ?, gate_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      "chapter",
      chapter.id,
      "chapter_outline",
      "chapter_outline",
      "chapter_outline",
      JSON.stringify(toJsonValue(payload)),
      null,
      nowValue,
      artifactId,
    );
  } else {
    db.prepare(
      `INSERT INTO planning_artifacts(id, project_id, scope_type, scope_id, artifact_type, artifact_key, title, payload_json, gate_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifactId,
      project.id,
      "chapter",
      chapter.id,
      "chapter_outline",
      "chapter_outline",
      "chapter_outline",
      JSON.stringify(toJsonValue(payload)),
      null,
      nowValue,
      nowValue,
    );
  }

  return { chapter, artifactId };
}

function chapterOutlineRecordTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = typeof args.chapterId === "string" && args.chapterId.trim().length > 0 ? args.chapterId : crypto.randomUUID();
    const chapterNumberRaw = typeof args.chapterNumber === "number" && Number.isInteger(args.chapterNumber) && args.chapterNumber > 0
      ? args.chapterNumber
      : null;
    const chapterNumber = chapterNumberRaw ?? 1;
    const containerType = typeof args.containerType === "string" && args.containerType.trim().length > 0 ? args.containerType : "book";
    const containerId = typeof args.containerId === "string" && args.containerId.trim().length > 0 ? args.containerId : "";
    const title = typeof args.title === "string" && args.title.trim().length > 0 ? args.title : null;
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status : "outlined";
    const outlineMarkdown = typeof args.outlineMarkdown === "string" ? args.outlineMarkdown : null;
    const outlinePathArg = typeof args.outlinePath === "string" ? args.outlinePath : null;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const outlineArtifactId = typeof args.outlineArtifactId === "string" && args.outlineArtifactId.trim().length > 0
        ? args.outlineArtifactId
        : null;
      const { chapter, artifactId } = upsertChapterOutlineRecord(
        db,
        project,
        chapterId,
        chapterNumber,
        containerType,
        containerId,
        title,
        status,
        outlineMarkdown,
        outlinePathArg,
        outlineArtifactId,
        false,
      );
      appendGraphLine(project.slug, "chapters.jsonl", {
        action: "chapter_outline_record",
        chapterId,
        projectSlug,
        status
      });
      return { chapter, artifactId };
    });

    return mcpOk({
      chapter: toJsonValue(result.chapter) as JsonObject,
      artifactId: result.artifactId
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_OUTLINE_ERROR", err.message || "Unable to record chapter outline", true);
  }
}

function serialSeasonPlanTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const seasonId = getOptionalString(args, "seasonId");
    const seasonNumber = parsePositiveInteger(args.seasonNumber, "seasonNumber");
    const providedStatus = typeof args.status === "string" && args.status.trim().length > 0
      ? validateSerialSeasonStatus(args.status)
      : null;
    const title = typeof args.title === "string" && args.title.trim().length > 0 ? args.title.trim() : null;
    const arcId = getOptionalString(args, "arcId");
    const promiseSummary = getOptionalString(args, "promiseSummary");

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      const nowValue = now();
      let season: DbSerialSeason | null = null;

      if (seasonId) {
        season = db.prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE id = ? AND project_id = ?")
          .get(seasonId, project.id) as DbSerialSeason | undefined ?? null;
        if (!season) {
          throw Object.assign(new Error(`Season not found: ${seasonId}`), { code: "SERIAL_SEASON_NOT_FOUND" });
        }
        const nextStatus = providedStatus || season.status;
        const nextTitle = title ?? season.title;
        const nextArcId = arcId ?? season.arc_id;
        const nextSummary = promiseSummary ?? season.promise_summary;
        if (nextArcId) {
          const ownerArc = db.prepare("SELECT id FROM arcs WHERE id = ? AND project_id = ?").get(nextArcId, project.id) as
            { id: string } | undefined;
          if (!ownerArc) {
            throw Object.assign(new Error(`Arc not found: ${nextArcId}`), { code: "ARC_NOT_FOUND" });
          }
        }
        db.prepare(
          "UPDATE serial_seasons SET season_number = ?, title = ?, status = ?, promise_summary = ?, arc_id = ?, updated_at = ? WHERE id = ?",
        ).run(
          season.season_number,
          nextTitle,
          nextStatus,
          nextSummary,
          nextArcId,
          nowValue,
          season.id,
        );
        if (nextStatus === "active") {
          db.prepare("UPDATE serial_seasons SET status = 'planned' WHERE project_id = ? AND id != ? AND status = 'active'").run(project.id, season.id);
        }
        season = db.prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE id = ?").get(season.id) as
          DbSerialSeason;
      } else {
        const active = getActiveSerialSeason(db, project.id);
        const nextNumber = seasonNumber ?? (active ? active.season_number + 1 : 1);
        if (seasonId) {
          db.prepare("SELECT id FROM serial_seasons WHERE project_id = ? AND season_number = ?").get(project.id, nextNumber) as
            { id: string } | undefined;
        }
        const existing = db
          .prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE project_id = ? AND season_number = ?")
          .get(project.id, nextNumber) as DbSerialSeason | undefined;
        const finalTitle = title || `Season ${nextNumber}`;
        const finalStatus = providedStatus || "planned";
        const resolvedArcId = arcId ?? null;
        if (resolvedArcId) {
          const ownerArc = db.prepare("SELECT id FROM arcs WHERE id = ? AND project_id = ?").get(resolvedArcId, project.id) as
            { id: string } | undefined;
          if (!ownerArc) {
            throw Object.assign(new Error(`Arc not found: ${resolvedArcId}`), { code: "ARC_NOT_FOUND" });
          }
        }
        if (existing) {
          db.prepare(
            "UPDATE serial_seasons SET title = ?, status = ?, promise_summary = ?, arc_id = ?, updated_at = ? WHERE id = ?",
          ).run(
            finalTitle,
            finalStatus,
            promiseSummary,
            resolvedArcId,
            nowValue,
            existing.id,
          );
          if (finalStatus === "active") {
            db.prepare("UPDATE serial_seasons SET status = 'planned' WHERE project_id = ? AND id != ? AND status = 'active'")
              .run(project.id, existing.id);
          }
          season = db.prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE id = ?").get(existing.id) as
            DbSerialSeason;
        } else {
          const createdId = typeof args.seasonId === "string" && args.seasonId.trim().length > 0 ? args.seasonId : crypto.randomUUID();
          if (finalStatus === "active" && active) {
            db.prepare("UPDATE serial_seasons SET status = 'planned' WHERE project_id = ? AND status = 'active'").run(project.id);
          }
          db.prepare(
            "INSERT INTO serial_seasons(id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).run(
            createdId,
            project.id,
            nextNumber,
            finalTitle,
            finalStatus,
            promiseSummary,
            resolvedArcId,
            null,
            nowValue,
            nowValue,
          );
          season = db.prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE id = ?").get(
            createdId,
          ) as DbSerialSeason;
        }
      }

      const gate = ensurePendingGate(db, project.id, "season", season.id, "season_plan");
      db.prepare("UPDATE serial_seasons SET gate_id = ? WHERE id = ?").run(gate.id, season.id);

      appendGraphLine(project.slug, "serial_seasons.jsonl", {
        action: "serial_season_plan",
        seasonId: season.id,
        seasonNumber: season.season_number,
        status: season.status
      });

      return { season, gate };
    });

    return mcpOk({ season: toJsonValue(result.season), gate: toJsonValue(result.gate) as JsonObject }, [], toJsonValue(result.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_SEASON_PLAN_ERROR", err.message || "Unable to plan serial season", true);
  }
}

function serialArcPlanTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const arcId = getOptionalString(args, "arcId");
    const title = getOptionalString(args, "title") || "Serial Arc";
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status.trim() : "draft";
    const ownerId = getOptionalString(args, "ownerId") || getOptionalString(args, "scopeId");
    const scopeInput = getOptionalString(args, "scope") || getOptionalString(args, "scopeType");
    const scope = validateSerialScopeValue(scopeInput, "scope");
    const seasonId = getOptionalString(args, "seasonId");

    const targetScopeId = seasonId || ownerId;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      if (scope === "season" && !targetScopeId) {
        throw Object.assign(new Error("Season arcs require owner/seasonId"), { code: "INVALID_PARAMS" });
      }

      if (targetScopeId) {
        if (scope === "season") {
          const season = getSerialSeasonById(db, targetScopeId);
          if (season?.project_id !== project.id) {
            throw Object.assign(new Error(`Season not found: ${targetScopeId}`), { code: "SERIAL_SEASON_NOT_FOUND" });
          }
          ensureGateApproved(db, project.id, "season", season.id, "season_plan");
        } else if (seasonId) {
          const season = getSerialSeasonById(db, seasonId);
          if (season?.project_id !== project.id) {
            throw Object.assign(new Error(`Season not found: ${seasonId}`), { code: "SERIAL_SEASON_NOT_FOUND" });
          }
        }
      }

      const nowValue = now();
      let targetArcId = arcId && arcId.trim().length > 0 ? arcId : crypto.randomUUID();
      const existing = db
        .prepare("SELECT id FROM arcs WHERE id = ? AND project_id = ?")
        .get(targetArcId, project.id) as
        | { id: string }
        | undefined;

      if (existing) {
        db.prepare(
          "UPDATE arcs SET scope = ?, owner_id = ?, title = ?, status = ?, updated_at = ? WHERE id = ?",
        ).run(
          scope,
          targetScopeId,
          title,
          status,
          nowValue,
          targetArcId,
        );
      } else {
        db.prepare(
          "INSERT INTO arcs(id, project_id, scope, owner_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          targetArcId,
          project.id,
          scope,
          targetScopeId,
          title,
          status,
          nowValue,
          nowValue,
        );
      }

      const gateScopeType = scope === "season" && targetScopeId ? "season" : "project";
      const gateScopeId = scope === "season" && targetScopeId ? targetScopeId : project.id;
      const gate = ensurePendingGate(db, project.id, gateScopeType as string, gateScopeId, "serial_arc_plan");
      if (scope === "season" && targetScopeId) {
        db.prepare("UPDATE serial_seasons SET arc_id = ?, updated_at = ? WHERE id = ? AND project_id = ?")
          .run(targetArcId, nowValue, targetScopeId, project.id);
      }
      const arc = db.prepare("SELECT id, project_id, scope, owner_id, title, status, created_at, updated_at FROM arcs WHERE id = ?").get(targetArcId) as
        DbArc;

      appendGraphLine(project.slug, "serial_arcs.jsonl", {
        action: "serial_arc_plan",
        arcId: targetArcId,
        scope,
        ownerId: targetScopeId,
        seasonId,
        gateId: gate.id
      });

      return { arc, gate };
    });

    return mcpOk(
      { arc: toJsonValue(result.arc) as JsonObject, gate: toJsonValue(result.gate) as JsonObject },
      [],
      toJsonValue(result.gate) as JsonObject,
    );
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_ARC_PLAN_ERROR", err.message || "Unable to plan serial arc", true);
  }
}

function serialNextEpisodeTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const episodeId = getOptionalString(args, "episodeId");
    const seasonId = getOptionalString(args, "seasonId");
    const seasonNumberRaw = parsePositiveInteger(args.seasonNumber, "seasonNumber");
    const episodeNumber = parsePositiveInteger(args.episodeNumber, "episodeNumber");
    const status = getOptionalString(args, "status") || "drafting";
    const finalStatus = validateSerialEpisodeStatus(status);
    const releaseLabel = getOptionalString(args, "releaseLabel");
    const title = getOptionalString(args, "title") || getOptionalString(args, "episodeTitle");
    const outlineMarkdown = typeof args.outlineMarkdown === "string" ? args.outlineMarkdown : null;
    const outlinePathArg = typeof args.outlinePath === "string" ? args.outlinePath : null;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      let season: DbSerialSeason | null = null;
      if (seasonId) {
        season = db.prepare("SELECT id, project_id, season_number, title, status, promise_summary, arc_id, gate_id, created_at, updated_at FROM serial_seasons WHERE id = ? AND project_id = ?")
          .get(seasonId, project.id) as DbSerialSeason | undefined ?? null;
        if (!season) throw Object.assign(new Error(`Season not found: ${seasonId}`), { code: "SERIAL_SEASON_NOT_FOUND" });
      } else if (seasonNumberRaw !== null) {
        season = getSerialSeasonByNumber(db, project.id, seasonNumberRaw);
        if (!season) throw Object.assign(new Error(`Season ${seasonNumberRaw} not found`), { code: "SERIAL_SEASON_NOT_FOUND" });
      } else {
        season = getActiveSerialSeason(db, project.id);
        if (!season) {
          const latestSeason = getLatestSerialSeason(db, project.id);
          if (!latestSeason) {
            throw Object.assign(new Error("No serial season found. Create a season first."), { code: "SERIAL_SEASON_NOT_FOUND" });
          }
          season = latestSeason;
        }
      }

      if (season.status !== "active") {
        throw Object.assign(new Error("Season is not active"), { code: "SERIAL_SEASON_STATE_ERROR" });
      }

      ensureGateApproved(db, project.id, "season", season.id, "season_plan");
      ensureGateApproved(db, project.id, "season", season.id, "serial_arc_plan");

      let episode: DbSerialEpisode | null = null;
      if (episodeId) {
        episode = getSerialEpisodeById(db, project.id, episodeId);
        if (!episode) throw Object.assign(new Error(`Episode not found: ${episodeId}`), { code: "SERIAL_EPISODE_NOT_FOUND" });
        if (episode.season_id !== season.id) {
          throw Object.assign(new Error("Episode does not belong to the selected season"), { code: "SERIAL_EPISODE_SCOPE_MISMATCH" });
        }
      } else if (episodeNumber !== null) {
        episode = getSerialEpisodeBySeasonAndNumber(db, project.id, season.id, episodeNumber);
      }

      const resolvedEpisodeNumber = episode?.episode_number ?? episodeNumber ?? getNextSerialEpisodeNumberForSeason(db, project.id, season.id);
      const chapterId = episode?.chapter_id ?? crypto.randomUUID();

      const { chapter, artifactId } = upsertChapterOutlineRecord(
        db,
        project,
        chapterId,
        resolvedEpisodeNumber,
        "season",
        season.id,
        title || `Episode ${resolvedEpisodeNumber}`,
        "outlined",
        outlineMarkdown,
        outlinePathArg,
        null,
        true,
      );
      if (episode) {
        db.prepare(
          "UPDATE serial_episodes SET status = ?, release_label = ?, updated_at = ? WHERE id = ?",
        ).run(finalStatus, releaseLabel, now(), episode.id);
        episode = db.prepare(
          "SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at FROM serial_episodes WHERE id = ?",
        ).get(episode.id) as DbSerialEpisode;
      } else {
        const finalEpisodeId = typeof args.episodeId === "string" && args.episodeId.trim().length > 0
          ? args.episodeId.trim()
          : crypto.randomUUID();
        db.prepare(
          "INSERT INTO serial_episodes(id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          finalEpisodeId,
          project.id,
          season.id,
          chapter.id,
          resolvedEpisodeNumber,
          getNextSerialSequence(db, project.id),
          finalStatus,
          releaseLabel,
          now(),
          now(),
        );
        episode = db.prepare(
          "SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at FROM serial_episodes WHERE id = ?",
        ).get(finalEpisodeId) as DbSerialEpisode;
      }

      const chapterGateTypes = CHAPTER_PRE_PROSE_GATES;
      const episodeChapterGates = chapterGateTypes.map((gateType) => getLatestGateForType(db, project.id, "chapter", chapter.id, gateType)).filter((gate): gate is DbGate => Boolean(gate));

      appendGraphLine(project.slug, "serial_episodes.jsonl", {
        action: "serial_next_episode",
        episodeId: episode.id,
        seasonId: season.id,
        chapterId: chapter.id,
        artifactId,
        episodeNumber: resolvedEpisodeNumber,
        status: finalStatus
      });

      return {
        season,
        episode,
        chapter,
        chapterGates: episodeChapterGates
      };
    });

    return mcpOk({
      season: toJsonValue(result.season) as JsonObject,
      episode: toJsonValue(result.episode) as JsonObject,
      chapter: toJsonValue(result.chapter) as JsonObject,
      preProseGates: result.chapterGates.map((gate) => toJsonValue(gate) as JsonObject)
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_NEXT_EPISODE_ERROR", err.message || "Unable to create or resume serial episode", true);
  }
}

function serialPromiseUpsertTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const promiseId = getOptionalString(args, "promiseId") || getOptionalString(args, "id") || crypto.randomUUID();
    const title = getOptionalString(args, "title");
    const category = typeof args.category === "string" && args.category.trim().length > 0
      ? validateSerialPromiseCategory(args.category)
      : null;
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? validateSerialPromiseStatus(args.status) : null;
    const visibility = typeof args.visibility === "string" && args.visibility.trim().length > 0
      ? validateSerialPromiseVisibility(args.visibility)
      : null;
    const priority = typeof args.priority === "number" && Number.isFinite(args.priority) ? Math.max(0, Math.floor(args.priority)) : null;
    const openedEpisodeId = getOptionalString(args, "openedEpisodeId") || getOptionalString(args, "sourceEpisodeId");
    const payoffEpisodeId = getOptionalString(args, "payoffEpisodeId");
    const sourceRef = getOptionalString(args, "sourceRef");
    const targetScopeType = getOptionalString(args, "targetScopeType") || getOptionalString(args, "scopeType");
    const targetScopeId = getOptionalString(args, "targetScopeId") || getOptionalString(args, "scopeId");
    const note = getOptionalString(args, "note") || getOptionalString(args, "notes");

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      if (openedEpisodeId) {
        const openedEpisode = getSerialEpisodeById(db, project.id, openedEpisodeId);
        if (!openedEpisode) throw Object.assign(new Error(`Opened episode not found: ${openedEpisodeId}`), { code: "SERIAL_EPISODE_NOT_FOUND" });
      }
      if (payoffEpisodeId) {
        const payoffEpisode = getSerialEpisodeById(db, project.id, payoffEpisodeId);
        if (!payoffEpisode) throw Object.assign(new Error(`Payoff episode not found: ${payoffEpisodeId}`), { code: "SERIAL_EPISODE_NOT_FOUND" });
      }

      let scopeType: SerialScope | null = null;
      if (targetScopeType !== null) {
        scopeType = validateSerialScopeValue(targetScopeType, "targetScopeType");
      }
      if (scopeType && !targetScopeId) {
        throw Object.assign(new Error("targetScopeId required when targetScopeType is provided"), { code: "INVALID_PARAMS" });
      }

      const existing = db
        .prepare("SELECT * FROM serial_promises WHERE id = ? AND project_id = ?")
        .get(promiseId, project.id) as DbSerialPromise | undefined;

      const nowValue = now();
      if (existing) {
        const nextStatus = status ?? existing.status;
        const nextVisibility = visibility ?? existing.visibility;
        const nextCategory = category ?? existing.category;
        const nextTitle = title ?? existing.title;
        const nextPriority = priority !== null ? priority : existing.priority;
        const nextOpenedEpisodeId = openedEpisodeId ?? existing.opened_episode_id;
        const nextPayoffEpisodeId = payoffEpisodeId ?? existing.payoff_episode_id;
        const nextScopeType = scopeType ?? existing.target_scope_type;
        const nextScopeId = targetScopeId ?? existing.target_scope_id;
        const nextSourceRef = sourceRef ?? existing.source_ref;

        if (nextStatus !== existing.status) {
          recordSerialPromiseEvent(db, existing.id, "status_update", nextOpenedEpisodeId, note, sourceRef ?? existing.source_ref);
        }
        if (nextPayoffEpisodeId !== existing.payoff_episode_id) {
          recordSerialPromiseEvent(
            db,
            existing.id,
            "payoff_episode_set",
            nextPayoffEpisodeId,
            note,
            sourceRef ?? existing.source_ref,
          );
        }
        if (nextOpenedEpisodeId !== existing.opened_episode_id) {
          recordSerialPromiseEvent(
            db,
            existing.id,
            "opened_episode_set",
            nextOpenedEpisodeId,
            note,
            sourceRef ?? existing.source_ref,
          );
        }

        db.prepare(
          `UPDATE serial_promises
           SET title = ?, category = ?, status = ?, visibility = ?, priority = ?, opened_episode_id = ?, target_scope_type = ?, target_scope_id = ?, payoff_episode_id = ?, source_ref = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          nextTitle,
          nextCategory,
          nextStatus,
          nextVisibility,
          nextPriority,
          nextOpenedEpisodeId,
          nextScopeType,
          nextScopeId,
          nextPayoffEpisodeId,
          nextSourceRef,
          nowValue,
          promiseId,
        );
      } else {
        if (!title || !category || !status || !visibility) {
          throw Object.assign(new Error("title, category, status, and visibility are required for new promises"), { code: "INVALID_PARAMS" });
        }
        db.prepare(
          `INSERT INTO serial_promises(id, project_id, title, category, status, visibility, priority, opened_episode_id, target_scope_type, target_scope_id, payoff_episode_id, source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          promiseId,
          project.id,
          title,
          category,
          status,
          visibility,
          priority ?? 0,
          openedEpisodeId,
          scopeType,
          targetScopeId,
          payoffEpisodeId,
          sourceRef,
          nowValue,
          nowValue,
        );
        recordSerialPromiseEvent(db, promiseId, "upserted", openedEpisodeId, note, sourceRef);
      }

      const updated = db.prepare("SELECT * FROM serial_promises WHERE id = ?").get(promiseId) as DbSerialPromise;
      appendGraphLine(project.slug, "serial_promises.jsonl", {
        action: existing ? "serial_promise_update" : "serial_promise_create",
        projectId: project.id,
        promiseId,
        status: updated.status,
        visibility: updated.visibility
      });
      return updated;
    });

    return mcpOk({ promise: toJsonValue(result) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_PROMISE_UPSERT_ERROR", err.message || "Unable to upsert serial promise", true);
  }
}

function serialPromiseListTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const seasonId = getOptionalString(args, "seasonId");
    const episodeId = getOptionalString(args, "episodeId");
    const { scopeType, scopeId } = resolveSerialScopeFromArgs({
      ...args,
      scopeType: getOptionalString(args, "scopeType") || getOptionalString(args, "targetScopeType") || undefined,
      scopeId: getOptionalString(args, "scopeId") || getOptionalString(args, "targetScopeId") || undefined
    });
    const statusRaw = getOptionalString(args, "status");
    const statusList = statusRaw
      ? statusRaw.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
      : null;
    const categoryRaw = getOptionalString(args, "category");
    const categoryList = categoryRaw
      ? categoryRaw.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
      : null;
    const visibilityRaw = getOptionalString(args, "visibility");
    const visibilityList = visibilityRaw
      ? visibilityRaw.split(",").map((item) => item.trim()).filter((item) => item.length > 0)
      : null;
    const limitRaw = args.limit === undefined ? null : parseNonNegativeInteger(args.limit, "limit");
    const limit = limitRaw === null ? 50 : Math.max(1, Math.min(100, limitRaw));
    const offset = args.offset === undefined ? 0 : parseNonNegativeInteger(args.offset, "offset");

    const rows = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      const conditions: string[] = ["project_id = ?"];
      const params: Array<string | number> = [project.id];

      if (statusList && statusList.length > 0) {
        const validated: string[] = [];
        for (const item of statusList) {
          validated.push(validateSerialPromiseStatus(item));
        }
        conditions.push(`status IN (${serializeWhereIn(validated)})`);
        params.push(...validated);
      }
      if (categoryList && categoryList.length > 0) {
        const validated: string[] = [];
        for (const item of categoryList) {
          validated.push(validateSerialPromiseCategory(item));
        }
        conditions.push(`category IN (${serializeWhereIn(validated)})`);
        params.push(...validated);
      }
      if (visibilityList && visibilityList.length > 0) {
        const validated: string[] = [];
        for (const item of visibilityList) {
          validated.push(validateSerialPromiseVisibility(item));
        }
        conditions.push(`visibility IN (${serializeWhereIn(validated)})`);
        params.push(...validated);
      }
      if (scopeType !== null) {
        conditions.push("target_scope_type = ?");
        params.push(scopeType);
        if (scopeId) {
          conditions.push("target_scope_id = ?");
          params.push(scopeId);
        }
      } else if (scopeId) {
        conditions.push("target_scope_id = ?");
        params.push(scopeId);
      }
      if (seasonId) {
        const episodeIds = getSerialEpisodeIdsForSeason(db, project.id, seasonId);
        if (episodeIds.length === 0) {
          return { total: 0, promises: [] as DbSerialPromise[] };
        }
        conditions.push(`(target_scope_id = ? OR opened_episode_id IN (${serializeWhereIn(episodeIds)}) OR payoff_episode_id IN (${serializeWhereIn(episodeIds)}))`);
        params.push(seasonId, ...episodeIds, ...episodeIds);
      }
      if (episodeId) {
        conditions.push(`(target_scope_id = ? OR opened_episode_id = ? OR payoff_episode_id = ?)`);
        params.push(episodeId, episodeId, episodeId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const promises = db.prepare(
        `SELECT id, project_id, title, category, status, visibility, priority, opened_episode_id, target_scope_type, target_scope_id, payoff_episode_id, source_ref, created_at, updated_at
         FROM serial_promises
         ${where}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as DbSerialPromise[];
      const countRow = db.prepare(`SELECT COUNT(*) AS count FROM serial_promises ${where}`).get(...params) as { count: number } | undefined;
      return {
        total: countRow ? countRow.count : 0,
        promises
      };
    });

    return mcpOk({
      count: rows.total,
      limit,
      offset,
      promises: rows.promises.map((promise) => toJsonValue(promise) as JsonObject)
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_PROMISE_LIST_ERROR", err.message || "Unable to list serial promises", true);
  }
}

function serialRecapGenerateTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const audience = validateSerialAudience(args.audience);
    const seasonIdArg = getOptionalString(args, "seasonId");
    const episodeId = getOptionalString(args, "episodeId");
    const includeOpenPromises = getOptionalBoolean(args, "includeOpenPromises", true);
    const maxEpisodes = Math.max(1, Math.min(25, parsePositiveInteger(args.maxEpisodes, "maxEpisodes") ?? 10));

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      let episode: DbSerialEpisode | null = null;
      if (episodeId) {
        episode = getSerialEpisodeById(db, project.id, episodeId);
        if (!episode) throw Object.assign(new Error(`Episode not found: ${episodeId}`), { code: "SERIAL_EPISODE_NOT_FOUND" });
      }

      let season: DbSerialSeason | null = null;
      if (seasonIdArg) {
        season = getSerialSeasonById(db, seasonIdArg);
        if (season?.project_id !== project.id) {
          throw Object.assign(new Error(`Season not found: ${seasonIdArg}`), { code: "SERIAL_SEASON_NOT_FOUND" });
        }
      } else if (episode) {
        season = getSerialSeasonById(db, episode.season_id);
      } else {
        season = getActiveSerialSeason(db, project.id) ?? getLatestSerialSeason(db, project.id);
      }
      if (!season) {
        throw Object.assign(new Error("No serial season available for recap"), { code: "SERIAL_SEASON_NOT_FOUND" });
      }

      const episodes = episode
        ? [episode]
        : db
          .prepare(
            `SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at
             FROM serial_episodes
             WHERE project_id = ? AND season_id = ?
             ORDER BY serial_sequence DESC
             LIMIT ?`,
          )
          .all(project.id, season.id, maxEpisodes) as DbSerialEpisode[];
      const orderedEpisodes = [...episodes].sort((a, b) => a.serial_sequence - b.serial_sequence);
      const episodeIds = orderedEpisodes.map((entry) => entry.id);

      const promiseConditions = ["project_id = ?"];
      const promiseParams: Array<string | number> = [project.id];
      if (audience === "reader") {
        promiseConditions.push("visibility IN ('reader', 'both')");
      }
      if (includeOpenPromises) {
        promiseConditions.push("status IN ('open', 'advanced', 'deferred')");
      }
      if (episodeIds.length > 0) {
        promiseConditions.push(
          `(target_scope_id = ? OR opened_episode_id IN (${serializeWhereIn(episodeIds)}) OR payoff_episode_id IN (${serializeWhereIn(episodeIds)}))`,
        );
        promiseParams.push(season.id, ...episodeIds, ...episodeIds);
      } else {
        promiseConditions.push("target_scope_id = ?");
        promiseParams.push(season.id);
      }

      const promises = db.prepare(
        `SELECT id, project_id, title, category, status, visibility, priority, opened_episode_id, target_scope_type, target_scope_id, payoff_episode_id, source_ref, created_at, updated_at
         FROM serial_promises
         WHERE ${promiseConditions.join(" AND ")}
         ORDER BY priority DESC, updated_at DESC
         LIMIT 100`,
      ).all(...promiseParams) as DbSerialPromise[];

      const scopeType = episode ? "episode" : "season";
      const scopeId = episode ? episode.id : season.id;
      const markdownLines = [
        `# ${audience === "reader" ? "Reader" : "Private"} recap`,
        "",
        `Project: ${project.slug}`,
        `Season: ${season.season_number} - ${season.title}`,
        episode ? `Episode: ${episode.episode_number}` : `Episodes included: ${orderedEpisodes.length}`,
        "",
        "## Episodes",
        ...(
          orderedEpisodes.length > 0
            ? orderedEpisodes.map((entry) => `- Episode ${entry.episode_number}${entry.release_label ? ` (${entry.release_label})` : ""}: ${entry.status}`)
            : ["- No recorded episodes yet."]
        ),
        "",
        "## Open promises",
        ...(
          promises.length > 0
            ? promises.map((promise) => `- [${promise.status}] ${promise.title} (${promise.category}, ${promise.visibility})`)
            : ["- No matching promises."]
        ),
        ""
      ];
      const markdown = markdownLines.join("\n");
      const fileSafeScope = formatPathSafe(`${scopeType}-${scopeId}-${audience}-${now()}`);
      const recapPath = writeProjectFile(project.slug, join("recaps", `${fileSafeScope}.md`), markdown);
      const recapId = crypto.randomUUID();
      const sourcePayload = {
        scopeType,
        scopeId,
        audience,
        seasonId: season.id,
        episodeIds,
        promiseIds: promises.map((promise) => promise.id)
      };
      db.prepare(
        "INSERT INTO serial_recaps(id, project_id, scope_type, scope_id, audience, markdown_path, source_payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(recapId, project.id, scopeType, scopeId, audience, recapPath, JSON.stringify(toJsonValue(sourcePayload)), now());
      appendGraphLine(project.slug, "serial_recaps.jsonl", {
        action: "serial_recap_generate",
        recapId,
        scopeType,
        scopeId,
        audience
      });

      return { recapId, recapPath, markdown, sourcePayload };
    });

    return mcpOk({
      recapId: result.recapId,
      recapPath: result.recapPath,
      markdownPath: result.recapPath,
      markdown: result.markdown,
      sourcePayload: toJsonValue(result.sourcePayload) as JsonObject
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_RECAP_ERROR", err.message || "Unable to generate serial recap", true);
  }
}

function serialSeasonReportTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const seasonIdArg = getOptionalString(args, "seasonId");
    const seasonNumber = parsePositiveInteger(args.seasonNumber, "seasonNumber");
    const includePrivate = getOptionalBoolean(args, "includePrivate", false);

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      ensureSerialProject(project);

      const season = seasonIdArg
        ? getSerialSeasonById(db, seasonIdArg)
        : seasonNumber
          ? findSerialSeasonByNumber(db, project.id, seasonNumber)
          : (getActiveSerialSeason(db, project.id) ?? getLatestSerialSeason(db, project.id));
      if (!season || season.project_id !== project.id) {
        throw Object.assign(new Error("Season not found"), { code: "SERIAL_SEASON_NOT_FOUND" });
      }

      const episodes = db.prepare(
        `SELECT id, project_id, season_id, chapter_id, episode_number, serial_sequence, status, release_label, created_at, updated_at
         FROM serial_episodes
         WHERE project_id = ? AND season_id = ?
         ORDER BY episode_number ASC`,
      ).all(project.id, season.id) as DbSerialEpisode[];
      const chapterIds = episodes.map((episode) => episode.chapter_id);
      const chapters = chapterIds.length > 0
        ? db.prepare(`SELECT id, status FROM chapters WHERE project_id = ? AND id IN (${serializeWhereIn(chapterIds)})`)
          .all(project.id, ...chapterIds) as Array<{ id: string; status: string }>
        : [];
      const completeChapterIds = new Set(chapters.filter((chapter) => chapter.status === "complete").map((chapter) => chapter.id));
      const incompleteEpisodes = episodes.filter((episode) => !completeChapterIds.has(episode.chapter_id));
      const episodeIds = episodes.map((episode) => episode.id);

      const promiseConditions = ["project_id = ?", "status IN ('open', 'advanced', 'deferred')"];
      const promiseParams: Array<string | number> = [project.id];
      if (!includePrivate) {
        promiseConditions.push("visibility IN ('reader', 'both')");
      }
      if (episodeIds.length > 0) {
        promiseConditions.push(
          `(target_scope_id = ? OR opened_episode_id IN (${serializeWhereIn(episodeIds)}) OR payoff_episode_id IN (${serializeWhereIn(episodeIds)}))`,
        );
        promiseParams.push(season.id, ...episodeIds, ...episodeIds);
      } else {
        promiseConditions.push("target_scope_id = ?");
        promiseParams.push(season.id);
      }
      const unresolvedPromises = db.prepare(
        `SELECT id, project_id, title, category, status, visibility, priority, opened_episode_id, target_scope_type, target_scope_id, payoff_episode_id, source_ref, created_at, updated_at
         FROM serial_promises
         WHERE ${promiseConditions.join(" AND ")}
         ORDER BY priority DESC, updated_at DESC`,
      ).all(...promiseParams) as DbSerialPromise[];

      const seasonGates = collectProjectScopeAndGateRows(db, project.id, "season", season.id);
      const chapterGateRows = chapterIds.length > 0
        ? db.prepare(
          `SELECT id, project_id, scope_type, scope_id, gate_type, status, required, blocker_reason, blocker_payload_json, created_at, resolved_at
           FROM gates
           WHERE project_id = ? AND scope_type = 'chapter' AND scope_id IN (${serializeWhereIn(chapterIds)})
           ORDER BY created_at ASC`,
        ).all(project.id, ...chapterIds) as DbGate[]
        : [];
      const unresolvedGates = [...seasonGates, ...chapterGateRows].filter((gate) => gate.required !== 0 && gate.status !== "approved");

      const arcBeatSummary = season.arc_id
        ? (() => {
          const beats = db.prepare("SELECT beat_name, beat_order FROM seven_point_beats WHERE arc_id = ? ORDER BY beat_order ASC").all(season.arc_id) as
            Array<{ beat_name: string; beat_order: number }>;
          const present = new Set(beats.map((beat) => beat.beat_name.trim().toLowerCase()));
          const missing = REQUIRED_BEAT_NAMES.filter((name) => !present.has(name.toLowerCase()));
          return { arcId: season.arc_id, beatCount: beats.length, missing, valid: missing.length === 0 };
        })()
        : { arcId: null, beatCount: 0, missing: [...REQUIRED_BEAT_NAMES], valid: false };

      const reviewGate = ensurePendingGate(db, project.id, "season", season.id, "season_completion_review");
      const summary = {
        seasonId: season.id,
        seasonNumber: season.season_number,
        episodeCount: episodes.length,
        incompleteEpisodeCount: incompleteEpisodes.length,
        unresolvedPromiseCount: unresolvedPromises.length,
        unresolvedGateCount: unresolvedGates.length,
        arcBeatSummary,
        blockers: unresolvedGates.map((gate) => ({
          gateId: gate.id,
          gateType: gate.gate_type,
          scopeType: gate.scope_type,
          scopeId: gate.scope_id,
          status: gate.status
        }))
      };
      const markdown = [
        `# Season ${season.season_number} completion report`,
        "",
        `Project: ${project.slug}`,
        `Season: ${season.title}`,
        `Episodes: ${episodes.length}`,
        `Incomplete episodes: ${incompleteEpisodes.length}`,
        `Unresolved promises: ${unresolvedPromises.length}`,
        `Unresolved gates: ${unresolvedGates.length}`,
        `Seven-point valid: ${arcBeatSummary.valid ? "yes" : "no"}`,
        "",
        "## Blockers",
        ...(summary.blockers.length > 0 ? summary.blockers.map((blocker) => `- ${blocker.gateType} ${blocker.status} (${blocker.scopeType}:${blocker.scopeId})`) : ["- None."]),
        "",
        "## Open promises",
        ...(unresolvedPromises.length > 0 ? unresolvedPromises.map((promise) => `- [${promise.status}] ${promise.title}`) : ["- None."]),
        ""
      ].join("\n");
      const reportPath = writeProjectFile(project.slug, join("reports", `season-${season.season_number}-completion.md`), markdown);
      const reportId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO serial_season_reports(id, project_id, season_id, markdown_path, summary_json, unresolved_promise_count, incomplete_episode_count, gate_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        reportId,
        project.id,
        season.id,
        reportPath,
        JSON.stringify(toJsonValue(summary)),
        unresolvedPromises.length,
        incompleteEpisodes.length,
        reviewGate.id,
        now(),
      );
      appendGraphLine(project.slug, "serial_season_reports.jsonl", {
        action: "serial_season_report",
        reportId,
        seasonId: season.id,
        unresolvedPromiseCount: unresolvedPromises.length,
        incompleteEpisodeCount: incompleteEpisodes.length
      });
      return { reportId, reportPath, summary, gate: reviewGate };
    });

    return mcpOk({
      reportId: result.reportId,
      reportPath: result.reportPath,
      markdownPath: result.reportPath,
      unresolvedPromiseCount: result.summary.unresolvedPromiseCount,
      incompleteEpisodeCount: result.summary.incompleteEpisodeCount,
      summary: toJsonValue(result.summary) as JsonObject,
      gate: toJsonValue(result.gate) as JsonObject
    }, [], toJsonValue(result.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "SERIAL_SEASON_REPORT_ERROR", err.message || "Unable to generate serial season report", true);
  }
}

function chapterVariantCreateTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");
    const variantType = getRequiredString(args, "variantType");
    if (!CHAPTER_VARIANT_TYPES.includes(variantType as ChapterVariantType)) {
      throw Object.assign(new Error("Invalid variant type"), { code: "INVALID_PARAMS" });
    }
    const purpose = typeof args.purpose === "string" && args.purpose.trim().length > 0
      ? args.purpose.trim()
      : CHAPTER_VARIANT_TYPES.includes(variantType as ChapterVariantType)
        ? `${variantType} draft`
        : "";
    const variantId = typeof args.variantId === "string" && args.variantId.trim().length > 0 ? args.variantId : crypto.randomUUID();
    const markdownText = typeof args.markdownText === "string" ? args.markdownText : null;
    const markdownPathInput = typeof args.markdownPath === "string" && args.markdownPath.trim().length > 0 ? args.markdownPath : null;
    const changedStructurally = getOptionalString(args, "changedStructurally");
    const changedEmotionally = getOptionalString(args, "changedEmotionally");
    const changedInPacing = getOptionalString(args, "changedInPacing");
    const canonRisk = getOptionalString(args, "canonRisk");
    const continuityRisk = getOptionalString(args, "continuityRisk");
    const bestUseCase = getOptionalString(args, "bestUseCase");
    const reasonToChoose = getOptionalString(args, "reasonToChoose");
    const reasonNotToChoose = getOptionalString(args, "reasonNotToChoose");
    const nowValue = now();

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      ensureProjectWorkflowComplete(db, project);
      ensureChapterPreProseApproved(db, project.id, chapter.id);

      const markdownPath = markdownText !== null
        ? writeProjectFile(project.slug, join("chapters", chapterId, "variants", `${variantType}.md`), markdownText)
        : (markdownPathInput ? resolveChapterFilePath(project.slug, markdownPathInput) : null);
      if (!markdownPath) {
        throw Object.assign(new Error("markdownText or markdownPath is required"), { code: "INVALID_PARAMS" });
      }
      const sameTypeConflict = db
        .prepare("SELECT id FROM chapter_variants WHERE chapter_id = ? AND variant_type = ? AND id != ?")
        .get(chapter.id, variantType, variantId) as { id: string } | undefined;
      if (sameTypeConflict) {
        throw Object.assign(new Error(`Variant type ${variantType} already exists for chapter`), { code: "DUPLICATE_VARIANT_TYPE" });
      }

      const conflictingIdRow = db.prepare("SELECT chapter_id FROM chapter_variants WHERE id = ?").get(variantId) as
        | { chapter_id: string }
        | undefined;
      if (conflictingIdRow && conflictingIdRow.chapter_id !== chapter.id) {
        throw Object.assign(new Error("Variant id already assigned to another chapter"), { code: "INVALID_VARIANT_ID" });
      }

      const existing = db.prepare("SELECT id FROM chapter_variants WHERE id = ? AND chapter_id = ?").get(variantId, chapter.id) as
        | { id: string }
        | undefined;
      if (existing) {
        db.prepare(
          `UPDATE chapter_variants
           SET variant_type = ?, purpose = ?, changed_structurally = ?, changed_emotionally = ?, changed_in_pacing = ?, canon_risk = ?, continuity_risk = ?, best_use_case = ?, reason_to_choose = ?, reason_not_to_choose = ?, markdown_path = ?, status = ?, updated_at = ?
           WHERE id = ? AND chapter_id = ?`,
        ).run(
          variantType,
          purpose,
          changedStructurally,
          changedEmotionally,
          changedInPacing,
          canonRisk,
          continuityRisk,
          bestUseCase,
          reasonToChoose,
          reasonNotToChoose,
          markdownPath,
          "draft",
          nowValue,
          variantId,
          chapter.id,
        );
      } else {
        db.prepare(
          `INSERT INTO chapter_variants(id, chapter_id, variant_type, purpose, changed_structurally, changed_emotionally, changed_in_pacing, canon_risk, continuity_risk, best_use_case, reason_to_choose, reason_not_to_choose, markdown_path, status, selected, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', 0, ?, ?)`,
        ).run(
          variantId,
          chapter.id,
          variantType,
          purpose,
          changedStructurally,
          changedEmotionally,
          changedInPacing,
          canonRisk,
          continuityRisk,
          bestUseCase,
          reasonToChoose,
          reasonNotToChoose,
          markdownPath,
          nowValue,
          nowValue,
        );
      }

      const variant = db.prepare("SELECT * FROM chapter_variants WHERE id = ? AND chapter_id = ?").get(variantId, chapter.id) as
        DbChapterVariant;
      const variants = db
        .prepare(
          "SELECT id, chapter_id, variant_type, purpose, changed_structurally, changed_emotionally, changed_in_pacing, canon_risk, continuity_risk, best_use_case, reason_to_choose, reason_not_to_choose, markdown_path, rank_score, ranking_reason, selected, status, selection_reason, updated_at, created_at FROM chapter_variants WHERE chapter_id = ?",
        )
        .all(chapter.id) as DbChapterVariant[];
      const variantCount = variants.length;
      return { variant, variantCount };
    });

    appendGraphLine(projectSlug, "chapter_variants.jsonl", {
      action: "chapter_variant_create",
      chapterId,
      variantId: payload.variant.id,
      variantType
    });

    return mcpOk({ variant: toJsonValue(payload.variant) as JsonObject, variantCount: payload.variantCount });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_VARIANT_CREATE_ERROR", err.message || "Unable to create chapter variant", true);
  }
}

function chapterVariantListTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      const variants = db
        .prepare(
          "SELECT id, chapter_id, variant_type, purpose, changed_structurally, changed_emotionally, changed_in_pacing, canon_risk, continuity_risk, best_use_case, reason_to_choose, reason_not_to_choose, markdown_path, rank_score, ranking_reason, selected, status, selection_reason, updated_at, created_at FROM chapter_variants WHERE chapter_id = ? ORDER BY created_at ASC",
        )
        .all(chapter.id) as DbChapterVariant[];
      const selected = variants.find((variant) => variant.selected === 1) ?? null;
      return { variants, selected };
    });

    return mcpOk({
      chapterId,
      variantCount: payload.variants.length,
      variants: payload.variants.map((variant) => toJsonValue(variant) as JsonObject),
      selectedVariantId: payload.selected ? payload.selected.id : null,
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_VARIANT_LIST_ERROR", err.message || "Unable to list chapter variants", true);
  }
}

function chapterVariantRankTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");
    const rankings = Array.isArray(args.rankings) ? args.rankings : null;
    if (rankings === null || rankings.length === 0) {
      return mcpError("INVALID_PARAMS", "rankings must be a non-empty array", true);
    }

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      ensureChapterPreProseApproved(db, project.id, chapter.id);
      const variants = ensureExactlyThreeVariants(db, chapter.id);
      const nowValue = now();
      const requested = new Map<string, { rankScore: number | null; rankingReason: string | null }>();

      for (const item of rankings) {
        if (!isObject(item)) {
          throw Object.assign(new Error("ranking item must be an object"), { code: "INVALID_PARAMS" });
        }
        const variantId = getRequiredString(item, "variantId");
        const rankScore = typeof item.rankScore === "number" && Number.isFinite(item.rankScore) ? item.rankScore : null;
        const rankingReason = getOptionalString(item, "rankingReason");
        if (requested.has(variantId)) {
          throw Object.assign(new Error(`Duplicate ranking entry: ${variantId}`), { code: "INVALID_RANKING" });
        }
        const variant = variants.find((entry) => entry.id === variantId);
        if (!variant) {
          throw Object.assign(new Error(`Unknown variant id: ${variantId}`), { code: "INVALID_VARIANT_ID" });
        }
        requested.set(variantId, { rankScore, rankingReason });
      }

      if (requested.size !== CHAPTER_VARIANT_TYPES.length) {
        throw Object.assign(new Error("Ranking must cover all required variant ids"), { code: "INVALID_VARIANT_COUNT" });
      }
      const seenTypes = new Set<string>();
      for (const variant of variants) {
        const entry = requested.get(variant.id);
        if (!entry) {
          throw Object.assign(new Error("Ranking must cover all required variant ids"), { code: "INVALID_VARIANT_COUNT" });
        }
        seenTypes.add(variant.variant_type);
      }

      if (seenTypes.size !== CHAPTER_VARIANT_TYPES.length) {
        throw Object.assign(new Error("Ranking must cover all required variant types"), { code: "INVALID_VARIANT_TYPES" });
      }

      db.run("BEGIN");
      try {
        for (const [variantId, entry] of requested.entries()) {
          db.prepare("UPDATE chapter_variants SET rank_score = ?, ranking_reason = ?, status = ?, updated_at = ? WHERE id = ? AND chapter_id = ?")
            .run(
              entry.rankScore,
              entry.rankingReason,
              "ranked",
              nowValue,
              variantId,
              chapter.id,
            );
        }
        db.run("COMMIT");
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }

      ensurePendingGate(db, project.id, "chapter", chapter.id, CHAPTER_VARIANT_CHOICE_GATE);

      const rankedVariants = db.prepare(
        "SELECT id, chapter_id, variant_type, purpose, changed_structurally, changed_emotionally, changed_in_pacing, canon_risk, continuity_risk, best_use_case, reason_to_choose, reason_not_to_choose, markdown_path, rank_score, ranking_reason, selected, status, selection_reason, updated_at, created_at FROM chapter_variants WHERE chapter_id = ? ORDER BY created_at ASC",
      ).all(chapter.id) as DbChapterVariant[];
      const choiceGate = getLatestGateForType(db, project.id, "chapter", chapter.id, CHAPTER_VARIANT_CHOICE_GATE);
      return { rankedVariants, choiceGate };
    });

    return mcpOk({
      chapterId,
      variants: payload.rankedVariants.map((variant) => toJsonValue(variant) as JsonObject),
      choiceGate: payload.choiceGate ? (toJsonValue(payload.choiceGate) as JsonObject) : null
    }, [], payload.choiceGate ? (toJsonValue(payload.choiceGate) as JsonObject) : null);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_VARIANT_RANK_ERROR", err.message || "Unable to rank chapter variants", true);
  }
}

function chapterVariantSelectTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");
    const variantId = getRequiredString(args, "variantId");
    const selectionReason = getOptionalString(args, "selectionReason");
    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      ensureChapterPreProseApproved(db, project.id, chapter.id);
      const variants = ensureExactlyThreeVariants(db, chapter.id);
      const variant = variants.find((entry) => entry.id === variantId);
      if (!variant) throw Object.assign(new Error("Variant not found"), { code: "INVALID_VARIANT_ID" });

      ensureVariantChoiceApprovedForVariant(db, project.id, chapter.id, variantId);

      db.prepare("UPDATE chapter_variants SET selected = 0, status = 'rejected', selection_reason = COALESCE(selection_reason, 'not selected') WHERE chapter_id = ?").run(chapter.id);
      db.prepare("UPDATE chapter_variants SET selected = 1, status = ?, selection_reason = ? WHERE id = ? AND chapter_id = ?")
        .run("selected", selectionReason, variantId, chapter.id);

      const nowValue = now();
      db.prepare(
        "UPDATE chapters SET selected_variant_id = ?, selected_draft_revision_id = NULL, status = ?, updated_at = ? WHERE id = ?",
      ).run(variantId, "variant_selected", nowValue, chapter.id);

      appendGraphLine(projectSlug, "chapter_variants.jsonl", {
        action: "chapter_variant_select",
        chapterId,
        variantId
      });

      const selected = db.prepare("SELECT * FROM chapter_variants WHERE id = ? AND chapter_id = ?").get(variantId, chapter.id) as
        DbChapterVariant;
      return { selected };
    });

    return mcpOk({ chapterId, variantId, variant: toJsonValue(result.selected) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_VARIANT_SELECT_ERROR", err.message || "Unable to select chapter variant", true);
  }
}

function chapterDraftRecordTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");
    const variantId = typeof args.variantId === "string" && args.variantId.trim().length > 0 ? args.variantId : null;
    const draftId = typeof args.draftId === "string" && args.draftId.trim().length > 0 ? args.draftId : crypto.randomUUID();
    const markdownText = typeof args.markdownText === "string" ? args.markdownText : null;
    const markdownPathInput = typeof args.markdownPath === "string" && args.markdownPath.trim().length > 0 ? args.markdownPath : null;
    const draftStage = typeof args.draftStage === "string" && args.draftStage.trim().length > 0 ? args.draftStage : "revision";
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status : "draft";
    const revisionNotes = getOptionalString(args, "revisionNotes");
    const markSelected = getOptionalBoolean(args, "select", true);

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      ensureChapterPreProseApproved(db, project.id, chapter.id);
      if (variantId && chapter.selected_variant_id && variantId !== chapter.selected_variant_id) {
        throw Object.assign(new Error("Drafts can only be recorded for the selected chapter variant"), { code: "INVALID_VARIANT_ID" });
      }
      const selectedVariantId = chapter.selected_variant_id;
      if (!selectedVariantId) {
        throw Object.assign(new Error("No selected variant available for chapter"), { code: "MISSING_SELECTED_VARIANT" });
      }
      const variant = db
        .prepare("SELECT id, variant_type, selected FROM chapter_variants WHERE id = ? AND chapter_id = ?")
        .get(selectedVariantId, chapter.id) as { id: string; variant_type: string; selected: number } | undefined;
      if (!variant) throw Object.assign(new Error("Variant not found"), { code: "INVALID_VARIANT_ID" });
      if (variant.selected !== 1) {
        throw Object.assign(new Error("Only the selected variant may receive drafts"), { code: "INVALID_VARIANT_STATUS" });
      }

      const markdownPath = markdownText !== null
        ? writeProjectFile(
          project.slug,
          join("chapters", chapterId, "revisions", `${variant.variant_type}-${now().replace(/[^0-9A-Za-z_-]/g, "_")}.md`),
          markdownText,
        )
        : (markdownPathInput ? resolveChapterFilePath(project.slug, markdownPathInput) : null);
      if (!markdownPath) {
        throw Object.assign(new Error("markdownText or markdownPath is required"), { code: "INVALID_PARAMS" });
      }

      const conflictingDraft = db.prepare("SELECT chapter_id FROM chapter_draft_revisions WHERE id = ?").get(draftId) as
        | { chapter_id: string }
        | undefined;
      if (conflictingDraft && conflictingDraft.chapter_id !== chapter.id) {
        throw Object.assign(new Error("Draft id already assigned to another chapter"), { code: "INVALID_DRAFT_ID" });
      }

      const existing = db.prepare("SELECT id FROM chapter_draft_revisions WHERE id = ? AND chapter_id = ?").get(draftId, chapter.id) as
        | { id: string }
        | undefined;
      const nowValue = now();
      if (existing) {
        db.prepare(
          `UPDATE chapter_draft_revisions
           SET chapter_id = ?, variant_id = ?, draft_stage = ?, status = ?, markdown_path = ?, revision_notes = ?, is_selected = ?, provenance_json = ?, updated_at = ?
           WHERE id = ? AND chapter_id = ?`,
        ).run(
          chapter.id,
          variant.id,
          draftStage,
          status,
          markdownPath,
          revisionNotes,
          markSelected ? 1 : 0,
          JSON.stringify({
            selectedVariantType: variant.variant_type,
            selected: true,
            source: "mcp"
          }),
          nowValue,
          draftId,
          chapter.id,
        );
      } else {
        db.prepare(
          `INSERT INTO chapter_draft_revisions(id, project_id, chapter_id, variant_id, draft_stage, status, markdown_path, revision_notes, is_selected, provenance_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          draftId,
          project.id,
          chapter.id,
          variant.id,
          draftStage,
          status,
          markdownPath,
          revisionNotes,
          markSelected ? 1 : 0,
          JSON.stringify({ selectedVariantType: variant.variant_type, selected: markSelected, source: "mcp" }),
          nowValue,
          nowValue,
        );
      }

      if (markSelected) {
        db.prepare("UPDATE chapter_draft_revisions SET is_selected = 0 WHERE chapter_id = ? AND id != ?").run(chapter.id, draftId);
        db.prepare("UPDATE chapters SET selected_draft_revision_id = ?, updated_at = ? WHERE id = ?").run(draftId, nowValue, chapter.id);
        for (const gateType of CHAPTER_POST_PROSE_GATES) {
          ensurePendingGate(db, project.id, "chapter", chapter.id, gateType);
        }
        ensurePendingGate(db, project.id, "chapter", chapter.id, CHAPTER_FINAL_APPROVAL_GATE);
      }

      const row = db.prepare(
        "SELECT id, project_id, chapter_id, variant_id, draft_stage, status, markdown_path, revision_notes, is_selected, provenance_json, created_at, updated_at FROM chapter_draft_revisions WHERE id = ? AND chapter_id = ?",
      ).get(draftId, chapter.id) as DbChapterDraftRevision;
      return { draft: row };
    });

    appendGraphLine(projectSlug, "chapter_drafts.jsonl", {
      action: "chapter_draft_record",
      chapterId,
      draftId: result.draft.id
    });

    return mcpOk({
      chapterId,
      draft: toJsonValue(result.draft) as JsonObject
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_DRAFT_RECORD_ERROR", err.message || "Unable to record chapter draft", true);
  }
}

function chapterCompleteMarkTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");
    const completionNotes = getOptionalString(args, "completionNotes");
    const exportPathInput = typeof args.exportPath === "string" && args.exportPath.trim().length > 0 ? args.exportPath : null;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      ensureChapterPostProseApproved(db, project.id, chapter.id);
      const finalGate = ensureFinalHumanApproval(db, project.id, chapter.id);
      const selectedDraft = ensureSelectedDraftRevision(db, chapter);
      const sourcePath = resolveChapterFilePath(project.slug, selectedDraft.markdown_path);
      const outputPath = exportPathInput
        ? resolveChapterFilePath(project.slug, exportPathInput)
        : writeProjectFile(project.slug, join("chapters", chapter.id, "final.md"), readFileSync(sourcePath, "utf8"));

      appendGraphLine(project.slug, "chapters.jsonl", {
        action: "chapter_complete_mark",
        chapterId,
        selectedDraftId: selectedDraft.id,
        finalGate: finalGate.id,
      });

      const nowValue = now();
      db.prepare(
        "UPDATE chapters SET status = ?, approved_by_gate_id = ?, approved_at = ?, final_markdown_path = ?, selected_draft_revision_id = ?, completed_at = ?, completion_notes = ?, updated_at = ? WHERE id = ?",
      ).run(
        "complete",
        finalGate.id,
        nowValue,
        outputPath,
        selectedDraft.id,
        nowValue,
        completionNotes,
        nowValue,
        chapter.id,
      );

      appendProjectMemoryLine(project.slug, "memory.jsonl", {
        action: "chapter_completed",
        chapterId,
        finalGateId: finalGate.id,
        draftRevisionId: selectedDraft.id,
      });

      const updated = db.prepare("SELECT * FROM chapters WHERE id = ?").get(chapter.id) as DbChapter;
      return { chapter: updated };
    });

    return mcpOk({
      chapterId,
      chapter: toJsonValue(result.chapter) as JsonObject
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_COMPLETE_ERROR", err.message || "Unable to mark chapter complete", true);
  }
}

function chapterAuditRunTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "chapter";
    const scopeId = getRequiredString(args, "scopeId");
    const auditType = getRequiredString(args, "auditType");
    const status = typeof args.status === "string" && args.status.trim().length > 0 ? args.status : "running";
    const summaryJson = isObject(args.summary) ? JSON.stringify(toJsonValue(args.summary)) : null;

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      if (scopeType === "chapter") {
        const chapter = getChapterRow(db, project, scopeId);
        ensureSelectedDraftRevision(db, chapter);
      }

      const runId = typeof args.auditRunId === "string" && args.auditRunId.trim().length > 0 ? args.auditRunId : crypto.randomUUID();
      const nowValue = now();
      const existing = db.prepare("SELECT id, project_id FROM audit_runs WHERE id = ?").get(runId) as { id: string; project_id: string } | undefined;
      if (existing && existing.project_id !== project.id) {
        throw Object.assign(new Error("Audit run id belongs to a different project"), { code: "AUDIT_RUN_PROJECT_MISMATCH" });
      }
      const completedAt = status === "completed" ? nowValue : null;
      const provenance = {
        source: "story_os_mcp",
        requester: "chapter_audit_run_tool",
      };
      if (existing) {
        db.prepare("UPDATE audit_runs SET scope_type = ?, scope_id = ?, audit_type = ?, status = ?, summary_json = ?, provenance_json = ?, completed_by = ?, completed_at = ? WHERE id = ?")
          .run(scopeType, scopeId, auditType, status, summaryJson, JSON.stringify(provenance), "mcp", completedAt, runId);
      } else {
        db.prepare(
          `INSERT INTO audit_runs(id, project_id, scope_type, scope_id, audit_type, status, summary_json, artifact_type, artifact_id, artifact_path, provenance_json, completed_by, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          runId,
          project.id,
          scopeType,
          scopeId,
          auditType,
          status,
          summaryJson,
          scopeType,
          scopeId,
          summaryJson ? "summary" : null,
          JSON.stringify(provenance),
          "mcp",
          nowValue,
          completedAt,
        );
      }

      const run = db.prepare("SELECT * FROM audit_runs WHERE id = ?").get(runId) as DbAuditRun;
      const findings = db.prepare("SELECT * FROM audit_findings WHERE audit_run_id = ? ORDER BY resolved ASC").all(runId) as DbAuditFinding[];
      return { run, findings };
    });

    return mcpOk({ auditRun: toJsonValue(result.run) as JsonObject, findings: result.findings.map((finding) => toJsonValue(finding) as JsonObject) });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_AUDIT_RUN_ERROR", err.message || "Unable to run audit", true);
  }
}

function chapterAuditRecordFindingTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const auditRunId = getRequiredString(args, "auditRunId");
    const category = getRequiredString(args, "category");
    const severity = getRequiredString(args, "severity");
    const quoteOrLocation = getRequiredString(args, "quoteOrLocation");
    const whyFlagged = getRequiredString(args, "whyFlagged");
    const fixStrategy = getRequiredString(args, "fixStrategy");

    const findingKey = getOptionalString(args, "findingKey");
    const occurrenceCount = typeof args.occurrenceCount === "number" && Number.isFinite(args.occurrenceCount) ? Math.max(1, Math.floor(args.occurrenceCount)) : 1;
    const evidenceJson = isObject(args.evidence) ? JSON.stringify(toJsonValue(args.evidence)) : null;

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const run = db.prepare("SELECT * FROM audit_runs WHERE id = ? AND project_id = ?").get(auditRunId, project.id) as
        DbAuditRun | undefined;
      if (!run) throw Object.assign(new Error(`Audit run not found: ${auditRunId}`), { code: "AUDIT_RUN_NOT_FOUND" });
      const findingId = typeof args.findingId === "string" && args.findingId.trim().length > 0 ? args.findingId : crypto.randomUUID();
      db.prepare(
        `INSERT INTO audit_findings(id, audit_run_id, category, severity, quote_or_location, why_flagged, fix_strategy, finding_key, evidence_json, occurrence_count, resolved, resolved_at, resolution_notes, found_by, found_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'mcp', ?)`,
      ).run(
        findingId,
        run.id,
        category,
        severity,
        quoteOrLocation,
        whyFlagged,
        fixStrategy,
        findingKey,
        evidenceJson,
        occurrenceCount,
        null,
        now(),
      );
      const finding = db.prepare("SELECT * FROM audit_findings WHERE id = ?").get(findingId) as DbAuditFinding;
      return finding;
    });

    return mcpOk({ finding: toJsonValue(payload) as JsonObject });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "AUDIT_RECORD_FINDING_ERROR", err.message || "Unable to record finding", true);
  }
}

function chapterAuditGetReportTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const auditRunId = typeof args.auditRunId === "string" && args.auditRunId.trim().length > 0 ? args.auditRunId : null;
    const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "chapter";
    const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0 ? args.scopeId : null;

    const report = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      let run: DbAuditRun | null = null;
      if (auditRunId) {
        run = db.prepare("SELECT * FROM audit_runs WHERE id = ? AND project_id = ?").get(auditRunId, project.id) as DbAuditRun | undefined ?? null;
      } else if (scopeId) {
        run = db.prepare(
          "SELECT * FROM audit_runs WHERE project_id = ? AND scope_type = ? AND scope_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(project.id, scopeType, scopeId) as DbAuditRun | undefined ?? null;
      } else {
        run = db.prepare("SELECT * FROM audit_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT 1").get(project.id) as DbAuditRun | undefined ?? null;
      }

      if (!run) {
        throw Object.assign(new Error("Audit run not found"), { code: "AUDIT_RUN_NOT_FOUND" });
      }
      const findings = db.prepare("SELECT * FROM audit_findings WHERE audit_run_id = ? ORDER BY found_at DESC").all(run.id) as DbAuditFinding[];
      return { run, findings };
    });

    return mcpOk({
      run: toJsonValue(report.run) as JsonObject,
      findings: report.findings.map((finding) => toJsonValue(finding) as JsonObject)
    });
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_AUDIT_REPORT_ERROR", err.message || "Unable to get audit report", true);
  }
}

function chapterAuditExportOccurrencesTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const scopeType = typeof args.scopeType === "string" && args.scopeType.trim().length > 0 ? args.scopeType : "chapter";
    const scopeId = typeof args.scopeId === "string" && args.scopeId.trim().length > 0 ? args.scopeId : null;

    const inventory = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const runQuery = scopeId
        ? "SELECT * FROM audit_runs WHERE project_id = ? AND scope_type = ? AND scope_id = ? ORDER BY created_at DESC"
        : "SELECT * FROM audit_runs WHERE project_id = ? ORDER BY created_at DESC";
      const runRows = scopeId
        ? db.prepare(runQuery).all(project.id, scopeType, scopeId) as DbAuditRun[]
        : db.prepare(runQuery).all(project.id) as DbAuditRun[];
      const runIds = runRows.map((run) => run.id);
      if (runIds.length === 0) return { occurrences: [], totalFindings: 0, byCategory: {} as Record<string, number> };

      const placeholders = runIds.map(() => "?").join(",");
      const findings = db.prepare(
        `SELECT category, severity, occurrence_count, quote_or_location, finding_key, evidence_json FROM audit_findings WHERE audit_run_id IN (${placeholders}) ORDER BY category, severity`,
      ).all(...runIds) as Array<{ category: string; severity: string; occurrence_count: number; quote_or_location: string; finding_key: string | null; evidence_json: string | null }>;

      const byCategory: Record<string, { count: number; examples: string[] }> = {};
      let total = 0;
      for (const finding of findings) {
        const count = Number.isFinite(finding.occurrence_count) ? finding.occurrence_count : 1;
        total += count;
        const existing = byCategory[finding.category] ?? { count: 0, examples: [] };
        existing.count += count;
        if (existing.examples.length < 3) {
          existing.examples.push(finding.quote_or_location);
        }
        byCategory[finding.category] = existing;
      }
      return { findings, totalFindings: total, byCategory };
    });

    return mcpOk(inventory);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "AUDIT_INVENTORY_ERROR", err.message || "Unable to export occurrence inventory", true);
  }
}

function chapterExportMarkdownTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);
    const chapterId = getRequiredString(args, "chapterId");
    const outputPathInput = typeof args.outputPath === "string" && args.outputPath.trim().length > 0 ? args.outputPath : null;
    const force = getOptionalBoolean(args, "force", true);

    const payload = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const chapter = getChapterRow(db, project, chapterId);
      ensureChapterPostProseApproved(db, project.id, chapter.id);
      const finalGate = ensureFinalHumanApproval(db, project.id, chapter.id);
      const selectedDraft = ensureSelectedDraftRevision(db, chapter);
      const sourcePath = resolveChapterFilePath(project.slug, selectedDraft.markdown_path);
      const targetPath = outputPathInput
        ? resolveChapterFilePath(project.slug, outputPathInput)
        : resolveChapterFilePath(project.slug, join("chapters", chapterId, "final.md"));

      if (!force && existsSync(targetPath)) {
        throw Object.assign(new Error(`Output path already exists: ${targetPath}`), { code: "FILE_EXISTS" });
      }

      const text = readFileSync(sourcePath, "utf8");
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, text, "utf8");

      db.prepare(
        "UPDATE chapters SET final_markdown_path = ?, updated_at = ? WHERE id = ?",
      ).run(targetPath, now(), chapter.id);

      appendGraphLine(project.slug, "chapter_exports.jsonl", {
        action: "chapter_markdown_exported",
        chapterId,
        finalGate: finalGate.id,
        sourcePath,
        targetPath
      });

      return { sourcePath, targetPath, status: "exported" };
    });

    return mcpOk(payload);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "CHAPTER_EXPORT_ERROR", err.message || "Unable to export chapter markdown", true);
  }
}

function getOptionalString(data: unknown, name: string): string | null {
  if (!isObject(data)) return null;
  const value = data[name];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function exportMermaidDiagramsTool(args: JsonObject): McpToolResult {
  try {
    const projectSlug = validateSlug(args.projectSlug);

    const result = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      enforcePriorGateApproved(db, project.id, "project", project.id, "mermaid_export");
      const gate = ensurePendingGate(db, project.id, "project", project.id, "mermaid_export");

      const exports: JsonObject[] = [];

      const allArcs = db.prepare("SELECT id FROM arcs WHERE project_id = ?").all(project.id) as Array<{ id: string }>;
      for (const arc of allArcs) {
        const beats = db.prepare("SELECT beat_name, beat_order, summary FROM seven_point_beats WHERE arc_id = ? ORDER BY beat_order ASC").all(arc.id) as Array<
          DbBeat
        >;
        const lines: string[] = ["flowchart TD"];
        if (beats.length === 0) {
          lines.push(`A(["arc ${formatPathSafe(arc.id)}"] )`);
        }
        const nodes = beats.map((beat, index) => {
          const node = `B${index + 1}`;
          const summary = beat.summary ? `\\n${escapeMermaidLabel(beat.summary)}` : "";
          lines.push(`${node}["${escapeMermaidLabel(beat.beat_name)}${summary}"]`);
          return node;
        });
        for (let i = 0; i < nodes.length - 1; i += 1) {
          lines.push(`${nodes[i]} --> ${nodes[i + 1]}`);
        }
        const mermaidText = `${lines.join("\n")}\n`;
        const filePath = writeMermaidDiagram(projectSlug, `arc-${formatPathSafe(arc.id)}.mmd`, mermaidText);
        const exportId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO mermaid_exports(id, project_id, scope_type, scope_id, diagram_kind, artifact_type, artifact_id, file_path, mermaid_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          exportId,
          project.id,
          "project",
          project.id,
          "arc",
          "arc",
          arc.id,
          filePath,
          mermaidText,
          now(),
        );
        exports.push({ diagramKind: "arc", arcId: arc.id, filePath, mermaid: mermaidText });
      }

      const entities = db.prepare("SELECT id, type, name, status FROM entities WHERE project_id = ?").all(project.id) as Array<
        DbEntity
      >;
      const relations = db
        .prepare("SELECT source_entity_id, target_entity_id, relationship_type FROM relationships WHERE project_id = ?")
        .all(project.id) as Array<{ source_entity_id: string; target_entity_id: string; relationship_type: string }>;
      {
        const idToNode = new Map<string, string>();
        const lines: string[] = ["graph LR"];
        entities.forEach((entity, i) => {
          const node = `N${i + 1}`;
          idToNode.set(entity.id, node);
          lines.push(`${node}["${escapeMermaidLabel(entity.type)}:${escapeMermaidLabel(entity.name)}"]`);
        });
        for (const relation of relations) {
          const from = idToNode.get(relation.source_entity_id);
          const to = idToNode.get(relation.target_entity_id);
          if (!from || !to) continue;
          const label = relation.relationship_type ? `|${escapeMermaidLabel(relation.relationship_type)}|` : "";
          lines.push(`${from} -->${label} ${to}`);
        }
        const mermaidText = `${lines.join("\n")}\n`;
        const filePath = writeMermaidDiagram(projectSlug, "knowledge-graph.mmd", mermaidText);
        const exportId = crypto.randomUUID();
        db.prepare(
          "INSERT INTO mermaid_exports(id, project_id, scope_type, scope_id, diagram_kind, artifact_type, artifact_id, file_path, mermaid_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          exportId,
          project.id,
          "project",
          project.id,
          "knowledge_graph",
          "knowledge_graph",
          null,
          filePath,
          mermaidText,
          now(),
        );
        exports.push({ diagramKind: "knowledge_graph", filePath, mermaid: mermaidText });
      }

      const events = db.prepare("SELECT id, title, summary FROM events WHERE project_id = ? ORDER BY title ASC").all(project.id) as Array<
        DbEvent
      >;
      const evMap = new Map<string, string>();
      const evNodes = db.prepare("SELECT from_event_id, to_event_id, edge_type, rationale FROM event_edges WHERE project_id = ?").all(project.id) as
        Array<{ from_event_id: string; to_event_id: string; edge_type: string; rationale: string | null }>;
      const lines: string[] = ["flowchart LR"];
      for (let i = 0; i < events.length; i += 1) {
        const node = `E${i + 1}`;
        evMap.set(events[i]!.id, node);
        const summary = events[i]!.summary ? `\\n${escapeMermaidLabel(events[i]!.summary)}` : "";
        lines.push(`${node}["${escapeMermaidLabel(events[i]!.title)}${summary}"]`);
      }
      for (const edge of evNodes) {
        const from = evMap.get(edge.from_event_id);
        const to = evMap.get(edge.to_event_id);
        if (!from || !to) continue;
        const label = edge.edge_type ? `|${escapeMermaidLabel(edge.edge_type)}|` : "";
        lines.push(`${from} -->${label} ${to}`);
      }
      const eventMermaid = `${lines.join("\n")}\n`;
      const eventFile = writeMermaidDiagram(projectSlug, "event-graph.mmd", eventMermaid);
      const eventExportId = crypto.randomUUID();
      db.prepare(
        "INSERT INTO mermaid_exports(id, project_id, scope_type, scope_id, diagram_kind, artifact_type, artifact_id, file_path, mermaid_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        eventExportId,
        project.id,
        "project",
        project.id,
        "event_graph",
        "event_graph",
        null,
        eventFile,
        eventMermaid,
        now(),
      );
      exports.push({ diagramKind: "event_graph", filePath: eventFile, mermaid: eventMermaid });

      return { gate, exports };
    });

    return mcpOk({ count: result.exports.length, exports: result.exports }, [], toJsonValue(result.gate) as JsonObject);
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return mcpError(err.code || "MERMAID_BULK_EXPORT_ERROR", err.message || "Unable to export mermaid artifacts", true);
  }
}

const mcpToolHandlers: Record<string, (args: JsonObject) => McpToolResult> = {
  story_project_create: createOrUpdateProject,
  story_project_status: (args) => projectStatusData(typeof args.projectSlug === "string" ? args.projectSlug : undefined) as McpToolResult,
  story_canon_upsert_fact: upsertCanonFact,
  story_canon_search: searchCanonFacts,
  story_kg_upsert_entity: upsertKgEntity,
  story_kg_upsert_relationship: upsertKgRelationship,
  story_kg_export_jsonl: exportKgJsonl,
  story_kg_upsert_event: eventUpsertTool,
  story_kg_export_mermaid: kgMermaidExportTool,
  story_event_graph_create: eventGraphCreateTool,
  story_event_graph_upsert_node: eventGraphNodeTool,
  story_event_graph_upsert_edge: eventGraphEdgeTool,
  story_event_graph_validate_causality: validateCausalityTool,
  story_event_graph_export_mermaid: eventGraphExportMermaidTool,
  story_export_mermaid_diagrams: exportMermaidDiagramsTool,
  story_gate_create: createGateTool,
  story_gate_status: gateStatusTool,
  story_gate_record_human_decision: recordGateDecisionTool,
  story_gate_blockers: gateBlockersTool,
  story_chapter_outline_record: chapterOutlineRecordTool,
  story_chapter_variant_create: chapterVariantCreateTool,
  story_chapter_variant_list: chapterVariantListTool,
  story_chapter_variant_rank: chapterVariantRankTool,
  story_chapter_variant_select: chapterVariantSelectTool,
  story_chapter_draft_record: chapterDraftRecordTool,
  story_chapter_complete_mark: chapterCompleteMarkTool,
  story_audit_run: chapterAuditRunTool,
  story_audit_get_report: chapterAuditGetReportTool,
  story_audit_record_finding: chapterAuditRecordFindingTool,
  story_audit_export_occurrence_inventory: chapterAuditExportOccurrencesTool,
  story_export_markdown_chapter: chapterExportMarkdownTool,
  story_premise_record: (args) => recordPlanningTool(args, "premise"),
  story_worldbuilding_record: (args) => recordPlanningTool(args, "worldbuilding"),
  story_series_bible_record: (args) => recordPlanningTool(args, "series_bible"),
  story_pov_plan_record: (args) => recordPlanningTool(args, "story_infrastructure"),
  story_beatmap_record: beatmapRecordTool,
  story_arc_create: arcCreateTool,
  story_arc_get: arcGetTool,
  story_arc_update: arcUpdateTool,
  story_arc_validate_seven_point: arcValidateSevenPointTool,
  story_arc_list_by_scope: arcListByScopeTool,
  story_arc_export_mermaid: arcExportMermaidTool,
  story_serial_season_plan: serialSeasonPlanTool,
  story_serial_arc_plan: serialArcPlanTool,
  story_serial_next_episode: serialNextEpisodeTool,
  story_serial_promise_upsert: serialPromiseUpsertTool,
  story_serial_promise_list: serialPromiseListTool,
  story_serial_recap_generate: serialRecapGenerateTool,
  story_serial_season_report: serialSeasonReportTool
};

function rpcResponse(id: unknown, result: unknown) {
  if (id === undefined) return null;
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: id === undefined ? null : id,
    error: {
      code,
      message
    }
  };
}

function negotiatedProtocolVersion(params: JsonObject): string {
  const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  if (/^20\d{2}-\d{2}-\d{2}$/.test(requested)) return requested;
  return DEFAULT_PROTOCOL_VERSION;
}

function callToolResult(payload: McpToolResult): McpCallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(payload.ok ? {} : { isError: true })
  };
}

async function handleMcpRequest(body: unknown): Promise<unknown> {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, -32600, "Invalid JSON-RPC 2.0 request");
    const responses: Array<Record<string, JsonValue>> = [];
    for (const item of body) {
      const response = await handleMcpRequest(item);
      if (response !== null) responses.push(response as Record<string, JsonValue>);
    }
    return responses.length > 0 ? responses : null;
  }

  if (!isObject(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(null, -32600, "Invalid JSON-RPC 2.0 request");
  }

  const id = Object.prototype.hasOwnProperty.call(body, "id") ? body.id : undefined;
  const method = body.method;
  const params = isObject(body.params) ? body.params : {};

  if (method === "initialize") {
    return rpcResponse(id, {
      protocolVersion: negotiatedProtocolVersion(params),
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {}
      },
      serverInfo: { name: "story-os-mcp", version: MCP_SERVER_VERSION },
      instructions: "Story OS MCP Phase 4"
    });
  }

  if (method === "notifications/initialized") {
    return rpcResponse(id, { acknowledged: true });
  }

  if (method === "ping") {
    return rpcResponse(id, { ok: true, pong: true });
  }

  if (method === "tools/list") {
    return rpcResponse(id, { tools: MCP_TOOLS });
  }

  if (method === "resources/list") {
    return rpcResponse(id, { resources: [] });
  }

  if (method === "prompts/list") {
    return rpcResponse(id, { prompts: [] });
  }

  if (method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const toolArgs = isObject(params.arguments) ? params.arguments : params;
    const handler = mcpToolHandlers[toolName];
    if (!handler) {
      return id === undefined ? null : rpcError(id, -32601, `Unknown tool: ${toolName}`);
    }
    try {
      const result = handler(toolArgs as JsonObject);
      return rpcResponse(id, callToolResult(result));
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return rpcError(id, -32603, err.message || "Tool handler failed");
    }
  }

  return id === undefined ? null : rpcError(id, -32601, `Method not found: ${method}`);
}

function mapToolFromPlanningPath(pathname: string): string {
  const match = pathname.match(/^\/api\/plan\/(.*)$/i);
  if (!match) return "";
  const tail = match[1] ?? "";
  const segment = tail.split("/").filter(Boolean).join("_");
  if (!segment) return "";
  return segment.startsWith("story_") ? segment : `story_${segment.replace(/-/g, "_")}`;
}

function mapToolFromChapterPath(pathname: string): string {
  const normalized = pathname.toLowerCase();
  if (normalized === "/api/chapter/outline") return "story_chapter_outline_record";
  if (normalized === "/api/chapter/variant/create") return "story_chapter_variant_create";
  if (normalized === "/api/chapter/variant/list") return "story_chapter_variant_list";
  if (normalized === "/api/chapter/variant/rank") return "story_chapter_variant_rank";
  if (normalized === "/api/chapter/variant/select") return "story_chapter_variant_select";
  if (normalized === "/api/chapter/draft") return "story_chapter_draft_record";
  if (normalized === "/api/chapter/complete") return "story_chapter_complete_mark";
  if (normalized === "/api/chapter/export") return "story_export_markdown_chapter";
  return "";
}

function mapToolFromAuditPath(pathname: string): string {
  const normalized = pathname.toLowerCase();
  if (normalized === "/api/audit/run") return "story_audit_run";
  if (normalized === "/api/audit/report") return "story_audit_get_report";
  if (normalized === "/api/audit/finding") return "story_audit_record_finding";
  if (normalized === "/api/audit/occurrences") return "story_audit_export_occurrence_inventory";
  return "";
}

function mapToolFromSerialPath(pathname: string): string {
  const normalized = pathname.toLowerCase();
  if (normalized === "/api/serial/season/plan") return "story_serial_season_plan";
  if (normalized === "/api/serial/arc/plan") return "story_serial_arc_plan";
  if (normalized === "/api/serial/next-episode") return "story_serial_next_episode";
  if (normalized === "/api/serial/promise/upsert") return "story_serial_promise_upsert";
  if (normalized === "/api/serial/promise/list") return "story_serial_promise_list";
  if (normalized === "/api/serial/recap") return "story_serial_recap_generate";
  if (normalized === "/api/serial/season/report") return "story_serial_season_report";
  return "";
}

async function handleProjectStatusApi(req: Request, defaultProjectSlug?: string): Promise<Response> {
  const body = await readJson(req);
  const query = new URL(req.url).searchParams.get("projectSlug") || "";
  const projectSlug = typeof body.projectSlug === "string" ? body.projectSlug : query || defaultProjectSlug;
  const summary = projectStatusData(projectSlug);

  if (!summary.ok) {
    const status = summary.code === "INVALID_PROJECT_SLUG" ? 400 : 500;
    return json(summary, status);
  }

  return json(summary);
}

function runToolApi(toolName: string, req: Request): Promise<Response> {
  return (async () => {
    const body = await readJson(req);
    const handler = mcpToolHandlers[toolName];
    if (!handler) {
      return json(mcpError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`, true), 404);
    }
    try {
      const result = handler(body);
      const status = result.ok ? 200 : statusForErrorCode(result.code);
      return json(result, status);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return json(
        mcpError(err.code || "HANDLER_ERROR", err.message || "Tool handler failed", true),
        statusForErrorCode(err.code)
      );
    }
  })();
}

async function handleSessionStopApi(req: Request): Promise<Response> {
  const body = await readJson(req);
  return json({ ok: true, stopped: true, projectSlug: typeof body.projectSlug === "string" ? body.projectSlug : null });
}

async function handleSessionStartApi(req: Request): Promise<Response> {
  const body = await readJson(req);
  return json({ ok: true, started: true, projectSlug: typeof body.projectSlug === "string" ? body.projectSlug : null });
}

function resolveRequestProjectSlug(body: JsonObject): string | null {
  const explicitSlug = typeof body.projectSlug === "string" && body.projectSlug.trim().length > 0
    ? validateSlug(body.projectSlug)
    : null;
  if (explicitSlug) return explicitSlug;
  return resolveProjectSlugFromCwd(body.cwd);
}

async function handleContextRelevantApi(req: Request): Promise<Response> {
  const body = await readJson(req);
  try {
    const projectSlug = resolveRequestProjectSlug(body);
    if (!projectSlug) {
      const summary = projectStatusData();
      return json(mcpOk({
        projectSlug: null,
        projects: summary.ok ? summary.data.projects : [],
        pendingGates: summary.ok ? summary.data.pendingGates : []
      }));
    }

    const state = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      return collectSerialHookState(db, project);
    });
    return json(mcpOk(state));
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return json(mcpError(err.code || "CONTEXT_RELEVANT_ERROR", err.message || "Unable to collect relevant Story OS context", true), 500);
  }
}

async function handleSessionCompactSummaryApi(req: Request): Promise<Response> {
  const body = await readJson(req);
  try {
    const projectSlug = resolveRequestProjectSlug(body);
    if (!projectSlug) {
      const summary = projectStatusData();
      return json(mcpOk({
        projectSlug: null,
        projects: summary.ok ? summary.data.projects : [],
        pendingGates: summary.ok ? summary.data.pendingGates : []
      }));
    }

    const state = withProjectDb(projectSlug, (db) => {
      const project = getProjectRowOrError(db, projectSlug);
      const hookState = collectSerialHookState(db, project);
      return {
        project: hookState.project,
        serialStatus: hookState.serialStatus,
        pendingGates: clampBoundedStateRows(Array.isArray(hookState.pendingGates) ? hookState.pendingGates : [], 30),
        openPromises: clampBoundedStateRows(Array.isArray(hookState.openPromises) ? hookState.openPromises : [], 30),
        recentEpisodes: clampBoundedStateRows(Array.isArray(hookState.recentEpisodes) ? hookState.recentEpisodes : [], 20),
        noDrafting: true
      };
    });
    return json(mcpOk(state));
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return json(mcpError(err.code || "COMPACT_SUMMARY_ERROR", err.message || "Unable to collect compact summary", true), 500);
  }
}

async function handleToolResultApi(req: Request): Promise<Response> {
  const body = await readJson(req);
  try {
    const projectSlug = resolveHookProjectSlug(body);
    if (!projectSlug) {
      return json(mcpOk({
        acknowledged: true,
        toolName: typeof body.toolName === "string" ? body.toolName : null,
        isError: body.isError === true,
        persisted: false,
        reason: "NO_ACTIVE_PROJECT",
        noDrafting: true
      }));
    }

    const stored = recordToolResultArtifact(projectSlug, body);
    return json(mcpOk({
      acknowledged: true,
      toolName: typeof body.toolName === "string" ? body.toolName : null,
      isError: body.isError === true,
      noDrafting: true,
      ...stored
    }));
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return json(mcpError(err.code || "TOOL_RESULT_RECORD_ERROR", err.message || "Unable to record tool result", true), 500);
  }
}

async function handleTurnEndApi(req: Request): Promise<Response> {
  const body = await readJson(req);
  try {
    const projectSlug = resolveHookProjectSlug(body);
    const createdGates = projectSlug ? createTurnEndChapterGates(projectSlug, body) : [];
    return json(mcpOk({
      acknowledged: true,
      projectSlug,
      createdGates,
      createdGateCount: createdGates.length,
      noDrafting: true
    }));
  } catch (error) {
    const err = error as { code?: string; message?: string };
    return json(mcpError(err.code || "TURN_END_ERROR", err.message || "Unable to process turn end", true), 500);
  }
}

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const externalMutationRejection = rejectUnsafeExternalMutation(req, url);
    if (externalMutationRejection) return externalMutationRejection;

    try {
    if (url.pathname === "/health") {
      return json({
        ok: true,
        service: "story-os-mcp",
        time: now(),
        version: MCP_SERVER_VERSION,
        schemaVersion: MCP_SCHEMA_VERSION,
        workspaceId,
        workspaceRoot,
        qdrantUrlConfigured: qdrantUrl.length > 0,
        authRequiredForExternalMutation: true,
        gateDecisionNonceRequired: gateDecisionSecret.length > 0
      });
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return json(rpcError(null, -32700, "Parse error"));
      }
      const response = await handleMcpRequest(body);
      if (response === null) return new Response("", { status: 204 });
      return json(response);
    }

    if (url.pathname === "/api/project/create" && req.method === "POST") {
      const body = await readJson(req);
      const result = createOrUpdateProject(body);
      return json(result, result.ok ? 200 : statusForErrorCode(result.code));
    }

    if (url.pathname === "/api/project/status") {
      return handleProjectStatusApi(req);
    }

    if (url.pathname === "/api/project/create/status") {
      return handleProjectStatusApi(req);
    }

    if (url.pathname === "/api/gate/pending") {
      const body = await readJson(req);
      const projectSlug = typeof body.projectSlug === "string"
        ? body.projectSlug
        : new URL(req.url).searchParams.get("projectSlug") || undefined;
      try {
        const gate = collectPendingGate(projectSlug ? validateSlug(projectSlug) : undefined);
        return json(mcpOk({ gate }));
      } catch (error) {
        const err = error as { code?: string; message?: string };
        return json(mcpError(err.code || "INVALID_PARAMS", err.message || "Unable to read pending gate", true), 400);
      }
    }

    if (url.pathname === "/api/gate/decision" && req.method === "POST") {
      return runToolApi("story_gate_record_human_decision", req);
    }

    if (url.pathname === "/api/gate/blockers" && req.method === "POST") {
      return runToolApi("story_gate_blockers", req);
    }

    if (url.pathname.startsWith("/api/chapter/")) {
      if (req.method !== "POST") {
        return json({ ok: false, error: "Method Not Allowed" }, 405);
      }
      const toolName = mapToolFromChapterPath(url.pathname);
      if (!toolName) return json({ ok: false, error: "Unknown chapter endpoint" }, 404);
      return runToolApi(toolName, req);
    }

    if (url.pathname.startsWith("/api/audit/")) {
      if (req.method !== "POST") {
        return json({ ok: false, error: "Method Not Allowed" }, 405);
      }
      const toolName = mapToolFromAuditPath(url.pathname);
      if (!toolName) return json({ ok: false, error: "Unknown audit endpoint" }, 404);
      return runToolApi(toolName, req);
    }

    if (url.pathname.startsWith("/api/serial/")) {
      if (req.method !== "POST") {
        return json({ ok: false, error: "Method Not Allowed" }, 405);
      }
      const toolName = mapToolFromSerialPath(url.pathname);
      if (!toolName) return json({ ok: false, error: "Unknown serial endpoint" }, 404);
      return runToolApi(toolName, req);
    }

    if (url.pathname === "/api/context/relevant") {
      return handleContextRelevantApi(req);
    }

    if (url.pathname === "/api/session/compact-summary") {
      return handleSessionCompactSummaryApi(req);
    }

    if (url.pathname === "/api/tool/result") {
      return handleToolResultApi(req);
    }

    if (url.pathname === "/api/turn/end") {
      return handleTurnEndApi(req);
    }

    if (url.pathname === "/api/session/stop") {
      return handleSessionStopApi(req);
    }

    if (url.pathname === "/api/session/start") {
      return handleSessionStartApi(req);
    }

    if (url.pathname.startsWith("/api/plan/")) {
      const toolName = mapToolFromPlanningPath(url.pathname);
      return runToolApi(toolName, req);
    }

    if (url.pathname === "/api/gate/status" && req.method === "POST") {
      return runToolApi("story_gate_status", req);
    }

    return json({ ok: false, error: "not found", path: url.pathname }, 404);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      return json(
        mcpError(err.code || "REQUEST_ERROR", err.message || "Request failed", true),
        statusForErrorCode(err.code)
      );
    }
  }
});

mkdirSync(storiesRoot, { recursive: true });
console.log(`Story OS MCP v${MCP_SERVER_VERSION} listening on http://${host}:${server.port}`);
