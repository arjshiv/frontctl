import { CliError } from "../lib/cli.js";
import { run } from "../lib/process.js";

const MQ_INSTALL_COMMAND = ["brew", "install", "mq"] as const;
const MQ_EXAMPLES = {
  renderConversation: "frontctl read CONVERSATION_ID --format markdown > conversation.md",
  extractHeadings: "frontctl mq query --query '.h' --input conversation.md --output-format text",
  extractLists: "frontctl mq query --query '.list' --input conversation.md --output-format markdown",
};

export async function mqCommand(args: string[]): Promise<unknown> {
  const [operation] = args;

  if (!operation || operation === "check") {
    return checkMq();
  }

  if (operation === "install") {
    const printOnly = args.includes("--print-only") || !args.includes("--yes");
    if (!printOnly) {
      await run(MQ_INSTALL_COMMAND[0], [...MQ_INSTALL_COMMAND.slice(1)]);
    }
    return {
      installed: !printOnly,
      command: [...MQ_INSTALL_COMMAND],
      note: printOnly
        ? "Run with --yes to install mq with Homebrew."
        : "mq install command completed.",
    };
  }

  if (operation === "query") {
    const query = readStringFlag(args, "--query") ?? firstPositional(args.slice(1));
    const input = readStringFlag(args, "--input");
    const outputFormat = readStringFlag(args, "--output-format") ?? "markdown";
    if (!query || !input) {
      throw new CliError("Usage: frontctl mq query --query QUERY --input FILE [--output-format markdown|text|json]", 64);
    }
    await ensureMq();
    const result = await run("mq", ["-I", "markdown", "-F", outputFormat, query, input], 10 * 1024 * 1024);
    return result.stdout.trimEnd();
  }

  if (operation === "example") {
    return MQ_EXAMPLES;
  }

  throw new CliError("Usage: frontctl mq check|install|query|example ...", 64);
}

async function checkMq(): Promise<unknown> {
  try {
    const result = await run("mq", ["--version"]);
    return {
      installed: true,
      version: result.stdout.trim() || result.stderr.trim(),
      install: undefined,
      examples: MQ_EXAMPLES,
    };
  } catch {
    return {
      installed: false,
      version: undefined,
      install: {
        command: [...MQ_INSTALL_COMMAND],
        printOnly: "frontctl mq install --print-only --json",
        install: "frontctl mq install --yes --json",
      },
      examples: MQ_EXAMPLES,
    };
  }
}

async function ensureMq() {
  const status = await checkMq() as { installed: boolean };
  if (!status.installed) {
    throw new CliError("mq is not installed. Run `frontctl mq install --yes --json` or install mq manually.", 69);
  }
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function firstPositional(args: string[]) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--query", "--input", "--output-format"].includes(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      return arg;
    }
  }
  return undefined;
}
