import { CliError } from "../lib/cli.js";
import { buildMemoryProfile, defaultMemoryPath, readMemoryProfile, writeMemoryProfile } from "../lib/memory.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { defaultStorePath } from "../lib/store.js";
import { syncCommand } from "./sync.js";

export async function memoryCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [subcommand = "report", ...rest] = args;
  const limit = readNumberFlag(rest, "--limit") ?? 500;
  const dbPath = readStringFlag(rest, "--store") ?? defaultStorePath();
  const memoryPath = readStringFlag(rest, "--memory") ?? defaultMemoryPath();

  if (subcommand === "path") {
    return {
      memoryPath,
      dbPath,
    };
  }

  if (subcommand === "init") {
    const sync = rest.includes("--live")
      ? await syncCommand(syncArgs(rest, limit), paths)
      : undefined;
    const profile = await buildMemoryProfile({ dbPath, memoryPath, limit });
    return {
      source: "local-memory",
      publicApiUsed: false,
      sync,
      ...(await writeMemoryProfile(profile, memoryPath)),
      note: "Initial memory profile written locally. Review it before letting agents rely on the inferred preferences.",
    };
  }

  if (subcommand === "report") {
    const existing = await readMemoryProfile(memoryPath);
    if (existing && !rest.includes("--fresh")) {
      return {
        source: "local-memory",
        publicApiUsed: false,
        memoryPath,
        fresh: false,
        profile: existing,
        note: "Loaded existing local memory profile. Pass --fresh to rebuild from the local store.",
      };
    }
    return {
      source: "local-memory",
      publicApiUsed: false,
      memoryPath,
      fresh: true,
      profile: await buildMemoryProfile({ dbPath, memoryPath, limit }),
    };
  }

  throw new CliError("Usage: frontctl memory init|report|path [--live] [--all] [--limit 500] [--fresh] [--json]", 64);
}

function syncArgs(args: string[], limit: number) {
  const next = ["--live", "--limit", String(limit)];
  if (args.includes("--all") || args.includes("--include-archived")) {
    next.push("--all");
  }
  return next;
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
