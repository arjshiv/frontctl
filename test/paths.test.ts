import { strict as assert } from "node:assert";
import test from "node:test";
import { defaultFrontPaths } from "../src/lib/paths.js";

test("defaultFrontPaths accepts environment overrides", () => {
  const paths = defaultFrontPaths({
    FRONTCTL_FRONT_APP_PATH: "/tmp/FakeFront.app",
    FRONTCTL_FRONT_SUPPORT_PATH: "/tmp/FakeSupport",
    FRONTCTL_FRONT_COOKIES_PATH: "/tmp/FakeCookies",
    FRONTCTL_FRONT_CACHE_DATA_PATH: "/tmp/FakeCacheData",
  });

  assert.equal(paths.appPath, "/tmp/FakeFront.app");
  assert.equal(paths.supportPath, "/tmp/FakeSupport");
  assert.equal(paths.cookiesPath, "/tmp/FakeCookies");
  assert.equal(paths.cacheDataPath, "/tmp/FakeCacheData");
  assert.equal(paths.infoPlistPath, "/tmp/FakeFront.app/Contents/Info.plist");
});
