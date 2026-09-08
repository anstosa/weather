import assert from "node:assert/strict";
import test from "node:test";

import {
  TEMPERATURE_MOS_RUNTIME_POLICY,
  applyEcmwfTemperatureMosRuntime,
} from "../dist/temperature-mos-runtime.js";

const DIRECT_COEFFICIENTS = Array.from(
  { length: 35 },
  (_unused, index) => ((index % 7) - 3) * 0.017,
);
const ADAPTIVE_COEFFICIENTS = Array.from(
  { length: 49 },
  (_unused, index) => ((index % 9) - 4) * 0.011,
);
const TRAINING_CUTOFF = "2026-08-25T07:00:00.000Z";

// create one supported original-winner and strength artifact
function createModel(overrides = {}) {
  return {
    adaptiveCoefficients: ADAPTIVE_COEFFICIENTS,
    cohort: "ecmwf_single_run_hindcast",
    contractVersion: "temperature-shortlead-models-research/v1",
    directCoefficients: DIRECT_COEFFICIENTS,
    learnedStrengthContractVersion:
      "temperature-winner-extensions-research/v1",
    month: "2026-09",
    scope: "initialization_first12",
    strengthBands: {
      "1-6": {
        alpha: 1,
        supported: true,
        trainingCutoffUtc: TRAINING_CUTOFF,
      },
      "7-12": {
        alpha: 0.8,
        supported: true,
        trainingCutoffUtc: TRAINING_CUTOFF,
      },
    },
    supported: true,
    trainingCutoffUtc: TRAINING_CUTOFF,
    ...overrides,
  };
}

// create one six-hour delayed winner artifact
function createDelayedModel(overrides = {}) {
  return createModel({ scope: "assumed_delay6_next12", ...overrides });
}

// create one explicitly bound recent-error receipt
function createState(supported = true, overrides = {}) {
  return {
    b24C: supported ? 0.8 : null,
    b72C: supported ? 0.3 : null,
    cohort: "ecmwf_single_run_hindcast",
    localDates: supported ? 3 : 0,
    mad72C: supported ? 0.4 : null,
    maximumSourceRunInitializedAt: supported
      ? "2026-09-06T12:00:00.000Z"
      : null,
    maximumSourceValidAt: supported ? "2026-09-07T05:00:00.000Z" : null,
    n24: supported ? 12 : 0,
    n72: supported ? 50 : 0,
    sourceKeys: supported
      ? Array.from({ length: 50 }, (_unused, index) => `source-${index}`)
      : [],
    supported,
    targetRunInitializedAt: "2026-09-07T12:00:00.000Z",
    windowEndValidAt: "2026-09-07T05:00:00.000Z",
    ...overrides,
  };
}

// create one primary initialization-relative forecast
function createForecast(lead = 5, overrides = {}) {
  const hour = 12 + lead;
  const validDate = hour < 24 ? "2026-09-07" : "2026-09-08";
  const validHour = hour % 24;
  return {
    cohort: "ecmwf_single_run_hindcast",
    key: `fixture-${lead}`,
    modelCycle: "50r1",
    modelLeadHours: lead,
    rawRelativeHumidityPercent: 78,
    rawTemperatureC: 16.4,
    rawWindSpeedMps: 3.2,
    runInitializedAt: "2026-09-07T12:00:00.000Z",
    validAt: `${validDate}T${String(validHour).padStart(2, "0")}:00:00.000Z`,
    ...overrides,
  };
}

// create one delayed-scope model lead
function createDelayedForecast(lead = 7, overrides = {}) {
  return createForecast(lead, overrides);
}

// apply one standard fixture
function applyFixture({ forecast, model, state } = {}) {
  return applyEcmwfTemperatureMosRuntime({
    forecast: forecast ?? createForecast(),
    model: model ?? createModel(),
    recentErrorState: state ?? createState(),
  });
}

// create one complete calendar-boundary fixture
function createCalendarFixture(month, cutoff, runDate, modelCycle) {
  const runInitializedAt = `${runDate}T12:00:00.000Z`;
  const runInitializedAtMilliseconds = Date.parse(runInitializedAt);
  const forecast = createForecast(5, {
    modelCycle,
    runInitializedAt,
    validAt: new Date(
      runInitializedAtMilliseconds + 5 * 3_600_000,
    ).toISOString(),
  });
  const state = createState(true, {
    maximumSourceRunInitializedAt: new Date(
      runInitializedAtMilliseconds - 24 * 3_600_000,
    ).toISOString(),
    maximumSourceValidAt: new Date(
      runInitializedAtMilliseconds - 7 * 3_600_000,
    ).toISOString(),
    targetRunInitializedAt: runInitializedAt,
    windowEndValidAt: new Date(
      runInitializedAtMilliseconds - 7 * 3_600_000,
    ).toISOString(),
  });
  const baseModel = createModel();
  const model = createModel({
    month,
    strengthBands: {
      "1-6": { ...baseModel.strengthBands["1-6"], trainingCutoffUtc: cutoff },
      "7-12": {
        ...baseModel.strengthBands["7-12"],
        trainingCutoffUtc: cutoff,
      },
    },
    trainingCutoffUtc: cutoff,
  });
  return { forecast, model, state };
}

// compare one javascript result with its python-generated reference
function assertNear(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} differs from ${expected}`,
  );
}

// prove exact adaptive and alpha behavior against frozen python fixtures
test("matches python adaptive MOS and learned-strength references", () => {
  const firstBand = applyFixture();
  assert.equal(firstBand.applied, true);
  assert.equal(firstBand.branch, "adaptive");
  assert.equal(firstBand.alpha, 1);
  assertNear(firstBand.unscaledCorrectionC, -0.02499230292486265);
  assertNear(
    firstBand.incumbentHalfStrengthTemperatureC,
    16.387503848537566,
  );
  assertNear(firstBand.predictionTemperatureC, 16.375007697075137);

  const secondBand = applyFixture({ forecast: createForecast(10) });
  assert.equal(secondBand.applied, true);
  assert.equal(secondBand.branch, "adaptive");
  assert.equal(secondBand.alpha, 0.8);
  assertNear(secondBand.unscaledCorrectionC, -0.06038976364525356);
  assertNear(
    secondBand.incumbentHalfStrengthTemperatureC,
    16.36980511817737,
  );
  assertNear(secondBand.predictionTemperatureC, 16.351688189083795);
});

// prove unsupported recent-error state selects the original direct schema
test("matches the python direct branch when recent-error support is absent", () => {
  const result = applyFixture({ state: createState(false) });
  assert.equal(result.applied, true);
  assert.equal(result.branch, "direct");
  assertNear(result.unscaledCorrectionC, -0.020674614090718732);
  assertNear(result.incumbentHalfStrengthTemperatureC, 16.38966269295464);
  assertNear(result.predictionTemperatureC, 16.37932538590928);
});

// prove delayed decay and strength use the post-availability horizon
test("matches delayed-scope operational horizons without changing static lead", () => {
  const firstHour = applyFixture({
    forecast: createDelayedForecast(7),
    model: createDelayedModel(),
  });
  assert.equal(firstHour.applied, true);
  assert.equal(firstHour.alpha, 1);
  assertNear(firstHour.unscaledCorrectionC, -0.02117124288061087);
  assertNear(firstHour.predictionTemperatureC, 16.378828757119386);

  const seventhHour = applyFixture({
    forecast: createDelayedForecast(13),
    model: createDelayedModel(),
  });
  assert.equal(seventhHour.applied, true);
  assert.equal(seventhHour.alpha, 0.8);
  assertNear(seventhHour.unscaledCorrectionC, -0.1148759989566083);
  assertNear(seventhHour.predictionTemperatureC, 16.30809920083471);
});

// prove delayed model leads stay closed to seven through eighteen
test("fails raw outside the delayed model-lead window", () => {
  const early = applyFixture({
    forecast: createDelayedForecast(6),
    model: createDelayedModel(),
  });
  assert.equal(early.applied, false);
  assert.equal(early.reason, "outside_assumed_delay6_next12");

  const late = applyFixture({
    forecast: createDelayedForecast(19),
    model: createDelayedModel(),
  });
  assert.equal(late.applied, false);
  assert.equal(late.reason, "outside_assumed_delay6_next12");
});

// prove the original missing-weather indicators retain python parity
test("matches python when humidity and wind features are missing", () => {
  const result = applyFixture({
    forecast: createForecast(5, {
      rawRelativeHumidityPercent: null,
      rawWindSpeedMps: null,
    }),
  });
  assert.equal(result.applied, true);
  assertNear(result.unscaledCorrectionC, -0.030563948752265615);
  assertNear(result.incumbentHalfStrengthTemperatureC, 16.384718025623865);
  assertNear(result.predictionTemperatureC, 16.36943605124773);
});

// prove both correction and physical limits remain frozen
test("caps learned correction at three Celsius and physical bounds", () => {
  const positiveCoefficients = Array(35).fill(0);
  positiveCoefficients[0] = 100;
  const positive = applyFixture({
    forecast: createForecast(5, { rawTemperatureC: 69 }),
    model: createModel({ directCoefficients: positiveCoefficients }),
    state: createState(false),
  });
  assert.equal(positive.applied, true);
  assert.equal(positive.incumbentHalfStrengthTemperatureC, 70);
  assert.equal(positive.predictionTemperatureC, 70);

  const negativeCoefficients = Array(35).fill(0);
  negativeCoefficients[0] = -100;
  const negative = applyFixture({
    forecast: createForecast(5, { rawTemperatureC: -99 }),
    model: createModel({ directCoefficients: negativeCoefficients }),
    state: createState(false),
  });
  assert.equal(negative.applied, true);
  assert.equal(negative.incumbentHalfStrengthTemperatureC, -100);
  assert.equal(negative.predictionTemperatureC, -100);
  assert.equal(TEMPERATURE_MOS_RUNTIME_POLICY.maximumCorrectionC, 3);
});

// prove foreign providers and delayed or later scopes never change raw
test("fails raw for Best Match and forecasts beyond initialization hour 12", () => {
  const bestMatch = applyFixture({
    forecast: createForecast(5, { cohort: "best_match_single_run_transfer" }),
  });
  assert.deepEqual(bestMatch, {
    applied: false,
    predictionTemperatureC: 16.4,
    rawTemperatureC: 16.4,
    reason: "unsupported_cohort",
  });

  const later = applyFixture({ forecast: createForecast(13) });
  assert.deepEqual(later, {
    applied: false,
    predictionTemperatureC: 16.4,
    rawTemperatureC: 16.4,
    reason: "outside_initialization_first12",
  });
});

// prove model cold starts and strength cold starts fail raw
test("fails raw instead of substituting another model", () => {
  const modelColdStart = applyFixture({ model: createModel({ supported: false }) });
  assert.equal(modelColdStart.applied, false);
  assert.equal(modelColdStart.reason, "model_not_supported");
  assert.equal(modelColdStart.predictionTemperatureC, 16.4);

  const strengthColdStart = applyFixture({
    model: createModel({
      strengthBands: {
        ...createModel().strengthBands,
        "1-6": {
          ...createModel().strengthBands["1-6"],
          supported: false,
        },
      },
    }),
  });
  assert.equal(strengthColdStart.applied, false);
  assert.equal(strengthColdStart.reason, "strength_band_not_supported");
  assert.equal(strengthColdStart.predictionTemperatureC, 16.4);

  const invalidContract = applyFixture({
    model: createModel({ contractVersion: "different-model/v1" }),
  });
  assert.equal(invalidContract.applied, false);
  assert.equal(invalidContract.reason, "invalid_model");

  const invalidAlpha = applyFixture({
    model: createModel({
      strengthBands: {
        ...createModel().strengthBands,
        "1-6": {
          ...createModel().strengthBands["1-6"],
          alpha: 0.75,
        },
      },
    }),
  });
  assert.equal(invalidAlpha.applied, false);
  assert.equal(invalidAlpha.reason, "invalid_model");
});

// prove model identity and causal cutoffs are mandatory
test("fails raw for wrong model identity or unavailable fits", () => {
  const wrongMonth = applyFixture({ model: createModel({ month: "2026-08" }) });
  assert.equal(wrongMonth.applied, false);
  assert.equal(wrongMonth.reason, "model_identity_mismatch");

  const futureFit = applyFixture({
    model: createModel({ trainingCutoffUtc: "2026-09-07T12:00:00.000Z" }),
  });
  assert.equal(futureFit.applied, false);
  assert.equal(futureFit.reason, "model_not_yet_available");

  const futureAlpha = applyFixture({
    model: createModel({
      strengthBands: {
        ...createModel().strengthBands,
        "7-12": {
          ...createModel().strengthBands["7-12"],
          trainingCutoffUtc: "2026-09-08T00:00:00.000Z",
        },
      },
    }),
  });
  assert.equal(futureAlpha.applied, false);
  assert.equal(futureAlpha.reason, "model_not_yet_available");

  const staleCutoff = applyFixture({
    model: createModel({ trainingCutoffUtc: "2026-08-24T07:00:00.000Z" }),
  });
  assert.equal(staleCutoff.applied, false);
  assert.equal(staleCutoff.reason, "invalid_model");

  const mismatchedBandCutoff = applyFixture({
    model: createModel({
      strengthBands: {
        ...createModel().strengthBands,
        "1-6": {
          ...createModel().strengthBands["1-6"],
          trainingCutoffUtc: "2026-08-24T07:00:00.000Z",
        },
      },
    }),
  });
  assert.equal(mismatchedBandCutoff.applied, false);
  assert.equal(mismatchedBandCutoff.reason, "invalid_model");
});

// prove exact winter, summer, and dst-adjacent local-month cutoffs
test("accepts exact local-month embargo cutoffs across Pacific offsets", () => {
  const fixtures = [
    createCalendarFixture(
      "2026-01",
      "2025-12-25T08:00:00.000Z",
      "2026-01-15",
      "49r1",
    ),
    createCalendarFixture(
      "2026-03",
      "2026-02-22T08:00:00.000Z",
      "2026-03-15",
      "49r1",
    ),
    createCalendarFixture(
      "2026-07",
      "2026-06-24T07:00:00.000Z",
      "2026-07-15",
      "50r1",
    ),
    createCalendarFixture(
      "2026-11",
      "2026-10-25T07:00:00.000Z",
      "2026-11-15",
      "50r1",
    ),
  ];

  // validate each Pacific calendar boundary independently
  for (const fixture of fixtures) {
    assert.equal(applyFixture(fixture).applied, true);
  }
});

// prove state is bound to the run and exact checked-as-of boundary
test("fails raw for stale or future recent-error state", () => {
  const wrongRun = applyFixture({
    state: createState(true, {
      targetRunInitializedAt: "2026-09-07T06:00:00.000Z",
    }),
  });
  assert.equal(wrongRun.applied, false);
  assert.equal(wrongRun.reason, "recent_error_state_run_mismatch");

  const staleBoundary = applyFixture({
    state: createState(true, {
      windowEndValidAt: "2026-09-07T04:00:00.000Z",
    }),
  });
  assert.equal(staleBoundary.applied, false);
  assert.equal(staleBoundary.reason, "recent_error_state_as_of_mismatch");

  const futureObservation = applyFixture({
    state: createState(true, {
      maximumSourceValidAt: "2026-09-07T06:00:00.000Z",
    }),
  });
  assert.equal(futureObservation.applied, false);
  assert.equal(
    futureObservation.reason,
    "recent_error_state_contains_future_data",
  );
  assert.equal(futureObservation.predictionTemperatureC, 16.4);

  const staleMaximum = applyFixture({
    state: createState(true, {
      maximumSourceValidAt: "2026-06-01T05:00:00.000Z",
    }),
  });
  assert.equal(staleMaximum.applied, false);
  assert.equal(staleMaximum.reason, "recent_error_state_outside_window");
  assert.equal(staleMaximum.predictionTemperatureC, 16.4);
});

// prove valid gaps and both inclusive lower boundaries remain accepted
test("accepts valid gaps and inclusive recent-error window boundaries", () => {
  const shortGap = applyFixture({
    state: createState(true, {
      maximumSourceValidAt: "2026-09-07T03:00:00.000Z",
    }),
  });
  assert.equal(shortGap.applied, true);
  assert.equal(shortGap.branch, "adaptive");

  const shortBoundary = applyFixture({
    state: createState(true, {
      maximumSourceRunInitializedAt: "2026-09-05T12:00:00.000Z",
      maximumSourceValidAt: "2026-09-06T06:00:00.000Z",
    }),
  });
  assert.equal(shortBoundary.applied, true);
  assert.equal(shortBoundary.branch, "adaptive");

  const longBoundary = applyFixture({
    state: createState(false, {
      localDates: 1,
      maximumSourceRunInitializedAt: "2026-09-03T12:00:00.000Z",
      maximumSourceValidAt: "2026-09-04T06:00:00.000Z",
      n72: 23,
      sourceKeys: Array.from(
        { length: 23 },
        (_unused, index) => `long-source-${index}`,
      ),
    }),
  });
  assert.equal(longBoundary.applied, true);
  assert.equal(longBoundary.branch, "direct");
});

// prove impossible source-lead maxima fail raw
test("rejects source-run maxima incompatible with leads 7 through 18", () => {
  const result = applyFixture({
    state: createState(true, {
      maximumSourceRunInitializedAt: "2026-09-07T00:00:00.000Z",
      maximumSourceValidAt: "2026-09-07T01:00:00.000Z",
    }),
  });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "recent_error_state_source_run_mismatch");
  assert.equal(result.predictionTemperatureC, 16.4);
});

// prove malformed support receipts cannot fabricate an adaptive state
test("fails raw for contradictory recent-error support", () => {
  const result = applyFixture({ state: createState(true, { n24: 5 }) });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "invalid_recent_error_state");
  assert.equal(result.predictionTemperatureC, 16.4);
});

// prove nonfinite model material cannot reach the dot product
test("fails raw for nonfinite or wrong-width coefficients", () => {
  const nonfinite = [...ADAPTIVE_COEFFICIENTS];
  nonfinite[4] = Number.NaN;
  const invalidNumber = applyFixture({
    model: createModel({ adaptiveCoefficients: nonfinite }),
  });
  assert.equal(invalidNumber.applied, false);
  assert.equal(invalidNumber.reason, "invalid_model");

  const invalidWidth = applyFixture({
    model: createModel({ directCoefficients: DIRECT_COEFFICIENTS.slice(1) }),
  });
  assert.equal(invalidWidth.applied, false);
  assert.equal(invalidWidth.reason, "invalid_model");
  assert.equal(invalidWidth.predictionTemperatureC, 16.4);
});

// prove run timestamps, lead labels, and cycle identity stay coupled
test("fails raw for inconsistent run identity", () => {
  const wrongLead = applyFixture({
    forecast: createForecast(5, { validAt: "2026-09-07T18:00:00.000Z" }),
  });
  assert.equal(wrongLead.applied, false);
  assert.equal(wrongLead.reason, "invalid_forecast");

  const missingCycle = applyFixture({
    forecast: createForecast(5, { modelCycle: "" }),
  });
  assert.equal(missingCycle.applied, false);
  assert.equal(missingCycle.reason, "invalid_forecast");
  assert.equal(missingCycle.predictionTemperatureC, 16.4);

  const wrongEra = applyFixture({
    forecast: createForecast(5, { modelCycle: "49r1" }),
  });
  assert.equal(wrongEra.applied, false);
  assert.equal(wrongEra.reason, "invalid_forecast");

  const wrongInitializationCycle = applyFixture({
    forecast: createForecast(5, {
      runInitializedAt: "2026-09-07T13:00:00.000Z",
      validAt: "2026-09-07T18:00:00.000Z",
    }),
    state: createState(true, {
      targetRunInitializedAt: "2026-09-07T13:00:00.000Z",
      windowEndValidAt: "2026-09-07T06:00:00.000Z",
    }),
  });
  assert.equal(wrongInitializationCycle.applied, false);
  assert.equal(wrongInitializationCycle.reason, "invalid_forecast");
});

// prove unexpected internal failures remain contained at the serving boundary
test("fails raw with a distinct reason for unclassified inference errors", () => {
  const input = {
    forecast: createForecast(),
    recentErrorState: createState(),
    // expose one unclassified caller-side access failure
    get model() {
      throw new Error("unexpected getter failure");
    },
  };
  const result = applyEcmwfTemperatureMosRuntime(input);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "inference_error");
  assert.equal(result.predictionTemperatureC, 16.4);
});
