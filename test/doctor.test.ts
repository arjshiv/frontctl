import { strict as assert } from "node:assert";
import test from "node:test";
import { doctor } from "../src/commands/doctor.js";
import { pathStatus } from "../src/lib/fsInfo.js";
import { makeFakeFrontInstall, makeTempDir } from "./helpers.js";

test("doctor reports ok for a complete fake Front install", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-doctor"));
  const result = await doctor(paths);

  assert.equal(result.ok, true);
  assert.equal(result.front.bundleIdentifier, "com.frontapp.Front");
  assert.equal(result.front.version, "9.9.9-test");
  assert.deepEqual(result.front.urlSchemes, ["front", "frontapp"]);
  assert.equal(result.safety.publicApiUsed, false);
  assert.equal(result.safety.sendsEmail, false);
  assert.equal(result.onboarding.readyForAgentUse, true);
});

test("doctor reports not ok when core paths are absent", async () => {
  const root = await makeTempDir("frontctl-doctor-missing");
  const paths = await makeFakeFrontInstall(root);
  paths.cookiesPath = `${paths.cookiesPath}.missing`;

  const result = await doctor(paths);
  assert.equal(result.ok, false);
  assert.equal(result.statuses.cookies.exists, false);
  assert.equal(result.onboarding.readyForAgentUse, false);
});

test("pathStatus distinguishes missing paths", async () => {
  const status = await pathStatus("/definitely/not/a/frontctl/path");
  assert.equal(status.exists, false);
  assert.equal(status.readable, false);
});
