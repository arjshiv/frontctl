import { readConversation } from "./conversation.js";
import { CliError } from "../lib/cli.js";
import { summarizeConversation } from "../lib/summary.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import type { CachedConversation, CachedTimelineItem } from "../lib/frontCache.js";
import { argsWithoutValueFlag, firstPositionalArg, maybeRenderSummary } from "../lib/render.js";

export async function summarizeCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const id = firstPositionalArg(args);
  if (!id) {
    throw new CliError("Missing conversation id", 64);
  }
  const readResult = await readConversation(argsWithoutValueFlag(args, "--format"), paths) as {
    id: string;
    conversation?: CachedConversation;
    timeline: CachedTimelineItem[];
    source?: string;
    stale?: boolean;
  };
  return maybeRenderSummary({
    source: readResult.source,
    stale: readResult.stale,
    summary: summarizeConversation({
      id,
      conversation: readResult.conversation,
      timeline: readResult.timeline,
    }),
  }, args);
}
