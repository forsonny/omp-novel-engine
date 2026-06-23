import { createHash, createHmac } from "node:crypto";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export const DEFAULT_STORY_OS_HOST = "127.0.0.1";
export const DEFAULT_STORY_OS_HOST_PORT = "7127";
export const DEFAULT_QDRANT_HOST_PORT = "6333";

export function storyOsWorkspaceRoot(): string {
  return resolve(process.env.STORY_OS_WORKSPACE ?? process.cwd());
}

export function storyOsWorkspaceId(workspaceRoot = storyOsWorkspaceRoot()): string {
  const normalized = workspaceRoot.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function storyOsComposeProjectName(workspaceId = storyOsWorkspaceId()): string {
  return `ompnovel${workspaceId.slice(0, 12)}`;
}

export function storyOsAuthToken(workspaceId = storyOsWorkspaceId()): string {
  const explicit = process.env.STORY_OS_AUTH_TOKEN?.trim();
  if (explicit) return explicit;
  return createHash("sha256").update(`story-os-auth:${workspaceId}`).digest("hex");
}

export function storyOsComposeEnv(): Record<string, string | undefined> {
  const workspaceId = storyOsWorkspaceId();
  const token = storyOsAuthToken(workspaceId);
  return {
    ...process.env,
    COMPOSE_PROJECT_NAME: process.env.COMPOSE_PROJECT_NAME || storyOsComposeProjectName(workspaceId),
    STORY_OS_WORKSPACE_ID: process.env.STORY_OS_WORKSPACE_ID || workspaceId,
    STORY_OS_AUTH_TOKEN: token,
    STORY_OS_GATE_DECISION_SECRET: process.env.STORY_OS_GATE_DECISION_SECRET || token,
    STORY_OS_HOST_BIND: process.env.STORY_OS_HOST_BIND || DEFAULT_STORY_OS_HOST,
    STORY_OS_HOST_PORT: process.env.STORY_OS_HOST_PORT || process.env.STORY_OS_PORT || DEFAULT_STORY_OS_HOST_PORT,
    QDRANT_HOST_BIND: process.env.QDRANT_HOST_BIND || DEFAULT_STORY_OS_HOST,
    QDRANT_HOST_PORT: process.env.QDRANT_HOST_PORT || process.env.QDRANT_PORT || DEFAULT_QDRANT_HOST_PORT,
  };
}

export function storyOsBaseUrl(): string {
  const host = process.env.STORY_OS_HOST_BIND || DEFAULT_STORY_OS_HOST;
  const port = process.env.STORY_OS_HOST_PORT || process.env.STORY_OS_PORT || DEFAULT_STORY_OS_HOST_PORT;
  return `http://${host}:${port}`;
}

export function qdrantBaseUrl(): string {
  const host = process.env.QDRANT_HOST_BIND || DEFAULT_STORY_OS_HOST;
  const port = process.env.QDRANT_HOST_PORT || process.env.QDRANT_PORT || DEFAULT_QDRANT_HOST_PORT;
  return `http://${host}:${port}`;
}

export function storyOsAuthHeaders(): Record<string, string> {
  const token = storyOsAuthToken();
  return { authorization: `Bearer ${token}` };
}

export function createGateConfirmationNonce(
  secret: string,
  projectSlug: string,
  gateReference: string,
  gateStatus: string
): string {
  return createHmac("sha256", secret)
    .update(`${projectSlug}:${gateReference}:${gateStatus}`)
    .digest("hex");
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function gateReferenceFromArgs(args: JsonObject): string {
  const gateId = asString(args.gateId);
  if (gateId) return `gate:${gateId}`;
  const gateType = asString(args.gateType);
  return gateType ? `type:${gateType}` : "";
}

export function withGateDecisionConfirmation(path: string, args: JsonObject): JsonObject {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (normalizedPath !== "/api/gate/decision" || typeof args.confirmationNonce === "string") {
    return args;
  }

  const secret = process.env.STORY_OS_GATE_DECISION_SECRET?.trim() || storyOsAuthToken();
  const projectSlug = asString(args.projectSlug);
  const gateStatus = asString(args.decision) || asString(args.humanDecision);
  const gateReference = gateReferenceFromArgs(args);
  if (!secret || !projectSlug || !gateStatus || !gateReference) return args;

  return {
    ...args,
    confirmationNonce: createGateConfirmationNonce(secret, projectSlug, gateReference, gateStatus),
  };
}
