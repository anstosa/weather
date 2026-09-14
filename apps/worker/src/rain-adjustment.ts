import { createHash } from "node:crypto";
import {
  appendRainAdjustmentRun,
  readPendingRainAdjustmentCaptures,
  type createDatabasePool,
  type RainAdjustmentCapture,
  type RainAdjustmentRun,
} from "@weather/database";
import { RAIN_COLLECTION_STATIONS } from "@weather/domain";
import { normalizeTempestObservationPayload } from "@weather/providers";
import {
  predictRainHurdleWind,
  RAIN_HURDLE_WIND_MODEL_SHA256,
  type RainWindRunProfile,
  type RainWindStationHour,
} from "@weather/forecast-adjustment";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
type Pool = ReturnType<typeof createDatabasePool>;
interface Interval {
  readonly amount: number | null;
  readonly minutes: number;
  readonly temperature: number | null;
  readonly receivedAt: string;
}

// decode only source bodies already validated and hash-checked during capture
export function rainForecastProfile(capture: RainAdjustmentCapture): RainWindRunProfile {
  // bind the original six-hour run rather than a retrieval snapshot
  if (capture.kind !== "forecast" || capture.runInitializedAt === null) {
    throw new Error("invalid rain forecast capture");
  }
  const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(capture.body));
  const hourly = payload.hourly as Record<string, (number | string | null)[]>;
  const initialized = Date.parse(capture.runInitializedAt);
  // reject source geometry drift before indexing any features
  if (!Array.isArray(hourly?.time) || hourly.time.length !== 49 || payload.utc_offset_seconds !== 0) {
    throw new Error("invalid rain forecast profile");
  }
  const hours: RainWindRunProfile["hours"][number][] = [];
  // omit initialization and preserve the original one-based lead grid
  for (let lead = 1; lead <= 48; lead += 1) {
    // refuse an hour shifted away from the claimed initialized run
    if (hourly.time[lead] !== new Date(initialized + lead * HOUR_MS).toISOString().slice(0, 16)) {
      throw new Error("rain forecast hour mismatch");
    }
    // retain null covariates without fabricating zeros
    const value = (field: string): number | null => {
      const cell = hourly[field]?.[lead];
      // reject missing schema and nonnumeric fields
      if (cell !== null && (typeof cell !== "number" || !Number.isFinite(cell))) {
        throw new Error("invalid rain forecast value");
      }
      return cell;
    };
    hours.push({
      leadHours: lead,
      precipitationMm: value("precipitation"), temperatureC: value("temperature_2m"),
      relativeHumidityPercent: value("relative_humidity_2m"), cloudCoverPercent: value("cloud_cover"),
      pressureHpa: value("surface_pressure"), windSpeedMps: value("wind_speed_10m"),
      windDirectionDegrees: value("wind_direction_10m"),
    });
  }
  return { runInitializedAt: capture.runInitializedAt, completedAt: capture.completedAt, hours };
}

// reconstruct exact lagged gauge hours without future receipts or interval interpolation
export function rainStationHours(
  captures: readonly RainAdjustmentCapture[],
  decisionAt: string,
): readonly RainWindStationHour[] {
  const decision = Date.parse(decisionAt);
  const observations = new Map<number, Map<number, Interval>>();
  // preserve one physical interval across overlapping collection windows
  for (const capture of captures) {
    // never admit future receipt evidence to an earlier model decision
    if (capture.kind !== "station" || Date.parse(capture.completedAt) > decision) {
      continue;
    }
    const station = RAIN_COLLECTION_STATIONS.find((item) => item.locationId === capture.stationId);
    // refuse source substitutions and missing window identity
    if (station === undefined || capture.windowStart === null || capture.windowEndExclusive === null) {
      throw new Error("invalid rain station identity");
    }
    const records = normalizeTempestObservationPayload(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(capture.body)),
      {
        deviceId: station.deviceId, locationId: station.locationId, serial: station.serial,
        start: capture.windowStart, endExclusive: capture.windowEndExclusive,
        sourceId: `rain-prospective-tempest-${station.locationId}`, timezone: "America/Los_Angeles",
      },
      capture.completedAt,
    );
    const byMinute = observations.get(station.locationId) ?? new Map<number, Interval>();
    // match the historical allowed quality flags and minute endpoints
    for (const record of records) {
      const minute = Date.parse(record.validAt) / MINUTE_MS;
      const provider = record.metadata.provider as Record<string, unknown>;
      const quality = record.metadata.quality as Record<string, unknown>;
      const duration = provider.report_interval_minutes;
      const flags = quality.flags ?? [];
      const accepted = quality.status == null && Array.isArray(flags) &&
        flags.every((flag) => flag === "uv_index_out_of_range");
      // reject off-grid intervals or malformed durations rather than rounding
      if (!Number.isInteger(minute) || !Number.isInteger(duration) || Number(duration) < 1 || Number(duration) > 5) {
        throw new Error("invalid rain interval timing");
      }
      const interval: Interval = {
        amount: accepted ? record.metrics.precipitationMm : null,
        minutes: accepted ? Number(duration) : 0,
        temperature: accepted ? record.metrics.temperatureC : null,
        receivedAt: capture.completedAt,
      };
      const previous = byMinute.get(minute);
      // reject contradictory reports without choosing a favorable revision
      if (previous !== undefined && (previous.amount !== interval.amount ||
        previous.minutes !== interval.minutes || previous.temperature !== interval.temperature)) {
        throw new Error("conflicting rain station interval");
      }
      // preserve the earliest matching response as the actual availability proof
      if (previous === undefined || interval.receivedAt < previous.receivedAt) {
        byMinute.set(minute, interval);
      }
    }
    observations.set(station.locationId, byMinute);
  }
  const result: RainWindStationHour[] = [];
  // reproduce only the model's frozen causal lag requests
  for (const lag of [1, 2, 3, 6, 12, 24]) {
    const hour = decision - lag * HOUR_MS;
    // preserve every fixed gauge, including explicitly missing station hours
    for (const station of RAIN_COLLECTION_STATIONS) {
      const minutes = observations.get(station.locationId) ?? new Map<number, Interval>();
      const target = hour / MINUTE_MS;
      let end: number | null = null;
      let temperature: number | null = null;
      let receivedAt: string | null = null;
      // accept only the same backward five-minute endpoint tolerance as research
      for (let offset = 0; offset <= 5; offset += 1) {
        const interval = minutes.get(target - offset);
        // choose the newest retained endpoint even if its rain is unusable
        if (end === null && interval !== undefined) {
          end = target - offset;
        }
        // preserve the latest physical temperature inside that same backward window
        if (temperature === null && interval?.temperature != null) {
          temperature = interval.temperature;
          receivedAt = interval.receivedAt;
        }
      }
      let amount: number | null = end === null ? null : 0;
      let wanted = end ?? target;
      const start = wanted - 60;
      // tile a complete backward hour without prorating or filling any missing minute
      while (amount !== null && wanted > start) {
        const interval = minutes.get(wanted);
        // partial, invalid and overshooting intervals invalidate the entire hour
        if (interval === undefined || interval.amount === null || interval.minutes <= 0 ||
          wanted - interval.minutes < start) {
          amount = null;
          break;
        }
        amount += interval.amount;
        receivedAt = receivedAt === null || interval.receivedAt > receivedAt ? interval.receivedAt : receivedAt;
        wanted -= interval.minutes;
      }
      // omit absent gauges rather than manufacturing a receipt time for a null hour
      if (receivedAt !== null && (amount !== null || temperature !== null)) {
        result.push({ hourAt: new Date(hour).toISOString(), stationId: station.locationId,
          receivedAt, precipitationMm: amount, temperatureC: temperature });
      }
    }
  }
  return result;
}

// freeze one current inference from the existing model without training or extra requests
export function createRainAdjustmentRun(
  captures: readonly RainAdjustmentCapture[],
  nowUtc: string,
): RainAdjustmentRun | null {
  const forecastCaptures = captures.filter((capture) => capture.kind === "forecast")
    .sort((left, right) => Date.parse(right.runInitializedAt!) - Date.parse(left.runInitializedAt!));
  const current = forecastCaptures[0];
  // preserve a missing source as raw instead of inventing another provider
  if (current?.runInitializedAt == null) {
    return null;
  }
  const decisionAt = new Date(Date.parse(current.runInitializedAt) + 8 * HOUR_MS).toISOString();
  const prediction = predictRainHurdleWind({
    currentRun: rainForecastProfile(current),
    priorRuns: forecastCaptures.slice(1).map(rainForecastProfile),
    stationHours: rainStationHours(captures, decisionAt),
    nowUtc,
  });
  return {
    runInitializedAt: current.runInitializedAt, modelSha256: prediction.modelSha256,
    inputSha256: createHash("sha256").update(JSON.stringify(captures.map((capture) => [
      capture.claimId, capture.bodySha256, capture.completedAt,
    ]))).digest("hex"),
    forecastClaimId: current.claimId, firstReceivedAt: current.completedAt,
    decisionAt, generatedAt: nowUtc, hours: prediction.hours,
  };
}

// isolate inference storage from the append-only provider collection loop
export async function publishRainAdjustment(pool: Pool, now: Date = new Date()): Promise<boolean> {
  const captures = await readPendingRainAdjustmentCaptures(pool, RAIN_HURDLE_WIND_MODEL_SHA256);
  const run = createRainAdjustmentRun(captures, now.toISOString());
  return run === null ? false : await appendRainAdjustmentRun(pool, run);
}
