import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ProviderFailure,
  buildOpenMeteoAirQualityForecastRequest,
  buildOpenMeteoArchiveRequest,
  buildOpenMeteoCurrentRequest,
  buildOpenMeteoForecastRequest,
  createOpenMeteoCurrentOperation,
  createOpenMeteoForecastOperation,
  createOpenMeteoHistoricalOperation,
  fetchJsonWithRetry,
  fetchOpenMeteoCurrent,
  fetchOpenMeteoForecast,
  normalizeArchivePayload,
  normalizeCurrentPayload,
  normalizeForecastPayload,
  openMeteoCapabilities,
  parseOpenMeteoCompatibilityOrigin,
  providerRequestBudgetMilliseconds,
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

// create an unambiguous UTC archive payload
async function utcArchiveFixture(start, hours) {
  const payload = await fixture("archive-fall-back.json");
  const startMilliseconds = Date.parse(start);

  // create one continuous UTC series
  const times = Array.from({ length: hours }, (_unused, index) =>
    new Date(startMilliseconds + index * 3_600_000).toISOString().slice(0, 16),
  );
  // repeat complete metric samples
  const repeat = (values) =>
    Array.from({ length: hours }, (_unused, index) => values[index % values.length]);

  payload.hourly = {
    apparent_temperature: repeat(payload.hourly.apparent_temperature),
    cloud_cover: repeat(payload.hourly.cloud_cover),
    precipitation: repeat(payload.hourly.precipitation),
    relative_humidity_2m: repeat(payload.hourly.relative_humidity_2m),
    surface_pressure: repeat(payload.hourly.surface_pressure),
    temperature_2m: repeat(payload.hourly.temperature_2m),
    time: times,
    wind_direction_10m: repeat(payload.hourly.wind_direction_10m),
    wind_gusts_10m: repeat(payload.hourly.wind_gusts_10m),
    wind_speed_10m: repeat(payload.hourly.wind_speed_10m),
  };
  payload.timezone = "UTC";
  payload.timezone_abbreviation = "UTC";
  payload.utc_offset_seconds = 0;
  return payload;
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
  assert.equal(plan.url.searchParams.get("end_date"), "2026-08-04");
  assert.equal(plan.url.searchParams.get("timezone"), "UTC");
});

test("hourly forecast uses ten weather days and the complete air-quality horizon", () => {
  const weatherPlan = buildOpenMeteoForecastRequest(location);
  const airQualityPlan = buildOpenMeteoAirQualityForecastRequest(location);

  assert.equal(weatherPlan.capability, "forecast");
  assert.equal(weatherPlan.sourceKind, "forecast");
  assert.equal(weatherPlan.adapterVersion, "open-meteo-forecast-daily/v4");
  assert.equal(
    weatherPlan.url.origin + weatherPlan.url.pathname,
    "https://api.open-meteo.com/v1/forecast",
  );
  assert.match(weatherPlan.url.searchParams.get("hourly"), /temperature_2m/u);
  assert.match(weatherPlan.url.searchParams.get("hourly"), /uv_index/u);
  assert.equal(weatherPlan.url.searchParams.get("forecast_days"), "10");
  assert.equal(weatherPlan.url.searchParams.get("forecast_hours"), null);
  assert.equal(weatherPlan.url.searchParams.get("timezone"), "America/Los_Angeles");
  assert.equal(
    airQualityPlan.url.origin + airQualityPlan.url.pathname,
    "https://air-quality-api.open-meteo.com/v1/air-quality",
  );
  assert.equal(airQualityPlan.url.searchParams.get("hourly"), "pm2_5");
  assert.equal(airQualityPlan.url.searchParams.get("forecast_days"), "7");
  assert.equal(airQualityPlan.url.searchParams.get("forecast_hours"), null);
  assert.equal(airQualityPlan.url.searchParams.get("timezone"), "America/Los_Angeles");
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

// collapse Open-Meteo's duplicate north direction
test("Open-Meteo wind direction 360 normalizes to zero", async () => {
  const payload = await fixture("current.json");
  payload.current.wind_direction_10m = 360;

  const record = normalizeCurrentPayload(payload, location.sourceId, receivedAt);

  assert.equal(record.metrics.windDirectionDegrees, 0);
});

// preserve exact hourly coverage across DST changes
test("archive operations query UTC and filter exact local calendar days", async () => {
  const operation = createOpenMeteoHistoricalOperation("http://provider-stub:8080");
  const spring = await operation(
    { ...location, endDate: "2019-03-10", startDate: "2019-03-10" },
    {
      fetch: async () =>
        new Response(JSON.stringify(await utcArchiveFixture("2019-03-10T00:00:00Z", 48))),
      now: () => new Date(receivedAt),
    },
  );
  const fall = await operation(
    { ...location, endDate: "2019-11-03", startDate: "2019-11-03" },
    {
      fetch: async () =>
        new Response(JSON.stringify(await utcArchiveFixture("2019-11-03T00:00:00Z", 48))),
      now: () => new Date(receivedAt),
    },
  );

  assert.equal(spring.records.length, 23);
  assert.equal(spring.records[0].validAt, "2019-03-10T08:00:00.000Z");
  assert.equal(spring.records.at(-1).validAt, "2019-03-11T06:00:00.000Z");
  assert.equal(fall.records.length, 25);
  assert.equal(fall.records[0].validAt, "2019-11-03T07:00:00.000Z");
  assert.equal(fall.records.at(-1).validAt, "2019-11-04T07:00:00.000Z");
});

// prove the first repeated hour follows the provider offset
test("current fall-back time honors the daylight offset", async () => {
  const payload = await fixture("current.json");
  payload.current.time = "2026-11-01T01:30";
  payload.utc_offset_seconds = -25_200;

  const record = normalizeCurrentPayload(payload, location.sourceId, receivedAt);

  assert.equal(record.validAt, "2026-11-01T08:30:00.000Z");
});

// prove the second repeated hour follows the provider offset
test("current fall-back time honors the standard offset", async () => {
  const payload = await fixture("current.json");
  payload.current.time = "2026-11-01T01:30";
  payload.utc_offset_seconds = -28_800;

  const record = normalizeCurrentPayload(payload, location.sourceId, receivedAt);

  assert.equal(record.validAt, "2026-11-01T09:30:00.000Z");
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

test("hourly forecast normalization retains product identity", async () => {
  const weather = await fixture("forecast.json");
  const airQuality = await fixture("air-quality.json");
  const records = normalizeForecastPayload(
    weather,
    airQuality,
    "source-forecast",
    receivedAt,
  );

  assert.equal(records.length, 3);
  assert.equal(records[0].sourceKind, "forecast");
  assert.equal(records[0].productRunAt, receivedAt);
  assert.equal(records[0].validAt, "2026-08-22T05:00:00.000Z");
  assert.equal(records.at(-1).validAt, "2026-08-22T07:00:00.000Z");
  assert.equal(records[0].metrics.precipitationRateMmPerHour, 0.1);
  assert.equal(records[0].metrics.uvIndex, 0.2);
  assert.equal(records[0].metrics.pm25MicrogramsPerCubicMeter, 5);
  assert.equal(records[1].metrics.pm25MicrogramsPerCubicMeter, 8);
  assert.equal(records[2].metrics.pm25MicrogramsPerCubicMeter, 12);
});

// prove paired requests run together and retain combined provenance
test("forecast fetch combines weather and air-quality products", async () => {
  const weather = await fixture("forecast.json");
  const airQuality = await fixture("air-quality.json");
  const requests = [];
  let active = 0;
  let maximumActive = 0;
  const responseChecksums = [];
  const injectedFetch = async (url) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    requests.push(String(url));
    const payload = new URL(url).pathname === "/v1/air-quality"
      ? airQuality
      : weather;
    const body = JSON.stringify(payload);
    responseChecksums.push(
      createHash("sha256").update(body).digest("hex"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return new Response(body, { status: 200 });
  };
  const batch = await fetchOpenMeteoForecast(location, {
    fetch: injectedFetch,
    now: () => new Date(receivedAt),
  });
  const checksum = createHash("sha256");

  // retain request-order checksum boundaries
  for (const responseChecksum of responseChecksums) {
    checksum.update(`${responseChecksum}\n`);
  }

  assert.equal(maximumActive, 2);
  assert.equal(requests.length, 2);
  assert.equal(batch.attempts, 2);
  assert.equal(batch.checksum, checksum.digest("hex"));
  assert.equal(batch.records.length, 3);
  assert.deepEqual(batch.responseMetadata, {
    air_quality_generation_ms: 0.08,
    air_quality_http_status: 200,
    http_status: 200,
    upstream_response_count: 2,
    weather_generation_ms: 0.12,
  });
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

// prove the request deadline covers response consumption
test("provider timeout cancels a stalled response body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    // retain an incomplete JSON body
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
    },
    // observe reader cancellation
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () => new Response(body, { status: 200 }),
      maxAttempts: 1,
      timeoutMs: 5,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_unavailable",
  );
  assert.equal(cancelled, true);
});

// prove cleanup cannot extend the response deadline
test("provider timeout does not await stalled stream cancellation", async () => {
  let cancelCalled = false;
  const body = new ReadableStream({
    // retain an incomplete body
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    // simulate a cleanup implementation that never settles
    cancel() {
      cancelCalled = true;
      return new Promise(() => {});
    },
  });
  const outcome = await Promise.race([
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () => new Response(body, { status: 200 }),
      maxAttempts: 1,
      timeoutMs: 5,
    }).catch((error) => error),
    new Promise((resolve) => {
      setTimeout(() => resolve("still-pending"), 100);
    }),
  ]);

  assert.notEqual(outcome, "still-pending");
  assert.equal(cancelCalled, true);
});

// prove declared oversize bodies are cancelled before reads
test("provider cancels an honestly declared oversized body", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    // retain a body that should never be read
    start() {},
    // observe pre-read cancellation
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () =>
        new Response(body, {
          headers: { "content-length": "100" },
          status: 200,
        }),
      maxAttempts: 1,
      maxBodyBytes: 8,
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_response_too_large",
  );
  assert.equal(cancelled, true);
});

// prove response bodies cannot exceed the configured byte ceiling
test("provider rejects oversized response bodies before parsing", async () => {
  // enforce the stream limit for both success and error responses
  for (const status of [200, 400]) {
    await assert.rejects(
      fetchJsonWithRetry(new URL("https://example.test/weather"), {
        fetch: async () =>
          new Response('{"payload":"too-large"}', {
            headers: { "content-length": "1" },
            status,
          }),
        maxAttempts: 1,
        maxBodyBytes: 8,
      }),
      (error) =>
        error instanceof ProviderFailure &&
        error.ingestionError.classification === "invalid_payload" &&
        error.ingestionError.code === "provider_response_too_large",
    );
  }
});

// prove the durable run budget covers every bounded retry phase
test("provider request budget includes attempts and maximum retry delays", () => {
  assert.equal(
    providerRequestBudgetMilliseconds({ maxAttempts: 3, timeoutMs: 10_000 }),
    90_000,
  );
});

// stop before a retry delay that would cross the absolute run deadline
test("provider retry sleep respects the persisted run deadline", async () => {
  let sleeps = 0;

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      clock: () => 0,
      deadlineAt: "1970-01-01T00:00:01.000Z",
      fetch: async () =>
        new Response('{"reason":"slow down"}', {
          headers: { "retry-after": "30" },
          status: 429,
        }),
      sleep: async () => {
        sleeps += 1;
      },
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "provider_deadline_exceeded",
  );
  assert.equal(sleeps, 0);
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

// prove persisted provider reasons never retain credential-shaped values
test("provider response reasons are bounded and redacted", async () => {
  const reason = [
    "api_key=provider-secret",
    "api key: spaced-provider-secret",
    "Authorization: Basic authorization-secret",
    "Bearer bearer-secret",
    "postgresql://worker:database-secret@database/weather",
    'token="alpha-secret,beta-secret"',
    "password=gamma-secret;delta-secret",
  ].join(" ");

  await assert.rejects(
    fetchJsonWithRetry(new URL("https://example.test/weather"), {
      fetch: async () =>
        new Response(JSON.stringify({ error: true, reason }), { status: 400 }),
      maxAttempts: 1,
    }),
    (error) => {
      // inspect the persistence-facing diagnosis
      if (!(error instanceof ProviderFailure)) {
        return false;
      }

      assert.match(error.ingestionError.message, /\[redacted\]/u);
      assert.doesNotMatch(error.ingestionError.message, /provider-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /spaced-provider-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /authorization-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /bearer-secret/u);
      assert.doesNotMatch(error.ingestionError.message, /database-secret/u);
      assert.doesNotMatch(
        error.ingestionError.message,
        /alpha-secret|beta-secret|gamma-secret|delta-secret/u,
      );
      assert.ok(error.ingestionError.message.length <= 512);
      return true;
    },
  );
});

// prove capability boundary stays narrow
test("U-OM-10 capability report is exact", () => {
  assert.deepEqual(openMeteoCapabilities(), ["current", "historical", "forecast"]);
});

// prove executable operations and safe endpoint selection
test("Open-Meteo operations default official and allow a safe compatibility origin", async () => {
  const current = await fixture("current.json");
  const archive = await fixture("archive-fall-back.json");
  const forecast = await fixture("forecast.json");
  const airQuality = await fixture("air-quality.json");
  const requests = [];
  const currentOperation = createOpenMeteoCurrentOperation();
  const forecastOperation = createOpenMeteoForecastOperation(
    "http://provider-stub:8080",
  );
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
  await forecastOperation(location, {
    fetch: async (url) => {
      requests.push(String(url));
      const payload = new URL(url).pathname === "/v1/air-quality"
        ? airQuality
        : forecast;
      return new Response(JSON.stringify(payload), { status: 200 });
    },
    now: () => new Date(receivedAt),
  });

  assert.equal(new URL(requests[0]).origin, "https://api.open-meteo.com");
  assert.equal(
    new URL(requests[1]).origin + new URL(requests[1]).pathname,
    "http://provider-stub:8080/v1/archive",
  );
  assert.deepEqual(
    requests.slice(2).map((request) => new URL(request).pathname).sort(),
    ["/v1/air-quality", "/v1/forecast"],
  );
  assert.ok(
    requests.slice(2).every(
      (request) => new URL(request).origin === "http://provider-stub:8080",
    ),
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
