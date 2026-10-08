#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

max_days=14

# print bounded usage
usage() {
  cat <<'EOF'
Usage: pull-adjustment-evaluation-export.sh FROM_DATE TO_DATE
       pull-adjustment-evaluation-export.sh --v2 FROM_DATE TO_DATE
       pull-adjustment-evaluation-export.sh --availability-v2 REGISTRATION_SHA256
       pull-adjustment-evaluation-export.sh --confirmation-v2 REGISTRATION_SHA256 ACCESS_SHA256 CHUNK_INDEX

Pulls one forced Ballydidean adjustment-evaluation snapshot into the ignored
.weather-data directory, verifies it, and publishes it atomically. V2 dates are
inclusive America/Los_Angeles observation dates, not UTC maintenance masks.
EOF
}

# handle only local informational help
if (($# == 1)) && [[ "$1" == --help || "$1" == -h ]]; then
  usage
  exit 0
fi

# select one exact local client operation
case "${1:-}" in
  --v2)
    (($# == 3)) || { usage >&2; exit 2; }
    mode=daily_v2
    from_date=$2
    to_date=$3
    validate_calendar_date_range "$from_date" "$to_date" "$max_days"
    ;;
  --availability-v2)
    (($# == 2)) || { usage >&2; exit 2; }
    mode=availability_v2
    registration_sha256=$2
    [[ "$registration_sha256" =~ ^[a-f0-9]{64}$ ]] ||
      die "registration SHA256 is invalid"
    ;;
  --confirmation-v2)
    (($# == 4)) || { usage >&2; exit 2; }
    mode=confirmation_v2
    registration_sha256=$2
    access_sha256=$3
    chunk_index=$4
    [[ "$registration_sha256" =~ ^[a-f0-9]{64}$ ]] ||
      die "registration SHA256 is invalid"
    [[ "$access_sha256" =~ ^[a-f0-9]{64}$ ]] || die "access SHA256 is invalid"
    [[ "$chunk_index" =~ ^(0|[1-9]|1[0-9]|2[0-6])$ ]] ||
      die "chunk index is invalid"
    ;;
  *)
    (($# == 2)) || { usage >&2; exit 2; }
    mode=legacy_v1
    from_date=$1
    to_date=$2
    validate_calendar_date_range "$from_date" "$to_date" "$max_days"
    ;;
esac
require_command node
require_command mv
require_command sync
require_command tar
data_root="$repo_root/.weather-data/adjustment-evaluation"

# isolate v2 publications from the byte-compatible v1 layout
if [[ "$mode" != legacy_v1 ]]; then
  data_root="$repo_root/.weather-data/adjustment-evaluation-v2"
fi

# reject a preexisting symbolic data root
if [[ -L "$repo_root/.weather-data" || -L "$data_root" ]]; then
  die "local adjustment-evaluation data root must not be symbolic"
fi

mkdir -p -- "$data_root"
[[ "$(realpath -m -- "$data_root")" == "$data_root" ]] ||
  die "local adjustment-evaluation data root must use a canonical path"
umask 077
partial_root=$(mktemp -d "$data_root/.partial.XXXXXXXX")
archive="$partial_root/export.tar.gz.partial"
package_root="$partial_root/package"
mkdir -m 0700 -- "$package_root"

# remove every interrupted local publication
cleanup() {
  rm -rf -- "$partial_root"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# pull and publish one value-free availability projection
if [[ "$mode" == availability_v2 ]]; then
  availability="$partial_root/availability.json"
  "$deploy_dir/scripts/ssh-run.sh" adjustment-confirmation-availability-v2 \
    "$registration_sha256" >"$availability"
  [[ -s "$availability" ]] || die "adjustment availability response is empty"
  (( $(stat -c '%s' "$availability") <= 768 * 1024 )) ||
    die "adjustment availability response exceeds the wire limit"
  envelope_hash=$(node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    verify-v2-availability "$availability")
  [[ "$envelope_hash" =~ ^[a-f0-9]{64}$ ]] ||
    die "verified adjustment availability hash is invalid"
  destination="$data_root/availability/$envelope_hash"
  require_canonical_descendant "$destination" "$data_root" \
    "local adjustment availability"
  if [[ -e "$destination" || -L "$destination" ]]; then
    die "verified adjustment availability already exists"
  fi
  mkdir -m 0700 -- "$partial_root/publication"
  mv --no-copy --no-target-directory --update=none -- \
    "$availability" "$partial_root/publication/availability.json"
  chmod -R go-rwx "$partial_root/publication"
  sync -f "$partial_root/publication/availability.json"
  mkdir -p -- "$data_root/availability"
  [[ ! -L "$data_root/availability" ]] || die "availability root is symbolic"
  mv --no-copy --no-target-directory --update=none -- \
    "$partial_root/publication" "$destination"
  sync -f "$data_root/availability"
  trap - EXIT
  rm -rf -- "$partial_root"
  printf 'Verified local value-free adjustment availability: %s\n' "$destination"
  exit 0
fi

# pull one framed v2 observation package
if [[ "$mode" != legacy_v1 ]]; then
  frame="$partial_root/export-v2.frame.partial"
  envelope="$partial_root/envelope.json"
  source_package_root="$package_root/source-package"
  mkdir -m 0700 -- "$source_package_root"
  if [[ "$mode" == daily_v2 ]]; then
    "$deploy_dir/scripts/ssh-run.sh" adjustment-evaluation-export-v2 \
      "$from_date" "$to_date" >"$frame"
  else
    "$deploy_dir/scripts/ssh-run.sh" adjustment-confirmation-export-v2 \
      "$registration_sha256" "$access_sha256" "$chunk_index" >"$frame"
  fi
  [[ -s "$frame" ]] || die "adjustment v2 export stream is empty"
  (( $(stat -c '%s' "$frame") <= 48 * 1024 * 1024 + 64 * 1024 + 128 )) ||
    die "adjustment v2 export exceeds the wire limit"
  read -r payload_offset payload_bytes < <(
    node --max-old-space-size=48 --max-semi-space-size=1 \
      "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
      verify-v2-stream "$frame" "$envelope"
  )
  [[ "$payload_offset" =~ ^[1-9][0-9]*$ && "$payload_bytes" =~ ^[1-9][0-9]*$ ]] ||
    die "adjustment v2 stream framing is invalid"
  ((payload_offset + payload_bytes == $(stat -c '%s' "$frame"))) ||
    die "adjustment v2 payload range differs"

  # reject special payload members before extraction
  if ! tail -c "+$((payload_offset + 1))" "$frame" |
    tar --list --verbose --gzip --file - |
    awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }'; then
    die "adjustment v2 payload contains a special file"
  fi

  # reject expansion beyond the unchanged v1 allocation
  if ! tail -c "+$((payload_offset + 1))" "$frame" |
    tar --list --verbose --gzip --file - |
    awk '
      substr($1, 1, 1) == "-" { total += $3 }
      total > 67108864 { exit 1 }
    '; then
    die "adjustment v2 payload expands beyond the temporary limit"
  fi

  # retain only the unchanged v1 package paths
  if ! tail -c "+$((payload_offset + 1))" "$frame" |
    tar --list --gzip --file - |
    awk '
      $0 == "./" { next }
      $0 == "./manifest.json" { next }
      $0 == "./manifest.sha256" { next }
      $0 == "./members/" { next }
      $0 == "./members/rows.jsonl.gz" { next }
      $0 == "./members/bodies/" { next }
      $0 ~ /^\.\/members\/bodies\/sha256-[a-f0-9]{64}\.json\.gz$/ { next }
      $0 == "./members/edge/" { next }
      $0 == "./members/edge/objects/" { next }
      $0 == "./members/edge/receipts/" { next }
      $0 ~ /^\.\/members\/edge\/objects\/sha256-[a-f0-9]{64}\.json\.gz$/ { next }
      $0 ~ /^\.\/members\/edge\/receipts\/sha256-[a-f0-9]{64}\.json$/ { next }
      { exit 1 }
    '; then
    die "adjustment v2 payload contains an invalid path"
  fi
  tail -c "+$((payload_offset + 1))" "$frame" |
    tar --extract --gzip --file - --directory "$source_package_root" \
      --no-same-owner --no-same-permissions --delay-directory-restore
  envelope_hash=$(node --max-old-space-size=48 --max-semi-space-size=1 \
    "$deploy_dir/scripts/adjustment-evaluation-package.mjs" \
    verify-v2-envelope "$envelope" "$source_package_root")
  [[ "$envelope_hash" =~ ^[a-f0-9]{64}$ ]] ||
    die "verified adjustment v2 envelope hash is invalid"
  destination="$data_root/snapshots/$envelope_hash"
  require_canonical_descendant "$destination" "$data_root" \
    "local adjustment v2 snapshot"
  if [[ -e "$destination" || -L "$destination" ]]; then
    die "verified adjustment v2 snapshot already exists"
  fi
  rm -f -- "$frame"
  mv --no-copy --no-target-directory --update=none -- \
    "$envelope" "$package_root/envelope.json"
  chmod -R go-rwx "$package_root"
  sync -f "$package_root/envelope.json" \
    "$source_package_root/manifest.json" "$source_package_root/manifest.sha256"
  mkdir -p -- "$data_root/snapshots"
  [[ ! -L "$data_root/snapshots" ]] || die "snapshot root is symbolic"
  mv --no-copy --no-target-directory --update=none -- "$package_root" "$destination"
  sync -f "$data_root/snapshots"
  trap - EXIT
  rm -rf -- "$partial_root"
  printf 'Verified local Ballydidean adjustment-evaluation v2 snapshot: %s\n' \
    "$destination"
  exit 0
fi

"$deploy_dir/scripts/ssh-run.sh" adjustment-evaluation-export \
  "$from_date" "$to_date" >"$archive"
[[ -s "$archive" ]] || die "adjustment evaluation export stream is empty"
(( $(stat -c '%s' "$archive") <= 48 * 1024 * 1024 )) ||
  die "adjustment evaluation archive exceeds the wire limit"

# reject special archive nodes before extraction
if ! tar --list --verbose --gzip --file "$archive" |
  awk 'substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { exit 1 }'; then
  die "adjustment evaluation archive contains a special file"
fi

# reject an archive whose declared extraction exceeds the package allocation
if ! tar --list --verbose --gzip --file "$archive" |
  awk '
    substr($1, 1, 1) == "-" { total += $3 }
    total > 67108864 { exit 1 }
  '; then
  die "adjustment evaluation archive expands beyond the temporary limit"
fi

# reject traversal and unknown archive paths
if ! tar --list --gzip --file "$archive" |
  awk '
    $0 == "./" { next }
    $0 == "./manifest.json" { next }
    $0 == "./manifest.sha256" { next }
    $0 == "./members/" { next }
    $0 == "./members/rows.jsonl.gz" { next }
    $0 == "./members/bodies/" { next }
    $0 ~ /^\.\/members\/bodies\/sha256-[a-f0-9]{64}\.json\.gz$/ { next }
    $0 == "./members/edge/" { next }
    $0 == "./members/edge/objects/" { next }
    $0 == "./members/edge/receipts/" { next }
    $0 ~ /^\.\/members\/edge\/objects\/sha256-[a-f0-9]{64}\.json\.gz$/ { next }
    $0 ~ /^\.\/members\/edge\/receipts\/sha256-[a-f0-9]{64}\.json$/ { next }
    { exit 1 }
  '; then
  die "adjustment evaluation archive contains an invalid path"
fi

tar --extract --gzip --file "$archive" --directory "$package_root" \
  --no-same-owner --no-same-permissions --delay-directory-restore
manifest_hash=$(node --max-old-space-size=48 --max-semi-space-size=1 \
  "$deploy_dir/scripts/adjustment-evaluation-package.mjs" verify "$package_root")
[[ "$manifest_hash" =~ ^[a-f0-9]{64}$ ]] ||
  die "verified adjustment evaluation manifest hash is invalid"
destination="$data_root/$manifest_hash"
require_canonical_descendant "$destination" "$data_root" \
  "local adjustment evaluation snapshot"

# refuse replacement, links, and raced publication
if [[ -e "$destination" || -L "$destination" ]]; then
  die "verified adjustment evaluation snapshot already exists"
fi

rm -f -- "$archive"
chmod -R go-rwx "$package_root"
sync -f "$package_root/manifest.json" "$package_root/manifest.sha256"
mv --no-copy --no-target-directory --update=none -- "$package_root" "$destination"

# reject a destination won by another publisher
if [[ -e "$package_root" || -L "$package_root" ]]; then
  die "verified adjustment evaluation snapshot publication raced"
fi

sync -f "$data_root"
trap - EXIT
rm -rf -- "$partial_root"
printf 'Verified local Ballydidean adjustment-evaluation snapshot: %s\n' \
  "$destination"
