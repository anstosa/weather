import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SOURCE_KINDS,
  backfillChunkKey,
  createBackfillChunkIdentity,
  createNormalizedWeatherRecord,
  isPhysicalMeasurement,
  normalizeMetricValue,
  parseSourceKind,
  serializeSourceMaterial,
  sourceKindLabel,
  validateCoordinates,
  validateTimeZone,
  weatherRecordIdentity,
} from "../dist/index.js";

const baseMetrics = {
  apparentTemperatureC: 8,
  blackGlobeTemperatureC: 18,
  cloudCoverPercent: 75,
  pm25MicrogramsPerCubicMeter: 7,
  precipitationMm: 0,
  precipitationRateMmPerHour: 0,
  pressureHpa: 1012,
  relativeHumidityPercent: 82,
  soilElectricalConductivityMicrosiemensPerCm: 420,
  soilMoisturePercent: 34,
  solarRadiationWm2: 320,
  temperatureC: 9,
  uvIndex: 2,
  waterLevelM: null,
  windDirectionDegrees: 270,
  windGustMps: 9,
  windSpeedMps: 4,
  wetBulbGlobeTemperatureC: 11,
};

const baseMetadata = {
  device: null,
  model: "regional-grid-v1",
  provider: { dataset: "current-grid" },
  quality: { status: "validated" },
  upstreamTimezone: "America/Los_Angeles",
};

const baseLocation = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  siteKey: "ballydidean",
  timezone: "America/Los_Angeles",
};

// verify closed provenance kinds
test("U-DOM-01 parses all source kinds and rejects unknown kinds", () => {
  // inspect every allowed value
  for (const sourceKind of SOURCE_KINDS) {
    assert.equal(parseSourceKind(sourceKind), sourceKind);
  }

  assert.throws(() => parseSourceKind("observation"), /unsupported source kind/u);
});

// verify provenance labels
test("U-DOM-02 separates model and sensor presentation semantics", () => {
  assert.equal(isPhysicalMeasurement("physical_sensor"), true);
  assert.equal(isPhysicalMeasurement("model_current"), false);
  assert.match(sourceKindLabel("model_current"), /model-derived/u);
  assert.match(sourceKindLabel("reanalysis"), /reanalysis/u);
  assert.doesNotMatch(sourceKindLabel("model_current"), /sensor/u);
});

// verify canonical conversions and bounds
test("U-DOM-03 converts canonical units and rejects impossible values", () => {
  assert.equal(normalizeMetricValue("temperatureC", 32, "f"), 0);
  assert.equal(normalizeMetricValue("precipitationMm", 1, "inch"), 25.4);
  assert.equal(normalizeMetricValue("windSpeedMps", 36, "kilometer_per_hour"), 10);
  assert.equal(normalizeMetricValue("windSpeedMps", 10, "mile_per_hour"), 4.4704);
  assert.equal(normalizeMetricValue("pressureHpa", 101_300, "pascal"), 1013);
  assert.ok(
    Math.abs(
      normalizeMetricValue("pressureHpa", 29.92, "inch_of_mercury") -
        1013.207489067664,
    ) < 1e-9,
  );
  assert.equal(normalizeMetricValue("relativeHumidityPercent", 50, "percent"), 50);
  assert.equal(
    normalizeMetricValue(
      "soilElectricalConductivityMicrosiemensPerCm",
      450,
      "microsiemens_per_centimeter",
    ),
    450,
  );
  assert.equal(
    normalizeMetricValue(
      "pm25MicrogramsPerCubicMeter",
      12,
      "microgram_per_cubic_meter",
    ),
    12,
  );
  assert.equal(
    normalizeMetricValue(
      "precipitationRateMmPerHour",
      3.5,
      "millimeter_per_hour",
    ),
    3.5,
  );
  assert.equal(
    normalizeMetricValue("precipitationRateMmPerHour", 1, "inch_per_hour"),
    25.4,
  );
  assert.equal(
    normalizeMetricValue("solarRadiationWm2", 800, "watt_per_square_meter"),
    800,
  );
  assert.equal(normalizeMetricValue("uvIndex", 5, "index"), 5);
  assert.equal(normalizeMetricValue("windDirectionDegrees", 90, "degree"), 90);
  assert.throws(
    () => normalizeMetricValue("relativeHumidityPercent", 101, "percent"),
    /between 0 and 100/u,
  );
  assert.throws(
    () => normalizeMetricValue("windDirectionDegrees", 360, "degree"),
    /less than 360/u,
  );
  assert.throws(
    () => normalizeMetricValue("pm25MicrogramsPerCubicMeter", 1_000, "microgram_per_cubic_meter"),
    /between 0 and 999/u,
  );
  assert.throws(
    () => normalizeMetricValue("temperatureC", 4, "millimeter"),
    /not supported/u,
  );
  assert.throws(() => validateCoordinates(91, 0), /latitude/u);
  assert.throws(() => validateTimeZone("Mars/Olympus"), /unsupported IANA/u);
});

// verify missing values
test("U-DOM-04 preserves null separately from zero", () => {
  assert.equal(normalizeMetricValue("precipitationMm", null, "millimeter"), null);
  assert.equal(normalizeMetricValue("precipitationMm", 0, "millimeter"), 0);
});

// verify stable identity semantics
test("U-DOM-05 record identity is stable across retry and provenance-aware", () => {
  const record = createNormalizedWeatherRecord({
    metadata: baseMetadata,
    metrics: baseMetrics,
    receivedAt: "2026-08-22T04:00:01.000Z",
    sourceId: "source-a",
    sourceKind: "model_current",
    validAt: "2026-08-22T04:00:00.000Z",
  });
  const retried = { ...record, receivedAt: "2026-08-22T04:05:00.000Z" };

  assert.equal(weatherRecordIdentity(record), weatherRecordIdentity(retried));
  assert.notEqual(
    weatherRecordIdentity(record),
    weatherRecordIdentity({ ...record, sourceId: "source-b" }),
  );
  assert.notEqual(
    weatherRecordIdentity(record),
    weatherRecordIdentity({ ...record, sourceKind: "reanalysis" }),
  );
  assert.notEqual(
    weatherRecordIdentity(record),
    weatherRecordIdentity({
      ...record,
      productRunAt: "2026-08-22T00:00:00.000Z",
      sourceKind: "forecast",
    }),
  );
});

// verify UTC and timezone preservation
test("U-DOM-06 preserves UTC instants and provider timezone", () => {
  const record = createNormalizedWeatherRecord({
    metadata: baseMetadata,
    metrics: baseMetrics,
    receivedAt: "2026-08-22T04:00:01Z",
    sourceId: "source-a",
    sourceKind: "model_current",
    validAt: "2026-08-21T21:00:00-07:00",
  });

  assert.equal(record.validAt, "2026-08-22T04:00:00.000Z");
  assert.equal(record.receivedAt, "2026-08-22T04:00:01.000Z");
  assert.equal(record.metadata.upstreamTimezone, "America/Los_Angeles");
});

// verify bounded allowlisted metadata
test("U-DOM-07 bounds metadata and source material serialization", () => {
  assert.throws(
    () =>
      createNormalizedWeatherRecord({
        metadata: { ...baseMetadata, quality: { invented: true } },
        metrics: baseMetrics,
        receivedAt: "2026-08-22T04:00:01.000Z",
        sourceId: "source-a",
        sourceKind: "model_current",
        validAt: "2026-08-22T04:00:00.000Z",
      }),
    /not allowlisted/u,
  );
  assert.throws(
    () =>
      createNormalizedWeatherRecord({
        metadata: { ...baseMetadata, model: "x".repeat(129) },
        metrics: baseMetrics,
        receivedAt: "2026-08-22T04:00:01.000Z",
        sourceId: "source-a",
        sourceKind: "model_current",
        validAt: "2026-08-22T04:00:00.000Z",
      }),
    /at most 128/u,
  );

  const first = serializeSourceMaterial({
    adapterConfig: { beta: 2, alpha: 1 },
    location: baseLocation,
    providerKey: "grid-provider",
    sourceKey: "current-feed",
    sourceKind: "model_current",
    stationKey: "virtual-station",
    version: 1,
  });
  const second = serializeSourceMaterial({
    adapterConfig: { alpha: 1, beta: 2 },
    location: baseLocation,
    providerKey: "grid-provider",
    sourceKey: "current-feed",
    sourceKind: "model_current",
    stationKey: "virtual-station",
    version: 1,
  });

  assert.equal(first, second);
  assert.notEqual(
    first,
    serializeSourceMaterial({
      adapterConfig: { alpha: 1, beta: 2 },
      location: { ...baseLocation, latitude: 47.96 },
      providerKey: "grid-provider",
      sourceKey: "current-feed",
      sourceKind: "model_current",
      stationKey: "virtual-station",
      version: 1,
    }),
  );
  assert.throws(
    () =>
      serializeSourceMaterial({
        adapterConfig: { alpha: 1 },
        providerKey: "grid-provider",
        sourceKey: "current-feed",
        sourceKind: "model_current",
        stationKey: "virtual-station",
        version: 1,
      }),
    /location is required/u,
  );
  assert.throws(
    () => serializeSourceMaterial({
      adapterConfig: { invalid: Number.NaN },
      location: baseLocation,
      providerKey: "grid-provider",
      sourceKey: "current-feed",
      sourceKind: "model_current",
      stationKey: "virtual-station",
      version: 1,
    }),
    /JSON numbers must be finite/u,
  );
  assert.throws(
    () =>
      createNormalizedWeatherRecord({
        metadata: baseMetadata,
        metrics: { ...baseMetrics, inventedMetric: 1 },
        receivedAt: "2026-08-22T04:00:01.000Z",
        sourceId: "source-a",
        sourceKind: "model_current",
        validAt: "2026-08-22T04:00:00.000Z",
      }),
    /complete canonical metric set/u,
  );
});

// verify exact chunk identity
test("exact backfill identity includes all six durable parts", () => {
  const base = createBackfillChunkIdentity({
    adapterVersion: "archive/v1",
    chunkPlanVersion: "archive-hourly/v1",
    intervalEndExclusive: "2026-08-15T07:00:00.000Z",
    intervalStart: "2026-08-01T07:00:00.000Z",
    requestedFromDate: "2026-08-01",
    requestedToDate: "2026-08-14",
    sourceConfigFingerprint: "a".repeat(64),
    sourceId: "source-a",
  });

  assert.equal(backfillChunkKey(base), backfillChunkKey({ ...base }));
  assert.notEqual(
    backfillChunkKey(base),
    backfillChunkKey({ ...base, adapterVersion: "archive/v2" }),
  );
  assert.throws(
    () =>
      createBackfillChunkIdentity({
        ...base,
        intervalEndExclusive: base.intervalStart,
      }),
    /non-empty and increasing/u,
  );
});
