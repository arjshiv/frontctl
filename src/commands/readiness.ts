import { checkFrontSession, DEFAULT_SESSION_TTL_HOURS } from "../lib/auth.js";
import { agentcookieStatus } from "../lib/agentcookie.js";
import { cdpBridgeStatus } from "../lib/cdpBridge.js";
import { detectDefaultBrowser, listBrowserProfiles } from "../lib/browserProfiles.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildUserReadiness } from "../lib/readiness.js";
import { agentsStatus } from "./agents.js";
import { doctor } from "./doctor.js";

export async function readinessCommand(_args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [doctorResult, auth, agents, agentcookie, bridge] = await Promise.all([
    doctor(paths),
    checkFrontSession(),
    agentsStatus("all"),
    agentcookieStatus(),
    cdpBridgeStatus(),
  ]);
  const defaultBrowser = detectDefaultBrowser();
  const browserProfiles = listBrowserProfiles();
  const explicitBrowserCookieFallbackAvailable = browserProfiles.some((profile) => profile.cookiesExists);
  const nonPromptingLiveAvailable = bridge.availableWithoutKeychain
    || bridge.proofValid
    || auth.valid
    || Boolean(agentcookie.frontCookiesAvailable);
  const frontAppInstalled = doctorResult.checks.find((check) => check.name === "frontApp")?.ok ?? false;
  const bundleReady = doctorResult.checks.find((check) => check.name === "frontBundle")?.ok ?? false;
  const localProfileVisible = doctorResult.onboarding.readyForAgentUse;
  const userReadiness = buildUserReadiness({
    frontAppInstalled,
    localProfileVisible,
    browserSessionAvailable: nonPromptingLiveAvailable,
    authValid: auth.valid || bridge.proofValid,
    agentsInstalled: agents.allInstalled,
  });

  return {
    ok: userReadiness.ready,
    userReadiness,
    front: {
      appInstalled: frontAppInstalled,
      bundleReady,
      version: doctorResult.front.version,
      localProfileVisible,
      issueCount: doctorResult.issues.length,
    },
    auth: {
      valid: auth.valid,
      exists: auth.exists,
      expiresAt: auth.expiresAt,
      promptsOnCheck: auth.security.promptsOnCheck,
      promptsOnLiveRead: auth.security.promptsOnLiveRead,
      promptsOnUnlock: auth.security.promptsOnUnlock,
      promptsOnExplicitKeychainUnlock: auth.security.promptsOnExplicitKeychainUnlock,
    },
    bridge,
    agents: {
      allInstalled: agents.allInstalled,
      count: agents.count,
    },
    authSources: {
      frontApp: {
        available: frontAppInstalled && localProfileVisible,
        valid: auth.valid,
        unlockCommand: `frontctl auth unlock --source front-app --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`,
      },
      defaultBrowser,
      browsers: browserProfiles.map((profile) => ({
        browser: profile.browser,
        profile: profile.profile,
        cookiesExists: profile.cookiesExists,
        supportsCookieImport: profile.supportsCookieImport,
        unlockCommand: profile.cookiesExists
          ? `frontctl auth unlock --source ${profile.browser} --profile ${shellQuote(profile.profile)} --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`
          : undefined,
      })),
      agentcookie: {
        installed: agentcookie.installed,
        plainCookiesExists: agentcookie.plainCookiesExists,
        frontCookiesAvailable: agentcookie.frontCookiesAvailable,
        unlockCommand: `frontctl auth unlock --source agentcookie --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`,
      },
      explicitBrowserCookieFallbackAvailable,
      nonPromptingLiveAvailable,
      recommendedUnlockCommand: recommendedUnlockCommand(
        auth.valid,
        bridge.proofValid,
        bridge.availableWithoutKeychain,
        agentcookie.frontCookiesAvailable,
        explicitBrowserCookieFallbackAvailable,
        frontAppInstalled && localProfileVisible,
      ),
    },
    safety: {
      publicApiUsed: false,
      sendsEmail: false,
      touchesKeychain: false,
      note: "Readiness checks do not read mailbox contents and do not access Keychain.",
    },
    nextCommand: nextCommandFor(userReadiness.state, recommendedUnlockCommand(
      auth.valid,
      bridge.proofValid,
      bridge.availableWithoutKeychain,
      agentcookie.frontCookiesAvailable,
      explicitBrowserCookieFallbackAvailable,
      frontAppInstalled && localProfileVisible,
    )),
  };
}

function nextCommandFor(state: ReturnType<typeof buildUserReadiness>["state"], unlockCommand?: string) {
  if (state === "ready") {
    return "frontctl triage inbox --limit 20 --json";
  }
  if (state === "live-mode-locked") {
    return unlockCommand ?? "frontctl discovery launch --remote-debugging-port 9222 --json";
  }
  if (state === "agent-skills-missing") {
    return "frontctl setup --agent all --yes --json";
  }
  return "frontctl doctor --json";
}

function recommendedUnlockCommand(
  authValid: boolean,
  bridgeProofValid: boolean,
  bridgeAvailableWithoutKeychain: boolean,
  agentcookieAvailable: boolean | undefined,
  browserCookieFallbackAvailable: boolean,
  frontAppUnlockAvailable: boolean,
) {
  if (authValid) return undefined;
  if (bridgeProofValid) return undefined;
  if (bridgeAvailableWithoutKeychain) {
    return "frontctl bridge test --json";
  }
  if (agentcookieAvailable) {
    return `frontctl auth unlock --source agentcookie --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`;
  }
  if (browserCookieFallbackAvailable) {
    return `frontctl auth unlock --source default-browser --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`;
  }
  if (frontAppUnlockAvailable) {
    return `frontctl auth unlock --source front-app --ttl-hours ${DEFAULT_SESSION_TTL_HOURS} --json`;
  }
  return "frontctl discovery launch --remote-debugging-port 9222 --json";
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
