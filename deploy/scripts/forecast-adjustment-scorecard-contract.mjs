const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_LABEL_PATTERN = /^[a-z0-9][a-z0-9_.:+-]{0,79}$/u;

export const FORECAST_ADJUSTMENT_SCORECARD_V1_CONTRACT_VERSION =
  "forecast-adjustment-scorecard/v1";
export const FORECAST_ADJUSTMENT_SCORECARD_V2_CONTRACT_VERSION =
  "forecast-adjustment-scorecard/v2";
export const FORECAST_ADJUSTMENT_SCORECARD_CONTRACT_VERSION =
  FORECAST_ADJUSTMENT_SCORECARD_V1_CONTRACT_VERSION;
export const FORECAST_ADJUSTMENT_SCORECARD_V1_MAX_BYTES = 512 * 1_024;
export const FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES = 128 * 1_024;
export const FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES =
  FORECAST_ADJUSTMENT_SCORECARD_V1_MAX_BYTES;
export const FORECAST_ADJUSTMENT_SCORECARD_FAMILIES = [
  "temperature",
  "wind",
  "rain",
];

const EVIDENCE_CLASSES = [
  "as_issued",
  "prospective_receipt",
  "retrospective_counterfactual",
  "development",
];
const SUPPORT_STATES = ["sufficient", "insufficient", "invalid"];
const COMPARISON_STATES = ["unscored", "better", "mixed", "worse"];
const QUALIFICATION_STATES = [
  "development_only",
  "counterfactual_only",
  "pending_support",
  "supported",
  "rejected",
];
const SERVING_STATES = [
  "authorized_active",
  "admin_disabled",
  "fail_raw",
  "pending_review",
];
const RECOMMENDATIONS = ["retain", "review_candidate", "review_disable", "none"];
const SLICE_DIMENSIONS = ["horizon", "month", "season", "daypart"];
const POLICY_DECISIONS = ["pending", "qualified", "failed", "regressed"];
const ACTION_STATES = [
  "none",
  "shadow_pending",
  "confirmation_registered",
  "pending_support",
  "release_pending",
  "deploying",
  "active",
  "failed",
  "expired_unapplied",
  "deployed_operator_off",
  "rolled_back_prior",
  "raw",
];
const ATTEMPT_STATES = ["not_due", "due", "running", "completed", "failed", "blocked"];
const SUCCESS_STATES = ["none", "succeeded", "failed"];
const DUE_STATES = ["not_due", "due", "overdue", "expired"];
const BACKLOG_STATES = ["clear", "present", "blocked"];
const OPERATOR_STATES = ["enabled", "disabled"];
const WARNING_CLASSES = ["source", "fallback", "gauge", "capture", "capacity"];
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

// parse one bounded closed scorecard document
export function parseForecastAdjustmentScorecard(input, options = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);

  // stop oversized documents before parsing
  if (bytes.byteLength > FORECAST_ADJUSTMENT_SCORECARD_MAX_BYTES) {
    throw new RangeError("forecast adjustment scorecard is too large");
  }

  const value = JSON.parse(bytes.toString("utf8"));

  // apply the tighter v2 publication envelope before semantic validation
  if (value?.contractVersion === FORECAST_ADJUSTMENT_SCORECARD_V2_CONTRACT_VERSION &&
    bytes.byteLength > FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES) {
    throw new RangeError("forecast adjustment scorecard v2 is too large");
  }
  validateForecastAdjustmentScorecard(value, options);
  return value;
}

// validate one supported aggregate-only scorecard contract
export function validateForecastAdjustmentScorecard(value, options = {}) {
  requireObject(value, "scorecard");

  // keep private confirmation member material structurally impossible
  rejectPrivateMemberFields(value, "scorecard");

  // preserve closed legacy display while routing v2 to automatic policy validation
  if (value.contractVersion === FORECAST_ADJUSTMENT_SCORECARD_V2_CONTRACT_VERSION) {
    return validateForecastAdjustmentScorecardV2(value, options);
  }

  return validateForecastAdjustmentScorecardV1(value, options);
}

// validate the historical review-only scorecard contract
function validateForecastAdjustmentScorecardV1(value, options) {
  requireKeys(value, [
    "automaticActivationEligible",
    "contractVersion",
    "families",
    "generatedAt",
    "inputs",
    "operatorApprovalRequired",
    "servingChanged",
    "siteKey",
    "validThrough",
  ], "scorecard");
  requireEqual(value.contractVersion, FORECAST_ADJUSTMENT_SCORECARD_V1_CONTRACT_VERSION, "contractVersion");
  requireEqual(value.siteKey, "ballydidean", "siteKey");
  requireInstant(value.generatedAt, "generatedAt");
  requireInstant(value.validThrough, "validThrough");

  // require one forward validity interval
  if (Date.parse(value.validThrough) <= Date.parse(value.generatedAt)) {
    throw new RangeError("forecast adjustment scorecard validity is invalid");
  }

  // reject expired publications at read time only
  if (options.now !== undefined && Date.parse(value.validThrough) <= Date.parse(options.now)) {
    throw new RangeError("forecast adjustment scorecard is stale");
  }

  requireEqual(value.servingChanged, false, "servingChanged");
  requireEqual(value.automaticActivationEligible, false, "automaticActivationEligible");
  requireEqual(value.operatorApprovalRequired, true, "operatorApprovalRequired");
  validateInputs(value.inputs);
  requireObject(value.families, "families");
  requireKeys(value.families, FORECAST_ADJUSTMENT_SCORECARD_FAMILIES, "families");

  // preserve one card for every existing model family
  for (const family of FORECAST_ADJUSTMENT_SCORECARD_FAMILIES) {
    validateFamily(value.families[family], family);
  }

  return value;
}

// validate the sanitized automatic policy projection
function validateForecastAdjustmentScorecardV2(value, options) {
  requireKeys(value, [
    "actionLineage",
    "actionProjectionSha256",
    "actionState",
    "contractVersion",
    "families",
    "generatedAt",
    "history",
    "identities",
    "inputs",
    "job",
    "policyDecision",
    "progress",
    "siteKey",
    "validThrough",
    "warnings",
  ], "scorecard");
  requireEqual(value.contractVersion, FORECAST_ADJUSTMENT_SCORECARD_V2_CONTRACT_VERSION, "contractVersion");
  requireEqual(value.siteKey, "ballydidean", "siteKey");
  validateValidity(value.generatedAt, value.validThrough, options, true);
  requireEnum(value.policyDecision, POLICY_DECISIONS, "policyDecision");
  requireEnum(value.actionState, ACTION_STATES, "actionState");
  requireSha256(value.actionProjectionSha256, "actionProjectionSha256");
  validateInputsV2(value.inputs);
  validateActionLineage(value.actionLineage);
  validateJob(value.job);
  validateWarnings(value.warnings);
  validateIdentities(value.identities);
  validateProgress(value.progress);
  const latestHistory = validateHistory(value.history);

  // bind the newest history entry to the current immutable projection
  if (latestHistory !== null && (
    latestHistory.actionProjectionSha256 !== value.actionProjectionSha256 ||
    latestHistory.actionState !== value.actionState ||
    latestHistory.policyDecision !== value.policyDecision ||
    latestHistory.attemptSha256 !== value.actionLineage.attemptSha256 ||
    latestHistory.releaseManifestSha256 !== value.actionLineage.releaseManifestSha256
  )) {
    throw new TypeError("latest scorecard history does not match the current projection");
  }
  requireObject(value.families, "families");
  requireKeys(value.families, FORECAST_ADJUSTMENT_SCORECARD_FAMILIES, "families");

  // retain the same aggregate diagnostic cards across the migration
  for (const family of FORECAST_ADJUSTMENT_SCORECARD_FAMILIES) {
    validateFamily(value.families[family], family);
  }

  return value;
}

// validate a forward, fresh, optionally seven-day publication window
function validateValidity(generatedAt, validThrough, options, requireSevenDayMaximum) {
  requireInstant(generatedAt, "generatedAt");
  requireInstant(validThrough, "validThrough");
  const generatedTime = Date.parse(generatedAt);
  const validThroughTime = Date.parse(validThrough);

  // reject reversed and overlong report validity
  if (validThroughTime <= generatedTime ||
    (requireSevenDayMaximum && validThroughTime - generatedTime > SEVEN_DAYS_MS)) {
    throw new RangeError("forecast adjustment scorecard validity is invalid");
  }

  // reject expired publications at read time only
  if (options.now !== undefined && validThroughTime <= Date.parse(options.now)) {
    throw new RangeError("forecast adjustment scorecard is stale");
  }
}

// validate immutable v2 report and frontier inputs
function validateInputsV2(value) {
  requireObject(value, "inputs");
  requireKeys(value, [
    "adjustmentEvidenceManifestSha256",
    "adjustmentEvidenceWatermarkSha256",
    "forecastTrainingManifestSha256",
    "frontierSha256",
    "inputManifestSha256",
    "localDateFrom",
    "localDateTo",
    "reportSha256",
    "reportSha256s",
    "sourceRevision",
    "targetCutoffAt",
  ], "inputs");
  validateInputs({
    adjustmentEvidenceManifestSha256: value.adjustmentEvidenceManifestSha256,
    adjustmentEvidenceWatermarkSha256: value.adjustmentEvidenceWatermarkSha256,
    forecastTrainingManifestSha256: value.forecastTrainingManifestSha256,
    localDateFrom: value.localDateFrom,
    localDateTo: value.localDateTo,
    reportSha256s: value.reportSha256s,
    sourceRevision: value.sourceRevision,
    targetCutoffAt: value.targetCutoffAt,
  });
  requireSha256(value.frontierSha256, "inputs.frontierSha256");
  requireSha256(value.inputManifestSha256, "inputs.inputManifestSha256");
  requireSha256(value.reportSha256, "inputs.reportSha256");
}

// validate immutable action lineage without accepting signatures or approval fields
function validateActionLineage(value) {
  requireObject(value, "actionLineage");
  requireKeys(value, [
    "actionSha256",
    "attemptSha256",
    "predecessorActionSha256",
    "releaseManifestSha256",
    "sourceRevision",
  ], "actionLineage");
  requireSha256(value.actionSha256, "actionLineage.actionSha256");
  requireSha256(value.attemptSha256, "actionLineage.attemptSha256");
  requireNullableSha256(value.predecessorActionSha256, "actionLineage.predecessorActionSha256");
  requireNullableSha256(value.releaseManifestSha256, "actionLineage.releaseManifestSha256");
  requireMatch(value.sourceRevision, REVISION_PATTERN, "actionLineage.sourceRevision");
}

// validate one bounded daily attempt projection
function validateJob(value) {
  requireObject(value, "job");
  requireKeys(value, [
    "attemptState",
    "backlogState",
    "dueState",
    "operatorState",
    "successState",
  ], "job");
  requireEnum(value.attemptState, ATTEMPT_STATES, "job.attemptState");
  requireEnum(value.backlogState, BACKLOG_STATES, "job.backlogState");
  requireEnum(value.dueState, DUE_STATES, "job.dueState");
  requireEnum(value.operatorState, OPERATOR_STATES, "job.operatorState");
  requireEnum(value.successState, SUCCESS_STATES, "job.successState");
}

// validate fixed warning categories containing codes only
function validateWarnings(value) {
  requireObject(value, "warnings");
  requireKeys(value, WARNING_CLASSES, "warnings");

  // bound each warning class independently
  for (const warningClass of WARNING_CLASSES) {
    const warnings = value[warningClass];
    requireArray(warnings, 16, `warnings.${warningClass}`);

    // reject prose, paths and private values
    for (const [index, warning] of warnings.entries()) {
      requireMatch(warning, SAFE_LABEL_PATTERN, `warnings.${warningClass}[${String(index)}]`);
    }
  }
}

// validate active, shadow, prior and raw identities for every family
function validateIdentities(value) {
  requireObject(value, "identities");
  requireKeys(value, ["active", "prior", "raw", "shadow"], "identities");

  // bind all family identity sets to the closed family registry
  for (const identityClass of ["active", "prior", "raw", "shadow"]) {
    const identities = value[identityClass];
    requireObject(identities, `identities.${identityClass}`);
    requireKeys(identities, FORECAST_ADJUSTMENT_SCORECARD_FAMILIES, `identities.${identityClass}`);

    // allow explicit absence except for the raw fallback identity
    for (const family of FORECAST_ADJUSTMENT_SCORECARD_FAMILIES) {
      if (identityClass === "raw") {
        requireSha256(identities[family], `identities.${identityClass}.${family}`);
      } else {
        requireNullableSha256(identities[family], `identities.${identityClass}.${family}`);
      }
    }
  }
}

// validate bounded confirmation and rollback epoch progress
function validateProgress(value) {
  requireObject(value, "progress");
  requireKeys(value, [
    "confirmationCompletedEpochs",
    "confirmationRequiredEpochs",
    "rainCaptureExpiresAt",
    "rollbackCompletedEpochs",
    "rollbackRequiredEpochs",
  ], "progress");
  requireCount(value.confirmationCompletedEpochs, "progress.confirmationCompletedEpochs");
  requireCount(value.confirmationRequiredEpochs, "progress.confirmationRequiredEpochs");
  requireCount(value.rollbackCompletedEpochs, "progress.rollbackCompletedEpochs");
  requireCount(value.rollbackRequiredEpochs, "progress.rollbackRequiredEpochs");
  requireInstant(value.rainCaptureExpiresAt, "progress.rainCaptureExpiresAt");

  // reject impossible progress projections
  if (value.confirmationCompletedEpochs > value.confirmationRequiredEpochs ||
    value.rollbackCompletedEpochs > value.rollbackRequiredEpochs) {
    throw new RangeError("scorecard epoch progress is invalid");
  }
}

// validate the newest bounded sanitized immutable action history
function validateHistory(value) {
  requireArray(value, 64, "history");
  let previousTime = -Infinity;

  // validate each immutable history reference without accepting result bodies
  for (const [index, entry] of value.entries()) {
    const path = `history[${String(index)}]`;
    requireObject(entry, path);
    requireKeys(entry, [
      "actionLineageSha256",
      "actionProjectionSha256",
      "actionState",
      "attemptSha256",
      "occurredAt",
      "policyDecision",
      "releaseManifestSha256",
    ], path);
    requireSha256(entry.actionLineageSha256, `${path}.actionLineageSha256`);
    requireSha256(entry.actionProjectionSha256, `${path}.actionProjectionSha256`);
    requireEnum(entry.actionState, ACTION_STATES, `${path}.actionState`);
    requireSha256(entry.attemptSha256, `${path}.attemptSha256`);
    requireInstant(entry.occurredAt, `${path}.occurredAt`);
    requireEnum(entry.policyDecision, POLICY_DECISIONS, `${path}.policyDecision`);
    requireNullableSha256(entry.releaseManifestSha256, `${path}.releaseManifestSha256`);
    const occurredTime = Date.parse(entry.occurredAt);

    // require stable chronological projection order
    if (occurredTime < previousTime) {
      throw new RangeError("scorecard history is not chronological");
    }
    previousTime = occurredTime;
  }
  return value.at(-1) ?? null;
}

// validate only hashes, cutoffs and aggregate package identity
function validateInputs(value) {
  requireObject(value, "inputs");
  requireKeys(value, [
    "adjustmentEvidenceManifestSha256",
    "adjustmentEvidenceWatermarkSha256",
    "forecastTrainingManifestSha256",
    "localDateFrom",
    "localDateTo",
    "reportSha256s",
    "sourceRevision",
    "targetCutoffAt",
  ], "inputs");
  requireSha256(value.adjustmentEvidenceManifestSha256, "inputs.adjustmentEvidenceManifestSha256");
  requireSha256(value.adjustmentEvidenceWatermarkSha256, "inputs.adjustmentEvidenceWatermarkSha256");
  requireSha256(value.forecastTrainingManifestSha256, "inputs.forecastTrainingManifestSha256");
  requireMatch(value.localDateFrom, DATE_PATTERN, "inputs.localDateFrom");
  requireMatch(value.localDateTo, DATE_PATTERN, "inputs.localDateTo");

  // retain one nonreversed evaluation interval
  if (value.localDateFrom > value.localDateTo) {
    throw new RangeError("scorecard input date interval is invalid");
  }
  requireMatch(value.sourceRevision, REVISION_PATTERN, "inputs.sourceRevision");
  requireInstant(value.targetCutoffAt, "inputs.targetCutoffAt");
  requireObject(value.reportSha256s, "inputs.reportSha256s");
  requireKeys(value.reportSha256s, FORECAST_ADJUSTMENT_SCORECARD_FAMILIES, "inputs.reportSha256s");

  // bind every rendered family to one immutable report
  for (const family of FORECAST_ADJUSTMENT_SCORECARD_FAMILIES) {
    requireSha256(value.reportSha256s[family], `inputs.reportSha256s.${family}`);
  }
}

// validate one closed family card
function validateFamily(value, expectedFamily) {
  requireObject(value, `families.${expectedFamily}`);
  requireKeys(value, [
    "bestMatchDiagnostic",
    "comparisonState",
    "evidenceClass",
    "evidenceCutoffAt",
    "family",
    "metrics",
    "qualificationState",
    "rainDiagnostics",
    "recommendation",
    "servingIdentitySha256",
    "servingState",
    "slices",
    "support",
    "supportState",
  ], `families.${expectedFamily}`);
  requireEqual(value.family, expectedFamily, `families.${expectedFamily}.family`);
  requireNullableSha256(value.servingIdentitySha256, `families.${expectedFamily}.servingIdentitySha256`);
  requireEnum(value.evidenceClass, EVIDENCE_CLASSES, `families.${expectedFamily}.evidenceClass`);
  requireNullableInstant(value.evidenceCutoffAt, `families.${expectedFamily}.evidenceCutoffAt`);
  requireEnum(value.supportState, SUPPORT_STATES, `families.${expectedFamily}.supportState`);
  requireEnum(value.comparisonState, COMPARISON_STATES, `families.${expectedFamily}.comparisonState`);
  requireEnum(value.qualificationState, QUALIFICATION_STATES, `families.${expectedFamily}.qualificationState`);
  requireEnum(value.servingState, SERVING_STATES, `families.${expectedFamily}.servingState`);
  requireEnum(value.recommendation, RECOMMENDATIONS, `families.${expectedFamily}.recommendation`);
  validateSupport(value.support, `families.${expectedFamily}.support`);
  const expectedUnit = expectedFamily === "temperature"
    ? "celsius"
    : expectedFamily === "wind"
      ? "meters_per_second"
      : "millimeters_per_hour";
  validateMetric(value.metrics, `families.${expectedFamily}.metrics`, expectedUnit);
  validateBestMatchDiagnostic(
    value.bestMatchDiagnostic,
    `families.${expectedFamily}.bestMatchDiagnostic`,
    expectedUnit,
    expectedFamily,
  );
  requireArray(value.slices, 256, `families.${expectedFamily}.slices`);

  // validate bounded aggregate slices without accepting arbitrary objects
  for (const [index, slice] of value.slices.entries()) {
    validateSlice(
      slice,
      `families.${expectedFamily}.slices[${String(index)}]`,
      expectedUnit,
    );
  }

  // keep rain-only diagnostics structurally impossible on other cards
  if (expectedFamily === "rain") {
    validateRainDiagnostics(value.rainDiagnostics, "families.rain.rainDiagnostics");
  } else if (value.rainDiagnostics !== null) {
    throw new TypeError(`families.${expectedFamily}.rainDiagnostics must be null`);
  }
}

// validate one separately matched nonqualification baseline diagnostic
function validateBestMatchDiagnostic(value, path, expectedUnit, family) {
  // wind already uses Best Match as its primary baseline
  if (family === "wind") {
    if (value !== null) {
      throw new TypeError(`${path} must be null`);
    }
    return;
  }

  // preserve honest absence when matched rows were not recorded
  if (value === null) {
    return;
  }

  requireObject(value, path);
  requireKeys(value, [
    "bestMatchRawMae",
    "dateCount",
    "rowCount",
    "sourceAdjustedMae",
    "sourceRawMae",
    "unit",
  ], path);
  requireEqual(value.unit, expectedUnit, `${path}.unit`);
  requireCount(value.dateCount, `${path}.dateCount`);
  requireCount(value.rowCount, `${path}.rowCount`);

  // retain only same-paired-subcohort MAEs
  for (const key of ["bestMatchRawMae", "sourceRawMae", "sourceAdjustedMae"]) {
    requireNullableFinite(value[key], `${path}.${key}`);

    if (value[key] !== null && value[key] < 0) {
      throw new RangeError(`${path}.${key} must be nonnegative`);
    }
  }
}

// validate aggregate support and exclusion counts
function validateSupport(value, path) {
  requireObject(value, path);
  requireKeys(value, [
    "dateCount",
    "effectiveWeightSum",
    "eventCount",
    "excludedCount",
    "exclusionReasons",
    "fallbackCount",
    "fallbackReasons",
    "gapCount",
    "rowCount",
    "targetRowCount",
    "validHourCount",
    "vintageCount",
    "wetDateCount",
    "wetRowCount",
  ], path);

  // accept only bounded nonnegative aggregate counts
  for (const key of [
    "dateCount",
    "eventCount",
    "excludedCount",
    "fallbackCount",
    "gapCount",
    "rowCount",
    "targetRowCount",
    "validHourCount",
    "vintageCount",
    "wetDateCount",
    "wetRowCount",
  ]) {
    requireCount(value[key], `${path}.${key}`);
  }
  requireNonnegativeFinite(value.effectiveWeightSum, `${path}.effectiveWeightSum`);
  validateReasonCountMap(value.exclusionReasons, `${path}.exclusionReasons`);
  validateReasonCountMap(value.fallbackReasons, `${path}.fallbackReasons`);
}

// validate one raw-versus-adjusted aggregate metric
function validateMetric(value, path, expectedUnit) {
  requireObject(value, path);
  requireKeys(value, [
    "adjustedBias",
    "adjustedMae",
    "adjustedP95",
    "adjustedRmse",
    "deltaMae",
    "rawBias",
    "rawMae",
    "rawP95",
    "rawRmse",
    "skillInterval95",
    "skillPercent",
    "unit",
  ], path);
  requireEnum(value.unit, ["celsius", "meters_per_second", "millimeters_per_hour"], `${path}.unit`);
  requireEqual(value.unit, expectedUnit, `${path}.unit`);
  requireNullableFinite(value.rawMae, `${path}.rawMae`);
  requireNullableFinite(value.adjustedMae, `${path}.adjustedMae`);
  requireNullableFinite(value.deltaMae, `${path}.deltaMae`);
  requireNullableFinite(value.rawBias, `${path}.rawBias`);
  requireNullableFinite(value.adjustedBias, `${path}.adjustedBias`);
  requireNullableFinite(value.rawRmse, `${path}.rawRmse`);
  requireNullableFinite(value.adjustedRmse, `${path}.adjustedRmse`);
  requireNullableFinite(value.rawP95, `${path}.rawP95`);
  requireNullableFinite(value.adjustedP95, `${path}.adjustedP95`);
  requireNullableFinite(value.skillPercent, `${path}.skillPercent`);

  // reject physically impossible error magnitudes
  for (const key of ["rawMae", "adjustedMae", "rawRmse", "adjustedRmse", "rawP95", "adjustedP95"]) {
    if (value[key] !== null && value[key] < 0) {
      throw new RangeError(`${path}.${key} must be nonnegative`);
    }
  }

  // require a complete paired interval or explicit absence
  if (value.skillInterval95 !== null) {
    requireObject(value.skillInterval95, `${path}.skillInterval95`);
    requireKeys(value.skillInterval95, ["lower", "upper"], `${path}.skillInterval95`);
    requireFinite(value.skillInterval95.lower, `${path}.skillInterval95.lower`);
    requireFinite(value.skillInterval95.upper, `${path}.skillInterval95.upper`);

    if (value.skillInterval95.lower > value.skillInterval95.upper) {
      throw new RangeError(`${path}.skillInterval95 is reversed`);
    }
  }
}

// validate one bounded safe-code count map
function validateReasonCountMap(value, path) {
  requireObject(value, path);
  const entries = Object.entries(value);

  if (entries.length > 64) {
    throw new TypeError(`${path} is invalid`);
  }

  // prohibit prose, paths and unbounded diagnostic values
  for (const [code, count] of entries) {
    requireMatch(code, /^[a-z][a-z0-9_]{0,79}$/u, `${path} code`);
    requireCount(count, `${path}.${code}`);
  }
}

// validate one aggregate horizon or calendar slice
function validateSlice(value, path, expectedUnit) {
  requireObject(value, path);
  requireKeys(value, ["dimension", "label", "metrics", "rowCount"], path);
  requireEnum(value.dimension, SLICE_DIMENSIONS, `${path}.dimension`);
  requireMatch(value.label, SAFE_LABEL_PATTERN, `${path}.label`);
  requireCount(value.rowCount, `${path}.rowCount`);
  validateMetric(value.metrics, `${path}.metrics`, expectedUnit);
}

// validate rain-only aggregate probability and accumulation diagnostics
function validateRainDiagnostics(value, path) {
  requireObject(value, path);
  requireKeys(value, [
    "accumulations",
    "annualBalancedVolumeRatio",
    "heavyAdjustedMae",
    "heavyRawMae",
    "probabilityOrderViolationCount",
    "thresholds",
    "wetAdjustedMae",
    "wetRawMae",
    "winterBalancedVolumeRatio",
  ], path);
  requireNullableFinite(value.annualBalancedVolumeRatio, `${path}.annualBalancedVolumeRatio`);
  requireNullableFinite(value.winterBalancedVolumeRatio, `${path}.winterBalancedVolumeRatio`);
  requireNullableFinite(value.wetRawMae, `${path}.wetRawMae`);
  requireNullableFinite(value.wetAdjustedMae, `${path}.wetAdjustedMae`);
  requireNullableFinite(value.heavyRawMae, `${path}.heavyRawMae`);
  requireNullableFinite(value.heavyAdjustedMae, `${path}.heavyAdjustedMae`);

  // reject negative volumes and amount errors
  for (const key of [
    "annualBalancedVolumeRatio",
    "winterBalancedVolumeRatio",
    "wetRawMae",
    "wetAdjustedMae",
    "heavyRawMae",
    "heavyAdjustedMae",
  ]) {
    if (value[key] !== null && value[key] < 0) {
      throw new RangeError(`${path}.${key} must be nonnegative`);
    }
  }
  requireCount(value.probabilityOrderViolationCount, `${path}.probabilityOrderViolationCount`);
  requireArray(value.thresholds, 3, `${path}.thresholds`, 3);
  requireArray(value.accumulations, 3, `${path}.accumulations`, 3);
  const thresholds = [0.1, 1, 2.5];
  const hours = [6, 12, 23];

  // keep threshold order fixed for unambiguous rendering
  for (const [index, threshold] of value.thresholds.entries()) {
    validateRainThreshold(threshold, thresholds[index], `${path}.thresholds[${String(index)}]`);
  }

  // keep accumulation windows fixed to the reviewed contract
  for (const [index, accumulation] of value.accumulations.entries()) {
    validateRainAccumulation(accumulation, hours[index], `${path}.accumulations[${String(index)}]`);
  }
}

// validate one fixed rain event threshold
function validateRainThreshold(value, expectedThreshold, path) {
  requireObject(value, path);
  requireKeys(value, [
    "adjustedBrier",
    "csi",
    "falseAlarms",
    "far",
    "hits",
    "misses",
    "pod",
    "rawBrier",
    "reliability",
    "thresholdMmPerHour",
  ], path);
  requireEqual(value.thresholdMmPerHour, expectedThreshold, `${path}.thresholdMmPerHour`);
  requireNullableFinite(value.rawBrier, `${path}.rawBrier`);
  requireNullableFinite(value.adjustedBrier, `${path}.adjustedBrier`);
  requireCount(value.hits, `${path}.hits`);
  requireCount(value.misses, `${path}.misses`);
  requireCount(value.falseAlarms, `${path}.falseAlarms`);
  requireNullableFinite(value.pod, `${path}.pod`);
  requireNullableFinite(value.far, `${path}.far`);
  requireNullableFinite(value.csi, `${path}.csi`);

  // retain probabilities and probability scores in their physical range
  for (const key of ["rawBrier", "adjustedBrier", "pod", "far", "csi"]) {
    if (value[key] !== null && (value[key] < 0 || value[key] > 1)) {
      throw new RangeError(`${path}.${key} is outside 0..1`);
    }
  }
  requireArray(value.reliability, 10, `${path}.reliability`, 10);

  // preserve empty deciles rather than dropping sparse bins
  for (const [index, bin] of value.reliability.entries()) {
    requireObject(bin, `${path}.reliability[${String(index)}]`);
    requireKeys(bin, ["count", "meanProbability", "observedFrequency"], `${path}.reliability[${String(index)}]`);
    requireCount(bin.count, `${path}.reliability[${String(index)}].count`);
    requireNullableFinite(bin.meanProbability, `${path}.reliability[${String(index)}].meanProbability`);
    requireNullableFinite(bin.observedFrequency, `${path}.reliability[${String(index)}].observedFrequency`);

    // retain calibrated probabilities in their physical range
    for (const key of ["meanProbability", "observedFrequency"]) {
      if (bin[key] !== null && (bin[key] < 0 || bin[key] > 1)) {
        throw new RangeError(`${path}.reliability[${String(index)}].${key} is outside 0..1`);
      }
    }
  }
}

// validate one fixed same-run rain accumulation window
function validateRainAccumulation(value, expectedHours, path) {
  requireObject(value, path);
  requireKeys(value, ["adjustedMae", "completeWindows", "hours", "rawMae"], path);
  requireEqual(value.hours, expectedHours, `${path}.hours`);
  requireCount(value.completeWindows, `${path}.completeWindows`);
  requireNullableFinite(value.rawMae, `${path}.rawMae`);
  requireNullableFinite(value.adjustedMae, `${path}.adjustedMae`);

  // reject negative accumulation errors
  if ((value.rawMae !== null && value.rawMae < 0) ||
    (value.adjustedMae !== null && value.adjustedMae < 0)) {
    throw new RangeError(`${path} MAE must be nonnegative`);
  }
}

// reject private or reserved-member result field names at every depth
function rejectPrivateMemberFields(value, path) {
  if (value === null || typeof value !== "object") {
    return;
  }

  // recurse through arrays without accepting hidden object members
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      rejectPrivateMemberFields(entry, `${path}[${String(index)}]`);
    }
    return;
  }

  // refuse fields that can carry designated confirmation-member material
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:private|reserved.*member|member.*result)/iu.test(key)) {
      throw new TypeError(`${path}.${key} is private`);
    }
    rejectPrivateMemberFields(entry, `${path}.${key}`);
  }
}

// require one plain object
function requireObject(value, path) {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError(`${path} must be an object`);
  }
}

// reject unknown, missing or reordered-independent keys
function requireKeys(value, expected, path) {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();

  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new TypeError(`${path} has invalid keys`);
  }
}

// require one exact invariant value
function requireEqual(value, expected, path) {
  if (value !== expected) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require one bounded enum value
function requireEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require one bounded array
function requireArray(value, maximumLength, path, exactLength) {
  if (!Array.isArray(value) || value.length > maximumLength ||
    (exactLength !== undefined && value.length !== exactLength)) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require one safe string pattern
function requireMatch(value, pattern, path) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require one canonical SHA-256 value
function requireSha256(value, path) {
  requireMatch(value, SHA256_PATTERN, path);
}

// require a present or unavailable SHA-256 value
function requireNullableSha256(value, path) {
  if (value !== null) {
    requireSha256(value, path);
  }
}

// require one canonical UTC instant
function requireInstant(value, path) {
  if (typeof value !== "string" || !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${path} is invalid`);
  }
}

// require a present or unavailable UTC instant
function requireNullableInstant(value, path) {
  if (value !== null) {
    requireInstant(value, path);
  }
}

// require one JSON-safe finite aggregate
function requireNullableFinite(value, path) {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError(`${path} must be finite or null`);
  }
}

// require one finite number
function requireFinite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be finite`);
  }
}

// require one nonnegative finite aggregate
function requireNonnegativeFinite(value, path) {
  requireFinite(value, path);

  if (value < 0) {
    throw new TypeError(`${path} must be nonnegative`);
  }
}

// require one bounded aggregate count
function requireCount(value, path) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
    throw new TypeError(`${path} must be a bounded count`);
  }
}
