# Product Packaging

This is the product contract for shipping `frontctl` to a non-technical macOS user.

## Primary Channel

Ship the first preview through GitHub Releases as a `.dmg` that contains:

- `frontctl-<version>.pkg`
- `Frontctl Setup.app`
- `START HERE.txt`
- `Uninstall Frontctl.command`
- `Developer README.md`

The package installs a self-contained runtime under `/opt/frontctl`, including the Node binary used
to run the CLI. Users should not need Homebrew, npm, Xcode, shell configuration, API tokens, or a
Front developer account.

For early testers, the GitHub preview DMG can be unsigned. For broader non-technical distribution,
the same GitHub release path should use a Developer ID signed and notarized DMG so Gatekeeper opens
it cleanly. Neither path requires the Mac App Store.

Homebrew and npm remain secondary channels for developers and automation environments.

## First-Run Promise

The user flow should be:

1. Open the DMG.
2. Run the package installer.
3. Open `Frontctl Setup.app`.
4. Click `Check Setup`.
5. Follow exactly one next action.
6. Copy the assistant prompt into Claude, ChatGPT with local command access, or Codex.

`Frontctl Setup.app` should be the normal entrypoint. Terminal commands are support and power-user
tools, not the primary consumer experience.

## Setup States

All setup surfaces should use the same readiness states from `frontctl readiness --json`:

- `front-not-installed`: install Front for macOS.
- `front-sign-in-missing`: open Front and sign in.
- `live-mode-locked`: approve one live-session unlock, preferably the default-browser unlock with
  a 720-hour TTL. Do not route normal users into macOS Automation.
- `agent-skills-missing`: click `Install Agent Skills`.
- `ready`: paste the agent prompt and start with read-only triage.

Do not expose stack traces, storage paths, cookie names, or raw command output as the main user
message. Keep those in the details pane and support bundle.

## Security UX

`frontctl` uses the user's existing local Front desktop session. It must not ask the user for a
Front API token or use the public Front API.

The expected prompt model is:

- `frontctl readiness --json`: no Keychain prompt.
- `frontctl auth check --json`: no Keychain prompt.
- `frontctl bridge test --json`: no Keychain prompt and no macOS Automation prompt on the default CDP path.
- `frontctl inbox list --json`: no Keychain prompt after bridge proof, agentcookie, or explicit unlock.
- `frontctl auth unlock --ttl-hours 720 --json`: no Keychain prompt; uses non-prompting sources
  such as agentcookie or fails with an explicit next action.
- `frontctl auth unlock --source default-browser --ttl-hours 720 --json`: may prompt once for the
  signed-in Chrome or Microsoft Edge safe-storage item, then reuses the frontctl cache.
- `frontctl auth unlock --force --ttl-hours 720 --json`: may prompt because the user explicitly
  requested a refresh.

Repeated Keychain prompts during setup checks or live reads are a product bug. The fix is to use the
reusable encrypted session cache written by `auth unlock`, not to train the user to keep approving
prompts.

Do not auto-export browser cookies as a fallback. Chrome, Edge, and Electron encrypt browser cookie
secrets with a macOS Safe Storage key, and reading that key is exactly what causes repeated Keychain
prompts when the binary is not already trusted. Default flows should either use an existing
reusable frontctl session, read an agentcookie plaintext sidecar, or fail closed.

For the “I already have Front open in Edge” case, the product-grade answer is the CDP browser bridge:
evaluate the request inside the live signed-in Front tab and ask that tab to call the same private
web routes. That avoids disk cookie decryption entirely. It is a first-class auth source, separate
from `--source default-browser`, because it depends on the browser being open and signed in rather
than on Keychain access to the browser profile.

The consumer setup path should launch or reuse a managed Edge/Chrome instance with
`--remote-debugging-port`, then verify a signed-in Front tab with `frontctl bridge test --json`.
AppleScript/Apple Events are fallback/debug tooling only; they should not be required for normal
installation.

Browser onboarding should gracefully report the local state: no Front app installed is acceptable
when Chrome or Edge has a signed-in Front profile; Safari should explain that cookie import needs
optional `agentcookie` support or a future signed helper.
For browser-backed route verification, do not confuse a reachable DevTools port with a signed-in
Front browser tab. `browser-status` finds the port, `browser-probe` proves Front auth, and
`browser-seed` can reuse the existing reusable `frontctl` session in that tab without printing
cookie values or touching Keychain again.

Agent identity should be visible without leaving the final mailbox state wrong. State-changing
commands accept `--actor NAME` and `--reason "..."`, write a Front identity comment first, and then
apply the requested action last. That ordering avoids the bad UX where an agent archives or snoozes
a thread and then immediately changes the thread again by commenting on it.

First-run learning should be explicit and local. After the live session is unlocked, the setup app can offer
`Learn Preferences`, backed by `frontctl setup --learn --json` or
`frontctl memory init --live --all --limit 200 --json`. The memory profile should remain local,
aggregate preference hypotheses such as fast-archive patterns and tag opportunities, and avoid
cookies, auth headers, and raw timeline bodies.

Future hardening can move unlock into a signed helper using Keychain and LocalAuthentication. That
is a post-MVP improvement; the MVP should avoid making ordinary read commands depend on Keychain.

## Graceful Failure Contract

Every failure should resolve to one user action:

- Install Front for macOS.
- Open Front and sign in.
- Run the package installer from the DMG.
- Click `Unlock Live Session`.
- Click `Install Agent Skills`.
- Click `Support Bundle`.

Support should ask for the generated `frontctl-support.json`, not screenshots of inboxes or copied
terminal dumps. The support bundle must remain redacted:

- no cookie values
- no auth headers
- no mailbox bodies
- no email subjects
- no signed attachment URLs

## Release Gates

Before handing a preview DMG to an early tester:

- `npm run check` passes.
- `npm test` passes.
- `npm run test:readonly` passes.
- `npm run build:package` produces a pkg, DMG, and manifest.
- `npm run release:check:local` passes.
- `frontctl readiness --json` reports `userReadiness.ready: true` on a signed-in test machine.
- `frontctl auth check --json` does not prompt.
- `frontctl create-test-conversation --subject "frontctl live verification" --body "Disposable test thread" --actor Codex --reason "Create test thread" --yes --json` creates a non-send internal test thread.
- `frontctl discovery verify-live-writes CONVERSATION_ID --actor Codex --yes --json` passes on that
  test thread and reports live-private source, no public API use, no sending, all route contracts
  verified, and final archived cleanup.
- `frontctl send --json` remains blocked.

Before publishing a polished public direct-download release:

- Developer ID Application and Installer certificates are installed.
- `DEVELOPER_ID_APPLICATION` and `DEVELOPER_ID_INSTALLER` are set.
- `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD` are set.
- `FRONTCTL_NOTARIZE=1 npm run build:package` completes.
- `npm run release:check` passes strict Gatekeeper checks.
