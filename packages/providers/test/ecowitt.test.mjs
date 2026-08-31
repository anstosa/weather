import assert from "node:assert/strict";
import test from "node:test";

import {
  ProviderFailure,
  buildEcowittLiveRequest,
  fetchEcowittLive,
  normalizeEcowittLivePayload,
} from "../dist/index.js";

const receivedAt = "2026-08-29T14:00:00.000Z";
const request = {
  expectedMac: "88:F1:55:05:D8:9F",
  gatewayHost: "192.168.11.137",
  model: "GW3000",
  previousCursor: null,
  sourceId: "source-ecowitt",
  timezone: "America/Los_Angeles",
};
const livePayload = {
  ch_aisle: [
    { battery: "0", channel: "1", humidity: "65%", name: "", temp: "68.0", unit: "F" },
  ],
  ch_ec: [
    {
      battery: "5",
      channel: "1",
      ec: "10 uS/cm",
      humidity: "42%",
      name: "",
      temp: "63.9",
      unit: "F",
    },
  ],
  ch_pm25: [
    { PM25: "12.4", channel: "1" },
  ],
  common_list: [
    { id: "0x02", unit: "F", val: "54.3" },
    { id: "0x07", val: "96%" },
    { id: "3", unit: "F", val: "53.6" },
    { id: "0xA1", unit: "F", val: "54.3" },
    { id: "0xA2", unit: "F", val: "53.6" },
    { id: "0x0B", val: "5.00 mph" },
    { id: "0x0C", val: "10.00 mph" },
    { id: "0x15", val: "21.94 W/m2" },
    { id: "0x17", val: "2" },
    { id: "0x0A", val: "47" },
  ],
  piezoRain: [
    { id: "0x0E", val: "0.02 in/Hr" },
    { id: "0x10", val: "0.15 in" },
  ],
  wh25: [
    { abs: "29.80 inHg", inhumi: "70%", intemp: "65.3", rel: "29.88 inHg", unit: "F" },
  ],
};

// create deterministic local HTTP responses
function responseFetcher(networkPayload = { mac: request.expectedMac }) {
  return async (input) => {
    const url = new URL(String(input));

    // return the configured gateway identity
    if (url.pathname === "/get_network_info") {
      return Response.json(networkPayload);
    }

    // return one live gateway snapshot
    if (url.pathname === "/get_livedata_info") {
      return Response.json(livePayload);
    }

    return new Response("not found", { status: 404 });
  };
}

// constrain the adapter to the configured private gateway
test("Ecowitt request targets the LAN live-data endpoint", () => {
  const plan = buildEcowittLiveRequest(request);

  assert.equal(plan.adapterVersion, "ecowitt-local-live/v1");
  assert.equal(plan.capability, "current");
  assert.equal(plan.sourceKind, "physical_sensor");
  assert.equal(plan.url.href, "http://192.168.11.137/get_livedata_info");
  assert.throws(
    () => buildEcowittLiveRequest({ ...request, gatewayHost: "weather.example" }),
    /private IPv4/u,
  );
});

// normalize the installed gateway's unique measurement set
test("Ecowitt live payload normalizes core, heat, air, and soil measurements", () => {
  const record = normalizeEcowittLivePayload(livePayload, request, receivedAt);

  assert.equal(record.validAt, receivedAt);
  assert.equal(record.sourceKind, "physical_sensor");
  assert.ok(Math.abs(record.metrics.temperatureC - 12.38888888888889) < 1e-12);
  assert.ok(Math.abs(record.metrics.apparentTemperatureC - 12) < 1e-12);
  assert.equal(record.metrics.relativeHumidityPercent, 96);
  assert.ok(Math.abs(record.metrics.pressureHpa - 1011.8529336009959) < 1e-9);
  assert.ok(Math.abs(record.metrics.windSpeedMps - 2.2352) < 1e-12);
  assert.ok(Math.abs(record.metrics.windGustMps - 4.4704) < 1e-12);
  assert.equal(record.metrics.windDirectionDegrees, 47);
  assert.ok(Math.abs(record.metrics.precipitationMm - 3.81) < 1e-12);
  assert.ok(
    Math.abs(record.metrics.precipitationRateMmPerHour - 0.508) < 1e-12,
  );
  assert.ok(
    Math.abs(record.metrics.blackGlobeTemperatureC - 12.38888888888889) < 1e-12,
  );
  assert.ok(Math.abs(record.metrics.wetBulbGlobeTemperatureC - 12) < 1e-12);
  assert.equal(record.metrics.solarRadiationWm2, 21.94);
  assert.equal(record.metrics.uvIndex, 2);
  assert.equal(record.metrics.pm25MicrogramsPerCubicMeter, 12.4);
  assert.equal(record.metrics.soilMoisturePercent, 42);
  assert.equal(record.metrics.soilElectricalConductivityMicrosiemensPerCm, 10);
  assert.deepEqual(record.metadata.device, {
    model: "GW3000",
    serial: "88:F1:55:05:D8:9F",
    vendor: "Ecowitt",
  });
  assert.deepEqual(record.metadata.provider.property_sensors, [
    {
      channel: null,
      key: "gateway",
      model: "GW3000",
      readings: {
        pressureHpa: record.metrics.pressureHpa,
        relativeHumidityPercent: 70,
        temperatureC: 18.5,
      },
    },
    {
      channel: null,
      key: "weather-array",
      model: "WS90",
      readings: {
        dailyPrecipitationMm: record.metrics.precipitationMm,
        precipitationRateMmPerHour: 0.508,
        relativeHumidityPercent: 96,
        solarRadiationWm2: 21.94,
        temperatureC: record.metrics.temperatureC,
        uvIndex: 2,
        windDirectionDegrees: 47,
        windGustMps: record.metrics.windGustMps,
        windSpeedMps: record.metrics.windSpeedMps,
      },
    },
    {
      channel: null,
      key: "black-globe",
      model: "WN38",
      readings: {
        blackGlobeTemperatureC: record.metrics.blackGlobeTemperatureC,
        wetBulbGlobeTemperatureC: record.metrics.wetBulbGlobeTemperatureC,
      },
    },
    {
      channel: 1,
      key: "temperature-1",
      model: "WN31",
      readings: {
        relativeHumidityPercent: 65,
        temperatureC: 20,
      },
    },
    {
      channel: 1,
      key: "soil-1",
      model: "WH52",
      readings: {
        soilElectricalConductivityMicrosiemensPerCm: 10,
        soilMoisturePercent: 42,
        temperatureC: 17.72222222222222,
      },
    },
    {
      channel: 1,
      key: "air-quality-1",
      model: "WH41",
      readings: { pm25MicrogramsPerCubicMeter: 12.4 },
    },
  ]);
});

// retain interval rain without summing the gateway's daily total repeatedly
test("Ecowitt rain cursor stores only the daily-counter delta", () => {
  const record = normalizeEcowittLivePayload(
    livePayload,
    {
      ...request,
      previousCursor: {
        rain_daily_total_mm: 2.54,
        rain_day: "2026-08-29",
      },
    },
    receivedAt,
  );
  const reset = normalizeEcowittLivePayload(
    livePayload,
    {
      ...request,
      previousCursor: {
        rain_daily_total_mm: 5,
        rain_day: "2026-08-29",
      },
    },
    receivedAt,
  );

  assert.ok(Math.abs(record.metrics.precipitationMm - 1.27) < 1e-9);
  assert.equal(reset.metrics.precipitationMm, null);
});

// verify gateway identity before accepting local data
test("Ecowitt fetch binds snapshots to the configured MAC", async () => {
  const batch = await fetchEcowittLive(request, {
    fetch: responseFetcher(),
    maxAttempts: 1,
    now: () => new Date(receivedAt),
  });

  assert.equal(batch.attempts, 2);
  assert.equal(batch.records.length, 1);
  assert.equal(batch.providerCursor.rain_day, "2026-08-29");
  assert.ok(Math.abs(batch.providerCursor.rain_daily_total_mm - 3.81) < 1e-12);
  assert.equal(batch.responseMetadata.rain_gauge, "piezo");
  assert.equal(batch.responseMetadata.soil_channel_count, 1);
  await assert.rejects(
    fetchEcowittLive(request, {
      fetch: responseFetcher({ mac: "00:11:22:33:44:55" }),
      maxAttempts: 1,
      now: () => new Date(receivedAt),
    }),
    (error) =>
      error instanceof ProviderFailure &&
      error.ingestionError.code === "ecowitt_invalid_payload",
  );
});
