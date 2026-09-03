import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  assertSupportedPostgres,
  loadEcowittConfiguration,
  loadDatabaseConfiguration,
  loadSiteConfiguration,
  loadTempestConfiguration,
  getWeatherForecast,
  listForecastObservationHourlyStations,
  listForecastTrainingCohorts,
  listWeatherHistory,
  parseSiteConfiguration,
  parseEcowittConfiguration,
  parseTempestConfiguration,
  toPoolConfiguration,
} from "../dist/index.js";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const ballydideanPath = join(repositoryRoot, "config/sites/ballydidean.json");
const ecowittPath = join(repositoryRoot, "config/ecowitt/gateways.json");
const tempestPath = join(repositoryRoot, "config/tempest/stations.json");

// verify the approved site configuration
test("configuration preserves exact Ballydidean identity and distinct sources", async () => {
  const configuration = await loadSiteConfiguration(ballydideanPath);

  assert.equal(configuration.site.key, "ballydidean");
  assert.equal(configuration.site.latitude, 47.950429954185445);
  assert.equal(configuration.site.longitude, -122.42797012608193);
  assert.equal(configuration.site.timezone, "America/Los_Angeles");
  assert.deepEqual(
    configuration.sources.map((source) => source.sourceKind),
    [
      "model_current",
      "reanalysis",
      "forecast",
      "forecast",
      "forecast",
      "forecast",
      "forecast",
    ],
  );
  assert.notEqual(
    configuration.sources[0].fingerprint,
    configuration.sources[1].fingerprint,
  );
  assert.notEqual(
    configuration.sources[1].fingerprint,
    configuration.sources[2].fingerprint,
  );
  assert.notEqual(
    configuration.sources[2].fingerprint,
    configuration.sources[3].fingerprint,
  );
  assert.notEqual(
    configuration.sources[3].fingerprint,
    configuration.sources[4].fingerprint,
  );
  assert.notEqual(
    configuration.sources[4].fingerprint,
    configuration.sources[5].fingerprint,
  );
  assert.notEqual(
    configuration.sources[5].fingerprint,
    configuration.sources[6].fingerprint,
  );
  const previousRuns = configuration.sources.find(
    // select the archive-only fixed-lead source
    (source) => source.key === "open-meteo-previous-runs-v1",
  );
  const liveForecast = configuration.sources.find(
    // select the unchanged operational forecast
    (source) => source.key === "open-meteo-forecast-v4",
  );

  assert.equal(liveForecast.active, true);
  assert.equal(liveForecast.cadenceSeconds, 3_600);
  assert.deepEqual(liveForecast.capabilities, ["forecast"]);
  assert.equal(previousRuns.sourceKind, "forecast");
  assert.deepEqual(previousRuns.capabilities, ["historical"]);
  assert.equal(previousRuns.cadenceSeconds, null);
  assert.equal(previousRuns.active, true);
  assert.deepEqual(previousRuns.adapterConfig, {
    contractEpoch: "open-meteo-previous-runs-best-match/2026-09",
    contractVersion: "previous-runs-hourly/v1",
    leadHours: [24, 48, 72, 96, 120, 144, 168],
    maximumChunkDays: 14,
    model: "best_match",
    variables: [
      "temperature",
      "apparent_temperature",
      "relative_humidity",
      "precipitation",
      "cloud_cover",
      "wind_speed",
      "wind_gust",
      "wind_direction",
      "surface_pressure",
    ],
  });
});

// verify the checked physical station catalog
test("Tempest configuration derives exact immutable source identities", async () => {
  const configuration = await loadTempestConfiguration(tempestPath);

  assert.equal(configuration.siteKey, "ballydidean");
  assert.equal(configuration.provider.key, "weatherflow-tempest");
  assert.equal(configuration.stations.length, 7);
  assert.deepEqual(
    configuration.stations.map((station) => station.locationId),
    [203055, 201058, 126537, 168853, 64255, 38270, 225947],
  );
  assert.deepEqual(
    configuration.stations.map(
      // retain each checked road label
      (station) => station.displayName,
    ),
    [
      "Maxwelton Rd & Quade Rd",
      "Maxwelton Rd & Dorothys Ln",
      "Sills Rd & Eaglecrest Ln",
      "Sills Rd & French Rd",
      "Maxwelton Rd & Mill Beach Ln",
      "Fiske Rd & Paris Pl",
      "Montgomery Ln & Thomas Ln",
    ],
  );
  assert.equal(configuration.stations[0].sourceKey, "tempest-203055-observations-v2");
  assert.deepEqual(configuration.stations[0].adapterConfig, {
    contractVersion: "tempest-observations/v2",
    deviceId: 470937,
    locationId: 203055,
    sample: "every-distinct-provider-observation",
    supersedesSourceKey: "tempest-203055-observations-v1",
  });
  assert.match(configuration.stations[0].fingerprint, /^[a-f0-9]{64}$/u);
});

// verify the checked first-party gateway catalog
test("Ecowitt configuration binds the farm gateway by private IP and MAC", async () => {
  const configuration = await loadEcowittConfiguration(ecowittPath);
  const station = configuration.stations[0];

  assert.equal(configuration.siteKey, "ballydidean");
  assert.equal(configuration.provider.key, "ecowitt-local");
  assert.equal(station.displayName, "Ballydídean Farm");
  assert.equal(station.gatewayHost, "192.168.11.137");
  assert.equal(station.expectedMac, "88:F1:55:05:D8:9F");
  assert.equal(station.sourceKey, "ecowitt-88f15505d89f-local-live-v1");
  assert.equal(station.cadenceSeconds, 60);
  assert.deepEqual(station.adapterConfig, {
    contractVersion: "ecowitt-local-live/v1",
    endpointPath: "/get_livedata_info",
    expectedMac: "88:F1:55:05:D8:9F",
    gatewayHost: "192.168.11.137",
    measurementSet: "canonical-primary",
    rainGauge: "traditional-preferred",
  });
  assert.match(station.fingerprint, /^[a-f0-9]{64}$/u);
});

// reject an Ecowitt target outside the private LAN
test("Ecowitt configuration rejects public gateway targets", async () => {
  const raw = JSON.parse(await readFile(ecowittPath, "utf8"));

  assert.throws(
    () => parseEcowittConfiguration({
      ...raw,
      stations: [{ ...raw.stations[0], gatewayHost: "8.8.8.8" }],
    }),
    /private IPv4/u,
  );
});

// reject duplicate physical device identities
test("Tempest configuration rejects duplicate station identities", async () => {
  const raw = JSON.parse(await readFile(tempestPath, "utf8"));

  assert.throws(
    () =>
      parseTempestConfiguration({
        ...raw,
        stations: [raw.stations[0], { ...raw.stations[1], deviceId: raw.stations[0].deviceId }],
      }),
    /deviceId values must be unique/u,
  );
});

// verify fingerprint material boundaries
test("source fingerprints ignore operational cadence and active fields", async () => {
  const raw = JSON.parse(await readFile(ballydideanPath, "utf8"));
  const baseline = parseSiteConfiguration(raw);
  const operationalChange = parseSiteConfiguration({
    ...raw,
    sources: raw.sources.map((source, index) =>
      index === 0
        ? { ...source, active: false, cadenceSeconds: 1_800 }
        : source,
    ),
  });
  const materialChange = parseSiteConfiguration({
    ...raw,
    sources: raw.sources.map((source, index) =>
      index === 0
        ? {
            ...source,
            adapterConfig: { ...source.adapterConfig, contractVersion: "changed/v2" },
          }
        : source,
    ),
  });
  const locationChanges = [
    { latitude: raw.site.latitude + 0.01 },
    { longitude: raw.site.longitude - 0.01 },
    { timezone: "UTC" },
  ].map((siteChange) =>
    parseSiteConfiguration({
      ...raw,
      site: { ...raw.site, ...siteChange },
    }),
  );

  assert.equal(
    baseline.sources[0].fingerprint,
    operationalChange.sources[0].fingerprint,
  );
  assert.notEqual(
    baseline.sources[0].fingerprint,
    materialChange.sources[0].fingerprint,
  );
  // require every location part in source identity
  for (const changed of locationChanges) {
    assert.notEqual(
      baseline.sources[0].fingerprint,
      changed.sources[0].fingerprint,
    );
  }
});

// reject non-object configuration roots
test("site configuration rejects null primitive and array roots", () => {
  // exercise every non-object JSON category
  for (const value of [null, true, 1, "invalid", []]) {
    assert.throws(
      () => parseSiteConfiguration(value),
      /site configuration must be an object/u,
    );
  }
});

// reject non-object adapter configuration
test("site configuration requires object adapter material", async () => {
  const raw = JSON.parse(await readFile(ballydideanPath, "utf8"));

  // exercise every non-object JSON category
  for (const value of [null, true, 1, "invalid", []]) {
    assert.throws(
      () =>
        parseSiteConfiguration({
          ...raw,
          sources: raw.sources.map((source, index) =>
            index === 0 ? { ...source, adapterConfig: value } : source,
          ),
        }),
      /sources\[0\]\.adapterConfig must be an object/u,
    );
  }
});

// verify secret-file configuration
test("database configuration reads mounted passwords without embedding them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-config-"));
  const secretPath = join(directory, "password");

  try {
    await writeFile(secretPath, "secret-value \n", { mode: 0o600 });
    const configuration = await loadDatabaseConfiguration({
      WEATHER_DATABASE_HOST: "127.0.0.1",
      WEATHER_DATABASE_LOCK_TIMEOUT_MS: "4321",
      WEATHER_DATABASE_NAME: "weather",
      WEATHER_DATABASE_PASSWORD_FILE: secretPath,
      WEATHER_DATABASE_PORT: "5432",
      WEATHER_DATABASE_SSL: "false",
      WEATHER_DATABASE_USER: "weather_owner",
    });
    const poolConfiguration = toPoolConfiguration(configuration);

    assert.equal(configuration.password, "secret-value ");
    assert.equal(configuration.lockTimeoutMs, 4_321);
    assert.equal(poolConfiguration.password, "secret-value ");
    assert.equal(JSON.stringify({ ...configuration, password: "[redacted]" }).includes("secret-value"), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

// verify the PostgreSQL feature floor
test("PostgreSQL preflight accepts 15 and rejects 14", async () => {
  const supported = {
    // return a supported version
    async query() {
      return { rows: [{ server_version_num: "150000" }] };
    },
  };
  const unsupported = {
    // return an unsupported version
    async query() {
      return { rows: [{ server_version_num: "140012" }] };
    },
  };

  assert.equal(await assertSupportedPostgres(supported), 150_000);
  await assert.rejects(
    () => assertSupportedPostgres(unsupported),
    /PostgreSQL 15 or newer/u,
  );
});

// verify role bootstrap syntax
test("runtime role bootstrap is valid shell without secret logging", async () => {
  const scriptPath = join(
    repositoryRoot,
    "deploy/postgres/010-create-runtime-roles.sh",
  );
  const script = await readFile(scriptPath, "utf8");

  await executeFile("bash", ["-n", scriptPath]);
  assert.doesNotMatch(script, /set -x/u);
  assert.doesNotMatch(script, /echo .*password/u);
  assert.match(script, /WEATHER_API_PASSWORD_FILE/u);
  assert.match(script, /WEATHER_INGEST_PASSWORD_FILE/u);
  assert.match(script, /WEATHER_OWNER_PASSWORD_FILE/u);
  assert.match(script, /WEATHER_TRAINING_EXPORT_PASSWORD_FILE/u);
});

// verify repository range validation precedes SQL
test("history rejects reversed ranges before querying PostgreSQL", async () => {
  const rejectingPool = {
    // expose unexpected query execution
    async query() {
      throw new Error("query should not execute");
    },
  };

  await assert.rejects(
    () =>
      listWeatherHistory(rejectingPool, {
        from: "2026-08-22T01:00:00.000Z",
        siteSlug: "ballydidean",
        to: "2026-08-22T00:00:00.000Z",
      }),
    /history from must be earlier/u,
  );
});

// verify live forecasts require the forecast capability
test("forecast repository keeps historical-only sources out of the live route", async () => {
  const captured = [];
  const pool = {
    // capture the generated query contract
    async query(text, values) {
      captured.push({ text, values });
      return { rows: [] };
    },
  };

  assert.deepEqual(
    await getWeatherForecast(pool, {
      asOf: "2026-09-01T00:00:00.000Z",
      hours: 24,
      siteSlug: "ballydidean",
    }),
    [],
  );
  assert.equal(captured.length, 1);
  assert.match(captured[0].text, /s\.capabilities @> '\["forecast"\]'::jsonb/u);
  assert.match(
    captured[0].text,
    /NULL::text AS "sourceConfigFingerprint"/u,
  );
  assert.match(
    captured[0].text,
    /NULL::text AS "adapterVersion"/u,
  );
  assert.match(
    captured[0].text,
    /NULL::text AS "contractEpoch"/u,
  );
  assert.doesNotMatch(captured[0].text, /forecast_runtime_provenance_v1/u);
  assert.deepEqual(captured[0].values, [
    "ballydidean",
    "2026-09-01T00:00:00.000Z",
    "2026-09-02T00:00:00.000Z",
  ]);
});

// verify optional provenance failures preserve the raw forecast
test("forecast repository fails raw when provenance access is denied", async () => {
  const rawRecord = weatherRecordRowFixture();
  const queries = [];
  const pool = {
    // fault only the optional provenance query
    async query(text, values) {
      queries.push({ text, values });

      // deny the narrow provenance view only
      if (text.includes("forecast_runtime_provenance_v1")) {
        throw Object.assign(new Error("permission denied"), { code: "42501" });
      }

      return { rows: [rawRecord] };
    },
  };
  const records = await getWeatherForecast(pool, {
    asOf: "2026-09-01T00:00:00.000Z",
    hours: 24,
    siteSlug: "ballydidean",
  });

  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0].text, /forecast_runtime_provenance_v1/u);
  assert.match(queries[1].text, /FROM forecast_runtime_provenance_v1/u);
  assert.match(queries[1].text, /weather_record_id = ANY\(\$1::bigint\[\]\)/u);
  assert.deepEqual(queries[1].values, [[rawRecord.id]]);
  assert.equal(JSON.stringify(records), JSON.stringify([rawRecord]));
});

// verify authoritative raw failures still reject
test("forecast repository does not swallow raw query failures", async () => {
  let queryCount = 0;
  const pool = {
    // fail the first authoritative query
    async query() {
      queryCount += 1;
      throw Object.assign(new Error("raw query failed"), { code: "08006" });
    },
  };

  await assert.rejects(
    () =>
      getWeatherForecast(pool, {
        asOf: "2026-09-01T00:00:00.000Z",
        hours: 24,
        siteSlug: "ballydidean",
      }),
    (error) => error?.code === "08006",
  );
  assert.equal(queryCount, 1);
});

// verify fixed anchors and v4 retrievals stay separate
test("forecast training repository projects separate provenance cohorts", async () => {
  let queryIndex = 0;
  const pool = {
    // return one cohort per repository query
    async query() {
      queryIndex += 1;

      // return one exact fixed anchor first
      if (queryIndex === 1) {
        return { rows: [forecastAnchorStorageFixture()] };
      }

      return {
        rows: [
          legacyV4StorageFixture(),
          legacyV4StorageFixture({
            referenceAt: "2026-09-02T00:00:00.000Z",
            stableRecordId: "2",
            validAt: "2026-09-02T00:00:00.000Z",
          }),
          legacyV4StorageFixture({
            referenceAt: "2026-08-20T00:00:00.000Z",
            stableRecordId: "3",
          }),
        ],
      };
    },
  };
  const cohorts = await listForecastTrainingCohorts(pool, {
    from: "2026-09-01T00:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-09-03T00:00:00.000Z",
  });

  assert.equal(cohorts.fixedLeadAnchors.length, 1);
  assert.equal(cohorts.fixedLeadAnchors[0].cohort, "fixed_lead_anchor");
  assert.equal(cohorts.fixedLeadAnchors[0].referenceKind, "fixed_lead_anchor");
  assert.equal(cohorts.legacyV4RetrievalSnapshots.length, 1);
  assert.equal(
    cohorts.legacyV4RetrievalSnapshots[0].cohort,
    "legacy_v4_retrieval_snapshot",
  );
  assert.equal(cohorts.legacyV4RetrievalSnapshots[0].targetLeadHours, 24);
  assert.match(
    cohorts.legacyV4RetrievalSnapshots[0].contractEpoch,
    /^legacy-v4\/[a-f0-9]{64}$/u,
  );
});

// verify impossible v4 provenance fails closed
test("forecast training repository rejects references after valid time", async () => {
  let queryIndex = 0;
  const pool = {
    // return malformed retrieval provenance second
    async query() {
      queryIndex += 1;
      return queryIndex === 1
        ? { rows: [] }
        : {
            rows: [
              legacyV4StorageFixture({
                referenceAt: "2026-09-02T00:00:00.000Z",
                validAt: "2026-09-01T00:00:00.000Z",
              }),
            ],
          };
    },
  };

  await assert.rejects(
    () =>
      listForecastTrainingCohorts(pool, {
        from: "2026-09-01T00:00:00.000Z",
        siteSlug: "ballydidean",
        to: "2026-09-03T00:00:00.000Z",
      }),
    /referenceAt must not be after validAt/u,
  );
});

// verify exact station windows cutovers and missingness
test("hourly station projection applies literal sampling and lineage rules", async () => {
  let selectedSourceKeys;
  const ecowitt = {
    adapterContract: "ecowitt-local-live/v1",
    id: "1",
    qualityMetadata: null,
    relativeHumidityPercent: 80,
    sourceConfigFingerprint:
      "0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d",
    sourceKey: "ecowitt-88f15505d89f-local-live-v1",
    stationSlug: "ballydidean-ecowitt",
    temperatureC: 10,
    validAt: "2026-09-01T00:58:00.000Z",
    windDirectionDegrees: 90,
    windGustMps: null,
    windSpeedMps: 0.5,
  };
  const gustRows = Array.from({ length: 6 }, (_unused, index) => ({
    ...ecowitt,
    id: String(index + 10),
    relativeHumidityPercent: null,
    temperatureC: null,
    validAt: new Date(Date.parse("2026-09-01T00:10:00.000Z") + index * 600_000).toISOString(),
    windDirectionDegrees: null,
    windGustMps: index + 2,
    windSpeedMps: null,
  }));
  const ambientAtCutover = {
    adapterContract: "ambient-device-data/v1",
    id: "30",
    qualityMetadata: null,
    relativeHumidityPercent: 70,
    sourceConfigFingerprint:
      "7a7528a6278924ca5280a1a6045b6647b7e660b112d7fa3008c542a17ff99df4",
    sourceKey: "ambient-maxweather-observations-v1",
    stationSlug: "ambient-maxweather",
    temperatureC: 12,
    validAt: "2026-08-24T00:00:00.000Z",
    windDirectionDegrees: 180,
    windGustMps: null,
    windSpeedMps: 2,
  };
  const wundergroundAtCutover = {
    ...ambientAtCutover,
    adapterContract: "wunderground-pws-history/v1",
    id: "31",
    sourceConfigFingerprint:
      "52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c",
    sourceKey: "wunderground-maxweather-history-v1",
    temperatureC: 99,
  };
  const pool = {
    // return deterministic raw physical observations
    async query(_text, values) {
      selectedSourceKeys = values[3];
      return {
        rows: [
          ecowitt,
          { ...ecowitt, id: "2", temperatureC: 20, validAt: "2026-09-01T01:02:00.000Z", windDirectionDegrees: 200, windSpeedMps: 2 },
          ...gustRows,
          ambientAtCutover,
          wundergroundAtCutover,
        ],
      };
    },
  };
  const september = await listForecastObservationHourlyStations(pool, {
    from: "2026-09-01T01:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-09-01T02:00:00.000Z",
  });
  const ecowittHour = september.find(
    (row) => row.physicalStationKey === "ballydidean-ecowitt",
  );

  assert.equal(september.length, 11);
  assert.equal(ecowittHour.metrics.temperatureC, 10);
  assert.equal(ecowittHour.metrics.windSpeedMps, 0.5);
  assert.equal(ecowittHour.metrics.windDirectionDegrees, 200);
  assert.equal(ecowittHour.metrics.windGustMps, 7);
  assert.equal(
    selectedSourceKeys.some((sourceKey) => sourceKey.endsWith("observations-v1") && sourceKey.startsWith("tempest-")),
    false,
  );

  const august = await listForecastObservationHourlyStations(pool, {
    from: "2026-08-24T00:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-08-24T01:00:00.000Z",
  });
  const maxweather = august.find(
    (row) => row.physicalStationKey === "ambient-maxweather",
  );

  assert.equal(maxweather.metrics.temperatureC, 12);
  assert.deepEqual(maxweather.sourceKeys, ["ambient-maxweather-observations-v1"]);
});

// verify post-precedence duplicates fail hard
test("hourly station projection rejects station time metric collisions", async () => {
  const row = {
    adapterContract: "ecowitt-local-live/v1",
    id: "1",
    qualityMetadata: null,
    relativeHumidityPercent: null,
    sourceConfigFingerprint:
      "0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d",
    sourceKey: "ecowitt-88f15505d89f-local-live-v1",
    stationSlug: "ballydidean-ecowitt",
    temperatureC: 10,
    validAt: "2026-09-01T01:00:00.000Z",
    windDirectionDegrees: null,
    windGustMps: null,
    windSpeedMps: null,
  };
  const pool = {
    // return a duplicated eligible station metric
    async query() {
      return { rows: [row, { ...row, id: "2" }] };
    },
  };

  await assert.rejects(
    () =>
      listForecastObservationHourlyStations(pool, {
        from: "2026-09-01T01:00:00.000Z",
        siteSlug: "ballydidean",
        to: "2026-09-01T02:00:00.000Z",
      }),
    /forecast observation collision/u,
  );
});

// verify literal Tempest flag handling
test("hourly station projection accepts only the checked quality exceptions", async () => {
  const tempest = {
    adapterContract: "tempest-observations/v2",
    id: "1",
    qualityMetadata: { flags: ["uv_index_out_of_range"] },
    relativeHumidityPercent: 70,
    sourceConfigFingerprint:
      "ce162067aced4ab3522fb83145a21e608ff24dec189097726188e96fd6cca52f",
    sourceKey: "tempest-38270-observations-v2",
    stationSlug: "tempest-38270",
    temperatureC: 10,
    validAt: "2026-09-01T01:00:00.000Z",
    windDirectionDegrees: 180,
    windGustMps: null,
    windSpeedMps: 2,
  };
  const wunderground = {
    adapterContract: "wunderground-pws-history/v1",
    id: "3",
    qualityMetadata: { status: "provider_qc_1" },
    relativeHumidityPercent: 75,
    sourceConfigFingerprint:
      "52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c",
    sourceKey: "wunderground-maxweather-history-v1",
    stationSlug: "ambient-maxweather",
    temperatureC: 8,
    validAt: "2026-08-23T23:00:00.000Z",
    windDirectionDegrees: 90,
    windGustMps: null,
    windSpeedMps: 2,
  };
  const pool = {
    // include one accepted and one rejected quality row
    async query() {
      return {
        rows: [
          tempest,
          {
            ...tempest,
            id: "2",
            qualityMetadata: { flags: ["invented_flag"] },
            temperatureC: 99,
          },
          wunderground,
          {
            ...wunderground,
            id: "4",
            qualityMetadata: { status: "provider_qc_2" },
            temperatureC: 99,
          },
        ],
      };
    },
  };
  const rows = await listForecastObservationHourlyStations(pool, {
    from: "2026-09-01T01:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-09-01T02:00:00.000Z",
  });
  const station = rows.find(
    (row) => row.physicalStationKey === "tempest-38270",
  );

  assert.equal(station.metrics.temperatureC, 10);
  assert.deepEqual(station.sourceKeys, ["tempest-38270-observations-v2"]);
  const beforeCutover = await listForecastObservationHourlyStations(pool, {
    from: "2026-08-23T23:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-08-24T00:00:00.000Z",
  });
  const maxweather = beforeCutover.find(
    (row) => row.physicalStationKey === "ambient-maxweather",
  );

  assert.equal(maxweather.metrics.temperatureC, 8);
  assert.deepEqual(maxweather.sourceKeys, ["wunderground-maxweather-history-v1"]);
});

// create one raw forecast row
function weatherRecordRowFixture(overrides = {}) {
  return {
    adapterVersion: null,
    apparentTemperatureC: 10,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: 20,
    contractEpoch: null,
    deviceModel: "virtual-grid",
    deviceSerial: null,
    deviceVendor: "Open-Meteo",
    firstReceivedAt: "2026-09-01T00:01:00.000Z",
    id: "201",
    lastReceivedAt: "2026-09-01T00:01:00.000Z",
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: 0,
    precipitationRateMmPerHour: 0,
    pressureHpa: 1010,
    productRunAt: "2026-09-01T00:00:00.000Z",
    providerKey: "open-meteo",
    providerMetadata: { dataset: "forecast" },
    qualityMetadata: null,
    relativeHumidityPercent: 70,
    revisionCount: 0,
    siteSlug: "ballydidean",
    sourceConfigFingerprint: null,
    sourceId: "200",
    sourceKey: "open-meteo-forecast-v4",
    sourceKind: "forecast",
    stationSlug: "open-meteo-virtual",
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: 11,
    upstreamModel: "best_match",
    upstreamTimezone: "UTC",
    uvIndex: null,
    validAt: "2026-09-01T01:00:00.000Z",
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: 90,
    windGustMps: 4,
    windSpeedMps: 2,
    ...overrides,
  };
}

// create one fixed-anchor storage row
function forecastAnchorStorageFixture(overrides = {}) {
  return {
    adapterVersion: "open-meteo-previous-runs/v1",
    apparentTemperatureC: null,
    cloudCoverPercent: null,
    contractEpoch: "open-meteo-previous-runs-best-match/2026-09",
    dataset: "previous_runs",
    leadHours: 24,
    precipitationMm: null,
    pressureHpa: null,
    providerMetadata: { dataset: "previous_runs" },
    qualityMetadata: null,
    receivedAt: "2026-09-02T00:00:00.000Z",
    relativeHumidityPercent: null,
    sourceConfigFingerprint: "a".repeat(64),
    sourceId: "100",
    temperatureC: 11,
    upstreamModel: "best_match",
    upstreamTimezone: "UTC",
    validAt: "2026-09-02T00:00:00.000Z",
    windDirectionDegrees: null,
    windGustMps: null,
    windSpeedMps: null,
    ...overrides,
  };
}

// create one legacy-v4 storage row
function legacyV4StorageFixture(overrides = {}) {
  return {
    adapterVersion: "open-meteo-forecast-daily/v4",
    apparentTemperatureC: 10,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: 20,
    dataset: "forecast",
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: 0,
    precipitationRateMmPerHour: 0,
    pressureHpa: 1010,
    referenceAt: "2026-09-01T00:00:00.000Z",
    relativeHumidityPercent: 70,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    sourceConfigFingerprint: "b".repeat(64),
    sourceId: "200",
    stableRecordId: "1",
    temperatureC: 11,
    upstreamModel: "best_match",
    uvIndex: null,
    validAt: "2026-09-02T00:00:00.000Z",
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: 90,
    windGustMps: 4,
    windSpeedMps: 2,
    ...overrides,
  };
}
