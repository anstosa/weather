import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenMeteoEcmwfSingleRunRequest,
  fetchOpenMeteoEcmwfSingleRun,
  normalizeOpenMeteoEcmwfSingleRunPayload,
} from "../dist/index.js";

const input = {
  latitude: 47.950429954185445,
  longitude: -122.42797012608193,
  runInitializedAt: "2026-09-07T12:00:00.000Z",
};

// create one exact standard payload
function payload(overrides = {}) {
  const initializedAt = Date.parse(input.runInitializedAt);

  return {
    timezone: "GMT",
    utc_offset_seconds: 0,
    hourly_units: {
      relative_humidity_2m: "%",
      temperature_2m: "°C",
      time: "iso8601",
      wind_speed_10m: "m/s",
    },
    hourly: {
      relative_humidity_2m: Array.from({ length: 19 }, (_, index) => 70 + index),
      temperature_2m: Array.from({ length: 19 }, (_, index) => 10 + index / 10),
      time: Array.from({ length: 19 }, (_, index) =>
        new Date(initializedAt + index * 3_600_000).toISOString().slice(0, 16),
      ),
      wind_speed_10m: Array.from({ length: 19 }, (_, index) => 2 + index / 10),
    },
    ...overrides,
  };
}

test("single-runs request pins the exact ECMWF contract", () => {
  const plan = buildOpenMeteoEcmwfSingleRunRequest(input);

  assert.equal(plan.url.origin, "https://single-runs-api.open-meteo.com");
  assert.equal(plan.url.pathname, "/v1/forecast");
  assert.equal(plan.url.searchParams.get("models"), "ecmwf_ifs");
  assert.equal(plan.url.searchParams.get("run"), "2026-09-07T12:00");
  assert.equal(plan.url.searchParams.get("forecast_hours"), "19");
  assert.equal(
    plan.url.searchParams.get("hourly"),
    "temperature_2m,relative_humidity_2m,wind_speed_10m",
  );
  assert.equal(plan.url.searchParams.get("timezone"), "UTC");
  assert.equal(plan.url.searchParams.get("wind_speed_unit"), "ms");
});

test("single-runs normalization stores only exact leads one through eighteen", () => {
  const hours = normalizeOpenMeteoEcmwfSingleRunPayload(payload(), input);

  assert.equal(hours.length, 18);
  assert.deepEqual(hours[0], {
    modelLeadHours: 1,
    rawRelativeHumidityPercent: 71,
    rawTemperatureC: 10.1,
    rawWindSpeedMps: 2.1,
    validAt: "2026-09-07T13:00:00.000Z",
  });
  assert.equal(hours.at(-1).modelLeadHours, 18);
  assert.equal(hours.at(-1).validAt, "2026-09-08T06:00:00.000Z");
});

test("single-runs normalization rejects shifted and partial grids", () => {
  const shifted = payload();
  shifted.hourly.time[7] = "2026-09-07T20:00";
  assert.throws(
    () => normalizeOpenMeteoEcmwfSingleRunPayload(shifted, input),
    /time grid/u,
  );

  const partial = payload();
  partial.hourly.temperature_2m.pop();
  assert.throws(
    () => normalizeOpenMeteoEcmwfSingleRunPayload(partial, input),
    /exactly 19/u,
  );
});

test("single-runs normalization rejects nonzero response offsets", () => {
  assert.throws(
    () => normalizeOpenMeteoEcmwfSingleRunPayload(
      payload({ timezone: "America/Los_Angeles", utc_offset_seconds: -25_200 }),
      input,
    ),
    /timezone must be UTC or GMT/u,
  );
});

test("single-runs fetch retains first receipt and response checksum", async () => {
  const responsePayload = payload();
  const batch = await fetchOpenMeteoEcmwfSingleRun(input, {
    fetch: async () => new Response(JSON.stringify(responsePayload), { status: 200 }),
    now: () => new Date("2026-09-07T18:03:04.000Z"),
  });

  assert.equal(batch.receivedAt, "2026-09-07T18:03:04.000Z");
  assert.equal(batch.runInitializedAt, input.runInitializedAt);
  assert.equal(batch.upstreamModel, "ecmwf_ifs");
  assert.equal(batch.modelCycle, "50r1");
  assert.match(batch.providerResponseSha256, /^[a-f0-9]{64}$/u);
});

test("single-runs requests require canonical six-hour initializations", () => {
  assert.throws(
    () => buildOpenMeteoEcmwfSingleRunRequest({
      ...input,
      runInitializedAt: "2026-09-07T15:00:00.000Z",
    }),
    /00\/06\/12\/18/u,
  );
});
