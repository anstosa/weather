import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import test from "node:test";

import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";

import {
  appendRainCaptureReceipt,
  claimRainCaptureSlot,
  readRainCollectionStatus,
  runMigrations,
} from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = join(repositoryRoot, "packages/database/migrations");
const runtimeAclPath = join(repositoryRoot, "deploy/postgres/runtime-acl-v2.sql");
const executeFile = promisify(execFile);
const HOUR_MS = 3_600_000;

// apply the same runtime grants used during deployment
async function applyAcl(server) {
  await executeFile("docker", ["cp", runtimeAclPath, `${server.name}:/tmp/runtime-acl-v2.sql`]);
  await executeFile("docker", ["exec", server.name, "psql", "--set=ON_ERROR_STOP=1",
    "--username", server.user, "--dbname", "weather_test", "--file", "/tmp/runtime-acl-v2.sql"]);
}

// choose a current eligible ECMWF cycle without trusting an old test date
function forecastRequest(now) {
  const initialized = Math.floor((now.getTime() - 6 * HOUR_MS) / (6 * HOUR_MS)) * 6 * HOUR_MS;
  const runInitializedAt = new Date(initialized).toISOString();
  const attempt = now.getTime() - initialized < 7 * HOUR_MS ? 1 : 2;
  return { kind: "forecast", slotKey: `forecast:${runInitializedAt}:${attempt}`,
    runInitializedAt, attempt };
}

// choose one complete two-hour station window
function stationRequest(now, stationId) {
  const hour = Math.floor((now.getTime() - 120_000) / HOUR_MS) * HOUR_MS;
  const endExclusive = new Date(hour + 1_000).toISOString();
  return { kind: "station", slotKey: `station:${stationId}:${endExclusive}`,
    stationId, start: new Date(hour + 1_000 - 2 * HOUR_MS).toISOString(), endExclusive };
}

// build one exact-byte transport receipt
function receipt(body, outcome = "valid", httpStatus = 200, availableByDecision = null) {
  const completedAt = new Date().toISOString();
  return {
    startedAt: completedAt,
    completedAt,
    httpStatus,
    body,
    bodySha256: body === null ? null : createHash("sha256").update(body).digest("hex"),
    outcome,
    errorCode: outcome === "valid" ? null : `http_${String(httpStatus)}`,
    parserVersion: RAIN_COLLECTION_POLICY.contractVersion,
    rowCount: outcome === "valid" ? 49 : 0,
    availableByDecision,
    metadata: {},
  };
}

test("rain claims and raw receipts are bounded private immutable evidence", { timeout: 600_000 }, async () => {
  const server = await startPostgres(17, "rain-collection");
  const owner = createTestPool(server);
  let ingest;
  let api;
  let exporter;

  try {
    await createRuntimeRoles(owner);
    await runMigrations(owner, migrationDirectory);
    await applyAcl(server);
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    api = createTestPool(server, "weather_test", "weather_api", "api-test");
    exporter = createTestPool(server, "weather_test", "weather_training_export", "training-export-test");
    const now = (await owner.query("SELECT clock_timestamp() AS now")).rows[0].now;
    const request = forecastRequest(now);
    const policyJson = JSON.stringify(RAIN_COLLECTION_POLICY);
    const policySha = createHash("sha256").update(policyJson).digest("hex");

    // reject malformed direct SQL even when the caller bypasses TypeScript validation
    await assert.rejects(ingest.query(`
      INSERT INTO rain_capture_claims
        (kind, slot_key, run_initialized_at, attempt, release, policy, policy_sha256)
      VALUES ('forecast', $1, $2, 1, '2026.09.13-1', '{}'::jsonb, $3)
    `, [request.slotKey, request.runInitializedAt, policySha]), /policy identity changed/u);
    // reject invalid calendar tags even through direct ingest SQL
    await assert.rejects(ingest.query(`
      INSERT INTO rain_capture_claims
        (kind, slot_key, run_initialized_at, attempt, release, policy, policy_sha256)
      VALUES ('forecast', $1, $2, 1, '2026.02.30-1', $3::jsonb, $4)
    `, [request.slotKey, request.runInitializedAt, policyJson, policySha]),
    /(?:release date is invalid|date\/time field value out of range)/u);
    await assert.rejects(ingest.query(`
      INSERT INTO rain_capture_claims
        (kind, slot_key, run_initialized_at, attempt, release, policy, policy_sha256)
      VALUES ('forecast', $1, $2, NULL, '2026.09.13-1', $3::jsonb, $4)
    `, [request.slotKey, request.runInitializedAt, policyJson, policySha]), /rain_capture_claim_identity/u);
    const claim = await claimRainCaptureSlot(ingest, { request, release: "2026.09.13-1" });
    assert.match(claim, /^[a-f0-9-]{36}$/u);
    assert.equal(await claimRainCaptureSlot(ingest, { request, release: "2026.09.13-1" }), null);

    // preserve a pending attempt without a phantom receipt
    const pending = await readRainCollectionStatus(api);
    assert.equal(pending.claims, 1);
    assert.equal(pending.pendingRequests, 1);
    assert.equal(pending.receipts, 0);
    const directReceiptSql = `
      INSERT INTO rain_capture_receipts (
        claim_id, started_at, completed_at, http_status, outcome, error_code,
        compressed_body, body_sha256, body_bytes, compressed_bytes,
        parser_version, row_count, available_by_decision, metadata
      ) VALUES (
        $1, clock_timestamp(), clock_timestamp(), $2, 'valid', NULL,
        decode('00', 'hex'), repeat('a', 64), 1, $3,
        'rain-prospective-capture/v1', 1,
        clock_timestamp() <= $4::timestamptz + interval '8 hours', '{}'::jsonb
      )
    `;

    // missing status and partial body metadata must fail at the SQL layer
    await assert.rejects(ingest.query(directReceiptSql,
      [claim, null, 1, request.runInitializedAt]), /rain_capture_receipt_outcome/u);
    await assert.rejects(ingest.query(directReceiptSql,
      [claim, 200, null, request.runInitializedAt]), /rain_capture_receipt_body/u);
    const raw = Buffer.from('{"hourly":{"precipitation":[0,1]}}');
    const actualReceipt = receipt(raw, "valid", 200,
      Date.now() <= Date.parse(request.runInitializedAt) + 8 * HOUR_MS);
    await appendRainCaptureReceipt(ingest, claim, actualReceipt);
    const stored = await ingest.query(
      "SELECT compressed_body, body_sha256, body_bytes, compressed_bytes FROM rain_capture_receipts WHERE claim_id = $1",
      [claim],
    );
    assert.deepEqual(gunzipSync(stored.rows[0].compressed_body), raw);
    assert.equal(stored.rows[0].body_sha256, actualReceipt.bodySha256);
    assert.equal(stored.rows[0].body_bytes, raw.byteLength);
    assert.ok(stored.rows[0].compressed_bytes > 0);
    await assert.rejects(appendRainCaptureReceipt(ingest, claim, actualReceipt), /duplicate key/u);
    await assert.rejects(ingest.query("UPDATE rain_capture_receipts SET row_count = 0 WHERE claim_id = $1", [claim]), /permission denied/u);
    await assert.rejects(owner.query("DELETE FROM rain_capture_claims WHERE id = $1", [claim]), /immutable/u);

    // restrict public and export roles to the sanitized aggregate only
    const status = await readRainCollectionStatus(api);
    assert.equal(status.receipts, 1);
    assert.equal(status.validForecasts, 1);
    assert.equal(status.modelEnabled, false);
    assert.equal(status.qualificationEnabled, false);
    await assert.rejects(api.query("SELECT * FROM rain_capture_receipts"), /permission denied/u);
    await assert.rejects(exporter.query("SELECT * FROM rain_capture_claims"), /permission denied/u);
    await assert.rejects(exporter.query("SELECT * FROM rain_collection_status_v1"), /permission denied/u);

    // deny unconfirmed station access at both repository and direct-SQL boundaries
    const station = stationRequest(new Date(), RAIN_COLLECTION_STATIONS[0].locationId);
    await assert.rejects(claimRainCaptureSlot(ingest,
      { request: station, release: "2026.09.13-1" }), /station access is not authorized/u);
    await assert.rejects(ingest.query(`
      INSERT INTO rain_capture_claims
        (kind, slot_key, station_id, window_start, window_end_exclusive, release, policy, policy_sha256)
      VALUES ('station', $1, $2, $3, $4, '2026.09.13-1', $5::jsonb, $6)
    `, [station.slotKey, station.stationId, station.start, station.endExclusive, policyJson, policySha]),
    /station access is not authorized/u);
  } finally {
    await Promise.all([ingest?.end(), api?.end(), exporter?.end(), owner.end()]);
    await stopPostgres(server);
  }
});

test("rain 429 manual review persists across restarts", { timeout: 600_000 }, async () => {
  const server = await startPostgres(17, "rain-manual-pause");
  const owner = createTestPool(server);
  let ingest;
  let api;

  try {
    await createRuntimeRoles(owner);
    await runMigrations(owner, migrationDirectory);
    await applyAcl(server);
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    api = createTestPool(server, "weather_test", "weather_api", "api-test");
    const request = forecastRequest((await owner.query("SELECT clock_timestamp() AS now")).rows[0].now);
    const claim = await claimRainCaptureSlot(ingest, { request, release: "2026.09.13-1" });
    assert.ok(claim);
    await appendRainCaptureReceipt(ingest, claim, {
      ...receipt(null, "rate_limited", 429, false),
      metadata: { retryAfterSeconds: null, retryAfterRequiresManualResume: true },
    });
    assert.equal((await readRainCollectionStatus(api)).pausedUntil,
      RAIN_COLLECTION_POLICY.expiresAt);
    assert.equal(await claimRainCaptureSlot(ingest, { request, release: "2026.09.13-1" }), null);
  } finally {
    await Promise.all([ingest?.end(), api?.end(), owner.end()]);
    await stopPostgres(server);
  }
});

test("rain compressed-byte reservations block HTTP claims before evidence is lost", { timeout: 600_000 }, async () => {
  const server = await startPostgres(17, "rain-storage-budget");
  const owner = createTestPool(server);
  let ingest;

  try {
    await createRuntimeRoles(owner);
    await runMigrations(owner, migrationDirectory);
    await applyAcl(server);
    ingest = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
    const policyJson = JSON.stringify(RAIN_COLLECTION_POLICY);
    const policySha = createHash("sha256").update(policyJson).digest("hex");

    // seed old unknown claims to isolate the reservation guard from live cycle timing
    await owner.query("ALTER TABLE rain_capture_claims DISABLE TRIGGER rain_capture_claims_guard_insert");
    await owner.query(`
      INSERT INTO rain_capture_claims
        (kind, slot_key, run_initialized_at, attempt, release, policy, policy_sha256, claimed_at)
      SELECT 'forecast', 'seed:' || n::text, clock_timestamp() - n * interval '6 hours',
        1, '2026.09.13-1', $1::jsonb, $2, clock_timestamp() - interval '121 seconds'
      FROM generate_series(1, 3) AS n
    `, [policyJson, policySha]);
    await owner.query("ALTER TABLE rain_capture_claims ENABLE TRIGGER rain_capture_claims_guard_insert");
    const request = forecastRequest((await owner.query("SELECT clock_timestamp() AS now")).rows[0].now);
    assert.equal(await claimRainCaptureSlot(ingest, { request, release: "2026.09.13-1" }), null);
    await assert.rejects(ingest.query(`
      INSERT INTO rain_capture_claims
        (kind, slot_key, run_initialized_at, attempt, release, policy, policy_sha256)
      VALUES ('forecast', $1, $2, $3, '2026.09.13-1', $4::jsonb, $5)
    `, [request.slotKey, request.runInitializedAt, request.attempt, policyJson, policySha]),
    /storage budget is exhausted/u);

    // completing one old claim releases only its unused reservation
    const oldClaim = (await owner.query("SELECT id FROM rain_capture_claims WHERE slot_key = 'seed:1'")).rows[0].id;
    await appendRainCaptureReceipt(ingest, oldClaim, {
      ...receipt(null, "transport_error", null, false),
      errorCode: "transport_error",
    });
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 1_200));
    assert.ok(await claimRainCaptureSlot(ingest, { request, release: "2026.09.13-1" }));
  } finally {
    await Promise.all([ingest?.end(), owner.end()]);
    await stopPostgres(server);
  }
});
