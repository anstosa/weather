#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

max_days=14
floor_bytes=1879048192
export_reservation_bytes=67108864
operational_margin_bytes=16777216
inode_floor=32768
evidence_root=${WEATHER_ADJUSTMENT_EVIDENCE_ROOT:-/var/lib/weather/xweather/adjustment-evidence}
temporary_root=/var/lib/weather/xweather/adjustment-evaluation-exports
lock_root=/run/lock/weather

# print bounded usage
usage() {
  cat >&2 <<'EOF'
Usage: adjustment-evaluation-export.sh FROM_DATE TO_DATE
       adjustment-evaluation-export.sh --v2 FROM_DATE TO_DATE
       adjustment-evaluation-export.sh --availability-v2 REGISTRATION_SHA256
       adjustment-evaluation-export.sh --confirmation-v2 REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX

Streams one private Ballydidean adjustment-evaluation snapshot for at most
14 inclusive America/Los_Angeles local dates. V2 daily transport is descriptive
only. Confirmation export requires the persisted function authorization.
EOF
}

# select one closed export mode
case "${1:-}" in
  --v2)
    (($# == 3)) || { usage; exit 2; }
    mode=daily_v2
    from_date=$2
    to_date=$3
    validate_calendar_date_range "$from_date" "$to_date" "$max_days"
    ;;
  --availability-v2)
    (($# == 2)) || { usage; exit 2; }
    mode=availability_v2
    registration_sha256=$2
    [[ "$registration_sha256" =~ ^[a-f0-9]{64}$ ]] ||
      die "registration SHA256 is invalid"
    ;;
  --confirmation-v2)
    (($# == 4)) || { usage; exit 2; }
    mode=confirmation_v2
    registration_sha256=$2
    access_sha256=$3
    chunk_index=$4
    [[ "$registration_sha256" =~ ^[a-f0-9]{64}$ ]] ||
      die "registration SHA256 is invalid"
    [[ "$access_sha256" =~ ^[a-f0-9]{64}$ ]] || die "access SHA256 is invalid"
    [[ "$chunk_index" =~ ^(0|[1-9]|1[0-9]|2[0-6])$ ]] ||
      die "chunk index is invalid"
    ;;
  *)
    (($# == 2)) || { usage; exit 2; }
    mode=legacy_v1
    from_date=$1
    to_date=$2
    validate_calendar_date_range "$from_date" "$to_date" "$max_days"
    ;;
esac

# require the root-owned forced operation
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "adjustment evaluation export must run through sudo"
fi

require_command df
require_command docker
require_command flock
require_command node
WEATHER_ENV_FILE=$(default_env_file)
require_file "$WEATHER_ENV_FILE"
database_name=$(env_value "$WEATHER_ENV_FILE" WEATHER_DATABASE_NAME)
validate_database_name "$database_name"
require_file "$deploy_dir/scripts/adjustment-evidence-store.mjs"
require_file "$deploy_dir/scripts/adjustment-evaluation-package.mjs"

# require edge evidence only for observation packages
if [[ "$mode" != availability_v2 ]]; then
  [[ -d "$evidence_root" && ! -L "$evidence_root" ]] ||
    die "adjustment evidence root is missing or linked"
fi

# serialize the complete reservation and wire stream
install -d -o 0 -g 0 -m 0700 "$lock_root"
[[ ! -L "$lock_root" ]] || die "adjustment export lock root is linked"
exec {export_lock_fd}>"$lock_root/adjustment-evaluation-export.lock"
chmod 0600 "$lock_root/adjustment-evaluation-export.lock"
flock -n "$export_lock_fd" || die "another adjustment evaluation export is in flight"

install -d -m 0700 "$temporary_root"
[[ ! -L "$temporary_root" ]] || die "adjustment export temporary root is linked"

# reserve the complete reviewed export envelope before any snapshot work
read -r free_bytes free_inodes < <(
  printf '%s %s\n' \
    "$(df --output=avail --block-size=1 "$temporary_root" | tail -n 1 | tr -d ' ')" \
    "$(df --output=iavail "$temporary_root" | tail -n 1 | tr -d ' ')"
)
[[ "$free_bytes" =~ ^[0-9]+$ && "$free_inodes" =~ ^[0-9]+$ ]] ||
  die "filesystem capacity could not be measured"
if ((free_bytes - export_reservation_bytes < floor_bytes + operational_margin_bytes)); then
  die "adjustment export reservation would cross the fixed filesystem floor"
fi
if ((free_inodes < inode_floor)); then
  die "adjustment export requires at least $inode_floor free inodes"
fi

temporary=$(mktemp -d "$temporary_root/.export.XXXXXXXX")
edge_snapshot="$temporary/edge-snapshot.json"

# remove only this interrupted export
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# write one closed function-only metadata query
write_function_export_sql() {
  local function_expression=$1
  cat >"$temporary/function-export.sql" <<SQL
\\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
COPY (
  SELECT jsonb_build_object(
    'databaseManifest', to_jsonb(manifest),
    'payload', $function_expression,
    'transaction', jsonb_build_object(
      'created_at_utc', to_char(
        transaction_timestamp() AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'idle_in_transaction_session_timeout',
        current_setting('idle_in_transaction_session_timeout'),
      'isolation_level', current_setting('transaction_isolation'),
      'lock_timeout', current_setting('lock_timeout'),
      'read_only', current_setting('transaction_read_only'),
      'statement_timeout', current_setting('statement_timeout')
    )
  )::text
  FROM adjustment_evaluation_export_manifest_v1 manifest
) TO STDOUT WITH (
  FORMAT csv,
  DELIMITER E'\\x01',
  QUOTE E'\\x02',
  ESCAPE E'\\x02'
);
COMMIT;
SQL
}

# query only the approved training-role function surface
run_function_export() {
  # shellcheck disable=SC2016
  WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
    sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_training_export_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --host 127.0.0.1 --username weather_training_export --dbname "$1" --set=registration_sha256="$2" --set=access_sha256="$3" --set=chunk_index="$4"' \
    adjustment-maintenance-v2-export "$database_name" \
    "${registration_sha256:-}" "${access_sha256:-}" "${chunk_index:-}" \
    <"$temporary/function-export.sql"
}

# return one value-free availability document without observation data
if [[ "$mode" == availability_v2 ]]; then
  write_function_export_sql \
    "adjustment_confirmation_availability_v2(:'registration_sha256')"
  if ! run_function_export |
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      frame-v2-availability "$registration_sha256"; then
    die "value-free adjustment confirmation availability export failed"
  fi
  exit 0
fi

# require one immutable burn authorization before confirmation rows
if [[ "$mode" == confirmation_v2 ]]; then
  authorization_envelope="$temporary/authorization-v2.json"
  write_function_export_sql \
    "adjustment_confirmation_export_v2(:'registration_sha256', :'access_sha256', :'chunk_index'::smallint)"
  if ! run_function_export |
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      frame-v2-authorization "$registration_sha256" "$access_sha256" \
      "$chunk_index" >"$authorization_envelope"; then
    die "post-burn adjustment confirmation authorization failed"
  fi
  read -r from_date to_date < <(
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      v2-authorization-dates "$authorization_envelope"
  )
  validate_calendar_date_range "$from_date" "$to_date" "$max_days"
fi

# refuse v2 daily transport before the exact 0018 ledger exists
if [[ "$mode" == daily_v2 ]]; then
  write_function_export_sql "NULL::jsonb"
  if ! run_function_export |
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      verify-v2-readiness; then
    die "adjustment maintenance v2 schema is not ready"
  fi
fi

# freeze the complete validated edge pair list before opening the database snapshot
node --max-old-space-size=48 --max-semi-space-size=1 --input-type=module - \
  "$deploy_dir/scripts/adjustment-evidence-store.mjs" "$evidence_root" "$edge_snapshot" <<'NODE'
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [, , modulePath, root, output] = process.argv;
const { freezeAdjustmentEvidenceSnapshot } = await import(pathToFileURL(modulePath));
const snapshot = await freezeAdjustmentEvidenceSnapshot({ root });
await writeFile(output, `${JSON.stringify(snapshot)}\n`, { flag: "wx", mode: 0o600 });
NODE

cat >"$temporary/export.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5min';
SET LOCAL lock_timeout = '5s';
SET LOCAL idle_in_transaction_session_timeout = '30s';
SET LOCAL weather.adjustment_evaluation_from_date TO :'from_date';
SET LOCAL weather.adjustment_evaluation_to_date TO :'to_date';
COPY (
  WITH bounded_rows AS MATERIALIZED (
    SELECT exported.*
    FROM adjustment_evaluation_export_rows_v1 exported
    ORDER BY
      exported.local_date,
      exported.valid_at,
      exported.record_kind COLLATE "C",
      exported.record_revision_identity COLLATE "C"
    LIMIT 8193
  ),
  records AS (
    SELECT
      0 AS record_order,
      NULL::date AS local_date_order,
      NULL::timestamptz AS valid_order,
      NULL::text AS kind_order,
      NULL::text AS identity_order,
      jsonb_build_object(
        'record_type', 'manifest',
        'payload', to_jsonb(manifest),
        'transaction', jsonb_build_object(
          'created_at_utc', to_char(
            transaction_timestamp() AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ),
          'from_local_date', :'from_date',
          'idle_in_transaction_session_timeout',
            current_setting('idle_in_transaction_session_timeout'),
          'isolation_level', current_setting('transaction_isolation'),
          'lock_timeout', current_setting('lock_timeout'),
          'read_only', current_setting('transaction_read_only'),
          'statement_timeout', current_setting('statement_timeout'),
          'to_local_date', :'to_date'
        )
      )::text AS line
    FROM adjustment_evaluation_export_manifest_v1 manifest

    UNION ALL

    SELECT
      1,
      exported.local_date,
      exported.valid_at,
      exported.record_kind,
      exported.record_revision_identity,
      jsonb_build_object(
        'record_type', 'row',
        'payload', jsonb_build_object(
          'compressed_body_base64', CASE
            WHEN exported.compressed_body IS NULL THEN NULL
            ELSE encode(exported.compressed_body, 'base64')
          END,
          'content_hash', exported.content_hash,
          'first_received_at', exported.first_received_at,
          'last_received_at', exported.last_received_at,
          'local_date', exported.local_date,
          'payload', exported.payload,
          'record_kind', exported.record_kind,
          'record_revision_identity', exported.record_revision_identity,
          'reference_at', exported.reference_at,
          'revision_count', exported.revision_count,
          'site_key', exported.site_key,
          'source_identity', exported.source_identity,
          'valid_at', exported.valid_at
        )
      )::text
    FROM bounded_rows exported
  )
  SELECT line
  FROM records
  ORDER BY
    record_order,
    local_date_order NULLS FIRST,
    valid_order NULLS FIRST,
    kind_order COLLATE "C" NULLS FIRST,
    identity_order COLLATE "C" NULLS FIRST
) TO STDOUT WITH (
  FORMAT csv,
  DELIMITER E'\x01',
  QUOTE E'\x02',
  ESCAPE E'\x02'
);
COMMIT;
SQL

# stream one unchanged v1 observation package
stream_observation_archive() {
  # shellcheck disable=SC2016
  WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
    sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_training_export_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --host 127.0.0.1 --username weather_training_export --dbname "$1" --set=from_date="$2" --set=to_date="$3"' \
    adjustment-evaluation-export "$database_name" "$from_date" "$to_date" \
    <"$temporary/export.sql" |
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      stream-archive "$temporary" "$from_date" "$to_date" "$edge_snapshot"
}

# retain the byte-compatible v1 wire behavior
if [[ "$mode" == legacy_v1 ]]; then
  if ! stream_observation_archive; then
    die "read-only adjustment evaluation export failed"
  fi
  exit 0
fi

# stage one bounded v1 archive so its v2 header can bind exact wire bytes
source_archive="$temporary/source-v1.tar.gz"
if ! stream_observation_archive >"$source_archive"; then
  die "read-only adjustment evaluation export failed"
fi
if [[ "$mode" == daily_v2 ]]; then
  node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    stream-v2-envelope daily_monitoring "$source_archive" "$from_date" \
    "$to_date" "$edge_snapshot"
else
  node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    stream-v2-envelope post_burn_confirmation "$source_archive" "$from_date" \
    "$to_date" "$edge_snapshot" "$authorization_envelope"
fi
