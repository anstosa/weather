import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  RAIN_COLLECTION_STATIONS,
  canonicalizeJson,
  createNormalizedWeatherRecord,
  weatherRecordContent,
} from "@weather/domain";

import {
  RAIN_FIXED_GAUGE_TARGET_CATALOG_SHA256,
  RAIN_FIXED_GAUGE_TARGET_RUN_CONTRACT_SHA256,
  commitRainFixedGaugeTargetRevisionGroup,
  readPendingRainFixedGaugeTargetCaptures,
  readRainFixedGaugeTargetSourceCatalog,
  runMigrations,
} from "../dist/index.js";
import {
  RAIN_FIXED_GAUGE_TARGET_RUN_CONTRACT_SHA256 as DEPLOY_RUN_CONTRACT_SHA256,
  RAIN_FIXED_GAUGE_TARGET_SOURCE_CATALOG_SHA256 as DEPLOY_CATALOG_SHA256,
  buildAdjustmentRainFixedGaugeTargetSourceInitializationSql,
} from "../../../deploy/scripts/adjustment-evaluation-package.mjs";
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
const HOUR_MS = 3_600_000;

// apply the production runtime grants to the disposable database
async function applyRuntimeAcl(server) {
  await executeFile("docker", ["cp", runtimeAclPath, `${server.name}:/tmp/runtime-acl-v2.sql`]);
  await executeFile("docker", ["exec", server.name, "psql", "--set=ON_ERROR_STOP=1",
    "--username", server.user, "--dbname", "weather_test", "--file",
    "/tmp/runtime-acl-v2.sql"]);
}

// install only the site required by the closed owner source initializer
async function prepareOwnerDatabase(server, admin) {
  await createRuntimeRoles(admin);
  await admin.query(`
    ALTER ROLE weather_owner LOGIN PASSWORD 'owner-test';
    ALTER DATABASE weather_test OWNER TO weather_owner;
    ALTER SCHEMA public OWNER TO weather_owner;
  `);
  const owner = createTestPool(server, "weather_test", "weather_owner", "owner-test");
  await runMigrations(owner, migrationDirectory);
  await owner.query(`
    INSERT INTO sites (slug, display_name, latitude, longitude, timezone, active)
    VALUES ('ballydidean', 'Ballydidean', 47.950429954185445,
      -122.42797012608193, 'America/Los_Angeles', true)
  `);
  await owner.query(buildAdjustmentRainFixedGaugeTargetSourceInitializationSql());
  return owner;
}

// create one canonical hourly target row for a dedicated source
function targetRow(source, validAt, receivedAt, amount) {
  const station = RAIN_COLLECTION_STATIONS.find(
    // bind the database catalog back to the frozen gauge
    (candidate) => candidate.locationId === source.locationId,
  );
  assert.ok(station);
  const normalizedRecord = createNormalizedWeatherRecord({
    metadata: {
      device: { model: "Tempest", serial: station.serial, vendor: "WeatherFlow" },
      model: null,
      provider: { dataset: "rain-fixed-gauge-target/v1" },
      quality: { flags: [] },
      upstreamTimezone: "America/Los_Angeles",
    },
    metrics: {
      apparentTemperatureC: null,
      blackGlobeTemperatureC: null,
      cloudCoverPercent: null,
      pm25MicrogramsPerCubicMeter: null,
      precipitationMm: amount,
      precipitationRateMmPerHour: amount,
      pressureHpa: null,
      relativeHumidityPercent: null,
      soilElectricalConductivityMicrosiemensPerCm: null,
      soilMoisturePercent: null,
      solarRadiationWm2: null,
      temperatureC: 10 + amount,
      uvIndex: null,
      waterLevelM: null,
      wetBulbGlobeTemperatureC: null,
      windDirectionDegrees: null,
      windGustMps: null,
      windSpeedMps: null,
    },
    productRunAt: null,
    receivedAt,
    sourceId: source.sourceId,
    sourceKind: "physical_sensor",
    validAt,
  });
  return {
    normalizedRecord,
    stationId: station.locationId,
    storedContentSha256: createHash("sha256")
      .update(weatherRecordContent(normalizedRecord)).digest("hex"),
  };
}

// create one exact staged group over the fixed source order
function targetGroup(catalog, validAt, byte, stageReceiptSha256 = "b".repeat(64)) {
  const projectionIdentitySha256 = byte.repeat(64);
  const logicalKeySha256 = createHash("sha256").update(`${canonicalizeJson({
    contractVersion: "adjustment-rain-fixed-gauge-target-logical-key/v1",
    sourceIds: catalog.sources.map((source) => source.sourceId),
    validAt,
  })}\n`).digest("hex");
  return {
    logicalKeySha256,
    projectionIdentitySha256,
    projectionSha256: projectionIdentitySha256,
    rows: catalog.sources.map(
      // retain exact catalog order in the shared receipt vector
      (source, index) => targetRow(
        source,
        validAt,
        new Date(Date.parse(validAt) + 120_000).toISOString(),
        (index + 1) / 10,
      ),
    ),
    stageReceiptSha256,
    validAt,
  };
}

// seed one complete raw fixed-gauge capture hour without provider I/O
async function seedRawCaptureHour(owner, validAt) {
  await owner.query("ALTER TABLE rain_capture_claims DISABLE TRIGGER USER");
  await owner.query("ALTER TABLE rain_capture_receipts DISABLE TRIGGER USER");
  try {
    // insert one immutable claim and response for every frozen gauge
    for (const station of RAIN_COLLECTION_STATIONS) {
      const body = Buffer.from(JSON.stringify({ device_id: station.deviceId, obs: [] }));
      const bodySha256 = createHash("sha256").update(body).digest("hex");
      const claim = await owner.query(`
        INSERT INTO rain_capture_claims (
          kind, slot_key, station_id, window_start, window_end_exclusive,
          release, policy, policy_sha256, claimed_at
        ) VALUES (
          'station', $1, $2, $3, $4, '2026.10.09-1', '{}'::jsonb,
          repeat('a', 64), $5
        ) RETURNING id
      `, [`station:${String(station.locationId)}:${new Date(Date.parse(validAt) + 1_000).toISOString()}`,
        station.locationId, new Date(Date.parse(validAt) - 2 * HOUR_MS + 1_000).toISOString(),
        new Date(Date.parse(validAt) + 1_000).toISOString(),
        new Date(Date.parse(validAt) + 60_000).toISOString()]);
      await owner.query(`
        INSERT INTO rain_capture_receipts (
          claim_id, started_at, completed_at, http_status, outcome, error_code,
          compressed_body, body_sha256, body_bytes, compressed_bytes,
          parser_version, row_count, available_by_decision, metadata, recorded_at
        ) VALUES (
          $1, $2, $2, 200, 'valid', NULL, $3, $4, $5, $6,
          'rain-prospective-capture/v1', 0, NULL, '{}'::jsonb, $2
        )
      `, [claim.rows[0].id, new Date(Date.parse(validAt) + 60_000).toISOString(),
        gzipSync(body), bodySha256, body.byteLength, gzipSync(body).byteLength]);
    }
  } finally {
    await owner.query("ALTER TABLE rain_capture_claims ENABLE TRIGGER USER");
    await owner.query("ALTER TABLE rain_capture_receipts ENABLE TRIGGER USER");
  }
}

test("rain fixed-gauge targets use twelve isolated sources and atomic revision groups", {
  timeout: 600_000,
}, async () => {
  const server = await startPostgres(17, "rain-fixed-gauge-target");
  const admin = createTestPool(server);
  let owner;
  let ingest;
  let api;

  try {
    owner = await prepareOwnerDatabase(server, admin);
    await applyRuntimeAcl(server);
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    api = createTestPool(server, "weather_test", "weather_api", "api-test");
    assert.equal(RAIN_FIXED_GAUGE_TARGET_CATALOG_SHA256, DEPLOY_CATALOG_SHA256);
    assert.equal(RAIN_FIXED_GAUGE_TARGET_RUN_CONTRACT_SHA256, DEPLOY_RUN_CONTRACT_SHA256);
    const catalog = await readRainFixedGaugeTargetSourceCatalog(ingest);
    assert.equal(catalog.sources.length, 12);
    assert.deepEqual(catalog.sources.map((source) => source.locationId),
      RAIN_COLLECTION_STATIONS.map((station) => station.locationId));
    assert.ok(catalog.sources.every(
      // exclude every ordinary scheduled Tempest source identity
      (source) => source.sourceKey === `rain-target-tempest-${String(source.locationId)}`,
    ));
    await assert.rejects(readRainFixedGaugeTargetSourceCatalog(api), /permission denied/u);

    // preserve exact source rows and reject rather than repair drift
    const first = catalog.sources[0];
    await owner.query("UPDATE sources SET active = false WHERE id = $1", [first.sourceId]);
    await assert.rejects(
      owner.query(buildAdjustmentRainFixedGaugeTargetSourceInitializationSql()),
      /rain target source differs/u,
    );
    await owner.query("UPDATE sources SET active = true WHERE id = $1", [first.sourceId]);
    await owner.query(buildAdjustmentRainFixedGaugeTargetSourceInitializationSql());

    const serverNow = (await owner.query("SELECT clock_timestamp() AS now")).rows[0].now;
    const validAt = new Date(
      Math.floor((serverNow.getTime() - 2 * HOUR_MS) / HOUR_MS) * HOUR_MS,
    ).toISOString();
    const epochAt = new Date(Date.parse(validAt) - 24 * HOUR_MS).toISOString();
    await seedRawCaptureHour(owner, validAt);
    const pending = await readPendingRainFixedGaugeTargetCaptures(
      ingest,
      epochAt,
    );
    assert.equal(pending?.validAt, validAt);
    assert.equal(pending?.captures.length, 12);
    assert.deepEqual(pending?.captures.map((capture) => capture.stationId),
      RAIN_COLLECTION_STATIONS.map((station) => station.locationId));

    const committed = await commitRainFixedGaugeTargetRevisionGroup(
      ingest,
      targetGroup(catalog, validAt, "c"),
    );
    assert.equal(committed.state, "committed");
    assert.equal(committed.revisionReceipts.length, 12);
    assert.deepEqual(committed.revisionReceipts.map((receipt) => receipt.archiveCommitOrdinal),
      Array.from({ length: 12 }, (_unused, index) => String(index + 1)));
    assert.equal(await readPendingRainFixedGaugeTargetCaptures(
      ingest,
      epochAt,
    ), null);

    const failedAt = new Date(Date.parse(validAt) + HOUR_MS).toISOString();
    const rejectedSourceId = catalog.sources.at(-1).sourceId;
    await owner.query(`
      CREATE FUNCTION reject_last_rain_target_receipt() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.source_id = ${rejectedSourceId}::bigint
          AND NEW.valid_at = timestamptz '${failedAt}'
          AND NEW.adjustment_revision_receipt->>'contractVersion' =
            'adjustment-revision-commit-receipt/v1' THEN
          RAISE EXCEPTION 'test receipt rejection' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER reject_last_rain_target_receipt
      BEFORE UPDATE ON weather_records
      FOR EACH ROW EXECUTE FUNCTION reject_last_rain_target_receipt();
    `);
    const failed = await commitRainFixedGaugeTargetRevisionGroup(
      ingest,
      targetGroup(catalog, failedAt, "d"),
    );
    assert.equal(failed.state, "gap");
    assert.equal(failed.gap.reason, "database_bind_failed");
    const failedRows = await owner.query(`
      SELECT adjustment_revision_receipt->>'contractVersion' AS version,
        adjustment_revision_receipt->>'logicalKeySha256' AS logical_key
      FROM weather_records
      WHERE valid_at = $1 AND source_id = ANY($2::bigint[])
      ORDER BY source_id
    `, [failedAt, catalog.sources.map((source) => source.sourceId)]);
    assert.equal(failedRows.rowCount, 12);
    assert.deepEqual(new Set(failedRows.rows.map((row) => row.version)),
      new Set(["adjustment-revision-gap-marker/v1"]));
    assert.deepEqual(new Set(failedRows.rows.map((row) => row.logical_key)),
      new Set([failed.gap.logicalKeySha256]));
    const frontier = await owner.query(
      "SELECT archive_commit_ordinal::text AS ordinal FROM adjustment_revision_frontier_v1",
    );
    assert.equal(frontier.rows[0].ordinal, "12");
  } finally {
    await api?.end().catch(() => undefined);
    await ingest?.end().catch(() => undefined);
    await owner?.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await stopPostgres(server);
  }
});
