import { createHash } from "node:crypto";

import {
  buildForecastAdjustmentMaintenancePortableCandidate,
  evaluateForecastAdjustmentMaintenanceNativeCandidate,
  evaluateForecastAdjustmentMaintenancePackagedCandidate,
  evaluateForecastAdjustmentMaintenancePolicy,
  parseForecastAdjustmentMaintenanceShadowCapsule,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  ADJUSTMENT_CONFIRMATION_CHUNK_PART_V3_VERSION,
  assembleConfirmationManifest,
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";
import {
  canonicalJsonBytes,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  createMaintenanceEvaluationRow,
  createRainMaintenanceEvaluationRow,
} from "./adjustment-maintenance-runtime/forecast/maintenance-policy.js";
import {
  decodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";

export const ADJUSTMENT_MAINTENANCE_DAILY_EVALUATION_VERSION =
  "adjustment-maintenance-daily-evaluation/v1";
export const ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION =
  "adjustment-maintenance-evaluation-chunk/v1";
export const ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V2_VERSION =
  "adjustment-maintenance-evaluation-chunk/v2";
export const ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION =
  "adjustment-maintenance-evaluation-chunk/v3";
export const ADJUSTMENT_MAINTENANCE_EXPECTED_KEY_PLAN_V3_VERSION =
  "adjustment-maintenance-expected-key-plan/v3";
export const ADJUSTMENT_MAINTENANCE_CANDIDATE_REPORT_VERSION =
  "adjustment-maintenance-candidate-report/v1";
const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const FAMILIES = new Set(["rain", "temperature", "wind"]);
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Los_Angeles",
  year: "numeric",
});
const CHUNK_COUNTS = new Map([
  ["temperature", 27],
  ["wind", 27],
  ["rain", 24],
]);
const INTERVAL_DAYS = new Map([
  ["temperature", 366],
  ["wind", 366],
  ["rain", 334],
]);
const CANDIDATE_KINDS = new Map([
  ["temperature", "temperature-delayed-mos/v1"],
  ["wind", "wind-robust-hierarchical-median/v1"],
  ["rain", "rain-hurdle-wind-occurrence-amount/v1"],
]);
const REGISTRATION_BASE_KEYS = [
  "artifactSha256", "candidateSha256", "cohortSha256", "family", "intervalEndAt",
  "intervalStartAt", "policySha256", "registrationSha256", "reservedKeySha256", "siteKey",
  "sourceSha256", "targetCutoffAt", "terminalAt",
];
const REGISTRATION_V3_KEYS = [
  ...REGISTRATION_BASE_KEYS, "epochWitnessSha256", "predecessorRegistrationSha256",
  "scheduleContractSha256",
];
const LIFECYCLE_CONTEXT_KEYS = [
  "accessState", "actionIdentitySha256", "actionState", "candidateKind", "candidateReportSha256",
  "candidateSha256", "cohortLineageSha256", "contractVersion", "family", "firstTargetAt",
  "gateManifestSha256", "inputHeadSha256", "intervalEndExclusiveLocalDate",
  "intervalStartLocalDate", "registrationSha256", "reservedKeySha256", "sourceLineageSha256",
  "terminalAccessAt",
];
const ACCESS_KEYS = [
  ...LIFECYCLE_CONTEXT_KEYS, "accessSha256", "accessedAt", "expectedKeySetSha256",
  "revisionCatalogWatermarkSha256", "targetComparatorSnapshotRootSha256", "targetCutoffAt",
];
const CHUNK_V1_KEYS = [
  "chunkIndex", "chunkSha256", "eligiblePredictionSubsetSha256", "expectedKeySubsetSha256",
  "fromLocalDate", "missingKeySubsetSha256", "recordCount", "toLocalDateExclusive",
];
const CHUNK_V3_KEYS = [
  "captureLocalDate", "contractVersion", "eligiblePredictionSubsetSha256", "expectedKeyCount",
  "expectedKeySubsetSha256", "fromLocalDate", "logicalChunkIndex", "missingKeyCount",
  "missingKeySubsetSha256", "partCount", "partIndex", "partSha256", "recordCount",
  "toLocalDateExclusive",
];
const CHUNK_PAYLOAD_KEYS = [
  "chunkIndex", "confirmationRegistrationSha256", "contractVersion", "expectedKeys", "family",
  "missingKeys", "records", "shadowRegistrationSha256",
];
const CHUNK_PAYLOAD_V2_KEYS = [...CHUNK_PAYLOAD_KEYS, "capsules"];
const CHUNK_PAYLOAD_V3_KEYS = [
  "capsules", "captureLocalDate", "confirmationRegistrationSha256", "contractVersion",
  "expectedKeys", "family", "logicalChunkIndex", "missingKeys", "partCount", "partIndex",
  "records", "shadowRegistrationSha256",
];
const RECORD_V1_KEYS = ["capsuleBase64", "comparison", "key", "metric", "rowIndex"];
const RECORD_V2_KEYS = ["capsuleMemberSha256", "comparison", "key", "metric", "rowIndex"];
const CAPSULE_MEMBER_KEYS = ["capsuleBase64", "capsuleMemberSha256"];
const COMPARISON_KEYS = [
  "farmTarget", "firstEdgeCommittedAt", "incumbentPrediction", "membership", "nearestThree",
  "providerFamily", "stationKey", "target",
];
const RAIN_COMPARISON_KEYS = [
  ...COMPARISON_KEYS, "incumbentProbability", "persistencePrediction", "rawTargetHourTemperatureC",
  "nativeSourceProbability", "recentVolumeScalePrediction", "runKey", "sameWindowVolumeScalePrediction",
  "unchangedOrdinalPrediction", "volumeScalePrediction",
];
const RAIN_COMPARISON_V3_KEYS = [...RAIN_COMPARISON_KEYS, "actualBestMatchPrediction"];
const MEMBERSHIP_V1_KEYS = [
  "actualBestMatchProjectionSha256", "actualBestMatchReceiptSha256", "incumbentMemberSha256",
  "nativeSourceProjectionSha256", "nativeSourceReceiptSha256", "targetProjectionSha256",
  "targetReceiptSha256", "targetRowSha256",
];
const RAIN_MEMBERSHIP_V1_KEYS = [
  ...MEMBERSHIP_V1_KEYS, "rainGateProjectionSha256", "rainGateReceiptSha256",
];
const MEMBERSHIP_V2_KEYS = [
  "actualBestMatchProjectionSha256", "actualBestMatchReceiptSha256", "incumbentMemberSha256",
  "nativeSourceProjectionSha256", "nativeSourceReceiptSha256", "targetMemberSha256",
];
const RAIN_MEMBERSHIP_V2_KEYS = [
  ...MEMBERSHIP_V2_KEYS, "rainGateProjectionSha256", "rainGateReceiptSha256",
];

// evaluate one family without conferring lifecycle or release authority
export function evaluateAdjustmentMaintenanceDaily(input) {
  requireExactKeys(input, [
    "catalogInputManifestSha256", "clockAt", "due", "epochWitness", "lifecycle",
  ], "daily evaluation input");
  requireHash(input.catalogInputManifestSha256, "catalogInputManifestSha256");
  requireInstant(input.clockAt, "clockAt");
  const due = validateDailyDue(input.due);
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const lifecycle = requireObject(input.lifecycle, "daily evaluation lifecycle");

  // preserve missing terminal material as a deterministic retryable state
  if (lifecycle.state === "pending") {
    requireExactKeys(lifecycle, ["family", "registrationSha256", "state"],
      "pending daily lifecycle");
    requireFamily(lifecycle.family);
    requireNullableHash(lifecycle.registrationSha256, "registrationSha256");
    const semanticInputSha256 = sha256(canonicalJsonBytes({
      catalogInputManifestSha256: input.catalogInputManifestSha256,
      due,
      epochWitnessSha256: witness.witnessSha256,
      family: lifecycle.family,
      registrationSha256: lifecycle.registrationSha256,
      state: lifecycle.state,
    }));
    return Object.freeze({
      reason: "history_unavailable",
      semanticInputSha256,
      state: "pending",
    });
  }

  requireExactKeys(lifecycle, [
    "access", "artifactBase64", "candidateBase64", "chunks", "confirmationRegistration",
    "fullManifest", "shadowRegistration", "state",
  ], "complete daily lifecycle");
  // prohibit value-bearing access before the lifecycle burn
  if (lifecycle.state !== "burned_complete") {
    throw new TypeError("daily evaluation lifecycle state is invalid");
  }
  const registration = validateLifecycleRegistration(lifecycle.confirmationRegistration);
  const access = validateLifecycleAccess(lifecycle.access, registration);
  const shadowRegistration = validateShadowRegistration(
    lifecycle.shadowRegistration,
    registration.family,
    witness.witnessSha256,
  );
  validateRegistrationCrossBinding(registration, access, shadowRegistration);

  // require terminal access and the frozen target cutoff before scoring
  if (Date.parse(input.clockAt) < Date.parse(registration.terminalAccessAt) ||
      Date.parse(input.clockAt) < Date.parse(access.accessedAt) ||
      Date.parse(access.targetCutoffAt) > Date.parse(input.clockAt)) {
    throw new RangeError("daily evaluation terminal clock is premature");
  }
  const candidateBytes = decodeBase64(lifecycle.candidateBase64, 8 * 1_024 * 1_024,
    "candidateBase64");
  const artifactBytes = decodeBase64(lifecycle.artifactBase64, 8 * 1_024 * 1_024,
    "artifactBase64");
  const portable = buildForecastAdjustmentMaintenancePortableCandidate({
    candidateBytes,
    family: registration.family,
  });

  // bind the fitted and packaged bytes to the public frozen registration
  if (portable.candidateSha256 !== shadowRegistration.candidateSha256 ||
      portable.artifactSha256 !== shadowRegistration.artifactSha256 ||
      !portable.artifactBytes.equals(artifactBytes)) {
    throw new TypeError("daily evaluation candidate package differs");
  }
  const { chunks, rows } = validateEvaluationChunks({
    access,
    artifactBytes,
    candidateBytes,
    chunks: lifecycle.chunks,
    epochWitness: witness,
    registration,
    shadowRegistration,
  });
  const manifest = assembleConfirmationManifest({ access, chunks, registration });

  // bind scoring to the exact already-finalized full member
  if (!canonicalBytes(manifest).equals(canonicalBytes(lifecycle.fullManifest))) {
    throw new TypeError("daily evaluation full manifest differs");
  }
  const policyBytes = evaluateForecastAdjustmentMaintenancePolicy({
    epoch: null,
    family: registration.family,
    kind: "promotion",
    rows,
  });
  const policy = parseCanonicalBytes(policyBytes, "maintenance policy");
  const evaluationRowsSha256 = sha256(canonicalJsonBytes(rows.map(
    // retain the exact ordered row identities only
    (row) => row.rowSha256,
  )));
  const policyReportSha256 = sha256(policyBytes);
  const candidateReport = Object.freeze({
    candidateSha256: shadowRegistration.candidateSha256,
    confirmationRegistrationSha256: registration.registrationSha256,
    contractVersion: ADJUSTMENT_MAINTENANCE_CANDIDATE_REPORT_VERSION,
    evaluationRowsSha256,
    family: registration.family,
    fullMemberRootSha256: manifest.fullMemberRootSha256,
    policyReportSha256,
    registrationSha256: shadowRegistration.registrationSha256,
    targetCutoffAt: access.targetCutoffAt,
  });
  const candidateReportBytes = canonicalBytes(candidateReport);
  const semanticInputSha256 = sha256(canonicalJsonBytes({
    catalogInputManifestSha256: input.catalogInputManifestSha256,
    candidateReportSha256: sha256(candidateReportBytes),
    due,
    epochWitnessSha256: witness.witnessSha256,
    fullMemberRootSha256: manifest.fullMemberRootSha256,
  }));
  return Object.freeze({
    candidateReportBase64: candidateReportBytes.toString("base64"),
    candidateReportSha256: sha256(candidateReportBytes),
    contractVersion: ADJUSTMENT_MAINTENANCE_DAILY_EVALUATION_VERSION,
    family: registration.family,
    fullMemberRootSha256: manifest.fullMemberRootSha256,
    policy,
    policyBytesBase64: policyBytes.toString("base64"),
    policyReportSha256,
    rowCount: rows.length,
    semanticInputSha256,
    state: "evaluated",
  });
}

// build one value-bearing chunk and its blinded journal projection
export function buildAdjustmentMaintenanceEvaluationChunk(input) {
  return buildAdjustmentMaintenanceEvaluationChunkVersion(
    input,
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION,
  );
}

// build one additive derived-target chunk without changing v1 bytes
export function buildAdjustmentMaintenanceEvaluationChunkV2(input) {
  return buildAdjustmentMaintenanceEvaluationChunkVersion(
    input,
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V2_VERSION,
  );
}

// build one bounded part of an all-cycle logical confirmation window
export function buildAdjustmentMaintenanceEvaluationChunkV3(input) {
  return buildAdjustmentMaintenanceEvaluationChunkVersion(
    input,
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION,
  );
}

// preregister every fixed-cycle target cell without reading outcomes
export function buildAdjustmentMaintenanceExpectedKeyPlanV3(input) {
  requireExactKeys(input, ["family", "intervalEndAt", "intervalStartAt"],
    "daily evaluation expected key plan input");
  requireFamily(input.family);
  requireInstant(input.intervalStartAt, "intervalStartAt");
  requireInstant(input.intervalEndAt, "intervalEndAt");
  const intervalStart = Date.parse(input.intervalStartAt);
  const intervalEnd = Date.parse(input.intervalEndAt);
  const intervalStartLocalDate = localDateAt(input.intervalStartAt);
  const intervalEndLocalDate = localDateAt(input.intervalEndAt);
  const logicalChunkCount = CHUNK_COUNTS.get(input.family);

  // require the exact reviewed rolling family span
  if (intervalEnd <= intervalStart ||
      daysBetween(intervalStartLocalDate, intervalEndLocalDate) !==
        INTERVAL_DAYS.get(input.family)) {
    throw new TypeError("daily evaluation expected key interval differs");
  }
  const maximumLeadHours = input.family === "wind" ? 168 : input.family === "rain" ? 31 : 12;
  const firstCycle = Math.floor((intervalStart - maximumLeadHours * 3_600_000) /
    (6 * 3_600_000)) * 6 * 3_600_000;
  const groups = new Map();

  // enumerate only fixed provider cycles whose target cells intersect the interval
  for (let cycleAt = firstCycle; cycleAt < intervalEnd; cycleAt += 6 * 3_600_000) {
    const dueAt = new Date(cycleAt + 35 * 60_000).toISOString();
    const dueKey = `capture/${dueAt}`;
    const captureLocalDate = localDateAt(dueAt);

    // enumerate each family output cell before any target exists
    for (const cell of expectedCycleCells(input.family, cycleAt)) {
      if (cell.validAt < intervalStart || cell.validAt >= intervalEnd) {
        continue;
      }
      const targetLocalDate = localDateAt(new Date(cell.validAt).toISOString());
      const dayOffset = daysBetween(intervalStartLocalDate, targetLocalDate);
      const logicalChunkIndex = Math.floor(dayOffset / 14);
      const groupKey = `${logicalChunkIndex}\0${captureLocalDate}`;
      const keys = groups.get(groupKey) ?? [];
      keys.push(`${dueKey}/${cell.leadHours}/${cell.metric ?? input.family}`);
      groups.set(groupKey, keys);
    }
  }
  const logicalChunks = [];

  // materialize one deterministic part for each target-window and capture-date pair
  for (let logicalChunkIndex = 0; logicalChunkIndex < logicalChunkCount;
    logicalChunkIndex += 1) {
    const fromLocalDate = addLocalDates(intervalStartLocalDate, logicalChunkIndex * 14);
    const remainingDays = INTERVAL_DAYS.get(input.family) - logicalChunkIndex * 14;
    const toLocalDateExclusive = addLocalDates(fromLocalDate, Math.min(14, remainingDays));
    const entries = [...groups.entries()].filter(
      // select only this logical target window's precomputed parts
      ([key]) => Number(key.split("\0", 1)[0]) === logicalChunkIndex,
    ).sort(
      // retain capture-date order independently from row outcomes
      ([left], [right]) => left.localeCompare(right),
    );

    // every reviewed logical window must contain scheduled target cells
    if (entries.length < 1 || entries.length > 24) {
      throw new RangeError("daily evaluation expected part population differs");
    }
    const parts = entries.map(
      // bind one bounded physical part to its complete expected key subset
      ([groupKey, keys], partIndex) => {
        const captureLocalDate = groupKey.split("\0")[1];
        const expectedKeys = [...keys].sort();

        // prove unique keys and the physical record ceiling before preregistration
        if (new Set(expectedKeys).size !== expectedKeys.length || expectedKeys.length > 8_192) {
          throw new RangeError("daily evaluation expected key population differs");
        }
        return Object.freeze({
          captureLocalDate,
          expectedKeyCount: expectedKeys.length,
          expectedKeys: Object.freeze(expectedKeys),
          expectedKeySubsetSha256: sha256(canonicalJsonBytes(expectedKeys)),
          partCount: entries.length,
          partIndex,
        });
      },
    );
    logicalChunks.push(Object.freeze({
      expectedKeyCount: parts.reduce(
        // retain the complete logical cell count
        (count, part) => count + part.expectedKeyCount,
        0,
      ),
      expectedKeySubsetSha256: sha256(canonicalJsonBytes(parts.map(
        // bind every ordered physical expected root
        (part) => part.expectedKeySubsetSha256,
      ))),
      fromLocalDate,
      logicalChunkIndex,
      partCount: parts.length,
      parts: Object.freeze(parts),
      toLocalDateExclusive,
    }));
  }
  const reservedKeySha256 = sha256(canonicalJsonBytes(logicalChunks.map(
    // bind every ordered logical expected root
    (chunk) => chunk.expectedKeySubsetSha256,
  )));
  return Object.freeze({
    contractVersion: ADJUSTMENT_MAINTENANCE_EXPECTED_KEY_PLAN_V3_VERSION,
    family: input.family,
    intervalEndAt: input.intervalEndAt,
    intervalStartAt: input.intervalStartAt,
    logicalChunkCount,
    logicalChunks: Object.freeze(logicalChunks),
    reservedKeySha256,
  });
}

// derive one family cycle's fixed target geometry
function expectedCycleCells(family, cycleAt) {
  const cells = [];
  const firstModelLead = family === "rain" ? 9 : 1;
  const rowCount = family === "wind" ? 168 : family === "rain" ? 23 : 12;

  // retain every supported row and wind metric independently
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const modelLeadHours = firstModelLead + rowIndex;
    const common = { leadHours: rowIndex + 1, validAt: cycleAt + modelLeadHours * 3_600_000 };
    if (family !== "wind") {
      cells.push({ ...common, metric: null });
      continue;
    }
    cells.push({ ...common, metric: "windSpeedMps" });
    // omit the frozen unsupported gust band 049-072
    if (modelLeadHours < 49 || modelLeadHours > 72) {
      cells.push({ ...common, metric: "windGustMps" });
    }
  }
  return cells;
}

// build one value-bearing chunk under an explicit closed version
function buildAdjustmentMaintenanceEvaluationChunkVersion(input, contractVersion) {
  const parted = contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION;
  requireExactKeys(input, parted ? [
    "captureLocalDate", "confirmationRegistrationSha256", "family", "fromLocalDate",
    "logicalChunkIndex", "missingKeys", "partCount", "partIndex", "records",
    "shadowRegistrationSha256", "toLocalDateExclusive",
  ] : [
    "chunkIndex", "confirmationRegistrationSha256", "family", "fromLocalDate", "missingKeys",
    "records", "shadowRegistrationSha256", "toLocalDateExclusive",
  ], "daily evaluation chunk builder input");
  requireFamily(input.family);
  requireHash(input.confirmationRegistrationSha256, "confirmationRegistrationSha256");
  requireHash(input.shadowRegistrationSha256, "shadowRegistrationSha256");
  requireLocalDate(input.fromLocalDate, "fromLocalDate");
  requireLocalDate(input.toLocalDateExclusive, "toLocalDateExclusive");
  if (parted) {
    requireLocalDate(input.captureLocalDate, "captureLocalDate");
  }
  // enforce one exact family chunk index and bounded record set
  if ((!parted && (!Number.isInteger(input.chunkIndex) || input.chunkIndex < 0 ||
      input.chunkIndex >= CHUNK_COUNTS.get(input.family))) ||
      (parted && (!Number.isInteger(input.logicalChunkIndex) || input.logicalChunkIndex < 0 ||
        input.logicalChunkIndex >= CHUNK_COUNTS.get(input.family) ||
        !Number.isInteger(input.partIndex) || input.partIndex < 0 ||
        !Number.isInteger(input.partCount) || input.partCount < 1 || input.partCount > 24 ||
        input.partIndex >= input.partCount)) || !Array.isArray(input.records) ||
      input.records.length > 8_192 || !Array.isArray(input.missingKeys)) {
    throw new TypeError("daily evaluation chunk builder bounds differ");
  }
  const derivedTarget = contractVersion !== ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION;
  const capsules = new Map();
  const records = input.records.map(
    // deduplicate exact capsule bytes only under the additive v2 grammar
    (record) => {
      if (!derivedTarget) {
        return structuredClone(validateEvaluationRecord(record, input.family, contractVersion));
      }
      requireExactKeys(record, RECORD_V1_KEYS, "daily evaluation v2 builder record");
      const capsuleBytes = decodeBase64(record.capsuleBase64, 2 * 1_024 * 1_024,
        "capsuleBase64");
      const capsuleMemberSha256 = sha256(capsuleBytes);
      const projected = {
        capsuleMemberSha256,
        comparison: record.comparison,
        key: record.key,
        metric: record.metric,
        rowIndex: record.rowIndex,
      };
      validateEvaluationRecord(projected, input.family, contractVersion);
      capsules.set(capsuleMemberSha256, Object.freeze({
        capsuleBase64: record.capsuleBase64,
        capsuleMemberSha256,
      }));
      return structuredClone(projected);
    },
  );
  const recordKeys = records.map(
    // retain caller-established record order for cold replay
    (record) => record.key,
  );
  validateSortedUniqueStrings(recordKeys, "record keys");
  validateSortedUniqueStrings(input.missingKeys, "missingKeys");
  const expectedKeys = [...recordKeys, ...input.missingKeys].sort();
  // require eligible and missing sets to be disjoint
  if (new Set(expectedKeys).size !== expectedKeys.length) {
    throw new TypeError("daily evaluation chunk expected keys overlap");
  }
  const payload = {
    ...(derivedTarget ? { capsules: [...capsules.values()].sort(
      // stabilize deduplicated capsule member order
      (left, right) => left.capsuleMemberSha256.localeCompare(right.capsuleMemberSha256),
    ) } : {}),
    ...(parted ? {
      captureLocalDate: input.captureLocalDate,
      logicalChunkIndex: input.logicalChunkIndex,
      partCount: input.partCount,
      partIndex: input.partIndex,
    } : { chunkIndex: input.chunkIndex }),
    confirmationRegistrationSha256: input.confirmationRegistrationSha256,
    contractVersion,
    expectedKeys,
    family: input.family,
    missingKeys: [...input.missingKeys],
    records,
    shadowRegistrationSha256: input.shadowRegistrationSha256,
  };
  const payloadBytes = canonicalBytes(payload);
  // refuse oversized physical parts before any archive publication
  if (payloadBytes.length > 8 * 1_024 * 1_024) {
    throw new RangeError("daily evaluation chunk payload exceeds its bound");
  }
  const commonMetadata = {
    eligiblePredictionSubsetSha256: sha256(canonicalJsonBytes(recordKeys)),
    expectedKeySubsetSha256: sha256(canonicalJsonBytes(expectedKeys)),
    fromLocalDate: input.fromLocalDate,
    missingKeySubsetSha256: sha256(canonicalJsonBytes(input.missingKeys)),
    recordCount: records.length,
    toLocalDateExclusive: input.toLocalDateExclusive,
  };
  return Object.freeze({
    metadata: Object.freeze(parted ? {
      captureLocalDate: input.captureLocalDate,
      contractVersion: ADJUSTMENT_CONFIRMATION_CHUNK_PART_V3_VERSION,
      ...commonMetadata,
      expectedKeyCount: expectedKeys.length,
      logicalChunkIndex: input.logicalChunkIndex,
      missingKeyCount: input.missingKeys.length,
      partCount: input.partCount,
      partIndex: input.partIndex,
      partSha256: sha256(payloadBytes),
    } : {
      chunkIndex: input.chunkIndex,
      chunkSha256: sha256(payloadBytes),
      ...commonMetadata,
    }),
    payloadBase64: payloadBytes.toString("base64"),
  });
}

// validate every ordered chunk and replay every eligible record
function validateEvaluationChunks(input) {
  const expectedCount = CHUNK_COUNTS.get(input.registration.family);

  // require at least the frozen logical family chunk population
  if (!Array.isArray(input.chunks) || input.chunks.length < expectedCount) {
    throw new RangeError("daily evaluation chunk count is incomplete");
  }
  const chunks = [];
  const rows = [];
  const keys = new Set();
  const expectedKeys = [];
  let chunkContractVersion = null;
  let previousMetadata = null;

  // preserve the manifest order while checking each value-bearing payload
  for (const [index, entry] of input.chunks.entries()) {
    requireExactKeys(entry, ["metadata", "payloadBase64"], "daily evaluation chunk entry");
    const metadata = validateChunkMetadata(entry.metadata, input.registration.family);
    const payloadBytes = decodeBase64(entry.payloadBase64, 8 * 1_024 * 1_024,
      "chunk payloadBase64");
    const payload = parseCanonicalBytes(payloadBytes, "daily evaluation chunk payload");
    const validatedPayload = validateChunkPayload(
      payload,
      metadata,
      input.registration,
      input.shadowRegistration,
    );
    const version = validatedPayload.contractVersion;

    // prohibit mixing the legacy and derived-target membership domains
    if (chunkContractVersion !== null && version !== chunkContractVersion) {
      throw new TypeError("daily evaluation chunk versions differ");
    }
    chunkContractVersion = version;
    // require exact physical order under the selected immutable grammar
    if (!evaluationChunkFollows(previousMetadata, metadata, version, index)) {
      throw new TypeError("daily evaluation chunk order differs");
    }
    previousMetadata = metadata;
    expectedKeys.push(...payload.expectedKeys);

    // bind the value-bearing cold member to the blinded manifest metadata
    const expectedPayloadSha256 = version === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION
      ? metadata.partSha256
      : metadata.chunkSha256;
    if (sha256(payloadBytes) !== expectedPayloadSha256) {
      throw new TypeError("daily evaluation chunk payload identity differs");
    }
    for (const record of payload.records) {
      // prohibit duplicate designated predictions across chunk boundaries
      if (keys.has(record.key)) {
        throw new RangeError("daily evaluation record key is duplicated");
      }
      keys.add(record.key);
      rows.push(replayEvaluationRecord({
        ...input,
        capsuleMembers: validatedPayload.capsuleMembers,
        chunkContractVersion: version,
        chunkMetadata: metadata,
        record,
      }));
    }
    chunks.push(metadata);
  }
  // retain the exact legacy physical count without limiting additive parts
  if (chunkContractVersion !== ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION &&
      input.chunks.length !== expectedCount) {
    throw new RangeError("daily evaluation chunk count is incomplete");
  }
  // bind the value-free snapshot root to the exact full expected-key population
  if (chunkContractVersion !== ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION &&
      sha256(canonicalJsonBytes(expectedKeys)) !== input.access.expectedKeySetSha256) {
    throw new TypeError("daily evaluation expected key set differs");
  }
  return { chunks, rows: Object.freeze(rows) };
}

// validate one value-bearing chunk against its blinded roots
function validateChunkPayload(payload, metadata, registration, shadowRegistration) {
  const supportedVersion = payload.contractVersion ===
      ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION ||
    payload.contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V2_VERSION ||
    payload.contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION;
  const parted = payload.contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION;
  const derivedTarget = payload.contractVersion !==
    ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION;
  requireExactKeys(payload, parted
    ? CHUNK_PAYLOAD_V3_KEYS
    : derivedTarget ? CHUNK_PAYLOAD_V2_KEYS : CHUNK_PAYLOAD_KEYS,
    "daily evaluation chunk payload");
  // require exact family, registration, order and contract bindings
  if (!supportedVersion ||
      payload.family !== registration.family ||
      (!parted && payload.chunkIndex !== metadata.chunkIndex) ||
      (parted && (payload.captureLocalDate !== metadata.captureLocalDate ||
        payload.logicalChunkIndex !== metadata.logicalChunkIndex ||
        payload.partCount !== metadata.partCount || payload.partIndex !== metadata.partIndex)) ||
      payload.confirmationRegistrationSha256 !== registration.registrationSha256 ||
      payload.shadowRegistrationSha256 !== shadowRegistration.registrationSha256 ||
      !Array.isArray(payload.expectedKeys) || !Array.isArray(payload.missingKeys) ||
      !Array.isArray(payload.records) || payload.records.length !== metadata.recordCount ||
      (parted && (payload.expectedKeys.length !== metadata.expectedKeyCount ||
        payload.missingKeys.length !== metadata.missingKeyCount))) {
    throw new TypeError("daily evaluation chunk payload differs");
  }
  const capsuleMembers = derivedTarget
    ? validateChunkCapsules(payload.capsules)
    : null;
  const recordKeys = payload.records.map(
    // validate each closed record before hashing its eligible set
    (record) => validateEvaluationRecord(
      record,
      registration.family,
      payload.contractVersion,
    ).key,
  );
  const referencedCapsules = derivedTarget
    ? new Set(payload.records.map(
        // retain the exact capsule member identities selected by records
        (record) => record.capsuleMemberSha256,
      ))
    : null;
  // require every v2 record to resolve one exact deduplicated capsule member
  if (derivedTarget && (capsuleMembers.size !== referencedCapsules.size ||
      [...referencedCapsules].some((identity) => !capsuleMembers.has(identity)))) {
    throw new TypeError("daily evaluation capsule member is unavailable");
  }
  validateSortedUniqueStrings(payload.expectedKeys, "expectedKeys");
  validateSortedUniqueStrings(payload.missingKeys, "missingKeys");
  validateSortedUniqueStrings(recordKeys, "record keys");
  const expected = [...recordKeys, ...payload.missingKeys].sort();

  // require a complete disjoint expected-key partition
  if (new Set(expected).size !== expected.length ||
      JSON.stringify(expected) !== JSON.stringify(payload.expectedKeys) ||
      sha256(canonicalJsonBytes(payload.expectedKeys)) !== metadata.expectedKeySubsetSha256 ||
      sha256(canonicalJsonBytes(recordKeys)) !== metadata.eligiblePredictionSubsetSha256 ||
      sha256(canonicalJsonBytes(payload.missingKeys)) !== metadata.missingKeySubsetSha256) {
    throw new TypeError("daily evaluation chunk key roots differ");
  }
  return Object.freeze({ capsuleMembers, contractVersion: payload.contractVersion });
}

// validate one sorted unique capsule table and exact byte identity
function validateChunkCapsules(value) {
  // retain the existing record ceiling without selecting a confirmation cadence
  if (!Array.isArray(value) || value.length > 8_192) {
    throw new TypeError("daily evaluation capsule population is invalid");
  }
  const capsules = new Map();

  // bind each exact capsule once before any record replay
  for (const entry of value) {
    requireExactKeys(entry, CAPSULE_MEMBER_KEYS, "daily evaluation capsule member");
    requireHash(entry.capsuleMemberSha256, "capsuleMemberSha256");
    const bytes = decodeBase64(entry.capsuleBase64, 2 * 1_024 * 1_024,
      "capsuleBase64");
    if (sha256(bytes) !== entry.capsuleMemberSha256 ||
      capsules.has(entry.capsuleMemberSha256)) {
      throw new TypeError("daily evaluation capsule member differs");
    }
    capsules.set(entry.capsuleMemberSha256, bytes);
  }
  const identities = [...capsules.keys()];
  // prohibit alternate capsule orderings for the same value set
  if (JSON.stringify(identities) !== JSON.stringify([...identities].sort())) {
    throw new TypeError("daily evaluation capsule members are not sorted");
  }
  return capsules;
}

// replay one archived capsule through independent fit and package decoders
function replayEvaluationRecord(input) {
  const record = validateEvaluationRecord(
    input.record,
    input.registration.family,
    input.chunkContractVersion,
  );
  const capsuleBytes = input.chunkContractVersion !==
      ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION
    ? input.capsuleMembers.get(record.capsuleMemberSha256)
    : decodeBase64(record.capsuleBase64, 2 * 1_024 * 1_024, "capsuleBase64");
  if (!Buffer.isBuffer(capsuleBytes)) {
    throw new TypeError("daily evaluation capsule member is unavailable");
  }
  const capsule = parseForecastAdjustmentMaintenanceShadowCapsule({ capsuleBytes });

  // bind every capsule to the registered future-only candidate
  if (capsule.body.family !== input.registration.family ||
      capsule.body.registrationSha256 !== input.shadowRegistration.registrationSha256 ||
      capsule.body.candidateSha256 !== input.shadowRegistration.candidateSha256 ||
      capsule.body.sourceSha256 !== input.shadowRegistration.sourceSha256 ||
      capsule.sourceIdentity.sourceReceiptSha256 !==
        capsule.revisionReceipt.projectionIdentitySha256 ||
      capsule.sourceIdentity.inputSha256 !== capsule.revisionReceipt.projectionSha256) {
    throw new TypeError("daily evaluation capsule registration differs");
  }
  validateFutureOnlyCapsule(capsule, input.epochWitness, input.access.targetCutoffAt);
  const bodyRow = capsule.body.rows[record.rowIndex];
  const sourceRow = capsule.source.rows[record.rowIndex];

  // reject absent rows and key aliases before numerical replay
  if (bodyRow === undefined || sourceRow === undefined ||
      record.key !== evaluationRecordKey(
        capsule.body,
        bodyRow,
        record.metric,
        input.chunkContractVersion,
      )) {
    throw new TypeError("daily evaluation record geometry differs");
  }
  const recordLocalDate = localDateAt(bodyRow.validAt);
  // bind the row to its exact chunk, registered interval and frozen cutoff
  if (recordLocalDate < input.chunkMetadata.fromLocalDate ||
      recordLocalDate >= input.chunkMetadata.toLocalDateExclusive ||
      recordLocalDate < input.registration.intervalStartLocalDate ||
      recordLocalDate >= input.registration.intervalEndExclusiveLocalDate ||
      Date.parse(bodyRow.validAt) > Date.parse(input.access.targetCutoffAt) ||
      Date.parse(record.comparison.firstEdgeCommittedAt) > Date.parse(input.access.targetCutoffAt) ||
      (input.chunkContractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION &&
        localDateAt(captureDueAt(capsule.body.dueKey)) !== input.chunkMetadata.captureLocalDate)) {
    throw new TypeError("daily evaluation record is outside its frozen interval");
  }
  const evaluatorInput = candidateEvaluatorInput(capsule, sourceRow);
  const nativeBytes = evaluateForecastAdjustmentMaintenanceNativeCandidate({
    candidateBytes: input.candidateBytes,
    family: input.registration.family,
    input: evaluatorInput,
  });
  const packagedBytes = evaluateForecastAdjustmentMaintenancePackagedCandidate({
    artifactBytes: input.artifactBytes,
    family: input.registration.family,
    input: evaluatorInput,
  });

  // require two real decode paths to produce the same canonical decision
  if (!nativeBytes.equals(packagedBytes)) {
    throw new TypeError("daily evaluation native and packaged replay differ");
  }
  const decision = parseCanonicalBytes(nativeBytes, "candidate replay decision");
  const comparison = record.comparison;
  const replay = replayedPrediction(capsule, bodyRow, sourceRow, record.metric, decision,
    input.chunkContractVersion, comparison);
  const common = {
    actualBestMatchPrediction: replay.actualBestMatchPrediction,
    applied: replay.applied,
    candidatePrediction: replay.candidatePrediction,
    evidenceClass: "prospective_receipt",
    farmTarget: comparison.farmTarget,
    firstEdgeCommittedAt: comparison.firstEdgeCommittedAt,
    horizonHours: bodyRow.leadHours,
    incumbentPrediction: comparison.incumbentPrediction,
    key: record.key,
    localDate: recordLocalDate,
    nativeSourcePrediction: replay.nativeSourcePrediction,
    nearestThree: comparison.nearestThree,
    provenanceComplete: true,
    providerFamily: comparison.providerFamily,
    sourceReceiptAt: capsule.revisionReceipt.archiveCommittedAt,
    sourceRowSha256: bodyRow.sourceRowSha256,
    stationKey: comparison.stationKey,
    target: comparison.target,
    targetRowSha256: input.chunkContractVersion !==
      ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION
      ? comparison.membership.targetMemberSha256
      : comparison.membership.targetRowSha256,
    validAt: bodyRow.validAt,
  };

  // build the extended rain row only from replayed candidate values
  if (input.registration.family === "rain") {
    return createRainMaintenanceEvaluationRow({
      ...common,
      candidateProbability: replay.candidateProbability,
      incumbentProbability: comparison.incumbentProbability,
      nativeSourceProbability: comparison.nativeSourceProbability,
      persistencePrediction: comparison.persistencePrediction,
      rawTargetHourTemperatureC: comparison.rawTargetHourTemperatureC,
      recentVolumeScalePrediction: comparison.recentVolumeScalePrediction,
      runKey: comparison.runKey,
      sameWindowVolumeScalePrediction: comparison.sameWindowVolumeScalePrediction,
      unchangedOrdinalPrediction: comparison.unchangedOrdinalPrediction,
      volumeScalePrediction: comparison.volumeScalePrediction,
    });
  }
  return createMaintenanceEvaluationRow({
    ...common,
    family: input.registration.family,
    pairKey: input.registration.family === "wind" ? windPairKey(record.metric, bodyRow.leadHours) : null,
  });
}

// derive the exact runtime input from one parser-verified source row
function candidateEvaluatorInput(capsule, row) {
  // restore temperature's complete captured rolling state and ECMWF row
  if (capsule.source.family === "temperature") {
    return {
      evaluatedAt: capsule.source.issuedAt,
      rawBestMatchTemperatureC: decodeNullable(row.bestMatchTemperatureC64),
      recentErrorState: capsule.source.recentErrorState,
      sourceForecast: {
        adapterVersion: row.adapterVersion,
        dataset: "single_run",
        firstReceivedAt: row.receivedAt,
        modelCycle: row.modelCycle,
        modelLeadHours: row.modelLeadHours,
        providerKey: "open-meteo",
        providerResponseSha256: row.providerResponseSha256,
        rawRelativeHumidityPercent: decodeNullable(row.rawRelativeHumidityPercent64),
        rawTemperatureC: decodeMaintenanceBinary64(row.rawTemperatureC64),
        rawWindSpeedMps: decodeNullable(row.rawWindSpeedMps64),
        runInitializedAt: row.referenceAt,
        upstreamModel: "ecmwf_ifs",
        validAt: row.validAt,
      },
      validAt: row.validAt,
    };
  }
  // restore wind's exact Best Match metrics and provenance
  if (capsule.source.family === "wind") {
    return {
      evaluatedAt: capsule.source.issuedAt,
      metrics: windMetrics(
        decodeMaintenanceBinary64(row.windSpeedMps64),
        decodeNullable(row.windGustMps64),
      ),
      rawForecastProvenance: {
        adapterVersion: row.adapterVersion,
        cohort: "legacy_v4_retrieval_snapshot",
        contractEpoch: row.contractEpoch,
        dataset: row.dataset,
        referenceAt: row.referenceAt,
        referenceKind: "retrieval_snapshot",
        sourceConfigFingerprint: row.sourceConfigFingerprint,
        sourceKey: row.sourceKey,
        targetLeadHours: row.modelLeadHours,
        upstreamModel: row.upstreamModel,
        validAt: row.validAt,
      },
    };
  }
  return capsule.source;
}

// cross-check one replay decision against its immutable public body row
function replayedPrediction(capsule, bodyRow, sourceRow, metric, decision, contractVersion, comparison) {
  // derive one temperature prediction or exact fallback
  if (capsule.body.family === "temperature") {
    const rawBestMatch = decodeNullable(sourceRow.bestMatchTemperatureC64);
    const raw = decodeMaintenanceBinary64(sourceRow.rawTemperatureC64);
    const applied = decision.state === "active" && decision.correctedTemperatureC !== null;
    const candidate = applied ? decision.correctedTemperatureC : rawBestMatch ?? raw;
    requireReplayMatch(bodyRow.wouldApply === applied &&
      decodeMaintenanceBinary64(bodyRow.candidateTemperatureC64) === candidate);
    return {
      actualBestMatchPrediction: rawBestMatch ?? raw,
      applied,
      candidatePrediction: candidate,
      nativeSourcePrediction: raw,
    };
  }
  // derive the selected wind metric from the shared runtime decision
  if (capsule.body.family === "wind") {
    const appliedMetrics = new Set(decision.state === "active" ? decision.appliedMetrics : []);
    const gust = metric === "windGustMps";
    const raw = decodeMaintenanceBinary64(gust
      ? sourceRow.windGustMps64 : sourceRow.windSpeedMps64);
    const applied = appliedMetrics.has(metric);
    const candidate = applied ? decision.adjustedMetrics[metric] : raw;
    requireReplayMatch((gust ? bodyRow.gustWouldApply : bodyRow.speedWouldApply) === applied &&
      decodeMaintenanceBinary64(gust
        ? bodyRow.candidateGustMps64 : bodyRow.candidateSpeedMps64) === candidate);
    return {
      actualBestMatchPrediction: raw,
      applied,
      candidatePrediction: candidate,
      nativeSourcePrediction: raw,
    };
  }
  const hour = decision.hours[bodyRow.leadHours - 1];
  const raw = decodeMaintenanceBinary64(sourceRow.precipitationMm64);
  const candidate = decodeMaintenanceBinary64(bodyRow.candidatePrecipitationMm64);
  const candidateProbability = {
    atLeast0_1: decodeMaintenanceBinary64(bodyRow.occurrenceProbability64),
    atLeast1_0: decodeMaintenanceBinary64(bodyRow.atLeast1_0Probability64),
    atLeast2_5: decodeMaintenanceBinary64(bodyRow.atLeast2_5Probability64),
  };
  requireReplayMatch(hour !== undefined && hour.validAt === bodyRow.validAt &&
    hour.applied === bodyRow.wouldApply && hour.correctedPrecipitationMm === candidate &&
    hour.positiveAmountMm === decodeMaintenanceBinary64(bodyRow.positiveAmountMm64) &&
    canonicalBytes(hour.occurrenceProbabilities).equals(canonicalBytes(candidateProbability)));
  return {
    actualBestMatchPrediction: contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION
      ? comparison.actualBestMatchPrediction : raw,
    applied: bodyRow.wouldApply,
    candidatePrediction: candidate,
    candidateProbability,
    nativeSourcePrediction: raw,
  };
}

// require one exact candidate replay match
function requireReplayMatch(matches) {
  // fail closed on any body/runtime divergence
  if (!matches) {
    throw new TypeError("daily evaluation replay differs from archived body");
  }
}

// validate one record without accepting arbitrary comparator fields
function validateEvaluationRecord(value, family, contractVersion) {
  const derivedTarget = contractVersion !== ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION;
  requireExactKeys(value, derivedTarget ? RECORD_V2_KEYS : RECORD_V1_KEYS,
    "daily evaluation record");
  requireBoundedString(value.key, "key", 512);
  if (derivedTarget) {
    requireHash(value.capsuleMemberSha256, "capsuleMemberSha256");
  } else {
    requireBase64(value.capsuleBase64, "capsuleBase64");
  }
  // restrict metric selection to the family output geometry
  if (!Number.isInteger(value.rowIndex) || value.rowIndex < 0 || value.rowIndex >= 168 ||
      (family === "wind"
        ? !new Set(["windGustMps", "windSpeedMps"]).has(value.metric)
        : value.metric !== null)) {
    throw new TypeError("daily evaluation record selector is invalid");
  }
  const comparisonKeys = family === "rain"
    ? contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION
      ? RAIN_COMPARISON_V3_KEYS : RAIN_COMPARISON_KEYS
    : COMPARISON_KEYS;
  requireExactKeys(value.comparison, comparisonKeys, "daily evaluation comparison");
  validateComparison(value.comparison, family, contractVersion);
  return value;
}

// validate the cold-resolved target and incumbent comparison projection
function validateComparison(value, family, contractVersion) {
  requireInstant(value.firstEdgeCommittedAt, "firstEdgeCommittedAt");
  const derivedTarget = contractVersion !== ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_VERSION;
  const membershipKeys = derivedTarget
    ? family === "rain" ? RAIN_MEMBERSHIP_V2_KEYS : MEMBERSHIP_V2_KEYS
    : family === "rain" ? RAIN_MEMBERSHIP_V1_KEYS : MEMBERSHIP_V1_KEYS;
  requireExactKeys(value.membership,
    membershipKeys,
    "daily evaluation membership");
  for (const [field, identity] of Object.entries(value.membership)) {
    // retain every source, comparator, target and receipt member identity
    requireHash(identity, field);
  }
  for (const field of ["incumbentPrediction", "target"]) {
    requireFinite(value[field], field);
  }
  // preserve only finite optional diagnostics
  if (value.farmTarget !== null) {
    requireFinite(value.farmTarget, "farmTarget");
  }
  if (value.nearestThree !== null && typeof value.nearestThree !== "boolean") {
    throw new TypeError("nearestThree is invalid");
  }
  for (const field of ["providerFamily", "stationKey"]) {
    // admit only bounded optional physical lineage labels
    if (value[field] !== null) {
      requireBoundedString(value[field], field, 128);
    }
  }
  // validate the rain-only fixed controls and probabilities
  if (family === "rain") {
    // keep the genuine best-match diagnostic separate from native rain and fixed controls
    if (contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION) {
      requireFinite(value.actualBestMatchPrediction, "actualBestMatchPrediction");
      if (value.actualBestMatchPrediction < 0 || value.actualBestMatchPrediction > 2_000) {
        throw new RangeError("rain actual best-match prediction is outside physical bounds");
      }
    }
    for (const field of [
      "persistencePrediction", "rawTargetHourTemperatureC", "recentVolumeScalePrediction",
      "sameWindowVolumeScalePrediction", "unchangedOrdinalPrediction", "volumeScalePrediction",
    ]) {
      requireFinite(value[field], field);
    }
    requireBoundedString(value.runKey, "runKey", 256);
    validateProbability(value.incumbentProbability, "incumbentProbability");
    validateProbability(value.nativeSourceProbability, "nativeSourceProbability");
  }
}

// validate one lifecycle registration record from the append-only journal
function validateLifecycleRegistration(value) {
  requireExactKeys(value, LIFECYCLE_CONTEXT_KEYS, "confirmation registration");
  requireFamily(value.family);
  // require the exact unopened registered lifecycle projection
  if (value.contractVersion !== "forecast-adjustment-lifecycle-ledger/v2" ||
      value.candidateKind !== CANDIDATE_KINDS.get(value.family) ||
      value.accessState !== "registered" || value.actionState !== "none" ||
      value.candidateReportSha256 !== null || value.actionIdentitySha256 !== null) {
    throw new TypeError("confirmation registration lifecycle differs");
  }
  for (const field of [
    "candidateSha256", "cohortLineageSha256", "gateManifestSha256", "inputHeadSha256",
    "registrationSha256", "reservedKeySha256", "sourceLineageSha256",
  ]) {
    requireHash(value[field], field);
  }
  requireInstant(value.firstTargetAt, "firstTargetAt");
  requireInstant(value.terminalAccessAt, "terminalAccessAt");
  requireLocalDate(value.intervalStartLocalDate, "intervalStartLocalDate");
  requireLocalDate(value.intervalEndExclusiveLocalDate, "intervalEndExclusiveLocalDate");
  const unsigned = Object.fromEntries([
    "contractVersion", "family", "candidateKind", "candidateSha256", "cohortLineageSha256",
    "sourceLineageSha256", "reservedKeySha256", "intervalStartLocalDate",
    "intervalEndExclusiveLocalDate", "firstTargetAt", "terminalAccessAt", "gateManifestSha256",
    "inputHeadSha256",
  ].map(
    // preserve the lifecycle registration hash field order independently of object order
    (field) => [field, value[field]],
  ));
  // recompute the preregistered member identity and exact span
  if (value.registrationSha256 !== sha256(canonicalJsonBytes(unsigned)) ||
      daysBetween(value.intervalStartLocalDate, value.intervalEndExclusiveLocalDate) !==
        INTERVAL_DAYS.get(value.family)) {
    throw new TypeError("confirmation registration identity differs");
  }
  return value;
}

// validate one durable terminal burn record and its content identity
function validateLifecycleAccess(value, registration) {
  requireExactKeys(value, ACCESS_KEYS, "confirmation access");
  for (const field of LIFECYCLE_CONTEXT_KEYS) {
    // preserve every registration field except the expected burn state
    if (field !== "accessState" && value[field] !== registration[field]) {
      throw new TypeError("confirmation access registration differs");
    }
  }
  // require the one state transition that permits value parsing
  if (value.accessState !== "burned") {
    throw new TypeError("confirmation access is not burned");
  }
  for (const field of [
    "accessSha256", "expectedKeySetSha256", "revisionCatalogWatermarkSha256",
    "targetComparatorSnapshotRootSha256",
  ]) {
    requireHash(value[field], field);
  }
  requireInstant(value.accessedAt, "accessedAt");
  requireInstant(value.targetCutoffAt, "targetCutoffAt");
  const unsigned = { ...value };
  delete unsigned.accessSha256;
  // bind access to the exact snapshot and terminal clock
  if (value.accessSha256 !== sha256(canonicalJsonBytes(unsigned)) ||
      Date.parse(value.accessedAt) < Date.parse(registration.terminalAccessAt)) {
    throw new TypeError("confirmation access identity differs");
  }
  return value;
}

// validate one future-only public database registration
function validateShadowRegistration(value, family, epochWitnessSha256) {
  const v3 = requireObject(value, "shadow registration") &&
    Object.hasOwn(value, "epochWitnessSha256");
  requireExactKeys(value, v3 ? REGISTRATION_V3_KEYS : REGISTRATION_BASE_KEYS,
    "shadow registration");
  requireFamily(value.family);
  // bind the public registration to this family and future-only epoch
  if (!v3 || value.family !== family || value.siteKey !== "ballydidean" ||
      value.epochWitnessSha256 !== epochWitnessSha256) {
    throw new TypeError("shadow registration lineage differs");
  }
  for (const field of [
    "artifactSha256", "candidateSha256", "cohortSha256", "policySha256",
    "registrationSha256", "reservedKeySha256", "sourceSha256",
  ]) {
    requireHash(value[field], field);
  }
  for (const field of ["intervalEndAt", "intervalStartAt", "targetCutoffAt", "terminalAt"]) {
    requireInstant(value[field], field);
  }
  requireHash(value.epochWitnessSha256, "epochWitnessSha256");
  requireHash(value.scheduleContractSha256, "scheduleContractSha256");
  requireNullableHash(value.predecessorRegistrationSha256, "predecessorRegistrationSha256");
  const preimage = `${[
    "adjustment-shadow-registration/v3", value.siteKey, value.family, value.candidateSha256,
    value.artifactSha256, value.policySha256, value.cohortSha256, value.reservedKeySha256,
    value.sourceSha256, value.epochWitnessSha256, value.scheduleContractSha256,
    value.predecessorRegistrationSha256 ?? "none", value.intervalStartAt, value.intervalEndAt,
    value.targetCutoffAt, value.terminalAt,
  ].join("\n")}\n`;
  // reject a literal registration hash claim without recomputation
  if (sha256(Buffer.from(preimage)) !== value.registrationSha256) {
    throw new TypeError("shadow registration identity differs");
  }
  return value;
}

// cross-bind public and lifecycle windows before parsing values
function validateRegistrationCrossBinding(registration, access, shadow) {
  // require the same candidate, source, reserved member and finite clocks
  if (registration.candidateSha256 !== shadow.candidateSha256 ||
      registration.sourceLineageSha256 !== shadow.sourceSha256 ||
      registration.reservedKeySha256 !== shadow.reservedKeySha256 ||
      registration.intervalStartLocalDate !== localDateAt(shadow.intervalStartAt) ||
      registration.intervalEndExclusiveLocalDate !== localDateAt(shadow.intervalEndAt) ||
      registration.terminalAccessAt !== shadow.terminalAt ||
      access.targetCutoffAt !== shadow.targetCutoffAt) {
    throw new TypeError("confirmation and shadow registrations differ");
  }
}

// validate one blinded chunk metadata record
function validateChunkMetadata(value, family) {
  const parted = Object.hasOwn(value, "contractVersion");
  requireExactKeys(value, parted ? CHUNK_V3_KEYS : CHUNK_V1_KEYS,
    "confirmation chunk metadata");
  if (parted) {
    requireLocalDate(value.captureLocalDate, "captureLocalDate");
    requireLocalDate(value.fromLocalDate, "fromLocalDate");
    requireLocalDate(value.toLocalDateExclusive, "toLocalDateExclusive");
    for (const field of [
      "partSha256", "expectedKeySubsetSha256", "eligiblePredictionSubsetSha256",
      "missingKeySubsetSha256",
    ]) {
      requireHash(value[field], field);
    }
    // require one complete bounded physical part under the additive grammar
    if (value.contractVersion !== ADJUSTMENT_CONFIRMATION_CHUNK_PART_V3_VERSION ||
      !Number.isInteger(value.logicalChunkIndex) || value.logicalChunkIndex < 0 ||
      value.logicalChunkIndex >= CHUNK_COUNTS.get(family) ||
      !Number.isInteger(value.partIndex) || value.partIndex < 0 ||
      !Number.isInteger(value.partCount) || value.partCount < 1 || value.partCount > 24 ||
      value.partIndex >= value.partCount || !Number.isSafeInteger(value.recordCount) ||
      value.recordCount < 0 || value.recordCount > 8_192 ||
      !Number.isSafeInteger(value.expectedKeyCount) || value.expectedKeyCount < 1 ||
      value.expectedKeyCount > 8_192 || !Number.isSafeInteger(value.missingKeyCount) ||
      value.missingKeyCount < 0 ||
      value.recordCount + value.missingKeyCount !== value.expectedKeyCount) {
      throw new TypeError("confirmation chunk metadata bounds differ");
    }
    return value;
  }
  // require exact order and bounded record population
  if (!Number.isInteger(value.chunkIndex) || value.chunkIndex < 0 ||
      !Number.isSafeInteger(value.recordCount) ||
      value.recordCount < 0 || value.recordCount > 8_192) {
    throw new TypeError("confirmation chunk metadata bounds differ");
  }
  requireLocalDate(value.fromLocalDate, "fromLocalDate");
  requireLocalDate(value.toLocalDateExclusive, "toLocalDateExclusive");
  for (const field of [
    "chunkSha256", "eligiblePredictionSubsetSha256", "expectedKeySubsetSha256",
    "missingKeySubsetSha256",
  ]) {
    requireHash(value[field], field);
  }
  // retain the family-specific index ceiling independently from assembly
  if (value.chunkIndex >= CHUNK_COUNTS.get(family)) {
    throw new TypeError("confirmation chunk index differs");
  }
  return value;
}

// require one exact next physical chunk coordinate
function evaluationChunkFollows(previous, current, version, physicalIndex) {
  const parted = version === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION;

  // begin at the first logical coordinate under either grammar
  if (previous === null) {
    return parted
      ? current.logicalChunkIndex === 0 && current.partIndex === 0
      : current.chunkIndex === physicalIndex;
  }
  const previousParted = Object.hasOwn(previous, "contractVersion");

  // never mix physical part and legacy metadata domains
  if (previousParted !== parted) {
    return false;
  }
  if (!parted) {
    return current.chunkIndex === physicalIndex;
  }
  if (current.logicalChunkIndex === previous.logicalChunkIndex) {
    return current.partCount === previous.partCount &&
      current.partIndex === previous.partIndex + 1 &&
      current.captureLocalDate > previous.captureLocalDate &&
      current.fromLocalDate === previous.fromLocalDate &&
      current.toLocalDateExclusive === previous.toLocalDateExclusive;
  }
  return previous.partIndex === previous.partCount - 1 && current.partIndex === 0 &&
    current.logicalChunkIndex === previous.logicalChunkIndex + 1;
}

// require every shadow receipt and causal clock to be post-epoch
function validateFutureOnlyCapsule(capsule, witness, targetCutoffAt) {
  const receipt = capsule.revisionReceipt;
  requireInstant(receipt.archiveCommittedAt, "archiveCommittedAt");
  // reject zero, pre-epoch and post-snapshot receipt identities
  if (typeof receipt.archiveCommitOrdinal !== "string" ||
      !/^[1-9]\d{0,19}$/u.test(receipt.archiveCommitOrdinal) ||
      Date.parse(receipt.archiveCommittedAt) < Date.parse(witness.epochAt) ||
      Date.parse(receipt.archiveCommittedAt) > Date.parse(targetCutoffAt)) {
    throw new TypeError("daily evaluation revision receipt is outside the future-only snapshot");
  }
  const instants = capsule.source.rows.flatMap(
    // retain each source, receipt and target clock separately
    (row) => [row.receivedAt, row.referenceAt, row.validAt],
  );
  instants.push(capsule.source.issuedAt);
  collectOptionalCausalInstants(capsule.source, instants);
  // prevent a post-epoch receipt from laundering older source bytes
  for (const instant of instants) {
    requireInstant(instant, "future-only causal instant");
    if (Date.parse(instant) < Date.parse(witness.epochAt)) {
      throw new TypeError("daily evaluation causal instant predates its epoch");
    }
  }
}

// collect closed family-specific causal clocks without scanning arbitrary fields
function collectOptionalCausalInstants(source, instants) {
  // preserve every temperature rolling-state clock
  if (source.family === "temperature") {
    const state = source.recentErrorState;
    instants.push(state.targetRunInitializedAt, state.windowEndValidAt);
    for (const instant of [state.maximumSourceRunInitializedAt, state.maximumSourceValidAt]) {
      // omit only explicit missing causal maxima
      if (instant !== null) {
        instants.push(instant);
      }
    }
    return;
  }
  // wind has no causal objects beyond its complete source rows
  if (source.family === "wind") {
    return;
  }
  const causal = source.causalInputs;
  for (const capture of causal.captureSet) {
    instants.push(capture.completedAt);
    for (const instant of [capture.runInitializedAt, capture.windowStart, capture.windowEndExclusive]) {
      // retain every present capture boundary
      if (instant !== null) {
        instants.push(instant);
      }
    }
  }
  for (const run of [causal.currentRun, ...causal.priorRuns]) {
    instants.push(run.runInitializedAt, run.completedAt);
  }
  for (const hour of causal.stationHours) {
    instants.push(hour.hourAt, hour.receivedAt);
  }
}

// derive one immutable record key from the archived prediction geometry
function evaluationRecordKey(body, row, metric, contractVersion) {
  return contractVersion === ADJUSTMENT_MAINTENANCE_EVALUATION_CHUNK_V3_VERSION
    ? `${body.dueKey}/${row.leadHours}/${metric ?? body.family}`
    : `${body.dueKey}/${row.validAt}/${metric ?? body.family}`;
}

// decode one fixed capture scheduler instant from its closed due key
function captureDueAt(dueKey) {
  if (typeof dueKey !== "string" || !dueKey.startsWith("capture/") ||
      !INSTANT.test(dueKey.slice(8))) {
    throw new TypeError("daily evaluation capture due key is invalid");
  }
  return dueKey.slice(8);
}

// project the seven fixed wind lead bands
function windPairKey(metric, leadHours) {
  const start = Math.floor((leadHours - 1) / 24) * 24 + 1;
  const end = start + 23;
  return `${metric}:${String(start).padStart(3, "0")}-${String(end).padStart(3, "0")}`;
}

// restore the canonical metrics shape used by wind inference
function windMetrics(windSpeedMps, windGustMps) {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: null,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: null,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps,
    windSpeedMps,
  };
}

// decode one explicit nullable binary64 field
function decodeNullable(value) {
  return value === null ? null : decodeMaintenanceBinary64(value);
}

// validate the controller's exact daily due projection
function validateDailyDue(value) {
  requireExactKeys(value, ["dueKey", "family", "mode", "originalCutoffAt", "scope"],
    "daily due");
  // admit only daily work without a fabricated family authority
  if (value.family !== null || value.mode !== "daily" || value.scope !== "daily" ||
      typeof value.dueKey !== "string" || !/^daily\/\d{4}-\d{2}-\d{2}$/u.test(value.dueKey)) {
    throw new TypeError("daily due differs");
  }
  requireInstant(value.originalCutoffAt, "originalCutoffAt");
  return value;
}

// parse one bounded canonical json document
function parseCanonicalBytes(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError(`${label} JSON is invalid`);
  }
  // reject alternate whitespace and key-order encodings
  if (!canonicalBytes(value).equals(bytes)) {
    throw new TypeError(`${label} is not canonical`);
  }
  return value;
}

// encode one canonical json value as immutable bytes
function canonicalBytes(value) {
  return Buffer.from(canonicalJsonBytes(value));
}

// decode canonical base64 without accepting aliases
function decodeBase64(value, maximumBytes, label) {
  requireBase64(value, label);
  const bytes = Buffer.from(value, "base64");
  // enforce the fixed decoded cap and canonical encoding
  if (bytes.length < 2 || bytes.length > maximumBytes || bytes.toString("base64") !== value) {
    throw new TypeError(`${label} is invalid`);
  }
  return bytes;
}

// validate one probability triplet without extension fields
function validateProbability(value, label) {
  requireExactKeys(value, ["atLeast0_1", "atLeast1_0", "atLeast2_5"], label);
  for (const probability of Object.values(value)) {
    // retain only physical probabilities
    if (typeof probability !== "number" || !Number.isFinite(probability) ||
        probability < 0 || probability > 1) {
      throw new TypeError(`${label} is invalid`);
    }
  }
}

// validate sorted unique bounded string arrays
function validateSortedUniqueStrings(values, label) {
  // reject aliases, duplicates and unbounded keys
  if (values.some((value) => typeof value !== "string" || value.length < 1 || value.length > 512) ||
      new Set(values).size !== values.length ||
      JSON.stringify(values) !== JSON.stringify([...values].sort())) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require a plain exact-key object
function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  // refuse omitted and extension fields
  if (Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new TypeError(`${label} fields differ`);
  }
}

// require one plain record
function requireObject(value, label) {
  // reject arrays, null and exotic objects
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

// require one supported maintenance family
function requireFamily(value) {
  // keep policy dispatch closed
  if (!FAMILIES.has(value)) {
    throw new TypeError("maintenance family is invalid");
  }
}

// require one lowercase sha-256 identity
function requireHash(value, label) {
  // reject literal labels and alternate digest encodings
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one nullable lowercase sha-256 identity
function requireNullableHash(value, label) {
  // preserve explicit absence only
  if (value !== null) {
    requireHash(value, label);
  }
}

// require one normalized utc millisecond instant
function requireInstant(value, label) {
  // reject clock aliases before chronology comparisons
  if (typeof value !== "string" || !INSTANT.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one real calendar date
function requireLocalDate(value, label) {
  // reject normalized-looking impossible dates
  if (typeof value !== "string" || !LOCAL_DATE.test(value) ||
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one finite numerical value
function requireFinite(value, label) {
  // reject null, infinities and coercible strings
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one bounded noncontrol string
function requireBoundedString(value, label, maximum) {
  // reject empty, control-bearing and oversized labels
  if (typeof value !== "string" || value.length < 1 || value.length > maximum ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one syntactically valid base64 string
function requireBase64(value, label) {
  // reject whitespace and URL-safe aliases
  if (typeof value !== "string" || value.length < 4 || value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// format one instant in the fixed farm timezone
function localDateAt(instant) {
  return LOCAL_DATE_FORMATTER.format(new Date(instant));
}

// count exact utc calendar dates for fixed confirmation spans
function daysBetween(from, to) {
  return (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
    86_400_000;
}

// advance one local calendar date without applying a timezone offset
function addLocalDates(localDate, days) {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString().slice(0, 10);
}

// hash exact canonical or binary bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
