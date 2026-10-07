#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

scorecard_root=${WEATHER_ADJUSTMENT_SCORECARD_ROOT:-/var/lib/weather/xweather/adjustment-evidence}
runtime_uid=10002
runtime_gid=10002

# require one exact content identity
if (($# != 1)) || [[ ! "$1" =~ ^[a-f0-9]{64}$ ]]; then
  die "usage: install-adjustment-scorecard.sh SHA256"
fi
expected_sha256=$1

# require the root-owned forced operation
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  die "adjustment scorecard installation must run through sudo"
fi

require_command node
require_command setpriv
require_command sync
require_file "$deploy_dir/scripts/forecast-adjustment-scorecard-contract.mjs"
[[ "$(realpath -m -- "$scorecard_root")" == "$scorecard_root" ]] ||
  die "adjustment scorecard root must use a canonical path"
[[ ! -L "$scorecard_root" ]] || die "adjustment scorecard root is linked"
install -d -o "$runtime_uid" -g "$runtime_gid" -m 0700 \
  "$scorecard_root" "$scorecard_root/scorecards"
[[ ! -L "$scorecard_root/scorecards" ]] || die "scorecard object directory is linked"
temporary=$(mktemp "$scorecard_root/.scorecard.XXXXXXXX.partial")
pointer_temporary=$(mktemp "$scorecard_root/.current.XXXXXXXX.partial")

# remove only uncommitted publication files
cleanup() {
  rm -f -- "$temporary" "$pointer_temporary"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# read, hash, and validate one bounded document from standard input
actual_sha256=$(node --input-type=module - \
  "$deploy_dir/scripts/forecast-adjustment-scorecard-contract.mjs" \
  "$temporary" <<'NODE'
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const [, , contractPath, outputPath] = process.argv;
const {
  FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES,
  parseForecastAdjustmentScorecard,
} = await import(pathToFileURL(contractPath));
const chunks = [];
let bytes = 0;

// stop reading immediately after the reviewed bound
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES) {
    throw new Error("forecast adjustment scorecard is too large");
  }
  chunks.push(chunk);
}

const content = Buffer.concat(chunks);
parseForecastAdjustmentScorecard(content, { now: new Date().toISOString() });
const handle = await open(outputPath, "w", 0o600);
try {
  await handle.writeFile(content);
  await handle.sync();
} finally {
  await handle.close();
}
process.stdout.write(`${createHash("sha256").update(content).digest("hex")}\n`);
NODE
)
[[ "$actual_sha256" == "$expected_sha256" ]] ||
  die "scorecard bytes differ from the requested SHA-256"

object="$scorecard_root/scorecards/sha256-$expected_sha256.json"
require_canonical_descendant "$object" "$scorecard_root/scorecards" "scorecard object"
[[ ! -e "$object" && ! -L "$object" ]] || die "scorecard object already exists"
chown "$runtime_uid:$runtime_gid" "$temporary"
chmod 0600 "$temporary"

# publish the immutable object with an exclusive same-filesystem link
ln "$temporary" "$object" || die "scorecard object publication raced"
rm -f -- "$temporary"
sync -f "$object"
sync -f "$scorecard_root/scorecards"

# prove the runtime identity can read the object before selecting it
setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
  test -r "$object"

# publish only the selected object hash
printf '{"sha256":"%s"}\n' "$expected_sha256" >"$pointer_temporary"
chown "$runtime_uid:$runtime_gid" "$pointer_temporary"
chmod 0600 "$pointer_temporary"
sync -f "$pointer_temporary"

# prove the runtime identity can read the pointer before replacement
setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
  test -r "$pointer_temporary"
mv -Tf -- "$pointer_temporary" "$scorecard_root/current.json"
sync -f "$scorecard_root"

# prove the selected pointer remains readable after atomic replacement
setpriv --reuid="$runtime_uid" --regid="$runtime_gid" --clear-groups \
  test -r "$scorecard_root/current.json"
trap - EXIT
printf 'Installed forecast adjustment scorecard: %s\n' "$expected_sha256"
