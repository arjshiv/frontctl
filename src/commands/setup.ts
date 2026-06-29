import { checkFrontSession, DEFAULT_SESSION_TTL_HOURS } from "../lib/auth.js";
import { agentcookieStatus } from "../lib/agentcookie.js";
import { cdpBridgeStatus } from "../lib/cdpBridge.js";
import { detectDefaultBrowser, listBrowserProfiles } from "../lib/browserProfiles.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildUserReadiness } from "../lib/readiness.js";
import { agentsStatus, installAgentSkills, type AgentKind } from "./agents.js";
import { authCommand } from "./auth.js";
import { doctor } from "./doctor.js";
import { memoryCommand } from "./memory.js";
import { bridgeCommand } from "./bridge.js";

export async function setupCommand(args: string[], paths: FrontPaths = defaultFrontPaths()) {
  if (args[0] === "complete") {
    return setupCompleteCommand(args.slice(1), paths);
  }

  return setupStatusCommand(args, paths);
}

async function setupStatusCommand(args: string[], paths: FrontPaths) {
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
  const enableLiveRequested = args.includes("--enable-live");
  const liveAlreadyAvailableBeforeBridge = auth.valid || bridgeStatusBefore.proofValid;
  const bridgeTest = enableLiveRequested && !liveAlreadyAvailableBeforeBridge
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
  const liveSetupCommand = agentcookie.frontCookiesAvailable
    ? `frontctl auth unlock --source agentcookie --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`
    : explicitBrowserCookieFallbackAvailable
      ? `frontctl auth unlock --source default-browser --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`
      : localProfileVisible
        ? `frontctl auth unlock --source front-app --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`
        : "frontctl discovery launch --remote-debugging-port 9222 --json";
  const userReadiness = buildUserReadiness({
    frontAppInstalled,
    localProfileVisible,
    browserSessionAvailable: nonPromptingLiveAvailable,
    authValid: liveReady,
    agentsInstalled: finalAgentStatus.allInstalled,
  });

  return {
    ok: userReadiness.ready,
    frontInstallOk: doctorResult.ok,
    install: {
      recommended: [
        "Install Front for macOS and sign in.",
        "Install frontctl with the signed macOS package once available, or npm/Homebrew for technical users.",
        "Run frontctl setup --agent all --yes --json.",
      ],
      development: [
        "npm install",
        "npm run build",
        "script/bootstrap_agent_install.sh --skip-live-proof --no-permission-preflight",
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
      enableSkipped: enableLiveRequested && liveAlreadyAvailableBeforeBridge,
      enableNote: enableLiveRequested && liveAlreadyAvailableBeforeBridge
        ? "Live reads are already available through a non-prompting session or existing CDP proof; no browser permission setup was attempted."
        : undefined,
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
        ? [liveSetupCommand]
        : doctorResult.issues.map((issue) => issue.remedy).filter(Boolean),
    userReadiness,
    failureMode: legacyFailureMode(userReadiness.state),
    agentPrompt:
      "Use the frontctl skill. Run frontctl doctor --json and frontctl ready --json. If setup is ready, run frontctl inbox --limit 20 --json. Do not send email, do not use the public Front API, and ask before any write.",
  };
}

async function setupCompleteCommand(args: string[], paths: FrontPaths) {
  const approved = args.includes("--yes");
  const skipPermissionPreflight = args.includes("--no-permission-preflight");
  const skipLearn = args.includes("--no-learn");
  const agent = readAgentFlag(args) ?? "all";
  const initialReadiness = await setupStatusCommand(["--agent", agent], paths);
  const authBefore = await checkFrontSession();
  const liveAvailableBefore = authBefore.valid || Boolean(initialReadiness.bridge.status.proofValid);
  const unlockPlan = await chooseUnlockPlan(paths);

  if (!approved) {
    return {
      ok: true,
      mode: "dry-run",
      action: "setup.complete",
      wouldInstallAgentSkills: agent,
      wouldPreflightPermission: !skipPermissionPreflight && !liveAvailableBefore,
      permissionPromptExpected: !skipPermissionPreflight && !liveAvailableBefore && Boolean(unlockPlan),
      unlockCommand: !skipPermissionPreflight && !liveAvailableBefore ? unlockPlan?.command : undefined,
      executeCommand: `frontctl setup complete --agent ${agent} --yes --json`,
      userReadiness: initialReadiness.userReadiness,
      nextAction: initialReadiness.userReadiness.nextAction,
      note: "Dry run. Re-run with --yes to install skills and preflight live-session permissions.",
    };
  }

  let unlock: unknown;
  let bridgePreflight: unknown;
  let permissionPromptExpected = false;
  let liveAlreadyAvailable = liveAvailableBefore;
  if (!skipPermissionPreflight && !liveAlreadyAvailable && initialReadiness.bridge.status.availableWithoutKeychain) {
    bridgePreflight = await bridgeCommand(["test"], paths).catch((error) => ({
      ok: false,
      skipped: true,
      error: error instanceof Error ? error.message : String(error),
      note: "Non-Keychain CDP bridge proof failed; setup will try the next available live auth source.",
    }));
    const bridgeAfter = await cdpBridgeStatus();
    liveAlreadyAvailable = bridgeAfter.proofValid;
  }
  if (!skipPermissionPreflight && !liveAlreadyAvailable) {
    if (!unlockPlan) {
      return {
        ok: false,
        mode: "execute",
        action: "setup.complete",
        state: "live-mode-locked",
        userReadiness: initialReadiness.userReadiness,
        nextAction: "Open Front, Chrome, or Microsoft Edge and sign into Front, then rerun `frontctl setup complete --yes --json`.",
        installedAgents: false,
        permissionPromptExpected: false,
        note: "No usable non-send live auth source was found. Stale cache was not used.",
      };
    }
    permissionPromptExpected = unlockPlan.mayPrompt;
    unlock = await authCommand([
      "unlock",
      "--source",
      unlockPlan.source,
      ...(unlockPlan.profile ? ["--profile", unlockPlan.profile] : []),
      "--ttl-hours",
      String(DEFAULT_SESSION_TTL_HOURS),
      "--json",
    ], paths);
  }

  const agentInstall = await installAgentSkills(agent, { write: true });
  const memory = skipLearn
    ? undefined
    : await memoryCommand(["init", "--live", "--all", "--limit", String(readNumberFlag(args, "--learn-limit") ?? 200)], paths)
      .catch((error) => ({
        ok: false,
        skipped: true,
        error: error instanceof Error ? error.message : String(error),
        note: "Preference learning is optional; setup continues without memory.",
      }));
  const final = await setupStatusCommand(["--agent", agent], paths);
  const authAfter = await checkFrontSession();
  const noFuturePrompts = authAfter.security.promptsOnCheck === false && authAfter.security.promptsOnLiveRead === false;

  return {
    ok: final.userReadiness.ready,
    mode: "execute",
    action: "setup.complete",
    installedAgents: agentInstall.installed,
    agentInstall,
    bridgePreflight,
    unlock,
    memory,
    permissionPreflight: {
      attempted: !skipPermissionPreflight && !liveAlreadyAvailable,
      skipped: skipPermissionPreflight,
      promptExpected: permissionPromptExpected,
      authWasValidBefore: authBefore.valid,
      authValidAfter: authAfter.valid,
      liveAlreadyAvailable,
      liveReadyAfter: final.userReadiness.gates.find((gate) => gate.name === "liveMode")?.ok ?? false,
      promptsOnCheck: authAfter.security.promptsOnCheck,
      promptsOnLiveRead: authAfter.security.promptsOnLiveRead,
      noFuturePrompts,
    },
    userReadiness: final.userReadiness,
    readiness: final,
    nextAgentPrompt:
      "Use frontctl on this Mac. Run frontctl ready --json, then frontctl inbox --limit 20 --json. Do not send email and do not use the public Front API.",
    nextCommand: final.nextSteps?.[0] ?? "frontctl ready --json",
  };
}

async function chooseUnlockPlan(paths: FrontPaths): Promise<{
  source: string;
  profile?: string;
  command: string;
  mayPrompt: boolean;
} | undefined> {
  const agentcookie = await agentcookieStatus();
  if (agentcookie.frontCookiesAvailable) {
    return {
      source: "agentcookie",
      command: `frontctl auth unlock --source agentcookie --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`,
      mayPrompt: false,
    };
  }

  const profiles = listBrowserProfiles().filter((profile) => profile.cookiesExists);
  const defaultBrowser = detectDefaultBrowser();
  if ((defaultBrowser.browser === "chrome" || defaultBrowser.browser === "edge")
    && profiles.some((profile) => profile.browser === defaultBrowser.browser)) {
    return {
      source: "default-browser",
      command: `frontctl auth unlock --source default-browser --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`,
      mayPrompt: true,
    };
  }

  const firstProfile = profiles.find((profile) => profile.browser === "edge")
    ?? profiles.find((profile) => profile.browser === "chrome");
  if (firstProfile) {
    return {
      source: firstProfile.browser,
      profile: firstProfile.profile,
      command: `frontctl auth unlock --source ${firstProfile.browser} --profile ${shellQuote(firstProfile.profile)} --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`,
      mayPrompt: true,
    };
  }

  const frontReady = (await doctor(paths)).onboarding.readyForAgentUse;
  if (frontReady) {
    return {
      source: "front-app",
      command: `frontctl auth unlock --source front-app --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`,
      mayPrompt: true,
    };
  }

  return undefined;
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

function shellQuote(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
