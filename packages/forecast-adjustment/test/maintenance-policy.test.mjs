import assert from "node:assert/strict";
import test from "node:test";

import { addLocalCalendarDays, localCalendarFeaturesFor } from "../dist/calendar.js";
import { canonicalSha256 } from "../dist/candidate.js";
import {
  createMaintenanceEvaluationRow,
  createRainMaintenanceEvaluationRow,
  evaluateRainMaintenanceDevelopment,
  evaluateRainMaintenanceDevelopmentV3,
  evaluateRainMaintenancePromotion,
  evaluateTemperatureMaintenancePromotion,
  evaluateWindMaintenancePromotion,
  maintenancePolicyReportIsFresh,
  RAIN_ORIGINAL_STABLE_GATE_IDS,
  WIND_MAINTENANCE_PAIR_KEYS,
} from "../dist/maintenance-policy.js";

const HASH = "a".repeat(64);

// create one hash-bound same-hour family row
function maintenanceRow(overrides = {}) {
  const validAt = overrides.validAt ?? "2026-10-01T20:00:00.000Z";
  const localDate = localCalendarFeaturesFor(validAt).localDate;
  return createMaintenanceEvaluationRow({
    actualBestMatchPrediction: 10.1,
    applied: true,
    candidatePrediction: 10,
    evidenceClass: "prospective_receipt",
    family: "temperature",
    farmTarget: 100,
    firstEdgeCommittedAt: new Date(Date.parse(validAt) - 2 * 3_600_000).toISOString(),
    horizonHours: 1,
    incumbentPrediction: 12,
    key: `temperature:h1:${validAt}`,
    localDate,
    nativeSourcePrediction: 13,
    nearestThree: null,
    pairKey: null,
    providerFamily: null,
    provenanceComplete: true,
    sourceRowSha256: HASH,
    sourceReceiptAt: new Date(Date.parse(validAt) - 3 * 3_600_000).toISOString(),
    stationKey: null,
    target: 10,
    targetRowSha256: HASH,
    validAt,
    ...overrides,
    localDate: overrides.localDate ?? localDate,
  });
}

// create seven independent local-date rows
function sevenRows(overrides = {}) {
  return Array.from({ length: 7 }, (_unused, index) => {
    const validAt = `${addLocalCalendarDays("2026-10-01", index)}T20:00:00.000Z`;
    return maintenanceRow({ validAt, ...overrides });
  });
}

// create one hash-bound rain policy row
function rainRow(overrides = {}) {
  const validAt = overrides.validAt ?? "2026-10-01T20:00:00.000Z";
  const localDate = localCalendarFeaturesFor(validAt).localDate;
  const probability = {
    atLeast0_1: 0.9,
    atLeast1_0: 0.8,
    atLeast2_5: 0.1,
  };
  return createRainMaintenanceEvaluationRow({
    actualBestMatchPrediction: 1.1,
    applied: true,
    candidatePrediction: 1,
    candidateProbability: probability,
    evidenceClass: "prospective_receipt",
    farmTarget: 20,
    firstEdgeCommittedAt: new Date(Date.parse(validAt) - 2 * 3_600_000).toISOString(),
    horizonHours: 1,
    incumbentPrediction: 1.5,
    incumbentProbability: probability,
    key: `rain:h1:${validAt}`,
    localDate,
    nativeSourcePrediction: 2,
    nativeSourceProbability: probability,
    nearestThree: null,
    persistencePrediction: 3,
    provenanceComplete: true,
    providerFamily: null,
    rawTargetHourTemperatureC: 2 + Number.EPSILON * 2,
    recentVolumeScalePrediction: 3,
    runKey: `run:${localDate}`,
    sameWindowVolumeScalePrediction: 3,
    sourceRowSha256: HASH,
    sourceReceiptAt: new Date(Date.parse(validAt) - 3 * 3_600_000).toISOString(),
    stationKey: null,
    target: 1,
    targetRowSha256: HASH,
    unchangedOrdinalPrediction: 1.2,
    validAt,
    volumeScalePrediction: 3,
    ...overrides,
    localDate: overrides.localDate ?? localDate,
  });
}

test("temperature policy keeps source, same-hour Best Match and farm diagnostics distinct", () => {
  const report = evaluateTemperatureMaintenancePromotion(sevenRows());
  assert.equal(report.population.nativeSource.comparator, "nativeSourcePrediction");
  assert.equal(
    report.population.actualBestMatchAllRows.comparator,
    "actualBestMatchPrediction",
  );
  assert.equal(report.population.nativeSource.skill > 0, true);
  assert.equal(report.population.farmDiagnosticMae, 90);
  assert.equal(report.gates.find((gate) => gate.id === "overall_support").state, "pending");
  assert.equal(report.action, "pending");
});

test("temperature policy fails harm and never converts missing provenance to pass", () => {
  const harmed = evaluateTemperatureMaintenancePromotion(sevenRows({
    candidatePrediction: 15,
    provenanceComplete: false,
  }));
  assert.equal(harmed.gates.find((gate) => gate.id === "native_source_skill").state, "fail");
  assert.equal(harmed.gates.find((gate) => gate.id === "complete_provenance").state, "pending");
  assert.equal(harmed.state, "fail");
  assert.equal(harmed.action, "retain");

  const row = sevenRows()[0];
  assert.throws(
    () => evaluateTemperatureMaintenancePromotion([{ ...row, target: 999 }]),
    /row hash is invalid/,
  );

  assert.throws(
    () => maintenanceRow({
      evidenceClass: "historical_development",
      firstEdgeCommittedAt: "2026-10-01T18:00:00.000Z",
      sourceReceiptAt: null,
    }),
    /evidence chronology is invalid/,
  );
});

test("wind policy requires all thirteen pairs and lets one pair veto", () => {
  const rows = WIND_MAINTENANCE_PAIR_KEYS.flatMap((pairKey) =>
    Array.from({ length: 7 }, (_unused, index) => {
      const validAt = `${addLocalCalendarDays("2026-10-01", index)}T20:00:00.000Z`;
      return maintenanceRow({
        family: "wind",
        key: `wind:${pairKey}:h1:${validAt}`,
        pairKey,
        validAt,
      });
    }));
  const report = evaluateWindMaintenancePromotion(rows);
  assert.equal(
    report.gates.filter((gate) => gate.id.startsWith("pair:") && gate.id.endsWith(":support")).length,
    13,
  );
  assert.equal(report.state, "pending");

  const harmed = rows.map((row) => {
    // rehash only the selected harmed pair
    if (row.pairKey === WIND_MAINTENANCE_PAIR_KEYS[0]) {
      const {
        contractVersion: _oldVersion,
        rowSha256: _oldHash,
        ...input
      } = row;
      return createMaintenanceEvaluationRow({
        ...input,
        candidatePrediction: 20,
      });
    }

    return row;
  });
  assert.equal(evaluateWindMaintenancePromotion(harmed).state, "fail");
  assert.throws(
    () => evaluateWindMaintenancePromotion(rows.filter(
      (row) => row.pairKey !== WIND_MAINTENANCE_PAIR_KEYS[0],
    )),
    /exactly 13 pairs/,
  );
});

test("rain policy derives every stable gate and aggregate gain cannot hide vetoes", () => {
  const rows = Array.from({ length: 7 }, (_unused, index) => {
    const validAt = `${addLocalCalendarDays("2026-10-01", index)}T20:00:00.000Z`;
    return rainRow({ validAt });
  });
  const report = evaluateRainMaintenancePromotion(rows);
  const original = report.gates.filter((gate) =>
    RAIN_ORIGINAL_STABLE_GATE_IDS.includes(gate.id));
  assert.deepEqual(original.map((gate) => gate.id), RAIN_ORIGINAL_STABLE_GATE_IDS);
  assert.equal(original.length, 49);
  assert.equal(report.gates.find((gate) => gate.id === "maeImprovesFivePercent").state, "pass");
  assert.equal(report.gates.find((gate) => gate.id === "heavyIntensityBounded").state, "fail");
  assert.equal(report.action, "retain");
});

// prove frozen development evaluation stays nonactionable
test("rain development screen is frozen and cannot authorize production", () => {
  // build the exact historical population
  const rows = Array.from({ length: 32_896 }, (_unused, index) => rainRow({
    evidenceClass: "historical_development",
    firstEdgeCommittedAt: null,
    key: `rain:development:${index}`,
    sourceReceiptAt: null,
  }));
  const report = evaluateRainMaintenanceDevelopment(rows);
  assert.equal(report.developmentRows, 32_896);
  assert.equal(report.productionEligible, false);
  assert.deepEqual(report.gates.map((gate) => gate.id), RAIN_ORIGINAL_STABLE_GATE_IDS);
  assert.equal(report.passed, report.state === "pass");
  // reject prospective rows on the development-only path
  assert.throws(
    () => evaluateRainMaintenanceDevelopment(Array.from(
      { length: 7 },
      (_unused, index) => rainRow({ key: `rain:prospective:${index}` }),
    )),
    /requires historical rows/,
  );
});

// build one complete annual value-blind source proof with one eligible target row
function annualRainDevelopmentPopulation() {
  const start = Date.parse("2025-11-24T00:00:00.000Z");
  const end = Date.parse("2026-11-24T00:00:00.000Z");
  const hour = 3_600_000;
  const firstRun = Math.floor((start - 31 * hour) / (6 * hour)) * 6 * hour;
  const sourcePopulation = [];

  // preserve every four-cycle issuance-halo member whose target lies in the year
  for (let run = firstRun; run <= end - 9 * hour; run += 6 * hour) {
    const runInitializedAt = new Date(run).toISOString();
    const issuedAt = new Date(run + 8 * hour).toISOString();
    // map source leads nine through thirty-one to operational horizons one through twenty-three
    for (let modelLeadHours = 9; modelLeadHours <= 31; modelLeadHours += 1) {
      const valid = run + modelLeadHours * hour;
      // omit only target clocks outside the frozen annual interval
      if (valid < start || valid >= end) {
        continue;
      }
      const validAt = new Date(valid).toISOString();
      const index = sourcePopulation.length;
      sourcePopulation.push({
        issuedAt,
        key: `${runInitializedAt}/${validAt}`,
        modelLeadHours,
        operationalHorizonHours: modelLeadHours - 8,
        phaseEligible: index === 0,
        sourceMemberSha256: HASH,
        sourceReceiptSha256: HASH,
        targetAvailable: index === 0,
        validAt,
      });
    }
  }
  return {
    contractVersion: "rain-maintenance-development-population/v3",
    cycleHours: [0, 6, 12, 18],
    developmentEndAt: "2026-11-24T00:00:00.000Z",
    developmentStartAt: "2025-11-24T00:00:00.000Z",
    eligibleRowCount: 1,
    excludedColdRowCount: sourcePopulation.length - 1,
    expectedRowCount: sourcePopulation.length,
    missingSourceRowCount: 0,
    missingTargetRowCount: 0,
    observedRowCount: sourcePopulation.length,
    operationalHorizonHours: Array.from({ length: 23 }, (_unused, index) => index + 1),
    populationMemberRootSha256: canonicalSha256(sourcePopulation.map(
      (member) => member.sourceMemberSha256).sort()),
    populationReceiptRootSha256: canonicalSha256([HASH]),
    populationSha256: canonicalSha256(sourcePopulation),
    sourceModelLeadHours: Array.from({ length: 23 }, (_unused, index) => index + 9),
    sourcePopulation,
  };
}

test("rain v3 development uses the original gates on a complete future-only year", () => {
  const population = annualRainDevelopmentPopulation();
  const selected = population.sourcePopulation[0];
  const row = rainRow({
    evidenceClass: "historical_development",
    firstEdgeCommittedAt: null,
    horizonHours: selected.operationalHorizonHours,
    key: selected.key,
    sourceReceiptAt: null,
    validAt: selected.validAt,
  });
  const report = evaluateRainMaintenanceDevelopmentV3([row], population);
  assert.equal(report.developmentRows, 1);
  assert.equal(report.developmentPopulationSha256, population.populationSha256);
  assert.equal(report.productionEligible, false);
  assert.deepEqual(report.gates.map((gate) => gate.id), RAIN_ORIGINAL_STABLE_GATE_IDS);
  assert.throws(() => evaluateRainMaintenanceDevelopmentV3([row], {
    ...population,
    sourcePopulation: population.sourcePopulation.slice(1),
  }), /population proof differs|evaluation population differs/u);
});

test("rain policy rejects cold rows and probability nesting violations", () => {
  assert.throws(
    () => rainRow({ rawTargetHourTemperatureC: 2 }),
    /rain maintenance evaluation row is invalid/,
  );
  const rows = Array.from({ length: 7 }, (_unused, index) => {
    const validAt = `${addLocalCalendarDays("2026-10-01", index)}T20:00:00.000Z`;
    return rainRow({
      candidateProbability: index === 0
        ? { atLeast0_1: 0.2, atLeast1_0: 0.8, atLeast2_5: 0.1 }
        : { atLeast0_1: 0.9, atLeast1_0: 0.8, atLeast2_5: 0.1 },
      validAt,
    });
  });
  const report = evaluateRainMaintenancePromotion(rows);
  assert.equal(report.gates.find((gate) => gate.id === "probability_nesting").state, "fail");
});

test("maintenance reports expire at the exact seven-day boundary", () => {
  assert.equal(maintenancePolicyReportIsFresh(
    "2026-10-01T00:00:00.000Z",
    "2026-10-07T23:59:59.999Z",
  ), true);
  assert.equal(maintenancePolicyReportIsFresh(
    "2026-10-01T00:00:00.000Z",
    "2026-10-08T00:00:00.000Z",
  ), false);
});
