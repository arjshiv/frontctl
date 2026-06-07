import { CliError } from "../lib/cli.js";
import { normalizeConversation, normalizeTimeline, readCachedConversations } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { formatFromArgs } from "../lib/render.js";
import { triageConversationReads, type TriageResult } from "../lib/triage.js";

export async function triageCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [scope] = args.filter((arg) => !arg.startsWith("--"));
  if (scope && scope !== "inbox") {
    throw new CliError("Usage: frontctl triage [inbox] [--limit 20] [--all] [--offline-cache] [--format markdown|plain]", 64);
  }
  const limit = readNumberFlag(args, "--limit") ?? 20;
  const includeArchived = args.includes("--all") || args.includes("--include-archived");
  const result = args.includes("--offline-cache")
    ? triageConversationReads(
        await readCachedConversations(paths.cacheDataPath, { limit, includeArchived }),
        { source: "cache", stale: true },
      )
    : await liveInboxTriage(paths, { limit, includeArchived });
  return maybeRenderTriage(result, args);
}

async function liveInboxTriage(paths: FrontPaths, options: { limit: number; includeArchived: boolean }) {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const payloads = options.includeArchived
    ? await Promise.all([
        client.getJson<Record<string, unknown>>(routes.inbox),
        client.getJson<Record<string, unknown>>(routes.done),
      ])
    : [await client.getJson<Record<string, unknown>>(routes.inbox)];
  const conversations = payloads
    .flatMap((data) => (Array.isArray(data.conversations) ? data.conversations : []))
    .map(normalizeConversation)
    .filter((conversation): conversation is NonNullable<typeof conversation> => Boolean(conversation))
    .slice(0, options.limit);
  const reads = await Promise.all(conversations.map(async (conversation) => {
    const timeline = await client.getJson<Record<string, unknown>>(routes.timeline(conversation.id));
    return {
      id: conversation.id,
      conversation,
      timeline: normalizeTimeline(timeline.timeline),
    };
  }));
  return triageConversationReads(reads, { source: "live-private", stale: false });
}

function maybeRenderTriage(result: TriageResult, args: string[]) {
  const format = formatFromArgs(args);
  if (format === "json") {
    return result;
  }
  const lines = format === "markdown"
    ? ["# Front Inbox Triage", "", meta(result), ""]
    : ["Front Inbox Triage", meta(result), ""];
  const buckets = [
    ["Needs Reply", result.buckets.needsReply],
    ["Reminders", result.buckets.reminders],
    ["Waiting", result.buckets.waiting],
    ["With Attachments", result.buckets.withAttachments],
    ["Manual Review", result.buckets.manualReview],
    ["Archived", result.buckets.archived],
  ] as const;
  for (const [label, items] of buckets) {
    if (format === "markdown") {
      lines.push(`## ${label} (${items.length})`, "");
    } else {
      lines.push(`${label} (${items.length})`);
    }
    if (!items.length) {
      lines.push(format === "markdown" ? "_None._" : "None.", "");
      continue;
    }
    for (const item of items) {
      if (format === "markdown") {
        lines.push(`- \`${item.id}\` ${item.subject ?? "(no subject)"}`);
        lines.push(`  - Next: ${item.suggestedNextStep ?? item.reason}`);
        lines.push(`  - Read: \`${item.commands.read}\``);
      } else {
        lines.push(`- ${item.id} ${item.subject ?? "(no subject)"}`);
        lines.push(`  Next: ${item.suggestedNextStep ?? item.reason}`);
        lines.push(`  Read: ${item.commands.read}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function meta(result: TriageResult) {
  return [result.source, result.stale ? "stale" : undefined, `${result.count} conversations`]
    .filter(Boolean)
    .join(" | ");
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
