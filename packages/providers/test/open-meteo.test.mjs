import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ProviderFailure,
  buildOpenMeteoArchiveRequest,
  buildOpenMeteoCurrentRequest,
  createOpenMeteoCurrentOperation,
  createOpenMeteoHistoricalOperation,
  fetchJsonWithRetry,
  fetchOpenMeteoCurrent,
  normalizeArchivePayload,
  normalizeCurrentPayload,
  openMeteoCapabilities,
  parseOpenMeteoCompatibilityOrigin,
} from "../dist/index.js";

const location = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  sourceId: "source-current",
  timezone: "America/Los_Angeles",
};
const receivedAt = "2026-08-22T05:00:00.000Z";

// load a committed provider fixture
async function fixture(name) {
  return JSON.parse(
    await readFile(new URL(`./fixtures/open-meteo/${name}`, import.meta.url), "utf8"),
  );
}

// prove modern current request parameters
test("U-OM-01 current URL uses modern variables and explicit controls", () => {
  const plan = buildOpenMeteoCurrentRequest(location);
  assert.equal(plan.url.origin + plan.url.pathname, "https://api.open-meteo.com/v1/forecast");
  assert.match(plan.url.searchParams.get("current"), /temperature_2m/u);
  assert.equal(plan.url.searchParams.get("hourly"), null);
  assert.equal(plan.url.searchParams.get("temperature_unit"), "celsius");
  assert.equal(plan.url.searchParams.get("wind_speed_unit"), "ms");
  assert.equal(plan.url.searchParams.get("precipitation_unit"), "mm");
  assert.equal(plan.url.searchParams.get("timezone"), location.timezone);
});

// prove archive request parameters
test("U-OM-02 archive URL uses inclusive dates and hourly variables", () => {
  const plan = buildOpenMeteoArchiveRequest({
    ...location,
    endDate: "2026-08-03",
    startDate: "2026-08-01",
  });
  assert.equal(
    plan.url.origin + plan.url.pathname,
    "https://archive-api.open-meteo.com/v1/archive",
  );
  assert.match(plan.url.searchParams.get("hourly"), /surface_pressure/u);
  assert.equal(plan.url.searchParams.get("start_date"), "2026-08-01");
  assert.equal(plan.url.searchParams.get("end_date"), "2026-08-03");
});

// prove current normalization and provenance
test("U-OM-03 current fixture normalizes to model_current", async () => {
  const record = normalizeCurrentPayload(
    await fixture("current.json"),
    location.sourceId,
    receivedAt,
  );
  assert.equal(record.sourceKind, "model_current");
  assert.equal(record.validAt, "2026-08-22T05:00:00.000Z");
  assert.equal(record.metrics.precipitationMm, 0);
  assert.equal(record.metadata.upstreamTimezone, "America/Los_Angeles");
  assert.equal(record.metadata.model, "best_match");
  assert.deepEqual(record.metadata.provider, {
    dataset: "forecast",
    elevation_m: 32,
    grid_cell: "47.941,-122.438",
  });
});

// prove archive normalization across repeated DST time
test("U-OM-04 archive fixture normalizes distinct reanalysis instants", async () => {
  const records = normalizeArchivePayload(
    await fixture("archive-fall-back.json"),
    "source-archive",
    receivedAt,
  );
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((record) => record.validAt),
    [
      "2026-11-01T08:00:00.000Z",
      "2026-11-01T09:00:00.000Z",
      "2026-11-01T10:00:00.000Z",
    ],
  );
  assert.equal(records[0].sourceKind, "reanalysis");
  assert.equal(records[1].metrics.precipitationMm, null);
});

// prove malformed and mismatched arrays fail closed
test("U-OM-05 invalid and mismatched payloads are classified invalid_payload", async () => {
  const payload = await fixture("archive-fall-back.json");
  payload.hourly.temperature_2m = payload.hourly.temperature_2m.slice(1);
  assert.throws(
    () => normalizeArchivePayload(payload, "source-archive", receivedAt),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.classification === "invalid_payload",
  );
  assert.throws(
    () => normalizeCurrentPayload({}, location.sourceId, receivedAt),
    ProviderFailure,
  );
});

// prove timeout abort behavior
test("U-OM-07 configured timeout aborts the provider request", async () => {
  let aborted = false;
  const pendingFetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      // observe the abort signal
      init.signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: pendingFetch,
      maxAttempts: 1,
      timeoutMs: 5,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.classification === "retryable",
  );
  assert.equal(aborted, true);
});

// prove bounded retry and no secret headers
test("U-OM-08 429 retries once with deterministic delay", async () => {
  const delays = [];
  const requests = [];
  let attempt = 0;
  const current = await fixture("current.json");
  const injectedFetch = async (url, init) => {
    attempt += 1;
    requests.push({ init, url: String(url) });

    // rate limit the first request
    if (attempt === 1) {
      return new Response('{"error":true,"reason":"slow down"}', {
        headers: { "retry-after": "1" },
        status: 429,
      });
    }

    return new Response(JSON.stringify(current), { status: 200 });
  };
  const batch = await fetchOpenMeteoCurrent(location, {
    fetch: injectedFetch,
    now: () => new Date(receivedAt),
    random: () => 0,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
  });
  assert.equal(batch.attempts, 2);
  assert.deepEqual(delays, [1_000]);
  assert.deepEqual(requests[0].init.headers, { accept: "application/json" });
});

// prove permanent failures do not retry
test("U-OM-09 4xx and invalid JSON do not retry", async () => {
  let attempts = 0;
  const rejectedFetch = async () => {
    attempts += 1;
    return new Response('{"error":true,"reason":"bad input"}', { status: 400 });
  };
  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: rejectedFetch,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.classification === "permanent",
  );
  assert.equal(attempts, 1);
});

// prove capability boundary stays narrow
test("U-OM-10 capability report is exact", () => {
  assert.deepEqual(openMeteoCapabilities(), ["current", "historical"]);
});

// prove executable operations and safe endpoint selection
test("Open-Meteo operations default official and allow a safe compatibility origin", async () => {
  const current = await fixture("current.json");
  const archive = await fixture("archive-fall-back.json");
  const requests = [];
  const currentOperation = createOpenMeteoCurrentOperation();
  const historicalOperation = createOpenMeteoHistoricalOperation(
    "http://provider-stub:8080",
  );
  await currentOperation(location, {
    fetch: async (url) => {
      requests.push(String(url));
      return new Response(JSON.stringify(current), { status: 200 });
    },
    now: () => new Date(receivedAt),
  });
  await historicalOperation(
    { ...location, endDate: "2026-11-01", startDate: "2026-11-01" },
    {
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(JSON.stringify(archive), { status: 200 });
      },
      now: () => new Date(receivedAt),
    },
  );

  assert.equal(new URL(requests[0]).origin, "https://api.open-meteo.com");
  assert.equal(
    new URL(requests[1]).origin + new URL(requests[1]).pathname,
    "http://provider-stub:8080/v1/archive",
  );
});

// reject unsafe compatibility origins
test("compatibility origin is credential-free and origin-only", () => {
  assert.equal(parseOpenMeteoCompatibilityOrigin(undefined), null);
  assert.equal(
    parseOpenMeteoCompatibilityOrigin("http://provider-stub:8080"),
    "http://provider-stub:8080",
  );

  // reject credentials paths queries fragments and non-http schemes
  for (const value of [
    "http://user:secret@provider-stub:8080",
    "http://provider-stub:8080/path",
    "http://provider-stub:8080?token=secret",
    "http://provider-stub:8080#fragment",
    "file:///tmp/provider",
  ]) {
    assert.throws(
      () => parseOpenMeteoCompatibilityOrigin(value),
      /credential-free HTTP origin/u,
    );
  }
});
