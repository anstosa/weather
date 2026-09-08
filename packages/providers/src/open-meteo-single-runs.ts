import { validateCoordinates, validateUtcInstant } from "@weather/domain";

import {
  ProviderFailure,
  type ProviderFetchOptions,
  type ProviderRequestPlan,
} from "./contract.js";
import { fetchJsonWithRetry } from "./http.js";
import { parseOpenMeteoCompatibilityOrigin } from "./open-meteo.js";

// freeze the private canary adapter identity
export const OPEN_METEO_ECMWF_SINGLE_RUN_ADAPTER_VERSION =
  "open-meteo-ecmwf-single-run/v1";
export const OPEN_METEO_ECMWF_SINGLE_RUN_MODEL = "ecmwf_ifs";

const SINGLE_RUNS_ENDPOINT =
  "https://single-runs-api.open-meteo.com/v1/forecast";
const SINGLE_RUNS_PATH = "/v1/forecast";
const FORECAST_HOURS = 19;
const HOUR_MILLISECONDS = 3_600_000;
const MODEL_50R1_CUTOFF = Date.parse("2026-05-12T06:00:00.000Z");
const HOURLY_VARIABLES = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
] as const;

// identify one exact model initialization
export interface OpenMeteoEcmwfSingleRunRequest {
  readonly latitude: number;
  readonly longitude: number;
  readonly runInitializedAt: string;
}

// retain only model inputs needed by the canary
export interface OpenMeteoEcmwfSingleRunHour {
  readonly modelLeadHours: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawTemperatureC: number;
  readonly rawWindSpeedMps: number | null;
  readonly validAt: string;
}

// retain one bounded provider response
export interface OpenMeteoEcmwfSingleRunBatch {
  readonly adapterVersion: typeof OPEN_METEO_ECMWF_SINGLE_RUN_ADAPTER_VERSION;
  readonly attempts: number;
  readonly hours: readonly OpenMeteoEcmwfSingleRunHour[];
  readonly modelCycle: "49r1" | "50r1";
  readonly providerResponseSha256: string;
  readonly receivedAt: string;
  readonly runInitializedAt: string;
  readonly upstreamModel: typeof OPEN_METEO_ECMWF_SINGLE_RUN_MODEL;
}

// type one injected single-runs operation
export type OpenMeteoEcmwfSingleRunOperation = (
  input: OpenMeteoEcmwfSingleRunRequest,
  options?: ProviderFetchOptions,
) => Promise<OpenMeteoEcmwfSingleRunBatch>;

// build one exact ECMWF run request
export function buildOpenMeteoEcmwfSingleRunRequest(
  input: OpenMeteoEcmwfSingleRunRequest,
): ProviderRequestPlan {
  return buildSingleRunRequest(input, SINGLE_RUNS_ENDPOINT);
}

// fetch one exact ECMWF run
export async function fetchOpenMeteoEcmwfSingleRun(
  input: OpenMeteoEcmwfSingleRunRequest,
  options: ProviderFetchOptions = {},
): Promise<OpenMeteoEcmwfSingleRunBatch> {
  return fetchSingleRun(input, options, SINGLE_RUNS_ENDPOINT);
}

// create one compatibility-aware operation
export function createOpenMeteoEcmwfSingleRunOperation(
  compatibilityOrigin?: string | null,
): OpenMeteoEcmwfSingleRunOperation {
  const origin = parseOpenMeteoCompatibilityOrigin(compatibilityOrigin);
  const endpoint = origin === null
    ? SINGLE_RUNS_ENDPOINT
    : new URL(SINGLE_RUNS_PATH, `${origin}/`).toString();

  return async (input, options = {}) => fetchSingleRun(input, options, endpoint);
}

// normalize one response for deterministic tests
export function normalizeOpenMeteoEcmwfSingleRunPayload(
  payload: unknown,
  input: OpenMeteoEcmwfSingleRunRequest,
): readonly OpenMeteoEcmwfSingleRunHour[] {
  return normalizeSingleRunPayload(payload, validateRequest(input));
}

// execute one bounded provider request
async function fetchSingleRun(
  input: OpenMeteoEcmwfSingleRunRequest,
  options: ProviderFetchOptions,
  endpoint: string,
): Promise<OpenMeteoEcmwfSingleRunBatch> {
  const request = validateRequest(input);
  const plan = buildSingleRunRequest(request, endpoint);
  const response = await fetchJsonWithRetry(plan.url, options);
  const receivedAt = (options.now ?? defaultNow)().toISOString();

  return {
    adapterVersion: OPEN_METEO_ECMWF_SINGLE_RUN_ADAPTER_VERSION,
    attempts: response.attempts,
    hours: normalizeSingleRunPayload(response.payload, request),
    modelCycle: modelCycleFor(request.runInitializedAt),
    providerResponseSha256: response.checksum,
    receivedAt,
    runInitializedAt: request.runInitializedAt,
    upstreamModel: OPEN_METEO_ECMWF_SINGLE_RUN_MODEL,
  };
}

// build an official or injected URL
function buildSingleRunRequest(
  input: OpenMeteoEcmwfSingleRunRequest,
  endpoint: string,
): ProviderRequestPlan {
  const request = validateRequest(input);
  const url = new URL(endpoint);
  url.searchParams.set("latitude", String(request.latitude));
  url.searchParams.set("longitude", String(request.longitude));
  url.searchParams.set("hourly", HOURLY_VARIABLES.join(","));
  url.searchParams.set("models", OPEN_METEO_ECMWF_SINGLE_RUN_MODEL);
  url.searchParams.set("run", request.runInitializedAt.slice(0, 16));
  url.searchParams.set("forecast_hours", String(FORECAST_HOURS));
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("timezone", "UTC");

  return {
    adapterVersion: OPEN_METEO_ECMWF_SINGLE_RUN_ADAPTER_VERSION,
    capability: "forecast",
    sourceKind: "forecast",
    url,
  };
}

// validate one exact ECMWF initialization
function validateRequest(
  input: OpenMeteoEcmwfSingleRunRequest,
): OpenMeteoEcmwfSingleRunRequest {
  const coordinates = validateCoordinates(input.latitude, input.longitude);
  const runInitializedAt = validateUtcInstant(
    input.runInitializedAt,
    "runInitializedAt",
  );
  const initializedAt = new Date(runInitializedAt);

  // require one canonical six-hour run boundary
  if (
    initializedAt.getUTCMinutes() !== 0 ||
    initializedAt.getUTCSeconds() !== 0 ||
    initializedAt.getUTCMilliseconds() !== 0 ||
    ![0, 6, 12, 18].includes(initializedAt.getUTCHours())
  ) {
    throw new RangeError("ECMWF run initialization must align to 00/06/12/18 UTC");
  }

  return {
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    runInitializedAt,
  };
}

// normalize one exact 19-hour grid
function normalizeSingleRunPayload(
  payload: unknown,
  input: OpenMeteoEcmwfSingleRunRequest,
): readonly OpenMeteoEcmwfSingleRunHour[] {
  const root = requireObject(payload, "single-runs payload");

  // bind naive provider hours to a zero-offset response envelope
  if (
    root.utc_offset_seconds !== 0 ||
    (root.timezone !== "GMT" && root.timezone !== "UTC")
  ) {
    throw invalidPayload("single-runs payload timezone must be UTC or GMT at offset zero");
  }

  const hourlyUnits = requireObject(root.hourly_units, "hourly_units");
  const hourly = requireObject(root.hourly, "hourly");
  requireUnit(hourlyUnits, "time", "iso8601");
  requireUnit(hourlyUnits, "temperature_2m", "°C");
  requireUnit(hourlyUnits, "relative_humidity_2m", "%");
  requireUnit(hourlyUnits, "wind_speed_10m", "m/s");
  const times = requireArray(hourly.time, "hourly.time");
  const temperatures = requireArray(
    hourly.temperature_2m,
    "hourly.temperature_2m",
  );
  const humidities = requireArray(
    hourly.relative_humidity_2m,
    "hourly.relative_humidity_2m",
  );
  const windSpeeds = requireArray(hourly.wind_speed_10m, "hourly.wind_speed_10m");

  // reject partial or unexpectedly extended products
  if (
    times.length !== FORECAST_HOURS ||
    temperatures.length !== FORECAST_HOURS ||
    humidities.length !== FORECAST_HOURS ||
    windSpeeds.length !== FORECAST_HOURS
  ) {
    throw invalidPayload("single-runs payload must contain exactly 19 hourly values");
  }

  const initializedAt = Date.parse(input.runInitializedAt);
  const hours: OpenMeteoEcmwfSingleRunHour[] = [];

  // validate the full grid and retain leads one through eighteen
  for (let modelLeadHours = 0; modelLeadHours < FORECAST_HOURS; modelLeadHours += 1) {
    const validAt = parseProviderUtcHour(times[modelLeadHours], "hourly.time");
    const expectedValidAt = new Date(
      initializedAt + modelLeadHours * HOUR_MILLISECONDS,
    ).toISOString();

    // bind every value to its exact initialization-relative hour
    if (validAt !== expectedValidAt) {
      throw invalidPayload("single-runs payload time grid does not match requested run");
    }

    // exclude the initialization analysis hour from storage
    if (modelLeadHours === 0) {
      continue;
    }

    hours.push({
      modelLeadHours,
      rawRelativeHumidityPercent: optionalMetric(
        humidities[modelLeadHours],
        "relative_humidity_2m",
        0,
        100,
      ),
      rawTemperatureC: requiredMetric(
        temperatures[modelLeadHours],
        "temperature_2m",
        -100,
        70,
      ),
      rawWindSpeedMps: optionalMetric(
        windSpeeds[modelLeadHours],
        "wind_speed_10m",
        0,
        150,
      ),
      validAt,
    });
  }

  return hours;
}

// bind the tested ECMWF cycle boundary
function modelCycleFor(runInitializedAt: string): "49r1" | "50r1" {
  return Date.parse(runInitializedAt) < MODEL_50R1_CUTOFF ? "49r1" : "50r1";
}

// parse one provider UTC hour
function parseProviderUtcHour(value: unknown, field: string): string {
  // require the provider's minute-resolution UTC representation
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:00$/u.test(value)) {
    throw invalidPayload(`${field} must contain UTC hourly timestamps`);
  }

  const instant = `${value}:00.000Z`;

  // reject calendar rollover normalization
  if (Number.isNaN(Date.parse(instant)) || new Date(instant).toISOString() !== instant) {
    throw invalidPayload(`${field} contains an invalid UTC hour`);
  }

  return instant;
}

// require one finite provider metric
function requiredMetric(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = optionalMetric(value, field, minimum, maximum);

  // temperature is required for every canary lead
  if (parsed === null) {
    throw invalidPayload(`${field} must not contain null`);
  }

  return parsed;
}

// validate one nullable provider metric
function optionalMetric(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  // preserve explicit provider missingness
  if (value === null) {
    return null;
  }

  // reject nonfinite or physically impossible values
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidPayload(`${field} contains an invalid value`);
  }

  return value;
}

// require one response object
function requireObject(value: unknown, field: string): Record<string, unknown> {
  // reject arrays and primitives
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPayload(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one response array
function requireArray(value: unknown, field: string): readonly unknown[] {
  // reject missing and non-array values
  if (!Array.isArray(value)) {
    throw invalidPayload(`${field} must be an array`);
  }

  return value;
}

// require one exact provider unit
function requireUnit(
  units: Record<string, unknown>,
  field: string,
  expected: string,
): void {
  // reject silent unit drift
  if (units[field] !== expected) {
    throw invalidPayload(`${field} unit must be ${expected}`);
  }
}

// create one bounded provider failure
function invalidPayload(message: string): ProviderFailure {
  return new ProviderFailure({
    classification: "invalid_payload",
    code: "invalid_payload",
    message,
  });
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}
