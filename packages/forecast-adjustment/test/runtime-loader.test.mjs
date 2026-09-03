import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  canonicalJsonBytes,
  canonicalObjectSha256,
  canonicalSha256,
  createForecastAdjustmentRuntimeBundle,
  createForecastAdjustmentRuntimeLoader,
  createForecastAdjustmentRuntimeLoaderForRoot,
  FORECAST_ADJUSTMENT_REGISTRY_FILENAME,
  FORECAST_ADJUSTMENT_RUNTIME_ROOT,
} from "../dist/index.js";

import { createQualifiedFixture } from "./evidence-fixtures.mjs";

// write one reviewed registry and bundle tree
async function writeRuntimeTree(root, bundle) {
  const bundleDirectory = join(root, "ballydidean", "bundles");
  await mkdir(bundleDirectory, { recursive: true });
  await writeFile(
    join(bundleDirectory, `sha256-${bundle.bundleSha256}.json`),
    canonicalJsonBytes(bundle),
  );
  await writeFile(
    join(root, "ballydidean.json"),
    canonicalJsonBytes(registryForBundle(bundle)),
  );
}

// create one exact active or inactive registry fixture
function registryForBundle(bundle) {
  return {
    activeBundle: bundle === null
      ? null
      : {
          bundleSha256: bundle.bundleSha256,
          candidateArtifactSha256: bundle.candidate.candidateArtifactSha256,
          evaluationReportSha256:
            bundle.evaluationReport.evaluationReportSha256,
          path: `bundles/sha256-${bundle.bundleSha256}.json`,
          qualificationReceiptSha256:
            bundle.qualificationReceipt.qualificationReceiptSha256,
        },
    contractVersion: "forecast-adjustment-registry/v1",
  };
}

// create a second valid reviewed bundle without mutating the first
function createDistinctRuntimeBundle(original) {
  const coefficients = original.candidate.coefficients.map(
    (coefficient, index) => index === 0
      ? { ...coefficient, coefficient: coefficient.coefficient + 0.25 }
      : coefficient,
  );
  const candidate = {
    ...original.candidate,
    coefficientPayloadSha256: canonicalSha256(coefficients),
    coefficients,
  };
  return rehashRuntimeBundleEvidence(original, candidate);
}

// cascade immutable hashes after one intentional candidate mutation
function rehashRuntimeBundleEvidence(original, candidate) {
  candidate.candidateArtifactSha256 = canonicalObjectSha256(
    candidate,
    "candidateArtifactSha256",
  );
  const evaluationReport = {
    ...original.evaluationReport,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
  };
  evaluationReport.evaluationReportSha256 = canonicalObjectSha256(
    evaluationReport,
    "evaluationReportSha256",
  );
  const qualificationReceipt = {
    ...original.qualificationReceipt,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    evaluationReportSha256: evaluationReport.evaluationReportSha256,
  };
  qualificationReceipt.qualificationReceiptSha256 = canonicalObjectSha256(
    qualificationReceipt,
    "qualificationReceiptSha256",
  );
  const bundle = {
    ...original,
    candidate,
    evaluationReport,
    qualificationReceipt,
  };
  bundle.bundleSha256 = canonicalObjectSha256(bundle, "bundleSha256");
  return bundle;
}

test("runtime loader deep-freezes and caches the first successful load", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-"));
  const ledger = await mkdtemp(join(tmpdir(), "weather-runtime-ledger-"));
  const triple = await createQualifiedFixture(ledger);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  await writeRuntimeTree(root, bundle);
  const loader = createForecastAdjustmentRuntimeLoaderForRoot(root);
  const first = await loader.load();
  assert.equal(first.state, "active");
  assert.equal(Object.isFrozen(first.bundle.candidate.coefficients), true);
  await writeFile(join(root, "ballydidean.json"), "not json\n");
  const second = await loader.load();
  assert.equal(second, first);
});

test("runtime loader caches bundle substitution as disabled raw service", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-invalid-"));
  const ledger = await mkdtemp(join(tmpdir(), "weather-runtime-invalid-ledger-"));
  const triple = await createQualifiedFixture(ledger);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  await writeRuntimeTree(root, bundle);
  const bundlePath = join(
    root,
    "ballydidean",
    "bundles",
    `sha256-${bundle.bundleSha256}.json`,
  );
  const substituted = JSON.parse(await readFile(bundlePath, "utf8"));
  substituted.evaluationReport.candidateArtifactSha256 = "0".repeat(64);
  await writeFile(bundlePath, canonicalJsonBytes(substituted));
  const loader = createForecastAdjustmentRuntimeLoaderForRoot(root);
  assert.deepEqual(await loader.load(), {
    bundle: null,
    reasonCode: "bundle_invalid",
    state: "disabled",
  });
});

test("runtime loader disables missing embedded receipt material", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-receipt-missing-"));
  const ledger = await mkdtemp(
    join(tmpdir(), "weather-runtime-receipt-missing-ledger-"),
  );
  const triple = await createQualifiedFixture(ledger);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  await writeRuntimeTree(root, bundle);
  const bundlePath = join(
    root,
    "ballydidean",
    "bundles",
    `sha256-${bundle.bundleSha256}.json`,
  );
  const missingReceipt = JSON.parse(await readFile(bundlePath, "utf8"));
  delete missingReceipt.qualificationReceipt;
  await writeFile(bundlePath, canonicalJsonBytes(missingReceipt));
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(root).load(),
    { bundle: null, reasonCode: "bundle_invalid", state: "disabled" },
  );
});

test("runtime loader disables a fully rehashed parallel provenance bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-provenance-"));
  const ledger = await mkdtemp(
    join(tmpdir(), "weather-runtime-provenance-ledger-"),
  );
  const triple = await createQualifiedFixture(ledger);
  const original = createForecastAdjustmentRuntimeBundle(triple);
  const trainingProvenance = {
    ...original.candidate.trainingProvenance,
    spatialWeightSha256: "f".repeat(64),
  };
  const candidate = {
    ...original.candidate,
    trainingProvenance,
  };
  candidate.candidateArtifactSha256 = canonicalObjectSha256(
    candidate,
    "candidateArtifactSha256",
  );
  const evaluationReport = {
    ...original.evaluationReport,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    trainingProvenance,
  };
  evaluationReport.evaluationReportSha256 = canonicalObjectSha256(
    evaluationReport,
    "evaluationReportSha256",
  );
  const qualificationReceipt = {
    ...original.qualificationReceipt,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    evaluationReportSha256: evaluationReport.evaluationReportSha256,
    trainingProvenance,
  };
  qualificationReceipt.qualificationReceiptSha256 = canonicalObjectSha256(
    qualificationReceipt,
    "qualificationReceiptSha256",
  );
  const forged = {
    ...original,
    candidate,
    evaluationReport,
    qualificationReceipt,
  };
  forged.bundleSha256 = canonicalObjectSha256(forged, "bundleSha256");
  await writeRuntimeTree(root, forged);
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(root).load(),
    {
      bundle: null,
      reasonCode: "bundle_invalid",
      state: "disabled",
    },
  );
});

test("runtime loader disables a fully rehashed calendar fingerprint mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-calendar-"));
  const ledger = await mkdtemp(join(tmpdir(), "weather-runtime-calendar-ledger-"));
  const triple = await createQualifiedFixture(ledger);
  const original = createForecastAdjustmentRuntimeBundle(triple);
  const forged = rehashRuntimeBundleEvidence(original, {
    ...original.candidate,
    runtimeFingerprint: {
      ...original.candidate.runtimeFingerprint,
      tzdataVersion: "forged-tzdata",
    },
  });
  await writeRuntimeTree(root, forged);
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(root).load(),
    { bundle: null, reasonCode: "bundle_invalid", state: "disabled" },
  );
});

test("runtime loader accepts the reviewed inactive registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-inactive-"));
  await writeFile(
    join(root, "ballydidean.json"),
    canonicalJsonBytes(registryForBundle(null)),
  );
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(root).load(),
    {
      bundle: null,
      reasonCode: "registry_inactive",
      state: "disabled",
    },
  );
});

test("runtime loader uses literal production paths without external I/O hooks", async () => {
  const source = await readFile(
    new URL("../src/runtime-loader.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    FORECAST_ADJUSTMENT_RUNTIME_ROOT,
    "/opt/weather/config/forecast-adjustments",
  );
  assert.equal(FORECAST_ADJUSTMENT_REGISTRY_FILENAME, "ballydidean.json");
  assert.equal(typeof createForecastAdjustmentRuntimeLoader().load, "function");
  assert.doesNotMatch(
    source,
    /process\.env|\bfetch\s*\(|\bwatch\s*\(|model-evidence|\.weather-data|\.weather-models|ecowitt|tempest|public-stations|decryptionKey|privateKey/u,
  );
});

test("committed registry is exact canonical inactive v1", async () => {
  const registryPath = resolve(
    import.meta.dirname,
    "../../..",
    "config",
    "forecast-adjustments",
    "ballydidean.json",
  );
  assert.equal(
    await readFile(registryPath, "utf8"),
    canonicalJsonBytes(registryForBundle(null)),
  );
});

test("runtime loader bounds missing and unsafe path material as disabled", async () => {
  const missingRegistryRoot = await mkdtemp(
    join(tmpdir(), "weather-runtime-missing-registry-"),
  );
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(missingRegistryRoot).load(),
    { bundle: null, reasonCode: "registry_invalid", state: "disabled" },
  );
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot("relative-runtime-root").load(),
    { bundle: null, reasonCode: "registry_invalid", state: "disabled" },
  );

  const ledger = await mkdtemp(join(tmpdir(), "weather-runtime-path-ledger-"));
  const triple = await createQualifiedFixture(ledger);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  const missingBundleRoot = await mkdtemp(
    join(tmpdir(), "weather-runtime-missing-bundle-"),
  );
  await writeFile(
    join(missingBundleRoot, "ballydidean.json"),
    canonicalJsonBytes(registryForBundle(bundle)),
  );
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(missingBundleRoot).load(),
    { bundle: null, reasonCode: "bundle_missing", state: "disabled" },
  );

  const unsafeRegistryRoot = await mkdtemp(
    join(tmpdir(), "weather-runtime-unsafe-registry-"),
  );
  const unsafeRegistry = registryForBundle(bundle);
  unsafeRegistry.activeBundle.path = "/tmp/sha256-forged.json";
  await writeFile(
    join(unsafeRegistryRoot, "ballydidean.json"),
    canonicalJsonBytes(unsafeRegistry),
  );
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(unsafeRegistryRoot).load(),
    { bundle: null, reasonCode: "registry_invalid", state: "disabled" },
  );
});

test("runtime loader rejects an intermediate bundle-directory symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-link-"));
  const outside = await mkdtemp(join(tmpdir(), "weather-runtime-link-outside-"));
  const ledger = await mkdtemp(join(tmpdir(), "weather-runtime-link-ledger-"));
  const triple = await createQualifiedFixture(ledger);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  await writeRuntimeTree(root, bundle);
  await mkdir(join(outside, "bundles"));
  await writeFile(
    join(outside, "bundles", `sha256-${bundle.bundleSha256}.json`),
    canonicalJsonBytes(bundle),
  );
  await rm(join(root, "ballydidean"), { recursive: true });
  await symlink(outside, join(root, "ballydidean"), "dir");
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(root).load(),
    { bundle: null, reasonCode: "bundle_invalid", state: "disabled" },
  );
});

test("two-bundle and null rollback require a fresh loader restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "weather-runtime-restart-"));
  const ledger = await mkdtemp(join(tmpdir(), "weather-runtime-restart-ledger-"));
  const triple = await createQualifiedFixture(ledger);
  const firstBundle = createForecastAdjustmentRuntimeBundle(triple);
  const secondBundle = createDistinctRuntimeBundle(firstBundle);
  await writeRuntimeTree(root, firstBundle);
  const firstLoader = createForecastAdjustmentRuntimeLoaderForRoot(root);
  const first = await firstLoader.load();
  assert.equal(first.state, "active");
  assert.equal(first.bundle.bundleSha256, firstBundle.bundleSha256);

  await writeRuntimeTree(root, secondBundle);
  assert.equal((await firstLoader.load()).bundle.bundleSha256, firstBundle.bundleSha256);
  const secondLoader = createForecastAdjustmentRuntimeLoaderForRoot(root);
  assert.equal((await secondLoader.load()).bundle.bundleSha256, secondBundle.bundleSha256);

  await writeFile(
    join(root, "ballydidean.json"),
    canonicalJsonBytes(registryForBundle(null)),
  );
  assert.equal((await secondLoader.load()).bundle.bundleSha256, secondBundle.bundleSha256);
  assert.deepEqual(
    await createForecastAdjustmentRuntimeLoaderForRoot(root).load(),
    { bundle: null, reasonCode: "registry_inactive", state: "disabled" },
  );
  assert.equal(
    await readFile(
      join(root, "ballydidean", "bundles", `sha256-${firstBundle.bundleSha256}.json`),
      "utf8",
    ),
    canonicalJsonBytes(firstBundle),
  );
  assert.equal(
    await readFile(
      join(root, "ballydidean", "bundles", `sha256-${secondBundle.bundleSha256}.json`),
      "utf8",
    ),
    canonicalJsonBytes(secondBundle),
  );

  const nullLoader = createForecastAdjustmentRuntimeLoaderForRoot(root);
  assert.equal((await nullLoader.load()).reasonCode, "registry_inactive");
  await writeRuntimeTree(root, firstBundle);
  assert.equal((await nullLoader.load()).reasonCode, "registry_inactive");
  assert.equal(
    (await createForecastAdjustmentRuntimeLoaderForRoot(root).load()).bundle
      .bundleSha256,
    firstBundle.bundleSha256,
  );
});
