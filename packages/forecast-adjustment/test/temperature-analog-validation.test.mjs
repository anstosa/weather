import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTemperatureAnalogValidation,
  scoreTemperatureAnalogValidationRecords,
  TEMPERATURE_ANALOG_VALIDATION_POLICY,
} from "../dist/temperature-analog-validation.js";

const HOUR = 3_600_000;

// create one structurally complete validation record
function validationRecord(input = {}) {
  const validAt = input.validAt ?? "2025-04-20T18:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 6;
  const referenceAt = input.referenceAt ?? new Date(
    Date.parse(validAt) - targetLeadHours * HOUR,
  ).toISOString();

  return {
    actual: input.actual ?? 0,
    analogPrediction: input.analogPrediction ?? 1,
    baselineEligible: input.baselineEligible ?? true,
    fallbackReason: Object.hasOwn(input, "fallbackReason")
      ? input.fallbackReason
      : null,
    key: input.key ?? `${validAt}|${targetLeadHours}`,
    priorPrediction: input.priorPrediction ?? 2,
    rawForecast: input.rawForecast ?? 3,
    referenceAt,
    targetLeadHours,
    validAt,
  };
}

// locate one fixed scope
function scope(report, key) {
  const selected = report.scopes.find(
    // match one scope identity
    (candidate) => candidate.key === key,
  );

  // require the fixed scope
  if (selected === undefined) {
    throw new Error(`missing scope ${key}`);
  }

  return selected;
}

// compare floating-point values closely
function assertClose(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${String(actual)} to equal ${String(expected)}`,
  );
}

// prove event and equal-hour arithmetic with duplicate anchors
test("scores duplicate anchors with equal valid-hour primary weighting", () => {
  const firstHour = "2025-04-20T18:00:00.000Z";
  const secondHour = "2025-04-20T19:00:00.000Z";
  const records = [
    validationRecord({
      analogPrediction: 0.5,
      key: "a",
      priorPrediction: 0,
      rawForecast: 1,
      targetLeadHours: 1,
      validAt: firstHour,
    }),
    validationRecord({
      analogPrediction: -0.5,
      key: "b",
      priorPrediction: 2,
      rawForecast: 3,
      targetLeadHours: 2,
      validAt: firstHour,
    }),
    validationRecord({
      analogPrediction: 1,
      key: "c",
      priorPrediction: 4,
      rawForecast: 5,
      targetLeadHours: 1,
      validAt: secondHour,
    }),
  ];
  const comparison = scoreTemperatureAnalogValidationRecords(records);
  const raw = comparison.raw;

  assert.equal(raw.eventCount, 3);
  assert.equal(raw.uniqueValidHours, 2);
  assert.equal(raw.localDateCount, 1);
  assert.equal(raw.eventWeightedMeanAbsoluteError, 3);
  assert.equal(raw.hourBalancedMeanAbsoluteError, 3.5);
  assert.equal(raw.hourBalancedSignedBias, 3.5);
  assertClose(raw.hourBalancedRootMeanSquaredError, Math.sqrt(15));
  assert.equal(raw.hourBalancedFractionAbsoluteErrorAbove2C, 0.75);
  assert.equal(raw.hourBalancedFractionAbsoluteErrorAbove3C, 0.5);
  assert.deepEqual(raw.hourlyMeanAbsoluteErrorPercentiles, {
    maximum: 5,
    p50: 3.5,
    p90: 4.7,
    p95: 4.85,
    p99: 4.97,
  });
});

// prove paired moving-block bootstrap values against a degenerate oracle
test("runs deterministic paired bootstrap with exact constant-date improvements", () => {
  const records = [
    validationRecord({
      actual: 0,
      analogPrediction: 2,
      key: "date-a",
      priorPrediction: 3,
      rawForecast: 4,
      targetLeadHours: 1,
      validAt: "2025-04-01T18:00:00.000Z",
    }),
    validationRecord({
      actual: 10,
      analogPrediction: 12,
      key: "date-b",
      priorPrediction: 13,
      rawForecast: 14,
      targetLeadHours: 1,
      validAt: "2025-04-02T18:00:00.000Z",
    }),
  ];
  const first = analyzeTemperatureAnalogValidation(records);
  const second = analyzeTemperatureAnalogValidation(records);

  assert.deepEqual(first.bootstrap, second.bootstrap);
  assert.equal(first.bootstrap.length, 3);

  // require the exact oracle for every frozen block length
  for (const block of first.bootstrap) {
    assert.equal(block.configuredReplicateCount, 20_000);
    assert.equal(block.completedReplicateCount, 20_000);
    assert.equal(block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.point, 2);
    assert.deepEqual(
      block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.confidenceInterval95,
      { lower: 2, upper: 2 },
    );
    assert.equal(block.rawMinusAnalog.relativePercent.point, 50);
    assert.deepEqual(
      block.rawMinusAnalog.relativePercent.confidenceInterval95,
      { lower: 50, upper: 50 },
    );
    assert.equal(block.priorMinusAnalog.absoluteMeanAbsoluteErrorC.point, 1);
    assert.deepEqual(
      block.priorMinusAnalog.absoluteMeanAbsoluteErrorC.confidenceInterval95,
      { lower: 1, upper: 1 },
    );
    assertClose(block.priorMinusAnalog.relativePercent.point, 100 / 3);
    assertClose(
      block.priorMinusAnalog.relativePercent.confidenceInterval95.lower,
      100 / 3,
    );
    assertClose(
      block.priorMinusAnalog.relativePercent.confidenceInterval95.upper,
      100 / 3,
    );
  }

  assert.deepEqual(first.first12DateOutcomes.versusRaw, {
    tieCount: 0,
    winCount: 2,
    worseCount: 0,
  });
  assert.deepEqual(first.first12DateOutcomes.versusPrior, {
    tieCount: 0,
    winCount: 2,
    worseCount: 0,
  });
  assert.equal(first.leaveOneLocalDateOut.rows.length, 2);
  assert.deepEqual(first.leaveOneLocalDateOut.rawMinusAnalogMeanAbsoluteErrorCRange, {
    maximum: 2,
    minimum: 2,
  });
  assert.equal(first.chronologicalSplit.earlier.localDateCount, 1);
  assert.equal(first.chronologicalSplit.later.localDateCount, 1);
});

// isolate undefined relative ratios to their own comparator
test("preserves raw relative intervals when prior loss is perfect", () => {
  const report = analyzeTemperatureAnalogValidation([
    validationRecord({
      analogPrediction: 0,
      key: "perfect-a",
      priorPrediction: 0,
      rawForecast: 2,
      validAt: "2025-04-01T18:00:00.000Z",
    }),
    validationRecord({
      analogPrediction: 10,
      actual: 10,
      key: "perfect-b",
      priorPrediction: 10,
      rawForecast: 12,
      validAt: "2025-04-02T18:00:00.000Z",
    }),
  ]);

  // verify every independently seeded distribution
  for (const block of report.bootstrap) {
    assert.equal(
      block.priorMinusAnalog.relativePercent.confidenceInterval95,
      null,
    );
    assert.deepEqual(
      block.rawMinusAnalog.relativePercent.confidenceInterval95,
      { lower: 100, upper: 100 },
    );
  }
});

// preserve explicit empty metrics and fixed diagnostics
test("reports every empty scope and null bootstrap interval", () => {
  const report = analyzeTemperatureAnalogValidation([]);

  assert.equal(report.scopes.length, 7);
  assert.equal(report.diagnostics.byExactLeadHour.length, 12);
  assert.equal(report.diagnostics.bySeason.length, 4);
  assert.equal(report.diagnostics.byDaypart.length, 4);
  assert.equal(scope(report, "overall").comparison.raw.eventCount, 0);
  assert.equal(
    scope(report, "overall").comparison.raw.hourBalancedMeanAbsoluteError,
    null,
  );
  assert.equal(report.bootstrap.length, 3);

  // retain all bootstrap configurations without pretending to sample
  for (const block of report.bootstrap) {
    assert.equal(block.completedReplicateCount, 0);
    assert.equal(
      block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.confidenceInterval95,
      null,
    );
    assert.equal(block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.point, null);
  }

  assert.equal(report.qualification, false);
  assert.equal(report.productionActivationAllowed, false);
});

// withhold intervals for a single represented local date
test("reports single-date points but no bootstrap intervals", () => {
  const report = analyzeTemperatureAnalogValidation([
    validationRecord({
      analogPrediction: 1,
      key: "single",
      priorPrediction: 2,
      rawForecast: 3,
    }),
  ]);

  // retain every frozen block length
  for (const block of report.bootstrap) {
    assert.equal(block.representedLocalDateCount, 1);
    assert.equal(block.completedReplicateCount, 0);
    assert.equal(block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.point, 2);
    assert.equal(
      block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.confidenceInterval95,
      null,
    );
  }

  assert.equal(report.leaveOneLocalDateOut.rows.length, 1);
  assert.equal(
    report.leaveOneLocalDateOut.rows[0].comparison.analog.eventCount,
    0,
  );
  assert.deepEqual(report.first12DateOutcomes.versusRaw, {
    tieCount: 0,
    winCount: 1,
    worseCount: 0,
  });
});

// retain ineligible and fallback rows in every aggregate
test("retains fallback and baseline-ineligible rows", () => {
  const report = analyzeTemperatureAnalogValidation([
    validationRecord({
      baselineEligible: false,
      fallbackReason: "baseline_ineligible",
      key: "ineligible",
    }),
    validationRecord({
      fallbackReason: "fewer_than_12_analogs",
      key: "fallback",
      targetLeadHours: 7,
    }),
  ]);

  assert.equal(scope(report, "first12").comparison.analog.eventCount, 2);
});

// derive diagnostic calendar cells from the canonical timestamp
test("derives exact-lead season and daypart diagnostics", () => {
  const report = analyzeTemperatureAnalogValidation([
    validationRecord({
      key: "winter-night",
      targetLeadHours: 12,
      validAt: "2025-01-20T08:00:00.000Z",
    }),
  ]);
  const lead = report.diagnostics.byExactLeadHour.find(
    // locate the exact lead cell
    (candidate) => candidate.targetLeadHours === 12,
  );
  const season = report.diagnostics.bySeason.find(
    // locate the winter cell
    (candidate) => candidate.season === "winter",
  );
  const daypart = report.diagnostics.byDaypart.find(
    // locate the night cell
    (candidate) => candidate.daypart === "night",
  );

  assert.equal(lead?.comparison.analog.eventCount, 1);
  assert.equal(season?.comparison.analog.eventCount, 1);
  assert.equal(daypart?.comparison.analog.eventCount, 1);
});

// enforce exact preservation after the analog target window
test("requires unchanged prior predictions after 12 hours", () => {
  assert.throws(
    () => analyzeTemperatureAnalogValidation([
      validationRecord({
        analogPrediction: 1,
        key: "changed",
        priorPrediction: 2,
        targetLeadHours: 13,
      }),
    ]),
    /must equal priorPrediction/u,
  );

  const report = analyzeTemperatureAnalogValidation([
    validationRecord({
      analogPrediction: 2,
      key: "unchanged",
      priorPrediction: 2,
      targetLeadHours: 13,
    }),
  ]);

  assert.equal(scope(report, "hours13To48").comparison.analog.eventCount, 1);
  assert.deepEqual(
    scope(report, "hours13To48").comparison.analog,
    scope(report, "hours13To48").comparison.prior,
  );
});

// reject malformed structural validation evidence
test("rejects invalid prediction records", () => {
  const duplicate = validationRecord({ key: "duplicate" });
  const cases = [
    {
      records: [duplicate, { ...duplicate }],
      pattern: /keys must be unique/u,
    },
    {
      records: [
        validationRecord({ key: "actual-a" }),
        validationRecord({ actual: 1, key: "actual-b", targetLeadHours: 7 }),
      ],
      pattern: /actual must be identical/u,
    },
    {
      records: [validationRecord({ analogPrediction: Number.NaN })],
      pattern: /analogPrediction must be finite/u,
    },
    {
      records: [validationRecord({ targetLeadHours: 0 })],
      pattern: /integer between 1 and 168/u,
    },
    {
      records: [validationRecord({ validAt: "2025-04-20T18:00:00Z" })],
      pattern: /canonical UTC instant/u,
    },
    {
      records: [validationRecord({ referenceAt: "2025-04-20T17:30:00.000Z" })],
      pattern: /must match validAt and referenceAt/u,
    },
    {
      records: [validationRecord({ baselineEligible: "yes" })],
      pattern: /baselineEligible must be boolean/u,
    },
    {
      records: [validationRecord({ fallbackReason: 1 })],
      pattern: /fallbackReason must be a string or null/u,
    },
  ];

  // exercise every validation boundary
  for (const entry of cases) {
    assert.throws(
      () => analyzeTemperatureAnalogValidation(entry.records),
      entry.pattern,
    );
  }
});

// expose the complete immutable public policy
test("freezes the non-overridable public validation policy", () => {
  assert.equal(TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount, 20_000);
  assert.deepEqual(TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.blockLengths, [1, 2, 3]);
  assert.equal(TEMPERATURE_ANALOG_VALIDATION_POLICY.qualificationAllowed, false);
  assert.equal(Object.isFrozen(TEMPERATURE_ANALOG_VALIDATION_POLICY), true);
  assert.equal(Object.isFrozen(TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap), true);
});

// bind heterogeneous partial dates to an independent Python bootstrap oracle
test("preserves block order and partial-date weights in heterogeneous bootstrap", () => {
  const counts = [1, 3, 2, 5, 1, 4, 2];
  const raw = [1.3, 2.7, 0.8, 4.2, 1.1, 3.4, 2.0];
  const prior = [1.1, 2.3, 1.0, 3.7, 0.9, 2.8, 1.9];
  const analog = [1.4, 1.8, 0.7, 3.0, 1.0, 3.3, 1.2];
  const records = [];
  // retain seven consecutive days with deliberately unequal hour counts
  for (let date = 0; date < counts.length; date += 1) {
    // retain each represented UTC hour without duplicating date weight
    for (let hour = 0; hour < counts[date]; hour += 1) {
      records.push(validationRecord({
        analogPrediction: analog[date],
        key: `heterogeneous-${date}-${hour}`,
        priorPrediction: prior[date],
        rawForecast: raw[date],
        targetLeadHours: 1,
        validAt: new Date(Date.UTC(2025, 3, date + 1, hour + 15)).toISOString(),
      }));
    }
  }
  // freeze independent absolute and relative intervals for both comparators
  const expected = [
    [
      [
        0.16666666666666652,
        0.9681818181818183
      ],
      [
        6.666666666666678,
        31.31036456957087
      ],
      [
        -0.20909090909090922,
        0.5909090909090908
      ],
      [
        -9.365558912386703,
        24.84848484848485
      ]
    ],
    [
      [
        0.2466666666666666,
        0.9136363636363631
      ],
      [
        9.273182957393482,
        29.440389294403897
      ],
      [
        -0.18421052631578938,
        0.5555555555555558
      ],
      [
        -7.906976744186037,
        21.763085399449043
      ]
    ],
    [
      [
        0.2625000000000002,
        0.8684210526315788
      ],
      [
        10.59431524547804,
        30.26819923371648
      ],
      [
        -0.11333333333333329,
        0.5499999999999998
      ],
      [
        -5.167173252279634,
        21.62162162162162
      ]
    ]
  ];
  const report = analyzeTemperatureAnalogValidation(records);
  // verify every block length rather than selecting a favorable interval
  for (const [index, block] of report.bootstrap.entries()) {
    const intervals = [
      block.rawMinusAnalog.absoluteMeanAbsoluteErrorC.confidenceInterval95,
      block.rawMinusAnalog.relativePercent.confidenceInterval95,
      block.priorMinusAnalog.absoluteMeanAbsoluteErrorC.confidenceInterval95,
      block.priorMinusAnalog.relativePercent.confidenceInterval95,
    ];
    // compare all paired absolute and relative bounds
    for (const [intervalIndex, interval] of intervals.entries()) {
      assertClose(interval.lower, expected[index][intervalIndex][0], 1e-10);
      assertClose(interval.upper, expected[index][intervalIndex][1], 1e-10);
    }
  }
});
