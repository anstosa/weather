import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as canonical from "../../../packages/forecast-adjustment/dist/index.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
} from "../../../packages/forecast-adjustment/dist/rain-hurdle-wind-artifact.js";
import { createQualifiedFixture } from "../../../packages/forecast-adjustment/test/evidence-fixtures.mjs";
import * as publicContract from "../src/adjustment-maintenance-contract.mjs";

const HASH = "a".repeat(64);
const SECOND_HASH = "b".repeat(64);
const THIRD_HASH = "c".repeat(64);
const dueKey = `confirmation/temperature/${HASH}`;
const leadBands = ["001-024", "025-048", "049-072", "073-096", "097-120", "121-144", "145-168"];

// hash exact member bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// encode one canonical json member
function canonicalBytes(value) {
  return Buffer.from(canonical.canonicalJsonBytes(value));
}

// create one exact qualified installation receipt
function qualifiedReceipt(bundleSha256, family) {
  return {
    actionKind: "promote", actionSha256: HASH, bundleSha256, candidateGraphSha256: SECOND_HASH,
    candidateSha256: THIRD_HASH, contractVersion: "adjustment-installed-candidate-receipt/v2",
    controlPlaneSha256: HASH, deployedCommit: HASH, deployedImageDigest: `sha256:${SECOND_HASH}`,
    deployedRelease: "2026.10.09-3", deployedSettingsSha256: THIRD_HASH, fencingToken: "1",
    fullMemberRootSha256: HASH, installedAt: "2026-10-08T00:00:00.000Z", lifecycleHeadSha256: SECOND_HASH,
    policyDecision: "qualified", policyReportSha256: THIRD_HASH, registrationSha256: HASH,
    sourceSha256: family === "rain" ? SECOND_HASH : HASH,
  };
}

// embed exact artifact and receipt bytes without pre-validating tampered fixtures
function servingAuthority(artifact, receipt, authorityKind, exactArtifactBytes = null) {
  const artifactBytes = artifact === null ? null : exactArtifactBytes ?? canonicalBytes(artifact);
  const receiptBytes = canonicalBytes(receipt);
  return {
    artifactBase64: artifactBytes?.toString("base64") ?? null,
    artifactIdentitySha256: artifactBytes === null ? null : String(artifact.bundleSha256 ?? sha256(artifactBytes)),
    artifactMemberSha256: artifactBytes === null ? null : sha256(artifactBytes),
    authorityKind,
    receiptBase64: receiptBytes.toString("base64"),
    receiptMemberSha256: sha256(receiptBytes),
  };
}

// encode one minimal family comparator in the frozen key order
function comparatorBytes(family, authority) {
  const common = { validAt: "2026-10-08T01:00:00.000Z", leadHours: 1, sourceRowSha256: HASH };
  let row;
  // retain the exact family row schema
  if (family === "temperature") {
    row = { ...common, incumbentTemperatureC64: canonical.encodeMaintenanceBinary64(10), applied: true, reasonCode: null };
  } else if (family === "wind") {
    row = { ...common, incumbentSpeedMps64: canonical.encodeMaintenanceBinary64(5),
      incumbentGustMps64: canonical.encodeMaintenanceBinary64(8), speedApplied: true, gustApplied: true, reasonCode: null };
  } else {
    row = { ...common, incumbentPrecipitationMm64: canonical.encodeMaintenanceBinary64(2),
      occurrenceProbability64: canonical.encodeMaintenanceBinary64(.6),
      atLeast1_0Probability64: canonical.encodeMaintenanceBinary64(.4),
      atLeast2_5Probability64: canonical.encodeMaintenanceBinary64(.2),
      positiveAmountMm64: canonical.encodeMaintenanceBinary64(2), applied: true, reasonCode: null };
  }
  return Buffer.from(JSON.stringify({ contractVersion: "adjustment-shadow-incumbent-comparator/v1", family,
    registrationSha256: HASH, candidateSha256: SECOND_HASH, sourceSha256: THIRD_HASH,
    dueKey, issuedAt: "2026-10-08T00:00:00.000Z", sourceProjectionSha256: HASH,
    predictionBodySha256: SECOND_HASH, servingAuthority: authority, rowCount: 1, rows: [row] }) + "\n");
}

// compare exact acceptance or rejection at both boundaries
function assertComparatorParity(bytes, accepted = true) {
  if (accepted) {
    assert.deepEqual(publicContract.parseMaintenanceShadowComparator(bytes),
      canonical.parseMaintenanceShadowComparator(bytes));
    return;
  }
  assert.throws(() => canonical.parseMaintenanceShadowComparator(bytes));
  assert.throws(() => publicContract.parseMaintenanceShadowComparator(bytes));
}

// create one valid portable temperature runtime
async function temperaturePackage() {
  const incumbent = JSON.parse(await readFile(new URL(
    "../../../config/forecast-adjustments/ballydidean/temperature-canary-bundles/" +
    "sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json",
    import.meta.url,
  )));
  const value = { candidateSha256: HASH, contractVersion: "forecast-adjustment-maintenance-runtime-package/v1",
    dueMonth: "2026-10", family: "temperature", model: incumbent.model,
    source: { adapterVersion: "open-meteo-ecmwf-single-run/v1", cohort: "ecmwf_single_run_hindcast",
      dataset: "single_run", maximumReceiptAgeHours: 12, providerKey: "open-meteo",
      scope: "assumed_delay6_next12", sourceDelayHours: 6, upstreamModel: "ecmwf_ifs" } };
  value.bundleSha256 = canonical.canonicalObjectSha256(value, "bundleSha256");
  canonical.verifyForecastAdjustmentMaintenanceRuntimePackage(value);
  return value;
}

// create all thirteen supported wind pairs
function windPairs() {
  return [
    ...leadBands.map((leadBand) => ({ leadBand, metric: "windSpeedMps" })),
    ...leadBands.filter((leadBand) => leadBand !== "049-072")
      .map((leadBand) => ({ leadBand, metric: "windGustMps" })),
  ];
}

// create one portable wind runtime through the canonical builder
function windPackage() {
  const pairs = windPairs();
  const stationScores = [["ambient-maxweather", "ambient"], ["ballydidean-ecowitt", "ecowitt"],
    ["netatmo-nearby", "netatmo"], ["tempest-126537", "tempest"], ["tempest-168853", "tempest"]]
    .map(([physicalStationKey, providerFamily]) => ({ adjustedLoss: 9, eventCount: 100, physicalStationKey,
      pointSkill: .1, providerFamily, rawLoss: 10, remainingNetworkScoreEvents: 100,
      scoreMatches: 100, trainingMatches: 500 }));
  const developmentReport = canonical.createDevelopmentReport({ enabledMetricBands: pairs,
    folds: pairs.flatMap((metricBand) => [1, 2, 3, 4, 5].map((fold) => canonical.evaluateDevelopmentLosoFold({
      auxiliaryModelSha256s: ["1", "2", "3", "4", "5"].map((value) => value.repeat(64)),
      bootstrapLowerBound: .01, fold, materialHarmSliceKeys: [], metricBand, stationScores }))) });
  const candidate = canonical.createForecastAdjustmentCandidate({ coefficients: pairs.map((pair) => ({
    coefficient: .25, daypart: null, effectiveEventCount: 200, leadBand: pair.leadBand, level: 1,
    metric: pair.metric, month: null, season: null })), developmentReportSha256: developmentReport.developmentReportSha256,
    enabledMetricBands: pairs, evaluationEpochId: "maintenance-2026-10", exportManifestSha256: HASH,
    finalTrainingCutoff: "2026-09-01T06:59:59.999Z",
    forecastIdentity: canonical.FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
    runtimeFingerprint: canonical.runtimeCalendarFingerprint(), trainingEnvelopes: pairs.map((pair) => ({
      leadBand: pair.leadBand, maximum: 40, metric: pair.metric, minimum: 0 })),
    trainingProvenance: canonical.FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1 });
  return canonical.buildForecastAdjustmentMaintenanceRuntimePackage(canonicalBytes({ candidate,
    confirmationOpened: false, contractVersion: "wind-maintenance-fit/v2", developmentReport,
    dueMonth: "2026-10", state: "development_candidate" }));
}

// project the private incumbent to the exact portable rain schema
function rainPackage() {
  const incumbent = JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON);
  const value = { categoryScales: incumbent.categoryScales, contractVersion: incumbent.contractVersion,
    featureNames: incumbent.featureNames, heads: incumbent.heads, modelMonth: incumbent.modelMonth, rules: incumbent.rules };
  canonical.validateRainHurdleWindPortableArtifact(canonical.canonicalJsonBytes(value), sha256(canonicalBytes(value)));
  return value;
}

// cascade a nested candidate mutation through every runtime bundle identity
function rehashRuntimeBundleCandidate(bundle, candidate) {
  candidate.candidateArtifactSha256 = canonical.canonicalObjectSha256(
    candidate,
    "candidateArtifactSha256",
  );
  const evaluationReport = {
    ...bundle.evaluationReport,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
  };
  evaluationReport.evaluationReportSha256 = canonical.canonicalObjectSha256(
    evaluationReport,
    "evaluationReportSha256",
  );
  const qualificationReceipt = {
    ...bundle.qualificationReceipt,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    evaluationReportSha256: evaluationReport.evaluationReportSha256,
  };
  qualificationReceipt.qualificationReceiptSha256 = canonical.canonicalObjectSha256(
    qualificationReceipt,
    "qualificationReceiptSha256",
  );
  const value = { ...bundle, candidate, evaluationReport, qualificationReceipt };
  value.bundleSha256 = canonical.canonicalObjectSha256(value, "bundleSha256");
  return value;
}

// build one exact retained generic v2 runtime bundle
async function legacyRuntimeBundle() {
  const directory = await mkdtemp(join(tmpdir(), "weather-public-contract-runtime-"));
  try {
    return canonical.createForecastAdjustmentRuntimeBundle(
      await createQualifiedFixture(directory),
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

// load one exact retained legacy bundle
async function legacyBundle(family) {
  const relative = family === "temperature"
    ? "../../../config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json"
    : "../../../config/forecast-adjustments/ballydidean/wind-canary-bundles/sha256-51f8efd63bef678a7f02d11bdab91405ec48f19808f64d3fe8354036c9b302a2.json";
  return JSON.parse(await readFile(new URL(relative, import.meta.url)));
}

test("comparator authority matrix retains canonical structural validation", async () => {
  const qualified = { temperature: await temperaturePackage(), wind: windPackage(), rain: rainPackage() };
  // verify every qualified family
  for (const [family, artifact] of Object.entries(qualified)) {
    const identity = String(artifact.bundleSha256 ?? sha256(canonicalBytes(artifact)));
    assertComparatorParity(comparatorBytes(family,
      servingAuthority(artifact, qualifiedReceipt(identity, family), "maintenance_qualified")));
  }
  // verify every retained legacy family
  for (const family of ["temperature", "wind"]) {
    const artifact = await legacyBundle(family);
    assertComparatorParity(comparatorBytes(family,
      servingAuthority(artifact, artifact.authorization, "legacy_active")));
  }
  const rainArtifact = JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON);
  assertComparatorParity(comparatorBytes("rain", servingAuthority(rainArtifact,
    { activeArtifact: { artifactSha256: sha256(Buffer.from(RAIN_HURDLE_WIND_ARTIFACT_JSON)) },
      contractVersion: "forecast-adjustment-rain-runtime-registry/v1", rawReason: null, siteKey: "ballydidean" },
    "legacy_active", Buffer.from(RAIN_HURDLE_WIND_ARTIFACT_JSON))));
  const rawReceipts = {
    temperature: [
      { activeBundle: null, contractVersion: "forecast-adjustment-temperature-canary-registry/v2", rawReason: "policy_raw", siteKey: "ballydidean" },
      { activePackage: null, contractVersion: "forecast-adjustment-temperature-maintenance-registry/v1", rawReason: "policy_raw", siteKey: "ballydidean" },
    ],
    wind: [
      { activeBundle: null, contractVersion: "forecast-adjustment-wind-canary-registry/v2", enabledMetricBands: windPairs(), rawReason: "policy_raw", siteKey: "ballydidean" },
      { activePackage: null, contractVersion: "forecast-adjustment-wind-maintenance-registry/v1", rawReason: "policy_raw", siteKey: "ballydidean" },
    ],
    rain: [
      { activeArtifact: null, contractVersion: "forecast-adjustment-rain-runtime-registry/v1", rawReason: "policy_raw", siteKey: "ballydidean" },
      { activePackage: null, contractVersion: "forecast-adjustment-rain-maintenance-registry/v1", rawReason: "policy_raw", siteKey: "ballydidean" },
    ],
  };
  // verify every raw registry grammar
  for (const [family, receipts] of Object.entries(rawReceipts)) {
    for (const receipt of receipts) {
      assertComparatorParity(comparatorBytes(family, servingAuthority(null, receipt, "policy_raw")));
    }
  }
});

test("semantic tampering remains rejected after every enclosing hash is recomputed", async () => {
  const temperature = structuredClone(await temperaturePackage());
  temperature.model.adaptiveCoefficients[0] = null;
  temperature.bundleSha256 = canonical.canonicalObjectSha256(temperature, "bundleSha256");
  assertComparatorParity(comparatorBytes("temperature", servingAuthority(temperature,
    qualifiedReceipt(temperature.bundleSha256, "temperature"), "maintenance_qualified")), false);

  const wind = structuredClone(windPackage());
  wind.source.upstreamModel = "ecmwf_ifs";
  wind.bundleSha256 = canonical.canonicalObjectSha256(wind, "bundleSha256");
  assertComparatorParity(comparatorBytes("wind", servingAuthority(wind,
    qualifiedReceipt(wind.bundleSha256, "wind"), "maintenance_qualified")), false);

  const rain = structuredClone(rainPackage());
  rain.heads["0.1"].trees[0][0][0] = 107;
  const rainIdentity = sha256(canonicalBytes(rain));
  assertComparatorParity(comparatorBytes("rain", servingAuthority(rain,
    qualifiedReceipt(rainIdentity, "rain"), "maintenance_qualified")), false);

  // cascade permanent authorization and bundle identities for both legacy families
  for (const family of ["temperature", "wind"]) {
    const artifact = structuredClone(await legacyBundle(family));
    artifact.authorization.expiresAt = "2100-01-01T00:00:00.000Z";
    artifact.authorization.authorizationSha256 = canonical.canonicalObjectSha256(artifact.authorization, "authorizationSha256");
    artifact.bundleSha256 = canonical.canonicalObjectSha256(artifact, "bundleSha256");
    assertComparatorParity(comparatorBytes(family,
      servingAuthority(artifact, artifact.authorization, "legacy_active")), false);
  }
});

test("legacy wind generic runtime v2 retains full canonical validation", async () => {
  const artifact = await legacyRuntimeBundle();
  assertComparatorParity(comparatorBytes("wind", servingAuthority(
    artifact,
    artifact.qualificationReceipt,
    "legacy_active",
  )));

  const candidate = structuredClone(artifact.candidate);
  candidate.coefficients[0].effectiveEventCount = 0;
  const tampered = rehashRuntimeBundleCandidate(artifact, candidate);
  assertComparatorParity(comparatorBytes("wind", servingAuthority(
    tampered,
    tampered.qualificationReceipt,
    "legacy_active",
  )), false);
});
