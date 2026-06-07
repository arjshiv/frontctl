import { CliError } from "../lib/cli.js";
import { buildWorkflowReport } from "../lib/workflows.js";

export async function workflowsCommand(args: string[]) {
  const [subcommand = "daily", ...rest] = args;
  if (subcommand === "list") {
    return {
      source: "local-workflows",
      publicApiUsed: false,
      workflows: [
        {
          id: "daily-triage",
          command: "frontctl workflows daily --json",
          goal: "Show what deserves attention before touching state.",
        },
        {
          id: "noise-review",
          command: "frontctl workflows daily --json",
          goal: "Preview obvious archive candidates without hiding anything automatically.",
        },
        {
          id: "follow-up",
          command: "frontctl workflows daily --json",
          goal: "Keep multi-message, attachment, and scheduling threads moving.",
        },
        {
          id: "tag-hygiene",
          command: "frontctl workflows daily --json",
          goal: "Suggest where durable tags would reduce future search and triage work.",
        },
        {
          id: "ops-risk",
          command: "frontctl workflows daily --json",
          goal: "Separate alerts that should be reviewed from routine archive noise.",
        },
      ],
      note: "The product surface is intentionally one daily workflow report with focused queues, not separate automations.",
    };
  }

  if (subcommand === "daily") {
    return buildWorkflowReport({
      months: readNumberFlag(rest, "--months") ?? 6,
      limit: readNumberFlag(rest, "--limit") ?? 8,
      actor: readStringFlag(rest, "--actor") ?? process.env.FRONTCTL_ACTOR_NAME ?? "frontctl agent",
      memoryPath: readStringFlag(rest, "--memory"),
      dbPath: readStringFlag(rest, "--store"),
    });
  }

  throw new CliError("Usage: frontctl workflows list|daily [--months 6] [--limit 8] [--actor NAME] [--json]", 64);
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
