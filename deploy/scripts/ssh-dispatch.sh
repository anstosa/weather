#!/usr/bin/env bash
set -euo pipefail

# install as the weather-ssh authorized_keys forced command
original=${SSH_ORIGINAL_COMMAND:-}

# allow only fixed Weather operator verbs
if [[ ! "$original" =~ ^(status|rollback|recover|backup|preflight|tempest-backfill)$ &&
  ! "$original" =~ ^(stage|activate)\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ ]]; then
  printf 'operation denied\n' >&2
  exit 126
fi

set -f
read -r -a operation <<<"$original"
exec sudo -n /usr/local/sbin/weather-remote-ops "${operation[@]}"
