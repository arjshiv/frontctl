import { readCachedConversations } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { syncStore, type StoreConversationInput } from "../lib/store.js";
import { normalizeConversation, normalizeTimeline } from "../lib/frontCache.js";

export async function syncCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const limit = readNumberFlag(args, "--limit") ?? 100;
  const includeArchived = args.includes("--all") || args.includes("--include-archived");
  const source = args.includes("--live") ? "live-private" : "cache";
  const inputs: StoreConversationInput[] = [];

  if (source === "live-private") {
    const client = await createFrontPrivateClient(paths);
    const routes = buildFrontRoutes(client.context);
    const payloads = includeArchived
      ? await Promise.all([
          client.getJson<Record<string, unknown>>(routes.inbox),
          client.getJson<Record<string, unknown>>(routes.done),
        ])
      : [await client.getJson<Record<string, unknown>>(routes.inbox)];
    const conversations = payloads
      .flatMap((data) => (Array.isArray(data.conversations) ? data.conversations : []))
      .map(normalizeConversation)
      .filter((conversation): conversation is NonNullable<typeof conversation> => Boolean(conversation))
      .slice(0, limit);

    for (const conversation of conversations) {
      const timeline = await client.getJson<Record<string, unknown>>(routes.timeline(conversation.id));
      inputs.push({
        source,
        conversation,
        timeline: normalizeTimeline(Array.isArray(timeline.timeline) ? timeline.timeline : timeline),
      });
    }
  } else {
    const cachedReads = await readCachedConversations(paths.cacheDataPath, { includeArchived, limit });
    for (const read of cachedReads) {
      if (!read.conversation) {
        continue;
      }
      inputs.push({
        source,
        conversation: read.conversation,
        timeline: read.timeline,
      });
    }
  }

  return {
    source,
    ...(await syncStore(inputs)),
  };
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
