#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print SSH usage
usage() {
  cat <<'EOF'
Usage: ssh-run.sh [--config SSH_CONFIG] status|yolo RELEASE|stage RELEASE|activate RELEASE|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|forecast-training-export FROM_DATE TO_DATE|adjustment-evaluation-export FROM_DATE TO_DATE|adjustment-evaluation-export-v2 FROM_DATE TO_DATE|adjustment-confirmation-availability-v2 REGISTRATION_SHA256|adjustment-confirmation-export-v2 REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX|install-adjustment-scorecard SHA256|install-adjustment-scorecard-v2 SHA256|adjustment-maintenance-anchor-status-v2|adjustment-archive-next|adjustment-archive-ack PAGE_SHA256 CHECKPOINT_SHA256|adjustment-archive-ack-final MANIFEST_SHA256 GRAPH_SHA256

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
  status|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|adjustment-archive-next|adjustment-maintenance-anchor-status-v2)
    (($# == 0)) || die "$action takes no arguments"
    ;;
  yolo|stage|activate)
    (($# == 1)) || die "$action requires one release"
    validate_release "$1"
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
