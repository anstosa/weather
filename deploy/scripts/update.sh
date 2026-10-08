#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print release usage
usage() {
  cat <<'EOF'
Usage:
  update.sh yolo RELEASE [--from ENV_FILE]
  update.sh stage RELEASE [--from ENV_FILE]
  update.sh activate RELEASE
  update.sh rollback
  update.sh recover
  update.sh status

yolo resolves the exact ARM64 images, enforces the local pull floor, applies
migrations, and starts the release directly without the full coexistence gate,
compatibility clone, or deployment-time backup.
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
control_plane_version=13
maintenance_previous_release=2026.10.07-3
maintenance_previous_control_plane_sha256=16d871c7aebb3a34097af219fd5c76a93b3ff1be3af521643dbf3a4d2041c61d
legacy_control_plane_version=6
legacy_control_plane_sha256=c4d74581b84505e065fdec63447dfdded1d14221e459777a88e37729275f33b5
migration_authorization_version=1
image_pull_required_free_bytes=2034155520
image_pull_required_free_inodes=32768
image_cleanup_maximum_inventory_lines=4096
image_cleanup_maximum_containers=1024
weather_server_image_repository=ghcr.io/anstosa/weather-server
weather_web_image_repository=ghcr.io/anstosa/weather-web

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
  ln "$source" "$target" || die "migration authorization already exists or could not be published"
  rm -f "$source"
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
    "$target_version" == "$control_plane_version" ]] ||
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

  # accept only the complete pinned maintenance predecessor
  if [[ "$expected_version" == 12 &&
    "$expected_digest" == "$maintenance_previous_control_plane_sha256" ]]; then
    expected_release=$(env_value "$env_file" WEATHER_RELEASE)
    [[ "$expected_release" == "$maintenance_previous_release" ]] ||
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

# prove the exact source runtime against a small target-schema fixture
verify_fixed_v13_source_compatibility() (
  local target_env=$1
  local source_env=$2
  local authorization_path=$3
  local candidate api_container unproven_api_container provider_container
  local provider_image provider_network source_release target_release history_sha256
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
  candidate="weather_v13_compat_$(date -u +%Y%m%d%H%M%S)_$$"
  api_container="${candidate}_api"
  unproven_api_container="${candidate}_api_unproven"
  provider_container="${candidate}_provider"
  provider_image=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  provider_network="${WEATHER_COMPOSE_PROJECT_NAME:-weather}_provider_egress"
  source_release=$(env_value "$source_env" WEATHER_RELEASE)
  target_release=$(env_value "$target_env" WEATHER_RELEASE)

  validate_release_env "$source_env" "$source_release"
  validate_release_env "$target_env" "$target_release"
  require_fixed_v13_source_identity "$target_env" "$source_env"
  require_fixed_v13_authorization_target "$authorization_path"

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
  [[ "$ledger_state" == "18:1:c13d2c2c39096887712ae97f0b863f8a7ab52074ca320575f8c4c1f9b72a50a3" ]] ||
    die "fixed v13 compatibility fixture lacks the exact complete 0018 ledger"
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
  WEATHER_ENV_FILE=$source_env compose run --rm --no-deps \
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
  if WEATHER_ENV_FILE=$source_env compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    worker node apps/worker/dist/health.js >/dev/null 2>&1; then
    die "fixed v13 source worker accepted unproven migration history"
  fi

  WEATHER_ENV_FILE=$source_env compose run --detach \
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

  WEATHER_ENV_FILE=$source_env compose run --detach \
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
      --command "CREATE OR REPLACE FUNCTION weather_source_is_current(candidate_id bigint) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS \$function\$ SELECT NOT EXISTS (SELECT 1 FROM public.sources candidate JOIN public.sources successor ON successor.station_id = candidate.station_id AND successor.active AND successor.material_provider_config->>'supersedesSourceKey' = candidate.source_key WHERE candidate.id = candidate_id); \$function\$; DROP TABLE IF EXISTS adjustment_shadow_predictions_v2, adjustment_confirmation_accesses_v2, adjustment_shadow_registrations_v2; DROP FUNCTION IF EXISTS weather_guard_adjustment_shadow_registration_v2(); DROP FUNCTION IF EXISTS weather_guard_adjustment_shadow_prediction_v2(); DROP FUNCTION IF EXISTS weather_guard_adjustment_confirmation_access_v2(); DROP FUNCTION IF EXISTS weather_reject_adjustment_maintenance_mutation(); DROP FUNCTION IF EXISTS weather_register_adjustment_shadow_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_temperature_shadow_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_wind_shadow_v2(jsonb); DROP FUNCTION IF EXISTS weather_append_adjustment_rain_shadow_v2(jsonb); DROP FUNCTION IF EXISTS adjustment_shadow_body_admission_v2(text,text,text,integer); DROP FUNCTION IF EXISTS weather_finalize_adjustment_shadow_metadata_v2(jsonb); DROP FUNCTION IF EXISTS weather_record_adjustment_confirmation_access_v2(jsonb); DROP FUNCTION IF EXISTS adjustment_confirmation_availability_v2(text); DROP FUNCTION IF EXISTS adjustment_confirmation_export_v2(text,text,smallint); DROP VIEW IF EXISTS adjustment_evaluation_export_manifest_v1; DROP VIEW IF EXISTS adjustment_evaluation_export_rows_v1; DROP VIEW IF EXISTS rain_collection_status_v1; DROP TABLE IF EXISTS rain_adjustment_runs; DROP FUNCTION IF EXISTS weather_guard_rain_adjustment_run(); DROP TABLE IF EXISTS rain_capture_receipts; DROP TABLE IF EXISTS rain_capture_claims; DROP FUNCTION IF EXISTS weather_guard_rain_capture_claim(); DROP FUNCTION IF EXISTS weather_guard_rain_capture_receipt(); DROP FUNCTION IF EXISTS weather_reject_rain_capture_mutation(); DROP VIEW IF EXISTS forecast_runtime_provenance_v1; DROP VIEW IF EXISTS forecast_training_export_manifest_v1; DROP VIEW IF EXISTS forecast_training_export_rows_v1; DROP TABLE IF EXISTS ecmwf_temperature_canary_hours; DROP TABLE IF EXISTS ecmwf_temperature_canary_runs; DROP FUNCTION IF EXISTS weather_guard_ecmwf_temperature_canary_run_update(); DROP FUNCTION IF EXISTS weather_require_ecmwf_temperature_canary_hour_identity(); DROP FUNCTION IF EXISTS weather_reject_ecmwf_temperature_canary_hour_mutation(); DROP TABLE IF EXISTS forecast_anchor_records; DROP FUNCTION IF EXISTS weather_require_historical_forecast_anchor_source(); DROP FUNCTION IF EXISTS weather_guard_forecast_anchor_record_update(); GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO PUBLIC; ALTER DEFAULT PRIVILEGES FOR ROLE weather_owner IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC; REVOKE SELECT (capabilities) ON sources FROM weather_api; DELETE FROM schema_migrations WHERE name IN ('0009_forecast_anchor_records.sql', '0010_forecast_training_export.sql', '0011_forecast_runtime_provenance.sql', '0012_hide_archive_only_forecasts_from_live_reads.sql', '0013_ecmwf_temperature_canary.sql', '0014_rain_collection.sql', '0015_rain_station_access.sql', '0016_rain_adjustment.sql', '0017_adjustment_evaluation_export.sql', '0018_adjustment_maintenance_v2.sql')"
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

# restore one exact image set without migration
restore_images() (
  local env_file=$1
  local runtime_release=${2:-}
  local schema_release=${3:-}
  local restore_authorization_path
  unset WEATHER_MIGRATION_AUTHORIZATION_RELEASE
  unset WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256

  # reject partial lifecycle identity
  if [[ -n "$runtime_release" || -n "$schema_release" ]]; then
    [[ -n "$runtime_release" && -n "$schema_release" ]] ||
      die "runtime and schema releases must be provided together"
  fi

  # inject only a validated older-release authorization
  if [[ -n "$runtime_release" && "$runtime_release" != "$schema_release" ]]; then
    restore_authorization_path=$(migration_authorization "$schema_release")
    validate_migration_authorization \
      "$restore_authorization_path" "$runtime_release" "$schema_release"
    export WEATHER_MIGRATION_AUTHORIZATION_RELEASE="$runtime_release"
    export WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256
    WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256=$(env_value \
      "$restore_authorization_path" WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256)
  fi

  prepare_xweather_usage_directory || return 1
  start_postgres "$env_file" || return 1
  apply_runtime_database_acl \
    "$env_file" "$(env_value "$env_file" WEATHER_DATABASE_NAME)" || return 1
  verify_runtime_database_acl \
    "$env_file" "$(env_value "$env_file" WEATHER_DATABASE_NAME)" || return 1
  WEATHER_ENV_FILE=$env_file compose up -d --no-deps --wait \
    api worker web cloudflared || return 1
)

# start an exact release without compatibility state
start_exact_release() (
  local env_file=$1
  unset WEATHER_MIGRATION_AUTHORIZATION_RELEASE
  unset WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256
  prepare_xweather_usage_directory || return 1
  WEATHER_ENV_FILE=$env_file compose up -d --remove-orphans --wait || return 1
)

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
    current=$(read_release_state "$state_dir/current-release")
    schema_release=$(read_optional_release_state "$state_dir/schema-release")

    # default legacy state to the active release
    if [[ -z "$schema_release" ]]; then
      schema_release=$current
    fi

    current_env=$(release_env "$current")
    validate_release_env "$current_env" "$current"
    require_control_plane_compatibility "$current_env"
    require_command docker
    require_deployment_secrets
    restore_images "$current_env" "$current" "$schema_release"
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
