import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  serializeSourceMaterial,
  validateCoordinates,
  validateStableKey,
  validateTimeZone,
  type JsonValue,
} from "@weather/domain";

export const TEMPEST_SOURCE_CONTRACT_VERSION = "tempest-observations/v2";

export interface TempestStationConfiguration {
  readonly active: boolean;
  readonly adapterConfig: JsonValue;
  readonly cadenceSeconds: number;
  readonly deviceId: number;
  readonly displayName: string;
  readonly fingerprint: string;
  readonly historyStartDate: string;
  readonly key: string;
  readonly latitude: number;
  readonly locationId: number;
  readonly longitude: number;
  readonly serial: string;
  readonly sourceKey: string;
  readonly timezone: string;
}

export interface TempestConfiguration {
  readonly provider: {
    readonly active: boolean;
    readonly attributionLabel: string;
    readonly attributionUrl: string;
    readonly displayName: string;
    readonly key: string;
  };
  readonly siteKey: string;
  readonly stations: readonly TempestStationConfiguration[];
  readonly version: number;
}

// load the checked Tempest station catalog
export async function loadTempestConfiguration(
  path: string,
): Promise<TempestConfiguration> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseTempestConfiguration(raw);
}

// parse the Tempest catalog trust boundary
export function parseTempestConfiguration(raw: unknown): TempestConfiguration {
  const root = requireObject(raw, "Tempest configuration");

  // require the initial catalog contract
  if (root.version !== 1) {
    throw new RangeError("Tempest configuration version must be 1");
  }

  const provider = requireObject(root.provider, "provider");
  const providerKey = validateStableKey(
    requireString(provider.key, "provider.key", 80),
    "provider.key",
  );
  const siteKey = validateStableKey(
    requireString(root.siteKey, "siteKey", 80),
    "siteKey",
  );

  // require at least one configured station
  if (!Array.isArray(root.stations) || root.stations.length === 0) {
    throw new RangeError("Tempest configuration requires stations");
  }

  const stations = root.stations.map((value, index) =>
    parseStation(
      requireObject(value, `stations[${index}]`),
      index,
      providerKey,
      siteKey,
      1,
    ),
  );

  // reject duplicate durable identities
  for (const field of ["key", "sourceKey", "locationId", "deviceId"] as const) {
    const values = stations.map((station) => station[field]);

    // preserve one-to-one station mapping
    if (new Set(values).size !== values.length) {
      throw new RangeError(`Tempest station ${field} values must be unique`);
    }
  }

  return {
    provider: {
      active: requireBoolean(provider.active, "provider.active"),
      attributionLabel: requireString(
        provider.attributionLabel,
        "provider.attributionLabel",
        256,
      ),
      attributionUrl: requireHttpUrl(provider.attributionUrl),
      displayName: requireString(provider.displayName, "provider.displayName", 160),
      key: providerKey,
    },
    siteKey,
    stations,
    version: 1,
  };
}

// parse one physical Tempest station
function parseStation(
  station: Record<string, unknown>,
  index: number,
  providerKey: string,
  siteKey: string,
  version: number,
): TempestStationConfiguration {
  const field = `stations[${index}]`;
  const key = validateStableKey(
    requireString(station.key, `${field}.key`, 80),
    `${field}.key`,
  );
  const locationId = requirePositiveInteger(station.locationId, `${field}.locationId`);
  const deviceId = requirePositiveInteger(station.deviceId, `${field}.deviceId`);
  const coordinates = validateCoordinates(
    requireNumber(station.latitude, `${field}.latitude`),
    requireNumber(station.longitude, `${field}.longitude`),
  );
  const timezone = validateTimeZone(
    requireString(station.timezone, `${field}.timezone`, 64),
  );
  const supersedesSourceKey = `tempest-${String(locationId)}-observations-v1`;
  const sourceKey = `tempest-${String(locationId)}-observations-v2`;
  const adapterConfig = {
    contractVersion: TEMPEST_SOURCE_CONTRACT_VERSION,
    deviceId,
    locationId,
    sample: "every-distinct-provider-observation",
    supersedesSourceKey,
  } as const;
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
    sourceKind: "physical_sensor",
    stationKey: key,
    version,
  });

  return {
    active: requireBoolean(station.active, `${field}.active`),
    adapterConfig,
    cadenceSeconds: requireBoundedInteger(
      station.cadenceSeconds,
      `${field}.cadenceSeconds`,
      3600,
      86_400,
    ),
    deviceId,
    displayName: requireString(station.displayName, `${field}.displayName`, 160),
    fingerprint: createHash("sha256").update(material).digest("hex"),
    historyStartDate: requireDate(station.historyStartDate, `${field}.historyStartDate`),
    key,
    latitude: coordinates.latitude,
    locationId,
    longitude: coordinates.longitude,
    serial: requireString(station.serial, `${field}.serial`, 128),
    sourceKey,
    timezone,
  };
}

// require one object
function requireObject(value: unknown, field: string): Record<string, unknown> {
  // reject arrays and nulls
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one bounded string
function requireString(value: unknown, field: string, maximum: number): string {
  // reject empty or oversized values
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new RangeError(`${field} must be a non-empty bounded string`);
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

// require one positive integer
function requirePositiveInteger(value: unknown, field: string): number {
  return requireBoundedInteger(value, field, 1, Number.MAX_SAFE_INTEGER);
}

// require one bounded integer
function requireBoundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  // reject non-integer values
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }

  return Number(value);
}

// require one calendar date
function requireDate(value: unknown, field: string): string {
  const date = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : null;

  // reject invalid and rollover dates
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
function requireHttpUrl(value: unknown): string {
  const parsed = new URL(requireString(value, "provider.attributionUrl", 512));

  // reject credentials and non-HTTP schemes
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0
  ) {
    throw new RangeError("provider.attributionUrl must be a public HTTP URL");
  }

  return parsed.href;
}
