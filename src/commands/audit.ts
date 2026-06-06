import { listAuditEntries } from "../lib/audit.js";
import { CliError } from "../lib/cli.js";

export async function auditCommand(args: string[]) {
  const [operation] = args;
  if (!operation || operation === "list") {
    const mode = readStringFlag(args, "--mode");
    if (mode && mode !== "dry-run" && mode !== "execute") {
      throw new CliError("Usage: frontctl audit list [--limit 50] [--action ACTION] [--conversation ID] [--mode dry-run|execute]", 64);
    }
    return listAuditEntries({
      limit: readNumberFlag(args, "--limit") ?? 50,
      action: readStringFlag(args, "--action"),
      conversationId: readStringFlag(args, "--conversation"),
      mode: parseMode(mode),
    });
  }
  throw new CliError("Usage: frontctl audit list [--limit 50] [--action ACTION] [--conversation ID] [--mode dry-run|execute]", 64);
}

function parseMode(mode: string | undefined): "dry-run" | "execute" | undefined {
  return mode === "dry-run" || mode === "execute" ? mode : undefined;
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
