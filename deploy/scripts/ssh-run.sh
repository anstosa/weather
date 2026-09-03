#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print SSH usage
usage() {
  cat <<'EOF'
Usage: ssh-run.sh [--config SSH_CONFIG] status|yolo RELEASE|stage RELEASE|activate RELEASE|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill|forecast-training-export FROM_DATE TO_DATE

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
  status|rollback|recover|backup|backup-stream|preflight|tempest-backfill|public-stations-backfill|tide-backfill)
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
