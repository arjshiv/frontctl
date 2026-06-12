# Release Checklist

Use this checklist before giving `frontctl` to an early tester or non-technical macOS user.

## Local Product Gates

- `npm run release:verify:local` passes for unsigned local artifacts.
- `script/verify_release_ready.sh --local --with-live-front` passes on a signed-in Front test machine.
- `npm run check` passes.
- `npm test` passes.
- `npm run test:readonly` passes.
- `npm pack --dry-run` shows `dist/src`, `skills`, `docs`, `script`, `packaging`, and setup app source.
- `npm run build:package` produces:
  - `dist/package/frontctl-<version>.pkg`
  - `dist/package/frontctl-<version>.dmg`
  - `dist/package/frontctl-<version>-manifest.json`
- `FRONTCTL_DOWNLOAD_BASE_URL=<release-url> npm run release:homebrew-cask` produces `dist/package/frontctl.rb`.
- `npm run release:check:local` passes against the generated artifacts.
- `frontctl doctor --json` works on a real signed-in Front desktop profile.
- `frontctl readiness --json` reports `userReadiness.ready: true` on the release test machine.
- `frontctl auth check --json` does not prompt for Keychain access.
- `frontctl inbox list --limit 5 --json` works after one successful `frontctl auth unlock`.
- `frontctl discovery browser-status --json` finds a usable browser DevTools port when Edge/Chrome
  is launched with remote debugging.
- `frontctl discovery browser-probe CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --json`
  reports authenticated after browser sign-in or `browser-seed`.
- `frontctl discovery verify-browser-writes CONVERSATION_ID --remote-debugging-port PORT --target-url-contains conversations/CONVERSATION_ID --tag-id TAG_ID --yes --json`
  passes on one low-risk real conversation and leaves it archived with no reminder, no draft, and no
  temporary tag/comment marker.
- `frontctl send --json` remains blocked.

## GitHub Preview Release Gates

- The `Preview Release` workflow is run with a tag such as `v0.1.0-preview.1`.
- The workflow uploads `.pkg`, `.dmg`, `-manifest.json`, and `frontctl.rb`.
- Release notes clearly state the preview is unsigned and may require Gatekeeper approval.
- The published DMG SHA-256 matches `frontctl-<version>-manifest.json`.
- The Homebrew cask SHA-256 matches the same manifest DMG hash.

## Signed Direct-Download Gates

- GitHub Actions secrets from `docs/distribution.md` are configured.
- Certificate and notarization setup from `docs/signing-notarization-setup.md` is complete.
- `.github/workflows/ci.yml` passes on the release branch.
- `npm run release:verify:strict` passes on a release machine or in the release workflow.
- `npm run release:doctor` reports ready.
- `DEVELOPER_ID_APPLICATION` is set to the exact Developer ID Application identity.
- `DEVELOPER_ID_INSTALLER` is set to the exact Developer ID Installer identity.
- `APPLE_ID`, `APPLE_TEAM_ID`, and `APPLE_APP_PASSWORD` are set for notarization.
- `FRONTCTL_NOTARIZE=1 npm run build:package` completes.
- `npm run release:check` passes Gatekeeper checks for the package, setup app, and DMG.
- The published DMG SHA-256 matches `frontctl-<version>-manifest.json`.
- The Homebrew cask SHA-256 matches the same manifest DMG hash.
- The tag release workflow uploads `.pkg`, `.dmg`, `-manifest.json`, and `frontctl.rb`.

## First-Run User Path

1. User opens the DMG.
2. User runs `frontctl-<version>.pkg`.
3. User opens `Frontctl Setup.app`.
4. Setup app tells them one of:
   - Front is missing: install Front for macOS.
   - Front sign-in is missing: open Front and sign in.
   - Live session is locked: click Unlock Live Session and approve Touch ID/password once.
   - Agent skills are missing: click Install Agent Skills.
   - Ready: paste the shown prompt into Claude, ChatGPT with local command access, or Codex.

## Support Rules

- Ask for `frontctl-support.json`, not screenshots of mail or raw terminal dumps.
- Support bundles must not contain cookie values, auth headers, message bodies, email subjects, or signed attachment URLs.
- Treat repeated Keychain prompts as a bug unless the user explicitly ran `frontctl auth unlock --force` or the 30-day session expired.
- For install failures, verify the manifest hash before debugging local machine state.
