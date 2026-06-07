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
  const [conversation, timeline] = await Promise.all([
    client.getJson<Record<string, unknown>>(routes.conversation(id)),
    client.getJson<Record<string, unknown>>(routes.timeline(id)),
  ]);
  const timelineValue = Array.isArray(timeline.timeline) ? timeline.timeline : timeline;
  return maybeRenderConversationRead({
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    id,
    conversation: normalizeConversation(conversation),
    timeline: normalizeTimeline(timelineValue),
  }, args);
}
