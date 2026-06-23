import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { storyOsAuthHeaders, storyOsBaseUrl, withGateDecisionConfirmation } from "./story-os-env";

type Check = { label: string; ok: boolean; details?: string };
type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

const API_ENDPOINT = storyOsBaseUrl();
const MCP_ENDPOINT = `${API_ENDPOINT}/mcp`;
const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const PROJECT_SLUG = `phase2-smoke-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PROJECT_DIR = join(WORKSPACE_ROOT, "stories", PROJECT_SLUG);
const PROJECT_DB = join(PROJECT_DIR, "canon", "canon.db");
const PROJECT_GRAPH = join(PROJECT_DIR, "canon", "graph");

const checks: Array<Check> = [];
const addCheck = (label: string, ok: boolean, details = "") => checks.push({ label, ok, details });

const requiredTools = [
  "story_project_create",
  "story_canon_upsert_fact",
  "story_canon_search",
  "story_kg_upsert_entity",
  "story_kg_upsert_relationship",
  "story_kg_export_jsonl",
  "story_premise_record",
  "story_worldbuilding_record",
  "story_series_bible_record",
  "story_pov_plan_record",
  "story_beatmap_record",
  "story_arc_create",
  "story_arc_validate_seven_point",
  "story_export_mermaid_diagrams",
  "story_gate_record_human_decision",
  "story_chapter_outline_record",
  "story_chapter_variant_create",
  "story_chapter_variant_list",
  "story_chapter_variant_rank",
  "story_chapter_variant_select",
  "story_chapter_draft_record",
  "story_chapter_complete_mark",
  "story_audit_run",
  "story_audit_get_report",
  "story_audit_record_finding",
  "story_audit_export_occurrence_inventory",
  "story_export_markdown_chapter",
  "story_serial_season_plan",
  "story_serial_arc_plan",
  "story_serial_next_episode",
  "story_serial_promise_upsert",
  "story_serial_promise_list",
  "story_serial_recap_generate",
  "story_serial_season_report",
];
const requiredBeatNames = [
  "Hook",
  "First Plot Point",
  "First Pinch",
  "Midpoint",
  "Second Pinch",
  "Second Plot Point",
  "Resolution"
];

let rpcId = 1;

const toObject = (value: unknown): JsonObject => (value && typeof value === "object" ? (value as JsonObject) : {});
const toArray = (value: unknown): JsonArray => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const callApi = async (path: string, args: JsonObject = {}, method: "POST" | "GET" = "POST"): Promise<JsonObject> => {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const requestArgs = withGateDecisionConfirmation(normalizedPath, args);
  const response = await fetch(`${API_ENDPOINT}${normalizedPath}`, {
    method,
    headers: method === "GET"
      ? { accept: "application/json", ...storyOsAuthHeaders() }
      : { "Content-Type": "application/json", ...storyOsAuthHeaders() },
    body: method === "GET" ? undefined : JSON.stringify(requestArgs)
  });

  const raw = await response.text();
  if (!raw.trim()) {
    return { ok: false, error: `API response empty: ${response.status} ${response.statusText}` };
  }

  const payload = JSON.parse(raw) as JsonObject;
  if (!response.ok && response.status !== 500) {
    return { ok: false, error: payload?.error ? String(payload.error) : `${response.status} ${response.statusText}`, ...payload };
  }
  return payload;
};

const callRpc = async (method: string, params?: JsonObject, includeId = true): Promise<JsonObject | null> => {
  const body: JsonObject = { jsonrpc: "2.0", method };
  if (includeId) {
    body.id = `protocol-${rpcId++}`;
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
    const errorMessage = `${String(error.code ?? "")} ${String(error.message ?? "unknown")}`;
    throw new Error(`tools/call(${name}) error: ${errorMessage.trim()}`);
  }
  if (!response.result || typeof response.result !== "object") {
    throw new Error(`tools/call(${name}) missing tool result`);
  }
  const callResult = response.result as JsonObject;
  const structuredContent = callResult.structuredContent;
  if (structuredContent && typeof structuredContent === "object") {
    return structuredContent as JsonObject;
  }
  return callResult;
};

const ensureToolOk = (label: string, result: JsonObject): JsonObject => {
  const ok = result.ok === true;
  const details = JSON.stringify(result);
  addCheck(label, ok, details);
  if (!ok) throw new Error(`${label}: ${details}`);
  return result;
};

const ensureApiOk = (label: string, result: JsonObject): JsonObject => {
  const ok = result.ok === true;
  const details = JSON.stringify(result);
  addCheck(label, ok, details);
  if (!ok) throw new Error(`${label}: ${details}`);
  return result;
};

const listFiles = (dir: string): string[] => {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const cleanupProject = async (): Promise<{ ok: boolean; detail: string }> => {
  let lastError = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      rmSync(PROJECT_DIR, { recursive: true, force: true });
      if (!existsSync(PROJECT_DIR)) return { ok: true, detail: `removed ${PROJECT_DIR}` };
    } catch (error) {
      lastError = String((error as Error).message);
    }
    await sleep(100);
  }

  return { ok: false, detail: lastError || `still exists: ${PROJECT_DIR}` };
};

const run = async () => {
  let entityOneId: string | null = null;
  let entityTwoId: string | null = null;
  let arcId: string | null = null;

  try {
    const init = await callRpc("initialize", {});
    const hasInit = init !== null && init.result !== undefined && typeof init.result === "object";
    addCheck("initialize returns MCP result", hasInit);
    if (hasInit) {
      const result = init!.result as JsonObject;
      const serverInfo = toObject(result.serverInfo);
      addCheck("initialize returns protocolVersion", typeof result.protocolVersion === "string");
      addCheck("initialize includes serverInfo.name", serverInfo.name === "story-os-mcp");
    }

    const initialized = await callRpc("notifications/initialized", undefined, false);
    if (initialized && initialized.result !== undefined) {
      const initializedResult = initialized.result as JsonObject;
      addCheck("notifications/initialized acknowledged", initializedResult.acknowledged === true);
    } else {
      addCheck("notifications/initialized acknowledged", true, "notification acknowledged by no-op response");
    }

    const ping = await callRpc("ping", {});
    addCheck("ping succeeds", ping?.result !== undefined);
    if (ping?.result && typeof ping.result === "object") {
      addCheck("ping returns ok:true", (ping.result as JsonObject).ok === true);
    }

    const resources = await callRpc("resources/list", {});
    const resourcesData = toObject(resources?.result);
    addCheck("resources/list returns resources array", Array.isArray(resourcesData.resources));
    const prompts = await callRpc("prompts/list", {});
    const promptsData = toObject(prompts?.result);
    addCheck("prompts/list returns prompts array", Array.isArray(promptsData.prompts));

    const toolsList = await callRpc("tools/list", {});
    const toolsPayload = toObject(toolsList?.result).tools;
    const tools = Array.isArray(toolsPayload)
      ? (toolsPayload as Array<JsonObject>)
      : [];
    addCheck("tools/list returns array", Array.isArray(tools));

    for (const tool of requiredTools) {
      addCheck(`tools/list includes ${tool}`, tools.some((entry) => entry.name === tool));
    }
    const toolsWithEmptySchemas = tools
      .filter((entry) => {
        const schema = toObject(entry.inputSchema);
        const properties = toObject(schema.properties);
        return Object.keys(properties).length === 0;
      })
      .map((entry) => asString(entry.name));
    addCheck("tools/list has non-empty input schemas", toolsWithEmptySchemas.length === 0, toolsWithEmptySchemas.join(", "));

    const create = ensureToolOk(
      "story_project_create returns ok",
      await callTool("story_project_create", {
        slug: PROJECT_SLUG,
        title: "Phase 2 Protocol Smoke Project",
        mode: "standalone",
      }),
    );
    const createData = create.data as JsonObject;
    addCheck("story_project_create returns data.project", Boolean(createData && typeof createData.project === "object"));
    const dbPathSuffix = join("stories", PROJECT_SLUG, "canon", "canon.db");
    const graphDirSuffix = join("stories", PROJECT_SLUG, "canon", "graph");
    addCheck("story_project_create returned dbPath", String(createData.dbPath ?? "").replace(/\\/g, "/").endsWith(dbPathSuffix.replace(/\\/g, "/")));
    addCheck("story_project_create returned graphDir", String(createData.graphDir ?? "").replace(/\\/g, "/").endsWith(graphDirSuffix.replace(/\\/g, "/")));
    addCheck("story_project_create writes project DB", existsSync(PROJECT_DB), `expected ${PROJECT_DB}`);

    const upsertFact = ensureToolOk(
      "story_canon_upsert_fact returns ok",
      await callTool("story_canon_upsert_fact", {
        projectSlug: PROJECT_SLUG,
        factType: "protocol",
        factText: "Smoke test canon fact for phase 2 protocol validation.",
      }),
    );
    const upsertFactData = upsertFact.data as JsonObject;
    addCheck(
      "story_canon_upsert_fact returns fact id",
      Boolean(upsertFactData && typeof upsertFactData.fact === "object" && typeof (upsertFactData.fact as JsonObject).id === "string"),
      JSON.stringify(upsertFactData),
    );

    const search = ensureToolOk(
      "story_canon_search returns ok",
      await callTool("story_canon_search", {
        projectSlug: PROJECT_SLUG,
        query: "protocol",
        limit: 10,
      }),
    );
    const searchData = search.data as JsonObject;
    const facts = Array.isArray(searchData.facts) ? (searchData.facts as unknown[]) : [];
    addCheck("story_canon_search returns results", facts.length > 0);

    const entityOne = ensureToolOk(
      "story_kg_upsert_entity returns ok",
      await callTool("story_kg_upsert_entity", {
        projectSlug: PROJECT_SLUG,
        type: "character",
        name: `source-${PROJECT_SLUG}`,
      }),
    );
    entityOneId = typeof entityOne.data === "object" && entityOne.data !== null
      ? (entityOne.data as JsonObject).entity
        ? (((entityOne.data as JsonObject).entity as JsonObject).id as string)
        : null
      : null;
    addCheck("story_kg_upsert_entity returns entity id", typeof entityOneId === "string" && entityOneId.length > 0);

    const entityTwo = ensureToolOk(
      "story_kg_upsert_entity returns ok",
      await callTool("story_kg_upsert_entity", {
        projectSlug: PROJECT_SLUG,
        type: "character",
        name: `target-${PROJECT_SLUG}`,
      }),
    );
    entityTwoId = typeof entityTwo.data === "object" && entityTwo.data !== null
      ? (entityTwo.data as JsonObject).entity
        ? (((entityTwo.data as JsonObject).entity as JsonObject).id as string)
        : null
      : null;
    addCheck("story_kg_upsert_entity returns second entity id", typeof entityTwoId === "string" && entityTwoId.length > 0);

    if (entityOneId && entityTwoId) {
      const relationship = ensureToolOk(
        "story_kg_upsert_relationship returns ok",
        await callTool("story_kg_upsert_relationship", {
          projectSlug: PROJECT_SLUG,
          sourceEntityId: entityOneId,
          targetEntityId: entityTwoId,
          relationshipType: "interacts_with",
          state: "smoke",
        }),
      );
      addCheck("story_kg_upsert_relationship returns relationship", relationship.data !== null);
    } else {
      addCheck("story_kg_upsert_relationship skipped due to missing entity ids", false);
    }

    const exportResult = ensureToolOk(
      "story_kg_export_jsonl returns ok",
      await callTool("story_kg_export_jsonl", { projectSlug: PROJECT_SLUG }),
    );
    const exportData = exportResult.data as JsonObject;
    const exportPayload = toObject(exportData.data);
    const fileArtifacts = toArray(exportPayload.files);
    addCheck("story_kg_export_jsonl includes files", fileArtifacts.length > 0, JSON.stringify(exportData));
    const graphFiles = listFiles(PROJECT_GRAPH);
    addCheck("graph directory created", graphFiles.length > 0, `checked ${PROJECT_GRAPH}`);

    addCheck("graph export reports local files", fileArtifacts.length > 0);
    addCheck("local graph files and export report agree", fileArtifacts.length === graphFiles.length);

    const initialProjectStatus = ensureApiOk(
      "api /project/status returns current stage",
      await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }, "POST"),
    );
    const initialStatusData = toObject(initialProjectStatus.data);
    const initialWorkflow = toObject(toArray(initialStatusData.projects)[0] as JsonObject).workflow as JsonObject;
    addCheck("phase3 workflow starts at premise", asString(initialWorkflow.currentStage) === "premise");
    addCheck("phase3 pending premise shown", initialWorkflow.blockerGateType === "premise");

    await callApi("/api/plan/worldbuilding_record", {
      projectSlug: PROJECT_SLUG,
      title: "Phase 3 blocked worldbuilding probe",
      premiseHint: "Premise must be decided before worldbuilding."
    });
    const statusAfterWorldbuildingAttempt = ensureApiOk(
      "api /project/status after worldbuilding probe returns ok",
      await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }, "POST"),
    );
    const statusAfterProbeData = toObject(statusAfterWorldbuildingAttempt.data);
    const workflowAfterProbe = toObject(toArray(statusAfterProbeData.projects)[0] as JsonObject).workflow as JsonObject;
    addCheck(
      "premise gate still pending before approval",
      asString(workflowAfterProbe.blockerGateType) === "premise"
      || asString(workflowAfterProbe.currentStage) === "premise",
    );

    const invalidGateDecision = await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      gateType: "premise",
      decision: "approved",
      decisionSource: "ui_confirmation",
      humanConfirmed: true
    });
    addCheck(
      "invalid gate decision rejected",
      invalidGateDecision.ok === false &&
      asString(invalidGateDecision.code) === "UNAUTHORIZED_GATE_DECISION"
    );

    ensureApiOk(
      "api /plan/premise_record records premise",
      await callApi("/api/plan/premise_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 3 Premise",
        premiseSummary: "A hero returns from loss to reclaim their inheritance through a required planning gate chain."
      })
    );
    const premiseStatus = ensureApiOk(
      "api /project/status after premise record returns ok",
      await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }, "POST"),
    );
    const premiseData = toObject(premiseStatus.data);
    const premiseWorkflow = toObject(toArray(premiseData.projects)[0] as JsonObject).workflow as JsonObject;
    addCheck("premise recording does not auto-approve gate", asString(premiseWorkflow.blockerGateType) === "premise");

    ensureApiOk(
      "api /gate/decision approve premise with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "premise",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );
    ensureApiOk(
      "api /plan/worldbuilding_record records worldbuilding",
      await callApi("/api/plan/worldbuilding_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 3 Worldbuilding",
        worldbuildingSummary: "Geography, factions, and rules were defined."
      }),
    );

    ensureApiOk(
      "api /gate/decision approve worldbuilding with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "worldbuilding",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const kgEntityOne = ensureApiOk(
      "api /plan/kg/upsert-entity creates knowledge graph entity",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "location",
        name: `phase3-location-${PROJECT_SLUG}`,
      }),
    );
    const kgEntityOneData = toObject(toObject(kgEntityOne.data).entity as JsonObject);
    const kgEntityOneId = asString(kgEntityOneData.id);
    const kgEntityTwo = ensureApiOk(
      "api /plan/kg/upsert-entity creates second knowledge graph entity",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "organization",
        name: `phase3-organization-${PROJECT_SLUG}`,
      }),
    );
    const kgEntityTwoData = toObject(toObject(kgEntityTwo.data).entity as JsonObject);
    const kgEntityTwoId = asString(kgEntityTwoData.id);
    addCheck("knowledge graph entity IDs present", kgEntityOneId.length > 0 && kgEntityTwoId.length > 0);
    const kgRelationship = ensureApiOk(
      "api /plan/kg/upsert-relationship creates seed relationship",
      await callApi("/api/plan/kg/upsert-relationship", {
        projectSlug: PROJECT_SLUG,
        sourceEntityId: kgEntityOneId,
        targetEntityId: kgEntityTwoId,
        relationshipType: "governs",
        state: "seed"
      }),
    );
    const relationshipData = toObject(kgRelationship.data);
    addCheck("knowledge graph relationship recorded", Boolean(relationshipData.relationship || relationshipData.rel));

    ensureApiOk(
      "api /gate/decision approve knowledge graph",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "knowledge_graph",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    ensureApiOk(
      "api /plan/series_bible_record records series bible",
      await callApi("/api/plan/series_bible_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 3 Series Bible",
        bibleSummary: "The novel premise scope and tone were established."
      }),
    );
    ensureApiOk(
      "api /gate/decision approve series_bible with OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "series_bible",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    ensureApiOk(
      "api /plan/pov_plan_record records story infrastructure",
      await callApi("/api/plan/pov_plan_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 3 Story Infrastructure",
        notes: "POV and structure plan recorded."
      }),
    );
    ensureApiOk(
      "api /gate/decision approve story infrastructure",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "story_infrastructure",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const arcResult = ensureToolOk(
      "story_arc_create creates arc for beats",
      await callTool("story_arc_create", {
        projectSlug: PROJECT_SLUG,
        scope: "book",
        title: "Phase 3 Test Arc",
      }),
    );
    arcId = asString((toObject(arcResult.data).arc as JsonObject).id);
    addCheck("story_arc_create returned arc id", arcId.length > 0);

    const beatmapResult = ensureApiOk(
      "api /plan/beatmap_record stores seven required beats",
      await callApi("/api/plan/beatmap_record", {
        projectSlug: PROJECT_SLUG,
        arcId,
        beats: requiredBeatNames.map((name, index) => ({
          beatName: name,
          summary: `Phase3 beat ${index + 1}: ${name}`,
          order: index + 1
        })),
      }),
    );
    const beatmapPayload = toObject(beatmapResult.data);
    addCheck("beatmap payload contains arc id", typeof beatmapPayload.arcId === "string" && beatmapPayload.arcId.length > 0);

    const beatsValidation = ensureToolOk(
      "story_arc_validate_seven_point validates required names",
      await callTool("story_arc_validate_seven_point", {
        projectSlug: PROJECT_SLUG,
        arcId,
      }),
    );
    const validationData = beatsValidation.data as JsonObject;
    addCheck("required beat names satisfied", (validationData.valid as boolean) === true);
    addCheck("no required beat names missing", toArray(validationData.missing).length === 0);

    ensureApiOk(
      "api /gate/decision approve beats",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "beats",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const kgJsonlExport = ensureApiOk(
      "api /plan/kg/export_jsonl returns jsonl export payload",
      await callApi("/api/plan/kg/export_jsonl", { projectSlug: PROJECT_SLUG }),
    );
    const kgExportPayload = toObject(toObject(kgJsonlExport.data).data);
    const graphFilesFromApi = toArray(kgExportPayload.files);
    addCheck("kg export payload includes files", graphFilesFromApi.length > 0, JSON.stringify(kgExportPayload));
    addCheck("kg export files exist on disk", graphFilesFromApi.every((entry) => {
      if (typeof entry !== "string") return false;
      return existsSync(join(PROJECT_GRAPH, entry));
    }));

    const mermaidExport = ensureApiOk(
      "api /plan/export_mermaid_diagrams creates mermaid export",
      await callApi("/api/plan/export_mermaid_diagrams", { projectSlug: PROJECT_SLUG }),
    );
    const mermaidRoot = toObject(mermaidExport.data);
    const mermaidPayload = Array.isArray(mermaidRoot.exports) ? mermaidRoot : toObject(mermaidRoot.data);
    const mermaidExports = toArray(mermaidPayload.exports);
    const firstMermaidPath = typeof toObject(mermaidExports[0] as JsonObject).filePath === "string"
      ? asString((toObject(mermaidExports[0] as JsonObject).filePath))
      : null;
    const mermaidFiles = mermaidExports
      .map((entry) => asString((toObject(entry as JsonObject).filePath)))
      .filter((path) => path.length > 0);
    addCheck("mermaid export created entries", mermaidExports.length > 0);
    addCheck(
      "mermaid file exists",
      mermaidFiles.every((filePath) => existsSync(toLocalWorkspacePath(filePath))) &&
        (firstMermaidPath !== null && firstMermaidPath.length > 0)
    );

    ensureApiOk(
      "api /gate/decision approve mermaid export",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "mermaid_export",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decision: "approved",
      }),
    );

    const finalStatus = ensureApiOk(
      "api /project/status final workflow stage",
      await callApi("/api/project/status", { projectSlug: PROJECT_SLUG }, "POST"),
    );
    const finalWorkflowData = toObject(toArray(toObject(finalStatus.data).projects)[0] as JsonObject).workflow as JsonObject;
    addCheck("final workflow stage is mermaid_export", asString(finalWorkflowData.currentStage) === "mermaid_export");
    addCheck("workflow allows completion", asString(finalWorkflowData.allowedNextAction) === "complete_workflow");
    addCheck("workflow has no blocker gate after all approvals", Boolean(finalWorkflowData.blockerGateStatus) === false);
  } catch (error) {
    addCheck("protocol smoke execution completed", false, String((error as Error).message));
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
