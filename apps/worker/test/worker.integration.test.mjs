import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadSiteConfiguration } from "@weather/database";
import { ProviderFailure } from "@weather/providers";

import {
  executeBackfill,
  runWorkerIteration,
  runScheduledSource,
} from "../dist/index.js";

const sitePath = new URL("../../../config/sites/ballydidean.json", import.meta.url).pathname;
const fixturePath = new URL(
  "../../../packages/providers/test/fixtures/open-meteo/current.json",
  import.meta.url,
);
const sourceId = "00000000-0000-4000-8000-000000000001";
const fingerprint = "a".repeat(64);

// create a retained fake source session
function sourceSession(log) {
  return {
    release: async () => {
      log.push("release");
    },
    sourceId,
  };
}

// create the G002 repository façade
function scheduledRepository(log) {
  const session = sourceSession(log);
  const repository = {
    abandonExpiredRuns: async () => {
      log.push("abandon");
      return [];
    },
    acquireSourceSession: async () => {
      log.push("lock");
      return session;
    },
    completeScheduledIngestion: async (_session, input) => {
      log.push(`complete:${input.records.length}`);
    },
    discoverDueSources: async () => [],
    failIngestionRun: async () => {
      log.push("fail");
    },
    getScheduledCheckpoint: async () => null,
    startIngestionRun: async (_session, input) => {
      log.push("start-committed");
      repository.startedInput = input;
      return { id: "run-1", startedAt: "2026-08-22T05:20:00.000Z", state: "running" };
    },
    startedInput: null,
    updateWorkerHeartbeat: async () => {},
  };

  return repository;
}

// create an active current discovery row
function currentDueSource(site, overrides = {}) {
  const configuration = site.sources.find(
    (candidate) => candidate.key === "open-meteo-current-v1",
  );
  assert.ok(configuration);

  return {
    active: true,
    cadenceSeconds: 900,
    id: sourceId,
    materialProviderConfig: configuration.adapterConfig,
    providerKey: site.provider.key,
    siteSlug: site.site.key,
    sourceConfigFingerprint: configuration.fingerprint,
    sourceKey: configuration.key,
    sourceKind: configuration.sourceKind,
    stationSlug: site.station.key,
    timezone: site.site.timezone,
    ...overrides,
  };
}

// create an exact historical source identity
function historicalSource(site, overrides = {}) {
  const configuration = site.sources.find(
    (candidate) => candidate.key === "open-meteo-reanalysis-v1",
  );
  assert.ok(configuration);

  return {
    id: sourceId,
    key: configuration.key,
    latitude: site.site.latitude,
    longitude: site.site.longitude,
    materialProviderConfig: configuration.adapterConfig,
    providerKey: site.provider.key,
    siteSlug: site.site.key,
    sourceConfigFingerprint: configuration.fingerprint,
    sourceKey: configuration.key,
    sourceKind: configuration.sourceKind,
    stationSlug: site.station.key,
    timezone: site.site.timezone,
    ...overrides,
  };
}

// prove committed run precedes provider HTTP
test("I-ING-01 scheduled fetch observes committed running lifecycle", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const log = [];
  const payload = await readFile(fixturePath, "utf8");
  const repository = scheduledRepository(log);
  const injectedFetch = async () => {
    assert.equal(log.includes("start-committed"), true);
    log.push("fetch");
    return new Response(payload, { status: 200 });
  };
  const result = await runScheduledSource({}, currentDueSource(site), {
    fetchOptions: {
      clock: () => Date.parse("2026-08-22T05:20:00.000Z"),
      fetch: injectedFetch,
      now: () => new Date("2026-08-22T05:20:00.000Z"),
    },
    now: () => new Date("2026-08-22T05:20:00.000Z"),
    repository,
    site,
  });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(log, ["lock", "abandon", "start-committed", "fetch", "complete:1", "release"]);
  assert.equal(
    Date.parse(repository.startedInput.deadlineAt) - Date.parse("2026-08-22T05:20:00.000Z"),
    120_000,
  );
});

// reject every mismatched source identity before external work
test("scheduled ingestion requires exact configured source identity", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const mismatches = [
    { stationSlug: "other-station" },
    { providerKey: "other-provider" },
    { sourceKind: "forecast" },
    { sourceConfigFingerprint: "b".repeat(64) },
    { materialProviderConfig: { contractVersion: "forecast-current/v2" } },
  ];

  // reject each identity mutation independently
  for (const mismatch of mismatches) {
    let calls = 0;
    const forbidden = async () => {
      calls += 1;
      throw new Error("external call was not expected");
    };
    const result = await runScheduledSource({}, currentDueSource(site, mismatch), {
      fetchCurrent: forbidden,
      now: () => new Date("2026-08-22T05:20:00.000Z"),
      repository: {
        ...scheduledRepository([]),
        acquireSourceSession: forbidden,
      },
      site,
    });

    assert.equal(result.status, "skipped");
    assert.equal(calls, 0);
  }
});

// retain primary and secondary scheduled failures
test("scheduled failure retains primary code and redacted finalization diagnostics", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const log = [];
  const repository = scheduledRepository(log);
  repository.failIngestionRun = async () => {
    throw new Error(
      `password: scheduled-secret Bearer bearer-secret ${"x".repeat(700)}`,
    );
  };
  const result = await runScheduledSource({}, currentDueSource(site), {
    fetchCurrent: async () => {
      throw new ProviderFailure({
        classification: "retryable",
        code: "provider_primary",
        message: "primary failure",
      });
    },
    now: () => new Date("2026-08-22T05:20:00.000Z"),
    repository,
    site,
  });

  assert.equal(result.reason, "provider_primary");
  assert.equal(result.status, "failed");
  assert.match(result.secondaryError, /\[redacted\]/u);
  assert.doesNotMatch(result.secondaryError, /scheduled-secret/u);
  assert.doesNotMatch(result.secondaryError, /bearer-secret/u);
  assert.ok(result.secondaryError.length <= 512);
});

// retain the scheduled primary failure when finalization and release also fail
test("scheduled release failure preserves primary and secondary diagnostics", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const repository = scheduledRepository([]);
  repository.failIngestionRun = async () => {
    throw new Error("token=finalization-secret");
  };
  repository.acquireSourceSession = async () => ({
    // fail session cleanup independently
    release: async () => {
      throw new Error("password: release-secret");
    },
    sourceId,
  });
  const result = await runScheduledSource({}, currentDueSource(site), {
    fetchCurrent: async () => {
      throw new ProviderFailure({
        classification: "retryable",
        code: "provider_primary",
        message: "primary failure",
      });
    },
    now: () => new Date("2026-08-22T05:20:00.000Z"),
    repository,
    site,
  });

  assert.equal(result.reason, "provider_primary");
  assert.equal(result.status, "failed");
  assert.match(result.secondaryError, /finalization=/u);
  assert.match(result.secondaryError, /release=/u);
  assert.doesNotMatch(result.secondaryError, /finalization-secret|release-secret/u);
});

// preserve durable success through restart failures and emit bounded diagnostics
test("worker iteration preserves restart success and emits allowlisted diagnostics", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const heartbeat = [];
  const diagnostics = [];
  const repository = scheduledRepository([]);
  repository.discoverDueSources = async () => [currentDueSource(site)];
  repository.updateWorkerHeartbeat = async (_pool, input) => {
    heartbeat.push(input);
  };
  const previousSuccess = "2026-08-21T05:20:00.000Z";
  const result = await runWorkerIteration({}, {
    diagnosticWriter: (diagnostic) => {
      diagnostics.push(diagnostic);
    },
    fetchCurrent: async () => {
      throw new Error("Bearer diagnostic-secret");
    },
    instance: "worker-test",
    lastSuccessAt: previousSuccess,
    now: () => new Date("2026-08-22T05:20:00.000Z"),
    repository,
    site,
    version: "release-test",
  });

  assert.equal(result.lastSuccessAt, previousSuccess);
  assert.equal(heartbeat[0].lastSuccessAt, previousSuccess);
  assert.deepEqual(Object.keys(diagnostics[0]).sort(), [
    "count",
    "duration_ms",
    "error_code",
    "event",
    "release",
    "run_id",
    "source_id",
  ]);
  assert.equal(diagnostics[0].error_code, "provider_unavailable");
  assert.equal(diagnostics[0].release, "release-test");
  assert.equal(JSON.stringify(diagnostics).includes("diagnostic-secret"), false);
});

// create an exact backfill repository
function backfillRepository(log, successfulKeys = new Set()) {
  let run = 0;
  return {
    abandonExpiredRuns: async () => {
      log.push("abandon");
      return [];
    },
    acquireSourceSession: async () => sourceSession(log),
    completeBackfillIngestion: async (_session, input) => {
      log.push(`complete:${input.identity.intervalStart}`);
    },
    failIngestionRun: async (_session, input) => {
      log.push(`fail:${input.backfillIdentity.intervalStart}`);
    },
    hasSuccessfulBackfillChunk: async (_pool, identity) =>
      successfulKeys.has(identity.intervalStart),
    startIngestionRun: async () => {
      run += 1;
      log.push("start-committed");
      return { id: `run-${run}`, startedAt: "2026-08-22T05:20:00.000Z", state: "running" };
    },
  };
}

// create a normalized archive batch inside one chunk
function archiveBatch(input) {
  return {
    attempts: 1,
    checksum: "c".repeat(64),
    providerCursor: null,
    records: [
      {
        metadata: {
          device: null,
          model: "reanalysis",
          provider: { dataset: "archive" },
          quality: null,
          upstreamTimezone: input.timezone,
        },
        metrics: {
          apparentTemperatureC: 9,
          cloudCoverPercent: 50,
          precipitationMm: 0,
          pressureHpa: 1012,
          relativeHumidityPercent: 75,
          temperatureC: 10,
          windDirectionDegrees: 180,
          windGustMps: 4,
          windSpeedMps: 2,
        },
        productRunAt: null,
        receivedAt: "2026-08-22T05:20:00.000Z",
        sourceId: input.sourceId,
        sourceKind: "reanalysis",
        validAt: `${input.startDate}T12:00:00.000Z`,
      },
    ],
    responseMetadata: { http_status: 200 },
  };
}

// prove resume, partial failure, and remaining identities
test("I-ING-07 exact resume skips only success and reports partial failure", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const hydratedSite = {
    ...site,
    sources: site.sources.map((candidate) =>
      candidate.key === "open-meteo-reanalysis-v1"
        ? { ...candidate, fingerprint }
        : candidate,
    ),
  };
  const source = historicalSource(hydratedSite);
  const successful = new Set(["2026-01-01T08:00:00.000Z"]);
  const log = [];
  let fetchCount = 0;
  const report = await executeBackfill(
    {},
    {
      chunkDays: 14,
      dryRun: false,
      from: "2026-01-01",
      reportPath: null,
      resume: true,
      site: "ballydidean",
      source: null,
      to: "2026-02-12",
    },
    hydratedSite,
    source,
    {
      fetchArchive: async (input) => {
        fetchCount += 1;

        // fail the second attempted chunk
        if (fetchCount === 2) {
          throw new ProviderFailure({
            classification: "retryable",
            code: "provider_unavailable",
            message: "stub outage",
          });
        }

        return archiveBatch(input);
      },
      now: () => new Date("2026-08-22T05:20:00.000Z"),
      repository: backfillRepository(log, successful),
    },
  );
  assert.deepEqual(report.chunks.map((chunk) => chunk.status), [
    "skipped",
    "completed",
    "failed",
    "remaining",
  ]);
  assert.equal(report.exitCode, 1);
  assert.equal(fetchCount, 2);
  assert.equal(log.filter((entry) => entry === "start-committed").length, 2);
  assert.equal(log.some((entry) => entry.startsWith("fail:")), true);
});

// retain primary and secondary backfill failures
test("backfill failure retains primary code and redacted finalization diagnostics", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const hydratedSite = {
    ...site,
    sources: site.sources.map((candidate) =>
      candidate.key === "open-meteo-reanalysis-v1"
        ? { ...candidate, fingerprint }
        : candidate,
    ),
  };
  const repository = backfillRepository([]);
  repository.failIngestionRun = async () => {
    throw new Error(
      `postgresql://worker:database-secret@database/weather token backfill-secret ${"x".repeat(700)}`,
    );
  };
  const report = await executeBackfill(
    {},
    {
      chunkDays: 14,
      dryRun: false,
      from: "2026-01-01",
      reportPath: null,
      resume: false,
      site: "ballydidean",
      source: null,
      to: "2026-01-01",
    },
    hydratedSite,
    historicalSource(hydratedSite),
    {
      fetchArchive: async () => {
        throw new ProviderFailure({
          classification: "retryable",
          code: "archive_primary",
          message: "primary failure",
        });
      },
      now: () => new Date("2026-08-22T05:20:00.000Z"),
      repository,
    },
  );

  assert.equal(report.chunks[0].errorCode, "archive_primary");
  assert.match(report.chunks[0].secondaryError, /\[redacted\]/u);
  assert.doesNotMatch(report.chunks[0].secondaryError, /backfill-secret/u);
  assert.doesNotMatch(report.chunks[0].secondaryError, /database-secret/u);
  assert.ok(report.chunks[0].secondaryError.length <= 512);
});

// retain backfill primary and finalization failures when release also fails
test("backfill release failure preserves primary and secondary diagnostics", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const repository = backfillRepository([]);
  repository.failIngestionRun = async () => {
    throw new Error("token=backfill-finalization-secret");
  };
  repository.acquireSourceSession = async () => ({
    // fail session cleanup independently
    release: async () => {
      throw new Error("password: backfill-release-secret");
    },
    sourceId,
  });
  const report = await executeBackfill(
    {},
    {
      chunkDays: 14,
      dryRun: false,
      from: "2026-01-01",
      reportPath: null,
      resume: false,
      site: "ballydidean",
      source: null,
      to: "2026-01-01",
    },
    site,
    historicalSource(site),
    {
      fetchArchive: async () => {
        throw new ProviderFailure({
          classification: "retryable",
          code: "archive_primary",
          message: "primary failure",
        });
      },
      now: () => new Date("2026-08-22T05:20:00.000Z"),
      repository,
    },
  );

  assert.equal(report.chunks[0].errorCode, "archive_primary");
  assert.match(report.chunks[0].secondaryError, /finalization=/u);
  assert.match(report.chunks[0].secondaryError, /release=/u);
  assert.doesNotMatch(
    report.chunks[0].secondaryError,
    /backfill-finalization-secret|backfill-release-secret/u,
  );
});

// reject backfill identity drift before resume reads locks or provider I/O
test("backfill requires exact configured source identity", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const mismatches = [
    { stationSlug: "other-station" },
    { providerKey: "other-provider" },
    { sourceKind: "forecast" },
    { sourceConfigFingerprint: "b".repeat(64) },
    { materialProviderConfig: { contractVersion: "archive-hourly/v2" } },
  ];

  // reject each identity mutation independently
  for (const mismatch of mismatches) {
    let calls = 0;
    const forbidden = async () => {
      calls += 1;
      throw new Error("external call was not expected");
    };

    await assert.rejects(
      executeBackfill(
        {},
        {
          chunkDays: 14,
          dryRun: false,
          from: "2026-01-01",
          reportPath: null,
          resume: true,
          site: "ballydidean",
          source: null,
          to: "2026-01-01",
        },
        site,
        historicalSource(site, mismatch),
        {
          fetchArchive: forbidden,
          repository: {
            abandonExpiredRuns: forbidden,
            acquireSourceSession: forbidden,
            completeBackfillIngestion: forbidden,
            failIngestionRun: forbidden,
            hasSuccessfulBackfillChunk: forbidden,
            startIngestionRun: forbidden,
          },
        },
      ),
      /source identity does not match configuration/u,
    );
    assert.equal(calls, 0);
  }
});
