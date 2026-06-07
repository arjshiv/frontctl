# Frontctl ChatGPT Instructions

Use `frontctl` as the only interface for Front mail automation on this Mac.

Requirements:

- You must have local terminal or Codex-style command execution access on the user's Mac.
- Run `frontctl doctor --json` first.
- Use `frontctl readiness --json`, `frontctl setup --json`, or `frontctl diagnose --json` and
  prefer `userReadiness.nextAction` when explaining setup status.
- Run `frontctl auth check --json` before live private reads.
- If live mode is locked, run `frontctl setup --enable-live --json` first. The default live path is
  the CDP browser bridge and must not touch Keychain or macOS Automation. If that fails, inspect
  `frontctl bridge status --json`; if no CDP browser is reachable, use
  `frontctl discovery launch --remote-debugging-port 9222 --json` to launch a managed signed-in
  browser. Ask before running
  `frontctl auth unlock --source default-browser --ttl-hours 12 --json` or
  `frontctl auth unlock --source front-app --ttl-hours 12 --json`.
- Never rerun unlock just to be safe when `auth check` is valid. Unlock reuses the valid session
  cache and should not repeatedly prompt for Keychain access.
- Never use the public Front API.
- Never send email.
- Never print cookies, auth headers, or raw private payloads.
- After initial setup or a broad sync, run `frontctl memory init --limit 500 --json` so future
  triage can use local aggregate preferences.
- When taking an action, pass `--actor ChatGPT` and a concise `--reason "..."`. frontctl itself
  writes a visible identity comment before executable conversation state changes, then applies the
  requested action last. Do not manually add a separate identity comment.

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
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl read CONVERSATION_ID --json
frontctl sync --limit 100 --json
frontctl cache search "query" --limit 10 --json
frontctl memory init --limit 500 --json
frontctl memory report --json
frontctl workflows daily --actor ChatGPT --json
```

Normal read commands are live private-session reads. Do not answer current inbox questions from
Front's stale local HTTP cache. Use `--offline-cache` only for diagnostics, offline recovery, or
tests where stale data is explicitly acceptable.

For normal product use after memory exists, prefer `frontctl workflows daily --actor ChatGPT --json`.
It returns daily triage, noise review, follow-up, tag hygiene, and ops/risk queues with safe preview
commands. When a valid live session exists, it verifies the current inbox before proposing open-thread
actions; use `--local-only` only when the user explicitly wants no live check. Do not execute state
changes unless the user explicitly approves them.

Mutation rule:

Run a dry-run preview first. Use `--yes` only after the user explicitly approves the exact action.
Drafting is allowed, but `frontctl send` is intentionally blocked.
When the user asks for proof on a real low-risk thread, run
`frontctl discovery verify-live-writes CONVERSATION_ID --yes --json`. The normal mutation layer
already leaves visible identity comments before state changes; add `--leave-proof-comment` only if
the user explicitly wants an extra final proof comment.

Browser route discovery:

Use `frontctl discovery browser-status --json` to find a reachable local DevTools port. CDP
reachability does not prove the browser is signed into Front. Before relying on browser capture, run
`frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json`.
If the probe reports `authentication_required`, ask the user to sign into Front in that browser
profile, or use `frontctl discovery browser-seed --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --yes --json`
when `frontctl auth check --json` is already valid. This seeds the selected browser tab from the
short-lived local `frontctl` session without printing cookie values or touching Keychain. Capture
output must stay sanitized:

```bash
frontctl discovery capture --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --reload --duration-ms 15000 --json
```

For browser-backed proof on a low-risk real conversation, choose a numeric tag id from
`frontctl tag list --json`, then run:

```bash
frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json
```
