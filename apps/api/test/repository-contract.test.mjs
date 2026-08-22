import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getCurrentWeather,
  listActiveSites,
  listWeatherHistory,
  readMigrationReadinessAuthorization,
  verifyMigrationReadiness,
} from "@weather/database";

// capture one repository query
function createCapturingPool(rows = []) {
  const queries = [];
  return {
    pool: {
      // retain parameterized query evidence
      async query(text, values = []) {
        queries.push({ text, values });
        return { rowCount: rows.length, rows };
      },
    },
    queries,
  };
}

test("current SQL enforces active joins and parameterized station/source filters", async () => {
  const { pool, queries } = createCapturingPool();
  await getCurrentWeather(pool, "ballydidean", {
    sourceId: "10",
    stationSlug: "open-meteo-virtual",
  });

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, [
    "ballydidean",
    "open-meteo-virtual",
    "10",
  ]);
  assert.match(queries[0].text, /si\.active/u);
  assert.match(queries[0].text, /st\.active/u);
  assert.match(queries[0].text, /s\.active/u);
  assert.match(queries[0].text, /p\.active/u);
  assert.match(queries[0].text, /st\.slug = \$2/u);
  assert.match(queries[0].text, /wr\.source_id = \$3/u);
  assert.match(queries[0].text, /wr\.upstream_timezone AS "upstreamTimezone"/u);
  assert.match(queries[0].text, /wr\.quality_metadata AS "qualityMetadata"/u);
  assert.match(queries[0].text, /wr\.provider_metadata AS "providerMetadata"/u);
});

test("site discovery requires every public entity to remain active", async () => {
  const { pool, queries } = createCapturingPool();
  await listActiveSites(pool);

  assert.equal(queries.length, 1);
  assert.match(queries[0].text, /WHERE si\.active/u);
  assert.match(queries[0].text, /JOIN stations st ON st\.site_id = si\.id AND st\.active/u);
  assert.match(queries[0].text, /JOIN sources s ON s\.station_id = st\.id AND s\.active/u);
  assert.match(queries[0].text, /JOIN providers p ON p\.id = s\.provider_id AND p\.active/u);
});

test("history SQL enforces active predicates, frozen filters, order, and bounded lookahead", async () => {
  const { pool, queries } = createCapturingPool();
  await listWeatherHistory(pool, {
    cursor: { id: "90", validAt: "2026-08-10T00:00:00.000Z" },
    from: "2026-08-01T00:00:00.000Z",
    limit: 251,
    siteSlug: "ballydidean",
    sourceId: "11",
    sourceKind: "reanalysis",
    stationSlug: "open-meteo-virtual",
    to: "2026-08-22T00:00:00.000Z",
  });

  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].values, [
    "ballydidean",
    "open-meteo-virtual",
    "11",
    "reanalysis",
    "2026-08-01T00:00:00.000Z",
    "2026-08-22T00:00:00.000Z",
    "2026-08-10T00:00:00.000Z",
    "90",
    251,
  ]);
  assert.match(queries[0].text, /si\.active/u);
  assert.match(queries[0].text, /st\.active/u);
  assert.match(queries[0].text, /s\.active/u);
  assert.match(queries[0].text, /p\.active/u);
  assert.match(queries[0].text, /st\.slug = \$2/u);
  assert.match(queries[0].text, /wr\.source_id = \$3/u);
  assert.match(queries[0].text, /wr\.source_kind = \$4/u);
  assert.match(queries[0].text, /wr\.valid_at >= \$5/u);
  assert.match(queries[0].text, /wr\.valid_at < \$6/u);
  assert.match(queries[0].text, /\(wr\.valid_at, wr\.id\) < \(\$7::timestamptz, \$8::bigint\)/u);
  assert.match(queries[0].text, /ORDER BY wr\.valid_at DESC, wr\.id DESC/u);
  assert.match(queries[0].text, /LIMIT \$9/u);

  await assert.rejects(
    () =>
      listWeatherHistory(pool, {
        limit: 252,
        siteSlug: "ballydidean",
      }),
    /between 1 and 251/u,
  );
});

test("migration readiness verifies the complete ledger with SELECT-only SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-api-migrations-"));
  const sql = "SELECT 1;\n";
  const checksum = createHash("sha256").update(sql).digest("hex");
  const { pool, queries } = createCapturingPool([
    { checksum, name: "0001_initial.sql" },
  ]);

  try {
    await writeFile(join(directory, "0001_initial.sql"), sql);
    const readiness = await verifyMigrationReadiness(pool, directory);

    assert.deepEqual(readiness, { version: "0001_initial.sql" });
    assert.equal(queries.length, 1);
    assert.match(queries[0].text, /^SELECT name, checksum FROM schema_migrations/u);
    assert.doesNotMatch(queries[0].text, /CREATE|INSERT|UPDATE|DELETE|LOCK/iu);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("trailing migrations require an exact release authorization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-api-migrations-"));
  const sql = "SELECT 1;\n";
  const checksum = createHash("sha256").update(sql).digest("hex");

  try {
    await writeFile(join(directory, "0001_initial.sql"), sql);
    const missing = createCapturingPool();
    const changed = createCapturingPool([
      { checksum: "0".repeat(64), name: "0001_initial.sql" },
    ]);
    const previousBinary = createCapturingPool([
      { checksum, name: "0001_initial.sql" },
      { checksum: "1".repeat(64), name: "0002_extra.sql" },
    ]);
    const reordered = createCapturingPool([
      { checksum: "1".repeat(64), name: "0002_extra.sql" },
      { checksum, name: "0001_initial.sql" },
    ]);

    await assert.rejects(
      () => verifyMigrationReadiness(missing.pool, directory),
      /pending migration artifacts/u,
    );
    await assert.rejects(
      () => verifyMigrationReadiness(changed.pool, directory),
      /migration checksum mismatch/u,
    );
    await assert.rejects(
      () => verifyMigrationReadiness(previousBinary.pool, directory),
      /migration history diverges/u,
    );
    const historySha256 = createHash("sha256")
      .update(`0001_initial.sql:${checksum}\n`)
      .update(`0002_extra.sql:${"1".repeat(64)}\n`)
      .digest("hex");
    const changedHistorySha256 = createHash("sha256")
      .update(`0001_initial.sql:${"0".repeat(64)}\n`)
      .digest("hex");
    const reorderedHistorySha256 = createHash("sha256")
      .update(`0002_extra.sql:${"1".repeat(64)}\n`)
      .update(`0001_initial.sql:${checksum}\n`)
      .digest("hex");
    assert.deepEqual(
      await verifyMigrationReadiness(previousBinary.pool, directory, {
        authorization: {
          historySha256,
          release: "2026.08.22-1",
        },
        release: "2026.08.22-1",
      }),
      { version: "0001_initial.sql" },
    );
    await assert.rejects(
      () =>
        verifyMigrationReadiness(previousBinary.pool, directory, {
          authorization: {
            historySha256,
            release: "2026.08.22-1",
          },
          release: "2026.08.22-2",
        }),
      /migration authorization release mismatch/u,
    );
    await assert.rejects(
      () =>
        verifyMigrationReadiness(previousBinary.pool, directory, {
          authorization: {
            historySha256: "2".repeat(64),
            release: "2026.08.22-1",
          },
          release: "2026.08.22-1",
        }),
      /migration authorization history mismatch/u,
    );
    await assert.rejects(
      () =>
        verifyMigrationReadiness(changed.pool, directory, {
          authorization: {
            historySha256: changedHistorySha256,
            release: "2026.08.22-1",
          },
          release: "2026.08.22-1",
        }),
      /migration checksum mismatch/u,
    );
    await assert.rejects(
      () =>
        verifyMigrationReadiness(reordered.pool, directory, {
          authorization: {
            historySha256: reorderedHistorySha256,
            release: "2026.08.22-1",
          },
          release: "2026.08.22-1",
        }),
      /migration history diverges/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("migration authorization parsing rejects partial and malformed state", () => {
  assert.equal(readMigrationReadinessAuthorization({}), null);
  assert.deepEqual(
    readMigrationReadinessAuthorization({
      WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256: "a".repeat(64),
      WEATHER_MIGRATION_AUTHORIZATION_RELEASE: "2026.08.22-1",
    }),
    {
      historySha256: "a".repeat(64),
      release: "2026.08.22-1",
    },
  );
  assert.throws(
    () =>
      readMigrationReadinessAuthorization({
        WEATHER_MIGRATION_AUTHORIZATION_RELEASE: "2026.08.22-1",
      }),
    /migration authorization must be complete/u,
  );
  assert.throws(
    () =>
      readMigrationReadinessAuthorization({
        WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256: "a".repeat(63),
        WEATHER_MIGRATION_AUTHORIZATION_RELEASE: "2026.08.22-1",
      }),
    /migration authorization history SHA-256/u,
  );
  assert.throws(
    () =>
      readMigrationReadinessAuthorization({
        WEATHER_MIGRATION_AUTHORIZATION_HISTORY_SHA256: "a".repeat(64),
        WEATHER_MIGRATION_AUTHORIZATION_RELEASE: "development",
      }),
    /migration authorization release/u,
  );
});
