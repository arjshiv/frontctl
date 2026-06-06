import { strict as assert } from "node:assert";
import test from "node:test";
import {
  checkFrontSession,
  decryptChromiumCookieValue,
  encryptChromiumCookieValueForTest,
  sessionSecurityStatus,
  unlockFrontSession,
} from "../src/lib/auth.js";
import { authCommand } from "../src/commands/auth.js";
import { makeTempDir, writeFakeFrontSession } from "./helpers.js";
import { join } from "node:path";

test("decryptChromiumCookieValue strips Chromium host digest prefix", () => {
  const password = "test-keychain-secret";
  const host = "app.frontapp.com";
  const encrypted = encryptChromiumCookieValueForTest("front-session-cookie", password, host);

  const decrypted = decryptChromiumCookieValue(encrypted, password, host);

  assert.equal(decrypted, "front-session-cookie");
});

test("checkFrontSession does not touch Keychain and reports missing session", async () => {
  const sessionPath = join(await makeTempDir("frontctl-auth-status"), "session.json");

  const status = await checkFrontSession(sessionPath);

  assert.equal(status.exists, false);
  assert.equal(status.valid, false);
  assert.equal(status.security.authorizationModel, "one-time-keychain-unlock");
  assert.equal(status.security.promptsOnCheck, false);
  assert.equal(status.security.promptsOnLiveRead, false);
  assert.equal(status.security.promptsOnUnlock, true);
  assert.match(status.note, /auth unlock/);
});

test("auth security exposes the one-time unlock model", async () => {
  const direct = sessionSecurityStatus();
  const command = await authCommand(["security"]);

  assert.deepEqual(command, direct);
  assert.equal(direct.keychainService, "Front Safe Storage");
  assert.equal(direct.keychainBackedSessionKey, false);
  assert.match(direct.note, /normal status\/live-read commands do not access Keychain/);
});

test("unlockFrontSession reuses a valid session without reading cookies or Keychain", async () => {
  const root = await makeTempDir("frontctl-auth-reuse");
  const sessionPath = join(root, "session.json");
  await writeFakeFrontSession(sessionPath);

  const status = await unlockFrontSession(join(root, "missing-cookies.sqlite"), { sessionPath });

  assert.equal(status.exists, true);
  assert.equal(status.valid, true);
  assert.equal(status.unlocked, true);
  assert.equal(status.keychainAccessed, false);
  assert.equal(status.reusedExisting, true);
  assert.equal(status.security.promptsOnCheck, false);
  assert.match(status.note, /Keychain was not accessed/);
});
