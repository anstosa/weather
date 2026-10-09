import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  encodeAdjustmentRevisionProjection,
  encodeMaintenanceBinary64,
} from "../../packages/forecast-adjustment/dist/index.js";
import {
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
} from "./adjustment-maintenance-runtime/node_modules/@weather/domain/dist/forecast-adjustment.js";
import {
  canonicalJsonBytes,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  adjustmentTemperatureConfirmationSourceMatchesNative,
  assembleAdjustmentMaintenanceUnsupportedDailyConfirmation,
  buildAdjustmentMaintenanceDerivedTarget,
  planAdjustmentMaintenanceDailyConfirmation,
  planAdjustmentMaintenanceUnsupportedDailyConfirmation,
  parseAdjustmentMaintenanceDerivedTarget,
  validateAdjustmentMaintenanceConfirmationPlanGraph,
  validateAdjustmentMaintenanceUnsupportedPlanGraph,
} from "./adjustment_confirmation_values.mjs";
import {
  buildAdjustmentMaintenanceExpectedKeyPlanV3,
} from "./adjustment_daily_evaluation.mjs";

const EPOCH_AT = "2026-10-08T16:00:00.000Z";
const VALID_AT = "2026-10-09T18:00:00.000Z";

// hash exact test member bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// create one authenticated future-only epoch witness
function epochWitness() {
  const unsigned = {
    activationKind: "inert_v14_pre_activation",
    archiveCommitOrdinal: "0",
    catalogFrontierSha256: "5d932b9623819be9432877a513194158708719497d755155f5ed9a4b501b48af",
    contractVersion: "adjustment-revision-capture-epoch-witness/v1",
    controlPlaneSha256: "1".repeat(64),
    controlPlaneVersion: "14",
    databaseMigrationHistorySha256: "6de5c8c7efaa448aeb12bf1a9debe6fe7d4d4d1003ee0e21ab619ffa624c3424",
    epochAt: EPOCH_AT,
    servingSnapshotSha256: "2".repeat(64),
    sourceCommit: "3".repeat(40),
    sourceRelease: "2026.10.08-1",
    sourceServerImageDigest: `sha256:${"4".repeat(64)}`,
    sourceWebImageDigest: `sha256:${"5".repeat(64)}`,
  };
  return { ...unsigned, witnessSha256: sha256(canonicalJsonBytes(unsigned)) };
}

// create one authenticated target row occurrence
function targetOccurrence(sourceKey, sourceId, value, ordinal) {
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    // select one reviewed source identity
    (candidate) => candidate.sourceKey === sourceKey,
  );
  assert.notEqual(lineage, undefined);
  const contentSha256 = sha256(Buffer.from(`${sourceKey}\n${VALID_AT}\n`));
  const payloadBytes = encodeAdjustmentRevisionProjection({
    contractVersion: "adjustment-revision-projection/v1",
    family: "shared",
    logicalKey: {
      productRunAt: null,
      sourceId,
      sourceKind: "physical_sensor",
      validAt: VALID_AT,
    },
    logicalReceivedAt: "2026-10-09T18:05:00.000Z",
    projectionKind: "target_revision",
    rows: [{
      apparentTemperatureC64: encodeMaintenanceBinary64(value),
      blackGlobeTemperatureC64: null,
      cloudCoverPercent64: null,
      contentSha256,
      pm25MicrogramsPerCubicMeter64: null,
      precipitationMm64: null,
      precipitationRateMmPerHour64: null,
      pressureHpa64: null,
      relativeHumidityPercent64: null,
      soilElectricalConductivityMicrosiemensPerCm64: null,
      soilMoisturePercent64: null,
      solarRadiationWm264: null,
      temperatureC64: encodeMaintenanceBinary64(value),
      uvIndex64: null,
      validAt: VALID_AT,
      waterLevelM64: null,
      wetBulbGlobeTemperatureC64: null,
      windDirectionDegrees64: null,
      windGustMps64: encodeMaintenanceBinary64(value),
      windSpeedMps64: encodeMaintenanceBinary64(value),
    }],
    source: {
      adapterVersion: lineage.adapterContract,
      contractEpoch: "physical-observation/v1",
      dataset: "physical_observation",
      providerKey: lineage.physicalStationKey,
      sourceConfigFingerprint: lineage.checkedFingerprint,
      sourceId,
      sourceKey,
      sourceKind: "physical_sensor",
      upstreamModel: null,
    },
    storedContentSha256: contentSha256,
  });
  const payloadIdentitySha256 = sha256(payloadBytes);
  const receipt = {
    archiveCommitOrdinal: String(ordinal),
    archiveCommittedAt: `2026-10-09T18:${String(10 + ordinal).padStart(2, "0")}:00.000Z`,
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: "a".repeat(64),
    predecessorFrontierSha256: "b".repeat(64),
    projectionIdentitySha256: payloadIdentitySha256,
    projectionKind: "target_revision",
    projectionSha256: payloadIdentitySha256,
    receiptSha256: sha256(Buffer.from(`receipt-${ordinal}`)),
    stageReceiptSha256: "c".repeat(64),
  };
  return {
    graphManifestSha256: sha256(Buffer.from(`graph-${ordinal}`)),
    pageSha256: sha256(Buffer.from(`page-${ordinal}`)),
    payloadBytes,
    payloadIdentitySha256,
    payloadKind: "adjustment-revision-projection/v1",
    publicationDisposition: "published",
    receipts: [receipt],
  };
}

test("derived target binds the frozen regional recipe to every cold row", () => {
  const occurrences = [
    targetOccurrence("ambient-merlin-observations-v1", "1", 10, 1),
    targetOccurrence("tempest-225947-observations-v2", "2", 20, 2),
    targetOccurrence("tempest-64255-observations-v2", "3", 30, 3),
  ];
  const result = buildAdjustmentMaintenanceDerivedTarget({
    epochWitness: epochWitness(),
    family: "temperature",
    metric: "temperatureC",
    occurrences,
    targetCutoffAt: "2026-10-10T00:00:00.000Z",
    validAt: VALID_AT,
  });

  assert.equal(result.state, "complete");
  assert.equal(result.value.contractVersion, "adjustment-maintenance-derived-target/v1");
  assert.equal(result.value.rows.length, 3);
  assert.equal(result.value.firstEdgeCommittedAt, "2026-10-09T18:13:00.000Z");
  assert.equal(result.targetMemberSha256, sha256(result.bytes));
  assert.deepEqual(parseAdjustmentMaintenanceDerivedTarget(result.bytes), result.value);
  assert.deepEqual(result.graphManifestSha256s, [...result.graphManifestSha256s].sort());
  assert.equal(result.requiredMemberIdentitySha256s.length, 9);
});

test("derived target reports genuine coverage gaps without a substituted value", () => {
  const result = buildAdjustmentMaintenanceDerivedTarget({
    epochWitness: epochWitness(),
    family: "wind",
    metric: "windSpeedMps",
    occurrences: [targetOccurrence("ambient-merlin-observations-v1", "1", 10, 1)],
    targetCutoffAt: "2026-10-10T00:00:00.000Z",
    validAt: VALID_AT,
  });

  assert.deepEqual(Object.keys(result).sort(), ["missingStationKeys", "reason", "state"]);
  assert.equal(result.reason, "target_unavailable");
  assert.equal(result.state, "pending");
  assert.ok(result.missingStationKeys.includes("tempest-64255"));
});

test("derived target rejects a tampered projected row identity", () => {
  const result = buildAdjustmentMaintenanceDerivedTarget({
    epochWitness: epochWitness(),
    family: "temperature",
    metric: "temperatureC",
    occurrences: [
      targetOccurrence("ambient-merlin-observations-v1", "1", 10, 1),
      targetOccurrence("tempest-225947-observations-v2", "2", 20, 2),
      targetOccurrence("tempest-64255-observations-v2", "3", 30, 3),
    ],
    targetCutoffAt: "2026-10-10T00:00:00.000Z",
    validAt: VALID_AT,
  });
  const tampered = JSON.parse(result.bytes.toString("utf8"));
  tampered.rows[0].memberSha256 = "f".repeat(64);

  assert.throws(
    () => parseAdjustmentMaintenanceDerivedTarget(Buffer.from(canonicalJsonBytes(tampered))),
    /row identity differs/u,
  );
});

test("confirmation planning stays value-blind when one expected capsule is absent", () => {
  const witness = epochWitness();
  const intervalStartAt = "2026-10-09T07:00:00.000Z";
  const intervalEndAt = "2027-10-10T07:00:00.000Z";
  const expected = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: "temperature",
    intervalEndAt,
    intervalStartAt,
  });
  const shadowUnsigned = {
    artifactSha256: "1".repeat(64),
    candidateSha256: "2".repeat(64),
    cohortSha256: "3".repeat(64),
    epochWitnessSha256: witness.witnessSha256,
    family: "temperature",
    intervalEndAt,
    intervalStartAt,
    policySha256: "4".repeat(64),
    predecessorRegistrationSha256: null,
    reservedKeySha256: expected.reservedKeySha256,
    scheduleContractSha256: "5".repeat(64),
    siteKey: "ballydidean",
    sourceSha256: "6".repeat(64),
    targetCutoffAt: "2027-10-17T07:00:00.000Z",
    terminalAt: "2027-10-18T07:00:00.000Z",
  };
  const registrationSha256 = sha256(Buffer.from(`${[
    "adjustment-shadow-registration/v3", shadowUnsigned.siteKey, shadowUnsigned.family,
    shadowUnsigned.candidateSha256, shadowUnsigned.artifactSha256, shadowUnsigned.policySha256,
    shadowUnsigned.cohortSha256, shadowUnsigned.reservedKeySha256, shadowUnsigned.sourceSha256,
    shadowUnsigned.epochWitnessSha256, shadowUnsigned.scheduleContractSha256, "none",
    shadowUnsigned.intervalStartAt, shadowUnsigned.intervalEndAt, shadowUnsigned.targetCutoffAt,
    shadowUnsigned.terminalAt,
  ].join("\n")}\n`));
  const shadowRegistration = { ...shadowUnsigned, registrationSha256 };
  const confirmationRegistration = {
    candidateSha256: shadowUnsigned.candidateSha256,
    family: "temperature",
    intervalEndExclusiveLocalDate: "2027-10-10",
    intervalStartLocalDate: "2026-10-09",
    registrationSha256: "7".repeat(64),
    reservedKeySha256: expected.reservedKeySha256,
    sourceLineageSha256: shadowUnsigned.sourceSha256,
    terminalAccessAt: shadowUnsigned.terminalAt,
  };
  const occurrence = targetOccurrence("ambient-merlin-observations-v1", "1", 10, 1);
  const result = planAdjustmentMaintenanceDailyConfirmation({
    confirmationRegistration,
    due: {
      dueKey: "daily/2027-10-18",
      family: null,
      mode: "daily",
      originalCutoffAt: "2027-10-19T07:00:00.000Z",
      scope: "daily",
    },
    epochWitness: witness,
    history: {
      catalog: {
        archiveCommitOrdinal: "1",
        catalogRootSha256: "8".repeat(64),
        frontierRootSha256: "9".repeat(64),
      },
      contractVersion: "adjustment-revision-historical-archive-index/v1",
      historyRootSha256: "a".repeat(64),
      occurrences: [occurrence],
      pages: [],
      receiptCount: 1,
    },
    shadowRegistration,
  });
  assert.deepEqual(result, {
    family: "temperature",
    reason: "history_unavailable",
    registrationSha256: confirmationRegistration.registrationSha256,
    state: "pending",
  });

  const unsupportedPlan = planAdjustmentMaintenanceUnsupportedDailyConfirmation({
    confirmationRegistration,
    due: {
      dueKey: "daily/2027-10-18",
      family: null,
      mode: "daily",
      originalCutoffAt: "2027-10-19T07:00:00.000Z",
      scope: "daily",
    },
    epochWitness: witness,
    history: {
      catalog: {
        archiveCommitOrdinal: "1",
        catalogRootSha256: "8".repeat(64),
        frontierRootSha256: "9".repeat(64),
      },
      contractVersion: "adjustment-revision-historical-archive-index/v1",
      historyRootSha256: "a".repeat(64),
      occurrences: [occurrence],
      pages: [],
      receiptCount: 1,
    },
    shadowRegistration,
  });
  assert.equal(unsupportedPlan.state, "unsupported_planned");
  assert.equal(unsupportedPlan.planGraph.entries.length, 0);
  assert.ok(unsupportedPlan.missingDueKeyCount > 0);
  assert.deepEqual(validateAdjustmentMaintenanceUnsupportedPlanGraph(
    unsupportedPlan.planGraph,
  ), unsupportedPlan.planGraph);
  const accessUnsigned = {
    accessState: "burned",
    accessedAt: confirmationRegistration.terminalAccessAt,
    expectedKeySetSha256: unsupportedPlan.expectedKeySetSha256,
    family: confirmationRegistration.family,
    registrationSha256: confirmationRegistration.registrationSha256,
    revisionCatalogWatermarkSha256: unsupportedPlan.revisionCatalogWatermarkSha256,
    targetComparatorSnapshotRootSha256: unsupportedPlan.snapshotRootSha256,
    targetCutoffAt: unsupportedPlan.targetCutoffAt,
  };
  const assembled = assembleAdjustmentMaintenanceUnsupportedDailyConfirmation({
    access: { ...accessUnsigned, accessSha256: sha256(canonicalJsonBytes(accessUnsigned)) },
    confirmationRegistration,
    due: {
      dueKey: "daily/2027-10-18",
      family: null,
      mode: "daily",
      originalCutoffAt: "2027-10-19T07:00:00.000Z",
      scope: "daily",
    },
    epochWitness: witness,
    history: {
      catalog: {
        archiveCommitOrdinal: "1",
        catalogRootSha256: "8".repeat(64),
        frontierRootSha256: "9".repeat(64),
      },
      contractVersion: "adjustment-revision-historical-archive-index/v1",
      historyRootSha256: "a".repeat(64),
      occurrences: [occurrence],
      pages: [],
      receiptCount: 1,
    },
    plan: unsupportedPlan,
    shadowRegistration,
  });
  assert.equal(assembled.state, "burned_unsupported");
  assert.equal(assembled.missingKeyCount, unsupportedPlan.entryCount);
  assert.equal("fullManifest" in assembled, false);
  assert.equal(assembled.chunks.length > 27, true);
});

test("confirmation plan graph binds every value-blind capsule member to its cold graph", () => {
  const entries = [{
    comparatorMemberSha256: "1".repeat(64),
    dueKey: "capture/2026-10-09T00:35:00.000Z",
    graphManifestSha256: "2".repeat(64),
    payloadIdentitySha256: "3".repeat(64),
    predictionBodySha256: "4".repeat(64),
    receiptSha256: "5".repeat(64),
    sourceProjectionSha256: "6".repeat(64),
    sourceReceiptSha256: "7".repeat(64),
  }];
  const unsigned = {
    contractVersion: "adjustment-maintenance-confirmation-plan-graph/v1",
    eligiblePredictionSetSha256: sha256(canonicalJsonBytes(entries)),
    entries,
    family: "temperature",
    registrationSha256: "8".repeat(64),
  };
  const graph = { ...unsigned, planGraphSha256: sha256(canonicalJsonBytes(unsigned)) };

  assert.deepEqual(validateAdjustmentMaintenanceConfirmationPlanGraph(graph), graph);
  assert.throws(() => validateAdjustmentMaintenanceConfirmationPlanGraph({
    ...graph,
    entries: [{ ...entries[0], predictionBodySha256: "9".repeat(64) }],
  }), /hash differs/u);
});

// raw hourly hashes do not replace run-level causal source custody
test("temperature confirmation crossbinds the entire native decision and comparator tuple", () => {
  const row = {
    adapterVersion: "open-meteo-ecmwf-single-run/v1",
    bestMatchContentSha256: "a".repeat(64),
    bestMatchProductRunAt: "2026-10-09T12:00:00.000Z",
    bestMatchSourceId: "7",
    bestMatchTemperatureC64: encodeMaintenanceBinary64(12),
    contentSha256: "b".repeat(64), dataset: "single_run", modelCycle: "50r1",
    modelLeadHours: 7, providerKey: "open-meteo", providerResponseSha256: "c".repeat(64),
    rawRelativeHumidityPercent64: encodeMaintenanceBinary64(80),
    rawTemperatureC64: encodeMaintenanceBinary64(11), rawWindSpeedMps64: encodeMaintenanceBinary64(5),
    referenceAt: "2026-10-09T06:00:00.000Z", upstreamModel: "ecmwf_ifs",
    validAt: "2026-10-09T13:00:00.000Z",
  };
  const source = { issuedAt: "2026-10-09T12:35:00.000Z", recentErrorState: { b24C: 0.2 } };
  const nativeMember = {
    document: {
      contractVersion: "adjustment-temperature-native-source-projection/v2",
      logicalKey: { providerResponseSha256: row.providerResponseSha256, runInitializedAt: row.referenceAt },
      logicalReceivedAt: "2026-10-09T12:30:00.000Z", recentErrorState: source.recentErrorState,
      source: { adapterVersion: row.adapterVersion, dataset: row.dataset,
        providerKey: row.providerKey, upstreamModel: row.upstreamModel },
    },
    row: { ...row },
  };
  const actualMember = {
    document: { logicalKey: { sourceId: row.bestMatchSourceId, productRunAt: row.bestMatchProductRunAt },
      logicalReceivedAt: "2026-10-09T12:20:00.000Z" },
    row: { contentSha256: row.bestMatchContentSha256, temperatureC64: row.bestMatchTemperatureC64,
      validAt: row.validAt },
  };
  const input = { actualMember, nativeMember, source, sourceRow: row };
  assert.equal(adjustmentTemperatureConfirmationSourceMatchesNative(input), true);
  for (const mutate of [
    // preserve hourly content while forging a different provider response
    (value) => { value.sourceRow.providerResponseSha256 = "d".repeat(64); },
    // preserve raw values while forging a different model cycle
    (value) => { value.sourceRow.modelCycle = "49r1"; },
    // preserve the same run while forging candidate-consumed rolling state
    (value) => { value.source.recentErrorState = { b24C: 0.3 }; },
    // preserve comparator content while forging its source identity
    (value) => { value.sourceRow.bestMatchSourceId = "8"; },
    // preserve comparator content while forging its initialization clock
    (value) => { value.actualMember.document.logicalKey.productRunAt = "2026-10-09T06:00:00.000Z"; },
    // refuse source availability after the frozen prediction
    (value) => { value.actualMember.document.logicalReceivedAt = "2026-10-09T12:36:00.000Z"; },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    assert.equal(adjustmentTemperatureConfirmationSourceMatchesNative(changed), false);
  }
});
