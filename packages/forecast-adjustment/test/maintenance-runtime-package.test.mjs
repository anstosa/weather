import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  applyForecastAdjustmentWindMaintenanceCandidate,
  buildForecastAdjustmentMaintenanceRuntimePackage,
  canonicalJsonBytes,
  canonicalSha256,
  createDevelopmentReport,
  createForecastAdjustmentCandidate,
  encodeForecastAdjustmentMaintenanceRuntimePackage,
  evaluateDevelopmentLosoFold,
  forecastAdjustmentRainMaintenanceSourceIdentitySha256,
  forecastAdjustmentTemperatureMaintenanceSourceIdentitySha256,
  forecastAdjustmentWindMaintenanceSourceIdentitySha256,
  runtimeCalendarFingerprint,
  verifyForecastAdjustmentMaintenanceRuntimePackage,
} from "../dist/index.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const leadBands = ["001-024", "025-048", "049-072", "073-096", "097-120", "121-144", "145-168"];

// create all thirteen supported wind pairs
function windPairs() {
  return [
    ...leadBands.map((leadBand) => ({ leadBand, metric: "windSpeedMps" })),
    ...leadBands.filter((leadBand) => leadBand !== "049-072")
      .map((leadBand) => ({ leadBand, metric: "windGustMps" })),
  ];
}

// create one independently hashed development report
function windDevelopmentReport() {
  const stationScores = [
    ["ambient-maxweather", "ambient"],
    ["ballydidean-ecowitt", "ecowitt"],
    ["netatmo-nearby", "netatmo"],
    ["tempest-126537", "tempest"],
    ["tempest-168853", "tempest"],
  ].map(([physicalStationKey, providerFamily]) => ({
    adjustedLoss: 9,
    eventCount: 100,
    physicalStationKey,
    pointSkill: 0.1,
    providerFamily,
    rawLoss: 10,
    remainingNetworkScoreEvents: 100,
    scoreMatches: 100,
    trainingMatches: 500,
  }));
  const pairs = windPairs();
  return createDevelopmentReport({
    enabledMetricBands: pairs,
    folds: pairs.flatMap((metricBand) => [1, 2, 3, 4, 5].map((fold) =>
      evaluateDevelopmentLosoFold({
        auxiliaryModelSha256s: ["1", "2", "3", "4", "5"].map((value) => value.repeat(64)),
        bootstrapLowerBound: 0.01,
        fold,
        materialHarmSliceKeys: [],
        metricBand,
        stationScores,
      }))),
  });
}

// create one complete selected wind fit
function windFit() {
  const developmentReport = windDevelopmentReport();
  const pairs = windPairs();
  const candidate = createForecastAdjustmentCandidate({
    coefficients: pairs.map((pair) => ({
      coefficient: 0.25,
      daypart: null,
      effectiveEventCount: 200,
      leadBand: pair.leadBand,
      level: 1,
      metric: pair.metric,
      month: null,
      season: null,
    })),
    developmentReportSha256: developmentReport.developmentReportSha256,
    enabledMetricBands: pairs,
    evaluationEpochId: "maintenance-2026-10",
    exportManifestSha256: canonicalSha256({ contractVersion: "fixture/v1" }),
    finalTrainingCutoff: "2026-09-01T06:59:59.999Z",
    forecastIdentity: FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
    runtimeFingerprint: runtimeCalendarFingerprint(),
    trainingEnvelopes: pairs.map((pair) => ({
      leadBand: pair.leadBand,
      maximum: 40,
      metric: pair.metric,
      minimum: 0,
    })),
    trainingProvenance: FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  });
  return {
    candidate,
    confirmationOpened: false,
    contractVersion: "wind-maintenance-fit/v2",
    developmentReport,
    dueMonth: "2026-10",
    state: "development_candidate",
  };
}

test("temperature fit packages portable parameters without legacy authority", async () => {
  const incumbent = JSON.parse(await readFile(
    new URL("../../../config/forecast-adjustments/ballydidean/temperature-canary-bundles/" +
      "sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json", import.meta.url),
    "utf8",
  ));
  const fit = {
    arms: {},
    confirmationOpened: false,
    contractVersion: "temperature-maintenance-fit/v2",
    developmentIncumbentMae: 1,
    developmentRawMae: 2,
    dueMonth: "2026-10",
    model: incumbent.model,
    selectedArm: "month_start_expanding",
    servingChanged: false,
    state: "development_candidate",
  };
  const fitBytes = Buffer.from(canonicalJsonBytes(fit));
  const runtimePackage = buildForecastAdjustmentMaintenanceRuntimePackage(fitBytes);
  assert.equal(runtimePackage.family, "temperature");
  assert.equal(runtimePackage.candidateSha256, hash(fitBytes));
  assert.notEqual(runtimePackage.bundleSha256, runtimePackage.candidateSha256);
  assert.equal("authorization" in runtimePackage, false);
  assert.match(forecastAdjustmentTemperatureMaintenanceSourceIdentitySha256(), /^[a-f0-9]{64}$/u);
  assert.equal("evidence" in runtimePackage, false);
  assert.doesNotThrow(() => verifyForecastAdjustmentMaintenanceRuntimePackage(runtimePackage));
  assert.equal(encodeForecastAdjustmentMaintenanceRuntimePackage(runtimePackage).toString("utf8"),
    canonicalJsonBytes(runtimePackage));
});

test("wind fit package binds the raw fit, portable candidate and actual source identity", () => {
  const fitBytes = Buffer.from(canonicalJsonBytes(windFit()));
  const runtimePackage = buildForecastAdjustmentMaintenanceRuntimePackage(fitBytes);
  assert.equal(runtimePackage.family, "wind");
  assert.equal(runtimePackage.candidateSha256, hash(fitBytes));
  assert.deepEqual(runtimePackage.source, runtimePackage.candidate.forecastIdentity);
  assert.equal(runtimePackage.candidate.enabledMetricBands.length, 13);
  assert.equal(
    forecastAdjustmentWindMaintenanceSourceIdentitySha256(runtimePackage.candidate),
    canonicalSha256(runtimePackage.candidate.forecastIdentity),
  );
  const changed = { ...runtimePackage, source: { ...runtimePackage.source, upstreamModel: "ecmwf_ifs" } };
  assert.throws(() => verifyForecastAdjustmentMaintenanceRuntimePackage(changed), /identity|source/u);
  const decision = applyForecastAdjustmentWindMaintenanceCandidate(
    runtimePackage.bundleSha256,
    runtimePackage.candidate,
    {
      evaluatedAt: "2026-10-08T00:00:00.000Z",
      metrics: {
        apparentTemperatureC: null, blackGlobeTemperatureC: null, cloudCoverPercent: null,
        pm25MicrogramsPerCubicMeter: null, precipitationMm: null, precipitationRateMmPerHour: null,
        pressureHpa: null, relativeHumidityPercent: null, soilElectricalConductivityMicrosiemensPerCm: null,
        soilMoisturePercent: null, solarRadiationWm2: null, temperatureC: null, uvIndex: null, waterLevelM: null,
        wetBulbGlobeTemperatureC: null, windDirectionDegrees: null, windGustMps: 8, windSpeedMps: 5,
      },
      rawForecastProvenance: {
        ...runtimePackage.source,
        referenceAt: "2026-10-08T00:00:00.000Z",
        targetLeadHours: 1,
        validAt: "2026-10-08T01:00:00.000Z",
      },
    },
    {
      actionSha256: "a".repeat(64),
      fullMemberRootSha256: "b".repeat(64),
      policyReportSha256: "c".repeat(64),
    },
  );
  assert.equal(decision.state, "active");
  assert.equal(decision.contractVersion, "forecast-adjustment-decision/v1");
  assert.equal(decision.activationKind, "maintenance_qualified");
  assert.equal(decision.actionSha256, "a".repeat(64));
  assert.match(forecastAdjustmentRainMaintenanceSourceIdentitySha256(), /^[a-f0-9]{64}$/u);
});
