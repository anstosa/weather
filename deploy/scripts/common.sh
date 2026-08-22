#!/usr/bin/env bash
set -euo pipefail

deploy_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_root=$(cd "$deploy_dir/.." && pwd)
compose_file="$deploy_dir/compose.yaml"
: "$repo_root"

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

# require one digest-pinned image reference
validate_image_reference() {
  local image=$1
  [[ "$image" =~ ^[^@[:space:]]+@sha256:[a-f0-9]{64}$ ]] ||
    die "image must be a complete name@sha256 digest reference"
}

# read one validated release marker
read_release_state() {
  local path=$1
  local mode
  local -a lines
  require_file "$path"
  [[ ! -L "$path" ]] || die "release state must not be a symbolic link: $path"
  mode=$(stat -c '%a' "$path")
  (( (8#$mode & 077) == 0 )) || die "release state must be private: $path"
  mapfile -t lines <"$path"
  ((${#lines[@]} == 1)) || die "release state must contain exactly one line: $path"
  validate_release "${lines[0]}"
  printf '%s\n' "${lines[0]}"
}

# read absent state as empty
read_optional_release_state() {
  local path=$1

  # distinguish absence from unsafe links
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    return 0
  fi

  read_release_state "$path"
}

# select active or bootstrap configuration
default_env_file() {
  local current
  current=$(read_optional_release_state "$deploy_dir/state/current-release")

  # derive active configuration from committed state
  if [[ -n "$current" ]]; then
    local active="$deploy_dir/releases/$current.env"
    require_file "$active"
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
  local -a matches
  mapfile -t matches < <(grep -E "^${name}=" "$file" || true)
  ((${#matches[@]} == 1)) || die "expected exactly one $name in $file"
  value=${matches[0]#*=}
  [[ -n "$value" ]] || die "missing $name in $file"
  printf '%s\n' "$value"
}

# publish private state atomically
write_private_state() {
  (
  local path=$1
  local value=$2
  local temporary
  mkdir -p "$(dirname "$path")"
  umask 077
  temporary=$(mktemp "${path}.XXXXXX")

  # remove interrupted state writes
  trap 'rm -f "$temporary"' EXIT
  printf '%s\n' "$value" >"$temporary"
  chmod 600 "$temporary"
  mv "$temporary" "$path"
  trap - EXIT
  )
}

# publish one release symlink atomically
write_active_symlink() {
  (
  local release=$1
  local path="$deploy_dir/state/active.env"
  local temporary
  validate_release "$release"
  mkdir -p "$(dirname "$path")"
  temporary=$(mktemp -u "$deploy_dir/state/.active.env.XXXXXX")

  # remove interrupted link writes
  trap 'rm -f "$temporary"' EXIT
  ln -s "../releases/$release.env" "$temporary"
  mv -Tf "$temporary" "$path"
  trap - EXIT
  )
}
