import {
  createDatabasePool,
  loadDatabaseConfiguration,
  runMigrations,
} from "@weather/database";

const configuration = await loadDatabaseConfiguration();
const pool = createDatabasePool(configuration);
const migrationDirectory =
  process.env.WEATHER_MIGRATION_DIRECTORY ??
  "/opt/weather/packages/database/migrations";

try {
  // apply checked migrations
  const result = await runMigrations(pool, migrationDirectory);
  console.log(JSON.stringify({ event: "migrations_complete", ...result }));
} finally {
  // close pooled sessions
  await pool.end();
}
