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

Streams one private Ballydidean adjustment-evaluation snapshot for at most
14 inclusive local dates. Split a refused interval into one-date exports.
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
[[ -d "$evidence_root" && ! -L "$evidence_root" ]] ||
  die "adjustment evidence root is missing or linked"

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

# stream through the read-only export role into bounded package members
# shellcheck disable=SC2016
if ! WEATHER_ENV_FILE=$WEATHER_ENV_FILE compose exec -T postgres \
  sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_training_export_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --host 127.0.0.1 --username weather_training_export --dbname "$1" --set=from_date="$2" --set=to_date="$3"' \
  adjustment-evaluation-export "$database_name" "$from_date" "$to_date" \
  <"$temporary/export.sql" |
  node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    stream-archive "$temporary" "$from_date" "$to_date" "$edge_snapshot"; then
  die "read-only adjustment evaluation export failed"
fi
