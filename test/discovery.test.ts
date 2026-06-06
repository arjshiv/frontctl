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
            url: "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/123/comments?token=SECRET",
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

test("discovery verify-writes accepts built-in known non-send route coverage", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-empty"), "fixtures");
  delete process.env.FRONTCTL_REQUIRE_DISCOVERY_FIXTURES;

  const result = await discoveryCommand(["verify-writes"]) as any;

  assert.equal(result.allVerified, true);
  assert.equal(result.verifiedCount, WRITE_ACTION_SPECS.length);
  assert.ok(result.actions.every((action: { source?: string }) => action.source === "known-route"));
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

test("discovery guide can focus on one write action", async () => {
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(await makeTempDir("frontctl-discovery-guide-one"), "fixtures");

  const result = await discoveryCommand(["guide", "comment.add"]) as any;

  assert.equal(result.count, 1);
  assert.equal(result.guides[0].action, "comment.add");
  assert.equal(result.guides[0].expectedRouteKind, "comment.add");
  assert.match(result.guides[0].safeFrontAction, /private internal comment/i);
  assert.match(result.guides[0].captureCommand, /--name comment\.add/);
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
          url: "https://app.frontapp.com/cell-00017/api/1/companies/abc/conversations/123/comments?token=SECRET",
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

function routeKindForAction(action: string) {
  return {
    archive: "archive",
    "tag.add": "tag.add",
    "tag.remove": "tag.remove",
    "comment.add": "comment.add",
    snooze: "snooze",
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

function makeFakeDevToolsSocket(messages: unknown[]) {
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

    send(_message: string) {
      for (const message of messages) {
        setTimeout(() => this.emit("message", { data: JSON.stringify(message) }), 0);
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
