# frontctl

This repository is for `frontctl`, a local-session CLI and agent skill layer for controlling the
Front desktop app from the user's already-authenticated macOS session.

The goal is not to be a prettier wrapper around the public Front API. The goal is to make Front feel
as scriptable and agent-manageable as Gmail or a local mail client for the person sitting at this
Mac, including personal inbox workflows the public API does not cover.

## Current Status

The first working loop exists:

- local Front app/profile discovery
- one-time `auth unlock` with a short-lived encrypted session cache
- Chrome/Edge/default-browser session unlock, with optional agentcookie cookie-source support
- non-prompting `auth check` and `readiness`
- cached and live private-session inbox reads
- search, read, full conversation reads, summarize, triage, attachment metadata/downloads, resources, tags, drafts, and local SQLite/FTS cache
- guarded archive, unarchive, delete-to-trash, restore, snooze, unsnooze, tag, comment, reply draft, compose draft, and discard flows
- guarded assign/unassign, move, follower-add, Front conversation link add/remove, and internal test-conversation routes
- preview/capture-gated follower-remove, custom-field, tag-create, and update/forward draft routes
- custom-field set builds Front's observed `custom_attributes.add` patch shape, but a live test on
  an internal task returned `ok` without persisting `custom_field_attributes`; do not promote it to
  built-in executable coverage until a UI/runtime capture plus live readback proves persistence
- browser/CDP discovery with explicit browser auth probing
- browser session seeding from the short-lived `frontctl` session cache without repeated Keychain prompts
- live browser-runtime write verification for archive/unarchive, snooze/unsnooze, move,
  follower-add, Front conversation link add/remove, tag add/remove, comment add/remove, and reply draft/discard
- local memory profiling for first-run preference learning
- local daily workflows for triage, noise review, follow-up, tag hygiene, and ops/risk alerts
- hard-blocked sending
- Codex, Claude, and ChatGPT agent instructions
- native macOS setup app
- GitHub preview release packaging with DMG/pkg/manifest/Homebrew cask

This is still a private-endpoint/local-app project. Front can change its app internals. Treat route
contracts and discovery fixtures as maintainable local integration surfaces, not permanent platform
APIs.

## Why This Exists

Front is excellent for shared inboxes, but the public API leaves a painful gap: it is oriented around
workspace and team inbox automation, while a lot of real day-to-day work happens in personal Front
inboxes.

The user frustration that created this project is simple: the Front app is open, signed in, and able
to show the user's personal mail, yet the official API boundary prevents the obvious agent workflow:
"look at my inbox, summarize what matters, archive the noise, snooze what can wait, add notes/tags,
and draft replies for me."

That gap is what `frontctl` closes. It uses the local authenticated Front desktop session as the
source of authority. It does not ask for Front API tokens. It does not require a team inbox. It does
not send mailbox contents through a third-party API just to make them searchable. It gives agents a
small, explicit CLI surface over the local state the user already has.

## Letter to the Agent

You are probably here because a human asked you to make Front easier to control.

Remember who this is for: a user who wants their assistant to help manage their actual Front inbox,
not a developer who wants to read OAuth docs, create team inbox API tokens, or debug why personal
mail is invisible to the public API.

The product should feel obvious:

- If Front is not installed, say that.
- If Front is installed but not signed in, say that.
- If live mode is locked, unlock once with Touch ID or password.
- If agent skills are missing, install them.
- If everything is ready, give the agent commands it can run.

Do not make users paste cookies, bearer tokens, HAR files, raw payloads, or API keys. The whole point
is to avoid that class of setup.

## Non-Negotiable Rules

- Do not use the public Front API for mailbox control.
- Do not send email. `frontctl send` must remain blocked.
- Do not print or commit cookie values, auth headers, bearer tokens, signed attachment URLs, raw
  mailbox payloads, or screenshots of private mail.
- Do not make normal read commands touch Keychain.
- Do not reintroduce repeated Keychain prompts as an acceptable UX.
- Do not force-refresh browser cookies unless the user explicitly needs it. Reuse the frontctl
  session cache whenever it is valid.
- Do not execute mutations without explicit user approval and a verified non-send route contract.
- Do not execute preview-only/capture-gated routes just because their payload shape looks plausible.
- Keep support bundles redacted.
- Keep agent output machine-readable with `--json` where possible.

## Product Principles

### Make the Local Truth Obvious

The Front desktop app is the source of truth. Build around what the signed-in app can already see.
If a command fails, map it back to one concrete user action: install Front, sign in, unlock live mode,
install skills, or generate a support bundle.

### Prefer CLI Surfaces Over Hidden Magic

Agents need tools they can inspect and retry. Every important workflow should have a command, JSON
output, tests, and clear failure states. The native setup app is a friendly wrapper, not a separate
source of truth.

### Keep v0 Safe and Useful

Reading, summarizing, searching, triaging, tagging, commenting, archiving, snoozing, and drafting are
useful enough. Sending is a different risk tier. Do not blur that line.

Use `frontctl create-test-conversation --subject "..." --body "..." --yes --json` to create a
harmless internal task-style test thread for live write verification. It uses Front's non-send
comment save/publish route and must never be implemented as outbound email compose.

When an agent takes an action, pass `--actor NAME` and `--reason "..."`. The CLI must write a
visible Front identity comment before any executable conversation state change, then apply the
requested action last so archive/snooze state lands correctly. This is a product invariant, not an
agent judgment.

### Make Prompting Rare

The right default model is no Keychain prompt at all: use the CDP browser bridge against a signed-in
Front tab, then many non-prompting reads. If a future change makes every inbox read ask for Keychain
access, treat it as a regression.

Explicit cookie unlocks are fallback/debug paths. `frontctl auth unlock --source edge` or
`--source default-browser` may ask once for the browser safe-storage item only after the user
chooses that fallback. After that, `auth check`, `readiness`, and live reads must use the frontctl
session cache without prompting.
For browser-backed route work, `browser-status` only proves an attachable DevTools port. Use
`browser-probe` to prove the selected tab is authenticated. If the CLI session is valid but the tab
is not, `browser-seed` may copy the short-lived `frontctl` session into that tab without printing
cookie values or touching Keychain again.

### Design For Agents Installing This For Users

Assume the end user may not be technical. The install path is a GitHub preview DMG now, a signed and
notarized direct-download DMG later, and Homebrew/npm for technical users. The setup app should be
the normal first-run experience.

### Approachability Is A Product Requirement

This tool is not successful if only the author can install it. A user should not have to understand
Electron cookie stores, Front route shapes, Keychain internals, npm, Xcode, or macOS signing to get
value from it.

Good UX here means:

- one download artifact for normal users
- a setup app with obvious buttons
- exactly one next action when setup is incomplete
- copyable prompts for Claude, ChatGPT, and Codex
- a local memory setup pass that learns aggregate preferences without exporting mail
- support bundles that are safe to send
- no scary terminal output as the primary experience
- no repeated Keychain permission loops
- no request for Front API tokens or team inbox workarounds

If a feature is technically powerful but makes the first-run path harder to explain, isolate it
behind an advanced CLI command and keep the setup app simple.

### Packaging Is Part Of The Feature

The package is not an afterthought. The DMG, pkg, setup app, Homebrew cask, uninstall path, release
manifest, and support docs are all part of the product.

For the current preview channel, deployable means a GitHub prerelease can be created without Apple
Developer ID secrets. For broader distribution, deployable means the same flow can be signed and
notarized without changing the product shape.

### Be Honest About Private Integration Risk

Private Front routes can break. That is acceptable only if the tool has diagnostics, route discovery,
sanitized fixtures, and graceful failure paths. Never present this as an official Front integration.

## What Counts As Deployable

A change is not deployable merely because it compiles. For this repo, deployable means:

- `npm run check` passes.
- `npm test` passes.
- `npm run test:readonly` passes.
- `frontctl send --json` is still blocked.
- `frontctl readiness --json` remains non-prompting.
- Readiness failures produce one concrete user action.
- Support/diagnose output remains redacted.
- Packaging still produces a DMG, pkg, setup app, manifest, and uninstall helper.
- `npm run release:verify:local` passes for the GitHub preview channel.
- On a signed-in Front test machine, `script/verify_release_ready.sh --local --with-live-front`
  passes.

For UI/setup-app changes, also verify the user path in plain language:

1. Install the package.
2. Open `Frontctl Setup.app`.
3. Click `Check Setup`.
4. Follow one next action.
5. Enable live mode once.
6. Install agent skills.
7. Paste the agent prompt.

For packaging changes, verify the artifact path, not just source code. A setup flow that works only
from `npm link` is not deployable for normal users.

## Working In This Repo

Use these commands before shipping meaningful changes:

```bash
npm run check
npm test
npm run test:readonly
```

For release/package work:

```bash
npm run release:verify:local
```

On a signed-in Front test machine:

```bash
script/verify_release_ready.sh --local --with-live-front
```

For strict signed/notarized releases later:

```bash
npm run release:verify:strict
```

## Important Files

- `src/cli.ts`: command router
- `src/lib/auth.ts`: local session unlock/cache behavior
- `src/lib/browserProfiles.ts`: Chrome/Edge/default-browser discovery
- `src/lib/agentcookie.ts`: optional agentcookie plaintext cookie sidecar support
- `src/commands/readiness.ts`: user-facing setup gates
- `src/commands/memory.ts` and `src/lib/memory.ts`: local preference memory
- `src/commands/workflows.ts` and `src/lib/workflows.ts`: agent-ready workflow affordances
- `src/commands/mutations.ts`: guarded non-send write actions
- `src/lib/writeVerification.ts`: route verification and fixture checks
- `skills/codex/frontctl/SKILL.md`: Codex skill
- `skills/claude/frontctl/SKILL.md`: Claude skill
- `skills/chatgpt/frontctl/INSTRUCTIONS.md`: ChatGPT instructions
- `macos/FrontctlSetup/Sources/FrontctlSetup/main.swift`: native setup app
- `script/verify_release_ready.sh`: one-command release gate
- `docs/product-packaging.md`: user/product packaging contract
- `docs/github-preview-release.md`: current self-distribution path

## When In Doubt

Make the obvious agent assumption true:

- `frontctl readiness --json` should tell an agent exactly what to do next.
- `frontctl auth check --json` should never prompt.
- `frontctl browser list --json` should identify Chrome/Edge profiles without printing cookie values.
- `frontctl auth unlock --source default-browser --json` should use Chrome/Edge when macOS points
  to one of them.
- `frontctl memory init --json` should write a local aggregate profile without cookies, auth
  headers, or raw timeline bodies.
- `frontctl workflows daily --json` should produce one simple agent-facing workflow report rather
  than many competing automations.
- Mutation previews should show that frontctl will add the visible identity comment before execution.
- `frontctl inbox list --json` should use the unlocked local session.
- `frontctl diagnose --json` should be safe to share.
- `frontctl send --json` should fail.

If a change violates one of those assumptions, stop and make the tradeoff explicit before continuing.
