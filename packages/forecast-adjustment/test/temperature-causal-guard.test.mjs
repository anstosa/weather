import assert from "node:assert/strict";
import test from "node:test";

import {
  createTemperatureCausalGuardAudit,
} from "../dist/temperature-causal-guard.js";

const HOUR = 3_600_000;

// create one exact causal-guard event
function guardEvent(input = {}) {
  const validAt = input.validAt ?? "2026-01-04T18:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 1;
  const referenceAt = input.referenceAt ?? new Date(
    Date.parse(validAt) - targetLeadHours * HOUR,
  ).toISOString();

  return {
    actual: input.actual ?? 10,
    halfStrengthPrediction: input.halfStrengthPrediction ?? 9,
    key: input.key ?? `${validAt}|${targetLeadHours}`,
    rawForecast: input.rawForecast ?? 8,
    referenceAt,
    targetLeadHours,
    validAt,
  };
}

// create same-daypart source hours with fixed errors
function sourceHours(date, utcHours, input = {}) {
  return utcHours.map(
    // create one distinct valid-hour source
    (utcHour) => {
      const validAt = `${date}T${String(utcHour).padStart(2, "0")}:00:00.000Z`;
      const actual = input.actual ?? 10;
      return guardEvent({
        actual,
        halfStrengthPrediction: actual + (input.halfError ?? 0),
        key: `${input.keyPrefix ?? "source"}|${validAt}`,
        rawForecast: actual + (input.rawError ?? 0),
        targetLeadHours: input.targetLeadHours ?? 1,
        validAt,
      });
    },
  );
}

// locate one immutable audit record
function recordFor(events, key) {
  const record = createTemperatureCausalGuardAudit(events).find(
    // match one input identity
    (candidate) => candidate.key === key,
  );

  // require the requested record
  if (record === undefined) {
    throw new Error(`missing guard audit ${key}`);
  }

  return record;
}

// verify both fixed support floors
test("retains half strength below either fixed support floor", () => {
  const target = guardEvent({ halfStrengthPrediction: 7, key: "target" });
  const elevenHours = [
    ...sourceHours("2026-01-01", [14, 15, 16, 17]),
    ...sourceHours("2026-01-02", [14, 15, 16, 17]),
    ...sourceHours("2026-01-03", [14, 15, 16]),
  ];
  const hourShortage = recordFor([...elevenHours, target], target.key);
  const twoDates = [
    ...sourceHours("2026-01-02", [14, 15, 16, 17, 18, 19]),
    ...sourceHours("2026-01-03", [14, 15, 16, 17, 18, 19]),
  ];
  const dateShortage = recordFor([...twoDates, target], target.key);

  assert.equal(hourShortage.supportUniqueValidHours, 11);
  assert.equal(hourShortage.supportDistinctLocalDates, 3);
  assert.equal(hourShortage.action, "half");
  assert.equal(hourShortage.fallbackReason, "insufficient_unique_source_hours");
  assert.equal(hourShortage.guardedPrediction, target.halfStrengthPrediction);
  assert.equal(dateShortage.supportUniqueValidHours, 12);
  assert.equal(dateShortage.supportDistinctLocalDates, 2);
  assert.equal(dateShortage.action, "half");
  assert.equal(dateShortage.fallbackReason, "insufficient_distinct_local_dates");
  assert.equal(dateShortage.guardedPrediction, target.halfStrengthPrediction);
});

// distinguish fixed equal-date weighting
test("uses equal-date rather than event-weighted source error", () => {
  const target = guardEvent({ halfStrengthPrediction: 12, key: "target", rawForecast: 8 });
  const sources = [
    ...sourceHours("2026-01-01", [14, 15, 16, 17, 18, 19], {
      halfError: 10,
      keyPrefix: "heavy-date",
      rawError: 0,
    }),
    ...sourceHours("2026-01-02", [14, 15, 16], {
      halfError: 0,
      keyPrefix: "light-date-a",
      rawError: 9,
    }),
    ...sourceHours("2026-01-03", [14, 15, 16], {
      halfError: 0,
      keyPrefix: "light-date-b",
      rawError: 9,
    }),
  ];
  const record = recordFor([...sources, target], target.key);
  const eventWeightedRaw = sources.reduce(
    // sum source raw errors
    (sum, source) => sum + Math.abs(source.rawForecast - source.actual),
    0,
  ) / sources.length;
  const eventWeightedHalf = sources.reduce(
    // sum source half-strength errors
    (sum, source) => sum + Math.abs(source.halfStrengthPrediction - source.actual),
    0,
  ) / sources.length;

  assert.equal(eventWeightedRaw, 4.5);
  assert.equal(eventWeightedHalf, 5);
  assert.equal(record.rawEqualDateMeanAbsoluteError, 6);
  assert.equal(record.halfStrengthEqualDateMeanAbsoluteError, 10 / 3);
  assert.equal(record.action, "half");
  assert.equal(record.fallbackReason, null);
  assert.equal(record.guardedPrediction, target.halfStrengthPrediction);
});

// verify the fixed raw tie action
test("prefers exact raw when supported source errors tie", () => {
  const target = guardEvent({ halfStrengthPrediction: 12, key: "target", rawForecast: 8 });
  const sources = [
    ...sourceHours("2026-01-01", [14, 15, 16, 17]),
    ...sourceHours("2026-01-02", [14, 15, 16, 17]),
    ...sourceHours("2026-01-03", [14, 15, 16, 17]),
  ].map(
    // give both comparators the same source loss
    (source) => ({ ...source, halfStrengthPrediction: 11, rawForecast: 9 }),
  );
  const record = recordFor([...sources, target], target.key);

  assert.equal(record.rawEqualDateMeanAbsoluteError, 1);
  assert.equal(record.halfStrengthEqualDateMeanAbsoluteError, 1);
  assert.equal(record.action, "raw");
  assert.equal(record.fallbackReason, null);
  assert.equal(record.guardedPrediction, target.rawForecast);
});

// verify every causal time boundary
test("honors strict references and inclusive availability and lookback boundaries", () => {
  const target = guardEvent({
    key: "target",
    validAt: "2026-01-10T18:00:00.000Z",
  });
  const exactAvailable = guardEvent({
    key: "exact-available",
    validAt: "2026-01-10T16:00:00.000Z",
  });
  const afterAvailable = guardEvent({
    key: "after-available",
    validAt: "2026-01-10T17:00:00.000Z",
  });
  const exactLookback = guardEvent({
    key: "exact-lookback",
    validAt: "2026-01-03T17:00:00.000Z",
  });
  const beforeLookback = guardEvent({
    key: "before-lookback",
    validAt: "2026-01-03T16:00:00.000Z",
  });
  const equalReference = guardEvent({
    key: "equal-reference",
    referenceAt: target.referenceAt,
    validAt: target.validAt,
  });
  const otherBand = guardEvent({
    key: "other-band",
    targetLeadHours: 7,
    validAt: "2026-01-10T16:00:00.000Z",
  });
  const otherDaypart = guardEvent({
    key: "other-daypart",
    validAt: "2026-01-10T12:00:00.000Z",
  });
  const record = recordFor([
    exactAvailable,
    afterAvailable,
    exactLookback,
    beforeLookback,
    equalReference,
    otherBand,
    otherDaypart,
    target,
  ], target.key);

  assert.deepEqual(record.selectedSources.map(
    // retain only causally admissible boundary sources
    (source) => source.key,
  ), ["exact-lookback", "exact-available"]);
  assert.equal(record.selectedSources[0].availableAt, "2026-01-03T18:00:00.000Z");
  assert.equal(record.selectedSources[1].availableAt, target.referenceAt);
});

// verify the complete deduplication hierarchy
test("deduplicates source hours by lead distance, latest reference, and greatest key", () => {
  const target = guardEvent({ key: "target", targetLeadHours: 4 });
  const validAtA = "2026-01-01T14:00:00.000Z";
  const validAtB = "2026-01-02T14:00:00.000Z";
  const validAtC = "2026-01-03T14:00:00.000Z";
  const events = [
    guardEvent({ key: "far-newer", targetLeadHours: 3, validAt: validAtA }),
    guardEvent({ key: "closest", targetLeadHours: 4, validAt: validAtA }),
    guardEvent({
      key: "older-reference",
      referenceAt: "2026-01-02T11:00:00.000Z",
      targetLeadHours: 3,
      validAt: validAtB,
    }),
    guardEvent({
      key: "latest-reference-Z",
      referenceAt: "2026-01-02T11:30:00.000Z",
      targetLeadHours: 3,
      validAt: validAtB,
    }),
    guardEvent({
      key: "latest-reference-a",
      referenceAt: "2026-01-02T11:30:00.000Z",
      targetLeadHours: 3,
      validAt: validAtB,
    }),
    guardEvent({ key: "lead-five", targetLeadHours: 5, validAt: validAtC }),
    guardEvent({ key: "lead-three", targetLeadHours: 3, validAt: validAtC }),
    target,
  ];
  const record = recordFor(events, target.key);

  assert.deepEqual(record.selectedSources.map(
    // retain the deterministic winner per source hour
    (source) => source.key,
  ), ["closest", "latest-reference-a", "lead-three"]);
});

// preserve the unguarded later horizon
test("preserves exact half-strength predictions outside the first twelve hours", () => {
  const target = guardEvent({
    halfStrengthPrediction: 123.456,
    key: "target",
    rawForecast: -50,
    targetLeadHours: 13,
  });
  const record = recordFor([target], target.key);

  assert.equal(record.guardedPrediction, target.halfStrengthPrediction);
  assert.equal(record.action, "half");
  assert.equal(record.fallbackReason, "outside_first_12_hours");
  assert.equal(record.supportUniqueValidHours, 0);
  assert.equal(record.supportDistinctLocalDates, 0);
  assert.equal(record.rawEqualDateMeanAbsoluteError, null);
  assert.equal(record.halfStrengthEqualDateMeanAbsoluteError, null);
  assert.deepEqual(record.selectedSources, []);
});

// verify temporal isolation from future labels
test("does not leak unavailable future labels into earlier actions", () => {
  const target = guardEvent({ key: "target" });
  const sources = [
    ...sourceHours("2026-01-01", [14, 15, 16, 17]),
    ...sourceHours("2026-01-02", [14, 15, 16, 17]),
    ...sourceHours("2026-01-03", [14, 15, 16, 17]),
  ];
  const future = guardEvent({
    actual: 10,
    key: "future-lead-one",
    validAt: "2026-01-05T18:00:00.000Z",
  });
  const futureOtherVintage = guardEvent({
    actual: 10,
    key: "future-lead-two",
    targetLeadHours: 2,
    validAt: future.validAt,
  });
  const original = recordFor(
    [...sources, target, future, futureOtherVintage],
    target.key,
  );
  const changed = recordFor(
    [
      ...sources,
      target,
      { ...future, actual: -20 },
      { ...futureOtherVintage, actual: -20 },
    ],
    target.key,
  );

  assert.deepEqual(changed, original);
});

// verify deterministic immutable audit output
test("preserves input order while making selection deterministic and deeply immutable", () => {
  const targetA = guardEvent({ key: "target-a" });
  const targetB = guardEvent({
    key: "target-b",
    validAt: "2026-01-04T19:00:00.000Z",
  });
  const sources = [
    ...sourceHours("2026-01-01", [14, 15, 16, 17]),
    ...sourceHours("2026-01-02", [14, 15, 16, 17]),
    ...sourceHours("2026-01-03", [14, 15, 16, 17]),
  ];
  const inputs = [targetB, ...sources, targetA];
  const snapshot = structuredClone(inputs);
  const original = createTemperatureCausalGuardAudit(inputs);
  const reversed = createTemperatureCausalGuardAudit([...inputs].reverse());
  const originalByKey = new Map(original.map(
    // bind output records by input identity
    (record) => [record.key, record],
  ));

  assert.deepEqual(original.map(
    // project returned input identities
    (record) => record.key,
  ), inputs.map(
    // project original input identities
    (event) => event.key,
  ));

  // compare selections independently from returned input order
  for (const record of reversed) {
    assert.deepEqual(record, originalByKey.get(record.key));
  }

  assert.deepEqual(inputs, snapshot);
  assert.equal(Object.isFrozen(original), true);
  assert.equal(Object.isFrozen(original[0]), true);
  assert.equal(Object.isFrozen(original.at(-1).selectedSources), true);
  assert.equal(
    original.at(-1).selectedSources.every(
      // require every nested source audit to be immutable
      (source) => Object.isFrozen(source),
    ),
    true,
  );
});

// verify the specified ceiling lead identity
test("accepts canonical instants whose elapsed lead requires ceiling", () => {
  const event = guardEvent({
    key: "fractional-elapsed-lead",
    referenceAt: "2026-01-04T17:00:00.000Z",
    targetLeadHours: 2,
    validAt: "2026-01-04T18:30:00.000Z",
  });
  const [record] = createTemperatureCausalGuardAudit([event]);

  assert.equal(record.targetLeadHours, 2);
  assert.equal(record.validAt, event.validAt);
});

// reject malformed or contradictory evidence
test("rejects malformed, duplicate, and contradictory event evidence", () => {
  const event = guardEvent();

  assert.throws(
    // reject non-array inputs
    () => createTemperatureCausalGuardAudit({}),
    /events must be an array/u,
  );
  assert.throws(
    // reject nonfinite predictions
    () => createTemperatureCausalGuardAudit([
      { ...event, halfStrengthPrediction: Number.NaN },
    ]),
    /numbers must be finite/u,
  );
  assert.throws(
    // reject noncanonical timestamps
    () => createTemperatureCausalGuardAudit([
      { ...event, validAt: "2026-01-04 18:00:00" },
    ]),
    /validAt must be a canonical UTC instant/u,
  );
  assert.throws(
    // reject invalid lead identities
    () => createTemperatureCausalGuardAudit([
      { ...event, targetLeadHours: 2 },
    ]),
    /targetLeadHours must match/u,
  );
  assert.throws(
    // reject duplicate canonical keys
    () => createTemperatureCausalGuardAudit([event, { ...event }]),
    /keys must be unique/u,
  );
  assert.throws(
    // reject contradictory shared-hour labels
    () => createTemperatureCausalGuardAudit([
      event,
      { ...event, actual: 11, key: "same-hour-other-vintage" },
    ]),
    /actual values must agree/u,
  );
  assert.throws(
    // reject additional schema fields
    () => createTemperatureCausalGuardAudit([{ ...event, extra: true }]),
    /fields must match/u,
  );
});
