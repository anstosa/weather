import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePublicStationBackfillArguments,
  planPublicStationBackfillChunks,
} from "../dist/index.js";

test("public-station backfill defaults to complete UTC days", () => {
  const parsed = parsePublicStationBackfillArguments(
    ["--site", "ballydidean", "--resume"],
    new Date("2026-08-24T12:00:00.000Z"),
  );

  assert.equal(parsed.to, "2026-08-23");
  assert.equal(parsed.from, null);
  assert.equal(parsed.resume, true);
  assert.deepEqual(parsed.sourceKeys, []);
  assert.throws(
    () =>
      parsePublicStationBackfillArguments(
        ["--site", "ballydidean", "--to", "2026-08-24"],
        new Date("2026-08-24T12:00:00.000Z"),
      ),
    /before today/u,
  );
});

test("public-station backfill uses configured chunk size and identity", () => {
  const source = {
    id: "42",
    source: { adapter: "ambient-weather", maximumChunkDays: 7 },
    sourceConfigFingerprint: "a".repeat(64),
  };
  const chunks = planPublicStationBackfillChunks(
    source,
    "2026-08-01",
    "2026-08-15",
  );

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].startDate, "2026-08-01");
  assert.equal(chunks[0].endDate, "2026-08-07");
  assert.equal(chunks[2].endDate, "2026-08-15");
  assert.equal(chunks[0].identity.sourceId, "42");
  assert.equal(chunks[0].identity.adapterVersion, "ambient-device-data/v1");
});

test("PurpleAir backfill plans exact two-day raw-history chunks", () => {
  const source = {
    id: "43",
    source: { adapter: "purpleair", maximumChunkDays: 2 },
    sourceConfigFingerprint: "b".repeat(64),
  };
  const chunks = planPublicStationBackfillChunks(
    source,
    "2019-01-01",
    "2019-01-05",
  );

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].endDate, "2019-01-02");
  assert.equal(chunks[2].startDate, "2019-01-05");
  assert.equal(chunks[0].identity.adapterVersion, "purpleair-map-history/v1");
});
