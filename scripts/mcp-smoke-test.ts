import { readFileSync } from "node:fs";

type ServerConfig = {
  url: string | null;
  enabled: boolean | null;
  type: string | null;
  timeout: number | null;
  exists: boolean;
};

const checks: Array<{ label: string; ok: boolean }> = [];
const addCheck = (label: string, ok: boolean) => checks.push({ label, ok });

const targets = [".omp/mcp.json", ".mcp.json"];

const readNovelConfig = (path: string): ServerConfig | null => {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    addCheck(`MISSING ${path}`, false);
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    const server = parsed?.mcpServers?.["novel-story-os"];
    if (!server) {
      addCheck(`${path} has novel-story-os server`, false);
      return { url: null, enabled: null, type: null, timeout: null, exists: false };
    }

    const url = typeof server.url === "string" ? server.url.trim() : null;
    const enabled = typeof server.enabled === "boolean" ? server.enabled : null;
    const type = typeof server.type === "string" ? server.type.trim() : null;
    const timeout = typeof server.timeout === "number" ? server.timeout : null;

    addCheck(`${path} has novel-story-os.url`, url !== null);
    addCheck(`${path} has novel-story-os.enabled`, enabled !== null);
    addCheck(`${path} has novel-story-os.type`, type !== null);
    addCheck(`${path} has novel-story-os.timeout`, timeout !== null);
    return { url, enabled, type, timeout, exists: true };
  } catch {
    addCheck(`INVALID ${path}`, false);
    return null;
  }
};

const canonical = readNovelConfig(targets[0]);
const mirror = readNovelConfig(targets[1]);

if (canonical && mirror && canonical.exists && mirror.exists) {
  addCheck("novel-story-os.url matches between .omp/mcp.json and .mcp.json", canonical.url === mirror.url);
  addCheck("novel-story-os.type matches between .omp/mcp.json and .mcp.json", canonical.type === mirror.type);
  addCheck("novel-story-os.timeout matches between .omp/mcp.json and .mcp.json", canonical.timeout === mirror.timeout);
  addCheck(
    "novel-story-os.enabled matches between .omp/mcp.json and .mcp.json",
    canonical.enabled === mirror.enabled,
  );
  addCheck("novel-story-os.type is http in .omp/mcp.json", canonical.type === "http");
  addCheck("novel-story-os.type is http in .mcp.json", mirror.type === "http");
  addCheck("novel-story-os.enabled is true in .omp/mcp.json", canonical.enabled === true);
  addCheck("novel-story-os.enabled is true in .mcp.json", mirror.enabled === true);
}

const allOk = checks.every((check) => check.ok);

for (const check of checks) {
  console.log(`${check.ok ? "OK" : "FAILED"} ${check.label}`);
}

process.exit(allOk ? 0 : 1);
