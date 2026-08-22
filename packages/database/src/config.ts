import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  SOURCE_CAPABILITIES,
  parseSourceKind,
  serializeSourceMaterial,
  validateCoordinates,
  validateStableKey,
  validateTimeZone,
  type JsonValue,
  type SourceCapability,
  type SourceKind,
  type StationKind,
} from "@weather/domain";
import type { PoolConfig } from "pg";

export interface DatabaseConfiguration {
  readonly applicationName: string;
  readonly database: string;
  readonly host: string;
  readonly lockTimeoutMs: number;
  readonly password: string;
  readonly port: number;
  readonly ssl: boolean;
  readonly statementTimeoutMs: number;
  readonly user: string;
}

export interface SiteConfigurationSource {
  readonly active: boolean;
  readonly adapterConfig: JsonValue;
  readonly cadenceSeconds: number | null;
  readonly capabilities: readonly SourceCapability[];
  readonly fingerprint: string;
  readonly key: string;
  readonly sourceKind: SourceKind;
}

export interface SiteConfiguration {
  readonly provider: {
    readonly active: boolean;
    readonly attributionLabel: string;
    readonly attributionUrl: string;
    readonly displayName: string;
    readonly key: string;
  };
  readonly site: {
    readonly active: boolean;
    readonly displayName: string;
    readonly key: string;
    readonly latitude: number;
    readonly longitude: number;
    readonly timezone: string;
  };
  readonly sources: readonly SiteConfigurationSource[];
  readonly station: {
    readonly active: boolean;
    readonly displayName: string;
    readonly key: string;
    readonly kind: StationKind;
    readonly model: string | null;
    readonly serial: string | null;
    readonly vendor: string | null;
  };
  readonly version: number;
}

// load database settings without logging secrets
export async function loadDatabaseConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseConfiguration> {
  const passwordFile = requireEnvironment(
    environment,
    "WEATHER_DATABASE_PASSWORD_FILE",
  );
  const password = (await readFile(passwordFile, "utf8")).replace(/[\r\n]+$/u, "");

  // reject empty or multiline mounted secrets
  if (password.length === 0 || /[\r\n]/u.test(password)) {
    throw new Error("database password file must contain one non-empty line");
  }

  return {
    applicationName:
      environment.WEATHER_DATABASE_APPLICATION_NAME ?? "weather-database",
    database: requireEnvironment(environment, "WEATHER_DATABASE_NAME"),
    host: requireEnvironment(environment, "WEATHER_DATABASE_HOST"),
    lockTimeoutMs: parseBoundedInteger(
      environment.WEATHER_DATABASE_LOCK_TIMEOUT_MS ?? "10000",
      "WEATHER_DATABASE_LOCK_TIMEOUT_MS",
      100,
      60_000,
    ),
    password,
    port: parseBoundedInteger(
      environment.WEATHER_DATABASE_PORT ?? "5432",
      "WEATHER_DATABASE_PORT",
      1,
      65_535,
    ),
    ssl: parseBoolean(environment.WEATHER_DATABASE_SSL ?? "false"),
    statementTimeoutMs: parseBoundedInteger(
      environment.WEATHER_DATABASE_STATEMENT_TIMEOUT_MS ?? "30000",
      "WEATHER_DATABASE_STATEMENT_TIMEOUT_MS",
      100,
      300_000,
    ),
    user: requireEnvironment(environment, "WEATHER_DATABASE_USER"),
  };
}

// map settings to pg without credential output
export function toPoolConfiguration(
  configuration: DatabaseConfiguration,
): PoolConfig {
  return {
    application_name: configuration.applicationName,
    database: configuration.database,
    host: configuration.host,
    max: 10,
    password: configuration.password,
    port: configuration.port,
    ssl: configuration.ssl,
    statement_timeout: configuration.statementTimeoutMs,
    user: configuration.user,
  };
}

// load a versioned site configuration
export async function loadSiteConfiguration(
  configurationPath: string,
): Promise<SiteConfiguration> {
  const raw: unknown = JSON.parse(await readFile(configurationPath, "utf8"));

  return parseSiteConfiguration(raw);
}

// parse configuration at the trust boundary
export function parseSiteConfiguration(raw: unknown): SiteConfiguration {
  const root = requireObject(raw, "site configuration");
  const version = root.version;

  // require the initial version
  if (version !== 1) {
    throw new RangeError("site configuration version must be 1");
  }

  const site = requireObject(root.site, "site");
  const station = requireObject(root.station, "station");
  const provider = requireObject(root.provider, "provider");
  const coordinates = validateCoordinates(
    requireNumber(site.latitude, "site.latitude"),
    requireNumber(site.longitude, "site.longitude"),
  );
  const siteKey = validateStableKey(
    requireString(site.key, "site.key"),
    "site.key",
  );
  const siteTimezone = validateTimeZone(
    requireString(site.timezone, "site.timezone"),
  );
  const stationKind = requireString(station.kind, "station.kind");

  // require a known station kind
  if (stationKind !== "physical" && stationKind !== "virtual") {
    throw new RangeError("station.kind must be physical or virtual");
  }

  // require at least one source
  if (!Array.isArray(root.sources) || root.sources.length === 0) {
    throw new RangeError("site configuration requires at least one source");
  }

  const providerKey = validateStableKey(
    requireString(provider.key, "provider.key"),
    "provider.key",
  );
  const stationKey = validateStableKey(
    requireString(station.key, "station.key"),
    "station.key",
  );
  const sources = root.sources.map((source, index) =>
    parseSourceConfiguration(
      requireObject(source, `sources[${index}]`),
      index,
      version,
      providerKey,
      stationKey,
      {
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        siteKey,
        timezone: siteTimezone,
      },
    ),
  );

  // reject duplicate source keys
  if (new Set(sources.map((source) => source.key)).size !== sources.length) {
    throw new RangeError("source keys must be unique");
  }

  return {
    provider: {
      active: requireBoolean(provider.active, "provider.active"),
      attributionLabel: requireBoundedString(
        provider.attributionLabel,
        "provider.attributionLabel",
        256,
      ),
      attributionUrl: requireHttpUrl(
        provider.attributionUrl,
        "provider.attributionUrl",
      ),
      displayName: requireBoundedString(
        provider.displayName,
        "provider.displayName",
        160,
      ),
      key: providerKey,
    },
    site: {
      active: requireBoolean(site.active, "site.active"),
      displayName: requireBoundedString(
        site.displayName,
        "site.displayName",
        160,
      ),
      key: siteKey,
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
      timezone: siteTimezone,
    },
    sources,
    station: {
      active: requireBoolean(station.active, "station.active"),
      displayName: requireBoundedString(
        station.displayName,
        "station.displayName",
        160,
      ),
      key: stationKey,
      kind: stationKind,
      model: optionalBoundedString(station.model, "station.model", 128),
      serial: optionalBoundedString(station.serial, "station.serial", 128),
      vendor: optionalBoundedString(station.vendor, "station.vendor", 128),
    },
    version,
  };
}

// parse one source configuration
function parseSourceConfiguration(
  source: Record<string, unknown>,
  index: number,
  version: number,
  providerKey: string,
  stationKey: string,
  location: Readonly<{
    latitude: number;
    longitude: number;
    siteKey: string;
    timezone: string;
  }>,
): SiteConfigurationSource {
  const field = `sources[${index}]`;
  const key = validateStableKey(
    requireString(source.key, `${field}.key`),
    `${field}.key`,
  );
  const sourceKind = parseSourceKind(
    requireString(source.sourceKind, `${field}.sourceKind`),
  );
  const adapterConfig = requireJsonValue(
    source.adapterConfig,
    `${field}.adapterConfig`,
  );
  const capabilities = requireCapabilities(
    source.capabilities,
    `${field}.capabilities`,
  );
  const material = serializeSourceMaterial({
    adapterConfig,
    location,
    providerKey,
    sourceKey: key,
    sourceKind,
    stationKey,
    version,
  });

  return {
    active: requireBoolean(source.active, `${field}.active`),
    adapterConfig,
    cadenceSeconds:
      source.cadenceSeconds === null
        ? null
        : parseBoundedInteger(
            requireNumber(source.cadenceSeconds, `${field}.cadenceSeconds`),
            `${field}.cadenceSeconds`,
            60,
            31_536_000,
          ),
    capabilities,
    fingerprint: createHash("sha256").update(material).digest("hex"),
    key,
    sourceKind,
  };
}

// require configured environment values
function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];

  // reject missing settings
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// parse bounded integers
function parseBoundedInteger(
  value: number | string,
  fieldName: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);

  // reject non-integer bounds
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`${fieldName} must be between ${minimum} and ${maximum}`);
  }

  return parsed;
}

// parse strict booleans
function parseBoolean(value: string): boolean {
  // accept true
  if (value === "true") {
    return true;
  }

  // accept false
  if (value === "false") {
    return false;
  }

  throw new RangeError("boolean setting must be true or false");
}

// require objects
function requireObject(
  value: unknown,
  fieldName: string,
): Record<string, unknown> {
  // reject non-object values
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require strings
function requireString(value: unknown, fieldName: string): string {
  // reject non-strings
  if (typeof value !== "string") {
    throw new TypeError(`${fieldName} must be a string`);
  }

  return value;
}

// require bounded strings
function requireBoundedString(
  value: unknown,
  fieldName: string,
  maximum: number,
): string {
  const parsed = requireString(value, fieldName);

  // reject empty or oversized values
  if (parsed.trim().length === 0 || parsed.length > maximum) {
    throw new RangeError(`${fieldName} must be non-empty and bounded`);
  }

  return parsed;
}

// parse nullable bounded strings
function optionalBoundedString(
  value: unknown,
  fieldName: string,
  maximum: number,
): string | null {
  // preserve null values
  if (value === null || value === undefined) {
    return null;
  }

  return requireBoundedString(value, fieldName, maximum);
}

// require numeric inputs
function requireNumber(value: unknown, fieldName: string): number {
  // reject non-numbers
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }

  return value;
}

// require boolean inputs
function requireBoolean(value: unknown, fieldName: string): boolean {
  // reject non-booleans
  if (typeof value !== "boolean") {
    throw new TypeError(`${fieldName} must be a boolean`);
  }

  return value;
}

// validate HTTP URLs
function requireHttpUrl(value: unknown, fieldName: string): string {
  const parsed = new URL(requireString(value, fieldName));

  // reject non-http attribution
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RangeError(`${fieldName} must be an HTTP URL`);
  }

  return parsed.toString();
}

// require closed capabilities
function requireCapabilities(
  value: unknown,
  fieldName: string,
): readonly SourceCapability[] {
  // require a non-empty array
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty array`);
  }

  // reject unknown capabilities
  for (const capability of value) {
    // require closed values
    if (
      typeof capability !== "string" ||
      !SOURCE_CAPABILITIES.some((allowed) => allowed === capability)
    ) {
      throw new RangeError(`${fieldName} contains an unsupported capability`);
    }
  }

  return [...new Set(value)] as SourceCapability[];
}

// require JSON-compatible configuration
function requireJsonValue(value: unknown, fieldName: string): JsonValue {
  const object = requireObject(value, fieldName);

  try {
    const serialized = JSON.stringify(object);

    // reject non-json values
    if (serialized === undefined || serialized.length > 16_384) {
      throw new TypeError(`${fieldName} must be bounded JSON`);
    }

    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new TypeError(`${fieldName} must be valid JSON`, { cause: error });
  }
}
