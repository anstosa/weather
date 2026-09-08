import {
  createDatabasePool,
  loadDatabaseConfiguration,
  readMigrationReadinessAuthorization,
} from "@weather/database";
import {
  createForecastAdjustmentRuntimeLoader,
  createForecastAdjustmentTemperatureCanaryRuntimeLoader,
  createForecastAdjustmentWindCanaryRuntimeLoader,
  type LoadedForecastAdjustmentRuntimeV1,
  type LoadedForecastAdjustmentTemperatureCanaryRuntimeV1,
  type LoadedForecastAdjustmentWindCanaryRuntimeV1,
} from "@weather/forecast-adjustment";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDatabaseWeatherReadStore,
  createWeatherApi,
  createWeatherApiServer,
  readApiRelease,
  writeApiDiagnostic,
} from "./index.js";

type LoadedApiForecastAdjustmentRuntime =
  | LoadedForecastAdjustmentRuntimeV1
  | LoadedForecastAdjustmentWindCanaryRuntimeV1;

// define the startup-only adjustment snapshot
export interface ForecastAdjustmentStartupSnapshot {
  readonly loadedAt: string;
  readonly runtime: LoadedApiForecastAdjustmentRuntime;
}

// define the independent startup-only temperature snapshot
export interface ForecastTemperatureAdjustmentStartupSnapshot {
  readonly loadedAt: string;
  readonly runtime: LoadedForecastAdjustmentTemperatureCanaryRuntimeV1;
}

// expose narrow startup seams for deterministic boundary tests
export interface WeatherApiStartupDependencies {
  readonly loadForecastAdjustmentRuntime?: () => Promise<LoadedForecastAdjustmentRuntimeV1>;
  readonly loadForecastAdjustmentTemperatureCanaryRuntime?: () => Promise<LoadedForecastAdjustmentTemperatureCanaryRuntimeV1>;
  readonly loadForecastAdjustmentWindCanaryRuntime?: () => Promise<LoadedForecastAdjustmentWindCanaryRuntimeV1>;
  readonly now?: () => Date;
  readonly prepareServer?: (
    adjustment: ForecastAdjustmentStartupSnapshot,
    temperatureAdjustment: ForecastTemperatureAdjustmentStartupSnapshot,
  ) => Promise<Readonly<{ port: number; server: Server }>>;
}

// share an immutable fail-raw loader result
const disabledLoaderRuntime = Object.freeze({
  bundle: null,
  reasonCode: "bundle_invalid",
  state: "disabled",
} as const);

// load one immutable runtime before constructing or listening on the server
export async function startWeatherApi(
  dependencies: WeatherApiStartupDependencies = {},
): Promise<Readonly<{
  adjustment: ForecastAdjustmentStartupSnapshot;
  server: Server;
  temperatureAdjustment: ForecastTemperatureAdjustmentStartupSnapshot;
}>> {
  const loadRuntime = dependencies.loadForecastAdjustmentRuntime ??
    loadFixedForecastAdjustmentRuntime;
  const loadWindCanaryRuntime = dependencies.loadForecastAdjustmentWindCanaryRuntime ??
    loadFixedForecastAdjustmentWindCanaryRuntime;
  const loadTemperatureCanaryRuntime =
    dependencies.loadForecastAdjustmentTemperatureCanaryRuntime ??
    loadFixedForecastAdjustmentTemperatureCanaryRuntime;
  const now = dependencies.now ?? currentDate;
  const prepareServer = dependencies.prepareServer ?? prepareProductionServer;
  let windCanaryRuntime: LoadedForecastAdjustmentWindCanaryRuntimeV1;
  let runtime: LoadedApiForecastAdjustmentRuntime;
  let temperatureRuntime: LoadedForecastAdjustmentTemperatureCanaryRuntimeV1;

  // contain every canary loader failure
  try {
    windCanaryRuntime = await loadWindCanaryRuntime();
  } catch {
    windCanaryRuntime = disabledLoaderRuntime;
  }

  // prefer only an explicitly active canary
  if (windCanaryRuntime.state === "active") {
    runtime = windCanaryRuntime;
  } else if (windCanaryRuntime.reasonCode === "registry_inactive") {
    // contain every qualified loader failure
    try {
      runtime = await loadRuntime();
    } catch {
      runtime = disabledLoaderRuntime;
    }
  } else {
    runtime = windCanaryRuntime;
  }

  // contain temperature loader failure without affecting wind selection
  try {
    temperatureRuntime = await loadTemperatureCanaryRuntime();
  } catch {
    temperatureRuntime = disabledLoaderRuntime;
  }

  const loadedAt = now().toISOString();
  const adjustment = {
    loadedAt,
    runtime,
  };
  const temperatureAdjustment = {
    loadedAt,
    runtime: temperatureRuntime,
  };
  const prepared = await prepareServer(adjustment, temperatureAdjustment);
  prepared.server.listen(prepared.port, "0.0.0.0");
  return { adjustment, server: prepared.server, temperatureAdjustment };
}

// use only the fixed production root and registry filename
async function loadFixedForecastAdjustmentRuntime(): Promise<LoadedForecastAdjustmentRuntimeV1> {
  const loader = createForecastAdjustmentRuntimeLoader();
  return await loader.load();
}

// use only the isolated wind-canary registry and kill switch
async function loadFixedForecastAdjustmentWindCanaryRuntime(): Promise<LoadedForecastAdjustmentWindCanaryRuntimeV1> {
  const environmentKillSwitch =
    process.env.WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH;
  const loader = createForecastAdjustmentWindCanaryRuntimeLoader({
    ...(environmentKillSwitch === undefined ? {} : { environmentKillSwitch }),
  });
  return await loader.load();
}

// use only the isolated temperature registry and fail-closed switch
async function loadFixedForecastAdjustmentTemperatureCanaryRuntime(): Promise<LoadedForecastAdjustmentTemperatureCanaryRuntimeV1> {
  const environmentKillSwitch =
    process.env.WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH;
  const loader = createForecastAdjustmentTemperatureCanaryRuntimeLoader({
    ...(environmentKillSwitch === undefined ? {} : { environmentKillSwitch }),
  });
  return await loader.load();
}

// construct production resources after adjustment selection is frozen
async function prepareProductionServer(
  adjustment: ForecastAdjustmentStartupSnapshot,
  temperatureAdjustment: ForecastTemperatureAdjustmentStartupSnapshot,
): Promise<Readonly<{ port: number; server: Server }>> {
  const configuration = await loadDatabaseConfiguration({
    ...process.env,
    WEATHER_DATABASE_APPLICATION_NAME:
      process.env.WEATHER_DATABASE_APPLICATION_NAME ?? "weather-api",
  });
  const pool = createDatabasePool(configuration);
  const release = readApiRelease(process.env);
  const store = createDatabaseWeatherReadStore(pool, {
    migrationAuthorization: readMigrationReadinessAuthorization(process.env),
    migrationDirectory: resolve(
      process.env.WEATHER_MIGRATION_DIRECTORY ?? "packages/database/migrations",
    ),
    release,
  });
  const handler = createWeatherApi(store, {
    forecastAdjustment: adjustment,
    logDiagnostic: writeApiDiagnostic,
    temperatureAdjustment,
    version: release,
  });
  const server = createWeatherApiServer(handler, {
    logDiagnostic: writeApiDiagnostic,
  });
  const port = parsePort(process.env.WEATHER_API_PORT ?? "8080");
  return { port, server };
}

// read the startup wall clock once
function currentDate(): Date {
  return new Date();
}

// parse a safe listener port
function parsePort(value: string): number {
  const port = Number(value);

  // reject invalid listener configuration
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("WEATHER_API_PORT must be between 1 and 65535");
  }

  return port;
}

const invokedPath = process.argv[1];

// start only when Node executes this module directly
if (
  invokedPath !== undefined &&
  pathToFileURL(resolve(invokedPath)).href === import.meta.url
) {
  await startWeatherApi();
}
