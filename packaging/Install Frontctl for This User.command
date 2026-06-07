#!/bin/sh
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE="$SCRIPT_DIR/frontctl"
DEST="$HOME/.local/share/frontctl"
BIN_DIR="$HOME/.local/bin"
LINK="$BIN_DIR/frontctl"

echo "Frontctl User Install"
echo "====================="
echo

if [ ! -x "$SOURCE/bin/frontctl" ]; then
  echo "Could not find the bundled frontctl payload next to this installer." >&2
  echo "Expected: $SOURCE/bin/frontctl" >&2
  exit 1
fi

mkdir -p "$BIN_DIR" "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SOURCE" "$DEST"
ln -sf "$DEST/bin/frontctl" "$LINK"

"$LINK" --version >/dev/null

echo "Installed frontctl for this user:"
echo "  $LINK"
echo
echo "No administrator password was required."
echo
if ! command -v frontctl >/dev/null 2>&1; then
  echo "Note: ~/.local/bin is not currently on this shell's PATH."
  echo "Frontctl Setup can still find this install automatically."
  echo "For terminal use, add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo
fi

printf "Press Return to close this window. "
read _unused
