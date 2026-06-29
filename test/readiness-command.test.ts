import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { installAgentSkills } from "../src/commands/agents.js";
import { readinessCommand } from "../src/commands/readiness.js";
import { setupCommand } from "../src/commands/setup.js";
import { writeCdpBridgeProof } from "../src/lib/cdpBridge.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontSession } from "./helpers.js";

test("readinessCommand returns a concise ready report without touching Keychain", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-readiness-ready"));
  const home = await makeTempDir("frontctl-readiness-ready-home");
  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);
    await installAgentSkills("all", { write: true });
    const result = await readinessCommand([], paths) as any;

    assert.equal(result.ok, true);
    assert.equal(result.userReadiness.ready, true);
    assert.equal(result.userReadiness.state, "ready");
    assert.equal(result.front.appInstalled, true);
    assert.equal(result.auth.valid, true);
    assert.equal(result.auth.promptsOnCheck, false);
    assert.equal(result.auth.promptsOnLiveRead, false);
    assert.equal(result.safety.touchesKeychain, false);
    assert.match(result.nextCommand, /triage inbox --limit 20/);
  });
});

test("readinessCommand reports the first nontechnical next action", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-readiness-partial"));
  const home = await makeTempDir("frontctl-readiness-partial-home");
  paths.cookiesPath = `${paths.cookiesPath}.missing`;

  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    const result = await readinessCommand([], paths) as any;

    assert.equal(result.ok, false);
    assert.equal(result.userReadiness.state, "front-sign-in-missing");
    assert.match(result.userReadiness.nextAction, /sign in/i);
    assert.equal(result.front.appInstalled, true);
    assert.equal(result.front.localProfileVisible, false);
    assert.equal(result.auth.valid, false);
    assert.equal(result.nextCommand, "frontctl doctor --json");
  });
});

test("readinessCommand recommends long-lived browser unlock before browser launch", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-readiness-browser-unlock"));
  const home = await makeTempDir("frontctl-readiness-browser-unlock-home");

  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    await mkdir(join(home, "Edge", "Default"), { recursive: true });
    await writeFile(join(home, "Edge", "Default", "Cookies"), "fake-cookie-db");
    const result = await readinessCommand([], paths) as any;

    assert.equal(result.ok, false);
    assert.equal(result.userReadiness.state, "live-mode-locked");
    assert.match(result.userReadiness.nextAction, /Approve one live-session unlock/);
    assert.equal(result.authSources.recommendedUnlockCommand, "frontctl auth unlock --source default-browser --ttl-hours 720 --json");
    assert.equal(result.nextCommand, "frontctl auth unlock --source default-browser --ttl-hours 720 --json");
  });
});

test("readinessCommand recommends signed-in Front.app unlock before browser bridge launch", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-readiness-front-app-unlock"));
  const home = await makeTempDir("frontctl-readiness-front-app-unlock-home");

  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    const result = await readinessCommand([], paths) as any;

    assert.equal(result.ok, false);
    assert.equal(result.userReadiness.state, "live-mode-locked");
    assert.equal(result.front.localProfileVisible, true);
    assert.equal(result.authSources.explicitBrowserCookieFallbackAvailable, false);
    assert.equal(result.authSources.recommendedUnlockCommand, "frontctl auth unlock --source front-app --ttl-hours 720 --json");
    assert.equal(result.nextCommand, "frontctl auth unlock --source front-app --ttl-hours 720 --json");
  });
});

test("setup complete dry-run reports the one agent bootstrap action", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-setup-complete-dry-run"));
  const home = await makeTempDir("frontctl-setup-complete-dry-run-home");

  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    const result = await setupCommand(["complete", "--agent", "codex"], paths) as any;

    assert.equal(result.ok, true);
    assert.equal(result.mode, "dry-run");
    assert.equal(result.action, "setup.complete");
    assert.equal(result.wouldInstallAgentSkills, "codex");
    assert.match(result.executeCommand, /frontctl setup complete --agent codex --yes --json/);
    assert.match(result.note, /Dry run/);
  });
});

test("setup complete reuses existing CDP proof without unlocking cookies", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-setup-complete-cdp-proof"));
  const home = await makeTempDir("frontctl-setup-complete-cdp-proof-home");

  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    process.env.FRONTCTL_CDP_BRIDGE_PROOF_PATH = join(home, ".frontctl", "browser-bridge.json");
    await writeCdpBridgeProof({
      origin: "https://app.frontapp.com",
      cell: "cell-00017",
      companyId: "abcdef123456",
      teamId: "123",
    }, { ttlHours: 1 });

    const result = await setupCommand(["complete", "--agent", "codex", "--yes", "--no-learn"], paths) as any;

    assert.equal(result.action, "setup.complete");
    assert.equal(result.permissionPreflight.attempted, false);
    assert.equal(result.permissionPreflight.liveAlreadyAvailable, true);
    assert.equal(result.permissionPreflight.liveReadyAfter, true);
    assert.equal(result.permissionPreflight.authWasValidBefore, false);
    assert.equal(result.permissionPreflight.authValidAfter, false);
    assert.equal(result.unlock, undefined);
    assert.equal(result.agentInstall.installed, true);
    assert.equal(result.userReadiness.ready, true);
  });
});

test("setup complete installs skills and reports no future prompt contract when session already exists", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-setup-complete-ready"));
  const home = await makeTempDir("frontctl-setup-complete-ready-home");

  await withHome(home, async () => {
    process.env.FRONTCTL_SESSION_PATH = join(home, ".frontctl", "session.json");
    await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH);
    const result = await setupCommand(["complete", "--agent", "codex", "--yes", "--no-learn"], paths) as any;

    assert.equal(result.action, "setup.complete");
    assert.equal(result.permissionPreflight.attempted, false);
    assert.equal(result.permissionPreflight.authWasValidBefore, true);
    assert.equal(result.permissionPreflight.authValidAfter, true);
    assert.equal(result.permissionPreflight.noFuturePrompts, true);
    assert.equal(result.agentInstall.installed, true);
    assert.match(result.nextAgentPrompt, /frontctl ready --json/);
  });
});

async function withHome<T>(home: string, fn: () => Promise<T>) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  const previousChromeRoot = process.env.FRONTCTL_CHROME_USER_DATA_DIR;
  const previousEdgeRoot = process.env.FRONTCTL_EDGE_USER_DATA_DIR;
  const previousAgentcookiePath = process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
  const previousCdpProofPath = process.env.FRONTCTL_CDP_BRIDGE_PROOF_PATH;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.FRONTCTL_CHROME_USER_DATA_DIR = join(home, "Chrome");
  process.env.FRONTCTL_EDGE_USER_DATA_DIR = join(home, "Edge");
  process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = join(home, ".agentcookie", "cookies-plain.db");
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
    if (previousChromeRoot === undefined) delete process.env.FRONTCTL_CHROME_USER_DATA_DIR;
    else process.env.FRONTCTL_CHROME_USER_DATA_DIR = previousChromeRoot;
    if (previousEdgeRoot === undefined) delete process.env.FRONTCTL_EDGE_USER_DATA_DIR;
    else process.env.FRONTCTL_EDGE_USER_DATA_DIR = previousEdgeRoot;
    if (previousAgentcookiePath === undefined) delete process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH;
    else process.env.FRONTCTL_AGENTCOOKIE_COOKIES_PATH = previousAgentcookiePath;
    if (previousCdpProofPath === undefined) delete process.env.FRONTCTL_CDP_BRIDGE_PROOF_PATH;
    else process.env.FRONTCTL_CDP_BRIDGE_PROOF_PATH = previousCdpProofPath;
  }
}
