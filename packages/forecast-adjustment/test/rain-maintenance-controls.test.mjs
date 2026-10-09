import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
  RAIN_MAINTENANCE_CONTROL_STATE_VERSION,
  canonicalJsonBytes,
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  evaluateRainMaintenanceControls,
  parseRainMaintenanceControlState,
} from "../dist/index.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
} from "../dist/rain-hurdle-wind-artifact.js";

// strip only the incumbent's legacy provenance extension
function portableArtifactBytes() {
  const { nativeModelSha256: _native, provenanceSha256: _provenance, ...artifact } =
    JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON);
  return Buffer.from(canonicalJsonBytes(artifact));
}

// construct one supported future-only monthly state
function controlState(overrides = {}) {
  const artifactBytes = portableArtifactBytes();
  return createRainMaintenanceControlState({
    calibrationEndAt: "2026-07-25T00:00:00.000Z",
    calibrationStartAt: "2026-04-26T00:00:00.000Z",
    contractVersion: RAIN_MAINTENANCE_CONTROL_STATE_VERSION,
    epochWitnessSha256: "1".repeat(64),
    generatedAt: "2026-07-26T00:00:00.000Z",
    legacyCalibrationStartAt: "2026-06-10T00:00:00.000Z",
    legacyRawScale: 1.25,
    modelMonth: "2026-08",
    ordinalArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
    recentFallbackReason: "recent_calibration",
    recentRawScale: 1.5,
    recentSupported: true,
    recipeSha256: RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
    sameWindowRawScale: 1.4,
    scheduleContractSha256: "2".repeat(64),
    sourceMemberRootSha256: "3".repeat(64),
    sourceReceiptRootSha256: "4".repeat(64),
    support: {
      calibrationDates: 90,
      calibrationHours: 1_500,
      calibrationRows: 2_000,
      calibrationWetDates: 20,
      calibrationWetHours: 100,
      effectiveDates64: "4044000000000000",
      effectiveWetDates64: "4014000000000000",
      legacyCalibrationRows: 1_000,
      legacyTrainingRows: 5_000,
      legacyTrainingWetRows: 500,
      trainingDates: 300,
      trainingHours: 5_000,
      trainingRows: 6_000,
      trainingWetDates: 50,
      trainingWetHours: 500,
    },
    trainingMaximumValidAt: "2026-04-18T23:00:00.000Z",
    ...overrides,
  });
}

test("rain control state roundtrips one canonical self-addressed artifact", () => {
  const state = controlState();
  const bytes = encodeRainMaintenanceControlState(state);
  assert.deepEqual(parseRainMaintenanceControlState(bytes), state);
  assert.equal(createHash("sha256").update(bytes).digest("hex").length, 64);
  assert.throws(
    () => parseRainMaintenanceControlState(Buffer.concat([bytes, Buffer.from("\n")])),
    /not canonical/,
  );
});

test("rain controls replay the exact retained scalar and ordinal recipes", () => {
  const state = controlState();
  const artifactBytes = portableArtifactBytes();
  const features = new Float32Array(107);
  features[5] = Math.fround(2);
  const values = evaluateRainMaintenanceControls({
    artifactBytes,
    features,
    persistencePrediction: 0.75,
    rawPrecipitationMm: 2,
    state,
  });
  assert.equal(values.volumeScalePrediction, 2.5);
  assert.equal(values.sameWindowVolumeScalePrediction, 2.8);
  assert.equal(values.recentVolumeScalePrediction, 3);
  assert.equal(values.persistencePrediction, 0.75);
  assert.equal(values.persistenceReason, "causal_target");
  assert.deepEqual(values.nativeSourceProbability, {
    atLeast0_1: 1,
    atLeast1_0: 1,
    atLeast2_5: 0,
  });
  assert.ok(Number.isFinite(values.unchangedOrdinalPrediction));
  assert.ok(values.unchangedOrdinalPrediction >= 0 && values.unchangedOrdinalPrediction <= 30);
});

test("rain controls retain the exact unsupported recent and persistence fallbacks", () => {
  const support = controlState().support;
  const state = controlState({
    recentFallbackReason: "insufficient_effective_support",
    recentRawScale: 1.4,
    recentSupported: false,
    support: {
      ...support,
      effectiveDates64: "4034000000000000",
      effectiveWetDates64: "3ff0000000000000",
    },
  });
  const features = new Float32Array(107);
  features[5] = Math.fround(0.2);
  const values = evaluateRainMaintenanceControls({
    artifactBytes: portableArtifactBytes(),
    features,
    persistencePrediction: null,
    rawPrecipitationMm: 0.2,
    state,
  });
  assert.equal(values.recentVolumeScalePrediction, values.sameWindowVolumeScalePrediction);
  assert.equal(values.persistencePrediction, 0.2);
  assert.equal(values.persistenceReason, "raw_fallback_unavailable");
  const commonUnsupported = controlState({
    recentFallbackReason: "insufficient_effective_support",
    recentRawScale: 1.4,
    recentSupported: false,
    support: { ...support, trainingDates: 179 },
  });
  assert.equal(commonUnsupported.recentSupported, false);
  assert.equal(commonUnsupported.recentRawScale64, commonUnsupported.sameWindowRawScale64);
});

test("rain control state rejects weakened support and mismatched ordinal bytes", () => {
  assert.throws(
    () => controlState({
      support: { ...controlState().support, calibrationDates: 59 },
    }),
    /support differs/,
  );
  const state = controlState();
  const artifact = JSON.parse(portableArtifactBytes().toString("utf8"));
  artifact.modelMonth = "2026-09";
  const artifactBytes = Buffer.from(canonicalJsonBytes(artifact));
  const features = new Float32Array(107);
  features[5] = Math.fround(1);
  assert.throws(
    () => evaluateRainMaintenanceControls({
      artifactBytes,
      features,
      persistencePrediction: 1,
      rawPrecipitationMm: 1,
      state,
    }),
    /ordinal artifact differs/,
  );
});
