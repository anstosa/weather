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
    ["model_current", "reanalysis", "forecast", "forecast", "forecast", "forecast"],
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
