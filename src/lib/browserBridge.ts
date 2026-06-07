import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { detectDefaultBrowser, type BrowserKind } from "./browserProfiles.js";
import { CliError } from "./cli.js";
import type { FrontPrivateClient } from "./frontPrivate.js";
import { type FrontRouteContext } from "./frontRoutes.js";
import { frontRouteContextSchema } from "./schemas.js";

const execFileAsync = promisify(execFile);
const FRONT_TAB_MARKER = "frontapp.com";
const NOT_AVAILABLE_PREFIX = "__FRONTCTL_BRIDGE_";
const ROUTE_PATTERN =
  /(https:\/\/(?:app|[a-z0-9-]+)\.frontapp\.com)\/(cell-[^/\s\x00"'<>\\]+)\/api\/1\/companies\/([a-f0-9]+)\/team\/(\d+)\/conversations\/(?:inbox|done)/i;

export interface BrowserBridgeStatus {
  enabled: boolean;
  preferredBrowser?: BrowserKind;
  availableWithoutKeychain: boolean;
  proofValid: boolean;
  proofPath: string;
  verifiedAt?: string;
  expiresAt?: string;
  touchesKeychain: false;
  promptClass: "none" | "macos-automation";
  note: string;
}

export interface BrowserBridgeProof {
  version: 1;
  source: "browser-bridge";
  browser?: BrowserKind;
  origin: string;
  verifiedAt: string;
  expiresAt: string;
}

interface BrowserBridgeResponse {
  ok: boolean;
  status: number;
  text: string;
  url?: string;
}

export async function browserBridgeStatus(env: NodeJS.ProcessEnv = process.env): Promise<BrowserBridgeStatus> {
  const defaultBrowser = detectDefaultBrowser(env);
  const enabled = browserBridgeEnabled(env);
  const proof = await readBrowserBridgeProof(env);
  return {
    enabled,
    preferredBrowser: preferredBridgeBrowsers(env, defaultBrowser.browser)[0],
    availableWithoutKeychain: enabled,
    proofValid: Boolean(proof),
    proofPath: defaultBrowserBridgeProofPath(env),
    verifiedAt: proof?.verifiedAt,
    expiresAt: proof?.expiresAt,
    touchesKeychain: false,
    promptClass: enabled ? "macos-automation" : "none",
    note: enabled
      ? "Live browser bridge uses the signed-in Front tab and does not read browser cookies or Keychain. macOS may ask once for Automation permission."
      : "Live browser bridge is disabled by environment.",
  };
}

export function defaultBrowserBridgeProofPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_BROWSER_BRIDGE_PROOF_PATH ?? join(homedir(), ".frontctl", "browser-bridge.json");
}

export async function readBrowserBridgeProof(env: NodeJS.ProcessEnv = process.env): Promise<BrowserBridgeProof | undefined> {
  let raw: string;
  try {
    raw = await readFile(defaultBrowserBridgeProofPath(env), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as BrowserBridgeProof;
    if (parsed.version !== 1 || parsed.source !== "browser-bridge" || !parsed.origin || !parsed.expiresAt) {
      return undefined;
    }
    if (Date.parse(parsed.expiresAt) <= Date.now()) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeBrowserBridgeProof(
  context: FrontRouteContext,
  options: { browser?: BrowserKind; ttlHours?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const createdAt = new Date();
  const ttlMs = (options.ttlHours ?? 12) * 60 * 60 * 1000;
  const proof: BrowserBridgeProof = {
    version: 1,
    source: "browser-bridge",
    browser: options.browser,
    origin: context.origin,
    verifiedAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
  const path = defaultBrowserBridgeProofPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  return { ...proof, path };
}

export async function createBrowserBridgeClient(
  context: FrontRouteContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FrontPrivateClient | undefined> {
  if (!browserBridgeEnabled(env)) {
    return undefined;
  }

  const mock = readMockResponses(env);
  if (mock) {
    return bridgeClient(context, async (url, options) => mockRequest(mock, url, options));
  }

  for (const browser of preferredBridgeBrowsers(env, detectDefaultBrowser(env).browser)) {
    const usable = await browserHasFrontTab(browser);
    if (!usable) {
      continue;
    }
    return bridgeClient(context, async (url, options) => executeBrowserFetch(browser, url, options));
  }

  return undefined;
}

export async function probeBrowserJavascriptAppleEvents(
  browser: BrowserKind,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!browserBridgeEnabled(env)) {
    return { ok: false, reason: "browser-bridge-disabled" };
  }
  const output = await executeBrowserScript(browser, "JSON.stringify({ ok: true })");
  if (output.startsWith(NOT_AVAILABLE_PREFIX)) {
    return { ok: false, reason: output };
  }
  const parsed = JSON.parse(output) as { ok?: boolean };
  return { ok: parsed.ok === true, reason: parsed.ok === true ? undefined : "unexpected-response" };
}

export async function discoverFrontRouteContextFromBrowserBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FrontRouteContext | undefined> {
  if (!browserBridgeEnabled(env)) {
    return undefined;
  }
  const mock = env.FRONTCTL_BROWSER_BRIDGE_MOCK_CONTEXT;
  if (mock) {
    return frontRouteContextSchema.parse(JSON.parse(mock));
  }

  const js = `
    (() => {
      const urls = [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)];
      return JSON.stringify(urls.filter((url) => typeof url === "string" && url.includes("/api/1/companies/")));
    })();
  `;
  for (const browser of preferredBridgeBrowsers(env, detectDefaultBrowser(env).browser)) {
    const output = await executeBrowserScript(browser, js).catch(() => undefined);
    if (!output || output.startsWith(NOT_AVAILABLE_PREFIX)) {
      continue;
    }
    try {
      const urls = JSON.parse(output) as string[];
      for (const url of urls) {
        const context = routeContextFromUrl(url);
        if (context) {
          return context;
        }
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function bridgeClient(
  context: FrontRouteContext,
  request: (url: string, options: { method: string; body?: unknown }) => Promise<unknown>,
): FrontPrivateClient {
  return {
    context,
    transport: "browser-bridge",
    async getJson<T = unknown>(url: string): Promise<T> {
      return request(url, { method: "GET" }) as Promise<T>;
    },
    async requestJson<T = unknown>(url: string, options: { method: string; body?: unknown }): Promise<T> {
      return request(url, options) as Promise<T>;
    },
  };
}

function browserBridgeEnabled(env: NodeJS.ProcessEnv) {
  if (env.FRONTCTL_BROWSER_BRIDGE === "0" || env.FRONTCTL_BROWSER_BRIDGE === "false") {
    return false;
  }
  if (env.FRONTCTL_BROWSER_BRIDGE === "1" || env.FRONTCTL_BROWSER_BRIDGE === "true") {
    return true;
  }
  if (env.FRONTCTL_BROWSER_BRIDGE_MOCK_RESPONSES) {
    return true;
  }
  if (env.NODE_ENV === "test" || env.npm_lifecycle_event === "test") {
    return false;
  }
  if (process.argv.some((arg) => /(?:^|\/)(?:dist\/)?test\//.test(arg))) {
    return false;
  }
  return true;
}

function preferredBridgeBrowsers(env: NodeJS.ProcessEnv, defaultBrowser?: BrowserKind): BrowserKind[] {
  const requested = normalizeBridgeBrowser(env.FRONTCTL_BROWSER_BRIDGE_BROWSER);
  if (requested) {
    return [requested];
  }
  const candidates: BrowserKind[] = [];
  if (defaultBrowser === "edge" || defaultBrowser === "chrome") {
    candidates.push(defaultBrowser);
  }
  candidates.push("edge", "chrome");
  return [...new Set(candidates)];
}

function normalizeBridgeBrowser(value: string | undefined): BrowserKind | undefined {
  const normalized = value?.toLowerCase();
  if (normalized === "edge" || normalized === "microsoft-edge") return "edge";
  if (normalized === "chrome" || normalized === "google-chrome") return "chrome";
  return undefined;
}

async function browserHasFrontTab(browser: BrowserKind) {
  const output = await executeBrowserScript(browser, `
    const done = ${JSON.stringify(NOT_AVAILABLE_PREFIX + "OK__")};
    done;
  `);
  return !output.startsWith(NOT_AVAILABLE_PREFIX);
}

async function executeBrowserFetch(
  browser: BrowserKind,
  url: string,
  options: { method: string; body?: unknown },
) {
  const bodyJson = options.body === undefined ? "undefined" : JSON.stringify(JSON.stringify(options.body));
  const js = `
    (async () => {
      const target = ${JSON.stringify(url)};
      const method = ${JSON.stringify(options.method.toUpperCase())};
      const bodyJson = ${bodyJson};
      const csrf = (document.cookie.match(/(?:^|; )front\\.csrf=([^;]+)/) || [])[1];
      const headers = {
        "accept": "application/json",
        "x-front-precogs": "direct",
        "x-front-session-id": "frontctl-browser-bridge"
      };
      if (bodyJson !== undefined) headers["content-type"] = "application/json";
      if (csrf) headers["x-front-xsrf"] = decodeURIComponent(csrf);
      const response = await fetch(target, {
        method,
        credentials: "include",
        headers,
        body: bodyJson
      });
      const text = await response.text();
      return JSON.stringify({ ok: response.ok, status: response.status, text, url: response.url });
    })();
  `;
  const raw = await executeBrowserScript(browser, js);
  const payload = parseBridgeResponse(raw);
  if (!payload.ok) {
    throw new CliError(`Front browser bridge request failed with HTTP ${payload.status}`, 69);
  }
  return payload.text ? JSON.parse(payload.text) : {};
}

async function executeBrowserScript(browser: BrowserKind, javascript: string) {
  const appName = browser === "edge" ? "Microsoft Edge" : "Google Chrome";
  if (!(await appIsRunning(appName))) {
    return `${NOT_AVAILABLE_PREFIX}NOT_RUNNING__`;
  }
  const script = `
    on run argv
      set jsSource to item 1 of argv
      tell application "${appName}"
        repeat with w in windows
          repeat with t in tabs of w
            set tabUrl to URL of t
            if tabUrl contains "${FRONT_TAB_MARKER}" then
              return execute t javascript jsSource
            end if
          end repeat
        end repeat
      end tell
      return "${NOT_AVAILABLE_PREFIX}NO_FRONT_TAB__"
    end run
  `;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script, javascript], {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 10_000,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Executing JavaScript through AppleScript is turned off|Allow JavaScript from Apple Events/i.test(message)) {
      throw new CliError(`${appName} blocks JavaScript from Apple Events. In ${appName}, enable View > Developer > Allow JavaScript from Apple Events, then rerun bridge test-apple-events. This does not require Keychain.`, 69);
    }
    if (/not authorized|not permitted|errAEEventNotPermitted|-1743|Automation/i.test(message)) {
      throw new CliError(`macOS Automation permission is required for ${appName}. Allow frontctl to control ${appName} in System Settings > Privacy & Security > Automation, then rerun bridge test.`, 69);
    }
    throw new CliError(`Could not run the Front browser bridge in ${appName}: ${message}`, 69);
  }
  const output = stdout.trim();
  if (output.startsWith(NOT_AVAILABLE_PREFIX)) {
    return output;
  }
  if (!output) {
    throw new CliError("Front browser bridge returned an empty response. Check browser Automation permission and Front sign-in.", 69);
  }
  return output;
}

async function appIsRunning(appName: string) {
  try {
    await execFileAsync("/usr/bin/pgrep", ["-x", appName], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

function parseBridgeResponse(raw: string): BrowserBridgeResponse {
  try {
    const parsed = JSON.parse(raw) as BrowserBridgeResponse;
    if (typeof parsed.ok === "boolean" && typeof parsed.status === "number" && typeof parsed.text === "string") {
      return parsed;
    }
  } catch {
    // Fall through to the structured CLI error below.
  }
  throw new CliError("Front browser bridge returned an unexpected response. Check that the active browser tab is signed into Front.", 69);
}

function routeContextFromUrl(url: string): FrontRouteContext | undefined {
  const match = url.match(ROUTE_PATTERN);
  if (!match) {
    return undefined;
  }
  return frontRouteContextSchema.parse({
    origin: match[1],
    cell: match[2],
    companyId: match[3],
    teamId: match[4],
  });
}

function readMockResponses(env: NodeJS.ProcessEnv) {
  if (!env.FRONTCTL_BROWSER_BRIDGE_MOCK_RESPONSES) {
    return undefined;
  }
  return JSON.parse(env.FRONTCTL_BROWSER_BRIDGE_MOCK_RESPONSES) as Record<string, unknown>;
}

async function mockRequest(
  mock: Record<string, unknown>,
  url: string,
  _options: { method: string; body?: unknown },
) {
  const match = Object.entries(mock).find(([suffix]) => url.endsWith(suffix));
  if (!match) {
    throw new CliError(`No mocked browser bridge response for ${url}`, 69);
  }
  return match[1];
}
