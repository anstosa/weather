import {
  canonicalizeJson,
  parseSourceKind,
  type JsonValue,
  type SourceKind,
} from "./provenance.js";

export const CANONICAL_UNITS = {
  apparentTemperatureC: "celsius",
  blackGlobeTemperatureC: "celsius",
  cloudCoverPercent: "percent",
  pm25MicrogramsPerCubicMeter: "microgram_per_cubic_meter",
  precipitationMm: "millimeter",
  precipitationRateMmPerHour: "millimeter_per_hour",
  pressureHpa: "hectopascal",
  relativeHumidityPercent: "percent",
  soilElectricalConductivityMicrosiemensPerCm:
    "microsiemens_per_centimeter",
  soilMoisturePercent: "percent",
  solarRadiationWm2: "watt_per_square_meter",
  temperatureC: "celsius",
  uvIndex: "index",
  waterLevelM: "meter",
  windDirectionDegrees: "degree",
  windGustMps: "meter_per_second",
  windSpeedMps: "meter_per_second",
  wetBulbGlobeTemperatureC: "celsius",
} as const;

export type MetricName = keyof typeof CANONICAL_UNITS;

// describe one canonical metric domain
export interface MetricBounds {
  readonly maximum: number;
  readonly minimum: number;
  readonly maximumExclusive?: boolean;
}

// freeze every canonical metric domain
export const METRIC_BOUNDS: Readonly<Record<MetricName, MetricBounds>> = {
  apparentTemperatureC: { maximum: 70, minimum: -100 },
  blackGlobeTemperatureC: { maximum: 125, minimum: -100 },
  cloudCoverPercent: { maximum: 100, minimum: 0 },
  pm25MicrogramsPerCubicMeter: { maximum: 999, minimum: 0 },
  precipitationMm: { maximum: 2_000, minimum: 0 },
  precipitationRateMmPerHour: { maximum: 10_000, minimum: 0 },
  pressureHpa: { maximum: 1_200, minimum: 100 },
  relativeHumidityPercent: { maximum: 100, minimum: 0 },
  soilElectricalConductivityMicrosiemensPerCm: {
    maximum: 10_000,
    minimum: 0,
  },
  soilMoisturePercent: { maximum: 100, minimum: 0 },
  solarRadiationWm2: { maximum: 2_500, minimum: 0 },
  temperatureC: { maximum: 70, minimum: -100 },
  uvIndex: { maximum: 20, minimum: 0 },
  waterLevelM: { maximum: 30, minimum: -20 },
  windDirectionDegrees: { maximum: 360, maximumExclusive: true, minimum: 0 },
  windGustMps: { maximum: 150, minimum: 0 },
  windSpeedMps: { maximum: 150, minimum: 0 },
  wetBulbGlobeTemperatureC: { maximum: 125, minimum: -100 },
};

export interface CanonicalWeatherMetrics {
  readonly apparentTemperatureC: number | null;
  readonly blackGlobeTemperatureC: number | null;
  readonly cloudCoverPercent: number | null;
  readonly pm25MicrogramsPerCubicMeter: number | null;
  readonly precipitationMm: number | null;
  readonly precipitationRateMmPerHour: number | null;
  readonly pressureHpa: number | null;
  readonly relativeHumidityPercent: number | null;
  readonly soilElectricalConductivityMicrosiemensPerCm: number | null;
  readonly soilMoisturePercent: number | null;
  readonly solarRadiationWm2: number | null;
  readonly temperatureC: number | null;
  readonly uvIndex: number | null;
  readonly waterLevelM: number | null;
  readonly windDirectionDegrees: number | null;
  readonly windGustMps: number | null;
  readonly windSpeedMps: number | null;
  readonly wetBulbGlobeTemperatureC: number | null;
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
  | "inch_of_mercury"
  | "inch_per_hour"
  | "index"
  | "kilometer_per_hour"
  | "knot"
  | "microgram_per_cubic_meter"
  | "microsiemens_per_centimeter"
  | "meter"
  | "meter_per_second"
  | "mile_per_hour"
  | "millimeter"
  | "millimeter_per_hour"
  | "pascal"
  | "percent"
  | "watt_per_square_meter";

const QUALITY_KEYS = new Set([
  "confidence_percent",
  "flags",
  "interpolation",
  "sampling",
  "status",
]);
const PROVIDER_KEYS = new Set([
  "battery_volts",
  "dataset",
  "device_id",
  "elevation_m",
  "grid_cell",
  "illuminance_lux",
  "lightning_average_distance_km",
  "lightning_strike_count",
  "location_id",
  "precipitation_type",
  "rain_accumulation_nc_mm",
  "report_interval_minutes",
  "request_id",
  "station_id",
  "datum",
  "product",
  "prediction_type",
  "property_sensors",
  "wind_lull_mps",
  "wind_sample_interval_seconds",
]);
const METRIC_NAMES = Object.keys(CANONICAL_UNITS) as MetricName[];
const METADATA_KEYS = new Set([
  "device",
  "model",
  "provider",
  "quality",
  "upstreamTimezone",
]);
const DEVICE_KEYS = new Set(["model", "serial", "vendor"]);

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
  const sourceKind = parseSourceKind(input.sourceKind);
  const validAt = validateUtcInstant(input.validAt, "validAt");
  const receivedAt = validateUtcInstant(input.receivedAt, "receivedAt");
  const productRunAt =
    input.productRunAt === null || input.productRunAt === undefined
      ? null
      : validateUtcInstant(input.productRunAt, "productRunAt");

  // require forecast product identity
  if (sourceKind === "forecast" && productRunAt === null) {
    throw new RangeError("forecast records require productRunAt");
  }

  const metrics = validateCanonicalWeatherMetrics(input.metrics);

  const metadata = validateWeatherRecordMetadata(input.metadata);

  // require non-empty source identity
  if (input.sourceId.trim().length === 0 || input.sourceId.length > 128) {
    throw new RangeError("sourceId must be non-empty and bounded");
  }

  return {
    metadata,
    metrics,
    productRunAt,
    receivedAt,
    sourceId: input.sourceId,
    sourceKind,
    validAt,
  };
}

// validate the complete canonical metric shape
export function validateCanonicalWeatherMetrics(
  metrics: CanonicalWeatherMetrics,
): CanonicalWeatherMetrics {
  const metricKeys = Object.keys(metrics);

  // require the exact canonical metric set
  if (
    metricKeys.length !== METRIC_NAMES.length ||
    METRIC_NAMES.some((metric) => !(metric in metrics)) ||
    metricKeys.some((metric) => !METRIC_NAMES.includes(metric as MetricName))
  ) {
    throw new RangeError("record metrics must use the complete canonical metric set");
  }

  // validate every metric
  for (const [metric, value] of Object.entries(metrics)) {
    // preserve null metrics
    if (value !== null) {
      validateMetricValue(metric as MetricName, value);
    }
  }

  return { ...metrics };
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
  if (
    metric === "temperatureC" ||
    metric === "apparentTemperatureC" ||
    metric === "blackGlobeTemperatureC" ||
    metric === "wetBulbGlobeTemperatureC"
  ) {
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

  // accept precipitation rates
  if (
    metric === "precipitationRateMmPerHour" &&
    (unit === "millimeter_per_hour" || unit === "inch_per_hour")
  ) {
    return unit === "inch_per_hour" ? value * 25.4 : value;
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

    // convert miles per hour
    if (unit === "mile_per_hour") {
      return value * 0.44704;
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

    // convert inches of mercury
    if (unit === "inch_of_mercury") {
      return value * 33.8638866667;
    }
  }

  // accept percentages
  if (
    (metric === "relativeHumidityPercent" ||
      metric === "cloudCoverPercent" ||
      metric === "soilMoisturePercent") &&
    unit === "percent"
  ) {
    return value;
  }

  // accept particulate concentration
  if (
    metric === "pm25MicrogramsPerCubicMeter" &&
    unit === "microgram_per_cubic_meter"
  ) {
    return value;
  }

  // accept soil conductivity
  if (
    metric === "soilElectricalConductivityMicrosiemensPerCm" &&
    unit === "microsiemens_per_centimeter"
  ) {
    return value;
  }

  // accept solar radiation
  if (metric === "solarRadiationWm2" && unit === "watt_per_square_meter") {
    return value;
  }

  // accept UV index
  if (metric === "uvIndex" && unit === "index") {
    return value;
  }

  // accept water levels
  if (metric === "waterLevelM" && unit === "meter") {
    return value;
  }

  // accept directions
  if (metric === "windDirectionDegrees" && unit === "degree") {
    return value;
  }

  throw new RangeError(`${unit} is not supported for ${metric}`);
}

// enforce canonical metric bounds
export function validateMetricValue(metric: MetricName, value: number): void {
  const range = METRIC_BOUNDS[metric];

  // reject impossible values
  if (!Number.isFinite(value) || value < range.minimum || value > range.maximum) {
    throw new RangeError(
      `${metric} must be between ${range.minimum} and ${range.maximum}`,
    );
  }

  // reject exclusive maxima
  if (range.maximumExclusive === true && value === range.maximum) {
    throw new RangeError(`${metric} must be less than ${range.maximum}`);
  }
}

// validate record metadata
export function validateWeatherRecordMetadata(
  metadata: WeatherRecordMetadata,
): WeatherRecordMetadata {
  // reject unknown metadata fields
  if (Object.keys(metadata).some((key) => !METADATA_KEYS.has(key))) {
    throw new RangeError("record metadata contains an unrecognized field");
  }

  const model = validateOptionalMetadataString(metadata.model, "model");
  const device = validateDeviceMetadata(metadata.device);
  const quality = validateMetadataFragment(
    metadata.quality,
    QUALITY_KEYS,
    "quality",
    2_048,
  );
  const provider = validateMetadataFragment(
    metadata.provider,
    PROVIDER_KEYS,
    "provider",
    8_192,
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

  // reject unknown device fields
  if (Object.keys(device).some((key) => !DEVICE_KEYS.has(key))) {
    throw new RangeError("device metadata contains an unrecognized field");
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
  maximumBytes: number,
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
  if (serialized.length > maximumBytes) {
    throw new RangeError(`${fieldName} metadata is too large`);
  }

  return { ...fragment };
}
