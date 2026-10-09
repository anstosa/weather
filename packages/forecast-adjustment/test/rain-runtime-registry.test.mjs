import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { canonicalJsonBytes, canonicalSha256 } from "../dist/candidate.js";
import { RAIN_HURDLE_WIND_ARTIFACT_SHA256 } from "../dist/rain-hurdle-wind-artifact.js";
import {
  createForecastAdjustmentRainRuntimeRegistryLoaderForRoot,
  FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_BYTES,
  FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_SHA256,
  FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME,
} from "../dist/rain-runtime-registry.js";

test("rain raw registry has exact bytes and ignores the compiled artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-rain-registry-raw-"));
  const registry = {
    activeArtifact: null,
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
    rawReason: "policy_raw",
    siteKey: "ballydidean",
  };
  const bytes = canonicalJsonBytes(registry);
  assert.equal(Buffer.byteLength(bytes), FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_BYTES);
  assert.equal(canonicalSha256(registry), FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_SHA256);
  await writeFile(join(root, FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME), bytes);
  const loaded = await createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(root).load();
  assert.deepEqual(
    { artifactSha256: loaded.artifactSha256, reasonCode: loaded.reasonCode, state: loaded.state },
    { artifactSha256: null, reasonCode: "policy_raw", state: "disabled" },
  );
  assert.equal(loaded.comparatorAuthority.authorityKind, "policy_raw");
  assert.equal(loaded.comparatorAuthority.receiptMemberSha256, FORECAST_ADJUSTMENT_RAIN_RAW_REGISTRY_SHA256);
});

test("rain active registry binds the compiled generated artifact hash", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-rain-registry-active-"));

  // write one active hash through a fresh startup loader
  async function load(artifactSha256) {
    await writeFile(
      join(root, FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME),
      canonicalJsonBytes({
        activeArtifact: { artifactSha256 },
        contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
        rawReason: null,
        siteKey: "ballydidean",
      }),
    );
    return createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(root).load();
  }

  const loaded = await load(RAIN_HURDLE_WIND_ARTIFACT_SHA256);
  assert.deepEqual({ artifactSha256: loaded.artifactSha256, reasonCode: loaded.reasonCode, state: loaded.state }, {
    artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
    reasonCode: null,
    state: "active",
  });
  assert.equal(loaded.comparatorAuthority.artifactIdentitySha256, RAIN_HURDLE_WIND_ARTIFACT_SHA256);
  assert.equal((await load("0".repeat(64))).reasonCode, "registry_invalid");
});

test("rain registry is closed and startup-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-rain-registry-cache-"));
  const path = join(root, FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME);
  await writeFile(path, canonicalJsonBytes({
    activeArtifact: null,
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
    rawReason: "policy_raw",
    siteKey: "ballydidean",
  }));
  const loader = createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(root);
  assert.equal((await loader.load()).reasonCode, "policy_raw");
  await writeFile(path, canonicalJsonBytes({
    activeArtifact: { artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256 },
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
    rawReason: null,
    siteKey: "ballydidean",
  }));
  assert.equal((await loader.load()).reasonCode, "policy_raw");
  assert.equal(
    (await createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(root).load()).state,
    "active",
  );

  await writeFile(path, canonicalJsonBytes({
    activeArtifact: null,
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
    extra: true,
    rawReason: "policy_raw",
    siteKey: "ballydidean",
  }));
  assert.equal(
    (await createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(root).load()).reasonCode,
    "registry_invalid",
  );

  const missingRoot = await mkdtemp(join(tmpdir(), "weather-rain-registry-missing-"));
  assert.equal(
    (await createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(missingRoot).load()).reasonCode,
    "registry_invalid",
  );
});

// bind the shipped public registry to the generated compiled artifact
test("public rain runtime registry is canonical and active", async () => {
  const root = resolve(import.meta.dirname, "../../../config/forecast-adjustments");
  const bytes = await readFile(
    join(root, FORECAST_ADJUSTMENT_RAIN_RUNTIME_REGISTRY_FILENAME),
    "utf8",
  );
  assert.equal(bytes, canonicalJsonBytes(JSON.parse(bytes)));
  const loaded = await createForecastAdjustmentRainRuntimeRegistryLoaderForRoot(root).load();
  assert.deepEqual(
    { artifactSha256: loaded.artifactSha256, reasonCode: loaded.reasonCode, state: loaded.state },
    {
      artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
      reasonCode: null,
      state: "active",
    },
  );
  assert.equal(loaded.comparatorAuthority.authorityKind, "legacy_active");
});
