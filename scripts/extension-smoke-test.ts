import { existsSync, readFileSync } from "fs";
import {
  REQUIRED_NOVEL_SKILLS,
  discoverBundledSkills,
  formatNovelStatusReport,
  loadNovelEngineConfig,
  readMcpConfigStatus,
} from "../.omp/extensions/novel-engine/src/config/novelEngineConfig";

const checks: Array<{ label: string; ok: boolean }> = [];
const addCheck = (label: string, ok: boolean) => checks.push({ label, ok });

const novelConfigPath = ".omp/config.yml";
const novelEngineConfigPath = ".omp/novel-engine/config.yml";
const extensionPaths = ["./.omp/extensions/novel-engine", ".omp/extensions/novel-engine"];
const extensionPackagePath = ".omp/extensions/novel-engine/package.json";
const extensionEntryPath = ".omp/extensions/novel-engine/index.ts";
const commandRegistryPath = ".omp/extensions/novel-engine/src/commands/registerCommands.ts";
const requiredSkills = [
  "chapter-outlining",
  "character-arc",
  "continuity-canon-audit",
  "dialogue-naturalness",
  "novel-series-architecture",
  "plain-physical-prose-revision",
  "progression-fantasy-advancement",
  "scene-drafting",
  "seven-point-structure",
  "aiism-detection-cleanup",
];

const loadedConfig = loadNovelEngineConfig(process.cwd());
const discoveredRuntimeSkills = discoverBundledSkills(process.cwd());
const mcpConfigStatus = readMcpConfigStatus(process.cwd());

const parseYamlBoolean = (source: string, section: string, key: string): boolean | null => {
  const lines = source.replace(/\r/g, "").split("\n");
  let activeSection = false;
  for (const line of lines) {
    const hasLeadingSpace = /^\s/.test(line);
    const trimmed = line.trim();
    if (/^[^\s#].*:/.test(line) && !line.startsWith(" ")) {
      activeSection = line.startsWith(`${section}:`);
      continue;
    }

    if (!activeSection) continue;
    if (!hasLeadingSpace || trimmed === "") continue;
    const match = trimmed.match(`^${key}:\\s*(true|false)$`);
    if (match) {
      return match[1] === "true";
    }
  }

  return null;
};

const parseYamlList = (source: string, section: string): string[] => {
  const lines = source.replace(/\r/g, "").split("\n");
  let activeSection = false;
  const values: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[^\s#].*:/.test(line) && !line.startsWith(" ")) {
      activeSection = line.startsWith(`${section}:`);
      continue;
    }
    if (!activeSection) continue;
    if (!line.startsWith(" ") || trimmed === "") continue;
    const match = trimmed.match(/^-\s*(.+)\s*$/);
    if (match) values.push(match[1]);
  }

  return values;
};

const parseYamlValue = (source: string, section: string, key: string): string | null => {
  const lines = source.replace(/\r/g, "").split("\n");
  let activeSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[^\s#].*:/.test(line) && !line.startsWith(" ")) {
      activeSection = line.startsWith(`${section}:`);
      continue;
    }
    if (!activeSection || !line.startsWith(" ") || trimmed === "") continue;
    const match = trimmed.match(new RegExp(`^${key}:\\s*(.+)$`));
    if (match) return match[1];
  }

  return null;
};

if (existsSync(novelConfigPath)) {
  const configText = readFileSync(novelConfigPath, "utf8");
  const extensions = parseYamlList(configText, "extensions");
  const skillsEnabled = parseYamlBoolean(configText, "skills", "enabled");
  const skillCommandsEnabled = parseYamlBoolean(configText, "skills", "enableSkillCommands");
  const extensionConfigured = extensions.some((path) => extensionPaths.includes(path));
  addCheck(
    `config has extension enabled path (${extensionPaths.join(" or ")})`,
    extensionConfigured && skillsEnabled === true && skillCommandsEnabled === true,
  );
  addCheck("config has skills.enabled = true", skillsEnabled === true);
  addCheck("config has skills.enableSkillCommands = true", skillCommandsEnabled === true);
} else {
  addCheck(`MISSING ${novelConfigPath}`, false);
}

if (existsSync(novelEngineConfigPath)) {
  const novelEngineConfigText = readFileSync(novelEngineConfigPath, "utf8");
  const mcpBaseUrl = parseYamlValue(novelEngineConfigText, "mcp", "baseUrl")?.trim();
  const hasMcpBaseUrl = typeof mcpBaseUrl === "string" && mcpBaseUrl.length > 0;
  addCheck("novel-engine config has MCP baseUrl", hasMcpBaseUrl);
  addCheck("config loader reads novel-engine config", loadedConfig.loaded && loadedConfig.mcp.baseUrl === mcpBaseUrl);
  addCheck("config loader reads project mode", loadedConfig.projectMode === "ask");
  addCheck("config loader reads strict gates", loadedConfig.humanInLoop.strict === true);
  addCheck("config loader reads three variants", loadedConfig.drafting.chapterVariantCount === 3);
} else {
  addCheck(`MISSING ${novelEngineConfigPath}`, false);
}

if (existsSync(extensionPackagePath)) {
  const packageText = readFileSync(extensionPackagePath, "utf8");
  try {
    const parsed = JSON.parse(packageText);
    const packageEntries = parsed?.omp?.extensions;
    const hasEntry = Array.isArray(packageEntries) && packageEntries.includes("./index.ts");
    addCheck("extension package points to index.ts", hasEntry);
  } catch {
    addCheck("extension package points to index.ts", false);
  }
} else {
  addCheck(`MISSING ${extensionPackagePath}`, false);
}

addCheck(`extension entry exists ${extensionEntryPath}`, existsSync(extensionEntryPath));

if (existsSync(commandRegistryPath)) {
  const registryText = readFileSync(commandRegistryPath, "utf8");
  const hasNewProjectCreationPath = registryText.includes("/api/project/create");
  const hasDraftChapterCommand = /\bregisterCommand\(\s*["'`]novel:draft-chapter["'`]/.test(
    registryText,
  );
  const hasReviseChapterCommand = /\bregisterCommand\(\s*["'`]novel:revise-chapter["'`]/.test(
    registryText,
  );
  const hasChapterWorkflowPaths = registryText.includes("/api/chapter/outline") && registryText.includes("/api/chapter/variant/list");
  const hasSerialSeasonPlanCommand = /\bregisterCommand\(\s*["'`]serial:plan-season["'`]/.test(registryText);
  const hasSerialArcPlanCommand = /\bregisterCommand\(\s*["'`]serial:plan-arc["'`]/.test(registryText);
  const hasSerialNextEpisodeCommand = /\bregisterCommand\(\s*["'`]serial:next-episode["'`]/.test(registryText);
  const hasSerialRecapCommand = /\bregisterCommand\(\s*["'`]serial:recap["'`]/.test(registryText);
  const hasSerialSeasonPlanRoute = registryText.includes("/api/serial/season/plan");
  const hasSerialArcPlanRoute = registryText.includes("/api/serial/arc/plan");
  const hasSerialNextEpisodeRoute = registryText.includes("/api/serial/next-episode");
  const hasSerialRecapRoute = registryText.includes("/api/serial/recap");
  const hasStatusCommand = /\bregisterCommand\(\s*["'`]novel:status["'`]/.test(
    registryText,
  );
  const hasApproveGateCommand = /\bregisterCommand\(\s*["'`]novel:approve-gate["'`]/.test(
    registryText,
  );
  addCheck("command registry contains /novel:status", hasStatusCommand);
  addCheck("command registry shows API-backed /novel:new flow", hasNewProjectCreationPath);
  addCheck("command registry enables /novel:approve-gate", hasApproveGateCommand && registryText.includes("/api/gate/decision"));
  addCheck("command registry enables /novel:draft-chapter", hasDraftChapterCommand && hasChapterWorkflowPaths);
  addCheck("command registry enables /novel:revise-chapter", hasReviseChapterCommand && hasChapterWorkflowPaths);
  addCheck("command registry enables /serial:plan-season", hasSerialSeasonPlanCommand && hasSerialSeasonPlanRoute);
  addCheck("command registry enables /serial:plan-arc", hasSerialArcPlanCommand && hasSerialArcPlanRoute);
  addCheck("command registry enables /serial:next-episode", hasSerialNextEpisodeCommand && hasSerialNextEpisodeRoute);
  addCheck("command registry enables /serial:recap", hasSerialRecapCommand && hasSerialRecapRoute);
  addCheck("command registry does not block serial commands", !registryText.includes("Phase 5 serial commands are blocked"));
} else {
  addCheck(`MISSING ${commandRegistryPath}`, false);
}

const existingSkills = requiredSkills.filter((skill) =>
  existsSync(`.omp/skills/${skill}/SKILL.md`),
);
addCheck(`ten skill SKILL.md files exist (${existingSkills.length}/10)`, existingSkills.length === 10);
addCheck(
  `runtime skill discovery finds ten skills (${discoveredRuntimeSkills.length}/10)`,
  discoveredRuntimeSkills.length === REQUIRED_NOVEL_SKILLS.length,
);
addCheck("runtime MCP config status has matching URLs", mcpConfigStatus.urlMatch);
addCheck("runtime MCP config status has matching enabled flags", mcpConfigStatus.enabledMatch);

const statusReport = formatNovelStatusReport({
  config: loadedConfig,
  mcpConfig: mcpConfigStatus,
  cwd: process.cwd(),
  health: { ok: false, error: "smoke offline" },
});
addCheck("status report includes MCP protocol state", statusReport.includes("protocol enabled for OMP"));

let ok = true;
for (const check of checks) {
  console.log(`${check.ok ? "OK" : "FAILED"} ${check.label}`);
  ok &&= check.ok;
}

process.exit(ok ? 0 : 1);
