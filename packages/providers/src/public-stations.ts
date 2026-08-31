import { createHash } from "node:crypto";

import {
  createNormalizedWeatherRecord,
  normalizeMetricValue,
  validateTimeZone,
  type CanonicalWeatherMetrics,
  type JsonValue,
  type NormalizedWeatherRecord,
} from "@weather/domain";

import {
  ProviderFailure,
  type HistoricalProviderOperation,
  type ProviderBatch,
  type ProviderFetchOptions,
} from "./contract.js";
import {
  fetchJsonWithRetry,
  fetchTextWithRetry,
  type JsonResponse,
  type TextResponse,
} from "./http.js";

export const AMBIENT_WEATHER_ADAPTER_VERSION = "ambient-device-data/v1";
export const WUNDERGROUND_ADAPTER_VERSION = "wunderground-pws-history/v1";
export const NETATMO_ADAPTER_VERSION = "netatmo-public-measures/v1";
export const PURPLEAIR_ADAPTER_VERSION = "purpleair-map-history/v1";
export const PUBLIC_STATION_CHUNK_PLAN_VERSION = "public-station-calendar-range/v1";

const AMBIENT_DEVICE_DATA_ENDPOINT =
  "https://lightning.ambientweather.net/device-data";
const WUNDERGROUND_HISTORY_ENDPOINT =
  "https://api.weather.com/v2/pws/history/all";
const NETATMO_TOKEN_ENDPOINT = "https://auth.netatmo.com/weathermap/token";
const NETATMO_MEASURE_ENDPOINT = "https://app.netatmo.net/api/getmeasure";
const PURPLEAIR_MAP_ORIGIN = "https://map.purpleair.com";
const MAX_PUBLIC_STATION_RANGE_MS = 31 * 24 * 60 * 60 * 1_000;
const MAX_PURPLEAIR_RANGE_MS = 2 * 24 * 60 * 60 * 1_000;
const FIVE_MINUTES_SECONDS = 5 * 60;
const PURPLEAIR_TOKEN_CACHE_MS = 10 * 60 * 1_000;
const PURPLEAIR_HISTORY_FIELDS = [
  "humidity_a",
  "humidity_b",
  "pm2.5_atm_a",
  "pm2.5_atm_b",
  "pressure_a",
  "pressure_b",
  "temperature_a",
  "temperature_b",
] as const;

let purpleAirTokenCache: Readonly<{
  expiresAt: number;
  mapVersion: string;
  token: string;
}> | null = null;

interface PublicStationRangeBase {
  readonly endExclusive: string;
  readonly model: string | null;
  readonly serial: string | null;
  readonly sourceId: string;
  readonly start: string;
  readonly timezone: string;
}

export interface AmbientWeatherRangeRequest extends PublicStationRangeBase {
  readonly adapter: "ambient-weather";
  readonly deviceId: string;
  readonly macAddress: string;
}

export interface WeatherUndergroundRangeRequest extends PublicStationRangeBase {
  readonly adapter: "weather-underground";
  readonly publicApiKey: string;
  readonly stationId: string;
}

export interface NetatmoRangeRequest extends PublicStationRangeBase {
  readonly adapter: "netatmo";
  readonly deviceId: string;
  readonly outdoorModuleId: string;
  readonly rainModuleId: string;
  readonly windModuleId: string;
}

export interface PurpleAirRangeRequest extends PublicStationRangeBase {
  readonly adapter: "purpleair";
  readonly mapVersion: string;
  readonly sensorIndex: number;
}

export type PublicStationRangeRequest =
  | AmbientWeatherRangeRequest
  | NetatmoRangeRequest
  | PurpleAirRangeRequest
  | WeatherUndergroundRangeRequest;

export type PublicStationRangeOperation =
  HistoricalProviderOperation<PublicStationRangeRequest>;

interface MeasurementBucket {
  metrics: Partial<Record<keyof CanonicalWeatherMetrics, number | null>>;
  validAtEpoch: number;
}

// select the frozen adapter version
export function publicStationAdapterVersion(
  adapter: PublicStationRangeRequest["adapter"],
): string {
  // map the Ambient adapter
  if (adapter === "ambient-weather") {
    return AMBIENT_WEATHER_ADAPTER_VERSION;
  }

  // map the Weather Underground adapter
  if (adapter === "weather-underground") {
    return WUNDERGROUND_ADAPTER_VERSION;
  }

  // map the PurpleAir public-map adapter
  if (adapter === "purpleair") {
    return PURPLEAIR_ADAPTER_VERSION;
  }

  return NETATMO_ADAPTER_VERSION;
}

// fetch one provider-neutral public-station range
export async function fetchPublicStationRange(
  input: PublicStationRangeRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  // dispatch the configured adapter
  if (input.adapter === "ambient-weather") {
    return await fetchAmbientWeatherRange(input, options);
  }

  // dispatch the configured archive adapter
  if (input.adapter === "weather-underground") {
    return await fetchWeatherUndergroundRange(input, options);
  }

  // dispatch the PurpleAir public-map archive
  if (input.adapter === "purpleair") {
    return await fetchPurpleAirRange(input, options);
  }

  return await fetchNetatmoRange(input, options);
}

// build one Ambient device-data request
export function buildAmbientWeatherRequest(
  input: AmbientWeatherRangeRequest,
): URL {
  const window = validateRange(input);
  requirePattern(input.deviceId, /^[a-f0-9]{24}$/u, "deviceId");
  requirePattern(
    input.macAddress,
    /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/u,
    "macAddress",
  );
  const url = new URL(AMBIENT_DEVICE_DATA_ENDPOINT);
  url.searchParams.set("macAddress", input.macAddress);
  url.searchParams.set("start", String(window.start));
  url.searchParams.set("end", String(window.endExclusive - 1));
  url.searchParams.set("limit", "10000");
  return url;
}

// fetch and normalize Ambient public observations
export async function fetchAmbientWeatherRange(
  input: AmbientWeatherRangeRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  const response = await fetchJsonWithRetry(
    buildAmbientWeatherRequest(input),
    { maxBodyBytes: 10_000_000, ...options },
  );
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizeAmbientWeatherPayload(response.payload, input, receivedAt);
  return batchFromResponses(
    [response],
    records,
    {
      normalized_record_count: records.length,
      provider: "ambient-weather-network",
      raw_observation_count: ambientRows(response.payload).length,
    },
  );
}

// normalize every Ambient device observation
export function normalizeAmbientWeatherPayload(
  payload: unknown,
  input: AmbientWeatherRangeRequest,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const window = validateRange(input);
  const distinct = new Map<number, Record<string, unknown>>();

  // retain each in-window provider timestamp
  for (const [index, value] of ambientRows(payload).entries()) {
    const row = requireObject(value, `data[${index}]`);
    const epoch = requireInteger(row.dateutc, `data[${index}].dateutc`);

    // exclude inclusive-boundary and unrelated rows
    if (epoch < window.start || epoch >= window.endExclusive) {
      continue;
    }

    // reject a conflicting optional device identity
    if (row.deviceId !== undefined && row.deviceId !== input.deviceId) {
      throw invalidPayload("Ambient response device identity is invalid");
    }

    // preserve the first exact observation
    if (!distinct.has(epoch)) {
      distinct.set(epoch, row);
    }
  }

  return [...distinct.entries()]
    .sort(([left], [right]) => left - right)
    .map(([epoch, row]) =>
      createNormalizedWeatherRecord({
        metadata: {
          device: {
            ...(input.model === null ? {} : { model: input.model }),
            ...(input.serial === null ? {} : { serial: input.serial }),
            vendor: "Ambient Weather",
          },
          model: null,
          provider: {
            dataset: "public-device-data",
            device_id: input.deviceId,
          },
          quality: { sampling: "every_distinct_provider_observation" },
          upstreamTimezone: input.timezone,
        },
        metrics: {
          ...emptyMetrics(),
          apparentTemperatureC: ambientApparentTemperature(row.feelsLike),
          precipitationRateMmPerHour: inchesPerHour(row.hourlyrainin),
          pressureHpa: inchesMercury(row.baromrelin),
          relativeHumidityPercent: metric(
            "relativeHumidityPercent",
            row.humidity,
            "percent",
          ),
          solarRadiationWm2: metric(
            "solarRadiationWm2",
            row.solarradiation,
            "watt_per_square_meter",
          ),
          temperatureC: metric("temperatureC", row.tempf, "f"),
          uvIndex: boundedUv(row.uv),
          windDirectionDegrees: direction(row.winddir),
          windGustMps: milesPerHour("windGustMps", row.windgustmph),
          windSpeedMps: milesPerHour("windSpeedMps", row.windspeedmph),
        },
        productRunAt: null,
        receivedAt,
        sourceId: input.sourceId,
        sourceKind: "physical_sensor",
        validAt: new Date(epoch).toISOString(),
      }),
    );
}

// fetch and normalize Weather Underground archive observations
export async function fetchWeatherUndergroundRange(
  input: WeatherUndergroundRangeRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  const window = validateRange(input, 24 * 60 * 60 * 1_000);
  requirePattern(input.stationId, /^[A-Z0-9]{3,32}$/u, "stationId");
  requirePattern(input.publicApiKey, /^[a-f0-9]{32}$/u, "publicApiKey");
  const dates = new Set([
    localDate(window.start, input.timezone),
    localDate(window.endExclusive - 1, input.timezone),
  ]);
  const responses: JsonResponse[] = [];

  // query each local day intersecting the UTC window
  for (const date of dates) {
    const url = new URL(WUNDERGROUND_HISTORY_ENDPOINT);
    url.searchParams.set("stationId", input.stationId);
    url.searchParams.set("format", "json");
    url.searchParams.set("units", "m");
    url.searchParams.set("numericPrecision", "decimal");
    url.searchParams.set("date", date.replaceAll("-", ""));
    url.searchParams.set("apiKey", input.publicApiKey);
    responses.push(await fetchJsonWithRetry(url, options));
  }

  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizeWeatherUndergroundPayloads(
    responses.map((response) => response.payload),
    input,
    receivedAt,
  );
  return batchFromResponses(
    responses,
    records,
    {
      normalized_record_count: records.length,
      provider: "weather-underground",
      raw_observation_count: responses.reduce(
        (count, response) => count + wundergroundRows(response.payload).length,
        0,
      ),
    },
  );
}

// normalize Weather Underground local-day responses
export function normalizeWeatherUndergroundPayloads(
  payloads: readonly unknown[],
  input: WeatherUndergroundRangeRequest,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const window = validateRange(input, 24 * 60 * 60 * 1_000);
  const distinct = new Map<number, Record<string, unknown>>();

  // flatten each intersecting provider day
  for (const payload of payloads) {
    for (const [index, value] of wundergroundRows(payload).entries()) {
      const row = requireObject(value, `observations[${index}]`);
      const epoch = requireInteger(row.epoch, `observations[${index}].epoch`) * 1_000;

      // filter the provider-local day to the UTC chunk
      if (epoch < window.start || epoch >= window.endExclusive) {
        continue;
      }

      // bind rows to the configured station
      if (row.stationID !== input.stationId) {
        throw invalidPayload("Weather Underground station identity is invalid");
      }

      // preserve the first exact observation
      if (!distinct.has(epoch)) {
        distinct.set(epoch, row);
      }
    }
  }

  return [...distinct.entries()]
    .sort(([left], [right]) => left - right)
    .map(([epoch, row]) => normalizeWeatherUndergroundRow(epoch, row, input, receivedAt));
}

// normalize one Weather Underground observation
function normalizeWeatherUndergroundRow(
  epoch: number,
  row: Record<string, unknown>,
  input: WeatherUndergroundRangeRequest,
  receivedAt: string,
): NormalizedWeatherRecord {
  const values = requireObject(row.metric, "observation.metric");
  const pressure = averageNullable(values.pressureMax, values.pressureMin);
  const qualityStatus = nullableNumber(row.qcStatus, "qcStatus");
  return createNormalizedWeatherRecord({
    metadata: {
      device: {
        ...(input.model === null ? {} : { model: input.model }),
        ...(input.serial === null ? {} : { serial: input.serial }),
        vendor: "Ambient Weather",
      },
      model: null,
      provider: {
        dataset: "pws-history-all",
        device_id: input.stationId,
        report_interval_minutes: 5,
      },
      quality: {
        sampling: "five_minute_provider_observations",
        ...(qualityStatus === null ? {} : { status: `provider_qc_${String(qualityStatus)}` }),
      },
      upstreamTimezone: input.timezone,
    },
    metrics: {
      ...emptyMetrics(),
      precipitationRateMmPerHour: metric(
        "precipitationRateMmPerHour",
        values.precipRate,
        "millimeter_per_hour",
      ),
      pressureHpa: normalizeMetricValue("pressureHpa", pressure, "hectopascal"),
      relativeHumidityPercent: metric(
        "relativeHumidityPercent",
        row.humidityAvg,
        "percent",
      ),
      solarRadiationWm2: metric(
        "solarRadiationWm2",
        row.solarRadiationHigh,
        "watt_per_square_meter",
      ),
      temperatureC: metric("temperatureC", values.tempAvg, "c"),
      uvIndex: boundedUv(row.uvHigh),
      windDirectionDegrees: direction(row.winddirAvg),
      windGustMps: metric("windGustMps", values.windgustHigh, "kilometer_per_hour"),
      windSpeedMps: metric("windSpeedMps", values.windspeedAvg, "kilometer_per_hour"),
    },
    productRunAt: null,
    receivedAt,
    sourceId: input.sourceId,
    sourceKind: "physical_sensor",
    validAt: new Date(epoch).toISOString(),
  });
}

// build one PurpleAir public-map history request
export function buildPurpleAirHistoryRequest(input: PurpleAirRangeRequest): URL {
  validateRange(input, MAX_PURPLEAIR_RANGE_MS);
  requireInteger(input.sensorIndex, "sensorIndex");
  requirePattern(input.mapVersion, /^\d+\.\d+\.\d+$/u, "mapVersion");
  const url = new URL(
    `/v1/sensors/${input.sensorIndex}/history/csv`,
    PURPLEAIR_MAP_ORIGIN,
  );
  url.searchParams.set("fields", PURPLEAIR_HISTORY_FIELDS.join(","));
  url.searchParams.set("start_timestamp", new Date(input.start).toISOString());
  url.searchParams.set(
    "end_timestamp",
    new Date(input.endExclusive).toISOString(),
  );
  url.searchParams.set("average", "0");
  return url;
}

// fetch and normalize PurpleAir two-minute observations
export async function fetchPurpleAirRange(
  input: PurpleAirRangeRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  const token = await fetchPurpleAirMapToken(input.mapVersion, options);
  const response = await fetchTextWithRetry(
    buildPurpleAirHistoryRequest(input),
    { maxBodyBytes: 10_000_000, ...options },
    { headers: purpleAirHeaders(token.value) },
  );
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizePurpleAirCsv(response.text, input, receivedAt);
  return batchFromResponses(
    [response],
    records,
    {
      normalized_record_count: records.length,
      provider: "purpleair",
      raw_observation_count: purpleAirCsvRowCount(response.text),
      resolution_seconds: 120,
    },
    token.attempts,
  );
}

// normalize PurpleAir dual-channel CSV observations
export function normalizePurpleAirCsv(
  csv: string,
  input: PurpleAirRangeRequest,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const window = validateRange(input, MAX_PURPLEAIR_RANGE_MS);
  requireInteger(input.sensorIndex, "sensorIndex");
  const lines = csv.trim().length === 0 ? [] : csv.trim().split(/\r?\n/u);

  // reject a missing schema line
  if (lines.length === 0) {
    throw invalidPayload("PurpleAir history CSV is empty");
  }

  const header = requirePurpleAirHeader(lines[0] ?? "");
  const distinct = new Map<number, Readonly<Record<string, string>>>();

  // retain every exact in-window provider timestamp
  for (const [index, line] of lines.slice(1).entries()) {
    const values = line.split(",");

    // reject malformed row widths
    if (values.length !== header.length) {
      throw invalidPayload(`PurpleAir history row ${index + 1} has invalid width`);
    }

    const row = Object.fromEntries(
      header.map((field, fieldIndex) => [field, values[fieldIndex] ?? ""]),
    );
    const sensorIndex = requireCsvInteger(
      row.sensor_index,
      `PurpleAir history row ${index + 1} sensor_index`,
    );

    // reject rows for another physical sensor
    if (sensorIndex !== input.sensorIndex) {
      throw invalidPayload("PurpleAir response sensor identity is invalid");
    }

    const epoch = Date.parse(row.time_stamp ?? "");

    // reject malformed timestamps
    if (!Number.isFinite(epoch) || epoch % 1_000 !== 0) {
      throw invalidPayload(`PurpleAir history row ${index + 1} timestamp is invalid`);
    }

    // exclude provider boundary padding
    if (epoch < window.start || epoch >= window.endExclusive) {
      continue;
    }

    // preserve the first exact observation
    if (!distinct.has(epoch)) {
      distinct.set(epoch, row);
    }
  }

  return [...distinct.entries()]
    .sort(([left], [right]) => left - right)
    .map(([epoch, row]) => {
      const pm25 = purpleAirPm25(row);

      return createNormalizedWeatherRecord({
        metadata: {
          device: {
            ...(input.model === null ? {} : { model: input.model }),
            ...(input.serial === null ? {} : { serial: input.serial }),
            vendor: "PurpleAir",
          },
          model: null,
          provider: {
            dataset: "public-map-history",
            device_id: String(input.sensorIndex),
            report_interval_minutes: 2,
          },
          quality: {
            flags: [
              "dual_channel_average",
              "uncorrected_sensor_enclosure_temperature",
              ...(pm25.outOfRange ? ["pm25_out_of_range"] : []),
            ],
            sampling: "every_two_minute_provider_observation",
          },
          upstreamTimezone: input.timezone,
        },
        metrics: {
          ...emptyMetrics(),
          pm25MicrogramsPerCubicMeter: pm25.value,
          pressureHpa: metric(
            "pressureHpa",
            averagePurpleAirChannels(row, "pressure_a", "pressure_b"),
            "hectopascal",
          ),
          relativeHumidityPercent: metric(
            "relativeHumidityPercent",
            averagePurpleAirChannels(row, "humidity_a", "humidity_b"),
            "percent",
          ),
          temperatureC: metric(
            "temperatureC",
            averagePurpleAirChannels(row, "temperature_a", "temperature_b"),
            "f",
          ),
        },
        productRunAt: null,
        receivedAt,
        sourceId: input.sourceId,
        sourceKind: "physical_sensor",
        validAt: new Date(epoch).toISOString(),
      });
    });
}

// pace public-station backfills by provider policy
export function publicStationBackfillDelayMilliseconds(
  adapter: PublicStationRangeRequest["adapter"],
): number {
  return adapter === "purpleair" ? 1_000 : 0;
}

// fetch one short-lived public map token
async function fetchPurpleAirMapToken(
  mapVersion: string,
  options: ProviderFetchOptions,
): Promise<Readonly<{ attempts: number; value: string }>> {
  requirePattern(mapVersion, /^\d+\.\d+\.\d+$/u, "mapVersion");
  const clock = options.clock ?? Date.now;
  const useCache = options.fetch === undefined;

  // reuse only an unexpired exact-version production token
  if (
    useCache &&
    purpleAirTokenCache !== null &&
    purpleAirTokenCache.mapVersion === mapVersion &&
    purpleAirTokenCache.expiresAt > clock()
  ) {
    return { attempts: 0, value: purpleAirTokenCache.token };
  }

  const url = new URL("/v1/token", PURPLEAIR_MAP_ORIGIN);
  url.searchParams.set("version", mapVersion);
  const response = await fetchTextWithRetry(url, options, {
    headers: purpleAirHeaders(),
  });
  const token = response.text.trim();

  // reject HTML and malformed public token responses
  if (!/^[A-Za-z0-9+/=]{64,256}$/u.test(token)) {
    throw invalidPayload("PurpleAir map token response is invalid");
  }

  // cache only real production transport results
  if (useCache) {
    purpleAirTokenCache = {
      expiresAt: clock() + PURPLEAIR_TOKEN_CACHE_MS,
      mapVersion,
      token,
    };
  }

  return { attempts: response.attempts, value: token };
}

// build the public-map referrer contract
function purpleAirHeaders(token?: string): Readonly<Record<string, string>> {
  return {
    origin: PURPLEAIR_MAP_ORIGIN,
    referer: `${PURPLEAIR_MAP_ORIGIN}/`,
    "user-agent": "Mozilla/5.0 weather.ballydidean.farm ingestion",
    ...(token === undefined ? {} : { "x-api-token": token }),
  };
}

// validate the exact requested PurpleAir history schema
function requirePurpleAirHeader(value: string): readonly string[] {
  const fields = value.split(",");
  const expected = ["time_stamp", "sensor_index", ...PURPLEAIR_HISTORY_FIELDS];

  // require every field exactly once while allowing provider ordering
  if (
    fields.length !== expected.length ||
    new Set(fields).size !== fields.length ||
    expected.some((field) => !fields.includes(field))
  ) {
    throw invalidPayload("PurpleAir history CSV schema is invalid");
  }

  return fields;
}

// count non-header PurpleAir CSV rows
function purpleAirCsvRowCount(value: string): number {
  const lines = value.trim().split(/\r?\n/u);
  return Math.max(0, lines.length - 1);
}

// parse one PurpleAir CSV integer
function requireCsvInteger(value: string | undefined, field: string): number {
  const parsed = Number(value);

  // reject empty fractional or unsafe identifiers
  if (value === undefined || value.length === 0 || !Number.isSafeInteger(parsed)) {
    throw invalidPayload(`${field} is invalid`);
  }

  return parsed;
}

// average available PurpleAir channel values
function averagePurpleAirChannels(
  row: Readonly<Record<string, string>>,
  channelA: string,
  channelB: string,
): number | null {
  const first = purpleAirCsvNumber(row[channelA], channelA);
  const second = purpleAirCsvNumber(row[channelB], channelB);

  // preserve two missing channels
  if (first === null && second === null) {
    return null;
  }

  // use a single available channel
  if (first === null || second === null) {
    return first ?? second;
  }

  return (first + second) / 2;
}

// discard impossible PurpleAir particulate spikes
function purpleAirPm25(
  row: Readonly<Record<string, string>>,
): Readonly<{ outOfRange: boolean; value: number | null }> {
  const value = averagePurpleAirChannels(row, "pm2.5_atm_a", "pm2.5_atm_b");

  // retain the canonical particulate range
  if (value !== null && (value < 0 || value > 999)) {
    return { outOfRange: true, value: null };
  }

  return {
    outOfRange: false,
    value: metric(
      "pm25MicrogramsPerCubicMeter",
      value,
      "microgram_per_cubic_meter",
    ),
  };
}

// parse one nullable PurpleAir CSV number
function purpleAirCsvNumber(value: string | undefined, field: string): number | null {
  // preserve provider gaps
  if (value === undefined || value === "" || value === "null") {
    return null;
  }

  const parsed = Number(value);

  // reject non-finite numeric cells
  if (!Number.isFinite(parsed)) {
    throw invalidPayload(`PurpleAir ${field} must be numeric or null`);
  }

  return parsed;
}

// fetch and normalize Netatmo public measurement history
export async function fetchNetatmoRange(
  input: NetatmoRangeRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch> {
  const window = validateRange(input);
  validateNetatmoIdentity(input);
  const tokenResponse = await fetchJsonWithRetry(new URL(NETATMO_TOKEN_ENDPOINT), options);
  const token = requireString(
    requireObject(tokenResponse.payload, "Netatmo token response").body,
    "token body",
    4096,
  );
  const definitions = [
    { moduleId: input.outdoorModuleId, type: "Temperature,Humidity" },
    { moduleId: input.deviceId, type: "Pressure" },
    { moduleId: input.rainModuleId, type: "Rain" },
    {
      moduleId: input.windModuleId,
      type: "WindStrength,WindAngle,GustStrength,GustAngle",
    },
  ] as const;
  const responses = await Promise.all(
    definitions.map(async (definition) => {
      const body = JSON.stringify({
        date_begin: String(Math.floor(window.start / 1_000)),
        date_end: String(Math.floor((window.endExclusive - 1) / 1_000)),
        device_id: input.deviceId,
        module_id: definition.moduleId,
        optimize: false,
        scale: "max",
        type: definition.type,
      });
      return await fetchJsonWithRetry(
        new URL(NETATMO_MEASURE_ENDPOINT),
        { maxBodyBytes: 10_000_000, ...options },
        {
          body,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      );
    }),
  );
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const records = normalizeNetatmoPayloads(
    responses.map((response) => response.payload),
    input,
    receivedAt,
  );
  return batchFromResponses(
    [tokenResponse, ...responses],
    records,
    {
      measurement_request_count: responses.length,
      normalized_record_count: records.length,
      provider: "netatmo-weathermap",
    },
  );
}

// normalize and merge Netatmo module series into five-minute points
export function normalizeNetatmoPayloads(
  payloads: readonly unknown[],
  input: NetatmoRangeRequest,
  receivedAt: string,
): readonly NormalizedWeatherRecord[] {
  const window = validateRange(input);
  validateNetatmoIdentity(input);

  // require the exact requested module set
  if (payloads.length !== 4) {
    throw invalidPayload("Netatmo response set must contain four module series");
  }

  const buckets = new Map<number, MeasurementBucket>();
  mergeNetatmoSeries(buckets, payloads[0], window, ["temperatureC", "relativeHumidityPercent"]);
  mergeNetatmoSeries(buckets, payloads[1], window, ["pressureHpa"]);
  mergeNetatmoSeries(buckets, payloads[2], window, ["precipitationMm"]);
  mergeNetatmoSeries(buckets, payloads[3], window, [
    "windSpeedMps",
    "windDirectionDegrees",
    "windGustMps",
    "unusedGustDirection",
  ]);

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([_bucket, value]) =>
      createNormalizedWeatherRecord({
        metadata: {
          device: {
            ...(input.model === null ? {} : { model: input.model }),
            ...(input.serial === null ? {} : { serial: input.serial }),
            vendor: "Netatmo",
          },
          model: null,
          provider: {
            dataset: "public-getmeasure",
            device_id: input.deviceId,
            report_interval_minutes: 5,
          },
          quality: { sampling: "five_minute_provider_buckets" },
          upstreamTimezone: input.timezone,
        },
        metrics: { ...emptyMetrics(), ...value.metrics },
        productRunAt: null,
        receivedAt,
        sourceId: input.sourceId,
        sourceKind: "physical_sensor",
        validAt: new Date(value.validAtEpoch * 1_000).toISOString(),
      }),
    );
}

// merge one Netatmo typed module series
function mergeNetatmoSeries(
  buckets: Map<number, MeasurementBucket>,
  payload: unknown,
  window: Readonly<{ endExclusive: number; start: number }>,
  metrics: readonly (
    | keyof CanonicalWeatherMetrics
    | "unusedGustDirection"
  )[],
): void {
  const root = requireObject(payload, "Netatmo measure response");

  // require a successful public API response
  if (root.status !== "ok") {
    throw invalidPayload("Netatmo measure response is not successful");
  }

  const body = root.body;

  // accept provider representations of an empty module period
  if (body === null || (Array.isArray(body) && body.length === 0)) {
    return;
  }

  const values = requireObject(body, "Netatmo measure body");

  // merge each provider timestamp
  for (const [epochText, raw] of Object.entries(values)) {
    const epoch = Number(epochText);

    // reject malformed epoch keys
    if (!Number.isSafeInteger(epoch) || epoch < 1) {
      throw invalidPayload("Netatmo measure timestamp is invalid");
    }

    const epochMilliseconds = epoch * 1_000;

    // exclude response padding and gaps
    if (epochMilliseconds < window.start || epochMilliseconds >= window.endExclusive) {
      continue;
    }

    const row = requireArray(raw, `Netatmo measure ${epochText}`);

    // require the requested type width
    if (row.length < metrics.length) {
      throw invalidPayload("Netatmo measure row is shorter than requested types");
    }

    const key = Math.floor(epoch / FIVE_MINUTES_SECONDS) * FIVE_MINUTES_SECONDS;
    const bucket = buckets.get(key) ?? { metrics: {}, validAtEpoch: epoch };
    bucket.validAtEpoch = Math.max(bucket.validAtEpoch, epoch);

    // merge every typed metric
    for (const [index, name] of metrics.entries()) {
      const rawValue = row[index];

      // ignore gust direction outside the canonical schema
      if (name === "unusedGustDirection") {
        continue;
      }

      bucket.metrics[name] = netatmoMetric(name, rawValue);
    }

    buckets.set(key, bucket);
  }
}

// normalize one Netatmo metric unit
function netatmoMetric(
  name: keyof CanonicalWeatherMetrics,
  value: unknown,
): number | null {
  // normalize temperatures
  if (name === "temperatureC") {
    return metric(name, value, "c");
  }

  // normalize percentages
  if (name === "relativeHumidityPercent") {
    return metric(name, value, "percent");
  }

  // normalize pressure
  if (name === "pressureHpa") {
    return metric(name, value, "hectopascal");
  }

  // normalize rain accumulation
  if (name === "precipitationMm") {
    return metric(name, value, "millimeter");
  }

  // normalize circular direction
  if (name === "windDirectionDegrees") {
    return direction(value);
  }

  return metric(name, value, "kilometer_per_hour");
}

// combine multiple upstream responses into one durable batch
function batchFromResponses(
  responses: readonly (JsonResponse | TextResponse)[],
  records: readonly NormalizedWeatherRecord[],
  responseMetadata: Readonly<Record<string, JsonValue>>,
  additionalAttempts = 0,
): ProviderBatch {
  const lastRecord = records.at(-1);
  const checksum = createHash("sha256");

  // retain exact response checksum boundaries
  for (const response of responses) {
    checksum.update(`${response.checksum}\n`);
  }

  return {
    attempts:
      additionalAttempts +
      responses.reduce((count, response) => count + response.attempts, 0),
    checksum: checksum.digest("hex"),
    providerCursor:
      lastRecord === undefined ? null : { valid_at: lastRecord.validAt },
    records,
    responseMetadata,
  };
}

// validate one common provider range
function validateRange(
  input: PublicStationRangeBase,
  maximumRangeMs = MAX_PUBLIC_STATION_RANGE_MS,
): Readonly<{ endExclusive: number; start: number }> {
  requireString(input.sourceId, "sourceId", 128);
  validateTimeZone(input.timezone);
  const start = Date.parse(input.start);
  const endExclusive = Date.parse(input.endExclusive);

  // require one bounded exact-second half-open range
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(endExclusive) ||
    start % 1_000 !== 0 ||
    endExclusive % 1_000 !== 0 ||
    start >= endExclusive ||
    endExclusive - start > maximumRangeMs
  ) {
    throw new RangeError("public-station range is invalid or too large");
  }

  return { endExclusive, start };
}

// validate configured Netatmo public identifiers
function validateNetatmoIdentity(input: NetatmoRangeRequest): void {
  const pattern = /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/u;
  requirePattern(input.deviceId, pattern, "deviceId");
  requirePattern(input.outdoorModuleId, pattern, "outdoorModuleId");
  requirePattern(input.rainModuleId, pattern, "rainModuleId");
  requirePattern(input.windModuleId, pattern, "windModuleId");
}

// read Ambient response rows
function ambientRows(payload: unknown): readonly unknown[] {
  return requireArray(requireObject(payload, "Ambient response").data, "Ambient data");
}

// read Weather Underground response rows
function wundergroundRows(payload: unknown): readonly unknown[] {
  const observations = requireObject(payload, "Weather Underground response").observations;

  // accept archive gaps
  if (observations === undefined || observations === null) {
    return [];
  }

  return requireArray(observations, "Weather Underground observations");
}

// convert one epoch to a provider-local date
function localDate(epochMilliseconds: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).formatToParts(new Date(epochMilliseconds));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

// create an all-null canonical metric set
function emptyMetrics(): CanonicalWeatherMetrics {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: null,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: null,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps: null,
    windSpeedMps: null,
  };
}

// normalize one nullable metric
function metric(
  name: Parameters<typeof normalizeMetricValue>[0],
  value: unknown,
  unit: Parameters<typeof normalizeMetricValue>[2],
): number | null {
  return normalizeMetricValue(name, nullableNumber(value, name), unit);
}

// discard impossible Ambient calculated heat-index values
function ambientApparentTemperature(value: unknown): number | null {
  const parsed = nullableNumber(value, "apparentTemperatureC");

  // retain the canonical temperature range after Fahrenheit conversion
  if (parsed !== null && (parsed < -148 || parsed > 158)) {
    return null;
  }

  return normalizeMetricValue("apparentTemperatureC", parsed, "f");
}

// convert Ambient miles per hour
function milesPerHour(
  name: "windGustMps" | "windSpeedMps",
  value: unknown,
): number | null {
  const parsed = nullableNumber(value, name);
  return normalizeMetricValue(
    name,
    parsed === null ? null : parsed * 0.44704,
    "meter_per_second",
  );
}

// convert a rolling inch-per-hour value
function inchesPerHour(value: unknown): number | null {
  const parsed = nullableNumber(value, "hourlyrainin");
  return normalizeMetricValue(
    "precipitationRateMmPerHour",
    parsed === null ? null : parsed * 25.4,
    "millimeter_per_hour",
  );
}

// convert inches of mercury to hectopascals
function inchesMercury(value: unknown): number | null {
  const parsed = nullableNumber(value, "baromrelin");
  return normalizeMetricValue(
    "pressureHpa",
    parsed === null ? null : parsed * 33.8638866667,
    "hectopascal",
  );
}

// normalize one optional circular direction
function direction(value: unknown): number | null {
  const parsed = nullableNumber(value, "wind direction");

  // preserve unavailable provider directions
  if (parsed !== null && parsed < 0) {
    return null;
  }

  return normalizeMetricValue(
    "windDirectionDegrees",
    parsed === 360 ? 0 : parsed,
    "degree",
  );
}

// retain only canonical UV readings
function boundedUv(value: unknown): number | null {
  const parsed = nullableNumber(value, "uv index");

  // discard impossible public sensor values
  if (parsed !== null && (parsed < 0 || parsed > 20)) {
    return null;
  }

  return normalizeMetricValue("uvIndex", parsed, "index");
}

// average two nullable values
function averageNullable(left: unknown, right: unknown): number | null {
  const first = nullableNumber(left, "pressureMax");
  const second = nullableNumber(right, "pressureMin");

  // preserve two missing values
  if (first === null && second === null) {
    return null;
  }

  // use the available bound
  if (first === null || second === null) {
    return first ?? second;
  }

  return (first + second) / 2;
}

// require one object
function requireObject(value: unknown, field: string): Record<string, unknown> {
  // reject null arrays and primitives
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPayload(`${field} must be an object`);
  }

  return value as Record<string, unknown>;
}

// require one array
function requireArray(value: unknown, field: string): readonly unknown[] {
  // reject non-arrays
  if (!Array.isArray(value)) {
    throw invalidPayload(`${field} must be an array`);
  }

  return value;
}

// require one bounded string
function requireString(value: unknown, field: string, maximum: number): string {
  // reject empty or oversized strings
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw invalidPayload(`${field} must be a bounded non-empty string`);
  }

  return value;
}

// require one positive integer
function requireInteger(value: unknown, field: string): number {
  // reject fractional or negative epochs
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw invalidPayload(`${field} must be a positive integer`);
  }

  return Number(value);
}

// parse one nullable provider number
function nullableNumber(value: unknown, field: string): number | null {
  // preserve explicit provider gaps
  if (value === null || value === undefined) {
    return null;
  }

  // reject numeric strings and non-finite values
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidPayload(`${field} must be a finite number or null`);
  }

  return value;
}

// require one identifier pattern
function requirePattern(value: string, pattern: RegExp, field: string): void {
  // reject malformed public identifiers
  if (!pattern.test(value)) {
    throw new RangeError(`${field} is invalid`);
  }
}

// create a bounded invalid-payload failure
function invalidPayload(message: string): ProviderFailure {
  return new ProviderFailure({
    classification: "invalid_payload",
    code: "invalid_payload",
    message,
  });
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}
