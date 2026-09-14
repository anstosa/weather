import { createHash } from "node:crypto";

import { RAIN_COLLECTION_STATIONS } from "@weather/domain";

import { createRainAdjustmentRun, rainStationHours } from "../dist/rain-adjustment.js";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const INITIALIZED_AT = "2026-09-14T00:00:00.000Z";
const DECISION_AT = "2026-09-14T08:00:00.000Z";

// build one invented forecast for the actual portable model path
function forecastCapture() {
  const initialized = Date.parse(INITIALIZED_AT);
  const hourly = {
    time: [], temperature_2m: [], relative_humidity_2m: [], cloud_cover: [],
    surface_pressure: [], wind_speed_10m: [], wind_direction_10m: [], precipitation: [],
  };
  // retain the exact provider initialization-plus-48 geometry
  for (let lead = 0; lead <= 48; lead += 1) {
    hourly.time.push(new Date(initialized + lead * HOUR_MS).toISOString().slice(0, 16));
    hourly.temperature_2m.push(12);
    hourly.relative_humidity_2m.push(80);
    hourly.cloud_cover.push(90);
    hourly.surface_pressure.push(1000);
    hourly.wind_speed_10m.push(4);
    hourly.wind_direction_10m.push(180);
    hourly.precipitation.push(0.5);
  }
  const body = Buffer.from(JSON.stringify({ hourly, utc_offset_seconds: 0 }));
  return {
    claimId: "synthetic-forecast", kind: "forecast", stationId: null,
    runInitializedAt: INITIALIZED_AT, windowStart: null, windowEndExclusive: null,
    completedAt: "2026-09-14T06:01:00.000Z",
    bodySha256: createHash("sha256").update(body).digest("hex"), body,
  };
}

// build sixty one-minute reports inside one two-hour source claim
function stationCapture(station, lag, ordinal) {
  const target = Date.parse(DECISION_AT) - lag * HOUR_MS;
  const obs = [];
  // preserve complete tiling for the most recent source hour
  for (let minute = 59; minute >= 0; minute -= 1) {
    obs.push([(target - minute * MINUTE_MS) / 1000, 0, 1, 2, 180, 3, 1000, 12, 80,
      0, 0, 0, 0.01, 0, 0, 0, 2.7, 1, 0, 0, 0, 0]);
  }
  const body = Buffer.from(JSON.stringify({
    status: { status_code: 0 }, type: "obs_st", device_id: station.deviceId, obs,
  }));
  return {
    claimId: `synthetic-${station.locationId}-${ordinal}`, kind: "station",
    stationId: station.locationId, runInitializedAt: null,
    windowStart: new Date(target - 2 * HOUR_MS + 1000).toISOString(),
    windowEndExclusive: new Date(target + 1000).toISOString(),
    completedAt: new Date(target + 3 * MINUTE_MS).toISOString(),
    bodySha256: createHash("sha256").update(body).digest("hex"), body,
  };
}

// exercise the bounded collector history rather than one tiny fixture
const captures = [forecastCapture()];
const lags = [...Array.from({ length: 21 }, (_unused, index) => index + 1), 24];
for (const station of RAIN_COLLECTION_STATIONS) {
  // retain all overlapping source windows per frozen physical gauge
  for (let index = 0; index < lags.length; index += 1) {
    captures.push(stationCapture(station, lags[index], index));
  }
}

const stationHours = rainStationHours(captures.slice(1), DECISION_AT);
const run = createRainAdjustmentRun(captures, DECISION_AT);
// fail the memory test if normalization silently skipped the real inference
if (stationHours.length !== 72 || run?.hours.length !== 23 ||
  !run.hours.every((hour) => hour.applied && Number.isFinite(hour.correctedPrecipitationMm)) ||
  !run.hours.some((hour) => hour.correctedPrecipitationMm !== hour.rawPrecipitationMm)) {
  throw new Error("synthetic rain inference did not produce full model output");
}

process.stdout.write(JSON.stringify({
  captures: captures.length,
  stationRecords: (captures.length - 1) * 60,
  stationHours: stationHours.length,
  modelHours: run.hours.length,
  adjustedHours: run.hours.filter((hour) => hour.correctedPrecipitationMm !== hour.rawPrecipitationMm).length,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
}) + "\n");
