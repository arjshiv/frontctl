export async function onboarding() {
  return {
    name: "frontctl onboarding",
    audience: "A non-technical Front user installing this for Claude, ChatGPT, or another agent.",
    promise: "Use your already-signed-in Front desktop app. No Front API token. No public Front API.",
    steps: [
      {
        title: "Install Front desktop",
        detail: "Install Front for macOS and sign in normally. Leave the app installed in /Applications.",
        check: "frontctl doctor --json",
      },
      {
        title: "Install frontctl",
        detail: "Use the signed macOS installer and Frontctl Setup app once available, or run npm install in this project during development.",
        check: "frontctl doctor",
      },
      {
        title: "Install the agent skill",
        detail:
          "Run frontctl agents install for Codex or Claude so the assistant knows to use frontctl and never send email. For ChatGPT, copy the prompt from frontctl agents prompt --agent chatgpt --json into a ChatGPT session that has local terminal or Codex-style command access.",
        check: "frontctl agents check --json",
      },
      {
        title: "Check readiness",
        detail:
          "Run the concise readiness check. It reports the user-facing setup gates and one next action without reading mailbox contents or Keychain.",
        check: "frontctl readiness --json",
      },
      {
        title: "Confirm privacy boundaries",
        detail:
          "The assistant should report that it can see Front locally. It should not print cookie values or email content during setup.",
        check: "frontctl cookies inspect --json",
      },
      {
        title: "Start with read-only workflows",
        detail:
          "Begin with summarize/search/read tasks. Archive, snooze, tag, comment, and draft require an explicit preview plus --yes; sending remains blocked.",
        check: "frontctl help",
      },
      {
        title: "Generate support safely",
        detail:
          "If setup fails, run a redacted diagnostic bundle. It excludes cookies, auth headers, mailbox bodies, subjects, and signed attachment URLs.",
        check: "frontctl diagnose --output frontctl-support.json --json",
      },
    ],
    currentStatus:
      "This milestone supports local setup, agent skill installation, cached and live reads, local search, draft inspection, and approved non-send write previews/execution. Sending remains blocked.",
  };
}
