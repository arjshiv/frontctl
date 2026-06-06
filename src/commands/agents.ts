import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../lib/cli.js";

export type AgentKind = "codex" | "claude";
export type PromptAgentKind = AgentKind | "chatgpt";

const SKILL_RELATIVE_PATHS: Record<AgentKind, string> = {
  codex: "skills/codex/frontctl/SKILL.md",
  claude: "skills/claude/frontctl/SKILL.md",
};

const PROMPT_RELATIVE_PATHS: Record<PromptAgentKind, string> = {
  codex: "skills/codex/frontctl/SKILL.md",
  claude: "skills/claude/frontctl/SKILL.md",
  chatgpt: "skills/chatgpt/frontctl/INSTRUCTIONS.md",
};

export async function agentsCommand(args: string[]) {
  const [subcommand] = args;

  if (!subcommand || subcommand === "check" || subcommand === "status") {
    return agentsStatus(readAgentFlag(args));
  }

  if (subcommand === "path" || subcommand === "paths") {
    return agentsPaths(readAgentFlag(args));
  }

  if (subcommand === "prompt" || subcommand === "prompts") {
    return agentPrompts(readPromptAgentFlag(args));
  }

  if (subcommand === "install") {
    const agent = readAgentFlag(args);
    if (!agent) {
      throw new CliError("Usage: frontctl agents install --agent codex|claude|all [--yes]", 64);
    }
    return installAgentSkills(agent, { write: args.includes("--yes") });
  }

  throw new CliError("Usage: frontctl agents check|paths|prompt|install --agent codex|claude|chatgpt|all", 64);
}

export async function agentsStatus(agent: AgentKind | "all" | undefined) {
  const targets = agentTargets(agent);
  const skills = await Promise.all(targets.map(async (target) => {
    const sourceExists = Boolean(await stat(target.sourcePath).catch(() => undefined));
    const installed = Boolean(await stat(target.destinationPath).catch(() => undefined));
    return {
      agent: target.agent,
      sourcePath: target.sourcePath,
      destinationPath: target.destinationPath,
      sourceExists,
      installed,
      installCommand: `frontctl agents install --agent ${target.agent} --yes --json`,
    };
  }));
  return {
    count: skills.length,
    allInstalled: skills.every((skill) => skill.installed),
    skills,
  };
}

function agentsPaths(agent: AgentKind | "all" | undefined) {
  const targets = agentTargets(agent);
  return {
    count: targets.length,
    skills: targets.map((target) => ({
      agent: target.agent,
      sourcePath: target.sourcePath,
      destinationPath: target.destinationPath,
    })),
  };
}

async function agentPrompts(agent: PromptAgentKind | "all" | undefined) {
  const targets = promptTargets(agent);
  const prompts = await Promise.all(targets.map(async (target) => ({
    agent: target.agent,
    sourcePath: target.sourcePath,
    installable: target.agent === "codex" || target.agent === "claude",
    prompt: await readFile(target.sourcePath, "utf8"),
    note: target.agent === "chatgpt"
      ? "Paste these instructions into ChatGPT. ChatGPT must have local terminal or Codex-style command execution access to use frontctl."
      : "This is also available as an installable local skill.",
  })));
  return {
    count: prompts.length,
    prompts,
  };
}

export async function installAgentSkills(agent: AgentKind | "all", options: { write: boolean }) {
  const targets = agentTargets(agent);
  const installed = [];
  for (const target of targets) {
    if (options.write) {
      await mkdir(dirname(target.destinationPath), { recursive: true, mode: 0o700 });
      await copyFile(target.sourcePath, target.destinationPath);
    }
    installed.push({
      agent: target.agent,
      sourcePath: target.sourcePath,
      destinationPath: target.destinationPath,
      installed: options.write,
      note: options.write ? "Skill copied." : "Dry run. Re-run with --yes to copy this skill.",
    });
  }
  return {
    installed: options.write,
    count: installed.length,
    skills: installed,
  };
}

function readAgentFlag(args: string[]): AgentKind | "all" | undefined {
  const index = args.indexOf("--agent");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === "codex" || value === "claude" || value === "all") {
    return value;
  }
  return undefined;
}

function readPromptAgentFlag(args: string[]): PromptAgentKind | "all" | undefined {
  const index = args.indexOf("--agent");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === "codex" || value === "claude" || value === "chatgpt" || value === "all") {
    return value;
  }
  return undefined;
}

function agentTargets(agent: AgentKind | "all" | undefined) {
  const kinds: AgentKind[] = agent && agent !== "all" ? [agent] : ["codex", "claude"];
  return kinds.map((kind) => ({
    agent: kind,
    sourcePath: skillSourcePath(kind),
    destinationPath: defaultSkillDestination(kind),
  }));
}

function skillSourcePath(agent: AgentKind) {
  return resolve(projectRoot(), SKILL_RELATIVE_PATHS[agent]);
}

function promptTargets(agent: PromptAgentKind | "all" | undefined) {
  const kinds: PromptAgentKind[] = agent && agent !== "all" ? [agent] : ["codex", "claude", "chatgpt"];
  return kinds.map((kind) => ({
    agent: kind,
    sourcePath: resolve(projectRoot(), PROMPT_RELATIVE_PATHS[kind]),
  }));
}

function defaultSkillDestination(agent: AgentKind) {
  if (agent === "codex") {
    return join(homedir(), ".codex", "skills", "frontctl", "SKILL.md");
  }
  return join(homedir(), ".claude", "skills", "frontctl", "SKILL.md");
}

function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}
