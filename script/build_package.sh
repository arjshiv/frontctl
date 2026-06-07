#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"
export COPYFILE_DISABLE=1

VERSION="$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')"
OUT_DIR="$ROOT_DIR/dist/package"
WORK_DIR="$OUT_DIR/work"
PKG_ROOT="$WORK_DIR/root"
INSTALL_ROOT="$PKG_ROOT/opt/frontctl"
COMPONENT_PKG="$WORK_DIR/frontctl-component.pkg"
FINAL_PKG="$OUT_DIR/frontctl-$VERSION.pkg"
FINAL_DMG="$OUT_DIR/frontctl-$VERSION.dmg"
FINAL_MANIFEST="$OUT_DIR/frontctl-$VERSION-manifest.json"
DMG_SRC="$WORK_DIR/dmg"
SETUP_APP="$ROOT_DIR/dist/Frontctl Setup.app"

if [ "${FRONTCTL_NOTARIZE:-0}" = "1" ]; then
  if [ -z "${DEVELOPER_ID_INSTALLER:-}" ] || [ -z "${DEVELOPER_ID_APPLICATION:-}" ]; then
    echo "Set DEVELOPER_ID_INSTALLER and DEVELOPER_ID_APPLICATION for notarized releases." >&2
    exit 1
  fi
  if [ -z "${APPLE_ID:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ] || [ -z "${APPLE_APP_PASSWORD:-}" ]; then
    echo "Set APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_PASSWORD for notarization." >&2
    exit 1
  fi
fi

rm -rf "$WORK_DIR" "$FINAL_PKG" "$FINAL_DMG" "$FINAL_MANIFEST"
mkdir -p "$INSTALL_ROOT/bin" "$INSTALL_ROOT/runtime" "$INSTALL_ROOT/dist" "$PKG_ROOT/usr/local/bin" "$OUT_DIR"

npm run build
if [ "${FRONTCTL_SKIP_SETUP_APP:-0}" != "1" ]; then
  "$ROOT_DIR/script/build_setup_app.sh"
fi

cp package.json "$INSTALL_ROOT/package.json"
cp README.md "$INSTALL_ROOT/README.md"
cp -R dist/src "$INSTALL_ROOT/dist/src"
cp -R docs "$INSTALL_ROOT/docs"
cp -R skills "$INSTALL_ROOT/skills"

node - "$INSTALL_ROOT" <<'NODE'
const { cpSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const installRoot = process.argv[2];
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const deps = Object.keys(pkg.dependencies ?? {});
for (const dep of deps) {
  const source = join("node_modules", dep);
  if (!existsSync(source)) {
    throw new Error(`Missing production dependency ${dep}. Run npm install before packaging.`);
  }
  const target = join(installRoot, "node_modules", dep);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, dereference: true });
}
NODE

if [ -n "${FRONTCTL_NODE_BIN:-}" ]; then
  if [ "${FRONTCTL_ALLOW_DYNAMIC_NODE:-0}" != "1" ]; then
    echo "FRONTCTL_NODE_BIN is only allowed with FRONTCTL_ALLOW_DYNAMIC_NODE=1." >&2
    echo "For non-technical distribution, let this script download the official standalone Node runtime." >&2
    exit 1
  fi
  cp "$FRONTCTL_NODE_BIN" "$INSTALL_ROOT/runtime/node"
else
  NODE_VERSION="${FRONTCTL_NODE_VERSION:-$(node -p 'process.versions.node')}"
  case "$(uname -m)" in
    arm64) NODE_ARCH="arm64" ;;
    x86_64) NODE_ARCH="x64" ;;
    *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
  esac
  NODE_NAME="node-v$NODE_VERSION-darwin-$NODE_ARCH"
  NODE_TARBALL="$WORK_DIR/$NODE_NAME.tar.gz"
  NODE_URL="https://nodejs.org/dist/v$NODE_VERSION/$NODE_NAME.tar.gz"
  echo "Downloading $NODE_URL"
  /usr/bin/curl -fsSL "$NODE_URL" -o "$NODE_TARBALL"
  /usr/bin/tar -xzf "$NODE_TARBALL" -C "$WORK_DIR"
  cp "$WORK_DIR/$NODE_NAME/bin/node" "$INSTALL_ROOT/runtime/node"
fi
chmod 755 "$INSTALL_ROOT/runtime/node"

cat > "$INSTALL_ROOT/bin/frontctl" <<'EOF'
#!/bin/sh
set -eu
exec /opt/frontctl/runtime/node /opt/frontctl/dist/src/cli.js "$@"
EOF
chmod 755 "$INSTALL_ROOT/bin/frontctl"
/usr/bin/xattr -cr "$PKG_ROOT" 2>/dev/null || true
find "$PKG_ROOT" -name '._*' -delete

/usr/bin/pkgbuild \
  --root "$PKG_ROOT" \
  --scripts "$ROOT_DIR/packaging/pkg-scripts" \
  --filter ".*\\._.*" \
  --identifier "ai.frontctl.cli" \
  --version "$VERSION" \
  "$COMPONENT_PKG"

PRODUCTBUILD_ARGS="--package $COMPONENT_PKG"
if [ -n "${DEVELOPER_ID_INSTALLER:-}" ]; then
  PRODUCTBUILD_ARGS="$PRODUCTBUILD_ARGS --sign $DEVELOPER_ID_INSTALLER"
fi

# shellcheck disable=SC2086
/usr/bin/productbuild $PRODUCTBUILD_ARGS "$FINAL_PKG"

if [ "${FRONTCTL_NOTARIZE:-0}" = "1" ]; then
  /usr/bin/xcrun notarytool submit "$FINAL_PKG" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait
  /usr/bin/xcrun stapler staple "$FINAL_PKG"
fi

mkdir -p "$DMG_SRC"
cp "$FINAL_PKG" "$DMG_SRC/"
cp -R "$INSTALL_ROOT" "$DMG_SRC/frontctl"
cp "packaging/Install Frontctl for This User.command" "$DMG_SRC/Install Frontctl for This User.command"
chmod 755 "$DMG_SRC/Install Frontctl for This User.command"
cp packaging/DMG_README.txt "$DMG_SRC/START HERE.txt"
cp "packaging/Uninstall Frontctl.command" "$DMG_SRC/Uninstall Frontctl.command"
chmod 755 "$DMG_SRC/Uninstall Frontctl.command"
cp README.md "$DMG_SRC/Developer README.md"
if [ -d "$SETUP_APP" ]; then
  cp -R "$SETUP_APP" "$DMG_SRC/"
fi
/usr/bin/xattr -cr "$DMG_SRC" 2>/dev/null || true
find "$DMG_SRC" -name '._*' -delete

/usr/bin/hdiutil create \
  -volname "frontctl $VERSION" \
  -srcfolder "$DMG_SRC" \
  -ov \
  -format UDZO \
  "$FINAL_DMG" >/dev/null

if [ "${FRONTCTL_NOTARIZE:-0}" = "1" ]; then
  /usr/bin/xcrun notarytool submit "$FINAL_DMG" \
    --apple-id "$APPLE_ID" \
    --team-id "$APPLE_TEAM_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --wait
  /usr/bin/xcrun stapler staple "$FINAL_DMG"
fi

PKG_SHA256="$(/usr/bin/shasum -a 256 "$FINAL_PKG" | awk '{print $1}')"
DMG_SHA256="$(/usr/bin/shasum -a 256 "$FINAL_DMG" | awk '{print $1}')"
PKG_SIZE="$(/usr/bin/stat -f %z "$FINAL_PKG")"
DMG_SIZE="$(/usr/bin/stat -f %z "$FINAL_DMG")"
NODE_RUNTIME_VERSION="$("$INSTALL_ROOT/runtime/node" --version)"
BUILD_ARCH="$(uname -m)"
BUILD_TIME_UTC="$(TZ=UTC date '+%Y-%m-%dT%H:%M:%SZ')"

cat > "$FINAL_MANIFEST" <<EOF
{
  "name": "frontctl",
  "version": "$VERSION",
  "builtAt": "$BUILD_TIME_UTC",
  "architecture": "$BUILD_ARCH",
  "nodeRuntimeVersion": "$NODE_RUNTIME_VERSION",
  "notarized": $([ "${FRONTCTL_NOTARIZE:-0}" = "1" ] && printf true || printf false),
  "artifacts": {
    "pkg": {
      "path": "$(basename "$FINAL_PKG")",
      "sha256": "$PKG_SHA256",
      "sizeBytes": $PKG_SIZE
    },
    "dmg": {
      "path": "$(basename "$FINAL_DMG")",
      "sha256": "$DMG_SHA256",
      "sizeBytes": $DMG_SIZE
    }
  }
}
EOF

cat <<EOF
Built:
  $FINAL_PKG
  $FINAL_DMG
  $FINAL_MANIFEST

Unsigned builds are for local validation only. Set DEVELOPER_ID_INSTALLER and FRONTCTL_NOTARIZE=1 for release.
EOF
