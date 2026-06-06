import { checkFrontSession } from "../lib/auth.js";
import { agentcookieStatus } from "../lib/agentcookie.js";
import { detectDefaultBrowser, listBrowserProfiles } from "../lib/browserProfiles.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildUserReadiness } from "../lib/readiness.js";
import { agentsStatus } from "./agents.js";
import { doctor } from "./doctor.js";

export async function readinessCommand(_args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [doctorResult, auth, agents, agentcookie] = await Promise.all([
    doctor(paths),
    checkFrontSession(),
    agentsStatus("all"),
    agentcookieStatus(),
  ]);
  const defaultBrowser = detectDefaultBrowser();
  const browserProfiles = listBrowserProfiles();
  const browserAuthAvailable = browserProfiles.some((profile) => profile.cookiesExists);
  const frontAppInstalled = doctorResult.checks.find((check) => check.name === "frontApp")?.ok ?? false;
  const bundleReady = doctorResult.checks.find((check) => check.name === "frontBundle")?.ok ?? false;
  const localProfileVisible = doctorResult.onboarding.readyForAgentUse;
  const userReadiness = buildUserReadiness({
    frontAppInstalled,
    localProfileVisible,
    browserSessionAvailable: browserAuthAvailable || Boolean(agentcookie.frontCookiesAvailable),
    authValid: auth.valid,
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
    },
    agents: {
      allInstalled: agents.allInstalled,
      count: agents.count,
    },
    authSources: {
      frontApp: {
        available: frontAppInstalled && localProfileVisible,
        valid: auth.valid,
        unlockCommand: "frontctl auth unlock --source front-app --ttl-hours 12 --json",
      },
      defaultBrowser,
      browsers: browserProfiles.map((profile) => ({
        browser: profile.browser,
        profile: profile.profile,
        cookiesExists: profile.cookiesExists,
        supportsCookieImport: profile.supportsCookieImport,
        unlockCommand: profile.cookiesExists
          ? `frontctl auth unlock --source ${profile.browser} --profile ${shellQuote(profile.profile)} --ttl-hours 12 --json`
          : undefined,
      })),
      agentcookie: {
        installed: agentcookie.installed,
        plainCookiesExists: agentcookie.plainCookiesExists,
        frontCookiesAvailable: agentcookie.frontCookiesAvailable,
        unlockCommand: "frontctl auth unlock --source agentcookie --ttl-hours 12 --json",
      },
      recommendedUnlockCommand: recommendedUnlockCommand(auth.valid, defaultBrowser.browser, browserAuthAvailable, agentcookie.frontCookiesAvailable),
    },
    safety: {
      publicApiUsed: false,
      sendsEmail: false,
      touchesKeychain: false,
      note: "Readiness checks do not read mailbox contents and do not access Keychain.",
    },
    nextCommand: nextCommandFor(userReadiness.state, recommendedUnlockCommand(auth.valid, defaultBrowser.browser, browserAuthAvailable, agentcookie.frontCookiesAvailable)),
  };
}

function nextCommandFor(state: ReturnType<typeof buildUserReadiness>["state"], unlockCommand?: string) {
  if (state === "ready") {
    return "frontctl triage inbox --live --limit 20 --json";
  }
  if (state === "live-mode-locked") {
    return unlockCommand ?? "frontctl auth unlock --ttl-hours 12 --json";
  }
  if (state === "agent-skills-missing") {
    return "frontctl setup --agent all --yes --json";
  }
  return "frontctl doctor --json";
}

function recommendedUnlockCommand(
  authValid: boolean,
  defaultBrowser: string | undefined,
  browserAuthAvailable: boolean,
  agentcookieAvailable: boolean | undefined,
) {
  if (authValid) return undefined;
  if ((defaultBrowser === "chrome" || defaultBrowser === "edge") && browserAuthAvailable) {
    return `frontctl auth unlock --source default-browser --ttl-hours 12 --json`;
  }
  if (agentcookieAvailable) {
    return "frontctl auth unlock --source agentcookie --ttl-hours 12 --json";
  }
  return "frontctl auth unlock --source front-app --ttl-hours 12 --json";
}

function shellQuote(value: string) {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
