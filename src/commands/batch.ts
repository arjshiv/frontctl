import { readFile } from "node:fs/promises";
import { CliError } from "../lib/cli.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { readConversation } from "./conversation.js";
import { archiveConversation, tagConversation } from "./mutations.js";
import { searchConversations } from "./search.js";

export async function batchCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, suboperation] = positional(args);
  const ids = await readIds(args);
  if (!ids.length) {
    throw new CliError("Batch command needs conversation IDs via --ids-file or --ids", 64);
  }
  if (operation === "read") {
    const results = await Promise.all(ids.map((id) => readConversation([id, "--json"], paths)));
    return {
      source: "live-private",
      publicApiUsed: false,
      operation: "batch.read",
      count: results.length,
      results,
    };
  }
  if (operation === "archive") {
    const rest = mutationFlags(args);
    const results = [];
    for (const id of ids) {
      results.push(await archiveConversation([id, ...rest], paths));
    }
    return {
      source: "live-private",
      publicApiUsed: false,
      operation: "batch.archive",
      count: results.length,
      results,
    };
  }
  if (operation === "tag" && (suboperation === "add" || suboperation === "remove")) {
    const tag = positional(args).find((value, index) => index > 1);
    if (!tag) {
      throw new CliError("Usage: frontctl batch tag add|remove --ids-file ids.txt TAG", 64);
    }
    const rest = mutationFlags(args);
    const results = [];
    for (const id of ids) {
      results.push(await tagConversation([suboperation, id, tag, ...rest], paths));
    }
    return {
      source: "live-private",
      publicApiUsed: false,
      operation: `batch.tag.${suboperation}`,
      count: results.length,
      results,
    };
  }
  throw new CliError("Usage: frontctl batch read|archive --ids-file ids.txt | batch tag add|remove --ids-file ids.txt TAG", 64);
}

export async function bulkCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation] = positional(args);
  if (operation !== "archive") {
    throw new CliError("Usage: frontctl bulk archive --query QUERY [--limit 100]", 64);
  }
  const query = readStringFlag(args, "--query") ?? positional(args).slice(1).join(" ");
  if (!query.trim()) {
    throw new CliError("Bulk archive needs --query QUERY", 64);
  }
  const limit = readStringFlag(args, "--limit") ?? "100";
  const search = await searchConversations(["ids", query, "--limit", limit, "--json"], paths) as { conversationIds?: string[] };
  const ids = search.conversationIds ?? [];
  const rest = mutationFlags(args);
  const results = [];
  for (const id of ids) {
    results.push(await archiveConversation([id, ...rest], paths));
  }
  return {
    source: "live-private",
    publicApiUsed: false,
    operation: "bulk.archive",
    query,
    count: results.length,
    conversationIds: ids,
    results,
  };
}

async function readIds(args: string[]) {
  const idsFile = readStringFlag(args, "--ids-file");
  const inline = readStringFlag(args, "--ids");
  const raw = [
    ...(idsFile ? (await readFile(idsFile, "utf8")).split(/\s+/) : []),
    ...(inline ? inline.split(/[,\s]+/) : []),
  ];
  return raw.map((id) => id.trim()).filter(Boolean);
}

function mutationFlags(args: string[]) {
  const keep = new Set(["--actor", "--agent-name", "--client", "--run-id", "--reason"]);
  const flags: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes" || arg === "--dry-run" || arg === "--live") {
      flags.push(arg);
      continue;
    }
    if (keep.has(arg)) {
      flags.push(arg, args[index + 1]);
      index += 1;
    }
  }
  return flags.filter((value): value is string => Boolean(value));
}

function positional(args: string[]) {
  const values: string[] = [];
  const skip = new Set(["--ids-file", "--ids", "--actor", "--agent-name", "--client", "--run-id", "--reason", "--query", "--limit"]);
  for (let index = 0; index < args.length; index += 1) {
    if (skip.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) {
      values.push(args[index]);
    }
  }
  return values;
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}
