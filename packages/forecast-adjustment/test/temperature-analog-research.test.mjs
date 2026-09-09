import assert from "node:assert/strict";
import test from "node:test";

import {
  createTemperatureAnalogPredictionAudit,
  TEMPERATURE_ANALOG_RESEARCH_POLICY,
} from "../dist/temperature-analog-research.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// create one complete pure analog event
function analogEvent(input = {}) {
  const validAt = input.validAt ?? "2025-04-20T18:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 6;
  const referenceAt = input.referenceAt ?? new Date(
    Date.parse(validAt) - targetLeadHours * HOUR,
  ).toISOString();

  return {
    actual: input.actual ?? 10,
    baselineEligible: input.baselineEligible ?? true,
    key: input.key ?? `${validAt}|${targetLeadHours}`,
    priorPrediction: input.priorPrediction ?? 9,
    rawForecast: input.rawForecast ?? 8,
    rawRelativeHumidityPercent: Object.hasOwn(
      input,
      "rawRelativeHumidityPercent",
    )
      ? input.rawRelativeHumidityPercent
      : 60,
    rawWindSpeedMps: Object.hasOwn(input, "rawWindSpeedMps")
      ? input.rawWindSpeedMps
      : 3,
    referenceAt,
    targetLeadHours,
    validAt,
  };
}

// create one prior-day analog source
function priorDaySource(target, daysAgo, input = {}) {
  const validAt = new Date(Date.parse(target.validAt) - daysAgo * DAY).toISOString();
  const targetLeadHours = input.targetLeadHours ?? target.targetLeadHours;
  const priorPrediction = input.priorPrediction ?? 20;
  const residual = input.residual ?? 0;

  return analogEvent({
    ...input,
    actual: input.actual ?? priorPrediction + residual,
    key: input.key ?? `source-${daysAgo}-${targetLeadHours}`,
    priorPrediction,
    rawForecast: input.rawForecast ?? target.rawForecast,
    rawRelativeHumidityPercent: Object.hasOwn(
      input,
      "rawRelativeHumidityPercent",
    )
      ? input.rawRelativeHumidityPercent
      : target.rawRelativeHumidityPercent,
    rawWindSpeedMps: Object.hasOwn(input, "rawWindSpeedMps")
      ? input.rawWindSpeedMps
      : target.rawWindSpeedMps,
    targetLeadHours,
    validAt,
  });
}

// create the frozen twelve-hour support
function twelveSources(target, transform = () => ({})) {
  return Array.from(
    { length: TEMPERATURE_ANALOG_RESEARCH_POLICY.requiredUniqueSourceHours },
    // retain one distinct prior valid hour per day
    (_, index) => priorDaySource(target, index + 1, transform(index + 1)),
  );
}

// locate one canonical target record
function auditRecord(events, key) {
  const record = createTemperatureAnalogPredictionAudit(events).find(
    // match one requested identity
    (candidate) => candidate.key === key,
  );

  // require the requested record
  if (record === undefined) {
    throw new Error(`missing analog audit record ${key}`);
  }

  return record;
}

// reproduce the even median and both correction caps
test("computes the twelve-source residual median and cumulative caps", () => {
  const target = analogEvent({
    actual: 69,
    key: "target",
    priorPrediction: 69,
    rawForecast: 68,
  });
  const sources = twelveSources(
    target,
    // assign the ordered one-through-twelve residuals
    (residual) => ({ residual }),
  );
  const record = auditRecord([...sources, target], target.key);

  assert.equal(record.fallbackReason, null);
  assert.equal(record.medianResidual, 6.5);
  assert.equal(record.preCapTotalCorrection, 7.5);
  assert.equal(record.totalCorrection, 5);
  assert.equal(record.analogPrediction, 70);
  assert.deepEqual(
    record.selectedSources.map(
      // retain one-based distance ranks
      (source) => source.rank,
    ),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
});

// enforce weather distance and preserve auditable terms
test("filters the inclusive weather radius with signed distance evidence", () => {
  const target = analogEvent({ key: "target", rawForecast: 10 });
  const accepted = priorDaySource(target, 1, {
    key: "accepted",
    rawForecast: 20,
  });
  const rejected = priorDaySource(target, 2, {
    key: "rejected",
    rawForecast: 20.01,
  });
  const record = auditRecord([target, accepted, rejected], target.key);
  const selected = record.selectedSources[0];

  assert.equal(record.candidateHourCount, 2);
  assert.equal(record.availableAnalogHourCount, 1);
  assert.equal(record.fallbackReason, "fewer_than_12_analogs");
  assert.equal(selected?.key, accepted.key);
  assert.equal(selected?.featureDifferences.temperatureC, 10);
  assert.equal(selected?.scaledSquaredDifferences.temperatureC, 4);
  assert.equal(selected?.distance, 4);
});

// enforce maturity and inclusive elapsed lookback boundaries
test("honors the one-hour maturity and 336-hour lookback edges", () => {
  const target = analogEvent({
    key: "target",
    targetLeadHours: 1,
    validAt: "2025-04-20T13:00:00.000Z",
  });
  const targetReference = Date.parse(target.referenceAt);
  const matureBoundary = analogEvent({
    key: "mature-boundary",
    targetLeadHours: 1,
    validAt: new Date(targetReference - HOUR).toISOString(),
  });
  const lookbackBoundary = analogEvent({
    key: "lookback-boundary",
    targetLeadHours: 1,
    validAt: new Date(targetReference - 336 * HOUR).toISOString(),
  });
  const outsideLookback = analogEvent({
    key: "outside-lookback",
    targetLeadHours: 1,
    validAt: new Date(targetReference - 336 * HOUR - 1).toISOString(),
  });
  const record = auditRecord([
    target,
    matureBoundary,
    lookbackBoundary,
    outsideLookback,
  ], target.key);

  assert.equal(record.candidateHourCount, 2);
  assert.deepEqual(
    record.selectedSources.map(
      // retain both inclusive boundary identities
      (source) => source.key,
    ).sort(),
    ["lookback-boundary", "mature-boundary"],
  );
  assert.equal(
    record.selectedSources.find(
      // locate the maturity boundary
      (source) => source.key === "mature-boundary",
    )?.availableAt,
    target.referenceAt,
  );
});

// use circular local hours across midnight
test("matches circular wall-clock hours across midnight", () => {
  const target = analogEvent({
    key: "target",
    validAt: "2025-01-20T07:00:00.000Z",
  });
  const source = analogEvent({
    key: "source",
    targetLeadHours: 6,
    validAt: "2025-01-19T09:00:00.000Z",
  });
  const record = auditRecord([source, target], target.key);

  assert.equal(record.localHour, 23);
  assert.equal(record.selectedSources[0]?.localHour, 1);
  assert.equal(record.selectedSources[0]?.featureDifferences.localHour, 2);
});

// retain distinct UTC source hours through a DST fold
test("keeps both repeated local hours during the DST fold", () => {
  const target = analogEvent({
    key: "target",
    targetLeadHours: 6,
    validAt: "2025-11-03T09:00:00.000Z",
  });
  const firstFold = analogEvent({
    key: "fold-a",
    targetLeadHours: 6,
    validAt: "2025-11-02T08:00:00.000Z",
  });
  const secondFold = analogEvent({
    key: "fold-b",
    targetLeadHours: 6,
    validAt: "2025-11-02T09:00:00.000Z",
  });
  const record = auditRecord([firstFold, secondFold, target], target.key);

  assert.equal(record.localHour, 1);
  assert.equal(record.candidateHourCount, 2);
  assert.deepEqual(
    record.selectedSources.map(
      // retain both distinct UTC hours
      (source) => [source.validAt, source.localHour]),
    [
      ["2025-11-02T09:00:00.000Z", 1],
      ["2025-11-02T08:00:00.000Z", 1],
    ],
  );
});

// enforce exact lead-band and twelve-hour boundaries
test("supports leads 6, 7, and 12 but preserves leads 13, 48, and 49", () => {
  // test every required lead edge independently
  for (const lead of [6, 7, 12]) {
    const target = analogEvent({ key: `target-${lead}`, targetLeadHours: lead });
    const record = auditRecord(
      [...twelveSources(target), target],
      target.key,
    );

    assert.equal(record.fallbackReason, null);
  }

  // test every later horizon independently
  for (const lead of [13, 48, 49]) {
    const target = analogEvent({
      key: `target-${lead}`,
      priorPrediction: 123,
      targetLeadHours: lead,
    });
    const record = auditRecord([target], target.key);

    assert.equal(record.fallbackReason, "outside_first12");
    assert.equal(record.analogPrediction, 123);
    assert.deepEqual(record.selectedSources, []);
  }
});

// choose one vintage by lead then issue time then key
test("deduplicates each source hour before applying distance", () => {
  const target = analogEvent({ key: "target", targetLeadHours: 5 });
  const commonValidAt = new Date(Date.parse(target.validAt) - DAY).toISOString();
  const fartherLead = analogEvent({
    actual: 10,
    key: "farther-lead",
    rawForecast: target.rawForecast,
    targetLeadHours: 3,
    validAt: commonValidAt,
  });
  const closerBadWeather = analogEvent({
    actual: 10,
    key: "closer-bad-weather",
    rawForecast: target.rawForecast + 20,
    targetLeadHours: 5,
    validAt: commonValidAt,
  });
  const tieValidAt = new Date(Date.parse(target.validAt) - 2 * DAY).toISOString();
  const tieA = analogEvent({
    actual: 10,
    key: "tie-a",
    targetLeadHours: 5,
    validAt: tieValidAt,
  });
  const tieZ = analogEvent({
    actual: 10,
    key: "tie-z",
    targetLeadHours: 5,
    validAt: tieValidAt,
  });
  const issueTieValidAt = new Date(
    Date.parse(target.validAt) - 3 * DAY,
  ).toISOString();
  const earlierIssue = analogEvent({
    actual: 10,
    key: "earlier-issue",
    targetLeadHours: 6,
    validAt: issueTieValidAt,
  });
  const laterIssue = analogEvent({
    actual: 10,
    key: "later-issue",
    targetLeadHours: 4,
    validAt: issueTieValidAt,
  });
  const record = auditRecord([
    target,
    fartherLead,
    closerBadWeather,
    tieA,
    tieZ,
    earlierIssue,
    laterIssue,
  ], target.key);

  assert.equal(record.candidateHourCount, 3);
  assert.equal(record.availableAnalogHourCount, 2);
  assert.deepEqual(
    record.selectedSources.map(
      // retain the later-issue and greatest-key ties
      (source) => source.key,
    ),
    ["tie-z", "later-issue"],
  );
});

// prevent unavailable future labels and arrival order from changing predictions
test("isolates future labels and returns canonical deterministic records", () => {
  const target = analogEvent({ key: "m-target" });
  const sources = twelveSources(target);
  const future = analogEvent({
    actual: -50,
    key: "z-future",
    targetLeadHours: 1,
    validAt: "2025-04-21T13:00:00.000Z",
  });
  const original = createTemperatureAnalogPredictionAudit([
    future,
    target,
    ...sources,
  ]);
  const changed = createTemperatureAnalogPredictionAudit([
    ...sources,
    { ...future, actual: 50 },
    target,
  ].reverse());
  const originalTarget = original.find(
    // locate the original target
    (record) => record.key === target.key,
  );
  const changedTarget = changed.find(
    // locate the changed target
    (record) => record.key === target.key,
  );

  assert.equal(originalTarget?.analogPrediction, changedTarget?.analogPrediction);
  assert.deepEqual(
    original.map(
      // retain canonical key ordering
      (record) => record.key,
    ),
    [...original].map(
      // retain keys for independent sorting
      (record) => record.key,
    ).sort(),
  );
});

// preserve exact prior predictions for every fallback class
test("does not clip fallback predictions outside physical bounds", () => {
  const targets = [
    analogEvent({ key: "later", priorPrediction: 200, targetLeadHours: 13 }),
    analogEvent({
      baselineEligible: false,
      key: "ineligible",
      priorPrediction: -200,
    }),
    analogEvent({
      key: "missing",
      priorPrediction: 200,
      rawRelativeHumidityPercent: null,
    }),
    analogEvent({ key: "unsupported", priorPrediction: -200 }),
  ];
  const records = createTemperatureAnalogPredictionAudit(targets);

  assert.deepEqual(
    records.map(
      // retain exact fallback reason and prediction pairs
      (record) => [record.fallbackReason, record.analogPrediction]),
    [
      ["baseline_ineligible", -200],
      ["outside_first12", 200],
      ["missing_target_weather", 200],
      ["fewer_than_12_analogs", -200],
    ],
  );
  assert.ok(records.every(
    // require unsupported correction fields to remain empty
    (record) => record.medianResidual === null &&
      record.preCapTotalCorrection === null &&
      record.totalCorrection === null,
  ));
});

// reject malformed numeric and shared-label material
test("fails closed on nonfinite weather and inconsistent actuals", () => {
  assert.throws(
    () => createTemperatureAnalogPredictionAudit([
      analogEvent({ key: "nan", rawWindSpeedMps: Number.NaN }),
    ]),
    /rawWindSpeedMps must be finite or null/u,
  );

  const sharedValidAt = "2025-04-19T18:00:00.000Z";
  assert.throws(
    () => createTemperatureAnalogPredictionAudit([
      analogEvent({ actual: 10, key: "a", validAt: sharedValidAt }),
      analogEvent({ actual: 11, key: "b", validAt: sharedValidAt }),
    ]),
    /conflicting actual values/u,
  );
});

// allow ineligible sources while gating ineligible targets
test("uses baseline-ineligible source residuals", () => {
  const target = analogEvent({ key: "target" });
  const sources = twelveSources(
    target,
    // mark every historical source ineligible
    () => ({ baselineEligible: false, residual: 1 }),
  );
  const record = auditRecord([...sources, target], target.key);

  assert.equal(record.fallbackReason, null);
  assert.equal(record.medianResidual, 1);
  assert.ok(record.selectedSources.every(
    // confirm the source eligibility flag is ignored
    (source) => source.baselineEligible === false,
  ));
});

// freeze the full public return graph
test("returns a deeply immutable audit array", () => {
  const target = analogEvent({ key: "target" });
  const audit = createTemperatureAnalogPredictionAudit([
    ...twelveSources(target),
    target,
  ]);
  const record = audit.find(
    // locate the supported target
    (candidate) => candidate.key === target.key,
  );
  const source = record?.selectedSources[0];

  assert.ok(Object.isFrozen(audit));
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record?.selectedSources));
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(source?.featureDifferences));
  assert.ok(Object.isFrozen(source?.scaledSquaredDifferences));
  assert.ok(Object.isFrozen(TEMPERATURE_ANALOG_RESEARCH_POLICY));
  assert.ok(Object.isFrozen(TEMPERATURE_ANALOG_RESEARCH_POLICY.distanceScales));
  assert.ok(Object.isFrozen(TEMPERATURE_ANALOG_RESEARCH_POLICY.sourceLeadBands));
  assert.throws(
    // reject top-level mutation
    () => audit.push(record),
    TypeError,
  );
  assert.throws(
    // reject nested source mutation
    () => {
      source.featureDifferences.temperatureC = 999;
    },
    TypeError,
  );
});
