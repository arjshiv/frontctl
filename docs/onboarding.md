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
4. Click **Check Setup**, **Install Agent Skills**, then **Enable Live Mode**.

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

### 5b. Unlock Live Mode Once

For live private Front requests, run:

```bash
frontctl auth unlock --ttl-hours 12 --json
```

If the user is signed into Front in their default browser, prefer the browser source:

```bash
frontctl browser list --json
frontctl auth unlock --source default-browser --ttl-hours 12 --json
```

This is the only setup step that may ask for macOS Keychain access. After it succeeds, regular
commands use the short-lived encrypted frontctl session cache and should not keep asking for
Keychain permission. Rerunning `frontctl auth unlock` while the cache is valid reuses the cache and
does not touch Keychain. Use `frontctl auth unlock --force --ttl-hours 12 --json` only when the
cached Front session has expired or you need to refresh it deliberately.

`--source default-browser` auto-detects Chrome or Microsoft Edge from macOS Launch Services and
uses the signed-in browser profile. Safari is open-only for the MVP; use optional `agentcookie`
support or a future signed helper for Safari cookie import.

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

After setup is ready, the assistant can run:

```bash
frontctl inbox list --limit 20 --json
frontctl triage inbox --limit 20 --json
```

If the result says the cache is empty, open the Inbox view in Front once and rerun the command.
Results are marked `stale: true` because this milestone reads Front's local cache instead of a live
browser session.

For live data after `auth unlock`:

```bash
frontctl inbox list --live --limit 20 --json
frontctl triage inbox --live --limit 20 --json
frontctl search "customer name" --live --json
frontctl read CONVERSATION_ID --live --json
frontctl summarize CONVERSATION_ID --live --json
frontctl attachments list CONVERSATION_ID --live --json
frontctl open CONVERSATION_ID --print-only --json
frontctl open CONVERSATION_ID --web --print-only --json
```

For repeated searches, build a local index after live unlock:

```bash
frontctl sync --live --limit 100 --json
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
Cache stats/search/read include freshness metadata. By default, cached index results are treated as
fresh for 12 hours. Override with `--max-age-hours N` or `FRONTCTL_STORE_MAX_AGE_HOURS`.

For first-run preference learning after setup:

```bash
frontctl sync --live --all --limit 200 --json
frontctl memory init --limit 500 --json
frontctl memory report --json
```

`memory init` writes `~/.frontctl/memory.json`. It is local-only and stores aggregate hypotheses:
what looks like fast archive material, what tends to stay open, where tags might help, and which
local sources were synced. It does not store cookies, auth headers, or raw timeline bodies. Agents
should present memory output as suggestions, not autonomous rules.

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
frontctl tag list --json
frontctl audit list --json
frontctl discovery sanitize --input capture.har --output sanitized.json --json
frontctl discovery fixtures install sanitized.json --json
frontctl discovery verify-writes --json
```

Draft list/read are local read-only IndexedDB scans. Draft compose accepts optional `--to`, `--cc`,
`--bcc`, and `--subject` fields, but still only creates a draft and never sends. Draft write/discard
commands default to preview and require explicit `--yes` before they can write through Front's
private routes. Optional endpoint discovery must write sanitized fixtures only; do not share raw HAR
files.
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
frontctl archive CONVERSATION_ID ANOTHER_CONVERSATION_ID --actor Claude --reason "User approved batch archive" --json
frontctl snooze CONVERSATION_ID tomorrow-9am --actor Claude --reason "User approved follow-up tomorrow" --json
frontctl tag list --json
frontctl comment add CONVERSATION_ID --body-file note.md --json
frontctl audit list --conversation CONVERSATION_ID --json
```

If `canExecute` is false, the assistant must not add `--yes`. The user should see the preview and
the reason. `--dry-run` forces preview mode even if `--yes` is present.
Agents should identify themselves with `--actor NAME` and a concise `--reason "..."` on state
changes. This records identity in frontctl previews and audit logs without adding a visible Front
comment. Do not add a comment only to identify the agent; that can change thread state and can undo
archive/snooze UX. Add a Front comment only when the user explicitly asks for a visible internal
comment. If the user wants a visible comment plus archive/snooze, add the comment first and run the
archive/snooze last so the final command leaves the thread in the intended state.
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
