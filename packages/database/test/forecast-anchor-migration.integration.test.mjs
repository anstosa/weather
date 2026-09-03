import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runMigrations } from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const migrationDirectory = join(repositoryRoot, "packages/database/migrations");
const legacyMigrationNames = [
  "0001_initial_weather.sql",
  "0002_worker_migration_readiness.sql",
  "0003_ecowitt_measurements.sql",
  "0004_tempest_metadata.sql",
  "0005_source_supersession.sql",
  "0006_station_coordinates.sql",
  "0007_tide_sources.sql",
  "0008_ecowitt_property_sensors.sql",
];

// preserve raw v4 storage through the additive upgrade
test("0009 upgrades an existing v4 database without rewriting live forecast rows", {
  timeout: 300_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-anchor-upgrade-"));
  const legacyDirectory = join(directory, "migrations");
  const server = await startPostgres(17, "anchor-upgrade");
  const pool = createTestPool(server);

  // run one disposable upgrade proof
  try {
    await mkdir(legacyDirectory);

    // copy the immutable previous-image migration set
    for (const migrationName of legacyMigrationNames) {
      await copyFile(
        join(migrationDirectory, migrationName),
        join(legacyDirectory, migrationName),
      );
    }

    await createRuntimeRoles(pool);
    const legacy = await runMigrations(pool, legacyDirectory);
    assert.deepEqual(legacy.applied, legacyMigrationNames);
    const fixture = await pool.query(`
      WITH inserted_site AS (
        INSERT INTO sites (slug, display_name, latitude, longitude, timezone)
        VALUES ('upgrade-site', 'Upgrade site', 47.95, -122.43, 'UTC')
        RETURNING id
      ), inserted_provider AS (
        INSERT INTO providers (provider_key, display_name, attribution_label, attribution_url)
        VALUES ('upgrade-provider', 'Upgrade provider', 'Upgrade provider', 'https://example.com')
        RETURNING id
      ), inserted_station AS (
        INSERT INTO stations (
          site_id,
          slug,
          display_name,
          station_kind,
          latitude,
          longitude
        )
        SELECT id, 'upgrade-virtual', 'Upgrade virtual', 'virtual', 47.95, -122.43
        FROM inserted_site
        RETURNING id
      ), inserted_source AS (
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
        SELECT
          inserted_station.id,
          inserted_provider.id,
          'open-meteo-forecast-v4-upgrade',
          'forecast',
          '{"contractVersion":"forecast-daily/v4"}'::jsonb,
          repeat('a', 64),
          '["forecast"]'::jsonb,
          3600,
          true
        FROM inserted_station, inserted_provider
        RETURNING id, source_config_fingerprint
      ), inserted_run AS (
        INSERT INTO ingestion_runs (
          source_id,
          mode,
          requested_start,
          requested_end_exclusive,
          source_config_fingerprint,
          adapter_version,
          started_at,
          deadline_at,
          completed_at,
          state,
          attempts,
          record_count
        )
        SELECT
          id,
          'scheduled',
          '2026-08-01T00:00:00Z',
          '2026-08-01T01:00:00Z',
          source_config_fingerprint,
          'forecast-daily/v4',
          '2026-08-01T00:00:00Z',
          '2026-08-01T00:05:00Z',
          '2026-08-01T00:01:00Z',
          'succeeded',
          1,
          1
        FROM inserted_source
        RETURNING id, source_id
      )
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
        upstream_model,
        provider_metadata,
        temperature_c,
        content_hash
      )
      SELECT
        source_id,
        'forecast',
        '2026-08-01T02:00:00Z',
        '2026-08-01T00:00:00Z',
        id,
        id,
        '2026-08-01T00:01:00Z',
        '2026-08-01T00:01:00Z',
        'UTC',
        'best_match',
        '{"dataset":"forecast"}'::jsonb,
        12.5,
        repeat('b', 64)
      FROM inserted_run
      RETURNING id
    `);
    const before = await pool.query(
      "SELECT to_jsonb(weather_records) AS record FROM weather_records WHERE id = $1",
      [fixture.rows[0].id],
    );
    const upgraded = await runMigrations(pool, migrationDirectory);
    const after = await pool.query(
      "SELECT to_jsonb(weather_records) AS record FROM weather_records WHERE id = $1",
      [fixture.rows[0].id],
    );

    assert.deepEqual(upgraded.current, legacyMigrationNames);
    assert.deepEqual(upgraded.applied, [
      "0009_forecast_anchor_records.sql",
      "0010_forecast_training_export.sql",
      "0011_forecast_runtime_provenance.sql",
      "0012_hide_archive_only_forecasts_from_live_reads.sql",
    ]);
    assert.deepEqual(after.rows[0].record, before.rows[0].record);
    assert.equal(
      (
        await pool.query(
          "SELECT to_regclass('public.forecast_anchor_records') AS anchor_table",
        )
      ).rows[0].anchor_table,
      "forecast_anchor_records",
    );
    assert.deepEqual(
      (
        await pool.query(`
          SELECT column_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'forecast_anchor_records'
            AND column_name = ANY(ARRAY['product_run_at', 'reference_at', 'run_at'])
          ORDER BY column_name
        `)
      ).rows,
      [],
    );
  } finally {
    // clean disposable upgrade resources
    await pool.end();
    await stopPostgres(server);
    await rm(directory, { force: true, recursive: true });
  }
});
