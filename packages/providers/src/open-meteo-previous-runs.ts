import {
  createNormalizedForecastAnchorRecord,
  normalizeMetricValue,
  parseFixedForecastLeadHours,
  validateCoordinates,
  validateSha256Hex,
  validateTimeZone,
  validateUtcInstant,
  type CanonicalWeatherMetrics,
  type JsonValue,
  type NormalizedForecastAnchorRecord,
} from "@weather/domain";

import {
  ProviderFailure,
  type HistoricalProviderOperation,
  type ProviderBatch,
  type ProviderFetchOptions,
  type ProviderRequestPlan,
} from "./contract.js";
import { fetchJsonWithRetry, type JsonResponse } from "./http.js";
import { parseOpenMeteoCompatibilityOrigin } from "./open-meteo.js";

// freeze the archive-only adapter identity
export const OPEN_METEO_PREVIOUS_RUNS_ADAPTER_VERSION =
  "open-meteo-previous-runs/v1";
export const OPEN_METEO_PREVIOUS_RUNS_CHUNK_PLAN_VERSION =
  "open-meteo-previous-runs/v1";
export const OPEN_METEO_PREVIOUS_RUNS_CONTRACT_VERSION =
  "previous-runs-hourly/v1";
export const OPEN_METEO_PREVIOUS_RUNS_CONTRACT_EPOCH =
  "open-meteo-previous-runs-best-match/2026-09";
export const OPEN_METEO_PREVIOUS_RUNS_MODEL = "best_match";
export const OPEN_METEO_PREVIOUS_RUNS_DATASET = "previous_runs";
export const OPEN_METEO_PREVIOUS_RUNS_MAXIMUM_CHUNK_DAYS = 14;
export const OPEN_METEO_PREVIOUS_RUNS_WIND_GUST_INTERVAL =
  "preceding_hour_maximum";
export const OPEN_METEO_PREVIOUS_RUNS_MODIFICATION_NOTICE =
  "normalized_to_canonical_fixed_lead_anchors";

const PREVIOUS_RUNS_ENDPOINT =
  "https://previous-runs-api.open-meteo.com/v1/forecast";
const PREVIOUS_RUNS_PATH = "/v1/forecast";
const MAXIMUM_LOCATIONS = 100;
const MILLISECONDS_PER_DAY = 86_400_000;
const PREVIOUS_RUNS_DAY_OFFSETS = [1, 2, 3, 4, 5, 6, 7] as const;
const PREVIOUS_RUNS_BASE_VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation",
  "cloud_cover",
  "wind_speed_10m",
  "wind_gusts_10m",
  "wind_direction_10m",
  "surface_pressure",
] as const;
const PREVIOUS_RUNS_EXPECTED_UNITS: Readonly<
  Record<PreviousRunsBaseVariable, string>
> = {
  apparent_temperature: "°C",
  cloud_cover: "%",
  precipitation: "mm",
  relative_humidity_2m: "%",
  surface_pressure: "hPa",
  temperature_2m: "°C",
  wind_direction_10m: "°",
  wind_gusts_10m: "m/s",
  wind_speed_10m: "m/s",
};

type PreviousRunsBaseVariable = (typeof PREVIOUS_RUNS_BASE_VARIABLES)[number];
type PreviousRunsDayOffset = (typeof PREVIOUS_RUNS_DAY_OFFSETS)[number];

// identify one positional storage target
export interface OpenMeteoPreviousRunsLocation {
  readonly latitude: number;
  readonly longitude: number;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
}

// describe one inclusive UTC archive request
export interface OpenMeteoPreviousRunsRequest {
  readonly contractEpoch: string;
  readonly endDate: string;
  readonly locations: readonly OpenMeteoPreviousRunsLocation[];
  readonly startDate: string;
}

// type one fixed-anchor historical operation
export type OpenMeteoPreviousRunsOperation = HistoricalProviderOperation<
  OpenMeteoPreviousRunsRequest,
  NormalizedForecastAnchorRecord
>;

// count one fixed lead's requested cells
interface PreviousRunsAnchorCounts {
  readonly null: number;
  readonly populated: number;
  readonly requested: number;
}

// retain validated records and bounded evidence
interface PreviousRunsNormalization {
  readonly countsByLead: ReadonlyMap<number, PreviousRunsAnchorCounts>;
  readonly records: readonly NormalizedForecastAnchorRecord[];
  readonly roots: readonly Record<string, unknown>[];
}

// retain one zero-offset provider grid envelope
interface PreviousRunsEnvelope {
  readonly elevation: number | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: "GMT" | "UTC";
}

// freeze every requested fixed-lead field
export const OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES =
  previousRunsHourlyVariables();

// expose the historical-only capability
export function openMeteoPreviousRunsCapabilities(): readonly ["historical"] {
  return ["historical"];
}

// calculate the conservative provider-weighted request cost
export function openMeteoPreviousRunsWeightedApiCallCost(
  locationCount: number,
  inclusiveDays = OPEN_METEO_PREVIOUS_RUNS_MAXIMUM_CHUNK_DAYS,
): number {
  // require the same bounded coordinate count as the request builder
  if (
    !Number.isSafeInteger(locationCount) ||
    locationCount < 1 ||
    locationCount > MAXIMUM_LOCATIONS
  ) {
    throw new RangeError("Previous Runs location count must be between 1 and 100");
  }

  // require one bounded inclusive chunk duration
  if (
    !Number.isSafeInteger(inclusiveDays) ||
    inclusiveDays < 1 ||
    inclusiveDays > OPEN_METEO_PREVIOUS_RUNS_MAXIMUM_CHUNK_DAYS
  ) {
    throw new RangeError("Previous Runs inclusive days must be between 1 and 14");
  }

  return Number(
    (
      locationCount *
      (inclusiveDays / OPEN_METEO_PREVIOUS_RUNS_MAXIMUM_CHUNK_DAYS) *
      (OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES.length / 10)
    ).toFixed(6),
  );
}

// build one bounded Previous Runs request
export function buildOpenMeteoPreviousRunsRequest(
  input: OpenMeteoPreviousRunsRequest,
): ProviderRequestPlan {
  return buildPreviousRunsRequest(input, PREVIOUS_RUNS_ENDPOINT);
}

// fetch and normalize fixed-lead anchors
export async function fetchOpenMeteoPreviousRuns(
  input: OpenMeteoPreviousRunsRequest,
  options: ProviderFetchOptions = {},
): Promise<ProviderBatch<NormalizedForecastAnchorRecord>> {
  return fetchPreviousRuns(input, options, PREVIOUS_RUNS_ENDPOINT);
}

// create an injected Previous Runs operation
export function createOpenMeteoPreviousRunsOperation(
  compatibilityOrigin?: string | null,
): OpenMeteoPreviousRunsOperation {
  const origin = parseOpenMeteoCompatibilityOrigin(compatibilityOrigin);
  const endpoint = origin === null
    ? PREVIOUS_RUNS_ENDPOINT
    : new URL(PREVIOUS_RUNS_PATH, `${origin}/`).toString();

  return async (input, options = {}) =>
    fetchPreviousRuns(input, options, endpoint);
}

// normalize a single-location or positional multi-location payload
export function normalizeOpenMeteoPreviousRunsPayload(
  payload: unknown,
  input: OpenMeteoPreviousRunsRequest,
  receivedAt: string,
): readonly NormalizedForecastAnchorRecord[] {
  return normalizePreviousRunsPayload(payload, input, receivedAt).records;
}

// construct the exact 9-by-7 field list
function previousRunsHourlyVariables(): readonly string[] {
  const variables: string[] = [];

  // retain provider variable order before lead order
  for (const variable of PREVIOUS_RUNS_BASE_VARIABLES) {
    // retain every fixed lead exactly once
    for (const dayOffset of PREVIOUS_RUNS_DAY_OFFSETS) {
      variables.push(previousRunsVariable(variable, dayOffset));
    }
  }

  return variables;
}

// name one provider fixed-lead field
function previousRunsVariable(
  variable: PreviousRunsBaseVariable,
  dayOffset: PreviousRunsDayOffset,
): string {
  return `${variable}_previous_day${dayOffset}`;
}

// build an official or injected request URL
function buildPreviousRunsRequest(
  input: OpenMeteoPreviousRunsRequest,
  endpoint: string,
): ProviderRequestPlan {
  const request = validatePreviousRunsRequest(input);
  const url = new URL(endpoint);
  url.searchParams.set(
    "latitude",
    request.locations.map(
      // retain request-position latitude order
      (location) => String(location.latitude),
    ).join(","),
  );
  url.searchParams.set(
    "longitude",
    request.locations.map(
      // retain request-position longitude order
      (location) => String(location.longitude),
    ).join(","),
  );
  url.searchParams.set("hourly", OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES.join(","));
  url.searchParams.set("models", OPEN_METEO_PREVIOUS_RUNS_MODEL);
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("start_date", request.startDate);
  url.searchParams.set("end_date", request.endDate);

  return {
    adapterVersion: OPEN_METEO_PREVIOUS_RUNS_ADAPTER_VERSION,
    capability: "historical",
    sourceKind: "forecast",
    url,
  };
}

// execute one Previous Runs HTTP request
async function fetchPreviousRuns(
  input: OpenMeteoPreviousRunsRequest,
  options: ProviderFetchOptions,
  endpoint: string,
): Promise<ProviderBatch<NormalizedForecastAnchorRecord>> {
  const plan = buildPreviousRunsRequest(input, endpoint);
  const response = await fetchJsonWithRetry(plan.url, options);
  const receivedAt = (options.now ?? defaultNow)().toISOString();
  const normalized = normalizePreviousRunsPayload(
    response.payload,
    input,
    receivedAt,
  );

  return {
    attempts: response.attempts,
    checksum: response.checksum,
    providerCursor: null,
    records: normalized.records,
    responseMetadata: previousRunsResponseMetadata(
      response,
      input,
      normalized,
    ),
  };
}

// validate the full provider response and anchor set
function normalizePreviousRunsPayload(
  payload: unknown,
  input: OpenMeteoPreviousRunsRequest,
  receivedAt: string,
): PreviousRunsNormalization {
  const request = validatePreviousRunsRequest(input);
  const normalizedReceivedAt = validateUtcInstant(receivedAt, "receivedAt");
  const roots = previousRunsResponseRoots(payload, request.locations.length);
  const countsByLead = initialAnchorCounts();
  const records: NormalizedForecastAnchorRecord[] = [];

  // bind each provider response by request position
  for (let locationIndex = 0; locationIndex < roots.length; locationIndex += 1) {
    const root = roots[locationIndex];
    const location = request.locations[locationIndex];

    // reject impossible positional drift after count validation
    if (root === undefined || location === undefined) {
      throw invalidPayload("Previous Runs positional response binding failed");
    }

    const locationRecords = normalizePreviousRunsLocation(
      root,
      location,
      request,
      normalizedReceivedAt,
      countsByLead,
    );
    records.push(...locationRecords);
  }

  // reject a chunk with no usable fixed anchor
  if (records.length === 0) {
    throw invalidPayload("Previous Runs chunk contained no populated anchors");
  }

  return { countsByLead, records, roots };
}

// normalize one positional location response
function normalizePreviousRunsLocation(
  root: Record<string, unknown>,
  location: OpenMeteoPreviousRunsLocation,
  request: OpenMeteoPreviousRunsRequest,
  receivedAt: string,
  countsByLead: Map<number, PreviousRunsAnchorCounts>,
): readonly NormalizedForecastAnchorRecord[] {
  const hourly = requireObject(root.hourly, "hourly");
  const units = requireObject(root.hourly_units, "hourly_units");
  const envelope = parsePreviousRunsEnvelope(root);
  const times = requireArray(hourly.time, "hourly.time");
  const maximumProviderHours = inclusiveDateSpanDays(
    request.startDate,
    request.endDate,
  ) * 24;

  // require every requested UTC hour even when its metrics are null
  if (times.length !== maximumProviderHours) {
    throw invalidPayload("Previous Runs hourly.time does not cover every requested hour");
  }

  const arrays = previousRunsMetricArrays(hourly, units, times.length);
  const records: NormalizedForecastAnchorRecord[] = [];
  const observedTimes = new Set<string>();
  let previousValidAt: string | null = null;

  // retain each provider valid hour once
  for (let timeIndex = 0; timeIndex < times.length; timeIndex += 1) {
    const validAt = parsePreviousRunsTime(
      requireString(times[timeIndex], `hourly.time[${timeIndex}]`),
    );
    assertRequestedValidAt(validAt, request.startDate, request.endDate);
    const expectedValidAt = new Date(
      Date.parse(`${request.startDate}T00:00:00.000Z`) + timeIndex * 3_600_000,
    ).toISOString();

    // reject duplicate provider valid hours
    if (observedTimes.has(validAt)) {
      throw invalidPayload("Previous Runs hourly.time contains duplicate instants");
    }

    // require chronological provider time order
    if (previousValidAt !== null && validAt <= previousValidAt) {
      throw invalidPayload("Previous Runs hourly.time must be strictly increasing");
    }

    // reject gaps or shifted hourly axes
    if (validAt !== expectedValidAt) {
      throw invalidPayload("Previous Runs hourly.time does not match the requested hourly axis");
    }

    observedTimes.add(validAt);
    previousValidAt = validAt;

    // expand one valid hour into fixed lead anchors
    for (const dayOffset of PREVIOUS_RUNS_DAY_OFFSETS) {
      const leadHours = dayOffset * 24;
      const values = previousRunsValues(arrays, timeIndex, dayOffset);
      const counts = requireAnchorCounts(countsByLead, leadHours);

      // omit only entirely null anchors
      if (Object.values(values).every(
        // recognize provider-null metric cells
        (value) => value === null,
      )) {
        countsByLead.set(leadHours, {
          null: counts.null + 1,
          populated: counts.populated,
          requested: counts.requested + 1,
        });
        continue;
      }

      const metrics = normalizePreviousRunsMetrics(values);
      const record = createPreviousRunsAnchor({
        envelope,
        leadHours,
        location,
        metrics,
        receivedAt,
        request,
        validAt,
      });
      records.push(record);
      countsByLead.set(leadHours, {
        null: counts.null,
        populated: counts.populated + 1,
        requested: counts.requested + 1,
      });
    }
  }

  return records;
}

// create one validated anchor without a run instant
function createPreviousRunsAnchor(input: Readonly<{
  envelope: PreviousRunsEnvelope;
  leadHours: number;
  location: OpenMeteoPreviousRunsLocation;
  metrics: CanonicalWeatherMetrics;
  receivedAt: string;
  request: OpenMeteoPreviousRunsRequest;
  validAt: string;
}>): NormalizedForecastAnchorRecord {
  try {
    return createNormalizedForecastAnchorRecord({
      adapterVersion: OPEN_METEO_PREVIOUS_RUNS_ADAPTER_VERSION,
      contractEpoch: input.request.contractEpoch,
      dataset: OPEN_METEO_PREVIOUS_RUNS_DATASET,
      leadHours: parseFixedForecastLeadHours(input.leadHours),
      metadata: {
        device: null,
        model: OPEN_METEO_PREVIOUS_RUNS_MODEL,
        provider: {
          dataset: OPEN_METEO_PREVIOUS_RUNS_DATASET,
          ...(input.envelope.elevation === null
            ? {}
            : { elevation_m: input.envelope.elevation }),
          grid_cell: `${input.envelope.latitude},${input.envelope.longitude}`,
        },
        quality: null,
        upstreamTimezone: "UTC",
      },
      metrics: input.metrics,
      receivedAt: input.receivedAt,
      sourceConfigFingerprint: input.location.sourceConfigFingerprint,
      sourceId: input.location.sourceId,
      upstreamModel: OPEN_METEO_PREVIOUS_RUNS_MODEL,
      validAt: input.validAt,
    });
  } catch (error) {
    // preserve already-classified provider failures
    if (error instanceof ProviderFailure) {
      throw error;
    }

    throw invalidPayload("Previous Runs anchor violates the fixed-anchor contract");
  }
}

// normalize exactly the nine requested weather metrics
function normalizePreviousRunsMetrics(
  values: Record<PreviousRunsBaseVariable, unknown>,
): CanonicalWeatherMetrics {
  try {
    const direction = requireNullableNumber(
      values.wind_direction_10m,
      "wind_direction_10m",
    );

    return {
      apparentTemperatureC: normalizeMetricValue(
        "apparentTemperatureC",
        requireNullableNumber(values.apparent_temperature, "apparent_temperature"),
        "c",
      ),
      blackGlobeTemperatureC: null,
      cloudCoverPercent: normalizeMetricValue(
        "cloudCoverPercent",
        requireNullableNumber(values.cloud_cover, "cloud_cover"),
        "percent",
      ),
      pm25MicrogramsPerCubicMeter: null,
      precipitationMm: normalizeMetricValue(
        "precipitationMm",
        requireNullableNumber(values.precipitation, "precipitation"),
        "millimeter",
      ),
      precipitationRateMmPerHour: null,
      pressureHpa: normalizeMetricValue(
        "pressureHpa",
        requireNullableNumber(values.surface_pressure, "surface_pressure"),
        "hectopascal",
      ),
      relativeHumidityPercent: normalizeMetricValue(
        "relativeHumidityPercent",
        requireNullableNumber(values.relative_humidity_2m, "relative_humidity_2m"),
        "percent",
      ),
      soilElectricalConductivityMicrosiemensPerCm: null,
      soilMoisturePercent: null,
      solarRadiationWm2: null,
      temperatureC: normalizeMetricValue(
        "temperatureC",
        requireNullableNumber(values.temperature_2m, "temperature_2m"),
        "c",
      ),
      uvIndex: null,
      waterLevelM: null,
      windDirectionDegrees: normalizeMetricValue(
        "windDirectionDegrees",
        direction === 360 ? 0 : direction,
        "degree",
      ),
      windGustMps: normalizeMetricValue(
        "windGustMps",
        requireNullableNumber(values.wind_gusts_10m, "wind_gusts_10m"),
        "meter_per_second",
      ),
      windSpeedMps: normalizeMetricValue(
        "windSpeedMps",
        requireNullableNumber(values.wind_speed_10m, "wind_speed_10m"),
        "meter_per_second",
      ),
      wetBulbGlobeTemperatureC: null,
    };
  } catch (error) {
    // preserve precise provider-shape failures
    if (error instanceof ProviderFailure) {
      throw error;
    }

    throw invalidPayload("Previous Runs metrics violate canonical bounds");
  }
}

// collect one lead's positional values
function previousRunsValues(
  arrays: Readonly<Record<string, readonly unknown[]>>,
  timeIndex: number,
  dayOffset: PreviousRunsDayOffset,
): Record<PreviousRunsBaseVariable, unknown> {
  return Object.fromEntries(
    PREVIOUS_RUNS_BASE_VARIABLES.map(
      // select the matching suffixed array cell
      (variable) => {
        const values = arrays[previousRunsVariable(variable, dayOffset)];

        // require the array proven by the shape validator
        if (values === undefined) {
          throw new Error("Previous Runs metric array is missing after validation");
        }

        return [variable, values[timeIndex]];
      },
    ),
  ) as Record<PreviousRunsBaseVariable, unknown>;
}

// validate every suffixed metric array and unit
function previousRunsMetricArrays(
  hourly: Record<string, unknown>,
  units: Record<string, unknown>,
  expectedLength: number,
): Readonly<Record<string, readonly unknown[]>> {
  const arrays: Record<string, readonly unknown[]> = {};
  const expectedFields = new Set([
    "time",
    ...OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES,
  ]);

  // reject unrequested or invalid lead fields
  if (
    Object.keys(hourly).some(
      // require only the exact requested hourly response keys
      (field) => !expectedFields.has(field),
    ) ||
    Object.keys(units).some(
      // require only the exact requested unit response keys
      (field) => !expectedFields.has(field),
    )
  ) {
    throw invalidPayload("Previous Runs response contains an unexpected hourly field");
  }

  requireExactUnit(units.time, "iso8601", "hourly_units.time");

  // inspect every requested base variable
  for (const variable of PREVIOUS_RUNS_BASE_VARIABLES) {
    // inspect all seven fixed leads
    for (const dayOffset of PREVIOUS_RUNS_DAY_OFFSETS) {
      const field = previousRunsVariable(variable, dayOffset);
      const values = requireArray(hourly[field], `hourly.${field}`);

      // reject positional drift from the time axis
      if (values.length !== expectedLength) {
        throw invalidPayload(`hourly.${field} length does not match hourly.time`);
      }

      requireExactUnit(
        units[field],
        PREVIOUS_RUNS_EXPECTED_UNITS[variable],
        `hourly_units.${field}`,
      );
      arrays[field] = values;
    }
  }

  return arrays;
}

// parse the UTC-only response envelope
function parsePreviousRunsEnvelope(
  root: Record<string, unknown>,
): PreviousRunsEnvelope {
  const latitude = requireNumber(root.latitude, "latitude");
  const longitude = requireNumber(root.longitude, "longitude");
  const timezone = requireString(root.timezone, "timezone");
  const utcOffsetSeconds = requireNumber(
    root.utc_offset_seconds,
    "utc_offset_seconds",
  );

  try {
    validateCoordinates(latitude, longitude);
    validateTimeZone(timezone);
  } catch {
    throw invalidPayload("Previous Runs envelope has invalid location metadata");
  }

  // accept the documented UTC request label or its GMT response alias
  if ((timezone !== "UTC" && timezone !== "GMT") || utcOffsetSeconds !== 0) {
    throw invalidPayload("Previous Runs response must use a zero-offset UTC or GMT envelope");
  }

  return {
    elevation:
      root.elevation === undefined || root.elevation === null
        ? null
        : requireNumber(root.elevation, "elevation"),
    latitude,
    longitude,
    timezone,
  };
}

// select the exact response-root shape for the coordinate count
function previousRunsResponseRoots(
  payload: unknown,
  locationCount: number,
): readonly Record<string, unknown>[] {
  // require an object for the single-coordinate contract
  if (locationCount === 1) {
    const root = requireObject(payload, "Open-Meteo Previous Runs response");
    assertResponseLocationId(root, 0);
    return [root];
  }

  const responses = requireArray(
    payload,
    "Open-Meteo Previous Runs multi-location response",
  );

  // reject missing or extra positional responses
  if (responses.length !== locationCount) {
    throw invalidPayload("Previous Runs response count does not match request positions");
  }

  const roots = responses.map(
    // bind each object by its array position
    (response, index) => requireObject(response, `responses[${index}]`),
  );

  // verify optional provider position markers without reordering
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];

    // require the root proven by the response count
    if (root === undefined) {
      throw invalidPayload("Previous Runs positional response is missing");
    }

    assertResponseLocationId(root, index);
  }

  return roots;
}

// verify an optional zero-based provider position marker
function assertResponseLocationId(
  root: Record<string, unknown>,
  index: number,
): void {
  const locationId = root.location_id;

  // permit the first response to omit its zero marker
  if (index === 0 && (locationId === undefined || locationId === 0)) {
    return;
  }

  // require every explicit marker to match request position
  if (locationId !== index) {
    throw invalidPayload("Previous Runs location_id does not match request position");
  }
}

// validate request identity dates and locations
function validatePreviousRunsRequest(
  input: OpenMeteoPreviousRunsRequest,
): OpenMeteoPreviousRunsRequest {
  validateDate(input.startDate, "startDate");
  validateDate(input.endDate, "endDate");

  // require an ordered inclusive range of at most fourteen days
  if (
    input.startDate > input.endDate ||
    inclusiveDateSpanDays(input.startDate, input.endDate) >
      OPEN_METEO_PREVIOUS_RUNS_MAXIMUM_CHUNK_DAYS
  ) {
    throw new RangeError(
      "Previous Runs dates must be ordered within a 14-day inclusive range",
    );
  }

  // require the frozen v1 contract epoch
  if (input.contractEpoch !== OPEN_METEO_PREVIOUS_RUNS_CONTRACT_EPOCH) {
    throw new RangeError("Previous Runs contractEpoch is not supported");
  }

  // require a bounded nonempty positional location set
  if (
    !Array.isArray(input.locations) ||
    input.locations.length < 1 ||
    input.locations.length > MAXIMUM_LOCATIONS
  ) {
    throw new RangeError("Previous Runs locations must contain between 1 and 100 entries");
  }

  const locations = input.locations.map(
    // validate every position before URL generation
    (location, index) => validatePreviousRunsLocation(location, index),
  );

  // require one storage identity per positional location
  if (new Set(locations.map(
    // project stable storage identities
    (location) => location.sourceId,
  )).size !== locations.length) {
    throw new RangeError("Previous Runs location sourceId values must be unique");
  }

  return { ...input, locations };
}

// validate one positional location identity
function validatePreviousRunsLocation(
  location: OpenMeteoPreviousRunsLocation,
  index: number,
): OpenMeteoPreviousRunsLocation {
  const coordinates = validateCoordinates(location.latitude, location.longitude);

  // require a bounded storage source identity
  if (location.sourceId.trim().length === 0 || location.sourceId.length > 128) {
    throw new RangeError(`locations[${index}].sourceId must be non-empty and bounded`);
  }

  return {
    ...coordinates,
    sourceConfigFingerprint: validateSha256Hex(
      location.sourceConfigFingerprint,
      `locations[${index}].sourceConfigFingerprint`,
    ),
    sourceId: location.sourceId,
  };
}

// parse one zero-offset hourly provider time
function parsePreviousRunsTime(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):00(?::00)?$/u.exec(value);

  // require a complete hourly ISO wall time
  if (match === null) {
    throw invalidPayload("Previous Runs time must use UTC hourly ISO precision");
  }

  const instant = new Date(`${value}Z`);

  // reject invalid or rolled-over timestamps
  if (
    Number.isNaN(instant.getTime()) ||
    instant.getUTCFullYear() !== Number(match[1]) ||
    instant.getUTCMonth() + 1 !== Number(match[2]) ||
    instant.getUTCDate() !== Number(match[3]) ||
    instant.getUTCHours() !== Number(match[4])
  ) {
    throw invalidPayload("Previous Runs time is invalid");
  }

  return instant.toISOString();
}

// keep provider hours inside the inclusive UTC date request
function assertRequestedValidAt(
  validAt: string,
  startDate: string,
  endDate: string,
): void {
  const value = Date.parse(validAt);
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${addCalendarDays(endDate, 1)}T00:00:00.000Z`);

  // reject out-of-window provider rows
  if (value < start || value >= end) {
    throw invalidPayload("Previous Runs time falls outside the requested UTC dates");
  }
}

// initialize bounded counts for every fixed lead
function initialAnchorCounts(): Map<number, PreviousRunsAnchorCounts> {
  return new Map(
    PREVIOUS_RUNS_DAY_OFFSETS.map(
      // start every fixed lead at zero
      (dayOffset) => [
        dayOffset * 24,
        { null: 0, populated: 0, requested: 0 },
      ],
    ),
  );
}

// require one known lead counter
function requireAnchorCounts(
  countsByLead: ReadonlyMap<number, PreviousRunsAnchorCounts>,
  leadHours: number,
): PreviousRunsAnchorCounts {
  const counts = countsByLead.get(leadHours);

  // reject impossible internal lead drift
  if (counts === undefined) {
    throw new Error("Previous Runs lead counter is missing");
  }

  return counts;
}

// expose bounded request and null-population evidence
function previousRunsResponseMetadata(
  response: JsonResponse,
  input: OpenMeteoPreviousRunsRequest,
  normalized: PreviousRunsNormalization,
): Readonly<Record<string, JsonValue>> {
  const locationCount = input.locations.length;
  const counts = [...normalized.countsByLead.entries()];
  const requested = counts.reduce(
    // total requested lead cells
    (total, [, value]) => total + value.requested,
    0,
  );
  const populated = counts.reduce(
    // total emitted lead cells
    (total, [, value]) => total + value.populated,
    0,
  );
  const nullAnchors = counts.reduce(
    // total omitted all-null lead cells
    (total, [, value]) => total + value.null,
    0,
  );
  const countsByLeadJson = Object.fromEntries(
    counts.map(
      // retain the seven fixed counters only
      ([leadHours, value]) => [
        String(leadHours),
        {
          null: value.null,
          populated: value.populated,
          requested: value.requested,
        },
      ],
    ),
  ) as unknown as Readonly<Record<string, JsonValue>>;
  const generationMilliseconds = normalized.roots.reduce(
    // total only valid reported generation durations
    (total, root) =>
      typeof root.generationtime_ms === "number" &&
      Number.isFinite(root.generationtime_ms) &&
      root.generationtime_ms >= 0
        ? total + root.generationtime_ms
        : total,
    0,
  );

  return {
    anchor_counts_by_lead: countsByLeadJson,
    data_modification: OPEN_METEO_PREVIOUS_RUNS_MODIFICATION_NOTICE,
    generation_ms: generationMilliseconds,
    http_status: response.status,
    location_response_count: normalized.roots.length,
    null_anchor_count: nullAnchors,
    populated_anchor_count: populated,
    requested_anchor_count: requested,
    requested_location_count: locationCount,
    selected_field_count: OPEN_METEO_PREVIOUS_RUNS_HOURLY_VARIABLES.length,
    upstream_http_response_count: 1,
    weighted_api_call_cost:
      openMeteoPreviousRunsWeightedApiCallCost(
        locationCount,
        inclusiveDateSpanDays(input.startDate, input.endDate),
      ),
    wind_gust_interval: OPEN_METEO_PREVIOUS_RUNS_WIND_GUST_INTERVAL,
  };
}

// validate response objects
function requireObject(value: unknown, fieldName: string): Record<string, unknown> {
  // reject arrays and nulls
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidPayload(`${fieldName} must be an object`);
  }

  return value as Record<string, unknown>;
}

// validate response arrays
function requireArray(value: unknown, fieldName: string): readonly unknown[] {
  // reject missing arrays
  if (!Array.isArray(value)) {
    throw invalidPayload(`${fieldName} must be an array`);
  }

  return value;
}

// validate response strings
function requireString(value: unknown, fieldName: string): string {
  // reject empty strings
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidPayload(`${fieldName} must be a non-empty string`);
  }

  return value;
}

// validate response numbers
function requireNumber(value: unknown, fieldName: string): number {
  // reject non-finite numbers
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidPayload(`${fieldName} must be a finite number`);
  }

  return value;
}

// validate nullable provider metrics
function requireNullableNumber(value: unknown, fieldName: string): number | null {
  // retain documented missing forecast horizons
  if (value === null) {
    return null;
  }

  return requireNumber(value, fieldName);
}

// reject silent provider-unit drift
function requireExactUnit(
  value: unknown,
  expected: string,
  fieldName: string,
): void {
  // require the literal requested unit
  if (value !== expected) {
    throw invalidPayload(`${fieldName} unit must be ${expected}`);
  }
}

// validate one UTC calendar date
function validateDate(value: string, fieldName: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`);

  // reject malformed or rolled-over dates
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new RangeError(`${fieldName} must use a valid YYYY-MM-DD date`);
  }

  return value;
}

// calculate one inclusive UTC date span
function inclusiveDateSpanDays(startDate: string, endDate: string): number {
  return (
    (Date.parse(`${endDate}T00:00:00.000Z`) -
      Date.parse(`${startDate}T00:00:00.000Z`)) /
      MILLISECONDS_PER_DAY +
    1
  );
}

// add one UTC calendar-day offset
function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

// create one bounded non-retryable payload failure
function invalidPayload(message: string): ProviderFailure {
  return new ProviderFailure({
    classification: "invalid_payload",
    code: "invalid_payload",
    message: message.slice(0, 512),
  });
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}
