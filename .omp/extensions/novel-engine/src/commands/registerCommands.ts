import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { storyOsGet, storyOsPost } from "../clients/storyOsClient";
import {
  REQUIRED_NOVEL_SKILLS,
  discoverBundledSkills,
  loadNovelEngineConfig,
  readMcpConfigStatus,
  formatNovelStatusReport
} from "../config/novelEngineConfig";
import {
  serialArcScopes,
  serialRecapAudiences,
  type SerialArcScope,
  type SerialRecapAudience
} from "../shared/types";

type JsonMap = Record<string, unknown>;
type StageWorkflow = {
  currentStage: string;
  allowedNextAction: string;
  blockerGateType?: string | null;
  blockerGateId?: string | null;
  blockerGateStatus?: string | null;
};
type PendingGateSummary = {
  gateId: string;
  gateType: string;
  status: string;
  scopeType: string;
  scopeId: string;
};
type ChapterWorkflowSummary = {
  chapterStatus: "blocked" | "ready" | "error";
  variantCount: number;
  selectedVariantId: string;
  blockers: string[];
  errors: string[];
};
type Choice<T extends string> = {
  label: string;
  value: T;
};
type CommandMessageContext = {
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  };
};

type SerialCommandContext = {
  slug: string;
  mode: string;
  status: unknown;
};

const asObject = (value: unknown): JsonMap => (
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonMap
    : {}
);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
const asChoiceText = (value: unknown): string => {
  const direct = asString(value);
  if (direct) return direct;
  const record = asObject(value);
  return asString(record.value) || asString(record.label);
};
const sendCommandMessage = (
  ctx: CommandMessageContext,
  content: string
) => {
  ctx.ui.notify(content, "info");
};
const isStoryCallOk = (value: unknown): boolean => {
  const root = asObject(value);
  if (root.ok !== true) return false;
  const payload = asObject(root.data);
  if (typeof payload.ok === "boolean") {
    return payload.ok === true;
  }
  return true;
};

const unwrapStoryData = (value: unknown): JsonMap => {
  const root = asObject(value);
  const payload = asObject(root.data);
  const first = Object.keys(payload).length > 0 ? payload : root;
  return first.ok === true && "data" in first ? asObject(first.data) : first;
};

const storyErrorText = (value: unknown): string => {
  const root = asObject(value);
  const payload = unwrapStoryData(value);
  return asString(payload.error) || asString(payload.code) || asString(root.error);
};

const readProjectWorkflowSummary = (projectStatus: unknown) => {
  if (!isStoryCallOk(projectStatus)) {
    return {
      pendingGateCount: 0,
      pendingGates: [],
      workflow: null as StageWorkflow | null
    };
  }

  const payload = unwrapStoryData(projectStatus);
  const projectRows = asArray(payload.projects).map((entry) => asObject(entry));
  if (projectRows.length === 0) {
    return {
      pendingGateCount: 0,
      pendingGates: [],
      workflow: null as StageWorkflow | null
    };
  }

  const firstProject = projectRows[0];
  const pendingGates = asArray(firstProject.pendingGates)
    .map((entry) => asObject(entry))
    .map((entry) => normalizeStoryGate(entry));

  const workflowData = asObject(firstProject.workflow);
  return {
    pendingGateCount: pendingGates.length,
    pendingGates,
    workflow: Object.keys(workflowData).length > 0 ? workflowData as StageWorkflow : null
  };
};

const resolveProjectSlug = (projectStatus: unknown): string => {
  const payload = unwrapStoryData(projectStatus);
  const projectRows = asArray(payload.projects).map((entry) => asObject(entry));
  const firstProject = projectRows[0];
  if (!firstProject) return "";

  const project = asObject(firstProject.project);
  return asString(project.slug) || asString(firstProject.slug);
};

const selectChoice = async <T extends string>(
  ctx: {
    ui: {
      select?: (label: string, options: string[]) => Promise<unknown>;
      input: (label: string, initialValue?: string) => Promise<string>;
    };
  },
  label: string,
  choices: Array<Choice<T>>
): Promise<T | ""> => {
  const labels = choices.map((choice) => choice.label);
  const selection = typeof ctx.ui.select === "function"
    ? await ctx.ui.select(label, labels)
    : await ctx.ui.input(`${label} (${labels.join(", ")})`, labels[0]);
  const selectionText = asChoiceText(selection);
  const selectionIndex = asNumber(selection);
  const fromIndex = Number.isInteger(selectionIndex) ? choices[selectionIndex] : undefined;
  const matched = choices.find((choice) => choice.label === selectionText || choice.value === selectionText) ?? fromIndex;
  return matched?.value ?? "";
};

const findPendingChapterGates = (projectStatus: unknown): PendingGateSummary[] => (
  readProjectWorkflowSummary(projectStatus).pendingGates.filter((gate) => gate.scopeType === "chapter")
);

const parseChapterIdArg = (raw: unknown): string => {
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";
  const record = asObject(raw);
  return asString(record.chapterId || record.chapter_id || record.chapter || record.id);
};

const createChapterId = (): string => `phase4-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;

const parseChapterNumber = (input: string): number => {
  const value = Number.parseInt(input, 10);
  return Number.isFinite(value) && value > 0 ? value : 1;
};

const ensureChapterRecord = async (
  mode: "draft" | "revise",
  projectSlug: string,
  requestedChapterId: string,
  pendingChapterGates: PendingGateSummary[],
  cwd: string,
  ctx: { ui: { input: (label: string, initialValue?: string) => Promise<string> } }
) => {
  let chapterId = requestedChapterId || asString(pendingChapterGates[0]?.scopeId);
  let chapterCreated = false;

  if (!chapterId && mode === "draft") {
    chapterId = createChapterId();
    const title = await ctx.ui.input("Chapter title (optional)", "");
    const chapterNumber = parseChapterNumber(await ctx.ui.input("Chapter number", "1"));
    const outlinePayload: Record<string, unknown> = { projectSlug, chapterId, chapterNumber };
    if (title) outlinePayload.title = title;
    const outlineResult = await storyOsPost("/api/chapter/outline", outlinePayload, { cwd });
    if (!isStoryCallOk(outlineResult)) {
      throw new Error(`Unable to start chapter workflow for ${chapterId}: ${storyErrorText(outlineResult)}`);
    }
    chapterCreated = true;
    return { chapterId, chapterCreated };
  }

  if (!chapterId && mode === "revise") {
    const fromInput = await ctx.ui.input("Chapter ID", "");
    chapterId = fromInput.trim();
  }

  if (!chapterId) {
    throw new Error("Chapter ID is required to continue chapter workflow.");
  }

  const probe = await storyOsPost("/api/chapter/variant/list", { projectSlug, chapterId }, { cwd });
  const probePayload = unwrapStoryData(probe);
  if (!isStoryCallOk(probe)) {
    if (asString(probePayload.code) === "CHAPTER_NOT_FOUND" && mode === "draft") {
      const title = await ctx.ui.input("Chapter title (optional)", "");
      const chapterNumber = parseChapterNumber(await ctx.ui.input("Chapter number", "1"));
      const outlinePayload: Record<string, unknown> = { projectSlug, chapterId, chapterNumber };
      if (title) outlinePayload.title = title;
      const outlineResult = await storyOsPost("/api/chapter/outline", outlinePayload, { cwd });
      if (!isStoryCallOk(outlineResult)) {
        throw new Error(`Unable to start chapter workflow for ${chapterId}: ${storyErrorText(outlineResult)}`);
      }
      chapterCreated = true;
    } else {
      throw new Error(`Unable to find chapter ${chapterId}: ${storyErrorText(probe)}`);
    }
  }

  return { chapterId, chapterCreated };
};

const summarizeChapterWorkflow = async (
  projectSlug: string,
  chapterId: string,
  cwd: string
): Promise<ChapterWorkflowSummary> => {
  const blockersResponse = await storyOsPost("/api/gate/blockers", {
    projectSlug,
    scopeType: "chapter",
    scopeId: chapterId
  }, { cwd });
  const blockersPayload = unwrapStoryData(blockersResponse);
  if (!isStoryCallOk(blockersResponse)) {
    return {
      chapterStatus: "error",
      variantCount: 0,
      selectedVariantId: "",
      blockers: [],
      errors: [`Unable to inspect chapter gate blockers: ${asString(blockersPayload.error) || asString(blockersPayload.code)}`]
    };
  }

  const blockers = asArray(blockersPayload.blockers).map((entry) => asObject(entry));
  const blockerLines = blockers
    .map((entry) => {
      const blocker = asObject(entry.blocker);
      const gateType = asString(entry.gateType);
      const status = asString(blocker.status || entry.status);
      return `${gateType}:${status}`;
    })
    .filter((entry) => entry.endsWith(":pending") || entry.endsWith(":blocked_by_audit") || entry.endsWith(":needs_revision") || entry.endsWith(":rejected"));

  const variantsResponse = await storyOsPost("/api/chapter/variant/list", { projectSlug, chapterId }, { cwd });
  const variantsPayload = unwrapStoryData(variantsResponse);
  if (!isStoryCallOk(variantsResponse)) {
    return {
      chapterStatus: "error",
      variantCount: 0,
      selectedVariantId: "",
      blockers: [],
      errors: [`Unable to inspect chapter variants: ${asString(variantsPayload.error) || asString(variantsPayload.code)}`]
    };
  }

  const variants = asArray(variantsPayload.variants).map((entry) => asObject(entry));
  const selectedVariantId = asString(variantsPayload.selectedVariantId);
  const status = asNumber(variantsPayload.variantCount);
  return {
    chapterStatus: blockerLines.length > 0 ? "blocked" : "ready",
    variantCount: Number.isFinite(status) ? status : variants.length,
    selectedVariantId,
    blockers: blockerLines,
    errors: []
  };
};

const resolveCurrentSerialProject = async (cwd: string): Promise<SerialCommandContext | null> => {
  const status = await storyOsPost("/api/project/status", {}, { cwd });
  if (!isStoryCallOk(status)) return null;

  const payload = unwrapStoryData(status);
  const projects = asArray(payload.projects).map((entry) => asObject(entry));
  const firstProject = projects[0];
  if (!firstProject) return null;
  const project = asObject(firstProject.project);
  const slug = asString(project.slug) || asString(firstProject.slug);
  if (!slug) return null;

  const mode = asString(project.mode) || asString(firstProject.mode) || "unknown";
  return {
    slug,
    mode,
    status
  };
};

const collectProjectGates = (projectStatus: unknown): PendingGateSummary[] => {
  const summary = readProjectWorkflowSummary(projectStatus);
  return summary.pendingGates;
};

const collectPathsFromPayload = (value: unknown, depth = 0): string[] => {
  if (depth > 2) return [];
  if (!value || typeof value !== "object") return [];

  const found: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value as unknown[]) {
      if (typeof entry === "string") {
        const candidate = entry.trim();
        if (candidate) found.push(candidate);
      } else {
        found.push(...collectPathsFromPayload(entry, depth + 1));
      }
    }
    return [...new Set(found)];
  }

  const record = asObject(value);

  for (const [key, raw] of Object.entries(record)) {
    const candidate = asString(raw);
    if (candidate && (key.toLowerCase().includes("path") || key.toLowerCase().includes("file")) && candidate) {
      found.push(candidate);
    }

    if (raw && typeof raw === "object") {
      found.push(...collectPathsFromPayload(raw, depth + 1));
    }
  }

  return [...new Set(found)];
};

const normalizeGateRows = (value: unknown): PendingGateSummary[] => {
  const record = asObject(value);
  const gateCandidates = asArray(record.pendingGates).concat(asArray(record.gates));
  const rootGate = asObject(record.gate);
  if (Object.keys(rootGate).length > 0) {
    gateCandidates.push(rootGate);
  }

  return gateCandidates
    .map((entry) => asObject(entry))
    .map((entry) => normalizeStoryGate(entry))
    .filter((entry) => entry.gateId || entry.gateType || entry.scopeType || entry.scopeId || entry.status);
};

const normalizeBlockers = (value: unknown): string[] => {
  const record = asObject(value);
  const blockerEntries = asArray(record.blockers);
  return blockerEntries
    .map((entry) => {
      const blocker = asObject(entry);
      const source = asObject(blocker.blocker);
      const gateType = asString(blocker.gateType || source.gateType || source.type || blocker.type || source.gate_type || blocker.gate_type);
      const status = asString(blocker.status || source.status);
      const scope = asString(blocker.scopeId || source.scopeId || source.scope_id || blocker.scopeType || source.scope_type);
      return gateType ? `${gateType}${status ? `:${status}` : ""}${scope ? ` (${scope})` : ""}` : "";
    })
    .filter((entry) => entry.length > 0);
};

const formatSerialGuidance = (payload: unknown, projectStatus: unknown, route: string): string[] => {
  const data = unwrapStoryData(payload);
  const nextAction = asString((data as { nextAction?: unknown }).nextAction || asString((data as { allowedNextAction?: unknown }).allowedNextAction));
  const projectGates = collectProjectGates(projectStatus);
  const responseGates = normalizeGateRows(data);
  const gateRows = [...responseGates, ...projectGates].map((entry) => {
    const scope = `${entry.scopeType || "project"}/${entry.scopeId || "n/a"}`;
    return `${entry.gateType || "gate"} (${scope}) => ${entry.status || "pending"}`;
  });

  const uniqueGateRows = [...new Set(gateRows)];
  const blockers = [...new Set(normalizeBlockers(data))];
  const paths = collectPathsFromPayload(data).filter((path) => path.length > 0);

  const lines = [
    `Action: ${asString(data.action || "serial command")}`,
    `Gates: ${uniqueGateRows.length > 0 ? uniqueGateRows.join("; ") : "none"}`,
    `Blockers: ${blockers.length > 0 ? blockers.join("; ") : "none"}`
  ];

  if (paths.length > 0) {
    lines.push(`Paths: ${paths.join(", ")}`);
  } else {
    lines.push(`Paths: ${route}`);
  }

  if (nextAction) {
    lines.push(`Next action: ${nextAction}`);
  }

  return lines;
};

const appendSerialEntry = async (
  api: ExtensionAPI,
  commandName: string,
  cwd: string,
  projectSlug: string,
  request: JsonMap,
  response: unknown
) => {
  await api.appendEntry("novel-engine-serial-command", {
    at: Date.now(),
    commandName,
    cwd,
    projectSlug,
    request,
    response
  });
};

const postSerialCommand = async (
  api: ExtensionAPI,
  commandName: string,
  route: string,
  projectContext: SerialCommandContext,
  request: JsonMap,
  cwd: string,
) => {
  const response = await storyOsPost(route, request, { cwd });
  await appendSerialEntry(api, commandName, cwd, projectContext.slug, request, response);
  if (!isStoryCallOk(response)) {
    const payload = unwrapStoryData(response);
    return {
      message: `${commandName} failed: ${asString(payload.error) || asString(payload.code) || "unknown error"}.`,
      guidance: [
        "Gates: none",
        "Blockers: request failed",
        `Paths: ${route}`
      ]
    };
  }

  const payload = unwrapStoryData(response);
  const message = asString(payload.message || payload.resultMessage || asString(payload.title));
  const effectiveMessage = message.length > 0 ? message : `${commandName} completed.`;
  return {
    message: effectiveMessage,
    guidance: formatSerialGuidance(payload, projectContext.status, route)
  };
};

export function registerCommands(pi: ExtensionAPI) {
  pi.registerCommand("novel:status", {
    description: "Show OMP Novel Engine status, MCP health, and pending human gates.",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const config = loadNovelEngineConfig(cwd);
      const mcpConfig = readMcpConfigStatus(cwd);
      const discoveredSkills = discoverBundledSkills(cwd);
      const missingSkills = REQUIRED_NOVEL_SKILLS.filter((skill) => !discoveredSkills.includes(skill));
      const health = await storyOsGet("/health", { cwd });
      const projectStatus = health.ok ? await storyOsPost("/api/project/status", {}, { cwd }) : null;
      const projectStatusReady = projectStatus ? isStoryCallOk(projectStatus) : false;
      const workflowSummary = health.ok && projectStatus
        ? readProjectWorkflowSummary(projectStatus)
        : { pendingGateCount: 0, pendingGates: [], workflow: null as StageWorkflow | null };
      const chapterGates = health.ok && projectStatus ? findPendingChapterGates(projectStatus) : [];
      const projectStatusText = health.ok
        ? projectStatusReady
          ? "queried"
          : `failed (${asString(unwrapStoryData(projectStatus).error) || asString(unwrapStoryData(projectStatus).code) || "unknown error"})`
        : "skipped";

      const configIssues = [...config.parseErrors, ...mcpConfig.parseErrors];
      const mcpProtocolEnabled =
        mcpConfig.ompProjectConfig.enabled === true &&
        mcpConfig.portableConfig.enabled === true &&
        mcpConfig.enabledMatch &&
        mcpConfig.urlMatch;
      const healthState = health.ok ? "online" : "offline";
      const degraded =
        configIssues.length > 0 ||
        !mcpConfig.ompProjectConfig.exists ||
        !mcpConfig.portableConfig.exists ||
        mcpConfig.ompProjectConfig.enabled === null ||
        mcpConfig.portableConfig.enabled === null ||
        !mcpProtocolEnabled ||
        missingSkills.length > 0 ||
        !config.loaded;
      const statusState: "offline" | "degraded" | "online" =
        healthState === "offline"
          ? "offline"
          : degraded
            ? "degraded"
            : "online";

      const report = [
        `Extension loaded: yes`,
        `Config loaded: ${config.loaded ? "yes" : "no"} (${config.configPath})`,
        `Project mode: ${config.projectMode}`,
        `Strict human-in-loop: ${config.humanInLoop.strict ? "on" : "off"}`,
        `Skills expected: ${REQUIRED_NOVEL_SKILLS.length}`,
        `Skills found: ${discoveredSkills.length}`,
        `Skills missing: ${missingSkills.length} ${missingSkills.join(", ") || "(none)"}`,
        "",
        `Canonical MCP (.omp/mcp.json)`,
        `- path: ${mcpConfig.ompProjectConfig.path}`,
        `- exists: ${mcpConfig.ompProjectConfig.exists}`,
        `- enabled: ${String(mcpConfig.ompProjectConfig.enabled)}`,
        `- url: ${mcpConfig.ompProjectConfig.url ?? "n/a"}`,
        `- error: ${mcpConfig.ompProjectConfig.error ?? "none"}`,
        "Mirror MCP (.mcp.json)",
        `- path: ${mcpConfig.portableConfig.path}`,
        `- exists: ${mcpConfig.portableConfig.exists}`,
        `- enabled: ${String(mcpConfig.portableConfig.enabled)}`,
        `- url: ${mcpConfig.portableConfig.url ?? "n/a"}`,
        `- error: ${mcpConfig.portableConfig.error ?? "none"}`,
        `- enabled match: ${mcpConfig.enabledMatch}`,
        `- url match: ${mcpConfig.urlMatch}`,
        `- protocol enabled for OMP: ${mcpProtocolEnabled ? "yes" : "no"}`,
        "",
        `MCP health: ${health.ok ? "ok" : "unreachable"} ${health.ok ? "" : `(${health.error ?? "no response"})`}`,
        `Project status: ${projectStatusText}`,
        `Workflow stage: ${workflowSummary.workflow ? asString(workflowSummary.workflow.currentStage) : "no workflow data"} (${workflowSummary.workflow ? asString(workflowSummary.workflow.allowedNextAction) : "unknown"})`,
        `Pending gates: ${workflowSummary.pendingGateCount}${workflowSummary.pendingGateCount > 0 ? ` (${workflowSummary.pendingGates.map((gate) => `${gate.scopeType}/${gate.scopeId} ${gate.gateType}:${gate.status}`).join(", ")})` : ""}`,
        `Chapter workflow gates: ${chapterGates.length > 0 ? chapterGates.map((gate) => `${gate.scopeId}:${gate.gateType}:${gate.status}`).join(", ") : "none"}`,
        "",
        `Overall status: ${statusState}`,
        "",
        formatNovelStatusReport({
          config,
          mcpConfig,
          cwd,
          health,
          ...(projectStatus ? { projectStatus } : {})
        })
      ].join("\n");

      await pi.appendEntry("novel-engine-status", {
        at: Date.now(),
        statusState,
        extension: { loaded: true },
        configPath: config.configPath,
        configLoaded: config.loaded,
        projectMode: config.projectMode,
        strictHumanInLoop: config.humanInLoop.strict,
        skills: {
          expected: REQUIRED_NOVEL_SKILLS,
          found: discoveredSkills,
          missing: missingSkills
        },
        mcpConfig,
        health,
        status: projectStatus,
        projectStatus,
        report
      });

      const details = statusState === "offline"
        ? "Novel Engine status: offline (Story OS MCP health unreachable)."
        : statusState === "degraded"
          ? "Novel Engine status: degraded (reachable but configuration, skill discovery, health checks, or MCP protocol readiness is incomplete)."
          : "Novel Engine status: online and stable.";

      ctx.ui.notify(details, statusState === "online" ? "info" : "warning");
    }
  });

  pi.registerCommand("novel:new", {
    description: "Create a new novel, finite series, or indefinite serial project through a human approval gate.",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const mode = await selectChoice(ctx, "Project mode", [
        { label: "Standalone novel", value: "standalone" },
        { label: "Finite series", value: "series" },
        { label: "Indefinite web serial", value: "serial" }
      ]);
      const title = await ctx.ui.input("Project title", "");
      const createSlug = `phase3-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
      const createPayload = {
        slug: createSlug,
        title,
        mode
      };
      const createResult = await storyOsPost("/api/project/create", createPayload, { cwd });
      const createData = unwrapStoryData(createResult);
      const project = asObject(createData.project);
      const gate = asObject(createData.gate);

      await pi.appendEntry("novel-engine-project-create", {
        at: Date.now(),
        request: createPayload,
        response: createResult,
        cwd,
        project,
        gate,
        dbPath: createData.dbPath,
        graphDir: createData.graphDir
      });

      if (!createResult.ok) {
        await ctx.ui.notify(`Unable to create project: ${createResult.error ?? "unknown error"}`, "warning");
        return;
      }

      await sendCommandMessage(
        ctx,
        `Created ${asString(project.slug) ? `project "${asString(project.slug)}"` : "new project"} with premise gate ${asString(gate.id) || "pending"}. Please review premise options and approve in the UI.`,
      );
    }
  });

  const commandToWorkflow: Record<string, string> = {
    "novel:plan-series": "Plan or revise the series bible. Stop at human approval gate.",
    "novel:plan-book": "Plan or revise a finite book arc with nested seven-point structure. Stop at human approval gate.",
    "novel:export": "Export planning artifacts and Mermaid diagrams once mermaid export gate is approved.",
    "novel:beatmap": "Generate or audit nested seven-point beat maps. Stop at human approval gate.",
    "novel:canon": "Inspect, correct, approve, lock, or unlock canon facts through Story OS MCP.",
    "novel:audit": "Run mandatory quality gates and occurrence inventory."
  };

  const resolveSerialCommandContext = async (ctx: {
    cwd?: string;
    ui: CommandMessageContext["ui"];
  }): Promise<SerialCommandContext | null> => {
    const cwd = ctx.cwd ?? process.cwd();
    const projectContext = await resolveCurrentSerialProject(cwd);
    if (!projectContext) {
      await sendCommandMessage(
        ctx,
        "No active Story OS project found. Run /novel:new first.",
      );
      return null;
    }

    if (projectContext.mode !== "serial") {
      await sendCommandMessage(
        ctx,
        `Serial commands require an active serial project. Current project mode is ${projectContext.mode || "unknown"}.`,
      );
      return null;
    }

    return projectContext;
  };

  const runSerialCommand = async (
    commandName: string,
    route: string,
    projectContext: SerialCommandContext,
    request: JsonMap,
    cwd: string,
    ctx: CommandMessageContext
  ) => {
    const result = await postSerialCommand(pi, commandName, route, projectContext, request, cwd);
    await sendCommandMessage(ctx, [result.message, ...result.guidance].join("\n"));
  };

  pi.registerCommand("serial:plan-season", {
    description: "Plan or revise a serial season.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const projectContext = await resolveSerialCommandContext(ctx);
      if (!projectContext) return;

      const argsRecord = asObject(args);
      const titleFromArg = asString(argsRecord.title || argsRecord.seasonTitle || argsRecord.name);
      const title = titleFromArg || await ctx.ui.input("Season title", "");
      if (!title) {
        await sendCommandMessage(ctx, "Season planning requires a season title.");
        return;
      }

      const request: JsonMap = {
        projectSlug: projectContext.slug,
        title
      };

      const seasonNumberValue = Number.parseInt(asString(argsRecord.seasonNumber || argsRecord.number), 10);
      if (Number.isFinite(seasonNumberValue) && seasonNumberValue > 0) {
        request.seasonNumber = seasonNumberValue;
      }

      const premise = asString(argsRecord.premise || argsRecord.notes);
      if (premise) request.premise = premise;

      await runSerialCommand("serial:plan-season", "/api/serial/season/plan", projectContext, request, cwd, ctx);
    }
  });

  pi.registerCommand("serial:plan-arc", {
    description: "Plan or revise a serial, subplot, or major character arc.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const projectContext = await resolveSerialCommandContext(ctx);
      if (!projectContext) return;

      const argsRecord = asObject(args);
      const scopeArg = asString(argsRecord.scopeType || argsRecord.scope || argsRecord.type);
      const scopeType = serialArcScopes.includes(scopeArg as SerialArcScope)
        ? (scopeArg as SerialArcScope)
        : await selectChoice(ctx, "Arc scope", serialArcScopes.map((scope) => ({ label: scope, value: scope })));
      if (!scopeType) {
        await sendCommandMessage(ctx, "Arc planning requires a scope type.");
        return;
      }

      const titleFromArg = asString(argsRecord.title || argsRecord.arcTitle || argsRecord.name);
      const title = titleFromArg || await ctx.ui.input("Arc title", "");
      if (!title) {
        await sendCommandMessage(ctx, "Arc planning requires a title.");
        return;
      }

      const request: JsonMap = {
        projectSlug: projectContext.slug,
        scopeType,
        title
      };

      const scopeId = asString(argsRecord.scopeId || argsRecord.ownerId || argsRecord.arcOwnerId);
      if (scopeId) request.scopeId = scopeId;
      const arcId = asString(argsRecord.arcId);
      if (arcId) request.arcId = arcId;
      const synopsis = asString(argsRecord.arcSynopsis || argsRecord.synopsis);
      if (synopsis) request.arcSynopsis = synopsis;

      await runSerialCommand("serial:plan-arc", "/api/serial/arc/plan", projectContext, request, cwd, ctx);
    }
  });

  pi.registerCommand("serial:next-episode", {
    description: "Create the next serial episode and initialize chapter workflow gates.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const projectContext = await resolveSerialCommandContext(ctx);
      if (!projectContext) return;

      const argsRecord = asObject(args);
      const request: JsonMap = { projectSlug: projectContext.slug };

      const seasonId = asString(argsRecord.seasonId);
      if (seasonId) request.seasonId = seasonId;
      const seasonNumberValue = Number.parseInt(asString(argsRecord.seasonNumber || argsRecord.season), 10);
      if (Number.isFinite(seasonNumberValue) && seasonNumberValue > 0) request.seasonNumber = seasonNumberValue;
      const episodeTitle = asString(argsRecord.title || argsRecord.episodeTitle || argsRecord.name);
      if (episodeTitle) {
        request.episodeTitle = episodeTitle;
      } else {
        const enteredTitle = await ctx.ui.input("Episode title (optional)", "");
        if (enteredTitle) request.episodeTitle = enteredTitle;
      }
      const releaseLabel = asString(argsRecord.releaseLabel || argsRecord.label);
      if (releaseLabel) request.releaseLabel = releaseLabel;

      await runSerialCommand("serial:next-episode", "/api/serial/next-episode", projectContext, request, cwd, ctx);
    }
  });

  pi.registerCommand("serial:recap", {
    description: "Generate canon-safe reader and private serial recaps.",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const projectContext = await resolveSerialCommandContext(ctx);
      if (!projectContext) return;

      const argsRecord = asObject(args);
      const audienceArg = asString(argsRecord.audience);
      const audience = serialRecapAudiences.includes(audienceArg as SerialRecapAudience)
        ? (audienceArg as SerialRecapAudience)
        : await selectChoice(ctx, "Recap audience", serialRecapAudiences.map((entry) => ({ label: entry, value: entry })));
      if (!audience) {
        await sendCommandMessage(ctx, "Recap generation requires an audience.");
        return;
      }

      const request: JsonMap = {
        projectSlug: projectContext.slug,
        audience
      };

      const seasonId = asString(argsRecord.seasonId);
      if (seasonId) request.seasonId = seasonId;
      const episodeId = asString(argsRecord.episodeId);
      if (episodeId) request.episodeId = episodeId;
      const maxEpisodesValue = Number.parseInt(asString(argsRecord.maxEpisodes), 10);
      if (Number.isFinite(maxEpisodesValue) && maxEpisodesValue > 0) request.maxEpisodes = maxEpisodesValue;
      const includeOpenPromises = argsRecord.includeOpenPromises === true || asString(argsRecord.includeOpenPromises).toLowerCase() === "true";
      if (includeOpenPromises) request.includeOpenPromises = true;

      await runSerialCommand("serial:recap", "/api/serial/recap", projectContext, request, cwd, ctx);
    }
  });

  const handleChapterCommand = async (
    mode: "draft" | "revise",
    args: unknown,
    ctx: { cwd?: string; ui: { input: (label: string, initialValue?: string) => Promise<string>; notify: CommandMessageContext["ui"]["notify"] } }
  ) => {
    const cwd = ctx.cwd ?? process.cwd();
    const projectStatus = await storyOsPost("/api/project/status", {}, { cwd });
    if (!isStoryCallOk(projectStatus)) {
      const statusError = asString(unwrapStoryData(projectStatus).error) || asString(unwrapStoryData(projectStatus).code);
      await sendCommandMessage(
        ctx,
        `Unable to reach or query Story OS MCP: ${statusError || "unknown"}`,
      );
      return;
    }

    const projectSlug = resolveProjectSlug(projectStatus);
    if (!projectSlug) {
      await sendCommandMessage(
        ctx,
        "No active Story OS project found. Run /novel:new first.",
      );
      return;
    }

    const requestedChapterId = parseChapterIdArg(args);
    const pendingChapterGates = findPendingChapterGates(projectStatus);

    try {
      const chapter = await ensureChapterRecord(mode, projectSlug, requestedChapterId, pendingChapterGates, cwd, ctx);
      const summary = await summarizeChapterWorkflow(projectSlug, chapter.chapterId, cwd);
      const lines = [
        `${mode === "draft" ? "Draft workflow" : "Revise workflow"} for chapter ${chapter.chapterId} in project ${projectSlug}`,
        chapter.chapterCreated ? "Started new chapter outline." : "Continuing with existing chapter."
      ];

      if (summary.errors.length > 0) {
        lines.push(...summary.errors);
      } else {
        if (summary.blockers.length > 0) {
          lines.push("Blocking gates:", ...summary.blockers.map((entry) => `- ${entry}`));
          lines.push("Action: resolve gate blockers before further drafting.");
        } else if (summary.variantCount < 3) {
          lines.push(`Variants available: ${summary.variantCount}/3`);
          lines.push("Action: produce all required canon-tight, character-heavy, and plot-accelerated variants.");
        } else if (!summary.selectedVariantId) {
          lines.push("All three variants exist, but no selected variant is recorded.");
          lines.push("Action: run variant ranking and gate choice before draft revision.");
        } else {
          lines.push(`Variants: ${summary.variantCount}/3`);
          lines.push(`Selected variant: ${summary.selectedVariantId}`);
          lines.push("Action: continue post-prose gates and final approval flow in your drafting path.");
        }
      }

      await sendCommandMessage(ctx, lines.join("\n"));
    } catch (error) {
      await sendCommandMessage(
        ctx,
        `Chapter workflow could not continue: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  };

  pi.registerCommand("novel:draft-chapter", {
    description: "Start chapter drafting workflow, or continue an in-progress chapter draft.",
    handler: async (args, ctx) => {
      await handleChapterCommand("draft", args, ctx);
    }
  });

  pi.registerCommand("novel:revise-chapter", {
    description: "Continue chapter revision workflow without bypassing chapter gates.",
    handler: async (args, ctx) => {
      await handleChapterCommand("revise", args, ctx);
    }
  });

  for (const [name, instruction] of Object.entries(commandToWorkflow)) {
    pi.registerCommand(name, {
      description: instruction,
      handler: async (_args, ctx) => {
        await sendCommandMessage(ctx, instruction);
      }
    });
  }
}
