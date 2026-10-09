#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print SSH usage
usage() {
  cat <<'EOF'
Usage: ssh-run.sh [--config SSH_CONFIG] status|yolo RELEASE|stage RELEASE|activate RELEASE|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|forecast-training-export FROM_DATE TO_DATE|adjustment-evaluation-export FROM_DATE TO_DATE|adjustment-evaluation-export-v2 FROM_DATE TO_DATE|adjustment-confirmation-availability-v2 REGISTRATION_SHA256|adjustment-confirmation-export-v2 REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX|adjustment-confirmation-access-burn-v3 REQUEST_SHA256|adjustment-shadow-terminal-record-v3 REQUEST_SHA256|adjustment-shadow-terminal-retire-v3 REQUEST_SHA256|adjustment-shadow-unsupported-terminal-record-v1 REQUEST_SHA256|adjustment-shadow-unsupported-terminal-retire-v1 REQUEST_SHA256|install-adjustment-scorecard SHA256|install-adjustment-scorecard-v2 SHA256|adjustment-maintenance-anchor-status-v2|adjustment-development-custody-anchor-current-v1|adjustment-development-custody-anchor-install-v1 SHA256|adjustment-rain-control-custody-anchor-current-v1|adjustment-rain-control-custody-anchor-install-v1 SHA256|adjustment-unsupported-terminal-proof-current-v1|adjustment-unsupported-terminal-proof-install-v1 SHA256|adjustment-future-input-seal-current-v2|adjustment-maintenance-anchor-current-v3|adjustment-future-input-seal-install-v2 SHA256|adjustment-maintenance-anchor-install-v2 SHA256|adjustment-maintenance-anchor-install-v3 SHA256|adjustment-maintenance-anchor-finalize-v2 SHA256|adjustment-maintenance-anchor-finalize-v3 SHA256|adjustment-shadow-metadata-custody-status-v1|adjustment-shadow-metadata-custody-finalize-v1 PROOF_SHA256|adjustment-archive-next|adjustment-archive-ack PAGE_SHA256 CHECKPOINT_SHA256|adjustment-archive-ack-final MANIFEST_SHA256 GRAPH_SHA256|adjustment-family-release TARGET_RELEASE COMPENSATING_RELEASE EXPECTED_CURRENT_RELEASE EXPECTED_SOURCE_RELEASE EXPECTED_SETTINGS_SHA256 FAMILY ACTION_SHA256 REPORT_SHA256 FENCE|adjustment-family-release-status ACTION_SHA256|adjustment-family-release-current-v1 FAMILY|adjustment-family-release-lineage-v2|adjustment-revision-capture-epoch-v1|adjustment-revision-capture-epoch-snapshot-v1|adjustment-database-ledger-v3|adjustment-registration-schedule-status-v3|adjustment-registration-lifecycle-status-v4|adjustment-revision-catalog-current-start-v1 CUTOFF_AT|adjustment-revision-catalog-start-v1 CUTOFF_AT WATERMARK_ORDINAL|adjustment-revision-catalog-page-v1 WATERMARK_ORDINAL WATERMARK_FRONTIER START_SHA256 AFTER_ORDINAL AFTER_FRONTIER PREVIOUS_PAGE_SHA256|adjustment-revision-custody-ack-v1 WATERMARK_ORDINAL WATERMARK_FRONTIER START_SHA256 AFTER_ORDINAL AFTER_FRONTIER PREVIOUS_PAGE_SHA256 PAGE_SHA256 GRAPH_MANIFEST_SHA256 MEMBER_ROOT_SHA256 START_MEMBER_SHA256_OR_NONE|adjustment-revision-custody-ack-v2 WATERMARK_ORDINAL WATERMARK_FRONTIER START_SHA256 AFTER_ORDINAL AFTER_FRONTIER PREVIOUS_PAGE_SHA256 PAGE_SHA256 CUSTODY_CHECKPOINT_SHA256 MEMBER_ROOT_SHA256 START_MEMBER_SHA256_OR_NONE|adjustment-revision-gap-start-v1|adjustment-revision-gap-page-v1 START_SHA256 FRONTIER_SHA256|adjustment-revision-gap-ack-v1 PAGE_SHA256 GRAPH_MANIFEST_SHA256

Runs one allowlisted operation through a loaded SSH agent and the isolated
weather-ssh forced-command account.
EOF
}

config="$deploy_dir/config/ssh_config"

# accept an explicit client config
if [[ ${1:-} == --config ]]; then
  (($# >= 3)) || die "--config requires a file and operation"
  config=$2
  shift 2
fi

(($# >= 1)) || { usage >&2; exit 2; }
action=$1
shift

case "$action" in
  status|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|adjustment-archive-next|adjustment-maintenance-anchor-status-v2|adjustment-development-custody-anchor-current-v1|adjustment-rain-control-custody-anchor-current-v1|adjustment-unsupported-terminal-proof-current-v1|adjustment-future-input-seal-current-v2|adjustment-maintenance-anchor-current-v3|adjustment-family-release-lineage-v2|adjustment-revision-capture-epoch-v1|adjustment-revision-capture-epoch-snapshot-v1|adjustment-database-ledger-v3|adjustment-registration-schedule-status-v3|adjustment-registration-lifecycle-status-v4|adjustment-shadow-metadata-custody-status-v1|adjustment-revision-gap-start-v1)
    (($# == 0)) || die "$action takes no arguments"
    ;;
  yolo|stage|activate)
    (($# == 1)) || die "$action requires one release"
    validate_release "$1"
    ;;
  # forward one bounded canonical bootstrap under its root-derived identity
  adjustment-registration-schedule-initialize-v3)
    (($# == 1)) || die "$action requires BOOTSTRAP_SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "schedule bootstrap SHA256 is invalid"
    ;;
  # forward one fixed nine-operand family transaction
  adjustment-family-release)
    (($# == 9)) || die "$action requires exactly nine arguments"
    for release in "$1" "$2" "$3" "$4"; do
      validate_release "$release"
    done
    [[ "$5" =~ ^[a-f0-9]{64}$ ]] || die "settings SHA256 is invalid"
    [[ "$6" == temperature || "$6" == wind || "$6" == rain ]] ||
      die "adjustment family is invalid"
    [[ "$7" =~ ^[a-f0-9]{64}$ && "$8" =~ ^[a-f0-9]{64}$ ]] ||
      die "family action or report SHA256 is invalid"
    [[ "$9" =~ ^[1-9][0-9]{0,19}$ ]] || die "family fencing token is invalid"
    # compare equal-width decimal strings without signed overflow
    # shellcheck disable=SC2071
    [[ ${#9} -lt 20 || "$9" < 18446744073709551616 ]] ||
      die "family fencing token overflows uint64"
    [[ "$3" == "$4" && "$1" != "$2" && "$1" != "$3" && "$2" != "$3" ]] ||
      die "family release identities conflict"
    ;;
  # forward one categorical family transaction status request
  adjustment-family-release-status)
    (($# == 1)) || die "$action requires ACTION_SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "family action SHA256 is invalid"
    ;;
  # forward one exact current family authority request
  adjustment-family-release-current-v1)
    (($# == 1)) || die "$action requires FAMILY"
    [[ "$1" == temperature || "$1" == wind || "$1" == rain ]] ||
      die "adjustment family is invalid"
    ;;
  # forward one cutoff to the database-authenticated current frontier reader
  adjustment-revision-catalog-current-start-v1)
    (($# == 1)) || die "$action requires CUTOFF_AT"
    [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] ||
      die "revision cutoff is invalid"
    ;;
  # forward one exact cutoff and database watermark
  adjustment-revision-catalog-start-v1)
    (($# == 2)) || die "$action requires CUTOFF_AT WATERMARK_ORDINAL"
    [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] ||
      die "revision cutoff is invalid"
    [[ "$2" =~ ^(0|[1-9][0-9]{0,18})$ ]] || die "revision watermark is invalid"
    # compare equal-width decimal strings without signed overflow
    # shellcheck disable=SC2071
    [[ ${#2} -lt 19 || "$2" < 9223372036854775808 ]] ||
      die "revision watermark overflows bigint"
    ;;
  # forward one bounded immutable successor-page cursor
  adjustment-revision-catalog-page-v1)
    (($# == 6)) || die "$action requires six revision page identities"
    [[ "$1" =~ ^(0|[1-9][0-9]{0,18})$ && "$4" =~ ^(0|[1-9][0-9]{0,18})$ ]] ||
      die "revision page ordinal is invalid"
    # bound both server-produced database ordinals
    for ordinal in "$1" "$4"; do
      # compare equal-width decimal strings without signed overflow
      # shellcheck disable=SC2071
      [[ ${#ordinal} -lt 19 || "$ordinal" < 9223372036854775808 ]] ||
        die "revision page ordinal overflows bigint"
    done
    # require each content identity independently
    for identity in "$2" "$3" "$5" "$6"; do
      [[ "$identity" =~ ^[a-f0-9]{64}$ ]] || die "revision page SHA256 is invalid"
    done
    ;;
  # forward one successful graph or packed cold-page custody checkpoint
  adjustment-revision-custody-ack-v1|adjustment-revision-custody-ack-v2)
    (($# == 10)) || die "$action requires ten revision custody identities"
    [[ "$1" =~ ^(0|[1-9][0-9]{0,18})$ && "$4" =~ ^(0|[1-9][0-9]{0,18})$ ]] ||
      die "revision custody ordinal is invalid"
    # bound both server-produced database ordinals
    for ordinal in "$1" "$4"; do
      # compare equal-width decimal strings without signed overflow
      # shellcheck disable=SC2071
      [[ ${#ordinal} -lt 19 || "$ordinal" < 9223372036854775808 ]] ||
        die "revision custody ordinal overflows bigint"
    done
    # require every content identity independently
    for identity in "$2" "$3" "$5" "$6" "$7" "$8" "$9"; do
      [[ "$identity" =~ ^[a-f0-9]{64}$ ]] || die "revision custody SHA256 is invalid"
    done
    [[ "${10}" =~ ^(none|[a-f0-9]{64})$ ]] ||
      die "revision custody start member is invalid"
    ;;
  # forward one closed permanent-gap page or acknowledgement identity pair
  adjustment-revision-gap-page-v1|adjustment-revision-gap-ack-v1)
    (($# == 2)) || die "$action requires two SHA256 identities"
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ ]] ||
      die "revision gap SHA256 is invalid"
    ;;
  # forward only two canonical export dates
  forecast-training-export)
    (($# == 2)) || die "$action requires FROM_DATE TO_DATE"
    validate_calendar_date_range "$1" "$2" 450
    ;;
  # forward only one bounded evaluation interval
  adjustment-evaluation-export|adjustment-evaluation-export-v2)
    (($# == 2)) || die "$action requires FROM_DATE TO_DATE"
    validate_calendar_date_range "$1" "$2" 14
    ;;
  # forward only one content-addressed scorecard identity
  install-adjustment-scorecard|install-adjustment-scorecard-v2)
    (($# == 1)) || die "$action requires SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "scorecard SHA256 is invalid"
    ;;
  # forward one value-free registration availability query
  adjustment-confirmation-availability-v2)
    (($# == 1)) || die "$action requires REGISTRATION_SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "registration SHA256 is invalid"
    ;;
  # forward one burned access and canonical confirmation chunk
  adjustment-confirmation-export-v2)
    (($# == 3)) || die "$action requires REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX"
    [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^[a-f0-9]{64}$ ]] ||
      die "confirmation SHA256 is invalid"
    [[ "$3" =~ ^([0-9]|1[0-9]|2[0-6])$ ]] || die "confirmation chunk index is invalid"
    ;;
  # forward one canonical maintenance proof from standard input
  adjustment-development-custody-anchor-install-v1|adjustment-rain-control-custody-anchor-install-v1|adjustment-unsupported-terminal-proof-install-v1|adjustment-future-input-seal-install-v2|adjustment-maintenance-anchor-install-v2|adjustment-maintenance-anchor-install-v3|adjustment-maintenance-anchor-finalize-v2|adjustment-maintenance-anchor-finalize-v3|adjustment-shadow-metadata-custody-finalize-v1|adjustment-confirmation-access-burn-v3|adjustment-shadow-terminal-record-v3|adjustment-shadow-terminal-retire-v3|adjustment-shadow-unsupported-terminal-record-v1|adjustment-shadow-unsupported-terminal-retire-v1)
    (($# == 1)) || die "$action requires SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "maintenance anchor SHA256 is invalid"
    ;;
  # forward only one exact page and open-cycle checkpoint pair
  adjustment-archive-ack)
    (($# == 2)) || die "$action requires PAGE_SHA256 CHECKPOINT_SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "page SHA256 is invalid"
    [[ "$2" =~ ^[a-f0-9]{64}$ ]] || die "checkpoint SHA256 is invalid"
    ;;
  # forward only one exact final manifest and cold graph pair
  adjustment-archive-ack-final)
    (($# == 2)) || die "$action requires MANIFEST_SHA256 GRAPH_SHA256"
    [[ "$1" =~ ^[a-f0-9]{64}$ ]] || die "manifest SHA256 is invalid"
    [[ "$2" =~ ^[a-f0-9]{64}$ ]] || die "graph SHA256 is invalid"
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *) die "operation is not allowlisted: $action" ;;
esac

require_file "$config"
require_command ssh
require_command ssh-add
[[ -n ${SSH_AUTH_SOCK:-} && -S ${SSH_AUTH_SOCK:-} ]] ||
  die "SSH_AUTH_SOCK is not a live agent socket"
ssh-add -L >/dev/null 2>&1 || die "the SSH agent has no loaded public keys"
ssh -F "$config" -- weather-pi "$action" "$@"
