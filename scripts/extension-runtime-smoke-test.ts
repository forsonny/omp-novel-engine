import novelEngine from "../.omp/extensions/novel-engine/index";

type SchemaChain = {
  optional: () => SchemaChain;
  passthrough: () => SchemaChain;
  int: () => SchemaChain;
  positive: () => SchemaChain;
  min: (_value: number) => SchemaChain;
  max: (_value: number) => SchemaChain;
  parse: <T>(value: T) => T;
};

type MockContext = {
  cwd?: string;
  hasUI?: boolean;
  ui: {
    input: (label: string, initialValue?: string) => Promise<string>;
    notify: (message: string, level: string) => void;
  };
};

type MockCommand = {
  description?: string;
  handler: (args: unknown, ctx: MockContext) => Promise<void> | void;
};

type MockTool = {
  name: string;
  execute?: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
};

type MockHook = {
  name: string;
  handler: (event: unknown, ctx: MockContext) => Promise<unknown> | unknown;
};

type JsonMap = Record<string, unknown>;

const checks: Array<{ label: string; ok: boolean; details?: string }> = [];
const addCheck = (label: string, ok: boolean, details = "") => checks.push({ label, ok, details });
const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
);


const schemaChain = (): SchemaChain => ({
  optional: schemaChain,
  passthrough: schemaChain,
  int: schemaChain,
  positive: schemaChain,
  min: schemaChain,
  max: schemaChain,
  parse: (value) => value,
});

const z = {
  object: (_shape: unknown) => schemaChain(),
  string: () => schemaChain(),
  number: () => schemaChain(),
  boolean: () => schemaChain(),
  enum: (_values: readonly string[]) => schemaChain(),
  array: (_schema: unknown) => schemaChain(),
  unknown: () => schemaChain(),
};

const commands: Array<{ name: string; command: MockCommand }> = [];
const tools: MockTool[] = [];
const hooks: MockHook[] = [];
const labels: string[] = [];
const messages: string[] = [];
const entries: unknown[] = [];

const pi = {
  zod: { z },
  setLabel: (label: string) => labels.push(label),
  on: (name: string, handler: MockHook["handler"]) => hooks.push({ name, handler }),
  registerTool: (tool: MockTool) => tools.push(tool),
  registerCommand: (name: string, command: MockCommand) => commands.push({ name, command }),
  sendMessage: async (message: string) => {
    messages.push(message);
  },
  appendEntry: async (...args: unknown[]) => {
    entries.push(args);
  },
};

const requiredCommands = [
  "novel:status",
  "novel:new",
  "novel:draft-chapter",
  "novel:revise-chapter",
  "serial:plan-season",
  "serial:plan-arc",
  "serial:next-episode",
  "serial:recap",
];

const requiredTools = [
  "story_project_status",
  "novel_project_status",
  "novel_pending_gate",
  "novel_variant_compare",
  "story_serial_season_plan",
  "story_serial_arc_plan",
  "story_serial_next_episode",
  "story_serial_promise_upsert",
  "story_serial_promise_list",
  "story_serial_recap_generate",
  "story_serial_season_report",
];

const requiredHooks = [
  "session_start",
  "context",
  "before_provider_request",
  "tool_call",
  "tool_result",
  "session_before_compact",
  "session.compacting",
  "session_stop",
  "user_bash",
  "user_python",
  "turn_end",
];

const mcpOk = (data: JsonMap) => ({ ok: true, data, warnings: [], gate: null });
const mcpError = (code: string, error: string) => ({ ok: false, code, error, recoverable: true });
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

let variantListCalls = 0;
const routeCalls: string[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  routeCalls.push(url.pathname);

  if (url.pathname === "/api/project/status") {
    return jsonResponse(mcpOk({
      projects: [
        {
          project: { slug: "runtime-smoke", mode: "standalone" },
          pendingGates: [],
          workflow: { currentStage: "chapter", allowedNextAction: "draft" },
        },
      ],
      pendingGates: [],
    }));
  }

  if (url.pathname === "/api/chapter/variant/list") {
    variantListCalls += 1;
    if (variantListCalls === 1) {
      return jsonResponse(mcpError("CHAPTER_NOT_FOUND", "Chapter not found"), 500);
    }
    return jsonResponse(mcpOk({
      chapterId: "chapter-one",
      variantCount: 0,
      selectedVariantId: "",
      variants: [],
    }));
  }

  if (url.pathname === "/api/chapter/outline") {
    return jsonResponse(mcpOk({
      chapter: { id: "chapter-one", status: "outlined" },
      artifactId: "runtime-smoke-outline",
    }));
  }

  if (url.pathname === "/api/gate/blockers") {
    return jsonResponse(mcpOk({ blockers: [] }));
  }

  if (url.pathname === "/api/context/relevant") {
    return jsonResponse(mcpOk({
      project: { slug: "runtime-smoke" },
      pendingGates: [],
    }));
  }

  if (url.pathname === "/api/session/compact-summary") {
    return jsonResponse(mcpOk({
      project: { slug: "runtime-smoke" },
      pendingGates: [],
      noDrafting: true,
    }));
  }

  return jsonResponse(mcpError("UNEXPECTED_ROUTE", url.pathname), 500);
};

try {
  novelEngine(pi);

  addCheck("extension label registered", labels.includes("OMP Novel Engine"));
  for (const name of requiredCommands) {
    addCheck(`command registered ${name}`, commands.some((entry) => entry.name === name && typeof entry.command.handler === "function"));
  }
  for (const name of requiredTools) {
    addCheck(`tool registered ${name}`, tools.some((tool) => tool.name === name && typeof tool.execute === "function"));
  }
  for (const name of requiredHooks) {
    addCheck(`hook registered ${name}`, hooks.some((hook) => hook.name === name && typeof hook.handler === "function"));
  }

  const hookByName = (name: string) => hooks.find((hook) => hook.name === name);
  const contextResult = await hookByName("context")?.handler({
    messages: [{ role: "user", content: "Keep this user message." }],
  }, {
    cwd: process.cwd(),
    ui: { input: async () => "", notify: () => undefined },
  });
  const contextPayload = asRecord(contextResult);
  const contextMessages = Array.isArray(contextPayload.messages) ? contextPayload.messages : [];
  addCheck(
    "context hook preserves messages",
    contextMessages.length === 2 && asRecord(contextMessages[0]).role === "user",
    JSON.stringify(contextResult),
  );
  addCheck(
    "context hook appends constraints",
    contextMessages.some((entry) => JSON.stringify(entry).includes("Story OS hard constraints")),
    JSON.stringify(contextResult),
  );
  const userBashResult = await hookByName("user_bash")?.handler({ command: "rm -rf stories/demo" }, {
    cwd: process.cwd(),
    ui: { input: async () => "", notify: () => undefined },
  });
  const userBashPayload = asRecord(asRecord(userBashResult).result);
  addCheck(
    "user_bash returns handled failure",
    userBashPayload.exitCode === 1
      && userBashPayload.cancelled === false
      && userBashPayload.truncated === false
      && userBashPayload.totalLines === 1
      && String(userBashPayload.output ?? "").includes("Blocked"),
    JSON.stringify(userBashResult),
  );

  const userPythonResult = await hookByName("user_python")?.handler({ code: "import sqlite3; sqlite3.connect('stories/demo/canon/canon.db')" }, {
    cwd: process.cwd(),
    ui: { input: async () => "", notify: () => undefined },
  });
  const userPythonPayload = asRecord(asRecord(userPythonResult).result);
  addCheck(
    "user_python returns handled failure",
    userPythonPayload.exitCode === 1
      && userPythonPayload.cancelled === false
      && userPythonPayload.truncated === false
      && Array.isArray(userPythonPayload.displayOutputs)
      && userPythonPayload.stdinRequested === false
      && String(userPythonPayload.output ?? "").includes("Blocked"),
    JSON.stringify(userPythonResult),
  );

  const compactingResult = await hookByName("session.compacting")?.handler({}, {
    cwd: process.cwd(),
    ui: { input: async () => "", notify: () => undefined },
  });
  const compactingPayload = asRecord(compactingResult);
  const compactingContext = Array.isArray(compactingPayload.context) ? compactingPayload.context : [];
  addCheck("session.compacting preserves context", compactingContext.some((entry) => String(entry).includes("Compacted Story OS state")), JSON.stringify(compactingResult));

  const providerResult = await hookByName("before_provider_request")?.handler({
    type: "before_provider_request",
    payload: { messages: [{ role: "user", content: "Draft the next beat." }] },
  }, {
    cwd: process.cwd(),
    ui: { input: async () => "", notify: () => undefined },
  });
  const providerPayload = asRecord(providerResult);
  const providerMessages = Array.isArray(providerPayload.messages) ? providerPayload.messages : [];
  addCheck(
    "before_provider_request preserves payload",
    providerMessages.length === 2 && asRecord(providerMessages[0]).role === "user",
    JSON.stringify(providerResult),
  );
  addCheck(
    "before_provider_request appends constraints",
    providerMessages.some((entry) => JSON.stringify(entry).includes("Story OS hard constraints")),
    JSON.stringify(providerResult),
  );

  const draftCommand = commands.find((entry) => entry.name === "novel:draft-chapter")?.command;
  if (!draftCommand) {
    addCheck("draft command available for invocation", false);
  } else {
    await draftCommand.handler({ chapterId: "chapter-one" }, {
      cwd: process.cwd(),
      hasUI: true,
      ui: {
        input: async (label: string, initialValue?: string) => {
          if (label === "Chapter title (optional)") return "Runtime Smoke Chapter";
          if (label === "Chapter number") return "1";
          return initialValue ?? "";
        },
        notify: () => undefined,
      },
    });

    const joinedMessages = messages.join("\n---\n");
    addCheck("draft command queried project status", routeCalls.includes("/api/project/status"), routeCalls.join(", "));
    addCheck("draft command recovered missing chapter", routeCalls.includes("/api/chapter/outline"), routeCalls.join(", "));
    addCheck("draft command rechecked variants", variantListCalls === 2, String(variantListCalls));
    addCheck("draft command sent workflow guidance", joinedMessages.includes("Draft workflow for chapter chapter-one"), joinedMessages);
    addCheck("draft command reports new outline", joinedMessages.includes("Started new chapter outline."), joinedMessages);
    addCheck("draft command avoids error path", !joinedMessages.includes("could not continue"), joinedMessages);
  }
} finally {
  globalThis.fetch = originalFetch;
}

const ok = checks.every((check) => check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "OK" : "FAILED"} ${check.label}${check.details ? ` - ${check.details}` : ""}`);
}

process.exit(ok ? 0 : 1);
