import { readAgentcookieFrontCookies } from "./agentcookie.js";
import { readFrontSession, unlockFrontSessionFromPlainCookies } from "./auth.js";
import { createBrowserBridgeClient, discoverFrontRouteContextFromBrowserBridge } from "./browserBridge.js";
import { createCdpBridgeClient, discoverFrontRouteContextFromCdpBridge } from "./cdpBridge.js";
import { CliError } from "./cli.js";
import { buildFrontRoutes, discoverFrontRouteContext, type FrontRouteContext } from "./frontRoutes.js";
import type { FrontPaths } from "./paths.js";

export interface FrontPrivateClient {
  context: FrontRouteContext;
  transport: "cdp-bridge" | "browser-bridge" | "session-cookie";
  getJson<T = unknown>(url: string): Promise<T>;
  requestJson<T = unknown>(url: string, options: { method: string; body?: unknown }): Promise<T>;
  requestBytes?(url: string): Promise<{ bytes: Uint8Array; contentType?: string; filename?: string }>;
}

export async function createFrontPrivateClient(paths: FrontPaths): Promise<FrontPrivateClient> {
  let [session, context] = await Promise.all([
    readFrontSession(),
    discoverFrontRouteContext(paths.cacheDataPath),
  ]);

  context ??= await discoverFrontRouteContextFromCdpBridge();
  context ??= await discoverFrontRouteContextFromBrowserBridge();

  if (!context) {
    throw new CliError("Could not discover Front private route context. Open Front inbox in a signed-in browser or the Front app once, then rerun.", 69);
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
    return sessionCookieClient(context, session);
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

function sessionCookieClient(
  context: FrontRouteContext,
  session: NonNullable<Awaited<ReturnType<typeof readFrontSession>>>,
): FrontPrivateClient {
  if (!session) {
    throw new CliError(
      "No live Front session is available. Run `frontctl readiness --json` and approve its recommended unlock command; do not use cache for current inbox state.",
      69,
    );
  }

  let cookieHeader = session.cookieHeader;
  let csrfToken = session.csrfToken;
  const routes = buildFrontRoutes(context);

  const rememberSetCookie = (setCookie: string | null) => {
    const token = extractFrontCsrfCookie(setCookie);
    if (!token) {
      return;
    }
    csrfToken = token;
    cookieHeader = upsertCookie(cookieHeader, "front.csrf", token);
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
      throw new CliError(`Front private request failed with HTTP ${response.status}${summarizeErrorBody(text)}`, 69);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  };

  return {
    context,
    transport: "session-cookie",
    async getJson<T = unknown>(url: string): Promise<T> {
      return requestJson<T>(url, { method: "GET" });
    },
    requestJson,
    async requestBytes(url: string) {
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
        throw new CliError(`Front private download failed with HTTP ${response.status}`, 69);
      }
      const disposition = response.headers.get("content-disposition") ?? undefined;
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? undefined,
        filename: dispositionFilename(disposition),
      };
    },
  };
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
