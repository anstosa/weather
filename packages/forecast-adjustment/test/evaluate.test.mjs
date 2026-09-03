import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createDevelopmentReport,
  createForecastAdjustmentEvaluationReport,
  createForecastAdjustmentQualificationReceipt,
  evaluateDevelopmentLosoFold,
  evaluateEcowittTargetSiteGate,
  pairedSkill,
} from "../dist/index.js";

import {
  createHoldoutFixture,
  createDevelopmentFixture,
  createQualifiedFixture,
} from "./evidence-fixtures.mjs";

// build one station-level paired score
const station = (physicalStationKey, providerFamily, pointSkill = 0.1) => ({
  adjustedLoss: 9,
  eventCount: 100,
  physicalStationKey,
  pointSkill,
  providerFamily,
  rawLoss: 10,
  remainingNetworkScoreEvents: 100,
  scoreMatches: 100,
  trainingMatches: 500,
});

test("development LOSO enforces five stations, three families, and equal providers", () => {
  const result = evaluateDevelopmentLosoFold({
    auxiliaryModelSha256s: Array.from({ length: 10 }, (_unused, index) =>
      index.toString(16).repeat(64),
    ),
    bootstrapLowerBound: 0.01,
    fold: 5,
    materialHarmSliceKeys: [],
    metricBand: { leadBand: "001-024", metric: "temperatureC" },
    stationScores: [
      station("ambient-maxweather", "ambient"),
      station("ballydidean-ecowitt", "ecowitt"),
      station("netatmo-nearby", "netatmo"),
      station("tempest-126537", "tempest"),
      station("tempest-168853", "tempest"),
      station("tempest-201058", "tempest"),
      station("tempest-203055", "tempest"),
      station("tempest-225947", "tempest"),
      station("tempest-38270", "tempest"),
      station("tempest-64255", "tempest"),
    ],
  });
  assert.equal(result.passed, true);
  assert.equal(result.providerBalancedRawLoss, 10);
  assert.equal(result.providerBalancedAdjustedLoss, 9);
  assert.equal(result.providerFamilies.length, 4);

  const tooFew = evaluateDevelopmentLosoFold({
    auxiliaryModelSha256s: ["1", "2", "3", "4"].map((value) =>
      value.repeat(64),
    ),
    bootstrapLowerBound: 0.01,
    fold: 1,
    materialHarmSliceKeys: [],
    metricBand: { leadBand: "001-024", metric: "temperatureC" },
    stationScores: [
      station("ambient-maxweather", "ambient"),
      station("ballydidean-ecowitt", "ecowitt"),
      station("netatmo-nearby", "netatmo"),
      station("tempest-126537", "tempest"),
    ],
  });
  assert.equal(tooFew.passed, false);
});

test("Ecowitt gate applies every exact boundary and zero-loss skill", () => {
  const score = {
    adjustedLoss: 9.8,
    bootstrapLowerBound: Number.EPSILON,
    bootstrapUpperBound: 0.1,
    eventCount: 100,
    rawLoss: 10,
    skill: 0.02,
  };
  const base = {
    criticalSlices: [],
    ecowittCompleteLocalDates: 30,
    ecowittMetricBandMatches: 100,
    ecowittMetricMatches: 500,
    ecowittTargetSite: score,
    evaluatedSeasonDaypartKeys: [],
    metricBand: { leadBand: "001-024", metric: "temperatureC" },
    network: score,
    providerBalanced: score,
    scoreableStationKeys: [],
  };
  assert.equal(evaluateEcowittTargetSiteGate(base).passed, true);
  assert.deepEqual(
    evaluateEcowittTargetSiteGate({ ...base, ecowittCompleteLocalDates: 29 })
      .failedReasons,
    ["ecowitt_complete_local_dates"],
  );
  assert.equal(pairedSkill(0, 0), 0);
  assert.equal(pairedSkill(0, 1), -1);
});

test("development report requires four passing folds including the latest", () => {
  assert.throws(
    () =>
      createDevelopmentReport({
        enabledMetricBands: [
          { leadBand: "001-024", metric: "temperatureC" },
        ],
        folds: [],
      }),
    /four passing folds/u,
  );
  const passing = createDevelopmentFixture();
  const fourOfFive = passing.folds.map((fold) =>
    fold.fold === 1
      ? { ...fold, bootstrapLowerBound: -0.01, passed: false }
      : fold,
  );
  assert.doesNotThrow(() =>
    createDevelopmentReport({
      enabledMetricBands: passing.enabledMetricBands,
      folds: fourOfFive,
    }),
  );
  assert.throws(
    () =>
      createDevelopmentReport({
        enabledMetricBands: passing.enabledMetricBands,
        folds: passing.folds.map((fold) =>
          fold.fold === 5
            ? { ...fold, bootstrapLowerBound: -0.01, passed: false }
            : fold,
        ),
      }),
    /four passing folds/u,
  );
});

test("holdout report remains immutable evidence when qualification fails", async () => {
  const qualifiedDirectory = await mkdtemp(join(tmpdir(), "weather-qualified-"));
  const holdoutDirectory = await mkdtemp(join(tmpdir(), "weather-rejected-"));
  const qualified = await createQualifiedFixture(qualifiedDirectory);
  const holdout = await createHoldoutFixture(holdoutDirectory);
  const failingEvaluation = {
    ...qualified.evaluationReport.metricBandEvaluations[0],
    ecowittCompleteLocalDates: 29,
  };
  const report = createForecastAdjustmentEvaluationReport({
    candidate: holdout.candidate,
    holdoutAccessMarker: holdout.marker,
    metricBandEvaluations: [failingEvaluation],
    preregistration: holdout.preregistration,
  });
  const receipt = createForecastAdjustmentQualificationReceipt({
    candidate: holdout.candidate,
    contextByMetricBand: {
      "temperatureC:001-024": {
        coefficientCoverageAndCapsPassed: true,
        criticalSlicesPassed: true,
        developmentFoldSkillPassed: true,
        productionIdentityPassed: true,
      },
    },
    evaluationReport: report,
    evidenceRedundancy: qualified.qualificationReceipt.evidenceRedundancy,
  });
  assert.equal(receipt.passed, false);
  assert.equal(receipt.lifecycleState, "rejected");
  assert.equal(
    receipt.gates.find((gate) => gate.name === "locked_holdout_and_ecowitt")
      .passed,
    false,
  );
});
