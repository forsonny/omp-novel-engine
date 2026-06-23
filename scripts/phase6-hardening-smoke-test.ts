import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

type Check = { label: string; ok: boolean; details?: string };

const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const PROJECT_SLUG = `phase6-smoke-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const PROJECT_DIR = join(WORKSPACE_ROOT, "stories", PROJECT_SLUG);
const BACKUP_DIR = join(WORKSPACE_ROOT, "backups", "phase6-smoke");
const DEMO_DIR = join(WORKSPACE_ROOT, "stories", "demo");
let demoBackupPath = "";
const checks: Check[] = [];

const addCheck = (label: string, ok: boolean, details = "") => checks.push({ label, ok, details });

const runBun = (args: string[]) => {
  const result = spawnSync("bun", args, {
    cwd: WORKSPACE_ROOT,
    encoding: "utf8",
    env: { ...process.env, STORY_OS_WORKSPACE: WORKSPACE_ROOT },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
};

const parseBackupPath = (stdout: string): string => {
  const match = stdout.match(/OK backup created: (.+)$/m);
  return match ? join(WORKSPACE_ROOT, match[1]) : "";
};

try {
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  mkdirSync(join(PROJECT_DIR, "canon", "graph"), { recursive: true });
  mkdirSync(join(PROJECT_DIR, "chapters"), { recursive: true });
  writeFileSync(join(PROJECT_DIR, "project.yml"), `slug: ${PROJECT_SLUG}\ntitle: Phase 6 Smoke\nmode: standalone\nstatus: scaffold\n`, "utf8");
  writeFileSync(join(PROJECT_DIR, "chapters", "chapter-1.md"), "Ada opened the door.\n", "utf8");

  const unsafeBackup = runBun(["run", "scripts/backup-project.ts", "backup", "--project", "../outside"]);
  addCheck("backup rejects unsafe slug", unsafeBackup.status !== 0, unsafeBackup.stderr || unsafeBackup.stdout);

  const backup = runBun(["run", "scripts/backup-project.ts", "backup", "--project", PROJECT_SLUG, "--out", BACKUP_DIR]);
  const backupPath = parseBackupPath(backup.stdout);
  addCheck("backup command succeeds", backup.status === 0, backup.stderr || backup.stdout);
  addCheck("backup manifest exists", existsSync(join(backupPath, "manifest.json")), backupPath);
  addCheck("backup includes chapter markdown", existsSync(join(backupPath, "project", "chapters", "chapter-1.md")), backupPath);

  writeFileSync(join(PROJECT_DIR, "chapters", "chapter-1.md"), "MUTATED\n", "utf8");
  const restoreRefusal = runBun(["run", "scripts/backup-project.ts", "restore", "--backup", backupPath, "--project", PROJECT_SLUG, "--out", BACKUP_DIR]);
  addCheck("restore requires explicit yes", restoreRefusal.status !== 0, restoreRefusal.stderr || restoreRefusal.stdout);

  const restore = runBun(["run", "scripts/backup-project.ts", "restore", "--backup", backupPath, "--project", PROJECT_SLUG, "--out", BACKUP_DIR, "--yes"]);
  addCheck("restore command succeeds", restore.status === 0, restore.stderr || restore.stdout);
  const restoredText = readFileSync(join(PROJECT_DIR, "chapters", "chapter-1.md"), "utf8");
  addCheck("restore returns backed up content", restoredText === "Ada opened the door.\n", restoredText);

  const resetGuard = runBun(["run", "scripts/reset-demo-project.ts", "--project", PROJECT_SLUG, "--yes", "--backup-dir", BACKUP_DIR]);
  addCheck("demo reset rejects non-demo slug", resetGuard.status !== 0, resetGuard.stderr || resetGuard.stdout);

  const demoBackup = runBun(["run", "scripts/backup-project.ts", "backup", "--project", "demo", "--out", BACKUP_DIR]);
  demoBackupPath = parseBackupPath(demoBackup.stdout);
  addCheck("demo pre-reset backup succeeds", demoBackup.status === 0, demoBackup.stderr || demoBackup.stdout);

  const resetDemo = runBun(["run", "scripts/reset-demo-project.ts", "--project", "demo", "--yes", "--backup-dir", BACKUP_DIR]);
  addCheck("demo reset command succeeds", resetDemo.status === 0, resetDemo.stderr || resetDemo.stdout);
  addCheck("demo reset writes project yaml", existsSync(join(DEMO_DIR, "project.yml")));
  addCheck("demo reset writes mermaid scaffold", existsSync(join(DEMO_DIR, "diagrams", "seven-point-map.mmd")));

  const qualityScan = runBun(["run", "scripts/quality-scan.ts", "--project", "demo"]);
  addCheck("quality scan command succeeds", qualityScan.status === 0, qualityScan.stderr || qualityScan.stdout);
  addCheck("quality scan writes reports", existsSync(join(WORKSPACE_ROOT, "stories", "demo", "reports")));
} finally {
  if (demoBackupPath) {
    runBun(["run", "scripts/backup-project.ts", "restore", "--backup", demoBackupPath, "--project", "demo", "--out", BACKUP_DIR, "--yes"]);
  }
  rmSync(PROJECT_DIR, { recursive: true, force: true });
  rmSync(BACKUP_DIR, { recursive: true, force: true });
}

const allOk = checks.every((check) => check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "OK" : "FAILED"} ${check.label}${check.details ? ` - ${check.details}` : ""}`);
}
process.exit(allOk ? 0 : 1);
