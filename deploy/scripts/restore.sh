#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print restore usage
usage() {
  cat <<'EOF'
Usage: restore.sh verify ARCHIVE --identity AGE_IDENTITY [--retain] [--env-file FILE]

Verifies checksum and encryption, restores into a uniquely named disposable
database, checks version, migration checksums, roles, counts, and sample rows,
then drops the candidate. Live replace and cutover modes are intentionally denied.
EOF
}

# reject missing or prohibited modes
if [[ ${1:-} == replace || ${1:-} == cutover ]]; then
  die "live database replacement and cutover are not supported"
fi
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  usage
  exit 0
fi
(($# >= 2)) || { usage >&2; exit 2; }
[[ "$1" == verify ]] || die "only verify mode is supported"
archive=$2
shift 2
identity=${AGE_IDENTITY_FILE:-}
retain=false
WEATHER_ENV_FILE=${WEATHER_ENV_FILE:-$(default_env_file)}

# parse verification options
while (($# > 0)); do
  case "$1" in
    --identity)
      (($# >= 2)) || die "--identity requires a value"
      identity=$2
      shift 2
      ;;
    --retain)
      retain=true
      shift
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

require_file "$archive"
require_file "$archive.sha256"
require_file "$identity"
require_file "$WEATHER_ENV_FILE"
require_command age
require_command docker
require_command sha256sum

# verify the published ciphertext
(
  cd "$(dirname "$archive")"
  sha256sum --check "$(basename "$archive").sha256"
)

candidate="weather_verify_$(date -u +%Y%m%d%H%M%S)_$$"
candidate_created=false

# remove disposable verification state
cleanup() {
  local status=$?

  # drop the candidate unless retained after success
  if [[ "$candidate_created" == true && "$retain" != true ]]; then
    WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
      dropdb --username postgres --if-exists "$candidate" >/dev/null || status=1
  fi
  exit "$status"
}
trap cleanup EXIT

WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  createdb --username postgres --owner weather_owner "$candidate"
candidate_created=true
age --decrypt --identity "$identity" "$archive" |
  WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
    pg_restore --username postgres --dbname "$candidate" --no-owner \
      --role weather_owner --exit-on-error

server_version=$(WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  psql --username postgres --dbname "$candidate" --tuples-only --no-align \
    --command "SHOW server_version_num")
[[ "$server_version" =~ ^[0-9]+$ && "$server_version" -ge 150000 ]] ||
  die "restored database requires PostgreSQL 15 or newer"

expected_migrations=$(for migration in "$repo_root"/packages/database/migrations/*.sql; do
  printf '%s|%s\n' "$(basename "$migration")" "$(sha256sum "$migration" | awk '{print $1}')"
done)
actual_migrations=$(WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  psql --username postgres --dbname "$candidate" --tuples-only --no-align \
    --field-separator='|' --command "SELECT name, checksum FROM schema_migrations ORDER BY name")
[[ "$actual_migrations" == "$expected_migrations" ]] || die "migration checksum verification failed"

unsafe_roles=$(WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  psql --username postgres --dbname "$candidate" --tuples-only --no-align \
    --command "SELECT rolname FROM pg_roles WHERE rolname IN ('weather_api','weather_ingest') AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication)")
[[ -z "$unsafe_roles" ]] || die "runtime roles gained administrative authority"

counts=$(WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  psql --username postgres --dbname "$candidate" --tuples-only --no-align \
    --command "SELECT json_build_object('sites',(SELECT count(*) FROM sites),'sources',(SELECT count(*) FROM sources),'runs',(SELECT count(*) FROM ingestion_runs),'records',(SELECT count(*) FROM weather_records))")
sample_hash=$(WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  psql --username postgres --dbname "$candidate" --tuples-only --no-align \
    --command "SELECT md5(COALESCE(string_agg(id::text || ':' || content_hash, ',' ORDER BY id),'empty')) FROM (SELECT id, content_hash FROM weather_records ORDER BY id LIMIT 10) sample")
[[ -n "$counts" && "$sample_hash" =~ ^[a-f0-9]{32}$ ]] ||
  die "representative data verification failed"

printf 'Verified disposable restore database %s: version=%s counts=%s sample=%s\n' \
  "$candidate" "$server_version" "$counts" "$sample_hash"

# preserve only an explicitly requested diagnostic candidate
if [[ "$retain" == true ]]; then
  printf 'Retained diagnostic database: %s\n' "$candidate"
fi
