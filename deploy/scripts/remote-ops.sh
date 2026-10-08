#!/usr/bin/env bash
set -euo pipefail

# require the root-owned sudo boundary
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  printf 'error: remote operations must run through sudo\n' >&2
  exit 1
fi

deploy_dir=/opt/weather/current/deploy

# require the isolated Weather deployment
if [[ ! -d "$deploy_dir" ]]; then
  printf 'error: deployment directory not found: %s\n' "$deploy_dir" >&2
  exit 1
fi

# shellcheck source=common.sh
source "$deploy_dir/scripts/common.sh"

(($# >= 1)) || { printf 'error: missing operation\n' >&2; exit 2; }
action=$1
shift

case "$action" in
  # expose only the bounded non-authoritative maintenance projection
  adjustment-maintenance-anchor-status-v2)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/status.sh" --adjustment-maintenance-v2
    ;;
  status|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }

    # map non-release operations explicitly
    case "$action" in
      backup) exec "$deploy_dir/scripts/backup.sh" ;;
      backup-stream) exec "$deploy_dir/scripts/backup-stream.sh" ;;
      public-stations-backfill) exec "$deploy_dir/scripts/public-stations-backfill.sh" ;;
      tempest-backfill) exec "$deploy_dir/scripts/tempest-backfill.sh" ;;
      tide-backfill) exec "$deploy_dir/scripts/tide-backfill.sh" ;;
      preflight)
        exec "$deploy_dir/scripts/preflight-capacity.sh" --sample-seconds 900 \
          --json /var/lib/weather/preflight-v13-resource.json
        ;;
      *) exec "$deploy_dir/scripts/update.sh" "$action" ;;
    esac
    ;;
  yolo|stage|activate)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ ]] || {
      printf 'error: invalid release\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/update.sh" "$action" "$1"
    ;;
  # export only one fixed Ballydidean date window
  forecast-training-export)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    validate_calendar_date_range "$1" "$2" 450
    exec "$deploy_dir/scripts/forecast-training-export.sh" "$1" "$2"
    ;;
  # export only one fixed Ballydidean evaluation window
  adjustment-evaluation-export|adjustment-evaluation-export-v2)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    validate_calendar_date_range "$1" "$2" 14
    # retain the v1 default and select only the closed v2 mode
    if [[ "$action" == adjustment-evaluation-export-v2 ]]; then
      exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" --v2 "$1" "$2"
    fi
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" "$1" "$2"
    ;;
  # install only one hash-bound sanitized scorecard from standard input
  install-adjustment-scorecard|install-adjustment-scorecard-v2)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid scorecard hash\n' >&2
      exit 2
    }
    # keep v2 schema selection explicit at the privilege boundary
    if [[ "$action" == install-adjustment-scorecard-v2 ]]; then
      exec "$deploy_dir/scripts/install-adjustment-scorecard.sh" --v2 "$1"
    fi
    exec "$deploy_dir/scripts/install-adjustment-scorecard.sh" "$1"
    ;;
  # read only value-free availability through the pinned registration function
  adjustment-confirmation-availability-v2)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || { printf 'error: invalid registration hash\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" --availability-v2 "$1"
    ;;
  # export only one function-authorized post-burn confirmation chunk
  adjustment-confirmation-export-v2)
    (($# == 3)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ &&
      "$3" =~ ^([0-9]|1[0-9]|2[0-6])$ ]] || {
      printf 'error: invalid confirmation identity\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" --confirmation-v2 "$1" "$2" "$3"
    ;;
  # export only the current fixed-root archive page
  adjustment-archive-next)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" archive-next
    ;;
  # acknowledge only one fixed-root page and open-cycle checkpoint pair
  adjustment-archive-ack)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid archive checkpoint acknowledgement\n' >&2
      exit 2
    }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" archive-ack "$1" "$2"
    ;;
  # acknowledge only one fixed-root final manifest and cold graph pair
  adjustment-archive-ack-final)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid archive final acknowledgement\n' >&2
      exit 2
    }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" archive-ack-final "$1" "$2"
    ;;
  *) printf 'error: operation denied\n' >&2; exit 126 ;;
esac
