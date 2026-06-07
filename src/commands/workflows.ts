import { CliError } from "../lib/cli.js";
import { normalizeConversation } from "../lib/frontCache.js";
import { createFrontPrivateClient } from "../lib/frontPrivate.js";
import { buildFrontRoutes } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildWorkflowReport, type WorkflowRow } from "../lib/workflows.js";

export async function workflowsCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
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
    const currentOpenRows = rest.includes("--local-only")
      ? undefined
      : await readCurrentOpenRows(paths).catch(() => undefined);
    return buildWorkflowReport({
      months: readNumberFlag(rest, "--months") ?? 6,
      limit: readNumberFlag(rest, "--limit") ?? 8,
      actor: readStringFlag(rest, "--actor") ?? process.env.FRONTCTL_ACTOR_NAME ?? "frontctl agent",
      memoryPath: readStringFlag(rest, "--memory"),
      dbPath: readStringFlag(rest, "--store"),
      currentOpenRows,
    });
  }

  throw new CliError("Usage: frontctl workflows list|daily [--months 6] [--limit 8] [--actor NAME] [--local-only] [--json]", 64);
}

async function readCurrentOpenRows(paths: FrontPaths): Promise<WorkflowRow[]> {
  const client = await createFrontPrivateClient(paths);
  const routes = buildFrontRoutes(client.context);
  const data = await client.getJson<Record<string, unknown>>(routes.inbox);
  const raw = Array.isArray(data.conversations) ? data.conversations : [];
  return raw
    .map(normalizeConversation)
    .filter((conversation): conversation is NonNullable<typeof conversation> => Boolean(conversation))
    .map((conversation) => ({
      id: conversation.id,
      subject: conversation.subject,
      status: conversation.status,
      messageType: conversation.messageType,
      contact: conversation.contact,
      summary: conversation.summary,
      bumpedAt: conversation.bumpedAt,
      updatedAt: conversation.updatedAt,
      numMessages: conversation.numMessages,
      hasAttachments: conversation.hasAttachments,
    }));
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
