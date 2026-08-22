import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

import {
  createWeatherApi,
  createWeatherApiServer,
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

// create a deterministic storage record
function makeRecord(overrides = {}) {
  return {
    apparentTemperatureC: 15.5,
    cloudCoverPercent: 42,
    firstReceivedAt: "2026-08-22T04:51:00.000Z",
    id: "100",
    lastReceivedAt: "2026-08-22T04:51:00.000Z",
    precipitationMm: 0.2,
    pressureHpa: 1014.2,
    productRunAt: null,
    providerKey: "open-meteo",
    relativeHumidityPercent: 78,
    revisionCount: 0,
    siteSlug: "ballydidean",
    sourceId: "11",
    sourceKey: "open-meteo-reanalysis-v1",
    sourceKind: "reanalysis",
    stationSlug: "open-meteo-virtual",
    temperatureC: 16.2,
    validAt: "2026-08-21T04:00:00.000Z",
    windDirectionDegrees: 225,
    windGustMps: 7.2,
    windSpeedMps: 4.1,
    ...overrides,
  };
}

// create an isolated API fixture
function createFixture() {
  const historyQueries = [];
  const historyRows = [
    makeRecord({ id: "103", validAt: "2026-08-21T03:00:00.000Z" }),
    makeRecord({ id: "102", validAt: "2026-08-21T02:00:00.000Z" }),
    makeRecord({ id: "101", validAt: "2026-08-21T01:00:00.000Z" }),
  ];
  const store = {
    // return current records
    async getCurrent() {
      return [currentRecord];
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
  };
  const handler = createWeatherApi(store, {
    // freeze response time
    now: () => new Date("2026-08-22T05:00:00.000Z"),
  });
  return { handler, historyQueries };
}

test("GET /sites groups sources and retains attribution", async () => {
  const { handler } = createFixture();
  const response = await handler(new Request("http://weather.test/sites"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].slug, "ballydidean");
  assert.equal(body.data[0].stations[0].sources.length, 2);
  assert.equal(
    body.data[0].stations[0].sources[0].attribution.label,
    "Weather data by Open-Meteo",
  );
});

test("GET current communicates model provenance and freshness", async () => {
  const { handler } = createFixture();
  const response = await handler(
    new Request("http://weather.test/sites/ballydidean/current"),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].metrics.temperatureC, 16.2);
  assert.equal(body.data[0].freshness.status, "fresh");
  assert.equal(body.data[0].provenance.label, "model-derived current conditions");
  assert.equal(body.data[0].provenance.attribution.url, "https://open-meteo.com/");
});

test("GET history validates filters and returns an opaque next cursor", async () => {
  const { handler, historyQueries } = createFixture();
  const response = await handler(
    new Request(
      "http://weather.test/sites/ballydidean/history?kind=reanalysis&station=open-meteo-virtual&from=2026-08-01T00%3A00%3A00Z&to=2026-08-22T00%3A00%3A00Z&limit=2",
    ),
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 2);
  assert.equal(typeof body.page.nextCursor, "string");
  assert.equal(historyQueries[0].sourceKind, "reanalysis");
  assert.equal(historyQueries[0].stationSlug, "open-meteo-virtual");
  assert.equal(historyQueries[0].limit, 3);
});

test("invalid filters, methods, and sites return bounded errors", async () => {
  const { handler } = createFixture();
  const invalidLimit = await handler(
    new Request("http://weather.test/sites/ballydidean/history?limit=101"),
  );
  const invalidMethod = await handler(
    new Request("http://weather.test/sites", { method: "POST" }),
  );
  const unknownSite = await handler(
    new Request("http://weather.test/sites/elsewhere/current"),
  );

  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidMethod.status, 405);
  assert.equal(invalidMethod.headers.get("allow"), "GET");
  assert.equal(unknownSite.status, 404);
});

test("Node server exposes the fetch handler end to end", async (context) => {
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
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/sites`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data[0].name, "Ballydidean");
});
