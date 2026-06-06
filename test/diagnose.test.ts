import { strict as assert } from "node:assert";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { diagnoseCommand, redactedDiagnosticBundle } from "../src/commands/diagnose.js";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontSession } from "./helpers.js";

test("diagnose returns a redacted support bundle", async () => {
  await withDiagnosticContext("frontctl-diagnose", async ({ paths, root }) => {
    await writeFakeFrontSession(process.env.FRONTCTL_SESSION_PATH as string);

    const result = await redactedDiagnosticBundle(paths);
    const serialized = JSON.stringify(result);

    assert.equal(result.redacted, true);
    assert.equal(result.publicApiUsed, false);
    assert.equal(result.sendsEmail, false);
    assert.equal(result.summary.ok, true);
    assert.equal(result.auth.valid, true);
    assert.equal(result.summary.userReady, false);
    assert.equal(result.summary.userReadinessState, "agent-skills-missing");
    assert.equal(result.userReadiness.gates.length, 4);
    assert.equal(result.auth.security.authorizationModel, "one-time-keychain-unlock");
    assert.equal(result.auth.security.promptsOnCheck, false);
    assert.equal(result.auth.security.promptsOnLiveRead, false);
    assert.equal(result.privacy.includesCookieValues, false);
    assert.doesNotMatch(serialized, /SECRET_COOKIE_VALUE|SECRET_SIG_VALUE|front\.id=test/);
    assert.match(result.storage.storePath, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("diagnose can write a 0600 redacted support file", async () => {
  await withDiagnosticContext("frontctl-diagnose-output", async ({ paths, root }) => {
    const output = join(root, "support", "frontctl-support.json");

    const result = await diagnoseCommand(["--output", output], paths) as any;
    const info = await stat(output);
    const written = JSON.parse(await readFile(output, "utf8"));

    assert.equal(result.outputPath, output);
    assert.equal(written.redacted, true);
    assert.equal((info.mode & 0o777), 0o600);
  });
});

async function withDiagnosticContext<T>(name: string, fn: (context: {
  paths: Awaited<ReturnType<typeof makeFakeFrontInstall>>;
  root: string;
}) => Promise<T>) {
  const previousHome = process.env.HOME;
  const root = await makeTempDir(name);
  process.env.HOME = root;
  process.env.FRONTCTL_SESSION_PATH = join(root, ".frontctl", "session.json");
  process.env.FRONTCTL_STORE_PATH = join(root, ".frontctl", "frontctl.sqlite");
  process.env.FRONTCTL_AUDIT_PATH = join(root, ".frontctl", "audit.jsonl");
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(root, ".frontctl", "discovery-fixtures");
  const paths = await makeFakeFrontInstall(join(root, "front"));
  try {
    return await fn({ paths, root });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.FRONTCTL_SESSION_PATH;
    delete process.env.FRONTCTL_STORE_PATH;
    delete process.env.FRONTCTL_AUDIT_PATH;
    delete process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH;
  }
}
