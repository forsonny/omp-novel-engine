import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { storyOsAuthHeaders, storyOsBaseUrl, withGateDecisionConfirmation } from "./story-os-env";

type Check = { label: string; ok: boolean; details?: string };
type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

const API_ENDPOINT = storyOsBaseUrl();
const MCP_ENDPOINT = `${API_ENDPOINT}/mcp`;
const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const PROJECT_SLUG = `phase3-planning-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PROJECT_DIR = join(WORKSPACE_ROOT, "stories", PROJECT_SLUG);
const PROJECT_DB = join(PROJECT_DIR, "canon", "canon.db");
const PROJECT_GRAPH = join(PROJECT_DIR, "canon", "graph");

const checks: Array<Check> = [];
const addCheck = (label: string, ok: boolean, details = "") => checks.push({ label, ok, details });

const requiredTools = [
  "story_project_status",
  "story_project_create",
  "story_premise_record",
  "story_worldbuilding_record",
  "story_series_bible_record",
  "story_pov_plan_record",
  "story_kg_upsert_entity",
  "story_kg_upsert_relationship",
  "story_kg_export_jsonl",
  "story_arc_create",
  "story_beatmap_record",
  "story_arc_validate_seven_point",
  "story_export_mermaid_diagrams",
  "story_gate_record_human_decision",
];

const requiredBeatNames = [
  "Hook",
  "First Plot Point",
  "First Pinch",
  "Midpoint",
  "Second Pinch",
  "Second Plot Point",
  "Resolution",
];

const toObject = (value: unknown): JsonObject => (value && typeof value === "object" ? (value as JsonObject) : {});
const toArray = (value: unknown): JsonArray => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const listJsonl = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
};

const toLocalWorkspacePath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/workspace/")) {
    return join(WORKSPACE_ROOT, normalized.slice("/workspace/".length));
  }
  return filePath;
};

const callRpc = async (method: string, params?: JsonObject, includeId = true): Promise<JsonObject | null> => {
  const body: JsonObject = { jsonrpc: "2.0", method };
  if (includeId) {
    body.id = `planning-${Math.random().toString(16).slice(2, 12)}`;
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
  if (raw.trim().length === 0) return null;
  return JSON.parse(raw) as JsonObject;
};

const callTool = async (name: string, args: JsonObject): Promise<JsonObject> => {
  const response = await callRpc("tools/call", { name, arguments: args });
  if (!response) throw new Error(`tools/call(${name}) returned empty response`);
  if (response.error) {
    const error = response.error as JsonObject;
    const errorMessage = `${String(error.code ?? "")}: ${String(error.message ?? "unknown")}`;
    throw new Error(`tools/call(${name}) failed: ${errorMessage}`);
  }
  if (!response.result || typeof response.result !== "object") {
    throw new Error(`tools/call(${name}) missing tool result`);
  }
  const result = response.result as JsonObject;
  const structured = result.structuredContent;
  return structured && typeof structured === "object" ? structured as JsonObject : result;
};

const callApi = async (path: string, args: JsonObject = {}, method: "POST" | "GET" = "POST"): Promise<JsonObject> => {
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
    throw new Error(`API response empty: ${response.status} ${response.statusText}`);
  }

  const payload = JSON.parse(raw) as JsonObject;
  return payload;
};

const ensureOk = (label: string, result: JsonObject): JsonObject => {
  const ok = result.ok === true;
  const details = JSON.stringify(result);
  addCheck(label, ok, details);
  if (!ok) throw new Error(`${label}: ${details}`);
  return result;
};

const getWorkflow = (statusResult: JsonObject): JsonObject => {
  const status = toObject(statusResult.data);
  const projectRows = toArray(status.projects).map((entry) => toObject(entry));
  return toObject(projectRows[0]).workflow as JsonObject;
};

const getProjectRow = (statusResult: JsonObject): JsonObject => {
  const status = toObject(statusResult.data);
  return toObject(toArray(status.projects)[0]);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { ok: false, detail: lastError || `still exists: ${PROJECT_DIR}` };
};

const run = async () => {
  let arcId: string | null = null;

  try {
    const toolsList = await callRpc("tools/list", {});
    if (!toolsList?.result || typeof toolsList.result !== "object") {
      throw new Error("tools/list did not return result");
    }
    const toolRows = toArray((toolsList.result as JsonObject).tools) as JsonObject[];
    for (const tool of requiredTools) {
      addCheck(`tools/list includes ${tool}`, toolRows.some((entry) => entry.name === tool));
    }

    const create = ensureOk(
      "/api/project/create creates planning project",
      await callApi("/api/project/create", {
        slug: PROJECT_SLUG,
        title: "Phase 3 Planning Project",
        mode: "standalone",
      }),
    );
    const createData = toObject(create.data);
    addCheck("project create returned dbPath", typeof createData.dbPath === "string" && createData.dbPath.length > 0);
    addCheck("project create returned graphDir", typeof createData.graphDir === "string" && createData.graphDir.length > 0);
    addCheck("project create writes sqlite DB", existsSync(PROJECT_DB), `expected ${PROJECT_DB}`);

    const initialStatus = ensureOk("/api/project/status before planning returns ok", await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }));
    const initialWorkflow = getWorkflow(initialStatus);
    addCheck("workflow starts at premise", asString(initialWorkflow.currentStage) === "premise");
    addCheck("initial pending gate is premise", asString(initialWorkflow.blockerGateType) === "premise");

    await callApi("/api/plan/worldbuilding_record", {
      projectSlug: PROJECT_SLUG,
      title: "Attempt blocked before premise approval",
    });
    const statusAfterAttempt = ensureOk(
      "/api/project/status after blocked worldbuilding probe",
      await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }),
    );
    const workflowAfterAttempt = getWorkflow(statusAfterAttempt);
    addCheck(
      "worldbuilding probe does not bypass premise gate",
      asString(workflowAfterAttempt.blockerGateType) === "premise" || asString(workflowAfterAttempt.currentStage) === "premise",
    );

    const invalidDecision = await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      gateType: "premise",
      decision: "approved",
      decisionSource: "wrong_source",
      humanConfirmed: true,
    });
    addCheck(
      "invalid gate decision rejected without omp ui source",
      invalidDecision.ok === false && asString(invalidDecision.code) === "UNAUTHORIZED_GATE_DECISION",
    );

    ensureOk(
      "/api/plan/premise_record stores premise artifact",
      await callApi("/api/plan/premise_record", {
        projectSlug: PROJECT_SLUG,
        title: "Planning premise",
        premiseSummary: "An apprentice discovers the hidden system and must choose duty or escape.",
      }),
    );

    const premiseDecision = ensureOk(
      "/api/gate/decision approves premise",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "premise",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );
    addCheck("premise decision accepted", premiseDecision.ok === true);

    const statusAfterPremiseDecision = getWorkflow(
      ensureOk("/api/project/status after premise decision", await callApi("/api/project/status", { projectSlug: PROJECT_SLUG })),
    );
    addCheck("workflow advances to worldbuilding", asString(statusAfterPremiseDecision.currentStage) === "worldbuilding");

    ensureOk(
      "/api/plan/worldbuilding_record stores worldbuilding artifact",
      await callApi("/api/plan/worldbuilding_record", {
        projectSlug: PROJECT_SLUG,
        title: "Worldbuilding notes",
        worldbuildingSummary: "Maps, factions, laws, and constraints are established.",
      }),
    );

    ensureOk(
      "/api/gate/decision approves worldbuilding",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "worldbuilding",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const seedEntity = ensureOk(
      "/api/plan/kg/upsert-entity seeds knowledge graph entity",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "location",
        name: `phase3-kg-${PROJECT_SLUG}`,
      }),
    );
    const seedEntityData = toObject(seedEntity.data);
    const sourceEntityId = asString(toObject(seedEntityData.entity).id);

    const targetEntity = ensureOk(
      "/api/plan/kg/upsert-entity seeds second knowledge graph entity",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "character",
        name: `phase3-char-${PROJECT_SLUG}`,
      }),
    );
    const targetEntityData = toObject(targetEntity.data);
    const targetEntityId = asString(toObject(targetEntityData.entity).id);
    addCheck("knowledge graph seed entities created", sourceEntityId.length > 0 && targetEntityId.length > 0);

    ensureOk(
      "/api/plan/kg/upsert-relationship seeds knowledge graph relation",
      await callApi("/api/plan/kg/upsert-relationship", {
        projectSlug: PROJECT_SLUG,
        sourceEntityId,
        targetEntityId,
        relationshipType: "ally",
      }),
    );

    ensureOk(
      "/api/gate/decision approves knowledge graph",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "knowledge_graph",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    ensureOk(
      "/api/plan/series_bible_record stores series bible",
      await callApi("/api/plan/series_bible_record", {
        projectSlug: PROJECT_SLUG,
        title: "Series bible",
        bibleSummary: "Tone, canon bounds, and serial promises are defined.",
      }),
    );

    ensureOk(
      "/api/gate/decision approves series bible",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "series_bible",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    ensureOk(
      "/api/plan/pov_plan_record stores story infrastructure",
      await callApi("/api/plan/pov_plan_record", {
        projectSlug: PROJECT_SLUG,
        title: "Story infrastructure",
        infraSummary: "POV and progression scaffolding established.",
      }),
    );

    ensureOk(
      "/api/gate/decision approves story infrastructure",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "story_infrastructure",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const arc = ensureOk(
      "story_arc_create creates arc",
      await callTool("story_arc_create", {
        projectSlug: PROJECT_SLUG,
        scope: "book",
        title: "Phase 3 Arc",
      }),
    );
    const arcData = toObject(toObject(arc.data).arc);
    arcId = asString(arcData.id);
    addCheck("arc id is present", arcId.length > 0);

    const requiredBeats = requiredBeatNames.map((name, index) => ({
      beatName: name,
      summary: `Beat ${index + 1} summary.`,
      order: index + 1,
      approved: true,
    }));

    ensureOk(
      "/api/plan/beatmap_record stores required beats",
      await callApi("/api/plan/beatmap_record", {
        projectSlug: PROJECT_SLUG,
        arcId,
        beats: requiredBeats,
      }),
    );

    const beatValidation = ensureOk(
      "story_arc_validate_seven_point validates required names",
      await callTool("story_arc_validate_seven_point", {
        projectSlug: PROJECT_SLUG,
        arcId,
      }),
    );
    const beatValidationData = toObject(beatValidation.data);
    addCheck("all required beats present", toArray(beatValidationData.missing).length === 0);
    addCheck("beat validation passes", beatValidationData.valid === true);

    ensureOk(
      "/api/gate/decision approves beats",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "beats",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const jsonlExport = ensureOk(
      "/api/plan/kg/export_jsonl exports knowledge graph artifacts",
      await callApi("/api/plan/kg/export_jsonl", {
        projectSlug: PROJECT_SLUG,
      }),
    );
    const jsonlPayload = toObject(toObject(jsonlExport.data).data);
    const files = toArray(jsonlPayload.files).map((entry) => asString(entry));
    const localGraphFiles = listJsonl(PROJECT_GRAPH);
    addCheck("kg jsonl export reports files", files.length > 0);
    addCheck("kg export file row count recorded", typeof jsonlPayload.totalLines === "number");
    addCheck(
      "jsonl report matches local graph files",
      files.every((fileName) => localGraphFiles.includes(fileName)) && localGraphFiles.length > 0,
    );

    const mermaid = ensureOk(
      "/api/plan/export_mermaid_diagrams creates mermaid export",
      await callApi("/api/plan/export_mermaid_diagrams", {
        projectSlug: PROJECT_SLUG,
      }),
    );
    const mermaidRoot = toObject(mermaid.data);
    const mermaidPayload = Array.isArray(mermaidRoot.exports) ? mermaidRoot : toObject(mermaidRoot.data);
    const mermaidExports = toArray(mermaidPayload.exports);
    const mermaidFiles = mermaidExports.map((entry) => asString(toObject(entry).filePath)).filter((fileName) => fileName.length > 0);
    addCheck("mermaid export includes files", mermaidFiles.length > 0);
    addCheck("mermaid export files exist", mermaidFiles.every((fileName) => existsSync(toLocalWorkspacePath(fileName))));

    const finalStatus = ensureOk("/api/project/status before mermaid decision", await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }));
    const finalWorkflow = getWorkflow(finalStatus);
    addCheck("workflow reaches mermaid_export", asString(finalWorkflow.currentStage) === "mermaid_export");

    ensureOk(
      "/api/gate/decision approves mermaid_export",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "mermaid_export",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const finalStatusAfter = ensureOk(
      "/api/project/status after mermaid decision",
      await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }),
    );
    const completedWorkflow = getWorkflow(finalStatusAfter);
    addCheck("workflow complete action available", asString(completedWorkflow.allowedNextAction) === "complete_workflow");
    addCheck("no blocker gate after approvals", asString(completedWorkflow.blockerGateStatus).length === 0);

    const finalProject = getProjectRow(finalStatusAfter);
    addCheck("project status returns this project", finalProject.slug === PROJECT_SLUG);
  } catch (error) {
    addCheck("phase3 planning smoke execution", false, String((error as Error).message));
  } finally {
    const cleanup = await cleanupProject();
    addCheck("cleanup removed generated project", cleanup.ok, cleanup.detail);
  }

  for (const check of checks) {
    console.log(`${check.ok ? "OK" : "FAILED"} ${check.label}` + (check.details ? ` - ${check.details}` : ""));
  }

  const allOk = checks.every((check) => check.ok);
  process.exit(allOk ? 0 : 1);
};

void run();
