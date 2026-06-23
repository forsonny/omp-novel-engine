import { rmSync } from "node:fs";
import { dirname, join } from "node:path";

const serverRoot = dirname(import.meta.dir);
const outdir = join(serverRoot, ".check");
const entrypoint = join(serverRoot, "src", "server.ts");

try {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir,
    target: "bun",
    packages: "external",
  });

  for (const log of result.logs) {
    console.error(log.message);
  }

  if (!result.success) {
    process.exit(1);
  }
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
