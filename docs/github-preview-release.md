# GitHub Preview Release

`frontctl` does not need the Mac App Store for the first release. The initial distribution channel
can be a GitHub prerelease with a DMG, package installer, manifest, and generated Homebrew cask.

This is similar in spirit to developer-first macOS tools that publish GitHub release artifacts and
offer Homebrew as the technical install path.

## What This Channel Provides

- A downloadable `frontctl-<version>.dmg`.
- A package installer inside the DMG.
- `Frontctl Setup.app` for non-technical onboarding.
- A release manifest with SHA-256 hashes and file sizes.
- A generated `frontctl.rb` Homebrew cask for tap-based installs.
- No Apple Developer ID or notarization secrets required.

## User Tradeoff

Unsigned preview builds are acceptable for early testers, but they are not the polished consumer
experience. macOS Gatekeeper may warn because the package, setup app, and DMG are not Developer ID
signed and notarized.

For non-technical users, the best production-quality GitHub release is still signed and notarized.
That is not an App Store requirement; it is the normal macOS trust path for direct downloads.

## Build Locally

```bash
npm run release:verify:local
```

For a signed-in Front test machine:

```bash
script/verify_release_ready.sh --local --with-live-front
```

Artifacts are written to `dist/package/`:

- `frontctl-<version>.pkg`
- `frontctl-<version>.dmg`
- `frontctl-<version>-manifest.json`

Generate the cask using the eventual GitHub release URL:

```bash
FRONTCTL_DOWNLOAD_BASE_URL="https://github.com/OWNER/REPO/releases/download/v0.1.0-preview.1" \
npm run release:homebrew-cask
```

## Build in GitHub Actions

Run the `Preview Release` workflow manually with a tag such as:

```text
v0.1.0-preview.1
```

The workflow:

1. Installs dependencies.
2. Runs `npm run release:verify:local`.
3. Generates `dist/package/frontctl.rb`.
4. Uploads the DMG, package, manifest, and cask to a GitHub prerelease.

No signing or notarization secrets are required for this preview workflow.

## Later Production Channel

When Developer ID certificates and notarization credentials are available, use:

```bash
npm run release:verify:strict
```

The strict path still publishes to GitHub Releases. It does not require the Mac App Store.

