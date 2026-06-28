import { createFrontPrivateClient, getBoot } from "./frontPrivate.js";
import { buildFrontRoutes } from "./frontRoutes.js";
import type { FrontPaths } from "./paths.js";

export type ResourceKind =
  | "inboxes"
  | "channels"
  | "teammates"
  | "teams"
  | "tags"
  | "signatures"
  | "custom-fields"
  | "contacts"
  | "accounts"
  | "links";

export function compactResource(value: unknown) {
  if (!isObject(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return stripUndefined({
    id: stringField(raw.id),
    alias: stringField(raw.alias),
    name: stringField(raw.name ?? raw.display_name),
    email: stringField(raw.email),
    handle: stringField(raw.handle),
    type: stringField(raw.type ?? raw.class ?? raw.message_type),
    source: stringField(raw.source),
    namespace: stringField(raw.namespace),
    isPrivate: booleanField(raw.is_private),
    inboxId: stringField(raw.inbox_id),
    inboxName: stringField(raw.inbox_name),
    channelId: stringField(raw.channel_id),
    color: stringField(raw.color ?? raw.highlight),
    updatedAt: timestampField(raw.updated_at),
  });
}

export async function listBootResources(kind: ResourceKind, paths: FrontPaths, limit = 100) {
  const boot = await getBoot(paths);
  const raw = bootResourceArray(boot, kind);
  const resources = raw
    .map(compactResource)
    .filter((resource): resource is Record<string, unknown> => Boolean(resource))
    .slice(0, limit);
  return {
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    kind,
    count: resources.length,
    resources,
  };
}

export async function searchFrontHints(query: string, paths: FrontPaths, limit = 20) {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const data = await client.getJson<unknown>(routes.searchHints(query));
  const hints = Array.isArray(data) ? data : Object.values(isObject(data) ? data : {});
  const resources = hints
    .flatMap((hint) => isObject(hint) && Array.isArray(hint.values) ? hint.values : [])
    .map((value) => compactSearchHint(value))
    .filter((value): value is Record<string, unknown> => Boolean(value))
    .slice(0, limit);
  return {
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    query,
    count: resources.length,
    resources,
  };
}

function bootResourceArray(boot: Record<string, unknown>, kind: ResourceKind) {
  if (kind === "teammates") {
    return arrayValue(boot.team);
  }
  if (kind === "custom-fields") {
    return arrayValue(boot.custom_fields);
  }
  if (kind === "contacts" || kind === "accounts" || kind === "links") {
    return [];
  }
  return arrayValue(boot[kind]);
}

function compactSearchHint(value: unknown) {
  if (!isObject(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  return stripUndefined({
    modifier: stringField(raw.modifier),
    title: stringField(raw.title),
    value: stringField(raw.value),
    id: stringField(raw.id),
    type: stringField(raw.type),
  });
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function stringField(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function booleanField(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function timestampField(value: unknown) {
  return typeof value === "number" && value > 0 ? new Date(value).toISOString() : undefined;
}

function stripUndefined(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
