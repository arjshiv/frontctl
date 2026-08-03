import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readFrontSession } from "../src/lib/auth.js";
import { createFrontPrivateClient, type FrontPrivateClient } from "../src/lib/frontPrivate.js";
import { buildFrontRoutes, readPersistedFrontRouteContext } from "../src/lib/frontRoutes.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontSession } from "./helpers.js";

test("session-cookie private requests time out instead of hanging forever", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-timeout"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  const previousFetch = globalThis.fetch;
  const previousTimeout = process.env.FRONTCTL_HTTP_TIMEOUT_MS;
  process.env.FRONTCTL_HTTP_TIMEOUT_MS = "25";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted") as Error & { name: string };
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    })) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths);
    const routes = buildFrontRoutes(client.context);
    await assert.rejects(
      () => client.getJson(routes.conversation("1")),
      /Front private request timed out after 25ms: GET .*\/conversations\/1/,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousTimeout === undefined) {
      delete process.env.FRONTCTL_HTTP_TIMEOUT_MS;
    } else {
      process.env.FRONTCTL_HTTP_TIMEOUT_MS = previousTimeout;
    }
  }
});

test("current Front routes resolve through local profile state and persist after a live request", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-current-route"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/97217720401",
  );
  await writeFile(join(paths.localStorageLevelDbPath, "000003.log"), "tea:6088721");
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  process.env.FRONTCTL_ROUTE_CONTEXT_PATH = join(paths.supportPath, "route-context.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ conversations: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths);
    assert.equal(client.context.teamId, "6088721");
    await client.getJson(buildFrontRoutes(client.context).inbox);
    assert.deepEqual(await readPersistedFrontRouteContext(), client.context);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.FRONTCTL_ROUTE_CONTEXT_PATH;
  }
});

test("boot metadata repairs route context when local team state is unavailable", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-boot-route"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/97217720401",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  process.env.FRONTCTL_ROUTE_CONTEXT_PATH = join(paths.supportPath, "route-context.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  const previousFetch = globalThis.fetch;
  let bootCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/boot/app/8")) {
      bootCalls += 1;
      return new Response(JSON.stringify({ user: { id: 6088721 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ conversations: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths);
    assert.equal(client.context.teamId, "6088721");
    assert.equal(bootCalls, 1);
    assert.deepEqual(await readPersistedFrontRouteContext(), client.context);
  } finally {
    globalThis.fetch = previousFetch;
    delete process.env.FRONTCTL_ROUTE_CONTEXT_PATH;
  }
});

test("session-cookie private requests include a redacted error excerpt", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-error-redaction"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      'Bad route for arjun@example.com cookie: front.id=secret; X-Front-Xsrf: csrf-secret',
      {
        status: 400,
        headers: { "content-type": "text/plain" },
      },
    )) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths);
    const routes = buildFrontRoutes(client.context);
    await assert.rejects(
      () => client.requestJson(routes.conversation("1"), { method: "PATCH", body: { ok: true } }),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /Front private request failed with HTTP 400: Bad route for \[redacted-email\]/);
        assert.doesNotMatch(message, /arjun@example\.com/);
        assert.doesNotMatch(message, /front\.id=secret/);
        assert.doesNotMatch(message, /csrf-secret/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("session-cookie authentication_required clears stale cache and suggests forced unlock", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-auth-required"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH, { source: "front-app" });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths);
    const routes = buildFrontRoutes(client.context);
    await assert.rejects(
      () => client.requestJson(routes.timeline("cnv_1"), { method: "POST", body: { type: "comment" } }),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /cached frontctl session was rejected by Front and has been cleared/);
        assert.match(message, /auth unlock --source front-app --ttl-hours 720 --force --json/);
        return true;
      },
    );
    assert.equal(await readFrontSession(process.env.FRONTCTL_SESSION_PATH), undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("session-cookie authentication_required retries once through a validated fallback client", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-auth-fallback"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH, { source: "edge:Default" });

  const previousFetch = globalThis.fetch;
  let recoveryCalls = 0;
  let fallbackCalls = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const context = {
      origin: "https://app.frontapp.com",
      cell: "cell-00017",
      companyId: "32390a17805cd26f7349",
      teamId: "6088721",
    };
    const fallbackClient: FrontPrivateClient = {
      context,
      transport: "cdp-bridge",
      async getJson<T>() {
        fallbackCalls += 1;
        return { recovered: true } as T;
      },
      async requestJson<T>() {
        fallbackCalls += 1;
        return { recovered: true } as T;
      },
    };
    const client = await createFrontPrivateClient(paths, {
      recoverAuthentication: async () => {
        recoveryCalls += 1;
        return fallbackClient;
      },
    });
    const routes = buildFrontRoutes(client.context);

    const [result, secondResult] = await Promise.all([
      client.getJson<{ recovered: boolean }>(routes.conversation("1")),
      client.getJson<{ recovered: boolean }>(routes.conversation("2")),
    ]);
    const thirdResult = await client.getJson<{ recovered: boolean }>(routes.conversation("3"));

    assert.deepEqual(result, { recovered: true });
    assert.deepEqual(secondResult, { recovered: true });
    assert.deepEqual(thirdResult, { recovered: true });
    assert.equal(recoveryCalls, 1);
    assert.equal(fallbackCalls, 3);
    assert.equal(client.transport, "cdp-bridge");
    assert.equal(await readFrontSession(process.env.FRONTCTL_SESSION_PATH), undefined);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("browser session rejection recommends the open Front app after bounded recovery fails", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-auth-fallback-failed"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH, { source: "edge:Default" });

  const previousFetch = globalThis.fetch;
  let recoveryCalls = 0;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const client = await createFrontPrivateClient(paths, {
      recoverAuthentication: async () => {
        recoveryCalls += 1;
        return undefined;
      },
    });
    const routes = buildFrontRoutes(client.context);
    await assert.rejects(
      () => client.getJson(routes.conversation("1")),
      (error: unknown) => {
        const message = String((error as Error).message);
        assert.match(message, /Automatic fallback through available live sources did not succeed/);
        assert.match(message, /auth unlock --source front-app --ttl-hours 720 --force --json/);
        return true;
      },
    );
    assert.equal(recoveryCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("attachment downloads use the same one-time authenticated fallback", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-private-download-fallback"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH, { source: "edge:Default" });

  const previousFetch = globalThis.fetch;
  let requiredByteDownloads = false;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "authentication_required" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;

  try {
    const context = {
      origin: "https://app.frontapp.com",
      cell: "cell-00017",
      companyId: "32390a17805cd26f7349",
      teamId: "6088721",
    };
    const fallbackClient: FrontPrivateClient = {
      context,
      transport: "session-cookie",
      async getJson<T>() {
        return {} as T;
      },
      async requestJson<T>() {
        return {} as T;
      },
      async requestBytes() {
        return {
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "application/pdf",
          filename: "attachment.pdf",
        };
      },
    };
    const client = await createFrontPrivateClient(paths, {
      recoverAuthentication: async (_context, _session, requireByteDownloads) => {
        requiredByteDownloads = requireByteDownloads;
        return fallbackClient;
      },
    });
    const result = await client.requestBytes?.(buildFrontRoutes(client.context).attachment("att_1"));

    assert.equal(requiredByteDownloads, true);
    assert.deepEqual([...result!.bytes], [1, 2, 3]);
    assert.equal(result?.contentType, "application/pdf");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
