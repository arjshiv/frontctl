import { strict as assert } from "node:assert";
import { join } from "node:path";
import test from "node:test";
import { installAgentSkills } from "../src/commands/agents.js";
import { readinessCommand } from "../src/commands/readiness.js";
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
    assert.match(result.nextCommand, /triage inbox --live/);
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

async function withHome<T>(home: string, fn: () => Promise<T>) {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousSessionPath = process.env.FRONTCTL_SESSION_PATH;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousSessionPath === undefined) delete process.env.FRONTCTL_SESSION_PATH;
    else process.env.FRONTCTL_SESSION_PATH = previousSessionPath;
  }
}
