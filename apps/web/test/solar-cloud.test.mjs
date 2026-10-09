import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSkyRadiation,
  createSolarCloudBias,
  projectSolarCloudCover,
} from "../dist/solar-cloud.js";

const latitude = 47.950429954185445;
const longitude = -122.42797012608193;
const observedAt = "2026-06-21T20:00:00.000Z";
const evaluatedAt = "2026-06-21T20:02:00.000Z";

// compare one deterministic floating-point result
function assertClose(actual, expected, tolerance = 1e-9) {
  assert.equal(Math.abs(actual - expected) <= tolerance, true, `${actual} != ${expected}`);
}

// create one complete source sample
function sample(value, overrides = {}) {
  return {
    freshnessStatus: "fresh",
    receivedAt: "2026-06-21T20:01:00.000Z",
    recordId: "ws90-record",
    sourceId: "ws90-source",
    validAt: observedAt,
    value,
    ...overrides,
  };
}

// create one valid paired estimator input
function validInput(overrides = {}) {
  return {
    latitude,
    longitude,
    now: evaluatedAt,
    regional: sample(20, {
      receivedAt: "2026-06-21T19:56:00.000Z",
      recordId: "regional-record",
      sourceId: "regional-source",
      validAt: "2026-06-21T19:55:00.000Z",
    }),
    ws90: sample(100),
    ...overrides,
  };
}

// create one coherent projection contract
function projectionBias(biasPercentPoints = 80, overrides = {}) {
  return {
    biasPercentPoints,
    clearSkyRadiationWm2: 900,
    contractVersion: "solar-cloud-experiment/v1",
    estimatedCloudCoverPercent: 100,
    evaluatedAt: observedAt,
    expiresAt: "2026-06-22T20:00:00.000Z",
    observationRecordId: "ws90-record",
    observationSourceId: "ws90-source",
    observedAt,
    observedRadiationWm2: 100,
    rawCloudCoverPercent: 20,
    regionalRecordId: "regional-record",
    regionalSourceId: "regional-source",
    regionalValidAt: observedAt,
    solarElevationDegrees: 65,
    ...overrides,
  };
}

// lock NOAA and Haurwitz outputs across seasons leap years and locations
test("clear-sky radiation matches independent solar-position references", () => {
  const references = [
    [0, 0, "2024-03-20T12:00:00Z", 88.1714062162, 1034.5338234291],
    [51.4779, 0, "2024-06-20T12:00:00Z", 61.9583166022, 906.4369883800],
    [40.7128, -74.006, "2024-06-20T16:58:00Z", 72.7256623733, 985.6522493131],
    [-33.8688, 151.2093, "2024-12-21T02:00:00Z", 79.4662624514, 1016.6193994027],
    [latitude, longitude, "2024-02-29T20:15:00Z", 34.4873305402, 560.1928148527],
  ];

  // verify every fixed external reference
  for (const [caseLatitude, caseLongitude, at, elevation, irradiance] of references) {
    const result = clearSkyRadiation(caseLatitude, caseLongitude, at);
    assert.ok(result);
    assertClose(result.solarElevationDegrees, elevation, 1e-8);
    assertClose(result.irradianceWm2, irradiance, 1e-8);
  }

  const offset = clearSkyRadiation(latitude, longitude, "2024-02-29T12:15:00-08:00");
  const utc = clearSkyRadiation(latitude, longitude, "2024-02-29T20:15:00Z");
  assert.deepEqual(offset, utc);
  const night = clearSkyRadiation(latitude, longitude, "2026-06-21T05:00:00Z");
  assert.ok(night);
  assert.equal(night.irradianceWm2, 0);
  assert.equal(night.solarElevationDegrees < 0, true);

  // reject ambiguous clocks invalid calendars and impossible coordinates
  for (const input of [
    [latitude, longitude, "2026-06-21T20:00:00"],
    [latitude, longitude, "2026-02-30T20:00:00Z"],
    [91, longitude, observedAt],
    [latitude, -181, observedAt],
    [Number.NaN, longitude, observedAt],
  ]) {
    assert.equal(clearSkyRadiation(...input), null);
  }
});

// derive strong upward downward and near-clear experimental biases
test("solar cloud bias uses bounded attenuation without mutating source readings", () => {
  const original = validInput();
  Object.freeze(original.ws90);
  Object.freeze(original.regional);
  Object.freeze(original);
  const upward = createSolarCloudBias(original);
  assert.ok(upward);
  assert.equal(upward.contractVersion, "solar-cloud-experiment/v1");
  assert.equal(upward.observedAt, observedAt);
  assert.equal(upward.evaluatedAt, evaluatedAt);
  assert.equal(upward.expiresAt, "2026-06-22T20:00:00.000Z");
  assert.equal(upward.observationRecordId, "ws90-record");
  assert.equal(upward.observationSourceId, "ws90-source");
  assert.equal(upward.regionalRecordId, "regional-record");
  assert.equal(upward.regionalSourceId, "regional-source");
  assert.equal(upward.regionalValidAt, "2026-06-21T19:55:00.000Z");
  assert.equal(upward.observedRadiationWm2, 100);
  assert.equal(upward.rawCloudCoverPercent, 20);
  assert.equal(upward.estimatedCloudCoverPercent, 100);
  assert.equal(upward.biasPercentPoints, 80);
  assertClose(upward.solarElevationDegrees, 65.3782759443, 1e-8);
  assertClose(upward.clearSkyRadiationWm2, 935.4433279636, 1e-8);
  assertClose(projectSolarCloudCover(20, evaluatedAt, upward), 99.8888888889, 1e-8);

  const clearSky = clearSkyRadiation(latitude, longitude, observedAt);
  assert.ok(clearSky);
  const nearClearRadiation = 0.85 * clearSky.irradianceWm2;
  const downward = createSolarCloudBias(validInput({
    regional: sample(100, {
      receivedAt: "2026-06-21T19:56:00.000Z",
      recordId: "regional-record",
      sourceId: "regional-source",
      validAt: "2026-06-21T19:55:00.000Z",
    }),
    ws90: sample(nearClearRadiation),
  }));
  assert.ok(downward);
  assertClose(downward.estimatedCloudCoverPercent, 0);
  assert.equal(downward.biasPercentPoints, -80);

  const nearClear = createSolarCloudBias(validInput({
    regional: sample(10, {
      receivedAt: "2026-06-21T19:56:00.000Z",
      recordId: "regional-record",
      sourceId: "regional-source",
      validAt: "2026-06-21T19:55:00.000Z",
    }),
    ws90: sample(nearClearRadiation),
  }));
  assert.ok(nearClear);
  assertClose(nearClear.estimatedCloudCoverPercent, 0);
  assert.equal(nearClear.biasPercentPoints, -10);

  const repeated = createSolarCloudBias(validInput({ now: "2026-06-21T20:05:00.000Z" }));
  assert.ok(repeated);
  assert.equal(repeated.expiresAt, upward.expiresAt);
  assert.equal(createSolarCloudBias(validInput({ now: "2026-06-21T20:06:00.000Z" })), null);
});

// fail raw for stale causal malformed dark or implausible evidence
test("solar cloud bias rejects unsafe sample and sunlight boundaries", () => {
  const atNight = {
    latitude,
    longitude,
    now: "2026-06-21T05:02:00.000Z",
    regional: sample(20, {
      receivedAt: "2026-06-21T04:56:00.000Z",
      recordId: "regional-record",
      sourceId: "regional-source",
      validAt: "2026-06-21T04:55:00.000Z",
    }),
    ws90: sample(100, {
      receivedAt: "2026-06-21T05:01:00.000Z",
      validAt: "2026-06-21T05:00:00.000Z",
    }),
  };
  const atLowSun = {
    ...atNight,
    now: "2026-06-21T13:52:00.000Z",
    regional: { ...atNight.regional, receivedAt: "2026-06-21T13:46:00.000Z", validAt: "2026-06-21T13:45:00.000Z" },
    ws90: { ...atNight.ws90, receivedAt: "2026-06-21T13:51:00.000Z", validAt: "2026-06-21T13:50:00.000Z" },
  };
  const invalid = [
    { ...validInput(), ws90: null },
    { ...validInput(), regional: null },
    validInput({ now: "2026-06-21T20:02:00" }),
    validInput({ ws90: sample(100, { validAt: "2026-02-30T20:00:00Z" }) }),
    validInput({ ws90: sample(100, { freshnessStatus: "stale" }) }),
    validInput({ regional: { ...validInput().regional, freshnessStatus: "delayed" } }),
    validInput({ ws90: sample(100, { validAt: "2026-06-21T20:03:00.000Z" }) }),
    validInput({ ws90: sample(100, { receivedAt: "2026-06-21T20:03:00.000Z" }) }),
    validInput({ ws90: sample(100, { receivedAt: "2026-06-21T19:59:00.000Z" }) }),
    validInput({ ws90: sample(100, { validAt: "2026-06-21T19:56:59.999Z" }) }),
    validInput({ regional: { ...validInput().regional, validAt: "2026-06-21T19:41:59.999Z" } }),
    validInput({ regional: { ...validInput().regional, receivedAt: "2026-06-21T19:40:00.000Z", validAt: "2026-06-21T19:39:59.999Z" } }),
    validInput({ ws90: sample(null) }),
    validInput({ ws90: sample(5) }),
    validInput({ ws90: sample(2501) }),
    validInput({ ws90: sample(Number.NaN) }),
    validInput({ ws90: sample(1500) }),
    validInput({ regional: { ...validInput().regional, value: null } }),
    validInput({ regional: { ...validInput().regional, value: -0.001 } }),
    validInput({ regional: { ...validInput().regional, value: 100.001 } }),
    validInput({ ws90: sample(100, { recordId: "" }) }),
    validInput({ regional: { ...validInput().regional, sourceId: " " } }),
    atNight,
    atLowSun,
  ];

  // reject every independent fail-raw condition
  for (const input of invalid) {
    assert.equal(createSolarCloudBias(input), null);
  }

  assert.ok(createSolarCloudBias(validInput({
    regional: { ...validInput().regional, value: 0 },
    ws90: sample(5.001),
  })));
  assert.ok(createSolarCloudBias(validInput({ regional: { ...validInput().regional, value: 100 } })));
});

// project the current correction through an exact fixed twenty-four-hour fade
test("solar cloud projection fades forward and preserves raw outside its contract", () => {
  const upward = Object.freeze(projectionBias());
  assert.equal(projectSolarCloudCover(20, observedAt, upward), 100);
  assert.equal(projectSolarCloudCover(20, "2026-06-22T02:00:00.000Z", upward), 80);
  assert.equal(projectSolarCloudCover(20, "2026-06-22T08:00:00.000Z", upward), 60);
  assert.equal(projectSolarCloudCover(20, "2026-06-22T20:00:00.000Z", upward), 20);
  assert.equal(projectSolarCloudCover(20, "2026-06-22T21:00:00.000Z", upward), 20);
  assert.equal(projectSolarCloudCover(20, "2026-06-21T19:59:59.999Z", upward), 20);
  assert.equal(projectSolarCloudCover(95, observedAt, upward), 100);
  assert.equal(projectSolarCloudCover(5, observedAt, projectionBias(-80)), 0);
  assert.equal(projectSolarCloudCover(null, observedAt, upward), null);
  assert.equal(projectSolarCloudCover(-1, observedAt, upward), -1);
  assert.equal(projectSolarCloudCover(101, observedAt, upward), 101);
  assert.equal(Number.isNaN(projectSolarCloudCover(Number.NaN, observedAt, upward)), true);
  assert.equal(projectSolarCloudCover(20, "2026-06-21T20:00:00", upward), 20);
  assert.equal(projectSolarCloudCover(20, observedAt, null), 20);
  assert.equal(projectSolarCloudCover(20, observedAt, projectionBias(81)), 20);
  assert.equal(projectSolarCloudCover(20, observedAt, projectionBias(80, {
    contractVersion: "solar-cloud-experiment/v0",
  })), 20);
  assert.equal(projectSolarCloudCover(20, observedAt, projectionBias(80, {
    expiresAt: "2026-06-22T20:01:00.000Z",
  })), 20);
  assert.equal(projectSolarCloudCover(20, observedAt, projectionBias(80, {
    evaluatedAt: "2026-06-21T19:59:00.000Z",
  })), 20);
});
