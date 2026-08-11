import { strict as assert } from "node:assert";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildFrontRoutes,
  discoverFrontRouteBaseContext,
  discoverFrontRouteContext,
  discoverFrontTeamId,
  discoverLocalFrontRouteContext,
  readPersistedFrontRouteContext,
  writePersistedFrontRouteContext,
} from "../src/lib/frontRoutes.js";
import { makeFakeFrontInstall, makeTempDir } from "./helpers.js";

test("discoverFrontRouteContext reads sanitized private route context from cache metadata", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-routes"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox?secret=NOPE",
  );

  const context = await discoverFrontRouteContext(paths.cacheDataPath);

  assert.deepEqual(context, {
    origin: "https://app.frontapp.com",
    cell: "cell-00017",
    companyId: "32390a17805cd26f7349",
    teamId: "6088721",
  });
});

test("discoverFrontRouteContext preserves company Front subdomains", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-routes-subdomain"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://residesk.frontapp.com/cell-abc/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/done?secret=NOPE",
  );

  const context = await discoverFrontRouteContext(paths.cacheDataPath);

  assert.equal(context?.origin, "https://residesk.frontapp.com");
  assert.equal(context?.cell, "cell-abc");
  assert.equal(context?.companyId, "32390a17805cd26f7349");
  assert.equal(context?.teamId, "6088721");
});

test("current direct conversation routes expose stable workspace context", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-routes-direct"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/conversations/97217720401",
  );
  await writeFile(join(paths.localStorageLevelDbPath, "000003.log"), "user namespace tea:6088721");

  assert.deepEqual(await discoverFrontRouteBaseContext(paths.cacheDataPath), {
    origin: "https://app.frontapp.com",
    cell: "cell-00017",
    companyId: "32390a17805cd26f7349",
  });
  assert.equal(await discoverFrontTeamId(paths.localStorageLevelDbPath), "6088721");

  await withRouteContextPath(join(paths.supportPath, "route-context.json"), async () => {
    assert.deepEqual(await discoverLocalFrontRouteContext(paths), {
      origin: "https://app.frontapp.com",
      cell: "cell-00017",
      companyId: "32390a17805cd26f7349",
      teamId: "6088721",
    });
  });
});

test("validated route context survives transient Front cache eviction", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-routes-persisted"));
  const contextPath = join(paths.supportPath, "route-context.json");
  const context = {
    origin: "https://residesk.frontapp.com",
    cell: "cell-abc",
    companyId: "32390a17805cd26f7349",
    teamId: "6088721",
  };

  await withRouteContextPath(contextPath, async () => {
    await writePersistedFrontRouteContext(context);
    assert.deepEqual(await readPersistedFrontRouteContext(), context);
    assert.deepEqual(await discoverLocalFrontRouteContext(paths), context);
    assert.equal((await stat(contextPath)).mode & 0o777, 0o600);
  });
});

test("a persisted context from another workspace is not reused for current cache routes", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-routes-workspace-switch"));
  const contextPath = join(paths.supportPath, "route-context.json");
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-current/api/1/companies/abcdef123456/conversations/123",
  );

  await withRouteContextPath(contextPath, async () => {
    await writePersistedFrontRouteContext({
      origin: "https://app.frontapp.com",
      cell: "cell-old",
      companyId: "fedcba654321",
      teamId: "6088721",
    });
    assert.equal(await discoverLocalFrontRouteContext(paths), undefined);
  });
});


test("buildFrontRoutes creates private app routes without public API paths", () => {
  const routes = buildFrontRoutes({
    origin: "https://app.frontapp.com",
    cell: "cell-00017",
    companyId: "company",
    teamId: "team",
  });

  assert.equal(routes.boot, "https://app.frontapp.com/cell-00017/api/1/companies/company/boot/app/8");
  assert.equal(routes.inbox, "https://app.frontapp.com/cell-00017/api/1/companies/company/team/team/conversations/inbox");
  assert.equal(routes.conversation("abc 123"), "https://app.frontapp.com/cell-00017/api/1/companies/company/conversations/abc%20123");
  assert.equal(routes.appLink("/open/cnv_123"), "https://app.frontapp.com/cell-00017/api/1/companies/company/app_link?link=%2Fopen%2Fcnv_123");
  assert.equal(routes.message("abc 123"), "https://app.frontapp.com/cell-00017/api/1/companies/company/messages/abc%20123");
  assert.equal(routes.conversationMessage("abc 123", "draft uid"), "https://app.frontapp.com/cell-00017/api/1/companies/company/conversations/abc%20123/messages/draft%20uid");
  assert.equal(routes.searchCards("Test@Example.com", 5), "https://app.frontapp.com/cell-00017/api/1/companies/company/search_card/test%40example.com?limit=5");
  assert.equal(routes.card("abc 123"), "https://app.frontapp.com/cell-00017/api/1/companies/company/cards/abc%20123");
  assert.doesNotMatch(routes.inbox, /api\.frontapp\.com/);
});

test("buildFrontRoutes does not expose send/finalize/deliver routes", () => {
  const routes = buildFrontRoutes({
    origin: "https://app.frontapp.com",
    cell: "cell-00017",
    companyId: "32390a17805cd26f7349",
    teamId: "6088721",
  });

  const routeSurface = [
    routes.boot,
    routes.inbox,
    routes.done,
    routes.conversation("123"),
    routes.timeline("123"),
    routes.content("123"),
    routes.appLink("/open/cnv_123"),
    routes.searchRaw("hello"),
    routes.searchHints("hello"),
    routes.searchCards("hello"),
    routes.conversations,
    routes.comments("123"),
    routes.comment("123", "comment-uid"),
    routes.commentTimeline("123", "comment-uid"),
    routes.timelineActivity("123", "activity-123"),
    routes.message("message-123"),
    routes.card("card-123"),
    routes.messages("123"),
    routes.conversationMessage("123", "message-123"),
  ].join("\n");

  assert.doesNotMatch(routeSurface, /\/(?:send|finalize|deliver)(?:\/|$)/i);
});

async function withRouteContextPath<T>(path: string, fn: () => Promise<T>) {
  const previous = process.env.FRONTCTL_ROUTE_CONTEXT_PATH;
  process.env.FRONTCTL_ROUTE_CONTEXT_PATH = path;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.FRONTCTL_ROUTE_CONTEXT_PATH;
    else process.env.FRONTCTL_ROUTE_CONTEXT_PATH = previous;
  }
}
