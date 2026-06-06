#!/bin/sh
set -eu

MODE=local
WITH_LIVE_FRONT=0
SKIP_BUILD_PACKAGE=0

usage() {
  cat >&2 <<'EOF'
Usage: script/verify_release_ready.sh [--local|--strict] [--with-live-front] [--skip-build-package]

  --local              Validate unsigned local artifacts. This is the default.
  --strict             Require signing/notarization prerequisites and strict Gatekeeper checks.
  --with-live-front    Also require this Mac's signed-in Front profile to be ready.
  --skip-build-package Reuse existing dist/package artifacts.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --local) MODE=local ;;
    --strict) MODE=strict ;;
    --with-live-front) WITH_LIVE_FRONT=1 ;;
    --skip-build-package) SKIP_BUILD_PACKAGE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 64 ;;
  esac
done

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

require_ready_front() {
  printf '\n==> frontctl readiness --json\n'
  readiness_json="$(node dist/src/cli.js readiness --json)"
  printf '%s\n' "$readiness_json"
  FRONTCTL_READINESS_JSON="$readiness_json" node <<'NODE'
const result = JSON.parse(process.env.FRONTCTL_READINESS_JSON);
const failures = [];
if (!result.userReadiness?.ready) {
  failures.push(`user readiness is ${result.userReadiness?.state ?? "unknown"}`);
}
if (result.auth?.promptsOnCheck !== false) {
  failures.push("readiness/auth check may prompt for Keychain");
}
if (result.auth?.promptsOnLiveRead !== false) {
  failures.push("live reads may prompt for Keychain");
}
if (result.safety?.publicApiUsed !== false) {
  failures.push("public API safety flag is not false");
}
if (result.safety?.sendsEmail !== false) {
  failures.push("send safety flag is not false");
}
if (failures.length > 0) {
  throw new Error(failures.join("; "));
}
console.log(`ready: ${result.userReadiness.state}`);
NODE
}

require_send_blocked() {
  printf '\n==> node dist/src/cli.js send --json\n'
  set +e
  output="$(node dist/src/cli.js send --json 2>&1)"
  status=$?
  set -e
  printf '%s\n' "$output"
  if [ "$status" -eq 0 ]; then
    echo "frontctl send unexpectedly succeeded" >&2
    exit 1
  fi
  printf '%s\n' "$output" | grep -qi "Sending is intentionally blocked"
}

run npm run check
run npm test
run npm run test:readonly
run npm pack --dry-run

if [ "$MODE" = "strict" ]; then
  run script/check_signing_prereqs.sh --strict
  if [ "$SKIP_BUILD_PACKAGE" = "0" ]; then
    run env FRONTCTL_NOTARIZE=1 npm run build:package
  fi
  run npm run release:check
else
  if [ "$SKIP_BUILD_PACKAGE" = "0" ]; then
    run npm run build:package
  fi
  run npm run release:check:local
fi

require_send_blocked

if [ "$WITH_LIVE_FRONT" = "1" ]; then
  require_ready_front
fi

printf '\nfrontctl %s release verification passed\n' "$MODE"
