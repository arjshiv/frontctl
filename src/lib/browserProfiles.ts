import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserKind = "chrome" | "edge" | "safari";

export interface BrowserDefinition {
  kind: BrowserKind;
  name: string;
  bundleId: string;
  keychainService?: string;
  rootPath?: string;
  supportsCookieImport: boolean;
}

export interface BrowserProfile {
  browser: BrowserKind;
  browserName: string;
  profile: string;
  profilePath: string;
  cookiesPath?: string;
  cookiesExists: boolean;
  keychainService?: string;
  supportsCookieImport: boolean;
}

const BROWSERS: Record<BrowserKind, BrowserDefinition> = {
  chrome: {
    kind: "chrome",
    name: "Google Chrome",
    bundleId: "com.google.Chrome",
    keychainService: "Chrome Safe Storage",
    rootPath: join(homedir(), "Library", "Application Support", "Google", "Chrome"),
    supportsCookieImport: true,
  },
  edge: {
    kind: "edge",
    name: "Microsoft Edge",
    bundleId: "com.microsoft.edgemac",
    keychainService: "Microsoft Edge Safe Storage",
    rootPath: join(homedir(), "Library", "Application Support", "Microsoft Edge"),
    supportsCookieImport: true,
  },
  safari: {
    kind: "safari",
    name: "Safari",
    bundleId: "com.apple.Safari",
    supportsCookieImport: false,
  },
};

export function browserDefinitions(env: NodeJS.ProcessEnv = process.env) {
  return {
    ...BROWSERS,
    chrome: {
      ...BROWSERS.chrome,
      rootPath: env.FRONTCTL_CHROME_USER_DATA_DIR ?? env.FRONTCTL_BROWSER_ROOT_CHROME ?? BROWSERS.chrome.rootPath,
    },
    edge: {
      ...BROWSERS.edge,
      rootPath: env.FRONTCTL_EDGE_USER_DATA_DIR ?? env.FRONTCTL_BROWSER_ROOT_EDGE ?? BROWSERS.edge.rootPath,
    },
  };
}

export function normalizeBrowserKind(value: string | undefined): BrowserKind | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === "chrome" || normalized === "google-chrome" || normalized === "com.google.chrome") {
    return "chrome";
  }
  if (normalized === "edge" || normalized === "microsoft-edge" || normalized === "com.microsoft.edgemac") {
    return "edge";
  }
  if (normalized === "safari" || normalized === "com.apple.safari") {
    return "safari";
  }
  return undefined;
}

export function detectDefaultBrowser(env: NodeJS.ProcessEnv = process.env): {
  browser?: BrowserKind;
  bundleId?: string;
  source: "env" | "launchservices" | "unknown";
} {
  const envBrowser = normalizeBrowserKind(env.FRONTCTL_DEFAULT_BROWSER);
  if (envBrowser) {
    return {
      browser: envBrowser,
      bundleId: browserDefinitions(env)[envBrowser].bundleId,
      source: "env",
    };
  }
  if (env.FRONTCTL_DEFAULT_BROWSER_BUNDLE_ID) {
    const browser = normalizeBrowserKind(env.FRONTCTL_DEFAULT_BROWSER_BUNDLE_ID);
    return {
      browser,
      bundleId: env.FRONTCTL_DEFAULT_BROWSER_BUNDLE_ID,
      source: "env",
    };
  }

  try {
    const plistPath = join(homedir(), "Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist");
    const stdout = execFileSync("plutil", ["-convert", "json", "-o", "-", plistPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const parsed = JSON.parse(stdout) as { LSHandlers?: Array<Record<string, unknown>> };
    const handler = parsed.LSHandlers?.find((item) => item.LSHandlerURLScheme === "https");
    const bundleId = typeof handler?.LSHandlerRoleAll === "string" ? handler.LSHandlerRoleAll : undefined;
    return {
      browser: normalizeBrowserKind(bundleId),
      bundleId,
      source: "launchservices",
    };
  } catch {
    return { source: "unknown" };
  }
}

export function listBrowserProfiles(env: NodeJS.ProcessEnv = process.env): BrowserProfile[] {
  const definitions = browserDefinitions(env);
  return (["chrome", "edge"] as const).flatMap((kind) => listChromiumProfiles(definitions[kind]));
}

export function inspectBrowserProfiles(kind: BrowserKind, env: NodeJS.ProcessEnv = process.env): BrowserProfile[] {
  const definition = browserDefinitions(env)[kind];
  if (!definition.supportsCookieImport || !definition.rootPath) {
    return [{
      browser: kind,
      browserName: definition.name,
      profile: "open-only",
      profilePath: "",
      cookiesExists: false,
      supportsCookieImport: false,
    }];
  }
  return listChromiumProfiles(definition);
}

export function resolveBrowserProfile(
  kind: BrowserKind,
  profileName = "Default",
  env: NodeJS.ProcessEnv = process.env,
): BrowserProfile | undefined {
  const candidates = inspectBrowserProfiles(kind, env);
  return candidates.find((profile) => profile.profile === profileName)
    ?? candidates.find((profile) => profile.profile === "Default")
    ?? candidates.find((profile) => profile.cookiesExists);
}

function listChromiumProfiles(definition: BrowserDefinition): BrowserProfile[] {
  const rootPath = definition.rootPath;
  if (!rootPath || !existsSync(rootPath)) {
    return [];
  }

  const names = readdirSync(rootPath)
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .sort((a, b) => profileSortKey(a) - profileSortKey(b));

  return names.map((profile) => {
    const profilePath = join(rootPath, profile);
    const networkCookiesPath = join(profilePath, "Network", "Cookies");
    const legacyCookiesPath = join(profilePath, "Cookies");
    const cookiesPath = existsSync(networkCookiesPath) ? networkCookiesPath : legacyCookiesPath;
    return {
      browser: definition.kind,
      browserName: definition.name,
      profile,
      profilePath,
      cookiesPath,
      cookiesExists: fileExists(cookiesPath),
      keychainService: definition.keychainService,
      supportsCookieImport: true,
    };
  });
}

function profileSortKey(name: string) {
  if (name === "Default") return 0;
  const match = /^Profile (\d+)$/.exec(name);
  return match ? Number(match[1]) : 10_000;
}

function fileExists(path: string) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

