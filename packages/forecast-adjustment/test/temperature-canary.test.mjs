import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  applyForecastAdjustmentTemperatureCanary,
  canonicalJsonBytes,
  createForecastAdjustmentTemperatureCanaryAuthorization,
  createForecastAdjustmentTemperatureCanaryRuntimeBundle,
  createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot,
  forecastAdjustmentTemperatureCanaryIsKilled,
  runtimeCalendarFingerprint,
  validateForecastAdjustmentTemperatureCanaryRuntimeBundleLinks,
  verifyForecastAdjustmentTemperatureCanaryRuntimeBundle,
} from "../dist/index.js";

const CUTOFF = "2026-08-25T07:00:00.000Z";

// create one exact delayed-scope model
function createModel() {
  return {
    adaptiveCoefficients: Array.from(
      { length: 49 },
      (_unused, index) => ((index % 9) - 4) * 0.011,
    ),
    cohort: "ecmwf_single_run_hindcast",
    contractVersion: "temperature-shortlead-models-research/v1",
    directCoefficients: Array.from(
      { length: 35 },
      (_unused, index) => ((index % 7) - 3) * 0.017,
    ),
    learnedStrengthContractVersion:
      "temperature-winner-extensions-research/v1",
    month: "2026-09",
    scope: "assumed_delay6_next12",
    strengthBands: {
      "1-6": { alpha: 1, supported: true, trainingCutoffUtc: CUTOFF },
      "7-12": { alpha: 1, supported: true, trainingCutoffUtc: CUTOFF },
    },
    supported: true,
    trainingCutoffUtc: CUTOFF,
  };
}

// create one explicitly authorized sanitized bundle
function createBundle() {
  const authorization = createForecastAdjustmentTemperatureCanaryAuthorization({
    activatedAt: "2026-09-08T00:22:24.734Z",
    authorizationReason: "operator-approved opt-in ECMWF temperature canary",
    authorizedAt: "2026-09-08T00:22:24.734Z",
    authorizedBy: "Ansel",
    expiresAt: "2026-09-22T00:22:24.734Z",
  });
  return createForecastAdjustmentTemperatureCanaryRuntimeBundle({
    authorization,
    evidence: {
      modelSourceSha256: "a".repeat(64),
      researchSummarySha256: "b".repeat(64),
      retentionManifestSha256: "c".repeat(64),
      strengthSourceSha256: "d".repeat(64),
    },
    model: createModel(),
    runtimeFingerprint: runtimeCalendarFingerprint(),
    servedForecastIdentity: {
      adapterVersion: "open-meteo-ecmwf-single-run/v1",
      dataset: "single_run",
      maximumReceiptAgeHours: 12,
      providerKey: "open-meteo",
      sourceDelayHours: 6,
      upstreamModel: "ecmwf_ifs",
    },
  });
}

// create one causal recent-error state
function createState(supported = true) {
  return {
    b24C: supported ? 0.8 : null,
    b72C: supported ? 0.3 : null,
    cohort: "ecmwf_single_run_hindcast",
    localDates: supported ? 3 : 0,
    mad72C: supported ? 0.4 : null,
    maximumSourceRunInitializedAt: supported
      ? "2026-09-07T00:00:00.000Z"
      : null,
    maximumSourceValidAt: supported ? "2026-09-07T17:00:00.000Z" : null,
    n24: supported ? 12 : 0,
    n72: supported ? 50 : 0,
    sourceKeys: supported
      ? Array.from({ length: 50 }, (_unused, index) => `source-${index}`)
      : [],
    supported,
    targetRunInitializedAt: "2026-09-08T00:00:00.000Z",
    windowEndValidAt: "2026-09-07T17:00:00.000Z",
  };
}

// create one truthfully received live ECMWF hour
function createSource(overrides = {}) {
  return {
    adapterVersion: "open-meteo-ecmwf-single-run/v1",
    dataset: "single_run",
    firstReceivedAt: "2026-09-08T06:05:00.000Z",
    modelCycle: "50r1",
    modelLeadHours: 7,
    providerKey: "open-meteo",
    providerResponseSha256: "e".repeat(64),
    rawRelativeHumidityPercent: 78,
    rawTemperatureC: 16.4,
    rawWindSpeedMps: 3.2,
    runInitializedAt: "2026-09-08T00:00:00.000Z",
    upstreamModel: "ecmwf_ifs",
    validAt: "2026-09-08T07:00:00.000Z",
    ...overrides,
  };
}

// apply one standard active fixture
function applyFixture(overrides = {}) {
  const bundle = createBundle();
  return applyForecastAdjustmentTemperatureCanary(
    { bundle, reasonCode: null, state: "active" },
    {
      evaluatedAt: "2026-09-08T06:10:00.000Z",
      rawBestMatchTemperatureC: 17.2,
      recentErrorState: createState(),
      sourceForecast: createSource(),
      validAt: "2026-09-08T07:00:00.000Z",
      ...overrides,
    },
  );
}

// write one canonical temperature runtime tree
async function writeRuntimeTree(root, bundle) {
  const directory = join(root, "ballydidean", "temperature-canary-bundles");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `sha256-${bundle.bundleSha256}.json`),
    canonicalJsonBytes(bundle),
  );
  await writeFile(
    join(root, "ballydidean-temperature-canary.json"),
    canonicalJsonBytes({
      activeBundle: {
        authorizationSha256: bundle.authorization.authorizationSha256,
        bundleSha256: bundle.bundleSha256,
        modelSourceSha256: bundle.evidence.modelSourceSha256,
        path: `temperature-canary-bundles/sha256-${bundle.bundleSha256}.json`,
        strengthSourceSha256: bundle.evidence.strengthSourceSha256,
      },
      contractVersion: "forecast-adjustment-temperature-canary-registry/v1",
    }),
  );
}

test("temperature canary applies ECMWF without replacing Best Match raw", () => {
  const decision = applyFixture();
  assert.equal(decision.state, "active");
  assert.equal(decision.branch, "adaptive");
  assert.equal(decision.rawBestMatchTemperatureC, 17.2);
  assert.equal(decision.sourceForecast.rawTemperatureC, 16.4);
  assert.equal(decision.sourceForecast.operationalHorizonHours, 1);
  assert.equal(decision.sourceForecast.upstreamModel, "ecmwf_ifs");
  assert.notEqual(decision.correctedTemperatureC, 17.2);
  assert.match(decision.recentErrorStateSha256, /^[a-f0-9]{64}$/u);
});

test("temperature canary uses the direct branch during causal warmup", () => {
  const decision = applyFixture({ recentErrorState: createState(false) });
  assert.equal(decision.state, "active");
  assert.equal(decision.branch, "direct");
});

test("temperature canary fails raw for missing, unavailable, stale, and past inputs", () => {
  const missing = applyFixture({ sourceForecast: null });
  assert.equal(missing.state, "raw_fallback");
  assert.equal(missing.reasonCode, "missing_source_forecast");
  assert.equal(missing.correctedTemperatureC, null);

  const unavailable = applyFixture({
    evaluatedAt: "2026-09-08T06:00:00.000Z",
  });
  assert.equal(unavailable.reasonCode, "source_not_available");

  const stale = applyFixture({
    evaluatedAt: "2026-09-08T18:05:00.001Z",
    sourceForecast: createSource({
      modelLeadHours: 18,
      validAt: "2026-09-08T18:00:00.000Z",
    }),
    validAt: "2026-09-08T18:00:00.000Z",
  });
  assert.equal(stale.reasonCode, "source_stale");

  const past = applyFixture({
    evaluatedAt: "2026-09-08T07:00:00.000Z",
  });
  assert.equal(past.reasonCode, "outside_operational_window");
});

test("temperature canary rejects cross-hour and source provenance substitution", () => {
  const crossHour = applyFixture({ validAt: "2026-09-08T08:00:00.000Z" });
  assert.equal(crossHour.reasonCode, "source_time_mismatch");

  const wrongModel = applyFixture({
    sourceForecast: createSource({ upstreamModel: "best_match" }),
  });
  assert.equal(wrongModel.reasonCode, "source_identity_mismatch");
  assert.equal(wrongModel.sourceForecast, null);

  const wrongAdapter = applyFixture({
    sourceForecast: createSource({ adapterVersion: "unreviewed-adapter/v999" }),
  });
  assert.equal(wrongAdapter.reasonCode, "source_identity_mismatch");
  assert.equal(wrongAdapter.sourceForecast, null);
});

test("temperature authorization and bundle reject expiry and tampering", () => {
  assert.throws(
    () => createForecastAdjustmentTemperatureCanaryAuthorization({
      activatedAt: "2026-09-08T00:22:24.734Z",
      authorizationReason: "too long",
      authorizedAt: "2026-09-08T00:22:24.734Z",
      authorizedBy: "Ansel",
      expiresAt: "2026-09-22T00:22:24.735Z",
    }),
    /authorization window/u,
  );

  const bundle = createBundle();
  const tampered = structuredClone(bundle);
  tampered.model.directCoefficients[0] += 1;
  assert.throws(
    () => verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(tampered),
    /bundle SHA-256 mismatch/u,
  );
});

test("temperature loader defaults killed and isolates expiry and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-temperature-canary-"));
  const bundle = createBundle();
  await writeRuntimeTree(root, bundle);
  assert.equal(forecastAdjustmentTemperatureCanaryIsKilled(undefined), true);
  assert.equal(forecastAdjustmentTemperatureCanaryIsKilled("1"), true);
  assert.equal(forecastAdjustmentTemperatureCanaryIsKilled("0"), false);
  assert.deepEqual(
    await createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot(root).load(),
    { bundle: null, reasonCode: "canary_killed", state: "disabled" },
  );
  assert.equal(
    (await createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot(root, {
      environmentKillSwitch: "0",
      now: () => "2026-09-08T01:00:00.000Z",
    }).load()).state,
    "active",
  );
  assert.deepEqual(
    await createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot(root, {
      environmentKillSwitch: "0",
      now: () => "2026-09-22T00:22:24.734Z",
    }).load(),
    { bundle: null, reasonCode: "canary_expired", state: "disabled" },
  );

  const outside = await mkdtemp(join(tmpdir(), "weather-temperature-outside-"));
  const symlinkRoot = await mkdtemp(join(tmpdir(), "weather-temperature-link-"));
  await writeRuntimeTree(outside, bundle);
  await writeFile(
    join(symlinkRoot, "ballydidean-temperature-canary.json"),
    await readFile(join(outside, "ballydidean-temperature-canary.json"), "utf8"),
  );
  await symlink(
    join(outside, "ballydidean"),
    join(symlinkRoot, "ballydidean"),
    "dir",
  );
  assert.deepEqual(
    await createForecastAdjustmentTemperatureCanaryRuntimeLoaderForRoot(
      symlinkRoot,
      { environmentKillSwitch: "0", now: () => "2026-09-08T01:00:00.000Z" },
    ).load(),
    { bundle: null, reasonCode: "bundle_invalid", state: "disabled" },
  );
});

test("committed temperature canary is sanitized and content addressed", async () => {
  const root = resolve(
    import.meta.dirname,
    "../../..",
    "config",
    "forecast-adjustments",
  );
  const registryBytes = await readFile(
    join(root, "ballydidean-temperature-canary.json"),
    "utf8",
  );
  const registry = JSON.parse(registryBytes);
  assert.equal(registryBytes, canonicalJsonBytes(registry));
  assert.equal(
    registry.activeBundle.bundleSha256,
    "3e82073a266ca88c15f492f86bbefbca8b8cda029520af6cc78e0a0062ee50dd",
  );
  const bundleBytes = await readFile(
    join(root, "ballydidean", registry.activeBundle.path),
    "utf8",
  );
  const bundle = JSON.parse(bundleBytes);
  assert.equal(bundleBytes, canonicalJsonBytes(bundle));
  validateForecastAdjustmentTemperatureCanaryRuntimeBundleLinks(
    registry,
    bundle,
  );
  assert.equal(
    bundle.servedForecastIdentity.adapterVersion,
    "open-meteo-ecmwf-single-run/v1",
  );
  assert.equal(bundle.model.directCoefficients.length, 35);
  assert.equal(bundle.model.adaptiveCoefficients.length, 49);
  assert.doesNotMatch(
    bundleBytes,
    /trainingKeys|trajectory|\/dev\/shm|model-evidence|source\/results/u,
  );
});
