import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import {
  getCurrentWeather,
  listActiveSites,
  listWeatherHistory,
  type HistoryQuery,
  type WeatherRecordRow,
} from "@weather/database";
import {
  parseSourceKind,
  sourceKindLabel,
  validateStableKey,
  validateUtcInstant,
  type SourceKind,
  type StationKind,
} from "@weather/domain";

type DatabasePool = Parameters<typeof listActiveSites>[0];

export interface ActiveSiteRow {
  readonly attributionLabel: string;
  readonly attributionUrl: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly providerKey: string;
  readonly providerName: string;
  readonly siteName: string;
  readonly siteSlug: string;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly sourceKind: SourceKind;
  readonly stationKind: StationKind;
  readonly stationName: string;
  readonly stationSlug: string;
  readonly timezone: string;
}

export interface WeatherReadStore {
  getCurrent(
    siteSlug: string,
    sourceId?: string,
  ): Promise<readonly WeatherRecordRow[]>;
  listHistory(query: HistoryQuery): Promise<readonly WeatherRecordRow[]>;
  listSites(): Promise<readonly ActiveSiteRow[]>;
}

export interface ApiSource {
  readonly attribution: {
    readonly label: string;
    readonly url: string;
  };
  readonly id: string;
  readonly key: string;
  readonly kind: SourceKind;
  readonly providerKey: string;
  readonly providerName: string;
  readonly provenanceLabel: string;
}

export interface ApiStation {
  readonly kind: StationKind;
  readonly name: string;
  readonly slug: string;
  readonly sources: readonly ApiSource[];
}

export interface ApiSite {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string;
  readonly slug: string;
  readonly stations: readonly ApiStation[];
  readonly timezone: string;
}

export interface ApiWeatherRecord {
  readonly freshness: {
    readonly ageSeconds: number;
    readonly label: string;
    readonly status: "delayed" | "fresh" | "stale";
  };
  readonly id: string;
  readonly metrics: {
    readonly apparentTemperatureC: number | null;
    readonly cloudCoverPercent: number | null;
    readonly precipitationMm: number | null;
    readonly pressureHpa: number | null;
    readonly relativeHumidityPercent: number | null;
    readonly temperatureC: number | null;
    readonly windDirectionDegrees: number | null;
    readonly windGustMps: number | null;
    readonly windSpeedMps: number | null;
  };
  readonly productRunAt: string | null;
  readonly provenance: {
    readonly attribution: {
      readonly label: string;
      readonly url: string;
    };
    readonly label: string;
    readonly providerKey: string;
    readonly sourceId: string;
    readonly sourceKey: string;
    readonly sourceKind: SourceKind;
    readonly stationSlug: string;
  };
  readonly receivedAt: string;
  readonly revisionCount: number;
  readonly validAt: string;
}

export interface ApiOptions {
  readonly now?: () => Date;
}

interface MutableStation {
  readonly kind: StationKind;
  readonly name: string;
  readonly slug: string;
  readonly sources: ApiSource[];
}

interface MutableSite {
  readonly latitude: number;
  readonly longitude: number;
  readonly name: string;
  readonly slug: string;
  readonly stations: Map<string, MutableStation>;
  readonly timezone: string;
}

interface ParsedHistoryQuery {
  readonly query: HistoryQuery;
  readonly requestedLimit: number;
}

interface SourceDetails {
  readonly attribution: ApiSource["attribution"];
  readonly key: string;
  readonly providerKey: string;
}

const HISTORY_DEFAULT_LIMIT = 25;
const HISTORY_MAX_LIMIT = 100;
const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const;

// represent an intentional client-visible failure
class HttpError extends Error {
  readonly code: string;
  readonly status: number;

  // retain a stable response code
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.status = status;
  }
}

// bind the API to frozen database read functions
export function createDatabaseWeatherReadStore(
  pool: DatabasePool,
): WeatherReadStore {
  return {
    // read the newest rows
    async getCurrent(siteSlug, sourceId) {
      return await getCurrentWeather(pool, siteSlug, sourceId);
    },
    // read a bounded page
    async listHistory(query) {
      return await listWeatherHistory(pool, query);
    },
    // read active metadata
    async listSites() {
      return (await listActiveSites(pool)) as readonly ActiveSiteRow[];
    },
  };
}

// create the fetch-compatible API boundary
export function createWeatherApi(
  store: WeatherReadStore,
  options: ApiOptions = {},
): (request: Request) => Promise<Response> {
  const now = options.now ?? Date;

  // route one request
  return async function handleWeatherRequest(request: Request): Promise<Response> {
    try {
      // keep the public surface read-only
      if (request.method !== "GET") {
        return jsonResponse(
          { error: { code: "method_not_allowed", message: "Only GET is supported" } },
          405,
          { allow: "GET" },
        );
      }

      const url = new URL(request.url);
      const segments = parsePathSegments(url.pathname);

      // list configured sites
      if (segments.length === 1 && segments[0] === "sites") {
        rejectUnexpectedParameters(url.searchParams, new Set());
        const sites = groupSites(await store.listSites());
        return jsonResponse({ data: sites });
      }

      // route site-specific reads
      if (segments.length === 3 && segments[0] === "sites") {
        const siteSlug = validateStableKey(segments[1] ?? "", "siteSlug");
        const resource = segments[2];
        const sites = groupSites(await store.listSites());
        const site = findSite(sites, siteSlug);

        // read current values
        if (resource === "current") {
          rejectUnexpectedParameters(url.searchParams, new Set(["source"]));
          const sourceId = parseOptionalSourceId(url.searchParams, "source");
          const rows = await store.getCurrent(siteSlug, sourceId);
          const generatedAt = now().toISOString();
          const sources = indexSources(site);
          const records = mapWeatherRecords(rows, sources, generatedAt);
          return jsonResponse({ data: records, generatedAt, site });
        }

        // read filtered history
        if (resource === "history") {
          const parsed = parseHistoryQuery(url.searchParams, siteSlug);
          const rows = await store.listHistory(parsed.query);
          const hasMore = rows.length > parsed.requestedLimit;
          const visibleRows = hasMore ? rows.slice(0, parsed.requestedLimit) : rows;
          const generatedAt = now().toISOString();
          const sources = indexSources(site);
          const records = mapWeatherRecords(visibleRows, sources, generatedAt);
          const last = visibleRows.at(-1);
          const nextCursor =
            hasMore && last !== undefined
              ? encodeCursor({ id: last.id, validAt: last.validAt })
              : null;
          return jsonResponse({
            data: records,
            generatedAt,
            page: { limit: parsed.requestedLimit, nextCursor },
            site,
          });
        }
      }

      throw new HttpError(404, "not_found", "Endpoint not found");
    } catch (error) {
      return errorResponse(error);
    }
  };
}

// adapt the fetch handler to a Node HTTP server
export function createWeatherApiServer(
  handler: (request: Request) => Promise<Response>,
): Server {
  // bridge one Node request
  return createServer(async (incoming, outgoing) => {
    try {
      const host = incoming.headers.host ?? "localhost";
      const request = new Request(
        `http://${host}${incoming.url ?? "/"}`,
        {
          headers: toFetchHeaders(incoming.headers),
          method: incoming.method ?? "GET",
        },
      );
      const response = await handler(request);
      outgoing.statusCode = response.status;

      // copy response headers
      response.headers.forEach((value, name) => {
        outgoing.setHeader(name, value);
      });

      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.statusCode = 500;
      outgoing.setHeader("content-type", JSON_HEADERS["content-type"]);
      outgoing.end(
        JSON.stringify({
          error: { code: "internal_error", message: "Unexpected server error" },
        }),
      );
    }
  });
}

// collect active rows into a stable nested contract
function groupSites(rows: readonly ActiveSiteRow[]): readonly ApiSite[] {
  const sites = new Map<string, MutableSite>();

  // group every metadata row
  for (const row of rows) {
    let site = sites.get(row.siteSlug);

    // create the site once
    if (site === undefined) {
      site = {
        latitude: row.latitude,
        longitude: row.longitude,
        name: row.siteName,
        slug: row.siteSlug,
        stations: new Map(),
        timezone: row.timezone,
      };
      sites.set(row.siteSlug, site);
    }

    let station = site.stations.get(row.stationSlug);

    // create the station once
    if (station === undefined) {
      station = {
        kind: row.stationKind,
        name: row.stationName,
        slug: row.stationSlug,
        sources: [],
      };
      site.stations.set(row.stationSlug, station);
    }

    station.sources.push({
      attribution: {
        label: row.attributionLabel,
        url: row.attributionUrl,
      },
      id: row.sourceId,
      key: row.sourceKey,
      kind: row.sourceKind,
      providerKey: row.providerKey,
      providerName: row.providerName,
      provenanceLabel: sourceKindLabel(row.sourceKind),
    });
  }

  const result: ApiSite[] = [];

  // freeze map-backed stations into arrays
  for (const site of sites.values()) {
    result.push({
      latitude: site.latitude,
      longitude: site.longitude,
      name: site.name,
      slug: site.slug,
      stations: Array.from(site.stations.values()),
      timezone: site.timezone,
    });
  }

  return result;
}

// require the requested active site
function findSite(sites: readonly ApiSite[], siteSlug: string): ApiSite {
  const site = sites.find(
    // compare stable slugs
    (candidate) => candidate.slug === siteSlug,
  );

  // distinguish unknown sites from empty datasets
  if (site === undefined) {
    throw new HttpError(404, "site_not_found", `Unknown site: ${siteSlug}`);
  }

  return site;
}

// index source metadata for provenance enrichment
function indexSources(site: ApiSite): ReadonlyMap<string, SourceDetails> {
  const sources = new Map<string, SourceDetails>();

  // visit every station
  for (const station of site.stations) {
    // visit every source
    for (const source of station.sources) {
      sources.set(source.id, {
        attribution: source.attribution,
        key: source.key,
        providerKey: source.providerKey,
      });
    }
  }

  return sources;
}

// map storage rows into the public weather contract
function mapWeatherRecords(
  rows: readonly WeatherRecordRow[],
  sources: ReadonlyMap<string, SourceDetails>,
  generatedAt: string,
): readonly ApiWeatherRecord[] {
  const records: ApiWeatherRecord[] = [];

  // enrich each storage row
  for (const row of rows) {
    const source = sources.get(row.sourceId);

    // fail closed on inconsistent metadata
    if (source === undefined) {
      throw new Error(`Missing active metadata for source ${row.sourceId}`);
    }

    records.push({
      freshness: describeFreshness(row.validAt, generatedAt),
      id: row.id,
      metrics: {
        apparentTemperatureC: row.apparentTemperatureC,
        cloudCoverPercent: row.cloudCoverPercent,
        precipitationMm: row.precipitationMm,
        pressureHpa: row.pressureHpa,
        relativeHumidityPercent: row.relativeHumidityPercent,
        temperatureC: row.temperatureC,
        windDirectionDegrees: row.windDirectionDegrees,
        windGustMps: row.windGustMps,
        windSpeedMps: row.windSpeedMps,
      },
      productRunAt: row.productRunAt,
      provenance: {
        attribution: source.attribution,
        label: sourceKindLabel(row.sourceKind),
        providerKey: source.providerKey,
        sourceId: row.sourceId,
        sourceKey: source.key,
        sourceKind: row.sourceKind,
        stationSlug: row.stationSlug,
      },
      receivedAt: row.lastReceivedAt,
      revisionCount: row.revisionCount,
      validAt: row.validAt,
    });
  }

  return records;
}

// describe recency without implying a physical observation
function describeFreshness(
  validAt: string,
  generatedAt: string,
): ApiWeatherRecord["freshness"] {
  const ageSeconds = Math.max(
    0,
    Math.floor((Date.parse(generatedAt) - Date.parse(validAt)) / 1_000),
  );

  // mark values within two source cadences as fresh
  if (ageSeconds <= 1_800) {
    return { ageSeconds, label: "Model value is current", status: "fresh" };
  }

  // call out a moderate delay explicitly
  if (ageSeconds <= 7_200) {
    return { ageSeconds, label: "Model value is delayed", status: "delayed" };
  }

  return { ageSeconds, label: "Model value may be stale", status: "stale" };
}

// parse and validate history filters
function parseHistoryQuery(
  parameters: URLSearchParams,
  siteSlug: string,
): ParsedHistoryQuery {
  rejectUnexpectedParameters(
    parameters,
    new Set(["cursor", "from", "kind", "limit", "source", "station", "to"]),
  );
  const requestedLimit = parseLimit(parameters);
  const cursorValue = getOptionalParameter(parameters, "cursor");
  const fromValue = getOptionalParameter(parameters, "from");
  const kindValue = getOptionalParameter(parameters, "kind");
  const sourceId = parseOptionalSourceId(parameters, "source");
  const stationValue = getOptionalParameter(parameters, "station");
  const toValue = getOptionalParameter(parameters, "to");
  const query: HistoryQuery = {
    limit: requestedLimit + 1,
    siteSlug,
  };

  // apply the cursor
  if (cursorValue !== undefined) {
    Object.assign(query, { cursor: decodeCursor(cursorValue) });
  }

  // apply the lower bound
  if (fromValue !== undefined) {
    Object.assign(query, { from: validateUtcInstant(fromValue, "from") });
  }

  // apply provenance filtering
  if (kindValue !== undefined) {
    Object.assign(query, { sourceKind: parseSourceKind(kindValue) });
  }

  // apply source filtering
  if (sourceId !== undefined) {
    Object.assign(query, { sourceId });
  }

  // apply station filtering
  if (stationValue !== undefined) {
    Object.assign(query, {
      stationSlug: validateStableKey(stationValue, "station"),
    });
  }

  // apply the upper bound
  if (toValue !== undefined) {
    Object.assign(query, { to: validateUtcInstant(toValue, "to") });
  }

  return { query, requestedLimit };
}

// enforce a bounded page size
function parseLimit(parameters: URLSearchParams): number {
  const value = getOptionalParameter(parameters, "limit");

  // use the product default
  if (value === undefined) {
    return HISTORY_DEFAULT_LIMIT;
  }

  // require a canonical positive integer
  if (!/^\d+$/u.test(value)) {
    throw new HttpError(400, "invalid_query", "limit must be an integer");
  }

  const limit = Number(value);

  // retain room for the lookahead row
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HISTORY_MAX_LIMIT) {
    throw new HttpError(
      400,
      "invalid_query",
      `limit must be between 1 and ${String(HISTORY_MAX_LIMIT)}`,
    );
  }

  return limit;
}

// validate an optional bigint identifier
function parseOptionalSourceId(
  parameters: URLSearchParams,
  name: string,
): string | undefined {
  const value = getOptionalParameter(parameters, name);

  // preserve an absent filter
  if (value === undefined) {
    return undefined;
  }

  // require a positive decimal identifier
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new HttpError(400, "invalid_query", `${name} must be a positive integer`);
  }

  return value;
}

// reject duplicate query fields
function getOptionalParameter(
  parameters: URLSearchParams,
  name: string,
): string | undefined {
  const values = parameters.getAll(name);

  // reject ambiguous duplicates
  if (values.length > 1) {
    throw new HttpError(400, "invalid_query", `${name} may be provided once`);
  }

  const value = values[0];

  // treat an empty value as absent
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return value;
}

// reject unsupported filters
function rejectUnexpectedParameters(
  parameters: URLSearchParams,
  allowed: ReadonlySet<string>,
): void {
  // inspect every submitted field
  for (const name of parameters.keys()) {
    // fail closed on misspelled filters
    if (!allowed.has(name)) {
      throw new HttpError(400, "invalid_query", `Unsupported query parameter: ${name}`);
    }
  }
}

// encode a stable pagination cursor
function encodeCursor(cursor: Readonly<{ id: string; validAt: string }>): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

// decode an opaque pagination cursor
function decodeCursor(value: string): Readonly<{ id: string; validAt: string }> {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;

    // require the exact cursor fields
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("id" in parsed) ||
      !("validAt" in parsed) ||
      typeof parsed.id !== "string" ||
      typeof parsed.validAt !== "string" ||
      !/^[1-9]\d*$/u.test(parsed.id)
    ) {
      throw new TypeError("invalid cursor fields");
    }

    return {
      id: parsed.id,
      validAt: validateUtcInstant(parsed.validAt, "cursor.validAt"),
    };
  } catch {
    throw new HttpError(400, "invalid_query", "cursor is invalid");
  }
}

// split and decode a URL path
function parsePathSegments(pathname: string): readonly string[] {
  try {
    const rawSegments = pathname.split("/");
    const segments: string[] = [];

    // retain non-empty path segments
    for (const segment of rawSegments) {
      // ignore separators
      if (segment.length > 0) {
        segments.push(decodeURIComponent(segment));
      }
    }

    return segments;
  } catch {
    throw new HttpError(400, "invalid_path", "Path is not valid UTF-8");
  }
}

// serialize a successful JSON response
function jsonResponse(
  body: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: { ...JSON_HEADERS, ...headers },
    status,
  });
}

// convert failures to bounded public errors
function errorResponse(error: unknown): Response {
  // preserve intentional HTTP errors
  if (error instanceof HttpError) {
    return jsonResponse(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }

  // expose safe validation feedback
  if (error instanceof RangeError || error instanceof TypeError) {
    return jsonResponse(
      { error: { code: "invalid_query", message: error.message } },
      400,
    );
  }

  return jsonResponse(
    { error: { code: "internal_error", message: "Unexpected server error" } },
    500,
  );
}

// convert Node request headers to Fetch headers
function toFetchHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();

  // copy every incoming header
  for (const [name, value] of Object.entries(incoming)) {
    // omit absent values
    if (value === undefined) {
      continue;
    }

    // preserve repeated headers
    if (Array.isArray(value)) {
      // append every value
      for (const entry of value) {
        headers.append(name, entry);
      }
    } else {
      headers.set(name, value);
    }
  }

  return headers;
}
