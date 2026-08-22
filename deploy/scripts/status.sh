#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

current=$(read_optional_release_state "$deploy_dir/state/current-release")
previous=$(read_optional_release_state "$deploy_dir/state/previous-release")
current=${current:-none}
previous=${previous:-none}
printf 'Current release: %s\nPrevious release: %s\n' "$current" "$previous"

# report runtime state only after activation
if [[ "$current" != none ]]; then
  require_command docker
  compose ps
  compose exec -T postgres psql --username postgres --dbname weather \
    --tuples-only --no-align --command \
    "SELECT json_build_object(
      'server_version_num', current_setting('server_version_num'),
      'migration', (SELECT max(name) FROM schema_migrations),
      'worker_last_loop_at', (SELECT max(last_loop_at) FROM worker_heartbeats),
      'worker_last_success_at', (SELECT max(last_success_at) FROM worker_heartbeats),
      'running_past_deadline', (SELECT count(*) FROM ingestion_runs WHERE state='running' AND deadline_at < clock_timestamp()),
      'weather_records', (SELECT count(*) FROM weather_records)
    )"
fi
