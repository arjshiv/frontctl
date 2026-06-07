# Distribution

This project can ship first as a GitHub prerelease with an unsigned DMG for early testers. The
production-quality direct-download channel should still be a signed, notarized installer package.
The npm package remains useful for technical users and agents, but it should not be the primary
consumer install path.

## Channels

1. **GitHub preview release**: unsigned `.dmg` with a no-admin user installer for early testers.
2. **macOS direct download**: signed/notarized `.dmg` with no-admin user install by default.
3. **Homebrew**: `brew install frontctl` for technical users.
4. **npm**: `npm install -g frontctl` for developers and automation environments.

The default user path installs the self-contained payload under `~/.local/share/frontctl` and a
user-owned shim at `~/.local/bin/frontctl`. It does not require an administrator password. The
package channel is system-wide: it installs under `/opt/frontctl` and creates
`/usr/local/bin/frontctl`, so it requires administrator approval. Do not try to install into
`/usr/bin`; System Integrity Protection protects that directory and third-party installers should
not target it.

The preview release path is documented in [github-preview-release.md](github-preview-release.md).
It does not require the Mac App Store, Developer ID certificates, or notarization credentials.

## Build Artifacts

Build an unsigned local package:

```bash
script/build_package.sh
```

By default, the package builder downloads the official `node-v<current>-darwin-<arch>` runtime from
nodejs.org and stages it under `/opt/frontctl/runtime/node`. It also copies production npm
dependencies under `/opt/frontctl/node_modules`. This keeps the installer usable without Homebrew or
npm after administrator approval.

The DMG contains both:

- `Install Frontctl for This User.command`
- `frontctl/` bundled CLI payload for user installs
- `frontctl-<version>.pkg`
- `Frontctl Setup.app`
- `START HERE.txt`
- `Uninstall Frontctl.command`
- `Developer README.md`

The setup app can use the user install, the bundled CLI next to the setup app in the DMG, or a
system package install. If `frontctl` is missing, it tells the user to run the no-admin user
installer from the DMG.
`START HERE.txt` is the first-run checklist for non-technical users; keep it short and free of
developer-only commands.
`Uninstall Frontctl.command` removes local frontctl state, installed agent skills,
`~/.local/share/frontctl`, `~/.local/bin/frontctl`, `/opt/frontctl`, the `/usr/local/bin/frontctl`
symlink, and the package receipt. It intentionally does not touch Front for macOS or the user's
Front account.

For local-only validation with an existing Node binary:

```bash
FRONTCTL_NODE_BIN="$(command -v node)" FRONTCTL_ALLOW_DYNAMIC_NODE=1 script/build_package.sh
```

Do not use the dynamic-node override for release packages unless you also bundle every required
dynamic library.

Build a signed package when a Developer ID Installer certificate is available:

```bash
npm run release:doctor
DEVELOPER_ID_INSTALLER="Developer ID Installer: Example, Inc. (TEAMID)" \
DEVELOPER_ID_APPLICATION="Developer ID Application: Example, Inc. (TEAMID)" \
script/build_package.sh
```

Submit for notarization when Apple credentials are configured:

```bash
npm run release:doctor
DEVELOPER_ID_INSTALLER="Developer ID Installer: Example, Inc. (TEAMID)" \
DEVELOPER_ID_APPLICATION="Developer ID Application: Example, Inc. (TEAMID)" \
FRONTCTL_NOTARIZE=1 \
APPLE_ID="release@example.com" \
APPLE_TEAM_ID="TEAMID" \
APPLE_APP_PASSWORD="app-specific-password" \
script/build_package.sh
```

For notarized releases, the script signs the setup app, signs the installer package, notarizes and
staples the package, assembles the DMG from the stapled package plus signed setup app, then
notarizes and staples the DMG. Do not assemble or publish the DMG before the package has been
stapled.
See [signing-notarization-setup.md](signing-notarization-setup.md) for certificate, environment,
and GitHub Actions secret setup.

The script writes artifacts to `dist/package/`:

- `frontctl-<version>.pkg`
- `frontctl-<version>.dmg`
- `frontctl-<version>-manifest.json`

Publish the manifest next to the package and DMG. It records SHA-256 hashes, file sizes, build
architecture, bundled Node runtime version, and whether the build ran through notarization.
Support can compare a user's downloaded artifact against this manifest before troubleshooting
install behavior.

## Homebrew

After building and notarizing the DMG, generate a Homebrew cask from the release manifest:

```bash
FRONTCTL_DOWNLOAD_BASE_URL="https://github.com/OWNER/REPO/releases/download/v$(node -p 'require("./package.json").version')" \
npm run release:homebrew-cask
```

The script writes `dist/package/frontctl.rb`. The generated cask installs the package inside the
DMG, uninstalls the `ai.frontctl.cli` package receipt plus `/opt/frontctl` and `/usr/local/bin/frontctl`,
and zaps frontctl local state and installed Codex/Claude skills. It takes the DMG SHA-256 from
`frontctl-<version>-manifest.json`, so regenerate it after every release build.

Validate the generated cask in a tap checkout with:

```bash
brew audit --cask --strict frontctl
brew install --cask ./frontctl.rb
frontctl readiness --json
brew uninstall --cask frontctl
```

## GitHub Release Automation

The repository includes:

- `.github/workflows/ci.yml`: runs typecheck, tests, npm pack dry run, unsigned package build, and
  local release validation on macOS.
- `.github/workflows/release.yml`: runs on `v*.*.*` tags or manual dispatch, imports Developer ID
  certificates, builds a notarized package/DMG, validates Gatekeeper checks, generates the Homebrew
  cask, and uploads release artifacts.

Configure these GitHub Actions secrets before using the release workflow. See
[signing-notarization-setup.md](signing-notarization-setup.md) for the certificate export and
verification flow.

- `DEVELOPER_ID_APPLICATION`: exact Developer ID Application identity name.
- `DEVELOPER_ID_INSTALLER`: exact Developer ID Installer identity name.
- `DEVELOPER_ID_APPLICATION_CERT_BASE64`: base64-encoded `.p12` for the Developer ID Application certificate.
- `DEVELOPER_ID_APPLICATION_CERT_PASSWORD`: password for that `.p12`.
- `DEVELOPER_ID_INSTALLER_CERT_BASE64`: base64-encoded `.p12` for the Developer ID Installer certificate.
- `DEVELOPER_ID_INSTALLER_CERT_PASSWORD`: password for that `.p12`.
- `RELEASE_KEYCHAIN_PASSWORD`: temporary CI keychain password.
- `APPLE_ID`: Apple ID used by `notarytool`.
- `APPLE_TEAM_ID`: Apple developer team ID.
- `APPLE_APP_PASSWORD`: Apple app-specific password for notarization.

Create the certificate secrets from local `.p12` files with:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
base64 -i DeveloperIDInstaller.p12 | pbcopy
```

Use one command per file and paste the clipboard contents into the matching GitHub secret.

## Setup App

Build a local unsigned setup app:

```bash
script/build_setup_app.sh
```

The app is staged at `dist/Frontctl Setup.app`. Local builds are ad-hoc signed so bundle
verification works during development. Production builds should set `DEVELOPER_ID_APPLICATION`
before the package build so the app is signed with Developer ID Application credentials.

It is a native first-run wrapper around:

- `frontctl readiness --json`
- `frontctl setup --json`
- `frontctl setup --agent all --yes --json`
- `frontctl auth unlock --ttl-hours 12 --json`
- `frontctl diagnose --output ~/Desktop/frontctl-support.json --json`

The window translates setup JSON into a plain-language checklist for Front installation, Front
sign-in, live mode, and agent skills. If the CLI is missing, it tells the user to run the installer
package from the DMG. It reads `userReadiness.state` and `userReadiness.nextAction` from setup
output so the user sees one clear next action. It also includes a copyable agent prompt for Claude,
ChatGPT, or Codex.

For production, set `DEVELOPER_ID_APPLICATION`; the package build signs the setup app before
bundling it in the DMG.

## Graceful Failure Contract

Every setup surface should route failures to one of these user actions:

- Install Front for macOS.
- Open Front and sign in.
- Verify frontctl is installed with `frontctl --version`.
- Re-run `frontctl auth unlock --ttl-hours 12 --json`.
- Install Codex/Claude skills with `frontctl setup --agent all --yes --json`.
- Generate a redacted support bundle with `frontctl diagnose --output support.json --json`.

The support bundle must not include cookie values, auth headers, mailbox body text, email subjects,
or signed attachment URLs.

## Security Model

- `frontctl auth check` never prompts.
- `frontctl auth security --json` reports the prompt model for onboarding, agents, and support.
- `frontctl auth unlock` is the only command expected to touch macOS Keychain.
- A successful unlock may ask for Touch ID or the account password once to read Front Safe Storage,
  then writes a short-lived encrypted session cache under `~/.frontctl/session.json`.
- The default TTL is 12 hours.
- `frontctl auth clear` deletes the live-session cache.
- `frontctl uninstall --yes` removes frontctl local state and installed local agent skills.
- `frontctl discovery browser-seed --yes` may copy the existing short-lived frontctl session into a
  selected Chrome/Edge tab through DevTools, including CSRF, but it must not print cookie values and
  must not read Keychain directly.

Future native hardening can move the session encryption key into a signed helper that uses
Keychain + LocalAuthentication. Until that helper is production-signed, avoid making ordinary
read commands depend on Keychain reads because unsigned command-line tools can create repeated
authorization prompts.

## Validation

Run before shipping:

```bash
npm run check
npm test
node dist/src/cli.js --version
node dist/src/cli.js diagnose --json
node dist/src/cli.js uninstall --json
npm pack --dry-run
script/build_package.sh
npm run release:check:local
```

`release:check:local` verifies the manifest hashes and file sizes against the generated package and
DMG.

For local development, use the optional pre-push hook rather than a pre-commit package build:

```bash
npm run hooks:install
```

The hook runs `npm test` before push and can be bypassed with `FRONTCTL_SKIP_HOOKS=1` for deliberate
emergency pushes. It does not build the package or DMG; packaging changes should run:

```bash
npm run check:package:local
```

For signed releases also run:

```bash
npm run release:doctor
npm run release:check
```

The strict release check verifies package signature, package Gatekeeper install assessment, setup
app signature, setup app Gatekeeper assessment, and DMG Gatekeeper assessment.

For a one-command local release gate, run:

```bash
npm run release:verify:local
```

On a signed-in Front test machine, include live readiness:

```bash
script/verify_release_ready.sh --local --with-live-front
```

For the public signed/notarized gate, run:

```bash
npm run release:verify:strict
```
