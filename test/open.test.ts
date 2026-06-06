import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { buildOpenTargets, openConversation } from "../src/commands/open.js";
import { makeFakeFrontInstall, makeTempDir } from "./helpers.js";

test("buildOpenTargets preserves origin and encodes conversation ids", () => {
  const targets = buildOpenTargets({
    origin: "https://residesk.frontapp.com",
    cell: "cell-abc",
    companyId: "32390a17805cd26f7349",
    teamId: "6088721",
  }, "abc 123");

  assert.equal(
    targets.appUrl,
    "https://residesk.frontapp.com/open/cell-abc/api/1/companies/32390a17805cd26f7349/conversations/abc%20123",
  );
  assert.equal(
    targets.deeplink,
    "frontapp:/go/cell-abc/api/1/companies/32390a17805cd26f7349/conversations/abc%20123",
  );
});

test("openConversation can launch deeplink through injected launcher", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-open-launch"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const launched: string[] = [];

  const result = await openConversation(["93727705553"], paths, async (target) => {
    launched.push(target);
  }) as { opened: boolean; target: string; deeplink: string };

  assert.equal(result.opened, true);
  assert.equal(result.target, result.deeplink);
  assert.deepEqual(launched, [result.deeplink]);
});

test("openConversation can launch web URL through injected launcher", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-open-web-launch"));
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://residesk.frontapp.com/cell-abc/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  const launched: string[] = [];

  const result = await openConversation(["93727705553", "--web"], paths, async (target) => {
    launched.push(target);
  }) as { opened: boolean; target: string; appUrl: string };

  assert.equal(result.opened, true);
  assert.equal(result.target, result.appUrl);
  assert.match(result.appUrl, /^https:\/\/residesk\.frontapp\.com\/open\//);
  assert.deepEqual(launched, [result.appUrl]);
});
