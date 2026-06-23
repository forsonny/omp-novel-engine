import { spawnSync } from "node:child_process";
import { storyOsComposeEnv } from "./story-os-env";

const action = process.argv[2];
const composeFile = "docker/compose.yml";

const run = (args: string[]) => {
  const result = spawnSync("docker", ["compose", "-f", composeFile, ...args], {
    stdio: "inherit",
    shell: false,
    env: storyOsComposeEnv(),
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
};

if (action === "up") {
  run(["up", "-d", "--build"]);
  const wait = spawnSync(process.execPath, ["run", "scripts/wait-for-services.ts"], {
    stdio: "inherit",
    shell: false,
    env: storyOsComposeEnv(),
  });
  process.exit(wait.status ?? 1);
}

if (action === "down") {
  run(["down"]);
  process.exit(0);
}

console.error("Usage: bun run scripts/services.ts <up|down>");
process.exit(1);
