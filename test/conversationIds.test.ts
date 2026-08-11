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

test("resolves an unindexed cnv id through Front's direct app link route", async () => {
  const requests: string[] = [];
  const client = fakeClient(async (url) => {
    requests.push(url);
    if (url === routes.appLink("/open/cnv_new123")) {
      return {
        app_link: "/inboxes/teammates/42/inbox/open/0/search/global/id:cnv_new123/97839252689",
      };
    }
    throw new Error("search must not run");
  });

  assert.equal(await resolvePrivateConversationRouteId(client, routes, "cnv_new123"), "97839252689");
  assert.deepEqual(requests, [routes.appLink("/open/cnv_new123")]);
});

test("falls back to compatibility search when app link resolution is unavailable", async () => {
  const requests: string[] = [];
  const client = fakeClient(async (url) => {
    requests.push(url);
    if (url === routes.appLink("/open/cnv_legacy")) {
      throw new Error("HTTP 404");
    }
    return { conversations: [{ conversation_id: "123456789" }] };
  });

  assert.equal(await resolvePrivateConversationRouteId(client, routes, "cnv_legacy"), "123456789");
  assert.deepEqual(requests, [routes.appLink("/open/cnv_legacy"), routes.searchRaw("cnv_legacy")]);
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
