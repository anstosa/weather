import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  listPendingPhysicalWeatherAdjustmentRevisions,
} from "../dist/index.js";

// create one exact stored post-epoch physical sample
function physicalRow(index, overrides = {}) {
  return {
    adapterVersion: "ecowitt-local-live/v1",
    apparentTemperatureC: 10,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    contentHash: createHash("sha256").update(`physical-${index}`).digest("hex"),
    deviceModel: null,
    deviceSerial: null,
    deviceVendor: null,
    logicalReceivedAt: new Date(Date.parse("2026-10-09T00:00:00.000Z") + index * 60_000),
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: 0,
    precipitationRateMmPerHour: null,
    pressureHpa: 1_010,
    providerKey: "ecowitt-local",
    providerMetadata: null,
    qualityMetadata: null,
    receivedAt: new Date(Date.parse("2026-10-09T00:00:30.000Z") + index * 60_000),
    relativeHumidityPercent: 80,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    sourceConfigFingerprint: "a".repeat(64),
    sourceId: "7",
    sourceKey: "ecowitt-88f15505d89f-local-live-v1",
    temperatureC: 11,
    upstreamModel: null,
    upstreamTimezone: "UTC",
    uvIndex: null,
    validAt: new Date(Date.parse("2026-10-09T00:00:00.000Z") + index * 60_000),
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: 180,
    windGustMps: 8,
    windSpeedMps: 5,
    ...overrides,
  };
}

test("physical revision custody waits for 168 rows and never reads before the epoch", async () => {
  const calls = [];
  const queryable = {
    // return one complete post-epoch source group
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: Array.from({ length: 168 }, (_unused, index) => physicalRow(index)) };
    },
  };
  const rows = await listPendingPhysicalWeatherAdjustmentRevisions(
    queryable,
    "7",
    "2026-10-09T00:00:00.000Z",
  );
  assert.equal(rows.length, 168);
  assert.deepEqual(calls[0].values, ["7", "2026-10-09T00:00:00.000Z"]);
  assert.match(calls[0].sql, /adjustment_revision_receipt IS NULL/u);
  assert.match(calls[0].sql, /wr\.first_received_at AS "logicalReceivedAt"/u);
  assert.match(calls[0].sql, /wr\.first_received_at >= \$2/u);
  assert.match(calls[0].sql, /wr\.valid_at >= \$2/u);
  assert.equal(rows[0].logicalReceivedAt, "2026-10-09T00:00:00.000Z");
  assert.equal(rows[0].record.validAt, "2026-10-09T00:00:00.000Z");
  assert.equal(rows.at(-1).record.validAt, "2026-10-09T02:47:00.000Z");
});

test("physical revision custody defers partial stable groups but closes a lineage boundary", async () => {
  const stable = await listPendingPhysicalWeatherAdjustmentRevisions({
    async query() {
      return { rows: Array.from({ length: 167 }, (_unused, index) => physicalRow(index)) };
    },
  }, "7", "2026-10-09T00:00:00.000Z");
  assert.deepEqual(stable, []);
  const boundary = await listPendingPhysicalWeatherAdjustmentRevisions({
    async query() {
      return { rows: [
        ...Array.from({ length: 5 }, (_unused, index) => physicalRow(index)),
        physicalRow(5, { sourceConfigFingerprint: "b".repeat(64) }),
      ] };
    },
  }, "7", "2026-10-09T00:00:00.000Z");
  assert.equal(boundary.length, 5);
});
