import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildAdjustmentMaintenanceEvaluationChunk,
  buildAdjustmentMaintenanceEvaluationChunkV2,
  buildAdjustmentMaintenanceEvaluationChunkV3,
  buildAdjustmentMaintenanceExpectedKeyPlanV3,
  evaluateAdjustmentMaintenanceDaily,
} from "./adjustment_daily_evaluation.mjs";
import {
  evaluateForecastAdjustmentMaintenanceNativeCandidate,
  buildForecastAdjustmentMaintenancePortableCandidate,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  assembleConfirmationManifest,
} from "./adjustment_maintenance_state.mjs";
import {
  canonicalJsonBytes,
  createMaintenanceShadowPredictionMetadata,
  createMaintenanceShadowSourceIdentity,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowSourceProjection,
  encodeMaintenanceShadowValues,
  MAINTENANCE_SHADOW_SOURCE_VERSION,
  MAINTENANCE_SHADOW_VALUES_VERSION,
} from "../../packages/forecast-adjustment/dist/index.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const EPOCH_AT = "2026-10-08T16:00:00.000Z";

// hash exact test fixture bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// create the authenticated v21 future-only witness
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

// load one genuine selected temperature fit
async function temperatureFitBytes() {
  const incumbent = JSON.parse(await readFile(
    new URL("../../config/forecast-adjustments/ballydidean/temperature-canary-bundles/" +
      "sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json",
    import.meta.url),
    "utf8",
  ));
  return Buffer.from(canonicalJsonBytes({
    arms: {},
    confirmationOpened: false,
    contractVersion: "temperature-maintenance-fit/v2",
    developmentIncumbentMae: 1,
    developmentRawMae: 2,
    dueMonth: "2026-10",
    model: incumbent.model,
    selectedArm: "month_start_expanding",
    servingChanged: false,
    state: "development_candidate",
  }));
}

// derive one v3 registration with its frozen final-lf hash
function shadowRegistration(portable, witness, reservedKeySha256 = HASH_C) {
  const registration = {
    artifactSha256: portable.artifactSha256,
    candidateSha256: portable.candidateSha256,
    cohortSha256: HASH_A,
    epochWitnessSha256: witness.witnessSha256,
    family: "temperature",
    intervalEndAt: "2027-10-10T07:00:00.000Z",
    intervalStartAt: "2026-10-09T07:00:00.000Z",
    policySha256: HASH_B,
    predecessorRegistrationSha256: null,
    registrationSha256: "",
    reservedKeySha256,
    scheduleContractSha256: "ca29db99377001fca2e2e4268fd80d1cbe7b876f71f2d5ba04e575712cb9f13b",
    siteKey: "ballydidean",
    sourceSha256: portable.sourceIdentitySha256,
    targetCutoffAt: "2027-10-16T07:00:00.000Z",
    terminalAt: "2027-10-17T07:00:00.000Z",
  };
  registration.registrationSha256 = sha256(Buffer.from(`${[
    "adjustment-shadow-registration/v3", registration.siteKey, registration.family,
    registration.candidateSha256, registration.artifactSha256, registration.policySha256,
    registration.cohortSha256, registration.reservedKeySha256, registration.sourceSha256,
    registration.epochWitnessSha256, registration.scheduleContractSha256, "none",
    registration.intervalStartAt, registration.intervalEndAt, registration.targetCutoffAt,
    registration.terminalAt,
  ].join("\n")}\n`));
  return registration;
}

// create the full append-only lifecycle registration projection
function confirmationRegistration(shadow) {
  const registration = {
    accessState: "registered",
    actionIdentitySha256: null,
    actionState: "none",
    candidateKind: "temperature-delayed-mos/v1",
    candidateReportSha256: null,
    candidateSha256: shadow.candidateSha256,
    cohortLineageSha256: shadow.cohortSha256,
    contractVersion: "forecast-adjustment-lifecycle-ledger/v2",
    family: "temperature",
    firstTargetAt: "2026-10-09T14:00:00.000Z",
    gateManifestSha256: shadow.policySha256,
    inputHeadSha256: HASH_A,
    intervalEndExclusiveLocalDate: "2027-10-10",
    intervalStartLocalDate: "2026-10-09",
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
    // reproduce the journal identity projection
    (field) => [field, registration[field]],
  ));
  registration.registrationSha256 = sha256(canonicalJsonBytes(unsigned));
  return registration;
}

// burn one immutable snapshot at the terminal clock
function confirmationAccess(registration, shadow, expectedKeySetSha256 = null) {
  const expectedKey =
    "capture/2026-10-09T12:35:00.000Z/2026-10-09T14:00:00.000Z/temperature";
  const unsigned = {
    ...registration,
    accessState: "burned",
    accessedAt: shadow.terminalAt,
    expectedKeySetSha256: expectedKeySetSha256 ?? sha256(canonicalJsonBytes([expectedKey])),
    revisionCatalogWatermarkSha256: HASH_B,
    targetComparatorSnapshotRootSha256: HASH_C,
    targetCutoffAt: shadow.targetCutoffAt,
  };
  return { ...unsigned, accessSha256: sha256(canonicalJsonBytes(unsigned)) };
}

// build one complete source and archived body from the real native evaluator
function temperatureCapsule(candidateBytes, shadow) {
  const issuedAt = "2026-10-09T13:35:00.000Z";
  const receivedAt = "2026-10-09T13:30:00.000Z";
  const referenceAt = "2026-10-09T06:00:00.000Z";
  const source = {
    candidateSha256: shadow.candidateSha256,
    contractVersion: MAINTENANCE_SHADOW_SOURCE_VERSION,
    dueKey: "capture/2026-10-09T12:35:00.000Z",
    family: "temperature",
    issuedAt,
    recentErrorState: {
      b24C: 0.8,
      b72C: 0.3,
      cohort: "ecmwf_single_run_hindcast",
      localDates: 1,
      mad72C: 0.4,
      maximumSourceRunInitializedAt: "2026-10-09T06:00:00.000Z",
      maximumSourceValidAt: "2026-10-09T12:00:00.000Z",
      n24: 12,
      n72: 50,
      sourceKeys: Array.from({ length: 50 },
        // retain a bounded genuine recent-error source population
        (_unused, index) => `source-${index}`),
      supported: true,
      targetRunInitializedAt: referenceAt,
      windowEndValidAt: "2026-10-09T12:00:00.000Z",
    },
    registrationSha256: shadow.registrationSha256,
    rowCount: 12,
    rows: Array.from({ length: 12 },
      // retain every one-based operational temperature lead
      (_unused, index) => {
        const modelLeadHours = index + 8;
        return {
          adapterVersion: "open-meteo-ecmwf-single-run/v1",
          bestMatchContentSha256: HASH_B,
          bestMatchProductRunAt: referenceAt,
          bestMatchSourceId: "7",
          bestMatchTemperatureC64: encodeMaintenanceBinary64(17.2 + index / 10),
          contentSha256: sha256(Buffer.from(`temperature-${index}`)),
          dataset: "single_run",
          leadHours: index + 1,
          modelCycle: "50r1",
          modelLeadHours,
          providerKey: "open-meteo",
          providerResponseSha256: HASH_A,
          rawRelativeHumidityPercent64: encodeMaintenanceBinary64(78),
          rawTemperatureC64: encodeMaintenanceBinary64(16.4 + index / 10),
          rawWindSpeedMps64: encodeMaintenanceBinary64(3.2),
          receivedAt,
          referenceAt,
          sourceSha256: shadow.sourceSha256,
          upstreamModel: "ecmwf_ifs",
          validAt: new Date(Date.parse(referenceAt) + modelLeadHours * 3_600_000).toISOString(),
        };
      }),
    sourceSha256: shadow.sourceSha256,
  };
  const sourceBytes = encodeMaintenanceShadowSourceProjection(source);
  const identity = createMaintenanceShadowSourceIdentity(sourceBytes);
  const rows = source.rows.map(
    // replay the actual fit before freezing each public prediction row
    (row, index) => {
      const decision = JSON.parse(evaluateForecastAdjustmentMaintenanceNativeCandidate({
        candidateBytes,
        family: "temperature",
        input: {
          evaluatedAt: issuedAt,
          rawBestMatchTemperatureC: 17.2 + index / 10,
          recentErrorState: source.recentErrorState,
          sourceForecast: {
            adapterVersion: row.adapterVersion,
            dataset: "single_run",
            firstReceivedAt: row.receivedAt,
            modelCycle: row.modelCycle,
            modelLeadHours: row.modelLeadHours,
            providerKey: "open-meteo",
            providerResponseSha256: row.providerResponseSha256,
            rawRelativeHumidityPercent: 78,
            rawTemperatureC: 16.4 + index / 10,
            rawWindSpeedMps: 3.2,
            runInitializedAt: row.referenceAt,
            upstreamModel: "ecmwf_ifs",
            validAt: row.validAt,
          },
          validAt: row.validAt,
        },
      }).toString("utf8"));
      const applied = decision.state === "active" && decision.correctedTemperatureC !== null;
      return {
        candidateTemperatureC64: encodeMaintenanceBinary64(
          applied ? decision.correctedTemperatureC : 17.2 + index / 10,
        ),
        fallbackCode: applied ? "none" : "ineligible",
        leadHours: index + 1,
        sourceRowSha256: identity.sourceRowSha256[index],
        validAt: row.validAt,
        wouldApply: applied,
      };
    },
  );
  const bodyBytes = encodeMaintenanceShadowValues({
    candidateSha256: shadow.candidateSha256,
    contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION,
    dueKey: source.dueKey,
    family: "temperature",
    inputSha256: identity.inputSha256,
    issuedAt,
    registrationSha256: shadow.registrationSha256,
    rowCount: 12,
    rows,
    sourceReceiptSha256: identity.sourceReceiptSha256,
    sourceSha256: shadow.sourceSha256,
  }, sourceBytes);
  return buildCapsule(bodyBytes, sourceBytes);
}

// wrap one source/body pair in the exact durable shadow capsule grammar
function buildCapsule(bodyBytes, sourceBytes) {
  const metadata = createMaintenanceShadowPredictionMetadata(bodyBytes, sourceBytes);
  const sourceProjectionSha256 = sha256(sourceBytes);
  const stageUnsigned = {
    contractVersion: "adjustment-shadow-stage-receipt/v1",
    durable: true,
    durableAt: "2026-10-09T13:36:00.000Z",
    dueKey: metadata.dueKey,
    predictionBodySha256: metadata.predictionBodySha256,
    registrationSha256: metadata.registrationSha256,
    sourceProjectionSha256,
  };
  const stageReceipt = {
    ...stageUnsigned,
    stageReceiptSha256: sha256(Buffer.from(`${JSON.stringify(stageUnsigned)}\n`)),
  };
  const predecessorFrontierSha256 = sha256(Buffer.from("adjustment-revision-frontier/v1\n0\n"));
  const revisionReceipt = {
    archiveCommitOrdinal: "1",
    archiveCommittedAt: "2026-10-09T13:37:00.000Z",
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
  return Buffer.from(canonicalJsonBytes({
    bodyBase64: bodyBytes.toString("base64"),
    contractVersion: "adjustment-shadow-revision-capsule/v1",
    metadata,
    revisionReceipt,
    sourceProjectionBase64: sourceBytes.toString("base64"),
    sourceProjectionSha256,
    stageReceipt,
  }));
}

// advance one local-date fixture without timezone ambiguity
function addDate(localDate, days) {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString().slice(0, 10);
}

// build all twenty-seven blinded chunks and one real value-bearing record
function confirmationChunks(capsuleBytes, confirmation, shadow, version = "v1") {
  const membership = version === "v2"
    ? {
        actualBestMatchProjectionSha256: "1".repeat(64),
        actualBestMatchReceiptSha256: "2".repeat(64),
        incumbentMemberSha256: "3".repeat(64),
        nativeSourceProjectionSha256: "4".repeat(64),
        nativeSourceReceiptSha256: "5".repeat(64),
        targetMemberSha256: HASH_A,
      }
    : {
        actualBestMatchProjectionSha256: "1".repeat(64),
        actualBestMatchReceiptSha256: "2".repeat(64),
        incumbentMemberSha256: "3".repeat(64),
        nativeSourceProjectionSha256: "4".repeat(64),
        nativeSourceReceiptSha256: "5".repeat(64),
        targetProjectionSha256: "6".repeat(64),
        targetReceiptSha256: "7".repeat(64),
        targetRowSha256: HASH_A,
      };
  const record = {
    capsuleBase64: capsuleBytes.toString("base64"),
    comparison: {
      farmTarget: null,
      firstEdgeCommittedAt: "2026-10-09T13:38:00.000Z",
      incumbentPrediction: 17.1,
      membership,
      nearestThree: null,
      providerFamily: null,
      stationKey: null,
      target: 16.9,
    },
    key: "capture/2026-10-09T12:35:00.000Z/2026-10-09T14:00:00.000Z/temperature",
    metric: null,
    rowIndex: 0,
  };
  let current = confirmation.intervalStartLocalDate;
  return Array.from({ length: 27 },
    // retain exact fourteen-day partitions and the final two-day tail
    (_unused, index) => {
      const end = addDate(current, index === 26 ? 2 : 14);
      const records = index === 0 ? [record] : [];
      const builder = version === "v2"
        ? buildAdjustmentMaintenanceEvaluationChunkV2
        : buildAdjustmentMaintenanceEvaluationChunk;
      const entry = builder({
        chunkIndex: index,
        confirmationRegistrationSha256: confirmation.registrationSha256,
        family: "temperature",
        missingKeys: [],
        records,
        shadowRegistrationSha256: shadow.registrationSha256,
        fromLocalDate: current,
        toLocalDateExclusive: end,
      });
      current = end;
      return entry;
    });
}

// create one fully burned input with genuine candidate replay bytes
async function completeInput(version = "v1") {
  const witness = epochWitness();
  const candidateBytes = await temperatureFitBytes();
  const portable = buildForecastAdjustmentMaintenancePortableCandidate({
    candidateBytes,
    family: "temperature",
  });
  const shadow = shadowRegistration(portable, witness);
  const confirmation = confirmationRegistration(shadow);
  const access = confirmationAccess(confirmation, shadow);
  const capsuleBytes = temperatureCapsule(candidateBytes, shadow);
  const chunks = confirmationChunks(capsuleBytes, confirmation, shadow, version);
  const fullManifest = assembleConfirmationManifest({
    access,
    chunks: chunks.map(
      // project the blinded metadata consumed by the lifecycle journal
      (chunk) => chunk.metadata,
    ),
    registration: confirmation,
  });
  return {
    catalogInputManifestSha256: HASH_A,
    clockAt: "2027-10-17T07:01:00.000Z",
    due: {
      dueKey: "daily/2027-10-17",
      family: null,
      mode: "daily",
      originalCutoffAt: "2027-10-18T07:00:00.000Z",
      scope: "daily",
    },
    epochWitness: witness,
    lifecycle: {
      access,
      artifactBase64: portable.artifactBytes.toString("base64"),
      candidateBase64: candidateBytes.toString("base64"),
      chunks,
      confirmationRegistration: confirmation,
      fullManifest,
      shadowRegistration: shadow,
      state: "burned_complete",
    },
  };
}

// create one all-cycle v3 member with every unavailable fixture cell explicit
async function completePartedInput() {
  const witness = epochWitness();
  const candidateBytes = await temperatureFitBytes();
  const portable = buildForecastAdjustmentMaintenancePortableCandidate({
    candidateBytes,
    family: "temperature",
  });
  const plan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: "temperature",
    intervalEndAt: "2027-10-10T07:00:00.000Z",
    intervalStartAt: "2026-10-09T07:00:00.000Z",
  });
  const shadow = shadowRegistration(portable, witness, plan.reservedKeySha256);
  const confirmation = confirmationRegistration(shadow);
  const access = confirmationAccess(confirmation, shadow, plan.reservedKeySha256);
  const capsuleBytes = temperatureCapsule(candidateBytes, shadow);
  const seedPayload = JSON.parse(Buffer.from(
    confirmationChunks(capsuleBytes, confirmation, shadow, "v2")[0].payloadBase64,
    "base64",
  ).toString("utf8"));
  const body = JSON.parse(Buffer.from(
    JSON.parse(capsuleBytes.toString("utf8")).bodyBase64,
    "base64",
  ).toString("utf8"));
  const selectedKey = `${body.dueKey}/1/temperature`;
  const selectedRecord = {
    capsuleBase64: seedPayload.capsules[0].capsuleBase64,
    comparison: seedPayload.records[0].comparison,
    key: selectedKey,
    metric: null,
    rowIndex: 0,
  };
  const chunks = plan.logicalChunks.flatMap(
    // emit every pretarget part and mark only absent fixture cells missing
    (logical) => logical.parts.map((part) => buildAdjustmentMaintenanceEvaluationChunkV3({
      captureLocalDate: part.captureLocalDate,
      confirmationRegistrationSha256: confirmation.registrationSha256,
      family: "temperature",
      fromLocalDate: logical.fromLocalDate,
      logicalChunkIndex: logical.logicalChunkIndex,
      missingKeys: part.expectedKeys.filter(
        // retain every expected fixture cell except the one genuine archived record
        (key) => key !== selectedKey,
      ),
      partCount: part.partCount,
      partIndex: part.partIndex,
      records: part.expectedKeys.includes(selectedKey) ? [selectedRecord] : [],
      shadowRegistrationSha256: shadow.registrationSha256,
      toLocalDateExclusive: logical.toLocalDateExclusive,
    })),
  );
  const fullManifest = assembleConfirmationManifest({
    access,
    chunks: chunks.map(
      // project only blinded physical part metadata
      (chunk) => chunk.metadata,
    ),
    registration: confirmation,
  });
  return {
    catalogInputManifestSha256: HASH_A,
    clockAt: "2027-10-17T07:01:00.000Z",
    due: {
      dueKey: "daily/2027-10-17",
      family: null,
      mode: "daily",
      originalCutoffAt: "2027-10-18T07:00:00.000Z",
      scope: "daily",
    },
    epochWitness: witness,
    lifecycle: {
      access,
      artifactBase64: portable.artifactBytes.toString("base64"),
      candidateBase64: candidateBytes.toString("base64"),
      chunks,
      confirmationRegistration: confirmation,
      fullManifest,
      shadowRegistration: shadow,
      state: "burned_complete",
    },
  };
}

// preserve a deterministic pending state without parsing values
test("daily evaluation remains pending before a complete burned member", () => {
  const input = {
    catalogInputManifestSha256: HASH_A,
    clockAt: "2026-10-10T00:00:00.000Z",
    due: {
      dueKey: "daily/2026-10-09",
      family: null,
      mode: "daily",
      originalCutoffAt: "2026-10-10T07:00:00.000Z",
      scope: "daily",
    },
    epochWitness: epochWitness(),
    lifecycle: { family: "temperature", registrationSha256: null, state: "pending" },
  };
  const first = evaluateAdjustmentMaintenanceDaily(input);
  const second = evaluateAdjustmentMaintenanceDaily(input);
  assert.deepEqual(first, second);
  assert.equal(first.state, "pending");
  assert.equal(first.reason, "history_unavailable");
});

// preserve the frozen 27/27/24 confirmation partition ceilings
test("evaluation chunk builder enforces each family chunk count", () => {
  for (const [family, count] of [["temperature", 27], ["wind", 27], ["rain", 24]]) {
    const input = {
      chunkIndex: count - 1,
      confirmationRegistrationSha256: HASH_A,
      family,
      fromLocalDate: "2027-01-01",
      missingKeys: [],
      records: [],
      shadowRegistrationSha256: HASH_B,
      toLocalDateExclusive: "2027-01-02",
    };
    assert.equal(buildAdjustmentMaintenanceEvaluationChunk(input).metadata.chunkIndex, count - 1);
    const v2 = buildAdjustmentMaintenanceEvaluationChunkV2(input);
    assert.equal(JSON.parse(Buffer.from(v2.payloadBase64, "base64").toString("utf8"))
      .contractVersion, "adjustment-maintenance-evaluation-chunk/v2");
    assert.throws(
      () => buildAdjustmentMaintenanceEvaluationChunk({ ...input, chunkIndex: count }),
      /builder bounds differ/u,
    );
    const v3 = buildAdjustmentMaintenanceEvaluationChunkV3({
      captureLocalDate: "2027-01-01",
      confirmationRegistrationSha256: HASH_A,
      family,
      fromLocalDate: "2027-01-01",
      logicalChunkIndex: count - 1,
      missingKeys: ["missing-key"],
      partCount: 1,
      partIndex: 0,
      records: [],
      shadowRegistrationSha256: HASH_B,
      toLocalDateExclusive: "2027-01-02",
    });
    assert.equal(v3.metadata.contractVersion, "adjustment-confirmation-chunk-part/v3");
  }
});

// bind genuine rain diagnostics under the additive v3 contract
test("rain v3 comparison requires genuine best-match diagnostics without changing v2 bytes", () => {
  const membership = Object.fromEntries([
    "actualBestMatchProjectionSha256", "actualBestMatchReceiptSha256",
    "incumbentMemberSha256", "nativeSourceProjectionSha256", "nativeSourceReceiptSha256",
    "rainGateProjectionSha256", "rainGateReceiptSha256", "targetMemberSha256",
  ].map(
    // bind the closed comparison membership fields
    (field) => [field, HASH_A],
  ));
  const probability = { atLeast0_1: 0.8, atLeast1_0: 0.4, atLeast2_5: 0.2 };
  const comparison = {
    farmTarget: null,
    firstEdgeCommittedAt: "2027-01-01T12:00:00.000Z",
    incumbentPrediction: 2,
    incumbentProbability: probability,
    membership,
    nativeSourceProbability: probability,
    nearestThree: null,
    persistencePrediction: 1,
    providerFamily: null,
    rawTargetHourTemperatureC: 12,
    recentVolumeScalePrediction: 2,
    runKey: "2027-01-01T00:00:00.000Z",
    sameWindowVolumeScalePrediction: 2,
    stationKey: null,
    target: 3,
    unchangedOrdinalPrediction: 2,
    volumeScalePrediction: 2,
  };
  const record = {
    capsuleBase64: Buffer.from("{}\n").toString("base64"),
    comparison,
    key: "rain-cell",
    metric: null,
    rowIndex: 0,
  };
  const base = {
    confirmationRegistrationSha256: HASH_A,
    family: "rain",
    fromLocalDate: "2027-01-01",
    missingKeys: [],
    records: [record],
    shadowRegistrationSha256: HASH_B,
    toLocalDateExclusive: "2027-01-02",
  };
  const v2 = buildAdjustmentMaintenanceEvaluationChunkV2({ ...base, chunkIndex: 0 });
  const v3Input = {
    ...base,
    captureLocalDate: "2027-01-01",
    logicalChunkIndex: 0,
    partCount: 1,
    partIndex: 0,
  };
  assert.throws(() => buildAdjustmentMaintenanceEvaluationChunkV3(v3Input),
    /comparison fields differ/u);
  const actualBestMatchPrediction = 7;
  const v3 = buildAdjustmentMaintenanceEvaluationChunkV3({
    ...v3Input,
    records: [{ ...record, comparison: { ...comparison, actualBestMatchPrediction } }],
  });
  assert.equal(JSON.parse(Buffer.from(v3.payloadBase64, "base64")).records[0]
    .comparison.actualBestMatchPrediction, actualBestMatchPrediction);
  assert.equal(Object.hasOwn(JSON.parse(Buffer.from(v2.payloadBase64, "base64"))
    .records[0].comparison, "actualBestMatchPrediction"), false);

  // refuse missing, nonfinite and physically invalid best-match diagnostics
  for (const value of [null, Number.NaN, Number.POSITIVE_INFINITY, -1, 2_001]) {
    assert.throws(() => buildAdjustmentMaintenanceEvaluationChunkV3({
      ...v3Input,
      records: [{ ...record, comparison: { ...comparison, actualBestMatchPrediction: value } }],
    }), /actualBestMatchPrediction|actual best-match prediction/u);
  }
});

// preregister every all-cycle cell without reading any target or outcome
test("expected key plan retains all four cycles and bounded deterministic parts", () => {
  const plan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: "wind",
    intervalEndAt: "2028-09-01T07:00:00.000Z",
    intervalStartAt: "2027-09-01T07:00:00.000Z",
  });
  assert.equal(plan.contractVersion, "adjustment-maintenance-expected-key-plan/v3");
  assert.equal(plan.logicalChunkCount, 27);
  assert.equal(plan.logicalChunks.length, 27);
  assert.equal(plan.logicalChunks.reduce(
    // retain the complete 366-day four-cycle wind population
    (count, chunk) => count + chunk.expectedKeyCount,
    0,
  ), 456_768);
  assert.ok(plan.logicalChunks.every((chunk) => chunk.parts.every(
    // bind each physical part to one bounded capture-local date
    (part) => part.expectedKeyCount <= 1_248 && part.expectedKeyCount > 0,
  )));
  assert.equal(plan.reservedKeySha256, buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: "wind",
    intervalEndAt: "2028-09-01T07:00:00.000Z",
    intervalStartAt: "2027-09-01T07:00:00.000Z",
  }).reservedKeySha256);
  assert.equal(plan.logicalChunks.flatMap(
    // inspect only preregistered immutable keys
    (chunk) => chunk.parts.flatMap((part) => part.expectedKeys),
  ).some((key) => /\/(?:49|50|51|52|53|54|55|56|57|58|59|60|61|62|63|64|65|66|67|68|69|70|71|72)\/windGustMps$/u
    .test(key)), false);
});

// replay one complete hierarchical all-cycle member under 27 logical windows
test("daily evaluation accepts every bounded v3 part before logical finalization", async () => {
  const input = await completePartedInput();
  const result = evaluateAdjustmentMaintenanceDaily(input);
  assert.equal(result.state, "evaluated");
  assert.equal(result.rowCount, 1);
  assert.equal(input.lifecycle.fullManifest.contractVersion,
    "adjustment-confirmation-member/v3");
  assert.equal(input.lifecycle.fullManifest.chunkCount, 27);
  assert.ok(input.lifecycle.chunks.length > 27);
});

// replay one additive derived-target member without accepting v1 target aliases
test("daily evaluation accepts one uniform chunk-v2 derived-target population", async () => {
  const input = await completeInput("v2");
  const result = evaluateAdjustmentMaintenanceDaily(input);
  assert.equal(result.state, "evaluated");
  assert.equal(result.rowCount, 1);

  const firstPayload = JSON.parse(Buffer.from(
    input.lifecycle.chunks[0].payloadBase64,
    "base64",
  ).toString("utf8"));
  const capsuleBase64 = firstPayload.capsules[0].capsuleBase64;
  const repeated = buildAdjustmentMaintenanceEvaluationChunkV2({
    chunkIndex: 0,
    confirmationRegistrationSha256:
      input.lifecycle.confirmationRegistration.registrationSha256,
    family: "temperature",
    fromLocalDate: input.lifecycle.confirmationRegistration.intervalStartLocalDate,
    missingKeys: [],
    records: firstPayload.records.map(
      // restore the builder input while repeating one exact capsule under a second key
      (record) => ({ ...record, capsuleBase64, capsuleMemberSha256: undefined }),
    ).flatMap(
      // prove exact capsule bytes occupy only one table entry
      (record) => [{ ...record, key: "a" }, { ...record, key: "b" }],
    ).map(
      // remove the decoder-only member key from the closed builder input
      ({ capsuleMemberSha256: _unused, ...record }) => record,
    ),
    shadowRegistrationSha256: input.lifecycle.shadowRegistration.registrationSha256,
    toLocalDateExclusive: addDate(
      input.lifecycle.confirmationRegistration.intervalStartLocalDate,
      14,
    ),
  });
  const repeatedPayload = JSON.parse(Buffer.from(repeated.payloadBase64, "base64"));
  assert.equal(repeatedPayload.capsules.length, 1);
  assert.equal(repeatedPayload.records.length, 2);

  const mixed = await completeInput("v2");
  mixed.lifecycle.chunks[1] = (await completeInput("v1")).lifecycle.chunks[1];
  assert.throws(
    () => evaluateAdjustmentMaintenanceDaily(mixed),
    /chunk versions differ/u,
  );

  const changed = await completeInput("v2");
  const changedPayload = JSON.parse(Buffer.from(
    changed.lifecycle.chunks[0].payloadBase64,
    "base64",
  ).toString("utf8"));
  changedPayload.capsules[0].capsuleBase64 = Buffer.from("changed").toString("base64");
  const changedBytes = Buffer.from(canonicalJsonBytes(changedPayload));
  changed.lifecycle.chunks[0] = {
    metadata: {
      ...changed.lifecycle.chunks[0].metadata,
      chunkSha256: sha256(changedBytes),
    },
    payloadBase64: changedBytes.toString("base64"),
  };
  changed.lifecycle.fullManifest = assembleConfirmationManifest({
    access: changed.lifecycle.access,
    chunks: changed.lifecycle.chunks.map(
      // project only blinded metadata into the finalized member
      (chunk) => chunk.metadata,
    ),
    registration: changed.lifecycle.confirmationRegistration,
  });
  assert.throws(
    () => evaluateAdjustmentMaintenanceDaily(changed),
    /capsule member differs/u,
  );

  const padded = await completeInput("v2");
  const paddedPayload = JSON.parse(Buffer.from(
    padded.lifecycle.chunks[0].payloadBase64,
    "base64",
  ).toString("utf8"));
  const unusedBytes = Buffer.from(canonicalJsonBytes({ unused: true }));
  paddedPayload.capsules.push({
    capsuleBase64: unusedBytes.toString("base64"),
    capsuleMemberSha256: sha256(unusedBytes),
  });
  paddedPayload.capsules.sort(
    // preserve canonical member order while testing an unreferenced entry
    (left, right) => left.capsuleMemberSha256.localeCompare(right.capsuleMemberSha256),
  );
  const paddedBytes = Buffer.from(canonicalJsonBytes(paddedPayload));
  padded.lifecycle.chunks[0] = {
    metadata: {
      ...padded.lifecycle.chunks[0].metadata,
      chunkSha256: sha256(paddedBytes),
    },
    payloadBase64: paddedBytes.toString("base64"),
  };
  padded.lifecycle.fullManifest = assembleConfirmationManifest({
    access: padded.lifecycle.access,
    chunks: padded.lifecycle.chunks.map(
      // retain the newly blinded payload identity in the full manifest
      (chunk) => chunk.metadata,
    ),
    registration: padded.lifecycle.confirmationRegistration,
  });
  assert.throws(
    () => evaluateAdjustmentMaintenanceDaily(padded),
    /capsule member is unavailable/u,
  );
});

// score one actual archived capsule only after exact full-member assembly
test("daily evaluation replays native and packaged candidate bytes under all 27 chunks", async () => {
  const input = await completeInput();
  const result = evaluateAdjustmentMaintenanceDaily(input);
  assert.equal(result.state, "evaluated");
  assert.equal(result.family, "temperature");
  assert.equal(result.rowCount, 1);
  assert.equal(result.fullMemberRootSha256, input.lifecycle.fullManifest.fullMemberRootSha256);
  assert.notEqual(result.policy.state, "pass");
  assert.equal(sha256(Buffer.from(result.policyBytesBase64, "base64")), result.policyReportSha256);
  assert.equal(
    sha256(Buffer.from(result.candidateReportBase64, "base64")),
    result.candidateReportSha256,
  );
});

// reject partial chunk populations and post-hoc value substitution
test("daily evaluation rejects incomplete manifests and changed cold comparisons", async () => {
  const incomplete = await completeInput();
  incomplete.lifecycle.chunks = incomplete.lifecycle.chunks.slice(0, 26);
  assert.throws(
    () => evaluateAdjustmentMaintenanceDaily(incomplete),
    /chunk count is incomplete/u,
  );

  const changed = await completeInput();
  const first = JSON.parse(Buffer.from(
    changed.lifecycle.chunks[0].payloadBase64,
    "base64",
  ).toString("utf8"));
  first.records[0].comparison.target = 99;
  changed.lifecycle.chunks[0] = {
    ...changed.lifecycle.chunks[0],
    payloadBase64: Buffer.from(canonicalJsonBytes(first)).toString("base64"),
  };
  assert.throws(
    () => evaluateAdjustmentMaintenanceDaily(changed),
    /chunk payload identity differs/u,
  );

  const legacy = await completeInput();
  const registration = legacy.lifecycle.shadowRegistration;
  delete registration.epochWitnessSha256;
  delete registration.predecessorRegistrationSha256;
  delete registration.scheduleContractSha256;
  registration.registrationSha256 = sha256(Buffer.from([
    "adjustment-shadow-registration/v2", registration.siteKey, registration.family,
    registration.candidateSha256, registration.artifactSha256, registration.policySha256,
    registration.cohortSha256, registration.reservedKeySha256, registration.sourceSha256,
    registration.intervalStartAt, registration.intervalEndAt, registration.targetCutoffAt,
    registration.terminalAt,
  ].join("\n")));
  assert.throws(
    () => evaluateAdjustmentMaintenanceDaily(legacy),
    /shadow registration lineage differs/u,
  );
});
