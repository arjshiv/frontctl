import { listCachedInbox, normalizeConversation } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { maybeRenderConversationList } from "../lib/render.js";

export async function listInbox(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const limit = readNumberFlag(args, "--limit") ?? 20;
  const includeArchived = args.includes("--all") || args.includes("--include-archived");
  if (args.includes("--live")) {
    const client = await createFrontPrivateClient(paths);
    const routes = buildFrontRoutes(client.context);
    const payloads = includeArchived
      ? await Promise.all([
          client.getJson<Record<string, unknown>>(routes.inbox),
          client.getJson<Record<string, unknown>>(routes.done),
        ])
      : [await client.getJson<Record<string, unknown>>(routes.inbox)];
    const raw = payloads.flatMap((data) => (Array.isArray(data.conversations) ? data.conversations : []));
    const conversations = raw
      .map(normalizeConversation)
      .filter((conversation): conversation is NonNullable<typeof conversation> => Boolean(conversation))
      .slice(0, limit);

    return maybeRenderConversationList({
      source: "live-private",
      stale: false,
      publicApiUsed: false,
      routes: includeArchived ? ["inbox", "done"] : ["inbox"],
      totalReturned: conversations.length,
      count: conversations.length,
      conversations,
    }, args);
  }

  return maybeRenderConversationList(await listCachedInbox(paths.cacheDataPath, { limit, includeArchived }), args);
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
