import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  assertSupportedPostgres,
  loadDatabaseConfiguration,
  loadSiteConfiguration,
  listWeatherHistory,
  parseSiteConfiguration,
  toPoolConfiguration,
} from "../dist/index.js";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const ballydideanPath = join(repositoryRoot, "config/sites/ballydidean.json");

// verify the approved site configuration
test("configuration preserves exact Ballydidean identity and distinct sources", async () => {
  const configuration = await loadSiteConfiguration(ballydideanPath);

  assert.equal(configuration.site.key, "ballydidean");
  assert.equal(configuration.site.latitude, 47.950429954185445);
  assert.equal(configuration.site.longitude, -122.42797012608193);
  assert.equal(configuration.site.timezone, "America/Los_Angeles");
  assert.deepEqual(
    configuration.sources.map((source) => source.sourceKind),
    ["model_current", "reanalysis"],
  );
  assert.notEqual(
    configuration.sources[0].fingerprint,
    configuration.sources[1].fingerprint,
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

  assert.equal(
    baseline.sources[0].fingerprint,
    operationalChange.sources[0].fingerprint,
  );
  assert.notEqual(
    baseline.sources[0].fingerprint,
    materialChange.sources[0].fingerprint,
  );
});

// verify secret-file configuration
test("database configuration reads mounted passwords without embedding them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-config-"));
  const secretPath = join(directory, "password");

  try {
    await writeFile(secretPath, "secret-value\n", { mode: 0o600 });
    const configuration = await loadDatabaseConfiguration({
      WEATHER_DATABASE_HOST: "127.0.0.1",
      WEATHER_DATABASE_NAME: "weather",
      WEATHER_DATABASE_PASSWORD_FILE: secretPath,
      WEATHER_DATABASE_PORT: "5432",
      WEATHER_DATABASE_SSL: "false",
      WEATHER_DATABASE_USER: "weather_owner",
    });
    const poolConfiguration = toPoolConfiguration(configuration);

    assert.equal(configuration.password, "secret-value");
    assert.equal(poolConfiguration.password, "secret-value");
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
