import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  appendRainAdjustmentShadow,
  appendTemperatureAdjustmentShadow,
  appendWindAdjustmentShadow,
  authorizeTrainingAdjustmentConfirmationChunk,
  isAdjustmentShadowBodyAdmitted,
  readTrainingAdjustmentConfirmationAvailability,
  registerApiAdjustmentShadow,
  registerRainAdjustmentShadow,
  runMigrations,
} from "../dist/index.js";
import {
  createMaintenanceShadowPredictionMetadata,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowValues,
  MAINTENANCE_SHADOW_LIMITS,
  MAINTENANCE_SHADOW_VALUES_VERSION,
} from "../../forecast-adjustment/dist/maintenance-shadow-values.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = resolve(repositoryRoot, "packages/database/migrations");
const runtimeAclPath = resolve(repositoryRoot, "deploy/postgres/runtime-acl-v2.sql");
const HOUR_MS = 3_600_000;

// hash one exact identity preimage
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// derive one registration identity from its exact database preimage
function registrationIdentity(registration) {
  return sha256([
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
}

// build every required lead in one exact family body
function stageShadowBody(family, registration, dueKey, issuedAt) {
  const rows = Array.from({ length: MAINTENANCE_SHADOW_LIMITS[family].rows },
    // preserve the complete ordered lead sequence
    (_, index) => {
      const common = {
        leadHours: index + 1,
        sourceRowSha256: sha256(`${family}-source-row-${index + 1}`),
        validAt: new Date(Date.parse(registration.intervalStartAt) + index * HOUR_MS)
          .toISOString(),
      };
      // retain the exact temperature row schema
      if (family === "temperature") {
        return {
          ...common,
          candidateTemperatureC64: encodeMaintenanceBinary64(12.5),
          wouldApply: true,
          fallbackCode: "none",
        };
      }
      // retain null gust evidence for disabled leads 49 through 72
      if (family === "wind") {
        const gustDisabled = index >= 48 && index < 72;
        return {
          ...common,
          candidateSpeedMps64: encodeMaintenanceBinary64(10),
          candidateGustMps64: gustDisabled ? null : encodeMaintenanceBinary64(20),
          speedWouldApply: true,
          gustWouldApply: !gustDisabled,
        };
      }
      return {
        ...common,
        occurrenceProbability64: encodeMaintenanceBinary64(0.8),
        positiveAmountMm64: encodeMaintenanceBinary64(4),
        candidatePrecipitationMm64: encodeMaintenanceBinary64(3),
        atLeast1_0Probability64: encodeMaintenanceBinary64(0.6),
        atLeast2_5Probability64: encodeMaintenanceBinary64(0.3),
        wouldApply: true,
        fallbackCode: "none",
      };
    });
  return encodeMaintenanceShadowValues({
    contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION,
    family,
    registrationSha256: registration.registrationSha256,
    candidateSha256: registration.candidateSha256,
    dueKey,
    issuedAt,
    sourceReceiptSha256: sha256(`${family}-source-receipt`),
    inputSha256: sha256(`${family}-input`),
    rowCount: rows.length,
    rows,
  });
}

// append exact staged bytes and prove their database admission identity
async function appendStagedBody(
  appendQueryable,
  admissionQueryable,
  appendPrediction,
  family,
  registration,
  bytes,
) {
  const prediction = createMaintenanceShadowPredictionMetadata(bytes);
  assert.equal(prediction.rowCount, MAINTENANCE_SHADOW_LIMITS[family].rows);
  assert.equal(prediction.predictionBodySha256, sha256(bytes));
  const receipt = await appendPrediction(appendQueryable, prediction);
  assert.equal(receipt.predictionSha256, prediction.predictionSha256);
  assert.equal(await isAdjustmentShadowBodyAdmitted(
    admissionQueryable,
    registration.registrationSha256,
    prediction.dueKey,
    prediction.predictionBodySha256,
    prediction.bodyByteCount,
  ), true);
  return { prediction, receipt };
}

// apply the production runtime acl in the disposable container
async function applyRuntimeAcl(server) {
  await executeFile("docker", ["cp", runtimeAclPath, `${server.name}:/tmp/runtime-acl-v2.sql`]);
  await executeFile("docker", [
    "exec",
    server.name,
    "psql",
    "--set=ON_ERROR_STOP=1",
    "--username",
    server.user,
    "--dbname",
    "weather_test",
    "--file",
    "/tmp/runtime-acl-v2.sql",
  ]);
}

// activate one exact role only inside the disposable database
async function activate(admin, role) {
  await admin.query(`ALTER ROLE ${role} IN DATABASE weather_test
    SET weather.adjustment_maintenance_v2_enabled = 'on'`);
}

// prove repository calls against their real runtime login roles
test("adjustment maintenance repositories preserve the PostgreSQL role boundary", {
  timeout: 180_000,
}, async () => {
  const server = await startPostgres(17, "adjustment-maintenance-repository");
  const admin = createTestPool(server);
  let owner;
  let api;
  let ingest;
  let exporter;
  // manage one complete disposable role graph
  try {
    await createRuntimeRoles(admin);
    await admin.query(`
      ALTER ROLE weather_owner LOGIN PASSWORD 'owner-test';
      ALTER DATABASE weather_test OWNER TO weather_owner;
      ALTER SCHEMA public OWNER TO weather_owner;
    `);
    owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
    await runMigrations(owner, migrationDirectory);
    await applyRuntimeAcl(server);
    api = createTestPool(server, "weather_test", "weather_api", "api-test");
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    exporter = createTestPool(
      server,
      "weather_test",
      "weather_training_export",
      "training-export-test",
    );

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
      artifactSha256: "a".repeat(64),
      candidateSha256: "b".repeat(64),
      cohortSha256: "c".repeat(64),
      family: "temperature",
      intervalEndAt: clocks.interval_end.toISOString(),
      intervalStartAt: clocks.interval_start.toISOString(),
      policySha256: "d".repeat(64),
      registrationSha256: "",
      reservedKeySha256: "e".repeat(64),
      siteKey: "ballydidean",
      sourceSha256: "f".repeat(64),
      targetCutoffAt: clocks.target_cutoff.toISOString(),
      terminalAt: clocks.target_cutoff.toISOString(),
    };
    registration.registrationSha256 = registrationIdentity(registration);
    await assert.rejects(registerApiAdjustmentShadow(api, registration), /inactive/u);
    await Promise.all([
      activate(admin, "weather_api"),
      activate(admin, "weather_ingest"),
      activate(admin, "weather_training_export"),
    ]);
    assert.deepEqual(await registerApiAdjustmentShadow(api, registration), {
      inserted: true,
      registrationSha256: registration.registrationSha256,
    });
    assert.equal((await registerApiAdjustmentShadow(api, registration)).inserted, false);
    await assert.rejects(
      registerApiAdjustmentShadow(ingest, registration),
      /unauthorized/u,
    );

    const windRegistration = {
      ...registration,
      artifactSha256: "8".repeat(64),
      candidateSha256: "9".repeat(64),
      family: "wind",
      registrationSha256: "",
    };
    windRegistration.registrationSha256 = registrationIdentity(windRegistration);
    assert.equal((await registerApiAdjustmentShadow(api, windRegistration)).inserted, true);

    const rainRegistration = {
      ...registration,
      artifactSha256: "7".repeat(64),
      candidateSha256: "7".repeat(64),
      family: "rain",
      registrationSha256: "1".repeat(64),
    };
    await assert.rejects(
      registerRainAdjustmentShadow(api, rainRegistration),
      /permission denied|unauthorized/u,
    );

    const issuedAt = new Date(clocks.due_at.getTime() + 300_123).toISOString();
    const dueKey = `capture/${clocks.due_at.toISOString()}`;
    const temperatureBytes = stageShadowBody(
      "temperature", registration, dueKey, issuedAt,
    );
    const { prediction, receipt: appended } = await appendStagedBody(
      api,
      api,
      appendTemperatureAdjustmentShadow,
      "temperature",
      registration,
      temperatureBytes,
    );
    assert.match(appended.committedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    assert.equal((await appendTemperatureAdjustmentShadow(api, prediction)).committedAt,
      appended.committedAt);
    const windBytes = stageShadowBody("wind", windRegistration, dueKey, issuedAt);
    await appendStagedBody(
      api,
      api,
      appendWindAdjustmentShadow,
      "wind",
      windRegistration,
      windBytes,
    );
    // seed one nonproduction rain registration without relying on the finite live window
    await owner.query(`ALTER TABLE adjustment_shadow_registrations_v2
      DISABLE TRIGGER adjustment_shadow_registrations_v2_guard_insert`);
    // isolate the temporary trigger bypass
    try {
      await owner.query(`INSERT INTO adjustment_shadow_registrations_v2 (
        registration_sha256, site_key, family, candidate_sha256, artifact_sha256,
        policy_sha256, cohort_sha256, reserved_key_sha256, source_sha256,
        interval_start_at, interval_end_at, target_cutoff_at, terminal_at, registered_at
      ) VALUES ($1, 'ballydidean', 'rain', $2, $2, $2, $2, $2, $2,
        $3, $4, $5, $5, clock_timestamp())`, [
        rainRegistration.registrationSha256,
        rainRegistration.candidateSha256,
        registration.intervalStartAt,
        registration.intervalEndAt,
        registration.targetCutoffAt,
      ]);
    } finally {
      // restore insert enforcement after the disposable fixture
      await owner.query(`ALTER TABLE adjustment_shadow_registrations_v2
        ENABLE TRIGGER adjustment_shadow_registrations_v2_guard_insert`);
    }
    const rainBytes = stageShadowBody("rain", rainRegistration, dueKey, issuedAt);
    const rainRows = JSON.parse(rainBytes).rows;
    assert.deepEqual(
      Object.keys(rainRows[0]).filter((key) => key.endsWith("Probability64")),
      ["occurrenceProbability64", "atLeast1_0Probability64", "atLeast2_5Probability64"],
    );
    const { prediction: rainPrediction } = await appendStagedBody(
      ingest,
      api,
      appendRainAdjustmentShadow,
      "rain",
      rainRegistration,
      rainBytes,
    );
    await assert.rejects(appendRainAdjustmentShadow(api, rainPrediction), /permission denied/u);

    const stored = (await owner.query(`
      SELECT to_char(committed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS committed_at,
        committed_at < min_valid_at AS before_valid
      FROM adjustment_shadow_predictions_v2
      WHERE prediction_sha256 = $1
    `, [prediction.predictionSha256])).rows[0];
    assert.deepEqual(stored, {
      before_valid: true,
      committed_at: appended.committedAt,
    });
    const availability = await readTrainingAdjustmentConfirmationAvailability(
      exporter,
      registration.registrationSha256,
    );
    assert.equal(availability.hotPredictionCount, 1);
    assert.equal(availability.hotPredictions[0].predictionSha256,
      prediction.predictionSha256);
    assert.equal(JSON.stringify(availability).includes(prediction.predictionBodySha256), false);
    await assert.rejects(
      authorizeTrainingAdjustmentConfirmationChunk(
        exporter,
        registration.registrationSha256,
        "5".repeat(64),
        0,
      ),
      /no rows/u,
    );
  } finally {
    // close every disposable connection before removing the server
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
