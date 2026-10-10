import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalForecastBias,
  projectLocalForecastBias,
} from "../dist/local-forecast-bias.js";

const latitude = 47.950429954185445;
const longitude = -122.42797012608193;
const observedAt = "2026-06-21T20:00:00.000Z";

// compare one deterministic floating-point result
function assertClose(actual, expected, tolerance = 1e-9) {
  assert.equal(Math.abs(actual - expected) <= tolerance, true, `${actual} != ${expected}`);
}

// create one complete local or regional sample
function sample(value, overrides = {}) {
  return {
    freshnessStatus: "fresh",
    receivedAt: observedAt,
    recordId: "record",
    sourceId: "source",
    validAt: observedAt,
    value,
    ...overrides,
  };
}

// create one valid paired bias input
function validInput(metric, observedValue, regionalValue, overrides = {}) {
  return {
    latitude,
    longitude,
    metric,
    now: observedAt,
    observed: sample(observedValue, {
      recordId: "observed-record",
      sourceId: "observed-source",
    }),
    regional: sample(regionalValue, {
      recordId: "regional-record",
      sourceId: "regional-source",
    }),
    ...overrides,
  };
}

// require one successfully created bias
function biasFor(metric, observedValue, regionalValue, overrides = {}) {
  const bias = createLocalForecastBias(validInput(metric, observedValue, regionalValue, overrides));
  assert.ok(bias);
  return bias;
}

// derive bounded corrections with complete immutable provenance
test("local forecast biases derive bounded additive deltas and UV ratios", () => {
  const input = validInput("relativeHumidityPercent", 70, 40);
  Object.freeze(input.observed);
  Object.freeze(input.regional);
  Object.freeze(input);
  const humidity = createLocalForecastBias(input);
  assert.ok(humidity);
  assert.deepEqual(humidity, {
    adjustmentType: "additive",
    adjustmentValue: 20,
    contractVersion: "local-forecast-bias-experiment/v1",
    evaluatedAt: observedAt,
    expiresAt: "2026-06-22T20:00:00.000Z",
    metric: "relativeHumidityPercent",
    observationRecordId: "observed-record",
    observationSourceId: "observed-source",
    observedAt,
    observedValue: 70,
    regionalRecordId: "regional-record",
    regionalSourceId: "regional-source",
    regionalValidAt: observedAt,
    regionalValue: 40,
  });

  const cases = [
    ["relativeHumidityPercent", 20, 80, -20, "additive"],
    ["pm25MicrogramsPerCubicMeter", 10, 100, -50, "additive"],
    ["pm25MicrogramsPerCubicMeter", 80, 10, 50, "additive"],
    ["pressureChange3hHpa", -10, 10, -3, "additive"],
    ["pressureChange3hHpa", 8, 7, 1, "additive"],
    ["uvIndex", 12, 6, 1.5, "multiplicative"],
    ["uvIndex", 0, 10, 0.2, "multiplicative"],
  ];
  // verify both correction signs and every safety cap
  for (const [metric, observedValue, regionalValue, adjustmentValue, adjustmentType] of cases) {
    const bias = biasFor(metric, observedValue, regionalValue);
    assert.equal(bias.adjustmentValue, adjustmentValue);
    assert.equal(bias.adjustmentType, adjustmentType);
  }
});

// taper each correction from its observation through exactly twenty-four hours
test("local forecast projections taper and clamp without changing unavailable raw values", () => {
  const humidityUp = biasFor("relativeHumidityPercent", 80, 40);
  const humidityDown = biasFor("relativeHumidityPercent", 10, 50);
  const pollutionDown = biasFor("pm25MicrogramsPerCubicMeter", 0, 100);
  const pressureUp = biasFor("pressureChange3hHpa", 10, 0);
  const uvUp = biasFor("uvIndex", 12, 6);
  const uvDown = biasFor("uvIndex", 0, 10);

  assert.equal(projectLocalForecastBias(50, observedAt, humidityUp), 70);
  assert.equal(projectLocalForecastBias(50, "2026-06-22T02:00:00.000Z", humidityUp), 65);
  assert.equal(projectLocalForecastBias(50, "2026-06-22T08:00:00.000Z", humidityUp), 60);
  assert.equal(projectLocalForecastBias(50, "2026-06-22T19:59:59.999Z", humidityUp) > 50, true);
  assert.equal(projectLocalForecastBias(50, "2026-06-22T20:00:00.000Z", humidityUp), 50);
  assert.equal(projectLocalForecastBias(50, "2026-06-22T21:00:00.000Z", humidityUp), 50);
  assert.equal(projectLocalForecastBias(95, observedAt, humidityUp), 100);
  assert.equal(projectLocalForecastBias(5, observedAt, humidityDown), 0);
  assert.equal(projectLocalForecastBias(20, observedAt, pollutionDown), 0);
  assert.equal(projectLocalForecastBias(19, observedAt, pressureUp), 20);
  assert.equal(projectLocalForecastBias(10, observedAt, uvUp), 15);
  assert.equal(projectLocalForecastBias(10, "2026-06-22T02:00:00.000Z", uvUp), 13.75);
  assert.equal(projectLocalForecastBias(0, observedAt, uvUp), 0);
  assertClose(projectLocalForecastBias(10, observedAt, uvDown), 2);
  assert.equal(projectLocalForecastBias(null, observedAt, humidityUp), null);
  assert.equal(projectLocalForecastBias(-1, observedAt, humidityUp), -1);
  assert.equal(projectLocalForecastBias(101, observedAt, humidityUp), 101);
  assert.equal(Number.isNaN(projectLocalForecastBias(Number.NaN, observedAt, humidityUp)), true);
  assert.equal(projectLocalForecastBias(50, "2026-06-21T20:00:00", humidityUp), 50);
  assert.equal(projectLocalForecastBias(50, observedAt, null), 50);
  assert.equal(projectLocalForecastBias(50, observedAt, humidityUp), 70);
});

// reject stale future malformed unidentified and physically invalid pairs
test("local forecast bias creation fails raw at every sample boundary", () => {
  const base = validInput("relativeHumidityPercent", 70, 40);
  const invalid = [
    { ...base, observed: null },
    { ...base, regional: null },
    { ...base, now: "2026-06-21T20:00:00" },
    { ...base, now: "2026-02-30T20:00:00Z" },
    { ...base, observed: sample(70, { freshnessStatus: "delayed" }) },
    { ...base, regional: sample(40, { freshnessStatus: "stale" }) },
    { ...base, observed: sample(70, { validAt: "2026-06-21T20:00:00.001Z" }) },
    { ...base, observed: sample(70, { receivedAt: "2026-06-21T20:00:00.001Z" }) },
    { ...base, observed: sample(70, { receivedAt: "2026-06-21T19:59:59.999Z" }) },
    { ...base, observed: sample(70, { validAt: "2026-02-30T20:00:00Z" }) },
    {
      ...base,
      now: "2026-06-21T20:15:00.001Z",
      observed: sample(70),
    },
    {
      ...base,
      now: "2026-06-21T21:00:00.001Z",
      regional: sample(40),
    },
    {
      ...base,
      now: "2026-06-21T21:00:00.000Z",
      observed: sample(70, {
        receivedAt: "2026-06-21T21:00:00.000Z",
        validAt: "2026-06-21T21:00:00.000Z",
      }),
      regional: sample(40, {
        receivedAt: "2026-06-21T19:59:59.999Z",
        validAt: "2026-06-21T19:59:59.999Z",
      }),
    },
    { ...base, observed: sample(70, { recordId: " " }) },
    { ...base, regional: sample(40, { sourceId: "" }) },
    { ...base, observed: sample(null) },
    { ...base, observed: sample(Number.NaN) },
    { ...base, observed: sample(-0.001) },
    { ...base, observed: sample(100.001) },
    { ...base, metric: "unsupportedMetric" },
  ];
  // verify every independent fail-raw condition
  for (const input of invalid) {
    assert.equal(createLocalForecastBias(input), null);
  }

  assert.ok(createLocalForecastBias(validInput("relativeHumidityPercent", 0, 100)));
  assert.ok(createLocalForecastBias(validInput("pm25MicrogramsPerCubicMeter", 0, 1000)));
  assert.ok(createLocalForecastBias(validInput("pressureChange3hHpa", -20, 20)));
  assert.ok(createLocalForecastBias(validInput("uvIndex", 20, 1)));
  assert.equal(createLocalForecastBias(validInput("uvIndex", 1, 0)), null);
  assert.equal(createLocalForecastBias(validInput("pm25MicrogramsPerCubicMeter", 0, 1000.001)), null);
  assert.equal(createLocalForecastBias(validInput("pressureChange3hHpa", -20.001, 0)), null);
  assert.equal(createLocalForecastBias(validInput("uvIndex", 20.001, 1)), null);
});

// distinguish published forecast baselines from causal current observations
test("regional forecast publication may precede its exact current valid hour", () => {
  const now = "2026-06-21T20:10:00.000Z";
  const observed = sample(70, {
    receivedAt: "2026-06-21T20:01:00.000Z",
    recordId: "observed-record",
    sourceId: "observed-source",
  });
  const publishedRegional = sample(40, {
    forecastProduct: true,
    receivedAt: "2026-06-21T19:30:00.000Z",
    recordId: "regional-record",
    sourceId: "regional-source",
  });
  const accepted = createLocalForecastBias(validInput(
    "relativeHumidityPercent",
    70,
    40,
    { now, observed, regional: publishedRegional },
  ));
  assert.ok(accepted);
  assert.equal(accepted.adjustmentValue, 20);

  const currentReading = { ...publishedRegional, forecastProduct: false };
  assert.equal(createLocalForecastBias(validInput(
    "relativeHumidityPercent",
    70,
    40,
    { now, observed, regional: currentReading },
  )), null);

  const expiredPublication = {
    ...publishedRegional,
    receivedAt: "2026-06-21T19:09:59.999Z",
  };
  assert.equal(createLocalForecastBias(validInput(
    "relativeHumidityPercent",
    70,
    40,
    { now, observed, regional: expiredPublication },
  )), null);

  const futureValidPublication = {
    ...publishedRegional,
    validAt: "2026-06-21T20:10:00.001Z",
  };
  assert.equal(createLocalForecastBias(validInput(
    "relativeHumidityPercent",
    70,
    40,
    { now, observed, regional: futureValidPublication },
  )), null);

  const forgedObservedForecast = {
    ...observed,
    forecastProduct: true,
    receivedAt: "2026-06-21T19:59:59.999Z",
  };
  assert.equal(createLocalForecastBias(validInput(
    "relativeHumidityPercent",
    70,
    40,
    { now, observed: forgedObservedForecast, regional: publishedRegional },
  )), null);
});

// permit UV ratios only under useful clear-sky geometry
test("UV bias requires valid coordinates and meaningful daylight", () => {
  const night = "2026-06-21T05:00:00.000Z";
  const lowSun = "2026-06-21T13:50:00.000Z";
  const invalid = [
    validInput("uvIndex", 5, 4, {
      now: night,
      observed: sample(5, { receivedAt: night, validAt: night }),
      regional: sample(4, { receivedAt: night, validAt: night }),
    }),
    validInput("uvIndex", 5, 4, {
      now: lowSun,
      observed: sample(5, { receivedAt: lowSun, validAt: lowSun }),
      regional: sample(4, { receivedAt: lowSun, validAt: lowSun }),
    }),
    validInput("uvIndex", 5, 4, { latitude: 91 }),
    validInput("uvIndex", 5, 4, { longitude: -181 }),
    validInput("uvIndex", 5, 4, { latitude: Number.NaN }),
  ];
  // verify each daylight or location gate
  for (const input of invalid) {
    assert.equal(createLocalForecastBias(input), null);
  }

  assert.ok(createLocalForecastBias(validInput("uvIndex", 5, 4)));
});

// ignore corrupted serialized biases rather than projecting unsafe values
test("local forecast projection validates the complete bias contract", () => {
  const humidity = biasFor("relativeHumidityPercent", 70, 40);
  const malformed = [
    { ...humidity, contractVersion: "local-forecast-bias-experiment/v0" },
    { ...humidity, metric: "unsupportedMetric" },
    { ...humidity, adjustmentType: "multiplicative" },
    { ...humidity, adjustmentValue: 21 },
    { ...humidity, adjustmentValue: 19 },
    { ...humidity, observedValue: 101 },
    { ...humidity, regionalValue: -1 },
    { ...humidity, observationRecordId: "" },
    { ...humidity, regionalSourceId: " " },
    { ...humidity, expiresAt: "2026-06-22T20:00:00.001Z" },
    { ...humidity, evaluatedAt: "2026-06-21T19:59:59.999Z" },
    { ...humidity, evaluatedAt: "2026-06-22T20:00:00.000Z" },
    { ...humidity, regionalValidAt: "2026-06-21T20:00:00" },
    { ...humidity, regionalValidAt: "2026-06-21T21:00:00.001Z" },
    { ...humidity, regionalValidAt: "2026-06-21T18:59:59.999Z" },
  ];
  // preserve the raw forecast for every malformed contract
  for (const bias of malformed) {
    assert.equal(projectLocalForecastBias(50, observedAt, bias), 50);
  }

  const uv = biasFor("uvIndex", 12, 6);
  assert.equal(projectLocalForecastBias(10, observedAt, { ...uv, regionalValue: 0 }), 10);
  assert.equal(projectLocalForecastBias(10, observedAt, { ...uv, adjustmentValue: 1.49 }), 10);
});
