#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

# report only bounded fixed-root maintenance anchor presence
if (($# == 1)) && [[ "$1" == --adjustment-maintenance-v2 ]]; then
  require_command node
  node --max-old-space-size=16 --max-semi-space-size=1 --input-type=module <<'NODE'
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

const root = "/var/lib/weather/xweather/adjustment-evidence/maintenance-anchors";
const slotNames = ["current.json", "pending.json", "previous.json"];

// return one closed absent projection
function absentProjection() {
  return { sha256: null, sizeBytes: null, state: "absent" };
}

// read one private slot without following links
async function readSlot(name) {
  const path = join(root, name);
  let handle;

  // distinguish absence from unsafe filesystem state
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return absentProjection();
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== 0n || before.gid !== 0n ||
      (before.mode & 0o777n) !== 0o600n || before.nlink !== 1n ||
      before.size < 1n || before.size > 16_384n) {
      throw new Error(`maintenance anchor slot is unsafe: ${name}`);
    }
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;

    // fill only the bounded proven allocation
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) {
        throw new Error(`maintenance anchor slot ended early: ${name}`);
      }
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) {
      throw new Error(`maintenance anchor slot changed while reading: ${name}`);
    }
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      state: "present_unverified",
    };
  } finally {
    await handle.close();
  }
}

let rootState = "unavailable";
let privacyState = "unavailable";
const slots = Object.fromEntries(slotNames.map(
  // initialize every fixed slot as absent
  (name) => [name.slice(0, -5), absentProjection()],
));
try {
  const metadata = await lstat(root, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== 0n ||
    metadata.gid !== 0n || (metadata.mode & 0o777n) !== 0o700n) {
    throw new Error("maintenance anchor root is unsafe");
  }
  const names = (await readdir(root)).sort();
  if (names.some((name) => !slotNames.includes(name))) {
    throw new Error("maintenance anchor root contains an unknown entry");
  }
  for (const name of slotNames) {
    slots[name.slice(0, -5)] = await readSlot(name);
  }
  privacyState = "verified_private";
  rootState = names.length === 0 ? "unavailable" : "opaque_unverified";
} catch (error) {
  // treat only a wholly absent future root as unavailable
  if (error?.code !== "ENOENT") {
    throw error;
  }
}
process.stdout.write(`${JSON.stringify({
  actionEligible: false,
  contractVersion: "adjustment-maintenance-anchor-status/v2",
  privacyState,
  rootState,
  schemaReadiness: "not_established",
  slots,
})}\n`);
NODE
  exit 0
fi

# reject every other status operand
if (($# != 0)); then
  die "status takes no arguments"
fi

current=$(read_optional_release_state "$deploy_dir/state/current-release")
previous=$(read_optional_release_state "$deploy_dir/state/previous-release")
current=${current:-none}
previous=${previous:-none}
printf 'Current release: %s\nPrevious release: %s\n' "$current" "$previous"

# report runtime state only after activation
if [[ "$current" != none ]]; then
  current_env="$deploy_dir/releases/$current.env"
  database_name=$(env_value "$current_env" WEATHER_DATABASE_NAME)
  validate_database_name "$database_name"
  expected_link="../releases/$current.env"
  require_file "$current_env"
  [[ -L "$deploy_dir/state/active.env" ]] || die "active release link is missing"
  [[ "$(readlink "$deploy_dir/state/active.env")" == "$expected_link" ]] ||
    die "active release link does not match committed state"
  printf 'Images:\n'

  # report the four immutable references
  for name in WEATHER_SERVER_IMAGE WEATHER_WEB_IMAGE POSTGRES_IMAGE CLOUDFLARED_IMAGE; do
    image=$(env_value "$current_env" "$name")
    validate_image_reference "$image"
    printf '  %s=%s\n' "$name" "$image"
  done

  require_command docker
  compose ps
  printf 'Connector evidence:\n'
  compose ps cloudflared
  compose exec -T postgres psql --username postgres --dbname "$database_name" \
    --tuples-only --no-align --command \
    "SELECT json_build_object(
      'connector', json_build_object('service', 'cloudflared'),
      'server_version_num', current_setting('server_version_num'),
      'migration', (SELECT max(name) FROM schema_migrations),
      'worker_last_loop_at', (SELECT max(last_loop_at) FROM worker_heartbeats),
      'worker_last_success_at', (SELECT max(last_success_at) FROM worker_heartbeats),
      'latest_run', (SELECT row_to_json(run) FROM (SELECT id, state, started_at, completed_at, record_count FROM ingestion_runs ORDER BY started_at DESC, id DESC LIMIT 1) run),
      'stale_run', (SELECT row_to_json(run) FROM (SELECT id, deadline_at FROM ingestion_runs WHERE state='running' AND deadline_at < clock_timestamp() ORDER BY deadline_at ASC, id ASC LIMIT 1) run),
      'chunk_outcome', (SELECT row_to_json(chunk) FROM (SELECT id, ingestion_run_id, outcome, completed_at, error_code FROM backfill_chunk_outcomes ORDER BY completed_at DESC, id DESC LIMIT 1) chunk),
      'failure_evidence', (SELECT row_to_json(failure) FROM (SELECT id, error_classification, error_code, completed_at FROM ingestion_runs WHERE state='failed' ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1) failure),
      'weather_records', (SELECT count(*) FROM weather_records),
      'tide_coverage', (
        SELECT json_agg(coverage ORDER BY coverage.source_key)
        FROM (
          SELECT
            s.source_key,
            s.source_kind,
            count(wr.id) AS record_count,
            min(wr.valid_at) AS earliest_valid_at,
            max(wr.valid_at) AS latest_valid_at
          FROM sources s
          LEFT JOIN weather_records wr ON wr.source_id = s.id
          WHERE s.source_kind IN ('tide_observation', 'tide_prediction')
          GROUP BY s.source_key, s.source_kind
        ) coverage
      )
    )"
fi
