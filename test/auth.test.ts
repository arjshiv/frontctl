import { strict as assert } from "node:assert";
import test from "node:test";
import {
  checkFrontSession,
  decryptChromiumCookieValue,
  encryptChromiumCookieValueForTest,
  readFrontSession,
  sessionSecurityStatus,
  unlockFrontSessionFromPlainCookies,
  unlockFrontSession,
} from "../src/lib/auth.js";
import { authCommand } from "../src/commands/auth.js";
import { makePlainCookieDb, makeTempDir, writeFakeFrontSession } from "./helpers.js";
import { join } from "node:path";
import { readAgentcookieFrontCookies } from "../src/lib/agentcookie.js";

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

test("auth unlock --source default-browser reuses valid cache before browser discovery", async () => {
  const root = await makeTempDir("frontctl-auth-command-reuse");
  const sessionPath = join(root, "session.json");
  await writeFakeFrontSession(sessionPath);
  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousDefaultBrowser = process.env.FRONTCTL_DEFAULT_BROWSER;
  process.env.FRONTCTL_SESSION_PATH = sessionPath;
  process.env.FRONTCTL_DEFAULT_BROWSER = "safari";
  try {
    const result = await authCommand(["unlock", "--source", "default-browser"]);

    assert.equal((result as any).valid, true);
    assert.equal((result as any).keychainAccessed, false);
    assert.equal((result as any).reusedExisting, true);
    assert.match((result as any).note, /Keychain was not accessed/);
  } finally {
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
    if (previousDefaultBrowser === undefined) delete process.env.FRONTCTL_DEFAULT_BROWSER;
    else process.env.FRONTCTL_DEFAULT_BROWSER = previousDefaultBrowser;
  }
});

test("unlockFrontSessionFromPlainCookies writes reusable browser/agentcookie session without Keychain", async () => {
  const root = await makeTempDir("frontctl-auth-plain");
  const sessionPath = join(root, "session.json");

  const result = await unlockFrontSessionFromPlainCookies([
    { host_key: "app.frontapp.com", name: "front.id", value: "SECRET_COOKIE_VALUE", expires_utc: 20000000000000000 },
    { host_key: "app.frontapp.com", name: "front.id.sig", value: "SECRET_SIG_VALUE", expires_utc: 20000000000000000 },
  ], { sessionPath, source: "agentcookie" });
  const session = await readFrontSession(sessionPath);

  assert.equal(result.valid, true);
  assert.equal(result.keychainAccessed, false);
  assert.equal(result.reusedExisting, false);
  assert.equal(result.source, "agentcookie");
  assert.equal(result.keychainServiceUsedForUnlock, undefined);
  assert.equal(session?.source, "agentcookie");
  assert.equal(session?.keychainServiceUsedForUnlock, undefined);
  assert.equal(session?.cookieHeader, "front.id=SECRET_COOKIE_VALUE; front.id.sig=SECRET_SIG_VALUE");
});

test("agentcookie plaintext cookie reader imports only Front cookies", async () => {
  const root = await makeTempDir("frontctl-agentcookie");
  const cookiePath = join(root, "cookies-plain.db");
  await makePlainCookieDb(cookiePath);

  const rows = await readAgentcookieFrontCookies(cookiePath);

  assert.deepEqual(rows.map((row) => row.name), ["front.id", "front.id.sig"]);
  assert.equal(rows.every((row) => row.host_key === "app.frontapp.com"), true);
});

test("auth unlock --source agentcookie uses plaintext cookie sidecar without Keychain", async () => {
  const root = await makeTempDir("frontctl-auth-agentcookie-command");
  const cookiePath = join(root, "cookies-plain.db");
  const sessionPath = join(root, "session.json");
  await makePlainCookieDb(cookiePath);
  const previousCookiePath = process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = cookiePath;
  process.env.FRONTCTL_SESSION_PATH = sessionPath;
  try {
    const result = await authCommand(["unlock", "--source", "agentcookie", "--force"]);

    assert.equal((result as any).valid, true);
    assert.equal((result as any).keychainAccessed, false);
    assert.equal((result as any).source, "agentcookie");
  } finally {
    if (previousCookiePath === undefined) delete process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
    else process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = previousCookiePath;
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
  }
});
