import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProjectMode = "ask" | "standalone" | "series" | "serial" | string;

type YamlValue = string | number | boolean | null | YamlObject | YamlArray;
type YamlArray = YamlValue[];
type YamlObject = Record<string, YamlValue>;

interface ParseFrame {
  indent: number;
  container: YamlObject | YamlArray;
}

export const REQUIRED_NOVEL_SKILLS = [
  "aiism-detection-cleanup",
  "chapter-outlining",
  "character-arc",
  "continuity-canon-audit",
  "dialogue-naturalness",
  "novel-series-architecture",
  "plain-physical-prose-revision",
  "progression-fantasy-advancement",
  "scene-drafting",
  "seven-point-structure"
] as const;

export interface NovelEngineConfig {
  projectMode: ProjectMode;
  humanInLoop: {
    strict: boolean;
    requireApprovalAt: string[];
  };
  drafting: {
    chapterVariantCount: number;
    variants: Array<{ id: string; purpose: string }>;
  };
  mcp: {
    serverName: string;
    baseUrl: string;
  };
  models: Record<string, string>;
  configPath: string;
  loaded: boolean;
  parseErrors: string[];
}

export interface McpConfigServerStatus {
  path: string;
  exists: boolean;
  enabled: boolean | null;
  url: string | null;
  error?: string;
}

export interface McpConfigStatus {
  serverName: string;
  ompProjectConfig: McpConfigServerStatus;
  portableConfig: McpConfigServerStatus;
  enabledMatch: boolean;
  urlMatch: boolean;
  parseErrors: string[];
}

interface NovelStatusInput {
  config?: NovelEngineConfig;
  mcpConfig?: McpConfigStatus;
  cwd?: string;
  health?: unknown;
  projectStatus?: unknown;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:7127";
const DEFAULT_MCP_SERVER_NAME = "novel-story-os";
const DEFAULT_PROJECT_MODE: ProjectMode = "ask";

function normalizeCwd(cwd?: string): string {
  return (typeof cwd === "string" && cwd.trim()) ? cwd : process.cwd();
}

function getIndent(line: string): number {
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === " ") {
      count += 1;
      continue;
    }
    if (char === "\t") {
      count += 2;
      continue;
    }
    break;
  }
  return count;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let output = "";

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (inDouble && char === "\\") {
      output += char;
      escaped = true;
      continue;
    }

    if (!inDouble && char === "'" ) {
      inSingle = !inSingle;
      output += char;
      continue;
    }

    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      output += char;
      continue;
    }

    if (!inSingle && !inDouble && char === "#") {
      break;
    }

    output += char;
  }

  return output;
}

function parseScalar(text: string): YamlValue {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null" || trimmed === "~") return null;
  if (/^-?\d+$/.test(trimmed)) {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }
  if (/^-?\d*\.\d+$/.test(trimmed)) {
    const parsed = Number.parseFloat(trimmed);
    return Number.isNaN(parsed) ? trimmed : parsed;
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((entry) => parseScalar(entry));
  }

  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}

function isRecord(value: unknown): value is YamlObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseYamlLite(text: string): YamlObject {
  const root: YamlObject = {};
  const frames: ParseFrame[] = [{ indent: -1, container: root }];
  const lines = text.split(/\r?\n/);

  const firstSignificantAfter = (start: number): number => {
    for (let i = start; i < lines.length; i++) {
      const stripped = stripYamlComment(lines[i]).trim();
      if (stripped.length > 0 && !stripped.startsWith("#")) {
        return i;
      }
    }
    return -1;
  };

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmedLine = stripYamlComment(rawLine).trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) continue;

    const indent = getIndent(rawLine);
    while (frames.length > 1 && indent <= frames[frames.length - 1].indent) {
      frames.pop();
    }

    const frame = frames[frames.length - 1];
    const parent = frame.container;

    if (trimmedLine.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        continue;
      }

      const token = trimmedLine.slice(2).trim();
      if (!token) {
        const child: YamlObject = {};
        parent.push(child);
        const next = firstSignificantAfter(i + 1);
        const nextIndent = next === -1 ? indent + 2 : getIndent(lines[next]);
        if (next !== -1 && nextIndent > indent) {
          frames.push({ indent, container: child });
        }
        continue;
      }

      const sep = token.indexOf(":");
      if (sep === -1) {
        parent.push(parseScalar(token));
        continue;
      }

      const key = token.slice(0, sep).trim();
      const valueText = token.slice(sep + 1).trim();
      const itemObject: YamlObject = { [key]: valueText ? parseScalar(valueText) : {} };
      parent.push(itemObject);

      const next = firstSignificantAfter(i + 1);
      const nextIndent = next === -1 ? indent + 2 : getIndent(lines[next]);
      const hasNestedFields = next !== -1 && nextIndent > indent;
      const nextLooksList = next !== -1 && stripYamlComment(lines[next]).trim().startsWith("-");
      if (hasNestedFields && !nextLooksList) {
        frames.push({ indent, container: itemObject });
      }

      continue;
    }

    const sep = trimmedLine.indexOf(":");
    if (sep === -1) continue;

    const key = trimmedLine.slice(0, sep).trim();
    const valueText = trimmedLine.slice(sep + 1).trim();
    if (!isRecord(parent)) continue;

    if (!valueText) {
      const next = firstSignificantAfter(i + 1);
      const nextIndent = next === -1 ? indent + 2 : getIndent(lines[next]);
      const nextLine = next === -1 ? "" : stripYamlComment(lines[next]).trim();
      const isList = next !== -1 && nextIndent > indent && nextLine.startsWith("-");
      parent[key] = isList ? [] : {};
      if (next !== -1 && nextIndent > indent) {
        frames.push({ indent, container: parent[key] as YamlObject | YamlArray });
      }
      continue;
    }

    parent[key] = parseScalar(valueText);
  }

  return root;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asRecordOfStrings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, valueNode] of Object.entries(value)) {
    if (typeof valueNode === "string") {
      output[key] = valueNode;
    }
  }
  return output;
}

function parseVariants(value: unknown): Array<{ id: string; purpose: string }> {
  if (!Array.isArray(value)) return [];

  const variants: Array<{ id: string; purpose: string }> = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const id = asString(item.id);
    const purpose = asString(item.purpose);
    if (!id) continue;
    variants.push({ id, purpose });
  }
  return variants;
}

export function loadNovelEngineConfig(cwd = process.cwd()): NovelEngineConfig {
  const root = normalizeCwd(cwd);
  const configPath = join(root, ".omp", "novel-engine", "config.yml");
  const parseErrors: string[] = [];

  let parsed: YamlObject = {};
  let loaded = false;

  try {
    const file = readFileSync(configPath, "utf8");
    parsed = parseYamlLite(file);
    loaded = true;
  } catch (error) {
    parseErrors.push(error instanceof Error ? error.message : String(error));
  }

  const projectMode = asString(parsed.projectMode) || DEFAULT_PROJECT_MODE;
  const humanInLoop = isRecord(parsed.humanInLoop) ? parsed.humanInLoop : {};
  const drafting = isRecord(parsed.drafting) ? parsed.drafting : {};
  const mcpNode = isRecord(parsed.mcp) ? parsed.mcp : {};
  const modelsNode = isRecord(parsed.models) ? parsed.models : {};

  return {
    projectMode,
    humanInLoop: {
      strict: asBoolean(humanInLoop.strict, true),
      requireApprovalAt: asStringArray(humanInLoop.requireApprovalAt)
    },
    drafting: {
      chapterVariantCount: asNumber(drafting.chapterVariantCount, 3),
      variants: parseVariants(drafting.variants)
    },
    mcp: {
      serverName: asString(mcpNode.serverName) || DEFAULT_MCP_SERVER_NAME,
      baseUrl: asString(mcpNode.baseUrl) || DEFAULT_BASE_URL
    },
    models: asRecordOfStrings(modelsNode),
    configPath,
    loaded,
    parseErrors
  };
}

export function discoverBundledSkills(cwd = process.cwd()): string[] {
  const root = normalizeCwd(cwd);
  const skillsPath = join(root, ".omp", "skills");
  if (!existsSync(skillsPath)) return [];

  const discovered = readdirSync(skillsPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .filter((name) => {
      if (!REQUIRED_NOVEL_SKILLS.includes(name as (typeof REQUIRED_NOVEL_SKILLS)[number])) return false;
      return existsSync(join(skillsPath, name, "SKILL.md"));
    })
    .sort();

  return discovered;
}

function readMcpEntry(path: string, serverName: string): McpConfigServerStatus {
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      enabled: null,
      url: null,
      error: "MCP config file not found"
    };
  }

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        path,
        exists: true,
        enabled: null,
        url: null,
        error: "Invalid MCP config shape"
      };
    }

    const mcpServers = parsed.mcpServers;
    if (!isRecord(mcpServers)) {
      return {
        path,
        exists: true,
        enabled: null,
        url: null,
        error: "No mcpServers section"
      };
    }

    const server = mcpServers[serverName];
    if (!isRecord(server)) {
      return {
        path,
        exists: true,
        enabled: null,
        url: null,
        error: `Server ${serverName} missing`
      };
    }

    const enabled = typeof server.enabled === "boolean" ? server.enabled : null;
    const url = typeof server.url === "string" ? server.url : null;
    return {
      path,
      exists: true,
      enabled,
      url
    };
  } catch (error) {
    return {
      path,
      exists: true,
      enabled: null,
      url: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function normalizeMcpUrlForCompare(url: string | null): string {
  if (!url) return "";
  return url.replace(/\/+$/, "");
}

export function readMcpConfigStatus(cwd = process.cwd()): McpConfigStatus {
  const root = normalizeCwd(cwd);
  const config = loadNovelEngineConfig(root);
  const serverName = config.mcp.serverName || DEFAULT_MCP_SERVER_NAME;
  const projectConfig = readMcpEntry(join(root, ".omp", "mcp.json"), serverName);
  const portableConfig = readMcpEntry(join(root, ".mcp.json"), serverName);
  const parseErrors = [
    ...config.parseErrors,
    ...(projectConfig.error ? [projectConfig.error] : []),
    ...(portableConfig.error ? [portableConfig.error] : [])
  ];

  const enabledMatch = projectConfig.exists &&
    portableConfig.exists &&
    projectConfig.enabled !== null &&
    projectConfig.enabled === portableConfig.enabled;

  const urlMatch = projectConfig.exists &&
    portableConfig.exists &&
    normalizeMcpUrlForCompare(projectConfig.url) !== "" &&
    normalizeMcpUrlForCompare(projectConfig.url) === normalizeMcpUrlForCompare(portableConfig.url);

  return {
    serverName,
    ompProjectConfig: projectConfig,
    portableConfig,
    enabledMatch,
    urlMatch,
    parseErrors
  };
}

export function formatNovelStatusReport(input: NovelStatusInput): string {
  const cwd = normalizeCwd(input.cwd);
  const config = input.config ?? loadNovelEngineConfig(cwd);
  const mcpConfig = input.mcpConfig ?? readMcpConfigStatus(cwd);
  const discoveredSkills = discoverBundledSkills(cwd);
  const missingSkills = REQUIRED_NOVEL_SKILLS.filter((skill) => !discoveredSkills.includes(skill));
  const protocolEnabledForOmp =
    mcpConfig.ompProjectConfig.enabled === true &&
    mcpConfig.portableConfig.enabled === true &&
    mcpConfig.enabledMatch &&
    mcpConfig.urlMatch;

  const lines = [
    "Novel Engine status",
    "",
    "Config",
    `- projectMode: ${config.projectMode}`,
    `- strict human-in-loop: ${config.humanInLoop.strict ? "on" : "off"}`,
    `- chapter variants: ${config.drafting.chapterVariantCount}`,
    `- mcp server: ${config.mcp.serverName}`,
    `- mcp base URL: ${config.mcp.baseUrl}`,
    "",
    "Model routing",
    ...Object.entries(config.models).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "Skills",
    `- discovered required: ${discoveredSkills.length} / ${REQUIRED_NOVEL_SKILLS.length}`
  ];

  if (missingSkills.length > 0) {
    lines.push(`- missing: ${missingSkills.join(", ")}`);
  }

  lines.push(
    "",
    ".omp/mcp.json",
    `- exists: ${mcpConfig.ompProjectConfig.exists}`,
    `- enabled: ${String(mcpConfig.ompProjectConfig.enabled)}`,
    `- url: ${mcpConfig.ompProjectConfig.url ?? "n/a"}`,
    ".mcp.json",
    `- exists: ${mcpConfig.portableConfig.exists}`,
    `- enabled: ${String(mcpConfig.portableConfig.enabled)}`,
    `- url: ${mcpConfig.portableConfig.url ?? "n/a"}`,
    `- enabled match: ${mcpConfig.enabledMatch}`,
    `- url match: ${mcpConfig.urlMatch}`,
    `- protocol enabled for OMP: ${
      protocolEnabledForOmp ? "yes" : "no"
    }`
  );

  if (input.health !== undefined) {
    lines.push(
      "",
      "Story OS health",
      `${typeof input.health === "string" ? input.health : JSON.stringify(input.health, null, 2)}`
    );
  }

  if (input.projectStatus !== undefined) {
    lines.push(
      "",
      "Project status",
      `${typeof input.projectStatus === "string" ? input.projectStatus : JSON.stringify(input.projectStatus, null, 2)}`
    );
  }

  if (config.parseErrors.length > 0) {
    lines.push(
      "",
      "Config load issues",
      ...config.parseErrors.map((error) => `- ${error}`)
    );
  }

  if (mcpConfig.parseErrors.length > 0) {
    lines.push(
      "",
      "MCP config issues",
      ...mcpConfig.parseErrors.map((error) => `- ${error}`)
    );
  }

  return lines.join("\n");
}
