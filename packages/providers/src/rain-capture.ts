import { createHash } from "node:crypto";

import {
  RAIN_COLLECTION_POLICY,
  RAIN_COLLECTION_STATIONS,
  type RainCaptureReceipt,
  type RainCaptureRequest,
} from "@weather/domain";

import {
  buildTempestObservationRequest,
  normalizeTempestObservationPayload,
} from "./tempest.js";

const FORECAST_ENDPOINT = "https://single-runs-api.open-meteo.com/v1/forecast";
const FORECAST_VARIABLES = [
  "temperature_2m",
  "relative_humidity_2m",
  "wind_speed_10m",
  "precipitation",
  "surface_pressure",
  "cloud_cover",
  "wind_direction_10m",
] as const;
const FORECAST_UNITS = {
  time: "iso8601",
  temperature_2m: "°C",
  relative_humidity_2m: "%",
  wind_speed_10m: "m/s",
  precipitation: "mm",
  surface_pressure: "hPa",
  cloud_cover: "%",
  wind_direction_10m: "°",
} as const;
const FORECAST_BOUNDS = {
  temperature_2m: [-100, 70],
  relative_humidity_2m: [0, 100],
  wind_speed_10m: [0, 150],
  precipitation: [0, 2000],
  surface_pressure: [100, 1200],
  cloud_cover: [0, 100],
  wind_direction_10m: [0, 360],
} as const;
const HOUR_MS = 3_600_000;
const EXPECTED_GRID = { latitude: 47.97891, longitude: -122.44185 } as const;
const GRID_TOLERANCE = 0.00001;

type CaptureOptions = Readonly<{
  apiKey?: string;
  fetch?: typeof fetch;
  now?: () => Date;
}>;

// require one record-shaped JSON value
function object(value: unknown): Record<string, unknown> {
  // reject arrays and null before field checks
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid_payload");
  }
  return value as Record<string, unknown>;
}

// bind the request to an exact UTC instant
function utc(value: string): number {
  // reject noncanonical or invalid dates
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/u.test(value)) {
    throw new RangeError("invalid UTC request instant");
  }
  const epoch = Date.parse(value);
  // reject normalized calendar overflow
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new RangeError("invalid UTC request instant");
  }
  return epoch;
}

// build a separate seven-variable rain request
function forecastUrl(request: Extract<RainCaptureRequest, { kind: "forecast" }>): URL {
  const initialized = utc(request.runInitializedAt);
  const hour = new Date(initialized).getUTCHours();
  // retain only canonical model cycles and attempts
  if (initialized % HOUR_MS !== 0 || ![0, 6, 12, 18].includes(hour) || (request.attempt !== 1 && request.attempt !== 2) || request.slotKey !== `forecast:${request.runInitializedAt}:${String(request.attempt)}`) {
    throw new RangeError("invalid forecast run identity");
  }
  const url = new URL(FORECAST_ENDPOINT);
  url.searchParams.set("latitude", String(RAIN_COLLECTION_POLICY.latitude));
  url.searchParams.set("longitude", String(RAIN_COLLECTION_POLICY.longitude));
  url.searchParams.set("run", request.runInitializedAt.slice(0, 16));
  url.searchParams.set("models", "ecmwf_ifs");
  url.searchParams.set("hourly", FORECAST_VARIABLES.join(","));
  url.searchParams.set("forecast_hours", String(RAIN_COLLECTION_POLICY.forecastHours));
  url.searchParams.set("timezone", "GMT");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timeformat", "iso8601");
  return url;
}

// build one frozen-device Tempest request
function stationPlan(request: Extract<RainCaptureRequest, { kind: "station" }>, apiKey: string | undefined, startedAt: string) {
  const station = RAIN_COLLECTION_STATIONS.find((entry) => entry.locationId === request.stationId);
  // require one approved device and credential
  if (station === undefined || apiKey === undefined || request.slotKey !== `station:${String(request.stationId)}:${request.endExclusive}`) {
    throw new RangeError("invalid station request identity");
  }
  const start = utc(request.start);
  const end = utc(request.endExclusive);
  // prevent prospective reads from future or overlong windows
  if (start >= end || end - start > RAIN_COLLECTION_POLICY.stationWindowHours * HOUR_MS || end > Date.parse(startedAt)) {
    throw new RangeError("invalid station observation window");
  }
  const input = {
    apiKey,
    deviceId: station.deviceId,
    endExclusive: request.endExclusive,
    locationId: station.locationId,
    serial: station.serial,
    sourceId: `rain-prospective-tempest-${station.locationId}`,
    start: request.start,
    timezone: "America/Los_Angeles",
  };
  return { input, url: buildTempestObservationRequest(input).url };
}

// enforce the exact forty-nine-hour forecast schema
function forecastMetadata(payload: unknown, request: Extract<RainCaptureRequest, { kind: "forecast" }>): Readonly<Record<string, string | number | boolean | null>> {
  const root = object(payload);
  const units = object(root.hourly_units);
  const hourly = object(root.hourly);
  const expected = ["time", ...FORECAST_VARIABLES];
  // reject unit and field drift
  if (Object.keys(units).length !== expected.length || Object.keys(hourly).length !== expected.length || root.utc_offset_seconds !== 0 || root.timezone !== "GMT" || ("location_id" in root && root.location_id !== 0)) {
    throw new Error("invalid_forecast_schema");
  }
  // validate exact unit identities and array cardinality
  for (const key of expected) {
    if (units[key] !== FORECAST_UNITS[key as keyof typeof FORECAST_UNITS] || !Array.isArray(hourly[key]) || hourly[key].length !== RAIN_COLLECTION_POLICY.forecastHours) {
      throw new Error("invalid_forecast_schema");
    }
  }
  const latitude = root.latitude;
  const longitude = root.longitude;
  const elevation = root.elevation;
  // preserve only bounded grid coordinates
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude - EXPECTED_GRID.latitude) > GRID_TOLERANCE || typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude - EXPECTED_GRID.longitude) > GRID_TOLERANCE || typeof elevation !== "number" || !Number.isFinite(elevation) || elevation < -1000 || elevation > 10000) {
    throw new Error("invalid_forecast_grid");
  }
  const origin = utc(request.runInitializedAt);
  const times = hourly.time as unknown[];
  // bind every provider hour to the requested run
  for (let lead = 0; lead < RAIN_COLLECTION_POLICY.forecastHours; lead += 1) {
    const expectedTime = new Date(origin + lead * HOUR_MS).toISOString().slice(0, 16);
    if (times[lead] !== expectedTime) {
      throw new Error("invalid_forecast_grid");
    }
  }
  let nullCount = 0;
  // validate numeric domains without replacing missing cells
  for (const variable of FORECAST_VARIABLES) {
    const values = hourly[variable] as unknown[];
    const [minimum, maximum] = FORECAST_BOUNDS[variable];
    for (const cell of values) {
      if (cell === null) {
        nullCount += 1;
      } else if (typeof cell !== "number" || !Number.isFinite(cell) || cell < minimum || cell > maximum) {
        throw new Error("invalid_forecast_cell");
      }
    }
  }
  return {
    runInitializedAt: request.runInitializedAt,
    returnedLatitude: latitude,
    returnedLongitude: longitude,
    forecastElevationM: elevation,
    nullCount,
    leadCount: RAIN_COLLECTION_POLICY.forecastHours - 1,
  };
}

// validate physical interval amounts and durations
function stationMetadata(payload: unknown, input: ReturnType<typeof stationPlan>["input"], completedAt: string): Readonly<Record<string, string | number | boolean | null>> {
  const root = object(payload);
  const seen = new Set<number>();
  // reject raw duplicates before the existing normalizer can first-wins them
  if (Array.isArray(root.obs)) {
    for (const observation of root.obs) {
      // leave malformed rows to the strict Tempest parser
      if (!Array.isArray(observation) || typeof observation[0] !== "number" || !Number.isInteger(observation[0])) {
        continue;
      }
      // preserve the complete invalid body for later audit
      if (seen.has(observation[0])) {
        throw new Error("duplicate_station_interval");
      }
      seen.add(observation[0]);
    }
  }
  const records = normalizeTempestObservationPayload(payload, input, completedAt);
  // reject future, subminute, or nonphysical intervals
  for (const row of records) {
    const provider = row.metadata.provider;
    const minutes = provider !== null && typeof provider === "object" && !Array.isArray(provider) ? provider.report_interval_minutes : null;
    const amount = row.metrics.precipitationMm;
    if (Date.parse(row.validAt) > Date.parse(completedAt) || Date.parse(row.validAt) % 60_000 !== 0 || typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 5 || (amount !== null && (!Number.isFinite(amount) || amount < 0 || amount > 500))) {
      throw new Error("invalid_station_interval");
    }
  }
  return {
    stationId: input.locationId,
    deviceId: input.deviceId,
    intervalCount: records.length,
    firstIntervalAt: records[0]?.validAt ?? null,
    lastIntervalAt: records.at(-1)?.validAt ?? null,
  };
}

// decode only complete bounded UTF-8 JSON bodies
function parseBody(body: Uint8Array): unknown {
  // reject empty and malformed UTF-8 before JSON parsing
  if (body.byteLength === 0) {
    throw new Error("invalid_json");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return JSON.parse(text) as unknown;
}

// retain a bounded retry delay or require a manual rate-limit review
function retryAfterMetadata(value: string | null): Readonly<{ retryAfterSeconds: number | null; retryAfterRequiresManualResume: boolean }> {
  // use the fixed cooldown only when no server hint was supplied
  if (value === null) {
    return { retryAfterSeconds: null, retryAfterRequiresManualResume: false };
  }
  // refuse to shorten unsupported or unbounded server hints
  if (!/^\d{1,6}$/u.test(value)) {
    return { retryAfterSeconds: null, retryAfterRequiresManualResume: true };
  }
  const seconds = Number(value);
  return seconds <= 604_800
    ? { retryAfterSeconds: seconds, retryAfterRequiresManualResume: false }
    : { retryAfterSeconds: null, retryAfterRequiresManualResume: true };
}

// fetch one evidence-preserving attempt without hidden retries
export async function fetchRainCapture(request: RainCaptureRequest, options: CaptureOptions = {}): Promise<RainCaptureReceipt> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const station = request.kind === "station" ? stationPlan(request, options.apiKey, startedAt) : null;
  const url = request.kind === "forecast" ? forecastUrl(request) : station!.url;
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // reject at the deadline even if an injected fetch ignores abort
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("timeout"));
    }, RAIN_COLLECTION_POLICY.timeoutMs);
  });
  let response: Response;
  let body: Uint8Array;
  try {
    // keep fetch, response streaming and assembly inside one deadline
    ({ response, body } = await Promise.race([(async () => {
      const headers = request.kind === "station" ? {
        origin: "https://tempestwx.com",
        "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      } : undefined;
      const received = await (options.fetch ?? globalThis.fetch)(url, { method: "GET", redirect: "error", signal: controller.signal, ...(headers === undefined ? {} : { headers }) });
      const reader = received.body?.getReader();
      // treat missing or interrupted bodies as transport failures
      if (reader === undefined) {
        throw new Error("missing_body");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      // retain the exact complete transport payload
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        size += chunk.value.byteLength;
        // discard incomplete oversized bodies
        if (size > RAIN_COLLECTION_POLICY.maximumBodyBytes) {
          void reader.cancel().catch(() => undefined);
          throw new Error("body_too_large");
        }
        chunks.push(Uint8Array.from(chunk.value));
      }
      const complete = new Uint8Array(size);
      let offset = 0;
      // reconstruct the original response byte order
      for (const chunk of chunks) {
        complete.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { response: received, body: complete };
    })(), deadline]));
  } catch (error) {
    // stop any in-flight stream after an incomplete capture
    controller.abort();
    return {
      startedAt,
      completedAt: now().toISOString(),
      httpStatus: null,
      body: null,
      bodySha256: null,
      outcome: "transport_error",
      errorCode: timedOut ? "timeout" : error instanceof Error && ["missing_body", "body_too_large"].includes(error.message) ? error.message : "transport_error",
      parserVersion: RAIN_COLLECTION_POLICY.contractVersion,
      rowCount: 0,
      availableByDecision: request.kind === "forecast" ? false : null,
      metadata: {},
    };
  } finally {
    clearTimeout(timer);
  }
  // stamp receipt immediately after complete body capture
  const completedAt = now().toISOString();
  const bodySha256 = createHash("sha256").update(body).digest("hex");
  const base = { startedAt, completedAt, httpStatus: response.status, body, bodySha256, parserVersion: RAIN_COLLECTION_POLICY.contractVersion } as const;
  const retryAfter = retryAfterMetadata(response.headers.get("retry-after"));
  // retain all complete HTTP error bodies without parsing them
  if (!response.ok) {
    const outcome = response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "unauthorized" : "invalid";
    return { ...base, outcome, errorCode: `http_${response.status}`, rowCount: 0, availableByDecision: request.kind === "forecast" ? false : null, metadata: outcome === "rate_limited" ? retryAfter : {} };
  }
  try {
    const payload = parseBody(body);
    const metadata = request.kind === "forecast" ? forecastMetadata(payload, request) : stationMetadata(payload, station!.input, completedAt);
    const rowCount = request.kind === "forecast" ? RAIN_COLLECTION_POLICY.forecastHours - 1 : metadata.intervalCount as number;
    const availableByDecision = request.kind === "forecast" ? Date.parse(completedAt) <= Date.parse(request.runInitializedAt) + RAIN_COLLECTION_POLICY.decisionDelayHours * HOUR_MS : null;
    return { ...base, outcome: "valid", errorCode: null, rowCount, availableByDecision, metadata };
  } catch (error) {
    const code = error instanceof Error && ["invalid_forecast_schema", "invalid_forecast_grid", "invalid_forecast_cell", "invalid_station_interval", "duplicate_station_interval"].includes(error.message) ? error.message : "invalid_json_or_payload";
    return { ...base, outcome: "invalid", errorCode: code, rowCount: 0, availableByDecision: request.kind === "forecast" ? false : null, metadata: {} };
  }
}
