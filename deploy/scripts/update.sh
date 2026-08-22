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

stage validates and pulls exact ARM64 images without changing running services
or the active database. Upgrade staging uses only a disposable compatibility
database. activate backs up before migration and records success last.
EOF
}

releases_dir="$deploy_dir/releases"
state_dir="$deploy_dir/state"
mkdir -p "$releases_dir" "$state_dir"

# locate staged release state
release_env() {
  printf '%s/%s.env\n' "$releases_dir" "$1"
}

# verify one published ARM64 manifest
verify_arm64_image() {
  local image=$1
  local manifest
  manifest=$(docker buildx imagetools inspect "$image")
  grep -qE 'linux/arm64|Platform:[[:space:]]+linux/arm64' <<<"$manifest" ||
    die "image has no linux/arm64 manifest: $image"
}

# run previous-image checks on a disposable migrated clone
verify_previous_image_compatibility() {
  local target_env=$1
  local previous_env=$2
  local candidate
  local status=0
  candidate="weather_compat_$(date -u +%Y%m%d%H%M%S)_$$"

  printf 'Creating disposable compatibility database %s...\n' "$candidate"
  compose exec -T postgres createdb --username postgres --owner weather_owner "$candidate"

  # clone active data without plaintext host storage
  if ! compose exec -T postgres \
    pg_dump --username weather_owner --dbname weather --format=custom --no-owner --no-acl |
    compose exec -T postgres pg_restore --username postgres --dbname "$candidate" \
      --no-owner --role weather_owner --exit-on-error; then
    status=1
  fi

  # migrate and probe only the disposable clone
  if (( status == 0 )) && ! WEATHER_DATABASE_NAME=$candidate WEATHER_ENV_FILE=$target_env \
    compose run --rm --no-deps migration; then
    status=1
  fi
  if (( status == 0 )) && ! WEATHER_DATABASE_NAME=$candidate WEATHER_ENV_FILE=$previous_env \
    compose run --rm --no-deps api node deploy/scripts/compatibility.mjs api; then
    status=1
  fi
  if (( status == 0 )) && ! WEATHER_DATABASE_NAME=$candidate WEATHER_ENV_FILE=$previous_env \
    compose run --rm --no-deps worker node deploy/scripts/compatibility.mjs worker; then
    status=1
  fi

  compose exec -T postgres dropdb --username postgres --if-exists "$candidate" || status=1
  (( status == 0 )) || die "previous image compatibility failed"
}

# start one staged release with health gates
start_release() {
  local target=$1
  local target_env current current_env backup_env
  target_env=$(release_env "$target")
  require_file "$target_env"
  current=$(cat "$state_dir/current-release" 2>/dev/null || true)

  # require the isolated connector credential
  require_file "$deploy_dir/secrets/cloudflare_tunnel_token"

  # establish the database used for the safety backup
  if [[ -n "$current" ]]; then
    backup_env=$(release_env "$current")
  else
    backup_env=$target_env
    WEATHER_ENV_FILE=$target_env compose up -d postgres --wait
  fi

  printf 'Creating pre-migration encrypted backup...\n'
  "$deploy_dir/scripts/backup.sh" --env-file "$backup_env" ||
    die "pre-migration backup failed"

  printf 'Applying candidate migrations...\n'
  WEATHER_ENV_FILE=$target_env compose run --rm migration

  printf 'Starting release %s...\n' "$target"
  if ! WEATHER_ENV_FILE=$target_env compose up -d --remove-orphans --wait; then
    # restore only the previous Weather images
    if [[ -n "$current" && "$current" != "$target" ]]; then
      current_env=$(release_env "$current")
      printf 'Activation failed; restoring Weather release %s...\n' "$current" >&2
      WEATHER_ENV_FILE=$current_env compose up -d --remove-orphans --wait ||
        die "activation and Weather image rollback both failed"
    else
      printf 'Initial activation failed; stopping only the Weather project...\n' >&2
      WEATHER_ENV_FILE=$target_env compose down --remove-orphans || true
    fi
    die "release $target failed health checks"
  fi

  # record success only after every health gate
  if [[ -n "$current" && "$current" != "$target" ]]; then
    write_private_state "$state_dir/previous-release" "$current"
  fi
  ln -sfn "../releases/$target.env" "$state_dir/active.env"
  write_private_state "$state_dir/current-release" "$target"
  printf 'Release %s is active.\n' "$target"
}

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
    target=$(release_env "$release")
    [[ ! -e "$target" ]] || die "release is already staged: $release"
    umask 077
    awk -v release="$release" '
      BEGIN { replaced = 0 }
      /^WEATHER_RELEASE=/ { print "WEATHER_RELEASE=" release; replaced = 1; next }
      { print }
      END { if (!replaced) print "WEATHER_RELEASE=" release }
    ' "$source_env" >"$target"
    chmod 600 "$target"
    WEATHER_ENV_FILE=$target compose config --quiet
    images=$(WEATHER_ENV_FILE=$target compose config --images | sort -u)

    # inspect every exact image before pulling
    while IFS= read -r image; do
      verify_arm64_image "$image"
    done <<<"$images"
    WEATHER_ENV_FILE=$target compose pull

    current=$(cat "$state_dir/current-release" 2>/dev/null || true)

    # require previous-image compatibility for upgrades
    if [[ -n "$current" ]]; then
      verify_previous_image_compatibility "$target" "$(release_env "$current")"
    else
      printf 'Initial release: previous-image compatibility is not applicable.\n'
    fi
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
    previous=$(cat "$state_dir/previous-release" 2>/dev/null || true)
    [[ -n "$previous" ]] || die "no previous Weather release is recorded"
    validate_release "$previous"
    require_command age
    require_command docker
    start_release "$previous"
    ;;
  recover)
    (($# == 0)) || die "recover takes no arguments"
    current=$(cat "$state_dir/current-release" 2>/dev/null || true)
    [[ -n "$current" ]] || die "no active Weather release is recorded"
    validate_release "$current"
    require_command docker
    WEATHER_ENV_FILE=$(release_env "$current") compose up -d --remove-orphans --wait
    ln -sfn "../releases/$current.env" "$state_dir/active.env"
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
