import {
  createNormalizedWeatherRecord,
  normalizeMetricValue,
  validateTimeZone,
  type JsonValue,
  type NormalizedWeatherRecord,
} from "@weather/domain";

import {
  ProviderFailure,
  type HistoricalProviderOperation,
  type ProviderAttribution,
  type ProviderBatch,
  type ProviderFetchOptions,
  type ProviderRequestPlan,
} from "./contract.js";
import { fetchJsonWithRetry } from "./http.js";

export const TEMPEST_ATTRIBUTION: ProviderAttribution = {
  label: "Weather data by Tempest",
  url: "https://tempestwx.com/",
};
export const TEMPEST_OBSERVATION_ADAPTER_VERSION =
  "tempest-observations-hourly/v1";
export const TEMPEST_OBSERVATION_CHUNK_PLAN_VERSION =
  "tempest-observations-five-day-hourly/v1";
export const TEMPEST_MAXIMUM_RANGE_SECONDS = 5 * 24 * 60 * 60;

const TEMPEST_API_ORIGIN = "https://swd.weatherflow.com";
const TEMPEST_BUILD = "169";
const TEMPEST_OBSERVATION_LENGTH = 22;

export interface TempestObservationRequest {
  readonly apiKey: string;
  readonly deviceId: number;
  readonly endExclusive: string;
  readonly locationId: number;
  readonly serial: string;
  readonly sourceId: string;
  readonly start: string;
  readonly timezone: string;
}

export interface TempestLocationRequest {
  readonly apiKey: string;
  readonly locationId: number;
}

export interface ResolvedTempestStation {
  readonly deviceId: number;
  readonly displayName: string;
  readonly latitude: number;
  readonly locationId: number;
  readonly longitude: number;
  readonly serial: string;
  readonly timezone: string;
}

export type TempestObservationOperation =
  HistoricalProviderOperation<Omit<TempestObservationRequest, "apiKey">>;

// build one bounded Tempest observation request
export function buildTempestObservationRequest(
  input: TempestObservationRequest,
): ProviderRequestPlan {
  const window = validateObservationRequest(input);
  const url = new URL(
    `/swd/rest/observations/device/${String(input.deviceId)}`,
    TEMPEST_API_ORIGIN,
  );
  url.searchParams.set("api_key", validateApiKey(input.apiKey));
  url.searchParams.set("build", TEMPEST_BUILD);
  url.searchParams.set("time_start", String(window.startEpochSeconds));
  url.searchParams.set("time_end", String(window.endEpochSecondsInclusive));

  return {
    adapterVersion: TEMPEST_OBSERVATION_ADAPTER_VERSION,
    capability: "historical",
    sourceKind: "physical_sensor",
    url,
  };
}

// create one credential-bound Tempest operation
export function createTempestObservationOperation(
  apiKey: string,
): TempestObservationOperation {
  const credential = validateApiKey(apiKey);

  // inject the credential without retaining it in station configuration
  return async (input, options = {}) =>
    await fetchTempestObservations({ ...input, apiKey: credential }, options);
}

// fetch and normalize one Tempest observation range
export async function fetchTempestObservations(
  input: TempestObservationRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  const plan = buildTempestObservationRequest(input);
  const response = await fetchJsonWithRetry(plan.url, withTempestHeaders({
    maxBodyBytes: 10_000_000,
    ...options,
  }));
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizeTempestObservationPayload(
    response.payload,
    input,
    receivedAt,
  );
  const lastRecord = records.at(-1);

  return {
    attempts: response.attempts,
    checksum: response.checksum,
    providerCursor:
      lastRecord === undefined
        ? null
        : { valid_at: lastRecord.validAt },
    records,
    responseMetadata: tempestResponseMetadata(response.payload, records.length),
  };
}

// resolve the ST device for one public station location
export async function resolveTempestStation(
  input: TempestLocationRequest,
  options: ProviderFetchOptions = {},
): Promise<ResolvedTempestStation> {
  const locationId = requirePositiveInteger(input.locationId, "locationId");
  const url = new URL(
    `/swd/rest/locations/${String(locationId)}`,
    TEMPEST_API_ORIGIN,
  );
  url.searchParams.set("api_key", validateApiKey(input.apiKey));
  url.searchParams.set("build", TEMPEST_BUILD);
  url.searchParams.set("include_arbitrary_locations", "true");
  const response = await fetchJsonWithRetry(url, withTempestHeaders(options));
  const root = requireObject(response.payload, "Tempest location response");
  requireSuccessfulStatus(root.status);
  const locations = requireArray(root.locations, "locations");
  const location = locations
    .map((value, index) => requireObject(value, `locations[${index}]`))
    .find((candidate) => candidate.location_id === locationId);

  // require the exact requested location
  if (location === undefined) {
    throw invalidPayload("Tempest location response omitted the requested location");
  }

  const devices = requireArray(location.devices, "location.devices").map(
    (value, index) => requireObject(value, `location.devices[${index}]`),
  );
  const tempestDevices = devices.filter((device) => device.device_type === "ST");

  // require one unambiguous weather device
  if (tempestDevices.length !== 1 || tempestDevices[0] === undefined) {
    throw invalidPayload("Tempest location must contain exactly one ST device");
  }

  const device = tempestDevices[0];
  return {
    deviceId: requirePositiveInteger(device.device_id, "device.device_id"),
    displayName: requireString(location.name, "location.name", 160),
    latitude: requireBoundedNumber(location.latitude, "location.latitude", -90, 90),
    locationId,
    longitude: requireBoundedNumber(
      location.longitude,
      "location.longitude",
      -180,
      180,
    ),
    serial: requireString(device.serial_number, "device.serial_number", 128),
    timezone: validateTimeZone(
      requireString(location.timezone, "location.timezone", 64),
    ),
  };
}

// normalize and hourly-sample one obs_st payload
export function normalizeTempestObservationPayload(
  payload: unknown,
  input: Omit<TempestObservationRequest, "apiKey">,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const root = requireObject(payload, "Tempest observation response");
  requireSuccessfulStatus(root.status);

  // require the requested Tempest device response
  if (root.type !== "obs_st" || root.device_id !== input.deviceId) {
    throw invalidPayload("Tempest response device identity or type is invalid");
  }

  const window = validateObservationRequest({ ...input, apiKey: "validation-only" });
  const observations = tempestObservations(root);
  const hourly = new Map<number, readonly unknown[]>();

  // retain the first actual observation in each UTC hour
  for (const [index, value] of observations.entries()) {
    const observation = requireArray(value, `obs[${index}]`);

    // require the documented obs_st layout
    if (observation.length < TEMPEST_OBSERVATION_LENGTH) {
      throw invalidPayload(`obs[${index}] is shorter than the obs_st contract`);
    }

    const epochSeconds = requirePositiveInteger(observation[0], `obs[${index}][0]`);

    // exclude the API's inclusive end and out-of-window values
    if (
      epochSeconds < window.startEpochSeconds ||
      epochSeconds > window.endEpochSecondsInclusive
    ) {
      continue;
    }

    const hour = Math.floor(epochSeconds / 3600);

    // preserve the earliest report within the hour
    if (!hourly.has(hour)) {
      hourly.set(hour, observation);
    }
  }

  const records = [...hourly.values()].map((observation) =>
    normalizeTempestObservation(observation, input, receivedAt),
  );

  return records;
}

// normalize one documented obs_st row
function normalizeTempestObservation(
  observation: readonly unknown[],
  input: Omit<TempestObservationRequest, "apiKey">,
  receivedAt: string,
): NormalizedWeatherRecord {
  const epochSeconds = requirePositiveInteger(observation[0], "observation epoch");
  const reportIntervalMinutes = requireNullableNumber(
    observation[17],
    "report interval",
  );

  // reject unusable rate denominators
  if (reportIntervalMinutes !== null && reportIntervalMinutes <= 0) {
    throw invalidPayload("report interval must be positive when present");
  }
  const precipitationMm = metric(
    "precipitationMm",
    observation[12],
    "millimeter",
  );
  const precipitationRateMmPerHour =
    precipitationMm === null || reportIntervalMinutes === null
      ? null
      : normalizeMetricValue(
          "precipitationRateMmPerHour",
          precipitationMm * (60 / reportIntervalMinutes),
          "millimeter_per_hour",
        );
  const windDirection = requireNullableNumber(observation[4], "wind direction");

  return createNormalizedWeatherRecord({
    metadata: {
      device: {
        model: "Tempest",
        serial: input.serial,
        vendor: "WeatherFlow",
      },
      model: null,
      provider: {
        battery_volts: jsonNumber(observation[16], "battery"),
        device_id: input.deviceId,
        illuminance_lux: jsonNumber(observation[9], "illuminance"),
        lightning_average_distance_km: jsonNumber(
          observation[14],
          "lightning average distance",
        ),
        lightning_strike_count: jsonNumber(
          observation[15],
          "lightning strike count",
        ),
        location_id: input.locationId,
        precipitation_type: jsonNumber(observation[13], "precipitation type"),
        rain_accumulation_nc_mm: jsonNumber(
          observation[19],
          "NC rain accumulation",
        ),
        report_interval_minutes: reportIntervalMinutes,
        wind_lull_mps: jsonNumber(observation[1], "wind lull"),
        wind_sample_interval_seconds: jsonNumber(
          observation[5],
          "wind sample interval",
        ),
      },
      quality: { sampling: "first_observation_per_utc_hour" },
      upstreamTimezone: input.timezone,
    },
    metrics: {
      apparentTemperatureC: null,
      blackGlobeTemperatureC: null,
      cloudCoverPercent: null,
      pm25MicrogramsPerCubicMeter: null,
      precipitationMm,
      precipitationRateMmPerHour,
      pressureHpa: metric("pressureHpa", observation[6], "hectopascal"),
      relativeHumidityPercent: metric(
        "relativeHumidityPercent",
        observation[8],
        "percent",
      ),
      soilElectricalConductivityMicrosiemensPerCm: null,
      soilMoisturePercent: null,
      solarRadiationWm2: metric(
        "solarRadiationWm2",
        observation[11],
        "watt_per_square_meter",
      ),
      temperatureC: metric("temperatureC", observation[7], "c"),
      uvIndex: metric("uvIndex", observation[10], "index"),
      windDirectionDegrees: normalizeMetricValue(
        "windDirectionDegrees",
        windDirection === 360 ? 0 : windDirection,
        "degree",
      ),
      windGustMps: metric("windGustMps", observation[3], "meter_per_second"),
      windSpeedMps: metric("windSpeedMps", observation[2], "meter_per_second"),
      wetBulbGlobeTemperatureC: null,
    },
    productRunAt: null,
    receivedAt,
    sourceId: input.sourceId,
    sourceKind: "physical_sensor",
    validAt: new Date(epochSeconds * 1000).toISOString(),
  });
}

// normalize one nullable metric
function metric(
  name: Parameters<typeof normalizeMetricValue>[0],
  value: unknown,
  unit: Parameters<typeof normalizeMetricValue>[2],
): number | null {
  return normalizeMetricValue(name, requireNullableNumber(value, name), unit);
}

// validate one observation request window
function validateObservationRequest(
  input: TempestObservationRequest,
): Readonly<{ endEpochSecondsInclusive: number; startEpochSeconds: number }> {
  requirePositiveInteger(input.deviceId, "deviceId");
  requirePositiveInteger(input.locationId, "locationId");
  requireString(input.serial, "serial", 128);
  requireString(input.sourceId, "sourceId", 128);
  validateTimeZone(input.timezone);
  const start = Date.parse(input.start);
  const endExclusive = Date.parse(input.endExclusive);

  // require an exact bounded half-open range
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(endExclusive) ||
    start % 1000 !== 0 ||
    endExclusive % 1000 !== 0 ||
    start >= endExclusive ||
    endExclusive - start > TEMPEST_MAXIMUM_RANGE_SECONDS * 1000
  ) {
    throw new RangeError("Tempest observation range must be positive and at most five days");
  }

  return {
    endEpochSecondsInclusive: endExclusive / 1000 - 1,
    startEpochSeconds: start / 1000,
  };
}

// expose bounded response diagnostics
function tempestResponseMetadata(
  payload: unknown,
  recordCount: number,
): Readonly<Record<string, JsonValue>> {
  const root = requireObject(payload, "Tempest observation response");
  const observations = tempestObservations(root);

  return {
    device_id: requirePositiveInteger(root.device_id, "device_id"),
    hourly_record_count: recordCount,
    raw_observation_count: observations.length,
    ...(typeof root.bucket_step_minutes === "number"
      ? { bucket_step_minutes: root.bucket_step_minutes }
      : {}),
  };
}

// normalize WeatherFlow's null no-data sentinel
function tempestObservations(
  root: Readonly<Record<string, unknown>>,
): readonly unknown[] {
  return root.obs === null ? [] : requireArray(root.obs, "obs");
}

// require provider success metadata
function requireSuccessfulStatus(value: unknown): void {
  const status = requireObject(value, "status");

  // reject provider-level errors hidden behind HTTP success
  if (status.status_code !== 0) {
    throw new ProviderFailure({
      classification: "permanent",
      code: "provider_request_rejected",
      message: "Tempest rejected the request",
    });
  }
}

// validate the API credential without exposing it
function validateApiKey(value: string): string {
  // reject empty multiline or oversized credentials
  if (value.length === 0 || value.length > 256 || /[\r\n\s]/u.test(value)) {
    throw new Error("Tempest API key must be one bounded non-empty value");
  }

  return value;
}

// retain the public web API request identity
function withTempestHeaders(options: ProviderFetchOptions): ProviderFetchOptions {
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    ...options,
    // add the headers required by the public Tempest web endpoint
    fetch: async (input, initialization = {}) => {
      const headers = new Headers(initialization.headers);
      headers.set("origin", "https://tempestwx.com");
      headers.set(
        "user-agent",
        "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      );
      return await fetchImplementation(input, { ...initialization, headers });
    },
  };
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
  // reject absent arrays
  if (!Array.isArray(value)) {
    throw invalidPayload(`${field} must be an array`);
  }

  return value;
}

// require one bounded response string
function requireString(value: unknown, field: string, maximum: number): string {
  // reject empty or oversized strings
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw invalidPayload(`${field} must be a non-empty bounded string`);
  }

  return value;
}

// require one positive response integer
function requirePositiveInteger(value: unknown, field: string): number {
  // reject numeric coercion and invalid identifiers
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw invalidPayload(`${field} must be a positive integer`);
  }

  return value;
}

// require one bounded response number
function requireBoundedNumber(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  // reject non-finite and out-of-range numbers
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw invalidPayload(`${field} is outside its supported range`);
  }

  return value;
}

// require one nullable response number
function requireNullableNumber(value: unknown, field: string): number | null {
  // preserve provider nulls
  if (value === null) {
    return null;
  }

  return requireBoundedNumber(value, field, -1_000_000_000, 1_000_000_000);
}

// retain only JSON-compatible numeric metadata
function jsonNumber(value: unknown, field: string): number | null {
  return requireNullableNumber(value, field);
}

// create one non-retryable payload failure
function invalidPayload(message: string): ProviderFailure {
  return new ProviderFailure({
    classification: "invalid_payload",
    code: "invalid_payload",
    message: message.slice(0, 512),
  });
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}
