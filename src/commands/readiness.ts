import { checkFrontSession } from "../lib/auth.js";
import { defaultFrontPaths, type FrontPaths } from "../lib/paths.js";
import { buildUserReadiness } from "../lib/readiness.js";
import { agentsStatus } from "./agents.js";
import { doctor } from "./doctor.js";

export async function readinessCommand(_args: string[], paths: FrontPaths = defaultFrontPaths()) {
  const [doctorResult, auth, agents] = await Promise.all([
    doctor(paths),
    checkFrontSession(),
    agentsStatus("all"),
  ]);
  const frontAppInstalled = doctorResult.checks.find((check) => check.name === "frontApp")?.ok ?? false;
  const bundleReady = doctorResult.checks.find((check) => check.name === "frontBundle")?.ok ?? false;
  const localProfileVisible = doctorResult.onboarding.readyForAgentUse;
  const userReadiness = buildUserReadiness({
    frontAppInstalled,
    localProfileVisible,
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
    safety: {
      publicApiUsed: false,
      sendsEmail: false,
      touchesKeychain: false,
      note: "Readiness checks do not read mailbox contents and do not access Keychain.",
    },
    nextCommand: nextCommandFor(userReadiness.state),
  };
}

function nextCommandFor(state: ReturnType<typeof buildUserReadiness>["state"]) {
  if (state === "ready") {
    return "frontctl triage inbox --live --limit 20 --json";
  }
  if (state === "live-mode-locked") {
    return "frontctl auth unlock --ttl-hours 12 --json";
  }
  if (state === "agent-skills-missing") {
    return "frontctl setup --agent all --yes --json";
  }
  return "frontctl doctor --json";
}
