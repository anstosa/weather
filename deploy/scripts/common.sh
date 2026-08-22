#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_root=$(cd "$deploy_dir/.." && pwd)
compose_file="$deploy_dir/compose.yaml"

# print an operator error
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# require an executable
require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# require a regular file
require_file() {
  [[ -f "$1" ]] || die "required file not found: $1"
}

# validate immutable release tags
validate_release() {
  local release=$1
  local release_date
  [[ "$release" =~ ^([0-9]{4})\.([0-9]{2})\.([0-9]{2})-([1-9][0-9]?)$ ]] ||
    die "release must use YYYY.MM.DD-N"
  release_date="${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}"
  [[ "$(date --date "$release_date" +%Y-%m-%d 2>/dev/null)" == "$release_date" ]] ||
    die "release contains an invalid date"
  [[ "$release" != latest && "$release" != dev ]] || die "release must be immutable"
}

# select active or bootstrap configuration
default_env_file() {
  local active="$deploy_dir/state/active.env"

  # prefer active release state
  if [[ -f "$active" ]]; then
    printf '%s\n' "$active"
  else
    printf '%s\n' "$deploy_dir/.env"
  fi
}

# run the Weather-scoped Compose project
compose() {
  local env_file=${WEATHER_ENV_FILE:-$(default_env_file)}
  require_file "$env_file"
  docker compose --project-name weather --env-file "$env_file" -f "$compose_file" "$@"
}

# read a simple env value without evaluating it
env_value() {
  local file=$1
  local name=$2
  local value
  value=$(sed -n "s/^${name}=//p" "$file" | tail -n 1)
  [[ -n "$value" ]] || die "missing $name in $file"
  printf '%s\n' "$value"
}

# publish private state atomically
write_private_state() {
  local path=$1
  local value=$2
  local temporary
  mkdir -p "$(dirname "$path")"
  umask 077
  temporary=$(mktemp "${path}.XXXXXX")
  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$path"
}
