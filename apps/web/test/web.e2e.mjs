import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

import { chromium } from "playwright";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const publicRoot = join(repositoryRoot, "apps/web/public");
const distRoot = join(repositoryRoot, "apps/web/dist");

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

const current = makeRecord("101", "2026-08-22T04:50:00.000Z", 16.2);
const older = makeRecord("100", "2026-08-21T04:50:00.000Z", 15.1);

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
      provider: { dataset: "best_match", elevationM: 17, gridCell: null },
      quality: null,
      upstream: {
        model: "best_match",
        timezone: "America/Los_Angeles",
      },
    },
    metrics: {
      apparentTemperatureC: temperatureC - 0.7,
      cloudCoverPercent: 42,
      precipitationMm: 0.2,
      pressureHpa: 1014.2,
      relativeHumidityPercent: 78,
      temperatureC,
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
    receivedAt: validAt,
    revisionCount: 0,
    validAt,
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

// start a bounded static and fake API server
async function startFixtureServer() {
  const state = {
    failReads: false,
    mutations: 0,
    requests: [],
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://weather.test");
    state.requests.push(`${request.method ?? "GET"} ${url.pathname}${url.search}`);

    // reject every mutation
    if (!["GET", "HEAD"].includes(request.method ?? "GET")) {
      state.mutations += 1;
      sendJson(response, { error: { code: "method_not_allowed" } }, 405);
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
      sendJson(response, { data: [current], site });
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

    const assets = new Map([
      ["/", [join(publicRoot, "index.html"), "text/html; charset=utf-8"]],
      ["/styles.css", [join(publicRoot, "styles.css"), "text/css; charset=utf-8"]],
      ["/client.js", [join(distRoot, "client.js"), "text/javascript; charset=utf-8"]],
      ["/index.js", [join(distRoot, "index.js"), "text/javascript; charset=utf-8"]],
    ]);
    const asset = assets.get(url.pathname);

    // serve allowlisted browser assets
    if (asset !== undefined) {
      response.statusCode = 200;
      response.setHeader("content-type", asset[1]);
      response.end(readFileSync(asset[0]));
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

// send one bounded JSON response
function sendJson(response, body, status = 200) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

test("real browser covers filters, pagination, last-good recovery, attribution, and mutation denial", { timeout: 60_000 }, async () => {
  const fixture = await startFixtureServer();
  let browser;

  try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    await assert.doesNotReject(() => page.getByRole("heading", { name: "Ballydidean weather" }).waitFor());
    assert.equal(await page.getByText("16.2").first().isVisible(), true);
    assert.equal(await page.getByText("model-derived current conditions").first().isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "Open-Meteo" }).isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "CC BY 4.0" }).isVisible(), true);
    assert.equal(await page.locator("table caption").count(), 1);

    await page.locator("select[name='stationSlug']").selectOption("open-meteo-virtual");
    await page.locator("select[name='sourceId']").selectOption("11");
    await page.locator("select[name='sourceKind']").selectOption("reanalysis");
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.waitForLoadState("networkidle");
    assert.ok(
      fixture.state.requests.some(
        // require frozen current filter names
        (entry) =>
          entry.includes("/current?") &&
          entry.includes("station=open-meteo-virtual") &&
          entry.includes("source=11"),
      ),
    );
    assert.ok(
      fixture.state.requests.some(
        // require frozen history filter names
        (entry) =>
          entry.includes("/history?") &&
          entry.includes("sourceKind=reanalysis"),
      ),
    );

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("15.1").first().waitFor();
    assert.equal(await page.getByRole("button", { name: "Next" }).isDisabled(), true);
    await page.getByRole("button", { name: "Previous" }).click();
    await page.getByText("16.2").first().waitFor();

    fixture.state.failReads = true;
    await page.getByRole("button", { name: "Apply filters" }).click();
    await page.getByRole("alert").waitFor();
    assert.match(await page.getByRole("alert").textContent() ?? "", /status 503/u);
    assert.equal(await page.getByText("16.2").first().isVisible(), true);
    assert.equal(await page.getByRole("link", { name: "CC BY 4.0" }).isVisible(), true);

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
    assert.equal(await page.getByText("16.2").first().isVisible(), true);

    await page.locator("body").press("Home");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "SELECT");
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
    const page = await browser.newPage({ viewport: { height: 844, width: 390 } });
    await page.goto(fixture.origin, { waitUntil: "networkidle" });
    const width = await page.evaluate(() => ({
      body: document.body.scrollWidth,
      viewport: document.documentElement.clientWidth,
    }));
    assert.equal(width.body <= width.viewport, true);
    assert.equal(await page.getByRole("button", { name: "Apply filters" }).isVisible(), true);
  } finally {
    await browser?.close();
    fixture.server.close();
    await once(fixture.server, "close");
  }
});
