import { CliError } from "../lib/cli.js";
import { readStoreConversation, searchStore, storeStats, type StoreStats } from "../lib/store.js";
import { firstPositionalArg, formatFromArgs, maybeRenderConversationList, maybeRenderConversationRead, skipValueFlag } from "../lib/render.js";

export async function cacheCommand(args: string[]) {
  const [subcommand, ...rest] = args;
  const maxAgeHours = readNumberFlag(rest, "--max-age-hours");

  if (subcommand === "search") {
    const limit = readNumberFlag(rest, "--limit") ?? 20;
    const query = readQueryArgs(rest).join(" ").trim();
    if (!query) {
      throw new CliError("Missing cache search query", 64);
    }
    return maybeRenderConversationList(await searchStore(query, limit, undefined, maxAgeHours), rest);
  }

  if (subcommand === "read") {
    const id = firstPositionalArg(rest);
    if (!id) {
      throw new CliError("Missing conversation id", 64);
    }
    return maybeRenderConversationRead(await readStoreConversation(id, undefined, maxAgeHours), rest);
  }

  if (!subcommand || subcommand === "stats") {
    return maybeRenderStats(await storeStats(undefined, maxAgeHours), rest);
  }

  throw new CliError(`Unknown cache subcommand: ${subcommand}`, 64);
}

function maybeRenderStats(stats: StoreStats, args: string[]) {
  const format = formatFromArgs(args);
  if (format === "json") {
    return stats;
  }
  const lines = format === "markdown"
    ? ["# Front Local Cache", ""]
    : ["Front Local Cache", ""];
  lines.push(`Database: ${stats.dbPath}`);
  lines.push(`Conversations: ${stats.conversations}`);
  lines.push(`Timeline items: ${stats.timelineItems}`);
  lines.push(`Attachments: ${stats.attachments}`);
  lines.push(`FTS rows: ${stats.ftsRows}`);
  lines.push(`Last synced: ${stats.lastSyncedAt ?? "never"}`);
  lines.push(`Fresh: ${stats.freshness.fresh ? "yes" : "no"}`);
  if (stats.freshness.warning) {
    lines.push(`Warning: ${stats.freshness.warning}`);
  }
  if (stats.sources.length) {
    lines.push("", format === "markdown" ? "## Sources" : "Sources");
    for (const source of stats.sources) {
      lines.push(`- ${source.source}: ${source.count} conversations, last synced ${source.lastSyncedAt ?? "never"}`);
    }
  }
  return lines.join("\n");
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
    if (arg === "--limit" || arg === "--max-age-hours" || skipValueFlag(args, "--format", index)) {
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
