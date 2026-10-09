import {
  createDatabasePool,
  getEcmwfTemperatureCanarySidecar,
  getWeatherForecast,
  loadDatabaseConfiguration,
  readMigrationReadinessAuthorization,
} from "@weather/database";
import {
  createForecastAdjustmentRuntimeLoader,
  createForecastAdjustmentRainRuntimeRegistryLoader,
  createForecastAdjustmentTemperatureCanaryRuntimeLoader,
  createForecastAdjustmentWindCanaryRuntimeLoader,
  loadAdjustmentRevisionCaptureEpochWitness,
  loadInstalledMaintenanceShadowCandidate,
  type InstalledMaintenanceShadowCandidate,
  type LoadedForecastAdjustmentRuntimeV1,
  type LoadedForecastAdjustmentRainRuntimeRegistryV1,
  type LoadedForecastAdjustmentTemperatureCanaryRuntime,
  type LoadedForecastAdjustmentWindCanaryRuntime,
} from "@weather/forecast-adjustment";
import type { Server } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createAdjustmentMaintenanceInternalServer,
  captureApiAdjustmentMaintenanceShadow,
  captureApiTemperatureMaintenanceShadow,
  createDatabaseWeatherReadStore,
  evaluateWindMaintenanceCandidate,
  createHttpAdjustmentMaintenanceArchiveRelay,
  createWeatherApi,
  createWeatherApiServer,
  readApiRelease,
  writeApiDiagnostic,
} from "./index.js";

type LoadedApiForecastAdjustmentRuntime =
  | LoadedForecastAdjustmentRuntimeV1
  | LoadedForecastAdjustmentWindCanaryRuntime;

// define the startup-only adjustment snapshot
export interface ForecastAdjustmentStartupSnapshot {
  readonly loadedAt: string;
  readonly runtime: LoadedApiForecastAdjustmentRuntime;
}

// define the independent startup-only temperature snapshot
export interface ForecastTemperatureAdjustmentStartupSnapshot {
  readonly loadedAt: string;
  readonly runtime: LoadedForecastAdjustmentTemperatureCanaryRuntime;
}

// define the independent startup-only rain snapshot
export interface ForecastRainAdjustmentStartupSnapshot {
  readonly loadedAt: string;
  readonly runtime: LoadedForecastAdjustmentRainRuntimeRegistryV1;
}

// expose narrow startup seams for deterministic boundary tests
export interface WeatherApiStartupDependencies {
  readonly loadForecastAdjustmentRuntime?: () => Promise<LoadedForecastAdjustmentRuntimeV1>;
  readonly loadForecastAdjustmentRainRuntime?: () => Promise<LoadedForecastAdjustmentRainRuntimeRegistryV1>;
  readonly loadForecastAdjustmentTemperatureCanaryRuntime?: () => Promise<LoadedForecastAdjustmentTemperatureCanaryRuntime>;
  readonly loadForecastAdjustmentWindCanaryRuntime?: () => Promise<LoadedForecastAdjustmentWindCanaryRuntime>;
  readonly now?: () => Date;
  readonly prepareServer?: (
    adjustment: ForecastAdjustmentStartupSnapshot,
    temperatureAdjustment: ForecastTemperatureAdjustmentStartupSnapshot,
    rainAdjustment: ForecastRainAdjustmentStartupSnapshot,
  ) => Promise<Readonly<{
    maintenancePort?: number;
    maintenanceServer?: Server;
    port: number;
    server: Server;
  }>>;
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
  maintenanceServer: Server | null;
  rainAdjustment: ForecastRainAdjustmentStartupSnapshot;
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
  const loadRainRuntime = dependencies.loadForecastAdjustmentRainRuntime ??
    loadFixedForecastAdjustmentRainRuntime;
  const now = dependencies.now ?? currentDate;
  const prepareServer = dependencies.prepareServer ?? prepareProductionServer;
  let windCanaryRuntime: LoadedForecastAdjustmentWindCanaryRuntime;
  let runtime: LoadedApiForecastAdjustmentRuntime;
  let temperatureRuntime: LoadedForecastAdjustmentTemperatureCanaryRuntime;
  let rainRuntime: LoadedForecastAdjustmentRainRuntimeRegistryV1;

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

  // contain rain registry failure without enabling a retained sidecar
  try {
    rainRuntime = await loadRainRuntime();
  } catch {
    rainRuntime = {
      artifactSha256: null,
      reasonCode: "registry_invalid",
      state: "disabled",
    };
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
  const rainAdjustment = {
    loadedAt,
    runtime: rainRuntime,
  };
  const prepared = await prepareServer(
    adjustment,
    temperatureAdjustment,
    rainAdjustment,
  );
  prepared.server.listen(prepared.port, "0.0.0.0");
  // listen separately only when the private maintenance relay is configured
  if (prepared.maintenanceServer !== undefined && prepared.maintenancePort !== undefined) {
    prepared.maintenanceServer.listen(prepared.maintenancePort, "0.0.0.0");
  }
  return {
    adjustment,
    maintenanceServer: prepared.maintenanceServer ?? null,
    rainAdjustment,
    server: prepared.server,
    temperatureAdjustment,
  };
}

// use only the fixed production root and registry filename
async function loadFixedForecastAdjustmentRuntime(): Promise<LoadedForecastAdjustmentRuntimeV1> {
  const loader = createForecastAdjustmentRuntimeLoader();
  return await loader.load();
}

// use only the isolated wind-canary registry and kill switch
async function loadFixedForecastAdjustmentWindCanaryRuntime(): Promise<LoadedForecastAdjustmentWindCanaryRuntime> {
  const environmentKillSwitch =
    process.env.WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH;
  const loader = createForecastAdjustmentWindCanaryRuntimeLoader({
    ...(environmentKillSwitch === undefined ? {} : { environmentKillSwitch }),
  });
  return await loader.load();
}

// use only the isolated temperature registry and fail-closed switch
async function loadFixedForecastAdjustmentTemperatureCanaryRuntime(): Promise<LoadedForecastAdjustmentTemperatureCanaryRuntime> {
  const environmentKillSwitch =
    process.env.WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH;
  const loader = createForecastAdjustmentTemperatureCanaryRuntimeLoader({
    ...(environmentKillSwitch === undefined ? {} : { environmentKillSwitch }),
  });
  return await loader.load();
}

// use only the fixed rain registry and compiled artifact identity
async function loadFixedForecastAdjustmentRainRuntime(): Promise<LoadedForecastAdjustmentRainRuntimeRegistryV1> {
  return await createForecastAdjustmentRainRuntimeRegistryLoader().load();
}

// construct production resources after adjustment selection is frozen
async function prepareProductionServer(
  adjustment: ForecastAdjustmentStartupSnapshot,
  temperatureAdjustment: ForecastTemperatureAdjustmentStartupSnapshot,
  rainAdjustment: ForecastRainAdjustmentStartupSnapshot,
): Promise<Readonly<{
  maintenancePort?: number;
  maintenanceServer?: Server;
  port: number;
  server: Server;
}>> {
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
    rainAdjustment,
    temperatureAdjustment,
    version: release,
  });
  const server = createWeatherApiServer(handler, {
    logDiagnostic: writeApiDiagnostic,
  });
  const port = parsePort(process.env.WEATHER_API_PORT ?? "8080");
  const maintenancePortValue = process.env.WEATHER_ADJUSTMENT_MAINTENANCE_INTERNAL_PORT;
  const archiveOrigin = process.env.WEATHER_ADJUSTMENT_MAINTENANCE_ARCHIVE_ORIGIN;
  // fail closed for shadow capture while preserving the public weather api
  if (maintenancePortValue === undefined || archiveOrigin === undefined) {
    return { port, server };
  }
  let captureEpoch;
  // keep every producer inactive until the root-installed zero-frontier witness exists
  try {
    captureEpoch = await loadAdjustmentRevisionCaptureEpochWitness();
  } catch {
    return { port, server };
  }
  const maintenancePort = parsePort(maintenancePortValue);
  const relay = createHttpAdjustmentMaintenanceArchiveRelay(archiveOrigin);
  const [temperatureCandidate, windCandidate] = await Promise.all([
    loadInstalledCandidateSafely("temperature"),
    loadInstalledCandidateSafely("wind"),
  ]);
  const maintenanceServer = createAdjustmentMaintenanceInternalServer({
    captureEpoch,
    // capture from retained database sources only after the worker schedules one cycle
    async capture(request) {
      const firstValidAt = new Date(
        Math.ceil(Date.parse(request.issuedAt) / 3_600_000) * 3_600_000,
      ).toISOString();
      const temperatureEnd = new Date(Date.parse(firstValidAt) + 12 * 3_600_000).toISOString();
      const captures: Promise<unknown>[] = [];
      // omit an uninstalled family without fabricating a registration identity
      if (temperatureCandidate !== null) {
        const [bestMatchRows, sidecar] = await Promise.all([
          getWeatherForecast(pool, {
            asOf: request.issuedAt,
            hours: 12,
            siteSlug: "ballydidean",
          }),
          getEcmwfTemperatureCanarySidecar(pool, {
            asOf: request.issuedAt,
            from: firstValidAt,
            siteSlug: "ballydidean",
            to: temperatureEnd,
          }),
        ]);
        // treat an absent sidecar as a source gap under the real registration
        if (sidecar === null) {
          await relay.recordGap({
            dueKey: request.dueKey,
            family: "temperature",
            reason: "source_incomplete",
            registrationSha256: temperatureCandidate.registration.registrationSha256,
          });
        } else {
          captures.push(captureApiTemperatureMaintenanceShadow({
            bestMatchRows,
            candidate: temperatureCandidate,
            captureEpoch,
            dueKey: request.dueKey,
            incumbentRuntime: temperatureAdjustment.runtime,
            issuedAt: request.issuedAt,
            queryable: pool,
            relay,
            sidecar,
          }));
        }
      }
      // evaluate the complete 168-hour Best Match halo without another provider request
      if (windCandidate !== null) {
        const rows = await getWeatherForecast(pool, {
          asOf: request.issuedAt,
          hours: 168,
          siteSlug: "ballydidean",
        });
        captures.push(captureApiAdjustmentMaintenanceShadow({
          candidate: windCandidate,
          captureEpoch,
          dueKey: request.dueKey,
          evaluate: (source) => Promise.resolve(
            evaluateWindMaintenanceCandidate(windCandidate, source),
          ),
          issuedAt: request.issuedAt,
          incumbentRuntime: adjustment.runtime,
          queryable: pool,
          relay,
          rows,
        }));
      }
      await Promise.all(captures);
    },
    queryable: pool,
    relay,
  });
  return { maintenancePort, maintenanceServer, port, server };
}

// load one root-installed inactive candidate without affecting public startup
async function loadInstalledCandidateSafely<F extends "temperature" | "wind">(
  family: F,
): Promise<InstalledMaintenanceShadowCandidate<F> | null> {
  try {
    return await loadInstalledMaintenanceShadowCandidate({ family });
  } catch {
    return null;
  }
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
