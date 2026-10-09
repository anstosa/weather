#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print release usage
usage() {
  cat <<'EOF'
Usage:
  update.sh v14-compatibility-bridge RELEASE
  update.sh yolo RELEASE [--from ENV_FILE]
  update.sh stage RELEASE [--from ENV_FILE]
  update.sh activate RELEASE
  update.sh rollback
  update.sh recover
  update.sh adjustment-family-release TARGET_RELEASE COMPENSATING_RELEASE EXPECTED_CURRENT_RELEASE EXPECTED_SOURCE_RELEASE EXPECTED_SETTINGS_SHA256 FAMILY ACTION_SHA256 REPORT_SHA256 FENCE
  update.sh status

yolo resolves the exact ARM64 images, enforces the local pull floor, applies
migrations, and starts the release directly without the full coexistence gate,
compatibility clone, or deployment-time backup.
v14-compatibility-bridge performs only the fixed source-compatible image handoff
on the unchanged reviewed 0018 ledger before the full v14 transition.
stage resolves and persists four exact ARM64 image digests without changing
running services or the active database. Upgrade staging uses only a disposable
compatibility database. activate backs up before migration and records success
last. rollback changes images only and never invokes migration.
EOF
}

releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
capacity_evidence=/var/lib/weather/preflight-latest.json
v13_resource_evidence=/var/lib/weather/preflight-v13-resource.json
control_plane_version=14
recurring_previous_release=2026.10.09-1
recurring_previous_control_plane_sha256=603eb8f488ba78be3d7ecf76b0d587346d1c36432255d390d86d2b768c8fecba
v14_compatibility_bridge_release=2026.10.09-2
v14_compatibility_bridge_commit=f6daa89d135661eb60dd5479c5d0d6c23e7198a9
full_v14_release=2026.10.09-3
# remain unavailable until the immutable bridge images are published
full_v14_source_server_image=ghcr.io/anstosa/weather-server@sha256:587dd0d34ed19086986a8081f7889fb10af2146d0d3f9ba46914389a787e5437
full_v14_source_web_image=ghcr.io/anstosa/weather-web@sha256:34d824b03c5f84289b8f38028e751f183a953565fc929260c09b07c9e64f15ba
v14_compatibility_bridge_state="$state_dir/v14-compatibility-bridge-v1"
v14_compatibility_bridge_pending="$state_dir/.v14-compatibility-bridge-v1.pending"
maintenance_previous_release=2026.10.07-3
legacy_control_plane_version=6
legacy_control_plane_sha256=c4d74581b84505e065fdec63447dfdded1d14221e459777a88e37729275f33b5
migration_authorization_version=1
image_pull_required_free_bytes=2034155520
image_pull_required_free_inodes=32768
image_cleanup_maximum_inventory_lines=4096
image_cleanup_maximum_containers=1024
weather_server_image_repository=ghcr.io/anstosa/weather-server
weather_web_image_repository=ghcr.io/anstosa/weather-web
adjustment_family_state_root=/opt/weather/current/deploy/state/adjustment-release-state
adjustment_family_deploy_state=/opt/weather/current/deploy/state
adjustment_family_releases=/opt/weather/current/deploy/releases
adjustment_family_settings=/var/lib/weather/xweather/forecast-adjustment-settings.json

# locate one validated release environment
release_env() {
  validate_release "$1"
  printf '%s/%s.env\n' "$releases_dir" "$1"
}

# hold one lifecycle lock on the fixed private state directory inode
acquire_release_transaction_lock() {
  require_command flock
  [[ -d "$state_dir" && ! -L "$state_dir" &&
    "$(realpath -e "$state_dir")" == "$state_dir" &&
    "$(stat -c '%u' "$state_dir")" == "$EUID" ]] ||
    die "release state lock root is missing, linked or foreign-owned"
  exec {release_transaction_lock_fd}<"$state_dir"
  flock --exclusive --nonblock "$release_transaction_lock_fd" ||
    die "another Weather release transaction is in flight"
  [[ "$(stat -Lc '%d:%i' "/proc/self/fd/$release_transaction_lock_fd")" == \
    "$(stat -c '%d:%i' "$state_dir")" ]] ||
    die "release state lock identity changed"
}

# derive v13 source settings only from the exact active predecessor
retained_maintenance_source_env() {
  local current source
  current=$(read_optional_release_state "$state_dir/current-release")
  [[ "$current" == "$maintenance_previous_release" ]] ||
    die "v13 deployment requires its exact retained active predecessor"
  source=$(release_env "$current")
  require_file "$source"
  printf '%s\n' "$source"
}

# refuse a bootstrap or caller-selected substitute for retained source settings
require_retained_maintenance_source() {
  [[ "$1" == "$(retained_maintenance_source_env)" ]] ||
    die "v13 deployment source must be the exact active release environment"
}

# locate one schema-release authorization
migration_authorization() {
  validate_release "$1"
  printf '%s/%s.migration-authorization\n' "$releases_dir" "$1"
}

# validate one exact private authorization
validate_migration_authorization() {
  local path=$1
  local expected_runtime=$2
  local expected_schema=$3
  local mode version runtime_release schema_release history_sha256
  local meaningful_lines allowed_fields
  require_canonical_descendant "$path" "$releases_dir" "migration authorization"
  require_file "$path"
  mode=$(stat -c '%a' "$path")
  [[ "$mode" == 600 ]] || die "migration authorization must be private"
  meaningful_lines=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$path")
  [[ "$meaningful_lines" -eq 4 ]] ||
    die "migration authorization must contain the exact current format"
  allowed_fields='^(WEATHER_MIGRATION_AUTHORIZATION_VERSION|WEATHER_MIGRATION_AUTHORIZATION_RELEASE|WEATHER_MIGRATION_AUTHORIZATION_SCHEMA_RELEASE|WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)='
  grep -qEv "$allowed_fields" "$path" &&
    die "migration authorization contains an unknown or malformed value"
  version=$(env_value "$path" WEATHER_MIGRATION_AUTHORIZATION_VERSION)
  runtime_release=$(env_value "$path" WEATHER_MIGRATION_AUTHORIZATION_RELEASE)
  schema_release=$(env_value "$path" WEATHER_MIGRATION_AUTHORIZATION_SCHEMA_RELEASE)
  history_sha256=$(env_value "$path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)
  validate_release "$runtime_release"
  validate_release "$schema_release"

  # bind the authorization to both releases
  if [[ "$runtime_release" != "$expected_runtime" || "$schema_release" != "$expected_schema" ]]; then
    die "migration authorization release mismatch"
  fi

  [[ "$version" == "$migration_authorization_version" ]] ||
    die "unsupported migration authorization version"
  [[ "$history_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "invalid migration authorization history digest"
}

# publish one immutable authorization payload
write_migration_authorization() {
  local path=$1
  local runtime_release=$2
  local schema_release=$3
  local history_sha256=$4
  validate_release "$runtime_release"
  validate_release "$schema_release"
  [[ "$history_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "invalid migration authorization history digest"
  require_canonical_descendant "$path" "$releases_dir" "migration authorization"
  umask 077
  printf '%s\n' \
    "WEATHER_MIGRATION_AUTHORIZATION_VERSION=$migration_authorization_version" \
    "WEATHER_MIGRATION_AUTHORIZATION_RELEASE=$runtime_release" \
    "WEATHER_MIGRATION_AUTHORIZATION_SCHEMA_RELEASE=$schema_release" \
    "WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=$history_sha256" >"$path"
  chmod 600 "$path"
  validate_migration_authorization "$path" "$runtime_release" "$schema_release"
}

# publish one authorization without replacement
publish_migration_authorization() {
  local source=$1
  local target=$2
  local runtime_release schema_release
  require_canonical_descendant "$source" "$releases_dir" "migration authorization"
  require_canonical_descendant "$target" "$releases_dir" "migration authorization"
  require_file "$source"
  runtime_release=$(env_value "$source" WEATHER_MIGRATION_AUTHORIZATION_RELEASE)
  schema_release=$(env_value "$source" WEATHER_MIGRATION_AUTHORIZATION_SCHEMA_RELEASE)
  validate_migration_authorization "$source" "$runtime_release" "$schema_release"

  # reject preexisting or raced publication
  [[ ! -e "$target" && ! -L "$target" ]] ||
    die "migration authorization already exists"
  sync -f "$source"
  ln "$source" "$target" || die "migration authorization already exists or could not be published"
  sync -f "$releases_dir"
  rm -f "$source"
  sync -f "$releases_dir"
  validate_migration_authorization "$target" "$runtime_release" "$schema_release"
}

# hash one exact ordered migration ledger
migration_history_sha256() {
  local env_file=$1
  local database_name=$2
  validate_database_name "$database_name"
  WEATHER_ENV_FILE=$env_file compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$database_name" \
      --tuples-only --no-align --field-separator=: \
      --command "SELECT name, checksum FROM schema_migrations ORDER BY name" |
    sha256sum | awk '{print $1}'
}

# remove a mutable tag or digest
image_repository() {
  local image=$1
  local repository=${image%%@*}
  local leaf=${repository##*/}

  # strip only a tag after the final slash
  if [[ "$leaf" == *:* ]]; then
    repository=${repository%:*}
  fi

  [[ "$repository" =~ ^[a-z0-9][a-z0-9._/:=-]*$ ]] ||
    die "invalid image repository: $image"
  printf '%s\n' "$repository"
}

# require the protected floor and one complete next-capture reservation
require_image_pull_capacity_floor() {
  local available_blocks block_bytes free_inodes free_bytes
  require_command stat
  read -r available_blocks block_bytes free_inodes < <(
    stat --file-system --format='%a %S %d' /var/lib/weather
  )
  [[ "$available_blocks" =~ ^[0-9]+$ && "$block_bytes" =~ ^[1-9][0-9]*$ &&
    "$free_inodes" =~ ^[0-9]+$ ]] || die "image pull capacity sample is invalid"
  free_bytes=$((available_blocks * block_bytes))

  # refuse pulls without claiming the separate full release oracle passed
  if ((free_bytes < image_pull_required_free_bytes ||
    free_inodes < image_pull_required_free_inodes)); then
    die "image pull capacity is below the protected capture floor"
  fi
}

# enforce the fixed inert v13 literal source/target/compensation ledger
require_literal_adjustment_release_capacity() (
  local source_env=$1
  local target_env=$2
  local source_release target_version receipt status key
  local source_server source_web target_server target_web
  require_file "$source_env"
  require_file "$target_env"
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  target_version=$(env_value "$target_env" WEATHER_CONTROL_PLANE_VERSION)

  # this gate is intentionally limited to the reviewed v12-to-v13 inert bridge
  [[ "$source_release" == "$maintenance_previous_release" &&
    "$target_version" == 13 ]] ||
    die "literal adjustment release capacity is unsupported outside the fixed inert v13 bridge"

  # keep the direct bridge on the exact retained database and tunnel infrastructure
  for key in POSTGRES_IMAGE CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR; do
    [[ "$(env_value "$source_env" "$key")" == "$(env_value "$target_env" "$key")" ]] ||
      die "fixed inert v13 infrastructure identity differs: $key"
  done
  source_server=$(env_value "$source_env" WEATHER_SERVER_IMAGE)
  source_web=$(env_value "$source_env" WEATHER_WEB_IMAGE)
  target_server=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  target_web=$(env_value "$target_env" WEATHER_WEB_IMAGE)
  receipt=$(mktemp "${TMPDIR:-/tmp}/weather-release-capacity.XXXXXX.json") ||
    die "literal adjustment release receipt could not be created"
  trap 'rm -f -- "$receipt"' EXIT
  chmod 600 "$receipt" || die "literal adjustment release receipt is not private"
  status=0
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" release-capacity \
    "$source_server" "$source_web" "$target_server" "$target_web" \
    >"$receipt" || status=$?
  require_bounded_image_cleanup_snapshot "$receipt" 1

  # surface the closed refusal receipt without treating it as admission
  if ((status != 0)); then
    cat "$receipt" >&2
    die "literal adjustment release image capacity is blocked"
  fi
  if ! node --input-type=module - "$receipt" <<'NODE'
import { readFileSync } from "node:fs";

const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));

// require the exact successful no-retirement receipt
if (receipt.contractVersion !== "adjustment-release-capacity/v3" ||
  receipt.compensationScope !== "fixed-inert-v13-whole-release-source-restore" ||
  receipt.sourceRelease !== "2026.10.07-3" ||
  receipt.state !== "capacity_ready" || receipt.retirementCreditBytes !== 0 ||
  receipt.compatibilityFixtureBytes !== 64 * 1_024 * 1_024 ||
  receipt.compatibilityFixtureInodes !== 4_096 ||
  receipt.futureStateBytes !== 1 * 1_024 * 1_024 ||
  !Number.isSafeInteger(receipt.retainedControlBytes) ||
  receipt.retainedControlBytes < 0 ||
  !Array.isArray(receipt.imageDigests) || receipt.imageDigests.length !== 6 ||
  !Number.isSafeInteger(receipt.requiredFreeBytes) ||
  !Number.isSafeInteger(receipt.requiredFreeInodes)) {
  throw new Error("literal release capacity receipt is invalid");
}
NODE
  then
    die "literal adjustment release capacity receipt is invalid"
  fi
  printf 'Literal adjustment release capacity passed: %s\n' \
    "$(tr -d '\n' <"$receipt")" >&2
)

# enforce the fixed inert v14 literal source/target/compensation ledger
require_literal_inert_v14_release_capacity() (
  local source_env=$1
  local target_env=$2
  local source_release target_version receipt status key
  local source_server source_web target_server target_web
  require_file "$source_env"
  require_file "$target_env"
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  target_version=$(env_value "$target_env" WEATHER_CONTROL_PLANE_VERSION)

  # this gate is intentionally limited to the reviewed inactive v13-to-v14 inert bridge
  [[ "$source_release" == "$recurring_previous_release" &&
    "$target_version" == 14 ]] ||
    die "literal adjustment release capacity is unsupported outside the fixed inert v14 bridge"

  # keep the direct bridge on the exact retained database and tunnel infrastructure
  for key in POSTGRES_IMAGE CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR; do
    [[ "$(env_value "$source_env" "$key")" == "$(env_value "$target_env" "$key")" ]] ||
      die "fixed inert v14 infrastructure identity differs: $key"
  done
  source_server=$(env_value "$source_env" WEATHER_SERVER_IMAGE)
  source_web=$(env_value "$source_env" WEATHER_WEB_IMAGE)
  target_server=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  target_web=$(env_value "$target_env" WEATHER_WEB_IMAGE)
  receipt=$(mktemp "${TMPDIR:-/tmp}/weather-release-capacity.XXXXXX.json") ||
    die "literal adjustment release receipt could not be created"
  trap 'rm -f -- "$receipt"' EXIT
  chmod 600 "$receipt" || die "literal adjustment release receipt is not private"
  status=0
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" inert-v14-release-capacity \
    "$source_server" "$source_web" "$target_server" "$target_web" \
    >"$receipt" || status=$?
  require_bounded_image_cleanup_snapshot "$receipt" 1

  # surface the closed refusal receipt without treating it as admission
  if ((status != 0)); then
    cat "$receipt" >&2
    die "literal adjustment release image capacity is blocked"
  fi
  if ! node --input-type=module - "$receipt" <<'NODE'
import { readFileSync } from "node:fs";

const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));

// require the exact successful no-retirement receipt
if (receipt.contractVersion !== "adjustment-inert-v14-release-capacity/v1" ||
  receipt.compensationScope !== "fixed-inert-v14-whole-release-source-restore" ||
  receipt.sourceRelease !== "2026.10.09-1" ||
  receipt.state !== "capacity_ready" || receipt.retirementCreditBytes !== 0 ||
  receipt.compatibilityFixtureBytes !== 64 * 1_024 * 1_024 ||
  receipt.compatibilityFixtureInodes !== 4_096 ||
  receipt.futureStateBytes !== 1 * 1_024 * 1_024 ||
  !Number.isSafeInteger(receipt.retainedControlBytes) ||
  receipt.retainedControlBytes < 0 ||
  !Array.isArray(receipt.imageDigests) || receipt.imageDigests.length !== 6 ||
  !Number.isSafeInteger(receipt.requiredFreeBytes) ||
  !Number.isSafeInteger(receipt.requiredFreeInodes)) {
  throw new Error("literal release capacity receipt is invalid");
}
NODE
  then
    die "literal adjustment release capacity receipt is invalid"
  fi
  printf 'Literal adjustment release capacity passed: %s\n' \
    "$(tr -d '\n' <"$receipt")" >&2
)

# enforce the full v14 literal bridge/target/compensation ledger
require_literal_full_v14_release_capacity() (
  local source_env=$1
  local target_env=$2
  local source_release target_version receipt status key
  local source_server source_web target_server target_web
  require_file "$source_env"
  require_file "$target_env"
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  target_version=$(env_value "$target_env" WEATHER_CONTROL_PLANE_VERSION)

  # admit only the reviewed bridge-to-full transition
  [[ "$source_release" == "$v14_compatibility_bridge_release" &&
    "$target_version" == 14 ]] ||
    die "literal full v14 capacity is unsupported outside the fixed bridge handoff"

  # retain the exact database and tunnel infrastructure across the handoff
  for key in POSTGRES_IMAGE CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR; do
    [[ "$(env_value "$source_env" "$key")" == "$(env_value "$target_env" "$key")" ]] ||
      die "full v14 infrastructure identity differs: $key"
  done
  source_server=$(env_value "$source_env" WEATHER_SERVER_IMAGE)
  source_web=$(env_value "$source_env" WEATHER_WEB_IMAGE)
  target_server=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  target_web=$(env_value "$target_env" WEATHER_WEB_IMAGE)
  receipt=$(mktemp "${TMPDIR:-/tmp}/weather-full-v14-capacity.XXXXXX.json") ||
    die "full v14 capacity receipt could not be created"
  trap 'rm -f -- "$receipt"' EXIT
  chmod 600 "$receipt" || die "full v14 capacity receipt is not private"
  status=0
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" full-v14-release-capacity \
    "$source_server" "$source_web" "$target_server" "$target_web" \
    >"$receipt" || status=$?
  require_bounded_image_cleanup_snapshot "$receipt" 1

  # retain the complete refusal receipt without treating it as admission
  if ((status != 0)); then
    cat "$receipt" >&2
    die "literal full v14 capacity is blocked"
  fi
  if ! node --input-type=module - "$receipt" <<'NODE'
import { readFileSync } from "node:fs";

const receipt = JSON.parse(readFileSync(process.argv[2], "utf8"));

// require the exact successful bridge-restoration receipt
if (receipt.contractVersion !== "adjustment-full-v14-release-capacity/v1" ||
  receipt.compensationScope !== "fixed-full-v14-whole-release-source-restore" ||
  receipt.sourceRelease !== "2026.10.09-2" ||
  receipt.state !== "capacity_ready" || receipt.retirementCreditBytes !== 0 ||
  receipt.compatibilityFixtureBytes !== 64 * 1_024 * 1_024 ||
  receipt.compatibilityFixtureInodes !== 4_096 ||
  receipt.futureStateBytes !== 1 * 1_024 * 1_024 ||
  !Number.isSafeInteger(receipt.retainedControlBytes) ||
  receipt.retainedControlBytes < 0 ||
  !Array.isArray(receipt.imageDigests) || receipt.imageDigests.length !== 6 ||
  !Number.isSafeInteger(receipt.requiredFreeBytes) ||
  !Number.isSafeInteger(receipt.requiredFreeInodes)) {
  throw new Error("literal full v14 capacity receipt is invalid");
}
NODE
  then
    die "literal full v14 capacity receipt is invalid"
  fi
  printf 'Literal full v14 capacity passed: %s\n' \
    "$(tr -d '\n' <"$receipt")" >&2
)

# cap one frozen Docker inventory before parsing or comparison
require_bounded_image_cleanup_snapshot() {
  local path=$1
  local maximum_lines=$2
  local byte_count line_count
  byte_count=$(wc -c <"$path")
  line_count=$(wc -l <"$path")
  [[ "$byte_count" =~ ^[0-9]+$ && "$line_count" =~ ^[0-9]+$ ]] ||
    die "Docker image cleanup snapshot is invalid"

  # reject unexpected daemon scale instead of scanning without a contract
  if ((byte_count > 1048576 || line_count > maximum_lines)); then
    die "Docker image cleanup snapshot exceeds its bound"
  fi
}

# freeze every local image reference without deleting or normalizing it
snapshot_docker_image_inventory() {
  local target=$1
  docker image ls --all --no-trunc --digests \
    --format '{{.ID}}\t{{.Repository}}\t{{.Tag}}\t{{.Digest}}' |
    LC_ALL=C sort -u >"$target"
  require_bounded_image_cleanup_snapshot \
    "$target" "$image_cleanup_maximum_inventory_lines"
}

# freeze every running or stopped container image identity
snapshot_docker_container_image_ids() {
  local target=$1
  local containers_path="${target}.containers"
  local -a containers
  docker ps --all --quiet --no-trunc | LC_ALL=C sort -u >"$containers_path"
  require_bounded_image_cleanup_snapshot \
    "$containers_path" "$image_cleanup_maximum_containers"
  mapfile -t containers <"$containers_path"
  : >"$target"

  # inspect only the bounded exact container set
  if ((${#containers[@]} > 0)); then
    docker container inspect --format '{{.Image}}' "${containers[@]}" |
      LC_ALL=C sort -u >"$target"
  fi
  rm -f -- "$containers_path"
  require_bounded_image_cleanup_snapshot \
    "$target" "$image_cleanup_maximum_containers"
}

# append one environment's closed image references to the cleanup contract
append_image_cleanup_environment() {
  local env_file=$1
  local require_local=$2
  local repositories_path=$3
  local references_path=$4
  local protected_ids_path=$5
  local key reference repository expected_repository image_id
  require_file "$env_file"

  # bind all four release images and only the two Weather-owned repositories
  for key in WEATHER_SERVER_IMAGE WEATHER_WEB_IMAGE POSTGRES_IMAGE CLOUDFLARED_IMAGE; do
    reference=$(env_value "$env_file" "$key")
    validate_image_reference "$reference"
    printf '%s\n' "$reference" >>"$references_path"

    # scope deletion authority to Weather application repositories
    if [[ "$key" == WEATHER_SERVER_IMAGE || "$key" == WEATHER_WEB_IMAGE ]]; then
      repository=$(image_repository "$reference")
      expected_repository=$weather_server_image_repository

      # select the fixed web repository only for the web image field
      if [[ "$key" == WEATHER_WEB_IMAGE ]]; then
        expected_repository=$weather_web_image_repository
      fi
      [[ "$repository" == "$expected_repository" ]] ||
        die "Weather image repository is outside cleanup authority: $repository"
      printf '%s\n' "$repository" >>"$repositories_path"
    fi

    # require every retained current or previous image to remain locally resolvable
    if [[ "$require_local" == true ]]; then
      image_id=$(docker image inspect --format '{{.Id}}' "$reference") ||
        die "retained release image is unavailable: $reference"
      [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
        die "retained release image identity is invalid"
      printf '%s\n' "$image_id" >>"$protected_ids_path"
    fi
  done
}

# freeze the release state and its exact image protection contract
write_weather_image_cleanup_contract() {
  local source_env=$1
  local target_env=$2
  local state_path=$3
  local repositories_path=$4
  local references_path=$5
  local protected_ids_path=$6
  local current previous retained_env
  current=$(read_optional_release_state "$state_dir/current-release")
  previous=$(read_optional_release_state "$state_dir/previous-release")
  printf 'current=%s\nprevious=%s\n' "$current" "$previous" >"$state_path"
  : >"$repositories_path"
  : >"$references_path"
  : >"$protected_ids_path"
  append_image_cleanup_environment \
    "$source_env" false "$repositories_path" "$references_path" "$protected_ids_path"
  append_image_cleanup_environment \
    "$target_env" false "$repositories_path" "$references_path" "$protected_ids_path"

  # protect both retained rollback boundaries by reference and local image identity
  for retained_env in "$current" "$previous"; do
    if [[ -n "$retained_env" ]]; then
      local retained_path
      retained_path=$(release_env "$retained_env")
      validate_release_env "$retained_path" "$retained_env"
      append_image_cleanup_environment \
        "$retained_path" true "$repositories_path" "$references_path" "$protected_ids_path"
    fi
  done
  LC_ALL=C sort -u -o "$repositories_path" "$repositories_path"
  LC_ALL=C sort -u -o "$references_path" "$references_path"
  LC_ALL=C sort -u -o "$protected_ids_path" "$protected_ids_path"
  require_bounded_image_cleanup_snapshot "$repositories_path" 16
  require_bounded_image_cleanup_snapshot "$references_path" 32
  require_bounded_image_cleanup_snapshot "$protected_ids_path" 16
}

# select only unprotected Weather-owned image identities from frozen files
select_obsolete_weather_image_ids() {
  local inventory_path=$1
  local repositories_path=$2
  local references_path=$3
  local protected_ids_path=$4
  node --input-type=module - \
    "$inventory_path" "$repositories_path" "$references_path" "$protected_ids_path" <<'NODE'
import { readFileSync, statSync } from "node:fs";

const [inventoryPath, repositoriesPath, referencesPath, protectedIdsPath] =
  process.argv.slice(2);
const imageIdPattern = /^sha256:[a-f0-9]{64}$/u;
const repositoryPattern = /^[a-z0-9][a-z0-9._/:=-]*$/u;
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const referencePattern =
  /^[a-z0-9][a-z0-9._/:=-]*(?:@sha256:[a-f0-9]{64}|:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/u;
const expectedRepositories = [
  "ghcr.io/anstosa/weather-server",
  "ghcr.io/anstosa/weather-web",
];

// read one small canonical newline-delimited contract
function readContractLines(path, label, maximumLines) {
  const details = statSync(path);

  // reject non-files and oversized selector inputs
  if (!details.isFile() || details.size > 1_048_576) {
    throw new Error(`${label} is invalid`);
  }
  const text = readFileSync(path, "utf8");

  // reject alternate framing and incomplete final records
  if (text.includes("\0") || text.includes("\r") ||
    (text.length > 0 && !text.endsWith("\n"))) {
    throw new Error(`${label} framing is invalid`);
  }
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");

  // reject empty, duplicate or unexpectedly large contracts
  if (lines.length > maximumLines || lines.some(
    // reject empty entries inside a nonempty contract
    (line) => line.length === 0,
  ) || new Set(lines).size !== lines.length) {
    throw new Error(`${label} entries are invalid`);
  }
  return lines;
}

const repositories = readContractLines(repositoriesPath, "Weather repositories", 16);
const protectedReferences = readContractLines(referencesPath, "protected references", 32);
const protectedIds = readContractLines(protectedIdsPath, "protected image IDs", 2048);
const inventory = readContractLines(inventoryPath, "image inventory", 4096);

// require every Weather repository to use the closed Docker grammar
if (JSON.stringify(repositories) !== JSON.stringify(expectedRepositories) ||
  repositories.some(
  // reject malformed repository authority
  (repository) => !repositoryPattern.test(repository),
)) {
  throw new Error("Weather repository contract is invalid");
}

// require every protected reference to remain exact and printable
if (protectedReferences.some(
  // reject mutable whitespace or unsupported reference shapes
  (reference) => !referencePattern.test(reference),
)) {
  throw new Error("protected image reference is invalid");
}

// require every protected image to use one full local identity
if (protectedIds.some(
  // reject shortened or non-content-addressed identities
  (imageId) => !imageIdPattern.test(imageId),
)) {
  throw new Error("protected image identity is invalid");
}

const repositorySet = new Set(repositories);
const referenceSet = new Set(protectedReferences);
const protectedIdSet = new Set(protectedIds);
const images = new Map();

// group every tag and digest sharing one local image identity
for (const line of inventory) {
  const fields = line.split("\t");

  // require the exact Docker inventory field contract
  if (fields.length !== 4) {
    throw new Error("image inventory record is invalid");
  }
  const [imageId, repository, tag, digest] = fields;

  // reject partial IDs and noncanonical repository metadata
  if (!imageIdPattern.test(imageId) ||
    (repository !== "<none>" && !repositoryPattern.test(repository)) ||
    (tag !== "<none>" && !tagPattern.test(tag)) ||
    (digest !== "<none>" && !digestPattern.test(digest))) {
    throw new Error("image inventory fields are invalid");
  }
  const state = images.get(imageId) ?? {
    foreignRepository: false,
    protected: protectedIdSet.has(imageId),
    weatherRepository: false,
  };

  // classify only repository-bound rows; dangling rows grant no authority
  if (repository !== "<none>") {
    if (repositorySet.has(repository)) {
      state.weatherRepository = true;
    } else {
      state.foreignRepository = true;
    }

    // protect either exact tag or exact digest references
    if ((tag !== "<none>" && referenceSet.has(`${repository}:${tag}`)) ||
      (digest !== "<none>" && referenceSet.has(`${repository}@${digest}`))) {
      state.protected = true;
    }
  }
  images.set(imageId, state);
}

const selected = [];

// choose only exclusively Weather-owned, unprotected local identities
for (const [imageId, state] of images) {
  if (state.weatherRepository && !state.foreignRepository && !state.protected) {
    selected.push(imageId);
  }
}
selected.sort();

// emit one bounded canonical deletion plan
if (selected.length > 0) {
  process.stdout.write(`${selected.join("\n")}\n`);
}
NODE
}

# retain one candidate's exact current repository aliases
write_image_alias_snapshot() {
  local inventory_path=$1
  local image_id=$2
  local target=$3
  [[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] ||
    die "Docker image cleanup candidate is invalid"
  awk -F '\t' -v expected="$image_id" '$1 == expected' "$inventory_path" >"$target"
  require_bounded_image_cleanup_snapshot "$target" 64
}

# delete one frozen obsolete Weather image plan without force or pruning
cleanup_obsolete_weather_images() (
  local source_env=$1
  local target_env=$2
  local temporary candidates_path image_id
  local -a candidates
  require_command cmp
  require_command node
  temporary=$(mktemp -d "${TMPDIR:-/tmp}/weather-image-cleanup.XXXXXX")

  # remove only the private selector workspace
  trap 'rm -rf -- "$temporary"' EXIT
  snapshot_docker_image_inventory "$temporary/images.before"
  snapshot_docker_container_image_ids "$temporary/containers.before"
  write_weather_image_cleanup_contract \
    "$source_env" "$target_env" \
    "$temporary/state.before" "$temporary/repositories.before" \
    "$temporary/references.before" "$temporary/retained.before"
  cat "$temporary/containers.before" "$temporary/retained.before" |
    LC_ALL=C sort -u >"$temporary/protected.before"
  candidates_path="$temporary/candidates"
  select_obsolete_weather_image_ids \
    "$temporary/images.before" "$temporary/repositories.before" \
    "$temporary/references.before" "$temporary/protected.before" >"$candidates_path"
  mapfile -t candidates <"$candidates_path"

  # leave an already clean cache unchanged
  if ((${#candidates[@]} == 0)); then
    return
  fi

  # reauthorize and remove exactly one image at a time
  for image_id in "${candidates[@]}"; do
    write_image_alias_snapshot \
      "$temporary/images.before" "$image_id" "$temporary/aliases.before"
    snapshot_docker_image_inventory "$temporary/images.current"
    snapshot_docker_container_image_ids "$temporary/containers.current"
    write_weather_image_cleanup_contract \
      "$source_env" "$target_env" \
      "$temporary/state.current" "$temporary/repositories.current" \
      "$temporary/references.current" "$temporary/retained.current"
    cat "$temporary/containers.current" "$temporary/retained.current" |
      LC_ALL=C sort -u >"$temporary/protected.current"
    select_obsolete_weather_image_ids \
      "$temporary/images.current" "$temporary/repositories.current" \
      "$temporary/references.current" "$temporary/protected.current" \
      >"$temporary/candidates.current"
    write_image_alias_snapshot \
      "$temporary/images.current" "$image_id" "$temporary/aliases.current"

    # refuse a newly protected, removed, retagged or foreign-aliased candidate
    if ! grep -Fxq -- "$image_id" "$temporary/candidates.current" ||
      ! cmp -s "$temporary/aliases.before" "$temporary/aliases.current"; then
      die "Docker image cleanup candidate changed during per-image selection"
    fi
    docker image rm "$image_id" >/dev/null ||
      die "obsolete Weather image removal failed"
  done
  printf 'Removed %s obsolete Weather image(s).\n' "${#candidates[@]}" >&2
)

# resolve one explicit linux arm64 manifest
resolve_arm64_image() {
  local image=$1
  local resolved

  # preserve pinned manifests after platform verification
  if [[ "$image" == *@sha256:* ]]; then
    resolved=$(docker manifest inspect --verbose "$image" |
      node "$deploy_dir/scripts/resolve-image.mjs" "$image")
  else
    resolved=$(docker buildx imagetools inspect "$image" --raw |
      node "$deploy_dir/scripts/resolve-image.mjs" "$image")
  fi
  validate_image_reference "$resolved"
  printf '%s\n' "$resolved"
}

# validate one immutable production release environment
validate_release_env() {
  local path=$1
  local expected_release=${2:-}
  local release database_name postgres_dir control_plane control_version wind_canary_kill_switch temperature_canary_kill_switch
  local meaningful_lines allowed_fields
  require_file "$path"
  [[ ! -L "$path" ]] || die "release environment must not be a symbolic link: $path"
  meaningful_lines=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$path")
  allowed_fields='^(WEATHER_RELEASE|WEATHER_SERVER_IMAGE|WEATHER_WEB_IMAGE|POSTGRES_IMAGE|CLOUDFLARED_IMAGE|WEATHER_DATABASE_NAME|WEATHER_POSTGRES_DIR|WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH|WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH|WEATHER_CONTROL_PLANE_SHA256|WEATHER_CONTROL_PLANE_VERSION)='
  control_plane=$(env_value "$path" WEATHER_CONTROL_PLANE_SHA256)
  control_version=$(env_value "$path" WEATHER_CONTROL_PLANE_VERSION)

  # preserve blank separators in the exact retained wind-only release
  if [[ "$control_version" == "$legacy_control_plane_version" && "$control_plane" == "$legacy_control_plane_sha256" ]]; then
    allowed_fields+='|^$'
  fi
  grep -qEv "$allowed_fields" "$path" &&
    die "release environment contains an unknown or malformed value"

  # accept only the exact field counts for current and legacy releases
  if [[ "$meaningful_lines" -eq 11 ]]; then
    temperature_canary_kill_switch=$(env_value "$path" WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH)
    [[ "$temperature_canary_kill_switch" =~ ^[01]$ ]] ||
      die "temperature canary kill switch must be 0 or 1"
    wind_canary_kill_switch=$(env_value "$path" WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH)
    [[ "$wind_canary_kill_switch" =~ ^[01]$ ]] ||
      die "wind canary kill switch must be 0 or 1"
  elif [[ "$meaningful_lines" -ne 10 || "$control_version" != "$legacy_control_plane_version" || "$control_plane" != "$legacy_control_plane_sha256" ]]; then
    die "release environment must contain the exact current or allowlisted legacy control-plane format"
  else
    # retain the actual version-six wind-only release format
    wind_canary_kill_switch=$(env_value "$path" WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH)
    [[ "$wind_canary_kill_switch" =~ ^[01]$ ]] ||
      die "wind canary kill switch must be 0 or 1"
  fi
  release=$(env_value "$path" WEATHER_RELEASE)
  validate_release "$release"

  # require the requested release identity
  if [[ -n "$expected_release" && "$release" != "$expected_release" ]]; then
    die "release environment identity mismatch"
  fi

  validate_image_reference "$(env_value "$path" WEATHER_SERVER_IMAGE)"
  validate_image_reference "$(env_value "$path" WEATHER_WEB_IMAGE)"
  validate_image_reference "$(env_value "$path" POSTGRES_IMAGE)"
  validate_image_reference "$(env_value "$path" CLOUDFLARED_IMAGE)"
  database_name=$(env_value "$path" WEATHER_DATABASE_NAME)
  postgres_dir=$(env_value "$path" WEATHER_POSTGRES_DIR)
  validate_database_name "$database_name"
  require_canonical_descendant "$postgres_dir" /var/lib/weather "PostgreSQL directory"
  [[ "$control_plane" =~ ^[a-f0-9]{64}$ ]] ||
    die "invalid deployment control-plane digest"
  [[ "$control_version" =~ ^[1-9][0-9]*$ ]] || die "invalid deployment control-plane version"
}

# inherit one independent canary switch without accepting malformed declarations
source_canary_kill_switch() {
  local source_env=$1
  local name=$2
  local default_value=$3
  local value
  local -a declarations
  [[ "$name" == WIND || "$name" == TEMPERATURE ]] || die "unknown canary switch"
  mapfile -t declarations < <(
    grep -E "^WEATHER_FORECAST_ADJUSTMENT_${name}_CANARY_KILL_SWITCH([=[:space:]]|$)" "$source_env" || true
  )

  # default only an omitted source field
  if ((${#declarations[@]} == 0)); then
    printf '%s\n' "$default_value"
    return
  fi

  ((${#declarations[@]} == 1)) || die "expected exactly one $name canary kill switch in $source_env"
  value=${declarations[0]#*=}
  [[ "${declarations[0]}" == "WEATHER_FORECAST_ADJUSTMENT_${name}_CANARY_KILL_SWITCH="* && "$value" =~ ^[01]$ ]] ||
    die "$name canary kill switch must be 0 or 1"
  printf '%s\n' "$value"
}

# require the installed deployment contract
require_control_plane_compatibility() {
  local env_file=$1
  local expected_version expected_digest expected_release current_digest
  grep -q '^WEATHER_CONTROL_PLANE_VERSION=' "$env_file" ||
    die "release state lacks deployment control-plane version metadata"
  grep -q '^WEATHER_CONTROL_PLANE_SHA256=' "$env_file" ||
    die "release state lacks deployment control-plane digest metadata"
  expected_version=$(env_value "$env_file" WEATHER_CONTROL_PLANE_VERSION)
  expected_digest=$(env_value "$env_file" WEATHER_CONTROL_PLANE_SHA256)
  current_digest=$(control_plane_digest)

  # accept the exact installed contract
  if [[ "$expected_version" == "$control_plane_version" && "$expected_digest" == "$current_digest" ]]; then
    return
  fi

  # accept only the complete pinned recurring-maintenance predecessor
  if [[ "$expected_version" == 13 &&
    "$expected_digest" == "$recurring_previous_control_plane_sha256" ]]; then
    expected_release=$(env_value "$env_file" WEATHER_RELEASE)
    [[ "$expected_release" == "$recurring_previous_release" ]] ||
      die "deployment control-plane identity is unsupported without an exact versioned allowlisted handoff"
    return
  fi

  die "deployment control-plane identity is unsupported without an exact versioned allowlisted handoff"
}

# write one deterministic release environment
write_release_env() {
  local source_env=$1
  local target=$2
  local release=$3
  local server_image=$4
  local web_image=$5
  local postgres_image=$6
  local cloudflared_image=$7
  local database_name postgres_dir control_plane wind_canary_kill_switch temperature_canary_kill_switch
  database_name=$(env_value "$source_env" WEATHER_DATABASE_NAME)
  postgres_dir=$(env_value "$source_env" WEATHER_POSTGRES_DIR)
  wind_canary_kill_switch=$(source_canary_kill_switch "$source_env" WIND 0)
  temperature_canary_kill_switch=$(source_canary_kill_switch "$source_env" TEMPERATURE 1)
  control_plane=$(control_plane_digest)
  umask 077
  printf '%s\n' \
    "WEATHER_RELEASE=$release" \
    "WEATHER_SERVER_IMAGE=$server_image" \
    "WEATHER_WEB_IMAGE=$web_image" \
    "POSTGRES_IMAGE=$postgres_image" \
    "CLOUDFLARED_IMAGE=$cloudflared_image" \
    "WEATHER_DATABASE_NAME=$database_name" \
    "WEATHER_POSTGRES_DIR=$postgres_dir" \
    "WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH=$wind_canary_kill_switch" \
    "WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH=$temperature_canary_kill_switch" \
    "WEATHER_CONTROL_PLANE_SHA256=$control_plane" \
    "WEATHER_CONTROL_PLANE_VERSION=$control_plane_version" >"$target"
  chmod 600 "$target"
  validate_release_env "$target" "$release"
}

# require recent passing preflight evidence
require_capacity_gate() {
  require_file "$capacity_evidence"
  node --input-type=module - "$capacity_evidence" <<'NODE'
import { readFile } from "node:fs/promises";

const path = process.argv[2];
const evidence = JSON.parse(await readFile(path, "utf8"));
const capturedAt = Date.parse(evidence.capturedAt);
const ageMilliseconds = Date.now() - capturedAt;

// require a recent full production sample
if (
  evidence.pass !== true ||
  evidence.sampleSeconds < 900 ||
  evidence.architecture?.host !== "aarch64" ||
  evidence.architecture?.docker !== "aarch64" ||
  !Number.isFinite(capturedAt) ||
  ageMilliseconds < -300_000 ||
  ageMilliseconds > 3_600_000
) {
  throw new Error("capacity evidence is absent, stale, incomplete, or failed");
}
NODE
}

# require fresh non-storage resource proof for the fixed v13 bridge
require_v13_resource_gate() {
  require_file "$v13_resource_evidence"
  node --input-type=module - "$v13_resource_evidence" <<'NODE'
import { lstatSync, readFileSync } from "node:fs";

const path = process.argv[2];
const details = lstatSync(path);

// require one bounded private regular evidence file
if (!details.isFile() || details.isSymbolicLink() || details.size < 1 ||
  details.size > 65_536 || (details.mode & 0o077) !== 0) {
  throw new Error("v13 resource evidence file is invalid");
}
const evidence = JSON.parse(readFileSync(path, "utf8"));
const exactKeys = (value, keys) => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const finite = (value) => Number.isFinite(value) && value >= 0;

// reject schema drift before evaluating individual resources
if (!exactKeys(evidence, [
  "architecture", "capturedAt", "cpu", "docker", "load15",
  "memoryAvailableBytes", "pass", "sampleSeconds", "swapBytesPerMinute",
  "varLib",
]) ||
  !exactKeys(evidence.architecture, ["docker", "expected", "host"]) ||
  !exactKeys(evidence.cpu, ["actual", "minimum"]) ||
  !exactKeys(evidence.load15, ["actual", "maximum"]) ||
  !exactKeys(evidence.memoryAvailableBytes, ["minimumObserved", "minimumRequired"]) ||
  !exactKeys(evidence.swapBytesPerMinute, ["actual", "maximum"]) ||
  !exactKeys(evidence.varLib, [
    "databaseBytes", "freeBytes", "inodeFreePercent", "minimumFreeBytes",
  ]) ||
  !exactKeys(evidence.docker, [
    "freeBytes", "inodeFreePercent", "minimumFreeBytes", "root",
  ])) {
  throw new Error("v13 resource evidence schema is invalid");
}
const capturedAt = Date.parse(evidence.capturedAt);
const ageMilliseconds = Date.now() - capturedAt;
const expectedVarLibMinimum = Math.max(
  10 * 1_024 * 1_024 * 1_024,
  3 * evidence.varLib.databaseBytes + 5 * 1_024 * 1_024 * 1_024,
);
const expectedLoadMaximum = Number((evidence.cpu.actual * 0.5).toFixed(3));

// preserve every fresh architecture, CPU, load, memory, swap and inode gate
if (evidence.sampleSeconds < 900 || !integer(evidence.sampleSeconds) ||
  !Number.isFinite(capturedAt) || ageMilliseconds < -300_000 ||
  ageMilliseconds > 3_600_000 ||
  evidence.architecture.host !== "aarch64" ||
  evidence.architecture.docker !== "aarch64" ||
  evidence.architecture.expected !== "aarch64" ||
  evidence.cpu.minimum !== 4 || !integer(evidence.cpu.actual) ||
  evidence.cpu.actual < evidence.cpu.minimum ||
  !finite(evidence.load15.actual) || !finite(evidence.load15.maximum) ||
  evidence.load15.maximum !== expectedLoadMaximum ||
  evidence.load15.actual > evidence.load15.maximum ||
  evidence.memoryAvailableBytes.minimumRequired !== 1_792 * 1_024 * 1_024 ||
  !integer(evidence.memoryAvailableBytes.minimumObserved) ||
  evidence.memoryAvailableBytes.minimumObserved <
    evidence.memoryAvailableBytes.minimumRequired ||
  evidence.swapBytesPerMinute.maximum !== 1_024 * 1_024 ||
  !integer(evidence.swapBytesPerMinute.actual) ||
  evidence.swapBytesPerMinute.actual > evidence.swapBytesPerMinute.maximum ||
  !integer(evidence.varLib.databaseBytes) || !integer(evidence.varLib.freeBytes) ||
  !integer(evidence.varLib.minimumFreeBytes) ||
  evidence.varLib.minimumFreeBytes !== expectedVarLibMinimum ||
  !integer(evidence.varLib.inodeFreePercent) ||
  evidence.varLib.inodeFreePercent < 10 ||
  evidence.varLib.inodeFreePercent > 100 ||
  evidence.docker.root !== "/var/lib/docker" ||
  !integer(evidence.docker.freeBytes) ||
  evidence.docker.minimumFreeBytes !== 4 * 1_024 * 1_024 * 1_024 ||
  !integer(evidence.docker.inodeFreePercent) ||
  evidence.docker.inodeFreePercent < 10 ||
  evidence.docker.inodeFreePercent > 100) {
  throw new Error("v13 non-storage resource evidence is absent, stale, or failed");
}
const failedBuckets = [];

// identify only the obsolete storage formulas in the reviewed sample
if (evidence.varLib.freeBytes < evidence.varLib.minimumFreeBytes) {
  failedBuckets.push("varLib.storage");
}
if (evidence.docker.freeBytes < evidence.docker.minimumFreeBytes) {
  failedBuckets.push("docker.storage");
}
const fullyPassing = evidence.pass === true && failedBuckets.length === 0;
const reviewedStorageFailure = evidence.pass === false &&
  JSON.stringify(failedBuckets) ===
    JSON.stringify(["varLib.storage", "docker.storage"]);

// admit either a full pass or only the exact reviewed obsolete storage failures
if (!fullyPassing && !reviewedStorageFailure) {
  throw new Error("v13 resource evidence does not contain only the reviewed storage failures");
}
NODE
}

# require host-owned per-consumer secrets
require_secret_source() {
  local path=$1
  local expected_uid=$2
  local expected_gid=$3
  local metadata uid gid mode
  require_canonical_descendant "$path" "$deploy_dir/secrets" "secret source"
  require_file "$path"
  metadata=$(stat -c '%u %g %a' "$path")
  read -r uid gid mode <<<"$metadata"
  [[ "$uid" == "$expected_uid" && "$gid" == "$expected_gid" ]] ||
    die "secret source has incorrect ownership: $path"
  [[ "$mode" == 400 ]] || die "secret source must use mode 0400: $path"
}

# verify every consumer copy without exposing material
require_deployment_secrets() {
  require_command cmp
  require_secret_source "$deploy_dir/secrets/weather_postgres_admin_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_postgres_owner_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_postgres_api_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_postgres_ingest_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_postgres_training_export_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_migration_owner_password" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_api_password" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_worker_ingest_password" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_tempest_api_key" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_xweather_client_id" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_xweather_client_secret" 10002 10002
  require_secret_source "$deploy_dir/secrets/cloudflare_tunnel_token" 65532 65532
  ! cmp -s "$deploy_dir/secrets/weather_postgres_admin_password" \
    "$deploy_dir/secrets/weather_postgres_owner_password" ||
    die "administrator and owner passwords must differ"
  cmp -s "$deploy_dir/secrets/weather_postgres_owner_password" \
    "$deploy_dir/secrets/weather_migration_owner_password" ||
    die "owner password copies differ"
  cmp -s "$deploy_dir/secrets/weather_postgres_api_password" \
    "$deploy_dir/secrets/weather_api_password" || die "API password copies differ"
  cmp -s "$deploy_dir/secrets/weather_postgres_ingest_password" \
    "$deploy_dir/secrets/weather_worker_ingest_password" ||
    die "ingest password copies differ"
  # reject shared training-export authority
  for runtime_secret in \
    weather_postgres_admin_password \
    weather_postgres_owner_password \
    weather_postgres_api_password \
    weather_postgres_ingest_password; do
    ! cmp -s "$deploy_dir/secrets/weather_postgres_training_export_password" \
      "$deploy_dir/secrets/$runtime_secret" ||
      die "training export password must differ from every runtime password"
  done
}

# record success with the current marker as commit point
record_release_success() {
  local target=$1
  local current=$2

  # retain the replaced release for rollback
  if [[ -n "$current" && "$current" != "$target" ]]; then
    write_private_state "$state_dir/previous-release" "$current"
  fi

  write_active_symlink "$target"
  write_private_state "$state_dir/current-release" "$target"
}

# require the one source image set reviewed for the inert v13 bridge
require_fixed_v13_source_identity() {
  local target_env=$1
  local source_env=$2
  local source_control source_control_version source_release source_server source_web
  local target_release target_version
  source_control=$(env_value "$source_env" WEATHER_CONTROL_PLANE_SHA256)
  source_control_version=$(env_value "$source_env" WEATHER_CONTROL_PLANE_VERSION)
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  source_server=$(env_value "$source_env" WEATHER_SERVER_IMAGE)
  source_web=$(env_value "$source_env" WEATHER_WEB_IMAGE)
  target_release=$(env_value "$target_env" WEATHER_RELEASE)
  target_version=$(env_value "$target_env" WEATHER_CONTROL_PLANE_VERSION)

  [[ "$source_release" == "2026.10.07-3" ]] ||
    die "fixed v13 source compatibility requires release 2026.10.07-3"
  [[ "$source_control_version" == 12 &&
    "$source_control" == "16d871c7aebb3a34097af219fd5c76a93b3ff1be3af521643dbf3a4d2041c61d" ]] ||
    die "fixed v13 source control-plane identity differs"
  [[ "$source_server" == "ghcr.io/anstosa/weather-server@sha256:d0688756c33875940f67fbb782d9e67a2405a811d2aca40bd155f6ceffa71a74" ]] ||
    die "fixed v13 source server image identity differs"
  [[ "$source_web" == "ghcr.io/anstosa/weather-web@sha256:739d063cd911bcd7c6637082e356889ef60ac7a76caabc737070703fdf83746f" ]] ||
    die "fixed v13 source web image identity differs"
  [[ "$target_version" == 13 ]] ||
    die "fixed v13 source compatibility requires a version 13 target"
  [[ "$target_release" != "$source_release" ]] ||
    die "fixed v13 source compatibility requires a distinct target release"
}

# require the exact source-one identity for the compatibility bridge
require_v14_compatibility_bridge_source_identity() {
  local target_env=$1
  local source_env=$2
  local source_control source_control_version source_release source_server source_web
  local target_release target_version
  source_control=$(env_value "$source_env" WEATHER_CONTROL_PLANE_SHA256)
  source_control_version=$(env_value "$source_env" WEATHER_CONTROL_PLANE_VERSION)
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  source_server=$(env_value "$source_env" WEATHER_SERVER_IMAGE)
  source_web=$(env_value "$source_env" WEATHER_WEB_IMAGE)
  target_release=$(env_value "$target_env" WEATHER_RELEASE)
  target_version=$(env_value "$target_env" WEATHER_CONTROL_PLANE_VERSION)

  [[ "$source_release" == "2026.10.09-1" ]] ||
    die "fixed v14 source compatibility requires release 2026.10.09-1"
  [[ "$source_control_version" == 13 &&
    "$source_control" == "603eb8f488ba78be3d7ecf76b0d587346d1c36432255d390d86d2b768c8fecba" ]] ||
    die "fixed v14 source control-plane identity differs"
  [[ "$source_server" == "ghcr.io/anstosa/weather-server@sha256:fb140b46d6eaea463ba2d10dc74303eac515135a37c21ddb746cdce744fd23ab" ]] ||
    die "fixed v14 source server image identity differs"
  [[ "$source_web" == "ghcr.io/anstosa/weather-web@sha256:fdcb2d10da4c9ed5ec8651bafa96c9d2b240b66b85db85619b909d6e144e2d7b" ]] ||
    die "fixed v14 source web image identity differs"
  [[ "$target_version" == 14 && "$target_release" == "$v14_compatibility_bridge_release" ]] ||
    die "v14 compatibility bridge target identity differs"
}

# bind the bridge target to installed controls, settings and immutable images
require_v14_compatibility_bridge_release_pair() {
  local target_env=$1
  local source_env=$2
  local key installed_control
  require_v14_compatibility_bridge_source_identity "$target_env" "$source_env"
  installed_control=$(control_plane_digest)
  validate_image_reference "$full_v14_source_server_image"
  validate_image_reference "$full_v14_source_web_image"
  [[ "$(env_value "$target_env" WEATHER_CONTROL_PLANE_SHA256)" == "$installed_control" ]] ||
    die "v14 compatibility bridge target control digest differs"
  [[ "$(env_value "$target_env" WEATHER_SERVER_IMAGE)" == "$full_v14_source_server_image" ]] ||
    die "v14 compatibility bridge target server image differs"
  [[ "$(env_value "$target_env" WEATHER_WEB_IMAGE)" == "$full_v14_source_web_image" ]] ||
    die "v14 compatibility bridge target web image differs"

  # preserve infrastructure and both canary decisions byte-for-byte
  for key in POSTGRES_IMAGE CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR \
    WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH \
    WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH; do
    [[ "$(env_value "$source_env" "$key")" == "$(env_value "$target_env" "$key")" ]] ||
      die "v14 compatibility bridge retained setting differs: $key"
  done
}

# require the exact published bridge identity for the full handoff
require_fixed_v14_source_identity() {
  local target_env=$1
  local source_env=$2
  local installed_control source_control source_control_version source_release source_server source_web
  local target_release target_version
  source_control=$(env_value "$source_env" WEATHER_CONTROL_PLANE_SHA256)
  source_control_version=$(env_value "$source_env" WEATHER_CONTROL_PLANE_VERSION)
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  source_server=$(env_value "$source_env" WEATHER_SERVER_IMAGE)
  source_web=$(env_value "$source_env" WEATHER_WEB_IMAGE)
  target_release=$(env_value "$target_env" WEATHER_RELEASE)
  target_version=$(env_value "$target_env" WEATHER_CONTROL_PLANE_VERSION)
  installed_control=$(control_plane_digest)

  # refuse activation until the two published bridge manifests are frozen
  validate_image_reference "$full_v14_source_server_image"
  validate_image_reference "$full_v14_source_web_image"
  [[ "$source_release" == "$v14_compatibility_bridge_release" ]] ||
    die "full v14 source release differs"
  [[ "$source_control_version" == 14 && "$source_control" == "$installed_control" ]] ||
    die "full v14 source control-plane identity differs"
  [[ "$source_server" == "$full_v14_source_server_image" ]] ||
    die "full v14 source server image identity differs"
  [[ "$source_web" == "$full_v14_source_web_image" ]] ||
    die "full v14 source web image identity differs"
  [[ "$target_version" == 14 && "$target_release" == "$full_v14_release" ]] ||
    die "full v14 target identity differs"
}

# require one exact active release link
require_v14_bridge_active_release() {
  local release=$1
  local active="$state_dir/active.env"
  [[ -L "$active" && "$(readlink "$active")" == "../releases/$release.env" ]] ||
    die "v14 compatibility bridge active release differs"
}

# validate one exact compatibility bridge receipt inode
require_v14_compatibility_bridge_state_file() {
  local path=$1
  local expected_links=$2
  local allowed_fields expected_owner meaningful_lines mode owner links size
  require_file "$path"
  [[ ! -L "$path" ]] || die "v14 compatibility bridge state must not be linked"
  mode=$(stat -c '%a' "$path")
  owner=$(stat -c '%u:%g' "$path")
  links=$(stat -c '%h' "$path")
  size=$(stat -c '%s' "$path")
  expected_owner="$EUID:$(id -g)"
  [[ "$mode" == 600 && "$owner" == "$expected_owner" && "$links" == "$expected_links" &&
    "$size" =~ ^[1-9][0-9]{0,3}$ && "$size" -le 4096 ]] ||
    die "v14 compatibility bridge state metadata differs"
  meaningful_lines=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$path")
  [[ "$meaningful_lines" == 11 ]] || die "v14 compatibility bridge state field count differs"
  allowed_fields='^(WEATHER_V14_BRIDGE_CONTRACT_VERSION|WEATHER_V14_BRIDGE_SOURCE_RELEASE|WEATHER_V14_BRIDGE_TARGET_RELEASE|WEATHER_V14_BRIDGE_TARGET_COMMIT|WEATHER_V14_BRIDGE_CONTROL_SHA256|WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256|WEATHER_V14_BRIDGE_SETTINGS_INODE|WEATHER_V14_BRIDGE_SETTINGS_SHA256|WEATHER_V14_BRIDGE_SOURCE_ENV_SHA256|WEATHER_V14_BRIDGE_TARGET_ENV_SHA256|WEATHER_V14_BRIDGE_PREVIOUS_RELEASE)='
  grep -qEv "$allowed_fields" "$path" && die "v14 compatibility bridge state contains an unknown field"
  [[ "$(env_value "$path" WEATHER_V14_BRIDGE_CONTRACT_VERSION)" == \
      weather-v14-compatibility-bridge/v1 &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_SOURCE_RELEASE)" == "$recurring_previous_release" &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_TARGET_RELEASE)" == "$v14_compatibility_bridge_release" &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_TARGET_COMMIT)" == "$v14_compatibility_bridge_commit" &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_CONTROL_SHA256)" == "$(control_plane_digest)" ]] ||
    die "v14 compatibility bridge state identity differs"
  [[ "$(env_value "$path" WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256)" =~ ^[a-f0-9]{64}$ &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_SETTINGS_INODE)" =~ ^[0-9]+:[0-9]+$ &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_SETTINGS_SHA256)" =~ ^[a-f0-9]{64}$ &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_SOURCE_ENV_SHA256)" =~ ^[a-f0-9]{64}$ &&
    "$(env_value "$path" WEATHER_V14_BRIDGE_TARGET_ENV_SHA256)" =~ ^[a-f0-9]{64}$ ]] ||
    die "v14 compatibility bridge state proof differs"
  local previous
  previous=$(env_value "$path" WEATHER_V14_BRIDGE_PREVIOUS_RELEASE)
  [[ "$previous" == absent ]] || validate_release "$previous"
}

# finish only the exact fixed hard-link publication window
reconcile_v14_compatibility_bridge_state() {
  local final=$v14_compatibility_bridge_state
  local pending=$v14_compatibility_bridge_pending
  # collapse the only accepted two-link crash state
  if [[ -e "$final" || -L "$final" ]]; then
    if [[ -e "$pending" || -L "$pending" ]]; then
      require_v14_compatibility_bridge_state_file "$final" 2
      require_v14_compatibility_bridge_state_file "$pending" 2
      [[ "$(stat -c '%d:%i' "$final")" == "$(stat -c '%d:%i' "$pending")" ]] ||
        die "v14 compatibility bridge pending receipt differs"
      rm -f -- "$pending"
      sync -f "$state_dir"
    fi
    require_v14_compatibility_bridge_state_file "$final" 1
  fi
}

# validate the durable compatibility bridge receipt
require_v14_compatibility_bridge_state() {
  reconcile_v14_compatibility_bridge_state
  require_v14_compatibility_bridge_state_file "$v14_compatibility_bridge_state" 1
}

# cross-bind the durable receipt to one computed bridge attempt
require_v14_compatibility_bridge_state_inputs() {
  local source_env=$1
  local target_env=$2
  local history_sha256=$3
  local settings_inode=$4
  local settings_sha256=$5
  local previous_release=$6
  require_v14_compatibility_bridge_state
  [[ "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256)" == "$history_sha256" &&
    "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SETTINGS_INODE)" == "$settings_inode" &&
    "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SETTINGS_SHA256)" == "$settings_sha256" &&
    "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_ENV_SHA256)" == "$(sha256sum "$source_env" | awk '{print $1}')" &&
    "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_TARGET_ENV_SHA256)" == "$(sha256sum "$target_env" | awk '{print $1}')" &&
    "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_PREVIOUS_RELEASE)" == "$previous_release" ]] ||
    die "v14 compatibility bridge state inputs differ"
}

# publish one create-once bridge receipt before runtime mutation
publish_v14_compatibility_bridge_state() {
  local source_env=$1
  local target_env=$2
  local history_sha256=$3
  local settings_inode=$4
  local settings_sha256=$5
  local previous_release=$6
  local temporary
  [[ "$history_sha256" =~ ^[a-f0-9]{64}$ && "$settings_inode" =~ ^[0-9]+:[0-9]+$ &&
    "$settings_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "v14 compatibility bridge state inputs are invalid"
  [[ "$previous_release" == absent ]] || validate_release "$previous_release"
  reconcile_v14_compatibility_bridge_state
  # finish an exact durable pending receipt from a pre-link crash
  if [[ ! -e "$v14_compatibility_bridge_state" && ! -L "$v14_compatibility_bridge_state" &&
    ( -e "$v14_compatibility_bridge_pending" || -L "$v14_compatibility_bridge_pending" ) ]]; then
    require_v14_compatibility_bridge_state_file "$v14_compatibility_bridge_pending" 1
    ln "$v14_compatibility_bridge_pending" "$v14_compatibility_bridge_state" ||
      die "v14 compatibility bridge state publication collided"
    sync -f "$state_dir"
    rm -f -- "$v14_compatibility_bridge_pending"
    sync -f "$state_dir"
    require_v14_compatibility_bridge_state_inputs "$source_env" "$target_env" \
      "$history_sha256" "$settings_inode" "$settings_sha256" "$previous_release"
    return
  fi
  [[ ! -e "$v14_compatibility_bridge_state" && ! -L "$v14_compatibility_bridge_state" ]] ||
    die "v14 compatibility bridge state already exists"
  [[ ! -e "$v14_compatibility_bridge_pending" && ! -L "$v14_compatibility_bridge_pending" ]] ||
    die "v14 compatibility bridge pending state already exists"
  temporary=$(mktemp "$state_dir/.v14-compatibility-bridge.XXXXXX")
  trap 'rm -f -- "$temporary"' RETURN
  umask 077
  printf '%s\n' \
    'WEATHER_V14_BRIDGE_CONTRACT_VERSION=weather-v14-compatibility-bridge/v1' \
    "WEATHER_V14_BRIDGE_SOURCE_RELEASE=$recurring_previous_release" \
    "WEATHER_V14_BRIDGE_TARGET_RELEASE=$v14_compatibility_bridge_release" \
    "WEATHER_V14_BRIDGE_TARGET_COMMIT=$v14_compatibility_bridge_commit" \
    "WEATHER_V14_BRIDGE_CONTROL_SHA256=$(control_plane_digest)" \
    "WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256=$history_sha256" \
    "WEATHER_V14_BRIDGE_SETTINGS_INODE=$settings_inode" \
    "WEATHER_V14_BRIDGE_SETTINGS_SHA256=$settings_sha256" \
    "WEATHER_V14_BRIDGE_SOURCE_ENV_SHA256=$(sha256sum "$source_env" | awk '{print $1}')" \
    "WEATHER_V14_BRIDGE_TARGET_ENV_SHA256=$(sha256sum "$target_env" | awk '{print $1}')" \
    "WEATHER_V14_BRIDGE_PREVIOUS_RELEASE=$previous_release" >"$temporary"
  chmod 600 "$temporary"
  chown "$EUID:$(id -g)" "$temporary"
  sync -f "$temporary"
  mv -T -n "$temporary" "$v14_compatibility_bridge_pending"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] ||
    die "v14 compatibility bridge pending state publication collided"
  sync -f "$state_dir"
  ln "$v14_compatibility_bridge_pending" "$v14_compatibility_bridge_state" ||
    die "v14 compatibility bridge state publication collided"
  sync -f "$state_dir"
  rm -f -- "$v14_compatibility_bridge_pending"
  sync -f "$state_dir"
  trap - RETURN
  require_v14_compatibility_bridge_state_inputs "$source_env" "$target_env" \
    "$history_sha256" "$settings_inode" "$settings_sha256" "$previous_release"
}

# write the fixed pre-epoch compose override
write_v14_compatibility_compose_override() {
  local override=$1
  cat >"$override" <<'YAML'
services:
  api:
    volumes: !reset []
  worker:
    volumes: !reset []
YAML
  chmod 600 "$override"
}

# prove one pre-epoch compose view contains no future-state mounts
require_v14_compatibility_compose_override() {
  local environment=$1
  local override=$2
  # prove the bridge does not depend on uninitialized maintenance authority files
  docker compose --project-name "${WEATHER_COMPOSE_PROJECT_NAME:-weather}" \
    --env-file "$environment" -f "$compose_file" -f "$override" config --format json | \
    node --input-type=module -e '
import { readFileSync } from "node:fs";
const configuration = JSON.parse(readFileSync(0, "utf8"));
// reject any inherited or future API and worker filesystem authority
if (configuration.services?.api?.volumes !== undefined ||
  configuration.services?.worker?.volumes !== undefined) {
  throw new Error("v14 compatibility bridge retained future-state mounts");
}
'
}

# run one compose operation through the fixed pre-epoch view
v14_compatibility_compose() {
  local environment=$1
  local override=$2
  shift 2
  docker compose --project-name "${WEATHER_COMPOSE_PROJECT_NAME:-weather}" \
    --env-file "$environment" -f "$compose_file" -f "$override" "$@"
}

# start only runtime containers without schema, ACL or future-state mounts
start_v14_compatibility_bridge_runtime() (
  local environment=$1
  local override
  override=$(mktemp "$state_dir/.v14-compatibility-compose.XXXXXX.yaml") ||
    die "v14 compatibility bridge override could not be created"
  trap 'rm -f -- "$override"' EXIT
  write_v14_compatibility_compose_override "$override"
  require_v14_compatibility_compose_override "$environment" "$override"
  v14_compatibility_compose "$environment" "$override" \
    up -d --no-deps --remove-orphans --wait api worker web cloudflared
)

# restore source-one runtime and markers after an interrupted bridge
recover_v14_compatibility_bridge() {
  local source_env target_env previous history settings_inode settings_sha256 actual_settings
  local recovery_status=0
  [[ -e "$v14_compatibility_bridge_state" || -L "$v14_compatibility_bridge_state" ]] || return 0
  require_v14_compatibility_bridge_state || return 1
  source_env=$(release_env "$recurring_previous_release")
  target_env=$(release_env "$v14_compatibility_bridge_release")
  validate_release_env "$source_env" "$recurring_previous_release" || return 1
  validate_release_env "$target_env" "$v14_compatibility_bridge_release" || return 1
  [[ "$(sha256sum "$source_env" | awk '{print $1}')" == \
      "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_ENV_SHA256)" &&
    "$(sha256sum "$target_env" | awk '{print $1}')" == \
      "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_TARGET_ENV_SHA256)" ]] ||
    die "v14 compatibility bridge recovery environment differs"
  history=$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256)
  settings_inode=$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SETTINGS_INODE)
  settings_sha256=$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SETTINGS_SHA256)
  actual_settings=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    inert-v14-settings-snapshot) || return 1
  [[ "$actual_settings" == "$settings_inode $settings_sha256" ]] ||
    die "v14 compatibility bridge recovery settings differ"

  # restore exact source images without touching ACLs or migrations
  start_v14_compatibility_bridge_runtime "$source_env" || recovery_status=1
  require_v14_compatibility_bridge_migration_ledger \
    "$source_env" "$(env_value "$source_env" WEATHER_DATABASE_NAME)" || recovery_status=1
  [[ "$(migration_history_sha256 "$source_env" \
      "$(env_value "$source_env" WEATHER_DATABASE_NAME)")" == "$history" ]] || recovery_status=1
  ((recovery_status == 0)) || return 1
  previous=$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_PREVIOUS_RELEASE)
  # restore the original rollback marker before source becomes current again
  if [[ "$previous" == absent ]]; then
    rm -f -- "$state_dir/previous-release" || return 1
  else
    write_private_state "$state_dir/previous-release" "$previous" || return 1
  fi
  write_private_state "$state_dir/schema-release" "$recurring_previous_release" || return 1
  write_active_symlink "$recurring_previous_release" || return 1
  write_private_state "$state_dir/current-release" "$recurring_previous_release" || return 1
  rm -f -- "$v14_compatibility_bridge_state"
}

# require the immutable bridge receipt without assuming the current schema state
require_v14_compatibility_bridge_receipt() {
  local source_env target_env
  require_v14_compatibility_bridge_state
  source_env=$(release_env "$recurring_previous_release")
  target_env=$(release_env "$v14_compatibility_bridge_release")
  validate_release_env "$source_env" "$recurring_previous_release"
  validate_release_env "$target_env" "$v14_compatibility_bridge_release"
  require_v14_compatibility_bridge_release_pair "$target_env" "$source_env"
  [[ "$(sha256sum "$source_env" | awk '{print $1}')" == \
      "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_ENV_SHA256)" &&
    "$(sha256sum "$target_env" | awk '{print $1}')" == \
      "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_TARGET_ENV_SHA256)" ]] ||
    die "v14 compatibility bridge receipt environments differ"
}

# require the original operator settings bound by the bridge receipt
require_v14_compatibility_bridge_settings() {
  local settings
  settings=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    inert-v14-settings-snapshot)
  [[ "$settings" == \
      "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SETTINGS_INODE) $(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SETTINGS_SHA256)" ]] ||
    die "v14 compatibility bridge settings differ"
}

# require the complete committed bridge before the full migration handoff
require_committed_v14_compatibility_bridge() {
  local target_env history
  require_v14_compatibility_bridge_receipt
  [[ "$(read_release_state "$state_dir/current-release")" == "$v14_compatibility_bridge_release" &&
    "$(read_release_state "$state_dir/schema-release")" == "$v14_compatibility_bridge_release" ]] ||
    die "full v14 requires committed bridge runtime and schema markers"
  require_v14_bridge_active_release "$v14_compatibility_bridge_release"
  target_env=$(release_env "$v14_compatibility_bridge_release")
  require_v14_compatibility_bridge_migration_ledger \
    "$target_env" "$(env_value "$target_env" WEATHER_DATABASE_NAME)"
  history=$(migration_history_sha256 \
    "$target_env" "$(env_value "$target_env" WEATHER_DATABASE_NAME)")
  [[ "$history" == \
      "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256)" ]] ||
    die "committed v14 compatibility bridge ledger differs"
  require_v14_compatibility_bridge_settings
}

# require source-two authorization for the exact complete full schema
require_v14_source2_full_schema_authority() {
  local environment=$1
  local authorization actual_history expected_history database
  require_v14_compatibility_bridge_receipt
  validate_release_env "$environment" "$v14_compatibility_bridge_release"
  authorization=$(migration_authorization "$full_v14_release")
  validate_migration_authorization "$authorization" \
    "$v14_compatibility_bridge_release" "$full_v14_release"
  database=$(env_value "$environment" WEATHER_DATABASE_NAME)
  actual_history=$(migration_history_sha256 "$environment" "$database")
  expected_history=$(env_value \
    "$authorization" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)
  [[ "$actual_history" == "$expected_history" ]] ||
    die "v14 source-two full-schema history differs"
  require_fixed_v14_migration_ledger "$environment" "$database"
  require_v14_compatibility_bridge_settings
}

# admit the full transaction from pristine or authorized compensated source two
require_v14_full_source_authority() {
  local environment=$1
  local schema
  [[ "$(read_release_state "$state_dir/current-release")" == \
    "$v14_compatibility_bridge_release" ]] ||
    die "full v14 requires the exact compatibility bridge runtime"
  require_v14_bridge_active_release "$v14_compatibility_bridge_release"
  schema=$(read_release_state "$state_dir/schema-release")
  # distinguish pristine schema 18 from an authorized full-schema retry
  if [[ "$schema" == "$v14_compatibility_bridge_release" ]]; then
    require_committed_v14_compatibility_bridge
  elif [[ "$schema" == "$full_v14_release" ]]; then
    require_v14_source2_full_schema_authority "$environment"
  else
    die "full v14 source schema marker differs"
  fi
}

# require the root current authority before accepting a committed full release
require_full_v14_current_authority() {
  local environment=$1
  local catalog="$state_dir/adjustment-candidate-catalog.json"
  local catalog_sha256 settings settings_identity settings_sha256
  require_file "$catalog"
  catalog_sha256=$(sha256sum "$catalog" | awk '{print $1}')
  settings=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    inert-v14-settings-snapshot)
  settings_identity=${settings%% *}
  settings_sha256=${settings#* }
  # validate live settings independently from the retained commit-time identity
  [[ "$catalog_sha256" =~ ^[a-f0-9]{64}$ && "$settings_identity" =~ ^[0-9]+:[0-9]+$ &&
    "$settings_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "full v14 current authority inputs are invalid"
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" verify-inert-v14-current \
    "$full_v14_release" "$(env_value "$environment" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$environment" WEATHER_WEB_IMAGE)" "$catalog_sha256" >/dev/null ||
    die "full v14 current authority is unavailable"
}

# verify the unchanged source ledger before and after the compatibility bridge
require_v14_compatibility_bridge_migration_ledger() {
  local environment=$1
  local database=$2
  WEATHER_ENV_FILE=$environment compose exec -T postgres \
    psql --no-psqlrc --set=ON_ERROR_STOP=1 --username postgres --dbname "$database" -tAc \
    'SELECT row_to_json(manifest) FROM adjustment_evaluation_export_manifest_v1 manifest' | \
    node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      verify-maintenance-ledger-v13-compatibility ||
    die "v14 compatibility bridge requires the exact complete 0018 ledger"
}

# verify all migration names and bytes before publishing v14 compatibility authority
require_fixed_v14_migration_ledger() {
  local environment=$1
  local database=$2
  WEATHER_ENV_FILE=$environment compose exec -T postgres \
    psql --no-psqlrc --set=ON_ERROR_STOP=1 --username postgres --dbname "$database" -tAc \
    'SELECT row_to_json(manifest) FROM adjustment_evaluation_export_manifest_v1 manifest' | \
    node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" verify-maintenance-ledger-v14-rolling ||
    die "fixed v14 compatibility fixture lacks the exact complete 0021 ledger"
}

# create or verify only the fixed dedicated rain target sources
initialize_adjustment_rain_fixed_gauge_target_sources_v1() (
  local environment=$1
  local database
  [[ "$EUID" == 0 ]] || die "rain target source initialization requires root"
  validate_release_env "$environment" "$(env_value "$environment" WEATHER_RELEASE)"
  require_control_plane_compatibility "$environment"
  [[ "$(env_value "$environment" WEATHER_CONTROL_PLANE_VERSION)" == 14 ]] ||
    die "rain target source initialization requires v14"
  require_deployment_secrets
  database=$(env_value "$environment" WEATHER_DATABASE_NAME)
  validate_database_name "$database"
  require_fixed_v14_migration_ledger "$environment" "$database"
  # keep the existing owner secret inside the database container process environment
  # shellcheck disable=SC2016
  node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    rain-fixed-gauge-target-sources-sql-v1 | \
    WEATHER_ENV_FILE=$environment compose exec -T postgres \
      sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_owner_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --host 127.0.0.1 --username weather_owner --dbname "$1"' \
      adjustment-rain-target-sources "$database" | \
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      project-rain-fixed-gauge-target-sources-v1
)

# retry the fixed source initialization only against the current v14 release
initialize_current_adjustment_rain_fixed_gauge_target_sources_v1() (
  local current environment
  [[ "$EUID" == 0 ]] || die "rain target source initialization requires root"
  acquire_release_transaction_lock
  current=$(read_release_state "$state_dir/current-release")
  environment=$(release_env "$current")
  initialize_adjustment_rain_fixed_gauge_target_sources_v1 "$environment"
)

# initialize only the create-once schedule independently derived from the root epoch
initialize_adjustment_registration_schedule_v3() (
  local bootstrap_sha256=$1
  local current environment database temporary
  [[ "$EUID" == 0 && "$bootstrap_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "registration schedule initialization requires root and one hash"
  acquire_release_transaction_lock
  current=$(read_release_state "$state_dir/current-release")
  environment=$(release_env "$current")
  validate_release_env "$environment" "$current"
  require_control_plane_compatibility "$environment"
  [[ "$(env_value "$environment" WEATHER_CONTROL_PLANE_VERSION)" == 14 ]] ||
    die "registration schedule requires the current v14 control plane"
  require_deployment_secrets
  database=$(env_value "$environment" WEATHER_DATABASE_NAME)
  validate_database_name "$database"
  require_fixed_v14_migration_ledger "$environment" "$database"
  temporary=$(mktemp "$state_dir/.registration-schedule.XXXXXX.sql")
  chmod 600 "$temporary"
  # remove only this unpublished bounded SQL inode on every exit
  trap 'rm -f -- "$temporary"' EXIT
  node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    registration-schedule-initialize-sql-v3 "$bootstrap_sha256" >"$temporary"
  # keep the existing owner secret inside the database container process environment
  # shellcheck disable=SC2016
  WEATHER_ENV_FILE=$environment compose exec -T postgres \
    sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_owner_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --host 127.0.0.1 --username weather_owner --dbname "$1"' \
    adjustment-registration-schedule "$database" <"$temporary" | \
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      verify-registration-schedule-initialization-v3 "$bootstrap_sha256"
)

# read only closed rolling registrations and reconciled predecessor identities
read_adjustment_registration_lifecycle_status_v4() (
  local current environment database
  [[ "$EUID" == 0 ]] || die "registration lifecycle status requires root"
  acquire_release_transaction_lock
  current=$(read_release_state "$state_dir/current-release")
  environment=$(release_env "$current")
  validate_release_env "$environment" "$current"
  require_control_plane_compatibility "$environment"
  [[ "$(env_value "$environment" WEATHER_CONTROL_PLANE_VERSION)" == 14 ]] ||
    die "registration lifecycle status requires v14"
  require_deployment_secrets
  database=$(env_value "$environment" WEATHER_DATABASE_NAME)
  validate_database_name "$database"
  require_fixed_v14_migration_ledger "$environment" "$database"
  # keep all SQL and schema identities inside the fixed reviewed owner boundary
  # shellcheck disable=SC2016
  node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" registration-lifecycle-status-sql-v4 | \
    WEATHER_ENV_FILE=$environment compose exec -T postgres \
      sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_owner_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --host 127.0.0.1 --username weather_owner --dbname "$1"' \
      adjustment-registration-lifecycle "$database" | \
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" project-registration-lifecycle-status-v4
)

# execute only a canonical authenticated owner operation under the deployment fence
run_adjustment_owner_operation_v3() (
  local kind=$1 identity=$2 current environment database result_kind
  [[ "$EUID" == 0 ]] || die "adjustment owner operation requires root"
  [[ "$kind" =~ ^(access|terminal|retire|unsupported-terminal|unsupported-retire)$ &&
    "$identity" =~ ^[a-f0-9]{64}$ ]] || die "adjustment owner operation is invalid"
  # reuse only the closed terminal response grammar after disjoint request authorization
  case "$kind" in
    unsupported-terminal) result_kind=terminal ;;
    unsupported-retire) result_kind=retire ;;
    *) result_kind=$kind ;;
  esac
  acquire_release_transaction_lock
  current=$(read_release_state "$state_dir/current-release")
  environment=$(release_env "$current")
  validate_release_env "$environment" "$current"
  require_control_plane_compatibility "$environment"
  [[ "$(env_value "$environment" WEATHER_CONTROL_PLANE_VERSION)" == 14 ]] || die "adjustment owner operation requires v14"
  require_deployment_secrets
  database=$(env_value "$environment" WEATHER_DATABASE_NAME)
  validate_database_name "$database"
  require_fixed_v14_migration_ledger "$environment" "$database"
  # stdin remains the bounded request and no password enters command arguments
  # shellcheck disable=SC2016
  node --max-old-space-size=48 --max-semi-space-size=1 "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    owner-operation-sql-v3 "$kind" "$identity" | \
    WEATHER_ENV_FILE=$environment compose exec -T postgres \
      sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_owner_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --host 127.0.0.1 --username weather_owner --dbname "$1"' \
      adjustment-owner-operation "$database" | \
    node --max-old-space-size=48 --max-semi-space-size=1 "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      owner-operation-result-v3 "$result_kind"
)

# finalize only compact rows covered by the current authenticated custody proof
finalize_adjustment_shadow_metadata_custody_v1() (
  local proof=$1 current environment database preparation consumed
  [[ "$EUID" == 0 ]] || die "shadow metadata custody finalization requires root"
  [[ "$proof" =~ ^[a-f0-9]{64}$ ]] || die "shadow metadata custody identity is invalid"
  require_command setpriv
  acquire_release_transaction_lock
  current=$(read_release_state "$state_dir/current-release")
  environment=$(release_env "$current")
  validate_release_env "$environment" "$current"
  require_control_plane_compatibility "$environment"
  [[ "$(env_value "$environment" WEATHER_CONTROL_PLANE_VERSION)" == 14 ]] ||
    die "shadow metadata custody finalization requires v14"
  require_deployment_secrets
  database=$(env_value "$environment" WEATHER_DATABASE_NAME)
  validate_database_name "$database"
  require_fixed_v14_migration_ledger "$environment" "$database"
  # preserve the actual consumed receipt when the SSH response was lost
  if consumed=$(setpriv --reuid=10002 --regid=10002 --clear-groups \
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evidence-store.mjs" shadow-metadata-custody-consumed-v1 "$proof"); then
    # null means that the current proof still needs its owner transaction
    if [[ "$consumed" != null ]]; then
      printf '%s\n' "$consumed"
      return
    fi
  fi
  preparation=$(setpriv --reuid=10002 --regid=10002 --clear-groups \
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" shadow-metadata-preparation-identity-v1 "$proof")
  # persist native manifest and successor arguments before deleting any hot row
  if [[ "$preparation" == unprepared ]]; then
    # shellcheck disable=SC2016
    setpriv --reuid=10002 --regid=10002 --clear-groups \
      node --max-old-space-size=48 --max-semi-space-size=1 \
        "$deploy_dir/scripts/adjustment-evaluation-package.mjs" shadow-metadata-preparation-sql-v1 "$proof" | \
      WEATHER_ENV_FILE=$environment compose exec -T postgres \
        sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_owner_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --host 127.0.0.1 --username weather_owner --dbname "$1"' \
        adjustment-shadow-metadata "$database" | \
      setpriv --reuid=10002 --regid=10002 --clear-groups \
        node --max-old-space-size=48 --max-semi-space-size=1 \
          "$deploy_dir/scripts/adjustment-evaluation-package.mjs" prepare-shadow-metadata-custody-v1 "$proof" >/dev/null
    preparation=$(setpriv --reuid=10002 --regid=10002 --clear-groups \
      node --max-old-space-size=48 --max-semi-space-size=1 \
        "$deploy_dir/scripts/adjustment-evaluation-package.mjs" shadow-metadata-preparation-identity-v1 "$proof")
  fi
  [[ "$preparation" =~ ^[a-f0-9]{64}$ ]] || die "shadow metadata custody preparation is unavailable"
  # the native function verifies the exact prepared generation or its byte-identical retry
  # shellcheck disable=SC2016
  setpriv --reuid=10002 --regid=10002 --clear-groups \
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" shadow-metadata-finalization-sql-v1 "$preparation" | \
    WEATHER_ENV_FILE=$environment compose exec -T postgres \
      sh -eu -c 'PGPASSWORD=$(cat /run/secrets/weather_owner_password); export PGPASSWORD; exec psql --no-password --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 --host 127.0.0.1 --username weather_owner --dbname "$1"' \
      adjustment-shadow-metadata "$database" | \
    setpriv --reuid=10002 --regid=10002 --clear-groups \
      node --max-old-space-size=48 --max-semi-space-size=1 \
        "$deploy_dir/scripts/adjustment-evaluation-package.mjs" consume-shadow-metadata-custody-v1 "$preparation"
)

# require one caller-created private publication inode
require_fixed_v13_authorization_target() {
  local path=$1
  local owner mode links size
  require_canonical_descendant "$path" "$releases_dir" "migration authorization"
  require_file "$path"
  [[ -f "$path" && ! -L "$path" ]] ||
    die "fixed v13 source compatibility authorization must be a regular file"
  read -r owner mode links size < <(stat --format='%u %a %h %s' "$path")
  [[ "$owner" == "$EUID" && "$mode" == 600 && "$links" == 1 && "$size" == 0 ]] ||
    die "fixed v13 source compatibility authorization must be a private empty single-link file"
}

# retain the exact immutable v13 bridge contract
verify_fixed_v13_source_compatibility() {
  verify_bounded_maintenance_source_compatibility "$1" "$2" "$3" v13
}

# prove the published compatibility bridge only for its full v14 successor
verify_fixed_v14_source_compatibility() {
  verify_bounded_maintenance_source_compatibility "$1" "$2" "$3" v14
}

# share the bounded fixture without widening either source identity
verify_bounded_maintenance_source_compatibility() (
  local target_env=$1
  local source_env=$2
  local authorization_path=$3
  local scope=$4
  local candidate api_container unproven_api_container provider_container
  local provider_image provider_network source_release target_release history_sha256
  local compatibility_compose_override=
  local ledger_state non_compatibility_source_ids compatibility_source_count
  local before_successes after_successes before_forecasts after_forecasts
  local start_free_bytes start_free_inodes start_wal_lsn
  local wal_bytes current_free_bytes current_free_inodes unproven_status
  local fixture_budget_bytes=$((64 * 1024 * 1024))
  local fixture_budget_inodes=4096
  local peak_fixture_bytes=0
  local peak_filesystem_bytes=0
  local peak_filesystem_inodes=0
  local candidate_created=false
  local api_started=false
  local unproven_api_started=false
  local provider_started=false
  [[ "$scope" == v13 || "$scope" == v14 ]] || die "unsupported bounded maintenance compatibility scope"
  candidate="weather_${scope}_compat_$(date -u +%Y%m%d%H%M%S)_$$"
  api_container="${candidate}_api"
  unproven_api_container="${candidate}_api_unproven"
  provider_container="${candidate}_provider"
  provider_image=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  provider_network="${WEATHER_COMPOSE_PROJECT_NAME:-weather}_provider_egress"
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  target_release=$(env_value "$target_env" WEATHER_RELEASE)

  validate_release_env "$source_env" "$source_release"
  validate_release_env "$target_env" "$target_release"
  # enforce the corresponding fixed source instead of a caller-selected predecessor
  if [[ "$scope" == v13 ]]; then
    require_fixed_v13_source_identity "$target_env" "$source_env"
  else
    require_fixed_v14_source_identity "$target_env" "$source_env"
  fi
  require_fixed_v13_authorization_target "$authorization_path"
  # strip unavailable future authority only from v14 source runtime probes
  if [[ "$scope" == v14 ]]; then
    compatibility_compose_override=$(mktemp \
      "$state_dir/.v14-compatibility-probe.XXXXXX.yaml")
    write_v14_compatibility_compose_override "$compatibility_compose_override"
    require_v14_compatibility_compose_override \
      "$source_env" "$compatibility_compose_override"
  fi

  # select the ordinary or pre-epoch compose view for source runtime probes
  source_compatibility_compose() {
    # keep the existing v13 fixture byte-for-byte unchanged
    if [[ "$scope" == v14 ]]; then
      v14_compatibility_compose "$source_env" "$compatibility_compose_override" "$@"
    else
      WEATHER_ENV_FILE=$source_env compose "$@"
    fi
  }

  # sample free filesystem capacity without prospective cleanup credit
  read -r start_free_bytes start_free_inodes < <(
    stat --file-system --format='%a %S %d' /var/lib/weather |
      awk '{ printf "%.0f %s\n", $1 * $2, $3 }'
  )
  [[ "$start_free_bytes" =~ ^[0-9]+$ && "$start_free_inodes" =~ ^[0-9]+$ ]] ||
    die "fixed v13 compatibility capacity sample is invalid"
  if ((start_free_bytes < image_pull_required_free_bytes + fixture_budget_bytes ||
    start_free_inodes < image_pull_required_free_inodes + fixture_budget_inodes)); then
    die "fixed v13 compatibility fixture lacks its bounded reservation"
  fi

  # clean every disposable bridge resource
  # shellcheck disable=SC2317,SC2329
  cleanup_fixed_v13_compatibility() {
    local status=$?

    # remove a started API probe
    if [[ "$api_started" == true ]]; then
      docker rm --force "$api_container" >/dev/null 2>&1 || status=1
    fi

    # remove a started rejection probe
    if [[ "$unproven_api_started" == true ]]; then
      docker rm --force "$unproven_api_container" >/dev/null 2>&1 || status=1
    fi

    # remove a started provider stub
    if [[ "$provider_started" == true ]]; then
      docker rm --force "$provider_container" >/dev/null 2>&1 || status=1
    fi

    # drop the isolated fixture last
    if [[ "$candidate_created" == true ]]; then
      WEATHER_ENV_FILE=$source_env compose exec -T postgres \
        dropdb --username postgres --if-exists "$candidate" >/dev/null || status=1
    fi

    # remove only this invocation's private pre-epoch override
    if [[ -n "$compatibility_compose_override" ]]; then
      rm -f -- "$compatibility_compose_override" || status=1
    fi

    trap - EXIT
    exit "$status"
  }
  trap cleanup_fixed_v13_compatibility EXIT
  trap 'exit 130' HUP INT TERM

  start_wal_lsn=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres \
      --dbname "$(env_value "$source_env" WEATHER_DATABASE_NAME)" \
      --tuples-only --no-align --command "SELECT pg_current_wal_lsn()")
  [[ "$start_wal_lsn" =~ ^[0-9A-F]+/[0-9A-F]+$ ]] ||
    die "fixed v13 compatibility WAL identity is invalid"

  # enforce the fixture ceiling after each bounded phase
  measure_fixed_v13_compatibility() {
    local phase=$1
    local database_name=${2:-}
    local fixture_sample=0
    local filesystem_sample filesystem_inode_sample

    # include the live fixture while it exists
    if [[ -n "$database_name" ]]; then
      fixture_sample=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
        psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$database_name" \
          --tuples-only --no-align --command "SELECT pg_database_size(current_database())")
    fi
    wal_bytes=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
      psql --set=ON_ERROR_STOP=1 --username postgres \
        --dbname "$(env_value "$source_env" WEATHER_DATABASE_NAME)" \
        --tuples-only --no-align --command "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '$start_wal_lsn'::pg_lsn)::bigint")
    read -r current_free_bytes current_free_inodes < <(
      stat --file-system --format='%a %S %d' /var/lib/weather |
        awk '{ printf "%.0f %s\n", $1 * $2, $3 }'
    )
    [[ "$fixture_sample" =~ ^[0-9]+$ && "$wal_bytes" =~ ^[0-9]+$ &&
      "$current_free_bytes" =~ ^[0-9]+$ && "$current_free_inodes" =~ ^[0-9]+$ ]] ||
      die "fixed v13 compatibility usage sample is invalid during $phase"
    filesystem_sample=$((start_free_bytes - current_free_bytes))
    filesystem_inode_sample=$((start_free_inodes - current_free_inodes))

    # ignore only capacity that another process returned
    if ((filesystem_sample < 0)); then
      filesystem_sample=0
    fi
    if ((filesystem_inode_sample < 0)); then
      filesystem_inode_sample=0
    fi

    # retain each observed high-water mark
    if ((fixture_sample > peak_fixture_bytes)); then
      peak_fixture_bytes=$fixture_sample
    fi
    if ((filesystem_sample > peak_filesystem_bytes)); then
      peak_filesystem_bytes=$filesystem_sample
    fi
    if ((filesystem_inode_sample > peak_filesystem_inodes)); then
      peak_filesystem_inodes=$filesystem_inode_sample
    fi

    # stop before the next phase when any measured envelope is exhausted
    if ((peak_fixture_bytes + wal_bytes > fixture_budget_bytes ||
      peak_filesystem_bytes > fixture_budget_bytes ||
      peak_filesystem_inodes > fixture_budget_inodes ||
      current_free_bytes < image_pull_required_free_bytes ||
      current_free_inodes < image_pull_required_free_inodes)); then
      die "fixed v13 compatibility fixture exceeded its bounded reservation during $phase"
    fi
  }

  printf 'Creating bounded fixed-v13 compatibility database %s...\n' "$candidate"
  WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    createdb --username postgres --owner weather_owner --template template0 "$candidate"
  candidate_created=true
  measure_fixed_v13_compatibility create "$candidate"

  # bootstrap only public target configuration into the empty fixture
  WEATHER_ENV_FILE=$target_env compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" migration
  apply_runtime_database_acl "$source_env" "$candidate"
  verify_runtime_database_acl "$source_env" "$candidate"
  history_sha256=$(migration_history_sha256 "$source_env" "$candidate")
  ledger_state=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --tuples-only --no-align --command "SELECT count(*)::text || ':' || count(*) FILTER (WHERE name = '0018_adjustment_maintenance_v2.sql')::text || ':' || COALESCE(max(checksum) FILTER (WHERE name = '0018_adjustment_maintenance_v2.sql'), '') FROM schema_migrations")
  # the historical bridge retains its exact eighteen-migration boundary
  if [[ "$scope" == v13 ]]; then
    [[ "$ledger_state" == "18:1:c13d2c2c39096887712ae97f0b863f8a7ab52074ca320575f8c4c1f9b72a50a3" ]] ||
      die "fixed v13 compatibility fixture lacks the exact complete 0018 ledger"
  else
    require_fixed_v14_migration_ledger "$source_env" "$candidate"
  fi
  measure_fixed_v13_compatibility schema "$candidate"

  non_compatibility_source_ids=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --tuples-only --no-align --command "SELECT COALESCE(string_agg(s.id::text, ',' ORDER BY s.id), '') FROM sources s JOIN providers p ON p.id = s.provider_id WHERE s.active AND p.provider_key <> 'open-meteo'")
  [[ -z "$non_compatibility_source_ids" ||
    "$non_compatibility_source_ids" =~ ^[0-9]+(,[0-9]+)*$ ]] ||
    die "fixed v13 non-compatibility source identity is invalid"
  compatibility_source_count=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --tuples-only --no-align --command "SELECT count(*) FROM sources s JOIN providers p ON p.id = s.provider_id WHERE s.active AND p.provider_key = 'open-meteo'")
  [[ "$compatibility_source_count" =~ ^[1-9][0-9]*$ ]] ||
    die "fixed v13 Open-Meteo compatibility source is missing"

  # isolate the exact source worker to the deterministic provider
  if [[ -n "$non_compatibility_source_ids" ]]; then
    WEATHER_ENV_FILE=$source_env compose exec -T postgres \
      psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
        --command "UPDATE sources SET active = false WHERE id IN ($non_compatibility_source_ids)"
  fi
  WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --command "UPDATE ingestion_checkpoints SET last_committed_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'; UPDATE sources SET cadence_seconds = 60 WHERE active"
  measure_fixed_v13_compatibility configuration "$candidate"

  docker run --detach --rm --name "$provider_container" \
    --network "$provider_network" --network-alias "$provider_container" \
    --env WEATHER_COMPATIBILITY_DYNAMIC_FORECAST=1 \
    "$provider_image" node deploy/scripts/compatibility-provider.mjs >/dev/null
  provider_started=true

  # wait for the deterministic provider
  for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
    # stop after its first successful readiness response
    if docker exec "$provider_container" node -e \
      "fetch('http://127.0.0.1:3002/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
      break
    fi
    sleep 1
  done
  ((_attempt < 30)) || die "fixed v13 compatibility provider did not become ready"

  before_successes=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM ingestion_runs WHERE state = 'succeeded'")
  before_forecasts=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM weather_records wr JOIN sources s ON s.id = wr.source_id WHERE s.source_key = 'open-meteo-forecast-v4'")
  source_compatibility_compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    --env WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$source_release" \
    --env WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256="$history_sha256" \
    --env WEATHER_OPEN_METEO_COMPATIBILITY_ORIGIN="http://$provider_container:3002" \
    worker node apps/worker/dist/worker.js --once
  after_successes=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM ingestion_runs WHERE state = 'succeeded'")
  after_forecasts=$(WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM weather_records wr JOIN sources s ON s.id = wr.source_id WHERE s.source_key = 'open-meteo-forecast-v4'")
  [[ "$before_successes" =~ ^[0-9]+$ && "$after_successes" =~ ^[0-9]+$ &&
    "$before_forecasts" =~ ^[0-9]+$ && "$after_forecasts" =~ ^[0-9]+$ ]] ||
    die "fixed v13 source worker returned an invalid proof count"
  if ((after_successes <= before_successes || after_forecasts <= before_forecasts)); then
    die "fixed v13 source worker did not persist the deterministic forecast"
  fi
  measure_fixed_v13_compatibility worker "$candidate"

  # require the source worker to reject the unproven trailing ledger
  if source_compatibility_compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    worker node apps/worker/dist/health.js >/dev/null 2>&1; then
    die "fixed v13 source worker accepted unproven migration history"
  fi

  source_compatibility_compose run --detach \
    --name "$unproven_api_container" --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    --env WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$source_release" \
    --env WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256="$(printf '%064d' 0)" \
    api node apps/api/dist/main.js >/dev/null
  unproven_api_started=true

  # require the source API to reject a wrong ledger digest
  for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
    # inspect the first reachable response
    if unproven_status=$(docker exec "$unproven_api_container" node -e \
      "fetch('http://127.0.0.1:3001/api/v1/health').then(r=>console.log(r.status)).catch(()=>process.exit(1))" 2>/dev/null); then
      [[ "$unproven_status" == 503 ]] ||
        die "fixed v13 source API accepted invalid migration authorization"
      break
    fi
    sleep 1
  done
  ((_attempt < 30)) || die "fixed v13 source API did not reject invalid authorization"
  docker rm --force "$unproven_api_container" >/dev/null
  unproven_api_started=false
  measure_fixed_v13_compatibility rejection "$candidate"

  source_compatibility_compose run --detach \
    --name "$api_container" --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    --env WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$source_release" \
    --env WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256="$history_sha256" \
    api node apps/api/dist/main.js >/dev/null
  api_started=true

  # wait for every exact-source API read contract
  for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
    # accept only complete target-ledger reads
    if docker exec "$api_container" node -e \
      "const origin='http://127.0.0.1:3001';Promise.all([fetch(origin+'/api/v1/health'),fetch(origin+'/api/v1/sites')]).then(async([health,sites])=>{if(!health.ok||!sites.ok)process.exit(1);const healthBody=await health.json();const sitesBody=await sites.json();const site=sitesBody.data?.[0]?.slug;if(healthBody.data?.ready!==true||healthBody.data?.version!=='$source_release'||typeof site!=='string')process.exit(1);const path=origin+'/api/v1/sites/'+encodeURIComponent(site);const [current,history,forecast]=await Promise.all([fetch(path+'/current'),fetch(path+'/history?limit=1'),fetch(path+'/forecast')]);if(!current.ok||!history.ok||!forecast.ok)process.exit(1);const bodies=await Promise.all([current.json(),history.json(),forecast.json()]);if(bodies.some(body=>!Array.isArray(body.data))||bodies[2].data.length===0)process.exit(1)}).catch(()=>process.exit(1))"; then
      break
    fi
    sleep 1
  done
  ((_attempt < 30)) || die "fixed v13 source API compatibility failed"
  measure_fixed_v13_compatibility api "$candidate"

  # include teardown WAL before authorizing the active migration
  docker rm --force "$api_container" >/dev/null
  api_started=false
  docker rm --force "$provider_container" >/dev/null
  provider_started=false
  WEATHER_ENV_FILE=$source_env compose exec -T postgres \
    dropdb --username postgres "$candidate" >/dev/null
  candidate_created=false
  measure_fixed_v13_compatibility teardown

  # publish only the target-bound proof payload after every source check
  write_migration_authorization \
    "$authorization_path" "$source_release" "$target_release" "$history_sha256"
)

# run previous-image checks on a disposable migrated clone
verify_previous_image_compatibility() (
  local target_env=$1
  local previous_env=$2
  local authorization_path=$3
  local candidate api_container unproven_api_container provider_container provider_image
  local active_database provider_network previous_release target_release history_sha256
  local previous_history_sha256
  local invalid_history_sha256 unproven_status
  local non_compatibility_source_ids compatibility_source_count
  local anchor_migration_count export_migration_count runtime_provenance_migration_count
  local live_visibility_migration_count temperature_canary_migration_count rain_collection_migration_count station_access_migration_count rain_adjustment_migration_count adjustment_export_migration_count adjustment_maintenance_migration_count baseline_acl_verified
  local baseline_schema_state
  local migrations_changed=false
  local candidate_created=false
  local api_started=false
  local unproven_api_started=false
  local provider_started=false
  local before_successes after_successes
  local before_v4_records=0 after_v4_records=0
  candidate="weather_compat_$(date -u +%Y%m%d%H%M%S)_$$"
  api_container="${candidate}_api"
  unproven_api_container="${candidate}_api_unproven"
  provider_container="${candidate}_provider"
  provider_image=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  active_database=$(env_value "$previous_env" WEATHER_DATABASE_NAME)
  previous_release=$(env_value "$previous_env" WEATHER_RELEASE)
  target_release=$(env_value "$target_env" WEATHER_RELEASE)
  invalid_history_sha256=$(printf '%064d' 0)
  provider_network="${WEATHER_COMPOSE_PROJECT_NAME:-weather}_provider_egress"

  # clean every disposable compatibility resource
  # shellcheck disable=SC2317,SC2329
  cleanup_compatibility() {
    local status=$?

    # remove a started API probe
    if [[ "$api_started" == true ]]; then
      docker rm --force "$api_container" >/dev/null 2>&1 || status=1
    fi

    # remove a started rejection probe
    if [[ "$unproven_api_started" == true ]]; then
      docker rm --force "$unproven_api_container" >/dev/null 2>&1 || status=1
    fi

    # remove a started provider stub
    if [[ "$provider_started" == true ]]; then
      docker rm --force "$provider_container" >/dev/null 2>&1 || status=1
    fi

    # drop a created candidate last
    if [[ "$candidate_created" == true ]]; then
      WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
        dropdb --username postgres --if-exists "$candidate" >/dev/null || status=1
    fi

    trap - EXIT
    exit "$status"
  }
  trap cleanup_compatibility EXIT
  trap 'exit 130' HUP INT TERM

  printf 'Creating disposable compatibility database %s...\n' "$candidate"
  WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    createdb --username postgres --owner weather_owner "$candidate"
  candidate_created=true

  WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    pg_dump --username weather_owner --dbname "$active_database" \
      --format=custom --no-owner |
    WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      pg_restore --username postgres --dbname "$candidate" \
        --no-owner --role weather_owner --exit-on-error

  # restore the exact migration boundary shipped by the previous Git image
  WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --command "CREATE OR REPLACE FUNCTION weather_source_is_current(candidate_id bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$ SELECT NOT EXISTS (SELECT 1 FROM public.sources candidate JOIN public.sources successor ON successor.station_id = candidate.station_id AND successor.active AND successor.material_provider_config->>'supersedesSourceKey' = candidate.source_key WHERE candidate.id = candidate_id); \$function\$; DROP TABLE IF EXISTS adjustment_shadow_registration_windows_v3, adjustment_registration_horizons_v3, adjustment_registration_schedule_v3; DROP FUNCTION IF EXISTS adjustment_shadow_registration_slot_v3(text); DROP FUNCTION IF EXISTS weather_register_adjustment_shadow_v3(jsonb); DROP FUNCTION IF EXISTS weather_initialize_adjustment_registration_schedule_v3(jsonb); DROP FUNCTION IF EXISTS weather_guard_adjustment_registration_v3(); DROP FUNCTION IF EXISTS weather_reject_adjustment_registration_v3_mutation(); DROP TRIGGER IF EXISTS weather_records_clear_adjustment_revision_pointer_v1 ON weather_records; DROP TRIGGER IF EXISTS forecast_anchor_records_clear_adjustment_revision_pointer_v1 ON forecast_anchor_records; DROP TRIGGER IF EXISTS rain_adjustment_runs_immutable ON rain_adjustment_runs; DROP FUNCTION IF EXISTS weather_append_adjustment_shadow_v4(jsonb,text); DROP FUNCTION IF EXISTS adjustment_revision_frontier_v1(); DROP FUNCTION IF EXISTS adjustment_shadow_revision_admission_v1(text,text,text,integer); DROP FUNCTION IF EXISTS weather_clear_adjustment_revision_pointer_v1(); DROP FUNCTION IF EXISTS weather_issue_adjustment_revision_receipt_v1(text,text,text,text); DROP FUNCTION IF EXISTS weather_bind_weather_record_revisions_v1(jsonb); DROP FUNCTION IF EXISTS weather_bind_forecast_anchor_revisions_v1(jsonb); DROP FUNCTION IF EXISTS weather_guard_rain_adjustment_revision_v1(); DROP FUNCTION IF EXISTS weather_bind_rain_gate_revision_v1(jsonb); DROP FUNCTION IF EXISTS weather_bind_ecmwf_temperature_revision_v1(jsonb); DROP FUNCTION IF EXISTS adjustment_revision_serving_snapshot_v1(timestamptz,bigint); DROP FUNCTION IF EXISTS adjustment_weather_revision_admission_v1(jsonb); DROP FUNCTION IF EXISTS adjustment_forecast_anchor_revision_admission_v1(jsonb); DROP FUNCTION IF EXISTS adjustment_rain_gate_revision_admission_v1(jsonb); DROP FUNCTION IF EXISTS adjustment_ecmwf_temperature_revision_admission_v1(jsonb); DROP FUNCTION IF EXISTS weather_mark_adjustment_revision_gap_v1(text,jsonb,jsonb); ALTER TABLE weather_records DROP COLUMN IF EXISTS adjustment_revision_receipt; ALTER TABLE forecast_anchor_records DROP COLUMN IF EXISTS adjustment_revision_receipt; ALTER TABLE rain_adjustment_runs DROP COLUMN IF EXISTS adjustment_revision_receipt; ALTER TABLE ecmwf_temperature_canary_runs DROP COLUMN IF EXISTS adjustment_revision_receipt; DROP FUNCTION IF EXISTS weather_adjustment_revision_receipt_valid_v1(jsonb); DROP TABLE IF EXISTS adjustment_revision_frontier_v1; DROP SEQUENCE IF EXISTS adjustment_revision_ordinal_v1; DROP TABLE IF EXISTS adjustment_shadow_terminal_results_v2; DROP FUNCTION IF EXISTS weather_guard_adjustment_shadow_terminal_result_v2(); DROP FUNCTION IF EXISTS weather_record_adjustment_shadow_terminal_result_v2(jsonb); DROP FUNCTION IF EXISTS weather_retire_adjustment_shadow_registration_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_shadow_v3(jsonb,text); DROP TABLE IF EXISTS adjustment_shadow_predictions_v2, adjustment_confirmation_accesses_v2, adjustment_shadow_registrations_v2; DROP FUNCTION IF EXISTS weather_guard_adjustment_shadow_registration_v2(); DROP FUNCTION IF EXISTS weather_guard_adjustment_shadow_prediction_v2(); DROP FUNCTION IF EXISTS weather_guard_adjustment_confirmation_access_v2(); DROP FUNCTION IF EXISTS weather_reject_adjustment_maintenance_mutation(); DROP FUNCTION IF EXISTS weather_register_adjustment_shadow_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_temperature_shadow_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_wind_shadow_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_rain_shadow_v2(jsonb); DROP FUNCTION IF EXISTS adjustment_shadow_body_admission_v2(text,text,text,integer); DROP FUNCTION IF EXISTS weather_finalize_adjustment_shadow_metadata_v2(jsonb); DROP FUNCTION IF EXISTS weather_record_adjustment_confirmation_access_v2(jsonb); DROP FUNCTION IF EXISTS adjustment_confirmation_availability_v2(text); DROP FUNCTION IF EXISTS adjustment_confirmation_export_v2(text,text,smallint); DROP VIEW IF EXISTS adjustment_evaluation_export_manifest_v1; DROP VIEW IF EXISTS adjustment_evaluation_export_rows_v1; DROP VIEW IF EXISTS rain_collection_status_v1; DROP TABLE IF EXISTS rain_adjustment_runs; DROP FUNCTION IF EXISTS weather_guard_rain_adjustment_run(); DROP TABLE IF EXISTS rain_capture_receipts; DROP TABLE IF EXISTS rain_capture_claims; DROP FUNCTION IF EXISTS weather_guard_rain_capture_claim(); DROP FUNCTION IF EXISTS weather_guard_rain_capture_receipt(); DROP FUNCTION IF EXISTS weather_reject_rain_capture_mutation(); DROP VIEW IF EXISTS forecast_runtime_provenance_v1; DROP VIEW IF EXISTS forecast_training_export_manifest_v1; DROP VIEW IF EXISTS forecast_training_export_rows_v1; DROP TABLE IF EXISTS ecmwf_temperature_canary_hours; DROP TABLE IF EXISTS ecmwf_temperature_canary_runs; DROP FUNCTION IF EXISTS weather_guard_ecmwf_temperature_canary_run_update(); DROP FUNCTION IF EXISTS weather_require_ecmwf_temperature_canary_hour_identity(); DROP FUNCTION IF EXISTS weather_reject_ecmwf_temperature_canary_hour_mutation(); DROP TABLE IF EXISTS forecast_anchor_records; DROP FUNCTION IF EXISTS weather_require_historical_forecast_anchor_source(); DROP FUNCTION IF EXISTS weather_guard_forecast_anchor_record_update(); GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC; REVOKE SELECT (capabilities) ON sources FROM weather_api; DELETE FROM schema_migrations WHERE name IN ('0009_forecast_anchor_records.sql', '0010_forecast_training_export.sql', '0011_forecast_runtime_provenance.sql', '0012_hide_archive_only_forecasts_from_live_reads.sql', '0013_ecmwf_temperature_canary.sql', '0014_rain_collection.sql', '0015_rain_station_access.sql', '0016_rain_adjustment.sql', '0017_adjustment_evaluation_export.sql', '0018_adjustment_maintenance_v2.sql', '0019_adjustment_maintenance_recurring.sql', '0020_adjustment_revision_frontier.sql', '0021_adjustment_rolling_registration.sql')"
  baseline_schema_state=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*)::text || ':' || COALESCE(to_regclass('forecast_anchor_records')::text, '') || ':' || COALESCE(to_regclass('forecast_training_export_rows_v1')::text, '') || ':' || COALESCE(to_regclass('ecmwf_temperature_canary_runs')::text, '') || ':' || COALESCE(to_regclass('ecmwf_temperature_canary_hours')::text, '') || ':' || COALESCE(to_regclass('rain_capture_claims')::text, '') || ':' || COALESCE(to_regclass('rain_capture_receipts')::text, '') || ':' || COALESCE(to_regclass('rain_collection_status_v1')::text, '') FROM schema_migrations")
  [[ "$baseline_schema_state" == "8:::::::" ]] ||
    die "previous compatibility database does not match the eight-migration Git baseline"

  previous_history_sha256=$(migration_history_sha256 "$previous_env" "$candidate")
  WEATHER_ENV_FILE=$target_env compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" migration
  history_sha256=$(migration_history_sha256 "$previous_env" "$candidate")

  # identify a real trailing migration compatibility run
  if [[ "$history_sha256" != "$previous_history_sha256" ]]; then
    migrations_changed=true
    anchor_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0009_forecast_anchor_records.sql'")
    [[ "$anchor_migration_count" == 1 ]] ||
      die "forecast anchor migration is missing from the compatibility database"
    export_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0010_forecast_training_export.sql'")
    [[ "$export_migration_count" == 1 ]] ||
      die "forecast training export migration is missing from the compatibility database"
    runtime_provenance_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0011_forecast_runtime_provenance.sql'")
    [[ "$runtime_provenance_migration_count" == 1 ]] ||
      die "forecast runtime provenance migration is missing from the compatibility database"
    live_visibility_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0012_hide_archive_only_forecasts_from_live_reads.sql'")
    [[ "$live_visibility_migration_count" == 1 ]] ||
      die "forecast live visibility migration is missing from the compatibility database"
    # require the isolated sidecar migration after rebuilding the baseline
    temperature_canary_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0013_ecmwf_temperature_canary.sql'")
    [[ "$temperature_canary_migration_count" == 1 ]] ||
      die "ECMWF temperature canary migration is missing from the compatibility database"
    # require rain collection after rebuilding the baseline
    rain_collection_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0014_rain_collection.sql'")
    [[ "$rain_collection_migration_count" == 1 ]] ||
      die "rain collection migration is missing from the compatibility database"
    # require the station access guard after rebuilding the baseline
    station_access_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0015_rain_station_access.sql'")
    [[ "$station_access_migration_count" == 1 ]] ||
      die "rain station access migration is missing from the compatibility database"
    # require the retained bounded rain projection after rebuilding the baseline
    rain_adjustment_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0016_rain_adjustment.sql'")
    [[ "$rain_adjustment_migration_count" == 1 ]] ||
      die "rain adjustment migration is missing from the compatibility database"
    # require the private adjustment evaluation export after rebuilding the baseline
    adjustment_export_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0017_adjustment_evaluation_export.sql'")
    [[ "$adjustment_export_migration_count" == 1 ]] ||
      die "adjustment evaluation export migration is missing from the compatibility database"
    # require the closed maintenance schema after rebuilding the baseline
    adjustment_maintenance_migration_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM schema_migrations WHERE name = '0018_adjustment_maintenance_v2.sql'")
    [[ "$adjustment_maintenance_migration_count" == 1 ]] ||
      die "adjustment maintenance migration is missing from the compatibility database"
  fi

  non_compatibility_source_ids=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT COALESCE(string_agg(s.id::text, ',' ORDER BY s.id), '') FROM sources s JOIN providers p ON p.id = s.provider_id WHERE s.active AND p.provider_key <> 'open-meteo'")
  [[ -z "$non_compatibility_source_ids" ||
    "$non_compatibility_source_ids" =~ ^[0-9]+(,[0-9]+)*$ ]] ||
    die "non-compatibility source identity is invalid"
  compatibility_source_count=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM sources s JOIN providers p ON p.id = s.provider_id WHERE s.active AND p.provider_key = 'open-meteo'")
  [[ "$compatibility_source_count" =~ ^[1-9][0-9]*$ ]] ||
    die "Open-Meteo compatibility source is missing"
  # apply the ACL version matching the candidate schema
  if [[ "$migrations_changed" == true ]]; then
    apply_runtime_database_acl "$previous_env" "$candidate"
    verify_runtime_database_acl "$previous_env" "$candidate"
  else
    WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
        <"$deploy_dir/postgres/runtime-acl-v1.sql"
    baseline_acl_verified=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
        --tuples-only --no-align --command "SELECT has_table_privilege('weather_api', 'sites', 'SELECT') AND NOT has_column_privilege('weather_api', 'sources', 'capabilities', 'SELECT') AND has_table_privilege('weather_ingest', 'weather_records', 'INSERT') AND to_regclass('forecast_anchor_records') IS NULL")
    [[ "$baseline_acl_verified" == t ]] ||
      die "previous runtime ACL verification failed"
  fi
  WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --command "UPDATE ingestion_checkpoints SET last_committed_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'; UPDATE sources SET cadence_seconds = 60 WHERE active"

  # isolate the worker to the deterministic provider stub
  if [[ -n "$non_compatibility_source_ids" ]]; then
    WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
        --command "UPDATE sources SET active = false WHERE id IN ($non_compatibility_source_ids)"
  fi

  docker run --detach --rm --name "$provider_container" \
    --network "$provider_network" --network-alias "$provider_container" \
    --env WEATHER_COMPATIBILITY_DYNAMIC_FORECAST=1 \
    "$provider_image" node deploy/scripts/compatibility-provider.mjs >/dev/null
  provider_started=true

  # wait for the deterministic provider
  for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
    # stop after the first successful readiness response
    if docker exec "$provider_container" node -e \
      "fetch('http://127.0.0.1:3002/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"; then
      break
    fi
    sleep 1
  done
  ((_attempt < 30)) || die "compatibility provider did not become ready"

  before_successes=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM ingestion_runs WHERE state='succeeded'")

  # snapshot the legacy v4 product only for a migrated-schema proof
  if [[ "$migrations_changed" == true ]]; then
    before_v4_records=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM weather_records wr JOIN sources s ON s.id = wr.source_id WHERE s.source_key = 'open-meteo-forecast-v4'")
  fi

  WEATHER_ENV_FILE=$previous_env compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    --env WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$previous_release" \
    --env WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256="$history_sha256" \
    --env WEATHER_OPEN_METEO_COMPATIBILITY_ORIGIN="http://$provider_container:3002" \
    worker node apps/worker/dist/worker.js --once
  after_successes=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM ingestion_runs WHERE state='succeeded'")

  # require the previous worker to insert legacy v4 rows after migration
  if [[ "$migrations_changed" == true ]]; then
    after_v4_records=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT count(*) FROM weather_records wr JOIN sources s ON s.id = wr.source_id WHERE s.source_key = 'open-meteo-forecast-v4'")
    [[ "$before_v4_records" =~ ^[0-9]+$ && "$after_v4_records" =~ ^[0-9]+$ ]] ||
      die "previous worker returned an invalid legacy v4 row count"

    # require at least one newly persisted forecast row
    if (( after_v4_records <= before_v4_records )); then
      die "previous worker did not insert a legacy v4 forecast row after migration"
    fi
  fi

  # expose only the bounded persisted failure diagnosis
  if (( after_successes <= before_successes )); then
    WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --username postgres --dbname "$candidate" --tuples-only --no-align \
        --command "SELECT COALESCE(error_code, 'unknown') || ': ' || COALESCE(error_message, 'no detail') FROM ingestion_runs WHERE state = 'failed' ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1" >&2
    die "previous worker compatibility failed"
  fi

  # restore other providers for previous API reads
  if [[ -n "$non_compatibility_source_ids" ]]; then
    WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
      psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
        --command "UPDATE sources SET active = true WHERE id IN ($non_compatibility_source_ids)"
  fi

  # prove authorization only for trailing history
  if [[ "$migrations_changed" == true ]]; then
    # reuse the refreshed worker heartbeat
    if WEATHER_ENV_FILE=$previous_env compose run --rm --no-deps \
      --env WEATHER_DATABASE_NAME="$candidate" \
      worker node apps/worker/dist/health.js >/dev/null 2>&1; then
      die "previous worker accepted unproven migration history"
    fi

    WEATHER_ENV_FILE=$previous_env compose run --detach \
      --name "$unproven_api_container" --no-deps \
      --env WEATHER_DATABASE_NAME="$candidate" \
      --env WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$previous_release" \
      --env WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256="$invalid_history_sha256" \
      api node apps/api/dist/main.js >/dev/null
    unproven_api_started=true

    # require the previous API to reject a wrong digest
    for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
      # inspect the first reachable health response
      if unproven_status=$(docker exec "$unproven_api_container" node -e \
        "fetch('http://127.0.0.1:3001/api/v1/health').then(r=>console.log(r.status)).catch(()=>process.exit(1))" 2>/dev/null); then
        [[ "$unproven_status" == 503 ]] ||
          die "previous API accepted invalid migration authorization"
        break
      fi
      sleep 1
    done
    ((_attempt < 30)) || die "previous API did not reject invalid migration authorization"
    docker rm --force "$unproven_api_container" >/dev/null
    unproven_api_started=false
  fi

  WEATHER_ENV_FILE=$previous_env compose run --detach --name "$api_container" --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    --env WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$previous_release" \
    --env WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256="$history_sha256" \
    api node apps/api/dist/main.js >/dev/null
  api_started=true

  # wait for every previous API read contract
  for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
    # accept only complete read success
    if docker exec --env WEATHER_REQUIRE_FORECAST_READ="$migrations_changed" \
      "$api_container" node -e \
      "const origin='http://127.0.0.1:3001';Promise.all([fetch(origin+'/api/v1/health'),fetch(origin+'/api/v1/sites')]).then(async([health,sites])=>{if(!health.ok||!sites.ok)process.exit(1);const healthBody=await health.json();const sitesBody=await sites.json();const site=sitesBody.data?.[0]?.slug;if(healthBody.data?.ready!==true||healthBody.data?.version!=='$previous_release'||typeof site!=='string')process.exit(1);const sitePath=origin+'/api/v1/sites/'+encodeURIComponent(site);const [current,history,forecast]=await Promise.all([fetch(sitePath+'/current'),fetch(sitePath+'/history?limit=1'),fetch(sitePath+'/forecast')]);if(!current.ok||!history.ok||!forecast.ok)process.exit(1);const currentBody=await current.json();const historyBody=await history.json();const forecastBody=await forecast.json();if(!Array.isArray(currentBody.data)||!Array.isArray(historyBody.data)||!Array.isArray(forecastBody.data))process.exit(1);if(process.env.WEATHER_REQUIRE_FORECAST_READ==='true'&&forecastBody.data.length===0)process.exit(1)}).catch(()=>process.exit(1))"; then
      break
    fi
    sleep 1
  done

  ((_attempt < 30)) || die "previous API compatibility failed"

  # publish only after every real compatibility check
  write_migration_authorization \
    "$authorization_path" "$previous_release" "$target_release" "$history_sha256"
)

# reconcile retained PostgreSQL administrator authority
start_postgres() {
  local env_file=$1
  WEATHER_ENV_FILE=$env_file compose up -d --no-deps --force-recreate --wait postgres ||
    return 1
}

# provision the persistent Xweather usage ledger
prepare_xweather_usage_directory() {
  install -d -m 0750 -o 10002 -g 10002 /var/lib/weather/xweather
}

# run one restore body with absent or exact persisted migration authority
with_restore_migration_authorization() (
  local authorization_path=$1
  local runtime_release=$2
  local schema_release=$3
  shift 3
  unset WEATHER_MIGRATION_AUTHORIZATION_RELEASE
  unset WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256
  local WEATHER_MIGRATION_AUTHORIZATION_RELEASE
  local WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256

  # inject only a nonempty validated authorization identity
  if [[ -n "$authorization_path" ]]; then
    validate_migration_authorization \
      "$authorization_path" "$runtime_release" "$schema_release"
    WEATHER_MIGRATION_AUTHORIZATION_RELEASE=$runtime_release
    WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=$(env_value \
      "$authorization_path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)
    export WEATHER_MIGRATION_AUTHORIZATION_RELEASE
    export WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256
  fi
  "$@"
)

# restore the ordinary runtime after authorization isolation
restore_images_runtime() {
  local env_file=$1
  prepare_xweather_usage_directory || return 1
  start_postgres "$env_file" || return 1
  apply_runtime_database_acl \
    "$env_file" "$(env_value "$env_file" WEATHER_DATABASE_NAME)" || return 1
  verify_runtime_database_acl \
    "$env_file" "$(env_value "$env_file" WEATHER_DATABASE_NAME)" || return 1
  WEATHER_ENV_FILE=$env_file compose up -d --no-deps --wait \
    api worker web cloudflared || return 1
}

# restore one exact image set without migration
restore_images() (
  local env_file=$1
  local runtime_release=${2:-}
  local schema_release=${3:-}
  local restore_authorization_path

  # reject partial lifecycle identity
  if [[ -n "$runtime_release" || -n "$schema_release" ]]; then
    [[ -n "$runtime_release" && -n "$schema_release" ]] ||
      die "runtime and schema releases must be provided together"
  fi

  # inject only a validated older-release authorization
  if [[ -n "$runtime_release" && "$runtime_release" != "$schema_release" ]]; then
    restore_authorization_path=$(migration_authorization "$schema_release")
  fi
  with_restore_migration_authorization "${restore_authorization_path:-}" \
    "$runtime_release" "$schema_release" restore_images_runtime "$env_file"
)

# restore the pre-epoch bridge runtime after authorization isolation
restore_v14_compatibility_bridge_runtime() {
  local env_file=$1
  local schema_release=$2
  prepare_xweather_usage_directory || return 1
  start_postgres "$env_file" || return 1
  # apply only the already-authorized full-schema ACL
  if [[ "$schema_release" == "$full_v14_release" ]]; then
    apply_runtime_database_acl \
      "$env_file" "$(env_value "$env_file" WEATHER_DATABASE_NAME)" || return 1
    verify_runtime_database_acl \
      "$env_file" "$(env_value "$env_file" WEATHER_DATABASE_NAME)" || return 1
  fi
  start_v14_compatibility_bridge_runtime "$env_file"
}

# restore the bridge image without requiring future epoch or catalog files
restore_v14_compatibility_bridge_images() (
  local env_file=$1
  local runtime_release=$2
  local schema_release=$3
  local restore_authorization_path
  [[ "$runtime_release" == "$v14_compatibility_bridge_release" &&
    ( "$schema_release" == "$v14_compatibility_bridge_release" ||
      "$schema_release" == "$full_v14_release" ) ]] ||
    die "v14 compatibility bridge restoration tuple differs"

  # inject only the persisted full-schema authorization
  if [[ "$schema_release" == "$full_v14_release" ]]; then
    restore_authorization_path=$(migration_authorization "$full_v14_release")
  fi
  with_restore_migration_authorization "${restore_authorization_path:-}" \
    "$runtime_release" "$schema_release" restore_v14_compatibility_bridge_runtime \
    "$env_file" "$schema_release"
)

# start an exact release without compatibility state
start_exact_release() (
  local env_file=$1
  unset WEATHER_MIGRATION_AUTHORIZATION_RELEASE
  unset WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256
  prepare_xweather_usage_directory || return 1
  WEATHER_ENV_FILE=$env_file compose up -d --remove-orphans --wait || return 1
)

# require the inherited family command to retain the shared release lock
require_adjustment_family_release_lock() {
  local descriptor=${WEATHER_RELEASE_LOCK_FD:-}
  [[ "$descriptor" =~ ^[1-9][0-9]{0,2}$ && -e "/proc/self/fd/$descriptor" ]] ||
    die "adjustment family release lock is unavailable"
  [[ "$(stat -Lc '%d:%i' "/proc/self/fd/$descriptor")" == \
    "$(stat -c '%d:%i' "$adjustment_family_deploy_state")" ]] ||
    die "adjustment family release lock identity differs"
}

# create only an absent private transaction root
ensure_adjustment_family_private_state_root() {
  local root=$1

  # create only a genuinely absent leaf beneath the already trusted state directory
  if [[ ! -e "$root" && ! -L "$root" ]]; then
    install -d -o 0 -g 0 -m 0700 "$root"
  fi

  # refuse existing ownership or mode drift without repairing or adopting it
  [[ -d "$root" && ! -L "$root" &&
    "$(realpath -e "$root")" == "$root" &&
    "$(stat -c '%u:%g:%a' "$root")" == "0:0:700" ]] ||
    die "adjustment family transaction root is unsafe"
}

# verify the installed state roots match the fixed privileged paths
require_adjustment_family_fixed_roots() {
  local ancestor mode

  # reject linked, foreign or other-writable ancestors in the installed tree
  for ancestor in /opt /opt/weather /opt/weather/current /opt/weather/current/deploy \
    "$adjustment_family_deploy_state" "$adjustment_family_releases"; do
    [[ -d "$ancestor" && ! -L "$ancestor" && "$(realpath -e "$ancestor")" == "$ancestor" &&
      "$(stat -c '%u:%g' "$ancestor")" == "0:0" ]] ||
      die "adjustment family deployment ancestor is unsafe: $ancestor"
    mode=$(stat -c '%a' "$ancestor")
    (( (8#$mode & 0002) == 0 )) ||
      die "adjustment family deployment ancestor is other-writable: $ancestor"
  done
  [[ "$(stat -c '%a' "$adjustment_family_deploy_state")" == 775 &&
    "$(stat -c '%a' "$adjustment_family_releases")" == 775 ]] ||
    die "adjustment family deployment directory mode differs"
  [[ "$(stat -c '%d:%i' "$state_dir")" == \
    "$(stat -c '%d:%i' "$adjustment_family_deploy_state")" ]] ||
    die "adjustment family deployment state root differs"
  [[ "$(stat -c '%d:%i' "$releases_dir")" == \
    "$(stat -c '%d:%i' "$adjustment_family_releases")" ]] ||
    die "adjustment family release root differs"
  ensure_adjustment_family_private_state_root "$adjustment_family_state_root"
}

# compare the live release and exact operator settings before preparation work
require_adjustment_family_source_cas() {
  local expected_release=$1
  local expected_settings_sha256=$2
  local owner size
  [[ "$(read_release_state "$state_dir/current-release")" == "$expected_release" ]] ||
    die "adjustment family source release differs before preparation"
  [[ -f "$adjustment_family_settings" && ! -L "$adjustment_family_settings" &&
    "$(realpath -e "$adjustment_family_settings")" == "$adjustment_family_settings" &&
    "$(stat -c '%a:%h' "$adjustment_family_settings")" == "600:1" ]] ||
    die "adjustment family settings file is unsafe"
  owner=$(stat -c '%u:%g' "$adjustment_family_settings")
  [[ "$owner" == 0:0 || "$owner" == 10002:10002 ]] ||
    die "adjustment family settings owner differs"
  size=$(stat -c '%s' "$adjustment_family_settings")
  [[ "$size" =~ ^[1-9][0-9]{0,3}$ && "$size" -le 4096 ]] ||
    die "adjustment family settings size is invalid"
  [[ "$(sha256sum "$adjustment_family_settings" | awk '{print $1}')" == \
    "$expected_settings_sha256" ]] ||
    die "adjustment family settings changed before preparation"
}

# render one family release from exact current infrastructure settings
render_adjustment_family_release_env() {
  local release=$1
  local source_env=$2
  local target server_image web_image temporary key
  validate_release "$release"
  require_file "$source_env"
  target=$(release_env "$release")
  server_image=$(resolve_arm64_image "$weather_server_image_repository:$release")
  web_image=$(resolve_arm64_image "$weather_web_image_repository:$release")

  # reuse only an environment with exact resolved images and retained infrastructure
  if [[ -e "$target" || -L "$target" ]]; then
    validate_release_env "$target" "$release"
    [[ "$(env_value "$target" WEATHER_SERVER_IMAGE)" == "$server_image" &&
      "$(env_value "$target" WEATHER_WEB_IMAGE)" == "$web_image" ]] ||
      die "adjustment family release images differ"
    for key in POSTGRES_IMAGE CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR \
      WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH \
      WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH; do
      [[ "$(env_value "$target" "$key")" == "$(env_value "$source_env" "$key")" ]] ||
        die "adjustment family release infrastructure differs: $key"
    done
    printf '%s\n' "$target"
    return
  fi
  temporary=$(mktemp "$releases_dir/.${release}.XXXXXX.env.partial")
  trap 'rm -f -- "$temporary"' RETURN
  write_release_env "$source_env" "$temporary" "$release" "$server_image" "$web_image" \
    "$(env_value "$source_env" POSTGRES_IMAGE)" \
    "$(env_value "$source_env" CLOUDFLARED_IMAGE)"
  validate_release_env "$temporary" "$release"
  mv "$temporary" "$target"
  trap - RETURN
  printf '%s\n' "$target"
}

# prepare both immutable releases and one pre-pull literal capacity receipt
prepare_adjustment_family_release_pair() {
  local target_release=$1
  local compensating_release=$2
  local source_release=$3
  local family=$4
  local action_sha256=$5
  local source_env target_env compensating_env capacity temporary status image
  local -a images
  require_adjustment_family_fixed_roots
  source_env=$(release_env "$source_release")
  validate_release_env "$source_env" "$source_release"
  require_control_plane_compatibility "$source_env"
  target_env=$(render_adjustment_family_release_env "$target_release" "$source_env")
  compensating_env=$(render_adjustment_family_release_env "$compensating_release" "$source_env")
  capacity="$adjustment_family_state_root/capacity-sha256-${action_sha256}.json"
  temporary=$(mktemp "$adjustment_family_state_root/.capacity.XXXXXX.tmp")
  trap 'rm -f -- "$temporary"' RETURN
  status=0
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" family-release-capacity \
    "$action_sha256" "$family" "$source_release" \
    "$(env_value "$source_env" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$source_env" WEATHER_WEB_IMAGE)" \
    "$(env_value "$target_env" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$target_env" WEATHER_WEB_IMAGE)" \
    "$(env_value "$compensating_env" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$compensating_env" WEATHER_WEB_IMAGE)" >"$temporary" || status=$?
  chmod 600 "$temporary"

  # preserve the refusal receipt while denying every blocked pull
  if ((status != 0)); then
    cat "$temporary" >&2
    die "adjustment family release capacity is blocked"
  fi
  mv "$temporary" "$capacity"
  trap - RETURN
  mapfile -t images < <(printf '%s\n' \
    "$(env_value "$target_env" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$target_env" WEATHER_WEB_IMAGE)" \
    "$(env_value "$compensating_env" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$compensating_env" WEATHER_WEB_IMAGE)" | LC_ALL=C sort -u)

  # pull only the four literal application references covered by capacity
  for image in "${images[@]}"; do
    validate_image_reference "$image"
    docker image pull "$image" >/dev/null
  done
}

# publish one family-only release marker without touching schema state
record_adjustment_family_release_success() {
  local target=$1
  local baseline=$2
  write_private_state "$state_dir/previous-release" "$baseline"
  write_active_symlink "$target"
  write_private_state "$state_dir/current-release" "$target"
}

# switch only application images under the inherited family transaction lock
apply_adjustment_family_release_unlocked() {
  local target=$1
  local expected_current=$2
  local alternate_current=$3
  local current target_env current_env key
  require_adjustment_family_release_lock
  current=$(read_release_state "$state_dir/current-release")

  # accept only an already committed exact-target retry
  if [[ "$current" == "$target" ]]; then
    target_env=$(release_env "$target")
    validate_release_env "$target_env" "$target"
    require_control_plane_compatibility "$target_env"
    [[ -L "$state_dir/active.env" &&
      "$(readlink "$state_dir/active.env")" == "../releases/$target.env" ]] ||
      die "adjustment family active release link differs"
    return
  fi
  [[ "$current" == "$expected_current" || "$current" == "$alternate_current" ]] ||
    die "adjustment family current release differs"
  target_env=$(release_env "$target")
  current_env=$(release_env "$current")
  validate_release_env "$target_env" "$target"
  validate_release_env "$current_env" "$current"
  require_control_plane_compatibility "$target_env"
  require_control_plane_compatibility "$current_env"

  # family releases retain every database, infrastructure and operator setting
  for key in POSTGRES_IMAGE CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR \
    WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH \
    WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH; do
    [[ "$(env_value "$target_env" "$key")" == "$(env_value "$current_env" "$key")" ]] ||
      die "adjustment family live infrastructure differs: $key"
  done
  require_deployment_secrets
  restore_images "$target_env" || die "adjustment family image switch failed"
  record_adjustment_family_release_success "$target" "$current"
}

# prepare one direct release without clone-based staging
prepare_yolo_release() {
  local release=$1
  local source_env=$2
  local target server_source web_source server_image web_image postgres_image
  local cloudflared_image temporary image
  local -a images
  target=$(release_env "$release")

  # reuse an exact previously rendered release
  if [[ -e "$target" || -L "$target" ]]; then
    validate_release_env "$target" "$release"
    require_control_plane_compatibility "$target"
    cleanup_obsolete_weather_images "$source_env" "$target"
    require_image_pull_capacity_floor
    require_v13_resource_gate
    require_literal_adjustment_release_capacity "$source_env" "$target"
    WEATHER_ENV_FILE=$target compose pull >&2
    require_literal_adjustment_release_capacity "$source_env" "$target"
    printf '%s\n' "$target"
    return
  fi

  server_source="$(image_repository "$(env_value "$source_env" WEATHER_SERVER_IMAGE)"):$release"
  web_source="$(image_repository "$(env_value "$source_env" WEATHER_WEB_IMAGE)"):$release"
  server_image=$(resolve_arm64_image "$server_source")
  web_image=$(resolve_arm64_image "$web_source")
  postgres_image=$(resolve_arm64_image "$(env_value "$source_env" POSTGRES_IMAGE)")
  cloudflared_image=$(resolve_arm64_image "$(env_value "$source_env" CLOUDFLARED_IMAGE)")
  temporary=$(mktemp "$releases_dir/.${release}.XXXXXX.env.partial")

  # remove an interrupted render
  trap 'rm -f "$temporary"' EXIT
  write_release_env "$source_env" "$temporary" "$release" \
    "$server_image" "$web_image" "$postgres_image" "$cloudflared_image"
  WEATHER_ENV_FILE=$temporary compose config --quiet
  mapfile -t images < <(WEATHER_ENV_FILE=$temporary compose config --images | sort -u)
  ((${#images[@]} == 4)) || die "release must contain exactly four images"

  # reject any tag-only rendered image
  for image in "${images[@]}"; do
    validate_image_reference "$image"
  done

  cleanup_obsolete_weather_images "$source_env" "$temporary"
  require_image_pull_capacity_floor
  require_v13_resource_gate
  require_literal_adjustment_release_capacity "$source_env" "$temporary"
  WEATHER_ENV_FILE=$temporary compose pull >&2
  require_literal_adjustment_release_capacity "$source_env" "$temporary"
  mv "$temporary" "$target"
  trap - EXIT
  printf '%s\n' "$target"
}

# apply one source-preserving direct release without deployment-time backup
yolo_release() (
  local release=$1
  local source_env=$2
  local target current current_env yolo_authorization_path temporary_authorization
  local actual_history expected_history source_history restored_history schema_after_restore key
  local previous_before=
  local previous_existed=false
  local active_mutation_started=false
  local completed=false
  current=$(read_optional_release_state "$state_dir/current-release")

  # restore the exact retained source after every active-database mutation failure
  # shellcheck disable=SC2317,SC2329
  restore_failed_yolo() {
    local status=$?
    local recovery_status=0
    trap - EXIT
    set +e

    # remove only an unpublished compatibility receipt
    if [[ -n "${temporary_authorization:-}" ]]; then
      rm -f -- "$temporary_authorization"
    fi

    # compensate only after the live database or service transaction began
    if [[ "$completed" != true && "$active_mutation_started" == true ]]; then
      printf 'Direct deployment failed; restoring Weather release %s...\n' \
        "$current" >&2
      if restore_images "$current_env" "$current" "$release"; then
        # reconcile durable state before the independent capacity diagnostic
        expected_history=$(env_value \
          "$yolo_authorization_path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256) ||
          recovery_status=1
        restored_history=$(migration_history_sha256 \
          "$current_env" "$(env_value "$current_env" WEATHER_DATABASE_NAME)") ||
          recovery_status=1
        schema_after_restore=

        # accept only one of the two pre-proven complete migration ledgers
        if [[ "$restored_history" == "$expected_history" ]]; then
          schema_after_restore=$release
        elif [[ "$restored_history" == "$source_history" ]]; then
          schema_after_restore=$current
        else
          recovery_status=1
        fi

        # publish a schema marker only for an exact recognized ledger
        if [[ -n "$schema_after_restore" ]]; then
          write_private_state "$state_dir/schema-release" "$schema_after_restore" ||
            recovery_status=1
        fi
        write_active_symlink "$current" || recovery_status=1
        write_private_state "$state_dir/current-release" "$current" || recovery_status=1

        # restore the pre-transaction rollback marker after a partial commit
        if [[ "$previous_existed" == true ]]; then
          write_private_state "$state_dir/previous-release" "$previous_before" ||
            recovery_status=1
        else
          rm -f -- "$state_dir/previous-release" || recovery_status=1
        fi

        # report compensation capacity only after source state is durable
        require_literal_adjustment_release_capacity "$source_env" "$target" ||
          recovery_status=1
      else
        recovery_status=1
      fi

      # never report an original or compensation failure as a successful release
      if ((recovery_status != 0)); then
        printf 'Direct deployment and exact source restoration both failed.\n' >&2
        exit 1
      fi
    fi
    exit "$status"
  }
  trap restore_failed_yolo EXIT

  # require one exact retained predecessor before rendering or pulling images
  [[ "$current" == "$maintenance_previous_release" ]] ||
    die "control plane v13 requires the exact retained source release"

  # freeze the rollback marker before record_release_success can replace it
  if [[ -e "$state_dir/previous-release" || -L "$state_dir/previous-release" ]]; then
    previous_before=$(read_release_state "$state_dir/previous-release")
    previous_existed=true
  fi
  current_env=$(release_env "$current")
  validate_release_env "$current_env" "$current"
  validate_release_env "$source_env" "$current"
  require_control_plane_compatibility "$current_env"
  require_control_plane_compatibility "$source_env"

  # prevent an explicit source file from changing any retained release setting
  for key in WEATHER_RELEASE WEATHER_SERVER_IMAGE WEATHER_WEB_IMAGE POSTGRES_IMAGE \
    CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR \
    WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH \
    WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH \
    WEATHER_CONTROL_PLANE_SHA256 WEATHER_CONTROL_PLANE_VERSION; do
    [[ "$(env_value "$source_env" "$key")" == "$(env_value "$current_env" "$key")" ]] ||
      die "direct deployment source differs from the retained release: $key"
  done

  target=$(prepare_yolo_release "$release" "$source_env")
  require_control_plane_compatibility "$target"
  require_deployment_secrets
  yolo_authorization_path=$(migration_authorization "$release")
  temporary_authorization=$(mktemp \
    "$releases_dir/.${release}.XXXXXX.migration-authorization.partial")
  verify_fixed_v13_source_compatibility \
    "$target" "$source_env" "$temporary_authorization"

  # reuse only byte-identical previously proven compatibility authorization
  if [[ -e "$yolo_authorization_path" || -L "$yolo_authorization_path" ]]; then
    validate_migration_authorization \
      "$yolo_authorization_path" "$current" "$release"
    cmp -s "$temporary_authorization" "$yolo_authorization_path" ||
      die "existing fixed v13 migration authorization differs"
    rm -f -- "$temporary_authorization"
    temporary_authorization=
  else
    publish_migration_authorization \
      "$temporary_authorization" "$yolo_authorization_path"
    temporary_authorization=
  fi

  # bind compensation to the exact complete source ledger observed before mutation
  source_history=$(migration_history_sha256 \
    "$current_env" "$(env_value "$current_env" WEATHER_DATABASE_NAME)")
  [[ "$source_history" =~ ^[a-f0-9]{64}$ ]] ||
    die "fixed v13 source migration ledger is invalid"

  # remeasure fresh resources and literal images at the last reversible boundary
  require_v13_resource_gate || die "fixed v13 resource gate failed before activation"
  require_literal_adjustment_release_capacity "$source_env" "$target" ||
    die "fixed v13 literal capacity failed before activation"

  printf 'Applying release %s directly...\n' "$release"
  active_mutation_started=true
  start_postgres "$target" || die "fixed v13 PostgreSQL restart failed"
  WEATHER_ENV_FILE=$target compose run --rm migration ||
    die "fixed v13 active migration failed"
  actual_history=$(migration_history_sha256 \
    "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)")
  expected_history=$(env_value \
    "$yolo_authorization_path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)
  [[ "$actual_history" == "$expected_history" ]] ||
    die "active migration ledger differs from fixed v13 compatibility proof"
  write_private_state "$state_dir/schema-release" "$release" ||
    die "fixed v13 schema marker publication failed"
  apply_runtime_database_acl "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)" ||
    die "fixed v13 runtime ACL application failed"
  verify_runtime_database_acl "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)" ||
    die "fixed v13 runtime ACL verification failed"
  start_exact_release "$target" || die "fixed v13 target release health failed"
  require_literal_adjustment_release_capacity "$source_env" "$target" ||
    die "fixed v13 idle literal capacity failed"
  record_release_success "$release" "$current" ||
    die "fixed v13 release state publication failed"
  completed=true
  trap - EXIT
  printf 'Release %s is active after direct deployment.\n' "$release"
)

# initialize only an exact empty root-owned catalog for the inactive code handoff
require_inert_v14_empty_catalog() {
  local catalog="$state_dir/adjustment-candidate-catalog.json"
  local owner group mode links
  require_adjustment_family_fixed_roots
  # atomically create the fixed read-only bind source without an application-owned directory
  if [[ ! -e "$catalog" && ! -L "$catalog" ]]; then
    local temporary
    temporary=$(mktemp "$state_dir/.adjustment-candidate-catalog.XXXXXX")
    printf '%s\n' '{"contractVersion":"adjustment-installed-candidate-catalog/v1","entries":[]}' >"$temporary"
    chmod 644 "$temporary"
    chown 0:0 "$temporary"
    sync -f "$temporary"
    ln "$temporary" "$catalog" || { rm -f -- "$temporary"; die "inactive v14 catalog publication collided"; }
    rm -f -- "$temporary"
    sync -f "$state_dir"
  fi
  [[ -f "$catalog" && ! -L "$catalog" ]] || die "inactive v14 catalog must be a regular file"
  read -r owner group mode links < <(stat --format='%u %g %a %h' "$catalog")
  [[ "$owner" == 0 && "$group" == 0 && "$mode" == 644 && "$links" == 1 ]] ||
    die "inactive v14 catalog ownership differs"
  cmp -s "$catalog" <(printf '%s\n' '{"contractVersion":"adjustment-installed-candidate-catalog/v1","entries":[]}') ||
    die "inactive v14 catalog is not the exact inert empty baseline"
}

# prepare only the fixed compatibility bridge without schema work
prepare_v14_compatibility_bridge_release() {
  local release=$1
  local source_env=$2
  local target server_source web_source server_image web_image postgres_image
  local cloudflared_image temporary image
  local -a images
  [[ "$release" == "$v14_compatibility_bridge_release" ]] ||
    die "v14 compatibility bridge release differs"
  target=$(release_env "$release")

  # reuse only the exact published bridge environment
  if [[ -e "$target" || -L "$target" ]]; then
    validate_release_env "$target" "$release"
    require_control_plane_compatibility "$target"
    require_v14_compatibility_bridge_release_pair "$target" "$source_env"
    cleanup_obsolete_weather_images "$source_env" "$target"
    require_image_pull_capacity_floor
    require_v13_resource_gate
    require_literal_inert_v14_release_capacity "$source_env" "$target"
    WEATHER_ENV_FILE=$target compose pull >&2
    require_literal_inert_v14_release_capacity "$source_env" "$target"
    printf '%s\n' "$target"
    return
  fi

  server_source="$(image_repository "$(env_value "$source_env" WEATHER_SERVER_IMAGE)"):$release"
  web_source="$(image_repository "$(env_value "$source_env" WEATHER_WEB_IMAGE)"):$release"
  server_image=$(resolve_arm64_image "$server_source")
  web_image=$(resolve_arm64_image "$web_source")
  postgres_image=$(resolve_arm64_image "$(env_value "$source_env" POSTGRES_IMAGE)")
  cloudflared_image=$(resolve_arm64_image "$(env_value "$source_env" CLOUDFLARED_IMAGE)")
  temporary=$(mktemp "$releases_dir/.${release}.XXXXXX.env.partial")

  # remove an interrupted render
  trap 'rm -f "$temporary"' EXIT
  write_release_env "$source_env" "$temporary" "$release" \
    "$server_image" "$web_image" "$postgres_image" "$cloudflared_image"
  require_v14_compatibility_bridge_release_pair "$temporary" "$source_env"
  WEATHER_ENV_FILE=$temporary compose config --quiet
  mapfile -t images < <(WEATHER_ENV_FILE=$temporary compose config --images | sort -u)
  ((${#images[@]} == 4)) || die "bridge release must contain exactly four images"

  # reject every tag-only image
  for image in "${images[@]}"; do
    validate_image_reference "$image"
  done

  cleanup_obsolete_weather_images "$source_env" "$temporary"
  require_image_pull_capacity_floor
  require_v13_resource_gate
  require_literal_inert_v14_release_capacity "$source_env" "$temporary"
  WEATHER_ENV_FILE=$temporary compose pull >&2
  require_literal_inert_v14_release_capacity "$source_env" "$temporary"
  mv "$temporary" "$target"
  trap - EXIT
  printf '%s\n' "$target"
}

# apply the compatibility-only bridge on the unchanged 0018 database
v14_compatibility_bridge_release() (
  local release=$1
  local source_env target current schema previous_before=absent
  local source_history actual_history bridge_settings_snapshot bridge_settings_inode
  local bridge_settings_sha256 git_proof bridge_target_commit committed=false
  local active_mutation_started=false
  local recovery_status=0

  # restore exact source-one state after every precommit mutation failure
  # shellcheck disable=SC2317,SC2329
  restore_failed_v14_compatibility_bridge() {
    local status=$?
    trap - EXIT
    # leave the successful current-marker commit as the final operation
    if [[ "$status" == 0 && "$committed" == true ]]; then
      exit 0
    fi
    set +e
    # compensate only after durable intent and runtime mutation
    if [[ "$active_mutation_started" == true ]]; then
      recover_v14_compatibility_bridge || recovery_status=1
    fi
    # never hide a failed source restoration
    if ((recovery_status != 0)); then
      printf 'V14 compatibility bridge and exact source restoration both failed.\n' >&2
      exit 1
    fi
    exit "$status"
  }
  trap restore_failed_v14_compatibility_bridge EXIT
  [[ "$release" == "$v14_compatibility_bridge_release" ]] ||
    die "v14 compatibility bridge release differs"

  # finish or compensate only the one durable prior attempt
  if [[ -e "$v14_compatibility_bridge_state" || -L "$v14_compatibility_bridge_state" ]]; then
    current=$(read_release_state "$state_dir/current-release")
    schema=$(read_optional_release_state "$state_dir/schema-release")
    case "$current:$schema" in
      "$recurring_previous_release:$recurring_previous_release"|\
      "$recurring_previous_release:$v14_compatibility_bridge_release")
        # compensate only the source-one bridge transaction
        active_mutation_started=true
        recover_v14_compatibility_bridge || die "interrupted v14 compatibility bridge recovery failed"
        active_mutation_started=false
        ;;
      "$v14_compatibility_bridge_release:$v14_compatibility_bridge_release")
        # preserve an already committed byte-identical bridge
        require_committed_v14_compatibility_bridge
        committed=true
        return 0
        ;;
      *)
        die "v14 compatibility bridge cannot rewind an advanced release state"
        ;;
    esac
  fi

  current=$(read_release_state "$state_dir/current-release")
  schema=$(read_release_state "$state_dir/schema-release")
  [[ "$current" == "$recurring_previous_release" &&
    "$schema" == "$recurring_previous_release" ]] ||
    die "v14 compatibility bridge requires exact source runtime and schema markers"
  require_v14_bridge_active_release "$recurring_previous_release"
  source_env=$(release_env "$recurring_previous_release")
  validate_release_env "$source_env" "$recurring_previous_release"
  require_control_plane_compatibility "$source_env"
  require_deployment_secrets
  # preserve the original rollback marker for compensation
  if [[ -e "$state_dir/previous-release" || -L "$state_dir/previous-release" ]]; then
    previous_before=$(read_release_state "$state_dir/previous-release")
  fi

  git_proof=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    verify-v14-compatibility-bridge-release "$release") ||
    die "v14 compatibility bridge exact-commit CI proof failed"
  bridge_target_commit=$(node --input-type=module -e '
const proof = JSON.parse(process.argv[1]);
// require the independently frozen bridge commit
if (proof.targetCommit !== process.argv[2]) throw new Error("bridge commit differs");
process.stdout.write(proof.targetCommit);
' "$git_proof" "$v14_compatibility_bridge_commit")
  [[ "$bridge_target_commit" == "$v14_compatibility_bridge_commit" ]] ||
    die "v14 compatibility bridge commit differs"
  target=$(prepare_v14_compatibility_bridge_release "$release" "$source_env")
  require_v14_compatibility_bridge_release_pair "$target" "$source_env"
  require_v14_compatibility_bridge_migration_ledger \
    "$source_env" "$(env_value "$source_env" WEATHER_DATABASE_NAME)"
  source_history=$(migration_history_sha256 \
    "$source_env" "$(env_value "$source_env" WEATHER_DATABASE_NAME)")
  [[ "$source_history" =~ ^[a-f0-9]{64}$ ]] ||
    die "v14 compatibility bridge source ledger hash is invalid"
  bridge_settings_snapshot=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    inert-v14-settings-snapshot)
  read -r bridge_settings_inode bridge_settings_sha256 <<<"$bridge_settings_snapshot"
  [[ "$bridge_settings_inode" =~ ^[0-9]+:[0-9]+$ &&
    "$bridge_settings_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "v14 compatibility bridge settings snapshot is invalid"

  # remeasure every admission gate immediately before mutation
  require_image_pull_capacity_floor
  require_v13_resource_gate
  require_literal_inert_v14_release_capacity "$source_env" "$target"
  publish_v14_compatibility_bridge_state "$source_env" "$target" "$source_history" \
    "$bridge_settings_inode" "$bridge_settings_sha256" "$previous_before"
  active_mutation_started=true
  start_v14_compatibility_bridge_runtime "$target" ||
    die "v14 compatibility bridge target health failed"

  # prove the database, settings, controls and capacity remained unchanged
  require_v14_compatibility_bridge_release_pair "$target" "$source_env"
  require_v14_compatibility_bridge_migration_ledger \
    "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)"
  actual_history=$(migration_history_sha256 \
    "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)")
  [[ "$actual_history" == "$source_history" ]] ||
    die "v14 compatibility bridge changed the 0018 ledger"
  [[ "$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      inert-v14-settings-snapshot)" == "$bridge_settings_snapshot" ]] ||
    die "v14 compatibility bridge settings changed"
  [[ "$(read_release_state "$state_dir/current-release")" == "$recurring_previous_release" &&
    "$(read_release_state "$state_dir/schema-release")" == "$recurring_previous_release" ]] ||
    die "v14 compatibility bridge source markers changed before commit"
  require_image_pull_capacity_floor
  require_v13_resource_gate
  require_literal_inert_v14_release_capacity "$source_env" "$target"

  # publish every reversible marker before the final current-release commit
  write_private_state "$state_dir/previous-release" "$recurring_previous_release"
  write_private_state "$state_dir/schema-release" "$release"
  write_active_symlink "$release"
  committed=true
  write_private_state "$state_dir/current-release" "$release"
)

# prepare one direct release without clone-based staging
prepare_inert_v14_release() {
  local release=$1
  local source_env=$2
  local target server_source web_source server_image web_image postgres_image
  local cloudflared_image temporary image
  local -a images
  target=$(release_env "$release")

  # reuse an exact previously rendered release
  if [[ -e "$target" || -L "$target" ]]; then
    validate_release_env "$target" "$release"
    require_control_plane_compatibility "$target"
    require_fixed_v14_source_identity "$target" "$source_env"
    cleanup_obsolete_weather_images "$source_env" "$target"
    require_image_pull_capacity_floor
    require_v13_resource_gate
    require_literal_full_v14_release_capacity "$source_env" "$target"
    WEATHER_ENV_FILE=$target compose pull >&2
    require_literal_full_v14_release_capacity "$source_env" "$target"
    printf '%s\n' "$target"
    return
  fi

  server_source="$(image_repository "$(env_value "$source_env" WEATHER_SERVER_IMAGE)"):$release"
  web_source="$(image_repository "$(env_value "$source_env" WEATHER_WEB_IMAGE)"):$release"
  server_image=$(resolve_arm64_image "$server_source")
  web_image=$(resolve_arm64_image "$web_source")
  postgres_image=$(resolve_arm64_image "$(env_value "$source_env" POSTGRES_IMAGE)")
  cloudflared_image=$(resolve_arm64_image "$(env_value "$source_env" CLOUDFLARED_IMAGE)")
  temporary=$(mktemp "$releases_dir/.${release}.XXXXXX.env.partial")

  # remove an interrupted render
  trap 'rm -f "$temporary"' EXIT
  write_release_env "$source_env" "$temporary" "$release" \
    "$server_image" "$web_image" "$postgres_image" "$cloudflared_image"
  require_fixed_v14_source_identity "$temporary" "$source_env"
  WEATHER_ENV_FILE=$temporary compose config --quiet
  mapfile -t images < <(WEATHER_ENV_FILE=$temporary compose config --images | sort -u)
  ((${#images[@]} == 4)) || die "release must contain exactly four images"

  # reject any tag-only rendered image
  for image in "${images[@]}"; do
    validate_image_reference "$image"
  done

  cleanup_obsolete_weather_images "$source_env" "$temporary"
  require_image_pull_capacity_floor
  require_v13_resource_gate
  require_literal_full_v14_release_capacity "$source_env" "$temporary"
  WEATHER_ENV_FILE=$temporary compose pull >&2
  require_literal_full_v14_release_capacity "$source_env" "$temporary"
  mv "$temporary" "$target"
  trap - EXIT
  printf '%s\n' "$target"
}

# apply one source-preserving direct release without deployment-time backup
inert_v14_release() (
  local release=$1
  local source_env=$2
  local target current v14_current_env inert_v14_authorization_path v14_temporary_authorization
  local actual_history expected_history v14_source_history restored_history schema_after_restore key
  local v14_starting_schema
  local git_proof target_commit catalog_sha256 settings_sha256 settings_inode
  local previous_before=
  local previous_existed=false
  local active_mutation_started=false
  local completed=false
  current=$(read_optional_release_state "$state_dir/current-release")

  # restore the exact retained source after every active-database mutation failure
  # shellcheck disable=SC2317,SC2329
  restore_failed_inert_v14() {
    local status=$?
    local recovery_status=0
    trap - EXIT
    set +e

    # remove only an unpublished compatibility receipt
    if [[ -n "${v14_temporary_authorization:-}" ]]; then
      rm -f -- "$v14_temporary_authorization"
    fi

    # compensate only after the live database or service transaction began
    if [[ "$completed" != true && "$active_mutation_started" == true ]]; then
      printf 'Direct deployment failed; restoring Weather release %s...\n' \
        "$current" >&2
      # observe the real schema before injecting source application authorization
      expected_history=$(env_value \
        "$inert_v14_authorization_path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256) ||
        recovery_status=1
      start_postgres "$v14_current_env" || recovery_status=1
      restored_history=$(migration_history_sha256 \
        "$v14_current_env" "$(env_value "$v14_current_env" WEATHER_DATABASE_NAME)") ||
        recovery_status=1
      schema_after_restore=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
        inert-v14-restoration-schema "$restored_history" "$v14_source_history" \
        "$current" "$v14_starting_schema" "$expected_history" "$release") || recovery_status=1
      if [[ "$recovery_status" == 0 ]] &&
        restore_v14_compatibility_bridge_images \
          "$v14_current_env" "$current" "$schema_after_restore"; then
        # remove only an exactly published actionless authority after source health is proven
        if [[ -n "${catalog_sha256:-}" && -n "${settings_sha256:-}" ]]; then
          node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" discard-failed-inert-v14-current \
            "$release" "$target_commit" "$(env_value "$target" WEATHER_SERVER_IMAGE)" \
            "$(env_value "$target" WEATHER_WEB_IMAGE)" "$catalog_sha256" "$settings_sha256" >/dev/null ||
            recovery_status=1
        fi
        # publish a schema marker only for an exact recognized ledger
        if [[ -n "$schema_after_restore" ]]; then
          write_private_state "$state_dir/schema-release" "$schema_after_restore" ||
            recovery_status=1
        fi
        write_active_symlink "$current" || recovery_status=1
        write_private_state "$state_dir/current-release" "$current" || recovery_status=1

        # restore the pre-transaction rollback marker after a partial commit
        if [[ "$previous_existed" == true ]]; then
          write_private_state "$state_dir/previous-release" "$previous_before" ||
            recovery_status=1
        else
          rm -f -- "$state_dir/previous-release" || recovery_status=1
        fi

        # report compensation capacity only after source state is durable
        require_literal_full_v14_release_capacity "$source_env" "$target" ||
          recovery_status=1
      else
        recovery_status=1
      fi

      # never report an original or compensation failure as a successful release
      if ((recovery_status != 0)); then
        printf 'Direct deployment and exact source restoration both failed.\n' >&2
        exit 1
      fi
    fi
    exit "$status"
  }
  trap restore_failed_inert_v14 EXIT

  # require one exact retained predecessor before rendering or pulling images
  [[ "$current" == "$v14_compatibility_bridge_release" ]] ||
    die "full v14 requires the exact committed compatibility bridge"
  require_v14_full_source_authority "$source_env"
  v14_starting_schema=$(read_release_state "$state_dir/schema-release")

  # freeze the rollback marker before record_release_success can replace it
  if [[ -e "$state_dir/previous-release" || -L "$state_dir/previous-release" ]]; then
    previous_before=$(read_release_state "$state_dir/previous-release")
    previous_existed=true
  fi
  v14_current_env=$(release_env "$current")
  validate_release_env "$v14_current_env" "$current"
  validate_release_env "$source_env" "$current"
  require_control_plane_compatibility "$v14_current_env"
  require_control_plane_compatibility "$source_env"

  # prevent an explicit source file from changing any retained release setting
  for key in WEATHER_RELEASE WEATHER_SERVER_IMAGE WEATHER_WEB_IMAGE POSTGRES_IMAGE \
    CLOUDFLARED_IMAGE WEATHER_DATABASE_NAME WEATHER_POSTGRES_DIR \
    WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH \
    WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH \
    WEATHER_CONTROL_PLANE_SHA256 WEATHER_CONTROL_PLANE_VERSION; do
    [[ "$(env_value "$source_env" "$key")" == "$(env_value "$v14_current_env" "$key")" ]] ||
      die "direct deployment source differs from the retained release: $key"
  done

  git_proof=$(node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" verify-full-v14-release "$release") ||
    die "full v14 exact-commit CI proof failed"
  target_commit=$(node --input-type=module -e '
const proof = JSON.parse(process.argv[1]);
// require the independently resolved literal commit
if (!/^[a-f0-9]{40}$/.test(proof.targetCommit)) throw new Error("invalid target commit");
process.stdout.write(proof.targetCommit);
' "$git_proof")
  target=$(prepare_inert_v14_release "$release" "$source_env")
  require_fixed_v14_source_identity "$target" "$source_env"
  require_inert_v14_empty_catalog
  require_control_plane_compatibility "$target"
  require_deployment_secrets
  inert_v14_authorization_path=$(migration_authorization "$release")
  # a compensated full-schema retry must reuse its exact durable authorization
  if [[ "$v14_starting_schema" == "$full_v14_release" ]]; then
    validate_migration_authorization \
      "$inert_v14_authorization_path" "$current" "$release"
  else
    v14_temporary_authorization=$(mktemp \
      "$releases_dir/.${release}.XXXXXX.migration-authorization.partial")
    verify_fixed_v14_source_compatibility \
      "$target" "$source_env" "$v14_temporary_authorization"

    # reuse only byte-identical previously proven compatibility authorization
    if [[ -e "$inert_v14_authorization_path" || -L "$inert_v14_authorization_path" ]]; then
      validate_migration_authorization \
        "$inert_v14_authorization_path" "$current" "$release"
      cmp -s "$v14_temporary_authorization" "$inert_v14_authorization_path" ||
        die "existing fixed v14 migration authorization differs"
      rm -f -- "$v14_temporary_authorization"
      v14_temporary_authorization=
    else
      publish_migration_authorization \
        "$v14_temporary_authorization" "$inert_v14_authorization_path"
      v14_temporary_authorization=
    fi
  fi

  # bind compensation to the exact complete source ledger observed before mutation
  v14_source_history=$(migration_history_sha256 \
    "$v14_current_env" "$(env_value "$v14_current_env" WEATHER_DATABASE_NAME)")
  [[ "$v14_source_history" =~ ^[a-f0-9]{64}$ ]] ||
    die "fixed v14 source migration ledger is invalid"

  # remeasure fresh resources and literal images at the last reversible boundary
  require_v13_resource_gate || die "fixed v14 resource gate failed before activation"
  require_literal_full_v14_release_capacity "$source_env" "$target" ||
    die "full v14 literal capacity failed before activation"

  printf 'Applying release %s directly...\n' "$release"
  active_mutation_started=true
  start_postgres "$target" || die "fixed v14 PostgreSQL restart failed"
  # keep the exact maintenance tail atomic for source-safe failure recovery
  WEATHER_ENV_FILE=$target compose run --rm migration \
    node deploy/scripts/migrate.mjs --atomic-maintenance-v14 ||
    die "fixed v14 active migration failed"
  actual_history=$(migration_history_sha256 \
    "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)")
  expected_history=$(env_value \
    "$inert_v14_authorization_path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)
  [[ "$actual_history" == "$expected_history" ]] ||
    die "active migration ledger differs from fixed v14 compatibility proof"
  write_private_state "$state_dir/schema-release" "$release" ||
    die "fixed v14 schema marker publication failed"
  apply_runtime_database_acl "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)" ||
    die "fixed v14 runtime ACL application failed"
  verify_runtime_database_acl "$target" "$(env_value "$target" WEATHER_DATABASE_NAME)" ||
    die "fixed v14 runtime ACL verification failed"
  # freeze the actual database capture epoch before any new producer can stage
  "$deploy_dir/scripts/adjustment-evaluation-export.sh" --revision-capture-epoch-init-v1 "$target" ||
    die "fixed v14 future-only epoch witness publication failed"
  # provision the isolated twelve-gauge target sources before any producer starts
  initialize_adjustment_rain_fixed_gauge_target_sources_v1 "$target" ||
    die "fixed v14 rain target source initialization failed"
  # freeze validated operator intent before the new writable web process starts
  read -r settings_inode settings_sha256 < <(
    node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" inert-v14-settings-snapshot
  )
  [[ "$settings_inode" =~ ^[0-9]+:[0-9]+$ && "$settings_sha256" =~ ^[a-f0-9]{64}$ ]] ||
    die "inactive v14 settings snapshot is unavailable"
  start_exact_release "$target" || die "fixed v14 target release health failed"
  require_literal_full_v14_release_capacity "$source_env" "$target" ||
    die "full v14 idle literal capacity failed"
  catalog_sha256=$(sha256sum "$state_dir/adjustment-candidate-catalog.json" | awk '{print $1}')
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    verify-inert-v14-settings-snapshot "$settings_inode" "$settings_sha256" ||
    die "inactive v14 operator settings changed before publication"
  node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" bootstrap-inert-v14-current \
    "$release" "$target_commit" "$(env_value "$target" WEATHER_SERVER_IMAGE)" \
    "$(env_value "$target" WEATHER_WEB_IMAGE)" "$catalog_sha256" "$settings_sha256" >/dev/null ||
    die "inactive v14 root source authority publication failed"
  # commit current only after every root source authority is durable
  record_release_success "$release" "$current" ||
    die "fixed v14 release state publication failed"
  completed=true
  trap - EXIT
  printf 'Release %s is active after direct deployment.\n' "$release"
)

# activate one forward release
start_release() (
  local target=$1
  local activation_env current current_env backup_env authorization_path schema_release
  local initial_started=false

  # clean a partially started first activation
  # shellcheck disable=SC2317,SC2329
  cleanup_initial_activation() {
    local status=$?

    # stop only this Weather project
    if [[ "$initial_started" == true ]]; then
      WEATHER_ENV_FILE=$activation_env compose down --remove-orphans >/dev/null 2>&1 || status=1
    fi

    trap - EXIT
    exit "$status"
  }
  activation_env=$(release_env "$target")
  validate_release_env "$activation_env" "$target"
  require_control_plane_compatibility "$activation_env"
  current=$(read_optional_release_state "$state_dir/current-release")
  schema_release=$(read_optional_release_state "$state_dir/schema-release")

  # default legacy state to the active release
  if [[ -n "$current" && -z "$schema_release" ]]; then
    schema_release=$current
  fi

  # reject stale retained targets
  if [[ "$current" != "$schema_release" && "$target" != "$schema_release" ]]; then
    die "cannot activate release $target while runtime release ${current:-unrecorded} differs from retained schema release $schema_release"
  fi

  require_capacity_gate
  require_deployment_secrets

  # establish the database used for the safety backup
  if [[ -n "$current" ]]; then
    current_env=$(release_env "$current")
    validate_release_env "$current_env" "$current"
    require_control_plane_compatibility "$current_env"
    backup_env=$current_env

    # require rollback proof before migration
    if [[ "$current" != "$target" ]]; then
      authorization_path=$(migration_authorization "$target")
      validate_migration_authorization "$authorization_path" "$current" "$target"
    fi
  else
    backup_env=$activation_env
    initial_started=true
  fi

  trap cleanup_initial_activation EXIT
  start_postgres "$backup_env"

  printf 'Creating pre-migration encrypted backup...\n'
  "$deploy_dir/scripts/backup.sh" --env-file "$backup_env" ||
    die "pre-migration backup failed"

  # record schema intent before the first migration
  write_private_state "$state_dir/schema-release" "$target"
  printf 'Applying candidate migrations...\n'
  WEATHER_ENV_FILE=$activation_env compose run --rm migration
  apply_runtime_database_acl \
    "$activation_env" "$(env_value "$activation_env" WEATHER_DATABASE_NAME)"
  verify_runtime_database_acl \
    "$activation_env" "$(env_value "$activation_env" WEATHER_DATABASE_NAME)"

  printf 'Starting release %s...\n' "$target"
  if ! start_exact_release "$activation_env"; then
    # restore only the prior exact image configuration
    if [[ -n "$current" && "$current" != "$target" ]]; then
      printf 'Activation failed; restoring Weather release %s...\n' "$current" >&2
      authorization_path=$(migration_authorization "$target")
      validate_migration_authorization "$authorization_path" "$current" "$target"
      restore_images "$current_env" "$current" "$target" ||
        die "activation and Weather image rollback both failed"
    fi
    die "release $target failed health checks"
  fi

  # record success only after every health gate
  record_release_success "$target" "$current"
  initial_started=false
  trap - EXIT
  printf 'Release %s is active.\n' "$target"
)

# roll back images without migration
rollback_release() {
  local current previous schema_release current_env previous_env
  current=$(read_release_state "$state_dir/current-release")
  previous=$(read_release_state "$state_dir/previous-release")
  [[ "$current" != "$previous" ]] || die "previous release matches the active release"
  current_env=$(release_env "$current")
  previous_env=$(release_env "$previous")
  validate_release_env "$current_env" "$current"
  validate_release_env "$previous_env" "$previous"
  require_control_plane_compatibility "$current_env"
  require_control_plane_compatibility "$previous_env"
  require_deployment_secrets
  schema_release=$(read_optional_release_state "$state_dir/schema-release")

  # default legacy state to the active release
  if [[ -z "$schema_release" ]]; then
    schema_release=$current
  fi

  # switch only immutable runtime images
  if ! restore_images "$previous_env" "$previous" "$schema_release"; then
    restore_images "$current_env" "$current" "$schema_release" ||
      die "rollback and current-image recovery both failed"
    die "rollback failed; current Weather images were restored"
  fi

  record_release_success "$previous" "$current"
  printf 'Release %s is active after migration-free rollback.\n' "$previous"
}

# dispatch one operator action
main() {
(($# >= 1)) || { usage >&2; exit 2; }
action=$1
shift

case "$action" in
  # expose no caller-selected family, source, cutoff or SQL on the owner reader
  adjustment-confirmation-access-burn-v3|adjustment-shadow-terminal-record-v3|adjustment-shadow-terminal-retire-v3|adjustment-shadow-unsupported-terminal-record-v1|adjustment-shadow-unsupported-terminal-retire-v1)
    [[ "$#" == 1 ]] || die "adjustment owner operation requires one request identity"
    # select the fixed operation without accepting a function or SQL identifier
    case "$action" in
      adjustment-confirmation-access-burn-v3) run_adjustment_owner_operation_v3 access "$1" ;;
      adjustment-shadow-terminal-record-v3) run_adjustment_owner_operation_v3 terminal "$1" ;;
      adjustment-shadow-terminal-retire-v3) run_adjustment_owner_operation_v3 retire "$1" ;;
      adjustment-shadow-unsupported-terminal-record-v1) run_adjustment_owner_operation_v3 unsupported-terminal "$1" ;;
      adjustment-shadow-unsupported-terminal-retire-v1) run_adjustment_owner_operation_v3 unsupported-retire "$1" ;;
    esac
    ;;

  adjustment-shadow-metadata-custody-finalize-v1)
    [[ "$#" == 1 ]] || die "shadow metadata custody finalization requires one identity"
    finalize_adjustment_shadow_metadata_custody_v1 "$1"
    ;;

  adjustment-registration-lifecycle-status-v4)
    (($# == 0)) || die "registration lifecycle status takes no arguments"
    read_adjustment_registration_lifecycle_status_v4
    ;;
  adjustment-rain-fixed-gauge-target-sources-initialize-v1)
    (($# == 0)) || die "rain target source initialization takes no arguments"
    initialize_current_adjustment_rain_fixed_gauge_target_sources_v1
    ;;
  # accept only the authenticated create-once schedule identity over bounded stdin
  adjustment-registration-schedule-initialize-v3)
    (($# == 1)) || die "registration schedule initialization requires one hash"
    initialize_adjustment_registration_schedule_v3 "$1"
    ;;
  adjustment-family-release)
    (($# == 9)) || die "adjustment-family-release requires exactly nine arguments"
    target_release=$1
    compensating_release=$2
    expected_current_release=$3
    expected_source_release=$4
    expected_settings_sha256=$5
    family=$6
    action_sha256=$7
    report_sha256=$8
    fence=$9
    validate_release "$target_release"
    validate_release "$compensating_release"
    validate_release "$expected_current_release"
    validate_release "$expected_source_release"
    [[ "$expected_settings_sha256" =~ ^[a-f0-9]{64}$ &&
      "$action_sha256" =~ ^[a-f0-9]{64}$ && "$report_sha256" =~ ^[a-f0-9]{64}$ ]] ||
      die "adjustment-family-release hashes are invalid"
    [[ "$family" == temperature || "$family" == wind || "$family" == rain ]] ||
      die "adjustment-family-release family is invalid"
    [[ "$fence" =~ ^[1-9][0-9]{0,19}$ ]] ||
      die "adjustment-family-release fence is invalid"
    # compare fixed-width decimal strings without signed integer overflow
    # shellcheck disable=SC2071
    [[ ${#fence} -lt 20 || "$fence" < 18446744073709551616 ]] ||
      die "adjustment-family-release fence overflows uint64"
    [[ "$expected_current_release" == "$expected_source_release" &&
      "$target_release" != "$compensating_release" &&
      "$target_release" != "$expected_current_release" &&
      "$compensating_release" != "$expected_current_release" ]] ||
      die "adjustment-family-release release identities conflict"
    acquire_release_transaction_lock
    require_adjustment_family_fixed_roots
    require_adjustment_family_source_cas \
      "$expected_source_release" "$expected_settings_sha256"
    export WEATHER_RELEASE_LOCK_FD=$release_transaction_lock_fd
    require_command docker
    require_command node
    prepare_adjustment_family_release_pair "$target_release" "$compensating_release" \
      "$expected_source_release" "$family" "$action_sha256"
    exec node "$deploy_dir/scripts/adjustment-evaluation-package.mjs" family-release "$@"
    ;;
  adjustment-family-apply-unlocked)
    (($# == 3)) || die "adjustment-family-apply-unlocked requires three releases"
    validate_release "$1"
    validate_release "$2"
    validate_release "$3"
    apply_adjustment_family_release_unlocked "$1" "$2" "$3"
    ;;
  v14-compatibility-bridge)
    (($# == 1)) || die "v14-compatibility-bridge requires one immutable release"
    [[ "$EUID" == 0 ]] || die "v14-compatibility-bridge requires root"
    validate_release "$1"
    acquire_release_transaction_lock
    require_command docker
    require_command node
    v14_compatibility_bridge_release "$1"
    ;;
  inert-v14)
    (($# == 1)) || die "inert-v14 requires one immutable release"
    validate_release "$1"
    acquire_release_transaction_lock
    require_adjustment_family_fixed_roots
    require_command docker
    require_command node
    source_env=$(release_env "$v14_compatibility_bridge_release")
    require_file "$source_env"
    inert_v14_release "$1" "$source_env"
    ;;
  yolo)
    (($# >= 1)) || die "yolo requires a release"
    release=$1
    shift
    validate_release "$release"
    acquire_release_transaction_lock
    source_env=$(retained_maintenance_source_env)

    # accept one explicit source environment
    if (($# > 0)); then
      [[ "$1" == --from && $# -eq 2 ]] || die "expected --from ENV_FILE"
      source_env=$2
    fi

    require_retained_maintenance_source "$source_env"
    require_file "$source_env"
    require_command docker
    require_command node
    yolo_release "$release" "$source_env"
    ;;
  stage)
    (($# >= 1)) || die "stage requires a release"
    release=$1
    shift
    validate_release "$release"
    acquire_release_transaction_lock
    source_env=$(retained_maintenance_source_env)

    # accept one explicit source environment
    if (($# > 0)); then
      [[ "$1" == --from && $# -eq 2 ]] || die "expected --from ENV_FILE"
      source_env=$2
    fi

    require_retained_maintenance_source "$source_env"
    require_file "$source_env"
    require_command docker
    require_command node
    current=$(read_optional_release_state "$state_dir/current-release")

    # gate the active control plane before any stage work
    if [[ -n "$current" ]]; then
      previous_env=$(release_env "$current")
      validate_release_env "$previous_env" "$current"
      require_control_plane_compatibility "$previous_env"
    fi

    require_capacity_gate
    mkdir -p "$releases_dir"
    target=$(release_env "$release")
    authorization=$(migration_authorization "$release")
    [[ ! -e "$target" && ! -L "$target" && ! -e "$authorization" && ! -L "$authorization" ]] ||
      die "release is already staged: $release"
    server_source="$(image_repository "$(env_value "$source_env" WEATHER_SERVER_IMAGE)"):$release"
    web_source="$(image_repository "$(env_value "$source_env" WEATHER_WEB_IMAGE)"):$release"
    server_image=$(resolve_arm64_image "$server_source")
    web_image=$(resolve_arm64_image "$web_source")
    postgres_image=$(resolve_arm64_image "$(env_value "$source_env" POSTGRES_IMAGE)")
    cloudflared_image=$(resolve_arm64_image "$(env_value "$source_env" CLOUDFLARED_IMAGE)")
    temporary=$(mktemp "$releases_dir/.${release}.XXXXXX.env.partial")
    temporary_authorization=
    published_authorization=

    # remove failed stage state
    trap 'rm -f "$temporary" ${temporary_authorization:+"$temporary_authorization"} ${published_authorization:+"$published_authorization"}' EXIT
    write_release_env "$source_env" "$temporary" "$release" \
      "$server_image" "$web_image" "$postgres_image" "$cloudflared_image"
    WEATHER_ENV_FILE=$temporary compose config --quiet
    mapfile -t images < <(WEATHER_ENV_FILE=$temporary compose config --images | sort -u)
    ((${#images[@]} == 4)) || die "release must contain exactly four images"

    # reject any tag-only rendered image
    for image in "${images[@]}"; do
      validate_image_reference "$image"
    done

    cleanup_obsolete_weather_images "$source_env" "$temporary"
    require_image_pull_capacity_floor
    WEATHER_ENV_FILE=$temporary compose pull

    # require previous-image compatibility for upgrades
    if [[ -n "$current" ]]; then
      require_deployment_secrets
      temporary_authorization=$(mktemp \
        "$releases_dir/.${release}.XXXXXX.migration-authorization.partial")
      verify_previous_image_compatibility \
        "$temporary" "$previous_env" "$temporary_authorization"
    else
      printf 'Initial release: previous-image compatibility is not applicable.\n'
    fi

    # publish authorization before the release commit marker
    if [[ -n "$temporary_authorization" ]]; then
      publish_migration_authorization "$temporary_authorization" "$authorization"
      published_authorization=$authorization
      temporary_authorization=
    fi

    # clean failed release publication
    if ! mv "$temporary" "$target"; then
      # remove orphaned authorization
      rm -f "$authorization"
      exit 1
    fi
    published_authorization=
    trap - EXIT
    printf 'Release %s staged without changing running services or the active database.\n' "$release"
    ;;
  activate)
    (($# == 1)) || die "activate requires exactly one release"
    validate_release "$1"
    require_command age
    require_command docker
    acquire_release_transaction_lock
    start_release "$1"
    ;;
  rollback)
    (($# == 0)) || die "rollback takes no arguments"
    require_command docker
    acquire_release_transaction_lock
    rollback_release
    ;;
  recover)
    (($# == 0)) || die "recover takes no arguments"
    acquire_release_transaction_lock
    require_command docker
    require_command node
    current=$(read_release_state "$state_dir/current-release")
    schema_release=$(read_optional_release_state "$state_dir/schema-release")
    v14_bridge_runtime_recovery=false
    v14_schema_marker_repair=false
    # classify the retained bridge receipt against exact runtime and schema markers
    if [[ -e "$v14_compatibility_bridge_state" || -L "$v14_compatibility_bridge_state" ]]; then
      case "$current:$schema_release" in
        "$recurring_previous_release:$recurring_previous_release"|\
        "$recurring_previous_release:$v14_compatibility_bridge_release")
          # only an uncommitted bridge may restore source-one images and markers
          recover_v14_compatibility_bridge ||
            die "interrupted v14 compatibility bridge recovery failed"
          return
          ;;
        "$v14_compatibility_bridge_release:$v14_compatibility_bridge_release")
          # distinguish pristine schema 18 from a full-migration pre-marker crash
          require_v14_compatibility_bridge_receipt
          current_env=$(release_env "$v14_compatibility_bridge_release")
          if [[ "$(migration_history_sha256 "$current_env" \
              "$(env_value "$current_env" WEATHER_DATABASE_NAME)")" == \
            "$(env_value "$v14_compatibility_bridge_state" WEATHER_V14_BRIDGE_SOURCE_HISTORY_SHA256)" ]]; then
            require_committed_v14_compatibility_bridge
          else
            require_v14_source2_full_schema_authority "$current_env"
            schema_release=$full_v14_release
            v14_schema_marker_repair=true
          fi
          v14_bridge_runtime_recovery=true
          ;;
        "$v14_compatibility_bridge_release:$full_v14_release")
          # restore source two only with exact full-schema authorization
          current_env=$(release_env "$v14_compatibility_bridge_release")
          require_v14_source2_full_schema_authority "$current_env"
          v14_bridge_runtime_recovery=true
          ;;
        "$full_v14_release:$full_v14_release")
          # restore the completed full release against its exact complete ledger
          require_v14_compatibility_bridge_receipt
          current_env=$(release_env "$full_v14_release")
          require_fixed_v14_migration_ledger \
            "$current_env" "$(env_value "$current_env" WEATHER_DATABASE_NAME)"
          require_full_v14_current_authority "$current_env"
          ;;
        *)
          die "v14 compatibility bridge recovery marker tuple is unsupported"
          ;;
      esac
    else
      # never recover a bridge or full runtime without its retained source authority
      if [[ "$current" == "$v14_compatibility_bridge_release" ||
        "$current" == "$full_v14_release" ||
        "$schema_release" == "$v14_compatibility_bridge_release" ||
        "$schema_release" == "$full_v14_release" ]]; then
        die "v14 recovery requires the retained compatibility bridge receipt"
      fi
    fi
    # default legacy state to the active release
    if [[ -z "$schema_release" ]]; then
      schema_release=$current
    fi

    current_env=$(release_env "$current")
    validate_release_env "$current_env" "$current"
    require_control_plane_compatibility "$current_env"
    require_deployment_secrets
    # keep source-two recovery independent of future-state bind files
    if [[ "$v14_bridge_runtime_recovery" == true ]]; then
      restore_v14_compatibility_bridge_images "$current_env" "$current" "$schema_release"
    else
      restore_images "$current_env" "$current" "$schema_release"
    fi
    # repair only a proven full-migration marker crash after source-two health
    if [[ "$v14_schema_marker_repair" == true ]]; then
      write_private_state "$state_dir/schema-release" "$full_v14_release"
    fi
    write_active_symlink "$current"
    ;;
  status)
    (($# == 0)) || die "status takes no arguments"
    exec "$deploy_dir/scripts/status.sh"
    ;;
  --help|-h)
    usage
    ;;
  *) die "unknown action: $action" ;;
esac
}

# run only from the release entrypoint
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
