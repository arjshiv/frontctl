#!/bin/sh
set -eu

JSON=0
STRICT=0

for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --strict) STRICT=1 ;;
    *) echo "Usage: script/check_signing_prereqs.sh [--json] [--strict]" >&2; exit 64 ;;
  esac
done

developer_id_application_count="$(security find-identity -v -p codesigning 2>/dev/null | grep -c 'Developer ID Application' || true)"
developer_id_installer_count="$(security find-certificate -a -c 'Developer ID Installer' -p 2>/dev/null | grep -c 'BEGIN CERTIFICATE' || true)"

has_developer_id_application_env=0
has_developer_id_installer_env=0
has_apple_id=0
has_apple_team_id=0
has_apple_app_password=0

[ -n "${DEVELOPER_ID_APPLICATION:-}" ] && has_developer_id_application_env=1
[ -n "${DEVELOPER_ID_INSTALLER:-}" ] && has_developer_id_installer_env=1
[ -n "${APPLE_ID:-}" ] && has_apple_id=1
[ -n "${APPLE_TEAM_ID:-}" ] && has_apple_team_id=1
[ -n "${APPLE_APP_PASSWORD:-}" ] && has_apple_app_password=1

developer_id_application_ok=0
developer_id_installer_ok=0
signing_env_ok=0
notarization_env_ok=0

[ "$developer_id_application_count" -gt 0 ] && developer_id_application_ok=1
[ "$developer_id_installer_count" -gt 0 ] && developer_id_installer_ok=1
[ "$has_developer_id_application_env" = "1" ] && [ "$has_developer_id_installer_env" = "1" ] && signing_env_ok=1
[ "$has_apple_id" = "1" ] && [ "$has_apple_team_id" = "1" ] && [ "$has_apple_app_password" = "1" ] && notarization_env_ok=1

ok=0
[ "$developer_id_application_ok" = "1" ] && \
  [ "$developer_id_installer_ok" = "1" ] && \
  [ "$signing_env_ok" = "1" ] && \
  [ "$notarization_env_ok" = "1" ] && ok=1

bool() {
  if [ "$1" = "1" ]; then
    printf true
  else
    printf false
  fi
}

if [ "$JSON" = "1" ]; then
  cat <<EOF
{
  "ok": $(bool "$ok"),
  "checks": {
    "developerIdApplicationIdentity": {
      "ok": $(bool "$developer_id_application_ok"),
      "count": $developer_id_application_count,
      "remedy": "Install a Developer ID Application certificate in the login keychain."
    },
    "developerIdInstallerCertificate": {
      "ok": $(bool "$developer_id_installer_ok"),
      "count": $developer_id_installer_count,
      "remedy": "Install a Developer ID Installer certificate in the login keychain."
    },
    "signingEnvironment": {
      "ok": $(bool "$signing_env_ok"),
      "developerIdApplicationSet": $(bool "$has_developer_id_application_env"),
      "developerIdInstallerSet": $(bool "$has_developer_id_installer_env"),
      "remedy": "Set DEVELOPER_ID_APPLICATION and DEVELOPER_ID_INSTALLER to the exact certificate names."
    },
    "notarizationEnvironment": {
      "ok": $(bool "$notarization_env_ok"),
      "appleIdSet": $(bool "$has_apple_id"),
      "appleTeamIdSet": $(bool "$has_apple_team_id"),
      "appleAppPasswordSet": $(bool "$has_apple_app_password"),
      "remedy": "Set APPLE_ID, APPLE_TEAM_ID, and APPLE_APP_PASSWORD for notarytool."
    }
  }
}
EOF
else
  printf 'frontctl release signing prerequisites\n'
  printf 'Developer ID Application identity: %s found\n' "$developer_id_application_count"
  printf 'Developer ID Installer certificate: %s found\n' "$developer_id_installer_count"
  printf 'DEVELOPER_ID_APPLICATION set: %s\n' "$(bool "$has_developer_id_application_env")"
  printf 'DEVELOPER_ID_INSTALLER set: %s\n' "$(bool "$has_developer_id_installer_env")"
  printf 'APPLE_ID set: %s\n' "$(bool "$has_apple_id")"
  printf 'APPLE_TEAM_ID set: %s\n' "$(bool "$has_apple_team_id")"
  printf 'APPLE_APP_PASSWORD set: %s\n' "$(bool "$has_apple_app_password")"
  if [ "$ok" = "1" ]; then
    printf 'Ready for signed notarized release build.\n'
  else
    printf 'Not ready for signed notarized release build. Run with --json for machine-readable details.\n'
  fi
fi

if [ "$STRICT" = "1" ] && [ "$ok" != "1" ]; then
  exit 1
fi
