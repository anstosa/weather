import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCurrentUrl,
  buildHistoryUrl,
  fromSiteWallClock,
  renderWeatherDashboard,
  toSiteWallClock,
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
    provider: { dataset: "best_match", elevationM: 17, gridCell: null },
    quality: null,
    upstream: {
      model: "best_match",
      timezone: "America/Los_Angeles",
    },
  },
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

test("dashboard renders station/source controls, units, metadata, and persistent attribution", () => {
  const html = renderWeatherDashboard({
    current: [record],
    error: "The latest refresh failed",
    filters: {
      sourceId: "10",
      stationSlug: "open-meteo-virtual",
    },
    history: [record],
    loading: false,
    nextCursor: "next-page",
    page: 0,
    selectedSite: site,
    sites: [site],
  });

  assert.match(html, /Ballydidean weather/u);
  assert.match(html, /aria-label="Weather location"/u);
  assert.match(html, /name="stationSlug"/u);
  assert.match(html, /name="sourceId"/u);
  assert.match(html, /name="sourceKind"/u);
  assert.match(html, /Nearby model value/u);
  assert.match(html, /not an on-site sensor reading/u);
  assert.match(html, /best_match/u);
  assert.match(html, /<th scope="col">Temperature \(°C\)<\/th>/u);
  assert.match(html, /<th scope="col">Source and provenance<\/th>/u);
  assert.match(html, /aria-label="History pages"/u);
  assert.match(html, /https:\/\/open-meteo\.com\//u);
  assert.match(html, /https:\/\/creativecommons\.org\/licenses\/by\/4\.0\//u);
  assert.match(html, /CC BY 4\.0/u);
  assert.match(html, /The latest refresh failed/u);
  assert.match(html, /16\.2/u);
});

test("current and history URLs use the versioned API and frozen filter names", () => {
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
  const history = new URL(
    buildHistoryUrl("/api/v1/", "ballydidean", filters, "opaque cursor"),
    "http://weather.test",
  );

  assert.equal(current.pathname, "/api/v1/sites/ballydidean/current");
  assert.equal(current.searchParams.get("station"), "open-meteo-virtual");
  assert.equal(current.searchParams.get("source"), "11");
  assert.equal(current.searchParams.has("from"), false);
  assert.equal(history.pathname, "/api/v1/sites/ballydidean/history");
  assert.equal(history.searchParams.get("station"), "open-meteo-virtual");
  assert.equal(history.searchParams.get("source"), "11");
  assert.equal(history.searchParams.get("sourceKind"), "reanalysis");
  assert.equal(history.searchParams.has("kind"), false);
  assert.equal(history.searchParams.get("cursor"), "opaque cursor");
  assert.equal(history.searchParams.get("limit"), "100");
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
  } finally {
    // restore the process timezone
    if (browserTimezone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = browserTimezone;
    }
  }
});

test("controller filters both current and history and follows cursor pagination", async () => {
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

    const nextCursor = url.includes("cursor=") ? null : "page-two";
    return Response.json({
      data: [record],
      page: { limit: 100, nextCursor },
      site,
    });
  }

  const controller = new WeatherDashboardController({
    fetcher,
  });
  await controller.initialize();
  await controller.setFilters({
    sourceId: "11",
    sourceKind: "reanalysis",
    stationSlug: "open-meteo-virtual",
  });
  await controller.nextPage();

  assert.equal(controller.state.selectedSite?.slug, "ballydidean");
  assert.equal(controller.state.current.length, 1);
  assert.equal(controller.state.page, 1);
  assert.equal(controller.state.nextCursor, null);
  assert.ok(
    requested.some(
      // require current selection filters
      (url) =>
        url.includes("/api/v1/sites/ballydidean/current") &&
        url.includes("station=open-meteo-virtual") &&
        url.includes("source=11"),
    ),
  );
  assert.ok(
    requested.some(
      // require history selection filters
      (url) =>
        url.includes("sourceKind=reanalysis") &&
        url.includes("cursor=page-two"),
    ),
  );
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
  assert.equal(controller.state.history[0]?.id, "101");
  assert.match(controller.state.error ?? "", /status 503/u);

  failReads = false;
  await controller.loadSelectedSite();

  assert.equal(controller.state.error, null);
  assert.equal(controller.state.current[0]?.id, "101");
});

test("controller clears site-scoped filters before loading another site", async () => {
  const requested = [];

  // serve two incompatible site selections
  async function fetcher(input) {
    const url = String(input);
    requested.push(url);

    // return both active sites
    if (url.endsWith("/api/v1/sites")) {
      return Response.json({ data: [site, secondSite] });
    }

    const selectedSite = url.includes("/coupeville/") ? secondSite : site;

    // return one current row
    if (url.includes("/current")) {
      return Response.json({ data: [record], site: selectedSite });
    }

    return Response.json({
      data: [record],
      page: { limit: 100, nextCursor: null },
      site: selectedSite,
    });
  }

  const controller = new WeatherDashboardController({ fetcher });
  await controller.initialize();
  await controller.setFilters({
    sourceId: "10",
    stationSlug: "open-meteo-virtual",
  });
  await controller.selectSite("coupeville");

  assert.deepEqual(controller.state.filters, {});
  assert.equal(controller.state.page, 0);
  assert.ok(
    requested.some(
      // require unfiltered reads for the new site
      (url) => url.endsWith("/api/v1/sites/coupeville/current"),
    ),
  );
  assert.ok(
    requested.some(
      // require unfiltered history for the new site
      (url) => url === "/api/v1/sites/coupeville/history?limit=100",
    ),
  );
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

  const controller = new WeatherDashboardController({ fetcher });
  await controller.initialize();
  failReads = true;
  await controller.nextPage();

  assert.equal(controller.state.page, 0);
  assert.equal(controller.state.nextCursor, "page-two");
  assert.equal(controller.state.history[0]?.id, "101");
  assert.match(controller.state.error ?? "", /status 503/u);
});
