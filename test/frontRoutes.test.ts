import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildFrontRoutes, discoverFrontRouteContext } from "../src/lib/frontRoutes.js";
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
  assert.equal(routes.message("abc 123"), "https://app.frontapp.com/cell-00017/api/1/companies/company/messages/abc%20123");
  assert.equal(routes.conversationMessage("abc 123", "draft uid"), "https://app.frontapp.com/cell-00017/api/1/companies/company/conversations/abc%20123/messages/draft%20uid");
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
    routes.searchRaw("hello"),
    routes.searchHints("hello"),
    routes.conversations,
    routes.comments("123"),
    routes.comment("123", "comment-uid"),
    routes.commentTimeline("123", "comment-uid"),
    routes.timelineActivity("123", "activity-123"),
    routes.message("message-123"),
    routes.messages("123"),
    routes.conversationMessage("123", "message-123"),
  ].join("\n");

  assert.doesNotMatch(routeSurface, /\/(?:send|finalize|deliver)(?:\/|$)/i);
});
