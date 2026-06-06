import { strict as assert } from "node:assert";
import test from "node:test";
import { inspectFront } from "../src/commands/front.js";
import { makeFakeFrontInstall, makeTempDir } from "./helpers.js";

test("inspectFront reads bundle metadata and schemes", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-front"));
  const result = await inspectFront(paths);

  assert.equal(result.bundleIdentifier, "com.frontapp.Front");
  assert.equal(result.displayName, "Front");
  assert.equal(result.version, "9.9.9-test");
  assert.equal(result.build, "999");
  assert.deepEqual(result.urlTypes, [
    {
      CFBundleURLName: "Open",
      CFBundleURLSchemes: ["front", "frontapp"],
    },
  ]);
});
