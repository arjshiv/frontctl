#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/.local/share/frontctl"
BIN_DIR="$HOME/.local/bin"
LINK="$BIN_DIR/frontctl"
AGENT="all"
SKIP_LIVE_PROOF=0
NO_PERMISSION_PREFLIGHT=0

usage() {
  cat >&2 <<'EOF'
Usage: script/bootstrap_agent_install.sh [--agent codex|claude|all] [--skip-live-proof] [--no-permission-preflight]

Installs frontctl for this user, preflights the one live-session permission prompt when needed,
installs agent skills, and verifies live Front behavior on a disposable test thread.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent)
      AGENT="${2:-}"
      [ "$AGENT" = "codex" ] || [ "$AGENT" = "claude" ] || [ "$AGENT" = "all" ] || { usage; exit 64; }
      shift 2
      ;;
    --skip-live-proof)
      SKIP_LIVE_PROOF=1
      shift
      ;;
    --no-permission-preflight)
      NO_PERMISSION_PREFLIGHT=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 64
      ;;
  esac
done

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

need_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 69
  fi
}

json_field() {
  node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const path=process.argv[1].split(".");let v=JSON.parse(s);for(const k of path){v=v?.[k]} if (v !== undefined && v !== null) process.stdout.write(String(v));})' "$1"
}

summarize_setup_json() {
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const readiness = j.readiness?.userReadiness || j.userReadiness || {};
const preflight = j.permissionPreflight || {};
const nextAction = j.readiness?.nextSteps?.[0] || j.nextSteps?.[0] || "none";
console.log(JSON.stringify({
  ok: Boolean(j.ok),
  ready: Boolean(readiness.ready),
  state: readiness.state || null,
  promptExpected: Boolean(preflight.promptExpected),
  noFuturePrompts: Boolean(preflight.noFuturePrompts),
  nextAction
}, null, 2));
' "$1"
}

summarize_readiness_json() {
  node -e '
const j = JSON.parse(process.argv[1]);
console.log(JSON.stringify({
  ready: Boolean(j.userReadiness?.ready),
  state: j.userReadiness?.state || null,
  authValid: Boolean(j.auth?.valid),
  promptsOnCheck: Boolean(j.auth?.promptsOnCheck),
  promptsOnLiveRead: Boolean(j.auth?.promptsOnLiveRead),
  recommendedCommand: j.auth?.recommendedCommand || null
}, null, 2));
' "$1"
}

summarize_live_proof_json() {
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify({
  ok: Boolean(j.ok),
  source: j.source || null,
  publicApiUsed: Boolean(j.publicApiUsed),
  sendsEmail: Boolean(j.sendsEmail),
  allRoutesVerified: Boolean(j.routeVerification?.allVerified),
  finalStatus: j.after?.status || null,
  remindersAfter: j.after?.reminders ?? null,
  hasDraftsAfter: Boolean(j.after?.hasDrafts),
  containsMarkerAfter: Boolean(j.after?.containsMarker)
}, null, 2));
' "$1"
}

need_command node
need_command npm

cd "$ROOT"

if [ ! -d node_modules ]; then
  run npm install
else
  run npm install
fi
run npm run build

printf '\n==> installing frontctl into %s\n' "$DEST"
rm -rf "$DEST"
mkdir -p "$DEST" "$BIN_DIR"
cp -R dist "$DEST/dist"
cp -R skills "$DEST/skills"
cp -R docs "$DEST/docs"
cp -R script "$DEST/script"
cp package.json "$DEST/package.json"
if [ -f package-lock.json ]; then
  cp package-lock.json "$DEST/package-lock.json"
fi
if [ -d node_modules ]; then
  cp -R node_modules "$DEST/node_modules"
fi

rm -f "$LINK"
cat > "$LINK" <<'EOF'
#!/bin/sh
set -eu
exec node "$HOME/.local/share/frontctl/dist/src/cli.js" "$@"
EOF
chmod 755 "$LINK"

"$LINK" --version >/dev/null

SETUP_ARGS="complete --agent $AGENT --yes --json"
if [ "$NO_PERMISSION_PREFLIGHT" = "1" ]; then
  SETUP_ARGS="$SETUP_ARGS --no-permission-preflight"
fi

AUTH_JSON="$("$LINK" auth check --json)"
AUTH_VALID="$(printf '%s' "$AUTH_JSON" | json_field valid)"
if [ "$AUTH_VALID" != "true" ] && [ "$NO_PERMISSION_PREFLIGHT" != "1" ]; then
  cat <<'EOF'

frontctl is about to preflight live Front access.
macOS may ask for Touch ID or your password once so frontctl can reuse your existing Front sign-in.
After this setup, normal checks and live reads should not ask again.
EOF
fi

SETUP_JSON_PATH="$(mktemp "${TMPDIR:-/tmp}/frontctl-setup-complete.XXXXXXXX").json"
printf '\n==> %s setup %s\n' "$LINK" "$SETUP_ARGS"
if ! "$LINK" setup $SETUP_ARGS > "$SETUP_JSON_PATH"; then
  echo "frontctl setup complete failed. First lines of captured output:" >&2
  sed -n '1,80p' "$SETUP_JSON_PATH" >&2
  exit 69
fi
printf '\n==> setup complete summary\n'
summarize_setup_json "$SETUP_JSON_PATH"

READINESS_JSON="$("$LINK" readiness --json)"
printf '\n==> readiness summary\n'
summarize_readiness_json "$READINESS_JSON"
READY="$(printf '%s' "$READINESS_JSON" | json_field userReadiness.ready)"
PROMPTS_ON_CHECK="$(printf '%s' "$READINESS_JSON" | json_field auth.promptsOnCheck)"
PROMPTS_ON_LIVE="$(printf '%s' "$READINESS_JSON" | json_field auth.promptsOnLiveRead)"

LIVE_PROOF="skipped"
LIVE_PROOF_PATH=""
if [ "$READY" = "true" ] && [ "$SKIP_LIVE_PROOF" != "1" ]; then
  CREATE_JSON="$("$LINK" create-test-conversation --subject "frontctl bootstrap verification" --body "Disposable frontctl bootstrap verification thread." --actor Frontctl --reason "Bootstrap live verification" --yes --json)"
  CONVERSATION_ID="$(printf '%s' "$CREATE_JSON" | json_field result.conversationId)"
  printf '\n==> created disposable Front test conversation %s\n' "$CONVERSATION_ID"
  LIVE_PROOF_PATH="$(mktemp "${TMPDIR:-/tmp}/frontctl-live-proof.XXXXXXXX").json"
  FRONTCTL_HTTP_TIMEOUT_MS="${FRONTCTL_HTTP_TIMEOUT_MS:-60000}" "$LINK" discovery verify-live-writes "$CONVERSATION_ID" --actor Frontctl --yes --json > "$LIVE_PROOF_PATH"
  printf '\n==> live write proof summary\n'
  summarize_live_proof_json "$LIVE_PROOF_PATH"
  LIVE_PROOF="passed"
fi

cat <<EOF

frontctl bootstrap summary
--------------------------
installed: $LINK
ready: $READY
future setup checks prompt: $PROMPTS_ON_CHECK
future live reads prompt: $PROMPTS_ON_LIVE
live proof: $LIVE_PROOF
setup proof: $SETUP_JSON_PATH
live proof details: ${LIVE_PROOF_PATH:-none}

Next agent prompt:
Use frontctl on this Mac. Run frontctl ready --json, then frontctl inbox --limit 20 --json. Do not send email and do not use the public Front API.
EOF

if [ "$READY" != "true" ]; then
  echo
  echo "Setup is not ready yet. Ask the user to complete the next action above, then rerun this bootstrap command." >&2
  exit 69
fi

if [ "$PROMPTS_ON_CHECK" != "false" ] || [ "$PROMPTS_ON_LIVE" != "false" ]; then
  echo "Setup completed, but prompt guarantees are not satisfied." >&2
  exit 69
fi
