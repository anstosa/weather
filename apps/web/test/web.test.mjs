import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistoryUrl,
  renderWeatherDashboard,
  WeatherDashboardController,
} from "../dist/index.js";

const site = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  name: "Ballydidean",
  slug: "ballydidean",
  stations: [
    {
      kind: "virtual",
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
      ],
    },
  ],
  timezone: "America/Los_Angeles",
};

const record = {
  freshness: {
    ageSeconds: 600,
    label: "Model value is current",
    status: "fresh",
  },
  id: "101",
  metrics: {
    apparentTemperatureC: 15.5,
    cloudCoverPercent: 42,
    precipitationMm: 0.2,
    pressureHpa: 1014.2,
    relativeHumidityPercent: 78,
    temperatureC: 16.2,
    windDirectionDegrees: 225,
    windGustMps: 7.2,
    windSpeedMps: 4.1,
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

test("dashboard renders accessible current, filters, pagination, and attribution", () => {
  const html = renderWeatherDashboard({
    current: [record],
    error: null,
    filters: {},
    history: [record],
    loading: false,
    nextCursor: "next-page",
    page: 0,
    selectedSite: site,
    sites: [site],
  });

  assert.match(html, /Ballydidean weather/u);
  assert.match(html, /aria-label="Weather location"/u);
  assert.match(html, /Nearby model value/u);
  assert.match(html, /not an on-site sensor reading/u);
  assert.match(html, /Weather data by Open-Meteo/u);
  assert.match(html, /data-history-filters/u);
  assert.match(html, /<table>/u);
  assert.match(html, /aria-label="History pages"/u);
});

test("history URLs preserve filters and opaque cursors", () => {
  const url = new URL(
    buildHistoryUrl(
      "/api/",
      "ballydidean",
      {
        from: "2026-08-01T00:00:00.000Z",
        sourceId: "11",
        sourceKind: "reanalysis",
        to: "2026-08-22T00:00:00.000Z",
      },
      "opaque cursor",
    ),
    "http://weather.test",
  );

  assert.equal(url.pathname, "/api/sites/ballydidean/history");
  assert.equal(url.searchParams.get("source"), "11");
  assert.equal(url.searchParams.get("kind"), "reanalysis");
  assert.equal(url.searchParams.get("cursor"), "opaque cursor");
});

test("controller defaults to Ballydidean and follows cursor pagination", async () => {
  const requested = [];

  // serve deterministic browser contracts
  async function fetcher(input) {
    const url = String(input);
    requested.push(url);

    // return site metadata
    if (url.endsWith("/sites")) {
      return Response.json({ data: [site] });
    }

    // return current conditions
    if (url.endsWith("/current")) {
      return Response.json({ data: [record], site });
    }

    const nextCursor = url.includes("cursor=") ? null : "page-two";
    return Response.json({
      data: [record],
      page: { limit: 25, nextCursor },
      site,
    });
  }

  const controller = new WeatherDashboardController({
    apiBaseUrl: "http://weather.test",
    fetcher,
  });
  await controller.initialize();

  assert.equal(controller.state.selectedSite?.slug, "ballydidean");
  assert.equal(controller.state.current.length, 1);
  assert.equal(controller.state.nextCursor, "page-two");

  await controller.nextPage();

  assert.equal(controller.state.page, 1);
  assert.equal(controller.state.nextCursor, null);
  assert.ok(requested.some((url) => url.includes("cursor=page-two")));
});
