import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type Command = "backup" | "restore" | "list";

type BackupManifest = {
  kind: "omp-novel-engine-project-backup";
  version: 1;
  projectSlug: string;
  createdAt: string;
  sourceProjectDir: string;
  files: string[];
  configFiles: string[];
};

const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const STORIES_DIR = resolve(WORKSPACE_ROOT, "stories");
const DEFAULT_BACKUP_DIR = resolve(WORKSPACE_ROOT, "backups");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const usage = () => {
  console.error(
    [
      "Usage:",
      "  bun run scripts/backup-project.ts backup --project <slug> [--out <backup-dir>]",
      "  bun run scripts/backup-project.ts restore --backup <backup-path> [--project <slug>] [--yes]",
      "  bun run scripts/backup-project.ts list [--out <backup-dir>]",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const options = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        options.set(key, true);
      } else {
        options.set(key, next);
        index += 1;
      }
    } else {
      positionals.push(arg);
    }
  }

  const command = (positionals[0] ?? "backup") as Command;
  return { command, options };
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

const assertSlug = (slug: string | null): string => {
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Invalid project slug: ${slug ?? "<missing>"}`);
  }
  return slug;
};

const projectDir = (slug: string): string => assertWorkspacePath(join(STORIES_DIR, slug), "Project path");

const collectFiles = (root: string, current = root): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(root, absolute));
    } else if (entry.isFile()) {
      files.push(relative(root, absolute).replace(/\\/g, "/"));
    }
  }
  return files.sort();
};

const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");

const CONFIG_FILES = [".omp/novel-engine/config.yml", ".omp/mcp.json", ".mcp.json"];

const copyWorkspaceConfig = (target: string): string[] => {
  const copied: string[] = [];
  for (const configFile of CONFIG_FILES) {
    const source = assertWorkspacePath(join(WORKSPACE_ROOT, configFile), "Config source");
    if (!existsSync(source)) continue;
    const destination = assertWorkspacePath(join(target, "config", configFile), "Config backup target");
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { force: false, errorOnExist: true });
    copied.push(configFile);
  }
  return copied;
};

const readManifest = (backupPath: string): BackupManifest => {
  const manifestPath = join(backupPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Backup manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as BackupManifest;
  if (manifest.kind !== "omp-novel-engine-project-backup" || manifest.version !== 1 || !SLUG_RE.test(manifest.projectSlug)) {
    throw new Error(`Invalid backup manifest: ${manifestPath}`);
  }
  return manifest;
};

const createBackup = (slug: string, outDir: string, prefix = slug): string => {
  const source = projectDir(slug);
  if (!existsSync(source)) {
    throw new Error(`Project not found: ${source}`);
  }

  const safeOutDir = assertWorkspacePath(outDir, "Backup directory");
  mkdirSync(safeOutDir, { recursive: true });

  const target = assertWorkspacePath(join(safeOutDir, `${prefix}-${timestamp()}`), "Backup target");
  mkdirSync(dirname(target), { recursive: true });
  const projectPayload = join(target, "project");
  cpSync(source, projectPayload, { recursive: true, force: false, errorOnExist: true });
  const configFiles = copyWorkspaceConfig(target);

  const manifest: BackupManifest = {
    kind: "omp-novel-engine-project-backup",
    version: 1,
    projectSlug: slug,
    createdAt: new Date().toISOString(),
    sourceProjectDir: relative(WORKSPACE_ROOT, source).replace(/\\/g, "/"),
    files: collectFiles(projectPayload),
    configFiles,
  };
  writeFileSync(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return target;
};

const restoreBackup = (backupPathInput: string | null, requestedSlug: string | null, yes: boolean, outDir: string): string => {
  if (!yes) {
    throw new Error("Restore requires --yes because it replaces a story project directory.");
  }
  if (!backupPathInput) {
    throw new Error("Missing --backup <backup-path>");
  }

  const backupPath = assertWorkspacePath(backupPathInput, "Backup path");
  const manifest = readManifest(backupPath);
  const slug = assertSlug(requestedSlug ?? manifest.projectSlug);
  const target = projectDir(slug);

  if (existsSync(target)) {
    createBackup(slug, outDir, `${slug}-pre-restore`);
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(backupPath, "project"), target, { recursive: true });
  return target;
};

const listBackups = (outDir: string): string[] => {
  const safeOutDir = assertWorkspacePath(outDir, "Backup directory");
  if (!existsSync(safeOutDir)) return [];
  return readdirSync(safeOutDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(safeOutDir, entry.name, "manifest.json")))
    .map((entry) => join(safeOutDir, entry.name))
    .sort();
};

try {
  const { command, options } = parseArgs(process.argv.slice(2));
  const outDir = resolve(getString(options, "out") ?? getString(options, "backup-dir") ?? DEFAULT_BACKUP_DIR);

  if (command === "backup") {
    const slug = assertSlug(getString(options, "project"));
    const backupPath = createBackup(slug, outDir);
    console.log(`OK backup created: ${relative(WORKSPACE_ROOT, backupPath).replace(/\\/g, "/")}`);
  } else if (command === "restore") {
    const targetPath = restoreBackup(getString(options, "backup"), getString(options, "project"), options.get("yes") === true, outDir);
    console.log(`OK backup restored: ${relative(WORKSPACE_ROOT, targetPath).replace(/\\/g, "/")}`);
  } else if (command === "list") {
    for (const backupPath of listBackups(outDir)) {
      const manifest = readManifest(backupPath);
      console.log(`${relative(WORKSPACE_ROOT, backupPath).replace(/\\/g, "/")} ${manifest.projectSlug} ${manifest.createdAt}`);
    }
  } else {
    usage();
    process.exit(2);
  }
} catch (error) {
  console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
