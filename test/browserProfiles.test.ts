import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { detectDefaultBrowser, listBrowserProfiles, resolveBrowserProfile } from "../src/lib/browserProfiles.js";
import { makeTempDir } from "./helpers.js";

test("detectDefaultBrowser honors explicit browser override", () => {
  assert.deepEqual(detectDefaultBrowser({ FRONTCTL_DEFAULT_BROWSER: "edge" } as any), {
    browser: "edge",
    bundleId: "com.microsoft.edgemac",
    source: "env",
  });
});

test("listBrowserProfiles discovers Chromium cookie stores without reading cookie values", async () => {
  const root = await makeTempDir("frontctl-browser-profiles");
  const chromeRoot = join(root, "Chrome");
  const edgeRoot = join(root, "Edge");
  await mkdir(join(chromeRoot, "Default", "Network"), { recursive: true });
  await mkdir(join(edgeRoot, "Default"), { recursive: true });
  await writeFile(join(chromeRoot, "Default", "Network", "Cookies"), "SECRET_COOKIE_DB");
  await writeFile(join(edgeRoot, "Default", "Cookies"), "SECRET_EDGE_COOKIE_DB");

  const profiles = listBrowserProfiles({
    FRONTCTL_CHROME_USER_DATA_DIR: chromeRoot,
    FRONTCTL_EDGE_USER_DATA_DIR: edgeRoot,
  } as any);

  assert.deepEqual(
    profiles.map((profile) => ({
      browser: profile.browser,
      profile: profile.profile,
      cookiesExists: profile.cookiesExists,
      keychainService: profile.keychainService,
    })),
    [
      {
        browser: "chrome",
        profile: "Default",
        cookiesExists: true,
        keychainService: "Chrome Safe Storage",
      },
      {
        browser: "edge",
        profile: "Default",
        cookiesExists: true,
        keychainService: "Microsoft Edge Safe Storage",
      },
    ],
  );
  assert.doesNotMatch(JSON.stringify(profiles), /SECRET_COOKIE_DB|SECRET_EDGE_COOKIE_DB/);
});

test("resolveBrowserProfile prefers requested profile then falls back to Default", async () => {
  const root = await makeTempDir("frontctl-browser-resolve");
  await mkdir(join(root, "Default"), { recursive: true });
  await writeFile(join(root, "Default", "Cookies"), "");

  const profile = resolveBrowserProfile("edge", "Missing", {
    FRONTCTL_EDGE_USER_DATA_DIR: root,
  } as any);

  assert.equal(profile?.browser, "edge");
  assert.equal(profile?.profile, "Default");
  assert.equal(profile?.cookiesExists, true);
});

