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
async function executeWithConfiguration(configuration, argumentsList = []) {
  const directory = await mkdtemp(join(tmpdir(), "weather-test-urls-"));
  const configurationPath = join(directory, "runtime-targets.json");

  try {
    await writeFile(configurationPath, JSON.stringify(configuration));
    return await executeFile(process.execPath, [script, ...argumentsList], {
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
  remote: { tunnel: { origin: "https://weather.santosa.family" } },
};

test("test URLs prefer the configured tunnel", async () => {
  const result = await executeWithConfiguration(configuredTargets);

  assert.match(result.stdout, /https:\/\/weather\.santosa\.family\//u);
  assert.doesNotMatch(result.stdout, /127\.0\.0\.1/u);
});

test("local test URLs remain explicitly selectable", async () => {
  const result = await executeWithConfiguration(configuredTargets, ["--local"]);

  assert.match(result.stdout, /http:\/\/127\.0\.0\.1:3000\//u);
  assert.doesNotMatch(result.stdout, /weather\.santosa\.family/u);
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
