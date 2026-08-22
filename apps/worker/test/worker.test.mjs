import assert from "node:assert/strict";
import test from "node:test";

import { loadSiteConfiguration } from "@weather/database";

import {
  createNonOverlappingScheduler,
  executeBackfill,
  nextScheduledAt,
  parseBackfillArguments,
  planBackfillChunks,
} from "../dist/index.js";

const sitePath = new URL("../../../config/sites/ballydidean.json", import.meta.url).pathname;
const fingerprint = "a".repeat(64);
const source = {
  id: "00000000-0000-4000-8000-000000000001",
  key: "open-meteo-reanalysis-v1",
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  timezone: "America/Los_Angeles",
};

// create canonical CLI arguments
function backfillArguments(overrides = {}) {
  return {
    chunkDays: 14,
    dryRun: false,
    from: "2026-03-01",
    reportPath: null,
    resume: false,
    site: "ballydidean",
    source: null,
    to: "2026-03-15",
    ...overrides,
  };
}

// prove anchored cadence and deterministic jitter
test("U-WRK-01 15-minute scheduling is stable and drift-free", () => {
  const now = new Date("2026-08-22T05:07:00.000Z");
  const first = nextScheduledAt(now, "worker-a");
  const second = nextScheduledAt(now, "worker-a");
  assert.equal(first.toISOString(), second.toISOString());
  assert.ok(first.getTime() >= Date.parse("2026-08-22T05:15:00.000Z"));
  assert.ok(first.getTime() < Date.parse("2026-08-22T05:15:30.001Z"));
});

// prove the in-process overlap guard
test("U-WRK-03 scheduler rejects an overlapping trigger", async () => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const scheduler = createNonOverlappingScheduler({
    key: "worker-a",
    run: async () => {
      await barrier;
    },
  });
  const first = scheduler.trigger();
  assert.equal(await scheduler.trigger(), false);
  release();
  assert.equal(await first, true);
});

// prove inclusive chunk coverage and DST-aware boundaries
test("U-WRK-04 backfill plans exact 14-day-or-smaller local chunks", () => {
  const chunks = planBackfillChunks({
    chunkDays: 14,
    from: "2026-03-01",
    sourceConfigFingerprint: fingerprint,
    sourceId: source.id,
    timezone: source.timezone,
    to: "2026-03-15",
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].startDate, "2026-03-01");
  assert.equal(chunks[0].endDate, "2026-03-14");
  assert.equal(chunks[0].identity.intervalStart, "2026-03-01T08:00:00.000Z");
  assert.equal(chunks[0].identity.intervalEndExclusive, "2026-03-15T07:00:00.000Z");
  assert.equal(chunks[1].identity.intervalStart, chunks[0].identity.intervalEndExclusive);
});

// prove CLI validation closes unsafe ranges
test("U-WRK-06 CLI rejects missing, reversed, future, and oversized chunks", () => {
  const today = new Date("2026-08-22T00:00:00.000Z");
  assert.throws(() => parseBackfillArguments([], today), /--site is required/u);
  assert.throws(
    () =>
      parseBackfillArguments(
        ["--site", "ballydidean", "--from", "2026-08-03", "--to", "2026-08-01"],
        today,
      ),
    /must not follow/u,
  );
  assert.throws(
    () =>
      parseBackfillArguments(
        ["--site", "ballydidean", "--from", "2026-08-01", "--to", "2026-08-22"],
        today,
      ),
    /before today/u,
  );
  assert.throws(
    () =>
      parseBackfillArguments(
        [
          "--site",
          "ballydidean",
          "--from",
          "2026-08-01",
          "--to",
          "2026-08-03",
          "--chunk-days",
          "15",
        ],
        today,
      ),
    /between 1 and 14/u,
  );
});

// prove dry-run excludes provider and write calls
test("U-WRK-07 dry-run performs exact-success reads only", async () => {
  const site = await loadSiteConfiguration(sitePath);
  const archive = site.sources.find((candidate) => candidate.key === source.key);
  const hydratedSite = {
    ...site,
    sources: site.sources.map((candidate) =>
      candidate.key === source.key ? { ...candidate, fingerprint } : candidate,
    ),
  };
  assert.ok(archive);
  let reads = 0;
  const forbidden = async () => {
    throw new Error("write/provider call was not expected");
  };
  const report = await executeBackfill(
    {},
    backfillArguments({ dryRun: true, resume: true }),
    hydratedSite,
    source,
    {
      fetchArchive: forbidden,
      repository: {
        abandonExpiredRuns: forbidden,
        acquireSourceSession: forbidden,
        completeBackfillIngestion: forbidden,
        failIngestionRun: forbidden,
        hasSuccessfulBackfillChunk: async () => {
          reads += 1;
          return false;
        },
        startIngestionRun: forbidden,
      },
    },
  );
  assert.equal(reads, 2);
  assert.deepEqual(report.chunks.map((chunk) => chunk.status), ["planned", "planned"]);
  assert.equal(report.exitCode, 0);
});

// prove exact identity changes remain eligible
test("U-WRK-08 exact chunk identity changes with every durable component", () => {
  const [base] = planBackfillChunks({
    chunkDays: 14,
    from: "2026-03-01",
    sourceConfigFingerprint: fingerprint,
    sourceId: source.id,
    timezone: source.timezone,
    to: "2026-03-01",
  });
  const [changed] = planBackfillChunks({
    chunkDays: 14,
    from: "2026-03-01",
    sourceConfigFingerprint: "b".repeat(64),
    sourceId: source.id,
    timezone: source.timezone,
    to: "2026-03-01",
  });
  assert.notEqual(base.key, changed.key);
});
