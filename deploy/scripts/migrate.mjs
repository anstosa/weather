import { pathToFileURL } from "node:url";

// initialize the schema and configured site
export async function migrateAndBootstrap(
  pool,
  migrationDirectory,
  siteConfigurationPath,
  dependencies,
) {
  try {
    // apply checked migrations first
    const migrations = await dependencies.runMigrations(pool, migrationDirectory);
    // load configuration after the schema is ready
    const siteConfiguration = await dependencies.loadSiteConfiguration(siteConfigurationPath);
    // bootstrap through the owner pool
    const bootstrap = await dependencies.bootstrapSiteConfiguration(pool, siteConfiguration);

    return { bootstrap, migrations };
  } finally {
    // close pooled sessions
    await pool.end();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

// run only when invoked as the one-shot
if (isEntrypoint) {
  const {
    bootstrapSiteConfiguration,
    createDatabasePool,
    loadDatabaseConfiguration,
    loadSiteConfiguration,
    runMigrations,
  } = await import("@weather/database");
  const configuration = await loadDatabaseConfiguration();
  const pool = createDatabasePool(configuration);
  const migrationDirectory =
    process.env.WEATHER_MIGRATION_DIRECTORY ??
    "/opt/weather/packages/database/migrations";
  const siteConfigurationPath =
    process.env.WEATHER_SITE_CONFIG_PATH ??
    "/opt/weather/config/sites/ballydidean.json";
  const result = await migrateAndBootstrap(
    pool,
    migrationDirectory,
    siteConfigurationPath,
    {
      bootstrapSiteConfiguration,
      loadSiteConfiguration,
      runMigrations,
    },
  );
  console.log(
    JSON.stringify({
      bootstrap: result.bootstrap,
      event: "migrations_complete",
      ...result.migrations,
    }),
  );
}
