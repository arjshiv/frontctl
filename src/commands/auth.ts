import {
  checkFrontSession,
  clearFrontSession,
  DEFAULT_SESSION_TTL_HOURS,
  sessionSecurityStatus,
  unlockFrontSessionFromPlainCookies,
  unlockFrontSession,
} from "../lib/auth.js";
import { readAgentcookieFrontCookies } from "../lib/agentcookie.js";
import { detectDefaultBrowser, normalizeBrowserKind, resolveBrowserProfile, type BrowserKind } from "../lib/browserProfiles.js";
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
    const source = readStringFlag(args, "--source") ?? "auto";
    const ttlHours = readNumberFlag(args, "--ttl-hours");
    const force = args.includes("--force");
    if (!force) {
      const existing = await checkFrontSession();
      if (existing.valid) {
        return {
          ...existing,
          unlocked: true,
          keychainAccessed: false,
          reusedExisting: true,
          note: "Unlocked session cache is already valid. Keychain was not accessed.",
        };
      }
    }
    if (source === "auto") {
      const rows = await readAgentcookieFrontCookies().catch(() => []);
      if (rows.length >= 2) {
        return unlockFrontSessionFromPlainCookies(rows, {
          ttlHours,
          force,
          source: "agentcookie:auto",
        });
      }
      throw new CliError(
        `No non-prompting Front auth source was found. Set up agentcookie, or explicitly run \`frontctl auth unlock --source default-browser --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json\` if you accept a one-time browser Keychain prompt.`,
        69,
      );
    }
    if (source === "front-app" || source === "front") {
      return unlockFrontSession(paths.cookiesPath, {
        ttlHours,
        force,
        source: "front-app",
      });
    }
    if (source === "agentcookie") {
      const rows = await readAgentcookieFrontCookies();
      if (rows.length < 2) {
        throw new CliError("Agentcookie Front cookies were not found. Sign into Front in your browser and sync agentcookie, then rerun auth unlock.", 69);
      }
      return unlockFrontSessionFromPlainCookies(rows, {
        ttlHours,
        force,
        source: "agentcookie",
      });
    }

    const browser = resolveUnlockBrowser(source);
    const profileName = readStringFlag(args, "--profile");
    const profile = resolveBrowserProfile(browser, profileName);
    if (!profile?.cookiesPath || !profile.cookiesExists || !profile.keychainService) {
      throw new CliError(`No readable ${browser} Front browser cookie profile was found. Open Front in ${browser}, sign in, then rerun auth unlock.`, 69);
    }
    return unlockFrontSession(profile.cookiesPath, {
      ttlHours,
      force,
      keychainService: profile.keychainService,
      source: `${browser}:${profile.profile}`,
      note: `Unlocked Front session from ${profile.browserName} profile ${profile.profile}. Cookie values are not printed.`,
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

function readStringFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (index >= 0 && !value) {
    throw new CliError(`Missing value for ${flag}`, 64);
  }
  return value;
}

function resolveUnlockBrowser(source: string): BrowserKind {
  if (source === "default-browser") {
    const detected = detectDefaultBrowser();
    if (detected.browser === "chrome" || detected.browser === "edge") {
      return detected.browser;
    }
    if (detected.browser === "safari") {
      throw new CliError("Safari is currently open-only for frontctl. Use --source agentcookie or sign into Front in Chrome/Edge.", 69);
    }
    throw new CliError("Could not detect a supported default browser. Use --source chrome or --source edge.", 69);
  }
  const browser = normalizeBrowserKind(source);
  if (browser === "chrome" || browser === "edge") {
    return browser;
  }
  if (browser === "safari") {
    throw new CliError("Safari is currently open-only for frontctl. Use --source agentcookie or sign into Front in Chrome/Edge.", 69);
  }
  throw new CliError(`Unsupported auth source: ${source}`, 64);
}
