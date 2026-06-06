import { readPlistJson } from "../lib/plist.js";
import { type PathStatus, pathStatus } from "../lib/fsInfo.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";

interface FrontInfoPlist {
  CFBundleShortVersionString?: string;
  CFBundleIdentifier?: string;
  CFBundleURLTypes?: Array<{ CFBundleURLSchemes?: string[] }>;
}

export async function doctor(paths: FrontPaths = defaultFrontPaths()) {
  const statuses = {
    app: await pathStatus(paths.appPath),
    infoPlist: await pathStatus(paths.infoPlistPath),
    asar: await pathStatus(paths.asarPath),
    support: await pathStatus(paths.supportPath),
    cookies: await pathStatus(paths.cookiesPath),
    cacheData: await pathStatus(paths.cacheDataPath),
    localStorage: await pathStatus(paths.localStorageLevelDbPath),
    indexedDb: await pathStatus(paths.indexedDbLevelDbPath),
    preferences: await pathStatus(paths.preferencesPath),
  };

  let plist: FrontInfoPlist | undefined;
  if (statuses.infoPlist.exists && statuses.infoPlist.readable) {
    plist = (await readPlistJson(paths.infoPlistPath)) as FrontInfoPlist;
  }

  const urlSchemes =
    plist?.CFBundleURLTypes?.flatMap((entry) => entry.CFBundleURLSchemes ?? []).sort() ?? [];
  const checks = [
    productCheck("frontApp", statuses.app, "Install Front for macOS in /Applications, then open it once."),
    productCheck("frontBundle", statuses.asar, "Reinstall Front for macOS; the app bundle is incomplete."),
    productCheck("localProfile", statuses.support, "Open Front and sign in so the local profile is created."),
    productCheck("cookies", statuses.cookies, "Open Front, sign in, and wait for the inbox to load."),
    productCheck("cache", statuses.cacheData, "Open the Front inbox once so cached read-only workflows have local data."),
    productCheck("indexedDb", statuses.indexedDb, "Open Front once; draft inspection needs Front's IndexedDB profile."),
  ];
  const ok = checks.slice(0, 4).every((check) => check.ok);
  const issues = checks.filter((check) => !check.ok);

  return {
    ok,
    front: {
      bundleIdentifier: plist?.CFBundleIdentifier,
      version: plist?.CFBundleShortVersionString,
      urlSchemes,
    },
    paths,
    statuses,
    checks,
    issues,
    safety: {
      publicApiUsed: false,
      sendsEmail: false,
      mutationCommandsImplemented: true,
      note: "Non-send mutation commands are implemented behind explicit --yes, audit logging, and known-route verification. Sending remains blocked.",
    },
    onboarding: {
      readyForAgentUse: ok,
      nextCommand: ok ? "frontctl setup --json" : "frontctl doctor --json",
      note: ok
        ? "Front is installed and the local profile is visible. Run setup, then auth unlock for live reads and approved actions."
        : issues[0]?.remedy ?? "Install and sign in to Front desktop before asking an agent to manage Front mail.",
    },
  };
}

function productCheck(name: string, status: PathStatus, remedy: string) {
  const ok = status.exists && status.readable;
  return {
    name,
    ok,
    path: status.path,
    state: status.exists ? status.readable ? "ready" : "not-readable" : "missing",
    remedy: ok ? undefined : remedy,
  };
}
