#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

scorecard_root=${WEATHER_ADJUSTMENT_SCORECARD_ROOT:-/var/lib/weather/xweather/adjustment-evidence}
v2_scorecard_root=/var/lib/weather/xweather/adjustment-evidence
runtime_uid=10002
runtime_gid=10002
install_mode=v1

# accept only the legacy or exact v2 internal grammar
if (($# == 1)) && [[ "$1" =~ ^[a-f0-9]{64}$ ]]; then
  expected_sha256=$1
elif (($# == 2)) && [[ "$1" == --v2 ]] && [[ "$2" =~ ^[a-f0-9]{64}$ ]]; then
  install_mode=v2
  expected_sha256=$2
else
  die "usage: install-adjustment-scorecard.sh [--v2] SHA256"
fi

# keep the privileged v2 operation on its fixed production root
if [[ "$install_mode" == v2 ]]; then
  scorecard_root=$v2_scorecard_root
fi

# require the root-owned forced operation
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "adjustment scorecard installation must run through sudo"
fi

require_command flock
require_command node
require_command setpriv
require_command sha256sum
require_command cut
require_command stat
require_command sync
require_file "$deploy_dir/scripts/forecast-adjustment-scorecard-contract.mjs"
[[ "$(realpath -m -- "$scorecard_root")" == "$scorecard_root" ]] ||
  die "adjustment scorecard root must use a canonical path"
[[ ! -L "$scorecard_root" ]] || die "adjustment scorecard root is linked"
[[ ! -L "$scorecard_root/scorecards" ]] || die "scorecard object directory is linked"
[[ ! -L "$scorecard_root/scorecards-v2" ]] || die "v2 scorecard object directory is linked"
install -d -o "$runtime_uid" -g "$runtime_gid" -m 0700 \
  "$scorecard_root" "$scorecard_root/scorecards"

# serialize both generations on the fixed root inode without adding a lock file
exec {scorecard_lock_fd}<"$scorecard_root"
flock --exclusive --nonblock "$scorecard_lock_fd" ||
  die "another scorecard installation is in flight"

# create the separate bounded v2 hot-object directory only for v2 installation
if [[ "$install_mode" == v2 ]]; then
  install -d -o "$runtime_uid" -g "$runtime_gid" -m 0700 \
    "$scorecard_root/scorecards-v2"
fi
temporary=$(mktemp "$scorecard_root/.scorecard.XXXXXXXX.partial")
pointer_temporary=$(mktemp "$scorecard_root/.current.XXXXXXXX.partial")
previous_temporary=$(mktemp "$scorecard_root/.previous.XXXXXXXX.partial")

# remove only uncommitted publication files
cleanup() {
  rm -f -- "$temporary" "$pointer_temporary" "$previous_temporary"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# read, hash, and validate one bounded document from standard input
read -r actual_sha256 actual_version < <(node --input-type=module - \
  "$deploy_dir/scripts/forecast-adjustment-scorecard-contract.mjs" \
  "$temporary" 3<&0 <<'NODE'
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [, , contractPath, outputPath] = process.argv;
const {
  FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES,
  parseForecastAdjustmentScorecard,
} = await import(pathToFileURL(contractPath));
const chunks = [];
let bytes = 0;
const input = createReadStream("", { autoClose: false, fd: 3 });

// stop reading immediately after the largest supported bound
for await (const chunk of input) {
  bytes += chunk.length;
  if (bytes > FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES) {
    throw new Error("forecast adjustment scorecard is too large");
  }
  chunks.push(chunk);
}

const content = Buffer.concat(chunks);
const scorecard = parseForecastAdjustmentScorecard(content, { now: new Date().toISOString() });
const handle = await open(outputPath, "w", 0o600);
try {
  await handle.writeFile(content);
  await handle.sync();
} finally {
  await handle.close();
}
process.stdout.write(
  `${createHash("sha256").update(content).digest("hex")} ${scorecard.contractVersion}\n`,
);
NODE
)
[[ "$actual_sha256" == "$expected_sha256" ]] ||
  die "scorecard bytes differ from the requested SHA-256"

# bind each forced verb to exactly one scorecard generation
if [[ "$install_mode" == v2 ]]; then
  [[ "$actual_version" == "forecast-adjustment-scorecard/v2" ]] ||
    die "v2 scorecard operation requires a v2 document"
else
  [[ "$actual_version" == "forecast-adjustment-scorecard/v1" ]] ||
    die "legacy scorecard operation requires a v1 document"
fi

object_directory="$scorecard_root/scorecards"

# isolate v2 hot-object accounting from immutable legacy v1 history
if [[ "$install_mode" == v2 ]]; then
  object_directory="$scorecard_root/scorecards-v2"
fi
object="$object_directory/sha256-$expected_sha256.json"
require_canonical_descendant "$object" "$object_directory" "scorecard object"

# publish or verify the immutable content object
publish_object() {
  # reuse only the exact previously committed content object
  if [[ -e "$object" || -L "$object" ]]; then
    verify_selected_object "$object_directory" "$expected_sha256"
    rm -f -- "$temporary"
  else
    chown "$runtime_uid:$runtime_gid" "$temporary"
    chmod 0600 "$temporary"
    ln "$temporary" "$object" || die "scorecard object publication raced"
    rm -f -- "$temporary"
    sync -f "$object"
    sync -f "$object_directory"
  fi

  # prove the runtime identity can read the object before selecting it
  setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
    test -r "$object"
}

# verify one selected immutable object beneath its fixed generation directory
verify_selected_object() {
  local directory=$1
  local sha256=$2
  local selected_object="$directory/sha256-$sha256.json"
  require_canonical_descendant "$selected_object" "$directory" "selected scorecard object"
  [[ -f "$selected_object" && ! -L "$selected_object" ]] ||
    die "selected scorecard object is invalid"
  [[ "$(stat -c '%a %h' -- "$selected_object")" == "600 1" ]] ||
    die "selected scorecard object mode is invalid"
  [[ "$(sha256sum -- "$selected_object" | cut -d ' ' -f 1)" == "$sha256" ]] ||
    die "selected scorecard object content is invalid"
}

# require every v2 hot object to remain selected or part of this exact retry
validate_v2_hot_objects() {
  local candidate
  local candidate_name
  local candidate_sha256
  local retained
  local selected_sha256
  local -a candidates
  shopt -s nullglob dotglob
  candidates=("$scorecard_root/scorecards-v2"/*)
  shopt -u nullglob dotglob

  # reject malformed, linked or unanchored hot v2 objects
  for candidate in "${candidates[@]}"; do
    candidate_name=${candidate##*/}
    [[ "$candidate_name" =~ ^sha256-([a-f0-9]{64})\.json$ ]] ||
      die "v2 scorecard object directory contains an invalid entry"
    candidate_sha256=${BASH_REMATCH[1]}
    [[ -f "$candidate" && ! -L "$candidate" ]] ||
      die "v2 scorecard object is invalid"
    [[ "$(stat -c '%a %h' -- "$candidate")" == "600 1" ]] ||
      die "v2 scorecard object mode or link count is invalid"
    [[ "$(sha256sum -- "$candidate" | cut -d ' ' -f 1)" == "$candidate_sha256" ]] ||
      die "v2 scorecard object content is invalid"
    retained=false

    # permit only the three fixed slots or this exact recoverable publication
    for selected_sha256 in "$current_sha256" "$previous_sha256" "$pending_sha256" "$expected_sha256"; do
      if [[ -n "$selected_sha256" && "$candidate_sha256" == "$selected_sha256" ]]; then
        retained=true
      fi
    done
    [[ "$retained" == true ]] ||
      die "unanchored v2 scorecard object requires archive retirement recovery"
  done
}

# publish one hash-only pointer through its private temporary file
write_pointer() {
  local output=$1
  local sha256=$2
  printf '{"sha256":"%s"}\n' "$sha256" >"$output"
  chown "$runtime_uid:$runtime_gid" "$output"
  chmod 0600 "$output"
  sync -f "$output"

  # prove the runtime identity can read the pointer before replacement
  setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
    test -r "$output"
}

# read one existing fixed private hash pointer without following links
read_pointer() {
  node --input-type=module - "$1" <<'NODE'
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const [, , pointerPath] = process.argv;
const handle = await open(pointerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const details = await handle.stat();
  if (!details.isFile() || (details.mode & 0o777) !== 0o600 || details.size > 128) {
    throw new Error("scorecard pointer is invalid");
  }
  const pointer = JSON.parse((await handle.readFile()).toString("utf8"));
  if (pointer === null || Array.isArray(pointer) || typeof pointer !== "object" ||
    Object.keys(pointer).length !== 1 || typeof pointer.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(pointer.sha256)) {
    throw new Error("scorecard pointer is invalid");
  }
  process.stdout.write(`${pointer.sha256}\n`);
} finally {
  await handle.close();
}
NODE
}

# retain the historical v1 pointer behavior unchanged
if [[ "$install_mode" == v1 ]]; then
  publish_object
  write_pointer "$pointer_temporary" "$expected_sha256"
  mv -Tf -- "$pointer_temporary" "$scorecard_root/current.json"
  sync -f "$scorecard_root"

  # prove the selected pointer remains readable after atomic replacement
  setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
    test -r "$scorecard_root/current.json"
  trap - EXIT
  rm -f -- "$previous_temporary"
  printf 'Installed forecast adjustment scorecard: %s\n' "$expected_sha256"
  exit 0
fi

v2_current="$scorecard_root/v2-current.json"
v2_previous="$scorecard_root/v2-previous.json"
v2_pending="$scorecard_root/v2-pending.json"
current_sha256=
previous_sha256=
pending_sha256=
legacy_sha256=

# freeze and validate every existing v2 selection before mutation
if [[ -e "$v2_current" || -L "$v2_current" ]]; then
  current_sha256=$(read_pointer "$v2_current")
fi
if [[ -e "$v2_previous" || -L "$v2_previous" ]]; then
  previous_sha256=$(read_pointer "$v2_previous")
fi
if [[ -e "$v2_pending" || -L "$v2_pending" ]]; then
  pending_sha256=$(read_pointer "$v2_pending")
  [[ "$pending_sha256" == "$expected_sha256" ]] ||
    die "another v2 scorecard installation is pending"
fi
if [[ -e "$scorecard_root/current.json" || -L "$scorecard_root/current.json" ]]; then
  legacy_sha256=$(read_pointer "$scorecard_root/current.json")
fi

# bind every fixed pointer to an existing immutable object before mutation
for selected_sha256 in "$current_sha256" "$previous_sha256" "$pending_sha256"; do
  if [[ -n "$selected_sha256" ]]; then
    verify_selected_object "$scorecard_root/scorecards-v2" "$selected_sha256"
  fi
done
if [[ -n "$legacy_sha256" ]]; then
  verify_selected_object "$scorecard_root/scorecards" "$legacy_sha256"
fi
validate_v2_hot_objects

# retain legacy v1 and only one pending v2 projection during migration
if [[ -n "$legacy_sha256" ]]; then
  [[ -z "$current_sha256" && -z "$previous_sha256" ]] ||
    die "legacy v1 cannot coexist with selected v2 scorecards"
  publish_object

  # make the exact pending migration publication idempotent
  if [[ -n "$pending_sha256" ]]; then
    trap - EXIT
    rm -f -- "$pointer_temporary" "$previous_temporary"
    printf 'Installed pending forecast adjustment scorecard v2: %s\n' "$expected_sha256"
    exit 0
  fi

  write_pointer "$pointer_temporary" "$expected_sha256"
  mv -Tf -- "$pointer_temporary" "$v2_pending"
  sync -f "$scorecard_root"
  trap - EXIT
  rm -f -- "$previous_temporary"
  printf 'Installed pending forecast adjustment scorecard v2: %s\n' "$expected_sha256"
  exit 0
fi

# refuse a third hot v2 object without an exact anchored cold retirement
if [[ -z "$pending_sha256" && -n "$current_sha256" && -n "$previous_sha256" &&
  "$expected_sha256" != "$current_sha256" && "$expected_sha256" != "$previous_sha256" ]]; then
  die "v2 scorecard retirement authority is required before another installation"
fi

# refuse recovery that would overwrite an unarchived previous selection
if [[ -n "$pending_sha256" && -n "$previous_sha256" &&
  "$previous_sha256" != "$current_sha256" && "$current_sha256" != "$expected_sha256" ]]; then
  die "pending v2 rotation would discard an unarchived previous scorecard"
fi

publish_object

# make an already selected publication idempotent
if [[ "$current_sha256" == "$expected_sha256" && -z "$pending_sha256" ]]; then
  trap - EXIT
  rm -f -- "$pointer_temporary" "$previous_temporary"
  printf 'Installed forecast adjustment scorecard v2: %s\n' "$expected_sha256"
  exit 0
fi

# commit the recoverable pending selection before rotating current and previous
if [[ -z "$pending_sha256" ]]; then
  write_pointer "$pointer_temporary" "$expected_sha256"
  mv -Tf -- "$pointer_temporary" "$v2_pending"
  sync -f "$scorecard_root"
  pending_sha256=$expected_sha256
fi

# preserve the former current selection unless a prior interrupted rotation already did
if [[ -n "$current_sha256" && "$current_sha256" != "$expected_sha256" &&
  "$previous_sha256" != "$current_sha256" ]]; then
  write_pointer "$previous_temporary" "$current_sha256"
  mv -Tf -- "$previous_temporary" "$v2_previous"
  sync -f "$scorecard_root"
fi

# select only the exact pending object through one atomic rename
mv -Tf -- "$v2_pending" "$v2_current"
sync -f "$scorecard_root"

# prove the selected pointer remains readable after atomic replacement
[[ "$(read_pointer "$v2_current")" == "$expected_sha256" ]] ||
  die "v2 scorecard selection did not persist"
setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
  test -r "$v2_current"
trap - EXIT
rm -f -- "$pointer_temporary" "$previous_temporary"
printf 'Installed forecast adjustment scorecard v2: %s\n' "$expected_sha256"
