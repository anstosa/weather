import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  createNormalizedForecastAnchorRecord,
  createNormalizedWeatherRecord,
} from "@weather/domain";

import {
  acquireSourceSession,
  completeForecastAnchorBackfillIngestion,
  completeScheduledIngestion,
  failIngestionRun,
  getWeatherForecast,
  listForecastTrainingCohorts,
  runMigrations,
  startIngestionRun,
} from "../dist/index.js";
import {
  createRuntimeRoles,
  createTestPool,
  startPostgres,
  stopPostgres,
} from "./postgres-harness.mjs";

const migrationDirectory = resolve(
  import.meta.dirname,
  "../migrations",
);

// verify anchor lifecycle training cohorts and live-route isolation
test(
  "forecast-anchor repository lifecycle is atomic and provenance-separated",
  { timeout: 300_000 },
  async () => {
    const server = await startPostgres(17, "forecast-anchor-repository");
    const pool = createTestPool(server);
    let apiPool;

    try {
      await createRuntimeRoles(pool);
      await runMigrations(pool, migrationDirectory);
      const sources = await seedForecastSources(pool);
      const identity = anchorChunkIdentity(sources.anchor);
      const firstRun = await startBackfillRun(pool, sources.anchor, identity);

      await completeAnchorRun(
        pool,
        sources.anchor.id,
        firstRun.id,
        identity,
        [makeAnchor(sources.anchor, "2026-09-02T00:00:00.000Z", 24, 11)],
      );
      const secondRun = await startBackfillRun(pool, sources.anchor, identity);
      await completeAnchorRun(
        pool,
        sources.anchor.id,
        secondRun.id,
        identity,
        [
          makeAnchor(
            sources.anchor,
            "2026-09-02T00:00:00.000Z",
            24,
            11,
            "2026-09-01T00:10:00.000Z",
          ),
        ],
      );
      const changedRun = await startBackfillRun(pool, sources.anchor, identity);
      await completeAnchorRun(
        pool,
        sources.anchor.id,
        changedRun.id,
        identity,
        [
          makeAnchor(
            sources.anchor,
            "2026-09-02T00:00:00.000Z",
            24,
            12,
            "2026-09-01T00:20:00.000Z",
          ),
        ],
      );
      const stored = await pool.query(
        `
          SELECT
            first_ingestion_run_id,
            last_ingestion_run_id,
            revision_count,
            temperature_c,
            (SELECT state FROM ingestion_runs WHERE id = $1) AS run_state,
            (SELECT record_count FROM ingestion_runs WHERE id = $1) AS record_count,
            (
              SELECT upstream_response_checksum
              FROM ingestion_runs
              WHERE id = $1
            ) AS upstream_response_checksum,
            (
              SELECT ingestion_run_id
              FROM backfill_chunk_outcomes
              WHERE source_id = $2
            ) AS outcome_run_id
          FROM forecast_anchor_records
        `,
        [changedRun.id, sources.anchor.id],
      );

      assert.equal(stored.rowCount, 1);
      assert.equal(String(stored.rows[0].first_ingestion_run_id), firstRun.id);
      assert.equal(String(stored.rows[0].last_ingestion_run_id), changedRun.id);
      assert.equal(stored.rows[0].revision_count, 1);
      assert.equal(stored.rows[0].temperature_c, 12);
      assert.equal(stored.rows[0].run_state, "succeeded");
      assert.equal(stored.rows[0].record_count, 1);
      assert.equal(stored.rows[0].upstream_response_checksum, "c".repeat(64));
      assert.equal(String(stored.rows[0].outcome_run_id), changedRun.id);

      const conflictingRun = await startBackfillRun(pool, sources.anchor, identity);
      await assert.rejects(
        () =>
          completeAnchorRun(
            pool,
            sources.anchor.id,
            conflictingRun.id,
            identity,
            [
              makeAnchor(
                sources.anchor,
                "2026-09-02T00:00:00.000Z",
                24,
                13,
                "2026-09-01T00:30:00.000Z",
                "changed-epoch/2026-09",
              ),
            ],
          ),
        /did not persist every input row/u,
      );
      const rolledBack = await pool.query(
        `
          SELECT
            (SELECT revision_count FROM forecast_anchor_records) AS revision_count,
            (SELECT state FROM ingestion_runs WHERE id = $1) AS run_state,
            (SELECT count(*)::integer FROM backfill_chunk_outcomes) AS outcomes
        `,
        [conflictingRun.id],
      );

      assert.deepEqual(rolledBack.rows[0], {
        outcomes: 1,
        revision_count: 1,
        run_state: "running",
      });
      await failAnchorRun(
        pool,
        sources.anchor.id,
        conflictingRun.id,
        identity,
      );

      await storeScheduledForecast(pool, sources.v4, "2026-09-01T00:00:00.000Z");
      await storeScheduledForecast(
        pool,
        sources.anchor,
        "2026-09-01T01:00:00.000Z",
      );
      const cohorts = await listForecastTrainingCohorts(pool, {
        from: "2026-09-01T00:00:00.000Z",
        siteSlug: "ballydidean",
        to: "2026-09-03T00:00:00.000Z",
      });

      assert.equal(cohorts.fixedLeadAnchors.length, 1);
      assert.equal(cohorts.legacyV4RetrievalSnapshots.length, 1);
      assert.equal(cohorts.fixedLeadAnchors[0].cohort, "fixed_lead_anchor");
      assert.equal(
        cohorts.legacyV4RetrievalSnapshots[0].cohort,
        "legacy_v4_retrieval_snapshot",
      );

      apiPool = createTestPool(
        server,
        "weather_test",
        "weather_api",
        "api-test",
      );
      const liveRows = await getWeatherForecast(apiPool, {
        asOf: "2026-09-01T00:00:00.000Z",
        hours: 48,
        siteSlug: "ballydidean",
      });

      assert.equal(liveRows.length, 1);
      assert.equal(liveRows[0].sourceKey, "open-meteo-forecast-v4");
      await assert.rejects(
        () => apiPool.query("SELECT count(*) FROM forecast_anchor_records"),
        (error) => error?.code === "42501",
      );
    } finally {
      await Promise.all([
        apiPool?.end() ?? Promise.resolve(),
        pool.end(),
      ]);
      await stopPostgres(server);
    }
  },
);

// seed one live-v4 and one historical-only forecast source
async function seedForecastSources(pool) {
  const seeded = await pool.query(
    `
      WITH site AS (
        INSERT INTO sites (slug, display_name, latitude, longitude, timezone)
        VALUES ('ballydidean', 'Ballydidean', 47.950429954185445, -122.42797012608193, 'America/Los_Angeles')
        RETURNING id
      ), provider AS (
        INSERT INTO providers (
          provider_key,
          display_name,
          attribution_label,
          attribution_url
        )
        VALUES ('open-meteo', 'Open-Meteo', 'Weather data by Open-Meteo', 'https://open-meteo.com/')
        RETURNING id
      ), station AS (
        INSERT INTO stations (
          site_id,
          slug,
          display_name,
          station_kind,
          latitude,
          longitude
        )
        SELECT id, 'ballydidean-grid', 'Ballydidean Grid', 'virtual', 47.950429954185445, -122.42797012608193
        FROM site
        RETURNING id
      ), anchor AS (
        INSERT INTO sources (
          station_id,
          provider_id,
          source_key,
          source_kind,
          material_provider_config,
          source_config_fingerprint,
          capabilities,
          cadence_seconds
        )
        SELECT
          station.id,
          provider.id,
          'open-meteo-previous-runs-v1',
          'forecast',
          '{"contractVersion":"previous-runs/v1"}'::jsonb,
          repeat('a', 64),
          '["historical"]'::jsonb,
          NULL
        FROM station, provider
        RETURNING id, source_config_fingerprint
      ), v4 AS (
        INSERT INTO sources (
          station_id,
          provider_id,
          source_key,
          source_kind,
          material_provider_config,
          source_config_fingerprint,
          capabilities,
          cadence_seconds
        )
        SELECT
          station.id,
          provider.id,
          'open-meteo-forecast-v4',
          'forecast',
          '{"contractVersion":"forecast-daily/v4"}'::jsonb,
          repeat('b', 64),
          '["forecast"]'::jsonb,
          3600
        FROM station, provider
        RETURNING id, source_config_fingerprint
      )
      SELECT
        anchor.id AS anchor_id,
        anchor.source_config_fingerprint AS anchor_fingerprint,
        v4.id AS v4_id,
        v4.source_config_fingerprint AS v4_fingerprint
      FROM anchor, v4
    `,
  );
  const row = seeded.rows[0];

  return {
    anchor: {
      fingerprint: row.anchor_fingerprint,
      id: String(row.anchor_id),
    },
    v4: {
      fingerprint: row.v4_fingerprint,
      id: String(row.v4_id),
    },
  };
}

// create one exact anchor chunk identity
function anchorChunkIdentity(source) {
  return {
    adapterVersion: "open-meteo-previous-runs/v1",
    chunkPlanVersion: "open-meteo-previous-runs/v1",
    intervalEndExclusive: "2026-09-03T00:00:00.000Z",
    intervalStart: "2026-09-01T00:00:00.000Z",
    requestedFromDate: "2026-09-01",
    requestedToDate: "2026-09-02",
    sourceConfigFingerprint: source.fingerprint,
    sourceId: source.id,
  };
}

// start one exact backfill run under its source lock
async function startBackfillRun(pool, source, identity) {
  const session = await acquireSourceSession(pool, source.id);
  assert.ok(session);

  try {
    return await startIngestionRun(session, {
      adapterVersion: identity.adapterVersion,
      chunkPlanVersion: identity.chunkPlanVersion,
      deadlineAt: "2099-01-01T00:00:00.000Z",
      mode: "backfill",
      requestedEndExclusive: identity.intervalEndExclusive,
      requestedStart: identity.intervalStart,
      sourceConfigFingerprint: source.fingerprint,
    });
  } finally {
    await session.release();
  }
}

// complete one anchor run under its source lock
async function completeAnchorRun(pool, sourceId, runId, identity, records) {
  const session = await acquireSourceSession(pool, sourceId);
  assert.ok(session);

  try {
    await completeForecastAnchorBackfillIngestion(session, {
      attempts: 1,
      identity,
      records,
      runId,
      upstreamResponseChecksum: "c".repeat(64),
    });
  } finally {
    await session.release();
  }
}

// close one expected rejected anchor run
async function failAnchorRun(pool, sourceId, runId, identity) {
  const session = await acquireSourceSession(pool, sourceId);
  assert.ok(session);

  try {
    await failIngestionRun(session, {
      attempts: 1,
      backfillIdentity: identity,
      error: {
        classification: "invalid_payload",
        code: "immutable_provenance_conflict",
        message: "test immutable provenance conflict",
      },
      runId,
    });
  } finally {
    await session.release();
  }
}

// create one truthful fixed anchor
function makeAnchor(
  source,
  validAt,
  leadHours,
  temperatureC,
  receivedAt = "2026-09-01T00:00:00.000Z",
  contractEpoch = "open-meteo-previous-runs-best-match/2026-09",
) {
  return createNormalizedForecastAnchorRecord({
    adapterVersion: "open-meteo-previous-runs/v1",
    contractEpoch,
    dataset: "previous_runs",
    leadHours,
    metadata: {
      device: null,
      model: "best_match",
      provider: { dataset: "previous_runs" },
      quality: null,
      upstreamTimezone: "UTC",
    },
    metrics: canonicalMetrics(temperatureC),
    receivedAt,
    sourceConfigFingerprint: source.fingerprint,
    sourceId: source.id,
    upstreamModel: "best_match",
    validAt,
  });
}

// store one retrieval-shaped weather row
async function storeScheduledForecast(pool, source, referenceAt) {
  const session = await acquireSourceSession(pool, source.id);
  assert.ok(session);

  try {
    const run = await startIngestionRun(session, {
      adapterVersion: "open-meteo-forecast-daily/v4",
      deadlineAt: "2099-01-01T00:00:00.000Z",
      mode: "scheduled",
      requestedEndExclusive: new Date(
        Date.parse(referenceAt) + 3_600_000,
      ).toISOString(),
      requestedStart: referenceAt,
      sourceConfigFingerprint: source.fingerprint,
    });
    await completeScheduledIngestion(session, {
      attempts: 1,
      expectedCheckpointVersion: null,
      lastValidAt: "2026-09-02T00:00:00.000Z",
      providerCursor: null,
      records: [
        createNormalizedWeatherRecord({
          metadata: {
            device: null,
            model: "best_match",
            provider: { dataset: "forecast" },
            quality: null,
            upstreamTimezone: "America/Los_Angeles",
          },
          metrics: canonicalMetrics(10),
          productRunAt: referenceAt,
          receivedAt: referenceAt,
          sourceId: source.id,
          sourceKind: "forecast",
          validAt: "2026-09-02T00:00:00.000Z",
        }),
      ],
      runId: run.id,
      windowEndExclusive: new Date(
        Date.parse(referenceAt) + 3_600_000,
      ).toISOString(),
      windowStart: referenceAt,
    });
  } finally {
    await session.release();
  }
}

// create the complete canonical metric shape
function canonicalMetrics(temperatureC) {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: null,
    relativeHumidityPercent: 70,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: 90,
    windGustMps: 4,
    windSpeedMps: 2,
  };
}
