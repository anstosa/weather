#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

max_days=450
max_rows=4000000
conservative_export_rows=3045600
export_row_headroom=954400

# print bounded usage
usage() {
  cat >&2 <<'EOF'
Usage: forecast-training-export.sh FROM_DATE TO_DATE

Streams one read-only Ballydidean training snapshot for inclusive local dates.
Both dates must use YYYY-MM-DD and the range may contain at most 450 dates.
EOF
}

# require exactly the forced date operands
if (($# != 2)); then
  usage
  exit 2
fi

from_date=$1
to_date=$2
validate_calendar_date_range "$from_date" "$to_date" "$max_days"

# require the root-owned forced operation
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "forecast-training export must run through sudo"
fi

# freeze the reviewed capacity oracle
if ((conservative_export_rows + export_row_headroom != max_rows)); then
  die "export capacity oracle is inconsistent"
fi

require_command docker
require_command gzip
require_command node
require_command tar
WEATHER_ENV_FILE=$(default_env_file)
require_file "$WEATHER_ENV_FILE"
database_name=$(env_value "$WEATHER_ENV_FILE" WEATHER_DATABASE_NAME)
validate_database_name "$database_name"
temporary=$(mktemp -d /tmp/weather-forecast-training.XXXXXXXX)
transaction_stream="$temporary/transaction.jsonl.partial"
query_errors="$temporary/query.stderr"
package_root="$temporary/package"

# remove every server-side temporary
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

cat >"$temporary/export.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '15min';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SET LOCAL weather.forecast_training_from_date TO :'from_date';
SET LOCAL weather.forecast_training_to_date TO :'to_date';
COPY (
  WITH requested AS (
    SELECT
      :'from_date'::date AS from_date,
      :'to_date'::date AS to_date,
      (:'from_date'::date::timestamp AT TIME ZONE 'America/Los_Angeles') AS start_inclusive,
      ((:'to_date'::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles') AS end_exclusive
  ),
  bounded_rows AS (
    SELECT exported.*
    FROM forecast_training_export_rows_v1 exported
    CROSS JOIN requested
    WHERE exported.site_key = 'ballydidean'
      AND exported.valid_at >= requested.start_inclusive
      AND exported.valid_at < requested.end_exclusive
    ORDER BY
      exported.valid_at,
      exported.record_kind COLLATE "C",
      exported.physical_station_key COLLATE "C" NULLS FIRST,
      exported.reference_at NULLS FIRST,
      exported.target_lead_hours NULLS FIRST,
      exported.source_keys::text COLLATE "C",
      exported.content_hashes::text COLLATE "C"
    LIMIT 4000001
  ),
  records AS (
    SELECT
      0 AS record_order,
      NULL::timestamptz AS valid_order,
      NULL::text AS kind_order,
      NULL::text AS station_order,
      NULL::timestamptz AS reference_order,
      NULL::smallint AS lead_order,
      NULL::text AS source_order,
      NULL::text AS hash_order,
      jsonb_build_object(
        'record_type', 'manifest',
        'payload', to_jsonb(manifest),
        'transaction', jsonb_build_object(
          'created_at_utc', to_char(
            transaction_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'from_local_date', requested.from_date::text,
          'idle_in_transaction_session_timeout',
            current_setting('idle_in_transaction_session_timeout'),
          'isolation_level', current_setting('transaction_isolation'),
          'lock_timeout', current_setting('lock_timeout'),
          'read_only', current_setting('transaction_read_only'),
          'statement_timeout', current_setting('statement_timeout'),
          'to_local_date', requested.to_date::text
        )
      )::text AS line
    FROM forecast_training_export_manifest_v1 manifest
    CROSS JOIN requested

    UNION ALL

    SELECT
      1,
      exported.valid_at,
      exported.record_kind,
      exported.physical_station_key,
      exported.reference_at,
      exported.target_lead_hours,
      exported.source_keys::text,
      exported.content_hashes::text,
      jsonb_build_object(
        'record_type', 'row',
        'payload',
          to_jsonb(exported)
          || jsonb_build_object(
            'received_at', CASE
              WHEN exported.received_at IS NULL THEN NULL
              ELSE to_char(
                exported.received_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            END,
            'reference_at', CASE
              WHEN exported.reference_at IS NULL THEN NULL
              ELSE to_char(
                exported.reference_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              )
            END,
            'valid_at', to_char(
              exported.valid_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
          )
      )::text
    FROM bounded_rows exported
  )
  SELECT line
  FROM records
  ORDER BY
    record_order,
    valid_order,
    kind_order COLLATE "C" NULLS FIRST,
    station_order COLLATE "C" NULLS FIRST,
    reference_order NULLS FIRST,
    lead_order NULLS FIRST,
    source_order COLLATE "C" NULLS FIRST,
    hash_order COLLATE "C" NULLS FIRST
) TO STDOUT;
COMMIT;
SQL

# run the fixed query through only the read-only role
# shellcheck disable=SC2016
if ! WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_training_export_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --host 127.0.0.1 --username weather_training_export --dbname "$1" --set=from_date="$2" --set=to_date="$3"' \
  weather-training-export "$database_name" "$from_date" "$to_date" \
  <"$temporary/export.sql" >"$transaction_stream" 2>"$query_errors"; then
  die "read-only training export query failed"
fi

# package only after schema, lineage, bounds, and row-cap verification
manifest_hash=$(node "$deploy_dir/scripts/forecast-training-package.mjs" \
  build "$transaction_stream" "$package_root" "$from_date" "$to_date")
[[ "$manifest_hash" =~ ^[a-f0-9]{64}$ ]] || die "training export manifest hash is invalid"

printf 'Streaming verified Ballydidean forecast-training export %s..%s manifest=%s rows<=%d oracle=%d export_rows_not_training_events\n' \
  "$from_date" "$to_date" "$manifest_hash" "$max_rows" "$conservative_export_rows" >&2

# publish only one deterministic compressed package stream
tar --create --format=ustar --sort=name --mtime=@0 --owner=0 --group=0 \
  --numeric-owner --directory "$package_root" . |
  gzip --no-name --best
