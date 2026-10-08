import assert from "node:assert/strict";
import test from "node:test";
import { RAIN_HURDLE_WIND_MODEL_SHA256 } from "@weather/forecast-adjustment";
import { RAIN_HURDLE_WIND_ARTIFACT_SHA256 } from "../../../packages/forecast-adjustment/dist/rain-hurdle-wind-artifact.js";
import { rainAdjustmentDecision, rainAdjustmentRuntime, validRainAdjustmentRun } from "../dist/rain-adjustment.js";

const now = "2026-09-14T08:05:00.000Z";

// bind one public-safe snapshot to the exact shipped model
function run() {
  return { runInitializedAt: "2026-09-14T00:00:00.000Z", firstReceivedAt: "2026-09-14T06:00:00.000Z",
    decisionAt: "2026-09-14T08:00:00.000Z", generatedAt: now,
    modelSha256: RAIN_HURDLE_WIND_MODEL_SHA256, inputSha256: "a".repeat(64), forecastClaimId: "private-claim",
    hours: [{ validAt: "2026-09-14T09:00:00.000Z", modelLeadHours: 9,
      rawPrecipitationMm: 0.5, correctedPrecipitationMm: 0.25, applied: true, reasonCode: null }] };
}

// a valid sidecar supplies rain only and retains the original Best Match amount
test("rain decisions retain raw identity and expose only actual model correction", () => {
  const source = run();
  const decision = rainAdjustmentDecision(source, source.hours[0].validAt, 0.6, now);
  assert.equal(decision.state, "active");
  assert.equal(decision.correctedPrecipitationMm, 0.25);
  assert.equal(decision.rawBestMatchPrecipitationMm, 0.6);
  assert.equal(decision.sourceForecast.rawPrecipitationMm, 0.5);
  assert.equal(decision.sourceForecast.modelLeadHours, 9);
  assert.equal(JSON.stringify(decision).includes("private-claim"), false);
  assert.equal(rainAdjustmentRuntime(source, now).state, "active");
  assert.equal(rainAdjustmentDecision(source, "2026-09-15T12:00:00.000Z", 0.6, now).state, "raw_fallback");
});

// malformed, stale and late sources cannot silently become active
test("rain validation fails raw for stale, unbound, future and malformed outputs", () => {
  const source = run();
  // independently violate every required source/output boundary
  for (const changed of [
    null, { ...source, modelSha256: "0".repeat(64) },
    { ...source, firstReceivedAt: "2026-09-14T08:01:00.000Z" },
    { ...source, generatedAt: "2026-09-14T08:06:00.000Z" },
    { ...source, decisionAt: "2026-09-14T07:00:00.000Z" },
    { ...source, hours: [source.hours[0], source.hours[0]] },
    { ...source, hours: [{ ...source.hours[0], correctedPrecipitationMm: -1 }] },
    { ...source, hours: [{ ...source.hours[0], correctedPrecipitationMm: 31 }] },
    { ...source, hours: [{ ...source.hours[0], modelLeadHours: 8 }] },
  ]) {
    assert.equal(validRainAdjustmentRun(changed, now), false);
    assert.equal(rainAdjustmentDecision(changed, source.hours[0].validAt, 0.6, now).correctedPrecipitationMm, null);
  }
  assert.equal(validRainAdjustmentRun(source, "2026-09-14T20:00:00.000Z"), false);
  assert.equal(rainAdjustmentDecision(source, source.hours[0].validAt, null, now).state, "raw_fallback");
});

// policy selection must override every retained adjusted sidecar
test("rain registry raw and invalid states retain Best Match without sidecar use", () => {
  const source = run();
  // prove both explicit disabled causes independently
  for (const reasonCode of ["policy_raw", "registry_invalid"]) {
    const selection = {
      loadedAt: "2026-09-14T07:59:00.000Z",
      runtime: { artifactSha256: null, reasonCode, state: "disabled" },
    };
    assert.deepEqual(
      rainAdjustmentDecision(
        source,
        source.hours[0].validAt,
        0.6,
        now,
        selection,
      ),
      {
        bundleSha256: null,
        contractVersion: "forecast-rain-adjustment-decision/v1",
        correctedPrecipitationMm: null,
        rawBestMatchPrecipitationMm: 0.6,
        reasonCode,
        sourceForecast: null,
        state: "disabled",
      },
    );
    assert.deepEqual(rainAdjustmentRuntime(source, now, selection), {
      activeBundle: null,
      loadedAt: selection.loadedAt,
      reasonCode,
      source: null,
      state: "disabled",
    });
  }
});

// active selection must preserve the legacy adjusted decision
test("active rain registry is behaviorally equivalent to legacy selection", () => {
  const source = run();
  const selection = {
    loadedAt: "2026-09-14T07:59:00.000Z",
    runtime: {
      artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
      reasonCode: null,
      state: "active",
    },
  };
  assert.deepEqual(
    rainAdjustmentDecision(
      source,
      source.hours[0].validAt,
      0.6,
      now,
      selection,
    ),
    rainAdjustmentDecision(source, source.hours[0].validAt, 0.6, now),
  );
  assert.deepEqual(rainAdjustmentRuntime(source, now, selection), {
    ...rainAdjustmentRuntime(source, now),
    loadedAt: selection.loadedAt,
  });
});
