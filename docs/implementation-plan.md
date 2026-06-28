# Front Local CLI Implementation Plan

## Goal

Build `frontctl`, a local-session CLI for managing Front desktop email from the authenticated
macOS Front app profile. This project intentionally avoids the public Front API because that API
does not cover personal inbox workflows.

The CLI should eventually support reading, summarizing, archiving, snoozing, drafting replies,
commenting, tagging, opening conversations, and searching. Sending email is explicitly out of
scope until a future user decision changes that.

## Current Local Findings

- Front desktop app path: `/Applications/Front.app`
- Bundle identifier: `com.frontapp.Front`
- Observed version during planning: `3.73.0`
- App implementation: Electron with `Contents/Resources/app.asar`
- Main web app origin: `https://app.frontapp.com` or a saved Front company subdomain
- Local profile path: `~/Library/Application Support/Front`
- Local auth/state stores:
  - `Cookies`
  - `Local Storage/leveldb`
  - `IndexedDB/https_app.frontapp.com_0.indexeddb.leveldb`
- Registered URL schemes:
  - `front`
  - `frontapp`
  - `mailto-frontapp`
  - `frontapp-mailto`

Do not commit private mailbox payloads, cookie values, bearer tokens, screenshots containing
private mail, or raw network captures.

## Architecture

`frontctl` should use four transports, in this order:

1. **Private web transport**
   - Read the local Electron cookie profile.
   - Use the authenticated Front web session to call the same private endpoints Front uses.
   - Keep endpoint details behind a route registry.

2. **Local cache**
   - Store normalized conversation/message metadata, summaries, and audit entries.
   - Use SQLite with FTS once read paths exist.

3. **Deeplink transport**
   - Use `front:` and `frontapp:` schemes for opening Front UI state.
   - Useful for manual verification and operations that have stable links.

4. **UI fallback**
   - Use only where private endpoints are not available or are too expensive to discover.
   - Require explicit command support and tests because UI selectors are brittle.

## Inspiration

- Bird: cookie auth, private web endpoints, human output by default, `--json`/`--plain` for scripts,
  and a diagnostic auth command. Bird documents that it uses existing browser sessions and private
  GraphQL endpoints that can break without notice.
- birdclaw: local-first normalized SQLite store, FTS search, scriptable JSON for agents, and
  transport separation where live cookie-backed reads are one layer under a local model.
- Himalaya: backend abstraction around mailboxes, envelopes, flags, messages, attachments, and
  JSON output.
- notmuch: fast local search, thread/message/tag outputs, and stable JSON output modes.
- aerc: terminal-native email workflows and composition ergonomics.

References:

- https://bird.fast/
- https://skills.sh/openclaw/openclaw/bird
- https://github.com/steipete/birdclaw
- https://github.com/pimalaya/himalaya
- https://notmuchmail.org/doc/latest/man1/notmuch-search.html
- https://notmuchmail.org/doc/latest/man7/notmuch-search-terms.html
- https://aerc-mail.org/

## Milestones

### M0: Read-only Foundation

Implemented first:

- `frontctl doctor`
- `frontctl front inspect`
- `frontctl cookies inspect`
- `frontctl asar inspect`
- `frontctl onboarding`
- Guarded placeholders for archive/snooze/tag/comment/draft
- Always-blocked `send`
- Codex and Claude skill docs

No endpoint calls, no cookie decryption, no mailbox reads, no mutations.

### M1: Auth Proof

Implemented:

- Added a macOS Electron/Chromium cookie decryptor for Front cookies.
- Strips Chromium's host-key digest prefix before constructing cookie headers.
- `frontctl auth unlock` performs the explicit Keychain step once and writes a reusable encrypted
  `0600` session cache.
- `frontctl auth check` is non-prompting.
- `frontctl whoami` proves authenticated private Front reads work.
- Tests cover digest stripping and non-prompting auth status.

### M2: Endpoint Discovery

Implemented:

- Added `frontctl discovery capture --remote-debugging-port <port>`.
- Added `frontctl discovery launch --remote-debugging-port <port>` to start a separate Front
  instance with DevTools discovery enabled.
- Added `frontctl discovery capture --install --name ACTION` to write sanitized capture output
  directly into the local fixture store.
- Added `frontctl discovery sanitize --input capture.har --output sanitized.json`.
- Sanitizer redacts query strings, cookies, auth headers, body values, mailbox text, subjects,
  names, and email addresses while preserving route kind and JSON body shape.
- Route-kind detection covers inbox/search/timeline/message/archive/snooze/tag/comment candidates.
- Write execution is gated by sanitized discovery fixtures installed in the local fixture store.
- `frontctl discovery fixtures path|list|install` manages sanitized fixture storage.
- `frontctl discovery guide [ACTION]` provides action-specific safe Front actions, preview
  commands, capture commands, and verification status.
- `frontctl discovery verify-writes --json` reports deployable v1 write coverage for thread
  actions, move/follower-add/remove, non-send drafts, and internal test-conversation creation.
  Delete-to-trash and restore remain blocked until a real Front private route is captured and
  live verified.
- `frontctl discovery verify-live-writes CONVERSATION_ID --yes --json` runs the deployable write
  set against real low-risk test conversations, verifies state after each mutation, creates a
  disposable link target when needed, cleans up temporary link/tag/comment/draft artifacts, and
  archives the test conversations last. Active-user `follower remove` is verified as a guarded
  refusal before any identity comment because Front can reject or revoke access for self-removal.
- `frontctl discovery browser-status --json` discovers fixed and dynamic Chrome/Edge DevTools
  ports without printing process command lines or profile paths.
- `frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json`
  proves whether the selected browser tab is authenticated to Front. CDP reachability alone is not
  enough.
- `frontctl discovery browser-seed --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --yes --json`
  copies the existing reusable `frontctl` session into the selected browser tab, including CSRF,
  without printing cookie values or touching Keychain again.
- `frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json`
  runs the deployable write set from inside the authenticated browser runtime, cleans up temporary
  tag/comment/draft/reminder state, and archives the conversation last.
- Sanitized request body shapes preserve redacted keys and types so write fixtures can prove payload
  shape without leaking message content.

Optional maintenance path:

- The built-in known route contract covers the supported non-send write routes for the observed
  Front 3.73.0 local app. If a future Front version changes route or payload shape, recapture and
  install sanitized write fixtures for archive, snooze, move, follower add/remove, tag add/remove,
  comment add, and draft create/update/discard.
- Use strict fixture mode only when validating a new local Front version against freshly captured
  fixtures.

### M3: Read Model

Implemented:

- `frontctl whoami --json` live private read.
- `frontctl inbox list` private live read by default.
- `frontctl inbox list --offline-cache` explicit stale diagnostic read.
- `frontctl search` private live read by default.
- `frontctl search --offline-cache` explicit stale diagnostic read.
- `frontctl read` private live timeline read by default.
- `frontctl read --offline-cache` explicit stale diagnostic timeline read.
- `frontctl summarize` private live deterministic summary by default.
- `frontctl summarize --offline-cache` explicit stale diagnostic summary.
- `frontctl triage inbox` private live inbox action buckets for agent workflows.
- `frontctl triage inbox --offline-cache` explicit stale diagnostic action buckets.
- `frontctl inbox list|search|read|summarize --format markdown|plain` readable renderers for
  chat and terminal workflows.
- `frontctl mq check|install|query|example` optional integration with `harehare/mq` for structural
  Markdown querying.
- `frontctl open CONVERSATION_ID --print-only|--web` target construction.
- `frontctl open CONVERSATION_ID` launches Front deeplinks through macOS `open`; tests cover
  injected launch behavior without opening the app.
- Route discovery preserves `app.frontapp.com` and saved company Front subdomains.
- `frontctl setup --json` install/readiness report.
- `frontctl readiness --json` concise non-prompting user readiness report.
- `frontctl agents check|paths|install --agent codex|claude|all` first-class local skill installer
  for Codex/ChatGPT and Claude.
- `frontctl sync` normalized local index build from private live reads.
- `frontctl sync --offline-cache` explicit stale local index build from cached Front data.
- Local index preserves bounded timeline text up to 20,000 characters per item with `textLength`
  and `textTruncated` metadata.
- `frontctl cache stats` local index stats.
- `frontctl cache search QUERY` local FTS search.
- `frontctl cache read CONVERSATION_ID` local indexed conversation read.
- `frontctl cache stats|search|read --max-age-hours N` freshness policy and stale guidance for
  local index reads.
- `frontctl attachments list CONVERSATION_ID` sanitized private live attachment metadata.
- `frontctl attachments list CONVERSATION_ID --offline-cache` explicit stale cached attachment metadata.
- Attachment metadata is indexed into SQLite without signed URLs or tokens.
- `frontctl draft list --limit N` read-only scan of Front local IndexedDB draft records.
- `frontctl draft read DRAFT_ID` read-only local draft inspection.
- `frontctl tag list [--live]` sanitized tag catalog listing for discovering usable tag aliases.

Future enhancement:

- The local SQLite index intentionally stores bounded timeline text with truncation metadata.
  Exact full-body offline archival can be added later if a workflow needs complete bodies without a
  live read.

### M4: Safe Mutations

Implemented behind known-route gates:

- `frontctl archive CONVERSATION_ID` dry-run preview; `--yes` requires known non-send route
  verification or a matching sanitized fixture.
- `frontctl tag add|remove CONVERSATION_ID TAG` dry-run preview with catalog-backed alias/id/name
  resolution; `--yes` requires known non-send route verification or a matching sanitized fixture.
- `frontctl comment add CONVERSATION_ID --body "..."|--body-file note.md` dry-run preview;
  `--yes` requires known non-send route verification or a matching sanitized fixture.
- `frontctl snooze CONVERSATION_ID UNTIL` dry-run preview with normalized `details.normalizedUntil`;
  `--yes` requires known non-send route verification or a matching sanitized fixture.
- `frontctl audit list [--action ACTION] [--conversation ID] [--mode dry-run|execute]` inspects
  recent redacted mutation previews and attempts.
- Mutation audit JSONL logs route/body hashes, not raw comment/draft text.
- Fixture-backed and known-route tests cover previews, execution gates, mocked private execution,
  and audit redaction.

Future maintenance:

- Recapture sanitized local fixtures only when a future Front version changes route or payload shape.

### M5: Drafts, No Send

Implemented behind non-send route gates:

- `frontctl draft reply CONVERSATION_ID --body "..."` dry-run preview; `--yes` requires known
  non-send route verification or a matching sanitized fixture.
- `frontctl draft reply CONVERSATION_ID --body-file reply.md` dry-run preview; `--yes` requires
  known non-send route verification or a matching sanitized fixture.
- `frontctl draft compose --to EMAIL --subject "..." --body "..."` dry-run preview; `--yes` saves a
  standalone draft through Front's non-send draft route and returns a discard command.
- `frontctl draft update CONVERSATION_ID MESSAGE_UID --to EMAIL --subject "..." --body "..."`
  dry-run preview; `--yes` updates that existing draft through Front's conversation-scoped
  non-send draft route and returns a discard command.
- `frontctl create-test-conversation --subject "..." --body "..."` dry-run preview; `--yes` creates a
  harmless internal task-style conversation for live write testing.
- `frontctl draft list --limit N` local IndexedDB draft scan.
- `frontctl draft read DRAFT_ID` local IndexedDB draft read.
- `frontctl draft discard DRAFT_ID` resolves cached draft message UIDs and can become executable
  when it can resolve the cached draft message UID and verify the non-send route.
- `frontctl draft discard CONVERSATION_ID MESSAGE_UID` deletes a known draft message UID returned
  from `frontctl draft reply --yes`, `frontctl draft compose --yes`, or `frontctl draft update --yes`.
- `frontctl send` remains hard blocked.
- Route-level tests prove no send/finalize/deliver endpoint is exposed.

Future maintenance:

- Improve cached draft discovery if Front changes its IndexedDB draft storage layout.

## Command Contract

Global flags:

- `--json`: machine-readable output
- `--plain`: no styled object inspection
- `--no-color`: no terminal colors
- `--dry-run`: force mutation preview; can appear before or after the command
- `--yes`: required for mutation execution, and ignored when `--dry-run` is also present

Baseline command shape:

```bash
frontctl doctor --json
frontctl readiness --json
frontctl front inspect --json
frontctl cookies inspect --json
frontctl asar inspect --json
frontctl send
```

Main workflow command shape:

```bash
frontctl whoami --json
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl search "from:alice newer:7d" --json
frontctl read cnv_123 --format markdown
frontctl mq query --query '.h' --input conversation.md --output-format text
frontctl sync --limit 100 --json
frontctl cache search "alice" --json
frontctl attachments list cnv_123 --json
frontctl discovery sanitize --input capture.har --output sanitized.json --json
frontctl discovery fixtures install sanitized.json --json
frontctl discovery verify-writes --json
frontctl discovery verify-live-writes CONVERSATION_ID --yes --json
frontctl discovery browser-status --remote-debugging-port 9222 --json
frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json
frontctl discovery browser-seed --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --yes --json
frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json
frontctl audit list --json
frontctl draft list --limit 20 --json
frontctl draft read draft_123 --json
frontctl archive cnv_123 --dry-run
frontctl snooze cnv_123 tomorrow-9am --yes
frontctl tag list --json
frontctl tag add cnv_123 "Needs Reply" --yes
frontctl comment add cnv_123 --body-file note.md --yes
frontctl draft reply cnv_123 --body-file reply.md --yes
frontctl draft compose --to alice@example.com --subject "Draft subject" --body-file draft.md
frontctl draft discard draft_123 --yes
frontctl open cnv_123
```

## Safety Rules

- Public Front API is not the product path.
- Never send email.
- Never print cookie values, auth headers, or raw mailbox payloads by default.
- Do not mutate Front state until the route is covered by a known non-send contract or sanitized
  local fixture, and tests cover the command.
- All mutating commands must default to preview, then require `--yes`.
- Every mutation must write an audit record.
- Audit inspection must show redacted metadata only, never raw body text.
- Every private route must live behind a typed route registry.
- Endpoint discovery fixtures must be sanitized before commit.

## Test Strategy

- Unit-test parsers, redactors, route registry, and output schemas.
- Fixture-test private endpoint clients.
- Add mutation tests that assert `--dry-run` does not call write endpoints.
- Add send-block tests that fail if any route name/path resembles send/finalize/deliver.
- Run `npm run test:readonly` to exercise the agent-facing read-only CLI matrix and assert JSON
  output stays secret-free.
- Add local smoke tests:
  - `frontctl doctor --json`
  - `frontctl cookies inspect --json`
  - `frontctl asar inspect --json`

## Completion Audit

The M0-M5 plan is complete for the current supported scope:

- Local Front app/profile detection: `frontctl doctor --json`.
- Concise user-facing setup readiness: `frontctl readiness --json`.
- Non-prompting auth status plus one-time unlock cache: `frontctl auth check|unlock --json`.
- Live personal-inbox reads without the public Front API:
  `frontctl whoami|inbox list|search|read|summarize`.
- Explicit offline/debug cache reads, local SQLite/FTS index, freshness metadata, and draft
  inspection: `--offline-cache`, `frontctl sync --offline-cache`, `frontctl cache ...`, and
  `frontctl draft list|read`.
- Agent triage and readable output:
  `frontctl triage inbox`, plus `--format markdown|plain` on read/search/list/summary commands.
- Optional Markdown querying: `frontctl mq check|install|query|example`.
- Safe non-send mutations:
  `frontctl archive`, `snooze`, `move`, `follower add|remove`, `link add|remove`,
  `tag create|delete|add|remove`, `comment add`, `draft reply|compose|forward|discard`.
- `follower remove` can intentionally revoke the active user's read access when used on an
  unassigned/internal task conversation where that user is the only tracker. The CLI now refuses
  active-user self-removal before writing an identity comment unless `--allow-self-remove` is
  passed; keep the conversation id and treat a later 403 as likely evidence that access was removed.
- Mutation safety: dry-run by default, `--yes` required for execution, route verification required,
  audit records are redacted, and `frontctl send` is hard blocked.
- Local agent installation: `frontctl setup --agent all --yes --json` and
  `frontctl agents check|paths|install`.

Verification commands:

```bash
npm run check
npm test
node dist/src/cli.js help --json
node dist/src/cli.js discovery verify-writes --json
node dist/src/cli.js auth check --json
node dist/src/cli.js inbox list --limit 5 --json
node dist/src/cli.js triage inbox --limit 5 --json
npm pack --dry-run
```

Known non-goals for this plan:

- Sending email.
- Using the public Front API.
- Guessing new private mutation routes without local route evidence, sanitized fixtures, and tests.
- Storing raw cookie values, auth headers, signed attachment URLs, or raw network captures.

Custom-field follow-up:

- Front's bundled runtime has two custom-field paths. Conversation-scoped fields use
  `custom_attributes.add` on `PATCH /conversations`, but the observed `PMS Admin` field is
  `resource_type: "card"`.
- Installed/browser-seeded `frontctl` confirmed `PATCH /conversations` returns `ok` without
  persisting the card field. The browser runtime also confirmed the card path:
  `GET /cards/:id` exposes `custom_field_attributes`, while `PUT /cards/:id` with
  `custom_field_attributes` returned HTTP 403 for this session.
- `frontctl cards search QUERY --json` and `frontctl cards read CARD_ID --json` are read-only live
  helpers for this card path. They are useful for proving card/contact identity and reading
  card-scoped custom fields without attempting the blocked card write.
- Keep `custom-field set` blocked for non-conversation fields. Do not promote card custom-field
  writes until a harmless card-scoped route can execute and read back successfully.

Tag creation follow-up:

- Front's bundled runtime creates tags with `POST /tags`; installed `frontctl` live-tested
  disposable tag `frontctl-test-delete-me-2026-06-28` and received created tag id `224924561`.
- Tag add/remove was then verified against dedicated test conversation `96869189969`.
- Tag deletion is implemented as `frontctl tag delete TAG_ID --yes`; use clearly disposable tag names
  and numeric ids for cleanup.
