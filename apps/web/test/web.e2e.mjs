import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

import { chromium } from "playwright";
import { UNIT_PREFERENCE_STORAGE_KEY } from "../dist/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const publicRoot = join(repositoryRoot, "apps/web/public");
const distRoot = join(repositoryRoot, "apps/web/dist");
const fixtureAssetVersion = "browser-test";
const transparentPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

const current = makeRecord("101", "2026-08-22T04:50:00.000Z", 16.2);
const older = makeRecord("100", "2026-08-21T04:50:00.000Z", 15.1);
const physicalCurrent = {
  ...makeRecord("301", "2026-08-22T04:52:00.000Z", 12),
  freshness: {
    ageSeconds: 120,
    label: "Station reading is current",
    status: "fresh",
  },
  metadata: {
    ...makeRecord("301", "2026-08-22T04:52:00.000Z", 12).metadata,
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
        {
          channel: 2,
          key: "temperature-2",
          model: "WN31",
          readings: {
            relativeHumidityPercent: 73,
            temperatureC: 16.5,
          },
        },
      ],
    },
  },
  metrics: {
    ...makeRecord("301", "2026-08-22T04:52:00.000Z", 12).metrics,
    pm25MicrogramsPerCubicMeter: 10,
    pressureHpa: 1013.5,
    relativeHumidityPercent: 81,
    uvIndex: 1,
    windGustMps: 4.5,
    windSpeedMps: 2.5,
  },
  provenance: {
    ...current.provenance,
    label: "nearby physical station",
    providerKey: "weatherflow-tempest",
    sourceId: "13",
    sourceKey: "tempest-38270-observations-v1",
    sourceKind: "physical_sensor",
    stationSlug: "tempest-38270",
  },
};
const forecast = Array.from({ length: 240 }, (_, index) => makeForecastRecord(index));
const adjustmentHashes = {
  bundle: "a".repeat(64),
  candidate: "b".repeat(64),
  report: "c".repeat(64),
  receipt: "d".repeat(64),
  source: "e".repeat(64),
};
const dailyPrecipitation = {
  accumulationMm: 2.54,
  source: {
    sourceId: "71",
    stationSlug: "tempest-64255",
  },
  validThrough: "2026-08-22T04:59:00.000Z",
};
const propertySensorLayout = [
  {
    displayName: "Orchard soil",
    icon: "temperature",
    latitude: 47.9505,
    longitude: -122.4281,
    sensorKey: "soil-1",
    updatedAt: "2026-08-22T04:59:00.000Z",
  },
  {
    displayName: "Barn temperature",
    icon: "temperature",
    latitude: 47.9505,
    longitude: -122.4281,
    sensorKey: "temperature-2",
    updatedAt: "2026-08-22T04:59:00.000Z",
  },
];
const trends = [];

// build matching month samples across three calendar years
for (const [yearIndex, year] of [2019, 2025, 2026].entries()) {
  // retain one representative daily sample per month
  for (let month = 0; month < 12; month += 1) {
    trends.push({
      metrics: {
        apparentTemperatureC: 8 + month + yearIndex * 0.4,
        precipitationMm: month % 3 === 0 ? 0.2 : 0,
        pressureHpa: 1012 + month * 0.3,
        relativeHumidityPercent: 82 - month,
        temperatureC: 9 + Math.sin((month / 12) * Math.PI * 2) * 7 + yearIndex,
        temperatureMaximumC: 14 + Math.sin((month / 12) * Math.PI * 2) * 7 + yearIndex,
        temperatureMinimumC: 5 + Math.sin((month / 12) * Math.PI * 2) * 7 + yearIndex,
        windDirectionDegrees: (month * 30 + yearIndex * 15) % 360,
        windGustMps: 5 + month * 0.25 + yearIndex * 0.2,
        windSpeedMps: 3 + month * 0.2,
      },
      validAt: new Date(Date.UTC(year, month, 15, 8)).toISOString(),
    });
  }
}
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

// create one public weather record
function makeRecord(id, validAt, temperatureC) {
  return {
    freshness: {
      ageSeconds: id === "101" ? 600 : 87_000,
      label: id === "101" ? "Model value is current" : "Model value may be stale",
      status: id === "101" ? "fresh" : "stale",
    },
    id,
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
      apparentTemperatureC: temperatureC - 0.7,
      blackGlobeTemperatureC: null,
      cloudCoverPercent: 42,
      pm25MicrogramsPerCubicMeter: null,
      precipitationMm: 0.2,
      precipitationRateMmPerHour: null,
      pressureHpa: 1014.2,
      relativeHumidityPercent: 78,
      soilElectricalConductivityMicrosiemensPerCm: null,
      soilMoisturePercent: null,
      solarRadiationWm2: null,
      temperatureC,
      uvIndex: null,
      windDirectionDegrees: 225,
      windGustMps: 7.2,
      windSpeedMps: 4.1,
      wetBulbGlobeTemperatureC: null,
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
    receivedAt: validAt,
    revisionCount: 0,
    validAt,
  };
}

// create one normalized forecast record
function makeForecastRecord(index) {
  const validAt = new Date(Date.UTC(2026, 7, 21, 7 + index)).toISOString();
  const hour = index % 24;
  const value = makeRecord(
    String(200 + index),
    validAt,
    15 + Math.sin((hour / 24) * Math.PI * 2) * 5,
  );
  return {
    ...value,
    metadata: {
      ...value.metadata,
      provider: { ...value.metadata.provider, dataset: "forecast" },
    },
    metrics: {
      ...value.metrics,
      pm25MicrogramsPerCubicMeter: 5 + hour % 6,
      precipitationRateMmPerHour: hour === 5 ? 2.54 : 0,
      pressureHpa: 1_014 + Math.sin((hour / 24) * Math.PI * 2) * 3,
      relativeHumidityPercent: 62 + Math.cos((hour / 24) * Math.PI * 2) * 12,
      uvIndex: Math.max(0, 8 - Math.abs(12 - hour)),
      windGustMps: 6 + Math.sin((hour / 24) * Math.PI * 2),
      windSpeedMps: 3 + Math.sin((hour / 24) * Math.PI * 2) * 0.5,
    },
    productRunAt: "2026-08-22T05:00:00.000Z",
    provenance: {
      ...value.provenance,
      label: "hourly forecast",
      sourceId: "12",
      sourceKey: "open-meteo-forecast-v1",
      sourceKind: "forecast",
    },
  };
}

// resolve one exact lead band
function adjustmentLeadBand(targetLeadHours) {
  const minimum = Math.floor((targetLeadHours - 1) / 24) * 24 + 1;
  return `${String(minimum).padStart(3, "0")}-${String(minimum + 23).padStart(3, "0")}`;
}

// create one exact active decision
function activeForecastAdjustment(record, targetLeadHours) {
  return {
    adjustedMetrics: {
      temperatureC: record.metrics.temperatureC + 2,
      windSpeedMps: record.metrics.windSpeedMps + 0.4,
    },
    algorithmContractVersion: "robust-hierarchical-median/v1",
    appliedMetrics: ["temperatureC", "windSpeedMps"],
    candidateArtifactSha256: adjustmentHashes.candidate,
    contractVersion: "forecast-adjustment-decision/v1",
    evaluationReportSha256: adjustmentHashes.report,
    leadBand: adjustmentLeadBand(targetLeadHours),
    qualificationReceiptSha256: adjustmentHashes.receipt,
    rawForecastProvenance: {
      adapterVersion: "open-meteo-forecast-daily/v4",
      cohort: "legacy_v4_retrieval_snapshot",
      contractEpoch:
        "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
      dataset: record.metadata.provider.dataset,
      referenceAt: new Date(
        Date.parse(record.validAt) - targetLeadHours * 3_600_000,
      ).toISOString(),
      referenceKind: "retrieval_snapshot",
      sourceConfigFingerprint: adjustmentHashes.source,
      sourceKey: record.provenance.sourceKey,
      targetLeadHours,
      upstreamModel: record.metadata.upstream.model,
      validAt: record.validAt,
    },
    reasonCode: null,
    state: "active",
  };
}

// create one exact raw decision
function rawForecastAdjustment(state, reasonCode) {
  return {
    adjustedMetrics: {},
    appliedMetrics: [],
    contractVersion: "forecast-adjustment-decision/v1",
    reasonCode,
    state,
  };
}

// create one bounded runtime summary
function forecastAdjustmentRuntime(mode) {
  // expose one synthetic verified bundle
  if (mode === "active") {
    return {
      activeBundle: adjustmentHashes.bundle,
      candidateArtifactSha256: adjustmentHashes.candidate,
      evaluationReportSha256: adjustmentHashes.report,
      loadedAt: "2026-08-22T05:00:00.000Z",
      qualificationReceiptSha256: adjustmentHashes.receipt,
      reasonCode: null,
      state: "active",
    };
  }

  return {
    activeBundle: null,
    candidateArtifactSha256: null,
    evaluationReportSha256: null,
    loadedAt: "2026-08-22T05:00:00.000Z",
    qualificationReceiptSha256: null,
    reasonCode: mode === "fault" ? "bundle_invalid" : "registry_inactive",
    state: "disabled",
  };
}

// create one complete adjusted forecast response
function forecastResponse(mode) {
  return {
    adjustmentRuntime: forecastAdjustmentRuntime(mode),
    data: forecast.map(
      // attach one exact per-row decision
      (record, index) => ({
        ...record,
        adjustment: mode === "active"
          ? index < 168
            ? activeForecastAdjustment(record, index + 1)
            : rawForecastAdjustment("not_applicable", "unsupported_lead")
          : rawForecastAdjustment(
              "disabled",
              mode === "fault" ? "bundle_invalid" : "registry_inactive",
            ),
      }),
    ),
    site,
  };
}

// locate an optional host Chromium binary
function findChromium() {
  const explicit = process.env.WEATHER_CHROMIUM_EXECUTABLE;

  // prefer an explicit test runner binary
  if (explicit !== undefined && existsSync(explicit)) {
    return explicit;
  }

  const cacheRoot = join(process.env.HOME ?? "", ".cache/ms-playwright");
  const candidates = existsSync(cacheRoot)
    ? readdirSync(cacheRoot)
      .filter((name) => name.startsWith("chromium-"))
      .sort()
      .reverse()
    : [];

  // select the newest cached browser
  for (const candidate of candidates) {
    const path = join(cacheRoot, candidate, "chrome-linux64/chrome");

    // require an executable artifact
    if (existsSync(path)) {
      return path;
    }
  }

  return undefined;
}

// launch the available real browser
async function launchBrowser() {
  const executablePath = findChromium();
  return await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: true,
  });
}

const MAP_TILE_PATTERN = /^https:\/\/(?:tile\.openstreetmap\.org|basemap\.nationalmap\.gov)\//u;

// create one browser page with deterministic map tiles
async function createFixturePage(browser, options) {
  const page = await browser.newPage(options);
  // replace external tiles with deterministic images
  await page.route(MAP_TILE_PATTERN, async (route) => {
    await route.fulfill({
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#d9d8d1"/></svg>',
      contentType: "image/svg+xml",
      status: 200,
    });
  });
  return page;
}

// capture stable document-space section geometry
async function captureSectionGeometry(page, selectors) {
  const geometry = {};

  // capture each requested section once
  for (const selector of selectors) {
    geometry[selector] = await page.locator(selector).evaluate(
      // preserve document coordinates across viewport movement
      (element) => {
        const bounds = element.getBoundingClientRect();
        return {
          height: bounds.height,
          left: bounds.left + window.scrollX,
          top: bounds.top + window.scrollY,
          width: bounds.width,
        };
      },
    );
  }

  return geometry;
}

// require rendered lines to clear every title footprint
async function assertForecastTitleClearance(page) {
  assert.equal(
    await page.locator(".forecast-chart").evaluateAll(
      // compare actual plot and title geometry
      (charts) => charts.every((chart) => {
        const heading = chart.querySelector(".forecast-chart-heading");
        const svg = chart.querySelector("svg");
        const headingBounds = heading?.getBoundingClientRect();
        const svgBounds = svg?.getBoundingClientRect();

        // require complete rendered geometry
        if (headingBounds === undefined || svgBounds === undefined) {
          return false;
        }

        const top = heading?.classList.contains("forecast-chart-heading-top") === true;
        const ordinates = [...chart.querySelectorAll("polyline")].flatMap(
          // read every rendered SVG ordinate
          (line) => (line.getAttribute("points") ?? "").split(" ").flatMap((point) => {
            const ordinate = Number(point.split(",")[1]);
            return Number.isFinite(ordinate) ? [ordinate] : [];
          }),
        );
        const rendered = ordinates.map(
          // project one SVG point into viewport pixels
          (ordinate) => svgBounds.top + (ordinate / 150) * svgBounds.height,
        );
        return top && rendered.every((ordinate) => ordinate >= headingBounds.bottom + 5);
      }),
    ),
    true,
  );
}

// start a bounded static and fake API server
async function startFixtureServer() {
  const state = {
    adjustmentMode: "inactive",
    adminUpdates: 0,
    failReads: false,
    mutations: 0,
    requests: [],
    propertySensorLayout: propertySensorLayout.map(
      // isolate each fixture's mutable editor state
      (entry) => ({ ...entry }),
    ),
    tileDelayMs: 0,
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://weather.test");
    state.requests.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);

    // persist one authenticated-editor fixture update
    if (
      request.method === "PUT" &&
      url.pathname === "/api/v1/admin/sites/ballydidean/property-sensor-layout/soil-1"
    ) {
      const chunks = [];

      // collect the bounded browser fixture body
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }

      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      state.propertySensorLayout[0] = {
        ...body,
        sensorKey: "soil-1",
        updatedAt: "2026-08-22T05:01:00.000Z",
      };
      state.adminUpdates += 1;
      sendJson(response, { data: state.propertySensorLayout[0] });
      return;
    }

    // reject every mutation
    if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
      state.mutations += 1;
      sendJson(response, { error: { code: "method_not_allowed" } }, 405);
      return;
    }

    // serve same-origin weather-map fixture tiles
    if (/^\/maps\/xweather\/(?:history|forecast)\/(?:radar|clouds|precipitation|wind)\/\d{14}\/\d+\/\d+x\d+\/-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?\.png$/u.test(url.pathname)) {
      response.statusCode = 200;
      response.setHeader(
        "cache-control",
        url.pathname.includes("/maps/xweather/history/")
          ? "public, max-age=31536000, immutable"
          : "no-store",
      );
      response.setHeader("content-type", "image/png");
      response.setHeader("content-length", String(transparentPng.byteLength));

      // keep cache progress observable in focused browser coverage
      if (state.tileDelayMs > 0) {
        setTimeout(() => {
          // complete one deliberately delayed tile
          response.end(request.method === "HEAD" ? undefined : transparentPng);
        }, state.tileDelayMs);
        return;
      }

      response.end(request.method === "HEAD" ? undefined : transparentPng);
      return;
    }

    // serve site metadata
    if (url.pathname === "/api/v1/sites") {
      sendJson(response, { data: [site] });
      return;
    }

    // simulate a recoverable API outage
    if (state.failReads && url.pathname.startsWith("/api/v1/sites/")) {
      sendJson(response, { error: { code: "unavailable" } }, 503);
      return;
    }

    // serve filtered current data
    if (url.pathname === "/api/v1/sites/ballydidean/current") {
      sendJson(response, { data: [current, physicalCurrent], site });
      return;
    }

    // serve the shared property sensor layout
    if (url.pathname === "/api/v1/sites/ballydidean/property-sensor-layout") {
      sendJson(response, { data: state.propertySensorLayout });
      return;
    }

    // serve today's nearest-gauge rain accumulation
    if (url.pathname === "/api/v1/sites/ballydidean/daily-precipitation") {
      sendJson(response, {
        data: dailyPrecipitation,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
      return;
    }

    // serve normalized forecast hours
    if (url.pathname === "/api/v1/sites/ballydidean/forecast") {
      sendJson(response, forecastResponse(state.adjustmentMode));
      return;
    }

    // serve daily calendar-year trend buckets
    if (url.pathname === "/api/v1/sites/ballydidean/trends") {
      sendJson(response, {
        data: trends,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
      return;
    }

    // serve observed and predicted tide levels
    if (url.pathname === "/api/v1/sites/ballydidean/tides") {
      sendJson(response, {
        data: tides,
        generatedAt: "2026-08-22T05:00:00.000Z",
        site,
      });
      return;
    }

    // serve stable cursor pages
    if (url.pathname === "/api/v1/sites/ballydidean/history") {
      const secondPage = url.searchParams.has("cursor");
      sendJson(response, {
        data: [secondPage ? older : current],
        page: { limit: 100, nextCursor: secondPage ? null : "older-page" },
        site,
      });
      return;
    }

    // serve one same-origin embedding host
    if (url.pathname === "/embed") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end('<!doctype html><html><body><iframe title="Embedded weather" src="/" style="width: 1000px; height: 700px"></iframe></body></html>');
      return;
    }

    const assets = new Map([
      ["/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/logs", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/logs/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/map", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/map/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/admin", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/admin/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/forecast", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/forecast/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/trends", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/trends/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/settings", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/settings/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/manifest.webmanifest", [join(publicRoot, "manifest.webmanifest"), "application/manifest+json; charset=utf-8"]],
      ["/service-worker.js", [join(publicRoot, "service-worker.js"), "text/javascript; charset=utf-8"]],
      [`/assets/${fixtureAssetVersion}/styles.css`, [join(publicRoot, "styles.css"), "text/css; charset=utf-8"]],
      ["/brand/ballydidean-wide.svg", [join(publicRoot, "brand/ballydidean-wide.svg"), "image/svg+xml"]],
      ["/brand/ballydidean-weather-icon-32.png", [join(publicRoot, "brand/ballydidean-weather-icon-32.png"), "image/png"]],
      ["/brand/ballydidean-weather-icon-180.png", [join(publicRoot, "brand/ballydidean-weather-icon-180.png"), "image/png"]],
      ["/brand/ballydidean-weather-icon-192.png", [join(publicRoot, "brand/ballydidean-weather-icon-192.png"), "image/png"]],
      ["/brand/ballydidean-weather-icon-512.png", [join(publicRoot, "brand/ballydidean-weather-icon-512.png"), "image/png"]],
      ["/brand/ballydidean-weather-icon-maskable-512.png", [join(publicRoot, "brand/ballydidean-weather-icon-maskable-512.png"), "image/png"]],
      ["/fonts/google-sans-flex-latin.woff2", [join(publicRoot, "fonts/google-sans-flex-latin.woff2"), "font/woff2"]],
      ["/fonts/material-symbols-rounded-v4.woff2", [join(publicRoot, "fonts/material-symbols-rounded-v4.woff2"), "font/woff2"]],
      [`/assets/${fixtureAssetVersion}/client.js`, [join(distRoot, "client.js"), "text/javascript; charset=utf-8"]],
      [`/assets/${fixtureAssetVersion}/index.js`, [join(distRoot, "index.js"), "text/javascript; charset=utf-8"]],
      [`/assets/${fixtureAssetVersion}/units.js`, [join(distRoot, "units.js"), "text/javascript; charset=utf-8"]],
    ]);
    const asset = assets.get(url.pathname);

    // serve allowlisted browser assets
    if (asset !== undefined) {
      response.statusCode = 200;
      response.setHeader("content-type", asset[1]);
      const source = readFileSync(asset[0]);
      response.end(
        url.pathname === "/" ||
          url.pathname === "/logs" ||
          url.pathname === "/logs/" ||
          url.pathname === "/map" ||
          url.pathname === "/map/" ||
          url.pathname === "/admin" ||
          url.pathname === "/admin/" ||
          url.pathname === "/forecast" ||
          url.pathname === "/forecast/" ||
          url.pathname === "/trends" ||
          url.pathname === "/trends/" ||
          url.pathname === "/settings" ||
          url.pathname === "/settings/" ||
          url.pathname === "/service-worker.js"
          ? source.toString("utf8").replaceAll("__WEATHER_ASSET_VERSION__", fixtureAssetVersion)
            .replaceAll("__WEATHER_ROUTE_PRELOAD__", "")
          : source,
      );
      return;
    }

    response.statusCode = 404;
    response.end("not found");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();

  // require the expected TCP listener
  if (address === null || typeof address === "string") {
    throw new Error("fixture server did not bind a TCP port");
  }

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    server,
    state,
  };
}

test("manifest and service worker provide an installable application shell", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      timezoneId: "America/Los_Angeles",
      viewport: { height: 780, width: 390 },
    });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    assert.equal(
      await page.locator('link[rel="manifest"]').getAttribute("href"),
      "/manifest.webmanifest",
    );
    assert.equal(
      await page.locator('link[rel="icon"][type="image/png"]').getAttribute("href"),
      "/brand/ballydidean-weather-icon-32.png",
    );
    assert.equal(
      await page.locator('link[rel="apple-touch-icon"]').getAttribute("href"),
      "/brand/ballydidean-weather-icon-180.png",
    );
    const manifest = await page.evaluate(
      // read the same-origin installation metadata
      async () => await fetch("/manifest.webmanifest").then(
        // parse one manifest response
        async (response) => await response.json(),
      ),
    );
    assert.equal(manifest.name, "Ballydídean Weather");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.deepEqual(
      manifest.icons.map(
        // capture current icon identities
        (icon) => icon.src,
      ),
      [
        "/brand/ballydidean-weather-icon-192.png",
        "/brand/ballydidean-weather-icon-512.png",
        "/brand/ballydidean-weather-icon-maskable-512.png",
      ],
    );
    assert.equal(
      manifest.icons.some(
        // require one adaptive launcher icon
        (icon) => icon.sizes === "512x512" && icon.purpose === "maskable",
      ),
      true,
    );
    // verify generated png dimensions
    assert.equal(readFileSync(join(publicRoot, "brand/ballydidean-weather-icon-32.png")).readUInt32BE(16), 32);
    assert.equal(readFileSync(join(publicRoot, "brand/ballydidean-weather-icon-180.png")).readUInt32BE(16), 180);
    assert.equal(readFileSync(join(publicRoot, "brand/ballydidean-weather-icon-192.png")).readUInt32BE(16), 192);
    assert.equal(readFileSync(join(publicRoot, "brand/ballydidean-weather-icon-512.png")).readUInt32BE(16), 512);
    assert.equal(readFileSync(join(publicRoot, "brand/ballydidean-weather-icon-maskable-512.png")).readUInt32BE(16), 512);
    assert.equal(
      manifest.icons.some(
        // require one compact launcher icon
        (icon) => icon.sizes === "192x192" && icon.purpose === "any",
      ),
      true,
    );
    const registration = await page.evaluate(async () => {
      const ready = await navigator.serviceWorker.ready;
      return {
        active: ready.active?.state ?? null,
        scriptUrl: ready.active?.scriptURL ?? null,
        scope: ready.scope,
        updateViaCache: ready.updateViaCache,
      };
    });
    assert.equal(registration.active, "activated");
    assert.equal(registration.scriptUrl, `${fixture.origin}/service-worker.js?release=browser-test`);
    assert.equal(registration.scope, `${fixture.origin}/`);
    assert.equal(registration.updateViaCache, "none");
    assert.equal(
      await page.evaluate(async () => (await caches.keys()).includes("ballydidean-weather-shell-browser-test")),
      true,
    );
    await page.context().setOffline(true);
    assert.equal(
      await page.evaluate(
        // prove a cached route survives network loss
        async () => await fetch("/forecast").then(
          // read one offline shell response
          (response) => response.status,
        ),
      ),
      200,
    );
    assert.equal(
      await page.evaluate(
        // keep display preferences available offline
        async () => await fetch("/settings").then(
          // read one offline settings shell
          (response) => response.status,
        ),
      ),
      200,
    );
    await page.context().setOffline(false);
  } finally {
    // close only disposable browser resources
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("forecast adjustment stays explicit and fail-raw on desktop and mobile", { timeout: 120_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();

    // verify every Stage 7 browser state at both responsive widths
    for (const viewport of [
      { height: 900, width: 960 },
      { height: 844, width: 390 },
    ]) {
      const page = await createFixturePage(browser, {
        hasTouch: viewport.width < 600,
        viewport,
      });

      // prove the inactive registry preserves the raw presentation
      fixture.state.adjustmentMode = "inactive";
      await page.goto(`${fixture.origin}/forecast`, { waitUntil: "networkidle" });
      assert.equal(await page.locator(".forecast-chart").count(), 8);
      assert.equal(await page.locator("[data-forecast-adjustment-status]").count(), 0);
      assert.equal(await page.getByText("Locally adjusted", { exact: true }).count(), 0);
      const inactiveToggle = page.getByRole("switch", { name: "Use locally adjusted forecasts" });
      assert.equal(await inactiveToggle.getAttribute("aria-checked"), "false");
      assert.equal(await inactiveToggle.isDisabled(), true);
      assert.match(await inactiveToggle.textContent() ?? "", /Regional/u);

      // prove a verified bundle labels prominent adjusted values
      fixture.state.adjustmentMode = "active";
      await page.reload({ waitUntil: "networkidle" });
      const status = page.locator("[data-forecast-adjustment-status]");
      const adjustmentToggle = page.getByRole("switch", { name: "Use locally adjusted forecasts" });
      await status.waitFor();
      assert.equal(await adjustmentToggle.getAttribute("aria-checked"), "true");
      assert.equal(await adjustmentToggle.isEnabled(), true);
      assert.equal(
        await adjustmentToggle.evaluate(
          // require the switch inside the top-right masthead actions
          (toggle) => toggle.parentElement?.classList.contains("masthead-actions") === true,
        ),
        true,
      );
      assert.equal(await status.getAttribute("data-forecast-adjustment-state"), "active");
      assert.match(await status.textContent() ?? "", /Locally adjusted[\s\S]*Temperature, Wind speed adjusted/u);
      assert.equal(
        (await page.locator('[data-forecast-chart="temperature"] [data-forecast-value="0"]').textContent())?.trim(),
        "58 °F",
      );
      await status.locator("summary").click();
      assert.match(await status.textContent() ?? "", /Raw 54\.5 °F[\s\S]*Adjusted 58\.1 °F/u);
      assert.match(await status.textContent() ?? "", /open-meteo-forecast-v1 · forecast · best_match/u);
      assert.match(await status.textContent() ?? "", /robust-hierarchical-median\/v1/u);

      // require every bounded runtime and model hash
      for (const hash of Object.values(adjustmentHashes)) {
        assert.match(await status.textContent() ?? "", new RegExp(hash, "u"));
      }

      const activeScreen = await status.screenshot();
      assert.ok(activeScreen.byteLength > 1_000);

      const forecastScrubber = page.getByRole("slider", { name: "Forecast time scrubber" });
      await forecastScrubber.press("ArrowRight");
      const forecastScrubberBounds = await forecastScrubber.boundingBox();
      assert.notEqual(forecastScrubberBounds, null);
      await forecastScrubber.click({
        position: {
          x: forecastScrubberBounds.width * 0.437,
          y: forecastScrubberBounds.height / 2,
        },
      });
      const selectedForecastPosition = await forecastScrubber.getAttribute("data-forecast-selected-position");
      assert.equal(Number.isInteger(Number(selectedForecastPosition)), false);
      const adjustedTemperature = (await page.locator('[data-forecast-chart="temperature"] [data-forecast-value="0"]').textContent())?.trim();
      await adjustmentToggle.click();
      const regionalToggle = page.getByRole("switch", { name: "Use locally adjusted forecasts" });
      assert.equal(await regionalToggle.getAttribute("aria-checked"), "false");
      assert.match(await regionalToggle.textContent() ?? "", /Regional/u);
      assert.equal(await regionalToggle.evaluate((toggle) => document.activeElement === toggle), true);
      assert.equal(
        await forecastScrubber.getAttribute("data-forecast-selected-position"),
        selectedForecastPosition,
      );
      assert.notEqual(
        (await page.locator('[data-forecast-chart="temperature"] [data-forecast-value="0"]').textContent())?.trim(),
        adjustedTemperature,
      );
      assert.equal(await status.getAttribute("data-forecast-adjustment-state"), "raw");
      assert.match(await status.textContent() ?? "", /Regional forecast[\s\S]*Local adjustment turned off/u);

      // preserve the preference across reloads and both forecast-bearing routes
      await page.reload({ waitUntil: "networkidle" });
      assert.equal(await adjustmentToggle.getAttribute("aria-checked"), "false");
      await page.goto(fixture.origin, { waitUntil: "networkidle" });
      assert.equal(await adjustmentToggle.getAttribute("aria-checked"), "false");
      const rawHomeTemperature = await page.locator("[data-condition='temperature'] .condition-forecast-readings").textContent();
      await adjustmentToggle.click();
      assert.equal(await adjustmentToggle.getAttribute("aria-checked"), "true");
      assert.notEqual(
        await page.locator("[data-condition='temperature'] .condition-forecast-readings").textContent(),
        rawHomeTemperature,
      );
      await page.getByRole("link", { name: "Forecast" }).click();
      await page.locator("[data-forecast-charts]").waitFor();
      assert.equal(await adjustmentToggle.getAttribute("aria-checked"), "true");

      // prove extended hours switch back to explicit raw values
      await page.getByRole("button", { name: "10 days" }).click();
      await page.locator('[data-forecast-charts][data-forecast-days="10"]').waitFor();
      assert.match(
        await page.locator(".forecast-adjustment-limit").textContent() ?? "",
        /Hours 169–240 use the raw regional forecast with no local adjustment/u,
      );
      await page.locator("[data-forecast-charts]").press("End");
      assert.equal(await status.getAttribute("data-forecast-adjustment-state"), "raw");
      assert.match(await status.textContent() ?? "", /Raw forecast[\s\S]*No local adjustment beyond 168 hours/u);
      await status.locator("summary").click();
      assert.equal(await status.locator(".forecast-adjustment-values").count(), 0);
      assert.match(await status.locator(".forecast-adjustment-raw-note").textContent() ?? "", /raw regional forecast/u);

      // prove a bundle cross-link fault cannot interrupt raw charts
      fixture.state.adjustmentMode = "fault";
      await page.reload({ waitUntil: "networkidle" });
      const fallback = page.locator('[data-forecast-adjustment-reason="bundle_invalid"]');
      await fallback.waitFor();
      assert.match(await fallback.textContent() ?? "", /Raw forecast[\s\S]*Local adjustment unavailable/u);
      assert.equal(await page.getByText("Locally adjusted", { exact: true }).count(), 0);
      assert.equal(await page.locator(".forecast-chart").count(), 8);
      assert.equal(
        await page.locator("body").evaluate(
          // reject adjustment status horizontal overflow
          (body) => body.scrollWidth > document.documentElement.clientWidth,
        ),
        false,
      );
      const fallbackScreen = await fallback.screenshot();
      assert.ok(fallbackScreen.byteLength > 500);
      await page.close();
    }
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

// verify public navigation preserves one document and browser history
test("public navigation updates the URL and restores routed content from history", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      timezoneId: "America/Los_Angeles",
      viewport: { height: 900, width: 1440 },
    });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    await page.locator(".current-conditions").waitFor();
    await page.evaluate(
      // mark the current document against full-page reloads
      () => {
        document.documentElement.dataset.navigationDocument = "preserved";
      },
    );

    await page.getByRole("link", { name: "Forecast" }).click();
    await page.waitForURL(`${fixture.origin}/forecast`);
    await page.locator(".forecast-panel").waitFor();
    assert.equal(
      await page.evaluate(
        // confirm navigation kept the original document
        () => document.documentElement.dataset.navigationDocument,
      ),
      "preserved",
    );
    assert.equal(await page.getByRole("link", { name: "Forecast" }).getAttribute("aria-current"), "page");

    await page.getByRole("link", { name: "Trends" }).click();
    await page.waitForURL(`${fixture.origin}/trends`);
    await page.locator(".trends-panel").waitFor();
    assert.equal(await page.getByRole("link", { name: "Trends" }).getAttribute("aria-current"), "page");

    await page.evaluate(
      // restore the preceding application route
      () => window.history.back(),
    );
    await page.waitForURL(`${fixture.origin}/forecast`);
    await page.locator(".forecast-panel").waitFor();
    assert.equal(await page.getByRole("link", { name: "Forecast" }).getAttribute("aria-current"), "page");

    await page.evaluate(
      // revisit the next application route
      () => window.history.forward(),
    );
    await page.waitForURL(`${fixture.origin}/trends`);
    await page.locator(".trends-panel").waitFor();
    assert.equal(
      await page.evaluate(
        // confirm history traversal kept the original document
        () => document.documentElement.dataset.navigationDocument,
      ),
      "preserved",
    );
  } finally {
    // close only disposable browser resources
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

// verify embedded navigation owns the visible same-origin URL
test("same-origin iframe navigation updates the parent URL", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      timezoneId: "America/Los_Angeles",
      viewport: { height: 900, width: 1440 },
    });
    await page.goto(`${fixture.origin}/embed`, { waitUntil: "networkidle" });
    const frame = page.frameLocator('iframe[title="Embedded weather"]');
    await frame.locator(".current-conditions").waitFor();
    await frame.locator("html").evaluate(
      // mark the child document against iframe reloads
      (documentElement) => {
        documentElement.dataset.navigationDocument = "preserved";
      },
    );

    await frame.getByRole("link", { name: "Forecast" }).click();
    await page.waitForURL(`${fixture.origin}/forecast`, { timeout: 3_000 });
    await frame.locator(".forecast-panel").waitFor();
    assert.equal(
      await frame.locator("html").evaluate(
        // confirm the embedded document stayed mounted
        (documentElement) => documentElement.dataset.navigationDocument,
      ),
      "preserved",
    );

    await frame.getByRole("link", { name: "Trends" }).click();
    await page.waitForURL(`${fixture.origin}/trends`);
    await frame.locator(".trends-panel").waitFor();

    await page.evaluate(
      // restore the preceding embedded route
      () => window.history.back(),
    );
    await page.waitForURL(`${fixture.origin}/forecast`);
    await frame.locator(".forecast-panel").waitFor();

    await page.evaluate(
      // restore the embedding host route
      () => window.history.back(),
    );
    await page.waitForURL(`${fixture.origin}/embed`);
    await frame.locator(".current-conditions").waitFor();
  } finally {
    // close only disposable browser resources
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

// send one bounded JSON response
function sendJson(response, body, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

// verify one rejected site wall clock
async function assertRejectedSiteWallClock(page, fixture, field, value) {
  const apiReadsBefore = fixture.state.requests.filter(
    // count weather data reads
    (entry) => entry.includes("/current") || entry.includes("/history"),
  ).length;
  await page.locator(`input[name='${field}']`).fill(value);
  await page.getByRole("button", { name: "Apply filters" }).click();
  const alert = page.getByRole("alert");
  await alert.waitFor();
  const message = await alert.textContent() ?? "";
  const apiReadsAfter = fixture.state.requests.filter(
    // recount weather data reads
    (entry) => entry.includes("/current") || entry.includes("/history"),
  ).length;

  assert.match(message, /daylight saving time/u);
  assert.match(message, /choose another time/iu);
  assert.equal(message.length <= 160, true);
  assert.equal(apiReadsAfter, apiReadsBefore);
  assert.equal(await page.locator(".table-scroll").getByText("61.2").count(), 1);
  assert.equal(await page.locator(".table-scroll").getByText("61.2").isVisible(), true);
}

test("real browser covers filters, pagination, last-good recovery, attribution, and mutation denial", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      timezoneId: "UTC",
      viewport: { height: 900, width: 1440 },
    });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    await assert.doesNotReject(() => page.getByRole("heading", { name: "Ballydídean Weather" }).waitFor());
    assert.equal(
      await page.evaluate(async () => {
        // wait for the bundled Pixel typeface
        await document.fonts.ready;
        return document.fonts.check('16px "Google Sans Flex"');
      }),
      true,
    );
    assert.match(
      await page.locator("body").evaluate(
        // require the Pixel typography across the application
        (body) => getComputedStyle(body).fontFamily,
      ),
      /Google Sans Flex/u,
    );
    assert.match(
      await page.locator("[data-condition='temperature']").textContent() ?? "",
      /61\s*°F/u,
    );
    assert.doesNotMatch(
      await page.locator("[data-condition='air-quality']").textContent() ?? "",
      /µg\/m³/u,
    );
    assert.deepEqual(
      await page.locator(".condition-card").first().evaluate(
        // require shared Material card shape and elevation
        (card) => {
          const style = getComputedStyle(card);
          return {
            borderRadius: style.borderRadius,
            elevated: style.boxShadow !== "none",
          };
        },
      ),
      { borderRadius: "24px", elevated: true },
    );
    assert.equal(
      await page.evaluate(() => document.fonts.check('20px "Material Symbols Rounded"')),
      true,
    );
    assert.match(
      await page.locator(".section-nav-settings .material-symbols-rounded").evaluate(
        // require the official Material symbol face
        (icon) => getComputedStyle(icon).fontFamily,
      ),
      /Material Symbols Rounded/u,
    );
    assert.equal(await page.locator(".condition-color rect").count(), 8);
    assert.equal(await page.locator(".condition-label .material-symbols-rounded").count(), 8);
    assert.equal(await page.locator(".condition-status-color rect").count(), 8);
    assert.equal(await page.locator(".condition-status-dark").count(), 8);
    assert.equal(await page.locator(".condition-status-light").count(), 0);
    assert.equal(
      await page.locator("[data-condition='humidity'] .condition-status-color rect").getAttribute("fill"),
      "rgb(239, 126, 31)",
    );
    assert.match(await page.locator("[data-condition='humidity']").textContent() ?? "", /Very humid/u);
    assert.equal(
      await page.locator(".condition-status-dark").first().evaluate(
        // require maximum contrast over mid-tone bands
        (status) => getComputedStyle(status).color,
      ),
      "rgb(0, 0, 0)",
    );
    assert.deepEqual(
      await page.locator(".condition-card").evaluateAll(
        // freeze the requested reading order
        (cards) => cards.map((card) => card.getAttribute("data-condition")),
      ),
      ["temperature", "wind", "rain", "tide", "humidity", "air-quality", "pressure", "uv-index"],
    );
    assert.deepEqual(
      await page.locator(".current-conditions").evaluate(
        // place wind beside temperature
        (grid) => {
          // read one named card
          const bounds = (name) => grid.querySelector(`[data-condition='${name}']`)?.getBoundingClientRect();
          const temperature = bounds("temperature");
          const wind = bounds("wind");

          // require the complete primary row
          if (temperature === undefined || wind === undefined) {
            throw new Error("condition grid is incomplete");
          }

          return {
            equalPrimaryWidths: Math.abs(wind.width - temperature.width) < 1,
            windBesideTemperature: Math.abs(wind.top - temperature.top) < 1 && wind.left >= temperature.right,
          };
        },
      ),
      { equalPrimaryWidths: true, windBesideTemperature: true },
    );
    assert.deepEqual(
      await page.locator('.section-nav a[aria-current="page"] .section-nav-icon').evaluate(
        // require the active Material indicator pill
        (indicator) => {
          const bounds = indicator.getBoundingClientRect();
          const style = getComputedStyle(indicator);
          return {
            backgroundColor: style.backgroundColor,
            height: bounds.height,
            width: bounds.width,
          };
        },
      ),
      { backgroundColor: "rgb(240, 230, 150)", height: 32, width: 56 },
    );
    assert.equal(await page.locator(".weather-content > .current-conditions").count(), 1);
    assert.equal(await page.locator(".current-panel, #current-heading, .freshness, .provenance").count(), 0);
    assert.equal(await page.getByText("Right now", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Forecast timeline" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Yearly trends" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Nearby station map" }).count(), 0);
    assert.deepEqual(
      await page.locator(".weather-content > .panel").evaluateAll(
        // require every section wrapper to remain visually flat
        (panels) => panels.map((panel) => {
          const style = getComputedStyle(panel);
          return {
            backgroundColor: style.backgroundColor,
            borderWidth: style.borderWidth,
            boxShadow: style.boxShadow,
            padding: style.padding,
          };
        }),
      ),
      [],
    );
    assert.equal(await page.locator(".alert-list").count(), 0);
    assert.equal(await page.getByText("Farm sensor map").count(), 0);
    await page.getByRole("link", { name: "Forecast" }).click();
    await page.waitForURL(`${fixture.origin}/forecast`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByRole("heading", { name: "Forecast timeline" }).count(), 0);
    assert.equal(await page.locator(".forecast-panel > .forecast-controls + .forecast-chart-shell").count(), 1);
    assert.equal(await page.locator(".forecast-model, .forecast-scrub-help").count(), 0);
    assert.equal(await page.locator(".section-nav-forecast").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".current-conditions, .trends-panel, .station-map-panel, [data-history-filters]").count(), 0);
    await page.getByRole("link", { name: "Map", exact: true }).click();
    await page.waitForURL(`${fixture.origin}/map`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByRole("heading", { name: "Property sensors" }).isVisible(), true);
    const propertyMap = page.locator(".property-map");
    const propertySensorList = page.locator(".property-sensor-list");
    // wait for route data to replace the map skeleton
    await propertySensorList.getByText("Orchard soil", { exact: true }).waitFor();
    assert.equal(await propertySensorList.getByText("Orchard soil", { exact: true }).isVisible(), true);
    assert.match(await propertySensorList.textContent() ?? "", /Temp 63\.9 °F/u);
    const propertySensorListButton = propertySensorList.locator('[data-property-sensor-view="soil-1"]');
    const propertySensorMarker = propertyMap.locator('[data-property-sensor-view="soil-1"]');
    assert.equal(
      await propertyMap.locator(".property-sensor-marker-head").evaluateAll(
        // separate markers that share an exact coordinate
        (heads) => new Set(heads.map((head) => head.getAttribute("transform"))).size,
      ),
      2,
    );
    assert.deepEqual(
      await page.locator(".property-map-layout").evaluate(
        // keep the bounded sensor catalog to the map's right
        (layout) => {
          const map = layout.querySelector(".property-map");
          const list = layout.querySelector(".property-sensor-list");

          // require both layout columns
          if (!(map instanceof HTMLElement) || !(list instanceof HTMLElement)) {
            throw new Error("property map layout is incomplete");
          }

          const mapBounds = map.getBoundingClientRect();
          const listBounds = list.getBoundingClientRect();
          const style = getComputedStyle(list);
          return {
            listRightOfMap: listBounds.left >= mapBounds.right,
            overflowY: style.overflowY,
          };
        },
      ),
      { listRightOfMap: true, overflowY: "auto" },
    );
    assert.equal(await page.locator("[data-property-sensor-details]").count(), 0);
    await propertySensorListButton.hover();
    assert.equal(await propertySensorMarker.evaluate((marker) => marker.classList.contains("related-hover")), true);
    assert.equal(
      await propertySensorMarker.locator(".property-sensor-marker-dot").evaluate(
        // expose the corresponding map marker strongly
        (marker) => getComputedStyle(marker).strokeWidth,
      ),
      "5px",
    );
    await propertySensorMarker.click();
    const propertySensorDetails = page.locator('[data-property-sensor-details="soil-1"]');
    assert.equal(await propertySensorListButton.getAttribute("aria-expanded"), "true");
    assert.equal(await propertySensorDetails.isVisible(), true);
    assert.match(await propertySensorDetails.textContent() ?? "", /Temp 63\.9 °F/u);
    assert.match(await propertySensorDetails.textContent() ?? "", /Moisture 42 %/u);
    assert.match(await propertySensorDetails.textContent() ?? "", /EcoWitt WH52 · channel 1 · soil-1/u);
    assert.match(await propertySensorDetails.textContent() ?? "", /Position 47\.950500, -122\.428100/u);
    assert.equal(await propertySensorMarker.getAttribute("aria-expanded"), "true");
    assert.equal(await propertyMap.locator("[data-property-map-layer]").count(), 3);
    assert.equal(await propertyMap.getByRole("button", { name: "Satellite" }).getAttribute("aria-pressed"), "true");
    assert.match(
      await propertyMap.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /imagery\.nationalmap\.gov\/arcgis\/rest\/services\/USGSNAIPImagery[\s\S]*size=1280%2C800/u,
    );
    assert.equal(
      await page.locator(".property-map-panel .property-sensor-list-icon .material-symbols-rounded").first().textContent(),
      "device_thermostat",
    );
    await propertyMap.getByRole("button", { name: "Topo" }).click();
    assert.match(
      await propertyMap.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /USGSTopo\/MapServer\/tile\/16\//u,
    );
    await propertyMap.getByRole("button", { name: "Satellite" }).click();
    assert.match(
      await propertyMap.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /imagery\.nationalmap\.gov\/arcgis\/rest\/services\/USGSNAIPImagery[\s\S]*size=1280%2C800/u,
    );
    await propertyMap.getByRole("button", { name: "Roads" }).click();
    assert.equal(await propertyMap.getByRole("button", { name: "Roads" }).getAttribute("aria-pressed"), "true");
    assert.match(
      await propertyMap.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /tile\.openstreetmap\.org\/17\//u,
    );
    const propertySensorMarkerSize = await propertyMap.locator(".property-sensor-marker").first().evaluate(
      // capture one marker's fixed visual footprint
      (marker) => {
        const bounds = marker.getBoundingClientRect();
        return { height: bounds.height, width: bounds.width };
      },
    );
    await propertyMap.getByRole("button", { name: "Zoom in" }).click();
    await propertyMap.getByRole("button", { name: "Zoom in" }).click();
    const zoomedPropertySensorMarkerSize = await propertyMap.locator(".property-sensor-marker").first().evaluate(
      // keep marker graphics fixed-size while their anchors move
      (marker) => {
        const bounds = marker.getBoundingClientRect();
        return { height: bounds.height, width: bounds.width };
      },
    );
    assert.equal(Math.abs(zoomedPropertySensorMarkerSize.height - propertySensorMarkerSize.height) < 0.01, true);
    assert.equal(Math.abs(zoomedPropertySensorMarkerSize.width - propertySensorMarkerSize.width) < 0.01, true);
    const propertyMapTransform = await propertyMap.locator("[data-property-interactive-map]").evaluate(
      // verify zoom remains inside the original fixed property extent
      (svg) => ({
        height: Number(svg.dataset.propertyMapHeight),
        scale: Number(svg.dataset.propertyMapScale),
        translateX: Number(svg.dataset.propertyMapTranslateX),
        translateY: Number(svg.dataset.propertyMapTranslateY),
        width: Number(svg.dataset.propertyMapWidth),
      }),
    );
    assert.equal(propertyMapTransform.scale, 2.25);
    assert.equal(propertyMapTransform.translateX <= 0, true);
    assert.equal(propertyMapTransform.translateY <= 0, true);
    assert.equal(
      propertyMapTransform.translateX >= propertyMapTransform.width - propertyMapTransform.width * propertyMapTransform.scale,
      true,
    );
    assert.equal(
      propertyMapTransform.translateY >= propertyMapTransform.height - propertyMapTransform.height * propertyMapTransform.scale,
      true,
    );
    const propertyMapBounds = await propertyMap.locator("[data-property-interactive-map]").boundingBox();

    // pan the zoomed map and retain the bounded translation
    if (propertyMapBounds !== null) {
      await page.mouse.move(
        propertyMapBounds.x + propertyMapBounds.width / 2,
        propertyMapBounds.y + propertyMapBounds.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        propertyMapBounds.x + propertyMapBounds.width,
        propertyMapBounds.y + propertyMapBounds.height,
      );
      await page.mouse.up();
    }

    const pannedPropertyMapTransform = await propertyMap.locator("[data-property-interactive-map]").evaluate(
      // retain the original bounds after an extreme pan
      (svg) => ({
        height: Number(svg.dataset.propertyMapHeight),
        scale: Number(svg.dataset.propertyMapScale),
        translateX: Number(svg.dataset.propertyMapTranslateX),
        translateY: Number(svg.dataset.propertyMapTranslateY),
        width: Number(svg.dataset.propertyMapWidth),
      }),
    );
    assert.equal(pannedPropertyMapTransform.translateX <= 0, true);
    assert.equal(pannedPropertyMapTransform.translateY <= 0, true);
    assert.equal(
      pannedPropertyMapTransform.translateX >= pannedPropertyMapTransform.width - pannedPropertyMapTransform.width * pannedPropertyMapTransform.scale,
      true,
    );
    assert.equal(
      pannedPropertyMapTransform.translateY >= pannedPropertyMapTransform.height - pannedPropertyMapTransform.height * pannedPropertyMapTransform.scale,
      true,
    );
    await propertyMap.getByRole("button", { name: "Reset map" }).click();
    assert.equal(
      await propertyMap.locator("[data-property-interactive-map]").getAttribute("data-property-map-scale"),
      "1",
    );
    assert.equal(
      await page.locator(".property-map-panel").evaluate(
        // keep the property map before the public station map
        (propertyMap) => propertyMap.nextElementSibling?.classList.contains("station-map-panel") === true,
      ),
      true,
    );
    assert.equal(await page.getByRole("heading", { name: "Nearby station map" }).isVisible(), true);
    assert.equal(await page.locator(".section-nav-map").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".current-conditions, .forecast-panel, .trends-panel").count(), 0);
    const map = page.locator(".station-map");
    const sharedMapSurface = await map.locator(".station-map-svg").evaluate((svg) => ({
      markerOwner: svg.querySelector(".station-marker")?.ownerSVGElement === svg,
      overlayOwner: svg.querySelector(".station-map-overlay")?.ownerSVGElement === svg,
      tileOwner: svg.querySelector(".map-tile-layer image")?.ownerSVGElement === svg,
    }));
    assert.deepEqual(sharedMapSurface, {
      markerOwner: true,
      overlayOwner: true,
      tileOwner: true,
    });
    assert.equal(
      await map.locator(".station-marker-hit-target").count(),
      await map.locator(".station-marker").count(),
    );
    const mapStyleControls = map.locator(".map-style-controls");
    assert.equal(
      await mapStyleControls.evaluate(
        // keep the illustrated picker inside the map canvas
        (controls) => controls.parentElement?.classList.contains("station-map-canvas"),
      ),
      true,
    );
    assert.equal(await mapStyleControls.locator("img").count(), 3);
    assert.deepEqual(
      await page.locator(".nearby-station-list").evaluate(
        // keep station navigation in the page scroll
        (list) => {
          const style = getComputedStyle(list);
          return {
            maxHeight: style.maxHeight,
            overflowY: style.overflowY,
          };
        },
      ),
      { maxHeight: "none", overflowY: "visible" },
    );
    assert.match(
      await map.getByRole("button", { name: "Roads" }).locator("img").getAttribute("src") ?? "",
      /tile\.openstreetmap\.org\/13\//u,
    );
    assert.match(
      await map.getByRole("button", { name: "Topo" }).locator("img").getAttribute("src") ?? "",
      /USGSTopo\/MapServer\/tile\/13\//u,
    );
    assert.match(
      await map.getByRole("button", { name: "Satellite" }).locator("img").getAttribute("src") ?? "",
      /USGSImageryOnly\/MapServer\/tile\/13\//u,
    );
    const stationListButton = page.locator('.nearby-station-select[data-station-select="tempest-38270"]');
    const stationMarker = map.locator('.station-marker[data-station-select="tempest-38270"]');
    await stationListButton.hover();
    assert.equal(await stationMarker.evaluate((marker) => marker.classList.contains("related-hover")), true);
    assert.equal(
      await stationMarker.locator(".station-marker-dot").evaluate(
        // expose the corresponding public marker strongly
        (marker) => getComputedStyle(marker).strokeWidth,
      ),
      "4px",
    );
    await stationListButton.click();
    const stationCurrent = page.locator('[data-station-current="tempest-38270"]');
    assert.equal(await stationListButton.getAttribute("aria-expanded"), "true");
    assert.equal(await stationCurrent.isVisible(), true);
    assert.match(await stationCurrent.textContent() ?? "", /Temp 53\.6 °F/u);
    assert.match(await stationCurrent.textContent() ?? "", /Wind 5\.6 mph · gust 10\.1 mph/u);
    assert.match(await stationCurrent.textContent() ?? "", /Platform WeatherFlow Tempest/u);
    assert.equal(await page.locator("[data-station-current]").count(), 1);
    await page.reload({ waitUntil: "networkidle" });
    await map.locator('.station-marker[data-station-select="tempest-38270"]').click();
    assert.equal(await page.locator('[data-station-current="tempest-38270"]').isVisible(), true);
    assert.match(
      await map.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /tile\.openstreetmap\.org\/13\//u,
    );
    assert.equal(await map.getByRole("button", { name: "Roads" }).getAttribute("aria-pressed"), "true");
    const topoButton = map.getByRole("button", { name: "Topo" });
    const inactiveTopoGeometry = await topoButton.evaluate(
      // capture the inactive tile footprint
      (button) => {
        const bounds = button.getBoundingClientRect();
        return {
          borderWidth: getComputedStyle(button).borderWidth,
          height: bounds.height,
          width: bounds.width,
        };
      },
    );
    await topoButton.click();
    assert.equal(await topoButton.getAttribute("aria-pressed"), "true");
    assert.deepEqual(
      await topoButton.evaluate(
        // keep active highlighting within the same footprint
        (button) => {
          const bounds = button.getBoundingClientRect();
          return {
            borderWidth: getComputedStyle(button).borderWidth,
            height: bounds.height,
            width: bounds.width,
          };
        },
      ),
      inactiveTopoGeometry,
    );
    assert.match(
      await map.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /USGSTopo\/MapServer\/tile\/13\//u,
    );
    assert.equal(await map.getByText(/U\.S\. Geological Survey/u).isVisible(), true);
    await map.getByRole("button", { name: "Satellite" }).click();
    assert.equal(await map.getByRole("button", { name: "Satellite" }).getAttribute("aria-pressed"), "true");
    assert.match(
      await map.locator(".map-tile-layer image").first().getAttribute("href") ?? "",
      /USGSImageryOnly\/MapServer\/tile\/13\//u,
    );
    assert.equal(await page.locator("[data-history-filters]").count(), 0);
    assert.equal(await page.locator("table").count(), 0);
    assert.equal(
      fixture.state.requests.some(
        // count only normalized history API reads
        (entry) => entry.includes("/api/v1/sites/ballydidean/history"),
      ),
      false,
    );
    await page.getByRole("link", { name: "Trends" }).click();
    await page.waitForURL(`${fixture.origin}/trends`);
    await page.waitForLoadState("networkidle");
    await page.locator("[data-trend-display-mode=aggregate][data-trend-detail=rolling]").waitFor();
    assert.equal(await page.getByRole("heading", { name: "Yearly trends" }).count(), 0);
    assert.equal(await page.getByText("Calendar comparison", { exact: true }).count(), 0);
    assert.equal(await page.locator(".section-nav-trends").getAttribute("aria-current"), "page");
    assert.equal(await page.locator(".current-conditions, .forecast-panel, .station-map-panel, [data-history-filters]").count(), 0);
    assert.equal(await page.locator(".trend-chart").count(), 1);
    assert.equal(await page.locator(".trend-month-label").count(), 12);
    assert.equal(await page.locator(".trend-historical-quartile-band").count(), 1);
    assert.equal(await page.locator(".trend-historical-range-line").count(), 2);
    assert.equal(await page.locator(".trend-aggregate-median-line").count(), 1);
    assert.equal(await page.locator(".trend-year-line").count(), 1);
    assert.equal(await page.locator(".trend-year-hit-target").count(), 0);
    assert.equal(await page.locator(".trend-year-line-current").getAttribute("stroke"), "var(--brand-orange)");
    assert.equal(await page.locator(".trend-y-axis span").count(), 5);
    assert.equal(await page.locator("[data-trend-range]").count(), 0);
    assert.equal(await page.locator("[data-trend-display-mode=aggregate]").count(), 1);
    assert.equal(await page.locator("[data-trend-detail=rolling]").count(), 1);
    const trendMetricTrigger = page.locator("[data-trend-metric-trigger]");
    assert.equal(
      await trendMetricTrigger.evaluate(
        // preserve visible space between the title and caret
        (trigger) => Number.parseFloat(getComputedStyle(trigger).columnGap) >= 4,
      ),
      true,
    );
    assert.equal(await page.getByRole("heading", { name: "Temperature" }).count(), 1);
    assert.equal(await page.locator("[data-trend-metric-option]").count(), 15);
    assert.equal(await page.locator(".trend-metric-option-group").count(), 2);
    assert.equal(await page.locator(".trend-metric-flyover").isVisible(), false);
    await trendMetricTrigger.click();
    assert.equal(await trendMetricTrigger.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator(".trend-metric-flyover").isVisible(), true);
    assert.equal(await page.locator('[data-trend-metric-option="temperatureC"]').getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    assert.equal(await trendMetricTrigger.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('[data-trend-chart="temperatureC"]').count(), 1);
    assert.equal(await page.locator(".trend-chart").getAttribute("data-trend-domain"), "visible");
    assert.equal(await page.locator("[data-trend-crosshair-value=median]").count(), 1);
    assert.equal(await page.locator('[data-trend-crosshair-value="2026"]').count(), 1);
    assert.match(await page.locator("[data-trend-crosshair-date]").textContent() ?? "", /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}$/u);
    const farmCharts = [
      ["cumulativePrecipitationMm", "Cumulative rainfall"],
      ["temperatureAnomalyC", "Temperature anomaly"],
      ["temperatureRangeC", "Daily temperature range"],
      ["drySpellDays", "Dry spell length"],
      ["growingDegreeDaysC", "Growing degree days"],
      ["frostDayCount", "Frost days"],
      ["extremeDayCount", "Extreme day counts"],
      ["windDirectionRose", "Wind direction rose"],
    ];

    // select and render every added farm chart without another API read
    for (const [metric, label] of farmCharts) {
      await trendMetricTrigger.click();
      await page.locator(`[data-trend-metric-option="${metric}"]`).click();
      await page.locator(`[data-trend-chart="${metric}"]`).waitFor();
      assert.equal(await page.getByRole("heading", { name: label }).count(), 1);

      // verify the polar chart's distinct accessible surface
      if (metric === "windDirectionRose") {
        assert.equal(await page.locator(".trend-wind-rose").count(), 1);
        assert.equal(await page.locator("[data-wind-rose-sector]").count() > 0, true);
        assert.equal(await page.locator('[aria-label="Wind direction percentages"] li').count(), 16);
      } else {
        // retain the shared annual line and scrubber contract
        assert.equal(await page.locator(".trend-year-line-current").count(), 1);
        assert.equal(await page.locator("[data-trend-crosshair-value]").count() >= 2, true);
      }
    }

    await trendMetricTrigger.click();
    await page.locator('[data-trend-metric-option="extremeDayCount"]').click();
    await page.locator('[data-trend-chart="extremeDayCount"]').waitFor();
    assert.equal(await page.locator("[data-trend-detail-toggle]").count(), 0);
    assert.equal(await page.locator("[data-trend-extreme-kind]").inputValue(), "heat");
    assert.equal(await page.locator("[data-trend-extreme-threshold]").inputValue(), "86.0");
    await page.locator("[data-trend-extreme-threshold]").fill("80");
    await page.locator("[data-trend-extreme-threshold]").dispatchEvent("change");
    assert.equal(await page.locator("[data-trend-extreme-threshold]").inputValue(), "80.0");
    await page.locator("[data-trend-extreme-kind]").selectOption("rain");
    assert.equal(await page.locator("[data-trend-extreme-kind]").inputValue(), "rain");
    assert.equal(await page.locator("[data-trend-extreme-threshold]").inputValue(), "1.0");
    await trendMetricTrigger.click();
    await page.locator('[data-trend-metric-option="temperatureC"]').click();
    await page.locator('[data-trend-chart="temperatureC"]').waitFor();
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // capture the aggregate viewport-fitted chart contract
        (chart) => {
          const band = chart.querySelector(".trend-historical-quartile-band");
          const landscape = chart.querySelector(".trend-chart-landscape");
          const legend = chart.querySelector(".trend-chart-legend");
          const median = chart.querySelector(".trend-aggregate-median-line");
          const detailToggle = chart.querySelector("[data-trend-detail-toggle]");
          const modeToggle = chart.querySelector("[data-trend-mode-toggle]");
          const ranges = [...chart.querySelectorAll(".trend-historical-range-line")];
          const title = chart.querySelector(".trend-chart-title");
          const titleControl = title?.closest(".trend-metric-control");
          const svg = chart.querySelector(".trend-chart-landscape > svg");
          const viewport = chart.querySelector(".trend-chart-viewport");
          const xAxis = chart.querySelector(".trend-chart-axis");
          const crosshair = chart.querySelector(".trend-crosshair-line");
          const crosshairSummary = chart.querySelector(".trend-crosshair-summary");
          const crosshairValueFlags = chart.querySelector(".trend-crosshair-values");
          const crosshairDateFlag = chart.querySelector("[data-trend-crosshair-date]");
          const currentYearLine = chart.querySelector(".trend-year-line-current");
          const todayMarker = chart.querySelector(".trend-today-marker");

          // require the complete aggregate chart surface
          if (
            band === null ||
            crosshair === null ||
            crosshairDateFlag === null ||
            crosshairSummary === null ||
            crosshairValueFlags === null ||
            currentYearLine === null ||
            detailToggle === null ||
            landscape === null ||
            legend === null ||
            median === null ||
            modeToggle === null ||
            ranges.length !== 2 ||
            title === null ||
            titleControl === null ||
            svg === null ||
            todayMarker === null ||
            viewport === null ||
            xAxis === null
          ) {
            throw new Error("aggregate trend chart is incomplete");
          }

          const landscapeBounds = landscape.getBoundingClientRect();
          const detailToggleBounds = detailToggle.getBoundingClientRect();
          const legendBounds = legend.getBoundingClientRect();
          const titleControlBounds = titleControl.getBoundingClientRect();
          const svgBounds = svg.getBoundingClientRect();
          const viewportBounds = viewport.getBoundingClientRect();
          const xAxisBounds = xAxis.getBoundingClientRect();
          const crosshairBounds = crosshair.getBoundingClientRect();
          const crosshairDateBounds = crosshairDateFlag.getBoundingClientRect();
          const currentYearPoint = currentYearLine.points.getItem(currentYearLine.points.numberOfItems - 1);
          const currentYearY = (currentYearPoint.y / 280) * landscape.clientHeight;
          const summaryValuesStyle = getComputedStyle(crosshairValueFlags);
          const summaryOnLeft = crosshairSummary.classList.contains("trend-crosshair-summary-left");
          return {
            bandOpacity: Number.parseFloat(getComputedStyle(band).opacity),
            crosshairFlagsAttached: Math.abs(
              Number.parseFloat(getComputedStyle(crosshairSummary).left) -
              Number.parseFloat(getComputedStyle(crosshair).left),
            ) < 1,
            crosshairFlagsBlack: getComputedStyle(crosshairValueFlags).backgroundColor ===
              getComputedStyle(crosshairDateFlag).backgroundColor,
            crosshairFlagsInsidePlot: crosshairSummary.offsetTop >= landscape.clientHeight * (42 / 280) - 1 &&
              crosshairSummary.offsetTop + crosshairSummary.offsetHeight <=
                landscape.clientHeight * ((280 - 34) / 280) + 1,
            crosshairFlagsMatchCurrentYear: Math.abs(
              crosshairSummary.offsetTop + crosshairSummary.offsetHeight / 2 - currentYearY,
            ) < 2,
            crosshairFlagsSquareAgainstLine: summaryOnLeft
              ? summaryValuesStyle.borderTopRightRadius === "0px" &&
                summaryValuesStyle.borderBottomRightRadius === "0px"
              : summaryValuesStyle.borderTopLeftRadius === "0px" &&
                summaryValuesStyle.borderBottomLeftRadius === "0px",
            crosshairFlagsTopIsDynamic: crosshairSummary.style.top.endsWith("px"),
            crosshairDateAboveLine: crosshairDateBounds.bottom < crosshairBounds.top,
            crosshairDateCentered: Math.abs(
              crosshairDateBounds.left + crosshairDateBounds.width / 2 -
              (crosshairBounds.left + crosshairBounds.width / 2),
            ) < 1,
            currentYearMatchesToday: getComputedStyle(currentYearLine).stroke ===
              getComputedStyle(todayMarker).borderLeftColor,
            currentYearUsesDarkOrange: getComputedStyle(currentYearLine).stroke === "rgb(239, 126, 31)",
            detailIcon: detailToggle.querySelector("[data-trend-toggle-icon]")?.getAttribute("data-trend-toggle-icon"),
            detailTopLeftOfTitle: detailToggleBounds.right < titleControlBounds.left &&
              Math.abs(detailToggleBounds.top - titleControlBounds.top) < 2,
            legendCentered: Math.abs(
              legendBounds.left + legendBounds.width / 2 -
              (landscapeBounds.left + landscapeBounds.width / 2),
            ) < 2,
            legendPlacement: legend.dataset.trendLegendPlacement,
            legendPlacementMatchesEdge: legend.dataset.trendLegendPlacement === "top"
              ? Number.parseFloat(getComputedStyle(legend).top) > landscape.clientHeight * (42 / 280)
              : legendBounds.bottom <= xAxisBounds.top + 1,
            medianWidth: Number.parseFloat(getComputedStyle(median).strokeWidth),
            minimumSize: landscapeBounds.width >= viewportBounds.width - 1 &&
              landscape.clientWidth >= viewport.clientWidth,
            modeLabel: chart.querySelector("[data-trend-mode-toggle]")?.textContent,
            modeIcon: modeToggle.querySelector("[data-trend-toggle-icon]")?.getAttribute("data-trend-toggle-icon"),
            monthLabels: [...chart.querySelectorAll(".trend-month-label")].map(
              // read one month label
              (label) => label.textContent,
            ),
            preserveAspectRatio: svg.getAttribute("preserveAspectRatio"),
            rangeDashes: ranges.map(
              // capture each historical range pattern
              (line) => getComputedStyle(line).strokeDasharray,
            ),
            titleTag: title.tagName,
            titleTopCentered: Math.abs(
              titleControlBounds.left + titleControlBounds.width / 2 -
              (landscapeBounds.left + landscapeBounds.width / 2),
            ) < 2 && title.closest(".trend-chart-landscape") === landscape,
            svgFitsViewport: Math.abs(svgBounds.width - viewportBounds.width) < 1 &&
              Math.abs(svgBounds.height - viewportBounds.height) < 1,
            todayLabel: todayMarker.textContent,
            todayPositionInsideChart: Number.parseFloat(getComputedStyle(todayMarker).left) > 0 &&
              Number.parseFloat(getComputedStyle(todayMarker).left) < landscape.clientWidth,
          };
        },
      ),
      {
        bandOpacity: 1,
        crosshairFlagsAttached: true,
        crosshairFlagsBlack: true,
        crosshairFlagsInsidePlot: true,
        crosshairFlagsMatchCurrentYear: true,
        crosshairFlagsSquareAgainstLine: true,
        crosshairFlagsTopIsDynamic: true,
        crosshairDateAboveLine: true,
        crosshairDateCentered: true,
        currentYearMatchesToday: true,
        currentYearUsesDarkOrange: true,
        detailIcon: "daily",
        detailTopLeftOfTitle: true,
        legendCentered: true,
        legendPlacement: "bottom",
        legendPlacementMatchesEdge: true,
        medianWidth: 2,
        minimumSize: true,
        modeLabel: "Show all",
        modeIcon: "show-all",
        monthLabels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        preserveAspectRatio: "none",
        rangeDashes: ["3px, 4px", "3px, 4px"],
        titleTag: "H2",
        titleTopCentered: true,
        svgFitsViewport: true,
        todayLabel: "Today",
        todayPositionInsideChart: true,
      },
    );
    await trendMetricTrigger.click();
    await page.locator('[data-trend-metric-option="precipitationMm"]').click();
    await page.locator('[data-trend-chart="precipitationMm"]').waitFor();
    assert.equal(
      await page.locator(".trend-chart-legend").getAttribute("data-trend-legend-placement"),
      "top",
    );
    await page.locator("[data-trend-metric-trigger]").click();
    await page.locator('[data-trend-metric-option="relativeHumidityPercent"]').click();
    await page.locator('[data-trend-chart="relativeHumidityPercent"]').waitFor();
    assert.equal(
      await page.locator(".trend-chart-legend").getAttribute("data-trend-legend-placement"),
      "bottom",
    );
    await page.locator("[data-trend-metric-trigger]").click();
    await page.locator('[data-trend-metric-option="temperatureC"]').click();
    await page.locator('[data-trend-chart="temperatureC"]').waitFor();
    const trendRequestsBeforeSelection = fixture.state.requests.filter(
      // count the calendar endpoint before local chart changes
      (entry) => entry === "GET /api/v1/sites/ballydidean/trends",
    ).length;
    const trendDateBeforeScrub = await page.locator("[data-trend-crosshair-date]").textContent();
    const trendSurfaceBounds = await page.locator("[data-trend-scrub-surface]").boundingBox();

    // require one measurable annual scrub surface
    if (trendSurfaceBounds === null) {
      throw new Error("trend scrub surface is unavailable");
    }

    await page.mouse.move(
      trendSurfaceBounds.x + trendSurfaceBounds.width * 0.8,
      trendSurfaceBounds.y + trendSurfaceBounds.height * 0.5,
    );
    await page.mouse.down();
    await page.mouse.move(
      trendSurfaceBounds.x + trendSurfaceBounds.width * 0.28,
      trendSurfaceBounds.y + trendSurfaceBounds.height * 0.5,
      { steps: 4 },
    );
    await page.mouse.up();
    assert.notEqual(await page.locator("[data-trend-crosshair-date]").textContent(), trendDateBeforeScrub);
    await page.getByRole("button", { name: "Show all" }).click();
    await page.locator("[data-trend-display-mode=all]").waitFor();
    assert.equal(await page.locator('[data-trend-toggle-icon="aggregate"]').count(), 1);
    assert.equal(await page.locator(".trend-aggregate-median-line").count(), 0);
    assert.equal(await page.locator(".trend-year-line").count(), 3);
    assert.equal(await page.locator(".trend-year-hit-target").count(), 3);
    assert.equal(await page.locator(".trend-year-line-current").count(), 1);
    assert.equal(await page.locator("button.trend-year-legend").count(), 3);
    assert.equal(await page.locator("[data-trend-crosshair-value]").count(), 3);
    await page.locator('button.trend-year-legend[data-trend-year-select="2019"]').click();
    await page.locator('[data-selected-trend-year="2019"]').waitFor();
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // verify one selected year fully hides every other line
        (chart) => {
          const selected = chart.querySelector(".trend-year-line-selected");
          const current = chart.querySelector(".trend-year-line-current");
          const hidden = [...chart.querySelectorAll(".trend-year-line:not(.trend-year-line-selected):not(.trend-year-line-current)")];

          // require one selected calendar year
          if (selected === null || current === null) {
            throw new Error("selected trend year is unavailable");
          }

          return {
            crosshairValues: chart.querySelectorAll("[data-trend-crosshair-value]").length,
            currentOpacity: Number.parseFloat(getComputedStyle(current).opacity),
            currentStroke: current.getAttribute("stroke"),
            hiddenOpacities: hidden.map(
              // capture one hidden yearly opacity
              (line) => Number.parseFloat(getComputedStyle(line).opacity),
            ),
            selectedOpacity: Number.parseFloat(getComputedStyle(selected).opacity),
            selectedYear: selected.getAttribute("data-trend-year"),
          };
        },
      ),
      {
        crosshairValues: 2,
        currentOpacity: 1,
        currentStroke: "var(--brand-orange)",
        hiddenOpacities: [0],
        selectedOpacity: 1,
        selectedYear: "2019",
      },
    );
    await page.locator('button.trend-year-legend[data-trend-year-select="2019"]').click();
    await page.locator("[data-selected-trend-year]").waitFor({ state: "detached" });
    const initialTrendGeometry = await page.locator(".trend-chart").evaluate(
      // capture the fixed overview footprint
      (chart) => {
        const landscape = chart.querySelector(".trend-chart-landscape");
        const viewport = chart.querySelector(".trend-chart-viewport");

        // require the daily-detail containers
        if (!(landscape instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
          throw new Error("trend detail geometry is incomplete");
        }

        return {
          height: landscape.clientHeight,
          viewportWidth: viewport.clientWidth,
          width: landscape.clientWidth,
        };
      },
    );
    await page.getByRole("button", { name: "Daily detail" }).click();
    await page.locator("[data-trend-detail=daily]").waitFor();
    assert.equal(await page.locator('[data-trend-toggle-icon="rolling"]').count(), 1);
    const dailyTrendGeometry = await page.locator(".trend-chart").evaluate(
      // verify the one fixed daily-detail canvas
      (chart) => {
        const landscape = chart.querySelector(".trend-chart-landscape");
        const viewport = chart.querySelector(".trend-chart-viewport");

        // require the expanded daily canvas
        if (!(landscape instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
          throw new Error("daily trend geometry is incomplete");
        }

        return {
          height: landscape.clientHeight,
          scrollable: viewport.scrollWidth > viewport.clientWidth,
          width: landscape.clientWidth,
        };
      },
    );
    assert.equal(dailyTrendGeometry.height, initialTrendGeometry.height);
    assert.equal(dailyTrendGeometry.scrollable, true);
    assert.equal(dailyTrendGeometry.width, 3000);
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // keep chart chrome fixed while the daily data canvas moves
        (chart) => {
          const legend = chart.querySelector(".trend-chart-legend");
          const svg = chart.querySelector(".trend-chart-landscape > svg");
          const title = chart.querySelector(".trend-metric-control");
          const viewport = chart.querySelector(".trend-chart-viewport");
          const xAxis = chart.querySelector(".trend-month-axis");

          // require both fixed chrome and scrollable data
          if (
            !(legend instanceof HTMLElement) ||
            !(svg instanceof SVGElement) ||
            !(title instanceof HTMLElement) ||
            !(viewport instanceof HTMLElement) ||
            !(xAxis instanceof HTMLElement)
          ) {
            throw new Error("daily trend scroll layers are incomplete");
          }

          viewport.scrollLeft = 0;
          const viewportBounds = viewport.getBoundingClientRect();
          const initial = {
            legend: legend.getBoundingClientRect().left,
            plot: svg.getBoundingClientRect().left,
            title: title.getBoundingClientRect().left,
            xAxis: xAxis.getBoundingClientRect().left,
          };
          viewport.scrollLeft = 500;
          const legendBounds = legend.getBoundingClientRect();
          const titleBounds = title.getBoundingClientRect();
          return {
            legendFixed: Math.abs(legend.getBoundingClientRect().left - initial.legend) < 1,
            legendVisible: legendBounds.left >= viewportBounds.left - 1 &&
              legendBounds.right <= viewportBounds.right + 1,
            plotMoved: svg.getBoundingClientRect().left < initial.plot - 499,
            titleFixed: Math.abs(title.getBoundingClientRect().left - initial.title) < 1,
            titleVisible: titleBounds.left >= viewportBounds.left - 1 &&
              titleBounds.right <= viewportBounds.right + 1,
            xAxisMoved: xAxis.getBoundingClientRect().left < initial.xAxis - 499,
          };
        },
      ),
      {
        legendFixed: true,
        legendVisible: true,
        plotMoved: true,
        titleFixed: true,
        titleVisible: true,
        xAxisMoved: true,
      },
    );
    assert.equal(await page.locator("[data-trend-zoom]").count(), 0);
    await page.locator("[data-trend-scrub-surface]").evaluate(
      // simulate a two-finger gesture that must not resize the fixed canvas
      (surface) => {
        const bounds = surface.getBoundingClientRect();
        const emit = (type, pointerId, clientX) => surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          buttons: type === "pointerup" ? 0 : 1,
          clientX,
          clientY: bounds.top + bounds.height * 0.55,
          pointerId,
          pointerType: "touch",
        }));
        emit("pointerdown", 41, bounds.left + bounds.width * 0.4);
        emit("pointerdown", 42, bounds.left + bounds.width * 0.6);
        emit("pointermove", 42, bounds.left + bounds.width * 0.8);
        emit("pointerup", 42, bounds.left + bounds.width * 0.8);
        emit("pointerup", 41, bounds.left + bounds.width * 0.4);
      },
    );
    assert.equal(await page.locator(".trend-chart-landscape").evaluate((landscape) => landscape.clientWidth), 3000);
    await page.locator(".trend-chart-viewport").evaluate(
      // reset native scroll before wheel panning
      (viewport) => {
        viewport.scrollLeft = 0;
      },
    );
    await page.locator("[data-trend-scrub-surface]").dispatchEvent("wheel", {
      clientX: trendSurfaceBounds.x + trendSurfaceBounds.width / 2,
      clientY: trendSurfaceBounds.y + trendSurfaceBounds.height / 2,
      deltaY: 120,
    });
    assert.equal(await page.locator(".trend-chart-viewport").evaluate((viewport) => viewport.scrollLeft > 0), true);
    await page.getByRole("button", { name: "7-day average" }).click();
    await page.locator("[data-trend-detail=rolling]").waitFor();
    assert.deepEqual(
      await page.locator(".trend-chart-landscape").evaluate(
        // preserve the initial chart floor after collapsing detail
        (landscape) => ({
          height: landscape.clientHeight,
          widthAtLeastInitial: landscape.clientWidth >= landscape.closest(".trend-chart-viewport").clientWidth,
        }),
      ),
      { height: initialTrendGeometry.height, widthAtLeastInitial: true },
    );
    await trendMetricTrigger.click();
    await page.locator('[data-trend-metric-option="windGustMps"]').click();
    await page.locator('[data-trend-chart="windGustMps"]').waitFor();
    assert.equal(await page.locator(".trend-chart").count(), 1);
    assert.equal(await page.locator('[data-trend-chart="temperatureC"]').count(), 0);
    assert.equal(await page.locator("[data-selected-trend-year]").count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Wind gust" }).count(), 1);
    assert.equal(await page.locator('[data-trend-metric-option="windGustMps"]').getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("[data-trend-crosshair-value]").count(), 3);
    await page.getByRole("button", { name: "Aggregate" }).click();
    await page.locator("[data-trend-display-mode=aggregate]").waitFor();
    assert.equal(await page.locator(".trend-year-line").count(), 1);
    assert.equal(await page.locator(".trend-year-line-current").getAttribute("stroke"), "var(--brand-orange)");
    assert.equal(await page.locator(".trend-aggregate-median-line").count(), 1);
    assert.equal(await page.locator("[data-trend-crosshair-value=median]").count(), 1);
    assert.equal(await page.locator("[data-trend-crosshair-value]").count(), 2);
    assert.equal(
      fixture.state.requests.filter(
        // keep every trend control entirely client-side
        (entry) => entry === "GET /api/v1/sites/ballydidean/trends",
      ).length,
      trendRequestsBeforeSelection,
    );
    assert.ok(
      fixture.state.requests.some(
        // require the parameter-free calendar endpoint
        (entry) => entry === "GET /api/v1/sites/ballydidean/trends",
      ),
    );
    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(`${fixture.origin}/settings`);
    await page.getByRole("link", { name: "Logs", exact: true }).click();
    await page.waitForURL(`${fixture.origin}/logs`);
    await page.waitForLoadState("networkidle");
    await page.locator("table caption").waitFor();
    assert.equal(await page.locator("#current-heading").count(), 0);
    assert.equal(
      await page.locator(".source-kind").getByText("model-derived current conditions").isVisible(),
      true,
    );
    const credits = page.locator(".credits details");
    assert.equal(await credits.getAttribute("open"), null);
    assert.equal(await page.getByRole("link", { name: "Weather data by Open-Meteo" }).isVisible(), false);
    assert.equal(await page.getByRole("link", { name: "CC BY 4.0" }).isVisible(), false);
    await credits.getByText("Data sources & credits", { exact: true }).click();
    assert.equal(await credits.getAttribute("open"), "");
    assert.equal(await page.getByRole("link", { name: "Weather data by Open-Meteo" }).isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "CC BY 4.0" }).isVisible(), true);
    assert.equal(await page.locator(".masthead img").count(), 0);
    assert.equal(await page.locator("[data-site-selector]").count(), 0);
    assert.equal(await page.locator("table caption").count(), 1);
    const currentReadCount = fixture.state.requests.filter(
      // count homepage current reads
      (entry) => entry.includes("/current"),
    ).length;

    await page.locator("select[name='stationSlug']").selectOption("open-meteo-virtual");
    await page.locator("select[name='sourceId']").selectOption("11");
    await page.locator("select[name='sourceKind']").selectOption("reanalysis");
    await page.locator("input[name='from']").fill("2026-08-21T21:30");
    await page.locator("input[name='to']").fill("2026-08-21T22:30");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForLoadState("networkidle");
    assert.equal(
      fixture.state.requests.filter((entry) => entry.includes("/current")).length,
      currentReadCount,
    );
    assert.ok(
      fixture.state.requests.some(
        // require frozen history filter names
        (entry) =>
          entry.includes("/history?") &&
          entry.includes("sourceKind=reanalysis") &&
          entry.includes("from=2026-08-22T04%3A30%3A00.000Z") &&
          entry.includes("to=2026-08-22T05%3A30%3A00.000Z"),
      ),
    );

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("59.2").first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Next" }).isDisabled(), true);
    await page.getByRole("button", { name: "Previous" }).click();
    await page.getByText("61.2").first().waitFor();

    fixture.state.failReads = true;
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").textContent() ?? "", /status 503/u);
    assert.equal(await page.getByText("61.2").first().isVisible(), true);
    assert.equal(await credits.getAttribute("open"), null);
    assert.equal(await page.getByRole("link", { name: "CC BY 4.0" }).isVisible(), false);

    fixture.state.failReads = false;
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.getByText("Weather data is up to date.").waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);

    const mutationStatus = await page.evaluate(async () => {
      const response = await fetch("/api/v1/sites", { method: "POST" });
      return response.status;
    });
    assert.equal(mutationStatus, 405);
    assert.equal(fixture.state.mutations, 1);
    assert.equal(await page.getByText("61.2").first().isVisible(), true);

    await page.locator("body").press("Home");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "A");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "A");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/forecast");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "A");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/trends");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "A");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/map");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "A");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "/settings");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SUMMARY");
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("admin editor names and places a reporting EcoWitt sensor", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      timezoneId: "America/Los_Angeles",
      viewport: { height: 900, width: 900 },
    });
    await page.goto(`${fixture.origin}/admin`, { waitUntil: "networkidle" });
    assert.equal(await page.getByRole("heading", { name: "Property sensors" }).isVisible(), true);
    assert.equal(await page.locator('[data-property-sensor-select="soil-1"]').getAttribute("aria-pressed"), "true");
    assert.equal(
      await page.locator('[data-property-sensor-select="soil-1"] .material-symbols-rounded').textContent(),
      "device_thermostat",
    );
    assert.equal(await page.locator('input[name="icon"]').count(), 4);
    assert.equal(await page.getByLabel("Temperature").isChecked(), true);
    assert.equal(await page.getByRole("button", { name: "Save sensor" }).locator("svg").count(), 1);
    assert.equal(await page.locator(".property-admin-map [data-property-map-layer]").count(), 3);
    await page.locator(".property-admin-map").getByRole("button", { name: "Roads" }).click();
    assert.equal(
      await page.locator(".property-admin-map").getByRole("button", { name: "Roads" }).getAttribute("aria-pressed"),
      "true",
    );
    const name = page.locator('input[name="displayName"]');
    await name.fill("North orchard soil");
    const markerGeometry = await page.locator(".property-position-marker").evaluate(
      // require the marker tip to terminate at its coordinate anchor
      (marker) => {
        const bounds = marker.getBoundingClientRect();
        const pin = marker.querySelector(".property-position-marker-pin");

        // require the complete marker geometry
        if (!(pin instanceof SVGGraphicsElement)) {
          throw new Error("property marker pin is missing");
        }

        const pinBounds = pin.getBBox();
        return {
          height: bounds.height,
          pinBottom: pinBounds.y + pinBounds.height,
          width: bounds.width,
        };
      },
    );
    assert.equal(Math.abs(markerGeometry.pinBottom) < 0.01, true);
    await page.locator(".property-admin-map").getByRole("button", { name: "Zoom in" }).click();
    const zoomedMarkerGeometry = await page.locator(".property-position-marker").evaluate(
      // keep the coordinate marker fixed-size during map zoom
      (marker) => {
        const bounds = marker.getBoundingClientRect();
        return { height: bounds.height, width: bounds.width };
      },
    );
    assert.equal(Math.abs(zoomedMarkerGeometry.height - markerGeometry.height) < 0.01, true);
    assert.equal(Math.abs(zoomedMarkerGeometry.width - markerGeometry.width) < 0.01, true);
    await page.locator("[data-property-position-map]").click({ position: { x: 380, y: 170 } });
    const latitude = Number(await page.locator('input[name="latitude"]').inputValue());
    const longitude = Number(await page.locator('input[name="longitude"]').inputValue());
    assert.equal(Number.isFinite(latitude), true);
    assert.equal(Number.isFinite(longitude), true);
    await page.locator(".property-icon-options label").filter({ hasText: "Air quality" }).click();
    assert.equal(
      await page.locator("[data-property-position-marker-icon]").textContent(),
      "masks",
    );
    assert.equal(
      await page.locator(".property-admin-actions").evaluate(
        // align the save action against the editor's right edge
        (actions) => {
          const button = actions.querySelector("button");
          const form = actions.closest("form");

          // require the rendered save geometry
          if (!(button instanceof HTMLElement) || !(form instanceof HTMLElement)) {
            return false;
          }

          return Math.abs(button.getBoundingClientRect().right - form.getBoundingClientRect().right) < 1;
        },
      ),
      true,
    );
    await page.getByRole("button", { name: "Save sensor" }).click();
    await page.waitForFunction(
      // wait for the saved name to survive the controller rerender
      () => document.querySelector('input[name="displayName"]')?.value === "North orchard soil",
    );
    assert.equal(fixture.state.adminUpdates, 1);
    assert.equal(fixture.state.propertySensorLayout[0].displayName, "North orchard soil");
    assert.equal(fixture.state.propertySensorLayout[0].icon, "air-quality");
    await page.goto(`${fixture.origin}/map`, { waitUntil: "networkidle" });
    assert.equal(await page.getByText("North orchard soil", { exact: true }).first().isVisible(), true);
    assert.equal(
      await page.locator('.property-sensor-marker .property-sensor-marker-icon').first().textContent(),
      "masks",
    );
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("forecast charts share one touch-controlled crosshair", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  fixture.state.tileDelayMs = 250;
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      hasTouch: true,
      viewport: { height: 844, width: 390 },
    });
    await page.goto(`${fixture.origin}/forecast`, { waitUntil: "domcontentloaded" });
    const grid = page.locator("[data-forecast-charts]");
    const line = page.locator(".forecast-shared-crosshair");
    const currentLine = page.locator(".forecast-current-time-line");
    const session = await page.context().newCDPSession(page);

    // dispatch one browser-native touch gesture
    const swipe = async (startX, startY, endX, endY) => {
      await session.send("Input.dispatchTouchEvent", {
        touchPoints: [{ x: startX, y: startY }],
        type: "touchStart",
      });
      await session.send("Input.dispatchTouchEvent", {
        touchPoints: [{ x: endX, y: endY }],
        type: "touchMove",
      });
      await session.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
      await page.waitForTimeout(40);
    };

    assert.equal(await page.locator(".forecast-chart").count(), 8);
    assert.equal(await page.locator(".forecast-chart-line").count(), 10);
    assert.deepEqual(
      await page.locator(".forecast-chart-line").evaluateAll(
        // match every forecast range
        (chartLines) => [...new Set(chartLines.map((chartLine) => getComputedStyle(chartLine).strokeWidth))].sort(),
      ),
      ["1.5px", "2px"],
    );
    assert.equal(await page.locator(".forecast-chart-guide").count(), 0);
    assert.equal(await page.locator(".forecast-chart linearGradient").count(), 10);
    assert.equal(await page.locator(".forecast-chart-scale").count(), 16);
    assert.equal(await page.locator(".forecast-x-tick").count(), 24);
    assert.equal(await page.locator(".forecast-x-axis time").count(), 5);
    assert.equal(await page.locator("button[data-forecast-days]").count(), 3);
    const weatherMap = page.locator("[data-forecast-weather-map]");
    const weatherTiles = page.locator("[data-forecast-map-tile]");
    const weatherLegend = page.locator("[data-forecast-map-legend]");
    const mapSelectionPhase = page.locator("[data-forecast-map-selection-phase]");
    const cacheProgress = page.locator("[data-forecast-map-cache-progress]");
    const cacheProgressBar = page.locator("[data-forecast-map-cache-bar]");
    assert.equal(await weatherMap.count(), 1);
    assert.equal(await weatherTiles.count(), 1);
    assert.equal(
      await page.locator(".forecast-map-layer-controls button").evaluateAll(
        // retain only the four weather overlays
        (buttons) => buttons.length,
      ),
      4,
    );
    assert.equal(await cacheProgress.count(), 1);
    await cacheProgress.waitFor({ state: "visible", timeout: 5_000 });
    assert.match(await cacheProgress.textContent() ?? "", /Caching Radar[\s\S]*\d+%[\s\S]*\d+ of 7 nearby frames ready/u);
    assert.equal(Number(await cacheProgressBar.getAttribute("value")) < 7, true);
    assert.deepEqual(
      await weatherMap.evaluate(
        // place the bare map between the final chart and shared axis
        (map) => ({
          followsCharts: map.previousElementSibling?.classList.contains("forecast-chart-grid") === true,
          precedesAxis: map.nextElementSibling?.classList.contains("forecast-x-axis") === true,
        }),
      ),
      { followsCharts: true, precedesAxis: true },
    );
    assert.equal(await page.getByRole("button", { name: "Radar" }).getAttribute("aria-pressed"), "true");
    assert.equal(await weatherLegend.getAttribute("data-forecast-map-legend-layer"), "radar");
    assert.equal(await weatherLegend.getAttribute("data-forecast-map-legend-phase"), "history");
    assert.equal(await mapSelectionPhase.getAttribute("data-forecast-map-selection-phase"), "history");
    assert.equal((await mapSelectionPhase.textContent() ?? "").trim(), "Historical");
    assert.match(await weatherLegend.textContent() ?? "", /Radar intensity[\s\S]*dBZ[\s\S]*10[\s\S]*30[\s\S]*50[\s\S]*70\+/u);
    const radarLegendGradient = await weatherLegend.locator(".forecast-map-legend-bar").evaluate(
      // require one rendered radar gradient
      (bar) => getComputedStyle(bar).backgroundImage,
    );
    assert.match(radarLegendGradient, /linear-gradient/u);
    assert.match(await weatherTiles.first().getAttribute("data-map-tile-url") ?? "", /\/maps\/xweather\/history\/radar\/\d{14}\/10\/256x168\/47\.950430,-122\.427970\.png$/u);
    await page.waitForFunction(
      // wait for the selected frame decode
      () => document.querySelector("[data-forecast-map-tile]")?.getAttribute("href")?.startsWith("blob:") === true,
    );
    assert.match(await weatherTiles.first().getAttribute("href") ?? "", /^blob:/u);
    assert.equal(await weatherMap.getAttribute("data-forecast-map-phase"), "history");
    assert.equal(await page.locator("[data-forecast-map-slider]").count(), 0);
    assert.equal(await page.locator(".forecast-map-heading, .forecast-map-time, .forecast-map-phase").count(), 0);
    assert.equal(await page.getByRole("link", { name: "Weather maps by Xweather" }).isVisible(), false);
    const credits = page.locator(".credits details");
    await credits.getByText("Data sources & credits", { exact: true }).click();
    assert.equal(await page.getByRole("link", { name: "Weather maps by Xweather" }).isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "OpenStreetMap contributors" }).isVisible(), true);
    await credits.getByText("Data sources & credits", { exact: true }).click();
    await page.waitForFunction(
      // wait for every nearby radar frame
      () => document.querySelector("[data-forecast-weather-map]")?.getAttribute("data-forecast-map-cache-state") === "complete",
      undefined,
      { timeout: 45_000 },
    );
    assert.equal(await weatherMap.getAttribute("data-forecast-map-cache-ready"), "7");
    assert.equal(await weatherMap.getAttribute("data-forecast-map-cache-total"), "7");
    assert.equal(await cacheProgress.isHidden(), true);
    assert.equal(await cacheProgressBar.getAttribute("value"), "7");
    const tileRequestsBeforeReload = fixture.state.requests.filter(
      // count only same-origin weather tile reads
      (entry) => /^GET \/maps\/xweather\/(?:history|forecast)\//u.test(entry),
    ).length;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(
      // restore the complete radar day from persistent browser storage
      () => document.querySelector("[data-forecast-weather-map]")?.getAttribute("data-forecast-map-cache-state") === "complete",
      undefined,
      { timeout: 10_000 },
    );
    assert.equal(
      fixture.state.requests.filter(
        // count only same-origin weather tile reads
        (entry) => /^GET \/maps\/xweather\/(?:history|forecast)\//u.test(entry),
      ).length,
      tileRequestsBeforeReload + 1,
    );
    assert.match(await weatherTiles.first().getAttribute("href") ?? "", /^blob:/u);
    const mapScrubber = page.locator("[data-forecast-map-scrubber]");
    await mapScrubber.scrollIntoViewIfNeeded();
    const mapBounds = await mapScrubber.boundingBox();

    // require one measurable map scrub surface
    if (mapBounds === null) {
      throw new Error("forecast map scrub surface is unavailable");
    }

    const mapTileBefore = await weatherTiles.first().getAttribute("data-map-tile-url");
    const mapClockBefore = await page.locator("[data-forecast-crosshair-time]").getAttribute("datetime");
    const mapTouchY = mapBounds.y + mapBounds.height * 0.72;
    await session.send("Input.dispatchTouchEvent", {
      touchPoints: [{ x: mapBounds.x + mapBounds.width * 0.25, y: mapTouchY }],
      type: "touchStart",
    });
    await session.send("Input.dispatchTouchEvent", {
      touchPoints: [{ x: mapBounds.x + mapBounds.width * 0.75, y: mapTouchY }],
      type: "touchMove",
    });
    const mapTileDuringSwipe = await weatherTiles.first().getAttribute("data-map-tile-url");
    const mapClockDuringSwipe = await page.locator("[data-forecast-crosshair-time]").getAttribute("datetime");
    const mapSelectedDuringSwipe = Number(await weatherMap.getAttribute("data-forecast-map-selected"));
    await session.send("Input.dispatchTouchEvent", { touchPoints: [], type: "touchEnd" });
    await page.waitForFunction(
      // wait for one uncached distant frame after the gesture settles
      (prior) => document.querySelector("[data-forecast-map-tile]")?.getAttribute("data-map-tile-url") !== prior,
      mapTileBefore,
    );
    assert.equal(mapTileDuringSwipe, mapTileBefore);
    assert.notEqual(mapClockDuringSwipe, mapClockBefore);
    assert.equal(Math.abs(mapSelectedDuringSwipe - Date.parse(mapClockDuringSwipe ?? "")) < 10 * 60 * 1_000, true);
    assert.equal(await grid.getAttribute("data-forecast-days"), "1");
    assert.equal(await page.locator(".forecast-chart-days").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Today" }).getAttribute("aria-pressed"), "true");
    assert.match(await page.locator("[data-forecast-crosshair-time]").textContent() ?? "", /\d{1,2}:\d{2}\s[AP]M/u);
    assert.equal(await page.locator(".forecast-chart-heading-top").count(), 8);
    assert.equal(await page.locator(".forecast-chart-heading-bottom").count(), 0);
    assert.equal(await page.locator('.forecast-x-tick[data-forecast-light="day"]').count(), 15);
    assert.equal(await page.locator('.forecast-x-tick[data-forecast-light="night"]').count(), 9);
    assert.equal(await page.locator(".forecast-chart-daylight").count(), 8);
    assert.equal(await page.locator('.forecast-chart-daylight [data-forecast-light="day"]').count(), 120);
    assert.equal(await page.locator('.forecast-chart-daylight [data-forecast-light="night"]').count(), 72);
    assert.deepEqual(
      await page.locator(".forecast-x-axis time").allTextContents(),
      ["12 AM", "6 AM", "12 PM", "6 PM", "11 PM"],
    );
    assert.deepEqual(
      await page.locator(".forecast-chart-shell").evaluate(
        // share one visible daylight scale across charts and axis
        (shell) => {
          const dayTick = shell.querySelector('[data-forecast-light="day"]');
          const nightTick = shell.querySelector('[data-forecast-light="night"]');
          const plotDay = shell.querySelector('.forecast-chart-daylight [data-forecast-light="day"]');
          const plotNight = shell.querySelector('.forecast-chart-daylight [data-forecast-light="night"]');
          return {
            dayBackground: dayTick === null ? "none" : getComputedStyle(dayTick).backgroundColor,
            nightBackground: nightTick === null ? "none" : getComputedStyle(nightTick).backgroundColor,
            plotDayBackground: plotDay === null ? "none" : getComputedStyle(plotDay).backgroundColor,
            plotNightBackground: plotNight === null ? "none" : getComputedStyle(plotNight).backgroundColor,
          };
        },
      ),
      {
        dayBackground: "rgba(240, 218, 89, 0.2)",
        nightBackground: "rgba(84, 68, 96, 0.14)",
        plotDayBackground: "rgba(240, 218, 89, 0.2)",
        plotNightBackground: "rgba(84, 68, 96, 0.14)",
      },
    );
    assert.deepEqual(
      await page.locator(".forecast-chart").evaluateAll(
        // preserve one chart per current-condition stat
        (charts) => charts.map((chart) => chart.getAttribute("data-forecast-chart")),
      ),
      ["temperature", "wind", "rain-rate", "humidity", "air-quality", "uv-index", "pressure", "tide"],
    );
    assert.equal(
      await page.locator(".forecast-chart").evaluateAll(
        // place every title at the plot's top-left edge
        (charts) => charts.every((chart) => {
          const heading = chart.querySelector(".forecast-chart-heading");
          const plot = chart.querySelector(".forecast-chart-plot");
          const headingBounds = heading?.getBoundingClientRect();
          const plotBounds = plot?.getBoundingClientRect();
          const atTop = heading?.classList.contains("forecast-chart-heading-top") === true;
          return headingBounds !== undefined && plotBounds !== undefined && atTop &&
            Math.abs(headingBounds.left - plotBounds.left) < 1 &&
            Math.abs(headingBounds.top - plotBounds.top) < 1 &&
            headingBounds.bottom <= plotBounds.bottom &&
            getComputedStyle(heading).position === "absolute";
        }),
      ),
      true,
    );
    assert.equal(
      await page.locator(".forecast-chart").evaluateAll(
        // reserve a line-free gutter beneath every title
        (charts) => charts.every((chart) => {
          const ordinates = [...chart.querySelectorAll("polyline")].flatMap(
            // read every rendered SVG ordinate
            (line) => (line.getAttribute("points") ?? "").split(" ").flatMap((point) => {
              const ordinate = Number(point.split(",")[1]);
              return Number.isFinite(ordinate) ? [ordinate] : [];
            }),
          );
          return ordinates.every((ordinate) => ordinate >= 52);
        }),
      ),
      true,
    );
    await assertForecastTitleClearance(page);
    await grid.press("End");
    await page.waitForFunction(
      // follow the shared selector into forecast tiles
      () => [...document.querySelectorAll("[data-forecast-map-tile]")].every(
        (tile) => tile.getAttribute("data-map-tile-url")?.includes("/maps/xweather/forecast/radar/") === true,
      ),
    );
    assert.equal(await weatherMap.getAttribute("data-forecast-map-phase"), "forecast");
    assert.equal(await weatherLegend.getAttribute("data-forecast-map-legend-phase"), "forecast");
    assert.equal(await mapSelectionPhase.getAttribute("data-forecast-map-selection-phase"), "forecast");
    assert.equal((await mapSelectionPhase.textContent() ?? "").trim(), "Forecast");
    assert.equal(
      await mapSelectionPhase.evaluate(
        // keep the end-position phase chip inside the map
        (phase) => {
          const phaseBounds = phase.querySelector("span")?.getBoundingClientRect();
          const mapBounds = phase.closest(".forecast-map-canvas")?.getBoundingClientRect();
          return phaseBounds !== undefined && mapBounds !== undefined &&
            phaseBounds.left >= mapBounds.left && phaseBounds.right <= mapBounds.right;
        },
      ),
      true,
    );
    await page.getByRole("button", { name: "Clouds" }).click();
    await page.waitForFunction(
      // wait for the selected cloud layer
      () => [...document.querySelectorAll("[data-forecast-map-tile]")].every(
        (tile) => tile.getAttribute("data-map-tile-url")?.includes("/maps/xweather/forecast/clouds/") === true,
      ),
    );
    assert.equal(await page.getByRole("button", { name: "Clouds" }).getAttribute("aria-pressed"), "true");
    assert.equal(await weatherMap.getAttribute("data-forecast-map-layer"), "clouds");
    assert.equal(await weatherLegend.getAttribute("data-forecast-map-legend-layer"), "clouds");
    assert.match(await weatherLegend.textContent() ?? "", /Forecast clouds[\s\S]*Clear[\s\S]*Dense/u);
    const cloudLegendGradient = await weatherLegend.locator(".forecast-map-legend-bar").evaluate(
      // retain the active cloud gradient
      (bar) => getComputedStyle(bar).backgroundImage,
    );
    assert.notEqual(cloudLegendGradient, radarLegendGradient);

    await page.getByRole("button", { name: "Rain" }).click();
    await page.waitForFunction(
      // wait for the selected precipitation layer
      () => [...document.querySelectorAll("[data-forecast-map-tile]")].every(
        (tile) => tile.getAttribute("data-map-tile-url")?.includes("/maps/xweather/forecast/precipitation/") === true,
      ),
    );
    assert.equal(await weatherLegend.getAttribute("data-forecast-map-legend-layer"), "precipitation");
    assert.match(await weatherLegend.textContent() ?? "", /Forecast 1-hour rain[\s\S]*in[\s\S]*0[\s\S]*2[\s\S]*6[\s\S]*10\+/u);
    const rainLegendGradient = await weatherLegend.locator(".forecast-map-legend-bar").evaluate(
      // retain the active rain gradient
      (bar) => getComputedStyle(bar).backgroundImage,
    );
    assert.notEqual(rainLegendGradient, cloudLegendGradient);

    await page.getByRole("button", { name: "Wind" }).click();
    await page.waitForFunction(
      // wait for the selected wind layer
      () => [...document.querySelectorAll("[data-forecast-map-tile]")].every(
        (tile) => tile.getAttribute("data-map-tile-url")?.includes("/maps/xweather/forecast/wind/") === true,
      ),
    );
    assert.equal(await weatherLegend.getAttribute("data-forecast-map-legend-layer"), "wind");
    assert.match(await weatherLegend.textContent() ?? "", /Wind speed[\s\S]*mph[\s\S]*0[\s\S]*20[\s\S]*50[\s\S]*100/u);
    const windLegendGradient = await weatherLegend.locator(".forecast-map-legend-bar").evaluate(
      // retain the active wind gradient
      (bar) => getComputedStyle(bar).backgroundImage,
    );
    assert.notEqual(windLegendGradient, rainLegendGradient);
    assert.equal(await page.locator("[data-forecast-map-refresh]").count(), 0);
    await page.getByRole("button", { name: "5 days" }).click();
    await page.waitForFunction(
      // wait for the five-day forecast render
      () => document.querySelectorAll(".forecast-x-tick").length === 120,
    );
    assert.equal(await page.getByRole("button", { name: "5 days" }).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("[data-forecast-weather-map]").count(), 0);
    assert.equal(JSON.parse(await grid.getAttribute("data-forecast-times") ?? "[]").length, 121);
    assert.deepEqual(
      await page.locator(".forecast-chart-line").evaluateAll(
        // match every forecast range
        (chartLines) => [...new Set(chartLines.map((chartLine) => getComputedStyle(chartLine).strokeWidth))].sort(),
      ),
      ["1.5px", "2px"],
    );
    assert.match(await page.locator("[data-forecast-crosshair-time]").textContent() ?? "", /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),[\s\S]*\d{1,2}:\d{2}\s[AP]M/u);
    assert.equal(await page.locator(".forecast-chart-days").count(), 8);
    assert.equal(await page.locator(".forecast-chart-day-start").count(), 40);
    assert.deepEqual(
      await page.locator(".forecast-chart-days").first().locator("b").allTextContents(),
      ["Fri 21", "Sat 22", "Sun 23", "Mon 24", "Tue 25"],
    );
    assert.equal(
      await page.locator(".forecast-chart-day-start").evaluateAll(
        // require each midnight divider to span its complete chart
        (markers) => markers.every((marker) => {
          const markerBounds = marker.getBoundingClientRect();
          const plotBounds = marker.closest(".forecast-chart-plot")?.getBoundingClientRect();
          return plotBounds !== undefined && Math.abs(markerBounds.top - plotBounds.top) < 1 &&
            Math.abs(markerBounds.bottom - plotBounds.bottom) < 1 &&
            getComputedStyle(marker).borderLeftStyle === "solid";
        }),
      ),
      true,
    );
    assert.equal(
      await page.locator(".forecast-chart-day-start b").first().evaluate(
        // require the reviewed light-gray day panel
        (panel) => getComputedStyle(panel).backgroundColor,
      ),
      "rgb(228, 228, 228)",
    );
    await assertForecastTitleClearance(page);
    await page.getByRole("button", { name: "10 days" }).click();
    await page.waitForFunction(
      // wait for the ten-day forecast render
      () => document.querySelectorAll(".forecast-x-tick").length === 240,
    );
    assert.equal(await page.getByRole("button", { name: "10 days" }).getAttribute("aria-pressed"), "true");
    assert.equal(JSON.parse(await grid.getAttribute("data-forecast-times") ?? "[]").length, 241);
    assert.deepEqual(
      await page.locator(".forecast-chart-line").evaluateAll(
        // match every forecast range
        (chartLines) => [...new Set(chartLines.map((chartLine) => getComputedStyle(chartLine).strokeWidth))].sort(),
      ),
      ["1.5px", "2px"],
    );
    assert.match(await page.locator("[data-forecast-crosshair-time]").textContent() ?? "", /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat),[\s\S]*\d{1,2}:\d{2}\s[AP]M/u);
    assert.equal(await page.locator(".forecast-chart-day-start").count(), 80);
    await assertForecastTitleClearance(page);
    assert.equal(
      fixture.state.requests.some(
        // require the five-day API contract
        (entry) => entry.includes("/forecast?days=5"),
      ),
      true,
    );
    assert.equal(
      fixture.state.requests.some(
        // require the ten-day API contract
        (entry) => entry.includes("/forecast?days=10"),
      ),
      true,
    );
    await page.getByRole("button", { name: "Today" }).click();
    await page.waitForFunction(
      // restore the one-day interaction fixture
      () => document.querySelectorAll(".forecast-x-tick").length === 24,
    );
    assert.deepEqual(
      await page.locator(".forecast-chart").evaluateAll(
        // retain the requested stable raw-unit chart domains
        (charts) => Object.fromEntries(charts.flatMap((chart) => {
          const key = chart.getAttribute("data-forecast-chart");

          // inspect only explicitly stabilized chart domains
          if (key === "humidity" || key === null) {
            return [];
          }

          return [[key, [Number(chart.getAttribute("data-forecast-min")), Number(chart.getAttribute("data-forecast-max"))]]];
        })),
      ),
      {
        "air-quality": [0, 14.4882614724],
        pressure: [1006.7957915632, 1020.9043383205],
        "rain-rate": [0, 25.4],
        temperature: [-1.1111111111, 26.6666666667],
        tide: [-0.3048, 3.6576],
        "uv-index": [0, 4],
        wind: [0, 22.3519999995],
      },
    );
    assert.equal(
      await page.locator(".forecast-chart-line").evaluateAll(
        // render every forecast line from its SVG condition-color gradient
        (lines) => lines.every((line) => line.getAttribute("stroke")?.startsWith("url(#forecast-line-") === true),
      ),
      true,
    );
    assert.deepEqual(
      await page.locator(".forecast-chart-shell").evaluate(
        // keep both lines spanning charts, map, and axis
        (chartShell) => {
          const sharedLineElement = chartShell.querySelector(".forecast-shared-crosshair");
          const currentLineElement = chartShell.querySelector(".forecast-current-time-line");
          const sharedLine = sharedLineElement?.getBoundingClientRect();
          const currentLine = currentLineElement?.getBoundingClientRect();
          const charts = [...chartShell.querySelectorAll(".forecast-chart")];
          const first = charts[0]?.getBoundingClientRect();
          const last = charts.at(-1)?.getBoundingClientRect();
          const map = chartShell.querySelector(".forecast-map-canvas")?.getBoundingClientRect();
          const axis = chartShell.querySelector(".forecast-x-axis")?.getBoundingClientRect();
          return {
            currentReachesAxis: currentLine !== undefined && axis !== undefined && currentLine.bottom >= axis.bottom,
            currentReachesBottom: currentLine !== undefined && last !== undefined && currentLine.bottom >= last.bottom,
            currentReachesMap: currentLine !== undefined && map !== undefined && currentLine.bottom >= map.bottom,
            currentReachesTop: currentLine !== undefined && first !== undefined && currentLine.top <= first.top,
            currentUnderScrubber: currentLineElement !== null && sharedLineElement !== null &&
              (currentLineElement.compareDocumentPosition(sharedLineElement) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
            reachesAxis: sharedLine !== undefined && axis !== undefined && sharedLine.bottom >= axis.bottom,
            reachesBottom: sharedLine !== undefined && last !== undefined && sharedLine.bottom >= last.bottom,
            reachesMap: sharedLine !== undefined && map !== undefined && sharedLine.bottom >= map.bottom,
            reachesTop: sharedLine !== undefined && first !== undefined && sharedLine.top <= first.top,
          };
        },
      ),
      {
        currentReachesAxis: true,
        currentReachesBottom: true,
        currentReachesMap: true,
        currentReachesTop: true,
        currentUnderScrubber: true,
        reachesAxis: true,
        reachesBottom: true,
        reachesMap: true,
        reachesTop: true,
      },
    );
    await grid.focus();
    assert.equal(
      await grid.evaluate(
        // remove the chart-specific focus effect
        (chartGrid) => getComputedStyle(chartGrid).outlineStyle,
      ),
      "none",
    );
    assert.equal(
      await page.locator(".forecast-chart").evaluateAll(
        // place every value bubble at one reviewed plot edge
        (charts) => charts.every(
          // verify one forecast bubble
          (chart) => {
            const plot = chart.querySelector(".forecast-chart-plot")?.getBoundingClientRect();
            const value = chart.querySelector(".forecast-chart-value");
            const bounds = value?.getBoundingClientRect();
            const lineZ = Number(getComputedStyle(document.querySelector(".forecast-shared-crosshair")).zIndex);
            const valueZ = value === null ? 0 : Number(getComputedStyle(value).zIndex);
            const atTop = value?.classList.contains("forecast-chart-value-top") === true;
            const atBottom = value?.classList.contains("forecast-chart-value-bottom") === true;
            return plot !== undefined && bounds !== undefined &&
              ((atTop && bounds.top - plot.top >= 0 && bounds.top - plot.top < 8) ||
                (atBottom && plot.bottom - bounds.bottom >= 0 && plot.bottom - bounds.bottom < 8)) &&
              atTop !== atBottom && valueZ > lineZ;
          },
        ),
      ),
      true,
    );
    assert.equal(await page.locator(".forecast-chart-value-top").count() > 0, true);
    assert.equal(await page.locator(".forecast-chart-value-bottom").count() > 0, true);

    await grid.scrollIntoViewIfNeeded();
    const bounds = await grid.boundingBox();

    // require a measurable touch surface
    if (bounds === null) {
      throw new Error("forecast touch surface is unavailable");
    }

    const touchY = bounds.y + Math.min(100, bounds.height / 4);
    const horizontalTarget = bounds.x + bounds.width * 0.75;
    const currentLineBefore = await currentLine.boundingBox();
    await swipe(bounds.x + 16, touchY, horizontalTarget, touchY);
    const horizontalLine = await line.boundingBox();
    const currentLineAfter = await currentLine.boundingBox();

    // require the direct line position
    if (horizontalLine === null || currentLineBefore === null || currentLineAfter === null) {
      throw new Error("forecast crosshair is unavailable");
    }

    assert.equal(Math.abs(horizontalLine.x - horizontalTarget) < 3, true);
    assert.equal(Math.abs(currentLineAfter.x - currentLineBefore.x) < 1, true);
    assert.equal(Number(await grid.getAttribute("aria-valuenow")) >= 17, true);

    const centerX = bounds.x + bounds.width / 2;
    const quarterHourTarget = centerX + bounds.width / (24 * 4);
    await swipe(quarterHourTarget, touchY, quarterHourTarget, touchY);
    const quarterHourClock = await page.locator("[data-forecast-crosshair-time]").textContent() ?? "";
    assert.match(quarterHourClock, /12:1[45] PM/u);
    await swipe(centerX, touchY, centerX, touchY);
    const centerClock = await page.locator("[data-forecast-crosshair-time]").textContent() ?? "";
    assert.match(centerClock, /(?:11:59 AM|12:00 PM)/u);
    assert.notEqual(centerClock, quarterHourClock);
    const centerLine = await line.boundingBox();
    const centerAirQuality = await page.locator('[data-forecast-chart="air-quality"] [data-forecast-value]').textContent();
    assert.equal(
      await page.locator('[data-forecast-chart="uv-index"] .forecast-chart-value').getAttribute("class"),
      "forecast-chart-value forecast-chart-value-bottom",
    );
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await swipe(centerX, touchY, centerX, touchY - 96);
    const scrolledLine = await line.boundingBox();
    const scrolledAirQuality = await page.locator('[data-forecast-chart="air-quality"] [data-forecast-value]').textContent();
    const scrollAfter = await page.evaluate(() => window.scrollY);

    // require normal vertical page scrolling
    if (centerLine === null || scrolledLine === null) {
      throw new Error("forecast scrolling crosshair is unavailable");
    }

    assert.equal(Math.abs(scrolledLine.x - centerLine.x) < 1, true);
    assert.equal(scrolledAirQuality, centerAirQuality);
    assert.equal(scrollAfter > scrollBefore, true);
    assert.equal(await page.locator(".forecast-chart-value").count(), 8);
    await swipe(bounds.x + 8, touchY, bounds.x + 8, touchY);
    assert.deepEqual(
      await page.locator('[data-forecast-chart="uv-index"]').evaluate(
        // keep one left-edge pill opposite its line without title avoidance
        (chart) => ({
          headingTop: chart.querySelector(".forecast-chart-heading")?.classList.contains("forecast-chart-heading-top"),
          valueTop: chart.querySelector(".forecast-chart-value")?.classList.contains("forecast-chart-value-top"),
          valueBottom: chart.querySelector(".forecast-chart-value")?.classList.contains("forecast-chart-value-bottom"),
        }),
      ),
      { headingTop: true, valueBottom: false, valueTop: true },
    );
    assert.deepEqual(
      await page.locator(".forecast-chart-shell").evaluate(
        // square the pill corners that meet the left edge of the selector line
        (chartShell) => {
          const timeStyle = getComputedStyle(chartShell.querySelector(".forecast-shared-crosshair"));
          const clockStyle = getComputedStyle(chartShell.querySelector(".forecast-crosshair-label time"));
          const valueStyle = getComputedStyle(chartShell.querySelector(".forecast-chart-value"));
          return {
            clockLeft: [clockStyle.borderTopLeftRadius, clockStyle.borderBottomLeftRadius],
            lineColor: timeStyle.backgroundColor,
            valueLeft: [valueStyle.borderTopLeftRadius, valueStyle.borderBottomLeftRadius],
          };
        },
      ),
      {
        clockLeft: ["0px", "0px"],
        lineColor: "rgb(0, 0, 0)",
        valueLeft: ["0px", "0px"],
      },
    );
    assert.deepEqual(
      await page.locator(".forecast-x-axis").evaluate(
        // keep the shortened stack's axis sticky and clear of mobile navigation
        (axis) => {
          const navigation = document.querySelector(".section-nav")?.getBoundingClientRect();
          const bounds = axis.getBoundingClientRect();
          return {
            nonOverlapping: navigation !== undefined && bounds.bottom <= navigation.top + 1,
            position: getComputedStyle(axis).position,
            visible: bounds.bottom > 0 && bounds.top < window.innerHeight,
          };
        },
      ),
      { nonOverlapping: true, position: "sticky", visible: true },
    );
    await page.evaluate(() => {
      const chartGrid = document.querySelector(".forecast-chart-grid");

      // move well inside the chart stack
      if (chartGrid !== null) {
        window.scrollTo(0, chartGrid.getBoundingClientRect().top + window.scrollY + 360);
      }
    });
    await page.waitForTimeout(50);
    assert.deepEqual(
      await page.locator(".forecast-chart-shell").evaluate(
        // retain the line labels at the viewport top while the chart stack scrolls
        (chartShell) => {
          const now = chartShell.querySelector(".forecast-current-time-label span")?.getBoundingClientRect();
          const clock = chartShell.querySelector(".forecast-crosshair-label time")?.getBoundingClientRect();
          return {
            clockAtTop: clock !== undefined && clock.top >= 0 && clock.top < 8,
            labelsAligned: now !== undefined && clock !== undefined && Math.abs(now.top - clock.top) < 1,
            nowAtTop: now !== undefined && now.top >= 0 && now.top < 8,
          };
        },
      ),
      { clockAtTop: true, labelsAligned: true, nowAtTop: true },
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      0,
    );
    await page.setViewportSize({ height: 844, width: 320 });
    assert.deepEqual(
      await page.locator(".forecast-chart-shell").evaluate(
        // keep the shared time axis inside the narrow chart shell
        (shell) => {
          const axis = shell.querySelector(".forecast-x-axis")?.getBoundingClientRect();
          const finalTick = shell.querySelector(".forecast-x-axis time:last-child")?.getBoundingClientRect();
          return {
            finalTickContained: axis !== undefined && finalTick !== undefined && finalTick.right <= axis.right,
            overflow: shell.scrollWidth - shell.clientWidth,
          };
        },
      ),
      { finalTickContained: true, overflow: 0 },
    );
    assert.equal(
      await page.locator(".forecast-x-axis time").evaluateAll(
        // keep each compact hour label readable on the narrowest viewport
        (labels) => labels.every((label, index) => {
          const next = labels[index + 1];
          return next === undefined || label.getBoundingClientRect().right <= next.getBoundingClientRect().left;
        }),
      ),
      true,
    );
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

// verify labeled forecast placeholders
test("forecast skeletons expose every chart label on the reserved cards", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, { viewport: { height: 844, width: 390 } });
    let releaseForecastReads;
    const forecastReadsReleased = new Promise(
      // expose one deterministic forecast gate
      (resolveRelease) => {
        releaseForecastReads = resolveRelease;
      },
    );
    await page.route(
      /\/api\/v1\/sites\/ballydidean\/(?:current|forecast|tides)/u,
      // hold the initial forecast behind its reserved layout
      async (route) => {
        await forecastReadsReleased;
        await route.continue();
      },
    );
    await page.goto(`${fixture.origin}/forecast`, { waitUntil: "domcontentloaded" });
    await page.locator(".forecast-panel.skeleton-region").waitFor();
    assert.deepEqual(
      await page.locator(".skeleton-forecast-chart h3").allTextContents(),
      ["device_thermostatTemperature", "airWind", "rainyRain rate", "humidity_percentageHumidity", "masksAir quality", "wb_sunnyUV index", "speedPressure", "waterTide"],
    );
    assert.equal(
      await page.locator(".skeleton-forecast-chart").evaluateAll(
        // keep each label visible over one gray reserved card
        (cards) => cards.every((card) => {
          const label = card.querySelector("h3");
          const background = getComputedStyle(card).backgroundColor;
          const color = label === null ? "transparent" : getComputedStyle(label).color;
          return background !== "rgba(0, 0, 0, 0)" && background !== "rgb(255, 255, 255)" && color !== "transparent";
        }),
      ),
      true,
    );
    assert.equal(
      await page.locator(".skeleton-forecast-chart").evaluateAll(
        // animate every reserved forecast chart beneath its stable label
        (charts) => charts.every((chart) => {
          const shimmer = getComputedStyle(chart, "::after");
          return shimmer.animationName === "skeleton-shimmer" &&
            shimmer.backgroundImage.includes("linear-gradient");
        }),
      ),
      true,
    );
    assert.equal(await page.locator(".skeleton-forecast-map").count(), 1);
    assert.equal(
      await page.locator(".skeleton-forecast-map").evaluate(
        // animate the reserved weather map surface
        (map) => getComputedStyle(map, "::after").animationName,
      ),
      "skeleton-shimmer",
    );
    releaseForecastReads();
    await page.locator(".forecast-panel:not(.skeleton-region)").waitFor();
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("trend skeleton shimmers without a show-all control", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, { viewport: { height: 844, width: 960 } });
    let releaseTrendRead;
    const trendReadReleased = new Promise(
      // expose one deterministic trend gate
      (resolveRelease) => {
        releaseTrendRead = resolveRelease;
      },
    );
    await page.route(
      /\/api\/v1\/sites\/ballydidean\/trends/u,
      // hold the initial trend behind its reserved chart
      async (route) => {
        await trendReadReleased;
        await route.continue();
      },
    );
    await page.goto(`${fixture.origin}/trends`, { waitUntil: "domcontentloaded" });
    await page.locator(".skeleton-trend-chart").waitFor();
    assert.equal(await page.locator(".skeleton-trend-chart [data-trend-mode-toggle]").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Show all" }).count(), 0);
    assert.equal(
      await page.locator(".skeleton-trend-chart").evaluate(
        // animate the complete reserved trend surface
        (chart) => getComputedStyle(chart, "::after").animationName,
      ),
      "skeleton-shimmer",
    );
    releaseTrendRead();
    await page.locator(".trends-panel:not(.skeleton-region)").waitFor();
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("initial skeletons preserve homepage geometry while weather data loads", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();

    // verify both compact and wide responsive layouts
    for (const width of [390, 960]) {
      const page = await createFixturePage(browser, { viewport: { height: 900, width } });
      let releaseWeatherReads;
      const weatherReadsReleased = new Promise(
        // expose one deterministic response gate
        (resolveRelease) => {
          releaseWeatherReads = resolveRelease;
        },
      );
      await page.route(
        /\/api\/v1\/sites\/ballydidean\/(?:current|forecast|trends)/u,
        // hold first-load weather data behind the skeletons
        async (route) => {
          await weatherReadsReleased;
          await route.continue();
        },
      );
      await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
      await page.locator(".current-conditions.skeleton-region").waitFor();
      assert.equal(await page.locator(".skeleton-card").count(), 8);
      assert.equal(
        await page.locator(".skeleton-card").evaluateAll(
          // animate every reserved condition card
          (cards) => cards.every(
            (card) => getComputedStyle(card, "::after").animationName === "skeleton-shimmer",
          ),
        ),
        true,
      );
      assert.equal(await page.locator(".skeleton-forecast-chart").count(), 0);
      assert.equal(await page.locator(".skeleton-trend-chart").count(), 0);
      assert.equal(await page.getByText("No current model value is available yet.").count(), 0);
      const selectors = [
        ".masthead",
        ".current-conditions",
        ".credits",
      ];
      const loadingGeometry = await captureSectionGeometry(page, selectors);
      const loadingCardHeights = await page.locator(".condition-card").evaluateAll(
        // capture every responsive card track
        (cards) => cards.map((card) => card.getBoundingClientRect().height),
      );
      releaseWeatherReads();
      await page.locator(".current-conditions:not(.skeleton-region)").waitFor();
      await page.waitForFunction(
        // require every first-load skeleton to clear
        () => document.querySelector(".skeleton-region") === null,
      );
      const loadedGeometry = await captureSectionGeometry(page, selectors);
      const loadedCardHeights = await page.locator(".condition-card").evaluateAll(
        // recapture every responsive card track
        (cards) => cards.map((card) => card.getBoundingClientRect().height),
      );

      assert.deepEqual(loadedCardHeights, loadingCardHeights);
      assert.deepEqual(loadedGeometry, loadingGeometry);
      assert.equal(await page.locator(".skeleton-line").count(), 0);
      assert.equal(await page.locator("body").evaluate(
        // reject responsive horizontal overflow
        (body) => body.scrollWidth > document.documentElement.clientWidth,
      ), false);
      await page.close();
    }
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("initial history skeletons preserve a full logs page while records load", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const historyRecords = Array.from({ length: 25 },
      // create one representative full history page
      (_, index) => makeRecord(
        String(400 + index),
        new Date(Date.UTC(2026, 7, 22, 4, 50 - index)).toISOString(),
        16.2 - index * 0.1,
      ),
    );

    // verify both compact and wide history layouts
    for (const width of [390, 960]) {
      const page = await createFixturePage(browser, { viewport: { height: 900, width } });
      let releaseHistoryRead;
      const historyReadReleased = new Promise(
        // expose one deterministic history gate
        (resolveRelease) => {
          releaseHistoryRead = resolveRelease;
        },
      );
      await page.route(
        /\/api\/v1\/sites\/ballydidean\/history/u,
        // hold first-load history behind the skeleton rows
        async (route) => {
          await historyReadReleased;
          await route.fulfill({
            contentType: "application/json",
            json: {
              data: historyRecords,
              page: { limit: 25, nextCursor: "older-page" },
              site,
            },
            status: 200,
          });
        },
      );
      await page.goto(`${fixture.origin}/logs`, { waitUntil: "domcontentloaded" });
      await page.locator(".skeleton-history-row").first().waitFor({ state: "attached" });
      assert.equal(await page.locator(".skeleton-history-row").count(), 25);
      assert.equal(await page.locator(".skeleton-history-card").count(), 25);
      assert.equal(
        await page.locator(".skeleton-history-row td, .skeleton-history-card").evaluateAll(
          // animate every reserved desktop and mobile history surface
          (skeletons) => skeletons.every(
            (skeleton) => getComputedStyle(skeleton, "::after").animationName === "skeleton-shimmer",
          ),
        ),
        true,
      );
      assert.equal(await page.getByText("No records match these filters.").count(), 0);
      const selectors = [".masthead", ".section-nav", ".weather-content > .panel", ".pagination", ".credits"];
      const loadingGeometry = await captureSectionGeometry(page, selectors);
      releaseHistoryRead();
      await page.locator(".skeleton-history-row").first().waitFor({ state: "detached" });
      await page.locator("tbody tr:not(.skeleton-history-row)").first().waitFor({ state: "attached" });
      const loadedGeometry = await captureSectionGeometry(page, selectors);

      // expose compact source provenance as a disclosure
      if (width === 390) {
        assert.deepEqual(
          await page.locator(".history-card details summary").first().evaluate((summary) => ({
            cursor: getComputedStyle(summary).cursor,
            indicator: getComputedStyle(summary, "::after").content,
          })),
          { cursor: "pointer", indicator: '"›"' },
        );
      }

      assert.deepEqual(loadedGeometry, loadingGeometry);
      assert.equal(await page.locator(".skeleton-line").count(), 0);
      await page.close();
    }
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("real browser rejects Los Angeles DST gaps and overlaps from UTC without losing last-good data", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;
  const pageErrors = [];

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, {
      timezoneId: "UTC",
      viewport: { height: 900, width: 1440 },
    });
    // capture unexpected handler errors
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    await page.goto(`${fixture.origin}/logs`, { waitUntil: "networkidle" });
    assert.equal(
      await page.evaluate(
        // read the actual browser timezone
        () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      ),
      "UTC",
    );

    await assertRejectedSiteWallClock(
      page,
      fixture,
      "from",
      "2026-03-08T02:30",
    );
    await assertRejectedSiteWallClock(
      page,
      fixture,
      "to",
      "2026-11-01T01:30",
    );
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("real browser configures and persists every measurement unit preference", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, { viewport: { height: 900, width: 960 } });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    const currentTemperature = page.locator("[data-condition='temperature']");
    assert.match(await currentTemperature.textContent() ?? "", /61\s*°F/u);
    assert.match(await currentTemperature.textContent() ?? "", /Feels like\s*60\s*°F/u);
    const currentWind = page.locator("[data-condition='wind']");
    assert.match(await currentWind.textContent() ?? "", /Wind\s*Breezy\s*9\s*mph SW/u);
    assert.match(await currentWind.textContent() ?? "", /Gusts\s*16\s*mph/u);
    assert.equal(
      await page.locator(".condition-primary strong").evaluateAll(
        // use one primary reading scale across every card
        (readings) => new Set(readings.map(
          // read one primary scale
          (reading) => getComputedStyle(reading).fontSize,
        )).size,
      ),
      1,
    );
    const secondarySectionGeometry = await page
      .locator("[data-condition='temperature'], [data-condition='wind'], [data-condition='rain'], [data-condition='tide']")
      .evaluateAll(
        // reserve two forecast rows inside every secondary section
        (cards) => cards.map(
          // measure one paired section
          (card) => {
            const secondary = card.querySelector(".condition-secondary");
            const forecast = card.querySelector(".condition-forecast-readings");
            const row = forecast?.querySelector(".condition-forecast-reading");
            const value = row?.querySelector("strong");

            // require the complete paired layout
            if (secondary === null || forecast === null || row === null || value === null || value === undefined) {
              return null;
            }

            const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
            const rowGap = Number.parseFloat(getComputedStyle(forecast).rowGap);
            const rowHeight = value.getBoundingClientRect().height;
            return {
              height: secondary.getBoundingClientRect().height,
              requiredHeight: rowHeight * 2 + rowGap + rootFontSize,
            };
          },
        ),
      );
    assert.equal(secondarySectionGeometry.includes(null), false);
    assert.equal(
      new Set(secondarySectionGeometry.map(
        // compare one rendered section height
        (geometry) => geometry?.height,
      )).size,
      1,
      JSON.stringify(secondarySectionGeometry),
    );
    assert.equal(
      secondarySectionGeometry.every(
        // retain one rem of normal breathing room
        (geometry) => geometry !== null && geometry.height >= geometry.requiredHeight,
      ),
      true,
      JSON.stringify(secondarySectionGeometry),
    );
    const pairedDividerTops = await page.locator("[data-condition='temperature'], [data-condition='wind']").evaluateAll(
      // measure paired secondary dividers
      (cards) => cards.map(
        // capture one divider position
        (card) => card.querySelector(".condition-secondary-divider")?.getBoundingClientRect().top ?? null,
      ),
    );
    assert.equal(pairedDividerTops.includes(null), false);
    assert.ok(
      Math.abs((pairedDividerTops[0] ?? 0) - (pairedDividerTops[1] ?? 0)) <= 1,
      JSON.stringify(pairedDividerTops),
    );
    assert.equal(
      await page.locator("[data-condition='temperature'], [data-condition='wind'], [data-condition='rain'], [data-condition='tide']").evaluateAll(
        // keep each secondary label and reading flush left
        (cards) => cards.every(
          // verify one secondary reading
          (card) => {
            const divider = card.querySelector(".condition-secondary-divider");
            const reading = card.querySelector(".condition-secondary strong");

            // require both secondary elements
            if (divider === null || reading === null) {
              return false;
            }

            const body = card.querySelector(".condition-body");

            // require the full card body boundary
            if (body === null) {
              return false;
            }

            return divider.getBoundingClientRect().bottom <= reading.getBoundingClientRect().top &&
              Math.abs(divider.getBoundingClientRect().left - reading.getBoundingClientRect().left) <= 1 &&
              Math.abs(divider.getBoundingClientRect().right - body.getBoundingClientRect().right) <= 1 &&
              getComputedStyle(divider, "::before").content === "none" &&
              Number.parseFloat(getComputedStyle(divider, "::after").width) > 0;
          },
        ),
      ),
      true,
    );
    assert.equal(
      await currentTemperature.evaluate(
        // keep the apparent-temperature forecast below the full divider
        (card) => {
          const divider = card.querySelector(".condition-secondary-divider");
          const apparentMaximum = card.querySelector(".condition-forecast-reading:nth-child(3) strong");

          // require both temperature rows
          if (divider === null || apparentMaximum === null) {
            return false;
          }

          return apparentMaximum.getBoundingClientRect().top >= divider.getBoundingClientRect().bottom;
        },
      ),
      true,
    );
    assert.match(
      await page.locator("[data-condition='pressure']").textContent() ?? "",
      /\+0\.1\s*%/u,
    );
    const currentTide = page.locator("[data-condition='tide']");
    assert.match(await currentTide.locator(".condition-status").textContent() ?? "", /High/u);
    assert.match(await currentTide.locator(".condition-primary").textContent() ?? "", /8\.2\s*ft/u);
    assert.match(await currentTide.locator(".condition-secondary").textContent() ?? "", /Direction\s*Rising/u);
    assert.equal(await currentTide.locator(".condition-detail").count(), 0);
    const tideForecastAlignment = await currentTide.evaluate(
      // align the next turn with the direction reading
      (card) => {
        const direction = card.querySelector(".condition-secondary strong");
        const forecast = card.querySelector(".condition-forecast-label");

        // require both tide sections
        if (direction === null || forecast === null) {
          return null;
        }

        return {
          directionTop: direction.getBoundingClientRect().top,
          forecastTop: forecast.getBoundingClientRect().top,
        };
      },
    );
    assert.equal(
      tideForecastAlignment !== null &&
        Math.abs(tideForecastAlignment.forecastTop - tideForecastAlignment.directionTop) <= 4,
      true,
      JSON.stringify(tideForecastAlignment),
    );
    assert.doesNotMatch(await currentTide.textContent() ?? "", /Forecast/u);
    assert.match(await currentTide.textContent() ?? "", /Rising/u);
    assert.doesNotMatch(await page.locator(".current-conditions").textContent() ?? "", /Next 24h/u);
    assert.match(await currentTemperature.textContent() ?? "", /Max\s*68°F\s*Min\s*50°F\s*Max\s*67°F\s*Min\s*49°F/u);
    assert.match(await currentWind.textContent() ?? "", /Max\s*8 mph\s*Max\s*16 mph/u);
    const currentRain = page.locator("[data-condition='rain']");
    assert.match(await currentRain.textContent() ?? "", /Rain/u);
    assert.match(await currentRain.textContent() ?? "", /Max 0\.1 in\/h/u);
    assert.match(await currentRain.textContent() ?? "", /Accumulation\s*0\.1\s*in/u);
    assert.match(await currentRain.textContent() ?? "", /Total 0\.19 in/u);
    assert.match(await page.locator("[data-condition='air-quality']").textContent() ?? "", /Max 10/u);
    assert.doesNotMatch(await page.locator("[data-condition='air-quality']").textContent() ?? "", /µg\/m³/u);
    assert.match(await page.locator("[data-condition='uv-index']").textContent() ?? "", /Max 8/u);
    assert.match(await page.locator("[data-condition='pressure']").textContent() ?? "", /Max\s*\+0\.4%\s*Min\s*-0\.2%/u);
    assert.match(await page.locator("[data-condition='humidity']").textContent() ?? "", /Max 74%/u);
    assert.match(await currentTide.textContent() ?? "", /Next low\s*5:00 AM/u);
    assert.deepEqual(
      await page.locator(".condition-forecast-reading").evaluateAll(
        // retain the requested threshold colors at consistent emphasis
        (readings) => readings.map((reading) => ({
          color: getComputedStyle(reading).color,
          condition: reading.closest("[data-condition]")?.getAttribute("data-condition"),
          opacity: getComputedStyle(reading).opacity,
        })),
      ),
      [
        { color: "rgb(67, 151, 86)", condition: "temperature", opacity: "0.75" },
        { color: "rgb(67, 151, 86)", condition: "temperature", opacity: "0.75" },
        { color: "rgb(67, 151, 86)", condition: "temperature", opacity: "0.75" },
        { color: "rgb(56, 120, 197)", condition: "temperature", opacity: "0.75" },
        { color: "rgb(67, 151, 86)", condition: "wind", opacity: "0.75" },
        { color: "rgb(230, 181, 25)", condition: "wind", opacity: "0.75" },
        { color: "rgb(56, 120, 197)", condition: "rain", opacity: "0.75" },
        { color: "rgb(0, 0, 0)", condition: "rain", opacity: "0.75" },
        { color: "rgb(0, 0, 0)", condition: "tide", opacity: "0.75" },
        { color: "rgb(239, 126, 31)", condition: "humidity", opacity: "0.75" },
        { color: "rgb(230, 181, 25)", condition: "air-quality", opacity: "0.75" },
        { color: "rgb(67, 151, 86)", condition: "pressure", opacity: "0.75" },
        { color: "rgb(67, 151, 86)", condition: "pressure", opacity: "0.75" },
        { color: "rgb(207, 67, 55)", condition: "uv-index", opacity: "0.75" },
      ],
    );
    assert.equal(await page.locator(".condition-card").count(), 8);
    assert.deepEqual(
      await page.locator(".condition-card").evaluateAll(
        // retain the requested dashboard sequence
        (cards) => cards.map(
          // read one card identity
          (card) => card.getAttribute("data-condition"),
        ),
      ),
      ["temperature", "wind", "rain", "tide", "humidity", "air-quality", "pressure", "uv-index"],
    );
    assert.equal(
      await page.locator(".condition-forecast-reading").evaluateAll(
        // keep every forecast label beside its value
        (readings) => readings.every((reading) => {
          const label = reading.querySelector(".condition-forecast-label");
          const value = reading.querySelector("strong");

          // require complete forecast geometry
          if (label === null || value === null) {
            return false;
          }

          // scope the requested inline treatment to extrema
          if (!["Max", "Min"].includes(label.textContent ?? "")) {
            return true;
          }

          const labelBounds = label.getBoundingClientRect();
          const valueBounds = value.getBoundingClientRect();
          return labelBounds.right <= valueBounds.left &&
            labelBounds.bottom > valueBounds.top &&
            labelBounds.top < valueBounds.bottom;
        }),
      ),
      true,
    );
    const gustForecastAlignment = await currentWind.evaluate(
      // align the gust forecast at the secondary row start
      (card) => {
        const secondary = card.querySelector(".condition-secondary strong");
        const forecastSecondary = card.querySelector(".condition-forecast-reading:last-child strong");

        // require both gust values
        if (secondary === null || forecastSecondary === null) {
          return null;
        }

        return {
          forecastTop: forecastSecondary.getBoundingClientRect().top,
          secondaryTop: secondary.getBoundingClientRect().top,
        };
      },
    );
    assert.equal(
      gustForecastAlignment !== null &&
        Math.abs(gustForecastAlignment.secondaryTop - gustForecastAlignment.forecastTop) <= 4,
      true,
      JSON.stringify(gustForecastAlignment),
    );
    const rainForecastAlignment = await currentRain.evaluate(
      // align accumulation totals at the secondary row start
      (card) => {
        const secondary = card.querySelector(".condition-secondary strong");
        const forecastSecondary = card.querySelector(".condition-forecast-reading:last-child strong");

        // require both accumulation values
        if (secondary === null || forecastSecondary === null) {
          return null;
        }

        return {
          forecastTop: forecastSecondary.getBoundingClientRect().top,
          secondaryTop: secondary.getBoundingClientRect().top,
        };
      },
    );
    assert.equal(
      rainForecastAlignment !== null &&
        Math.abs(rainForecastAlignment.secondaryTop - rainForecastAlignment.forecastTop) <= 4,
      true,
      JSON.stringify(rainForecastAlignment),
    );
    assert.deepEqual(
      await page.locator(".condition-card").evaluateAll(
        // reject clipped content inside every condition card
        (cards) => cards
          .filter((card) => card.scrollWidth > card.clientWidth)
          .map((card) => card.getAttribute("data-condition")),
      ),
      [],
    );
    assert.equal(await page.locator(".metric").count(), 0);

    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(`${fixture.origin}/settings`);
    const settings = page.getByRole("region", { name: "Measurement units" });
    await settings.waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0);
    assert.equal(await page.locator(".section-nav-settings").getAttribute("aria-current"), "page");
    await settings.locator("select[name='temperature']").selectOption("celsius");
    await settings.locator("select[name='windSpeed']").selectOption("meters_per_second");
    await settings.locator("select[name='precipitation']").selectOption("millimeters");
    await settings.locator("select[name='pressure']").selectOption("hectopascals");
    await settings.locator("select[name='waterLevel']").selectOption("meters");
    await settings.getByRole("button", { name: "Save units" }).click();
    await page.getByRole("link", { name: "Home" }).click();
    await page.waitForURL(`${fixture.origin}/`);

    assert.match(await currentTemperature.textContent() ?? "", /16\s*°C/u);
    assert.match(await currentTemperature.textContent() ?? "", /Feels like\s*16\s*°C/u);
    assert.match(await currentWind.textContent() ?? "", /Wind\s*Breezy\s*4\s*m\/s SW/u);
    assert.match(await currentWind.textContent() ?? "", /Gusts\s*7\s*m\/s/u);
    assert.match(await currentWind.textContent() ?? "", /Peak reading 7 m\/s/u);
    assert.match(
      await page.locator("[data-condition='pressure']").textContent() ?? "",
      /1,014\.2\s*hPa/u,
    );
    assert.match(await currentTide.locator(".condition-status").textContent() ?? "", /High/u);
    assert.match(await currentTide.locator(".condition-primary").textContent() ?? "", /2\.5\s*m/u);
    assert.match(await currentTide.textContent() ?? "", /Rising/u);
    assert.match(await currentTemperature.textContent() ?? "", /Max\s*20°C\s*Min\s*10°C\s*Max\s*19°C\s*Min\s*9°C/u);
    assert.match(await currentWind.textContent() ?? "", /Max\s*4 m\/s\s*Max\s*7 m\/s/u);
    assert.match(await currentRain.textContent() ?? "", /Max 2\.5 mm\/h/u);
    assert.match(await currentRain.textContent() ?? "", /Accumulation\s*2\.5\s*mm/u);
    assert.match(await currentRain.textContent() ?? "", /Total 4\.8 mm/u);
    assert.match(await page.locator("[data-condition='pressure']").textContent() ?? "", /Max\s*1,017\.0 hPa\s*Min\s*1,011\.0 hPa/u);
    assert.deepEqual(
      await page.evaluate(
        // read the persisted browser preference record
        (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
        UNIT_PREFERENCE_STORAGE_KEY,
      ),
      {
        precipitation: "millimeters",
        pressure: "hectopascals",
        temperature: "celsius",
        waterLevel: "meters",
        windSpeed: "meters_per_second",
      },
    );

    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(`${fixture.origin}/settings`);
    await page.getByRole("link", { name: "Logs", exact: true }).click();
    await page.waitForURL(`${fixture.origin}/logs`);
    await page.waitForLoadState("networkidle");
    assert.equal(await page.getByRole("columnheader", { name: "Temperature (°C)" }).isVisible(), true);
    assert.equal(await page.getByText("16.2").first().isVisible(), true);
    await page.reload({ waitUntil: "networkidle" });
    assert.equal(await page.getByRole("columnheader", { name: "Temperature (°C)" }).isVisible(), true);
    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(`${fixture.origin}/settings`);
    assert.equal(await page.locator("select[name='temperature']").inputValue(), "celsius");
    assert.equal(await page.locator("select[name='windSpeed']").inputValue(), "meters_per_second");
    assert.equal(await page.locator("select[name='precipitation']").inputValue(), "millimeters");
    assert.equal(await page.locator("select[name='pressure']").inputValue(), "hectopascals");
    assert.equal(await page.locator("select[name='waterLevel']").inputValue(), "meters");
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("real browser keeps the tablet masthead and compact navigation in separate rows", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, { viewport: { height: 900, width: 960 } });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    assert.equal(
      await page.locator(".condition-primary strong").evaluateAll(
        // retain the shared primary scale on tablets
        (readings) => new Set(readings.map(
          // read one tablet primary scale
          (reading) => getComputedStyle(reading).fontSize,
        )).size,
      ),
      1,
    );
    assert.equal(
      await page.locator("[data-condition='temperature'], [data-condition='wind'], [data-condition='rain'], [data-condition='tide']").evaluateAll(
        // retain one static secondary height on tablets
        (cards) => new Set(cards.map(
          // measure one tablet secondary section
          (card) => {
            const secondary = card.querySelector(".condition-secondary");
            return secondary === null ? null : secondary.getBoundingClientRect().height;
          },
        )).size,
      ),
      1,
    );
    assert.equal(
      await page.locator(".current-conditions").evaluate(
        // keep temperature and wind paired on tablets
        (grid) => {
          const temperature = grid.querySelector("[data-condition='temperature']")?.getBoundingClientRect();
          const wind = grid.querySelector("[data-condition='wind']")?.getBoundingClientRect();
          return temperature !== undefined && wind !== undefined &&
            Math.abs(temperature.top - wind.top) < 1 &&
            Math.abs(temperature.width - wind.width) < 1 &&
            wind.left >= temperature.right;
        },
      ),
      true,
    );
    await page.goto(`${fixture.origin}/logs`, { waitUntil: "networkidle" });
    const headerLayout = await page.locator("main.shell").evaluate(
      // measure the exact tablet header geometry
      (shell) => {
        const masthead = shell.querySelector(".masthead");
        const heading = masthead?.querySelector("h1");
        const navigation = shell.querySelector(".section-nav");
        const forecast = navigation?.querySelector('a[href="/forecast"]');
        const home = navigation?.querySelector(".section-nav-home");
        const map = navigation?.querySelector(".section-nav-map");
        const trends = navigation?.querySelector('a[href="/trends"]');
        const settings = navigation?.querySelector(".section-nav-settings");
        const icon = settings?.querySelector(".material-symbols-rounded");
        const headingRange = document.createRange();

        // require the complete header surface
        if (
          masthead === null ||
          heading === null ||
          navigation === null ||
          forecast === null ||
          home === null ||
          map === null ||
          trends === null ||
          settings === null ||
          icon === null
        ) {
          throw new Error("header controls are incomplete");
        }

        headingRange.selectNodeContents(heading);
        const shellBounds = shell.getBoundingClientRect();
        const mastheadBounds = masthead.getBoundingClientRect();
        const navigationBounds = navigation.getBoundingClientRect();
        const forecastIcon = forecast.querySelector(".material-symbols-rounded");
        const forecastIconBounds = forecastIcon?.getBoundingClientRect();
        const mapIcon = map.querySelector(".material-symbols-rounded");
        const trendsIcon = trends.querySelector(".material-symbols-rounded");
        const trendsIconBounds = trendsIcon?.getBoundingClientRect();
        const iconBounds = icon.getBoundingClientRect();
        const activeIndicator = settings.querySelector(".section-nav-icon");
        const activeIndicatorBounds = activeIndicator?.getBoundingClientRect();
        const controls = [home, forecast, trends, map, settings];
        const controlBounds = controls.map(
          // measure every rail destination
          (control) => control.getBoundingClientRect(),
        );
        return {
          activeIndicatorBackground: activeIndicator === null
            ? null
            : getComputedStyle(activeIndicator).backgroundColor,
          activeIndicatorHeight: activeIndicatorBounds?.height,
          activeIndicatorWidth: activeIndicatorBounds?.width,
          bodyWidth: document.body.scrollWidth,
          controlLabels: [
            home.lastElementChild?.textContent,
            forecast.lastElementChild?.textContent,
            trends.lastElementChild?.textContent,
            map.lastElementChild?.textContent,
            settings.lastElementChild?.textContent,
          ],
          decorationContent: getComputedStyle(masthead, "::after").content,
          desktopNavigationLeftAligned: Math.abs(navigationBounds.left - shellBounds.left) < 1,
          forecastIconIsGlyph: forecastIconBounds !== undefined && forecastIconBounds.width <= 24,
          forecastIconText: forecastIcon?.textContent,
          headingLineCount: headingRange.getClientRects().length,
          headingText: heading.textContent,
          iconFont: getComputedStyle(icon).fontFamily,
          iconHeight: iconBounds.height,
          iconText: icon.textContent,
          iconWidth: iconBounds.width,
          imageCount: masthead.querySelectorAll("img").length,
          linkCount: masthead.querySelectorAll("a").length,
          mapIconText: mapIcon?.textContent,
          navigationBelowMasthead: navigationBounds.top >= mastheadBounds.bottom,
          navigationPosition: getComputedStyle(navigation).position,
          navigationWidth: navigationBounds.width,
          railIsColumn: controlBounds.every(
            // keep every destination below its predecessor
            (bounds, index) => index === 0 || bounds.top >= controlBounds[index - 1].bottom,
          ),
          trendsIconText: trendsIcon?.textContent,
          trendsIconIsGlyph: trendsIconBounds !== undefined && trendsIconBounds.width <= 24,
          viewportWidth: document.documentElement.clientWidth,
        };
      },
    );

    assert.equal(headerLayout.activeIndicatorBackground, "rgb(240, 230, 150)");
    assert.equal(headerLayout.activeIndicatorHeight, 32);
    assert.equal(headerLayout.activeIndicatorWidth, 56);
    assert.deepEqual(headerLayout.controlLabels, ["Home", "Forecast", "Trends", "Map", "Settings"]);
    assert.equal(headerLayout.decorationContent, "none");
    assert.equal(headerLayout.desktopNavigationLeftAligned, true);
    assert.equal(headerLayout.headingLineCount, 1);
    assert.equal(headerLayout.headingText, "Ballydídean Weather");
    assert.equal(headerLayout.forecastIconIsGlyph, true);
    assert.equal(headerLayout.forecastIconText, "partly_cloudy_day");
    assert.equal(headerLayout.imageCount, 0);
    assert.match(headerLayout.iconFont, /Material Symbols Rounded/u);
    assert.equal(headerLayout.iconText, "settings");
    assert.equal(headerLayout.iconWidth <= 24 && headerLayout.iconHeight <= 24, true);
    assert.equal(headerLayout.linkCount, 0);
    assert.equal(headerLayout.mapIconText, "map");
    assert.equal(headerLayout.navigationBelowMasthead, true);
    assert.equal(headerLayout.navigationPosition, "sticky");
    assert.equal(headerLayout.navigationWidth, 92);
    assert.equal(headerLayout.railIsColumn, true);
    assert.equal(headerLayout.trendsIconIsGlyph, true);
    assert.equal(headerLayout.trendsIconText, "trending_up");
    assert.equal(headerLayout.bodyWidth <= headerLayout.viewportWidth, true);
    assert.equal(
      await page.locator(".condition-card").evaluateAll(
        // keep every tablet pill in the upper-right corner
        (cards) => cards.every(
          // verify one card
          (card) => {
            const heading = card.querySelector(".condition-card-heading")?.getBoundingClientRect();
            const status = card.querySelector(".condition-status")?.getBoundingClientRect();
            return heading !== undefined && status !== undefined &&
              Math.abs(status.top - heading.top) < 1 &&
              status.right > heading.left + heading.width / 2;
          },
        ),
      ),
      true,
    );
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});

test("real browser keeps the dashboard within a mobile viewport", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await createFixturePage(browser, { viewport: { height: 844, width: 390 } });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    assert.equal(
      await page.locator(".condition-primary strong").evaluateAll(
        // retain the shared primary scale on phones
        (readings) => new Set(readings.map(
          // read one mobile primary scale
          (reading) => getComputedStyle(reading).fontSize,
        )).size,
      ),
      1,
    );
    assert.equal(
      await page.locator("[data-condition='temperature'], [data-condition='wind'], [data-condition='rain'], [data-condition='tide']").evaluateAll(
        // retain one static secondary height on phones
        (cards) => new Set(cards.map(
          // measure one mobile secondary section
          (card) => {
            const secondary = card.querySelector(".condition-secondary");
            return secondary === null ? null : secondary.getBoundingClientRect().height;
          },
        )).size,
      ),
      1,
    );
    assert.equal(
      await page.locator(".current-conditions").evaluate(
        // keep temperature and wind paired on mobile
        (grid) => {
          const temperature = grid.querySelector("[data-condition='temperature']")?.getBoundingClientRect();
          const wind = grid.querySelector("[data-condition='wind']")?.getBoundingClientRect();
          return temperature !== undefined && wind !== undefined &&
            Math.abs(temperature.top - wind.top) < 1 &&
            Math.abs(temperature.width - wind.width) < 1 &&
            wind.left >= temperature.right;
        },
      ),
      true,
    );
    const mobileDividerTops = await page.locator("[data-condition='temperature'], [data-condition='wind']").evaluateAll(
      // measure paired mobile dividers
      (cards) => cards.map(
        // capture one divider position
        (card) => card.querySelector(".condition-secondary-divider")?.getBoundingClientRect().top ?? null,
      ),
    );
    assert.equal(mobileDividerTops.includes(null), false);
    assert.ok(
      Math.abs((mobileDividerTops[0] ?? 0) - (mobileDividerTops[1] ?? 0)) <= 1,
      JSON.stringify(mobileDividerTops),
    );
    assert.deepEqual(
      await page.locator(".condition-card").evaluateAll(
        // keep compact labels clear of status pills
        (cards) => cards.filter(
          // verify one mobile card
          (card) => {
            const label = card.querySelector(".condition-label");
            const status = card.querySelector(".condition-status");

            // require both heading controls
            if (label === null || status === null) {
              return true;
            }

            const labelBounds = label.getBoundingClientRect();
            const statusBounds = status.getBoundingClientRect();
            return label.scrollWidth > label.clientWidth || labelBounds.right > statusBounds.left;
          },
        ).map((card) => card.getAttribute("data-condition")),
      ),
      [],
    );
    const mobileTideDirection = page.locator("[data-condition='tide'] .condition-secondary");
    assert.equal(await mobileTideDirection.isVisible(), true);
    assert.match(await mobileTideDirection.textContent() ?? "", /Direction\s*Rising/u);
    assert.equal(await page.locator("[data-condition='tide'] .condition-detail").count(), 0);
    await page.setViewportSize({ height: 844, width: 320 });
    assert.deepEqual(
      await page.locator(".section-nav").evaluate(
        // keep the complete toolbar on one narrow row
        (navigation) => {
          const controls = [...navigation.children].map((control) => control.getBoundingClientRect());
          const navigationBounds = navigation.getBoundingClientRect();
          return {
            bottomAligned: Math.abs(navigationBounds.bottom - document.documentElement.clientHeight) < 1,
            fullWidth: Math.abs(navigationBounds.width - document.documentElement.clientWidth) < 1,
            oneRow: controls.every((control) => Math.abs(control.top - controls[0].top) < 1),
            position: getComputedStyle(navigation).position,
            withinViewport: navigationBounds.left >= 0 && navigationBounds.right <= document.documentElement.clientWidth,
          };
        },
      ),
      { bottomAligned: true, fullWidth: true, oneRow: true, position: "fixed", withinViewport: true },
    );
    assert.equal(
      await page.locator("body").evaluate(
        // reject narrow toolbar overflow
        (body) => body.scrollWidth > document.documentElement.clientWidth,
      ),
      false,
    );
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto(`${fixture.origin}/trends`, { waitUntil: "networkidle" });
    assert.deepEqual(
      await page.locator(".trends-panel").evaluate(
        // rotate the chart and its selector together on phones
        (panel) => {
          const chart = panel.querySelector(".trend-chart");
          const crosshair = panel.querySelector(".trend-crosshair-line");
          const crosshairDate = panel.querySelector(".trend-crosshair-date-pill");
          const crosshairSummary = panel.querySelector(".trend-crosshair-summary");
          const crosshairValueFlags = panel.querySelector(".trend-crosshair-values");
          const currentYearLine = panel.querySelector(".trend-year-line-current");
          const detailToggle = panel.querySelector("[data-trend-detail-toggle]");
          const landscape = panel.querySelector(".trend-chart-landscape");
          const legend = panel.querySelector(".trend-chart-legend");
          const masthead = document.querySelector(".masthead");
          const navigation = document.querySelector(".section-nav");
          const title = panel.querySelector(".trend-chart-title");
          const titleControl = title?.closest(".trend-metric-control");
          const svg = panel.querySelector(".trend-chart-landscape > svg");
          const viewport = panel.querySelector(".trend-chart-viewport");

          // require the complete mobile trend surface
          if (
            chart === null ||
            crosshair === null ||
            crosshairDate === null ||
            crosshairSummary === null ||
            crosshairValueFlags === null ||
            currentYearLine === null ||
            detailToggle === null ||
            landscape === null ||
            legend === null ||
            masthead === null ||
            navigation === null ||
            title === null ||
            titleControl === null ||
            svg === null ||
            viewport === null
          ) {
            throw new Error("mobile trend chart is incomplete");
          }

          const chartBounds = chart.getBoundingClientRect();
          const detailToggleStyle = getComputedStyle(detailToggle);
          const landscapeBounds = landscape.getBoundingClientRect();
          const crosshairBounds = crosshair.getBoundingClientRect();
          const crosshairDateBounds = crosshairDate.getBoundingClientRect();
          const crosshairSummaryBounds = crosshairSummary.getBoundingClientRect();
          const navigationBounds = navigation.getBoundingClientRect();
          const viewportBounds = viewport.getBoundingClientRect();
          const landscapeTransform = getComputedStyle(landscape).transform;
          const legendStyle = getComputedStyle(legend);
          const titleControlStyle = getComputedStyle(titleControl);
          const chartStyle = getComputedStyle(chart);
          const currentYearPoint = currentYearLine.points.getItem(currentYearLine.points.numberOfItems - 1);
          const currentYearY = (currentYearPoint.y / 280) * landscape.clientHeight;
          const crosshairValueFlagsStyle = getComputedStyle(crosshairValueFlags);
          const summaryOnLeft = crosshairSummary.classList.contains("trend-crosshair-summary-left");
          return {
            cardRemoved: chartStyle.borderTopStyle === "none" &&
              chartStyle.backgroundColor === "rgba(0, 0, 0, 0)" &&
              chartStyle.boxShadow === "none" &&
              chartStyle.paddingTop === "0px",
            chartFitsAboveNavigation: chartBounds.bottom <= navigationBounds.top + 1,
            crosshairInsideLandscape: crosshairBounds.left >= landscapeBounds.left - 1 &&
              crosshairBounds.right <= landscapeBounds.right + 1 &&
              crosshairBounds.top >= landscapeBounds.top - 1 &&
              crosshairBounds.bottom <= landscapeBounds.bottom + 1,
            crosshairDateCentered: Math.abs(
              Number.parseFloat(getComputedStyle(crosshairDate).left) -
              Number.parseFloat(getComputedStyle(crosshair).left),
            ) < 1,
            crosshairDateInsideLandscape: crosshairDateBounds.left >= landscapeBounds.left - 1 &&
              crosshairDateBounds.right <= landscapeBounds.right + 1 &&
              crosshairDateBounds.top >= landscapeBounds.top - 1 &&
              crosshairDateBounds.bottom <= landscapeBounds.bottom + 1,
            crosshairDateInsideRotatedChart: crosshairDate.closest(".trend-chart-landscape") === landscape,
            crosshairSummaryInsideLandscape: crosshairSummaryBounds.left >= landscapeBounds.left - 1 &&
              crosshairSummaryBounds.right <= landscapeBounds.right + 1 &&
              crosshairSummaryBounds.top >= landscapeBounds.top - 1 &&
              crosshairSummaryBounds.bottom <= landscapeBounds.bottom + 1,
            crosshairSummaryInsidePlot: crosshairSummary.offsetTop >= landscape.clientHeight * (42 / 280) - 1 &&
              crosshairSummary.offsetTop + crosshairSummary.offsetHeight <=
                landscape.clientHeight * ((280 - 34) / 280) + 1,
            crosshairSummaryMatchesCurrentYear: Math.abs(
              crosshairSummary.offsetTop + crosshairSummary.offsetHeight / 2 - currentYearY,
            ) < 2,
            crosshairSummarySquareAgainstLine: summaryOnLeft
              ? crosshairValueFlagsStyle.borderTopRightRadius === "0px" &&
                crosshairValueFlagsStyle.borderBottomRightRadius === "0px"
              : crosshairValueFlagsStyle.borderTopLeftRadius === "0px" &&
                crosshairValueFlagsStyle.borderBottomLeftRadius === "0px",
            detailIcon: detailToggle.querySelector("[data-trend-toggle-icon]")?.getAttribute("data-trend-toggle-icon"),
            detailTopLeftOfTitle: Number.parseFloat(detailToggleStyle.left) <
              Number.parseFloat(titleControlStyle.left) &&
              Math.abs(Number.parseFloat(detailToggleStyle.top) - Number.parseFloat(titleControlStyle.top)) < 2,
            landscapeFitsViewport: landscapeBounds.left >= viewportBounds.left - 1 &&
              landscapeBounds.right <= viewportBounds.right + 1 &&
              landscapeBounds.top >= viewportBounds.top - 1 &&
              landscapeBounds.bottom <= viewportBounds.bottom + 1,
            landscapeRotated: landscapeTransform.startsWith("matrix(0, 1, -1, 0"),
            legendAtChosenEdge: legend.dataset.trendLegendPlacement === "top"
              ? Number.parseFloat(legendStyle.top) > landscape.clientHeight * (42 / 280)
              : Number.parseFloat(legendStyle.bottom) > landscape.clientHeight * (34 / 280),
            legendInsideRotatedChart: legend.closest(".trend-chart-landscape") === landscape,
            mastheadTransform: getComputedStyle(masthead).transform,
            navigationTransform: getComputedStyle(navigation).transform,
            titleInsideRotatedChart: title.closest(".trend-chart-landscape") === landscape,
            titleTag: title.tagName,
            titleTopCenteredInGraph: Math.abs(
              Number.parseFloat(titleControlStyle.left) - landscape.clientWidth / 2,
            ) < 1 && Number.parseFloat(titleControlStyle.top) < landscape.clientHeight / 2,
            svgFitsBothAxes: svg.clientWidth === landscape.clientWidth &&
              svg.clientHeight === landscape.clientHeight,
          };
        },
      ),
      {
        cardRemoved: true,
        chartFitsAboveNavigation: true,
        crosshairDateCentered: true,
        crosshairDateInsideLandscape: true,
        crosshairDateInsideRotatedChart: true,
        crosshairInsideLandscape: true,
        crosshairSummaryInsideLandscape: true,
        crosshairSummaryInsidePlot: true,
        crosshairSummaryMatchesCurrentYear: true,
        crosshairSummarySquareAgainstLine: true,
        detailIcon: "daily",
        detailTopLeftOfTitle: true,
        landscapeFitsViewport: true,
        landscapeRotated: true,
        legendAtChosenEdge: true,
        legendInsideRotatedChart: true,
        mastheadTransform: "none",
        navigationTransform: "none",
        titleInsideRotatedChart: true,
        titleTag: "H2",
        titleTopCenteredInGraph: true,
        svgFitsBothAxes: true,
      },
    );
    assert.equal(await page.getByRole("heading", { name: "Yearly trends" }).count(), 0);
    assert.equal(await page.getByRole("heading", { name: "Temperature" }).count(), 1);
    const mobileTrendMetricTrigger = page.locator("[data-trend-metric-trigger]");
    await mobileTrendMetricTrigger.click();
    assert.equal(await page.locator(".trend-metric-flyover").isVisible(), true);
    assert.equal(
      await page.locator(".trend-metric-flyover").evaluate(
        // keep the flyover inside the rotated chart coordinate system
        (flyover) => flyover.closest(".trend-chart-landscape") !== null,
      ),
      true,
    );
    await page.keyboard.press("Escape");
    const mobileTrendDateBefore = await page.locator("[data-trend-crosshair-date]").textContent();
    const mobileTrendBounds = await page.locator("[data-trend-scrub-surface]").boundingBox();

    // require one rotated annual scrub surface
    if (mobileTrendBounds === null) {
      throw new Error("mobile trend scrub surface is unavailable");
    }

    await page.mouse.move(
      mobileTrendBounds.x + mobileTrendBounds.width * 0.5,
      mobileTrendBounds.y + mobileTrendBounds.height * 0.75,
    );
    await page.mouse.down();
    await page.mouse.move(
      mobileTrendBounds.x + mobileTrendBounds.width * 0.5,
      mobileTrendBounds.y + mobileTrendBounds.height * 0.3,
      { steps: 4 },
    );
    await page.mouse.up();
    assert.notEqual(await page.locator("[data-trend-crosshair-date]").textContent(), mobileTrendDateBefore);
    const initialMobileTrendWidth = await page.locator(".trend-chart-landscape").evaluate((landscape) => landscape.clientWidth);
    await page.getByRole("button", { name: "Daily detail" }).click();
    await page.locator("[data-trend-detail=daily]").waitFor();
    await mobileTrendMetricTrigger.click();
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // rotate the fixed daily flyover with the scrollable chart
        (chart) => {
          const fixedChrome = chart.querySelector(".trend-chart-fixed-chrome");
          const flyover = chart.querySelector(".trend-metric-flyover");
          const landscape = chart.querySelector(".trend-chart-landscape");

          // require both mobile rotation layers
          if (fixedChrome === null || flyover === null || landscape === null) {
            throw new Error("mobile trend flyover rotation is incomplete");
          }

          return {
            flyoverInsideFixedChrome: flyover.closest(".trend-chart-fixed-chrome") === fixedChrome,
            matchingRotation: getComputedStyle(fixedChrome).transform === getComputedStyle(landscape).transform,
          };
        },
      ),
      { flyoverInsideFixedChrome: true, matchingRotation: true },
    );
    await page.keyboard.press("Escape");
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // verify the fixed daily canvas scrolls along the rotated annual axis
        (chart) => {
          const landscape = chart.querySelector(".trend-chart-landscape");
          const viewport = chart.querySelector(".trend-chart-viewport");

          // require both rotated detail containers
          if (!(landscape instanceof HTMLElement) || !(viewport instanceof HTMLElement)) {
            throw new Error("mobile trend detail geometry is incomplete");
          }

          return {
            scrollable: viewport.scrollHeight > viewport.clientHeight,
            width: landscape.clientWidth,
          };
        },
      ),
      { scrollable: true, width: 3000 },
    );
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // keep rotated chart chrome fixed while the daily data canvas moves
        (chart) => {
          const legend = chart.querySelector(".trend-chart-legend");
          const svg = chart.querySelector(".trend-chart-landscape > svg");
          const title = chart.querySelector(".trend-metric-control");
          const viewport = chart.querySelector(".trend-chart-viewport");
          const xAxis = chart.querySelector(".trend-month-axis");

          // require both rotated fixed chrome and scrollable data
          if (
            !(legend instanceof HTMLElement) ||
            !(svg instanceof SVGElement) ||
            !(title instanceof HTMLElement) ||
            !(viewport instanceof HTMLElement) ||
            !(xAxis instanceof HTMLElement)
          ) {
            throw new Error("mobile daily trend scroll layers are incomplete");
          }

          viewport.scrollTop = 0;
          const viewportBounds = viewport.getBoundingClientRect();
          const initial = {
            legend: legend.getBoundingClientRect().top,
            plot: svg.getBoundingClientRect().top,
            title: title.getBoundingClientRect().top,
            xAxis: xAxis.getBoundingClientRect().top,
          };
          viewport.scrollTop = 500;
          const legendBounds = legend.getBoundingClientRect();
          const titleBounds = title.getBoundingClientRect();
          return {
            legendFixed: Math.abs(legend.getBoundingClientRect().top - initial.legend) < 1,
            legendVisible: legendBounds.top >= viewportBounds.top - 1 &&
              legendBounds.bottom <= viewportBounds.bottom + 1,
            plotMoved: svg.getBoundingClientRect().top < initial.plot - 499,
            titleFixed: Math.abs(title.getBoundingClientRect().top - initial.title) < 1,
            titleVisible: titleBounds.top >= viewportBounds.top - 1 &&
              titleBounds.bottom <= viewportBounds.bottom + 1,
            xAxisMoved: xAxis.getBoundingClientRect().top < initial.xAxis - 499,
          };
        },
      ),
      {
        legendFixed: true,
        legendVisible: true,
        plotMoved: true,
        titleFixed: true,
        titleVisible: true,
        xAxisMoved: true,
      },
    );
    await page.locator("[data-trend-scrub-surface]").evaluate(
      // simulate a pinch that must not resize the fixed daily canvas
      (surface) => {
        const bounds = surface.getBoundingClientRect();
        const emit = (type, pointerId, clientY) => surface.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: bounds.left + bounds.width * 0.5,
          clientY,
          pointerId,
          pointerType: "touch",
        }));
        emit("pointerdown", 51, bounds.top + bounds.height * 0.4);
        emit("pointerdown", 52, bounds.top + bounds.height * 0.6);
        emit("pointermove", 52, bounds.top + bounds.height * 0.8);
        emit("pointerup", 52, bounds.top + bounds.height * 0.8);
        emit("pointerup", 51, bounds.top + bounds.height * 0.4);
      },
    );
    assert.equal(await page.locator(".trend-chart-landscape").evaluate((landscape) => landscape.clientWidth), 3000);
    assert.equal(await page.locator("[data-trend-zoom]").count(), 0);
    await page.locator(".trend-chart-viewport").evaluate(
      // reset the rotated native scroll position
      (viewport) => {
        viewport.scrollTop = 0;
      },
    );
    await page.locator("[data-trend-scrub-surface]").dispatchEvent("wheel", {
      clientX: mobileTrendBounds.x + mobileTrendBounds.width / 2,
      clientY: mobileTrendBounds.y + mobileTrendBounds.height / 2,
      deltaY: 120,
    });
    assert.equal(await page.locator(".trend-chart-viewport").evaluate((viewport) => viewport.scrollTop > 0), true);
    await page.getByRole("button", { name: "7-day average" }).click();
    await page.locator("[data-trend-detail=rolling]").waitFor();
    assert.equal(await page.locator(".trend-chart-landscape").evaluate(
      // preserve the original rotated width floor
      (landscape, initialWidth) => landscape.clientWidth >= initialWidth,
      initialMobileTrendWidth,
    ), true);
    assert.equal(
      await page.locator("body").evaluate(
        // reject rotated-chart horizontal overflow
        (body) => body.scrollWidth > document.documentElement.clientWidth,
      ),
      false,
    );
    await mobileTrendMetricTrigger.click();
    await page.locator('[data-trend-metric-option="windDirectionRose"]').click();
    await page.locator('[data-trend-chart="windDirectionRose"]').waitFor();
    assert.deepEqual(
      await page.locator(".trend-chart").evaluate(
        // keep the polar chart inside the rotated mobile surface
        (chart) => {
          const landscape = chart.querySelector(".trend-chart-landscape");
          const rose = chart.querySelector(".trend-wind-rose");

          // require the complete mobile polar surface
          if (!(landscape instanceof HTMLElement) || !(rose instanceof SVGElement)) {
            throw new Error("mobile wind rose is incomplete");
          }

          const landscapeBounds = landscape.getBoundingClientRect();
          const roseBounds = rose.getBoundingClientRect();
          return {
            labels: rose.querySelectorAll(".trend-wind-rose-label").length,
            roseInsideLandscape: roseBounds.left >= landscapeBounds.left - 1 &&
              roseBounds.right <= landscapeBounds.right + 1 &&
              roseBounds.top >= landscapeBounds.top - 1 &&
              roseBounds.bottom <= landscapeBounds.bottom + 1,
          };
        },
      ),
      { labels: 8, roseInsideLandscape: true },
    );
    await mobileTrendMetricTrigger.click();
    await page.locator('[data-trend-metric-option="extremeDayCount"]').click();
    await page.locator('[data-trend-chart="extremeDayCount"]').waitFor();
    assert.equal(
      await page.locator("[data-trend-extreme-controls]").evaluate(
        // keep threshold controls inside the rotated chart
        (controls) => {
          const chart = controls.closest(".trend-chart-landscape");

          // require one rotated control owner
          if (!(chart instanceof HTMLElement)) {
            return false;
          }

          const bounds = controls.getBoundingClientRect();
          const chartBounds = chart.getBoundingClientRect();
          return bounds.left >= chartBounds.left - 1 &&
            bounds.right <= chartBounds.right + 1 &&
            bounds.top >= chartBounds.top - 1 &&
            bounds.bottom <= chartBounds.bottom + 1;
        },
      ),
      true,
    );
    assert.equal(
      await page.locator("body").evaluate(
        // reject derived-chart horizontal overflow
        (body) => body.scrollWidth > document.documentElement.clientWidth,
      ),
      false,
    );
    await page.goto(`${fixture.origin}/map`, { waitUntil: "networkidle" });
    assert.deepEqual(
      await page.locator(".property-map-layout").evaluate(
        // stack property sensors into ordinary page scroll on phones
        (layout) => {
          const map = layout.querySelector(".property-map");
          const list = layout.querySelector(".property-sensor-list");

          // require both mobile sections
          if (!(map instanceof HTMLElement) || !(list instanceof HTMLElement)) {
            throw new Error("mobile property map layout is incomplete");
          }

          return {
            listBelowMap: list.getBoundingClientRect().top >= map.getBoundingClientRect().bottom,
            overflowY: getComputedStyle(list).overflowY,
            position: getComputedStyle(list).position,
          };
        },
      ),
      { listBelowMap: true, overflowY: "visible", position: "static" },
    );
    await page.locator(".station-map").scrollIntoViewIfNeeded();
    const markerCentersAreClickable = await page.locator(".station-marker").evaluateAll(
      // keep overlay controls away from every marker center
      (markers) => markers.map((marker) => {
        const bounds = marker.getBoundingClientRect();
        const center = document.elementFromPoint(
          bounds.left + bounds.width / 2,
          bounds.top + bounds.height / 2,
        );
        return center?.closest(".station-marker") === marker;
      }),
    );
    assert.equal(markerCentersAreClickable.every(Boolean), true);
    assert.equal(
      await page.locator("body").evaluate(
        // reject map-route horizontal overflow
        (body) => body.scrollWidth > document.documentElement.clientWidth,
      ),
      false,
    );
    await page.goto(`${fixture.origin}/logs`, { waitUntil: "networkidle" });
    const width = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    assert.equal(width.body <= width.viewport, true);
    assert.equal(await page.getByRole("button", { name: "Apply filters" }).isVisible(), false);
    await page.getByText("Filters", { exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Apply filters" }).isVisible(), true);
    assert.equal(await page.locator(".table-scroll").isVisible(), false);
    assert.equal(await page.locator(".history-cards").isVisible(), true);
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});
