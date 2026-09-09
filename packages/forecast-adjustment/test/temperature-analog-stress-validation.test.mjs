import assert from "node:assert/strict";
import test from "node:test";
import { analyzeTemperatureAnalogStress } from "../dist/temperature-analog-stress-validation.js";

const HOUR = 3_600_000;

// construct one frozen midpoint and a causal synthetic source audit
function record(input = {}) {
  const validAt = input.validAt ?? "2026-08-26T18:00:00.000Z";
  const lead = input.targetLeadHours ?? 1;
  const referenceAt = input.referenceAt ?? new Date(Date.parse(validAt) - lead * HOUR).toISOString();
  const prior = input.priorPrediction ?? 2;
  const full = input.analogPrediction ?? 0;
  return {
    actual: 0, baselineEligible: true, fallbackReason: null,
    key: input.key ?? `${validAt}|${lead}`, rawForecast: 3,
    priorPrediction: prior, analogPrediction: full,
    shrunkAnalogPrediction: prior + 0.5 * (full - prior),
    targetLeadHours: lead, validAt, referenceAt,
    selectedSources: Array.from({ length: 12 },
      // place twelve distinct valid hours before the target reference
      (_, index) => ({ key: `source-${index}`,
        validAt: new Date(Date.parse(referenceAt) - (index + 1) * HOUR).toISOString(),
        referenceAt: new Date(Date.parse(referenceAt) - (index + 2) * HOUR).toISOString(),
      }),
    ),
    ...input,
  };
}

// isolate one availability scenario and horizon
function lagScope(report, lag, scope = "first12") {
  return report.availability.find(
    // identify one fixed lag
    (row) => row.lagHours === lag,
  ).scopes.find(
    // identify one fixed horizon
    (row) => row.key === scope,
  ).scores;
}

// require all omission windows rather than a favorable selected subset
test("enumerates all pairs, their contiguous subset, triples, windows and 48 cells", () => {
  const rows = Array.from({ length: 12 },
    // retain twelve complete represented calendar dates
    (_, index) => record({ validAt: new Date(Date.UTC(2026, 7, 26 + index, 18)).toISOString() }),
  );
  const result = analyzeTemperatureAnalogStress(rows);
  assert.equal(result.pairOmissions.length, 66);
  assert.equal(result.pairOmissions.filter(
    // count consecutive pairs as a tagged subset
    (row) => row.consecutive,
  ).length, 11);
  assert.equal(result.contiguousOmissions.length, 1);
  assert.equal(result.contiguousOmissions[0].length, 3);
  assert.equal(result.contiguousOmissions[0].rows.length, 10);
  assert.equal(result.rollingWindows.length, 10);
  assert.equal(result.pairOmissions[0].scores.halfAnalog.eventCount, 10);
  assert.equal(result.rollingWindows[0].scores.halfAnalog.eventCount, 3);
  assert.equal(result.leadByDaypart.length, 48);
  assert.equal(result.leadByDaypart.filter(
    // retain explicit empty cells
    (row) => row.scores.halfAnalog.eventCount === 0,
  ).length, 47);
  assert.equal(result.qualification, false);
});

// distinguish equal-date weighting from equal-hour and event weighting
test("equal-date scores average daily equal-hour means including partial dates", () => {
  const rows = [
    record({ key: "a", rawForecast: 0 }),
    record({ key: "b", rawForecast: 2, targetLeadHours: 2 }),
    record({ key: "c", validAt: "2026-08-26T19:00:00.000Z", rawForecast: 3 }),
    record({ key: "d", validAt: "2026-08-27T18:00:00.000Z", rawForecast: 8 }),
  ];
  const result = analyzeTemperatureAnalogStress(rows);
  assert.equal(result.primary.raw.eventWeightedMeanAbsoluteError, 13 / 4);
  assert.equal(result.primary.raw.hourBalancedMeanAbsoluteError, 4);
  assert.equal(result.equalDateMaeC.raw, 5);
  assert.equal(result.daily[0].supportedEventCount, 3);
  assert.equal(result.daily[0].supportedUniqueValidHours, 2);
});

// require common hours and deterministic vintage selection without averaging leads
test("earliest and latest views use reference then greatest key and expose lead mix", () => {
  const rows = [record({ key: "a", targetLeadHours: 6, rawForecast: 6 }),
    record({ key: "b", targetLeadHours: 1, rawForecast: 2 }),
    record({ key: "c", targetLeadHours: 1, rawForecast: 4 })];
  const result = analyzeTemperatureAnalogStress(rows);
  assert.equal(result.vintageViews[0].scores.raw.hourBalancedMeanAbsoluteError, 6);
  assert.equal(result.vintageViews[1].scores.raw.hourBalancedMeanAbsoluteError, 4);
  assert.equal(result.vintageViews[0].leadCounts[5].eventCount, 1);
  assert.equal(result.vintageViews[1].leadCounts[0].eventCount, 1);
  assert.equal(result.vintageViews[0].scores.raw.uniqueValidHours, 1);
  assert.deepEqual(result, analyzeTemperatureAnalogStress([...rows].reverse()));
});

// distinguish the inclusive availability boundary from a one-millisecond delay
test("availability keeps exact-boundary sources and falls both analogs back without reselection", () => {
  const row = record();
  const boundary = { ...row, selectedSources: row.selectedSources.map(
    // shift every selected source back one more hour
    (source) => ({ ...source, validAt: new Date(Date.parse(source.validAt) - HOUR).toISOString(),
      referenceAt: new Date(Date.parse(source.referenceAt) - HOUR).toISOString() }),
  ) };
  const result = analyzeTemperatureAnalogStress([boundary]);
  assert.deepEqual(lagScope(result, 1), result.primary);
  assert.deepEqual(lagScope(result, 2), result.primary);
  assert.equal(lagScope(result, 3).halfAnalog.hourBalancedMeanAbsoluteError, 2);
  assert.equal(lagScope(result, 3).fullAnalog.hourBalancedMeanAbsoluteError, 2);
  assert.equal(result.availability[2].newlyUnsupportedCount, 1);
  const slightlyLate = { ...boundary, selectedSources: boundary.selectedSources.map(
    // move the nearest source one millisecond past the stressed boundary
    (source, index) => index === 0 ? { ...source, validAt: new Date(Date.parse(source.validAt) + 1).toISOString() } : source,
  ) };
  assert.equal(analyzeTemperatureAnalogStress([slightlyLate]).availability[1].newlyUnsupportedCount, 1);
});

// preserve partial-source fallbacks and every protected later prediction
test("availability preserves original partial fallbacks and all leads after twelve", () => {
  const partial = record({ key: "fallback", analogPrediction: 2, shrunkAnalogPrediction: 2,
    fallbackReason: "fewer_than_12_analogs", selectedSources: record().selectedSources.slice(0, 3) });
  const later = record({ key: "later", targetLeadHours: 49, analogPrediction: 2,
    shrunkAnalogPrediction: 2, fallbackReason: "outside_first12", selectedSources: [] });
  const before = JSON.stringify([partial, later]);
  const result = analyzeTemperatureAnalogStress([partial, later]);
  // require exact fallbacks under every scenario
  for (const scenario of result.availability) {
    assert.equal(scenario.newlyUnsupportedCount, 0);
    assert.equal(scenario.retainedSupportedCount, 0);
    assert.equal(scenario.scopes.find(
      // identify protected later forecasts
      (scope) => scope.key === "after48",
    ).scores.halfAnalog.hourBalancedMeanAbsoluteError, 2);
  }
  assert.equal(JSON.stringify([partial, later]), before);
});

// prevent invalid evidence from creating plausible stress results
test("rejects invalid midpoints, sources, shared labels, identities and date gaps", () => {
  const row = record();
  const invalid = [
    [{ ...row, shrunkAnalogPrediction: 1.1 }],
    [{ ...row, selectedSources: row.selectedSources.slice(1) }],
    [{ ...row, selectedSources: [row.selectedSources[0], ...row.selectedSources.slice(0, 11)] }],
    [{ ...row, selectedSources: [{ ...row.selectedSources[0], validAt: row.referenceAt }, ...row.selectedSources.slice(1)] }],
    [{ ...row, selectedSources: [{ ...row.selectedSources[0], validAt: "not-a-date" }, ...row.selectedSources.slice(1)] }],
    [row, { ...row, key: "other", actual: 1 }], [row, row],
    [row, record({ validAt: "2026-08-28T18:00:00.000Z" })],
  ];
  // reject every malformed evidence variant
  for (const rows of invalid) {
    assert.throws(
      // exercise complete input validation
      () => analyzeTemperatureAnalogStress(rows),
    );
  }
});

// keep DST repeated hours distinct and derive local-date membership
test("scores both DST repeated UTC hours without trusting imported local labels", () => {
  const rows = [record({ validAt: "2026-11-01T08:00:00.000Z", localDate: "wrong" }),
    record({ validAt: "2026-11-01T09:00:00.000Z", localDate: "wrong" })];
  const result = analyzeTemperatureAnalogStress(rows);
  assert.equal(result.dateCount, 1);
  assert.equal(result.primary.raw.uniqueValidHours, 2);
  assert.deepEqual(result.daily[0].dates, ["2026-11-01"]);
});

// preserve explicit absence rather than manufacturing zero error
test("empty populations retain null metrics and no omission windows", () => {
  const result = analyzeTemperatureAnalogStress([]);
  assert.equal(result.primary.halfAnalog.hourBalancedMeanAbsoluteError, null);
  assert.equal(result.equalDateMaeC.halfAnalog, null);
  assert.equal(result.pairOmissions.length, 0);
  assert.equal(result.rollingWindows.length, 0);
  assert.equal(result.leadByDaypart.length, 48);
  assert.equal(result.availability[0].retainedSupportedCount, 0);
});
