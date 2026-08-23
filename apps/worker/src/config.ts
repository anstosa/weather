import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import {
  loadDatabaseConfiguration,
  loadSiteConfiguration,
  loadTempestConfiguration,
  readMigrationReadinessAuthorization,
  type DatabaseConfiguration,
  type MigrationReadinessAuthorization,
  type SiteConfiguration,
  type TempestConfiguration,
} from "@weather/database";
import {
  OPEN_METEO_COMPATIBILITY_ORIGIN_ENV,
  parseOpenMeteoCompatibilityOrigin,
} from "@weather/providers";

export interface WorkerConfiguration {
  readonly database: DatabaseConfiguration;
  readonly instance: string;
  readonly migrationAuthorization: MigrationReadinessAuthorization | null;
  readonly migrationDirectory: string;
  readonly openMeteoCompatibilityOrigin: string | null;
  readonly site: SiteConfiguration;
  readonly siteConfigurationPath: string;
  readonly tempest: TempestConfiguration | null;
  readonly tempestApiKey: string | null;
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
  const tempestConfigurationPath = optionalEnvironment(
    environment.WEATHER_TEMPEST_CONFIG_PATH,
    "WEATHER_TEMPEST_CONFIG_PATH",
  );
  const tempestApiKeyPath = optionalEnvironment(
    environment.WEATHER_TEMPEST_API_KEY_FILE,
    "WEATHER_TEMPEST_API_KEY_FILE",
  );

  // require the catalog and credential together
  if ((tempestConfigurationPath === null) !== (tempestApiKeyPath === null)) {
    throw new Error(
      "WEATHER_TEMPEST_CONFIG_PATH and WEATHER_TEMPEST_API_KEY_FILE must be configured together",
    );
  }

  return {
    database: await loadDatabaseConfiguration(environment),
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
