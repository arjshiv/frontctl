import { CliError } from "../lib/cli.js";
import { attachmentsFromTimeline, normalizeTimeline, readCachedConversation } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function attachmentsCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [subcommand] = args;
  if (subcommand && subcommand !== "list") {
    throw new CliError("Usage: frontctl attachments list CONVERSATION_ID [--offline-cache]", 64);
  }
  const id = args.find((arg) => !arg.startsWith("--") && arg !== "list");
  if (!id) {
    throw new CliError("Usage: frontctl attachments list CONVERSATION_ID [--offline-cache]", 64);
  }

  if (args.includes("--offline-cache")) {
    const read = await readCachedConversation(paths.cacheDataPath, id);
    const attachments = attachmentsFromTimeline(read.timeline);
    return {
      source: "cache",
      stale: true,
      id,
      count: attachments.length,
      attachments,
    };
  }

  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const timeline = await client.getJson<Record<string, unknown>>(routes.timeline(id));
  const timelineValue = Array.isArray(timeline.timeline) ? timeline.timeline : timeline;
  const attachments = attachmentsFromTimeline(normalizeTimeline(timelineValue));
  return {
    source: "live-private",
    stale: false,
    publicApiUsed: false,
    id,
    count: attachments.length,
    attachments,
  };
}
