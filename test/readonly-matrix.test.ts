import { execFile } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { makeFakeFrontInstall, makeTempDir, writeFakeFrontCacheFixture } from "./helpers.js";
import type { FrontPaths } from "../src/lib/paths.js";

const execFileAsync = promisify(execFile);
const SECRET_PATTERN =
  /SECRET_COOKIE_VALUE|SECRET_SIG_VALUE|SECRET_CACHE_TOKEN|SECRET_ATTACHMENT_TOKEN|access_token|signed\.example|front\.id=test|front\.id\.sig=test/i;

test("read-only CLI matrix stays JSON-safe and secret-free", async () => {
  const paths = await makeFakeFrontInstall(await makeTempDir("frontctl-readonly-matrix"));
  await writeFakeFrontCacheFixture(paths);
  await writeFile(
    join(paths.cacheDataPath, "route-cache"),
    "https://app.frontapp.com/cell-00017/api/1/companies/32390a17805cd26f7349/team/6088721/conversations/inbox",
  );
  await writeFile(
    join(paths.cacheDataPath, "tags-cache"),
    JSON.stringify({
      tags: [
        { id: "tag-1", alias: "needs-reply", name: "Needs Reply", email: "secret@example.com" },
        { id: "tag-2", alias: "vip", name: "VIP" },
      ],
    }),
  );
  await mkdir(paths.indexedDbLevelDbPath, { recursive: true });
  await writeFile(
    join(paths.indexedDbLevelDbPath, "000001.ldb"),
    `draft-reply /cell-00017/api/1/companies/32390a17805cd26f7349/conversations/93727705553/messages/abc123def456 blurb"Readonly matrix draft body" DRAFT`,
  );

  const env = envForPaths(paths);
  const staticCommands = [
    ["doctor", "--json"],
    ["readiness", "--json"],
    ["auth", "check", "--json"],
    ["auth", "security", "--json"],
    ["browser", "list", "--json"],
    ["browser", "inspect", "--browser", "edge", "--json"],
    ["front", "inspect", "--json"],
    ["cookies", "inspect", "--json"],
    ["asar", "inspect", "--json"],
    ["onboarding", "--json"],
    ["agents", "check", "--json"],
    ["inbox", "list", "--offline-cache", "--limit", "2", "--json"],
    ["inbox", "list", "--offline-cache", "--all", "--json"],
    ["triage", "inbox", "--offline-cache", "--all", "--json"],
    ["search", "Deel", "--offline-cache", "--json"],
    ["read", "93727705553", "--offline-cache", "--json"],
    ["summarize", "93727705553", "--offline-cache", "--json"],
    ["attachments", "list", "93727705553", "--offline-cache", "--json"],
    ["open", "93727705553", "--print-only", "--json"],
    ["tag", "list", "--json"],
    ["draft", "list", "--limit", "5", "--json"],
    ["sync", "--offline-cache", "--limit", "10", "--json"],
    ["memory", "report", "--fresh", "--json"],
    ["workflows", "list", "--json"],
    ["workflows", "daily", "--actor", "Codex", "--json"],
    ["cache", "stats", "--json"],
    ["cache", "search", "Deel", "--json"],
    ["cache", "read", "93727705553", "--json"],
  ];

  let draftId: string | undefined;
  for (const args of staticCommands) {
    const json = await runJson(args, env);
    if (args.join(" ") === "draft list --limit 5 --json") {
      draftId = json.drafts?.[0]?.id;
      assert.equal(typeof draftId, "string");
    }
  }

  assert.ok(draftId, "draft list should expose a draft id for the read-only read command");
  await runJson(["draft", "read", draftId, "--json"], env);
});

async function runJson(args: string[], env: NodeJS.ProcessEnv) {
  const { stdout, stderr } = await execFileAsync("node", ["dist/src/cli.js", ...args], { env });
  const combined = `${stdout}\n${stderr}`;
  assert.doesNotMatch(combined, SECRET_PATTERN, `secret leaked while running frontctl ${args.join(" ")}`);
  assert.doesNotMatch(combined, /"sendsEmail"\s*:\s*true/, `send flag appeared while running frontctl ${args.join(" ")}`);
  assert.doesNotMatch(combined, /"publicApiUsed"\s*:\s*true/, `public API flag appeared while running frontctl ${args.join(" ")}`);

  const parsed = JSON.parse(stdout);
  if ("publicApiUsed" in parsed) {
    assert.equal(parsed.publicApiUsed, false, `publicApiUsed must be false for frontctl ${args.join(" ")}`);
  }
  if ("sendsEmail" in parsed) {
    assert.equal(parsed.sendsEmail, false, `sendsEmail must be false for frontctl ${args.join(" ")}`);
  }
  if (parsed.safety?.publicApiUsed !== undefined) {
    assert.equal(parsed.safety.publicApiUsed, false, `safety.publicApiUsed must be false for frontctl ${args.join(" ")}`);
  }
  if (parsed.safety?.sendsEmail !== undefined) {
    assert.equal(parsed.safety.sendsEmail, false, `safety.sendsEmail must be false for frontctl ${args.join(" ")}`);
  }
  return parsed;
}

function envForPaths(paths: FrontPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: paths.supportPath,
    USERPROFILE: paths.supportPath,
    FRONTCTL_FRONT_APP_PATH: paths.appPath,
    FRONTCTL_FRONT_SUPPORT_PATH: paths.supportPath,
    FRONTCTL_FRONT_INFO_PLIST_PATH: paths.infoPlistPath,
    FRONTCTL_FRONT_ASAR_PATH: paths.asarPath,
    FRONTCTL_FRONT_COOKIES_PATH: paths.cookiesPath,
    FRONTCTL_FRONT_CACHE_DATA_PATH: paths.cacheDataPath,
    FRONTCTL_FRONT_LOCAL_STORAGE_PATH: paths.localStorageLevelDbPath,
    FRONTCTL_FRONT_INDEXED_DB_PATH: paths.indexedDbLevelDbPath,
    FRONTCTL_FRONT_PREFERENCES_PATH: paths.preferencesPath,
    FRONTCTL_SESSION_PATH: join(paths.supportPath, "frontctl-session.json"),
    FRONTCTL_STORE_PATH: join(paths.supportPath, "frontctl.sqlite"),
    FRONTCTL_MEMORY_PATH: join(paths.supportPath, "memory.json"),
    FRONTCTL_AUDIT_PATH: join(paths.supportPath, "audit.jsonl"),
    FRONTCTL_DISCOVERY_FIXTURES_PATH: join(paths.supportPath, "discovery-fixtures"),
  };
}
