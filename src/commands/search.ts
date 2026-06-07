import { CliError } from "../lib/cli.js";
import { normalizeConversation, searchCachedConversations } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { maybeRenderConversationList, skipValueFlag } from "../lib/render.js";

export async function searchConversations(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const limit = readNumberFlag(args, "--limit") ?? 20;
  const query = readQueryArgs(args).join(" ").trim();
  if (!query) {
    throw new CliError("Missing search query", 64);
  }

  if (args.includes("--offline-cache")) {
    return maybeRenderConversationList(await searchCachedConversations(paths.cacheDataPath, query, limit), args);
  }

  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const data = await client.getJson<Record<string, unknown>>(routes.searchRaw(query));
  const raw = Array.isArray(data.conversations)
    ? data.conversations
    : Array.isArray(data.conversation_search_results)
      ? data.conversation_search_results
      : [];
  const conversations = raw
    .map(normalizeConversation)
    .filter((conversation): conversation is NonNullable<typeof conversation> => Boolean(conversation))
    .slice(0, limit);

  return maybeRenderConversationList({
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    query,
    count: conversations.length,
    conversations,
  }, args);
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function readQueryArgs(args: string[]) {
  const query: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit" || skipValueFlag(args, "--format", index)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      continue;
    }
    query.push(arg);
  }
  return query;
}
