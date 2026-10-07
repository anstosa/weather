#!/usr/bin/env bash
set -euo pipefail

previous_digest=ae098ea591868b9f0d093815fa94d05082af96ece7e9f6fd62e1d903bb8179eb
previous_release=2026.10.01-6
control_files=(
  compose.yaml
  postgres/runtime-acl-v2.sql
  scripts/adjustment-evaluation-export.sh
  scripts/adjustment-evaluation-package.mjs
  scripts/adjustment-evidence-store.mjs
  scripts/common.sh
  scripts/forecast-adjustment-scorecard-contract.mjs
  scripts/forecast-training-package.mjs
  scripts/home-network.mjs
  scripts/install-adjustment-scorecard.sh
  scripts/publish-adjustment-scorecard.sh
  scripts/pull-adjustment-evaluation-export.sh
  scripts/remote-ops.sh
  scripts/ssh-dispatch.sh
  scripts/ssh-run.sh
  scripts/update.sh
  scripts/weather-admin-store.mjs
  scripts/web-server.mjs
)

# print one fatal installer error
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# emit the complete reviewed live v11 public manifest
previous_manifest() {
  cat <<'EOF'
c598784b280e13b9f12982e93df751b1b9a4290bb3c7a5c1994808cb75e16223  deploy/postgres/010-create-runtime-roles.sh
20f90bfd9f86f9c35a8c0fa540760c71a96e0a9d1d2a71049ca0fbcf15a3031f  deploy/postgres/postgres-admin-entrypoint.sh
b1e1f92d24a84317797bbe1ead5b877d3335e1ccadc54cb2680a55d033a24cc5  deploy/postgres/runtime-acl-v1.sql
c32aaf96cea06d480fbe533fb8c97a85684f61ba9cc25cceca7e08f972ccd910  deploy/postgres/runtime-acl-v2.sql
3446f5d8a3840bf4caf57ee7c09bdfccaa546d69abb6f31888d6a51192273038  deploy/scripts/backup-stream.sh
cb862c9ff824c1558f8475e42f51ae658ba94ddc8b8db5ed0fec47abd236733a  deploy/scripts/backup.sh
8453fd4c332633a200a3019cef62c3a9dfab52c96c88ebf007a1d7ac313bdf72  deploy/scripts/common.sh
8b7b4b1fa44ad2969066487ced0269b9d594cba4b3c29d17d6bffb474e16a6e3  deploy/scripts/compatibility-provider.mjs
48db6635659da7dba0062594f9ae1146176c40d22a714a58b7675b3f1570b5f8  deploy/scripts/forecast-training-export.sh
7fa1e789fb715aa655a9a2aaab09078cbfeb95373c213970a798e665376a47d1  deploy/scripts/forecast-training-package.mjs
309024c28ff33f2fc2fe3cc21bb7ca294b3de3243e5158eb72f414023ceb5fa2  deploy/scripts/migrate.mjs
e8e70038bf77a85ca5eafc8047800ebbd931edd81d5f58a0228908ea4858987e  deploy/scripts/preflight-capacity.sh
f57d8568f87040821c32274d1fa84b3058aba353ee03447b95dbcdfaf6191e57  deploy/scripts/public-stations-backfill.sh
566e114a050d54743e679f2ba5b1c39a7466a24dc8040fed910dff30da72355e  deploy/scripts/pull-backup.sh
1cd1f32732bb30837f86e3fdab10d31ebb06e3bace2de1e219aed8ee4b320053  deploy/scripts/pull-forecast-training-export.sh
4099774759b9022f67da294f0e1e0d32bafe30e32ff5974a1cce536e0569097f  deploy/scripts/remote-ops.sh
f4f845fd094ac39c5ab1533efff0a4d5acd5e820a2916e625fbd7532dd070d22  deploy/scripts/resolve-image.mjs
106957ec33fe86dfcef039129a2890df8655cf8521ee80cd4cf1282fefa9e9a9  deploy/scripts/restore.sh
4297d45c58fb12e4f7040288e44bd087f2747c24805bfc871ed9cfe7d5992e36  deploy/scripts/ssh-dispatch.sh
b33d284c9c82c6d36810445867e375ea639a92ba75a3230f70d8bcbb13da6e71  deploy/scripts/ssh-run.sh
68abcda2c0e08cc33980871150e3aae3b4ead98646ee1b52e91be01221aab703  deploy/scripts/status.sh
8218aae7bb2f7af21348e4d8e3a6d5796a3d52279ab70607c61f362a5ef2090f  deploy/scripts/tempest-backfill.sh
3709e03ada7f1864b49f50e880a81f1b3ae23bd903d6c9b0109d9b15d553e5fa  deploy/scripts/tide-backfill.sh
508b655d7fdcbfd37bbb28883ef668994e3e9f34679da177fc9e5057c7fb81e3  deploy/scripts/update.sh
aadfcdfa9fbdf76761616675e8c52995840b5bf6489185e4ba8a8eb9589e4dad  deploy/scripts/verify-static.sh
fd2928364daa3101f4370a57e20ce0d884198af9e13ae06697dacfe0e539669d  deploy/scripts/weather-admin-store.mjs
893372ef9f24fb0d94a327ad34b32ea0b14d6f18a63ff796eca5c0ca93b260d6  deploy/scripts/web-server.mjs
2a0006cf85e7b6416c4628bcef23ddd55553402f63382358b283e2f8c37ffa82  deploy/scripts/xweather-tile-cache.mjs
2a2f3e0cc8f59369a5235454a4237eed91c60cdbe374dcd1c8c7821731e2e3d0  deploy/scripts/xweather-usage-budget.mjs
4f8b4d58b8645f40e5da779857669114a2bec11cb720aedd7be340c3c6c1ac00  deploy/sudoers/weather-ops
85d77f2e61be5dab2d387e867a8dfb4ff70a90e659c5e9e91d633858d0c3d4aa  deploy/systemd/weather-backup-local.service
9fb0866ceb3b81f90e0c579628a8028bc807d3f7c1a7ac9ff3e37c505c2d02dd  deploy/systemd/weather-backup-local.timer
12e33019380f77215a44340e4d6feb4a0dc13f76c968ab36c4501d039ec24de8  deploy/systemd/weather-compose.service
001e03e5d6374c8806537c9729228a0377c465d2447e0f5506bb82ccf7de87be  deploy/compose.yaml
EOF
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
    # bind each stable relative path and file digest
    for file in "${files[@]}"; do
      printf '%s\0' "${file#"$root/"}"
      sha256sum "$file" | awk '{print $1}'
    done
  ) | sha256sum | awk '{print $1}'
}

# record one normalized public-file manifest
actual_manifest() {
  local root=$1
  local file
  local -a files
  mapfile -d '' -t files < <(
    find "$root/deploy/scripts" "$root/deploy/postgres" \
      "$root/deploy/systemd" "$root/deploy/sudoers" \
      -type f -print0 | LC_ALL=C sort -z
  )
  files+=("$root/deploy/compose.yaml")

  # emit one path-bound content identity per file
  for file in "${files[@]}"; do
    printf '%s  %s\n' "$(sha256sum "$file" | awk '{print $1}')" \
      "${file#"$root/"}"
  done
}

# require the byte-exact reviewed v11 predecessor
verify_previous_manifest() {
  local root=$1
  cmp -s <(previous_manifest) <(actual_manifest "$root") ||
    fail "installed public manifest differs from reviewed v11"
  [[ "$(control_digest "$root")" == "$previous_digest" ]] ||
    fail "installed control-plane digest differs from reviewed v11"
}

# reject active release or migration commands
require_quiet_weather() {
  local command_line
  local process

  # inspect host commands without claiming a cross-lifecycle mutex
  for process in /proc/[0-9]*/cmdline; do
    [[ -r "$process" ]] || continue
    command_line=$(tr '\0' ' ' <"$process" 2>/dev/null) || continue
    if [[ "$command_line" == *'/opt/weather/current/deploy/scripts/update.sh'* ||
      "$command_line" == *'/opt/weather/current/deploy/scripts/restore.sh'* ||
      "$command_line" == *'/opt/weather/current/deploy/scripts/backup.sh'* ]]; then
      fail "a Weather lifecycle operation is in flight"
    fi
  done

  # reject a disposable migration still in flight
  [[ -z "$(docker ps --quiet \
    --filter label=com.docker.compose.project=weather \
    --filter label=com.docker.compose.service=migration)" ]] ||
    fail "a Weather migration container is in flight"
}

# identify one explicitly reviewed changed path
is_reviewed_change() {
  local relative_path=$1
  local file

  # match only the fixed v12 convergence list
  for file in "${control_files[@]}"; do
    if [[ "$relative_path" == "deploy/$file" ]]; then
      return 0
    fi
  done
  return 1
}

# copy one file by same-directory atomic rename
install_atomic_file() (
  local source=$1
  local target=$2
  local temporary='' mode source_hash
  trap '[[ -z "$temporary" ]] || rm -f -- "$temporary"' EXIT
  mode=$(stat -c '%a' "$source")
  source_hash=$(sha256sum "$source" | awk '{print $1}')
  mkdir -p -- "$(dirname "$target")"
  temporary=$(mktemp "$(dirname "$target")/.adjustment-control.XXXXXX")
  install -m "$mode" "$source" "$temporary"
  [[ "$(sha256sum "$temporary" | awk '{print $1}')" == "$source_hash" ]] ||
    fail "staged control file hash changed: $target"
  mv -Tf -- "$temporary" "$target"
)

# restore one retained v11 public tree after failure or SIGKILL
recover_control_plane() {
  local destination=$1
  local backup=$2
  local file target
  [[ "$destination" == /* && "$backup" == /* ]] || fail "recovery paths must be absolute"
  verify_previous_manifest "$backup"
  require_quiet_weather

  # remove only allowlisted v12 additions before restoring v11 bytes
  for file in "${control_files[@]}"; do
    target="$destination/deploy/$file"
    if [[ -f "$backup/deploy/$file" ]]; then
      install_atomic_file "$backup/deploy/$file" "$target"
    else
      rm -f -- "$target"
    fi
  done
  verify_previous_manifest "$destination"
  printf 'Recovered reviewed version-eleven control plane: %s\n' "$previous_digest"
}

# install one pinned v11-to-v12 transition
install_control_plane() (
  local destination=$1
  local backup_root=$2
  local archive=$3
  local archive_sha256=$4
  local candidate_digest=$5
  local fail_after=${6:-0}
  local stage='' backup='' replaced=0 status candidate_root candidate_archive
  local entry line file expected_mode lock_fd relative old_hash new_hash
  local -A previous_hashes=()

  # restore every replaced path after an ordinary failure
  # shellcheck disable=SC2329
  restore_on_exit() {
    status=$?
    trap - EXIT
    if ((status != 0 && replaced > 0)); then
      printf 'Restoring retained version-eleven control plane from %s\n' "$backup" >&2
      recover_control_plane "$destination" "$backup" || status=2
    fi
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
  [[ "$fail_after" =~ ^([0-9]|1[0-8])$ ]] || fail "invalid internal failure probe"
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$archive_sha256" ]] ||
    fail "candidate archive hash differs from the committed artifact"
  [[ -f "$destination/deploy/state/current-release" &&
    ! -L "$destination/deploy/state/current-release" ]] ||
    fail "installed release state is missing or linked"
  [[ "$(cat "$destination/deploy/state/current-release")" == "$previous_release" ]] ||
    fail "installed release is not the reviewed v11 predecessor"
  [[ -f "$destination/deploy/releases/$previous_release.env" &&
    ! -L "$destination/deploy/releases/$previous_release.env" ]] ||
    fail "predecessor release metadata is missing or linked"
  grep -Fxq 'WEATHER_CONTROL_PLANE_VERSION=11' \
    "$destination/deploy/releases/$previous_release.env" ||
    fail "predecessor release version differs"
  grep -Fxq "WEATHER_CONTROL_PLANE_SHA256=$previous_digest" \
    "$destination/deploy/releases/$previous_release.env" ||
    fail "predecessor release digest differs"
  verify_previous_manifest "$destination"

  # serialize only this installer
  install -d -m 0700 "$backup_root"
  exec {lock_fd}>"$backup_root/.adjustment-control-install.lock"
  chmod 600 "$backup_root/.adjustment-control-install.lock"
  flock -n "$lock_fd" || fail "another control-plane installer is in flight"
  require_quiet_weather
  verify_previous_manifest "$destination"
  stage=$(mktemp -d "$backup_root/.adjustment-control-stage.XXXXXXXX")
  trap restore_on_exit EXIT
  candidate_archive="$stage/candidate.tar"
  install -m 0600 "$archive" "$candidate_archive"
  [[ "$(sha256sum "$candidate_archive" | awk '{print $1}')" == "$archive_sha256" ]] ||
    fail "private candidate archive hash differs from the committed artifact"

  # allow only public deployment-control archive paths
  tar -tf "$candidate_archive" >"$stage/archive-paths"
  while IFS= read -r entry; do
    [[ "$entry" =~ ^deploy(/([a-zA-Z0-9._-]+))*/?$ &&
      ! "$entry" =~ (^|/)\.\.(/|$) && ! "$entry" =~ (^|/)\.(/|$) ]] ||
      fail "candidate archive contains a forbidden path"
    case "$entry" in
      deploy/|deploy/compose.yaml|deploy/scripts/|deploy/scripts/*|\
      deploy/postgres/|deploy/postgres/*|deploy/systemd/|deploy/systemd/*|\
      deploy/sudoers/|deploy/sudoers/*) ;;
      *) fail "candidate archive includes private or unrelated state" ;;
    esac
  done <"$stage/archive-paths"
  tar -tvf "$candidate_archive" >"$stage/archive-types"
  while IFS= read -r line; do
    [[ "${line:0:1}" == - || "${line:0:1}" == d ]] ||
      fail "candidate archive includes a non-file entry"
  done <"$stage/archive-types"
  tar --no-same-owner --same-permissions -xf "$candidate_archive" -C "$stage"
  candidate_root=$stage
  grep -Fxq 'control_plane_version=12' "$candidate_root/deploy/scripts/update.sh" ||
    fail "candidate control version is not twelve"
  grep -Fxq "previous_control_plane_sha256=$previous_digest" \
    "$candidate_root/deploy/scripts/update.sh" ||
    fail "candidate does not pin the reviewed v11 predecessor"
  [[ "$(control_digest "$candidate_root")" == "$candidate_digest" ]] ||
    fail "candidate control-plane digest differs"

  # compare every candidate path against the complete reviewed predecessor
  while read -r old_hash relative; do
    previous_hashes["$relative"]=$old_hash
    [[ -f "$candidate_root/$relative" ]] || fail "candidate deletes predecessor file: $relative"
  done < <(previous_manifest)
  while read -r new_hash relative; do
    old_hash=${previous_hashes["$relative"]:-}
    if [[ -z "$old_hash" || "$old_hash" != "$new_hash" ]]; then
      is_reviewed_change "$relative" || fail "candidate changes unreviewed path: $relative"
    fi
  done < <(actual_manifest "$candidate_root")

  # retain the complete exact predecessor outside release metadata
  backup=$(mktemp -d "$backup_root/v11-${previous_digest:0:12}.XXXXXXXX")
  mkdir -p "$backup/deploy"
  cp -a "$destination/deploy/scripts" "$destination/deploy/postgres" \
    "$destination/deploy/systemd" "$destination/deploy/sudoers" \
    "$destination/deploy/compose.yaml" "$backup/deploy/"
  verify_previous_manifest "$backup"

  # prove the fixed allowlist alone yields the candidate digest
  cp -a "$backup/deploy" "$stage/trial-deploy"
  for file in "${control_files[@]}"; do
    [[ -f "$candidate_root/deploy/$file" && ! -L "$candidate_root/deploy/$file" ]] ||
      fail "candidate control file is missing or linked: $file"
    case "$file" in
      scripts/forecast-training-package.mjs) expected_mode=755 ;;
      compose.yaml|postgres/*.sql|scripts/*.mjs) expected_mode=644 ;;
      *) expected_mode=755 ;;
    esac
    [[ "$(stat -c '%a' "$candidate_root/deploy/$file")" == "$expected_mode" ]] ||
      fail "candidate control file mode is unsafe: $file"
    mkdir -p "$(dirname "$stage/trial-deploy/$file")"
    cp "$candidate_root/deploy/$file" "$stage/trial-deploy/$file"
  done
  mkdir -p "$stage/trial"
  mv "$stage/trial-deploy" "$stage/trial/deploy"
  [[ "$(control_digest "$stage/trial")" == "$candidate_digest" ]] ||
    fail "candidate changes exceed the reviewed v12 allowlist"

  # recheck the operator-serialized handoff immediately before replacement
  require_quiet_weather
  [[ "$(cat "$destination/deploy/state/current-release")" == "$previous_release" ]] ||
    fail "active release changed during staging"
  verify_previous_manifest "$destination"

  # install update last so old guards remain until all other bytes converge
  for file in "${control_files[@]}"; do
    [[ "$file" == scripts/update.sh ]] && continue
    install_atomic_file "$candidate_root/deploy/$file" "$destination/deploy/$file"
    replaced=$((replaced + 1))
    if ((fail_after > 0 && replaced == fail_after)); then
      fail "internal mid-install failure probe"
    fi
  done
  install_atomic_file "$candidate_root/deploy/scripts/update.sh" \
    "$destination/deploy/scripts/update.sh"
  replaced=$((replaced + 1))
  if ((fail_after > 0 && replaced == fail_after)); then
    fail "internal mid-install failure probe"
  fi
  [[ "$(control_digest "$destination")" == "$candidate_digest" ]] ||
    fail "installed control-plane digest differs from candidate"
  printf 'Installed version-twelve control plane: %s\nRetained v11 backup: %s\n' \
    "$candidate_digest" "$backup"
)

# accept only a root-owned production handoff or explicit crash recovery
main() {
  ((EUID == 0)) || fail "host administrator authority is required"
  if (($# == 2)) && [[ "$1" == --recover ]]; then
    recover_control_plane /opt/weather/current "$2"
    return
  fi
  (($# == 3)) || fail "usage: install-adjustment-evaluation-control-plane.sh ARCHIVE ARCHIVE_SHA256 CANDIDATE_SHA256 | --recover BACKUP"
  install_control_plane /opt/weather/current \
    /var/lib/weather/control-plane-backups "$1" "$2" "$3" 0
}

# run only when invoked instead of sourced by tests
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
