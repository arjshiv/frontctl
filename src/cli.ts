#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { agentsCommand } from "./commands/agents.js";
import { inspectAsar } from "./commands/asar.js";
import { attachmentsCommand } from "./commands/attachments.js";
import { auditCommand } from "./commands/audit.js";
import { authCommand } from "./commands/auth.js";
import { batchCommand, bulkCommand } from "./commands/batch.js";
import { bridgeCommand } from "./commands/bridge.js";
import { browserCommand } from "./commands/browser.js";
import { cacheCommand } from "./commands/cache.js";
import { inspectCookies } from "./commands/cookies.js";
import { readConversation } from "./commands/conversation.js";
import { diagnoseCommand } from "./commands/diagnose.js";
import { discoveryCommand } from "./commands/discovery.js";
import { doctor } from "./commands/doctor.js";
import { inspectFront } from "./commands/front.js";
import { listInbox } from "./commands/inbox.js";
import { memoryCommand } from "./commands/memory.js";
import { mqCommand } from "./commands/mq.js";
import {
  archiveConversation,
  commentConversation,
  createTestConversation,
  customFieldConversation,
  deleteConversation,
  draftCommand,
  assignConversation,
  followerConversation,
  linkConversation,
  moveConversation,
  restoreConversation,
  snoozeConversation,
  tagConversation,
  unarchiveConversation,
  unsnoozeConversation,
} from "./commands/mutations.js";
import { onboarding } from "./commands/onboarding.js";
import { openConversation } from "./commands/open.js";
import { readinessCommand } from "./commands/readiness.js";
import { resourcesCommand } from "./commands/resources.js";
import { searchConversations } from "./commands/search.js";
import { setupCommand } from "./commands/setup.js";
import { summarizeCommand } from "./commands/summarize.js";
import { syncCommand } from "./commands/sync.js";
import { triageCommand } from "./commands/triage.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { unsupportedMutation } from "./commands/unsupported.js";
import { whoami } from "./commands/whoami.js";
import { workflowsCommand } from "./commands/workflows.js";
import { CliError, parseGlobalOptions, printResult } from "./lib/cli.js";

type CommandHandler = (args: string[]) => Promise<unknown>;

const commandTree: Record<string, CommandHandler | Record<string, CommandHandler>> = {
  version: async () => versionInfo(),
  doctor: async () => doctor(),
  asar: {
    inspect: async () => inspectAsar(),
  },
  cookies: {
    inspect: async () => inspectCookies(),
  },
  front: {
    inspect: async () => inspectFront(),
  },
  auth: authCommand,
  bridge: bridgeCommand,
  browser: browserCommand,
  audit: auditCommand,
  diagnose: diagnoseCommand,
  attachments: {
    list: async (args) => attachmentsCommand(["list", ...args]),
    read: async (args) => attachmentsCommand(["read", ...args]),
  },
  discovery: discoveryCommand,
  cache: cacheCommand,
  memory: memoryCommand,
  mq: mqCommand,
  whoami,
  resources: resourcesCommand,
  cards: async (args) => resourcesCommand(args[0] === "read" ? ["read-card", ...args.slice(1)] : args[0] === "search" ? ["search-cards", ...args.slice(1)] : args),
  card: async (args) => resourcesCommand(args[0] === "read" ? ["read-card", ...args.slice(1)] : ["read-card", ...args]),
  contacts: async (args) => resourcesCommand(args[0] === "search" ? args : ["list", "contacts", ...args]),
  accounts: async (args) => resourcesCommand(args[0] === "search" ? args : ["list", "accounts", ...args]),
  "custom-fields": async (args) => resourcesCommand(args[0] === "search" ? args : ["list", "custom-fields", ...args]),
  workflows: workflowsCommand,
  workflow: workflowsCommand,
  inbox: {
    list: listInbox,
  },
  conversation: {
    read: readConversation,
  },
  read: readConversation,
  summarize: summarizeCommand,
  summary: summarizeCommand,
  triage: triageCommand,
  search: searchConversations,
  batch: batchCommand,
  bulk: bulkCommand,
  sync: syncCommand,
  open: openConversation,
  archive: archiveConversation,
  unarchive: unarchiveConversation,
  delete: deleteConversation,
  restore: restoreConversation,
  "create-test-conversation": createTestConversation,
  assign: assignConversation,
  unassign: async (args) => assignConversation(["unassign", ...args]),
  move: moveConversation,
  follower: followerConversation,
  follow: followerConversation,
  link: linkConversation,
  "custom-field": customFieldConversation,
  snooze: snoozeConversation,
  unsnooze: unsnoozeConversation,
  tag: tagConversation,
  comment: commentConversation,
  draft: draftCommand,
  send: unsupportedMutation("send", "Sending is intentionally blocked by this project."),
  help: async () => usage(),
  onboarding,
  setup: setupCommand,
  ready: readinessCommand,
  act: async (args) => actCommand(args),
  readiness: readinessCommand,
  agents: agentsCommand,
  uninstall: uninstallCommand,
};

async function main(argv: string[]) {
  const { globals, rest } = parseGlobalOptions(argv);
  const [first, second, ...tail] = rest;

  if (first === "--version" || first === "-v") {
    console.log((await versionInfo()).version);
    return;
  }

  if (first === "--help" || first === "-h" || rest.includes("--help") || rest.includes("-h")) {
    printResult(usage(first && !first.startsWith("-") && first !== "help" ? first : undefined), globals);
    return;
  }

  if (!first) {
    printResult(usage(), globals);
    return;
  }

  const entry = commandTree[first];
  if (!entry) {
    throw new CliError(`Unknown command: ${first}`, 64);
  }

  if (typeof entry === "function") {
    printResult(await entry(commandArgs([second, ...tail].filter(Boolean), globals)), globals);
    return;
  }

  if (first === "inbox" && second !== "list") {
    printResult(await listInbox(commandArgs([second, ...tail].filter(Boolean), globals)), globals);
    return;
  }

  if (!second) {
    if (first === "inbox") {
      printResult(await listInbox(commandArgs(tail, globals)), globals);
      return;
    }
    throw new CliError(`Missing subcommand for: ${first}`, 64);
  }

  const subcommand = entry[second];
  if (!subcommand) {
    throw new CliError(`Unknown subcommand: ${first} ${second}`, 64);
  }

  printResult(await subcommand(commandArgs(tail, globals)), globals);
}

async function actCommand(args: string[]) {
  const [action, ...rest] = args;
  if (!action) {
    throw new CliError("Usage: frontctl act archive|unarchive|delete|restore|snooze|unsnooze|tag|comment|assign|unassign|move|follower|link|draft ...", 64);
  }
  if (action === "archive") return archiveConversation(rest);
  if (action === "unarchive") return unarchiveConversation(rest);
  if (action === "delete") return deleteConversation(rest);
  if (action === "restore") return restoreConversation(rest);
  if (action === "snooze") return snoozeConversation(rest);
  if (action === "unsnooze") return unsnoozeConversation(rest);
  if (action === "tag") return tagConversation(rest);
  if (action === "comment") return commentConversation(rest);
  if (action === "assign") return assignConversation(rest);
  if (action === "unassign") return assignConversation(["unassign", ...rest]);
  if (action === "move") return moveConversation(rest);
  if (action === "follower" || action === "follow") return followerConversation(rest);
  if (action === "link") return linkConversation(rest);
  if (action === "draft") return draftCommand(rest);
  throw new CliError(`Unknown action for frontctl act: ${action}`, 64);
}

function commandArgs(args: string[], globals: { dryRun: boolean }) {
  return globals.dryRun ? [...args, "--dry-run"] : args;
}

function usage(topic?: string) {
  return {
    name: "frontctl",
    purpose: "Local-session CLI for controlling Front without the public Front API. It exists so agents can manage personal Front inboxes that the public API cannot reach.",
    topic: topic ?? "overview",
    agentQuickStart: [
      "Run `frontctl doctor --json` to confirm Front is installed or a signed-in browser is available.",
      "Run `frontctl ready --json` before reading mail. If not ready, follow `nextCommand` exactly.",
      "Run `frontctl inbox --limit 20 --json` for current inbox state. This must be live-private and not stale.",
      "Ask the user before writes. For approved writes, include `--actor` and `--reason`; use `--yes` only after approval.",
    ],
    agentRules: [
      "Do not use Front's public API for mailbox work.",
      "Do not send email. `frontctl send` is intentionally blocked; drafts are allowed.",
      "Do not use cache for current inbox state unless the user explicitly asks for offline/cache analysis.",
      "For state-changing actions, frontctl writes a visible identity comment before the action so the user can distinguish agent actions from human actions.",
      "Pass Front conversation ids such as `cnv_...` directly. frontctl resolves them live; do not search for a numeric id, inspect the local index, open a browser, invent app URLs, or pass route fragments merely to resolve one.",
      "If a command says live mode is locked, run the recommended setup/unlock command instead of falling back to stale data.",
      "If Front rejects a cached browser session, frontctl performs one bounded live-source recovery and can fall back to an open, signed-in Front app. Do not replace that with cached mail.",
    ],
    setupLoop: {
      installFromRepo: "script/bootstrap_agent_install.sh",
      oneCommandSetup: "frontctl setup complete --yes --json",
      readiness: "frontctl ready --json",
      liveInbox: "frontctl inbox --limit 20 --json",
      supportBundle: "frontctl diagnose --output frontctl-support.json --json",
    },
    commonWorkflows: {
      readCurrentInbox: [
        "frontctl ready --json",
        "frontctl inbox --limit 20 --json",
        "frontctl read CONVERSATION_ID --full --json",
        "frontctl summarize CONVERSATION_ID --json",
      ],
      triageWithoutWriting: [
        "frontctl triage inbox --limit 20 --json",
        "frontctl search \"query\" --limit 20 --json",
        "frontctl resources list tags --json",
      ],
      approvedWrites: [
        "frontctl archive CONVERSATION_ID --actor AGENT_NAME --reason \"why the user approved this\" --yes --json",
        "frontctl snooze CONVERSATION_ID in:2d --actor AGENT_NAME --reason \"why the user approved this\" --yes --json",
        "frontctl tag add CONVERSATION_ID TAG_ID --actor AGENT_NAME --reason \"why the user approved this\" --yes --json",
        "frontctl comment add CONVERSATION_ID --body-file note.md --yes --json",
      ],
      draftOnly: [
        "frontctl draft reply CONVERSATION_ID --body-html-file reply.html --yes --json",
        "frontctl draft discard CONVERSATION_ID MESSAGE_UID --yes --json",
      ],
      verification: [
        "frontctl discovery verify-writes --json",
        "frontctl create-test-conversation --subject \"frontctl test\" --body \"Disposable test\" --yes --json",
        "frontctl discovery verify-live-writes CONVERSATION_ID --yes --json",
      ],
    },
    commandGroups: {
      setup: [
        "frontctl doctor [--json]",
        "frontctl ready|readiness [--json]",
        "frontctl setup complete [--agent codex|claude|all] [--yes] [--json]",
        "frontctl agents check|install|prompt --agent codex|claude|chatgpt|all [--yes] [--json]",
        "frontctl auth check|security|unlock|clear [--json]",
      ],
      reads: [
        "frontctl inbox [--limit 20] [--all] [--format markdown|plain] [--json]",
        "frontctl read CONVERSATION_ID [--full] [--format markdown|plain] [--json]",
        "frontctl summarize CONVERSATION_ID [--format markdown|plain] [--json]",
        "frontctl triage inbox [--limit 20] [--all] [--json]",
        "frontctl search QUERY [--limit 20] [--ids-only] [--json]",
        "frontctl attachments list|read ... [--json]",
      ],
      resources: [
        "frontctl whoami [--json]",
        "frontctl resources list inboxes|channels|teammates|teams|tags|signatures|custom-fields [--json]",
        "frontctl resources search QUERY [--limit 20] [--json]",
        "frontctl cards search QUERY [--limit 20] [--json]",
      ],
      writesRequireApproval: [
        "frontctl archive|unarchive|delete|restore CONVERSATION_ID --actor NAME --reason WHY --yes [--json]",
        "frontctl snooze CONVERSATION_ID UNTIL --actor NAME --reason WHY --yes [--json]",
        "frontctl tag add|remove CONVERSATION_ID TAG --actor NAME --reason WHY --yes [--json]",
        "frontctl assign|unassign|move|follower|link|custom-field ... --actor NAME --reason WHY --yes [--json]",
        "frontctl comment add|remove ... [--yes] [--json]",
      ],
      draftsNoSend: [
        "frontctl draft list|read ... [--json]",
        "frontctl draft reply CONVERSATION_ID --body-file reply.txt|--body-html-file reply.html --yes [--json]  # reply-all, shared draft",
        "frontctl draft create|compose --to EMAIL --subject TEXT --body-file draft.txt|--body-html-file draft.html --yes [--json]",
        "frontctl draft update CONVERSATION_ID MESSAGE_UID --to EMAIL --body-file draft.txt|--body-html-file draft.html --yes [--json]",
        "frontctl draft discard DRAFT_ID | frontctl draft discard CONVERSATION_ID MESSAGE_UID --yes [--json]",
      ],
      diagnosticsAndAdvanced: [
        "frontctl audit list [--limit 50] [--conversation ID] [--json]",
        "frontctl diagnose [--output support.json] [--json]",
        "frontctl browser list|inspect ... [--json]",
        "frontctl bridge status|test|permissions [--json]",
        "frontctl discovery guide|capture|sanitize|verify-writes|verify-live-writes ... [--json]",
        "frontctl sync|cache|memory|workflows|mq ... [--json]",
      ],
      blocked: [
        "frontctl send ... (always blocked)",
      ],
    },
    globalFlags: ["--help", "-h", "--json", "--plain", "--no-color", "--dry-run", "--version"],
    notes: [
      "Use `--json` for agent/tool calls.",
      "Use `--dry-run` to preview mutations; execution still requires command-specific `--yes`.",
      "Use `--offline-cache` only for explicit cache/analytics workflows, not realtime email triage.",
      "Use draft `--body-html` or `--body-html-file` for formatted drafts with conservative HTML: p, ul/ol/li, blockquote, strong, em, code, and links. Comments are plain text.",
    ],
  };
}

async function versionInfo() {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
    name?: string;
    version?: string;
    description?: string;
  };
  return {
    name: packageJson.name ?? "frontctl",
    version: packageJson.version ?? "0.0.0",
    description: packageJson.description,
  };
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const cliError = error instanceof CliError ? error : new CliError(String(error), 1);
  const payload = {
    ok: false,
    error: cliError.message,
    exitCode: cliError.exitCode,
  };

  if (process.argv.includes("--json")) {
    console.error(JSON.stringify(payload, null, 2));
  } else {
    console.error(`frontctl: ${cliError.message}`);
  }

  process.exitCode = cliError.exitCode;
});
