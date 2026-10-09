import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

import {
  RAIN_COLLECTION_POLICY,
  RAIN_COLLECTION_STATIONS,
  canonicalizeJson,
  serializeSourceMaterial,
  validateUtcInstant,
  weatherRecordContent,
  type RainCaptureReceipt,
  type RainCaptureRequest,
  type RainCollectionStatus,
  type NormalizedWeatherRecord,
} from "@weather/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  bindAdjustmentWeatherRevisions,
  markAdjustmentRevisionGap,
  type AdjustmentRevisionBatchReceipt,
  type AdjustmentRevisionCommitReceipt,
  type AdjustmentRevisionGap,
} from "./adjustment-maintenance.js";
import { withTransaction } from "./pool.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CLAIM_LOCK = 7_203_492_731_157_622;
const HASH = /^[a-f0-9]{64}$/u;
const RELEASE = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d?)$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const POLICY_JSON = JSON.stringify(RAIN_COLLECTION_POLICY);
const POLICY_SHA = createHash("sha256").update(POLICY_JSON).digest("hex");
const RAIN_TARGET_SOURCE_CONTRACT_VERSION = "rain-fixed-gauge-target-source/v1";
const RAIN_TARGET_RUN_ADAPTER_VERSION = "rain-fixed-gauge-target/v1";
const RAIN_TARGET_CATALOG_CONTRACT_VERSION =
  "adjustment-rain-fixed-gauge-target-source-catalog/v1";
const RAIN_TARGET_PROVIDER_KEY = "weatherflow-tempest";
const RAIN_TARGET_SITE_KEY = "ballydidean";
const RAIN_TARGET_TIMEZONE = "America/Los_Angeles";
const RAIN_TARGET_CAPTURE_BYTES = RAIN_COLLECTION_STATIONS.length *
  RAIN_COLLECTION_POLICY.maximumBodyBytes;

// describe one immutable dedicated target source
export interface RainFixedGaugeTargetSource {
  readonly locationId: number;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly sourceKey: string;
}

// expose the complete fixed target source catalog
export interface RainFixedGaugeTargetSourceCatalog {
  readonly catalogSha256: string;
  readonly contractVersion: typeof RAIN_TARGET_CATALOG_CONTRACT_VERSION;
  readonly runContractSha256: string;
  readonly sources: readonly RainFixedGaugeTargetSource[];
}

// retain one exact raw station response for a closed target hour
export interface RainFixedGaugeTargetCapture {
  readonly body: Uint8Array;
  readonly bodySha256: string;
  readonly claimId: string;
  readonly completedAt: string;
  readonly stationId: number;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

// bind one row from the independently parsed canonical target body
export interface RainFixedGaugeTargetRevisionRow {
  readonly normalizedRecord: NormalizedWeatherRecord;
  readonly stationId: number;
  readonly storedContentSha256: string;
}

// bind one staged body to all twelve immutable target rows
export interface RainFixedGaugeTargetRevisionGroup {
  readonly logicalKeySha256: string;
  readonly projectionIdentitySha256: string;
  readonly projectionSha256: string;
  readonly rows: readonly RainFixedGaugeTargetRevisionRow[];
  readonly stageReceiptSha256: string | null;
  readonly validAt: string;
}

// report either the complete receipt vector or one permanent group gap
export type RainFixedGaugeTargetRevisionResult = Readonly<{
  state: "committed";
  revisionReceipts: readonly AdjustmentRevisionCommitReceipt[];
}> | Readonly<{
  state: "gap";
  gap: AdjustmentRevisionGap;
}>;

type RainFixedGaugeTargetSourceSpec = Readonly<{
  adapterConfig: Readonly<Record<string, string | number>>;
  deviceId: number;
  latitude: number;
  locationId: number;
  longitude: number;
  serial: string;
  sourceConfigFingerprint: string;
  sourceKey: string;
  stationKey: string;
}>;

const RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS = Object.freeze(
  RAIN_COLLECTION_STATIONS.map(
    // derive the dedicated target lineage from the frozen gauge catalog
    (station): RainFixedGaugeTargetSourceSpec => {
      const sourceKey = `rain-target-tempest-${String(station.locationId)}`;
      const adapterConfig = {
        contractVersion: RAIN_TARGET_SOURCE_CONTRACT_VERSION,
        deviceId: station.deviceId,
        locationId: station.locationId,
        projection: "fixed-gauge-hour-target",
      } as const;
      const sourceConfigFingerprint = createHash("sha256").update(serializeSourceMaterial({
        adapterConfig,
        location: {
          latitude: station.latitude,
          longitude: station.longitude,
          siteKey: RAIN_TARGET_SITE_KEY,
          timezone: RAIN_TARGET_TIMEZONE,
        },
        providerKey: RAIN_TARGET_PROVIDER_KEY,
        sourceKey,
        sourceKind: "physical_sensor",
        stationKey: sourceKey,
        version: 1,
      })).digest("hex");
      return {
        adapterConfig,
        deviceId: station.deviceId,
        latitude: station.latitude,
        locationId: station.locationId,
        longitude: station.longitude,
        serial: station.serial,
        sourceConfigFingerprint,
        sourceKey,
        stationKey: sourceKey,
      };
    },
  ),
);
export const RAIN_FIXED_GAUGE_TARGET_CATALOG_SHA256 = createHash("sha256").update(
  `${canonicalizeJson({
    contractVersion: RAIN_TARGET_CATALOG_CONTRACT_VERSION,
    sources: RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS,
  })}\n`,
).digest("hex");
export const RAIN_FIXED_GAUGE_TARGET_RUN_CONTRACT_SHA256 = createHash("sha256").update(
  `${canonicalizeJson({
    adapterVersion: RAIN_TARGET_RUN_ADAPTER_VERSION,
    contractVersion: "adjustment-rain-fixed-gauge-target-run/v1",
    sourceCatalogSha256: RAIN_FIXED_GAUGE_TARGET_CATALOG_SHA256,
  })}\n`,
).digest("hex");

interface ClaimRow extends QueryResultRow {
  readonly id: string;
  readonly kind: "forecast" | "station";
  readonly claimed_at: Date;
  readonly run_initialized_at: Date | null;
}

interface StatusRow extends QueryResultRow {
  readonly contract_version: string;
  readonly model_enabled: boolean;
  readonly qualification_enabled: boolean;
  readonly claims: number;
  readonly receipts: number;
  readonly valid_forecasts: number;
  readonly timely_forecasts: number;
  readonly valid_station_windows: number;
  readonly stations_seen: number;
  readonly failed_requests: number;
  readonly pending_requests: number;
  readonly unknown_requests: number;
  readonly last_claim_at: Date | null;
  readonly last_receipt_at: Date | null;
  readonly last_forecast_receipt_at: Date | null;
  readonly last_station_receipt_at: Date | null;
  readonly paused_until: Date | null;
  readonly compressed_bytes: string;
}

interface RainFixedGaugeTargetSourceRow extends QueryResultRow {
  readonly active: boolean;
  readonly adapterConfig: Readonly<Record<string, unknown>>;
  readonly cadenceSeconds: number | null;
  readonly capabilities: readonly string[];
  readonly latitude: number;
  readonly longitude: number;
  readonly providerActive: boolean;
  readonly providerKey: string;
  readonly serial: string | null;
  readonly siteActive: boolean;
  readonly siteKey: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly sourceKind: string;
  readonly stationActive: boolean;
  readonly stationKey: string;
  readonly stationKind: string;
  readonly timezone: string;
}

interface RainFixedGaugeTargetCaptureRow extends QueryResultRow {
  readonly bodySha256: string;
  readonly claimId: string;
  readonly completedAt: Date;
  readonly compressedBody: Buffer;
  readonly stationId: number;
  readonly validAt: Date;
  readonly windowEndExclusive: Date;
  readonly windowStart: Date;
}

// claim one bounded slot using the database clock and a cross-worker lock
export async function claimRainCaptureSlot(
  pool: Pool,
  input: Readonly<{ request: RainCaptureRequest; release: string; now?: Date }>,
): Promise<string | null> {
  // never use an injected or host clock to authorize a production request
  const release = RELEASE.exec(input.release);
  const releaseDate = release === null ? Number.NaN :
    Date.parse(`${release[1]}-${release[2]}-${release[3]}T00:00:00.000Z`);

  // require the immutable deployed tag and a real calendar date
  if (release === null || !Number.isFinite(releaseDate) || new Date(releaseDate).toISOString().slice(0, 10) !==
    `${release[1]}-${release[2]}-${release[3]}`) {
    throw new RangeError("rain capture release is invalid");
  }
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [CLAIM_LOCK]);
      const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now;

      // fail closed without a trustworthy server time
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw new Error("database clock unavailable");
      }
      const request = validateRequest(input.request, now);
      const time = now.toISOString();
      const dayStart = new Date(Math.floor(now.getTime() / DAY_MS) * DAY_MS).toISOString();
      const gate = await client.query<{
        existing: boolean;
        pending: boolean;
        latest: Date | null;
        today: string;
        rolling: string;
        storage_day: string;
        storage_total: string;
        paused: boolean;
        valid_prior: boolean;
      }>(`
        SELECT
          EXISTS (SELECT 1 FROM rain_capture_claims WHERE slot_key = $1) AS existing,
          EXISTS (
            SELECT 1 FROM rain_capture_claims c
            LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
            WHERE r.claim_id IS NULL AND c.claimed_at > $3::timestamptz - interval '120 seconds'
          ) AS pending,
          GREATEST(
            (SELECT max(claimed_at) FROM rain_capture_claims),
            (SELECT max(completed_at) FROM rain_capture_receipts)
          ) AS latest,
          (SELECT count(*) FROM rain_capture_claims
            WHERE kind = $2 AND claimed_at >= $4::timestamptz)::text AS today,
          (SELECT count(*) FROM rain_capture_claims
            WHERE kind = $2 AND claimed_at > $3::timestamptz - interval '24 hours')::text AS rolling,
          (SELECT coalesce(sum(CASE WHEN r.claim_id IS NULL THEN 2100000
              ELSE coalesce(r.compressed_bytes, 0) END), 0)::text
            FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id
            WHERE c.claimed_at >= $4::timestamptz) AS storage_day,
          (SELECT coalesce(sum(CASE WHEN r.claim_id IS NULL THEN 2100000
              ELSE coalesce(r.compressed_bytes, 0) END), 0)::text
            FROM rain_capture_claims c LEFT JOIN rain_capture_receipts r ON r.claim_id = c.id) AS storage_total,
          EXISTS (
            SELECT 1 FROM rain_capture_receipts r
            JOIN rain_capture_claims c ON c.id = r.claim_id
            WHERE (r.outcome = 'rate_limited' AND (
              r.metadata->>'retryAfterRequiresManualResume' = 'true' OR
              r.completed_at + greatest(interval '24 hours',
                coalesce((r.metadata->>'retryAfterSeconds')::integer, 0) * interval '1 second'
              ) > $3::timestamptz))
              OR (r.outcome = 'unauthorized' AND c.kind = $2
                AND r.completed_at > $3::timestamptz - interval '24 hours')
          ) AS paused,
          EXISTS (
            SELECT 1 FROM rain_capture_claims c
            JOIN rain_capture_receipts r ON r.claim_id = c.id
            WHERE $2 = 'forecast' AND c.kind = 'forecast'
              AND c.run_initialized_at = $5::timestamptz AND r.outcome = 'valid'
          ) AS valid_prior
      `, [request.slotKey, request.kind, time, dayStart, request.runInitializedAt]);
      const state = gate.rows[0];
      const limit = request.kind === "forecast"
        ? RAIN_COLLECTION_POLICY.maximumForecastRequestsPerDay
        : RAIN_COLLECTION_POLICY.maximumStationRequestsPerDay;

      // deny duplicate, overlapping, paused, or over-budget requests
      if (
        state === undefined || state.existing || state.pending || state.paused || state.valid_prior ||
        Number(state.today) >= limit || Number(state.rolling) >= limit ||
        Number(state.storage_day) + RAIN_COLLECTION_POLICY.maximumCompressedBodyBytes > RAIN_COLLECTION_POLICY.maximumStoredBytesPerDay ||
        Number(state.storage_total) + RAIN_COLLECTION_POLICY.maximumCompressedBodyBytes > RAIN_COLLECTION_POLICY.maximumStoredBytes ||
        (state.latest !== null && now.getTime() - state.latest.getTime() < RAIN_COLLECTION_POLICY.minimumRequestSpacingMs)
      ) {
        return null;
      }
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO rain_capture_claims (
          kind, slot_key, station_id, run_initialized_at, attempt,
          window_start, window_end_exclusive, release, policy, policy_sha256, claimed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, clock_timestamp())
        ON CONFLICT (slot_key) DO NOTHING RETURNING id
      `, [request.kind, request.slotKey, request.stationId, request.runInitializedAt,
        request.attempt, request.start, request.endExclusive, input.release,
        POLICY_JSON, POLICY_SHA]);
      return inserted.rows[0]?.id ?? null;
    });
  } finally {
    client.release();
  }
}

// append one completed attempt without changing its claim or prior evidence
export async function appendRainCaptureReceipt(
  pool: Pool,
  claimId: string,
  receipt: RainCaptureReceipt,
): Promise<void> {
  // reject untrusted payloads before compressing or touching the database
  if (!/^[a-f0-9-]{36}$/iu.test(claimId)) {
    throw new RangeError("rain capture claim id is invalid");
  }
  const startedAt = parseUtc(receipt.startedAt);
  const completedAt = parseUtc(receipt.completedAt);

  // preserve chronological transport evidence
  if (completedAt < startedAt || receipt.parserVersion !== RAIN_COLLECTION_POLICY.contractVersion) {
    throw new RangeError("rain capture receipt time or parser is invalid");
  }
  const body = receipt.body === null ? null : Buffer.from(receipt.body);

  // keep raw provider bytes bounded before gzip allocation
  if (body !== null && body.byteLength > RAIN_COLLECTION_POLICY.maximumBodyBytes) {
    throw new RangeError("rain capture body exceeds the bound");
  }
  const digest = body === null ? null : createHash("sha256").update(body).digest("hex");

  // require the caller's exact-byte checksum, including for empty bodies
  if (digest !== receipt.bodySha256 || (digest !== null && !HASH.test(digest))) {
    throw new RangeError("rain capture raw body hash mismatch");
  }
  const compressed = body === null ? null : gzipSync(body, { level: 9 });

  // keep compressed storage bounded independently of source size
  if (compressed !== null && compressed.byteLength > RAIN_COLLECTION_POLICY.maximumCompressedBodyBytes) {
    throw new RangeError("rain capture compressed body exceeds the bound");
  }
  validateReceiptFields(receipt, body !== null);
  const claim = await pool.query<ClaimRow>(
    "SELECT id, kind, claimed_at, run_initialized_at FROM rain_capture_claims WHERE id = $1",
    [claimId],
  );
  const identity = claim.rows[0];

  // require the claim to predate the HTTP attempt
  if (identity === undefined || startedAt < identity.claimed_at.getTime()) {
    throw new RangeError("rain capture receipt has no prior claim");
  }
  const available = identity.kind === "forecast"
    ? receipt.outcome === "valid" && identity.run_initialized_at !== null &&
      completedAt <= identity.run_initialized_at.getTime() + RAIN_COLLECTION_POLICY.decisionDelayHours * HOUR_MS
    : null;

  // prevent a caller from promoting a late or invalid forecast
  if (receipt.availableByDecision !== available) {
    throw new RangeError("rain capture availability differs from receipt time");
  }
  await pool.query(`
    INSERT INTO rain_capture_receipts (
      claim_id, started_at, completed_at, http_status, outcome, error_code,
      compressed_body, body_sha256, body_bytes, compressed_bytes,
      parser_version, row_count, available_by_decision, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
  `, [claimId, receipt.startedAt, receipt.completedAt, receipt.httpStatus,
    receipt.outcome, receipt.errorCode, compressed, digest,
    body?.byteLength ?? null, compressed?.byteLength ?? null,
    receipt.parserVersion, receipt.rowCount, available,
    JSON.stringify(receipt.metadata)]);
}

// read only the sanitized collection progress view
export async function readRainCollectionStatus(pool: Pool): Promise<RainCollectionStatus> {
  const result = await pool.query<StatusRow>("SELECT * FROM rain_collection_status_v1");
  const row = result.rows[0];

  // require the view's frozen non-serving contract
  if (row?.contract_version !== RAIN_COLLECTION_POLICY.contractVersion ||
    row.model_enabled !== false || row.qualification_enabled !== false) {
    throw new Error("rain collection status contract mismatch");
  }
  return {
    contractVersion: RAIN_COLLECTION_POLICY.contractVersion,
    modelEnabled: false,
    qualificationEnabled: false,
    claims: row.claims,
    receipts: row.receipts,
    validForecasts: row.valid_forecasts,
    timelyForecasts: row.timely_forecasts,
    validStationWindows: row.valid_station_windows,
    stationsSeen: row.stations_seen,
    failedRequests: row.failed_requests,
    pendingRequests: row.pending_requests,
    unknownRequests: row.unknown_requests,
    lastClaimAt: row.last_claim_at?.toISOString() ?? null,
    lastReceiptAt: row.last_receipt_at?.toISOString() ?? null,
    lastForecastReceiptAt: row.last_forecast_receipt_at?.toISOString() ?? null,
    lastStationReceiptAt: row.last_station_receipt_at?.toISOString() ?? null,
    pausedUntil: row.paused_until?.toISOString() ?? null,
    compressedBytes: Number(row.compressed_bytes),
  };
}

// read the exact dedicated source catalog without admitting ordinary aliases
export async function readRainFixedGaugeTargetSourceCatalog(
  pool: Pool,
): Promise<RainFixedGaugeTargetSourceCatalog> {
  return await readRainFixedGaugeTargetSourceCatalogFrom(pool, false);
}

// select one latest complete post-epoch closed gauge hour
export async function readPendingRainFixedGaugeTargetCaptures(
  pool: Pool,
  captureEpochAt: string,
): Promise<Readonly<{
  captures: readonly RainFixedGaugeTargetCapture[];
  validAt: string;
}> | null> {
  const validAt = await readPendingRainFixedGaugeTargetHour(pool, captureEpochAt);

  // preserve no-work without reading or inflating provider bodies
  if (validAt === null) {
    return null;
  }
  return {
    captures: await readRainFixedGaugeTargetCapturesForHour(pool, captureEpochAt, validAt),
    validAt,
  };
}

// read one pending logical hour without inflating raw provider bodies
export async function readPendingRainFixedGaugeTargetHour(
  pool: Pool,
  captureEpochAt: string,
): Promise<string | null> {
  const epochAt = validateUtcInstant(captureEpochAt, "captureEpochAt");
  const sourceKeys = RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS.map((source) => source.sourceKey);
  const stationIds = RAIN_COLLECTION_STATIONS.map((station) => station.locationId);
  const candidate = await pool.query<{ validAt: Date }>(`
    SELECT c.window_end_exclusive - interval '1 second' AS "validAt"
    FROM rain_capture_claims c
    JOIN rain_capture_receipts r ON r.claim_id = c.id
    WHERE c.kind = 'station' AND c.station_id = ANY($1::integer[])
      AND r.outcome = 'valid' AND c.window_start >= $2::timestamptz
      AND r.completed_at >= $2::timestamptz
      AND c.window_end_exclusive <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM weather_records wr
        JOIN sources source ON source.id = wr.source_id
        WHERE source.source_key = ANY($3::text[])
          AND wr.source_kind = 'physical_sensor'
          AND wr.product_run_at IS NULL
          AND wr.valid_at = c.window_end_exclusive - interval '1 second'
      )
    GROUP BY c.window_end_exclusive
    HAVING count(*) = $4 AND count(DISTINCT c.station_id) = $4
    ORDER BY c.window_end_exclusive DESC
    LIMIT 1
  `, [stationIds, epochAt, sourceKeys, RAIN_COLLECTION_STATIONS.length]);
  const validAt = candidate.rows[0]?.validAt;
  return validAt instanceof Date ? validAt.toISOString() : null;
}

// inflate one exact pending hour only after external gap admission
export async function readRainFixedGaugeTargetCapturesForHour(
  pool: Pool,
  captureEpochAt: string,
  targetValidAt: string,
): Promise<readonly RainFixedGaugeTargetCapture[]> {
  const epochAt = validateUtcInstant(captureEpochAt, "captureEpochAt");
  const validAt = validateUtcInstant(targetValidAt, "targetValidAt");
  const sourceKeys = RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS.map((source) => source.sourceKey);
  const stationIds = RAIN_COLLECTION_STATIONS.map((station) => station.locationId);
  const eligible = await pool.query<{ eligible: boolean }>(`
    SELECT count(*) = $4 AND count(DISTINCT c.station_id) = $4 AND NOT EXISTS (
      SELECT 1 FROM weather_records wr
      JOIN sources source ON source.id = wr.source_id
      WHERE source.source_key = ANY($3::text[])
        AND wr.source_kind = 'physical_sensor' AND wr.product_run_at IS NULL
        AND wr.valid_at = $2::timestamptz
    ) AS eligible
    FROM rain_capture_claims c
    JOIN rain_capture_receipts r ON r.claim_id = c.id
    WHERE c.kind = 'station' AND c.station_id = ANY($1::integer[])
      AND r.outcome = 'valid' AND c.window_start >= $5::timestamptz
      AND r.completed_at >= $5::timestamptz
      AND c.window_end_exclusive = $2::timestamptz + interval '1 second'
      AND c.window_end_exclusive <= clock_timestamp()
  `, [stationIds, validAt, sourceKeys, RAIN_COLLECTION_STATIONS.length, epochAt]);

  // refuse a raced, completed or incomplete hour before reading raw values
  if (eligible.rows[0]?.eligible !== true) {
    throw new Error("rain fixed-gauge target hour is no longer pending");
  }
  const result = await pool.query<RainFixedGaugeTargetCaptureRow>(`
    SELECT r.body_sha256 AS "bodySha256", c.id::text AS "claimId",
      r.completed_at AS "completedAt", r.compressed_body AS "compressedBody",
      c.station_id AS "stationId",
      c.window_end_exclusive - interval '1 second' AS "validAt",
      c.window_end_exclusive AS "windowEndExclusive", c.window_start AS "windowStart"
    FROM rain_capture_claims c
    JOIN rain_capture_receipts r ON r.claim_id = c.id
    WHERE c.kind = 'station' AND c.station_id = ANY($1::integer[])
      AND r.outcome = 'valid'
      AND c.window_end_exclusive = $2::timestamptz + interval '1 second'
      AND c.window_start >= $3::timestamptz AND r.completed_at >= $3::timestamptz
    ORDER BY array_position($1::integer[], c.station_id)
  `, [stationIds, validAt, epochAt]);

  // require exactly one immutable source response per frozen gauge
  if (result.rows.length !== RAIN_COLLECTION_STATIONS.length) {
    throw new Error("rain fixed-gauge target capture set is incomplete");
  }
  let decodedBytes = 0;
  const captures = result.rows.map((row, index): RainFixedGaugeTargetCapture => {
    const station = RAIN_COLLECTION_STATIONS[index];

    // reject reordered, duplicated or off-hour source rows
    if (station === undefined || row.stationId !== station.locationId ||
      row.validAt.toISOString() !== validAt) {
      throw new Error("rain fixed-gauge target capture order differs");
    }
    const body = gunzipSync(row.compressedBody, {
      maxOutputLength: RAIN_COLLECTION_POLICY.maximumBodyBytes,
    });
    decodedBytes += body.byteLength;

    // bound the complete raw proof set before returning it to the worker
    if (decodedBytes > RAIN_TARGET_CAPTURE_BYTES ||
      createHash("sha256").update(body).digest("hex") !== row.bodySha256) {
      throw new Error("rain fixed-gauge target capture body differs");
    }
    return {
      body,
      bodySha256: row.bodySha256,
      claimId: row.claimId,
      completedAt: row.completedAt.toISOString(),
      stationId: row.stationId,
      windowEndExclusive: row.windowEndExclusive.toISOString(),
      windowStart: row.windowStart.toISOString(),
    };
  });
  return captures;
}

// atomically persist and bind one complete twelve-gauge target group
export async function commitRainFixedGaugeTargetRevisionGroup(
  pool: Pool,
  input: RainFixedGaugeTargetRevisionGroup,
): Promise<RainFixedGaugeTargetRevisionResult> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const catalog = await readRainFixedGaugeTargetSourceCatalogFrom(client, true);
      const checked = validateRainFixedGaugeTargetRevisionGroup(input, catalog);
      await ensureRainFixedGaugeTargetRows(client, checked, catalog);
      const gap = rainFixedGaugeTargetRevisionGap(
        checked,
        checked.stageReceiptSha256 === null ? "archive_stage_failed" : "database_bind_failed",
      );

      // retain an unqualified complete row group when no durable stage exists
      if (checked.stageReceiptSha256 === null) {
        await markRainFixedGaugeTargetRowsGap(client, checked, gap);
        return { gap, state: "gap" };
      }
      await client.query("SAVEPOINT rain_fixed_gauge_target_bind");
      try {
        const revisionReceipts: AdjustmentRevisionCommitReceipt[] = [];

        // issue receipts in frozen station order rather than source-id lexical order
        for (const row of checked.rows) {
          const batch = await bindAdjustmentWeatherRevisions(client, [{
            productRunAt: null,
            projectionIdentitySha256: checked.projectionIdentitySha256,
            projectionSha256: checked.projectionSha256,
            sourceId: row.normalizedRecord.sourceId,
            sourceKind: "physical_sensor",
            stageReceiptSha256: checked.stageReceiptSha256,
            storedContentSha256: row.storedContentSha256,
            validAt: checked.validAt,
          }]);
          revisionReceipts.push(requireRainFixedGaugeTargetReceipt(batch, row));
        }
        await client.query("RELEASE SAVEPOINT rain_fixed_gauge_target_bind");
        return { revisionReceipts, state: "committed" };
      } catch {
        // remove every partial ordinal and pointer before retaining one group gap
        await client.query("ROLLBACK TO SAVEPOINT rain_fixed_gauge_target_bind");
        await client.query("RELEASE SAVEPOINT rain_fixed_gauge_target_bind");
        await markRainFixedGaugeTargetRowsGap(client, checked, gap);
        return { gap, state: "gap" };
      }
    });
  } finally {
    client.release();
  }
}

// mark one already-committed group after publication or admission failure
export async function markRainFixedGaugeTargetRevisionGroupGap(
  pool: Pool,
  input: RainFixedGaugeTargetRevisionGroup,
  reason: "archive_publish_failed" | "database_admission_failed",
): Promise<AdjustmentRevisionGap> {
  const client = await pool.connect();

  try {
    return await withTransaction(client, async () => {
      const catalog = await readRainFixedGaugeTargetSourceCatalogFrom(client, true);
      const checked = validateRainFixedGaugeTargetRevisionGroup(input, catalog);
      const gap = rainFixedGaugeTargetRevisionGap(checked, reason);
      await requireRainFixedGaugeTargetRows(client, checked, true);
      await markRainFixedGaugeTargetRowsGap(client, checked, gap);
      return gap;
    });
  } finally {
    client.release();
  }
}

// load and verify every immutable target source row
async function readRainFixedGaugeTargetSourceCatalogFrom(
  queryable: Pool | PoolClient,
  lock: boolean,
): Promise<RainFixedGaugeTargetSourceCatalog> {
  const sourceKeys = RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS.map((source) => source.sourceKey);
  const result = await queryable.query<RainFixedGaugeTargetSourceRow>(`
    SELECT source.id::text AS "sourceId", source.source_key AS "sourceKey",
      source.source_kind AS "sourceKind",
      source.material_provider_config AS "adapterConfig",
      source.source_config_fingerprint::text AS "sourceConfigFingerprint",
      source.capabilities, source.cadence_seconds AS "cadenceSeconds", source.active,
      station.slug AS "stationKey", station.station_kind AS "stationKind",
      station.latitude, station.longitude, station.serial,
      station.active AS "stationActive", provider.provider_key AS "providerKey",
      provider.active AS "providerActive", site.slug AS "siteKey",
      site.timezone, site.active AS "siteActive"
    FROM sources source
    JOIN stations station ON station.id = source.station_id
    JOIN providers provider ON provider.id = source.provider_id
    JOIN sites site ON site.id = station.site_id
    WHERE source.source_key = ANY($1::text[])
    ORDER BY array_position($1::text[], source.source_key)
  `, [sourceKeys]);

  // require a complete, distinct and immutable source catalog
  if (result.rows.length !== RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS.length) {
    throw new Error("rain fixed-gauge target source catalog is incomplete");
  }
  const sources = result.rows.map((row, index): RainFixedGaugeTargetSource => {
    const expected = RAIN_FIXED_GAUGE_TARGET_SOURCE_SPECS[index];

    // reject aliases, mutable scheduling and material drift
    if (expected === undefined || row.sourceKey !== expected.sourceKey ||
      row.stationKey !== expected.stationKey || row.sourceKind !== "physical_sensor" ||
      row.providerKey !== RAIN_TARGET_PROVIDER_KEY || row.siteKey !== RAIN_TARGET_SITE_KEY ||
      row.stationKind !== "physical" || row.timezone !== RAIN_TARGET_TIMEZONE ||
      row.latitude !== expected.latitude || row.longitude !== expected.longitude ||
      row.serial !== expected.serial || row.sourceConfigFingerprint !== expected.sourceConfigFingerprint ||
      canonicalizeJson(row.adapterConfig as never) !== canonicalizeJson(expected.adapterConfig as never) ||
      canonicalizeJson(row.capabilities as never) !== canonicalizeJson(["historical"] as never) ||
      row.cadenceSeconds !== null || !row.active || !row.stationActive ||
      !row.providerActive || !row.siteActive || !/^[1-9][0-9]*$/u.test(row.sourceId)) {
      throw new Error("rain fixed-gauge target source catalog differs");
    }
    return {
      locationId: expected.locationId,
      sourceConfigFingerprint: expected.sourceConfigFingerprint,
      sourceId: row.sourceId,
      sourceKey: expected.sourceKey,
    };
  });

  // share the established per-source lock namespace without requiring source mutation grants
  if (lock) {
    await queryable.query(`
      SELECT pg_advisory_xact_lock(hashtextextended('weather-source:' || source_id, 0))
      FROM unnest($1::text[]) WITH ORDINALITY AS locked(source_id, ordinal)
      ORDER BY ordinal
    `, [sources.map((source) => source.sourceId)]);
  }
  return {
    catalogSha256: RAIN_FIXED_GAUGE_TARGET_CATALOG_SHA256,
    contractVersion: RAIN_TARGET_CATALOG_CONTRACT_VERSION,
    runContractSha256: RAIN_FIXED_GAUGE_TARGET_RUN_CONTRACT_SHA256,
    sources,
  };
}

// validate the complete staged group before opening storage mutations
function validateRainFixedGaugeTargetRevisionGroup(
  input: RainFixedGaugeTargetRevisionGroup,
  catalog: RainFixedGaugeTargetSourceCatalog,
): RainFixedGaugeTargetRevisionGroup {
  const validAt = validateUtcInstant(input.validAt, "validAt");

  // require one closed UTC hour and one canonical group identity
  if (Date.parse(validAt) % HOUR_MS !== 0 || !HASH.test(input.logicalKeySha256) ||
    !HASH.test(input.projectionIdentitySha256) ||
    input.projectionSha256 !== input.projectionIdentitySha256 ||
    (input.stageReceiptSha256 !== null && !HASH.test(input.stageReceiptSha256)) ||
    input.rows.length !== RAIN_COLLECTION_STATIONS.length) {
    throw new RangeError("rain fixed-gauge target revision group is invalid");
  }
  const expectedLogicalKeySha256 = createHash("sha256").update(
    `${canonicalizeJson({
      contractVersion: "adjustment-rain-fixed-gauge-target-logical-key/v1",
      sourceIds: catalog.sources.map((source) => source.sourceId),
      validAt,
    })}\n`,
  ).digest("hex");

  // crossbind the shared logical key to the exact provisioned catalog
  if (input.logicalKeySha256 !== expectedLogicalKeySha256) {
    throw new RangeError("rain fixed-gauge target logical key differs");
  }
  input.rows.forEach((row, index) => {
    const station = RAIN_COLLECTION_STATIONS[index];
    const source = catalog.sources[index];
    const record = row.normalizedRecord;

    // bind each canonical row to its frozen station and dedicated source
    if (station === undefined || source === undefined || row.stationId !== station.locationId ||
      source.locationId !== station.locationId || record.sourceId !== source.sourceId ||
      record.sourceKind !== "physical_sensor" || record.productRunAt !== null ||
      record.validAt !== validAt || record.metadata.upstreamTimezone !== RAIN_TARGET_TIMEZONE ||
      record.metadata.device?.vendor !== "WeatherFlow" ||
      record.metadata.device.model !== "Tempest" ||
      record.metadata.device.serial !== station.serial || !HASH.test(row.storedContentSha256) ||
      createHash("sha256").update(weatherRecordContent(record)).digest("hex") !==
        row.storedContentSha256) {
      throw new RangeError("rain fixed-gauge target row differs");
    }
  });
  return { ...input, validAt };
}

// insert the complete immutable row set or validate one exact retry
async function ensureRainFixedGaugeTargetRows(
  client: PoolClient,
  input: RainFixedGaugeTargetRevisionGroup,
  catalog: RainFixedGaugeTargetSourceCatalog,
): Promise<void> {
  const existing = await requireRainFixedGaugeTargetRows(client, input, false);

  // preserve exact retries without adding duplicate ingestion runs
  if (existing === true) {
    return;
  }
  const requestedStart = new Date(Date.parse(input.validAt) - HOUR_MS).toISOString();

  // persist one source-scoped provenance run and one target row in fixed order
  for (const [index, row] of input.rows.entries()) {
    const source = catalog.sources[index]!;
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingestion_runs (
        source_id, mode, requested_start, requested_end_exclusive,
        source_config_fingerprint, adapter_version, deadline_at, completed_at,
        state, attempts, record_count, request_metadata, response_metadata,
        upstream_response_checksum
      ) VALUES (
        $1, 'scheduled', $2, $3, $4, $5, clock_timestamp() + interval '1 minute',
        clock_timestamp(), 'succeeded', 1, 1, $6::jsonb, $7::jsonb, $8
      ) RETURNING id
    `, [source.sourceId, requestedStart, input.validAt, source.sourceConfigFingerprint,
      RAIN_TARGET_RUN_ADAPTER_VERSION, JSON.stringify({
        contractVersion: "adjustment-rain-fixed-gauge-target-run/v1",
        projectionIdentitySha256: input.projectionIdentitySha256,
        runContractSha256: RAIN_FIXED_GAUGE_TARGET_RUN_CONTRACT_SHA256,
      }), JSON.stringify({ logicalReceivedAt: row.normalizedRecord.receivedAt }),
      input.projectionIdentitySha256]);
    const runId = run.rows[0]?.id;

    // refuse an incomplete provenance row before storing values
    if (runId === undefined) {
      throw new Error("rain fixed-gauge target ingestion run was not stored");
    }
    await insertRainFixedGaugeTargetWeatherRow(client, runId, row);
  }
}

// validate zero or all exact target rows under deterministic row locks
async function requireRainFixedGaugeTargetRows(
  client: PoolClient,
  input: RainFixedGaugeTargetRevisionGroup,
  requireComplete: boolean,
): Promise<boolean> {
  const sourceIds = input.rows.map((row) => row.normalizedRecord.sourceId);
  const existing = await client.query<{
    contentHash: string;
    sourceId: string;
    validAt: Date;
  }>(`
    SELECT source_id::text AS "sourceId", content_hash AS "contentHash",
      valid_at AS "validAt"
    FROM weather_records
    WHERE source_id = ANY($1::bigint[]) AND source_kind = 'physical_sensor'
      AND product_run_at IS NULL AND valid_at = $2::timestamptz
    ORDER BY array_position($1::bigint[], source_id)
    FOR UPDATE
  `, [sourceIds, input.validAt]);

  // accept only an empty insert boundary or the complete exact retry set
  if (existing.rows.length === 0 && !requireComplete) {
    return false;
  }
  if (existing.rows.length !== input.rows.length || existing.rows.some((stored, index) =>
    stored.sourceId !== sourceIds[index] ||
    stored.contentHash !== input.rows[index]?.storedContentSha256 ||
    stored.validAt.toISOString() !== input.validAt)) {
    throw new Error("rain fixed-gauge target stored row set differs");
  }
  return true;
}

// insert one exact normalized target row without an upsert rewrite path
async function insertRainFixedGaugeTargetWeatherRow(
  client: PoolClient,
  runId: string,
  row: RainFixedGaugeTargetRevisionRow,
): Promise<void> {
  const record = row.normalizedRecord;
  const result = await client.query(`
    INSERT INTO weather_records (
      source_id, source_kind, valid_at, product_run_at,
      first_ingestion_run_id, last_ingestion_run_id,
      first_received_at, last_received_at, upstream_timezone, upstream_model,
      device_vendor, device_model, device_serial, quality_metadata, provider_metadata,
      temperature_c, apparent_temperature_c, precipitation_mm, wind_speed_mps,
      wind_gust_mps, pressure_hpa, relative_humidity_percent, cloud_cover_percent,
      wind_direction_degrees, black_globe_temperature_c,
      pm25_micrograms_per_cubic_meter, precipitation_rate_mm_per_hour,
      soil_electrical_conductivity_us_cm, soil_moisture_percent,
      solar_radiation_wm2, uv_index, wet_bulb_globe_temperature_c,
      water_level_m, content_hash
    ) VALUES (
      $1, $2, $3, $4, $5, $5, $6, $6, $7, $8, $9, $10, $11,
      $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22,
      $23, $24, $25, $26, $27, $28, $29, $30, $31, $32
    ) ON CONFLICT ON CONSTRAINT weather_records_identity_key DO NOTHING
  `, [record.sourceId, record.sourceKind, record.validAt, record.productRunAt, runId,
    record.receivedAt, record.metadata.upstreamTimezone, record.metadata.model,
    record.metadata.device?.vendor ?? null, record.metadata.device?.model ?? null,
    record.metadata.device?.serial ?? null, JSON.stringify(record.metadata.quality),
    JSON.stringify(record.metadata.provider), record.metrics.temperatureC,
    record.metrics.apparentTemperatureC, record.metrics.precipitationMm,
    record.metrics.windSpeedMps, record.metrics.windGustMps, record.metrics.pressureHpa,
    record.metrics.relativeHumidityPercent, record.metrics.cloudCoverPercent,
    record.metrics.windDirectionDegrees, record.metrics.blackGlobeTemperatureC,
    record.metrics.pm25MicrogramsPerCubicMeter,
    record.metrics.precipitationRateMmPerHour,
    record.metrics.soilElectricalConductivityMicrosiemensPerCm,
    record.metrics.soilMoisturePercent, record.metrics.solarRadiationWm2,
    record.metrics.uvIndex, record.metrics.wetBulbGlobeTemperatureC,
    record.metrics.waterLevelM, row.storedContentSha256]);

  // reject a concurrent or partial identity collision
  if (result.rowCount !== 1) {
    throw new Error("rain fixed-gauge target weather row collided");
  }
}

// extract one exact receipt from a single-row binder call
function requireRainFixedGaugeTargetReceipt(
  batch: AdjustmentRevisionBatchReceipt,
  row: RainFixedGaugeTargetRevisionRow,
): AdjustmentRevisionCommitReceipt {
  const entry = batch.receipts[0];

  // require the binder to return the exact stored row and one server receipt
  if (batch.receipts.length !== 1 || entry?.sourceId !== row.normalizedRecord.sourceId ||
    entry.validAt !== row.normalizedRecord.validAt ||
    entry.storedContentSha256 !== row.storedContentSha256 ||
    typeof entry.revisionReceipt !== "object" || entry.revisionReceipt === null) {
    throw new Error("rain fixed-gauge target revision receipt differs");
  }
  return entry.revisionReceipt as unknown as AdjustmentRevisionCommitReceipt;
}

// build one shared permanent group gap without claiming a receipt
function rainFixedGaugeTargetRevisionGap(
  input: RainFixedGaugeTargetRevisionGroup,
  reason: AdjustmentRevisionGap["reason"],
): AdjustmentRevisionGap {
  return {
    logicalKeySha256: input.logicalKeySha256,
    projectionIdentitySha256: input.projectionIdentitySha256,
    projectionKind: "target_revision",
    projectionSha256: input.projectionSha256,
    reason,
  };
}

// mark every exact row with the same body-level terminal gap
async function markRainFixedGaugeTargetRowsGap(
  queryable: PoolClient,
  input: RainFixedGaugeTargetRevisionGroup,
  gap: AdjustmentRevisionGap,
): Promise<void> {
  // persist all twelve markers within the surrounding group transaction
  for (const row of input.rows) {
    await markAdjustmentRevisionGap(queryable, "weather_record", {
      productRunAt: null,
      sourceId: row.normalizedRecord.sourceId,
      sourceKind: "physical_sensor",
      storedContentSha256: row.storedContentSha256,
      validAt: input.validAt,
    }, gap);
  }
}

type CheckedRequest = Readonly<{
  kind: "forecast" | "station";
  slotKey: string;
  stationId: number | null;
  runInitializedAt: string | null;
  attempt: number | null;
  start: string | null;
  endExclusive: string | null;
}>;

// bind one request to its exact, credential-free fixed-policy slot
function validateRequest(request: RainCaptureRequest, now: Date): CheckedRequest {
  const time = now.getTime();

  // enforce collection lifetime at the database clock boundary
  if (time < Date.parse(RAIN_COLLECTION_POLICY.startsAt) ||
    time >= Date.parse(RAIN_COLLECTION_POLICY.expiresAt)) {
    throw new RangeError("rain capture policy is not active");
  }

  // accept only the two pinned request shapes
  if (request.kind === "forecast") {
    // require only the canonical forecast identity fields
    if (Object.keys(request).sort().join() !== "attempt,kind,runInitializedAt,slotKey") {
      throw new RangeError("rain forecast request keys are invalid");
    }
    const initialized = parseUtc(request.runInitializedAt);
    const age = time - initialized;
    const expected = `forecast:${request.runInitializedAt}:${String(request.attempt)}`;

    // restrict to one of four ECMWF cycles and its fixed receipt window
    if (initialized % HOUR_MS !== 0 || new Date(initialized).getUTCHours() % 6 !== 0 ||
      request.slotKey !== expected ||
      (request.attempt === 1 && (age < 6 * HOUR_MS || age >= 7 * HOUR_MS)) ||
      (request.attempt === 2 && (age < 7 * HOUR_MS || age >= 12 * HOUR_MS)) ||
      (request.attempt !== 1 && request.attempt !== 2)) {
      throw new RangeError("rain forecast slot is outside the fixed cycle policy");
    }
    return { kind: "forecast", slotKey: request.slotKey, stationId: null,
      runInitializedAt: request.runInitializedAt, attempt: request.attempt,
      start: null, endExclusive: null };
  }

  // reject an unknown discriminator before reading station properties
  if (request.kind !== "station" ||
    Object.keys(request).sort().join() !== "endExclusive,kind,slotKey,start,stationId") {
    throw new RangeError("rain station request keys are invalid");
  }
  // prevent an operator option from widening the frozen station entitlement
  if (!RAIN_COLLECTION_POLICY.stationAccessAuthorized) {
    throw new RangeError("rain station access is not authorized");
  }
  const start = parseUtc(request.start);
  const end = parseUtc(request.endExclusive);
  const hour = end - 1_000;

  // require one fixed gauge and one exact two-hour window ending one second after an hour
  if (!RAIN_COLLECTION_STATIONS.some((station) => station.locationId === request.stationId) ||
    hour % HOUR_MS !== 0 || end - start !== 2 * HOUR_MS ||
    request.slotKey !== `station:${String(request.stationId)}:${request.endExclusive}` ||
    time < hour + 2 * 60_000 || time >= hour + 2 * HOUR_MS) {
    throw new RangeError("rain station slot is outside the fixed hourly policy");
  }
  return { kind: "station", slotKey: request.slotKey, stationId: request.stationId,
    runInitializedAt: null, attempt: null, start: request.start,
    endExclusive: request.endExclusive };
}

// parse exact UTC milliseconds without accepting Date rollover
function parseUtc(value: string): number {
  const parsed = Date.parse(value);

  // require canonical instants rather than host-local dates
  if (!UTC_INSTANT.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RangeError("rain capture timestamp must be exact UTC milliseconds");
  }
  return parsed;
}

// reject oversized or credential-bearing receipt metadata
function validateReceiptFields(receipt: RainCaptureReceipt, hasBody: boolean): void {
  const status = receipt.httpStatus;

  // bind transport classes to their actual status and body evidence
  if (!Number.isSafeInteger(receipt.rowCount) || receipt.rowCount < 0 || receipt.rowCount > 100_000 ||
    (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) ||
    (receipt.outcome === "valid" && (status !== 200 || !hasBody || receipt.errorCode !== null)) ||
    (receipt.outcome === "rate_limited" && status !== 429) ||
    (receipt.outcome === "unauthorized" && status !== 401 && status !== 403) ||
    (receipt.outcome === "transport_error" && (status !== null || receipt.errorCode === null)) ||
    (receipt.outcome === "invalid" && (status === null || status === 401 || status === 403 || status === 429))) {
    throw new RangeError("rain capture outcome and HTTP status disagree");
  }
  const metadata = receipt.metadata;

  // retain only a small scalar and secret-free metadata envelope
  if (metadata === null || Array.isArray(metadata) || typeof metadata !== "object" ||
    JSON.stringify(metadata).length > 4_096 ||
    Object.entries(metadata).some(([key, value]) =>
      !/^[a-z][a-zA-Z0-9]{0,79}$/u.test(key) ||
      /(?:secret|token|authorization|apiKey|password|url)/iu.test(key) ||
      (typeof value === "string" && (value.length > 256 || /(?:https?:\/\/|api_key=)/iu.test(value))) ||
      (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
        (typeof value !== "number" || !Number.isFinite(value)))
    )) {
    throw new RangeError("rain capture metadata is unsafe");
  }
  const retrySeconds = metadata.retryAfterSeconds;
  const manualResume = metadata.retryAfterRequiresManualResume;

  // preserve bounded provider retry hints without silently shortening a 429 pause
  if ((retrySeconds !== undefined && retrySeconds !== null &&
      (!Number.isSafeInteger(retrySeconds) || Number(retrySeconds) < 0 || Number(retrySeconds) > 604_800)) ||
    (manualResume !== undefined && typeof manualResume !== "boolean") ||
    ((retrySeconds !== undefined || manualResume !== undefined) && receipt.outcome !== "rate_limited")) {
    throw new RangeError("rain capture retry-after metadata is invalid");
  }
  // constrain diagnostic codes independently from the body
  if (receipt.errorCode !== null && !/^[a-z][a-z0-9_]{0,79}$/u.test(receipt.errorCode)) {
    throw new RangeError("rain capture error code is invalid");
  }
}
