import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  serializeSourceMaterial,
  validateCoordinates,
  validateStableKey,
  validateTimeZone,
  type JsonValue,
} from "@weather/domain";

export const ECOWITT_SOURCE_CONTRACT_VERSION = "ecowitt-local-live/v1";

const PRIVATE_IPV4 = /^(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3})$/u;

export interface EcowittStationConfiguration {
  readonly active: boolean;
  readonly adapterConfig: JsonValue;
  readonly cadenceSeconds: number;
  readonly displayName: string;
  readonly expectedMac: string;
  readonly fingerprint: string;
  readonly gatewayHost: string;
  readonly key: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly model: string;
  readonly sourceKey: string;
  readonly timezone: string;
}

export interface EcowittConfiguration {
  readonly provider: {
    readonly active: boolean;
    readonly attributionLabel: string;
    readonly attributionUrl: string;
    readonly displayName: string;
    readonly key: string;
  };
  readonly siteKey: string;
  readonly stations: readonly EcowittStationConfiguration[];
  readonly version: number;
}

// load the checked local gateway catalog
export async function loadEcowittConfiguration(
  path: string,
): Promise<EcowittConfiguration> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseEcowittConfiguration(raw);
}

// parse the Ecowitt catalog trust boundary
export function parseEcowittConfiguration(raw: unknown): EcowittConfiguration {
  const root = requireObject(raw, "Ecowitt configuration");

  // require the initial catalog contract
  if (root.version !== 1) {
    throw new RangeError("Ecowitt configuration version must be 1");
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

  // require at least one local gateway
  if (!Array.isArray(root.stations) || root.stations.length === 0) {
    throw new RangeError("Ecowitt configuration requires stations");
  }

  const stations = root.stations.map(
    // parse every configured gateway
    (value, index) => parseStation(
      requireObject(value, `stations[${index}]`),
      index,
      providerKey,
      siteKey,
      1,
    ),
  );

  // reject duplicate durable identities
  for (const field of ["key", "sourceKey", "expectedMac", "gatewayHost"] as const) {
    const values = stations.map(
      // collect one identity field
      (station) => station[field],
    );

    // preserve one-to-one gateway mapping
    if (new Set(values).size !== values.length) {
      throw new RangeError(`Ecowitt station ${field} values must be unique`);
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

// parse one local Ecowitt gateway
function parseStation(
  station: Record<string, unknown>,
  index: number,
  providerKey: string,
  siteKey: string,
  version: number,
): EcowittStationConfiguration {
  const field = `stations[${index}]`;
  const key = validateStableKey(
    requireString(station.key, `${field}.key`, 80),
    `${field}.key`,
  );
  const coordinates = validateCoordinates(
    requireNumber(station.latitude, `${field}.latitude`),
    requireNumber(station.longitude, `${field}.longitude`),
  );
  const timezone = validateTimeZone(
    requireString(station.timezone, `${field}.timezone`, 64),
  );
  const gatewayHost = requirePrivateIpv4(
    station.gatewayHost,
    `${field}.gatewayHost`,
  );
  const expectedMac = requireMac(station.expectedMac, `${field}.expectedMac`);
  const sourceKey = `ecowitt-${expectedMac.replaceAll(":", "").toLowerCase()}-local-live-v1`;
  const adapterConfig = {
    contractVersion: ECOWITT_SOURCE_CONTRACT_VERSION,
    endpointPath: "/get_livedata_info",
    expectedMac,
    gatewayHost,
    measurementSet: "canonical-primary",
    rainGauge: "traditional-preferred",
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
      60,
      3_600,
    ),
    displayName: requireString(station.displayName, `${field}.displayName`, 160),
    expectedMac,
    fingerprint: createHash("sha256").update(material).digest("hex"),
    gatewayHost,
    key,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    model: requireString(station.model, `${field}.model`, 128),
    sourceKey,
    timezone,
  };
}

// require one private dotted-quad address
function requirePrivateIpv4(value: unknown, field: string): string {
  const host = requireString(value, field, 64);
  const validOctets = host.split(".").every(
    // require decimal octets only
    (part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255,
  );

  // prevent configured SSRF outside the farm LAN
  if (!PRIVATE_IPV4.test(host) || !validOctets) {
    throw new RangeError(`${field} must be a private IPv4 address`);
  }

  return host;
}

// require one canonical gateway MAC
function requireMac(value: unknown, field: string): string {
  const mac = requireString(value, field, 17).toUpperCase();

  // reject ambiguous hardware identities
  if (!/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/u.test(mac)) {
    throw new RangeError(`${field} must use canonical colon notation`);
  }

  return mac;
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
  // reject empty or oversized strings
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

// require one public attribution URL
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
