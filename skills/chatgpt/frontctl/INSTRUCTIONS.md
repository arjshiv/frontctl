# Frontctl ChatGPT Instructions

Use `frontctl` as the only interface for Front mail automation on this Mac.

Requirements:

- You must have local terminal or Codex-style command execution access on the user's Mac.
- Run `frontctl doctor --json` first.
- Use `frontctl readiness --json`, `frontctl setup --json`, or `frontctl diagnose --json` and
  prefer `userReadiness.nextAction` when explaining setup status.
- Run `frontctl auth check --json` before live private reads. If it is valid, run the requested read
  command directly.
- If live mode is locked, run `frontctl readiness --json` once and stop: report the
  `authSources.*.unlockCommand` the user can approve. Do not run `frontctl setup --enable-live`,
  `frontctl discovery launch`, Apple Events, browser permission helpers, `auth unlock`, or any
  cache fallback unless the user explicitly asks for that setup/debug action. The normal recovery
  path is a single user-approved unlock such as
  `frontctl auth unlock --source default-browser --ttl-hours 720 --json`; normal reads reuse that
  local session and do not touch Keychain.
- Never rerun unlock just to be safe when `auth check` is valid. Unlock reuses the valid session
  cache and should not repeatedly prompt for Keychain access.
- Never use the public Front API.
- Never send email.
- Never print cookies, auth headers, or raw private payloads.
- After initial setup or a broad sync, run `frontctl memory init --limit 500 --json` so future
  triage can use local aggregate preferences.
- When taking an action, pass `--actor ChatGPT` and a concise `--reason "..."`. frontctl itself
  writes a visible identity comment before executable conversation state changes, then applies the
  requested action last. Do not manually add a separate identity comment. If a command fails after
  writing the identity comment, report the returned comment UID or activity ID and inspect the
  thread before retrying.

Safe starting commands:

```bash
frontctl doctor --json
frontctl readiness --json
frontctl browser list --json
frontctl agents prompt --agent chatgpt --json
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl search "query" --json
frontctl search ids "query" --limit 20 --json
frontctl read CONVERSATION_ID --json
frontctl read CONVERSATION_ID --full --json
frontctl summarize CONVERSATION_ID --format plain
frontctl resources list inboxes --json
frontctl resources search "person or company" --json
frontctl cards search "person@example.com" --json
frontctl cards read CARD_ID --json
```

Live commands after `frontctl auth check --json` reports a valid session:

```bash
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl read CONVERSATION_ID --json
frontctl cards search "person@example.com" --json
frontctl cards read CARD_ID --json
frontctl sync --limit 100 --json
frontctl memory init --limit 500 --json
frontctl memory report --json
frontctl workflows daily --actor ChatGPT --json
```

Normal read commands are live private-session reads. Do not answer current inbox questions from
Front's stale local HTTP cache. If live reads fail, stop and report the live-read setup issue; do not
switch to `--offline-cache`, `frontctl cache ...`, or local index reads unless the user explicitly
asks for offline diagnostics.

For normal product use after memory exists, prefer `frontctl workflows daily --actor ChatGPT --json`.
It returns daily triage, noise review, follow-up, tag hygiene, and ops/risk queues with safe preview
commands. When a valid live session exists, it verifies the current inbox before proposing open-thread
actions; use `--local-only` only when the user explicitly wants no live check. Do not execute state
changes unless the user explicitly approves them.

Mutation rule:

Run a dry-run preview first. Use `--yes` only after the user explicitly approves the exact action.
Drafting is allowed, but `frontctl send` is intentionally blocked.
Archive/unarchive/snooze/unsnooze, tag add/remove, comment add/remove,
assign/unassign, move, follower add/remove, Front conversation link add/remove, tag create/delete, reply draft,
standalone compose/create draft, draft update, draft discard, and `create-test-conversation` are the executable
v1 action set when `canExecute` is true. Custom-field routes are capture-gated preview routes unless
`canExecute` is true. Delete-to-trash and restore are preview-only until a real Front private route
is captured and live verified; do not execute them even if they look like ordinary status updates.
Forward drafts save through the same
non-send draft route as compose/create and return a discard command. For `draft update`, use the
conversation id and message uid returned by compose/reply/update plus explicit recipients and subject;
do not guess from stale local draft cache.
For `follower remove`, removing the active user can immediately revoke read access on an
unassigned/internal task conversation. By default frontctl refuses active-user self-removal before
writing an identity comment; use `--allow-self-remove` only on a disposable conversation when the
user explicitly accepts possible access loss.
When the user asks for proof on a real low-risk thread, run
`frontctl discovery verify-live-writes CONVERSATION_ID --yes --json`. It verifies archive/unarchive,
assign/unassign, move, follower add, guarded active-user follower-remove refusal,
Front conversation link add/remove, snooze/unsnooze, tag add/remove, comment add/remove, and draft
save/update/discard, then archives test conversations last. The normal mutation layer already leaves
visible identity comments before state changes; add `--leave-proof-comment` only if the user
explicitly wants an extra final proof comment.

Browser route discovery:

Use `frontctl discovery browser-status --json` to find a reachable local DevTools port. CDP
reachability does not prove the browser is signed into Front. Before relying on browser capture, run
`frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json`.
If the probe reports `authentication_required`, ask the user to sign into Front in that browser
profile, or use `frontctl discovery browser-seed --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --yes --json`
when `frontctl auth check --json` is already valid. This seeds the selected browser tab from the
reusable local `frontctl` session without printing cookie values or touching Keychain. Capture
output must stay sanitized:

```bash
frontctl discovery capture --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --reload --duration-ms 15000 --json
```

For browser-backed proof on a low-risk real conversation, choose a numeric tag id from
`frontctl tag list --json`, then run:

```bash
frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json
```
