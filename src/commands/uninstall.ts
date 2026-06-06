import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultAuditPath } from "../lib/audit.js";
import { defaultSessionPath } from "../lib/auth.js";
import { CliError } from "../lib/cli.js";
import { pathStatus } from "../lib/fsInfo.js";
import { defaultStorePath } from "../lib/store.js";
import { discoveryFixtureRoot } from "../lib/writeVerification.js";

interface RemovalTarget {
  id: string;
  path: string;
  description: string;
}

export async function uninstallCommand(args: string[]) {
  if (args.includes("--help")) {
    return {
      usage: "frontctl uninstall [--yes] [--keep-agents] [--keep-data] [--json]",
      note: "Dry-run by default. Removes frontctl state and installed local skills only with --yes.",
    };
  }
  const execute = args.includes("--yes") && !args.includes("--dry-run");
  const keepAgents = args.includes("--keep-agents");
  const keepData = args.includes("--keep-data");
  const unknown = args.filter((arg) => arg.startsWith("--") && ![
    "--yes",
    "--dry-run",
    "--keep-agents",
    "--keep-data",
    "--json",
    "--plain",
    "--no-color",
  ].includes(arg));
  if (unknown.length) {
    throw new CliError(`Unknown uninstall option: ${unknown.join(", ")}`, 64);
  }

  const targets = removalTargets({ keepAgents, keepData });
  const planned = await Promise.all(targets.map(async (target) => ({
    ...target,
    status: await pathStatus(target.path),
  })));

  if (execute) {
    for (const target of planned) {
      await rm(target.path, { recursive: true, force: true });
    }
  }

  return {
    mode: execute ? "execute" : "dry-run",
    removed: execute,
    targets: planned,
    nextSteps: execute
      ? [
          "Remove the frontctl package with your installer, Homebrew, or npm if applicable.",
          "Front desktop and your Front account were not modified.",
        ]
      : [
          "Review targets, then rerun with --yes to remove frontctl local state.",
          "Use --keep-agents to leave Codex/Claude skills installed.",
          "Use --keep-data to leave ~/.frontctl data in place.",
        ],
  };
}

function removalTargets(options: { keepAgents: boolean; keepData: boolean }): RemovalTarget[] {
  const targets: RemovalTarget[] = [];
  if (!options.keepData) {
    targets.push(
      {
        id: "session",
        path: defaultSessionPath(),
        description: "Encrypted frontctl live-session cache.",
      },
      {
        id: "store",
        path: defaultStorePath(),
        description: "Local SQLite search index.",
      },
      {
        id: "audit",
        path: defaultAuditPath(),
        description: "Redacted mutation audit log.",
      },
      {
        id: "discoveryFixtures",
        path: discoveryFixtureRoot(),
        description: "Sanitized write-route discovery fixtures.",
      },
    );
  }
  if (!options.keepAgents) {
    targets.push(
      {
        id: "codexSkill",
        path: join(homedir(), ".codex", "skills", "frontctl"),
        description: "Installed Codex frontctl skill.",
      },
      {
        id: "claudeSkill",
        path: join(homedir(), ".claude", "skills", "frontctl"),
        description: "Installed Claude frontctl skill.",
      },
    );
  }
  return targets;
}
