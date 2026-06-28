import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { listInbox } from "../src/commands/inbox.js";
import { makeFakeFrontInstall, makePlainCookieDb, makeTempDir, writeFakeFrontCacheFixture, writeFakeFrontSession } from "./helpers.js";

const ROUTE_CONTEXT =
  "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox";

test("inbox list uses the live private route by default", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-inbox-live-default"));
  await writeFakeFrontCacheFixture(paths);
  await writeFile(join(paths.cacheDataPath, "route-cache"), ROUTE_CONTEXT);

  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousFetch = globalThis.fetch;
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.endsWith("/conversations/inbox")) {
      return new Response(JSON.stringify({
        conversations: [
          {
            id: "live-conversation-1",
            subject: "Live inbox thread",
            status: "assigned",
            message_type: "email",
            contact: { name: "Live Sender" },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await listInbox(["--limit", "1", "--json"], paths) as {
      source: string;
      stale: boolean;
      conversations: Array<{ id: string; subject: string }>;
    };

    assert.equal(result.source, "live-private");
    assert.equal(result.stale, false);
    assert.equal(result.conversations[0].id, "live-conversation-1");
    assert.ok(requestedUrls.some((url) => url.endsWith("/conversations/inbox")));
    assert.ok(!requestedUrls.some((url) => url.includes("api2.frontapp.com")));
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
  }
});

test("inbox list reads stale cache only when explicitly requested", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-inbox-offline-cache"));
  await writeFakeFrontCacheFixture(paths);

  const result = await listInbox(["--offline-cache", "--limit", "1", "--json"], paths) as {
    source: string;
    stale: boolean;
    conversations: Array<{ id: string }>;
  };

  assert.equal(result.source, "cache");
  assert.equal(result.stale, true);
  assert.equal(result.conversations[0].id, "93727705553");
});

test("inbox list prefers a valid reusable session over CDP bridge", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-inbox-session-before-cdp"));
  await writeFakeFrontCacheFixture(paths);
  await writeFile(join(paths.cacheDataPath, "route-cache"), ROUTE_CONTEXT);

  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousBridge = process.env.FRONTCTL_CDP_BRIDGE;
  const previousBridgeContext = process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT;
  const previousBridgeResponses = process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES;
  const previousFetch = globalThis.fetch;
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  process.env.FRONTCTL_CDP_BRIDGE = "1";
  process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT = JSON.stringify({
    origin: "https://app.frontapp.com",
    cell: "cell-00017",
    companyId: "32390a17805cd26f7349",
    teamId: "6088721",
  });
  process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES = JSON.stringify({
    "/conversations/inbox": {
      conversations: [{ id: "bridge-should-not-win", subject: "Bridge should not win" }],
    },
  });
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/conversations/inbox")) {
      return new Response(JSON.stringify({
        conversations: [
          {
            id: "session-live-1",
            subject: "Session live thread",
            status: "assigned",
            message_type: "email",
            contact: { name: "Session Sender" },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await listInbox(["--limit", "1", "--json"], paths) as {
      transport: string;
      conversations: Array<{ id: string }>;
    };

    assert.equal(result.transport, "session-cookie");
    assert.equal(result.conversations[0].id, "session-live-1");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
    if (previousBridge === undefined) delete process.env.FRONTCTL_CDP_BRIDGE;
    else process.env.FRONTCTL_CDP_BRIDGE = previousBridge;
    if (previousBridgeContext === undefined) delete process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT;
    else process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT = previousBridgeContext;
    if (previousBridgeResponses === undefined) delete process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES;
    else process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES = previousBridgeResponses;
  }
});

test("inbox list can bootstrap a live session from agentcookie without Keychain", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-inbox-agentcookie-default"));
  await writeFakeFrontCacheFixture(paths);
  await writeFile(join(paths.cacheDataPath, "route-cache"), ROUTE_CONTEXT);
  const cookiePath = join(paths.supportPath, "agentcookie", "cookies-plain.db");
  await makePlainCookieDb(cookiePath);

  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousCookiePath = process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
  const previousFetch = globalThis.fetch;
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = cookiePath;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/conversations/inbox")) {
      return new Response(JSON.stringify({
        conversations: [
          {
            id: "agentcookie-live-1",
            subject: "Agentcookie live thread",
            status: "assigned",
            message_type: "email",
            contact: { name: "Browser Sender" },
          },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const result = await listInbox(["--json"], paths) as {
      source: string;
      stale: boolean;
      conversations: Array<{ id: string }>;
    };

    assert.equal(result.source, "live-private");
    assert.equal(result.stale, false);
    assert.equal(result.conversations[0].id, "agentcookie-live-1");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
    if (previousCookiePath === undefined) delete process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
    else process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = previousCookiePath;
  }
});

test("inbox list uses CDP bridge without Keychain, session, agentcookie, or stale cache", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-inbox-cdp-bridge"));
  await writeFakeFrontCacheFixture(paths);

  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousCookiePath = process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
  const previousBridge = process.env.FRONTCTL_CDP_BRIDGE;
  const previousBridgeContext = process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT;
  const previousBridgeResponses = process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES;
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "missing-session.json");
  process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = join(paths.supportPath, "missing-agentcookie.db");
  process.env.FRONTCTL_CDP_BRIDGE = "1";
  process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT = JSON.stringify({
    origin: "https://app.frontapp.com",
    cell: "cell-00017",
    companyId: "32390a17805cd26f7349",
    teamId: "6088721",
  });
  process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES = JSON.stringify({
    "/conversations/inbox": {
      conversations: [
        {
          id: "bridge-live-1",
          subject: "Bridge live thread",
          status: "assigned",
          message_type: "email",
          contact: { name: "Signed-in Browser" },
        },
      ],
    },
  });

  try {
    const result = await listInbox(["--limit", "1", "--json"], paths) as {
      source: string;
      transport: string;
      stale: boolean;
      conversations: Array<{ id: string; subject: string }>;
    };

    assert.equal(result.source, "live-private");
    assert.equal(result.transport, "cdp-bridge");
    assert.equal(result.stale, false);
    assert.equal(result.conversations[0].id, "bridge-live-1");
  } finally {
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
    if (previousCookiePath === undefined) delete process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
    else process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = previousCookiePath;
    if (previousBridge === undefined) delete process.env.FRONTCTL_CDP_BRIDGE;
    else process.env.FRONTCTL_CDP_BRIDGE = previousBridge;
    if (previousBridgeContext === undefined) delete process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT;
    else process.env.FRONTCTL_CDP_BRIDGE_MOCK_CONTEXT = previousBridgeContext;
    if (previousBridgeResponses === undefined) delete process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES;
    else process.env.FRONTCTL_CDP_BRIDGE_MOCK_RESPONSES = previousBridgeResponses;
  }
});
