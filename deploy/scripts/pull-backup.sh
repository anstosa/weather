#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print local backup usage
usage() {
  cat <<'EOF'
Usage: pull-backup.sh [--output FILE] [--identity FILE]

Streams the production database into an encrypted local file, verifies full
decryption and PostgreSQL archive readability, then atomically replaces it.
EOF
}

output="$deploy_dir/backups/weather-nightly.dump.age"
identity=${WEATHER_BACKUP_IDENTITY:-"$HOME/.config/weather/backup-age-key.txt"}

# parse local backup options
while (($# > 0)); do
  case "$1" in
    --output)
      (($# >= 2)) || die "--output requires a file"
      output=$2
      shift 2
      ;;
    --identity)
      (($# >= 2)) || die "--identity requires a file"
      identity=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$output" == /* ]] || output="$repo_root/$output"
[[ "$identity" == /* ]] || identity="$repo_root/$identity"
require_canonical_descendant "$output" "$deploy_dir/backups" "local backup"
require_file "$identity"
PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/opt/libpq/bin:$PATH"
export PATH
require_command age
require_command cat
require_command pg_restore
require_command sha256sum
require_command sync

# validate the archive table and drain the decrypted stream
verify_archive_stream() {
  local restore_status

  set +e
  pg_restore --list >/dev/null
  restore_status=$?
  # drain after pg_restore reads the early archive table of contents
  cat >/dev/null
  return "$restore_status"
}

# restore the persistent deployment agent for unattended timers
if [[ -z ${SSH_AUTH_SOCK:-} || ! -S ${SSH_AUTH_SOCK:-} ]]; then
  agent_environment=${WEATHER_SSH_AGENT_ENV:-"$HOME/.ssh/agent/weather.env"}
  require_file "$agent_environment"
  # shellcheck disable=SC1090
  source "$agent_environment"
fi

[[ -n ${SSH_AUTH_SOCK:-} && -S ${SSH_AUTH_SOCK:-} ]] ||
  die "SSH_AUTH_SOCK is not a live agent socket"
mkdir -p "$(dirname "$output")"
umask 077
partial=$(mktemp "${output}.XXXXXX.partial")
checksum="$output.sha256"
checksum_partial=$(mktemp "${checksum}.XXXXXX.partial")

# remove interrupted local publications
cleanup() {
  rm -f "$partial" "$checksum_partial"
}
trap cleanup EXIT

"$deploy_dir/scripts/ssh-run.sh" backup-stream >"$partial"
[[ -s "$partial" ]] || die "streamed backup is empty"
head -n 1 "$partial" | grep -qx 'age-encryption.org/v1' ||
  die "streamed backup is not an age archive"

# verify the complete encrypted PostgreSQL archive without plaintext on disk
age --decrypt --identity "$identity" "$partial" |
  verify_archive_stream

digest=$(sha256sum "$partial" | awk '{print $1}')
printf '%s  %s\n' "$digest" "$(basename "$output")" >"$checksum_partial"
chmod 600 "$partial" "$checksum_partial"
sync -f "$partial" "$checksum_partial"
mv "$partial" "$output"
mv "$checksum_partial" "$checksum"
sync -f "$(dirname "$output")"
trap - EXIT
printf 'Verified local Weather backup: %s\nChecksum: %s\n' "$output" "$checksum"
