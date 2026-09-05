import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const executeFile = promisify(execFile);
const script = resolve(import.meta.dirname, "test-urls.mjs");

// run the URL generator with isolated configuration
async function executeWithConfiguration(configuration, argumentsList = [], preloadSource) {
  const directory = await mkdtemp(join(tmpdir(), "weather-test-urls-"));
  const configurationPath = join(directory, "runtime-targets.json");
  const preloadPath = join(directory, "preload.mjs");

  try {
    await writeFile(configurationPath, JSON.stringify(configuration));

    const preloadArguments = [];

    // install one test-only runtime shim
    if (preloadSource !== undefined) {
      await writeFile(preloadPath, preloadSource);
      preloadArguments.push("--import", preloadPath);
    }

    return await executeFile(process.execPath, [...preloadArguments, script, ...argumentsList], {
      env: {
        ...process.env,
        WEATHER_RUNTIME_TARGETS_PATH: configurationPath,
      },
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const configuredTargets = {
  defaultSiteSlug: "ballydidean",
  local: { origin: "http://127.0.0.1:3000" },
  remote: { tunnel: { origin: "https://weather.ballydidean.farm" } },
};

// observe request budgets without wall-clock waits
const timeoutProbePreload = `
// replace wall-clock timers with observable markers
AbortSignal.timeout = (milliseconds) => ({ milliseconds });

// emulate every public URL check
globalThis.fetch = async (url, { signal }) => {
  const requestUrl = new URL(url);
  const expectedMilliseconds = requestUrl.pathname === "/api/v1/sites/ballydidean/trends"
    ? 35_000
    : 10_000;

  // fail on one inconsistent request budget
  if (signal?.milliseconds !== expectedMilliseconds) {
    throw new Error(
      \`expected \${expectedMilliseconds}ms for \${requestUrl.pathname}, received \${String(signal?.milliseconds)}ms\`,
    );
  }

  const unauthorized = requestUrl.pathname === "/admin";
  return {
    ok: !unauthorized,
    status: unauthorized ? 401 : 200,
    // preserve the health response contract
    async json() {
      return {
        data: {
          live: true,
          migration: { version: "test-migration" },
          ready: true,
          version: "test-release",
        },
      };
    },
  };
};
`;

test("test URLs prefer the configured tunnel", async () => {
  const result = await executeWithConfiguration(configuredTargets);

  assert.match(result.stdout, /https:\/\/weather\.ballydidean\.farm\//u);
  assert.match(result.stdout, /Weather station map\nhttps:\/\/weather\.ballydidean\.farm\/map/u);
  assert.match(result.stdout, /Weather forecast\nhttps:\/\/weather\.ballydidean\.farm\/forecast/u);
  assert.match(result.stdout, /Weather trends\nhttps:\/\/weather\.ballydidean\.farm\/trends/u);
  assert.match(result.stdout, /Property sensor admin\nhttps:\/\/weather\.ballydidean\.farm\/admin/u);
  assert.match(result.stdout, /\/forecast/u);
  assert.match(result.stdout, /\/trends\?range=24h/u);
  assert.doesNotMatch(result.stdout, /127\.0\.0\.1/u);
});

test("local test URLs remain explicitly selectable", async () => {
  const result = await executeWithConfiguration(configuredTargets, ["--local"]);

  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:3000\//u);
  assert.doesNotMatch(result.stdout, /weather\.ballydidean\.farm/u);
});

test("automatic URLs fall back locally when no tunnel is configured", async () => {
  const configuration = {
    defaultSiteSlug: "ballydidean",
    local: { origin: "http://127.0.0.1:3000" },
  };
  const automatic = await executeWithConfiguration(configuration);

  assert.match(automatic.stdout, /http:\/\/127\.0\.0\.1:3000\//u);
  await assert.rejects(
    () => executeWithConfiguration(configuration, ["--remote"]),
    /remote tunnel is not configured/u,
  );
});

// reserve transport margin for only the trends API
test("URL checks reserve the extended timeout for only the trends API", async () => {
  const result = await executeWithConfiguration(
    configuredTargets,
    ["--remote", "--check"],
    timeoutProbePreload,
  );

  assert.match(result.stdout, /Weather tunnel ready/u);
  assert.match(result.stdout, /Release: test-release/u);
  assert.match(result.stdout, /Migration: test-migration/u);
});
