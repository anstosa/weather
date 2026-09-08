import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { runMigrations } from "../../packages/database/dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "../../packages/database/test/postgres-harness.mjs";

const executeFile = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = join(repoRoot, "packages/database/migrations");
const runtimeAclPath = join(repoRoot, "deploy/postgres/runtime-acl-v2.sql");
const runIntegration = process.env.WEATHER_RUN_DEPLOY_INTEGRATION === "1";

// copy one exact migration prefix
async function copyMigrationPrefix(destination, count) {
  const migrations = (await readdir(migrationDirectory))
    .filter((name) => {
      // select migration artifacts only
      return /^\d{4}_.+\.sql$/u.test(name);
    })
    .sort()
    .slice(0, count);

  // retain immutable migration bytes
  for (const migration of migrations) {
    await copyFile(
      join(migrationDirectory, migration),
      join(destination, migration),
    );
  }

  return migrations;
}

// apply the production psql ACL contract
async function applyRuntimeAcl(server, sourcePath, targetName) {
  const containerPath = `/tmp/${targetName}`;
  await executeFile(
    "docker",
    ["cp", sourcePath, `${server.name}:${containerPath}`],
    { timeout: 30_000 },
  );
  return executeFile(
    "docker",
    [
      "exec",
      server.name,
      "psql",
      "--set=ON_ERROR_STOP=1",
      "--username",
      server.user,
      "--dbname",
      "weather_test",
      "--file",
      containerPath,
    ],
    { timeout: 30_000 },
  );
}

test(
  "temperature canary ACL upgrades retained schema 0012 fail closed",
  {
    // keep the database exercise opt-in
    skip: runIntegration ? false : "set WEATHER_RUN_DEPLOY_INTEGRATION=1",
    timeout: 120_000,
  },
  async () => {
    // exercise the retained upgrade boundary
    const prefixDirectory = await mkdtemp(
      join(tmpdir(), "weather-canary-upgrade-migrations-"),
    );
    const server = await startPostgres(17, "temperature-canary-upgrade");
    const pool = createTestPool(server);

    try {
      await createRuntimeRoles(pool);
      const prefix = await copyMigrationPrefix(prefixDirectory, 12);
      const initial = await runMigrations(pool, prefixDirectory);

      assert.equal(prefix.at(-1), "0012_hide_archive_only_forecasts_from_live_reads.sql");
      assert.deepEqual(initial.applied, prefix);
      assert.equal(
        (await pool.query("SELECT to_regclass('ecmwf_temperature_canary_runs') AS relation")).rows[0].relation,
        null,
      );
      await applyRuntimeAcl(server, runtimeAclPath, basename(runtimeAclPath));

      await pool.query("CREATE TABLE ecmwf_temperature_canary_runs (id bigint PRIMARY KEY)");
      await assert.rejects(
        applyRuntimeAcl(server, runtimeAclPath, "runtime-acl-v2-partial.sql"),
        (error) => {
          // require the explicit partial-schema rejection
          return error?.stderr?.includes(
            "ECMWF temperature canary schema is incomplete",
          );
        },
      );
      await pool.query("DROP TABLE ecmwf_temperature_canary_runs");

      const upgraded = await runMigrations(pool, migrationDirectory);
      assert.deepEqual(upgraded.current, prefix);
      assert.deepEqual(upgraded.applied, ["0013_ecmwf_temperature_canary.sql"]);
      await applyRuntimeAcl(server, runtimeAclPath, "runtime-acl-v2-upgraded.sql");

      const privileges = await pool.query(`
        SELECT
          has_table_privilege(
            'weather_api', 'ecmwf_temperature_canary_runs', 'SELECT'
          ) AS api_runs_select,
          has_table_privilege(
            'weather_api', 'ecmwf_temperature_canary_hours', 'SELECT'
          ) AS api_hours_select,
          has_table_privilege(
            'weather_api', 'ecmwf_temperature_canary_runs', 'INSERT,UPDATE,DELETE'
          ) AS api_runs_write,
          has_table_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_runs', 'SELECT'
          ) AND has_table_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_runs', 'INSERT'
          ) AS ingest_runs_read_insert,
          has_table_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_hours', 'SELECT'
          ) AND has_table_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_hours', 'INSERT'
          ) AS ingest_hours_read_insert,
          has_table_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_hours', 'UPDATE,DELETE'
          ) AS ingest_hours_mutate,
          has_column_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_runs',
            'last_received_at', 'UPDATE'
          ) AS ingest_last_receipt_update,
          has_column_privilege(
            'weather_ingest', 'ecmwf_temperature_canary_runs',
            'first_received_at', 'UPDATE'
          ) AS ingest_first_receipt_update
      `);

      assert.deepEqual(privileges.rows[0], {
        api_hours_select: true,
        api_runs_select: true,
        api_runs_write: false,
        ingest_first_receipt_update: false,
        ingest_hours_mutate: false,
        ingest_hours_read_insert: true,
        ingest_last_receipt_update: true,
        ingest_runs_read_insert: true,
      });
    } finally {
      // clean every disposable test resource
      await pool.end().catch(() => {
        // preserve the primary test outcome
        return undefined;
      });
      await stopPostgres(server);
      await rm(prefixDirectory, { force: true, recursive: true });
    }
  },
);
