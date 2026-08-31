import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  serializeSourceMaterial,
  validateCoordinates,
  validateStableKey,
  validateTimeZone,
  type JsonValue,
  type SourceCapability,
  type SourceKind,
  type StationKind,
} from "@weather/domain";

export interface TideProviderConfiguration {
  readonly active: boolean;
  readonly attributionLabel: string;
  readonly attributionUrl: string;
  readonly displayName: string;
  readonly key: string;
}

export interface TideSourceConfiguration {
  readonly active: boolean;
  readonly adapterConfig: Readonly<Record<string, JsonValue>>;
  readonly cadenceSeconds: number;
  readonly capabilities: readonly SourceCapability[];
  readonly fingerprint: string;
  readonly historyStartDate: string;
  readonly key: string;
  readonly maximumChunkDays: number;
  readonly sourceKind: "tide_observation" | "tide_prediction";
}

export interface TideStationConfiguration {
  readonly active: boolean;
  readonly displayName: string;
  readonly key: string;
  readonly kind: StationKind;
  readonly latitude: number;
  readonly longitude: number;
  readonly model: string;
  readonly serial: string;
  readonly source: TideSourceConfiguration;
  readonly timezone: string;
  readonly vendor: string;
}

export interface TideConfiguration {
  readonly provider: TideProviderConfiguration;
  readonly siteKey: string;
  readonly stations: readonly TideStationConfiguration[];
  readonly version: number;
}

// load the checked NOAA tide catalog
export async function loadTideConfiguration(
  path: string,
): Promise<TideConfiguration> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseTideConfiguration(raw);
}

// parse the tide catalog trust boundary
export function parseTideConfiguration(raw: unknown): TideConfiguration {
  const root = requireObject(raw, "tide configuration");

  // require the initial catalog contract
  if (root.version !== 1) {
    throw new RangeError("tide configuration version must be 1");
  }

  const providerValue = requireObject(root.provider, "provider");
  const provider: TideProviderConfiguration = {
    active: requireBoolean(providerValue.active, "provider.active"),
    attributionLabel: requireString(
      providerValue.attributionLabel,
      "provider.attributionLabel",
      256,
    ),
    attributionUrl: requireHttpUrl(
      providerValue.attributionUrl,
      "provider.attributionUrl",
    ),
    displayName: requireString(
      providerValue.displayName,
      "provider.displayName",
      160,
    ),
    key: validateStableKey(
      requireString(providerValue.key, "provider.key", 80),
      "provider.key",
    ),
  };
  const siteKey = validateStableKey(
    requireString(root.siteKey, "siteKey", 80),
    "siteKey",
  );
  const stations = requireArray(root.stations, "stations").map((value, index) =>
    parseStation(
      requireObject(value, `stations[${index}]`),
      index,
      provider.key,
      siteKey,
    ),
  );

  // require both observation and prediction contracts
  if (
    stations.length !== 2 ||
    !stations.some((station) => station.source.sourceKind === "tide_observation") ||
    !stations.some((station) => station.source.sourceKind === "tide_prediction")
  ) {
    throw new RangeError("tide configuration requires one observation and one prediction source");
  }

  // reject duplicate durable identities
  if (
    new Set(stations.map((station) => station.key)).size !== stations.length ||
    new Set(stations.map((station) => station.source.key)).size !== stations.length
  ) {
    throw new RangeError("tide station and source keys must be unique");
  }

  return { provider, siteKey, stations, version: 1 };
}

// parse one NOAA tide station and source
function parseStation(
  value: Record<string, unknown>,
  index: number,
  providerKey: string,
  siteKey: string,
): TideStationConfiguration {
  const field = `stations[${index}]`;
  const key = validateStableKey(
    requireString(value.key, `${field}.key`, 80),
    `${field}.key`,
  );
  const coordinates = validateCoordinates(
    requireNumber(value.latitude, `${field}.latitude`),
    requireNumber(value.longitude, `${field}.longitude`),
  );
  const timezone = validateTimeZone(
    requireString(value.timezone, `${field}.timezone`, 64),
  );
  const sourceValue = requireObject(value.source, `${field}.source`);
  const sourceKind = requireSourceKind(
    sourceValue.sourceKind,
    `${field}.source.sourceKind`,
  );
  const sourceKey = validateStableKey(
    requireString(sourceValue.key, `${field}.source.key`, 80),
    `${field}.source.key`,
  );
  const stationId = requireStationId(value.serial, `${field}.serial`);
  const adapterConfig = sourceKind === "tide_observation"
    ? {
        contractVersion: "noaa-water-level/v1",
        datum: "MLLW",
        product: "water_level",
        sample: "six-minute-verified-water-level",
        stationId,
      }
    : {
        contractVersion: "noaa-tide-predictions/v1",
        datum: "MLLW",
        forecastDays: 30,
        interval: "hilo",
        product: "predictions",
        sample: "high-low-events",
        stationId,
      };
  const material = serializeSourceMaterial({
    adapterConfig,
    location: {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      siteKey,
      timezone,
    },
    providerKey,
    sourceKey,
    sourceKind,
    stationKey: key,
    version: 1,
  });

  return {
    active: requireBoolean(value.active, `${field}.active`),
    displayName: requireString(value.displayName, `${field}.displayName`, 160),
    key,
    kind: requireStationKind(value.kind, `${field}.kind`),
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    model: requireString(value.model, `${field}.model`, 128),
    serial: stationId,
    source: {
      active: requireBoolean(sourceValue.active, `${field}.source.active`),
      adapterConfig,
      cadenceSeconds: requireInteger(
        sourceValue.cadenceSeconds,
        `${field}.source.cadenceSeconds`,
        360,
        86_400,
      ),
      capabilities: sourceKind === "tide_observation"
        ? ["current", "historical"]
        : ["forecast", "historical"],
      fingerprint: createHash("sha256").update(material).digest("hex"),
      historyStartDate: requireDate(
        sourceValue.historyStartDate,
        `${field}.source.historyStartDate`,
      ),
      key: sourceKey,
      maximumChunkDays: requireInteger(
        sourceValue.maximumChunkDays,
        `${field}.source.maximumChunkDays`,
        1,
        sourceKind === "tide_observation" ? 31 : 366,
      ),
      sourceKind,
    },
    timezone,
    vendor: requireString(value.vendor, `${field}.vendor`, 128),
  };
}

// require one supported tide kind
function requireSourceKind(value: unknown, field: string): TideSourceConfiguration["sourceKind"] {
  // reject weather and unknown source semantics
  if (value !== "tide_observation" && value !== "tide_prediction") {
    throw new RangeError(`${field} must be a tide source kind`);
  }

  return value;
}

// require one supported station kind
function requireStationKind(value: unknown, field: string): StationKind {
  // reject unknown station semantics
  if (value !== "physical" && value !== "virtual") {
    throw new RangeError(`${field} must be physical or virtual`);
  }

  return value;
}

// require one response object
function requireObject(value: unknown, field: string): Record<string, unknown> {
  // reject arrays and nulls
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one non-empty array
function requireArray(value: unknown, field: string): readonly unknown[] {
  // reject empty and non-array values
  if (!Array.isArray(value) || value.length === 0) {
    throw new RangeError(`${field} must be a non-empty array`);
  }

  return value;
}

// require one bounded string
function requireString(value: unknown, field: string, maximum: number): string {
  // reject empty and oversized strings
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new RangeError(`${field} must be a bounded non-empty string`);
  }

  return value;
}

// require one boolean
function requireBoolean(value: unknown, field: string): boolean {
  // reject truthy coercion
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }

  return value;
}

// require one finite number
function requireNumber(value: unknown, field: string): number {
  // reject numeric strings
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${field} must be a finite number`);
  }

  return value;
}

// require one bounded integer
function requireInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  // reject fractional and unbounded values
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }

  return Number(value);
}

// require one NOAA station identifier
function requireStationId(value: unknown, field: string): string {
  const stationId = requireString(value, field, 7);

  // reject malformed station keys
  if (!/^\d{7}$/u.test(stationId)) {
    throw new RangeError(`${field} must contain seven digits`);
  }

  return stationId;
}

// require one calendar date
function requireDate(value: unknown, field: string): string {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : null;

  // reject invalid and rolled-over dates
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    date === null ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`${field} must use YYYY-MM-DD`);
  }

  return value;
}

// require one public HTTP URL
function requireHttpUrl(value: unknown, field: string): string {
  const parsed = new URL(requireString(value, field, 512));

  // reject credentials and non-HTTP schemes
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new RangeError(`${field} must be a public HTTP URL`);
  }

  return parsed.href;
}
