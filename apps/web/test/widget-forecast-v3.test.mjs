import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  projectWidgetForecastV2,
} from "../dist/widget-forecast-v2.js";
import {
  projectWidgetForecastV3,
  WIDGET_FORECAST_V3_SCHEMA_VERSION,
} from "../dist/widget-forecast-v3.js";
import { WIDGET_FORECAST_MAX_BYTES } from "../dist/widget-forecast.js";
import { createForecastFixture } from "../../../scripts/widget-fixtures.mjs";

const HOUR_MS = 3_600_000;

// build one complete anchor-day through next-morning source response
function createOvernightFixture(options = {}) {
  const date = options.date ?? "2026-09-12";
  const nextDate = addDays(date, 1);
  const conditionOptions = {
    ...options,
    row(index, record) {
      const row = options.row?.(index, record) ?? record;
      return {
        ...row,
        metrics: {
          ...row.metrics,
          cloudCoverPercent: row.metrics.cloudCoverPercent ?? 20 + index,
          windSpeedMps: row.metrics.windSpeedMps ?? 4 + index / 10,
        },
      };
    },
  };
  const anchor = createForecastFixture({ ...conditionOptions, date });
  const next = createForecastFixture({ ...conditionOptions, date: nextDate });
  anchor.input.data.push(...next.input.data.slice(0, 7));
  return anchor;
}

// advance one calendar date without applying a runtime timezone
function addDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// retarget every generic correction to adjusted wind
function enableWindAdjustment(fixture) {
  fixture.input.adjustmentRuntime.enabledMetrics = ["windSpeedMps"];

  // preserve every row identity while selecting only wind
  for (const record of fixture.input.data) {
    record.adjustment.adjustedMetrics = {
      windSpeedMps: record.metrics.windSpeedMps + 3,
    };
    record.adjustment.appliedMetrics = ["windSpeedMps"];
  }
}

// preserve the v2 object graph while adding only overnightEnd and more hours
test("widget v3 extends the v2 fields with one overnight calendar bound", () => {
  const fixture = createOvernightFixture({ generic: true });
  enableWindAdjustment(fixture);
  const snapshot = projectWidgetForecastV3(fixture.input, fixture.receivedAt);
  const dailyInput = structuredClone(fixture.input);
  dailyInput.data = dailyInput.data.slice(0, 24);
  const v2 = projectWidgetForecastV2(dailyInput, fixture.receivedAt);
  const { overnightEnd, ...calendar } = snapshot.calendar;

  assert.equal(snapshot.schemaVersion, WIDGET_FORECAST_V3_SCHEMA_VERSION);
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    Object.keys(v2).sort(),
  );
  assert.deepEqual(calendar, v2.calendar);
  assert.equal(overnightEnd, "2026-09-13T14:00:00.000Z");
  assert.deepEqual(snapshot.hours.slice(0, 24), v2.hours);
  assert.equal(snapshot.hours.length, 31);
  assert.equal(snapshot.hours[0].cloudCoverPercent.mode, "raw");
  assert.equal(snapshot.hours[0].windSpeedMps.mode, "adjusted");
  assert.deepEqual(
    snapshot.hours[0].windSpeedMps.selectedSource,
    snapshot.hours[0].windSpeedMps.rawSource,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= WIDGET_FORECAST_MAX_BYTES);
});

// anchor the overnight date at the exact local 07:00 boundary
test("widget v3 anchors before 07:00 to the previous date", () => {
  const before = createOvernightFixture({
    date: "2026-09-11",
    generatedAt: "2026-09-12T13:59:59.999Z",
    receivedAt: "2026-09-12T14:00:00.000Z",
  });
  const beforeSnapshot = projectWidgetForecastV3(before.input, before.receivedAt);
  assert.equal(beforeSnapshot.calendar.date, "2026-09-11");
  assert.equal(beforeSnapshot.calendar.dayStart, "2026-09-11T07:00:00.000Z");
  assert.equal(beforeSnapshot.calendar.dayEnd, "2026-09-12T07:00:00.000Z");
  assert.equal(beforeSnapshot.calendar.cutoff, "2026-09-12T03:00:00.000Z");
  assert.equal(beforeSnapshot.calendar.overnightEnd, "2026-09-12T14:00:00.000Z");

  const exact = createOvernightFixture({
    date: "2026-09-12",
    generatedAt: "2026-09-12T14:00:00.000Z",
    receivedAt: "2026-09-12T14:00:00.001Z",
  });
  const exactSnapshot = projectWidgetForecastV3(exact.input, exact.receivedAt);
  assert.equal(exactSnapshot.calendar.date, "2026-09-12");

  const cutoff = createOvernightFixture({
    date: "2026-09-12",
    generatedAt: "2026-09-13T03:00:00.000Z",
    receivedAt: "2026-09-13T03:00:00.001Z",
  });
  assert.equal(
    projectWidgetForecastV3(cutoff.input, cutoff.receivedAt).calendar.date,
    "2026-09-12",
  );
});

// retain complete real-hour grids across both daylight-saving transitions
test("widget v3 emits contiguous 30, 31, and 32 hour windows", () => {
  const cases = [
    ["2026-03-08", "2026-03-08T15:00:00.000Z", 30],
    ["2026-09-12", "2026-09-12T15:00:00.000Z", 31],
    ["2026-11-01", "2026-11-01T16:00:00.000Z", 32],
  ];

  // verify each reviewed overnight capacity
  for (const [date, generatedAt, count] of cases) {
    const fixture = createOvernightFixture({
      date,
      generatedAt,
      receivedAt: new Date(Date.parse(generatedAt) + 1).toISOString(),
    });
    const snapshot = projectWidgetForecastV3(fixture.input, fixture.receivedAt);
    assert.equal(snapshot.hours.length, count);
    assert.equal(snapshot.hours[0].start, snapshot.calendar.dayStart);
    assert.equal(snapshot.hours.at(-1).end, snapshot.calendar.overnightEnd);

    // require exact one-hour adjacency across offset changes
    for (let index = 1; index < snapshot.hours.length; index += 1) {
      assert.equal(snapshot.hours[index - 1].end, snapshot.hours[index].start);
      assert.equal(
        Date.parse(snapshot.hours[index].start) -
          Date.parse(snapshot.hours[index - 1].start),
        HOUR_MS,
      );
    }
  }
});

// fill genuine row gaps and preserve field-specific fallback deadlines
test("widget v3 keeps missing hours unavailable and adjustment deadlines honest", () => {
  const fixture = createOvernightFixture({ generic: true });
  enableWindAdjustment(fixture);
  const missingStart = fixture.input.data[27].validAt;
  fixture.input.data.splice(27, 1);
  const snapshot = projectWidgetForecastV3(fixture.input, fixture.receivedAt);
  const missing = snapshot.hours.find((hour) => hour.start === missingStart);
  assert.equal(missing.temperatureC.mode, "unavailable");
  assert.equal(missing.rainMmPerHour.mode, "unavailable");
  assert.equal(missing.cloudCoverPercent.mode, "unavailable");
  assert.equal(missing.windSpeedMps.mode, "unavailable");

  const expired = createOvernightFixture({ generic: true });
  enableWindAdjustment(expired);
  expired.input.adjustmentRuntime.expiresAt = expired.input.generatedAt;
  const field = projectWidgetForecastV3(expired.input, expired.receivedAt)
    .hours[0].windSpeedMps;
  assert.equal(field.mode, "raw");
  assert.equal(field.reason, "deadline_expired");
});

// reject off-grid rows and impossible source or edge clock ordering
test("widget v3 validates grid and source clocks without synthetic anchors", () => {
  const foreign = createOvernightFixture();
  foreign.input.data.at(-1).validAt = new Date(
    Date.parse(foreign.input.data.at(-1).validAt) + 7 * HOUR_MS,
  ).toISOString();
  assert.throws(
    () => projectWidgetForecastV3(foreign.input, foreign.receivedAt),
    /duplicate or foreign hour/u,
  );

  const futureSource = createOvernightFixture();
  futureSource.input.data[0].receivedAt = new Date(
    Date.parse(futureSource.input.generatedAt) + 1,
  ).toISOString();
  assert.throws(
    () => projectWidgetForecastV3(futureSource.input, futureSource.receivedAt),
    /timestamps are out of order/u,
  );

  const futureGeneration = createOvernightFixture();
  assert.throws(
    () => projectWidgetForecastV3(
      futureGeneration.input,
      new Date(Date.parse(futureGeneration.input.generatedAt) - 1).toISOString(),
    ),
    /generatedAt is after receivedAt/u,
  );
});

// lock the closed v3 schema and its overnight-only delta
test("widget v3 schema closes the extended calendar and hour bounds", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../../mobile/shared/widget-forecast-v3.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, WIDGET_FORECAST_V3_SCHEMA_VERSION);
  assert.equal(schema.properties.calendar.additionalProperties, false);
  assert.equal(schema.properties.calendar.properties.overnightEnd.$ref, "#/$defs/instant");
  assert.ok(schema.properties.calendar.required.includes("overnightEnd"));
  assert.equal(schema.properties.hours.minItems, 30);
  assert.equal(schema.properties.hours.maxItems, 32);
  assert.equal(schema.properties.hours.items.additionalProperties, false);
});
