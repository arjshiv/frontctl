import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { discoveryCommand, launchFrontForDiscovery } from "../src/commands/discovery.js";
import { sanitizeDiscoveryInput } from "../src/lib/discovery.js";
import { discoveryFixtureRoot, WRITE_ACTION_SPECS } from "../src/lib/writeVerification.js";
import { makeFakeFrontInstall, makeTempDir } from "./helpers.js";

test("sanitizeDiscoveryInput redacts private Front network captures", () => {
  const result = sanitizeDiscoveryInput({
    log: {
      entries: [
        {
          request: {
            method: "POST",
            url: "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123/timeline?token=SECRET",
            headers: [{ name: "cookie", value: "front.id=SECRET" }],
            postData: {
              text: JSON.stringify({
                body: "SECRET COMMENT BODY",
                email: "person@example.com",
                metadata: { keep_shape: true },
              }),
            },
          },
          response: {
            status: 200,
            content: { text: JSON.stringify({ id: "comment-1", body: "SECRET RESPONSE BODY" }) },
          },
        },
      ],
    },
  });

  assert.equal(result.count, 1);
  assert.deepEqual(result.routeKinds, ["comment.add"]);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|person@example.com|token=/);
  assert.match(JSON.stringify(result.entries[0].requestBodyShape), /body/);
  assert.match(JSON.stringify(result.entries[0].requestBodyShape), /<redacted:string>/);
  assert.match(JSON.stringify(result.entries[0].requestBodyShape), /email/);
  assert.match(JSON.stringify(result.entries[0].requestBodyShape), /metadata/);
});

test("discovery sanitize command can write sanitized fixture output", async () => {
  const dir = await makeTempDir("frontctl-discovery");
  const input = join(dir, "capture.har");
  const output = join(dir, "sanitized.json");
  await writeFile(input, JSON.stringify({
    entries: [
      {
        method: "POST",
        url: "https://app.frontapp.com/cell-00017/api/1/companies/abc/team/1/conversations/inbox?auth=SECRET",
      },
    ],
  }));

  const result = await discoveryCommand(["sanitize", "--input", input, "--output", output]) as any;

  assert.equal(result.outputPath, output);
  assert.equal(result.count, 1);
});

test("discovery verify-writes accepts only empirically proven built-in route coverage", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-empty"), "fixtures");
  delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;

  const result = await discoveryCommand(["verify-writes"]) as any;

  assert.equal(result.scope, "deployable-v1-thread-actions");
  assert.equal(result.allVerified, true);
  assert.equal(result.verifiedCount, 24);
  assert.equal(result.count, 24);
  assert.deepEqual(
    result.actions.filter((action: { source?: string }) => action.source === "known-route").map((action: { action: string }) => action.action),
    ["archive", "unarchive", "delete", "restore", "unsnooze", "tag.add", "tag.remove", "tag.create", "conversation.create-test", "assign", "unassign", "move", "follower.add", "follower.remove", "link.add", "link.remove", "comment.add", "comment.remove", "snooze", "draft.reply", "draft.compose", "draft.update", "draft.forward", "draft.discard"],
  );
  assert.deepEqual(result.blockedActions.map((action: { action: string }) => action.action), []);
});

test("discovery verify-writes can require local sanitized fixtures", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-empty-strict"), "fixtures");
  process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES = "1";

  try {
    const result = await discoveryCommand(["verify-writes"]) as any;

    assert.equal(result.allVerified, false);
    assert.equal(result.verifiedCount, 0);
    assert.ok(result.actions.every((action: { reason?: string }) => action.reason?.includes("No sanitized write fixtures found")));
  } finally {
    delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;
  }
});

test("discovery guide reports action-specific capture steps", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-guide-empty"), "fixtures");
  delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;

  const result = await discoveryCommand(["guide", "--remote-debugging-port", "9333"]) as any;

  assert.equal(result.count, WRITE_ACTION_SPECS.length);
  assert.equal(result.verifiedCount, WRITE_ACTION_SPECS.length);
  assert.equal(result.remoteDebuggingPort, 9333);
  assert.equal(result.nextUnverified, undefined);
  assert.match(result.launchCommand, /9333/);
  assert.match(result.guides[0].safeFrontAction, /Archive/);
  assert.match(result.guides[0].captureCommand, /--name archive/);
  assert.match(result.guides[0].previewCommand, /frontctl archive/);
});

test("discovery guide can describe verified standalone compose explicitly", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-guide-compose"), "fixtures");

  const result = await discoveryCommand(["guide", "draft.compose"]) as any;

  assert.equal(result.scope, "requested-action");
  assert.equal(result.count, 1);
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.nextUnverified, undefined);
  assert.equal(result.guides[0].action, "draft.compose");
  assert.equal(result.guides[0].verified, true);
  assert.match(result.guides[0].safeFrontAction, /Create one new draft compose/);
});

test("discovery guide can describe test conversation route capture explicitly", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-guide-test-conversation"), "fixtures");

  const result = await discoveryCommand(["guide", "conversation.create-test"]) as any;

  assert.equal(result.scope, "requested-action");
  assert.equal(result.count, 1);
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.nextUnverified, undefined);
  assert.equal(result.guides[0].action, "conversation.create-test");
  assert.equal(result.guides[0].expectedRouteKind, "comment.save");
  assert.equal(result.guides[0].verified, true);
  assert.match(result.guides[0].safeFrontAction, /internal discussion\/test conversation/);
  assert.match(result.guides[0].previewCommand, /create-test-conversation/);
});

test("discovery guide can focus on one write action", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-guide-one"), "fixtures");

  const result = await discoveryCommand(["guide", "comment.add"]) as any;

  assert.equal(result.count, 1);
  assert.equal(result.guides[0].action, "comment.add");
  assert.equal(result.guides[0].expectedRouteKind, "comment.add");
  assert.match(result.guides[0].safeFrontAction, /private internal comment/i);
  assert.match(result.guides[0].captureCommand, /--name comment\.add/);
});

test("discovery browser-status reports CDP readiness without raw process commands", async () => {
  const result = await discoveryCommand(["browser-status", "--remote-debugging-port", "9"]) as any;

  assert.equal(result.source, "local-diagnostics");
  assert.equal(result.publicApiUsed, false);
  assert.equal(result.remoteDebuggingPort, 9);
  assert.equal(typeof result.cdp.reachable, "boolean");
  assert.equal(typeof result.front.processCount, "number");
  assert.equal(typeof result.front.remoteDebuggingEnabled, "boolean");
  assert.equal(typeof result.edge.processCount, "number");
  assert.equal(typeof result.edge.remoteDebuggingEnabled, "boolean");
  assert.match(result.recommendedLaunchCommand, /frontctl discovery launch/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp("Applications/Front\\\\.app/Contents/MacOS|--user-data-dir="));
});

test("discovery browser-probe reports unauthenticated browser sessions without leaking secrets", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-browser-probe"));
  await writeFile(
    join(paths.cacheDataPath, "route"),
    "https://app.frontapp.com/cell-00017/api/1/companies/abc/team/123/conversations/inbox",
  );
  const testGlobal = globalThis as unknown as { fetch: unknown; WebSocket?: unknown };
  const originalFetch = testGlobal.fetch;
  const originalWebSocket = testGlobal.WebSocket;
  testGlobal.fetch = async () => ({
    ok: true,
    json: async () => [
      {
        type: "page",
        title: "Front",
        url: "https://app.frontapp.com/open/cell-00017/api/1/companies/abc/conversations/96357799249?token=SECRET",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/conversation",
      },
    ],
  });
  testGlobal.WebSocket = makeFakeRuntimeProbeSocket({
    ok: false,
    httpStatus: 401,
    contentType: "application/json; charset=utf-8",
    status: "authentication_required",
    hasSubject: false,
    hasMessages: false,
    bodyShape: {
      name: "string",
      status: "string",
      reason: "string",
      message: "string",
      settings: {
        account: {
          accessToken: "string",
          refreshToken: "string",
        },
      },
    },
  });

  try {
    const result = await discoveryCommand([
      "browser-probe",
      "96357799249",
      "--remote-debugging-port",
      "9222",
      "--target-url-contains",
      "conversations/96357799249",
    ], paths) as any;

    assert.equal(result.source, "browser-cdp-runtime");
    assert.equal(result.publicApiUsed, false);
    assert.equal(result.authenticated, false);
    assert.equal(result.probe.httpStatus, 401);
    assert.equal(result.probe.frontStatus, "authentication_required");
    assert.match(result.nextAction, /browser tab is reachable but not authenticated/i);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|token=|accessToken|refreshToken/);
    assert.match(JSON.stringify(result.probe.bodyShape), /<redacted:secret-key>/);
  } finally {
    testGlobal.fetch = originalFetch;
    testGlobal.WebSocket = originalWebSocket;
  }
});

test("discovery browser-seed is dry-run unless --yes is passed", async () => {
  const result = await discoveryCommand([
    "browser-seed",
    "--remote-debugging-port",
    "9333",
    "--target-url-contains",
    "conversations/96357799249",
  ]) as any;

  assert.equal(result.source, "frontctl-session-to-browser-cdp");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.requiresYes, true);
  assert.equal(result.publicApiUsed, false);
  assert.deepEqual(result.cookieNames, ["front.id", "front.id.sig", "front.csrf"]);
  assert.equal(result.valuePrinted, false);
  assert.match(result.command, /browser-seed/);
});

test("discovery verify-browser-writes previews browser mutation coverage", async () => {
  const result = await discoveryCommand([
    "verify-browser-writes",
    "96357799249",
    "--remote-debugging-port",
    "9333",
    "--target-url-contains",
    "conversations/96357799249",
    "--tag-id",
    "200405777",
  ]) as any;

  assert.equal(result.source, "browser-cdp-runtime");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.requiresYes, true);
  assert.equal(result.publicApiUsed, false);
  assert.equal(result.sendsEmail, false);
  assert.deepEqual(result.actions, [
    "unarchive",
    "archive",
    "snooze",
    "unsnooze",
    "tag.add",
    "tag.remove",
    "comment.add",
    "comment.remove",
    "draft.reply",
    "draft.discard",
  ]);
  assert.match(result.command, /verify-browser-writes 96357799249/);
});

test("discovery relaunch-front is dry-run unless --yes is passed", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-discovery-relaunch"));

  const result = await discoveryCommand(["relaunch-front", "--remote-debugging-port", "9333"], paths) as any;

  assert.equal(result.source, "local-diagnostics");
  assert.equal(result.mode, "dry-run");
  assert.equal(result.requiresYes, true);
  assert.equal(result.willQuitFront, true);
  assert.equal(result.remoteDebuggingPort, 9333);
  assert.equal(result.preflight.potentialDraftCount, 0);
  assert.equal(result.preflight.draftCheck.bodyTextIncluded, false);
  assert.equal(result.browserStatus.remoteDebuggingPort, 9333);
  assert.match(result.command, /relaunch-front --remote-debugging-port 9333 --yes/);
  assert.match(result.warning, /quits and reopens Front/);
  assert.deepEqual(result.launchCommand, [
    "open",
    "-na",
    paths.appPath,
    "--args",
    "--remote-debugging-port=9333",
  ]);
});

test("discovery verify-writes reports complete fixture coverage", async () => {
  const dir = await makeTempDir("frontctl-discovery-verify");
  const fixturePath = join(dir, "writes.sanitized.json");
  await writeFile(fixturePath, JSON.stringify({
    publicApiUsed: false,
    redacted: true,
    entries: WRITE_ACTION_SPECS.map((spec) => ({
      method: spec.method,
      path: spec.path,
      routeKind: routeKindForAction(spec.action),
      requestBodyShape: shapeOfFixtureBody("body" in spec ? spec.body : undefined),
      redacted: ["query", "headers", "cookies", "auth", "body-values", "mailbox-text"],
    })),
  }));
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixturePath;

  const result = await discoveryCommand(["verify-writes"]) as any;

  assert.equal(result.allVerified, true);
  assert.equal(result.verifiedCount, WRITE_ACTION_SPECS.length);
  assert.deepEqual(result.blockedActions.map((action: { action: string }) => action.action), []);
});

test("discovery verify-live-writes previews the real mutation sequence unless --yes is passed", async () => {
  const result = await discoveryCommand(["verify-live-writes", "conversation-1"]) as any;

  assert.equal(result.mode, "dry-run");
  assert.equal(result.source, "live-private");
  assert.equal(result.publicApiUsed, false);
  assert.equal(result.requiresYes, true);
  assert.equal(result.conversationId, "conversation-1");
  assert.deepEqual(result.actions, [
    "archive",
    "unarchive",
    "snooze",
    "unsnooze",
    "tag.add",
    "tag.remove",
    "comment.add",
    "comment.remove",
    "draft.reply",
    "draft.compose",
    "draft.update",
    "draft.discard",
  ]);
  assert.match(result.command, /verify-live-writes conversation-1 --yes/);
  assert.equal(result.finalState.identityCommentsRemain, true);
  assert.match(result.note, /identity comments remain visible by design/);
});

test("discovery fixtures install/list/path manage the default fixture store", async () => {
  const dir = await makeTempDir("frontctl-discovery-fixtures");
  const fixtureRoot = join(dir, "fixtures");
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixtureRoot;
  const input = join(dir, "archive-write.har");
  await writeFile(input, JSON.stringify({
    entries: [
      {
        method: "POST",
        url: "https://app.frontapp.com/cell-00017/api/1/companies/abc/conversation_batch/archive?token=SECRET",
        postData: { text: JSON.stringify({ conversation_ids: ["cnv_1"] }) },
      },
    ],
  }));

  const pathResult = await discoveryCommand(["fixtures", "path"]) as any;
  const installResult = await discoveryCommand(["fixtures", "install", input, "--name", "archive"]) as any;
  const listResult = await discoveryCommand(["fixtures", "list"]) as any;

  assert.equal(pathResult.fixtureRoot, discoveryFixtureRoot());
  assert.equal(installResult.installed, true);
  assert.equal(installResult.count, 1);
  assert.deepEqual(installResult.routeKinds, ["archive"]);
  assert.equal(listResult.count, 1);
  assert.doesNotMatch(JSON.stringify(listResult), /SECRET|token=/);
});

test("discovery launch print-only returns remote debugging command without opening Front", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-discovery-launch"));

  const result = await launchFrontForDiscovery({
    paths,
    remoteDebuggingPort: 9333,
    printOnly: true,
  });

  assert.equal(result.launched, false);
  assert.equal(result.remoteDebuggingPort, 9333);
  assert.deepEqual(result.command, [
    "open",
    "-na",
    paths.appPath,
    "--args",
    "--remote-debugging-port=9333",
  ]);
  assert.match(result.nextSteps.join("\n"), /discovery capture/);
});

test("discovery capture can install sanitized DevTools entries directly into fixture store", async () => {
  const fixtureRoot = join(await makeTempDir("frontctl-discovery-capture-install"), "fixtures");
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = fixtureRoot;
  const testGlobal = globalThis as unknown as { fetch: unknown; WebSocket?: unknown };
  const originalFetch = testGlobal.fetch;
  const originalWebSocket = testGlobal.WebSocket;
  const fakeSocket = makeFakeDevToolsSocket([
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId: "request-1",
        request: {
          method: "POST",
          url: "https://app.frontapp.com/cell-00017/api/1/companies/abc/conversations/123/timeline?token=SECRET",
          postData: JSON.stringify({ body: "SECRET COMMENT" }),
        },
      },
    },
  ]);
  testGlobal.fetch = async () => ({
    ok: true,
    json: async () => [
      {
        url: "https://app.frontapp.com",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/1",
      },
    ],
  });
  testGlobal.WebSocket = fakeSocket;

  try {
    const result = await discoveryCommand([
      "capture",
      "--remote-debugging-port",
      "9222",
      "--duration-ms",
      "5",
      "--install",
      "--name",
      "comment",
    ]) as any;

    assert.equal(result.installed, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.installedRouteKinds, ["comment.add"]);
    assert.match(result.fixturePath, /comment-/);
    assert.doesNotMatch(await readFile(result.fixturePath, "utf8"), /SECRET|token=/);
  } finally {
    testGlobal.fetch = originalFetch;
    testGlobal.WebSocket = originalWebSocket;
  }
});

test("discovery capture prefers the requested Front conversation target over sign-in tabs", async () => {
  const testGlobal = globalThis as unknown as { fetch: unknown; WebSocket?: unknown };
  const originalFetch = testGlobal.fetch;
  const originalWebSocket = testGlobal.WebSocket;
  const sentMessages: string[] = [];
  const fakeSocket = makeFakeDevToolsSocket([
    {
      method: "Network.requestWillBeSent",
      params: {
        requestId: "request-1",
        request: {
          method: "GET",
          url: "https://app.frontapp.com/cell-00017/api/1/companies/abc/conversations/96357799249/content?auth=SECRET",
        },
      },
    },
  ], sentMessages);
  testGlobal.fetch = async () => ({
    ok: true,
    json: async () => [
      {
        type: "page",
        title: "Front",
        url: "https://app.frontapp.com/signin?next=SECRET",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/signin",
      },
      {
        type: "page",
        title: "Front",
        url: "https://app.frontapp.com/open/cell-00017/api/1/companies/abc/conversations/96357799249?token=SECRET",
        webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/conversation",
      },
    ],
  });
  testGlobal.WebSocket = fakeSocket;

  try {
    const result = await discoveryCommand([
      "capture",
      "--remote-debugging-port",
      "9222",
      "--duration-ms",
      "5",
      "--target-url-contains",
      "conversations/96357799249",
      "--reload",
    ]) as any;

    assert.equal(result.count, 1);
    assert.equal(result.target.matchedFrontApp, true);
    assert.match(result.target.url, /conversations\/96357799249$/);
    assert.equal(result.reloaded, true);
    assert.match(sentMessages.join("\n"), /"method":"Page.reload"/);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|token=|auth=/);
  } finally {
    testGlobal.fetch = originalFetch;
    testGlobal.WebSocket = originalWebSocket;
  }
});

function routeKindForAction(action: string) {
  return {
    archive: "conversation.update",
    unarchive: "conversation.update",
    unsnooze: "conversation.update",
    "tag.add": "conversation.update",
    "tag.remove": "conversation.update",
    "comment.add": "comment.add",
    "comment.remove": "comment.remove",
    snooze: "conversation.update",
    "draft.reply": "message-or-draft",
    "draft.compose": "message-or-draft",
    "draft.discard": "draft.discard",
  }[action] ?? action;
}

function shapeOfFixtureBody(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length ? [shapeOfFixtureBody(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /body|text|subject|email|name/i.test(key) ? `<redacted:${typeof child}>` : shapeOfFixtureBody(child),
    ]));
  }
  return typeof value;
}

function makeFakeDevToolsSocket(messages: unknown[], sentMessages: string[] = []) {
  return class FakeWebSocket {
    private listeners = new Map<string, Array<(message?: { data?: unknown }) => void>>();

    constructor(_url: string) {
      setTimeout(() => this.emit("open"), 0);
    }

    addEventListener(event: string, listener: (message?: { data?: unknown }) => void) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    send(messageText: string) {
      sentMessages.push(messageText);
      const message = JSON.parse(messageText) as { method?: string };
      if (message.method === "Network.enable") {
        for (const item of messages) {
          setTimeout(() => this.emit("message", { data: JSON.stringify(item) }), 0);
        }
      }
    }

    close() {
      // Test fake: no persistent connection to clean up.
    }

    private emit(event: string, message?: { data?: unknown }) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(message);
      }
    }
  };
}

function makeFakeRuntimeProbeSocket(value: unknown) {
  return class FakeRuntimeProbeSocket {
    private listeners = new Map<string, Array<(message?: { data?: unknown }) => void>>();

    constructor(_url: string) {
      setTimeout(() => this.emit("open"), 0);
    }

    addEventListener(event: string, listener: (message?: { data?: unknown }) => void) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
    }

    send(messageText: string) {
      const message = JSON.parse(messageText) as { id?: number; method?: string };
      if (message.method === "Runtime.evaluate") {
        setTimeout(() => this.emit("message", {
          data: JSON.stringify({
            id: message.id,
            result: {
              result: {
                type: "object",
                value,
              },
            },
          }),
        }), 0);
      }
    }

    close() {
      // Test fake: no persistent connection to clean up.
    }

    private emit(event: string, message?: { data?: unknown }) {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(message);
      }
    }
  };
}
