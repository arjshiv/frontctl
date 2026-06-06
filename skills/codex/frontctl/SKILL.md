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
For live private reads, run `frontctl auth check --json`; if it is not valid, inspect
`frontctl browser list --json` and prefer
`frontctl auth unlock --source default-browser --ttl-hours 12 --json` when the user is signed into
Front in Chrome or Microsoft Edge. Otherwise ask before running
`frontctl auth unlock --source front-app --ttl-hours 12 --json` because the first unlock may touch
macOS Keychain.
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
frontctl discovery guide --json
frontctl discovery guide ACTION --json
frontctl discovery capture --remote-debugging-port 9222 --duration-ms 15000 --install --name ACTION --json
frontctl discovery sanitize --input capture.har --output sanitized.json --json
frontctl discovery fixtures install sanitized.json --json
frontctl discovery verify-writes --json
frontctl audit list --json
```

Read commands:

```bash
frontctl inbox list --limit 20 --json
frontctl inbox list --all --limit 50 --json
frontctl triage inbox --limit 20 --json
frontctl search "query" --json
frontctl read CONVERSATION_ID --json
frontctl read CONVERSATION_ID --format markdown
frontctl summarize CONVERSATION_ID --format plain
frontctl inbox list --live --limit 20 --json
frontctl triage inbox --live --limit 20 --json
frontctl search "query" --live --json
frontctl read CONVERSATION_ID --live --json
frontctl summarize CONVERSATION_ID --live --json
frontctl attachments list CONVERSATION_ID --live --json
frontctl open CONVERSATION_ID --print-only --json
frontctl open CONVERSATION_ID --web --print-only --json
```

Read results may be marked `stale: true` when they come from Front's local HTTP cache. If the inbox
cache is empty, ask the user to open the relevant view in Front, then rerun the command.
Use `frontctl open CONVERSATION_ID --print-only --json` to inspect the Front deeplink without
launching. Omit `--print-only` only when the user wants Front opened locally.

Local index commands:

```bash
frontctl sync --live --limit 100 --json
frontctl cache stats --json
frontctl cache stats --max-age-hours 6 --json
frontctl cache search "query" --limit 10 --json
frontctl cache read CONVERSATION_ID --json
frontctl cache read CONVERSATION_ID --format markdown
```

After `frontctl auth unlock`, prefer `frontctl sync --live` before broad repeated searches. Then use
`frontctl cache search/read` for fast follow-up work without repeated Front or Keychain access.
Cache stats/search/read include `freshness`; if `freshness.fresh` is false, run
`frontctl sync --live --limit 100 --json` before relying on the local index.
Local index timeline text is bounded at 20,000 characters per item. If `textTruncated` is true,
use `frontctl read CONVERSATION_ID --live --json` for the freshest available context.
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
frontctl draft compose --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft discard DRAFT_ID --json
frontctl tag list --json
```

`draft list/read` are read-only local IndexedDB scans. `draft reply/compose/discard` do not send;
compose accepts optional `--to`, `--cc`, `--bcc`, and `--subject` fields for draft creation. Draft
writes require preview plus explicit `--yes` and known non-send route verification. Never call
`frontctl send`.

Guarded mutation pattern:

```bash
frontctl --dry-run archive CONVERSATION_ID --yes --json
frontctl archive CONVERSATION_ID --json
frontctl archive CONVERSATION_ID ANOTHER_CONVERSATION_ID --yes --json
frontctl snooze CONVERSATION_ID tomorrow-9am --json
frontctl tag list --json
frontctl tag add CONVERSATION_ID "Needs Reply" --json
frontctl comment add CONVERSATION_ID --body "..." --json
frontctl comment add CONVERSATION_ID --body-file note.md --json
frontctl audit list --conversation CONVERSATION_ID --json
```

Mutation execution requires `--yes`, an unlocked local session, and known non-send route
verification or a matching sanitized discovery fixture. `--dry-run` forces preview mode even when
`--yes` is present. Drafting previews are allowed; sending is not. Do not use `--yes` unless the
user explicitly asked for that exact state change and `canExecute` is true.
Use `frontctl audit list --json` when reviewing recent previews or attempts. Audit output is
redacted metadata only: action, mode, route, body keys, and body hash, never raw comment or draft text.
For snooze, inspect `details.normalizedUntil` in the preview and include that exact timestamp in
the user confirmation. Supported shortcuts include `in:30m`, `in:2h`, `later`, `tomorrow`,
`tomorrow-9am`, and weekday forms such as `monday-9am`.
Before `tag add` or `tag remove`, run `frontctl tag list --json` or `frontctl tag list --live --json`.
Use an alias, id, or unique name from the result, then inspect `details.tag.resolvedAlias` in the
preview. Ambiguous names fail; do not guess.

If `frontctl discovery verify-writes --json` reports a route mismatch, guide the user through
`frontctl discovery launch`, ask them to run `frontctl discovery guide ACTION --json`, ask them to
perform exactly one safe write-like action in Front, then run
`frontctl discovery capture --install --name ACTION --json` and
`frontctl discovery verify-writes --json`. Capture output is sanitized; do not ask the user to paste
cookies, tokens, HAR contents, or raw mailbox payloads.
