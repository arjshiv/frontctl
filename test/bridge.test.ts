import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bridgeCommand } from "../src/commands/bridge.js";
import { createCdpBridgeClient } from "../src/lib/cdpBridge.js";
import { readinessCommand } from "../src/commands/readiness.js";
import { installAgentSkills } from "../src/commands/agents.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontCacheFixture } from "./helpers.js";

const BRIDGE_CONTEXT = {
  origin: "https://app.frontapp.com",
  cell: "cell-00017",
  companyId: "32390a17805cd26f7349",
  teamId: "6088721",
};

test("bridge test proves live CDP browser access and writes a short-lived proof without Keychain", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-bridge-test"));
  await writeFakeFrontCacheFixture(paths);
  const proofPath = join(paths.supportPath, "browser-bridge.json");

  await withCdpBridgeEnv(paths.supportPath, proofPath, async () => {
    const result = await bridgeCommand(["test"], paths) as any;

    assert.equal(result.ok, true);
    assert.equal(result.source, "cdp-bridge");
    assert.equal(result.transport, "cdp-bridge");
    assert.equal(result.touchesKeychain, false);
    assert.equal(result.publicApiUsed, false);
    assert.equal(result.sendsEmail, false);
    assert.equal(result.promptClass, "none");
    assert.match(result.nextCommand, /inbox list/);

    const proof = JSON.parse(await readFile(proofPath, "utf8"));
    assert.equal(proof.source, "cdp-bridge");
    assert.equal(proof.origin, "https://app.frontapp.com");
    assert.ok(Date.parse(proof.expiresAt) > Date.now());
  });
});

test("readiness treats verified browser bridge as live mode without auth unlock", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-bridge-readiness"));
  await writeFakeFrontCacheFixture(paths);
  const home = await makeTempDir("frontctl-bridge-readiness-home");
  const proofPath = join(home, ".frontctl", "browser-bridge.json");

  await withCdpBridgeEnv(home, proofPath, async () => {
    await bridgeCommand(["test"], paths);
    await installAgentSkills("all", { write: true });

    const result = await readinessCommand([], paths) as any;

    assert.equal(result.ok, true);
    assert.equal(result.userReadiness.ready, true);
    assert.equal(result.auth.valid, false);
    assert.equal(result.bridge.proofValid, true);
    assert.equal(result.safety.touchesKeychain, false);
    assert.match(result.nextCommand, /triage inbox/);
  });
});

test("bridge permission helpers are explicit and non-Keychain", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-bridge-permissions"));
  const home = await makeTempDir("frontctl-bridge-permissions-home");
  const proofPath = join(home, ".frontctl", "browser-bridge.json");

  await withCdpBridgeEnv(home, proofPath, async () => {
    const permissions = await bridgeCommand(["permissions", "--browser", "edge"], paths) as any;
    assert.equal(permissions.ok, true);
    assert.equal(permissions.touchesKeychain, false);
    assert.match(permissions.permissions.primary, /No macOS privacy permission/);
    assert.match(permissions.permissions.fallbackAutomation, /System Settings/);
    assert.match(permissions.permissions.fallbackJavascriptAppleEvents, /Allow JavaScript from Apple Events/);
    assert.match(permissions.commands.launch, /discovery launch/);

    const dryRun = await bridgeCommand(["enable-javascript-events", "--browser", "edge"], paths) as any;
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.touchesKeychain, false);
    assert.match(dryRun.executeCommand, /--yes/);
  });
});

test("bridge status keeps Apple Events fallback disabled by default", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-bridge-status-no-apple-events"));
  const previousBrowserBridge = process.env.FRONTCTL_BROWSER_BRIDGE;
  delete process.env.FRONTCTL_BROWSER_BRIDGE;
  try {
    const result = await bridgeCommand(["status"], paths) as any;

    assert.equal(result.ok, false);
    assert.equal(result.recommended, "cdp");
    assert.equal(result.appleEvents.enabled, false);
    assert.equal(result.appleEvents.availableWithoutKeychain, false);
    assert.equal(result.appleEvents.promptClass, "none");
    assert.equal(result.touchesKeychain, false);
    assert.match(result.nextCommand, /discovery launch/);
  } finally {
    if (previousBrowserBridge === undefined) delete process.env.FRONTCTL_BROWSER_BRIDGE;
    else process.env.FRONTCTL_BROWSER_BRIDGE = previousBrowserBridge;
  }
});

test("bridge enable-javascript-events validates browser names", async () => {
  await assert.rejects(
    () => bridgeCommand(["enable-javascript-events", "--browser", "safari"]),
    /edge\|chrome/,
  );
});

test("CDP bridge closes the browser websocket after every request", async () => {
  const previousFetch = globalThis.fetch;
  const mutableGlobal = globalThis as unknown as { WebSocket?: unknown };
  const previousWebSocket = mutableGlobal.WebSocket;
  const previousBridge = process.env.FRONTCTL_CDP_BRIDGE;
  const previousPort = process.env.FRONTCTL_CDP_PORT;
  const closedSockets: string[] = [];
  const sentMessages: string[] = [];

  process.env.FRONTCTL_CDP_BRIDGE = "1";
  process.env.FRONTCTL_CDP_PORT = "9222";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/json/version")) {
      return new Response(JSON.stringify({ Browser: "Edg/Test", webSocketDebuggerUrl: "ws://127.0.0.1/browser" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/json/list")) {
      return new Response(JSON.stringify([{
        type: "page",
        title: "Front",
        url: "https://app.frontapp.com/open/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123",
        webSocketDebuggerUrl: "ws://127.0.0.1/page/1",
      }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  mutableGlobal.WebSocket = makeFakeCdpFetchSocket({
    closedSockets,
    sentMessages,
    responseBody: { conversations: [] },
  });

  try {
    const client = await createCdpBridgeClient(BRIDGE_CONTEXT);
    assert.ok(client);

    await client.getJson("https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox");
    await client.getJson("https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/boot/app/8");

    assert.deepEqual(closedSockets, ["ws://127.0.0.1/page/1", "ws://127.0.0.1/page/1"]);
    assert.equal(sentMessages.filter((message) => JSON.parse(message).method === "Runtime.evaluate").length, 2);
  } finally {
    globalThis.fetch = previousFetch;
    mutableGlobal.WebSocket = previousWebSocket;
    restoreEnv("FRONTCTL_CDP_BRIDGE", previousBridge);
    restoreEnv("FRONTCTL_CDP_PORT", previousPort);
  }
});

async function withCdpBridgeEnv<T>(home: string, proofPath: string, fn: () => Promise<T>) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousCookiePath = process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
  const previousBridge = process.env.FRONTCTL_CDP_BRIDGE;
  const previousBridgeProofPath = process.env.FRONTCTL_CDP_BRIDGE_PROOF_PATH;
  const previousBridgeContext = process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT;
  const previousBridgeResponses = process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "missing-session.json");
  process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = join(home, ".agentcookie", "missing-cookies.db");
  process.env.FRONTCTL_CDP_BRIDGE = "1";
  process.env.FRONTCTL_CDP_BRIDGE_PROOF_PATH = proofPath;
  process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT = JSON.stringify(BRIDGE_CONTEXT);
  process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES = JSON.stringify({
    "/boot/app/8": {
      current_user: { id: "usr_123", name: "Bridge User" },
    },
    "/conversations/inbox": {
      conversations: [],
    },
  });
  try {
    return await fn();
  } finally {
    restoreEnv("HOME", previousHome);
    restoreEnv("USERPROFILE", previousUserProfile);
    restoreEnv("FRONTCTL_SESSION_PATH", previousSessionPath);
    restoreEnv("FRONTCTL_AGENTCOOKIE_COOKIES_PATH", previousCookiePath);
    restoreEnv("FRONTCTL_CDP_BRIDGE", previousBridge);
    restoreEnv("FRONTCTL_CDP_BRIDGE_PROOF_PATH", previousBridgeProofPath);
    restoreEnv("FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT", previousBridgeContext);
    restoreEnv("FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES", previousBridgeResponses);
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function makeFakeCdpFetchSocket(options: {
  closedSockets: string[];
  sentMessages: string[];
  responseBody: unknown;
}) {
  return class FakeCdpFetchSocket {
    private listeners = new Map<string, Array<(message?: { data?: unknown }) => void>>();
    private readonly url: string;

    constructor(url: string) {
      this.url = url;
      setTimeout(() => this.emit("open"), 0);
    }

    addEventListener(event: string, listener: (message?: { data?: unknown }) => void) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    send(messageText: string) {
      options.sentMessages.push(messageText);
      const message = JSON.parse(messageText) as { id?: number; method?: string };
      if (message.method === "Runtime.evaluate") {
        setTimeout(() => this.emit("message", {
          data: JSON.stringify({
            id: message.id,
            result: {
              result: {
                type: "string",
                value: JSON.stringify({
                  ok: true,
                  status: 200,
                  text: JSON.stringify(options.responseBody),
                  url: "https://app.frontapp.com/test",
                }),
              },
            },
          }),
        }), 0);
      }
    }

    close() {
      options.closedSockets.push(this.url);
    }

    private emit(event: string, message?: { data?: unknown }) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(message);
      }
    }
  };
}
