import {
  createNormalizedWeatherRecord,
  normalizeMetricValue,
  validateCoordinates,
  validateTimeZone,
  type CanonicalWeatherMetrics,
  type JsonValue,
  type NormalizedWeatherRecord,
  type SourceKind,
} from "@weather/domain";

import {
  ProviderFailure,
  type CurrentProviderOperation,
  type HistoricalProviderOperation,
  type ProviderAttribution,
  type ProviderBatch,
  type ProviderFetchOptions,
  type ProviderRequestPlan,
} from "./contract.js";
import { fetchJsonWithRetry } from "./http.js";

export const OPEN_METEO_ATTRIBUTION: ProviderAttribution = {
  label: "Weather data by Open-Meteo",
  url: "https://open-meteo.com/",
};
export const OPEN_METEO_CURRENT_ADAPTER_VERSION =
  "open-meteo-forecast-current/v1";
export const OPEN_METEO_ARCHIVE_ADAPTER_VERSION =
  "open-meteo-archive-hourly/v1";
export const OPEN_METEO_ARCHIVE_CHUNK_PLAN_VERSION =
  "open-meteo-archive-hourly/v1";
export const OPEN_METEO_COMPATIBILITY_ORIGIN_ENV =
  "WEATHER_OPEN_METEO_COMPATIBILITY_ORIGIN";

const CURRENT_ENDPOINT = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_ENDPOINT = "https://archive-api.open-meteo.com/v1/archive";
const CURRENT_PATH = "/v1/forecast";
const ARCHIVE_PATH = "/v1/archive";
const CURRENT_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "cloud_cover",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "surface_pressure",
] as const;
const HOURLY_VARIABLES = CURRENT_VARIABLES;

export interface OpenMeteoLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly sourceId: string;
  readonly timezone: string;
}

export interface OpenMeteoArchiveRequest extends OpenMeteoLocation {
  readonly endDate: string;
  readonly startDate: string;
}

export type OpenMeteoCurrentOperation =
  CurrentProviderOperation<OpenMeteoLocation>;
export type OpenMeteoHistoricalOperation =
  HistoricalProviderOperation<OpenMeteoArchiveRequest>;

// expose the implemented capability set
export function openMeteoCapabilities(): readonly ["current", "historical"] {
  return ["current", "historical"];
}

// build the modern current request
export function buildOpenMeteoCurrentRequest(
  input: OpenMeteoLocation,
): ProviderRequestPlan {
  return buildCurrentRequest(input, CURRENT_ENDPOINT);
}

// build one current endpoint request
function buildCurrentRequest(
  input: OpenMeteoLocation,
  endpoint: string,
): ProviderRequestPlan {
  const location = validateLocation(input);
  const url = new URL(endpoint);
  appendCommonParameters(url, location, "current", CURRENT_VARIABLES);

  return {
    adapterVersion: OPEN_METEO_CURRENT_ADAPTER_VERSION,
    capability: "current",
    sourceKind: "model_current",
    url,
  };
}

// build the archive hourly request
export function buildOpenMeteoArchiveRequest(
  input: OpenMeteoArchiveRequest,
): ProviderRequestPlan {
  return buildArchiveRequest(input, ARCHIVE_ENDPOINT);
}

// build one historical endpoint request
function buildArchiveRequest(
  input: OpenMeteoArchiveRequest,
  endpoint: string,
): ProviderRequestPlan {
  const location = validateLocation(input);
  validateDate(input.startDate, "startDate");
  validateDate(input.endDate, "endDate");

  // require an ordered inclusive range
  if (input.startDate > input.endDate) {
    throw new RangeError("archive startDate must not follow endDate");
  }

  const url = new URL(endpoint);
  appendCommonParameters(url, location, "hourly", HOURLY_VARIABLES);
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", input.startDate);
  url.searchParams.set("end_date", addCalendarDays(input.endDate, 1));

  return {
    adapterVersion: OPEN_METEO_ARCHIVE_ADAPTER_VERSION,
    capability: "historical",
    sourceKind: "reanalysis",
    url,
  };
}

// fetch and normalize one current record
export async function fetchOpenMeteoCurrent(
  input: OpenMeteoLocation,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  return fetchCurrent(input, options, CURRENT_ENDPOINT);
}

// execute one current endpoint
async function fetchCurrent(
  input: OpenMeteoLocation,
  options: ProviderFetchOptions,
  endpoint: string,
): Promise<ProviderBatch> {
  const plan = buildCurrentRequest(input, endpoint);
  const response = await fetchJsonWithRetry(plan.url, options);
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const record = normalizeCurrentPayload(
    response.payload,
    input.sourceId,
    receivedAt,
  );

  return {
    attempts: response.attempts,
    checksum: response.checksum,
    providerCursor: { valid_at: record.validAt },
    records: [record],
    responseMetadata: responseMetadata(response.payload, response.status),
  };
}

// fetch and normalize archive records
export async function fetchOpenMeteoArchive(
  input: OpenMeteoArchiveRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  return fetchHistorical(input, options, ARCHIVE_ENDPOINT);
}

// execute one historical endpoint
async function fetchHistorical(
  input: OpenMeteoArchiveRequest,
  options: ProviderFetchOptions,
  endpoint: string,
): Promise<ProviderBatch> {
  const plan = buildArchiveRequest(input, endpoint);
  const response = await fetchJsonWithRetry(plan.url, options);
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizeArchivePayload(
    response.payload,
    input.sourceId,
    receivedAt,
  );
  const requestedRecords = filterArchiveWindow(records, input);

  return {
    attempts: response.attempts,
    checksum: response.checksum,
    providerCursor: null,
    records: requestedRecords,
    responseMetadata: responseMetadata(response.payload, response.status),
  };
}

// retain the exact local-calendar archive window
function filterArchiveWindow(
  records: readonly NormalizedWeatherRecord[],
  input: OpenMeteoArchiveRequest,
): readonly NormalizedWeatherRecord[] {
  const intervalStart = providerTimeToUtc(
    `${input.startDate}T00:00`,
    input.timezone,
    0,
  );
  const intervalEnd = providerTimeToUtc(
    `${addCalendarDays(input.endDate, 1)}T00:00`,
    input.timezone,
    0,
  );
  const requestedRecords = records.filter(
    (record) => record.validAt >= intervalStart && record.validAt < intervalEnd,
  );

  // reject provider responses outside the requested window
  if (requestedRecords.length === 0) {
    throw invalidPayload("archive payload contained no requested records");
  }

  return requestedRecords;
}

// create an injected current operation
export function createOpenMeteoCurrentOperation(
  compatibilityOrigin?: string | null,
): OpenMeteoCurrentOperation {
  const origin = parseOpenMeteoCompatibilityOrigin(compatibilityOrigin);
  const endpoint = origin === null
    ? CURRENT_ENDPOINT
    : new URL(CURRENT_PATH, `${origin}/`).toString();

  return async (input, options = {}) => fetchCurrent(input, options, endpoint);
}

// create an injected historical operation
export function createOpenMeteoHistoricalOperation(
  compatibilityOrigin?: string | null,
): OpenMeteoHistoricalOperation {
  const origin = parseOpenMeteoCompatibilityOrigin(compatibilityOrigin);
  const endpoint = origin === null
    ? ARCHIVE_ENDPOINT
    : new URL(ARCHIVE_PATH, `${origin}/`).toString();

  return async (input, options = {}) => fetchHistorical(input, options, endpoint);
}

// validate an explicit compatibility origin
export function parseOpenMeteoCompatibilityOrigin(
  value?: string | null,
): string | null {
  // preserve official endpoints by default
  if (value === undefined || value === null) {
    return null;
  }

  try {
    const parsed = new URL(value);

    // require a credential-free origin only
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.pathname !== "/" ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new TypeError("invalid compatibility origin");
    }

    return parsed.origin;
  } catch (error) {
    throw new TypeError(
      `${OPEN_METEO_COMPATIBILITY_ORIGIN_ENV} must be a credential-free HTTP origin`,
      { cause: error },
    );
  }
}

// normalize the current response shape
export function normalizeCurrentPayload(
  payload: unknown,
  sourceId: string,
  receivedAt: string,
): NormalizedWeatherRecord {
  const root = requireObject(payload, "Open-Meteo response");
  const current = requireObject(root.current, "current");
  const units = requireObject(root.current_units, "current_units");
  const envelope = parseEnvelope(root);
  const validAt = providerTimeToUtc(
    requireString(current.time, "current.time"),
    envelope.timezone,
    envelope.utcOffsetSeconds,
    { preferProviderOffset: true },
  );

  return createNormalizedWeatherRecord({
    metadata: createMetadata(envelope, "forecast", "best_match"),
    metrics: normalizeMetrics(current, units),
    productRunAt: null,
    receivedAt,
    sourceId,
    sourceKind: "model_current",
    validAt,
  });
}

// normalize the archive hourly response shape
export function normalizeArchivePayload(
  payload: unknown,
  sourceId: string,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const root = requireObject(payload, "Open-Meteo response");
  const hourly = requireObject(root.hourly, "hourly");
  const units = requireObject(root.hourly_units, "hourly_units");
  const envelope = parseEnvelope(root);
  const times = requireArray(hourly.time, "hourly.time");

  // reject successful empty payloads
  if (times.length === 0) {
    throw invalidPayload("hourly.time must not be empty");
  }

  const metricArrays = archiveMetricArrays(hourly, times.length);
  const records: NormalizedWeatherRecord[] = [];
  let previousValidAt: string | null = null;

  // retain the provider timestamp order
  for (let index = 0; index < times.length; index += 1) {
    const localTime = requireString(times[index], `hourly.time[${index}]`);
    const validAt = providerTimeToUtc(
      localTime,
      envelope.timezone,
      envelope.utcOffsetSeconds,
      { previousValidAt },
    );
    const values = Object.fromEntries(
      Object.entries(metricArrays).map(([key, value]) => [key, value[index]]),
    );
    records.push(
      createNormalizedWeatherRecord({
        metadata: createMetadata(envelope, "archive", "reanalysis"),
        metrics: normalizeMetrics(values, units),
        productRunAt: null,
        receivedAt,
        sourceId,
        sourceKind: "reanalysis",
        validAt,
      }),
    );
    previousValidAt = validAt;
  }

  return records;
}

// append the provider-neutral request controls
function appendCommonParameters(
  url: URL,
  location: OpenMeteoLocation,
  collection: "current" | "hourly",
  variables: readonly string[],
): void {
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set(collection, variables.join(","));
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timezone", location.timezone);
}

// validate adapter coordinates and timezone
function validateLocation(input: OpenMeteoLocation): OpenMeteoLocation {
  const coordinates = validateCoordinates(input.latitude, input.longitude);

  // require a stable source identity
  if (input.sourceId.trim().length === 0 || input.sourceId.length > 128) {
    throw new RangeError("sourceId must be non-empty and bounded");
  }

  return {
    ...coordinates,
    sourceId: input.sourceId,
    timezone: validateTimeZone(input.timezone),
  };
}

// parse provider envelope metadata
function parseEnvelope(root: Record<string, unknown>): Readonly<{
  elevation: number | null;
  latitude: number;
  longitude: number;
  timezone: string;
  utcOffsetSeconds: number;
}> {
  const latitude = requireNumber(root.latitude, "latitude");
  const longitude = requireNumber(root.longitude, "longitude");
  validateCoordinates(latitude, longitude);
  const timezone = validateTimeZone(requireString(root.timezone, "timezone"));
  const utcOffsetSeconds = requireNumber(
    root.utc_offset_seconds,
    "utc_offset_seconds",
  );

  // require a realistic offset
  if (!Number.isSafeInteger(utcOffsetSeconds) || Math.abs(utcOffsetSeconds) > 50_400) {
    throw invalidPayload("utc_offset_seconds is invalid");
  }

  return {
    elevation:
      root.elevation === undefined || root.elevation === null
        ? null
        : requireNumber(root.elevation, "elevation"),
    latitude,
    longitude,
    timezone,
    utcOffsetSeconds,
  };
}

// normalize one provider metric object
function normalizeMetrics(
  values: Record<string, unknown>,
  units: Record<string, unknown>,
): CanonicalWeatherMetrics {
  return {
    apparentTemperatureC: normalizeMetricValue(
      "apparentTemperatureC",
      requireNullableNumber(values.apparent_temperature, "apparent_temperature"),
      requireUnit(units.apparent_temperature, "°C", "apparent_temperature", "c"),
    ),
    blackGlobeTemperatureC: null,
    cloudCoverPercent: normalizeMetricValue(
      "cloudCoverPercent",
      requireNullableNumber(values.cloud_cover, "cloud_cover"),
      requireUnit(units.cloud_cover, "%", "cloud_cover", "percent"),
    ),
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: normalizeMetricValue(
      "precipitationMm",
      requireNullableNumber(values.precipitation, "precipitation"),
      requireUnit(units.precipitation, "mm", "precipitation", "millimeter"),
    ),
    precipitationRateMmPerHour: null,
    pressureHpa: normalizeMetricValue(
      "pressureHpa",
      requireNullableNumber(values.surface_pressure, "surface_pressure"),
      requireUnit(units.surface_pressure, "hPa", "surface_pressure", "hectopascal"),
    ),
    relativeHumidityPercent: normalizeMetricValue(
      "relativeHumidityPercent",
      requireNullableNumber(values.relative_humidity_2m, "relative_humidity_2m"),
      requireUnit(units.relative_humidity_2m, "%", "relative_humidity_2m", "percent"),
    ),
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: normalizeMetricValue(
      "temperatureC",
      requireNullableNumber(values.temperature_2m, "temperature_2m"),
      requireUnit(units.temperature_2m, "°C", "temperature_2m", "c"),
    ),
    uvIndex: null,
    windDirectionDegrees: normalizeOpenMeteoWindDirection(
      values.wind_direction_10m,
      units.wind_direction_10m,
    ),
    windGustMps: normalizeMetricValue(
      "windGustMps",
      requireNullableNumber(values.wind_gusts_10m, "wind_gusts_10m"),
      requireUnit(units.wind_gusts_10m, "m/s", "wind_gusts_10m", "meter_per_second"),
    ),
    windSpeedMps: normalizeMetricValue(
      "windSpeedMps",
      requireNullableNumber(values.wind_speed_10m, "wind_speed_10m"),
      requireUnit(units.wind_speed_10m, "m/s", "wind_speed_10m", "meter_per_second"),
    ),
    wetBulbGlobeTemperatureC: null,
  };
}

// collapse the circular north duplicate
function normalizeOpenMeteoWindDirection(
  value: unknown,
  unit: unknown,
): number | null {
  const direction = requireNullableNumber(value, "wind_direction_10m");
  const canonicalDirection = direction === 360 ? 0 : direction;

  return normalizeMetricValue(
    "windDirectionDegrees",
    canonicalDirection,
    requireUnit(unit, "°", "wind_direction_10m", "degree"),
  );
}

// validate all parallel archive arrays
function archiveMetricArrays(
  hourly: Record<string, unknown>,
  expectedLength: number,
): Readonly<Record<string, readonly unknown[]>> {
  const arrays: Record<string, readonly unknown[]> = {};

  // collect every required variable
  for (const variable of HOURLY_VARIABLES) {
    const value = requireArray(hourly[variable], `hourly.${variable}`);

    // reject positional misalignment
    if (value.length !== expectedLength) {
      throw invalidPayload(`hourly.${variable} length does not match hourly.time`);
    }

    arrays[variable] = value;
  }

  return arrays;
}

// create allowlisted record metadata
function createMetadata(
  envelope: ReturnType<typeof parseEnvelope>,
  dataset: string,
  model: string,
): NormalizedWeatherRecord["metadata"] {
  return {
    device: null,
    model,
    provider: {
      dataset,
      ...(envelope.elevation === null ? {} : { elevation_m: envelope.elevation }),
      grid_cell: `${envelope.latitude},${envelope.longitude}`,
    },
    quality: null,
    upstreamTimezone: envelope.timezone,
  };
}

// expose bounded response metadata
function responseMetadata(
  payload: unknown,
  status: number,
): Readonly<Record<string, JsonValue>> {
  const root = requireObject(payload, "Open-Meteo response");
  const generation = root.generationtime_ms;

  return {
    http_status: status,
    ...(typeof generation === "number" && Number.isFinite(generation)
      ? { generation_ms: generation }
      : {}),
  };
}

// convert provider wall time to a UTC instant
function providerTimeToUtc(
  value: string,
  timezone: string,
  fallbackOffsetSeconds: number,
  selection: Readonly<{
    preferProviderOffset?: boolean;
    previousValidAt?: string | null;
  }> = {},
): string {
  // accept explicit instants directly
  if (/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    const parsed = new Date(value);

    // reject invalid explicit instants
    if (Number.isNaN(parsed.getTime())) {
      throw invalidPayload("provider time is invalid");
    }

    return parsed.toISOString();
  }

  const parts = parseLocalDateTime(value);
  const naiveUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  const formatter = localTimeFormatter(timezone);
  const offsets = new Set<number>([
    Math.round(fallbackOffsetSeconds / 60),
    ...Array.from({ length: 113 }, (_unused, index) => -840 + index * 15),
  ]);
  const candidates: number[] = [];

  // search modern quarter-hour timezone offsets
  for (const offsetMinutes of offsets) {
    const candidate = naiveUtc - offsetMinutes * 60_000;

    // retain exact local wall-time matches
    if (formatLocalParts(candidate, formatter) === value) {
      candidates.push(candidate);
    }
  }

  // order exact timezone candidates
  const orderedCandidates = [...new Set(candidates)].sort(
    (left, right) => left - right,
  );

  // require current times to agree with the provider offset
  if (selection.preferProviderOffset === true) {
    const preferred = naiveUtc - fallbackOffsetSeconds * 1_000;

    // reject contradictory timezone metadata
    if (!orderedCandidates.includes(preferred)) {
      throw invalidPayload("provider time does not match its UTC offset");
    }

    return new Date(preferred).toISOString();
  }

  const previous =
    selection.previousValidAt === undefined || selection.previousValidAt === null
      ? null
      : Date.parse(selection.previousValidAt);

  // select the next archive instant
  const selected = orderedCandidates.find(
    (candidate) => previous === null || candidate > previous,
  );

  // reject missing, duplicate, or non-monotonic local time
  if (selected === undefined) {
    throw invalidPayload("provider time does not map monotonically in its timezone");
  }

  return new Date(selected).toISOString();
}

// parse minute-resolution provider wall time
function parseLocalDateTime(value: string): Readonly<{
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  year: number;
}> {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/u.exec(value);

  // require the documented timestamp shape
  if (match === null) {
    throw invalidPayload("provider time must use local ISO minute precision");
  }

  const parsed = {
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    month: Number(match[2]),
    second: Number(match[6] ?? 0),
    year: Number(match[1]),
  };
  const validation = new Date(
    Date.UTC(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      parsed.hour,
      parsed.minute,
      parsed.second,
    ),
  );

  // reject rollover timestamps
  if (
    validation.getUTCFullYear() !== parsed.year ||
    validation.getUTCMonth() + 1 !== parsed.month ||
    validation.getUTCDate() !== parsed.day ||
    validation.getUTCHours() !== parsed.hour ||
    validation.getUTCMinutes() !== parsed.minute ||
    validation.getUTCSeconds() !== parsed.second
  ) {
    throw invalidPayload("provider time is invalid");
  }

  return parsed;
}

// create a reusable local-time formatter
function localTimeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });
}

// format an instant as provider local wall time
function formatLocalParts(
  epochMilliseconds: number,
  formatter: Intl.DateTimeFormat,
): string {
  const parts = formatter.formatToParts(epochMilliseconds);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const seconds = values.second === "00" ? "" : `:${values.second}`;
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}${seconds}`;
}

// validate response objects
function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  // reject arrays and nulls
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPayload(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

// validate response arrays
function requireArray(value: unknown, fieldName: string): readonly unknown[] {
  // reject missing arrays
  if (!Array.isArray(value)) {
    throw invalidPayload(`${fieldName} must be an array`);
  }

  return value;
}

// validate response strings
function requireString(value: unknown, fieldName: string): string {
  // reject empty strings
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidPayload(`${fieldName} must be a non-empty string`);
  }

  return value;
}

// validate response numbers
function requireNumber(value: unknown, fieldName: string): number {
  // reject non-finite values
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidPayload(`${fieldName} must be a finite number`);
  }

  return value;
}

// validate nullable metrics
function requireNullableNumber(value: unknown, fieldName: string): number | null {
  // preserve documented null metrics
  if (value === null) {
    return null;
  }

  return requireNumber(value, fieldName);
}

// validate provider units exactly
function requireUnit<T extends string>(
  value: unknown,
  expected: string,
  fieldName: string,
  normalized: T,
): T {
  // reject silent unit drift
  if (value !== expected) {
    throw invalidPayload(`${fieldName} unit must be ${expected}`);
  }

  return normalized;
}

// validate calendar date strings
function validateDate(value: string, fieldName: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  // reject rollover dates
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${fieldName} must use a valid YYYY-MM-DD date`);
  }

  return value;
}

// add one UTC calendar-day offset
function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// create a non-retryable payload failure
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

// preserve the declared source kind constraint
export function openMeteoSourceKind(
  capability: "current" | "historical",
): SourceKind {
  return capability === "current" ? "model_current" : "reanalysis";
}
