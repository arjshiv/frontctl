#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
MANIFEST="${FRONTCTL_CASK_MANIFEST:-dist/package/frontctl-$VERSION-manifest.json}"
OUT="${FRONTCTL_CASK_OUTPUT:-dist/package/frontctl.rb}"

if [ -z "${FRONTCTL_DOWNLOAD_BASE_URL:-}" ]; then
  echo "Set FRONTCTL_DOWNLOAD_BASE_URL to the published artifact base URL." >&2
  echo "Example: FRONTCTL_DOWNLOAD_BASE_URL=https://github.com/example/frontctl/releases/download/v$VERSION" >&2
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "Missing release manifest: $MANIFEST" >&2
  echo "Run npm run build:package first." >&2
  exit 1
fi

DMG_PATH="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).artifacts.dmg.path' "$MANIFEST")"
DMG_SHA256="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).artifacts.dmg.sha256' "$MANIFEST")"
PKG_PATH="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).artifacts.pkg.path' "$MANIFEST")"

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<EOF
cask "frontctl" do
  version "$VERSION"
  sha256 "$DMG_SHA256"

  url "${FRONTCTL_DOWNLOAD_BASE_URL%/}/$DMG_PATH"
  name "frontctl"
  desc "Local-session CLI for controlling Front desktop without the public Front API"
  homepage "https://github.com/frontctl/frontctl"

  pkg "$PKG_PATH"

  uninstall pkgutil: "ai.frontctl.cli",
            delete: [
              "/opt/frontctl",
              "/usr/local/bin/frontctl",
            ]

  zap trash: [
    "~/.frontctl",
    "~/.codex/skills/frontctl",
    "~/.claude/skills/frontctl",
  ]

  caveats <<~EOS
    Open Frontctl Setup.app from the DMG for the non-technical first-run flow,
    or run:
      frontctl readiness --json
      frontctl setup --agent all --yes --json
      frontctl auth unlock --ttl-hours 12 --json

    frontctl never sends email and does not use the public Front API.
  EOS
end
EOF

printf '%s\n' "$OUT"
