export interface ReadinessGate {
  name: "frontApp" | "frontSignIn" | "liveMode" | "agentSkills";
  ok: boolean;
  label: string;
  userAction: string;
}

export interface UserReadiness {
  ready: boolean;
  state: "ready" | "front-not-installed" | "front-sign-in-missing" | "live-mode-locked" | "agent-skills-missing";
  summary: string;
  nextAction: string;
  gates: ReadinessGate[];
}

export function buildUserReadiness(input: {
  frontAppInstalled: boolean;
  localProfileVisible: boolean;
  browserSessionAvailable?: boolean;
  authValid: boolean;
  agentsInstalled: boolean;
}): UserReadiness {
  const frontAccessAvailable = input.frontAppInstalled || Boolean(input.browserSessionAvailable) || input.authValid;
  const signedInSessionAvailable = input.localProfileVisible || Boolean(input.browserSessionAvailable) || input.authValid;
  const gates: ReadinessGate[] = [
    {
      name: "frontApp",
      ok: frontAccessAvailable,
      label: "Front access",
      userAction: "Install Front for macOS, or sign into Front in Chrome or Microsoft Edge.",
    },
    {
      name: "frontSignIn",
      ok: signedInSessionAvailable,
      label: "Front sign-in",
      userAction: "Open Front, Chrome, or Microsoft Edge and sign into Front, then wait for the inbox to load.",
    },
    {
      name: "liveMode",
      ok: input.authValid,
      label: "Live session",
      userAction: "Approve one live-session unlock, or configure a CDP browser bridge. Run `frontctl readiness --json` for the exact command.",
    },
    {
      name: "agentSkills",
      ok: input.agentsInstalled,
      label: "Agent skills",
      userAction: "Click Install Agent Skills or run `frontctl setup --agent all --yes --json`.",
    },
  ];

  const firstMissing = gates.find((gate) => !gate.ok);
  if (!firstMissing) {
    return {
      ready: true,
      state: "ready",
      summary: "Frontctl is ready for local agent use.",
      nextAction: "Ask Claude, ChatGPT with local command access, or Codex to use frontctl. Do not send email.",
      gates,
    };
  }

  return {
    ready: false,
    state: stateForGate(firstMissing.name),
    summary: "A setup step is still required before local agent use.",
    nextAction: firstMissing.userAction,
    gates,
  };
}

function stateForGate(name: ReadinessGate["name"]): UserReadiness["state"] {
  if (name === "frontApp") return "front-not-installed";
  if (name === "frontSignIn") return "front-sign-in-missing";
  if (name === "liveMode") return "live-mode-locked";
  return "agent-skills-missing";
}
