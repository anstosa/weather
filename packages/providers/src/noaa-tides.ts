import {
  createNormalizedWeatherRecord,
  normalizeMetricValue,
  validateTimeZone,
  type CanonicalWeatherMetrics,
  type JsonValue,
  type NormalizedWeatherRecord,
} from "@weather/domain";

import {
  ProviderFailure,
  type HistoricalProviderOperation,
  type ProviderBatch,
  type ProviderFetchOptions,
} from "./contract.js";
import { fetchJsonWithRetry } from "./http.js";

export const NOAA_TIDE_OBSERVATION_ADAPTER_VERSION = "noaa-water-level/v1";
export const NOAA_TIDE_PREDICTION_ADAPTER_VERSION = "noaa-tide-predictions/v1";
export const NOAA_TIDE_CHUNK_PLAN_VERSION = "noaa-calendar-range/v1";

const NOAA_DATA_ENDPOINT =
  "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const MAX_OBSERVATION_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_PREDICTION_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

interface NoaaTideRangeBase {
  readonly datum: "MLLW";
  readonly endExclusive: string;
  readonly sourceId: string;
  readonly start: string;
  readonly stationId: string;
  readonly timezone: string;
}

export interface NoaaTideObservationRequest extends NoaaTideRangeBase {
  readonly product: "water_level";
  readonly sourceKind: "tide_observation";
}

export interface NoaaTidePredictionRequest extends NoaaTideRangeBase {
  readonly interval: "hilo";
  readonly product: "predictions";
  readonly sourceKind: "tide_prediction";
}

export type NoaaTideRangeRequest =
  | NoaaTideObservationRequest
  | NoaaTidePredictionRequest;

export type NoaaTideRangeOperation =
  HistoricalProviderOperation<NoaaTideRangeRequest>;

// select the frozen NOAA adapter contract
export function noaaTideAdapterVersion(
  sourceKind: NoaaTideRangeRequest["sourceKind"],
): string {
  // map observed water levels
  if (sourceKind === "tide_observation") {
    return NOAA_TIDE_OBSERVATION_ADAPTER_VERSION;
  }

  return NOAA_TIDE_PREDICTION_ADAPTER_VERSION;
}

// build one bounded NOAA data request
export function buildNoaaTideRequest(input: NoaaTideRangeRequest): URL {
  const maximumRange = input.sourceKind === "tide_observation"
    ? MAX_OBSERVATION_RANGE_MS
    : MAX_PREDICTION_RANGE_MS;
  const window = validateRange(input, maximumRange);
  const url = new URL(NOAA_DATA_ENDPOINT);
  url.searchParams.set("application", "weather.ballydidean.farm");
  url.searchParams.set("begin_date", formatNoaaInstant(window.start));
  url.searchParams.set("end_date", formatNoaaInstant(window.endExclusive - 60_000));
  url.searchParams.set("station", input.stationId);
  url.searchParams.set("product", input.product);
  url.searchParams.set("datum", input.datum);
  url.searchParams.set("time_zone", "gmt");
  url.searchParams.set("units", "metric");
  url.searchParams.set("format", "json");

  // request high and low events for a subordinate station
  if (input.sourceKind === "tide_prediction") {
    url.searchParams.set("interval", input.interval);
  }

  return url;
}

// fetch and normalize one NOAA tide range
export async function fetchNoaaTideRange(
  input: NoaaTideRangeRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  const response = await fetchJsonWithRetry(
    buildNoaaTideRequest(input),
    { maxBodyBytes: 10_000_000, ...options },
  );
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizeNoaaTidePayload(response.payload, input, receivedAt);
  const lastRecord = records.at(-1);
  return {
    attempts: response.attempts,
    checksum: response.checksum,
    providerCursor:
      lastRecord === undefined ? null : { valid_at: lastRecord.validAt },
    records,
    responseMetadata: {
      datum: input.datum,
      normalized_record_count: records.length,
      product: input.product,
      provider: "noaa-co-ops",
      station_id: input.stationId,
    },
  };
}

// normalize NOAA observations or predictions
export function normalizeNoaaTidePayload(
  payload: unknown,
  input: NoaaTideRangeRequest,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const maximumRange = input.sourceKind === "tide_observation"
    ? MAX_OBSERVATION_RANGE_MS
    : MAX_PREDICTION_RANGE_MS;
  const window = validateRange(input, maximumRange);
  const root = requireObject(payload, "NOAA response");

  // surface provider-declared failures
  if (root.error !== undefined && root.error !== null) {
    const error = requireObject(root.error, "NOAA error");
    throw invalidPayload(requireString(error.message, "NOAA error message", 512));
  }

  const key = input.sourceKind === "tide_observation" ? "data" : "predictions";
  const rows = requireArray(root[key], `NOAA ${key}`);
  const records: NormalizedWeatherRecord[] = [];

  // normalize every in-window provider row
  for (const [index, raw] of rows.entries()) {
    const row = requireObject(raw, `${key}[${index}]`);
    const validAt = parseNoaaInstant(row.t, `${key}[${index}].t`);
    const epoch = Date.parse(validAt);

    // remove inclusive boundary padding
    if (epoch < window.start || epoch >= window.endExclusive) {
      continue;
    }

    const predictionType = input.sourceKind === "tide_prediction"
      ? requirePredictionType(row.type, `${key}[${index}].type`)
      : null;
    const quality = input.sourceKind === "tide_observation"
      ? observationQuality(row)
      : { sampling: "high_low_prediction" };
    records.push(
      createNormalizedWeatherRecord({
        metadata: {
          device: {
            model: input.sourceKind === "tide_observation"
              ? "Water Level Station"
              : "Tide Prediction Station",
            serial: input.stationId,
            vendor: "NOAA CO-OPS",
          },
          model: null,
          provider: {
            dataset: input.product,
            datum: input.datum,
            prediction_type: predictionType,
            product: input.product,
            station_id: input.stationId,
          },
          quality,
          upstreamTimezone: input.timezone,
        },
        metrics: {
          ...emptyMetrics(),
          waterLevelM: normalizeMetricValue(
            "waterLevelM",
            requireNumberString(row.v, `${key}[${index}].v`),
            "meter",
          ),
        },
        productRunAt: null,
        receivedAt,
        sourceId: input.sourceId,
        sourceKind: input.sourceKind,
        validAt,
      }),
    );
  }

  return records;
}

// project NOAA observation quality fields
function observationQuality(
  row: Record<string, unknown>,
): Readonly<Record<string, JsonValue>> {
  const status = requireString(row.q, "observation quality", 16);
  const flags = requireString(row.f, "observation flags", 128).split(",");
  return { flags, status };
}

// validate one bounded request range
function validateRange(
  input: NoaaTideRangeBase,
  maximumRangeMs: number,
): Readonly<{ endExclusive: number; start: number }> {
  requireString(input.sourceId, "sourceId", 128);
  requireStationId(input.stationId);
  validateTimeZone(input.timezone);
  const start = Date.parse(input.start);
  const endExclusive = Date.parse(input.endExclusive);

  // require an increasing minute-aligned provider range
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(endExclusive) ||
    start % 60_000 !== 0 ||
    endExclusive % 60_000 !== 0 ||
    start >= endExclusive ||
    endExclusive - start > maximumRangeMs
  ) {
    throw new RangeError("NOAA tide range is invalid or too large");
  }

  return { endExclusive, start };
}

// format one UTC minute for NOAA
function formatNoaaInstant(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 16).replace("T", " ");
}

// parse one zone-less NOAA GMT minute
function parseNoaaInstant(value: unknown, field: string): string {
  const text = requireString(value, field, 16);

  // require the documented minute format
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u.test(text)) {
    throw invalidPayload(`${field} is not a NOAA GMT minute`);
  }

  const date = new Date(`${text.replace(" ", "T")}:00.000Z`);

  // reject invalid and rolled-over timestamps
  if (Number.isNaN(date.getTime()) || formatNoaaInstant(date.getTime()) !== text) {
    throw invalidPayload(`${field} is invalid`);
  }

  return date.toISOString();
}

// require a NOAA station identifier
function requireStationId(value: string): void {
  // require the documented seven-digit station key
  if (!/^\d{7}$/u.test(value)) {
    throw new RangeError("NOAA stationId must contain seven digits");
  }
}

// require one prediction event type
function requirePredictionType(value: unknown, field: string): "H" | "L" {
  // reject unknown event labels
  if (value !== "H" && value !== "L") {
    throw invalidPayload(`${field} must be H or L`);
  }

  return value;
}

// require one response object
function requireObject(value: unknown, field: string): Record<string, unknown> {
  // reject arrays and nulls
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidPayload(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one response array
function requireArray(value: unknown, field: string): readonly unknown[] {
  // reject non-array payloads
  if (!Array.isArray(value)) {
    throw invalidPayload(`${field} must be an array`);
  }

  return value;
}

// require one bounded string
function requireString(value: unknown, field: string, maximum: number): string {
  // reject empty and oversized text
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw invalidPayload(`${field} must be a bounded string`);
  }

  return value;
}

// parse one numeric provider string
function requireNumberString(value: unknown, field: string): number {
  const number = typeof value === "string" ? Number(value) : Number.NaN;

  // reject non-numeric NOAA values
  if (!Number.isFinite(number)) {
    throw invalidPayload(`${field} must be numeric`);
  }

  return number;
}

// create an all-null canonical metric set
function emptyMetrics(): CanonicalWeatherMetrics {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: null,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: null,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps: null,
    windSpeedMps: null,
  };
}

// classify provider schema failures
function invalidPayload(message: string): ProviderFailure {
  return new ProviderFailure({
    classification: "invalid_payload",
    code: "noaa_invalid_payload",
    message,
  });
}

// provide a testable clock default
function defaultNow(): Date {
  return new Date();
}
