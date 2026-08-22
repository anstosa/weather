import { resolve } from "node:path";

import {
  loadDatabaseConfiguration,
  loadSiteConfiguration,
  type DatabaseConfiguration,
  type SiteConfiguration,
} from "@weather/database";
import {
  OPEN_METEO_COMPATIBILITY_ORIGIN_ENV,
  parseOpenMeteoCompatibilityOrigin,
} from "@weather/providers";

export interface WorkerConfiguration {
  readonly database: DatabaseConfiguration;
  readonly instance: string;
  readonly migrationDirectory: string;
  readonly openMeteoCompatibilityOrigin: string | null;
  readonly site: SiteConfiguration;
  readonly siteConfigurationPath: string;
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

  return {
    database: await loadDatabaseConfiguration(environment),
    instance: boundedEnvironment(
      environment.WEATHER_WORKER_INSTANCE ?? "weather-worker",
      "WEATHER_WORKER_INSTANCE",
    ),
    migrationDirectory: resolve(
      environment.WEATHER_MIGRATION_DIRECTORY ??
        "packages/database/migrations",
    ),
    openMeteoCompatibilityOrigin: parseOpenMeteoCompatibilityOrigin(
      environment[OPEN_METEO_COMPATIBILITY_ORIGIN_ENV],
    ),
    site: await loadSiteConfiguration(siteConfigurationPath),
    siteConfigurationPath,
    version: boundedEnvironment(
      environment.WEATHER_RELEASE ?? "development",
      "WEATHER_RELEASE",
    ),
  };
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
