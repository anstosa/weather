#!/usr/bin/env bash
set -euo pipefail

previous_digest=399bb66688833b73e6a6679db66f0f3c54814c0962b7909f31734190030608e3
previous_release=2026.09.12-1
control_files=(
  compose.yaml
  postgres/runtime-acl-v2.sql
  scripts/common.sh
  scripts/forecast-training-package.mjs
  scripts/update.sh
)

# reject an unsafe handoff
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# hash the exact deployment control plane
control_digest() {
  local root=$1
  local file
  local -a files
  mapfile -d '' -t files < <(
    find "$root/deploy/scripts" "$root/deploy/postgres" \
      "$root/deploy/systemd" "$root/deploy/sudoers" \
      -type f -print0 | LC_ALL=C sort -z
  )
  files+=("$root/deploy/compose.yaml")
  (
    # bind each relative path and file digest
    for file in "${files[@]}"; do
      printf '%s\0' "${file#"$root/"}"
      sha256sum "$file" | awk '{print $1}'
    done
  ) | sha256sum | awk '{print $1}'
}

# reject active release or migration commands
require_quiet_weather() {
  local command_line
  local process

  # inspect host command lines without matching this script body
  for process in /proc/[0-9]*/cmdline; do
    [[ -r "$process" ]] || continue
    command_line=$(tr '\0' ' ' <"$process" 2>/dev/null) || continue

    # deny lifecycle and restore overlap
    if [[ "$command_line" == *'/opt/weather/current/deploy/scripts/update.sh'* ||
      "$command_line" == *'/opt/weather/current/deploy/scripts/restore.sh'* ||
      "$command_line" == *'/opt/weather/current/deploy/scripts/backup.sh'* ]]; then
      fail "a Weather lifecycle operation is in flight"
    fi
  done

  # deny a still-running disposable migration container
  [[ -z "$(docker ps --quiet \
    --filter label=com.docker.compose.project=weather \
    --filter label=com.docker.compose.service=migration)" ]] ||
    fail "a Weather migration container is in flight"
}

# copy one file by same-directory atomic rename
install_atomic_file() (
  local source=$1
  local target=$2
  local temporary='' mode source_hash
  trap '[[ -z "$temporary" ]] || rm -f -- "$temporary"' EXIT
  mode=$(stat -c '%a' "$source")
  source_hash=$(sha256sum "$source" | awk '{print $1}')
  temporary=$(mktemp "$(dirname "$target")/.rain-control.XXXXXX")
  install -m "$mode" "$source" "$temporary"
  [[ "$(sha256sum "$temporary" | awk '{print $1}')" == "$source_hash" ]] ||
    fail "staged control file hash changed: $target"
  mv -Tf -- "$temporary" "$target"
)

# install one pinned five-file control-plane transition
install_control_plane() (
  local destination=$1
  local backup_root=$2
  local archive=$3
  local archive_sha256=$4
  local candidate_digest=$5
  local fail_after=${6:-0}
  local stage='' backup='' replaced=0 status candidate_root candidate_archive entry line file expected_mode lock_fd

  # restore all five original files after an interrupted replacement
  # shellcheck disable=SC2329
  restore_on_exit() {
    status=$?
    trap - EXIT

    # recover only when installation actually began
    if ((status != 0 && replaced > 0)); then
      printf 'Restoring retained version-eight control plane from %s\n' "$backup" >&2
      for file in "${control_files[@]}"; do
        install_atomic_file "$backup/deploy/$file" "$destination/deploy/$file" || status=2
      done
      [[ "$(control_digest "$destination")" == "$previous_digest" ]] || status=2
    fi

    # remove only the private extraction scratch
    if [[ -n "$stage" ]]; then
      rm -rf -- "$stage"
    fi
    exit "$status"
  }

  [[ "$destination" == /* && "$backup_root" == /* && "$archive" == /* ]] ||
    fail "handoff paths must be absolute"
  [[ "$(realpath -m "$destination")" == "$destination" && ! -L "$destination" ]] ||
    fail "deployment root is not a canonical directory"
  [[ "$(realpath -m "$backup_root")" == "$backup_root" &&
    "$backup_root" != "$destination"/* ]] ||
    fail "backup root must be canonical and outside the deployment"
  [[ -f "$archive" && ! -L "$archive" ]] || fail "candidate archive is missing or linked"
  [[ "$archive_sha256" =~ ^[a-f0-9]{64}$ && "$candidate_digest" =~ ^[a-f0-9]{64}$ ]] ||
    fail "candidate hashes must be complete SHA-256 values"
  [[ "$fail_after" =~ ^[0-4]$ ]] || fail "invalid internal failure probe"
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$archive_sha256" ]] ||
    fail "candidate archive hash differs from the committed artifact"
  [[ -d "$destination/deploy" && ! -L "$destination/deploy" ]] ||
    fail "installed deployment is missing or linked"
  [[ -f "$destination/deploy/compose.yaml" && ! -L "$destination/deploy/compose.yaml" ]] ||
    fail "installed Compose contract is missing or linked"
  [[ -f "$destination/deploy/state/current-release" &&
    ! -L "$destination/deploy/state/current-release" ]] ||
    fail "installed release state is missing or linked"
  [[ "$(cat "$destination/deploy/state/current-release")" == "$previous_release" ]] ||
    fail "installed release is not the verified version-eight predecessor"
  [[ -f "$destination/deploy/releases/$previous_release.env" &&
    ! -L "$destination/deploy/releases/$previous_release.env" ]] ||
    fail "predecessor release metadata is missing or linked"
  [[ "$(grep -c '^WEATHER_CONTROL_PLANE_VERSION=' "$destination/deploy/releases/$previous_release.env")" == 1 &&
    "$(grep -c '^WEATHER_CONTROL_PLANE_SHA256=' "$destination/deploy/releases/$previous_release.env")" == 1 ]] ||
    fail "predecessor release metadata is ambiguous"
  grep -Fxq 'WEATHER_CONTROL_PLANE_VERSION=8' \
    "$destination/deploy/releases/$previous_release.env" ||
    fail "predecessor release version differs"
  grep -Fxq "WEATHER_CONTROL_PLANE_SHA256=$previous_digest" \
    "$destination/deploy/releases/$previous_release.env" ||
    fail "predecessor release digest differs"
  [[ -z "$(find "$destination/deploy/scripts" "$destination/deploy/postgres" \
    "$destination/deploy/systemd" "$destination/deploy/sudoers" -type l -print -quit)" ]] ||
    fail "installed control plane contains a symbolic link"
  [[ "$(control_digest "$destination")" == "$previous_digest" ]] ||
    fail "installed control plane differs from the verified predecessor"

  # serialize only this installer, not the existing release commands
  install -d -m 0700 "$backup_root"
  [[ "$(stat -c '%a' "$backup_root")" == 700 ]] ||
    fail "backup root must be private"
  exec {lock_fd}>"$backup_root/.rain-control-install.lock"
  chmod 600 "$backup_root/.rain-control-install.lock"
  flock -n "$lock_fd" || fail "another control-plane installer is in flight"
  [[ "$(cat "$destination/deploy/state/current-release")" == "$previous_release" &&
    "$(control_digest "$destination")" == "$previous_digest" ]] ||
    fail "predecessor changed before installer lock"
  require_quiet_weather
  stage=$(mktemp -d "$backup_root/.rain-control-stage.XXXXXX")
  trap restore_on_exit EXIT

  # read only a private byte-for-byte snapshot after the caller path is closed
  candidate_archive=$stage/candidate.tar
  install -m 0600 "$archive" "$candidate_archive"
  [[ "$(sha256sum "$candidate_archive" | awk '{print $1}')" == "$archive_sha256" ]] ||
    fail "private candidate archive hash differs from the committed artifact"

  # allow only reviewed control-plane archive paths
  tar -tf "$candidate_archive" >"$stage/archive-paths"
  while IFS= read -r entry; do
    [[ "$entry" =~ ^deploy(/([a-zA-Z0-9._-]+))*/?$ &&
      ! "$entry" =~ (^|/)\.\.(/|$) && ! "$entry" =~ (^|/)\.(/|$) ]] ||
      fail "candidate archive contains a forbidden path"
    case "$entry" in
      deploy/|deploy/compose.yaml|deploy/scripts/|deploy/scripts/*|\
      deploy/postgres/|deploy/postgres/*|deploy/systemd/|deploy/systemd/*|\
      deploy/sudoers/|deploy/sudoers/*) ;;
      *) fail "candidate archive includes a private or unrelated path" ;;
    esac
  done <"$stage/archive-paths"
  tar -tvf "$candidate_archive" >"$stage/archive-types"
  while IFS= read -r line; do
    [[ "${line:0:1}" == - || "${line:0:1}" == d ]] ||
      fail "candidate archive includes a non-file entry"
  done <"$stage/archive-types"
  tar --no-same-owner --same-permissions -xf "$candidate_archive" -C "$stage"
  candidate_root=$stage
  [[ -f "$candidate_root/deploy/scripts/update.sh" ]] ||
    fail "candidate update script is missing"
  [[ "$(grep -c '^control_plane_version=' "$candidate_root/deploy/scripts/update.sh")" == 1 ]] ||
    fail "candidate control version is ambiguous"
  grep -Fxq 'control_plane_version=9' "$candidate_root/deploy/scripts/update.sh" ||
    fail "candidate control version is not nine"
  grep -Fxq "previous_control_plane_sha256=$previous_digest" \
    "$candidate_root/deploy/scripts/update.sh" ||
    fail "candidate does not pin the predecessor"
  [[ "$(control_digest "$candidate_root")" == "$candidate_digest" ]] ||
    fail "candidate control-plane digest differs"

  # retain only the exact previous control plane, never state or secrets
  backup=$(mktemp -d "$backup_root/v8-${previous_digest:0:12}.XXXXXX")
  mkdir -p "$backup/deploy"
  cp -a "$destination/deploy/scripts" "$destination/deploy/postgres" \
    "$destination/deploy/systemd" "$destination/deploy/sudoers" \
    "$destination/deploy/compose.yaml" "$backup/deploy/"
  [[ "$(control_digest "$backup")" == "$previous_digest" ]] ||
    fail "retained predecessor backup differs"

  # prove that only the five selected files produce the candidate digest
  cp -a "$backup/deploy" "$stage/trial-deploy"
  for file in "${control_files[@]}"; do
    [[ -f "$candidate_root/deploy/$file" && ! -L "$candidate_root/deploy/$file" ]] ||
      fail "candidate control file is missing or linked: $file"
    # keep archive file modes from widening host control access
    case "$file" in
      compose.yaml|postgres/runtime-acl-v2.sql) expected_mode=644 ;;
      *) expected_mode=755 ;;
    esac
    [[ "$(stat -c '%a' "$candidate_root/deploy/$file")" == "$expected_mode" ]] ||
      fail "candidate control file mode is unsafe: $file"
    cp "$candidate_root/deploy/$file" "$stage/trial-deploy/$file"
  done
  mkdir -p "$stage/trial"
  mv "$stage/trial-deploy" "$stage/trial/deploy"
  [[ "$(control_digest "$stage/trial")" == "$candidate_digest" ]] ||
    fail "candidate changes exceed the five reviewed control files"

  # recheck the serialized handoff immediately before file replacement
  require_quiet_weather
  [[ "$(cat "$destination/deploy/state/current-release")" == "$previous_release" &&
    "$(control_digest "$destination")" == "$previous_digest" ]] ||
    fail "predecessor changed during staging"

  # keep the old update guard installed until every other file is in place
  for file in "${control_files[@]}"; do
    install_atomic_file "$candidate_root/deploy/$file" "$destination/deploy/$file"
    replaced=$((replaced + 1))

    # exercise rollback only in a sourced disposable test
    if ((fail_after > 0 && replaced == fail_after)); then
      fail "internal mid-install failure probe"
    fi
  done
  [[ "$(control_digest "$destination")" == "$candidate_digest" ]] ||
    fail "installed control-plane digest differs from the candidate"
  printf 'Installed version-nine control plane: %s\nRetained backup: %s\n' \
    "$candidate_digest" "$backup"
)

# accept only a root-owned production handoff
main() {
  (($# == 3)) || fail "usage: install-rain-control-plane.sh ARCHIVE ARCHIVE_SHA256 CANDIDATE_SHA256"
  ((EUID == 0)) || fail "host administrator authority is required"
  install_control_plane /opt/weather/current \
    /var/lib/weather/control-plane-backups "$1" "$2" "$3" 0
}

# run only when invoked rather than sourced by a disposable test
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
