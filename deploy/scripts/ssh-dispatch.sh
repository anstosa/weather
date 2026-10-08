#!/usr/bin/env bash
set -euo pipefail

# install as the weather-ssh authorized_keys forced command
original=${SSH_ORIGINAL_COMMAND:-}

# allow only fixed Weather operator verbs
if [[ ! "$original" =~ ^(status|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|adjustment-archive-next|adjustment-maintenance-anchor-status-v2)$ &&
  ! "$original" =~ ^(yolo|stage|activate)\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ &&
  ! "$original" =~ ^forecast-training-export\ [0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
  ! "$original" =~ ^adjustment-evaluation-export(-v2)?\ [0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
  ! "$original" =~ ^install-adjustment-scorecard(-v2)?\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-confirmation-availability-v2\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-confirmation-export-v2\ [a-f0-9]{64}\ [a-f0-9]{64}\ ([0-9]|1[0-9]|2[0-6])$ &&
  ! "$original" =~ ^adjustment-archive-ack\ [a-f0-9]{64}\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-archive-ack-final\ [a-f0-9]{64}\ [a-f0-9]{64}$ ]]; then
  printf 'operation denied\n' >&2
  exit 126
fi

set -f
read -r -a operation <<<"$original"
exec sudo -n /usr/local/sbin/weather-remote-ops "${operation[@]}"
