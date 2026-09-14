import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createRainAdjustmentRun, rainForecastProfile, rainStationHours } from "../dist/rain-adjustment.js";

const decisionAt = "2026-09-14T08:00:00.000Z";

// preserve exact minute intervals in an overlapping two-hour provider window
function stationCapture({ missing = -1, received = "2026-09-14T07:03:00.000Z", amount = 0.01 } = {}) {
  const start = Date.parse("2026-09-14T05:00:00.000Z");
  const obs = [];
  // emit one complete minute-by-minute response without daily counter substitution
  for (let minute = 1; minute <= 120; minute += 1) {
    // leave one requested gap explicit
    if (minute === missing) continue;
    obs.push([(start + minute * 60_000) / 1000, 0, 1, 2, 180, 3, 1000, 12, 80,
      0, 0, 0, amount, 0, 0, 0, 2.7, 1, 0, 0, 0, 0]);
  }
  const body = Buffer.from(JSON.stringify({ status: { status_code: 0 }, type: "obs_st", device_id: 175727, obs }));
  return { claimId: "gauge", kind: "station", stationId: 64255, runInitializedAt: null,
    windowStart: "2026-09-14T05:00:01.000Z", windowEndExclusive: "2026-09-14T07:00:01.000Z",
    completedAt: received, bodySha256: createHash("sha256").update(body).digest("hex"), body };
}

// construct a source-shaped profile independent of the native model fixtures
function forecastCapture() {
  const runInitializedAt = "2026-09-14T00:00:00.000Z";
  const hourly = { time: [], temperature_2m: [], relative_humidity_2m: [], cloud_cover: [],
    surface_pressure: [], wind_speed_10m: [], wind_direction_10m: [], precipitation: [] };
  // retain all 49 provider timestamps including initialization
  for (let lead = 0; lead <= 48; lead += 1) {
    hourly.time.push(new Date(Date.parse(runInitializedAt) + lead * 3_600_000).toISOString().slice(0, 16));
    hourly.temperature_2m.push(12); hourly.relative_humidity_2m.push(80);
    hourly.cloud_cover.push(90); hourly.surface_pressure.push(1000);
    hourly.wind_speed_10m.push(4); hourly.wind_direction_10m.push(180);
    hourly.precipitation.push(0.5);
  }
  const body = Buffer.from(JSON.stringify({ hourly, utc_offset_seconds: 0 }));
  return { claimId: "forecast", kind: "forecast", stationId: null, runInitializedAt,
    windowStart: null, windowEndExclusive: null, completedAt: "2026-09-14T06:01:00.000Z",
    bodySha256: createHash("sha256").update(body).digest("hex"), body };
}

// complete hours require all reported intervals and retain actual receipt availability
test("rain station aggregation deduplicates overlaps without filling interval gaps", () => {
  const first = stationCapture();
  const later = stationCapture({ received: "2026-09-14T07:10:00.000Z" });
  const full = rainStationHours([first, later], decisionAt);
  const hour = full.find((item) => item.hourAt === "2026-09-14T07:00:00.000Z");
  assert.ok(Math.abs(hour.precipitationMm - 0.6) < 1e-12);
  assert.equal(hour.receivedAt, first.completedAt);
  assert.equal(hour.temperatureC, 12);
  assert.equal(full.some((item) => item.stationId !== 64255), false);
  const missing = rainStationHours([stationCapture({ missing: 90 })], decisionAt);
  assert.equal(missing.find((item) => item.hourAt === hour.hourAt).precipitationMm, null);
});

// future reports cannot repair a historical decision and conflicts cannot be cherry-picked
test("rain aggregation excludes late receipts and rejects contradictory gauge revisions", () => {
  assert.deepEqual(rainStationHours([stationCapture({ received: "2026-09-14T08:01:00.000Z" })], decisionAt), []);
  assert.throws(() => rainStationHours([stationCapture(), stationCapture({ amount: 0.02 })], decisionAt), /conflicting/u);
});

// source identity must survive provider decoding before any portable inference
test("rain profile and genuine model output preserve initialized hourly scope", () => {
  const capture = forecastCapture();
  const profile = rainForecastProfile(capture);
  assert.equal(profile.hours.length, 48);
  assert.equal(profile.hours[0].leadHours, 1);
  const run = createRainAdjustmentRun([capture, stationCapture()], "2026-09-14T08:05:00.000Z");
  assert.equal(run.decisionAt, decisionAt);
  assert.equal(run.hours.length, 23);
  assert.equal(run.hours[0].modelLeadHours, 9);
  assert.equal(run.hours.at(-1).modelLeadHours, 31);
  assert.equal(run.hours.every((hour) => hour.applied && Number.isFinite(hour.correctedPrecipitationMm)), true);
  assert.equal(run.hours.some((hour) => hour.correctedPrecipitationMm !== hour.rawPrecipitationMm), true);
  assert.equal(JSON.stringify(run).includes('"body"'), false);
  assert.equal(createRainAdjustmentRun([], decisionAt), null);
  assert.throws(() => createRainAdjustmentRun([capture], "2026-09-14T07:59:00.000Z"), /matured/u);
  const bad = JSON.parse(capture.body);
  bad.hourly.time[9] = "2026-09-14T10:00";
  assert.throws(() => rainForecastProfile({ ...capture, body: Buffer.from(JSON.stringify(bad)) }), /hour mismatch/u);
});
