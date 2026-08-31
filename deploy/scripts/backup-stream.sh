#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print stream usage
usage() {
  cat <<'EOF'
Usage: backup-stream.sh

Streams one age-encrypted PostgreSQL custom-format dump to standard output.
Progress and errors use standard error so an SSH caller can save stdout exactly.
EOF
}

# handle the only informational option
if (($# > 0)); then
  [[ $# -eq 1 && ( "$1" == --help || "$1" == -h ) ]] || die "Backup streaming takes no arguments"
  usage
  exit 0
fi

# require the root-owned operator boundary
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "Backup streaming must run through sudo"
fi

recipient=${AGE_RECIPIENT:-}
WEATHER_ENV_FILE=${WEATHER_ENV_FILE:-$(default_env_file)}

# load only the public encryption recipient
if [[ -z "$recipient" && -f "$deploy_dir/config/backup.env" ]]; then
  recipient=$(env_value "$deploy_dir/config/backup.env" AGE_RECIPIENT)
fi

[[ "$recipient" == age1* || "$recipient" == ssh-* ]] ||
  die "set a valid age or SSH recipient"
require_command age
require_command docker
require_file "$WEATHER_ENV_FILE"
database_name=$(env_value "$WEATHER_ENV_FILE" WEATHER_DATABASE_NAME)
validate_database_name "$database_name"

printf 'Streaming encrypted Weather database backup\n' >&2
WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  pg_dump --username weather_owner --dbname "$database_name" --format=custom --no-owner |
  age --recipient "$recipient"
