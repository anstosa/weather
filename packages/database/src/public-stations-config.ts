import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SOURCE_CAPABILITIES,
  serializeSourceMaterial,
  validateCoordinates,
  validateStableKey,
  validateTimeZone,
  type JsonValue,
  type SourceCapability,
} from "@weather/domain";

export const PUBLIC_STATION_ADAPTERS = [
  "ambient-weather",
  "weather-underground",
  "netatmo",
  "purpleair",
] as const;

export type PublicStationAdapter = (typeof PUBLIC_STATION_ADAPTERS)[number];

export interface PublicStationProviderConfiguration {
  readonly active: boolean;
  readonly attributionLabel: string;
  readonly attributionUrl: string;
  readonly displayName: string;
  readonly key: string;
}

export interface PublicStationSourceConfiguration {
  readonly active: boolean;
  readonly adapter: PublicStationAdapter;
  readonly adapterConfig: Readonly<Record<string, JsonValue>>;
  readonly cadenceSeconds: number | null;
  readonly capabilities: readonly SourceCapability[];
  readonly fingerprint: string;
  readonly historyEndDate: string | null;
  readonly historyStartDate: string | null;
  readonly key: string;
  readonly maximumChunkDays: number;
  readonly providerKey: string;
}

export interface PublicStationConfiguration {
  readonly siteKey: string;
  readonly providers: readonly PublicStationProviderConfiguration[];
  readonly stations: readonly PublicStationConfigurationStation[];
  readonly version: number;
}

export interface PublicStationConfigurationStation {
  readonly active: boolean;
  readonly displayName: string;
  readonly key: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly model: string | null;
  readonly serial: string | null;
  readonly sources: readonly PublicStationSourceConfiguration[];
  readonly timezone: string;
  readonly vendor: string | null;
}

// load the checked public-station catalog
export async function loadPublicStationConfiguration(
  path: string,
): Promise<PublicStationConfiguration> {
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  return parsePublicStationConfiguration(raw);
}

// parse the public-station trust boundary
export function parsePublicStationConfiguration(
  raw: unknown,
): PublicStationConfiguration {
  const root = requireObject(raw, "public-station configuration");

  // require the initial catalog contract
  if (root.version !== 1) {
    throw new RangeError("public-station configuration version must be 1");
  }

  const siteKey = validateStableKey(
    requireString(root.siteKey, "siteKey", 80),
    "siteKey",
  );
  const providers = requireArray(root.providers, "providers").map(
    (provider, index) => parseProvider(requireObject(provider, `providers[${index}]`), index),
  );
  const providerKeys = new Set(providers.map((provider) => provider.key));

  // reject ambiguous providers
  if (providerKeys.size !== providers.length) {
    throw new RangeError("public-station provider keys must be unique");
  }

  const stations = requireArray(root.stations, "stations").map((station, index) =>
    parseStation(
      requireObject(station, `stations[${index}]`),
      index,
      siteKey,
      providerKeys,
    ),
  );

  // reject ambiguous station identities
  if (new Set(stations.map((station) => station.key)).size !== stations.length) {
    throw new RangeError("public-station keys must be unique");
  }

  const sourceKeys = stations.flatMap((station) =>
    station.sources.map((source) => source.key),
  );

  // reject ambiguous source identities
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    throw new RangeError("public-station source keys must be unique");
  }

  return { providers, siteKey, stations, version: 1 };
}

// parse one provider definition
function parseProvider(
  provider: Record<string, unknown>,
  index: number,
): PublicStationProviderConfiguration {
  const field = `providers[${index}]`;
  return {
    active: requireBoolean(provider.active, `${field}.active`),
    attributionLabel: requireString(
      provider.attributionLabel,
      `${field}.attributionLabel`,
      256,
    ),
    attributionUrl: requireHttpUrl(
      provider.attributionUrl,
      `${field}.attributionUrl`,
    ),
    displayName: requireString(provider.displayName, `${field}.displayName`, 160),
    key: validateStableKey(
      requireString(provider.key, `${field}.key`, 80),
      `${field}.key`,
    ),
  };
}

// parse one public physical station
function parseStation(
  station: Record<string, unknown>,
  index: number,
  siteKey: string,
  providerKeys: ReadonlySet<string>,
): PublicStationConfigurationStation {
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
  const sources = requireArray(station.sources, `${field}.sources`).map(
    (source, sourceIndex) =>
      parseSource(
        requireObject(source, `${field}.sources[${sourceIndex}]`),
        `${field}.sources[${sourceIndex}]`,
        1,
        siteKey,
        key,
        coordinates,
        timezone,
        providerKeys,
      ),
  );

  // require at least one usable source
  if (sources.length === 0) {
    throw new RangeError(`${field}.sources must not be empty`);
  }

  return {
    active: requireBoolean(station.active, `${field}.active`),
    displayName: requireString(station.displayName, `${field}.displayName`, 160),
    key,
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    model: optionalString(station.model, `${field}.model`, 128),
    serial: optionalString(station.serial, `${field}.serial`, 128),
    sources,
    timezone,
    vendor: optionalString(station.vendor, `${field}.vendor`, 128),
  };
}

// parse one immutable provider source
function parseSource(
  source: Record<string, unknown>,
  field: string,
  version: number,
  siteKey: string,
  stationKey: string,
  coordinates: Readonly<{ latitude: number; longitude: number }>,
  timezone: string,
  providerKeys: ReadonlySet<string>,
): PublicStationSourceConfiguration {
  const key = validateStableKey(
    requireString(source.key, `${field}.key`, 80),
    `${field}.key`,
  );
  const providerKey = validateStableKey(
    requireString(source.providerKey, `${field}.providerKey`, 80),
    `${field}.providerKey`,
  );

  // require a declared provider
  if (!providerKeys.has(providerKey)) {
    throw new RangeError(`${field}.providerKey is not declared`);
  }

  const adapter = requireAdapter(source.adapter, `${field}.adapter`);
  const capabilities = requireCapabilities(
    source.capabilities,
    `${field}.capabilities`,
  );
  const adapterConfig = requireAdapterConfig(
    source.adapterConfig,
    adapter,
    `${field}.adapterConfig`,
  );
  const historyStartDate = optionalDate(
    source.historyStartDate,
    `${field}.historyStartDate`,
  );
  const historyEndDate = optionalDate(
    source.historyEndDate,
    `${field}.historyEndDate`,
  );

  // bind historical sources to a concrete available range
  if (capabilities.includes("historical") && historyStartDate === null) {
    throw new RangeError(`${field}.historyStartDate is required for history`);
  }

  // reject reversed archive bounds
  if (
    historyStartDate !== null &&
    historyEndDate !== null &&
    historyStartDate > historyEndDate
  ) {
    throw new RangeError(`${field} history dates are reversed`);
  }

  const cadenceSeconds = source.cadenceSeconds === null
    ? null
    : requireInteger(
        source.cadenceSeconds,
        `${field}.cadenceSeconds`,
        60,
        86_400,
      );

  // require scheduled current sources to have a cadence
  if (capabilities.includes("current") !== (cadenceSeconds !== null)) {
    throw new RangeError(`${field} current capability and cadence must match`);
  }

  const material = serializeSourceMaterial({
    adapterConfig,
    location: {
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      siteKey,
      timezone,
    },
    providerKey,
    sourceKey: key,
    sourceKind: "physical_sensor",
    stationKey,
    version,
  });

  return {
    active: requireBoolean(source.active, `${field}.active`),
    adapter,
    adapterConfig,
    cadenceSeconds,
    capabilities,
    fingerprint: createHash("sha256").update(material).digest("hex"),
    historyEndDate,
    historyStartDate,
    key,
    maximumChunkDays: requireInteger(
      source.maximumChunkDays,
      `${field}.maximumChunkDays`,
      1,
      31,
    ),
    providerKey,
  };
}

// validate adapter-specific immutable material
function requireAdapterConfig(
  value: unknown,
  adapter: PublicStationAdapter,
  field: string,
): Readonly<Record<string, JsonValue>> {
  const configuration = requireObject(value, field) as Record<string, JsonValue>;

  // validate Ambient source identity
  if (adapter === "ambient-weather") {
    requireExactKeys(configuration, field, [
      "contractVersion",
      "deviceId",
      "macAddress",
      "sample",
    ]);
    requireLiteral(configuration.contractVersion, "ambient-device-data/v1", `${field}.contractVersion`);
    requirePattern(configuration.deviceId, /^[a-f0-9]{24}$/u, `${field}.deviceId`);
    requirePattern(configuration.macAddress, /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/u, `${field}.macAddress`);
    requireLiteral(configuration.sample, "every-distinct-provider-observation", `${field}.sample`);
    return configuration;
  }

  // validate Weather Underground source identity
  if (adapter === "weather-underground") {
    requireExactKeys(configuration, field, [
      "contractVersion",
      "deduplicatesSourceKey",
      "publicApiKey",
      "sample",
      "stationId",
    ]);
    requireLiteral(configuration.contractVersion, "wunderground-pws-history/v1", `${field}.contractVersion`);
    requirePattern(configuration.stationId, /^[A-Z0-9]{3,32}$/u, `${field}.stationId`);
    requirePattern(configuration.publicApiKey, /^[a-f0-9]{32}$/u, `${field}.publicApiKey`);
    requireLiteral(configuration.sample, "five-minute-provider-observations", `${field}.sample`);
    validateStableKey(
      requireString(configuration.deduplicatesSourceKey, `${field}.deduplicatesSourceKey`, 80),
      `${field}.deduplicatesSourceKey`,
    );
    return configuration;
  }

  // validate PurpleAir public-map source identity
  if (adapter === "purpleair") {
    requireExactKeys(configuration, field, [
      "contractVersion",
      "mapVersion",
      "sample",
      "sensorIndex",
    ]);
    requireLiteral(configuration.contractVersion, "purpleair-map-history/v1", `${field}.contractVersion`);
    requirePattern(configuration.mapVersion, /^\d+\.\d+\.\d+$/u, `${field}.mapVersion`);
    requireInteger(configuration.sensorIndex, `${field}.sensorIndex`, 1, 10_000_000);
    requireLiteral(configuration.sample, "every-two-minute-dual-channel-average", `${field}.sample`);
    return configuration;
  }

  requireExactKeys(configuration, field, [
    "contractVersion",
    "deviceId",
    "outdoorModuleId",
    "rainModuleId",
    "sample",
    "windModuleId",
  ]);
  requireLiteral(configuration.contractVersion, "netatmo-public-measures/v1", `${field}.contractVersion`);
  requirePattern(configuration.deviceId, /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u, `${field}.deviceId`);
  requirePattern(configuration.outdoorModuleId, /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u, `${field}.outdoorModuleId`);
  requirePattern(configuration.rainModuleId, /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u, `${field}.rainModuleId`);
  requirePattern(configuration.windModuleId, /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u, `${field}.windModuleId`);
  requireLiteral(configuration.sample, "five-minute-provider-buckets", `${field}.sample`);
  return configuration;
}

// require an exact object key set
function requireExactKeys(
  value: Readonly<Record<string, JsonValue>>,
  field: string,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort().join(",");

  // reject silent source-contract expansion
  if (actual !== [...expected].sort().join(",")) {
    throw new RangeError(`${field} contains unexpected keys`);
  }
}

// require one exact string value
function requireLiteral(value: unknown, expected: string, field: string): void {
  // reject contract drift
  if (value !== expected) {
    throw new RangeError(`${field} must equal ${expected}`);
  }
}

// require one string pattern
function requirePattern(value: unknown, pattern: RegExp, field: string): void {
  // reject malformed identifiers
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RangeError(`${field} is invalid`);
  }
}

// require one known adapter
function requireAdapter(value: unknown, field: string): PublicStationAdapter {
  // reject unsupported adapters
  if (!PUBLIC_STATION_ADAPTERS.includes(value as PublicStationAdapter)) {
    throw new RangeError(`${field} is unsupported`);
  }

  return value as PublicStationAdapter;
}

// require source capabilities
function requireCapabilities(
  value: unknown,
  field: string,
): readonly SourceCapability[] {
  const values = requireArray(value, field);

  // require a non-empty unique supported set
  if (
    values.length === 0 ||
    new Set(values).size !== values.length ||
    values.some((entry) => !SOURCE_CAPABILITIES.includes(entry as SourceCapability))
  ) {
    throw new RangeError(`${field} must contain unique supported capabilities`);
  }

  return values as SourceCapability[];
}

// require one object
function requireObject(value: unknown, field: string): Record<string, unknown> {
  // reject null arrays and primitives
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one array
function requireArray(value: unknown, field: string): readonly unknown[] {
  // reject non-arrays
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array`);
  }

  return value;
}

// require one bounded string
function requireString(value: unknown, field: string, maximum: number): string {
  // reject empty or oversized strings
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${field} must be a bounded non-empty string`);
  }

  return value;
}

// parse one optional bounded string
function optionalString(value: unknown, field: string, maximum: number): string | null {
  // preserve explicit absence
  if (value === null) {
    return null;
  }

  return requireString(value, field, maximum);
}

// require one number
function requireNumber(value: unknown, field: string): number {
  // reject non-finite numbers
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
  // reject non-integer bounds
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError(`${field} must be between ${minimum} and ${maximum}`);
  }

  return Number(value);
}

// require one boolean
function requireBoolean(value: unknown, field: string): boolean {
  // reject truthy substitutes
  if (typeof value !== "boolean") {
    throw new TypeError(`${field} must be a boolean`);
  }

  return value;
}

// parse one optional calendar date
function optionalDate(value: unknown, field: string): string | null {
  // preserve explicit absence
  if (value === null) {
    return null;
  }

  const date = requireString(value, field, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);

  // reject rollover dates
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RangeError(`${field} must use a valid YYYY-MM-DD date`);
  }

  return date;
}

// require one HTTP attribution URL
function requireHttpUrl(value: unknown, field: string): string {
  const url = new URL(requireString(value, field, 512));

  // reject non-web schemes
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new RangeError(`${field} must use HTTP or HTTPS`);
  }

  return url.toString();
}
