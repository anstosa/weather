import assert from "node:assert/strict";
import { once } from "node:events";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  bootstrapSiteConfiguration,
  loadSiteConfiguration,
  runMigrations,
} from "@weather/database";

import {
  createDatabaseWeatherReadStore,
  createWeatherApi,
  createWeatherApiServer,
} from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "../../../packages/database/test/postgres-harness.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = join(repositoryRoot, "packages/database/migrations");
const siteConfigurationPath = join(repositoryRoot, "config/sites/ballydidean.json");

test("real PostgreSQL serves active versioned API reads and exact readiness", { timeout: 300_000 }, async (context) => {
  const postgres = await startPostgres(17, "api");
  const admin = createTestPool(postgres);
  let apiPool;
  let server;

  try {
    await createRuntimeRoles(admin);
    await runMigrations(admin, migrationDirectory);
    const configuration = await loadSiteConfiguration(siteConfigurationPath);
    await bootstrapSiteConfiguration(admin, configuration);
    const sources = await admin.query(
      "SELECT id, source_kind, source_config_fingerprint FROM sources ORDER BY source_kind",
    );
    const currentSource = sources.rows.find(
      // select the current source
      (source) => source.source_kind === "model_current",
    );
    const historySource = sources.rows.find(
      // select the history source
      (source) => source.source_kind === "reanalysis",
    );

    assert.ok(currentSource);
    assert.ok(historySource);
    const currentRun = await insertSucceededRun(admin, currentSource, "scheduled");
    const historyRun = await insertSucceededRun(admin, historySource, "backfill");
    await insertRecord(admin, currentSource, currentRun, {
      idSuffix: "current-new",
      temperatureC: 16.2,
      validAt: "2026-08-22T04:50:00.000Z",
    });
    await insertRecord(admin, currentSource, currentRun, {
      idSuffix: "current-old",
      temperatureC: 15.8,
      validAt: "2026-08-22T03:50:00.000Z",
    });
    await insertRecord(admin, historySource, historyRun, {
      idSuffix: "history-tied",
      temperatureC: 14.9,
      validAt: "2026-08-22T04:50:00.000Z",
    });
    await admin.query(
      `
        INSERT INTO worker_heartbeats (
          worker_instance,
          last_loop_at,
          last_success_at,
          current_activity,
          worker_version
        )
        VALUES ('api-integration', '2026-08-22T04:55:00.000Z', '2026-08-22T04:50:00.000Z', 'idle', 'test/v1')
      `,
    );
    await insertInactiveMetadata(admin);

    apiPool = createTestPool(postgres, "weather_test", "weather_api", "api-test");
    const store = createDatabaseWeatherReadStore(apiPool, { migrationDirectory });
    const handler = createWeatherApi(store, {
      now: () => new Date("2026-08-22T05:00:00.000Z"),
      version: "integration/v1",
    });
    server = createWeatherApiServer(handler);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${String(address.port)}`;

    await context.test("sites omit every inactive entity", async () => {
      const response = await fetch(`${origin}/api/v1/sites`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.data.map((site) => site.slug), ["ballydidean"]);
      assert.equal(body.data[0].stations.length, 1);
      assert.equal(body.data[0].stations[0].sources.length, 2);
      assert.doesNotMatch(JSON.stringify(body), /inactive|material_provider_config/u);
    });

    await context.test("current filters active station and source", async () => {
      const response = await fetch(
        `${origin}/api/v1/sites/ballydidean/current?station=open-meteo-virtual&source=${String(currentSource.id)}`,
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.data.length, 1);
      assert.equal(body.data[0].metrics.temperatureC, 16.2);
      assert.equal(body.data[0].metadata.upstream.model, "best_match");
      assert.equal(body.data[0].metadata.provider.dataset, "integration");
      assert.equal(body.data[0].metadata.provider.requestId, undefined);
    });

    await context.test("history filters and cursor pages are stable and complete", async () => {
      const pagedIds = [];
      let cursor;

      // traverse the complete stable cursor sequence
      do {
        const cursorQuery = cursor === undefined
          ? ""
          : `&cursor=${encodeURIComponent(cursor)}`;
        const response = await fetch(
          `${origin}/api/v1/sites/ballydidean/history?limit=1${cursorQuery}`,
        );
        const page = await response.json();
        assert.equal(response.status, 200);
        assert.equal(page.data.length, 1);
        pagedIds.push(page.data[0].id);
        cursor = page.page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      assert.equal(pagedIds.length, 3);
      assert.equal(new Set(pagedIds).size, 3);

      const filteredResponse = await fetch(
        `${origin}/api/v1/sites/ballydidean/history?station=open-meteo-virtual&source=${String(historySource.id)}&sourceKind=reanalysis&from=2026-08-22T04%3A00%3A00Z&to=2026-08-22T05%3A00%3A00Z`,
      );
      const filtered = await filteredResponse.json();
      assert.equal(filteredResponse.status, 200);
      assert.equal(filtered.data.length, 1);
      assert.equal(filtered.data[0].provenance.sourceKind, "reanalysis");
    });

    await context.test("deactivated sources disappear from current and history", async () => {
      await admin.query("UPDATE sources SET active = false WHERE id = $1", [
        currentSource.id,
      ]);
      const currentResponse = await fetch(
        `${origin}/api/v1/sites/ballydidean/current`,
      );
      const currentBody = await currentResponse.json();
      const historyResponse = await fetch(
        `${origin}/api/v1/sites/ballydidean/history`,
      );
      const historyBody = await historyResponse.json();

      assert.equal(currentResponse.status, 200);
      assert.equal(
        currentBody.data.some((record) => record.provenance.sourceId === String(currentSource.id)),
        false,
      );
      assert.equal(
        historyBody.data.some((record) => record.provenance.sourceId === String(currentSource.id)),
        false,
      );
      await admin.query("UPDATE sources SET active = true WHERE id = $1", [
        currentSource.id,
      ]);
    });

    await context.test("health allows newer trailing migrations but rejects changed known history", async () => {
      const healthyResponse = await fetch(`${origin}/api/v1/health`);
      const healthy = await healthyResponse.json();
      assert.equal(healthyResponse.status, 200);
      assert.deepEqual(healthy.data.migration, {
        status: "current",
        version: "0002_worker_migration_readiness.sql",
      });
      assert.deepEqual(healthy.data.worker, { freshness: "fresh" });

      await admin.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        ["0003_future.sql", "1".repeat(64)],
      );
      const previousBinaryResponse = await fetch(`${origin}/api/v1/health`);
      const previousBinary = await previousBinaryResponse.json();
      assert.equal(previousBinaryResponse.status, 200);
      assert.deepEqual(previousBinary.data.migration, {
        status: "current",
        version: "0002_worker_migration_readiness.sql",
      });

      const ledger = await admin.query(
        "SELECT checksum FROM schema_migrations WHERE name = '0001_initial_weather.sql'",
      );
      await admin.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE name = '0001_initial_weather.sql'",
        ["0".repeat(64)],
      );
      const unhealthyResponse = await fetch(`${origin}/api/v1/health`);
      const unhealthy = await unhealthyResponse.json();
      assert.equal(unhealthyResponse.status, 503);
      assert.deepEqual(unhealthy.data.migration, {
        status: "outdated",
        version: null,
      });
      assert.doesNotMatch(JSON.stringify(unhealthy), /checksum|postgres|password|error/u);
      await admin.query(
        "UPDATE schema_migrations SET checksum = $1 WHERE name = '0001_initial_weather.sql'",
        [ledger.rows[0].checksum],
      );
      await admin.query(
        "DELETE FROM schema_migrations WHERE name = '0003_future.sql'",
      );
    });

    await context.test("API role cannot mutate stored data", async () => {
      await assert.rejects(
        () => apiPool.query("UPDATE sites SET display_name = 'denied'"),
        (error) => error?.code === "42501",
      );
    });
  } finally {
    // close the HTTP listener first
    if (server !== undefined) {
      server.close();
      await once(server, "close");
    }

    await Promise.all([
      apiPool?.end(),
      admin.end(),
    ]);
    await stopPostgres(postgres);
  }
});

// insert one finalized ingestion run
async function insertSucceededRun(pool, source, mode) {
  const result = await pool.query(
    `
      INSERT INTO ingestion_runs (
        source_id,
        mode,
        requested_start,
        requested_end_exclusive,
        source_config_fingerprint,
        adapter_version,
        chunk_plan_version,
        started_at,
        deadline_at,
        completed_at,
        state,
        attempts,
        record_count
      )
      VALUES (
        $1,
        $2,
        '2026-08-22T03:00:00.000Z',
        '2026-08-22T05:00:00.000Z',
        $3,
        'integration/v1',
        $4,
        '2026-08-22T04:00:00.000Z',
        '2026-08-22T05:10:00.000Z',
        '2026-08-22T04:55:00.000Z',
        'succeeded',
        1,
        2
      )
      RETURNING id
    `,
    [
      source.id,
      mode,
      source.source_config_fingerprint,
      mode === "backfill" ? "integration-plan/v1" : null,
    ],
  );
  return result.rows[0].id;
}

// insert one normalized integration record
async function insertRecord(pool, source, runId, input) {
  const contentHash = Buffer.from(input.idSuffix).toString("hex").padEnd(64, "0").slice(0, 64);
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
        upstream_model,
        device_vendor,
        device_model,
        quality_metadata,
        provider_metadata,
        temperature_c,
        content_hash
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $4,
        $3::timestamptz + interval '1 minute',
        $3::timestamptz + interval '1 minute',
        'America/Los_Angeles',
        'best_match',
        'Open-Meteo',
        'virtual-grid',
        '{"confidence_percent":93,"flags":["integration"],"status":"accepted"}'::jsonb,
        '{"dataset":"integration","elevation_m":17,"request_id":"private"}'::jsonb,
        $5,
        $6
      )
    `,
    [source.id, source.source_kind, input.validAt, runId, input.temperatureC, contentHash],
  );
}

// insert metadata that must never cross the active boundary
async function insertInactiveMetadata(pool) {
  await pool.query(
    `
      WITH inserted_site AS (
        INSERT INTO sites (slug, display_name, latitude, longitude, timezone, active)
        VALUES ('inactive-site', 'Inactive site', 47, -122, 'UTC', false)
        RETURNING id
      ),
      inserted_station AS (
        INSERT INTO stations (site_id, slug, display_name, station_kind, active)
        SELECT id, 'inactive-station', 'Inactive station', 'virtual', false
        FROM inserted_site
        RETURNING id
      ),
      inserted_provider AS (
        INSERT INTO providers (
          provider_key,
          display_name,
          attribution_label,
          attribution_url,
          active
        )
        VALUES ('inactive-provider', 'Inactive provider', 'Inactive', 'https://example.test/', false)
        RETURNING id
      )
      INSERT INTO sources (
        station_id,
        provider_id,
        source_key,
        source_kind,
        material_provider_config,
        source_config_fingerprint,
        capabilities,
        active
      )
      SELECT
        inserted_station.id,
        inserted_provider.id,
        'inactive-source',
        'model_current',
        '{}'::jsonb,
        $1,
        '["current"]'::jsonb,
        false
      FROM inserted_station, inserted_provider
    `,
    ["a".repeat(64)],
  );
}
