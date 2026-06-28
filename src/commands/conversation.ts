import { CliError } from "../lib/cli.js";
import { normalizeConversation, normalizeTimeline, readCachedConversation } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { firstPositionalArg, maybeRenderConversationRead } from "../lib/render.js";

export async function readConversation(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const id = firstPositionalArg(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }

  if (args.includes("--offline-cache")) {
    return maybeRenderConversationRead(await readCachedConversation(paths.cacheDataPath, id), args);
  }

  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const full = args.includes("--full");
  const [conversation, timeline, content, events, inboxes, followers] = await Promise.all([
    client.getJson<Record<string, unknown>>(routes.conversation(id)),
    client.getJson<Record<string, unknown>>(routes.timeline(id)),
    full ? client.getJson<Record<string, unknown>>(routes.content(id)).catch((error) => ({ error: String(error) })) : undefined,
    full ? client.getJson<Record<string, unknown>>(routes.conversationEvents(id)).catch((error) => ({ error: String(error) })) : undefined,
    full ? client.getJson<Record<string, unknown>>(routes.conversationInboxes(id)).catch((error) => ({ error: String(error) })) : undefined,
    full ? client.getJson<Record<string, unknown>>(routes.conversationFollowers(id)).catch((error) => ({ error: String(error) })) : undefined,
  ]);
  const timelineValue = Array.isArray(timeline.timeline) ? timeline.timeline : timeline;
  return maybeRenderConversationRead({
    source: "live-private",
    transport: client.transport,
    stale: false,
    publicApiUsed: false,
    id,
    conversation: normalizeConversation(conversation),
    timeline: normalizeTimeline(timelineValue),
    full: full ? {
      rawKeys: {
        conversation: Object.keys(conversation).sort(),
        content: content && typeof content === "object" && !Array.isArray(content) ? Object.keys(content).sort() : undefined,
        events: events && typeof events === "object" && !Array.isArray(events) ? Object.keys(events).sort() : undefined,
        inboxes: inboxes && typeof inboxes === "object" && !Array.isArray(inboxes) ? Object.keys(inboxes).sort() : undefined,
        followers: followers && typeof followers === "object" && !Array.isArray(followers) ? Object.keys(followers).sort() : undefined,
      },
      conversation: redactConversationDetail(conversation),
      content: summarizeObject(content),
      events: summarizeObject(events),
      inboxes: summarizeObject(inboxes),
      followers: summarizeObject(followers),
    } : undefined,
  }, args);
}

export function redactConversationDetail(value: Record<string, unknown>) {
  const base = pick(value, [
    "id",
    "conversation_id",
    "subject",
    "status",
    "assignee_id",
    "inbox_ids",
    "channel_ids",
    "tag_ids",
    "topic_ids",
    "custom_fields",
    "updated_at",
    "created_at",
    "bumped_at",
    "num_messages",
    "has_attachments",
    "message_type",
  ]);
  return {
    ...base,
    reminders: summarizeArray(value.reminders),
    trackers: summarizeArray(value.trackers),
    links: summarizeArray(value.links),
    customFieldAttributes: summarizeArray(value.custom_field_attributes),
  };
}

function summarizeObject(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      count: value.length,
      items: value.slice(0, 20).map((item) => typeof item === "object" && item !== null ? redactRecord(item as Record<string, unknown>) : item),
      truncated: value.length > 20,
    };
  }
  const raw = value as Record<string, unknown>;
  const arrayEntries = Object.entries(raw).filter(([, item]) => Array.isArray(item));
  return {
    type: "object",
    keys: Object.keys(raw).sort(),
    arrays: Object.fromEntries(arrayEntries.map(([key, item]) => [key, {
      count: (item as unknown[]).length,
      items: (item as unknown[]).slice(0, 20).map((entry) => typeof entry === "object" && entry !== null ? redactRecord(entry as Record<string, unknown>) : entry),
      truncated: (item as unknown[]).length > 20,
    }])),
  };
}

function redactRecord(raw: Record<string, unknown>) {
  return pick(raw, [
    "id",
    "type",
    "status",
    "name",
    "display_name",
    "email",
    "handle",
    "role",
    "source",
    "subject",
    "date",
    "created_at",
    "updated_at",
    "inbox_id",
    "channel_id",
    "teammate_id",
    "assignee_id",
    "tag_id",
    "custom_field_id",
    "linked_conversation_id",
    "original_conversation_id",
    "value",
    "url",
  ]);
}

function pick(raw: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => raw[key] !== undefined).map((key) => [key, raw[key]]));
}

function summarizeArray(value: unknown) {
  const items = Array.isArray(value) ? value : [];
  return {
    count: items.length,
    items: items.slice(0, 20).map((item) => typeof item === "object" && item !== null ? redactRecord(item as Record<string, unknown>) : item),
    truncated: items.length > 20,
  };
}
