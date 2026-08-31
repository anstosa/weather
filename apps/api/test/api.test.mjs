import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  calendarTrendWindow,
  createWeatherApi,
  createWeatherApiServer,
  readApiRelease,
  siteForecastDayWindow,
} from "../dist/index.js";

const siteRows = [
  {
    attributionLabel: "Weather data by Open-Meteo",
    attributionUrl: "https://open-meteo.com/",
    latitude: 47.950429954185445,
    longitude: -122.42797012608193,
    providerKey: "open-meteo",
    providerName: "Open-Meteo",
    siteName: "Ballydidean",
    siteSlug: "ballydidean",
    sourceId: "10",
    sourceKey: "open-meteo-current-v1",
    sourceKind: "model_current",
    stationKind: "virtual",
    stationLatitude: 47.950429954185445,
    stationLongitude: -122.42797012608193,
    stationName: "Open-Meteo virtual station",
    stationSlug: "open-meteo-virtual",
    timezone: "America/Los_Angeles",
  },
  {
    attributionLabel: "Weather data by Open-Meteo",
    attributionUrl: "https://open-meteo.com/",
    latitude: 47.950429954185445,
    longitude: -122.42797012608193,
    providerKey: "open-meteo",
    providerName: "Open-Meteo",
    siteName: "Ballydidean",
    siteSlug: "ballydidean",
    sourceId: "11",
    sourceKey: "open-meteo-reanalysis-v1",
    sourceKind: "reanalysis",
    stationKind: "virtual",
    stationLatitude: 47.950429954185445,
    stationLongitude: -122.42797012608193,
    stationName: "Open-Meteo virtual station",
    stationSlug: "open-meteo-virtual",
    timezone: "America/Los_Angeles",
  },
  {
    attributionLabel: "Weather data by Open-Meteo",
    attributionUrl: "https://open-meteo.com/",
    latitude: 47.950429954185445,
    longitude: -122.42797012608193,
    providerKey: "open-meteo",
    providerName: "Open-Meteo",
    siteName: "Ballydidean",
    siteSlug: "ballydidean",
    sourceId: "12",
    sourceKey: "open-meteo-forecast-v1",
    sourceKind: "forecast",
    stationKind: "virtual",
    stationLatitude: 47.950429954185445,
    stationLongitude: -122.42797012608193,
    stationName: "Open-Meteo virtual station",
    stationSlug: "open-meteo-virtual",
    timezone: "America/Los_Angeles",
  },
];

const currentRecord = makeRecord({
  id: "101",
  sourceId: "10",
  sourceKind: "model_current",
  sourceKey: "open-meteo-current-v1",
  validAt: "2026-08-22T04:50:00.000Z",
});
const forecastRecord = makeRecord({
  id: "201",
  productRunAt: "2026-08-22T05:00:00.000Z",
  sourceId: "12",
  sourceKind: "forecast",
  sourceKey: "open-meteo-forecast-v1",
  validAt: "2026-08-22T06:00:00.000Z",
});

// create a deterministic storage record
function makeRecord(overrides = {}) {
  return {
    apparentTemperatureC: 15.5,
    blackGlobeTemperatureC: 18.4,
    cloudCoverPercent: 42,
    deviceModel: "virtual-grid",
    deviceSerial: null,
    deviceVendor: "Open-Meteo",
    firstReceivedAt: "2026-08-22T04:51:00.000Z",
    id: "100",
    lastReceivedAt: "2026-08-22T04:51:00.000Z",
    pm25MicrogramsPerCubicMeter: 7,
    precipitationMm: 0.2,
    precipitationRateMmPerHour: 0.4,
    pressureHpa: 1014.2,
    productRunAt: null,
    providerKey: "open-meteo",
    providerMetadata: {
      dataset: "era5",
      elevation_m: 17,
      grid_cell: "47.95,-122.43",
      request_id: "private-request-id",
    },
    qualityMetadata: {
      confidence_percent: 93,
      flags: ["interpolated"],
      interpolation: "linear",
      status: "accepted",
    },
    relativeHumidityPercent: 78,
    revisionCount: 0,
    siteSlug: "ballydidean",
    sourceId: "11",
    sourceKey: "open-meteo-reanalysis-v1",
    sourceKind: "reanalysis",
    stationSlug: "open-meteo-virtual",
    soilElectricalConductivityMicrosiemensPerCm: 420,
    soilMoisturePercent: 34,
    solarRadiationWm2: 320,
    temperatureC: 16.2,
    upstreamModel: "best_match",
    upstreamTimezone: "America/Los_Angeles",
    uvIndex: 2,
    validAt: "2026-08-21T04:00:00.000Z",
    windDirectionDegrees: 225,
    windGustMps: 7.2,
    windSpeedMps: 4.1,
    wetBulbGlobeTemperatureC: 14.1,
    ...overrides,
  };
}

// create an isolated API fixture
function createFixture(overrides = {}, options = {}) {
  const currentQueries = [];
  const dailyPrecipitationQueries = [];
  const forecastQueries = [];
  const historyQueries = [];
  const trendQueries = [];
  const historyRows = [
    makeRecord({ id: "103", validAt: "2026-08-21T03:00:00.000Z" }),
    makeRecord({ id: "102", validAt: "2026-08-21T02:00:00.000Z" }),
    makeRecord({ id: "101", validAt: "2026-08-21T01:00:00.000Z" }),
  ];
  const store = {
    // return today's nearest-gauge accumulation
    async getDailyPrecipitation(siteSlug, from, to) {
      dailyPrecipitationQueries.push({ from, siteSlug, to });
      return {
        accumulationMm: 2.54,
        sourceId: "13",
        stationSlug: "tempest-64255",
        validThrough: "2026-08-22T04:59:00.000Z",
      };
    },
    // return current records
    async getCurrent(siteSlug, filters) {
      currentQueries.push({ filters, siteSlug });
      return [currentRecord];
    },
    // return normalized forecast rows
    async getForecast(siteSlug, asOf, hours) {
      forecastQueries.push({ asOf, hours, siteSlug });
      return [forecastRecord];
    },
    // return safe health state
    async getHealth() {
      return {
        database: "ready",
        migration: { status: "current", version: "0001_initial_weather.sql" },
        workerLastLoopAt: "2026-08-22T04:45:00.000Z",
      };
    },
    // capture history filters
    async listHistory(query) {
      historyQueries.push(query);
      return historyRows;
    },
    // return active metadata
    async listSites() {
      return siteRows;
    },
    // return observed and predicted tide levels
    async listTides() {
      return [{
        attributionLabel: "NOAA Tides & Currents",
        attributionUrl: "https://tidesandcurrents.noaa.gov/",
        predictionType: "H",
        providerKey: "noaa-co-ops",
        sourceId: "42",
        sourceKind: "tide_prediction",
        stationName: "Glendale Tide Predictions",
        stationSlug: "glendale-tide-predictions",
        validAt: "2026-08-22T11:27:00.000Z",
        waterLevelM: 3.271,
      }];
    },
    // return normalized trend buckets
    async listTrends(siteSlug, from, to) {
      trendQueries.push({ from, siteSlug, to });
      return [{
        apparentTemperatureC: 15.5,
        precipitationMm: 0.2,
        pressureHpa: 1014.2,
        relativeHumidityPercent: 78,
        temperatureC: 16.2,
        validAt: new Date("2026-08-22T04:00:00.000Z"),
        windGustMps: 7.2,
        windSpeedMps: 4.1,
      }];
    },
    ...overrides,
  };
  const handler = createWeatherApi(store, {
    // freeze response time
    now: () => new Date("2026-08-22T05:00:00.000Z"),
    version: "2026.08.22-1",
    ...options,
  });
  return {
    currentQueries,
    dailyPrecipitationQueries,
    forecastQueries,
    handler,
    historyQueries,
    trendQueries,
  };
}

test("only exact versioned GET and HEAD routes are public", async () => {
  const { handler } = createFixture();
  const accepted = [
    "/api/v1/sites",
    "/api/v1/sites/ballydidean/current",
    "/api/v1/sites/ballydidean/daily-precipitation",
    "/api/v1/sites/ballydidean/forecast",
    "/api/v1/sites/ballydidean/history",
    "/api/v1/sites/ballydidean/trends",
    "/api/v1/sites/ballydidean/tides",
    "/api/v1/health",
  ];

  // verify every documented route and read method
  for (const path of accepted) {
    // verify both read methods
    for (const method of ["GET", "HEAD"]) {
      const response = await handler(
        new Request(`http://weather.test${path}`, { method }),
      );
      assert.equal(response.status, 200, `${method} ${path}`);

      // require bodyless head responses
      if (method === "HEAD") {
        assert.equal(await response.text(), "");
      }
    }
  }

  const rejected = [
    "/",
    "/sites",
    "/api/sites",
    "/api/v1",
    "/api/v1/sites/",
    "/api/v1/sites/ballydidean",
    "/api/v1/sites/ballydidean/current/extra",
    "/api/v1/sites/Bad/current",
    "/api/v2/sites",
  ];

  // reject every undocumented route
  for (const path of rejected) {
    const response = await handler(new Request(`http://weather.test${path}`));
    assert.equal(response.status, 404, path);
  }
});

test("mutation methods fail on every documented route without store writes", async () => {
  const { handler } = createFixture();
  const paths = [
    "/api/v1/sites",
    "/api/v1/sites/ballydidean/current",
    "/api/v1/sites/ballydidean/forecast",
    "/api/v1/sites/ballydidean/history",
    "/api/v1/sites/ballydidean/trends",
    "/api/v1/sites/ballydidean/tides",
    "/api/v1/health",
  ];

  // verify the complete mutation matrix
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    // verify every documented route
    for (const path of paths) {
      const response = await handler(
        new Request(`http://weather.test${path}`, { method }),
      );
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.get("allow"), "GET, HEAD");
    }
  }
});

test("GET sites groups active sources and retains direct attribution", async () => {
  const { handler } = createFixture();
  const response = await handler(
    new Request("http://weather.test/api/v1/sites"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].slug, "ballydidean");
  assert.equal(body.data[0].stations[0].sources.length, 3);
  assert.equal(body.data[0].stations[0].latitude, 47.950429954185445);
  assert.equal(body.data[0].stations[0].longitude, -122.42797012608193);
  assert.equal(
    body.data[0].stations[0].sources[0].attribution.label,
    "Weather data by Open-Meteo",
  );
  assert.equal(
    body.data[0].stations[0].sources[0].attribution.url,
    "https://open-meteo.com/",
  );
});

test("current accepts station and source and returns bounded public metadata", async () => {
  const { currentQueries, handler } = createFixture();
  const response = await handler(
    new Request(
      "http://weather.test/api/v1/sites/ballydidean/current?station=open-meteo-virtual&source=10",
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(currentQueries[0], {
    filters: { sourceId: "10", stationSlug: "open-meteo-virtual" },
    siteSlug: "ballydidean",
  });
  assert.equal(body.data[0].freshness.status, "fresh");
  assert.equal(body.data[0].provenance.label, "model-derived current conditions");
  assert.equal(body.data[0].metrics.pm25MicrogramsPerCubicMeter, 7);
  assert.equal(
    body.data[0].metrics.soilElectricalConductivityMicrosiemensPerCm,
    420,
  );
  assert.deepEqual(body.data[0].metadata, {
    device: { model: "virtual-grid", serial: null, vendor: "Open-Meteo" },
    provider: {
      dataset: "era5",
      elevationM: 17,
      gridCell: "47.95,-122.43",
      propertySensors: null,
    },
    quality: {
      confidencePercent: 93,
      flags: ["interpolated"],
      interpolation: "linear",
      status: "accepted",
    },
    upstream: {
      model: "best_match",
      timezone: "America/Los_Angeles",
    },
  });
  assert.doesNotMatch(JSON.stringify(body), /private-request-id|request_id/u);
});

test("current exposes only bounded EcoWitt property sensor snapshots", async () => {
  const { handler } = createFixture({
    // return one record with provider-private sensor snapshots
    async getCurrent() {
      return [makeRecord({
        providerMetadata: {
          dataset: "get_livedata_info",
          property_sensors: [
            {
              channel: 1,
              key: "soil-1",
              model: "WH52",
              readings: {
                soilMoisturePercent: 42,
                temperatureC: 17.7,
                unsafe: "not-a-number",
              },
            },
            { key: "../invalid", model: "Unknown", readings: {} },
          ],
        },
      })];
    },
  });
  const response = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/current"),
  );
  const body = await response.json();

  assert.deepEqual(body.data[0].metadata.provider.propertySensors, [
    {
      channel: 1,
      key: "soil-1",
      model: "WH52",
      readings: {
        soilMoisturePercent: 42,
        temperatureC: 17.7,
      },
    },
  ]);
});

test("history uses frozen filter names, defaults, maximum, and opaque cursor", async () => {
  const { handler, historyQueries } = createFixture();
  const defaultResponse = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/history"),
  );
  const response = await handler(
    new Request(
      "http://weather.test/api/v1/sites/ballydidean/history?sourceKind=reanalysis&station=open-meteo-virtual&source=11&from=2026-08-01T00%3A00%3A00Z&to=2026-08-22T00%3A00%3A00Z&limit=2",
    ),
  );
  const body = await response.json();

  assert.equal(defaultResponse.status, 200);
  assert.equal(historyQueries[0].limit, 101);
  assert.equal(response.status, 200);
  assert.equal(body.data.length, 2);
  assert.equal(typeof body.page.nextCursor, "string");
  assert.equal(historyQueries[1].sourceKind, "reanalysis");
  assert.equal(historyQueries[1].stationSlug, "open-meteo-virtual");
  assert.equal(historyQueries[1].sourceId, "11");
  assert.equal(historyQueries[1].from, "2026-08-01T00:00:00.000Z");
  assert.equal(historyQueries[1].to, "2026-08-22T00:00:00.000Z");
  assert.equal(historyQueries[1].limit, 3);

  const maximum = await handler(
    new Request(
      "http://weather.test/api/v1/sites/ballydidean/history?limit=250",
    ),
  );
  const excessive = await handler(
    new Request(
      "http://weather.test/api/v1/sites/ballydidean/history?limit=251",
    ),
  );
  const oldName = await handler(
    new Request(
      "http://weather.test/api/v1/sites/ballydidean/history?kind=reanalysis",
    ),
  );

  assert.equal(maximum.status, 200);
  assert.equal(historyQueries.at(-1).limit, 251);
  assert.equal(excessive.status, 400);
  assert.equal(oldName.status, 400);
});

test("forecast returns the latest normalized product within the fixed horizon", async () => {
  const { forecastQueries, handler } = createFixture();
  const response = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/forecast"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(forecastQueries, [{
    asOf: "2026-08-21T07:00:00.000Z",
    hours: 24,
    siteSlug: "ballydidean",
  }]);
  assert.equal(body.data[0].provenance.sourceKind, "forecast");
  assert.equal(body.data[0].productRunAt, "2026-08-22T05:00:00.000Z");
  assert.equal(body.days, 1);

  const extendedResponse = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/forecast?days=10"),
  );
  const extendedBody = await extendedResponse.json();
  assert.equal(extendedResponse.status, 200);
  assert.equal(extendedBody.days, 10);
  assert.deepEqual(forecastQueries.at(-1), {
    asOf: "2026-08-21T07:00:00.000Z",
    hours: 240,
    siteSlug: "ballydidean",
  });
});

test("daily precipitation uses the site-local day and nearest physical gauge", async () => {
  const { dailyPrecipitationQueries, handler } = createFixture();
  const response = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/daily-precipitation"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(dailyPrecipitationQueries, [{
    from: "2026-08-21T07:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-08-22T05:00:00.000Z",
  }]);
  assert.deepEqual(body.data, {
    accumulationMm: 2.54,
    source: {
      sourceId: "13",
      stationSlug: "tempest-64255",
    },
    validThrough: "2026-08-22T04:59:00.000Z",
  });
});

test("forecast day windows follow site midnight through DST changes", () => {
  assert.deepEqual(
    siteForecastDayWindow(
      "2026-08-22T05:00:00.000Z",
      "America/Los_Angeles",
    ),
    { asOf: "2026-08-21T07:00:00.000Z", hours: 24 },
  );
  assert.deepEqual(
    siteForecastDayWindow(
      "2026-03-08T20:00:00.000Z",
      "America/Los_Angeles",
    ),
    { asOf: "2026-03-08T08:00:00.000Z", hours: 23 },
  );
  assert.deepEqual(
    siteForecastDayWindow(
      "2026-11-01T20:00:00.000Z",
      "America/Los_Angeles",
    ),
    { asOf: "2026-11-01T07:00:00.000Z", hours: 25 },
  );
  assert.deepEqual(
    siteForecastDayWindow(
      "2026-08-22T05:00:00.000Z",
      "America/Los_Angeles",
      10,
    ),
    { asOf: "2026-08-21T07:00:00.000Z", hours: 240 },
  );
  assert.deepEqual(
    siteForecastDayWindow(
      "2026-03-06T20:00:00.000Z",
      "America/Los_Angeles",
      5,
    ),
    { asOf: "2026-03-06T08:00:00.000Z", hours: 119 },
  );
});


test("tides expose normalized NOAA levels and local event types", async () => {
  const { handler } = createFixture();
  const response = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/tides"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.data[0], {
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
    validAt: "2026-08-22T11:27:00.000Z",
    waterLevelM: 3.271,
  });
});

test("trends expose daily local-calendar history from 2019", async () => {
  const { handler, trendQueries } = createFixture();
  const response = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/trends"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.generatedAt, "2026-08-22T05:00:00.000Z");
  assert.deepEqual(trendQueries, [{
    from: "2019-01-01T08:00:00.000Z",
    siteSlug: "ballydidean",
    to: "2026-08-22T05:00:00.000Z",
  }]);
  assert.equal(body.data[0].validAt, "2026-08-22T04:00:00.000Z");
  assert.equal(body.data[0].metrics.temperatureC, 16.2);

  assert.deepEqual(
    calendarTrendWindow("2026-08-22T05:00:00.000Z", "America/Los_Angeles"),
    { from: "2019-01-01T08:00:00.000Z" },
  );

  const invalid = await handler(
    new Request("http://weather.test/api/v1/sites/ballydidean/trends?range=90d"),
  );
  assert.equal(invalid.status, 400);
});

test("invalid ranges, cursors, duplicate filters, sites, stations, and sources are bounded", async () => {
  const { handler } = createFixture();
  const cases = [
    ["/api/v1/sites/ballydidean/history?from=2026-08-22T01%3A00%3A00Z&to=2026-08-22T00%3A00%3A00Z", 400],
    ["/api/v1/sites/ballydidean/history?cursor=not-a-cursor", 400],
    ["/api/v1/sites/ballydidean/history?source=10&source=11", 400],
    ["/api/v1/sites/elsewhere/current", 404],
    ["/api/v1/sites/ballydidean/current?station=missing", 404],
    ["/api/v1/sites/ballydidean/current?source=999", 404],
    ["/api/v1/sites/ballydidean/current?unsupported=true", 400],
    ["/api/v1/sites/ballydidean/forecast?days=7", 400],
  ];

  // verify each structured failure
  for (const [path, status] of cases) {
    const response = await handler(new Request(`http://weather.test${path}`));
    const body = await response.json();
    assert.equal(response.status, status, path);
    assert.equal(typeof body.error.code, "string");
    assert.equal(typeof body.error.message, "string");
  }
});

test("health is allowlisted and reports migration readiness and coarse freshness", async () => {
  const { handler } = createFixture();
  const response = await handler(
    new Request("http://weather.test/api/v1/health"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    data: {
      database: "ready",
      live: true,
      migration: { status: "current", version: "0001_initial_weather.sql" },
      ready: true,
      version: "2026.08.22-1",
      worker: { freshness: "fresh" },
    },
  });
  assert.deepEqual(Object.keys(body.data).sort(), [
    "database",
    "live",
    "migration",
    "ready",
    "version",
    "worker",
  ]);
});

test("health reports the bounded production release environment value", async () => {
  const version = readApiRelease({ WEATHER_RELEASE: "2026.08.22-9" });
  const { handler } = createFixture({}, { version });
  const response = await handler(
    new Request("http://weather.test/api/v1/health"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.version, "2026.08.22-9");
  assert.throws(
    () => readApiRelease({ WEATHER_RELEASE: " ".repeat(129) }),
    /WEATHER_RELEASE must be non-empty and bounded/u,
  );
});

test("unexpected failures return safe errors and emit redacted structured diagnostics", async () => {
  const diagnostics = [];
  const failure = new TypeError(
    "postgres://weather:super-secret@database/weather?sslkey=/run/secrets/key",
  );
  failure.code = "28P01";
  const { handler } = createFixture(
    {
      // fail before returning metadata
      async listSites() {
        throw failure;
      },
    },
    {
      // capture the internal boundary
      logDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
  );
  const response = await handler(
    new Request("http://weather.test/api/v1/sites"),
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: { code: "internal_error", message: "Unexpected server error" },
  });
  assert.deepEqual(diagnostics, [
    {
      errorCode: "28P01",
      errorName: "TypeError",
      event: "api_request_failed",
      method: "GET",
      status: 500,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify({ body, diagnostics }),
    /super-secret|sslkey|postgres:\/\//u,
  );
});

test("health failures stay live, fail readiness, and redact raw database errors", async () => {
  const { handler } = createFixture({
    // simulate a safely classified database failure
    async getHealth() {
      return {
        database: "unavailable",
        migration: { status: "unavailable", version: null },
        workerLastLoopAt: null,
      };
    },
  });
  const response = await handler(
    new Request("http://weather.test/api/v1/health"),
  );
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.deepEqual(body.data, {
    database: "unavailable",
    live: true,
    migration: { status: "unavailable", version: null },
    ready: false,
    version: "2026.08.22-1",
    worker: { freshness: "unknown" },
  });
  assert.doesNotMatch(JSON.stringify(body), /password|postgres|host|stack|error/u);
});

test("future worker heartbeats are stale without changing database readiness", async () => {
  const { handler } = createFixture({
    // simulate clock skew beyond the health allowance
    async getHealth() {
      return {
        database: "ready",
        migration: { status: "current", version: "0001_initial_weather.sql" },
        workerLastLoopAt: "2026-08-22T05:30:01.000Z",
      };
    },
  });
  const response = await handler(
    new Request("http://weather.test/api/v1/health"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.ready, true);
  assert.equal(body.data.worker.freshness, "stale");
});

test("Node server exposes the versioned handler end to end", async (context) => {
  const { handler } = createFixture();
  const server = createWeatherApiServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // close the ephemeral server
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/api/v1/sites`,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].name, "Ballydidean");
});

test("Node server adapter redacts rejected handler diagnostics", async (context) => {
  const diagnostics = [];
  const failure = new Error("authorization=Bearer super-secret");
  failure.code = "ERR_HANDLER";
  const server = createWeatherApiServer(
    // reject outside the fetch-compatible boundary
    async () => {
      throw failure;
    },
    {
      // capture the server boundary
      logDiagnostic(diagnostic) {
        diagnostics.push(diagnostic);
      },
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  // close the ephemeral server
  context.after(async () => {
    server.close();
    await once(server, "close");
  });

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/`);
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: { code: "internal_error", message: "Unexpected server error" },
  });
  assert.deepEqual(diagnostics, [
    {
      errorCode: "ERR_HANDLER",
      errorName: "Error",
      event: "api_request_failed",
      method: "GET",
      status: 500,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify({ body, diagnostics }),
    /super-secret|authorization|Bearer/u,
  );
});
