#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Frontctl Setup"
PACKAGE_DIR="$ROOT_DIR/macos/FrontctlSetup"
APP_DIR="$ROOT_DIR/dist/$APP_NAME.app"
EXECUTABLE="$PACKAGE_DIR/.build/release/FrontctlSetup"

cd "$PACKAGE_DIR"
if ! swift build -c release; then
  echo "Swift setup app build failed. Clearing local SwiftPM cache and retrying once." >&2
  rm -rf "$PACKAGE_DIR/.build"
  swift build -c release
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp "$EXECUTABLE" "$APP_DIR/Contents/MacOS/FrontctlSetup"
chmod 755 "$APP_DIR/Contents/MacOS/FrontctlSetup"

cat > "$APP_DIR/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>FrontctlSetup</string>
  <key>CFBundleIdentifier</key>
  <string>ai.frontctl.setup</string>
  <key>CFBundleName</key>
  <string>Frontctl Setup</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
EOF

if [ -n "${DEVELOPER_ID_APPLICATION:-}" ]; then
  /usr/bin/codesign --force --deep --options runtime --timestamp --sign "$DEVELOPER_ID_APPLICATION" "$APP_DIR"
else
  /usr/bin/codesign --force --deep --options runtime --sign - "$APP_DIR"
fi

echo "Built $APP_DIR"
