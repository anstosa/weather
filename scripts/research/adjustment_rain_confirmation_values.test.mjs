import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  RAIN_COLLECTION_STATIONS,
} from "./adjustment-maintenance-runtime/node_modules/@weather/domain/dist/rain-collection.js";
import {
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  canonicalJsonBytes,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  createMaintenanceShadowServingAuthority,
  encodeMaintenanceShadowComparator,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-comparator.js";
import {
  adjustmentRainGateFeatureRowSha256,
  createRainMaintenancePersistenceTarget,
  encodeAdjustmentRainGateControlProjection,
  encodeAdjustmentRevisionBatchProjection,
  encodeAdjustmentRevisionProjection,
} from "./adjustment-maintenance-runtime/forecast/maintenance-revision-projection.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
  RAIN_HURDLE_WIND_ARTIFACT_SHA256,
} from "./adjustment-maintenance-runtime/forecast/rain-hurdle-wind-artifact.js";
import {
  createMaintenanceShadowPredictionMetadata,
  createMaintenanceShadowSourceIdentity,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowSourceProjection,
  encodeMaintenanceShadowValues,
  MAINTENANCE_SHADOW_SOURCE_VERSION,
  MAINTENANCE_SHADOW_VALUES_VERSION,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";
import {
  buildAdjustmentMaintenanceExpectedKeyPlanV3,
} from "./adjustment_daily_evaluation.mjs";
import {
  buildAdjustmentMaintenanceInputClassMembers,
} from "./adjustment_maintenance_controller.mjs";
import {
  planAdjustmentMaintenanceUnsupportedDailyConfirmation,
} from "./adjustment_confirmation_values.mjs";
import {
  assembleAdjustmentRainUnsupportedDailyConfirmation,
} from "./adjustment_rain_confirmation_values.mjs";
import {
  rainHistoryEpochWitness,
  rainHistoryTargetOccurrence,
} from "./fixtures/adjustment-rain-history.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const RUN_AT = "2026-10-11T12:00:00.000Z";
const ISSUED_AT = "2026-10-11T20:02:17.123Z";
const DUE_KEY = "capture/2026-10-11T12:35:00.000Z";
const VALID_AT = "2026-10-12T07:00:00.000Z";
const TARGET_CUTOFF_AT = "2027-09-18T07:00:00.000Z";

// hash exact fixture bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// create a generic verified archive envelope around canonical bytes
function occurrence(payloadBytes, ordinal, archiveCommittedAt, receipts = 1) {
  const document = JSON.parse(payloadBytes.toString("utf8"));
  const payloadIdentitySha256 = sha256(payloadBytes);
  return {
    graphManifestSha256: sha256(Buffer.from(`graph-${ordinal}`)),
    pageSha256: sha256(Buffer.from(`page-${ordinal}`)),
    payloadBytes,
    payloadIdentitySha256,
    payloadKind: document.contractVersion,
    publicationDisposition: "published",
    receipts: Array.from({ length: receipts }, (_unused, index) => ({
      archiveCommitOrdinal: String(ordinal + index),
      archiveCommittedAt,
      contractVersion: "adjustment-revision-commit-receipt/v1",
      frontierSha256: A,
      predecessorFrontierSha256: B,
      projectionIdentitySha256: payloadIdentitySha256,
      projectionKind: document.projectionKind,
      projectionSha256: payloadIdentitySha256,
      receiptSha256: sha256(Buffer.from(`receipt-${ordinal}-${index}`)),
      stageReceiptSha256: C,
    })),
  };
}

// create one exact future-only rain registration pair
function registrations(witness) {
  const intervalStartAt = "2026-10-12T07:00:00.000Z";
  const intervalEndAt = "2027-09-11T07:00:00.000Z";
  const keyPlan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: "rain",
    intervalEndAt,
    intervalStartAt,
  });
  const shadow = {
    artifactSha256: A,
    candidateSha256: B,
    cohortSha256: C,
    epochWitnessSha256: witness.witnessSha256,
    family: "rain",
    intervalEndAt,
    intervalStartAt,
    policySha256: "d".repeat(64),
    predecessorRegistrationSha256: null,
    registrationSha256: "",
    reservedKeySha256: keyPlan.reservedKeySha256,
    scheduleContractSha256: "ca29db99377001fca2e2e4268fd80d1cbe7b876f71f2d5ba04e575712cb9f13b",
    siteKey: "ballydidean",
    sourceSha256: "e".repeat(64),
    targetCutoffAt: TARGET_CUTOFF_AT,
    terminalAt: "2027-09-19T07:00:00.000Z",
  };
  shadow.registrationSha256 = sha256(Buffer.from(`${[
    "adjustment-shadow-registration/v3", shadow.siteKey, shadow.family,
    shadow.candidateSha256, shadow.artifactSha256, shadow.policySha256, shadow.cohortSha256,
    shadow.reservedKeySha256, shadow.sourceSha256, shadow.epochWitnessSha256,
    shadow.scheduleContractSha256, "none", shadow.intervalStartAt, shadow.intervalEndAt,
    shadow.targetCutoffAt, shadow.terminalAt,
  ].join("\n")}\n`));
  const confirmation = {
    accessState: "registered",
    actionIdentitySha256: null,
    actionState: "none",
    candidateKind: "rain-hurdle-wind-occurrence-amount/v1",
    candidateReportSha256: null,
    candidateSha256: shadow.candidateSha256,
    cohortLineageSha256: shadow.cohortSha256,
    contractVersion: "forecast-adjustment-lifecycle-ledger/v2",
    family: "rain",
    firstTargetAt: intervalStartAt,
    gateManifestSha256: shadow.policySha256,
    inputHeadSha256: "f".repeat(64),
    intervalEndExclusiveLocalDate: "2027-09-11",
    intervalStartLocalDate: "2026-10-12",
    registrationSha256: "",
    reservedKeySha256: shadow.reservedKeySha256,
    sourceLineageSha256: shadow.sourceSha256,
    terminalAccessAt: shadow.terminalAt,
  };
  const unsigned = Object.fromEntries([
    "contractVersion", "family", "candidateKind", "candidateSha256", "cohortLineageSha256",
    "sourceLineageSha256", "reservedKeySha256", "intervalStartLocalDate",
    "intervalEndExclusiveLocalDate", "firstTargetAt", "terminalAccessAt", "gateManifestSha256",
    "inputHeadSha256",
  ].map(
    // reproduce the lifecycle journal registration identity
    (field) => [field, confirmation[field]],
  ));
  confirmation.registrationSha256 = sha256(canonicalJsonBytes(unsigned));
  return { confirmation, keyPlan, shadow };
}

// build a parser-authenticated rain v2 capsule with genuine nested causal source bytes
function rainCapsule(registration) {
  const contentSha256 = sha256(Buffer.from("rain-current"));
  const source = {
    candidateSha256: registration.candidateSha256,
    causalInputs: {
      captureSet: [{ bodySha256: contentSha256, claimId: "forecast", completedAt: "2026-10-11T18:01:00.000Z",
        kind: "forecast", runInitializedAt: RUN_AT, stationId: null,
        windowEndExclusive: null, windowStart: null }],
      contractVersion: "adjustment-shadow-rain-causal-inputs/v1",
      currentRun: {
        completedAt: "2026-10-11T18:01:00.000Z",
        contentSha256,
        hours: Array.from({ length: 48 }, (_unused, index) => ({
          cloudCoverPercent64: encodeMaintenanceBinary64(50),
          leadHours: index + 1,
          precipitationMm64: encodeMaintenanceBinary64(2),
          pressureHpa64: encodeMaintenanceBinary64(1_000),
          relativeHumidityPercent64: encodeMaintenanceBinary64(80),
          temperatureC64: encodeMaintenanceBinary64(12),
          windDirectionDegrees64: encodeMaintenanceBinary64(180),
          windSpeedMps64: encodeMaintenanceBinary64(5),
        })),
        runInitializedAt: RUN_AT,
      },
      priorRuns: [],
      stationHours: [],
    },
    contractVersion: MAINTENANCE_SHADOW_SOURCE_VERSION,
    dueKey: DUE_KEY,
    family: "rain",
    issuedAt: ISSUED_AT,
    registrationSha256: registration.registrationSha256,
    rowCount: 23,
    rows: Array.from({ length: 23 }, (_unused, index) => ({
      adapterVersion: "open-meteo-rain-capture/v1",
      contentSha256,
      contractEpoch: "rain-prospective-capture/v1",
      dataset: "ecmwf_ifs",
      leadHours: index + 1,
      modelLeadHours: index + 9,
      precipitationMm64: encodeMaintenanceBinary64(2),
      providerKey: "open-meteo-single-runs",
      receivedAt: "2026-10-11T18:01:00.000Z",
      referenceAt: RUN_AT,
      revisionCount: 0,
      sourceConfigFingerprint: "96e4365f74a0fb8694944172b73a65c29d89a68ddf86b1b0a50db38bb39d52aa",
      sourceKey: "rain-prospective-forecast",
      sourceSha256: registration.sourceSha256,
      upstreamModel: "ecmwf_ifs",
      validAt: new Date(Date.parse(RUN_AT) + (index + 9) * 3_600_000).toISOString(),
    })),
    sourceSha256: registration.sourceSha256,
  };
  const sourceBytes = encodeMaintenanceShadowSourceProjection(source);
  const identity = createMaintenanceShadowSourceIdentity(sourceBytes);
  const body = {
    candidateSha256: source.candidateSha256,
    contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION,
    dueKey: source.dueKey,
    family: "rain",
    inputSha256: identity.inputSha256,
    issuedAt: source.issuedAt,
    registrationSha256: source.registrationSha256,
    rowCount: source.rowCount,
    rows: source.rows.map((row, index) => ({
      atLeast1_0Probability64: encodeMaintenanceBinary64(0.4),
      atLeast2_5Probability64: encodeMaintenanceBinary64(0.2),
      candidatePrecipitationMm64: encodeMaintenanceBinary64(2),
      fallbackCode: "none",
      leadHours: row.leadHours,
      occurrenceProbability64: encodeMaintenanceBinary64(0.6),
      positiveAmountMm64: encodeMaintenanceBinary64(2),
      sourceRowSha256: identity.sourceRowSha256[index],
      validAt: row.validAt,
      wouldApply: true,
    })),
    sourceReceiptSha256: identity.sourceReceiptSha256,
    sourceSha256: source.sourceSha256,
  };
  const bodyBytes = encodeMaintenanceShadowValues(body, sourceBytes);
  const metadata = createMaintenanceShadowPredictionMetadata(bodyBytes, sourceBytes);
  const authority = createMaintenanceShadowServingAuthority({
    artifactBytes: Buffer.from(RAIN_HURDLE_WIND_ARTIFACT_JSON),
    artifactIdentitySha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256,
    authorityKind: "legacy_active",
    family: "rain",
    receiptBytes: canonicalJsonBytes({ activeArtifact: {
      artifactSha256: RAIN_HURDLE_WIND_ARTIFACT_SHA256 },
    contractVersion: "forecast-adjustment-rain-runtime-registry/v1", rawReason: null,
    siteKey: "ballydidean" }),
  });
  const comparatorBytes = encodeMaintenanceShadowComparator({
    contractVersion: "adjustment-shadow-incumbent-comparator/v1",
    family: "rain",
    registrationSha256: source.registrationSha256,
    candidateSha256: source.candidateSha256,
    sourceSha256: source.sourceSha256,
    dueKey: source.dueKey,
    issuedAt: source.issuedAt,
    sourceProjectionSha256: sha256(sourceBytes),
    predictionBodySha256: metadata.predictionBodySha256,
    servingAuthority: authority,
    rowCount: source.rowCount,
    rows: source.rows.map((row, index) => ({
      validAt: row.validAt,
      leadHours: row.leadHours,
      sourceRowSha256: identity.sourceRowSha256[index],
      incumbentPrecipitationMm64: encodeMaintenanceBinary64(2),
      occurrenceProbability64: encodeMaintenanceBinary64(0.6),
      atLeast1_0Probability64: encodeMaintenanceBinary64(0.4),
      atLeast2_5Probability64: encodeMaintenanceBinary64(0.2),
      positiveAmountMm64: encodeMaintenanceBinary64(2),
      applied: true,
      reasonCode: null,
    })),
  }, sourceBytes, bodyBytes);
  const stageUnsigned = {
    contractVersion: "adjustment-shadow-stage-receipt/v2",
    durable: true,
    durableAt: "2026-10-11T20:03:00.000Z",
    dueKey: source.dueKey,
    predictionBodySha256: metadata.predictionBodySha256,
    registrationSha256: source.registrationSha256,
    sourceProjectionSha256: sha256(sourceBytes),
    comparatorSha256: sha256(comparatorBytes),
  };
  const stageReceipt = { ...stageUnsigned,
    stageReceiptSha256: sha256(Buffer.from(`${JSON.stringify(stageUnsigned)}\n`)) };
  const predecessorFrontierSha256 = sha256(Buffer.from("adjustment-revision-frontier/v1\n400\n"));
  const revisionReceipt = {
    archiveCommitOrdinal: "401",
    archiveCommittedAt: "2026-10-11T20:04:00.000Z",
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: "",
    predecessorFrontierSha256,
    projectionIdentitySha256: metadata.sourceReceiptSha256,
    projectionKind: "shadow_prediction",
    projectionSha256: metadata.inputSha256,
    receiptSha256: "",
    stageReceiptSha256: stageReceipt.stageReceiptSha256,
  };
  revisionReceipt.receiptSha256 = sha256(Buffer.from([
    revisionReceipt.contractVersion, revisionReceipt.archiveCommitOrdinal,
    revisionReceipt.archiveCommittedAt, revisionReceipt.projectionKind,
    revisionReceipt.projectionIdentitySha256, revisionReceipt.projectionSha256,
    revisionReceipt.stageReceiptSha256, revisionReceipt.predecessorFrontierSha256,
  ].join("\n")));
  revisionReceipt.frontierSha256 = sha256(Buffer.from([
    "adjustment-revision-frontier/v1", predecessorFrontierSha256,
    revisionReceipt.archiveCommitOrdinal, revisionReceipt.receiptSha256,
  ].join("\n")));
  const bytes = Buffer.from(canonicalJsonBytes({
    bodyBase64: bodyBytes.toString("base64"),
    comparatorBase64: comparatorBytes.toString("base64"),
    comparatorSha256: sha256(comparatorBytes),
    contractVersion: "adjustment-shadow-revision-capsule/v2",
    metadata,
    predictionCommittedAt: "2026-10-11T20:03:30.000Z",
    revisionReceipt,
    sourceProjectionBase64: sourceBytes.toString("base64"),
    sourceProjectionSha256: sha256(sourceBytes),
    stageReceipt,
  }));
  return {
    authority,
    contentSha256,
    occurrence: {
      graphManifestSha256: sha256(Buffer.from("capsule-graph")),
      pageSha256: sha256(Buffer.from("capsule-page")),
      payloadBytes: bytes,
      payloadIdentitySha256: sha256(bytes),
      payloadKind: "adjustment-shadow-revision-capsule/v2",
      publicationDisposition: "published",
      receipts: [revisionReceipt],
    },
  };
}

// create one exact archived pre-target control projection for the same raw run
function rainControl(capsule, { receiptAt = "2026-10-11T20:03:00.000Z",
  sourceId = "forecast", storedContentSha256 = capsule.contentSha256 } = {}) {
  const logicalKey = { inputSha256: A, modelSha256: B, runInitializedAt: RUN_AT };
  const persistenceTarget = createRainMaintenancePersistenceTarget({
    decisionAt: ISSUED_AT,
    rows: RAIN_COLLECTION_STATIONS.map(
      // retain an explicit unavailable prior-hour gauge population
      (station) => ({ captureMembers: [], precipitationMm: null,
        receivedAt: null, stationId: station.locationId }),
    ),
  });
  const rows = Array.from({ length: 23 }, (_unused, index) => {
    const raw = 2;
    const source = {
      features64: Array.from({ length: 107 }, () => encodeMaintenanceBinary64(1)),
      modelLeadHours: index + 9,
      rawPrecipitationMm64: encodeMaintenanceBinary64(raw),
      rawTargetHourTemperatureC64: encodeMaintenanceBinary64(10),
      validAt: new Date(Date.parse(RUN_AT) + (index + 9) * 3_600_000).toISOString(),
    };
    return {
      ...source,
      incumbentArtifactIdentitySha256: capsule.authority.artifactIdentitySha256,
      incumbentPrediction64: encodeMaintenanceBinary64(2),
      incumbentProbability: {
        atLeast0_1: encodeMaintenanceBinary64(0.6),
        atLeast1_0: encodeMaintenanceBinary64(0.4),
        atLeast2_5: encodeMaintenanceBinary64(0.2),
      },
      incumbentReceiptMemberSha256: capsule.authority.receiptMemberSha256,
      nativeSourceProbability: {
        atLeast0_1: encodeMaintenanceBinary64(1),
        atLeast1_0: encodeMaintenanceBinary64(1),
        atLeast2_5: encodeMaintenanceBinary64(0),
      },
      persistencePrediction64: encodeMaintenanceBinary64(raw),
      persistenceReason: "raw_fallback_unavailable",
      persistenceTargetMemberSha256: null,
      recentVolumeScalePrediction64: encodeMaintenanceBinary64(raw),
      sameWindowVolumeScalePrediction64: encodeMaintenanceBinary64(raw),
      sourceRowSha256: adjustmentRainGateFeatureRowSha256(logicalKey, source),
      unchangedOrdinalPrediction64: encodeMaintenanceBinary64(raw),
      volumeScalePrediction64: encodeMaintenanceBinary64(raw),
    };
  });
  const bytes = encodeAdjustmentRainGateControlProjection({
    contractVersion: "adjustment-rain-gate-control-projection/v3",
    family: "rain",
    logicalKey,
    logicalReceivedAt: "2026-10-11T20:02:30.000Z",
    ordinalArtifactSha256: C,
    persistenceTarget,
    projectionKind: "rain_gate_input",
    rows,
    source: {
      adapterVersion: "rain-hurdle-wind-features/v1",
      contractEpoch: "rain-prospective-capture/v1",
      dataset: "ecmwf_ifs",
      providerKey: "open-meteo-single-runs",
      sourceConfigFingerprint: "96e4365f74a0fb8694944172b73a65c29d89a68ddf86b1b0a50db38bb39d52aa",
      sourceId,
      sourceKey: "rain-prospective-forecast",
      sourceKind: "forecast",
      upstreamModel: "ecmwf_ifs",
    },
    stateSha256: A,
    stateStageReceiptSha256: B,
    storedContentSha256,
  });
  return occurrence(bytes, 400, receiptAt);
}

// create one canonical archived v2 Best Match run with a distinct precipitation value
function rainBestMatch({ precipitationMm = 1.25,
  ordinal = 1, receiptAt = "2026-10-11T12:06:00.000Z", sourceKey =
    FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.sourceKey } = {}) {
  const sourceId = "7";
  const rows = Array.from({ length: 168 }, (_unused, index) => ({
    apparentTemperatureC64: encodeMaintenanceBinary64(10),
    blackGlobeTemperatureC64: null,
    cloudCoverPercent64: encodeMaintenanceBinary64(50),
    contentSha256: sha256(Buffer.from(`best-match-${index}`)),
    pm25MicrogramsPerCubicMeter64: null,
    precipitationMm64: encodeMaintenanceBinary64(precipitationMm),
    precipitationRateMmPerHour64: null,
    pressureHpa64: encodeMaintenanceBinary64(1_000),
    relativeHumidityPercent64: encodeMaintenanceBinary64(80),
    soilElectricalConductivityMicrosiemensPerCm64: null,
    soilMoisturePercent64: null,
    solarRadiationWm264: null,
    temperatureC64: encodeMaintenanceBinary64(12),
    uvIndex64: null,
    validAt: new Date(Date.parse(RUN_AT) + (index + 1) * 3_600_000).toISOString(),
    waterLevelM64: null,
    wetBulbGlobeTemperatureC64: null,
    windDirectionDegrees64: encodeMaintenanceBinary64(180),
    windGustMps64: encodeMaintenanceBinary64(8),
    windSpeedMps64: encodeMaintenanceBinary64(5),
  }));
  const canonical = FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1;
  const bytes = encodeAdjustmentRevisionBatchProjection({
    contractVersion: "adjustment-revision-batch-projection/v2",
    family: "wind",
    logicalKey: {
      productRunAt: RUN_AT,
      sourceId,
      sourceKind: "forecast",
      validAt: rows[0].validAt,
    },
    logicalReceivedAt: "2026-10-11T12:05:00.000Z",
    projectionKind: "actual_best_match",
    rows,
    source: {
      adapterVersion: canonical.adapterVersion,
      contractEpoch: canonical.contractEpoch,
      dataset: "best_match",
      providerKey: "open-meteo",
      sourceConfigFingerprint: canonical.sourceConfigFingerprint,
      sourceId,
      sourceKey,
      sourceKind: "forecast",
      upstreamModel: canonical.upstreamModel,
    },
    storedContentSha256: rows[0].contentSha256,
  });
  return occurrence(bytes, ordinal, receiptAt, rows.length);
}

// create one genuine unrelated physical target projection from the shared archive
function unrelatedPhysicalTarget() {
  const contentSha256 = sha256(Buffer.from("unrelated-target"));
  const bytes = encodeAdjustmentRevisionProjection({
    contractVersion: "adjustment-revision-projection/v1",
    family: "shared",
    logicalKey: {
      productRunAt: null,
      sourceId: "12",
      sourceKind: "physical_sensor",
      validAt: VALID_AT,
    },
    logicalReceivedAt: "2026-10-12T07:20:00.000Z",
    projectionKind: "target_revision",
    rows: [{
      apparentTemperatureC64: encodeMaintenanceBinary64(10),
      blackGlobeTemperatureC64: null,
      cloudCoverPercent64: encodeMaintenanceBinary64(50),
      contentSha256,
      pm25MicrogramsPerCubicMeter64: null,
      precipitationMm64: encodeMaintenanceBinary64(1),
      precipitationRateMmPerHour64: null,
      pressureHpa64: encodeMaintenanceBinary64(1_000),
      relativeHumidityPercent64: encodeMaintenanceBinary64(80),
      soilElectricalConductivityMicrosiemensPerCm64: null,
      soilMoisturePercent64: null,
      solarRadiationWm264: null,
      temperatureC64: encodeMaintenanceBinary64(12),
      uvIndex64: null,
      validAt: VALID_AT,
      waterLevelM64: null,
      wetBulbGlobeTemperatureC64: null,
      windDirectionDegrees64: encodeMaintenanceBinary64(180),
      windGustMps64: encodeMaintenanceBinary64(8),
      windSpeedMps64: encodeMaintenanceBinary64(5),
    }],
    source: {
      adapterVersion: "physical/v1",
      contractEpoch: "physical/v1",
      dataset: "unrelated-target",
      providerKey: "physical",
      sourceConfigFingerprint: A,
      sourceId: "12",
      sourceKey: "unrelated-target",
      sourceKind: "physical_sensor",
      upstreamModel: null,
    },
    storedContentSha256: contentSha256,
  });
  return occurrence(bytes, 800, "2026-10-12T07:21:00.000Z");
}

// create one genuine unrelated native projection from another maintenance family
function unrelatedNativeSource() {
  const contentSha256 = sha256(Buffer.from("unrelated-native"));
  const bytes = encodeAdjustmentRevisionProjection({
    contractVersion: "adjustment-revision-projection/v1",
    family: "wind",
    logicalKey: {
      contentSha256: null,
      leadHours: 1,
      providerResponseSha256: null,
      runInitializedAt: null,
      siteId: null,
      sourceId: "7",
      sourceType: "forecast_anchor",
      validAt: VALID_AT,
    },
    logicalReceivedAt: "2026-10-11T19:59:00.000Z",
    projectionKind: "native_source",
    rows: [{
      apparentTemperatureC64: encodeMaintenanceBinary64(10),
      cloudCoverPercent64: encodeMaintenanceBinary64(50),
      contentSha256,
      leadHours: 1,
      precipitationMm64: encodeMaintenanceBinary64(2),
      pressureHpa64: encodeMaintenanceBinary64(1_000),
      relativeHumidityPercent64: encodeMaintenanceBinary64(80),
      temperatureC64: encodeMaintenanceBinary64(12),
      validAt: VALID_AT,
      windDirectionDegrees64: encodeMaintenanceBinary64(180),
      windGustMps64: encodeMaintenanceBinary64(8),
      windSpeedMps64: encodeMaintenanceBinary64(5),
    }],
    source: {
      adapterVersion: "unrelated-native/v1",
      contractEpoch: "unrelated-native/v1",
      dataset: "native",
      providerKey: "unrelated",
      sourceConfigFingerprint: B,
      sourceId: "7",
      sourceKey: "unrelated-native",
      sourceKind: "forecast",
      upstreamModel: "unrelated",
    },
    storedContentSha256: contentSha256,
  });
  return occurrence(bytes, 350, "2026-10-11T20:00:00.000Z");
}

// construct the authenticated historical index consumed by both planning phases
function history(occurrences) {
  return {
    catalog: { archiveCommitOrdinal: "1000", catalogRootSha256: A, frontierRootSha256: B },
    contractVersion: "adjustment-revision-historical-archive-index/v1",
    historyRootSha256: C,
    occurrences,
    pages: [],
    receiptCount: occurrences.reduce((count, item) => count + item.receipts.length, 0),
  };
}

// burn one exact unsupported snapshot after value-blind planning
function burn(plan, registration) {
  const unsigned = {
    ...registration,
    accessState: "burned",
    accessedAt: registration.terminalAccessAt,
    expectedKeySetSha256: plan.expectedKeySetSha256,
    revisionCatalogWatermarkSha256: plan.revisionCatalogWatermarkSha256,
    targetComparatorSnapshotRootSha256: plan.snapshotRootSha256,
    targetCutoffAt: plan.targetCutoffAt,
  };
  return { ...unsigned, accessSha256: sha256(canonicalJsonBytes(unsigned)) };
}

// execute one value opening only through a verified owner-burn-shaped snapshot
function assembleFixture({ actualBestMatchOccurrences, controlOptions = {}, extraOccurrences = [],
  targetOccurrences } = {}) {
  const witness = rainHistoryEpochWitness();
  const { confirmation, shadow } = registrations(witness);
  const capsule = rainCapsule(shadow);
  const control = rainControl(capsule, controlOptions);
  const actualBestMatches = actualBestMatchOccurrences ?? [rainBestMatch()];
  const targets = targetOccurrences ?? [rainHistoryTargetOccurrence({ ordinal: 500 })];
  const archive = history([
    capsule.occurrence, control, ...actualBestMatches, ...targets, ...extraOccurrences,
  ]);
  const due = {
    dueKey: "daily/2027-09-19",
    family: null,
    mode: "daily",
    originalCutoffAt: TARGET_CUTOFF_AT,
    scope: "daily",
  };
  const plan = planAdjustmentMaintenanceUnsupportedDailyConfirmation({
    confirmationRegistration: confirmation,
    due,
    epochWitness: witness,
    history: archive,
    shadowRegistration: shadow,
  });
  return {
    actualBestMatch: actualBestMatches[0],
    capsule,
    control,
    result: assembleAdjustmentRainUnsupportedDailyConfirmation({
      access: burn(plan, confirmation),
      confirmationRegistration: confirmation,
      due,
      epochWitness: witness,
      history: archive,
      plan,
      shadowRegistration: shadow,
    }),
  };
}

test("rain confirmation joins genuine capsule, control and first fixed-gauge target", () => {
  const actualBestMatch = rainBestMatch();
  const laterBestMatch = rainBestMatch({
    ordinal: 169,
    precipitationMm: 4,
    receiptAt: "2026-10-11T12:07:00.000Z",
  });
  const target = rainHistoryTargetOccurrence({ ordinal: 500 });
  const laterTarget = rainHistoryTargetOccurrence({
    completedAt: "2026-10-12T07:11:00.000Z",
    ordinal: 700,
    receiptAt: "2026-10-12T07:16:00.000Z",
  });
  const { capsule, control, result } = assembleFixture({
    actualBestMatchOccurrences: [laterBestMatch, actualBestMatch],
    extraOccurrences: [unrelatedPhysicalTarget(), unrelatedNativeSource()],
    targetOccurrences: [laterTarget, target],
  });
  const record = result.chunks.flatMap((chunk) => {
    const payload = JSON.parse(Buffer.from(chunk.payloadBase64, "base64").toString("utf8"));
    return payload.records;
  })[0];

  assert.notEqual(record, undefined);
  assert.equal(record.rowIndex, 10);
  assert.equal(record.comparison.runKey, `${RUN_AT}/${VALID_AT}`);
  assert.equal(record.comparison.actualBestMatchPrediction, 1.25);
  assert.notEqual(record.comparison.actualBestMatchPrediction,
    record.comparison.incumbentPrediction);
  assert.equal(record.comparison.target > 0, true);
  assert.equal(record.comparison.membership.actualBestMatchProjectionSha256,
    actualBestMatch.payloadIdentitySha256);
  assert.notEqual(record.comparison.membership.actualBestMatchProjectionSha256,
    control.payloadIdentitySha256);
  assert.equal(record.comparison.membership.rainGateProjectionSha256,
    control.payloadIdentitySha256);
  assert.equal(result.terminalGraph.bindings[0].nativeSource.receiptSha256,
    capsule.occurrence.receipts[0].receiptSha256);
  assert.equal(result.terminalGraph.bindings[0].target.sourceMemberSha256s.length, 12);
  assert.equal(result.terminalGraph.bindings[0].target.targetMemberSha256,
    target.payloadIdentitySha256);
  assert.match(result.rainGateInputMemberSha256s[0], /^[a-f0-9]{64}$/u);
  const classes = buildAdjustmentMaintenanceInputClassMembers({
    artifactSha256: A,
    candidateSha256: B,
    family: "rain",
    rainGateInputMemberSha256s: result.rainGateInputMemberSha256s,
    terminalGraph: result.terminalGraph,
  });
  assert.equal(Object.keys(classes).length, 10);
  assert.equal(Object.values(classes).every((members) => members.length > 0), true);
  assert.notDeepEqual(classes.actual_best_match, classes.rain_gate_input);
});

test("rain confirmation refuses mismatched source tuples and late control receipts", () => {
  const mismatch = assembleFixture({
    controlOptions: { sourceId: "different-forecast" },
  }).result;
  assert.equal(mismatch.terminalGraph.bindings.length, 0);
  assert.equal(mismatch.rainGateInputMemberSha256s.length, 0);
  assert.throws(() => assembleFixture({
    controlOptions: { receiptAt: VALID_AT },
  }), /pre-target/u);
});

test("rain confirmation refuses wrong-kind, wrong-source and post-decision Best Match revisions", () => {
  const wrongKind = assembleFixture({
    actualBestMatchOccurrences: [unrelatedPhysicalTarget()],
  }).result;
  assert.equal(wrongKind.terminalGraph.bindings.length, 0);
  const wrongSource = assembleFixture({
    actualBestMatchOccurrences: [rainBestMatch({ sourceKey: "other-forecast" })],
  }).result;
  assert.equal(wrongSource.terminalGraph.bindings.length, 0);
  const futureReceipt = assembleFixture({
    actualBestMatchOccurrences: [rainBestMatch({
      receiptAt: "2026-10-11T20:03:45.000Z",
    })],
  }).result;
  assert.equal(futureReceipt.terminalGraph.bindings.length, 0);
  const malformedReceipt = rainBestMatch();
  malformedReceipt.receipts[18].projectionKind = "rain_gate_input";
  assert.throws(() => assembleFixture({
    actualBestMatchOccurrences: [malformedReceipt],
  }), /receipt binding differs/u);
});

test("full 334-day rain geometry closes missing history as unsupported under the same burn", () => {
  const { result } = assembleFixture();

  assert.equal(result.state, "burned_unsupported");
  assert.equal(result.missingKeyCount > 30_000, true);
  assert.equal(result.chunks.reduce((count, chunk) =>
    count + chunk.metadata.recordCount, 0), 1);
  assert.equal(new Set(result.chunks.map((chunk) => chunk.metadata.logicalChunkIndex)).size, 24);
  assert.equal(result.rainGateInputMemberSha256s.length, 1);
  assert.equal(result.terminalGraph.bindings.length, 1);
  assert.equal(result.terminalGraph.graphManifestSha256s.length, 4);
  assert.equal(result.terminalGraph.derivedTargetMemberSha256s.length, 1);
});
