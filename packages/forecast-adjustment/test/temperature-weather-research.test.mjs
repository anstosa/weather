import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalSha256,
} from "../dist/candidate.js";
import {
  analyzeTemperatureNearNowcastResearch,
  analyzeTemperatureBoostedHybridResearch,
  analyzeTemperatureBoostedResearch,
  analyzeTemperatureWeatherAdaptiveResearch,
  analyzeTemperatureWeatherHybridResearch,
  analyzeTemperatureOnlyResearch,
  analyzeTemperatureWeatherHorizonResearch,
  analyzeTemperatureWeatherResearch,
  analyzeTemperatureWeatherRecencyResearch,
  analyzeTemperatureWeatherShrinkageResearch,
  TEMPERATURE_BOOSTED_FEATURE_NAMES,
} from "../dist/temperature-weather-research.js";
import { analyzeTemperatureLeadResearch } from "../dist/temperature-lead-research.js";

// create one exact fixed-anchor event
function anchorEvent(input = {}) {
  // preserve explicit null predictors while defaulting omitted fields
  return {
    actual: input.actual ?? 10,
    baselineAdjusted: input.baselineAdjusted ?? 10,
    baselineEligible: input.baselineEligible ?? true,
    rawForecast: input.rawForecast ?? 10,
    rawRelativeHumidityPercent: Object.hasOwn(input, "rawRelativeHumidityPercent")
      ? input.rawRelativeHumidityPercent
      : 60,
    rawWindSpeedMps: Object.hasOwn(input, "rawWindSpeedMps")
      ? input.rawWindSpeedMps
      : 3,
    referenceAt: input.referenceAt ?? null,
    targetLeadHours: input.targetLeadHours ?? 24,
    validAt: input.validAt ?? "2025-02-15T16:00:00.000Z",
  };
}

// create one supported winter morning cell
function trainingCell(input = {}) {
  const count = input.count ?? 50;
  const dateCount = input.dateCount ?? 10;
  const startDay = input.startDay ?? 1;
  const rows = [];

  // distribute support across exact hours and local dates
  for (let index = 0; index < count; index += 1) {
    const dayOffset = index % dateCount;
    const hourOffset = Math.floor(index / dateCount);
    rows.push(anchorEvent({
      actual: input.actual ?? 16,
      baselineAdjusted: input.baselineAdjusted ?? 4,
      rawForecast: input.rawForecast ?? 0,
      rawRelativeHumidityPercent: input.rawRelativeHumidityPercent ?? 60,
      rawWindSpeedMps: input.rawWindSpeedMps ?? 3,
      targetLeadHours: input.targetLeadHours ?? 24,
      validAt: new Date(
        Date.UTC(2025, 0, startDay + dayOffset, 14 + hourOffset),
      ).toISOString(),
    }));
  }

  return rows;
}

// analyze one fixed-anchor experiment
function analyze(trainingEvents, scoreEvents) {
  return analyzeTemperatureWeatherResearch({
    scoreCohort: "fixed_lead_anchor",
    scoreEvents,
    trainingEvents,
  });
}

// analyze one live horizon-gate experiment
function analyzeHorizon(trainingEvents, scoreEvents) {
  return analyzeTemperatureWeatherHorizonResearch({
    scoreCohort: "legacy_v4_retrieval_snapshot",
    scoreEvents,
    trainingEvents,
  });
}

// analyze one live adaptive-correction experiment
function analyzeAdaptive(trainingEvents, scoreEvents, scoreCohort = "legacy_v4_retrieval_snapshot") {
  return analyzeTemperatureWeatherAdaptiveResearch({
    scoreCohort,
    scoreEvents,
    trainingEvents,
  });
}

// analyze one live fixed hybrid experiment
function analyzeHybrid(trainingEvents, scoreEvents, scoreCohort = "legacy_v4_retrieval_snapshot") {
  return analyzeTemperatureWeatherHybridResearch({
    scoreCohort,
    scoreEvents,
    trainingEvents,
  });
}

// analyze one fixed half-weather experiment
function analyzeShrinkage(trainingEvents, scoreEvents, scoreCohort = "fixed_lead_anchor") {
  return analyzeTemperatureWeatherShrinkageResearch({
    scoreCohort,
    scoreEvents,
    trainingEvents,
  });
}

// analyze one fixed recent-training experiment
function analyzeRecency(trainingEvents, scoreEvents, scoreCohort = "fixed_lead_anchor") {
  return analyzeTemperatureWeatherRecencyResearch({
    scoreCohort,
    scoreEvents,
    trainingEvents,
  });
}

// analyze one injected boosted residual experiment
function analyzeBoosted(
  trainingEvents,
  scoreEvents,
  trainer,
  scoreCohort = "fixed_lead_anchor",
) {
  return analyzeTemperatureBoostedResearch({
    scoreCohort,
    scoreEvents,
    trainer,
    trainingEvents,
  });
}

// analyze one fixed boosted hybrid experiment
function analyzeBoostedHybrid(
  trainingEvents,
  scoreEvents,
  trainer,
  scoreCohort = "legacy_v4_retrieval_snapshot",
) {
  return analyzeTemperatureBoostedHybridResearch({
    scoreCohort,
    scoreEvents,
    trainer,
    trainingEvents,
  });
}

// analyze one first-twelve-hour recent-error challenger
function analyzeNearNowcast(
  trainingEvents,
  scoreEvents,
  trainer,
  input = {},
) {
  return analyzeTemperatureNearNowcastResearch({
    scoreCohort: input.scoreCohort ?? "legacy_v4_retrieval_snapshot",
    scoreEvents,
    trainer,
    trainingEvents,
    ...(input.onPrivatePredictionAudit === undefined
      ? {}
      : { onPrivatePredictionAudit: input.onPrivatePredictionAudit }),
  });
}

// create one deterministic stand-in boosted trainer
function boostedTrainer(predictionFor = () => 0) {
  return (request) => ({
    configJson: JSON.stringify({ booster: "stand_in" }),
    modelJson: JSON.stringify({ learner: { kind: "stand_in" } }),
    predictionIds: [...request.predictionIds],
    predictedResiduals: request.predictionFeatures.map(
      // produce one requested stand-in residual
      (features, index) => predictionFor(features, index),
    ),
  });
}

// move one synthetic training cell to another calendar year
function trainingCellYear(year, input = {}) {
  return trainingCell(input).map(
    // preserve every event field except its synthetic valid year
    (event) => ({
      ...event,
      validAt: event.validAt.replace(/^2025/u, String(year)),
    }),
  );
}

// create one daily live sequence in a stable winter model cell
function liveDailySequence(input = {}) {
  const count = input.count ?? 35;
  const startDay = input.startDay ?? 20;
  const targetLeadHours = input.targetLeadHours ?? 24;

  return Array.from({ length: count },
    // retain one forecast and observation per valid hour
    (_unused, index) => {
      const validAt = new Date(Date.UTC(2025, 0, startDay + index, 16));
      const referenceAt = new Date(
        validAt.getTime() - targetLeadHours * 3_600_000,
      );

      return anchorEvent({
        actual: input.actual ?? 2,
        baselineAdjusted: input.baselineAdjusted ?? 0,
        rawForecast: input.rawForecast ?? 0,
        referenceAt: referenceAt.toISOString(),
        targetLeadHours,
        validAt: validAt.toISOString(),
      });
    },
  );
}

// analyze one raw-start temperature-only ablation
function analyzeTemperatureOnly(trainingEvents, scoreEvents, scoreCohort = "fixed_lead_anchor") {
  return analyzeTemperatureOnlyResearch({
    scoreCohort,
    scoreEvents,
    trainingEvents,
  });
}

// locate one structured weather regime
function regime(report, humidityBin, windSpeedBin) {
  const match = report.diagnostics.byWeatherRegime.find(
    // match both raw forecast regime dimensions
    (candidate) =>
      candidate.humidityBin === humidityBin &&
      candidate.windSpeedBin === windSpeedBin,
  );

  // require every frozen regime cell
  if (match === undefined) {
    throw new Error(`missing regime ${humidityBin}|${windSpeedBin}`);
  }

  return match;
}

// verify exact forecast-value bin boundaries including negative temperatures
test("uses frozen temperature, humidity, and wind bins", () => {
  const scoreEvents = [
    anchorEvent({ rawForecast: -5, rawRelativeHumidityPercent: 49.9, rawWindSpeedMps: 1.9 }),
    anchorEvent({ rawForecast: -0.1, rawRelativeHumidityPercent: 50, rawWindSpeedMps: 2, validAt: "2025-02-15T17:00:00.000Z" }),
    anchorEvent({ rawForecast: 0, rawRelativeHumidityPercent: 79.9, rawWindSpeedMps: 4.9, validAt: "2025-02-15T18:00:00.000Z" }),
    anchorEvent({ rawForecast: 4.9, rawRelativeHumidityPercent: 80, rawWindSpeedMps: 5, validAt: "2025-02-15T19:00:00.000Z" }),
    anchorEvent({ rawForecast: 5, rawRelativeHumidityPercent: null, rawWindSpeedMps: null, validAt: "2025-02-15T20:00:00.000Z" }),
  ];
  const report = analyze([], scoreEvents);

  assert.deepEqual(
    report.diagnostics.byTemperatureBin.map(
      // retain numeric bin order
      (item) => item.temperatureBin,
    ),
    [
      { index: -1, maximumExclusiveC: 0, minimumC: -5 },
      { index: 0, maximumExclusiveC: 5, minimumC: 0 },
      { index: 1, maximumExclusiveC: 10, minimumC: 5 },
    ],
  );
  assert.equal(regime(report, "<50", "<2").comparison.raw.eventCount, 1);
  assert.equal(regime(report, "[50,80)", "[2,5)").comparison.raw.eventCount, 2);
  assert.equal(regime(report, ">=80", ">=5").comparison.raw.eventCount, 1);
  assert.equal(regime(report, "missing", "missing").comparison.raw.eventCount, 1);
});

// verify both independent support floors
test("requires fifty unique hours and ten local dates per fitted cell", () => {
  const trainingEvents = [
    ...trainingCell({ count: 49, dateCount: 10, rawForecast: 0, startDay: 1 }),
    ...trainingCell({ count: 50, dateCount: 9, rawForecast: 5, startDay: 12 }),
    ...trainingCell({ count: 50, dateCount: 10, rawForecast: 10, startDay: 22 }),
  ];
  const report = analyze(trainingEvents, [anchorEvent({ validAt: "2025-02-20T16:00:00.000Z" })]);

  assert.deepEqual(
    report.models.calendarStart.temperature.map(
      // retain only independently supported bins
      (cell) => cell.temperatureBin,
    ),
    [2],
  );
  assert.deepEqual(
    report.models.rawStart.temperature.map(
      // retain only independently supported bins
      (cell) => cell.temperatureBin,
    ),
    [2],
  );
  assert.equal(report.models.calendarStart.temperature[0].supportUniqueValidHours, 50);
  assert.equal(report.models.calendarStart.temperature[0].supportLocalDateCount, 10);
});

// verify missing and unsupported weather cells retain common denominators
test("falls back by component without dropping score events", () => {
  const trainingEvents = trainingCell();
  const scoreEvents = [
    anchorEvent({ rawForecast: 0, validAt: "2025-01-20T14:00:00.000Z" }),
    anchorEvent({ rawForecast: 0, rawRelativeHumidityPercent: null, validAt: "2025-01-20T15:00:00.000Z" }),
    anchorEvent({ rawForecast: 0, rawRelativeHumidityPercent: 90, validAt: "2025-01-20T16:00:00.000Z" }),
  ];
  const report = analyze(trainingEvents, scoreEvents);

  assert.deepEqual(
    Object.values(report.overall).map(
      // compare every strategy denominator
      (score) => [score.eventCount, score.uniqueValidHours, score.localDateCount],
    ),
    Array.from({ length: 5 }, () => [3, 3, 1]),
  );
  assert.equal(report.coverage.calendarTemperature.temperatureSupportedCount, 3);
  assert.equal(report.coverage.calendarTemperatureWeather.weatherSupportedCount, 1);
  assert.equal(report.coverage.calendarTemperatureWeather.weatherFeatureMissingCount, 1);
  assert.equal(report.coverage.calendarTemperatureWeather.weatherUnsupportedCount, 1);
  assert.equal(report.coverage.rawTemperatureWeather.weatherSupportedCount, 1);
});

// verify the shared baseline mask forces every nonraw strategy to raw
test("forces all strategies to raw when the baseline is ineligible", () => {
  const report = analyze(trainingCell(), [anchorEvent({
    actual: 20,
    baselineAdjusted: 4,
    baselineEligible: false,
    rawForecast: 0,
    validAt: "2025-01-20T14:00:00.000Z",
  })]);

  assert.equal(report.coverage.baselineIneligibleCount, 1);
  assert.equal(report.coverage.baselineEligibleCount, 0);

  // require raw identity for all frozen strategies
  for (const score of Object.values(report.overall)) {
    assert.equal(score.eventWeightedMeanAbsoluteError, 20);
    assert.equal(score.correctionUseCount, 0);
  }
});

// verify independent raw-start fitting and cumulative final clipping
test("fits raw-start residuals separately and clips only the cumulative correction", () => {
  const report = analyze(trainingCell(), [anchorEvent({
    actual: 16,
    baselineAdjusted: 4,
    rawForecast: 0,
    validAt: "2025-01-20T14:00:00.000Z",
  })]);
  const calendarTemperature = report.models.calendarStart.temperature[0];
  const calendarWeather = report.models.calendarStart.weather[0];
  const rawTemperature = report.models.rawStart.temperature[0];
  const rawWeather = report.models.rawStart.weather[0];

  assert.equal(calendarTemperature.rawCoefficient, 12);
  assert.equal(calendarTemperature.coefficient, 4);
  assert.equal(calendarWeather.rawCoefficient, 8);
  assert.ok(Math.abs(calendarWeather.coefficient - 8 / 3) < 1e-12);
  assert.equal(rawTemperature.rawCoefficient, 16);
  assert.equal(rawTemperature.coefficient, 5);
  assert.equal(rawWeather.rawCoefficient, 11);
  assert.ok(Math.abs(rawWeather.coefficient - 11 / 3) < 1e-12);
  assert.equal(report.overall.calendarBaseline.eventWeightedMeanAbsoluteError, 12);
  assert.equal(report.overall.calendarTemperature.eventWeightedMeanAbsoluteError, 11);
  assert.equal(report.overall.calendarTemperatureWeather.eventWeightedMeanAbsoluteError, 11);
  assert.equal(report.overall.rawTemperatureWeather.eventWeightedMeanAbsoluteError, 11);
});

// verify common-mask rows never enter either fitted path
test("excludes baseline-ineligible rows from both fitted paths", () => {
  const eligible = trainingCell({ count: 49 });
  const ineligible = anchorEvent({
    actual: 70,
    baselineAdjusted: 0,
    baselineEligible: false,
    rawForecast: 0,
    validAt: "2025-01-10T19:00:00.000Z",
  });
  const report = analyze([...eligible, ineligible], [anchorEvent({
    rawForecast: 0,
    validAt: "2025-01-20T14:00:00.000Z",
  })]);

  assert.equal(report.trainingCoverage.eventCount, 50);
  assert.equal(report.trainingCoverage.baselineEligibleEventCount, 49);
  assert.equal(report.models.calendarStart.temperature.length, 0);
  assert.equal(report.models.rawStart.temperature.length, 0);
});

// verify UTC provenance and availability separation
test("rejects invalid anchor, live-reference, and leakage provenance", () => {
  assert.throws(
    () => analyzeTemperatureWeatherResearch({
      scoreCohort: "fixed_lead_anchor",
      scoreEvents: [anchorEvent({ referenceAt: "2025-02-14T16:00:00.000Z" })],
      trainingEvents: [],
    }),
    /null referenceAt/u,
  );
  assert.throws(
    () => analyze([anchorEvent({ targetLeadHours: 25, validAt: "2025-01-01T16:00:00.000Z" })], []),
    /24-hour increments/u,
  );
  assert.throws(
    () => analyzeTemperatureWeatherResearch({
      scoreCohort: "legacy_v4_retrieval_snapshot",
      scoreEvents: [anchorEvent({
        referenceAt: "2025-02-14T15:00:00.000Z",
        validAt: "2025-02-15T16:00:00.000Z",
      })],
      trainingEvents: [],
    }),
    /must match/u,
  );
  assert.throws(
    () => analyzeTemperatureWeatherResearch({
      scoreCohort: "legacy_v4_retrieval_snapshot",
      scoreEvents: [anchorEvent({
        referenceAt: "2025-01-10T18:30:00.000Z",
        validAt: "2025-01-11T18:00:00.000Z",
      })],
      trainingEvents: trainingCell(),
    }),
    /cross the earliest score information boundary/u,
  );
});

// verify result identity does not depend on caller order
test("returns deterministic models and diagnostics for reordered inputs", () => {
  const trainingEvents = trainingCell();
  const scoreEvents = [
    anchorEvent({ rawForecast: 0, validAt: "2025-01-20T14:00:00.000Z" }),
    anchorEvent({ rawForecast: 0, rawRelativeHumidityPercent: 90, validAt: "2025-01-20T15:00:00.000Z" }),
  ];
  const forward = analyze(trainingEvents, scoreEvents);
  const reversed = analyze([...trainingEvents].reverse(), [...scoreEvents].reverse());

  assert.deepEqual(reversed, forward);
});

// lock the original v1 report serialization before adding the horizon view
test("preserves the frozen weather research v1 report", () => {
  const scoreEvents = [
    anchorEvent({
      actual: 8,
      baselineAdjusted: 2,
      rawForecast: 0,
      referenceAt: "2025-02-14T16:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      baselineAdjusted: 2,
      rawForecast: 0,
      rawRelativeHumidityPercent: null,
      referenceAt: "2025-02-13T15:00:00.000Z",
      targetLeadHours: 49,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 6,
      baselineAdjusted: 2,
      rawForecast: 0,
      rawWindSpeedMps: null,
      referenceAt: "2025-02-13T17:00:00.000Z",
      targetLeadHours: 48,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
    anchorEvent({
      actual: 5,
      baselineAdjusted: 2,
      baselineEligible: false,
      rawForecast: 0,
      referenceAt: "2025-02-12T17:00:00.000Z",
      targetLeadHours: 72,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
  ];
  const report = analyzeTemperatureWeatherResearch({
    scoreCohort: "legacy_v4_retrieval_snapshot",
    scoreEvents,
    trainingEvents: trainingCell(),
  });
  const digest = createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");

  assert.equal(
    digest,
    "5a5f133fded99e31fcfdaa30d72726ce74460b45a05de7d8d28d300724e3685a",
  );
});

// preserve both existing research views while adding the isolated ablation
test("adds temperature-only results without changing existing report contracts", () => {
  const trainingEvents = trainingCell({ actual: 13, rawForecast: 10 });
  const scoreEvents = [anchorEvent({
    actual: 11,
    baselineAdjusted: 9,
    rawForecast: 10,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const legacy = analyze(trainingEvents, scoreEvents);
  const horizon = analyzeTemperatureWeatherHorizonResearch({
    scoreCohort: "fixed_lead_anchor",
    scoreEvents,
    trainingEvents,
  });
  const report = analyzeTemperatureOnly(trainingEvents, scoreEvents);
  const { temperatureOnly, ...compatibleReport } = report;

  assert.equal(report.contractVersion, "temperature-only-research/v1");
  assert.deepEqual(
    { ...compatibleReport, contractVersion: "temperature-weather-research/v1" },
    legacy,
  );
  assert.equal(Object.hasOwn(horizon, "temperatureOnly"), false);
  assert.equal(horizon.contractVersion, "temperature-weather-horizon-research/v1");
  assert.deepEqual(report.models, legacy.models);
  assert.deepEqual(report.diagnostics, legacy.diagnostics);
  assert.deepEqual(Object.keys(temperatureOnly.overall), [
    "raw",
    "rawTemperatureOnly",
    "rawTemperatureWeather",
  ]);
  assert.equal(temperatureOnly.policy.selectedAfterExaminingPriorResults, true);
  assert.equal(temperatureOnly.policy.datesConsumed, true);
  assert.equal(temperatureOnly.policy.productionActivationAllowed, false);
  assert.equal(temperatureOnly.policy.promotable, false);
  assert.equal(temperatureOnly.policy.researchOnly, true);
});

// verify the raw-start temperature stage, caps, and physical bounds directly
test("scores only the supported raw-start temperature cell before final bounds", () => {
  const trainingEvents = [
    ...trainingCell({
      actual: 70,
      baselineAdjusted: -20,
      rawForecast: 50,
      startDay: 1,
    }),
    ...trainingCell({
      actual: 70,
      baselineAdjusted: -20,
      rawForecast: 65,
      startDay: 12,
    }),
  ];
  const scoreEvents = [
    anchorEvent({
      actual: 59,
      baselineAdjusted: -80,
      rawForecast: 54,
      validAt: "2025-02-20T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 70,
      baselineAdjusted: -80,
      rawForecast: 69,
      validAt: "2025-02-20T17:00:00.000Z",
    }),
  ];
  const report = analyzeTemperatureOnly(trainingEvents, scoreEvents);
  const cappedCell = report.models.rawStart.temperature.find(
    // locate the deliberately oversized raw residual cell
    (cell) => cell.temperatureBin === 10,
  );
  const boundedBin = report.temperatureOnly.diagnostics.byTemperatureBin.find(
    // locate the physical upper-bound score event
    (item) => item.temperatureBin.index === 13,
  );

  assert.ok(cappedCell);
  assert.equal(cappedCell.rawCoefficient, 20);
  assert.equal(cappedCell.coefficient, 5);
  assert.equal(
    report.temperatureOnly.overall.rawTemperatureOnly.eventWeightedMeanAbsoluteError,
    0,
  );
  assert.ok(boundedBin);
  assert.equal(
    boundedBin.comparison.rawTemperatureOnly.eventWeightedMeanAbsoluteError,
    0,
  );
  assert.equal(report.temperatureOnly.policy.calendarComponentIncluded, false);
  assert.equal(report.temperatureOnly.policy.weatherComponentIncluded, false);
});

// verify mask, support, and predictor fallbacks without dropping rows
test("reports temperature-only fallbacks independently from weather predictors", () => {
  const trainingEvents = trainingCell({ actual: 3, baselineAdjusted: 20, rawForecast: 0 });
  const scoreEvents = [
    anchorEvent({
      actual: 1,
      baselineAdjusted: 40,
      rawForecast: 0,
      rawRelativeHumidityPercent: null,
      validAt: "2025-02-20T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 10,
      baselineAdjusted: 40,
      rawForecast: 10,
      validAt: "2025-02-20T17:00:00.000Z",
    }),
    anchorEvent({
      actual: 4,
      baselineAdjusted: 40,
      baselineEligible: false,
      rawForecast: 4,
      validAt: "2025-02-20T18:00:00.000Z",
    }),
  ];
  const report = analyzeTemperatureOnly(trainingEvents, scoreEvents);
  const coverage = report.temperatureOnly.coverage;
  const missingRegime = regime(
    { diagnostics: report.temperatureOnly.diagnostics },
    "missing",
    "[2,5)",
  );

  assert.deepEqual(coverage, {
    baselineIneligibleCount: 1,
    differsFromRawTemperatureWeatherCount: 1,
    eventCount: 3,
    nonzeroCorrectionCount: 1,
    temperatureSupportedCount: 1,
    temperatureUnsupportedCount: 1,
  });
  assert.deepEqual(
    missingRegime.comparison.rawTemperatureOnly,
    missingRegime.comparison.rawTemperatureWeather,
  );
  assert.equal(
    report.temperatureOnly.overall.rawTemperatureOnly.eventWeightedMeanAbsoluteError,
    0,
  );
  assert.equal(report.temperatureOnly.overall.rawTemperatureOnly.eventCount, 3);
});

// verify event and unique-hour denominators remain independently scored
test("scores temperature-only unequal-hour cohorts and every diagnostic partition", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = [
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      referenceAt: "2025-02-14T17:00:00.000Z",
      targetLeadHours: 23,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 3,
      rawForecast: 0,
      referenceAt: "2025-02-14T16:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      rawForecast: 0,
      referenceAt: "2025-02-14T17:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
  ];
  const report = analyzeTemperatureOnly(
    trainingEvents,
    scoreEvents,
    "legacy_v4_retrieval_snapshot",
  );
  const score = report.temperatureOnly.overall.rawTemperatureOnly;

  assert.equal(score.eventWeightedMeanAbsoluteError, 8 / 3);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 3.5);
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);

  // require every diagnostic dimension to partition the common denominator
  for (const slices of Object.values(report.temperatureOnly.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum every temperature-only diagnostic denominator
        (sum, item) => sum + item.comparison.rawTemperatureOnly.eventCount,
        0,
      ),
      report.temperatureOnly.coverage.eventCount,
    );
  }
});

// retain explicit empty support without qualification or activation claims
test("reports an empty temperature-only ablation", () => {
  const report = analyzeTemperatureOnly([], []);

  assert.equal(report.evidenceStatus, "empty_score_cohort");
  assert.equal(report.temperatureOnly.coverage.eventCount, 0);
  assert.equal(report.temperatureOnly.coverage.nonzeroCorrectionCount, 0);
  assert.equal(report.temperatureOnly.overall.rawTemperatureOnly.eventCount, 0);
  assert.equal(report.temperatureOnly.first48Hours.raw.eventCount, 0);
  assert.equal(report.temperatureOnly.after48Hours.rawTemperatureWeather.eventCount, 0);
  assert.equal(report.temperatureOnly.policy.productionActivationAllowed, false);
  assert.equal(report.productionActivationAllowed, false);

  // require all frozen diagnostic slices to retain explicit zero support
  for (const slices of Object.values(report.temperatureOnly.diagnostics)) {
    assert.ok(slices.every(
      // retain zero support in every diagnostic slice
      (item) => item.comparison.rawTemperatureOnly.eventCount === 0,
    ));
  }
});

// verify the literal gate boundary and inherited raw-start predictions
test("gates the first forty-eight hours to raw without refitting", () => {
  const trainingEvents = [
    ...trainingCell({ targetLeadHours: 48 }),
    ...trainingCell({ targetLeadHours: 72 }),
  ];
  const scoreEvents = [
    anchorEvent({
      actual: 10,
      baselineAdjusted: 2,
      rawForecast: 0,
      referenceAt: "2025-02-13T16:00:00.000Z",
      targetLeadHours: 48,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 5,
      baselineAdjusted: 2,
      rawForecast: 0,
      referenceAt: "2025-02-13T15:30:00.000Z",
      targetLeadHours: 49,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 5,
      baselineAdjusted: 2,
      rawForecast: 0,
      rawRelativeHumidityPercent: null,
      referenceAt: "2025-02-13T05:00:00.000Z",
      targetLeadHours: 60,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
    anchorEvent({
      actual: 5,
      baselineAdjusted: 2,
      rawForecast: 0,
      rawRelativeHumidityPercent: 90,
      rawWindSpeedMps: 9,
      referenceAt: "2025-02-12T19:00:00.000Z",
      targetLeadHours: 71,
      validAt: "2025-02-15T18:00:00.000Z",
    }),
    anchorEvent({
      actual: 5,
      baselineAdjusted: 2,
      baselineEligible: false,
      rawForecast: 0,
      referenceAt: "2025-02-13T16:00:00.000Z",
      targetLeadHours: 72,
      validAt: "2025-02-16T16:00:00.000Z",
    }),
  ];
  const report = analyzeHorizon(trainingEvents, scoreEvents);
  const legacy = analyzeTemperatureWeatherResearch({
    scoreCohort: "legacy_v4_retrieval_snapshot",
    scoreEvents,
    trainingEvents,
  });
  const { horizonGate, ...compatibleReport } = report;

  assert.equal(report.contractVersion, "temperature-weather-horizon-research/v1");
  assert.equal(horizonGate.contractVersion, "temperature-weather-horizon-gate/v1");
  assert.deepEqual(
    { ...compatibleReport, contractVersion: "temperature-weather-research/v1" },
    legacy,
  );
  assert.equal(horizonGate.policy.thresholdHours, 48);
  assert.equal(horizonGate.policy.first48RawByConstruction, true);
  assert.equal(horizonGate.policy.selectedAfterExaminingPriorResults, true);
  assert.equal(horizonGate.policy.promotable, false);
  assert.deepEqual(
    horizonGate.first48Hours.gatedAfter48Hours,
    horizonGate.first48Hours.raw,
  );
  assert.notDeepEqual(
    horizonGate.first48Hours.rawTemperatureWeather,
    horizonGate.first48Hours.raw,
  );
  assert.deepEqual(
    horizonGate.after48Hours.gatedAfter48Hours,
    horizonGate.after48Hours.rawTemperatureWeather,
  );
  assert.equal(horizonGate.overall.gatedAfter48Hours.eventWeightedMeanAbsoluteError, 3);
  assert.equal(
    horizonGate.overall.gatedAfter48Hours.uniqueHourBalancedMeanAbsoluteError,
    2.5,
  );
  assert.equal(horizonGate.coverage.eventCount, 5);
  assert.equal(horizonGate.coverage.rawProtectedEventCount, 1);
  assert.equal(horizonGate.coverage.after48EventCount, 4);
  assert.equal(horizonGate.coverage.after48BaselineIneligibleCount, 1);
  assert.equal(horizonGate.coverage.after48TemperatureSupportedCount, 3);
  assert.equal(horizonGate.coverage.after48TemperatureUnsupportedCount, 0);
  assert.equal(horizonGate.coverage.after48WeatherFeatureMissingCount, 1);
  assert.equal(horizonGate.coverage.after48WeatherSupportedCount, 1);
  assert.equal(horizonGate.coverage.after48WeatherUnsupportedCount, 1);
  assert.equal(horizonGate.coverage.nonzeroCorrectionCount, 3);
  assert.equal(
    horizonGate.coverage.eventCount,
    horizonGate.coverage.rawProtectedEventCount +
      horizonGate.coverage.after48EventCount,
  );
  assert.equal(
    horizonGate.coverage.after48EventCount,
    horizonGate.coverage.after48BaselineIneligibleCount +
      horizonGate.coverage.after48TemperatureSupportedCount +
      horizonGate.coverage.after48TemperatureUnsupportedCount,
  );
  assert.equal(
    horizonGate.coverage.after48EventCount,
    horizonGate.coverage.after48BaselineIneligibleCount +
      horizonGate.coverage.after48WeatherFeatureMissingCount +
      horizonGate.coverage.after48WeatherSupportedCount +
      horizonGate.coverage.after48WeatherUnsupportedCount,
  );

  // require every diagnostic dimension to partition the score denominator
  for (const slices of Object.values(horizonGate.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum the gated denominator from every diagnostic slice
        (sum, item) => sum + item.comparison.gatedAfter48Hours.eventCount,
        0,
      ),
      horizonGate.coverage.eventCount,
    );
  }

  const ineligibleDate = horizonGate.diagnostics.byLocalDate.find(
    // isolate the all-raw baseline-ineligible score date
    (item) => item.localDate === "2025-02-16",
  );

  assert.ok(ineligibleDate);
  assert.deepEqual(
    ineligibleDate.comparison.gatedAfter48Hours,
    ineligibleDate.comparison.raw,
  );
});

// verify explicit zero-support gate reports preserve every diagnostic denominator
test("reports an empty horizon gate without a promotion claim", () => {
  const report = analyzeHorizon([], []);

  assert.equal(report.evidenceStatus, "empty_score_cohort");
  assert.equal(report.horizonGate.coverage.eventCount, 0);
  assert.equal(report.horizonGate.coverage.rawProtectedEventCount, 0);
  assert.equal(report.horizonGate.coverage.after48EventCount, 0);
  assert.equal(report.horizonGate.coverage.nonzeroCorrectionCount, 0);
  assert.equal(report.horizonGate.overall.gatedAfter48Hours.eventCount, 0);
  assert.equal(report.horizonGate.first48Hours.raw.eventCount, 0);
  assert.equal(report.horizonGate.after48Hours.rawTemperatureWeather.eventCount, 0);
  assert.equal(report.horizonGate.policy.productionActivationAllowed, false);
  assert.equal(report.productionActivationAllowed, false);

  // require every empty diagnostic slice to remain explicit
  for (const slices of Object.values(report.horizonGate.diagnostics)) {
    assert.ok(slices.every(
      // retain zero support in every frozen slice
      (item) => item.comparison.gatedAfter48Hours.eventCount === 0,
    ));
  }
});

// verify empty inputs report zero support without a qualification claim
test("reports explicit empty cohort support and raw fallbacks", () => {
  const empty = analyze([], []);
  const emptyTraining = analyze([], [anchorEvent()]);
  const emptyScore = analyze(trainingCell(), []);

  assert.equal(empty.evidenceStatus, "empty_score_cohort");
  assert.equal(empty.overall.raw.eventCount, 0);
  assert.equal(empty.models.calendarStart.temperature.length, 0);
  assert.equal(empty.productionActivationAllowed, false);
  assert.equal(empty.promotable, false);
  assert.equal(empty.runtimeBundleCreated, false);
  assert.equal(emptyTraining.evidenceStatus, "empty_training_cohort");
  assert.equal(emptyTraining.coverage.calendarTemperature.temperatureUnsupportedCount, 1);
  assert.equal(emptyTraining.coverage.calendarTemperatureWeather.weatherUnsupportedCount, 1);
  assert.equal(emptyTraining.overall.raw.eventCount, 1);
  assert.equal(emptyTraining.overall.calendarTemperature.eventCount, 1);
  assert.equal(emptyScore.evidenceStatus, "empty_score_cohort");
  assert.equal(emptyScore.inputCoverage.eventCount, 0);
  assert.equal(emptyScore.trainingCoverage.eventCount, 50);
  assert.equal(emptyScore.models.calendarStart.temperature.length, 1);
});

// preserve every prior report while keeping archive controls explicitly unscored
test("adds a live-only adaptive view without changing existing research reports", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 2,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const legacy = analyze(trainingEvents, scoreEvents);
  const horizon = analyzeTemperatureWeatherHorizonResearch({
    scoreCohort: "fixed_lead_anchor",
    scoreEvents,
    trainingEvents,
  });
  const temperatureOnly = analyzeTemperatureOnly(trainingEvents, scoreEvents);
  const report = analyzeAdaptive(
    trainingEvents,
    scoreEvents,
    "fixed_lead_anchor",
  );
  const { adaptiveCorrection, ...compatibleReport } = report;

  assert.equal(report.contractVersion, "temperature-weather-adaptive-research/v1");
  assert.deepEqual(
    { ...compatibleReport, contractVersion: "temperature-weather-research/v1" },
    legacy,
  );
  assert.equal(Object.hasOwn(horizon, "adaptiveCorrection"), false);
  assert.equal(Object.hasOwn(temperatureOnly, "adaptiveCorrection"), false);
  assert.equal(adaptiveCorrection.status, "not_applicable_archive_cohort");
  assert.equal(adaptiveCorrection.reason, "archive_has_no_observed_retrieval_time");
  assert.equal(adaptiveCorrection.overall, null);
  assert.equal(adaptiveCorrection.first48Hours, null);
  assert.equal(adaptiveCorrection.after48Hours, null);
  assert.equal(adaptiveCorrection.calibratedSubset, null);
  assert.equal(adaptiveCorrection.coverage, null);
  assert.equal(adaptiveCorrection.causalAudit, null);
  assert.equal(adaptiveCorrection.diagnostics, null);
  assert.equal(adaptiveCorrection.policy.sourceStrategy, "rawTemperatureWeather");
  assert.equal(adaptiveCorrection.policy.liveOnly, true);
  assert.equal(adaptiveCorrection.policy.noArchiveWarmStart, true);
  assert.equal(adaptiveCorrection.policy.datesConsumed, true);
  assert.equal(adaptiveCorrection.policy.productionActivationAllowed, false);
  assert.equal(adaptiveCorrection.policy.promotable, false);
});

// require the shared lead calibrator to remain the exact adaptive oracle
test("matches the existing causal lead calibrator without exposing its trace", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = liveDailySequence();
  const source = analyzeTemperatureWeatherResearch({
    scoreCohort: "legacy_v4_retrieval_snapshot",
    scoreEvents,
    trainingEvents,
  });
  const report = analyzeAdaptive(trainingEvents, scoreEvents);
  const rawTemperatureCorrection =
    (source.models.rawStart.temperature[0]?.coefficient ?? 0) +
    (source.models.rawStart.weather[0]?.coefficient ?? 0);
  const oracle = analyzeTemperatureLeadResearch(scoreEvents.map(
    // pass the already-fitted full raw-start prediction to the frozen calibrator
    (event) => ({
      actual: event.actual,
      baselineAdjusted: event.rawForecast + rawTemperatureCorrection,
      rawForecast: event.rawForecast,
      referenceAt: event.referenceAt,
      targetLeadHours: event.targetLeadHours,
      validAt: event.validAt,
    }),
  ));
  const oracleAlphaCounts = [0, 0.25, 0.5, 0.75, 1].map(
    // aggregate the private oracle trace for comparison
    (alpha) => {
      const selections = oracle.causalTrace.filter(
        // isolate one frozen alpha
        (item) => item.selectedAlpha === alpha,
      );

      return {
        alpha,
        calibratedSelectionCount: selections.filter(
          // count supported selections
          (item) => item.calibrated,
        ).length,
        selectionCount: selections.length,
        uncalibratedSelectionCount: selections.filter(
          // count cold-start selections
          (item) => !item.calibrated,
        ).length,
      };
    },
  );

  assert.equal(report.adaptiveCorrection.status, "evaluated");
  assert.deepEqual(report.adaptiveCorrection.overall.causalAdaptive, oracle.overall.causalAdaptive);
  assert.deepEqual(
    report.adaptiveCorrection.calibratedSubset.causalAdaptive,
    oracle.calibratedSubset.causalAdaptive,
  );
  assert.deepEqual(
    report.adaptiveCorrection.coverage.alphaSelectionCounts,
    oracleAlphaCounts,
  );
  assert.equal(report.adaptiveCorrection.coverage.eventCount, scoreEvents.length);
  assert.equal(
    report.adaptiveCorrection.coverage.calibratedEventCount,
    oracle.causalTrace.filter((item) => item.calibrated).length,
  );
  assert.deepEqual(report.adaptiveCorrection.causalAudit, {
    selectionCount: scoreEvents.length,
    violationCount: 0,
  });
  assert.equal(JSON.stringify(report).includes("causalTrace"), false);
  assert.equal(JSON.stringify(report).includes("latestConsumedObservationAvailableAt"), false);
  assert.equal(JSON.stringify(report).includes('"actual"'), false);
});

// prove causal ordering, support floors, conservative ties, and bucket isolation
test("keeps adaptive selections causal and isolated by six-hour bucket", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = liveDailySequence();
  const isolatedValidAt = new Date(Date.UTC(2025, 1, 25, 16));
  const isolatedTargetLeadHours = 18;
  const isolated = anchorEvent({
    actual: 2,
    rawForecast: 0,
    referenceAt: new Date(
      isolatedValidAt.getTime() - isolatedTargetLeadHours * 3_600_000,
    ).toISOString(),
    targetLeadHours: isolatedTargetLeadHours,
    validAt: isolatedValidAt.toISOString(),
  });
  const report = analyzeAdaptive(trainingEvents, [...scoreEvents, isolated]);
  const isolatedBucket = report.adaptiveCorrection.diagnostics.bySixHourBucket.find(
    // locate the unsupported bucket
    (item) => item.key === "013-018",
  );
  const supportedAlpha = report.adaptiveCorrection.coverage.alphaSelectionCounts.find(
    // locate the fully selected correction
    (item) => item.alpha === 1,
  );

  assert.ok(isolatedBucket);
  assert.deepEqual(isolatedBucket.comparison.causalAdaptive, isolatedBucket.comparison.raw);
  assert.ok(supportedAlpha);
  assert.ok(supportedAlpha.calibratedSelectionCount > 0);
  assert.equal(report.adaptiveCorrection.coverage.uncalibratedEventCount, 32);
  assert.equal(
    report.adaptiveCorrection.coverage.calibratedEventCount +
      report.adaptiveCorrection.coverage.uncalibratedEventCount,
    report.adaptiveCorrection.coverage.eventCount,
  );
  assert.equal(
    report.adaptiveCorrection.coverage.alphaSelectionCounts.reduce(
      // sum every explicit alpha partition
      (sum, item) => sum + item.selectionCount,
      0,
    ),
    report.adaptiveCorrection.coverage.eventCount,
  );
  assert.ok(report.adaptiveCorrection.coverage.alphaSelectionCounts.every(
    // require each support split to reconstruct its alpha total
    (item) => item.selectionCount ===
      item.calibratedSelectionCount + item.uncalibratedSelectionCount,
  ));

  const tied = analyzeAdaptive([], liveDailySequence({ actual: 0 }));
  const zeroAlpha = tied.adaptiveCorrection.coverage.alphaSelectionCounts[0];

  assert.equal(zeroAlpha.alpha, 0);
  assert.ok(zeroAlpha.calibratedSelectionCount > 0);
  assert.equal(
    tied.adaptiveCorrection.coverage.alphaSelectionCounts
      .slice(1)
      .reduce((sum, item) => sum + item.selectionCount, 0),
    0,
  );

  const changedEvents = scoreEvents.map(
    // perturb only a forecast whose observation arrives later
    (event, index) => index === scoreEvents.length - 1
      ? { ...event, actual: 60 }
      : event,
  );
  const changed = analyzeAdaptive(trainingEvents, changedEvents);
  const earlierDate = "2025-02-20";
  const originalEarlier = report.adaptiveCorrection.diagnostics.byLocalDate.find(
    // select an already-calibrated earlier date
    (item) => item.localDate === earlierDate,
  );
  const changedEarlier = changed.adaptiveCorrection.diagnostics.byLocalDate.find(
    // select the same earlier causal result
    (item) => item.localDate === earlierDate,
  );

  assert.deepEqual(changedEarlier, originalEarlier);
});

// score unequal-hour events independently across every inherited diagnostic dimension
test("scores adaptive equal-hour arithmetic and all six diagnostics", () => {
  const scoreEvents = [
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      referenceAt: "2025-02-14T17:00:00.000Z",
      targetLeadHours: 23,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 3,
      rawForecast: 0,
      referenceAt: "2025-02-14T16:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      rawForecast: 0,
      referenceAt: "2025-02-14T17:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
  ];
  const report = analyzeAdaptive([], scoreEvents);
  const score = report.adaptiveCorrection.overall.causalAdaptive;

  assert.equal(score.eventWeightedMeanAbsoluteError, 11 / 3);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 4.5);
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);

  // require every diagnostic dimension to partition the common denominator
  for (const slices of Object.values(report.adaptiveCorrection.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum every adaptive diagnostic denominator
        (sum, item) => sum + item.comparison.causalAdaptive.eventCount,
        0,
      ),
      report.adaptiveCorrection.coverage.eventCount,
    );
  }
});

// retain explicit empty live support without invoking the nonempty calibrator
test("reports an empty live adaptive cohort without raw pseudo-results", () => {
  const report = analyzeAdaptive(trainingCell(), []);

  assert.equal(report.adaptiveCorrection.status, "empty_live_cohort");
  assert.equal(report.adaptiveCorrection.reason, null);
  assert.equal(report.adaptiveCorrection.coverage.eventCount, 0);
  assert.equal(report.adaptiveCorrection.coverage.calibratedEventCount, 0);
  assert.equal(report.adaptiveCorrection.coverage.uncalibratedEventCount, 0);
  assert.equal(report.adaptiveCorrection.coverage.nonzeroCorrectionCount, 0);
  assert.equal(report.adaptiveCorrection.overall.causalAdaptive.eventCount, 0);
  assert.equal(report.adaptiveCorrection.calibratedSubset.raw.eventCount, 0);
  assert.deepEqual(report.adaptiveCorrection.causalAudit, {
    selectionCount: 0,
    violationCount: 0,
  });
  assert.ok(report.adaptiveCorrection.coverage.alphaSelectionCounts.every(
    // retain one explicit zero for every frozen alpha
    (item) => item.selectionCount === 0,
  ));
  assert.equal(report.adaptiveCorrection.policy.productionActivationAllowed, false);
  assert.equal(report.adaptiveCorrection.policy.promotable, false);
});

// preserve every prior report while keeping archive controls explicitly unscored
test("adds a live-only hybrid view without changing existing reports", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 2,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const legacy = analyze(trainingEvents, scoreEvents);
  const horizon = analyzeTemperatureWeatherHorizonResearch({
    scoreCohort: "fixed_lead_anchor",
    scoreEvents,
    trainingEvents,
  });
  const adaptive = analyzeAdaptive(
    trainingEvents,
    scoreEvents,
    "fixed_lead_anchor",
  );
  const temperatureOnly = analyzeTemperatureOnly(trainingEvents, scoreEvents);
  const report = analyzeHybrid(
    trainingEvents,
    scoreEvents,
    "fixed_lead_anchor",
  );
  const { hybridCorrection, ...compatibleReport } = report;

  assert.equal(report.contractVersion, "temperature-weather-hybrid-research/v1");
  assert.deepEqual(
    { ...compatibleReport, contractVersion: "temperature-weather-research/v1" },
    legacy,
  );
  assert.equal(Object.hasOwn(horizon, "hybridCorrection"), false);
  assert.equal(Object.hasOwn(adaptive, "hybridCorrection"), false);
  assert.equal(Object.hasOwn(temperatureOnly, "hybridCorrection"), false);
  assert.equal(hybridCorrection.status, "not_applicable_archive_cohort");
  assert.equal(hybridCorrection.reason, "archive_has_no_observed_retrieval_time");
  assert.equal(hybridCorrection.overall, null);
  assert.equal(hybridCorrection.first48Hours, null);
  assert.equal(hybridCorrection.after48Hours, null);
  assert.equal(hybridCorrection.coverage, null);
  assert.equal(hybridCorrection.causalAudit, null);
  assert.equal(hybridCorrection.diagnostics, null);
  assert.equal(hybridCorrection.policy.thresholdHours, 48);
  assert.equal(hybridCorrection.policy.atOrBelowThresholdStrategy, "causalAdaptive");
  assert.equal(hybridCorrection.policy.aboveThresholdStrategy, "rawTemperatureWeather");
  assert.equal(hybridCorrection.policy.calibration.sourceStrategy, "rawTemperatureWeather");
  assert.equal(hybridCorrection.policy.selectedAfterExaminingPriorResults, true);
  assert.equal(hybridCorrection.policy.datesConsumed, true);
  assert.equal(hybridCorrection.policy.productionActivationAllowed, false);
  assert.equal(hybridCorrection.policy.promotable, false);
});

// verify the exact forty-eight-hour boundary and both inherited predictions
test("combines near-term causal scaling with the full longer correction", () => {
  const trainingEvents = [
    ...trainingCell({ actual: 3, rawForecast: 0, targetLeadHours: 48 }),
    ...trainingCell({ actual: 3, rawForecast: 0, targetLeadHours: 72 }),
  ];
  const nearEvents = liveDailySequence({ count: 35, targetLeadHours: 48 });
  const partialLeadValidAt = new Date(Date.UTC(2025, 1, 24, 16));
  const scoreEvents = [
    ...nearEvents,
    anchorEvent({
      actual: 2,
      baselineAdjusted: 0,
      rawForecast: 0,
      referenceAt: new Date(
        partialLeadValidAt.getTime() - 48.5 * 3_600_000,
      ).toISOString(),
      targetLeadHours: 49,
      validAt: partialLeadValidAt.toISOString(),
    }),
  ];
  const report = analyzeHybrid(trainingEvents, scoreEvents);
  const adaptive = analyzeAdaptive(trainingEvents, scoreEvents);
  const horizon = analyzeHorizon(trainingEvents, scoreEvents);
  const { hybridCorrection } = report;

  assert.equal(hybridCorrection.status, "evaluated");
  assert.equal(hybridCorrection.reason, null);
  assert.deepEqual(
    hybridCorrection.first48Hours.hybrid,
    adaptive.adaptiveCorrection.first48Hours.causalAdaptive,
  );
  assert.deepEqual(
    hybridCorrection.first48Hours.causalAdaptive,
    adaptive.adaptiveCorrection.first48Hours.causalAdaptive,
  );
  assert.deepEqual(
    hybridCorrection.after48Hours.hybrid,
    hybridCorrection.after48Hours.rawTemperatureWeather,
  );
  assert.deepEqual(
    hybridCorrection.after48Hours.hybrid,
    horizon.horizonGate.after48Hours.gatedAfter48Hours,
  );
  assert.equal(hybridCorrection.coverage.eventCount, scoreEvents.length);
  assert.equal(hybridCorrection.coverage.first48EventCount, nearEvents.length);
  assert.equal(hybridCorrection.coverage.after48EventCount, 1);
  assert.ok(hybridCorrection.coverage.first48NonzeroCorrectionCount > 0);
  assert.equal(hybridCorrection.coverage.after48NonzeroCorrectionCount, 1);
  assert.equal(
    hybridCorrection.coverage.first48CalibratedEventCount +
      hybridCorrection.coverage.first48UncalibratedEventCount,
    hybridCorrection.coverage.first48EventCount,
  );
  assert.equal(
    hybridCorrection.coverage.first48AlphaSelectionCounts.reduce(
      // sum each near-term alpha partition
      (sum, item) => sum + item.selectionCount,
      0,
    ),
    hybridCorrection.coverage.first48EventCount,
  );
  assert.equal(hybridCorrection.coverage.first48AlphaSelectionCounts.length, 5);
  assert.equal(
    hybridCorrection.coverage.nonzeroCorrectionCount,
    hybridCorrection.coverage.first48NonzeroCorrectionCount +
      hybridCorrection.coverage.after48NonzeroCorrectionCount,
  );
  assert.equal(
    hybridCorrection.coverage.differsFromGatedAfter48HoursCount,
    hybridCorrection.coverage.first48NonzeroCorrectionCount,
  );
  assert.deepEqual(hybridCorrection.causalAudit, {
    selectionCount: scoreEvents.length,
    violationCount: 0,
  });
  assert.equal(JSON.stringify(report).includes("causalTrace"), false);
  assert.equal(JSON.stringify(report).includes("latestConsumedObservationAvailableAt"), false);
  assert.equal(JSON.stringify(report).includes('"actual"'), false);
});

// score the hybrid independently across unequal hours and every diagnostic dimension
test("reports hybrid cold starts, arithmetic, and all six diagnostics", () => {
  const scoreEvents = [
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      referenceAt: "2025-02-14T17:00:00.000Z",
      targetLeadHours: 23,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 3,
      rawForecast: 0,
      referenceAt: "2025-02-14T16:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      baselineEligible: false,
      rawForecast: 0,
      referenceAt: "2025-02-14T17:00:00.000Z",
      targetLeadHours: 24,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
  ];
  const report = analyzeHybrid([], scoreEvents);
  const { hybridCorrection } = report;
  const score = hybridCorrection.overall.hybrid;

  assert.equal(score.eventWeightedMeanAbsoluteError, 11 / 3);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 4.5);
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);
  assert.equal(hybridCorrection.coverage.first48CalibratedEventCount, 0);
  assert.equal(hybridCorrection.coverage.first48UncalibratedEventCount, 3);
  assert.equal(hybridCorrection.coverage.first48NonzeroCorrectionCount, 0);
  assert.equal(hybridCorrection.coverage.after48NonzeroCorrectionCount, 0);
  assert.equal(hybridCorrection.coverage.nonzeroCorrectionCount, 0);
  assert.equal(hybridCorrection.coverage.differsFromGatedAfter48HoursCount, 0);
  assert.deepEqual(
    hybridCorrection.coverage.first48AlphaSelectionCounts.map(
      // expose every fixed alpha even without support
      (item) => item.selectionCount,
    ),
    [3, 0, 0, 0, 0],
  );

  // require every diagnostic dimension to partition the common denominator
  for (const slices of Object.values(hybridCorrection.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum every hybrid diagnostic denominator
        (sum, item) => sum + item.comparison.hybrid.eventCount,
        0,
      ),
      hybridCorrection.coverage.eventCount,
    );
  }
});

// retain explicit empty live support and causal independence from future outcomes
test("keeps hybrid selection causal and reports an empty live cohort", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = liveDailySequence({ targetLeadHours: 48 });
  const original = analyzeHybrid(trainingEvents, scoreEvents);
  const changed = analyzeHybrid(
    trainingEvents,
    scoreEvents.map(
      // perturb only the final future observation
      (event, index) => index === scoreEvents.length - 1
        ? { ...event, actual: 60 }
        : event,
    ),
  );
  const earlierDate = "2025-02-20";
  const originalEarlier = original.hybridCorrection.diagnostics.byLocalDate.find(
    // select an earlier hybrid result
    (item) => item.localDate === earlierDate,
  );
  const changedEarlier = changed.hybridCorrection.diagnostics.byLocalDate.find(
    // select the same earlier causal result
    (item) => item.localDate === earlierDate,
  );
  const empty = analyzeHybrid(trainingEvents, []);

  assert.deepEqual(changedEarlier, originalEarlier);
  assert.equal(empty.hybridCorrection.status, "empty_live_cohort");
  assert.equal(empty.hybridCorrection.reason, null);
  assert.equal(empty.hybridCorrection.coverage.eventCount, 0);
  assert.equal(empty.hybridCorrection.coverage.first48EventCount, 0);
  assert.equal(empty.hybridCorrection.coverage.after48EventCount, 0);
  assert.equal(empty.hybridCorrection.overall.hybrid.eventCount, 0);
  assert.deepEqual(empty.hybridCorrection.causalAudit, {
    selectionCount: 0,
    violationCount: 0,
  });
  assert.ok(empty.hybridCorrection.coverage.first48AlphaSelectionCounts.every(
    // retain explicit zero counts for every alpha
    (item) => item.selectionCount === 0,
  ));
});

// preserve every source report while adding one static scored view
test("adds half-weather shrinkage without changing existing reports", () => {
  const trainingEvents = trainingCell({ actual: 12, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 5,
    rawForecast: 0,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const legacy = analyze(trainingEvents, scoreEvents);
  const temperatureOnly = analyzeTemperatureOnly(trainingEvents, scoreEvents);
  const report = analyzeShrinkage(trainingEvents, scoreEvents);
  const reversed = analyzeShrinkage(
    [...trainingEvents].reverse(),
    [...scoreEvents].reverse(),
  );
  const { weatherShrinkage, ...compatibleReport } = report;

  assert.equal(report.contractVersion, "temperature-weather-shrinkage-research/v1");
  assert.deepEqual(
    { ...compatibleReport, contractVersion: "temperature-weather-research/v1" },
    legacy,
  );
  assert.deepEqual(report, reversed);
  assert.deepEqual(
    weatherShrinkage.overall.rawTemperatureOnly,
    temperatureOnly.temperatureOnly.overall.rawTemperatureOnly,
  );
  assert.deepEqual(
    weatherShrinkage.first48Hours.rawTemperatureOnly,
    temperatureOnly.temperatureOnly.first48Hours.rawTemperatureOnly,
  );
  assert.deepEqual(
    weatherShrinkage.after48Hours.rawTemperatureOnly,
    temperatureOnly.temperatureOnly.after48Hours.rawTemperatureOnly,
  );
  assert.deepEqual(Object.keys(weatherShrinkage.overall), [
    "raw",
    "rawTemperatureOnly",
    "rawTemperatureWeather",
    "rawTemperatureHalfWeather",
  ]);
  assert.deepEqual(weatherShrinkage.policy, {
    allLeadHours: true,
    calendarComponentIncluded: false,
    datesConsumed: true,
    noAdaptiveCalibration: true,
    noHorizonGate: true,
    noRefittingOrCoefficientSearch: true,
    notAnAverageOfCappedPredictions: true,
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    temperatureComponentWeight: 1,
    weatherComponentWeight: 0.5,
    weightsAppliedBeforeCumulativeClipping: true,
  });
  assert.equal(JSON.stringify(report).includes("rawTemperatureDelta"), false);
  assert.equal(JSON.stringify(report).includes("rawWeatherDelta"), false);
  assert.equal(JSON.stringify(report).includes("rawTemperatureHalfWeatherPrediction"), false);
  assert.equal(JSON.stringify(report).includes('"actual"'), false);
});

// prove component weighting precedes cumulative and physical clipping
test("halves the weather component before applying final caps", () => {
  const trainingEvents = trainingCell({ actual: 12, rawForecast: 0 });
  const report = analyzeShrinkage(trainingEvents, [anchorEvent({
    actual: 0,
    rawForecast: 0,
    validAt: "2025-02-20T16:00:00.000Z",
  })]);
  const temperatureCoefficient = report.models.rawStart.temperature[0].coefficient;
  const weatherCoefficient = report.models.rawStart.weather[0].coefficient;
  const expectedHalfPrediction = Math.min(
    5,
    Math.max(-5, temperatureCoefficient + 0.5 * weatherCoefficient),
  );
  const averageOfCappedEndpoints = (
    report.weatherShrinkage.overall.rawTemperatureOnly.eventWeightedMeanAbsoluteError +
    report.weatherShrinkage.overall.rawTemperatureWeather.eventWeightedMeanAbsoluteError
  ) / 2;

  assert.equal(temperatureCoefficient, 4);
  assert.equal(weatherCoefficient, 8 / 3);
  assert.equal(expectedHalfPrediction, 5);
  assert.equal(
    report.weatherShrinkage.overall.rawTemperatureHalfWeather.eventWeightedMeanAbsoluteError,
    expectedHalfPrediction,
  );
  assert.notEqual(expectedHalfPrediction, averageOfCappedEndpoints);
  assert.deepEqual(report.weatherShrinkage.coverage, {
    eventCount: 1,
    baselineIneligibleCount: 0,
    temperatureSupportedCount: 1,
    temperatureUnsupportedCount: 0,
    weatherSupportedCount: 1,
    weatherUnsupportedCount: 0,
    weatherFeatureMissingCount: 0,
    nonzeroCorrectionCount: 1,
    differsFromRawTemperatureOnlyCount: 1,
    differsFromRawTemperatureWeatherCount: 0,
  });

  const highTraining = trainingCell({ actual: 70, rawForecast: 65 });
  const high = analyzeShrinkage(highTraining, [anchorEvent({
    actual: 70,
    baselineAdjusted: 70,
    rawForecast: 69,
    validAt: "2025-02-20T16:00:00.000Z",
  })]);

  assert.equal(
    high.weatherShrinkage.overall.rawTemperatureHalfWeather.eventWeightedMeanAbsoluteError,
    0,
  );
  assert.equal(high.weatherShrinkage.coverage.nonzeroCorrectionCount, 1);

  const negative = analyzeShrinkage(
    trainingCell({ actual: -12, rawForecast: 0 }),
    [anchorEvent({
      actual: 0,
      rawForecast: 0,
      validAt: "2025-02-20T16:00:00.000Z",
    })],
  );
  const low = analyzeShrinkage(
    trainingCell({ actual: -100, rawForecast: -96 }),
    [anchorEvent({
      actual: -100,
      baselineAdjusted: -100,
      rawForecast: -99,
      validAt: "2025-02-20T16:00:00.000Z",
    })],
  );

  assert.equal(
    negative.weatherShrinkage.overall.rawTemperatureHalfWeather
      .eventWeightedMeanAbsoluteError,
    5,
  );
  assert.equal(
    low.weatherShrinkage.overall.rawTemperatureHalfWeather
      .eventWeightedMeanAbsoluteError,
    0,
  );
});

// retain all fallback rows while shrinking only supported weather
test("preserves shrinkage fallbacks and independent component support", () => {
  const trainingEvents = trainingCell({ actual: 12, rawForecast: 0 });
  const missing = analyzeShrinkage(trainingEvents, [anchorEvent({
    actual: 4,
    rawForecast: 0,
    rawRelativeHumidityPercent: null,
    validAt: "2025-02-20T16:00:00.000Z",
  })]);
  const unsupported = analyzeShrinkage(trainingEvents, [anchorEvent({
    actual: 4,
    rawForecast: 0,
    rawRelativeHumidityPercent: 90,
    rawWindSpeedMps: 9,
    validAt: "2025-02-20T16:00:00.000Z",
  })]);
  const ineligible = analyzeShrinkage(trainingEvents, [anchorEvent({
    actual: 0,
    baselineEligible: false,
    rawForecast: 0,
    validAt: "2025-02-20T16:00:00.000Z",
  })]);
  const unsupportedTemperature = analyzeShrinkage(trainingEvents, [anchorEvent({
    actual: 10,
    rawForecast: 10,
    validAt: "2025-02-20T16:00:00.000Z",
  })]);
  const zeroWeather = analyzeShrinkage(
    trainingCell({ actual: 0, rawForecast: 0 }),
    [anchorEvent({
      actual: 0,
      rawForecast: 0,
      validAt: "2025-02-20T16:00:00.000Z",
    })],
  );

  assert.deepEqual(
    missing.weatherShrinkage.overall.rawTemperatureHalfWeather,
    missing.weatherShrinkage.overall.rawTemperatureOnly,
  );
  assert.equal(missing.weatherShrinkage.coverage.weatherFeatureMissingCount, 1);
  assert.deepEqual(
    unsupported.weatherShrinkage.overall.rawTemperatureHalfWeather,
    unsupported.weatherShrinkage.overall.rawTemperatureOnly,
  );
  assert.equal(unsupported.weatherShrinkage.coverage.weatherUnsupportedCount, 1);
  assert.deepEqual(
    ineligible.weatherShrinkage.overall.rawTemperatureHalfWeather,
    ineligible.weatherShrinkage.overall.raw,
  );
  assert.equal(ineligible.weatherShrinkage.coverage.baselineIneligibleCount, 1);
  assert.equal(
    unsupportedTemperature.weatherShrinkage.coverage.temperatureUnsupportedCount,
    1,
  );
  assert.equal(
    unsupportedTemperature.weatherShrinkage.coverage.weatherSupportedCount,
    1,
  );
  assert.ok(
    unsupportedTemperature.weatherShrinkage.overall.rawTemperatureHalfWeather
      .eventWeightedMeanAbsoluteError > 0,
  );
  assert.deepEqual(
    zeroWeather.weatherShrinkage.overall.rawTemperatureHalfWeather,
    zeroWeather.weatherShrinkage.overall.rawTemperatureOnly,
  );
  assert.deepEqual(
    zeroWeather.weatherShrinkage.overall.rawTemperatureHalfWeather,
    zeroWeather.weatherShrinkage.overall.rawTemperatureWeather,
  );
});

// score unequal hours and every inherited diagnostic on one denominator
test("scores shrinkage arithmetic and all six diagnostics", () => {
  const trainingEvents = [
    ...trainingCell({ actual: 12, rawForecast: 0, targetLeadHours: 24 }),
    ...trainingCell({ actual: 12, rawForecast: 0, targetLeadHours: 48 }),
    ...trainingCell({ actual: 12, rawForecast: 0, targetLeadHours: 72 }),
  ];
  const scoreEvents = [
    anchorEvent({
      actual: 7,
      rawForecast: 0,
      validAt: "2025-02-20T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      rawForecast: 2,
      targetLeadHours: 48,
      validAt: "2025-02-20T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      targetLeadHours: 72,
      validAt: "2025-02-20T17:00:00.000Z",
    }),
  ];
  const report = analyzeShrinkage(trainingEvents, scoreEvents);
  const score = report.weatherShrinkage.overall.rawTemperatureHalfWeather;

  assert.equal(score.eventWeightedMeanAbsoluteError, 2);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 2.5);
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);
  assert.equal(report.weatherShrinkage.first48Hours.raw.eventCount, 2);
  assert.equal(report.weatherShrinkage.after48Hours.raw.eventCount, 1);

  // require every diagnostic dimension to partition the score denominator
  for (const slices of Object.values(report.weatherShrinkage.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum every shrinkage diagnostic denominator
        (sum, item) =>
          sum + item.comparison.rawTemperatureHalfWeather.eventCount,
        0,
      ),
      report.weatherShrinkage.coverage.eventCount,
    );
  }

  const empty = analyzeShrinkage([], []);

  assert.equal(empty.evidenceStatus, "empty_score_cohort");
  assert.equal(empty.weatherShrinkage.coverage.eventCount, 0);
  assert.equal(empty.weatherShrinkage.overall.rawTemperatureHalfWeather.eventCount, 0);
  assert.equal(empty.weatherShrinkage.first48Hours.raw.eventCount, 0);
  assert.equal(empty.weatherShrinkage.after48Hours.rawTemperatureWeather.eventCount, 0);
  assert.ok(Object.values(empty.weatherShrinkage.diagnostics).every(
    // retain explicit zero support in every frozen slice
    (slices) => slices.every(
      // retain each empty comparison
      (item) => item.comparison.rawTemperatureHalfWeather.eventCount === 0,
    ),
  ));
});

// preserve the original report when all training already fits the recent window
test("adds deterministic recent training without changing existing reports", () => {
  const trainingEvents = trainingCell({ actual: 12, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 5,
    rawForecast: 0,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const legacy = analyze(trainingEvents, scoreEvents);
  const report = analyzeRecency(trainingEvents, scoreEvents);
  const reversed = analyzeRecency(
    [...trainingEvents].reverse(),
    [...scoreEvents].reverse(),
  );
  const { recencyTraining, ...compatibleReport } = report;

  assert.equal(report.contractVersion, "temperature-weather-recency-research/v1");
  assert.deepEqual(
    { ...compatibleReport, contractVersion: "temperature-weather-research/v1" },
    legacy,
  );
  assert.deepEqual(report, reversed);
  assert.deepEqual(recencyTraining.models, legacy.models.rawStart);
  assert.equal(
    recencyTraining.modelSha256,
    canonicalSha256(recencyTraining.models),
  );
  assert.deepEqual(
    recencyTraining.overall.recentTemperatureWeather,
    legacy.overall.rawTemperatureWeather,
  );
  assert.deepEqual(
    recencyTraining.first48Hours.recentTemperatureWeather,
    legacy.first48Hours.rawTemperatureWeather,
  );
  assert.deepEqual(recencyTraining.trainingCoverage.available, legacy.trainingCoverage);
  assert.deepEqual(recencyTraining.trainingCoverage.retained, legacy.trainingCoverage);
  assert.equal(recencyTraining.trainingCoverage.excludedEventCount, 0);
  assert.deepEqual(recencyTraining.policy, {
    allLeadHours: true,
    datesConsumed: true,
    inclusiveLocalDateBounds: true,
    localCalendarArithmetic: true,
    lookbackLocalDates: 365,
    noAdaptiveCalibration: true,
    noCoefficientScaling: true,
    noHorizonGate: true,
    noLookbackSearch: true,
    noScoreOutcomeDependence: true,
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    trainingAnchor: "latest_admitted_training_local_date",
  });
  assert.equal(JSON.stringify(report).includes("trainingEvents"), false);
  assert.equal(JSON.stringify(report).includes("recentTemperatureDelta"), false);
  assert.equal(JSON.stringify(report).includes("recentWeatherDelta"), false);
  assert.equal(JSON.stringify(report).includes('"actual"'), false);
});

// prove the weather stage uses the newly fitted recent temperature model
test("matches a standalone recent fit and ignores excluded older values", () => {
  const recent = trainingCellYear(2025, { actual: 12, rawForecast: 0 });
  const olderA = trainingCellYear(2024, { actual: 30, rawForecast: 0 });
  const olderB = trainingCellYear(2024, { actual: -30, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 5,
    rawForecast: 0,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const reportA = analyzeRecency([...olderA, ...recent], scoreEvents);
  const reportB = analyzeRecency([...olderB, ...recent], scoreEvents);
  const standalone = analyze(recent, scoreEvents);

  assert.equal(reportA.recencyTraining.trainingCoverage.excludedEventCount, 50);
  assert.deepEqual(reportA.recencyTraining.models, standalone.models.rawStart);
  assert.deepEqual(reportA.recencyTraining.models, reportB.recencyTraining.models);
  assert.equal(
    reportA.recencyTraining.modelSha256,
    reportB.recencyTraining.modelSha256,
  );
  assert.deepEqual(
    reportA.recencyTraining.overall.recentTemperatureWeather,
    standalone.overall.rawTemperatureWeather,
  );
  assert.deepEqual(
    reportA.recencyTraining.diagnostics.byWeatherRegime,
    standalone.diagnostics.byWeatherRegime.map(
      // project the standalone raw-start score into the recency comparison
      (item) => ({
        comparison: {
          raw: item.comparison.raw,
          rawTemperatureWeather:
            regime(reportA, item.humidityBin, item.windSpeedBin)
              .comparison.rawTemperatureWeather,
          recentTemperatureWeather: item.comparison.rawTemperatureWeather,
        },
        humidityBin: item.humidityBin,
        windSpeedBin: item.windSpeedBin,
      }),
    ),
  );
});

// retain the exact inclusive calendar boundary and anchor ineligible rows
test("uses an inclusive leap-aware local-date recency window", () => {
  const trainingEvents = [
    anchorEvent({
      actual: 1,
      validAt: "2024-03-11T06:00:00.000Z",
    }),
    anchorEvent({
      actual: 1,
      validAt: "2024-03-11T07:00:00.000Z",
    }),
    anchorEvent({
      actual: 1,
      baselineEligible: false,
      validAt: "2025-03-10T07:00:00.000Z",
    }),
  ];
  const scoreEvents = [anchorEvent({
    validAt: "2025-04-20T16:00:00.000Z",
  })];
  const report = analyzeRecency(trainingEvents, scoreEvents);

  assert.deepEqual(report.recencyTraining.trainingWindow, {
    lookbackLocalDates: 365,
    fromLocalDate: "2024-03-11",
    throughLocalDate: "2025-03-10",
    firstRetainedValidAt: "2024-03-11T07:00:00.000Z",
    lastRetainedValidAt: "2025-03-10T07:00:00.000Z",
  });
  assert.equal(report.recencyTraining.trainingCoverage.available.eventCount, 3);
  assert.equal(report.recencyTraining.trainingCoverage.retained.eventCount, 2);
  assert.equal(report.recencyTraining.trainingCoverage.excludedEventCount, 1);
  assert.equal(
    report.recencyTraining.trainingCoverage.retained.baselineEligibleEventCount,
    1,
  );

  const leapYear = analyzeRecency([
    anchorEvent({ actual: 1, validAt: "2024-01-01T16:00:00.000Z" }),
    anchorEvent({ actual: 1, validAt: "2024-01-02T16:00:00.000Z" }),
    anchorEvent({
      actual: 1,
      baselineEligible: false,
      validAt: "2024-12-31T16:00:00.000Z",
    }),
  ], [anchorEvent({ validAt: "2025-02-20T16:00:00.000Z" })]);

  assert.deepEqual(leapYear.recencyTraining.trainingWindow, {
    lookbackLocalDates: 365,
    fromLocalDate: "2024-01-02",
    throughLocalDate: "2024-12-31",
    firstRetainedValidAt: "2024-01-02T16:00:00.000Z",
    lastRetainedValidAt: "2024-12-31T16:00:00.000Z",
  });
  assert.equal(leapYear.recencyTraining.trainingCoverage.retained.eventCount, 2);
  assert.equal(leapYear.recencyTraining.trainingCoverage.excludedEventCount, 1);

  assert.throws(
    () => analyzeRecency(
      [anchorEvent({ validAt: "2025-05-01T16:00:00.000Z" })],
      scoreEvents,
    ),
    /cross the earliest score information boundary/u,
  );
});

// report lost support and complete raw candidate fallbacks
test("reports recency support loss without dropping score events", () => {
  const olderSupport = trainingCellYear(2024, {
    actual: 12,
    rawForecast: 0,
  });
  const anchor = anchorEvent({
    actual: 0,
    baselineEligible: false,
    validAt: "2025-01-20T16:00:00.000Z",
  });
  const scoreEvents = [anchorEvent({
    actual: 5,
    rawForecast: 0,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  const report = analyzeRecency([...olderSupport, anchor], scoreEvents);

  assert.equal(report.models.rawStart.temperature.length, 1);
  assert.equal(report.models.rawStart.weather.length, 1);
  assert.deepEqual(report.recencyTraining.models, {
    temperature: [],
    weather: [],
  });
  assert.deepEqual(report.recencyTraining.coverage, {
    eventCount: 1,
    baselineIneligibleCount: 0,
    temperatureSupportedCount: 0,
    temperatureUnsupportedCount: 1,
    weatherSupportedCount: 0,
    weatherUnsupportedCount: 1,
    weatherFeatureMissingCount: 0,
    temperatureSupportLostCount: 1,
    weatherSupportLostCount: 1,
    nonzeroCorrectionCount: 0,
    differsFromRawTemperatureWeatherCount: 1,
  });
  assert.deepEqual(
    report.recencyTraining.overall.recentTemperatureWeather,
    report.recencyTraining.overall.raw,
  );
});

// score unequal hours and empty training on the unchanged denominator
test("scores recency arithmetic, diagnostics, and empty training", () => {
  const trainingEvents = [
    ...trainingCell({ actual: 12, rawForecast: 0, targetLeadHours: 24 }),
    ...trainingCell({ actual: 12, rawForecast: 0, targetLeadHours: 48 }),
    ...trainingCell({ actual: 12, rawForecast: 0, targetLeadHours: 72 }),
  ];
  const scoreEvents = [
    anchorEvent({
      actual: 7,
      rawForecast: 0,
      validAt: "2025-02-20T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      rawForecast: 2,
      targetLeadHours: 48,
      validAt: "2025-02-20T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      targetLeadHours: 72,
      validAt: "2025-02-20T17:00:00.000Z",
    }),
  ];
  const report = analyzeRecency(trainingEvents, scoreEvents);
  const score = report.recencyTraining.overall.recentTemperatureWeather;

  assert.equal(score.eventWeightedMeanAbsoluteError, 2);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 2.5);
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);
  assert.equal(report.recencyTraining.first48Hours.raw.eventCount, 2);
  assert.equal(report.recencyTraining.after48Hours.raw.eventCount, 1);

  // require every diagnostic dimension to partition the score denominator
  for (const slices of Object.values(report.recencyTraining.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum every recency diagnostic denominator
        (sum, item) =>
          sum + item.comparison.recentTemperatureWeather.eventCount,
        0,
      ),
      report.recencyTraining.coverage.eventCount,
    );
  }

  const empty = analyzeRecency([], scoreEvents);

  assert.deepEqual(empty.recencyTraining.trainingWindow, {
    lookbackLocalDates: 365,
    fromLocalDate: null,
    throughLocalDate: null,
    firstRetainedValidAt: null,
    lastRetainedValidAt: null,
  });
  assert.deepEqual(empty.recencyTraining.models, {
    temperature: [],
    weather: [],
  });
  assert.equal(
    empty.recencyTraining.modelSha256,
    canonicalSha256({ temperature: [], weather: [] }),
  );
  assert.deepEqual(empty.recencyTraining.trainingCoverage, {
    available: {
      baselineEligibleEventCount: 0,
      eventCount: 0,
      localDateCount: 0,
      uniqueValidHours: 0,
    },
    retained: {
      baselineEligibleEventCount: 0,
      eventCount: 0,
      localDateCount: 0,
      uniqueValidHours: 0,
    },
    excludedEventCount: 0,
  });
  assert.deepEqual(
    empty.recencyTraining.overall.recentTemperatureWeather,
    empty.recencyTraining.overall.raw,
  );
  assert.equal(empty.recencyTraining.coverage.eventCount, scoreEvents.length);

  const emptyScore = analyzeRecency(trainingEvents, []);

  assert.equal(emptyScore.evidenceStatus, "empty_score_cohort");
  assert.equal(emptyScore.recencyTraining.overall.raw.eventCount, 0);
  assert.equal(emptyScore.recencyTraining.coverage.eventCount, 0);
});

// bind the injected request to the frozen encoding and original report
test("encodes boosted requests without changing inherited evidence", () => {
  const trainingEvents = [
    anchorEvent({
      actual: 16,
      rawForecast: 10,
      targetLeadHours: 24,
      validAt: "2025-01-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 7,
      rawForecast: 4,
      rawRelativeHumidityPercent: null,
      rawWindSpeedMps: null,
      targetLeadHours: 48,
      validAt: "2025-01-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 9,
      baselineEligible: false,
      targetLeadHours: 72,
      validAt: "2025-01-15T17:00:00.000Z",
    }),
  ];
  const scoreEvents = [anchorEvent({
    actual: 63.123,
    baselineAdjusted: 57.321,
    rawForecast: 7,
    rawRelativeHumidityPercent: null,
    rawWindSpeedMps: null,
    validAt: "2025-03-10T10:00:00.000Z",
  })];
  let capturedRequest;
  const modelJson = "{\"learner\":{\"kind\":\"stand_in\"}}";
  const configJson = "{\"booster\":\"stand_in\"}";
  const trainer = (request) => {
    capturedRequest = structuredClone(request);
    assert.equal(Object.isFrozen(request), true);
    assert.equal(Object.isFrozen(request.featureNames), true);
    assert.equal(Object.isFrozen(request.trainingIds), true);
    assert.equal(Object.isFrozen(request.trainingFeatures), true);
    assert.equal(request.trainingFeatures.every(Object.isFrozen), true);
    assert.equal(Object.isFrozen(request.trainingResiduals), true);
    assert.equal(Object.isFrozen(request.trainingWeights), true);
    assert.equal(Object.isFrozen(request.predictionIds), true);
    assert.equal(Object.isFrozen(request.predictionFeatures), true);
    assert.equal(request.predictionFeatures.every(Object.isFrozen), true);
    assert.throws(
      // reject trainer-side row identity mutation
      () => {
        request.trainingIds[0] = "mutated-training-id";
      },
      TypeError,
    );
    assert.throws(
      // reject trainer-side feature mutation
      () => {
        request.predictionFeatures[0][0] = 999;
      },
      TypeError,
    );
    return {
      configJson,
      modelJson,
      predictionIds: [...capturedRequest.predictionIds],
      predictedResiduals: [0],
    };
  };
  const report = analyzeBoosted(trainingEvents, scoreEvents, trainer);
  const original = analyze(trainingEvents, scoreEvents);
  const { boostedResidual, ...inherited } = report;

  assert.deepEqual(
    { ...inherited, contractVersion: original.contractVersion },
    original,
  );
  assert.deepEqual(capturedRequest.featureNames, TEMPERATURE_BOOSTED_FEATURE_NAMES);
  assert.deepEqual(Object.keys(capturedRequest).sort(), [
    "featureNames",
    "predictionFeatures",
    "predictionIds",
    "trainingFeatures",
    "trainingIds",
    "trainingResiduals",
    "trainingWeights",
  ]);
  assert.deepEqual(capturedRequest.trainingFeatures, [
    [10, 60, 3, 24, 1, 0, 0, 0, 0, 1, 0, 0],
    [4, null, null, 48, 1, 0, 0, 0, 0, 1, 0, 0],
  ]);
  assert.deepEqual(capturedRequest.trainingResiduals, [6, 3]);
  assert.deepEqual(capturedRequest.trainingWeights, [0.5, 0.5]);
  assert.deepEqual(capturedRequest.predictionFeatures, [
    [7, null, null, 24, 0, 1, 0, 0, 1, 0, 0, 0],
  ]);
  assert.equal(JSON.stringify(capturedRequest).includes("63.123"), false);
  assert.equal(JSON.stringify(capturedRequest).includes("57.321"), false);
  assert.deepEqual(boostedResidual.trainingEvidence, {
    available: {
      baselineEligibleEventCount: 2,
      eventCount: 3,
      localDateCount: 1,
      uniqueValidHours: 2,
    },
    eligible: {
      baselineEligibleEventCount: 2,
      eventCount: 2,
      localDateCount: 1,
      uniqueValidHours: 1,
    },
    eligibleEventCount: 2,
    weightSum: 1,
    perExactLead: [
      { eventCount: 1, targetLeadHours: 24 },
      { eventCount: 1, targetLeadHours: 48 },
    ],
    supportedExactLeads: [24, 48],
    minimumTargetLeadHours: 24,
    maximumTargetLeadHours: 48,
  });
  assert.equal(
    boostedResidual.model.requestSha256,
    canonicalSha256(capturedRequest),
  );
  assert.equal(
    boostedResidual.model.modelSha256,
    createHash("sha256").update(modelJson).digest("hex"),
  );
  assert.equal(
    boostedResidual.model.configSha256,
    createHash("sha256").update(configJson).digest("hex"),
  );
  assert.equal(boostedResidual.coverage.missingFeatureCount, 1);
  assert.deepEqual(boostedResidual.policy, {
    allLeadHours: true,
    calendarPredictors: "existing_local_season_and_daypart_one_hot",
    continuousPredictors: "raw_temperature_humidity_wind_and_lead",
    datesConsumed: true,
    existingPredictorsOnly: true,
    missingValuesUseNativeRouting: true,
    noAdaptiveCalibration: true,
    noCoefficientScaling: true,
    noFeatureSearch: true,
    noFeatureSourceExpansion: true,
    noHorizonGate: true,
    noHyperparameterSearch: true,
    noLookbackSearch: true,
    noRecencyFilter: true,
    noScoreOutcomeDependence: true,
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    target: "actual_minus_raw_temperature",
    trainingRowWeighting: "equal_total_weight_per_valid_hour",
  });
});

// apply cumulative and physical caps while preserving ineligible raw rows
test("caps boosted residuals and reports explicit raw fallbacks", () => {
  const trainingEvents = [anchorEvent({
    actual: 12,
    rawForecast: 10,
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  const scoreEvents = [
    anchorEvent({
      actual: 15,
      rawForecast: 10,
      rawRelativeHumidityPercent: null,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      actual: -100,
      rawForecast: -99,
      targetLeadHours: 48,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 5,
      baselineEligible: false,
      rawForecast: 5,
      targetLeadHours: 72,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
  ];
  const report = analyzeBoosted(
    trainingEvents,
    scoreEvents,
    boostedTrainer((_features, index) => [10, -200, 20][index]),
  ).boostedResidual;

  assert.equal(report.overall.boostedTemperature.eventWeightedMeanAbsoluteError, 0);
  assert.equal(report.overall.boostedTemperature.correctionUseCount, 2);
  assert.deepEqual(report.coverage, {
    eventCount: 3,
    baselineIneligibleCount: 1,
    missingFeatureCount: 1,
    modelPredictionCount: 2,
    modelFallbackCount: 1,
    nonzeroCorrectionCount: 2,
    differsFromRawTemperatureWeatherCount: 2,
    seenExactTrainingLeadCount: 1,
    unseenExactTrainingLeadCount: 2,
    belowTrainingLeadRangeCount: 0,
  });
});

// avoid invoking native training when no eligible rows exist
test("uses complete raw fallback for empty eligible boosted training", () => {
  const scoreEvents = [
    anchorEvent({ actual: 12, rawForecast: 10 }),
    anchorEvent({
      actual: 3,
      rawForecast: 1,
      targetLeadHours: 48,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
  ];
  let callCount = 0;
  const trainer = () => {
    callCount += 1;
    throw new Error("trainer must not run");
  };
  const report = analyzeBoosted([], scoreEvents, trainer).boostedResidual;

  assert.equal(callCount, 0);
  assert.equal(report.model.modelJson, null);
  assert.equal(report.model.modelSha256, null);
  assert.equal(report.model.configJson, null);
  assert.equal(report.model.configSha256, null);
  assert.match(report.model.requestSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.overall.boostedTemperature, report.overall.raw);
  assert.equal(report.coverage.modelPredictionCount, 0);
  assert.equal(report.coverage.modelFallbackCount, 2);
  assert.equal(report.leadScopes.unseenExactTrainingLead.raw.eventCount, 2);
  assert.equal(report.leadScopes.belowTrainingLeadRange.raw.eventCount, 0);
});

// reject malformed native artifacts, predictions, and echoed identities
test("rejects malformed boosted trainer responses", () => {
  const trainingEvents = [anchorEvent({
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  const scoreEvents = [
    anchorEvent({ validAt: "2025-03-10T16:00:00.000Z" }),
    anchorEvent({
      targetLeadHours: 48,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
  ];
  const valid = {
    configJson: "{\"eta\":0.1}",
    modelJson: "{\"learner\":{}}",
    predictionIds: scoreEvents.map(
      // mirror the canonical fixed-anchor identities
      (event) => `${event.validAt}|${event.targetLeadHours}`,
    ),
    predictedResiduals: [0, 0],
  };
  const cases = [
    [{ ...valid, extra: true }, /fields must match/u],
    [{ ...valid, predictionIds: [...valid.predictionIds].reverse() }, /request order/u],
    [{ ...valid, predictedResiduals: [0] }, /finite and complete/u],
    [{ ...valid, predictedResiduals: [0, Number.NaN] }, /finite and complete/u],
    [{ ...valid, modelJson: "[]" }, /JSON object/u],
    [{ ...valid, modelJson: "{broken" }, /valid JSON/u],
    [{ ...valid, modelJson: "{\"weight\":1e309}" }, /finite numbers/u],
    [{ ...valid, configJson: "{broken" }, /valid JSON/u],
    [null, /must be an object/u],
  ];

  // reject every invalid external result independently
  for (const [result, expected] of cases) {
    assert.throws(
      // return one deliberately malformed trainer result
      () => analyzeBoosted(trainingEvents, scoreEvents, () => result),
      expected,
    );
  }
});

// validate temporal and identity inputs before invoking native training
test("rejects contaminated or duplicate boosted training before callbacks", () => {
  const scoreEvents = [anchorEvent({
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  let callCount = 0;
  const trainer = () => {
    callCount += 1;
    return {
      configJson: "{}",
      modelJson: "{}",
      predictionIds: [],
      predictedResiduals: [],
    };
  };
  const future = anchorEvent({ validAt: "2025-02-20T16:00:00.000Z" });
  const duplicate = anchorEvent({ validAt: "2025-01-15T16:00:00.000Z" });

  assert.throws(
    () => analyzeBoosted([future], scoreEvents, trainer),
    /cross the earliest score information boundary/u,
  );
  assert.throws(
    () => analyzeBoosted([duplicate, duplicate], scoreEvents, trainer),
    /unique validAt and targetLeadHours identities/u,
  );
  assert.equal(callCount, 0);
});

// keep model requests independent from score outcomes and arrival order
test("binds boosted row partitions without exposing score labels", () => {
  const trainingEvents = [
    anchorEvent({
      actual: 4,
      rawForecast: 0,
      targetLeadHours: 24,
      validAt: "2025-01-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 8,
      rawForecast: 2,
      targetLeadHours: 48,
      validAt: "2025-01-15T16:00:00.000Z",
    }),
  ];
  const scoreEvents = [
    anchorEvent({
      actual: 10,
      rawForecast: 0,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 6,
      rawForecast: 1,
      targetLeadHours: 48,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
  ];
  const captured = [];
  const trainer = (request) => {
    captured.push(structuredClone(request));
    return boostedTrainer(() => 1)(request);
  };
  const original = analyzeBoosted(trainingEvents, scoreEvents, trainer);
  const changedLabels = analyzeBoosted(
    [...trainingEvents].reverse(),
    [...scoreEvents].reverse().map(
      // change score outcomes without changing predictor rows
      (event) => ({ ...event, actual: event.actual + 3 }),
    ),
    trainer,
  );

  assert.deepEqual(captured[0], captured[1]);
  assert.equal(
    original.boostedResidual.model.requestSha256,
    changedLabels.boostedResidual.model.requestSha256,
  );
  assert.equal(
    original.boostedResidual.model.trainingIdentitySha256,
    changedLabels.boostedResidual.model.trainingIdentitySha256,
  );
  assert.equal(
    original.boostedResidual.model.scoreIdentitySha256,
    changedLabels.boostedResidual.model.scoreIdentitySha256,
  );
  assert.notEqual(
    original.boostedResidual.overall.boostedTemperature.eventWeightedMeanAbsoluteError,
    changedLabels.boostedResidual.overall.boostedTemperature.eventWeightedMeanAbsoluteError,
  );

  const changedScorePartition = analyzeBoosted(
    trainingEvents,
    scoreEvents.map(
      // change only one score eligibility partition
      (event, index) => index === 0
        ? { ...event, baselineEligible: false }
        : event,
    ),
    trainer,
  );
  assert.equal(
    original.boostedResidual.model.requestSha256,
    changedScorePartition.boostedResidual.model.requestSha256,
  );
  assert.notEqual(
    original.boostedResidual.model.scoreIdentitySha256,
    changedScorePartition.boostedResidual.model.scoreIdentitySha256,
  );

  const changedTrainingPartition = analyzeBoosted(
    trainingEvents.map(
      // exclude one training row from the native fit
      (event, index) => index === 0
        ? { ...event, baselineEligible: false }
        : event,
    ),
    scoreEvents,
    trainer,
  );
  assert.notEqual(
    original.boostedResidual.model.requestSha256,
    changedTrainingPartition.boostedResidual.model.requestSha256,
  );
  assert.notEqual(
    original.boostedResidual.model.trainingIdentitySha256,
    changedTrainingPartition.boostedResidual.model.trainingIdentitySha256,
  );
});

// report seen and unseen leads without suppressing extrapolated predictions
test("scores boosted exact-lead scopes without gating", () => {
  const trainingEvents = [
    anchorEvent({
      targetLeadHours: 48,
      validAt: "2025-01-15T16:00:00.000Z",
    }),
    anchorEvent({
      targetLeadHours: 72,
      validAt: "2025-01-15T16:00:00.000Z",
    }),
  ];
  const scoreEvents = [
    anchorEvent({
      rawForecast: 0,
      targetLeadHours: 24,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      rawForecast: 0,
      targetLeadHours: 48,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      rawForecast: 0,
      targetLeadHours: 96,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
  ];
  const report = analyzeBoosted(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 1),
  ).boostedResidual;

  assert.equal(report.coverage.modelPredictionCount, 3);
  assert.equal(report.coverage.modelFallbackCount, 0);
  assert.equal(report.coverage.seenExactTrainingLeadCount, 1);
  assert.equal(report.coverage.unseenExactTrainingLeadCount, 2);
  assert.equal(report.coverage.belowTrainingLeadRangeCount, 1);
  assert.equal(report.leadScopes.seenExactTrainingLead.raw.eventCount, 1);
  assert.equal(report.leadScopes.unseenExactTrainingLead.raw.eventCount, 2);
  assert.equal(report.leadScopes.belowTrainingLeadRange.raw.eventCount, 1);
  assert.equal(
    report.leadScopes.unseenExactTrainingLead.boostedTemperature.correctionUseCount,
    2,
  );
});

// score unequal valid-hour populations and every diagnostic dimension
test("scores boosted event and balanced arithmetic across diagnostics", () => {
  const trainingEvents = [anchorEvent({
    actual: 0,
    rawForecast: 0,
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  const scoreEvents = [
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      targetLeadHours: 24,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 3,
      rawForecast: 0,
      targetLeadHours: 48,
      validAt: "2025-03-10T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 9,
      rawForecast: 0,
      targetLeadHours: 72,
      validAt: "2025-03-10T17:00:00.000Z",
    }),
  ];
  const report = analyzeBoosted(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 0),
  ).boostedResidual;
  const score = report.overall.boostedTemperature;

  assert.equal(score.eventWeightedMeanAbsoluteError, 13 / 3);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 5.5);
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);
  assert.equal(report.first48Hours.boostedTemperature.eventCount, 2);
  assert.equal(report.after48Hours.boostedTemperature.eventCount, 1);

  // require every diagnostic dimension to partition the score denominator
  for (const slices of Object.values(report.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum every boosted diagnostic denominator
        (sum, item) => sum + item.comparison.boostedTemperature.eventCount,
        0,
      ),
      report.coverage.eventCount,
    );
  }
});

// preserve the boosted report while declining archive hybrid scores
test("adds a live-only boosted hybrid without changing boosted evidence", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 2,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  let callbackCount = 0;
  const report = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    (request) => {
      callbackCount += 1;
      return boostedTrainer(() => 0)(request);
    },
    "fixed_lead_anchor",
  );
  const original = analyzeBoosted(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 0),
  );
  const { boostedHybrid, ...compatibleReport } = report;

  assert.equal(callbackCount, 1);
  assert.equal(report.contractVersion, "temperature-boosted-hybrid-research/v1");
  assert.deepEqual(
    {
      ...compatibleReport,
      contractVersion: "temperature-boosted-residual-research/v1",
    },
    original,
  );
  assert.equal(boostedHybrid.status, "not_applicable_archive_cohort");
  assert.equal(boostedHybrid.reason, "archive_has_no_observed_retrieval_time");
  assert.equal(boostedHybrid.overall, null);
  assert.equal(boostedHybrid.first48Hours, null);
  assert.equal(boostedHybrid.after48Hours, null);
  assert.equal(boostedHybrid.coverage, null);
  assert.equal(boostedHybrid.causalAudit, null);
  assert.equal(boostedHybrid.diagnostics, null);
  assert.deepEqual(boostedHybrid.policy, {
    aboveThresholdStrategy: "boostedTemperature",
    atOrBelowThresholdStrategy: "causalAdaptive",
    calibration: analyzeHybrid(
      trainingEvents,
      scoreEvents,
      "fixed_lead_anchor",
    ).hybridCorrection.policy.calibration,
    datesConsumed: true,
    fixedSourceModels: true,
    noAdditionalPredictionCapping: true,
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    selectedAfterExaminingPriorResults: true,
    thresholdHours: 48,
  });
});

// switch exactly after forty-eight hours without changing either source
test("combines causal near predictions with frozen boosted far predictions", () => {
  const trainingEvents = [
    ...trainingCell({ actual: 3, rawForecast: 0, targetLeadHours: 48 }),
    ...trainingCell({ actual: 3, rawForecast: 0, targetLeadHours: 72 }),
  ];
  const nearEvents = liveDailySequence({ count: 35, targetLeadHours: 48 });
  const farValidAt = new Date(Date.UTC(2025, 1, 24, 16));
  const scoreEvents = [
    ...nearEvents,
    anchorEvent({
      actual: 2,
      baselineAdjusted: 0,
      rawForecast: 0,
      referenceAt: new Date(
        farValidAt.getTime() - 49 * 3_600_000,
      ).toISOString(),
      targetLeadHours: 49,
      validAt: farValidAt.toISOString(),
    }),
  ];
  let callbackCount = 0;
  const trainer = (request) => {
    callbackCount += 1;
    return boostedTrainer(() => 1)(request);
  };
  const report = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    trainer,
  );
  const boosted = analyzeBoosted(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 1),
    "legacy_v4_retrieval_snapshot",
  );
  const adaptive = analyzeAdaptive(trainingEvents, scoreEvents);
  const priorHybrid = analyzeHybrid(trainingEvents, scoreEvents);
  const candidate = report.boostedHybrid;

  assert.equal(callbackCount, 1);
  assert.equal(candidate.status, "evaluated");
  assert.deepEqual(
    candidate.first48Hours.boostedHybrid,
    adaptive.adaptiveCorrection.first48Hours.causalAdaptive,
  );
  assert.deepEqual(
    candidate.first48Hours.boostedHybrid,
    priorHybrid.hybridCorrection.first48Hours.hybrid,
  );
  assert.deepEqual(
    candidate.after48Hours.boostedHybrid,
    boosted.boostedResidual.after48Hours.boostedTemperature,
  );
  assert.deepEqual(
    candidate.after48Hours.hybrid,
    priorHybrid.hybridCorrection.after48Hours.hybrid,
  );
  assert.deepEqual(report.boostedResidual, boosted.boostedResidual);
  assert.equal(candidate.coverage.first48EventCount, nearEvents.length);
  assert.equal(candidate.coverage.after48EventCount, 1);
  assert.equal(candidate.coverage.modelPredictionCount, 1);
  assert.equal(candidate.coverage.modelFallbackCount, 0);
  assert.equal(candidate.coverage.differsFromPriorHybridCount, 1);
  assert.equal(
    candidate.coverage.nonzeroCorrectionCount,
    candidate.coverage.first48NonzeroCorrectionCount +
      candidate.coverage.after48NonzeroCorrectionCount,
  );
  assert.deepEqual(candidate.causalAudit, {
    selectionCount: scoreEvents.length,
    violationCount: 0,
  });
});

// score mixed lead populations from rows rather than scope averages
test("scores boosted hybrid event and equal-hour arithmetic directly", () => {
  const trainingEvents = [anchorEvent({
    actual: 0,
    rawForecast: 0,
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  const sharedValidAt = new Date("2025-03-10T16:00:00.000Z");
  const farValidAt = new Date("2025-03-10T17:00:00.000Z");
  const scoreEvents = [
    anchorEvent({
      actual: 1,
      rawForecast: 0,
      referenceAt: new Date(
        sharedValidAt.getTime() - 47 * 3_600_000,
      ).toISOString(),
      targetLeadHours: 47,
      validAt: sharedValidAt.toISOString(),
    }),
    anchorEvent({
      actual: 3,
      rawForecast: 0,
      referenceAt: new Date(
        sharedValidAt.getTime() - 48 * 3_600_000,
      ).toISOString(),
      targetLeadHours: 48,
      validAt: sharedValidAt.toISOString(),
    }),
    anchorEvent({
      actual: 9,
      rawForecast: 0,
      referenceAt: new Date(
        farValidAt.getTime() - 49 * 3_600_000,
      ).toISOString(),
      targetLeadHours: 49,
      validAt: farValidAt.toISOString(),
    }),
  ];
  const candidate = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 1),
  ).boostedHybrid;
  const score = candidate.overall.boostedHybrid;

  assert.equal(candidate.first48Hours.boostedHybrid.eventWeightedMeanAbsoluteError, 2);
  assert.equal(candidate.after48Hours.boostedHybrid.eventWeightedMeanAbsoluteError, 8);
  assert.equal(score.eventWeightedMeanAbsoluteError, 4);
  assert.equal(score.uniqueHourBalancedMeanAbsoluteError, 5);
  assert.notEqual(
    score.eventWeightedMeanAbsoluteError,
    (
      candidate.first48Hours.boostedHybrid.eventWeightedMeanAbsoluteError +
      candidate.after48Hours.boostedHybrid.eventWeightedMeanAbsoluteError
    ) / 2,
  );
  assert.equal(score.eventCount, 3);
  assert.equal(score.uniqueValidHours, 2);

  // require every diagnostic dimension to partition the full denominator
  for (const slices of Object.values(candidate.diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum each exact candidate diagnostic denominator
        (sum, item) => sum + item.comparison.boostedHybrid.eventCount,
        0,
      ),
      scoreEvents.length,
    );
  }
});

// retain full denominators across native missing and fallback cases
test("reports boosted hybrid missing, ineligible, and empty fallbacks", () => {
  const trainingEvents = [anchorEvent({
    actual: 2,
    rawForecast: 0,
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  const scoreEvents = [
    anchorEvent({
      actual: 2,
      rawForecast: 0,
      rawRelativeHumidityPercent: null,
      rawWindSpeedMps: null,
      referenceAt: "2025-02-13T15:00:00.000Z",
      targetLeadHours: 49,
      validAt: "2025-02-15T16:00:00.000Z",
    }),
    anchorEvent({
      actual: 3,
      baselineEligible: false,
      rawForecast: 0,
      referenceAt: "2025-02-12T17:00:00.000Z",
      targetLeadHours: 72,
      validAt: "2025-02-15T17:00:00.000Z",
    }),
  ];
  const candidate = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 2),
  ).boostedHybrid;

  assert.equal(candidate.coverage.eventCount, 2);
  assert.equal(candidate.coverage.modelPredictionCount, 1);
  assert.equal(candidate.coverage.modelFallbackCount, 1);
  assert.equal(candidate.coverage.missingFeatureCount, 1);
  assert.equal(candidate.coverage.after48NonzeroCorrectionCount, 1);
  assert.deepEqual(
    candidate.after48Hours.boostedHybrid,
    candidate.after48Hours.boostedTemperature,
  );

  let callbackCount = 0;
  const emptyTraining = analyzeBoostedHybrid(
    [],
    scoreEvents,
    () => {
      callbackCount += 1;
      throw new Error("trainer must not run");
    },
  ).boostedHybrid;

  assert.equal(callbackCount, 0);
  assert.deepEqual(
    emptyTraining.after48Hours.boostedHybrid,
    emptyTraining.after48Hours.raw,
  );
  assert.equal(emptyTraining.coverage.modelPredictionCount, 0);
  assert.equal(emptyTraining.coverage.modelFallbackCount, 2);

  const emptyScore = analyzeBoostedHybrid(
    trainingEvents,
    [],
    boostedTrainer(() => 0),
  ).boostedHybrid;

  assert.equal(emptyScore.status, "empty_live_cohort");
  assert.equal(emptyScore.overall.boostedHybrid.eventCount, 0);
  assert.equal(emptyScore.coverage.eventCount, 0);
  assert.deepEqual(emptyScore.causalAudit, {
    selectionCount: 0,
    violationCount: 0,
  });
});

// keep earlier causal selections isolated from later outcomes
test("keeps boosted hybrid earlier slices independent from future labels", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = liveDailySequence({ count: 35, targetLeadHours: 48 });
  const changedEvents = scoreEvents.map(
    // alter only the final outcome
    (event, index) => index === scoreEvents.length - 1
      ? { ...event, actual: event.actual + 20 }
      : event,
  );
  const original = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 0),
  );
  const changed = analyzeBoostedHybrid(
    trainingEvents,
    changedEvents,
    boostedTrainer(() => 0),
  );
  const originalEarlier = original.boostedHybrid.diagnostics.byLocalDate.slice(0, -1);
  const changedEarlier = changed.boostedHybrid.diagnostics.byLocalDate.slice(0, -1);

  assert.deepEqual(originalEarlier, changedEarlier);
  assert.equal(
    original.boostedResidual.model.requestSha256,
    changed.boostedResidual.model.requestSha256,
  );
  assert.notDeepEqual(
    original.boostedHybrid.diagnostics.byLocalDate.at(-1),
    changed.boostedHybrid.diagnostics.byLocalDate.at(-1),
  );
});

// retain the boosted hybrid report while declining archive nowcast scores
test("adds archive-safe nowcast evidence without changing boosted hybrid results", () => {
  const trainingEvents = trainingCell({ actual: 3, rawForecast: 0 });
  const scoreEvents = [anchorEvent({
    actual: 2,
    validAt: "2025-02-20T16:00:00.000Z",
  })];
  let nativeCallCount = 0;
  let auditCallCount = 0;
  const report = analyzeNearNowcast(
    trainingEvents,
    scoreEvents,
    (request) => {
      nativeCallCount += 1;
      return boostedTrainer(() => 0)(request);
    },
    {
      scoreCohort: "fixed_lead_anchor",
      onPrivatePredictionAudit: () => {
        auditCallCount += 1;
      },
    },
  );
  const original = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 0),
    "fixed_lead_anchor",
  );
  const { nearNowcast, ...compatibleReport } = report;

  assert.equal(nativeCallCount, 1);
  assert.equal(auditCallCount, 0);
  assert.equal(report.contractVersion, "temperature-near-nowcast-research/v1");
  assert.deepEqual(
    {
      ...compatibleReport,
      contractVersion: "temperature-boosted-hybrid-research/v1",
    },
    original,
  );
  assert.equal(nearNowcast.status, "not_applicable_archive_cohort");
  assert.equal(nearNowcast.reason, "archive_has_no_observed_retrieval_time");

  // require every archive score surface to remain explicitly null
  for (const field of [
    "overall",
    "first6Hours",
    "hours7To12",
    "first12Hours",
    "hours13To24",
    "hours25To48",
    "hours13To48",
    "first48Hours",
    "after48Hours",
    "diagnostics",
    "first12Diagnostics",
    "coverage",
    "causalAudit",
    "sourceAge",
  ]) {
    assert.equal(nearNowcast[field], null);
  }
});

// preserve exact twelve, thirteen, and forty-eight-hour composition boundaries
test("applies nowcasting through twelve hours and preserves later hybrid rows", () => {
  const scoreEvents = [
    anchorEvent({
      actual: 10,
      rawForecast: 8,
      referenceAt: "2025-03-10T08:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T09:00:00.000Z",
    }),
    anchorEvent({
      actual: 12,
      rawForecast: 8,
      referenceAt: "2025-03-10T09:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T10:00:00.000Z",
    }),
    anchorEvent({
      actual: 14,
      rawForecast: 8,
      rawRelativeHumidityPercent: null,
      rawWindSpeedMps: null,
      referenceAt: "2025-03-10T10:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T11:00:00.000Z",
    }),
    anchorEvent({
      actual: 13,
      rawForecast: 8,
      referenceAt: "2025-03-10T12:00:00.000Z",
      targetLeadHours: 12,
      validAt: "2025-03-11T00:00:00.000Z",
    }),
    anchorEvent({
      actual: 13,
      rawForecast: 8,
      referenceAt: "2025-03-10T12:00:00.000Z",
      targetLeadHours: 13,
      validAt: "2025-03-11T01:00:00.000Z",
    }),
    anchorEvent({
      actual: 13,
      rawForecast: 8,
      referenceAt: "2025-03-10T12:00:00.000Z",
      targetLeadHours: 49,
      validAt: "2025-03-12T13:00:00.000Z",
    }),
  ];
  const trainingEvents = [anchorEvent({
    actual: 10,
    rawForecast: 8,
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  let nativeCallCount = 0;
  let auditCallCount = 0;
  let privateRecords;
  const privateCallback = (records) => {
    auditCallCount += 1;
    privateCallback.ownCallCount += 1;
    privateRecords = records;
    assert.equal(Object.isFrozen(records), true);
    assert.equal(records.every(Object.isFrozen), true);
    assert.equal(records.every(
      // require every nested source collection to be frozen
      (record) =>
        Object.isFrozen(record.selectedSources) &&
        record.selectedSources.every(Object.isFrozen),
    ), true);
    assert.throws(
      // reject private target mutation
      () => {
        records[0].actual = 999;
      },
      TypeError,
    );
  };
  // retain caller-owned mutable callback state
  privateCallback.ownCallCount = 0;
  const report = analyzeNearNowcast(
    trainingEvents,
    scoreEvents,
    (request) => {
      nativeCallCount += 1;
      return boostedTrainer(() => 1)(request);
    },
    { onPrivatePredictionAudit: privateCallback },
  );
  const original = analyzeBoostedHybrid(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 1),
  );
  const withoutPrivateCallback = analyzeNearNowcast(
    trainingEvents,
    scoreEvents,
    boostedTrainer(() => 1),
  );
  const { nearNowcast, ...compatibleReport } = report;
  const target12 = privateRecords.find(
    // locate the supported boundary target
    (record) => record.targetLeadHours === 12,
  );
  const target13 = privateRecords.find(
    // locate the first preserved target
    (record) => record.targetLeadHours === 13,
  );
  const target49 = privateRecords.find(
    // locate the frozen boosted target
    (record) => record.targetLeadHours === 49,
  );

  assert.equal(nativeCallCount, 1);
  assert.equal(auditCallCount, 1);
  assert.equal(privateCallback.ownCallCount, 1);
  assert.equal(Object.isFrozen(privateCallback), false);
  assert.deepEqual(report, withoutPrivateCallback);
  assert.deepEqual(
    {
      ...compatibleReport,
      contractVersion: "temperature-boosted-hybrid-research/v1",
    },
    original,
  );
  assert.equal(target12.fallbackReason, null);
  assert.deepEqual(
    target12.selectedSources.map(
      // retain the latest three mature hours
      (source) => source.validAt,
    ),
    [
      "2025-03-10T11:00:00.000Z",
      "2025-03-10T10:00:00.000Z",
      "2025-03-10T09:00:00.000Z",
    ],
  );
  assert.equal(target13.fallbackReason, "outside_first_12_hours");
  assert.equal(
    target13.nearNowcastPrediction,
    target13.priorBoostedHybridPrediction,
  );
  assert.equal(target49.fallbackReason, "outside_first_12_hours");
  assert.equal(
    target49.nearNowcastPrediction,
    target49.priorBoostedHybridPrediction,
  );
  assert.notEqual(target49.priorBoostedHybridPrediction, target49.rawForecast);
  assert.equal(nearNowcast.coverage.nonzeroCorrectionCount, 1);
  assert.deepEqual(
    nearNowcast.hours13To48.nearNowcast,
    nearNowcast.hours13To48.boostedHybrid,
  );
  assert.deepEqual(
    nearNowcast.after48Hours.nearNowcast,
    nearNowcast.after48Hours.boostedHybrid,
  );
  assert.equal(nearNowcast.causalAudit.auditSha256, canonicalSha256(privateRecords));
  assert.deepEqual(
    {
      lookbackViolationCount: nearNowcast.causalAudit.lookbackViolationCount,
      maturityViolationCount: nearNowcast.causalAudit.maturityViolationCount,
      referenceOrderViolationCount:
        nearNowcast.causalAudit.referenceOrderViolationCount,
      sourceLeadViolationCount: nearNowcast.causalAudit.sourceLeadViolationCount,
    },
    {
      lookbackViolationCount: 0,
      maturityViolationCount: 0,
      referenceOrderViolationCount: 0,
      sourceLeadViolationCount: 0,
    },
  );
  assert.equal(JSON.stringify(report).includes("selectedSources"), false);
  assert.equal(JSON.stringify(report).includes(target12.key), false);

  const primaryRecords = privateRecords.filter(
    // independently retain the complete first-twelve-hour denominator
    (record) => record.targetLeadHours <= 12,
  );
  const eventMae = primaryRecords.reduce(
    // sum exact candidate errors
    (sum, record) =>
      sum + Math.abs(record.actual - record.nearNowcastPrediction),
    0,
  ) / primaryRecords.length;
  const errorsByValidAt = new Map();

  // independently group first-twelve-hour errors by valid hour
  for (const record of primaryRecords) {
    const errors = errorsByValidAt.get(record.validAt) ?? [];
    errors.push(Math.abs(record.actual - record.nearNowcastPrediction));
    errorsByValidAt.set(record.validAt, errors);
  }

  const balancedMae = [...errorsByValidAt.values()].reduce(
    // average each valid-hour mean equally
    (sum, errors) =>
      sum + errors.reduce(
        // sum one valid hour's event errors
        (hourSum, error) => hourSum + error,
        0,
      ) / errors.length,
    0,
  ) / errorsByValidAt.size;

  assert.equal(
    nearNowcast.first12Hours.nearNowcast.eventWeightedMeanAbsoluteError,
    eventMae,
  );
  assert.equal(
    nearNowcast.first12Hours.nearNowcast.uniqueHourBalancedMeanAbsoluteError,
    balancedMae,
  );

  // require every primary diagnostic dimension to retain its denominator
  for (const slices of Object.values(nearNowcast.first12Diagnostics)) {
    assert.equal(
      slices.reduce(
        // sum each primary diagnostic denominator
        (sum, item) => sum + item.comparison.nearNowcast.eventCount,
        0,
      ),
      primaryRecords.length,
    );
  }
});

// isolate earlier nowcasts from later observations and input order
test("keeps earlier nowcasts independent from future labels and ordering", () => {
  const scoreEvents = [
    anchorEvent({
      actual: 10,
      rawForecast: 8,
      referenceAt: "2025-03-10T08:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T09:00:00.000Z",
    }),
    anchorEvent({
      actual: 12,
      rawForecast: 8,
      referenceAt: "2025-03-10T09:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T10:00:00.000Z",
    }),
    anchorEvent({
      actual: 14,
      rawForecast: 8,
      referenceAt: "2025-03-10T10:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T11:00:00.000Z",
    }),
    anchorEvent({
      actual: 13,
      rawForecast: 8,
      referenceAt: "2025-03-10T12:00:00.000Z",
      targetLeadHours: 12,
      validAt: "2025-03-11T00:00:00.000Z",
    }),
    anchorEvent({
      actual: 15,
      rawForecast: 8,
      referenceAt: "2025-03-10T13:00:00.000Z",
      targetLeadHours: 1,
      validAt: "2025-03-10T14:00:00.000Z",
    }),
  ];
  const trainingEvents = [anchorEvent({
    validAt: "2025-01-15T16:00:00.000Z",
  })];

  // capture one complete private audit
  function run(events) {
    let records;
    const report = analyzeNearNowcast(
      trainingEvents,
      events,
      boostedTrainer(() => 0),
      {
        onPrivatePredictionAudit: (value) => {
          records = value;
        },
      },
    );
    return { records, report };
  }

  const original = run(scoreEvents);
  const changed = run([...scoreEvents].reverse().map(
    // alter only one observation unavailable to the earlier target
    (event) => event.validAt === "2025-03-10T14:00:00.000Z"
      ? { ...event, actual: event.actual + 20 }
      : event,
  ));
  const earlierKey = "2025-03-11T00:00:00.000Z|12";
  const originalEarlier = original.records.find(
    // locate the original earlier target
    (record) => record.key === earlierKey,
  );
  const changedEarlier = changed.records.find(
    // locate the changed-run earlier target
    (record) => record.key === earlierKey,
  );

  assert.deepEqual(originalEarlier, changedEarlier);
  assert.equal(
    original.report.nearNowcast.first12Hours.nearNowcast.eventCount,
    changed.report.nearNowcast.first12Hours.nearNowcast.eventCount,
  );
  assert.notEqual(
    original.report.nearNowcast.causalAudit.auditSha256,
    changed.report.nearNowcast.causalAudit.auditSha256,
  );
});

// retain explicit empty and missing-predictor evidence
test("reports empty nowcast cohorts and validates the private callback", () => {
  const trainingEvents = [anchorEvent({
    validAt: "2025-01-15T16:00:00.000Z",
  })];
  let callbackCount = 0;
  const empty = analyzeNearNowcast(
    trainingEvents,
    [],
    boostedTrainer(() => 0),
    {
      onPrivatePredictionAudit: (records) => {
        callbackCount += 1;
        assert.deepEqual(records, []);
        assert.equal(Object.isFrozen(records), true);
      },
    },
  ).nearNowcast;

  assert.equal(callbackCount, 1);
  assert.equal(empty.status, "empty_live_cohort");
  assert.equal(empty.coverage.eventCount, 0);
  assert.equal(empty.causalAudit.auditSha256, canonicalSha256([]));
  assert.equal(empty.sourceAge.adjustedEventCount, 0);
  assert.equal(empty.sourceAge.meanLatestSourceAgeToTargetHours, null);
  assert.equal(empty.overall.nearNowcast.eventCount, 0);
  assert.throws(
    () => analyzeTemperatureNearNowcastResearch({
      onPrivatePredictionAudit: "invalid",
      scoreCohort: "legacy_v4_retrieval_snapshot",
      scoreEvents: [],
      trainer: boostedTrainer(() => 0),
      trainingEvents,
    }),
    /must be a function/u,
  );
});
