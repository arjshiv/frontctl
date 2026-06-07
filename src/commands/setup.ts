import { checkFrontSession } from "../lib/auth.js";
import { agentcookieStatus } from "../lib/agentcookie.js";
import { cdpBridgeStatus } from "../lib/cdpBridge.js";
import { listBrowserProfiles } from "../lib/browserProfiles.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildUserReadiness } from "../lib/readiness.js";
import { agentsStatus, installAgentSkills, type AgentKind } from "./agents.js";
import { doctor } from "./doctor.js";
import { memoryCommand } from "./memory.js";
import { bridgeCommand } from "./bridge.js";

export async function setupCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const agent = readAgentFlag(args);
  const shouldInstallAgents = args.includes("--yes") || args.includes("--install-agents");
  const [doctorResult, auth, agentCheck, agentcookie, bridgeStatusBefore] = await Promise.all([
    doctor(paths),
    checkFrontSession(),
    agentsStatus(agent),
    agentcookieStatus(),
    cdpBridgeStatus(),
  ]);
  const browserProfiles = listBrowserProfiles();
  const explicitBrowserCookieFallbackAvailable = browserProfiles.some((profile) => profile.cookiesExists);
  const agentInstall = shouldInstallAgents
    ? await installAgentSkills(agent ?? "all", { write: args.includes("--yes") })
    : undefined;
  const memory = args.includes("--learn")
    ? await memoryCommand(["init", "--live", "--all", "--limit", String(readNumberFlag(args, "--learn-limit") ?? 200)], paths)
    : undefined;
  const bridgeTest = args.includes("--enable-live")
    ? await bridgeCommand(["test"], paths)
    : undefined;
  const bridgeStatusAfter = bridgeTest ? await cdpBridgeStatus() : bridgeStatusBefore;
  const liveReady = auth.valid || bridgeStatusAfter.proofValid;
  const nonPromptingLiveAvailable = bridgeStatusAfter.availableWithoutKeychain
    || bridgeStatusAfter.proofValid
    || auth.valid
    || Boolean(agentcookie.frontCookiesAvailable);
  const finalAgentStatus = agentInstall ? await agentsStatus(agent) : agentCheck;
  const frontAppInstalled = checkOk(doctorResult.checks, "frontApp");
  const localProfileVisible = doctorResult.onboarding.readyForAgentUse;
  const userReadiness = buildUserReadiness({
    frontAppInstalled,
    localProfileVisible,
    browserSessionAvailable: nonPromptingLiveAvailable,
    authValid: liveReady,
    agentsInstalled: finalAgentStatus.allInstalled,
  });

  return {
    ok: doctorResult.ok,
    install: {
      recommended: [
        "Install Front for macOS and sign in.",
        "Install frontctl with the signed macOS package once available, or npm/Homebrew for technical users.",
        "Run frontctl setup --agent all --yes --json.",
      ],
      development: [
        "npm install",
        "npm run build",
        "npm link",
      ],
      verify: "frontctl doctor --json",
      agents: [
        "frontctl agents check --json",
        "frontctl agents install --agent codex --yes --json",
        "frontctl agents install --agent claude --yes --json",
        "frontctl agents prompt --agent chatgpt --json",
      ],
    },
    front: {
      installed: frontAppInstalled,
      appInstalled: frontAppInstalled,
      bundleReady: checkOk(doctorResult.checks, "frontBundle"),
      version: doctorResult.front?.version,
      localProfileVisible,
      checks: doctorResult.checks,
      issues: doctorResult.issues,
    },
    auth,
    bridge: {
      status: bridgeStatusAfter,
      test: bridgeTest,
      enableCommand: "frontctl setup --enable-live --json",
    },
    memory,
    authSources: {
      browsers: browserProfiles.map((profile) => ({
        browser: profile.browser,
        profile: profile.profile,
        cookiesExists: profile.cookiesExists,
        supportsCookieImport: profile.supportsCookieImport,
      })),
      agentcookie: {
        installed: agentcookie.installed,
        plainCookiesExists: agentcookie.plainCookiesExists,
        frontCookiesAvailable: agentcookie.frontCookiesAvailable,
      },
      explicitBrowserCookieFallbackAvailable,
      nonPromptingLiveAvailable,
    },
    agents: {
      status: finalAgentStatus,
      install: agentInstall,
      installCommand: `frontctl setup --agent ${agent ?? "all"} --yes --json`,
      chatgptPromptCommand: "frontctl agents prompt --agent chatgpt --json",
    },
    nextSteps: liveReady
      ? doctorResult.ok
        ? [
          "frontctl inbox list --limit 20 --json",
          "frontctl memory init --all --limit 200 --json",
          "frontctl workflows daily --actor Codex --json",
          "frontctl triage inbox --limit 20 --json",
          "frontctl search \"query\" --json",
          "frontctl read CONVERSATION_ID --json",
        ]
        : doctorResult.issues.map((issue) => issue.remedy).filter(Boolean)
      : doctorResult.ok
        ? [
          "frontctl setup --enable-live --json",
          "frontctl discovery launch --remote-debugging-port 9222 --json",
          "frontctl setup --learn --json",
          "frontctl workflows daily --actor Codex --json",
          "frontctl triage inbox --limit 20 --json",
          "frontctl inbox list --limit 20 --json",
        ]
        : doctorResult.issues.map((issue) => issue.remedy).filter(Boolean),
    userReadiness,
    failureMode: legacyFailureMode(userReadiness.state),
    agentPrompt:
      "Use the frontctl skill. Run frontctl auth check --json, then frontctl workflows daily --actor Codex --json. Do not send email.",
  };
}

function checkOk(checks: Array<{ name: string; ok: boolean }>, name: string) {
  return checks.find((check) => check.name === name)?.ok ?? false;
}

function legacyFailureMode(state: ReturnType<typeof buildUserReadiness>["state"]) {
  if (state === "front-not-installed" || state === "front-sign-in-missing") {
    return "front-not-ready";
  }
  if (state === "agent-skills-missing") {
    return "agent-skill-not-installed";
  }
  return state;
}

function readAgentFlag(args: string[]): AgentKind | "all" | undefined {
  const index = args.indexOf("--agent");
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === "codex" || value === "claude" || value === "all" ? value : undefined;
}

function readNumberFlag(args: string[], flag: string): number | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? Number(args[index + 1]) : undefined;
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}
