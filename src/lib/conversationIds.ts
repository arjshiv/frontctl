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
    const data = await client.getJson<Record<string, unknown>>(routes.appLink(`/open/${id}`));
    const routeId = extractRouteIdFromAppLink(data.app_link, id);
    if (routeId) {
      return routeId;
    }
  } catch {
    // Older Front builds may not expose app_link; retain search as compatibility only.
  }

  const data = await client.getJson<Record<string, unknown>>(routes.searchRaw(id));
  const raw = Array.isArray(data.conversations)
    ? data.conversations
    : Array.isArray(data.conversation_search_results)
      ? data.conversation_search_results
      : [];
  const ids = [...new Set(raw
    .map(extractNumericConversationId)
    .filter((candidate): candidate is string => Boolean(candidate)))];
  if (ids.length === 1) {
    return ids[0];
  }
  if (ids.length > 1) {
    throw new CliError(`Conversation id ${id} resolved to multiple private route ids; use a numeric Front route id explicitly.`, 69);
  }
  throw new CliError(
    `Could not resolve conversation id ${id} through Front's direct link route or compatibility search.`,
    69,
  );
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
