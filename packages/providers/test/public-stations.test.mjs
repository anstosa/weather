import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAmbientWeatherRequest,
  buildPurpleAirHistoryRequest,
  fetchPublicStationRange,
  normalizeAmbientWeatherPayload,
  normalizeNetatmoPayloads,
  normalizePurpleAirCsv,
  normalizeWeatherUndergroundPayloads,
} from "../dist/index.js";

const common = {
  endExclusive: "2026-08-24T14:00:00.000Z",
  model: "test-model",
  serial: "test-serial",
  sourceId: "source-public",
  start: "2026-08-24T13:00:00.000Z",
  timezone: "America/Los_Angeles",
};

const ambient = {
  ...common,
  adapter: "ambient-weather",
  deviceId: "5fe7d16a25083b000171f8e5",
  macAddress: "F0:08:D1:07:B3:9E",
};

const wunderground = {
  ...common,
  adapter: "weather-underground",
  publicApiKey: "e1f10a1e78da46f5b10a1e78da96f525",
  stationId: "KWACLINT112",
};

const netatmo = {
  ...common,
  adapter: "netatmo",
  deviceId: "70:ee:50:71:3f:c4",
  outdoorModuleId: "02:00:00:69:34:4e",
  rainModuleId: "05:00:00:08:97:7e",
  windModuleId: "06:00:00:06:45:7c",
};

const purpleAir = {
  ...common,
  adapter: "purpleair",
  mapVersion: "3.2.3",
  sensorIndex: 32489,
};

test("Ambient public data retains every in-window observation", () => {
  const url = buildAmbientWeatherRequest(ambient);
  assert.equal(url.searchParams.get("macAddress"), ambient.macAddress);
  assert.equal(url.searchParams.get("start"), "1787576400000");
  assert.equal(url.searchParams.get("end"), "1787579999999");

  const records = normalizeAmbientWeatherPayload(
    {
      data: [
        {
          baromrelin: 30,
          dateutc: 1787576400000,
          deviceId: ambient.deviceId,
          feelsLike: 54,
          hourlyrainin: 0.1,
          humidity: 90,
          solarradiation: 100,
          tempf: 53.6,
          uv: 1,
          winddir: 360,
          windgustmph: 10,
          windspeedmph: 5,
        },
        {
          dateutc: 1787580000000,
          deviceId: ambient.deviceId,
        },
      ],
    },
    ambient,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].validAt, common.start);
  assert.ok(Math.abs(records[0].metrics.temperatureC - 12) < 1e-9);
  assert.equal(records[0].metrics.precipitationRateMmPerHour, 2.54);
  assert.equal(records[0].metrics.windDirectionDegrees, 0);
  assert.equal(records[0].metrics.windSpeedMps, 2.2352);
  assert.equal(records[0].metadata.provider.device_id, ambient.deviceId);
});

// accept legacy rows scoped only by the requested MAC
test("Ambient public data accepts a missing legacy device identity", () => {
  const records = normalizeAmbientWeatherPayload(
    {
      data: [{ dateutc: 1787576400000, feelsLike: 180, tempf: 53.6 }],
    },
    ambient,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(records.length, 1);
  assert.ok(Math.abs(records[0].metrics.temperatureC - 12) < 1e-9);
  assert.equal(records[0].metrics.apparentTemperatureC, null);
});

// reject a conflicting optional device identity
test("Ambient public data rejects a conflicting device identity", () => {
  assert.throws(
    () =>
      normalizeAmbientWeatherPayload(
        {
          data: [{ dateutc: 1787576400000, deviceId: "another-device" }],
        },
        ambient,
        "2026-08-24T15:00:00.000Z",
      ),
    /Ambient response device identity is invalid/u,
  );
});

test("Weather Underground merges local days into one UTC range", () => {
  const row = (epoch, temperature) => ({
    epoch,
    humidityAvg: 85,
    metric: {
      precipRate: 0.2,
      pressureMax: 1020,
      pressureMin: 1019,
      tempAvg: temperature,
      windgustHigh: 18,
      windspeedAvg: 9,
    },
    qcStatus: 1,
    solarRadiationHigh: 50,
    stationID: wunderground.stationId,
    uvHigh: 2,
    winddirAvg: 180,
  });
  const records = normalizeWeatherUndergroundPayloads(
    [
      { observations: [row(1787576399, 10), row(1787576400, 11)] },
      { observations: [row(1787579999, 12), row(1787580000, 13)] },
    ],
    wunderground,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(records.length, 2);
  assert.equal(records[0].metrics.temperatureC, 11);
  assert.equal(records[1].metrics.windSpeedMps, 2.5);
  assert.equal(records[1].metrics.relativeHumidityPercent, 85);
  assert.equal(records[1].metadata.quality.status, "provider_qc_1");
});

test("Netatmo module series merge into five-minute normalized points", () => {
  const payload = (body) => ({ body, status: "ok" });
  const records = normalizeNetatmoPayloads(
    [
      payload({ "1787576617": [12.7, 96] }),
      payload({ "1787576661": [1018.5] }),
      payload({ "1787576655": [0.2] }),
      payload({ "1787576655": [3, -1, 5, 15] }),
    ],
    netatmo,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].validAt, "2026-08-24T13:04:21.000Z");
  assert.equal(records[0].metrics.temperatureC, 12.7);
  assert.equal(records[0].metrics.precipitationMm, 0.2);
  assert.equal(records[0].metrics.windSpeedMps, 3 / 3.6);
  assert.equal(records[0].metrics.windDirectionDegrees, null);
  assert.equal(records[0].metrics.windGustMps, 5 / 3.6);
});

// preserve observations when optional module archives are empty
test("Netatmo accepts empty public module archive gaps", () => {
  const payload = (body) => ({ body, status: "ok" });
  const records = normalizeNetatmoPayloads(
    [
      payload({ "1787576617": [12.7, 96] }),
      payload({}),
      payload([]),
      payload(null),
    ],
    netatmo,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].metrics.temperatureC, 12.7);
  assert.equal(records[0].metrics.pressureHpa, null);
  assert.equal(records[0].metrics.precipitationMm, null);
  assert.equal(records[0].metrics.windSpeedMps, null);
});

test("Netatmo operation uses a visitor token only in authorization", async () => {
  const requests = [];
  const payloads = [
    { body: "visitor-token" },
    { body: { "1787576617": [12.7, 96] }, status: "ok" },
    { body: { "1787576661": [1018.5] }, status: "ok" },
    { body: { "1787576655": [0.2] }, status: "ok" },
    { body: { "1787576655": [3, 1, 5, 15] }, status: "ok" },
  ];
  const batch = await fetchPublicStationRange(netatmo, {
    fetch: async (url, initialization) => {
      requests.push({ initialization, url: String(url) });
      return new Response(JSON.stringify(payloads.shift()), { status: 200 });
    },
    now: () => new Date("2026-08-24T15:00:00.000Z"),
  });

  assert.equal(requests.length, 5);
  assert.equal(requests[0].initialization.method, "GET");
  assert.equal(new Headers(requests[0].initialization.headers).get("authorization"), null);
  assert.equal(requests[1].initialization.method, "POST");
  assert.equal(
    new Headers(requests[1].initialization.headers).get("authorization"),
    "Bearer visitor-token",
  );
  assert.equal(batch.records.length, 1);
  assert.equal(batch.attempts, 5);
});

test("PurpleAir public history retains every dual-channel observation", () => {
  const url = buildPurpleAirHistoryRequest(purpleAir);
  assert.equal(url.pathname, "/v1/sensors/32489/history/csv");
  assert.equal(url.searchParams.get("average"), "0");
  assert.equal(
    url.searchParams.get("fields"),
    "humidity_a,humidity_b,pm2.5_atm_a,pm2.5_atm_b,pressure_a,pressure_b,temperature_a,temperature_b",
  );
  const records = normalizePurpleAirCsv(
    [
      "time_stamp,sensor_index,humidity_a,humidity_b,pm2.5_atm_a,pm2.5_atm_b,pressure_a,pressure_b,temperature_a,temperature_b",
      "2026-08-24T13:00:00Z,32489,50,52,10,12,1000,1002,68,null",
      "2026-08-24T14:00:00Z,32489,49,51,9,11,1001,1003,70,null",
    ].join("\n"),
    purpleAir,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(records.length, 1);
  assert.equal(records[0].validAt, common.start);
  assert.equal(records[0].metrics.pm25MicrogramsPerCubicMeter, 11);
  assert.equal(records[0].metrics.relativeHumidityPercent, 51);
  assert.equal(records[0].metrics.pressureHpa, 1001);
  assert.ok(Math.abs(records[0].metrics.temperatureC - 20) < 1e-9);
  assert.deepEqual(records[0].metadata.quality.flags, [
    "dual_channel_average",
    "uncorrected_sensor_enclosure_temperature",
  ]);
});

test("PurpleAir history flags only an out-of-range particulate value", () => {
  const [record] = normalizePurpleAirCsv(
    [
      "time_stamp,sensor_index,humidity_a,humidity_b,pm2.5_atm_a,pm2.5_atm_b,pressure_a,pressure_b,temperature_a,temperature_b",
      "2026-08-24T13:00:00Z,32489,50,52,999.3,1001.9,1000,1002,68,null",
    ].join("\n"),
    purpleAir,
    "2026-08-24T15:00:00.000Z",
  );

  assert.equal(record.metrics.pm25MicrogramsPerCubicMeter, null);
  assert.equal(record.metrics.relativeHumidityPercent, 51);
  assert.equal(record.metrics.pressureHpa, 1001);
  assert.ok(Math.abs(record.metrics.temperatureC - 20) < 1e-9);
  assert.deepEqual(record.metadata.quality.flags, [
    "dual_channel_average",
    "uncorrected_sensor_enclosure_temperature",
    "pm25_out_of_range",
  ]);
});

test("PurpleAir operation obtains a scoped map token before CSV history", async () => {
  const requests = [];
  const token = "a".repeat(80);
  const csv = [
    "time_stamp,sensor_index,humidity_a,humidity_b,pm2.5_atm_a,pm2.5_atm_b,pressure_a,pressure_b,temperature_a,temperature_b",
    "2026-08-24T13:00:00Z,32489,50,null,10,12,1000,null,68,null",
  ].join("\n");
  const responses = [token, csv];
  const batch = await fetchPublicStationRange(purpleAir, {
    fetch: async (url, initialization) => {
      requests.push({ initialization, url: String(url) });
      return new Response(responses.shift(), { status: 200 });
    },
    now: () => new Date("2026-08-24T15:00:00.000Z"),
  });

  assert.equal(requests.length, 2);
  assert.equal(new URL(requests[0].url).pathname, "/v1/token");
  assert.equal(
    new Headers(requests[0].initialization.headers).get("origin"),
    "https://map.purpleair.com",
  );
  assert.equal(
    new Headers(requests[1].initialization.headers).get("x-api-token"),
    token,
  );
  assert.equal(batch.records.length, 1);
  assert.equal(batch.attempts, 2);
});
