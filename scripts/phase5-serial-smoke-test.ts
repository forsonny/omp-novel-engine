import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { storyOsAuthHeaders, storyOsBaseUrl, withGateDecisionConfirmation } from "./story-os-env";

type Check = { label: string; ok: boolean; details?: string };
type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

const API_ENDPOINT = storyOsBaseUrl();
const MCP_ENDPOINT = `${API_ENDPOINT}/mcp`;
const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const PROJECT_SLUG = `phase5-serial-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PROJECT_DIR = join(WORKSPACE_ROOT, "stories", PROJECT_SLUG);
const PROJECT_DB = join(PROJECT_DIR, "canon", "canon.db");
const PROJECT_GRAPH_DIR = join(PROJECT_DIR, "canon", "graph");

const checks: Array<Check> = [];
const addCheck = (label: string, ok: boolean, details = "") => checks.push({ label, ok, details });

const requiredTools = [
  "story_serial_season_plan",
  "story_serial_arc_plan",
  "story_serial_next_episode",
  "story_serial_promise_upsert",
  "story_serial_promise_list",
  "story_serial_recap_generate",
  "story_serial_season_report",
];
const PRE_PROSE_GATES = [
  "structure_judge",
  "canon_continuity_judge",
  "character_genre_judge",
  "pre_prose_human_approval",
] as const;
const CHAPTER_VARIANTS = ["canon-tight", "character-heavy", "plot-accelerated"] as const;
const REQUIRED_BEAT_NAMES = [
  "Hook",
  "First Plot Point",
  "First Pinch",
  "Midpoint",
  "Second Pinch",
  "Second Plot Point",
  "Resolution",
];

const toObject = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {});
const toArray = (value: unknown): JsonArray => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
const extractId = (value: unknown, keys: string[] = ["id"]): string => {
  const direct = asString(value);
  if (direct.length > 0) return direct;

  const obj = toObject(value);
  if (obj.id !== undefined) return asString(obj.id);
  for (const key of keys) {
    const candidate = obj[key];
    const candidateString = asString(candidate);
    if (candidateString.length > 0) return candidateString;
  }
  return "";
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toLocalWorkspacePath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/workspace/")) {
    return join(WORKSPACE_ROOT, normalized.slice("/workspace/".length));
  }
  if (normalized.startsWith("/")) {
    return filePath;
  }
  return filePath;
};

const listJsonl = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((entry) => entry.endsWith(".jsonl"));
};

const readJsonl = (filePath: string): JsonObject[] => {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as JsonObject;
      } catch {
        return null as unknown as JsonObject;
      }
    })
    .filter((entry): entry is JsonObject => entry !== null);
};

const normalizeProjectPath = (candidate: string): string => {
  const local = toLocalWorkspacePath(candidate);
  if (existsSync(local)) return local;
  return join(PROJECT_DIR, local);
};

const isPathSafeUnderProject = (candidate: string): boolean => {
  if (!candidate) return false;
  const projectRoot = resolve(PROJECT_DIR);
  const normalized = normalizeProjectPath(candidate);
  const absolute = resolve(normalized);
  const rel = relative(projectRoot, absolute).replace(/\\/g, "/");
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("../"));
};

const collectPaths = (value: unknown, depth = 0): string[] => {
  if (depth > 3) return [];
  if (!value || typeof value !== "object") return [];
  const values = new Set<string>();

  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) {
      if (typeof entry === "string") {
        values.add(entry);
      } else {
        collectPaths(entry, depth + 1).forEach((entryPath) => values.add(entryPath));
      }
    }
    return [...values];
  }

  const record = value as JsonObject;
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string" && typeof key === "string" && /path|file|markdown|recap|report/i.test(key)) {
      values.add(entry);
    } else if (entry && typeof entry === "object") {
      collectPaths(entry, depth + 1).forEach((entryPath) => values.add(entryPath));
    }
  }

  return [...values];
};

const collectText = (value: unknown, depth = 0): string[] => {
  if (depth > 4) return [];
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry, depth + 1));
  }
  if (typeof value !== "object") return [];
  const record = value as JsonObject;
  return Object.entries(record).flatMap(([key, entry]) => {
    if (typeof entry === "string" && (key === "text" || key === "markdown" || key === "content" || key === "summary" || key === "recap")) {
      return [entry];
    }
    if (entry && typeof entry === "object") {
      return collectText(entry, depth + 1);
    }
    return [];
  });
};

const getPayloadData = (payload: JsonObject): JsonObject => {
  if ("data" in payload) {
    return toObject(payload.data);
  }
  return payload;
};

const getProjectStatusData = (result: JsonObject): JsonObject => {
  const data = getPayloadData(result);
  const projects = toArray(data.projects);
  return toObject(projects[0]);
};

const getSerialStatus = (result: JsonObject): JsonObject => {
  const project = getProjectStatusData(result);
  return toObject(project.serialStatus);
};

const getWorkflow = (result: JsonObject): JsonObject => {
  const project = getProjectStatusData(result);
  return toObject(project.workflow);
};

const getGateRows = (result: JsonObject): JsonObject[] => {
  const data = getPayloadData(result);
  return toArray(data.gates).map((entry) => toObject(entry));
};

const getGate = (gates: JsonObject[], gateType: string) => gates.find((entry) =>
  asString(entry.gateType || entry.gate_type) === gateType,
);

const toNumber = (payload: JsonObject, keys: string[]): number => {
  const data = getPayloadData(payload);
  for (const key of keys) {
    const value = asNumber((data as Record<string, unknown>)[key]);
    if (Number.isFinite(value)) return value;
  }
  return Number.NaN;
};

const pickRecapText = (payload: JsonObject): string => {
  const data = getPayloadData(payload);
  const fields = ["text", "markdown", "markdownText", "content", "summary", "recap"];
  for (const field of fields) {
    const text = asString((data as Record<string, unknown>)[field]);
    if (text.length > 0) return text;
  }

  const extracted = collectText(data);
  const byText = extracted.filter((entry) => entry.includes("PROMISE") || entry.includes("Episode") || entry.includes("Season"));
  if (byText.length > 0) return byText.join("\n\n");

  const paths = collectPaths(data);
  for (const candidate of paths) {
    const normalized = normalizeProjectPath(candidate);
    if (existsSync(normalized)) {
      try {
        const fileText = readFileSync(normalized, "utf8");
        if (fileText.length > 0) return fileText;
      } catch {
      }
    }
  }

  return "";
};

const pickSafePath = (payload: JsonObject): string => {
  const data = getPayloadData(payload);
  const keys = ["path", "filePath", "markdownPath", "reportPath", "targetPath", "outputPath", "recapPath"];
  for (const key of keys) {
    const value = asString((data as Record<string, unknown>)[key]);
    if (value.length > 0 && isPathSafeUnderProject(value)) return value;
  }

  const candidates = collectPaths(data);
  for (const candidate of candidates) {
    if (isPathSafeUnderProject(candidate)) return candidate;
  }

  return "";
};

const callApi = async (
  path: string,
  args: JsonObject = {},
  method: "POST" | "GET" = "POST",
): Promise<JsonObject> => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const requestArgs = withGateDecisionConfirmation(normalizedPath, args);
  const response = await fetch(`${API_ENDPOINT}${normalizedPath}`, {
    method,
    headers: method === "GET"
      ? { accept: "application/json", ...storyOsAuthHeaders() }
      : { "Content-Type": "application/json", ...storyOsAuthHeaders() },
    body: method === "GET" ? undefined : JSON.stringify(requestArgs),
  });

  const raw = await response.text();
  if (!raw.trim()) {
    return { ok: false, error: `API response empty: ${response.status} ${response.statusText}` };
  }

  const payload = JSON.parse(raw) as JsonObject;
  if (!response.ok && payload.ok !== false) {
    return { ok: false, error: asString(payload.error) || `${response.status}` , ...payload };
  }

  return payload;
};

const callRpc = async (method: string, params?: JsonObject, includeId = true): Promise<JsonObject | null> => {
  const body: JsonObject = { jsonrpc: "2.0", method };
  if (includeId) {
    body.id = `phase5-serial-${Math.random().toString(16).slice(2, 10)}`;
  }
  if (params) {
    body.params = params;
  }

  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...storyOsAuthHeaders() },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP failure: ${response.status} ${response.statusText}`);
  }

  const raw = await response.text();
  if (!raw.trim()) return null;
  return JSON.parse(raw) as JsonObject;
};

const callTool = async (name: string, args: JsonObject): Promise<JsonObject> => {
  const response = await callRpc("tools/call", { name, arguments: args });
  if (!response) throw new Error(`tools/call(${name}) returned empty response`);
  if (response.error) {
    const error = response.error as JsonObject;
    throw new Error(`tools/call(${name}) error: ${String(error.code ?? "")}: ${String(error.message ?? "unknown")}`);
  }
  const result = toObject(response.result);
  if (!result || typeof result !== "object") {
    throw new Error(`tools/call(${name}) missing result`);
  }
  if (toObject(result.structuredContent) && Object.keys(toObject(result.structuredContent)).length > 0) {
    return toObject(result.structuredContent);
  }
  return result;
};

const ensureOk = (label: string, result: JsonObject): JsonObject => {
  const ok = result.ok === true;
  const details = JSON.stringify(result);
  addCheck(label, ok, details);
  if (!ok) throw new Error(`${label}: ${details}`);
  return result;
};

const ensureFailureCode = (label: string, result: JsonObject, expectedCodes: string[]): boolean => {
  const ok = result.ok === false && expectedCodes.includes(asString(result.code));
  addCheck(label, ok, JSON.stringify(result));
  return ok;
};

const ensureExpectedGateRows = (label: string, gates: JsonObject[], gateType: string) => {
  const found = gates.some((entry) => asString(entry.gateType || entry.gate_type) === gateType);
  addCheck(label, found);
  return found;
};

const cleanupProject = async (): Promise<{ ok: boolean; detail: string }> => {
  let lastError = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      rmSync(PROJECT_DIR, { recursive: true, force: true });
      if (!existsSync(PROJECT_DIR)) {
        return { ok: true, detail: `removed ${PROJECT_DIR}` };
      }
    } catch (error) {
      lastError = String((error as Error).message);
    }

    await sleep(100);
  }

  return { ok: false, detail: lastError || `still exists: ${PROJECT_DIR}` };
};

const run = async () => {
  let seasonId = "";
  let arcId = "";
  let episodeId = "";
  let chapterId = "";

  try {
    const toolsList = await callRpc("tools/list", {});
    const tools = toolsList && toolsList.result ? toArray(toObject(toolsList.result).tools) : [];
    addCheck("tools/list returns result", toolsList !== null && toolsList.result !== undefined);
    const toolNames = tools.map((entry) => asString(toObject(entry).name));
    const toolsPresent = requiredTools.every((name) => toolNames.includes(name));
    addCheck("all required serial MCP tools listed", toolsPresent);

    const create = ensureOk(
      "/api/project/create creates serial project",
      await callApi("/api/project/create", {
        slug: PROJECT_SLUG,
        title: "Phase 5 Serial Smoke Project",
        mode: "serial",
      }),
    );
    addCheck("project create returns dbPath", existsSync(PROJECT_DB), `expected ${PROJECT_DB}`);

    const statusCreate = ensureOk("/api/project/status returns serial project status", await callApi("/api/project/status", {
      projectSlug: PROJECT_SLUG,
    }));
    const statusCreateSerial = getSerialStatus(statusCreate);
    addCheck("project status includes serial metadata", asString(statusCreateSerial.projectMode) === "serial");
    addCheck("serial project status includes unresolved promise count", Number.isFinite(asNumber(statusCreateSerial.unresolvedPromiseCount)));

    const invalidGateDecision = await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      gateType: "premise",
      decision: "approved",
      decisionSource: "ui_confirmation",
      humanConfirmed: true,
    });
    ensureFailureCode("invalid premise decision rejects non-ui confirmation source", invalidGateDecision, ["UNAUTHORIZED_GATE_DECISION"]);

    ensureOk(
      "/api/plan/premise_record records premise artifact",
      await callApi("/api/plan/premise_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 5 Premise",
        premiseSummary: "A serial narrator tracks unresolved promises across seasons and episodes.",
      }),
    );
    ensureOk(
      "/api/gate/decision approves premise with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "premise",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );
    ensureOk(
      "/api/plan/worldbuilding_record records worldbuilding",
      await callApi("/api/plan/worldbuilding_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 5 Worldbuilding",
        worldbuildingSummary: "The serial setting constrains promises by episode cadence and reveal schedule.",
      }),
    );
    ensureOk(
      "/api/gate/decision approves worldbuilding with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "worldbuilding",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const sourceEntity = ensureOk(
      "/api/plan/kg/upsert-entity seeds serial source entity",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "location",
        name: `phase5-source-${PROJECT_SLUG}`,
      }),
    );
    const sourceEntityId = extractId(toObject(sourceEntity.data).entityId || toObject(toObject(sourceEntity.data).entity).id, [
      "entityId",
      "id",
    ]);

    const targetEntity = ensureOk(
      "/api/plan/kg/upsert-entity seeds serial target entity",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "character",
        name: `phase5-target-${PROJECT_SLUG}`,
      }),
    );
    const targetEntityId = extractId(toObject(targetEntity.data).entityId || toObject(toObject(targetEntity.data).entity).id, [
      "entityId",
      "id",
    ]);
    addCheck("knowledge graph seed entities created", sourceEntityId.length > 0 && targetEntityId.length > 0);

    ensureOk(
      "/api/plan/kg/upsert-relationship seeds serial relation",
      await callApi("/api/plan/kg/upsert-relationship", {
        projectSlug: PROJECT_SLUG,
        sourceEntityId,
        targetEntityId,
        relationshipType: "foreshadows",
      }),
    );
    ensureOk(
      "/api/gate/decision approves knowledge graph with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "knowledge_graph",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    ensureOk(
      "/api/plan/series_bible_record records series bible",
      await callApi("/api/plan/series_bible_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 5 Serial Series Bible",
        bibleSummary: "The serial’s rhythm depends on clear promise status and release windows.",
      }),
    );
    ensureOk(
      "/api/gate/decision approves series bible with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "series_bible",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );
    ensureOk(
      "/api/plan/pov_plan_record records story infrastructure",
      await callApi("/api/plan/pov_plan_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 5 Story Infrastructure",
        infraSummary: "Serial chapter workflow reuses chapter variant gates.",
      }),
    );
    ensureOk(
      "/api/gate/decision approves story infrastructure with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "story_infrastructure",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );
    const planningArc = ensureOk(
      "story_arc_create creates project planning arc",
      await callTool("story_arc_create", {
        projectSlug: PROJECT_SLUG,
        scope: "book",
        title: "Phase 5 Planning Arc",
      }),
    );
    const planningArcId = extractId(toObject(toObject(planningArc.data).arc).id, ["arcId", "id"]);
    addCheck("project planning arc id is present", planningArcId.length > 0);

    ensureOk(
      "/api/plan/beatmap_record records project planning beats",
      await callApi("/api/plan/beatmap_record", {
        projectSlug: PROJECT_SLUG,
        arcId: planningArcId,
        beats: REQUIRED_BEAT_NAMES.map((name, index) => ({
          beatName: name,
          summary: `Phase 5 project beat ${index + 1}: ${name}`,
          order: index + 1,
          approved: true,
        })),
      }),
    );

    const planningBeatValidation = ensureOk(
      "story_arc_validate_seven_point validates project planning beats",
      await callTool("story_arc_validate_seven_point", {
        projectSlug: PROJECT_SLUG,
        arcId: planningArcId,
      }),
    );
    const planningBeatPayload = toObject(planningBeatValidation.data);
    addCheck("project planning beats validate", planningBeatPayload.valid === true);

    ensureOk(
      "/api/gate/decision approves project beats with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "beats",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const kgExport = ensureOk(
      "/api/plan/kg/export_jsonl exports serial knowledge graph",
      await callApi("/api/plan/kg/export_jsonl", {
        projectSlug: PROJECT_SLUG,
      }),
    );
    const kgFiles = toArray(toObject(toObject(kgExport.data).data).files);
    addCheck("knowledge graph export returned files", kgFiles.length > 0);

    const mermaidExport = ensureOk(
      "/api/plan/export_mermaid_diagrams creates planning diagrams",
      await callApi("/api/plan/export_mermaid_diagrams", {
        projectSlug: PROJECT_SLUG,
      }),
    );
    const mermaidRoot = toObject(mermaidExport.data);
    const mermaidPayload = Array.isArray(mermaidRoot.exports) ? mermaidRoot : toObject(mermaidRoot.data);
    const mermaidPaths = toArray(mermaidPayload.exports)
      .map((entry) => asString(toObject(entry).filePath))
      .filter((fileName) => fileName.length > 0)
      .map((fileName) => toLocalWorkspacePath(fileName));
    addCheck("planning mermaid export files exist", mermaidPaths.length > 0 && mermaidPaths.every((fileName) => existsSync(fileName)));

    ensureOk(
      "/api/gate/decision approves mermaid_export with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "mermaid_export",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const statusBeforeSeason = ensureOk("/api/project/status after planning", await callApi("/api/project/status", {
      projectSlug: PROJECT_SLUG,
    }));
    const workflowAfterPlan = getWorkflow(statusBeforeSeason);
    addCheck("planning workflow reaches completion", asString(workflowAfterPlan.allowedNextAction) === "complete_workflow");

    const seasonPlan = ensureOk(
      "/api/serial/season/plan creates active season",
      await callApi("/api/serial/season/plan", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 5 Serial Season 1",
        status: "active",
        seasonNumber: 1,
        premise: "Episode 1 seeds the open-promise economy.",
      }),
    );
    const seasonPayload = getPayloadData(seasonPlan);
    const seasonRecord = toObject(seasonPayload.season);
    const seasonResult = toObject(seasonPayload.result);
    seasonId = extractId(toObject(seasonPayload).seasonId || seasonRecord.id || toObject(seasonResult).seasonId || seasonResult.season?.id, [
      "seasonId",
      "id",
    ]);
    addCheck("serial season plan returns seasonId", seasonId.length > 0, JSON.stringify(seasonPayload));

    const invalidArcScope = await callApi("/api/serial/arc/plan", {
      projectSlug: PROJECT_SLUG,
      title: "Invalid Arc",
      scope: "invalid_scope",
      seasonId,
      arcSynopsis: "invalid",
    });
    ensureFailureCode("invalid serial arc scope rejected", invalidArcScope, ["INVALID_PARAMS", "INVALID_SCOPE"]);

    const seasonGateStatus = ensureOk("/api/gate/status exposes season_plan gate", await callApi("/api/gate/status", {
      projectSlug: PROJECT_SLUG,
      scopeType: "season",
      scopeId: seasonId,
    }));
    addCheck("season_plan gate present", ensureExpectedGateRows("season gate created", getGateRows(seasonGateStatus), "season_plan"));

    const invalidSeasonDecision = await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      scopeType: "season",
      scopeId: seasonId,
      gateType: "season_plan",
      decision: "approved",
      decisionSource: "bad_source",
      humanConfirmed: true,
    });
    ensureFailureCode("serial season gate decision requires OMP confirmation source", invalidSeasonDecision, ["UNAUTHORIZED_GATE_DECISION"]);

    ensureOk("approve season_plan gate with human provenance", await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      scopeType: "season",
      scopeId: seasonId,
      gateType: "season_plan",
      decision: "approved",
      decisionSource: "omp_ui_confirmation",
      humanConfirmed: true,
    }));

    const arcPlan = ensureOk("/api/serial/arc/plan creates season arc", await callApi("/api/serial/arc/plan", {
      projectSlug: PROJECT_SLUG,
      title: "Season 1 Main Arc",
      scope: "season",
      seasonId,
      arcSynopsis: "A serial promise unfolds across episodes 1-3.",
    }));
    const arcPayload = getPayloadData(arcPlan);
    const arcRecord = toObject(arcPayload.arc);
    const arcResult = toObject(arcPayload.result);
    arcId = extractId(toObject(arcPayload).arcId || arcRecord.id || arcRecord.arcId || arcResult.arcId || toObject(arcResult.arc).id || toObject(arcResult.arc).arcId, [
      "arcId",
      "id",
    ]);
    addCheck("serial arc plan returns arcId", arcId.length > 0, JSON.stringify(arcPlan));

    ensureOk("record seven-point beats for serial arc", await callApi("/api/plan/beatmap_record", {
      projectSlug: PROJECT_SLUG,
      arcId,
      beats: REQUIRED_BEAT_NAMES.map((name, index) => ({
        beatName: name,
        summary: `Phase 5 beat ${index + 1}: ${name}`,
        order: index + 1,
      })),
    }));
    const arcValidation = ensureOk(
      "serial arc seven-point validation passes",
      await callTool("story_arc_validate_seven_point", {
        projectSlug: PROJECT_SLUG,
        arcId,
      }),
    );
    addCheck(
      "arc validation reports valid",
      toObject(arcValidation.data).valid === true,
      JSON.stringify(arcValidation),
    );

    ensureOk("approve serial arc beats gate", await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      gateType: "beats",
      decision: "approved",
      decisionSource: "omp_ui_confirmation",
      humanConfirmed: true,
    }));

    const serialMermaidExport = ensureOk(
      "/api/plan/export_mermaid_diagrams refreshes diagrams after serial arc beats",
      await callApi("/api/plan/export_mermaid_diagrams", {
        projectSlug: PROJECT_SLUG,
      }),
    );
    const serialMermaidRoot = toObject(serialMermaidExport.data);
    const serialMermaidPayload = Array.isArray(serialMermaidRoot.exports) ? serialMermaidRoot : toObject(serialMermaidRoot.data);
    const serialMermaidPaths = toArray(serialMermaidPayload.exports)
      .map((entry) => asString(toObject(entry).filePath))
      .filter((fileName) => fileName.length > 0)
      .map((fileName) => toLocalWorkspacePath(fileName));
    addCheck("serial mermaid export files exist", serialMermaidPaths.length > 0 && serialMermaidPaths.every((fileName) => existsSync(fileName)));

    ensureOk("approve serial mermaid_export gate", await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      gateType: "mermaid_export",
      decision: "approved",
      decisionSource: "omp_ui_confirmation",
      humanConfirmed: true,
    }));

    const arcGateStatus = ensureOk("/api/gate/status exposes serial_arc_plan", await callApi("/api/gate/status", {
      projectSlug: PROJECT_SLUG,
      scopeType: "season",
      scopeId: seasonId,
    }));
    addCheck("serial_arc_plan gate present before approval", ensureExpectedGateRows("serial_arc_plan gate pending", getGateRows(arcGateStatus), "serial_arc_plan"));

    const invalidArcDecision = await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      scopeType: "season",
      scopeId: seasonId,
      gateType: "serial_arc_plan",
      decision: "approved",
      decisionSource: "not_a_human_confirm_source",
      humanConfirmed: true,
    });
    ensureFailureCode("serial_arc_plan decision requires OMP source", invalidArcDecision, ["UNAUTHORIZED_GATE_DECISION"]);

    ensureOk("approve serial_arc_plan gate", await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      scopeType: "season",
      scopeId: seasonId,
      gateType: "serial_arc_plan",
      decision: "approved",
      decisionSource: "omp_ui_confirmation",
      humanConfirmed: true,
    }));

    const readerPromiseMarker = `[READABLE-${PROJECT_SLUG}]`;
    const privatePromiseMarker = `[PRIVATE-${PROJECT_SLUG}]`;
    ensureOk("create reader-visible serial promise", await callApi("/api/serial/promise/upsert", {
      projectSlug: PROJECT_SLUG,
      title: `reader promise ${readerPromiseMarker}`,
      category: "open_promise",
      status: "open",
      visibility: "reader",
      note: "reader-visible contract",
      targetScopeType: "season",
      targetScopeId: seasonId,
    }));
    ensureOk("create private serial promise", await callApi("/api/serial/promise/upsert", {
      projectSlug: PROJECT_SLUG,
      title: `private promise ${privatePromiseMarker}`,
      category: "mystery",
      status: "open",
      visibility: "private",
      note: "private canon note",
      targetScopeType: "season",
      targetScopeId: seasonId,
    }));
    ensureOk("create deferred serial promise", await callApi("/api/serial/promise/upsert", {
      projectSlug: PROJECT_SLUG,
      title: `deferred promise ${PROJECT_SLUG}`,
      category: "theme",
      status: "deferred",
      visibility: "both",
      note: "deferred serial promise",
      targetScopeType: "season",
      targetScopeId: seasonId,
    }));

    const readerPromiseList = ensureOk("list reader-visible promises", await callApi("/api/serial/promise/list", {
      projectSlug: PROJECT_SLUG,
      status: "open",
      visibility: "reader",
      category: "open_promise",
      targetScopeType: "season",
      targetScopeId: seasonId,
    }));
    addCheck("reader visibility filter returns entries", toArray(getPayloadData(readerPromiseList).promises).length >= 1);

    const privatePromiseList = ensureOk("list private promises", await callApi("/api/serial/promise/list", {
      projectSlug: PROJECT_SLUG,
      visibility: "private",
      status: "open",
      targetScopeType: "season",
      targetScopeId: seasonId,
    }));
    addCheck("private visibility filter returns entries", toArray(getPayloadData(privatePromiseList).promises).length >= 1);

    const seasonStatusBeforeEpisode = ensureOk("/api/project/status before next episode", await callApi("/api/project/status", {
      projectSlug: PROJECT_SLUG,
    }));
    const serialStatusBeforeEpisode = getSerialStatus(seasonStatusBeforeEpisode);
    addCheck("serial status tracks active season", asString(serialStatusBeforeEpisode.activeSeasonId) === seasonId);
    addCheck("serial status tracks next episode number", asNumber(serialStatusBeforeEpisode.nextEpisodeNumber) >= 1);
    addCheck("serial status tracks open promise counts", Number.isFinite(asNumber(serialStatusBeforeEpisode.openPromiseCounts.open)));

    const nextEpisode = ensureOk("/api/serial/next-episode creates serial episode and chapter", await callApi("/api/serial/next-episode", {
      projectSlug: PROJECT_SLUG,
      seasonId,
      episodeTitle: "Episode 1",
      releaseLabel: "s1-e01",
    }));
    const nextEpisodePayload = getPayloadData(nextEpisode);
    episodeId = extractId(
      nextEpisodePayload.episodeId || nextEpisodePayload.episode,
      ["episodeId", "id", "serialEpisodeId"],
    );
    chapterId = extractId(
      nextEpisodePayload.chapterId || nextEpisodePayload.chapter,
      ["chapterId", "id", "serialChapterId"],
    );
    addCheck("next-episode returns episodeId", episodeId.length > 0);
    addCheck("next-episode returns chapterId", chapterId.length > 0);

    const preProseGatesFromNext = toArray(nextEpisodePayload.preProseGates).map((entry) => asString((toObject(entry)).gateType || (toObject(entry)).gate_type));
    addCheck("next-episode returns pre-prose gates", preProseGatesFromNext.length >= PRE_PROSE_GATES.length);

    const chapterGateStatus = ensureOk("chapter pre-prose gates exist for next episode", await callApi("/api/gate/status", {
      projectSlug: PROJECT_SLUG,
      scopeType: "chapter",
      scopeId: chapterId,
    }));
    const chapterGates = getGateRows(chapterGateStatus);
    addCheck("all chapter pre-prose gates created", PRE_PROSE_GATES.every((gateType) => Boolean(getGate(chapterGates, gateType))));

    const prematureVariant = await callApi("/api/chapter/variant/create", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      variantType: CHAPTER_VARIANTS[0],
      purpose: "blocked pre-prose attempt",
      markdownText: "# Should not be allowed yet",
      changedStructurally: "too early",
      changedEmotionally: "too early",
      changedInPacing: "too early",
      canonRisk: "low",
      continuityRisk: "low",
      bestUseCase: "blocked path",
      reasonToChoose: "blocked path",
      reasonNotToChoose: "blocked path",
    });
    ensureFailureCode("variant create blocked before pre-prose approval", prematureVariant, ["GATE_NOT_APPROVED", "MISSING_GATE"]);

    for (const gateType of PRE_PROSE_GATES) {
      ensureOk(`approve pre-prose gate ${gateType}`, await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        scopeType: "chapter",
        scopeId: chapterId,
        gateType,
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }));
    }

    const postDecisionGates = getGateRows(ensureOk("/api/gate/status", await callApi("/api/gate/status", {
      projectSlug: PROJECT_SLUG,
      scopeType: "chapter",
      scopeId: chapterId,
    })));
    addCheck("all pre-prose gates approved before variants", PRE_PROSE_GATES.every((gateType) => {
      const row = getGate(postDecisionGates, gateType);
      return asString(row?.status || row?.state) === "approved";
    }));

    for (const variantType of CHAPTER_VARIANTS) {
      ensureOk(`create ${variantType} variant`, await callApi("/api/chapter/variant/create", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        variantType,
        purpose: `${variantType} chapter draft`,
        markdownText: `# ${variantType}\n\nPhase 5 variant for chapter gating checks.`,
        changedStructurally: `Structural plan for ${variantType}`,
        changedEmotionally: `Emotional plan for ${variantType}`,
        changedInPacing: `Pacing plan for ${variantType}`,
        canonRisk: "low",
        continuityRisk: "low",
        bestUseCase: `Use case for ${variantType}`,
        reasonToChoose: `Reason to choose ${variantType}`,
        reasonNotToChoose: `Reason not choose ${variantType}`,
      }));
    }
    const variantList = ensureOk("chapter variant list includes all three variants", await callApi("/api/chapter/variant/list", {
      projectSlug: PROJECT_SLUG,
      chapterId,
    }));
    const variantRows = toArray(getPayloadData(variantList).variants).map((entry) => asString(toObject(entry).variant_type || toObject(entry).variantType));
    addCheck("exactly three variants created", variantRows.length === CHAPTER_VARIANTS.length);
    addCheck(
      "all required variant types present",
      CHAPTER_VARIANTS.every((variantType) => variantRows.includes(variantType)),
      `found=${JSON.stringify(variantRows)}`,
    );

    const invalidVariantType = await callApi("/api/chapter/variant/create", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      variantType: "experimental",
      purpose: "invalid",
      markdownText: "# invalid",
      changedStructurally: "invalid",
      changedEmotionally: "invalid",
      changedInPacing: "invalid",
      canonRisk: "invalid",
      continuityRisk: "invalid",
      bestUseCase: "invalid",
      reasonToChoose: "invalid",
      reasonNotToChoose: "invalid",
    });
    ensureFailureCode("invalid variant type rejected", invalidVariantType, ["INVALID_PARAMS"]);

    const readerRecap = ensureOk("generate reader recap", await callApi("/api/serial/recap", {
      projectSlug: PROJECT_SLUG,
      episodeId,
      seasonId,
      audience: "reader",
      includeOpenPromises: true,
      maxEpisodes: 1,
    }));
    const readerText = pickRecapText(readerRecap);
    addCheck("reader recap returns content", readerText.length > 0);
    addCheck("reader recap excludes private promise marker", !readerText.includes(privatePromiseMarker));
    const readerRecapPath = pickSafePath(readerRecap);
    addCheck("reader recap path is safe",
      readerRecapPath.length > 0 && isPathSafeUnderProject(readerRecapPath) && existsSync(normalizeProjectPath(readerRecapPath)));

    const privateRecap = ensureOk("generate private recap", await callApi("/api/serial/recap", {
      projectSlug: PROJECT_SLUG,
      episodeId,
      seasonId,
      audience: "private",
      includeOpenPromises: true,
      maxEpisodes: 1,
    }));
    const privateText = pickRecapText(privateRecap);
    addCheck("private recap returns content", privateText.length > 0);
    addCheck("private recap includes private promise marker", privateText.includes(privatePromiseMarker));
    const privateRecapPath = pickSafePath(privateRecap);
    addCheck("private recap path is safe",
      privateRecapPath.length > 0 && isPathSafeUnderProject(privateRecapPath) && existsSync(normalizeProjectPath(privateRecapPath)));

    const statusBeforeReport = ensureOk("/api/project/status before season report", await callApi("/api/project/status", {
      projectSlug: PROJECT_SLUG,
    }));
    const serialStatusBeforeReport = getSerialStatus(statusBeforeReport);
    const expectedUnresolved = asNumber(serialStatusBeforeReport.unresolvedPromiseCount);

    const seasonReport = ensureOk("generate season report", await callApi("/api/serial/season/report", {
      projectSlug: PROJECT_SLUG,
      seasonId,
      includePrivate: true,
    }));
    const seasonReportData = getPayloadData(seasonReport);
    const reportedUnresolved = toNumber(seasonReportData, ["unresolvedPromiseCount", "unresolvedPromises", "openPromiseCount", "pendingPromiseCount"]);
    addCheck("season report includes unresolved promise count", Number.isFinite(reportedUnresolved));
    if (Number.isFinite(reportedUnresolved)) {
      addCheck("season report unresolved count matches project status", reportedUnresolved === expectedUnresolved, `reported=${reportedUnresolved}, expected=${expectedUnresolved}`);
    }
    const reportSummary = toObject(seasonReportData.summary);
    const arcBeatSummary = toObject(reportSummary.arcBeatSummary);
    addCheck("season report includes planned serial arc", asString(arcBeatSummary.arcId) === arcId, JSON.stringify(arcBeatSummary));
    addCheck("season report validates serial arc beats", arcBeatSummary.valid === true && toArray(arcBeatSummary.missing).length === 0, JSON.stringify(arcBeatSummary));
    const reportPath = pickSafePath(seasonReport);
    addCheck("season report path is safe",
      reportPath.length > 0 && isPathSafeUnderProject(reportPath) && existsSync(normalizeProjectPath(reportPath)));

    const graphFiles = listJsonl(PROJECT_GRAPH_DIR);
    addCheck("serial graph output includes season files", graphFiles.some((entry) => entry === "serial_seasons.jsonl"));
    addCheck("serial graph output includes episodes file", graphFiles.some((entry) => entry === "serial_episodes.jsonl"));
    addCheck("serial graph output includes promises file", graphFiles.some((entry) => entry === "serial_promises.jsonl"));
    const seasonGraphRows = readJsonl(join(PROJECT_GRAPH_DIR, "serial_seasons.jsonl"));
    const episodeGraphRows = readJsonl(join(PROJECT_GRAPH_DIR, "serial_episodes.jsonl"));
    const promiseGraphRows = readJsonl(join(PROJECT_GRAPH_DIR, "serial_promises.jsonl"));
    addCheck("season graph entries recorded", seasonGraphRows.length > 0);
    addCheck("episode graph entries recorded", episodeGraphRows.length > 0);
    addCheck("promise graph entries recorded", promiseGraphRows.length > 0);
  } catch (error) {
    addCheck("phase5 serial smoke execution", false, String((error as Error).message));
  } finally {
    const cleanup = await cleanupProject();
    addCheck("cleanup removed generated project", cleanup.ok, cleanup.detail);
  }

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAILED"} ${check.label}` + (check.details ? ` - ${check.details}` : ""));
  }
  const allOk = checks.every((entry) => entry.ok);
  process.exit(allOk ? 0 : 1);
};

void run();
