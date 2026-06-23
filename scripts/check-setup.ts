import { spawnSync } from "node:child_process";
import { qdrantBaseUrl, storyOsBaseUrl, storyOsWorkspaceId } from "./story-os-env";

type Check = {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
};

const checks: Check[] = [];
const requiredMinimumBun = "1.3.14";

const run = (command: string, args: string[] = []) => {
  const result = spawnSync(command, args, { encoding: "utf8", shell: false });
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
};

const compareVersions = (actual: string, minimum: string): number => {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(actual);
  const right = parse(minimum);
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const add = (name: string, ok: boolean, detail: string, required = true) => {
  checks.push({ name, ok, detail, required });
};

const bunVersion = Bun.version;
add("Bun runtime", compareVersions(bunVersion, requiredMinimumBun) >= 0, `${bunVersion} detected; ${requiredMinimumBun}+ required`);

const dockerVersion = run("docker", ["--version"]);
add(
  "Docker CLI",
  dockerVersion.status === 0,
  dockerVersion.status === 0 ? dockerVersion.stdout : "Install Docker Desktop or Docker Engine and add docker to PATH",
);

const dockerInfo = dockerVersion.status === 0 ? run("docker", ["info"]) : { status: 1, stdout: "", stderr: "docker unavailable" };
add(
  "Docker daemon",
  dockerInfo.status === 0,
  dockerInfo.status === 0 ? "Docker daemon is responding" : "Start Docker Desktop or the Docker daemon",
);

const ompVersion = run("omp", ["--version"]);
add(
  "OMP CLI",
  ompVersion.status === 0,
  ompVersion.status === 0 ? ompVersion.stdout : "Install Oh My Pi and add omp to PATH",
);

const expectedWorkspaceId = process.env.STORY_OS_WORKSPACE_ID || storyOsWorkspaceId();
const healthUrls = [
  { name: "Story OS MCP health", url: `${storyOsBaseUrl()}/health` },
  { name: "Qdrant collections", url: `${qdrantBaseUrl()}/collections` },
];

for (const target of healthUrls) {
  try {
    const response = await fetch(target.url, { signal: AbortSignal.timeout(1500) });
    const payload = await response.json().catch(() => ({}));
    const workspaceMatches = target.name !== "Story OS MCP" ||
      (payload && typeof payload === "object" && "workspaceId" in payload && payload.workspaceId === expectedWorkspaceId);
    add(
      target.name,
      response.ok && workspaceMatches,
      response.ok
        ? workspaceMatches
          ? `${target.url} responded`
          : `${target.url} responded with a different workspace identity`
        : `${target.url} returned HTTP ${response.status}`,
      false
    );
  } catch {
    add(target.name, true, `${target.url} is not running yet; start services with bun run services:up`, false);
  }
}

for (const check of checks) {
  const prefix = check.ok ? "OK" : check.required ? "FAIL" : "WARN";
  console.log(`${prefix} ${check.name}: ${check.detail}`);
}

const failedRequired = checks.filter((check) => check.required && !check.ok);
if (failedRequired.length > 0) {
  console.error(`FAILED missing required setup checks: ${failedRequired.map((check) => check.name).join(", ")}`);
  process.exit(1);
}

console.log("OK setup doctor passed");
