import {
  checkFrontSession,
  clearFrontSession,
  sessionSecurityStatus,
  unlockFrontSession,
} from "../lib/auth.js";
import { CliError } from "../lib/cli.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

export async function authCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [subcommand] = args;

  if (!subcommand || subcommand === "check" || subcommand === "status") {
    return checkFrontSession();
  }

  if (subcommand === "security") {
    return sessionSecurityStatus();
  }

  if (subcommand === "unlock") {
    return unlockFrontSession(paths.cookiesPath, {
      ttlHours: readNumberFlag(args, "--ttl-hours"),
      force: args.includes("--force"),
    });
  }

  if (subcommand === "clear" || subcommand === "logout") {
    return clearFrontSession();
  }

  throw new CliError(`Unknown auth subcommand: ${subcommand}`, 64);
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
