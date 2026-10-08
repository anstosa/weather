import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runMigrations } from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = join(repositoryRoot, "packages/database/migrations");
const runtimeAclPath = join(repositoryRoot, "deploy/postgres/runtime-acl-v2.sql");
const commonPath = join(repositoryRoot, "deploy/scripts/common.sh");

// hash one exact utf-8 identity preimage
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// install login-capable test roles with production ownership shape
async function prepareRoles(admin) {
  await createRuntimeRoles(admin);
  await admin.query(`
    ALTER ROLE weather_owner LOGIN PASSWORD 'owner-test';
    ALTER DATABASE weather_test OWNER TO weather_owner;
    ALTER SCHEMA public OWNER TO weather_owner;
  `);
}

// apply the real runtime acl inside the disposable container
async function applyRuntimeAcl(server, database = "weather_test") {
  await executeFile("docker", ["cp", runtimeAclPath, `${server.name}:/tmp/runtime-acl-v2.sql`]);
  await executeFile("docker", [
    "exec",
    server.name,
    "psql",
    "--username",
    server.user,
    "--dbname",
    database,
    "--file",
    "/tmp/runtime-acl-v2.sql",
  ]);
}

// run the production verifier against one disposable container
async function verifyRuntimeAcl(server) {
  return executeFile("bash", [
    "-c",
    `source "$1"
container_name=$2
# route one compose database command
compose() {
  [[ "$1" == exec && "$2" == -T && "$3" == postgres ]] || return 1
  shift 3
  docker exec -i "$container_name" "$@"
}
verify_runtime_database_acl /unused.env weather_test`,
    "adjustment-maintenance-v2",
    commonPath,
    server.name,
  ], { timeout: 30_000 });
}

// activate only one exact role in one disposable database
async function activate(admin, role) {
  await admin.query(`ALTER ROLE ${role} IN DATABASE weather_test
    SET weather.adjustment_maintenance_v2_enabled = 'on'`);
}

// call an owner function with transaction-local anchor proof
async function callWithAnchor(owner, settings, sql, parameters) {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    // install only the supplied root-wrapper proof fields
    for (const [name, value] of Object.entries(settings)) {
      await client.query("SELECT set_config($1, $2, true)", [name, value]);
    }
    const result = await client.query(sql, parameters);
    // require function-local trigger context cleanup
    const operation = await client.query(
      "SELECT current_setting('weather.adjustment_maintenance_operation', true) AS value",
    );
    assert.equal(operation.rows[0].value ?? "", "");
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// prove the closed c/t/f metadata boundary against PostgreSQL 17
test("adjustment maintenance v2 is inactive, value-free, role-closed, and idempotent", {
  timeout: 240_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-maintenance-v2");
  const admin = createTestPool(server);
  let owner;
  let api;
  let ingest;
  let exporter;
  try {
    await prepareRoles(admin);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, migrationDirectory);
    await applyRuntimeAcl(server);
    // prove acl reconciliation is idempotent before activation
    await applyRuntimeAcl(server);
    await verifyRuntimeAcl(server);
    await owner.query(
      "GRANT SELECT ON adjustment_shadow_predictions_v2 TO weather_api",
    );
    await assert.rejects(
      verifyRuntimeAcl(server),
      (error) => error?.stderr?.includes("runtime database ACL verification failed"),
    );
    await applyRuntimeAcl(server);
    await owner.query(
      "ALTER FUNCTION adjustment_confirmation_availability_v2(text) VOLATILE",
    );
    await assert.rejects(
      verifyRuntimeAcl(server),
      (error) => error?.stderr?.includes("runtime database ACL verification failed"),
    );
    await owner.query(
      "ALTER FUNCTION adjustment_confirmation_availability_v2(text) STABLE",
    );
    await verifyRuntimeAcl(server);
    api = createTestPool(server, "weather_test", "weather_api", "api-test");
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    exporter = createTestPool(
      server,
      "weather_test",
      "weather_training_export",
      "training-export-test",
    );

    const graph = await admin.query(`
      SELECT procedure.proname, procedure.prosecdef, procedure.provolatile,
        procedure.proowner = 'weather_owner'::regrole AS owner_ok,
        procedure.proconfig
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN (
          'weather_register_adjustment_shadow_v2',
          'weather_append_adjustment_temperature_shadow_v2',
          'weather_append_adjustment_wind_shadow_v2',
          'weather_append_adjustment_rain_shadow_v2',
          'adjustment_shadow_body_admission_v2',
          'weather_finalize_adjustment_shadow_metadata_v2',
          'weather_record_adjustment_confirmation_access_v2',
          'adjustment_confirmation_availability_v2',
          'adjustment_confirmation_export_v2'
        )
      ORDER BY procedure.proname
    `);
    assert.equal(graph.rowCount, 9);
    // require every exposed api to be an owner-controlled hardened definer
    for (const row of graph.rows) {
      assert.equal(row.prosecdef, true);
      assert.equal(row.owner_ok, true);
      assert.deepEqual(row.proconfig, ["search_path=pg_catalog, public"]);
      assert.equal(
        row.provolatile,
        [
          "adjustment_confirmation_availability_v2",
          "adjustment_confirmation_export_v2",
          "adjustment_shadow_body_admission_v2",
        ].includes(row.proname) ? "s" : "v",
      );
    }
    const valueColumns = await admin.query(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (
          'adjustment_shadow_registrations_v2',
          'adjustment_shadow_predictions_v2',
          'adjustment_confirmation_accesses_v2'
        )
        AND data_type IN ('json', 'jsonb', 'numeric', 'real', 'double precision')
    `);
    assert.deepEqual(valueColumns.rows, []);
    assert.equal(
      (await admin.query(`SELECT count(*)::integer AS count FROM pg_trigger trigger
        JOIN pg_class relation ON relation.oid = trigger.tgrelid
        WHERE relation.relname IN (
          'adjustment_shadow_registrations_v2',
          'adjustment_shadow_predictions_v2',
          'adjustment_confirmation_accesses_v2'
        ) AND NOT trigger.tgisinternal`)).rows[0].count,
      9,
    );

    const privileges = await admin.query(`
      SELECT
        has_function_privilege('weather_api',
          'weather_register_adjustment_shadow_v2(jsonb)', 'EXECUTE') AS api_register,
        has_function_privilege('weather_api',
          'weather_append_adjustment_temperature_shadow_v2(jsonb)', 'EXECUTE') AS api_temperature,
        has_function_privilege('weather_api',
          'weather_append_adjustment_rain_shadow_v2(jsonb)', 'EXECUTE') AS api_rain,
        has_function_privilege('weather_ingest',
          'weather_append_adjustment_rain_shadow_v2(jsonb)', 'EXECUTE') AS ingest_rain,
        has_function_privilege('weather_ingest',
          'weather_append_adjustment_wind_shadow_v2(jsonb)', 'EXECUTE') AS ingest_wind,
        has_function_privilege('weather_training_export',
          'adjustment_confirmation_availability_v2(text)', 'EXECUTE') AS export_availability,
        has_function_privilege('weather_training_export',
          'weather_finalize_adjustment_shadow_metadata_v2(jsonb)', 'EXECUTE') AS export_finalize,
        has_table_privilege('weather_api',
          'adjustment_shadow_predictions_v2', 'SELECT') AS api_table,
        has_table_privilege('weather_training_export',
          'adjustment_confirmation_accesses_v2', 'SELECT') AS export_table
    `);
    assert.deepEqual(privileges.rows[0], {
      api_register: true,
      api_temperature: true,
      api_rain: false,
      ingest_rain: true,
      ingest_wind: false,
      export_availability: true,
      export_finalize: false,
      api_table: false,
      export_table: false,
    });

    const clocks = (await owner.query(`
      WITH local_bounds AS (
        SELECT (clock_timestamp() AT TIME ZONE 'America/Los_Angeles')::date + 2
          AS start_date
      ), cycle AS (
        SELECT candidate
        FROM local_bounds,
        LATERAL (
          SELECT (day::date + make_interval(hours => hour, mins => 35))
            AT TIME ZONE 'UTC' AS candidate
          FROM generate_series(start_date - 3, start_date, interval '1 day') day
          CROSS JOIN unnest(ARRAY[0, 6, 12, 18]) hour
        ) candidates
        WHERE candidate <= clock_timestamp() - interval '1 hour'
        ORDER BY candidate DESC
        LIMIT 1
      )
      SELECT
        start_date::timestamp AT TIME ZONE 'America/Los_Angeles' AS interval_start,
        (start_date + 366)::timestamp AT TIME ZONE 'America/Los_Angeles' AS interval_end,
        ((start_date + 366)::timestamp AT TIME ZONE 'America/Los_Angeles')
          + interval '7 days' AS target_cutoff,
        candidate AS due_at
      FROM local_bounds, cycle
    `)).rows[0];
    const registration = {
      artifactSha256: "b".repeat(64),
      candidateSha256: "a".repeat(64),
      cohortSha256: "d".repeat(64),
      family: "temperature",
      intervalEndAt: clocks.interval_end.toISOString(),
      intervalStartAt: clocks.interval_start.toISOString(),
      policySha256: "c".repeat(64),
      registrationSha256: "",
      reservedKeySha256: "e".repeat(64),
      siteKey: "ballydidean",
      sourceSha256: "f".repeat(64),
      targetCutoffAt: clocks.target_cutoff.toISOString(),
      terminalAt: clocks.target_cutoff.toISOString(),
    };
    registration.registrationSha256 = sha256([
      "adjustment-shadow-registration/v2",
      registration.siteKey,
      registration.family,
      registration.candidateSha256,
      registration.artifactSha256,
      registration.policySha256,
      registration.cohortSha256,
      registration.reservedKeySha256,
      registration.sourceSha256,
      registration.intervalStartAt,
      registration.intervalEndAt,
      registration.targetCutoffAt,
      registration.terminalAt,
    ].join("\n"));

    await assert.rejects(
      api.query("SELECT weather_register_adjustment_shadow_v2($1)", [registration]),
      /inactive/u,
    );
    // prove a caller-set custom guc cannot forge catalog activation
    await api.query("SET weather.adjustment_maintenance_v2_enabled = 'on'");
    await assert.rejects(
      api.query("SELECT weather_register_adjustment_shadow_v2($1)", [registration]),
      /inactive/u,
    );
    await api.query("RESET weather.adjustment_maintenance_v2_enabled");
    await Promise.all([
      activate(admin, "weather_owner"),
      activate(admin, "weather_api"),
      activate(admin, "weather_ingest"),
      activate(admin, "weather_training_export"),
    ]);

    const registered = await api.query(
      "SELECT weather_register_adjustment_shadow_v2($1) AS receipt",
      [registration],
    );
    assert.deepEqual(registered.rows[0].receipt, {
      inserted: true,
      registrationSha256: registration.registrationSha256,
    });
    assert.equal(
      (await api.query("SELECT weather_register_adjustment_shadow_v2($1) AS receipt", [
        registration,
      ])).rows[0].receipt.inserted,
      false,
    );
    await assert.rejects(
      ingest.query("SELECT weather_register_adjustment_shadow_v2($1)", [registration]),
      /unauthorized/u,
    );
    await assert.rejects(
      api.query("SELECT * FROM adjustment_shadow_registrations_v2"),
      /permission denied/u,
    );
    await assert.rejects(
      owner.query(`INSERT INTO adjustment_shadow_registrations_v2 (
        registration_sha256, site_key, family, candidate_sha256, artifact_sha256,
        policy_sha256, cohort_sha256, reserved_key_sha256, source_sha256,
        interval_start_at, interval_end_at, target_cutoff_at, terminal_at, registered_at
      ) VALUES (NULL, 'ballydidean', 'wind', $1, $1, $1, $1, $1, $1,
        $2, $3, $4, $4, NULL)`, ["1".repeat(64), clocks.interval_start,
        clocks.interval_end, clocks.target_cutoff]),
      /closed function context/u,
    );

    const schemaSha256 = "eb9930a1e12919d6f35feb2d402b87b336859b24f031f0e2e3d99168716dc0cd";
    const jitteredIssuedAt = new Date(clocks.due_at.getTime() + 300_123);
    const prediction = {
      bodyByteCount: 2048,
      dueKey: `capture/${clocks.due_at.toISOString()}`,
      inputSha256: "2".repeat(64),
      issuedAt: jitteredIssuedAt.toISOString(),
      maxValidAt: new Date(clocks.interval_start.getTime() + 11 * 3_600_000).toISOString(),
      minValidAt: clocks.interval_start.toISOString(),
      predictionBodySha256: "3".repeat(64),
      predictionSchemaSha256: schemaSha256,
      predictionSha256: "",
      registrationSha256: registration.registrationSha256,
      rowCount: 12,
      sourceReceiptSha256: "4".repeat(64),
    };
    prediction.predictionSha256 = sha256([
      "adjustment-shadow-prediction/v2",
      prediction.registrationSha256,
      prediction.dueKey,
      prediction.issuedAt,
      prediction.minValidAt,
      prediction.maxValidAt,
      prediction.sourceReceiptSha256,
      prediction.inputSha256,
      prediction.predictionBodySha256,
      prediction.predictionSchemaSha256,
      String(prediction.rowCount),
      String(prediction.bodyByteCount),
    ].join("\n"));
    await assert.rejects(
      api.query("SELECT weather_append_adjustment_temperature_shadow_v2($1)", [{
        ...prediction,
        rowCount: 13,
      }]),
      /body bounds/u,
    );
    await assert.rejects(
      api.query("SELECT weather_append_adjustment_temperature_shadow_v2($1)", [{
        ...prediction,
        bodyByteCount: 8193,
      }]),
      /body bounds/u,
    );
    await assert.rejects(
      api.query("SELECT weather_append_adjustment_temperature_shadow_v2($1)", [{
        ...prediction,
        issuedAt: prediction.issuedAt.replace(/Z$/u, "+00:00"),
      }]),
      /prediction object is invalid/u,
    );
    await assert.rejects(
      api.query("SELECT weather_append_adjustment_temperature_shadow_v2($1)", [{
        ...prediction,
        dueKey: `capture/${new Date(clocks.due_at.getTime() + 86_400_000).toISOString()}`,
      }]),
      /due key or clocks/u,
    );
    await assert.rejects(
      api.query("SELECT weather_append_adjustment_temperature_shadow_v2($1)", [{
        ...prediction,
        dueKey: `capture/${new Date(clocks.due_at.getTime() - 2 * 86_400_000).toISOString()}`,
      }]),
      /due key or clocks/u,
    );
    const appended = (await api.query(
      "SELECT weather_append_adjustment_temperature_shadow_v2($1) AS receipt",
      [prediction],
    )).rows[0].receipt;
    assert.equal(appended.inserted, true);
    assert.equal(appended.predictionSha256, prediction.predictionSha256);
    assert.match(appended.committedAt, /^\d{4}-\d{2}-\d{2}T/u);
    const retried = (await api.query(
      "SELECT weather_append_adjustment_temperature_shadow_v2($1) AS receipt",
      [prediction],
    )).rows[0].receipt;
    assert.match(prediction.issuedAt, /[.]123Z$/u);
    assert.equal(retried.inserted, false);
    assert.equal(retried.committedAt, appended.committedAt);
    await assert.rejects(
      api.query("SELECT weather_append_adjustment_wind_shadow_v2($1)", [prediction]),
      /family or schema/u,
    );
    assert.equal((await api.query(
      "SELECT adjustment_shadow_body_admission_v2($1,$2,$3,$4) AS admitted",
      [registration.registrationSha256, prediction.dueKey,
        prediction.predictionBodySha256, prediction.bodyByteCount],
    )).rows[0].admitted, true);
    assert.equal((await api.query(
      "SELECT adjustment_shadow_body_admission_v2($1,$2,$3,$4) AS admitted",
      [registration.registrationSha256, prediction.dueKey, "5".repeat(64),
        prediction.bodyByteCount],
    )).rows[0].admitted, false);
    await assert.rejects(
      owner.query("UPDATE adjustment_shadow_registrations_v2 SET family = family"),
      /immutable/u,
    );
    await assert.rejects(
      owner.query("DELETE FROM adjustment_shadow_predictions_v2"),
      /immutable/u,
    );
    await assert.rejects(
      owner.query("TRUNCATE adjustment_shadow_predictions_v2"),
      /not truncatable/u,
    );

    const available = (await exporter.query(
      "SELECT adjustment_confirmation_availability_v2($1) AS availability",
      [registration.registrationSha256],
    )).rows[0].availability;
    assert.equal(available.hotPredictionCount, 1);
    assert.equal(available.hotPredictions[0].predictionSha256, prediction.predictionSha256);
    assert.equal(JSON.stringify(available).includes(prediction.predictionBodySha256), false);
    await assert.rejects(
      exporter.query("SELECT * FROM adjustment_shadow_predictions_v2"),
      /permission denied/u,
    );
    await assert.rejects(
      exporter.query("SELECT adjustment_confirmation_export_v2($1,$2,0::smallint)", [
        registration.registrationSha256,
        "6".repeat(64),
      ]),
      /no rows/u,
    );

    const manifest = (await owner.query(`
      SELECT encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
        'bodyByteCount', prediction.body_byte_count,
        'committedAt', to_char(prediction.committed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'dueKey', prediction.due_key,
        'inputSha256', prediction.input_sha256,
        'issuedAt', to_char(prediction.issued_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'maxValidAt', to_char(prediction.max_valid_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'minValidAt', to_char(prediction.min_valid_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'predictionBodySha256', prediction.prediction_body_sha256,
        'predictionSchemaSha256', prediction.prediction_schema_sha256,
        'predictionSha256', prediction.prediction_sha256,
        'rowCount', prediction.row_count,
        'sourceReceiptSha256', prediction.source_receipt_sha256
      ) ORDER BY prediction.prediction_sha256), '[]'::jsonb)::text, 'UTF8')), 'hex')
        AS sha256
      FROM adjustment_shadow_predictions_v2 prediction
      WHERE registration_sha256 = $1
    `, [registration.registrationSha256])).rows[0].sha256;
    const emptyRoot = sha256("[]");
    const transferAnchor = "7".repeat(64);
    const coldCommit = "8".repeat(64);
    const successor = sha256([
      emptyRoot,
      manifest,
      "1",
      "1",
      appended.committedAt,
      coldCommit,
      transferAnchor,
    ].join("\n"));
    const finalization = {
      coldCommitSha256: coldCommit,
      expectedPreviousMetadataRootSha256: emptyRoot,
      finalDisposition: "retain",
      fromCommittedAt: appended.committedAt,
      generation: 1,
      maintenanceAnchorSha256: transferAnchor,
      metadataManifestSha256: manifest,
      newMetadataRootSha256: successor,
      registrationSha256: registration.registrationSha256,
      rowCount: 1,
      throughCommittedAt: appended.committedAt,
    };
    await assert.rejects(
      owner.query("SELECT weather_finalize_adjustment_shadow_metadata_v2($1)", [
        finalization,
      ]),
      /anchor is unavailable/u,
    );
    await assert.rejects(
      callWithAnchor(owner, {
        "weather.adjustment_maintenance_anchor_kind": "shadow_metadata_transfer",
        "weather.adjustment_maintenance_anchor_sha256": transferAnchor,
      }, "SELECT weather_finalize_adjustment_shadow_metadata_v2($1)", [{
        ...finalization,
        newMetadataRootSha256: "0".repeat(64),
      }]),
      /manifest is invalid/u,
    );
    assert.deepEqual((await owner.query(`
      SELECT registration.metadata_generation,
        count(prediction.*)::integer AS prediction_count
      FROM adjustment_shadow_registrations_v2 registration
      LEFT JOIN adjustment_shadow_predictions_v2 prediction
        ON prediction.registration_sha256 = registration.registration_sha256
      WHERE registration.registration_sha256 = $1
      GROUP BY registration.metadata_generation
    `, [registration.registrationSha256])).rows[0], {
      metadata_generation: 0,
      prediction_count: 1,
    });
    const finalized = await callWithAnchor(owner, {
      "weather.adjustment_maintenance_anchor_kind": "shadow_metadata_transfer",
      "weather.adjustment_maintenance_anchor_sha256": transferAnchor,
    }, "SELECT weather_finalize_adjustment_shadow_metadata_v2($1) AS receipt", [
      finalization,
    ]);
    assert.equal(finalized.rows[0].receipt.status, "finalized");
    assert.equal((await owner.query(
      "SELECT count(*)::integer AS count FROM adjustment_shadow_predictions_v2",
    )).rows[0].count, 0);
    const finalizedRetry = await callWithAnchor(owner, {
      "weather.adjustment_maintenance_anchor_kind": "shadow_metadata_transfer",
      "weather.adjustment_maintenance_anchor_sha256": transferAnchor,
    }, "SELECT weather_finalize_adjustment_shadow_metadata_v2($1) AS receipt", [
      finalization,
    ]);
    assert.equal(finalizedRetry.rows[0].receipt.status, "already_finalized");
    const coldAvailability = (await exporter.query(
      "SELECT adjustment_confirmation_availability_v2($1) AS availability",
      [registration.registrationSha256],
    )).rows[0].availability;
    assert.equal(coldAvailability.hotPredictionCount, 0);
    assert.equal(coldAvailability.missingExpectedDueKeys, null);
    assert.equal(
      coldAvailability.missingExpectedDueKeysStatus,
      "requires_anchored_cold_reconstruction",
    );
    assert.equal(coldAvailability.expectedKeySetSha256, registration.reservedKeySha256);

    // seed only historical terminal clocks in the disposable database
    await owner.query(`ALTER TABLE adjustment_shadow_registrations_v2
      DISABLE TRIGGER adjustment_shadow_registrations_v2_guard_mutation`);
    try {
      await owner.query(`
      UPDATE adjustment_shadow_registrations_v2
      SET interval_start_at = timestamptz '2024-01-01 08:00:00+00',
          interval_end_at = timestamptz '2025-01-01 08:00:00+00',
          target_cutoff_at = timestamptz '2025-01-08 08:00:00+00',
          terminal_at = timestamptz '2025-01-08 08:00:00+00'
      WHERE registration_sha256 = $1
      `, [registration.registrationSha256]);
    } finally {
      // restore mutation enforcement after the historical fixture
      await owner.query(`ALTER TABLE adjustment_shadow_registrations_v2
        ENABLE TRIGGER adjustment_shadow_registrations_v2_guard_mutation`);
    }
    const hotRoot = sha256("[]");
    const combinedMetadataRoot = sha256([
      successor,
      hotRoot,
      "1",
      "0",
      "1",
    ].join("\n"));
    const access = {
      accessSha256: "",
      eligiblePredictionSetSha256: "9".repeat(64),
      expectedKeySetSha256: registration.reservedKeySha256,
      gateManifestSha256: "a".repeat(64),
      journalHeadSha256: "b".repeat(64),
      maintenanceAnchorSha256: "c".repeat(64),
      metadataRootSha256: combinedMetadataRoot,
      registrationSha256: registration.registrationSha256,
      revisionCatalogWatermarkSha256: "d".repeat(64),
      targetComparatorSnapshotRootSha256: "e".repeat(64),
      targetCutoffAt: "2025-01-08T08:00:00.000Z",
    };
    access.accessSha256 = sha256([
      "adjustment-confirmation-access/v2",
      access.registrationSha256,
      access.journalHeadSha256,
      access.maintenanceAnchorSha256,
      access.gateManifestSha256,
      access.eligiblePredictionSetSha256,
      access.expectedKeySetSha256,
      access.metadataRootSha256,
      access.targetComparatorSnapshotRootSha256,
      access.revisionCatalogWatermarkSha256,
      access.targetCutoffAt,
    ].join("\n"));
    const accessed = await callWithAnchor(owner, {
      "weather.adjustment_maintenance_anchor_kind": "confirmation_accessed",
      "weather.adjustment_maintenance_anchor_sha256": access.maintenanceAnchorSha256,
      "weather.adjustment_eligible_prediction_set_sha256":
        access.eligiblePredictionSetSha256,
    }, "SELECT weather_record_adjustment_confirmation_access_v2($1) AS receipt", [access]);
    assert.equal(accessed.rows[0].receipt.inserted, true);
    const accessedRetry = await callWithAnchor(owner, {
      "weather.adjustment_maintenance_anchor_kind": "confirmation_accessed",
      "weather.adjustment_maintenance_anchor_sha256": access.maintenanceAnchorSha256,
      "weather.adjustment_eligible_prediction_set_sha256":
        access.eligiblePredictionSetSha256,
    }, "SELECT weather_record_adjustment_confirmation_access_v2($1) AS receipt", [access]);
    assert.equal(accessedRetry.rows[0].receipt.inserted, false);

    const firstChunk = (await exporter.query(
      "SELECT adjustment_confirmation_export_v2($1,$2,0::smallint) AS authorization",
      [registration.registrationSha256, access.accessSha256],
    )).rows[0].authorization;
    const lastChunk = (await exporter.query(
      "SELECT adjustment_confirmation_export_v2($1,$2,26::smallint) AS authorization",
      [registration.registrationSha256, access.accessSha256],
    )).rows[0].authorization;
    assert.deepEqual(
      [firstChunk.chunkCount, firstChunk.fromLocalDate, firstChunk.toLocalDateExclusive],
      [27, "2024-01-01", "2024-01-15"],
    );
    assert.deepEqual(
      [lastChunk.chunkIndex, lastChunk.fromLocalDate, lastChunk.toLocalDateExclusive],
      [26, "2024-12-30", "2025-01-01"],
    );
    await assert.rejects(
      exporter.query("SELECT adjustment_confirmation_export_v2($1,$2,27::smallint)", [
        registration.registrationSha256,
        access.accessSha256,
      ]),
      /invalid/u,
    );
    await assert.rejects(
      api.query("SELECT weather_finalize_adjustment_shadow_metadata_v2($1)", [
        finalization,
      ]),
      /permission denied/u,
    );
  } finally {
    await Promise.all([
      admin.end(),
      owner?.end(),
      api?.end(),
      ingest?.end(),
      exporter?.end(),
    ]);
    await stopPostgres(server);
  }
});

// prove the acl accepts an absent graph and rejects a partial graph
test("runtime acl preserves 0017 images but rejects partial 0018 state", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-maintenance-v2-compat");
  const admin = createTestPool(server);
  const prefix = await mkdtemp(join(tmpdir(), "weather-0017-prefix-"));
  let owner;
  try {
    await prepareRoles(admin);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    const names = (await readdir(migrationDirectory)).sort();
    // retain the exact immutable migration prefix
    for (const name of names.filter((name) => name < "0018_")) {
      await copyFile(join(migrationDirectory, name), join(prefix, name));
    }
    await runMigrations(owner, prefix);
    await applyRuntimeAcl(server);
    await verifyRuntimeAcl(server);
    assert.equal((await owner.query(
      "SELECT to_regclass('public.adjustment_shadow_registrations_v2') AS relation",
    )).rows[0].relation, null);
    await owner.query("CREATE TABLE adjustment_shadow_registrations_v2 (id integer)");
    await assert.rejects(
      applyRuntimeAcl(server),
      /adjustment maintenance v2 schema is incomplete/u,
    );
  } finally {
    await Promise.all([admin.end(), owner?.end()]);
    await stopPostgres(server);
    await rm(prefix, { recursive: true, force: true });
  }
});
