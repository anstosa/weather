import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { RAIN_COLLECTION_STATIONS } from "@weather/domain";

import {
  RAIN_HURDLE_WIND_MODEL_SHA256,
  buildRainHurdleWindFeatures,
  createRainHurdleWindPortableArtifactEvaluator,
  predictRainHurdleWind,
  predictRainHurdleWindFeaturesWithProbabilities,
  predictRainHurdleWindFeatures,
  predictRainHurdleWindPerformance,
  validateRainHurdleWindPortableArtifact,
} from "../dist/rain-hurdle-wind.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
  RAIN_HURDLE_WIND_ARTIFACT_SHA256,
} from "../dist/rain-hurdle-wind-artifact.js";

const INITIALIZED_AT = "2026-09-13T00:00:00.000Z";
const DECISION_AT = "2026-09-13T08:00:00.000Z";
const PARITY = JSON.parse(readFileSync(new URL("./rain-hurdle-wind-parity.json", import.meta.url)));
const FEATURE_PARITY = JSON.parse(readFileSync(new URL("./rain-hurdle-wind-feature-parity.json", import.meta.url)));

// hash one exact invented portable artifact string
function artifactSha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// strip incumbent-only provenance from one public portable candidate
function publicArtifact() {
  const { nativeModelSha256: _native, provenanceSha256: _provenance, ...artifact } =
    JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON);
  return artifact;
}

// construct one additive selected-arm artifact without incumbent provenance
function publicArtifactV2(projectionId) {
  return {
    ...publicArtifact(),
    contractVersion: "rain-hurdle-wind-runtime/v2",
    projectionId,
  };
}

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

// keep runtime validation month-independent while preserving numerical parity
test("portable rain artifact validator accepts a later model month and injects an exact evaluator", () => {
  const source = publicArtifact();
  const laterJson = JSON.stringify({ ...source, modelMonth: "2027-01" });
  const validated = validateRainHurdleWindPortableArtifact(laterJson, artifactSha256(laterJson));
  const evaluate = createRainHurdleWindPortableArtifactEvaluator(
    JSON.stringify(source),
    artifactSha256(JSON.stringify(source)),
  );
  const features = Float32Array.from(
    PARITY.features[0].map((value) => value === null ? Number.NaN : value),
  );
  assert.equal(validated.modelMonth, "2027-01");
  assert.deepEqual(evaluate(features), predictRainHurdleWindFeaturesWithProbabilities(features));
});

// reject malformed clocks and numerical rule shapes before evaluation
test("portable rain artifact validator rejects malformed public fields", () => {
  const source = publicArtifact();
  const invalidMonth = JSON.stringify({ ...source, modelMonth: "2027-13" });
  const invalidRules = JSON.stringify({ ...source, rules: [{ threshold: 0.1, cutoff: "bad" }] });
  assert.throws(
    () => validateRainHurdleWindPortableArtifact(invalidMonth, artifactSha256(invalidMonth)),
    /schema mismatch/,
  );
  assert.throws(
    () => validateRainHurdleWindPortableArtifact(invalidRules, artifactSha256(invalidRules)),
    /schema mismatch/,
  );
});

// apply v3 selected-arm semantics in the actual portable serving evaluator
test("portable rain v2 evaluator preserves selected arms and event guards", () => {
  const exactJson = JSON.stringify(publicArtifactV2("R0_exact_refit"));
  const winterJson = JSON.stringify(publicArtifactV2("R1_winter_scale_0_90"));
  const springJson = JSON.stringify(publicArtifactV2("R3_spring_wet_logit_plus_0_20"));
  const nestedJson = JSON.stringify(publicArtifactV2("R5_nested_cumulative_min"));
  const exact = createRainHurdleWindPortableArtifactEvaluator(
    exactJson,
    artifactSha256(exactJson),
  );
  const winter = createRainHurdleWindPortableArtifactEvaluator(
    winterJson,
    artifactSha256(winterJson),
  );
  const spring = createRainHurdleWindPortableArtifactEvaluator(
    springJson,
    artifactSha256(springJson),
  );
  const nested = createRainHurdleWindPortableArtifactEvaluator(
    nestedJson,
    artifactSha256(nestedJson),
  );
  const features = Float32Array.from(
    PARITY.features[4].map((value) => value === null ? Number.NaN : value),
  );
  const winterAt = "2027-01-15T12:00:00.000Z";
  const springAt = "2027-04-15T12:00:00.000Z";
  assert.equal(winter(features, winterAt).correctedPrecipitationMm,
    exact(features, winterAt).correctedPrecipitationMm * 0.90);
  assert.ok(spring(features, springAt).occurrenceProbabilityAtLeast0_1 >
    exact(features, springAt).occurrenceProbabilityAtLeast0_1);
  const nestedPrediction = nested(features, springAt);
  assert.ok(nestedPrediction.occurrenceProbabilityAtLeast1_0 <=
    nestedPrediction.occurrenceProbabilityAtLeast0_1);
  assert.ok(nestedPrediction.occurrenceProbabilityAtLeast2_5 <=
    nestedPrediction.occurrenceProbabilityAtLeast1_0);
  const heavy = Float32Array.from(features);
  heavy[5] = 50;
  assert.equal(winter(heavy, winterAt).correctedPrecipitationMm, 50);
  const wet = Float32Array.from(features);
  wet[5] = 0.5;
  assert.ok(winter(wet, winterAt).correctedPrecipitationMm >= 0.1);
  assert.throws(() => exact(features), /validAt is required/);
});

test("rain performance helper exposes only named binary probabilities with amount parity", () => {
  for (let index = 0; index < PARITY.features.length; index += 1) {
    const features = Float32Array.from(
      PARITY.features[index].map((value) => value === null ? Number.NaN : value),
    );
    const performance = predictRainHurdleWindFeaturesWithProbabilities(features);
    assert.equal(
      performance.correctedPrecipitationMm,
      predictRainHurdleWindFeatures(features),
    );
    assert.ok(performance.occurrenceProbabilityAtLeast0_1 >= 0 &&
      performance.occurrenceProbabilityAtLeast0_1 <= 1);
    assert.ok(performance.occurrenceProbabilityAtLeast1_0 >= 0 &&
      performance.occurrenceProbabilityAtLeast1_0 <= 1);
    assert.ok(performance.occurrenceProbabilityAtLeast2_5 >= 0 &&
      performance.occurrenceProbabilityAtLeast2_5 <= 1);
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
  const input = {
    currentRun: currentRun(),
    priorRuns: [],
    stationHours: stationHours(),
    nowUtc: DECISION_AT,
  };
  const result = predictRainHurdleWind(input);
  const performance = predictRainHurdleWindPerformance(input);
  assert.equal(result.modelSha256, RAIN_HURDLE_WIND_MODEL_SHA256);
  assert.equal(result.decisionAt, DECISION_AT);
  assert.equal(result.hours.length, 23);
  assert.equal(result.hours[0].validAt, "2026-09-13T09:00:00.000Z");
  assert.equal(result.hours[0].modelLeadHours, 9);
  assert.equal(result.hours.at(-1).modelLeadHours, 31);
  assert.ok(result.hours.every((hour) => hour.applied && hour.reasonCode === null));
  assert.ok(result.hours.some((hour) => hour.correctedPrecipitationMm !== hour.rawPrecipitationMm));
  assert.ok(result.hours.every((hour) => hour.correctedPrecipitationMm >= 0 && hour.correctedPrecipitationMm <= 30));
  assert.deepEqual(
    performance.hours.map(({ occurrenceProbabilities: _unused, positiveAmountMm: _positive, ...hour }) => hour),
    result.hours,
  );
  assert.ok(performance.hours.every((hour) => hour.occurrenceProbabilities !== null));
  assert.ok(performance.hours.every((hour) => hour.positiveAmountMm > 0 && hour.positiveAmountMm <= 30));
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
