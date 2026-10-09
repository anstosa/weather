import assert from "node:assert/strict";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildAdjustmentMaintenanceRawRegistry,
  buildAdjustmentMaintenanceServingRegistry,
  buildAdjustmentModelAction,
  buildAdjustmentRainControlReferenceAction,
  packageAdjustmentModelFamily,
  packageAdjustmentRainControlReference,
  publishAdjustmentModelRelease,
  publishAdjustmentModelReleasePair,
  publishAdjustmentRainControlReferenceReleasePair,
} from "./adjustment_model_release.mjs";
import { buildPortableRainModelPackage } from "./adjustment_rain_model_package.mjs";
import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";
import {
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
} from "./adjustment-maintenance-runtime/forecast/rain-maintenance-controls.js";
import {
  encodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";

const execFile = promisify(nodeExecFile);
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

// build one valid action input with narrow overrides
function modelAction(overrides = {}) {
  return {
    actionKind: "promote",
    candidateGraphSha256: HASH_B,
    candidateSha256: HASH_A,
    contractVersion: "forecast-adjustment-model-action/v1",
    createdAt: "2027-01-10T08:00:00.000Z",
    expectedInstalledReceiptSha256: null,
    expectedSettingsSha256: HASH_C,
    expectedSourceCommit: "1".repeat(40),
    expectedSourceRelease: "2027.01.09-1",
    family: "temperature",
    fencingToken: "1",
    fullMemberRootSha256: HASH_D,
    lifecycleHeadSha256: HASH_E,
    policyDecision: "qualified",
    policyReportSha256: HASH_B,
    predecessorActionSha256: null,
    reason: "qualified_candidate",
    reportCreatedAt: "2027-01-10T08:00:00.000Z",
    siteKey: "ballydidean",
    validThrough: "2027-01-17T08:00:00.000Z",
    ...overrides,
  };
}

// build one canonical content-addressed family registry and bundle
function familyFiles(family = "temperature", actionOverrides = {}) {
  const windBands = [
    ["windGustMps", "001-024"], ["windGustMps", "025-048"],
    ["windGustMps", "073-096"], ["windGustMps", "097-120"],
    ["windGustMps", "121-144"], ["windGustMps", "145-168"],
    ["windSpeedMps", "001-024"], ["windSpeedMps", "025-048"],
    ["windSpeedMps", "049-072"], ["windSpeedMps", "073-096"],
    ["windSpeedMps", "097-120"], ["windSpeedMps", "121-144"],
    ["windSpeedMps", "145-168"],
  ].map(
    // project the fixed wind mask
    ([metric, leadBand]) => ({ leadBand, metric }),
  );
  const candidateSha256 = adjustmentSha256(canonicalJsonBytes({
    contractVersion: `${family}-maintenance-fit/v2`,
    state: "development_candidate",
  }));
  const source = family === "temperature"
    ? {
        adapterVersion: "open-meteo-ecmwf-single-run/v1",
        cohort: "ecmwf_single_run_hindcast",
        dataset: "single_run",
        maximumReceiptAgeHours: 12,
        providerKey: "open-meteo",
        scope: "assumed_delay6_next12",
        sourceDelayHours: 6,
        upstreamModel: "ecmwf_ifs",
      }
    : { contractVersion: "wind-forecast-identity/v1", sourceSha256: HASH_B };
  const unsigned = family === "temperature"
    ? {
        candidateSha256,
        contractVersion: "forecast-adjustment-maintenance-runtime-package/v1",
        dueMonth: "2026-10",
        family,
        model: { contractVersion: "temperature-permanent-model/v1" },
        source,
      }
    : {
        candidate: { enabledMetricBands: windBands, forecastIdentity: source },
        candidateSha256,
        contractVersion: "forecast-adjustment-maintenance-runtime-package/v1",
        dueMonth: "2026-10",
        family,
        source,
      };
  const bundleSha256 = adjustmentSha256(canonicalJsonBytes(unsigned));
  const bundle = { ...unsigned, bundleSha256 };
  const directory = `${family}-canary-bundles`;
  const action = modelAction({ candidateSha256, family, ...actionOverrides });
  const registry = buildAdjustmentMaintenanceServingRegistry({
    action,
    artifactSha256: bundleSha256,
  });
  return {
    action,
    bundleSha256,
    candidateSha256,
    files: [{
      bytes: canonicalJsonBytes(bundle),
      path: `config/forecast-adjustments/ballydidean/${directory}/sha256-${bundleSha256}.json`,
    }, registry],
  };
}

// build byte-bearing parity evidence
function parity() {
  return {
    retainedInput: Buffer.from("retained-input"),
    retainedNativeOutput: Buffer.from("retained-output"),
    retainedPackagedOutput: Buffer.from("retained-output"),
    syntheticInput: Buffer.from("synthetic-input"),
    syntheticNativeOutput: Buffer.from("synthetic-output"),
    syntheticPackagedOutput: Buffer.from("synthetic-output"),
  };
}

// build one genuine pre-month state, artifact and custody action
async function rainControlReference(actionOverrides = {}) {
  const source = await readFile(
    new URL("../../packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts", import.meta.url),
    "utf8",
  );
  const artifact = JSON.parse(JSON.parse(
    source.match(/RAIN_HURDLE_WIND_ARTIFACT_JSON = (.*) as const;\n$/su)[1],
  ));
  delete artifact.nativeModelSha256;
  delete artifact.provenanceSha256;
  const ordinalArtifactBytes = canonicalJsonBytes(artifact);
  const monthStart = Date.parse(`${artifact.modelMonth}-01T00:00:00.000Z`);
  const calibrationEnd = monthStart - 7 * 86_400_000;
  const calibrationStart = calibrationEnd - 90 * 86_400_000;
  const generatedAt = new Date(calibrationEnd + 3_600_000).toISOString();
  const state = createRainMaintenanceControlState({
    calibrationEndAt: new Date(calibrationEnd).toISOString(),
    calibrationStartAt: new Date(calibrationStart).toISOString(),
    contractVersion: "rain-maintenance-control-state/v1",
    epochWitnessSha256: HASH_A,
    generatedAt,
    legacyCalibrationStartAt: new Date(calibrationEnd - 45 * 86_400_000).toISOString(),
    legacyRawScale: 1,
    modelMonth: artifact.modelMonth,
    ordinalArtifactSha256: adjustmentSha256(ordinalArtifactBytes),
    recentFallbackReason: "recent_calibration",
    recentRawScale: 1,
    recentSupported: true,
    recipeSha256: RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
    sameWindowRawScale: 1,
    scheduleContractSha256: HASH_B,
    sourceMemberRootSha256: HASH_C,
    sourceReceiptRootSha256: HASH_D,
    support: {
      calibrationDates: 60,
      calibrationHours: 500,
      calibrationRows: 500,
      calibrationWetDates: 5,
      calibrationWetHours: 20,
      effectiveDates64: encodeMaintenanceBinary64(30),
      effectiveWetDates64: encodeMaintenanceBinary64(3),
      legacyCalibrationRows: 200,
      legacyTrainingRows: 1_000,
      legacyTrainingWetRows: 100,
      trainingDates: 180,
      trainingHours: 1_000,
      trainingRows: 1_000,
      trainingWetDates: 20,
      trainingWetHours: 100,
    },
    trainingMaximumValidAt: new Date(calibrationStart - 8 * 86_400_000).toISOString(),
  });
  const controlStateBytes = encodeRainMaintenanceControlState(state);
  const action = {
    actionKind: "control_reference",
    contractVersion: "forecast-adjustment-rain-control-reference-action/v1",
    controlStateSha256: adjustmentSha256(controlStateBytes),
    createdAt: generatedAt,
    dueMonth: artifact.modelMonth,
    expectedCatalogReceiptSha256: null,
    expectedSettingsSha256: HASH_E,
    expectedSourceCommit: "1".repeat(40),
    expectedSourceRelease: "2027.01.09-1",
    family: "rain",
    fencingToken: "1",
    graphManifestSha256: HASH_F,
    ordinalArtifactSha256: adjustmentSha256(ordinalArtifactBytes),
    predecessorActionSha256: null,
    reason: "premonth_reference",
    sourceMemberRootSha256: state.sourceMemberRootSha256,
    sourceReceiptRootSha256: state.sourceReceiptRootSha256,
    validThrough: new Date(monthStart).toISOString(),
    ...actionOverrides,
  };
  return { action, controlStateBytes, ordinalArtifactBytes };
}

// build one authority-free recurring temperature runtime package
function temperatureMaintenancePackage() {
  const candidateSha256 = adjustmentSha256(canonicalJsonBytes({
    contractVersion: "temperature-maintenance-fit/v2",
    state: "development_candidate",
  }));
  const unsigned = {
    candidateSha256,
    contractVersion: "forecast-adjustment-maintenance-runtime-package/v1",
    dueMonth: "2026-10",
    family: "temperature",
    model: { contractVersion: "temperature-permanent-model/v1" },
    source: {
      adapterVersion: "open-meteo-ecmwf-single-run/v1",
      cohort: "ecmwf_single_run_hindcast",
      dataset: "single_run",
      maximumReceiptAgeHours: 12,
      providerKey: "open-meteo",
      scope: "assumed_delay6_next12",
      sourceDelayHours: 6,
      upstreamModel: "ecmwf_ifs",
    },
  };
  const bundleSha256 = adjustmentSha256(canonicalJsonBytes(unsigned));
  const bundle = { ...unsigned, bundleSha256 };
  return {
    bundleSha256,
    candidateSha256,
    file: {
      bytes: canonicalJsonBytes(bundle),
      path: `config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-${bundleSha256}.json`,
    },
  };
}

// build one immutable shadow registration bound to a candidate artifact
function shadowRegistration({ artifactSha256, candidateSha256, family }, version = "v2") {
  const registration = {
    artifactSha256,
    candidateSha256,
    cohortSha256: HASH_C,
    family,
    intervalEndAt: "2027-01-09T08:00:00.000Z",
    intervalStartAt: "2027-01-02T08:00:00.000Z",
    policySha256: HASH_D,
    registrationSha256: "",
    reservedKeySha256: HASH_E,
    siteKey: "ballydidean",
    sourceSha256: HASH_B,
    targetCutoffAt: "2027-01-09T08:00:00.000Z",
    terminalAt: "2027-01-10T08:00:00.000Z",
  };
  // extend only the rolling contract with its future-only lineage
  if (version === "v3") {
    registration.epochWitnessSha256 = HASH_E;
    registration.predecessorRegistrationSha256 = null;
    registration.scheduleContractSha256 = HASH_F;
  }
  const registrationMaterial = version === "v3"
    ? `${[
      "adjustment-shadow-registration/v3",
      registration.siteKey,
      registration.family,
      registration.candidateSha256,
      registration.artifactSha256,
      registration.policySha256,
      registration.cohortSha256,
      registration.reservedKeySha256,
      registration.sourceSha256,
      registration.epochWitnessSha256,
      registration.scheduleContractSha256,
      "none",
      registration.intervalStartAt,
      registration.intervalEndAt,
      registration.targetCutoffAt,
      registration.terminalAt,
    ].join("\n")}\n`
    : [
      "adjustment-shadow-registration/v2",
      registration.siteKey,
      registration.family,
      registration.candidateSha256,
      registration.artifactSha256,
      registration.policySha256,
      registration.cohortSha256,
      registration.reservedKeySha256,
      registration.sourceSha256,
      registration.intervalStartAt,
      registration.intervalEndAt,
      registration.targetCutoffAt,
      registration.terminalAt,
    ].join("\n");
  registration.registrationSha256 = adjustmentSha256(Buffer.from(registrationMaterial));
  return registration;
}

// build one reviewed raw serving registry
function rawRegistry(family) {
  return [buildAdjustmentMaintenanceRawRegistry(modelAction({
    actionKind: "raw",
    candidateGraphSha256: null,
    candidateSha256: null,
    family,
    policyDecision: "regressed",
    reason: "policy_raw",
  }))];
}

// run one git command for a disposable fixture
async function git(cwd, arguments_) {
  const result = await execFile("git", arguments_, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

test("action manifest binds compensation ancestry and policy freshness", () => {
  const built = buildAdjustmentModelAction(modelAction());
  assert.equal(adjustmentSha256(built.bytes), built.actionSha256);
  assert.equal(built.path.endsWith(`sha256-${built.actionSha256}.json`), true);
  const promotionWithInstalledBaseline = buildAdjustmentModelAction(modelAction({
    expectedInstalledReceiptSha256: HASH_F,
  }));
  assert.equal(promotionWithInstalledBaseline.action.expectedInstalledReceiptSha256, HASH_F);
  assert.throws(
    // reject an expired ordinary qualification
    () => buildAdjustmentModelAction(modelAction({ validThrough: "2027-01-18T08:00:00.000Z" })),
    /validity/u,
  );
  const compensation = buildAdjustmentModelAction(modelAction({
    actionKind: "compensate_incumbent",
    policyDecision: "regressed",
    predecessorActionSha256: HASH_C,
    reason: "failed_promotion",
    reportCreatedAt: "2027-01-03T08:00:00.000Z",
    validThrough: "2027-01-10T08:00:00.000Z",
  }));
  assert.equal(compensation.action.predecessorActionSha256, HASH_C);
  const shadowCompensation = buildAdjustmentModelAction(modelAction({
    actionKind: "compensate_shadow",
    expectedInstalledReceiptSha256: HASH_F,
    fullMemberRootSha256: null,
    policyDecision: "pending",
    predecessorActionSha256: HASH_C,
    reason: "development_shadow_failure",
  }));
  assert.equal(shadowCompensation.action.expectedInstalledReceiptSha256, HASH_F);
  assert.throws(
    // reject relabelling compensation as a fresh action
    () => buildAdjustmentModelAction(modelAction({
      actionKind: "compensate_incumbent",
      policyDecision: "regressed",
      reason: "failed_promotion",
    })),
    /predecessor/u,
  );
});

test("rain control reference packages only pre-month state, artifact, selector and action", async () => {
  const reference = await rainControlReference();
  const built = buildAdjustmentRainControlReferenceAction(reference.action);
  const packaged = packageAdjustmentRainControlReference({
    action: reference.action,
    baselineSelectorBytes: null,
    controlStateBytes: reference.controlStateBytes,
    ordinalArtifactBytes: reference.ordinalArtifactBytes,
  });
  assert.equal(packaged.actionSha256, built.actionSha256);
  assert.deepEqual(packaged.removedPaths, []);
  assert.deepEqual(packaged.files.map((file) => file.path), [
    `config/forecast-adjustments/ballydidean/actions/sha256-${built.actionSha256}.json`,
    "config/forecast-adjustments/ballydidean/rain-maintenance-control-states/" +
      `sha256-${reference.action.controlStateSha256}.json`,
    "config/forecast-adjustments/ballydidean/rain-runtime-artifacts/" +
      `sha256-${reference.action.ordinalArtifactSha256}.json`,
    "config/forecast-adjustments/ballydidean-rain-control-reference.json",
  ].sort());
  const selectorBytes = packaged.files.find((file) =>
    file.path.endsWith("ballydidean-rain-control-reference.json")).bytes;
  assert.deepEqual(JSON.parse(selectorBytes), {
    actionSha256: built.actionSha256,
    contractVersion: "forecast-adjustment-rain-control-reference-registry/v1",
    controlStatePath: `rain-maintenance-control-states/` +
      `sha256-${reference.action.controlStateSha256}.json`,
    controlStateSha256: reference.action.controlStateSha256,
    dueMonth: reference.action.dueMonth,
    ordinalArtifactPath: `rain-runtime-artifacts/` +
      `sha256-${reference.action.ordinalArtifactSha256}.json`,
    ordinalArtifactSha256: reference.action.ordinalArtifactSha256,
    siteKey: "ballydidean",
  });

  const compensationAction = {
    ...reference.action,
    actionKind: "compensate_control_reference",
    expectedSourceCommit: "2".repeat(40),
    expectedSourceRelease: "2027.01.10-1",
    predecessorActionSha256: built.actionSha256,
    reason: "failed_control_reference",
  };
  const compensation = packageAdjustmentRainControlReference({
    action: compensationAction,
    baselineSelectorBytes: null,
    controlStateBytes: null,
    ordinalArtifactBytes: null,
  });
  assert.deepEqual(compensation.removedPaths, [
    "config/forecast-adjustments/ballydidean-rain-control-reference.json",
  ]);
  assert.equal(compensation.files.length, 1);
  assert.throws(
    // reject backdated reference publication outside the literal pre-month window
    () => buildAdjustmentRainControlReferenceAction({
      ...reference.action,
      createdAt: new Date(Date.parse(reference.action.validThrough) - 8 * 86_400_000).toISOString(),
    }),
    /chronology/u,
  );
});

test("rain control publisher prebuilds an immutable absent-baseline compensation", async () => {
  const root = await mkdtemp(join(tmpdir(), "adjustment-rain-control-release-test-"));
  const repository = join(root, "repository");
  const origin = join(root, "origin.git");

  try {
    await execFile("git", ["init", "--bare", origin]);
    await execFile("git", ["init", repository]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@localhost",
      "commit", "-m", "fixture",
    ]);
    await git(repository, ["remote", "add", "origin", origin]);
    const sourceCommit = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["push", "origin", "HEAD:refs/heads/main"]);
    const reference = await rainControlReference({ expectedSourceCommit: sourceCommit });
    const prepared = [];
    const compensatingPrepared = [];
    const pairs = [];
    const startedAt = new Date(Date.parse(reference.action.createdAt) + 60_000);
    const releaseDate = reference.action.createdAt.slice(0, 10).replaceAll("-", ".");
    const result = await publishAdjustmentRainControlReferenceReleasePair({
      buildCompensation: async (target) => ({
        action: {
          ...reference.action,
          actionKind: "compensate_control_reference",
          expectedSourceCommit: target.commitSha,
          expectedSourceRelease: target.releaseTag,
          predecessorActionSha256: target.actionSha256,
          reason: "failed_control_reference",
        },
        baselineSelectorBytes: null,
        controlStateBytes: null,
        ordinalArtifactBytes: null,
        releaseDate,
        releaseDueKey: `control-reference/rain/${reference.action.dueMonth}`,
        releaseRunId: "rain-control-reference-fixture",
        repositoryPath: repository,
        sourceCommit: target.commitSha,
      }),
      target: {
        action: reference.action,
        baselineSelectorBytes: null,
        controlStateBytes: reference.controlStateBytes,
        ordinalArtifactBytes: reference.ordinalArtifactBytes,
        releaseDate,
        releaseDueKey: `control-reference/rain/${reference.action.dueMonth}`,
        releaseRunId: "rain-control-reference-fixture",
        repositoryPath: repository,
        sourceCommit,
      },
    }, {
      awaitExactCheck: async () => undefined,
      clock: () => startedAt,
      prepareCompensatingRelease: async (mapping) => compensatingPrepared.push(mapping),
      prepareRelease: async (mapping) => prepared.push(mapping),
      recordReleasePair: async (mapping) => pairs.push(mapping),
      recordTagCollision: async () => {
        throw new Error("release tag collision was not expected");
      },
    });
    assert.equal(prepared.length, 1);
    assert.equal(compensatingPrepared.length, 1);
    assert.equal(pairs.length, 1);
    assert.equal(compensatingPrepared[0].predecessorActionSha256, result.target.actionSha256);
    assert.equal(await git(repository, [
      "show",
      `${result.target.commitSha}:config/forecast-adjustments/` +
        "ballydidean-rain-control-reference.json",
    ]).then((bytes) => JSON.parse(bytes).actionSha256), result.target.actionSha256);
    await assert.rejects(
      execFile("git", [
        "show",
        `${result.compensation.commitSha}:config/forecast-adjustments/` +
          "ballydidean-rain-control-reference.json",
      ], { cwd: repository }),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("family package requires real parity and the closed wind mask", () => {
  const temperature = familyFiles();
  const packaged = packageAdjustmentModelFamily({
    action: temperature.action,
    familyFiles: temperature.files,
    parity: parity(),
    shadowRegistration: null,
  });
  assert.equal(packaged.files.length, 4);
  assert.ok(packaged.totalBytes < 8 * 1_024 * 1_024);
  const parityBytes = packaged.files.find((file) =>
    // select the exact immutable parity receipt for safe reuse
    file.path.includes("/model-parity/temperature/"),
  ).bytes;
  const reused = packageAdjustmentModelFamily({
    action: temperature.action,
    familyFiles: temperature.files,
    parity: parityBytes,
    shadowRegistration: null,
  });
  assert.equal(reused.paritySha256, packaged.paritySha256);
  assert.throws(
    // refuse hash-only parity when actual output bytes disagree
    () => packageAdjustmentModelFamily({
      action: temperature.action,
      familyFiles: temperature.files,
      parity: { ...parity(), syntheticPackagedOutput: Buffer.from("different") },
      shadowRegistration: null,
    }),
    (error) => error.reason === "synthetic_parity_failed",
  );
  const wind = familyFiles("wind");
  const windPackage = packageAdjustmentModelFamily({
    action: wind.action,
    familyFiles: wind.files,
    parity: parity(),
    shadowRegistration: null,
  });
  assert.equal(windPackage.files.length, 4);
});

test("rain packaging accepts only the validated portable compiled recipe", async () => {
  const source = await readFile(
    new URL("../../packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts", import.meta.url),
    "utf8",
  );
  const retained = JSON.parse(JSON.parse(
    source.match(/RAIN_HURDLE_WIND_ARTIFACT_JSON = (.*) as const;\n$/su)[1],
  ));
  const candidateBytes = canonicalJsonBytes({
    artifact: {
      calibration: {
        categories: Object.fromEntries(retained.categoryScales.map(
          // restore only public serving calibration scales
          (scale, index) => [String(index + 1), { scale }],
        )),
        contractVersion: "rain-hurdle-calibration/v1",
        rules: retained.rules,
      },
      contractVersion: "rain-maintenance-artifact/v2",
      featureNames: retained.featureNames,
      heads: retained.heads,
      modelMonth: retained.modelMonth,
      projectionId: "publisher-test",
    },
    confirmationOpened: false,
    contractVersion: "rain-maintenance-fit/v2",
    reason: "development_gate_passer",
    state: "development_candidate",
  });
  const rain = buildPortableRainModelPackage(candidateBytes);
  const rainAction = modelAction({
    candidateSha256: rain.candidateSha256,
    family: "rain",
  });
  const rainRegistry = buildAdjustmentMaintenanceServingRegistry({
    action: rainAction,
    artifactSha256: rain.artifactSha256,
  });
  const packaged = packageAdjustmentModelFamily({
    action: rainAction,
    familyFiles: rain.familyFiles.map((file) =>
      file.path === rainRegistry.path ? rainRegistry : file),
    parity: parity(),
    shadowRegistration: null,
  });
  assert.equal(packaged.files.length, 6);
});

test("shadow packages add inactive members without changing serving registries", async () => {
  const temperature = familyFiles();
  const action = modelAction({
    actionKind: "shadow",
    candidateSha256: temperature.candidateSha256,
    fullMemberRootSha256: null,
    policyDecision: "pending",
    reason: "development_candidate",
  });
  const registration = shadowRegistration({
    artifactSha256: temperature.bundleSha256,
    candidateSha256: temperature.candidateSha256,
    family: "temperature",
  });
  const packaged = packageAdjustmentModelFamily({
    action,
    familyFiles: [temperature.files[0]],
    parity: parity(),
    shadowRegistration: registration,
  });
  assert.deepEqual(packaged.files.map((file) => file.path), [
    `config/forecast-adjustments/ballydidean/actions/sha256-${packaged.actionSha256}.json`,
    `config/forecast-adjustments/ballydidean/model-parity/temperature/sha256-${temperature.candidateSha256}.json`,
    `config/forecast-adjustments/ballydidean/shadow-catalog/temperature/sha256-${temperature.candidateSha256}.json`,
    `config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-${temperature.bundleSha256}.json`,
  ].sort());
  assert.equal(
    packaged.files.some((file) => file.path ===
      "config/forecast-adjustments/ballydidean-temperature-canary.json"),
    false,
  );

  const rollingRegistration = shadowRegistration({
    artifactSha256: temperature.bundleSha256,
    candidateSha256: temperature.candidateSha256,
    family: "temperature",
  }, "v3");
  const rollingPackage = packageAdjustmentModelFamily({
    action,
    familyFiles: [temperature.files[0]],
    parity: parity(),
    shadowRegistration: rollingRegistration,
  });
  const rollingProjection = JSON.parse(rollingPackage.files.find((file) =>
    file.path.includes("/shadow-catalog/temperature/")).bytes);
  assert.deepEqual(rollingProjection.registration, rollingRegistration);

  const source = await readFile(
    new URL("../../packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts", import.meta.url),
    "utf8",
  );
  const retained = JSON.parse(JSON.parse(
    source.match(/RAIN_HURDLE_WIND_ARTIFACT_JSON = (.*) as const;\n$/su)[1],
  ));
  const candidateBytes = canonicalJsonBytes({
    artifact: {
      calibration: {
        categories: Object.fromEntries(retained.categoryScales.map(
          // restore serving calibration scales for the fit candidate
          (scale, index) => [String(index + 1), { scale }],
        )),
        contractVersion: "rain-hurdle-calibration/v1",
        rules: retained.rules,
      },
      contractVersion: "rain-maintenance-artifact/v2",
      featureNames: retained.featureNames,
      heads: retained.heads,
      modelMonth: retained.modelMonth,
      projectionId: "publisher-shadow-test",
    },
    confirmationOpened: false,
    contractVersion: "rain-maintenance-fit/v2",
    reason: "development_gate_passer",
    state: "development_candidate",
  });
  const rain = buildPortableRainModelPackage(candidateBytes);
  const rainAction = modelAction({
    actionKind: "shadow",
    candidateSha256: rain.candidateSha256,
    family: "rain",
    fullMemberRootSha256: null,
    policyDecision: "pending",
    reason: "development_candidate",
  });
  const rainPackage = packageAdjustmentModelFamily({
    action: rainAction,
    familyFiles: rain.shadowFamilyFiles,
    parity: parity(),
    shadowRegistration: shadowRegistration({
      artifactSha256: rain.artifactSha256,
      candidateSha256: rain.candidateSha256,
      family: "rain",
    }),
  });
  assert.equal(rainPackage.files.length, 5);
  assert.equal(
    rainPackage.files.some((file) => file.path.endsWith("ballydidean-rain-runtime.json") ||
      file.path.endsWith("rain-hurdle-wind-artifact.ts")),
    false,
  );
  const projectionFile = rainPackage.files.find((file) =>
    file.path.includes("/shadow-catalog/rain/"));
  assert.equal(JSON.parse(projectionFile.bytes).bundleSha256, rain.artifactSha256);

  const recurring = temperatureMaintenancePackage();
  const recurringPackage = packageAdjustmentModelFamily({
    action: modelAction({
      actionKind: "shadow",
      candidateSha256: recurring.candidateSha256,
      fullMemberRootSha256: null,
      policyDecision: "pending",
      reason: "development_candidate",
    }),
    familyFiles: [recurring.file],
    parity: parity(),
    shadowRegistration: shadowRegistration({
      artifactSha256: recurring.bundleSha256,
      candidateSha256: recurring.candidateSha256,
      family: "temperature",
    }),
  });
  const recurringProjection = JSON.parse(recurringPackage.files.find((file) =>
    file.path.includes("/shadow-catalog/temperature/"))?.bytes);
  assert.equal(recurringProjection.candidateSha256, recurring.candidateSha256);
  assert.equal(recurringProjection.artifactSha256, recurring.bundleSha256);
});

test("raw packages contain only the exact family fallback registry and action", () => {
  for (const family of ["temperature", "wind", "rain"]) {
    const packaged = packageAdjustmentModelFamily({
      action: modelAction({
        actionKind: "raw",
        candidateGraphSha256: null,
        candidateSha256: null,
        family,
        policyDecision: "regressed",
        reason: "policy_raw",
      }),
      familyFiles: rawRegistry(family),
      parity: null,
      shadowRegistration: null,
    });
    assert.equal(packaged.files.length, 2);
    assert.equal(packaged.paritySha256, null);
    assert.equal(packaged.files.some((file) => file.path.includes("model-parity")), false);
  }
});

test("shadow compensation adds only immutable action metadata", () => {
  const packaged = packageAdjustmentModelFamily({
    action: modelAction({
      actionKind: "compensate_shadow",
      expectedInstalledReceiptSha256: HASH_F,
      fullMemberRootSha256: null,
      policyDecision: "pending",
      predecessorActionSha256: HASH_C,
      reason: "development_shadow_failure",
    }),
    familyFiles: [],
    parity: null,
    shadowRegistration: null,
  });
  assert.equal(packaged.files.length, 1);
  assert.match(packaged.files[0].path, /\/actions\/sha256-[a-f0-9]{64}\.json$/u);
  assert.equal(packaged.paritySha256, null);
  assert.throws(
    // prohibit serving or candidate file mutation during shadow compensation
    () => packageAdjustmentModelFamily({
      action: modelAction({
        actionKind: "compensate_shadow",
        expectedInstalledReceiptSha256: HASH_F,
        fullMemberRootSha256: null,
        policyDecision: "pending",
        predecessorActionSha256: HASH_C,
        reason: "development_shadow_failure",
      }),
      familyFiles: familyFiles().files,
      parity: null,
      shadowRegistration: null,
    }),
    (error) => error.reason === "family_shadow_compensation_files_invalid",
  );
});

test("publisher records identity before branch and immutable tags", async () => {
  const root = await mkdtemp(join(tmpdir(), "adjustment-model-release-test-"));
  const repository = join(root, "repository");
  const origin = join(root, "origin.git");

  try {
    await execFile("git", ["init", "--bare", origin]);
    await execFile("git", ["init", repository]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, [
      "-c", "user.name=Fixture",
      "-c", "user.email=fixture@localhost",
      "commit", "-m", "fixture",
    ]);
    await git(repository, ["remote", "add", "origin", origin]);
    const sourceCommit = await git(repository, ["rev-parse", "HEAD"]);
    await git(repository, ["push", "origin", `HEAD:refs/heads/main`]);
    const temperature = familyFiles("temperature", { expectedSourceCommit: sourceCommit });
    const prepared = [];
    const compensatingPrepared = [];
    const environmentVerifications = [];
    const releasePairs = [];
    let checked = false;
    const action = temperature.action;
    const result = await publishAdjustmentModelRelease({
      action,
      familyFiles: temperature.files,
      parity: parity(),
      releaseDate: "2027.01.10",
      releaseDueKey: `release/temperature/${HASH_A}`,
      releaseRunId: "release-temperature-fixture",
      repositoryPath: repository,
      shadowRegistration: null,
      sourceCommit,
    }, {
      // require mapping before the first remote branch exists
      prepareRelease: async (mapping) => {
        // inspect pre-push state only on the first publication
        if (prepared.length === 0) {
          assert.equal(await git(repository, ["ls-remote", "--refs", "origin", `refs/heads/${mapping.branch}`]), "");
        } else {
          assert.deepEqual(mapping, prepared[0]);
        }
        prepared.push(mapping);
      },
      // verify the exact pushed branch commit before tags
      awaitExactCheck: async ({ branch, commitSha }) => {
        assert.equal(
          await git(repository, ["ls-remote", "--refs", "origin", `refs/heads/${branch}`]),
          `${commitSha}\trefs/heads/${branch}`,
        );
        checked = true;
      },
      clock: () => new Date("2027-01-10T08:01:00.000Z"),
      recordTagCollision: async () => {
        throw new Error("release tag collision was not expected");
      },
      verifyEnvironment: async (input) => {
        environmentVerifications.push(input);
      },
    });
    assert.equal(prepared.length, 1);
    assert.equal(checked, true);
    assert.deepEqual(environmentVerifications, [{
      repositoryPath: repository,
      sourceCommit,
      sourceRelease: action.expectedSourceRelease,
    }]);
    assert.equal(prepared[0].commitSha, result.commitSha);
    assert.equal(
      await git(repository, ["ls-remote", "--refs", "origin", `refs/tags/${result.actionTag}`]),
      `${result.commitSha}\trefs/tags/${result.actionTag}`,
    );
    assert.equal(
      await git(repository, ["ls-remote", "--refs", "origin", `refs/tags/${result.releaseTag}`]),
      `${result.commitSha}\trefs/tags/${result.releaseTag}`,
    );
    const committedAction = await git(repository, [
      "show",
      `${result.commitSha}:config/forecast-adjustments/ballydidean/actions/sha256-${result.actionSha256}.json`,
    ]);
    assert.equal(JSON.parse(committedAction).expectedSourceCommit, sourceCommit);
    const replay = await publishAdjustmentModelRelease({
      action,
      familyFiles: temperature.files,
      parity: parity(),
      releaseDate: "2027.01.10",
      releaseDueKey: `release/temperature/${HASH_A}`,
      releaseRunId: "release-temperature-fixture",
      repositoryPath: repository,
      shadowRegistration: null,
      sourceCommit,
    }, {
      prepareRelease: async (mapping) => {
        assert.deepEqual(mapping, prepared[0]);
      },
      awaitExactCheck: async () => undefined,
      clock: () => new Date("2027-01-10T08:01:00.000Z"),
      recordTagCollision: async () => {
        throw new Error("release tag collision was not expected");
      },
    });
    assert.deepEqual(replay, result);

    const paired = await publishAdjustmentModelReleasePair({
      // create compensation only after the immutable target commit is known
      buildCompensation: async (target) => ({
        action: modelAction({
          actionKind: "compensate_raw",
          candidateGraphSha256: null,
          candidateSha256: null,
          expectedSourceCommit: target.commitSha,
          expectedSourceRelease: target.releaseTag,
          policyDecision: "regressed",
          predecessorActionSha256: target.actionSha256,
          reason: "invalid_incumbent",
        }),
        familyFiles: rawRegistry("temperature"),
        parity: null,
        releaseDate: "2027.01.10",
        releaseDueKey: `release/temperature/${HASH_A}`,
        releaseRunId: "release-temperature-fixture",
        repositoryPath: repository,
        shadowRegistration: null,
        sourceCommit: target.commitSha,
      }),
      target: {
        action,
        familyFiles: temperature.files,
        parity: parity(),
        releaseDate: "2027.01.10",
        releaseDueKey: `release/temperature/${HASH_A}`,
        releaseRunId: "release-temperature-fixture",
        repositoryPath: repository,
        shadowRegistration: null,
        sourceCommit,
      },
    }, {
      awaitExactCheck: async () => undefined,
      clock: () => new Date("2027-01-10T08:01:00.000Z"),
      prepareCompensatingRelease: async (mapping) => {
        assert.equal(mapping.expectedSourceCommit, result.commitSha);
        assert.equal(mapping.predecessorActionSha256, result.actionSha256);
        compensatingPrepared.push(mapping);
      },
      prepareRelease: async (mapping) => {
        assert.deepEqual(mapping, prepared[0]);
      },
      recordReleasePair: async (mapping) => {
        releasePairs.push(mapping);
      },
      recordTagCollision: async () => {
        throw new Error("release tag collision was not expected");
      },
    });
    assert.equal(compensatingPrepared.length, 1);
    assert.equal(releasePairs.length, 1);
    assert.equal(paired.target.commitSha, result.commitSha);
    assert.equal(paired.compensation.commitSha, releasePairs[0].compensationCommitSha);
    assert.equal(releasePairs[0].targetActionSha256, result.actionSha256);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
