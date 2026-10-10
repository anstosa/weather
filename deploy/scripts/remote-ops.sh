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
  # execute one web-only release under exact core and source CAS
  dashboard-release)
    (($# == 3)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    for release in "$1" "$2" "$3"; do
      [[ "$release" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ ]] || {
        printf 'error: invalid dashboard release\n' >&2
        exit 2
      }
    done
    exec "$deploy_dir/scripts/update.sh" dashboard-release "$@"
    ;;
  # roll back only the current web override
  dashboard-rollback)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/update.sh" dashboard-rollback
    ;;
  # return directly to the pinned core web from any override depth
  dashboard-rollback-core)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/update.sh" dashboard-rollback-core
    ;;
  # execute one fenced family-only release with a prebuilt compensation release
  adjustment-family-release)
    (($# == 9)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    for release in "$1" "$2" "$3" "$4"; do
      [[ "$release" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}-[1-9][0-9]?$ ]] || {
        printf 'error: invalid family release\n' >&2
        exit 2
      }
    done
    [[ "$5" =~ ^[a-f0-9]{64}$ && "$6" =~ ^(temperature|wind|rain)$ &&
      "$7" =~ ^[a-f0-9]{64}$ && "$8" =~ ^[a-f0-9]{64}$ &&
      "$9" =~ ^[1-9][0-9]{0,19}$ ]] || {
      printf 'error: invalid family release identity\n' >&2
      exit 2
    }
    # compare equal-width decimal strings without signed overflow
    # shellcheck disable=SC2071
    [[ ${#9} -lt 20 || "$9" < 18446744073709551616 ]] || {
      printf 'error: family release fence overflows uint64\n' >&2
      exit 2
    }
    [[ "$3" == "$4" && "$1" != "$2" && "$1" != "$3" && "$2" != "$3" ]] || {
      printf 'error: family release identities conflict\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/update.sh" adjustment-family-release "$@"
    ;;
  # expose one bounded categorical family transaction status
  adjustment-family-release-status)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid family action hash\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/status.sh" --adjustment-family-release "$1"
    ;;
  # expose one exact current family source authority
  adjustment-family-release-current-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^(temperature|wind|rain)$ ]] || {
      printf 'error: invalid adjustment family\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/status.sh" --adjustment-family-release-current "$1"
    ;;
  # expose one root-verified transitive release lineage without caller operands
  adjustment-family-release-lineage-v2)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      family-release-lineage-v2
    ;;
  # expose only the authenticated create-once future capture epoch
  adjustment-revision-capture-epoch-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      revision-capture-epoch-read-v1
    ;;
  # expose the exact database snapshot sealed by the capture epoch
  adjustment-revision-capture-epoch-snapshot-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      revision-capture-epoch-snapshot-read-v1
    ;;
  # initialize only the retained epoch-bound rolling schedule with canonical stdin
  adjustment-registration-schedule-initialize-v3)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid schedule bootstrap hash\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/update.sh" adjustment-registration-schedule-initialize-v3 "$1"
    ;;
  # expose the current append-only finite schedule through fixed read-only functions
  adjustment-registration-schedule-status-v3)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" --registration-schedule-status-v3
    ;;
  # expose only the fixed owner-read lifecycle projection
  adjustment-registration-lifecycle-status-v4)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/update.sh" adjustment-registration-lifecycle-status-v4
    ;;
  # expose only the current compact-metadata custody proof and preparation
  adjustment-shadow-metadata-custody-status-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
        shadow-metadata-custody-status-v1
    ;;
  # run only the root owner bridge for one exact current proof
  adjustment-shadow-metadata-custody-finalize-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid shadow metadata custody proof hash\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/update.sh" \
      adjustment-shadow-metadata-custody-finalize-v1 "$1"
    ;;
  # run one exact terminal lifecycle owner bridge over canonical bounded stdin
  adjustment-confirmation-access-burn-v3|adjustment-shadow-terminal-record-v3|adjustment-shadow-terminal-retire-v3|adjustment-shadow-unsupported-terminal-record-v1|adjustment-shadow-unsupported-terminal-retire-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid terminal lifecycle request hash\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/update.sh" "$action" "$1"
    ;;
  # expose only the live migration ledger and its database transaction clock
  adjustment-database-ledger-v3)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" --database-ledger-v3
    ;;
  # freeze the server-authenticated current frontier at one logical cutoff
  adjustment-revision-catalog-current-start-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] || {
      printf 'error: invalid revision catalog cutoff\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" \
      --revision-catalog-current-start-v1 "$1"
    ;;
  # freeze one cutoff-bound revision transfer and its authoritative watermark
  adjustment-revision-catalog-start-v1)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ &&
      "$2" =~ ^(0|[1-9][0-9]{0,18})$ ]] || {
      printf 'error: invalid revision catalog start\n' >&2
      exit 2
    }
    # compare equal-width decimal strings without signed overflow
    # shellcheck disable=SC2071
    [[ ${#2} -lt 19 || "$2" < 9223372036854775808 ]] || {
      printf 'error: revision watermark overflows bigint\n' >&2
      exit 2
    }
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" \
      --revision-catalog-start-v1 "$1" "$2"
    ;;
  # read one bounded direct-successor page from the frozen revision transfer
  adjustment-revision-catalog-page-v1)
    (($# == 6)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^(0|[1-9][0-9]{0,18})$ && "$4" =~ ^(0|[1-9][0-9]{0,18})$ &&
      "$2" =~ ^[a-f0-9]{64}$ && "$3" =~ ^[a-f0-9]{64}$ &&
      "$5" =~ ^[a-f0-9]{64}$ && "$6" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid revision catalog page\n' >&2
      exit 2
    }
    # bound both server-produced database ordinals
    for ordinal in "$1" "$4"; do
      # compare equal-width decimal strings without signed overflow
      # shellcheck disable=SC2071
      [[ ${#ordinal} -lt 19 || "$ordinal" < 9223372036854775808 ]] || {
        printf 'error: revision page ordinal overflows bigint\n' >&2
        exit 2
      }
    done
    exec "$deploy_dir/scripts/adjustment-evaluation-export.sh" \
      --revision-catalog-page-v1 "$@"
    ;;
  # checkpoint graph or packed custody before exact successful-spool retirement
  adjustment-revision-custody-ack-v1|adjustment-revision-custody-ack-v2)
    (($# == 10)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^(0|[1-9][0-9]{0,18})$ && "$4" =~ ^(0|[1-9][0-9]{0,18})$ &&
      "$2" =~ ^[a-f0-9]{64}$ && "$3" =~ ^[a-f0-9]{64}$ &&
      "$5" =~ ^[a-f0-9]{64}$ && "$6" =~ ^[a-f0-9]{64}$ &&
      "$7" =~ ^[a-f0-9]{64}$ && "$8" =~ ^[a-f0-9]{64}$ &&
      "$9" =~ ^[a-f0-9]{64}$ && "${10}" =~ ^(none|[a-f0-9]{64})$ ]] || {
      printf 'error: invalid revision custody acknowledgement\n' >&2
      exit 2
    }
    # bound both server-produced database ordinals
    for ordinal in "$1" "$4"; do
      # compare equal-width decimal strings without signed overflow
      # shellcheck disable=SC2071
      [[ ${#ordinal} -lt 19 || "$ordinal" < 9223372036854775808 ]] || {
        printf 'error: revision custody ordinal overflows bigint\n' >&2
        exit 2
      }
    done
    require_command node
    require_command setpriv
    revision_custody_action=${action/adjustment-revision/revision-cold}
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      "$revision_custody_action" "$@"
    ;;
  # expose one bounded permanent-gap transfer snapshot
  adjustment-revision-gap-start-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" revision-gap-start-v1
    ;;
  # expose one exact pending permanent-gap payload page
  adjustment-revision-gap-page-v1)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid revision gap page identity\n' >&2
      exit 2
    }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" revision-gap-page-v1 "$1" "$2"
    ;;
  # acknowledge only one fully archived permanent-gap page
  adjustment-revision-gap-ack-v1)
    (($# == 2)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid revision gap acknowledgement\n' >&2
      exit 2
    }
    require_command node
    require_command setpriv
    exec setpriv --reuid=10002 --regid=10002 --clear-groups \
      node "$deploy_dir/scripts/adjustment-evidence-store.mjs" revision-gap-ack-v1 "$1" "$2"
    ;;
  # expose only the bounded non-authoritative maintenance projection
  adjustment-maintenance-anchor-status-v2)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    exec "$deploy_dir/scripts/status.sh" --adjustment-maintenance-v2
    ;;
  # install one canonical shadow-only development custody anchor
  adjustment-development-custody-anchor-install-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid development custody anchor hash\n' >&2
      exit 2
    }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      development-custody-anchor-install-v1 "$1"
    ;;
  # read only the current server-derived development custody predecessor
  adjustment-development-custody-anchor-current-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      development-custody-anchor-current-v1
    ;;
  # install one canonical custody-only rain control-reference anchor
  adjustment-rain-control-custody-anchor-install-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid rain control custody anchor hash\n' >&2
      exit 2
    }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      rain-control-custody-anchor-install-v1 "$1"
    ;;
  # read only the current server-derived rain control custody predecessor
  adjustment-rain-control-custody-anchor-current-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      rain-control-custody-anchor-current-v1
    ;;
  # install one canonical custody-only unsupported terminal proof
  adjustment-unsupported-terminal-proof-install-v1)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid unsupported terminal proof hash\n' >&2
      exit 2
    }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      unsupported-terminal-proof-install-v1 "$1"
    ;;
  # read only the current unsupported terminal predecessor
  adjustment-unsupported-terminal-proof-current-v1)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      unsupported-terminal-proof-current-v1
    ;;
  # read one exact current future-only seal or null genesis marker
  adjustment-future-input-seal-current-v2)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node --max-old-space-size=32 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evidence-store.mjs" future-input-seal-current-v2
    ;;
  # read one exact current future-only v3 anchor or null genesis marker
  adjustment-maintenance-anchor-current-v3)
    (($# == 0)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node --max-old-space-size=32 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evidence-store.mjs" maintenance-anchor-current-v3
    ;;
  # install one canonical future-only seal from bounded standard input
  adjustment-future-input-seal-install-v2)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid future-only input seal hash\n' >&2
      exit 2
    }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      future-input-seal-install-v2 "$1"
    ;;
  # install only one canonical transferred anchor from bounded standard input
  adjustment-maintenance-anchor-install-v2)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid maintenance anchor hash\n' >&2
      exit 2
    }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      maintenance-anchor-install-v2 "$1"
    ;;
  # install only one future-only transferred anchor from bounded standard input
  adjustment-maintenance-anchor-install-v3)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid future-only maintenance anchor hash\n' >&2
      exit 2
    }
    require_command node
    current_release=$(read_optional_release_state "$deploy_dir/state/current-release")
    [[ -n "$current_release" ]] || { printf 'error: current release is unavailable\n' >&2; exit 1; }
    current_env="$deploy_dir/releases/${current_release}.env"
    require_file "$current_env"
    WEATHER_ANCHOR_CONTROL_SHA256=$(env_value "$current_env" WEATHER_CONTROL_PLANE_SHA256)
    WEATHER_ANCHOR_CONTROL_VERSION=$(env_value "$current_env" WEATHER_CONTROL_PLANE_VERSION)
    export WEATHER_ANCHOR_CONTROL_SHA256 WEATHER_ANCHOR_CONTROL_VERSION
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      maintenance-anchor-install-v3 "$1"
    ;;
  # finalize only one installed anchor from bounded standard input
  adjustment-maintenance-anchor-finalize-v2)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid maintenance finalization proof hash\n' >&2
      exit 2
    }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      maintenance-anchor-finalize-v2 "$1"
    ;;
  # finalize only one future-only anchor from bounded standard input
  adjustment-maintenance-anchor-finalize-v3)
    (($# == 1)) || { printf 'error: invalid arguments\n' >&2; exit 2; }
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || {
      printf 'error: invalid future-only finalization proof hash\n' >&2
      exit 2
    }
    require_command node
    exec node "$deploy_dir/scripts/adjustment-evidence-store.mjs" \
      maintenance-anchor-finalize-v3 "$1"
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
