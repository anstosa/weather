import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { createNormalizedWeatherRecord } from "@weather/domain";

import {
  abandonExpiredRuns,
  acquireSourceSession,
  bootstrapSiteConfiguration,
  completeBackfillIngestion,
  completeScheduledIngestion,
  failIngestionRun,
  getScheduledCheckpoint,
  hasSuccessfulBackfillChunk,
  loadSiteConfiguration,
  runMigrations,
  startIngestionRun,
  updateWorkerHeartbeat,
  verifyMigrationReadiness,
} from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = join(repositoryRoot, "packages/database/migrations");
const siteConfigurationPath = join(repositoryRoot, "config/sites/ballydidean.json");
const executeFile = promisify(execFile);

// exercise the complete Phase 2 PostgreSQL contract
test(
  "I-DB-01 through I-DB-26 PostgreSQL foundation",
  { timeout: 600_000 },
  async (context) => {
    const server = await startPostgres(17, "main");
    const adminPool = createTestPool(server);
    await runRuntimeRoleBootstrap(server);
    const pool = createTestPool(
      server,
      "weather_test",
      "weather_owner",
      "owner-test",
    );
    let configuration;
    let bootstrap;
    let currentSource;
    let reanalysisSource;
    let currentFirstRunId;
    let backfillRunId;
    let successfulBackfillIdentity;

    try {
      // verify initial migration and checksum ledger
      await context.test("I-DB-01 empty database migrates with checksums", async () => {
        const result = await runMigrations(pool, migrationDirectory);
        const ledger = await pool.query(
          "SELECT name, checksum FROM schema_migrations ORDER BY name",
        );

        assert.deepEqual(result.applied, [
          "0001_initial_weather.sql",
          "0002_worker_migration_readiness.sql",
        ]);
        assert.equal(result.serverVersionNum >= 150_000, true);
        assert.equal(ledger.rowCount, 2);
        // require every migration checksum
        for (const row of ledger.rows) {
          assert.match(row.checksum, /^[a-f0-9]{64}$/u);
        }
      });

      // verify rerun and changed-checksum failure
      await context.test("I-DB-02 rerun is a no-op and tampering fails closed", async () => {
        const rerun = await runMigrations(pool, migrationDirectory);
        const directory = await mkdtemp(join(tmpdir(), "weather-migrations-"));

        try {
          const source = await readFile(
            join(migrationDirectory, "0001_initial_weather.sql"),
            "utf8",
          );
          await writeFile(
            join(directory, "0001_initial_weather.sql"),
            `${source}\n-- tampered copy\n`,
          );
          assert.deepEqual(rerun.current, [
            "0001_initial_weather.sql",
            "0002_worker_migration_readiness.sql",
          ]);
          await assert.rejects(
            () => runMigrations(pool, directory),
            /migration checksum mismatch/u,
          );
          await writeFile(join(directory, "0001_initial_weather.sql"), source);
          await writeFile(
            join(directory, "0000_retroactive.sql"),
            "SELECT 1;\n",
          );
          await assert.rejects(
            () => runMigrations(pool, directory),
            /migration history diverges/u,
          );
        } finally {
          await rm(directory, { force: true, recursive: true });
        }
      });

      // verify concurrent first migration serialization
      await context.test("I-DB-03 concurrent migrators serialize", async () => {
        const database = `weather_concurrent_${process.pid}`;
        await adminPool.query(`CREATE DATABASE ${database} OWNER weather_owner`);
        const left = createTestPool(server, database);
        const right = createTestPool(server, database);

        try {
          const [first, second] = await Promise.all([
            runMigrations(left, migrationDirectory),
            runMigrations(right, migrationDirectory),
          ]);
          assert.equal(first.applied.length + second.applied.length, 2);
          assert.equal(first.current.length + second.current.length, 2);
        } finally {
          await Promise.all([left.end(), right.end()]);
          await adminPool.query(`DROP DATABASE ${database}`);
        }
      });

      // verify idempotent Ballydidean bootstrap
      await context.test("I-DB-04 Ballydidean bootstrap is idempotent", async () => {
        configuration = await loadSiteConfiguration(siteConfigurationPath);
        bootstrap = await bootstrapSiteConfiguration(pool, configuration);
        const second = await bootstrapSiteConfiguration(pool, configuration);
        const counts = await pool.query(`
          SELECT
            (SELECT count(*)::integer FROM sites) AS sites,
            (SELECT count(*)::integer FROM stations) AS stations,
            (SELECT count(*)::integer FROM providers) AS providers,
            (SELECT count(*)::integer FROM sources) AS sources
        `);

        assert.deepEqual(second, bootstrap);
        assert.deepEqual(counts.rows[0], {
          providers: 1,
          sites: 1,
          sources: 2,
          stations: 1,
        });
        const sources = await pool.query(
          "SELECT id, source_kind, source_config_fingerprint FROM sources ORDER BY source_kind",
        );
        currentSource = sources.rows.find(
          (source) => source.source_kind === "model_current",
        );
        reanalysisSource = sources.rows.find(
          (source) => source.source_kind === "reanalysis",
        );
        assert.ok(currentSource);
        assert.ok(reanalysisSource);
      });

      // verify schema constraints
      await context.test("I-DB-05 coordinates timezone kinds states and FKs reject invalid rows", async () => {
        await assert.rejects(
          () =>
            pool.query(
              "INSERT INTO sites (slug, display_name, latitude, longitude, timezone) VALUES ('invalid-lat', 'invalid', 91, 0, 'UTC')",
            ),
          hasDatabaseCode("23514"),
        );
        await assert.rejects(
          () =>
            pool.query(
              `
                INSERT INTO sources (
                  station_id,
                  provider_id,
                  source_key,
                  source_kind,
                  material_provider_config,
                  source_config_fingerprint,
                  capabilities
                )
                VALUES ($1, $2, 'invalid-capability', 'model_current', '{}'::jsonb, $3, '["invented"]'::jsonb)
              `,
              [bootstrap.stationId, bootstrap.providerId, "e".repeat(64)],
            ),
          hasDatabaseCode("23514"),
        );
        await assert.rejects(
          () =>
            pool.query(
              "INSERT INTO sites (slug, display_name, latitude, longitude, timezone) VALUES ('invalid-zone', 'invalid', 0, 0, 'Mars/Olympus')",
            ),
          hasDatabaseCode("23503"),
        );
        await assert.rejects(
          () =>
            pool.query(
              "INSERT INTO stations (site_id, slug, display_name, station_kind) VALUES (999999, 'missing', 'missing', 'virtual')",
            ),
          hasDatabaseCode("23503"),
        );
        await assert.rejects(
          () =>
            pool.query(
              `
                INSERT INTO sources (
                  station_id,
                  provider_id,
                  source_key,
                  source_kind,
                  material_provider_config,
                  source_config_fingerprint,
                  capabilities
                )
                VALUES ($1, $2, 'invalid-kind', 'observation', '{}'::jsonb, $3, '["current"]'::jsonb)
              `,
              [bootstrap.stationId, bootstrap.providerId, "f".repeat(64)],
            ),
          hasDatabaseCode("23514"),
        );
      });

      // verify read-only API role
      await context.test("I-DB-06 API role reads but cannot mutate or DDL", async () => {
        const apiPool = createTestPool(server, "weather_test", "weather_api", "api-test");

        try {
          assert.equal((await apiPool.query("SELECT * FROM sites")).rowCount, 1);
          await assert.rejects(
            () => apiPool.query("DELETE FROM sites"),
            hasDatabaseCode("42501"),
          );
          await assert.rejects(
            () => apiPool.query("CREATE TABLE api_escape (id integer)"),
            hasDatabaseCode("42501"),
          );
          await assert.rejects(
            () => apiPool.query("SELECT material_provider_config FROM sources"),
            hasDatabaseCode("42501"),
          );
          await assert.rejects(
            () => apiPool.query("CREATE TEMP TABLE api_temp_escape (id integer)"),
            hasDatabaseCode("42501"),
          );
        } finally {
          await apiPool.end();
        }
      });

      // verify write-limited ingestion role
      await context.test("I-DB-07 ingest role writes operations but cannot DDL or roles", async () => {
        const ingestPool = createTestPool(
          server,
          "weather_test",
          "weather_ingest",
          "ingest-test",
        );

        try {
          const knownMigration = await pool.query(
            "SELECT checksum FROM schema_migrations WHERE name = '0001_initial_weather.sql'",
          );
          assert.deepEqual(
            await verifyMigrationReadiness(ingestPool, migrationDirectory),
            { version: "0002_worker_migration_readiness.sql" },
          );
          try {
            // allow candidate-only trailing history
            await pool.query(
              "INSERT INTO schema_migrations (name, checksum) VALUES ('0003_candidate_only.sql', $1)",
              ["3".repeat(64)],
            );
            assert.deepEqual(
              await verifyMigrationReadiness(ingestPool, migrationDirectory),
              { version: "0002_worker_migration_readiness.sql" },
            );
            await pool.query(
              "UPDATE schema_migrations SET checksum = $1 WHERE name = '0001_initial_weather.sql'",
              ["0".repeat(64)],
            );
            await assert.rejects(
              () => verifyMigrationReadiness(ingestPool, migrationDirectory),
              /migration checksum mismatch/u,
            );
          } finally {
            // restore the shared migration ledger
            await pool.query(
              "UPDATE schema_migrations SET checksum = $1 WHERE name = '0001_initial_weather.sql'",
              [knownMigration.rows[0].checksum],
            );
            await pool.query(
              "DELETE FROM schema_migrations WHERE name = '0003_candidate_only.sql'",
            );
          }
          await ingestPool.query(
            `
              INSERT INTO worker_heartbeats (
                worker_instance,
                last_loop_at,
                worker_version
              )
              VALUES ('role-test', clock_timestamp(), 'test/v1')
            `,
          );
          assert.equal((await ingestPool.query("SELECT * FROM sources")).rowCount, 2);
          await assert.rejects(
            () => ingestPool.query("ALTER TABLE weather_records ADD COLUMN escaped text"),
            hasDatabaseCode("42501"),
          );
          await assert.rejects(
            () => ingestPool.query("CREATE ROLE escaped"),
            hasDatabaseCode("42501"),
          );
          await assert.rejects(
            () =>
              ingestPool.query(
                "UPDATE weather_records SET first_received_at = clock_timestamp()",
              ),
            hasDatabaseCode("42501"),
          );
        } finally {
          await ingestPool.end();
        }
      });

      // verify PostgreSQL version compatibility
      await context.test("I-DB-08 PostgreSQL 15 migrates and PostgreSQL 14 fails preflight", async () => {
        const version15 = await startPostgres(15, "pg15");
        const version14 = await startPostgres(14, "pg14");
        const pool15 = createTestPool(version15);
        const pool14 = createTestPool(version14);

        try {
          await createRuntimeRoles(pool15);
          const migrated = await runMigrations(pool15, migrationDirectory);
          assert.equal(migrated.serverVersionNum >= 150_000, true);
          await assert.rejects(
            () => runMigrations(pool14, migrationDirectory),
            /PostgreSQL 15 or newer/u,
          );
          const ledger14 = await pool14.query(
            "SELECT to_regclass('public.schema_migrations') AS ledger",
          );
          assert.equal(ledger14.rows[0].ledger, null);
        } finally {
          await Promise.all([pool15.end(), pool14.end()]);
          await Promise.all([stopPostgres(version15), stopPostgres(version14)]);
        }
      });

      // verify immutable source semantics
      await context.test("I-DB-09 source material is immutable but cadence and active are mutable", async () => {
        await assert.rejects(
          () =>
            pool.query(
              "UPDATE sources SET material_provider_config = '{\"changed\":true}'::jsonb WHERE id = $1",
              [currentSource.id],
            ),
          hasDatabaseCode("23514"),
        );
        await pool.query(
          "UPDATE sources SET active = false, cadence_seconds = 1800 WHERE id = $1",
          [currentSource.id],
        );
        await pool.query(
          "UPDATE sources SET active = true, cadence_seconds = 900 WHERE id = $1",
          [currentSource.id],
        );
      });

      // verify multi-source storage and first scheduled success
      await context.test("I-DB-10 two sources persist the same valid instant", async () => {
        const currentSession = await requireSession(pool, currentSource.id);
        const reanalysisSession = await requireSession(pool, reanalysisSource.id);

        try {
          const currentRun = await createRun(
            currentSession,
            currentSource,
            "scheduled",
            "2026-08-20T00:00:00.000Z",
            "2026-08-20T00:15:00.000Z",
          );
          currentFirstRunId = currentRun.id;
          await completeScheduledIngestion(currentSession, {
            attempts: 1,
            expectedCheckpointVersion: null,
            lastValidAt: "2026-08-20T00:00:00.000Z",
            providerCursor: { dataset: "current" },
            records: [
              makeRecord(currentSource.id, "model_current", "2026-08-20T00:00:00.000Z"),
            ],
            runId: currentRun.id,
            windowEndExclusive: "2026-08-20T00:15:00.000Z",
            windowStart: "2026-08-20T00:00:00.000Z",
          });
          successfulBackfillIdentity = makeChunkIdentity(
            reanalysisSource,
            "2026-08-20T00:00:00.000Z",
            "2026-08-20T01:00:00.000Z",
          );
          const backfillRun = await createRun(
            reanalysisSession,
            reanalysisSource,
            "backfill",
            successfulBackfillIdentity.intervalStart,
            successfulBackfillIdentity.intervalEndExclusive,
          );
          backfillRunId = backfillRun.id;
          await completeBackfillIngestion(reanalysisSession, {
            attempts: 1,
            identity: successfulBackfillIdentity,
            records: [
              makeRecord(reanalysisSource.id, "reanalysis", "2026-08-20T00:00:00.000Z"),
            ],
            runId: backfillRun.id,
          });
          const rows = await pool.query(
            "SELECT source_id FROM weather_records WHERE valid_at = '2026-08-20T00:00:00.000Z' ORDER BY source_id",
          );
          assert.equal(rows.rowCount, 2);
        } finally {
          await Promise.all([currentSession.release(), reanalysisSession.release()]);
        }
      });

      // verify run fingerprint composite FK
      await context.test("I-DB-11 run fingerprint must match its source", async () => {
        await assert.rejects(
          () =>
            pool.query(
              `
                INSERT INTO ingestion_runs (
                  source_id,
                  mode,
                  requested_start,
                  requested_end_exclusive,
                  source_config_fingerprint,
                  adapter_version,
                  deadline_at
                )
                VALUES ($1, 'scheduled', clock_timestamp(), clock_timestamp() + interval '1 minute', $2, 'test/v1', clock_timestamp() + interval '2 minutes')
              `,
              [currentSource.id, reanalysisSource.source_config_fingerprint],
            ),
          hasDatabaseCode("23503"),
        );
        await assert.rejects(
          () =>
            insertRawRecord(pool, {
              firstRunId: currentFirstRunId,
              lastRunId: currentFirstRunId,
              providerMetadata: { unrecognized: true },
              sourceId: currentSource.id,
              sourceKind: "model_current",
              validAt: "2026-08-20T04:00:00.000Z",
            }),
          hasDatabaseCode("23514"),
        );
      });

      // verify record provenance composite FKs
      await context.test("I-DB-12 record kind and run linkage cannot cross sources", async () => {
        await assert.rejects(
          () =>
            insertRawRecord(pool, {
              firstRunId: currentFirstRunId,
              lastRunId: currentFirstRunId,
              sourceId: currentSource.id,
              sourceKind: "reanalysis",
              validAt: "2026-08-20T02:00:00.000Z",
            }),
          hasDatabaseCode("23503"),
        );
        await assert.rejects(
          () =>
            insertRawRecord(pool, {
              firstRunId: backfillRunId,
              lastRunId: backfillRunId,
              sourceId: currentSource.id,
              sourceKind: "model_current",
              validAt: "2026-08-20T03:00:00.000Z",
            }),
          hasDatabaseCode("23503"),
        );
      });

      // verify forecast identity requirements and separation
      await context.test("I-DB-13 and I-DB-15 forecast product runs are required and distinguishable", async () => {
        const forecastSource = await createForecastSource(pool, bootstrap);
        const forecastSession = await requireSession(pool, forecastSource.id);

        try {
          const run = await createRun(
            forecastSession,
            forecastSource,
            "scheduled",
            "2026-08-20T06:00:00.000Z",
            "2026-08-20T07:00:00.000Z",
          );
          await assert.rejects(
            () =>
              insertRawRecord(pool, {
                firstRunId: run.id,
                lastRunId: run.id,
                productRunAt: null,
                sourceId: forecastSource.id,
                sourceKind: "forecast",
                validAt: "2026-08-20T06:00:00.000Z",
              }),
            hasDatabaseCode("23514"),
          );
          await completeScheduledIngestion(forecastSession, {
            attempts: 1,
            expectedCheckpointVersion: null,
            lastValidAt: "2026-08-20T06:00:00.000Z",
            providerCursor: null,
            records: [
              makeRecord(
                forecastSource.id,
                "forecast",
                "2026-08-20T06:00:00.000Z",
                { productRunAt: "2026-08-20T00:00:00.000Z" },
              ),
              makeRecord(
                forecastSource.id,
                "forecast",
                "2026-08-20T06:00:00.000Z",
                { productRunAt: "2026-08-20T01:00:00.000Z" },
              ),
            ],
            runId: run.id,
            windowEndExclusive: "2026-08-20T07:00:00.000Z",
            windowStart: "2026-08-20T06:00:00.000Z",
          });
          const rows = await pool.query(
            "SELECT product_run_at FROM weather_records WHERE source_id = $1 ORDER BY product_run_at",
            [forecastSource.id],
          );
          assert.equal(rows.rowCount, 2);
        } finally {
          await forecastSession.release();
        }
      });

      // verify retry and revision semantics
      await context.test("I-DB-14 identical retry preserves first linkage and revisions increment only on change", async () => {
        const retrySession = await requireSession(pool, currentSource.id);

        try {
          const retry = await createRun(
            retrySession,
            currentSource,
            "scheduled",
            "2026-08-20T00:15:00.000Z",
            "2026-08-20T00:30:00.000Z",
          );
          await completeScheduledIngestion(retrySession, {
            attempts: 1,
            expectedCheckpointVersion: 1,
            lastValidAt: "2026-08-20T00:00:00.000Z",
            providerCursor: { dataset: "current" },
            records: [
              makeRecord(
                currentSource.id,
                "model_current",
                "2026-08-20T00:00:00.000Z",
                { receivedAt: "2026-08-20T00:06:00.000Z" },
              ),
            ],
            runId: retry.id,
            windowEndExclusive: "2026-08-20T00:30:00.000Z",
            windowStart: "2026-08-20T00:15:00.000Z",
          });
          const identical = await pool.query(
            "SELECT first_ingestion_run_id, last_ingestion_run_id, revision_count FROM weather_records WHERE source_id = $1 AND valid_at = '2026-08-20T00:00:00.000Z'",
            [currentSource.id],
          );
          assert.equal(identical.rows[0].first_ingestion_run_id, currentFirstRunId);
          assert.equal(identical.rows[0].last_ingestion_run_id, retry.id);
          assert.equal(identical.rows[0].revision_count, 0);

          const revised = await createRun(
            retrySession,
            currentSource,
            "scheduled",
            "2026-08-20T00:30:00.000Z",
            "2026-08-20T00:45:00.000Z",
          );
          await completeScheduledIngestion(retrySession, {
            attempts: 1,
            expectedCheckpointVersion: 2,
            lastValidAt: "2026-08-20T00:00:00.000Z",
            providerCursor: { dataset: "current" },
            records: [
              makeRecord(
                currentSource.id,
                "model_current",
                "2026-08-20T00:00:00.000Z",
                { receivedAt: "2026-08-20T00:07:00.000Z", temperatureC: 12 },
              ),
            ],
            runId: revised.id,
            windowEndExclusive: "2026-08-20T00:45:00.000Z",
            windowStart: "2026-08-20T00:30:00.000Z",
          });
          const changed = await pool.query(
            "SELECT first_ingestion_run_id, last_ingestion_run_id, revision_count, temperature_c FROM weather_records WHERE source_id = $1 AND valid_at = '2026-08-20T00:00:00.000Z'",
            [currentSource.id],
          );
          assert.equal(changed.rows[0].first_ingestion_run_id, currentFirstRunId);
          assert.equal(changed.rows[0].last_ingestion_run_id, revised.id);
          assert.equal(changed.rows[0].revision_count, 1);
          assert.equal(changed.rows[0].temperature_c, 12);
          await assert.rejects(
            () =>
              pool.query(
                "UPDATE weather_records SET first_ingestion_run_id = $1 WHERE source_id = $2 AND valid_at = '2026-08-20T00:00:00.000Z'",
                [revised.id, currentSource.id],
              ),
            hasDatabaseCode("23514"),
          );
        } finally {
          await retrySession.release();
        }
      });

      // verify current/history index availability
      await context.test("I-DB-16 representative current lookup uses the source-time index", async () => {
        await pool.query(
          `
            INSERT INTO weather_records (
              source_id,
              source_kind,
              valid_at,
              first_ingestion_run_id,
              last_ingestion_run_id,
              first_received_at,
              last_received_at,
              upstream_timezone,
              temperature_c,
              content_hash
            )
            SELECT
              $1,
              'model_current',
              '2020-01-01T00:00:00.000Z'::timestamptz + generated * interval '1 hour',
              $2,
              $2,
              '2020-01-01T00:05:00.000Z'::timestamptz + generated * interval '1 hour',
              '2020-01-01T00:05:00.000Z'::timestamptz + generated * interval '1 hour',
              'UTC',
              10,
              md5(generated::text) || md5(generated::text)
            FROM generate_series(1, 2000) AS generated
            ON CONFLICT ON CONSTRAINT weather_records_identity_key DO NOTHING
          `,
          [currentSource.id, currentFirstRunId],
        );
        await pool.query("ANALYZE weather_records");
        const plan = await pool.query(
          "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT * FROM weather_records WHERE source_id = $1 ORDER BY valid_at DESC, id DESC LIMIT 10",
          [currentSource.id],
        );
        assert.match(
          plan.rows.map((row) => row["QUERY PLAN"]).join("\n"),
          /weather_records_(?:current|source_valid)_idx/u,
        );
      });

      // verify committed running visibility
      await context.test("I-DB-17 committed pre-fetch run is visible to another session", async () => {
        const session = await requireSession(pool, currentSource.id);

        try {
          const run = await createRun(session, currentSource, "scheduled");
          const visible = await pool.query(
            "SELECT state FROM ingestion_runs WHERE id = $1",
            [run.id],
          );
          assert.equal(visible.rows[0].state, "running");
          await failIngestionRun(session, {
            attempts: 1,
            error: testError("probe_failed"),
            runId: run.id,
          });
        } finally {
          await session.release();
        }
      });

      // verify scheduled atomic final state
      await context.test("I-DB-18 scheduled records checkpoint and run finalize atomically", async () => {
        const state = await pool.query(
          `
            SELECT
              run.state,
              checkpoint.version,
              (SELECT count(*)::integer FROM weather_records WHERE source_id = $1) AS records
            FROM ingestion_runs run
            JOIN ingestion_checkpoints checkpoint ON checkpoint.source_id = run.source_id
            WHERE run.id = $2
          `,
          [currentSource.id, currentFirstRunId],
        );
        assert.equal(state.rows[0].state, "succeeded");
        assert.equal(state.rows[0].version >= 1, true);
        assert.equal(state.rows[0].records >= 1, true);
      });

      // verify backfill atomic final state
      await context.test("I-DB-19 backfill records exact outcome and run finalize atomically", async () => {
        const state = await pool.query(
          `
            SELECT run.state, outcome.outcome
            FROM ingestion_runs run
            JOIN backfill_chunk_outcomes outcome ON outcome.ingestion_run_id = run.id
            WHERE run.id = $1
          `,
          [backfillRunId],
        );
        assert.deepEqual(state.rows[0], {
          outcome: "succeeded",
          state: "succeeded",
        });
      });

      // verify rollback after record write
      await context.test("I-DB-20 stale checkpoint fault rolls back rows and finalization", async () => {
        const session = await requireSession(pool, currentSource.id);
        const validAt = "2026-08-20T08:00:00.000Z";

        try {
          const run = await createRun(
            session,
            currentSource,
            "scheduled",
            validAt,
            "2026-08-20T08:15:00.000Z",
          );
          await assert.rejects(
            () =>
              completeScheduledIngestion(session, {
                attempts: 1,
                expectedCheckpointVersion: 999,
                lastValidAt: validAt,
                providerCursor: null,
                records: [makeRecord(currentSource.id, "model_current", validAt)],
                runId: run.id,
                windowEndExclusive: "2026-08-20T08:15:00.000Z",
                windowStart: validAt,
              }),
            /checkpoint compare-and-set/u,
          );
          const state = await pool.query(
            `
              SELECT
                (SELECT count(*)::integer FROM weather_records WHERE source_id = $1 AND valid_at = $2) AS records,
                (SELECT state FROM ingestion_runs WHERE id = $3) AS run_state
            `,
            [currentSource.id, validAt, run.id],
          );
          assert.deepEqual(state.rows[0], { records: 0, run_state: "running" });
          await failIngestionRun(session, {
            attempts: 1,
            error: testError("checkpoint_conflict"),
            runId: run.id,
          });
        } finally {
          await session.release();
        }
      });

      // verify failure preserves last-good state
      await context.test("I-DB-21 provider failure preserves records and checkpoint", async () => {
        const session = await requireSession(pool, currentSource.id);
        const before = await operationalCounts(pool, currentSource.id);

        try {
          const run = await createRun(session, currentSource, "scheduled");
          await failIngestionRun(session, {
            attempts: 3,
            error: testError("provider_unavailable"),
            runId: run.id,
          });
          const after = await operationalCounts(pool, currentSource.id);
          const state = await pool.query(
            "SELECT state, error_code FROM ingestion_runs WHERE id = $1",
            [run.id],
          );
          assert.deepEqual(after, before);
          assert.deepEqual(state.rows[0], {
            error_code: "provider_unavailable",
            state: "failed",
          });
        } finally {
          await session.release();
        }
      });

      // verify stale recovery after lock release
      await context.test("I-DB-22 released session permits deadline-based abandonment", async () => {
        const first = await requireSession(pool, currentSource.id);
        const run = await createRun(first, currentSource, "scheduled");
        await pool.query(
          "UPDATE ingestion_runs SET started_at = clock_timestamp() - interval '2 minutes', deadline_at = clock_timestamp() - interval '1 minute' WHERE id = $1",
          [run.id],
        );
        await first.release();
        const recovered = await requireSession(pool, currentSource.id);

        try {
          const abandoned = await abandonExpiredRuns(
            recovered,
            new Date().toISOString(),
          );
          assert.deepEqual(abandoned, [run.id]);
          const state = await pool.query(
            "SELECT state FROM ingestion_runs WHERE id = $1",
            [run.id],
          );
          assert.equal(state.rows[0].state, "abandoned");
        } finally {
          await recovered.release();
        }
      });

      // verify lock exclusion and non-expired protection
      await context.test("I-DB-23 active lock excludes a second worker and live run is not recovered", async () => {
        const first = await requireSession(pool, currentSource.id);
        let run;

        try {
          assert.equal(await acquireSourceSession(pool, currentSource.id), null);
          run = await createRun(first, currentSource, "scheduled");
          assert.deepEqual(
            await abandonExpiredRuns(first, new Date().toISOString()),
            [],
          );
        } finally {
          await first.release();
        }

        const recovered = await requireSession(pool, currentSource.id);

        try {
          await assert.rejects(
            () => createRun(recovered, currentSource, "scheduled"),
            /already has a running ingestion/u,
          );
          await failIngestionRun(recovered, {
            attempts: 1,
            error: testError("test_cleanup"),
            runId: run.id,
          });
        } finally {
          await recovered.release();
        }
      });

      // verify exact six-part resume behavior
      await context.test("I-DB-24 only exact successful chunks are skipped", async () => {
        assert.equal(
          await hasSuccessfulBackfillChunk(pool, successfulBackfillIdentity),
          true,
        );
        const changedIdentities = [
          { ...successfulBackfillIdentity, adapterVersion: "archive/v2" },
          { ...successfulBackfillIdentity, chunkPlanVersion: "archive-hourly/v2" },
          { ...successfulBackfillIdentity, sourceConfigFingerprint: "b".repeat(64) },
          { ...successfulBackfillIdentity, intervalEndExclusive: "2026-08-20T02:00:00.000Z" },
        ];

        // reject every changed identity from skip
        for (const identity of changedIdentities) {
          assert.equal(await hasSuccessfulBackfillChunk(pool, identity), false);
        }

        const failedSession = await requireSession(pool, reanalysisSource.id);

        try {
          const failedIdentity = makeChunkIdentity(
            reanalysisSource,
            "2026-08-21T00:00:00.000Z",
            "2026-08-21T01:00:00.000Z",
          );
          const run = await createRun(
            failedSession,
            reanalysisSource,
            "backfill",
            failedIdentity.intervalStart,
            failedIdentity.intervalEndExclusive,
          );
          await assert.rejects(
            () =>
              completeBackfillIngestion(failedSession, {
                attempts: 1,
                identity: {
                  ...failedIdentity,
                  intervalEndExclusive: "2026-08-21T02:00:00.000Z",
                },
                records: [],
                runId: run.id,
              }),
            /backfill run identity check/u,
          );
          await failIngestionRun(failedSession, {
            attempts: 1,
            backfillIdentity: failedIdentity,
            error: testError("chunk_failed"),
            runId: run.id,
          });
          assert.equal(await hasSuccessfulBackfillChunk(pool, failedIdentity), false);
          await assert.rejects(
            () =>
              pool.query(
                `
                  UPDATE backfill_chunk_outcomes
                  SET source_id = $1
                  WHERE ingestion_run_id = $2
                `,
                [currentSource.id, run.id],
              ),
            hasDatabaseCode("23503"),
          );
        } finally {
          await failedSession.release();
        }

        const preservedSession = await requireSession(pool, reanalysisSource.id);

        try {
          const run = await createRun(
            preservedSession,
            reanalysisSource,
            "backfill",
            successfulBackfillIdentity.intervalStart,
            successfulBackfillIdentity.intervalEndExclusive,
          );
          await failIngestionRun(preservedSession, {
            attempts: 1,
            backfillIdentity: successfulBackfillIdentity,
            error: testError("later_retry_failed"),
            runId: run.id,
          });
          assert.equal(
            await hasSuccessfulBackfillChunk(pool, successfulBackfillIdentity),
            true,
          );
        } finally {
          await preservedSession.release();
        }
      });

      // verify checkpoint compare-and-set conflict protection
      await context.test("I-DB-25 stale checkpoint cannot overwrite newer state", async () => {
        const session = await requireSession(pool, currentSource.id);

        try {
          const initial = await getScheduledCheckpoint(session);
          assert.ok(initial);
          const priorVersion = initial.version;
          const winning = await createRun(
            session,
            currentSource,
            "scheduled",
            "2026-08-20T09:00:00.000Z",
            "2026-08-20T09:15:00.000Z",
          );
          await completeScheduledIngestion(session, {
            attempts: 1,
            expectedCheckpointVersion: priorVersion,
            lastValidAt: "2026-08-20T09:00:00.000Z",
            providerCursor: null,
            records: [
              makeRecord(currentSource.id, "model_current", "2026-08-20T09:00:00.000Z"),
            ],
            runId: winning.id,
            windowEndExclusive: "2026-08-20T09:15:00.000Z",
            windowStart: "2026-08-20T09:00:00.000Z",
          });
          const stale = await createRun(
            session,
            currentSource,
            "scheduled",
            "2026-08-20T10:00:00.000Z",
            "2026-08-20T10:15:00.000Z",
          );
          await assert.rejects(
            () =>
              completeScheduledIngestion(session, {
                attempts: 1,
                expectedCheckpointVersion: priorVersion,
                lastValidAt: "2026-08-20T10:00:00.000Z",
                providerCursor: null,
                records: [
                  makeRecord(currentSource.id, "model_current", "2026-08-20T10:00:00.000Z"),
                ],
                runId: stale.id,
                windowEndExclusive: "2026-08-20T10:15:00.000Z",
                windowStart: "2026-08-20T10:00:00.000Z",
              }),
            /checkpoint compare-and-set/u,
          );
          const checkpoint = await getScheduledCheckpoint(session);
          assert.ok(checkpoint);
          assert.equal(checkpoint.version, priorVersion + 1);
          assert.equal(
            checkpoint.lastValidAt,
            "2026-08-20T09:00:00.000Z",
          );
          await failIngestionRun(session, {
            attempts: 1,
            error: testError("stale_checkpoint"),
            runId: stale.id,
          });
        } finally {
          await session.release();
        }
      });

      // verify heartbeat success independence
      await context.test("I-DB-26 heartbeat loop freshness is independent from last success", async () => {
        await updateWorkerHeartbeat(pool, {
          activity: "scheduled",
          instance: "worker-main",
          lastLoopAt: "2026-08-20T11:00:00.000Z",
          lastSuccessAt: "2026-08-20T10:00:00.000Z",
          version: "worker/v1",
        });
        await updateWorkerHeartbeat(pool, {
          activity: "idle",
          instance: "worker-main",
          lastLoopAt: "2026-08-20T11:15:00.000Z",
          lastSuccessAt: "2026-08-20T10:00:00.000Z",
          version: "worker/v1",
        });
        const heartbeat = await pool.query(
          "SELECT last_loop_at, last_success_at, current_activity FROM worker_heartbeats WHERE worker_instance = 'worker-main'",
        );
        assert.equal(
          heartbeat.rows[0].last_loop_at.toISOString(),
          "2026-08-20T11:15:00.000Z",
        );
        assert.equal(
          heartbeat.rows[0].last_success_at.toISOString(),
          "2026-08-20T10:00:00.000Z",
        );
        assert.equal(heartbeat.rows[0].current_activity, "idle");
      });
    } finally {
      await Promise.all([pool.end(), adminPool.end()]);
      await stopPostgres(server);
    }
  },
);

// match PostgreSQL error codes
function hasDatabaseCode(code) {
  // inspect structured database errors
  return (error) => error?.code === code;
}

// execute the real first-init role boundary
async function runRuntimeRoleBootstrap(server) {
  const directory = await mkdtemp(join(tmpdir(), "weather-role-secrets-"));
  const adminPath = join(directory, "admin");
  const ownerPath = join(directory, "owner");
  const apiPath = join(directory, "api");
  const ingestPath = join(directory, "ingest");

  try {
    await Promise.all([
      writeFile(adminPath, "admin-test\n", { mode: 0o600 }),
      writeFile(ownerPath, "owner-test\n", { mode: 0o600 }),
      writeFile(apiPath, "api-test\n", { mode: 0o600 }),
      writeFile(ingestPath, "ingest-test\n", { mode: 0o600 }),
    ]);
    await executeFile(
      join(repositoryRoot, "deploy/postgres/010-create-runtime-roles.sh"),
      [],
      {
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
      },
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// require a retained source session
async function requireSession(pool, sourceId) {
  const session = await acquireSourceSession(pool, sourceId);

  // reject unexpected lock contention
  if (session === null) {
    throw new Error(`could not acquire source session for ${sourceId}`);
  }

  return session;
}

// create a committed running row
async function createRun(
  session,
  source,
  mode,
  requestedStart = "2026-08-22T00:00:00.000Z",
  requestedEndExclusive = "2026-08-22T01:00:00.000Z",
) {
  return startIngestionRun(session, {
    adapterVersion: mode === "backfill" ? "archive/v1" : "current/v1",
    chunkPlanVersion: mode === "backfill" ? "archive-hourly/v1" : null,
    deadlineAt: new Date(Date.now() + 120_000).toISOString(),
    mode,
    requestedEndExclusive,
    requestedStart,
    sourceConfigFingerprint: source.source_config_fingerprint,
  });
}

// create a normalized test record
function makeRecord(sourceId, sourceKind, validAt, overrides = {}) {
  return createNormalizedWeatherRecord({
    metadata: {
      device: null,
      model: "test-grid/v1",
      provider: { dataset: "integration" },
      quality: { status: "validated" },
      upstreamTimezone: "America/Los_Angeles",
    },
    metrics: {
      apparentTemperatureC: 9,
      cloudCoverPercent: 50,
      precipitationMm: 0,
      pressureHpa: 1013,
      relativeHumidityPercent: 70,
      temperatureC: overrides.temperatureC ?? 10,
      windDirectionDegrees: 180,
      windGustMps: 7,
      windSpeedMps: 4,
    },
    productRunAt: overrides.productRunAt ?? null,
    receivedAt: overrides.receivedAt ?? "2026-08-20T00:05:00.000Z",
    sourceId,
    sourceKind,
    validAt,
  });
}

// create an exact chunk identity
function makeChunkIdentity(source, intervalStart, intervalEndExclusive) {
  return {
    adapterVersion: "archive/v1",
    chunkPlanVersion: "archive-hourly/v1",
    intervalEndExclusive,
    intervalStart,
    requestedFromDate: intervalStart.slice(0, 10),
    requestedToDate: intervalStart.slice(0, 10),
    sourceConfigFingerprint: source.source_config_fingerprint,
    sourceId: source.id,
  };
}

// create a bounded failure
function testError(code) {
  return {
    classification: "retryable",
    code,
    message: `integration failure: ${code}`,
  };
}

// insert a raw row for constraint tests
async function insertRawRecord(pool, input) {
  return pool.query(
    `
      INSERT INTO weather_records (
        source_id,
        source_kind,
        valid_at,
        product_run_at,
        first_ingestion_run_id,
        last_ingestion_run_id,
        first_received_at,
        last_received_at,
        upstream_timezone,
        provider_metadata,
        content_hash
      )
      VALUES ($1, $2, $3, $4, $5, $6, $3, $3, 'UTC', $7::jsonb, $8)
    `,
    [
      input.sourceId,
      input.sourceKind,
      input.validAt,
      input.productRunAt ?? null,
      input.firstRunId,
      input.lastRunId,
      input.providerMetadata === undefined
        ? null
        : JSON.stringify(input.providerMetadata),
      "c".repeat(64),
    ],
  );
}

// add one future forecast source
async function createForecastSource(pool, bootstrap) {
  const result = await pool.query(
    `
      INSERT INTO sources (
        station_id,
        provider_id,
        source_key,
        source_kind,
        material_provider_config,
        source_config_fingerprint,
        capabilities,
        cadence_seconds,
        active
      )
      VALUES ($1, $2, 'forecast-test-v1', 'forecast', '{"contract":"forecast/v1"}'::jsonb, $3, '["forecast"]'::jsonb, 3600, true)
      RETURNING id, source_kind, source_config_fingerprint
    `,
    [bootstrap.stationId, bootstrap.providerId, "d".repeat(64)],
  );

  return result.rows[0];
}

// snapshot record and checkpoint state
async function operationalCounts(pool, sourceId) {
  const result = await pool.query(
    `
      SELECT
        (SELECT count(*)::integer FROM weather_records WHERE source_id = $1) AS records,
        (SELECT version FROM ingestion_checkpoints WHERE source_id = $1) AS checkpoint_version
    `,
    [sourceId],
  );

  return result.rows[0];
}
