import assert from "node:assert/strict";
import test from "node:test";

import {
  createTemperatureNowcastPredictionAudit,
} from "../dist/temperature-nowcast-research.js";

const HOUR = 3_600_000;

// create one complete pure nowcast event
function nowcastEvent(input = {}) {
  const validAt = input.validAt ?? "2025-03-10T18:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 6;
  const referenceAt = input.referenceAt ?? new Date(
    Date.parse(validAt) - targetLeadHours * HOUR,
  ).toISOString();

  return {
    actual: input.actual ?? 10,
    baselineEligible: input.baselineEligible ?? true,
    daypart: input.daypart ?? "morning",
    humidityBin: input.humidityBin ?? "[50,80)",
    key: input.key ?? `${validAt}|${targetLeadHours}`,
    leadBand: input.leadBand ?? "0_24_hours",
    localDate: input.localDate ?? "2025-03-10",
    priorPrediction: input.priorPrediction ?? 9,
    rawForecast: input.rawForecast ?? 8,
    rawRelativeHumidityPercent: Object.hasOwn(input, "rawRelativeHumidityPercent")
      ? input.rawRelativeHumidityPercent
      : 60,
    rawWindSpeedMps: Object.hasOwn(input, "rawWindSpeedMps")
      ? input.rawWindSpeedMps
      : 3,
    referenceAt,
    season: input.season ?? "spring",
    sixHourBucket: input.sixHourBucket ?? "001-006",
    targetLeadHours,
    temperatureBin: input.temperatureBin ?? 1,
    validAt,
    windSpeedBin: input.windSpeedBin ?? "[2,5)",
  };
}

// locate one private target record
function auditRecord(events, key) {
  const record = createTemperatureNowcastPredictionAudit(events).records.find(
    // match one canonical target identity
    (candidate) => candidate.key === key,
  );

  // require the requested audit record
  if (record === undefined) {
    throw new Error(`missing audit record ${key}`);
  }

  return record;
}

// create one mature source at a chosen valid hour
function sourceEvent(validHour, input = {}) {
  const validAt = `2025-03-10T${String(validHour).padStart(2, "0")}:00:00.000Z`;
  const targetLeadHours = input.targetLeadHours ?? 1;

  return nowcastEvent({
    ...input,
    key: input.key ?? `${validAt}|${targetLeadHours}`,
    referenceAt: input.referenceAt ?? new Date(
      Date.parse(validAt) - targetLeadHours * HOUR,
    ).toISOString(),
    targetLeadHours,
    validAt,
  });
}

// choose one latest vintage per distinct source hour
test("selects distinct source hours by latest vintage and greatest-key tie", () => {
  const target = nowcastEvent({ key: "target" });
  const events = [
    sourceEvent(11, {
      key: "vintage-old",
      referenceAt: "2025-03-10T08:00:00.000Z",
      targetLeadHours: 3,
    }),
    sourceEvent(11, {
      key: "vintage-tie-a",
      referenceAt: "2025-03-10T09:00:00.000Z",
      targetLeadHours: 2,
    }),
    sourceEvent(11, {
      key: "vintage-tie-z",
      referenceAt: "2025-03-10T09:00:00.000Z",
      targetLeadHours: 2,
    }),
    sourceEvent(10),
    sourceEvent(9),
    sourceEvent(8),
    target,
  ];
  const record = auditRecord(events, target.key);

  assert.deepEqual(
    record.selectedSources.map(
      // retain the selected deterministic identities
      (source) => source.key,
    ),
    ["vintage-tie-z", "2025-03-10T10:00:00.000Z|1", "2025-03-10T09:00:00.000Z|1"],
  );
});

// reject contradictory measurements for one source hour
test("fails closed on conflicting source actual values", () => {
  const events = [
    sourceEvent(11, { actual: 10, key: "source-a" }),
    sourceEvent(11, { actual: 11, key: "source-b", targetLeadHours: 2 }),
    nowcastEvent({ key: "target" }),
  ];

  assert.throws(
    () => createTemperatureNowcastPredictionAudit(events),
    /conflicting actual values/u,
  );
});

// reject labels that can bypass horizon gates
test("requires target leads to match the elapsed timestamp horizon", () => {
  assert.throws(
    // reject a mislabeled source horizon
    () => createTemperatureNowcastPredictionAudit([
      sourceEvent(11, {
        key: "source-labeled-six",
        referenceAt: "2025-03-10T04:00:00.000Z",
        targetLeadHours: 6,
      }),
    ]),
    /targetLeadHours must match/u,
  );
  assert.throws(
    // reject a mislabeled target horizon
    () => createTemperatureNowcastPredictionAudit([
      nowcastEvent({
        key: "target-labeled-twelve",
        referenceAt: "2025-03-10T05:00:00.000Z",
        targetLeadHours: 12,
      }),
    ]),
    /targetLeadHours must match/u,
  );
});

// enforce strict vintage order and inclusive maturity and lookback edges
test("honors strict reference order and inclusive causal time boundaries", () => {
  const target = nowcastEvent({ key: "target" });
  const events = [
    sourceEvent(11),
    sourceEvent(10),
    sourceEvent(6),
    sourceEvent(13, {
      key: "equal-target-reference",
      referenceAt: target.referenceAt,
    }),
    sourceEvent(5),
    target,
  ];
  const record = auditRecord(events, target.key);

  assert.deepEqual(
    record.selectedSources.map(
      // retain all included boundary hours
      (source) => [source.validAt, source.availableAt]),
    [
      ["2025-03-10T11:00:00.000Z", "2025-03-10T12:00:00.000Z"],
      ["2025-03-10T10:00:00.000Z", "2025-03-10T11:00:00.000Z"],
      ["2025-03-10T06:00:00.000Z", "2025-03-10T07:00:00.000Z"],
    ],
  );
  assert.equal(record.fallbackReason, null);
});

// require three distinct source hours before adjustment
test("falls back until exactly three unique source hours are available", () => {
  const target = nowcastEvent({ key: "target", priorPrediction: 7 });
  const twoSources = [sourceEvent(11), sourceEvent(10), target];
  const cold = auditRecord(twoSources, target.key);
  const supported = auditRecord(
    [sourceEvent(11), sourceEvent(10), sourceEvent(9), target],
    target.key,
  );

  assert.equal(cold.fallbackReason, "insufficient_unique_source_hours");
  assert.equal(cold.nearNowcastPrediction, target.priorPrediction);
  assert.equal(supported.fallbackReason, null);
  assert.equal(supported.selectedSources.length, 3);
});

// reproduce the median, decay, correction cap, and physical cap
test("computes fixed median decay and caps with hand arithmetic", () => {
  const target = nowcastEvent({
    key: "target",
    rawForecast: 68,
    validAt: "2025-03-10T18:00:00.000Z",
  });
  const record = auditRecord([
    sourceEvent(11, { actual: 20, rawForecast: 8 }),
    sourceEvent(10, { actual: 18, rawForecast: 8 }),
    sourceEvent(9, { actual: 22, rawForecast: 8 }),
    target,
  ], target.key);

  assert.equal(record.medianBias, 12);
  assert.equal(record.latestSourceAgeToTargetHours, 7);
  assert.equal(record.decay, 2 ** (-7 / 6));
  assert.equal(record.nowcastCorrection, 5);
  assert.equal(record.nearNowcastPrediction, 70);
});

// permit ineligible sources while protecting ineligible targets
test("uses ineligible source errors but preserves ineligible targets", () => {
  const eligibleTarget = nowcastEvent({ key: "eligible-target" });
  const ineligibleTarget = nowcastEvent({
    baselineEligible: false,
    key: "ineligible-target",
    priorPrediction: 6,
    targetLeadHours: 7,
    validAt: "2025-03-10T19:00:00.000Z",
  });
  const sources = [
    sourceEvent(11, { baselineEligible: false }),
    sourceEvent(10, { baselineEligible: false }),
    sourceEvent(9, { baselineEligible: false }),
  ];
  const audit = createTemperatureNowcastPredictionAudit([
    ...sources,
    eligibleTarget,
    ineligibleTarget,
  ]).records;
  const eligibleRecord = audit.find(
    // locate the eligible target
    (record) => record.key === eligibleTarget.key,
  );
  const ineligibleRecord = audit.find(
    // locate the ineligible target
    (record) => record.key === ineligibleTarget.key,
  );

  assert.equal(eligibleRecord?.fallbackReason, null);
  assert.ok(eligibleRecord?.selectedSources.every(
    // confirm each selected ineligible source remains admissible
    (source) => sources.some(
      // match one retained source identity
      (candidate) => candidate.key === source.key,
    ),
  ));
  assert.equal(ineligibleRecord?.fallbackReason, "baseline_ineligible");
  assert.equal(ineligibleRecord?.nearNowcastPrediction, 6);
  assert.deepEqual(ineligibleRecord?.selectedSources, []);
});

// remove input-order dependence from records and predictions
test("returns deterministic audits for unordered inputs", () => {
  const events = [
    sourceEvent(11),
    sourceEvent(10),
    sourceEvent(9),
    nowcastEvent({ key: "target" }),
  ];
  const original = createTemperatureNowcastPredictionAudit(events);
  const reversed = createTemperatureNowcastPredictionAudit([...events].reverse());

  assert.deepEqual(original.records, reversed.records);
  assert.deepEqual([...original.predictionByKey], [...reversed.predictionByKey]);
});

// preserve exact ordering for canonically equivalent unicode keys
test("orders unicode keys deterministically without locale collation", () => {
  const composedKey = "é";
  const decomposedKey = "e\u0301";
  const target = nowcastEvent({ key: "target" });
  const events = [
    sourceEvent(11, { key: composedKey, rawForecast: 2 }),
    sourceEvent(11, { key: decomposedKey, rawForecast: 9 }),
    sourceEvent(10, { rawForecast: 7 }),
    sourceEvent(9, { rawForecast: 2 }),
    target,
  ];
  const original = createTemperatureNowcastPredictionAudit(events);
  const reversed = createTemperatureNowcastPredictionAudit([...events].reverse());
  const targetRecord = original.records.find(
    // locate the audited target
    (record) => record.key === target.key,
  );

  assert.deepEqual(original.records, reversed.records);
  assert.deepEqual([...original.predictionByKey], [...reversed.predictionByKey]);
  assert.deepEqual(
    targetRecord?.selectedSources.map(
      // retain deterministic source identities
      (source) => source.key,
    ),
    [composedKey, "2025-03-10T10:00:00.000Z|1", "2025-03-10T09:00:00.000Z|1"],
  );
  assert.deepEqual(
    original.records.slice(-2).map(
      // expose exact audit ordering
      (record) => record.key,
    ),
    ["target", composedKey],
  );
});
