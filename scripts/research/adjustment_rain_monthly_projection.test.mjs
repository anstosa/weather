import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { buildAdjustmentHistoricalFitProjection } from "./adjustment_historical_fit_assembler.mjs";
import {
  ADJUSTMENT_RAIN_DEVELOPMENT_POPULATION_VERSION,
  buildAdjustmentRainDevelopmentPopulationV3,
  buildAdjustmentRainMonthlyFitAssembly,
} from "./adjustment_rain_monthly_projection.mjs";
import {
  rainHistory,
  rainHistoryEpochWitness,
} from "./fixtures/adjustment-rain-history.mjs";

const HOUR = 3_600_000;

// build one full compact source year without model or target values
function fullPopulation(dueMonth, eligibleIndex = 0) {
  const monthStart = Date.parse(`${dueMonth}-01T00:00:00.000Z`);
  const end = new Date(monthStart - 7 * 86_400_000);
  const start = new Date(end);
  start.setUTCFullYear(start.getUTCFullYear() - 1);
  const firstRun = Math.floor((start.getTime() - 31 * HOUR) / (6 * HOUR)) * 6 * HOUR;
  const members = [];

  // reproduce the exact target-valid issuance halo
  for (let run = firstRun; run <= end.getTime() - 9 * HOUR; run += 6 * HOUR) {
    const runInitializedAt = new Date(run).toISOString();
    const issuedAt = new Date(run + 8 * HOUR).toISOString();
    // retain every original source lead whose target is inside the year
    for (let modelLeadHours = 9; modelLeadHours <= 31; modelLeadHours += 1) {
      const valid = run + modelLeadHours * HOUR;
      // exclude only target clocks outside the half-open year
      if (valid < start.getTime() || valid >= end.getTime()) {
        continue;
      }
      const validAt = new Date(valid).toISOString();
      const index = members.length;
      members.push(Object.freeze({
        issuedAt,
        key: `${runInitializedAt}/${validAt}`,
        modelLeadHours,
        operationalHorizonHours: modelLeadHours - 8,
        phaseEligible: index === eligibleIndex,
        sourceMemberSha256: sha256(`member-${index}`),
        sourceReceiptSha256: sha256(`receipt-${Math.floor(index / 23)}`),
        targetAvailable: index === eligibleIndex,
        validAt,
      }));
    }
  }
  return members;
}

// hash one deterministic fixture identity
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("rain v3 population binds one full target-valid utc year and issuance halo", () => {
  const populationMembers = fullPopulation("2026-12");
  const selected = populationMembers[0];
  const proof = buildAdjustmentRainDevelopmentPopulationV3({
    dueMonth: "2026-12",
    populationMembers,
    rows: [{ key: selected.key }],
  });
  assert.equal(proof.contractVersion, ADJUSTMENT_RAIN_DEVELOPMENT_POPULATION_VERSION);
  assert.equal(proof.developmentStartAt, "2025-11-24T00:00:00.000Z");
  assert.equal(proof.developmentEndAt, "2026-11-24T00:00:00.000Z");
  assert.equal(proof.expectedRowCount, 365 * 4 * 23);
  assert.equal(proof.observedRowCount, proof.expectedRowCount);
  assert.equal(proof.eligibleRowCount, 1);
  assert.equal(proof.excludedColdRowCount, proof.expectedRowCount - 1);
  assert.equal(proof.missingSourceRowCount, 0);
  assert.equal(proof.missingTargetRowCount, 0);
  assert.deepEqual(proof.cycleHours, [0, 6, 12, 18]);
  assert.deepEqual(proof.sourceModelLeadHours, Array.from({ length: 23 }, (_unused, index) => index + 9));
  assert.deepEqual(proof.operationalHorizonHours, Array.from({ length: 23 }, (_unused, index) => index + 1));
});

test("rain v3 population retains leap-year count and reports missing target honestly", () => {
  const populationMembers = fullPopulation("2025-03");
  populationMembers[0] = Object.freeze({ ...populationMembers[0], targetAvailable: false });
  const proof = buildAdjustmentRainDevelopmentPopulationV3({
    dueMonth: "2025-03",
    populationMembers,
    rows: [],
  });
  assert.equal(proof.expectedRowCount, 366 * 4 * 23);
  assert.equal(proof.missingSourceRowCount, 0);
  assert.equal(proof.missingTargetRowCount, 1);
});

test("rain monthly assembly returns noncandidate for a genuine incomplete future-only year", () => {
  const witness = rainHistoryEpochWitness();
  const historicalProjection = buildAdjustmentHistoricalFitProjection({
    epochWitness: witness,
    family: "rain",
    fitMonth: "2026-12",
    history: rainHistory(),
  });
  const result = buildAdjustmentRainMonthlyFitAssembly({
    dueMonth: "2026-12",
    epochWitness: witness,
    historicalProjection,
  });
  assert.equal(result.contractVersion, "adjustment-rain-monthly-fit-assembly/v1");
  assert.equal(result.state, "no_candidate");
  assert.equal(result.reason, "incomplete_development_population");
  assert.ok(result.developmentPopulation.missingSourceRowCount > 0);
  assert.equal("fitInput" in result, false);
});
