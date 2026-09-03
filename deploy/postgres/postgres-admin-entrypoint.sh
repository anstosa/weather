#!/usr/bin/env bash
set -euo pipefail

temporary_server_started=0

# report one bounded failure
die() {
  printf 'postgres administrator reconciliation failed: %s\n' "$1" >&2
  exit 1
}

# read one mounted secret
read_secret() {
  local path=$1
  local description=$2
  local value
  [[ -n "$path" && -f "$path" ]] || die "$description secret is unavailable"
  value="$(<"$path")"

  # reject unsafe secret values
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    die "$description secret must be non-empty and single-line"
  fi

  printf '%s' "$value"
}

# escape one SQL literal
sql_literal() {
  printf "'%s'" "${1//\'/\'\'}"
}

# stop only this temporary server
stop_temporary_server() {
  # preserve an absent server
  if [[ "$temporary_server_started" == 1 ]]; then
    pg_ctl --pgdata "$PGDATA" --mode fast --wait stop >/dev/null
    temporary_server_started=0
  fi
}

# load and separate administrator authority
load_passwords() {
  admin_password="$(read_secret "${WEATHER_ADMIN_PASSWORD_FILE:-}" administrator)"
  owner_password="$(read_secret "${WEATHER_OWNER_PASSWORD_FILE:-}" owner)"
  api_password="$(read_secret "${WEATHER_API_PASSWORD_FILE:-}" api)"
  ingest_password="$(read_secret "${WEATHER_INGEST_PASSWORD_FILE:-}" ingest)"
  training_export_password="$(read_secret "${WEATHER_TRAINING_EXPORT_PASSWORD_FILE:-}" training-export)"

  # reject shared authority
  if [[ "$admin_password" == "$owner_password" ]]; then
    die "administrator and owner secrets must differ"
  fi

  # reject shared training-export authority
  if [[ "$training_export_password" == "$admin_password" ||
    "$training_export_password" == "$owner_password" ||
    "$training_export_password" == "$api_password" ||
    "$training_export_password" == "$ingest_password" ]]; then
    die "training export secret must differ from every runtime secret"
  fi
}

# authenticate the configured administrator
check_health() {
  load_passwords
  PGPASSWORD="$admin_password" psql \
    --no-password \
    --no-psqlrc \
    --quiet \
    --host postgres \
    --username "${POSTGRES_USER:-postgres}" \
    --dbname "${POSTGRES_DB:-postgres}" \
    --command "SELECT 1" >/dev/null 2>&1
  unset admin_password owner_password api_password ingest_password
  unset training_export_password
}

# reconcile one retained cluster
reconcile_retained_cluster() {
  local admin_literal training_export_literal acl_ready
  load_passwords
  admin_literal="$(sql_literal "$admin_password")"
  training_export_literal="$(sql_literal "$training_export_password")"
  trap stop_temporary_server EXIT
  pg_ctl \
    --pgdata "$PGDATA" \
    --options "-c listen_addresses='' -c unix_socket_directories=/var/run/postgresql" \
    --log /tmp/weather-postgres-reconcile.log \
    --wait start >/dev/null
  temporary_server_started=1
  psql \
    --no-psqlrc \
    --quiet \
    --host /var/run/postgresql \
    --username "${POSTGRES_USER:-postgres}" \
    --dbname "${POSTGRES_DB:-postgres}" \
    --set ON_ERROR_STOP=1 >/dev/null <<SQL
ALTER ROLE postgres WITH LOGIN PASSWORD $admin_literal;
SELECT format(
  'CREATE ROLE weather_training_export LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS',
  $training_export_literal
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weather_training_export')
\gexec
ALTER ROLE weather_training_export WITH LOGIN PASSWORD $training_export_literal NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
-- clear database-specific role defaults
SELECT format(
  'ALTER ROLE weather_training_export IN DATABASE %I RESET ALL',
  database.datname
)
FROM pg_db_role_setting setting
JOIN pg_database database ON database.oid = setting.setdatabase
WHERE setting.setrole = 'weather_training_export'::regrole
ORDER BY database.datname
\gexec
ALTER ROLE weather_training_export RESET ALL;
ALTER ROLE weather_training_export SET default_transaction_read_only = on;
SELECT format('REVOKE %I FROM weather_training_export', granted_role.rolname)
FROM pg_auth_members membership
JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
WHERE membership.member = 'weather_training_export'::regrole
\gexec
SQL
  acl_ready=$(psql \
    --no-psqlrc \
    --quiet \
    --host /var/run/postgresql \
    --username "${POSTGRES_USER:-postgres}" \
    --dbname "${POSTGRES_DB:-postgres}" \
    --set ON_ERROR_STOP=1 \
    --tuples-only --no-align \
    --command "SELECT to_regclass('forecast_training_export_rows_v1') IS NOT NULL")

  # retain forward-only ACL authority after application rollback
  if [[ "$acl_ready" == t ]]; then
    [[ -f "${WEATHER_RUNTIME_ACL_PATH:-}" ]] || die "runtime ACL v2 is unavailable"
    psql \
      --no-psqlrc \
      --quiet \
      --host /var/run/postgresql \
      --username "${POSTGRES_USER:-postgres}" \
      --dbname "${POSTGRES_DB:-postgres}" \
      --set ON_ERROR_STOP=1 \
      --file "$WEATHER_RUNTIME_ACL_PATH" >/dev/null
  fi

  unset admin_literal training_export_literal admin_password owner_password
  unset api_password ingest_password training_export_password acl_ready
  stop_temporary_server
  rm -f /tmp/weather-postgres-reconcile.log
  trap - EXIT
}

# run only the credentialed health probe
if [[ "${1:-}" == health ]]; then
  check_health
  exit 0
fi

load_passwords
unset admin_password owner_password api_password ingest_password
unset training_export_password

# reconcile only initialized storage
if [[ -f "${PGDATA:?PGDATA is required}/PG_VERSION" ]]; then
  reconcile_retained_cluster
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
