import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  createTestPool,
  startPostgres,
  stopPostgres,
} from "../../packages/database/test/postgres-harness.mjs";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = join(repoRoot, "packages/database/migrations");
const runtimeAclPath = join(repoRoot, "deploy/postgres/runtime-acl-v1.sql");
const siteConfigurationPath = join(repoRoot, "config/sites/ballydidean.json");
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";

// require PostgreSQL privilege denial
async function assertPrivilegeDenied(operation) {
  await assert.rejects(operation, { code: "42501" });
}

// configure production-equivalent database roles
async function bootstrapRuntimeRoles(server, directory) {
  const adminPath = join(directory, "admin");
  const ownerPath = join(directory, "owner");
  const apiPath = join(directory, "api");
  const ingestPath = join(directory, "ingest");
  await Promise.all([
    writeFile(adminPath, `${server.password}\n`, { mode: 0o600 }),
    writeFile(ownerPath, "owner-test\n", { mode: 0o600 }),
    writeFile(apiPath, "api-test\n", { mode: 0o600 }),
    writeFile(ingestPath, "ingest-test\n", { mode: 0o600 }),
  ]);
  await executeFile(join(repoRoot, "deploy/postgres/010-create-runtime-roles.sh"), [], {
    env: {
      ...process.env,
      PGHOST: server.host,
      PGPASSWORD: server.password,
      PGPORT: String(server.port),
      POSTGRES_DB: "weather_test",
      POSTGRES_USER: server.user,
      WEATHER_ADMIN_PASSWORD_FILE: adminPath,
      WEATHER_API_PASSWORD_FILE: apiPath,
      WEATHER_INGEST_PASSWORD_FILE: ingestPath,
      WEATHER_OWNER_PASSWORD_FILE: ownerPath,
    },
    timeout: 30_000,
  });
  return ownerPath;
}

// read stable bootstrap identities and counts
async function readBootstrapSnapshot(pool) {
  const [sites, stations, providers, sources, migrations, identity, owners, ordering] =
    await Promise.all([
    pool.query("SELECT id, slug, display_name FROM sites ORDER BY slug"),
    pool.query("SELECT id, slug FROM stations ORDER BY slug"),
    pool.query("SELECT id, provider_key FROM providers ORDER BY provider_key"),
    pool.query("SELECT id, source_key FROM sources ORDER BY source_key"),
    pool.query("SELECT name FROM schema_migrations ORDER BY name"),
    pool.query("SELECT current_user, session_user"),
    pool.query(`
      SELECT tablename, tableowner
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY($1::text[])
      ORDER BY tablename
    `, [["providers", "schema_migrations", "sites", "sources", "stations"]]),
    pool.query(`
      SELECT
        (SELECT max(applied_at) FROM schema_migrations) <=
        (SELECT min(created_at) FROM sites) AS migrations_first
    `),
  ]);

  return {
    identity: identity.rows[0],
    migrations: migrations.rows,
    migrationsFirst: ordering.rows[0].migrations_first,
    owners: owners.rows,
    providers: providers.rows,
    sites: sites.rows,
    sources: sources.rows,
    stations: stations.rows,
  };
}

// execute the real migration one-shot twice
test(
  "migration one-shot bootstraps configured Ballydidean data idempotently",
  {
    skip: runIntegration ? false : "set WEATHER_RUN_DEPLOY_INTEGRATION=1",
    timeout: 300_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "weather-migrate-entrypoint-"));
    let server;
    let pool;
    let ingestPool;
    let migrationLockClient;

    try {
      server = await startPostgres(17, "migrate-entrypoint");
      const ownerPath = await bootstrapRuntimeRoles(server, directory);
      const configuredSitePath = join(directory, "ballydidean.json");
      const configuredSite = JSON.parse(await readFile(siteConfigurationPath, "utf8"));
      configuredSite.site.displayName = "Ballydidean entrypoint fixture";
      await writeFile(configuredSitePath, `${JSON.stringify(configuredSite)}\n`);
      const environment = {
        ...process.env,
        WEATHER_DATABASE_APPLICATION_NAME: "weather-migration-entrypoint-test",
        WEATHER_DATABASE_HOST: server.host,
        WEATHER_DATABASE_NAME: "weather_test",
        WEATHER_DATABASE_PASSWORD_FILE: ownerPath,
        WEATHER_DATABASE_PORT: String(server.port),
        WEATHER_DATABASE_SSL: "false",
        WEATHER_DATABASE_USER: "weather_owner",
        WEATHER_MIGRATION_DIRECTORY: migrationDirectory,
        WEATHER_SITE_CONFIG_PATH: configuredSitePath,
      };
      const first = await executeFile(process.execPath, ["deploy/scripts/migrate.mjs"], {
        cwd: repoRoot,
        env: environment,
        timeout: 60_000,
      });
      pool = createTestPool(server, "weather_test", "weather_owner", "owner-test");
      const firstSnapshot = await readBootstrapSnapshot(pool);
      const second = await executeFile(process.execPath, ["deploy/scripts/migrate.mjs"], {
        cwd: repoRoot,
        env: environment,
        timeout: 60_000,
      });
      const secondSnapshot = await readBootstrapSnapshot(pool);
      const firstEvent = JSON.parse(first.stdout.trim());
      const secondEvent = JSON.parse(second.stdout.trim());

      assert.equal(firstEvent.event, "migrations_complete");
      assert.deepEqual(firstEvent.applied, [
        "0001_initial_weather.sql",
        "0002_worker_migration_readiness.sql",
      ]);
      assert.deepEqual(firstEvent.current, []);
      assert.equal(secondEvent.event, "migrations_complete");
      assert.deepEqual(secondEvent.applied, []);
      assert.deepEqual(secondEvent.current, [
        "0001_initial_weather.sql",
        "0002_worker_migration_readiness.sql",
      ]);
      assert.deepEqual(secondEvent.bootstrap, firstEvent.bootstrap);
      assert.deepEqual(secondSnapshot, firstSnapshot);
      assert.deepEqual(firstSnapshot.identity, {
        current_user: "weather_owner",
        session_user: "weather_owner",
      });
      assert.equal(firstSnapshot.migrationsFirst, true);
      assert.deepEqual(firstSnapshot.migrations, [
        { name: "0001_initial_weather.sql" },
        { name: "0002_worker_migration_readiness.sql" },
      ]);
      assert.deepEqual(firstSnapshot.owners, [
        { tableowner: "weather_owner", tablename: "providers" },
        { tableowner: "weather_owner", tablename: "schema_migrations" },
        { tableowner: "weather_owner", tablename: "sites" },
        { tableowner: "weather_owner", tablename: "sources" },
        { tableowner: "weather_owner", tablename: "stations" },
      ]);
      assert.deepEqual(firstSnapshot.providers, [
        { id: firstEvent.bootstrap.providerId, provider_key: "open-meteo" },
      ]);
      assert.deepEqual(firstSnapshot.sites, [
        {
          display_name: "Ballydidean entrypoint fixture",
          id: firstEvent.bootstrap.siteId,
          slug: "ballydidean",
        },
      ]);
      assert.deepEqual(firstSnapshot.sources, [
        { id: firstEvent.bootstrap.sourceIds[0], source_key: "open-meteo-current-v1" },
        { id: firstEvent.bootstrap.sourceIds[1], source_key: "open-meteo-reanalysis-v1" },
      ]);
      assert.deepEqual(firstSnapshot.stations, [
        { id: firstEvent.bootstrap.stationId, slug: "open-meteo-virtual" },
      ]);

      // hold the production migration lock
      migrationLockClient = await pool.connect();
      await migrationLockClient.query("SELECT pg_advisory_lock($1::bigint)", [
        8_032_416_683_782_917,
      ]);
      const contentionStartedAt = performance.now();
      await assert.rejects(
        executeFile(process.execPath, ["deploy/scripts/migrate.mjs"], {
          cwd: repoRoot,
          env: {
            ...environment,
            WEATHER_DATABASE_LOCK_TIMEOUT_MS: "250",
            WEATHER_DATABASE_STATEMENT_TIMEOUT_MS: "5000",
          },
          timeout: 5_000,
        }),
        // require the database lock timeout
        (error) => {
          assert.match(error.stderr, /canceling statement due to lock timeout/u);
          return true;
        },
      );
      const contentionElapsedMs = performance.now() - contentionStartedAt;
      assert.equal(contentionElapsedMs >= 200, true);
      assert.equal(contentionElapsedMs < 2_500, true);
      await migrationLockClient.query("SELECT pg_advisory_unlock($1::bigint)", [
        8_032_416_683_782_917,
      ]);
      migrationLockClient.release();
      migrationLockClient = undefined;

      await executeFile(
        "psql",
        [
          "--set=ON_ERROR_STOP=1",
          "--host",
          server.host,
          "--port",
          String(server.port),
          "--username",
          server.user,
          "--dbname",
          "weather_test",
          "--file",
          runtimeAclPath,
        ],
        {
          env: { ...process.env, PGPASSWORD: server.password },
          timeout: 30_000,
        },
      );
      ingestPool = createTestPool(server, "weather_test", "weather_ingest", "ingest-test");
      const ingestMigrations = await ingestPool.query(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      assert.deepEqual(ingestMigrations.rows, [
        { name: "0001_initial_weather.sql" },
        { name: "0002_worker_migration_readiness.sql" },
      ]);
      await assertPrivilegeDenied(
        ingestPool.query(
          "INSERT INTO schema_migrations (name, checksum) VALUES ('forbidden.sql', repeat('0', 64))",
        ),
      );
      await assertPrivilegeDenied(
        ingestPool.query("UPDATE schema_migrations SET name = name WHERE false"),
      );
      await assertPrivilegeDenied(
        ingestPool.query("DELETE FROM schema_migrations WHERE false"),
      );
      await assertPrivilegeDenied(ingestPool.query("TRUNCATE schema_migrations"));
      await assertPrivilegeDenied(
        ingestPool.query("CREATE TABLE weather_ingest_acl_probe (id integer)"),
      );
    } finally {
      // clean disposable resources
      migrationLockClient?.release();
      await ingestPool?.end();
      await pool?.end();
      // stop only a started container
      if (server !== undefined) {
        await stopPostgres(server);
      }
      await rm(directory, { force: true, recursive: true });
    }
  },
);
