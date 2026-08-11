import { CliError } from "./cli.js";
import type { FrontPrivateClient } from "./frontPrivate.js";
import type { FrontRoutes } from "./frontRoutes.js";

export function shouldResolvePrivateConversationRouteId(id: string) {
  return /^cnv_[A-Za-z0-9]+$/.test(id);
}

export async function resolvePrivateConversationRouteId(
  client: FrontPrivateClient,
  routes: FrontRoutes,
  id: string,
) {
  if (!shouldResolvePrivateConversationRouteId(id)) {
    return id;
  }

  try {
    const data = await client.getJson<Record<string, unknown>>(routes.searchRaw(id));
    const ids = extractSearchRouteIds(data);
    if (ids.length === 1) {
      return ids[0];
    }
  } catch {
    // A new conversation may not be indexed yet; resolve its authenticated deep link below.
  }

  try {
    const data = await client.getJson<Record<string, unknown>>(routes.appLink(`/open/${id}`));
    const routeId = extractRouteIdFromAppLink(data.app_link, id);
    if (routeId) {
      return routeId;
    }
  } catch {
    // Report one stable resolution error after both private live routes fail.
  }

  throw new CliError(
    `Could not resolve conversation id ${id} through Front's search index or direct link route.`,
    69,
  );
}

function extractSearchRouteIds(data: Record<string, unknown>) {
  const raw = Array.isArray(data.conversations)
    ? data.conversations
    : Array.isArray(data.conversation_search_results)
      ? data.conversation_search_results
      : [];
  return [...new Set(raw
    .map(extractNumericConversationId)
    .filter((candidate): candidate is string => Boolean(candidate)))];
}

export function extractRouteIdFromAppLink(value: unknown, conversationId: string) {
  if (typeof value !== "string") {
    return undefined;
  }
  const segments = value.split("/").map((segment) => decodeURIComponent(segment));
  const markerIndex = segments.lastIndexOf(`id:${conversationId}`);
  const candidate = markerIndex >= 0 ? segments[markerIndex + 1] : undefined;
  return candidate && /^\d+$/.test(candidate) ? candidate : undefined;
}

function extractNumericConversationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const nested = record.conversation && typeof record.conversation === "object"
    ? record.conversation as Record<string, unknown>
    : undefined;
  const candidate = record.id ?? record.conversation_id ?? nested?.id ?? nested?.conversation_id;
  if (typeof candidate !== "number" && typeof candidate !== "string") {
    return undefined;
  }
  const id = String(candidate);
  return /^\d+$/.test(id) ? id : undefined;
}
