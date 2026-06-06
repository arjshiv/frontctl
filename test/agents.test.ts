import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { agentsCommand } from "../src/commands/agents.js";
import { makeTempDir } from "./helpers.js";

test("agents paths reports source and destination for both skills", async () => {
  const result = await withHome(async () => agentsCommand(["paths"])) as any;

  assert.equal(result.count, 2);
  assert.deepEqual(result.skills.map((skill: { agent: string }) => skill.agent), ["codex", "claude"]);
  assert.match(result.skills[0].sourcePath, /skills\/codex\/frontctl\/SKILL\.md$/);
  assert.match(result.skills[0].destinationPath, /\.codex\/skills\/frontctl\/SKILL\.md$/);
});

test("agents install is dry-run unless --yes is passed", async () => {
  const result = await withHome(async () => agentsCommand(["install", "--agent", "codex"])) as any;

  assert.equal(result.installed, false);
  assert.equal(result.skills[0].installed, false);
  assert.match(result.skills[0].note, /Dry run/);
});

test("agents install copies selected skill with --yes", async () => {
  const result = await withHome(async () => agentsCommand(["install", "--agent", "claude", "--yes"])) as any;

  assert.equal(result.installed, true);
  assert.equal(result.count, 1);
  assert.equal(result.skills[0].agent, "claude");
  const installed = await readFile(result.skills[0].destinationPath, "utf8");
  assert.match(installed, /^---\nname: frontctl/m);
  assert.match(installed, /Never send email/);
});

test("agents check reports installed status", async () => {
  const result = await withHome(async () => {
    await agentsCommand(["install", "--agent", "codex", "--yes"]);
    return agentsCommand(["check", "--agent", "codex"]);
  }) as any;

  assert.equal(result.count, 1);
  assert.equal(result.allInstalled, true);
  assert.equal(result.skills[0].installed, true);
});

test("agents prompt returns ChatGPT pasteable instructions without installing", async () => {
  const result = await withHome(async () => agentsCommand(["prompt", "--agent", "chatgpt"])) as any;

  assert.equal(result.count, 1);
  assert.equal(result.prompts[0].agent, "chatgpt");
  assert.equal(result.prompts[0].installable, false);
  assert.match(result.prompts[0].prompt, /local terminal or Codex-style command execution access/);
  assert.match(result.prompts[0].prompt, /Never use the public Front API/);
  assert.match(result.prompts[0].note, /Paste these instructions into ChatGPT/);
});

test("agents prompt all includes installable skills and ChatGPT instructions", async () => {
  const result = await withHome(async () => agentsCommand(["prompt", "--agent", "all"])) as any;

  assert.equal(result.count, 3);
  assert.deepEqual(result.prompts.map((prompt: { agent: string }) => prompt.agent), ["codex", "claude", "chatgpt"]);
  assert.deepEqual(result.prompts.map((prompt: { installable: boolean }) => prompt.installable), [true, true, false]);
});

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  process.env.HOME = await makeTempDir("frontctl-agents-home");
  try {
    return await fn();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
}
