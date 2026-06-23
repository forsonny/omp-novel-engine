import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { storyOsAuthHeaders, storyOsBaseUrl, withGateDecisionConfirmation } from "./story-os-env";

type Check = { label: string; ok: boolean; details?: string };
type JsonObject = Record<string, unknown>;
type JsonArray = unknown[];

const API_ENDPOINT = storyOsBaseUrl();
const MCP_ENDPOINT = `${API_ENDPOINT}/mcp`;
const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const PROJECT_SLUG = `phase4-chapter-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PROJECT_DIR = join(WORKSPACE_ROOT, "stories", PROJECT_SLUG);
const PROJECT_DB = join(PROJECT_DIR, "canon", "canon.db");
const PROJECT_GRAPH_DIR = join(PROJECT_DIR, "canon", "graph");
const PROJECT_MEMORY_FILE = join(PROJECT_DIR, "memory", "memory.jsonl");
const SERVER_PACKAGE_VERSION = JSON.parse(readFileSync(join(WORKSPACE_ROOT, "docker", "story-os-mcp", "package.json"), "utf8")).version;

const checks: Array<Check> = [];
const addCheck = (label: string, ok: boolean, details = "") => checks.push({ label, ok, details });

const PRE_PROSE_GATES = [
  "structure_judge",
  "canon_continuity_judge",
  "character_genre_judge",
  "pre_prose_human_approval",
] as const;

const POST_PROSE_GATES = [
  "continuity_timeline_check",
  "canon_contradiction_check",
  "character_motivation_check",
  "chapter_goal_scene_job_check",
  "dialogue_naturalness_check",
  "narrator_distance_ban_scan",
  "plain_physical_prose_scan",
  "aiism_risk_report",
  "style_preservation_check",
] as const;

const CHAPTER_VARIANT_TYPES = ["canon-tight", "character-heavy", "plot-accelerated"] as const;
const REQUIRED_BEAT_NAMES = [
  "Hook",
  "First Plot Point",
  "First Pinch",
  "Midpoint",
  "Second Pinch",
  "Second Plot Point",
  "Resolution",
];
const POST_PROSE_FINDING_CATEGORIES = ["narrator-distance", "plain-prose", "dialogue", "AI-ism"] as const;

const toObject = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {});
const toArray = (value: unknown): JsonArray => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const toLocalWorkspacePath = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("/workspace/")) {
    return join(WORKSPACE_ROOT, normalized.slice("/workspace/".length));
  }
  return filePath;
};

const callRpc = async (method: string, params?: JsonObject): Promise<JsonObject | null> => {
  const response = await fetch(MCP_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...storyOsAuthHeaders() },
    body: JSON.stringify({ jsonrpc: "2.0", id: `phase4-${Math.random().toString(16).slice(2, 10)}`, method, params }),
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `RPC failed: ${response.status} ${response.statusText}`,
    };
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
    throw new Error(`tools/call(${name}) failed: ${String(error.code ?? "")}: ${String(error.message ?? "unknown")}`.trim());
  }

  const result = toObject(response.result);
  if (!result || typeof result !== "object") {
    throw new Error(`tools/call(${name}) missing structured result`);
  }

  return (toObject(result.structuredContent) as JsonObject) || result;
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
    return {
      ok: false,
      error: `API response empty: ${response.status} ${response.statusText}`,
    };
  }

  const payload = JSON.parse(raw) as JsonObject;
  if (!response.ok && payload.ok !== false) {
    return {
      ok: false,
      error: asString(payload.error) || `${response.status}`,
      code: asString(payload.code),
      ...payload,
    };
  }

  return payload;
};

const ensureOk = (label: string, result: JsonObject): JsonObject => {
  const ok = result.ok === true;
  addCheck(label, ok, JSON.stringify(result));
  if (!ok) throw new Error(`${label}: ${JSON.stringify(result)}`);
  return result;
};

const ensureFailureCode = (label: string, result: JsonObject, expectedCodes: string[]): boolean => {
  const ok = result.ok === false && expectedCodes.includes(asString(result.code));
  addCheck(label, ok, `code=${asString(result.code)}`);
  return ok;
};

const getProjectStatus = async (projectSlug: string) => ensureOk(
  "/api/project/status returns ok",
  await callApi("/api/project/status", { projectSlug }),
);

const getGateStatus = async (projectSlug: string, scopeType: string, scopeId: string) => ensureOk(
  `/api/gate/status returns ok for ${scopeType}/${scopeId}`,
  await callApi("/api/gate/status", { projectSlug, scopeType, scopeId }),
);

const getWorkflow = (statusResult: JsonObject): JsonObject => {
  const payload = toObject(statusResult.data);
  const workflow = toObject(payload.workflow);
  if (Object.keys(workflow).length > 0) return workflow;
  const projects = toArray(payload.projects);
  if (projects.length > 0) return toObject(toObject(projects[0]).workflow);
  return {};
};

const findGate = (gatePayload: JsonObject, gateType: string): JsonObject | null => {
  const root = toObject(gatePayload);
  const source = Array.isArray(root.gates) ? root : toObject(root.data);
  const gateRows = toArray(source.gates).map((entry) => toObject(entry));
  return gateRows.find((entry) => asString(entry.gateType || entry.gate_type) === gateType) ?? null;
};

const listJsonl = (filePath: string): JsonObject[] => {
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

const listJsonlFiles = (dir: string): string[] => {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
};

const ensureLocalFile = async (projectSlug: string, relativeOrAbsolute: string): Promise<boolean> => {
  const candidate = toLocalWorkspacePath(relativeOrAbsolute);
  if (existsSync(candidate)) return true;
  const fallback = join(join(WORKSPACE_ROOT, "stories", projectSlug), relativeOrAbsolute);
  return existsSync(fallback);
};

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
  let chapterId = `chapter-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
  let arcId = "";
  const variantIds = new Map<string, string>();
  let selectedVariantId = "";
  let chapterRunPath = "";

  try {
    addCheck("workspace root exists", existsSync(WORKSPACE_ROOT));
    addCheck("stories directory exists", existsSync(join(WORKSPACE_ROOT, "stories")));

    const health = ensureOk("health endpoint reachable", await callApi("/health", {}, "GET"));
    addCheck("health returns service", asString(health.service) === "story-os-mcp");
    addCheck("health returns version", asString(health.version) === SERVER_PACKAGE_VERSION);

    const projectCreate = ensureOk(
      "/api/project/create creates project",
      await callApi("/api/project/create", {
        slug: PROJECT_SLUG,
        title: "Phase 4 Chapter Workflow Project",
        mode: "standalone",
      }),
    );

    const projectData = toObject(toObject(projectCreate).data);
    addCheck("project create returned dbPath", typeof projectData.dbPath === "string" && projectData.dbPath.length > 0);
    addCheck("project create returned graphDir", typeof projectData.graphDir === "string" && projectData.graphDir.length > 0);
    addCheck("project DB created", existsSync(PROJECT_DB));

    const initialStatus = getProjectStatus(PROJECT_SLUG);
    const initialWorkflow = getWorkflow(await initialStatus);
    addCheck("planning starts at premise", asString(initialWorkflow.currentStage) === "premise");

    const blockedOutline = await callApi("/api/chapter/outline", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      chapterNumber: 1,
      title: "Blocked Chapter",
    });
    ensureFailureCode("chapter outline blocked before planning complete", blockedOutline, ["GATE_NOT_APPROVED", "MISSING_GATE"]);

    const blockedWorldbuilding = await callApi("/api/plan/worldbuilding_record", {
      projectSlug: PROJECT_SLUG,
      title: "Blocked worldbuilding probe",
      worldbuildingSummary: "This should be rejected until premise is approved.",
    });
    ensureFailureCode("worldbuilding blocked before premise decision", blockedWorldbuilding, ["MISSING_GATE", "GATE_NOT_APPROVED"]);

    const invalidPremiseDecision = await callApi("/api/gate/decision", {
      projectSlug: PROJECT_SLUG,
      gateType: "premise",
      decision: "approved",
      decisionSource: "bad_source",
      humanConfirmed: true,
    });
    ensureFailureCode("invalid premise decision source rejected", invalidPremiseDecision, ["UNAUTHORIZED_GATE_DECISION"]);

    ensureOk(
      "premise artifact recorded",
      await callApi("/api/plan/premise_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 4 Premise",
        premiseSummary: "A painter discovers they can alter memory through serialized prompts.",
      }),
    );

    ensureOk(
      "premise gate approved via human-confirmed OMP source",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "premise",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const statusAfterPremise = getProjectStatus(PROJECT_SLUG);
    const workflowAfterPremise = getWorkflow(await statusAfterPremise);
    addCheck("workflow advances to worldbuilding", asString(workflowAfterPremise.currentStage) === "worldbuilding");

    ensureOk(
      "worldbuilding artifact recorded",
      await callApi("/api/plan/worldbuilding_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 4 Worldbuilding",
        worldbuildingSummary: "A finite city-state under pressure of serial canon commitments.",
      }),
    );
    ensureOk(
      "worldbuilding gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "worldbuilding",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const sourceEntity = ensureOk(
      "knowledge-graph source entity recorded",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "location",
        name: `phase4-source-${PROJECT_SLUG}`,
      }),
    );
    const sourceEntityId = asString(toObject(sourceEntity.data as JsonObject).entityId) || asString(toObject((toObject(sourceEntity.data as JsonObject).entity as JsonObject)).id);

    const targetEntity = ensureOk(
      "knowledge-graph target entity recorded",
      await callApi("/api/plan/kg/upsert-entity", {
        projectSlug: PROJECT_SLUG,
        type: "character",
        name: `phase4-target-${PROJECT_SLUG}`,
      }),
    );
    const targetEntityId = asString(toObject(targetEntity.data as JsonObject).entityId) || asString(toObject((toObject(targetEntity.data as JsonObject).entity as JsonObject)).id);
    addCheck("knowledge graph entity ids are present", sourceEntityId.length > 0 && targetEntityId.length > 0);

    ensureOk(
      "knowledge graph relation recorded",
      await callApi("/api/plan/kg/upsert-relationship", {
        projectSlug: PROJECT_SLUG,
        sourceEntityId,
        targetEntityId,
        relationshipType: "knows",
      }),
    );

    ensureOk(
      "knowledge graph gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "knowledge_graph",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    ensureOk(
      "series bible artifact recorded",
      await callApi("/api/plan/series_bible_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 4 Series Bible",
        bibleSummary: "Canon and tone constraints established for serial-safe chapters.",
      }),
    );
    ensureOk(
      "series bible gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "series_bible",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    ensureOk(
      "story infrastructure artifact recorded",
      await callApi("/api/plan/pov_plan_record", {
        projectSlug: PROJECT_SLUG,
        title: "Phase 4 Story Infrastructure",
        infraSummary: "POV and chapter sequencing rules recorded.",
      }),
    );
    ensureOk(
      "story infrastructure gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "story_infrastructure",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const arcTool = ensureOk(
      "chapter arc created",
      await callTool("story_arc_create", {
        projectSlug: PROJECT_SLUG,
        scope: "book",
        title: "Phase 4 test arc",
      }),
    );
    arcId = asString(toObject(toObject(arcTool.data).arc).id) || asString(toObject(arcTool.data).id) || asString(toObject(arcTool).id);
    addCheck("arc id returned", arcId.length > 0);

    ensureOk(
      "seven-point beats recorded",
      await callApi("/api/plan/beatmap_record", {
        projectSlug: PROJECT_SLUG,
        arcId,
        beats: REQUIRED_BEAT_NAMES.map((name, index) => ({
          beatName: name,
          summary: `Phase4 beat ${index + 1}: ${name}`,
          order: index + 1,
          approved: true,
        })),
      }),
    );

    const beatsValidation = ensureOk(
      "seven-point validator passes all required beats",
      await callTool("story_arc_validate_seven_point", {
        projectSlug: PROJECT_SLUG,
        arcId,
      }),
    );
    const beatPayload = toObject(beatsValidation.data);
    addCheck("story_arc_validate_seven_point valid flag", beatPayload.valid === true);
    addCheck("story_arc_validate_seven_point no missing beats", asNumber(beatPayload.missingCount) === 0 || toArray(beatPayload.missing).length === 0);

    ensureOk(
      "beats gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "beats",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const kgExport = ensureOk(
      "knowledge graph jsonl export called",
      await callApi("/api/plan/kg/export_jsonl", { projectSlug: PROJECT_SLUG }),
    );
    const kgFiles = toArray(toObject(toObject(kgExport.data).data).files);
    addCheck("kg export returned files", kgFiles.length > 0);

    const mermaidExport = ensureOk(
      "mermaid export called",
      await callApi("/api/plan/export_mermaid_diagrams", { projectSlug: PROJECT_SLUG }),
    );
    const mermaidPayload = toObject((Array.isArray(toObject(mermaidExport.data).exports) ? mermaidExport.data : toObject(toObject(mermaidExport.data).data) as JsonObject));
    const mermaidEntries = toArray(mermaidPayload.exports);
    addCheck("mermaid export returned entries", mermaidEntries.length > 0);
    const mermaidPaths = mermaidEntries
      .map((entry) => asString((toObject(entry as JsonObject).filePath)))
      .filter((path) => path.length > 0)
      .map((path) => toLocalWorkspacePath(path));
    addCheck("mermaid export files exist", mermaidPaths.every((entry) => existsSync(entry)));

    ensureOk(
      "mermaid_export gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        gateType: "mermaid_export",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const completePlanningStatus = getProjectStatus(PROJECT_SLUG);
    const planningWorkflow = getWorkflow(await completePlanningStatus);
    addCheck("planning workflow complete action available", asString(planningWorkflow.allowedNextAction) === "complete_workflow");

    const outline = ensureOk(
      "chapter outline recorded after planning complete",
      await callApi("/api/chapter/outline", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        chapterNumber: 1,
        title: "Phase 4 Draft Chapter",
        outlineMarkdown: "# Chapter 4\n\nChapter outline for phase 4 chapter workflow smoke test.",
      }),
    );
    chapterId = asString((toObject(outline.data).chapterId ?? toObject(toObject(outline.data).chapter).id)) || chapterId;

    const chapterOutlinePayload = getProjectStatus(PROJECT_SLUG);
    const chapterGateStatus = getGateStatus(PROJECT_SLUG, "chapter", chapterId);
    const chapterGateRows = toArray((await chapterGateStatus).data ? toObject((await chapterGateStatus).data).gates : []);
    const preProseFound = PRE_PROSE_GATES.every((gateType) => chapterGateRows.some((entry) => {
      const gate = toObject(entry);
      return asString(gate.gateType || gate.gate_type) === gateType;
    }));
    addCheck("chapter outline created all pre-prose gates", preProseFound);

    const earlyVariantCreate = await callApi("/api/chapter/variant/create", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      variantType: CHAPTER_VARIANT_TYPES[0],
      purpose: "premature attempt",
      markdownText: "# Early",
      changedStructurally: "Early",
      changedEmotionally: "Early",
      changedInPacing: "Early",
      canonRisk: "Low",
      continuityRisk: "Low",
      bestUseCase: "Fallback",
      reasonToChoose: "Fallback",
      reasonNotToChoose: "Fallback",
    });
    ensureFailureCode("variant creation blocked before pre-prose approval", earlyVariantCreate, ["GATE_NOT_APPROVED", "MISSING_GATE"]);

    for (const gateType of PRE_PROSE_GATES) {
      ensureOk(
        `pre-prose gate approved: ${gateType}`,
        await callApi("/api/gate/decision", {
          projectSlug: PROJECT_SLUG,
          scopeType: "chapter",
          scopeId: chapterId,
          gateType,
          decision: "approved",
          decisionSource: "omp_ui_confirmation",
          humanConfirmed: true,
          notes: `approved ${gateType}`,
        }),
      );
    }

    const preProseStatus = await getGateStatus(PROJECT_SLUG, "chapter", chapterId);
    addCheck(
      "all pre-prose gates approved",
      PRE_PROSE_GATES.every((gateType) => asString(findGate(preProseStatus, gateType)?.status) === "approved"),
    );

    const variantDefs = [
      {
        variantType: CHAPTER_VARIANT_TYPES[0],
        purpose: "Canon-tight pass: preserve setting facts and tighten transitions.",
        changedStructurally: "Tightens scene transitions and keeps plot mechanics intact.",
        changedEmotionally: "Sharpened emotional accountability between protagonists.",
        changedInPacing: "Keeps pace steady with firm structural checkpoints.",
        canonRisk: "Low; constrained by approved canon facts.",
        continuityRisk: "Moderate if timing edges are misread.",
        bestUseCase: "Use when canon precision must dominate.",
        reasonToChoose: "Best preserves story invariants while still resolving arc pressure.",
        reasonNotToChoose: "Least experimental; conservative rhythm.",
      },
      {
        variantType: CHAPTER_VARIANT_TYPES[1],
        purpose: "Character-heavy pass: elevate POV and emotional tension.",
        changedStructurally: "Reordered POV anchors around the same plot milestones.",
        changedEmotionally: "Amplified internal conflict and relationship stakes.",
        changedInPacing: "Slower scene beats to deepen character reactions.",
        canonRisk: "Low-to-moderate; outcomes unchanged.",
        continuityRisk: "Requires careful relationship-state continuity.",
        bestUseCase: "Use when emotional payoff is primary.",
        reasonToChoose: "Maximizes reader empathy and voice clarity.",
        reasonNotToChoose: "May reduce action immediacy.",
      },
      {
        variantType: CHAPTER_VARIANT_TYPES[2],
        purpose: "Plot-accelerated pass: increase forward momentum and momentum hooks.",
        changedStructurally: "Compacts scenes and advances causal links between events.",
        changedEmotionally: "Shifts weight toward urgency and consequence.",
        changedInPacing: "Faster, with reduced reflective pauses.",
        canonRisk: "Moderate; ensure sequence causality remains intact.",
        continuityRisk: "Lower risk to timeline consistency if anchor beats are kept.",
        bestUseCase: "Use when chapter should drive serial forward.",
        reasonToChoose: "Improves urgency and pagination density.",
        reasonNotToChoose: "Can reduce breathing room for subtext.",
      },
    ];

    for (const definition of variantDefs) {
      const created = ensureOk(
        `variant created (${definition.variantType})`,
        await callApi("/api/chapter/variant/create", {
          projectSlug: PROJECT_SLUG,
          chapterId,
          variantType: definition.variantType,
          purpose: definition.purpose,
          markdownText: `# ${definition.variantType}\n\nSmoke variant body for ${definition.variantType}.`,
          changedStructurally: definition.changedStructurally,
          changedEmotionally: definition.changedEmotionally,
          changedInPacing: definition.changedInPacing,
          canonRisk: definition.canonRisk,
          continuityRisk: definition.continuityRisk,
          bestUseCase: definition.bestUseCase,
          reasonToChoose: definition.reasonToChoose,
          reasonNotToChoose: definition.reasonNotToChoose,
        }),
      );

      const variant = toObject(toObject(created.data).variant);
      const variantId = asString(variant.id);
      const variantType = asString(variant.variant_type);
      addCheck(`variant id returned for ${variantType}`, variantId.length > 0);
      addCheck(`variant report fields populated for ${variantType}`,
        variant.purpose &&
          asString(variant.changed_structurally).length > 0 &&
          asString(variant.changed_emotionally).length > 0 &&
          asString(variant.changed_in_pacing).length > 0 &&
          asString(variant.canon_risk).length > 0 &&
          asString(variant.continuity_risk).length > 0 &&
          asString(variant.best_use_case).length > 0 &&
          asString(variant.reason_to_choose).length > 0 &&
          asString(variant.reason_not_to_choose).length > 0,
        JSON.stringify(variant),
      );
      variantIds.set(variantType, variantId);
    }

    const variantList = ensureOk(
      "chapter variant list returns all variants",
      await callApi("/api/chapter/variant/list", {
        projectSlug: PROJECT_SLUG,
        chapterId,
      }),
    );
    const variants = toArray(toObject(variantList.data).variants).map((entry) => toObject(entry));
    const variantTypes = variants.map((entry) => asString(entry.variant_type));
    addCheck("exactly three variants created", variants.length === CHAPTER_VARIANT_TYPES.length);
    addCheck(
      "all required variant types present",
      CHAPTER_VARIANT_TYPES.every((variantType) => variantTypes.includes(variantType)),
      `found=${JSON.stringify(variantTypes)}`,
    );
    addCheck("selected variant absent before choice", toObject(variantList.data).selectedVariantId === null);

    const duplicateVariant = await callApi("/api/chapter/variant/create", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      variantType: CHAPTER_VARIANT_TYPES[0],
      purpose: "dup attempt",
      markdownText: "# duplicate",
      changedStructurally: "dup",
      changedEmotionally: "dup",
      changedInPacing: "dup",
      canonRisk: "dup",
      continuityRisk: "dup",
      bestUseCase: "dup",
      reasonToChoose: "dup",
      reasonNotToChoose: "dup",
    });
    ensureFailureCode("duplicate variant type rejected", duplicateVariant, ["DUPLICATE_VARIANT_TYPE"]);

    const invalidVariantType = await callApi("/api/chapter/variant/create", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      variantType: "experimental",
      purpose: "invalid attempt",
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
    ensureFailureCode("fourth variant rejected", invalidVariantType, ["INVALID_PARAMS"]);

    const ranking = ensureOk(
      "variants ranked",
      await callApi("/api/chapter/variant/rank", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        rankings: variants.map((variant, index) => ({
          variantId: asString(variant.id),
          rankScore: 100 - index,
          rankingReason: `Ranking reason for ${asString(variant.variant_type)}`,
        })),
      }),
    );
    const rankedPayload = ranking.data as JsonObject;
    const choiceGate = toObject(rankedPayload.choiceGate);
    addCheck("variant ranking returns three ranked variants", toArray(rankedPayload.variants).length === CHAPTER_VARIANT_TYPES.length);
    addCheck("ranking created chapter_variant_choice gate", asString(choiceGate.gateType || choiceGate.gate_type) === "chapter_variant_choice");
    addCheck("chapter_variant_choice gate starts pending", asString(choiceGate.status) === "pending");

    selectedVariantId = variantIds.get(CHAPTER_VARIANT_TYPES[0]) || "";
    const selectBlocked = await callApi("/api/chapter/variant/select", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      variantId: selectedVariantId,
      selectionReason: "attempt before gate provenance",
    });
    ensureFailureCode("variant select blocked until chapter_variant_choice decision", selectBlocked, ["GATE_NOT_APPROVED", "MISSING_GATE"]);

    const selectionGateDecision = ensureOk(
      "chapter_variant_choice gate approved via gate decision",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        scopeType: "chapter",
        scopeId: chapterId,
        gateType: "chapter_variant_choice",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
        decisionMetadata: {
          selectedVariantId,
          variantId: selectedVariantId,
          reason: "selected for smoke test",
          rationale: "manual",
        },
        notes: "selected first variant",
      }),
    );
    addCheck("chapter_variant_choice decision recorded", Object.keys(toObject(toObject(selectionGateDecision.data).decision)).length > 0);

    const selected = ensureOk(
      "selected variant recorded after gate approval",
      await callApi("/api/chapter/variant/select", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        variantId: selectedVariantId,
        selectionReason: "selected for draft review",
      }),
    );
    const selectedPayload = toObject(selected.data);
    addCheck("selected variant returned", asString(selectedPayload.variantId || asString(toObject(selectedPayload.variant).id)) === selectedVariantId);

    const draft = ensureOk(
      "selected draft revision recorded",
      await callApi("/api/chapter/draft", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        markdownText: "# Selected draft\n\nSelected draft revision for smoke testing.",
        draftStage: "revision",
        status: "draft",
        revisionNotes: "preliminary draft for post-prose checks",
      }),
    );
    const draftPayload = toObject(draft.data);
    const draftId = asString(toObject(draftPayload.draft).id || toObject(draftPayload).draftId);
    addCheck("draft id returned", draftId.length > 0);

    const preCompletionBlocked = await callApi("/api/chapter/complete", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      completionNotes: "attempt before post-prose gates",
    });
    ensureFailureCode("chapter complete blocked before post-prose gates", preCompletionBlocked, ["GATE_NOT_APPROVED", "MISSING_GATE", "GATE_BLOCKED"]);

    const auditRun = ensureOk(
      "post-prose audit run recorded",
      await callApi("/api/audit/run", {
        projectSlug: PROJECT_SLUG,
        scopeType: "chapter",
        scopeId: chapterId,
        auditType: "post_prose_review",
        status: "completed",
        summary: {
          purpose: "phase 4 smoke",
          categories: POST_PROSE_FINDING_CATEGORIES,
        },
      }),
    );
    chapterRunPath = asString(toObject(auditRun.data).auditRunId) || asString(toObject(toObject(auditRun.data).auditRun).id);

    const auditRunPayload = toObject(auditRun.data);
    const runId = asString(auditRunPayload.auditRunId) || asString(toObject(auditRunPayload.auditRun).id);
    addCheck("audit run id returned", runId.length > 0);

    for (const category of POST_PROSE_FINDING_CATEGORIES) {
      ensureOk(
        `audit finding recorded for ${category}`,
        await callApi("/api/audit/finding", {
          projectSlug: PROJECT_SLUG,
          auditRunId: runId,
          category,
          severity: "medium",
          quoteOrLocation: `fixture-${category}`,
          whyFlagged: `Smoke finding for ${category}`,
          fixStrategy: `Review and align with ${category} rubric`,
          findingKey: `phase4-${category}`,
          occurrenceCount: 1,
        }),
      );
    }

    const report = ensureOk(
      "audit report retrievable",
      await callApi("/api/audit/report", {
        projectSlug: PROJECT_SLUG,
        scopeType: "chapter",
        scopeId: chapterId,
      }),
    );
    const reportPayload = toObject(report.data);
    addCheck("audit report has findings", toArray(reportPayload.findings).length >= POST_PROSE_FINDING_CATEGORIES.length);

    const inventory = ensureOk(
      "occurrence inventory export retrievable",
      await callApi("/api/audit/occurrences", {
        projectSlug: PROJECT_SLUG,
        scopeType: "chapter",
        scopeId: chapterId,
      }),
    );
    const inventoryPayload = toObject(inventory.data);
    const byCategory = toObject(inventoryPayload.byCategory);
    addCheck("inventory has narrator-distance category", Object.prototype.hasOwnProperty.call(byCategory, "narrator-distance"));
    addCheck("inventory has plain-prose category", Object.prototype.hasOwnProperty.call(byCategory, "plain-prose") || Object.prototype.hasOwnProperty.call(byCategory, "plain_physical_prose"));
    addCheck("inventory has dialogue category", Object.prototype.hasOwnProperty.call(byCategory, "dialogue"));
    addCheck("inventory has AI-ism category", Object.prototype.hasOwnProperty.call(byCategory, "AI-ism") || Object.prototype.hasOwnProperty.call(byCategory, "aiism") || Object.prototype.hasOwnProperty.call(byCategory, "AIism"));

    for (const gateType of POST_PROSE_GATES) {
      ensureOk(
        `post-prose gate approved: ${gateType}`,
        await callApi("/api/gate/decision", {
          projectSlug: PROJECT_SLUG,
          scopeType: "chapter",
          scopeId: chapterId,
          gateType,
          decision: "approved",
          decisionSource: "omp_ui_confirmation",
          humanConfirmed: true,
          notes: `approved ${gateType}`,
        }),
      );
    }

    const blockedAfterPostGates = await callApi("/api/chapter/complete", {
      projectSlug: PROJECT_SLUG,
      chapterId,
      completionNotes: "attempt before human final approval",
    });
    ensureFailureCode("chapter complete blocked before human_final_approval", blockedAfterPostGates, ["GATE_NOT_APPROVED", "MISSING_GATE", "GATE_BLOCKED"]);

    ensureOk(
      "human_final_approval gate approved",
      await callApi("/api/gate/decision", {
        projectSlug: PROJECT_SLUG,
        scopeType: "chapter",
        scopeId: chapterId,
        gateType: "human_final_approval",
        decision: "approved",
        decisionSource: "omp_ui_confirmation",
        humanConfirmed: true,
      }),
    );

    const complete = ensureOk(
      "chapter marked complete",
      await callApi("/api/chapter/complete", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        completionNotes: "Phase 4 smoke complete.",
      }),
    );
    const completePayload = toObject(complete.data);
    const completedChapter = toObject(completePayload.chapter);
    addCheck("chapter status is complete", asString(completedChapter.status) === "complete");
    const finalMarkdownPath = asString(completedChapter.final_markdown_path);
    addCheck("complete response has final markdown path", finalMarkdownPath.length > 0);
    addCheck("complete final markdown exists", finalMarkdownPath.length > 0 && (await ensureLocalFile(PROJECT_SLUG, finalMarkdownPath)));

    const exportResult = ensureOk(
      "chapter markdown explicitly exported",
      await callApi("/api/chapter/export", {
        projectSlug: PROJECT_SLUG,
        chapterId,
        outputPath: join("chapters", chapterId, "exported-final.md"),
      }),
    );
    const exportPayload = toObject(exportResult.data);
    const targetPath = asString(exportPayload.targetPath);
    addCheck("chapter export target path returned", targetPath.length > 0);
    addCheck("chapter export target exists", targetPath.length > 0 && (await ensureLocalFile(PROJECT_SLUG, targetPath)));

    const finalGateStatus = await getGateStatus(PROJECT_SLUG, "chapter", chapterId);
    const humanFinal = findGate(finalGateStatus, "human_final_approval");
    addCheck("human_final_approval gate approved at end", asString(humanFinal?.status) === "approved");

    const chapterRows = listJsonlFiles(PROJECT_GRAPH_DIR);
    addCheck("chapter graph jsonl files exist", chapterRows.some((name) => name === "chapters.jsonl") &&
      chapterRows.some((name) => name === "chapter_variants.jsonl") &&
      chapterRows.some((name) => name === "chapter_drafts.jsonl") &&
      chapterRows.some((name) => name === "chapter_exports.jsonl"),
      `files=${JSON.stringify(chapterRows)}`,
    );

    const chapterFileLines = listJsonl(join(PROJECT_GRAPH_DIR, "chapters.jsonl"));
    const variantsFileLines = listJsonl(join(PROJECT_GRAPH_DIR, "chapter_variants.jsonl"));
    const draftsFileLines = listJsonl(join(PROJECT_GRAPH_DIR, "chapter_drafts.jsonl"));
    const exportsFileLines = listJsonl(join(PROJECT_GRAPH_DIR, "chapter_exports.jsonl"));

    const chapterActions = chapterFileLines.map((row) => asString(row.action));
    const variantActions = variantsFileLines.map((row) => asString(row.action));
    const draftActions = draftsFileLines.map((row) => asString(row.action));
    const exportActions = exportsFileLines.map((row) => asString(row.action));

    addCheck("chapter outline graph action recorded", chapterActions.includes("chapter_outline_record"));
    addCheck("chapter complete graph action recorded", chapterActions.includes("chapter_complete_mark"));
    addCheck("chapter variant create graph action recorded", variantActions.filter((action) => action === "chapter_variant_create").length === CHAPTER_VARIANT_TYPES.length);
    addCheck("chapter variant select graph action recorded", variantActions.includes("chapter_variant_select"));
    addCheck("chapter draft record graph action recorded", draftActions.includes("chapter_draft_record"));
    addCheck("chapter export graph action recorded", exportActions.includes("chapter_markdown_exported"));

    addCheck("memory file exists", existsSync(PROJECT_MEMORY_FILE));
    const memoryRows = listJsonl(PROJECT_MEMORY_FILE);
    addCheck("memory includes chapter_completed action", memoryRows.some((entry) => asString(entry.action) === "chapter_completed" && asString(entry.chapterId) === chapterId));

    addCheck("project status remains queryable after completion", (await getProjectStatus(PROJECT_SLUG)).ok === true);
  } catch (error) {
    addCheck("phase4 chapter workflow execution", false, String((error as Error).message));
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
