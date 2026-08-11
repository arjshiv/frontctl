import { strict as assert } from "node:assert";
import test from "node:test";
import {
  extractRouteIdFromAppLink,
  resolvePrivateConversationRouteId,
} from "../src/lib/conversationIds.js";
import type { FrontPrivateClient } from "../src/lib/frontPrivate.js";
import { buildFrontRoutes } from "../src/lib/frontRoutes.js";

const routes = buildFrontRoutes({
  origin: "https://app.frontapp.com",
  cell: "cell-00017",
  companyId: "company",
  teamId: "team",
});

test("resolves an indexed cnv id without calling Front's direct app link route", async () => {
  const requests: string[] = [];
  const client = fakeClient(async (url) => {
    requests.push(url);
    if (url === routes.searchRaw("cnv_indexed")) {
      return { conversations: [{ conversation_id: "97839252689" }] };
    }
    throw new Error("app link must not run");
  });

  assert.equal(await resolvePrivateConversationRouteId(client, routes, "cnv_indexed"), "97839252689");
  assert.deepEqual(requests, [routes.searchRaw("cnv_indexed")]);
});

test("resolves an unindexed cnv id through Front's direct app link route", async () => {
  const requests: string[] = [];
  const client = fakeClient(async (url) => {
    requests.push(url);
    if (url === routes.searchRaw("cnv_new123")) {
      return { conversations: [] };
    }
    return {
      app_link: "/inboxes/teammates/42/inbox/open/0/search/global/id:cnv_new123/97839252689",
    };
  });

  assert.equal(await resolvePrivateConversationRouteId(client, routes, "cnv_new123"), "97839252689");
  assert.deepEqual(requests, [routes.searchRaw("cnv_new123"), routes.appLink("/open/cnv_new123")]);
});

test("falls back to the direct route when indexed lookup fails or is ambiguous", async () => {
  for (const searchResult of [new Error("index unavailable"), {
    conversations: [{ conversation_id: "111" }, { conversation_id: "222" }],
  }]) {
    const client = fakeClient(async (url) => {
      if (url === routes.searchRaw("cnv_fallback")) {
        if (searchResult instanceof Error) throw searchResult;
        return searchResult;
      }
      return { app_link: "/search/global/id:cnv_fallback/333" };
    });

    assert.equal(await resolvePrivateConversationRouteId(client, routes, "cnv_fallback"), "333");
  }
});

test("does not accept an app link for a different conversation", () => {
  assert.equal(
    extractRouteIdFromAppLink(
      "/inboxes/teammates/42/inbox/open/0/search/global/id:cnv_other/97839252689",
      "cnv_expected",
    ),
    undefined,
  );
});

test("does not resolve malformed or non-numeric app links", () => {
  assert.equal(extractRouteIdFromAppLink(undefined, "cnv_test"), undefined);
  assert.equal(extractRouteIdFromAppLink("/search/global/id:cnv_test/not-a-number", "cnv_test"), undefined);
});

test("leaves Front's numeric private route id unchanged", async () => {
  const client = fakeClient(async () => {
    throw new Error("no request expected");
  });
  assert.equal(await resolvePrivateConversationRouteId(client, routes, "97839252689"), "97839252689");
});

function fakeClient(getJson: (url: string) => Promise<unknown>): FrontPrivateClient {
  return {
    context: {
      origin: "https://app.frontapp.com",
      cell: "cell-00017",
      companyId: "company",
      teamId: "team",
    },
    transport: "session-cookie",
    async getJson<T = unknown>(url: string) {
      return await getJson(url) as T;
    },
    async requestJson() {
      throw new Error("not implemented");
    },
  };
}
