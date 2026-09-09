import assert from "node:assert/strict";
import test from "node:test";
import { captureResponse, identities, observationInput, STATIONS, validateBatch } from "./acquire_rain_stations.mjs";

import { buildTempestObservationRequest } from "../../packages/providers/dist/tempest.js";

// freeze two-year-plus daily scope and unique station identities
test("station acquisition includes every selected station day", () => {
  const rows = identities();
  assert.equal(rows.length, 4520);
  assert.equal(new Set(rows.map((row) => `${row.stationId}|${row.date}`)).size, 4520);
  assert.equal(rows[0].date, "2024-03-13");
  assert.equal(rows.at(-1).date, "2026-09-02");
  assert.equal(new Set(STATIONS).size, 5);
});

// retain exact response bytes for independent parsing
test("response capture is byte preserving", async () => {
  assert.deepEqual(await captureResponse(new Response("{\"obs\":[]}")), Buffer.from("{\"obs\":[]}"));
});

// reject oversized responses before normalization
test("response capture enforces the adapter bound", async () => {
  await assert.rejects(captureResponse(new Response(new Uint8Array(10000001))), /exceeds bound/u);
});

// require the exact station and half-open observation interval
test("station validation rejects identity drift and duplicates", () => {
  const identity = identities()[0];
  const station = { deviceId: 123 };
  const row = { sourceId: `research-tempest-${identity.stationId}`, validAt: identity.start, metadata: { provider: { device_id: 123, location_id: identity.stationId } } };
  assert.equal(validateBatch({ records: [row] }, identity, station).records.length, 1);
  assert.throws(() => validateBatch({ records: [row, row] }, identity, station), /identity changed/u);
  assert.throws(() => validateBatch({ records: [{ ...row, validAt: identity.end }] }, identity, station), /identity changed/u);
  assert.throws(() => validateBatch({ records: [{ ...row, sourceId: "other" }] }, identity, station), /identity changed/u);
});

// preserve the adapter's exclusive ending boundary and one-day limit
test("daily inputs use the actual adapter contract", () => {
  const identity = identities()[0];
  const input = observationInput(identity, { locationId: identity.stationId, deviceId: 123, serial: "fixture", timezone: "America/Los_Angeles" }, "synthetic-only");
  const plan = buildTempestObservationRequest(input);
  assert.equal(Number(plan.url.searchParams.get("time_end")) - Number(plan.url.searchParams.get("time_start")), 86399);
});
