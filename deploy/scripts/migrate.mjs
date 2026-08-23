import { pathToFileURL } from "node:url";

// initialize the schema and configured site
export async function migrateAndBootstrap(
  pool,
  migrationDirectory,
  siteConfigurationPath,
  dependencies,
  migrationOptions = {},
  tempestConfigurationPath = null,
) {
  try {
    // apply checked migrations first
    const migrations = await dependencies.runMigrations(
      pool,
      migrationDirectory,
      migrationOptions,
    );
    // load configuration after the schema is ready
    const siteConfiguration = await dependencies.loadSiteConfiguration(siteConfigurationPath);
    // bootstrap through the owner pool
    const bootstrap = await dependencies.bootstrapSiteConfiguration(pool, siteConfiguration);
    let tempestBootstrap = null;

    // bootstrap the optional Tempest catalog
    if (tempestConfigurationPath !== null) {
      const tempestConfiguration = await dependencies.loadTempestConfiguration(
        tempestConfigurationPath,
      );
      tempestBootstrap = await dependencies.bootstrapTempestConfiguration(
        pool,
        tempestConfiguration,
      );
    }

    return { bootstrap, migrations, tempestBootstrap };
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
    bootstrapTempestConfiguration,
    createDatabasePool,
    loadDatabaseConfiguration,
    loadSiteConfiguration,
    loadTempestConfiguration,
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
  const tempestConfigurationPath =
    process.env.WEATHER_TEMPEST_CONFIG_PATH ??
    "/opt/weather/config/tempest/stations.json";
  const result = await migrateAndBootstrap(
    pool,
    migrationDirectory,
    siteConfigurationPath,
    {
      bootstrapSiteConfiguration,
      bootstrapTempestConfiguration,
      loadSiteConfiguration,
      loadTempestConfiguration,
      runMigrations,
    },
    {
      lockTimeoutMs: configuration.lockTimeoutMs,
      statementTimeoutMs: configuration.statementTimeoutMs,
    },
    tempestConfigurationPath,
  );
  console.log(
    JSON.stringify({
      bootstrap: result.bootstrap,
      event: "migrations_complete",
      tempestBootstrap: result.tempestBootstrap,
      ...result.migrations,
    }),
  );
}
