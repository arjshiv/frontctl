#!/bin/sh
set -eu

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$ROOT_DIR/.git/hooks"
HOOK_PATH="$HOOK_DIR/pre-push"

if [ ! -d "$ROOT_DIR/.git" ]; then
  echo "This repository has no .git directory. Run from a normal git checkout." >&2
  exit 1
fi

mkdir -p "$HOOK_DIR"
cat > "$HOOK_PATH" <<'EOF'
#!/bin/sh
set -eu

if [ "${FRONTCTL_SKIP_HOOKS:-0}" = "1" ]; then
  echo "frontctl pre-push hook skipped because FRONTCTL_SKIP_HOOKS=1"
  exit 0
fi

npm test
EOF
chmod 755 "$HOOK_PATH"

echo "Installed $HOOK_PATH"
echo "The hook runs npm test before push. Set FRONTCTL_SKIP_HOOKS=1 to bypass intentionally."
