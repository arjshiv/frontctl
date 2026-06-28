# Onboarding

This is the intended setup flow for a non-technical user who wants Claude, ChatGPT, or Codex to
manage Front mail through `frontctl`.

## Plain-English Promise

`frontctl` uses the Front desktop app you are already signed into. You should not need a Front API
token, a developer account, or a team inbox API workaround.

The assistant must not send email. Drafting is allowed when that feature exists, but final sending
is blocked.

## User Flow

### 1. Install and Sign In to Front

Install the normal Front desktop app for macOS. Open it and sign in.

The user should not need to find cookies, paste tokens, or create API keys.

### 2. Install `frontctl`

Preferred non-technical install after release:

1. Download the signed `frontctl` DMG.
2. Open it and run the installer package.
3. Open `Frontctl Setup.app`.
4. Click **Check Setup**, **Install Agent Skills**, then **Unlock Live Session**.

Current local install from this repo:

```bash
npm install
npm run build
npm link
frontctl doctor
frontctl setup --agent all --yes --json
```

Recommended npm install after publishing:

```bash
npm install -g frontctl
frontctl doctor
frontctl setup --agent all --yes --json
```

Without `npm link`, a technical user can run the built CLI directly:

```bash
node dist/src/cli.js doctor
```

Future Homebrew install:

```bash
brew install frontctl
```

### 3. Run the Setup Check

```bash
frontctl doctor
```

Good result:

- Front is installed.
- Front local profile exists.
- Front cookies DB exists.
- The CLI can inspect the local cache for read-only inbox workflows.

If this fails, the app should explain the next simple action: install Front, open Front, or sign in.

For support, generate a redacted bundle:

```bash
frontctl diagnose --output frontctl-support.json --json
```

The support bundle does not include cookie values, auth headers, mailbox bodies, email subjects, or
signed attachment URLs.

### 4. Install the Agent Skill

Check which local assistant skills can be installed:

```bash
frontctl agents check --json
```

Then install the appropriate skill:

```bash
frontctl setup --agent all --yes --json
frontctl agents install --agent codex --yes --json
frontctl agents install --agent claude --yes --json
frontctl agents prompt --agent chatgpt --json
```

Codex and Claude use local skill files. ChatGPT uses pasteable instructions instead; paste the
`frontctl agents prompt --agent chatgpt --json` output into a ChatGPT session only when that session
has local terminal or Codex-style command execution access on this Mac.

Use `frontctl setup --agent all --yes --json` for the one-command readiness check plus Codex/Claude
skill install. Without `--yes`, setup and agent install commands are dry runs that print the source
and destination paths without copying anything.

The skill tells the agent:

- use `frontctl`, not the public Front API
- run `frontctl doctor --json` first
- never send email
- do not print cookies or tokens
- use JSON output for reliable automation

### 5. Ask the Assistant to Verify Setup

Example prompt:

```text
Use frontctl. Check whether you can see my local Front app and tell me if setup is ready.
Do not read my email yet.
```

The assistant should run:

```bash
frontctl doctor --json
```

Then, if needed:

```bash
frontctl cookies inspect --json
```

The assistant should summarize readiness without printing cookie values.

### 5b. Unlock Live Session

For live private Front requests, prefer one explicit unlock that writes a reusable local session
cache:

```bash
frontctl auth unlock --source default-browser --ttl-hours 720 --json
```

Explicit app/browser unlock may ask for macOS Keychain access once because it reads browser or app
Safe Storage. Rerunning `frontctl auth unlock` while the cache is valid reuses the cache and does not
touch Keychain. Use `frontctl auth unlock --force --ttl-hours 720 --json` only when the cached Front
session has expired or you need to refresh it deliberately.

The CDP browser bridge is optional and mostly useful for development/debugging when a browser is
launched with remote debugging:

```bash
frontctl setup --enable-live --json
frontctl bridge status --json
```

If no CDP browser is reachable, the setup app may show one instruction: launch a managed Edge or
Chrome window, sign into Front, then retry.

```bash
frontctl discovery launch --remote-debugging-port 9222 --json
```

Apple Events are a fallback/debug path only. They are not the consumer onboarding path.

`--source default-browser` auto-detects Chrome or Microsoft Edge from macOS Launch Services and
uses the signed-in browser profile. Safari is open-only for the MVP; use optional `agentcookie`
support or a future signed helper for cookie/session import.

Check it later without prompting, and inspect the prompt/security model:

```bash
frontctl auth check --json
frontctl auth security --json
```

For a complete readiness report:

```bash
frontctl readiness --json
frontctl setup --json
frontctl setup --agent all --yes --json
```

`readiness` is the shortest non-prompting check for setup gates. `setup` returns the same
`userReadiness.ready`, `userReadiness.state`, and `userReadiness.nextAction` fields plus installer
and agent details. Agents and support tools should prefer those fields when explaining what the
user needs to do next.

### 5c. Optional Write-Route Discovery

Mutations stay in preview mode unless the user explicitly approves the exact action with `--yes`.
Standard non-send write routes use frontctl's built-in route contract. To recapture route shapes for
a new Front version or strict local verification, launch Front with DevTools discovery enabled:

```bash
frontctl discovery launch --remote-debugging-port 9222 --json
frontctl discovery guide comment.add --json
```

In Front, perform exactly one safe write-like action, such as adding a private comment or applying a
test tag. Then capture and install only the sanitized route shape:

```bash
frontctl discovery capture --remote-debugging-port 9222 --duration-ms 15000 --install --name comment --json
frontctl discovery verify-writes --json
```

The installed fixture stores method, route shape, and request body shape. It does not store cookies,
auth headers, query tokens, email text, subjects, email addresses, or signed attachment URLs.
Use `frontctl discovery guide --json` to see route coverage, safe Front actions, preview commands,
and capture commands. Set `FRONTCTL_REQUIRE_DISCOVERY_FIXTURES=1` only when you want fixture-only
write execution.

### 6. First Read-Only Inbox Check

After setup is ready, the assistant can run live private-session reads:

```bash
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
frontctl search "customer name" --json
frontctl read CONVERSATION_ID --json
frontctl summarize CONVERSATION_ID --json
frontctl attachments list CONVERSATION_ID --json
frontctl open CONVERSATION_ID --print-only --json
frontctl open CONVERSATION_ID --web --print-only --json
```

If these commands cannot reach a live session, setup is not ready. Do not answer current inbox
questions from Front's local HTTP cache. Use `--offline-cache` only for diagnostics, offline
recovery, or tests where stale data is explicitly acceptable.

For explicit historical search or preference learning, build a local index after live unlock:

```bash
frontctl sync --limit 100 --json
frontctl cache stats --json
frontctl cache stats --max-age-hours 6 --json
frontctl cache search "customer name" --limit 10 --json
frontctl cache read CONVERSATION_ID --json
frontctl cache read CONVERSATION_ID --format markdown
```

The index lives at `~/.frontctl/frontctl.sqlite`. It stores normalized conversation metadata and
timeline snippets so agents can search without hitting Front or macOS Keychain every time. It does
not store cookies or auth headers.
Timeline text is preserved up to 20,000 characters per item and marks clipped items with
`textTruncated` plus `textLength`, so agents can tell when they need a live read for full context.
Cache stats/search/read include freshness metadata. Do not use cache or local-index reads for
current inbox questions unless the user explicitly asks for offline diagnostics.

For first-run preference learning after setup:

```bash
frontctl sync --all --limit 200 --json
frontctl memory init --limit 500 --json
frontctl memory report --json
frontctl workflows daily --actor Claude --json
```

`memory init` writes `~/.frontctl/memory.json`. It is local-only and stores aggregate hypotheses:
what looks like fast archive material, what tends to stay open, where tags might help, and which
local sources were synced. It does not store cookies, auth headers, or raw timeline bodies. Agents
should present memory output as suggestions, not autonomous rules.
`workflows daily` is the default agent-friendly view over that memory and store data. When live
mode is unlocked, it verifies the current inbox before proposing open-thread actions so archived
threads do not reappear from stale local rows. Use `--local-only` only when live verification is not
wanted. It returns daily triage, noise review, follow-up, tag hygiene, and ops/risk queues with
preview commands.

For readable output in chat or terminals:

```bash
frontctl inbox list --format markdown
frontctl triage inbox --format markdown
frontctl read CONVERSATION_ID --format markdown
frontctl summarize CONVERSATION_ID --format plain
```

Optional Markdown querying is available through `mq`:

```bash
frontctl mq check --json
frontctl mq install --print-only --json
frontctl read CONVERSATION_ID --format markdown > conversation.md
frontctl mq query --query '.h' --input conversation.md --output-format text
```

`mq` is optional. Installation requires `frontctl mq install --yes --json`; without `--yes`, the
command only prints the Homebrew install command.

Draft and discovery helpers:

```bash
frontctl draft list --limit 20 --json
frontctl draft read DRAFT_ID --json
frontctl draft reply CONVERSATION_ID --body-file reply.md --json
frontctl draft compose --to person@example.com --subject "Draft subject" --body-file draft.md --json
frontctl draft discard CONVERSATION_ID MESSAGE_UID --json
frontctl tag list --json
frontctl audit list --json
frontctl discovery sanitize --input capture.har --output sanitized.json --json
frontctl discovery fixtures install sanitized.json --json
frontctl discovery browser-status --remote-debugging-port 9222 --json
frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port 9222 --target-url-contains conversations/CONVERSATION_ID --json
frontctl discovery browser-seed --remote-debugging-port 9222 --target-url-contains conversations/CONVERSATION_ID --yes --json
frontctl discovery relaunch-front --remote-debugging-port 9222 --json
frontctl discovery verify-writes --json
frontctl discovery verify-live-writes CONVERSATION_ID --yes --json
frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json
```

Draft list/read are local read-only IndexedDB scans. Draft reply returns `result.messageUid` and
`result.discardCommand` for deleting the saved draft. Standalone draft compose accepts optional
`--to`, `--cc`, `--bcc`, and `--subject` fields and saves through Front's non-send draft route when
`--yes` is explicitly approved. Reply draft, standalone compose, discard, and test-conversation
commands default to preview and require explicit `--yes` before they can write through Front's
private routes. Optional endpoint discovery must write sanitized fixtures only; do not share raw HAR
files.
`frontctl discovery verify-writes --json` reports the deployable v1 thread-action scope separately
from preview-only commands. A ready install should show `allVerified: true` and an empty
`blockedActions` list.
`frontctl discovery verify-live-writes CONVERSATION_ID --yes --json` mutates one real low-risk
conversation to prove those actions work live, then cleans up temporary tag/comment/draft artifacts
and archives the conversation last. Normal state-changing commands already write a visible identity
comment before each action; use `--leave-proof-comment` only when the user wants an extra final
proof comment inside Front.
If browser capture is unavailable, `frontctl discovery browser-status --json` reports whether the
local DevTools endpoint is reachable and whether Front or Edge were launched with remote debugging.
If it finds a usable browser port, run `frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json`
before capturing routes. The probe distinguishes an attachable browser from an authenticated Front
browser session and reports `authentication_required` without printing cookies, headers, or message
body text.
When `auth check` is valid but the browser profile is not authenticated, `frontctl discovery browser-seed --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --yes --json`
can copy the existing reusable `frontctl` session into the selected browser tab without printing
cookie values or touching Keychain. After the probe is authenticated, use
`frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json`
to prove archive/unarchive, snooze/unsnooze, tag add/remove, comment add/remove, and reply
draft/discard from the browser runtime itself. Move, follower-add, and Front conversation
link add/remove use guarded private routes and should be proven on dedicated test conversations.
Only with user approval, `frontctl discovery relaunch-front --remote-debugging-port 9222 --yes --json`
quits and reopens Front with remote debugging enabled for browser/network capture. It checks the
local draft cache first and requires `--allow-existing-drafts` if potential drafts are present.
Tag list returns sanitized tag metadata only. Use it before `tag add` or `tag remove` so the
assistant does not guess. Tag mutations accept an alias, id, or unique name and show
`details.tag.resolvedAlias` in preview; ambiguous names fail.
Audit list returns recent mutation previews and attempts with only redacted route/body metadata.
Use it to review what an assistant previewed or attempted without exposing raw comment or draft text.

Mutation execution requires explicit approval and known non-send route verification:

```bash
frontctl discovery fixtures path --json
frontctl discovery fixtures install sanitized.json --json
frontctl discovery verify-writes --json
frontctl archive CONVERSATION_ID --actor Claude --reason "User approved archive" --json
frontctl unarchive CONVERSATION_ID --actor Claude --reason "User approved restore after archive" --json
frontctl snooze CONVERSATION_ID tomorrow-9am --actor Claude --reason "User approved follow-up tomorrow" --json
frontctl tag list --json
frontctl comment add CONVERSATION_ID --body-file note.md --json
frontctl audit list --conversation CONVERSATION_ID --json
```

If `canExecute` is false, the assistant must not add `--yes`. The user should see the preview and
the reason. `--dry-run` forces preview mode even if `--yes` is present.
Agents should identify themselves with `--actor NAME` and a concise `--reason "..."` on state
changes. frontctl writes the visible Front identity comment first, then applies the requested action
last so archive/snooze UX ends in the intended state. This is enforced by the CLI mutation layer,
not left to each agent. Add a separate Front comment only when the user wants an additional internal
note beyond the automatic action trail. If the identity comment write fails, frontctl blocks the
state change. If the final state change fails after the identity comment succeeds, the error includes
the comment UID/activity ID so the agent can report the partial trail instead of retrying blindly.
`FRONTCTL_REQUIRE_DISCOVERY_FIXTURES=1` restores strict local fixture-only execution, and
`FRONTCTL_DISCOVERY_FIXTURES_PATH` can override the default fixture store only when needed.
Snooze accepts ISO timestamps and safe shortcuts such as `in:30m`, `in:2h`, `later`, `tomorrow`,
`tomorrow-9am`, and `monday-9am`. The preview includes `details.normalizedUntil` so the user can
verify the exact timestamp before approving.

## Great Onboarding Bar

The finished product should feel like this:

1. The user installs a package.
2. The user signs in to Front normally.
3. The user runs `frontctl agents install --agent codex|claude --yes`.
4. The assistant runs a check.
5. The assistant says exactly what is ready and what is not.
6. The first useful workflow is read-only: "summarize my unread Front inbox."

No token copying. No developer console. No API scopes. No team inbox limitation.

## First-Run Setup Command

```bash
frontctl setup
```

It should:

- explain what it will check before it checks anything
- verify Front is installed
- verify Front has been opened and signed in
- verify the local profile is readable
- install or print the agent skill path with `frontctl agents`
- run a final `doctor`
- end with one copy-paste prompt for Claude/ChatGPT

Use `frontctl setup --agent all --yes --json` to actually install both bundled skills.

## Uninstall

Preview local cleanup:

```bash
frontctl uninstall --json
```

Remove frontctl local state and installed local skills:

```bash
frontctl uninstall --yes --json
```

Front desktop, the user's Front account, and mail data in Front are not modified. Use
`--keep-agents` to leave Codex/Claude skills installed, or `--keep-data` to leave `~/.frontctl`
state in place.

Potential final message:

```text
Frontctl is ready.

Paste this into Claude or ChatGPT:
"Use the frontctl skill. Check my Front setup with frontctl doctor --json, then help me summarize my unread inbox. Do not send email."
```
