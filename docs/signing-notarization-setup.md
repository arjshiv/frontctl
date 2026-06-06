# Signing and Notarization Setup

This is the external setup required before `frontctl` can be handed to non-technical users as a
public macOS download.

Unsigned local artifacts are useful for development, but the consumer DMG should be signed and
notarized so Gatekeeper accepts the installer, setup app, and disk image.

## Required Apple Assets

Use an Apple Developer Program account with access to certificates for the release team.

Create or install these certificates:

- `Developer ID Application`: signs `Frontctl Setup.app`.
- `Developer ID Installer`: signs `frontctl-<version>.pkg`.

Create a notarization credential:

- `APPLE_ID`: Apple ID used by `notarytool`.
- `APPLE_TEAM_ID`: Apple Developer Team ID.
- `APPLE_APP_PASSWORD`: app-specific password for the Apple ID.

Confirm local certificate availability:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
security find-certificate -a -c "Developer ID Installer" -p | grep "BEGIN CERTIFICATE"
```

## Local Release Machine

Set the exact identity names from Keychain:

```bash
export DEVELOPER_ID_APPLICATION="Developer ID Application: Example, Inc. (TEAMID)"
export DEVELOPER_ID_INSTALLER="Developer ID Installer: Example, Inc. (TEAMID)"
export APPLE_ID="release@example.com"
export APPLE_TEAM_ID="TEAMID"
export APPLE_APP_PASSWORD="app-specific-password"
```

Check readiness:

```bash
npm run release:doctor
npm run release:doctor:json
```

Build and verify the signed/notarized release:

```bash
npm run release:verify:strict
```

The strict verifier runs the full release gate: typecheck, tests, package dry run, notarized package
build, Gatekeeper checks, and the hard `frontctl send` block.

## GitHub Actions Secrets

Export `.p12` files for both Developer ID certificates from Keychain Access. Use strong unique
passwords for the exported files.

Create base64 values:

```bash
base64 -i DeveloperIDApplication.p12 | pbcopy
base64 -i DeveloperIDInstaller.p12 | pbcopy
```

Configure these repository secrets:

- `DEVELOPER_ID_APPLICATION`
- `DEVELOPER_ID_INSTALLER`
- `DEVELOPER_ID_APPLICATION_CERT_BASE64`
- `DEVELOPER_ID_APPLICATION_CERT_PASSWORD`
- `DEVELOPER_ID_INSTALLER_CERT_BASE64`
- `DEVELOPER_ID_INSTALLER_CERT_PASSWORD`
- `RELEASE_KEYCHAIN_PASSWORD`
- `APPLE_ID`
- `APPLE_TEAM_ID`
- `APPLE_APP_PASSWORD`

The release workflow imports the `.p12` files into a temporary CI keychain, builds with
`FRONTCTL_NOTARIZE=1`, staples the package and DMG, validates Gatekeeper, generates the Homebrew
cask, and uploads release artifacts.

## Final Checks

Before publishing the download URL:

```bash
npm run release:doctor
npm run release:verify:strict
```

Then verify the published artifact:

```bash
shasum -a 256 dist/package/frontctl-<version>.dmg
cat dist/package/frontctl-<version>-manifest.json
spctl --assess --type open --context context:primary-signature -vv dist/package/frontctl-<version>.dmg
```

The DMG hash must match the manifest and the generated Homebrew cask.

