import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listBrowserProfiles } from "../lib/browserProfiles.js";
import { run } from "../lib/process.js";

export async function discoveryBrowserStatus(options: { remoteDebuggingPort?: number } = {}) {
  const port = options.remoteDebuggingPort ?? 9222;
  const [cdp, processes, dynamicCdpCandidates] = await Promise.all([
    inspectCdp(port),
    inspectProcesses(),
    discoverDynamicCdpCandidates(),
  ]);
  const usableDynamicCandidate = dynamicCdpCandidates.find((candidate) => candidate.reachable && candidate.hasWebSocketDebuggerUrl);
  const selectedPort = cdp.reachable && cdp.hasWebSocketDebuggerUrl ? port : usableDynamicCandidate?.port;
  return {
    source: "local-diagnostics",
    publicApiUsed: false,
    remoteDebuggingPort: port,
    cdp,
    dynamicCdpCandidates,
    selectedRemoteDebuggingPort: selectedPort,
    front: {
      running: processes.front.count > 0,
      processCount: processes.front.count,
      remoteDebuggingEnabled: processes.front.remoteDebuggingEnabled,
    },
    edge: {
      running: processes.edge.count > 0,
      processCount: processes.edge.count,
      remoteDebuggingEnabled: processes.edge.remoteDebuggingEnabled,
    },
    recommendedLaunchCommand: `frontctl discovery launch --remote-debugging-port ${port} --json`,
    usableForBrowserCapture: Boolean(selectedPort),
    nextAction: selectedPort
      ? `frontctl discovery capture --remote-debugging-port ${selectedPort} --duration-ms 15000 --json`
      : "No usable CDP endpoint is reachable. If Front is already running, it may ignore new remote-debugging flags; do not quit/relaunch it without the user's approval. Use frontctl discovery verify-live-writes CONVERSATION_ID --yes --json for CLI-level live proof.",
  };
}

async function inspectCdp(port: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
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

async function discoverDynamicCdpCandidates() {
  const profiles = listBrowserProfiles();
  const candidates = await Promise.all(profiles.map(async (profile) => {
    const activePort = await readDevToolsActivePort(profile.profilePath);
    if (!activePort) {
      return undefined;
    }
    const cdp = await inspectCdp(activePort.port);
    return {
      browser: profile.browser,
      profile: profile.profile,
      port: activePort.port,
      reachable: cdp.reachable,
      hasWebSocketDebuggerUrl: cdp.hasWebSocketDebuggerUrl,
      browserVersion: cdp.browser,
    };
  }));
  return candidates.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
}

async function readDevToolsActivePort(profilePath: string) {
  if (!profilePath) {
    return undefined;
  }
  try {
    const text = await readFile(join(profilePath, "DevToolsActivePort"), "utf8");
    const [portText] = text.trim().split(/\n/);
    const port = Number(portText);
    return Number.isFinite(port) && port > 0 ? { port } : undefined;
  } catch {
    return undefined;
  }
}

async function inspectProcesses() {
  const output = await run("ps", ["auxww"], 8 * 1024 * 1024).catch(() => ({ stdout: "" }));
  const lines = output.stdout.split("\n");
  return {
    front: summarizeProcesses(lines, "/Applications/Front.app"),
    edge: summarizeProcesses(lines, "/Applications/Microsoft Edge.app"),
  };
}

function summarizeProcesses(lines: string[], needle: string) {
  const matches = lines.filter((line) => line.includes(needle));
  return {
    count: matches.length,
    remoteDebuggingEnabled: matches.some((line) => line.includes("--remote-debugging-port")),
  };
}
