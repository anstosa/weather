import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";

import { XweatherTileMemoryCache } from "./xweather-tile-cache.mjs";
import { XweatherUsageBudget } from "./xweather-usage-budget.mjs";
import { WeatherAdminStore } from "./weather-admin-store.mjs";

const root = resolve(process.cwd());
const publicRoot = join(root, "apps/web/public");
const compiledRoot = join(root, "apps/web/dist");
const maximumApiBytes = 1024 * 1024;
// allow the complete daily trends history
const maximumTrendsApiBytes = 2 * 1024 * 1024;
const maximumMapBytes = 4 * 1024 * 1024;
const apiOrigin = parseApiOrigin(process.env.WEATHER_API_ORIGIN);
const xweatherOrigin = parseXweatherOrigin(
  process.env.WEATHER_XWEATHER_MAP_ORIGIN ?? "https://maps.api.xweather.com",
);
const xweatherCredentials = await loadXweatherCredentials();
const port = parsePort(process.env.PORT ?? "3000");
const release = parseAssetRelease(process.env.WEATHER_RELEASE ?? "development");
const forecastMapPreloadSite = await loadForecastMapPreloadSite(
  process.env.WEATHER_SITE_CONFIG_PATH ?? join(root, "config/sites/ballydidean.json"),
);
const adminStore = new WeatherAdminStore({
  authPath: process.env.WEATHER_ADMIN_AUTH_PATH ?? "/var/lib/weather/xweather/admin-auth.json",
  bootstrapTokenPath: process.env.WEATHER_ADMIN_BOOTSTRAP_TOKEN_PATH ??
    process.env.WEATHER_XWEATHER_CLIENT_SECRET_FILE ??
    "/run/secrets/weather_xweather_client_secret",
  center: forecastMapPreloadSite ?? { latitude: 47.95043, longitude: -122.42797 },
  layoutPath: process.env.WEATHER_PROPERTY_SENSOR_LAYOUT_PATH ?? "/var/lib/weather/xweather/property-sensor-layout.json",
});
const assetPrefix = `/assets/${release}/`;
const assets = new Map([
  ["/", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/index.html", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/logs", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/logs/", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/map", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/map/", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/admin", { cache: "no-store", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/admin/", { cache: "no-store", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/forecast", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/forecast/", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/trends", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/trends/", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/settings", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/settings/", { cache: "no-cache", path: join(publicRoot, "index.html"), template: true, type: "text/html; charset=utf-8" }],
  ["/manifest.webmanifest", { cache: "no-cache", path: join(publicRoot, "manifest.webmanifest"), type: "application/manifest+json; charset=utf-8" }],
  ["/service-worker.js", { cache: "no-store", path: join(publicRoot, "service-worker.js"), template: true, type: "text/javascript; charset=utf-8" }],
  ["/brand/ballydidean-wide.svg", { cache: "public, max-age=86400", path: join(publicRoot, "brand/ballydidean-wide.svg"), type: "image/svg+xml" }],
  ["/brand/favicon.svg", { cache: "public, max-age=86400", path: join(publicRoot, "brand/favicon.svg"), type: "image/svg+xml" }],
  ["/brand/ballydidean-weather-icon-32.png", { cache: "no-cache", path: join(publicRoot, "brand/ballydidean-weather-icon-32.png"), type: "image/png" }],
  ["/brand/ballydidean-weather-icon-180.png", { cache: "no-cache", path: join(publicRoot, "brand/ballydidean-weather-icon-180.png"), type: "image/png" }],
  ["/brand/ballydidean-weather-icon-192.png", { cache: "no-cache", path: join(publicRoot, "brand/ballydidean-weather-icon-192.png"), type: "image/png" }],
  ["/brand/ballydidean-weather-icon-512.png", { cache: "no-cache", path: join(publicRoot, "brand/ballydidean-weather-icon-512.png"), type: "image/png" }],
  ["/brand/ballydidean-weather-icon-maskable-512.png", { cache: "no-cache", path: join(publicRoot, "brand/ballydidean-weather-icon-maskable-512.png"), type: "image/png" }],
  ["/fonts/google-sans-flex-latin.woff2", { cache: "public, max-age=31536000, immutable", path: join(publicRoot, "fonts/google-sans-flex-latin.woff2"), type: "font/woff2" }],
  ["/fonts/LICENSE-google-sans-flex.txt", { cache: "public, max-age=86400", path: join(publicRoot, "fonts/LICENSE-google-sans-flex.txt"), type: "text/plain; charset=utf-8" }],
  ["/fonts/material-symbols-rounded-v4.woff2", { cache: "public, max-age=31536000, immutable", path: join(publicRoot, "fonts/material-symbols-rounded-v4.woff2"), type: "font/woff2" }],
  ["/fonts/LICENSE-material-symbols.txt", { cache: "public, max-age=86400", path: join(publicRoot, "fonts/LICENSE-material-symbols.txt"), type: "text/plain; charset=utf-8" }],
]);
const versionedAssets = new Map([
  ["styles.css", { cache: "public, max-age=31536000, immutable", path: join(publicRoot, "styles.css"), type: "text/css; charset=utf-8" }],
  ["client.js", { cache: "public, max-age=31536000, immutable", path: join(compiledRoot, "client.js"), type: "text/javascript; charset=utf-8" }],
  ["index.js", { cache: "public, max-age=31536000, immutable", path: join(compiledRoot, "index.js"), type: "text/javascript; charset=utf-8" }],
  ["units.js", { cache: "public, max-age=31536000, immutable", path: join(compiledRoot, "units.js"), type: "text/javascript; charset=utf-8" }],
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", "http://weather.invalid");

    // initialize admin access through one secret-bound request only
    if (requestUrl.pathname === "/api/v1/admin/bootstrap") {
      await bootstrapAdmin(request, response);
      return;
    }

    // expose the read-only shared sensor layout
    if (requestUrl.pathname === "/api/v1/sites/ballydidean/property-sensor-layout") {
      await servePropertySensorLayout(request, response);
      return;
    }

    // update one layout entry behind HTTP Basic authentication
    if (requestUrl.pathname.startsWith("/api/v1/admin/sites/ballydidean/property-sensor-layout/")) {
      await updatePropertySensorLayout(request, response, requestUrl.pathname);
      return;
    }

    // proxy only the same-origin API namespace
    if (requestUrl.pathname.startsWith("/api/v1/")) {
      await proxyApi(request, response, requestUrl);
      return;
    }

    // proxy only the bounded weather-map namespace
    if (requestUrl.pathname.startsWith("/maps/xweather/")) {
      await proxyXweatherMap(request, response, requestUrl);
      return;
    }

    // serve only the explicit static allowlist
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendText(response, 405, "method not allowed\n", { Allow: "GET, HEAD" });
      return;
    }

    // unwrap the RemoteAgents preview bridge on the public tunnel
    if (requestUrl.pathname === "/__rac/browser-device") {
      redirectRemoteAgentsBrowser(response, requestUrl);
      return;
    }

    // protect both spellings of the admin application shell
    if (
      (requestUrl.pathname === "/admin" || requestUrl.pathname === "/admin/") &&
      !(await adminStore.authenticate(request.headers.authorization))
    ) {
      sendAdminUnauthorized(response);
      return;
    }

    const asset = resolveAsset(requestUrl.pathname);

    // reject traversal and unknown files uniformly
    if (asset === undefined || requestUrl.pathname.includes("\\")) {
      sendText(response, 404, "not found\n");
      return;
    }

    const source = await readFile(asset.path);
    const body = asset.template === true
      ? Buffer.from(renderHtmlTemplate(source.toString("utf8"), requestUrl.pathname))
      : source;
    // deny framing for the credentialed editor shell
    if (requestUrl.pathname === "/admin" || requestUrl.pathname === "/admin/") {
      setAdminSecurityHeaders(response);
    } else {
      setSecurityHeaders(response);
    }
    response.writeHead(200, {
      "Cache-Control": asset.cache,
      "Content-Length": String(body.byteLength),
      "Content-Type": asset.type,
    });

    // omit response bodies for HEAD
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(body);
    }
  } catch {
    sendText(response, 500, "internal server error\n");
  }
});

server.listen(port, "0.0.0.0");

// initialize the first admin password without persisting plaintext
async function bootstrapAdmin(request, response) {
  // accept only one explicit mutation method
  if (request.method !== "POST") {
    sendText(response, 405, "method not allowed\n", { Allow: "POST" });
    return;
  }

  try {
    const body = await readRequestJson(request, 2_048);
    const result = await adminStore.bootstrap(
      request.headers["x-weather-admin-bootstrap"],
      body.password,
    );

    // reject invalid one-time credentials uniformly
    if (result.status === "unauthorized") {
      sendText(response, 401, "unauthorized\n");
      return;
    }

    // permanently close bootstrap after first configuration
    if (result.status === "already_configured") {
      sendText(response, 409, "admin access is already configured\n");
      return;
    }

    sendJson(response, 201, { configured: true });
  } catch (error) {
    // distinguish malformed client input from server persistence failures
    if (error instanceof RangeError || error instanceof SyntaxError) {
      sendText(response, 400, "invalid request\n");
    } else {
      sendText(response, 500, "internal server error\n");
    }
  }
}

// serve the shared public sensor layout
async function servePropertySensorLayout(request, response) {
  // preserve a read-only public endpoint
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const body = { data: await adminStore.readLayout() };
  sendJson(response, 200, body, request.method === "HEAD", {
    "Cache-Control": "no-cache",
  });
}

// update one server-persisted sensor layout entry
async function updatePropertySensorLayout(request, response, pathname) {
  // require one authenticated admin request
  if (!(await adminStore.authenticate(request.headers.authorization))) {
    sendAdminUnauthorized(response);
    return;
  }

  // accept only bounded JSON updates
  if (request.method !== "PUT") {
    sendText(response, 405, "method not allowed\n", { Allow: "PUT" });
    return;
  }

  const prefix = "/api/v1/admin/sites/ballydidean/property-sensor-layout/";
  const encodedKey = pathname.slice(prefix.length);

  try {
    const sensorKey = decodeURIComponent(encodedKey);
    const body = await readRequestJson(request, 4_096);
    const saved = await adminStore.upsertSensor(sensorKey, body);
    sendJson(response, 200, { data: saved });
  } catch (error) {
    // reject malformed keys, bodies, and property positions
    if (error instanceof RangeError || error instanceof SyntaxError || error instanceof URIError) {
      sendText(response, 400, "invalid request\n");
    } else {
      sendText(response, 500, "internal server error\n");
    }
  }
}

// challenge one unauthenticated admin request
function sendAdminUnauthorized(response) {
  sendText(response, 401, "authentication required\n", {
    "WWW-Authenticate": 'Basic realm="Ballydidean Weather Admin", charset="UTF-8"',
  });
}

// read one bounded JSON request body
async function readRequestJson(request, maximumBytes) {
  const chunks = [];
  let length = 0;

  // buffer only the configured small request limit
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.byteLength;

    // stop oversized writes before parsing
    if (length > maximumBytes) {
      throw new RangeError("request body is too large");
    }

    chunks.push(bytes);
  }

  const parsed = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));

  // require one object request body
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new RangeError("request body must be an object");
  }

  return parsed;
}

// resolve only fixed or active-release assets
function resolveAsset(pathname) {
  // isolate compiled assets by immutable release URL
  if (pathname.startsWith(assetPrefix)) {
    return versionedAssets.get(pathname.slice(assetPrefix.length));
  }

  return assets.get(pathname);
}

// redirect one validated RemoteAgents preview target
function redirectRemoteAgentsBrowser(response, requestUrl) {
  const mode = requestUrl.searchParams.get("mode");
  const location = requestUrl.searchParams.get("location");

  // require the bridge contract and one root-relative target
  if (
    (mode !== "desktop" && mode !== "mobile") ||
    location === null ||
    !location.startsWith("/") ||
    location.startsWith("//")
  ) {
    sendText(response, 400, "invalid browser preview\n");
    return;
  }

  const destination = new URL(location, "http://weather.invalid");

  // reject URL-parser backslash normalization into another origin
  if (destination.origin !== "http://weather.invalid") {
    sendText(response, 400, "invalid browser preview\n");
    return;
  }

  const target = `${destination.pathname}${destination.search}${destination.hash}`;
  setSecurityHeaders(response);
  response.writeHead(302, {
    "Cache-Control": "no-store",
    "Content-Length": "0",
    Location: target,
  });
  response.end();
}

// render one route-aware release template
function renderHtmlTemplate(source, pathname) {
  return source
    .replaceAll("__WEATHER_ASSET_VERSION__", release)
    .replaceAll("__WEATHER_ROUTE_PRELOAD__", forecastMapPreloadLink(pathname));
}

// prioritize the first Today radar frame before JavaScript executes
function forecastMapPreloadLink(pathname) {
  // keep weather-map traffic off unrelated routes
  if (
    (pathname !== "/forecast" && pathname !== "/forecast/") ||
    forecastMapPreloadSite === null
  ) {
    return "";
  }

  const frameMs = Math.floor(Date.now() / (10 * 60 * 1_000)) * 10 * 60 * 1_000;
  const validTime = formatXweatherValidTime(new Date(frameMs));
  const latitude = forecastMapPreloadSite.latitude.toFixed(6);
  const longitude = forecastMapPreloadSite.longitude.toFixed(6);
  const href = `/maps/xweather/history/radar/${validTime}/10/256x168/${latitude},${longitude}.png`;
  return `<link rel="preload" as="image" type="image/png" fetchpriority="high" href="${href}">`;
}

// load only the public map center from the site configuration
async function loadForecastMapPreloadSite(path) {
  try {
    const configuration = JSON.parse(await readFile(path, "utf8"));
    const site = configuration?.site;

    // require one bounded public map center
    if (
      site === null ||
      typeof site !== "object" ||
      !Number.isFinite(site.latitude) ||
      site.latitude < -85 ||
      site.latitude > 85 ||
      !Number.isFinite(site.longitude) ||
      site.longitude < -180 ||
      site.longitude > 180
    ) {
      return null;
    }

    return { latitude: site.latitude, longitude: site.longitude };
  } catch {
    // retain ordinary static serving without optional preload metadata
    return null;
  }
}

// format one provider-compatible UTC timestamp
function formatXweatherValidTime(instant) {
  return [
    String(instant.getUTCFullYear()).padStart(4, "0"),
    String(instant.getUTCMonth() + 1).padStart(2, "0"),
    String(instant.getUTCDate()).padStart(2, "0"),
    String(instant.getUTCHours()).padStart(2, "0"),
    String(instant.getUTCMinutes()).padStart(2, "0"),
    String(instant.getUTCSeconds()).padStart(2, "0"),
  ].join("");
}

// validate one cache-safe release path segment
function parseAssetRelease(value) {
  // allow the direct local development server
  if (value === "development") {
    return value;
  }

  // require the immutable deployment release shape
  if (!/^\d{4}\.\d{2}\.\d{2}-[1-9]\d?$/u.test(value)) {
    throw new Error("WEATHER_RELEASE must use YYYY.MM.DD-N");
  }

  return value;
}

// validate the internal upstream origin
function parseApiOrigin(value) {
  const origin = new URL(value ?? "http://api:3001");

  // reject credentials, non-HTTP protocols, and path prefixes
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("WEATHER_API_ORIGIN must be a credential-free HTTP origin");
  }

  return origin;
}

// validate the Xweather map origin
function parseXweatherOrigin(value) {
  const origin = new URL(value);
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(origin.hostname);

  // require HTTPS outside disposable loopback tests
  if (
    (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error("WEATHER_XWEATHER_MAP_ORIGIN must be a credential-free HTTPS origin");
  }

  return origin;
}

// validate the listener port
function parsePort(value) {
  const parsed = Number(value);

  // reject invalid listener configuration
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new RangeError("PORT must be between 1 and 65535");
  }

  return parsed;
}

// proxy one bounded API request
async function proxyApi(request, response, requestUrl) {
  // keep the edge read-only
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const target = new URL(`${requestUrl.pathname}${requestUrl.search}`, apiOrigin);
  // relax only the exact site trends route
  const maximumResponseBytes = /^\/api\/v1\/sites\/[^/]+\/trends$/u.test(requestUrl.pathname)
    ? maximumTrendsApiBytes
    : maximumApiBytes;

  try {
    const upstream = await fetch(target, {
      headers: { Accept: request.headers.accept ?? "application/json" },
      method: request.method,
      redirect: "manual",
      signal: AbortSignal.timeout(apiRequestTimeoutMs(requestUrl.pathname)),
    });
    const body = request.method === "HEAD"
      ? Buffer.alloc(0)
      : await readBoundedBody(upstream, maximumResponseBytes, "API");
    const contentLength =
      request.method === "HEAD"
        ? boundedContentLength(upstream.headers.get("content-length"), maximumResponseBytes)
        : body.byteLength;
    setSecurityHeaders(response);
    response.writeHead(upstream.status, {
      "Cache-Control": upstream.ok ? apiCacheControl(requestUrl.pathname) : "no-store",
      "Content-Length": String(contentLength),
      "Content-Type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      Vary: "Accept",
    });
    response.end(body);
  } catch {
    sendText(response, 502, "upstream unavailable\n");
  }
}

// select one freshness-aware public API cache policy
function apiCacheControl(pathname) {
  // retain stable site metadata at the edge
  if (pathname === "/api/v1/sites") {
    return "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
  }

  // refresh current conditions within one ingestion interval
  if (/^\/api\/v1\/sites\/[^/]+\/current$/u.test(pathname)) {
    return "public, max-age=15, s-maxage=30, stale-while-revalidate=30";
  }

  // retain slower-changing modeled products briefly
  if (/^\/api\/v1\/sites\/[^/]+\/(?:forecast|tides)$/u.test(pathname)) {
    return "public, max-age=60, s-maxage=300, stale-while-revalidate=300";
  }

  // retain one normalized trend snapshot briefly
  if (/^\/api\/v1\/sites\/[^/]+\/trends$/u.test(pathname)) {
    return "public, max-age=300, s-maxage=1800, stale-while-revalidate=86400";
  }

  return "no-store";
}

// allow one bounded cold annual aggregation without relaxing ordinary reads
function apiRequestTimeoutMs(pathname) {
  return /^\/api\/v1\/sites\/[^/]+\/trends$/u.test(pathname) ? 30_000 : 5_000;
}

const XWEATHER_LAYERS = {
  forecast: {
    clouds: "fsatellite",
    precipitation: "fqpf-1h",
    radar: "fradar",
    wind: "fwind-speeds",
  },
  history: {
    clouds: "satellite-geocolor",
    precipitation: "precip-1h",
    radar: "radar",
    wind: "wind-speeds",
  },
};
const XWEATHER_FRAME_PATTERN = /^\/maps\/xweather\/(history|forecast)\/(radar|clouds|precipitation|wind)\/(\d{14})\/(\d{1,2})\/(\d{3,4})x(\d{3,4})\/(-?\d{1,2}(?:\.\d{1,6})?),(-?\d{1,3}(?:\.\d{1,6})?)\.png$/u;
const XWEATHER_FORECAST_FRESHNESS_MS = 60 * 60 * 1_000;
const XWEATHER_MAP_CACHE_BYTES = 256 * 1_024 * 1_024;
const XWEATHER_PROVIDER_CONCURRENCY = 8;
const XWEATHER_PROVIDER_MINIMUM_INTERVAL_MS = 125;
const XWEATHER_PROVIDER_QUEUE_LIMIT = 512;
const XWEATHER_PROVIDER_DAILY_MAP_UNIT_BUDGET = 300;
const XWEATHER_PROVIDER_MONTHLY_MAP_UNIT_BUDGET = 10_000;
const xweatherProviderQueue = [];
let xweatherProviderActive = 0;
let xweatherProviderLastStartedAt = 0;
let xweatherProviderStartTimer = null;
const xweatherUsageBudget = new XweatherUsageBudget({
  dailyLimit: XWEATHER_PROVIDER_DAILY_MAP_UNIT_BUDGET,
  monthlyLimit: XWEATHER_PROVIDER_MONTHLY_MAP_UNIT_BUDGET,
  path: process.env.WEATHER_XWEATHER_USAGE_PATH ?? null,
});
const xweatherTileCache = new XweatherTileMemoryCache({
  forecastFreshnessMs: XWEATHER_FORECAST_FRESHNESS_MS,
  loadTile: queueXweatherTileFetch,
  maximumBytes: XWEATHER_MAP_CACHE_BYTES,
});
// proxy one allowlisted Xweather raster tile
async function proxyXweatherMap(request, response, requestUrl) {
  // keep the map edge read-only
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "method not allowed\n", { Allow: "GET, HEAD" });
    return;
  }

  const tile = parseXweatherMapImage(requestUrl.pathname);

  // reject unknown layers and malformed coordinates uniformly
  if (tile === null) {
    sendText(response, 404, "not found\n");
    return;
  }

  // keep the public route disabled without server-side credentials
  if (xweatherCredentials === null) {
    sendText(response, 503, "weather map unavailable\n", { "Retry-After": "300" });
    return;
  }

  try {
    const cached = await xweatherTileCache.get(tile);
    const ageSeconds = Math.max(0, Math.floor((Date.now() - cached.fetchedAt) / 1_000));
    setSecurityHeaders(response);
    response.writeHead(200, {
      "Cache-Control": tile.phase === "history"
        ? "public, max-age=31536000, immutable"
        : "no-store",
      "Content-Length": String(cached.body.byteLength),
      "Content-Type": "image/png",
      "X-Weather-Tile-Age": String(ageSeconds),
      "X-Weather-Tile-Cache": cached.cacheStatus,
    });

    // omit cached tile bodies for HEAD
    if (request.method === "HEAD") {
      response.end();
    } else {
      response.end(cached.body);
    }
  } catch (error) {
    // stop provider spend at the reviewed calendar boundaries
    if (error?.code === "xweather_budget_exhausted") {
      sendText(response, 429, "weather map budget exhausted\n", { "Retry-After": secondsUntilUtcDay() });
    } else {
      sendText(response, 502, "weather tile unavailable\n");
    }
  }
}

// enqueue one provider fetch behind the shared rate boundary
async function queueXweatherTileFetch(tile) {
  // reject excess public demand before memory grows without bound
  if (xweatherProviderQueue.length >= XWEATHER_PROVIDER_QUEUE_LIMIT) {
    throw new Error("Xweather provider queue is full");
  }

  return await new Promise((resolveFetch, rejectFetch) => {
    xweatherProviderQueue.push({ rejectFetch, resolveFetch, tile });
    drainXweatherProviderQueue();
  });
}

// start queued provider requests within concurrency and rate limits
function drainXweatherProviderQueue() {
  // leave one scheduled start in sole control of the queue
  if (
    xweatherProviderStartTimer !== null ||
    xweatherProviderActive >= XWEATHER_PROVIDER_CONCURRENCY ||
    xweatherProviderQueue.length === 0
  ) {
    return;
  }

  const delay = Math.max(
    0,
    xweatherProviderLastStartedAt + XWEATHER_PROVIDER_MINIMUM_INTERVAL_MS - Date.now(),
  );

  // preserve the minimum interval between provider request starts
  if (delay > 0) {
    xweatherProviderStartTimer = setTimeout(
      // resume the provider queue after the rate window
      () => {
        xweatherProviderStartTimer = null;
        drainXweatherProviderQueue();
      },
      delay,
    );
    xweatherProviderStartTimer.unref();
    return;
  }

  const task = xweatherProviderQueue.shift();

  // preserve the checked queue boundary
  if (task === undefined) {
    return;
  }

  xweatherProviderActive += 1;
  xweatherProviderLastStartedAt = Date.now();
  void fetchXweatherTile(task.tile).then(task.resolveFetch, task.rejectFetch).finally(
    // release one provider slot and continue the queue
    () => {
      xweatherProviderActive -= 1;
      drainXweatherProviderQueue();
    },
  );
  drainXweatherProviderQueue();
}

// classify one provider content type without logging parameters
function xweatherDiagnosticContentType(value) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();

  // expose only reviewed diagnostic categories
  return ["application/json", "image/png", "text/html", "text/plain"].includes(mediaType ?? "")
    ? mediaType
    : value === null
      ? "missing"
      : "other";
}

// fetch one credentialed tile for the server memory cache
async function fetchXweatherTile(tile) {
  // reject impossible loader use while the integration is disabled
  if (xweatherCredentials === null) {
    throw new Error("Xweather credentials are unavailable");
  }

  reserveXweatherMapUnits(tile);

  const credentials = `${encodeURIComponent(xweatherCredentials.clientId)}_${encodeURIComponent(xweatherCredentials.clientSecret)}`;
  const layer = XWEATHER_LAYERS[tile.phase][tile.layer];
  const geometry = tile.kind === "frame"
    ? `${String(tile.width)}x${String(tile.height)}/${tile.latitude.toFixed(6)},${tile.longitude.toFixed(6)},${String(tile.zoom)}`
    : `${String(tile.zoom)}/${String(tile.column)}/${String(tile.row)}`;
  const target = new URL(
    `${credentials}/${layer}/${geometry}/${tile.validTime}.png`,
    xweatherOrigin,
  );
  let upstream;

  try {
    upstream = await fetch(target, {
      headers: {
        Accept: "image/png",
        "User-Agent": "Ballydidean-Weather/1.0",
      },
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    // report only one safe transport failure category
    const errorName = error instanceof TypeError ? "TypeError" : "Error";
    process.stderr.write(`Xweather tile fetch failed: error=${errorName}\n`);
    throw error;
  }

  // reject provider errors without exposing credential details
  if (!upstream.ok || !upstream.headers.get("content-type")?.startsWith("image/png")) {
    const mediaType = xweatherDiagnosticContentType(upstream.headers.get("content-type"));
    process.stderr.write(
      `Xweather tile response rejected: status=${String(upstream.status)} content-type=${mediaType}\n`,
    );
    const error = new Error("Xweather tile provider returned an invalid response");
    const retryAfterSeconds = Number(upstream.headers.get("retry-after"));

    // retain only one bounded provider retry delay
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      error.retryAfterMs = Math.min(60_000, Math.ceil(retryAfterSeconds * 1_000));
    }

    throw error;
  }

  return {
    body: await readBoundedBody(upstream, maximumMapBytes, "weather map"),
  };
}

// reserve map units before one billable provider call
function reserveXweatherMapUnits(tile) {
  const units = Math.ceil(tile.width / 256) * Math.ceil(tile.height / 256);
  xweatherUsageBudget.reserve(units);
}

// report the next UTC budget reset in seconds
function secondsUntilUtcDay() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return String(Math.max(1, Math.ceil((next - now.getTime()) / 1_000)));
}

// parse one bounded public map-image path
function parseXweatherMapImage(pathname) {
  return parseXweatherFrame(pathname);
}

// parse one bounded public static-frame path
function parseXweatherFrame(pathname) {
  const match = XWEATHER_FRAME_PATTERN.exec(pathname);

  // reject every non-frame route
  if (match === null) {
    return null;
  }

  const [, phase, layer, validTime, zoomText, widthText, heightText, latitudeText, longitudeText] = match;
  const zoom = Number(zoomText);
  const width = Number(widthText);
  const height = Number(heightText);
  const latitude = Number(latitudeText);
  const longitude = Number(longitudeText);
  const instant = parseXweatherValidTime(validTime);
  const now = Date.now();
  const ageMs = instant === null ? Number.POSITIVE_INFINITY : now - instant.getTime();
  const futureMs = instant === null ? Number.POSITIVE_INFINITY : instant.getTime() - now;
  const exactLatitude = forecastMapPreloadSite?.latitude.toFixed(6);
  const exactLongitude = forecastMapPreloadSite?.longitude.toFixed(6);

  // constrain the single reviewed static-map product
  if (
    zoom !== 10 ||
    width !== 256 ||
    height !== 168 ||
    latitude.toFixed(6) !== exactLatitude ||
    longitude.toFixed(6) !== exactLongitude ||
    instant === null ||
    instant.getUTCSeconds() !== 0 ||
    (phase === "history" && instant.getUTCMinutes() % 10 !== 0) ||
    (phase === "history" && (ageMs < -10 * 60 * 1_000 || ageMs > 26 * 60 * 60 * 1_000)) ||
    (phase === "forecast" && instant.getUTCMinutes() !== 0) ||
    (phase === "forecast" && (futureMs < -60 * 60 * 1_000 || futureMs > 26 * 60 * 60 * 1_000))
  ) {
    return null;
  }

  return { height, kind: "frame", latitude, layer, longitude, phase, validTime, width, zoom };
}

// parse one exact UTC Xweather valid time
function parseXweatherValidTime(value) {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const canonical = [
    String(instant.getUTCFullYear()).padStart(4, "0"),
    String(instant.getUTCMonth() + 1).padStart(2, "0"),
    String(instant.getUTCDate()).padStart(2, "0"),
    String(instant.getUTCHours()).padStart(2, "0"),
    String(instant.getUTCMinutes()).padStart(2, "0"),
    String(instant.getUTCSeconds()).padStart(2, "0"),
  ].join("");

  return canonical === value ? instant : null;
}

// load optional server-side Xweather credentials
async function loadXweatherCredentials() {
  const clientId = await loadOptionalSecret(
    process.env.WEATHER_XWEATHER_CLIENT_ID_FILE ?? "/run/secrets/weather_xweather_client_id",
  );
  const clientSecret = await loadOptionalSecret(
    process.env.WEATHER_XWEATHER_CLIENT_SECRET_FILE ?? "/run/secrets/weather_xweather_client_secret",
  );

  // disable the route only when both files are absent
  if (clientId === null && clientSecret === null) {
    return null;
  }

  // reject partial secret provisioning
  if (clientId === null || clientSecret === null) {
    throw new Error("both Xweather credential files are required");
  }

  return { clientId, clientSecret };
}

// read one private credential file without logging material
async function loadOptionalSecret(path) {
  try {
    const value = (await readFile(path, "utf8")).trim();

    // reject empty, multiline, or control-bearing credentials
    if (value.length < 4 || value.length > 256 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error("Xweather credential file is invalid");
    }

    return value;
  } catch (error) {
    // treat only an absent file as an intentionally disabled integration
    if (error?.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

// preserve bounded head metadata
function boundedContentLength(value, maximumBytes = maximumApiBytes) {
  const length = Number(value ?? "0");

  // reject invalid or oversized metadata
  if (!Number.isSafeInteger(length) || length < 0 || length > maximumBytes) {
    throw new Error("upstream content length exceeded the edge limit");
  }

  return length;
}

// read an upstream response within the edge limit
async function readBoundedBody(upstream, maximumBytes, description) {
  const reader = upstream.body?.getReader();
  const chunks = [];
  let length = 0;

  // allow legitimate empty responses
  if (reader === undefined) {
    return Buffer.alloc(0);
  }

  // stop before buffering an oversized response
  for (;;) {
    const { done, value } = await reader.read();

    // finish on upstream EOF
    if (done) {
      break;
    }

    length += value.byteLength;

    // reject oversized API bodies
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error(`${description} response exceeded the edge limit`);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, length);
}

// apply response hardening
function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; frame-ancestors *; form-action 'none'; img-src 'self' blob: data: https://tile.openstreetmap.org https://basemap.nationalmap.gov https://imagery.nationalmap.gov; object-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'",
  );
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

// harden the authenticated HTML shell against clickjacking
function setAdminSecurityHeaders(response) {
  setSecurityHeaders(response);
  const policy = response.getHeader("Content-Security-Policy");

  // replace the public preview embedding rule only for Admin
  if (typeof policy === "string") {
    response.setHeader(
      "Content-Security-Policy",
      policy.replace("frame-ancestors *", "frame-ancestors 'none'"),
    );
  }
}

// send one bounded text response
function sendText(response, status, body, headers = {}) {
  const content = Buffer.from(body);
  setSecurityHeaders(response);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(content.byteLength),
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  response.end(content);
}

// send one bounded JSON response
function sendJson(response, status, value, head = false, headers = {}) {
  const content = Buffer.from(`${JSON.stringify(value)}\n`);
  setSecurityHeaders(response);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Length": String(content.byteLength),
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(head ? undefined : content);
}

// close without accepting new work
async function shutdown() {
  await new Promise((resolveShutdown, rejectShutdown) => {
    server.close((error) => {
      // surface unexpected close failures
      if (error) {
        rejectShutdown(error);
      } else {
        resolveShutdown();
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
