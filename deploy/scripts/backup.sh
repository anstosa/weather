#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print backup usage
usage() {
  cat <<'EOF'
Usage: backup.sh [--recipient AGE_RECIPIENT] [--output-dir DIRECTORY] [--env-file FILE]

Streams a PostgreSQL custom-format dump directly into age encryption, then
atomically publishes the encrypted artifact and adjacent SHA-256 checksum.
No plaintext database dump is written.
EOF
}

recipient=${AGE_RECIPIENT:-}
output_dir=/var/lib/weather/backups
WEATHER_ENV_FILE=${WEATHER_ENV_FILE:-$(default_env_file)}

# parse backup options
while (($# > 0)); do
  case "$1" in
    --recipient)
      (($# >= 2)) || die "--recipient requires a value"
      recipient=$2
      shift 2
      ;;
    --output-dir)
      (($# >= 2)) || die "--output-dir requires a value"
      output_dir=$2
      shift 2
      ;;
    --env-file)
      (($# >= 2)) || die "--env-file requires a value"
      WEATHER_ENV_FILE=$2
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

# load public backup policy
if [[ -z "$recipient" && -f "$deploy_dir/config/backup.env" ]]; then
  # shellcheck disable=SC1091
  source "$deploy_dir/config/backup.env"
  recipient=${AGE_RECIPIENT:-}
fi

[[ "$recipient" == age1* || "$recipient" == ssh-* ]] ||
  die "set a valid age or SSH recipient"
[[ "$output_dir" == /* ]] || die "output directory must be absolute"
require_command age
require_command docker
require_command sha256sum
require_command sync
require_file "$WEATHER_ENV_FILE"

umask 077
mkdir -p "$output_dir"
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
temporary=$(mktemp "$output_dir/.weather-${timestamp}.XXXXXX.dump.age.partial")
nonce=$(basename "$temporary" | sed -E 's/^\.weather-[^.]+\.([^.]+)\.dump\.age\.partial$/\1/')
archive="$output_dir/weather-${timestamp}-${nonce}.dump.age"
checksum="$archive.sha256"
checksum_temporary="$checksum.partial"
publication_complete=false

# remove interrupted publications
cleanup() {
  rm -f "$temporary" "$checksum_temporary"

  # remove an incomplete published pair
  if [[ "$publication_complete" != true ]]; then
    rm -f "$archive" "$checksum"
  fi
}
trap cleanup EXIT

printf 'Creating encrypted PostgreSQL backup %s\n' "$archive"
WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  pg_dump --username weather_owner --dbname weather --format=custom --no-owner --no-acl |
  age --recipient "$recipient" --output "$temporary"
[[ -s "$temporary" ]] || die "encrypted backup is empty"

digest=$(sha256sum "$temporary" | awk '{print $1}')
printf '%s  %s\n' "$digest" "$(basename "$archive")" >"$checksum_temporary"
chmod 600 "$temporary" "$checksum_temporary"
sync -f "$temporary" "$checksum_temporary"
mv "$temporary" "$archive"
mv "$checksum_temporary" "$checksum"
sync -f "$output_dir"
publication_complete=true
trap - EXIT
printf 'Backup complete: %s\nChecksum: %s\n' "$archive" "$checksum"
