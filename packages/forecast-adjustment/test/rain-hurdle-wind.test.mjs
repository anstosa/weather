import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RAIN_COLLECTION_STATIONS } from "@weather/domain";

import {
  RAIN_HURDLE_WIND_MODEL_SHA256,
  buildRainHurdleWindFeatures,
  predictRainHurdleWind,
  predictRainHurdleWindFeatures,
} from "../dist/rain-hurdle-wind.js";

const INITIALIZED_AT = "2026-09-13T00:00:00.000Z";
const DECISION_AT = "2026-09-13T08:00:00.000Z";
const PARITY = JSON.parse(readFileSync(new URL("./rain-hurdle-wind-parity.json", import.meta.url)));
const FEATURE_PARITY = JSON.parse(readFileSync(new URL("./rain-hurdle-wind-feature-parity.json", import.meta.url)));

// construct an invented complete ECMWF source run
function currentRun(temperatureC = 12) {
  return {
    runInitializedAt: INITIALIZED_AT,
    completedAt: "2026-09-13T07:00:00.000Z",
    hours: Array.from({ length: 48 }, (_unused, index) => ({
      leadHours: index + 1,
      precipitationMm: index % 7 === 0 ? 1.2 : 0.3,
      temperatureC,
      relativeHumidityPercent: 90,
      cloudCoverPercent: 85,
      pressureHpa: 1010,
      windSpeedMps: 3,
      windDirectionDegrees: 180,
    })),
  };
}

// construct exactly prior hourly gauge values without target-hour labels
function stationHours() {
  return [1, 2, 3, 6, 12, 24].flatMap((lag) =>
    RAIN_COLLECTION_STATIONS.map((station) => ({
      hourAt: new Date(Date.parse(DECISION_AT) - lag * 3_600_000).toISOString(),
      receivedAt: DECISION_AT,
      stationId: station.locationId,
      precipitationMm: 0.2,
      temperatureC: 11,
    })),
  );
}

// preserve native predictions on synthetic vectors including missing branches
test("portable rain hurdle matches frozen native predictions", () => {
  assert.equal(PARITY.contractVersion, "rain-hurdle-wind-native-parity/v1");
  assert.equal(PARITY.features.length, 40);
  assert.ok(PARITY.nativeFinal.filter((value) => value > 0).length >= 20);
  // compare every native result after all event and category operations
  for (let index = 0; index < PARITY.features.length; index += 1) {
    const features = Float32Array.from(
      PARITY.features[index].map((value) => value === null ? Number.NaN : value),
    );
    assert.ok(
      Math.abs(predictRainHurdleWindFeatures(features) - PARITY.nativeFinal[index]) < 2e-6,
      `native parity row ${index}`,
    );
  }
});

// preserve all 107 native feature calculations on invented source profiles
test("portable rain feature builder matches the frozen native projection", () => {
  const source = FEATURE_PARITY.currentRun;
  const current = {
    initializedMs: Date.parse(source.runInitializedAt),
    completedMs: Date.parse(source.completedAt),
    hours: source.hours,
  };
  const prior = new Map(FEATURE_PARITY.priorRuns.map((run) => [
    Date.parse(run.runInitializedAt),
    { initializedMs: Date.parse(run.runInitializedAt), completedMs: Date.parse(run.completedAt), hours: run.hours },
  ]));
  const stations = new Map();
  // keep one exact synthetic row per station and lagged hour
  for (const row of FEATURE_PARITY.stationHours) {
    const hour = Date.parse(row.hourAt);
    const byStation = stations.get(hour) ?? new Map();
    byStation.set(row.stationId, { precipitationMm: row.precipitationMm, temperatureC: row.temperatureC });
    stations.set(hour, byStation);
  }
  // compare missingness and float32 values across short middle and last leads
  for (let index = 0; index < FEATURE_PARITY.leads.length; index += 1) {
    const actual = buildRainHurdleWindFeatures(current, prior, stations, FEATURE_PARITY.leads[index]);
    const native = FEATURE_PARITY.nativeFeatures[index];
    assert.equal(actual.length, 107);
    for (let column = 0; column < 107; column += 1) {
      const expected = native[column];
      assert.ok(
        expected === null ? Number.isNaN(actual[column]) : Math.abs(actual[column] - expected) < 1e-6,
        `feature row ${index} column ${column}`,
      );
    }
  }
});

// serve genuinely adjusted first-day rain with fixed model provenance
test("rain runtime applies the frozen fit to causal first-day hours", () => {
  const result = predictRainHurdleWind({
    currentRun: currentRun(),
    priorRuns: [],
    stationHours: stationHours(),
    nowUtc: DECISION_AT,
  });
  assert.equal(result.modelSha256, RAIN_HURDLE_WIND_MODEL_SHA256);
  assert.equal(result.decisionAt, DECISION_AT);
  assert.equal(result.hours.length, 23);
  assert.equal(result.hours[0].validAt, "2026-09-13T09:00:00.000Z");
  assert.equal(result.hours[0].modelLeadHours, 9);
  assert.equal(result.hours.at(-1).modelLeadHours, 31);
  assert.ok(result.hours.every((hour) => hour.applied && hour.reasonCode === null));
  assert.ok(result.hours.some((hour) => hour.correctedPrecipitationMm !== hour.rawPrecipitationMm));
  assert.ok(result.hours.every((hour) => hour.correctedPrecipitationMm >= 0 && hour.correctedPrecipitationMm <= 30));
});

// keep cold-phase hours raw rather than extrapolating the trained warm-rain scope
test("rain runtime falls back raw outside the warm-rain phase", () => {
  const result = predictRainHurdleWind({
    currentRun: currentRun(1),
    priorRuns: [],
    stationHours: stationHours(),
    nowUtc: DECISION_AT,
  });
  assert.ok(result.hours.every((hour) =>
    !hour.applied && hour.reasonCode === "phase_unsupported" &&
    hour.correctedPrecipitationMm === hour.rawPrecipitationMm,
  ));
});

// fail closed when the receipt proves the source was late
test("rain runtime rejects unavailable forecast receipts", () => {
  assert.throws(() => predictRainHurdleWind({
    currentRun: { ...currentRun(), completedAt: "2026-09-13T08:00:01.000Z" },
    priorRuns: [],
    stationHours: stationHours(),
    nowUtc: "2026-09-13T08:00:02.000Z",
  }), /receipt unavailable/);
});

// fail closed when an observation arrives after the fixed decision
test("rain runtime rejects future station receipts", () => {
  const rows = stationHours();
  rows[0] = { ...rows[0], receivedAt: "2026-09-13T08:00:01.000Z" };
  assert.throws(() => predictRainHurdleWind({
    currentRun: currentRun(), priorRuns: [], stationHours: rows, nowUtc: DECISION_AT,
  }), /station value unavailable/);
});

// reject broken vectors before any native tree traversal
test("rain runtime rejects malformed finite feature inputs", () => {
  assert.throws(() => predictRainHurdleWindFeatures(new Float32Array(106)), /feature vector invalid/);
  const invalid = new Float32Array(107);
  invalid[5] = Number.POSITIVE_INFINITY;
  assert.throws(() => predictRainHurdleWindFeatures(invalid), /feature vector invalid/);
});
