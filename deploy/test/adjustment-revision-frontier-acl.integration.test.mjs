import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runMigrations } from "../../packages/database/dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "../../packages/database/test/postgres-harness.mjs";

const executeFile = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");

// apply only the checked-in acl to one disposable database
async function applyAcl(server) {
  await executeFile("docker", ["cp", `${root}/deploy/postgres/runtime-acl-v2.sql`,
    `${server.name}:/tmp/runtime-acl-v2.sql`]);
  await executeFile("docker", ["exec", server.name, "psql", "--set=ON_ERROR_STOP=1",
    "--username", server.user, "--dbname", "weather_test", "--file", "/tmp/runtime-acl-v2.sql"]);
}

// run the production effective-privilege verifier
async function verifyAcl(server) {
  return await executeFile("bash", ["-c", `
source "$1"
container_name=$2
# restrict compose forwarding to the disposable postgres container
compose() {
  [[ "$1" == exec && "$2" == -T && "$3" == postgres ]] || return 1
  shift 3
  docker exec -i "$container_name" "$@"
}
verify_runtime_database_acl /unused.env weather_test
`, "revision-frontier-acl", `${root}/deploy/scripts/common.sh`, server.name], { timeout: 30_000 });
}

// keep ordinal assignment private and expose only the bounded frontier read
test("revision frontier acl rejects direct hot or sequence authority", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "revision-frontier-acl");
  const admin = createTestPool(server);
  let owner;
  try {
    await createRuntimeRoles(admin);
    await admin.query(`ALTER ROLE weather_owner LOGIN PASSWORD 'owner-test';
      ALTER DATABASE weather_test OWNER TO weather_owner;
      ALTER SCHEMA public OWNER TO weather_owner;`);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, `${root}/packages/database/migrations`);
    await applyAcl(server);
    await verifyAcl(server);

    const first = await owner.query(`SELECT weather_issue_adjustment_revision_receipt_v1(
      'actual_best_match', $1, $2, $3) AS receipt`, ["1".repeat(64), "2".repeat(64),
      "3".repeat(64)]);
    const second = await owner.query(`SELECT weather_issue_adjustment_revision_receipt_v1(
      'target_revision', $1, $2, $3) AS receipt`, ["4".repeat(64), "5".repeat(64),
      "6".repeat(64)]);
    assert.equal(first.rows[0].receipt.archiveCommitOrdinal, "1");
    assert.equal(second.rows[0].receipt.archiveCommitOrdinal, "2");
    assert.equal(second.rows[0].receipt.predecessorFrontierSha256,
      first.rows[0].receipt.frontierSha256);
    assert.match(first.rows[0].receipt.archiveCommittedAt,
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    const receiptSize = await owner.query(`SELECT pg_column_size($1::jsonb)::integer AS bytes`,
      [first.rows[0].receipt]);
    assert.ok(receiptSize.rows[0].bytes * 4096 <= 69.98 * 1024 * 1024);

    const privileges = await admin.query(`SELECT
      has_function_privilege('weather_ingest',
        'weather_bind_weather_record_revisions_v1(jsonb)', 'EXECUTE') AS weather_bind,
      has_function_privilege('weather_ingest',
        'weather_bind_forecast_anchor_revisions_v1(jsonb)', 'EXECUTE') AS anchor_bind,
      has_function_privilege('weather_ingest',
        'weather_bind_rain_gate_revision_v1(jsonb)', 'EXECUTE') AS rain_bind,
      has_function_privilege('weather_ingest',
        'weather_bind_ecmwf_temperature_revision_v1(jsonb)', 'EXECUTE') AS temperature_bind,
      has_column_privilege('weather_ingest', 'weather_records',
        'adjustment_revision_receipt', 'INSERT') AS direct_insert,
      has_column_privilege('weather_api', 'weather_records',
        'adjustment_revision_receipt', 'SELECT') AS direct_read`);
    assert.deepEqual(privileges.rows[0], {
      anchor_bind: true,
      direct_insert: false,
      direct_read: false,
      rain_bind: true,
      temperature_bind: true,
      weather_bind: true,
    });

    const snapshot = await owner.query(`SELECT adjustment_revision_serving_snapshot_v1(
      clock_timestamp(), 2) AS value`);
    assert.equal(snapshot.rows[0].value.archiveCommitOrdinal, "2");
    assert.equal(snapshot.rows[0].value.entryCount, 0);

    await admin.query("GRANT USAGE ON SEQUENCE adjustment_revision_ordinal_v1 TO weather_api");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("GRANT EXECUTE ON FUNCTION weather_append_adjustment_shadow_v4(jsonb,text) TO weather_api");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("GRANT SELECT ON adjustment_revision_frontier_v1 TO weather_training_export");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    const bounded = await admin.query(`SELECT sum(pg_total_relation_size(name::regclass))::text AS bytes
      FROM unnest(ARRAY['adjustment_shadow_registrations_v2',
        'adjustment_shadow_predictions_v2', 'adjustment_confirmation_accesses_v2',
        'adjustment_shadow_terminal_results_v2',
        'adjustment_revision_frontier_v1']) name`);
    assert.ok(BigInt(bounded.rows[0].bytes) <= 1_048_576n);
  } finally {
    await owner?.end();
    await admin.end();
    await stopPostgres(server);
  }
});
