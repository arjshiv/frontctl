---
name: frontctl
description: Use the local `frontctl` CLI to inspect and manage Front desktop mail from the user's authenticated local Front session. Use when the user asks Claude to read, summarize, search, archive, snooze, tag, comment, or draft replies in Front. Never use the public Front API and never send email.
---

# Frontctl

Use `frontctl` as the only interface for Front mail automation. It uses the user's local Front
desktop session and intentionally does not use the public Front API.

## Start

```bash
frontctl doctor --json
```

If the doctor check fails, explain which local Front dependency is missing and stop.
For setup guidance, run `frontctl onboarding --json`. For a concise non-prompting readiness report,
run `frontctl readiness --json`. For a readiness report plus local skill install, run
`frontctl setup --agent all --yes --json` only when the user asks to install.
When reporting setup state, prefer `userReadiness.ready`, `userReadiness.state`, and
`userReadiness.nextAction` from `frontctl readiness --json`, `frontctl setup --json`, or
`frontctl diagnose --json`.
For live private reads, run `frontctl readiness --json`; if live mode is locked, run
`frontctl setup --enable-live --json` first. The default live path is the CDP browser bridge and
must not touch Keychain or macOS Automation. If that fails, inspect `frontctl bridge status --json`;
if no CDP browser is reachable, use `frontctl discovery launch --remote-debugging-port 9222 --json`
to launch a managed signed-in browser. Ask before running
`frontctl auth unlock --source default-browser --ttl-hours 12 --json` or
`frontctl auth unlock --source front-app --ttl-hours 12 --json` because explicit app/browser unlock
may touch macOS Keychain.
Never rerun unlock just to be safe when `auth check` is valid. `auth unlock` reuses a valid cache,
and `--force` should be used only when the user explicitly wants to refresh the Front cookies.

## Safety

- Never send email.
- Never expose cookies, tokens, auth headers, or raw mailbox payloads.
- Use JSON output for tool-to-tool work.
- Do not mutate state without a dry-run preview unless the user explicitly instructed the exact action.
- Use `--yes` only for an approved or explicitly requested action.
- Draft replies are allowed; final sending is blocked.

## Commands

Diagnostics:

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

Reads:

```bash
frontctl inbox list --limit 20 --json
frontctl inbox list --all --limit 50 --json
frontctl triage inbox --limit 20 --json
frontctl search "query" --json
frontctl read CONVERSATION_ID --json
frontctl read CONVERSATION_ID --format markdown
frontctl summarize CONVERSATION_ID --format plain
frontctl attachments list CONVERSATION_ID --json
frontctl open CONVERSATION_ID --print-only --json
frontctl open CONVERSATION_ID --web --print-only --json
```

Normal read commands are live private-session reads. Do not answer current inbox questions from
Front's stale local HTTP cache. Use `--offline-cache` only for diagnostics, offline recovery, or
tests where stale data is explicitly acceptable.
Use `frontctl open CONVERSATION_ID --print-only --json` to inspect the Front deeplink without
launching. Omit `--print-only` only when the user wants Front opened locally.

Local index:

```bash
frontctl sync --limit 100 --json
frontctl cache stats --json
frontctl cache stats --max-age-hours 6 --json
frontctl cache search "query" --limit 10 --json
frontctl cache read CONVERSATION_ID --json
frontctl cache read CONVERSATION_ID --format markdown
frontctl memory init --limit 500 --json
frontctl memory report --json
frontctl workflows daily --actor Claude --json
```

After `frontctl auth unlock`, prefer `frontctl sync` before broad repeated searches. Then use
`frontctl cache search/read` for fast follow-up work without repeated Front or Keychain access.
Cache stats/search/read include `freshness`; if `freshness.fresh` is false, run
`frontctl sync --limit 100 --json` before relying on the local index.
After first setup or a broad live sync, run `frontctl memory init --limit 500 --json` to create the
local preference profile. Use `frontctl memory report --json` before suggesting archive/tag/snooze
rules. Memory is local-only and stores aggregate signals, not cookies, auth headers, or raw timeline
bodies.
For normal product use, prefer `frontctl workflows daily --actor Claude --json` after memory exists.
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

Drafts:

```bash
frontctl draft list --limit 20 --json
frontctl draft read DRAFT_ID --json
frontctl draft reply CONVERSATION_ID --body-file reply.md --json
frontctl draft compose --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft discard DRAFT_ID --json
frontctl draft discard CONVERSATION_ID MESSAGE_UID --json
frontctl tag list --json
```

`draft list/read` are read-only local IndexedDB scans. `draft reply/discard` do not send;
standalone `draft compose` is preview-only until its private route is captured and implemented.
Draft writes require preview plus explicit `--yes` and known non-send route verification.
`draft reply` returns `result.messageUid` and `result.discardCommand`; use that discard command to
delete the saved draft. Never call `frontctl send`.

Guarded mutation pattern:

```bash
frontctl --dry-run archive CONVERSATION_ID --yes --json
frontctl archive CONVERSATION_ID --actor Claude --reason "User approved archiving this low-priority thread" --json
frontctl unarchive CONVERSATION_ID --actor Claude --reason "User approved restore after archive" --yes --json
frontctl snooze CONVERSATION_ID tomorrow-9am --actor Claude --reason "User approved follow-up tomorrow" --json
frontctl tag list --json
frontctl tag add CONVERSATION_ID "Needs Reply" --json
frontctl comment add CONVERSATION_ID --body "..." --json
frontctl comment add CONVERSATION_ID --body-file note.md --json
frontctl draft reply CONVERSATION_ID --body "..." --json
frontctl audit list --conversation CONVERSATION_ID --json
```

Mutation execution requires `--yes`, an unlocked local session, and known non-send route
verification or a matching sanitized discovery fixture. `--dry-run` forces preview mode even when
`--yes` is present. Do not use `--yes` unless the user explicitly asked for that exact state change
and `canExecute` is true.
When taking an action, pass `--actor Claude` and a concise `--reason "..."`. This records identity
in the frontctl preview and audit log. Do not add a Front comment just to identify yourself; comments
can alter thread state, including archived/snoozed workflows. Only run `frontctl comment add` when
the user explicitly wants a visible internal Front comment. If the user wants both a visible comment
and an archive/snooze, add the comment first, then run the archive/snooze last so the final state is
the intended state.
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
to copy the existing short-lived frontctl session into the selected browser tab without printing
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
snooze/unsnooze, tag add/remove, comment add/remove, and reply draft/discard, then cleans up
temporary artifacts and archives the conversation last. Add `--leave-proof-comment` only when the
user explicitly wants a visible Front comment left behind.
Use `frontctl discovery relaunch-front --remote-debugging-port 9222 --yes --json` only with explicit
user approval because it quits and reopens Front to enable browser/network capture. It checks the
local draft cache first and refuses when potential drafts are present unless
`--allow-existing-drafts` is passed.
