#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { agentsCommand } from "./commands/agents.js";
import { inspectAsar } from "./commands/asar.js";
import { attachmentsCommand } from "./commands/attachments.js";
import { auditCommand } from "./commands/audit.js";
import { authCommand } from "./commands/auth.js";
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
  draftCommand,
  snoozeConversation,
  tagConversation,
  unarchiveConversation,
  unsnoozeConversation,
} from "./commands/mutations.js";
import { onboarding } from "./commands/onboarding.js";
import { openConversation } from "./commands/open.js";
import { readinessCommand } from "./commands/readiness.js";
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
  },
  discovery: discoveryCommand,
  cache: cacheCommand,
  memory: memoryCommand,
  mq: mqCommand,
  whoami,
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
  sync: syncCommand,
  open: openConversation,
  archive: archiveConversation,
  unarchive: unarchiveConversation,
  snooze: snoozeConversation,
  unsnooze: unsnoozeConversation,
  tag: tagConversation,
  comment: commentConversation,
  draft: draftCommand,
  send: unsupportedMutation("send", "Sending is intentionally blocked by this project."),
  help: async () => usage(),
  onboarding,
  setup: setupCommand,
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

  if (!second) {
    throw new CliError(`Missing subcommand for: ${first}`, 64);
  }

  const subcommand = entry[second];
  if (!subcommand) {
    throw new CliError(`Unknown subcommand: ${first} ${second}`, 64);
  }

  printResult(await subcommand(commandArgs(tail, globals)), globals);
}

function commandArgs(args: string[], globals: { dryRun: boolean }) {
  return globals.dryRun ? [...args, "--dry-run"] : args;
}

function usage() {
  return {
    name: "frontctl",
    purpose: "Local Front desktop session CLI. Public Front API is intentionally not used.",
    commands: [
      "frontctl doctor [--json]",
      "frontctl version|--version [--json]",
      "frontctl front inspect [--json]",
      "frontctl cookies inspect [--json]",
      "frontctl asar inspect [--json]",
      "frontctl onboarding [--json]",
      "frontctl setup [--agent codex|claude|all] [--install-agents] [--learn] [--yes] [--json]",
      "frontctl readiness [--json]",
      "frontctl agents check|paths|install --agent codex|claude|all [--yes] [--json]",
      "frontctl agents prompt --agent codex|claude|chatgpt|all [--json]",
      "frontctl diagnose [--output support.json] [--json]",
      "frontctl uninstall [--yes] [--keep-agents] [--keep-data] [--json]",
      "frontctl auth check|security|unlock [--ttl-hours 12] [--force]|clear [--json]",
      "frontctl auth unlock --source front-app|chrome|edge|default-browser|agentcookie [--profile Default] [--ttl-hours 12] [--force] [--json]",
      "frontctl bridge status|test|permissions [--json]",
      "frontctl bridge enable-javascript-events [--browser edge|chrome] [--yes] [--json]",
      "frontctl browser list [--json]",
      "frontctl browser inspect --browser chrome|edge|safari [--json]",
      "frontctl audit list [--limit 50] [--action ACTION] [--conversation ID] [--mode dry-run|execute] [--json]",
      "frontctl attachments list CONVERSATION_ID [--offline-cache] [--json]",
      "frontctl discovery launch [--remote-debugging-port 9222] [--print-only] [--json]",
      "frontctl discovery relaunch-front [--remote-debugging-port 9222] [--allow-existing-drafts] --yes [--json]",
      "frontctl discovery browser-status [--remote-debugging-port 9222] [--json]",
      "frontctl discovery browser-probe CONVERSATION_ID [--remote-debugging-port 9222] [--target-url-contains conversations/ID] [--json]",
      "frontctl discovery browser-seed [--remote-debugging-port 9222] [--target-url-contains conversations/ID] --yes [--json]",
      "frontctl discovery guide [ACTION] [--remote-debugging-port 9222] [--json]",
      "frontctl discovery capture --remote-debugging-port 9222 [--target-url-contains conversations/ID] [--reload] [--log-path trace.ndjson] [--install] [--name ACTION] [--json]",
      "frontctl discovery trace --remote-debugging-port 9222 [--target-url-contains conversations/ID] [--reload] [--duration-ms 15000] [--log-path trace.ndjson] [--install] [--name ACTION] [--json]",
      "frontctl discovery sanitize --input capture.har [--json]",
      "frontctl discovery verify-writes [--json]",
      "frontctl discovery verify-live-writes CONVERSATION_ID --yes [--leave-proof-comment] [--json]",
      "frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --tag-id TAG_ID --yes [--json]",
      "frontctl discovery fixtures path|list|install ... [--json]",
      "frontctl sync [--offline-cache] [--limit 100] [--all] [--json]",
      "frontctl cache stats|search|read ... [--max-age-hours 12] [--format markdown|plain] [--json]",
      "frontctl memory init|report|path [--live] [--all] [--limit 500] [--fresh] [--json]",
      "frontctl workflows list|daily [--months 6] [--limit 8] [--actor NAME] [--local-only] [--json]",
      "frontctl mq check|install|query|example [--json]",
      "frontctl whoami [--json]",
      "frontctl inbox list [--limit 20] [--all] [--offline-cache] [--format markdown|plain] [--json]",
      "frontctl read CONVERSATION_ID [--offline-cache] [--format markdown|plain] [--json]",
      "frontctl summarize CONVERSATION_ID [--offline-cache] [--format markdown|plain] [--json]",
      "frontctl triage [inbox] [--limit 20] [--all] [--offline-cache] [--format markdown|plain] [--json]",
      "frontctl search QUERY [--offline-cache] [--limit 20] [--format markdown|plain] [--json]",
      "frontctl open CONVERSATION_ID [--print-only|--web] [--json]",
      "frontctl archive CONVERSATION_ID [--actor NAME] [--reason WHY] [--yes] [--json]",
      "frontctl unarchive CONVERSATION_ID [--actor NAME] [--reason WHY] [--yes] [--json]",
      "frontctl snooze CONVERSATION_ID UNTIL [--actor NAME] [--reason WHY] [--yes] [--json]",
      "frontctl unsnooze CONVERSATION_ID [--actor NAME] [--reason WHY] [--yes] [--json]",
      "frontctl tag list [--live] [--limit 100] [--json]",
      "frontctl tag add|remove CONVERSATION_ID TAG [--actor NAME] [--reason WHY] [--live] [--yes] [--json]",
      "frontctl comment add CONVERSATION_ID --body \"...\"|--body-file note.md [--actor NAME] [--reason WHY] [--yes] [--json]",
      "frontctl comment remove CONVERSATION_ID ACTIVITY_OR_COMMENT_UID [--actor NAME] [--reason WHY] [--yes] [--json]",
      "frontctl draft list|read ... [--json]",
      "frontctl draft discard DRAFT_ID | draft discard CONVERSATION_ID MESSAGE_UID [--yes] [--json]",
      "frontctl draft reply CONVERSATION_ID --body \"...\"|--body-file reply.md [--yes] [--json]",
      "frontctl draft compose [--to EMAIL] [--cc EMAIL] [--bcc EMAIL] [--subject \"...\"] --body \"...\"|--body-file draft.md [--json] (preview-only)",
      "frontctl send ... (always blocked)",
    ],
    globalFlags: ["--json", "--plain", "--no-color", "--dry-run"],
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
