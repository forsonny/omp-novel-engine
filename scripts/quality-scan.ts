import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";

type Finding = {
  file: string;
  line: number;
  category: "aiism" | "dialogue" | "plain_physical_prose" | "narrator_distance" | "continuity";
  severity: "info" | "warning";
  excerpt: string;
  reason: string;
};

const WORKSPACE_ROOT = resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
const STORIES_DIR = resolve(WORKSPACE_ROOT, "stories");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

const PATTERNS: Array<{ category: Finding["category"]; reason: string; pattern: RegExp }> = [
  { category: "aiism", reason: "stock summary phrasing", pattern: /\b(in conclusion|it is important to note|little did (?:he|she|they) know)\b/i },
  { category: "aiism", reason: "generic emotional abstraction", pattern: /\b(a testament to|served as a reminder|couldn't help but)\b/i },
  { category: "dialogue", reason: "dialogue may explain emotion instead of carrying subtext", pattern: /"(?:[^"]*\b(as you know|I feel like|let me explain)\b[^"]*)"/i },
  { category: "plain_physical_prose", reason: "filter verb increases distance from physical action", pattern: /\b(?:felt|noticed|realized|saw|heard|watched)\b/i },
  { category: "narrator_distance", reason: "narrator labels inner state directly", pattern: /\b(?:was angry|was sad|was terrified|felt guilty|felt ashamed)\b/i },
  { category: "continuity", reason: "explicit continuity placeholder marker", pattern: /\b(?:TODO|FIXME|CONTINUITY)\b/i },
];

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

const assertSlug = (slug: string | null): string => {
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`Invalid project slug: ${slug ?? "<missing>"}`);
  }
  return slug;
};

const walkTextFiles = (root: string, current = root): string[] => {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTextFiles(root, absolute));
    } else if (entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(absolute);
    }
  }
  return files.sort();
};

const scanFile = (projectDir: string, filePath: string): Finding[] => {
  const text = readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const findings: Finding[] = [];
  lines.forEach((line, index) => {
    for (const rule of PATTERNS) {
      if (rule.pattern.test(line)) {
        findings.push({
          file: relative(projectDir, filePath).replace(/\\/g, "/"),
          line: index + 1,
          category: rule.category,
          severity: "warning",
          excerpt: line.trim().slice(0, 240),
          reason: rule.reason,
        });
      }
    }
  });
  return findings;
};

const writeReports = (projectDir: string, findings: Finding[]) => {
  const reportDir = join(projectDir, "reports");
  mkdirSync(reportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = join(reportDir, `quality-scan-${stamp}.json`);
  const mdPath = join(reportDir, `quality-scan-${stamp}.md`);
  const summary = {
    generatedAt: new Date().toISOString(),
    findingCount: findings.length,
    categories: Object.fromEntries(
      [...new Set(PATTERNS.map((rule) => rule.category))].map((category) => [
        category,
        findings.filter((finding) => finding.category === category).length,
      ]),
    ),
    findings,
  };

  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeFileSync(
    mdPath,
    [
      "# Quality Scan Report",
      "",
      `Finding count: ${findings.length}`,
      "",
      ...findings.map((finding) => `- ${finding.category} ${finding.file}:${finding.line} - ${finding.reason}`),
      "",
    ].join("\n"),
    "utf8",
  );
  return { jsonPath, mdPath };
};

try {
  const options = parseArgs(process.argv.slice(2));
  const slug = assertSlug(getString(options, "project") ?? "demo");
  const projectDir = assertWorkspacePath(join(STORIES_DIR, slug), "Project path");
  if (!existsSync(projectDir)) {
    throw new Error(`Project not found: ${projectDir}`);
  }

  const scanRoots = ["chapters"].map((entry) => join(projectDir, entry));
  const files = scanRoots.flatMap((root) => walkTextFiles(projectDir, root));
  const findings = files.flatMap((file) => scanFile(projectDir, file));
  const reports = writeReports(projectDir, findings);

  console.log(`OK quality scan project: ${slug}`);
  console.log(`OK scanned files: ${files.length}`);
  console.log(`OK findings: ${findings.length}`);
  console.log(`OK report json: ${relative(WORKSPACE_ROOT, reports.jsonPath).replace(/\\/g, "/")}`);
  console.log(`OK report markdown: ${relative(WORKSPACE_ROOT, reports.mdPath).replace(/\\/g, "/")}`);

  if (findings.length > 0 && options.get("fail-on-findings") === true) {
    process.exit(1);
  }
} catch (error) {
  console.error(`FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
