import { CliError } from "../lib/cli.js";
import { captureChromeDiscovery, sanitizeDiscoveryFile } from "../lib/discovery.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { run } from "../lib/process.js";
import {
  discoveryFixtureRoot,
  installDiscoveryFixture,
  installSanitizedDiscoveryFixture,
  listDiscoveryFixtures,
  verifyAllWriteFixtures,
  writeCaptureGuide,
} from "../lib/writeVerification.js";

export async function discoveryCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [subcommand] = args;

  if (subcommand === "sanitize") {
    const input = readStringFlag(args, "--input");
    if (!input) {
      throw new CliError("Usage: frontctl discovery sanitize --input capture.har [--output sanitized.json]", 64);
    }
    return sanitizeDiscoveryFile(input, readStringFlag(args, "--output"));
  }

  if (subcommand === "launch") {
    return launchFrontForDiscovery({
      paths,
      remoteDebuggingPort: readNumberFlag(args, "--remote-debugging-port") ?? 9222,
      printOnly: args.includes("--print-only"),
    });
  }

  if (subcommand === "capture") {
    const port = readNumberFlag(args, "--remote-debugging-port");
    if (!port) {
      throw new CliError(
        "Usage: frontctl discovery capture --remote-debugging-port 9222 [--duration-ms 15000] [--output sanitized.json] [--install] [--name NAME]",
        64,
      );
    }
    const result = await captureChromeDiscovery({
      remoteDebuggingPort: port,
      durationMs: readNumberFlag(args, "--duration-ms") ?? 15_000,
      outputPath: readStringFlag(args, "--output"),
    });
    if (!args.includes("--install")) {
      return result;
    }
    const install = await installSanitizedDiscoveryFixture(result, { name: readStringFlag(args, "--name") ?? "capture" });
    return {
      ...result,
      installed: true,
      fixturePath: install.fixturePath,
      fixtureRoot: install.fixtureRoot,
      installedRouteKinds: install.routeKinds,
      nextCommand: "frontctl discovery verify-writes --json",
    };
  }

  if (subcommand === "verify-writes") {
    return verifyAllWriteFixtures();
  }

  if (subcommand === "guide") {
    const action = args.find((arg, index) => index > 0 && !arg.startsWith("--") && args[index - 1] !== "--remote-debugging-port");
    return writeCaptureGuide({
      action,
      remoteDebuggingPort: readNumberFlag(args, "--remote-debugging-port") ?? 9222,
    });
  }

  if (subcommand === "fixtures") {
    const operation = args[1];
    if (operation === "path") {
      return { fixtureRoot: discoveryFixtureRoot() };
    }
    if (operation === "list") {
      return listDiscoveryFixtures();
    }
    if (operation === "install") {
      const input = args.find((arg, index) => index > 1 && !arg.startsWith("--"));
      if (!input) {
        throw new CliError("Usage: frontctl discovery fixtures install SANITIZED_OR_HAR_JSON [--name NAME]", 64);
      }
      return installDiscoveryFixture(input, { name: readStringFlag(args, "--name") });
    }
    throw new CliError("Usage: frontctl discovery fixtures path|list|install ...", 64);
  }

  throw new CliError("Usage: frontctl discovery launch|capture|sanitize|guide|verify-writes|fixtures ...", 64);
}

export async function launchFrontForDiscovery(options: {
  paths: FrontPaths;
  remoteDebuggingPort: number;
  printOnly?: boolean;
}) {
  const args = [
    "-na",
    options.paths.appPath,
    "--args",
    `--remote-debugging-port=${options.remoteDebuggingPort}`,
  ];
  if (!options.printOnly) {
    await run("open", args);
  }
  return {
    launched: !options.printOnly,
    appPath: options.paths.appPath,
    remoteDebuggingPort: options.remoteDebuggingPort,
    command: ["open", ...args],
    nextSteps: [
      "Perform exactly one write-like action in Front, such as adding a private comment or applying a tag.",
      `frontctl discovery capture --remote-debugging-port ${options.remoteDebuggingPort} --duration-ms 15000 --install --name ACTION --json`,
      "frontctl discovery verify-writes --json",
    ],
  };
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
