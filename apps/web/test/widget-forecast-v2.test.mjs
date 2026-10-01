import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  projectWidgetForecastV2,
  WIDGET_FORECAST_V2_SCHEMA_VERSION,
} from "../dist/widget-forecast-v2.js";
import { projectWidgetForecast } from "../dist/widget-forecast.js";
import { createForecastFixture } from "../../../scripts/widget-fixtures.mjs";

const expectedFieldKeys = [
  "mode",
  "raw",
  "rawSource",
  "reason",
  "selected",
  "selectedSource",
  "selectedUntil",
];

// create one fixture with visible raw condition metrics
function createConditionFixture(options = {}) {
  return createForecastFixture({
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
  });
}

// retarget one valid generic fixture to adjusted wind
function enableWindAdjustment(fixture) {
  fixture.input.adjustmentRuntime.enabledMetrics = ["windSpeedMps"];

  // preserve each decision identity while changing its sole adjusted metric
  for (const record of fixture.input.data) {
    record.adjustment.adjustedMetrics = {
      windSpeedMps: record.metrics.windSpeedMps + 3,
    };
    record.adjustment.appliedMetrics = ["windSpeedMps"];
  }
}

// preserve v1 bytes and add only the versioned condition fields
test("widget v2 extends every v1 hour without changing v1 output", () => {
  const fixture = createConditionFixture({ rain: true, temperature: true });
  const before = projectWidgetForecast(fixture.input, fixture.receivedAt);
  const snapshot = projectWidgetForecastV2(fixture.input, fixture.receivedAt);
  const after = projectWidgetForecast(fixture.input, fixture.receivedAt);
  assert.deepEqual(after, before);
  assert.equal(snapshot.schemaVersion, WIDGET_FORECAST_V2_SCHEMA_VERSION);
  assert.equal(snapshot.status, "mixed");
  assert.equal(snapshot.hours.length, before.hours.length);

  // compare every inherited hour independently of the new fields
  for (const [index, hour] of snapshot.hours.entries()) {
    const { cloudCoverPercent, windSpeedMps, ...v1Hour } = hour;
    assert.deepEqual(v1Hour, before.hours[index]);
    assert.deepEqual(Object.keys(cloudCoverPercent).sort(), expectedFieldKeys);
    assert.deepEqual(Object.keys(windSpeedMps).sort(), expectedFieldKeys);
    assert.equal(cloudCoverPercent.mode, "raw");
    assert.equal(windSpeedMps.mode, "raw");
  }
});

// expose adjusted wind with the generic runtime deadline and provenance
test("widget v2 selects bounded adjusted wind while cloud remains raw", () => {
  const fixture = createConditionFixture({ generic: true });
  enableWindAdjustment(fixture);
  const snapshot = projectWidgetForecastV2(fixture.input, fixture.receivedAt);
  const hour = snapshot.hours[0];
  assert.equal(hour.cloudCoverPercent.mode, "raw");
  assert.equal(hour.cloudCoverPercent.selected, 20);
  assert.equal(hour.windSpeedMps.mode, "adjusted");
  assert.equal(hour.windSpeedMps.raw, 4);
  assert.equal(hour.windSpeedMps.selected, 7);
  assert.equal(hour.windSpeedMps.reason, "generic_adjustment");
  assert.deepEqual(hour.windSpeedMps.selectedSource, hour.windSpeedMps.rawSource);
  assert.equal(hour.windSpeedMps.selectedUntil, "2026-09-12T16:45:00.000Z");
  assert.equal(snapshot.status, "mixed");
});

// cap permanent temperature and wind while invalid deadlines fail raw
test("widget v2 caps permanent adjustments and demotes invalid deadlines", () => {
  const permanent = createConditionFixture({ generic: true, temperature: true });
  enableWindAdjustment(permanent);
  permanent.input.adjustmentRuntime.expiresAt = null;
  permanent.input.temperatureAdjustmentRuntime.expiresAt = null;
  const permanentHour = projectWidgetForecastV2(
    permanent.input,
    permanent.receivedAt,
  ).hours[0];
  assert.equal(permanentHour.temperatureC.mode, "adjusted");
  assert.equal(permanentHour.temperatureC.selectedUntil, "2026-09-12T16:45:00.000Z");
  assert.equal(permanentHour.windSpeedMps.mode, "adjusted");
  assert.equal(permanentHour.windSpeedMps.selectedUntil, "2026-09-12T16:45:00.000Z");

  const missing = createConditionFixture({ generic: true });
  enableWindAdjustment(missing);
  delete missing.input.adjustmentRuntime.expiresAt;
  const missingField = projectWidgetForecastV2(
    missing.input,
    missing.receivedAt,
  ).hours[0].windSpeedMps;
  assert.equal(missingField.mode, "raw");
  assert.equal(missingField.reason, "raw_forecast");

  const malformed = createConditionFixture({ generic: true });
  enableWindAdjustment(malformed);
  malformed.input.adjustmentRuntime.expiresAt = "2026-02-30T12:00:00Z";
  const malformedField = projectWidgetForecastV2(
    malformed.input,
    malformed.receivedAt,
  ).hours[0].windSpeedMps;
  assert.equal(malformedField.mode, "raw");
  assert.equal(malformedField.reason, "deadline_unavailable");

  const expired = createConditionFixture({ generic: true });
  enableWindAdjustment(expired);
  expired.input.adjustmentRuntime.expiresAt = expired.input.generatedAt;
  const expiredField = projectWidgetForecastV2(
    expired.input,
    expired.receivedAt,
  ).hours[0].windSpeedMps;
  assert.equal(expiredField.mode, "raw");
  assert.equal(expiredField.reason, "deadline_expired");
});

// retain honest missing fields and reject out-of-range condition values
test("widget v2 distinguishes missing cloud and wind from invalid values", () => {
  const missing = createForecastFixture();
  const missingHour = projectWidgetForecastV2(
    missing.input,
    missing.receivedAt,
  ).hours[0];
  assert.equal(missingHour.cloudCoverPercent.mode, "unavailable");
  assert.equal(missingHour.windSpeedMps.mode, "unavailable");
  assert.equal(missingHour.cloudCoverPercent.selected, null);
  assert.equal(missingHour.windSpeedMps.selected, null);

  const invalidCloud = createConditionFixture({
    row(index, record) {
      return index === 0
        ? { ...record, metrics: { ...record.metrics, cloudCoverPercent: 101 } }
        : record;
    },
  });
  assert.throws(
    () => projectWidgetForecastV2(invalidCloud.input, invalidCloud.receivedAt),
    /invalid cloudCoverPercent/u,
  );

  const invalidWind = createConditionFixture({
    row(index, record) {
      return index === 0
        ? { ...record, metrics: { ...record.metrics, windSpeedMps: 151 } }
        : record;
    },
  });
  assert.throws(
    () => projectWidgetForecastV2(invalidWind.input, invalidWind.receivedAt),
    /invalid windSpeedMps/u,
  );
});

// lock the closed v2 schema and its condition ranges
test("widget v2 schema requires both closed condition fields", async () => {
  const schema = JSON.parse(await readFile(
    new URL("../../../mobile/shared/widget-forecast-v2.schema.json", import.meta.url),
    "utf8",
  ));
  const hour = schema.properties.hours.items;
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.schemaVersion.const, WIDGET_FORECAST_V2_SCHEMA_VERSION);
  assert.deepEqual(hour.required, [
    "cloudCoverPercent",
    "end",
    "rainMmPerHour",
    "start",
    "temperatureC",
    "windSpeedMps",
  ]);
  assert.equal(hour.additionalProperties, false);
  assert.equal(hour.properties.cloudCoverPercent.$ref, "#/$defs/cloudCoverField");
  assert.equal(hour.properties.windSpeedMps.$ref, "#/$defs/windSpeedField");
  assert.equal(schema.$defs.cloudCover.oneOf[0].maximum, 100);
  assert.equal(schema.$defs.windSpeed.oneOf[0].maximum, 150);
  assert.equal(schema.$defs.cloudCoverField.allOf[1].not.properties.mode.const, "adjusted");
});
