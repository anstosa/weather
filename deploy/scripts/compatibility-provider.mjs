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

  // serve the current fixture
  if (url.pathname === "/v1/forecast") {
    sendJson(request, response, 200, currentPayload);
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
