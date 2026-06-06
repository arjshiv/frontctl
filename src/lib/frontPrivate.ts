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

  const requestJson = async <T = unknown>(
    url: string,
    options: { method: string; body?: unknown },
  ): Promise<T> => {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        accept: "application/json",
        cookie: session.cookieHeader,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": "Mozilla/5.0 frontctl-local-session",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
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
