#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

max_days=14

# print bounded usage
usage() {
  cat <<'EOF'
Usage: pull-adjustment-evaluation-export.sh FROM_DATE TO_DATE

Pulls one forced Ballydidean adjustment-evaluation snapshot into the ignored
.weather-data directory, verifies it, and publishes it atomically.
EOF
}

# handle only local informational help
if (($# == 1)) && [[ "$1" == --help || "$1" == -h ]]; then
  usage
  exit 0
fi

# require exactly the forced date operands
if (($# != 2)); then
  usage >&2
  exit 2
fi

from_date=$1
to_date=$2
validate_calendar_date_range "$from_date" "$to_date" "$max_days"
require_command node
require_command mv
require_command sync
require_command tar
data_root="$repo_root/.weather-data/adjustment-evaluation"

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
