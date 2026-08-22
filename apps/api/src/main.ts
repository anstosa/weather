import {
  createDatabasePool,
  loadDatabaseConfiguration,
  readMigrationReadinessAuthorization,
} from "@weather/database";
import { resolve } from "node:path";

import {
  createDatabaseWeatherReadStore,
  createWeatherApi,
  createWeatherApiServer,
  readApiRelease,
  writeApiDiagnostic,
} from "./index.js";

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
  logDiagnostic: writeApiDiagnostic,
  version: release,
});
const server = createWeatherApiServer(handler, {
  logDiagnostic: writeApiDiagnostic,
});
const port = parsePort(process.env.WEATHER_API_PORT ?? "8080");

server.listen(port, "0.0.0.0");

// parse a safe listener port
function parsePort(value: string): number {
  const port = Number(value);

  // reject invalid listener configuration
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("WEATHER_API_PORT must be between 1 and 65535");
  }

  return port;
}
