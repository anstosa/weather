import {
  canonicalizeJson,
  type JsonValue,
  type SourceKind,
} from "./provenance.js";

export const CANONICAL_UNITS = {
  apparentTemperatureC: "celsius",
  cloudCoverPercent: "percent",
  precipitationMm: "millimeter",
  pressureHpa: "hectopascal",
  relativeHumidityPercent: "percent",
  temperatureC: "celsius",
  windDirectionDegrees: "degree",
  windGustMps: "meter_per_second",
  windSpeedMps: "meter_per_second",
} as const;

export type MetricName = keyof typeof CANONICAL_UNITS;

export interface CanonicalWeatherMetrics {
  readonly apparentTemperatureC: number | null;
  readonly cloudCoverPercent: number | null;
  readonly precipitationMm: number | null;
  readonly pressureHpa: number | null;
  readonly relativeHumidityPercent: number | null;
  readonly temperatureC: number | null;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
}

export interface DeviceMetadata {
  readonly model?: string;
  readonly serial?: string;
  readonly vendor?: string;
}

export interface WeatherRecordMetadata {
  readonly device: DeviceMetadata | null;
  readonly model: string | null;
  readonly provider: Readonly<Record<string, JsonValue>> | null;
  readonly quality: Readonly<Record<string, JsonValue>> | null;
  readonly upstreamTimezone: string;
}

export interface NormalizedWeatherRecord {
  readonly metadata: WeatherRecordMetadata;
  readonly metrics: CanonicalWeatherMetrics;
  readonly productRunAt: string | null;
  readonly receivedAt: string;
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly validAt: string;
}

export interface NormalizedWeatherRecordInput {
  readonly metadata: WeatherRecordMetadata;
  readonly metrics: CanonicalWeatherMetrics;
  readonly productRunAt?: string | null;
  readonly receivedAt: string;
  readonly sourceId: string;
  readonly sourceKind: SourceKind;
  readonly validAt: string;
}

type SupportedUnit =
  | "c"
  | "degree"
  | "f"
  | "hectopascal"
  | "inch"
  | "kilometer_per_hour"
  | "knot"
  | "meter_per_second"
  | "millimeter"
  | "pascal"
  | "percent";

const QUALITY_KEYS = new Set([
  "confidence_percent",
  "flags",
  "interpolation",
  "status",
]);
const PROVIDER_KEYS = new Set([
  "dataset",
  "elevation_m",
  "grid_cell",
  "request_id",
]);

// normalize a provider metric
export function normalizeMetricValue(
  metric: MetricName,
  value: number | null,
  unit: SupportedUnit,
): number | null {
  // preserve missing values
  if (value === null) {
    return null;
  }

  // require finite provider values
  if (!Number.isFinite(value)) {
    throw new RangeError(`${metric} must be finite`);
  }

  const converted = convertMetricValue(metric, value, unit);
  validateMetricValue(metric, converted);
  return converted;
}

// create a validated record
export function createNormalizedWeatherRecord(
  input: NormalizedWeatherRecordInput,
): NormalizedWeatherRecord {
  const validAt = validateUtcInstant(input.validAt, "validAt");
  const receivedAt = validateUtcInstant(input.receivedAt, "receivedAt");
  const productRunAt =
    input.productRunAt === null || input.productRunAt === undefined
      ? null
      : validateUtcInstant(input.productRunAt, "productRunAt");

  // require forecast product identity
  if (input.sourceKind === "forecast" && productRunAt === null) {
    throw new RangeError("forecast records require productRunAt");
  }

  // validate every metric
  for (const [metric, value] of Object.entries(input.metrics)) {
    // preserve null metrics
    if (value !== null) {
      validateMetricValue(metric as MetricName, value);
    }
  }

  const metadata = validateWeatherRecordMetadata(input.metadata);

  // require non-empty source identity
  if (input.sourceId.trim().length === 0 || input.sourceId.length > 128) {
    throw new RangeError("sourceId must be non-empty and bounded");
  }

  return {
    metadata,
    metrics: { ...input.metrics },
    productRunAt,
    receivedAt,
    sourceId: input.sourceId,
    sourceKind: input.sourceKind,
    validAt,
  };
}

// build stable storage identity
export function weatherRecordIdentity(
  record: Pick<
    NormalizedWeatherRecord,
    "productRunAt" | "sourceId" | "sourceKind" | "validAt"
  >,
): string {
  return canonicalizeJson({
    productRunAt: record.productRunAt,
    sourceId: record.sourceId,
    sourceKind: record.sourceKind,
    validAt: record.validAt,
  });
}

// serialize revision-bearing content
export function weatherRecordContent(record: NormalizedWeatherRecord): string {
  return canonicalizeJson({
    metadata: record.metadata,
    metrics: record.metrics,
    productRunAt: record.productRunAt,
    sourceId: record.sourceId,
    sourceKind: record.sourceKind,
    validAt: record.validAt,
  } as unknown as JsonValue);
}

// validate coordinates
export function validateCoordinates(
  latitude: number,
  longitude: number,
): Readonly<{ latitude: number; longitude: number }> {
  // require valid latitude
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new RangeError("latitude must be between -90 and 90");
  }

  // require valid longitude
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError("longitude must be between -180 and 180");
  }

  return { latitude, longitude };
}

// validate UTC instants
export function validateUtcInstant(value: string, fieldName: string): string {
  // require explicit zone information
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new RangeError(`${fieldName} must include an explicit timezone`);
  }

  const parsed = new Date(value);

  // reject invalid timestamps
  if (Number.isNaN(parsed.getTime())) {
    throw new RangeError(`${fieldName} must be a valid instant`);
  }

  return parsed.toISOString();
}

// validate timezone identifiers
export function validateTimeZone(value: string): string {
  // reject oversized identifiers
  if (value.length === 0 || value.length > 64) {
    throw new RangeError("timezone must be non-empty and bounded");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
  } catch {
    throw new RangeError(`unsupported IANA timezone: ${value}`);
  }

  return value;
}

// convert supported units
function convertMetricValue(
  metric: MetricName,
  value: number,
  unit: SupportedUnit,
): number {
  // convert temperatures
  if (metric === "temperatureC" || metric === "apparentTemperatureC") {
    // accept celsius
    if (unit === "c") {
      return value;
    }

    // convert fahrenheit
    if (unit === "f") {
      return (value - 32) * (5 / 9);
    }
  }

  // convert precipitation
  if (metric === "precipitationMm") {
    // accept millimeters
    if (unit === "millimeter") {
      return value;
    }

    // convert inches
    if (unit === "inch") {
      return value * 25.4;
    }
  }

  // convert wind speed
  if (metric === "windSpeedMps" || metric === "windGustMps") {
    // accept meters per second
    if (unit === "meter_per_second") {
      return value;
    }

    // convert kilometers per hour
    if (unit === "kilometer_per_hour") {
      return value / 3.6;
    }

    // convert knots
    if (unit === "knot") {
      return value * 0.514444;
    }
  }

  // convert pressure
  if (metric === "pressureHpa") {
    // accept hectopascals
    if (unit === "hectopascal") {
      return value;
    }

    // convert pascals
    if (unit === "pascal") {
      return value / 100;
    }
  }

  // accept percentages
  if (
    (metric === "relativeHumidityPercent" || metric === "cloudCoverPercent") &&
    unit === "percent"
  ) {
    return value;
  }

  // accept directions
  if (metric === "windDirectionDegrees" && unit === "degree") {
    return value;
  }

  throw new RangeError(`${unit} is not supported for ${metric}`);
}

// enforce metric bounds
function validateMetricValue(metric: MetricName, value: number): void {
  const range = metricRange(metric);

  // reject impossible values
  if (!Number.isFinite(value) || value < range.minimum || value > range.maximum) {
    throw new RangeError(
      `${metric} must be between ${range.minimum} and ${range.maximum}`,
    );
  }

  // reject circular duplicate direction
  if (metric === "windDirectionDegrees" && value === 360) {
    throw new RangeError("windDirectionDegrees must be less than 360");
  }
}

// map metric ranges
function metricRange(
  metric: MetricName,
): Readonly<{ maximum: number; minimum: number }> {
  // map temperature range
  if (metric === "temperatureC" || metric === "apparentTemperatureC") {
    return { maximum: 70, minimum: -100 };
  }

  // map percentage range
  if (metric === "relativeHumidityPercent" || metric === "cloudCoverPercent") {
    return { maximum: 100, minimum: 0 };
  }

  // map precipitation range
  if (metric === "precipitationMm") {
    return { maximum: 2_000, minimum: 0 };
  }

  // map wind range
  if (metric === "windSpeedMps" || metric === "windGustMps") {
    return { maximum: 150, minimum: 0 };
  }

  // map pressure range
  if (metric === "pressureHpa") {
    return { maximum: 1_200, minimum: 100 };
  }

  return { maximum: 360, minimum: 0 };
}

// validate record metadata
function validateWeatherRecordMetadata(
  metadata: WeatherRecordMetadata,
): WeatherRecordMetadata {
  const model = validateOptionalMetadataString(metadata.model, "model");
  const device = validateDeviceMetadata(metadata.device);
  const quality = validateMetadataFragment(
    metadata.quality,
    QUALITY_KEYS,
    "quality",
  );
  const provider = validateMetadataFragment(
    metadata.provider,
    PROVIDER_KEYS,
    "provider",
  );

  return {
    device,
    model,
    provider,
    quality,
    upstreamTimezone: validateTimeZone(metadata.upstreamTimezone),
  };
}

// validate device metadata
function validateDeviceMetadata(
  device: DeviceMetadata | null,
): DeviceMetadata | null {
  // preserve absent devices
  if (device === null) {
    return null;
  }

  const normalized: DeviceMetadata = {
    ...(device.model === undefined
      ? {}
      : { model: validateMetadataString(device.model, "device.model") }),
    ...(device.serial === undefined
      ? {}
      : { serial: validateMetadataString(device.serial, "device.serial") }),
    ...(device.vendor === undefined
      ? {}
      : { vendor: validateMetadataString(device.vendor, "device.vendor") }),
  };

  return normalized;
}

// validate optional metadata
function validateOptionalMetadataString(
  value: string | null,
  fieldName: string,
): string | null {
  // preserve missing metadata
  if (value === null) {
    return null;
  }

  return validateMetadataString(value, fieldName);
}

// validate metadata strings
function validateMetadataString(value: string, fieldName: string): string {
  // enforce bounded non-empty values
  if (value.trim().length === 0 || value.length > 128) {
    throw new RangeError(`${fieldName} must be non-empty and at most 128 chars`);
  }

  return value;
}

// validate allowlisted fragments
function validateMetadataFragment(
  fragment: Readonly<Record<string, JsonValue>> | null,
  allowedKeys: ReadonlySet<string>,
  fieldName: string,
): Readonly<Record<string, JsonValue>> | null {
  // preserve missing fragments
  if (fragment === null) {
    return null;
  }

  // reject unknown fields
  for (const key of Object.keys(fragment)) {
    // enforce allowlist
    if (!allowedKeys.has(key)) {
      throw new RangeError(`${fieldName}.${key} is not allowlisted`);
    }
  }

  const serialized = canonicalizeJson(fragment);

  // enforce bounded storage
  if (serialized.length > 2_048) {
    throw new RangeError(`${fieldName} metadata is too large`);
  }

  return { ...fragment };
}
