import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";
import {
  parseRainMaintenanceControlState,
  validateRainMaintenanceControlArtifact,
} from "./adjustment-maintenance-runtime/forecast/rain-maintenance-controls.js";

export const ADJUSTMENT_RAIN_MODEL_PACKAGE_CONTRACT_VERSION =
  "forecast-adjustment-rain-model-package/v1";
export const ADJUSTMENT_RAIN_MODEL_PACKAGE_V2_CONTRACT_VERSION =
  "forecast-adjustment-rain-model-package/v2";
export const ADJUSTMENT_RAIN_RUNTIME_VERSION = "rain-hurdle-wind-runtime/v1";
export const ADJUSTMENT_RAIN_RUNTIME_V2_VERSION = "rain-hurdle-wind-runtime/v2";
export const ADJUSTMENT_RAIN_PROJECTION_IDS = Object.freeze([
  "R0_exact_refit",
  "R1_winter_scale_0_90",
  "R2_winter_scale_0_95",
  "R3_spring_wet_logit_plus_0_20",
  "R4_summer_wet_logit_plus_0_20",
  "R5_nested_cumulative_min",
  "R6_heavy_raw_blend_0_25",
]);

const HEAD_NAMES = Object.freeze(["0.1", "1.0", "2.5", "amount"]);
const THRESHOLDS = Object.freeze([0.1, 1, 2.5]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

// transform one sanitized fit candidate into the compiled public runtime package
export function buildPortableRainModelPackage(candidateBytes, controls = null) {
  const bytes = requireBuffer(candidateBytes, "rain candidate bytes");
  const candidate = parseCanonicalJson(bytes, "rain candidate");
  const candidateSha256 = adjustmentSha256(bytes);

  // admit only a genuine selected development candidate
  if (!["rain-maintenance-fit/v2", "rain-maintenance-fit/v3"].includes(
    candidate.contractVersion,
  ) ||
    candidate.state !== "development_candidate" ||
    candidate.reason !== "development_gate_passer") {
    throw packageError("rain_candidate_not_selected");
  }
  const runtimeArtifact = buildRuntimeArtifact(candidate.artifact, candidate.contractVersion);
  const artifactBytes = canonicalJsonBytes(runtimeArtifact);
  const artifactSha256 = adjustmentSha256(artifactBytes);
  const compiledSourceBytes = buildCompiledArtifactSource(artifactBytes, artifactSha256);
  const compiledSourceSha256 = adjustmentSha256(compiledSourceBytes);
  const artifactPath = `config/forecast-adjustments/ballydidean/rain-runtime-artifacts/` +
    `sha256-${artifactSha256}.json`;
  const receiptPath = `config/forecast-adjustments/ballydidean/rain-model-packages/` +
    `sha256-${candidateSha256}.json`;
  const registryPath = "config/forecast-adjustments/ballydidean-rain-runtime.json";
  const compiledSourcePath =
    "packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts";
  const registry = {
    activeArtifact: { artifactSha256 },
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
    rawReason: null,
    siteKey: "ballydidean",
  };
  const registryBytes = canonicalJsonBytes(registry);
  const receiptV1 = {
    artifactPath: artifactPath.slice("config/forecast-adjustments/ballydidean/".length),
    artifactSha256,
    candidateSha256,
    compiledSourcePath,
    compiledSourceSha256,
    contractVersion: ADJUSTMENT_RAIN_MODEL_PACKAGE_CONTRACT_VERSION,
    modelMonth: runtimeArtifact.modelMonth,
    registrySha256: adjustmentSha256(registryBytes),
  };
  const controlPackage = controls === null
    ? null
    : buildRainControlPackage(controls, runtimeArtifact.modelMonth);
  const receipt = controlPackage === null
    ? receiptV1
    : {
        ...receiptV1,
        contractVersion: ADJUSTMENT_RAIN_MODEL_PACKAGE_V2_CONTRACT_VERSION,
        controlStatePath: controlPackage.controlStatePath,
        controlStateSha256: controlPackage.controlStateSha256,
        ordinalArtifactPath: controlPackage.ordinalArtifactPath,
        ordinalArtifactSha256: controlPackage.ordinalArtifactSha256,
      };
  const receiptBytes = canonicalJsonBytes(receipt);
  const technicalFiles = controlPackage === null
    ? [{ bytes: artifactBytes, path: artifactPath }]
    : mergeRainTechnicalArtifactFiles({
        active: { bytes: artifactBytes, path: artifactPath },
        controlPackage,
      });
  return {
    artifactSha256,
    candidateSha256,
    controlStateBytes: controlPackage?.controlStateBytes ?? null,
    controlStateSha256: controlPackage?.controlStateSha256 ?? null,
    familyFiles: [
      ...technicalFiles,
      { bytes: receiptBytes, path: receiptPath },
      { bytes: registryBytes, path: registryPath },
      { bytes: compiledSourceBytes, path: compiledSourcePath },
    ],
    receipt,
    runtimeArtifact,
    ordinalArtifactBytes: controlPackage?.ordinalArtifactBytes ?? null,
    ordinalArtifactSha256: controlPackage?.ordinalArtifactSha256 ?? null,
    shadowFamilyFiles: [
      ...technicalFiles,
      { bytes: receiptBytes, path: receiptPath },
    ],
  };
}

// validate the inactive artifact and candidate mapping used by shadow releases
export function validatePortableRainShadowFiles(files, candidateSha256) {
  requireSha256(candidateSha256, "candidateSha256");

  // require one closed v1 or v2 inactive technical matrix
  if (!Array.isArray(files) || files.length < 2 || files.length > 4) {
    throw packageError("rain_shadow_files_invalid");
  }
  const receiptPath = `config/forecast-adjustments/ballydidean/rain-model-packages/` +
    `sha256-${candidateSha256}.json`;
  const receiptFile = files.find((file) => file.path === receiptPath);

  // bind the inactive projection to its candidate-addressed receipt
  if (receiptFile === undefined || !Buffer.isBuffer(receiptFile.bytes)) {
    throw packageError("rain_package_receipt_invalid");
  }
  const receipt = parseCanonicalJson(receiptFile.bytes, "rain package receipt");
  validateRainPackageReceipt(receipt);
  requireSha256(receipt.artifactSha256, "artifactSha256");

  // prohibit path substitution and cross-candidate receipt reuse
  if (receipt.candidateSha256 !== candidateSha256 ||
    receipt.artifactPath !== `rain-runtime-artifacts/sha256-${receipt.artifactSha256}.json`) {
    throw packageError("rain_package_receipt_invalid");
  }
  const artifactFile = files.find((file) => file.path ===
    `config/forecast-adjustments/ballydidean/${receipt.artifactPath}`);

  // require exact canonical artifact bytes under the receipt identity
  if (artifactFile === undefined || !Buffer.isBuffer(artifactFile.bytes) ||
    adjustmentSha256(artifactFile.bytes) !== receipt.artifactSha256) {
    throw packageError("rain_package_member_invalid");
  }
  const artifact = parseCanonicalJson(artifactFile.bytes, "rain runtime artifact");
  validateRuntimeArtifact(artifact);

  // bind the inactive receipt to its runtime month
  if (artifact.modelMonth !== receipt.modelMonth) {
    throw packageError("rain_package_member_invalid");
  }
  validateRainControlPackageFiles(files, receipt);
  const expectedCount = receipt.contractVersion === ADJUSTMENT_RAIN_MODEL_PACKAGE_CONTRACT_VERSION
    ? 2
    : receipt.ordinalArtifactSha256 === receipt.artifactSha256 ? 3 : 4;

  // reject unrelated immutable members even when every required member exists
  if (files.length !== expectedCount) {
    throw packageError("rain_shadow_files_invalid");
  }
  return { artifact, receipt };
}

// validate the closed four-file rain package against one candidate identity
export function validatePortableRainModelPackageFiles(files, candidateSha256) {
  requireSha256(candidateSha256, "candidateSha256");

  // require one closed v1 or v2 serving package
  if (!Array.isArray(files) || files.length < 4 || files.length > 6 || files.some((file) =>
    file === null || typeof file !== "object" || typeof file.path !== "string" ||
    !Buffer.isBuffer(file.bytes))) {
    throw packageError("rain_package_files_invalid");
  }
  const technical = validatePortableRainTechnicalFiles(files, candidateSha256);
  const registryFile = files.find((file) =>
    file.path === "config/forecast-adjustments/ballydidean-rain-runtime.json");

  // require the technical builder's actionless registry provenance
  if (registryFile === undefined ||
    adjustmentSha256(registryFile.bytes) !== technical.receipt.registrySha256) {
    throw packageError("rain_package_member_invalid");
  }
  const registry = parseCanonicalJson(registryFile.bytes, "rain runtime registry");
  requireExactKeys(registry, [
    "activeArtifact",
    "contractVersion",
    "rawReason",
    "siteKey",
  ], "rain runtime registry");

  // require the active registry to select this artifact only
  if (registry.contractVersion !== "forecast-adjustment-rain-runtime-registry/v1" ||
    registry.siteKey !== "ballydidean" || registry.rawReason !== null ||
    registry.activeArtifact?.artifactSha256 !== technical.receipt.artifactSha256 ||
    Object.keys(registry.activeArtifact ?? {}).length !== 1) {
    throw packageError("rain_package_registry_invalid");
  }
  return technical;
}

// validate a promoted rain package and its independently authorized selector
export function validatePortableRainServingPackageFiles(files, candidateSha256, actionSha256) {
  requireSha256(candidateSha256, "candidateSha256");
  requireSha256(actionSha256, "actionSha256");

  // require one closed v1 or v2 serving package
  if (!Array.isArray(files) || files.length < 4 || files.length > 6 || files.some((file) =>
    file === null || typeof file !== "object" || typeof file.path !== "string" ||
    !Buffer.isBuffer(file.bytes))) {
    throw packageError("rain_package_files_invalid");
  }
  const technical = validatePortableRainTechnicalFiles(files, candidateSha256);
  const registryFile = files.find((file) =>
    file.path === "config/forecast-adjustments/ballydidean-rain-runtime.json");

  // require the new action-bound selector without reinterpreting receipt provenance
  if (registryFile === undefined) {
    throw packageError("rain_package_registry_invalid");
  }
  const registry = parseCanonicalJson(registryFile.bytes, "rain maintenance registry");
  requireExactKeys(registry, [
    "activePackage",
    "contractVersion",
    "rawReason",
    "siteKey",
  ], "rain maintenance registry");
  requireExactKeys(registry.activePackage, [
    "actionSha256",
    "artifactSha256",
    "candidateSha256",
    "path",
  ], "rain active maintenance package");

  // bind the selector to the actual compiled artifact and root action
  if (registry.contractVersion !== "forecast-adjustment-rain-maintenance-registry/v1" ||
    registry.siteKey !== "ballydidean" || registry.rawReason !== null ||
    registry.activePackage.actionSha256 !== actionSha256 ||
    registry.activePackage.artifactSha256 !== technical.receipt.artifactSha256 ||
    registry.activePackage.candidateSha256 !== candidateSha256 ||
    registry.activePackage.path !==
      `rain-runtime-artifacts/sha256-${technical.receipt.artifactSha256}.json`) {
    throw packageError("rain_package_registry_invalid");
  }
  return technical;
}

// validate immutable rain artifact, receipt, and compiled execution bytes
function validatePortableRainTechnicalFiles(files, candidateSha256) {
  const receiptPath = `config/forecast-adjustments/ballydidean/rain-model-packages/` +
    `sha256-${candidateSha256}.json`;
  const receiptFile = files.find((file) => file.path === receiptPath);

  // require the candidate-addressed mapping receipt
  if (receiptFile === undefined) {
    throw packageError("rain_package_receipt_invalid");
  }
  const receipt = parseCanonicalJson(receiptFile.bytes, "rain package receipt");
  validateRainPackageReceipt(receipt);

  // bind the receipt to the selected candidate and fixed execution source
  if (receipt.candidateSha256 !== candidateSha256 ||
    receipt.artifactPath !== `rain-runtime-artifacts/sha256-${receipt.artifactSha256}.json` ||
    receipt.compiledSourcePath !==
      "packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts") {
    throw packageError("rain_package_receipt_invalid");
  }
  const artifactPath = `config/forecast-adjustments/ballydidean/${receipt.artifactPath}`;
  const artifactFile = files.find((file) => file.path === artifactPath);
  const sourceFile = files.find((file) => file.path === receipt.compiledSourcePath);

  // require the exact executable source generated from the portable artifact
  if (artifactFile === undefined || sourceFile === undefined ||
    adjustmentSha256(artifactFile.bytes) !== receipt.artifactSha256 ||
    adjustmentSha256(sourceFile.bytes) !== receipt.compiledSourceSha256) {
    throw packageError("rain_package_member_invalid");
  }
  const artifact = parseCanonicalJson(artifactFile.bytes, "rain runtime artifact");
  validateRuntimeArtifact(artifact);
  const technicalRegistry = {
    activeArtifact: { artifactSha256: receipt.artifactSha256 },
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1",
    rawReason: null,
    siteKey: "ballydidean",
  };

  // bind the receipt month, generator provenance, and source to exact artifact bytes
  if (artifact.modelMonth !== receipt.modelMonth ||
    adjustmentSha256(canonicalJsonBytes(technicalRegistry)) !== receipt.registrySha256 ||
    !buildCompiledArtifactSource(artifactFile.bytes, receipt.artifactSha256)
      .equals(sourceFile.bytes)) {
    throw packageError("rain_package_member_invalid");
  }
  validateRainControlPackageFiles(files, receipt);
  const technicalCount = receipt.contractVersion === ADJUSTMENT_RAIN_MODEL_PACKAGE_CONTRACT_VERSION
    ? 2
    : receipt.ordinalArtifactSha256 === receipt.artifactSha256 ? 3 : 4;

  // exclude unrelated files from the full technical plus registry/source matrix
  if (files.length !== technicalCount + 2) {
    throw packageError("rain_package_files_invalid");
  }
  return { artifact, receipt };
}

// build one state and ordinal-artifact extension without changing legacy bytes
function buildRainControlPackage(value, modelMonth) {
  requirePlainObject(value, "rain control package");
  requireExactKeys(value, ["controlStateBytes", "ordinalArtifactBytes"],
    "rain control package");
  const controlStateBytes = requireBuffer(value.controlStateBytes, "rain control state bytes");
  const ordinalArtifactBytes = requireBuffer(
    value.ordinalArtifactBytes,
    "rain ordinal artifact bytes",
  );
  const state = parseRainMaintenanceControlState(controlStateBytes);
  validateRainMaintenanceControlArtifact(state, ordinalArtifactBytes);

  // keep the selected and fixed-control runtimes on the same due month
  if (state.modelMonth !== modelMonth) {
    throw packageError("rain_control_state_invalid");
  }
  const controlStateSha256 = adjustmentSha256(controlStateBytes);
  const ordinalArtifactSha256 = adjustmentSha256(ordinalArtifactBytes);
  const controlStatePath =
    `rain-maintenance-control-states/sha256-${controlStateSha256}.json`;
  const ordinalArtifactPath = `rain-runtime-artifacts/sha256-${ordinalArtifactSha256}.json`;
  return {
    controlStateBytes,
    controlStatePath,
    controlStateSha256,
    ordinalArtifactBytes,
    ordinalArtifactPath,
    ordinalArtifactSha256,
  };
}

// retain one copy when the selected and fixed-control artifacts are identical
function mergeRainTechnicalArtifactFiles(input) {
  const ordinalPath =
    `config/forecast-adjustments/ballydidean/${input.controlPackage.ordinalArtifactPath}`;
  const files = [input.active];

  // add the separate fixed control runtime only when it has a distinct address
  if (ordinalPath !== input.active.path) {
    files.push({
      bytes: input.controlPackage.ordinalArtifactBytes,
      path: ordinalPath,
    });
  } else if (!input.controlPackage.ordinalArtifactBytes.equals(input.active.bytes)) {
    throw packageError("rain_control_artifact_invalid");
  }
  files.push({
    bytes: input.controlPackage.controlStateBytes,
    path: `config/forecast-adjustments/ballydidean/${input.controlPackage.controlStatePath}`,
  });
  return files;
}

// validate the disjoint exact v1 and v2 receipt schemas
function validateRainPackageReceipt(receipt) {
  const legacyKeys = [
    "artifactPath", "artifactSha256", "candidateSha256", "compiledSourcePath",
    "compiledSourceSha256", "contractVersion", "modelMonth", "registrySha256",
  ];
  const v2Keys = [
    ...legacyKeys,
    "controlStatePath", "controlStateSha256", "ordinalArtifactPath",
    "ordinalArtifactSha256",
  ];

  // choose only from the two frozen receipt versions
  if (receipt.contractVersion === ADJUSTMENT_RAIN_MODEL_PACKAGE_CONTRACT_VERSION) {
    requireExactKeys(receipt, legacyKeys, "rain package receipt");
  } else if (receipt.contractVersion === ADJUSTMENT_RAIN_MODEL_PACKAGE_V2_CONTRACT_VERSION) {
    requireExactKeys(receipt, v2Keys, "rain package receipt");
    requireSha256(receipt.controlStateSha256, "controlStateSha256");
    requireSha256(receipt.ordinalArtifactSha256, "ordinalArtifactSha256");
    if (receipt.controlStatePath !==
      `rain-maintenance-control-states/sha256-${receipt.controlStateSha256}.json` ||
      receipt.ordinalArtifactPath !==
      `rain-runtime-artifacts/sha256-${receipt.ordinalArtifactSha256}.json`) {
      throw packageError("rain_package_receipt_invalid");
    }
  } else {
    throw packageError("rain_package_receipt_invalid");
  }
  requireSha256(receipt.artifactSha256, "artifactSha256");
  requireSha256(receipt.compiledSourceSha256, "compiledSourceSha256");
  requireSha256(receipt.registrySha256, "registrySha256");
}

// bind v2 state bytes to the independently loaded ordinal runtime
function validateRainControlPackageFiles(files, receipt) {
  // preserve the exact legacy matrix without optional control members
  if (receipt.contractVersion === ADJUSTMENT_RAIN_MODEL_PACKAGE_CONTRACT_VERSION) {
    return;
  }
  const stateFile = files.find((file) => file.path ===
    `config/forecast-adjustments/ballydidean/${receipt.controlStatePath}`);
  const ordinalFile = files.find((file) => file.path ===
    `config/forecast-adjustments/ballydidean/${receipt.ordinalArtifactPath}`);

  // require actual canonical members rather than receipt-only hashes
  if (stateFile === undefined || ordinalFile === undefined ||
    adjustmentSha256(stateFile.bytes) !== receipt.controlStateSha256 ||
    adjustmentSha256(ordinalFile.bytes) !== receipt.ordinalArtifactSha256) {
    throw packageError("rain_package_member_invalid");
  }
  const state = parseRainMaintenanceControlState(stateFile.bytes);
  validateRainMaintenanceControlArtifact(state, ordinalFile.bytes);
  if (state.modelMonth !== receipt.modelMonth) {
    throw packageError("rain_package_member_invalid");
  }
}

// evaluate one validated runtime artifact on a public feature vector
export function evaluatePortableRainArtifact(artifactInput, featuresInput, validAt = undefined) {
  const artifact = validateRuntimeArtifact(structuredClone(artifactInput));
  return evaluateValidatedRainArtifact(artifact, featuresInput, validAt);
}

// evaluate one already-validated numerical artifact without package construction
function evaluateValidatedRainArtifact(artifact, featuresInput, validAt) {
  // preserve float32 feature semantics and explicit missing branches
  if (!Array.isArray(featuresInput) && !(featuresInput instanceof Float32Array)) {
    throw new TypeError("rain parity features are invalid");
  }
  const features = Float32Array.from(featuresInput, (value) => value === null
    ? Number.NaN
    : value);

  // require the exact fitted feature order width
  if (features.length !== artifact.featureNames.length ||
    features.some((value) => value === Infinity || value === -Infinity)) {
    throw new TypeError("rain parity features are invalid");
  }
  const raw = features[5];

  // bind the portable projection to one physical raw amount
  if (!Number.isFinite(raw) || raw < 0) {
    throw new TypeError("rain parity raw amount is invalid");
  }
  const nativeProbabilities = THRESHOLDS.map(
    // score each named binary occurrence head independently
    (threshold) => scoreRainHead(artifact.heads[threshold.toFixed(1)], features),
  );
  const probabilities = artifact.contractVersion === ADJUSTMENT_RAIN_RUNTIME_V2_VERSION
    ? projectRainOccurrenceProbabilities(nativeProbabilities, artifact.projectionId, validAt)
    : nativeProbabilities;
  let category = 0;

  // select the highest calibrated event exactly once
  for (let index = 0; index < THRESHOLDS.length; index += 1) {
    const rule = artifact.rules[index];
    const score = probabilities[index];

    // reject impossible binary probabilities
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new TypeError("rain parity probability is invalid");
    }

    // retain raw-threshold fallback only for an explicit null cutoff
    if (rule.cutoff === null ? raw >= THRESHOLDS[index] : score >= rule.cutoff) {
      category = index + 1;
    }
  }
  const positiveAmountMm = Math.min(
    30,
    Math.max(0.1, scoreRainHead(artifact.heads.amount, features)),
  );
  let correctedPrecipitationMm = 0;

  // apply the v2 wet-call floor even when no learned category was called
  if (category === 0 && artifact.contractVersion === ADJUSTMENT_RAIN_RUNTIME_V2_VERSION) {
    correctedPrecipitationMm = applyRainSelectedProjection(
      raw,
      correctedPrecipitationMm,
      artifact.projectionId,
      validAt,
    );
  }
  // project a called category through its calibrated amount scale
  if (category > 0) {
    const base = Math.min(30, Math.max(0, 0.25 * raw + 0.75 * positiveAmountMm));
    const scaled = base * artifact.categoryScales[category - 1];
    const lower = THRESHOLDS[category - 1];
    const upper = category === 1
      ? 1 - Number.EPSILON / 2
      : category === 2 ? 2.5 - Number.EPSILON : 30;
    correctedPrecipitationMm = Math.min(upper, Math.max(lower, scaled));
    // apply the selected arm and original guard after calibration
    if (artifact.contractVersion === ADJUSTMENT_RAIN_RUNTIME_V2_VERSION) {
      correctedPrecipitationMm = applyRainSelectedProjection(
        raw,
        correctedPrecipitationMm,
        artifact.projectionId,
        validAt,
      );
    }
  }
  return {
    correctedPrecipitationMm,
    occurrenceProbabilityAtLeast0_1: probabilities[0],
    occurrenceProbabilityAtLeast1_0: probabilities[1],
    occurrenceProbabilityAtLeast2_5: probabilities[2],
    positiveAmountMm,
  };
}

// evaluate raw selected fit bytes without packaging or reparsing serving bytes
export function evaluateNativeRainCandidateArtifact(
  candidateBytes,
  featuresInput,
  validAt = undefined,
) {
  const native = createNativeRainCandidateArtifactEvaluator(candidateBytes);
  // prohibit the legacy candidate contract on the v3-only direct helper
  if (native.contractVersion !== "rain-maintenance-fit/v3") {
    throw packageError("rain_candidate_not_selected");
  }
  return native.evaluate(featuresInput, validAt);
}

// prepare one raw fit candidate for repeated independent parity evaluation
export function createNativeRainCandidateArtifactEvaluator(candidateBytes) {
  const bytes = requireBuffer(candidateBytes, "rain candidate bytes");
  const candidate = parseCanonicalJson(bytes, "rain candidate");
  // require one selected legacy or v3 fit before exposing numerical material
  if (!["rain-maintenance-fit/v2", "rain-maintenance-fit/v3"].includes(
    candidate.contractVersion,
  ) || candidate.state !== "development_candidate" ||
    candidate.reason !== "development_gate_passer") {
    throw packageError("rain_candidate_not_selected");
  }
  const numericalArtifact = buildRuntimeArtifact(
    candidate.artifact,
    candidate.contractVersion,
  );
  return Object.freeze({
    artifactSha256: adjustmentSha256(canonicalJsonBytes(numericalArtifact)),
    candidateSha256: adjustmentSha256(bytes),
    contractVersion: candidate.contractVersion,
    // evaluate raw candidate material without emitting package bytes
    evaluate: (features, validAt = undefined) =>
      evaluateValidatedRainArtifact(numericalArtifact, features, validAt),
    featureNames: Object.freeze([...numericalArtifact.featureNames]),
    modelMonth: numericalArtifact.modelMonth,
  });
}

// apply one reviewed occurrence-head arm before category selection
function projectRainOccurrenceProbabilities(probabilities, projectionId, validAt) {
  const projected = [...probabilities];
  const month = rainProjectionMonth(validAt);
  const seasonalMonths = projectionId === "R3_spring_wet_logit_plus_0_20"
    ? [3, 4, 5]
    : projectionId === "R4_summer_wet_logit_plus_0_20" ? [6, 7, 8] : [];
  // adjust only the selected seasonal wet head
  if (seasonalMonths.includes(month)) {
    const probability = Math.min(1 - 1e-12, Math.max(1e-12, projected[0]));
    projected[0] = Math.fround(1 / (1 + Math.exp(
      -(Math.log(probability / (1 - probability)) + 0.20),
    )));
  }
  // enforce nesting only for its independent arm
  if (projectionId === "R5_nested_cumulative_min") {
    for (let index = 1; index < projected.length; index += 1) {
      projected[index] = Math.min(projected[index - 1], projected[index]);
    }
  }
  return projected;
}

// apply post-calibration arm behavior and the original event guard
function applyRainSelectedProjection(raw, calibrated, projectionId, validAt) {
  const month = rainProjectionMonth(validAt);
  let projected = calibrated;
  // scale only winter hours in the selected scale arm
  if ([12, 1, 2].includes(month) &&
    ["R1_winter_scale_0_90", "R2_winter_scale_0_95"].includes(projectionId)) {
    projected *= projectionId === "R1_winter_scale_0_90" ? 0.90 : 0.95;
  }
  // preserve the preregistered heavy blend before the overriding safety guard
  if (projectionId === "R6_heavy_raw_blend_0_25" && raw >= 1) {
    projected = 0.25 * raw + 0.75 * projected;
  }
  // preserve raw heavy amounts and every raw wet call
  if (raw >= 1) {
    return raw;
  }
  return raw >= 0.1 ? Math.max(0.1, projected) : projected;
}

// derive the native grid's local target month
function rainProjectionMonth(validAt) {
  // require an exact target clock for every selected v2 arm
  if (typeof validAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(validAt) ||
    new Date(validAt).toISOString() !== validAt) {
    throw new TypeError("rain parity validAt is invalid");
  }
  const month = new Intl.DateTimeFormat("en-US", {
    calendar: "gregory",
    month: "numeric",
    numberingSystem: "latn",
    timeZone: "America/Los_Angeles",
  }).formatToParts(new Date(validAt)).find((part) => part.type === "month")?.value;
  // fail closed if the runtime calendar cannot expose its month
  if (month === undefined) {
    throw new TypeError("rain parity validAt is invalid");
  }
  return Number(month);
}

// derive only serving material from the selected candidate artifact
function buildRuntimeArtifact(value, candidateContractVersion) {
  requirePlainObject(value, "rain candidate artifact");
  const calibration = value.calibration;
  requirePlainObject(calibration, "rain candidate calibration");

  // require the fitted artifact and calibration contracts
  if (value.contractVersion !== "rain-maintenance-artifact/v2" ||
    typeof value.projectionId !== "string" || value.projectionId.length === 0 ||
    calibration.contractVersion !== "rain-hurdle-calibration/v1") {
    throw packageError("rain_candidate_artifact_invalid");
  }
  const rules = calibration.rules;
  const categories = calibration.categories;

  // require the exact three ordered physical threshold rules
  if (!Array.isArray(rules) || rules.length !== 3 ||
    rules.some((rule, index) => rule?.threshold !== THRESHOLDS[index] ||
      (rule.cutoff !== null &&
        (typeof rule.cutoff !== "number" || !Number.isFinite(rule.cutoff) ||
          rule.cutoff < 0 || rule.cutoff > 1)))) {
    throw packageError("rain_candidate_calibration_invalid");
  }
  requirePlainObject(categories, "rain candidate categories");
  const categoryScales = ["1", "2", "3"].map(
    // project only the three serving calibration scales
    (category) => categories[category]?.scale,
  );

  // retain only bounded positive serving scales
  if (categoryScales.some((scale) => typeof scale !== "number" ||
    !Number.isFinite(scale) || scale < 0.1 || scale > 3)) {
    throw packageError("rain_candidate_calibration_invalid");
  }
  const runtimeArtifact = {
    categoryScales,
    contractVersion: candidateContractVersion === "rain-maintenance-fit/v3"
      ? ADJUSTMENT_RAIN_RUNTIME_V2_VERSION
      : ADJUSTMENT_RAIN_RUNTIME_VERSION,
    featureNames: value.featureNames,
    heads: value.heads,
    modelMonth: value.modelMonth,
    rules: rules.map(
      // exclude development-only calibration metadata
      (rule) => ({ cutoff: rule.cutoff, threshold: rule.threshold }),
    ),
  };
  // retain the selected v3 projection in serving bytes
  if (candidateContractVersion === "rain-maintenance-fit/v3") {
    runtimeArtifact.projectionId = value.projectionId;
  }
  return validateRuntimeArtifact(runtimeArtifact);
}

// validate one complete portable numerical runtime artifact
function validateRuntimeArtifact(value) {
  requirePlainObject(value, "rain runtime artifact");
  const keys = [
    "categoryScales",
    "contractVersion",
    "featureNames",
    "heads",
    "modelMonth",
    "rules",
  ];
  // close the additive runtime against one reviewed selected projection
  if (value.contractVersion === ADJUSTMENT_RAIN_RUNTIME_V2_VERSION) {
    keys.push("projectionId");
  }
  requireExactKeys(value, keys, "rain runtime artifact");

  // require closed runtime identity and feature order
  if (![ADJUSTMENT_RAIN_RUNTIME_VERSION, ADJUSTMENT_RAIN_RUNTIME_V2_VERSION].includes(
    value.contractVersion,
  ) ||
    (value.contractVersion === ADJUSTMENT_RAIN_RUNTIME_V2_VERSION &&
      !ADJUSTMENT_RAIN_PROJECTION_IDS.includes(value.projectionId)) ||
    typeof value.modelMonth !== "string" || !/^\d{4}-\d{2}$/u.test(value.modelMonth) ||
    !Array.isArray(value.featureNames) || value.featureNames.length !== 107 ||
    new Set(value.featureNames).size !== 107 ||
    value.featureNames.some((name) => typeof name !== "string" || name.length === 0 ||
      name.length > 128)) {
    throw packageError("rain_runtime_artifact_invalid");
  }

  // require the selected calibration projection
  if (!Array.isArray(value.rules) || value.rules.length !== 3 ||
    value.rules.some((rule, index) => rule?.threshold !== THRESHOLDS[index] ||
      (rule.cutoff !== null &&
        (typeof rule.cutoff !== "number" || !Number.isFinite(rule.cutoff) ||
          rule.cutoff < 0 || rule.cutoff > 1))) ||
    !Array.isArray(value.categoryScales) || value.categoryScales.length !== 3 ||
    value.categoryScales.some((scale) => typeof scale !== "number" ||
      !Number.isFinite(scale) || scale < 0.1 || scale > 3)) {
    throw packageError("rain_runtime_artifact_invalid");
  }
  requirePlainObject(value.heads, "rain runtime heads");
  requireExactKeys(value.heads, HEAD_NAMES, "rain runtime heads");

  // validate every fixed named head
  for (const name of HEAD_NAMES) {
    validateRainHead(value.heads[name], name, value.featureNames.length);
  }
  return value;
}

// validate one compact numerical tree ensemble
function validateRainHead(head, name, featureCount) {
  requirePlainObject(head, `rain runtime head ${name}`);
  requireExactKeys(head, ["baseScore", "objective", "trees"], `rain runtime head ${name}`);
  const expectedObjective = name === "amount" ? "reg:gamma" : "binary:logistic";

  // require one complete fitted finite ensemble
  if (head.objective !== expectedObjective || typeof head.baseScore !== "number" ||
    !Number.isFinite(head.baseScore) || head.baseScore <= 0 ||
    (name !== "amount" && head.baseScore >= 1) ||
    !Array.isArray(head.trees) || head.trees.length !== 160) {
    throw packageError("rain_runtime_head_invalid");
  }

  // validate every numerical tree before publication
  for (const tree of head.trees) {
    if (!Array.isArray(tree) || tree.length !== 5 ||
      tree.some((column) => !Array.isArray(column)) || tree[0].length === 0 ||
      tree.some((column) => column.length !== tree[0].length)) {
      throw packageError("rain_runtime_tree_invalid");
    }

    // prove every node is finite and forward-only
    for (let node = 0; node < tree[0].length; node += 1) {
      const feature = tree[0][node];
      const value = tree[1][node];
      const left = tree[2][node];
      const right = tree[3][node];
      const missingLeft = tree[4][node];

      // reject categorical, cyclic, malformed, or out-of-range nodes
      if (!Number.isInteger(feature) || feature < 0 || feature >= featureCount ||
        typeof value !== "number" || !Number.isFinite(value) ||
        !Number.isInteger(left) || !Number.isInteger(right) ||
        !new Set([0, 1]).has(missingLeft) ||
        (left !== -1 && (left <= node || left >= tree[0].length)) ||
        (right !== -1 && (right <= node || right >= tree[0].length)) ||
        ((left === -1) !== (right === -1))) {
        throw packageError("rain_runtime_tree_invalid");
      }
    }
  }
}

// score one head using native float32 split comparisons
function scoreRainHead(head, features) {
  let margin = head.objective === "binary:logistic"
    ? Math.log(head.baseScore / (1 - head.baseScore))
    : Math.log(head.baseScore);

  // sum every ordered tree contribution
  for (const tree of head.trees) {
    let node = 0;

    // traverse the validated forward-only tree
    while (tree[2][node] !== -1) {
      const value = features[tree[0][node]];
      const goLeft = Number.isNaN(value)
        ? tree[4][node] === 1
        : value < Math.fround(tree[1][node]);
      node = goLeft ? tree[2][node] : tree[3][node];
    }
    margin += tree[1][node];
  }
  return Math.fround(head.objective === "binary:logistic"
    ? 1 / (1 + Math.exp(-margin))
    : Math.exp(margin));
}

// emit one deterministic generated typescript artifact module
function buildCompiledArtifactSource(artifactBytes, artifactSha256) {
  const artifactText = artifactBytes.toString("utf8");
  const source =
    "// generated by adjustment_rain_model_package.mjs from a sanitized fit candidate\n" +
    `export const RAIN_HURDLE_WIND_ARTIFACT_SHA256 = ${JSON.stringify(artifactSha256)} as const;\n` +
    `export const RAIN_HURDLE_WIND_ARTIFACT_JSON = ${JSON.stringify(artifactText)} as const;\n`;
  return Buffer.from(source, "utf8");
}

// parse one exact canonical json object
function parseCanonicalJson(bytes, label) {
  let value;

  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }

  // reject alternate encodings and top-level arrays
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    !canonicalJsonBytes(value).equals(bytes)) {
    throw new TypeError(`${label} is not canonical`);
  }
  return value;
}

// require one real nonempty byte buffer
function requireBuffer(value, label) {
  // prohibit paths, strings, and hash-only candidate claims
  if (!Buffer.isBuffer(value) || value.length === 0 || value.length > 8 * 1_024 * 1_024) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one lowercase sha256 identity
function requireSha256(value, label) {
  // reject abbreviated and uppercase identities
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one plain data object
function requirePlainObject(value, label) {
  // reject null, arrays, and custom prototypes
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one exact key set
function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  // reject omitted or future fields at the runtime boundary
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} keys are invalid`);
  }
}

// create one closed portable-package failure
function packageError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}
