import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { eveningSunTimes } from "../dist/index.js";
import {
  projectWidgetForecast,
  WIDGET_FORECAST_MAX_BYTES,
  WIDGET_FORECAST_SCHEMA_VERSION,
} from "../dist/widget-forecast.js";
import { createForecastFixture } from "../../../scripts/widget-fixtures.mjs";

const HOUR_MS = 3_600_000;
const expectedTopKeys = [
  "attribution",
  "calendar",
  "generatedAt",
  "hours",
  "receivedAt",
  "schemaVersion",
  "site",
  "status",
];
const expectedFieldKeys = [
  "mode",
  "raw",
  "rawSource",
  "reason",
  "selected",
  "selectedSource",
  "selectedUntil",
];

// retain import safety when the edge adapter loads the browser module in node
test("widget projector imports in node without browser startup side effects", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", "await import('./apps/web/dist/widget-forecast.js'); console.log('imported')"],
    { cwd: new URL("../../..", import.meta.url), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "imported\n");
  assert.equal(result.stderr, "");
});

// freeze the closed allowlisted public object graph
test("widget projector emits only the v1 public keys within 128 KiB", () => {
  const { input, receivedAt } = createForecastFixture({ generic: true, rain: true, temperature: true });
  const snapshot = projectWidgetForecast(input, receivedAt);
  assert.equal(snapshot.schemaVersion, WIDGET_FORECAST_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(snapshot).sort(), expectedTopKeys);
  assert.deepEqual(Object.keys(snapshot.site).sort(), ["latitude", "longitude", "name", "slug", "timezone"]);
  assert.deepEqual(Object.keys(snapshot.calendar).sort(), ["cutoff", "date", "dayEnd", "dayStart", "sunset"]);
  assert.deepEqual(Object.keys(snapshot.attribution).sort(), ["label", "licenseUrl", "providerUrl"]);
  assert.deepEqual(Object.keys(snapshot.hours[0]).sort(), ["end", "rainMmPerHour", "start", "temperatureC"]);
  assert.deepEqual(Object.keys(snapshot.hours[0].temperatureC).sort(), expectedFieldKeys);
  assert.deepEqual(Object.keys(snapshot.hours[0].rainMmPerHour).sort(), expectedFieldKeys);
  assert.deepEqual(Object.keys(snapshot.hours[0].temperatureC.rawSource).sort(), ["receivedAt", "runAt"]);
  assert.deepEqual(Object.keys(snapshot.hours[0].temperatureC.selectedSource).sort(), ["receivedAt", "runAt"]);
  const serialized = JSON.stringify(snapshot);
  assert.ok(Buffer.byteLength(serialized) <= WIDGET_FORECAST_MAX_BYTES);

  // reject private adjustment and row identities anywhere in public bytes
  for (const forbidden of [
    "activeBundle",
    "adjustmentRuntime",
    "bundleSha256",
    "candidateArtifactSha256",
    "decisionAt",
    "id\"",
    "pressureContext",
    "providerResponseSha256",
    "sourceId",
    "stationSlug",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

// lock the schema itself as a closed dependency-free public artifact
test("widget schema closes every public object and pins site attribution and version", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../../mobile/shared/widget-forecast-v1.schema.json", import.meta.url),
    "utf8",
  ));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, WIDGET_FORECAST_SCHEMA_VERSION);
  assert.equal(schema.properties.site.properties.slug.const, "ballydidean");
  assert.equal(schema.properties.site.properties.name.const, "Ballydidean");
  assert.equal(schema.properties.site.properties.timezone.const, "America/Los_Angeles");
  assert.equal(schema.properties.attribution.properties.label.const, "Open-Meteo · CC BY 4.0");
  assert.equal(schema.$defs.fieldBase.additionalProperties, false);
  assert.equal(schema.$defs.fieldBase.oneOf.length, 3);
  assert.equal(schema.$defs.fieldBase.oneOf[0].properties.selectedSource.$ref, "#/$defs/source");
  assert.equal(schema.$defs.fieldBase.oneOf[0].oneOf.length, 2);
  assert.equal(schema.$defs.fieldBase.oneOf[0].oneOf[0].properties.raw.type, "number");
  assert.equal(schema.$defs.fieldBase.oneOf[0].oneOf[0].properties.rawSource.$ref, "#/$defs/source");
  assert.equal(schema.$defs.fieldBase.oneOf[0].oneOf[1].properties.raw.type, "null");
  assert.equal(schema.$defs.fieldBase.oneOf[0].oneOf[1].properties.rawSource.type, "null");
  assert.equal(schema.$defs.fieldBase.oneOf[1].properties.selectedSource.type, "null");
  assert.equal(schema.$defs.fieldBase.oneOf[2].properties.raw.type, "null");
  assert.deepEqual(schema.$defs.mode.enum, ["adjusted", "raw", "unavailable"]);
  assert.deepEqual(schema.$defs.status.enum, ["adjusted", "mixed", "raw", "unavailable"]);
});

// lock the adjusted raw value and provenance pairing the schema encodes
test("widget adjusted raw values and sources remain paired", () => {
  const numeric = createForecastFixture({ temperature: true });
  const numericField = projectWidgetForecast(numeric.input, numeric.receivedAt).hours[0].temperatureC;
  const missing = createForecastFixture({
    row(index, record) {
      return index === 0 ? { ...record, metrics: { ...record.metrics, temperatureC: null } } : record;
    },
    temperature: true,
  });
  const missingField = projectWidgetForecast(missing.input, missing.receivedAt).hours[0].temperatureC;
  assert.equal(adjustedRawPairIsValid(numericField), true);
  assert.equal(adjustedRawPairIsValid(missingField), true);
  assert.equal(adjustedRawPairIsValid({ ...numericField, rawSource: null }), false);
  assert.equal(adjustedRawPairIsValid({ ...missingField, rawSource: numericField.rawSource }), false);
});

// preserve complete 23, 24, and 25 real-hour grids across dst
test("widget projector emits complete contiguous civil-day grids", () => {
  const cases = [
    ["2026-03-08", "2026-03-08T08:00:00.000Z", "2026-03-08T08:00:01.000Z", 23],
    ["2026-09-12", "2026-09-12T07:00:00.000Z", "2026-09-12T07:00:01.000Z", 24],
    ["2026-11-01", "2026-11-01T07:00:00.000Z", "2026-11-01T07:00:01.000Z", 25],
  ];

  // verify every reviewed civil-day capacity
  for (const [date, generatedAt, receivedAt, count] of cases) {
    const fixture = createForecastFixture({ date, generatedAt, receivedAt });
    const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
    assert.equal(snapshot.hours.length, count);
    assert.equal(snapshot.hours[0].start, snapshot.calendar.dayStart);
    assert.equal(snapshot.hours.at(-1).end, snapshot.calendar.dayEnd);

    // require exact one-hour utc adjacency
    for (let index = 1; index < snapshot.hours.length; index += 1) {
      assert.equal(snapshot.hours[index - 1].end, snapshot.hours[index].start);
      assert.equal(Date.parse(snapshot.hours[index].start) - Date.parse(snapshot.hours[index - 1].start), HOUR_MS);
    }
  }

  const fallback = createForecastFixture({
    date: "2026-11-01",
    generatedAt: "2026-11-01T07:00:00.000Z",
    receivedAt: "2026-11-01T07:00:01.000Z",
  });
  const repeated = projectWidgetForecast(fallback.input, fallback.receivedAt).hours
    .filter((hour) => hour.start === "2026-11-01T08:00:00.000Z" || hour.start === "2026-11-01T09:00:00.000Z");
  assert.equal(repeated.length, 2);
});

// anchor all calendar fields and astronomy to upstream generation time only
test("widget calendar and sunset ignore the edge midnight rollover", () => {
  const { input, receivedAt } = createForecastFixture({
    date: "2026-09-11",
    generatedAt: "2026-09-12T06:59:59.000Z",
    receivedAt: "2026-09-12T07:00:01.000Z",
  });
  const snapshot = projectWidgetForecast(input, receivedAt);
  const expectedSunset = eveningSunTimes(snapshot.site, new Date(input.generatedAt)).sunset;
  assert.equal(snapshot.calendar.date, "2026-09-11");
  assert.equal(snapshot.calendar.dayStart, "2026-09-11T07:00:00.000Z");
  assert.equal(snapshot.calendar.cutoff, "2026-09-12T03:00:00.000Z");
  assert.equal(snapshot.calendar.dayEnd, "2026-09-12T07:00:00.000Z");
  assert.equal(snapshot.calendar.sunset, expectedSunset.toISOString());

  const newDay = createForecastFixture({
    date: "2026-09-12",
    generatedAt: "2026-09-12T07:00:00.000Z",
    receivedAt: "2026-09-12T07:00:01.000Z",
  });
  assert.equal(projectWidgetForecast(newDay.input, newDay.receivedAt).calendar.date, "2026-09-12");
});

// reject impossible sites, clocks, duplicate hours, and foreign rows
test("widget projector fails closed on site grid and timestamp mismatches", () => {
  const base = createForecastFixture();

  // reject every fixed site identity mismatch independently
  for (const [key, value] of [
    ["slug", "other"],
    ["timezone", "UTC"],
    ["latitude", 47],
    ["longitude", -123],
  ]) {
    const input = structuredClone(base.input);
    input.site[key] = value;
    assert.throws(() => projectWidgetForecast(input, base.receivedAt), /site or calendar anchor/u);
  }

  const duplicate = structuredClone(base.input);
  duplicate.data.push(structuredClone(duplicate.data[0]));
  assert.throws(() => projectWidgetForecast(duplicate, base.receivedAt), /duplicate or foreign hour/u);

  const offDay = structuredClone(base.input);
  offDay.data[0].validAt = new Date(Date.parse(offDay.data[0].validAt) - HOUR_MS).toISOString();
  assert.throws(() => projectWidgetForecast(offDay, base.receivedAt), /duplicate or foreign hour/u);

  const offGrid = structuredClone(base.input);
  offGrid.data[0].validAt = new Date(Date.parse(offGrid.data[0].validAt) + 1).toISOString();
  assert.throws(() => projectWidgetForecast(offGrid, base.receivedAt), /duplicate or foreign hour/u);

  const wrongKind = structuredClone(base.input);
  wrongKind.data[0].provenance.sourceKind = "model_current";
  assert.throws(() => projectWidgetForecast(wrongKind, base.receivedAt), /duplicate or foreign hour/u);

  const futureGeneration = structuredClone(base.input);
  assert.throws(
    () => projectWidgetForecast(futureGeneration, "2026-09-12T15:14:59.999Z"),
    /generatedAt is after receivedAt/u,
  );

  // reject parseable javascript date rollovers and incomplete instants
  for (const generatedAt of ["2026-02-30T12:00:00Z", "2026-09-12Z", "2026-09-12T24:00:00Z"]) {
    const malformed = structuredClone(base.input);
    malformed.generatedAt = generatedAt;
    assert.throws(() => projectWidgetForecast(malformed, base.receivedAt), /generatedAt is invalid/u);
  }

  const futureReceipt = structuredClone(base.input);
  futureReceipt.data[0].receivedAt = new Date(Date.parse(base.input.generatedAt) + 1).toISOString();
  assert.throws(() => projectWidgetForecast(futureReceipt, base.receivedAt), /timestamps are out of order/u);

  const reversedRun = structuredClone(base.input);
  reversedRun.data[0].productRunAt = new Date(Date.parse(reversedRun.data[0].receivedAt) + 1).toISOString();
  assert.throws(() => projectWidgetForecast(reversedRun, base.receivedAt), /timestamps are out of order/u);
});

// fill genuine gaps but reject physically invalid supplied numbers
test("widget projector distinguishes missing values from invalid values", () => {
  const gap = createForecastFixture();
  const missingStart = gap.input.data[3].validAt;
  gap.input.data.splice(3, 1);
  const gapSnapshot = projectWidgetForecast(gap.input, gap.receivedAt);
  const missing = gapSnapshot.hours.find((hour) => hour.start === missingStart);
  assert.equal(missing.temperatureC.mode, "unavailable");
  assert.equal(missing.rainMmPerHour.mode, "unavailable");
  assert.equal(missing.rainMmPerHour.selected, null);

  const nullMetrics = createForecastFixture({
    row(index, record) {
      return index === 2
        ? {
            ...record,
            metrics: {
              ...record.metrics,
              precipitationMm: null,
              precipitationRateMmPerHour: null,
              temperatureC: null,
            },
          }
        : record;
    },
  });
  const nullHour = projectWidgetForecast(nullMetrics.input, nullMetrics.receivedAt).hours[2];
  assert.equal(nullHour.temperatureC.reason, "missing");
  assert.equal(nullHour.rainMmPerHour.reason, "missing");

  // reject each field's canonical physical bounds
  for (const [metric, value] of [
    ["temperatureC", -100.000001],
    ["temperatureC", 70.000001],
    ["precipitationMm", -0.000001],
    ["precipitationRateMmPerHour", -0.000001],
  ]) {
    const invalid = createForecastFixture();
    invalid.input.data[0].metrics[metric] = value;
    assert.throws(() => projectWidgetForecast(invalid.input, invalid.receivedAt), /contains invalid/u);
  }

  const nonfinite = createForecastFixture();
  nonfinite.input.data[0].metrics.temperatureC = Number.NaN;
  assert.throws(() => projectWidgetForecast(nonfinite.input, nonfinite.receivedAt), /invalid raw record/u);
  assert.throws(() => JSON.parse('{"temperatureC":NaN}'), SyntaxError);
});

// preserve rate-first rain semantics and every native classification boundary
test("widget rain projection preserves zero epsilon and threshold values", () => {
  const values = [0, 0.000001, 2.5, 2.500001, 30];
  const fixture = createForecastFixture({
    row(index, record) {
      const rate = values[index] ?? record.metrics.precipitationRateMmPerHour;
      return {
        ...record,
        metrics: {
          ...record.metrics,
          precipitationMm: index === 0 ? 9 : rate,
          precipitationRateMmPerHour: rate,
        },
      };
    },
  });
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  assert.deepEqual(snapshot.hours.slice(0, values.length).map((hour) => hour.rainMmPerHour.selected), values);

  const amountFallback = createForecastFixture({
    row(index, record) {
      return index === 0
        ? { ...record, metrics: { ...record.metrics, precipitationMm: 0, precipitationRateMmPerHour: null } }
        : record;
    },
  });
  assert.equal(projectWidgetForecast(amountFallback.input, amountFallback.receivedAt).hours[0].rainMmPerHour.selected, 0);
});

// freeze independent temperature over generic over raw precedence and provenance
test("widget temperature selection follows the shared resolver precedence", () => {
  const fixture = createForecastFixture({
    generic: true,
    row(_index, record) {
      return { ...record, metrics: { ...record.metrics, temperatureC: 16 } };
    },
    temperature: true,
  });

  // distinguish the independent correction from generic and raw values
  for (const record of fixture.input.data) {
    record.temperatureAdjustment.correctedTemperatureC = 15;
  }

  const independent = projectWidgetForecast(fixture.input, fixture.receivedAt).hours[0].temperatureC;
  assert.equal(independent.raw, 16);
  assert.equal(independent.selected, 15);
  assert.equal(independent.reason, "independent_adjustment");
  assert.equal(independent.rawSource.runAt, fixture.input.data[0].productRunAt);
  assert.equal(independent.selectedSource.runAt, fixture.input.data[0].temperatureAdjustment.sourceForecast.runInitializedAt);
  assert.notDeepEqual(independent.rawSource, independent.selectedSource);

  const genericInput = structuredClone(fixture.input);

  // convert every independent decision into a valid raw fallback
  for (const record of genericInput.data) {
    record.temperatureAdjustment = {
      branch: null,
      bundleSha256: genericInput.temperatureAdjustmentRuntime.activeBundle,
      contractVersion: "forecast-temperature-canary-decision/v1",
      correctedTemperatureC: null,
      rawBestMatchTemperatureC: record.metrics.temperatureC,
      reasonCode: "outside_operational_window",
      recentErrorStateSha256: null,
      sourceForecast: null,
      state: "raw_fallback",
    };
  }

  const generic = projectWidgetForecast(genericInput, fixture.receivedAt).hours[0].temperatureC;
  assert.equal(generic.selected, 18);
  assert.equal(generic.reason, "generic_adjustment");
  assert.deepEqual(generic.selectedSource, generic.rawSource);

  const rawInput = structuredClone(genericInput);
  delete rawInput.adjustmentRuntime;

  // remove generic row decisions with their runtime
  for (const record of rawInput.data) {
    delete record.adjustment;
  }

  const raw = projectWidgetForecast(rawInput, fixture.receivedAt).hours[0].temperatureC;
  assert.equal(raw.selected, 16);
  assert.equal(raw.mode, "raw");
  assert.equal(raw.selectedSource, null);
});

// cap every correction at its own known deadline and snapshot age
test("widget corrections fail raw when deadlines are absent expired or capped", () => {
  const generatedAt = "2026-09-12T15:15:00.000Z";
  const cap = "2026-09-12T16:45:00.000Z";
  const capped = createForecastFixture({ generatedAt, temperature: true });
  assert.equal(projectWidgetForecast(capped.input, capped.receivedAt).hours[0].temperatureC.selectedUntil, cap);

  const shorter = createForecastFixture({
    generatedAt,
    temperature: true,
    temperatureExpiresAt: "2026-09-12T15:45:00.000Z",
  });
  assert.equal(
    projectWidgetForecast(shorter.input, shorter.receivedAt).hours[0].temperatureC.selectedUntil,
    "2026-09-12T15:45:00.000Z",
  );

  const expired = createForecastFixture({
    generatedAt,
    temperature: true,
    temperatureExpiresAt: generatedAt,
  });
  const expiredField = projectWidgetForecast(expired.input, expired.receivedAt).hours[0].temperatureC;
  assert.equal(expiredField.mode, "raw");
  assert.equal(expiredField.reason, "deadline_expired");
  assert.equal(expiredField.selectedSource, null);

  const genericUnknown = createForecastFixture({ generic: true });
  genericUnknown.input.adjustmentRuntime.expiresAt = null;
  const unknownField = projectWidgetForecast(genericUnknown.input, genericUnknown.receivedAt).hours[0].temperatureC;
  assert.equal(unknownField.mode, "raw");
  assert.equal(unknownField.reason, "deadline_unavailable");

  const genericMalformed = createForecastFixture({ generic: true });
  genericMalformed.input.adjustmentRuntime.expiresAt = "2026-02-30T12:00:00Z";
  const malformedField = projectWidgetForecast(genericMalformed.input, genericMalformed.receivedAt).hours[0].temperatureC;
  assert.equal(malformedField.mode, "raw");
  assert.equal(malformedField.reason, "deadline_unavailable");

  const rain = createForecastFixture({ rain: true });
  const rainField = projectWidgetForecast(rain.input, rain.receivedAt).hours[0].rainMmPerHour;
  assert.equal(rainField.selectedUntil, new Date(Math.min(
    Date.parse(rain.input.generatedAt) + 90 * 60_000,
    Date.parse(rain.input.data[0].rainAdjustment.sourceForecast.decisionAt) + 12 * HOUR_MS,
  )).toISOString());
});

// retain active values with nullable raw fallback until their deadline
test("widget adjusted fields may carry a missing raw fallback", () => {
  const fixture = createForecastFixture({
    row(index, record) {
      return index === 0 ? { ...record, metrics: { ...record.metrics, temperatureC: null } } : record;
    },
    temperature: true,
  });
  const field = projectWidgetForecast(fixture.input, fixture.receivedAt).hours[0].temperatureC;
  assert.equal(field.mode, "adjusted");
  assert.equal(field.raw, null);
  assert.equal(field.rawSource, null);
  assert.equal(field.selected, 10);
  assert.notEqual(field.selectedSource, null);
  assert.notEqual(field.selectedUntil, null);
});

// exercise every three-switch setting and corrupt-state fail closed behavior
test("widget projection honors all eight admin switch combinations", () => {
  // exercise the complete three-bit switch matrix
  for (let bits = 0; bits < 8; bits += 1) {
    const settings = {
      rain: Boolean(bits & 4),
      temperature: Boolean(bits & 1),
      version: 1,
      wind: Boolean(bits & 2),
    };
    const fixture = createForecastFixture({
      generic: true,
      rain: true,
      row(_index, record) {
        return {
          ...record,
          metrics: {
            ...record.metrics,
            precipitationMm: 0.4,
            precipitationRateMmPerHour: 0.4,
            temperatureC: 16,
          },
        };
      },
      settings,
      temperature: true,
    });

    // make selected values visibly distinct from raw and generic
    for (const record of fixture.input.data) {
      record.temperatureAdjustment.correctedTemperatureC = 15;
      record.rainAdjustment.correctedPrecipitationMm = 3;
    }

    const hour = projectWidgetForecast(fixture.input, fixture.receivedAt).hours[0];
    assert.equal(hour.temperatureC.selected, settings.temperature ? 15 : 16, `temperature bits ${String(bits)}`);
    assert.equal(hour.temperatureC.mode, settings.temperature ? "adjusted" : "raw", `temperature bits ${String(bits)}`);
    assert.equal(hour.rainMmPerHour.selected, settings.rain ? 3 : 0.4, `rain bits ${String(bits)}`);
    assert.equal(hour.rainMmPerHour.mode, settings.rain ? "adjusted" : "raw", `rain bits ${String(bits)}`);
  }

  const malformed = createForecastFixture({
    generic: true,
    rain: true,
    settings: { version: 1, temperature: true, wind: true },
    temperature: true,
  });
  const failClosed = projectWidgetForecast(malformed.input, malformed.receivedAt).hours[0];
  assert.equal(failClosed.temperatureC.mode, "raw");
  assert.equal(failClosed.rainMmPerHour.mode, "raw");
});

// keep malformed adjustment sets isolated behind the parser's global raw fallback
test("widget projection inherits malformed adjustment fail-raw behavior", () => {
  const fixture = createForecastFixture({ generic: true, temperature: true });
  fixture.input.data[4].temperatureAdjustment.bundleSha256 = "0".repeat(64);
  fixture.input.data[5].adjustment.candidateArtifactSha256 = "1".repeat(64);
  const snapshot = projectWidgetForecast(fixture.input, fixture.receivedAt);
  assert.ok(snapshot.hours.every((hour) => hour.temperatureC.mode === "raw"));
  assert.ok(snapshot.hours.every((hour) => hour.temperatureC.selectedSource === null));

  const disabled = createForecastFixture({ temperature: true });
  disabled.input.temperatureAdjustmentRuntime = {
    activeBundle: null,
    authorizationSha256: null,
    expiresAt: null,
    loadedAt: disabled.input.generatedAt,
    reasonCode: "registry_inactive",
    source: null,
    state: "disabled",
  };

  // bind every row to the explicit disabled runtime
  for (const record of disabled.input.data) {
    record.temperatureAdjustment = {
      branch: null,
      bundleSha256: null,
      contractVersion: "forecast-temperature-canary-decision/v1",
      correctedTemperatureC: null,
      rawBestMatchTemperatureC: record.metrics.temperatureC,
      reasonCode: "registry_inactive",
      recentErrorStateSha256: null,
      sourceForecast: null,
      state: "disabled",
    };
  }

  assert.ok(projectWidgetForecast(disabled.input, disabled.receivedAt).hours.every(
    // keep explicit runtime disablement raw
    (hour) => hour.temperatureC.mode === "raw",
  ));
});

// validate the schema's adjusted raw/source invariant without a schema dependency
function adjustedRawPairIsValid(field) {
  // require both numeric raw data and its source together
  if (typeof field.raw === "number") {
    return field.rawSource !== null;
  }

  return field.raw === null && field.rawSource === null;
}
