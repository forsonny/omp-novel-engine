import { loadNovelEngineConfig } from "../config/novelEngineConfig";

export type StoryOsResult<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

export type StoryOsRequestOptions = {
  cwd?: string;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:7127";
const DEFAULT_TIMEOUT_MS = 3_000;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function getRequestTimeoutMs(options?: StoryOsRequestOptions): number {
  if (typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    return options.timeoutMs;
  }

  const fromEnv = process.env.STORY_OS_REQUEST_TIMEOUT_MS;
  if (!fromEnv) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(fromEnv, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

export function getStoryOsBaseUrl(cwd?: string): string {
  const envOverride = process.env.STORY_OS_BASE_URL?.trim();
  if (envOverride) return normalizeBaseUrl(envOverride);

  const config = loadNovelEngineConfig(cwd);
  return normalizeBaseUrl(config.mcp.baseUrl || DEFAULT_BASE_URL);
}

async function requestStoryOs<T = unknown>(
  path: string,
  init: RequestInit,
  options?: StoryOsRequestOptions
): Promise<StoryOsResult<T>> {
  const baseUrl = getStoryOsBaseUrl(options?.cwd);
  const url = `${baseUrl}${normalizePath(path)}`;
  const controller = new AbortController();
  const timeout = getRequestTimeoutMs(options);
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        "accept": "application/json"
      }
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        ok: false,
        error: `${response.status} ${response.statusText}`,
        data: data as T
      };
    }
    return { ok: true, data: data as T };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (typeof error === "object" && error !== null) {
      const typed = error as { name?: string };
      if (typed.name === "AbortError") {
        return { ok: false, error: `Request timed out after ${timeout}ms` };
      }
    }

    if (message.includes("This operation was aborted")) {
      return { ok: false, error: `Request timed out after ${timeout}ms` };
    }

    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function storyOsGet<T = unknown>(
  path: string,
  options?: StoryOsRequestOptions
): Promise<StoryOsResult<T>> {
  return requestStoryOs<T>(path, { method: "GET" }, options);
}

export async function storyOsPost<T = unknown>(
  path: string,
  body: unknown,
  options?: StoryOsRequestOptions
): Promise<StoryOsResult<T>> {
  return requestStoryOs<T>(path, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body ?? {})
  }, options);
}
