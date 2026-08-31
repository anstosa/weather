import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  loadEcowittConfiguration,
  loadDatabaseConfiguration,
  loadPublicStationConfiguration,
  loadSiteConfiguration,
  loadTempestConfiguration,
  loadTideConfiguration,
  readMigrationReadinessAuthorization,
  type DatabaseConfiguration,
  type EcowittConfiguration,
  type MigrationReadinessAuthorization,
  type PublicStationConfiguration,
  type SiteConfiguration,
  type TempestConfiguration,
  type TideConfiguration,
} from "@weather/database";
import {
  OPEN_METEO_COMPATIBILITY_ORIGIN_ENV,
  parseOpenMeteoCompatibilityOrigin,
} from "@weather/providers";

export interface WorkerConfiguration {
  readonly database: DatabaseConfiguration;
  readonly ecowitt: EcowittConfiguration | null;
  readonly instance: string;
  readonly migrationAuthorization: MigrationReadinessAuthorization | null;
  readonly migrationDirectory: string;
  readonly openMeteoCompatibilityOrigin: string | null;
  readonly publicStations: PublicStationConfiguration | null;
  readonly site: SiteConfiguration;
  readonly siteConfigurationPath: string;
  readonly tempest: TempestConfiguration | null;
  readonly tempestApiKey: string | null;
  readonly tides: TideConfiguration | null;
  readonly version: string;
}

// load the worker trust boundary
export async function loadWorkerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkerConfiguration> {
  const siteConfigurationPath = requireEnvironment(
    environment,
    "WEATHER_SITE_CONFIG_PATH",
  );
  const ecowittConfigurationPath = optionalEnvironment(
    environment.WEATHER_ECOWITT_CONFIG_PATH ?? "config/ecowitt/gateways.json",
    "WEATHER_ECOWITT_CONFIG_PATH",
  );
  const tempestConfigurationPath = optionalEnvironment(
    environment.WEATHER_TEMPEST_CONFIG_PATH,
    "WEATHER_TEMPEST_CONFIG_PATH",
  );
  const tempestApiKeyPath = optionalEnvironment(
    environment.WEATHER_TEMPEST_API_KEY_FILE,
    "WEATHER_TEMPEST_API_KEY_FILE",
  );
  const publicStationConfigurationPath = optionalEnvironment(
    environment.WEATHER_PUBLIC_STATIONS_CONFIG_PATH ??
      "config/public-stations/stations.json",
    "WEATHER_PUBLIC_STATIONS_CONFIG_PATH",
  );
  const tideConfigurationPath = optionalEnvironment(
    environment.WEATHER_TIDE_CONFIG_PATH ?? "config/tides/noaa.json",
    "WEATHER_TIDE_CONFIG_PATH",
  );

  // require the catalog and credential together
  if ((tempestConfigurationPath === null) !== (tempestApiKeyPath === null)) {
    throw new Error(
      "WEATHER_TEMPEST_CONFIG_PATH and WEATHER_TEMPEST_API_KEY_FILE must be configured together",
    );
  }

  return {
    database: await loadDatabaseConfiguration(environment),
    ecowitt:
      ecowittConfigurationPath === null
        ? null
        : await loadEcowittConfiguration(ecowittConfigurationPath),
    instance: boundedEnvironment(
      environment.WEATHER_WORKER_INSTANCE ?? "weather-worker",
      "WEATHER_WORKER_INSTANCE",
    ),
    migrationAuthorization: readMigrationReadinessAuthorization(environment),
    migrationDirectory: resolve(
      environment.WEATHER_MIGRATION_DIRECTORY ??
        "packages/database/migrations",
    ),
    openMeteoCompatibilityOrigin: parseOpenMeteoCompatibilityOrigin(
      environment[OPEN_METEO_COMPATIBILITY_ORIGIN_ENV],
    ),
    publicStations:
      publicStationConfigurationPath === null
        ? null
        : await loadPublicStationConfiguration(publicStationConfigurationPath),
    site: await loadSiteConfiguration(siteConfigurationPath),
    siteConfigurationPath,
    tempest:
      tempestConfigurationPath === null
        ? null
        : await loadTempestConfiguration(tempestConfigurationPath),
    tempestApiKey:
      tempestApiKeyPath === null
        ? null
        : await readOneLineSecret(tempestApiKeyPath, "Tempest API key"),
    tides:
      tideConfigurationPath === null
        ? null
        : await loadTideConfiguration(tideConfigurationPath),
    version: boundedEnvironment(
      environment.WEATHER_RELEASE ?? "development",
      "WEATHER_RELEASE",
    ),
  };
}

// read one mounted connector credential
async function readOneLineSecret(path: string, label: string): Promise<string> {
  const value = (await readFile(path, "utf8")).replace(/[\r\n]+$/u, "");

  // reject empty multiline or oversized credentials
  if (value.length === 0 || value.length > 256 || /[\r\n\s]/u.test(value)) {
    throw new Error(`${label} file must contain one bounded non-empty value`);
  }

  return value;
}

// validate one optional environment path
function optionalEnvironment(value: string | undefined, name: string): string | null {
  // preserve omitted optional integrations
  if (value === undefined) {
    return null;
  }

  // reject present but empty paths
  if (value.trim().length === 0) {
    throw new Error(`${name} must be non-empty when configured`);
  }

  return value;
}

// require a configured value
function requireEnvironment(
  environment: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = environment[name];

  // reject missing configuration
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// validate public heartbeat fields
function boundedEnvironment(value: string, name: string): string {
  // reject empty or oversized values
  if (value.trim().length === 0 || value.length > 128) {
    throw new RangeError(`${name} must be non-empty and bounded`);
  }

  return value;
}
