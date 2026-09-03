import assert from "node:assert/strict";
import test from "node:test";

import { FORECAST_OBSERVATION_MANIFEST_V1 } from "@weather/domain";

import {
  applyCappedCorrection,
  applyCoreAdjustment,
  assessProviderBalancedLosoFold,
  assignUnitNetworkEventWeights,
  compareForecastAtomicCandidatePriority,
  deduplicateForecastAtomicCandidates,
  deduplicateStationLineageSamples,
  deterministicWeightedCircularMedian,
  deterministicWeightedMedian,
  directionNetworkActual,
  createTrainingEnvelope,
  eligibleStationDirection,
  fitCoefficientCell,
  fitRobustHierarchy,
  forecastResidual,
  haversineDistanceMeters,
  isMaterialHarm,
  kishEffectiveEventCount,
  metricPolicyFor,
  corePairedSkill,
  parseSanitizedTrainingExportRow,
  providerBalancedPairedLoss,
  scalarNetworkActual,
  scoreableLosoStations,
  selectClosestInstantSample,
  selectCoveredPrecedingHourGust,
  selectHierarchyCoefficient,
  unnormalizedSpatialWeight,
  withLocalHierarchyFeatures,
  wrap180,
  wrap360,
} from "../dist/index.js";

// create one canonical residual fixture
function residual(index, value, weight = 1) {
  return {
    referenceAt: "2025-01-01T00:00:00.000Z",
    residual: value,
    stableId: `row-${String(index).padStart(4, "0")}`,
    targetLeadHours: 24,
    validAt: new Date(Date.UTC(2025, 0, 2, index)).toISOString(),
    weight,
  };
}

// create one station source sample
function stationSample(observedAt, value, stableId, metric = "temperatureC") {
  return {
    metric,
    observedAt,
    physicalStationKey: "ballydidean-ecowitt",
    sourceKey: "ecowitt-88f15505d89f-local-live-v1",
    stableId,
    value,
  };
}

// create one exact export row fixture
function forecastExportRow(overrides = {}) {
  return {
    adapter_contracts: ["forecast-daily/v4"],
    collision_count: 0,
    content_hashes: ["b".repeat(64)],
    contract_epoch:
      "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
    dataset: "forecast",
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: null,
    provider_family: null,
    record_kind: "legacy_v4_retrieval_snapshot",
    received_at: "2025-01-01T00:01:00.000Z",
    reference_at: "2025-01-01T00:00:00.000Z",
    reference_kind: "retrieval_snapshot",
    relative_humidity_percent: 80,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "ceb83ac4ba3ddc421a31043794ad450a859ecc31643506f93f64a28feb15e5b4",
    ],
    source_keys: ["open-meteo-forecast-v4"],
    target_lead_hours: 24,
    temperature_c: 10,
    upstream_model: "best_match",
    valid_at: "2025-01-02T00:00:00.000Z",
    wind_direction_degrees: 180,
    wind_gust_mps: 8,
    wind_speed_mps: 5,
    ...overrides,
  };
}

// create one fully bound Ecowitt station-hour fixture
function stationExportRow(overrides = {}) {
  return {
    adapter_contracts: ["ecowitt-local-live/v1"],
    collision_count: 0,
    content_hashes: ["b".repeat(64)],
    contract_epoch: "physical-station-hourly/v1",
    dataset: null,
    exclusion_reason_codes: [],
    ingestion_run_ids: ["1"],
    physical_station_key: "ballydidean-ecowitt",
    provider_family: "ecowitt",
    record_kind: "station_hour",
    received_at: "2026-08-20T00:01:00.000Z",
    reference_at: null,
    reference_kind: null,
    relative_humidity_percent: 80,
    site_key: "ballydidean",
    source_config_fingerprints: [
      "0a44488714d0fa807b924f8aea14965b437722e8cf9f8eae4bc8c81da8a0149d",
    ],
    source_keys: ["ecowitt-88f15505d89f-local-live-v1"],
    target_lead_hours: null,
    temperature_c: 10,
    upstream_model: null,
    valid_at: "2026-08-20T00:00:00.000Z",
    wind_direction_degrees: 180,
    wind_gust_mps: 8,
    wind_speed_mps: 5,
    ...overrides,
  };
}

// create one exact MaxWeather source binding
function maxWeatherStationRow(source, validAt) {
  const ambient = source === "ambient";
  return stationExportRow({
    adapter_contracts: [
      ambient ? "ambient-device-data/v1" : "wunderground-pws-history/v1",
    ],
    physical_station_key: "ambient-maxweather",
    provider_family: "ambient",
    source_config_fingerprints: [
      ambient
        ? "7a7528a6278924ca5280a1a6045b6647b7e660b112d7fa3008c542a17ff99df4"
        : "52dda6c5444d0a234fbe23d6218027d417ac966ecf291a7d5dfff42fd0dc207c",
    ],
    source_keys: [
      ambient
        ? "ambient-maxweather-observations-v1"
        : "wunderground-maxweather-history-v1",
    ],
    valid_at: validAt,
  });
}

// verify strict sanitized export parsing and provenance failures
test("parses only exact sanitized forecast export rows", () => {
  const parsed = parseSanitizedTrainingExportRow(forecastExportRow());
  assert.equal(parsed.adapterContracts[0], "forecast-daily/v4");
  assert.equal(parsed.adapterVersion, "open-meteo-forecast-daily/v4");
  assert.equal(parsed.recordKind, "legacy_v4_retrieval_snapshot");
  assert.equal(parsed.dataset, "forecast");
  assert.equal(parsed.upstreamModel, "best_match");
  assert.equal(parsed.targetLeadHours, 24);
  assert.equal(parsed.metrics.temperatureC, 10);
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow({
        ...forecastExportRow(),
        surprise: true,
      }),
    /fields/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        forecastExportRow({ reference_at: "2025-01-02T01:00:00.000Z" }),
      ),
    /lead/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        forecastExportRow({ collision_count: 1 }),
      ),
    /collision/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        forecastExportRow({ dataset: "best_match" }),
      ),
    /cohort evidence/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        forecastExportRow({ upstream_model: "forecast" }),
      ),
    /cohort evidence/u,
  );
});

// accept PostgreSQL microseconds and normalize to milliseconds
test("sanitized rows normalize canonical UTC microseconds", () => {
  const parsed = parseSanitizedTrainingExportRow({
    ...forecastExportRow(),
    received_at: "2025-01-01T00:01:00.000000Z",
    valid_at: "2025-01-02T00:00:00.000000Z",
  });

  assert.equal(parsed.receivedAt, "2025-01-01T00:01:00.000Z");
  assert.equal(parsed.validAt, "2025-01-02T00:00:00.000Z");
});

// verify populated station metrics require complete exact source evidence
test("rejects populated station hours without exact bound lineage", () => {
  assert.equal(
    parseSanitizedTrainingExportRow(stationExportRow()).recordKind,
    "station_hour",
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        stationExportRow({
          adapter_contracts: [],
          content_hashes: [],
          ingestion_run_ids: [],
          received_at: null,
          source_config_fingerprints: [],
          source_keys: [],
        }),
      ),
    /lacks bound source evidence/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        stationExportRow({ source_config_fingerprints: ["f".repeat(64)] }),
      ),
    /source lineage/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        stationExportRow({ adapter_contracts: ["ecowitt-local-live/v2"] }),
      ),
    /source lineage/u,
  );
});

// verify source intervals and the MaxWeather aggregate-hour handoff
test("enforces source intervals and the MaxWeather handoff", () => {
  assert.equal(
    parseSanitizedTrainingExportRow(
      maxWeatherStationRow("wunderground", "2026-08-23T23:00:00.000Z"),
    ).physicalStationKey,
    "ambient-maxweather",
  );
  assert.equal(
    parseSanitizedTrainingExportRow(
      maxWeatherStationRow("ambient", "2026-08-24T00:00:00.000Z"),
    ).physicalStationKey,
    "ambient-maxweather",
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        maxWeatherStationRow("wunderground", "2024-11-28T23:00:00.000Z"),
      ),
    /source lineage/u,
  );
  assert.equal(
    parseSanitizedTrainingExportRow(
      maxWeatherStationRow("wunderground", "2026-08-24T00:00:00.000Z"),
    ).physicalStationKey,
    "ambient-maxweather",
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        maxWeatherStationRow("ambient", "2026-08-23T23:59:59.000Z"),
      ),
    /source lineage/u,
  );
});

// verify superseded Tempest v1 can never fill a v2 gap
test("rejects superseded Tempest v1 station evidence", () => {
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        stationExportRow({
          adapter_contracts: ["tempest-observations/v1"],
          physical_station_key: "tempest-64255",
          provider_family: "tempest",
          source_config_fingerprints: ["f".repeat(64)],
          source_keys: ["tempest-64255-observations-v1"],
          valid_at: "2026-08-20T00:00:00.000Z",
        }),
      ),
    /source lineage/u,
  );
});

// retain rejected-sample diagnostics beside independently selected metrics
test("accepts rejected-sample diagnostics beside selected metrics", () => {
  for (const reason of [
    "metric_ineligible",
    "quality_flag_rejected",
    "quality_status_rejected",
    "source_interval_out_of_range",
    "source_superseded",
  ]) {
    assert.equal(
      parseSanitizedTrainingExportRow(
        stationExportRow({ exclusion_reason_codes: [reason] }),
      ).metrics.temperatureC,
      10,
    );
  }

  assert.equal(
    parseSanitizedTrainingExportRow(
      maxWeatherStationRow("wunderground", "2026-08-23T23:00:00.000Z"),
    ).metrics.temperatureC,
    10,
  );
  assert.equal(
    parseSanitizedTrainingExportRow(
      stationExportRow({
        adapter_contracts: ["tempest-observations/v2"],
        physical_station_key: "tempest-64255",
        provider_family: "tempest",
        source_config_fingerprints: [
          "8eb488a358375fc3526347d9ef6c9f23080095a22ea874a42ec400b0317d868a",
        ],
        source_keys: ["tempest-64255-observations-v2"],
      }),
    ).metrics.windSpeedMps,
    5,
  );
});

// retain diagnostics from discarded samples beside selected hourly metrics
test("accepts calm-sample diagnostics beside a selected direction", () => {
  const parsed = parseSanitizedTrainingExportRow(
    stationExportRow({ exclusion_reason_codes: ["station_direction_calm"] }),
  );

  assert.equal(parsed.metrics.windDirectionDegrees, 180);
  assert.deepEqual(parsed.exclusionReasonCodes, ["station_direction_calm"]);
});

// verify explicit gaps remain missing while populated gaps and collisions reject
test("accepts explicit gaps but rejects populated gaps and collisions", () => {
  const emptyMetrics = {
    relative_humidity_percent: null,
    temperature_c: null,
    wind_direction_degrees: null,
    wind_gust_mps: null,
    wind_speed_mps: null,
  };
  const gap = stationExportRow({
    ...emptyMetrics,
    adapter_contracts: [],
    content_hashes: [],
    exclusion_reason_codes: ["metric_missing", "station_coverage_insufficient"],
    ingestion_run_ids: [],
    received_at: null,
    source_config_fingerprints: [],
    source_keys: [],
  });
  assert.equal(
    parseSanitizedTrainingExportRow(gap).metrics.temperatureC,
    null,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        stationExportRow({
          exclusion_reason_codes: [
            "metric_missing",
            "station_coverage_insufficient",
          ],
          wind_direction_degrees: null,
        }),
      ),
    /gap diagnostics|rejected lineage/u,
  );
  assert.throws(
    () =>
      parseSanitizedTrainingExportRow(
        stationExportRow({ collision_count: 1 }),
      ),
    /collision/u,
  );
});

// verify literal Haversine radius and spatial formula hand oracles
test("uses frozen Haversine and spatial weight constants", () => {
  const longitudeForTwoKilometers =
    (2_000 / 6_371_008.8) * (180 / Math.PI);
  assert.ok(
    Math.abs(
      haversineDistanceMeters(
        { latitude: 0, longitude: 0 },
        { latitude: 0, longitude: longitudeForTwoKilometers },
      ) - 2_000,
    ) < 1e-9,
  );
  assert.equal(unnormalizedSpatialWeight(0), 1);
  assert.equal(unnormalizedSpatialWeight(2_000), 0.5);
  assert.equal(unnormalizedSpatialWeight(4_000), 0.2);
  assert.throws(() => unnormalizedSpatialWeight(-1), /nonnegative/u);

  // recompute every frozen station spatial input
  for (const station of FORECAST_OBSERVATION_MANIFEST_V1.stations) {
    const distance = haversineDistanceMeters(
      FORECAST_OBSERVATION_MANIFEST_V1.site,
      station,
    );
    assert.ok(Math.abs(distance - station.distanceMeters) < 1e-8);
    assert.ok(
      Math.abs(
        unnormalizedSpatialWeight(distance) - station.unnormalizedSpatialWeight,
      ) < 1e-14,
    );
  }
});

// verify closest instant selection and lineage collision rejection
test("selects closest instant samples with earlier ties", () => {
  const samples = [
    stationSample("2025-01-01T11:56:00.000Z", 1, "earlier"),
    stationSample("2025-01-01T12:04:00.000Z", 2, "later"),
    stationSample("2025-01-01T12:05:00.000Z", 3, "excluded-end"),
  ];
  assert.equal(
    selectClosestInstantSample(samples, "2025-01-01T12:00:00.000Z")?.value,
    1,
  );
  assert.equal(
    selectClosestInstantSample(
      [stationSample("2025-01-01T12:05:00.000Z", 3, "excluded-end")],
      "2025-01-01T12:00:00.000Z",
    ),
    null,
  );
  assert.throws(
    () =>
      deduplicateStationLineageSamples([
        stationSample("2025-01-01T12:00:00.000Z", 1, "first"),
        stationSample("2025-01-01T12:00:00.000Z", 2, "second"),
      ]),
    /collision/u,
  );
});

// verify complete preceding-hour gust coverage and gap rejection
test("selects gust maximum only under complete preceding-hour coverage", () => {
  const sampleMinutes = [5, 15, 25, 35, 45, 55, 60];
  const complete = sampleMinutes.map((minutes, index) =>
    stationSample(
      new Date(Date.UTC(2025, 0, 1, 11, minutes)).toISOString(),
      index + 1,
      `gust-${index}`,
      "windGustMps",
    ),
  );
  assert.equal(
    selectCoveredPrecedingHourGust(complete, "2025-01-01T12:00:00.000Z"),
    7,
  );
  assert.equal(
    selectCoveredPrecedingHourGust(
      complete.filter((_sample, index) => index !== 3),
      "2025-01-01T12:00:00.000Z",
    ),
    null,
  );
});

// verify station coverage, weighted median, and vector-strength gates
test("constructs deterministic multi-station network actuals", () => {
  const scalar = scalarNetworkActual([
    {
      nearestRank: 1,
      pairedWindSpeedMps: 2,
      physicalStationKey: "ballydidean-ecowitt",
      unnormalizedSpatialWeight: 1,
      value: 10,
    },
    {
      nearestRank: 2,
      pairedWindSpeedMps: 2,
      physicalStationKey: "tempest-64255",
      unnormalizedSpatialWeight: 0.5,
      value: 20,
    },
    {
      nearestRank: 4,
      physicalStationKey: "tempest-225947",
      unnormalizedSpatialWeight: 0.2,
      value: 30,
    },
  ]);
  assert.equal(scalar?.value, 10);
  assert.ok(Math.abs((scalar?.normalizedWeights[0]?.normalizedWeight ?? 0) - 1 / 1.7) < 1e-15);
  assert.equal(
    scalarNetworkActual([
      {
        nearestRank: 1,
        physicalStationKey: "ballydidean-ecowitt",
        unnormalizedSpatialWeight: 1,
        value: 10,
      },
      {
        nearestRank: 2,
        physicalStationKey: "tempest-64255",
        unnormalizedSpatialWeight: 1,
        value: 20,
      },
    ]),
    null,
  );
  assert.equal(
    scalarNetworkActual([
      {
        nearestRank: 4,
        physicalStationKey: "tempest-225947",
        unnormalizedSpatialWeight: 1,
        value: 10,
      },
      {
        nearestRank: 5,
        physicalStationKey: "tempest-38270",
        unnormalizedSpatialWeight: 1,
        value: 20,
      },
      {
        nearestRank: 6,
        physicalStationKey: "tempest-168853",
        unnormalizedSpatialWeight: 1,
        value: 30,
      },
    ]),
    null,
  );

  const opposed = directionNetworkActual([
    {
      nearestRank: 1,
      pairedWindSpeedMps: 2,
      physicalStationKey: "ballydidean-ecowitt",
      unnormalizedSpatialWeight: 1,
      value: 0,
    },
    {
      nearestRank: 2,
      pairedWindSpeedMps: 2,
      physicalStationKey: "tempest-64255",
      unnormalizedSpatialWeight: 1,
      value: 120,
    },
    {
      nearestRank: 3,
      pairedWindSpeedMps: 2,
      physicalStationKey: "ambient-merlin",
      unnormalizedSpatialWeight: 1,
      value: 240,
    },
  ]);
  assert.equal(opposed, null);
});

// verify direction residuals require both station and forecast non-calm wind
test("excludes calm direction observations and forecasts", () => {
  assert.equal(eligibleStationDirection(180, 0.99), null);
  assert.equal(eligibleStationDirection(180, 1), 180);
  assert.equal(
    forecastResidual({
      actualValue: 1,
      metric: "windDirectionDegrees",
      rawForecastValue: 359,
      rawWindSpeedMps: 1,
    }),
    2,
  );
  assert.equal(
    forecastResidual({
      actualValue: 1,
      metric: "windDirectionDegrees",
      rawForecastValue: 359,
      rawWindSpeedMps: 0.99,
    }),
    null,
  );
});

// verify forecast jitter deduplication and unit event mass
test("deduplicates forecast jitter and assigns one event weight", () => {
  const base = {
    cohort: "legacy_v4_retrieval_snapshot",
    metric: "temperatureC",
    referenceKind: "retrieval_snapshot",
    targetLeadHours: 24,
    validAt: "2025-01-02T00:00:00.000Z",
  };
  const selected = deduplicateForecastAtomicCandidates([
    {
      ...base,
      continuousLeadHours: 23.7,
      referenceAt: "2025-01-01T00:18:00.000Z",
      stableId: "far",
    },
    {
      ...base,
      continuousLeadHours: 23.9,
      referenceAt: "2025-01-01T00:06:00.000Z",
      stableId: "later-id",
    },
    {
      ...base,
      continuousLeadHours: 23.9,
      referenceAt: "2025-01-01T00:06:00.000Z",
      stableId: "earlier-stable-id",
    },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]?.stableId, "earlier-stable-id");
  const weighted = assignUnitNetworkEventWeights(
    selected.map((candidate) => ({ ...candidate, leadBand: "001-024" })),
  );
  assert.equal(weighted[0]?.weight, 1);
  assert.throws(
    () => assignUnitNetworkEventWeights([weighted[0], weighted[0]]),
    /more than once/u,
  );
});

// verify the literal closest reference and stable-id jitter priority
test("orders repeated target-lead jitter by the frozen tie rules", () => {
  const base = {
    cohort: "legacy_v4_retrieval_snapshot",
    metric: "temperatureC",
    referenceKind: "retrieval_snapshot",
    stableId: "z",
    targetLeadHours: 24,
    validAt: "2025-01-02T00:00:00.000Z",
  };
  const far = {
    ...base,
    continuousLeadHours: 23.5,
    referenceAt: "2025-01-01T00:30:00.000Z",
  };
  const close = {
    ...base,
    continuousLeadHours: 23.9,
    referenceAt: "2025-01-01T00:06:00.000Z",
  };
  assert.ok(compareForecastAtomicCandidatePriority(close, far) < 0);
  assert.ok(
    compareForecastAtomicCandidatePriority(
      { ...close, referenceAt: "2025-01-01T00:05:00.000Z" },
      close,
    ) < 0,
  );
  assert.ok(
    compareForecastAtomicCandidatePriority(
      { ...close, stableId: "a" },
      close,
    ) < 0,
  );
});

// verify target lead and cohort remain part of event identity
test("keeps distinct target leads and cohorts as unit-weight events", () => {
  const common = {
    leadBand: "001-024",
    metric: "temperatureC",
    validAt: "2025-01-02T00:00:00.000Z",
  };
  const weighted = assignUnitNetworkEventWeights([
    {
      ...common,
      cohort: "legacy_v4_retrieval_snapshot",
      referenceKind: "retrieval_snapshot",
      sourceSampleCount: 600,
      stationCount: 11,
      targetLeadHours: 23,
    },
    {
      ...common,
      cohort: "legacy_v4_retrieval_snapshot",
      referenceKind: "retrieval_snapshot",
      sourceSampleCount: 60,
      stationCount: 3,
      targetLeadHours: 24,
    },
    {
      ...common,
      cohort: "fixed_lead_anchor",
      referenceKind: "fixed_lead_anchor",
      sourceSampleCount: 1,
      stationCount: 7,
      targetLeadHours: 24,
    },
  ]);
  assert.deepEqual(weighted.map((event) => event.targetLeadHours), [23, 24, 24]);
  assert.deepEqual(weighted.map((event) => event.weight), [1, 1, 1]);
  assert.deepEqual(weighted.map((event) => event.cohort), [
    "legacy_v4_retrieval_snapshot",
    "legacy_v4_retrieval_snapshot",
    "fixed_lead_anchor",
  ]);
  assert.deepEqual(weighted.map((event) => event.stationCount), [11, 3, 7]);
});

// verify scalar and circular estimator tie rules
test("uses exact scalar and circular weighted-median ties", () => {
  assert.equal(
    deterministicWeightedMedian([
      { stableId: "a", value: 1, weight: 1 },
      { stableId: "b", value: 3, weight: 1 },
    ]),
    2,
  );
  assert.equal(
    deterministicWeightedCircularMedian([
      { stableId: "a", value: -10, weight: 100 },
      { stableId: "b", value: 10, weight: 100 },
    ]),
    -10,
  );
  assert.equal(wrap180(180), -180);
  assert.equal(wrap180(-181), 179);
  assert.equal(wrap360(-3), 357);
});

// verify Kish count uses distinct valid events instead of row count
test("computes Kish count from distinct valid-event weights", () => {
  const rows = [
    residual(0, 1, 0.5),
    { ...residual(0, 2, 0.5), stableId: "same-event-second-lead", targetLeadHours: 48 },
    residual(1, 3, 1),
  ];
  assert.equal(kishEffectiveEventCount(rows), 2);
});

// verify literal thresholds, priors, shrinkage, and parent fallback
test("fits exact 200 100 50 hierarchy cell or falls back", () => {
  const scalarPolicy = metricPolicyFor("temperatureC");
  const root = fitCoefficientCell(
    Array.from({ length: 200 }, (_unused, index) => residual(index, 2)),
    {
      direction: false,
      minimumEffectiveEvents: 200,
      parentCoefficient: 0,
      policy: scalarPolicy,
      pseudocount: 200,
    },
  );
  assert.equal(root?.coefficient, 1);
  const season = fitCoefficientCell(
    Array.from({ length: 100 }, (_unused, index) => residual(index, 3)),
    {
      direction: false,
      minimumEffectiveEvents: 100,
      parentCoefficient: 1,
      policy: scalarPolicy,
      pseudocount: 100,
    },
  );
  assert.equal(season?.coefficient, 2);
  const month = fitCoefficientCell(
    Array.from({ length: 50 }, (_unused, index) => residual(index, 4)),
    {
      direction: false,
      minimumEffectiveEvents: 50,
      parentCoefficient: 2,
      policy: scalarPolicy,
      pseudocount: 50,
    },
  );
  assert.equal(month?.coefficient, 3);
  assert.equal(
    fitCoefficientCell(
      Array.from({ length: 49 }, (_unused, index) => residual(index, 4)),
      {
        direction: false,
        minimumEffectiveEvents: 50,
        parentCoefficient: 2,
        policy: scalarPolicy,
        pseudocount: 50,
      },
    ),
    null,
  );

  const direction = fitCoefficientCell(
    [
      ...Array.from({ length: 100 }, (_unused, index) => residual(index, -10)),
      ...Array.from({ length: 100 }, (_unused, index) => residual(index + 100, 10)),
    ],
    {
      direction: true,
      minimumEffectiveEvents: 200,
      parentCoefficient: 0,
      policy: metricPolicyFor("windDirectionDegrees"),
      pseudocount: 200,
    },
  );
  assert.equal(direction?.rawCoefficient, -10);
  assert.equal(direction?.coefficient, -5);
});

// verify hierarchy feature mapping and deepest-cell selection
test("fits and selects the deepest matching local hierarchy cell", () => {
  const rows = Array.from({ length: 200 }, (_unused, index) =>
    withLocalHierarchyFeatures(residual(index, 2)),
  );
  const coefficients = fitRobustHierarchy("temperatureC", "001-024", rows);
  assert.equal(coefficients[0]?.level, 1);
  const selected = selectHierarchyCoefficient(
    coefficients,
    "temperatureC",
    "001-024",
    {
      daypart: rows[0].daypart,
      month: rows[0].month,
      season: rows[0].season,
    },
  );
  const expected = [...coefficients]
    .reverse()
    .find(
      (coefficient) =>
        coefficient.daypart === rows[0].daypart &&
        (coefficient.level === 1 ||
          (coefficient.level === 2 && coefficient.season === rows[0].season) ||
          (coefficient.level === 3 && coefficient.month === rows[0].month)),
    )?.coefficient;
  assert.equal(
    selected,
    expected,
  );
  assert.equal(
    selectHierarchyCoefficient([], "temperatureC", "001-024", {
      daypart: "night",
      month: 1,
      season: "winter",
    }),
    null,
  );
  assert.deepEqual(fitRobustHierarchy("temperatureC", "001-024", []), []);
});

// verify correction caps, final ranges, and direction wrapping
test("applies frozen correction caps before final ranges", () => {
  assert.equal(applyCappedCorrection("temperatureC", 68, 9), 70);
  assert.equal(applyCappedCorrection("relativeHumidityPercent", 95, 25), 100);
  assert.equal(applyCappedCorrection("windSpeedMps", 2, -20), 0);
  assert.equal(applyCappedCorrection("windGustMps", 145, 20), 150);
  assert.equal(applyCappedCorrection("windDirectionDegrees", 350, 90), 35);
  assert.equal(applyCappedCorrection("windDirectionDegrees", 2, -5), 357);
});

// verify training envelopes retain exact inclusive extrema
test("derives inclusive non-direction training envelopes", () => {
  assert.deepEqual(
    createTrainingEnvelope("temperatureC", "001-024", [20, -2, 4]),
    {
      leadBand: "001-024",
      maximum: 20,
      metric: "temperatureC",
      minimum: -2,
    },
  );
  assert.throws(
    () => createTrainingEnvelope("temperatureC", "001-024", []),
    /requires/u,
  );
});

// verify inclusive OOD envelopes and every core fail-raw guard
test("fails raw on identity calendar root calm and envelope guards", () => {
  const base = {
    calendarFingerprintMatches: true,
    coefficient: 1,
    enabled: true,
    envelope: { maximum: 20, minimum: -2 },
    identityMatches: true,
    metric: "temperatureC",
    rawForecastValue: 20,
    rawWindSpeedMps: 3,
    rootAvailable: true,
  };
  assert.deepEqual(applyCoreAdjustment(base), {
    adjustedValue: 21,
    applied: true,
    reason: "adjusted",
  });
  assert.deepEqual(
    applyCoreAdjustment({ ...base, rawForecastValue: 20.01 }),
    {
      adjustedValue: 20.01,
      applied: false,
      reason: "raw_value_ood",
    },
  );
  assert.equal(
    applyCoreAdjustment({ ...base, identityMatches: false }).adjustedValue,
    base.rawForecastValue,
  );
  assert.equal(
    applyCoreAdjustment({ ...base, calendarFingerprintMatches: false }).applied,
    false,
  );
  assert.equal(
    applyCoreAdjustment({ ...base, rootAvailable: false }).reason,
    "root_missing",
  );
  assert.equal(
    applyCoreAdjustment({
      ...base,
      envelope: null,
      metric: "windDirectionDegrees",
      rawForecastValue: 180,
      rawWindSpeedMps: 0.99,
    }).reason,
    "raw_direction_calm",
  );
  assert.equal(
    applyCoreAdjustment({
      ...base,
      envelope: null,
      metric: "windDirectionDegrees",
      rawForecastValue: 180,
      rawWindSpeedMps: 1,
    }).applied,
    true,
  );
});

// verify literal zero-loss skill cases
test("computes paired skill without division substitution", () => {
  assert.equal(corePairedSkill(0, 0), 0);
  assert.equal(corePairedSkill(0, 1), -1);
  assert.equal(corePairedSkill(2, 1), 0.5);
});

// verify station and provider families receive equal hierarchical weight
test("balances LOSO station losses equally within provider family", () => {
  const score = providerBalancedPairedLoss([
    {
      adjustedLoss: 8,
      eventCount: 100,
      physicalStationKey: "tempest-64255",
      providerFamily: "tempest",
      rawLoss: 10,
    },
    {
      adjustedLoss: 2,
      eventCount: 200,
      physicalStationKey: "tempest-38270",
      providerFamily: "tempest",
      rawLoss: 2,
    },
    {
      adjustedLoss: 2,
      eventCount: 300,
      physicalStationKey: "ballydidean-ecowitt",
      providerFamily: "ecowitt",
      rawLoss: 4,
    },
  ]);
  assert.equal(score.rawLoss, 5);
  assert.equal(score.adjustedLoss, 3.5);
  assert.equal(score.skill, 0.3);
  assert.deepEqual(score.providerFamilies, ["ecowitt", "tempest"]);
});

// verify exact LOSO scoreability, diversity, skill, and harm thresholds
test("assesses provider-balanced LOSO thresholds literally", () => {
  const coverage = [
    ["ambient-maxweather", "ambient"],
    ["ambient-merlin", "ambient"],
    ["ballydidean-ecowitt", "ecowitt"],
    ["netatmo-nearby", "netatmo"],
    ["tempest-64255", "tempest"],
  ].map(([physicalStationKey, providerFamily]) => ({
    physicalStationKey,
    providerFamily,
    remainingNetworkScoreEvents: 100,
    scoreMatches: 100,
    trainingMatches: 500,
  }));
  assert.equal(scoreableLosoStations(coverage).length, 5);
  const assessment = assessProviderBalancedLosoFold({
    bootstrapLowerBound: Number.MIN_VALUE,
    coverage,
    materialHarmDetected: false,
    providerBalancedSkill: 0.02,
    stationSkills: coverage.map((station, index) => ({
      physicalStationKey: station.physicalStationKey,
      skill: index === 0 ? -0.01 : 0,
    })),
  });
  assert.equal(assessment.passed, true);
  assert.equal(assessment.nonnegativeStationFraction, 0.8);
  assert.equal(
    assessProviderBalancedLosoFold({
      bootstrapLowerBound: 0,
      coverage,
      materialHarmDetected: false,
      providerBalancedSkill: 0.02,
      stationSkills: coverage.map((station) => ({
        physicalStationKey: station.physicalStationKey,
        skill: 0,
      })),
    }).passed,
    false,
  );
  assert.equal(
    isMaterialHarm({ bootstrapUpperBound: -0.001, eventCount: 100, skill: -0.02 }),
    true,
  );
  assert.equal(
    isMaterialHarm({ bootstrapUpperBound: 0, eventCount: 100, skill: -0.02 }),
    false,
  );
});
