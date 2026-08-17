export interface ReadinessGate {
  name: "frontApp" | "frontSignIn" | "liveMode" | "routeContext" | "agentSkills";
  ok: boolean;
  label: string;
  userAction: string;
}

export interface UserReadiness {
  ready: boolean;
  state: "ready" | "front-not-installed" | "front-sign-in-missing" | "live-mode-locked" | "route-context-missing" | "agent-skills-missing";
  summary: string;
  nextAction: string;
  gates: ReadinessGate[];
}

export function buildUserReadiness(input: {
  frontAppInstalled: boolean;
  localProfileVisible: boolean;
  browserSessionAvailable?: boolean;
  authValid: boolean;
  routeContextAvailable?: boolean;
  agentsInstalled: boolean;
}): UserReadiness {
  const frontAccessAvailable = input.frontAppInstalled || Boolean(input.browserSessionAvailable) || input.authValid;
  const signedInSessionAvailable = input.localProfileVisible || Boolean(input.browserSessionAvailable) || input.authValid;
  const gates: ReadinessGate[] = [
    {
      name: "frontApp",
      ok: frontAccessAvailable,
      label: "Front access",
      userAction: frontAccessAvailable
        ? "No action needed. Front access is available."
        : "Install Front for macOS, or sign into Front in Chrome or Microsoft Edge.",
    },
    {
      name: "frontSignIn",
      ok: signedInSessionAvailable,
      label: "Front sign-in",
      userAction: signedInSessionAvailable
        ? "No action needed. A signed-in Front profile is available."
        : "Open Front, Chrome, or Microsoft Edge and sign into Front, then wait for the inbox to load.",
    },
    {
      name: "liveMode",
      ok: input.authValid,
      label: "Live session",
      userAction: input.authValid
        ? "No action needed. Reuse the valid live session; do not unlock again or configure CDP."
        : "Approve one live-session unlock recommended by `frontctl readiness --json`.",
    },
    {
      name: "routeContext",
      ok: input.routeContextAvailable ?? true,
      label: "Workspace route",
      userAction: (input.routeContextAvailable ?? true)
        ? "No action needed. Front workspace routing is available."
        : "Open the signed-in Front app and let the inbox finish loading, then rerun `frontctl readiness --json`. Browser debugging is not required.",
    },
    {
      name: "agentSkills",
      ok: input.agentsInstalled,
      label: "Agent skills",
      userAction: input.agentsInstalled
        ? "No action needed. Agent skills are installed."
        : "Click Install Agent Skills or run `frontctl setup --agent all --yes --json`.",
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
  if (name === "routeContext") return "route-context-missing";
  return "agent-skills-missing";
}
