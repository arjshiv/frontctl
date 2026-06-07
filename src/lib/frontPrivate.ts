import { readFrontSession } from "./auth.js";
import { CliError } from "./cli.js";
import { buildFrontRoutes, discoverFrontRouteContext, type FrontRouteContext } from "./frontRoutes.js";
import type { FrontPaths } from "./paths.js";

export interface FrontPrivateClient {
  context: FrontRouteContext;
  getJson<T = unknown>(url: string): Promise<T>;
  requestJson<T = unknown>(url: string, options: { method: string; body?: unknown }): Promise<T>;
}

export async function createFrontPrivateClient(paths: FrontPaths): Promise<FrontPrivateClient> {
  const [session, context] = await Promise.all([
    readFrontSession(),
    discoverFrontRouteContext(paths.cacheDataPath),
  ]);

  if (!session) {
    throw new CliError("No unlocked live Front session. Run `frontctl auth unlock` first.", 69);
  }

  if (!context) {
    throw new CliError("Could not discover Front private route context. Open Front inbox once, then rerun.", 69);
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
    const response = await fetch(routes.boot, {
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
    const response = await fetch(url, {
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
      throw new CliError(`Front private request failed with HTTP ${response.status}`, 69);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  };

  return {
    context,
    async getJson<T = unknown>(url: string): Promise<T> {
      return requestJson<T>(url, { method: "GET" });
    },
    requestJson,
  };
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
