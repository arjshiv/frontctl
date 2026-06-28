# API And CLI Contract

`frontctl` does not use Front's public API. This document describes the local CLI contract and the
private Front web-route surface that the CLI is allowed to exercise from the user's signed-in local
session.

## Invariants

- Never send email. `frontctl send` is blocked.
- Never print cookies, auth headers, CSRF tokens, signed attachment URLs, or raw discovery payloads.
- Normal current-state reads are live private-session reads, not stale local HTTP cache reads.
- Mutations preview by default and execute only with `--yes`.
- Executable conversation state changes write a visible identity comment first, then apply the
  requested state change last.
- Every mutation attempt writes redacted audit metadata: action, mode, phase, route, body keys, body
  hash, and result hash.

## Auth Sources

`frontctl auth check --json` is non-prompting and should be the first live-read gate. When valid, it
means reads and approved writes can use the reusable local session cache.

`frontctl auth unlock --source default-browser --ttl-hours 720 --json` is the explicit user-approved
fallback. It may ask macOS for Touch ID or the account password once, then writes
`~/.frontctl/session.json` for normal non-prompting use.

The CDP bridge is the browser-runtime path. `browser-status` proves a DevTools endpoint exists,
`browser-probe` proves the selected tab is signed into Front, and `browser-seed` can copy the valid
frontctl session into the selected browser tab without printing cookie values or touching Keychain.

## Read Commands

These commands use the live private session by default:

```bash
frontctl whoami --json
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl search "query" --json
frontctl search ids "query" --limit 20 --json
frontctl read CONVERSATION_ID --json
frontctl read CONVERSATION_ID --full --json
frontctl summarize CONVERSATION_ID --format plain
frontctl attachments list CONVERSATION_ID --json
frontctl resources list inboxes --json
frontctl resources list custom-fields --json
frontctl resources search "person or company" --json
frontctl cards search "person@example.com" --json
frontctl cards read CARD_ID --json
```

Use `--offline-cache` or `frontctl cache ...` only for explicit offline diagnostics, historical
search, or preference learning. Do not use those paths to answer "what is in my inbox right now?"

## Write Commands

Preview first:

```bash
frontctl archive CONVERSATION_ID --actor Codex --reason "Why this should happen" --json
```

Execute only after approval:

```bash
frontctl archive CONVERSATION_ID --actor Codex --reason "User approved archive" --yes --json
```

Live-proven executable actions:

- `archive`, `unarchive`
- `delete`, `restore`
- `snooze`, `unsnooze`
- `assign`, `unassign`
- `move`
- `follower add`
- `follower remove`, with active-user self-removal guarded by default
- `link add`, `link remove`
- `tag add`, `tag remove`
- `tag create`, `tag delete TAG_ID`
- `comment add`, `comment remove`
- `draft compose`, `draft update`, `draft discard`
- `create-test-conversation`

Draft commands save or discard drafts only. They do not send:

```bash
frontctl draft reply CONVERSATION_ID --body-file reply.md --json
frontctl draft compose --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft update CONVERSATION_ID MESSAGE_UID --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft forward CONVERSATION_ID --to person@example.com --body-file note.md --json
frontctl draft discard CONVERSATION_ID MESSAGE_UID --json
```

## Private Route Families

The route registry treats these as known non-send private Front route families:

| Capability | Route family | Notes |
| --- | --- | --- |
| Thread state | `PATCH /conversations` | Archive, unarchive, snooze, unsnooze, assign, unassign, move, tags, followers |
| Trash/restore | tracker status update through `PATCH /conversations` | Uses Front tracker-status semantics, not ordinary status payloads |
| Comments | `/conversations/:id/timeline` | Identity comments and explicit internal notes |
| Comment removal | `/conversations/:id/timeline/:activityId` | Used for cleanup of explicit test comments |
| Links | `/conversation_batch/link` and timeline unlink | Adds/removes Front conversation links |
| Drafts | `/conversations/new/messages/:uid` and `/conversations/:id/messages/:uid` | Save/update/discard only |
| Test thread | `/conversations/new/comments/:uid` then `/conversations/:id/timeline` | Creates an internal task-style conversation, not outbound email |
| Tags | `/tags` and numeric tag delete route | Delete requires a numeric id |
| Cards | `/cards/:id` | Read-only helpers are enabled; card writes are blocked for this session |

Route details are intentionally behind the typed registry and sanitizer. Do not commit raw network
captures or mailbox-specific payloads.

## Custom Fields

Run this before any custom-field work:

```bash
frontctl resources list custom-fields --json
```

Only conversation-scoped fields are candidates for conversation custom-field writes. The observed
`PMS Admin` field is scoped to Front cards. `PATCH /conversations` returned `ok` without persisting
that card field, and `PUT /cards/:id` with `custom_field_attributes` returned HTTP 403 for this
session. `frontctl custom-field set` therefore blocks card-scoped writes until a harmless card write
can execute and read back successfully.

## Live Verification

Use the installed binary for release confidence:

```bash
frontctl create-test-conversation --subject "frontctl live verification" --body "Disposable test thread" --actor Codex --reason "Create test thread" --yes --json
frontctl discovery verify-live-writes CONVERSATION_ID --actor Codex --yes --json
frontctl audit list --conversation CONVERSATION_ID --json
```

The verifier mutates the real disposable thread and should end with:

- `source: live-private`
- `publicApiUsed: false`
- `sendsEmail: false`
- `routeVerification.allVerified: true`
- final state archived
- no reminder, draft, temporary link, or temporary tag marker left behind

## Discovery And Fixtures

Use discovery only when a Front version changes or a new action needs proof:

```bash
frontctl discovery guide ACTION --json
frontctl discovery capture --remote-debugging-port 9222 --target-url-contains conversations/CONVERSATION_ID --reload --duration-ms 15000 --install --name ACTION --json
frontctl discovery verify-writes --json
```

Sanitized fixtures may preserve method, route kind, and JSON body shape. They must not preserve
cookies, headers, query tokens, subjects, message text, email addresses, or signed URLs.
