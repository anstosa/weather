#!/usr/bin/env bash
set -euo pipefail

previous_digest=ae098ea591868b9f0d093815fa94d05082af96ece7e9f6fd62e1d903bb8179eb
previous_release=2026.10.01-6
repair_previous_digest=9a48c7e5c7450dfeee12c0813bf343f24f6c0f68e6472338bf33dde5c6fea2c0
repair_previous_release=2026.10.07-1
password_previous_digest=5685ead4440468ecdb58402fbe14e76ce63ed03a018b9b4724fa24ffef4eb3c8
password_previous_release=2026.10.07-2
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
repair_control_files=(
  scripts/adjustment-evidence-store.mjs
  scripts/update.sh
)
password_control_files=(
  scripts/install-adjustment-scorecard.sh
  scripts/weather-admin-store.mjs
  scripts/web-server.mjs
  scripts/update.sh
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

# emit the complete first version-twelve public manifest
repair_previous_manifest() {
  cat <<'EOF'
c598784b280e13b9f12982e93df751b1b9a4290bb3c7a5c1994808cb75e16223  deploy/postgres/010-create-runtime-roles.sh
20f90bfd9f86f9c35a8c0fa540760c71a96e0a9d1d2a71049ca0fbcf15a3031f  deploy/postgres/postgres-admin-entrypoint.sh
b1e1f92d24a84317797bbe1ead5b877d3335e1ccadc54cb2680a55d033a24cc5  deploy/postgres/runtime-acl-v1.sql
964a7e52e81e33bfaea6a3c0f1828b31053e3974ff5bdd514cf33e766682c822  deploy/postgres/runtime-acl-v2.sql
e2944ec5b47c49a05377b8d654ef843f5a1eb771d763f2da9bb11e130e55672c  deploy/scripts/adjustment-evaluation-export.sh
2084401bf872256a5dbad43ea14994c2f5fb85ecf0665e9058fcf75cd7554f6f  deploy/scripts/adjustment-evaluation-package.mjs
cac646dffe37e7d3254b7edbedaa234c7baa89a42314f1a11015a31278371984  deploy/scripts/adjustment-evidence-store.mjs
3446f5d8a3840bf4caf57ee7c09bdfccaa546d69abb6f31888d6a51192273038  deploy/scripts/backup-stream.sh
cb862c9ff824c1558f8475e42f51ae658ba94ddc8b8db5ed0fec47abd236733a  deploy/scripts/backup.sh
d714b71625abe36072631f56cd10f7528f26d77e89bbbd00725fe9595d5c633a  deploy/scripts/common.sh
8b7b4b1fa44ad2969066487ced0269b9d594cba4b3c29d17d6bffb474e16a6e3  deploy/scripts/compatibility-provider.mjs
e7666700564bd4602d06d506bf0e05d690f9bb9aa5b04b34af8842810090bd3c  deploy/scripts/forecast-adjustment-scorecard-contract.mjs
48db6635659da7dba0062594f9ae1146176c40d22a714a58b7675b3f1570b5f8  deploy/scripts/forecast-training-export.sh
f1bd65685da06f0d6969ad9b96722c5edb6f030e291a375bfb3e36192db76787  deploy/scripts/forecast-training-package.mjs
3dc0cf6b07f4a844f95fffd58352523636d7b93c4b51f42ad47e1161c7dd0266  deploy/scripts/home-network.mjs
c28c9a4a681fb68048f3fae0dd16ab4c7c4528c212aec1dd6c69032716eb7c65  deploy/scripts/install-adjustment-scorecard.sh
309024c28ff33f2fc2fe3cc21bb7ca294b3de3243e5158eb72f414023ceb5fa2  deploy/scripts/migrate.mjs
e8e70038bf77a85ca5eafc8047800ebbd931edd81d5f58a0228908ea4858987e  deploy/scripts/preflight-capacity.sh
f57d8568f87040821c32274d1fa84b3058aba353ee03447b95dbcdfaf6191e57  deploy/scripts/public-stations-backfill.sh
120b17c23060569bcd83a57b8225ce569863613586090a4c9443214863013ee0  deploy/scripts/publish-adjustment-scorecard.sh
267262518c248559d4fa589afaf3108246e27fee91e0f3a6d914229188b392eb  deploy/scripts/pull-adjustment-evaluation-export.sh
566e114a050d54743e679f2ba5b1c39a7466a24dc8040fed910dff30da72355e  deploy/scripts/pull-backup.sh
1cd1f32732bb30837f86e3fdab10d31ebb06e3bace2de1e219aed8ee4b320053  deploy/scripts/pull-forecast-training-export.sh
1fd37757ab3158bde2d124f8f689a3936464befc7159bc93e4229874603b80d7  deploy/scripts/remote-ops.sh
f4f845fd094ac39c5ab1533efff0a4d5acd5e820a2916e625fbd7532dd070d22  deploy/scripts/resolve-image.mjs
106957ec33fe86dfcef039129a2890df8655cf8521ee80cd4cf1282fefa9e9a9  deploy/scripts/restore.sh
ea4a33a1f03e0c7a75befa99eb7fd7c3cfe277be697c4f227b3c55ee7fb3aaea  deploy/scripts/ssh-dispatch.sh
f4aca87ae2856303539f11a5e6fdffbc51a844db867954b633153d859f6a3c0f  deploy/scripts/ssh-run.sh
68abcda2c0e08cc33980871150e3aae3b4ead98646ee1b52e91be01221aab703  deploy/scripts/status.sh
8218aae7bb2f7af21348e4d8e3a6d5796a3d52279ab70607c61f362a5ef2090f  deploy/scripts/tempest-backfill.sh
3709e03ada7f1864b49f50e880a81f1b3ae23bd903d6c9b0109d9b15d553e5fa  deploy/scripts/tide-backfill.sh
6b475bd91a4bc65a22991439af9a55a55bcc46d0b0e1b789f3793019b331ad01  deploy/scripts/update.sh
aadfcdfa9fbdf76761616675e8c52995840b5bf6489185e4ba8a8eb9589e4dad  deploy/scripts/verify-static.sh
1d2f082830738b85b2ae2bdab5b0167d2206f125542d1b44e20e3c55f25eb833  deploy/scripts/weather-admin-store.mjs
dc65fab8fe4367338221d336974cba921092447839745babce7f9a2fdd210607  deploy/scripts/web-server.mjs
2a0006cf85e7b6416c4628bcef23ddd55553402f63382358b283e2f8c37ffa82  deploy/scripts/xweather-tile-cache.mjs
2a2f3e0cc8f59369a5235454a4237eed91c60cdbe374dcd1c8c7821731e2e3d0  deploy/scripts/xweather-usage-budget.mjs
4f8b4d58b8645f40e5da779857669114a2bec11cb720aedd7be340c3c6c1ac00  deploy/sudoers/weather-ops
85d77f2e61be5dab2d387e867a8dfb4ff70a90e659c5e9e91d633858d0c3d4aa  deploy/systemd/weather-backup-local.service
9fb0866ceb3b81f90e0c579628a8028bc807d3f7c1a7ac9ff3e37c505c2d02dd  deploy/systemd/weather-backup-local.timer
12e33019380f77215a44340e4d6feb4a0dc13f76c968ab36c4501d039ec24de8  deploy/systemd/weather-compose.service
fe2de752a807672543c789cb900ce0d23fbcc60663462ca29ddb1070acb2fd2e  deploy/compose.yaml
EOF
}

# emit the complete reviewed password-repair predecessor manifest
password_previous_manifest() {
  cat <<'EOF'
c598784b280e13b9f12982e93df751b1b9a4290bb3c7a5c1994808cb75e16223  deploy/postgres/010-create-runtime-roles.sh
20f90bfd9f86f9c35a8c0fa540760c71a96e0a9d1d2a71049ca0fbcf15a3031f  deploy/postgres/postgres-admin-entrypoint.sh
b1e1f92d24a84317797bbe1ead5b877d3335e1ccadc54cb2680a55d033a24cc5  deploy/postgres/runtime-acl-v1.sql
964a7e52e81e33bfaea6a3c0f1828b31053e3974ff5bdd514cf33e766682c822  deploy/postgres/runtime-acl-v2.sql
e2944ec5b47c49a05377b8d654ef843f5a1eb771d763f2da9bb11e130e55672c  deploy/scripts/adjustment-evaluation-export.sh
2084401bf872256a5dbad43ea14994c2f5fb85ecf0665e9058fcf75cd7554f6f  deploy/scripts/adjustment-evaluation-package.mjs
adc04d326832fb5e38743f16cfccc965cf3f3fa8c252379fb256bdb97f8a1f1d  deploy/scripts/adjustment-evidence-store.mjs
3446f5d8a3840bf4caf57ee7c09bdfccaa546d69abb6f31888d6a51192273038  deploy/scripts/backup-stream.sh
cb862c9ff824c1558f8475e42f51ae658ba94ddc8b8db5ed0fec47abd236733a  deploy/scripts/backup.sh
d714b71625abe36072631f56cd10f7528f26d77e89bbbd00725fe9595d5c633a  deploy/scripts/common.sh
8b7b4b1fa44ad2969066487ced0269b9d594cba4b3c29d17d6bffb474e16a6e3  deploy/scripts/compatibility-provider.mjs
e7666700564bd4602d06d506bf0e05d690f9bb9aa5b04b34af8842810090bd3c  deploy/scripts/forecast-adjustment-scorecard-contract.mjs
48db6635659da7dba0062594f9ae1146176c40d22a714a58b7675b3f1570b5f8  deploy/scripts/forecast-training-export.sh
f1bd65685da06f0d6969ad9b96722c5edb6f030e291a375bfb3e36192db76787  deploy/scripts/forecast-training-package.mjs
3dc0cf6b07f4a844f95fffd58352523636d7b93c4b51f42ad47e1161c7dd0266  deploy/scripts/home-network.mjs
c28c9a4a681fb68048f3fae0dd16ab4c7c4528c212aec1dd6c69032716eb7c65  deploy/scripts/install-adjustment-scorecard.sh
309024c28ff33f2fc2fe3cc21bb7ca294b3de3243e5158eb72f414023ceb5fa2  deploy/scripts/migrate.mjs
e8e70038bf77a85ca5eafc8047800ebbd931edd81d5f58a0228908ea4858987e  deploy/scripts/preflight-capacity.sh
f57d8568f87040821c32274d1fa84b3058aba353ee03447b95dbcdfaf6191e57  deploy/scripts/public-stations-backfill.sh
120b17c23060569bcd83a57b8225ce569863613586090a4c9443214863013ee0  deploy/scripts/publish-adjustment-scorecard.sh
267262518c248559d4fa589afaf3108246e27fee91e0f3a6d914229188b392eb  deploy/scripts/pull-adjustment-evaluation-export.sh
566e114a050d54743e679f2ba5b1c39a7466a24dc8040fed910dff30da72355e  deploy/scripts/pull-backup.sh
1cd1f32732bb30837f86e3fdab10d31ebb06e3bace2de1e219aed8ee4b320053  deploy/scripts/pull-forecast-training-export.sh
1fd37757ab3158bde2d124f8f689a3936464befc7159bc93e4229874603b80d7  deploy/scripts/remote-ops.sh
f4f845fd094ac39c5ab1533efff0a4d5acd5e820a2916e625fbd7532dd070d22  deploy/scripts/resolve-image.mjs
106957ec33fe86dfcef039129a2890df8655cf8521ee80cd4cf1282fefa9e9a9  deploy/scripts/restore.sh
ea4a33a1f03e0c7a75befa99eb7fd7c3cfe277be697c4f227b3c55ee7fb3aaea  deploy/scripts/ssh-dispatch.sh
f4aca87ae2856303539f11a5e6fdffbc51a844db867954b633153d859f6a3c0f  deploy/scripts/ssh-run.sh
68abcda2c0e08cc33980871150e3aae3b4ead98646ee1b52e91be01221aab703  deploy/scripts/status.sh
8218aae7bb2f7af21348e4d8e3a6d5796a3d52279ab70607c61f362a5ef2090f  deploy/scripts/tempest-backfill.sh
3709e03ada7f1864b49f50e880a81f1b3ae23bd903d6c9b0109d9b15d553e5fa  deploy/scripts/tide-backfill.sh
22c9dd29356b95a82d54ea77981e37cb8f53ac928eda1048fee3558c9cdf48b3  deploy/scripts/update.sh
aadfcdfa9fbdf76761616675e8c52995840b5bf6489185e4ba8a8eb9589e4dad  deploy/scripts/verify-static.sh
1d2f082830738b85b2ae2bdab5b0167d2206f125542d1b44e20e3c55f25eb833  deploy/scripts/weather-admin-store.mjs
dc65fab8fe4367338221d336974cba921092447839745babce7f9a2fdd210607  deploy/scripts/web-server.mjs
2a0006cf85e7b6416c4628bcef23ddd55553402f63382358b283e2f8c37ffa82  deploy/scripts/xweather-tile-cache.mjs
2a2f3e0cc8f59369a5235454a4237eed91c60cdbe374dcd1c8c7821731e2e3d0  deploy/scripts/xweather-usage-budget.mjs
4f8b4d58b8645f40e5da779857669114a2bec11cb720aedd7be340c3c6c1ac00  deploy/sudoers/weather-ops
85d77f2e61be5dab2d387e867a8dfb4ff70a90e659c5e9e91d633858d0c3d4aa  deploy/systemd/weather-backup-local.service
9fb0866ceb3b81f90e0c579628a8028bc807d3f7c1a7ac9ff3e37c505c2d02dd  deploy/systemd/weather-backup-local.timer
12e33019380f77215a44340e4d6feb4a0dc13f76c968ab36c4501d039ec24de8  deploy/systemd/weather-compose.service
fe2de752a807672543c789cb900ce0d23fbcc60663462ca29ddb1070acb2fd2e  deploy/compose.yaml
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

# require the byte-exact first version-twelve predecessor
verify_repair_previous_manifest() {
  local root=$1
  cmp -s <(repair_previous_manifest) <(actual_manifest "$root") ||
    fail "installed public manifest differs from reviewed first v12"
  [[ "$(control_digest "$root")" == "$repair_previous_digest" ]] ||
    fail "installed control-plane digest differs from reviewed first v12"
}

# require the byte-exact password-repair predecessor
verify_password_previous_manifest() {
  local root=$1
  cmp -s <(password_previous_manifest) <(actual_manifest "$root") ||
    fail "installed public manifest differs from reviewed password predecessor"
  [[ "$(control_digest "$root")" == "$password_previous_digest" ]] ||
    fail "installed control-plane digest differs from reviewed password predecessor"
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

# identify one path in a fixed repair allowlist
is_fixed_repair_change() {
  local relative_path=$1
  local file_list_name=$2
  local file
  local -n file_list=$file_list_name

  # match only the selected fixed repair list
  for file in "${file_list[@]}"; do
    if [[ "$relative_path" == "deploy/$file" ]]; then
      return 0
    fi
  done
  return 1
}

# identify one explicitly reviewed first-v12 repair path
is_repair_change() {
  is_fixed_repair_change "$1" repair_control_files
}

# identify one explicitly reviewed password-repair path
is_password_repair_change() {
  is_fixed_repair_change "$1" password_control_files
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

# require one exact version-twelve release state
require_exact_v12_release_state() {
  local destination=$1
  local expected_release=$2
  local expected_digest=$3
  local description=$4
  local release_env="$destination/deploy/releases/$expected_release.env"
  [[ -f "$destination/deploy/state/current-release" &&
    ! -L "$destination/deploy/state/current-release" ]] ||
    fail "installed release state is missing or linked"
  [[ "$(cat "$destination/deploy/state/current-release")" == "$expected_release" ]] ||
    fail "installed release is not the reviewed $description release"
  [[ -f "$release_env" && ! -L "$release_env" ]] ||
    fail "$description release metadata is missing or linked"
  grep -Fxq "WEATHER_RELEASE=$expected_release" "$release_env" ||
    fail "$description release identity differs"
  grep -Fxq 'WEATHER_CONTROL_PLANE_VERSION=12' "$release_env" ||
    fail "$description control-plane version differs"
  grep -Fxq "WEATHER_CONTROL_PLANE_SHA256=$expected_digest" "$release_env" ||
    fail "$description control-plane digest differs"
}

# require the exact first version-twelve release state
require_repair_release_state() {
  require_exact_v12_release_state "$1" "$repair_previous_release" \
    "$repair_previous_digest" "first v12"
}

# require the exact password-repair predecessor release state
require_password_release_state() {
  require_exact_v12_release_state "$1" "$password_previous_release" \
    "$password_previous_digest" "password predecessor"
}

# restore one retained version-twelve repair predecessor
recover_v12_repair() {
  local repair_kind=$1
  local destination=$2
  local backup=$3
  local digest description release_check verify_manifest
  local file
  local -a file_list=()
  # select only one closed reviewed recovery contract
  case "$repair_kind" in
    first)
      digest=$repair_previous_digest
      description="first version-twelve"
      file_list=("${repair_control_files[@]}")
      release_check=require_repair_release_state
      verify_manifest=verify_repair_previous_manifest
      ;;
    password)
      digest=$password_previous_digest
      description="password-repair predecessor"
      file_list=("${password_control_files[@]}")
      release_check=require_password_release_state
      verify_manifest=verify_password_previous_manifest
      ;;
    *) fail "unsupported version-twelve repair recovery" ;;
  esac
  [[ "$destination" == /* && "$backup" == /* ]] || fail "recovery paths must be absolute"
  "$verify_manifest" "$backup"
  "$release_check" "$destination"
  require_quiet_weather

  # restore only the selected fixed repair paths
  for file in "${file_list[@]}"; do
    [[ -f "$backup/deploy/$file" && ! -L "$backup/deploy/$file" ]] ||
      fail "retained $description control file is missing or linked: $file"
    install_atomic_file "$backup/deploy/$file" "$destination/deploy/$file"
  done
  "$verify_manifest" "$destination"
  printf 'Recovered reviewed %s control plane: %s\n' "$description" "$digest"
}

# restore one retained first-v12 public tree after failure or sigkill
recover_v12_control_plane() {
  recover_v12_repair first "$1" "$2"
}

# restore one retained password-repair predecessor after failure or sigkill
recover_password_v12_control_plane() {
  recover_v12_repair password "$1" "$2"
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

# install one pinned version-twelve repair transaction
repair_v12_control_plane_transaction() (
  local repair_kind=$1
  local destination=$2
  local backup_root=$3
  local archive=$4
  local archive_sha256=$5
  local candidate_digest=$6
  local fail_after=${7:-0}
  local predecessor_digest predecessor_release description
  local manifest_function verify_function release_check change_check
  local pinned_release_name pinned_digest_name
  local stage='' backup='' replaced=0 status candidate_root candidate_archive
  local entry line file expected_mode lock_fd relative old_hash new_hash
  local -a repair_files=()
  local -A previous_hashes=()
  local -A changed_paths=()

  # select only one closed reviewed repair contract
  case "$repair_kind" in
    first)
      predecessor_digest=$repair_previous_digest
      predecessor_release=$repair_previous_release
      description="first version-twelve"
      repair_files=("${repair_control_files[@]}")
      manifest_function=repair_previous_manifest
      verify_function=verify_repair_previous_manifest
      release_check=require_repair_release_state
      change_check=is_repair_change
      pinned_release_name=previous_v12_release
      pinned_digest_name=previous_v12_control_plane_sha256
      ;;
    password)
      predecessor_digest=$password_previous_digest
      predecessor_release=$password_previous_release
      description="password-only version-twelve"
      repair_files=("${password_control_files[@]}")
      manifest_function=password_previous_manifest
      verify_function=verify_password_previous_manifest
      release_check=require_password_release_state
      change_check=is_password_repair_change
      pinned_release_name=password_previous_v12_release
      pinned_digest_name=password_previous_v12_control_plane_sha256
      ;;
    *) fail "unsupported version-twelve repair contract" ;;
  esac

  # restore every replaced path after an ordinary failure
  # shellcheck disable=SC2329
  restore_on_exit() {
    status=$?
    trap - EXIT
    # recover only after replacement began
    if ((status != 0 && replaced > 0)); then
      printf 'Restoring retained %s control plane from %s\n' "$description" "$backup" >&2
      recover_v12_repair "$repair_kind" "$destination" "$backup" || status=2
    fi
    # remove only this private staging tree
    if [[ -n "$stage" ]]; then
      rm -rf -- "$stage"
    fi
    exit "$status"
  }

  [[ "$destination" == /* && "$backup_root" == /* && "$archive" == /* ]] ||
    fail "repair handoff paths must be absolute"
  [[ "$(realpath -m "$destination")" == "$destination" && ! -L "$destination" ]] ||
    fail "deployment root is not a canonical directory"
  [[ "$(realpath -m "$backup_root")" == "$backup_root" &&
    "$backup_root" != "$destination"/* ]] ||
    fail "backup root must be canonical and outside the deployment"
  [[ -f "$archive" && ! -L "$archive" ]] || fail "repair archive is missing or linked"
  [[ "$archive_sha256" =~ ^[a-f0-9]{64}$ && "$candidate_digest" =~ ^[a-f0-9]{64}$ ]] ||
    fail "repair hashes must be complete SHA-256 values"
  # bound the internal failure probe to this fixed file count
  if [[ ! "$fail_after" =~ ^[0-9]+$ ]] || ((fail_after > ${#repair_files[@]})); then
    fail "invalid internal repair failure probe"
  fi
  [[ "$(sha256sum "$archive" | awk '{print $1}')" == "$archive_sha256" ]] ||
    fail "repair archive hash differs from the committed artifact"
  "$release_check" "$destination"
  "$verify_function" "$destination"

  # serialize only this installer
  install -d -m 0700 "$backup_root"
  exec {lock_fd}>"$backup_root/.adjustment-control-install.lock"
  chmod 600 "$backup_root/.adjustment-control-install.lock"
  flock -n "$lock_fd" || fail "another control-plane installer is in flight"
  require_quiet_weather
  "$release_check" "$destination"
  "$verify_function" "$destination"
  stage=$(mktemp -d "$backup_root/.adjustment-control-repair-stage.XXXXXXXX")
  trap restore_on_exit EXIT
  candidate_archive="$stage/candidate.tar"
  install -m 0600 "$archive" "$candidate_archive"
  [[ "$(sha256sum "$candidate_archive" | awk '{print $1}')" == "$archive_sha256" ]] ||
    fail "private repair archive hash differs from the committed artifact"

  # allow only public deployment-control archive paths
  tar -tf "$candidate_archive" >"$stage/archive-paths"
  # reject every path outside the fixed public tree
  while IFS= read -r entry; do
    [[ "$entry" =~ ^deploy(/([a-zA-Z0-9._-]+))*/?$ &&
      ! "$entry" =~ (^|/)\.\.(/|$) && ! "$entry" =~ (^|/)\.(/|$) ]] ||
      fail "repair archive contains a forbidden path"
    case "$entry" in
      deploy/|deploy/compose.yaml|deploy/scripts/|deploy/scripts/*|\
      deploy/postgres/|deploy/postgres/*|deploy/systemd/|deploy/systemd/*|\
      deploy/sudoers/|deploy/sudoers/*) ;;
      *) fail "repair archive includes private or unrelated state" ;;
    esac
  done <"$stage/archive-paths"
  tar -tvf "$candidate_archive" >"$stage/archive-types"
  # reject links and special files before extraction
  while IFS= read -r line; do
    [[ "${line:0:1}" == - || "${line:0:1}" == d ]] ||
      fail "repair archive includes a non-file entry"
  done <"$stage/archive-types"
  tar --no-same-owner --same-permissions -xf "$candidate_archive" -C "$stage"
  candidate_root=$stage
  grep -Fxq 'control_plane_version=12' "$candidate_root/deploy/scripts/update.sh" ||
    fail "repair candidate control version is not twelve"
  grep -Fxq "$pinned_release_name=$predecessor_release" \
    "$candidate_root/deploy/scripts/update.sh" ||
    fail "repair candidate does not pin the reviewed $description release"
  grep -Fxq "$pinned_digest_name=$predecessor_digest" \
    "$candidate_root/deploy/scripts/update.sh" ||
    fail "repair candidate does not pin the reviewed $description digest"
  [[ "$(control_digest "$candidate_root")" == "$candidate_digest" ]] ||
    fail "repair candidate control-plane digest differs"

  # compare every candidate path against the complete reviewed predecessor
  while read -r old_hash relative; do
    previous_hashes["$relative"]=$old_hash
    [[ -f "$candidate_root/$relative" ]] || fail "repair candidate deletes predecessor file: $relative"
  done < <("$manifest_function")
  # close all changed paths to the fixed repair allowlist
  while read -r new_hash relative; do
    old_hash=${previous_hashes["$relative"]:-}
    # record only changed public identities
    if [[ -z "$old_hash" || "$old_hash" != "$new_hash" ]]; then
      "$change_check" "$relative" || fail "repair candidate changes unreviewed path: $relative"
      changed_paths["$relative"]=1
    fi
  done < <(actual_manifest "$candidate_root")
  # require every reviewed repair file to change
  for file in "${repair_files[@]}"; do
    [[ -n "${changed_paths["deploy/$file"]:-}" ]] ||
      fail "repair candidate leaves required path unchanged: deploy/$file"
  done

  # retain the complete exact predecessor outside release metadata
  backup=$(mktemp -d "$backup_root/v12-${predecessor_digest:0:12}.XXXXXXXX")
  mkdir -p "$backup/deploy"
  cp -a "$destination/deploy/scripts" "$destination/deploy/postgres" \
    "$destination/deploy/systemd" "$destination/deploy/sudoers" \
    "$destination/deploy/compose.yaml" "$backup/deploy/"
  "$verify_function" "$backup"

  # prove the fixed allowlist alone yields the repair digest
  cp -a "$backup/deploy" "$stage/trial-deploy"
  # validate and overlay every repair file
  for file in "${repair_files[@]}"; do
    [[ -f "$candidate_root/deploy/$file" && ! -L "$candidate_root/deploy/$file" ]] ||
      fail "repair control file is missing or linked: $file"
    case "$file" in
      scripts/*.mjs) expected_mode=644 ;;
      *) expected_mode=755 ;;
    esac
    [[ "$(stat -c '%a' "$candidate_root/deploy/$file")" == "$expected_mode" ]] ||
      fail "repair control file mode is unsafe: $file"
    cp "$candidate_root/deploy/$file" "$stage/trial-deploy/$file"
  done
  mkdir -p "$stage/trial"
  mv "$stage/trial-deploy" "$stage/trial/deploy"
  [[ "$(control_digest "$stage/trial")" == "$candidate_digest" ]] ||
    fail "repair candidate changes exceed the reviewed fixed allowlist"

  # recheck the operator-serialized repair immediately before replacement
  require_quiet_weather
  "$release_check" "$destination"
  "$verify_function" "$destination"

  # install every reviewed file before the compatibility guard
  for file in "${repair_files[@]}"; do
    [[ "$file" == scripts/update.sh ]] && continue
    install_atomic_file "$candidate_root/deploy/$file" "$destination/deploy/$file"
    replaced=$((replaced + 1))
    # inject one bounded pre-guard failure
    if ((fail_after > 0 && replaced == fail_after)); then
      fail "internal mid-repair failure probe"
    fi
  done
  # install update last so the old guard remains through the repair
  install_atomic_file "$candidate_root/deploy/scripts/update.sh" \
    "$destination/deploy/scripts/update.sh"
  replaced=$((replaced + 1))
  # inject a bounded last-file failure
  if ((fail_after > 0 && replaced == fail_after)); then
    fail "internal mid-repair failure probe"
  fi
  [[ "$(control_digest "$destination")" == "$candidate_digest" ]] ||
    fail "installed repair control-plane digest differs from candidate"
  printf 'Installed %s control-plane repair: %s\nRetained v12 backup: %s\n' \
    "$description" "$candidate_digest" "$backup"
)

# install one pinned first-v12 repair
repair_v12_control_plane() {
  repair_v12_control_plane_transaction first "$@"
}

# install one pinned password-only v12 repair
repair_password_v12_control_plane() {
  repair_v12_control_plane_transaction password "$@"
}

# accept only a root-owned production handoff or explicit crash recovery
main() {
  ((EUID == 0)) || fail "host administrator authority is required"
  # recover the reviewed password-repair predecessor
  if (($# == 2)) && [[ "$1" == --recover-password-v12 ]]; then
    recover_password_v12_control_plane /opt/weather/current "$2"
    return
  fi
  # install the reviewed four-file password-only repair
  if (($# == 4)) && [[ "$1" == --repair-password-v12 ]]; then
    repair_password_v12_control_plane /opt/weather/current \
      /var/lib/weather/control-plane-backups "$2" "$3" "$4" 0
    return
  fi
  # recover the reviewed first-v12 repair predecessor
  if (($# == 2)) && [[ "$1" == --recover-v12 ]]; then
    recover_v12_control_plane /opt/weather/current "$2"
    return
  fi
  # install the reviewed two-file first-v12 repair
  if (($# == 4)) && [[ "$1" == --repair-v12 ]]; then
    repair_v12_control_plane /opt/weather/current \
      /var/lib/weather/control-plane-backups "$2" "$3" "$4" 0
    return
  fi
  # retain the pinned version-eleven recovery path
  if (($# == 2)) && [[ "$1" == --recover ]]; then
    recover_control_plane /opt/weather/current "$2"
    return
  fi
  (($# == 3)) || fail "usage: install-adjustment-evaluation-control-plane.sh ARCHIVE ARCHIVE_SHA256 CANDIDATE_SHA256 | --recover BACKUP | --repair-v12 ARCHIVE ARCHIVE_SHA256 CANDIDATE_SHA256 | --recover-v12 BACKUP | --repair-password-v12 ARCHIVE ARCHIVE_SHA256 CANDIDATE_SHA256 | --recover-password-v12 BACKUP"
  install_control_plane /opt/weather/current \
    /var/lib/weather/control-plane-backups "$1" "$2" "$3" 0
}

# run only when invoked instead of sourced by tests
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
