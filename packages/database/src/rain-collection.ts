import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  RAIN_COLLECTION_POLICY,
  RAIN_COLLECTION_STATIONS,
  type RainCaptureReceipt,
  type RainCaptureRequest,
  type RainCollectionStatus,
} from "@weather/domain";
import type { Pool, QueryResultRow } from "pg";

import { withTransaction } from "./pool.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const CLAIM_LOCK = 7_203_492_731_157_622;
const HASH = /^[a-f0-9]{64}$/u;
const RELEASE = /^(\d{4})\.(\d{2})\.(\d{2})-([1-9]\d?)$/u;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const POLICY_JSON = JSON.stringify(RAIN_COLLECTION_POLICY);
const POLICY_SHA = createHash("sha256").update(POLICY_JSON).digest("hex");

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
