import assert from "node:assert/strict";
import test from "node:test";

import { createWeatherApi } from "../dist/index.js";

const endpoint = "https://weather.ballydidean.farm/api/v1/sites/ballydidean/rain-collection";

// provide aggregate-only test input with a deliberate forbidden extra field
function status() {
  return {
    claims: 15, receipts: 14, validForecasts: 2, timelyForecasts: 1,
    validStationWindows: 12, stationsSeen: 12, failedRequests: 0,
    pendingRequests: 0, unknownRequests: 1, compressedBytes: 1000,
    lastClaimAt: "2026-09-14T12:00:00.000Z",
    lastReceiptAt: "2026-09-14T12:00:02.000Z",
    lastForecastReceiptAt: "2026-09-14T12:00:02.000Z",
    lastStationReceiptAt: "2026-09-14T11:06:00.000Z",
    pausedUntil: null, rawBody: "private-provider-body", apiKey: "private-key",
  };
}

// supply one ordinary site without permitting private source queries
function store(value = status()) {
  return {
    async getRainCollectionStatus() { return value; },
    async listSites() {
      return [{
        siteSlug: "ballydidean", siteName: "Ballydidean", latitude: 47.95,
        longitude: -122.43, timezone: "America/Los_Angeles",
        stationSlug: "fixture", stationName: "Fixture", stationKind: "virtual",
        stationLatitude: 47.95, stationLongitude: -122.43,
        sourceId: "1", sourceKey: "fixture", sourceKind: "model_current",
        providerKey: "fixture", providerName: "Fixture",
        attributionLabel: "Fixture", attributionUrl: "https://example.com",
      }];
    },
  };
}

// expose counts while independently forcing model and qualification disabled
test("rain status is read-only aggregate evidence with no raw response or key", async () => {
  const handler = createWeatherApi(store(), { now: () => new Date("2026-09-14T12:01:00Z") });
  const response = await handler(new Request(endpoint));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.data.modelEnabled, false);
  assert.equal(body.data.qualificationEnabled, false);
  assert.equal(body.data.expectedStations, 12);
  assert.equal(body.data.timelyForecasts, 1);
  assert.equal(body.data.unknownRequests, 1);
  assert.equal(JSON.stringify(body).includes("private-"), false);
  assert.equal(Object.hasOwn(body.data, "rawBody"), false);
});

// reject write methods and unsupported query or raw-data paths
test("rain status rejects writes, extra parameters and private subroutes", async () => {
  const handler = createWeatherApi(store());
  assert.equal((await handler(new Request(endpoint, { method: "POST" }))).status, 405);
  assert.equal((await handler(new Request(`${endpoint}?raw=true`))).status, 400);
  assert.equal((await handler(new Request(`${endpoint}/receipts`))).status, 404);
  const head = await handler(new Request(endpoint, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

// fail closed instead of inventing healthy status from malformed counts
test("invalid rain aggregates and unavailable storage produce a redacted error", async () => {
  const bad = createWeatherApi(store({ ...status(), claims: -1 }));
  const invalid = await bad(new Request(endpoint));
  assert.equal(invalid.status, 500);
  assert.equal((await invalid.text()).includes("private-"), false);
  const failing = store();
  failing.getRainCollectionStatus = async () => { throw new Error("private-key"); };
  const response = await createWeatherApi(failing)(new Request(endpoint));
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("private-key"), false);
});
