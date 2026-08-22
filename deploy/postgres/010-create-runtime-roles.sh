#!/usr/bin/env bash
set -euo pipefail

# require mounted secret files
require_secret_file() {
  local variable_name="$1"
  local path="${!variable_name:-}"

  # reject missing secret paths
  if [[ -z "$path" || ! -f "$path" ]]; then
    printf 'required secret file is unavailable: %s\n' "$variable_name" >&2
    exit 1
  fi
}

# escape SQL string literals
sql_literal() {
  local value="$1"

  # reject unsafe multiline secrets
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    printf 'database role secret must be non-empty and single-line\n' >&2
    exit 1
  fi

  printf "'%s'" "${value//\'/\'\'}"
}

require_secret_file WEATHER_ADMIN_PASSWORD_FILE
require_secret_file WEATHER_OWNER_PASSWORD_FILE
require_secret_file WEATHER_API_PASSWORD_FILE
require_secret_file WEATHER_INGEST_PASSWORD_FILE

admin_password="$(<"$WEATHER_ADMIN_PASSWORD_FILE")"
owner_password="$(<"$WEATHER_OWNER_PASSWORD_FILE")"
api_password="$(<"$WEATHER_API_PASSWORD_FILE")"
ingest_password="$(<"$WEATHER_INGEST_PASSWORD_FILE")"

# separate administrator authority
if [[ -z "$admin_password" || "$admin_password" == *$'\n'* || "$admin_password" == *$'\r'* ]]; then
  printf 'database role secret must be non-empty and single-line\n' >&2
  exit 1
fi

# reject shared administrator authority
if [[ "$admin_password" == "$owner_password" ]]; then
  printf 'administrator and owner passwords must differ\n' >&2
  exit 1
fi

owner_literal="$(sql_literal "$owner_password")"
api_literal="$(sql_literal "$api_password")"
ingest_literal="$(sql_literal "$ingest_password")"

# create roles without exposing credentials in arguments or output
psql --set=ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-postgres}" <<SQL
SELECT format(
  'CREATE ROLE weather_api LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  $api_literal
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weather_api')
\gexec
ALTER ROLE weather_api WITH LOGIN PASSWORD $api_literal NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT format(
  'CREATE ROLE weather_ingest LOGIN PASSWORD %L NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  $ingest_literal
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weather_ingest')
\gexec
ALTER ROLE weather_ingest WITH LOGIN PASSWORD $ingest_literal NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

SELECT format(
  'CREATE ROLE weather_owner LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION',
  $owner_literal
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weather_owner')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO weather_owner', current_database())
\gexec
ALTER SCHEMA public OWNER TO weather_owner;
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database())
\gexec
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO weather_owner, weather_api, weather_ingest',
  current_database()
)
\gexec
ALTER ROLE weather_owner WITH LOGIN PASSWORD $owner_literal NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SQL

unset admin_password owner_password api_password ingest_password owner_literal api_literal ingest_literal
