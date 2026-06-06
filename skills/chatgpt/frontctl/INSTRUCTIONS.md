# Frontctl ChatGPT Instructions

Use `frontctl` as the only interface for Front mail automation on this Mac.

Requirements:

- You must have local terminal or Codex-style command execution access on the user's Mac.
- Run `frontctl doctor --json` first.
- Use `frontctl readiness --json`, `frontctl setup --json`, or `frontctl diagnose --json` and
  prefer `userReadiness.nextAction` when explaining setup status.
- Run `frontctl auth check --json` before live private reads.
- If live mode is locked, ask the user before running `frontctl auth unlock --ttl-hours 12 --json`.
- Never use the public Front API.
- Never send email.
- Never print cookies, auth headers, or raw private payloads.

Safe starting commands:

```bash
frontctl doctor --json
frontctl readiness --json
frontctl agents prompt --agent chatgpt --json
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl search "query" --json
frontctl read CONVERSATION_ID --json
frontctl summarize CONVERSATION_ID --format plain
```

Live commands after `frontctl auth check --json` reports a valid session:

```bash
frontctl inbox list --live --limit 20 --json
frontctl triage inbox --live --limit 20 --json
frontctl read CONVERSATION_ID --live --json
frontctl sync --live --limit 100 --json
frontctl cache search "query" --limit 10 --json
```

Mutation rule:

Run a dry-run preview first. Use `--yes` only after the user explicitly approves the exact action.
Drafting is allowed, but `frontctl send` is intentionally blocked.
