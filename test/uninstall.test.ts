import { strict as assert } from "node:assert";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { uninstallCommand } from "../src/commands/uninstall.js";
import { makeTempDir } from "./helpers.js";

test("uninstall is dry-run by default", async () => {
  await withUninstallContext("frontctl-uninstall-dry-run", async ({ root }) => {
    const sessionPath = process.env.FRONTCTL_SESSION_PATH as string;
    await mkdir(join(sessionPath, ".."), { recursive: true });
    await writeFile(sessionPath, "{}");

    const result = await uninstallCommand([]) as any;

    assert.equal(result.mode, "dry-run");
    assert.equal(result.removed, false);
    assert.ok(result.targets.some((target: { id: string }) => target.id === "session"));
    assert.ok(await stat(sessionPath));
    assert.match(JSON.stringify(result), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

test("uninstall --yes removes frontctl state and installed skills", async () => {
  await withUninstallContext("frontctl-uninstall-yes", async ({ root }) => {
    const sessionPath = process.env.FRONTCTL_SESSION_PATH as string;
    const codexSkillDir = join(root, ".codex", "skills", "frontctl");
    const claudeSkillDir = join(root, ".claude", "skills", "frontctl");
    await mkdir(join(sessionPath, ".."), { recursive: true });
    await mkdir(codexSkillDir, { recursive: true });
    await mkdir(claudeSkillDir, { recursive: true });
    await writeFile(sessionPath, "{}");
    await writeFile(join(codexSkillDir, "SKILL.md"), "codex");
    await writeFile(join(claudeSkillDir, "SKILL.md"), "claude");

    const result = await uninstallCommand(["--yes"]) as any;

    assert.equal(result.mode, "execute");
    assert.equal(result.removed, true);
    await assert.rejects(stat(sessionPath));
    await assert.rejects(stat(codexSkillDir));
    await assert.rejects(stat(claudeSkillDir));
  });
});

test("uninstall --keep-agents leaves local skills installed", async () => {
  await withUninstallContext("frontctl-uninstall-keep-agents", async ({ root }) => {
    const codexSkillDir = join(root, ".codex", "skills", "frontctl");
    await mkdir(codexSkillDir, { recursive: true });
    await writeFile(join(codexSkillDir, "SKILL.md"), "codex");

    const result = await uninstallCommand(["--yes", "--keep-agents"]) as any;

    assert.equal(result.mode, "execute");
    assert.ok(await stat(codexSkillDir));
  });
});

async function withUninstallContext<T>(name: string, fn: (context: { root: string }) => Promise<T>) {
  const previousHome = process.env.HOME;
  const root = await makeTempDir(name);
  process.env.HOME = root;
  process.env.FRONTCTL_SESSION_PATH = join(root, ".frontctl", "session.json");
  process.env.FRONTCTL_STORE_PATH = join(root, ".frontctl", "frontctl.sqlite");
  process.env.FRONTCTL_AUDIT_PATH = join(root, ".frontctl", "audit.jsonl");
  process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH = join(root, ".frontctl", "discovery-fixtures");
  try {
    return await fn({ root });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    delete process.env.FRONTCTL_SESSION_PATH;
    delete process.env.FRONTCTL_STORE_PATH;
    delete process.env.FRONTCTL_AUDIT_PATH;
    delete process.env.FRONTCTL_DISCOVERY_FIXTURES_PATH;
  }
}
