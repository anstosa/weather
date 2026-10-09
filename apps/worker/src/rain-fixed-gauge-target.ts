import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { RainAdjustmentCapture } from "@weather/database";
import {
  RAIN_COLLECTION_STATIONS,
  createNormalizedWeatherRecord,
  weatherRecordContent,
  type CanonicalWeatherMetrics,
} from "@weather/domain";
import {
  ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_MAX_BYTES,
  encodeAdjustmentRainFixedGaugeTargetProjection,
  encodeMaintenanceBinary64,
  type AdjustmentRainFixedGaugeTargetCaptureBody,
  type AdjustmentRainFixedGaugeTargetCaptureMember,
  type AdjustmentRainFixedGaugeTargetInterval,
  type AdjustmentRainFixedGaugeTargetProjection,
} from "@weather/forecast-adjustment";
import { normalizeTempestObservationPayload } from "@weather/providers";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

interface ReplayInterval {
  readonly amount: number | null;
  readonly capture: RainAdjustmentCapture;
  readonly minutes: number;
  readonly recordTemperature: number | null;
  readonly validAt: string;
}

export interface RainFixedGaugeTargetSource {
  readonly sourceId: string;
  readonly stationId: number;
}

export interface RainFixedGaugeHourReplay {
  readonly captureMembers: readonly AdjustmentRainFixedGaugeTargetCaptureMember[];
  readonly captures: readonly RainAdjustmentCapture[];
  readonly intervals: readonly AdjustmentRainFixedGaugeTargetInterval[];
  readonly precipitationMm: number | null;
  readonly receivedAt: string | null;
  readonly stationId: number;
  readonly temperatureC: number | null;
}

export type RainFixedGaugeTargetBuildResult =
  | Readonly<{
    bytes: Buffer;
    projection: AdjustmentRainFixedGaugeTargetProjection;
    state: "complete";
  }>
  | Readonly<{
    logicalHourAt: string;
    reason: "target_source_oversized";
    state: "gap";
  }>;

// replay one target hour through the existing raw Tempest interval recipe
export function replayRainFixedGaugeTargetHour(
  captures: readonly RainAdjustmentCapture[],
  validAt: string,
  targetCutoffAt: string,
  requireEveryStation = true,
): readonly RainFixedGaugeHourReplay[] {
  requireInstant(validAt, "validAt");
  requireInstant(targetCutoffAt, "targetCutoffAt");
  if (Date.parse(targetCutoffAt) < Date.parse(validAt)) {
    throw new RangeError("rain fixed-gauge cutoff precedes the target hour");
  }
  const target = Date.parse(validAt);
  return RAIN_COLLECTION_STATIONS.map((station) => {
    const selectedCaptures = captures.filter((capture) =>
      // select only immutable station responses able to prove this backward hour
      capture.kind === "station" && capture.stationId === station.locationId &&
      capture.windowStart !== null && capture.windowEndExclusive !== null &&
      Date.parse(capture.completedAt) <= Date.parse(targetCutoffAt) &&
      Date.parse(capture.windowStart) <= target &&
      Date.parse(capture.windowEndExclusive) > target - 65 * MINUTE_MS,
    ).sort(compareCaptures);
    if (selectedCaptures.length < 1) {
      // legacy model inputs omit stations outside the requested lag window
      if (!requireEveryStation) {
        return Object.freeze({
          captureMembers: Object.freeze([]),
          captures: Object.freeze([]),
          intervals: Object.freeze([]),
          precipitationMm: null,
          receivedAt: null,
          stationId: station.locationId,
          temperatureC: null,
        });
      }
      throw new RangeError(`rain fixed-gauge capture is absent for station ${station.locationId}`);
    }
    const observations = new Map<number, ReplayInterval>();
    // normalize every overlapping raw response before choosing any favorable value
    for (const capture of selectedCaptures) {
      verifyCapture(capture, station.locationId);
      const records = normalizeTempestObservationPayload(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(capture.body)),
        {
          deviceId: station.deviceId,
          locationId: station.locationId,
          serial: station.serial,
          start: capture.windowStart!,
          endExclusive: capture.windowEndExclusive!,
          sourceId: `rain-prospective-tempest-${station.locationId}`,
          timezone: "America/Los_Angeles",
        },
        capture.completedAt,
      );
      // retain the earliest matching response for every minute endpoint
      for (const record of records) {
        const minute = Date.parse(record.validAt) / MINUTE_MS;
        const provider = record.metadata.provider as Record<string, unknown>;
        const quality = record.metadata.quality as Record<string, unknown>;
        const duration = provider.report_interval_minutes;
        const flags = quality.flags ?? [];
        const accepted = quality.status == null && Array.isArray(flags) &&
          flags.every((flag) => flag === "uv_index_out_of_range");
        if (!Number.isInteger(minute) || !Number.isInteger(duration) || Number(duration) < 1 ||
            Number(duration) > 5) {
          throw new RangeError("rain fixed-gauge interval timing differs");
        }
        const interval: ReplayInterval = {
          amount: accepted ? record.metrics.precipitationMm : null,
          capture,
          minutes: accepted ? Number(duration) : 0,
          recordTemperature: accepted ? record.metrics.temperatureC : null,
          validAt: record.validAt,
        };
        const previous = observations.get(minute);
        // reject contradictory overlapping provider responses
        if (previous !== undefined && (previous.amount !== interval.amount ||
            previous.minutes !== interval.minutes ||
            previous.recordTemperature !== interval.recordTemperature)) {
          throw new RangeError("conflicting rain fixed-gauge interval across captures");
        }
        if (previous === undefined || compareCaptures(interval.capture, previous.capture) < 0) {
          observations.set(minute, interval);
        }
      }
    }
    return replayStationHour(station.locationId, selectedCaptures, observations, validAt);
  });
}

// construct the canonical body and native weather-record hashes for twelve gauges
export function buildRainFixedGaugeTargetProjection(input: Readonly<{
  captures: readonly RainAdjustmentCapture[];
  sources: readonly RainFixedGaugeTargetSource[];
  targetCutoffAt: string;
  validAt: string;
}>): RainFixedGaugeTargetBuildResult {
  const sourceIds = validateSourceCatalog(input.sources);
  const replay = replayRainFixedGaugeTargetHour(input.captures, input.validAt, input.targetCutoffAt);
  const captureBodies = buildCaptureBodies(replay);
  const rows = replay.map((hour, index) => {
    const station = RAIN_COLLECTION_STATIONS[index]!;
    const metrics = targetMetrics(hour);
    const normalizedRecord = createNormalizedWeatherRecord({
      metadata: {
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
          status: hour.precipitationMm === null
            ? "incomplete_interval_coverage"
            : "complete_interval_coverage",
        },
        upstreamTimezone: "America/Los_Angeles",
      },
      metrics,
      productRunAt: null,
      receivedAt: hour.captureMembers.at(-1)!.completedAt,
      sourceId: sourceIds[index]!,
      sourceKind: "physical_sensor",
      validAt: input.validAt,
    });
    return Object.freeze({
      captureMembers: hour.captureMembers,
      intervals: hour.precipitationMm === null ? Object.freeze([]) : hour.intervals,
      normalizedRecord,
      stationId: station.locationId,
      storedContentSha256: sha256(weatherRecordContent(normalizedRecord)),
    });
  });
  const logicalReceivedAt = rows.flatMap((row) => row.captureMembers)
    .map((member) => member.completedAt).sort().at(-1)!;
  const projection: AdjustmentRainFixedGaugeTargetProjection = Object.freeze({
    captureBodies,
    contractVersion: "adjustment-rain-fixed-gauge-target-projection/v1",
    family: "rain",
    logicalReceivedAt,
    projectionKind: "target_revision",
    rows: Object.freeze(rows),
    validAt: input.validAt,
  });
  let bytes: Buffer;
  try {
    bytes = encodeAdjustmentRainFixedGaugeTargetProjection(projection);
  } catch (error) {
    // classify only the reviewed pre-stage size refusal as a value-free gap
    if (error instanceof RangeError &&
        error.message === "adjustment rain fixed-gauge target exceeds its canonical cap") {
      return Object.freeze({
        logicalHourAt: input.validAt,
        reason: "target_source_oversized",
        state: "gap",
      });
    }
    throw error;
  }
  if (bytes.byteLength > ADJUSTMENT_RAIN_FIXED_GAUGE_TARGET_MAX_BYTES) {
    throw new RangeError("rain fixed-gauge encoder exceeded its advertised cap");
  }
  return Object.freeze({ bytes, projection, state: "complete" });
}

// select one station's newest endpoint and exact backward sixty-minute tiling
function replayStationHour(
  stationId: number,
  captures: readonly RainAdjustmentCapture[],
  observations: ReadonlyMap<number, ReplayInterval>,
  validAt: string,
): RainFixedGaugeHourReplay {
  const target = Date.parse(validAt) / MINUTE_MS;
  let end: number | null = null;
  let temperatureC: number | null = null;
  let receivedAt: string | null = null;
  // preserve the frozen five-minute backward endpoint tolerance
  for (let offset = 0; offset <= 5; offset += 1) {
    const interval = observations.get(target - offset);
    if (end === null && interval !== undefined) {
      end = target - offset;
    }
    if (temperatureC === null && interval?.recordTemperature != null) {
      temperatureC = interval.recordTemperature;
      receivedAt = interval.capture.completedAt;
    }
  }
  let precipitationMm: number | null = end === null ? null : 0;
  let wanted = end ?? target;
  const start = wanted - 60;
  const selected: ReplayInterval[] = [];
  // tile the complete hour without interpolation, proration or zero filling
  while (precipitationMm !== null && wanted > start) {
    const interval = observations.get(wanted);
    if (interval === undefined || interval.amount === null || interval.minutes <= 0 ||
        wanted - interval.minutes < start) {
      precipitationMm = null;
      break;
    }
    precipitationMm += interval.amount;
    selected.push(interval);
    receivedAt = receivedAt === null || interval.capture.completedAt > receivedAt
      ? interval.capture.completedAt
      : receivedAt;
    wanted -= interval.minutes;
  }
  const captureMembers = captures.map((capture) => Object.freeze({
    bodySha256: capture.bodySha256,
    claimId: capture.claimId,
    completedAt: capture.completedAt,
  }));
  const intervals = selected.reverse().map((interval) => Object.freeze({
    bodySha256: interval.capture.bodySha256,
    claimId: interval.capture.claimId,
    completedAt: interval.capture.completedAt,
    durationMinutes: interval.minutes,
    precipitationMm64: encodeMaintenanceBinary64(interval.amount!),
    temperatureC64: interval.recordTemperature === null
      ? null
      : encodeMaintenanceBinary64(interval.recordTemperature),
    validAt: interval.validAt,
  }));
  return Object.freeze({
    captureMembers: Object.freeze(captureMembers),
    captures: Object.freeze([...captures]),
    intervals: Object.freeze(intervals),
    precipitationMm,
    receivedAt,
    stationId,
    temperatureC,
  });
}

// deduplicate raw bytes while retaining every immutable claim address
function buildCaptureBodies(
  replay: readonly RainFixedGaugeHourReplay[],
): readonly AdjustmentRainFixedGaugeTargetCaptureBody[] {
  const bodies = new Map<string, { body: Buffer; claims: RainAdjustmentCapture[] }>();
  // collect every row member into its exact body-addressed group
  for (const capture of replay.flatMap((hour) => hour.captures)) {
    const existing = bodies.get(capture.bodySha256);
    if (existing !== undefined && !existing.body.equals(Buffer.from(capture.body))) {
      throw new RangeError("rain fixed-gauge body hash collision");
    }
    const group = existing ?? { body: Buffer.from(capture.body), claims: [] };
    group.claims.push(capture);
    bodies.set(capture.bodySha256, group);
  }
  return Object.freeze([...bodies.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([bodySha256, group]) => Object.freeze({
      bodyBase64: group.body.toString("base64"),
      bodySha256,
      claims: Object.freeze(group.claims.sort(compareCaptures).map((capture) => Object.freeze({
        claimId: capture.claimId,
        completedAt: capture.completedAt,
        stationId: capture.stationId!,
        windowEndExclusive: capture.windowEndExclusive!,
        windowStart: capture.windowStart!,
      }))),
    })));
}

// require one independently provisioned source for every fixed station
function validateSourceCatalog(sources: readonly RainFixedGaugeTargetSource[]): readonly string[] {
  if (!Array.isArray(sources) || sources.length !== RAIN_COLLECTION_STATIONS.length) {
    throw new TypeError("rain fixed-gauge source catalog differs");
  }
  const byStation = new Map(sources.map((source) => [source.stationId, source.sourceId]));
  if (byStation.size !== RAIN_COLLECTION_STATIONS.length) {
    throw new TypeError("rain fixed-gauge source catalog is duplicated");
  }
  const sourceIds = RAIN_COLLECTION_STATIONS.map((station) => byStation.get(station.locationId));
  if (sourceIds.some((sourceId) => typeof sourceId !== "string" || sourceId.length < 1 ||
      sourceId.length > 128) || new Set(sourceIds).size !== sourceIds.length) {
    throw new TypeError("rain fixed-gauge source identities differ");
  }
  return Object.freeze(sourceIds as string[]);
}

// retain only the target precipitation and endpoint temperature metrics
function targetMetrics(hour: RainFixedGaugeHourReplay): CanonicalWeatherMetrics {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: hour.precipitationMm,
    precipitationRateMmPerHour: hour.precipitationMm,
    pressureHpa: null,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: hour.temperatureC,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps: null,
    windSpeedMps: null,
  };
}

// bind every provider response to its stored whole-byte identity
function verifyCapture(capture: RainAdjustmentCapture, stationId: number): void {
  requireInstant(capture.completedAt, "completedAt");
  if (capture.kind !== "station" || capture.stationId !== stationId ||
      capture.windowStart === null || capture.windowEndExclusive === null ||
      createHash("sha256").update(capture.body).digest("hex") !== capture.bodySha256) {
    throw new TypeError("rain fixed-gauge capture identity differs");
  }
}

// order capture revisions before any provider value is inspected
function compareCaptures(left: RainAdjustmentCapture, right: RainAdjustmentCapture): number {
  return left.completedAt.localeCompare(right.completedAt) ||
    left.claimId.localeCompare(right.claimId) || left.bodySha256.localeCompare(right.bodySha256);
}

// require canonical UTC millisecond clocks at the producer boundary
function requireInstant(value: string, name: string): void {
  if (!/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      new Date(value).toISOString() !== value) {
    throw new TypeError(`rain fixed-gauge ${name} is invalid`);
  }
}

// hash exact native weather content without object coercion
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
