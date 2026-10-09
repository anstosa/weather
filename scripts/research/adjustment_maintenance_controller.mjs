import { constants as fsConstants, readFileSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ADJUSTMENT_DEFAULT_ARCHIVE_ROOT,
  buildGraphManifest,
  canonicalJsonBytes,
  createPlaintextArchive,
  adjustmentSha256,
} from "./adjustment_plaintext_archive.mjs";
import {
  ADJUSTMENT_DEFAULT_STATE_ROOT,
  createMaintenanceJournal,
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";
import { ensureAdjustmentPrivateDirectory } from "./adjustment_private_directory.mjs";
import { runAdjustmentFitWithInput } from "./adjustment_fit_inputs.mjs";
import {
  captureAdjustmentFitRuntimeReadiness,
  hashAdjustmentFitRuntimeReadiness,
} from "./adjustment_fit_sandbox.mjs";
import {
  FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES,
  validateForecastAdjustmentScorecard,
} from "../../deploy/scripts/forecast-adjustment-scorecard-contract.mjs";
import {
  validateAdjustmentConfirmationAccessBurnRequestV3,
  validateAdjustmentShadowTerminalRecordRequestV3,
  validateAdjustmentShadowTerminalRetirementRequestV3,
  validateAdjustmentShadowUnsupportedTerminalRecordRequestV1,
  validateAdjustmentShadowUnsupportedTerminalRetirementRequestV1,
  validateAdjustmentV14RollingDatabaseManifest,
} from "../../deploy/scripts/adjustment-evaluation-package.mjs";
import {
  buildAdjustmentRevisionColdGraphSegment,
  buildAdjustmentRevisionGapGraphSegment,
  validateAdjustmentDevelopmentCustodyAnchorInstallation,
  validateAdjustmentDevelopmentCustodyAnchorCurrent,
  validateAdjustmentDevelopmentCustodyAnchorV1,
  validateAdjustmentRevisionColdCustodyAcknowledgementV2,
  validateAdjustmentRevisionColdPage,
  validateAdjustmentRevisionColdTransferStart,
  validateAdjustmentRevisionGapPayloadAcknowledgement,
  validateAdjustmentRevisionGapPayloadPage,
  validateAdjustmentRevisionGapTransferStart,
  validateAdjustmentRevisionServingSnapshot,
  validateAdjustmentRainControlCustodyAnchorCurrent,
  validateAdjustmentRainControlCustodyAnchorInstallation,
  validateAdjustmentRainControlCustodyAnchorV1,
  validateAdjustmentUnsupportedTerminalProofCurrent,
  validateAdjustmentUnsupportedTerminalProofInstallation,
  validateAdjustmentUnsupportedTerminalProofV1,
  validateAdjustmentFutureOnlyInputSeal,
  validateAdjustmentFutureOnlyInputSealCurrent,
  validateAdjustmentFutureOnlyInputSealInstallation,
  validateAdjustmentMaintenanceAnchorFinalizationV3,
  validateAdjustmentMaintenanceAnchorInstallationV3,
  validateAdjustmentMaintenanceAnchorV3,
  validateAdjustmentMaintenanceAnchorCurrentV3,
  validateAdjustmentMaintenanceFinalizationProofV3,
  validateAdjustmentShadowMetadataCustodyConsumption,
  validateAdjustmentShadowMetadataCustodyStatus,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import { drainAdjustmentRevisionColdPage } from "./adjustment_revision_cold_drain.mjs";
import { createAdjustmentRevisionCustodyPack } from "./adjustment_revision_custody_pack.mjs";
import {
  restoreAdjustmentRevisionHistoricalArchive,
} from "./adjustment_historical_archive.mjs";
import {
  createAdjustmentCycleCapsuleValidator,
  measureAdjustmentArchiveBackingCapacity,
} from "./adjustment_archive_job.mjs";
import { ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION } from "./adjustment_cycle_pages.mjs";
import {
  buildAdjustmentRainControlReferenceAction,
  buildAdjustmentMaintenanceRawRegistry,
  buildAdjustmentMaintenanceServingRegistry,
  buildAdjustmentModelAction,
  createProductionAdjustmentModelReleasePorts,
  publishAdjustmentModelReleasePair,
  publishAdjustmentRainControlReferenceReleasePair,
} from "./adjustment_model_release.mjs";
import { buildPortableRainModelPackage } from "./adjustment_rain_model_package.mjs";
import {
  buildForecastAdjustmentMaintenancePortableCandidate,
  evaluateForecastAdjustmentMaintenanceNativeCandidate,
  evaluateForecastAdjustmentMaintenancePackagedCandidate,
  evaluateForecastAdjustmentMaintenancePolicy,
  buildForecastAdjustmentMaintenanceFitParityInputs,
  loadForecastAdjustmentMaintenanceIncumbent,
  parseRainMaintenanceControlState,
  validateRainMaintenanceControlArtifact,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  buildAdjustmentHistoricalFitProjection,
} from "./adjustment_historical_fit_assembler.mjs";
import {
  buildAdjustmentMonthlyFitAssembly,
} from "./adjustment_monthly_projection.mjs";
import {
  buildAdjustmentRainMonthlyFitAssembly,
} from "./adjustment_rain_monthly_projection.mjs";
import {
  ADJUSTMENT_MAINTENANCE_CANDIDATE_REPORT_VERSION,
  ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION,
  ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V2_VERSION,
  ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION,
  buildAdjustmentMaintenanceExpectedKeyPlanV3,
  evaluateAdjustmentMaintenanceDaily,
} from "./adjustment_daily_evaluation.mjs";
import {
  ADJUSTMENT_MAINTENANCE_CONFIRMATION_TERMINAL_GRAPH_VERSION,
  ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION,
  ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_GRAPH_VERSION,
  assembleAdjustmentMaintenanceDailyConfirmation,
  assembleAdjustmentMaintenanceUnsupportedDailyConfirmation,
  planAdjustmentMaintenanceDailyConfirmation,
  planAdjustmentMaintenanceUnsupportedDailyConfirmation,
  parseAdjustmentMaintenanceDerivedTarget,
  validateAdjustmentMaintenanceConfirmationPlanGraph,
  validateAdjustmentMaintenanceUnsupportedPlanGraph,
} from "./adjustment_confirmation_values.mjs";
import {
  assembleAdjustmentRainDailyConfirmation,
  assembleAdjustmentRainUnsupportedDailyConfirmation,
} from "./adjustment_rain_confirmation_values.mjs";
import {
  ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
  adjustmentRollingLocalDateAt,
  buildAdjustmentRollingScheduleBootstrap,
  buildAdjustmentRollingWindow,
} from "./adjustment_rolling_schedule.mjs";
import {
  RAIN_MAINTENANCE_POLICY_VERSION,
  TEMPERATURE_MAINTENANCE_POLICY_VERSION,
  WIND_MAINTENANCE_POLICY_VERSION,
} from "./adjustment-maintenance-runtime/forecast/maintenance-policy.js";

export const ADJUSTMENT_MAINTENANCE_ATTEMPT_CONTRACT_VERSION =
  "forecast-adjustment-maintenance-attempt/v2";
export const ADJUSTMENT_MAINTENANCE_TIME_ZONE = "America/Los_Angeles";
export const ADJUSTMENT_MAINTENANCE_UNSUPPORTED_POLICY_REPORT_VERSION =
  "adjustment-maintenance-unsupported-policy-report/v1";
export const ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_PROOF_VERSION =
  "adjustment-maintenance-unsupported-terminal-proof/v1";
export const ADJUSTMENT_MAINTENANCE_REQUIRED_ADAPTERS = Object.freeze([
  "daily_evaluation/v1",
  "future_only_input_seal/v2",
  "historical_fit_assembler/v2",
  "incumbent_comparator/v1",
  "registration_schedule/v3",
  "revision_custody_pack/v1",
  "semantic_cold_catalog/v1",
  "scorecard_publication/v2",
]);

const ATTEMPT_MAXIMUM_BYTES = 128 * 1_024;
const DAILY_LIMIT = 7;
const FAMILIES = Object.freeze(["temperature", "wind", "rain"]);
// bind registrations to the exact installed policy module bytes
const REGISTRATION_POLICY_MODULE_BYTES = readFileSync(new URL(
  "./adjustment-maintenance-runtime/forecast/maintenance-policy.js",
  import.meta.url,
));
const REGISTRATION_POLICY_VERSIONS = Object.freeze(new Map([
  ["temperature", TEMPERATURE_MAINTENANCE_POLICY_VERSION],
  ["wind", WIND_MAINTENANCE_POLICY_VERSION],
  ["rain", RAIN_MAINTENANCE_POLICY_VERSION],
]));
const CONFIRMATION_CANDIDATE_KINDS = Object.freeze(new Map([
  ["temperature", "temperature-delayed-mos/v1"],
  ["wind", "wind-robust-hierarchical-median/v1"],
  ["rain", "rain-hurdle-wind-occurrence-amount/v1"],
]));
const FUTURE_INPUT_CLASS_NAMES = Object.freeze([
  "actual_best_match", "artifact", "candidate", "comparator", "native_source",
  "rain_gate_input", "shadow_body", "shadow_source", "target", "target_revision",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DUE_KEY_PATTERN = /^(?:daily\/\d{4}-\d{2}-\d{2}|monthly\/(?:temperature|wind|rain)\/\d{4}-\d{2}|control-reference\/rain\/\d{4}-\d{2})$/u;
const SAFE_REASON_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const CONTROLLER_LOCK_PATH = join(ADJUSTMENT_DEFAULT_STATE_ROOT, "maintenance-controller.lock");
const CONTROLLER_SSH_CONFIG = resolve(
  import.meta.dirname,
  "../..",
  "deploy/config/ssh_config.example",
);
const CONTROLLER_REMOTE_HOST = "weather-pi";
const SCORECARD_PUBLICATION_OUTPUT_MAXIMUM_BYTES = 16 * 1_024;
const FAMILY_RELEASE_OUTPUT_MAXIMUM_BYTES = 16 * 1_024;
const REVISION_CATALOG_OUTPUT_MAXIMUM_BYTES = 4_832 * 1_024 + 1;
const ARCHIVE_SEGMENT_MAXIMUM_MEMBERS = 13_000;
const ARCHIVE_SEGMENT_MAXIMUM_CROSS_LINKS = 40_000;
const TERMINAL_GRAPH_PART_MAXIMUM_BINDINGS = 4_096;
const TERMINAL_GRAPH_PART_MAXIMUM_BYTES = 8 * 1_024 * 1_024;
const ATTEMPT_STATES = new Set(["blocked", "completed", "failed"]);
const ATTEMPT_REASONS = new Set([
  "candidate_archive_unavailable",
  "candidate_parity_failed",
  "control_reference_archived",
  "daily_candidate_promoted",
  "daily_candidate_rejected",
  "daily_evaluation_failed",
  "daily_history_pending",
  "daily_no_registered_candidate",
  "daily_promotion_pending",
  "daily_support_failed",
  "dependency_failed",
  "development_candidate_archived",
  "fit_failed",
  "family_slot_busy",
  "history_unavailable",
  "monthly_no_candidate",
  "registration_schedule_unavailable",
  "semantic_catalog_unavailable",
  "semantic_input_blocked",
]);

// build one public rolling registration and its archived schedule plan
export function buildAdjustmentRollingShadowRegistration(input) {
  requireExactKeys(input, [
    "artifactSha256", "candidateSha256", "cohortSha256", "epochAt",
    "epochWitnessSha256", "family", "fitMonth", "policySha256",
    "predecessorRegistrationSha256", "predecessorTerminalAt", "requestedAt",
    "reservedKeySha256", "sourceSha256",
  ], "rolling registration input");
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily family at a registration boundary
  if (input.family === null) {
    throw new TypeError("rolling registration family is invalid");
  }
  for (const name of [
    "artifactSha256", "candidateSha256", "cohortSha256", "epochWitnessSha256",
    "policySha256", "reservedKeySha256", "sourceSha256",
  ]) {
    requireSha256(input[name], name);
  }
  requireNullableSha256(input.predecessorRegistrationSha256,
    "predecessorRegistrationSha256");
  const plan = buildAdjustmentRollingWindow({
    epochAt: input.epochAt,
    epochWitnessSha256: input.epochWitnessSha256,
    family: input.family,
    fitMonth: input.fitMonth,
    predecessorTerminalAt: input.predecessorTerminalAt,
    requestedAt: input.requestedAt,
  });
  const registration = {
    artifactSha256: input.artifactSha256,
    candidateSha256: input.candidateSha256,
    cohortSha256: input.cohortSha256,
    epochWitnessSha256: input.epochWitnessSha256,
    family: input.family,
    intervalEndAt: plan.intervalEndAt,
    intervalStartAt: plan.intervalStartAt,
    policySha256: input.policySha256,
    predecessorRegistrationSha256: input.predecessorRegistrationSha256,
    registrationSha256: "",
    reservedKeySha256: input.reservedKeySha256,
    scheduleContractSha256: ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
    siteKey: "ballydidean",
    sourceSha256: input.sourceSha256,
    targetCutoffAt: plan.targetCutoffAt,
    terminalAt: plan.terminalAt,
  };
  registration.registrationSha256 = adjustmentSha256(Buffer.from(`${[
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
    registration.predecessorRegistrationSha256 ?? "none",
    registration.intervalStartAt,
    registration.intervalEndAt,
    registration.targetCutoffAt,
    registration.terminalAt,
  ].join("\n")}\n`, "utf8"));
  return Object.freeze({ plan, registration: Object.freeze(registration) });
}

// build the archived exact policy identity for one registration
export function buildAdjustmentRegistrationPolicyDescriptor(input) {
  requireExactKeys(input, ["family"], "registration policy descriptor input");
  requireFamilyOrNull(input.family);

  // prohibit a nullable family at the registration boundary
  if (input.family === null) {
    throw new TypeError("registration policy family is invalid");
  }
  const descriptor = {
    contractVersion: "adjustment-registration-policy/v3",
    family: input.family,
    policyModuleSha256: adjustmentSha256(REGISTRATION_POLICY_MODULE_BYTES),
    policyVersion: REGISTRATION_POLICY_VERSIONS.get(input.family),
    scheduleContractSha256: ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
  };
  const bytes = canonicalJsonBytes(descriptor);
  return Object.freeze({
    bytes,
    descriptor: Object.freeze(descriptor),
    policySha256: adjustmentSha256(bytes),
  });
}

// validate one exact installed registration policy descriptor
export function validateAdjustmentRegistrationPolicyDescriptor(value) {
  requireExactKeys(value, [
    "contractVersion", "family", "policyModuleSha256", "policyVersion",
    "scheduleContractSha256",
  ], "registration policy descriptor");
  const expected = buildAdjustmentRegistrationPolicyDescriptor({ family: value.family });

  // refuse an alternate module, version or schedule identity
  if (!canonicalJsonBytes(value).equals(expected.bytes)) {
    throw new TypeError("registration policy descriptor differs");
  }
  return Object.freeze(structuredClone(value));
}

// build one archive-derived fit cohort identity
export function buildAdjustmentRegistrationCohortDescriptor(input) {
  requireExactKeys(input, [
    "cutoffAt", "dueMonth", "epochWitnessSha256", "family",
    "historicalMemberRootSha256", "inputManifestSha256",
  ], "registration cohort descriptor input");
  requireFamilyOrNull(input.family);

  // prohibit daily and malformed monthly cohort identities
  if (input.family === null || typeof input.dueMonth !== "string" ||
    !/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(input.dueMonth)) {
    throw new TypeError("registration cohort family or month is invalid");
  }
  requireInstant(input.cutoffAt, "cutoffAt");
  requireSha256(input.epochWitnessSha256, "epochWitnessSha256");
  requireSha256(input.historicalMemberRootSha256, "historicalMemberRootSha256");
  requireSha256(input.inputManifestSha256, "inputManifestSha256");
  const descriptor = {
    contractVersion: "adjustment-registration-cohort/v3",
    cutoffAt: input.cutoffAt,
    dueMonth: input.dueMonth,
    epochWitnessSha256: input.epochWitnessSha256,
    family: input.family,
    historicalMemberRootSha256: input.historicalMemberRootSha256,
    inputManifestSha256: input.inputManifestSha256,
  };
  const bytes = canonicalJsonBytes(descriptor);
  return Object.freeze({
    bytes,
    cohortSha256: adjustmentSha256(bytes),
    descriptor: Object.freeze(descriptor),
  });
}

// validate one exact archive-derived registration cohort descriptor
export function validateAdjustmentRegistrationCohortDescriptor(value) {
  requireExactKeys(value, [
    "contractVersion", "cutoffAt", "dueMonth", "epochWitnessSha256", "family",
    "historicalMemberRootSha256", "inputManifestSha256",
  ], "registration cohort descriptor");
  const expected = buildAdjustmentRegistrationCohortDescriptor({
    cutoffAt: value.cutoffAt,
    dueMonth: value.dueMonth,
    epochWitnessSha256: value.epochWitnessSha256,
    family: value.family,
    historicalMemberRootSha256: value.historicalMemberRootSha256,
    inputManifestSha256: value.inputManifestSha256,
  });

  // refuse extension fields or alternate canonical identities
  if (!canonicalJsonBytes(value).equals(expected.bytes)) {
    throw new TypeError("registration cohort descriptor differs");
  }
  return Object.freeze(structuredClone(value));
}

// compact one independently reproducible all-cycle expected-key plan
export function buildAdjustmentRegistrationExpectedKeyPlan(input) {
  requireExactKeys(input, ["family", "intervalEndAt", "intervalStartAt"],
    "registration expected key plan input");
  const plan = buildAdjustmentMaintenanceExpectedKeyPlanV3(input);
  const logicalChunks = plan.logicalChunks.map(
    // retain roots and scheduler coordinates without duplicating every key
    (logical) => Object.freeze({
      expectedKeyCount: logical.expectedKeyCount,
      expectedKeySubsetSha256: logical.expectedKeySubsetSha256,
      fromLocalDate: logical.fromLocalDate,
      logicalChunkIndex: logical.logicalChunkIndex,
      partCount: logical.partCount,
      parts: Object.freeze(logical.parts.map(
        // bind each fixed-cycle capture-date subset
        (part) => Object.freeze({
          captureLocalDate: part.captureLocalDate,
          expectedKeyCount: part.expectedKeyCount,
          expectedKeySubsetSha256: part.expectedKeySubsetSha256,
          partCount: part.partCount,
          partIndex: part.partIndex,
        }),
      )),
      toLocalDateExclusive: logical.toLocalDateExclusive,
    }),
  );
  const descriptor = {
    contractVersion: "adjustment-registration-expected-key-plan/v3",
    family: plan.family,
    intervalEndAt: plan.intervalEndAt,
    intervalStartAt: plan.intervalStartAt,
    logicalChunkCount: plan.logicalChunkCount,
    logicalChunks: Object.freeze(logicalChunks),
    reservedKeySha256: plan.reservedKeySha256,
  };
  const bytes = canonicalJsonBytes(descriptor);
  return Object.freeze({
    bytes,
    descriptor: Object.freeze(descriptor),
    expectedPlanSha256: adjustmentSha256(bytes),
    reservedKeySha256: plan.reservedKeySha256,
  });
}

// validate a compact plan by independently enumerating all fixed cycles
export function validateAdjustmentRegistrationExpectedKeyPlan(value) {
  requireExactKeys(value, [
    "contractVersion", "family", "intervalEndAt", "intervalStartAt", "logicalChunkCount",
    "logicalChunks", "reservedKeySha256",
  ], "registration expected key plan");
  const expected = buildAdjustmentRegistrationExpectedKeyPlan({
    family: value.family,
    intervalEndAt: value.intervalEndAt,
    intervalStartAt: value.intervalStartAt,
  });

  // recompute every root and scheduler coordinate from the reviewed cadence
  if (!canonicalJsonBytes(value).equals(expected.bytes)) {
    throw new TypeError("registration expected key plan differs");
  }
  return Object.freeze(structuredClone(value));
}

// assemble every immutable post-fit registration identity before archival
export function buildAdjustmentPostFitRegistrationMaterial(input) {
  requireExactKeys(input, [
    "artifactSha256", "candidateSha256", "cutoffAt", "dueMonth", "epochWitness",
    "family", "historicalMemberRootSha256", "inputManifestSha256",
    "predecessorRegistrationSha256", "predecessorTerminalAt", "requestedAt",
    "sourceIdentitySha256",
  ], "post-fit registration material input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requireFamilyOrNull(input.family);

  // prohibit daily registration and malformed fit months
  if (input.family === null || typeof input.dueMonth !== "string" ||
    !/^20\d{2}-(?:0[1-9]|1[0-2])$/u.test(input.dueMonth)) {
    throw new TypeError("post-fit registration family or month is invalid");
  }
  requireInstant(input.cutoffAt, "cutoffAt");
  requireInstant(input.requestedAt, "requestedAt");
  // validate every independent post-fit identity
  for (const field of [
    "artifactSha256", "candidateSha256", "historicalMemberRootSha256",
    "inputManifestSha256", "sourceIdentitySha256",
  ]) {
    requireSha256(input[field], field);
  }
  requireNullableSha256(input.predecessorRegistrationSha256,
    "predecessorRegistrationSha256");
  const schedulePlan = buildAdjustmentRollingWindow({
    epochAt: witness.epochAt,
    epochWitnessSha256: witness.witnessSha256,
    family: input.family,
    fitMonth: input.dueMonth,
    predecessorTerminalAt: input.predecessorTerminalAt,
    requestedAt: input.requestedAt,
  });
  const expectedPlan = buildAdjustmentRegistrationExpectedKeyPlan({
    family: input.family,
    intervalEndAt: schedulePlan.intervalEndAt,
    intervalStartAt: schedulePlan.intervalStartAt,
  });
  const policy = buildAdjustmentRegistrationPolicyDescriptor({ family: input.family });
  const cohort = buildAdjustmentRegistrationCohortDescriptor({
    cutoffAt: input.cutoffAt,
    dueMonth: input.dueMonth,
    epochWitnessSha256: witness.witnessSha256,
    family: input.family,
    historicalMemberRootSha256: input.historicalMemberRootSha256,
    inputManifestSha256: input.inputManifestSha256,
  });
  const source = buildAdjustmentFutureOnlySourceLineage({
    epochWitness: witness,
    family: input.family,
    sourceIdentitySha256: input.sourceIdentitySha256,
  });
  const rolling = buildAdjustmentRollingShadowRegistration({
    artifactSha256: input.artifactSha256,
    candidateSha256: input.candidateSha256,
    cohortSha256: cohort.cohortSha256,
    epochAt: witness.epochAt,
    epochWitnessSha256: witness.witnessSha256,
    family: input.family,
    fitMonth: input.dueMonth,
    policySha256: policy.policySha256,
    predecessorRegistrationSha256: input.predecessorRegistrationSha256,
    predecessorTerminalAt: input.predecessorTerminalAt,
    requestedAt: input.requestedAt,
    reservedKeySha256: expectedPlan.reservedKeySha256,
    sourceSha256: source.sourceSha256,
  });

  // require both schedule derivations to remain byte-identical
  if (!canonicalJsonBytes(schedulePlan).equals(canonicalJsonBytes(rolling.plan))) {
    throw new Error("post-fit registration schedule plan differs");
  }
  return Object.freeze({
    cohort,
    confirmation: Object.freeze({
      candidateKind: CONFIRMATION_CANDIDATE_KINDS.get(input.family),
      candidateSha256: input.candidateSha256,
      cohortLineageSha256: cohort.cohortSha256,
      family: input.family,
      firstTargetAt: rolling.registration.intervalStartAt,
      gateManifestSha256: policy.policySha256,
      intervalEndExclusiveLocalDate:
        adjustmentRollingLocalDateAt(rolling.registration.intervalEndAt),
      intervalStartLocalDate:
        adjustmentRollingLocalDateAt(rolling.registration.intervalStartAt),
      reservedKeySha256: expectedPlan.reservedKeySha256,
      sourceLineageSha256: source.sourceSha256,
      terminalAccessAt: rolling.registration.terminalAt,
    }),
    expectedPlan,
    policy,
    schedulePlan,
    shadowRegistration: rolling.registration,
    source,
  });
}

// build one nonmutating terminal identity and its completed receipt
export function buildAdjustmentTerminalNoActionReceipt(input) {
  requireExactKeys(input, [
    "completedAt", "disposition", "finalizedAt", "fullMemberRootSha256",
    "policyReportSha256", "registrationSha256",
  ], "terminal no-action receipt input");
  requireInstant(input.completedAt, "completedAt");
  requireInstant(input.finalizedAt, "finalizedAt");
  requireSha256(input.fullMemberRootSha256, "fullMemberRootSha256");
  requireSha256(input.policyReportSha256, "policyReportSha256");
  requireSha256(input.registrationSha256, "registrationSha256");

  // admit only terminal nonmutating outcomes after actual finalization
  if (!new Set(["rejected", "resource_refused", "support_failed"])
    .has(input.disposition) || Date.parse(input.completedAt) < Date.parse(input.finalizedAt)) {
    throw new TypeError("terminal no-action receipt disposition or clock is invalid");
  }
  const identity = {
    contractVersion: "adjustment-terminal-no-action-identity/v3",
    disposition: input.disposition,
    policyReportSha256: input.policyReportSha256,
    registrationSha256: input.registrationSha256,
  };
  const identityBytes = canonicalJsonBytes(identity);
  const receipt = {
    actionSha256: adjustmentSha256(identityBytes),
    completedAt: input.completedAt,
    contractVersion: "adjustment-terminal-no-action-receipt/v3",
    disposition: input.disposition,
    fullMemberRootSha256: input.fullMemberRootSha256,
    policyReportSha256: input.policyReportSha256,
    registrationSha256: input.registrationSha256,
    state: "verified_no_action",
  };
  return Object.freeze({
    identity: Object.freeze(identity),
    identityBytes,
    receipt: Object.freeze(receipt),
    receiptBytes: canonicalJsonBytes(receipt),
  });
}

// validate one completed nonmutating terminal receipt independently
export function validateAdjustmentTerminalNoActionReceipt(value) {
  requireExactKeys(value, [
    "actionSha256", "completedAt", "contractVersion", "disposition",
    "fullMemberRootSha256", "policyReportSha256", "registrationSha256", "state",
  ], "terminal no-action receipt");
  const rebuilt = buildAdjustmentTerminalNoActionReceipt({
    completedAt: value.completedAt,
    disposition: value.disposition,
    finalizedAt: value.completedAt,
    fullMemberRootSha256: value.fullMemberRootSha256,
    policyReportSha256: value.policyReportSha256,
    registrationSha256: value.registrationSha256,
  });

  // require the exact frozen literals and independently derived identity
  if (value.contractVersion !== rebuilt.receipt.contractVersion ||
    value.state !== rebuilt.receipt.state ||
    !canonicalJsonBytes(value).equals(rebuilt.receiptBytes)) {
    throw new TypeError("terminal no-action receipt differs");
  }
  return Object.freeze(structuredClone(value));
}

// execute only the package-owned closed promotion or regression policy
export function evaluateAdjustmentMaintenanceControllerPolicy(input) {
  requireExactKeys(input, ["epoch", "family", "kind", "rows"],
    "controller policy input");
  return evaluateForecastAdjustmentMaintenancePolicy(input);
}

// bind a family source identity to the one authenticated future-only epoch
export function buildAdjustmentFutureOnlySourceLineage(input) {
  requireExactKeys(input, ["epochWitness", "family", "sourceIdentitySha256"],
    "future-only source lineage");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily projection at a family registration boundary
  if (input.family === null) {
    throw new TypeError("future-only source lineage family is invalid");
  }
  requireSha256(input.sourceIdentitySha256, "sourceIdentitySha256");
  const descriptor = {
    contractVersion: "forecast-adjustment-future-only-source-lineage/v1",
    epochWitnessSha256: witness.witnessSha256,
    family: input.family,
    sourceIdentitySha256: input.sourceIdentitySha256,
  };
  const bytes = canonicalJsonBytes(descriptor);
  return Object.freeze({
    bytes,
    descriptor: Object.freeze(descriptor),
    sourceSha256: adjustmentSha256(bytes),
  });
}

// prove a candidate through two execution paths on synthetic and retained inputs
export function buildAdjustmentMaintenanceCandidateParity(input) {
  requireExactKeys(input, ["candidateBytes", "family", "retainedInput", "syntheticInput"],
    "candidate parity input");
  requireFamilyOrNull(input.family);

  // prohibit the daily null-family projection at this candidate boundary
  if (input.family === null || !Buffer.isBuffer(input.candidateBytes)) {
    throw new TypeError("candidate parity family or bytes are invalid");
  }
  const portable = buildForecastAdjustmentMaintenancePortableCandidate({
    candidateBytes: input.candidateBytes,
    family: input.family,
  });
  // execute one input independently through raw-fit and packaged evaluators
  const evaluate = (parityInput) => {
    const nativeOutput = evaluateForecastAdjustmentMaintenanceNativeCandidate({
      candidateBytes: input.candidateBytes,
      family: input.family,
      input: parityInput,
    });
    const packagedOutput = evaluateForecastAdjustmentMaintenancePackagedCandidate({
      artifactBytes: portable.artifactBytes,
      family: input.family,
      input: parityInput,
    });

    // reject hash-only or same-function parity claims
    if (!nativeOutput.equals(packagedOutput)) {
      throw new Error("candidate runtime parity failed");
    }
    return { nativeOutput, packagedOutput };
  };
  const synthetic = evaluate(input.syntheticInput);
  const retained = evaluate(input.retainedInput);
  return Object.freeze({
    parity: Object.freeze({
      retainedInput: canonicalJsonBytes(input.retainedInput),
      retainedNativeOutput: retained.nativeOutput,
      retainedPackagedOutput: retained.packagedOutput,
      syntheticInput: canonicalJsonBytes(input.syntheticInput),
      syntheticNativeOutput: synthetic.nativeOutput,
      syntheticPackagedOutput: synthetic.packagedOutput,
    }),
    portable,
  });
}

// reduce exact parity byte streams to one public immutable receipt
export function buildAdjustmentMaintenanceParityReceipt(input) {
  requireExactKeys(input, ["candidateSha256", "family", "parity"],
    "candidate parity receipt input");
  requireSha256(input.candidateSha256, "candidateSha256");
  requireFamilyOrNull(input.family);

  // prohibit a nullable family and caller-shaped parity field set
  if (input.family === null) {
    throw new TypeError("candidate parity receipt family is invalid");
  }
  requireExactKeys(input.parity, [
    "retainedInput", "retainedNativeOutput", "retainedPackagedOutput",
    "syntheticInput", "syntheticNativeOutput", "syntheticPackagedOutput",
  ], "candidate parity evidence");
  const fixture = {
    candidateSha256: input.candidateSha256,
    contractVersion: "forecast-adjustment-model-parity/v1",
    family: input.family,
    retainedInputSha256: adjustmentSha256(requireBuffer(input.parity.retainedInput,
      "retainedInput")),
    retainedNativeOutputSha256: adjustmentSha256(requireBuffer(
      input.parity.retainedNativeOutput, "retainedNativeOutput")),
    retainedPackagedOutputSha256: adjustmentSha256(requireBuffer(
      input.parity.retainedPackagedOutput, "retainedPackagedOutput")),
    syntheticInputSha256: adjustmentSha256(requireBuffer(input.parity.syntheticInput,
      "syntheticInput")),
    syntheticNativeOutputSha256: adjustmentSha256(requireBuffer(
      input.parity.syntheticNativeOutput, "syntheticNativeOutput")),
    syntheticPackagedOutputSha256: adjustmentSha256(requireBuffer(
      input.parity.syntheticPackagedOutput, "syntheticPackagedOutput")),
  };

  // independently require equality before publishing the corresponding hashes
  if (!input.parity.retainedNativeOutput.equals(input.parity.retainedPackagedOutput) ||
    !input.parity.syntheticNativeOutput.equals(input.parity.syntheticPackagedOutput)) {
    throw new Error("candidate parity receipt outputs differ");
  }
  const bytes = canonicalJsonBytes(fixture);
  return Object.freeze({
    bytes,
    fixture: Object.freeze(fixture),
    paritySha256: adjustmentSha256(bytes),
  });
}

// require a genuine post-epoch committed server revision receipt
export function validateAdjustmentFutureOnlyRevisionReceipt(input) {
  requireExactKeys(input, ["epochWitness", "receipt"], "future-only revision receipt");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requirePlainObject(input.receipt, "future-only revision receipt");
  requireInstant(input.receipt.archiveCommittedAt, "archiveCommittedAt");

  // exclude the epoch snapshot and every pre-epoch or zero-ordinal value
  if (typeof input.receipt.archiveCommitOrdinal !== "string" ||
    !/^[1-9]\d{0,19}$/u.test(input.receipt.archiveCommitOrdinal) ||
    BigInt(input.receipt.archiveCommitOrdinal) > 0xffff_ffff_ffff_ffffn ||
    Date.parse(input.receipt.archiveCommittedAt) < Date.parse(witness.epochAt)) {
    throw new TypeError("future-only revision receipt predates its epoch");
  }
  return input.receipt;
}

// require every family-specific causal clock to originate after the epoch
export function validateAdjustmentFutureOnlyCausalInstants(input) {
  requireExactKeys(input, ["epochWitness", "instants"], "future-only causal clocks");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);

  // callers must provide at least one complete family-specific clock set
  if (!Array.isArray(input.instants) || input.instants.length < 1 ||
    input.instants.length > 8_192) {
    throw new TypeError("future-only causal clocks are invalid");
  }
  for (const instant of input.instants) {
    requireInstant(instant, "future-only causal instant");

    // a post-epoch receipt cannot launder an older run, target, or causal row
    if (Date.parse(instant) < Date.parse(witness.epochAt)) {
      throw new TypeError("future-only causal clock predates its epoch");
    }
  }
  return Object.freeze([...input.instants]);
}

// build the actual epoch witness and three family lineage graph members
export function buildAdjustmentFutureOnlyGenesisGraphSegment(input) {
  requireExactKeys(input, ["servingSnapshot", "witness"],
    "future-only genesis graph input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.witness);
  const servingSnapshot = validateAdjustmentRevisionServingSnapshot(input.servingSnapshot);

  // require the retained database zero-frontier member sealed by this witness
  if (servingSnapshot.snapshotSha256 !== witness.servingSnapshotSha256 ||
    servingSnapshot.cutoffAt !== witness.epochAt ||
    servingSnapshot.archiveCommitOrdinal !== "0" ||
    servingSnapshot.frontierSha256 !== witness.catalogFrontierSha256) {
    throw new TypeError("future-only zero-frontier snapshot differs");
  }
  const members = [{
    identitySha256: witness.witnessSha256,
    kind: witness.contractVersion,
    payload: canonicalJsonBytes(witness),
  }, {
    identitySha256: servingSnapshot.snapshotSha256,
    kind: servingSnapshot.contractVersion,
    payload: canonicalJsonBytes(servingSnapshot),
  }];
  return Object.freeze({
    crossLinks: Object.freeze([{
    fromIdentitySha256: witness.witnessSha256,
    relation: "binds_zero_frontier_snapshot",
    toIdentitySha256: servingSnapshot.snapshotSha256,
    }]),
    members: Object.freeze(members),
  });
}

// bind one candidate-derived family source to the archived epoch member
export function buildAdjustmentFutureOnlySourceLineageGraphSegment(input) {
  const lineage = buildAdjustmentFutureOnlySourceLineage(input);
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  return Object.freeze({
    crossLinks: Object.freeze([{
      fromIdentitySha256: lineage.sourceSha256,
      relation: "binds_capture_epoch",
      toIdentitySha256: witness.witnessSha256,
    }]),
    members: Object.freeze([{
      identitySha256: witness.witnessSha256,
      kind: witness.contractVersion,
      payload: canonicalJsonBytes(witness),
    }, {
      identitySha256: lineage.sourceSha256,
      kind: lineage.descriptor.contractVersion,
      payload: lineage.bytes,
    }]),
  });
}

// build one closed shadow graph before installing development-only authority
export function buildAdjustmentDevelopmentCustodyGraphSegment(input) {
  requireExactKeys(input, [
    "action", "artifactBytes", "candidateBytes", "candidateGraphSha256",
    "registration", "reportBytes",
  ], "development custody graph input");
  const action = buildAdjustmentModelAction(input.action);
  const candidateBytes = requireBuffer(input.candidateBytes, "candidateBytes");
  const artifactBytes = requireBuffer(input.artifactBytes, "artifactBytes");
  const reportBytes = requireBuffer(input.reportBytes, "reportBytes");
  requireSha256(input.candidateGraphSha256, "candidateGraphSha256");
  const registration = validateRollingShadowRegistration(input.registration);
  const report = validateCanonicalDocument(
    reportBytes,
    ADJUSTMENT_MAINTENANCE_ATTEMPT_CONTRACT_VERSION,
    validateAdjustmentMaintenanceAttempt,
  );
  const artifact = validateCanonicalDocument(
    artifactBytes,
    JSON.parse(artifactBytes.toString("utf8")).contractVersion,
  );

  // crossbind the public release identities before archiving any authority graph
  if (action.action.actionKind !== "shadow" ||
    action.action.candidateGraphSha256 !== input.candidateGraphSha256 ||
    action.action.candidateSha256 !== registration.candidateSha256 ||
    action.action.family !== registration.family ||
    action.action.policyReportSha256 !== adjustmentSha256(reportBytes) ||
    report.candidateGraphSha256 !== input.candidateGraphSha256 ||
    report.candidateSha256 !== registration.candidateSha256 ||
    report.family !== registration.family || report.mode !== "monthly" ||
    (registration.artifactSha256 !== artifact.bundleSha256 &&
      registration.artifactSha256 !== adjustmentSha256(artifactBytes)) ||
    adjustmentSha256(candidateBytes) !== registration.candidateSha256) {
    throw new TypeError("development custody graph identities differ");
  }
  const graphReference = {
    contractVersion: "adjustment-archive-graph-reference/v1",
    graphSha256: input.candidateGraphSha256,
  };
  const graphReferenceBytes = canonicalJsonBytes(graphReference);
  const graphReferenceSha256 = adjustmentSha256(graphReferenceBytes);
  const registrationBytes = canonicalJsonBytes(registration);
  const binding = {
    actionSha256: action.actionSha256,
    artifactSha256: registration.artifactSha256,
    candidateGraphSha256: input.candidateGraphSha256,
    candidateSha256: registration.candidateSha256,
    contractVersion: "adjustment-development-custody-graph/v1",
    policyReportSha256: adjustmentSha256(reportBytes),
    registrationSha256: registration.registrationSha256,
    sourceSha256: registration.sourceSha256,
  };
  const bindingBytes = canonicalJsonBytes(binding);
  const bindingSha256 = adjustmentSha256(bindingBytes);
  return Object.freeze({
    binding: Object.freeze(binding),
    bindingSha256,
    segment: Object.freeze({
      crossLinks: Object.freeze([{
        fromIdentitySha256: bindingSha256,
        relation: "binds_public_action",
        toIdentitySha256: action.actionSha256,
      }, {
        fromIdentitySha256: bindingSha256,
        relation: "binds_shadow_registration",
        toIdentitySha256: registration.registrationSha256,
      }, {
        fromIdentitySha256: bindingSha256,
        relation: "binds_candidate_graph",
        toIdentitySha256: graphReferenceSha256,
      }, {
        fromIdentitySha256: action.actionSha256,
        relation: "binds_candidate",
        toIdentitySha256: registration.candidateSha256,
      }, {
        fromIdentitySha256: action.actionSha256,
        relation: "binds_policy_report",
        toIdentitySha256: binding.policyReportSha256,
      }, {
        fromIdentitySha256: registration.registrationSha256,
        relation: "binds_portable_artifact",
        toIdentitySha256: registration.artifactSha256,
      }]),
      members: Object.freeze([{
        identitySha256: bindingSha256,
        kind: binding.contractVersion,
        payload: bindingBytes,
      }, {
        identitySha256: action.actionSha256,
        kind: action.action.contractVersion,
        payload: action.bytes,
      }, {
        identitySha256: registration.registrationSha256,
        kind: "adjustment-shadow-registration/v3",
        payload: registrationBytes,
      }, {
        identitySha256: graphReferenceSha256,
        kind: graphReference.contractVersion,
        payload: graphReferenceBytes,
      }, {
        identitySha256: registration.candidateSha256,
        kind: developmentCandidateKind(registration.family),
        payload: candidateBytes,
      }, {
        identitySha256: registration.artifactSha256,
        kind: artifact.contractVersion,
        payload: artifactBytes,
      }, {
        identitySha256: binding.policyReportSha256,
        kind: report.contractVersion,
        payload: reportBytes,
      }]),
    }),
  });
}

// build one value-blind confirmation plan graph and its retained cold-graph references
export function buildAdjustmentConfirmationPlanGraphSegment(input) {
  requireExactKeys(input, ["planGraph"], "confirmation plan graph segment input");
  const planGraph = validateAdjustmentControllerPlanGraph(input.planGraph);
  const planGraphBytes = canonicalJsonBytes(planGraph);
  const references = [...new Set(planGraph.entries.map(
    // retain one immutable reference per verified cold graph
    (entry) => entry.graphManifestSha256,
  ))].sort().map((graphSha256) => {
    const document = {
      contractVersion: "adjustment-archive-graph-reference/v1",
      graphSha256,
    };
    const bytes = canonicalJsonBytes(document);
    return Object.freeze({
      bytes,
      identitySha256: adjustmentSha256(bytes),
      kind: document.contractVersion,
    });
  });
  return Object.freeze({
    crossLinks: Object.freeze(references.map(
      // bind the blinded population to every source graph without copying value bytes
      (reference) => ({
        fromIdentitySha256: planGraph.planGraphSha256,
        relation: "binds_confirmation_source_graph",
        toIdentitySha256: reference.identitySha256,
      }),
    )),
    members: Object.freeze([{
      identitySha256: planGraph.planGraphSha256,
      kind: planGraph.contractVersion,
      payload: planGraphBytes,
    }, ...references.map(
      // project each canonical reference into the archive member grammar
      (reference) => ({
        identitySha256: reference.identitySha256,
        kind: reference.kind,
        payload: reference.bytes,
      }),
    )]),
  });
}

// validate the complete or explicitly unsupported blinded plan grammar
function validateAdjustmentControllerPlanGraph(value) {
  if (value?.contractVersion === "adjustment-maintenance-confirmation-plan-graph/v1") {
    return validateAdjustmentMaintenanceConfirmationPlanGraph(value);
  }
  return validateAdjustmentMaintenanceUnsupportedPlanGraph(value);
}

// build one exact future-only input closure from graph-reachable member identities
export function buildAdjustmentFutureOnlyInputSeal(input) {
  requireExactKeys(input, [
    "archiveCommitOrdinal", "burnSha256", "candidateReportSha256",
    "captureEpochWitnessSha256", "confirmationAccessSha256",
    "custodyCheckpointSha256", "dueKey", "family", "frontierSha256",
    "fullMemberRootSha256", "graphManifestSha256", "inputClassMembers",
    "lifecycleLedgerRootSha256", "pageSha256", "policyReportSha256",
    "predecessorSealSha256", "sealedAt", "sequence", "sourceCommit",
    "workstationJournalHeadSha256",
  ], "future-only input seal builder");
  requirePlainObject(input.inputClassMembers, "future-only input class members");
  requireExactKeys(input.inputClassMembers, FUTURE_INPUT_CLASS_NAMES,
    "future-only input class members");
  const inputClasses = Object.fromEntries(FUTURE_INPUT_CLASS_NAMES.map(
    // normalize every member class to one sorted unique identity population
    (name) => {
      const members = input.inputClassMembers[name];

      // refuse duplicate, unordered or non-hash graph member identities
      if (!Array.isArray(members) || members.some((identity) =>
        typeof identity !== "string" || !SHA256_PATTERN.test(identity)) ||
        new Set(members).size !== members.length) {
        throw new TypeError(`future-only ${name} members are invalid`);
      }
      const sorted = [...members].sort();
      if (members.some((identity, index) => identity !== sorted[index])) {
        throw new TypeError(`future-only ${name} members are not sorted`);
      }
      return [name, {
        count: members.length,
        rootSha256: adjustmentSha256(canonicalJsonBytes(members)),
      }];
    },
  ));
  const seal = {
    archiveCommitOrdinal: input.archiveCommitOrdinal,
    burnSha256: input.burnSha256,
    candidateArtifactRootSha256: adjustmentSha256(canonicalJsonBytes([
      inputClasses.candidate.rootSha256,
      inputClasses.artifact.rootSha256,
    ])),
    candidateReportSha256: input.candidateReportSha256,
    captureEpochWitnessSha256: input.captureEpochWitnessSha256,
    comparatorRootSha256: inputClasses.comparator.rootSha256,
    confirmationAccessSha256: input.confirmationAccessSha256,
    confirmationChunkCount: input.family === "rain" ? 24 : 27,
    contractVersion: "adjustment-future-only-input-seal/v2",
    custodyCheckpointSha256: input.custodyCheckpointSha256,
    dueKey: input.dueKey,
    family: input.family,
    frontierSha256: input.frontierSha256,
    fullMemberCount: 1,
    fullMemberRootSha256: input.fullMemberRootSha256,
    graphManifestSha256: input.graphManifestSha256,
    inputClasses,
    lifecycleLedgerRootSha256: input.lifecycleLedgerRootSha256,
    pageSha256: input.pageSha256,
    policyReportSha256: input.policyReportSha256,
    predecessorSealSha256: input.predecessorSealSha256,
    requiredInputRootSha256: adjustmentSha256(canonicalJsonBytes(inputClasses)),
    sealedAt: input.sealedAt,
    sequence: input.sequence,
    sourceCommit: input.sourceCommit,
    targetRootSha256: inputClasses.target.rootSha256,
    workstationJournalHeadSha256: input.workstationJournalHeadSha256,
  };
  validateAdjustmentFutureOnlyInputSeal(seal);
  const bytes = canonicalJsonBytes(seal);
  return Object.freeze({ bytes, seal: Object.freeze(seal), sealSha256: adjustmentSha256(bytes) });
}

// bind one transferred v3 anchor to an installed future-only input seal
export function buildAdjustmentMaintenanceTransferredAnchorV3(input) {
  requireExactKeys(input, [
    "actionSha256", "controlSha256", "controlVersion", "fullGraphVerifiedAt",
    "inputSeal", "inputSealSha256", "predecessorAnchorSha256", "publishedAt",
  ], "future-only transferred anchor builder");
  const seal = validateAdjustmentFutureOnlyInputSeal(input.inputSeal);
  requireSha256(input.inputSealSha256, "inputSealSha256");

  // bind the anchor to the exact canonical seal bytes rather than a caller hash
  if (adjustmentSha256(canonicalJsonBytes(seal)) !== input.inputSealSha256) {
    throw new TypeError("future-only input seal identity differs");
  }
  const anchor = {
    actionSha256: input.actionSha256,
    archiveCommitOrdinal: seal.archiveCommitOrdinal,
    burnSha256: seal.burnSha256,
    candidateArtifactRootSha256: seal.candidateArtifactRootSha256,
    candidateReportSha256: seal.candidateReportSha256,
    captureEpochWitnessSha256: seal.captureEpochWitnessSha256,
    confirmationAccessSha256: seal.confirmationAccessSha256,
    confirmationChunkCount: seal.confirmationChunkCount,
    contractVersion: "adjustment-maintenance-anchor/v3",
    controlSha256: input.controlSha256,
    controlVersion: input.controlVersion,
    ctfState: "transferred",
    custodyCheckpointSha256: seal.custodyCheckpointSha256,
    dueKey: seal.dueKey,
    family: seal.family,
    frontierSha256: seal.frontierSha256,
    fullGraphVerifiedAt: input.fullGraphVerifiedAt,
    fullMemberRootSha256: seal.fullMemberRootSha256,
    graphManifestSha256: seal.graphManifestSha256,
    inputSealSha256: input.inputSealSha256,
    lifecycleLedgerRootSha256: seal.lifecycleLedgerRootSha256,
    pageSha256: seal.pageSha256,
    policyReportSha256: seal.policyReportSha256,
    predecessorAnchorSha256: input.predecessorAnchorSha256,
    publishedAt: input.publishedAt,
    requiredInputRootSha256: seal.requiredInputRootSha256,
    sequence: seal.sequence,
    sourceCommit: seal.sourceCommit,
    workstationJournalHeadSha256: seal.workstationJournalHeadSha256,
  };
  validateAdjustmentMaintenanceAnchorV3(anchor);
  const bytes = canonicalJsonBytes(anchor);
  return Object.freeze({ anchor: Object.freeze(anchor), anchorSha256: adjustmentSha256(bytes), bytes });
}

// build one external finalization proof without changing transferred authority
export function buildAdjustmentMaintenanceFinalizationProofV3(input) {
  requireExactKeys(input, ["anchor", "anchorSha256", "finalizedAt"],
    "future-only finalization proof builder");
  const anchor = validateAdjustmentMaintenanceAnchorV3(input.anchor);
  requireSha256(input.anchorSha256, "anchorSha256");

  // finalize only the exact canonical transferred anchor
  if (anchor.ctfState !== "transferred" ||
    adjustmentSha256(canonicalJsonBytes(anchor)) !== input.anchorSha256) {
    throw new TypeError("future-only transferred anchor identity differs");
  }
  const { contractVersion: _contractVersion, ctfState: _ctfState, ...fields } = anchor;
  const proof = {
    ...fields,
    contractVersion: "adjustment-maintenance-finalization-proof/v3",
    finalizedAt: input.finalizedAt,
    transferredAnchorSha256: input.anchorSha256,
  };
  validateAdjustmentMaintenanceFinalizationProofV3(proof);
  const bytes = canonicalJsonBytes(proof);
  return Object.freeze({
    bytes,
    finalizationProofSha256: adjustmentSha256(bytes),
    proof: Object.freeze(proof),
  });
}

// accept only the two installed controller modes
export function parseAdjustmentMaintenanceControllerArguments(arguments_) {
  // reject paths, combined modes and caller knobs
  if (!Array.isArray(arguments_) || arguments_.length !== 1 ||
    !new Set(["--daily", "--monthly"]).has(arguments_[0])) {
    throw new TypeError("maintenance controller requires exactly --daily or --monthly");
  }
  return arguments_[0].slice(2);
}

// derive bounded oldest-first due work from immutable due records
export async function planAdjustmentMaintenanceDues({ journal, mode, now, schedule }) {
  requireControllerMode(mode);
  const instant = requireDate(now);
  const rolling = validateAdjustmentRegistrationScheduleStatus(schedule);

  // bind planning to the same authenticated database transaction clock
  if (instant.toISOString() !== rolling.snapshotAt) {
    throw new TypeError("maintenance planner clock differs from schedule");
  }
  const currentLocalDate = localDateAt(instant);
  const currentMonth = currentLocalDate.slice(0, 7);
  const firstLocalDate = addLocalDates(adjustmentRollingLocalDateAt(rolling.epochAt), 1);
  const horizonEndExclusiveLocalDate = adjustmentRollingLocalDateAt(rolling.horizonEndAt);
  const candidates = [];

  // daily handles at most seven oldest eligible local dates
  if (mode === "daily") {
    const finalDate = minimumLocalDate(
      addLocalDates(currentLocalDate, -1),
      addLocalDates(horizonEndExclusiveLocalDate, -1),
    );
    const dailyDates = localDatesBetween(
      firstLocalDate,
      finalDate,
    );
    const dailyKeys = dailyDates.map(
      // bind every local date to one durable due identity
      (localDate) => `daily/${localDate}`,
    );
    const dailyState = await journal.inspectDueKeys({ dueKeys: dailyKeys });

    // retain only the oldest seven unfinished dates
    for (const state of dailyState) {
      // skip every immutable completion
      if (state.status === "complete") {
        continue;
      }
      candidates.push(dueFromKey(state.dueKey));

      // stop at the fixed daily catch-up ceiling
      if (candidates.filter((due) => due.mode === "daily").length === DAILY_LIMIT) {
        break;
      }
    }

    const nextControlMonth = utcMonthAfter(instant);
    const controlMonthStart = Date.parse(`${nextControlMonth}-01T00:00:00.000Z`);
    const controlWindowStart = controlMonthStart - 7 * 86_400_000;

    // register the next rain control exactly once inside its authenticated pre-month window
    if (instant.getTime() >= controlWindowStart && instant.getTime() < controlMonthStart &&
      controlMonthStart < Date.parse(rolling.horizonEndAt)) {
      const controlKey = `control-reference/rain/${nextControlMonth}`;
      const [controlState] = await journal.inspectDueKeys({ dueKeys: [controlKey] });

      // never replay a published immutable reference
      if (controlState.status !== "complete") {
        candidates.push(dueFromKey(controlKey));
      }
    }

    const oldMonths = monthsBetween(
      firstLocalDate.slice(0, 7),
      minimumMonth(
        previousMonth(currentMonth),
        previousMonth(horizonEndExclusiveLocalDate.slice(0, 7)),
      ),
    );

    // advance at most one old month for each family
    for (const family of FAMILIES) {
      const keys = oldMonths.map(
        // bind each family month independently
        (month) => `monthly/${family}/${month}`,
      );
      const states = await journal.inspectDueKeys({ dueKeys: keys });
      const unfinished = states.find(
        // select the oldest incomplete attempt
        (state) => state.status !== "complete",
      );

      // append no synthetic work when backlog is clear
      if (unfinished !== undefined) {
        candidates.push(dueFromKey(unfinished.dueKey));
      }
    }
    return candidates;
  }

  const localDay = Number(currentLocalDate.slice(8, 10));

  // wait for the fixed second-day monthly due boundary
  if (localDay < 2 || currentMonth < firstLocalDate.slice(0, 7) ||
    currentLocalDate >= horizonEndExclusiveLocalDate) {
    return [];
  }
  const monthlyKeys = FAMILIES.map(
    // retain one distinct attempt per family and month
    (family) => `monthly/${family}/${currentMonth}`,
  );
  const monthlyState = await journal.inspectDueKeys({ dueKeys: monthlyKeys });
  return monthlyState.filter(
    // never replay a completed monthly attempt
    (state) => state.status !== "complete",
  ).map(
    // restore the closed due projection
    (state) => dueFromKey(state.dueKey),
  );
}

// select one terminal family without fixed-order starvation
export function selectAdjustmentDailyLifecycleEntry(entries, clockAt) {
  requireInstant(clockAt, "daily lifecycle selector clockAt");
  if (!Array.isArray(entries)) {
    throw new TypeError("daily lifecycle entries are invalid");
  }
  const now = Date.parse(clockAt);
  const active = entries.filter(
    // retain only authenticated occupied future-only slots
    (entry) => entry?.slot?.state === "busy_v3" &&
      entry.activeRegistration !== null &&
      typeof entry?.activeRegistration?.terminalAt === "string",
  );
  active.sort(
    // process eligible terminals first, then earliest terminal and family
    (left, right) => {
      const leftTerminal = Date.parse(left.activeRegistration.terminalAt);
      const rightTerminal = Date.parse(right.activeRegistration.terminalAt);
      const eligibility = Number(rightTerminal <= now) - Number(leftTerminal <= now);
      return eligibility || leftTerminal - rightTerminal ||
        FAMILIES.indexOf(left.slot.family) - FAMILIES.indexOf(right.slot.family);
    },
  );
  return active[0] ?? null;
}

// execute one complete locked daily or monthly run
export async function runAdjustmentMaintenanceController(
  arguments_ = process.argv.slice(2),
  options = {},
) {
  const mode = parseAdjustmentMaintenanceControllerArguments(arguments_);
  const ports = options.ports ?? createProductionAdjustmentMaintenanceControllerPorts();
  validateControllerPorts(ports);

  return await ports.withProcessLock(
    // hold the kernel lock across initialization, attempts and publication
    async () => {
      await ports.journal.initialize();
      await ports.archive.initialize();
      let lifecycle = null;
      if (typeof ports.initializeLifecycle === "function") {
        lifecycle = await ports.initializeLifecycle();
      }
      if (typeof ports.readRegistrationSchedule !== "function") {
        throw new TypeError("registration schedule reader is unavailable");
      }
      const schedule = validateAdjustmentRegistrationScheduleStatus(
        await ports.readRegistrationSchedule(lifecycle),
      );
      const startedAt = requireDate(new Date(schedule.snapshotAt));
      let revisionCycle = null;

      // capture at most one bounded server page before sharing evidence across dues
      if (typeof ports.synchronizeEvidence === "function") {
        revisionCycle = await ports.synchronizeEvidence(startedAt.toISOString());
      }

      // seal a partial custody pack before due work consumes immutable semantics
      if (typeof ports.flushEvidence === "function") {
        await ports.flushEvidence();
      }
      const dues = await planAdjustmentMaintenanceDues({
        journal: ports.journal,
        mode,
        now: startedAt,
        schedule,
      });
      const attempts = [];

      // execute every bounded due item sequentially
      for (const due of dues) {
        try {
          attempts.push(await executeAdjustmentMaintenanceDue({
            due,
            now: requireDate(ports.clock()),
            ports,
            revisionCycle,
          }));
        } catch {
          // preserve later due reconciliation without claiming persistence
          attempts.push({
            dueKey: due.dueKey,
            reason: "controller_error",
            state: "failed",
          });
        }
      }
      return {
        attempts,
        contractVersion: "forecast-adjustment-maintenance-controller-run/v1",
        mode,
        requiredAdapters: ADJUSTMENT_MAINTENANCE_REQUIRED_ADAPTERS,
        startedAt: startedAt.toISOString(),
      };
    },
  );
}

// run one reusable custody cycle without planning model due work
export async function runAdjustmentRevisionCaptureCycle(options = {}) {
  requirePlainObject(options, "revision capture cycle options");

  // prohibit path, transport and interval overrides at the custody boundary
  if (Object.keys(options).some((key) => key !== "ports")) {
    throw new TypeError("revision capture cycle options are invalid");
  }
  const ports = options.ports ?? createProductionAdjustmentMaintenanceControllerPorts();
  validateControllerPorts(ports);

  // require the production custody surface rather than silently doing no work
  if (typeof ports.initializeLifecycle !== "function" ||
    typeof ports.synchronizeEvidence !== "function") {
    throw new TypeError("revision capture cycle ports are invalid");
  }
  return await ports.withProcessLock(
    // serialize archive initialization, epoch binding and one bounded transfer
    async () => {
      await ports.journal.initialize();
      await ports.archive.initialize();
      await ports.initializeLifecycle();
      const cutoffAt = requireDate(ports.clock()).toISOString();
      return await ports.synchronizeEvidence(cutoffAt);
    },
  );
}

// execute one exact original-cutoff due attempt
export async function executeAdjustmentMaintenanceDue({ due, now, ports, revisionCycle = null }) {
  validateDue(due);
  const instant = requireDate(now);
  const dueState = (await ports.journal.inspectDueKeys({ dueKeys: [due.dueKey] }))[0];

  // return immutable completions without replay
  if (dueState.status === "complete") {
    return {
      dueKey: due.dueKey,
      outputSha256: dueState.outputSha256,
      state: "already_complete",
    };
  }

  await reconcileExpiredControllerLease(ports.journal, due.scope, instant);
  const status = await ports.journal.status();
  const inputHeadSha256 = dueState.inputHeadSha256 ?? status.headSha256;

  // refuse unanchored genesis rather than invent an input head
  if (inputHeadSha256 === null) {
    return { dueKey: due.dueKey, reason: "history_unavailable", state: "blocked" };
  }
  requireSha256(inputHeadSha256, "inputHeadSha256");
  requireSha256(status.headSha256, "controller journal head");
  const runId = controllerRunId(due.dueKey, status.headSha256);
  let acquired = false;

  try {
    await ports.journal.acquireLease({
      dueKey: due.dueKey,
      inputHeadSha256,
      now: instant.toISOString(),
      runId,
      scope: due.scope,
    });
    acquired = true;
    const leasedStatus = await ports.journal.status();
    requireSha256(leasedStatus.headSha256, "lifecycleHeadSha256");
    let attemptContext = await ports.journal.readDueAttemptContext({ dueKey: due.dueKey });

    // freeze the original lifecycle head before any terminal side effect
    if (attemptContext === null) {
      attemptContext = await ports.journal.recordDueAttemptContext({
        dueKey: due.dueKey,
        inputHeadSha256,
        lifecycleHeadSha256: leasedStatus.headSha256,
        now: requireDate(ports.clock()).toISOString(),
      });
    }
    const attemptIdentitySha256 = adjustmentSha256(canonicalJsonBytes({
      contractVersion: "forecast-adjustment-maintenance-attempt-identity/v1",
      dueKey: due.dueKey,
      inputHeadSha256,
      originalCutoffAt: due.originalCutoffAt,
    }));
    let outcome = await ports.journal.readDueTerminalOutcome({ dueKey: due.dueKey });

    // finish any owner retirement retained before an interrupted report publication
    if (outcome !== null) {
      await ports.reconcileTerminalOutcome({ dueKey: due.dueKey });
    }

    // run semantics only when no irreversible terminal result is retained
    if (outcome === null) {
      let inspection;
      try {
        inspection = validateSemanticInspection(await ports.inspectSemanticInput({
          archive: ports.archive,
          due,
          inputHeadSha256,
          originalCutoffAt: due.originalCutoffAt,
          revisionCycle,
        }));
      } catch {
        inspection = { reason: "dependency_failed", state: "blocked" };
      }
      outcome = await runDueWork({
        due,
        now: instant.toISOString(),
        inspection,
        ports,
      });
    }
    const report = {
      actionEligible: outcome.actionEligible ?? false,
      attemptIdentitySha256,
      candidateGraphSha256: outcome.candidateGraphSha256,
      candidateSha256: outcome.candidateSha256,
      contractVersion: ADJUSTMENT_MAINTENANCE_ATTEMPT_CONTRACT_VERSION,
      dueKey: due.dueKey,
      family: due.family,
      fitReceiptSha256: outcome.fitReceiptSha256,
      inputHeadSha256,
      lifecycleHeadSha256: attemptContext.lifecycleHeadSha256,
      mode: due.mode,
      originalCutoffAt: due.originalCutoffAt,
      reason: outcome.reason,
      reservedConfirmationExposed: false,
      semanticInputSha256: outcome.semanticInputSha256,
      servingChanged: outcome.servingChanged ?? false,
      state: outcome.state,
    };
    validateAdjustmentMaintenanceAttempt(report);
    const publication = await ports.publishAttemptReport(report);
    requireSha256(publication.manifestObjectSha256, "manifestObjectSha256");
    requireSha256(publication.reportSha256, "reportSha256");
    let developmentRelease = null;
    let controlRelease = null;

    // publish a pre-month reference only after its genuine state and artifact are archived
    if (outcome.controlReferenceMaterial !== undefined) {
      if (typeof ports.publishRainControlReference !== "function") {
        throw new Error("rain control reference publisher is unavailable");
      }
      const actionStatus = await ports.journal.status();
      requireSha256(actionStatus.headSha256, "lifecycleHeadSha256");
      controlRelease = await ports.publishRainControlReference({
        due,
        inputHeadSha256,
        lifecycleHeadSha256: actionStatus.headSha256,
        material: outcome.controlReferenceMaterial,
        report,
        reportCreatedAt: requireDate(ports.clock()).toISOString(),
        reportSha256: publication.reportSha256,
      });
      requireSha256(controlRelease.actionSha256, "actionSha256");

      // complete only a root-acknowledged custody-backed reference release
      if (controlRelease.state !== "acknowledged") {
        throw new Error("rain control reference release is not acknowledged");
      }
    }

    // install every selected monthly fit as an inactive shadow before completing its due
    if (outcome.developmentCandidate !== undefined) {
      if (typeof ports.publishDevelopmentCandidate !== "function") {
        throw new Error("development candidate publisher is unavailable");
      }
      const actionStatus = await ports.journal.status();
      requireSha256(actionStatus.headSha256, "lifecycleHeadSha256");
      developmentRelease = await ports.publishDevelopmentCandidate({
        candidateGraphSha256: outcome.candidateGraphSha256,
        due,
        inputHeadSha256,
        lifecycleHeadSha256: actionStatus.headSha256,
        material: outcome.developmentCandidate,
        report,
        reportCreatedAt: requireDate(ports.clock()).toISOString(),
        reportSha256: publication.reportSha256,
      });
      requireSha256(developmentRelease.actionSha256, "actionSha256");

      // accept only root-acknowledged inactive release installation
      if (developmentRelease.state !== "acknowledged") {
        throw new Error("development candidate release is not acknowledged");
      }
      const material = outcome.developmentCandidate;

      // retain replay custody only for the complete production registration contract
      if (material.registrationMaterial?.shadowRegistration !== undefined) {
        const shadowRegistration = material.registrationMaterial.shadowRegistration;
        await ports.journal.recordDevelopmentCandidateInstalled({
          actionSha256: developmentRelease.actionSha256,
          artifactSha256: shadowRegistration.artifactSha256,
          candidateGraphSha256: outcome.candidateGraphSha256,
          candidateSha256: outcome.candidateSha256,
          family: due.family,
          now: requireDate(ports.clock()).toISOString(),
          registrationSha256: material.confirmationRegistrationSha256,
          shadowRegistrationSha256: shadowRegistration.registrationSha256,
        });
      }
    }

    // leave blocked and failed work registered so future evidence can retry it
    if (report.state === "completed") {
      await ports.journal.completeDue({
        dueKey: due.dueKey,
        now: requireDate(ports.clock()).toISOString(),
        outputSha256: publication.manifestObjectSha256,
      });
    }
    await ports.journal.releaseLease({
      dueKey: due.dueKey,
      now: requireDate(ports.clock()).toISOString(),
      runId,
      scope: due.scope,
    });
    acquired = false;
    return {
      dueKey: due.dueKey,
      manifestObjectSha256: publication.manifestObjectSha256,
      reason: report.reason,
      reportSha256: publication.reportSha256,
      state: report.state,
      ...(developmentRelease === null
        ? controlRelease === null ? {} : { actionSha256: controlRelease.actionSha256 }
        : { actionSha256: developmentRelease.actionSha256 }),
    };
  } finally {
    // release only an unfinished ordinary controller lease
    if (acquired) {
      await ports.journal.releaseLease({
        dueKey: due.dueKey,
        now: requireDate(ports.clock()).toISOString(),
        runId,
        scope: due.scope,
      }).catch(
        // preserve the original failure for later exact reconciliation
        () => undefined,
      );
    }
  }
}

// build one sanitized bounded v2 scorecard from actual supplied roots
export function buildAdjustmentMaintenanceScorecardV2(input) {
  requireExactKeys(input, [
    "attemptSha256",
    "families",
    "generatedAt",
    "identities",
    "inputs",
    "job",
    "operatorState",
    "progress",
    "sourceRevision",
    "warnings",
  ], "scorecard production input");
  requireSha256(input.attemptSha256, "attemptSha256");
  requireInstant(input.generatedAt, "generatedAt");
  const actionLineage = {
    actionSha256: adjustmentSha256(canonicalJsonBytes({
      attemptSha256: input.attemptSha256,
      contractVersion: "forecast-adjustment-no-action-lineage/v1",
      state: "none",
    })),
    attemptSha256: input.attemptSha256,
    predecessorActionSha256: null,
    releaseManifestSha256: null,
    sourceRevision: input.sourceRevision,
  };
  const actionProjectionSha256 = adjustmentSha256(canonicalJsonBytes({
    actionLineage,
    actionState: "none",
    contractVersion: "forecast-adjustment-action-projection/v2",
    policyDecision: "pending",
  }));
  const actionLineageSha256 = adjustmentSha256(canonicalJsonBytes(actionLineage));
  const generatedAt = new Date(input.generatedAt);
  const scorecard = {
    actionLineage,
    actionProjectionSha256,
    actionState: "none",
    contractVersion: "forecast-adjustment-scorecard/v2",
    families: input.families,
    generatedAt: input.generatedAt,
    history: [{
      actionLineageSha256,
      actionProjectionSha256,
      actionState: "none",
      attemptSha256: input.attemptSha256,
      occurredAt: input.generatedAt,
      policyDecision: "pending",
      releaseManifestSha256: null,
    }],
    identities: input.identities,
    inputs: input.inputs,
    job: { ...input.job, operatorState: input.operatorState },
    policyDecision: "pending",
    progress: input.progress,
    siteKey: "ballydidean",
    validThrough: new Date(generatedAt.getTime() + 7 * 86_400_000).toISOString(),
    warnings: input.warnings,
  };
  validateForecastAdjustmentScorecard(scorecard, { now: input.generatedAt });
  const bytes = canonicalJsonBytes(scorecard);

  // enforce the hot publication envelope after canonical encoding
  if (bytes.length > FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES) {
    throw new RangeError("maintenance scorecard exceeds 128 KiB");
  }
  return {
    bytes,
    scorecard,
    scorecardSha256: adjustmentSha256(bytes),
  };
}

// publish one canonical v2 scorecard through the fixed forced-command ssh boundary
export async function publishAdjustmentMaintenanceScorecardV2(input, options = {}) {
  requireExactKeys(input, ["bytes", "scorecardSha256"], "scorecard publication");
  requirePlainObject(options, "scorecard publication options");

  // permit only deterministic clock and process injection for regression tests
  if (Object.keys(options).some((key) => !["now", "spawnImpl"].includes(key)) ||
    (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function")) {
    throw new TypeError("scorecard publication options are invalid");
  }
  const bytes = input.bytes;
  requireSha256(input.scorecardSha256, "scorecardSha256");

  // require one bounded exact canonical scorecard before network mutation
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 ||
    bytes.length > FORECAST_ADJUSTMENT_SCORECARD_V2_MAX_BYTES ||
    adjustmentSha256(bytes) !== input.scorecardSha256) {
    throw new TypeError("scorecard publication bytes are invalid");
  }
  let scorecard;

  try {
    scorecard = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("scorecard publication JSON is invalid");
  }
  const now = options.now === undefined
    ? new Date().toISOString()
    : requireDate(options.now).toISOString();
  validateForecastAdjustmentScorecard(scorecard, { now });

  // reject whitespace or key-order substitution after parsing
  if (!canonicalJsonBytes(scorecard).equals(bytes) ||
    scorecard.contractVersion !== "forecast-adjustment-scorecard/v2") {
    throw new TypeError("scorecard publication is not canonical v2");
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const sshAgentSocket = spawnImpl === spawn
    ? await requireControllerSshAgentSocket()
    : undefined;
  const child = spawnImpl("/usr/bin/ssh", [
    "-F",
    CONTROLLER_SSH_CONFIG,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "--",
    CONTROLLER_REMOTE_HOST,
    "install-adjustment-scorecard-v2",
    input.scorecardSha256,
  ], {
    env: {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      ...(sshAgentSocket === undefined ? {} : { SSH_AUTH_SOCK: sshAgentSocket }),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await transferScorecardPublication(child, bytes);
  return { scorecardSha256: input.scorecardSha256 };
}

// invoke one fixed nine-operand family release through the forced ssh boundary
export async function applyAdjustmentFamilyRelease(input, options = {}) {
  requireExactKeys(input, [
    "actionSha256", "compensatingRelease", "expectedCurrentRelease",
    "expectedSettingsSha256", "expectedSourceRelease", "family", "fencingToken",
    "reportSha256", "targetRelease",
  ], "family release request");
  requirePlainObject(options, "family release request options");

  // permit only process injection for isolated transport tests
  if (Object.keys(options).some((key) => key !== "spawnImpl") ||
    (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function")) {
    throw new TypeError("family release request options are invalid");
  }
  for (const name of ["actionSha256", "expectedSettingsSha256", "reportSha256"]) {
    requireSha256(input[name], name);
  }
  for (const name of [
    "compensatingRelease", "expectedCurrentRelease", "expectedSourceRelease", "targetRelease",
  ]) {
    // close every immutable release operand before ssh invocation
    if (typeof input[name] !== "string" ||
      !/^\d{4}\.\d{2}\.\d{2}-[1-9]\d?$/u.test(input[name])) {
      throw new TypeError(`${name} is invalid`);
    }
  }
  // accept only one closed adjustment family literal
  if (!FAMILIES.includes(input.family)) {
    throw new TypeError("family is invalid");
  }

  // close the uint64 fence and source equality before remote work
  if (typeof input.fencingToken !== "string" || !/^[1-9]\d{0,19}$/u.test(input.fencingToken) ||
    BigInt(input.fencingToken) > 0xffff_ffff_ffff_ffffn ||
    input.expectedCurrentRelease !== input.expectedSourceRelease ||
    input.targetRelease === input.compensatingRelease ||
    input.targetRelease === input.expectedCurrentRelease ||
    input.compensatingRelease === input.expectedCurrentRelease) {
    throw new TypeError("family release request identity is invalid");
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const sshAgentSocket = spawnImpl === spawn
    ? await requireControllerSshAgentSocket()
    : undefined;
  const child = spawnImpl("/usr/bin/ssh", [
    "-F", CONTROLLER_SSH_CONFIG,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "--", CONTROLLER_REMOTE_HOST,
    "adjustment-family-release",
    input.targetRelease,
    input.compensatingRelease,
    input.expectedCurrentRelease,
    input.expectedSourceRelease,
    input.expectedSettingsSha256,
    input.family,
    input.actionSha256,
    input.reportSha256,
    input.fencingToken,
  ], {
    env: {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      ...(sshAgentSocket === undefined ? {} : { SSH_AUTH_SOCK: sshAgentSocket }),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bytes = await collectAdjustmentFamilyReleaseResult(child);
  let result;

  // decode only the canonical sanitized status projection
  try {
    result = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("family_release_response_invalid");
  }
  const canonical = canonicalJsonBytes(result);
  const status = validateAdjustmentFamilyReleaseStatus(result, input.actionSha256);

  // reject remote whitespace or an unfinished command result
  if (!canonical.equals(bytes) ||
    !["acknowledged", "compensation_required", "operator_off_unapplied"].includes(result.state) ||
    (result.state === "operator_off_unapplied" &&
      (result.compensationState !== "absent" || result.outcome !== "operator_off_unapplied"))) {
    throw new Error("family_release_response_invalid");
  }
  return status;
}

// read one authoritative root family transaction without mutating it
export async function fetchAdjustmentFamilyReleaseStatus(actionSha256, options = {}) {
  requireSha256(actionSha256, "actionSha256");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-family-release-status",
    [actionSha256],
    (value) => validateAdjustmentFamilyReleaseStatus(value, actionSha256),
    options,
  );
}

// validate one absent, in-flight or terminal root transaction projection
export function validateAdjustmentFamilyReleaseStatus(value, expectedActionSha256 = null) {
  requirePlainObject(value, "family release status");

  // preserve exact absence without manufacturing release identities
  if (value.state === "absent") {
    requireExactKeys(value, ["actionSha256", "contractVersion", "state"],
      "family release status");
    requireSha256(value.actionSha256, "family release status actionSha256");
    if (value.contractVersion !== "adjustment-family-release-status/v1" ||
      expectedActionSha256 !== null && value.actionSha256 !== expectedActionSha256) {
      throw new TypeError("family release status is invalid");
    }
    return Object.freeze(value);
  }
  requireExactKeys(value, [
    "actionSha256", "compensatingRelease", "compensationState", "contractVersion",
    "family", "fencingToken", "outcome", "state", "targetRelease",
  ], "family release status");
  requireSha256(value.actionSha256, "family release status actionSha256");
  requireFamilyOrNull(value.family);
  const inFlight = new Set(["prepared", "applying"]);
  const terminal = new Set([
    "acknowledged", "compensation_required", "operator_off_unapplied",
  ]);

  // admit only states emitted by the fixed root transaction store
  if (value.contractVersion !== "adjustment-family-release-status/v1" ||
    expectedActionSha256 !== null && value.actionSha256 !== expectedActionSha256 ||
    !inFlight.has(value.state) && !terminal.has(value.state) ||
    !["absent", "failed", "verified"].includes(value.compensationState) ||
    typeof value.fencingToken !== "string" || !/^[1-9]\d{0,19}$/u.test(value.fencingToken) ||
    typeof value.targetRelease !== "string" ||
    !/^\d{4}\.\d{2}\.\d{2}-[1-9]\d*$/u.test(value.targetRelease) ||
    typeof value.compensatingRelease !== "string" ||
    !/^\d{4}\.\d{2}\.\d{2}-[1-9]\d*$/u.test(value.compensatingRelease) ||
    inFlight.has(value.state) &&
      (value.compensationState !== "absent" || value.outcome !== null) ||
    value.state === "acknowledged" &&
      (value.compensationState !== "absent" ||
        !["active", "deployed_operator_off"].includes(value.outcome)) ||
    value.state === "compensation_required" && value.outcome !== null ||
    value.state === "operator_off_unapplied" &&
      (value.compensationState !== "absent" || value.outcome !== "operator_off_unapplied")) {
    throw new TypeError("family release status is invalid");
  }
  return Object.freeze(value);
}

// read one exact live source authority for publisher compare-and-swap inputs
export async function fetchAdjustmentFamilyReleaseCurrent(family, options = {}) {
  requireFamilyOrNull(family);

  // prohibit the nullable daily family projection
  if (family === null) {
    throw new TypeError("family current authority family is invalid");
  }
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-family-release-current-v1",
    [family],
    (value) => validateAdjustmentFamilyReleaseCurrent(value, family),
    options,
  );
}

// read one root-authenticated transitive current-release lineage proof
export async function fetchAdjustmentFamilyReleaseLineage(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-family-release-lineage-v2",
    [],
    validateAdjustmentFamilyReleaseLineage,
    options,
  );
}

// validate one closed transitive current-release lineage proof
export function validateAdjustmentFamilyReleaseLineage(value) {
  requireExactKeys(value, [
    "contractVersion", "controlSha256", "controlVersion", "currentActionSha256",
    "currentCommit", "currentRelease", "epochAncestorCommit",
    "epochWitnessSha256", "state", "verifiedAt",
  ], "family release lineage");
  requireSha256(value.controlSha256, "controlSha256");
  requireNullableSha256(value.currentActionSha256, "currentActionSha256");
  requireSha256(value.epochWitnessSha256, "epochWitnessSha256");
  requireInstant(value.verifiedAt, "verifiedAt");

  // accept only the reviewed v14 epoch-descendant identity projection
  if (value.contractVersion !== "adjustment-family-release-lineage/v2" ||
    value.controlVersion !== "14" || value.state !== "verified_epoch_descendant" ||
    typeof value.currentCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.currentCommit) ||
    typeof value.epochAncestorCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.epochAncestorCommit) ||
    typeof value.currentRelease !== "string" ||
    !/^\d{4}\.\d{2}\.\d{2}-[1-9]\d{0,2}$/u.test(value.currentRelease)) {
    throw new TypeError("family release lineage is invalid");
  }
  return Object.freeze(value);
}

// build one value-free support failure report from actual missing evidence roots
export function buildAdjustmentUnsupportedPolicyReport(input) {
  requireExactKeys(input, [
    "family", "missingClassNames", "missingKeyCount", "missingKeySetSha256",
    "registrationSha256", "targetCutoffAt", "unsupportedReason",
  ], "unsupported policy report input");
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily family at a terminal member boundary
  if (input.family === null) {
    throw new TypeError("unsupported policy report family is invalid");
  }
  validateUnsupportedMissingEvidence(input);
  requireSha256(input.registrationSha256, "unsupported registrationSha256");
  requireInstant(input.targetCutoffAt, "unsupported targetCutoffAt");
  const report = {
    contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_POLICY_REPORT_VERSION,
    family: input.family,
    missingClassNames: Object.freeze([...input.missingClassNames]),
    missingKeyCount: input.missingKeyCount,
    missingKeySetSha256: input.missingKeySetSha256,
    registrationSha256: input.registrationSha256,
    state: "unsupported",
    targetCutoffAt: input.targetCutoffAt,
    unsupportedReason: input.unsupportedReason,
  };
  const bytes = canonicalJsonBytes(report);
  return Object.freeze({
    bytes,
    policyReportSha256: adjustmentSha256(bytes),
    report: Object.freeze(report),
  });
}

// project terminal graph bindings into the ten closed C/T/F member classes
export function buildAdjustmentMaintenanceInputClassMembers(input) {
  requireExactKeys(input, [
    "artifactSha256", "candidateSha256", "family", "rainGateInputMemberSha256s",
    "terminalGraph",
  ], "maintenance input class projection");
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily family at one terminal proof boundary
  if (input.family === null) {
    throw new TypeError("maintenance input class family is invalid");
  }
  requireSha256(input.artifactSha256, "artifactSha256");
  requireSha256(input.candidateSha256, "candidateSha256");
  if (!Array.isArray(input.rainGateInputMemberSha256s) ||
    input.rainGateInputMemberSha256s.some((identity) =>
      typeof identity !== "string" || !SHA256_PATTERN.test(identity)) ||
    new Set(input.rainGateInputMemberSha256s).size !==
      input.rainGateInputMemberSha256s.length ||
    (input.family !== "rain" && input.rainGateInputMemberSha256s.length !== 0)) {
    throw new TypeError("maintenance rain gate members are invalid");
  }
  requirePlainObject(input.terminalGraph, "maintenance terminal graph");
  if (!Array.isArray(input.terminalGraph.bindings)) {
    throw new TypeError("maintenance terminal graph bindings are invalid");
  }
  const classes = Object.fromEntries(FUTURE_INPUT_CLASS_NAMES.map(
    // retain one unique set for every frozen semantic class
    (name) => [name, new Set()],
  ));
  classes.candidate.add(input.candidateSha256);
  classes.artifact.add(input.artifactSha256);
  for (const identity of input.rainGateInputMemberSha256s) {
    classes.rain_gate_input.add(identity);
  }

  // derive only identities explicitly crosslinked by each terminal record
  for (const binding of input.terminalGraph.bindings) {
    requireExactKeys(binding, [
      "actualBestMatch", "capsule", "key", "nativeSource", "target",
    ], "maintenance terminal graph binding");
    requireExactKeys(binding.actualBestMatch, [
      "memberSha256", "payloadIdentitySha256", "receiptSha256",
    ], "maintenance actual best match binding");
    requireExactKeys(binding.capsule, [
      "comparatorMemberSha256", "payloadIdentitySha256", "predictionBodySha256",
      "receiptSha256", "sourceProjectionSha256",
    ], "maintenance capsule binding");
    requireExactKeys(binding.nativeSource, [
      "memberSha256", "payloadIdentitySha256", "receiptSha256",
    ], "maintenance native source binding");
    requireExactKeys(binding.target, ["sourceMemberSha256s", "targetMemberSha256"],
      "maintenance target binding");
    for (const identity of [
      binding.actualBestMatch.memberSha256,
      binding.capsule.comparatorMemberSha256,
      binding.capsule.predictionBodySha256,
      binding.capsule.sourceProjectionSha256,
      binding.nativeSource.memberSha256,
      binding.target.targetMemberSha256,
    ]) {
      requireSha256(identity, "maintenance terminal member identity");
    }
    if (!Array.isArray(binding.target.sourceMemberSha256s) ||
      binding.target.sourceMemberSha256s.some((identity) =>
        typeof identity !== "string" || !SHA256_PATTERN.test(identity))) {
      throw new TypeError("maintenance target source members are invalid");
    }
    classes.actual_best_match.add(binding.actualBestMatch.memberSha256);
    classes.comparator.add(binding.capsule.comparatorMemberSha256);
    classes.shadow_body.add(binding.capsule.predictionBodySha256);
    classes.shadow_source.add(binding.capsule.sourceProjectionSha256);
    classes.native_source.add(binding.nativeSource.memberSha256);
    classes.target.add(binding.target.targetMemberSha256);
    for (const identity of binding.target.sourceMemberSha256s) {
      classes.target_revision.add(identity);
    }
  }
  return Object.freeze(Object.fromEntries(FUTURE_INPUT_CLASS_NAMES.map(
    // stabilize every class before root derivation and transport
    (name) => [name, Object.freeze([...classes[name]].sort())],
  )));
}

// partition one terminal graph into bounded immutable archive members
export function buildAdjustmentMaintenanceTerminalGraphParts(input) {
  requireExactKeys(input, ["family", "terminalGraph"],
    "maintenance terminal graph parts input");
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily family at the terminal archive boundary
  if (input.family === null) {
    throw new TypeError("maintenance terminal graph family is invalid");
  }
  requirePlainObject(input.terminalGraph, "maintenance terminal graph");
  const unsupported = input.terminalGraph.contractVersion ===
    ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_GRAPH_VERSION;
  requireExactKeys(input.terminalGraph, unsupported
    ? [
        "bindings", "contractVersion", "derivedTargetMemberSha256s",
        "graphManifestSha256s", "missingKeySetSha256", "terminalGraphSha256",
      ]
    : [
        "bindings", "contractVersion", "derivedTargetMemberSha256s",
        "graphManifestSha256s", "terminalGraphSha256",
      ], "maintenance terminal graph");

  // accept only the complete or explicit unsupported graph domains
  if (!unsupported && input.terminalGraph.contractVersion !==
    ADJUSTMENT_MAINTENANCE_CONFIRMATION_TERMINAL_GRAPH_VERSION) {
    throw new TypeError("maintenance terminal graph contract is invalid");
  }
  requireSha256(input.terminalGraph.terminalGraphSha256, "terminalGraphSha256");
  if (unsupported) {
    requireSha256(input.terminalGraph.missingKeySetSha256, "missingKeySetSha256");
  }
  for (const [name, values] of [
    ["derivedTargetMemberSha256s", input.terminalGraph.derivedTargetMemberSha256s],
    ["graphManifestSha256s", input.terminalGraph.graphManifestSha256s],
  ]) {
    // require one canonical unique identity population
    if (!Array.isArray(values) || values.some((value) =>
      typeof value !== "string" || !SHA256_PATTERN.test(value)) ||
      new Set(values).size !== values.length ||
      values.some((value, index) => value !== [...values].sort()[index])) {
      throw new TypeError(`maintenance terminal graph ${name} is invalid`);
    }
  }
  if (!Array.isArray(input.terminalGraph.bindings)) {
    throw new TypeError("maintenance terminal graph bindings are invalid");
  }
  const keys = input.terminalGraph.bindings.map(
    // bind the partition order to each preregistered expected cell
    (binding) => binding?.key,
  );
  if (keys.some((key) => typeof key !== "string") ||
    new Set(keys).size !== keys.length ||
    keys.some((key, index) => key !== [...keys].sort()[index])) {
    throw new TypeError("maintenance terminal graph binding order is invalid");
  }
  const { terminalGraphSha256: _terminalGraphSha256, ...unsignedGraph } =
    input.terminalGraph;

  // require the source graph's exact self-hash before splitting it
  if (input.terminalGraph.terminalGraphSha256 !==
    adjustmentSha256(canonicalJsonBytes(unsignedGraph))) {
    throw new TypeError("maintenance terminal graph identity differs");
  }
  const groups = [];
  let current = [];

  // choose boundaries from ordered identities and byte ceilings, never outcomes
  for (const binding of input.terminalGraph.bindings) {
    const candidate = [...current, binding];
    const upperBound = canonicalJsonBytes({
      bindings: candidate,
      contractVersion: "adjustment-maintenance-confirmation-terminal-graph-part/v1",
      family: input.family,
      originalTerminalGraphSha256: input.terminalGraph.terminalGraphSha256,
      partCount: 9_500_000,
      partIndex: 9_500_000,
    }).length;

    // close the current part before the next binding would exceed either bound
    if (current.length > 0 && (candidate.length > TERMINAL_GRAPH_PART_MAXIMUM_BINDINGS ||
      upperBound > TERMINAL_GRAPH_PART_MAXIMUM_BYTES)) {
      groups.push(current);
      current = [binding];
    } else {
      current = candidate;
    }
  }
  groups.push(current);
  const parts = groups.map(
    // freeze each final part with its actual total and index
    (bindings, partIndex) => {
      const document = {
        bindings,
        contractVersion: "adjustment-maintenance-confirmation-terminal-graph-part/v1",
        family: input.family,
        originalTerminalGraphSha256: input.terminalGraph.terminalGraphSha256,
        partCount: groups.length,
        partIndex,
      };
      const bytes = canonicalJsonBytes(document);

      // retain the hard member ceiling after substituting final counters
      if (bytes.length > TERMINAL_GRAPH_PART_MAXIMUM_BYTES) {
        throw new RangeError("maintenance terminal graph part exceeds its bound");
      }
      return Object.freeze({
        bytes,
        document: Object.freeze(document),
        partSha256: adjustmentSha256(bytes),
      });
    },
  );
  const manifestUnsigned = {
    contractVersion: "adjustment-maintenance-confirmation-terminal-graph-manifest/v1",
    derivedTargetMemberSha256s: input.terminalGraph.derivedTargetMemberSha256s,
    family: input.family,
    graphManifestSha256s: input.terminalGraph.graphManifestSha256s,
    missingKeySetSha256: unsupported
      ? input.terminalGraph.missingKeySetSha256
      : null,
    originalContractVersion: input.terminalGraph.contractVersion,
    originalTerminalGraphSha256: input.terminalGraph.terminalGraphSha256,
    partSha256s: parts.map(
      // retain the exact ordered bounded member population
      (part) => part.partSha256,
    ),
  };
  const manifest = Object.freeze({
    ...manifestUnsigned,
    terminalGraphManifestSha256: adjustmentSha256(canonicalJsonBytes(manifestUnsigned)),
  });
  return Object.freeze({
    manifest,
    manifestBytes: canonicalJsonBytes(manifest),
    parts: Object.freeze(parts),
  });
}

// validate one closed value-free unsupported policy report
export function validateAdjustmentUnsupportedPolicyReport(value) {
  requireExactKeys(value, [
    "contractVersion", "family", "missingClassNames", "missingKeyCount",
    "missingKeySetSha256", "registrationSha256", "state", "targetCutoffAt",
    "unsupportedReason",
  ], "unsupported policy report");
  const rebuilt = buildAdjustmentUnsupportedPolicyReport({
    family: value.family,
    missingClassNames: value.missingClassNames,
    missingKeyCount: value.missingKeyCount,
    missingKeySetSha256: value.missingKeySetSha256,
    registrationSha256: value.registrationSha256,
    targetCutoffAt: value.targetCutoffAt,
    unsupportedReason: value.unsupportedReason,
  });

  // require the one unsupported report contract without a caller-created state alias
  if (value.contractVersion !== ADJUSTMENT_MAINTENANCE_UNSUPPORTED_POLICY_REPORT_VERSION ||
    value.state !== "unsupported" || !rebuilt.bytes.equals(canonicalJsonBytes(value))) {
    throw new TypeError("unsupported policy report differs");
  }
  return Object.freeze(value);
}

// build one no-promotion terminal proof from actual partial graph members
export function buildAdjustmentUnsupportedTerminalProof(input) {
  requireExactKeys(input, [
    "actionSha256", "archiveCommitOrdinal", "burnSha256", "candidateReportSha256",
    "captureEpochWitnessSha256", "confirmationAccessSha256", "controlSha256",
    "controlVersion", "custodyCheckpointSha256", "dueKey",
    "eligiblePredictionSetSha256", "expectedKeySetSha256", "family", "finalizedAt",
    "frontierSha256", "fullGraphVerifiedAt", "fullMemberRootSha256",
    "graphManifestSha256", "inputClassMembers", "lifecycleLedgerRootSha256",
    "missingClassNames", "missingKeyCount", "missingKeySetSha256", "pageSha256",
    "policyReportSha256", "predecessorProofSha256", "registrationSha256", "sequence",
    "sourceCommit", "unsupportedReason", "workstationJournalHeadSha256",
  ], "unsupported terminal proof input");
  requirePlainObject(input.inputClassMembers, "unsupported input class members");
  requireExactKeys(input.inputClassMembers, FUTURE_INPUT_CLASS_NAMES,
    "unsupported input class members");
  const inputClasses = Object.fromEntries(FUTURE_INPUT_CLASS_NAMES.map(
    // normalize each genuine partial class without synthesizing absent members
    (name) => {
      const members = input.inputClassMembers[name];

      // require canonical unique member identity order
      if (!Array.isArray(members) || members.some((identity) =>
        typeof identity !== "string" || !SHA256_PATTERN.test(identity)) ||
        new Set(members).size !== members.length ||
        members.some((identity, index) => identity !== [...members].sort()[index])) {
        throw new TypeError(`unsupported ${name} members are invalid`);
      }
      return [name, Object.freeze({
        count: members.length,
        rootSha256: adjustmentSha256(canonicalJsonBytes(members)),
      })];
    },
  ));
  const proof = {
    actionSha256: input.actionSha256,
    archiveCommitOrdinal: input.archiveCommitOrdinal,
    burnSha256: input.burnSha256,
    candidateReportSha256: input.candidateReportSha256,
    captureEpochWitnessSha256: input.captureEpochWitnessSha256,
    confirmationAccessSha256: input.confirmationAccessSha256,
    confirmationChunkCount: input.family === "rain" ? 24 : 27,
    contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_PROOF_VERSION,
    controlSha256: input.controlSha256,
    controlVersion: input.controlVersion,
    custodyCheckpointSha256: input.custodyCheckpointSha256,
    dueKey: input.dueKey,
    eligiblePredictionSetSha256: input.eligiblePredictionSetSha256,
    expectedKeySetSha256: input.expectedKeySetSha256,
    family: input.family,
    finalizedAt: input.finalizedAt,
    frontierSha256: input.frontierSha256,
    fullGraphVerifiedAt: input.fullGraphVerifiedAt,
    fullMemberRootSha256: input.fullMemberRootSha256,
    graphManifestSha256: input.graphManifestSha256,
    inputClasses,
    lifecycleLedgerRootSha256: input.lifecycleLedgerRootSha256,
    missingClassNames: Object.freeze([...input.missingClassNames]),
    missingKeyCount: input.missingKeyCount,
    missingKeySetSha256: input.missingKeySetSha256,
    pageSha256: input.pageSha256,
    policyReportSha256: input.policyReportSha256,
    predecessorProofSha256: input.predecessorProofSha256,
    registrationSha256: input.registrationSha256,
    requiredInputRootSha256: adjustmentSha256(canonicalJsonBytes(inputClasses)),
    sequence: input.sequence,
    sourceCommit: input.sourceCommit,
    unsupportedReason: input.unsupportedReason,
    workstationJournalHeadSha256: input.workstationJournalHeadSha256,
  };
  validateAdjustmentUnsupportedTerminalProof(proof);
  const bytes = canonicalJsonBytes(proof);
  return Object.freeze({
    bytes,
    proof: Object.freeze(proof),
    proofSha256: adjustmentSha256(bytes),
  });
}

// derive one installed unsupported proof and no-action receipt from burned evidence
export function buildAdjustmentUnsupportedTerminalArtifacts(input) {
  requireExactKeys(input, [
    "acknowledgement", "artifactSha256", "assembly", "candidateSha256", "epochWitness",
    "finalizedAt", "fullGraphVerifiedAt", "fullManifest", "graphManifestSha256",
    "journalHeadSha256", "localBurn", "nativeAccess", "predecessor", "registrationSha256",
    "rainGateInputMemberSha256s", "sourceCommit", "targetCutoffAt", "unsupportedReason",
  ], "unsupported terminal artifacts input");
  const acknowledgement = validateAdjustmentRevisionColdCustodyAcknowledgementV2(
    input.acknowledgement,
  );
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requirePlainObject(input.assembly, "unsupported terminal assembly");
  requirePlainObject(input.fullManifest, "unsupported full manifest");
  requirePlainObject(input.localBurn, "unsupported local burn");
  requirePlainObject(input.nativeAccess, "unsupported native access");
  requireSha256(input.graphManifestSha256, "graphManifestSha256");
  requireSha256(input.journalHeadSha256, "journalHeadSha256");
  requireSha256(input.registrationSha256, "registrationSha256");
  requireGitCommit(input.sourceCommit, "sourceCommit");
  requireInstant(input.finalizedAt, "finalizedAt");
  requireInstant(input.fullGraphVerifiedAt, "fullGraphVerifiedAt");
  requireInstant(input.targetCutoffAt, "targetCutoffAt");
  requireExactKeys(input.fullManifest, [
    "accessSha256", "chunkCount", "chunks", "contractVersion",
    "eligiblePredictionSetSha256", "expectedKeySetSha256", "family",
    "fullMemberRootSha256", "intervalEndExclusiveLocalDate",
    "intervalStartLocalDate", "missingKeySetSha256", "registrationSha256",
    "revisionCatalogWatermarkSha256", "targetComparatorSnapshotRootSha256",
    "targetCutoffAt",
  ], "unsupported full manifest");

  // admit only a terminal partial assembly with a finalized logical member
  if (input.assembly.state !== "burned_unsupported" ||
    input.fullManifest.fullMemberRootSha256 === undefined ||
    Date.parse(input.finalizedAt) < Date.parse(input.fullGraphVerifiedAt)) {
    throw new TypeError("unsupported terminal assembly is invalid");
  }
  requireSha256(input.fullManifest.fullMemberRootSha256, "fullMemberRootSha256");
  requireSha256(input.localBurn.accessSha256, "local burn accessSha256");
  requireSha256(input.localBurn.registrationSha256, "local burn registrationSha256");
  requireSha256(input.assembly.registrationSha256,
    "unsupported assembly registrationSha256");
  requireSha256(input.nativeAccess.accessSha256, "native accessSha256");
  requireSha256(input.nativeAccess.eligiblePredictionSetSha256,
    "native eligiblePredictionSetSha256");
  requireSha256(input.nativeAccess.expectedKeySetSha256,
    "native expectedKeySetSha256");
  requireSha256(input.nativeAccess.targetComparatorSnapshotRootSha256,
    "native targetComparatorSnapshotRootSha256");
  requireSha256(input.fullManifest.eligiblePredictionSetSha256,
    "full manifest eligiblePredictionSetSha256");
  requireSha256(input.fullManifest.expectedKeySetSha256,
    "full manifest expectedKeySetSha256");
  requireSha256(input.fullManifest.missingKeySetSha256,
    "full manifest missingKeySetSha256");
  requireSha256(input.fullManifest.registrationSha256,
    "full manifest registrationSha256");
  requireInstant(input.nativeAccess.accessedAt, "native accessedAt");
  requireInstant(input.nativeAccess.targetCutoffAt, "native targetCutoffAt");
  const unsignedManifest = { ...input.fullManifest };
  delete unsignedManifest.fullMemberRootSha256;

  // bind the proof to the owner-opened plan rather than the blinded snapshot root
  if (input.nativeAccess.registrationSha256 !== input.registrationSha256 ||
    input.nativeAccess.expectedKeySetSha256 !== input.localBurn.expectedKeySetSha256 ||
    input.nativeAccess.targetComparatorSnapshotRootSha256 !==
      input.localBurn.targetComparatorSnapshotRootSha256 ||
    input.nativeAccess.targetCutoffAt !== input.targetCutoffAt ||
    input.fullManifest.accessSha256 !== input.localBurn.accessSha256 ||
    input.fullManifest.contractVersion !== "adjustment-confirmation-member/v3" ||
    input.fullManifest.family !== input.assembly.family ||
    input.fullManifest.chunkCount !== (input.assembly.family === "rain" ? 24 : 27) ||
    !Array.isArray(input.fullManifest.chunks) ||
    input.fullManifest.chunks.length !== input.fullManifest.chunkCount ||
    input.fullManifest.registrationSha256 !== input.assembly.registrationSha256 ||
    input.fullManifest.registrationSha256 !== input.localBurn.registrationSha256 ||
    input.fullManifest.expectedKeySetSha256 !== input.localBurn.expectedKeySetSha256 ||
    input.fullManifest.missingKeySetSha256 !== input.assembly.missingKeySetSha256 ||
    input.fullManifest.targetCutoffAt !== input.targetCutoffAt ||
    input.fullManifest.fullMemberRootSha256 !==
      adjustmentSha256(canonicalJsonBytes(unsignedManifest)) ||
    Date.parse(input.fullGraphVerifiedAt) < Date.parse(input.nativeAccess.accessedAt)) {
    throw new TypeError("unsupported terminal access binding differs");
  }
  const inputClassMembers = buildAdjustmentMaintenanceInputClassMembers({
    artifactSha256: input.artifactSha256,
    candidateSha256: input.candidateSha256,
    family: input.assembly.family,
    rainGateInputMemberSha256s: input.rainGateInputMemberSha256s,
    terminalGraph: input.assembly.terminalGraph,
  });
  const missingClassNames = FUTURE_INPUT_CLASS_NAMES.filter(
    // report only required semantic classes with no genuine member
    (name) => inputClassMembers[name].length === 0 &&
      (input.assembly.family === "rain" || name !== "rain_gate_input"),
  );
  const policy = buildAdjustmentUnsupportedPolicyReport({
    family: input.assembly.family,
    missingClassNames,
    missingKeyCount: input.assembly.missingKeyCount,
    missingKeySetSha256: input.assembly.missingKeySetSha256,
    registrationSha256: input.registrationSha256,
    targetCutoffAt: input.targetCutoffAt,
    unsupportedReason: input.unsupportedReason,
  });
  const action = buildAdjustmentTerminalNoActionReceipt({
    completedAt: input.finalizedAt,
    disposition: "support_failed",
    finalizedAt: input.fullGraphVerifiedAt,
    fullMemberRootSha256: input.fullManifest.fullMemberRootSha256,
    policyReportSha256: policy.policyReportSha256,
    registrationSha256: input.registrationSha256,
  });
  const predecessor = input.predecessor === null
    ? null
    : validateAdjustmentUnsupportedTerminalProofCurrent(input.predecessor);
  const proof = buildAdjustmentUnsupportedTerminalProof({
    actionSha256: action.receipt.actionSha256,
    archiveCommitOrdinal: acknowledgement.nextArchiveCommitOrdinal,
    burnSha256: input.localBurn.accessSha256,
    candidateReportSha256: policy.policyReportSha256,
    captureEpochWitnessSha256: adjustmentSha256(canonicalJsonBytes(witness)),
    confirmationAccessSha256: input.nativeAccess.accessSha256,
    controlSha256: witness.controlPlaneSha256,
    controlVersion: witness.controlPlaneVersion,
    custodyCheckpointSha256: acknowledgement.custodyCheckpointSha256,
    dueKey: `confirmation/${input.assembly.family}/${input.candidateSha256}`,
    eligiblePredictionSetSha256: input.nativeAccess.eligiblePredictionSetSha256,
    expectedKeySetSha256: input.localBurn.expectedKeySetSha256,
    family: input.assembly.family,
    finalizedAt: input.finalizedAt,
    frontierSha256: acknowledgement.nextFrontierSha256,
    fullGraphVerifiedAt: input.fullGraphVerifiedAt,
    fullMemberRootSha256: input.fullManifest.fullMemberRootSha256,
    graphManifestSha256: input.graphManifestSha256,
    inputClassMembers,
    lifecycleLedgerRootSha256: input.journalHeadSha256,
    missingClassNames,
    missingKeyCount: input.assembly.missingKeyCount,
    missingKeySetSha256: input.assembly.missingKeySetSha256,
    pageSha256: acknowledgement.pageSha256,
    policyReportSha256: policy.policyReportSha256,
    predecessorProofSha256: predecessor?.proofSha256 ?? null,
    registrationSha256: input.registrationSha256,
    sequence: predecessor === null ? "0" : (BigInt(predecessor.proof.sequence) + 1n).toString(),
    sourceCommit: input.sourceCommit,
    unsupportedReason: input.unsupportedReason,
    workstationJournalHeadSha256: input.journalHeadSha256,
  });
  return Object.freeze({ action, inputClassMembers, policy, proof });
}

// validate one no-promotion unsupported terminal proof
export function validateAdjustmentUnsupportedTerminalProof(value) {
  requireExactKeys(value, [
    "actionSha256", "archiveCommitOrdinal", "burnSha256", "candidateReportSha256",
    "captureEpochWitnessSha256", "confirmationAccessSha256", "confirmationChunkCount",
    "contractVersion", "controlSha256", "controlVersion", "custodyCheckpointSha256",
    "dueKey", "eligiblePredictionSetSha256", "expectedKeySetSha256", "family",
    "finalizedAt", "frontierSha256", "fullGraphVerifiedAt", "fullMemberRootSha256",
    "graphManifestSha256", "inputClasses", "lifecycleLedgerRootSha256",
    "missingClassNames", "missingKeyCount", "missingKeySetSha256", "pageSha256",
    "policyReportSha256", "predecessorProofSha256", "registrationSha256",
    "requiredInputRootSha256", "sequence", "sourceCommit", "unsupportedReason",
    "workstationJournalHeadSha256",
  ], "unsupported terminal proof");
  requireFamilyOrNull(value.family);
  const due = /^confirmation\/(temperature|wind|rain)\/([a-f0-9]{64})$/u.exec(value.dueKey);

  // retain a disjoint terminal-only contract and logical family population
  if (value.contractVersion !== ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_PROOF_VERSION ||
    value.family === null || due === null || due[1] !== value.family ||
    value.confirmationChunkCount !== (value.family === "rain" ? 24 : 27) ||
    !/^[1-9][0-9]{0,5}$/u.test(value.controlVersion) ||
    !/^[a-f0-9]{40}$/u.test(value.sourceCommit)) {
    throw new TypeError("unsupported terminal proof contract differs");
  }
  requireArchiveOrdinal(value.archiveCommitOrdinal, "unsupported archiveCommitOrdinal");
  requireArchiveOrdinal(value.sequence, "unsupported sequence");
  requireInstant(value.finalizedAt, "unsupported finalizedAt");
  requireInstant(value.fullGraphVerifiedAt, "unsupported fullGraphVerifiedAt");
  for (const field of [
    "actionSha256", "burnSha256", "candidateReportSha256",
    "captureEpochWitnessSha256", "confirmationAccessSha256", "controlSha256",
    "custodyCheckpointSha256", "eligiblePredictionSetSha256", "expectedKeySetSha256",
    "frontierSha256", "fullMemberRootSha256", "graphManifestSha256",
    "lifecycleLedgerRootSha256", "missingKeySetSha256", "pageSha256",
    "policyReportSha256", "registrationSha256", "requiredInputRootSha256",
    "workstationJournalHeadSha256",
  ]) {
    requireSha256(value[field], `unsupported ${field}`);
  }
  requireNullableSha256(value.predecessorProofSha256, "unsupported predecessorProofSha256");
  validateUnsupportedMissingEvidence(value);
  requirePlainObject(value.inputClasses, "unsupported inputClasses");
  requireExactKeys(value.inputClasses, FUTURE_INPUT_CLASS_NAMES,
    "unsupported inputClasses");
  const zeroClasses = [];

  // validate every genuine partial member root and discover actual absent classes
  for (const name of FUTURE_INPUT_CLASS_NAMES) {
    const entry = value.inputClasses[name];
    requireExactKeys(entry, ["count", "rootSha256"], `unsupported ${name} class`);
    requireSha256(entry.rootSha256, `unsupported ${name} rootSha256`);
    if (!Number.isSafeInteger(entry.count) || entry.count < 0 || entry.count > 9_500_000 ||
      (entry.count === 0 && entry.rootSha256 !== adjustmentSha256(canonicalJsonBytes([])))) {
      throw new TypeError("unsupported input class differs");
    }
    // omit the intentionally absent non-rain gate class from missing diagnostics
    if (entry.count === 0 && (value.family === "rain" || name !== "rain_gate_input")) {
      zeroClasses.push(name);
    }
  }
  const identity = {
    contractVersion: "adjustment-terminal-no-action-identity/v3",
    disposition: "support_failed",
    policyReportSha256: value.policyReportSha256,
    registrationSha256: value.registrationSha256,
  };

  // require missing-class truth, real candidate bytes and a no-action-only identity
  if (JSON.stringify(zeroClasses) !== JSON.stringify(value.missingClassNames) ||
    value.inputClasses.candidate.count !== 1 || value.inputClasses.artifact.count < 1 ||
    value.requiredInputRootSha256 !== adjustmentSha256(canonicalJsonBytes(value.inputClasses)) ||
    value.actionSha256 !== adjustmentSha256(canonicalJsonBytes(identity)) ||
    value.candidateReportSha256 !== value.policyReportSha256 ||
    (value.sequence === "0") !== (value.predecessorProofSha256 === null) ||
    Date.parse(value.finalizedAt) < Date.parse(value.fullGraphVerifiedAt)) {
    throw new Error("unsupported terminal proof identity differs");
  }
  return Object.freeze(value);
}

// validate common genuine missing-evidence fields
function validateUnsupportedMissingEvidence(value) {
  if (!Array.isArray(value.missingClassNames) ||
    value.missingClassNames.some((name) => !FUTURE_INPUT_CLASS_NAMES.includes(name)) ||
    new Set(value.missingClassNames).size !== value.missingClassNames.length ||
    value.missingClassNames.some((name, index) =>
      name !== [...value.missingClassNames].sort()[index]) ||
    !Number.isSafeInteger(value.missingKeyCount) || value.missingKeyCount < 1 ||
    value.missingKeyCount > 9_500_000 ||
    !new Set([
      "permanent_capture_gap", "permanent_source_gap", "permanent_target_gap",
    ]).has(value.unsupportedReason)) {
    throw new TypeError("unsupported missing evidence differs");
  }
  requireSha256(value.missingKeySetSha256, "unsupported missingKeySetSha256");
}

// validate one sanitized live source authority response
function validateAdjustmentFamilyReleaseCurrent(value, family) {
  requireExactKeys(value, [
    "activeInstalledReceiptSha256", "catalogSha256", "commit",
    "controlInstalledReceiptSha256", "contractVersion", "family", "release",
    "settingsSha256", "shadowInstalledReceiptSha256", "sourceServerImageDigest",
  ], "family current authority");
  requireSha256(value.catalogSha256, "catalogSha256");
  requireSha256(value.settingsSha256, "settingsSha256");
  requireNullableSha256(value.activeInstalledReceiptSha256,
    "activeInstalledReceiptSha256");
  requireNullableSha256(value.controlInstalledReceiptSha256,
    "controlInstalledReceiptSha256");
  requireNullableSha256(value.shadowInstalledReceiptSha256,
    "shadowInstalledReceiptSha256");

  // accept only the requested family and closed immutable deployment identities
  if (value.contractVersion !== "adjustment-family-release-current-status/v1" ||
    value.family !== family || typeof value.commit !== "string" ||
    (family !== "rain" && value.controlInstalledReceiptSha256 !== null) ||
    !/^[a-f0-9]{40}$/u.test(value.commit) || typeof value.release !== "string" ||
    !/^\d{4}\.\d{2}\.\d{2}-[1-9]\d{0,2}$/u.test(value.release) ||
    typeof value.sourceServerImageDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(value.sourceServerImageDigest)) {
    throw new TypeError("family current authority is invalid");
  }
  return Object.freeze(value);
}

// read the one root-authenticated future-only capture epoch
export async function fetchAdjustmentRevisionCaptureEpochWitness(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-capture-epoch-v1",
    [],
    validateAdjustmentFutureOnlyEpochWitness,
    options,
  );
}

// read the exact zero-frontier snapshot retained beside the capture epoch
export async function fetchAdjustmentRevisionCaptureEpochSnapshot(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-capture-epoch-snapshot-v1",
    [],
    validateAdjustmentRevisionServingSnapshot,
    options,
  );
}

// read the exact full-0021 database ledger and its authenticated server clock
export async function fetchAdjustmentMaintenanceDatabaseLedger(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-database-ledger-v3",
    [],
    validateAdjustmentMaintenanceDatabaseLedger,
    options,
  );
}

// read one authenticated finite schedule head and all family slots
export async function fetchAdjustmentRegistrationScheduleStatus(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-registration-schedule-status-v3",
    [],
    validateAdjustmentRegistrationScheduleStatus,
    options,
  );
}

// fetch the active v3 registrations and their reconciled predecessors
export async function fetchAdjustmentRegistrationLifecycleStatus(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-registration-lifecycle-status-v4",
    [],
    validateAdjustmentRegistrationLifecycleStatus,
    options,
  );
}

// initialize the owner-only rolling schedule from the retained epoch bootstrap
export async function initializeAdjustmentRegistrationSchedule(input, options = {}) {
  requireExactKeys(input, ["bootstrap"], "registration schedule initialization");
  requirePlainObject(options, "registration schedule initialization options");

  // permit only isolated process injection at this privileged transport boundary
  if (Object.keys(options).some((key) => key !== "spawnImpl") ||
    (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function")) {
    throw new TypeError("registration schedule initialization options are invalid");
  }
  const bootstrap = input.bootstrap;
  requireExactKeys(bootstrap, [
    "bootstrapSha256", "contractVersion", "epochAt", "epochWitnessSha256",
    "firstCompleteLocalDate", "horizonEndAt", "scheduleContractSha256",
  ], "registration schedule bootstrap");
  requireSha256(bootstrap.bootstrapSha256, "bootstrapSha256");
  requireSha256(bootstrap.epochWitnessSha256, "epochWitnessSha256");
  requireInstant(bootstrap.epochAt, "epochAt");
  requireInstant(bootstrap.horizonEndAt, "horizonEndAt");

  // require the shared planner contract before opening ssh
  if (bootstrap.contractVersion !== "adjustment-registration-schedule-bootstrap/v3" ||
    bootstrap.scheduleContractSha256 !== ADJUSTMENT_ROLLING_SCHEDULE_SHA256 ||
    !/^20\d{2}-\d{2}-\d{2}$/u.test(bootstrap.firstCompleteLocalDate)) {
    throw new TypeError("registration schedule bootstrap is invalid");
  }
  const expectedBootstrap = buildAdjustmentRollingScheduleBootstrap({
    epochAt: bootstrap.epochAt,
    epochWitnessSha256: bootstrap.epochWitnessSha256,
  });

  // reject a caller-selected horizon or full-document hash substitution before ssh
  if (!canonicalJsonBytes(expectedBootstrap).equals(canonicalJsonBytes(bootstrap))) {
    throw new TypeError("registration schedule bootstrap differs");
  }
  const bytes = canonicalJsonBytes(bootstrap);
  const spawnImpl = options.spawnImpl ?? spawn;
  const sshAgentSocket = spawnImpl === spawn
    ? await requireControllerSshAgentSocket()
    : undefined;
  const child = spawnImpl("/usr/bin/ssh", [
    "-F", CONTROLLER_SSH_CONFIG,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "--", CONTROLLER_REMOTE_HOST,
    "adjustment-registration-schedule-initialize-v3",
    bootstrap.bootstrapSha256,
  ], {
    env: {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      ...(sshAgentSocket === undefined ? {} : { SSH_AUTH_SOCK: sshAgentSocket }),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(bytes);
  const responseBytes = await collectAdjustmentRevisionColdResult(child);
  let value;

  // accept only the root-validated canonical database result
  try {
    value = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    throw new Error("registration_schedule_response_invalid");
  }
  requireExactKeys(value, ["bootstrapSha256", "initialized", "scheduleContractSha256"],
    "registration schedule initialization response");

  // bind the response to this exact bootstrap without treating retries as failure
  if (!canonicalJsonBytes(value).equals(responseBytes) ||
    value.bootstrapSha256 !== bootstrap.bootstrapSha256 ||
    typeof value.initialized !== "boolean" ||
    value.scheduleContractSha256 !== ADJUSTMENT_ROLLING_SCHEDULE_SHA256) {
    throw new Error("registration_schedule_response_invalid");
  }
  return Object.freeze(value);
}

// install one canonical future-only input seal through the fixed privileged boundary
export async function installAdjustmentFutureOnlyInputSeal(input, options = {}) {
  requireExactKeys(input, ["seal"], "future-only input seal installation");
  const seal = validateAdjustmentFutureOnlyInputSeal(input.seal);
  const bytes = canonicalJsonBytes(seal);
  const sealSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-future-input-seal-install-v2", sealSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentFutureOnlyInputSealInstallation(value);
      if (response.sealSha256 !== sealSha256) {
        throw new TypeError("future-only input seal installation response differs");
      }
      return response;
    },
  });
}

// read the exact predecessor seal for one recurring terminal sequence
export async function fetchAdjustmentFutureOnlyInputSealCurrent(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-future-input-seal-current-v2",
    [],
    validateAdjustmentFutureOnlyInputSealCurrent,
    options,
  );
}

// install one transferred v3 anchor after the exact input seal is durable
export async function installAdjustmentMaintenanceAnchorV3(input, options = {}) {
  requireExactKeys(input, ["anchor"], "future-only anchor installation");
  const anchor = validateAdjustmentMaintenanceAnchorV3(input.anchor);

  // prohibit sending an already-finalized anchor through the T transition
  if (anchor.ctfState !== "transferred") {
    throw new TypeError("future-only transferred anchor is invalid");
  }
  const bytes = canonicalJsonBytes(anchor);
  const anchorSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-maintenance-anchor-install-v3", anchorSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentMaintenanceAnchorInstallationV3(value);
      if (response.anchorSha256 !== anchorSha256) {
        throw new TypeError("future-only anchor installation response differs");
      }
      return response;
    },
  });
}

// read the exact predecessor v3 anchor for one recurring terminal sequence
export async function fetchAdjustmentMaintenanceAnchorCurrentV3(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-maintenance-anchor-current-v3",
    [],
    validateAdjustmentMaintenanceAnchorCurrentV3,
    options,
  );
}

// build one shadow-only authority from an exact packed-custody acknowledgement
export function buildAdjustmentDevelopmentCustodyAnchor(input) {
  requireExactKeys(input, [
    "acknowledgement", "actionSha256", "artifactSha256", "candidateGraphSha256",
    "candidateSha256", "captureEpochWitnessSha256", "controlSha256",
    "controlVersion", "developmentGraphSha256", "dueKey", "family",
    "fullGraphVerifiedAt", "inputHeadSha256", "lifecycleLedgerRootSha256",
    "policyReportSha256", "predecessorAnchorSha256", "registrationSha256",
    "sequence", "sourceCommit", "sourceSha256",
  ], "development custody anchor input");
  const acknowledgement = validateAdjustmentRevisionColdCustodyAcknowledgementV2(
    input.acknowledgement,
  );
  const anchor = {
    actionKind: "shadow",
    actionSha256: input.actionSha256,
    archiveCommitOrdinal: acknowledgement.nextArchiveCommitOrdinal,
    artifactSha256: input.artifactSha256,
    candidateGraphSha256: input.candidateGraphSha256,
    candidateSha256: input.candidateSha256,
    captureEpochWitnessSha256: input.captureEpochWitnessSha256,
    contractVersion: "adjustment-development-custody-anchor/v1",
    controlSha256: input.controlSha256,
    controlVersion: input.controlVersion,
    custodyAcknowledgedAt: acknowledgement.acknowledgedAt,
    custodyAcknowledgementSha256: acknowledgement.acknowledgementSha256,
    custodyCheckpointSha256: acknowledgement.custodyCheckpointSha256,
    developmentGraphSha256: input.developmentGraphSha256,
    dueKey: input.dueKey,
    family: input.family,
    frontierSha256: acknowledgement.nextFrontierSha256,
    fullGraphVerifiedAt: input.fullGraphVerifiedAt,
    inputHeadSha256: input.inputHeadSha256,
    lifecycleLedgerRootSha256: input.lifecycleLedgerRootSha256,
    memberRootSha256: acknowledgement.memberRootSha256,
    pageSha256: acknowledgement.pageSha256,
    policyReportSha256: input.policyReportSha256,
    predecessorAnchorSha256: input.predecessorAnchorSha256,
    registrationSha256: input.registrationSha256,
    sequence: input.sequence,
    sourceCommit: input.sourceCommit,
    sourceSha256: input.sourceSha256,
    startMemberSha256: acknowledgement.startMemberSha256,
    startSha256: acknowledgement.startSha256,
  };
  return validateAdjustmentDevelopmentCustodyAnchorV1(anchor);
}

// build one custody-only rain control anchor from an exact packed acknowledgement
export function buildAdjustmentRainControlCustodyAnchor(input) {
  requireExactKeys(input, [
    "acknowledgement", "actionSha256", "captureEpochWitnessSha256", "controlSha256",
    "controlStateSha256", "controlVersion", "dueMonth", "fencingToken",
    "fullGraphVerifiedAt", "graphManifestSha256", "ordinalArtifactSha256",
    "predecessorAnchorSha256", "sequence", "sourceCommit", "sourceMemberRootSha256",
    "sourceReceiptRootSha256", "workstationJournalHeadSha256",
  ], "rain control custody anchor input");
  const acknowledgement = validateAdjustmentRevisionColdCustodyAcknowledgementV2(
    input.acknowledgement,
  );
  const anchor = {
    actionKind: "control_reference",
    actionSha256: input.actionSha256,
    archiveCommitOrdinal: acknowledgement.nextArchiveCommitOrdinal,
    captureEpochWitnessSha256: input.captureEpochWitnessSha256,
    contractVersion: "adjustment-rain-control-custody-anchor/v1",
    controlSha256: input.controlSha256,
    controlStateSha256: input.controlStateSha256,
    controlVersion: input.controlVersion,
    custodyAcknowledgedAt: acknowledgement.acknowledgedAt,
    custodyAcknowledgementSha256: acknowledgement.acknowledgementSha256,
    custodyCheckpointSha256: acknowledgement.custodyCheckpointSha256,
    dueMonth: input.dueMonth,
    fencingToken: input.fencingToken,
    frontierSha256: acknowledgement.nextFrontierSha256,
    fullGraphVerifiedAt: input.fullGraphVerifiedAt,
    graphManifestSha256: input.graphManifestSha256,
    memberRootSha256: acknowledgement.memberRootSha256,
    ordinalArtifactSha256: input.ordinalArtifactSha256,
    pageSha256: acknowledgement.pageSha256,
    predecessorAnchorSha256: input.predecessorAnchorSha256,
    sequence: input.sequence,
    sourceCommit: input.sourceCommit,
    sourceMemberRootSha256: input.sourceMemberRootSha256,
    sourceReceiptRootSha256: input.sourceReceiptRootSha256,
    startMemberSha256: acknowledgement.startMemberSha256,
    startSha256: acknowledgement.startSha256,
    workstationJournalHeadSha256: input.workstationJournalHeadSha256,
  };
  return validateAdjustmentRainControlCustodyAnchorV1(anchor);
}

// install one development-only anchor before any family mutation
export async function installAdjustmentDevelopmentCustodyAnchor(input, options = {}) {
  requireExactKeys(input, ["anchor"], "development custody anchor installation");
  const anchor = validateAdjustmentDevelopmentCustodyAnchorV1(input.anchor);
  const bytes = canonicalJsonBytes(anchor);
  const anchorSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-development-custody-anchor-install-v1", anchorSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentDevelopmentCustodyAnchorInstallation(value);

      // bind the server response to the exact caller document
      if (response.anchorSha256 !== anchorSha256) {
        throw new TypeError("development custody anchor installation response differs");
      }
      return response;
    },
  });
}

// read the only server-retained development anchor predecessor
export async function fetchAdjustmentDevelopmentCustodyAnchorCurrent(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-development-custody-anchor-current-v1",
    [],
    validateAdjustmentDevelopmentCustodyAnchorCurrent,
    options,
  );
}

// install one control-only anchor before the fenced family release
export async function installAdjustmentRainControlCustodyAnchor(input, options = {}) {
  requireExactKeys(input, ["anchor"], "rain control custody anchor installation");
  const anchor = validateAdjustmentRainControlCustodyAnchorV1(input.anchor);
  const bytes = canonicalJsonBytes(anchor);
  const anchorSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-rain-control-custody-anchor-install-v1", anchorSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentRainControlCustodyAnchorInstallation(value);

      // bind the root response to the exact installed custody bytes
      if (response.anchorSha256 !== anchorSha256) {
        throw new TypeError("rain control custody installation response differs");
      }
      return response;
    },
  });
}

// read the bounded predecessor for one later pre-month reference
export async function fetchAdjustmentRainControlCustodyAnchorCurrent(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-rain-control-custody-anchor-current-v1",
    [],
    validateAdjustmentRainControlCustodyAnchorCurrent,
    options,
  );
}

// install one terminal-only unsupported proof without granting model authority
export async function installAdjustmentUnsupportedTerminalProof(input, options = {}) {
  requireExactKeys(input, ["proof"], "unsupported terminal proof installation");
  const proof = validateAdjustmentUnsupportedTerminalProofV1(input.proof);
  const bytes = canonicalJsonBytes(proof);
  const proofSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-unsupported-terminal-proof-install-v1", proofSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentUnsupportedTerminalProofInstallation(value);

      // bind the root response to the exact unsupported proof bytes
      if (response.proofSha256 !== proofSha256) {
        throw new TypeError("unsupported terminal proof installation response differs");
      }
      return response;
    },
  });
}

// read the bounded predecessor for one later unsupported terminal proof
export async function fetchAdjustmentUnsupportedTerminalProofCurrent(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-unsupported-terminal-proof-current-v1",
    [],
    validateAdjustmentUnsupportedTerminalProofCurrent,
    options,
  );
}

// read the only pending compact-metadata custody proof and preparation
export async function fetchAdjustmentShadowMetadataCustodyStatus(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-shadow-metadata-custody-status-v1",
    [],
    validateAdjustmentShadowMetadataCustodyStatus,
    options,
  );
}

// finalize one exact compact-metadata proof through the owner bridge
export async function finalizeAdjustmentShadowMetadataCustody(input, options = {}) {
  requireExactKeys(input, ["proofSha256"], "shadow metadata custody finalization");
  requireSha256(input.proofSha256, "proofSha256");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-shadow-metadata-custody-finalize-v1",
    [input.proofSha256],
    (value) => {
      const response = validateAdjustmentShadowMetadataCustodyConsumption(value);

      // bind retries and first completion to the requested retained proof
      if (response.proofSha256 !== input.proofSha256) {
        throw new TypeError("shadow metadata custody consumption differs");
      }
      return response;
    },
    options,
  );
}

// consume one pending custody proof without granting qualification authority
export async function reconcileAdjustmentShadowMetadataCustody(options = {}) {
  requirePlainObject(options, "shadow metadata custody reconciliation options");
  const allowed = new Set(["fetchStatus", "finalize"]);

  // permit only isolated transport injection for controller tests
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    (options.fetchStatus !== undefined && typeof options.fetchStatus !== "function") ||
    (options.finalize !== undefined && typeof options.finalize !== "function")) {
    throw new TypeError("shadow metadata custody reconciliation options are invalid");
  }
  const fetchStatus = options.fetchStatus ?? fetchAdjustmentShadowMetadataCustodyStatus;
  const finalize = options.finalize ?? finalizeAdjustmentShadowMetadataCustody;
  const status = validateAdjustmentShadowMetadataCustodyStatus(await fetchStatus());

  // leave an empty server checkpoint untouched
  if (status.proof === null) {
    return { state: "idle" };
  }
  const consumption = validateAdjustmentShadowMetadataCustodyConsumption(
    await finalize({ proofSha256: status.proof.proofSha256 }),
  );

  // retain only the exact proof completion as custody evidence
  if (consumption.proofSha256 !== status.proof.proofSha256) {
    throw new Error("shadow metadata custody reconciliation differs");
  }
  return { consumption, state: "consumed" };
}

// finalize one transferred v3 anchor with its external canonical proof
export async function finalizeAdjustmentMaintenanceAnchorV3(input, options = {}) {
  requireExactKeys(input, ["proof"], "future-only anchor finalization");
  const proof = validateAdjustmentMaintenanceFinalizationProofV3(input.proof);
  const bytes = canonicalJsonBytes(proof);
  const finalizationProofSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-maintenance-anchor-finalize-v3", finalizationProofSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentMaintenanceAnchorFinalizationV3(value);
      if (response.finalizationProofSha256 !== finalizationProofSha256) {
        throw new TypeError("future-only anchor finalization response differs");
      }
      return response;
    },
  });
}

// burn one native confirmation access through the owner-only fixed bridge
export async function burnAdjustmentConfirmationAccessV3(input, options = {}) {
  requireExactKeys(input, ["request"], "confirmation access burn operation");
  const request = validateAdjustmentConfirmationAccessBurnRequestV3(input.request);
  const bytes = canonicalJsonBytes(request);
  const requestSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-confirmation-access-burn-v3", requestSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentConfirmationAccessBurnResultV3(value);

      // bind the owner response to both local and database registration domains
      if (response.localAccessSha256 !== request.localBurn.accessSha256 ||
        response.nativeAccess.registrationSha256 !==
          request.shadowRegistration.registrationSha256 ||
        response.nativeAccess.journalHeadSha256 !== request.journalHeadSha256 ||
        response.nativeAccess.expectedKeySetSha256 !==
          request.localBurn.expectedKeySetSha256 ||
        response.nativeAccess.gateManifestSha256 !==
          request.localBurn.gateManifestSha256 ||
        response.nativeAccess.eligiblePredictionSetSha256 !==
          request.archive.eligiblePredictionSetSha256 ||
        response.nativeAccess.revisionCatalogWatermarkSha256 !==
          request.localBurn.revisionCatalogWatermarkSha256 ||
        response.nativeAccess.targetComparatorSnapshotRootSha256 !==
          request.localBurn.targetComparatorSnapshotRootSha256 ||
        response.nativeAccess.targetCutoffAt !== request.localBurn.targetCutoffAt) {
        throw new TypeError("confirmation access burn response binding differs");
      }
      return response;
    },
  });
}

// record one finalized terminal result through the owner-only fixed bridge
export async function recordAdjustmentShadowTerminalV3(input, options = {}) {
  requireExactKeys(input, ["request"], "shadow terminal record operation");
  const request = validateAdjustmentShadowTerminalRecordRequestV3(input.request);
  const bytes = canonicalJsonBytes(request);
  const requestSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-shadow-terminal-record-v3", requestSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentShadowTerminalRecordResultV3(value);

      // bind reconciliation to the exact requested registration and final proof
      if (response.registrationSha256 !==
          request.shadowRegistration.registrationSha256 ||
        response.terminalRecord.accessSha256 !== request.nativeAccess.accessSha256 ||
        response.terminalRecord.actionSha256 !== request.finalizationProof.actionSha256 ||
        response.terminalRecord.terminalMemberSha256 !==
          request.finalizationProof.fullMemberRootSha256 ||
        response.terminalRecord.maintenanceAnchorSha256 !==
          request.finalizationProof.transferredAnchorSha256) {
        throw new TypeError("shadow terminal record response binding differs");
      }
      return response;
    },
  });
}

// retire one exact reconciled terminal registration through the owner bridge
export async function retireAdjustmentShadowTerminalV3(input, options = {}) {
  requireExactKeys(input, ["request"], "shadow terminal retirement operation");
  const request = validateAdjustmentShadowTerminalRetirementRequestV3(input.request);
  const bytes = canonicalJsonBytes(request);
  const requestSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-shadow-terminal-retire-v3", requestSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentShadowTerminalRetirementResultV3(value);

      // bind retirement to the exact reconciled tombstone
      if (response.registrationSha256 !== request.registrationSha256 ||
        response.reconciliationSha256 !== request.terminalRecord.reconciliationSha256) {
        throw new TypeError("shadow terminal retirement response binding differs");
      }
      return response;
    },
  });
}

// record one unsupported failed member through its disjoint owner bridge
export async function recordAdjustmentShadowUnsupportedTerminalV1(input, options = {}) {
  requireExactKeys(input, ["request"], "unsupported shadow terminal record operation");
  const request = validateAdjustmentShadowUnsupportedTerminalRecordRequestV1(input.request);
  const bytes = canonicalJsonBytes(request);
  const requestSha256 = adjustmentSha256(bytes);
  const proofSha256 = adjustmentSha256(canonicalJsonBytes(request.unsupportedProof));
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-shadow-unsupported-terminal-record-v1", requestSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentShadowTerminalRecordResultV3(value);

      // bind the actual failed row to the installed unsupported proof
      if (response.registrationSha256 !== request.shadowRegistration.registrationSha256 ||
        response.terminalRecord.accessSha256 !== request.nativeAccess.accessSha256 ||
        response.terminalRecord.actionSha256 !== request.unsupportedProof.actionSha256 ||
        response.terminalRecord.terminalMemberSha256 !==
          request.unsupportedProof.fullMemberRootSha256 ||
        response.terminalRecord.maintenanceAnchorSha256 !== proofSha256) {
        throw new TypeError("unsupported shadow terminal record response binding differs");
      }
      return response;
    },
  });
}

// retire one reconciled unsupported registration through the owner bridge
export async function retireAdjustmentShadowUnsupportedTerminalV1(input, options = {}) {
  requireExactKeys(input, ["request"], "unsupported shadow terminal retirement operation");
  const request = validateAdjustmentShadowUnsupportedTerminalRetirementRequestV1(input.request);
  const bytes = canonicalJsonBytes(request);
  const requestSha256 = adjustmentSha256(bytes);
  return await requestAdjustmentMaintenanceStdinDocument({
    arguments_: ["adjustment-shadow-unsupported-terminal-retire-v1", requestSha256],
    bytes,
    options,
    validate: (value) => {
      const response = validateAdjustmentShadowTerminalRetirementResultV3(value);

      // bind retirement to the exact unsupported reconciliation tombstone
      if (response.registrationSha256 !== request.registrationSha256 ||
        response.reconciliationSha256 !== request.terminalRecord.reconciliationSha256) {
        throw new TypeError("unsupported shadow terminal retirement response binding differs");
      }
      return response;
    },
  });
}

// validate one owner-native access response and its independently derived identity
function validateAdjustmentConfirmationAccessBurnResultV3(value) {
  requireExactKeys(value, [
    "contractVersion", "localAccessSha256", "nativeAccess", "nativeAccessSha256",
    "state",
  ], "confirmation access burn result");
  requireSha256(value.localAccessSha256, "localAccessSha256");
  requireExactKeys(value.nativeAccess, [
    "accessSha256", "accessedAt", "eligiblePredictionSetSha256",
    "expectedKeySetSha256", "gateManifestSha256", "journalHeadSha256",
    "maintenanceAnchorSha256", "metadataRootSha256", "registrationSha256",
    "revisionCatalogWatermarkSha256", "targetComparatorSnapshotRootSha256",
    "targetCutoffAt",
  ], "native confirmation access");
  // validate every named identity under the native access domain
  for (const [field, fieldValue] of Object.entries(value.nativeAccess)) {
    if (field.endsWith("Sha256")) {
      requireSha256(fieldValue, `native access ${field}`);
    }
  }
  requireInstant(value.nativeAccess.accessedAt, "native access accessedAt");
  requireInstant(value.nativeAccess.targetCutoffAt, "native access targetCutoffAt");
  const nativeIdentity = adjustmentSha256(Buffer.from([
    "adjustment-confirmation-access/v2",
    value.nativeAccess.registrationSha256,
    value.nativeAccess.journalHeadSha256,
    value.nativeAccess.maintenanceAnchorSha256,
    value.nativeAccess.gateManifestSha256,
    value.nativeAccess.eligiblePredictionSetSha256,
    value.nativeAccess.expectedKeySetSha256,
    value.nativeAccess.metadataRootSha256,
    value.nativeAccess.targetComparatorSnapshotRootSha256,
    value.nativeAccess.revisionCatalogWatermarkSha256,
    value.nativeAccess.targetCutoffAt,
  ].join("\n"), "utf8"));

  // require exact root projection literals and the native preimage hash
  if (value.contractVersion !== "adjustment-confirmation-access-burn-result/v3" ||
    value.state !== "burned" || value.nativeAccessSha256 !== nativeIdentity ||
    value.nativeAccess.accessSha256 !== nativeIdentity) {
    throw new TypeError("confirmation access burn result differs");
  }
  return value;
}

// validate one actual owner terminal row returned after reconciliation
function validateAdjustmentShadowTerminalRecordResultV3(value) {
  requireExactKeys(value, [
    "contractVersion", "reconciliationSha256", "registrationSha256", "state",
    "terminalRecord",
  ], "shadow terminal record result");
  requireSha256(value.reconciliationSha256, "reconciliationSha256");
  requireSha256(value.registrationSha256, "registrationSha256");
  requireExactKeys(value.terminalRecord, [
    "accessSha256", "actionCompletedAt", "actionDisposition", "actionSha256",
    "candidateSha256", "contractVersion", "family", "finalizedMetadataRootSha256",
    "finalizedPredictionCount", "maintenanceAnchorSha256", "metadataGeneration",
    "recordedAt", "reconciliationSha256", "registrationSha256", "reservedKeySha256",
    "sourceSha256", "terminalMemberSha256", "terminalResultSha256",
  ], "shadow terminal record");
  // validate every terminal row identity without accepting hash aliases
  for (const [field, fieldValue] of Object.entries(value.terminalRecord)) {
    if (field.endsWith("Sha256")) {
      requireSha256(fieldValue, `terminal record ${field}`);
    }
  }
  requireInstant(value.terminalRecord.actionCompletedAt,
    "terminal record actionCompletedAt");
  requireInstant(value.terminalRecord.recordedAt, "terminal record recordedAt");

  // crossbind the envelope to the actual retained row
  if (value.contractVersion !== "adjustment-shadow-terminal-record-result/v3" ||
    value.state !== "recorded" || value.terminalRecord.contractVersion !==
      "adjustment-shadow-terminal-record/v3" ||
    value.terminalRecord.reconciliationSha256 !== value.reconciliationSha256 ||
    value.terminalRecord.registrationSha256 !== value.registrationSha256 ||
    !FAMILIES.includes(value.terminalRecord.family) ||
    !Number.isSafeInteger(value.terminalRecord.metadataGeneration) ||
    value.terminalRecord.metadataGeneration < 1 ||
    !Number.isSafeInteger(value.terminalRecord.finalizedPredictionCount) ||
    value.terminalRecord.finalizedPredictionCount < 1) {
    throw new TypeError("shadow terminal record result differs");
  }
  return value;
}

// validate one exact owner retirement response
function validateAdjustmentShadowTerminalRetirementResultV3(value) {
  requireExactKeys(value, [
    "contractVersion", "reconciliationSha256", "registrationSha256", "state",
  ], "shadow terminal retirement result");
  requireSha256(value.reconciliationSha256, "reconciliationSha256");
  requireSha256(value.registrationSha256, "registrationSha256");

  // accept only the closed successful owner projection
  if (value.contractVersion !== "adjustment-shadow-terminal-retirement-result/v3" ||
    value.state !== "retired") {
    throw new TypeError("shadow terminal retirement result differs");
  }
  return value;
}

// send one bounded canonical stdin document and require one canonical response
async function requestAdjustmentMaintenanceStdinDocument(input) {
  requireExactKeys(input, ["arguments_", "bytes", "options", "validate"],
    "maintenance stdin document request");
  requirePlainObject(input.options, "maintenance stdin document options");

  // permit only isolated process injection at this privileged transport boundary
  if (Object.keys(input.options).some((key) => key !== "spawnImpl") ||
    (input.options.spawnImpl !== undefined && typeof input.options.spawnImpl !== "function") ||
    !Array.isArray(input.arguments_) || !Buffer.isBuffer(input.bytes) ||
    typeof input.validate !== "function") {
    throw new TypeError("maintenance stdin document request is invalid");
  }
  const spawnImpl = input.options.spawnImpl ?? spawn;
  const sshAgentSocket = spawnImpl === spawn
    ? await requireControllerSshAgentSocket()
    : undefined;
  const child = spawnImpl("/usr/bin/ssh", [
    "-F", CONTROLLER_SSH_CONFIG,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "--", CONTROLLER_REMOTE_HOST,
    ...input.arguments_,
  ], {
    env: {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      ...(sshAgentSocket === undefined ? {} : { SSH_AUTH_SOCK: sshAgentSocket }),
    },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(input.bytes);
  const responseBytes = await collectAdjustmentRevisionColdResult(child);
  let value;

  // accept only one complete canonical JSON response
  try {
    value = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    throw new Error("maintenance_stdin_response_invalid");
  }
  if (!canonicalJsonBytes(value).equals(responseBytes)) {
    throw new Error("maintenance_stdin_response_invalid");
  }
  try {
    return Object.freeze(input.validate(value));
  } catch {
    throw new Error("maintenance_stdin_response_invalid");
  }
}

// validate one closed full-ledger projection without accepting private payloads
function validateAdjustmentMaintenanceDatabaseLedger(value) {
  requireExactKeys(value, ["contractVersion", "databaseManifest", "snapshotAt"],
    "adjustment database ledger");
  const databaseManifest = validateAdjustmentV14RollingDatabaseManifest(
    value.databaseManifest,
  );
  requireInstant(value.snapshotAt, "snapshotAt");

  // retain only the typed v3 response emitted by the root projector
  if (value.contractVersion !== "adjustment-database-ledger/v3") {
    throw new TypeError("adjustment database ledger is invalid");
  }
  return Object.freeze({ ...value, databaseManifest });
}

// validate one root-authenticated rolling horizon and fixed family slot set
function validateAdjustmentRegistrationScheduleStatus(value) {
  requireExactKeys(value, [
    "contractVersion", "epochAt", "epochWitnessSha256", "horizonEndAt",
    "scheduleContractSha256", "slots", "snapshotAt",
  ], "registration schedule status");
  requireInstant(value.epochAt, "epochAt");
  requireInstant(value.horizonEndAt, "horizonEndAt");
  requireInstant(value.snapshotAt, "snapshotAt");
  requireSha256(value.epochWitnessSha256, "epochWitnessSha256");
  requireSha256(value.scheduleContractSha256, "scheduleContractSha256");

  // require the shared contract, future horizon and exact fixed family order
  if (value.contractVersion !== "adjustment-registration-schedule-status/v3" ||
    value.scheduleContractSha256 !== ADJUSTMENT_ROLLING_SCHEDULE_SHA256 ||
    Date.parse(value.snapshotAt) < Date.parse(value.epochAt) ||
    Date.parse(value.horizonEndAt) <= Date.parse(value.epochAt) ||
    !Array.isArray(value.slots) || value.slots.length !== FAMILIES.length) {
    throw new TypeError("registration schedule status is invalid");
  }
  value.slots.forEach(
    // bind every family slot to the same authenticated schedule head
    (slot, index) => {
      validateAdjustmentRegistrationSlot(slot);
      if (slot.family !== FAMILIES[index] ||
        slot.epochWitnessSha256 !== value.epochWitnessSha256 ||
        slot.scheduleContractSha256 !== value.scheduleContractSha256 ||
        slot.horizonEndAt !== value.horizonEndAt) {
        throw new TypeError("registration schedule slot differs");
      }
    },
  );
  return Object.freeze({ ...value, slots: Object.freeze([...value.slots]) });
}

// validate one authenticated active-registration and predecessor projection
function validateAdjustmentRegistrationLifecycleStatus(value) {
  requireExactKeys(value, [
    "contractVersion", "entries", "epochAt", "epochWitnessSha256", "horizonEndAt",
    "scheduleContractSha256", "snapshotAt",
  ], "registration lifecycle status");

  // reuse the frozen schedule validator for top-level epoch and slot geometry
  const schedule = validateAdjustmentRegistrationScheduleStatus({
    contractVersion: "adjustment-registration-schedule-status/v3",
    epochAt: value.epochAt,
    epochWitnessSha256: value.epochWitnessSha256,
    horizonEndAt: value.horizonEndAt,
    scheduleContractSha256: value.scheduleContractSha256,
    slots: Array.isArray(value.entries)
      ? value.entries.map((entry) => entry?.slot)
      : [],
    snapshotAt: value.snapshotAt,
  });

  // accept only the closed v4 family order projected by the root boundary
  if (value.contractVersion !== "adjustment-registration-lifecycle-status/v4" ||
    !Array.isArray(value.entries) || value.entries.length !== FAMILIES.length) {
    throw new TypeError("registration lifecycle status is invalid");
  }
  value.entries.forEach(
    // crossbind each active row, metadata head and reconciled predecessor
    (entry, index) => {
      requireExactKeys(entry, [
        "activeRegistration", "latestRegistrationSha256", "metadata", "predecessor", "slot",
      ], "registration lifecycle entry");
      const slot = schedule.slots[index];
      requireNullableSha256(entry.latestRegistrationSha256,
        "latestRegistrationSha256");
      const predecessor = validateRegistrationLifecyclePredecessor(
        entry.predecessor,
        schedule,
      );

      // expose active values only for a genuine occupied v3 slot
      if (slot.state === "busy_v3") {
        const registration = validateRollingShadowRegistration(entry.activeRegistration);
        validateRegistrationLifecycleMetadata(entry.metadata, schedule.snapshotAt);
        if (registration.family !== slot.family ||
          registration.registrationSha256 !== slot.registrationSha256 ||
          registration.registrationSha256 !== entry.latestRegistrationSha256 ||
          registration.terminalAt !== slot.terminalAt ||
          registration.epochWitnessSha256 !== schedule.epochWitnessSha256 ||
          registration.predecessorRegistrationSha256 !==
            (predecessor?.registrationSha256 ?? null) &&
            predecessor?.registrationSha256 !== registration.registrationSha256) {
          throw new TypeError("registration lifecycle active binding differs");
        }
        return;
      }

      // free and legacy slots cannot expose v3 active or metadata values
      if (entry.activeRegistration !== null || entry.metadata !== null ||
        slot.state === "free" && entry.latestRegistrationSha256 !==
          (predecessor?.registrationSha256 ?? null)) {
        throw new TypeError("registration lifecycle inactive binding differs");
      }
    },
  );
  return Object.freeze({
    ...value,
    entries: Object.freeze(value.entries.map((entry) => Object.freeze(entry))),
  });
}

// project the v4 lifecycle transaction into the existing planner contract
function registrationScheduleFromLifecycle(value) {
  const lifecycle = validateAdjustmentRegistrationLifecycleStatus(value);
  return validateAdjustmentRegistrationScheduleStatus({
    contractVersion: "adjustment-registration-schedule-status/v3",
    epochAt: lifecycle.epochAt,
    epochWitnessSha256: lifecycle.epochWitnessSha256,
    horizonEndAt: lifecycle.horizonEndAt,
    scheduleContractSha256: lifecycle.scheduleContractSha256,
    slots: lifecycle.entries.map(
      // preserve each exact database-owned slot without adding authority
      (entry) => entry.slot,
    ),
    snapshotAt: lifecycle.snapshotAt,
  });
}

// validate one reconciled future-only registration predecessor
function validateRegistrationLifecyclePredecessor(value, schedule) {
  if (value === null) {
    return null;
  }
  requireExactKeys(value, [
    "epochWitnessSha256", "reconciliationSha256", "registrationSha256",
    "reservedKeySha256", "scheduleContractSha256", "sourceSha256", "terminalAt",
  ], "registration lifecycle predecessor");
  // validate every predecessor identity under the shared epoch
  for (const field of [
    "epochWitnessSha256", "reconciliationSha256", "registrationSha256",
    "reservedKeySha256", "scheduleContractSha256", "sourceSha256",
  ]) {
    requireSha256(value[field], `registration lifecycle predecessor ${field}`);
  }
  requireInstant(value.terminalAt, "registration lifecycle predecessor terminalAt");

  // bind predecessor authority to the same epoch and completed transaction clock
  if (value.epochWitnessSha256 !== schedule.epochWitnessSha256 ||
    value.scheduleContractSha256 !== schedule.scheduleContractSha256 ||
    Date.parse(value.terminalAt) <= Date.parse(schedule.epochAt) ||
    Date.parse(value.terminalAt) > Date.parse(schedule.snapshotAt)) {
    throw new TypeError("registration lifecycle predecessor differs");
  }
  return value;
}

// validate one compact retained metadata root without reading predictions
function validateRegistrationLifecycleMetadata(value, snapshotAt) {
  requireExactKeys(value, [
    "finalizedPredictionCount", "generation", "lastAnchorSha256", "rootSha256", "throughAt",
  ], "registration lifecycle metadata");

  // require bounded integer counters and one actual root at every generation
  if (!Number.isInteger(value.generation) || value.generation < 0 ||
    value.generation > 2_147_483_647 || !Number.isInteger(value.finalizedPredictionCount) ||
    value.finalizedPredictionCount < 0 || value.finalizedPredictionCount > 2_147_483_647) {
    throw new TypeError("registration lifecycle metadata counter is invalid");
  }
  requireSha256(value.rootSha256, "registration lifecycle metadata rootSha256");
  requireNullableSha256(value.lastAnchorSha256,
    "registration lifecycle metadata lastAnchorSha256");

  // generation zero is the exact canonical empty metadata root
  if (value.generation === 0) {
    if (value.finalizedPredictionCount !== 0 || value.throughAt !== null ||
      value.lastAnchorSha256 !== null || value.rootSha256 !==
        "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945") {
      throw new TypeError("registration lifecycle empty metadata differs");
    }
    return value;
  }
  requireInstant(value.throughAt, "registration lifecycle metadata throughAt");

  // later generations require one anchored nonempty range no later than the snapshot
  if (value.finalizedPredictionCount < 1 || value.lastAnchorSha256 === null ||
    Date.parse(value.throughAt) > Date.parse(snapshotAt)) {
    throw new TypeError("registration lifecycle metadata differs");
  }
  return value;
}

// freeze one cutoff against the current server-authenticated database frontier
export async function fetchAdjustmentRevisionColdCurrentTransferStart(cutoffAt, options = {}) {
  requireInstant(cutoffAt, "cutoffAt");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-catalog-current-start-v1",
    [cutoffAt],
    validateAdjustmentRevisionColdTransferStart,
    options,
  );
}

// freeze one remote revision snapshot at the original maintenance cutoff
export async function fetchAdjustmentRevisionColdTransferStart(input, options = {}) {
  requireExactKeys(input, ["cutoffAt", "watermarkArchiveCommitOrdinal"],
    "revision catalog start request");
  requireInstant(input.cutoffAt, "cutoffAt");
  requireArchiveOrdinal(input.watermarkArchiveCommitOrdinal, "watermarkArchiveCommitOrdinal");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-catalog-start-v1",
    [input.cutoffAt, input.watermarkArchiveCommitOrdinal],
    validateAdjustmentRevisionColdTransferStart,
    options,
  );
}

// fetch one bounded direct-successor page from an immutable remote watermark
export async function fetchAdjustmentRevisionColdPage(input, options = {}) {
  requireExactKeys(input, [
    "afterArchiveCommitOrdinal", "afterFrontierSha256", "previousPageSha256",
    "startSha256", "watermarkArchiveCommitOrdinal", "watermarkFrontierSha256",
  ], "revision catalog page request");
  requireArchiveOrdinal(input.afterArchiveCommitOrdinal, "afterArchiveCommitOrdinal");
  requireArchiveOrdinal(input.watermarkArchiveCommitOrdinal, "watermarkArchiveCommitOrdinal");
  for (const name of [
    "afterFrontierSha256", "previousPageSha256", "startSha256",
    "watermarkFrontierSha256",
  ]) {
    requireSha256(input[name], name);
  }
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-catalog-page-v1",
    [
      input.watermarkArchiveCommitOrdinal,
      input.watermarkFrontierSha256,
      input.startSha256,
      input.afterArchiveCommitOrdinal,
      input.afterFrontierSha256,
      input.previousPageSha256,
    ],
    validateAdjustmentRevisionColdPage,
    options,
  );
}

// acknowledge one archived cold page through the fixed custody-only boundary
export async function acknowledgeAdjustmentRevisionColdCustody(input, options = {}) {
  requireExactKeys(input, [
    "afterArchiveCommitOrdinal", "afterFrontierSha256", "custodyCheckpointSha256",
    "memberRootSha256", "pageSha256", "previousPageSha256", "startMemberSha256",
    "startSha256", "watermarkArchiveCommitOrdinal", "watermarkFrontierSha256",
  ], "revision custody acknowledgement request");
  for (const name of ["afterArchiveCommitOrdinal", "watermarkArchiveCommitOrdinal"]) {
    requireArchiveOrdinal(input[name], name);
  }
  for (const name of [
    "afterFrontierSha256", "custodyCheckpointSha256", "memberRootSha256", "pageSha256",
    "previousPageSha256", "startSha256", "watermarkFrontierSha256",
  ]) {
    requireSha256(input[name], name);
  }
  requireNullableSha256(input.startMemberSha256, "startMemberSha256");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-custody-ack-v2",
    [
      input.watermarkArchiveCommitOrdinal,
      input.watermarkFrontierSha256,
      input.startSha256,
      input.afterArchiveCommitOrdinal,
      input.afterFrontierSha256,
      input.previousPageSha256,
      input.pageSha256,
      input.custodyCheckpointSha256,
      input.memberRootSha256,
      input.startMemberSha256 ?? "none",
    ],
    validateAdjustmentRevisionColdCustodyAcknowledgementV2,
    options,
  );
}

// fetch the fixed permanent-gap transfer frontier
export async function fetchAdjustmentRevisionGapTransferStart(options = {}) {
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-gap-start-v1",
    [],
    validateAdjustmentRevisionGapTransferStart,
    options,
  );
}

// fetch one pending page of actual unqualified staged bytes
export async function fetchAdjustmentRevisionGapPayloadPage(input, options = {}) {
  requireExactKeys(input, ["frontierSha256", "startSha256"],
    "revision gap page request");
  requireSha256(input.frontierSha256, "frontierSha256");
  requireSha256(input.startSha256, "startSha256");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-gap-page-v1",
    [input.startSha256, input.frontierSha256],
    validateAdjustmentRevisionGapPayloadPage,
    options,
  );
}

// acknowledge one page only after a verified durable graph publication
export async function acknowledgeAdjustmentRevisionGapPayload(input, options = {}) {
  requireExactKeys(input, ["graphManifestSha256", "pageSha256"],
    "revision gap acknowledgement request");
  requireSha256(input.graphManifestSha256, "graphManifestSha256");
  requireSha256(input.pageSha256, "pageSha256");
  return await requestAdjustmentRevisionColdDocument(
    "adjustment-revision-gap-ack-v1",
    [input.pageSha256, input.graphManifestSha256],
    validateAdjustmentRevisionGapPayloadAcknowledgement,
    options,
  );
}

// execute one closed revision-catalog read through the forced ssh account
async function requestAdjustmentRevisionColdDocument(operation, arguments_, validator, options) {
  requirePlainObject(options, "revision catalog request options");

  // permit only process injection for isolated transport tests
  if (Object.keys(options).some((key) => key !== "spawnImpl") ||
    (options.spawnImpl !== undefined && typeof options.spawnImpl !== "function")) {
    throw new TypeError("revision catalog request options are invalid");
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const sshAgentSocket = spawnImpl === spawn
    ? await requireControllerSshAgentSocket()
    : undefined;
  const child = spawnImpl("/usr/bin/ssh", [
    "-F", CONTROLLER_SSH_CONFIG,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=15",
    "--", CONTROLLER_REMOTE_HOST,
    operation,
    ...arguments_,
  ], {
    env: {
      HOME: homedir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      ...(sshAgentSocket === undefined ? {} : { SSH_AUTH_SOCK: sshAgentSocket }),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bytes = await collectAdjustmentRevisionColdResult(child);
  let value;

  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("revision_catalog_response_invalid");
  }

  // require the server's exact one-line JSON framing before semantic validation
  if (!Buffer.from(`${JSON.stringify(value)}\n`).equals(bytes)) {
    throw new Error("revision_catalog_response_invalid");
  }
  try {
    return validator(value);
  } catch {
    throw new Error("revision_catalog_response_invalid");
  }
}

// validate one value-free immutable attempt report
export function validateAdjustmentMaintenanceAttempt(value) {
  requireExactKeys(value, [
    "actionEligible",
    "attemptIdentitySha256",
    "candidateGraphSha256",
    "candidateSha256",
    "contractVersion",
    "dueKey",
    "family",
    "fitReceiptSha256",
    "inputHeadSha256",
    "lifecycleHeadSha256",
    "mode",
    "originalCutoffAt",
    "reason",
    "reservedConfirmationExposed",
    "semanticInputSha256",
    "servingChanged",
    "state",
  ], "maintenance attempt");

  // require one exact value-free attempt contract
  if (value.contractVersion !== ADJUSTMENT_MAINTENANCE_ATTEMPT_CONTRACT_VERSION ||
    typeof value.actionEligible !== "boolean" ||
    value.reservedConfirmationExposed !== false ||
    typeof value.servingChanged !== "boolean" || !ATTEMPT_STATES.has(value.state) ||
    !ATTEMPT_REASONS.has(value.reason)) {
    throw new TypeError("maintenance attempt contract is invalid");
  }
  requireDueKey(value.dueKey);
  requireFamilyOrNull(value.family);
  requireControllerMode(value.mode);
  requireInstant(value.originalCutoffAt, "originalCutoffAt");
  requireSha256(value.attemptIdentitySha256, "attemptIdentitySha256");
  requireSha256(value.inputHeadSha256, "inputHeadSha256");
  requireSha256(value.lifecycleHeadSha256, "lifecycleHeadSha256");
  requireNullableSha256(value.candidateGraphSha256, "candidateGraphSha256");
  requireNullableSha256(value.candidateSha256, "candidateSha256");
  requireNullableSha256(value.fitReceiptSha256, "fitReceiptSha256");
  requireNullableSha256(value.semanticInputSha256, "semanticInputSha256");

  // reserve mutation flags for one completed promotion outcome
  if ((value.reason === "daily_candidate_promoted") !== value.actionEligible ||
    value.servingChanged && !value.actionEligible) {
    throw new TypeError("maintenance attempt mutation flags are invalid");
  }

  // bind family presence to monthly work only
  if ((value.mode === "monthly") !== (value.family !== null)) {
    throw new TypeError("maintenance attempt family is invalid");
  }
  const hasCandidate = value.candidateGraphSha256 !== null && value.candidateSha256 !== null;

  // require candidate graph and candidate identity as one pair
  if ((value.candidateGraphSha256 === null) !== (value.candidateSha256 === null)) {
    throw new TypeError("maintenance attempt candidate identity is invalid");
  }

  // bind every outcome reason to its exact non-value evidence surface
  if (value.reason === "development_candidate_archived") {
    if (value.state !== "completed" || !hasCandidate || value.fitReceiptSha256 === null ||
      value.semanticInputSha256 === null || value.mode !== "monthly") {
      throw new TypeError("maintenance attempt completed outcome is invalid");
    }
  } else if (value.reason === "control_reference_archived") {
    if (value.state !== "completed" || hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "monthly" || value.family !== "rain" ||
      !value.dueKey.startsWith("control-reference/rain/")) {
      throw new TypeError("maintenance attempt control reference outcome is invalid");
    }
  } else if (value.reason === "candidate_archive_unavailable") {
    if (value.state !== "blocked" || hasCandidate || value.fitReceiptSha256 === null ||
      value.semanticInputSha256 === null || value.mode !== "monthly") {
      throw new TypeError("maintenance attempt candidate refusal is invalid");
    }
  } else if (value.reason === "fit_failed") {
    if (value.state !== "failed" || hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "monthly") {
      throw new TypeError("maintenance attempt fit failure is invalid");
    }
  } else if (value.reason === "candidate_parity_failed") {
    if (value.state !== "failed" || hasCandidate || value.fitReceiptSha256 === null ||
      value.semanticInputSha256 === null || value.mode !== "monthly") {
      throw new TypeError("maintenance attempt candidate parity failure is invalid");
    }
  } else if (value.reason === "monthly_no_candidate") {
    if (value.state !== "completed" || hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "monthly") {
      throw new TypeError("maintenance attempt no-candidate outcome is invalid");
    }
  } else if (new Set([
    "daily_candidate_rejected", "daily_no_registered_candidate", "daily_support_failed",
  ]).has(value.reason)) {
    if (value.state !== "completed" || value.actionEligible || value.servingChanged ||
      hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "daily") {
      throw new TypeError("maintenance attempt daily completion is invalid");
    }
  } else if (value.reason === "daily_candidate_promoted") {
    if (value.state !== "completed" || !value.actionEligible ||
      hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "daily") {
      throw new TypeError("maintenance attempt daily promotion is invalid");
    }
  } else if (new Set(["daily_history_pending", "daily_promotion_pending"])
    .has(value.reason)) {
    if (value.state !== "blocked" || value.actionEligible || value.servingChanged ||
      hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "daily") {
      throw new TypeError("maintenance attempt daily pending outcome is invalid");
    }
  } else if (value.reason === "daily_evaluation_failed") {
    if (value.state !== "failed" || hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "daily") {
      throw new TypeError("maintenance attempt daily failure is invalid");
    }
  } else if (value.reason === "family_slot_busy" ||
    value.reason === "registration_schedule_unavailable") {
    if (value.state !== "blocked" || hasCandidate || value.fitReceiptSha256 !== null ||
      value.semanticInputSha256 === null || value.mode !== "monthly") {
      throw new TypeError("maintenance attempt registration refusal is invalid");
    }
  } else if (value.state !== "blocked" || hasCandidate || value.fitReceiptSha256 !== null ||
    value.semanticInputSha256 !== null) {
    throw new TypeError("maintenance attempt blocked outcome is invalid");
  }
  return value;
}

// classify one permanent unsupported member from its actual absent semantic classes
function classifyAdjustmentUnsupportedTerminalReason(material) {
  requirePlainObject(material, "unsupported terminal material");
  const classes = buildAdjustmentMaintenanceInputClassMembers({
    artifactSha256: material.shadowRegistration.artifactSha256,
    candidateSha256: material.shadowRegistration.candidateSha256,
    family: material.assembly.family,
    rainGateInputMemberSha256s:
      material.assembly.rainGateInputMemberSha256s ?? [],
    terminalGraph: material.assembly.terminalGraph,
  });

  // classify an absent capsule/comparator population as a capture failure
  if (classes.shadow_body.length === 0 || classes.shadow_source.length === 0 ||
    classes.comparator.length === 0) {
    return "permanent_capture_gap";
  }

  // classify a missing derived or physical target population explicitly
  if (classes.target.length === 0 || classes.target_revision.length === 0) {
    return "permanent_target_gap";
  }
  return "permanent_source_gap";
}

// run only work supported by genuine semantic inputs
async function runDueWork({ due, now, inspection, ports }) {
  // complete a genuine no-candidate snapshot without inventing evaluation values
  if (inspection.state === "idle") {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "daily_no_registered_candidate",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "completed",
    };
  }

  // retain honest semantic refusal without fitting
  if (inspection.state === "blocked") {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: inspection.reason,
      semanticInputSha256: null,
      state: "blocked",
    };
  }

  // archive and publish one genuine pre-month reference without occupying the model slot
  if (due.dueKey.startsWith("control-reference/rain/")) {
    const material = validateRainControlReferenceMaterial(inspection.controlReferenceMaterial, due, now);
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      controlReferenceMaterial: material,
      fitReceiptSha256: null,
      reason: "control_reference_archived",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "completed",
    };
  }

  // evaluate only the closed terminal projection assembled from durable evidence
  if (due.mode === "daily") {
    // close a burned partial member through its disjoint proof and owner retirement
    if (inspection.dailyUnsupportedMaterial !== undefined) {
      await completeAdjustmentUnsupportedDailyTerminal({
        archive: ports.archive,
        dailyMaterial: inspection.dailyUnsupportedMaterial,
        due,
        epochWitness: inspection.dailyUnsupportedMaterial.epochWitness,
        journal: ports.journal,
        readHead: ports.readArchiveHead,
        semanticInputSha256: inspection.inputManifestSha256,
        unsupportedReason: classifyAdjustmentUnsupportedTerminalReason(
          inspection.dailyUnsupportedMaterial,
        ),
      });
      return {
        candidateGraphSha256: null,
        candidateSha256: null,
        fitReceiptSha256: null,
        reason: "daily_support_failed",
        semanticInputSha256: inspection.inputManifestSha256,
        state: "completed",
      };
    }
    let evaluation;

    try {
      evaluation = evaluateAdjustmentMaintenanceDaily(inspection.dailyEvaluationInput);
    } catch {
      return {
        candidateGraphSha256: null,
        candidateSha256: null,
        fitReceiptSha256: null,
        reason: "daily_evaluation_failed",
        semanticInputSha256: inspection.inputManifestSha256,
        state: "failed",
      };
    }

    // retain incomplete terminal history for an exact later retry
    if (evaluation.state === "pending") {
      return {
        candidateGraphSha256: null,
        candidateSha256: null,
        fitReceiptSha256: null,
        reason: "daily_history_pending",
        semanticInputSha256: evaluation.semanticInputSha256,
        state: "blocked",
      };
    }
    // finalize a passing member through its immutable release and owner retirement
    if (evaluation.policy.state === "pass" && evaluation.policy.action === "promote") {
      if (inspection.dailyTerminalMaterial === undefined) {
        return {
          candidateGraphSha256: null,
          candidateSha256: null,
          fitReceiptSha256: null,
          reason: "daily_evaluation_failed",
          semanticInputSha256: evaluation.semanticInputSha256,
          state: "failed",
        };
      }
      const completion = await completeAdjustmentQualifiedDailyTerminal({
        archive: ports.archive,
        dailyMaterial: inspection.dailyTerminalMaterial,
        due,
        epochWitness: inspection.dailyTerminalMaterial.epochWitness,
        evaluation,
        journal: ports.journal,
        readHead: ports.readArchiveHead,
      });
      return {
        actionEligible: true,
        candidateGraphSha256: null,
        candidateSha256: null,
        fitReceiptSha256: null,
        reason: "daily_candidate_promoted",
        semanticInputSha256: evaluation.semanticInputSha256,
        servingChanged: completion.servingChanged,
        state: "completed",
      };
    }
    const disposition = evaluation.policy.state === "pending" &&
      evaluation.policy.action === "pending"
      ? "support_failed"
      : evaluation.policy.state === "fail" && evaluation.policy.action === "retain"
        ? "rejected"
        : null;

    // reject unknown policy pairs instead of inferring a lifecycle outcome
    if (disposition === null || inspection.dailyTerminalMaterial === undefined) {
      return {
        candidateGraphSha256: null,
        candidateSha256: null,
        fitReceiptSha256: null,
        reason: "daily_evaluation_failed",
        semanticInputSha256: evaluation.semanticInputSha256,
        state: "failed",
      };
    }
    await completeAdjustmentNoActionDailyTerminal({
      archive: ports.archive,
      dailyMaterial: inspection.dailyTerminalMaterial,
      disposition,
      due,
      epochWitness: inspection.dailyTerminalMaterial.epochWitness,
      evaluation,
      journal: ports.journal,
      readHead: ports.readArchiveHead,
    });
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: disposition === "rejected"
        ? "daily_candidate_rejected"
        : "daily_support_failed",
      semanticInputSha256: evaluation.semanticInputSha256,
      state: "completed",
    };
  }

  // never spend fitter capacity while the family slot is occupied or unauthenticated
  if (inspection.state === "no_candidate") {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "monthly_no_candidate",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "completed",
    };
  }
  if (inspection.registrationSlot === undefined ||
    inspection.registrationSlot.family !== due.family) {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "registration_schedule_unavailable",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "blocked",
    };
  }
  if (inspection.registrationSlot.state !== "free") {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "family_slot_busy",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "blocked",
    };
  }

  let fit;

  try {
    fit = await ports.runFit({
      family: due.family,
      input: inspection.fitInput,
      runtimeReadiness: inspection.runtimeReadiness,
      runtimeReadinessSha256: inspection.runtimeReadinessSha256,
    });
    validateFitResult(fit, due.family, inspection.runtimeReadinessSha256);
  } catch {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "fit_failed",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "failed",
    };
  }
  const fitReceiptSha256 = adjustmentSha256(canonicalJsonBytes({
    candidateSha256: fit.candidateSha256,
    codeSnapshotSha256: fit.codeSnapshotSha256,
    contractVersion: fit.contractVersion,
    family: fit.family,
    inputSnapshotSha256: fit.inputSnapshotSha256,
    runtimeReadinessSha256: fit.runtimeReadinessSha256,
  }));
  let parity = null;

  // require independent native/package parity whenever the runtime adapter is installed
  if (typeof ports.buildCandidateParity === "function") {
    try {
      parity = ports.buildCandidateParity({
        candidateBytes: Buffer.from(fit.candidateJson, "utf8"),
        family: due.family,
        retainedInput: inspection.retainedParityInput,
        syntheticInput: inspection.syntheticParityInput,
      });
    } catch {
      return {
        candidateGraphSha256: null,
        candidateSha256: null,
        fitReceiptSha256,
        reason: "candidate_parity_failed",
        semanticInputSha256: inspection.inputManifestSha256,
        state: "failed",
      };
    }
  }

  // refuse promotion when candidate retention is not implemented
  if (typeof ports.persistCandidate !== "function") {
    return {
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256,
      reason: "candidate_archive_unavailable",
      semanticInputSha256: inspection.inputManifestSha256,
      state: "blocked",
    };
  }
  let registrationMaterial = null;

  // derive registration only after the exact portable artifact and source identities exist
  if (typeof ports.buildCandidateRegistration === "function") {
    registrationMaterial = await ports.buildCandidateRegistration({
      due,
      fit,
      inspection,
      parity,
      requestedAt: now,
    });
    requirePlainObject(registrationMaterial, "registrationMaterial");
  }
  const candidate = await ports.persistCandidate({
    due,
    fit,
    fitReceiptSha256,
    parity,
    registrationMaterial,
  });
  requireSha256(candidate.candidateGraphSha256, "candidateGraphSha256");
  let confirmationRegistrationSha256 = null;

  // occupy the local family slot before a released process can expose predictions
  if (registrationMaterial !== null) {
    if (typeof ports.journal.preregisterConfirmation !== "function") {
      throw new Error("confirmation preregistration port is unavailable");
    }
    const registrationHead = await ports.journal.status();
    requireSha256(registrationHead.headSha256, "confirmation inputHeadSha256");
    const preregistration = await ports.journal.preregisterConfirmation({
      ...registrationMaterial.confirmation,
      inputHeadSha256: registrationHead.headSha256,
      now,
    });
    requireSha256(preregistration.registrationSha256,
      "confirmationRegistrationSha256");
    confirmationRegistrationSha256 = preregistration.registrationSha256;
  }
  return {
    candidateGraphSha256: candidate.candidateGraphSha256,
    candidateSha256: fit.candidateSha256,
    developmentCandidate: Object.freeze({
      candidate,
      confirmationRegistrationSha256,
      fit,
      inspection,
      parity,
      registrationMaterial,
    }),
    fitReceiptSha256,
    reason: "development_candidate_archived",
    semanticInputSha256: inspection.inputManifestSha256,
    state: "completed",
  };
}

// validate one sanitized isolated fitter receipt
function validateFitResult(value, family, runtimeReadinessSha256) {
  requirePlainObject(value, "fit result");
  requireExactKeys(value, [
    "candidateJson",
    "candidateSha256",
    "codeSnapshotSha256",
    "contractVersion",
    "family",
    "inputSnapshotSha256",
    "runtimeReadinessSha256",
    "stderr",
    "stdout",
  ], "fit result");
  requireSha256(value.candidateSha256, "candidateSha256");
  requireSha256(value.codeSnapshotSha256, "codeSnapshotSha256");
  requireSha256(value.inputSnapshotSha256, "inputSnapshotSha256");
  requireSha256(value.runtimeReadinessSha256, "runtimeReadinessSha256");

  // bind family, runtime and exact candidate bytes
  if (value.contractVersion !== "adjustment-fit-sandbox/v1" || value.family !== family ||
    value.runtimeReadinessSha256 !== runtimeReadinessSha256 ||
    typeof value.candidateJson !== "string" ||
    adjustmentSha256(Buffer.from(value.candidateJson, "utf8")) !== value.candidateSha256) {
    throw new TypeError("fit result identity is invalid");
  }
}

// publish one member on the predecessor-linked archive head
export async function publishAdjustmentArchiveMember(input) {
  requireExactKeys(input, [
    "archive",
    "clock",
    "identitySha256",
    "journal",
    "kind",
    "payload",
    "readHead",
  ], "archive member publication");
  requireSha256(input.identitySha256, "identitySha256");

  // require one bounded immutable member kind and payload
  if (typeof input.kind !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(input.kind) ||
    !Buffer.isBuffer(input.payload) || input.payload.length === 0 ||
    input.payload.length > 8 * 1_024 * 1_024 || typeof input.clock !== "function" ||
    typeof input.readHead !== "function") {
    throw new TypeError("archive member publication is invalid");
  }
  const dueKey = `archive/member/${input.identitySha256}`;
  const runId = `archive-member-${input.identitySha256}`;
  const due = (await input.journal.inspectDueKeys({ dueKeys: [dueKey] }))[0];
  const existingHead = await input.readHead();

  // return only an actually reachable completed member
  if (due.status === "complete") {
    const existing = await findArchiveMember(
      input.archive,
      existingHead,
      input.identitySha256,
      input.kind,
    );

    // bind the due output to the graph that introduced the member
    if (existing === null || existing.graphSha256 !== due.outputSha256) {
      throw new Error("archive completed member is unavailable");
    }
    return { manifestObjectSha256: existing.graphSha256, memberSha256: existing.entry.memberSha256 };
  }
  const status = await input.journal.status();
  const active = status.activeLeases.find(
    // select the sole archive mutation lease
    (lease) => lease.scope === "archive",
  );
  const now = requireDate(input.clock());

  // refuse reconciling an unrelated archive job without its private checkpoint evidence
  if (active !== undefined && (active.dueKey !== dueKey || active.runId !== runId)) {
    throw new Error("archive mutation lease is occupied");
  }

  // reconcile only this member after proving it reachable from the durable head
  if (active !== undefined && Date.parse(active.expiresAt) <= now.getTime()) {
    const existing = await findArchiveMember(
      input.archive,
      existingHead,
      input.identitySha256,
      input.kind,
    );

    // never clear an expired archive lease without durable member evidence
    if (existing === null) {
      throw new Error("archive member reconciliation is required");
    }
    await input.journal.reconcileExpiredLease({
      dueKey,
      immutableOutputSha256: existing.graphSha256,
      now: now.toISOString(),
      remoteStateSha256: existingHead,
      resolution: "complete",
      runId,
      scope: "archive",
    });
  }
  const refreshedStatus = await input.journal.status();
  requireSha256(refreshedStatus.headSha256, "archive inputHeadSha256");
  let acquired = false;

  try {
    await input.journal.acquireLease({
      dueKey,
      inputHeadSha256: due.inputHeadSha256 ?? refreshedStatus.headSha256,
      now: requireDate(input.clock()).toISOString(),
      runId,
      scope: "archive",
    });
    acquired = true;
    const published = await input.archive.publishCasObject([{
      identitySha256: input.identitySha256,
      kind: input.kind,
      payload: input.payload,
    }]);
    const expectedEntry = graphEntryForMember(published, published.members[0]);
    const currentHead = await input.readHead();
    const existing = await findArchiveMember(
      input.archive,
      currentHead,
      input.identitySha256,
      input.kind,
    );
    let manifestObjectSha256;

    // reuse only byte-identical reachable member metadata
    if (existing !== null) {
      if (!canonicalJsonBytes(existing.entry).equals(canonicalJsonBytes(expectedEntry))) {
        throw new TypeError("archive member retry differs");
      }
      manifestObjectSha256 = existing.graphSha256;
    } else {
      const manifest = buildGraphManifest({
        crossLinks: [],
        entries: [expectedEntry],
        predecessorGraphSha256: currentHead,
      });
      const graph = await input.archive.publishGraphManifest(manifest);
      await input.archive.verifyFullGraph(graph.objectSha256);
      await input.archive.updateHead(graph.objectSha256);
      const durableHead = await input.readHead();

      // require durable pointer visibility before journal completion
      if (durableHead !== graph.objectSha256) {
        throw new TypeError("archive member head differs");
      }
      manifestObjectSha256 = graph.objectSha256;
    }
    await input.journal.completeDue({
      dueKey,
      now: requireDate(input.clock()).toISOString(),
      outputSha256: manifestObjectSha256,
    });
    await input.journal.releaseLease({
      dueKey,
      now: requireDate(input.clock()).toISOString(),
      runId,
      scope: "archive",
    });
    acquired = false;
    return { manifestObjectSha256, memberSha256: expectedEntry.memberSha256 };
  } finally {
    // release only a live same-process lease after a recoverable error
    if (acquired) {
      await input.journal.releaseLease({
        dueKey,
        now: requireDate(input.clock()).toISOString(),
        runId,
        scope: "archive",
      }).catch(
        // preserve the publication error for exact later retry
        () => undefined,
      );
    }
  }
}

// publish one verified multi-member transport segment under the archive lease
export async function publishAdjustmentArchiveGraphSegment(input) {
  requireExactKeys(input, [
    "archive", "clock", "dueKey", "journal", "readHead", "segment",
  ], "archive graph segment publication");
  if (typeof input.dueKey !== "string" ||
    !/^archive\/(?:(?:revision-(?:cold|gap)-page|revision-custody-pack|future-only-(?:genesis|lineage)|development-custody|confirmation-plan|confirmation-terminal-part)\/[a-f0-9]{64}|development-candidate\/(?:temperature|wind|rain)\/[a-f0-9]{64})$/u
      .test(input.dueKey)) {
    throw new TypeError("archive graph segment due key is invalid");
  }
  requirePlainObject(input.segment, "archive graph segment");

  // require an actual bounded segment and all archive boundaries
  if (!Array.isArray(input.segment.members) || input.segment.members.length < 1 ||
    input.segment.members.length > ARCHIVE_SEGMENT_MAXIMUM_MEMBERS ||
    !Array.isArray(input.segment.crossLinks) ||
    input.segment.crossLinks.length > ARCHIVE_SEGMENT_MAXIMUM_CROSS_LINKS ||
    typeof input.clock !== "function" || typeof input.readHead !== "function") {
    throw new TypeError("archive graph segment publication is invalid");
  }
  const checkpoint = input.segment.members[0];
  requireSha256(checkpoint.identitySha256, "archive checkpoint identitySha256");
  const runId = `archive-segment-${checkpoint.identitySha256}`;
  const due = (await input.journal.inspectDueKeys({ dueKeys: [input.dueKey] }))[0];

  // reuse only a verified graph that contains the exact checkpoint identity
  if (due.status === "complete") {
    const verified = await input.archive.verifyFullGraph(due.outputSha256);
    if (!verified.manifest.entries.some((entry) =>
      entry.identitySha256 === checkpoint.identitySha256 && entry.kind === checkpoint.kind)) {
      throw new Error("archive completed segment is unavailable");
    }
    return { manifestObjectSha256: due.outputSha256, state: "already_complete" };
  }
  const status = await input.journal.status();
  const active = status.activeLeases.find(
    // select the only archive mutation lease
    (lease) => lease.scope === "archive",
  );
  const now = requireDate(input.clock());

  // never clear another archive producer's lease without its own checkpoint
  if (active !== undefined && (active.dueKey !== input.dueKey || active.runId !== runId)) {
    throw new Error("archive mutation lease is occupied");
  }
  if (active !== undefined && Date.parse(active.expiresAt) <= now.getTime()) {
    const existing = await findArchiveMember(
      input.archive,
      await input.readHead(),
      checkpoint.identitySha256,
      checkpoint.kind,
    );

    // reconcile only a checkpoint already reachable from the durable head
    if (existing === null) {
      throw new Error("archive segment reconciliation is required");
    }
    await input.journal.reconcileExpiredLease({
      dueKey: input.dueKey,
      immutableOutputSha256: existing.graphSha256,
      now: now.toISOString(),
      remoteStateSha256: await input.readHead(),
      resolution: "complete",
      runId,
      scope: "archive",
    });
    return { manifestObjectSha256: existing.graphSha256, state: "reconciled" };
  }
  requireSha256(status.headSha256, "archive segment inputHeadSha256");
  let acquired = false;

  try {
    await input.journal.acquireLease({
      dueKey: input.dueKey,
      inputHeadSha256: due.inputHeadSha256 ?? status.headSha256,
      now: now.toISOString(),
      runId,
      scope: "archive",
    });
    acquired = true;
    const published = await input.archive.publishCasObject(input.segment.members);
    const entries = published.members.map(
      // bind every exact member to the one immutable CAS object
      (member) => graphEntryForMember(published, member),
    );
    const predecessorGraphSha256 = await input.readHead();
    const manifest = buildGraphManifest({
      crossLinks: input.segment.crossLinks,
      entries,
      predecessorGraphSha256,
    });
    const graph = await input.archive.publishGraphManifest(manifest);
    await input.archive.verifyFullGraph(graph.objectSha256);
    await input.archive.updateHead(graph.objectSha256);

    // require durable head visibility before freeing a server slot
    if (await input.readHead() !== graph.objectSha256) {
      throw new Error("archive segment head differs");
    }
    await input.journal.completeDue({
      dueKey: input.dueKey,
      now: requireDate(input.clock()).toISOString(),
      outputSha256: graph.objectSha256,
    });
    await input.journal.releaseLease({
      dueKey: input.dueKey,
      now: requireDate(input.clock()).toISOString(),
      runId,
      scope: "archive",
    });
    acquired = false;
    return { manifestObjectSha256: graph.objectSha256, state: "published" };
  } finally {
    // release only this still-live segment lease on recoverable local failure
    if (acquired) {
      await input.journal.releaseLease({
        dueKey: input.dueKey,
        now: requireDate(input.clock()).toISOString(),
        runId,
        scope: "archive",
      }).catch(
        // preserve the publication failure for exact retry
        () => undefined,
      );
    }
  }
}

// archive the root witness and all family lineage descriptors as one graph
export async function archiveAdjustmentFutureOnlyGenesis(input) {
  requireExactKeys(input, [
    "archive", "clock", "journal", "readHead", "servingSnapshot", "witness",
  ], "future-only genesis archive");
  const segment = buildAdjustmentFutureOnlyGenesisGraphSegment({
    servingSnapshot: input.servingSnapshot,
    witness: input.witness,
  });
  return await publishAdjustmentArchiveGraphSegment({
    archive: input.archive,
    clock: input.clock,
    dueKey: `archive/future-only-genesis/${input.witness.witnessSha256}`,
    journal: input.journal,
    readHead: input.readHead,
    segment,
  });
}

// archive one candidate-derived source descriptor before registration
export async function archiveAdjustmentFutureOnlySourceLineage(input) {
  requireExactKeys(input, [
    "archive", "clock", "epochWitness", "family", "journal", "readHead",
    "sourceIdentitySha256",
  ], "future-only source lineage archive");
  const segment = buildAdjustmentFutureOnlySourceLineageGraphSegment({
    epochWitness: input.epochWitness,
    family: input.family,
    sourceIdentitySha256: input.sourceIdentitySha256,
  });
  const lineage = segment.members[1];
  return await publishAdjustmentArchiveGraphSegment({
    archive: input.archive,
    clock: input.clock,
    dueKey: `archive/future-only-lineage/${lineage.identitySha256}`,
    journal: input.journal,
    readHead: input.readHead,
    segment,
  });
}

// archive one value-blind terminal plan only after every named cold graph verifies
export async function archiveAdjustmentConfirmationPlan(input) {
  requireExactKeys(input, [
    "archive", "clock", "journal", "planGraph", "readHead",
  ], "confirmation plan archive input");
  const planGraph = validateAdjustmentControllerPlanGraph(input.planGraph);

  // prove every selected capsule is actually retained by its named immutable graph
  for (const entry of planGraph.entries) {
    const verified = await input.archive.verifyFullGraph(entry.graphManifestSha256);
    const retained = verified.manifest.entries.find(
      // require the exact parser-authenticated outer capsule member
      (member) => member.identitySha256 === entry.payloadIdentitySha256 &&
        member.kind === "adjustment-shadow-revision-capsule/v2",
    );

    // reject a naked graph or capsule identity before publishing burn evidence
    if (retained === undefined) {
      throw new Error("confirmation plan capsule graph is unavailable");
    }
  }
  const segment = buildAdjustmentConfirmationPlanGraphSegment({ planGraph });
  return await publishAdjustmentArchiveGraphSegment({
    archive: input.archive,
    clock: input.clock,
    dueKey: `archive/confirmation-plan/${planGraph.planGraphSha256}`,
    journal: input.journal,
    readHead: input.readHead,
    segment,
  });
}

// build bounded terminal archive members without granting C, T, F or action authority
export function buildAdjustmentMaintenanceTerminalEvidenceMembers(input) {
  requireExactKeys(input, [
    "actionIdentitySha256", "assembly", "candidateGraphSha256",
    "confirmationRegistration", "fullManifest", "localBurn", "nativeAccess",
    "planGraphManifestSha256", "policy", "registrationSha256", "shadowRegistration",
  ], "terminal evidence members input");
  requirePlainObject(input.assembly, "terminal evidence assembly");
  requirePlainObject(input.confirmationRegistration, "terminal confirmation registration");
  requirePlainObject(input.fullManifest, "terminal full manifest");
  requirePlainObject(input.localBurn, "terminal local burn");
  requirePlainObject(input.nativeAccess, "terminal native access");
  requirePlainObject(input.policy, "terminal unsupported policy");
  requirePlainObject(input.shadowRegistration, "terminal shadow registration");
  for (const field of [
    "actionIdentitySha256", "candidateGraphSha256", "planGraphManifestSha256",
    "registrationSha256",
  ]) {
    requireSha256(input[field], field);
  }
  const policy = validateAdjustmentUnsupportedPolicyReport(input.policy.report);
  requireSha256(input.policy.policyReportSha256, "policyReportSha256");

  // bind the report bytes and nonmutating identity before any archive write
  if (!Buffer.isBuffer(input.policy.bytes) ||
    !input.policy.bytes.equals(canonicalJsonBytes(policy)) ||
    adjustmentSha256(input.policy.bytes) !== input.policy.policyReportSha256 ||
    policy.registrationSha256 !== input.registrationSha256) {
    throw new TypeError("terminal unsupported policy bytes differ");
  }
  const actionIdentity = {
    contractVersion: "adjustment-terminal-no-action-identity/v3",
    disposition: "support_failed",
    policyReportSha256: input.policy.policyReportSha256,
    registrationSha256: input.registrationSha256,
  };
  const actionIdentityBytes = canonicalJsonBytes(actionIdentity);

  // require the caller identity to be the exact nonmutating preimage hash
  if (adjustmentSha256(actionIdentityBytes) !== input.actionIdentitySha256) {
    throw new TypeError("terminal no-action identity differs");
  }
  const terminalParts = buildAdjustmentMaintenanceTerminalGraphParts({
    family: input.assembly.family,
    terminalGraph: input.assembly.terminalGraph,
  });
  const dataMembers = [];

  // retain every value-bearing physical part under its blinded journal identity
  for (const chunk of input.assembly.chunks) {
    requireExactKeys(chunk, ["metadata", "payloadBase64"],
      "terminal evidence chunk");
    const bytes = Buffer.from(chunk.payloadBase64, "base64");
    const identitySha256 = chunk.metadata.partSha256 ?? chunk.metadata.chunkSha256;
    requireSha256(identitySha256, "terminal chunk identitySha256");
    const document = JSON.parse(bytes.toString("utf8"));

    // reject alternate base64, noncanonical JSON and a mismatched blinded identity
    if (bytes.toString("base64") !== chunk.payloadBase64 ||
      !canonicalJsonBytes(document).equals(bytes) ||
      adjustmentSha256(bytes) !== identitySha256 ||
      typeof document.contractVersion !== "string") {
      throw new TypeError("terminal evidence chunk bytes differ");
    }
    dataMembers.push({
      identitySha256,
      kind: document.contractVersion,
      payload: bytes,
    });
  }

  // retain each regional derived target exactly once
  for (const target of input.assembly.derivedTargets) {
    requireExactKeys(target, ["bytes", "targetMemberSha256"],
      "terminal derived target");
    requireSha256(target.targetMemberSha256, "targetMemberSha256");
    const bytes = requireBuffer(target.bytes, "derived target bytes");
    parseAdjustmentMaintenanceDerivedTarget(bytes);

    // bind the archived target identity to its exact canonical bytes
    if (adjustmentSha256(bytes) !== target.targetMemberSha256) {
      throw new TypeError("terminal derived target identity differs");
    }
    dataMembers.push({
      identitySha256: target.targetMemberSha256,
      kind: ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION,
      payload: bytes,
    });
  }

  // retain bounded terminal graph parts separately from the compact final manifest
  for (const part of terminalParts.parts) {
    dataMembers.push({
      identitySha256: part.partSha256,
      kind: part.document.contractVersion,
      payload: part.bytes,
    });
  }
  const graphReferences = [...new Set([
    input.candidateGraphSha256,
    input.planGraphManifestSha256,
    ...input.assembly.graphManifestSha256s,
  ])].sort().map(
    // preserve every authenticated predecessor graph as one canonical reference member
    (graphSha256) => {
      requireSha256(graphSha256, "terminal graph reference");
      const document = {
        contractVersion: "adjustment-archive-graph-reference/v1",
        graphSha256,
      };
      const bytes = canonicalJsonBytes(document);
      return {
        identitySha256: adjustmentSha256(bytes),
        kind: document.contractVersion,
        payload: bytes,
      };
    },
  );
  const localBurnDocument = {
    contractVersion: "adjustment-confirmation-local-burn-member/v1",
    localBurn: input.localBurn,
  };
  const nativeAccessDocument = {
    contractVersion: "adjustment-confirmation-native-access-member/v1",
    nativeAccess: input.nativeAccess,
  };
  const finalDocuments = [{
    identitySha256: terminalParts.manifest.terminalGraphManifestSha256,
    kind: terminalParts.manifest.contractVersion,
    payload: terminalParts.manifestBytes,
  }, {
    identitySha256: input.fullManifest.fullMemberRootSha256,
    kind: input.fullManifest.contractVersion,
    payload: canonicalJsonBytes(input.fullManifest),
  }, {
    identitySha256: adjustmentSha256(canonicalJsonBytes(localBurnDocument)),
    kind: localBurnDocument.contractVersion,
    payload: canonicalJsonBytes(localBurnDocument),
  }, {
    identitySha256: adjustmentSha256(canonicalJsonBytes(nativeAccessDocument)),
    kind: nativeAccessDocument.contractVersion,
    payload: canonicalJsonBytes(nativeAccessDocument),
  }, {
    identitySha256: input.policy.policyReportSha256,
    kind: policy.contractVersion,
    payload: input.policy.bytes,
  }, {
    identitySha256: input.actionIdentitySha256,
    kind: actionIdentity.contractVersion,
    payload: actionIdentityBytes,
  }, {
    identitySha256: input.confirmationRegistration.registrationSha256,
    kind: input.confirmationRegistration.contractVersion,
    payload: canonicalJsonBytes(input.confirmationRegistration),
  }, {
    identitySha256: input.shadowRegistration.registrationSha256,
    kind: "adjustment-shadow-registration/v3",
    payload: canonicalJsonBytes(input.shadowRegistration),
  }, ...graphReferences];
  return Object.freeze({
    dataMembers: Object.freeze(dataMembers),
    finalMembers: Object.freeze(finalDocuments),
    terminalGraphManifest: terminalParts.manifest,
  });
}

// build complete terminal evidence around one immutable action or no-action identity
export function buildAdjustmentQualifiedTerminalEvidenceMembers(input) {
  requireExactKeys(input, [
    "action", "assembly", "candidateGraphSha256", "candidateReportBytes",
    "confirmationRegistration", "fullManifest", "localBurn", "nativeAccess",
    "planGraphManifestSha256", "policyBytes", "shadowRegistration",
  ], "qualified terminal evidence members input");
  requirePlainObject(input.action, "terminal evidence action");
  const noAction = input.action.contractVersion ===
    "adjustment-terminal-no-action-identity/v3";
  const builtAction = noAction ? null : buildAdjustmentModelAction(input.action);
  const candidateReportBytes = requireBuffer(
    input.candidateReportBytes,
    "qualified candidate report bytes",
  );
  const policyBytes = requireBuffer(input.policyBytes, "qualified policy bytes");
  const candidateReport = validateCanonicalDocument(
    candidateReportBytes,
    ADJUSTMENT_MAINTENANCE_CANDIDATE_REPORT_VERSION,
  );
  const family = noAction ? input.assembly.family : builtAction.action.family;
  const policyVersion = REGISTRATION_POLICY_VERSIONS.get(family);
  const policy = validateCanonicalDocument(policyBytes, policyVersion);
  requireSha256(input.candidateGraphSha256, "candidateGraphSha256");
  requireSha256(input.planGraphManifestSha256, "planGraphManifestSha256");
  requirePlainObject(input.assembly, "qualified terminal assembly");
  requirePlainObject(input.fullManifest, "qualified terminal full manifest");
  requirePlainObject(input.localBurn, "qualified terminal local burn");
  requirePlainObject(input.nativeAccess, "qualified terminal native access");
  requirePlainObject(input.confirmationRegistration,
    "qualified confirmation registration");
  const shadowRegistration = validateRollingShadowRegistration(input.shadowRegistration);
  let authority;

  // validate a nonmutating terminal identity without granting release authority
  if (noAction) {
    requireExactKeys(input.action, [
      "contractVersion", "disposition", "policyReportSha256", "registrationSha256",
    ], "terminal no-action identity");
    if (!new Set(["rejected", "resource_refused", "support_failed"])
      .has(input.action.disposition) ||
      input.action.policyReportSha256 !== adjustmentSha256(policyBytes) ||
      input.action.registrationSha256 !== shadowRegistration.registrationSha256) {
      throw new TypeError("terminal no-action identity differs");
    }
    const bytes = canonicalJsonBytes(input.action);
    authority = {
      bytes,
      contractVersion: input.action.contractVersion,
      identitySha256: adjustmentSha256(bytes),
    };
  } else {
    authority = {
      bytes: builtAction.bytes,
      contractVersion: builtAction.action.contractVersion,
      identitySha256: builtAction.actionSha256,
    };
  }

  // bind action, policy and candidate report to the same complete terminal member
  if (input.assembly.state !== "burned_complete" ||
    (!noAction && (builtAction.action.actionKind !== "promote" ||
      builtAction.action.family !== input.assembly.family ||
      builtAction.action.candidateGraphSha256 !== input.candidateGraphSha256 ||
      builtAction.action.candidateSha256 !== shadowRegistration.candidateSha256 ||
      builtAction.action.fullMemberRootSha256 !== input.fullManifest.fullMemberRootSha256 ||
      builtAction.action.policyReportSha256 !== adjustmentSha256(policyBytes))) ||
    candidateReport.family !== family ||
    candidateReport.candidateSha256 !== shadowRegistration.candidateSha256 ||
    candidateReport.registrationSha256 !== shadowRegistration.registrationSha256 ||
    candidateReport.confirmationRegistrationSha256 !==
      input.confirmationRegistration.registrationSha256 ||
    candidateReport.fullMemberRootSha256 !== input.fullManifest.fullMemberRootSha256 ||
    candidateReport.policyReportSha256 !== adjustmentSha256(policyBytes)) {
    throw new TypeError("qualified terminal evidence binding differs");
  }
  const terminalParts = buildAdjustmentMaintenanceTerminalGraphParts({
    family: input.assembly.family,
    terminalGraph: input.assembly.terminalGraph,
  });
  const dataMembers = [];

  // retain every value-bearing physical part under its blinded identity
  for (const chunk of input.assembly.chunks) {
    requireExactKeys(chunk, ["metadata", "payloadBase64"],
      "qualified terminal evidence chunk");
    const bytes = Buffer.from(chunk.payloadBase64, "base64");
    const identitySha256 = chunk.metadata.partSha256 ?? chunk.metadata.chunkSha256;
    requireSha256(identitySha256, "qualified terminal chunk identitySha256");
    const document = JSON.parse(bytes.toString("utf8"));

    // require exact canonical bytes and the blinded physical-part identity
    if (bytes.toString("base64") !== chunk.payloadBase64 ||
      !canonicalJsonBytes(document).equals(bytes) ||
      adjustmentSha256(bytes) !== identitySha256) {
      throw new TypeError("qualified terminal chunk bytes differ");
    }
    dataMembers.push({
      identitySha256,
      kind: document.contractVersion,
      payload: bytes,
    });
  }

  // retain only newly derived regional target members
  for (const target of input.assembly.derivedTargets) {
    requireExactKeys(target, ["bytes", "targetMemberSha256"],
      "qualified terminal derived target");
    const bytes = requireBuffer(target.bytes, "qualified derived target bytes");
    parseAdjustmentMaintenanceDerivedTarget(bytes);
    if (adjustmentSha256(bytes) !== target.targetMemberSha256) {
      throw new TypeError("qualified terminal derived target identity differs");
    }
    dataMembers.push({
      identitySha256: target.targetMemberSha256,
      kind: ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION,
      payload: bytes,
    });
  }

  // retain every bounded terminal graph part before its compact manifest
  for (const part of terminalParts.parts) {
    dataMembers.push({
      identitySha256: part.partSha256,
      kind: part.document.contractVersion,
      payload: part.bytes,
    });
  }
  const graphReferences = [...new Set([
    input.candidateGraphSha256,
    input.planGraphManifestSha256,
    ...input.assembly.graphManifestSha256s,
  ])].sort().map(
    // preserve every authenticated predecessor graph as one canonical reference
    (graphSha256) => {
      requireSha256(graphSha256, "qualified terminal graph reference");
      const document = {
        contractVersion: "adjustment-archive-graph-reference/v1",
        graphSha256,
      };
      const bytes = canonicalJsonBytes(document);
      return {
        identitySha256: adjustmentSha256(bytes),
        kind: document.contractVersion,
        payload: bytes,
      };
    },
  );
  const localBurnDocument = {
    contractVersion: "adjustment-confirmation-local-burn-member/v1",
    localBurn: input.localBurn,
  };
  const nativeAccessDocument = {
    contractVersion: "adjustment-confirmation-native-access-member/v1",
    nativeAccess: input.nativeAccess,
  };
  const finalMembers = [{
    identitySha256: terminalParts.manifest.terminalGraphManifestSha256,
    kind: terminalParts.manifest.contractVersion,
    payload: terminalParts.manifestBytes,
  }, {
    identitySha256: input.fullManifest.fullMemberRootSha256,
    kind: input.fullManifest.contractVersion,
    payload: canonicalJsonBytes(input.fullManifest),
  }, {
    identitySha256: adjustmentSha256(canonicalJsonBytes(localBurnDocument)),
    kind: localBurnDocument.contractVersion,
    payload: canonicalJsonBytes(localBurnDocument),
  }, {
    identitySha256: adjustmentSha256(canonicalJsonBytes(nativeAccessDocument)),
    kind: nativeAccessDocument.contractVersion,
    payload: canonicalJsonBytes(nativeAccessDocument),
  }, {
    identitySha256: adjustmentSha256(candidateReportBytes),
    kind: candidateReport.contractVersion,
    payload: candidateReportBytes,
  }, {
    identitySha256: adjustmentSha256(policyBytes),
    kind: policy.contractVersion,
    payload: policyBytes,
  }, {
    identitySha256: authority.identitySha256,
    kind: authority.contractVersion,
    payload: authority.bytes,
  }, {
    identitySha256: input.confirmationRegistration.registrationSha256,
    kind: input.confirmationRegistration.contractVersion,
    payload: canonicalJsonBytes(input.confirmationRegistration),
  }, {
    identitySha256: shadowRegistration.registrationSha256,
    kind: "adjustment-shadow-registration/v3",
    payload: canonicalJsonBytes(shadowRegistration),
  }, ...graphReferences];
  return Object.freeze({
    dataMembers: Object.freeze(dataMembers),
    finalMembers: Object.freeze(finalMembers),
    terminalGraphManifest: terminalParts.manifest,
  });
}

// archive one terminal evidence population across bounded predecessor-linked segments
export async function archiveAdjustmentMaintenanceTerminalEvidence(input) {
  requireExactKeys(input, [
    "archive", "clock", "evidence", "journal", "readHead",
  ], "terminal evidence archive input");
  requirePlainObject(input.evidence, "terminal evidence archive members");
  if (typeof input.clock !== "function" || typeof input.readHead !== "function" ||
    !Array.isArray(input.evidence.dataMembers) ||
    !Array.isArray(input.evidence.finalMembers) ||
    input.evidence.finalMembers.length < 1) {
    throw new TypeError("terminal evidence archive ports are invalid");
  }
  const batches = [];
  let batch = [];
  let batchBytes = 0;

  // partition members by both manifest count and bounded allocation
  for (const member of input.evidence.dataMembers) {
    const memberBytes = requireBuffer(member.payload, "terminal evidence member payload").length;

    // close the prior batch before adding one member would cross its bound
    if (batch.length > 0 && (batch.length >= ARCHIVE_SEGMENT_MAXIMUM_MEMBERS ||
      batchBytes + memberBytes > 64 * 1_024 * 1_024)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(member);
    batchBytes += memberBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  const publications = [];

  // publish every data batch before the compact terminal manifest
  for (const members of batches) {
    const publication = await publishAdjustmentArchiveGraphSegment({
      archive: input.archive,
      clock: input.clock,
      dueKey: `archive/confirmation-terminal-part/${members[0].identitySha256}`,
      journal: input.journal,
      readHead: input.readHead,
      segment: { crossLinks: [], members },
    });
    publications.push(publication.manifestObjectSha256);
  }
  const finalPublication = await publishAdjustmentArchiveGraphSegment({
    archive: input.archive,
    clock: input.clock,
    dueKey: `archive/confirmation-terminal-part/` +
      `${input.evidence.finalMembers[0].identitySha256}`,
    journal: input.journal,
    readHead: input.readHead,
    segment: { crossLinks: [], members: input.evidence.finalMembers },
  });
  await input.archive.verifyFullGraph(finalPublication.manifestObjectSha256);
  return Object.freeze({
    manifestObjectSha256: finalPublication.manifestObjectSha256,
    publicationGraphSha256s: Object.freeze([
      ...publications,
      finalPublication.manifestObjectSha256,
    ]),
  });
}

// retain one exact outcome and owner command before releasing its family slot
async function retainAdjustmentDueTerminalRetirement(input) {
  requireExactKeys(input, ["dueKey", "journal", "kind", "now", "outcome", "request"],
    "due terminal retirement retention");
  if (typeof input.journal.recordDueTerminalRetirement !== "function" ||
    typeof input.journal.recordDueTerminalOutcome !== "function") {
    throw new Error("daily terminal retirement journal is unavailable");
  }
  const retained = await input.journal.recordDueTerminalRetirement({
    dueKey: input.dueKey,
    kind: input.kind,
    now: input.now,
    request: input.request,
  });
  requireSha256(retained.requestSha256, "terminal retirement requestSha256");
  await input.journal.recordDueTerminalOutcome({
    dueKey: input.dueKey,
    now: input.now,
    outcome: input.outcome,
  });
  return retained;
}

// acknowledge one authenticated owner retirement after its exact response
async function completeAdjustmentDueTerminalRetirement(input) {
  if (typeof input.journal.completeDueTerminalRetirement !== "function") {
    throw new Error("daily terminal retirement completion journal is unavailable");
  }
  await input.journal.completeDueTerminalRetirement({
    dueKey: input.dueKey,
    now: input.now,
    requestSha256: input.requestSha256,
  });
}

// resume one retained owner retirement without rerunning semantic evaluation
export async function reconcileAdjustmentDueTerminalRetirement(input, options = {}) {
  requireExactKeys(input, ["dueKey", "journal"], "due terminal retirement reconciliation");
  requirePlainObject(options, "due terminal retirement reconciliation options");
  const allowed = new Set(["clock", "retireQualified", "retireUnsupported"]);

  // permit only the two closed owner retirement transports
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => key !== "clock" && options[key] !== undefined &&
      typeof options[key] !== "function") ||
    (options.clock !== undefined && typeof options.clock !== "function")) {
    throw new TypeError("due terminal retirement reconciliation options are invalid");
  }
  if (typeof input.journal.readDueTerminalRetirement !== "function") {
    throw new Error("daily terminal retirement journal is unavailable");
  }
  const retained = await input.journal.readDueTerminalRetirement({ dueKey: input.dueKey });

  // an outcome without its prior retirement command is corrupt authority
  if (retained === null) {
    throw new Error("daily terminal retirement is unavailable");
  }
  if (retained.completed) {
    return retained;
  }
  const retireQualified = options.retireQualified ??
    (async ({ request }) => await retireAdjustmentShadowTerminalV3({ request }));
  const retireUnsupported = options.retireUnsupported ??
    (async ({ request }) => await retireAdjustmentShadowUnsupportedTerminalV1({ request }));

  // route only the exact retained contract kind
  if (retained.kind === "qualified_v3") {
    await retireQualified({ request: retained.request });
  } else if (retained.kind === "unsupported_v1") {
    await retireUnsupported({ request: retained.request });
  } else {
    throw new Error("daily terminal retirement kind is invalid");
  }
  const clock = options.clock ?? (() => new Date());
  await completeAdjustmentDueTerminalRetirement({
    dueKey: input.dueKey,
    journal: input.journal,
    now: requireDate(clock()).toISOString(),
    requestSha256: retained.requestSha256,
  });
  return Object.freeze({ ...retained, completed: true });
}

// close one permanently unsupported member without granting model mutation authority
export async function completeAdjustmentUnsupportedDailyTerminal(input, options = {}) {
  requireExactKeys(input, [
    "archive", "dailyMaterial", "due", "epochWitness", "journal", "readHead",
    "semanticInputSha256", "unsupportedReason",
  ], "unsupported daily terminal completion input");
  validateDue(input.due);
  requireSha256(input.semanticInputSha256, "semanticInputSha256");
  requirePlainObject(options, "unsupported daily terminal completion options");
  const allowed = new Set([
    "archiveEvidence", "archiveTombstone", "clock", "installProof", "readProof",
    "recordTerminal", "retireTerminal",
  ]);

  // permit only isolated durable ports for exact crash-boundary tests
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => key !== "clock" && options[key] !== undefined &&
      typeof options[key] !== "function") ||
    (options.clock !== undefined && typeof options.clock !== "function")) {
    throw new TypeError("unsupported daily terminal completion options are invalid");
  }
  requirePlainObject(input.dailyMaterial, "unsupported daily material");
  const material = input.dailyMaterial;
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const clock = options.clock ?? (() => new Date());
  const inputClassMembers = buildAdjustmentMaintenanceInputClassMembers({
    artifactSha256: material.shadowRegistration.artifactSha256,
    candidateSha256: material.shadowRegistration.candidateSha256,
    family: material.assembly.family,
    rainGateInputMemberSha256s:
      material.assembly.rainGateInputMemberSha256s ?? [],
    terminalGraph: material.assembly.terminalGraph,
  });
  const missingClassNames = FUTURE_INPUT_CLASS_NAMES.filter(
    // report only required empty classes beside the exact missing-key population
    (name) => inputClassMembers[name].length === 0 &&
      (material.assembly.family === "rain" || name !== "rain_gate_input"),
  );
  const policy = buildAdjustmentUnsupportedPolicyReport({
    family: material.assembly.family,
    missingClassNames,
    missingKeyCount: material.assembly.missingKeyCount,
    missingKeySetSha256: material.assembly.missingKeySetSha256,
    registrationSha256: material.shadowRegistration.registrationSha256,
    targetCutoffAt: material.shadowRegistration.targetCutoffAt,
    unsupportedReason: input.unsupportedReason,
  });
  const actionIdentitySha256 = adjustmentSha256(canonicalJsonBytes({
    contractVersion: "adjustment-terminal-no-action-identity/v3",
    disposition: "support_failed",
    policyReportSha256: policy.policyReportSha256,
    registrationSha256: material.shadowRegistration.registrationSha256,
  }));
  const evidence = buildAdjustmentMaintenanceTerminalEvidenceMembers({
    actionIdentitySha256,
    assembly: material.assembly,
    candidateGraphSha256: material.candidate.candidateGraphSha256,
    confirmationRegistration: material.confirmationRegistration,
    fullManifest: material.fullManifest,
    localBurn: material.localBurn,
    nativeAccess: material.nativeAccess,
    planGraphManifestSha256: material.planGraphManifestSha256,
    policy,
    registrationSha256: material.shadowRegistration.registrationSha256,
    shadowRegistration: material.shadowRegistration,
  });
  const archiveEvidence = options.archiveEvidence ??
    (async (archiveInput) => await archiveAdjustmentMaintenanceTerminalEvidence(archiveInput));
  const publication = await archiveEvidence({
    archive: input.archive,
    clock,
    evidence,
    journal: input.journal,
    readHead: input.readHead,
  });
  requireSha256(publication.manifestObjectSha256,
    "unsupported terminal graphManifestSha256");
  const fullGraphVerifiedAt = requireDate(clock()).toISOString();
  const acknowledgement = await input.journal.readLatestRevisionCustodyAcknowledgement();

  // require current server custody before installing terminal-only authority
  if (acknowledgement === null) {
    throw new Error("unsupported terminal custody acknowledgement is unavailable");
  }
  const readProof = options.readProof ?? fetchAdjustmentUnsupportedTerminalProofCurrent;
  const predecessor = await readProof();
  const artifacts = buildAdjustmentUnsupportedTerminalArtifacts({
    acknowledgement,
    artifactSha256: material.shadowRegistration.artifactSha256,
    assembly: material.assembly,
    candidateSha256: material.shadowRegistration.candidateSha256,
    epochWitness: witness,
    finalizedAt: fullGraphVerifiedAt,
    fullGraphVerifiedAt,
    fullManifest: material.fullManifest,
    graphManifestSha256: publication.manifestObjectSha256,
    journalHeadSha256: (await input.journal.status()).headSha256,
    localBurn: material.localBurn,
    nativeAccess: material.nativeAccess,
    predecessor,
    rainGateInputMemberSha256s:
      material.assembly.rainGateInputMemberSha256s ?? [],
    registrationSha256: material.shadowRegistration.registrationSha256,
    sourceCommit: material.sourceCommit,
    targetCutoffAt: material.shadowRegistration.targetCutoffAt,
    unsupportedReason: input.unsupportedReason,
  });
  const installProof = options.installProof ??
    (async ({ proof }) => await installAdjustmentUnsupportedTerminalProof({ proof }));
  await installProof({ proof: artifacts.proof.proof });
  const completedAt = requireDate(clock()).toISOString();
  const localResult = await input.journal.recordConfirmationResult({
    actionIdentitySha256: null,
    candidateReportSha256: artifacts.policy.policyReportSha256,
    disposition: "support_failed",
    family: material.assembly.family,
    nextConfirmationEligibleAt:
      new Date(Date.parse(completedAt) + 7 * 86_400_000).toISOString(),
    now: completedAt,
    registrationSha256: material.confirmationRegistration.registrationSha256,
  });
  const previousTombstone = await input.journal.readOwnerTerminalTombstone({
    family: material.assembly.family,
  });
  const recordRequest = validateAdjustmentShadowUnsupportedTerminalRecordRequestV1({
    actionReceipt: artifacts.action.receipt,
    confirmationRegistration: material.confirmationRegistration,
    contractVersion: "adjustment-shadow-unsupported-terminal-record-request/v1",
    localResult,
    nativeAccess: material.nativeAccess,
    previousTombstone,
    shadowRegistration: material.shadowRegistration,
    sourceCommit: material.sourceCommit,
    terminalGraphManifestSha256: publication.manifestObjectSha256,
    terminalGraphVerifiedAt: completedAt,
    unsupportedProof: artifacts.proof.proof,
  });
  const recordTerminal = options.recordTerminal ??
    (async ({ request }) => await recordAdjustmentShadowUnsupportedTerminalV1({ request }));
  const recorded = await recordTerminal({ request: recordRequest });
  requirePlainObject(recorded, "unsupported terminal owner result");
  requirePlainObject(recorded.terminalRecord, "unsupported terminal owner record");
  const tombstone = {
    contractVersion: "adjustment-shadow-terminal-tombstone/v3",
    reconciliationSha256: recorded.terminalRecord.reconciliationSha256,
    registrationSha256: recorded.terminalRecord.registrationSha256,
    terminalResultSha256: recorded.terminalRecord.terminalResultSha256,
  };
  const archiveTombstone = options.archiveTombstone ??
    (async (archiveInput) => await publishAdjustmentArchiveMember(archiveInput));
  await archiveTombstone({
    archive: input.archive,
    clock,
    identitySha256: adjustmentSha256(canonicalJsonBytes(tombstone)),
    journal: input.journal,
    kind: tombstone.contractVersion,
    payload: canonicalJsonBytes(tombstone),
    readHead: input.readHead,
  });
  await input.journal.recordOwnerTerminalTombstone({
    family: material.assembly.family,
    now: requireDate(clock()).toISOString(),
    tombstone,
  });
  const retirementRequest = validateAdjustmentShadowUnsupportedTerminalRetirementRequestV1({
    contractVersion: "adjustment-shadow-unsupported-terminal-retirement-request/v1",
    registrationSha256: material.shadowRegistration.registrationSha256,
    terminalRecord: recorded.terminalRecord,
    terminalTombstone: tombstone,
    unsupportedProof: artifacts.proof.proof,
  });
  const retirement = await retainAdjustmentDueTerminalRetirement({
    dueKey: input.due.dueKey,
    journal: input.journal,
    kind: "unsupported_v1",
    now: requireDate(clock()).toISOString(),
    outcome: {
      actionEligible: false,
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "daily_support_failed",
      semanticInputSha256: input.semanticInputSha256,
      servingChanged: false,
      state: "completed",
    },
    request: retirementRequest,
  });
  const retireTerminal = options.retireTerminal ??
    (async ({ request }) => await retireAdjustmentShadowUnsupportedTerminalV1({ request }));
  const retired = await retireTerminal({ request: retirementRequest });
  await completeAdjustmentDueTerminalRetirement({
    dueKey: input.due.dueKey,
    journal: input.journal,
    now: requireDate(clock()).toISOString(),
    requestSha256: retirement.requestSha256,
  });
  return Object.freeze({
    action: artifacts.action,
    policy: artifacts.policy,
    proof: artifacts.proof,
    recorded,
    retired,
    tombstone: Object.freeze(tombstone),
  });
}

// finalize one qualified member through C, T, F, release and owner retirement
export async function completeAdjustmentQualifiedDailyTerminal(input, options = {}) {
  requireExactKeys(input, [
    "archive", "dailyMaterial", "due", "epochWitness", "evaluation", "journal",
    "readHead",
  ], "qualified daily terminal completion input");
  validateDue(input.due);
  requirePlainObject(options, "qualified daily terminal completion options");
  const allowed = new Set([
    "applyRelease", "archiveEvidence", "archiveTombstone", "clock", "fetchCurrent",
    "fetchReleaseStatus", "finalizeAnchor", "installAnchor", "installSeal",
    "publishRelease", "readAnchor", "readSeal", "recordTerminal", "retireTerminal",
  ]);

  // permit only isolated durable ports for exact transition tests
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => key !== "clock" && options[key] !== undefined &&
      typeof options[key] !== "function") ||
    (options.clock !== undefined && typeof options.clock !== "function")) {
    throw new TypeError("qualified daily terminal completion options are invalid");
  }
  const material = input.dailyMaterial;
  requirePlainObject(material, "qualified daily material");
  requirePlainObject(input.evaluation, "qualified daily evaluation");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const clock = options.clock ?? (() => new Date());
  const candidateReport = parseCanonicalBase64Document(
    input.evaluation.candidateReportBase64,
    input.evaluation.candidateReportSha256,
    "qualified candidate report",
  );
  const policyVersion = REGISTRATION_POLICY_VERSIONS.get(input.evaluation.family);

  // select only the closed family policy contract before decoding its bytes
  if (policyVersion === undefined) {
    throw new TypeError("qualified daily evaluation family is invalid");
  }
  const policy = parseCanonicalBase64Document(
    input.evaluation.policyBytesBase64,
    input.evaluation.policyReportSha256,
    "qualified policy report",
    policyVersion,
  );
  const candidateReportBytes = canonicalJsonBytes(candidateReport);
  const policyBytes = canonicalJsonBytes(policy);

  // admit only the exact passing promotion policy
  if (input.evaluation.state !== "evaluated" ||
    input.evaluation.policy?.state !== "pass" ||
    input.evaluation.policy?.action !== "promote" ||
    input.evaluation.family !== material.assembly.family ||
    input.evaluation.fullMemberRootSha256 !== material.fullManifest.fullMemberRootSha256) {
    throw new TypeError("qualified daily evaluation is invalid");
  }
  const retainedLifecycle = typeof input.journal.readConfirmationByCandidate === "function"
    ? await input.journal.readConfirmationByCandidate({
        candidateSha256: material.shadowRegistration.candidateSha256,
        family: material.assembly.family,
      })
    : null;

  // reconcile an already-published action without rebuilding from changed live source
  if (retainedLifecycle?.result?.disposition === "promoted") {
    return await recoverAdjustmentQualifiedDailyTerminal({
      archive: input.archive,
      dailyMaterial: material,
      due: input.due,
      evaluation: input.evaluation,
      journal: input.journal,
      localResult: retainedLifecycle.result,
      options,
      readHead: input.readHead,
    });
  }
  const fetchCurrent = options.fetchCurrent ?? fetchAdjustmentFamilyReleaseCurrent;
  const current = await fetchCurrent(material.assembly.family);
  const releaseRunId = `release-promote-${material.shadowRegistration.candidateSha256.slice(0, 32)}`;
  const releaseDueKey = `confirmation/${material.assembly.family}/` +
    material.shadowRegistration.candidateSha256;
  const acquiredAt = requireDate(clock()).toISOString();
  const leaseHead = await input.journal.status();
  requireSha256(leaseHead.headSha256, "qualified release inputHeadSha256");
  const lease = await input.journal.acquireLease({
    dueKey: releaseDueKey,
    inputHeadSha256: leaseHead.headSha256,
    now: acquiredAt,
    runId: releaseRunId,
    scope: "release",
  });
  let acquired = true;

  try {
    const reportCreatedAt = material.nativeAccess.accessedAt;
    requireInstant(reportCreatedAt, "qualified reportCreatedAt");
    requireSha256(material.nativeAccess.journalHeadSha256,
      "qualified lifecycleHeadSha256");
    const action = {
      actionKind: "promote",
      candidateGraphSha256: material.candidate.candidateGraphSha256,
      candidateSha256: material.shadowRegistration.candidateSha256,
      contractVersion: "forecast-adjustment-model-action/v1",
      createdAt: reportCreatedAt,
      expectedInstalledReceiptSha256: current.shadowInstalledReceiptSha256,
      expectedSettingsSha256: current.settingsSha256,
      expectedSourceCommit: current.commit,
      expectedSourceRelease: current.release,
      family: material.assembly.family,
      fencingToken: lease.fencingToken,
      fullMemberRootSha256: material.fullManifest.fullMemberRootSha256,
      lifecycleHeadSha256: material.nativeAccess.journalHeadSha256,
      policyDecision: "qualified",
      policyReportSha256: input.evaluation.policyReportSha256,
      predecessorActionSha256: null,
      reason: "qualified_candidate",
      reportCreatedAt,
      siteKey: "ballydidean",
      validThrough: new Date(Date.parse(reportCreatedAt) + 7 * 86_400_000).toISOString(),
    };
    const builtAction = buildAdjustmentModelAction(action);
    const nextConfirmationEligibleAt =
      new Date(Date.parse(reportCreatedAt) + 7 * 86_400_000).toISOString();
    const expectedLocalResult = Object.freeze({
      ...material.confirmationRegistration,
      accessState: "opened",
      actionIdentitySha256: builtAction.actionSha256,
      actionState: "action_pending",
      candidateReportSha256: input.evaluation.policyReportSha256,
      disposition: "promoted",
      fullMemberRootSha256: material.fullManifest.fullMemberRootSha256,
      nextConfirmationEligibleAt,
    });
    const evidence = buildAdjustmentQualifiedTerminalEvidenceMembers({
      action,
      assembly: material.assembly,
      candidateGraphSha256: material.candidate.candidateGraphSha256,
      candidateReportBytes,
      confirmationRegistration: material.confirmationRegistration,
      fullManifest: material.fullManifest,
      localBurn: material.localBurn,
      nativeAccess: material.nativeAccess,
      planGraphManifestSha256: material.planGraphManifestSha256,
      policyBytes,
      shadowRegistration: material.shadowRegistration,
    });
    const archiveEvidence = options.archiveEvidence ??
      (async (archiveInput) => await archiveAdjustmentMaintenanceTerminalEvidence(archiveInput));
    const publication = await archiveEvidence({
      archive: input.archive,
      clock,
      evidence,
      journal: input.journal,
      readHead: input.readHead,
    });
    requireSha256(publication.manifestObjectSha256,
      "qualified terminal graphManifestSha256");
    const fullGraphVerifiedAt = requireDate(clock()).toISOString();
    const acknowledgement = await input.journal.readLatestRevisionCustodyAcknowledgement();

    // require one current custody checkpoint before installing C authority
    if (acknowledgement === null) {
      throw new Error("qualified terminal custody acknowledgement is unavailable");
    }
    const inputClassMembers = buildAdjustmentMaintenanceInputClassMembers({
      artifactSha256: material.shadowRegistration.artifactSha256,
      candidateSha256: material.shadowRegistration.candidateSha256,
      family: action.family,
      rainGateInputMemberSha256s:
        material.assembly.rainGateInputMemberSha256s ?? [],
      terminalGraph: material.assembly.terminalGraph,
    });
    const requiredClassNames = FUTURE_INPUT_CLASS_NAMES.filter(
      // keep rain-gate optional only for the two non-rain families
      (name) => action.family === "rain" || name !== "rain_gate_input",
    );

    // qualified C authority requires every genuinely consumed semantic class
    if (requiredClassNames.some((name) => inputClassMembers[name].length === 0)) {
      throw new Error("qualified terminal input class is unavailable");
    }
    const readSeal = options.readSeal ?? fetchAdjustmentFutureOnlyInputSealCurrent;
    const predecessorSeal = await readSeal();
    const workstationHead = await input.journal.status();
    requireSha256(workstationHead.headSha256, "qualified workstationJournalHeadSha256");
    const seal = buildAdjustmentFutureOnlyInputSeal({
      archiveCommitOrdinal: acknowledgement.nextArchiveCommitOrdinal,
      burnSha256: material.localBurn.accessSha256,
      candidateReportSha256: input.evaluation.candidateReportSha256,
      captureEpochWitnessSha256: adjustmentSha256(canonicalJsonBytes(witness)),
      confirmationAccessSha256: material.nativeAccess.accessSha256,
      custodyCheckpointSha256: acknowledgement.custodyCheckpointSha256,
      dueKey: `confirmation/${action.family}/${action.candidateSha256}`,
      family: action.family,
      frontierSha256: acknowledgement.nextFrontierSha256,
      fullMemberRootSha256: material.fullManifest.fullMemberRootSha256,
      graphManifestSha256: publication.manifestObjectSha256,
      inputClassMembers,
      lifecycleLedgerRootSha256: action.lifecycleHeadSha256,
      pageSha256: acknowledgement.pageSha256,
      policyReportSha256: input.evaluation.policyReportSha256,
      predecessorSealSha256: predecessorSeal?.sealSha256 ?? null,
      sealedAt: fullGraphVerifiedAt,
      sequence: predecessorSeal === null
        ? "0"
        : (BigInt(predecessorSeal.seal.sequence) + 1n).toString(),
      sourceCommit: current.commit,
      workstationJournalHeadSha256: workstationHead.headSha256,
    });
    const installSeal = options.installSeal ??
      (async ({ seal: value }) => await installAdjustmentFutureOnlyInputSeal({ seal: value }));
    const readAnchor = options.readAnchor ?? fetchAdjustmentMaintenanceAnchorCurrentV3;
    const predecessorAnchor = await readAnchor();
    const anchor = buildAdjustmentMaintenanceTransferredAnchorV3({
      actionSha256: builtAction.actionSha256,
      controlSha256: witness.controlPlaneSha256,
      controlVersion: witness.controlPlaneVersion,
      fullGraphVerifiedAt,
      inputSeal: seal.seal,
      inputSealSha256: seal.sealSha256,
      predecessorAnchorSha256: predecessorAnchor?.anchorSha256 ?? null,
      publishedAt: requireDate(clock()).toISOString(),
    });
    const installAnchor = options.installAnchor ??
      (async ({ anchor: value }) => await installAdjustmentMaintenanceAnchorV3({ anchor: value }));
    const finalization = buildAdjustmentMaintenanceFinalizationProofV3({
      anchor: anchor.anchor,
      anchorSha256: anchor.anchorSha256,
      finalizedAt: requireDate(clock()).toISOString(),
    });
    const finalizeAnchor = options.finalizeAnchor ??
      (async ({ proof }) => await finalizeAdjustmentMaintenanceAnchorV3({ proof }));
    if (typeof input.journal.recordQualifiedTerminalAuthority !== "function") {
      throw new Error("qualified terminal recovery journal is unavailable");
    }
    const staged = await input.journal.recordQualifiedTerminalAuthority({
      action: builtAction.action,
      anchor: anchor.anchor,
      candidateReportSha256: input.evaluation.policyReportSha256,
      current,
      family: action.family,
      finalizationProof: finalization.proof,
      nextConfirmationEligibleAt,
      now: requireDate(clock()).toISOString(),
      registrationSha256: material.confirmationRegistration.registrationSha256,
      releaseDueKey,
      releaseRunId,
      seal: seal.seal,
    });

    // require the atomic journal transition to reproduce the predicted result
    if (!canonicalJsonBytes(staged.localResult).equals(
      canonicalJsonBytes(expectedLocalResult),
    )) {
      throw new Error("qualified terminal atomic result differs");
    }
    const localResult = staged.localResult;
    await installSeal({ seal: seal.seal });
    await installAnchor({ anchor: anchor.anchor });
    await finalizeAnchor({ proof: finalization.proof });
    const publishRelease = options.publishRelease ?? publishProductionQualifiedCandidate;
    const release = await publishRelease({
      action,
      current,
      dailyMaterial: material,
      due: input.due,
      finalization,
      fencingToken: lease.fencingToken,
      journal: input.journal,
      releaseDueKey,
      releaseRunId,
    });
    return await reconcileAdjustmentQualifiedOwnerTerminal({
      action: builtAction,
      archive: input.archive,
      clock,
      finalization,
      journal: input.journal,
      localResult,
      material,
      due: input.due,
      options,
      publicationManifestSha256: publication.manifestObjectSha256,
      readHead: input.readHead,
      release,
      seal,
      semanticInputSha256: input.evaluation.semanticInputSha256,
      sourceCommit: current.commit,
    });
  } finally {
    // release only the exact still-live qualified publisher fence
    if (acquired) {
      await input.journal.releaseLease({
        dueKey: releaseDueKey,
        now: requireDate(clock()).toISOString(),
        runId: releaseRunId,
        scope: "release",
      });
      acquired = false;
    }
  }
}

// resume one promoted member from its original durable action and root documents
async function recoverAdjustmentQualifiedDailyTerminal(input) {
  const material = input.dailyMaterial;
  const registrationSha256 = material.confirmationRegistration.registrationSha256;
  const readAuthority = input.journal.readQualifiedTerminalAuthority;
  const readTransaction = input.journal.readQualifiedModelReleaseTransaction;

  // refuse recovery from hashes or a rebuilt live-source action
  if (typeof readAuthority !== "function" || typeof readTransaction !== "function") {
    throw new Error("qualified terminal recovery journal is unavailable");
  }
  const authority = await readAuthority.call(input.journal, {
    family: material.assembly.family,
    registrationSha256,
  });
  if (authority === null) {
    throw new Error("qualified terminal authority is unavailable");
  }
  const recovered = validateAdjustmentQualifiedTerminalAuthority(
    authority,
    input.evaluation,
    material,
    input.localResult,
  );
  await restoreAdjustmentQualifiedTerminalAuthority(recovered, input.options);
  const releaseDueKey = `confirmation/${recovered.action.family}/` +
    recovered.action.candidateSha256;
  const releaseRunId = `release-promote-${recovered.action.candidateSha256.slice(0, 32)}`;
  const clock = input.options.clock ?? (() => new Date());
  let transaction = await readTransaction.call(input.journal, {
    family: material.assembly.family,
    registrationSha256,
  });
  const retainedLease = typeof input.journal.continueConfirmationActionLease === "function"
    ? await input.journal.continueConfirmationActionLease({
        family: recovered.action.family,
        now: requireDate(clock()).toISOString(),
        registrationSha256,
      })
    : typeof input.journal.readConfirmationActionLease === "function"
      ? await input.journal.readConfirmationActionLease({
          family: recovered.action.family,
          now: requireDate(clock()).toISOString(),
          registrationSha256,
        })
      : null;
  let release;

  // finish immutable publication only from the original staged action and source
  if (transaction === null) {
    // fail closed once the original pre-publication fence is no longer live
    if (retainedLease === null || retainedLease.live !== true ||
      retainedLease.dueKey !== releaseDueKey || retainedLease.runId !== releaseRunId ||
      retainedLease.fencingToken !== recovered.action.fencingToken) {
      throw new Error("qualified release original fence is unavailable");
    }
    const publishRelease = input.options.publishRelease ?? publishProductionQualifiedCandidate;
    release = await publishRelease({
      action: recovered.action,
      current: recovered.current,
      dailyMaterial: material,
      due: input.due,
      finalization: recovered.finalization,
      fencingToken: recovered.action.fencingToken,
      journal: input.journal,
      releaseDueKey,
      releaseRunId,
    });
    transaction = await readTransaction.call(input.journal, {
      family: material.assembly.family,
      registrationSha256,
    });
    if (transaction === null) {
      throw new Error("qualified release recovery transaction is unavailable");
    }
  } else {
    const validated = validateAdjustmentQualifiedReleaseTransaction(
      transaction,
      recovered,
      material,
    );
    const fetchStatus = input.options.fetchReleaseStatus ??
      fetchAdjustmentFamilyReleaseStatus;
    const applyRelease = input.options.applyRelease ?? applyAdjustmentFamilyRelease;
    let status = await fetchStatus(validated.target.actionSha256);
    validateAdjustmentQualifiedReleaseStatus(status, validated);

    // use the exact persisted request to finish absent or interrupted root work
    if (status.state === "absent" || status.state === "prepared" ||
      status.state === "applying" || status.state === "compensation_required" &&
        status.compensationState !== "verified") {
      status = await applyRelease(validated.releaseRequest);
      validateAdjustmentQualifiedReleaseStatus(status, validated);
    }
    release = Object.freeze({
      compensationActionSha256: validated.compensation.actionSha256,
      compensationKind: validated.compensationAction.actionKind,
      pair: Object.freeze({
        compensation: validated.compensation,
        target: validated.target,
      }),
      status,
    });
  }
  const validatedTransaction = validateAdjustmentQualifiedReleaseTransaction(
    transaction,
    recovered,
    material,
  );

  // bind a newly published retry to the same persisted manifests before owner work
  if (release.compensationActionSha256 !== validatedTransaction.compensation.actionSha256 ||
    release.compensationKind !== validatedTransaction.compensationAction.actionKind) {
    throw new Error("qualified release recovery identity differs");
  }
  const result = await reconcileAdjustmentQualifiedOwnerTerminal({
    action: buildAdjustmentModelAction(recovered.action),
    archive: input.archive,
    clock,
    finalization: recovered.finalization,
    journal: input.journal,
    localResult: input.localResult,
    material,
    due: input.due,
    options: input.options,
    publicationManifestSha256: recovered.finalization.proof.graphManifestSha256,
    readHead: input.readHead,
    release,
    seal: recovered.seal,
    semanticInputSha256: input.evaluation.semanticInputSha256,
    sourceCommit: recovered.action.expectedSourceCommit,
  });

  // release a surviving original fence only after exact owner retirement
  if (retainedLease?.live === true) {
    await input.journal.releaseLease({
      dueKey: releaseDueKey,
      now: requireDate(clock()).toISOString(),
      runId: releaseRunId,
      scope: "release",
    });
  }
  return result;
}

// validate the locally staged promotion authority before any root retry
function validateAdjustmentQualifiedTerminalAuthority(value, evaluation, material, localResult) {
  requireExactKeys(value, [
    "action", "anchor", "current", "family", "finalizationProof",
    "registrationSha256", "seal",
  ], "qualified terminal authority");
  const built = buildAdjustmentModelAction(value.action);
  const seal = validateAdjustmentFutureOnlyInputSeal(value.seal);
  const anchor = validateAdjustmentMaintenanceAnchorV3(value.anchor);
  const proof = validateAdjustmentMaintenanceFinalizationProofV3(value.finalizationProof);
  validateAdjustmentFamilyReleaseCurrent(value.current, value.family);
  const anchorSha256 = adjustmentSha256(canonicalJsonBytes(anchor));
  const rebuilt = buildAdjustmentMaintenanceFinalizationProofV3({
    anchor,
    anchorSha256,
    finalizedAt: proof.finalizedAt,
  });

  // require exact action, graph and local-result identity continuity
  if (value.family !== material.assembly.family ||
    value.registrationSha256 !== material.confirmationRegistration.registrationSha256 ||
    built.actionSha256 !== localResult.actionIdentitySha256 ||
    built.action.candidateSha256 !== material.shadowRegistration.candidateSha256 ||
    built.action.candidateGraphSha256 !== material.candidate.candidateGraphSha256 ||
    built.action.fullMemberRootSha256 !== material.fullManifest.fullMemberRootSha256 ||
    built.action.policyReportSha256 !== evaluation.policyReportSha256 ||
    anchor.actionSha256 !== built.actionSha256 ||
    anchor.inputSealSha256 !== adjustmentSha256(canonicalJsonBytes(seal)) ||
    !canonicalJsonBytes(rebuilt.proof).equals(canonicalJsonBytes(proof))) {
    throw new Error("qualified terminal authority differs");
  }
  return Object.freeze({
    action: built.action,
    anchor,
    current: value.current,
    finalization: rebuilt,
    seal: Object.freeze({
      bytes: canonicalJsonBytes(seal),
      seal,
      sealSha256: adjustmentSha256(canonicalJsonBytes(seal)),
    }),
  });
}

// restore an interrupted C/T/F sequence from the original staged documents
async function restoreAdjustmentQualifiedTerminalAuthority(authority, options) {
  const installSeal = options.installSeal ??
    (async ({ seal }) => await installAdjustmentFutureOnlyInputSeal({ seal }));
  const installAnchor = options.installAnchor ??
    (async ({ anchor }) => await installAdjustmentMaintenanceAnchorV3({ anchor }));
  const finalizeAnchor = options.finalizeAnchor ??
    (async ({ proof }) => await finalizeAdjustmentMaintenanceAnchorV3({ proof }));

  // replay only exact retained bytes; every root transition is idempotent
  await installSeal({ seal: authority.seal.seal });
  await installAnchor({ anchor: authority.anchor });
  await finalizeAnchor({ proof: authority.finalization.proof });
}

// validate the published release pair used by root status reconciliation
function validateAdjustmentQualifiedReleaseTransaction(value, authority, material) {
  requireExactKeys(value, [
    "compensation", "compensationAction", "family", "finalizationProof",
    "registrationSha256", "releaseRequest", "target", "targetAction",
  ], "qualified release recovery transaction");
  const target = buildAdjustmentModelAction(value.targetAction);
  const compensation = buildAdjustmentModelAction(value.compensationAction);
  requireExactKeys(value.target, ["actionSha256", "commitSha", "releaseTag"],
    "qualified target release");
  requireExactKeys(value.compensation, ["actionSha256", "commitSha", "releaseTag"],
    "qualified compensation release");
  requireExactKeys(value.releaseRequest, [
    "actionSha256", "compensatingRelease", "expectedCurrentRelease",
    "expectedSettingsSha256", "expectedSourceRelease", "family", "fencingToken",
    "reportSha256", "targetRelease",
  ], "qualified family release request");

  // preserve exact staged action, compensation and root command identities
  if (value.family !== authority.action.family ||
    value.registrationSha256 !== material.confirmationRegistration.registrationSha256 ||
    target.actionSha256 !== adjustmentSha256(canonicalJsonBytes(authority.action)) ||
    value.target.actionSha256 !== target.actionSha256 ||
    value.compensation.actionSha256 !== compensation.actionSha256 ||
    compensation.action.predecessorActionSha256 !== target.actionSha256 ||
    compensation.action.expectedSourceCommit !== value.target.commitSha ||
    compensation.action.expectedSourceRelease !== value.target.releaseTag ||
    !canonicalJsonBytes(value.finalizationProof)
      .equals(canonicalJsonBytes(authority.finalization.proof)) ||
    value.releaseRequest.actionSha256 !== target.actionSha256 ||
    value.releaseRequest.targetRelease !== value.target.releaseTag ||
    value.releaseRequest.compensatingRelease !== value.compensation.releaseTag ||
    value.releaseRequest.expectedCurrentRelease !== target.action.expectedSourceRelease ||
    value.releaseRequest.expectedSourceRelease !== target.action.expectedSourceRelease ||
    value.releaseRequest.expectedSettingsSha256 !== target.action.expectedSettingsSha256 ||
    value.releaseRequest.fencingToken !== target.action.fencingToken ||
    value.releaseRequest.reportSha256 !== target.action.policyReportSha256) {
    throw new Error("qualified release recovery transaction differs");
  }
  return Object.freeze({
    ...value,
    compensationAction: compensation.action,
    targetAction: target.action,
  });
}

// crossbind one root status projection to its persisted release transaction
function validateAdjustmentQualifiedReleaseStatus(status, transaction) {
  validateAdjustmentFamilyReleaseStatus(status, transaction.target.actionSha256);

  // absence carries no guessed publication fields
  if (status.state === "absent") {
    return status;
  }
  if (status.family !== transaction.family ||
    status.fencingToken !== transaction.targetAction.fencingToken ||
    status.targetRelease !== transaction.target.releaseTag ||
    status.compensatingRelease !== transaction.compensation.releaseTag) {
    throw new Error("qualified root release status differs");
  }
  return status;
}

// derive the effective serving result from one reconciled root transaction
export function projectAdjustmentQualifiedReleaseOutcome(status, compensationKind) {
  validateAdjustmentFamilyReleaseStatus(status);

  // distinguish an acknowledged deploy whose final operator state is disabled
  if (status.state === "acknowledged") {
    return Object.freeze({
      acknowledgementOutcome: status.outcome === "active"
        ? "active"
        : "deployed_operator_off",
      compensationOutcome: null,
      servingChanged: status.outcome === "active",
      verificationOutcome: status.outcome === "active"
        ? "verified"
        : "deployed_operator_off",
    });
  }

  // close only a verified safe compensation result
  if (status.state === "compensation_required" && status.compensationState === "verified" &&
    new Set(["compensate_incumbent", "compensate_raw"]).has(compensationKind)) {
    return Object.freeze({
      acknowledgementOutcome: null,
      compensationOutcome: compensationKind === "compensate_raw"
        ? "raw_installed"
        : "incumbent_restored",
      servingChanged: false,
      verificationOutcome: "failed",
    });
  }
  throw new Error("qualified family release is not reconciled");
}

// reconcile the local action lifecycle and authenticated owner terminal row
async function reconcileAdjustmentQualifiedOwnerTerminal(input) {
  const actionReceipt = validateAdjustmentFamilyReleaseStatus(
    input.release.status,
    input.action.actionSha256,
  );
  const action = input.action.action;
  const registrationSha256 = input.material.confirmationRegistration.registrationSha256;
  const receiptSha256 = adjustmentSha256(canonicalJsonBytes(actionReceipt));

  const operatorOffUnapplied = actionReceipt.state === "operator_off_unapplied";
  let effective;

  // close an authenticated pre-apply operator-off result without claiming apply
  if (operatorOffUnapplied) {
    await input.journal.recordConfirmationCompensationResult({
      actionIdentitySha256: input.action.actionSha256,
      compensationActionIdentitySha256: input.release.compensationActionSha256,
      compensationReportSha256: action.policyReportSha256,
      family: action.family,
      fencingToken: action.fencingToken,
      now: requireDate(input.clock()).toISOString(),
      outcome: "unapplied",
      registrationSha256,
    });
    effective = Object.freeze({ servingChanged: false });
  } else {
    effective = projectAdjustmentQualifiedReleaseOutcome(
      actionReceipt,
      input.release.compensationKind,
    );
    await input.journal.recordConfirmationActionApplied({
      actionIdentitySha256: input.action.actionSha256,
      applyReceiptSha256: receiptSha256,
      family: action.family,
      fencingToken: action.fencingToken,
      now: requireDate(input.clock()).toISOString(),
      registrationSha256,
    });
    const acknowledged = actionReceipt.state === "acknowledged";
    await input.journal.recordConfirmationActionVerified({
      actionIdentitySha256: input.action.actionSha256,
      family: action.family,
      fencingToken: action.fencingToken,
      now: requireDate(input.clock()).toISOString(),
      registrationSha256,
      verificationOutcome: effective.verificationOutcome,
      verificationSha256: receiptSha256,
    });

    // close the immutable local action only after the root categorical result
    if (acknowledged) {
      await input.journal.acknowledgeConfirmationAction({
        acknowledgementSha256: receiptSha256,
        actionIdentitySha256: input.action.actionSha256,
        family: action.family,
        fencingToken: action.fencingToken,
        now: requireDate(input.clock()).toISOString(),
        outcome: effective.acknowledgementOutcome,
        registrationSha256,
      });
    } else {
      await input.journal.recordConfirmationCompensationResult({
        actionIdentitySha256: input.action.actionSha256,
        compensationActionIdentitySha256: input.release.compensationActionSha256,
        compensationReportSha256: action.policyReportSha256,
        family: action.family,
        fencingToken: action.fencingToken,
        now: requireDate(input.clock()).toISOString(),
        outcome: effective.compensationOutcome,
        registrationSha256,
      });
    }
  }
  const servingChanged = effective.servingChanged;
  const terminalGraphVerifiedAt = requireDate(input.clock()).toISOString();
  const previousTombstone = await input.journal.readOwnerTerminalTombstone({
    family: action.family,
  });
  const recordRequest = validateAdjustmentShadowTerminalRecordRequestV3({
    action,
    actionReceipt,
    confirmationRegistration: input.material.confirmationRegistration,
    contractVersion: "adjustment-shadow-terminal-record-request/v3",
    finalizationProof: input.finalization.proof,
    localResult: input.localResult,
    nativeAccess: input.material.nativeAccess,
    previousTombstone,
    shadowRegistration: input.material.shadowRegistration,
    sourceCommit: input.sourceCommit,
    terminalGraphManifestSha256: input.publicationManifestSha256,
    terminalGraphVerifiedAt,
  });
  const recordTerminal = input.options.recordTerminal ??
    (async ({ request }) => await recordAdjustmentShadowTerminalV3({ request }));
  const recorded = await recordTerminal({ request: recordRequest });
  requirePlainObject(recorded?.terminalRecord, "qualified terminal owner record");
  const tombstone = {
    contractVersion: "adjustment-shadow-terminal-tombstone/v3",
    reconciliationSha256: recorded.terminalRecord.reconciliationSha256,
    registrationSha256: recorded.terminalRecord.registrationSha256,
    terminalResultSha256: recorded.terminalRecord.terminalResultSha256,
  };
  const archiveTombstone = input.options.archiveTombstone ??
    (async (archiveInput) => await publishAdjustmentArchiveMember(archiveInput));
  await archiveTombstone({
    archive: input.archive,
    clock: input.clock,
    identitySha256: adjustmentSha256(canonicalJsonBytes(tombstone)),
    journal: input.journal,
    kind: tombstone.contractVersion,
    payload: canonicalJsonBytes(tombstone),
    readHead: input.readHead,
  });
  await input.journal.recordOwnerTerminalTombstone({
    family: action.family,
    now: requireDate(input.clock()).toISOString(),
    tombstone,
  });
  const retirementRequest = validateAdjustmentShadowTerminalRetirementRequestV3({
    contractVersion: "adjustment-shadow-terminal-retirement-request/v3",
    finalizationProof: input.finalization.proof,
    registrationSha256: input.material.shadowRegistration.registrationSha256,
    terminalRecord: recorded.terminalRecord,
    terminalTombstone: tombstone,
  });
  const retirement = await retainAdjustmentDueTerminalRetirement({
    dueKey: input.due.dueKey,
    journal: input.journal,
    kind: "qualified_v3",
    now: requireDate(input.clock()).toISOString(),
    outcome: {
      actionEligible: true,
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: "daily_candidate_promoted",
      semanticInputSha256: input.semanticInputSha256,
      servingChanged,
      state: "completed",
    },
    request: retirementRequest,
  });
  const retireTerminal = input.options.retireTerminal ??
    (async ({ request }) => await retireAdjustmentShadowTerminalV3({ request }));
  const retired = await retireTerminal({ request: retirementRequest });
  await completeAdjustmentDueTerminalRetirement({
    dueKey: input.due.dueKey,
    journal: input.journal,
    now: requireDate(input.clock()).toISOString(),
    requestSha256: retirement.requestSha256,
  });
  return Object.freeze({
    action: input.action,
    finalization: input.finalization,
    recorded,
    release: input.release,
    retired,
    seal: input.seal,
    servingChanged,
    tombstone: Object.freeze(tombstone),
  });
}

// validate one staged no-action authority without using live predecessor state
function validateAdjustmentNoActionTerminalAuthority(value, actionIdentity, material) {
  requireExactKeys(value, [
    "actionIdentity", "anchor", "current", "disposition", "family",
    "finalizationProof", "registrationSha256", "seal",
  ], "no-action terminal authority");
  const seal = validateAdjustmentFutureOnlyInputSeal(value.seal);
  const anchor = validateAdjustmentMaintenanceAnchorV3(value.anchor);
  const proof = validateAdjustmentMaintenanceFinalizationProofV3(value.finalizationProof);
  validateAdjustmentFamilyReleaseCurrent(value.current, value.family);
  const actionSha256 = adjustmentSha256(canonicalJsonBytes(actionIdentity));
  const rebuilt = buildAdjustmentMaintenanceFinalizationProofV3({
    anchor,
    anchorSha256: adjustmentSha256(canonicalJsonBytes(anchor)),
    finalizedAt: proof.finalizedAt,
  });

  // preserve the exact nonmutating identity, graph and source authority
  if (!canonicalJsonBytes(value.actionIdentity).equals(canonicalJsonBytes(actionIdentity)) ||
    value.disposition !== actionIdentity.disposition ||
    value.family !== material.assembly.family ||
    value.registrationSha256 !== material.confirmationRegistration.registrationSha256 ||
    anchor.actionSha256 !== actionSha256 ||
    anchor.fullMemberRootSha256 !== material.fullManifest.fullMemberRootSha256 ||
    anchor.inputSealSha256 !== adjustmentSha256(canonicalJsonBytes(seal)) ||
    !canonicalJsonBytes(rebuilt.proof).equals(canonicalJsonBytes(proof))) {
    throw new Error("no-action terminal authority differs");
  }
  return Object.freeze({
    action: actionIdentity,
    anchor,
    current: value.current,
    finalization: rebuilt,
    seal: Object.freeze({
      bytes: canonicalJsonBytes(seal),
      seal,
      sealSha256: adjustmentSha256(canonicalJsonBytes(seal)),
    }),
  });
}

// record and retire one exact no-action result after restored C/T/F authority
async function reconcileAdjustmentNoActionOwnerTerminal(input) {
  const completedAt = input.finalization.proof.finalizedAt;
  const localResult = await input.journal.recordConfirmationResult({
    actionIdentitySha256: null,
    candidateReportSha256: input.actionIdentity.policyReportSha256,
    disposition: input.disposition,
    family: input.material.assembly.family,
    nextConfirmationEligibleAt:
      new Date(Date.parse(completedAt) + 7 * 86_400_000).toISOString(),
    now: completedAt,
    registrationSha256: input.material.confirmationRegistration.registrationSha256,
  });
  const receipt = buildAdjustmentTerminalNoActionReceipt({
    completedAt,
    disposition: input.disposition,
    finalizedAt: input.finalization.proof.finalizedAt,
    fullMemberRootSha256: input.material.fullManifest.fullMemberRootSha256,
    policyReportSha256: input.actionIdentity.policyReportSha256,
    registrationSha256: input.material.shadowRegistration.registrationSha256,
  });
  const previousTombstone = await input.journal.readOwnerTerminalTombstone({
    family: input.material.assembly.family,
  });
  const terminalGraphVerifiedAt = requireDate(input.clock()).toISOString();
  const recordRequest = validateAdjustmentShadowTerminalRecordRequestV3({
    action: null,
    actionReceipt: receipt.receipt,
    confirmationRegistration: input.material.confirmationRegistration,
    contractVersion: "adjustment-shadow-terminal-record-request/v3",
    finalizationProof: input.finalization.proof,
    localResult,
    nativeAccess: input.material.nativeAccess,
    previousTombstone,
    shadowRegistration: input.material.shadowRegistration,
    sourceCommit: input.sourceCommit,
    terminalGraphManifestSha256: input.publicationManifestSha256,
    terminalGraphVerifiedAt,
  });
  const recordTerminal = input.options.recordTerminal ??
    (async ({ request }) => await recordAdjustmentShadowTerminalV3({ request }));
  const recorded = await recordTerminal({ request: recordRequest });
  requirePlainObject(recorded?.terminalRecord, "no-action terminal owner record");
  const tombstone = {
    contractVersion: "adjustment-shadow-terminal-tombstone/v3",
    reconciliationSha256: recorded.terminalRecord.reconciliationSha256,
    registrationSha256: recorded.terminalRecord.registrationSha256,
    terminalResultSha256: recorded.terminalRecord.terminalResultSha256,
  };
  const archiveTombstone = input.options.archiveTombstone ??
    (async (archiveInput) => await publishAdjustmentArchiveMember(archiveInput));
  await archiveTombstone({
    archive: input.archive,
    clock: input.clock,
    identitySha256: adjustmentSha256(canonicalJsonBytes(tombstone)),
    journal: input.journal,
    kind: tombstone.contractVersion,
    payload: canonicalJsonBytes(tombstone),
    readHead: input.readHead,
  });
  await input.journal.recordOwnerTerminalTombstone({
    family: input.material.assembly.family,
    now: requireDate(input.clock()).toISOString(),
    tombstone,
  });
  const retirementRequest = validateAdjustmentShadowTerminalRetirementRequestV3({
    contractVersion: "adjustment-shadow-terminal-retirement-request/v3",
    finalizationProof: input.finalization.proof,
    registrationSha256: input.material.shadowRegistration.registrationSha256,
    terminalRecord: recorded.terminalRecord,
    terminalTombstone: tombstone,
  });
  const retirement = await retainAdjustmentDueTerminalRetirement({
    dueKey: input.due.dueKey,
    journal: input.journal,
    kind: "qualified_v3",
    now: requireDate(input.clock()).toISOString(),
    outcome: {
      actionEligible: false,
      candidateGraphSha256: null,
      candidateSha256: null,
      fitReceiptSha256: null,
      reason: input.disposition === "rejected"
        ? "daily_candidate_rejected"
        : "daily_support_failed",
      semanticInputSha256: input.semanticInputSha256,
      servingChanged: false,
      state: "completed",
    },
    request: retirementRequest,
  });
  const retireTerminal = input.options.retireTerminal ??
    (async ({ request }) => await retireAdjustmentShadowTerminalV3({ request }));
  const retired = await retireTerminal({ request: retirementRequest });
  await completeAdjustmentDueTerminalRetirement({
    dueKey: input.due.dueKey,
    journal: input.journal,
    now: requireDate(input.clock()).toISOString(),
    requestSha256: retirement.requestSha256,
  });
  return Object.freeze({
    action: receipt,
    finalization: input.finalization,
    recorded,
    retired,
    seal: input.seal,
    servingChanged: false,
    tombstone: Object.freeze(tombstone),
  });
}

// finalize one evaluated no-action member through C, T, F and owner retirement
export async function completeAdjustmentNoActionDailyTerminal(input, options = {}) {
  requireExactKeys(input, [
    "archive", "dailyMaterial", "disposition", "due", "epochWitness", "evaluation",
    "journal", "readHead",
  ], "no-action daily terminal completion input");
  validateDue(input.due);
  requirePlainObject(options, "no-action daily terminal completion options");
  const allowed = new Set([
    "archiveEvidence", "archiveTombstone", "clock", "fetchCurrent", "finalizeAnchor",
    "installAnchor", "installSeal", "readAnchor", "readSeal", "recordTerminal",
    "retireTerminal",
  ]);

  // permit only isolated durable ports for exact transition tests
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    [...allowed].some((key) => key !== "clock" && options[key] !== undefined &&
      typeof options[key] !== "function") ||
    (options.clock !== undefined && typeof options.clock !== "function") ||
    !new Set(["rejected", "support_failed"])
      .has(input.disposition)) {
    throw new TypeError("no-action daily terminal completion options are invalid");
  }
  const material = input.dailyMaterial;
  requirePlainObject(material, "no-action daily material");
  requirePlainObject(input.evaluation, "no-action daily evaluation");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const clock = options.clock ?? (() => new Date());
  const candidateReport = parseCanonicalBase64Document(
    input.evaluation.candidateReportBase64,
    input.evaluation.candidateReportSha256,
    "no-action candidate report",
  );
  const policyVersion = REGISTRATION_POLICY_VERSIONS.get(input.evaluation.family);

  // require one closed family policy before installing terminal authority
  if (policyVersion === undefined || input.evaluation.state !== "evaluated" ||
    input.evaluation.family !== material.assembly.family ||
    input.evaluation.fullMemberRootSha256 !== material.fullManifest.fullMemberRootSha256) {
    throw new TypeError("no-action daily evaluation is invalid");
  }
  const evaluatedDisposition = input.evaluation.policy?.state === "fail" &&
    input.evaluation.policy?.action === "retain"
    ? "rejected"
    : input.evaluation.policy?.state === "pending" &&
        input.evaluation.policy?.action === "pending"
      ? "support_failed"
      : null;

  // prohibit relabelling a genuine policy result as another terminal disposition
  if (evaluatedDisposition !== input.disposition) {
    throw new TypeError("no-action daily disposition differs");
  }
  const policy = parseCanonicalBase64Document(
    input.evaluation.policyBytesBase64,
    input.evaluation.policyReportSha256,
    "no-action policy report",
    policyVersion,
  );
  const actionIdentity = {
    contractVersion: "adjustment-terminal-no-action-identity/v3",
    disposition: input.disposition,
    policyReportSha256: input.evaluation.policyReportSha256,
    registrationSha256: material.shadowRegistration.registrationSha256,
  };
  const actionSha256 = adjustmentSha256(canonicalJsonBytes(actionIdentity));
  const retainedAuthority = typeof input.journal.readNoActionTerminalAuthority === "function"
    ? await input.journal.readNoActionTerminalAuthority({
        family: material.assembly.family,
        registrationSha256: material.confirmationRegistration.registrationSha256,
      })
    : null;

  // finish an interrupted no-action C/T/F sequence from its original documents
  if (retainedAuthority !== null) {
    const recovered = validateAdjustmentNoActionTerminalAuthority(
      retainedAuthority,
      actionIdentity,
      material,
    );
    await restoreAdjustmentQualifiedTerminalAuthority(recovered, options);
    return await reconcileAdjustmentNoActionOwnerTerminal({
      actionIdentity,
      actionSha256,
      archive: input.archive,
      clock,
      disposition: input.disposition,
      finalization: recovered.finalization,
      journal: input.journal,
      material,
      due: input.due,
      options,
      publicationManifestSha256: recovered.finalization.proof.graphManifestSha256,
      readHead: input.readHead,
      seal: recovered.seal,
      semanticInputSha256: input.evaluation.semanticInputSha256,
      sourceCommit: recovered.current.commit,
    });
  }
  const fetchCurrent = options.fetchCurrent ?? fetchAdjustmentFamilyReleaseCurrent;
  const current = await fetchCurrent(material.assembly.family);
  const lifecycle = await input.journal.status();
  requireSha256(lifecycle.headSha256, "no-action lifecycleLedgerRootSha256");
  const evidence = buildAdjustmentQualifiedTerminalEvidenceMembers({
    action: actionIdentity,
    assembly: material.assembly,
    candidateGraphSha256: material.candidate.candidateGraphSha256,
    candidateReportBytes: canonicalJsonBytes(candidateReport),
    confirmationRegistration: material.confirmationRegistration,
    fullManifest: material.fullManifest,
    localBurn: material.localBurn,
    nativeAccess: material.nativeAccess,
    planGraphManifestSha256: material.planGraphManifestSha256,
    policyBytes: canonicalJsonBytes(policy),
    shadowRegistration: material.shadowRegistration,
  });
  const archiveEvidence = options.archiveEvidence ??
    (async (archiveInput) => await archiveAdjustmentMaintenanceTerminalEvidence(archiveInput));
  const publication = await archiveEvidence({
    archive: input.archive,
    clock,
    evidence,
    journal: input.journal,
    readHead: input.readHead,
  });
  requireSha256(publication.manifestObjectSha256,
    "no-action terminal graphManifestSha256");
  const fullGraphVerifiedAt = requireDate(clock()).toISOString();
  const acknowledgement = await input.journal.readLatestRevisionCustodyAcknowledgement();

  // require current custody before installing complete terminal authority
  if (acknowledgement === null) {
    throw new Error("no-action terminal custody acknowledgement is unavailable");
  }
  const inputClassMembers = buildAdjustmentMaintenanceInputClassMembers({
    artifactSha256: material.shadowRegistration.artifactSha256,
    candidateSha256: material.shadowRegistration.candidateSha256,
    family: material.assembly.family,
    rainGateInputMemberSha256s: material.assembly.rainGateInputMemberSha256s ?? [],
    terminalGraph: material.assembly.terminalGraph,
  });
  const requiredClassNames = FUTURE_INPUT_CLASS_NAMES.filter(
    // keep rain-gate optional only for the two non-rain families
    (name) => material.assembly.family === "rain" || name !== "rain_gate_input",
  );

  // a complete no-action result retains the same semantic class strength as promotion
  if (requiredClassNames.some((name) => inputClassMembers[name].length === 0)) {
    throw new Error("no-action terminal input class is unavailable");
  }
  const readSeal = options.readSeal ?? fetchAdjustmentFutureOnlyInputSealCurrent;
  const predecessorSeal = await readSeal();
  const workstationHead = await input.journal.status();
  requireSha256(workstationHead.headSha256, "no-action workstationJournalHeadSha256");
  const seal = buildAdjustmentFutureOnlyInputSeal({
    archiveCommitOrdinal: acknowledgement.nextArchiveCommitOrdinal,
    burnSha256: material.localBurn.accessSha256,
    candidateReportSha256: input.evaluation.candidateReportSha256,
    captureEpochWitnessSha256: adjustmentSha256(canonicalJsonBytes(witness)),
    confirmationAccessSha256: material.nativeAccess.accessSha256,
    custodyCheckpointSha256: acknowledgement.custodyCheckpointSha256,
    dueKey: `confirmation/${material.assembly.family}/` +
      material.shadowRegistration.candidateSha256,
    family: material.assembly.family,
    frontierSha256: acknowledgement.nextFrontierSha256,
    fullMemberRootSha256: material.fullManifest.fullMemberRootSha256,
    graphManifestSha256: publication.manifestObjectSha256,
    inputClassMembers,
    lifecycleLedgerRootSha256: lifecycle.headSha256,
    pageSha256: acknowledgement.pageSha256,
    policyReportSha256: input.evaluation.policyReportSha256,
    predecessorSealSha256: predecessorSeal?.sealSha256 ?? null,
    sealedAt: fullGraphVerifiedAt,
    sequence: predecessorSeal === null
      ? "0"
      : (BigInt(predecessorSeal.seal.sequence) + 1n).toString(),
    sourceCommit: current.commit,
    workstationJournalHeadSha256: workstationHead.headSha256,
  });
  const installSeal = options.installSeal ??
    (async ({ seal: value }) => await installAdjustmentFutureOnlyInputSeal({ seal: value }));
  const readAnchor = options.readAnchor ?? fetchAdjustmentMaintenanceAnchorCurrentV3;
  const predecessorAnchor = await readAnchor();
  const anchor = buildAdjustmentMaintenanceTransferredAnchorV3({
    actionSha256,
    controlSha256: witness.controlPlaneSha256,
    controlVersion: witness.controlPlaneVersion,
    fullGraphVerifiedAt,
    inputSeal: seal.seal,
    inputSealSha256: seal.sealSha256,
    predecessorAnchorSha256: predecessorAnchor?.anchorSha256 ?? null,
    publishedAt: requireDate(clock()).toISOString(),
  });
  const installAnchor = options.installAnchor ??
    (async ({ anchor: value }) => await installAdjustmentMaintenanceAnchorV3({ anchor: value }));
  const finalization = buildAdjustmentMaintenanceFinalizationProofV3({
    anchor: anchor.anchor,
    anchorSha256: anchor.anchorSha256,
    finalizedAt: requireDate(clock()).toISOString(),
  });
  const finalizeAnchor = options.finalizeAnchor ??
    (async ({ proof }) => await finalizeAdjustmentMaintenanceAnchorV3({ proof }));
  if (typeof input.journal.recordNoActionTerminalAuthority !== "function") {
    throw new Error("no-action terminal recovery journal is unavailable");
  }
  await input.journal.recordNoActionTerminalAuthority({
    actionIdentity,
    anchor: anchor.anchor,
    current,
    disposition: input.disposition,
    family: material.assembly.family,
    finalizationProof: finalization.proof,
    now: requireDate(clock()).toISOString(),
    registrationSha256: material.confirmationRegistration.registrationSha256,
    seal: seal.seal,
  });
  await installSeal({ seal: seal.seal });
  await installAnchor({ anchor: anchor.anchor });
  await finalizeAnchor({ proof: finalization.proof });
  return await reconcileAdjustmentNoActionOwnerTerminal({
    actionIdentity,
    actionSha256,
    archive: input.archive,
    clock,
    disposition: input.disposition,
    finalization,
    journal: input.journal,
    material,
    due: input.due,
    options,
    publicationManifestSha256: publication.manifestObjectSha256,
    readHead: input.readHead,
    seal,
    semanticInputSha256: input.evaluation.semanticInputSha256,
    sourceCommit: current.commit,
  });
}

// restore one raw fit and portable artifact from their authenticated candidate graph
export async function restoreAdjustmentCandidateMaterial(input) {
  requireExactKeys(input, [
    "archive", "artifactSha256", "candidateGraphSha256", "candidateSha256", "family",
  ], "candidate material restore input");
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily family before selecting archive members
  if (input.family === null) {
    throw new TypeError("candidate material family is invalid");
  }
  for (const field of ["artifactSha256", "candidateGraphSha256", "candidateSha256"]) {
    requireSha256(input[field], `candidate material ${field}`);
  }
  const verified = await input.archive.verifyFullGraph(input.candidateGraphSha256, {
    verifyPredecessors: false,
  });
  const parityMembers = verified.manifest.entries.filter(
    // select only the one archived candidate parity receipt
    (entry) => entry.kind === "forecast-adjustment-model-parity/v1",
  );

  // refuse a graph without one exact reusable parity receipt
  if (parityMembers.length !== 1) {
    throw new Error("candidate material parity receipt is unavailable");
  }
  const paritySha256 = parityMembers[0].identitySha256;
  requireSha256(paritySha256, "candidate material paritySha256");
  const files = new Map();
  const sink = {
    // retain only the three explicitly requested verified member streams
    writeExclusive: async (fileName, readable, expectedLength) => {
      const chunks = [];
      let length = 0;

      // enforce the family artifact bound while consuming the verified range
      for await (const chunk of readable) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 8 * 1_024 * 1_024) {
          throw new RangeError("candidate material exceeds its bound");
        }
        chunks.push(bytes);
      }

      // prohibit short reads and duplicate fixed sink names
      if (length !== expectedLength || files.has(fileName)) {
        throw new Error("candidate material restore differs");
      }
      files.set(fileName, Buffer.concat(chunks, length));
    },
  };
  await input.archive.restoreFullGraph(input.candidateGraphSha256, {
    maximumBytes: 16 * 1_024 * 1_024 + 16 * 1_024,
    sink,
    targets: [{
      fileName: "candidate.json",
      identitySha256: input.candidateSha256,
    }, {
      fileName: "artifact.json",
      identitySha256: input.artifactSha256,
    }, {
      fileName: "parity.json",
      identitySha256: paritySha256,
    }],
  });
  const candidateBytes = files.get("candidate.json");
  const artifactBytes = files.get("artifact.json");
  const parityReceiptBytes = files.get("parity.json");

  // bind the raw fit directly while deferring self-addressed artifact identity to its parser
  if (!Buffer.isBuffer(candidateBytes) || !Buffer.isBuffer(artifactBytes) ||
    !Buffer.isBuffer(parityReceiptBytes) ||
    adjustmentSha256(candidateBytes) !== input.candidateSha256 ||
    adjustmentSha256(parityReceiptBytes) !== paritySha256) {
    throw new Error("candidate material identity differs");
  }
  const parityReceipt = validateCanonicalDocument(
    parityReceiptBytes,
    "forecast-adjustment-model-parity/v1",
  );

  // bind the receipt to this exact family candidate
  if (parityReceipt.family !== input.family ||
    parityReceipt.candidateSha256 !== input.candidateSha256) {
    throw new Error("candidate material parity receipt differs");
  }
  validateArchivedDevelopmentCandidate(candidateBytes, input.family);
  const portable = buildForecastAdjustmentMaintenancePortableCandidate({
    candidateBytes,
    family: input.family,
  });

  // prove the independently rebuilt portable package equals the retained artifact bytes
  if (portable.artifactSha256 !== input.artifactSha256 ||
    !portable.artifactBytes.equals(artifactBytes)) {
    throw new Error("candidate material portable artifact differs");
  }
  return Object.freeze({
    artifactBytes,
    candidateBytes,
    parityReceiptBytes,
    paritySha256,
  });
}

// locate one active raw fit graph from its root-acknowledged local shadow binding
export async function resolveAdjustmentCandidateMaterial(input) {
  requireExactKeys(input, [
    "archive", "artifactSha256", "candidateSha256", "family", "journal", "readHead",
  ], "candidate material resolution input");
  requireFamilyOrNull(input.family);

  // prohibit the nullable daily family before selecting local release custody
  if (input.family === null || typeof input.readHead !== "function") {
    throw new TypeError("candidate material resolution family is invalid");
  }
  const installed = await input.journal.readActiveDevelopmentMaterial({
    family: input.family,
  });

  // require the exact acknowledged shadow binding retained after release application
  if (installed === null || installed.candidateSha256 !== input.candidateSha256 ||
    installed.artifactSha256 !== input.artifactSha256) {
    throw new Error("candidate material installation is unavailable");
  }
  const headSha256 = await input.readHead();
  requireSha256(headSha256, "candidate archive headSha256");
  const retained = await findArchiveMember(
    input.archive,
    headSha256,
    input.candidateSha256,
    developmentCandidateKind(input.family),
  );

  // require the retained candidate graph to equal the root-acknowledged local binding
  if (retained === null || retained.graphSha256 !== installed.candidateGraphSha256) {
    throw new Error("candidate material graph is unavailable");
  }
  const material = await restoreAdjustmentCandidateMaterial({
    archive: input.archive,
    artifactSha256: input.artifactSha256,
    candidateGraphSha256: installed.candidateGraphSha256,
    candidateSha256: input.candidateSha256,
    family: input.family,
  });
  return Object.freeze({
    ...material,
    candidateGraphSha256: installed.candidateGraphSha256,
  });
}

// freeze one value-blind plan and open owner-native access before reading prediction values
export async function prepareAdjustmentMaintenanceConfirmationAccess(input, options = {}) {
  requireExactKeys(input, [
    "archive", "catalogInputManifestSha256", "clock", "due", "epochWitness", "history",
    "journal", "lifecycleEntry", "readHead", "sourceCommit",
  ], "confirmation access preparation input");
  requirePlainObject(options, "confirmation access preparation options");

  // admit only the fixed owner burn transport as an isolated test seam
  if (Object.keys(options).some((key) => !["burnAccess", "unsupported"].includes(key)) ||
    (options.burnAccess !== undefined && typeof options.burnAccess !== "function")) {
    throw new TypeError("confirmation access preparation options are invalid");
  }
  // select only the explicit terminal unsupported planner
  if (options.unsupported !== undefined && typeof options.unsupported !== "boolean") {
    throw new TypeError("confirmation access preparation unsupported mode is invalid");
  }
  validateDue(input.due);
  requireSha256(input.catalogInputManifestSha256, "catalogInputManifestSha256");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requireGitCommit(input.sourceCommit, "sourceCommit");
  requirePlainObject(input.lifecycleEntry, "confirmation lifecycle entry");
  const shadowRegistration = validateRollingShadowRegistration(
    input.lifecycleEntry.activeRegistration,
  );
  let local = await input.journal.readActiveConfirmation({
    family: shadowRegistration.family,
  });

  // resume only the exact candidate retained across an owner-reconciliation retry
  if (local === null && typeof input.journal.readConfirmationByCandidate === "function") {
    local = await input.journal.readConfirmationByCandidate({
      candidateSha256: shadowRegistration.candidateSha256,
      family: shadowRegistration.family,
    });
  }

  // require the local preregistration created before the public shadow release
  if (local === null || local.registration.candidateSha256 !==
      shadowRegistration.candidateSha256 || local.registration.reservedKeySha256 !==
      shadowRegistration.reservedKeySha256) {
    throw new Error("confirmation local registration differs");
  }
  const planInput = {
    confirmationRegistration: local.registration,
    due: input.due,
    epochWitness: witness,
    history: input.history,
    shadowRegistration,
  };
  const plan = options.unsupported === true
    ? planAdjustmentMaintenanceUnsupportedDailyConfirmation(planInput)
    : planAdjustmentMaintenanceDailyConfirmation(planInput);

  // preserve genuine incomplete capture as retryable non-value state
  if (plan.state === "pending") {
    return Object.freeze({ local, plan, shadowRegistration, state: "pending" });
  }
  const publication = await archiveAdjustmentConfirmationPlan({
    archive: input.archive,
    clock: input.clock,
    journal: input.journal,
    planGraph: plan.planGraph,
    readHead: input.readHead,
  });
  await input.archive.verifyFullGraph(publication.manifestObjectSha256);
  const fullGraphVerifiedAt = requireDate(input.clock()).toISOString();
  await input.journal.recordRevisionSnapshot({
    entryCount: plan.entryCount,
    expectedKeySetSha256: plan.expectedKeySetSha256,
    family: shadowRegistration.family,
    now: fullGraphVerifiedAt,
    registrationSha256: local.registration.registrationSha256,
    revisionCatalogWatermarkSha256: plan.revisionCatalogWatermarkSha256,
    snapshotRootSha256: plan.snapshotRootSha256,
    targetCutoffAt: plan.targetCutoffAt,
  });
  const localBurn = await input.journal.burnConfirmation({
    family: shadowRegistration.family,
    now: requireDate(input.clock()).toISOString(),
    registrationSha256: local.registration.registrationSha256,
  });
  const acknowledgement = await input.journal.readLatestRevisionCustodyAcknowledgement();
  const status = await input.journal.status();
  requireSha256(status.headSha256, "confirmation journalHeadSha256");

  // bind access only to a complete custody acknowledgement and finalized database metadata
  if (acknowledgement === null || input.lifecycleEntry.metadata === null) {
    throw new Error("confirmation custody or metadata is unavailable");
  }
  const request = validateAdjustmentConfirmationAccessBurnRequestV3({
    acknowledgement,
    archive: {
      eligiblePredictionSetSha256: plan.eligiblePredictionSetSha256,
      fullGraphVerifiedAt,
      graphManifestSha256: publication.manifestObjectSha256,
    },
    confirmationRegistration: local.registration,
    contractVersion: "adjustment-confirmation-access-burn-request/v3",
    epochWitnessSha256: adjustmentSha256(canonicalJsonBytes(witness)),
    journalHeadSha256: status.headSha256,
    localBurn,
    metadata: input.lifecycleEntry.metadata,
    shadowRegistration,
    sourceCommit: input.sourceCommit,
  });
  const burnAccess = options.burnAccess ?? burnAdjustmentConfirmationAccessV3;
  const ownerAccess = await burnAccess({ request });
  return Object.freeze({
    localBurn,
    nativeAccess: ownerAccess.nativeAccess,
    plan,
    planGraphManifestSha256: publication.manifestObjectSha256,
    shadowRegistration,
    state: options.unsupported === true ? "burned_unsupported" : "burned",
  });
}

// assemble one terminal daily member from authenticated history after the owner burn
export async function prepareAdjustmentMaintenanceDailyTerminalMaterial(input, options = {}) {
  requireExactKeys(input, [
    "archive", "catalogInputManifestSha256", "clockAt", "due", "epochWitness", "history",
    "journal", "lifecycleEntry", "readHead", "sourceCommit",
  ], "daily terminal material input");
  requirePlainObject(options, "daily terminal material options");

  // permit only the owner burn transport as an isolated regression seam
  if (Object.keys(options).some((key) => key !== "burnAccess") ||
    (options.burnAccess !== undefined && typeof options.burnAccess !== "function")) {
    throw new TypeError("daily terminal material options are invalid");
  }
  validateDue(input.due);
  requireInstant(input.clockAt, "daily terminal clockAt");
  requireSha256(input.catalogInputManifestSha256, "catalogInputManifestSha256");
  requireGitCommit(input.sourceCommit, "sourceCommit");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requirePlainObject(input.lifecycleEntry, "daily terminal lifecycle entry");
  const shadowRegistration = validateRollingShadowRegistration(
    input.lifecycleEntry.activeRegistration,
  );
  let local = await input.journal.readActiveConfirmation({
    family: shadowRegistration.family,
  });

  // resume an owner-reconciliation retry after a durable local terminal result
  if (local === null && typeof input.journal.readConfirmationByCandidate === "function") {
    local = await input.journal.readConfirmationByCandidate({
      candidateSha256: shadowRegistration.candidateSha256,
      family: shadowRegistration.family,
    });
  }

  // retain the unopened member until the database-owned terminal clock
  if (Date.parse(input.clockAt) < Date.parse(shadowRegistration.terminalAt)) {
    return Object.freeze({
      dailyEvaluationInput: Object.freeze({
        catalogInputManifestSha256: input.catalogInputManifestSha256,
        clockAt: input.clockAt,
        due: input.due,
        epochWitness: witness,
        lifecycle: Object.freeze({
          family: shadowRegistration.family,
          registrationSha256: local?.registration.registrationSha256 ?? null,
          state: "pending",
        }),
      }),
      state: "pending",
    });
  }
  const accessInput = {
    archive: input.archive,
    catalogInputManifestSha256: input.catalogInputManifestSha256,
    clock: () => new Date(input.clockAt),
    due: input.due,
    epochWitness: witness,
    history: input.history,
    journal: input.journal,
    lifecycleEntry: input.lifecycleEntry,
    readHead: input.readHead,
    sourceCommit: input.sourceCommit,
  };
  let access = await prepareAdjustmentMaintenanceConfirmationAccess(accessInput, {
    ...(options.burnAccess === undefined ? {} : { burnAccess: options.burnAccess }),
  });

  // open the disjoint unsupported snapshot only when capture cycles are permanently absent
  if (access.state === "pending") {
    access = await prepareAdjustmentMaintenanceConfirmationAccess(accessInput, {
      ...(options.burnAccess === undefined ? {} : { burnAccess: options.burnAccess }),
      unsupported: true,
    });
  }
  if (!new Set(["burned", "burned_unsupported"]).has(access.state)) {
    throw new Error("daily terminal access is unavailable");
  }
  const assemblyInput = {
    access: access.localBurn,
    confirmationRegistration: access.local.registration,
    due: input.due,
    epochWitness: witness,
    history: input.history,
    plan: access.plan,
    shadowRegistration,
  };
  const assembleComplete = shadowRegistration.family === "rain"
    ? assembleAdjustmentRainDailyConfirmation
    : assembleAdjustmentMaintenanceDailyConfirmation;
  const assembleUnsupported = shadowRegistration.family === "rain"
    ? assembleAdjustmentRainUnsupportedDailyConfirmation
    : assembleAdjustmentMaintenanceUnsupportedDailyConfirmation;
  let assembly = access.state === "burned"
    ? assembleComplete(assemblyInput)
    : assembleUnsupported(assemblyInput);

  // preserve the same complete-plan burn when source or target members are later unavailable
  if (assembly.state === "pending") {
    assembly = assembleUnsupported(assemblyInput);
  }
  if (!new Set(["burned_complete", "burned_unsupported"]).has(assembly.state)) {
    throw new Error("daily terminal assembly is unavailable");
  }

  // append every value-blind physical part in deterministic preregistered order
  for (const chunk of assembly.chunks) {
    await input.journal.appendConfirmationChunk({
      chunk: chunk.metadata,
      family: shadowRegistration.family,
      now: input.clockAt,
      registrationSha256: access.local.registration.registrationSha256,
    });
  }
  const fullManifest = await input.journal.finalizeConfirmationMember({
    family: shadowRegistration.family,
    now: input.clockAt,
    registrationSha256: access.local.registration.registrationSha256,
  });
  const candidate = await resolveAdjustmentCandidateMaterial({
    archive: input.archive,
    artifactSha256: shadowRegistration.artifactSha256,
    candidateSha256: shadowRegistration.candidateSha256,
    family: shadowRegistration.family,
    journal: input.journal,
    readHead: input.readHead,
  });
  const common = Object.freeze({
    assembly,
    candidate,
    confirmationRegistration: access.local.registration,
    epochWitness: witness,
    fullManifest,
    localBurn: access.localBurn,
    nativeAccess: access.nativeAccess,
    plan: access.plan,
    planGraphManifestSha256: access.planGraphManifestSha256,
    shadowRegistration,
    sourceCommit: input.sourceCommit,
  });

  // keep incomplete evidence disjoint from the qualified evaluation surface
  if (assembly.state === "burned_unsupported") {
    return Object.freeze({ dailyUnsupportedMaterial: common, state: "unsupported" });
  }
  return Object.freeze({
    dailyEvaluationInput: Object.freeze({
      catalogInputManifestSha256: input.catalogInputManifestSha256,
      clockAt: input.clockAt,
      due: input.due,
      epochWitness: witness,
      lifecycle: Object.freeze({
        access: access.localBurn,
        artifactBase64: candidate.artifactBytes.toString("base64"),
        candidateBase64: candidate.candidateBytes.toString("base64"),
        chunks: assembly.chunks,
        confirmationRegistration: access.local.registration,
        fullManifest,
        shadowRegistration,
        state: "burned_complete",
      }),
    }),
    dailyTerminalMaterial: common,
    state: "complete",
  });
}

// archive one successful revision page with all exact proof members
export async function archiveAdjustmentRevisionColdPage(input) {
  requireExactKeys(input, ["archive", "clock", "journal", "page", "readHead", "start"],
    "revision cold page archive");
  const segment = buildAdjustmentRevisionColdGraphSegment({
    page: input.page,
    start: input.start,
  });
  return await publishAdjustmentArchiveGraphSegment({
    archive: input.archive,
    clock: input.clock,
    dueKey: `archive/revision-cold-page/${input.page.pageSha256}`,
    journal: input.journal,
    readHead: input.readHead,
    segment,
  });
}

// archive and remotely acknowledge one permanent unqualified gap page
export async function archiveAdjustmentRevisionGapPage(input, options = {}) {
  requireExactKeys(input, ["archive", "clock", "journal", "page", "readHead"],
    "revision gap page archive");
  requirePlainObject(options, "revision gap archive options");

  // permit only the exact acknowledgement transport injection
  if (Object.keys(options).some((key) => key !== "acknowledge") ||
    (options.acknowledge !== undefined && typeof options.acknowledge !== "function")) {
    throw new TypeError("revision gap archive options are invalid");
  }
  const page = validateAdjustmentRevisionGapPayloadPage(input.page);
  const segment = buildAdjustmentRevisionGapGraphSegment(page);
  const publication = await publishAdjustmentArchiveGraphSegment({
    archive: input.archive,
    clock: input.clock,
    dueKey: `archive/revision-gap-page/${page.pageSha256}`,
    journal: input.journal,
    readHead: input.readHead,
    segment,
  });
  const acknowledge = options.acknowledge ?? acknowledgeAdjustmentRevisionGapPayload;
  const acknowledgement = await acknowledge({
    graphManifestSha256: publication.manifestObjectSha256,
    pageSha256: page.pageSha256,
  });

  // accept only an acknowledgement of this exact archived page and member set
  if (acknowledgement.pageSha256 !== page.pageSha256 ||
    acknowledgement.graphManifestSha256 !== publication.manifestObjectSha256 ||
    acknowledgement.memberRootSha256 !== page.memberRootSha256 ||
    acknowledgement.predecessorFrontierSha256 !== page.predecessorFrontierSha256) {
    throw new Error("revision_gap_acknowledgement_differs");
  }
  return { acknowledgement, ...publication };
}

// drain the bounded server gap spool before semantic inspection
export async function drainAdjustmentRevisionGapSpool(input, options = {}) {
  requireExactKeys(input, ["archive", "clock", "journal", "readHead"],
    "revision gap drain input");
  requirePlainObject(options, "revision gap drain options");
  const allowed = new Set(["acknowledge", "fetchPage", "fetchStart"]);

  // permit only explicit transport injection for isolated tests
  if (Object.keys(options).some((key) => !allowed.has(key)) ||
    ["acknowledge", "fetchPage", "fetchStart"].some((key) =>
      options[key] !== undefined && typeof options[key] !== "function")) {
    throw new TypeError("revision gap drain options are invalid");
  }
  const fetchStart = options.fetchStart ?? fetchAdjustmentRevisionGapTransferStart;
  const fetchPage = options.fetchPage ?? fetchAdjustmentRevisionGapPayloadPage;
  const acknowledge = options.acknowledge ?? acknowledgeAdjustmentRevisionGapPayload;
  const start = await fetchStart();
  const page = await fetchPage({
    frontierSha256: start.frontierSha256,
    startSha256: start.startSha256,
  });

  // an idle page is a verified no-op and never produces an acknowledgement
  if (page.idle) {
    return { pageSha256: page.pageSha256, state: "idle" };
  }
  return await archiveAdjustmentRevisionGapPage({ ...input, page }, { acknowledge });
}

// restore and verify the complete captured prefix for one authenticated snapshot
export async function assembleAdjustmentRevisionColdCatalog(input) {
  requireExactKeys(input, ["archive", "journal", "selection", "start"],
    "revision semantic catalog input");
  const start = validateAdjustmentRevisionColdTransferStart(input.start);

  // require the complete durable prefix before exposing any semantic payload
  const cursor = await input.journal.readRevisionCursor();
  requireArchiveOrdinal(cursor?.archiveCommitOrdinal, "archiveCommitOrdinal");
  requireSha256(cursor?.frontierSha256, "frontierSha256");
  if (cursor.archiveCommitOrdinal !== start.watermarkArchiveCommitOrdinal ||
    cursor.frontierSha256 !== start.watermarkFrontierSha256) {
    return { reason: "semantic_input_blocked", state: "blocked" };
  }
  const mappings = await input.journal.listRevisionCatalogPages();

  // an empty future-only frontier is genuine but not yet semantically usable
  if (!Array.isArray(mappings) || mappings.length === 0) {
    return { reason: "semantic_input_blocked", state: "blocked" };
  }
  const history = await restoreAdjustmentRevisionHistoricalArchive({
    archive: input.archive,
    mappings,
    selection: input.selection,
    start,
  });
  const receiptMembers = new Map();

  // index every ordinal receipt back to its value-bearing packed occurrence
  for (const occurrence of history.occurrences) {
    for (const receipt of occurrence.receipts) {
      receiptMembers.set(receipt.receiptSha256, occurrence);
    }
  }
  const members = [];

  // select only the exact current-pointer payloads from the complete history
  for (const snapshotEntry of start.servingSnapshot.entries) {
    const retained = receiptMembers.get(snapshotEntry.receipt.receiptSha256);

    // terminal unpublished gaps can remain in custody but never enter semantics
    if (retained === undefined || retained.publicationDisposition !== "published") {
      throw new Error("revision semantic payload is unqualified");
    }
    members.push(Object.freeze({
      logicalReceivedAt: snapshotEntry.logicalReceivedAt,
      payloadBytes: retained.payloadBytes,
      payloadKind: retained.payloadKind,
      receipt: snapshotEntry.receipt,
      relation: snapshotEntry.relation,
    }));
  }
  return Object.freeze({
    catalog: history.catalog,
    history,
    inputManifestSha256: history.historyRootSha256,
    members: Object.freeze(members),
    servingSnapshot: start.servingSnapshot,
    state: "ready",
  });
}

// parse one exact canonical archived evidence document
function validateCanonicalDocument(bytes, contractVersion, validator = (value) => value) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2) {
    throw new TypeError("revision semantic document is invalid");
  }
  let value;

  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("revision semantic document JSON is invalid");
  }
  if (value?.contractVersion !== contractVersion || !canonicalJsonBytes(value).equals(bytes)) {
    throw new TypeError("revision semantic document is not canonical");
  }
  return validator(value);
}

// validate one exact v3 rolling registration and its domain identity
function validateRollingShadowRegistration(value) {
  requireExactKeys(value, [
    "artifactSha256", "candidateSha256", "cohortSha256", "epochWitnessSha256",
    "family", "intervalEndAt", "intervalStartAt", "policySha256",
    "predecessorRegistrationSha256", "registrationSha256", "reservedKeySha256",
    "scheduleContractSha256", "siteKey", "sourceSha256", "targetCutoffAt",
    "terminalAt",
  ], "rolling shadow registration");
  requireFamilyOrNull(value.family);

  // require only an actual family registration at this graph boundary
  if (value.family === null || value.siteKey !== "ballydidean" ||
    value.scheduleContractSha256 !== ADJUSTMENT_ROLLING_SCHEDULE_SHA256) {
    throw new TypeError("rolling shadow registration is invalid");
  }
  // validate every nonnullable registration identity
  for (const field of [
    "artifactSha256", "candidateSha256", "cohortSha256", "epochWitnessSha256",
    "policySha256", "registrationSha256", "reservedKeySha256",
    "scheduleContractSha256", "sourceSha256",
  ]) {
    requireSha256(value[field], `rolling shadow registration ${field}`);
  }
  requireNullableSha256(value.predecessorRegistrationSha256,
    "rolling shadow registration predecessorRegistrationSha256");
  // validate every registration boundary clock
  for (const field of ["intervalEndAt", "intervalStartAt", "targetCutoffAt", "terminalAt"]) {
    requireInstant(value[field], `rolling shadow registration ${field}`);
  }
  const material = `${[
    "adjustment-shadow-registration/v3", value.siteKey, value.family,
    value.candidateSha256, value.artifactSha256, value.policySha256,
    value.cohortSha256, value.reservedKeySha256, value.sourceSha256,
    value.epochWitnessSha256, value.scheduleContractSha256,
    value.predecessorRegistrationSha256 ?? "none", value.intervalStartAt,
    value.intervalEndAt, value.targetCutoffAt, value.terminalAt,
  ].join("\n")}\n`;

  // preserve the frozen final-LF v3 identity grammar
  if (value.registrationSha256 !== adjustmentSha256(Buffer.from(material, "utf8"))) {
    throw new TypeError("rolling shadow registration identity differs");
  }
  return value;
}

// find one exact member along the verified predecessor chain
async function findArchiveMember(archive, head, identitySha256, kind) {
  let current = head;
  const visited = new Set();

  // walk only the bounded verified graph chain
  while (current !== null) {
    requireSha256(current, "archive head");

    // reject cycles rather than loop over corrupted history
    if (visited.has(current) || visited.size >= 16_744) {
      throw new TypeError("archive predecessor chain is invalid");
    }
    visited.add(current);
    const verified = await archive.verifyFullGraph(current, { verifyPredecessors: false });
    const sameIdentity = verified.manifest.entries.find(
      // locate one globally unique archive member identity
      (entry) => entry.identitySha256 === identitySha256,
    );

    // reject cross-kind identity aliasing
    if (sameIdentity !== undefined) {
      if (sameIdentity.kind !== kind) {
        throw new TypeError("archive member identity kind differs");
      }
      return { entry: sameIdentity, graphSha256: current };
    }
    current = verified.manifest.predecessorGraphSha256;
  }
  return null;
}

// project one published member into a graph entry
function graphEntryForMember(published, member) {
  return {
    identitySha256: member.identitySha256,
    kind: member.kind,
    memberLength: member.memberLength,
    memberOffset: member.memberOffset,
    memberSha256: member.memberSha256,
    objectSha256: published.objectSha256,
  };
}

// publish one closed report through the durable archive chain
async function publishArchiveAttemptReport(ports, report) {
  const bytes = canonicalJsonBytes(report);
  const reportSha256 = adjustmentSha256(bytes);
  const publication = await publishAdjustmentArchiveMember({
    archive: ports.archive,
    clock: ports.clock,
    identitySha256: reportSha256,
    journal: ports.journal,
    kind: ADJUSTMENT_MAINTENANCE_ATTEMPT_CONTRACT_VERSION,
    payload: bytes,
    readHead: ports.readArchiveHead,
  });
  return { manifestObjectSha256: publication.manifestObjectSha256, reportSha256 };
}

// create closed production ports with action paths disabled by missing semantics
export function createProductionAdjustmentMaintenanceControllerPorts() {
  const attemptValidator = (bytes) => {
    const parsed = JSON.parse(bytes.toString("utf8"));
    validateAdjustmentMaintenanceAttempt(parsed);

    // require exact canonical archived bytes
    if (!canonicalJsonBytes(parsed).equals(bytes)) {
      throw new TypeError("maintenance attempt is not canonical");
    }
  };
  attemptValidator.maximumBytes = ATTEMPT_MAXIMUM_BYTES;
  const candidateValidators = new Map();

  // register each closed development candidate member kind
  for (const family of FAMILIES) {
    const validator = (bytes) => validateArchivedDevelopmentCandidate(bytes, family);
    validator.maximumBytes = 8 * 1_024 * 1_024;
    candidateValidators.set(developmentCandidateKind(family), validator);
  }
  const evidenceValidators = new Map();

  // retain every transported evidence kind as canonical immutable bytes
  for (const kind of [
    "adjustment-archive-graph-reference/v1",
    "adjustment-confirmation-local-burn-member/v1",
    "adjustment-confirmation-member/v3",
    "adjustment-confirmation-native-access-member/v1",
    "adjustment-development-custody-graph/v1",
    "adjustment-maintenance-confirmation-terminal-graph-manifest/v1",
    "adjustment-maintenance-confirmation-terminal-graph-part/v1",
    ADJUSTMENT_MAINTENANCE_CANDIDATE_REPORT_VERSION,
    "adjustment-maintenance-unsupported-policy-report/v1",
    "adjustment-terminal-no-action-identity/v3",
    "adjustment-shadow-terminal-tombstone/v3",
    "forecast-adjustment-future-only-source-lineage/v1",
    "forecast-adjustment-lifecycle-ledger/v2",
    "forecast-adjustment-maintenance-runtime-package/v1",
    "forecast-adjustment-model-action/v1",
    "forecast-adjustment-model-parity/v1",
    "rain-maintenance-control-state/v1",
    "rain-hurdle-wind-runtime/v1",
    "rain-hurdle-wind-runtime/v2",
    RAIN_MAINTENANCE_POLICY_VERSION,
    TEMPERATURE_MAINTENANCE_POLICY_VERSION,
    WIND_MAINTENANCE_POLICY_VERSION,
    "adjustment-rain-gate-feature-projection/v2",
    "adjustment-revision-batch-projection/v2",
    "adjustment-revision-batch-publish-receipt/v2",
    "adjustment-revision-capture-epoch-witness/v1",
    "adjustment-revision-cold-page-checkpoint/v1",
    "adjustment-revision-cold-transfer-start/v1",
    "adjustment-revision-commit-receipt/v1",
    "adjustment-revision-gap-page-checkpoint/v1",
    "adjustment-revision-gap/v1",
    "adjustment-revision-projection/v1",
    "adjustment-revision-publish-receipt/v1",
    "adjustment-revision-stage-receipt/v1",
    "adjustment-revision-successor/v1",
    "adjustment-revision-serving-snapshot/v1",
    "adjustment-shadow-gap/v1",
    "adjustment-shadow-incumbent-comparator/v1",
    "adjustment-shadow-publish-receipt/v1",
    "adjustment-shadow-publish-receipt/v2",
    "adjustment-shadow-revision-capsule/v1",
    "adjustment-shadow-revision-capsule/v2",
    "adjustment-shadow-revision-stage/v1",
    "adjustment-shadow-revision-stage/v2",
    "adjustment-shadow-stage-receipt/v1",
  ]) {
    const validator = (bytes) => validateCanonicalEvidenceMember(bytes, kind);
    validator.maximumBytes = REVISION_CATALOG_OUTPUT_MAXIMUM_BYTES;
    evidenceValidators.set(kind, validator);
  }
  // validate each derived target through its frozen regional recipe grammar
  const derivedTargetValidator = (bytes) =>
    parseAdjustmentMaintenanceDerivedTarget(bytes);
  derivedTargetValidator.maximumBytes = 256 * 1_024;
  evidenceValidators.set(
    ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION,
    derivedTargetValidator,
  );

  // retain value-bearing evaluation chunks for later contextual replay
  for (const kind of [
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION,
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V2_VERSION,
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION,
  ]) {
    const validator = (bytes) => validateCanonicalEvidenceMember(bytes, kind, 8 * 1_024 * 1_024);
    validator.maximumBytes = 8 * 1_024 * 1_024;
    evidenceValidators.set(kind, validator);
  }
  const registrationValidator = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    validateRollingShadowRegistration(value);

    // retain only one canonical public registration document
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new TypeError("rolling shadow registration is not canonical");
    }
  };
  registrationValidator.maximumBytes = 16 * 1_024;
  evidenceValidators.set("adjustment-shadow-registration/v3", registrationValidator);
  const policyDescriptorValidator = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    validateAdjustmentRegistrationPolicyDescriptor(value);

    // retain only the exact canonical policy identity
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new TypeError("registration policy descriptor is not canonical");
    }
  };
  policyDescriptorValidator.maximumBytes = 16 * 1_024;
  evidenceValidators.set("adjustment-registration-policy/v3", policyDescriptorValidator);
  const cohortDescriptorValidator = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    validateAdjustmentRegistrationCohortDescriptor(value);

    // retain only the exact canonical cohort identity
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new TypeError("registration cohort descriptor is not canonical");
    }
  };
  cohortDescriptorValidator.maximumBytes = 16 * 1_024;
  evidenceValidators.set("adjustment-registration-cohort/v3", cohortDescriptorValidator);
  const expectedPlanValidator = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    validateAdjustmentRegistrationExpectedKeyPlan(value);

    // retain only the exact canonical all-cycle plan
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new TypeError("registration expected key plan is not canonical");
    }
  };
  expectedPlanValidator.maximumBytes = 256 * 1_024;
  evidenceValidators.set("adjustment-registration-expected-key-plan/v3",
    expectedPlanValidator);
  const confirmationPlanGraphValidator = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    validateAdjustmentMaintenanceConfirmationPlanGraph(value);

    // retain only the exact canonical value-blind confirmation plan
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new TypeError("confirmation plan graph is not canonical");
    }
  };
  confirmationPlanGraphValidator.maximumBytes = 8 * 1_024 * 1_024;
  evidenceValidators.set(
    "adjustment-maintenance-confirmation-plan-graph/v1",
    confirmationPlanGraphValidator,
  );
  const unsupportedPlanGraphValidator = (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    validateAdjustmentMaintenanceUnsupportedPlanGraph(value);

    // retain only the exact canonical missing-cycle confirmation plan
    if (!canonicalJsonBytes(value).equals(bytes)) {
      throw new TypeError("unsupported confirmation plan graph is not canonical");
    }
  };
  unsupportedPlanGraphValidator.maximumBytes = 8 * 1_024 * 1_024;
  evidenceValidators.set(
    "adjustment-maintenance-confirmation-plan-graph/v2",
    unsupportedPlanGraphValidator,
  );
  const archive = createPlaintextArchive({
    backingCapacity: async () => await measureAdjustmentArchiveBackingCapacity(),
    memberValidators: new Map([[
      ADJUSTMENT_MAINTENANCE_ATTEMPT_CONTRACT_VERSION,
      attemptValidator,
    ], [
      ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
      createAdjustmentCycleCapsuleValidator(),
    ], ...candidateValidators, ...evidenceValidators]),
  });
  const journal = createMaintenanceJournal();
  const custodyPack = createAdjustmentRevisionCustodyPack({
    backingCapacity: async () => await measureAdjustmentArchiveBackingCapacity(),
  });
  let latestRevisionCycle = null;
  let epochWitness = null;
  let registrationSchedule = null;
  let registrationLifecycle = null;
  const ports = {
    // execute only publisher-produced fixed family release identities
    applyFamilyRelease: async (request) => await applyAdjustmentFamilyRelease(request),
    archive,
    archiveRevisionColdPage: async ({ page, start }) => {
      let appended;
      try {
        appended = await custodyPack.append({ page, start });
      } catch (error) {
        // seal the verified prior pack before retrying one capacity-bounded page
        if (error?.code !== "adjustment_custody_pack_full") {
          throw error;
        }
        await ports.sealRevisionCustodyPack({ force: true });
        appended = await custodyPack.append({ page, start });
      }
      const retained = appended.pages.at(-1);
      return {
        custodyCheckpointSha256: appended.checkpointSha256,
        memberRootSha256: retained.record.memberRootSha256,
        startMemberSha256: retained.record.startMemberSha256,
      };
    },
    archiveRevisionGapPage: async ({ page }) => await archiveAdjustmentRevisionGapPage({
      archive,
      clock: ports.clock,
      journal,
      page,
      readHead: ports.readArchiveHead,
    }),
    buildCandidateRegistration: async ({ due, fit, inspection, parity, requestedAt }) => {
      requirePlainObject(inspection.registrationContext, "registrationContext");
      return buildAdjustmentPostFitRegistrationMaterial({
        artifactSha256: parity.portable.artifactSha256,
        candidateSha256: fit.candidateSha256,
        cutoffAt: inspection.registrationContext.cutoffAt,
        dueMonth: due.dueKey.slice(due.dueKey.lastIndexOf("/") + 1),
        epochWitness,
        family: due.family,
        historicalMemberRootSha256:
          inspection.registrationContext.historicalMemberRootSha256,
        inputManifestSha256: inspection.registrationContext.inputManifestSha256,
        predecessorRegistrationSha256:
          inspection.registrationContext.predecessorRegistrationSha256,
        predecessorTerminalAt: inspection.registrationContext.predecessorTerminalAt,
        requestedAt,
        sourceIdentitySha256: parity.portable.sourceIdentitySha256,
      });
    },
    buildCandidateParity: (input) => buildAdjustmentMaintenanceCandidateParity(input),
    clock: () => new Date(),
    inspectSemanticInput: async ({ due, revisionCycle }) => {
      const cycle = revisionCycle ?? latestRevisionCycle;

      // refuse due work until this process owns one authenticated snapshot
      if (cycle === null || cycle.start === undefined ||
        cycle.state === "archived_cursor_ahead") {
        return { reason: "semantic_input_blocked", state: "blocked" };
      }
      // refresh owner lifecycle after each terminal retirement before selecting the next family
      if (due.mode === "daily") {
        registrationLifecycle = await fetchAdjustmentRegistrationLifecycleStatus();
        if (registrationLifecycle.epochWitnessSha256 !== epochWitness.witnessSha256) {
          throw new Error("registration lifecycle epoch differs");
        }
      }
      const activeEntry = due.mode === "daily"
        ? selectAdjustmentDailyLifecycleEntry(
            registrationLifecycle?.entries ?? [],
            registrationLifecycle.snapshotAt,
          )
        : null;
      const catalog = await assembleAdjustmentRevisionColdCatalog({
        archive,
        journal,
        selection: {
          family: due.mode === "monthly" ? due.family : activeEntry?.slot.family ?? null,
          fromAt: due.mode === "monthly"
            ? epochWitness.epochAt
            : activeEntry?.activeRegistration.intervalStartAt ?? null,
          receiptSha256s: cycle.start.servingSnapshot.entries.map(
            // retain every current pointer beside the family history selection
            (entry) => entry.receipt.receiptSha256,
          ),
          toAt: due.mode === "monthly"
            ? due.originalCutoffAt
            : activeEntry?.activeRegistration.targetCutoffAt ?? null,
        },
        start: cycle.start,
      });

      // retain a genuine incomplete frontier without fitting or qualification
      if (catalog.state === "blocked") {
        return catalog;
      }
      const registrationSlot = due.family === null
        ? null
        : registrationSchedule?.slots.find((slot) => slot.family === due.family) ?? null;
      return await buildProductionSemanticInspection({
        archive,
        catalog,
        clockAt: registrationSchedule.snapshotAt,
        due,
        epochWitness,
        journal,
        readHead: ports.readArchiveHead,
        registrationSlot,
        registrationLifecycle,
        registrationSchedule,
      });
    },
    initializeLifecycle: async () => {
      const witness = await fetchAdjustmentRevisionCaptureEpochWitness();
      const servingSnapshot = await fetchAdjustmentRevisionCaptureEpochSnapshot();
      const databaseLedger = await fetchAdjustmentMaintenanceDatabaseLedger();
      epochWitness = witness;

      // require the full rolling database ledger retained by the epoch witness
      if (databaseLedger.databaseManifest.migration_history_sha256 !==
        witness.databaseMigrationHistorySha256) {
        throw new Error("registration schedule database ledger differs");
      }
      const bootstrap = buildAdjustmentRollingScheduleBootstrap({
        epochAt: witness.epochAt,
        epochWitnessSha256: witness.witnessSha256,
      });
      await initializeAdjustmentRegistrationSchedule({ bootstrap });
      registrationLifecycle = await fetchAdjustmentRegistrationLifecycleStatus();
      registrationSchedule = registrationScheduleFromLifecycle(registrationLifecycle);

      // bind the post-initialization status to the retained epoch
      if (registrationSchedule.epochAt !== witness.epochAt ||
        registrationSchedule.epochWitnessSha256 !== witness.witnessSha256) {
        throw new Error("registration schedule epoch differs");
      }
      await journal.initializeFutureOnlyLifecycle({
        now: requireDate(ports.clock()).toISOString(),
        witness,
      });
      await archiveAdjustmentFutureOnlyGenesis({
        archive,
        clock: ports.clock,
        journal,
        readHead: ports.readArchiveHead,
        servingSnapshot,
        witness,
      });
      return {
        schedule: registrationSchedule,
        servingSnapshotSha256: servingSnapshot.snapshotSha256,
        witnessSha256: witness.witnessSha256,
      };
    },
    journal,
    reconcileTerminalOutcome: async ({ dueKey }) =>
      await reconcileAdjustmentDueTerminalRetirement({ dueKey, journal }),
    persistCandidate: async ({ due, fit, parity, registrationMaterial }) => {
      const bytes = Buffer.from(fit.candidateJson, "utf8");
      validateArchivedDevelopmentCandidate(bytes, due.family);
      if (parity === null || epochWitness === null || registrationMaterial === null) {
        throw new Error("candidate parity, epoch witness or registration unavailable");
      }
      const expectedLineage = buildAdjustmentFutureOnlySourceLineage({
        epochWitness,
        family: due.family,
        sourceIdentitySha256: parity.portable.sourceIdentitySha256,
      });
      const lineage = registrationMaterial.source;
      const policy = registrationMaterial.policy;
      const cohort = registrationMaterial.cohort;
      const expectedPlan = registrationMaterial.expectedPlan;
      const registration = validateRollingShadowRegistration(
        registrationMaterial.shadowRegistration,
      );
      validateAdjustmentRegistrationPolicyDescriptor(policy.descriptor);
      validateAdjustmentRegistrationCohortDescriptor(cohort.descriptor);
      validateAdjustmentRegistrationExpectedKeyPlan(expectedPlan.descriptor);

      // crossbind all descriptor identities to the post-fit artifact and source
      if (lineage.sourceSha256 !== expectedLineage.sourceSha256 ||
        !lineage.bytes.equals(expectedLineage.bytes) ||
        registration.candidateSha256 !== fit.candidateSha256 ||
        registration.artifactSha256 !== parity.portable.artifactSha256 ||
        registration.policySha256 !== policy.policySha256 ||
        registration.cohortSha256 !== cohort.cohortSha256 ||
        registration.reservedKeySha256 !== expectedPlan.reservedKeySha256 ||
        registration.sourceSha256 !== lineage.sourceSha256) {
        throw new Error("candidate registration material differs");
      }
      const parityReceipt = buildAdjustmentMaintenanceParityReceipt({
        candidateSha256: fit.candidateSha256,
        family: due.family,
        parity: parity.parity,
      });
      const artifact = validateCanonicalDocument(
        parity.portable.artifactBytes,
        JSON.parse(parity.portable.artifactBytes.toString("utf8")).contractVersion,
      );
      const controlMembers = adjustmentPortableControlMembers(parity.portable);
      const segment = {
        crossLinks: [{
          fromIdentitySha256: fit.candidateSha256,
          relation: "binds_portable_artifact",
          toIdentitySha256: parity.portable.artifactSha256,
        }, {
          fromIdentitySha256: fit.candidateSha256,
          relation: "binds_runtime_parity",
          toIdentitySha256: parityReceipt.paritySha256,
        }, {
          fromIdentitySha256: parity.portable.artifactSha256,
          relation: "binds_future_only_source",
          toIdentitySha256: lineage.sourceSha256,
        }, {
          fromIdentitySha256: fit.candidateSha256,
          relation: "binds_shadow_registration",
          toIdentitySha256: registration.registrationSha256,
        }, {
          fromIdentitySha256: registration.registrationSha256,
          relation: "binds_registration_policy",
          toIdentitySha256: policy.policySha256,
        }, {
          fromIdentitySha256: registration.registrationSha256,
          relation: "binds_registration_cohort",
          toIdentitySha256: cohort.cohortSha256,
        }, {
          fromIdentitySha256: registration.registrationSha256,
          relation: "binds_reserved_key_plan",
          toIdentitySha256: expectedPlan.expectedPlanSha256,
        }, {
          fromIdentitySha256: registration.registrationSha256,
          relation: "binds_future_only_source",
          toIdentitySha256: lineage.sourceSha256,
        }, {
          fromIdentitySha256: lineage.sourceSha256,
          relation: "binds_capture_epoch",
          toIdentitySha256: epochWitness.witnessSha256,
        }, ...controlMembers.crossLinks],
        members: [{
          identitySha256: fit.candidateSha256,
          kind: developmentCandidateKind(due.family),
          payload: bytes,
        }, {
          identitySha256: parity.portable.artifactSha256,
          kind: artifact.contractVersion,
          payload: parity.portable.artifactBytes,
        }, {
          identitySha256: parityReceipt.paritySha256,
          kind: parityReceipt.fixture.contractVersion,
          payload: parityReceipt.bytes,
        }, {
          identitySha256: lineage.sourceSha256,
          kind: lineage.descriptor.contractVersion,
          payload: lineage.bytes,
        }, {
          identitySha256: policy.policySha256,
          kind: policy.descriptor.contractVersion,
          payload: policy.bytes,
        }, {
          identitySha256: cohort.cohortSha256,
          kind: cohort.descriptor.contractVersion,
          payload: cohort.bytes,
        }, {
          identitySha256: expectedPlan.expectedPlanSha256,
          kind: expectedPlan.descriptor.contractVersion,
          payload: expectedPlan.bytes,
        }, {
          identitySha256: registration.registrationSha256,
          kind: "adjustment-shadow-registration/v3",
          payload: canonicalJsonBytes(registration),
        }, {
          identitySha256: epochWitness.witnessSha256,
          kind: epochWitness.contractVersion,
          payload: canonicalJsonBytes(epochWitness),
        }, ...controlMembers.members],
      };
      const publication = await publishAdjustmentArchiveGraphSegment({
        archive,
        clock: ports.clock,
        dueKey: `archive/development-candidate/${due.family}/${fit.candidateSha256}`,
        journal,
        readHead: ports.readArchiveHead,
        segment,
      });
      return {
        artifactSha256: parity.portable.artifactSha256,
        candidateGraphSha256: publication.manifestObjectSha256,
        paritySha256: parityReceipt.paritySha256,
        registrationSha256: registration.registrationSha256,
        sourceSha256: lineage.sourceSha256,
      };
    },
    publishAttemptReport: async (report) => await publishArchiveAttemptReport(ports, report),
    publishDevelopmentCandidate: async (request) =>
      await publishProductionDevelopmentCandidate({
        ...request,
        applyFamilyRelease: ports.applyFamilyRelease,
        archive,
        clock: ports.clock,
        epochWitness,
        installDevelopmentAnchor: async (anchor) =>
          await installAdjustmentDevelopmentCustodyAnchor({ anchor }),
        journal,
        readArchiveHead: ports.readArchiveHead,
        readDevelopmentAnchor: async () =>
          await fetchAdjustmentDevelopmentCustodyAnchorCurrent(),
      }),
    publishRainControlReference: async (request) =>
      await publishProductionRainControlReference({
        ...request,
        applyFamilyRelease: ports.applyFamilyRelease,
        archive,
        clock: ports.clock,
        epochWitness,
        installControlAnchor: async (anchor) =>
          await installAdjustmentRainControlCustodyAnchor({ anchor }),
        journal,
        readArchiveHead: ports.readArchiveHead,
        readBaselineSelector: async (sourceCommit) =>
          readRainControlReferenceBaseline("/home/ubuntu/weather", sourceCommit),
        readControlAnchor: async () =>
          await fetchAdjustmentRainControlCustodyAnchorCurrent(),
      }),
    // publish only an already validated canonical scorecard
    publishScorecard: async (scorecard) =>
      await publishAdjustmentMaintenanceScorecardV2(scorecard),
    readArchiveHead: async () => await readProductionArchiveHead(),
    readRegistrationSchedule: async () => registrationSchedule ??
      await fetchAdjustmentRegistrationScheduleStatus(),
    runFit: async (request) => await runAdjustmentFitWithInput(request),
    sealRevisionCustodyPack: async ({ force }) => {
      const status = await custodyPack.inspect();

      // retain a partial pack until four pages or an explicit due flush
      if (status.pages.length === 0 || (!force && status.pages.length < 4)) {
        return { state: status.pages.length === 0 ? "empty" : "pending" };
      }
      const sealed = await custodyPack.buildSealedSegment();
      const publication = await publishAdjustmentArchiveGraphSegment({
        archive,
        clock: ports.clock,
        dueKey: `archive/revision-custody-pack/${sealed.checkpointSha256}`,
        journal,
        readHead: ports.readArchiveHead,
        segment: sealed.segment,
      });
      await journal.recordRevisionCustodyPackSeal({
        checkpointSha256: sealed.checkpointSha256,
        graphManifestSha256: publication.manifestObjectSha256,
        now: requireDate(ports.clock()).toISOString(),
        pages: sealed.pageCheckpoints,
      });
      await custodyPack.removeSealed(sealed.checkpointSha256);
      return {
        graphManifestSha256: publication.manifestObjectSha256,
        pageCount: sealed.pageCheckpoints.length,
        state: "sealed",
      };
    },
    synchronizeEvidence: async (cutoffAt) => {
      // clear any prior durable metadata proof before requesting another hot page
      await reconcileAdjustmentShadowMetadataCustody();
      const gap = await drainAdjustmentRevisionGapSpool({
        archive,
        clock: ports.clock,
        journal,
        readHead: ports.readArchiveHead,
      });

      // charge one nonempty gap page as this cycle's complete two-body budget
      if (gap.state !== "idle") {
        latestRevisionCycle = { gap, state: "gap_captured" };
        return latestRevisionCycle;
      }
      latestRevisionCycle = await drainAdjustmentRevisionColdPage({
        acknowledge: async (request) =>
          await acknowledgeAdjustmentRevisionColdCustody(request),
        archivePage: ports.archiveRevisionColdPage,
        clock: ports.clock,
        cutoffAt,
        fetchPage: async (request) => await fetchAdjustmentRevisionColdPage(request),
        fetchStart: async (currentCutoffAt) =>
          await fetchAdjustmentRevisionColdCurrentTransferStart(currentCutoffAt),
        journal,
        sealPack: async ({ force }) => await ports.sealRevisionCustodyPack({ force }),
      });
      // compact only rows covered by this page's completed custody proof
      await reconcileAdjustmentShadowMetadataCustody();
      return latestRevisionCycle;
    },
    // force a partial verified pack into immutable storage before due semantics
    flushEvidence: async () => await ports.sealRevisionCustodyPack({ force: true }),
    withProcessLock: async (operation) => await withControllerProcessLock(operation),
  };
  return ports;
}

// select the complete optional rain control-state member pair
function adjustmentPortableControlMembers(portable) {
  const values = [
    portable.controlStateBytes,
    portable.controlStateSha256,
    portable.ordinalArtifactBytes,
    portable.ordinalArtifactSha256,
  ];
  const absent = values.every((value) => value === null || value === undefined);

  // preserve temperature, wind, and legacy rain packages without control aliases
  if (absent) {
    return { crossLinks: [], members: [] };
  }

  // prohibit a partial state or hash-only ordinal member
  if (!Buffer.isBuffer(portable.controlStateBytes) ||
    !Buffer.isBuffer(portable.ordinalArtifactBytes)) {
    throw new TypeError("portable control members are incomplete");
  }
  requireSha256(portable.controlStateSha256, "controlStateSha256");
  requireSha256(portable.ordinalArtifactSha256, "ordinalArtifactSha256");
  const controlState = validateCanonicalDocument(
    portable.controlStateBytes,
    "rain-maintenance-control-state/v1",
  );
  const ordinalArtifact = validateCanonicalDocument(
    portable.ordinalArtifactBytes,
    "rain-hurdle-wind-runtime/v1",
  );

  // bind the package-reported identities before archival
  if (adjustmentSha256(portable.controlStateBytes) !== portable.controlStateSha256 ||
    adjustmentSha256(portable.ordinalArtifactBytes) !== portable.ordinalArtifactSha256 ||
    controlState.ordinalArtifactSha256 !== portable.ordinalArtifactSha256 ||
    controlState.modelMonth !== ordinalArtifact.modelMonth) {
    throw new Error("portable control member identity differs");
  }
  return {
    crossLinks: [{
      fromIdentitySha256: portable.artifactSha256,
      relation: "binds_rain_control_state",
      toIdentitySha256: portable.controlStateSha256,
    }, {
      fromIdentitySha256: portable.controlStateSha256,
      relation: "binds_ordinal_artifact",
      toIdentitySha256: portable.ordinalArtifactSha256,
    }],
    members: [{
      identitySha256: portable.controlStateSha256,
      kind: controlState.contractVersion,
      payload: portable.controlStateBytes,
    }, {
      identitySha256: portable.ordinalArtifactSha256,
      kind: ordinalArtifact.contractVersion,
      payload: portable.ordinalArtifactBytes,
    }],
  };
}

// publish and apply one inactive candidate plus precomputed shadow compensation
async function publishProductionDevelopmentCandidate(input) {
  requireExactKeys(input, [
    "applyFamilyRelease", "archive", "candidateGraphSha256", "clock", "due",
    "epochWitness", "inputHeadSha256", "installDevelopmentAnchor", "journal",
    "lifecycleHeadSha256", "material", "readArchiveHead", "readDevelopmentAnchor",
    "report", "reportCreatedAt", "reportSha256",
  ], "development candidate publication");
  requireSha256(input.candidateGraphSha256, "candidateGraphSha256");
  requireSha256(input.inputHeadSha256, "inputHeadSha256");
  requireSha256(input.lifecycleHeadSha256, "lifecycleHeadSha256");
  requireSha256(input.reportSha256, "reportSha256");
  requireInstant(input.reportCreatedAt, "reportCreatedAt");
  validateDue(input.due);
  const epochWitness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  validateAdjustmentMaintenanceAttempt(input.report);

  // require every mutating or archive port before releasing public tags
  if (typeof input.applyFamilyRelease !== "function" ||
    typeof input.archive?.verifyFullGraph !== "function" ||
    typeof input.installDevelopmentAnchor !== "function" ||
    typeof input.readArchiveHead !== "function" ||
    typeof input.readDevelopmentAnchor !== "function") {
    throw new TypeError("development candidate publication ports are invalid");
  }

  // require the exact archived package and authenticated registration inputs
  if (input.due.family === null || input.material?.parity === null ||
    input.material?.parity === undefined ||
    input.material.registrationMaterial?.shadowRegistration === undefined) {
    throw new Error("development candidate registration is unavailable");
  }
  const family = input.due.family;
  const candidateSha256 = input.material.fit.candidateSha256;
  const releaseRunId = `release-${candidateSha256.slice(0, 32)}`;
  const acquiredAt = requireDate(input.clock()).toISOString();
  const lease = await input.journal.acquireLease({
    dueKey: input.due.dueKey,
    inputHeadSha256: input.inputHeadSha256,
    now: acquiredAt,
    runId: releaseRunId,
    scope: "release",
  });
  let acquired = true;

  try {
    const current = await fetchAdjustmentFamilyReleaseCurrent(family);
    const createdAt = requireDate(input.clock()).toISOString();
    const validThrough = new Date(Date.parse(input.reportCreatedAt) +
      7 * 86_400_000).toISOString();
    const targetAction = {
      actionKind: "shadow",
      candidateGraphSha256: input.candidateGraphSha256,
      candidateSha256,
      contractVersion: "forecast-adjustment-model-action/v1",
      createdAt,
      expectedInstalledReceiptSha256: current.shadowInstalledReceiptSha256,
      expectedSettingsSha256: current.settingsSha256,
      expectedSourceCommit: current.commit,
      expectedSourceRelease: current.release,
      family,
      fencingToken: lease.fencingToken,
      fullMemberRootSha256: null,
      lifecycleHeadSha256: input.lifecycleHeadSha256,
      policyDecision: "pending",
      policyReportSha256: input.reportSha256,
      predecessorActionSha256: null,
      reason: "development_candidate",
      reportCreatedAt: input.reportCreatedAt,
      siteKey: "ballydidean",
      validThrough,
    };
    const targetIdentity = buildAdjustmentModelAction(targetAction);
    const familyFiles = buildAdjustmentDevelopmentFamilyFiles({
      candidateBytes: Buffer.from(input.material.fit.candidateJson, "utf8"),
      family,
      portable: input.material.parity.portable,
    });
    const releasePorts = createProductionAdjustmentModelReleasePorts(input.journal);
    const common = {
      parity: input.material.parity.parity,
      releaseDate: localDateAt(new Date(createdAt)).replaceAll("-", "."),
      releaseDueKey: input.due.dueKey,
      releaseRunId,
      repositoryPath: "/home/ubuntu/weather",
    };
    const pair = await publishAdjustmentModelReleasePair({
      buildCompensation: async (target) => {
        const compensationCreatedAt = requireDate(input.clock()).toISOString();
        return {
          ...common,
          action: {
            ...targetAction,
            actionKind: "compensate_shadow",
            createdAt: compensationCreatedAt,
            expectedSourceCommit: target.commitSha,
            expectedSourceRelease: target.releaseTag,
            predecessorActionSha256: target.actionSha256,
            reason: "development_shadow_failure",
          },
          familyFiles: [],
          shadowRegistration: null,
          sourceCommit: target.commitSha,
        };
      },
      target: {
        ...common,
        action: targetAction,
        familyFiles,
        shadowRegistration: input.material.registrationMaterial.shadowRegistration,
        sourceCommit: current.commit,
      },
    }, releasePorts);

    // require publisher identity to remain the action bytes validated before git work
    if (pair.target.actionSha256 !== targetIdentity.actionSha256) {
      throw new Error("development candidate action identity differs");
    }
    const verifiedCandidateGraph = await input.archive.verifyFullGraph(
      input.candidateGraphSha256,
      { verifyPredecessors: false },
    );
    const registration = input.material.registrationMaterial.shadowRegistration;

    // prove every public registration dependency is an actual prior graph member
    for (const identitySha256 of [
      candidateSha256,
      registration.artifactSha256,
      registration.registrationSha256,
      registration.policySha256,
      registration.cohortSha256,
      input.material.registrationMaterial.expectedPlan.expectedPlanSha256,
      registration.sourceSha256,
    ]) {
      if (!verifiedCandidateGraph.manifest.entries.some(
        // require one actual immutable member with this public identity
        (entry) => entry.identitySha256 === identitySha256,
      )) {
        throw new Error("development candidate graph member is unavailable");
      }
    }
    const custodyGraph = buildAdjustmentDevelopmentCustodyGraphSegment({
      action: targetAction,
      artifactBytes: input.material.parity.portable.artifactBytes,
      candidateBytes: Buffer.from(input.material.fit.candidateJson, "utf8"),
      candidateGraphSha256: input.candidateGraphSha256,
      registration,
      reportBytes: canonicalJsonBytes(input.report),
    });
    const developmentPublication = await publishAdjustmentArchiveGraphSegment({
      archive: input.archive,
      clock: input.clock,
      dueKey: `archive/development-custody/${custodyGraph.bindingSha256}`,
      journal: input.journal,
      readHead: input.readArchiveHead,
      segment: custodyGraph.segment,
    });
    const acknowledgement = await input.journal
      .readLatestRevisionCustodyAcknowledgement();

    // refuse shadow application without one fully retained packed-custody ACK-v2
    if (acknowledgement === null) {
      throw new Error("development custody acknowledgement is unavailable");
    }
    const previous = await input.readDevelopmentAnchor();
    const sequence = previous === null
      ? "0"
      : (BigInt(previous.anchor.sequence) + 1n).toString();
    const anchor = buildAdjustmentDevelopmentCustodyAnchor({
      acknowledgement,
      actionSha256: targetIdentity.actionSha256,
      artifactSha256: registration.artifactSha256,
      candidateGraphSha256: input.candidateGraphSha256,
      candidateSha256,
      captureEpochWitnessSha256: adjustmentSha256(canonicalJsonBytes(epochWitness)),
      controlSha256: epochWitness.controlPlaneSha256,
      controlVersion: epochWitness.controlPlaneVersion,
      developmentGraphSha256: developmentPublication.manifestObjectSha256,
      dueKey: input.due.dueKey,
      family,
      fullGraphVerifiedAt: requireDate(input.clock()).toISOString(),
      inputHeadSha256: input.inputHeadSha256,
      lifecycleLedgerRootSha256: input.lifecycleHeadSha256,
      policyReportSha256: input.reportSha256,
      predecessorAnchorSha256: previous?.anchorSha256 ?? null,
      registrationSha256: registration.registrationSha256,
      sequence,
      sourceCommit: current.commit,
      sourceSha256: input.material.candidate.sourceSha256,
    });
    await input.installDevelopmentAnchor(anchor);
    const applied = await input.applyFamilyRelease({
      actionSha256: pair.target.actionSha256,
      compensatingRelease: pair.compensation.releaseTag,
      expectedCurrentRelease: current.release,
      expectedSettingsSha256: current.settingsSha256,
      expectedSourceRelease: current.release,
      family,
      fencingToken: lease.fencingToken,
      reportSha256: input.reportSha256,
      targetRelease: pair.target.releaseTag,
    });
    return Object.freeze({ actionSha256: pair.target.actionSha256, state: applied.state });
  } finally {
    // release only the exact still-live publisher fence
    if (acquired) {
      await input.journal.releaseLease({
        dueKey: input.due.dueKey,
        now: requireDate(input.clock()).toISOString(),
        runId: releaseRunId,
        scope: "release",
      });
      acquired = false;
    }
  }
}

// publish and apply one pre-month reference plus its prepared selector compensation
export async function publishProductionRainControlReference(input) {
  requireExactKeys(input, [
    "applyFamilyRelease", "archive", "clock", "due", "epochWitness",
    "inputHeadSha256", "installControlAnchor", "journal", "lifecycleHeadSha256",
    "material", "readArchiveHead", "readBaselineSelector", "readControlAnchor",
    "report", "reportCreatedAt", "reportSha256",
  ], "rain control reference publication");
  validateDue(input.due);
  validateAdjustmentMaintenanceAttempt(input.report);
  requireSha256(input.inputHeadSha256, "inputHeadSha256");
  requireSha256(input.lifecycleHeadSha256, "lifecycleHeadSha256");
  requireSha256(input.reportSha256, "reportSha256");
  requireInstant(input.reportCreatedAt, "reportCreatedAt");
  const epochWitness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);

  // require every archive, release and root custody boundary before publication
  if (input.due.scope !== "control-reference/rain" ||
    typeof input.applyFamilyRelease !== "function" ||
    typeof input.archive?.verifyFullGraph !== "function" ||
    typeof input.installControlAnchor !== "function" ||
    typeof input.readArchiveHead !== "function" ||
    typeof input.readBaselineSelector !== "function" ||
    typeof input.readControlAnchor !== "function") {
    throw new TypeError("rain control reference publication ports are invalid");
  }
  const material = validateRainControlReferenceMaterial(
    input.material,
    input.due,
    input.reportCreatedAt,
  );
  const state = parseRainMaintenanceControlState(material.controlStateBytes);
  const controlStateSha256 = adjustmentSha256(material.controlStateBytes);
  const ordinalArtifactSha256 = adjustmentSha256(material.ordinalArtifactBytes);
  const releaseRunId = `release-control-${controlStateSha256.slice(0, 32)}`;
  const lease = await input.journal.acquireLease({
    dueKey: input.due.dueKey,
    inputHeadSha256: input.inputHeadSha256,
    now: requireDate(input.clock()).toISOString(),
    runId: releaseRunId,
    scope: "release",
  });
  let acquired = true;

  try {
    const current = await fetchAdjustmentFamilyReleaseCurrent("rain");
    const verified = await input.archive.verifyFullGraph(material.graphManifestSha256, {
      verifyPredecessors: false,
    });

    // require actual state and artifact members before any public release is created
    for (const identitySha256 of [controlStateSha256, ordinalArtifactSha256]) {
      if (!verified.manifest.entries.some(
        // require one immutable graph member with the exact byte identity
        (entry) => entry.identitySha256 === identitySha256,
      )) {
        throw new Error("rain control source graph member is unavailable");
      }
    }
    const targetAction = {
      actionKind: "control_reference",
      contractVersion: "forecast-adjustment-rain-control-reference-action/v1",
      controlStateSha256,
      createdAt: state.generatedAt,
      dueMonth: state.modelMonth,
      expectedCatalogReceiptSha256: current.controlInstalledReceiptSha256,
      expectedSettingsSha256: current.settingsSha256,
      expectedSourceCommit: current.commit,
      expectedSourceRelease: current.release,
      family: "rain",
      fencingToken: lease.fencingToken,
      graphManifestSha256: material.graphManifestSha256,
      ordinalArtifactSha256,
      predecessorActionSha256: null,
      reason: "premonth_reference",
      sourceMemberRootSha256: material.sourceMemberRootSha256,
      sourceReceiptRootSha256: material.sourceReceiptRootSha256,
      validThrough: `${state.modelMonth}-01T00:00:00.000Z`,
    };
    const targetIdentity = buildAdjustmentRainControlReferenceAction(targetAction);
    const baselineSelectorBytes = await input.readBaselineSelector(current.commit);
    const releasePorts = createProductionAdjustmentModelReleasePorts(input.journal);
    const common = {
      releaseDate: localDateAt(requireDate(input.clock())).replaceAll("-", "."),
      releaseDueKey: input.due.dueKey,
      releaseRunId,
      repositoryPath: "/home/ubuntu/weather",
    };
    const pair = await publishAdjustmentRainControlReferenceReleasePair({
      buildCompensation: async (target) => ({
        ...common,
        action: {
          ...targetAction,
          actionKind: "compensate_control_reference",
          createdAt: requireDate(input.clock()).toISOString(),
          expectedSourceCommit: target.commitSha,
          expectedSourceRelease: target.releaseTag,
          predecessorActionSha256: target.actionSha256,
          reason: "failed_control_reference",
        },
        baselineSelectorBytes,
        controlStateBytes: null,
        ordinalArtifactBytes: null,
        sourceCommit: target.commitSha,
      }),
      target: {
        ...common,
        action: targetAction,
        baselineSelectorBytes: null,
        controlStateBytes: material.controlStateBytes,
        ordinalArtifactBytes: material.ordinalArtifactBytes,
        sourceCommit: current.commit,
      },
    }, releasePorts);

    // retain the action bytes selected before Git work
    if (pair.target.actionSha256 !== targetIdentity.actionSha256) {
      throw new Error("rain control reference action identity differs");
    }
    const acknowledgement = await input.journal.readLatestRevisionCustodyAcknowledgement();
    if (acknowledgement === null) {
      throw new Error("rain control custody acknowledgement is unavailable");
    }
    const previous = await input.readControlAnchor();
    const sequence = previous === null
      ? "0"
      : (BigInt(previous.anchor.sequence) + 1n).toString();
    const anchor = buildAdjustmentRainControlCustodyAnchor({
      acknowledgement,
      actionSha256: pair.target.actionSha256,
      captureEpochWitnessSha256: adjustmentSha256(canonicalJsonBytes(epochWitness)),
      controlSha256: epochWitness.controlPlaneSha256,
      controlStateSha256,
      controlVersion: epochWitness.controlPlaneVersion,
      dueMonth: state.modelMonth,
      fencingToken: lease.fencingToken,
      fullGraphVerifiedAt: requireDate(input.clock()).toISOString(),
      graphManifestSha256: material.graphManifestSha256,
      ordinalArtifactSha256,
      predecessorAnchorSha256: previous?.anchorSha256 ?? null,
      sequence,
      sourceCommit: current.commit,
      sourceMemberRootSha256: material.sourceMemberRootSha256,
      sourceReceiptRootSha256: material.sourceReceiptRootSha256,
      workstationJournalHeadSha256: input.lifecycleHeadSha256,
    });
    await input.installControlAnchor(anchor);
    const applied = await input.applyFamilyRelease({
      actionSha256: pair.target.actionSha256,
      compensatingRelease: pair.compensation.releaseTag,
      expectedCurrentRelease: current.release,
      expectedSettingsSha256: current.settingsSha256,
      expectedSourceRelease: current.release,
      family: "rain",
      fencingToken: lease.fencingToken,
      reportSha256: material.graphManifestSha256,
      targetRelease: pair.target.releaseTag,
    });
    return Object.freeze({ actionSha256: pair.target.actionSha256, state: applied.state });
  } finally {
    // release only the exact live reference publisher fence
    if (acquired) {
      await input.journal.releaseLease({
        dueKey: input.due.dueKey,
        now: requireDate(input.clock()).toISOString(),
        runId: releaseRunId,
        scope: "release",
      });
      acquired = false;
    }
  }
}

// read the exact prior public selector from the authenticated source commit
function readRainControlReferenceBaseline(repositoryPath, sourceCommit) {
  const path = "config/forecast-adjustments/ballydidean-rain-control-reference.json";
  const tree = execFileSync("/usr/bin/git", [
    "ls-tree", "-z", "--name-only", sourceCommit, "--", path,
  ], { cwd: repositoryPath, encoding: null, maxBuffer: 32 * 1_024 });

  // distinguish exact absence from an alternate or ambiguous tree result
  if (tree.length === 0) {
    return null;
  }
  if (!tree.equals(Buffer.from(`${path}\0`))) {
    throw new Error("rain control source selector differs");
  }
  const bytes = execFileSync("/usr/bin/git", ["show", `${sourceCommit}:${path}`], {
    cwd: repositoryPath,
    encoding: null,
    maxBuffer: 16 * 1_024 + 1,
  });
  if (bytes.length < 2 || bytes.length > 16 * 1_024) {
    throw new Error("rain control source selector exceeds its bound");
  }
  return Buffer.from(bytes);
}

// read one exact public model member from an authenticated source commit
function readAdjustmentSourceFile(repositoryPath, sourceCommit, path, maximumBytes = 8 * 1_024 * 1_024) {
  if (typeof path !== "string" || !path.startsWith("config/forecast-adjustments/") &&
    path !== "packages/forecast-adjustment/src/rain-hurdle-wind-artifact.ts") {
    throw new TypeError("adjustment source file path is invalid");
  }
  const tree = execFileSync("/usr/bin/git", [
    "ls-tree", "-z", "--name-only", sourceCommit, "--", path,
  ], { cwd: repositoryPath, encoding: null, maxBuffer: 32 * 1_024 });

  // require one exact ordinary path in the authenticated commit tree
  if (!tree.equals(Buffer.from(`${path}\0`))) {
    throw new Error("adjustment source file is unavailable");
  }
  const bytes = execFileSync("/usr/bin/git", ["show", `${sourceCommit}:${path}`], {
    cwd: repositoryPath,
    encoding: null,
    maxBuffer: maximumBytes + 1,
  });

  // preserve the model package byte ceilings while reading the source baseline
  if (bytes.length < 2 || bytes.length > maximumBytes) {
    throw new Error("adjustment source file exceeds its bound");
  }
  return Buffer.from(bytes);
}

// build the exact active family file matrix for one qualified target
function buildAdjustmentServingFamilyFiles(input) {
  const candidateBytes = requireBuffer(input.candidateBytes, "serving candidateBytes");
  const portable = buildForecastAdjustmentMaintenancePortableCandidate({
    candidateBytes,
    family: input.family,
  });
  const registry = buildAdjustmentMaintenanceServingRegistry({
    action: input.action,
    artifactSha256: portable.artifactSha256,
  });

  // rain carries its technical receipt and compiled execution source
  if (input.family === "rain") {
    const packaged = buildPortableRainModelPackage(candidateBytes);
    if (packaged.artifactSha256 !== portable.artifactSha256 ||
      packaged.candidateSha256 !== portable.candidateSha256) {
      throw new Error("rain serving package identity differs");
    }
    return packaged.familyFiles.map(
      // replace only the legacy technical registry with action-bound authority
      (file) => file.path === registry.path ? registry : file,
    );
  }
  const directory = input.family === "temperature"
    ? "temperature-canary-bundles"
    : "wind-canary-bundles";
  return [{
    bytes: portable.artifactBytes,
    path: `config/forecast-adjustments/ballydidean/${directory}/` +
      `sha256-${portable.artifactSha256}.json`,
  }, registry];
}

// restore one prior qualified public package or explicit raw baseline
function readAdjustmentCompensationBaseline(input) {
  requireFamilyOrNull(input.family);
  const repositoryPath = "/home/ubuntu/weather";
  const registryPath = input.family === "rain"
    ? "config/forecast-adjustments/ballydidean-rain-runtime.json"
    : `config/forecast-adjustments/ballydidean-${input.family}-canary.json`;

  // legacy or raw incumbents have no v2 qualified provenance and compensate to raw
  if (input.current.activeInstalledReceiptSha256 === null) {
    return Object.freeze({ kind: "raw" });
  }
  const registryBytes = readAdjustmentSourceFile(
    repositoryPath,
    input.current.commit,
    registryPath,
  );
  const registry = validateCanonicalDocument(
    registryBytes,
    `forecast-adjustment-${input.family}-maintenance-registry/v1`,
  );
  requireExactKeys(registry, ["activePackage", "contractVersion", "rawReason", "siteKey"],
    "compensation source registry");
  requirePlainObject(registry.activePackage, "compensation active package");
  requireExactKeys(registry.activePackage, [
    "actionSha256", "artifactSha256", "candidateSha256", "path",
  ], "compensation active package");
  for (const name of ["actionSha256", "artifactSha256", "candidateSha256"]) {
    requireSha256(registry.activePackage[name], `compensation ${name}`);
  }
  const priorActionBytes = readAdjustmentSourceFile(
    repositoryPath,
    input.current.commit,
    `config/forecast-adjustments/ballydidean/actions/` +
      `sha256-${registry.activePackage.actionSha256}.json`,
  );
  const priorAction = buildAdjustmentModelAction(JSON.parse(priorActionBytes.toString("utf8")));

  // bind the public serving selector to the exact prior qualified action
  if (!priorAction.bytes.equals(priorActionBytes) ||
    priorAction.actionSha256 !== registry.activePackage.actionSha256 ||
    priorAction.action.candidateSha256 !== registry.activePackage.candidateSha256 ||
    priorAction.action.family !== input.family ||
    !["promote", "rollback_prior", "compensate_incumbent"].includes(
      priorAction.action.actionKind,
    )) {
    throw new Error("compensation source action differs");
  }
  const parityReceiptBytes = readAdjustmentSourceFile(
    repositoryPath,
    input.current.commit,
    `config/forecast-adjustments/ballydidean/model-parity/${input.family}/` +
      `sha256-${registry.activePackage.candidateSha256}.json`,
    64 * 1_024,
  );
  const fixedFiles = [];

  // rain restores its complete technical receipt and compiled execution matrix
  if (input.family === "rain") {
    const receiptPath = `config/forecast-adjustments/ballydidean/rain-model-packages/` +
      `sha256-${registry.activePackage.candidateSha256}.json`;
    const receiptBytes = readAdjustmentSourceFile(
      repositoryPath,
      input.current.commit,
      receiptPath,
    );
    const receipt = JSON.parse(receiptBytes.toString("utf8"));
    fixedFiles.push({ bytes: receiptBytes, path: receiptPath });
    for (const path of [
      `config/forecast-adjustments/ballydidean/${receipt.artifactPath}`,
      receipt.compiledSourcePath,
      ...(receipt.controlStatePath === undefined ? [] : [
        `config/forecast-adjustments/ballydidean/${receipt.controlStatePath}`,
      ]),
      ...(receipt.ordinalArtifactPath === undefined ? [] : [
        `config/forecast-adjustments/ballydidean/${receipt.ordinalArtifactPath}`,
      ]),
    ]) {
      fixedFiles.push({
        bytes: readAdjustmentSourceFile(repositoryPath, input.current.commit, path),
        path,
      });
    }
  } else {
    const bundlePath = `config/forecast-adjustments/ballydidean/` +
      registry.activePackage.path;
    fixedFiles.push({
      bytes: readAdjustmentSourceFile(repositoryPath, input.current.commit, bundlePath),
      path: bundlePath,
    });
  }
  const uniqueFiles = [];
  const seenFiles = new Map();

  // collapse content-addressed rain aliases only when their exact bytes agree
  for (const file of fixedFiles) {
    const existing = seenFiles.get(file.path);

    // reject one path naming divergent retained source bytes
    if (existing !== undefined && !existing.equals(file.bytes)) {
      throw new Error("compensation source file differs");
    }
    if (existing === undefined) {
      seenFiles.set(file.path, file.bytes);
      uniqueFiles.push(file);
    }
  }
  return Object.freeze({
    artifactSha256: registry.activePackage.artifactSha256,
    candidateGraphSha256: priorAction.action.candidateGraphSha256,
    candidateSha256: registry.activePackage.candidateSha256,
    familyFiles: Object.freeze(uniqueFiles),
    kind: "incumbent",
    parityReceiptBytes,
  });
}

// publish and apply one qualified candidate with a precomputed safe compensation
async function publishProductionQualifiedCandidate(input) {
  requireExactKeys(input, [
    "action", "current", "dailyMaterial", "due", "fencingToken", "finalization",
    "journal", "releaseDueKey", "releaseRunId",
  ], "qualified candidate publication");
  const targetIdentity = buildAdjustmentModelAction(input.action);
  const family = targetIdentity.action.family;
  const targetFiles = buildAdjustmentServingFamilyFiles({
    action: targetIdentity.action,
    candidateBytes: input.dailyMaterial.candidate.candidateBytes,
    family,
  });
  const baseline = readAdjustmentCompensationBaseline({
    current: input.current,
    family,
  });
  const releasePorts = createProductionAdjustmentModelReleasePorts(input.journal);
  const common = {
    releaseDate: localDateAt(releasePorts.clock()).replaceAll("-", "."),
    releaseDueKey: input.releaseDueKey,
    releaseRunId: input.releaseRunId,
    repositoryPath: "/home/ubuntu/weather",
  };
  let compensationKind = null;
  let compensationAction = null;
  const pair = await publishAdjustmentModelReleasePair({
    buildCompensation: async (target) => {
      compensationKind = baseline.kind === "raw"
        ? "compensate_raw"
        : "compensate_incumbent";
      compensationAction = {
        ...targetIdentity.action,
        actionKind: compensationKind,
        candidateGraphSha256: baseline.kind === "raw"
          ? null
          : baseline.candidateGraphSha256,
        candidateSha256: baseline.kind === "raw" ? null : baseline.candidateSha256,
        createdAt: targetIdentity.action.createdAt,
        expectedSourceCommit: target.commitSha,
        expectedSourceRelease: target.releaseTag,
        predecessorActionSha256: target.actionSha256,
        reason: baseline.kind === "raw" ? "invalid_incumbent" : "failed_promotion",
      };
      const compensationRegistry = baseline.kind === "raw"
        ? buildAdjustmentMaintenanceRawRegistry(compensationAction)
        : buildAdjustmentMaintenanceServingRegistry({
            action: compensationAction,
            artifactSha256: baseline.artifactSha256,
          });
      return {
        ...common,
        action: compensationAction,
        familyFiles: baseline.kind === "raw"
          ? [compensationRegistry]
          : [...baseline.familyFiles, compensationRegistry],
        parity: baseline.kind === "raw" ? null : baseline.parityReceiptBytes,
        shadowRegistration: null,
        sourceCommit: target.commitSha,
      };
    },
    target: {
      ...common,
      action: targetIdentity.action,
      familyFiles: targetFiles,
      parity: input.dailyMaterial.candidate.parityReceiptBytes,
      shadowRegistration: null,
      sourceCommit: input.current.commit,
    },
  }, releasePorts);

  // preserve the pre-finalized action identity through both public releases
  if (pair.target.actionSha256 !== targetIdentity.actionSha256 || compensationKind === null ||
    compensationAction === null || pair.compensation.actionSha256 !==
      adjustmentSha256(canonicalJsonBytes(compensationAction))) {
    throw new Error("qualified candidate release identity differs");
  }
  const releaseRequest = {
    actionSha256: pair.target.actionSha256,
    compensatingRelease: pair.compensation.releaseTag,
    expectedCurrentRelease: input.current.release,
    expectedSettingsSha256: input.current.settingsSha256,
    expectedSourceRelease: input.current.release,
    family,
    fencingToken: input.fencingToken,
    reportSha256: targetIdentity.action.policyReportSha256,
    targetRelease: pair.target.releaseTag,
  };
  if (typeof input.journal.recordQualifiedModelReleaseTransaction !== "function") {
    throw new Error("qualified release recovery journal is unavailable");
  }
  await input.journal.recordQualifiedModelReleaseTransaction({
    compensation: {
      actionSha256: pair.compensation.actionSha256,
      commitSha: pair.compensation.commitSha,
      releaseTag: pair.compensation.releaseTag,
    },
    compensationAction,
    family,
    finalizationProof: input.finalization.proof,
    now: releasePorts.clock().toISOString(),
    registrationSha256:
      input.dailyMaterial.confirmationRegistration.registrationSha256,
    releaseRequest,
    target: {
      actionSha256: pair.target.actionSha256,
      commitSha: pair.target.commitSha,
      releaseTag: pair.target.releaseTag,
    },
    targetAction: targetIdentity.action,
  });
  const status = await applyAdjustmentFamilyRelease(releaseRequest);
  return Object.freeze({
    compensationActionSha256: pair.compensation.actionSha256,
    compensationKind,
    pair,
    status,
  });
}

// select the closed inactive family file matrix for one portable candidate
function buildAdjustmentDevelopmentFamilyFiles(input) {
  const candidateBytes = requireBuffer(input.candidateBytes, "candidateBytes");
  requireFamilyOrNull(input.family);

  // rain retains its separate candidate-to-artifact technical receipt
  if (input.family === "rain") {
    const packaged = buildPortableRainModelPackage(candidateBytes);
    if (packaged.artifactSha256 !== input.portable.artifactSha256 ||
      packaged.candidateSha256 !== input.portable.candidateSha256) {
      throw new Error("rain portable package identity differs");
    }
    return packaged.shadowFamilyFiles;
  }
  if (input.family !== "temperature" && input.family !== "wind") {
    throw new TypeError("development family is invalid");
  }
  const directory = input.family === "temperature"
    ? "temperature-canary-bundles"
    : "wind-canary-bundles";
  return [{
    bytes: input.portable.artifactBytes,
    path: `config/forecast-adjustments/ballydidean/${directory}/` +
      `sha256-${input.portable.artifactSha256}.json`,
  }];
}

// validate captured members before withholding an unsupported family assembly
async function buildProductionSemanticInspection(input) {
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);

  // independently require every selected database receipt and logical clock post-epoch
  for (const member of input.catalog.members) {
    validateAdjustmentFutureOnlyRevisionReceipt({
      epochWitness: witness,
      receipt: member.receipt,
    });
    validateAdjustmentFutureOnlyCausalInstants({
      epochWitness: witness,
      instants: [member.logicalReceivedAt],
    });
    validateCanonicalDocument(member.payloadBytes, member.payloadKind);
  }
  const inputManifestSha256 = input.catalog.inputManifestSha256;

  // project daily work only for the oldest occupied future-only family slot
  if (input.due.mode === "daily") {
    const occupied = selectAdjustmentDailyLifecycleEntry(
      input.registrationLifecycle.entries,
      input.clockAt,
    );

    // record a real no-candidate snapshot without fabricating lifecycle values
    if (occupied === null) {
      return {
        inputManifestSha256,
        reason: "no_registered_candidate",
        state: "idle",
      };
    }
    const current = await fetchAdjustmentFamilyReleaseCurrent(occupied.slot.family);
    const material = await prepareAdjustmentMaintenanceDailyTerminalMaterial({
      archive: input.archive,
      catalogInputManifestSha256: inputManifestSha256,
      clockAt: input.clockAt,
      due: input.due,
      epochWitness: witness,
      history: input.catalog.history,
      journal: input.journal,
      lifecycleEntry: occupied,
      readHead: input.readHead,
      sourceCommit: current.commit,
    });

    // expose only the disjoint complete or unsupported terminal material
    if (material.state === "unsupported") {
      return {
        dailyUnsupportedMaterial: material.dailyUnsupportedMaterial,
        inputManifestSha256,
        state: "ready",
      };
    }
    return {
      dailyEvaluationInput: material.dailyEvaluationInput,
      ...(material.dailyTerminalMaterial === undefined
        ? {} : { dailyTerminalMaterial: material.dailyTerminalMaterial }),
      inputManifestSha256,
      state: "ready",
    };
  }
  const fitMonth = input.due.dueKey.slice(input.due.dueKey.lastIndexOf("/") + 1);
  const historicalProjection = buildAdjustmentHistoricalFitProjection({
    epochWitness: witness,
    family: input.due.family,
    fitMonth,
    history: input.catalog.history,
  });
  const requiredMonthlyKinds = input.due.family === "temperature"
    ? ["actual_best_match", "native_source", "target_revision"]
    : input.due.family === "wind"
      ? ["actual_best_match", "target_revision"]
      : [];
  const availableMonthlyKinds = new Set(historicalProjection.projectionMembers.map(
    // retain only the authenticated archive class names
    (member) => member.projectionKind,
  ));

  // complete an empty original cutoff rather than starving every later month
  if (requiredMonthlyKinds.some((kind) => !availableMonthlyKinds.has(kind))) {
    return {
      inputManifestSha256: historicalProjection.memberRootSha256,
      reason: "incomplete_development_population",
      state: "no_candidate",
    };
  }
  const assembly = input.due.family === "rain"
    ? buildAdjustmentRainMonthlyFitAssembly({
        dueMonth: fitMonth,
        epochWitness: witness,
        historicalProjection,
      })
    : buildAdjustmentMonthlyFitAssembly({
        dueMonth: fitMonth,
        epochWitness: witness,
        family: input.due.family,
        historicalProjection,
        incumbent: input.due.family === "temperature"
          ? loadForecastAdjustmentMaintenanceIncumbent({ family: "temperature" })
          : null,
      });

  // complete one immutable original cutoff that cannot produce a candidate
  if (assembly.state === "no_candidate") {
    return {
      inputManifestSha256: assembly.historicalMemberRootSha256,
      reason: assembly.reason,
      state: "no_candidate",
    };
  }
  const parityInputs = buildForecastAdjustmentMaintenanceFitParityInputs({
    family: input.due.family,
    fitInput: assembly.fitInput,
  });

  // prohibit a retained member from crossing a family fitter boundary
  if (parityInputs.family !== input.due.family) {
    throw new Error("monthly parity family differs");
  }
  const runtimeReadiness = await captureAdjustmentFitRuntimeReadiness();
  const lifecycleEntry = input.registrationLifecycle.entries.find(
    // retain the database-owned predecessor even while its family slot is free
    (entry) => entry.slot.family === input.due.family,
  );

  // every fixed family must have one authenticated rolling lifecycle row
  if (lifecycleEntry === undefined || input.registrationSlot === null) {
    throw new Error("monthly registration lifecycle is unavailable");
  }
  return {
    fitInput: assembly.fitInput,
    inputManifestSha256: assembly.inputManifestSha256,
    registrationContext: {
      cutoffAt: assembly.cutoffAt,
      historicalMemberRootSha256: assembly.historicalMemberRootSha256,
      inputManifestSha256: assembly.inputManifestSha256,
      predecessorRegistrationSha256:
        lifecycleEntry.predecessor?.registrationSha256 ?? null,
      predecessorTerminalAt: lifecycleEntry.predecessor?.terminalAt ?? null,
    },
    registrationSlot: input.registrationSlot,
    retainedParityInput: parityInputs.retainedInput,
    runtimeReadiness,
    runtimeReadinessSha256: hashAdjustmentFitRuntimeReadiness(runtimeReadiness),
    state: "ready",
    syntheticParityInput: parityInputs.syntheticInput,
  };
}

// validate one already schema-checked transport member on every archive read
function validateCanonicalEvidenceMember(
  bytes,
  kind,
  maximumBytes = REVISION_CATALOG_OUTPUT_MAXIMUM_BYTES,
) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 ||
    bytes.length > maximumBytes) {
    throw new TypeError("revision evidence member bytes are invalid");
  }
  let value;

  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("revision evidence member JSON is invalid");
  }

  // preserve the builder-validated contract and exact canonical framing
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    value.contractVersion !== kind || !canonicalJsonBytes(value).equals(bytes)) {
    throw new TypeError("revision evidence member is not canonical");
  }
  return value;
}

// decode one bounded canonical document and bind its exact content identity
function parseCanonicalBase64Document(base64, expectedSha256, name,
  contractVersion = ADJUSTMENT_MAINTENANCE_CANDIDATE_REPORT_VERSION) {
  requireSha256(expectedSha256, `${name}Sha256`);

  // reject alternate base64 spellings and oversized lifecycle values
  if (typeof base64 !== "string" || base64.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) {
    throw new TypeError(`${name} base64 is invalid`);
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > ATTEMPT_MAXIMUM_BYTES ||
    bytes.toString("base64") !== base64 || adjustmentSha256(bytes) !== expectedSha256) {
    throw new TypeError(`${name} bytes are invalid`);
  }
  return validateCanonicalDocument(bytes, contractVersion);
}

// derive one family-specific public development member kind
function developmentCandidateKind(family) {
  requireFamilyOrNull(family);

  // prohibit the nullable daily projection at this monthly-only boundary
  if (family === null) {
    throw new TypeError("development candidate family is invalid");
  }
  return `forecast-adjustment-${family}-development-candidate/v1`;
}

// validate one canonical sanitized fit candidate before archival
function validateArchivedDevelopmentCandidate(bytes, family) {
  // enforce the family artifact ceiling and canonical utf8 json
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 8 * 1_024 * 1_024 ||
    !Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes)) {
    throw new TypeError("development candidate bytes are invalid");
  }
  let value;

  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("development candidate JSON is invalid");
  }

  // preserve the disjoint rain v3 candidate without widening other families
  const contractVersion = family === "rain" && value?.contractVersion ===
    "rain-maintenance-fit/v3"
    ? "rain-maintenance-fit/v3"
    : `${family}-maintenance-fit/v2`;

  // bind family, canonical encoding, and public-only material
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    value.contractVersion !== contractVersion ||
    !canonicalJsonBytes(value).equals(bytes) ||
    /(?:\/home\/|\/root\/|\/mnt\/c\/Users\/|SSH_AUTH_SOCK|ANSEL_HOST_PASSWORD|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u
      .test(bytes.toString("utf8"))) {
    throw new TypeError("development candidate is invalid");
  }
  return value;
}

// read one fixed owner-private archive graph head
async function readProductionArchiveHead() {
  const path = join(ADJUSTMENT_DEFAULT_ARCHIVE_ROOT, "head.current");
  let handle;

  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    // treat only an absent genesis pointer as empty
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const details = await handle.stat();

    // require one exact owner-private single-link pointer
    if (!details.isFile() || details.uid !== process.getuid() || details.nlink !== 1 ||
      (details.mode & 0o777) !== 0o600 || details.size !== 65) {
      throw new TypeError("archive head metadata is invalid");
    }
    const value = await handle.readFile("ascii");

    // accept only one lowercase hash and newline
    if (!/^[a-f0-9]{64}\n$/u.test(value)) {
      throw new TypeError("archive head value is invalid");
    }
    return value.slice(0, 64);
  } finally {
    await handle.close();
  }
}

// reconcile only expired ordinary daily or monthly leases
async function reconcileExpiredControllerLease(journal, scope, now) {
  const status = await journal.status();
  const active = status.activeLeases.find(
    // match one exact controller scope
    (lease) => lease.scope === scope,
  );

  // retain absent and still-live leases
  if (active === undefined || Date.parse(active.expiresAt) > now.getTime()) {
    return;
  }
  const due = (await journal.inspectDueKeys({ dueKeys: [active.dueKey] }))[0];
  await journal.reconcileExpiredLease({
    dueKey: active.dueKey,
    immutableOutputSha256: due.outputSha256,
    now: now.toISOString(),
    remoteStateSha256: null,
    resolution: due.status === "complete" ? "complete" : "resume",
    runId: active.runId,
    scope,
  });
}

// hold one kernel lock for the complete controller process operation
async function withControllerProcessLock(operation) {
  await ensureAdjustmentPrivateDirectory("state");
  const handle = await open(
    CONTROLLER_LOCK_PATH,
    fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
    0o600,
  );
  const details = await handle.stat();

  // reject substituted or broadly accessible lock files
  if (!details.isFile() || details.uid !== process.getuid() || details.nlink !== 1 ||
    (details.mode & 0o777) !== 0o600) {
    await handle.close();
    throw new Error("maintenance controller lock is invalid");
  }
  const child = spawn(
    "/usr/bin/flock",
    ["--exclusive", "--nonblock", CONTROLLER_LOCK_PATH, "sh", "-c", "printf ready; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  try {
    const ready = await waitForLockReady(child);

    // refuse concurrent daily or monthly controller execution
    if (ready !== "ready") {
      throw new Error("maintenance controller lock is occupied");
    }
    return await operation();
  } finally {
    child.stdin.end();
    await waitForChildExit(child).catch(() => undefined);
    await handle.close();
  }
}

// wait for the fixed flock readiness marker
async function waitForLockReady(child) {
  return await new Promise(
    // settle on readiness, failure or early exit
    (resolvePromise, rejectPromise) => {
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("ascii");

        // resolve only the complete marker
        if (output === "ready") {
          resolvePromise(output);
        }
      });
      child.once("error", rejectPromise);
      child.once("exit", () => resolvePromise(output));
    },
  );
}

// wait for one child process exit
async function waitForChildExit(child) {
  // return an already observed exit code
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await new Promise(
    // retain one bounded child lifecycle
    (resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", resolvePromise);
    },
  );
}

// require one inherited owner socket for the fixed ssh identity
async function requireControllerSshAgentSocket() {
  const path = process.env.SSH_AUTH_SOCK;

  // reject absent, relative, or unbounded agent paths
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 4_096) {
    throw new Error("scorecard_publication_agent_unavailable");
  }
  let details;

  try {
    details = await lstat(path);
  } catch {
    throw new Error("scorecard_publication_agent_unavailable");
  }

  // require one current-user socket without link indirection
  if (!details.isSocket() || details.isSymbolicLink() || details.uid !== process.getuid() ||
    await realpath(path) !== path) {
    throw new Error("scorecard_publication_agent_unavailable");
  }
  return path;
}

// transfer one already validated scorecard and bound publication identity
async function transferScorecardPublication(child, bytes) {
  // require the ordinary spawned-process stream surface
  if (child === null || typeof child !== "object" || child.stdin === null ||
    child.stdout === null || child.stderr === null ||
    typeof child.stdin?.end !== "function" || typeof child.stdout?.on !== "function" ||
    typeof child.stderr?.on !== "function" || typeof child.once !== "function") {
    throw new TypeError("scorecard publication process is invalid");
  }
  await new Promise(
    // settle only after the remote forced command closes
    (resolvePromise, rejectPromise) => {
      let outputBytes = 0;
      let settled = false;

      // close the child after the first terminal result
      const settle = (error) => {
        // ignore duplicate stream and process events
        if (settled) {
          return;
        }
        settled = true;

        // preserve one bounded failure or success result
        if (error === null) {
          resolvePromise();
        } else {
          rejectPromise(error);
        }
      };
      const collect = (chunk) => {
        outputBytes += Buffer.byteLength(chunk);

        // stop unbounded remote diagnostics before retaining them
        if (outputBytes > SCORECARD_PUBLICATION_OUTPUT_MAXIMUM_BYTES) {
          child.kill?.("SIGKILL");
          settle(new Error("scorecard_publication_output_refused"));
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.once("error", (error) => settle(error));
      child.stdin.once("error", (error) => settle(error));
      child.once("close", (code, signal) => {
        // accept only a clean forced-command exit
        if (code !== 0 || signal !== null) {
          settle(new Error("scorecard_publication_failed"));
          return;
        }
        settle(null);
      });
      child.stdin.end(bytes);
    },
  );
}

// collect one bounded canonical family release response
async function collectAdjustmentFamilyReleaseResult(child) {
  // require the ordinary spawned-process output surface
  if (child === null || typeof child !== "object" || child.stdout === null ||
    child.stderr === null || typeof child.stdout?.on !== "function" ||
    typeof child.stderr?.on !== "function" || typeof child.once !== "function") {
    throw new TypeError("family release process is invalid");
  }
  return await new Promise(
    // settle only once after the forced command closes
    (resolvePromise, rejectPromise) => {
      const output = [];
      let outputBytes = 0;
      let diagnosticBytes = 0;
      let settled = false;

      // close the child after one terminal result
      const settle = (error, bytes = null) => {
        // ignore duplicate stream and process events
        if (settled) return;
        settled = true;

        // preserve one bounded failure or successful response
        if (error === null) resolvePromise(bytes);
        else rejectPromise(error);
      };
      child.stdout.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);

        // stop an unbounded success response before retaining it
        if (outputBytes > FAMILY_RELEASE_OUTPUT_MAXIMUM_BYTES) {
          child.kill?.("SIGKILL");
          settle(new Error("family_release_output_refused"));
          return;
        }
        output.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        diagnosticBytes += Buffer.byteLength(chunk);

        // stop unbounded remote diagnostics without retaining them
        if (diagnosticBytes > FAMILY_RELEASE_OUTPUT_MAXIMUM_BYTES) {
          child.kill?.("SIGKILL");
          settle(new Error("family_release_output_refused"));
        }
      });
      child.once("error", (error) => settle(error));
      child.once("close", (code, signal) => {
        // accept only one clean nonempty canonical response
        if (code !== 0 || signal !== null || outputBytes === 0) {
          settle(new Error("family_release_failed"));
          return;
        }
        settle(null, Buffer.concat(output));
      });
    },
  );
}

// collect one bounded canonical revision start or page response
async function collectAdjustmentRevisionColdResult(child) {
  // require the ordinary spawned-process output surface
  if (child === null || typeof child !== "object" || child.stdout === null ||
    child.stderr === null || typeof child.stdout?.on !== "function" ||
    typeof child.stderr?.on !== "function" || typeof child.once !== "function") {
    throw new TypeError("revision catalog process is invalid");
  }
  return await new Promise(
    // settle only once after the forced command closes
    (resolvePromise, rejectPromise) => {
      const output = [];
      let outputBytes = 0;
      let diagnosticBytes = 0;
      let settled = false;

      // retain only the first terminal process result
      const settle = (error, bytes = null) => {
        // ignore duplicate stream and process events
        if (settled) return;
        settled = true;

        // preserve one bounded failure or successful response
        if (error === null) resolvePromise(bytes);
        else rejectPromise(error);
      };
      child.stdout.on("data", (chunk) => {
        outputBytes += Buffer.byteLength(chunk);

        // stop before retaining an oversized catalog page
        if (outputBytes > REVISION_CATALOG_OUTPUT_MAXIMUM_BYTES) {
          child.kill?.("SIGKILL");
          settle(new Error("revision_catalog_output_refused"));
          return;
        }
        output.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk) => {
        diagnosticBytes += Buffer.byteLength(chunk);

        // bound remote diagnostics independently of a valid payload
        if (diagnosticBytes > FAMILY_RELEASE_OUTPUT_MAXIMUM_BYTES) {
          child.kill?.("SIGKILL");
          settle(new Error("revision_catalog_output_refused"));
        }
      });
      child.once("error", (error) => settle(error));
      child.once("close", (code, signal) => {
        // accept only one clean nonempty response
        if (code !== 0 || signal !== null || outputBytes === 0) {
          settle(new Error("revision_catalog_failed"));
          return;
        }
        settle(null, Buffer.concat(output));
      });
    },
  );
}

// validate the injected production port surface
function validateControllerPorts(ports) {
  requirePlainObject(ports, "controller ports");
  const required = [
    "archive",
    "clock",
    "inspectSemanticInput",
    "journal",
    "publishAttemptReport",
    "reconcileTerminalOutcome",
    "runFit",
    "withProcessLock",
  ];

  // validate the production-only epoch bootstrap when supplied
  if (ports.initializeLifecycle !== undefined &&
    typeof ports.initializeLifecycle !== "function") {
    throw new TypeError("controller port initializeLifecycle is invalid");
  }
  if (ports.synchronizeEvidence !== undefined &&
    typeof ports.synchronizeEvidence !== "function") {
    throw new TypeError("controller port synchronizeEvidence is invalid");
  }
  if (ports.buildCandidateParity !== undefined &&
    typeof ports.buildCandidateParity !== "function") {
    throw new TypeError("controller port buildCandidateParity is invalid");
  }
  if (ports.buildCandidateRegistration !== undefined &&
    typeof ports.buildCandidateRegistration !== "function") {
    throw new TypeError("controller port buildCandidateRegistration is invalid");
  }
  if (ports.publishRainControlReference !== undefined &&
    typeof ports.publishRainControlReference !== "function") {
    throw new TypeError("controller port publishRainControlReference is invalid");
  }

  // require every executable boundary before lock acquisition
  for (const name of required) {
    const value = ports[name];

    // archive and journal are validated by their method sets below
    if (name !== "archive" && name !== "journal" && typeof value !== "function") {
      throw new TypeError(`controller port ${name} is invalid`);
    }
  }

  // require the closed archive and journal operations
  if (typeof ports.archive?.initialize !== "function" ||
    typeof ports.archive?.status !== "function" ||
    typeof ports.journal?.initialize !== "function" ||
    typeof ports.journal?.status !== "function" ||
    typeof ports.journal?.inspectDueKeys !== "function" ||
    typeof ports.journal?.readDueAttemptContext !== "function" ||
    typeof ports.journal?.recordDueAttemptContext !== "function" ||
    typeof ports.journal?.readDueTerminalOutcome !== "function" ||
    typeof ports.journal?.recordDueTerminalOutcome !== "function" ||
    typeof ports.journal?.readDueTerminalRetirement !== "function" ||
    typeof ports.journal?.recordDueTerminalRetirement !== "function" ||
    typeof ports.journal?.completeDueTerminalRetirement !== "function" ||
    typeof ports.journal?.acquireLease !== "function" ||
    typeof ports.journal?.completeDue !== "function" ||
    typeof ports.journal?.releaseLease !== "function" ||
    typeof ports.journal?.reconcileExpiredLease !== "function") {
    throw new TypeError("controller storage ports are invalid");
  }
}

// require one closed semantic input result
function validateSemanticInspection(value) {
  requirePlainObject(value, "semantic inspection");

  // accept one value-free no-candidate daily snapshot
  if (value.state === "idle") {
    requireExactKeys(value, ["inputManifestSha256", "reason", "state"],
      "semantic inspection");
    requireSha256(value.inputManifestSha256, "inputManifestSha256");
    if (value.reason !== "no_registered_candidate") {
      throw new TypeError("semantic inspection idle reason is invalid");
    }
    return value;
  }

  // accept only an honest blocked result
  if (value.state === "blocked") {
    requireExactKeys(value, ["reason", "state"], "semantic inspection");

    // reject prose or unknown refusal reasons
    if (!SAFE_REASON_PATTERN.test(value.reason) ||
      !new Set(["history_unavailable", "semantic_catalog_unavailable", "semantic_input_blocked"])
        .has(value.reason)) {
      throw new TypeError("semantic inspection reason is invalid");
    }
    return value;
  }

  // accept one immutable monthly population that genuinely has no candidate
  if (value.state === "no_candidate") {
    requireExactKeys(value, ["inputManifestSha256", "reason", "state"],
      "semantic inspection");
    requireSha256(value.inputManifestSha256, "inputManifestSha256");
    if (!new Set([
      "incomplete_development_population", "incomplete_development_target",
    ]).has(value.reason)) {
      throw new TypeError("semantic inspection no-candidate reason is invalid");
    }
    return value;
  }
  const readyKeys = [
    "fitInput",
    "inputManifestSha256",
    "runtimeReadiness",
    "runtimeReadinessSha256",
    "state",
  ];
  const hasDailyEvaluation = Object.hasOwn(value, "dailyEvaluationInput");
  const hasDailyTerminal = Object.hasOwn(value, "dailyTerminalMaterial");
  const hasDailyUnsupported = Object.hasOwn(value, "dailyUnsupportedMaterial");
  const hasControlReference = Object.hasOwn(value, "controlReferenceMaterial");
  const hasParityInputs = Object.hasOwn(value, "retainedParityInput") ||
    Object.hasOwn(value, "syntheticParityInput");
  const hasRegistrationContext = Object.hasOwn(value, "registrationContext");
  const hasRegistrationSlot = Object.hasOwn(value, "registrationSlot");
  const completeReadyKeys = hasDailyUnsupported
    ? ["dailyUnsupportedMaterial", "inputManifestSha256", "state"]
    : hasDailyEvaluation
    ? ["dailyEvaluationInput", "inputManifestSha256", "state",
        ...(hasDailyTerminal ? ["dailyTerminalMaterial"] : [])]
    : hasControlReference
    ? ["controlReferenceMaterial", "inputManifestSha256", "state"]
    : hasRegistrationSlot
    ? [...readyKeys, "registrationSlot"]
    : readyKeys;

  // admit parity inputs only as one complete retained and synthetic pair
  requireExactKeys(value, hasParityInputs
    ? [...completeReadyKeys, "registrationContext", "retainedParityInput", "syntheticParityInput"]
    : completeReadyKeys, "semantic inspection");

  // require closed ready inputs without claiming qualification
  if (value.state !== "ready") {
    throw new TypeError("semantic inspection state is invalid");
  }
  requireSha256(value.inputManifestSha256, "inputManifestSha256");
  if (hasDailyUnsupported) {
    requirePlainObject(value.dailyUnsupportedMaterial, "dailyUnsupportedMaterial");
    if (hasDailyEvaluation || hasDailyTerminal || hasParityInputs || hasRegistrationSlot) {
      throw new TypeError("semantic inspection unsupported daily shape is invalid");
    }
    return value;
  }
  if (hasDailyEvaluation) {
    requirePlainObject(value.dailyEvaluationInput, "dailyEvaluationInput");
    if (hasDailyTerminal) {
      requirePlainObject(value.dailyTerminalMaterial, "dailyTerminalMaterial");
    }
    if (hasParityInputs || hasRegistrationSlot) {
      throw new TypeError("semantic inspection daily shape is invalid");
    }
    return value;
  }
  if (hasControlReference) {
    requirePlainObject(value.controlReferenceMaterial, "controlReferenceMaterial");
    if (hasParityInputs || hasRegistrationSlot) {
      throw new TypeError("semantic inspection control reference shape is invalid");
    }
    return value;
  }
  requireSha256(value.runtimeReadinessSha256, "runtimeReadinessSha256");
  requirePlainObject(value.fitInput, "fitInput");
  requirePlainObject(value.runtimeReadiness, "runtimeReadiness");
  // validate the database-owned family slot without accepting a boolean alias
  if (hasRegistrationSlot) {
    validateAdjustmentRegistrationSlot(value.registrationSlot);
  }
  if (hasParityInputs) {
    requirePlainObject(value.registrationContext, "registrationContext");
    requireExactKeys(value.registrationContext, [
      "cutoffAt", "historicalMemberRootSha256", "inputManifestSha256",
      "predecessorRegistrationSha256", "predecessorTerminalAt",
    ], "registrationContext");
    requireInstant(value.registrationContext.cutoffAt,
      "registrationContext cutoffAt");
    requireSha256(value.registrationContext.historicalMemberRootSha256,
      "registrationContext historicalMemberRootSha256");
    requireSha256(value.registrationContext.inputManifestSha256,
      "registrationContext inputManifestSha256");
    requireNullableSha256(value.registrationContext.predecessorRegistrationSha256,
      "registrationContext predecessorRegistrationSha256");

    // bind predecessor clocks only when the reconciled identity exists
    if ((value.registrationContext.predecessorRegistrationSha256 === null) !==
      (value.registrationContext.predecessorTerminalAt === null)) {
      throw new TypeError("registrationContext predecessor differs");
    }
    if (value.registrationContext.predecessorTerminalAt !== null) {
      requireInstant(value.registrationContext.predecessorTerminalAt,
        "registrationContext predecessorTerminalAt");
    }
    requirePlainObject(value.retainedParityInput, "retainedParityInput");
    requirePlainObject(value.syntheticParityInput, "syntheticParityInput");
  } else if (hasRegistrationContext) {
    throw new TypeError("semantic inspection registration context is incomplete");
  }
  return value;
}

// validate one value-free database-owned family slot projection
function validateAdjustmentRegistrationSlot(value) {
  requireExactKeys(value, [
    "contractVersion", "epochWitnessSha256", "family", "horizonEndAt",
    "registrationSha256", "scheduleContractSha256", "state", "terminalAt",
  ], "registration slot");
  requireFamilyOrNull(value.family);
  requireSha256(value.epochWitnessSha256, "epochWitnessSha256");
  requireSha256(value.scheduleContractSha256, "scheduleContractSha256");
  requireInstant(value.horizonEndAt, "horizonEndAt");
  requireNullableSha256(value.registrationSha256, "registrationSha256");

  // bind the exact rolling contract and occupancy fields
  if (value.contractVersion !== "adjustment-shadow-registration-slot/v3" ||
    value.family === null || value.scheduleContractSha256 !== ADJUSTMENT_ROLLING_SCHEDULE_SHA256 ||
    !new Set(["busy_v2_legacy", "busy_v3", "free"]).has(value.state)) {
    throw new TypeError("registration slot is invalid");
  }
  if (value.state === "free") {
    // reject identities on a nominally free slot
    if (value.registrationSha256 !== null || value.terminalAt !== null) {
      throw new TypeError("registration free slot differs");
    }
  } else {
    requireSha256(value.registrationSha256, "registrationSha256");
    requireInstant(value.terminalAt, "terminalAt");
  }
  return value;
}

// project one closed due key into its fixed cutoff and scope
function dueFromKey(dueKey) {
  requireDueKey(dueKey);

  // project one daily cutoff at the next local midnight
  if (dueKey.startsWith("daily/")) {
    const localDate = dueKey.slice("daily/".length);
    return {
      dueKey,
      family: null,
      mode: "daily",
      originalCutoffAt: localMidnightInstant(addLocalDates(localDate, 1)),
      scope: "daily",
    };
  }
  if (dueKey.startsWith("control-reference/rain/")) {
    const month = dueKey.slice("control-reference/rain/".length);
    return {
      dueKey,
      family: "rain",
      mode: "monthly",
      originalCutoffAt: new Date(Date.parse(`${month}-01T00:00:00.000Z`) -
        7 * 86_400_000).toISOString(),
      scope: "control-reference/rain",
    };
  }
  const [, family, month] = dueKey.split("/");
  return {
    dueKey,
    family,
    mode: "monthly",
    originalCutoffAt: localMidnightInstant(`${month}-01`),
    scope: `monthly/${family}`,
  };
}

// validate one archived pre-month state and its exact portable ordinal artifact
function validateRainControlReferenceMaterial(value, due, now) {
  requireExactKeys(value, [
    "controlStateBytes", "graphManifestSha256", "ordinalArtifactBytes",
    "sourceMemberRootSha256", "sourceReceiptRootSha256",
  ], "rain control reference material");
  if (!Buffer.isBuffer(value.controlStateBytes) || !Buffer.isBuffer(value.ordinalArtifactBytes) ||
    value.controlStateBytes.length === 0 || value.ordinalArtifactBytes.length === 0 ||
    value.controlStateBytes.length > 8 * 1_024 * 1_024 ||
    value.ordinalArtifactBytes.length > 8 * 1_024 * 1_024) {
    throw new TypeError("rain control reference bytes are invalid");
  }
  requireSha256(value.graphManifestSha256, "graphManifestSha256");
  requireSha256(value.sourceMemberRootSha256, "sourceMemberRootSha256");
  requireSha256(value.sourceReceiptRootSha256, "sourceReceiptRootSha256");
  const state = parseRainMaintenanceControlState(value.controlStateBytes);
  validateRainMaintenanceControlArtifact(state, value.ordinalArtifactBytes);
  const month = due.dueKey.slice("control-reference/rain/".length);
  const monthStart = Date.parse(`${month}-01T00:00:00.000Z`);
  const generatedAt = Date.parse(state.generatedAt);

  // bind the state to the due, archive roots and exact seven-day publication window
  if (state.modelMonth !== month || state.sourceMemberRootSha256 !== value.sourceMemberRootSha256 ||
    state.sourceReceiptRootSha256 !== value.sourceReceiptRootSha256 ||
    generatedAt < monthStart - 7 * 86_400_000 || generatedAt >= monthStart ||
    generatedAt > Date.parse(now)) {
    throw new TypeError("rain control reference material differs");
  }
  return Object.freeze({ ...value });
}

// return the next UTC calendar month for the pre-month reference window
function utcMonthAfter(instant) {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth() + 1;
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7);
}

// validate one derived due projection
function validateDue(due) {
  requireExactKeys(due, [
    "dueKey",
    "family",
    "mode",
    "originalCutoffAt",
    "scope",
  ], "maintenance due");
  requireDueKey(due.dueKey);
  requireFamilyOrNull(due.family);
  requireControllerMode(due.mode);
  requireInstant(due.originalCutoffAt, "originalCutoffAt");
  const expected = dueFromKey(due.dueKey);

  // reject caller-shaped cutoff, family or scope drift
  if (!canonicalJsonBytes(due).equals(canonicalJsonBytes(expected))) {
    throw new TypeError("maintenance due projection is invalid");
  }
}

// derive one stable retry identity from due and original input
function controllerRunId(dueKey, inputHeadSha256) {
  return `maintenance-${adjustmentSha256(`${dueKey}\n${inputHeadSha256}\n`).slice(0, 32)}`;
}

// format one instant as a local calendar date
function localDateAt(date) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: ADJUSTMENT_MAINTENANCE_TIME_ZONE,
    year: "numeric",
  }).format(date);
}

// convert one local midnight through the fixed timezone
function localMidnightInstant(localDate) {
  let guess = Date.parse(`${localDate}T08:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: ADJUSTMENT_MAINTENANCE_TIME_ZONE,
    year: "numeric",
  });

  // converge the formatted local wall clock to midnight
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(
      // retain only named calendar components
      (part) => [part.type, part.value],
    ));
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    const target = Date.parse(`${localDate}T00:00:00.000Z`);
    guess += target - observed;
  }
  return new Date(guess).toISOString();
}

// enumerate inclusive local dates without timezone arithmetic
function localDatesBetween(start, end) {
  // return no dates for a reversed interval
  if (end < start) {
    return [];
  }
  const dates = [];
  let current = start;

  // retain every exact calendar label once
  while (current <= end) {
    dates.push(current);
    current = addLocalDates(current, 1);
  }
  return dates;
}

// enumerate inclusive calendar months
function monthsBetween(start, end) {
  // return no months for a reversed interval
  if (end < start) {
    return [];
  }
  const months = [];
  let current = start;

  // retain every exact calendar month once
  while (current <= end) {
    months.push(current);
    current = addMonths(current, 1);
  }
  return months;
}

// add exact UTC calendar days to one date label
function addLocalDates(localDate, days) {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString().slice(0, 10);
}

// add exact calendar months to one month label
function addMonths(month, delta) {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

// return the preceding calendar month
function previousMonth(month) {
  return addMonths(month, -1);
}

// retain the earlier local date
function minimumLocalDate(left, right) {
  return left < right ? left : right;
}

// retain the earlier calendar month
function minimumMonth(left, right) {
  return left < right ? left : right;
}

// require one valid date object
function requireDate(value) {
  const date = value instanceof Date ? value : new Date(value);

  // reject invalid caller clocks
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError("controller clock is invalid");
  }
  return date;
}

// require one exact controller mode
function requireControllerMode(value) {
  // reject aliases and combined modes
  if (value !== "daily" && value !== "monthly") {
    throw new TypeError("controller mode is invalid");
  }
}

// require one exact due key
function requireDueKey(value) {
  // reject traversal and alternate due classes
  if (typeof value !== "string" || !DUE_KEY_PATTERN.test(value)) {
    throw new TypeError("maintenance dueKey is invalid");
  }
}

// require one fixed family or daily null
function requireFamilyOrNull(value) {
  // reject cross-family aliases
  if (value !== null && !FAMILIES.includes(value)) {
    throw new TypeError("maintenance family is invalid");
  }
}

// require one canonical UTC millisecond instant
function requireInstant(value, label) {
  let normalized;

  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw new TypeError(`${label} is invalid`);
  }

  // reject alternate or impossible instants
  if (typeof value !== "string" || normalized !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one canonical database archive ordinal
function requireArchiveOrdinal(value, label) {
  // match the signed bigint producer without numeric coercion
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,18})$/u.test(value) ||
    BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one lowercase sha-256
function requireSha256(value, label) {
  // reject alternate hash encodings
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one full lowercase git commit identity
function requireGitCommit(value, label) {
  // reject tags, abbreviations and alternate encodings
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one bounded immutable byte surface
function requireBuffer(value, label) {
  if (!Buffer.isBuffer(value) || value.length < 2 || value.length > 8 * 1_024 * 1_024) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one nullable lowercase sha-256
function requireNullableSha256(value, label) {
  // validate only a present identity
  if (value !== null) {
    requireSha256(value, label);
  }
}

// require one plain object
function requirePlainObject(value, label) {
  // reject arrays, null and custom prototypes
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

// require one exact closed object key set
function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  // reject unknown or missing fields
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has invalid keys`);
  }
}

// isolate process execution from imported controller helpers
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runAdjustmentMaintenanceController().then(
    // emit one bounded sanitized run projection
    (result) => process.stdout.write(canonicalJsonBytes(result)),
  ).catch(
    // expose only the controlled failure class
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : "maintenance controller failed"}\n`);
      process.exitCode = 1;
    },
  );
}
