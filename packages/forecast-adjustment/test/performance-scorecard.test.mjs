import assert from "node:assert/strict";
import test from "node:test";

import {
  balanceForecastAdjustmentPerformancePairs,
  bootstrapBalancedForecastAdjustmentPairs,
  coalesceForecastAdjustmentPerformancePairs,
  createEcowittTargetDiagnostic,
  createEligibleFixedRainGaugeHourlyTarget,
  createFixedRainGaugeTarget,
  createRegionalPhysicalStationTarget,
  evaluateForecastAdjustmentPerformance,
  evaluateForecastAdjustmentRainDiagnostics,
  prepareForecastAdjustmentPerformancePairs,
  scoreBalancedForecastAdjustmentPairs,
  tileBackwardRainGaugeHour,
} from "../dist/performance-scorecard.js";

// create one causal paired forecast event
function pair(overrides = {}) {
  const localDate = overrides.localDate ?? "2026-10-01";
  const hour = overrides.hour ?? 20;
  const validAt = overrides.validAt ??
    `${localDate}T${String(hour).padStart(2, "0")}:00:00.000Z`;
  const suffix = overrides.suffix ?? `${localDate}-${String(hour)}`;
  return {
    adjustedPrediction: 11,
    evidenceClass: "as_issued",
    fallback: false,
    firstEdgeCommittedAt: `${localDate}T18:00:00.000Z`,
    horizonHours: 2,
    key: `pair-${suffix}`,
    localDate,
    provenanceComplete: true,
    rawPrediction: 12,
    rowIdentity: `row-${suffix}`,
    sourceReceiptAt: `${localDate}T17:00:00.000Z`,
    target: 10,
    targetKey: `target-${localDate}-${String(hour)}`,
    validAt,
    vintageKey: `vintage-${suffix}`,
    ...overrides,
  };
}

// create consecutive seven-date support
function sevenDatePairs(overrides = {}) {
  return Array.from({ length: 7 }, (_unused, index) => {
    const localDate = `2026-10-${String(index + 1).padStart(2, "0")}`;
    return pair({ localDate, suffix: localDate, ...overrides });
  });
}

// create one exactly tiled backward gauge hour
function gaugeHour(stationId, amount, endpointLagMinutes = 0) {
  const validAt = Date.parse("2026-10-01T20:00:00.000Z");
  const end = validAt - endpointLagMinutes * 60_000;
  return Array.from({ length: 12 }, (_unused, index) => ({
    precipitationMm: amount / 12,
    reportIntervalMinutes: 5,
    reportedAt: new Date(end - index * 5 * 60_000).toISOString(),
    stationId,
  }));
}

test("overlap coalescing keeps earliest commit and guards row chronology", () => {
  const first = pair();
  const later = {
    ...first,
    firstEdgeCommittedAt: "2026-10-01T19:00:00.000Z",
    sourceReceiptAt: "2026-10-01T18:30:00.000Z",
  };
  const coalesced = coalesceForecastAdjustmentPerformancePairs([later, first]);
  assert.equal(coalesced.duplicateCount, 1);
  assert.equal(coalesced.rows[0].firstEdgeCommittedAt, first.firstEdgeCommittedAt);
  assert.equal(coalesced.rows[0].sourceReceiptAt, first.sourceReceiptAt);

  const excluded = prepareForecastAdjustmentPerformancePairs([
    pair({
      firstEdgeCommittedAt: "2026-10-01T20:00:00.000Z",
      sourceReceiptAt: "2026-10-01T21:00:00.000Z",
    }),
  ]);
  assert.equal(excluded.rows.length, 0);
  assert.equal(excluded.exclusions.issued_after_valid, 1);
  assert.equal(excluded.exclusions.source_late, 1);

  assert.throws(() => coalesceForecastAdjustmentPerformancePairs([
    first,
    { ...later, adjustedPrediction: 9 },
  ]), /identity collision/);
});

test("date hour vintage weights do not multiply repeated forecasts", () => {
  const rows = [
    pair({ suffix: "d1-h20-v1" }),
    pair({ suffix: "d1-h20-v2", rowIdentity: "row-d1-h20-v2", vintageKey: "v2" }),
    pair({ hour: 21, suffix: "d1-h21" }),
    pair({ localDate: "2026-10-02", suffix: "d2-h20" }),
  ];
  const weighted = balanceForecastAdjustmentPerformancePairs(rows);
  assert.deepEqual(weighted.map((row) => row.weight), [0.125, 0.125, 0.25, 0.5]);
  assert.equal(weighted.reduce((sum, row) => sum + row.weight, 0), 1);
  assert.throws(() => balanceForecastAdjustmentPerformancePairs([
    rows[0],
    { ...rows[1], evidenceClass: "development" },
  ]), /evidence classes/);
});

test("paired metrics preserve zero-safe skill, bias, rmse and weighted p95", () => {
  const exact = sevenDatePairs({ rawPrediction: 10, adjustedPrediction: 10 });
  const score = scoreBalancedForecastAdjustmentPairs(exact);
  assert.equal(score.metrics.raw.mae, 0);
  assert.equal(score.metrics.adjusted.mae, 0);
  assert.equal(score.metrics.skill, 0);

  const harmed = scoreBalancedForecastAdjustmentPairs(
    sevenDatePairs({ rawPrediction: 10, adjustedPrediction: 11 }),
  );
  assert.equal(harmed.metrics.raw.mae, 0);
  assert.ok(Math.abs(harmed.metrics.adjusted.bias - 1) < 1e-12);
  assert.ok(Math.abs(harmed.metrics.adjusted.rmse - 1) < 1e-12);
  assert.equal(harmed.metrics.adjusted.p95AbsoluteError, 1);
  assert.equal(harmed.metrics.skill, -1);
});

test("bootstrap requires seven dates and produces exactly 2000 paired replicates", () => {
  assert.equal(
    bootstrapBalancedForecastAdjustmentPairs(sevenDatePairs().slice(0, 6)),
    null,
  );
  const bootstrap = bootstrapBalancedForecastAdjustmentPairs(sevenDatePairs());
  assert.equal(bootstrap.replicates, 2_000);
  assert.ok(bootstrap.lowerSkill > 0);
  assert.ok(bootstrap.upperSkill > 0);

  const evaluation = evaluateForecastAdjustmentPerformance(sevenDatePairs(), {
    minimumDates: 7,
    minimumRows: 7,
    servingState: "pending_review",
  });
  assert.equal(evaluation.supportState, "sufficient");
  assert.equal(evaluation.comparisonState, "better");
  assert.equal(evaluation.qualificationState, "supported");
  assert.equal(evaluation.servingState, "pending_review");

  const incomplete = sevenDatePairs({ provenanceComplete: false });
  const prepared = prepareForecastAdjustmentPerformancePairs(incomplete);
  assert.equal(prepared.rows.length, 7);
  assert.equal(prepared.diagnostics.provenance_incomplete, 7);
  const descriptive = evaluateForecastAdjustmentPerformance(prepared.rows, {
    minimumDates: 7,
    minimumRows: 7,
    servingState: "pending_review",
  });
  assert.equal(descriptive.comparisonState, "better");
  assert.equal(descriptive.qualificationState, "pending_support");
});

test("physical targets dedupe regional stations and isolate Ecowitt", () => {
  const values = [
    { physicalStationKey: "ambient-merlin", value: 8 },
    { physicalStationKey: "tempest-64255", value: 10 },
    { physicalStationKey: "tempest-38270", value: 12 },
    { physicalStationKey: "ballydidean-ecowitt", value: 30 },
  ];
  const regional = createRegionalPhysicalStationTarget(values);
  assert.equal(regional.stationCount, 3);
  assert.notEqual(regional.value, 30);
  assert.equal(createEcowittTargetDiagnostic(values), 30);
  assert.throws(() => createRegionalPhysicalStationTarget([
    values[0], values[0], values[1], values[2],
  ]), /duplicated/);
});

test("fixed rain gauges report incomplete coverage without imputation", () => {
  const incomplete = createFixedRainGaugeTarget([
    { stationId: 64255, precipitationMm: null },
    { stationId: 225947, precipitationMm: 1 },
    { stationId: 38270, precipitationMm: null },
  ]);
  assert.deepEqual(incomplete, {
    complete: false,
    precipitationMm: null,
    stationCount: 1,
  });
  const complete = createFixedRainGaugeTarget([
    { stationId: 64255, precipitationMm: 1 },
    { stationId: 225947, precipitationMm: 2 },
    { stationId: 38270, precipitationMm: 3 },
  ]);
  assert.equal(complete.complete, true);
  assert.equal(complete.precipitationMm, 2);
});

test("fixed rain gauges use the served weighted median instead of the mean", () => {
  const outlier = createFixedRainGaugeTarget([
    { stationId: 64255, precipitationMm: 0 },
    { stationId: 225947, precipitationMm: 1 },
    { stationId: 38270, precipitationMm: 100 },
  ]);
  assert.equal(outlier.precipitationMm, 1);

  const tied = createFixedRainGaugeTarget([
    { stationId: 64255, precipitationMm: 1 },
    { stationId: 225947, precipitationMm: 1 },
    { stationId: 38270, precipitationMm: 100 },
  ]);
  assert.equal(tied.precipitationMm, 1);

  const asymmetric = createFixedRainGaugeTarget([
    { stationId: 64255, precipitationMm: 0 },
    { stationId: 225947, precipitationMm: 2 },
    { stationId: 38270, precipitationMm: 9 },
    { stationId: 168853, precipitationMm: 10 },
  ]);
  assert.equal(asymmetric.precipitationMm, 2);
});

test("rain target retains backward tiling, endpoint tolerance and raw phase", () => {
  const intervals = [
    ...gaugeHour(64255, 1, 5),
    ...gaugeHour(225947, 2),
    ...gaugeHour(38270, 3),
  ];
  assert.deepEqual(tileBackwardRainGaugeHour(
    intervals,
    "2026-10-01T20:00:00.000Z",
  ).map((row) => [row.stationId, Math.round(row.precipitationMm * 10) / 10]), [
    [38270, 3],
    [64255, 1],
    [225947, 2],
  ]);

  const cold = createEligibleFixedRainGaugeHourlyTarget({
    intervals,
    rawTargetHourTemperatureC: 2,
    validAt: "2026-10-01T20:00:00.000Z",
  });
  assert.equal(cold.eligible, false);
  assert.equal(cold.reason, "cold_or_unknown_forecast_phase");

  const warm = createEligibleFixedRainGaugeHourlyTarget({
    intervals,
    rawTargetHourTemperatureC: 2 + Number.EPSILON * 2,
    validAt: "2026-10-01T20:00:00.000Z",
  });
  assert.equal(warm.eligible, true);
  assert.equal(warm.precipitationMm, 2);

  const unsupported = createEligibleFixedRainGaugeHourlyTarget({
    intervals: intervals.filter((row) => row.stationId !== 225947),
    rawTargetHourTemperatureC: 10,
    validAt: "2026-10-01T20:00:00.000Z",
  });
  assert.equal(unsupported.reason, "unsupported_target");
});

test("rain diagnostics use named probabilities and complete same-run windows", () => {
  const rows = Array.from({ length: 23 }, (_unused, index) => {
    const hour = index;
    const validAt = new Date(Date.parse("2026-01-15T08:00:00.000Z") +
      index * 3_600_000).toISOString();
    const target = index % 4 === 0 ? 3 : index % 2 === 0 ? 0.2 : 0;
    return pair({
      adjustedPrediction: target,
      adjustedProbability: {
        atLeast0_1: target >= 0.1 ? 0.9 : 0.1,
        atLeast1_0: target >= 1 ? 0.8 : 0.05,
        atLeast2_5: target >= 2.5 ? 0.7 : 0.01,
      },
      amountParity: true,
      evidenceClass: "development",
      firstEdgeCommittedAt: null,
      hour,
      key: `rain-${String(index)}`,
      localDate: "2026-01-15",
      rawPrediction: 0,
      rowIdentity: `rain-row-${String(index)}`,
      runKey: "run-1",
      sourceReceiptAt: null,
      suffix: `rain-${String(index)}`,
      target,
      targetKey: `rain-target-${String(index)}`,
      targetTilingComplete: true,
      validAt,
      vintageKey: "run-1",
    });
  });
  const diagnostics = evaluateForecastAdjustmentRainDiagnostics(rows);
  assert.equal(diagnostics.thresholds.length, 3);
  assert.equal(diagnostics.thresholds[0].reliability.length, 10);
  assert.equal(diagnostics.thresholds[0].reliability[5].count, 0);
  assert.equal(diagnostics.thresholds[0].rawBrier, null);
  assert.ok(diagnostics.thresholds[0].adjustedBrier > 0);
  assert.equal(diagnostics.probabilityOrderViolationCount, 0);
  assert.deepEqual(
    diagnostics.accumulations.map((entry) => entry.completeWindows),
    [18, 12, 1],
  );
  assert.equal(diagnostics.accumulations[2].adjustedMae, 0);
  assert.throws(() => evaluateForecastAdjustmentRainDiagnostics([
    { ...rows[0], amountParity: false },
  ]), /amount parity/);
});
