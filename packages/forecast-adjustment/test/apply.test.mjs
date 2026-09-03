import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyForecastAdjustment,
  createForecastAdjustmentRuntimeBundle,
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  runtimeCalendarFingerprint,
} from "../dist/index.js";

import { createQualifiedFixture } from "./evidence-fixtures.mjs";

// build one complete canonical raw metric map
function metrics(temperatureC) {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: 70,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: 1013,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps: null,
    windSpeedMps: 2,
  };
}

// build one exact v4 retrieval identity
function provenance() {
  return {
    ...FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
    referenceAt: "2026-03-01T00:30:00.000Z",
    targetLeadHours: 24,
    validAt: "2026-03-02T00:00:00.000Z",
  };
}

test("application adjusts only enabled in-envelope metrics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-apply-"));
  const triple = await createQualifiedFixture(directory);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  const runtime = { bundle, reasonCode: null, state: "active" };
  const decision = applyForecastAdjustment(runtime, {
    metrics: metrics(20),
    rawForecastProvenance: provenance(),
  });
  assert.equal(decision.state, "active");
  assert.deepEqual(decision.appliedMetrics, ["temperatureC"]);
  assert.deepEqual(decision.adjustedMetrics, { temperatureC: 22 });
  assert.equal("cloudCoverPercent" in decision.adjustedMetrics, false);

  const outOfDomain = applyForecastAdjustment(runtime, {
    metrics: metrics(20.01),
    rawForecastProvenance: provenance(),
  });
  assert.equal(outOfDomain.state, "not_applicable");
  assert.equal(outOfDomain.reasonCode, "training_envelope_mismatch");

  const allNull = applyForecastAdjustment(runtime, {
    metrics: { ...metrics(null), windSpeedMps: null },
    rawForecastProvenance: provenance(),
  });
  assert.deepEqual(allNull, {
    adjustedMetrics: {},
    appliedMetrics: [],
    contractVersion: "forecast-adjustment-decision/v1",
    reasonCode: "metric_not_enabled",
    state: "not_applicable",
  });
});

test("enabled-set stripping and runtime fingerprint drift fail raw", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-apply-guard-"));
  const triple = await createQualifiedFixture(directory);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  const strippedRuntime = {
    bundle: {
      ...bundle,
      candidate: { ...bundle.candidate, enabledMetricBands: [] },
    },
    reasonCode: null,
    state: "active",
  };
  assert.equal(
    applyForecastAdjustment(strippedRuntime, {
      metrics: metrics(20),
      rawForecastProvenance: provenance(),
    }).reasonCode,
    "metric_not_enabled",
  );

  const fingerprint = runtimeCalendarFingerprint();
  assert.equal(
    applyForecastAdjustment(
      { bundle, reasonCode: null, state: "active" },
      {
        metrics: metrics(20),
        rawForecastProvenance: provenance(),
        runtimeFingerprint: { ...fingerprint, icuVersion: "mismatch" },
      },
    ).reasonCode,
    "runtime_fingerprint_mismatch",
  );
});
