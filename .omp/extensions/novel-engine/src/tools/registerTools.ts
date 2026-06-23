import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { storyOsGet, storyOsPost } from "../clients/storyOsClient";
import {
  formatNovelStatusReport,
  loadNovelEngineConfig,
  readMcpConfigStatus
} from "../config/novelEngineConfig";
import type { ChapterVariantKind } from "../shared/types";
import {
  serialArcScopes,
  serialPromiseCategories,
  serialPromiseStatuses,
  serialPromiseVisibilities,
  serialRecapAudiences
} from "../shared/types";

type JsonMap = Record<string, unknown>;

const CHAPTER_VARIANTS: ChapterVariantKind[] = ["canon-tight", "character-heavy", "plot-accelerated"];

export function registerTools(pi: ExtensionAPI) {
  const { z } = pi.zod;

  type ToolResult =
    | {
        ok: true;
        data: unknown;
        warnings: string[];
        gate: null;
      }
    | {
        ok: false;
        error: string;
        code: string;
        recoverable: true;
      };

const asObject = (value: unknown): JsonMap => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonMap;
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const toToolResult = (sourceLabel: string, response: { ok: boolean; data?: unknown; error?: string }): ToolResult => {
  if (!response.ok) {
    return {
      ok: false,
      error: response.error ?? `${sourceLabel}: request failed`,
      code: "STORY_OS_REQUEST_ERROR",
      recoverable: true
    };
  }

  const root = asObject(response.data);
  if (!("ok" in root)) {
    return {
      ok: true,
      data: root,
      warnings: [],
      gate: null
    };
  }

  if (root.ok === false) {
    return {
      ok: false,
      error: String(root.error ?? `${sourceLabel}: tool returned ok=false`),
      code: String(root.code ?? "STORY_OS_TOOL_ERROR"),
      recoverable: Boolean(typeof root.recoverable === "boolean" ? root.recoverable : true)
    };
  }

  return {
    ok: true,
    data: root.data,
    warnings: asStringArray(root.warnings),
    gate: root.gate as Record<string, unknown> | null ?? null
  };
};

const unwrapStoryData = (value: unknown): JsonMap => {
  const root = asObject(value);
  const first = root.ok === true && "data" in root ? asObject(root.data) : root;
  return first.ok === true && "data" in first ? asObject(first.data) : first;
};

const resolveProjectSlug = async (): Promise<{ slug: string } | null> => {
  const status = await storyOsPost("/api/project/status", {});
  const parsed = toToolResult("story_project_status", status);
  if (!parsed.ok) return null;
  const payload = asObject(parsed.data);
  const projects = asArray(payload.projects).map((entry) => asObject(entry));
  const first = projects[0];
  if (!first) return null;
  const project = asObject(first.project);
  return { slug: asString(project.slug) || asString(first.slug) };
};

const buildNovelCompareReport = (chapterId: string, projectSlug: string, payload: JsonMap) => {
  const selectedVariantId = asString(payload.selectedVariantId);
  const variants = asArray(payload.variants).map((entry) => asObject(entry));
  const variantMap = new Map<string, JsonMap>();
  for (const variant of variants) {
    variantMap.set(asString(variant.variant_type || variant.variantType), variant);
  }

  for (const variantType of CHAPTER_VARIANTS) {
    if (!variantMap.has(variantType)) {
      return {
        ok: false as const,
        message: `Missing required variant type: ${variantType}`,
        data: null
      };
    }
  }

  const ordered = CHAPTER_VARIANTS.map((variantType) => variantMap.get(variantType)).filter((entry): entry is JsonMap => Boolean(entry));
  const reportVariants = ordered.map((variant) => ({
    "Variant ID": asString(variant.id),
    "Purpose": asString(variant.purpose),
    "What changed structurally": asString(variant.changed_structurally || variant.changedStructurally),
    "What changed emotionally": asString(variant.changed_emotionally || variant.changedEmotionally),
    "What changed in pacing": asString(variant.changed_in_pacing || variant.changedInPacing),
    "Canon risk": asString(variant.canon_risk || variant.canonRisk),
    "Continuity risk": asString(variant.continuity_risk || variant.continuityRisk),
    "Best use case": asString(variant.best_use_case || variant.bestUseCase),
    "Reason to choose it": asString(variant.reason_to_choose || variant.reasonToChoose),
    "Reason not to choose it": asString(variant.reason_not_to_choose || variant.reasonNotToChoose),
    "Variant type": asString(variant.variant_type || variant.variantType),
    "selected": asString(variant.selected),
    "status": asString(variant.status)
  }));

  return {
    ok: true as const,
    data: {
      chapterId,
      projectSlug,
      variantCount: ordered.length,
      selectedVariantId,
      variants: reportVariants
    }
  };
};

  const resolveProjectForSerial = async (projectSlug?: string): Promise<string | null> => {
    if (projectSlug) return projectSlug;
    const status = await resolveProjectSlug();
    return status?.slug ?? null;
  };

  const executeSerialTool = async (
    _toolCallId: string,
    params: JsonMap,
    options: { route: string; toolName: string; requireProjectSlug: boolean }
  ) => {
    const projectSlug = asString(params.projectSlug);
    const resolvedProjectSlug = await resolveProjectForSerial(projectSlug);
    if (options.requireProjectSlug && !resolvedProjectSlug) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: "projectSlug missing and no active project found" }, null, 2) }],
        details: { ok: false, error: "projectSlug missing and no active project found", code: "NO_ACTIVE_PROJECT", recoverable: true }
      };
    }

    const request = {
      ...params,
      ...(resolvedProjectSlug ? { projectSlug: resolvedProjectSlug } : {})
    };

    const response = await storyOsPost(options.route, request);
    const toolResult = toToolResult(options.toolName, response);
    return toolResult.ok
      ? {
        content: [{ type: "text", text: JSON.stringify(toolResult.data, null, 2) }],
        details: toolResult
      }
      : {
        content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
        details: toolResult
      };
  };

  const resolveProjectStatus = async (
    params: { projectSlug?: string }
  ): Promise<ToolResult> => {
    const health = await storyOsGet("/health");
    const status = await storyOsPost("/api/project/status", {
      ...(params.projectSlug ? { projectSlug: params.projectSlug } : {})
    });

    if (!health.ok) {
      return {
        ok: false,
        error: health.error ?? "Story OS health check failed",
        code: "STORY_OS_HEALTH_ERROR",
        recoverable: true
      };
    }

    if (!status.ok) {
      return {
        ok: false,
        error: status.error ?? "Project status query failed",
        code: "STORY_OS_PROJECT_STATUS_ERROR",
        recoverable: true
      };
    }

    const parsedStatus = toToolResult("story_project_status", status);
    if (!parsedStatus.ok) return parsedStatus;

    return {
      ok: true,
      data: {
        health,
        status: parsedStatus.data
      },
      warnings: [],
      gate: null
    };
  };

  const executeProjectStatusTool = async (_toolCallId: string, params: { projectSlug?: string }) => {
    const statusResult = await resolveProjectStatus(params);
    return {
      content: [{ type: "text", text: JSON.stringify(statusResult, null, 2) }],
      details: statusResult
    };
  };

  const projectStatusReport = async (params: { projectSlug?: string }) => {
    const [health, status] = await Promise.all([
      storyOsGet("/health"),
      storyOsPost("/api/project/status", {
        ...(params.projectSlug ? { projectSlug: params.projectSlug } : {})
      })
    ]);
    const parsedStatus = toToolResult("story_project_status", status);
    const response: Record<string, unknown> = {
      health,
      status: parsedStatus.ok ? parsedStatus.data : status
    };
    const config = loadNovelEngineConfig();
    const mcpConfig = readMcpConfigStatus();
    const report = formatNovelStatusReport({
      config,
      mcpConfig,
      health,
      projectStatus: status
    });
    return { report, ...response };
  };

  pi.registerTool({
    name: "story_project_status",
    label: "Novel Project Status",
    description: "Return Story OS MCP health and active project status.",
    parameters: z.object({
      projectSlug: z.string().optional()
    }),
    execute: executeProjectStatusTool
  });

  pi.registerTool({
    name: "novel_project_status",
    label: "Novel Project Status (Legacy)",
    description: "Return Story OS MCP health and active project status.",
    parameters: z.object({
      projectSlug: z.string().optional()
    }),
    execute: async (_toolCallId, params) => {
      const statusResult = await resolveProjectStatus(params);
      const statusDetails = await projectStatusReport(params);
      return {
        content: [{ type: "text", text: JSON.stringify(statusResult, null, 2) }],
        details: { ...statusResult, ...statusDetails }
      };
    }
  });

  pi.registerTool({
    name: "novel_pending_gate",
    label: "Novel Pending Gate",
    description: "Return the currently pending human gate for a project.",
    parameters: z.object({ projectSlug: z.string().optional() }),
    async execute(_toolCallId, params) {
      const gate = await storyOsPost("/api/gate/pending", params);
      const toolResult = toToolResult("novel_pending_gate", gate);
      return { content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }], details: toolResult };
    }
  });

  pi.registerTool({
    name: "novel_variant_compare",
    label: "Novel Variant Compare",
    description: "Compare canon-tight, character-heavy, and plot-accelerated variants for a chapter.",
    parameters: z.object({
      chapterId: z.string(),
      projectSlug: z.string().optional()
    }),
    async execute(_toolCallId, params) {
      const requestedProjectSlug = asString(params.projectSlug);
      const slug = requestedProjectSlug || asString((await resolveProjectSlug())?.slug);
      if (!slug) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "projectSlug missing and no active project found" }, null, 2) }],
          details: { ok: false, error: "projectSlug missing and no active project found", code: "NO_ACTIVE_PROJECT", recoverable: true }
        };
      }

      const listResult = await storyOsPost("/api/chapter/variant/list", {
        projectSlug: slug,
        chapterId: params.chapterId
      });
      const listToolResult = toToolResult("story_chapter_variant_list", listResult);
      if (!listToolResult.ok) return {
        content: [{ type: "text", text: JSON.stringify(listToolResult, null, 2) }],
        details: listToolResult
      };

      const payload = unwrapStoryData(listToolResult.data);
      const compare = buildNovelCompareReport(params.chapterId, slug, payload);
      if (!compare.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: compare.message }, null, 2) }],
          details: { ok: false, error: compare.message, code: "NOVEL_VARIANT_COMPARE_MISSING_VARIANTS", recoverable: true }
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(compare.data, null, 2) }],
        details: compare.data
      };
    }
  });

  pi.registerTool({
    name: "story_serial_season_plan",
    label: "Story Serial Season Plan",
    description: "Create or revise a serial season plan and persist season metadata to Story OS.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      seasonNumber: z.number().int().positive().optional(),
      title: z.string().optional(),
      premise: z.string().optional(),
      notes: z.string().optional(),
      arcId: z.string().optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/season/plan",
        toolName: "story_serial_season_plan",
        requireProjectSlug: true
      });
    }
  });

  pi.registerTool({
    name: "story_serial_arc_plan",
    label: "Story Serial Arc Plan",
    description: "Create or revise serial arcs with seven-point planning for a serial scope.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      arcId: z.string().optional(),
      title: z.string().optional(),
      scopeType: z.enum(serialArcScopes).optional(),
      scopeId: z.string().optional(),
      arcSynopsis: z.string().optional(),
      beats: z.array(z.unknown()).optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/arc/plan",
        toolName: "story_serial_arc_plan",
        requireProjectSlug: true
      });
    }
  });

  pi.registerTool({
    name: "story_serial_next_episode",
    label: "Story Serial Next Episode",
    description: "Allocate and initialize the next serial episode/chapter workflow.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      seasonId: z.string().optional(),
      seasonNumber: z.number().int().positive().optional(),
      episodeTitle: z.string().optional(),
      releaseLabel: z.string().optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/next-episode",
        toolName: "story_serial_next_episode",
        requireProjectSlug: true
      });
    }
  });

  pi.registerTool({
    name: "story_serial_promise_upsert",
    label: "Story Serial Promise Upsert",
    description: "Create or update a serial promise record with visibility and status.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      id: z.string().optional(),
      title: z.string().optional(),
      category: z.enum(serialPromiseCategories).optional(),
      status: z.enum(serialPromiseStatuses).optional(),
      visibility: z.enum(serialPromiseVisibilities).optional(),
      scopeType: z.enum(serialArcScopes).optional(),
      scopeId: z.string().optional(),
      sourceEpisodeId: z.string().optional(),
      targetScopeId: z.string().optional(),
      payoffEpisodeId: z.string().optional(),
      priority: z.number().int().min(0).max(5).optional(),
      notes: z.string().optional(),
      sourceRef: z.string().optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/promise/upsert",
        toolName: "story_serial_promise_upsert",
        requireProjectSlug: true
      });
    }
  });

  pi.registerTool({
    name: "story_serial_promise_list",
    label: "Story Serial Promise List",
    description: "List serial promises with scope/category/status/visibility filters.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      status: z.enum(serialPromiseStatuses).optional(),
      visibility: z.enum(serialPromiseVisibilities).optional(),
      category: z.enum(serialPromiseCategories).optional(),
      scopeType: z.enum(serialArcScopes).optional(),
      scopeId: z.string().optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/promise/list",
        toolName: "story_serial_promise_list",
        requireProjectSlug: true
      });
    }
  });

  pi.registerTool({
    name: "story_serial_recap_generate",
    label: "Story Serial Recap Generate",
    description: "Generate a reader or private recap for serial scope.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      seasonId: z.string().optional(),
      episodeId: z.string().optional(),
      audience: z.enum(serialRecapAudiences).optional(),
      includeOpenPromises: z.boolean().optional(),
      maxEpisodes: z.number().int().positive().optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/recap",
        toolName: "story_serial_recap_generate",
        requireProjectSlug: true
      });
    }
  });

  pi.registerTool({
    name: "story_serial_season_report",
    label: "Story Serial Season Report",
    description: "Generate a season completion report and unresolved promise summary.",
    parameters: z.object({
      projectSlug: z.string().optional(),
      seasonId: z.string().optional(),
      includePrivate: z.boolean().optional()
    }).passthrough(),
    async execute(_toolCallId, params) {
      return executeSerialTool(_toolCallId, params as JsonMap, {
        route: "/api/serial/season/report",
        toolName: "story_serial_season_report",
        requireProjectSlug: true
      });
    }
  });
}
