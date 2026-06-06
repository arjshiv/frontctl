import { readFile, writeFile } from "node:fs/promises";

export interface SanitizedDiscoveryEntry {
  method: string;
  url: string;
  path: string;
  routeKind: string;
  status?: number;
  requestBodyShape?: unknown;
  responseBodyShape?: unknown;
  redacted: string[];
}

interface CdpRequestState {
  requestId: string;
  method: string;
  url: string;
  requestBodyShape?: unknown;
}

export async function sanitizeDiscoveryFile(inputPath: string, outputPath?: string) {
  const raw = await readFile(inputPath, "utf8");
  const result = sanitizeDiscoveryInput(JSON.parse(raw) as unknown);
  if (outputPath) {
    await writeFile(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  }
  return {
    source: inputPath,
    outputPath,
    ...result,
  };
}

export function sanitizeDiscoveryInput(input: unknown) {
  const entries = extractEntries(input)
    .map(sanitizeEntry)
    .filter((entry): entry is SanitizedDiscoveryEntry => Boolean(entry));

  return {
    publicApiUsed: false,
    redacted: true,
    count: entries.length,
    routeKinds: [...new Set(entries.map((entry) => entry.routeKind))].sort(),
    entries,
  };
}

export async function captureChromeDiscovery(options: {
  remoteDebuggingPort: number;
  durationMs: number;
  outputPath?: string;
}) {
  const targetsResponse = await fetch(`http://127.0.0.1:${options.remoteDebuggingPort}/json/list`);
  if (!targetsResponse.ok) {
    throw new Error(`Chrome DevTools target list failed with HTTP ${targetsResponse.status}`);
  }
  const targets = (await targetsResponse.json()) as Array<Record<string, unknown>>;
  const target = targets.find((candidate) => {
    const url = typeof candidate.url === "string" ? candidate.url : "";
    return url.includes("app.frontapp.com");
  }) ?? targets.find((candidate) => typeof candidate.webSocketDebuggerUrl === "string");
  const webSocketDebuggerUrl = target?.webSocketDebuggerUrl;
  if (typeof webSocketDebuggerUrl !== "string") {
    throw new Error("No Chrome DevTools target with a websocket URL was found.");
  }

  const WebSocketCtor = (globalThis as typeof globalThis & {
    WebSocket?: new (url: string) => {
      addEventListener: (event: string, listener: (message?: { data?: unknown }) => void) => void;
      send: (message: string) => void;
      close: () => void;
    };
  }).WebSocket;
  if (!WebSocketCtor) {
    throw new Error("This Node runtime does not expose WebSocket. Use discovery sanitize with a saved HAR instead.");
  }

  const entries = await new Promise<SanitizedDiscoveryEntry[]>((resolve, reject) => {
    const socket = new WebSocketCtor(webSocketDebuggerUrl);
    const requests = new Map<string, CdpRequestState>();
    let nextId = 1;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      socket.close();
      resolve([...requests.values()].map(cdpRequestToEntry).filter(Boolean) as SanitizedDiscoveryEntry[]);
    };

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: nextId++, method: "Network.enable" }));
      setTimeout(finish, options.durationMs);
    });
    socket.addEventListener("error", () => {
      if (!settled) {
        settled = true;
        reject(new Error("Chrome DevTools websocket connection failed."));
      }
    });
    socket.addEventListener("message", (message) => {
      const data = typeof message?.data === "string" ? JSON.parse(message.data) as Record<string, unknown> : undefined;
      if (!data || typeof data.method !== "string") {
        return;
      }
      if (data.method === "Network.requestWillBeSent") {
        const params = data.params as Record<string, unknown> | undefined;
        const request = params?.request as Record<string, unknown> | undefined;
        const requestId = typeof params?.requestId === "string" ? params.requestId : undefined;
        const url = typeof request?.url === "string" ? request.url : undefined;
        const method = typeof request?.method === "string" ? request.method : "GET";
        if (requestId && url?.includes("app.frontapp.com")) {
          requests.set(requestId, {
            requestId,
            method,
            url,
            requestBodyShape: shapeOf(parseMaybeJson(request?.postData)),
          });
        }
      }
      if (data.method === "Network.responseReceived") {
        const params = data.params as Record<string, unknown> | undefined;
        const requestId = typeof params?.requestId === "string" ? params.requestId : undefined;
        const response = params?.response as Record<string, unknown> | undefined;
        const status = typeof response?.status === "number" ? response.status : undefined;
        const request = requestId ? requests.get(requestId) : undefined;
        if (request && status) {
          requests.set(request.requestId, { ...request, requestBodyShape: request.requestBodyShape });
        }
      }
    });
  });

  const result = {
    publicApiUsed: false,
    redacted: true,
    remoteDebuggingPort: options.remoteDebuggingPort,
    durationMs: options.durationMs,
    count: entries.length,
    routeKinds: [...new Set(entries.map((entry) => entry.routeKind))].sort(),
    entries,
  };
  if (options.outputPath) {
    await writeFile(options.outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
  }
  return { outputPath: options.outputPath, ...result };
}

function extractEntries(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) {
    return input.filter(isObject);
  }
  if (!isObject(input)) {
    return [];
  }
  const log = input.log;
  if (isObject(log) && Array.isArray(log.entries)) {
    return log.entries.filter(isObject);
  }
  if (Array.isArray(input.entries)) {
    return input.entries.filter(isObject);
  }
  if (Array.isArray(input.requests)) {
    return input.requests.filter(isObject);
  }
  return [input];
}

function sanitizeEntry(entry: Record<string, unknown>): SanitizedDiscoveryEntry | undefined {
  const request = isObject(entry.request) ? entry.request : entry;
  const response = isObject(entry.response) ? entry.response : undefined;
  const method = typeof request.method === "string" ? request.method.toUpperCase() : "GET";
  const rawUrl = typeof request.url === "string" ? request.url : undefined;
  if (!rawUrl || !rawUrl.includes("app.frontapp.com")) {
    return undefined;
  }

  const url = sanitizedUrl(rawUrl);
  const parsed = new URL(url);
  const postData = isObject(request.postData) ? request.postData.text : request.postData;
  const responseContent = isObject(response?.content) ? response.content.text : undefined;
  return {
    method,
    url,
    path: parsed.pathname,
    routeKind: routeKind(parsed.pathname, method),
    status: typeof response?.status === "number" ? response.status : undefined,
    requestBodyShape: shapeOf(parseMaybeJson(postData)),
    responseBodyShape: shapeOf(parseMaybeJson(responseContent)),
    redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
  };
}

function cdpRequestToEntry(request: CdpRequestState): SanitizedDiscoveryEntry | undefined {
  const url = sanitizedUrl(request.url);
  const parsed = new URL(url);
  return {
    method: request.method.toUpperCase(),
    url,
    path: parsed.pathname,
    routeKind: routeKind(parsed.pathname, request.method),
    requestBodyShape: request.requestBodyShape,
    redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
  };
}

function sanitizedUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  url.search = "";
  url.hash = "";
  return url.toString();
}

function routeKind(path: string, method = "GET") {
  const normalizedMethod = method.toUpperCase();
  if (path.includes("/conversation_batch/archive")) return "archive";
  if (/\/conversations\/[^/]+\/status\/snoozed/.test(path)) return "snooze";
  if (/\/conversations\/[^/]+\/tag\//.test(path)) return "tag.add";
  if (/\/conversations\/[^/]+\/untag\//.test(path)) return "tag.remove";
  if (/\/conversations\/[^/]+\/comments/.test(path)) return "comment.add";
  if (normalizedMethod === "DELETE" && /\/messages\/[^/]+/.test(path)) return "draft.discard";
  if (/\/conversations\/[^/]+\/messages/.test(path)) return "message-or-draft";
  if (/\/messages\/[^/]+/.test(path)) return "message";
  if (/\/conversations\/[^/]+\/timeline/.test(path)) return "timeline";
  if (/\/conversations\/(?:inbox|done)/.test(path)) return "conversation-list";
  if (/\/search_/.test(path)) return "search";
  return "other";
}

function shapeOf(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.length ? [shapeOf(value[0])] : [];
  }
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, shapeOfObjectField(key, child)]));
  }
  return typeof value;
}

function shapeOfObjectField(key: string, value: unknown) {
  if (/cookie|token|auth|secret/i.test(key)) {
    return "<redacted:secret>";
  }
  if (/body|text|subject|email|name/i.test(key)) {
    return `<redacted:${typeof value}>`;
  }
  return shapeOf(value);
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return "string";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
