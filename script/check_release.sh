#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
PKG="dist/package/frontctl-$VERSION.pkg"
DMG="dist/package/frontctl-$VERSION.dmg"
MANIFEST="dist/package/frontctl-$VERSION-manifest.json"
APP="dist/Frontctl Setup.app"
ALLOW_UNSIGNED=0

if [ "${1:-}" = "--allow-unsigned" ]; then
  ALLOW_UNSIGNED=1
fi

failures=0

check() {
  label="$1"
  shift
  : > /tmp/frontctl-release-check.out
  if "$@" >/tmp/frontctl-release-check.out 2>&1; then
    printf 'ok: %s\n' "$label"
  else
    failures=$((failures + 1))
    printf 'fail: %s\n' "$label"
    if [ -s /tmp/frontctl-release-check.out ]; then
      sed 's/^/  /' /tmp/frontctl-release-check.out
    else
      printf '  no diagnostic output\n'
    fi
  fi
}

check_dmg_contents() {
  dmg_path="$1"
  package_name="$2"
  mountpoint="$(mktemp -d /tmp/frontctl-release-dmg-XXXXXX)"
  attached=0
  cleanup_dmg() {
    if [ "$attached" = "1" ]; then
      hdiutil detach "$mountpoint" >/dev/null 2>&1 || true
    fi
    rmdir "$mountpoint" >/dev/null 2>&1 || true
  }
  trap cleanup_dmg EXIT HUP INT TERM
  hdiutil attach -nobrowse -readonly -mountpoint "$mountpoint" "$dmg_path" >/dev/null
  attached=1
  test -f "$mountpoint/$package_name"
  test -f "$mountpoint/START HERE.txt"
  test -x "$mountpoint/Uninstall Frontctl.command"
  test -x "$mountpoint/Frontctl Setup.app/Contents/MacOS/FrontctlSetup"
  cleanup_dmg
  trap - EXIT HUP INT TERM
}

check_expanded_payload() {
  pkg_path="$1"
  temp_root="$(mktemp -d /tmp/frontctl-release-pkg-XXXXXX)"
  cleanup_pkg() {
    rm -rf "$temp_root" >/dev/null 2>&1 || true
  }
  trap cleanup_pkg EXIT HUP INT TERM
  pkgutil --expand-full "$pkg_path" "$temp_root/expanded" >/dev/null
  if find "$temp_root/expanded" -name '._*' | grep -q .; then
    find "$temp_root/expanded" -name '._*'
    cleanup_pkg
    trap - EXIT HUP INT TERM
    return 1
  fi

  runtime_node="$(find "$temp_root/expanded" -path '*/opt/frontctl/runtime/node' -type f | head -n 1)"
  cli_js="$(find "$temp_root/expanded" -path '*/opt/frontctl/dist/src/cli.js' -type f | head -n 1)"
  wrapper="$(find "$temp_root/expanded" -path '*/opt/frontctl/bin/frontctl' -type f | head -n 1)"

  test -n "$runtime_node"
  test -n "$cli_js"
  test -n "$wrapper"
  test -x "$runtime_node"
  test -x "$wrapper"
  "$runtime_node" "$cli_js" --version >/dev/null
  grep -q "/opt/frontctl/runtime/node /opt/frontctl/dist/src/cli.js" "$wrapper"
  ! otool -L "$runtime_node" | grep -q '/opt/homebrew'

  cleanup_pkg
  trap - EXIT HUP INT TERM
}

check_manifest() {
  manifest_path="$1"
  pkg_path="$2"
  dmg_path="$3"
  node - "$manifest_path" "$pkg_path" "$dmg_path" "$VERSION" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const [manifestPath, pkgPath, dmgPath, expectedVersion] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
assert(manifest.name === "frontctl", "manifest name mismatch");
assert(manifest.version === expectedVersion, "manifest version mismatch");
assert(manifest.artifacts.pkg.path === pkgPath.split("/").pop(), "pkg filename mismatch");
assert(manifest.artifacts.dmg.path === dmgPath.split("/").pop(), "dmg filename mismatch");
assert(manifest.artifacts.pkg.sha256 === sha256(pkgPath), "pkg sha256 mismatch");
assert(manifest.artifacts.dmg.sha256 === sha256(dmgPath), "dmg sha256 mismatch");
assert(manifest.artifacts.pkg.sizeBytes === statSync(pkgPath).size, "pkg size mismatch");
assert(manifest.artifacts.dmg.sizeBytes === statSync(dmgPath).size, "dmg size mismatch");
assert(/^v\d+\.\d+\.\d+/.test(manifest.nodeRuntimeVersion), "node runtime version missing");
assert(typeof manifest.notarized === "boolean", "notarized flag missing");
NODE
}

check "package exists" test -f "$PKG"
check "dmg exists" test -f "$DMG"
check "release manifest exists" test -f "$MANIFEST"
check "setup app exists" test -x "$APP/Contents/MacOS/FrontctlSetup"
check "setup app plist" /usr/bin/plutil -lint "$APP/Contents/Info.plist"
check "package contains frontctl" sh -c "pkgutil --payload-files '$PKG' | grep -q './opt/frontctl/bin/frontctl'"
check "package contains runtime node" sh -c "pkgutil --payload-files '$PKG' | grep -q './opt/frontctl/runtime/node'"
check "package contains cli" sh -c "pkgutil --payload-files '$PKG' | grep -q './opt/frontctl/dist/src/cli.js'"
check "package contains postinstall" sh -c "rm -rf /tmp/frontctl-release-expand-postinstall && pkgutil --expand '$PKG' /tmp/frontctl-release-expand-postinstall && test -f /tmp/frontctl-release-expand-postinstall/frontctl-component.pkg/Scripts/postinstall; rm -rf /tmp/frontctl-release-expand-postinstall"
check "expanded package payload is runnable" check_expanded_payload "$PKG"
check "dmg contains package and setup app" check_dmg_contents "$DMG" "frontctl-$VERSION.pkg"
check "release manifest matches artifacts" check_manifest "$MANIFEST" "$PKG" "$DMG"

if [ "$ALLOW_UNSIGNED" = "1" ]; then
  pkgutil --check-signature "$PKG" >/tmp/frontctl-release-signature.out 2>&1 || true
  printf 'warn: unsigned release allowed for local validation\n'
  sed 's/^/  /' /tmp/frontctl-release-signature.out
else
  check "package signature" pkgutil --check-signature "$PKG"
  check "package gatekeeper install assessment" spctl --assess --type install -vv "$PKG"
  check "setup app code signature" codesign --verify --deep --strict --verbose "$APP"
  check "setup app gatekeeper assessment" spctl --assess --type execute -vv "$APP"
  check "dmg gatekeeper assessment" spctl --assess --type open --context context:primary-signature -vv "$DMG"
fi

rm -f /tmp/frontctl-release-check.out /tmp/frontctl-release-signature.out

if [ "$failures" -gt 0 ]; then
  printf 'release check failed: %s failure(s)\n' "$failures" >&2
  exit 1
fi

printf 'release check passed\n'
