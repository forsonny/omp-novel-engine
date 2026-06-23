import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { storyOsPost } from "../clients/storyOsClient";

type JsonMap = Record<string, unknown>;
type HookContext = {
  cwd?: string;
  hasUI?: boolean;
  ui?: {
    notify?: (message: string, level: string) => void;
  };
};

const asObject = (value: unknown): JsonMap => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {}
);

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const commandText = (input: unknown): string => {
  if (typeof input === "string") return input;
  const maybe = asObject(input);
  return String(maybe.command ?? maybe.cmd ?? maybe.code ?? maybe.script ?? maybe.input ?? "");
};

const contextCwd = (ctx: unknown): string => asString(asObject(ctx).cwd) || process.cwd();

const systemMessage = (text: string) => ({
  role: "system",
  content: [{ type: "text", text }]
});

const messageEnvelope = (text: string) => ({
  messages: [systemMessage(text)]
});

const formatStoryState = (label: string, data: unknown): string => (
  `${label}:\n${JSON.stringify(data, null, 2)}`
);

const hardConstraintText = (memory: unknown): string => [
  "Story OS hard constraints for this turn:",
  "- Do not continue downstream drafting until the current human gate is approved.",
  "- Do not mark a chapter complete until post-prose gates and final human approval pass.",
  "- Preserve locked canon; route canon, graph, and chapter artifact changes through Story OS tools.",
  "- Produce and compare canon-tight, character-heavy, and plot-accelerated chapter variants before selection.",
  formatStoryState("Current Story OS state", memory)
].join("\n");

const unsafeShellReason = (text: string): string => {
  const dangerousDelete = /rm\s+-rf|rmdir\s+\/s|del\s+\/f|format\s+[a-z]:/i.test(text);
  const directCanonMutation = /canon\.db|canon[\\/]+graph/i.test(text)
    && /(sqlite3|rm|del|write|echo\s+.*>|cat\s*>|Set-Content|Out-File)/i.test(text);
  const unsafeStoryWrite = /stories[\\/][^\\s]+/i.test(text)
    && /(rm\s+-rf|rmdir\s+\/s|del\s+\/f|Set-Content|Out-File|cat\s*>)/i.test(text);

  if (dangerousDelete) return "Blocked destructive shell command.";
  if (directCanonMutation) return "Blocked direct canon database or graph mutation; use Story OS tools.";
  if (unsafeStoryWrite) return "Blocked direct story artifact mutation; use backup, restore, or Story OS tools.";
  return "";
};

const unsafePythonReason = (text: string): string => {
  const touchesCanon = /canon\.db|canon[\\/]+graph|stories[\\/][^\\s]+/i.test(text);
  const writesFiles = /sqlite3\.connect|open\([^)]*[\"'](?:w|a|x|\\+)|write_text|write_bytes|unlink\(|rmtree\(|remove\(/i.test(text);
  return touchesCanon && writesFiles
    ? "Blocked direct Python mutation of canon or story artifacts; use Story OS tools."
    : "";
};

const blockedBashResult = (reason: string) => ({
  result: {
    output: reason,
    exitCode: 1,
    cancelled: false,
    truncated: false,
    totalLines: 1,
    totalBytes: reason.length,
    outputLines: 1,
    outputBytes: reason.length
  }
});

const blockedPythonResult = (reason: string) => ({
  result: {
    output: reason,
    exitCode: 1,
    cancelled: false,
    truncated: false,
    totalLines: 1,
    totalBytes: reason.length,
    outputLines: 1,
    outputBytes: reason.length,
    displayOutputs: [],
    stdinRequested: false
  }
});

const readStoryContext = async (cwd: string) => {
  const memory = await storyOsPost("/api/context/relevant", { cwd });
  return memory.ok ? memory.data : { ok: false, error: memory.error };
};

const compactState = async (cwd: string) => {
  const summary = await storyOsPost("/api/session/compact-summary", { cwd });
  if (!summary.ok) return undefined;
  return {
    compaction: {
      summary: "Story OS canon, gates, promises, and chapter state preserved.",
      details: summary.data
    },
    ...messageEnvelope(formatStoryState("Compacted Story OS state", summary.data))
  } as unknown;
};

const compactContextState = async (cwd: string) => {
  const summary = await storyOsPost("/api/session/compact-summary", { cwd });
  if (!summary.ok) return undefined;
  return {
    context: [formatStoryState("Compacted Story OS state", summary.data)],
    preserveData: { storyOs: summary.data }
  };
};

export function registerHooks(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: HookContext) => {
    const cwd = contextCwd(ctx);
    await storyOsPost("/api/session/start", { cwd });
    const memory = await readStoryContext(cwd);
    if (ctx.hasUI && ctx.ui?.notify) ctx.ui.notify("OMP Novel Engine loaded. Use /novel:status.", "info");
    return messageEnvelope(formatStoryState("Loaded Story OS state", memory));
  });

  pi.on("context", async (event, ctx: HookContext) => {
    const eventObject = asObject(event);
    if (!Array.isArray(eventObject.messages)) return undefined;
    const memory = await readStoryContext(contextCwd(ctx));
    return { messages: [...eventObject.messages, systemMessage(hardConstraintText(memory))] };
  });

  pi.on("before_provider_request", async (event, ctx: HookContext) => {
    const eventObject = asObject(event);
    const payload = asObject(eventObject.payload);
    const memory = await readStoryContext(contextCwd(ctx));
    const constraintMessage = {
      role: "system",
      content: [{ type: "text", text: hardConstraintText(memory) }]
    };
    if (Array.isArray(payload.messages)) {
      return { ...payload, messages: [...payload.messages, constraintMessage] };
    }
    const request = asObject(payload.request);
    if (Array.isArray(request.messages)) {
      return { ...payload, request: { ...request, messages: [...request.messages, constraintMessage] } };
    }
    return undefined;
  });

  pi.on("tool_call", async (event) => {
    const eventObject = asObject(event);
    const toolName = asString(eventObject.toolName);
    const text = commandText(eventObject.input);
    const shellReason = toolName === "bash" || toolName === "shell" ? unsafeShellReason(text) : "";
    const pythonReason = toolName === "python" ? unsafePythonReason(text) : "";
    const reason = shellReason || pythonReason;
    return reason ? { block: true, reason } : undefined;
  });

  pi.on("tool_result", async (event, ctx: HookContext) => {
    const eventObject = asObject(event);
    await storyOsPost("/api/tool/result", {
      cwd: contextCwd(ctx),
      projectSlug: asString(eventObject.projectSlug),
      toolName: asString(eventObject.toolName),
      isError: eventObject.isError === true,
      details: eventObject.details ?? null
    });
    return undefined;
  });

  pi.on("session_before_compact", async (_event, ctx: HookContext) => compactState(contextCwd(ctx)));
  pi.on("session.compacting", async (_event, ctx: HookContext) => compactContextState(contextCwd(ctx)));

  pi.on("session_stop", async (_event, ctx: HookContext) => {
    await storyOsPost("/api/session/stop", { cwd: contextCwd(ctx), allowDrafting: false });
    return undefined;
  });

  pi.on("user_bash", async (event) => {
    const reason = unsafeShellReason(commandText(event));
    return reason ? blockedBashResult(reason) : undefined;
  });

  pi.on("user_python", async (event) => {
    const reason = unsafePythonReason(commandText(event));
    return reason ? blockedPythonResult(reason) : undefined;
  });

  pi.on("turn_end", async (event, ctx: HookContext) => {
    const eventObject = asObject(event);
    await storyOsPost("/api/turn/end", {
      cwd: contextCwd(ctx),
      projectSlug: asString(eventObject.projectSlug),
      details: eventObject
    });
  });
}
