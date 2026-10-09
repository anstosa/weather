import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  RAIN_COLLECTION_STATIONS,
  createNormalizedWeatherRecord,
  weatherRecordContent,
  type JsonValue,
  type NormalizedWeatherRecord,
} from "@weather/domain";

import { canonicalJsonBytes } from "./candidate.js";
import {
  decodeMaintenanceBinary64,
} from "./maintenance-shadow-values.js";
import {
  rainMaintenanceStationWeight,
  rainMaintenanceWeightedMedian,
} from "./maintenance-revision-projection.js";

export const ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_PROJECTION_VERSION =
  "adjustment-rain-fixed-gauge-target-projection/v1" as const;
export const ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_LOGICAL_KEY_VERSION =
  "adjustment-rain-fixed-gauge-target-logical-key/v1" as const;
export const ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_MAX_BYTES = 3_500 * 1_024;

const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TOP_KEYS = [
  "captureBodies", "contractVersion", "family", "logicalReceivedAt", "projectionKind", "rows",
  "validAt",
] as const;
const BODY_KEYS = ["bodyBase64", "bodySha256", "claims"] as const;
const CLAIM_KEYS = ["claimId", "completedAt", "stationId", "windowEndExclusive", "windowStart"] as const;
const ROW_KEYS = ["captureMembers", "intervals", "normalizedRecord", "stationId", "storedContentSha256"] as const;
const MEMBER_KEYS = ["bodySha256", "claimId", "completedAt"] as const;
const INTERVAL_KEYS = [
  "bodySha256", "claimId", "completedAt", "durationMinutes", "precipitationMm64", "temperatureC64",
  "validAt",
] as const;
const LOGICAL_KEY_KEYS = ["contractVersion", "sourceIds", "validAt"] as const;
const RECORD_KEYS = ["metadata", "metrics", "productRunAt", "receivedAt", "sourceId", "sourceKind", "validAt"] as const;
const METRIC_KEYS = [
  "apparentTemperatureC", "blackGlobeTemperatureC", "cloudCoverPercent",
  "pm25MicrogramsPerCubicMeter", "precipitationMm", "precipitationRateMmPerHour", "pressureHpa",
  "relativeHumidityPercent", "soilElectricalConductivityMicrosiemensPerCm", "soilMoisturePercent",
  "solarRadiationWm2", "temperatureC", "uvIndex", "waterLevelM", "wetBulbGlobeTemperatureC",
  "windDirectionDegrees", "windGustMps", "windSpeedMps",
] as const;

export interface AdjustmentRainFixedGaugeTargetClaim {
  readonly claimId: string;
  readonly completedAt: string;
  readonly stationId: number;
  readonly windowEndExclusive: string;
  readonly windowStart: string;
}

export interface AdjustmentRainFixedGaugeTargetCaptureBody {
  readonly bodyBase64: string;
  readonly bodySha256: string;
  readonly claims: readonly AdjustmentRainFixedGaugeTargetClaim[];
}

export interface AdjustmentRainFixedGaugeTargetCaptureMember {
  readonly bodySha256: string;
  readonly claimId: string;
  readonly completedAt: string;
}

export interface AdjustmentRainFixedGaugeTargetInterval {
  readonly bodySha256: string;
  readonly claimId: string;
  readonly completedAt: string;
  readonly durationMinutes: number;
  readonly precipitationMm64: string;
  readonly temperatureC64: string | null;
  readonly validAt: string;
}

export interface AdjustmentRainFixedGaugeTargetRow {
  readonly captureMembers: readonly AdjustmentRainFixedGaugeTargetCaptureMember[];
  readonly intervals: readonly AdjustmentRainFixedGaugeTargetInterval[];
  readonly normalizedRecord: NormalizedWeatherRecord;
  readonly stationId: number;
  readonly storedContentSha256: string;
}

export interface AdjustmentRainFixedGaugeTargetProjection {
  readonly captureBodies: readonly AdjustmentRainFixedGaugeTargetCaptureBody[];
  readonly contractVersion: typeof ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_PROJECTION_VERSION;
  readonly family: "rain";
  readonly logicalReceivedAt: string;
  readonly projectionKind: "target_revision";
  readonly rows: readonly AdjustmentRainFixedGaugeTargetRow[];
  readonly validAt: string;
}

export interface AdjustmentRainFixedGaugeTargetLogicalKey {
  readonly contractVersion: typeof ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_LOGICAL_KEY_VERSION;
  readonly sourceIds: readonly string[];
  readonly validAt: string;
}

export interface AdjustmentRainFixedGaugeTargetActual {
  readonly firstEdgeCommittedAt: string;
  readonly gaugeCount: number;
  readonly target: number;
}

// encode one closed twelve-gauge target body before archive staging
export function encodeAdjustmentRainFixedGaugeTargetProjection(
  value: AdjustmentRainFixedGaugeTargetProjection,
): Buffer {
  validateAdjustmentRainFixedGaugeTargetProjection(value);
  const bytes = Buffer.from(canonicalJsonBytes(value as unknown as JsonValue));
  // preserve room for receipts and page metadata under the fixed wire cap
  if (bytes.byteLength > ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_MAX_BYTES) {
    throw new RangeError("adjustment rain fixed-gauge target exceeds its canonical cap");
  }
  return bytes;
}

// parse only the canonical whole-byte target representation
export function parseAdjustmentRainFixedGaugeTargetProjection(
  bytes: Uint8Array,
): AdjustmentRainFixedGaugeTargetProjection {
  // cap hostile bodies before decoding embedded provider responses
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
      bytes.byteLength > ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_MAX_BYTES) {
    throw new RangeError("adjustment rain fixed-gauge target size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    AdjustmentRainFixedGaugeTargetProjection;
  const canonical = encodeAdjustmentRainFixedGaugeTargetProjection(value);
  // reject alternate ordering, whitespace, duplicate keys and base64 aliases
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new TypeError("adjustment rain fixed-gauge target is not canonical");
  }
  return value;
}

// validate one independently replayable fixed-gauge target document
export function validateAdjustmentRainFixedGaugeTargetProjection(
  value: AdjustmentRainFixedGaugeTargetProjection,
): void {
  exactKeys(value, TOP_KEYS);
  requireInstant(value.logicalReceivedAt, "logicalReceivedAt");
  requireInstant(value.validAt, "validAt");
  // retain this grammar exclusively for the dedicated rain target stream
  if (value.contractVersion !== ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_PROJECTION_VERSION ||
      value.family !== "rain" || value.projectionKind !== "target_revision" ||
      !Array.isArray(value.captureBodies) || value.captureBodies.length < 1 ||
      !Array.isArray(value.rows) || value.rows.length !== RAIN_COLLECTION_STATIONS.length) {
    throw new TypeError("adjustment rain fixed-gauge target identity differs");
  }
  const claims = validateCaptureBodies(value.captureBodies, value.validAt);
  const referencedClaims = new Set<string>();
  let latestCompletedAt: string | null = null;
  // bind every normalized row to one fixed physical gauge and its raw captures
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, ROW_KEYS);
    const station = RAIN_COLLECTION_STATIONS[index];
    if (station === undefined || row.stationId !== station.locationId ||
        !Array.isArray(row.captureMembers) || !Array.isArray(row.intervals)) {
      throw new TypeError("adjustment rain fixed-gauge station order differs");
    }
    const rowClaims = validateCaptureMembers(row.captureMembers, row.stationId, claims);
    for (const member of row.captureMembers) {
      const key = claimKey(member.bodySha256, member.claimId);
      referencedClaims.add(key);
      latestCompletedAt = latestCompletedAt === null || member.completedAt > latestCompletedAt
        ? member.completedAt
        : latestCompletedAt;
    }
    validateIntervals(row.intervals, rowClaims, value.validAt);
    validateNormalizedTargetRecord(row, station, value.validAt);
  }
  // prohibit unused raw bodies or claims and bind the document availability clock
  if (referencedClaims.size !== claims.size ||
      [...claims.keys()].some((key) => !referencedClaims.has(key)) ||
      latestCompletedAt !== value.logicalReceivedAt) {
    throw new TypeError("adjustment rain fixed-gauge capture graph differs");
  }
}

// hash the value-free fixed-catalog logical key shared by all twelve rows
export function adjustmentRainFixedGaugeTargetLogicalKeySha256(input: Readonly<{
  sourceIds: readonly string[];
  validAt: string;
}>): string {
  requireInstant(input.validAt, "validAt");
  if (!Array.isArray(input.sourceIds) || input.sourceIds.length !== RAIN_COLLECTION_STATIONS.length ||
      new Set(input.sourceIds).size !== input.sourceIds.length ||
      input.sourceIds.some((sourceId) => typeof sourceId !== "string" || sourceId.length < 1 ||
        sourceId.length > 128)) {
    throw new TypeError("adjustment rain fixed-gauge source catalog differs");
  }
  const key: AdjustmentRainFixedGaugeTargetLogicalKey = {
    contractVersion: ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_LOGICAL_KEY_VERSION,
    sourceIds: [...input.sourceIds],
    validAt: input.validAt,
  };
  exactKeys(key, LOGICAL_KEY_KEYS);
  return sha256(Buffer.from(canonicalJsonBytes(key as unknown as JsonValue)));
}

// derive the frozen weighted-median target from one parser-authenticated document
export function adjustmentRainFixedGaugeTargetActual(
  value: AdjustmentRainFixedGaugeTargetProjection,
): AdjustmentRainFixedGaugeTargetActual | null {
  validateAdjustmentRainFixedGaugeTargetProjection(value);
  const gauges = value.rows.flatMap((row, index) => {
    // retain explicit missing gauges rather than treating them as dry
    if (row.normalizedRecord.metrics.precipitationMm === null) {
      return [];
    }
    const station = RAIN_COLLECTION_STATIONS[index]!;
    return [{
      id: station.locationId,
      value: row.normalizedRecord.metrics.precipitationMm,
      weight: rainMaintenanceStationWeight(station),
    }];
  });
  // preserve the frozen three-gauge and nearest-three support gate
  if (gauges.length < 3 || !value.rows.slice(0, 3)
    .some((row) => row.normalizedRecord.metrics.precipitationMm !== null)) {
    return null;
  }
  return Object.freeze({
    firstEdgeCommittedAt: value.logicalReceivedAt,
    gaugeCount: gauges.length,
    target: rainMaintenanceWeightedMedian(gauges),
  });
}

// validate and index every exact raw provider body and claim
function validateCaptureBodies(
  bodies: readonly AdjustmentRainFixedGaugeTargetCaptureBody[],
  validAt: string,
): ReadonlyMap<string, AdjustmentRainFixedGaugeTargetClaim> {
  const claims = new Map<string, AdjustmentRainFixedGaugeTargetClaim>();
  let previousBodySha256: string | null = null;
  // preserve body-address order independently of database capture order
  for (const body of bodies) {
    exactKeys(body, BODY_KEYS);
    requireHash(body.bodySha256, "bodySha256");
    if (previousBodySha256 !== null && body.bodySha256 <= previousBodySha256) {
      throw new TypeError("adjustment rain fixed-gauge bodies are not ordered");
    }
    previousBodySha256 = body.bodySha256;
    if (typeof body.bodyBase64 !== "string" || body.bodyBase64.length < 4) {
      throw new TypeError("adjustment rain fixed-gauge body is invalid");
    }
    const raw = Buffer.from(body.bodyBase64, "base64");
    // require exact padded base64 and the claimed whole-byte hash
    if (raw.toString("base64") !== body.bodyBase64 || sha256(raw) !== body.bodySha256 ||
        !Array.isArray(body.claims) || body.claims.length < 1) {
      throw new TypeError("adjustment rain fixed-gauge body identity differs");
    }
    let previousClaim: string | null = null;
    // authenticate every claim carried by one deduplicated body
    for (const claim of body.claims) {
      exactKeys(claim, CLAIM_KEYS);
      requireClaimId(claim.claimId);
      requireInstant(claim.completedAt, "completedAt");
      requireInstant(claim.windowStart, "windowStart");
      requireInstant(claim.windowEndExclusive, "windowEndExclusive");
      const order = `${claim.completedAt}\n${claim.claimId}`;
      const station = RAIN_COLLECTION_STATIONS.find((entry) => entry.locationId === claim.stationId);
      // accept only real two-hour collection windows that overlap this target hour
      if (station === undefined || Date.parse(claim.windowStart) >= Date.parse(claim.windowEndExclusive) ||
          Date.parse(claim.windowStart) > Date.parse(validAt) ||
          Date.parse(claim.windowEndExclusive) <= Date.parse(validAt) - 65 * 60_000 ||
          (previousClaim !== null && order <= previousClaim)) {
        throw new TypeError("adjustment rain fixed-gauge claim differs");
      }
      previousClaim = order;
      const key = claimKey(body.bodySha256, claim.claimId);
      if (claims.has(key)) {
        throw new TypeError("adjustment rain fixed-gauge claim is duplicated");
      }
      claims.set(key, claim);
    }
  }
  return claims;
}

// validate one station's complete raw-capture membership
function validateCaptureMembers(
  members: readonly AdjustmentRainFixedGaugeTargetCaptureMember[],
  stationId: number,
  claims: ReadonlyMap<string, AdjustmentRainFixedGaugeTargetClaim>,
): ReadonlyMap<string, AdjustmentRainFixedGaugeTargetClaim> {
  if (members.length < 1) {
    throw new TypeError("adjustment rain fixed-gauge row lacks capture evidence");
  }
  const selected = new Map<string, AdjustmentRainFixedGaugeTargetClaim>();
  let previous: string | null = null;
  // bind sorted row membership to the exact deduplicated body claim
  for (const member of members) {
    exactKeys(member, MEMBER_KEYS);
    requireHash(member.bodySha256, "bodySha256");
    requireClaimId(member.claimId);
    requireInstant(member.completedAt, "completedAt");
    const order = `${member.completedAt}\n${member.claimId}\n${member.bodySha256}`;
    const key = claimKey(member.bodySha256, member.claimId);
    const claim = claims.get(key);
    if (claim === undefined || claim.stationId !== stationId || claim.completedAt !== member.completedAt ||
        selected.has(key) || (previous !== null && order <= previous)) {
      throw new TypeError("adjustment rain fixed-gauge capture membership differs");
    }
    previous = order;
    selected.set(key, claim);
  }
  return selected;
}

// validate the exact successful minute intervals selected by the frozen recipe
function validateIntervals(
  intervals: readonly AdjustmentRainFixedGaugeTargetInterval[],
  claims: ReadonlyMap<string, AdjustmentRainFixedGaugeTargetClaim>,
  validAt: string,
): void {
  let previousValidAt: string | null = null;
  // preserve chronological interval order without allowing duplicate endpoints
  for (const interval of intervals) {
    exactKeys(interval, INTERVAL_KEYS);
    requireHash(interval.bodySha256, "bodySha256");
    requireClaimId(interval.claimId);
    requireInstant(interval.completedAt, "completedAt");
    requireInstant(interval.validAt, "interval validAt");
    const claim = claims.get(claimKey(interval.bodySha256, interval.claimId));
    if (claim === undefined || claim.completedAt !== interval.completedAt ||
        !Number.isInteger(interval.durationMinutes) || interval.durationMinutes < 1 ||
        interval.durationMinutes > 5 || (previousValidAt !== null && interval.validAt <= previousValidAt) ||
        Date.parse(interval.validAt) > Date.parse(validAt) ||
        Date.parse(interval.validAt) < Date.parse(validAt) - 65 * 60_000) {
      throw new TypeError("adjustment rain fixed-gauge interval differs");
    }
    previousValidAt = interval.validAt;
    const precipitation = decodeMaintenanceBinary64(interval.precipitationMm64);
    if (precipitation < 0) {
      throw new TypeError("adjustment rain fixed-gauge interval amount differs");
    }
    if (interval.temperatureC64 !== null) {
      decodeMaintenanceBinary64(interval.temperatureC64);
    }
  }
}

// bind one derived hourly record to its station, target clock and selected intervals
function validateNormalizedTargetRecord(
  row: AdjustmentRainFixedGaugeTargetRow,
  station: typeof RAIN_COLLECTION_STATIONS[number],
  validAt: string,
): void {
  requireHash(row.storedContentSha256, "storedContentSha256");
  exactKeys(row.normalizedRecord, RECORD_KEYS);
  const record = createNormalizedWeatherRecord(row.normalizedRecord);
  if (record.sourceKind !== "physical_sensor" || record.productRunAt !== null ||
      record.validAt !== validAt || record.receivedAt !== row.captureMembers.at(-1)?.completedAt ||
      sha256(weatherRecordContent(record)) !== row.storedContentSha256) {
    throw new TypeError("adjustment rain fixed-gauge normalized record differs");
  }
  validateTargetMetadata(record, station, row.intervals.length > 0);
  exactKeys(record.metrics, METRIC_KEYS);
  const expectedNull = METRIC_KEYS.filter((key) => ![
    "precipitationMm", "precipitationRateMmPerHour", "temperatureC",
  ].includes(key));
  if (expectedNull.some((key) => record.metrics[key] !== null)) {
    throw new TypeError("adjustment rain fixed-gauge record has unrelated metrics");
  }
  const tiled = validateCompleteTiling(row.intervals, validAt);
  // complete rows must equal their exact sixty-minute interval sum
  if (tiled !== null) {
    const amount = row.intervals.reduce(
      // sum only parser-validated finite binary64 values
      (sum, interval) => sum + decodeMaintenanceBinary64(interval.precipitationMm64),
      0,
    );
    if (record.metrics.precipitationMm !== amount ||
        record.metrics.precipitationRateMmPerHour !== amount) {
      throw new TypeError("adjustment rain fixed-gauge record amount differs");
    }
    return;
  }
  // incomplete source coverage stays explicit and never becomes a zero
  if (record.metrics.precipitationMm !== null || record.metrics.precipitationRateMmPerHour !== null ||
      row.intervals.length !== 0) {
    throw new TypeError("adjustment rain fixed-gauge incomplete record differs");
  }
}

// require the closed aggregate metadata derived from one physical Tempest gauge
function validateTargetMetadata(
  record: NormalizedWeatherRecord,
  station: typeof RAIN_COLLECTION_STATIONS[number],
  complete: boolean,
): void {
  const expected = {
    device: { model: "Tempest", serial: station.serial, vendor: "WeatherFlow" },
    model: null,
    provider: {
      dataset: "rain_fixed_gauge_hourly",
      device_id: station.deviceId,
      location_id: station.locationId,
      report_interval_minutes: 60,
    },
    quality: {
      sampling: "backward_exact_interval_tiling",
      status: complete ? "complete_interval_coverage" : "incomplete_interval_coverage",
    },
    upstreamTimezone: "America/Los_Angeles",
  };
  if (JSON.stringify(record.metadata) !== JSON.stringify(expected)) {
    throw new TypeError("adjustment rain fixed-gauge metadata differs");
  }
}

// confirm one exact backward sixty-minute tiling and endpoint tolerance
function validateCompleteTiling(
  intervals: readonly AdjustmentRainFixedGaugeTargetInterval[],
  validAt: string,
): true | null {
  if (intervals.length === 0) {
    return null;
  }
  let elapsedMinutes = 0;
  let previousEnd: number | null = null;
  // walk the chronological tiling without interpolation or proration
  for (const interval of intervals) {
    const end = Date.parse(interval.validAt);
    const start = end - interval.durationMinutes * 60_000;
    if (previousEnd !== null && start !== previousEnd) {
      throw new TypeError("adjustment rain fixed-gauge intervals do not tile");
    }
    previousEnd = end;
    elapsedMinutes += interval.durationMinutes;
  }
  const finalEnd = Date.parse(intervals.at(-1)!.validAt);
  const offsetMinutes = (Date.parse(validAt) - finalEnd) / 60_000;
  if (elapsedMinutes !== 60 || !Number.isInteger(offsetMinutes) || offsetMinutes < 0 || offsetMinutes > 5) {
    throw new TypeError("adjustment rain fixed-gauge hour geometry differs");
  }
  return true;
}

// form one unambiguous body-claim address
function claimKey(bodySha256: string, claimId: string): string {
  return `${bodySha256}\n${claimId}`;
}

// require exact object keys without admitting private extensions
function exactKeys(value: unknown, keys: readonly string[]): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("adjustment rain fixed-gauge object is invalid");
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError("adjustment rain fixed-gauge keys differ");
  }
}

// require one canonical UTC millisecond instant
function requireInstant(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !INSTANT.test(value) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`adjustment rain fixed-gauge ${name} is invalid`);
  }
}

// require one bounded immutable capture claim identity
function requireClaimId(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TypeError("adjustment rain fixed-gauge claim identity is invalid");
  }
}

// require one lowercase SHA-256 identity
function requireHash(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`adjustment rain fixed-gauge ${name} is invalid`);
  }
}

// hash exact strings or byte sequences without coercing objects
function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
