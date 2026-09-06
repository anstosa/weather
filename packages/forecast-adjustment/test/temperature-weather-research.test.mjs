import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeTemperatureWeatherResearch,
} from "../dist/temperature-weather-research.js";

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
