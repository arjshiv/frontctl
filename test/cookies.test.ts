import { strict as assert } from "node:assert";
import test from "node:test";
import { inspectCookieInventory } from "../src/lib/cookies.js";
import { makeCookieDb, makeTempDir } from "./helpers.js";
import { join } from "node:path";

test("inspectCookieInventory returns only Front cookie metadata", async () => {
  const cookiesPath = join(await makeTempDir("frontctl-cookies"), "Cookies");
  await makeCookieDb(cookiesPath);

  const result = await inspectCookieInventory(cookiesPath);
  assert.equal(result.temporaryCopyRemoved, true);
  assert.equal(result.frontCookieCount, 2);
  assert.deepEqual(
    result.cookies.map((cookie) => cookie.name),
    ["front.id", "front.id.sig"],
  );
  assert.equal(result.cookies[0]?.httpOnly, true);
  assert.equal(result.cookies[0]?.secure, true);
  assert.equal(result.cookies[0]?.hasEncryptedValue, true);
});

test("inspectCookieInventory never returns cookie values", async () => {
  const cookiesPath = join(await makeTempDir("frontctl-cookies-redaction"), "Cookies");
  await makeCookieDb(cookiesPath);

  const serialized = JSON.stringify(await inspectCookieInventory(cookiesPath));
  assert.doesNotMatch(serialized, /SECRET_COOKIE_VALUE/);
  assert.doesNotMatch(serialized, /SECRET_SIG_VALUE/);
  assert.doesNotMatch(serialized, /NOPE/);
});
