import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildWidgetFixtures,
  createForecastFixture,
  renderWidgetFixtureSemantics,
} from "./widget-fixtures.mjs";
import { projectWidgetForecast } from "../apps/web/dist/widget-forecast.js";

const HOUR_MS = 3_600_000;

// ensure check mode verifies committed bytes without regenerating them
test("widget fixture check validates committed golden bytes", () => {
  const result = spawnSync(process.execPath, ["scripts/widget-fixtures.mjs", "--check"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

// retain deterministic fixture construction independently of file order
test("widget fixtures regenerate deterministic inputs snapshots and semantics", () => {
  assert.deepEqual(buildWidgetFixtures(), buildWidgetFixtures());
  assert.deepEqual(
    buildWidgetFixtures().map((fixture) => fixture.name),
    [
      "adjusted-standard",
      "spring-forward-23",
      "fall-back-25",
      "missing-raw-at-expiry",
      "stale-old-source",
      "midnight-race",
    ],
  );
});

// freeze the shared maximum-density range and wettest-hour oracle
test("widget semantic golden groups 60 63 61 as 60–63 and rain", () => {
  const fixture = buildWidgetFixtures().find((candidate) => candidate.name === "adjusted-standard");
  assert.ok(fixture);
  assert.equal(fixture.expected.groups.length, 7);
  assert.equal(fixture.expected.groups[0].hourCount, 3);
  assert.deepEqual(fixture.expected.groups[0].temperature, {
    label: "60–63",
    maximum: 63,
    minimum: 60,
  });
  assert.equal(fixture.expected.groups[0].condition, "rain");
  assert.equal(fixture.expected.groups.at(-1).hourCount, 2);
  assert.equal(fixture.expected.bedtime, false);
});

// preserve exact rain thresholds and missing-is-not-dry behavior
test("widget semantic renderer classifies rain before rounding", () => {
  const fixture = createForecastFixture();
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const start = Date.parse(snapshot.calendar.dayStart);
  snapshot.calendar.cutoff = new Date(start + 4 * HOUR_MS).toISOString();
  const values = [0, 0.000001, 2.5, 2.500001];

  // assign one independently grouped threshold value per hour
  for (let index = 0; index < values.length; index += 1) {
    snapshot.hours[index].rainMmPerHour = rawField(values[index], snapshot.hours[index].rainMmPerHour.rawSource);
  }

  const expected = renderWidgetFixtureSemantics(snapshot, {
    now: snapshot.calendar.dayStart,
    unit: "celsius",
  });
  assert.deepEqual(expected.groups.map((group) => group.condition), ["dry", "sprinkle", "sprinkle", "rain"]);

  snapshot.hours[1].rainMmPerHour = unavailableField();
  const missing = renderWidgetFixtureSemantics(snapshot, {
    now: snapshot.calendar.dayStart,
    unit: "celsius",
  });
  assert.equal(missing.groups[1].condition, "unavailable");
});

// pin cross-language midpoint rounding and negative-zero normalization
test("widget semantic renderer rounds temperature ties away from zero", () => {
  const fixture = createForecastFixture();
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const start = Date.parse(snapshot.calendar.dayStart);
  snapshot.calendar.cutoff = new Date(start + 5 * HOUR_MS).toISOString();
  const values = [-1.5, -0.5, 0.5, 1.5, -0.1];

  // isolate one tie value in each one-hour group
  for (let index = 0; index < values.length; index += 1) {
    snapshot.hours[index].temperatureC = rawField(values[index], snapshot.hours[index].temperatureC.rawSource);
  }

  const expected = renderWidgetFixtureSemantics(snapshot, {
    now: snapshot.calendar.dayStart,
    unit: "celsius",
  });
  assert.deepEqual(expected.groups.map((group) => group.temperature.label), ["-2", "-1", "1", "2", "0"]);
});

// cover every requested clock boundary without changing group membership rules
test("widget semantic renderer covers cutoff and local midnight boundaries", () => {
  const fixture = createForecastFixture({
    generatedAt: "2026-09-12T07:00:00.000Z",
    receivedAt: "2026-09-12T07:00:01.000Z",
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const cases = [
    ["2026-09-12T07:00:01.000Z", 7, false, "weather"],
    ["2026-09-12T15:15:00.000Z", 6, true, "weather"],
    ["2026-09-13T00:30:00.000Z", 3, true, "weather"],
    ["2026-09-13T02:59:59.000Z", 1, true, "weather"],
    ["2026-09-13T03:00:00.000Z", 0, true, "bedtime"],
    ["2026-09-13T03:00:01.000Z", 0, true, "bedtime"],
    ["2026-09-13T04:00:00.000Z", 0, true, "bedtime"],
    ["2026-09-13T06:59:59.000Z", 0, true, "bedtime"],
    ["2026-09-13T07:00:00.000Z", 0, false, "unavailable"],
  ];

  // verify exact group capacity at every boundary
  for (const [now, groupCount, bedtime, presentation] of cases) {
    const expected = renderWidgetFixtureSemantics(snapshot, { now, unit: "fahrenheit" });
    assert.equal(expected.groups.length, groupCount, now);
    assert.ok(expected.groups.length <= 7, now);
    assert.ok(expected.groups.every((group) => Date.parse(group.start) < Date.parse(snapshot.calendar.cutoff)), now);
    assert.equal(expected.bedtime, bedtime, now);
    assert.equal(expected.presentation, presentation, now);
  }
});

// select each repeated fall-back hour by its explicit utc interval
test("widget semantic renderer distinguishes repeated local hours", () => {
  const fixture = buildWidgetFixtures().find((candidate) => candidate.name === "fall-back-25");
  assert.ok(fixture);
  const first = renderWidgetFixtureSemantics(fixture.snapshot, {
    now: "2026-11-01T08:30:00.000Z",
    unit: "fahrenheit",
  });
  const second = renderWidgetFixtureSemantics(fixture.snapshot, {
    now: "2026-11-01T09:30:00.000Z",
    unit: "fahrenheit",
  });
  assert.equal(first.groups[0].start, "2026-11-01T08:00:00.000Z");
  assert.equal(second.groups[0].start, "2026-11-01T09:00:00.000Z");
  assert.notEqual(first.groups[0].start, second.groups[0].start);
});

// require incomplete groups to remain visibly unavailable
test("widget semantic renderer does not hide partial missing groups", () => {
  const fixture = createForecastFixture({
    generatedAt: "2026-09-12T07:00:00.000Z",
    receivedAt: "2026-09-12T07:00:01.000Z",
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  snapshot.hours[1].temperatureC = unavailableField();
  snapshot.hours[2].rainMmPerHour = unavailableField();
  const expected = renderWidgetFixtureSemantics(snapshot, {
    now: "2026-09-12T07:00:01.000Z",
    unit: "fahrenheit",
  });
  assert.equal(expected.groups[0].temperature, null);
  assert.equal(expected.groups[0].condition, "unavailable");
  assert.equal(expected.groups[0].status, "mixed");
});

// freeze correction equality demotion including value and provenance
test("widget semantic renderer demotes corrections at deadline equality", () => {
  const fixture = createForecastFixture({
    row(index, record) {
      return index === 9 ? { ...record, metrics: { ...record.metrics, temperatureC: null } } : record;
    },
    temperature: true,
    temperatureExpiresAt: "2026-09-12T16:00:00.000Z",
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const field = snapshot.hours[0].temperatureC;
  const before = renderWidgetFixtureSemantics(snapshot, {
    now: new Date(Date.parse(field.selectedUntil) - 1).toISOString(),
    unit: "celsius",
  });
  const at = renderWidgetFixtureSemantics(snapshot, {
    now: field.selectedUntil,
    unit: "celsius",
  });
  assert.notEqual(before.groups[0].temperature, null);
  assert.equal(at.groups[0].temperature, null);
  assert.equal(at.status, "mixed");
});

// switch freshness to raw provenance when a correction expires
test("widget semantic renderer recomputes source age after correction demotion", () => {
  const fixture = createForecastFixture({
    temperature: true,
    temperatureExpiresAt: "2026-09-12T16:00:00.000Z",
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const field = snapshot.hours[9].temperatureC;
  field.selectedSource.runAt = "2026-09-12T15:59:00.000Z";
  field.selectedSource.receivedAt = "2026-09-12T15:59:00.000Z";
  field.rawSource.runAt = "2026-09-12T02:59:59.999Z";
  field.rawSource.receivedAt = "2026-09-12T15:10:00.000Z";
  const before = renderWidgetFixtureSemantics(snapshot, {
    now: "2026-09-12T15:59:59.999Z",
    unit: "celsius",
  });
  const at = renderWidgetFixtureSemantics(snapshot, {
    now: "2026-09-12T16:00:00.000Z",
    unit: "celsius",
  });
  assert.equal(before.stale, false);
  assert.equal(at.stale, true);
});

// freeze exact stale boundaries for acquisition and oldest applicable source
test("widget semantic renderer applies 90 minute and 12 hour stale boundaries", () => {
  const staleGolden = buildWidgetFixtures().find((candidate) => candidate.name === "stale-old-source");
  assert.equal(staleGolden.expected.stale, true);
  const fixture = createForecastFixture({
    generatedAt: "2026-09-12T07:00:00.000Z",
    receivedAt: "2026-09-12T07:00:00.000Z",
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const now = "2026-09-12T19:00:00.000Z";

  // make every applicable source clock exactly twelve hours old
  for (const hour of snapshot.hours) {
    for (const field of [hour.temperatureC, hour.rainMmPerHour]) {
      field.rawSource.runAt = "2026-09-12T07:00:00.000Z";
      field.rawSource.receivedAt = "2026-09-12T07:00:00.000Z";
    }
  }

  snapshot.receivedAt = "2026-09-12T17:30:00.000Z";
  assert.equal(renderWidgetFixtureSemantics(snapshot, { now, unit: "celsius" }).stale, false);
  snapshot.receivedAt = "2026-09-12T17:29:59.999Z";
  assert.equal(renderWidgetFixtureSemantics(snapshot, { now, unit: "celsius" }).stale, true);
  snapshot.receivedAt = "2026-09-12T19:00:00.000Z";

  // cross the source age boundary by one millisecond
  for (const hour of snapshot.hours) {
    for (const field of [hour.temperatureC, hour.rainMmPerHour]) {
      field.rawSource.runAt = "2026-09-12T06:59:59.999Z";
    }
  }

  assert.equal(renderWidgetFixtureSemantics(snapshot, { now, unit: "celsius" }).stale, true);
});

// enforce hard numeric expiry at equality
test("widget semantic renderer expires numeric data at local midnight", () => {
  const fixture = createForecastFixture({
    generatedAt: "2026-09-12T07:00:00.000Z",
    receivedAt: "2026-09-12T07:00:01.000Z",
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const expected = renderWidgetFixtureSemantics(snapshot, {
    now: snapshot.calendar.dayEnd,
    unit: "fahrenheit",
  });
  assert.equal(expected.hardExpired, true);
  assert.equal(expected.status, "unavailable");
  assert.equal(expected.groups.length, 0);
  assert.equal(expected.presentation, "unavailable");
  assert.equal(expected.bedtime, false);
  assert.equal(expected.footer.sunset, null);

  const nextNoon = renderWidgetFixtureSemantics(snapshot, {
    now: "2026-09-13T19:00:00.000Z",
    unit: "fahrenheit",
  });
  assert.equal(nextNoon.hardExpired, true);
  assert.equal(nextNoon.presentation, "unavailable");
  assert.equal(nextNoon.bedtime, false);
  assert.equal(nextNoon.footer.sunset, null);
  assert.equal(nextNoon.date, "2026-09-12");
});

// ensure the checked schema and snapshots remain parseable json artifacts
test("widget shared artifacts are valid json", async () => {
  const fixtures = buildWidgetFixtures();

  // inspect every committed fixture trio
  for (const fixture of fixtures) {
    for (const name of ["input.json", "snapshot.json", "expected.json"]) {
      const value = JSON.parse(await readFile(
        new URL(`../mobile/shared/fixtures/${fixture.name}/${name}`, import.meta.url),
        "utf8",
      ));
      assert.notEqual(value, null);
    }
  }
});

// create one raw public field for semantic-only boundary tests
function rawField(value, source) {
  return {
    mode: "raw",
    raw: value,
    rawSource: source,
    reason: "raw_forecast",
    selected: value,
    selectedSource: null,
    selectedUntil: null,
  };
}

// create one unavailable public field for semantic-only boundary tests
function unavailableField() {
  return {
    mode: "unavailable",
    raw: null,
    rawSource: null,
    reason: "missing",
    selected: null,
    selectedSource: null,
    selectedUntil: null,
  };
}
