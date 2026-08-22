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
  local project_name=${WEATHER_COMPOSE_PROJECT_NAME:-weather}
  require_file "$env_file"
  docker compose --project-name "$project_name" --env-file "$env_file" -f "$compose_file" "$@"
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

# validate one PostgreSQL identifier
validate_database_name() {
  local database_name=$1
  [[ "$database_name" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "invalid database name"
}

# require one canonical owned descendant
require_canonical_descendant() {
  local path=$1
  local root=$2
  local description=$3
  local canonical_path canonical_root
  require_command realpath
  canonical_path=$(realpath -m -- "$path")
  canonical_root=$(realpath -m -- "$root")
  [[ "$path" == "$canonical_path" ]] || die "$description must use a canonical path"
  [[ "$canonical_path" == "$canonical_root/"* ]] || die "$description escapes its Weather root"
  [[ ! -L "$path" ]] || die "$description must not be a symbolic link"
}

# hash the production deployment control plane
control_plane_digest() {
  local file
  local -a files
  mapfile -d '' -t files < <(
    find "$deploy_dir/scripts" "$deploy_dir/postgres" "$deploy_dir/systemd" \
      "$deploy_dir/sudoers" -type f -print0 | sort -z
  )
  files+=("$deploy_dir/compose.yaml")
  (
    cd "$repo_root"

    # hash stable relative paths and contents
    for file in "${files[@]}"; do
      printf '%s\0' "${file#"$repo_root/"}"
      sha256sum "$file" | awk '{print $1}'
    done
  ) | sha256sum | awk '{print $1}'
}

# apply the versioned runtime ACL contract
apply_runtime_database_acl() {
  local env_file=$1
  local database_name=$2
  validate_database_name "$database_name"
  WEATHER_ENV_FILE=$env_file compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$database_name" \
      <"$deploy_dir/postgres/runtime-acl-v1.sql"
}

# verify effective runtime grants and denials
verify_runtime_database_acl() {
  local env_file=$1
  local database_name=$2
  local verified
  validate_database_name "$database_name"
  verified=$(WEATHER_ENV_FILE=$env_file compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$database_name" \
      --tuples-only --no-align --command "SELECT
        has_database_privilege('weather_api', current_database(), 'CONNECT')
        AND NOT has_database_privilege('weather_api', current_database(), 'CREATE')
        AND NOT has_database_privilege('weather_api', current_database(), 'TEMP')
        AND has_schema_privilege('weather_api', 'public', 'USAGE')
        AND NOT has_schema_privilege('weather_api', 'public', 'CREATE')
        AND has_table_privilege('weather_api', 'sites', 'SELECT')
        AND NOT has_table_privilege('weather_api', 'sites', 'INSERT')
        AND has_column_privilege('weather_api', 'sources', 'source_key', 'SELECT')
        AND NOT has_column_privilege('weather_api', 'sources', 'material_provider_config', 'SELECT')
        AND has_database_privilege('weather_ingest', current_database(), 'CONNECT')
        AND NOT has_database_privilege('weather_ingest', current_database(), 'CREATE')
        AND NOT has_database_privilege('weather_ingest', current_database(), 'TEMP')
        AND NOT has_schema_privilege('weather_ingest', 'public', 'CREATE')
        AND has_table_privilege('weather_ingest', 'sources', 'SELECT')
        AND has_table_privilege('weather_ingest', 'schema_migrations', 'SELECT')
        AND NOT has_table_privilege('weather_ingest', 'schema_migrations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND has_table_privilege('weather_ingest', 'ingestion_runs', 'INSERT')
        AND has_table_privilege('weather_ingest', 'ingestion_runs', 'UPDATE')
        AND NOT has_table_privilege('weather_ingest', 'ingestion_runs', 'DELETE')
        AND has_sequence_privilege('weather_ingest', 'weather_records_id_seq', 'USAGE')")
  [[ "$verified" == t ]] || die "runtime database ACL verification failed"
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
  local temporary_directory
  validate_release "$release"
  mkdir -p "$(dirname "$path")"
  temporary_directory=$(mktemp -d "$deploy_dir/state/.active.env.XXXXXX")

  # remove interrupted link writes
  trap 'rm -rf "$temporary_directory"' EXIT
  ln -s "../releases/$release.env" "$temporary_directory/active.env"
  mv -Tf "$temporary_directory/active.env" "$path"
  rmdir "$temporary_directory"
  trap - EXIT
  )
}
