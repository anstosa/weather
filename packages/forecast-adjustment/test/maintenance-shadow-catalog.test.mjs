import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  canonicalJsonBytes,
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  loadInstalledMaintenanceShadowCandidate,
  RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
  verifyInstalledRainMaintenanceControlReference,
  verifyMaintenanceShadowCatalogProjection,
} from "../dist/index.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
} from "../dist/rain-hurdle-wind-artifact.js";

// hash one exact byte sequence
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// build one correctly self-addressed registration
function registration() {
  const value = {
    artifactSha256: "1".repeat(64),
    candidateSha256: "2".repeat(64),
    cohortSha256: "3".repeat(64),
    family: "temperature",
    intervalEndAt: "2026-11-01T00:00:00.000Z",
    intervalStartAt: "2026-10-01T00:00:00.000Z",
    policySha256: "4".repeat(64),
    registrationSha256: "",
    reservedKeySha256: "5".repeat(64),
    siteKey: "ballydidean",
    sourceSha256: "6".repeat(64),
    targetCutoffAt: "2026-11-08T00:00:00.000Z",
    terminalAt: "2026-11-09T00:00:00.000Z",
  };
  value.registrationSha256 = sha256(Buffer.from([
    "adjustment-shadow-registration/v2", value.siteKey, value.family,
    value.candidateSha256, value.artifactSha256, value.policySha256,
    value.cohortSha256, value.reservedKeySha256, value.sourceSha256,
    value.intervalStartAt, value.intervalEndAt, value.targetCutoffAt, value.terminalAt,
  ].join("\n")));
  return value;
}

// build one correctly self-addressed rolling registration
function rollingRegistration() {
  const value = {
    ...registration(),
    epochWitnessSha256: "7".repeat(64),
    predecessorRegistrationSha256: null,
    scheduleContractSha256: "8".repeat(64),
  };
  value.registrationSha256 = sha256(Buffer.from(`${[
    "adjustment-shadow-registration/v3", value.siteKey, value.family,
    value.candidateSha256, value.artifactSha256, value.policySha256,
    value.cohortSha256, value.reservedKeySha256, value.sourceSha256,
    value.epochWitnessSha256, value.scheduleContractSha256, "none",
    value.intervalStartAt, value.intervalEndAt, value.targetCutoffAt, value.terminalAt,
  ].join("\n")}\n`));
  return value;
}

// construct one closed installed receipt around the registration
function receipt(value) {
  return {
    actionSha256: "7".repeat(64),
    bundleSha256: value.artifactSha256,
    candidateGraphSha256: "8".repeat(64),
    candidateSha256: value.candidateSha256,
    contractVersion: "adjustment-installed-candidate-receipt/v1",
    controlPlaneSha256: "9".repeat(64),
    deployedCommit: "a".repeat(40),
    deployedImageDigest: `sha256:${"b".repeat(64)}`,
    deployedRelease: "2026.10.08-1",
    deployedSettingsSha256: "c".repeat(64),
    fencingToken: "1",
    installedAt: "2026-10-08T01:00:00.000Z",
    registrationSha256: value.registrationSha256,
    sourceSha256: value.sourceSha256,
  };
}

// build exact projection and parity bytes for one installed slot
function documents(value, installed) {
  const parity = {
    candidateSha256: value.candidateSha256,
    contractVersion: "forecast-adjustment-model-parity/v1",
    family: value.family,
    retainedInputSha256: "d".repeat(64),
    retainedNativeOutputSha256: "e".repeat(64),
    retainedPackagedOutputSha256: "e".repeat(64),
    syntheticInputSha256: "f".repeat(64),
    syntheticNativeOutputSha256: "0".repeat(64),
    syntheticPackagedOutputSha256: "0".repeat(64),
  };
  const parityBytes = Buffer.from(canonicalJsonBytes(parity));
  const projection = {
    actionSha256: installed.actionSha256,
    artifactSha256: value.artifactSha256,
    bundleSha256: value.artifactSha256,
    candidateGraphSha256: installed.candidateGraphSha256,
    candidateSha256: value.candidateSha256,
    contractVersion: "forecast-adjustment-shadow-catalog-projection/v1",
    family: value.family,
    paritySha256: sha256(parityBytes),
    registration: value,
    siteKey: "ballydidean",
  };
  return { parity, parityBytes, projection, projectionBytes: Buffer.from(canonicalJsonBytes(projection)) };
}

// accept only a fully cross-bound source-image projection pair
test("shadow catalog projection binds action artifact registration and parity", () => {
  const value = registration();
  const installed = receipt(value);
  const docs = documents(value, installed);
  assert.doesNotThrow(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: docs.parityBytes,
    projectionBytes: docs.projectionBytes,
    receipt: installed,
    registration: value,
  }));
});

test("shadow catalog projection accepts only the closed rolling registration", () => {
  const value = rollingRegistration();
  const installed = receipt(value);
  const docs = documents(value, installed);
  assert.doesNotThrow(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: docs.parityBytes,
    projectionBytes: docs.projectionBytes,
    receipt: installed,
    registration: value,
  }));
  const partial = { ...value };
  delete partial.scheduleContractSha256;
  const partialDocs = documents(partial, receipt(partial));
  assert.throws(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: partialDocs.parityBytes,
    projectionBytes: partialDocs.projectionBytes,
    receipt: receipt(partial),
    registration: partial,
  }), /fields differ/u);
});

// reject candidate substitutions and parity claims without native equality
test("shadow catalog projection rejects cross-candidate and parity substitutions", () => {
  const value = registration();
  const installed = receipt(value);
  const docs = documents(value, installed);
  const substitutedProjection = Buffer.from(canonicalJsonBytes({
    ...docs.projection,
    candidateSha256: "a".repeat(64),
  }));
  assert.throws(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: docs.parityBytes,
    projectionBytes: substitutedProjection,
    receipt: installed,
    registration: value,
  }), /projection differs/u);
  const unequalParityBytes = Buffer.from(canonicalJsonBytes({
    ...docs.parity,
    retainedPackagedOutputSha256: "1".repeat(64),
  }));
  const reboundProjectionBytes = Buffer.from(canonicalJsonBytes({
    ...docs.projection,
    paritySha256: sha256(unequalParityBytes),
  }));
  assert.throws(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: unequalParityBytes,
    projectionBytes: reboundProjectionBytes,
    receipt: installed,
    registration: value,
  }), /parity differs/u);
});

test("shadow catalog accepts only pending null-member v2 receipts", () => {
  const value = registration();
  const v1 = receipt(value);
  const installed = {
    ...v1,
    actionKind: "shadow",
    contractVersion: "adjustment-installed-candidate-receipt/v2",
    fullMemberRootSha256: null,
    lifecycleHeadSha256: "1".repeat(64),
    policyDecision: "pending",
    policyReportSha256: "2".repeat(64),
  };
  const docs = documents(value, installed);
  assert.doesNotThrow(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: docs.parityBytes,
    projectionBytes: docs.projectionBytes,
    receipt: installed,
    registration: value,
  }));
  assert.throws(() => verifyMaintenanceShadowCatalogProjection({
    family: "temperature",
    parityBytes: docs.parityBytes,
    projectionBytes: docs.projectionBytes,
    receipt: { ...installed, actionKind: "promote", fullMemberRootSha256: "3".repeat(64),
      policyDecision: "qualified" },
    registration: value,
  }), /authority differs/u);
});

test("rain control reference binds selector action state and ordinal artifact", () => {
  const { nativeModelSha256: _native, provenanceSha256: _provenance, ...baseArtifact } =
    JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON);
  const ordinalArtifactBytes = Buffer.from(canonicalJsonBytes({
    ...baseArtifact,
    modelMonth: "2026-11",
  }));
  const ordinalArtifactSha256 = sha256(ordinalArtifactBytes);
  const sourceMemberRootSha256 = "1".repeat(64);
  const sourceReceiptRootSha256 = "2".repeat(64);
  const state = createRainMaintenanceControlState({
    calibrationEndAt: "2026-10-25T00:00:00.000Z",
    calibrationStartAt: "2026-07-27T00:00:00.000Z",
    contractVersion: "rain-maintenance-control-state/v1",
    epochWitnessSha256: "3".repeat(64),
    generatedAt: "2026-10-26T00:00:00.000Z",
    legacyCalibrationStartAt: "2026-09-10T00:00:00.000Z",
    legacyRawScale: 1.1,
    modelMonth: "2026-11",
    ordinalArtifactSha256,
    recentFallbackReason: "recent_calibration",
    recentRawScale: 1.2,
    recentSupported: true,
    recipeSha256: RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
    sameWindowRawScale: 1.15,
    scheduleContractSha256: "4".repeat(64),
    sourceMemberRootSha256,
    sourceReceiptRootSha256,
    support: {
      calibrationDates: 90, calibrationHours: 2_000, calibrationRows: 2_000,
      calibrationWetDates: 20, calibrationWetHours: 200,
      effectiveDates64: "404e000000000000", effectiveWetDates64: "4008000000000000",
      legacyCalibrationRows: 500, legacyTrainingRows: 2_000, legacyTrainingWetRows: 200,
      trainingDates: 200, trainingHours: 4_000, trainingRows: 4_000,
      trainingWetDates: 30, trainingWetHours: 300,
    },
    trainingMaximumValidAt: "2026-07-19T23:00:00.000Z",
  });
  const controlStateBytes = encodeRainMaintenanceControlState(state);
  const controlStateSha256 = sha256(controlStateBytes);
  const action = {
    actionKind: "control_reference",
    contractVersion: "forecast-adjustment-rain-control-reference-action/v1",
    createdAt: state.generatedAt,
    dueMonth: state.modelMonth,
    expectedCatalogReceiptSha256: null,
    expectedSettingsSha256: "5".repeat(64),
    expectedSourceCommit: "a".repeat(40),
    expectedSourceRelease: "2026.10.25-1",
    family: "rain",
    fencingToken: "1",
    graphManifestSha256: "6".repeat(64),
    ordinalArtifactSha256,
    predecessorActionSha256: null,
    reason: "premonth_reference",
    controlStateSha256,
    sourceMemberRootSha256,
    sourceReceiptRootSha256,
    validThrough: "2026-11-01T00:00:00.000Z",
  };
  const actionBytes = Buffer.from(canonicalJsonBytes(action));
  const actionSha256 = sha256(actionBytes);
  const receipt = {
    actionKind: "control_reference",
    actionSha256,
    contractVersion: "adjustment-installed-rain-control-reference-receipt/v1",
    controlPlaneSha256: "7".repeat(64),
    controlStateSha256,
    custodyAnchorSha256: "8".repeat(64),
    deployedCommit: "b".repeat(40),
    deployedImageDigest: `sha256:${"9".repeat(64)}`,
    deployedRelease: "2026.10.26-1",
    deployedSettingsSha256: action.expectedSettingsSha256,
    dueMonth: action.dueMonth,
    fencingToken: action.fencingToken,
    graphManifestSha256: action.graphManifestSha256,
    installedAt: "2026-10-26T01:00:00.000Z",
    ordinalArtifactSha256,
    sourceMemberRootSha256,
    sourceReceiptRootSha256,
  };
  const selector = {
    actionSha256,
    contractVersion: "forecast-adjustment-rain-control-reference-registry/v1",
    controlStatePath: `rain-maintenance-control-states/sha256-${controlStateSha256}.json`,
    controlStateSha256,
    dueMonth: state.modelMonth,
    ordinalArtifactPath: `rain-runtime-artifacts/sha256-${ordinalArtifactSha256}.json`,
    ordinalArtifactSha256,
    siteKey: "ballydidean",
  };
  const input = {
    actionBytes,
    controlStateBytes,
    ordinalArtifactBytes,
    receipt,
    selectorBytes: Buffer.from(canonicalJsonBytes(selector)),
  };
  const loaded = verifyInstalledRainMaintenanceControlReference(input);
  assert.equal(loaded.controlStateSha256, controlStateSha256);
  assert.equal(loaded.ordinalArtifactSha256, ordinalArtifactSha256);
  assert.throws(() => verifyInstalledRainMaintenanceControlReference({
    ...input,
    selectorBytes: Buffer.from(canonicalJsonBytes({ ...selector, dueMonth: "2026-12" })),
  }), /selector differs/u);
});

// preserve the production loader's fixed root-owned mount boundary
test("installed catalog loader rejects caller-selected compatibility paths", async () => {
  await assert.rejects(
    loadInstalledMaintenanceShadowCandidate({
      catalogPath: "/tmp/adjustment-candidate-catalog.json",
      family: "rain",
    }),
    /catalog path is invalid/u,
  );
});
