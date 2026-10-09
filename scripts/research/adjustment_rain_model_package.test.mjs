import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildPortableRainModelPackage,
  evaluateNativeRainCandidateArtifact,
  evaluatePortableRainArtifact,
  validatePortableRainModelPackageFiles,
  validatePortableRainShadowFiles,
} from "./adjustment_rain_model_package.mjs";
import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";
import {
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
} from "./adjustment-maintenance-runtime/forecast/rain-maintenance-controls.js";
import {
  encodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";

// read the retained generated runtime without executing typescript source
async function retainedRuntimeArtifact() {
  const source = await readFile(
    new URL("../../packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts", import.meta.url),
    "utf8",
  );
  const match = source.match(/RAIN_HURDLE_WIND_ARTIFACT_JSON = (.*) as const;\n$/su);

  // require the one generated string literal assignment
  if (match === null) {
    throw new TypeError("retained rain artifact source is invalid");
  }
  return JSON.parse(JSON.parse(match[1]));
}

// construct a selected sanitized candidate from the retained public artifact
async function retainedCandidateBytes({
  contractVersion = "rain-maintenance-fit/v2",
  projectionId = "retained-native-parity",
} = {}) {
  const runtime = await retainedRuntimeArtifact();
  const categories = Object.fromEntries(runtime.categoryScales.map(
    // restore only the serving scale projection
    (scale, index) => [String(index + 1), { scale }],
  ));
  return canonicalJsonBytes({
    artifact: {
      calibration: {
        categories,
        contractVersion: "rain-hurdle-calibration/v1",
        rules: runtime.rules,
      },
      contractVersion: "rain-maintenance-artifact/v2",
      featureNames: runtime.featureNames,
      heads: runtime.heads,
      modelMonth: runtime.modelMonth,
      projectionId,
    },
    confirmationOpened: false,
    contractVersion,
    reason: "development_gate_passer",
    state: "development_candidate",
  });
}

// build one fully supported earlier-only state around a portable ordinal artifact
function controlPackage(runtimeArtifact) {
  const ordinalArtifact = structuredClone(runtimeArtifact);
  ordinalArtifact.categoryScales[0] = ordinalArtifact.categoryScales[0] === 1 ? 1.1 : 1;
  const ordinalArtifactBytes = canonicalJsonBytes(ordinalArtifact);
  const monthStart = Date.parse(`${runtimeArtifact.modelMonth}-01T00:00:00.000Z`);
  const calibrationEnd = monthStart - 7 * 86_400_000;
  const calibrationStart = calibrationEnd - 90 * 86_400_000;
  const state = createRainMaintenanceControlState({
    calibrationEndAt: new Date(calibrationEnd).toISOString(),
    calibrationStartAt: new Date(calibrationStart).toISOString(),
    contractVersion: "rain-maintenance-control-state/v1",
    epochWitnessSha256: "1".repeat(64),
    generatedAt: new Date(calibrationEnd + 3_600_000).toISOString(),
    legacyCalibrationStartAt: new Date(calibrationEnd - 45 * 86_400_000).toISOString(),
    legacyRawScale: 1,
    modelMonth: runtimeArtifact.modelMonth,
    ordinalArtifactSha256: adjustmentSha256(ordinalArtifactBytes),
    recentFallbackReason: "recent_calibration",
    recentRawScale: 1,
    recentSupported: true,
    recipeSha256: RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
    sameWindowRawScale: 1,
    scheduleContractSha256: "2".repeat(64),
    sourceMemberRootSha256: "3".repeat(64),
    sourceReceiptRootSha256: "4".repeat(64),
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
  return {
    controlStateBytes: encodeRainMaintenanceControlState(state),
    ordinalArtifactBytes,
  };
}

test("portable rain recipe reproduces independent retained native predictions", async () => {
  const candidateBytes = await retainedCandidateBytes();
  const packaged = buildPortableRainModelPackage(candidateBytes);
  const parity = JSON.parse(await readFile(
    new URL(
      "../../packages/forecast-adjustment/test/rain-hurdle-wind-parity.json",
      import.meta.url,
    ),
    "utf8",
  ));
  assert.equal(parity.contractVersion, "rain-hurdle-wind-native-parity/v1");
  assert.equal(packaged.candidateSha256, adjustmentSha256(candidateBytes));

  // compare every independently retained native final projection
  for (let index = 0; index < parity.features.length; index += 1) {
    const actual = evaluatePortableRainArtifact(
      packaged.runtimeArtifact,
      parity.features[index],
    );
    assert.ok(
      Math.abs(actual.correctedPrecipitationMm - parity.nativeFinal[index]) < 2e-6,
      `native parity row ${index}`,
    );
  }
});

// v3 packages retain and execute the selected screened projection
test("portable rain v3 package applies distinct selected arms and event guards", async () => {
  const winterAt = "2027-01-15T12:00:00.000Z";
  const springAt = "2027-04-15T12:00:00.000Z";
  const parity = JSON.parse(await readFile(
    new URL(
      "../../packages/forecast-adjustment/test/rain-hurdle-wind-parity.json",
      import.meta.url,
    ),
    "utf8",
  ));
  const features = [...parity.features[4]];
  const r0Bytes = await retainedCandidateBytes({
    contractVersion: "rain-maintenance-fit/v3",
    projectionId: "R0_exact_refit",
  });
  const r1Bytes = await retainedCandidateBytes({
    contractVersion: "rain-maintenance-fit/v3",
    projectionId: "R1_winter_scale_0_90",
  });
  const r3Bytes = await retainedCandidateBytes({
    contractVersion: "rain-maintenance-fit/v3",
    projectionId: "R3_spring_wet_logit_plus_0_20",
  });
  const r5Bytes = await retainedCandidateBytes({
    contractVersion: "rain-maintenance-fit/v3",
    projectionId: "R5_nested_cumulative_min",
  });
  const r0 = buildPortableRainModelPackage(r0Bytes);
  const r1 = buildPortableRainModelPackage(r1Bytes);
  const r3 = buildPortableRainModelPackage(r3Bytes);
  const r5 = buildPortableRainModelPackage(r5Bytes);
  assert.equal(r0.runtimeArtifact.contractVersion, "rain-hurdle-wind-runtime/v2");
  assert.equal(r1.runtimeArtifact.projectionId, "R1_winter_scale_0_90");
  assert.notEqual(r0.artifactSha256, r1.artifactSha256);
  const exact = evaluatePortableRainArtifact(r0.runtimeArtifact, features, winterAt);
  const winter = evaluatePortableRainArtifact(r1.runtimeArtifact, features, winterAt);
  assert.equal(winter.correctedPrecipitationMm,
    exact.correctedPrecipitationMm * 0.90);
  const springBase = evaluatePortableRainArtifact(r0.runtimeArtifact, features, springAt);
  const springWet = evaluatePortableRainArtifact(r3.runtimeArtifact, features, springAt);
  assert.ok(springWet.occurrenceProbabilityAtLeast0_1 >
    springBase.occurrenceProbabilityAtLeast0_1);
  const nested = evaluatePortableRainArtifact(r5.runtimeArtifact, features, springAt);
  assert.ok(nested.occurrenceProbabilityAtLeast1_0 <=
    nested.occurrenceProbabilityAtLeast0_1);
  assert.ok(nested.occurrenceProbabilityAtLeast2_5 <=
    nested.occurrenceProbabilityAtLeast1_0);

  // preserve exact raw heavy amounts and raw wet calls in both native and package paths
  for (const raw of [50, 0.5]) {
    const guarded = [...features];
    guarded[5] = raw;
    const native = evaluateNativeRainCandidateArtifact(r1Bytes, guarded, winterAt);
    const portable = evaluatePortableRainArtifact(r1.runtimeArtifact, guarded, winterAt);
    assert.deepEqual(portable, native);
    assert.equal(portable.correctedPrecipitationMm, raw >= 1 ? raw :
      Math.max(0.1, portable.correctedPrecipitationMm));
  }
});

test("portable rain package closes artifact, registry, receipt and generated source", async () => {
  const candidateBytes = await retainedCandidateBytes();
  const packaged = buildPortableRainModelPackage(candidateBytes);
  const validated = validatePortableRainModelPackageFiles(
    packaged.familyFiles,
    packaged.candidateSha256,
  );
  assert.equal(validated.receipt.artifactSha256, packaged.artifactSha256);
  assert.equal(validated.artifact.modelMonth, packaged.runtimeArtifact.modelMonth);
  assert.throws(
    // reject generated source substitution under a retained receipt
    () => validatePortableRainModelPackageFiles(
      packaged.familyFiles.map((file) => file.path.endsWith("artifact.ts")
        ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from("// changed\n")]) }
        : file),
      packaged.candidateSha256,
    ),
    (error) => error.reason === "rain_package_member_invalid",
  );
});

test("portable rain v2 package binds immutable control state and ordinal runtime", async () => {
  const candidateBytes = await retainedCandidateBytes();
  const legacy = buildPortableRainModelPackage(candidateBytes);
  const controls = controlPackage(legacy.runtimeArtifact);
  const packaged = buildPortableRainModelPackage(candidateBytes, controls);
  assert.equal(packaged.receipt.contractVersion, "forecast-adjustment-rain-model-package/v2");
  assert.equal(packaged.controlStateSha256, adjustmentSha256(controls.controlStateBytes));
  assert.equal(packaged.ordinalArtifactSha256, adjustmentSha256(controls.ordinalArtifactBytes));
  assert.ok(packaged.controlStateBytes.equals(controls.controlStateBytes));
  assert.ok(packaged.ordinalArtifactBytes.equals(controls.ordinalArtifactBytes));
  assert.equal(packaged.shadowFamilyFiles.length, 4);
  assert.equal(packaged.familyFiles.length, 6);
  const shadow = validatePortableRainShadowFiles(
    packaged.shadowFamilyFiles,
    packaged.candidateSha256,
  );
  assert.equal(shadow.receipt.controlStateSha256,
    adjustmentSha256(controls.controlStateBytes));
  const serving = validatePortableRainModelPackageFiles(
    packaged.familyFiles,
    packaged.candidateSha256,
  );
  assert.equal(serving.receipt.ordinalArtifactSha256,
    adjustmentSha256(controls.ordinalArtifactBytes));
  assert.throws(
    // reject a receipt whose state member was substituted after packaging
    () => validatePortableRainShadowFiles(packaged.shadowFamilyFiles.map((file) =>
      file.path.includes("control-states")
        ? { ...file, bytes: Buffer.concat([file.bytes, Buffer.from("\n")]) }
        : file), packaged.candidateSha256),
    (error) => error.reason === "rain_package_member_invalid",
  );
});

test("portable rain recipe refuses unselected fit output", async () => {
  const candidate = JSON.parse((await retainedCandidateBytes()).toString("utf8"));
  candidate.state = "no_candidate";
  candidate.reason = "insufficient_development";
  assert.throws(
    // prohibit packaging fit completion without a selected development model
    () => buildPortableRainModelPackage(canonicalJsonBytes(candidate)),
    (error) => error.reason === "rain_candidate_not_selected",
  );
});

// reject unreviewed v3 projection ids while retaining legacy v2 compatibility
test("portable rain package keeps v2 bytes and closes the v3 projection grid", async () => {
  const legacyBytes = await retainedCandidateBytes();
  const legacy = buildPortableRainModelPackage(legacyBytes);
  assert.equal(legacy.runtimeArtifact.contractVersion, "rain-hurdle-wind-runtime/v1");
  assert.equal(Object.hasOwn(legacy.runtimeArtifact, "projectionId"), false);
  const candidate = JSON.parse((await retainedCandidateBytes({
    contractVersion: "rain-maintenance-fit/v3",
    projectionId: "R0_exact_refit",
  })).toString("utf8"));
  candidate.artifact.projectionId = "unreviewed_projection";
  assert.throws(
    // prohibit a selected report from extending the frozen serving grid
    () => buildPortableRainModelPackage(canonicalJsonBytes(candidate)),
    (error) => error.reason === "rain_runtime_artifact_invalid",
  );
});
