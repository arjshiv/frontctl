import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAgentcookieFrontCookies } from "./agentcookie.js";
import { clearFrontSession, forceUnlockCommandForSession, readFrontSession, unlockFrontSession, unlockFrontSessionFromPlainCookies, type FrontSession } from "./auth.js";
import { createBrowserBridgeClient, discoverFrontRouteContextFromBrowserBridge } from "./browserBridge.js";
import { createCdpBridgeClient, discoverFrontRouteContextFromCdpBridge } from "./cdpBridge.js";
import { CliError } from "./cli.js";
import {
  buildFrontBootRoute,
  buildFrontRoutes,
  discoverFrontRouteBaseContext,
  discoverLocalFrontRouteContext,
  writePersistedFrontRouteContext,
  type FrontRouteBaseContext,
  type FrontRouteContext,
} from "./frontRoutes.js";
import type { FrontPaths } from "./paths.js";
import { frontRouteContextSchema } from "./schemas.js";

const execFileAsync = promisify(execFile);

export interface FrontPrivateClient {
  context: FrontRouteContext;
  transport: "cdp-bridge" | "browser-bridge" | "session-cookie";
  getJson<T = unknown>(url: string): Promise<T>;
  requestJson<T = unknown>(url: string, options: { method: string; body?: unknown }): Promise<T>;
  requestBytes?(url: string): Promise<{ bytes: Uint8Array; contentType?: string; filename?: string }>;
}

interface FrontPrivateClientOptions {
  requireByteDownloads?: boolean;
  recoverAuthentication?: (
    context: FrontRouteContext,
    rejectedSession: FrontSession,
    requireByteDownloads: boolean,
  ) => Promise<FrontPrivateClient | undefined>;
}

export async function createFrontPrivateClient(
  paths: FrontPaths,
  options: FrontPrivateClientOptions = {},
): Promise<FrontPrivateClient> {
  let session = await readFrontSession();
  const context = await resolveFrontRouteContext(paths, session);

  if (!context) {
    throw new CliError(
      "Could not resolve Front's local workspace context. Open the signed-in Front app and let the inbox finish loading, then rerun `frontctl readiness --json`. Browser debugging is not required.",
      69,
    );
  }

  if (!session) {
    const rows = await readAgentcookieFrontCookies().catch(() => []);
    if (rows.length >= 2) {
      await unlockFrontSessionFromPlainCookies(rows, {
        source: "agentcookie:auto",
      });
      session = await readFrontSession();
    }
  }

  if (session) {
    return sessionCookieClient(
      context,
      session,
      (requireByteDownloads) => {
        const bytesRequired = options.requireByteDownloads === true || requireByteDownloads;
        return options.recoverAuthentication?.(context, session, bytesRequired)
          ?? recoverRejectedSession(paths, context, session, bytesRequired);
      },
      () => writePersistedFrontRouteContext(context),
    );
  }

  const cdpClient = await createCdpBridgeClient(context);
  if (cdpClient) {
    return cdpClient;
  }

  const bridgeClient = await createBrowserBridgeClient(context);
  if (bridgeClient) {
    return bridgeClient;
  }

  throw new CliError(
    "No live Front session is available. Run `frontctl readiness --json` and approve its recommended unlock command; do not use cache for current inbox state.",
    69,
  );
}

export async function resolveFrontRouteContext(
  paths: FrontPaths,
  session: FrontSession | undefined = undefined,
): Promise<FrontRouteContext | undefined> {
  const local = await discoverLocalFrontRouteContext(paths);
  if (local) return local;

  const activeSession = session ?? await readFrontSession();
  if (activeSession) {
    const base = await discoverFrontRouteBaseContext(paths.cacheDataPath);
    const fromBoot = base ? await resolveContextFromBoot(base, activeSession) : undefined;
    if (fromBoot) return fromBoot;
  }

  const cdp = await discoverFrontRouteContextFromCdpBridge();
  if (cdp) return cdp;
  return discoverFrontRouteContextFromBrowserBridge();
}

function sessionCookieClient(
  context: FrontRouteContext,
  session: NonNullable<Awaited<ReturnType<typeof readFrontSession>>>,
  recoverAuthentication?: (requireByteDownloads: boolean) => Promise<FrontPrivateClient | undefined>,
  onAuthenticatedRequest?: () => Promise<void>,
): FrontPrivateClient {
  if (!session) {
    throw new CliError(
      "No live Front session is available. Run `frontctl readiness --json` and approve its recommended unlock command; do not use cache for current inbox state.",
      69,
    );
  }

  let cookieHeader = session.cookieHeader;
  let csrfToken = session.csrfToken;
  let fallbackClient: FrontPrivateClient | undefined;
  let recoveryPromise: Promise<FrontPrivateClient | undefined> | undefined;
  let contextRemembered = false;
  const routes = buildFrontRoutes(context);

  const recoverOnce = async (requireByteDownloads: boolean) => {
    if (!recoveryPromise && recoverAuthentication) {
      recoveryPromise = recoverAuthentication(requireByteDownloads).catch(() => undefined);
    }
    fallbackClient = await recoveryPromise;
    return fallbackClient;
  };

  const rememberSetCookie = (setCookie: string | null) => {
    const token = extractFrontCsrfCookie(setCookie);
    if (!token) {
      return;
    }
    csrfToken = token;
    cookieHeader = upsertCookie(cookieHeader, "front.csrf", token);
  };

  const rememberContext = async () => {
    if (contextRemembered || !onAuthenticatedRequest) {
      return;
    }
    contextRemembered = true;
    await onAuthenticatedRequest().catch(() => {
      contextRemembered = false;
    });
  };

  const ensureCsrfToken = async () => {
    if (csrfToken) {
      return;
    }
    const response = await fetchFront(routes.boot, {
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: cookieHeader,
        origin: new URL(routes.boot).origin,
        referer: `${new URL(routes.boot).origin}/`,
        "user-agent": "Mozilla/5.0 frontctl-local-session",
      },
    });
    rememberSetCookie(response.headers.get("set-cookie"));
    await response.arrayBuffer();
  };

  const requestJson = async <T = unknown>(
    url: string,
    options: { method: string; body?: unknown },
  ): Promise<T> => {
    if (fallbackClient) {
      return fallbackClient.requestJson<T>(url, options);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(options.method.toUpperCase())) {
      await ensureCsrfToken();
    }
    const response = await fetchFront(url, {
      method: options.method,
      headers: {
        accept: "application/json",
        cookie: cookieHeader,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        ...(csrfToken === undefined
          ? {}
          : {
            "X-Front-Xsrf": csrfToken,
          }),
        origin: new URL(url).origin,
        referer: `${new URL(url).origin}/`,
        "X-Front-Session-Id": "frontctl",
        "x-front-precogs": "direct",
        "user-agent": "Mozilla/5.0 frontctl-local-session",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    rememberSetCookie(response.headers.get("set-cookie"));
    const text = await response.text();
    if (!response.ok) {
      if (isAuthenticationRequired(response.status, text)) {
        await clearFrontSession();
        if (recoverAuthentication) {
          const recovered = await recoverOnce(false);
          if (recovered) {
            return recovered.requestJson<T>(url, options);
          }
        }
        throw authenticationRequiredError(response.status, text, session);
      }
      throw new CliError(`Front private request failed with HTTP ${response.status}${summarizeErrorBody(text)}`, 69);
    }
    await rememberContext();
    return text ? (JSON.parse(text) as T) : ({} as T);
  };

  return {
    context,
    get transport() {
      return fallbackClient?.transport ?? "session-cookie";
    },
    async getJson<T = unknown>(url: string): Promise<T> {
      return requestJson<T>(url, { method: "GET" });
    },
    requestJson,
    async requestBytes(url: string) {
      if (fallbackClient?.requestBytes) {
        return fallbackClient.requestBytes(url);
      }
      const response = await fetchFront(url, {
        method: "GET",
        headers: {
          accept: "*/*",
          cookie: cookieHeader,
          origin: new URL(url).origin,
          referer: `${new URL(url).origin}/`,
          "user-agent": "Mozilla/5.0 frontctl-local-session",
        },
      });
      rememberSetCookie(response.headers.get("set-cookie"));
      if (!response.ok) {
        const text = await response.text();
        if (isAuthenticationRequired(response.status, text) && recoverAuthentication) {
          await clearFrontSession();
          const recovered = await recoverOnce(true);
          if (recovered?.requestBytes) {
            return recovered.requestBytes(url);
          }
        }
        if (isAuthenticationRequired(response.status, text)) {
          throw authenticationRequiredError(response.status, text, session);
        }
        throw new CliError(`Front private download failed with HTTP ${response.status}`, 69);
      }
      await rememberContext();
      const disposition = response.headers.get("content-disposition") ?? undefined;
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? undefined,
        filename: dispositionFilename(disposition),
      };
    },
  };
}

async function resolveContextFromBoot(
  base: FrontRouteBaseContext,
  session: FrontSession,
): Promise<FrontRouteContext | undefined> {
  const url = buildFrontBootRoute(base);
  const response = await fetchFront(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      cookie: session.cookieHeader,
      origin: base.origin,
      referer: `${base.origin}/`,
      "user-agent": "Mozilla/5.0 frontctl-local-session",
    },
  }).catch(() => undefined);
  if (!response?.ok) {
    return undefined;
  }
  const boot = await response.json().catch(() => undefined);
  const teamId = activeTeamIdFromBoot(boot);
  if (!teamId) {
    return undefined;
  }
  const context = frontRouteContextSchema.parse({ ...base, teamId });
  await writePersistedFrontRouteContext(context).catch(() => undefined);
  return context;
}

function activeTeamIdFromBoot(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const boot = value as Record<string, unknown>;
  const userId = objectId(boot.user);
  if (userId) return userId;
  const teamId = objectId(boot.team);
  if (teamId) return teamId;
  if (Array.isArray(boot.teams) && boot.teams.length === 1) {
    return objectId(boot.teams[0]);
  }
  return undefined;
}

function objectId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

async function recoverRejectedSession(
  paths: FrontPaths,
  context: FrontRouteContext,
  rejectedSession: FrontSession,
  requireByteDownloads: boolean,
): Promise<FrontPrivateClient | undefined> {
  const bridgeCandidates = [
    await createCdpBridgeClient(context).catch(() => undefined),
    await createBrowserBridgeClient(context).catch(() => undefined),
  ];
  for (const candidate of bridgeCandidates) {
    if (candidate && (!requireByteDownloads || candidate.requestBytes) && await clientIsAuthenticated(candidate)) {
      return candidate;
    }
  }

  if (!rejectedSession.source?.startsWith("agentcookie")) {
    const rows = await readAgentcookieFrontCookies().catch(() => []);
    if (rows.length >= 2) {
      await unlockFrontSessionFromPlainCookies(rows, {
        force: true,
        source: "agentcookie:auto-recovery",
      });
      const session = await readFrontSession();
      if (session) {
        const candidate = sessionCookieClient(context, session);
        if (await clientIsAuthenticated(candidate)) {
          return candidate;
        }
      }
    }
  }

  if (await frontAppIsRunning(paths)) {
    await unlockFrontSession(paths.cookiesPath, {
      force: true,
      source: "front-app",
      note: "Recovered the rejected Front session from the open Front app. Cookie values are not printed.",
    });
    const session = await readFrontSession();
    if (session) {
      const candidate = sessionCookieClient(context, session);
      if (await clientIsAuthenticated(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function clientIsAuthenticated(client: FrontPrivateClient) {
  try {
    await client.getJson(buildFrontRoutes(client.context).boot);
    return true;
  } catch {
    return false;
  }
}

async function frontAppIsRunning(paths: FrontPaths, env: NodeJS.ProcessEnv = process.env) {
  if (env.FRONTCTL_FRONT_APP_RUNNING === "1" || env.FRONTCTL_FRONT_APP_RUNNING === "true") {
    return true;
  }
  if (env.FRONTCTL_FRONT_APP_RUNNING === "0" || env.FRONTCTL_FRONT_APP_RUNNING === "false") {
    return false;
  }
  const executable = `${paths.appPath}/Contents/MacOS/Front`;
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["ax", "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2_000,
    });
    return stdout.split("\n").some((line) => line === executable || line.startsWith(`${executable} `));
  } catch {
    return false;
  }
}

function isAuthenticationRequired(status: number, text: string) {
  return status === 401 && /authentication_required|not signed in|sign in/i.test(text);
}

function authenticationRequiredError(status: number, text: string, session: FrontSession) {
  const frontAppFallback = session.source === "front-app" || session.source === "front"
    ? ""
    : ` If Front.app is open and signed in, refresh once with \`frontctl auth unlock --source front-app --ttl-hours 720 --force --json\` instead.`;
  return new CliError(
    [
      `Front private request failed with HTTP ${status}${summarizeErrorBody(text)}.`,
      "The cached frontctl session was rejected by Front and has been cleared.",
      "Automatic fallback through available live sources did not succeed.",
      `Refresh once with \`${forceUnlockCommandForSession(session)}\`, then retry the approved operation.${frontAppFallback}`,
    ].join(" "),
    69,
  );
}

async function fetchFront(url: string, init: RequestInit) {
  const timeoutMs = frontRequestTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw new CliError(`Front private request timed out after ${timeoutMs}ms: ${(init.method ?? "GET").toUpperCase()} ${requestPath(url)}`, 69);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function frontRequestTimeoutMs() {
  const value = Number(process.env.FRONTCTL_HTTP_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : 20_000;
}

function requestPath(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "<unknown>";
  }
}

function summarizeErrorBody(text: string) {
  if (!text.trim()) {
    return "";
  }
  const summary = redactPrivateText(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return summary ? `: ${summary}` : "";
}

function redactPrivateText(text: string) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(front\.(?:id|id\.sig|csrf))=[^;\s"]+/gi, "$1=[redacted]")
    .replace(/\b(cookie|authorization|x-front-xsrf)\b\s*[:=]\s*("[^"]+"|[^\s,}]+)/gi, "$1=[redacted]");
}

export async function getBoot(paths: FrontPaths) {
  const client = await createFrontPrivateClient(paths);
  return client.getJson<Record<string, unknown>>(buildFrontRoutes(client.context).boot);
}

function extractFrontCsrfCookie(setCookie: string | null) {
  if (!setCookie) {
    return undefined;
  }
  const match = setCookie.match(/(?:^|,\s*)front\.csrf=([^;,]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function upsertCookie(cookieHeader: string, name: string, value: string) {
  const encoded = `${name}=${value}`;
  const parts = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith(`${name}=`));
  return [...parts, encoded].join("; ");
}

function dispositionFilename(disposition: string | undefined) {
  if (!disposition) {
    return undefined;
  }
  const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8) {
    return decodeURIComponent(utf8[1].replace(/^"|"$/g, ""));
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : undefined;
}
