import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { detectDefaultBrowser, listBrowserProfiles } from "./browserProfiles.js";
import { CliError } from "./cli.js";
import { selectFrontDevToolsTarget, sanitizeDevToolsTarget } from "./discovery.js";
import type { FrontPrivateClient } from "./frontPrivate.js";
import { type FrontRouteContext } from "./frontRoutes.js";
import { frontRouteContextSchema } from "./schemas.js";

const ROUTE_PATTERN =
  /(https:\/\/(?:app|[a-z0-9-]+)\.frontapp\.com)\/(cell-[^/\s\x00"'<>\\]+)\/api\/1\/companies\/([a-f0-9]+)\/team\/(\d+)\/conversations\/(?:inbox|done)/i;

export interface CdpBridgeProof {
  version: 1;
  source: "cdp-bridge";
  origin: string;
  remoteDebuggingPort: number;
  target?: ReturnType<typeof sanitizeDevToolsTarget>;
  verifiedAt: string;
  expiresAt: string;
}

export async function cdpBridgeStatus(env: NodeJS.ProcessEnv = process.env) {
  const enabled = cdpBridgeEnabled(env);
  const proof = await readCdpBridgeProof(env);
  const selectedPort = enabled ? await selectCdpPort(env).catch(() => undefined) : undefined;
  return {
    enabled,
    source: "cdp-bridge",
    preferredBrowser: detectDefaultBrowser(env).browser,
    availableWithoutKeychain: Boolean(enabled && selectedPort),
    proofValid: Boolean(proof),
    proofPath: defaultCdpBridgeProofPath(env),
    verifiedAt: proof?.verifiedAt,
    expiresAt: proof?.expiresAt,
    remoteDebuggingPort: selectedPort,
    touchesKeychain: false,
    promptClass: "none" as const,
    note: enabled
      ? "Live CDP bridge uses a signed-in Front browser tab through Chrome DevTools Protocol. It does not read cookies, Keychain, or stale cache."
      : "Live CDP bridge is disabled by environment.",
  };
}

export function defaultCdpBridgeProofPath(env: NodeJS.ProcessEnv = process.env) {
  return env.FRONTCTL_CDP_BRIDGE_PROOF_PATH
    ?? join(homedir(), ".frontctl", "browser-bridge.json");
}

export async function readCdpBridgeProof(env: NodeJS.ProcessEnv = process.env): Promise<CdpBridgeProof | undefined> {
  let raw: string;
  try {
    raw = await readFile(defaultCdpBridgeProofPath(env), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as CdpBridgeProof;
    if (parsed.version !== 1 || parsed.source !== "cdp-bridge" || !parsed.origin || !parsed.expiresAt) {
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

export async function writeCdpBridgeProof(
  context: FrontRouteContext,
  options: { remoteDebuggingPort?: number; target?: Record<string, unknown>; ttlHours?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const createdAt = new Date();
  const ttlMs = (options.ttlHours ?? 12) * 60 * 60 * 1000;
  const proof: CdpBridgeProof = {
    version: 1,
    source: "cdp-bridge",
    origin: context.origin,
    remoteDebuggingPort: options.remoteDebuggingPort ?? readConfiguredCdpPort(env),
    target: sanitizeDevToolsTarget(options.target),
    verifiedAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  };
  const path = defaultCdpBridgeProofPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
  return { ...proof, path };
}

export async function createCdpBridgeClient(
  context: FrontRouteContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FrontPrivateClient | undefined> {
  if (!cdpBridgeEnabled(env)) {
    return undefined;
  }

  const mock = readMockResponses(env);
  if (mock) {
    return bridgeClient(context, async (url, options) => mockRequest(mock, url, options));
  }

  const target = await findFrontTarget(env).catch(() => undefined);
  if (!target || typeof target.webSocketDebuggerUrl !== "string") {
    return undefined;
  }
  return bridgeClient(context, async (url, options) => {
    const connection = await connectDevTools(target.webSocketDebuggerUrl as string);
    try {
      return await executeCdpFetch(connection, url, options);
    } finally {
      connection.close();
    }
  });
}

export async function discoverFrontRouteContextFromCdpBridge(
  env: NodeJS.ProcessEnv = process.env,
): Promise<FrontRouteContext | undefined> {
  const mock = env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT;
  if (mock) {
    return frontRouteContextSchema.parse(JSON.parse(mock));
  }
  if (!cdpBridgeEnabled(env)) {
    return undefined;
  }
  const target = await findFrontTarget(env).catch(() => undefined);
  if (!target || typeof target.webSocketDebuggerUrl !== "string") {
    return undefined;
  }
  if (typeof target.url === "string") {
    const fromTargetUrl = routeContextFromUrl(target.url);
    if (fromTargetUrl) {
      return fromTargetUrl;
    }
  }
  const connection = await connectDevTools(target.webSocketDebuggerUrl);
  try {
    const urls = await evaluateJson<string[]>(connection, `
      (() => {
        const urls = [location.href, ...performance.getEntriesByType("resource").map((entry) => entry.name)];
        return JSON.stringify(urls.filter((url) => typeof url === "string" && url.includes("/api/1/companies/")));
      })();
    `);
    for (const url of urls) {
      const context = routeContextFromUrl(url);
      if (context) {
        return context;
      }
    }
  } finally {
    connection.close();
  }
  return undefined;
}

export async function testCdpBridge(context: FrontRouteContext, env: NodeJS.ProcessEnv = process.env) {
  if (readMockResponses(env)) {
    const client = await createCdpBridgeClient(context, env);
    if (!client) {
      throw new CliError("Could not create the mocked Front CDP bridge client.", 69);
    }
    return {
      client,
      target: {
        type: "page",
        title: "Front",
        url: context.origin,
      },
      remoteDebuggingPort: readConfiguredCdpPort(env),
    };
  }
  const target = await findFrontTarget(env);
  if (!target || typeof target.webSocketDebuggerUrl !== "string") {
    throw new CliError("No signed-in Front browser tab with Chrome DevTools Protocol was reachable. Launch Edge or Chrome with remote debugging and sign into Front.", 69);
  }
  const client = await createCdpBridgeClient(context, env);
  if (!client) {
    throw new CliError("Could not create the Front CDP bridge client.", 69);
  }
  return {
    client,
    target,
    remoteDebuggingPort: await selectCdpPort(env),
  };
}

function bridgeClient(
  context: FrontRouteContext,
  request: (url: string, options: { method: string; body?: unknown }) => Promise<unknown>,
): FrontPrivateClient {
  return {
    context,
    transport: "cdp-bridge",
    async getJson<T = unknown>(url: string): Promise<T> {
      return request(url, { method: "GET" }) as Promise<T>;
    },
    async requestJson<T = unknown>(url: string, options: { method: string; body?: unknown }): Promise<T> {
      return request(url, options) as Promise<T>;
    },
  };
}

async function findFrontTarget(env: NodeJS.ProcessEnv) {
  const port = await selectCdpPort(env);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!response.ok) {
    throw new CliError(`Chrome DevTools target list failed with HTTP ${response.status}`, 69);
  }
  const targets = await response.json() as Array<Record<string, unknown>>;
  return selectFrontDevToolsTarget(targets, env.FRONTCTL_CDP_TARGET_URL_CONTAINS ?? "app.frontapp.com");
}

async function selectCdpPort(env: NodeJS.ProcessEnv) {
  const configured = readConfiguredCdpPort(env);
  if (await cdpPortReachable(configured)) {
    return configured;
  }
  const candidates = await Promise.all(listBrowserProfiles(env).map(async (profile) => {
    try {
      const raw = await readFile(join(profile.profilePath, "DevToolsActivePort"), "utf8");
      const port = Number(raw.trim().split(/\n/)[0]);
      return Number.isFinite(port) && port > 0 && await cdpPortReachable(port) ? port : undefined;
    } catch {
      return undefined;
    }
  }));
  const dynamic = candidates.find((port): port is number => typeof port === "number");
  if (dynamic) {
    return dynamic;
  }
  throw new CliError(`No reachable Chrome DevTools Protocol endpoint was found on port ${configured}.`, 69);
}

async function cdpPortReachable(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function readConfiguredCdpPort(env: NodeJS.ProcessEnv) {
  const parsed = Number(env.FRONTCTL_CDP_PORT ?? env.FRONTCTL_REMOTE_DEBUGGING_PORT ?? "9222");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 9222;
}

async function executeCdpFetch(
  connection: Awaited<ReturnType<typeof connectDevTools>>,
  url: string,
  options: { method: string; body?: unknown },
) {
  const bodyJson = options.body === undefined ? "undefined" : JSON.stringify(JSON.stringify(options.body));
  const payload = await evaluateJson<{ ok: boolean; status: number; text: string; url?: string }>(connection, `
    (async () => {
      const target = ${JSON.stringify(url)};
      const method = ${JSON.stringify(options.method.toUpperCase())};
      const bodyJson = ${bodyJson};
      const csrf = (document.cookie.match(/(?:^|; )front\\.csrf=([^;]+)/) || [])[1];
      const headers = {
        "accept": "application/json",
        "x-front-precogs": "direct",
        "x-front-session-id": "frontctl-cdp-bridge"
      };
      if (bodyJson !== undefined) headers["content-type"] = "application/json";
      if (csrf) headers["x-front-xsrf"] = decodeURIComponent(csrf);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(target, {
          method,
          credentials: "include",
          headers,
          body: bodyJson,
          signal: controller.signal
        });
        const text = await response.text();
        return JSON.stringify({ ok: response.ok, status: response.status, text, url: response.url });
      } finally {
        clearTimeout(timeout);
      }
    })();
  `);
  if (!payload.ok) {
    throw new CliError(`Front CDP bridge request failed with HTTP ${payload.status}`, 69);
  }
  return payload.text ? JSON.parse(payload.text) : {};
}

async function evaluateJson<T>(connection: Awaited<ReturnType<typeof connectDevTools>>, expression: string): Promise<T> {
  const result = await connection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: 12_000,
  });
  const runtimeResult = result.result as Record<string, unknown> | undefined;
  if (runtimeResult?.subtype === "error") {
    throw new CliError("Front CDP bridge evaluation failed in the browser tab.", 69);
  }
  const value = runtimeResult?.value;
  if (typeof value !== "string") {
    throw new CliError("Front CDP bridge returned an unexpected browser response.", 69);
  }
  return JSON.parse(value) as T;
}

async function connectDevTools(webSocketDebuggerUrl: string) {
  const WebSocketCtor = (globalThis as typeof globalThis & {
    WebSocket?: new (url: string) => {
      addEventListener: (event: string, listener: (message?: { data?: unknown }) => void, options?: { once?: boolean }) => void;
      send: (message: string) => void;
      close: () => void;
    };
  }).WebSocket;
  if (!WebSocketCtor) {
    throw new CliError("This Node runtime does not expose WebSocket.", 69);
  }
  const socket = new WebSocketCtor(webSocketDebuggerUrl);
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  let nextId = 1;
  socket.addEventListener("message", (message) => {
    const data = typeof message?.data === "string" ? JSON.parse(message.data) as Record<string, unknown> : undefined;
    const id = typeof data?.id === "number" ? data.id : undefined;
    if (!data || id === undefined || !pending.has(id)) {
      return;
    }
    const callbacks = pending.get(id)!;
    pending.delete(id);
    if (data.error) {
      callbacks.reject(new Error(JSON.stringify(data.error)));
      return;
    }
    callbacks.resolve(data.result as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("Browser DevTools websocket connection failed.")), { once: true });
  });
  return {
    send(method: string, params: Record<string, unknown>) {
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const id = nextId++;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new CliError(`Chrome DevTools command timed out: ${method}`, 69));
        }, 15_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function cdpBridgeEnabled(env: NodeJS.ProcessEnv) {
  if (env.FRONTCTL_CDP_BRIDGE === "0" || env.FRONTCTL_CDP_BRIDGE === "false") {
    return false;
  }
  if (env.FRONTCTL_CDP_BRIDGE === "1" || env.FRONTCTL_CDP_BRIDGE === "true") {
    return true;
  }
  if (env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES || env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT) {
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
  const raw = env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES;
  if (!raw) {
    return undefined;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function mockRequest(
  mock: Record<string, unknown>,
  url: string,
  _options: { method: string; body?: unknown },
) {
  const match = Object.entries(mock).find(([suffix]) => url.endsWith(suffix));
  if (!match) {
    throw new CliError(`No mocked CDP bridge response for ${url}`, 69);
  }
  return match[1];
}
