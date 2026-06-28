---
name: frontctl
description: Use the local `frontctl` CLI to inspect and manage Front desktop mail from the user's authenticated local Front session. Use when the user asks Codex to read, summarize, search, archive, snooze, tag, comment, or draft replies in Front. Never use the public Front API and never send email.
---

# Frontctl

Use `frontctl` for Front desktop mail automation. It is a local-session CLI that works from the
user's authenticated Front app profile, not the public Front API.

## First Step

Run:

```bash
frontctl doctor --json
```

If `doctor.ok` is false, report the failing checks and stop before touching mail state.
For setup guidance, run `frontctl onboarding --json`. For a concise non-prompting readiness report,
run `frontctl readiness --json`. For a readiness report plus local skill install, run
`frontctl setup --agent all --yes --json` only when the user asks to install.
When reporting setup state, prefer `userReadiness.ready`, `userReadiness.state`, and
`userReadiness.nextAction` from `frontctl readiness --json`, `frontctl setup --json`, or
`frontctl diagnose --json`.
For live private reads, run `frontctl auth check --json` first. If it is valid, run the requested
read command directly. If it is not valid, run `frontctl readiness --json` once and stop: report the
`authSources.*.unlockCommand` the user can approve. Do not run `frontctl setup --enable-live`,
`frontctl discovery launch`, Apple Events, browser permission helpers, `auth unlock`, or any cache
fallback unless the user explicitly asks for that setup/debug action. The normal recovery path is a
single user-approved unlock such as
`frontctl auth unlock --source default-browser --ttl-hours 720 --json`; the resulting local session
is reused and normal reads do not touch Keychain.
Never rerun unlock just to be safe when `auth check` is valid. `auth unlock` reuses a valid cache,
and `--force` should be used only when the user explicitly wants to refresh the Front cookies.

## Rules

- Do not use the public Front API.
- Do not send email.
- Prefer `--json` for reads so IDs and fields stay stable.
- Never print cookie values, auth headers, or raw private payloads.
- For mutations, run a dry run first unless the user explicitly asks to apply.
- Use `--yes` only after the user asked for the action or approved a dry-run preview.
- Include Front conversation IDs when summarizing or proposing actions.

## Common Commands

Read-only diagnostics:

```bash
frontctl doctor --json
frontctl front inspect --json
frontctl cookies inspect --json
frontctl asar inspect --json
frontctl onboarding --json
frontctl readiness --json
frontctl browser list --json
frontctl browser inspect --browser edge --json
frontctl discovery launch --remote-debugging-port 9222 --print-only --json
frontctl discovery relaunch-front --remote-debugging-port 9222 --json
frontctl discovery browser-status --remote-debugging-port 9222 --json
frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port 9222 --target-url-contains conversations/CONVERSATION_ID --json
frontctl discovery browser-seed --remote-debugging-port 9222 --target-url-contains conversations/CONVERSATION_ID --yes --json
frontctl discovery guide --json
frontctl discovery guide ACTION --json
frontctl discovery capture --remote-debugging-port 9222 --target-url-contains conversations/CONVERSATION_ID --reload --duration-ms 15000 --install --name ACTION --json
frontctl discovery sanitize --input capture.har --output sanitized.json --json
frontctl discovery fixtures install sanitized.json --json
frontctl discovery verify-writes --json
frontctl discovery verify-live-writes CONVERSATION_ID --yes --json
frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json
frontctl audit list --json
```

Read commands:

```bash
frontctl inbox list --limit 20 --json
frontctl inbox list --all --limit 50 --json
frontctl triage inbox --limit 20 --json
frontctl search "query" --json
frontctl search ids "query" --limit 20 --json
frontctl read CONVERSATION_ID --json
frontctl read CONVERSATION_ID --full --json
frontctl read CONVERSATION_ID --format markdown
frontctl summarize CONVERSATION_ID --format plain
frontctl attachments list CONVERSATION_ID --json
frontctl resources list inboxes --json
frontctl resources search "person or company" --json
frontctl cards search "person@example.com" --json
frontctl cards read CARD_ID --json
frontctl open CONVERSATION_ID --print-only --json
frontctl open CONVERSATION_ID --web --print-only --json
```

Normal read commands are live private-session reads. Do not answer current inbox questions from
Front's stale local HTTP cache. If live reads fail, stop and report the live-read setup issue; do not
switch to `--offline-cache`, `frontctl cache ...`, or local index reads unless the user explicitly
asks for offline diagnostics.
Use `frontctl open CONVERSATION_ID --print-only --json` to inspect the Front deeplink without
launching. Omit `--print-only` only when the user wants Front opened locally.

Historical/local analytics commands. Do not use these for current inbox state:

```bash
frontctl sync --limit 100 --json
frontctl cache stats --json
frontctl cache stats --max-age-hours 6 --json
frontctl cache search "query" --limit 10 --json
frontctl cache read CONVERSATION_ID --json
frontctl cache read CONVERSATION_ID --format markdown
frontctl memory init --limit 500 --json
frontctl memory report --json
frontctl workflows daily --actor Codex --json
```

Use `frontctl sync` and `frontctl cache ...` only for explicit historical search, analytics,
preference learning, or offline diagnostics. Never use them as a fallback for "what is in my inbox
right now?"
After first setup or a broad live sync, run `frontctl memory init --limit 500 --json` to create the
local preference profile. Use `frontctl memory report --json` before suggesting archive/tag/snooze
rules. Memory is local-only and stores aggregate signals, not cookies, auth headers, or raw timeline
bodies.
For normal product use, prefer `frontctl workflows daily --actor Codex --json` after memory exists.
It returns the common queues the user actually needs: daily triage, noise review, follow-up, tag
hygiene, and ops/risk alerts. Treat its archive/snooze/tag commands as previews unless the user
explicitly approves execution. When a valid live session exists, it verifies the current inbox before
proposing open-thread actions; use `--local-only` only when the user explicitly wants no live check.
Local index timeline text is bounded at 20,000 characters per item. If `textTruncated` is true,
use `frontctl read CONVERSATION_ID --json` for the freshest available context.
Use `--format markdown` or `--format plain` when the user wants readable output instead of a JSON
object. For structural Markdown queries, optionally use:

```bash
frontctl mq check --json
frontctl mq install --print-only --json
frontctl mq query --query '.h' --input conversation.md --output-format text
```

`frontctl mq install --yes --json` installs `mq` with Homebrew; do not run it without user approval.

Draft commands:

```bash
frontctl draft list --limit 20 --json
frontctl draft read DRAFT_ID --json
frontctl draft reply CONVERSATION_ID --body-file reply.md --json
frontctl draft update CONVERSATION_ID MESSAGE_UID --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft forward CONVERSATION_ID --to person@example.com --body-file note.md --json
frontctl draft compose --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft discard DRAFT_ID --json
frontctl draft discard CONVERSATION_ID MESSAGE_UID --json
frontctl tag list --json
```

`draft list/read` are read-only local IndexedDB scans. `draft reply`, `draft compose/create`,
`draft update`, `draft forward`, and `draft discard` do not send. Standalone compose/create and
forward drafts save through Front's
non-send draft route and return `result.conversationId`, `result.messageUid`, and
`result.discardCommand`. `draft update` requires that conversation id and message uid, plus explicit
recipients/subject, so agents do not guess from stale local draft cache.
Draft writes require preview plus explicit `--yes` and known non-send route verification.
Use the returned discard command to delete the saved draft. Never call `frontctl send`.

Guarded mutation pattern:

```bash
frontctl --dry-run archive CONVERSATION_ID --yes --json
frontctl archive CONVERSATION_ID --actor Codex --reason "User approved archiving this low-priority thread" --json
frontctl unarchive CONVERSATION_ID --actor Codex --reason "User approved restore after archive" --yes --json
frontctl delete CONVERSATION_ID --actor Codex --reason "User approved moving this test thread to trash" --json
frontctl restore CONVERSATION_ID --actor Codex --reason "User approved restoring this test thread" --json
frontctl snooze CONVERSATION_ID tomorrow-9am --actor Codex --reason "User approved follow-up tomorrow" --json
frontctl tag list --json
frontctl tag add CONVERSATION_ID "Needs Reply" --json
frontctl comment add CONVERSATION_ID --body "..." --json
frontctl comment add CONVERSATION_ID --body-file note.md --json
frontctl batch archive --ids-file ids.txt --actor Codex --reason "User approved these archive candidates" --json
frontctl create-test-conversation --subject "frontctl test conversation" --body "Safe local integration test" --json
frontctl audit list --conversation CONVERSATION_ID --json
```

Mutation execution requires `--yes`, an unlocked local session, and known non-send route
verification or a matching sanitized discovery fixture. `--dry-run` forces preview mode even when
`--yes` is present. Drafting previews are allowed; sending is not. Do not use `--yes` unless the
user explicitly asked for that exact state change and `canExecute` is true.
`create-test-conversation` creates a harmless internal task-style test conversation through Front's
non-send comment save/publish route when `canExecute` is true. Delete-to-trash, restore,
assign/unassign, move, follower add/remove, Front conversation link add/remove, tag create,
and numeric-id tag delete are executable routes when `canExecute` is true. Delete-to-trash and
restore use Front's tracker-status route, not ordinary status updates. Custom-field routes are
capture-gated unless `canExecute` is true.
Standalone compose/create drafts, draft updates, and forward drafts are executable when `canExecute` is true.
For `follower remove`, removing the active user can immediately revoke read access on an
unassigned/internal task conversation. By default frontctl refuses active-user self-removal before
writing an identity comment; use `--allow-self-remove` only on a disposable conversation when the
user explicitly accepts possible access loss.
When taking an action, pass `--actor Codex` and a concise `--reason "..."`. For every executable
conversation state change, frontctl itself writes a visible identity comment before the action and
then applies the requested action last. Do not manually add a separate identity comment. Only run
`frontctl comment add` when the user wants an additional internal note beyond the automatic action
trail. If a command fails after writing the identity comment, report the returned comment UID or
activity ID and inspect the thread before retrying.
Use `frontctl audit list --json` when reviewing recent previews or attempts. Audit output is
redacted metadata only: action, mode, route, body keys, and body hash, never raw comment or draft text.
For snooze, inspect `details.normalizedUntil` in the preview and include that exact timestamp in
the user confirmation. Supported shortcuts include `in:30m`, `in:2h`, `later`, `tomorrow`,
`tomorrow-9am`, and weekday forms such as `monday-9am`.
Before `tag add` or `tag remove`, run `frontctl tag list --json` or `frontctl tag list --json`.
Use an alias, id, or unique name from the result, then inspect `details.tag.resolvedAlias` in the
preview. Ambiguous names fail; do not guess.

If `frontctl discovery verify-writes --json` reports a route mismatch, guide the user through
`frontctl discovery browser-status --json` and `frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json`.
`browser-status` only proves a local DevTools endpoint is reachable; `browser-probe` proves whether
the selected browser tab is authenticated to Front. If the probe reports `authentication_required`,
and `frontctl auth check --json` is valid, use
`frontctl discovery browser-seed --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --yes --json`
to copy the existing reusable frontctl session into the selected browser tab without printing
cookie values or touching Keychain. Then rerun `browser-probe`. Use
`frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json`
when browser-backed proof is required; choose `TAG_ID` from `frontctl tag list --json` and do
not guess. If browser seeding is unavailable, ask the user to sign into Front in that browser
profile before relying on browser capture. Then use
`frontctl discovery launch`, ask them to run
`frontctl discovery guide ACTION --json`, ask them to
perform exactly one safe write-like action in Front, then run
`frontctl discovery capture --target-url-contains conversations/CONVERSATION_ID --install --name ACTION --json` and
`frontctl discovery verify-writes --json`. Capture output is sanitized; do not ask the user to paste
cookies, tokens, HAR contents, or raw mailbox payloads.
Use `frontctl discovery verify-live-writes CONVERSATION_ID --yes --json` only when the user wants
proof against a real low-risk conversation. It mutates and verifies archive/unarchive,
delete-to-trash/restore,
assign/unassign, move, follower add, guarded active-user follower-remove refusal,
Front conversation link add/remove, snooze/unsnooze, tag add/remove, comment add/remove, and draft
save/update/discard, then cleans up temporary link/tag/comment/draft artifacts and archives the test
conversations last. The normal mutation layer already leaves visible identity comments before state
changes; `--leave-proof-comment` adds an extra final proof comment only when the user explicitly
wants one.
Use `frontctl discovery relaunch-front --remote-debugging-port 9222 --yes --json` only with explicit
user approval because it quits and reopens Front to enable browser/network capture. It checks the
local draft cache first and refuses when potential drafts are present unless
`--allow-existing-drafts` is passed.
