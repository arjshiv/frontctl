import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { resourcesCommand } from "../src/commands/resources.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontSession } from "./helpers.js";

test("resources list custom-fields exposes resource scope from live boot metadata", async () => {
  const paths = await fakeResourceContext("frontctl-resources-custom-fields");
  const requests: Array<{ url: string; method: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/boot/app/8")) {
      return jsonResponse({
        custom_fields: [
          {
            id: 272081,
            name: "PMS Admin",
            type: "boolean",
            resource_type: "card",
          },
        ],
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  try {
    const result = await resourcesCommand(["list", "custom-fields", "--limit", "10"], paths) as any;

    assert.equal(result.source, "live-private");
    assert.equal(result.publicApiUsed, false);
    assert.equal(result.kind, "custom-fields");
    assert.equal(result.count, 1);
    assert.deepEqual(result.resources[0], {
      id: "272081",
      name: "PMS Admin",
      type: "boolean",
      resourceType: "card",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    requests.map((request) => ({ method: request.method, path: new URL(request.url).pathname })),
    [{ method: "GET", path: "/cell-00017/api/1/companies/32390a17805cd26f7349/boot/app/8" }],
  );
});

test("resources search-cards and read-card use private Front card routes", async () => {
  const paths = await fakeResourceContext("frontctl-resources-cards");

  const requests: Array<{ url: string; method: string }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET" });
    if (url.includes("/search_card/test%40test.com?limit=5")) {
      return jsonResponse({
        cards: [
          {
            id: 8866591441,
            namespace: "global",
            url: "/cell-00017/api/1/companies/32390a17805cd26f7349/cards/8866591441",
            name: "test@test.com",
            display_name: "test@test.com",
            type: "enhanced",
            custom_field_attributes: [{ custom_field_id: 272081, value: "true" }],
            contacts: [{ id: 15659853521, source: "email", handle: "test@test.com" }],
          },
        ],
      });
    }
    if (url.endsWith("/cards/8866591441")) {
      return jsonResponse({
        id: 8866591441,
        namespace: "global",
        url: "/cell-00017/api/1/companies/32390a17805cd26f7349/cards/8866591441",
        name: "test@test.com",
        display_name: "test@test.com",
        type: "enhanced",
        custom_field_attributes: [{ custom_field_id: 272081, value: "false" }],
        contacts: [{ id: 15659853521, source: "email", handle: "test@test.com" }],
      });
    }
    return jsonResponse({}, 404);
  }) as typeof fetch;

  try {
    const search = await resourcesCommand(["search-cards", "test@test.com", "--limit", "5"], paths) as any;
    assert.equal(search.source, "live-private");
    assert.equal(search.publicApiUsed, false);
    assert.equal(search.count, 1);
    assert.equal(search.cards[0].id, "8866591441");
    assert.equal(search.cards[0].contacts[0].handle, "test@test.com");
    assert.deepEqual(search.cards[0].customFieldAttributes, [{ customFieldId: "272081", value: "true" }]);

    const read = await resourcesCommand(["read-card", "8866591441"], paths) as any;
    assert.equal(read.source, "live-private");
    assert.equal(read.publicApiUsed, false);
    assert.equal(read.card.id, "8866591441");
    assert.deepEqual(read.card.customFieldAttributes, [{ customFieldId: "272081", value: "false" }]);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(
    requests.map((request) => ({ method: request.method, path: new URL(request.url).pathname + new URL(request.url).search })),
    [
      { method: "GET", path: "/cell-00017/api/1/companies/32390a17805cd26f7349/search_card/test%40test.com?limit=5" },
      { method: "GET", path: "/cell-00017/api/1/companies/32390a17805cd26f7349/cards/8866591441" },
    ],
  );
});

async function fakeResourceContext(name: string) {
  const paths = await makeFakeFrontInstall(await makeTempDir(name));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  process.env.FRONTCTL_SESSION_PATH = join(paths.supportPath, "frontctl-session.json");
  await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);
  return paths;
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
