#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# report one bounded family release transaction projection
if (($# == 2)) && [[ "$1" == --adjustment-family-release ]]; then
  [[ "$2" =~ ^[a-f0-9]{64}$ ]] || die "family action SHA256 is invalid"
  require_command node
  exec node --max-old-space-size=24 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" family-release-status "$2"
fi

# report one bounded current family source authority
if (($# == 2)) && [[ "$1" == --adjustment-family-release-current ]]; then
  [[ "$2" =~ ^(temperature|wind|rain)$ ]] || die "adjustment family is invalid"
  require_command node
  exec node --max-old-space-size=24 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" family-release-current "$2"
fi

# report only bounded fixed-root maintenance anchor presence
if (($# == 1)) && [[ "$1" == --adjustment-maintenance-v2 ]]; then
  require_command node
  exec node --max-old-space-size=16 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evidence-store.mjs" maintenance-anchor-status-v2
fi

# reject every other status operand
if (($# != 0)); then
  die "status takes no arguments"
fi

current=$(read_optional_release_state "$deploy_dir/state/current-release")
previous=$(read_optional_release_state "$deploy_dir/state/previous-release")
current=${current:-none}
previous=${previous:-none}
printf 'Current release: %s\nPrevious release: %s\n' "$current" "$previous"

# report runtime state only after activation
if [[ "$current" != none ]]; then
  current_env="$deploy_dir/releases/$current.env"
  database_name=$(env_value "$current_env" WEATHER_DATABASE_NAME)
  validate_database_name "$database_name"
  expected_link="../releases/$current.env"
  require_file "$current_env"
  [[ -L "$deploy_dir/state/active.env" ]] || die "active release link is missing"
  [[ "$(readlink "$deploy_dir/state/active.env")" == "$expected_link" ]] ||
    die "active release link does not match committed state"
  printf 'Images:\n'

  # report the four immutable references
  for name in WEATHER_SERVER_IMAGE WEATHER_WEB_IMAGE POSTGRES_IMAGE CLOUDFLARED_IMAGE; do
    image=$(env_value "$current_env" "$name")
    validate_image_reference "$image"
    printf '  %s=%s\n' "$name" "$image"
  done

  require_command docker
  compose ps
  printf 'Connector evidence:\n'
  compose ps cloudflared
  compose exec -T postgres psql --username postgres --dbname "$database_name" \
    --tuples-only --no-align --command \
    "SELECT json_build_object(
      'connector', json_build_object('service', 'cloudflared'),
      'server_version_num', current_setting('server_version_num'),
      'migration', (SELECT max(name) FROM schema_migrations),
      'worker_last_loop_at', (SELECT max(last_loop_at) FROM worker_heartbeats),
      'worker_last_success_at', (SELECT max(last_success_at) FROM worker_heartbeats),
      'latest_run', (SELECT row_to_json(run) FROM (SELECT id, state, started_at, completed_at, record_count FROM ingestion_runs ORDER BY started_at DESC, id DESC LIMIT 1) run),
      'stale_run', (SELECT row_to_json(run) FROM (SELECT id, deadline_at FROM ingestion_runs WHERE state='running' AND deadline_at < clock_timestamp() ORDER BY deadline_at ASC, id ASC LIMIT 1) run),
      'chunk_outcome', (SELECT row_to_json(chunk) FROM (SELECT id, ingestion_run_id, outcome, completed_at, error_code FROM backfill_chunk_outcomes ORDER BY completed_at DESC, id DESC LIMIT 1) chunk),
      'failure_evidence', (SELECT row_to_json(failure) FROM (SELECT id, error_classification, error_code, completed_at FROM ingestion_runs WHERE state='failed' ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1) failure),
      'weather_records', (SELECT count(*) FROM weather_records),
      'tide_coverage', (
        SELECT json_agg(coverage ORDER BY coverage.source_key)
        FROM (
          SELECT
            s.source_key,
            s.source_kind,
            count(wr.id) AS record_count,
            min(wr.valid_at) AS earliest_valid_at,
            max(wr.valid_at) AS latest_valid_at
          FROM sources s
          LEFT JOIN weather_records wr ON wr.source_id = s.id
          WHERE s.source_kind IN ('tide_observation', 'tide_prediction')
          GROUP BY s.source_key, s.source_kind
        ) coverage
      )
    )"
fi
