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

// run the same effective-privilege verifier used by deployment
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
`, "recurring-acl", `${root}/deploy/scripts/common.sh`, server.name], { timeout: 30_000 });
}

// keep new terminal authority owner-only and reject partially installed recurring objects
test("recurring acl rejects direct metadata grants, trigger drift and partial schema", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "recurring-acl");
  const admin = createTestPool(server);
  let owner;
  let api;
  let ingest;
  try {
    await createRuntimeRoles(admin);
    await admin.query(`ALTER ROLE weather_owner LOGIN PASSWORD 'owner-test';
      ALTER DATABASE weather_test OWNER TO weather_owner;
      ALTER SCHEMA public OWNER TO weather_owner;`);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    api = createTestPool(server, "weather_test", "weather_api", "api-test");
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    await runMigrations(owner, `${root}/packages/database/migrations`);
    await applyAcl(server);
    await verifyAcl(server);

    const fixture = await owner.query(`WITH inserted_site AS (
        INSERT INTO sites (slug, display_name, latitude, longitude, timezone)
        VALUES ('acl-receipt-site', 'ACL receipt site', 47, -122, 'UTC')
        RETURNING id
      ), inserted_provider AS (
        INSERT INTO providers (provider_key, display_name, attribution_label, attribution_url)
        VALUES ('acl-receipt-provider', 'ACL receipt provider', 'ACL', 'https://example.test')
        RETURNING id
      ), inserted_station AS (
        INSERT INTO stations (site_id, slug, display_name, station_kind, latitude, longitude)
        SELECT id, 'acl-receipt-station', 'ACL receipt station', 'physical', 47, -122
        FROM inserted_site RETURNING id
      ), inserted_source AS (
        INSERT INTO sources (station_id, provider_id, source_key, source_kind,
          material_provider_config, source_config_fingerprint, capabilities, cadence_seconds)
        SELECT station.id, provider.id, 'acl-receipt-source', 'physical_sensor',
          '{}'::jsonb, repeat('a', 64), '["current"]'::jsonb, 300
        FROM inserted_station station CROSS JOIN inserted_provider provider RETURNING id
      ), inserted_run AS (
        INSERT INTO ingestion_runs (source_id, mode, requested_start,
          requested_end_exclusive, source_config_fingerprint, adapter_version, deadline_at)
        SELECT id, 'scheduled', '2026-10-08T00:00:00.000Z',
          '2026-10-08T01:00:00.000Z', repeat('a', 64), 'acl-receipt/v1',
          '2030-01-01T00:00:00.000Z' FROM inserted_source RETURNING id, source_id
      ) SELECT id AS run_id, source_id FROM inserted_run`);
    const { run_id: runId, source_id: sourceId } = fixture.rows[0];
    // prove both constrained runtime roles can evaluate only the pure predicate
    for (const pool of [api, ingest]) {
      assert.equal((await pool.query(
        "SELECT weather_adjustment_revision_receipt_valid_v1(NULL) AS valid",
      )).rows[0].valid, true);
      assert.equal((await pool.query(
        "SELECT weather_adjustment_revision_receipt_valid_v1('{}'::jsonb) AS valid",
      )).rows[0].valid, false);
    }
    await ingest.query(`INSERT INTO weather_records (source_id, source_kind, valid_at,
      first_ingestion_run_id, last_ingestion_run_id, first_received_at, last_received_at,
      upstream_timezone, temperature_c, content_hash)
      VALUES ($1, 'physical_sensor', '2026-10-08T00:00:00.000Z', $2, $2,
        '2026-10-08T00:01:00.000Z', '2026-10-08T00:01:00.000Z', 'UTC', 10,
        repeat('b', 64))`, [sourceId, runId]);
    assert.equal((await owner.query(`SELECT adjustment_revision_receipt IS NULL AS legacy
      FROM weather_records WHERE source_id = $1`, [sourceId])).rows[0].legacy, true);
    await assert.rejects(owner.query(`INSERT INTO weather_records (source_id, source_kind,
      valid_at, first_ingestion_run_id, last_ingestion_run_id, first_received_at,
      last_received_at, upstream_timezone, temperature_c, content_hash,
      adjustment_revision_receipt) VALUES ($1, 'physical_sensor',
        '2026-10-08T01:00:00.000Z', $2, $2, '2026-10-08T01:01:00.000Z',
        '2026-10-08T01:01:00.000Z', 'UTC', 11, repeat('c', 64), '{}'::jsonb)`,
    [sourceId, runId]), /weather_records_adjustment_revision_receipt_check/u);

    await admin.query(`REVOKE EXECUTE ON FUNCTION
      weather_adjustment_revision_receipt_valid_v1(jsonb) FROM weather_ingest`);
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query(`REVOKE EXECUTE ON FUNCTION
      adjustment_shadow_registration_slot_v3(text) FROM weather_training_export`);
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("GRANT SELECT (terminal_result_sha256) ON adjustment_shadow_terminal_results_v2 TO weather_api");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("GRANT SELECT (epoch_at) ON adjustment_registration_schedule_v3 TO weather_api");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("GRANT EXECUTE ON FUNCTION weather_initialize_adjustment_registration_schedule_v3(jsonb) TO weather_api");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("ALTER TABLE adjustment_shadow_terminal_results_v2 DISABLE TRIGGER adjustment_shadow_terminal_results_v2_guard_mutation");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await admin.query("ALTER TABLE adjustment_shadow_terminal_results_v2 ENABLE TRIGGER adjustment_shadow_terminal_results_v2_guard_mutation");
    await verifyAcl(server);

    const sizes = await admin.query(`SELECT sum(pg_total_relation_size(name::regclass))::text AS bytes
      FROM unnest(ARRAY['adjustment_shadow_registrations_v2', 'adjustment_shadow_predictions_v2',
        'adjustment_confirmation_accesses_v2', 'adjustment_shadow_terminal_results_v2',
        'adjustment_revision_frontier_v1', 'adjustment_registration_schedule_v3',
        'adjustment_registration_horizons_v3',
        'adjustment_shadow_registration_windows_v3']) name`);
    assert.ok(BigInt(sizes.rows[0].bytes) <= 1_048_576n);

    await admin.query("ALTER TABLE adjustment_shadow_terminal_results_v2 RENAME TO adjustment_shadow_terminal_results_v2_missing");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await assert.rejects(applyAcl(server), /recurring maintenance schema is incomplete/u);
    await admin.query("ALTER TABLE adjustment_shadow_terminal_results_v2_missing RENAME TO adjustment_shadow_terminal_results_v2");
    await applyAcl(server);
    await verifyAcl(server);

    await admin.query("ALTER FUNCTION adjustment_shadow_registration_slot_v3(text) RENAME TO adjustment_shadow_registration_slot_v3_missing");
    await assert.rejects(verifyAcl(server), /runtime database ACL verification failed/u);
    await assert.rejects(applyAcl(server), /adjustment rolling registration schema is incomplete/u);
    await admin.query("ALTER FUNCTION adjustment_shadow_registration_slot_v3_missing(text) RENAME TO adjustment_shadow_registration_slot_v3");
    await applyAcl(server);
    await verifyAcl(server);
  } finally {
    await ingest?.end();
    await api?.end();
    await owner?.end();
    await admin.end();
    await stopPostgres(server);
  }
});
