import assert from "node:assert/strict";
import test from "node:test";

import {
  airQualityBand,
  buildCurrentUrl,
  buildDailyPrecipitationUrl,
  buildForecastUrl,
  buildHistoryUrl,
  buildTidesUrl,
  buildTrendsUrl,
  DEFAULT_UNIT_PREFERENCES,
  FORECAST_ADJUSTMENT_MODE_STORAGE_KEY,
  forecastMetricValue,
  forecastForSiteDay,
  forecastForSiteDays,
  formatMeasurement,
  fromSiteWallClock,
  humidityBand,
  interpolateForecastInstant,
  loadUnitPreferences,
  parseForecastRecordsResponse,
  pressureBand,
  renderWeatherDashboard,
  temperatureBand,
  tideLevelLabel,
  toSiteWallClock,
  UNIT_PREFERENCE_STORAGE_KEY,
  uvBand,
  WeatherDashboardController,
  windBand,
} from "../dist/index.js";

const site = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  name: "Ballydidean",
  slug: "ballydidean",
  stations: [
    {
      kind: "virtual",
      latitude: 47.950429954185445,
      longitude: -122.42797012608193,
      name: "Open-Meteo virtual station",
      slug: "open-meteo-virtual",
      sources: [
        {
          attribution: {
            label: "Weather data by Open-Meteo",
            url: "https://open-meteo.com/",
          },
          id: "10",
          key: "open-meteo-current-v1",
          kind: "model_current",
          providerKey: "open-meteo",
          providerName: "Open-Meteo",
          provenanceLabel: "model-derived current conditions",
        },
        {
          attribution: {
            label: "Weather data by Open-Meteo",
            url: "https://open-meteo.com/",
          },
          id: "11",
          key: "open-meteo-reanalysis-v1",
          kind: "reanalysis",
          providerKey: "open-meteo",
          providerName: "Open-Meteo",
          provenanceLabel: "historical reanalysis",
        },
        {
          attribution: {
            label: "Weather data by Open-Meteo",
            url: "https://open-meteo.com/",
          },
          id: "12",
          key: "open-meteo-forecast-v1",
          kind: "forecast",
          providerKey: "open-meteo",
          providerName: "Open-Meteo",
          provenanceLabel: "hourly forecast",
        },
      ],
    },
    {
      kind: "physical",
      latitude: 47.95293,
      longitude: -122.41414,
      name: "Fiske Rd & Paris Pl",
      slug: "tempest-38270",
      sources: [
        {
          attribution: {
            label: "Weather data by Tempest",
            url: "https://tempestwx.com/",
          },
          id: "13",
          key: "tempest-38270-observations-v1",
          kind: "physical_sensor",
          providerKey: "weatherflow-tempest",
          providerName: "WeatherFlow Tempest",
          provenanceLabel: "nearby physical station",
        },
      ],
    },
  ],
  timezone: "America/Los_Angeles",
};

// represent an incompatible site selection
const secondSite = {
  ...site,
  name: "Coupeville",
  slug: "coupeville",
  stations: [
    {
      ...site.stations[0],
      slug: "coupeville-virtual",
      sources: [
        {
          ...site.stations[0].sources[0],
          id: "20",
        },
      ],
    },
  ],
};

const record = {
  freshness: {
    ageSeconds: 600,
    label: "Model value is current",
    status: "fresh",
  },
  id: "101",
  metadata: {
    device: { model: "virtual-grid", serial: null, vendor: "Open-Meteo" },
    provider: {
      dataset: "best_match",
      elevationM: 17,
      gridCell: null,
      propertySensors: null,
    },
    quality: null,
    upstream: {
      model: "best_match",
      timezone: "America/Los_Angeles",
    },
  },
  metrics: {
    apparentTemperatureC: 15.5,
    blackGlobeTemperatureC: 18.4,
    cloudCoverPercent: 42,
    pm25MicrogramsPerCubicMeter: 7.4,
    precipitationMm: 0.2,
    precipitationRateMmPerHour: 0.4,
    pressureHpa: 1014.2,
    relativeHumidityPercent: 78,
    soilElectricalConductivityMicrosiemensPerCm: 420,
    soilMoisturePercent: 34,
    solarRadiationWm2: 320,
    temperatureC: 16.2,
    uvIndex: 2,
    windDirectionDegrees: 225,
    windGustMps: 7.2,
    windSpeedMps: 4.1,
    wetBulbGlobeTemperatureC: 14.1,
  },
  productRunAt: null,
  provenance: {
    attribution: {
      label: "Weather data by Open-Meteo",
      url: "https://open-meteo.com/",
    },
    label: "model-derived current conditions",
    providerKey: "open-meteo",
    sourceId: "10",
    sourceKey: "open-meteo-current-v1",
    sourceKind: "model_current",
    stationSlug: "open-meteo-virtual",
  },
  receivedAt: "2026-08-22T04:51:00.000Z",
  revisionCount: 0,
  validAt: "2026-08-22T04:50:00.000Z",
};

const forecastRecord = {
  ...record,
  id: "201",
  productRunAt: "2026-08-22T04:00:00.000Z",
  provenance: {
    ...record.provenance,
    label: "hourly forecast",
    sourceId: "12",
    sourceKey: "open-meteo-forecast-v1",
    sourceKind: "forecast",
  },
  validAt: "2026-08-22T06:00:00.000Z",
};

const physicalRecord = {
  ...record,
  freshness: {
    ageSeconds: 120,
    label: "Station reading is current",
    status: "fresh",
  },
  id: "301",
  metrics: {
    ...record.metrics,
    apparentTemperatureC: 12.2,
    pm25MicrogramsPerCubicMeter: null,
    precipitationRateMmPerHour: 0,
    pressureHpa: 1013.5,
    relativeHumidityPercent: 81,
    temperatureC: 12,
    uvIndex: 1,
    windGustMps: 4.5,
    windSpeedMps: 2.5,
  },
  provenance: {
    ...record.provenance,
    label: "nearby physical station",
    providerKey: "weatherflow-tempest",
    sourceId: "13",
    sourceKey: "tempest-38270-observations-v1",
    sourceKind: "physical_sensor",
    stationSlug: "tempest-38270",
  },
};

const ecowittRecord = {
  ...physicalRecord,
  id: "302",
  metadata: {
    ...physicalRecord.metadata,
    provider: {
      dataset: "get_livedata_info",
      elevationM: null,
      gridCell: null,
      propertySensors: [
        {
          channel: 1,
          key: "soil-1",
          model: "WH52",
          readings: {
            soilMoisturePercent: 42,
            temperatureC: 17.7,
          },
        },
      ],
    },
  },
  metrics: {
    ...physicalRecord.metrics,
    apparentTemperatureC: 9.4,
    pressureHpa: 1012.2,
    relativeHumidityPercent: 88,
    temperatureC: 10,
    uvIndex: 0.5,
    windGustMps: 2,
    windSpeedMps: 1,
  },
  provenance: {
    ...physicalRecord.provenance,
    label: "first-party physical station",
    providerKey: "ecowitt-local",
    sourceId: "14",
    sourceKey: "ecowitt-88f15505d89f-local-live-v1",
    stationSlug: "ballydidean-ecowitt",
  },
};

const trend = {
  metrics: {
    apparentTemperatureC: 15.5,
    precipitationMm: 0.2,
    pressureHpa: 1014.2,
    relativeHumidityPercent: 78,
    temperatureC: 16.2,
    temperatureMaximumC: 19.4,
    temperatureMinimumC: 11.1,
    windDirectionDegrees: 225,
    windGustMps: 7.2,
    windSpeedMps: 4.1,
  },
  validAt: "2026-08-22T04:00:00.000Z",
};

const trendHistory = [
  { ...trend, metrics: { ...trend.metrics, temperatureC: 5, windGustMps: 4 }, validAt: "2019-01-15T08:00:00.000Z" },
  { ...trend, metrics: { ...trend.metrics, temperatureC: 18, windGustMps: 6 }, validAt: "2019-07-15T07:00:00.000Z" },
  { ...trend, metrics: { ...trend.metrics, temperatureC: 7, windGustMps: 5 }, validAt: "2025-01-15T08:00:00.000Z" },
  { ...trend, metrics: { ...trend.metrics, temperatureC: 20, windGustMps: 7 }, validAt: "2025-07-15T07:00:00.000Z" },
  { ...trend, metrics: { ...trend.metrics, temperatureC: 6, windGustMps: 4.5 }, validAt: "2026-01-15T08:00:00.000Z" },
  { ...trend, metrics: { ...trend.metrics, temperatureC: 22, windGustMps: 8 }, validAt: "2026-07-15T07:00:00.000Z" },
];

const dailyPrecipitation = {
  accumulationMm: 2.54,
  source: {
    sourceId: "71",
    stationSlug: "tempest-64255",
  },
  validThrough: "2026-08-22T04:59:00.000Z",
};

const tides = [
  {
    eventType: "low",
    kind: "prediction",
    source: {
      attribution: {
        label: "NOAA Tides & Currents",
        url: "https://tidesandcurrents.noaa.gov/",
      },
      providerKey: "noaa-co-ops",
      stationName: "Glendale Tide Predictions",
      stationSlug: "glendale-tide-predictions",
    },
    validAt: "2026-08-22T00:30:00.000Z",
    waterLevelM: 0.5,
  },
  {
    eventType: null,
    kind: "observation",
    source: {
      attribution: {
        label: "NOAA Tides & Currents",
        url: "https://tidesandcurrents.noaa.gov/",
      },
      providerKey: "noaa-co-ops",
      stationName: "Port Townsend Tide Gauge",
      stationSlug: "port-townsend-tide-gauge",
    },
    validAt: "2026-08-22T04:48:00.000Z",
    waterLevelM: 2.4,
  },
  {
    eventType: null,
    kind: "observation",
    source: {
      attribution: {
        label: "NOAA Tides & Currents",
        url: "https://tidesandcurrents.noaa.gov/",
      },
      providerKey: "noaa-co-ops",
      stationName: "Port Townsend Tide Gauge",
      stationSlug: "port-townsend-tide-gauge",
    },
    validAt: "2026-08-22T04:54:00.000Z",
    waterLevelM: 2.5,
  },
  {
    eventType: "high",
    kind: "prediction",
    source: {
      attribution: {
        label: "NOAA Tides & Currents",
        url: "https://tidesandcurrents.noaa.gov/",
      },
      providerKey: "noaa-co-ops",
      stationName: "Glendale Tide Predictions",
      stationSlug: "glendale-tide-predictions",
    },
    validAt: "2026-08-22T06:30:00.000Z",
    waterLevelM: 3.2,
  },
  {
    eventType: "low",
    kind: "prediction",
    source: {
      attribution: {
        label: "NOAA Tides & Currents",
        url: "https://tidesandcurrents.noaa.gov/",
      },
      providerKey: "noaa-co-ops",
      stationName: "Glendale Tide Predictions",
      stationSlug: "glendale-tide-predictions",
    },
    validAt: "2026-08-22T12:00:00.000Z",
    waterLevelM: 0.4,
  },
];

const adjustmentHashes = {
  bundle: "a".repeat(64),
  candidate: "b".repeat(64),
  report: "c".repeat(64),
  receipt: "d".repeat(64),
  source: "e".repeat(64),
};

// create one exact response runtime
function adjustmentRuntime(state = "active", reasonCode = null) {
  // create one fail-raw runtime
  if (state === "disabled") {
    return {
      activationMode: null,
      activeBundle: null,
      authorizationSha256: null,
      candidateArtifactSha256: null,
      enabledMetrics: [],
      evaluationReportSha256: null,
      expiresAt: null,
      loadedAt: "2026-08-22T05:00:00.000Z",
      qualificationReceiptSha256: null,
      reasonCode,
      state,
      transferReportSha256: null,
    };
  }

  return {
    activationMode: "qualified",
    activeBundle: adjustmentHashes.bundle,
    authorizationSha256: null,
    candidateArtifactSha256: adjustmentHashes.candidate,
    enabledMetrics: ["relativeHumidityPercent", "temperatureC"],
    evaluationReportSha256: adjustmentHashes.report,
    expiresAt: null,
    loadedAt: "2026-08-22T05:00:00.000Z",
    qualificationReceiptSha256: adjustmentHashes.receipt,
    reasonCode: null,
    state: "active",
    transferReportSha256: null,
  };
}

// create one bounded wind-canary runtime
function windCanaryRuntime() {
  return {
    ...adjustmentRuntime(),
    activationMode: "wind_canary",
    authorizationSha256: adjustmentHashes.receipt,
    enabledMetrics: ["windGustMps", "windSpeedMps"],
    evaluationReportSha256: null,
    expiresAt: "2026-09-10T05:00:00.000Z",
    qualificationReceiptSha256: null,
    transferReportSha256: adjustmentHashes.report,
  };
}

// create one exact active row decision
function activeAdjustment(recordValue, targetLeadHours = 1) {
  const referenceAt = new Date(
    Date.parse(recordValue.validAt) - targetLeadHours * 3_600_000,
  ).toISOString();
  return {
    adjustedMetrics: {
      relativeHumidityPercent: recordValue.metrics.relativeHumidityPercent - 5,
      temperatureC: recordValue.metrics.temperatureC + 2,
    },
    algorithmContractVersion: "robust-hierarchical-median/v1",
    appliedMetrics: ["temperatureC", "relativeHumidityPercent"],
    candidateArtifactSha256: adjustmentHashes.candidate,
    contractVersion: "forecast-adjustment-decision/v1",
    evaluationReportSha256: adjustmentHashes.report,
    leadBand: targetLeadHours <= 24 ? "001-024" : "145-168",
    qualificationReceiptSha256: adjustmentHashes.receipt,
    rawForecastProvenance: {
      adapterVersion: "open-meteo-forecast-daily/v4",
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch:
        "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
      dataset: recordValue.metadata.provider.dataset,
      referenceAt,
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: adjustmentHashes.source,
      sourceKey: recordValue.provenance.sourceKey,
      targetLeadHours,
      upstreamModel: recordValue.metadata.upstream.model,
      validAt: recordValue.validAt,
    },
    reasonCode: null,
    state: "active",
  };
}

// create one wind-only active decision
function windCanaryAdjustment(recordValue, targetLeadHours = 1) {
  const qualified = activeAdjustment(recordValue, targetLeadHours);
  return {
    activationKind: "wind_transfer_canary",
    adjustedMetrics: {
      windGustMps: Math.max(0, recordValue.metrics.windGustMps - 2),
      windSpeedMps: recordValue.metrics.windSpeedMps + 0.4,
    },
    algorithmContractVersion: qualified.algorithmContractVersion,
    appliedMetrics: ["windGustMps", "windSpeedMps"],
    authorizationSha256: adjustmentHashes.receipt,
    candidateArtifactSha256: qualified.candidateArtifactSha256,
    contractVersion: qualified.contractVersion,
    leadBand: qualified.leadBand,
    rawForecastProvenance: qualified.rawForecastProvenance,
    reasonCode: null,
    state: "active",
    transferReportSha256: adjustmentHashes.report,
  };
}

// create one exact fail-raw row decision
function failRawAdjustment(state, reasonCode) {
  return {
    adjustedMetrics: {},
    appliedMetrics: [],
    contractVersion: "forecast-adjustment-decision/v1",
    reasonCode,
    state,
  };
}

// create one complete forecast rendering state
function forecastState(records, runtime, forecastDays = 1) {
  return {
    current: [record],
    dailyPrecipitation: null,
    error: null,
    filters: {},
    forecastAdjustmentMode: "adjusted",
    forecast: records,
    forecastAdjustmentRuntime: runtime,
    forecastDays,
    history: [],
    loading: false,
    mapLayer: "roads",
    nextCursor: null,
    page: 0,
    propertyMapLayer: "satellite",
    propertySensorLayout: [],
    selectedPropertySensorKey: null,
    selectedStationSlug: null,
    selectedSite: site,
    selectedTrendMetric: "temperatureC",
    selectedTrendYear: null,
    sites: [site],
    tideGeneratedAt: null,
    tides: [],
    trendDetail: "rolling",
    trendDisplayMode: "aggregate",
    trendExtremeKind: "heat",
    trendExtremeThreshold: 30,
    trendGeneratedAt: null,
    trends: [],
    units: DEFAULT_UNIT_PREFERENCES,
  };
}

test("forecast adjustment boundary preserves raw and validates active metadata", () => {
  const raw = {
    ...forecastRecord,
    futureApiField: { contractVersion: 2 },
    metadata: {
      ...forecastRecord.metadata,
      provider: { ...forecastRecord.metadata.provider, dataset: "forecast" },
    },
    metrics: { ...forecastRecord.metrics, futureMetric: 123 },
  };
  const active = { ...raw, adjustment: activeAdjustment(raw) };
  const parsed = parseForecastRecordsResponse({
    adjustmentRuntime: adjustmentRuntime(),
    data: [active],
    site,
  });
  const parsedRecord = parsed.data[0];

  assert.equal(parsedRecord.metrics.temperatureC, raw.metrics.temperatureC);
  assert.deepEqual(parsedRecord.futureApiField, raw.futureApiField);
  assert.equal(parsedRecord.metrics.futureMetric, raw.metrics.futureMetric);
  assert.equal(forecastMetricValue(parsedRecord, "temperatureC"), raw.metrics.temperatureC + 2);
  assert.equal(forecastMetricValue(parsedRecord, "temperatureC", false), raw.metrics.temperatureC);
  assert.equal(forecastMetricValue(parsedRecord, "pressureHpa"), raw.metrics.pressureHpa);

  const html = renderWeatherDashboard(
    forecastState(parsed.data, parsed.adjustmentRuntime),
    "forecast",
  );
  assert.match(html, /data-forecast-adjustment-available="true"/u);
  assert.match(html, /data-forecast-adjustment-state="active"[\s\S]*Locally adjusted/u);
  assert.match(html, /Raw and adjusted source details[\s\S]*Raw 61\.2 °F[\s\S]*Adjusted 64\.8 °F/u);
  assert.match(html, new RegExp(`Bundle hash[\\s\\S]*${adjustmentHashes.bundle}`, "u"));
  assert.match(html, new RegExp(`Candidate/model hash[\\s\\S]*${adjustmentHashes.candidate}`, "u"));
  assert.match(html, new RegExp(`Report hash[\\s\\S]*${adjustmentHashes.report}`, "u"));
  assert.match(html, new RegExp(`Receipt hash[\\s\\S]*${adjustmentHashes.receipt}`, "u"));
  assert.match(html, new RegExp(`Raw model source hash[\\s\\S]*${adjustmentHashes.source}`, "u"));

  const rawHtml = renderWeatherDashboard(
    {
      ...forecastState(parsed.data, parsed.adjustmentRuntime),
      forecastAdjustmentMode: "raw",
    },
    "forecast",
  );
  assert.match(rawHtml, /class="forecast-adjustment-toggle"[\s\S]*aria-checked="false"[\s\S]*data-forecast-adjustment-toggle/u);
  assert.match(rawHtml, /Regional forecast[\s\S]*Local adjustment turned off/u);
  assert.doesNotMatch(rawHtml, /data-forecast-adjustment-state="active"/u);
});

test("wind canary is explicit, wind-only, and cannot suppress a raw gust warning", () => {
  const raw = {
    ...forecastRecord,
    metadata: {
      ...forecastRecord.metadata,
      provider: { ...forecastRecord.metadata.provider, dataset: "forecast" },
    },
    metrics: {
      ...forecastRecord.metrics,
      windGustMps: 16,
    },
  };
  const parsed = parseForecastRecordsResponse({
    adjustmentRuntime: windCanaryRuntime(),
    data: [{ ...raw, adjustment: windCanaryAdjustment(raw) }],
    site,
  });
  const adjustedHtml = renderWeatherDashboard(
    forecastState(parsed.data, parsed.adjustmentRuntime),
    "home",
  );
  const regionalHtml = renderWeatherDashboard(
    {
      ...forecastState(parsed.data, parsed.adjustmentRuntime),
      forecastAdjustmentMode: "raw",
    },
    "forecast",
  );

  assert.match(adjustedHtml, /Wind adjusted \(canary\)/u);
  assert.match(
    adjustedHtml,
    /temperature and humidity remain regional/iu,
  );
  assert.match(adjustedHtml, /High wind/u);
  assert.doesNotMatch(adjustedHtml, /Wind direction adjusted/u);
  assert.match(
    regionalHtml,
    /forecast-adjustment-toggle-mode">Regional<[\s\S]*Regional[\s\S]*Wind canary turned off/u,
  );
  assert.match(regionalHtml, /Canary expires[\s\S]*2026-09-10T05:00:00\.000Z/u);

  const invalid = parseForecastRecordsResponse({
    adjustmentRuntime: windCanaryRuntime(),
    data: [{ ...raw, adjustment: activeAdjustment(raw) }],
    site,
  });
  assert.equal(invalid.adjustmentRuntime.state, "disabled");
  assert.equal(invalid.adjustmentRuntime.reasonCode, "adjustment_error");
  assert.equal(invalid.data[0].adjustment, undefined);
});

test("inactive and invalid adjustment metadata remain usable raw", () => {
  const raw = {
    ...forecastRecord,
    metadata: {
      ...forecastRecord.metadata,
      provider: { ...forecastRecord.metadata.provider, dataset: "forecast" },
    },
  };
  const inactive = parseForecastRecordsResponse({
    adjustmentRuntime: adjustmentRuntime("disabled", "registry_inactive"),
    data: [{ ...raw, adjustment: failRawAdjustment("disabled", "registry_inactive") }],
    site,
  });
  const inactiveHtml = renderWeatherDashboard(
    forecastState(inactive.data, inactive.adjustmentRuntime),
    "forecast",
  );
  assert.match(
    inactiveHtml,
    /class="forecast-adjustment-toggle"[\s\S]*aria-checked="true"[\s\S]*data-forecast-adjustment-available="false"[\s\S]*data-forecast-adjustment-fallback="true"/u,
  );
  assert.doesNotMatch(inactiveHtml, /\sdisabled(?:\s|>)/u);
  assert.match(inactiveHtml, /Regional fallback[\s\S]*Adjusted mode will apply automatically after the local model qualifies/u);

  const invalid = parseForecastRecordsResponse({
    adjustmentRuntime: adjustmentRuntime(),
    data: [{
      ...raw,
      adjustment: {
        ...activeAdjustment(raw),
        candidateArtifactSha256: "f".repeat(64),
      },
    }],
    site,
  });
  assert.equal(invalid.adjustmentRuntime.state, "disabled");
  assert.equal(invalid.adjustmentRuntime.reasonCode, "adjustment_error");
  assert.equal(invalid.data[0].adjustment, undefined);
  assert.equal(forecastMetricValue(invalid.data[0], "temperatureC"), raw.metrics.temperatureC);
  assert.match(
    renderWeatherDashboard(forecastState(invalid.data, invalid.adjustmentRuntime), "forecast"),
    /Raw forecast[\s\S]*Local adjustment unavailable/u,
  );

  const missing = parseForecastRecordsResponse({ data: [raw], site });
  assert.equal(missing.adjustmentRuntime.reasonCode, "adjustment_error");
  assert.equal(forecastMetricValue(missing.data[0], "temperatureC"), raw.metrics.temperatureC);
});

test("forecast adjustment boundary rejects malformed raw records", () => {
  assert.throws(
    () => parseForecastRecordsResponse({ data: [{}], site }),
    { message: "Forecast response contains an invalid raw record" },
  );
  assert.throws(
    () => parseForecastRecordsResponse({
      data: [{
        ...forecastRecord,
        metrics: { ...forecastRecord.metrics, temperatureC: Number.NaN },
      }],
      site,
    }),
    { message: "Forecast response contains an invalid raw record" },
  );
});

test("extended forecast visibly returns to raw after 168 hours", () => {
  const raw = {
    ...forecastRecord,
    metadata: {
      ...forecastRecord.metadata,
      provider: { ...forecastRecord.metadata.provider, dataset: "forecast" },
    },
  };
  const extendedRaw = {
    ...raw,
    id: "extended-169",
    adjustment: failRawAdjustment("not_applicable", "unsupported_lead"),
    validAt: new Date(Date.parse(raw.validAt) + 169 * 3_600_000).toISOString(),
  };
  const parsed = parseForecastRecordsResponse({
    adjustmentRuntime: adjustmentRuntime(),
    data: [{ ...raw, adjustment: activeAdjustment(raw) }, extendedRaw],
    site,
  });
  const html = renderWeatherDashboard(
    forecastState(parsed.data, parsed.adjustmentRuntime, 10),
    "forecast",
  );

  assert.equal(forecastMetricValue(parsed.data[0], "temperatureC"), raw.metrics.temperatureC + 2);
  assert.equal(forecastMetricValue(parsed.data[1], "temperatureC"), raw.metrics.temperatureC);
  assert.match(html, /Hours 169–240 use the raw regional forecast with no local adjustment/u);
  assert.match(html, /No local adjustment beyond 168 hours/u);

  const invalidActive = parseForecastRecordsResponse({
    adjustmentRuntime: adjustmentRuntime(),
    data: [{
      ...extendedRaw,
      adjustment: activeAdjustment(extendedRaw, 169),
    }],
    site,
  });
  assert.equal(invalidActive.adjustmentRuntime.reasonCode, "adjustment_error");
  assert.equal(invalidActive.data[0].adjustment, undefined);
  assert.equal(forecastMetricValue(invalidActive.data[0], "temperatureC"), raw.metrics.temperatureC);
});

test("dashboard separates current conditions from the historical logs route", () => {
  const state = {
    current: [record, physicalRecord],
    dailyPrecipitation,
    error: "The latest refresh failed",
    filters: {
      sourceId: "10",
      stationSlug: "open-meteo-virtual",
    },
    forecast: [forecastRecord],
    forecastDays: 1,
    history: [record],
    loading: false,
    mapLayer: "roads",
    nextCursor: "next-page",
    page: 0,
    propertyMapLayer: "satellite",
    propertySensorLayout: [
      {
        displayName: "Orchard soil",
        icon: "rain",
        latitude: 47.9505,
        longitude: -122.4281,
        sensorKey: "soil-1",
        updatedAt: "2026-08-22T04:59:00.000Z",
      },
    ],
    selectedPropertySensorKey: null,
    selectedStationSlug: null,
    trendDetail: "rolling",
    trendDisplayMode: "aggregate",
    trendExtremeKind: "heat",
    trendExtremeThreshold: 30,
    selectedTrendMetric: "temperatureC",
    selectedTrendYear: null,
    selectedSite: site,
    sites: [site],
    tideGeneratedAt: "2026-08-22T05:00:00.000Z",
    tides,
    trendGeneratedAt: "2026-08-22T05:00:00.000Z",
    trends: trendHistory,
    units: DEFAULT_UNIT_PREFERENCES,
  };
  const html = renderWeatherDashboard(state);
  const firstPartyHtml = renderWeatherDashboard({
    ...state,
    current: [record, physicalRecord, ecowittRecord],
  });
  const nearFeelsHtml = renderWeatherDashboard({
    ...state,
    current: [{
      ...record,
      metrics: { ...record.metrics, apparentTemperatureC: 16 },
    }],
  });
  const forecastHtml = renderWeatherDashboard(state, "forecast");
  const fiveDayForecastHtml = renderWeatherDashboard({
    ...state,
    forecast: Array.from({ length: 5 },
      // provide one local midnight per extended-range day
      (_, day) => ({
        ...forecastRecord,
        id: `forecast-${String(day)}`,
        validAt: `2026-08-${String(21 + day).padStart(2, "0")}T07:00:00.000Z`,
      }),
    ),
    forecastDays: 5,
  }, "forecast");
  const logsHtml = renderWeatherDashboard(state, "logs");
  const mapHtml = renderWeatherDashboard(state, "map");
  const propertyMapHtml = renderWeatherDashboard({
    ...state,
    current: [ecowittRecord, record, physicalRecord],
  }, "map");
  const selectedPropertyMapHtml = renderWeatherDashboard({
    ...state,
    current: [ecowittRecord, record, physicalRecord],
    selectedPropertySensorKey: "soil-1",
  }, "map");
  const adminHtml = renderWeatherDashboard({
    ...state,
    current: [ecowittRecord],
  }, "admin");
  const settingsHtml = renderWeatherDashboard(state, "settings");
  const trendsHtml = renderWeatherDashboard(state, "trends");
  const windTrendsHtml = renderWeatherDashboard({
    ...state,
    selectedTrendMetric: "windGustMps",
  }, "trends");
  const farmChartsHtml = Object.fromEntries([
    "cumulativePrecipitationMm",
    "temperatureAnomalyC",
    "temperatureRangeC",
    "drySpellDays",
    "growingDegreeDaysC",
    "frostDayCount",
    "extremeDayCount",
    "windDirectionRose",
  ].map(
    // render every farm-focused chart option
    (metric) => [metric, renderWeatherDashboard({
      ...state,
      selectedTrendMetric: metric,
    }, "trends")],
  ));
  const selectedTrendsHtml = renderWeatherDashboard({
    ...state,
    trendDisplayMode: "all",
    selectedTrendYear: 2025,
  }, "trends");
  const allTrendsHtml = renderWeatherDashboard({
    ...state,
    trendDisplayMode: "all",
  }, "trends");
  const dailyTrendsHtml = renderWeatherDashboard({
    ...state,
    trendDetail: "daily",
  }, "trends");
  const denseTrendHistory = [2019, 2025, 2026].flatMap(
    // provide seven consecutive daily points per comparison year
    (year) => [0, 0, 0, 21, 21, 21, 21].map(
      // retain one visible step that a rolling average must smooth
      (temperatureC, day) => ({
        ...trend,
        metrics: { ...trend.metrics, temperatureC },
        validAt: `${String(year)}-01-${String(day + 1).padStart(2, "0")}T20:00:00.000Z`,
      }),
    ),
  );
  const denseRollingTrendsHtml = renderWeatherDashboard({
    ...state,
    trends: denseTrendHistory,
  }, "trends");
  const denseDailyTrendsHtml = renderWeatherDashboard({
    ...state,
    trendDetail: "daily",
    trends: denseTrendHistory,
  }, "trends");
  const loadingHtml = renderWeatherDashboard({
    ...state,
    error: null,
    loading: true,
  });
  const initialLoadingState = {
    ...state,
    current: [],
    dailyPrecipitation: null,
    error: null,
    forecast: [],
    history: [],
    loading: true,
    selectedSite: null,
    sites: [],
    tideGeneratedAt: null,
    tides: [],
    trends: [],
  };
  const initialHomeHtml = renderWeatherDashboard(initialLoadingState);
  const initialForecastHtml = renderWeatherDashboard(initialLoadingState, "forecast");
  const initialLogsHtml = renderWeatherDashboard(initialLoadingState, "logs");
  const initialMapHtml = renderWeatherDashboard(initialLoadingState, "map");
  const initialSettingsHtml = renderWeatherDashboard(initialLoadingState, "settings");
  const initialTrendsHtml = renderWeatherDashboard(initialLoadingState, "trends");
  const alertHtml = renderWeatherDashboard({
    ...state,
    current: [
      {
        ...record,
        metrics: {
          ...record.metrics,
          pm25MicrogramsPerCubicMeter: 40,
        },
      },
    ],
  });

  assert.match(html, /<header class="masthead">[\s\S]*?<h1>Ballydídean Weather<\/h1>/u);
  assert.match(html, /data-forecast-adjustment-toggle/u);
  assert.match(forecastHtml, /data-forecast-adjustment-toggle/u);
  assert.doesNotMatch(logsHtml, /data-forecast-adjustment-toggle/u);
  assert.doesNotMatch(mapHtml, /data-forecast-adjustment-toggle/u);
  assert.doesNotMatch(settingsHtml, /data-forecast-adjustment-toggle/u);
  assert.doesNotMatch(trendsHtml, /data-forecast-adjustment-toggle/u);
  assert.doesNotMatch(html, /brand-link|brand-mark|ballydidean-wide\.svg/u);
  assert.doesNotMatch(html, /aria-label="Weather location"|data-site-selector/u);
  assert.match(html, /class="section-nav-home" href="\/" data-weather-route aria-current="page">[\s\S]*?>home<\/span><\/span><span>Home<\/span><\/a>/u);
  assert.match(html, /class="section-nav-map" href="\/map" data-weather-route>[\s\S]*?>map<\/span><\/span><span>Map<\/span><\/a>/u);
  assert.match(html, /class="section-nav-forecast" href="\/forecast" data-weather-route>[\s\S]*?>partly_cloudy_day<\/span><\/span><span>Forecast<\/span><\/a>/u);
  assert.match(html, /class="section-nav-trends" href="\/trends" data-weather-route>[\s\S]*?>trending_up<\/span><\/span><span>Trends<\/span><\/a>/u);
  assert.match(html, /class="section-nav-settings" href="\/settings" data-weather-route>[\s\S]*?>settings<\/span><\/span><span>Settings<\/span><\/a>/u);
  assert.match(html, /section-nav-home[\s\S]*section-nav-forecast[\s\S]*section-nav-trends[\s\S]*section-nav-map[\s\S]*section-nav-settings/u);
  assert.doesNotMatch(html, /section-nav-logs|href="\/logs"/u);
  assert.doesNotMatch(html, /data-unit-settings-form|<dialog/u);
  assert.doesNotMatch(html, /Current conditions<\/span>|Weather logs|>Units</u);
  assert.doesNotMatch(html, /name="stationSlug"|name="sourceId"|name="sourceKind"/u);
  assert.doesNotMatch(html, /<table/u);
  assert.doesNotMatch(html, /No active local weather watches|class="alert-list"/u);
  assert.match(alertHtml, /<section class="alert-list" aria-label="Conditions to watch">/u);
  assert.doesNotMatch(alertHtml, /Threshold watch|<h2[^>]*>Conditions to watch|alert-strip|alert-disclaimer/u);
  assert.match(alertHtml, /PM2\.5 is 40 µg\/m³/u);
  assert.doesNotMatch(html, /Forecast timeline|Yearly trends|Nearby station map|station-map-panel|data-station-select/u);
  assert.match(forecastHtml, /href="\/forecast" data-weather-route aria-current="page"/u);
  assert.doesNotMatch(forecastHtml, /Forecast timeline|forecast-model|forecast-scrub-help/u);
  assert.match(forecastHtml, /<section class="panel forecast-panel" aria-label="Weather forecast">\s*<div class="forecast-controls">/u);
  assert.match(forecastHtml, /class="forecast-controls">[\s\S]*?class="range-selector forecast-range-selector"[\s\S]*?<\/div>[\s\S]*?<\/div>\s*<div class="forecast-chart-shell">/u);
  assert.match(forecastHtml, /data-forecast-days="1" aria-pressed="true"/u);
  assert.match(forecastHtml, /data-forecast-days="5" aria-pressed="false"/u);
  assert.match(forecastHtml, /data-forecast-days="10" aria-pressed="false"/u);
  assert.equal((forecastHtml.match(/forecast-chart-heading-top/gu) ?? []).length, 8);
  assert.doesNotMatch(forecastHtml, /forecast-chart-heading-bottom/u);
  assert.equal((forecastHtml.match(/class="forecast-chart"/gu) ?? []).length, 8);
  assert.match(forecastHtml, /data-forecast-charts[\s\S]*data-forecast-times=/u);
  assert.match(forecastHtml, /class="forecast-current-time-line"/u);
  assert.match(forecastHtml, /class="forecast-shared-crosshair"/u);
  assert.doesNotMatch(forecastHtml, /forecast-chart-days|forecast-chart-day-start/u);
  assert.equal((fiveDayForecastHtml.match(/class="forecast-chart-days"/gu) ?? []).length, 8);
  assert.equal((fiveDayForecastHtml.match(/class="forecast-chart-day-start"/gu) ?? []).length, 40);
  assert.match(fiveDayForecastHtml, /data-forecast-day="2026-08-21"><b>Fri 21<\/b>/u);
  assert.match(fiveDayForecastHtml, /data-forecast-day="2026-08-25"><b>Tue 25<\/b>/u);
  assert.equal((forecastHtml.match(/class="forecast-chart-daylight"/gu) ?? []).length, 8);
  assert.equal((forecastHtml.match(/<linearGradient id="forecast-line-/gu) ?? []).length, 10);
  assert.match(forecastHtml, /data-forecast-light="day"/u);
  assert.match(forecastHtml, /data-forecast-chart="temperature"[\s\S]*?data-forecast-min="-1\.1111111111"[\s\S]*?data-forecast-max="26\.6666666667"/u);
  assert.match(forecastHtml, /data-forecast-chart="wind"[\s\S]*?data-forecast-min="0"[\s\S]*?data-forecast-max="22\.3519999995"/u);
  assert.match(forecastHtml, /data-forecast-chart="rain-rate"[\s\S]*?data-forecast-min="0"[\s\S]*?data-forecast-max="25\.4"/u);
  assert.match(forecastHtml, /data-forecast-chart="uv-index"[\s\S]*?data-forecast-min="0"[\s\S]*?data-forecast-max="4"/u);
  assert.match(forecastHtml, /data-forecast-chart="tide"[\s\S]*?data-forecast-min="-0\.3048"[\s\S]*?data-forecast-max="3\.6576"/u);
  assert.match(forecastHtml, /data-forecast-chart="uv-index"[\s\S]*?forecast-chart-scale-maximum">4<[\s\S]*?forecast-chart-scale-minimum">0</u);
  assert.match(forecastHtml, /data-forecast-chart="tide"[\s\S]*?forecast-chart-scale-maximum">12 ft<[\s\S]*?forecast-chart-scale-minimum">-1 ft</u);
  assert.doesNotMatch(forecastHtml, /forecast-chart-guide/u);
  assert.match(forecastHtml, /forecast-chart-scale-maximum">80 °F<[\s\S]*forecast-chart-scale-minimum">30 °F</u);
  assert.match(forecastHtml, /forecast-line-air-quality-0[\s\S]*stop-color="rgb\(0, 146, 63\)"/u);
  assert.match(forecastHtml, /data-forecast-chart="temperature"[\s\S]*data-forecast-chart="wind"[\s\S]*data-forecast-chart="rain-rate"[\s\S]*data-forecast-chart="humidity"[\s\S]*data-forecast-chart="air-quality"[\s\S]*data-forecast-chart="uv-index"[\s\S]*data-forecast-chart="pressure"[\s\S]*data-forecast-chart="tide"/u);
  assert.doesNotMatch(forecastHtml, /Drag left or right to scrub time|Swipe vertically to scroll the page/u);
  assert.match(forecastHtml, /class="forecast-x-axis"/u);
  assert.equal((forecastHtml.match(/class="forecast-x-tick"/gu) ?? []).length, 1);
  assert.match(forecastHtml, /data-forecast-weather-map/u);
  assert.match(forecastHtml, /data-forecast-map-scrubber/u);
  assert.match(forecastHtml, /data-forecast-map-layer="radar" aria-pressed="true"/u);
  assert.match(forecastHtml, /data-forecast-map-layer="clouds" aria-pressed="false"/u);
  assert.match(forecastHtml, /data-forecast-map-layer="precipitation" aria-pressed="false"/u);
  assert.match(forecastHtml, /data-forecast-map-layer="wind" aria-pressed="false"/u);
  assert.doesNotMatch(forecastHtml, /data-forecast-map-refresh|forecast-map-refresh-icon/u);
  assert.match(forecastHtml, /data-forecast-map-selection-phase="history"[\s\S]*data-forecast-map-selection-phase-label>Historical</u);
  assert.match(forecastHtml, /data-forecast-map-legend-layer="radar"[\s\S]*data-forecast-map-legend-phase="history"[\s\S]*Radar intensity[\s\S]*dBZ[\s\S]*10[\s\S]*30[\s\S]*50[\s\S]*70\+/u);
  assert.match(forecastHtml, /data-forecast-map-cache-progress[\s\S]*Map cache progress[\s\S]*Caching Radar[\s\S]*data-forecast-map-cache-bar max="7" value="0"[\s\S]*0 of 7 nearby frames ready/u);
  assert.match(forecastHtml, /data-map-tile-url="\/maps\/xweather\/history\/radar\/\d{14}\/10\/256x168\/47\.950430,-122\.427970\.png"/u);
  assert.match(forecastHtml, /Weather maps by Xweather/u);
  assert.doesNotMatch(forecastHtml, /class="forecast-map-heading|class="forecast-map-time"|data-forecast-map-slider|class="forecast-map-phase"|class="forecast-map-attribution"/u);
  assert.ok(
    forecastHtml.indexOf("data-forecast-weather-map") > forecastHtml.indexOf('data-forecast-chart="tide"') &&
      forecastHtml.indexOf("data-forecast-weather-map") < forecastHtml.indexOf("forecast-x-axis"),
  );
  assert.ok(forecastHtml.indexOf("Weather maps by Xweather") > forecastHtml.indexOf('<footer class="credits"'));
  assert.doesNotMatch(fiveDayForecastHtml, /data-forecast-weather-map/u);
  assert.doesNotMatch(forecastHtml, /forecast-hour|forecast-timeline/u);
  assert.doesNotMatch(forecastHtml, /class="current-conditions"|Yearly trends|Nearby station map|<table/u);
  assert.match(trendsHtml, /href="\/trends" data-weather-route aria-current="page"/u);
  assert.doesNotMatch(trendsHtml, /Yearly trends|Calendar comparison/u);
  assert.equal((trendsHtml.match(/class="trend-chart"/gu) ?? []).length, 1);
  assert.match(trendsHtml, /data-trend-chart="temperatureC"[^>]*data-trend-domain="visible"/u);
  const trendDomain = trendsHtml.match(/data-trend-maximum="([^"]+)" data-trend-minimum="([^"]+)" data-trend-domain="visible"/u);
  const allTrendDomain = allTrendsHtml.match(/data-trend-maximum="([^"]+)" data-trend-minimum="([^"]+)" data-trend-domain="visible"/u);
  assert.ok(trendDomain !== null);
  assert.ok(allTrendDomain !== null);
  assert.ok(Math.abs(Number(trendDomain[1]) - ((72 - 32) * 5) / 9) < 0.000_001);
  assert.ok(Math.abs(Number(trendDomain[2]) - 5) < 0.000_001);
  assert.ok(Math.abs(Number(allTrendDomain[1]) - ((72 - 32) * 5) / 9) < 0.000_001);
  assert.ok(Math.abs(Number(allTrendDomain[2]) - 5) < 0.000_001);
  assert.match(trendsHtml, /<div class="trend-metric-control" data-trend-metric-control>[\s\S]*?<h2 class="trend-chart-title">[\s\S]*?<button type="button" class="trend-metric-trigger" data-trend-metric-trigger aria-expanded="false" aria-haspopup="menu" aria-controls="trend-metric-flyover">[\s\S]*?<span>Temperature<\/span>[\s\S]*?class="trend-metric-caret"[\s\S]*?<div class="trend-metric-flyover" id="trend-metric-flyover" role="menu" aria-label="Trend measurement" hidden>[\s\S]*?data-trend-metric-option="temperatureC" role="menuitemradio" aria-checked="true">Temperature<\/button>[\s\S]*?data-trend-metric-option="apparentTemperatureC"[^>]*>Feels like<\/button>[\s\S]*?data-trend-metric-option="windSpeedMps"[^>]*>Wind speed<\/button>[\s\S]*?data-trend-metric-option="windGustMps"[^>]*>Wind gust<\/button>[\s\S]*?data-trend-metric-option="precipitationMm"[^>]*>Daily rain<\/button>[\s\S]*?data-trend-metric-option="relativeHumidityPercent"[^>]*>Humidity<\/button>[\s\S]*?data-trend-metric-option="pressureHpa"[^>]*>Pressure<\/button>/u);
  assert.equal((trendsHtml.match(/data-trend-metric-option=/gu) ?? []).length, 15);
  assert.match(trendsHtml, /class="trend-metric-option-group" role="presentation">[\s\S]*?Measurements[\s\S]*?class="trend-metric-option-group" role="presentation">[\s\S]*?Farm insights/u);
  for (const [metric, chartHtml] of Object.entries(farmChartsHtml)) {
    // require one selectable rendered chart for every recommendation
    assert.match(chartHtml, new RegExp(`data-trend-chart="${metric}"`, "u"));
  }
  assert.match(farmChartsHtml.cumulativePrecipitationMm, /Running annual total/u);
  assert.match(farmChartsHtml.cumulativePrecipitationMm, /data-trend-crosshair-value="2026">0\.02 in<\/output>/u);
  assert.doesNotMatch(farmChartsHtml.cumulativePrecipitationMm, /data-trend-detail-toggle/u);
  assert.match(farmChartsHtml.temperatureAnomalyC, /Versus historical daily average/u);
  assert.match(farmChartsHtml.temperatureAnomalyC, /data-trend-crosshair-value="2026">5 °F<\/output>/u);
  assert.match(farmChartsHtml.temperatureRangeC, /Daily high − low/u);
  assert.match(farmChartsHtml.temperatureRangeC, /data-trend-crosshair-value="2026">15 °F<\/output>/u);
  assert.match(farmChartsHtml.drySpellDays, /Rain below 0\.01 in/u);
  assert.match(farmChartsHtml.drySpellDays, /data-trend-crosshair-value="2026">2 days<\/output>/u);
  assert.match(farmChartsHtml.growingDegreeDaysC, /Base 50 °F/u);
  assert.match(farmChartsHtml.growingDegreeDaysC, /data-trend-crosshair-value="2026">22 °F·days<\/output>/u);
  assert.match(farmChartsHtml.frostDayCount, /Daily low ≤ 32 °F/u);
  assert.match(farmChartsHtml.frostDayCount, /data-trend-crosshair-value="2026">0 days<\/output>/u);
  assert.match(farmChartsHtml.extremeDayCount, /data-trend-extreme-kind[\s\S]*?<option value="heat" selected>Heat<\/option>[\s\S]*?data-trend-extreme-threshold[^>]*value="86\.0"/u);
  assert.match(farmChartsHtml.extremeDayCount, /data-trend-crosshair-value="2026">0 days<\/output>/u);
  assert.equal((farmChartsHtml.windDirectionRose.match(/data-wind-rose-sector=/gu) ?? []).length, 2);
  assert.match(farmChartsHtml.windDirectionRose, /class="trend-wind-rose"[\s\S]*?Wind direction rose comparing historical days with 2026[\s\S]*?aria-label="Wind rose legend"[\s\S]*?Historical[\s\S]*?2026/u);
  assert.equal((farmChartsHtml.windDirectionRose.match(/<li>[^<]+: historical/gu) ?? []).length, 16);
  assert.match(trendsHtml, /<svg[^>]*preserveAspectRatio="none"/u);
  assert.match(trendsHtml, /data-trend-detail="rolling" data-trend-display-mode="aggregate"/u);
  assert.equal((trendsHtml.match(/class="trend-historical-quartile-band"/gu) ?? []).length, 1);
  assert.equal((trendsHtml.match(/class="trend-historical-range-line"/gu) ?? []).length, 2);
  assert.equal((trendsHtml.match(/class="trend-aggregate-median-line"/gu) ?? []).length, 1);
  assert.equal((trendsHtml.match(/class="trend-year-line/gu) ?? []).length, 1);
  assert.equal((trendsHtml.match(/class="trend-year-hit-target/gu) ?? []).length, 0);
  assert.match(trendsHtml, /class="trend-year-line trend-year-line-current"[^>]*data-trend-year="2026"[^>]*stroke="var\(--brand-orange\)"/u);
  assert.match(trendsHtml, /data-trend-mode-toggle aria-pressed="false">[\s\S]*?data-trend-toggle-icon="show-all"[\s\S]*?<span>Show all<\/span><\/button>/u);
  assert.match(trendsHtml, /data-trend-detail-toggle aria-pressed="false">[\s\S]*?data-trend-toggle-icon="daily"[\s\S]*?<span>Daily detail<\/span><\/button>/u);
  assert.equal((allTrendsHtml.match(/class="trend-year-line/gu) ?? []).length, 3);
  assert.equal((allTrendsHtml.match(/class="trend-year-hit-target/gu) ?? []).length, 3);
  assert.equal((allTrendsHtml.match(/trend-year-line-current/gu) ?? []).length, 1);
  assert.match(allTrendsHtml, /data-trend-mode-toggle aria-pressed="true">[\s\S]*?data-trend-toggle-icon="aggregate"[\s\S]*?<span>Aggregate<\/span><\/button>/u);
  assert.match(dailyTrendsHtml, /data-trend-detail="daily" data-trend-display-mode="aggregate"/u);
  assert.match(dailyTrendsHtml, /data-trend-detail-toggle aria-pressed="true">[\s\S]*?data-trend-toggle-icon="rolling"[\s\S]*?<span>7-day average<\/span><\/button>/u);
  assert.match(dailyTrendsHtml, /class="trend-chart-viewport">[\s\S]*class="trend-month-axis"[\s\S]*<\/div>\s*<\/div>\s*<div class="trend-chart-fixed-chrome">[\s\S]*aria-label="Trend measurement"[\s\S]*aria-label="Trend legend"/u);
  assert.equal((dailyTrendsHtml.match(/aria-label="Trend measurement"/gu) ?? []).length, 1);
  assert.equal((dailyTrendsHtml.match(/aria-label="Trend legend"/gu) ?? []).length, 1);
  const denseRollingMedian = denseRollingTrendsHtml.match(/<polyline points="([^"]+)" class="trend-aggregate-median-line"/u);
  const denseDailyMedian = denseDailyTrendsHtml.match(/<polyline points="([^"]+)" class="trend-aggregate-median-line"/u);
  assert.ok(denseRollingMedian !== null);
  assert.ok(denseDailyMedian !== null);
  assert.equal(denseRollingMedian[1]?.trim().split(/\s+/u).length, 7);
  assert.notEqual(denseRollingMedian[1], denseDailyMedian[1]);
  assert.equal((trendsHtml.match(/class="trend-month-label"/gu) ?? []).length, 12);
  assert.equal((trendsHtml.match(/class="trend-y-grid-line"/gu) ?? []).length, 4);
  assert.match(trendsHtml, /class="trend-y-axis" aria-hidden="true">(?:\s*<span>[^<]+<\/span>){5}/u);
  assert.match(trendsHtml, /data-trend-crosshair-slider[\s\S]*role="slider"[\s\S]*aria-label="Annual trend date scrubber"/u);
  assert.match(trendsHtml, /class="trend-crosshair-date-pill" data-trend-crosshair-date datetime="2000-07-15" aria-hidden="true">Jul 15<\/time>/u);
  assert.match(trendsHtml, /data-trend-today-position="0\.636612021858"/u);
  assert.match(trendsHtml, /class="trend-today-marker" aria-hidden="true"><span>Today<\/span>/u);
  assert.equal((trendsHtml.match(/data-trend-crosshair-value=/gu) ?? []).length, 2);
  assert.match(trendsHtml, /<strong>Median<\/strong><output data-trend-crosshair-value="median">66 °F<\/output>/u);
  assert.match(trendsHtml, /data-trend-crosshair-value="2026">72 °F<\/output>/u);
  assert.match(trendsHtml, /class="trend-chart-legend" aria-label="Trend legend"[\s\S]*25th–75th[\s\S]*Historical min\/max[\s\S]*Historical median[\s\S]*trend-current-year-color[\s\S]*2026/u);
  assert.match(allTrendsHtml, /class="trend-year-legend" data-trend-year-select="2019" aria-pressed="false"/u);
  assert.match(selectedTrendsHtml, /class="trend-year-legend trend-year-legend-selected" data-trend-year-select="2025" aria-pressed="true"/u);
  assert.match(selectedTrendsHtml, /data-selected-trend-year="2025"/u);
  assert.equal((selectedTrendsHtml.match(/trend-year-line-selected/gu) ?? []).length, 1);
  assert.equal((selectedTrendsHtml.match(/data-trend-crosshair-value=/gu) ?? []).length, 2);
  assert.match(selectedTrendsHtml, /data-trend-crosshair-value="2025">68 °F<\/output>/u);
  assert.match(selectedTrendsHtml, /data-trend-crosshair-value="2026">72 °F<\/output>/u);
  assert.match(selectedTrendsHtml, /data-trend-year="2026"[\s\S]*data-trend-year="2025"/u);
  assert.match(windTrendsHtml, /data-trend-chart="windGustMps"[\s\S]*?<h2 class="trend-chart-title">[\s\S]*?<span>Wind gust<\/span>[\s\S]*?data-trend-metric-option="windGustMps" role="menuitemradio" aria-checked="true">Wind gust<\/button>/u);
  assert.doesNotMatch(windTrendsHtml, /data-trend-chart="temperatureC"/u);
  assert.doesNotMatch(trendsHtml, /class="current-conditions"|Forecast timeline|Nearby station map|<table/u);
  assert.match(settingsHtml, /href="\/settings" data-weather-route aria-current="page"/u);
  assert.match(settingsHtml, /<section class="unit-settings-page" aria-labelledby="unit-settings-heading">/u);
  assert.match(settingsHtml, /<h2 id="unit-settings-heading">Measurement units<\/h2>/u);
  assert.match(settingsHtml, /class="settings-logs-link" href="\/logs" data-weather-route aria-label="Logs">[\s\S]*?>history<\/span>[\s\S]*?<strong>Logs<\/strong>/u);
  assert.match(settingsHtml, /href="\/admin" aria-label="Admin">[\s\S]*?>settings<\/span>[\s\S]*?<strong>Admin<\/strong>/u);
  assert.doesNotMatch(settingsHtml, /href="\/admin" data-weather-route/u);
  assert.doesNotMatch(settingsHtml, /Property sensors<\/strong>|Name and place/u);
  assert.match(settingsHtml, /data-unit-settings-form/u);
  assert.doesNotMatch(settingsHtml, /<dialog|data-unit-settings-open|data-unit-settings-close/u);
  assert.doesNotMatch(settingsHtml, /class="current-conditions"|Forecast timeline|Yearly trends|Nearby station map|<table/u);
  assert.match(mapHtml, /href="\/map" data-weather-route aria-current="page"/u);
  assert.match(mapHtml, /Nearby station map/u);
  assert.match(mapHtml, /data-map-layer="roads" aria-pressed="true"/u);
  assert.match(mapHtml, /tile\.openstreetmap\.org\/13\//u);
  assert.match(mapHtml, /<image href="https:\/\/tile\.openstreetmap\.org/u);
  assert.match(mapHtml, /<svg class="station-map-svg"[^>]*>[\s\S]*<g class="map-tile-layer"[^>]*>[\s\S]*<g class="station-map-overlay">/u);
  assert.equal((mapHtml.match(/<svg class="station-map-svg"/gu) ?? []).length, 1);
  assert.doesNotMatch(mapHtml, /<image[^>]+style=/u);
  assert.match(mapHtml, /OpenStreetMap contributors/u);
  assert.match(mapHtml, /data-station-select="tempest-38270"/u);
  assert.doesNotMatch(mapHtml, /data-station-current="tempest-38270"/u);
  assert.match(propertyMapHtml, /<h2 id="property-map-heading">Property sensors<\/h2>/u);
  assert.match(propertyMapHtml, /class="property-map-svg"[\s\S]*USGSNAIPImagery[\s\S]*size=1280%2C800[\s\S]*Orchard soil[\s\S]*Temp 63\.9 °F/u);
  assert.match(propertyMapHtml, /class="property-map-layout"[\s\S]*class="property-map"[\s\S]*class="property-sensor-list"/u);
  assert.match(propertyMapHtml, /class="property-sensor-marker-icon">rainy<\/text>/u);
  assert.match(propertyMapHtml, /class="property-sensor-list-icon">[\s\S]*?>rainy<\/span>/u);
  assert.match(propertyMapHtml, /data-property-sensor-view="soil-1"[\s\S]*aria-expanded="false"/u);
  assert.doesNotMatch(propertyMapHtml, /data-property-sensor-details="soil-1"/u);
  assert.match(selectedPropertyMapHtml, /class="property-sensor-marker selected"[\s\S]*aria-expanded="true"/u);
  assert.match(selectedPropertyMapHtml, /data-property-sensor-details="soil-1"[\s\S]*Temp 63\.9 °F[\s\S]*Moisture 42 %[\s\S]*EcoWitt WH52<\/strong> · channel 1 · soil-1[\s\S]*Position<\/strong> 47\.950500, -122\.428100/u);
  assert.match(propertyMapHtml, /USGS and USDA NAIP aerial imagery[\s\S]*The National Map/u);
  assert.doesNotMatch(propertyMapHtml, /USGSImageryOnly\/MapServer\/tile\/1[67]\//u);
  assert.equal((propertyMapHtml.match(/data-property-map-layer=/gu) ?? []).length, 3);
  assert.match(propertyMapHtml, /data-property-interactive-map[\s\S]*data-property-map-world[\s\S]*data-property-map-zoom="in"/u);
  assert.ok(propertyMapHtml.indexOf("property-map-panel") < propertyMapHtml.indexOf("station-map-panel"));
  assert.match(adminHtml, /href="\/settings" data-weather-route aria-current="page"/u);
  assert.match(adminHtml, /data-property-sensor-select="soil-1" aria-pressed="true"/u);
  assert.match(adminHtml, /data-property-sensor-form data-sensor-key="soil-1"/u);
  assert.match(adminHtml, /data-property-position-map/u);
  assert.match(adminHtml, /data-property-map-anchor[\s\S]*class="property-position-marker-pin" d="M0 0/u);
  assert.equal((adminHtml.match(/type="radio" name="icon"/gu) ?? []).length, 4);
  assert.match(adminHtml, /name="icon" value="rain" aria-label="Rain" checked/u);
  assert.match(adminHtml, /data-property-position-marker-icon[^>]*>rainy<\/text>/u);
  assert.match(adminHtml, /class="material-inline-icon"[\s\S]*Save sensor/u);
  assert.doesNotMatch(mapHtml, /class="current-conditions"|Forecast timeline|Yearly trends|<table/u);
  assert.doesNotMatch(html, /Farm sensor map/u);
  assert.match(html, /<section class="current-conditions" aria-label="Current conditions">/u);
  assert.doesNotMatch(
    html,
    /class="panel current-panel"|id="current-heading"|class="freshness|class="provenance"|Right now|Nearby model value/u,
  );
  assert.equal((html.match(/class="condition-card /gu) ?? []).length, 8);
  assert.equal((html.match(/class="condition-color"/gu) ?? []).length, 8);
  assert.equal((html.match(/<rect width="1\.4"/gu) ?? []).length, 0);
  assert.match(html, /class="condition-card temperature-condition" data-condition="temperature"/u);
  assert.match(html, /class="condition-card wind-condition" data-condition="wind"/u);
  assert.match(html, /class="condition-card rain-condition" data-condition="rain"/u);
  assert.match(html, /class="condition-card compact-condition tide-condition" data-condition="tide"/u);
  assert.equal(html.indexOf('data-condition="wind"') < html.indexOf('data-condition="rain"'), true);
  assert.equal(
    ["rain", "tide", "humidity", "air-quality", "pressure", "uv-index"].every(
      // keep every requested card after its predecessor
      (condition, index, conditions) => index === 0 ||
        html.indexOf(`data-condition="${conditions[index - 1]}"`) < html.indexOf(`data-condition="${condition}"`),
    ),
    true,
  );
  assert.match(html, /Feels like/u);
  assert.match(nearFeelsHtml, /Feels like/u);
  assert.match(html, /Gusts/u);
  assert.match(html, /Comfortable outdoor temperature/u);
  assert.match(html, /Peak reading 16 mph/u);
  assert.equal((html.match(/class="condition-secondary-divider"/gu) ?? []).length, 4);
  assert.match(html, /data-condition="tide"[\s\S]*?class="condition-status condition-status-dark">[\s\S]*?<span>High<\/span>[\s\S]*?<div class="condition-primary"><strong>8\.2<small>ft<\/small><\/strong>[\s\S]*?class="condition-secondary-divider">Direction<\/span>[\s\S]*?<strong>Rising<\/strong>/u);
  assert.doesNotMatch(html, /data-condition="tide"[\s\S]*?class="condition-detail">Rising<\/p>/u);
  assert.doesNotMatch(html, /condition-forecast-heading/u);
  assert.equal((html.match(/condition-forecast-tone-green/gu) ?? []).length, 9);
  assert.equal((html.match(/condition-forecast-tone-blue/gu) ?? []).length, 1);
  assert.equal((html.match(/condition-forecast-tone-orange/gu) ?? []).length, 1);
  assert.equal((html.match(/condition-forecast-tone-yellow/gu) ?? []).length, 1);
  assert.equal((html.match(/condition-forecast-tone-neutral/gu) ?? []).length, 2);
  assert.doesNotMatch(html, /Next 24h/u);
  assert.match(html, /data-condition="temperature"[\s\S]*?Max[\s\S]*?61<small>°F[\s\S]*?Min[\s\S]*?61<small>°F[\s\S]*?Max[\s\S]*?60<small>°F[\s\S]*?Min[\s\S]*?60<small>°F/u);
  assert.match(html, /data-condition="wind"[\s\S]*?Max[\s\S]*?9 <small>mph[\s\S]*?Max[\s\S]*?16 <small>mph/u);
  assert.match(html, /data-condition="rain"[\s\S]*?Rain[\s\S]*?Accumulation[\s\S]*?0\.1<small>in[\s\S]*?Max[\s\S]*?0\.02 <small>in\/h[\s\S]*?Total[\s\S]*?0\.01 <small>in/u);
  assert.match(html, /data-condition="air-quality"[\s\S]*?Max[\s\S]*?<strong>7<\/strong>/u);
  assert.doesNotMatch(html, /data-condition="air-quality"[\s\S]*?µg\/m³/u);
  assert.match(html, /data-condition="uv-index"[\s\S]*?Max[\s\S]*?2/u);
  assert.match(html, /data-condition="pressure"[\s\S]*?Max[\s\S]*?\+0\.1<small>%[\s\S]*?Min[\s\S]*?\+0\.1<small>%/u);
  assert.match(html, /data-condition="humidity"[\s\S]*?Max[\s\S]*?78<small>%/u);
  assert.match(html, /data-condition="tide"[\s\S]*?Next low[\s\S]*?5:00 AM/u);
  assert.match(html, /PM2\.5 health range/u);
  assert.match(html, />Good</u);
  assert.match(html, /Minimal sun protection needed/u);
  assert.match(html, /-0\.4–\+0\.9 %/u);
  assert.doesNotMatch(html, /class="current-grid"|class="metric/u);
  assert.doesNotMatch(html, /<article class="condition-card[^>]+style=/u);
  assert.equal((html.match(/class="condition-status-color"/gu) ?? []).length, 8);
  assert.match(html, /data-condition="air-quality"[\s\S]*?class="condition-status condition-status-dark">[\s\S]*?fill="rgb\(0, 146, 63\)"/u);
  assert.match(settingsHtml, /class="material-symbols-rounded" aria-hidden="true">settings<\/span>/u);
  assert.match(html, /data-condition="temperature"[\s\S]*?>device_thermostat<\/span>/u);
  assert.match(html, /data-condition="wind"[\s\S]*?>air<\/span>/u);
  assert.match(html, /data-condition="tide"[\s\S]*?>water<\/span>/u);
  assert.match(html, /https:\/\/open-meteo\.com\//u);
  assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//u);
  assert.match(html, /CC BY 4\.0/u);
  assert.match(html, /<footer class="credits" aria-label="Weather data credits">[\s\S]*?<details>[\s\S]*?<summary>Data sources &amp; credits<\/summary>/u);
  assert.doesNotMatch(html, /<details open/u);
  assert.match(html, /The latest refresh failed/u);
  assert.match(
    loadingHtml,
    /<p class="refresh-indicator active" role="status"><span class="sr-only">Refreshing weather data…<\/span><\/p>/u,
  );
  assert.doesNotMatch(
    loadingHtml,
    /<p class="notice" role="status">Refreshing weather data…<\/p>/u,
  );
  assert.equal((initialHomeHtml.match(/class="[^"]*skeleton-region/gu) ?? []).length, 1);
  assert.equal((initialHomeHtml.match(/class="condition-card [^"]*skeleton-card"/gu) ?? []).length, 8);
  assert.match(initialHomeHtml, /data-condition="rain"[\s\S]*?Accumulation[\s\S]*?Max[\s\S]*?Total/u);
  assert.equal((initialHomeHtml.match(/class="forecast-chart skeleton-forecast-chart"/gu) ?? []).length, 0);
  assert.equal((initialHomeHtml.match(/class="trend-chart skeleton-trend-chart"/gu) ?? []).length, 0);
  assert.equal((initialForecastHtml.match(/class="forecast-chart skeleton-forecast-chart"/gu) ?? []).length, 8);
  assert.equal((initialForecastHtml.match(/forecast-chart-heading forecast-chart-heading-top/gu) ?? []).length, 8);
  assert.match(initialForecastHtml, /Temperature[\s\S]*Wind[\s\S]*Rain rate[\s\S]*Humidity[\s\S]*Air quality[\s\S]*UV index[\s\S]*Pressure[\s\S]*Tide/u);
  assert.match(initialForecastHtml, /class="forecast-weather-map skeleton-forecast-map"/u);
  assert.match(initialForecastHtml, /href="\/maps\/xweather\/history\/radar\/\d{14}\/10\/256x168\/47\.950430,-122\.427970\.png" fetchpriority="high"/u);
  assert.equal((initialForecastHtml.match(/class="forecast-x-tick"/gu) ?? []).length, 24);
  assert.match(initialForecastHtml, /data-forecast-light="night"/u);
  assert.match(initialForecastHtml, /data-forecast-light="day"/u);
  assert.equal((initialTrendsHtml.match(/class="trend-chart skeleton-trend-chart"/gu) ?? []).length, 1);
  assert.match(initialTrendsHtml, /class="trend-metric-control trend-metric-control-skeleton">[\s\S]*?<h2 class="trend-chart-title">Temperature<\/h2>/u);
  assert.doesNotMatch(initialTrendsHtml, /data-trend-metric-control|data-trend-metric-option/u);
  assert.doesNotMatch(initialTrendsHtml, /data-trend-mode-toggle|>Show all<\/button>/u);
  assert.doesNotMatch(initialHomeHtml, /station-map|skeleton-map/u);
  assert.equal((initialMapHtml.match(/class="[^"]*skeleton-region/gu) ?? []).length, 1);
  assert.equal((initialSettingsHtml.match(/class="[^"]*skeleton-region/gu) ?? []).length, 0);
  assert.match(initialMapHtml, /class="station-map skeleton-map"/u);
  assert.doesNotMatch(initialHomeHtml, /No current model value|being collected|No normalized trend buckets/u);
  assert.equal((initialLogsHtml.match(/class="skeleton-history-row"/gu) ?? []).length, 25);
  assert.equal((initialLogsHtml.match(/class="history-card skeleton-history-card"/gu) ?? []).length, 25);
  assert.doesNotMatch(initialLogsHtml, /No records match these filters/u);
  assert.doesNotMatch(html, /skeleton-region|skeleton-history-row|skeleton-history-card/u);
  assert.match(html, /data-condition="temperature"[\s\S]*?<div class="condition-primary"><strong>61<small>°F<\/small>/u);
  assert.match(html, /Feels like[\s\S]*?<strong>60<small>°F<\/small>/u);
  assert.match(html, /data-condition="wind"[\s\S]*?<div class="condition-primary"><strong>9<small>mph SW<\/small>/u);
  assert.match(html, /Gusts[\s\S]*?<strong>16<small>mph<\/small>/u);
  assert.match(html, /data-condition="air-quality"[\s\S]*?<div class="condition-primary"><strong>7<\/strong>/u);
  assert.match(html, /data-condition="pressure"[\s\S]*?<div class="condition-primary"><strong>\+0\.1<small>%<\/small>/u);
  assert.match(firstPartyHtml, /data-condition="temperature"[\s\S]*?<div class="condition-primary"><strong>50<small>°F<\/small>/u);
  assert.match(firstPartyHtml, /data-condition="wind"[\s\S]*?<div class="condition-primary"><strong>2<small>mph SW<\/small>/u);
  const selectedHtml = renderWeatherDashboard({
    ...state,
    selectedStationSlug: "tempest-38270",
  }, "map");
  assert.match(selectedHtml, /data-station-current="tempest-38270"/u);
  assert.match(selectedHtml, /Current conditions for Fiske Rd &amp; Paris Pl/u);
  assert.match(selectedHtml, /<strong>Temp<\/strong> 53\.6 °F/u);
  assert.match(selectedHtml, /<strong>Wind<\/strong> 5\.6 mph · gust 10\.1 mph/u);
  assert.match(selectedHtml, /<strong>Platform<\/strong> WeatherFlow Tempest/u);
  assert.match(selectedHtml, /Station reading is current/u);
  assert.match(logsHtml, /class="section-nav-settings" href="\/settings" data-weather-route aria-current="page"/u);
  assert.doesNotMatch(logsHtml, /section-nav-logs/u);
  assert.doesNotMatch(logsHtml, /id="current-heading"/u);
  assert.match(logsHtml, /name="stationSlug"/u);
  assert.match(logsHtml, /name="sourceId"/u);
  assert.match(logsHtml, /name="sourceKind"/u);
  assert.match(logsHtml, /<th scope="col">Temperature \(°F\)<\/th>/u);
  assert.match(logsHtml, /<th scope="col">Wind \(mph\)<\/th>/u);
  assert.match(logsHtml, /<th scope="col">Precipitation \(in\)<\/th>/u);
  assert.match(logsHtml, /<th scope="col">Source and provenance<\/th>/u);
  assert.match(logsHtml, /aria-label="History pages"/u);
  assert.equal(
    logsHtml.indexOf('class="credits"') > logsHtml.indexOf('id="history-heading"'),
    true,
  );
});

test("measurement formatting uses US consumer defaults and supports every configured alternative", () => {
  assert.deepEqual(
    formatMeasurement(16.2, "temperature", DEFAULT_UNIT_PREFERENCES),
    { unit: "°F", value: "61.2" },
  );
  assert.deepEqual(
    formatMeasurement(4.1, "windSpeed", DEFAULT_UNIT_PREFERENCES),
    { unit: "mph", value: "9.2" },
  );
  assert.deepEqual(
    formatMeasurement(0.2, "precipitation", DEFAULT_UNIT_PREFERENCES),
    { unit: "in", value: "0.01" },
  );
  assert.deepEqual(
    formatMeasurement(1014.2, "pressure", DEFAULT_UNIT_PREFERENCES),
    { unit: "%", value: "+0.1" },
  );
  assert.deepEqual(
    formatMeasurement(16.2, "temperature", DEFAULT_UNIT_PREFERENCES, 0),
    { unit: "°F", value: "61" },
  );
  assert.deepEqual(
    formatMeasurement(4.1, "windSpeed", DEFAULT_UNIT_PREFERENCES, 0),
    { unit: "mph", value: "9" },
  );
  assert.deepEqual(
    formatMeasurement(1014.2, "pressure", DEFAULT_UNIT_PREFERENCES, 0),
    { unit: "%", value: "+0.1" },
  );

  const inchesPressurePreferences = {
    ...DEFAULT_UNIT_PREFERENCES,
    pressure: "inches_of_mercury",
  };
  assert.deepEqual(
    formatMeasurement(1014.2, "pressure", inchesPressurePreferences),
    { unit: "inHg", value: "29.9" },
  );

  const metricPreferences = {
    precipitation: "millimeters",
    pressure: "hectopascals",
    temperature: "celsius",
    waterLevel: "meters",
    windSpeed: "kilometers_per_hour",
  };
  assert.deepEqual(
    formatMeasurement(16.2, "temperature", metricPreferences),
    { unit: "°C", value: "16.2" },
  );
  assert.deepEqual(
    formatMeasurement(4.1, "windSpeed", metricPreferences),
    { unit: "km/h", value: "14.8" },
  );
  assert.deepEqual(
    formatMeasurement(0.2, "precipitation", metricPreferences),
    { unit: "mm", value: "0.2" },
  );
  assert.deepEqual(
    formatMeasurement(1014.2, "pressure", metricPreferences),
    { unit: "hPa", value: "1,014.2" },
  );
  assert.deepEqual(
    formatMeasurement(2.5, "waterLevel", DEFAULT_UNIT_PREFERENCES),
    { unit: "ft", value: "8.2" },
  );
  assert.deepEqual(
    formatMeasurement(2.5, "waterLevel", metricPreferences),
    { unit: "m", value: "2.5" },
  );
});

test("forecast selector timestamps interpolate continuously between hourly samples", () => {
  const times = [
    "2026-08-21T07:00:00.000Z",
    "2026-08-21T08:00:00.000Z",
  ];
  assert.equal(interpolateForecastInstant(times, 0.25), "2026-08-21T07:15:00.000Z");
  assert.equal(interpolateForecastInstant(times, 0.5), "2026-08-21T07:30:00.000Z");
  assert.equal(interpolateForecastInstant(times, 0.75), "2026-08-21T07:45:00.000Z");
});

test("daily forecasts use the site calendar", () => {
  const records = [
    { ...forecastRecord, id: "before", validAt: "2026-08-21T06:59:59.000Z" },
    { ...forecastRecord, id: "start", validAt: "2026-08-21T07:00:00.000Z" },
    { ...forecastRecord, id: "end", validAt: "2026-08-22T06:59:59.000Z" },
    { ...forecastRecord, id: "after", validAt: "2026-08-22T07:00:00.000Z" },
  ];
  assert.deepEqual(
    forecastForSiteDay(
      records,
      "2026-08-22T04:50:00.000Z",
      "America/Los_Angeles",
    ).map((entry) => entry.id),
    ["start", "end"],
  );
  assert.deepEqual(
    forecastForSiteDays(
      [
        ...records,
        { ...forecastRecord, id: "day-five", validAt: "2026-08-25T07:00:00.000Z" },
        { ...forecastRecord, id: "day-six", validAt: "2026-08-26T07:00:00.000Z" },
      ],
      "2026-08-22T04:50:00.000Z",
      "America/Los_Angeles",
      5,
    ).map((entry) => entry.id),
    ["start", "end", "after", "day-five"],
  );
});

test("current condition bands follow requested weather and health thresholds", () => {
  assert.equal(temperatureBand(0).color, "rgb(56, 120, 197)");
  assert.equal(temperatureBand((60 - 32) * 5 / 9).color, "rgb(67, 151, 86)");
  assert.equal(temperatureBand((80 - 32) * 5 / 9).color, "rgb(207, 67, 55)");
  assert.notEqual(temperatureBand(10).color, temperatureBand(0).color);
  assert.equal(windBand(10 / 2.236_936_292_1, null).color, "rgb(67, 151, 86)");
  assert.equal(windBand(null, 50 / 2.236_936_292_1).color, "rgb(207, 67, 55)");
  assert.equal(windBand(null, 51 / 2.236_936_292_1).label, "Dangerous");
  assert.equal(
    windBand(4.1, 7.2, {
      precipitation: "millimeters",
      pressure: "hectopascals",
      temperature: "celsius",
      waterLevel: "meters",
      windSpeed: "meters_per_second",
    }).detail,
    "Peak reading 7 m/s",
  );
  assert.deepEqual(
    [9, 9.1, 35.5, 55.5, 125.5, 225.5].map(
      // collect every EPA particulate band
      (value) => airQualityBand(value).label,
    ),
    ["Good", "Moderate", "Sensitive groups", "Unhealthy", "Very unhealthy", "Hazardous"],
  );
  assert.deepEqual(
    [2, 3, 6, 8, 11].map(
      // collect every EPA UV band
      (value) => uvBand(value).label,
    ),
    ["Low", "Moderate", "High", "Very high", "Extreme"],
  );
  assert.equal(pressureBand(1_008.9).label, "Low");
  assert.equal(pressureBand(1_014.2).label, "Normal");
  assert.equal(pressureBand(1_022.8).label, "High");
  assert.equal(
    pressureBand(1_014.2, {
      precipitation: "millimeters",
      pressure: "hectopascals",
      temperature: "celsius",
      waterLevel: "meters",
      windSpeed: "meters_per_second",
    }).detail,
    "1,009.0–1,022.7 hPa",
  );
  assert.deepEqual(
    [29, 30, 60, 61, 71, 81].map(
      // collect every humidity comfort band
      (value) => humidityBand(value).color,
    ),
    [
      "rgb(200, 183, 68)",
      "rgb(67, 151, 86)",
      "rgb(67, 151, 86)",
      "rgb(230, 181, 25)",
      "rgb(239, 126, 31)",
      "rgb(207, 67, 55)",
    ],
  );
  assert.equal(tideLevelLabel(tides[2], tides), "High");
  assert.equal(tideLevelLabel({ ...tides[2], waterLevelM: 1.8 }, tides), "Medium");
  assert.equal(tideLevelLabel({ ...tides[2], waterLevelM: 0.7 }, tides), "Low");
});

test("controller loads validated unit preferences and persists changes", () => {
  const values = new Map([
    [
      UNIT_PREFERENCE_STORAGE_KEY,
      JSON.stringify({
        precipitation: "millimeters",
        pressure: "unsupported",
        temperature: "celsius",
        windSpeed: "meters_per_second",
      }),
    ],
  ]);
  const storage = {
    // read one stored value
    getItem(key) {
      return values.get(key) ?? null;
    },
    // write one stored value
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const controller = new WeatherDashboardController({ storage });

  assert.deepEqual(controller.state.units, {
    precipitation: "millimeters",
    pressure: "atmosphere_percent",
    temperature: "celsius",
    waterLevel: "feet",
    windSpeed: "meters_per_second",
  });
  controller.setUnitPreferences({
    precipitation: "inches",
    pressure: "hectopascals",
    temperature: "fahrenheit",
    waterLevel: "meters",
    windSpeed: "kilometers_per_hour",
  });
  assert.deepEqual(
    loadUnitPreferences(storage),
    controller.state.units,
  );
  assert.deepEqual(JSON.parse(values.get(UNIT_PREFERENCE_STORAGE_KEY)), {
    precipitation: "inches",
    pressure: "hectopascals",
    temperature: "fahrenheit",
    waterLevel: "meters",
    windSpeed: "kilometers_per_hour",
  });
  assert.equal(controller.state.forecastAdjustmentMode, "adjusted");
  controller.toggleForecastAdjustmentMode();
  assert.equal(controller.state.forecastAdjustmentMode, "raw");
  assert.equal(values.get(FORECAST_ADJUSTMENT_MODE_STORAGE_KEY), "raw");
  assert.equal(new WeatherDashboardController({ storage }).state.forecastAdjustmentMode, "raw");
});

test("new wind-canary sessions default regional while explicit opt-in persists", async () => {
  const values = new Map();
  const storage = {
    // read one stored choice
    getItem(key) {
      return values.get(key) ?? null;
    },
    // write one stored choice
    setItem(key, value) {
      values.set(key, value);
    },
  };
  const raw = {
    ...forecastRecord,
    metadata: {
      ...forecastRecord.metadata,
      provider: { ...forecastRecord.metadata.provider, dataset: "forecast" },
    },
  };

  // serve one complete forecast view
  async function fetcher(input) {
    const url = String(input);

    // serve the current row
    if (url.includes("/current")) {
      return Response.json({ data: [record], site });
    }

    // serve the wind canary
    if (url.includes("/forecast")) {
      return Response.json({
        adjustmentRuntime: windCanaryRuntime(),
        data: [{ ...raw, adjustment: windCanaryAdjustment(raw) }],
        site,
      });
    }

    return Response.json({ data: [], generatedAt: "2026-09-03T05:00:00.000Z", site });
  }

  const controller = new WeatherDashboardController({ fetcher, storage, view: "forecast" });
  await controller.initialize();
  assert.equal(controller.state.forecastAdjustmentMode, "raw");
  assert.equal(values.has(FORECAST_ADJUSTMENT_MODE_STORAGE_KEY), false);

  controller.toggleForecastAdjustmentMode();
  assert.equal(controller.state.forecastAdjustmentMode, "adjusted");
  assert.equal(values.get(FORECAST_ADJUSTMENT_MODE_STORAGE_KEY), "adjusted");

  const restored = new WeatherDashboardController({ fetcher, storage, view: "forecast" });
  await restored.initialize();
  assert.equal(restored.state.forecastAdjustmentMode, "adjusted");
});

test("weather URLs use the versioned API and frozen query contracts", () => {
  const filters = {
    from: "2026-08-01T00:00:00.000Z",
    sourceId: "11",
    sourceKind: "reanalysis",
    stationSlug: "open-meteo-virtual",
    to: "2026-08-22T00:00:00.000Z",
  };
  const current = new URL(
    buildCurrentUrl("/api/v1/", "ballydidean", filters),
    "http://weather.test",
  );
  const dailyPrecipitationUrl = new URL(
    buildDailyPrecipitationUrl("/api/v1/", "ballydidean"),
    "http://weather.test",
  );
  const history = new URL(
    buildHistoryUrl("/api/v1/", "ballydidean", filters, "opaque cursor"),
    "http://weather.test",
  );
  const forecast = new URL(
    buildForecastUrl("/api/v1/", "ballydidean"),
    "http://weather.test",
  );
  const tenDayForecast = new URL(
    buildForecastUrl("/api/v1/", "ballydidean", 10),
    "http://weather.test",
  );
  const trends = new URL(
    buildTrendsUrl("/api/v1/", "ballydidean"),
    "http://weather.test",
  );
  const tidesUrl = new URL(
    buildTidesUrl("/api/v1/", "ballydidean"),
    "http://weather.test",
  );

  assert.equal(current.pathname, "/api/v1/sites/ballydidean/current");
  assert.equal(current.searchParams.get("station"), "open-meteo-virtual");
  assert.equal(current.searchParams.get("source"), "11");
  assert.equal(current.searchParams.has("from"), false);
  assert.equal(dailyPrecipitationUrl.pathname, "/api/v1/sites/ballydidean/daily-precipitation");
  assert.equal(dailyPrecipitationUrl.search, "");
  assert.equal(history.pathname, "/api/v1/sites/ballydidean/history");
  assert.equal(history.searchParams.get("station"), "open-meteo-virtual");
  assert.equal(history.searchParams.get("source"), "11");
  assert.equal(history.searchParams.get("sourceKind"), "reanalysis");
  assert.equal(history.searchParams.has("kind"), false);
  assert.equal(history.searchParams.get("cursor"), "opaque cursor");
  assert.equal(history.searchParams.get("limit"), "25");
  assert.equal(forecast.pathname, "/api/v1/sites/ballydidean/forecast");
  assert.equal(forecast.search, "");
  assert.equal(tenDayForecast.pathname, "/api/v1/sites/ballydidean/forecast");
  assert.equal(tenDayForecast.searchParams.get("days"), "10");
  assert.equal(trends.pathname, "/api/v1/sites/ballydidean/trends");
  assert.equal(trends.search, "");
  assert.equal(tidesUrl.pathname, "/api/v1/sites/ballydidean/tides");
  assert.equal(tidesUrl.search, "");
});

test("history wall clocks use the selected site timezone instead of the browser timezone", () => {
  const browserTimezone = process.env.TZ;
  process.env.TZ = "UTC";

  try {
    assert.equal(
      fromSiteWallClock("2026-08-21T21:30", "America/Los_Angeles"),
      "2026-08-22T04:30:00.000Z",
    );
    assert.equal(
      toSiteWallClock("2026-08-22T04:30:00.000Z", "America/Los_Angeles"),
      "2026-08-21T21:30",
    );
    assert.notEqual(
      new Date("2026-08-21T21:30").toISOString(),
      fromSiteWallClock("2026-08-21T21:30", "America/Los_Angeles"),
    );
    assert.throws(
      () => fromSiteWallClock("2026-03-08T02:30", "America/Los_Angeles"),
      /not valid in the site timezone/u,
    );
    assert.throws(
      // reject repeated fall-back minutes
      () => fromSiteWallClock("2026-11-01T01:30", "America/Los_Angeles"),
      /not valid in the site timezone/u,
    );
  } finally {
    // restore the process timezone
    if (browserTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = browserTimezone;
    }
  }
});

test("logs controller filters history without loading current conditions", async () => {
  const requested = [];

  // serve deterministic browser contracts
  async function fetcher(input) {
    const url = String(input);
    requested.push(url);

    // return site metadata
    if (url.endsWith("/api/v1/sites")) {
      return Response.json({ data: [site] });
    }

    // return current conditions
    if (url.includes("/current")) {
      return Response.json({ data: [record], site });
    }

    // return today's rain accumulation
    if (url.includes("/daily-precipitation")) {
      return Response.json({
        data: dailyPrecipitation,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
    }

    // return normalized forecast data
    if (url.includes("/forecast")) {
      return Response.json({ data: [forecastRecord], site });
    }

    // return observed and predicted tides
    if (url.includes("/tides")) {
      return Response.json({
        data: tides,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
    }

    // return recent trend buckets
    if (url.includes("/trends")) {
      return Response.json({ data: [trend], range: "24h", site });
    }

    const nextCursor = url.includes("cursor=") ? null : "page-two";
    return Response.json({
      data: [record],
      page: { limit: 100, nextCursor },
      site,
    });
  }

  const controller = new WeatherDashboardController({
    fetcher,
    view: "logs",
  });
  await controller.initialize();
  await controller.setFilters({
    sourceId: "11",
    sourceKind: "reanalysis",
    stationSlug: "open-meteo-virtual",
  });
  await controller.nextPage();

  assert.equal(controller.state.selectedSite?.slug, "ballydidean");
  assert.equal(controller.state.current.length, 0);
  assert.equal(controller.state.page, 1);
  assert.equal(controller.state.nextCursor, null);
  assert.equal(requested.some((url) => url.includes("/current")), false);
  assert.equal(requested.some((url) => url.includes("/daily-precipitation")), false);
  assert.ok(
    requested.some(
      // require history selection filters
      (url) =>
        url.includes("sourceKind=reanalysis") &&
        url.includes("cursor=page-two"),
    ),
  );
});

test("settings controller loads browser preferences without weather requests", async () => {
  let requests = 0;

  // reject every unexpected network request
  async function fetcher() {
    requests += 1;
    throw new Error("settings should remain local");
  }

  const controller = new WeatherDashboardController({ fetcher, view: "settings" });
  await controller.initialize();

  assert.equal(requests, 0);
  assert.equal(controller.state.loading, false);
  assert.equal(controller.state.error, null);
});

test("controller retains last-good data through failure and clears the error on recovery", async () => {
  let failReads = false;

  // toggle deterministic API failure
  async function fetcher(input) {
    const url = String(input);

    // retain site discovery
    if (url.endsWith("/api/v1/sites")) {
      return Response.json({ data: [site] });
    }

    // fail one refresh cycle
    if (failReads) {
      return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    }

    // return current data
    if (url.includes("/current")) {
      return Response.json({ data: [record], site });
    }

    // return today's rain accumulation
    if (url.includes("/daily-precipitation")) {
      return Response.json({
        data: dailyPrecipitation,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
    }

    // return normalized forecast data
    if (url.includes("/forecast")) {
      return Response.json({ data: [forecastRecord], site });
    }

    // return observed and predicted tides
    if (url.includes("/tides")) {
      return Response.json({
        data: tides,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
    }

    // return recent trend buckets
    if (url.includes("/trends")) {
      return Response.json({ data: [trend], range: "24h", site });
    }

    return Response.json({
      data: [record],
      page: { limit: 100, nextCursor: null },
      site,
    });
  }

  const controller = new WeatherDashboardController({ fetcher });
  await controller.initialize();
  failReads = true;
  await controller.loadSelectedSite();

  assert.equal(controller.state.current[0]?.id, "101");
  assert.equal(controller.state.dailyPrecipitation?.accumulationMm, 2.54);
  assert.equal(controller.state.history.length, 0);
  assert.match(controller.state.error ?? "", /status 503/u);

  failReads = false;
  await controller.loadSelectedSite();

  assert.equal(controller.state.error, null);
  assert.equal(controller.state.current[0]?.id, "101");
});

test("controller requests the fixed Ballydidean product without site discovery", async () => {
  const requested = [];

  // serve two incompatible site records
  async function fetcher(input) {
    const url = String(input);
    requested.push(url);

    // return one current row
    if (url.includes("/current")) {
      return Response.json({ data: [record], site });
    }

    // return today's rain accumulation
    if (url.includes("/daily-precipitation")) {
      return Response.json({
        data: dailyPrecipitation,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
    }

    // return normalized forecast data
    if (url.includes("/forecast")) {
      return Response.json({ data: [forecastRecord], site });
    }

    // return observed and predicted tides
    if (url.includes("/tides")) {
      return Response.json({
        data: tides,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
    }

    // return recent trend buckets
    if (url.includes("/trends")) {
      return Response.json({ data: [trend], range: "24h", site });
    }

    return Response.json({
      data: [record],
      page: { limit: 100, nextCursor: null },
      site,
    });
  }

  const controller = new WeatherDashboardController({ fetcher });
  await controller.initialize();

  assert.equal(controller.state.selectedSite?.slug, "ballydidean");
  assert.equal(requested.some((url) => url.endsWith("/api/v1/sites")), false);
  assert.equal(requested.some((url) => url.includes("/coupeville/")), false);
  assert.equal(requested.some((url) => url.includes("/ballydidean/")), true);
  assert.equal(requested.some((url) => url.includes("/daily-precipitation")), true);
});

test("failed next-page reads keep the prior page label and cursor", async () => {
  let failReads = false;

  // serve one successful page then fail pagination
  async function fetcher(input) {
    const url = String(input);

    // return site metadata
    if (url.endsWith("/api/v1/sites")) {
      return Response.json({ data: [site] });
    }

    // preserve current reads
    if (url.includes("/current")) {
      return Response.json({ data: [record], site });
    }

    // fail the attempted next page
    if (failReads) {
      return Response.json({ error: { code: "unavailable" } }, { status: 503 });
    }

    return Response.json({
      data: [record],
      page: { limit: 100, nextCursor: "page-two" },
      site,
    });
  }

  const controller = new WeatherDashboardController({ fetcher, view: "logs" });
  await controller.initialize();
  failReads = true;
  await controller.nextPage();

  assert.equal(controller.state.page, 0);
  assert.equal(controller.state.nextCursor, "page-two");
  assert.equal(controller.state.history[0]?.id, "101");
  assert.match(controller.state.error ?? "", /status 503/u);
});
