# Frontctl ChatGPT Instructions

Use `frontctl` as the only interface for Front mail automation on this Mac.

Requirements:

- You must have local terminal or Codex-style command execution access on the user's Mac.
- Run `frontctl doctor --json` first.
- Use `frontctl readiness --json`, `frontctl setup --json`, or `frontctl diagnose --json` and
  prefer `userReadiness.nextAction` when explaining setup status.
- Run `frontctl auth check --json` before live private reads.
- If live mode is locked, inspect `frontctl browser list --json` and prefer
  `frontctl auth unlock --source default-browser --ttl-hours 12 --json` when the user is signed into
  Front in Chrome or Microsoft Edge. Otherwise ask the user before running
  `frontctl auth unlock --source front-app --ttl-hours 12 --json`.
- Never rerun unlock just to be safe when `auth check` is valid. Unlock reuses the valid session
  cache and should not repeatedly prompt for Keychain access.
- Never use the public Front API.
- Never send email.
- Never print cookies, auth headers, or raw private payloads.
- After initial setup or a broad sync, run `frontctl memory init --limit 500 --json` so future
  triage can use local aggregate preferences.
- When taking an action, pass `--actor ChatGPT` and a concise `--reason "..."`. Do not add a Front
  comment just to identify yourself; comments can change thread state. Only comment when the user
  explicitly wants a visible internal Front comment. If the user wants a visible comment plus
  archive/snooze, add the comment first and run the archive/snooze last.

Safe starting commands:

```bash
frontctl doctor --json
frontctl readiness --json
frontctl browser list --json
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
frontctl memory init --limit 500 --json
frontctl memory report --json
frontctl workflows daily --actor ChatGPT --json
```

For normal product use after memory exists, prefer `frontctl workflows daily --actor ChatGPT --json`.
It returns daily triage, noise review, follow-up, tag hygiene, and ops/risk queues with safe preview
commands. When a valid live session exists, it verifies the current inbox before proposing open-thread
actions; use `--local-only` only when the user explicitly wants no live check. Do not execute state
changes unless the user explicitly approves them.

Mutation rule:

Run a dry-run preview first. Use `--yes` only after the user explicitly approves the exact action.
Drafting is allowed, but `frontctl send` is intentionally blocked.
