#!/bin/sh
set -u

echo "Frontctl Uninstall"
echo "=================="
echo
echo "This removes frontctl local data, installed agent skills, and the package-installed CLI files."
echo "Front for macOS and your Front account are not modified."
echo

FRONTCTL=""
if command -v frontctl >/dev/null 2>&1; then
  FRONTCTL="$(command -v frontctl)"
elif [ -x /opt/frontctl/bin/frontctl ]; then
  FRONTCTL="/opt/frontctl/bin/frontctl"
fi

if [ -n "$FRONTCTL" ]; then
  echo "Removing frontctl local state and agent skills..."
  "$FRONTCTL" uninstall --yes || true
else
  echo "frontctl CLI was not found. Continuing with package file cleanup."
fi

echo
echo "Removing package-installed files. macOS may ask for your password."
if [ -e /usr/local/bin/frontctl ] || [ -L /usr/local/bin/frontctl ]; then
  sudo rm -f /usr/local/bin/frontctl
fi
if [ -d /opt/frontctl ]; then
  sudo rm -rf /opt/frontctl
fi
if pkgutil --pkg-info ai.frontctl.cli >/dev/null 2>&1; then
  sudo pkgutil --forget ai.frontctl.cli >/dev/null || true
fi

echo
echo "Frontctl has been removed."
echo
printf "Press Return to close this window. "
read _unused
