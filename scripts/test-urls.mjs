import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_CONFIGURATION_PATH = resolve(
  import.meta.dirname,
  "../config/runtime-targets.json",
);
const SITE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

// load the runtime target contract
async function loadRuntimeTargets() {
  const path = process.env.WEATHER_RUNTIME_TARGETS_PATH ?? DEFAULT_CONFIGURATION_PATH;
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const root = requireObject(parsed, "runtime targets");
  const local = requireObject(root.local, "local target");
  const remote = optionalObject(root.remote, "remote target");
  const tunnel = optionalObject(remote?.tunnel, "remote tunnel");
  const defaultSiteSlug = requireString(root.defaultSiteSlug, "defaultSiteSlug");

  // require one route-safe site slug
  if (!SITE_SLUG_PATTERN.test(defaultSiteSlug)) {
    throw new Error("defaultSiteSlug must be a route-safe slug");
  }

  return {
    defaultSiteSlug,
    localOrigin: validateOrigin(
      requireString(local.origin, "local.origin"),
      "local.origin",
      false,
    ),
    tunnelOrigin:
      tunnel === null
        ? null
        : validateOrigin(
            requireString(tunnel.origin, "remote.tunnel.origin"),
            "remote.tunnel.origin",
            true,
          ),
  };
}

// parse the bounded command options
function parseOptions(argumentsList) {
  const options = new Set(argumentsList);

  // reject unknown arguments
  if ([...options].some((option) => !["--check", "--local", "--remote"].includes(option))) {
    throw new Error("usage: test-urls.mjs [--local|--remote] [--check]");
  }

  // reject conflicting targets
  if (options.has("--local") && options.has("--remote")) {
    throw new Error("--local and --remote are mutually exclusive");
  }

  return {
    check: options.has("--check"),
    target: options.has("--local")
      ? "local"
      : options.has("--remote")
        ? "remote"
        : "auto",
  };
}

// choose the requested browser origin
function selectOrigin(configuration, target) {
  // force the local stack
  if (target === "local") {
    return configuration.localOrigin;
  }

  // require a configured remote tunnel
  if (target === "remote" && configuration.tunnelOrigin === null) {
    throw new Error("the remote tunnel is not configured");
  }

  return configuration.tunnelOrigin ?? configuration.localOrigin;
}

// construct the useful browser targets
function buildTestUrls(origin, siteSlug) {
  const sitePath = `/api/v1/sites/${encodeURIComponent(siteSlug)}`;

  return [
    ["Weather dashboard", new URL("/", origin).href],
    ["Weather station map", new URL("/map", origin).href],
    ["Weather forecast", new URL("/forecast", origin).href],
    ["Weather trends", new URL("/trends", origin).href],
    ["Deployment health and migration status", new URL("/api/v1/health", origin).href],
    ["Current normalized measurements", new URL(`${sitePath}/current`, origin).href],
    ["Next 48 forecast hours", new URL(`${sitePath}/forecast`, origin).href],
    ["Recent 24-hour trends", new URL(`${sitePath}/trends?range=24h`, origin).href],
    ["Recent historical measurements", new URL(`${sitePath}/history?limit=25`, origin).href],
    ["Weather logs", new URL("/logs", origin).href],
    ["Property sensor admin", new URL("/admin", origin).href],
  ];
}

// verify the configured tunnel surface
async function checkUrls(urls) {
  // check every URL within its route budget
  const responses = await Promise.all(
    urls.map(async ([description, url]) => {
      // allow the edge's bounded annual aggregation
      const timeoutMilliseconds = /^\/api\/v1\/sites\/[^/]+\/trends$/u.test(new URL(url).pathname)
        ? 35_000
        : 10_000;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });

      // reject an unavailable route
      if (!response.ok && !(description === "Property sensor admin" && response.status === 401)) {
        throw new Error(`${description} returned HTTP ${response.status}`);
      }

      return response;
    }),
  );
  const health = await responses[4].json();

  // require ready application health
  if (health?.data?.live !== true || health?.data?.ready !== true) {
    throw new Error("the configured Weather origin is not ready");
  }

  process.stdout.write(
    `Weather tunnel ready: ${urls[0][1]}\nRelease: ${String(health.data.version)}\nMigration: ${String(health.data.migration?.version)}\n`,
  );
}

// render copy-pasteable test URLs
function printUrls(urls) {
  process.stdout.write(
    `${urls.map(([description, url]) => `${description}\n${url}`).join("\n\n")}\n`,
  );
}

// require an object value
function requireObject(value, fieldName) {
  // reject non-object values
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }

  return value;
}

// read an optional object value
function optionalObject(value, fieldName) {
  // preserve an absent object
  if (value === undefined) {
    return null;
  }

  return requireObject(value, fieldName);
}

// require a non-empty string
function requireString(value, fieldName) {
  // reject empty or non-string values
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value;
}

// validate a credential-free origin
function validateOrigin(value, fieldName, requireHttps) {
  const origin = new URL(value);

  // reject unsafe origin components
  if (
    (origin.protocol !== "http:" && origin.protocol !== "https:") ||
    (requireHttps && origin.protocol !== "https:") ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== ""
  ) {
    throw new Error(`${fieldName} must be a credential-free HTTP origin`);
  }

  return origin.origin;
}

const configuration = await loadRuntimeTargets();
const options = parseOptions(process.argv.slice(2));
const urls = buildTestUrls(
  selectOrigin(configuration, options.target),
  configuration.defaultSiteSlug,
);

// execute the requested operation
if (options.check) {
  await checkUrls(urls);
} else {
  printUrls(urls);
}
