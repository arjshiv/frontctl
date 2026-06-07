import { CliError } from "../lib/cli.js";
import { selectFrontDevToolsTarget, sanitizeDevToolsTarget } from "../lib/discovery.js";
import { buildFrontRoutes, discoverFrontRouteContext } from "../lib/frontRoutes.js";
import type { FrontPaths } from "../lib/paths.js";
import { browserProbeRuntimeSchema } from "../lib/schemas.js";

export async function browserProbeCommand(args: string[], paths: FrontPaths) {
  const conversationId = args.find((arg) => !arg.startsWith("--") && args[args.indexOf(arg) - 1] !== "--remote-debugging-port" && args[args.indexOf(arg) - 1] !== "--target-url-contains");
  const remoteDebuggingPort = readNumberFlag(args, "--remote-debugging-port") ?? 9222;
  const targetUrlContains = readStringFlag(args, "--target-url-contains") ?? (conversationId ? `conversations/${conversationId}` : undefined);

  if (!conversationId) {
    throw new CliError("Usage: frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT [--target-url-contains conversations/ID]", 64);
  }

  const context = await discoverFrontRouteContext(paths.cacheDataPath);
  if (!context) {
    throw new CliError("Could not discover Front private route context. Open Front inbox once, then rerun.", 69);
  }

  const routes = buildFrontRoutes(context);
  const route = routes.conversation(conversationId);
  const target = await findProbeTarget(remoteDebuggingPort, targetUrlContains);
  if (!target || typeof target.webSocketDebuggerUrl !== "string") {
    throw new CliError("No usable Front browser tab with a DevTools websocket URL was found.", 69);
  }

  const probe = browserProbeRuntimeSchema.parse(
    await runBrowserConversationProbe(target.webSocketDebuggerUrl, new URL(route).pathname),
  );
  const status = typeof probe.status === "string" ? probe.status : undefined;
  const authenticated = probe.ok === true && status !== "authentication_required";
  return {
    source: "browser-cdp-runtime",
    publicApiUsed: false,
    remoteDebuggingPort,
    conversationId,
    target: sanitizeDevToolsTarget(target),
    targetUrlContains,
    authenticated,
    probe: {
      ok: probe.ok,
      httpStatus: probe.httpStatus,
      frontStatus: status,
      contentType: probe.contentType,
      hasSubject: probe.hasSubject === true,
      hasMessages: probe.hasMessages === true,
      bodyShape: sanitizeProbeShape(probe.bodyShape),
    },
    nextAction: authenticated
      ? `frontctl discovery capture --remote-debugging-port ${remoteDebuggingPort} --target-url-contains ${targetUrlContains ?? "app.frontapp.com"} --duration-ms 15000 --json`
      : "The browser tab is reachable but not authenticated for Front. Sign into Front in that browser profile, then rerun this probe. The CLI live session may still work without another Keychain prompt.",
  };
}

async function findProbeTarget(remoteDebuggingPort: number, targetUrlContains: string | undefined) {
  const response = await fetch(`http://127.0.0.1:${remoteDebuggingPort}/json/list`);
  if (!response.ok) {
    throw new CliError(`Chrome DevTools target list failed with HTTP ${response.status}`, 69);
  }
  const targets = await response.json() as Array<Record<string, unknown>>;
  return selectFrontDevToolsTarget(targets, targetUrlContains);
}

async function runBrowserConversationProbe(webSocketDebuggerUrl: string, path: string) {
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

  const send = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  try {
    const expression = browserProbeExpression(path);
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const runtimeResult = result.result as Record<string, unknown> | undefined;
    return (runtimeResult?.value && typeof runtimeResult.value === "object"
      ? runtimeResult.value
      : { ok: false, httpStatus: undefined, status: "probe_failed" }) as Record<string, unknown>;
  } finally {
    socket.close();
  }
}

function browserProbeExpression(path: string) {
  return `
(async () => {
  const secretKey = (key) => /cookie|token|auth|secret|password|credential/i.test(key);
  const shape = (value, depth = 0) => {
    if (depth > 4) return "<redacted:depth>";
    if (Array.isArray(value)) return value.length ? [shape(value[0], depth + 1)] : [];
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, child]) => [
        secretKey(key) ? "<redacted:secret-key>" : key,
        secretKey(key) ? "<redacted:secret>" : shape(child, depth + 1)
      ]));
    }
    return typeof value;
  };
  const response = await fetch(${JSON.stringify(path)}, {
    method: "GET",
    credentials: "include",
    headers: { accept: "application/json", "x-front-precogs": "direct" }
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
  return {
    ok: response.ok,
    httpStatus: response.status,
    contentType: response.headers.get("content-type"),
    status: parsed && parsed.status,
    hasSubject: typeof (parsed && parsed.subject) === "string",
    hasMessages: Array.isArray(parsed && parsed.messages),
    bodyShape: shape(parsed)
  };
})()
`;
}

function sanitizeProbeShape(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "<redacted:depth>";
  }
  if (Array.isArray(value)) {
    return value.length ? [sanitizeProbeShape(value[0], depth + 1)] : [];
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).slice(0, 30).map(([key, child]) => {
      if (isSecretShapeKey(key)) {
        return ["<redacted:secret-key>", "<redacted:secret>"];
      }
      return [key, sanitizeProbeShape(child, depth + 1)];
    }),
  );
}

function isSecretShapeKey(key: string) {
  return /cookie|token|auth|secret|password|credential/i.test(key);
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
