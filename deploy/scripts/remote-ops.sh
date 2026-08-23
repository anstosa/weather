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

(($# >= 1)) || { printf 'error: missing operation\n' >&2; exit 2; }
action=$1
shift

case "$action" in
  status|rollback|recover|backup|preflight|tempest-backfill)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }

    # map non-release operations explicitly
    case "$action" in
      backup) exec "$deploy_dir/scripts/backup.sh" ;;
      tempest-backfill) exec "$deploy_dir/scripts/tempest-backfill.sh" ;;
      preflight)
        exec "$deploy_dir/scripts/preflight-capacity.sh" --sample-seconds 900 \
          --json "/var/lib/weather/preflight-$(date -u +%Y%m%dT%H%M%SZ).json"
        ;;
      *) exec "$deploy_dir/scripts/update.sh" "$action" ;;
    esac
    ;;
  stage|activate)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ ]] || {
      printf 'error: invalid release\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/update.sh" "$action" "$1"
    ;;
  *) printf 'error: operation denied\n' >&2; exit 126 ;;
esac
