import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  browserBridgeStatus,
  createBrowserBridgeClient,
  discoverFrontRouteContextFromBrowserBridge,
  probeBrowserJavascriptAppleEvents,
  writeBrowserBridgeProof,
} from "../lib/browserBridge.js";
import {
  cdpBridgeStatus,
  discoverFrontRouteContextFromCdpBridge,
  testCdpBridge,
  writeCdpBridgeProof,
} from "../lib/cdpBridge.js";
import { CliError } from "../lib/cli.js";
import { buildFrontRoutes, discoverFrontRouteContext } from "../lib/frontRoutes.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { normalizeBrowserKind, type BrowserKind } from "../lib/browserProfiles.js";

const execFileAsync = promisify(execFile);

export async function bridgeCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [subcommand] = args;
  if (!subcommand || subcommand === "status") {
    const [cdp, appleEvents] = await Promise.all([
      cdpBridgeStatus(),
      browserBridgeStatus(),
    ]);
    return {
      ok: cdp.availableWithoutKeychain || cdp.proofValid || (appleEvents.enabled && appleEvents.proofValid),
      source: "bridge-status",
      recommended: "cdp",
      cdp,
      appleEvents,
      touchesKeychain: false,
      nextCommand: cdp.availableWithoutKeychain || cdp.proofValid
        ? "frontctl bridge test --json"
        : "frontctl discovery launch --remote-debugging-port 9222 --json",
    };
  }
  if (subcommand === "test") {
    const context = await discoverFrontRouteContext(paths.cacheDataPath)
      ?? await discoverFrontRouteContextFromCdpBridge();
    if (!context) {
      throw new CliError("Could not discover Front private route context. Open Front inbox in a signed-in browser once, then rerun bridge test.", 69);
    }
    const { client, target, remoteDebuggingPort } = await testCdpBridge(context);
    const boot = await client.getJson<Record<string, unknown>>(buildFrontRoutes(context).boot);
    const proof = await writeCdpBridgeProof(context, { remoteDebuggingPort, target });
    return {
      ok: true,
      source: "cdp-bridge",
      transport: client.transport,
      publicApiUsed: false,
      sendsEmail: false,
      touchesKeychain: false,
      promptClass: "none",
      remoteDebuggingPort,
      target,
      proof,
      bootKeys: Object.keys(boot).slice(0, 20),
      nextCommand: "frontctl inbox list --limit 20 --json",
    };
  }
  if (subcommand === "test-apple-events") {
    const appleEventsEnv = { ...process.env, FRONTCTL_BROWSER_BRIDGE: "1" };
    const context = await discoverFrontRouteContext(paths.cacheDataPath)
      ?? await discoverFrontRouteContextFromBrowserBridge(appleEventsEnv);
    if (!context) {
      throw new CliError("Could not discover Front private route context. Open Front inbox once, then rerun bridge test-apple-events.", 69);
    }
    const client = await createBrowserBridgeClient(context, appleEventsEnv);
    if (!client) {
      throw new CliError("No signed-in Front browser tab was reachable through Apple Events.", 69);
    }
    const boot = await client.getJson<Record<string, unknown>>(buildFrontRoutes(context).boot);
    const proof = await writeBrowserBridgeProof(context, {});
    return {
      ok: true,
      source: "browser-bridge",
      transport: client.transport,
      publicApiUsed: false,
      sendsEmail: false,
      touchesKeychain: false,
      promptClass: "macos-automation",
      proof,
      bootKeys: Object.keys(boot).slice(0, 20),
      nextCommand: "frontctl inbox list --limit 20 --json",
    };
  }
  if (subcommand === "permissions") {
    const browser = readBrowserFlag(args) ?? "edge";
    const appName = appNameForBrowser(browser);
    return {
      ok: true,
      browser,
      appName,
      touchesKeychain: false,
      permissions: {
        primary: "No macOS privacy permission is needed after the browser is launched with Chrome DevTools Protocol.",
        fallbackAutomation: `Apple Events fallback only: System Settings > Privacy & Security > Automation > allow frontctl to control ${appName}.`,
        fallbackJavascriptAppleEvents: `Apple Events fallback only: in ${appName}, choose View > Developer > Allow JavaScript from Apple Events.`,
      },
      commands: {
        check: "frontctl bridge status --json",
        test: "frontctl bridge test --json",
        launch: "frontctl discovery launch --remote-debugging-port 9222 --json",
        appleEventsTest: "frontctl bridge test-apple-events --json",
      },
      note: "The default bridge uses the signed-in Front browser tab through CDP and does not read browser cookies or Keychain.",
    };
  }
  if (subcommand === "enable-javascript-events") {
    const appleEventsEnv = { ...process.env, FRONTCTL_BROWSER_BRIDGE: "1" };
    const status = await browserBridgeStatus(appleEventsEnv);
    const browser = readBrowserFlag(args) ?? status.preferredBrowser ?? "edge";
    const appName = appNameForBrowser(browser);
    const approved = args.includes("--yes");
    if (!approved) {
      return {
        ok: true,
        dryRun: true,
        browser,
        appName,
        touchesKeychain: false,
        wouldEnable: "View > Developer > Allow JavaScript from Apple Events",
        executeCommand: `frontctl bridge enable-javascript-events --browser ${browser} --yes --json`,
      };
    }
    await clickJavascriptAppleEventsMenuItem(appName);
    const probe = await probeBrowserJavascriptAppleEvents(browser, appleEventsEnv).catch((error) => ({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    }));
    if (!probe.ok) {
      throw new CliError(`Tried to enable JavaScript from Apple Events in ${appName}, but verification failed (${probe.reason ?? "unknown"}). Enable View > Developer > Allow JavaScript from Apple Events manually, then rerun bridge test-apple-events.`, 69);
    }
    return {
      ok: true,
      dryRun: false,
      browser,
      appName,
      touchesKeychain: false,
      enabled: "View > Developer > Allow JavaScript from Apple Events",
      nextCommand: "frontctl bridge test --json",
    };
  }
  throw new CliError(`Unknown bridge subcommand: ${subcommand}`, 64);
}

function readBrowserFlag(args: string[]): BrowserKind | undefined {
  const index = args.indexOf("--browser");
  const value = index >= 0 ? args[index + 1] : undefined;
  const browser = normalizeBrowserKind(value);
  if (index >= 0 && (!browser || (browser !== "edge" && browser !== "chrome"))) {
    throw new CliError("Usage: frontctl bridge enable-javascript-events --browser edge|chrome [--yes]", 64);
  }
  return browser;
}

function appNameForBrowser(browser: BrowserKind) {
  return browser === "edge" ? "Microsoft Edge" : "Google Chrome";
}

async function clickJavascriptAppleEventsMenuItem(appName: string) {
  const script = `
    tell application "${appName}" to activate
    delay 0.2
    tell application "System Events"
      tell process "${appName}"
        click menu item "Allow JavaScript from Apple Events" of menu 1 of menu item "Developer" of menu 1 of menu bar item "View" of menu bar 1
      end tell
    end tell
  `;
  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not authorized|not permitted|errAEEventNotPermitted|-1743|assistive|accessibility|System Events/i.test(message)) {
      throw new CliError(`macOS Automation or Accessibility permission is required to click the ${appName} menu item. Open System Settings > Privacy & Security > Automation and Accessibility, allow frontctl or your terminal app, then rerun.`, 69);
    }
    throw new CliError(`Could not enable JavaScript from Apple Events in ${appName}: ${message}`, 69);
  }
}
