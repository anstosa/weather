import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID,
  analyzeTemperatureLeadResearch,
} from "../dist/index.js";

// create one exact hourly research event
function researchEvent(input = {}) {
  const validAt = input.validAt ?? "2026-01-01T16:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 1;
  const referenceAt =
    input.referenceAt ??
    new Date(
      Date.parse(validAt) - targetLeadHours * 3_600_000,
    ).toISOString();

  return {
    actual: input.actual ?? 12,
    baselineAdjusted: input.baselineAdjusted ?? 12,
    rawForecast: input.rawForecast ?? 10,
    referenceAt,
    targetLeadHours,
    validAt,
  };
}

// build deterministic multi-date causal evidence
function causalSeries(actualForDay) {
  const events = [];

  // create eight valid hours per local date
  for (let day = 0; day < 12; day += 1) {
    // create one repeated lead-bucket sample
    for (let hour = 0; hour < 8; hour += 1) {
      const validAt = new Date(
        Date.UTC(2026, 0, day + 1, 16 + hour),
      ).toISOString();
      events.push(
        researchEvent({
          actual: actualForDay(day),
          validAt,
        }),
      );
    }
  }

  return events;
}

// find one exact causal trace row
function traceFor(report, validAt) {
  const trace = report.causalTrace.find(
    // match one forecast valid time
    (candidate) => candidate.validAt === validAt,
  );

  // require the complete frozen trace
  if (trace === undefined) {
    throw new Error(`missing causal trace for ${validAt}`);
  }

  return trace;
}

// verify complete diagnostics and weighting semantics
test("scores full, tapered, and fallback temperature strategies", () => {
  const report = analyzeTemperatureLeadResearch([
    researchEvent({
      actual: 2,
      baselineAdjusted: 2,
      rawForecast: 0,
    }),
    researchEvent({
      actual: 2,
      baselineAdjusted: 4,
      rawForecast: 2,
      targetLeadHours: 24,
      validAt: "2026-01-02T16:00:00.000Z",
    }),
  ]);

  assert.equal(report.contractVersion, "temperature-lead-research/v1");
  assert.equal(report.researchOnly, true);
  assert.equal(report.productionActivationAllowed, false);
  assert.equal(
    report.availabilityAssumption.evidenceStatus,
    "pseudo_real_time_retrospective_not_independently_validated",
  );
  assert.deepEqual(
    report.alphaGrid.scores.map(
      // retain frozen alpha order
      (item) => item.alpha,
    ),
    TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID,
  );
  assert.equal(report.overall.raw.eventWeightedMeanAbsoluteError, 1);
  assert.equal(report.overall.baselineFull.eventWeightedMeanAbsoluteError, 1);
  assert.equal(
    report.overall.baselineFull.eventWeightedPointSkillVersusRaw,
    0,
  );
  assert.ok(
    Math.abs(
      report.overall.staticLinearTaper.eventWeightedMeanAbsoluteError -
        47 / 24,
    ) < 1e-12,
  );
  assert.equal(
    report.overall.causalAdaptive.eventWeightedMeanAbsoluteError,
    1,
  );
  assert.equal(report.overall.causalAdaptive.correctionUseCount, 0);
  assert.equal(report.calibratedSubset.raw.eventCount, 0);
  assert.equal(
    report.calibratedSubset.raw.eventWeightedMeanAbsoluteError,
    null,
  );
  assert.equal(report.diagnostics.byExactLeadHour.length, 168);
  assert.equal(report.diagnostics.bySixHourBucket.length, 28);
  assert.equal(report.diagnostics.byDaypart.length, 4);
  assert.equal(report.diagnostics.byLeadBand.length, 7);
  assert.deepEqual(
    report.diagnostics.byLocalDate.map(
      // retain chronological date diagnostics
      (item) => item.localDate,
    ),
    ["2026-01-01", "2026-01-02"],
  );
  assert.equal(
    report.diagnostics.byLocalDate[0].comparison.baselineFull.eventCount,
    1,
  );
  assert.equal(
    report.diagnostics.byExactLeadHour[1].comparison.raw.eventCount,
    0,
  );
  assert.equal(
    report.diagnostics.byExactLeadHour[1].comparison.raw
      .eventWeightedMeanAbsoluteError,
    null,
  );
  assert.equal(
    report.diagnostics.byExactLeadHour[1].comparison.baselineFull.eventCount,
    0,
  );
  assert.equal(
    report.diagnostics.byExactLeadHour[1].comparison.staticLinearTaper
      .eventWeightedMeanAbsoluteError,
    null,
  );
  assert.equal(
    report.diagnostics.byExactLeadHour[1].comparison.causalAdaptive
      .eventWeightedMeanAbsoluteError,
    null,
  );
  assert.deepEqual(
    report.diagnostics.bySixHourBucket[0].fixedAlphaScores.map(
      // retain the complete frozen grid
      (item) => item.alpha,
    ),
    TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID,
  );
  assert.equal(
    report.diagnostics.bySixHourBucket[1].fixedAlphaScores.length,
    TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.length,
  );
  assert.equal(
    report.diagnostics.bySixHourBucket[1].fixedAlphaScores[0].score
      .eventWeightedMeanAbsoluteError,
    null,
  );
  assert.equal(
    report.staticLinearTaper.bandBoundaryTreatment,
    "24_to_25_hour_reset_is_intentional_experimental_behavior_not_recommended_policy",
  );
});

// verify diagnostic strategies share exact sample denominators
test("uses common samples for every diagnostic strategy and alpha", () => {
  const report = analyzeTemperatureLeadResearch([
    researchEvent(),
    researchEvent({
      actual: 11,
      baselineAdjusted: 13,
      targetLeadHours: 2,
    }),
    researchEvent({
      actual: 9,
      baselineAdjusted: 11,
      targetLeadHours: 25,
      validAt: "2026-01-02T16:00:00.000Z",
    }),
  ]);
  const comparisons = [
    ...report.diagnostics.byExactLeadHour.map(
      // retain each complete exact-lead comparison
      (item) => item.comparison,
    ),
    ...report.diagnostics.bySixHourBucket.map(
      // retain each complete lead-bucket comparison
      (item) => item.comparison,
    ),
    ...report.diagnostics.byDaypart.map(
      // retain each complete daypart comparison
      (item) => item.comparison,
    ),
    ...report.diagnostics.byLeadBand.map(
      // retain each complete broad-band comparison
      (item) => item.comparison,
    ),
  ];

  // require identical support for every strategy in every cell
  for (const comparison of comparisons) {
    const denominators = Object.values(comparison).map(
      // retain the three sample dimensions
      (score) => [score.eventCount, score.uniqueValidHours, score.localDateCount],
    );
    assert.deepEqual(
      denominators,
      Array.from({ length: 4 }, () => denominators[0]),
    );
  }

  // require every bucket alpha to use its strategy denominator
  for (const bucket of report.diagnostics.bySixHourBucket) {
    const expected = [
      bucket.comparison.raw.eventCount,
      bucket.comparison.raw.uniqueValidHours,
      bucket.comparison.raw.localDateCount,
    ];

    // compare all five fixed-grid denominators
    for (const item of bucket.fixedAlphaScores) {
      assert.deepEqual(
        [
          item.score.eventCount,
          item.score.uniqueValidHours,
          item.score.localDateCount,
        ],
        expected,
      );
    }
  }
});

// verify unique-hour balancing differs from event weighting
test("balances calibration scores equally by valid hour", () => {
  const report = analyzeTemperatureLeadResearch([
    researchEvent({ actual: 0, baselineAdjusted: 0, rawForecast: 0 }),
    researchEvent({
      actual: 10,
      baselineAdjusted: 0,
      rawForecast: 0,
      targetLeadHours: 2,
    }),
    researchEvent({
      actual: 0,
      baselineAdjusted: 0,
      rawForecast: 0,
      validAt: "2026-01-02T16:00:00.000Z",
    }),
  ]);

  assert.equal(report.overall.raw.eventWeightedMeanAbsoluteError, 10 / 3);
  assert.equal(
    report.overall.raw.uniqueHourBalancedMeanAbsoluteError,
    2.5,
  );
  assert.equal(report.overall.raw.eventCount, 3);
  assert.equal(report.overall.raw.uniqueValidHours, 2);
  assert.equal(report.overall.raw.localDateCount, 2);
});

// verify causal selection and future-outcome isolation
test("selects causal alpha only from observations available at issue time", () => {
  const baselineEvents = causalSeries(
    // make the complete baseline correction historically perfect
    () => 12,
  );
  const changedFutureEvents = causalSeries(
    // change only later actuals to favor raw forecasts
    (day) => (day >= 5 && day <= 9 ? 10 : 12),
  );
  const baselineReport = analyzeTemperatureLeadResearch(baselineEvents);
  const changedReport = analyzeTemperatureLeadResearch(changedFutureEvents);
  const firstSupportedValidAt = "2026-01-04T23:00:00.000Z";
  const beforeMutationValidAt = "2026-01-05T16:00:00.000Z";
  const afterMutationValidAt = "2026-01-11T16:00:00.000Z";
  const firstSupported = traceFor(baselineReport, firstSupportedValidAt);

  assert.equal(firstSupported.calibrated, true);
  assert.equal(firstSupported.supportUniqueValidHours, 30);
  assert.equal(firstSupported.supportLocalDateCount, 4);
  assert.equal(firstSupported.selectedAlpha, 1);
  assert.deepEqual(
    traceFor(baselineReport, beforeMutationValidAt),
    traceFor(changedReport, beforeMutationValidAt),
  );
  assert.equal(
    traceFor(baselineReport, afterMutationValidAt).selectedAlpha,
    1,
  );
  assert.equal(traceFor(changedReport, afterMutationValidAt).selectedAlpha, 0);

  // prove every consumed observation respects its issue cutoff
  for (const trace of changedReport.causalTrace) {
    // compare only nonempty support cutoffs
    if (trace.latestConsumedObservationAvailableAt !== null) {
      assert.ok(
        Date.parse(trace.latestConsumedObservationAvailableAt) <=
          Date.parse(trace.calibrationCutoff),
      );
    }
  }
});

// verify stable results independent from ordering or optional milliseconds
test("is deterministic for canonical event sets and UTC notation", () => {
  const events = causalSeries(
    // alternate the preferred correction by date
    (day) => (day % 2 === 0 ? 12 : 10),
  );
  const report = analyzeTemperatureLeadResearch(events);

  assert.deepEqual(
    report,
    analyzeTemperatureLeadResearch([...events].reverse()),
  );
  assert.deepEqual(
    report,
    analyzeTemperatureLeadResearch(events.map(
      // omit only optional zero milliseconds
      (event) => ({
        ...event,
        referenceAt: event.referenceAt.replace(".000Z", "Z"),
        validAt: event.validAt.replace(".000Z", "Z"),
      }),
    )),
  );
});

// reject calendar normalization that would silently change event identities
test("rejects nonexistent UTC dates and overflowing clock fields", () => {
  const invalidInstants = [
    {
      referenceAt: "2026-02-30T15:00:00Z",
      validAt: "2026-02-30T16:00:00Z",
    },
    {
      referenceAt: "2026-02-30T15:00:00Z",
      validAt: "2026-03-02T16:00:00Z",
    },
    {
      referenceAt: "2026-01-01T23:00:00Z",
      validAt: "2026-01-01T24:00:00Z",
    },
  ];

  // reject both target and issue-time rollovers
  for (const instants of invalidInstants) {
    assert.throws(
      // exercise the public research input boundary
      () => analyzeTemperatureLeadResearch([researchEvent(instants)]),
      RangeError,
    );
  }
});

// verify strict finite, identity, and temporal guards
test("rejects invalid or duplicate research events", () => {
  const event = researchEvent();

  assert.throws(() => analyzeTemperatureLeadResearch([]), /non-empty/u);
  assert.throws(
    () => analyzeTemperatureLeadResearch([event, { ...event }]),
    /canonicalized/u,
  );
  assert.throws(
    () => analyzeTemperatureLeadResearch([{ ...event, actual: Number.NaN }]),
    /actual must be finite/u,
  );
  assert.throws(
    () =>
      analyzeTemperatureLeadResearch([
        { ...event, referenceAt: event.validAt },
      ]),
    /must match/u,
  );
  assert.throws(
    () =>
      analyzeTemperatureLeadResearch([
        { ...event, targetLeadHours: 1.5 },
      ]),
    /integer/u,
  );
  assert.throws(
    () =>
      analyzeTemperatureLeadResearch([
        researchEvent({ validAt: "2026-01-01T16:30:00.000Z" }),
      ]),
    /exact UTC hour/u,
  );
});
