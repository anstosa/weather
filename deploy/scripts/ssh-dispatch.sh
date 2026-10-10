#!/usr/bin/env bash
set -euo pipefail

# install as the weather-ssh authorized_keys forced command
original=${SSH_ORIGINAL_COMMAND:-}

# allow only fixed Weather operator verbs
if [[ ! "$original" =~ ^(status|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|adjustment-archive-next|adjustment-maintenance-anchor-status-v2)$ &&
  ! "$original" =~ ^dashboard-rollback(-core)?$ &&
  ! "$original" =~ ^dashboard-release\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ &&
  ! "$original" =~ ^(yolo|stage|activate)\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ &&
  ! "$original" =~ ^adjustment-family-release\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?\ [0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?\ [a-f0-9]{64}\ (temperature|wind|rain)\ [a-f0-9]{64}\ [a-f0-9]{64}\ [1-9][0-9]{0,19}$ &&
  ! "$original" =~ ^adjustment-family-release-status\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-family-release-current-v1\ (temperature|wind|rain)$ &&
  ! "$original" =~ ^adjustment-family-release-lineage-v2$ &&
  ! "$original" =~ ^adjustment-revision-capture-epoch-v1$ &&
  ! "$original" =~ ^adjustment-revision-capture-epoch-snapshot-v1$ &&
  ! "$original" =~ ^adjustment-registration-schedule-status-v3$ &&
  ! "$original" =~ ^adjustment-registration-lifecycle-status-v4$ &&
  ! "$original" =~ ^adjustment-shadow-metadata-custody-status-v1$ &&
  ! "$original" =~ ^adjustment-shadow-metadata-custody-finalize-v1\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-confirmation-access-burn-v3\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-shadow-terminal-record-v3\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-shadow-terminal-retire-v3\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-shadow-unsupported-terminal-record-v1\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-shadow-unsupported-terminal-retire-v1\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-registration-schedule-initialize-v3\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-database-ledger-v3$ &&
  ! "$original" =~ ^adjustment-revision-catalog-current-start-v1\ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ &&
  ! "$original" =~ ^adjustment-revision-catalog-start-v1\ [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\ (0|[1-9][0-9]{0,18})$ &&
  ! "$original" =~ ^adjustment-revision-catalog-page-v1\ (0|[1-9][0-9]{0,18})\ [a-f0-9]{64}\ [a-f0-9]{64}\ (0|[1-9][0-9]{0,18})\ [a-f0-9]{64}\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-revision-custody-ack-v1\ (0|[1-9][0-9]{0,18})\ [a-f0-9]{64}\ [a-f0-9]{64}\ (0|[1-9][0-9]{0,18})\ [a-f0-9]{64}\ [a-f0-9]{64}\ [a-f0-9]{64}\ [a-f0-9]{64}\ [a-f0-9]{64}\ (none|[a-f0-9]{64})$ &&
  ! "$original" =~ ^adjustment-revision-custody-ack-v2\ (0|[1-9][0-9]{0,18})\ [a-f0-9]{64}\ [a-f0-9]{64}\ (0|[1-9][0-9]{0,18})\ [a-f0-9]{64}\ [a-f0-9]{64}\ [a-f0-9]{64}\ [a-f0-9]{64}\ [a-f0-9]{64}\ (none|[a-f0-9]{64})$ &&
  ! "$original" =~ ^adjustment-revision-gap-start-v1$ &&
  ! "$original" =~ ^adjustment-revision-gap-page-v1\ [a-f0-9]{64}\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-revision-gap-ack-v1\ [a-f0-9]{64}\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^forecast-training-export\ [0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
  ! "$original" =~ ^adjustment-evaluation-export(-v2)?\ [0-9]{4}-[0-9]{2}-[0-9]{2}\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ &&
  ! "$original" =~ ^install-adjustment-scorecard(-v2)?\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-confirmation-availability-v2\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-confirmation-export-v2\ [a-f0-9]{64}\ [a-f0-9]{64}\ ([0-9]|1[0-9]|2[0-6])$ &&
  ! "$original" =~ ^adjustment-development-custody-anchor-install-v1\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-development-custody-anchor-current-v1$ &&
  ! "$original" =~ ^adjustment-rain-control-custody-anchor-install-v1\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-rain-control-custody-anchor-current-v1$ &&
  ! "$original" =~ ^adjustment-unsupported-terminal-proof-install-v1\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-unsupported-terminal-proof-current-v1$ &&
  ! "$original" =~ ^adjustment-future-input-seal-current-v2$ &&
  ! "$original" =~ ^adjustment-maintenance-anchor-current-v3$ &&
  ! "$original" =~ ^adjustment-maintenance-anchor-install-v2\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-future-input-seal-install-v2\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-maintenance-anchor-install-v3\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-maintenance-anchor-finalize-v2\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-maintenance-anchor-finalize-v3\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-archive-ack\ [a-f0-9]{64}\ [a-f0-9]{64}$ &&
  ! "$original" =~ ^adjustment-archive-ack-final\ [a-f0-9]{64}\ [a-f0-9]{64}$ ]]; then
  printf 'operation denied\n' >&2
  exit 126
fi

set -f
read -r -a operation <<<"$original"
exec sudo -n /usr/local/sbin/weather-remote-ops "${operation[@]}"
