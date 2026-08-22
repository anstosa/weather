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

  # reject shared authority
  if [[ "$admin_password" == "$owner_password" ]]; then
    die "administrator and owner secrets must differ"
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
  unset admin_password owner_password
}

# reconcile one retained cluster
reconcile_retained_cluster() {
  local admin_literal
  load_passwords
  admin_literal="$(sql_literal "$admin_password")"
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
SQL
  unset admin_literal admin_password owner_password
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
unset admin_password owner_password

# reconcile only initialized storage
if [[ -f "${PGDATA:?PGDATA is required}/PG_VERSION" ]]; then
  reconcile_retained_cluster
fi

exec /usr/local/bin/docker-entrypoint.sh "$@"
