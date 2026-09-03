import assert from "node:assert/strict";
import test from "node:test";

import {
  DEVELOPMENT_FOLD_INDEXES,
  addLocalCalendarDays,
  createQualificationCalendarEpoch,
  daypartForLocalHour,
  localCalendarFeaturesFor,
  meteorologicalSeasonForMonth,
  runtimeCalendarFingerprint,
  runtimeCalendarFingerprintMatches,
} from "../dist/index.js";

// verify literal season and daypart boundaries
test("maps literal Los Angeles seasons and dayparts", () => {
  assert.deepEqual(
    Array.from({ length: 12 }, (_unused, index) =>
      meteorologicalSeasonForMonth(index + 1),
    ),
    [
      "winter",
      "winter",
      "spring",
      "spring",
      "spring",
      "summer",
      "summer",
      "summer",
      "autumn",
      "autumn",
      "autumn",
      "winter",
    ],
  );
  assert.deepEqual(
    Array.from({ length: 24 }, (_unused, hour) => daypartForLocalHour(hour)),
    [
      ...Array(6).fill("night"),
      ...Array(6).fill("morning"),
      ...Array(6).fill("afternoon"),
      ...Array(6).fill("evening"),
    ],
  );
  assert.throws(() => meteorologicalSeasonForMonth(0), /month/u);
  assert.throws(() => daypartForLocalHour(24), /hour/u);
});

// verify DST gaps and repeated hours without synthetic event identities
test("maps spring gaps and repeated fall hours from distinct UTC events", () => {
  const beforeSpringGap = localCalendarFeaturesFor("2025-03-09T09:30:00Z");
  const afterSpringGap = localCalendarFeaturesFor("2025-03-09T10:30:00Z");
  assert.equal(beforeSpringGap.localDate, "2025-03-09");
  assert.equal(beforeSpringGap.hour, 1);
  assert.equal(afterSpringGap.localDate, "2025-03-09");
  assert.equal(afterSpringGap.hour, 3);

  const firstFallHour = localCalendarFeaturesFor("2025-11-02T08:30:00Z");
  const secondFallHour = localCalendarFeaturesFor("2025-11-02T09:30:00Z");
  assert.equal(firstFallHour.localDate, "2025-11-02");
  assert.equal(secondFallHour.localDate, "2025-11-02");
  assert.equal(firstFallHour.hour, 1);
  assert.equal(secondFallHour.hour, 1);
  assert.equal(firstFallHour.daypart, secondFallHour.daypart);
  assert.notEqual(firstFallHour.validAt, secondFallHour.validAt);
});

// verify calendar labels advance independently from DST hour counts
test("adds strict local calendar labels", () => {
  assert.equal(addLocalCalendarDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addLocalCalendarDays("2025-03-09", 1), "2025-03-10");
  assert.equal(addLocalCalendarDays("2025-11-02", 1), "2025-11-03");
  assert.throws(() => addLocalCalendarDays("2025-02-29", 1), /valid/u);
  assert.throws(() => addLocalCalendarDays("2025-01-01", 0.5), /integer/u);
});

// verify the exact D0 through D401 rolling-origin calendar
test("builds the frozen 402-date partitions", () => {
  const epoch = createQualificationCalendarEpoch("2026-02-06");
  assert.equal(epoch.d0, "2025-01-01");
  assert.equal(epoch.localDates.length, 402);
  assert.equal(new Set(epoch.localDates).size, 402);
  assert.deepEqual(
    DEVELOPMENT_FOLD_INDEXES.map((definition) => definition.fold),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    epoch.folds.map((fold) => ({
      embargo: [fold.embargo.startLocalDate, fold.embargo.endLocalDate],
      score: [fold.score.startLocalDate, fold.score.endLocalDate],
      training: [fold.training.startLocalDate, fold.training.endLocalDate],
    })),
    [
      {
        embargo: ["2025-06-30", "2025-07-06"],
        score: ["2025-07-07", "2025-08-05"],
        training: ["2025-01-01", "2025-06-29"],
      },
      {
        embargo: ["2025-08-06", "2025-08-12"],
        score: ["2025-08-13", "2025-09-11"],
        training: ["2025-01-01", "2025-08-05"],
      },
      {
        embargo: ["2025-09-12", "2025-09-18"],
        score: ["2025-09-19", "2025-10-18"],
        training: ["2025-01-01", "2025-09-11"],
      },
      {
        embargo: ["2025-10-19", "2025-10-25"],
        score: ["2025-10-26", "2025-11-24"],
        training: ["2025-01-01", "2025-10-18"],
      },
      {
        embargo: ["2025-11-25", "2025-12-01"],
        score: ["2025-12-02", "2025-12-31"],
        training: ["2025-01-01", "2025-11-24"],
      },
    ],
  );
  assert.deepEqual(
    [epoch.finalTraining.startLocalDate, epoch.finalTraining.endLocalDate],
    ["2025-01-01", "2025-12-31"],
  );
  assert.deepEqual(
    [epoch.finalEmbargo.startLocalDate, epoch.finalEmbargo.endLocalDate],
    ["2026-01-01", "2026-01-07"],
  );
  assert.deepEqual(
    [epoch.holdout.startLocalDate, epoch.holdout.endLocalDate],
    ["2026-01-08", "2026-02-06"],
  );

  const partitions = [
    ...epoch.folds.flatMap((fold) => [fold.embargo, fold.score]),
    epoch.finalEmbargo,
    epoch.holdout,
  ];

  // prove every explicit boundary is internally unique
  for (const partition of partitions) {
    assert.equal(
      partition.localDates.length,
      partition.endIndex - partition.startIndex + 1,
    );
    assert.equal(new Set(partition.localDates).size, partition.localDates.length);
  }
});

// verify runtime calendar provenance is concrete and self-consistent
test("captures Node ICU and tzdata fingerprints", () => {
  const fingerprint = runtimeCalendarFingerprint();
  assert.match(fingerprint.icuVersion, /^\d/u);
  assert.match(fingerprint.tzdataVersion, /^\d/u);
  assert.equal(runtimeCalendarFingerprintMatches(fingerprint), true);
  assert.equal(
    runtimeCalendarFingerprintMatches({
      ...fingerprint,
      tzdataVersion: `${fingerprint.tzdataVersion}-changed`,
    }),
    false,
  );
});
