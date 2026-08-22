#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# print release usage
usage() {
  cat <<'EOF'
Usage:
  update.sh stage RELEASE [--from ENV_FILE]
  update.sh activate RELEASE
  update.sh rollback
  update.sh recover
  update.sh status

stage resolves and persists four exact ARM64 image digests without changing
running services or the active database. Upgrade staging uses only a disposable
compatibility database. activate backs up before migration and records success
last. rollback changes images only and never invokes migration.
EOF
}

releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
capacity_evidence=/var/lib/weather/preflight-latest.json
control_plane_version=1
mkdir -p "$releases_dir" "$state_dir"

# locate one validated release environment
release_env() {
  validate_release "$1"
  printf '%s/%s.env\n' "$releases_dir" "$1"
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

# resolve one explicit linux arm64 manifest
resolve_arm64_image() {
  local image=$1
  local resolved
  resolved=$(docker buildx imagetools inspect "$image" --raw |
    node "$deploy_dir/scripts/resolve-image.mjs" "$image")
  validate_image_reference "$resolved"
  printf '%s\n' "$resolved"
}

# validate one immutable production release environment
validate_release_env() {
  local path=$1
  local expected_release=${2:-}
  local release database_name postgres_dir control_plane control_version
  local meaningful_lines allowed_fields
  require_file "$path"
  [[ ! -L "$path" ]] || die "release environment must not be a symbolic link: $path"
  meaningful_lines=$(grep -cE '^[A-Z][A-Z0-9_]*=' "$path")
  # accept the original version-one release format
  if [[ "$meaningful_lines" -eq 7 ]]; then
    allowed_fields='^(WEATHER_RELEASE|WEATHER_SERVER_IMAGE|WEATHER_WEB_IMAGE|POSTGRES_IMAGE|CLOUDFLARED_IMAGE|WEATHER_DATABASE_NAME|WEATHER_POSTGRES_DIR)='
    control_plane=
    control_version=1
  elif [[ "$meaningful_lines" -eq 9 ]]; then
    allowed_fields='^(WEATHER_RELEASE|WEATHER_SERVER_IMAGE|WEATHER_WEB_IMAGE|POSTGRES_IMAGE|CLOUDFLARED_IMAGE|WEATHER_DATABASE_NAME|WEATHER_POSTGRES_DIR|WEATHER_CONTROL_PLANE_SHA256|WEATHER_CONTROL_PLANE_VERSION)='
    control_plane=$(env_value "$path" WEATHER_CONTROL_PLANE_SHA256)
    control_version=$(env_value "$path" WEATHER_CONTROL_PLANE_VERSION)
  else
    die "release environment must use the version-one legacy or current format"
  fi
  grep -qEv "$allowed_fields" "$path" &&
    die "release environment contains an unknown or malformed value"
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
  [[ -z "$control_plane" || "$control_plane" =~ ^[a-f0-9]{64}$ ]] ||
    die "invalid deployment control-plane digest"
  [[ "$control_version" =~ ^[1-9][0-9]*$ ]] || die "invalid deployment control-plane version"
}

# require the installed deployment contract
require_control_plane_compatibility() {
  local env_file=$1
  local expected_version expected_digest current_digest
  grep -q '^WEATHER_CONTROL_PLANE_VERSION=' "$env_file" ||
    die "release state lacks deployment control-plane version metadata"
  grep -q '^WEATHER_CONTROL_PLANE_SHA256=' "$env_file" ||
    die "release state lacks deployment control-plane digest metadata"
  expected_version=$(env_value "$env_file" WEATHER_CONTROL_PLANE_VERSION)
  expected_digest=$(env_value "$env_file" WEATHER_CONTROL_PLANE_SHA256)
  current_digest=$(control_plane_digest)
  [[ "$expected_version" == "$control_plane_version" ]] ||
    die "deployment control-plane version is incompatible with release state"
  [[ "$expected_digest" == "$current_digest" ]] ||
    die "deployment control-plane digest is incompatible with release state"
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
  local database_name postgres_dir control_plane
  database_name=$(env_value "$source_env" WEATHER_DATABASE_NAME)
  postgres_dir=$(env_value "$source_env" WEATHER_POSTGRES_DIR)
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
  require_secret_source "$deploy_dir/secrets/weather_postgres_owner_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_postgres_api_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_postgres_ingest_password" 999 999
  require_secret_source "$deploy_dir/secrets/weather_migration_owner_password" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_api_password" 10002 10002
  require_secret_source "$deploy_dir/secrets/weather_worker_ingest_password" 10002 10002
  require_secret_source "$deploy_dir/secrets/cloudflare_tunnel_token" 65532 65532
  cmp -s "$deploy_dir/secrets/weather_postgres_owner_password" \
    "$deploy_dir/secrets/weather_migration_owner_password" ||
    die "owner password copies differ"
  cmp -s "$deploy_dir/secrets/weather_postgres_api_password" \
    "$deploy_dir/secrets/weather_api_password" || die "API password copies differ"
  cmp -s "$deploy_dir/secrets/weather_postgres_ingest_password" \
    "$deploy_dir/secrets/weather_worker_ingest_password" ||
    die "ingest password copies differ"
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

# run previous-image checks on a disposable migrated clone
verify_previous_image_compatibility() (
  local target_env=$1
  local previous_env=$2
  local candidate api_container provider_container provider_image active_database provider_network
  local previous_release
  local candidate_created=false
  local api_started=false
  local provider_started=false
  local before_successes after_successes
  candidate="weather_compat_$(date -u +%Y%m%d%H%M%S)_$$"
  api_container="${candidate}_api"
  provider_container="${candidate}_provider"
  provider_image=$(env_value "$target_env" WEATHER_SERVER_IMAGE)
  active_database=$(env_value "$previous_env" WEATHER_DATABASE_NAME)
  previous_release=$(env_value "$previous_env" WEATHER_RELEASE)
  provider_network="${WEATHER_COMPOSE_PROJECT_NAME:-weather}_provider_egress"

  # clean every disposable compatibility resource
  # shellcheck disable=SC2329
  cleanup_compatibility() {
    local status=$?

    # remove a started API probe
    if [[ "$api_started" == true ]]; then
      docker rm --force "$api_container" >/dev/null 2>&1 || status=1
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

  WEATHER_ENV_FILE=$target_env compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" migration
  apply_runtime_database_acl "$previous_env" "$candidate"
  verify_runtime_database_acl "$previous_env" "$candidate"
  WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --set=ON_ERROR_STOP=1 --username postgres --dbname "$candidate" \
      --command "UPDATE ingestion_checkpoints SET last_committed_at = TIMESTAMPTZ '1970-01-01 00:00:00+00'; UPDATE sources SET cadence_seconds = 60 WHERE active"

  docker run --detach --rm --name "$provider_container" \
    --network "$provider_network" --network-alias "$provider_container" \
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
  WEATHER_ENV_FILE=$previous_env compose run --rm --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" \
    --env WEATHER_OPEN_METEO_COMPATIBILITY_ORIGIN="http://$provider_container:3002" \
    worker node apps/worker/dist/worker.js --once
  after_successes=$(WEATHER_ENV_FILE=$previous_env compose exec -T postgres \
    psql --username postgres --dbname "$candidate" --tuples-only --no-align \
      --command "SELECT count(*) FROM ingestion_runs WHERE state='succeeded'")
  (( after_successes > before_successes )) || die "previous worker compatibility failed"

  WEATHER_ENV_FILE=$previous_env compose run --detach --name "$api_container" --no-deps \
    --env WEATHER_DATABASE_NAME="$candidate" api node apps/api/dist/main.js >/dev/null
  api_started=true

  # wait for both previous API contracts
  for ((_attempt = 0; _attempt < 30; _attempt += 1)); do
    # accept only health and read success together
    if docker exec "$api_container" node -e \
      "Promise.all(['/api/v1/health','/api/v1/sites'].map(path=>fetch('http://127.0.0.1:3001'+path))).then(async([health,sites])=>{if(!health.ok||!sites.ok)process.exit(1);const healthBody=await health.json();const sitesBody=await sites.json();if(healthBody.data?.ready!==true||healthBody.data?.version!=='$previous_release'||!Array.isArray(sitesBody.data))process.exit(1)}).catch(()=>process.exit(1))"; then
      exit 0
    fi
    sleep 1
  done

  die "previous API compatibility failed"
)

# restore one exact image set without migration
restore_images() {
  local env_file=$1
  WEATHER_ENV_FILE=$env_file compose up -d --no-deps --wait \
    postgres api worker web cloudflared
}

# activate one forward release
start_release() (
  local target=$1
  local activation_env current current_env backup_env
  local initial_started=false

  # clean a partially started first activation
  # shellcheck disable=SC2329
  cleanup_initial_activation() {
    local status=$?

    # stop only this Weather project
    if [[ "$initial_started" == true ]]; then
      WEATHER_ENV_FILE=$activation_env compose down --remove-orphans >/dev/null 2>&1 || status=1
    fi

    trap - EXIT
    exit "$status"
  }
  trap cleanup_initial_activation EXIT
  activation_env=$(release_env "$target")
  validate_release_env "$activation_env" "$target"
  require_control_plane_compatibility "$activation_env"
  current=$(read_optional_release_state "$state_dir/current-release")
  require_capacity_gate
  require_deployment_secrets

  # establish the database used for the safety backup
  if [[ -n "$current" ]]; then
    current_env=$(release_env "$current")
    validate_release_env "$current_env" "$current"
    backup_env=$current_env
  else
    backup_env=$activation_env
    initial_started=true
    WEATHER_ENV_FILE=$activation_env compose up -d postgres --wait
  fi

  printf 'Creating pre-migration encrypted backup...\n'
  "$deploy_dir/scripts/backup.sh" --env-file "$backup_env" ||
    die "pre-migration backup failed"

  printf 'Applying candidate migrations...\n'
  WEATHER_ENV_FILE=$activation_env compose run --rm migration

  printf 'Starting release %s...\n' "$target"
  if ! WEATHER_ENV_FILE=$activation_env compose up -d --remove-orphans --wait; then
    # restore only the prior exact image configuration
    if [[ -n "$current" && "$current" != "$target" ]]; then
      printf 'Activation failed; restoring Weather release %s...\n' "$current" >&2
      restore_images "$current_env" ||
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
  local current previous current_env previous_env
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

  # switch only immutable runtime images
  if ! restore_images "$previous_env"; then
    restore_images "$current_env" || die "rollback and current-image recovery both failed"
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
  stage)
    (($# >= 1)) || die "stage requires a release"
    release=$1
    shift
    validate_release "$release"
    source_env="$deploy_dir/.env"

    # accept one explicit source environment
    if (($# > 0)); then
      [[ "$1" == --from && $# -eq 2 ]] || die "expected --from ENV_FILE"
      source_env=$2
    fi

    require_file "$source_env"
    require_command docker
    require_command node
    require_capacity_gate
    target=$(release_env "$release")
    [[ ! -e "$target" && ! -L "$target" ]] || die "release is already staged: $release"
    server_source="$(image_repository "$(env_value "$source_env" WEATHER_SERVER_IMAGE)"):$release"
    web_source="$(image_repository "$(env_value "$source_env" WEATHER_WEB_IMAGE)"):$release"
    server_image=$(resolve_arm64_image "$server_source")
    web_image=$(resolve_arm64_image "$web_source")
    postgres_image=$(resolve_arm64_image "$(env_value "$source_env" POSTGRES_IMAGE)")
    cloudflared_image=$(resolve_arm64_image "$(env_value "$source_env" CLOUDFLARED_IMAGE)")
    temporary=$(mktemp "$releases_dir/.${release}.XXXXXX.env.partial")

    # remove failed stage state
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

    WEATHER_ENV_FILE=$temporary compose pull
    current=$(read_optional_release_state "$state_dir/current-release")

    # require previous-image compatibility for upgrades
    if [[ -n "$current" ]]; then
      previous_env=$(release_env "$current")
      validate_release_env "$previous_env" "$current"
      require_deployment_secrets
      verify_previous_image_compatibility "$temporary" "$previous_env"
    else
      printf 'Initial release: previous-image compatibility is not applicable.\n'
    fi

    mv "$temporary" "$target"
    trap - EXIT
    printf 'Release %s staged without changing running services or the active database.\n' "$release"
    ;;
  activate)
    (($# == 1)) || die "activate requires exactly one release"
    validate_release "$1"
    require_command age
    require_command docker
    start_release "$1"
    ;;
  rollback)
    (($# == 0)) || die "rollback takes no arguments"
    require_command docker
    rollback_release
    ;;
  recover)
    (($# == 0)) || die "recover takes no arguments"
    current=$(read_release_state "$state_dir/current-release")
    current_env=$(release_env "$current")
    validate_release_env "$current_env" "$current"
    require_control_plane_compatibility "$current_env"
    require_command docker
    require_deployment_secrets
    restore_images "$current_env"
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
