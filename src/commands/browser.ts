import { agentcookieStatus } from "../lib/agentcookie.js";
import {
  detectDefaultBrowser,
  inspectBrowserProfiles,
  listBrowserProfiles,
  normalizeBrowserKind,
  type BrowserKind,
} from "../lib/browserProfiles.js";
import { CliError } from "../lib/cli.js";

export async function browserCommand(args: string[]) {
  const [subcommand] = args;
  if (!subcommand || subcommand === "list") {
    const defaultBrowser = detectDefaultBrowser();
    const agentcookie = await agentcookieStatus();
    return {
      defaultBrowser,
      profiles: listBrowserProfiles(),
      safari: {
        supported: "open-only",
        cookieImport: false,
        note: "Safari browser sessions are supported for opening Front URLs. Cookie import should use agentcookie or a future signed helper.",
      },
      agentcookie,
    };
  }

  if (subcommand === "inspect") {
    const browser = readBrowserFlag(args);
    if (!browser) {
      throw new CliError("Pass --browser chrome|edge|safari.", 64);
    }
    return {
      browser,
      defaultBrowser: detectDefaultBrowser(),
      profiles: inspectBrowserProfiles(browser),
    };
  }

  throw new CliError(`Unknown browser subcommand: ${subcommand}`, 64);
}

function readBrowserFlag(args: string[]): BrowserKind | undefined {
  const index = args.indexOf("--browser");
  return normalizeBrowserKind(index >= 0 ? args[index + 1] : undefined);
}

