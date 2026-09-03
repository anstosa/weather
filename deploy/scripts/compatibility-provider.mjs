import { createServer } from "node:http";

const metricUnits = {
  apparent_temperature: "°C",
  cloud_cover: "%",
  precipitation: "mm",
  relative_humidity_2m: "%",
  surface_pressure: "hPa",
  temperature_2m: "°C",
  time: "iso8601",
  wind_direction_10m: "°",
  wind_gusts_10m: "m/s",
  wind_speed_10m: "m/s",
};
const forecastBase = new Date();
forecastBase.setUTCMinutes(0, 0, 0);
const dynamicForecastTimes = [
  forecastBase.toISOString().slice(0, 16),
  new Date(forecastBase.getTime() + 3_600_000).toISOString().slice(0, 16),
  new Date(forecastBase.getTime() + 7_200_000).toISOString().slice(0, 16),
];

// keep normal fixtures fixed while compatibility reads track the runtime day
const forecastTimes = process.env.WEATHER_COMPATIBILITY_DYNAMIC_FORECAST === "1"
  ? dynamicForecastTimes
  : ["2026-08-22T05:00", "2026-08-22T06:00", "2026-08-22T07:00"];
const currentPayload = {
  current: {
    apparent_temperature: 11.8,
    cloud_cover: 35,
    interval: 900,
    precipitation: 0,
    relative_humidity_2m: 72,
    surface_pressure: 1015.4,
    temperature_2m: 12.4,
    time: "2026-08-22T06:30",
    wind_direction_10m: 240,
    wind_gusts_10m: 4.6,
    wind_speed_10m: 2.8,
  },
  current_units: { ...metricUnits, interval: "seconds" },
  elevation: 32,
  generationtime_ms: 0,
  latitude: 47.95043,
  longitude: -122.42797,
  timezone: "America/Los_Angeles",
  timezone_abbreviation: "GMT-7",
  utc_offset_seconds: -25_200,
};
const archivePayload = {
  elevation: 32,
  generationtime_ms: 0,
  hourly: {
    apparent_temperature: [10.2, 10.8],
    cloud_cover: [40, 35],
    precipitation: [0, 0],
    relative_humidity_2m: [76, 72],
    surface_pressure: [1015.1, 1015.4],
    temperature_2m: [10.9, 11.5],
    time: ["2026-08-22T05:00", "2026-08-22T06:00"],
    wind_direction_10m: [235, 240],
    wind_gusts_10m: [4.2, 4.6],
    wind_speed_10m: [2.5, 2.8],
  },
  hourly_units: metricUnits,
  latitude: 47.95043,
  longitude: -122.42797,
  timezone: "America/Los_Angeles",
  timezone_abbreviation: "GMT-7",
  utc_offset_seconds: -25_200,
};
const forecastPayload = {
  elevation: 32,
  generationtime_ms: 0,
  hourly: {
    apparent_temperature: [11.7, 12.4, 13.1],
    cloud_cover: [72, 68, 61],
    precipitation: [0.1, 0.2, 0.3],
    relative_humidity_2m: [83, 80, 77],
    surface_pressure: [1018.1, 1018.3, 1018.5],
    temperature_2m: [12.1, 12.8, 13.4],
    time: forecastTimes,
    uv_index: [0.2, 0.5, 0.9],
    wind_direction_10m: [180, 185, 190],
    wind_gusts_10m: [3.1, 3.6, 4.2],
    wind_speed_10m: [1.8, 2.1, 2.4],
  },
  hourly_units: { ...metricUnits, uv_index: "" },
  latitude: 47.95043,
  longitude: -122.42797,
  timezone: "GMT",
  timezone_abbreviation: "GMT",
  utc_offset_seconds: 0,
};
const airQualityPayload = {
  generationtime_ms: 0,
  hourly: {
    pm2_5: [5, 8, 12],
    time: forecastTimes,
  },
  hourly_units: { pm2_5: "μg/m³", time: "iso8601" },
  latitude: 47.95043,
  longitude: -122.42797,
  timezone: "GMT",
  timezone_abbreviation: "GMT",
  utc_offset_seconds: 0,
};
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3002");

// reject invalid listener configuration
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new RangeError("PORT must be between 1 and 65535");
}

// send one deterministic response
function sendJson(request, response, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(body.byteLength),
    "Content-Type": "application/json; charset=utf-8",
  });

  // omit head response bodies
  if (request.method === "HEAD") {
    response.end();
  } else {
    response.end(body);
  }
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://compatibility.invalid");

  // keep the stub read-only
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(request, response, 405, { error: "method_not_allowed" });
    return;
  }

  // expose a bounded readiness probe
  if (url.pathname === "/health") {
    sendJson(request, response, 200, { status: "ok" });
    return;
  }

  // serve the selected weather fixture
  if (url.pathname === "/v1/forecast") {
    sendJson(
      request,
      response,
      200,
      url.searchParams.has("hourly") ? forecastPayload : currentPayload,
    );
    return;
  }

  // serve the air-quality forecast fixture
  if (url.pathname === "/v1/air-quality") {
    sendJson(request, response, 200, airQualityPayload);
    return;
  }

  // serve the archive fixture
  if (url.pathname === "/v1/archive") {
    sendJson(request, response, 200, archivePayload);
    return;
  }

  sendJson(request, response, 404, { error: "not_found" });
});

server.listen(port, host);

// stop without accepting new work
async function shutdown() {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      // surface close failures
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
