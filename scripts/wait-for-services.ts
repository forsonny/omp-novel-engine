type Target = {
  name: string;
  url: string;
  validate: (payload: unknown) => boolean;
};

const timeoutSeconds = Number.parseInt(process.env.STORY_OS_WAIT_SECONDS ?? "120", 10);
const pollIntervalMs = 1000;
const deadline = Date.now() + timeoutSeconds * 1000;

const sleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

const isObject = (value: unknown): value is object => typeof value === "object" && value !== null;

const targets: Target[] = [
  {
    name: "Story OS MCP",
    url: "http://127.0.0.1:7127/health",
    validate: (payload) => isObject(payload) && "ok" in payload && payload.ok === true,
  },
  {
    name: "Qdrant",
    url: "http://127.0.0.1:6333/collections",
    validate: (payload) => {
      if (!isObject(payload)) return false;
      if ("collections" in payload && Array.isArray(payload.collections)) return true;
      if (!(`result` in payload) || !isObject(payload.result)) return false;
      return "collections" in payload.result && Array.isArray(payload.result.collections);
    },
  },
];

const waitForTarget = async (target: Target): Promise<boolean> => {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(target.url, { signal: AbortSignal.timeout(2000) });
      const payload = await response.json();
      if (target.validate(payload)) {
        console.log(`OK ${target.name} is ready at ${target.url}`);
        return true;
      }
    } catch {
      // Keep polling until the shared deadline.
    }

    await sleep(pollIntervalMs);
  }

  console.error(`FAILED timed out waiting for ${target.name} at ${target.url}`);
  return false;
};

const results = await Promise.all(targets.map((target) => waitForTarget(target)));
if (results.some((ok) => !ok)) process.exit(1);
console.log("OK Story OS MCP and Qdrant are ready");
