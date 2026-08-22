import { createServer, type IncomingHttpHeaders, type Server } from "node:http";

import {
  getCurrentWeather,
  getLatestWorkerHeartbeat,
  listActiveSites,
  listWeatherHistory,
  verifyMigrationReadiness,
  type ActiveSiteRow,
  type CurrentQuery,
  type HistoryQuery,
  type WeatherRecordRow,
} from "@weather/database";
import {
  parseSourceKind,
  sourceKindLabel,
  validateStableKey,
  validateUtcInstant,
  type JsonValue,
  type SourceKind,
  type StationKind,
} from "@weather/domain";

type DatabasePool = Parameters<typeof listActiveSites>[0];

export interface HealthSnapshot {
  readonly database: "ready" | "unavailable";
  readonly migration: {
    readonly status: "current" | "outdated" | "unavailable";
    readonly version: string | null;
  };
  readonly workerLastLoopAt: string | null;
}

export interface WeatherReadStore {
  getCurrent(
    siteSlug: string,
    query: CurrentQuery,
  ): Promise<readonly WeatherRecordRow[]>;
  getHealth(): Promise<HealthSnapshot>;
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
  readonly metadata: {
    readonly device: {
      readonly model: string | null;
      readonly serial: string | null;
      readonly vendor: string | null;
    } | null;
    readonly provider: {
      readonly dataset: string | null;
      readonly elevationM: number | null;
      readonly gridCell: string | null;
    } | null;
    readonly quality: {
      readonly confidencePercent: number | null;
      readonly flags: readonly string[] | null;
      readonly interpolation: string | null;
      readonly status: string | null;
    } | null;
    readonly upstream: {
      readonly model: string | null;
      readonly timezone: string;
    };
  };
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
  readonly logDiagnostic?: (diagnostic: ApiDiagnostic) => void;
  readonly now?: () => Date;
  readonly version?: string;
}

export interface ApiDiagnostic {
  readonly errorCode: string | null;
  readonly errorName: string;
  readonly event: "api_request_failed";
  readonly method: string;
  readonly status: number;
}

export interface ApiServerOptions {
  readonly logDiagnostic?: (diagnostic: ApiDiagnostic) => void;
}

export interface DatabaseStoreOptions {
  readonly migrationDirectory: string;
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

// describe one exact public route
type Route =
  | Readonly<{ kind: "health" }>
  | Readonly<{ kind: "sites" }>
  | Readonly<{ kind: "current"; siteSlug: string }>
  | Readonly<{ kind: "history"; siteSlug: string }>;

const HISTORY_DEFAULT_LIMIT = 100;
const HISTORY_MAX_LIMIT = 250;
const WORKER_FRESH_SECONDS = 1_800;
const DIAGNOSTIC_TOKEN = /^[a-zA-Z0-9_:-]{1,64}$/u;
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

// read the production release contract
export function readApiRelease(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const release = environment.WEATHER_RELEASE ?? "development";

  // reject unsafe public release labels
  if (release.trim().length === 0 || release.length > 128) {
    throw new RangeError("WEATHER_RELEASE must be non-empty and bounded");
  }

  return release;
}

// write one redacted diagnostic event
export function writeApiDiagnostic(diagnostic: ApiDiagnostic): void {
  process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
}

// bind the API to frozen database reads
export function createDatabaseWeatherReadStore(
  pool: DatabasePool,
  options: DatabaseStoreOptions,
): WeatherReadStore {
  return {
    // read the newest rows
    async getCurrent(siteSlug, query) {
      return await getCurrentWeather(pool, siteSlug, query);
    },
    // classify readiness without raw errors
    async getHealth() {
      try {
        await pool.query("SELECT 1");
      } catch {
        return unavailableHealth();
      }

      let migration: HealthSnapshot["migration"];

      try {
        const readiness = await verifyMigrationReadiness(
          pool,
          options.migrationDirectory,
        );
        migration = { status: "current", version: readiness.version };
      } catch {
        migration = { status: "outdated", version: null };
      }

      let workerLastLoopAt: string | null = null;

      try {
        const heartbeat = await getLatestWorkerHeartbeat(pool);
        workerLastLoopAt =
          heartbeat === null ? null : toIsoInstant(heartbeat.lastLoopAt);
      } catch {
        workerLastLoopAt = null;
      }

      return { database: "ready", migration, workerLastLoopAt };
    },
    // read a bounded page
    async listHistory(query) {
      return await listWeatherHistory(pool, query);
    },
    // read active metadata
    async listSites() {
      return await listActiveSites(pool);
    },
  };
}

// create the fetch-compatible API boundary
export function createWeatherApi(
  store: WeatherReadStore,
  options: ApiOptions = {},
): (request: Request) => Promise<Response> {
  const logDiagnostic = options.logDiagnostic;
  const now = options.now ?? currentDate;
  const version = options.version ?? "development";

  // route one request
  return async function handleWeatherRequest(request: Request): Promise<Response> {
    let response: Response;

    try {
      const url = new URL(request.url);
      const route = matchRoute(url.pathname);

      // keep every exact endpoint read-only
      if (request.method !== "GET" && request.method !== "HEAD") {
        response = jsonResponse(
          { error: { code: "method_not_allowed", message: "Only GET and HEAD are supported" } },
          405,
          { allow: "GET, HEAD" },
        );
      } else {
        response = await handleReadRoute(store, route, url, now, version);
      }
    } catch (error) {
      response = errorResponse(error);

      // record only non-public failure details
      if (!(error instanceof HttpError) && logDiagnostic !== undefined) {
        emitApiDiagnostic(
          logDiagnostic,
          createApiDiagnostic(error, request.method, response.status),
        );
      }
    }

    return request.method === "HEAD" ? withoutBody(response) : response;
  };
}

// read the current wall clock
function currentDate(): Date {
  return new Date();
}

// adapt the fetch handler to a Node HTTP server
export function createWeatherApiServer(
  handler: (request: Request) => Promise<Response>,
  options: ApiServerOptions = {},
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
    } catch (error) {
      // record only bounded server boundary fields
      if (options.logDiagnostic !== undefined) {
        emitApiDiagnostic(
          options.logDiagnostic,
          createApiDiagnostic(error, incoming.method ?? "GET", 500),
        );
      }

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

// execute one matched read route
async function handleReadRoute(
  store: WeatherReadStore,
  route: Route,
  url: URL,
  now: () => Date,
  version: string,
): Promise<Response> {
  // serve liveness and readiness
  if (route.kind === "health") {
    rejectUnexpectedParameters(url.searchParams, new Set());
    return await healthResponse(store, now().toISOString(), version);
  }

  // serve active site metadata
  if (route.kind === "sites") {
    rejectUnexpectedParameters(url.searchParams, new Set());
    return jsonResponse({ data: groupSites(await store.listSites()) });
  }

  const sites = groupSites(await store.listSites());
  const site = findSite(sites, route.siteSlug);

  // serve selected current rows
  if (route.kind === "current") {
    rejectUnexpectedParameters(url.searchParams, new Set(["source", "station"]));
    const query = parsePublicQuery(
      // parse only the current query boundary
      () => parseCurrentQuery(url.searchParams, site),
    );
    const rows = await store.getCurrent(route.siteSlug, query);
    const generatedAt = now().toISOString();
    const records = mapWeatherRecords(rows, indexSources(site), generatedAt);
    return jsonResponse({ data: records, generatedAt, site });
  }

  const parsed = parsePublicQuery(
    // parse only the history query boundary
    () => parseHistoryQuery(url.searchParams, route.siteSlug, site),
  );
  const rows = await store.listHistory(parsed.query);
  const hasMore = rows.length > parsed.requestedLimit;
  const visibleRows = hasMore ? rows.slice(0, parsed.requestedLimit) : rows;
  const generatedAt = now().toISOString();
  const records = mapWeatherRecords(visibleRows, indexSources(site), generatedAt);
  const last = records.at(-1);
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

// render one safe health response
async function healthResponse(
  store: WeatherReadStore,
  generatedAt: string,
  version: string,
): Promise<Response> {
  let health: HealthSnapshot;

  try {
    health = await store.getHealth();
  } catch {
    health = unavailableHealth();
  }

  const ready =
    health.database === "ready" && health.migration.status === "current";
  const body = {
    data: {
      database: health.database,
      live: true,
      migration: health.migration,
      ready,
      version,
      worker: {
        freshness: describeWorkerFreshness(
          health.workerLastLoopAt,
          generatedAt,
        ),
      },
    },
  };
  return jsonResponse(body, ready ? 200 : 503);
}

// classify a completely unavailable database
function unavailableHealth(): HealthSnapshot {
  return {
    database: "unavailable",
    migration: { status: "unavailable", version: null },
    workerLastLoopAt: null,
  };
}

// classify coarse worker loop freshness
function describeWorkerFreshness(
  lastLoopAt: string | null,
  generatedAt: string,
): "fresh" | "stale" | "unknown" {
  // preserve absent heartbeat state
  if (lastLoopAt === null) {
    return "unknown";
  }

  const ageSeconds = Math.floor(
    (Date.parse(generatedAt) - Date.parse(lastLoopAt)) / 1_000,
  );

  // fail closed on invalid or future heartbeats
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) {
    return "stale";
  }

  return ageSeconds <= WORKER_FRESH_SECONDS ? "fresh" : "stale";
}

// match only the frozen public surface
function matchRoute(pathname: string): Route {
  const segments = parsePathSegments(pathname);

  // match top-level reads
  if (segments.length === 3 && segments[0] === "api" && segments[1] === "v1") {
    // match active site discovery
    if (segments[2] === "sites") {
      return { kind: "sites" };
    }

    // match health
    if (segments[2] === "health") {
      return { kind: "health" };
    }
  }

  // match site-specific reads
  if (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "sites"
  ) {
    let siteSlug: string;

    try {
      siteSlug = validateStableKey(segments[3] ?? "", "siteSlug");
    } catch {
      // keep invalid path segments outside the public surface
      throw new HttpError(404, "not_found", "Endpoint not found");
    }

    const resource = segments[4];

    // match current rows
    if (resource === "current") {
      return { kind: "current", siteSlug };
    }

    // match history rows
    if (resource === "history") {
      return { kind: "history", siteSlug };
    }
  }

  throw new HttpError(404, "not_found", "Endpoint not found");
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

// parse selected current filters
function parseCurrentQuery(
  parameters: URLSearchParams,
  site: ApiSite,
): CurrentQuery {
  const stationValue = getOptionalParameter(parameters, "station");
  const stationSlug =
    stationValue === undefined
      ? undefined
      : validateStableKey(stationValue, "station");
  const sourceId = parseOptionalSourceId(parameters, "source");
  validateSelection(site, stationSlug, sourceId);
  return {
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(stationSlug === undefined ? {} : { stationSlug }),
  };
}

// require active station and source selections
function validateSelection(
  site: ApiSite,
  stationSlug?: string,
  sourceId?: string,
): void {
  const stations =
    stationSlug === undefined
      ? site.stations
      : site.stations.filter(
        // match one active station
        (station) => station.slug === stationSlug,
      );

  // reject unknown stations
  if (stationSlug !== undefined && stations.length === 0) {
    throw new HttpError(404, "station_not_found", `Unknown station: ${stationSlug}`);
  }

  // preserve an absent source filter
  if (sourceId === undefined) {
    return;
  }

  const sourceExists = stations.some(
    // inspect selected station sources
    (station) => station.sources.some(
      // compare stable source IDs
      (source) => source.id === sourceId,
    ),
  );

  // reject inactive or unrelated sources
  if (!sourceExists) {
    throw new HttpError(404, "source_not_found", `Unknown source: ${sourceId}`);
  }
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

    const validAt = toIsoInstant(row.validAt);
    records.push({
      freshness: describeFreshness(validAt, generatedAt),
      id: row.id,
      metadata: projectMetadata(row),
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
      productRunAt:
        row.productRunAt === null ? null : toIsoInstant(row.productRunAt),
      provenance: {
        attribution: source.attribution,
        label: sourceKindLabel(row.sourceKind),
        providerKey: source.providerKey,
        sourceId: row.sourceId,
        sourceKey: source.key,
        sourceKind: row.sourceKind,
        stationSlug: row.stationSlug,
      },
      receivedAt: toIsoInstant(row.lastReceivedAt),
      revisionCount: row.revisionCount,
      validAt,
    });
  }

  return records;
}

// project only public metadata fields
function projectMetadata(row: WeatherRecordRow): ApiWeatherRecord["metadata"] {
  const device =
    row.deviceVendor === null &&
    row.deviceModel === null &&
    row.deviceSerial === null
      ? null
      : {
        model: row.deviceModel,
        serial: row.deviceSerial,
        vendor: row.deviceVendor,
      };
  const quality = projectQuality(row.qualityMetadata);
  const provider = projectProvider(row.providerMetadata);
  return {
    device,
    provider,
    quality,
    upstream: {
      model: row.upstreamModel,
      timezone: row.upstreamTimezone,
    },
  };
}

// project allowlisted quality metadata
function projectQuality(
  metadata: Readonly<Record<string, JsonValue>> | null,
): ApiWeatherRecord["metadata"]["quality"] {
  // preserve absent metadata
  if (metadata === null) {
    return null;
  }

  return {
    confidencePercent: boundedNumber(metadata.confidence_percent),
    flags: boundedStrings(metadata.flags),
    interpolation: boundedString(metadata.interpolation),
    status: boundedString(metadata.status),
  };
}

// project allowlisted provider metadata
function projectProvider(
  metadata: Readonly<Record<string, JsonValue>> | null,
): ApiWeatherRecord["metadata"]["provider"] {
  // preserve absent metadata
  if (metadata === null) {
    return null;
  }

  return {
    dataset: boundedString(metadata.dataset),
    elevationM: boundedNumber(metadata.elevation_m),
    gridCell: boundedString(metadata.grid_cell),
  };
}

// retain one bounded public string
function boundedString(value: JsonValue | undefined): string | null {
  return typeof value === "string" ? value.slice(0, 256) : null;
}

// retain one finite public number
function boundedNumber(value: JsonValue | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// retain a bounded public string list
function boundedStrings(value: JsonValue | undefined): readonly string[] | null {
  // require an array
  if (!Array.isArray(value)) {
    return null;
  }

  const strings: string[] = [];

  // retain only bounded string entries
  for (const entry of value.slice(0, 20)) {
    // omit non-string entries
    if (typeof entry === "string") {
      strings.push(entry.slice(0, 128));
    }
  }

  return strings;
}

// normalize database instants
function toIsoInstant(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);

  // reject corrupt storage values
  if (Number.isNaN(date.getTime())) {
    throw new Error("database returned an invalid timestamp");
  }

  return date.toISOString();
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
  site: ApiSite,
): ParsedHistoryQuery {
  rejectUnexpectedParameters(
    parameters,
    new Set(["cursor", "from", "limit", "source", "sourceKind", "station", "to"]),
  );
  const requestedLimit = parseLimit(parameters);
  const cursorValue = getOptionalParameter(parameters, "cursor");
  const fromValue = getOptionalParameter(parameters, "from");
  const sourceKindValue = getOptionalParameter(parameters, "sourceKind");
  const sourceId = parseOptionalSourceId(parameters, "source");
  const stationValue = getOptionalParameter(parameters, "station");
  const stationSlug =
    stationValue === undefined
      ? undefined
      : validateStableKey(stationValue, "station");
  const toValue = getOptionalParameter(parameters, "to");
  validateSelection(site, stationSlug, sourceId);
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
  if (sourceKindValue !== undefined) {
    Object.assign(query, { sourceKind: parseSourceKind(sourceKindValue) });
  }

  // apply source filtering
  if (sourceId !== undefined) {
    Object.assign(query, { sourceId });
  }

  // apply station filtering
  if (stationSlug !== undefined) {
    Object.assign(query, { stationSlug });
  }

  // apply the upper bound
  if (toValue !== undefined) {
    Object.assign(query, { to: validateUtcInstant(toValue, "to") });
  }

  // reject reversed ranges before storage
  if (query.from !== undefined && query.to !== undefined && query.from >= query.to) {
    throw new HttpError(400, "invalid_query", "from must be earlier than to");
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

  // enforce the frozen public maximum
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
      Object.keys(parsed).length !== 2 ||
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

// split one exact URL path
function parsePathSegments(pathname: string): readonly string[] {
  try {
    // reject non-canonical separators
    if (!pathname.startsWith("/") || pathname.endsWith("/") || pathname.includes("//")) {
      throw new HttpError(404, "not_found", "Endpoint not found");
    }

    const rawSegments = pathname.slice(1).split("/");
    const segments: string[] = [];

    // decode every exact segment
    for (const segment of rawSegments) {
      const decoded = decodeURIComponent(segment);

      // reject encoded separators
      if (decoded.length === 0 || decoded.includes("/")) {
        throw new HttpError(404, "not_found", "Endpoint not found");
      }

      segments.push(decoded);
    }

    return segments;
  } catch (error) {
    // preserve intentional route errors
    if (error instanceof HttpError) {
      throw error;
    }

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

// strip one head response body
function withoutBody(response: Response): Response {
  return new Response(null, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
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

  return jsonResponse(
    { error: { code: "internal_error", message: "Unexpected server error" } },
    500,
  );
}

// classify only request parsing failures
function parsePublicQuery<Result>(read: () => Result): Result {
  try {
    return read();
  } catch (error) {
    // preserve intentional query responses
    if (error instanceof HttpError) {
      throw error;
    }

    // hide validation implementation details
    if (error instanceof RangeError || error instanceof TypeError) {
      throw new HttpError(400, "invalid_query", "Request query is invalid");
    }

    throw error;
  }
}

// build one allowlisted diagnostic event
function createApiDiagnostic(
  error: unknown,
  method: string,
  status: number,
): ApiDiagnostic {
  const errorName =
    error instanceof Error && DIAGNOSTIC_TOKEN.test(error.name)
      ? error.name
      : "UnknownError";
  const candidateCode =
    typeof error === "object" && error !== null && "code" in error
      ? error.code
      : undefined;
  const errorCode =
    typeof candidateCode === "string" && DIAGNOSTIC_TOKEN.test(candidateCode)
      ? candidateCode
      : null;
  const safeMethod = /^[A-Z]{1,16}$/u.test(method) ? method : "UNKNOWN";
  return {
    errorCode,
    errorName,
    event: "api_request_failed",
    method: safeMethod,
    status,
  };
}

// isolate diagnostic sink failures
function emitApiDiagnostic(
  sink: (diagnostic: ApiDiagnostic) => void,
  diagnostic: ApiDiagnostic,
): void {
  try {
    sink(diagnostic);
  } catch {
    // preserve the public response boundary
  }
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
