import { CliError } from "../lib/cli.js";
import { browserSeedCommand, verifyBrowserWritesCommand } from "./browserWrites.js";
import { browserProbeCommand } from "./browserProbe.js";
import { discoveryBrowserStatus } from "./discoveryStatus.js";
import { verifyLiveWritesCommand } from "./liveWrites.js";
import { captureChromeDiscovery, sanitizeDiscoveryFile } from "../lib/discovery.js";
import { listCachedDrafts } from "../lib/draftCache.js";
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

  if (subcommand === "relaunch-front") {
    return relaunchFrontForDiscovery({
      paths,
      remoteDebuggingPort: readNumberFlag(args, "--remote-debugging-port") ?? 9222,
      yes: args.includes("--yes"),
      allowExistingDrafts: args.includes("--allow-existing-drafts"),
      waitMs: readNumberFlag(args, "--wait-ms") ?? 10_000,
    });
  }

  if (subcommand === "browser-status") {
    return discoveryBrowserStatus({
      remoteDebuggingPort: readNumberFlag(args, "--remote-debugging-port") ?? 9222,
    });
  }

  if (subcommand === "browser-probe") {
    return browserProbeCommand(args.slice(1), paths);
  }

  if (subcommand === "browser-seed") {
    return browserSeedCommand(args.slice(1), paths);
  }

  if (subcommand === "verify-browser-writes") {
    return verifyBrowserWritesCommand(args.slice(1), paths);
  }

  if (subcommand === "capture") {
    const port = readNumberFlag(args, "--remote-debugging-port");
    if (!port) {
      throw new CliError(
        "Usage: frontctl discovery capture --remote-debugging-port 9222 [--target-url-contains conversations/ID] [--reload] [--duration-ms 15000] [--output sanitized.json] [--log-path trace.ndjson] [--install] [--name NAME]",
        64,
      );
    }
    const result = await captureChromeDiscovery({
      remoteDebuggingPort: port,
      durationMs: readNumberFlag(args, "--duration-ms") ?? 15_000,
      outputPath: readStringFlag(args, "--output"),
      logPath: readStringFlag(args, "--log-path"),
      targetUrlContains: readStringFlag(args, "--target-url-contains"),
      reload: args.includes("--reload"),
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

  if (subcommand === "trace") {
    const port = readNumberFlag(args, "--remote-debugging-port");
    if (!port) {
      throw new CliError(
        "Usage: frontctl discovery trace --remote-debugging-port 9222 [--target-url-contains conversations/ID] [--reload] [--duration-ms 15000] [--log-path trace.ndjson] [--output sanitized.json] [--install] [--name NAME]",
        64,
      );
    }
    const result = await captureChromeDiscovery({
      remoteDebuggingPort: port,
      durationMs: readNumberFlag(args, "--duration-ms") ?? 15_000,
      outputPath: readStringFlag(args, "--output"),
      logPath: readStringFlag(args, "--log-path"),
      targetUrlContains: readStringFlag(args, "--target-url-contains"),
      reload: args.includes("--reload"),
    });
    if (!args.includes("--install")) {
      return {
        ...result,
        note: "Trace log is redacted NDJSON. Use writeCandidates to inspect non-read private Front routes.",
      };
    }
    const install = await installSanitizedDiscoveryFixture(result, { name: readStringFlag(args, "--name") ?? "trace" });
    return {
      ...result,
      installed: true,
      fixturePath: install.fixturePath,
      fixtureRoot: install.fixtureRoot,
      installedRouteKinds: install.routeKinds,
      nextCommand: "frontctl discovery verify-writes --json",
      note: "Trace log is redacted NDJSON. Use writeCandidates to inspect non-read private Front routes.",
    };
  }

  if (subcommand === "verify-writes") {
    return verifyAllWriteFixtures();
  }

  if (subcommand === "verify-live-writes") {
    return verifyLiveWritesCommand(args.slice(1), paths);
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

  throw new CliError("Usage: frontctl discovery launch|relaunch-front|browser-status|browser-probe|browser-seed|capture|sanitize|guide|verify-writes|verify-live-writes|verify-browser-writes|fixtures ...", 64);
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

export async function relaunchFrontForDiscovery(options: {
  paths: FrontPaths;
  remoteDebuggingPort: number;
  yes?: boolean;
  allowExistingDrafts?: boolean;
  waitMs?: number;
}) {
  const quitCommand = ["osascript", "-e", "tell application id \"com.frontapp.Front\" to quit"];
  const launchCommand = [
    "open",
    "-na",
    options.paths.appPath,
    "--args",
    `--remote-debugging-port=${options.remoteDebuggingPort}`,
  ];
  const [preflight, browserStatus] = await Promise.all([
    relaunchPreflight(options.paths),
    discoveryBrowserStatus({ remoteDebuggingPort: options.remoteDebuggingPort }),
  ]);
  if (!options.yes) {
    return {
      source: "local-diagnostics",
      mode: "dry-run",
      requiresYes: true,
      willQuitFront: true,
      remoteDebuggingPort: options.remoteDebuggingPort,
      preflight,
      browserStatus,
      quitCommand,
      launchCommand,
      command: `frontctl discovery relaunch-front --remote-debugging-port ${options.remoteDebuggingPort} --yes --json`,
      warning: "This quits and reopens Front so Chromium/Electron accepts remote debugging flags. Unsaved Front UI state may be disrupted.",
    };
  }
  if (preflight.potentialDraftCount > 0 && !options.allowExistingDrafts) {
    throw new CliError(
      `Front local cache suggests ${preflight.potentialDraftCount} existing draft(s). Re-run with --allow-existing-drafts only if relaunching Front is acceptable.`,
      69,
    );
  }

  await run(quitCommand[0], quitCommand.slice(1)).catch(() => ({ stdout: "", stderr: "" }));
  await waitForFrontMainProcess(false, options.waitMs ?? 10_000);
  await run(launchCommand[0], launchCommand.slice(1));
  const cdp = await waitForCdp(options.remoteDebuggingPort, options.waitMs ?? 10_000);
  const status = await discoveryBrowserStatus({ remoteDebuggingPort: options.remoteDebuggingPort });
  return {
    source: "local-diagnostics",
    mode: "execute",
    relaunched: true,
    remoteDebuggingPort: options.remoteDebuggingPort,
    preflight,
    cdp,
    status,
    nextCommand: cdp.reachable && cdp.hasWebSocketDebuggerUrl
      ? `frontctl discovery capture --remote-debugging-port ${options.remoteDebuggingPort} --duration-ms 15000 --json`
      : `frontctl discovery browser-status --remote-debugging-port ${options.remoteDebuggingPort} --json`,
  };
}

async function relaunchPreflight(paths: FrontPaths) {
  const drafts = await listCachedDrafts(paths.indexedDbLevelDbPath).catch(() => []);
  return {
    potentialDraftCount: drafts.length,
    draftCheck: {
      source: "local-indexeddb",
      stale: true,
      bodyTextIncluded: false,
    },
    warning: drafts.length
      ? "Local Front cache suggests existing drafts. This check is stale but relaunch-front --yes will refuse unless --allow-existing-drafts is passed."
      : undefined,
  };
}

async function waitForFrontMainProcess(running: boolean, waitMs: number) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const ps = await run("ps", ["auxww"], 8 * 1024 * 1024).catch(() => ({ stdout: "" }));
    const isRunning = ps.stdout.split("\n").some((line) => line.includes("/Applications/Front.app/Contents/MacOS/Front"));
    if (isRunning === running) {
      return true;
    }
    await delay(300);
  }
  return false;
}

async function waitForCdp(port: number, waitMs: number) {
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const result = await inspectCdp(port);
    if (result.reachable) {
      return result;
    }
    await delay(300);
  }
  return inspectCdp(port);
}

async function inspectCdp(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    if (!response.ok) {
      return {
        reachable: false,
        status: response.status,
        hasWebSocketDebuggerUrl: false,
      };
    }
    const json = await response.json() as Record<string, unknown>;
    return {
      reachable: true,
      browser: typeof json.Browser === "string" ? json.Browser : undefined,
      protocolVersion: typeof json["Protocol-Version"] === "string" ? json["Protocol-Version"] : undefined,
      hasWebSocketDebuggerUrl: typeof json.webSocketDebuggerUrl === "string",
    };
  } catch {
    return {
      reachable: false,
      hasWebSocketDebuggerUrl: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readStringFlag(args: string[], flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const value = Number(readStringFlag(args, flag));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
