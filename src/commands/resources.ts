import { CliError } from "../lib/cli.js";
import { listBootResources, searchFrontHints, type ResourceKind } from "../lib/frontResources.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

const RESOURCE_KINDS = new Set<ResourceKind>([
  "inboxes",
  "channels",
  "teammates",
  "teams",
  "tags",
  "signatures",
  "custom-fields",
  "contacts",
  "accounts",
  "links",
]);

export async function resourcesCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [operation, kindOrQuery, ...rest] = positional(args);
  const limit = readNumberFlag(args, "--limit") ?? 100;
  if (operation === "list") {
    if (!RESOURCE_KINDS.has(kindOrQuery as ResourceKind)) {
      throw new CliError(`Usage: frontctl resources list ${[...RESOURCE_KINDS].join("|")} [--limit 100]`, 64);
    }
    const kind = kindOrQuery as ResourceKind;
    if (kind === "contacts" || kind === "accounts" || kind === "links") {
      return {
        source: "live-private",
        stale: false,
        publicApiUsed: false,
        kind,
        count: 0,
        resources: [],
        note: `${kind} are not present in Front boot metadata. Use \`frontctl resources search QUERY --json\` or conversation full reads until the private ${kind} list route is captured.`,
      };
    }
    return listBootResources(kind, paths, limit);
  }
  if (operation === "search") {
    const query = [kindOrQuery, ...rest].filter(Boolean).join(" ").trim();
    if (!query) {
      throw new CliError("Usage: frontctl resources search QUERY [--limit 20]", 64);
    }
    return searchFrontHints(query, paths, limit);
  }
  throw new CliError("Usage: frontctl resources list KIND | resources search QUERY", 64);
}

function positional(args: string[]) {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--limit") {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) {
      values.push(args[index]);
    }
  }
  return values;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : undefined;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
