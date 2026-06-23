import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const STORIES_DIR = resolve(WORKSPACE_ROOT, "stories");
const DEMO_SLUG = "demo";

const parseArgs = (argv: string[]) => {
  const options = new Map<string, string | boolean>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, true);
    } else {
      options.set(key, next);
      index += 1;
    }
  }
  return options;
};

const getString = (options: Map<string, string | boolean>, key: string): string | null => {
  const value = options.get(key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
};

const assertWorkspacePath = (candidate: string, label: string): string => {
  const absolute = resolve(candidate);
  const rel = relative(WORKSPACE_ROOT, absolute);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return absolute;
  }
  throw new Error(`${label} must stay inside workspace: ${candidate}`);
};

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const writeFile = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
};

try {
  const options = parseArgs(process.argv.slice(2));
  const slug = getString(options, "project") ?? DEMO_SLUG;
  if (slug !== DEMO_SLUG) {
    throw new Error("Demo reset only supports --project demo.");
  }
  if (options.get("yes") !== true) {
    throw new Error("Demo reset requires --yes because it replaces stories/demo.");
  }

  const demoDir = assertWorkspacePath(join(STORIES_DIR, DEMO_SLUG), "Demo project path");
  const backupDir = assertWorkspacePath(resolve(getString(options, "backup-dir") ?? join(WORKSPACE_ROOT, "backups")), "Backup directory");

  if (existsSync(demoDir) && options.get("skip-backup") !== true) {
    const backupPath = assertWorkspacePath(join(backupDir, `demo-pre-reset-${timestamp()}`), "Demo backup path");
    mkdirSync(backupDir, { recursive: true });
    cpSync(demoDir, backupPath, { recursive: true, force: false, errorOnExist: true });
    console.log(`OK demo backup created: ${relative(WORKSPACE_ROOT, backupPath).replace(/\\/g, "/")}`);
  }

  rmSync(demoDir, { recursive: true, force: true });
  mkdirSync(join(demoDir, "canon", "graph"), { recursive: true });
  mkdirSync(join(demoDir, "chapters"), { recursive: true });
  mkdirSync(join(demoDir, "diagrams"), { recursive: true });
  writeFile(
    join(demoDir, "project.yml"),
    ["slug: demo", "title: Demo Story", "mode: standalone", "status: scaffold", ""].join("\n"),
  );
  writeFile(
    join(demoDir, "diagrams", "seven-point-map.mmd"),
    ["flowchart TD", "  Hook[Demo hook]", "  Resolution[Demo resolution]", "  Hook --> Resolution", ""].join("\n"),
  );

  console.log(`OK demo project reset: ${relative(WORKSPACE_ROOT, demoDir).replace(/\\/g, "/")}`);
} catch (error) {
  console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
