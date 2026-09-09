import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  FORECAST_LEAD_BANDS,
  forecastLeadBandFor,
} from "@weather/domain";

import { canonicalSha256 } from "../dist/candidate.js";
import { localCalendarFeaturesFor } from "../dist/calendar.js";
import {
  replayFrozenTemperatureHybrid,
} from "../dist/temperature-frozen-replay.js";
import {
  TEMPERATURE_BOOSTED_FEATURE_NAMES,
} from "../dist/temperature-weather-research.js";

// hash retained native bytes
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// create one exact live event
function replayEvent(input = {}) {
  const validAt = input.validAt ?? "2026-01-10T20:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 12;
  const referenceAt = input.referenceAt ?? new Date(
    Date.parse(validAt) - targetLeadHours * 3_600_000,
  ).toISOString();

  return {
    actual: input.actual ?? 10,
    rawForecast: input.rawForecast ?? 10,
    rawRelativeHumidityPercent: Object.hasOwn(input, "rawRelativeHumidityPercent")
      ? input.rawRelativeHumidityPercent
      : 40,
    rawWindSpeedMps: Object.hasOwn(input, "rawWindSpeedMps")
      ? input.rawWindSpeedMps
      : 3,
    referenceAt,
    targetLeadHours,
    validAt,
  };
}

// create one retained hierarchy root
function rootCoefficient(leadBand, coefficient) {
  return {
    coefficient,
    daypart: null,
    effectiveEventCount: 100,
    leadBand,
    level: 1,
    metric: "temperatureC",
    month: null,
    season: null,
  };
}

// create exact raw-start model cells for supplied events
function staticCells(events, temperatureCoefficient, weatherCoefficient) {
  const temperature = new Map();
  const weather = new Map();

  // build each unique retained lookup cell
  for (const event of events) {
    const calendar = localCalendarFeaturesFor(event.validAt);
    const leadBand = forecastLeadBandFor(event.targetLeadHours);
    const temperatureBin = Math.floor(event.rawForecast / 5);
    const temperatureKey = [
      leadBand,
      calendar.season,
      calendar.daypart,
      temperatureBin,
    ].join("|");

    // retain one temperature cell per key
    if (!temperature.has(temperatureKey)) {
      temperature.set(temperatureKey, {
        coefficient: temperatureCoefficient,
        daypart: calendar.daypart,
        effectiveEventCount: 100,
        key: temperatureKey,
        leadBand,
        path: "raw_start",
        rawCoefficient: temperatureCoefficient,
        season: calendar.season,
        supportLocalDateCount: 20,
        supportUniqueValidHours: 100,
        temperatureBin,
        temperatureMaximumExclusiveC: temperatureBin * 5 + 5,
        temperatureMinimumC: temperatureBin * 5,
      });
    }

    const humidityBin = event.rawRelativeHumidityPercent === null
      ? null
      : event.rawRelativeHumidityPercent < 50
        ? "<50"
        : event.rawRelativeHumidityPercent < 80
          ? "[50,80)"
          : ">=80";
    const windBin = event.rawWindSpeedMps === null
      ? null
      : event.rawWindSpeedMps < 2
        ? "<2"
        : event.rawWindSpeedMps < 5
          ? "[2,5)"
          : ">=5";

    // omit unsupported missing-feature weather cells
    if (humidityBin === null || windBin === null) {
      continue;
    }

    const weatherKey = [
      leadBand,
      calendar.season,
      calendar.daypart,
      humidityBin,
      windBin,
    ].join("|");

    // retain one weather cell per key
    if (!weather.has(weatherKey)) {
      weather.set(weatherKey, {
        coefficient: weatherCoefficient,
        daypart: calendar.daypart,
        effectiveEventCount: 100,
        humidityBin,
        key: weatherKey,
        leadBand,
        path: "raw_start",
        rawCoefficient: weatherCoefficient,
        season: calendar.season,
        supportLocalDateCount: 20,
        supportUniqueValidHours: 100,
        windSpeedBin: windBin,
      });
    }
  }

  return {
    temperature: [...temperature.values()],
    weather: [...weather.values()],
  };
}

// create minimal frozen retained material
function replayMaterial(events, input = {}) {
  const modelJson = input.modelJson ?? "{}";
  const configJson = input.configJson ?? "{}";
  const missingBands = new Set(input.missingBands ?? []);
  const envelopeMinimum = input.envelopeMinimum ?? -100;
  const envelopeMaximum = input.envelopeMaximum ?? 70;

  return {
    baseline: {
      fitted: FORECAST_LEAD_BANDS.map((band) => ({
        coefficients: missingBands.has(band.key)
          ? []
          : [rootCoefficient(band.key, input.baselineCoefficient ?? 0)],
        pair: { leadBand: band.key, metric: "temperatureC" },
        trainingEnvelope: {
          leadBand: band.key,
          maximum: envelopeMaximum,
          metric: "temperatureC",
          minimum: envelopeMinimum,
        },
        trainingEventCount: 100,
      })),
    },
    candidateFeatureNames: [...TEMPERATURE_BOOSTED_FEATURE_NAMES],
    nativeCandidate: {
      configJson,
      configSha256: sha256(configJson),
      featureSchemaSha256: canonicalSha256(TEMPERATURE_BOOSTED_FEATURE_NAMES),
      modelJson,
      modelSha256: sha256(modelJson),
    },
    originalStaticModels: {
      rawStart: staticCells(
        events,
        input.temperatureCoefficient ?? 0,
        input.weatherCoefficient ?? 0,
      ),
    },
  };
}

// select one record by event identity
function recordFor(result, event) {
  return result.records.find(
    // match the canonical event key
    (record) => record.key === `${event.validAt}|${event.targetLeadHours}`,
  );
}

test("replays baseline, static, native, clipping, and exact raw fallbacks", () => {
  const capped = replayEvent({ actual: 69, rawForecast: 68 });
  const missingWeather = replayEvent({
    rawRelativeHumidityPercent: null,
    validAt: "2026-01-11T20:00:00.000Z",
  });
  const outsideEnvelope = replayEvent({
    rawForecast: -50,
    validAt: "2026-01-12T20:00:00.000Z",
  });
  const missingHierarchy = replayEvent({
    targetLeadHours: 30,
    validAt: "2026-01-13T20:00:00.000Z",
  });
  const events = [capped, missingWeather, outsideEnvelope, missingHierarchy];
  const material = replayMaterial(events, {
    baselineCoefficient: 10,
    envelopeMinimum: -20,
    missingBands: ["025-048"],
    temperatureCoefficient: 3,
    weatherCoefficient: 4,
  });
  let capturedRequest;
  const result = replayFrozenTemperatureHybrid(events, material, (request) => {
    capturedRequest = request;
    return {
      predictedResiduals: request.predictionIds.map(
        // exercise both correction caps
        (_id, index) => index === 0 ? 10 : -10,
      ),
      predictionIds: [...request.predictionIds],
    };
  });

  assert.deepEqual(Object.keys(capturedRequest).sort(), [
    "featureNames",
    "modelJson",
    "predictionFeatures",
    "predictionIds",
  ]);
  assert.deepEqual(capturedRequest.predictionIds, [
    `${capped.validAt}|12`,
    `${missingWeather.validAt}|12`,
    `${outsideEnvelope.validAt}|12`,
    `${missingHierarchy.validAt}|30`,
  ]);
  assert.equal(Object.isFrozen(capturedRequest), true);
  assert.equal(Object.isFrozen(capturedRequest.predictionFeatures), true);
  assert.equal(Object.isFrozen(capturedRequest.predictionFeatures[0]), true);
  assert.equal(capturedRequest.predictionFeatures[0].includes(capped.actual), false);
  assert.deepEqual(capturedRequest.predictionFeatures[0].slice(0, 4), [68, 40, 3, 12]);

  assert.deepEqual(recordFor(result, capped), {
    adaptivePrediction: 68,
    baselineEligible: true,
    baselinePrediction: 70,
    boostedPrediction: 70,
    key: `${capped.validAt}|12`,
    originalInput: capped,
    priorPrediction: 68,
    selectedAlpha: 0,
    staticPrediction: 70,
  });
  assert.equal(recordFor(result, missingWeather).baselinePrediction, 15);
  assert.equal(recordFor(result, missingWeather).staticPrediction, 13);
  assert.equal(recordFor(result, missingWeather).boostedPrediction, 5);

  // preserve both inherited raw fallback classes
  for (const event of [outsideEnvelope, missingHierarchy]) {
    const record = recordFor(result, event);
    assert.equal(record.baselineEligible, false);
    assert.equal(record.baselinePrediction, event.rawForecast);
    assert.equal(record.staticPrediction, event.rawForecast);
    assert.equal(record.boostedPrediction, event.rawForecast);
    assert.equal(record.priorPrediction, event.rawForecast);
  }
});

test("predicts wholly ineligible rows and rejects an empty replay before inference", () => {
  const event = replayEvent({ targetLeadHours: 100 });
  const material = replayMaterial([event], { missingBands: ["097-120"] });
  let callCount = 0;
  const result = replayFrozenTemperatureHybrid([event], material, (request) => {
    callCount += 1;
    assert.deepEqual(request.predictionIds, [`${event.validAt}|100`]);
    assert.equal(request.predictionFeatures.length, 1);
    return { predictedResiduals: [4], predictionIds: [...request.predictionIds] };
  });

  assert.equal(callCount, 1);
  assert.equal(result.records[0].priorPrediction, event.rawForecast);
  assert.equal(result.records[0].boostedPrediction, event.rawForecast);
  assert.throws(
    // reject an absent score denominator without invoking native inference
    () => replayFrozenTemperatureHybrid([], material, () => {
      callCount += 1;
      return { predictedResiduals: [], predictionIds: [] };
    }),
    /non-empty array/u,
  );
  assert.equal(callCount, 1);
});

test("calibrates from all leads and preserves the original 48-hour hybrid boundary", () => {
  const events = [];

  // create independent support for both boundary buckets
  for (let day = 0; day < 36; day += 1) {
    const validAt = new Date(Date.UTC(2026, 0, 1 + day, 20)).toISOString();

    // populate both sides of the fixed gate
    for (const targetLeadHours of [48, 49]) {
      events.push(replayEvent({
        actual: 12,
        rawForecast: 10,
        targetLeadHours,
        validAt,
      }));
    }
  }

  const material = replayMaterial(events, { temperatureCoefficient: 2 });
  let nativeCount = 0;
  const result = replayFrozenTemperatureHybrid(events, material, (request) => {
    nativeCount = request.predictionIds.length;
    return {
      predictedResiduals: request.predictionIds.map(
        // make the native branch observably distinct
        () => 4,
      ),
      predictionIds: [...request.predictionIds],
    };
  });
  const final48 = events.at(-2);
  const final49 = events.at(-1);
  const record48 = recordFor(result, final48);
  const record49 = recordFor(result, final49);

  assert.equal(nativeCount, events.length);
  assert.equal(record48.selectedAlpha, 1);
  assert.equal(record49.selectedAlpha, 1);
  assert.equal(record48.adaptivePrediction, 12);
  assert.equal(record49.adaptivePrediction, 12);
  assert.equal(record48.boostedPrediction, 14);
  assert.equal(record49.boostedPrediction, 14);
  assert.equal(record48.priorPrediction, 12);
  assert.equal(record49.priorPrediction, 14);
});

test("is deterministic, temporally isolated from future labels, and deeply immutable", () => {
  const events = Array.from({ length: 35 }, (_unused, day) => {
    const validAt = new Date(Date.UTC(2026, 0, 1 + day, 20)).toISOString();
    return replayEvent({ actual: 12, rawForecast: 10, targetLeadHours: 1, validAt });
  });
  const material = replayMaterial(events, { temperatureCoefficient: 2 });
  const eventSnapshot = structuredClone(events);
  const materialSnapshot = structuredClone(material);
  const predictor = (request) => ({
    predictedResiduals: request.predictionIds.map(
      // return a stable native residual
      () => 3,
    ),
    predictionIds: [...request.predictionIds],
  });
  const original = replayFrozenTemperatureHybrid(events, material, predictor);
  const reversed = replayFrozenTemperatureHybrid([...events].reverse(), material, predictor);
  const changedFuture = events.map(
    // change only the final unavailable outcome
    (event, index) => index === events.length - 1 ? { ...event, actual: 5 } : event,
  );
  const changed = replayFrozenTemperatureHybrid(changedFuture, material, predictor);

  assert.deepEqual(reversed, original);
  assert.deepEqual(changed.records.slice(0, -1), original.records.slice(0, -1));
  assert.deepEqual(changed.causalTrace.slice(0, -1), original.causalTrace.slice(0, -1));
  assert.deepEqual(events, eventSnapshot);
  assert.deepEqual(material, materialSnapshot);
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Object.isFrozen(original.records), true);
  assert.equal(Object.isFrozen(original.records[0]), true);
  assert.equal(Object.isFrozen(original.records[0].originalInput), true);
  assert.equal(Object.isFrozen(original.causalTrace), true);
  assert.equal(Object.isFrozen(original.causalTrace[0]), true);
});

test("rejects malformed events and retained model material", () => {
  const event = replayEvent();
  const material = replayMaterial([event]);
  const predictor = (request) => ({
    predictedResiduals: request.predictionIds.map(
      // return one finite residual per identity
      () => 0,
    ),
    predictionIds: [...request.predictionIds],
  });

  assert.throws(
    // reject duplicate forecast identities
    () => replayFrozenTemperatureHybrid([event, { ...event }], material, predictor),
    /unique/u,
  );
  assert.throws(
    // reject nonfinite outcomes
    () => replayFrozenTemperatureHybrid([{ ...event, actual: Number.NaN }], material, predictor),
    /actual must be finite/u,
  );
  assert.throws(
    // reject invalid nullable predictors
    () => replayFrozenTemperatureHybrid([{ ...event, rawWindSpeedMps: -1 }], material, predictor),
    /rawWindSpeedMps/u,
  );
  assert.throws(
    // reject noncanonical timestamps
    () => replayFrozenTemperatureHybrid([{ ...event, validAt: "2026-01-10 20:00:00" }], material, predictor),
    /validAt must be a canonical UTC instant/u,
  );

  const badCellKey = structuredClone(material);
  badCellKey.originalStaticModels.rawStart.temperature[0].key = "wrong";
  assert.throws(
    // reject malformed static lookup material
    () => replayFrozenTemperatureHybrid([event], badCellKey, predictor),
    /temperature cell key/u,
  );

  const duplicateCell = structuredClone(material);
  duplicateCell.originalStaticModels.rawStart.weather.push(
    structuredClone(duplicateCell.originalStaticModels.rawStart.weather[0]),
  );
  assert.throws(
    // reject duplicate static lookup material
    () => replayFrozenTemperatureHybrid([event], duplicateCell, predictor),
    /weather cell key/u,
  );

  const badCoefficient = structuredClone(material);
  badCoefficient.baseline.fitted[0].coefficients[0].coefficient = Number.NaN;
  assert.throws(
    // reject nonfinite hierarchy material
    () => replayFrozenTemperatureHybrid([event], badCoefficient, predictor),
    /coefficient must be finite/u,
  );

  const badModelHash = structuredClone(material);
  badModelHash.nativeCandidate.modelSha256 = "0".repeat(64);
  assert.throws(
    // reject unbound native payloads
    () => replayFrozenTemperatureHybrid([event], badModelHash, predictor),
    /modelSha256 does not match/u,
  );
});

test("rejects malformed native prediction identities, counts, and values", () => {
  const event = replayEvent();
  const material = replayMaterial([event]);

  assert.throws(
    // reject reordered native identities
    () => replayFrozenTemperatureHybrid([event], material, () => ({
      predictedResiduals: [0],
      predictionIds: ["wrong"],
    })),
    /predictionIds must match/u,
  );
  assert.throws(
    // reject incomplete native results
    () => replayFrozenTemperatureHybrid([event], material, () => ({
      predictedResiduals: [],
      predictionIds: [`${event.validAt}|12`],
    })),
    /finite and complete/u,
  );
  assert.throws(
    // reject nonfinite native residuals
    () => replayFrozenTemperatureHybrid([event], material, () => ({
      predictedResiduals: [Number.POSITIVE_INFINITY],
      predictionIds: [`${event.validAt}|12`],
    })),
    /finite and complete/u,
  );
});
