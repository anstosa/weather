import { createHash } from "node:crypto";

import {
  parseShadowRevisionCapsule,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  scalarNetworkActual,
} from "./adjustment-maintenance-runtime/forecast/algorithm-v1.js";
import {
  canonicalJsonBytes,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  decodeMaintenanceBinary64,
  encodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";
import {
  FORECAST_OBSERVATION_SOURCE_LINEAGES,
  FORECAST_OBSERVATION_STATIONS,
} from "./adjustment-maintenance-runtime/node_modules/@weather/domain/dist/forecast-adjustment.js";
import {
  buildAdjustmentMaintenanceEvaluationChunkV3,
  buildAdjustmentMaintenanceExpectedKeyPlanV3,
} from "./adjustment_daily_evaluation.mjs";
import {
  parseForecastAdjustmentMaintenanceRevisionProjection,
  parseForecastAdjustmentMaintenanceShadowCapsule,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  assembleConfirmationManifest,
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";

export const ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION =
  "adjustment-maintenance-derived-target/v1";
export const ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUE_PLAN_VERSION =
  "adjustment-maintenance-confirmation-value-plan/v1";
export const ADJUSTMENT_MAINTENANCE_CONFIRMATION_PLAN_GRAPH_VERSION =
  "adjustment-maintenance-confirmation-plan-graph/v1";
export const ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_PLAN_VERSION =
  "adjustment-maintenance-unsupported-confirmation-value-plan/v1";
export const ADJUSTMENT_MAINTENANCE_UNSUPPORTED_PLAN_GRAPH_VERSION =
  "adjustment-maintenance-confirmation-plan-graph/v2";
export const ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUES_VERSION =
  "adjustment-maintenance-confirmation-values/v1";
export const ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_VALUES_VERSION =
  "adjustment-maintenance-unsupported-confirmation-values/v1";
export const ADJUSTMENT_MAINTENANCE_CONFIRMATION_TERMINAL_GRAPH_VERSION =
  "adjustment-maintenance-confirmation-terminal-graph/v1";
export const ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_GRAPH_VERSION =
  "adjustment-maintenance-confirmation-unsupported-terminal-graph/v1";

const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TARGET_KEYS = [
  "contractVersion", "family", "firstEdgeCommittedAt", "metric", "rows", "target64",
  "validAt",
];
const TARGET_ROW_KEYS = [
  "archiveCommitOrdinal", "graphManifestSha256", "memberSha256", "payloadIdentitySha256",
  "receiptSha256", "rowIndex", "sourceKey",
];
const METRIC_FIELDS = Object.freeze({
  temperatureC: "temperatureC64",
  windGustMps: "windGustMps64",
  windSpeedMps: "windSpeedMps64",
});
const FAMILY_METRICS = Object.freeze({
  temperature: new Set(["temperatureC"]),
  wind: new Set(["windGustMps", "windSpeedMps"]),
});

// freeze a value-blind exact-key and archived-capsule population before burn
export function planAdjustmentMaintenanceDailyConfirmation(input) {
  requireExactKeys(input, [
    "confirmationRegistration", "due", "epochWitness", "history", "shadowRegistration",
  ], "confirmation value plan input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const registration = validateConfirmationRegistration(input.confirmationRegistration);
  const shadow = validateConfirmationShadowRegistration(
    input.shadowRegistration,
    registration.family,
    witness.witnessSha256,
  );
  validateConfirmationCrossBinding(registration, shadow);
  validateConfirmationDue(input.due);
  validateConfirmationHistory(input.history);
  const keyPlan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: shadow.family,
    intervalEndAt: shadow.intervalEndAt,
    intervalStartAt: shadow.intervalStartAt,
  });

  // require preregistration to bind the complete all-cycle expected population
  if (shadow.reservedKeySha256 !== keyPlan.reservedKeySha256 ||
      registration.reservedKeySha256 !== keyPlan.reservedKeySha256) {
    throw new TypeError("confirmation expected key population differs");
  }
  const expectedDueKeys = expectedDueKeySet(keyPlan);
  const capsules = new Map();

  // inspect only canonical outer capsule identities without decoding value bodies
  for (const occurrence of input.history.occurrences) {
    if (occurrence.publicationDisposition !== "published" ||
        occurrence.payloadKind !== "adjustment-shadow-revision-capsule/v2") {
      continue;
    }
    validateConfirmationOccurrenceEnvelope(occurrence);
    const capsule = parseShadowRevisionCapsule(Buffer.from(occurrence.payloadBytes));
    if (capsule.metadata.registrationSha256 !== shadow.registrationSha256 ||
        !expectedDueKeys.has(capsule.metadata.dueKey)) {
      continue;
    }
    const receipt = occurrence.receipts[0];
    if (occurrence.receipts.length !== 1 ||
        canonicalJsonBytes(receipt) !== canonicalJsonBytes(capsule.revisionReceipt) ||
        Date.parse(receipt.archiveCommittedAt) < Date.parse(witness.epochAt) ||
        Date.parse(receipt.archiveCommittedAt) > Date.parse(shadow.targetCutoffAt) ||
        Date.parse(capsule.predictionCommittedAt) > Date.parse(shadow.targetCutoffAt)) {
      throw new TypeError("confirmation capsule receipt differs");
    }
    if (capsules.has(capsule.metadata.dueKey)) {
      throw new TypeError("confirmation capsule due is duplicated");
    }
    capsules.set(capsule.metadata.dueKey, Object.freeze({
      comparatorMemberSha256: capsule.comparatorSha256,
      dueKey: capsule.metadata.dueKey,
      graphManifestSha256: occurrence.graphManifestSha256,
      payloadIdentitySha256: occurrence.payloadIdentitySha256,
      predictionBodySha256: capsule.metadata.predictionBodySha256,
      receiptSha256: receipt.receiptSha256,
      sourceProjectionSha256: capsule.sourceProjectionSha256,
      sourceReceiptSha256: capsule.metadata.sourceReceiptSha256,
    }));
  }

  // return no values when any preregistered capture is absent
  if (capsules.size !== expectedDueKeys.size ||
      [...expectedDueKeys].some((dueKey) => !capsules.has(dueKey))) {
    return pendingConfirmation(registration);
  }
  const capsuleIdentities = [...capsules.values()].sort(
    // make historical page ordering irrelevant to the blinded snapshot
    (left, right) => left.dueKey.localeCompare(right.dueKey),
  );
  const revisionCatalogWatermarkSha256 = sha256(canonicalJsonBytes({
    archiveCommitOrdinal: input.history.catalog.archiveCommitOrdinal,
    catalogFrontierSha256: input.history.catalog.frontierRootSha256,
    historyRootSha256: input.history.historyRootSha256,
  }));
  const eligiblePredictionSetSha256 = sha256(canonicalJsonBytes(capsuleIdentities));
  const planGraphUnsigned = Object.freeze({
    contractVersion: ADJUSTMENT_MAINTENANCE_CONFIRMATION_PLAN_GRAPH_VERSION,
    eligiblePredictionSetSha256,
    entries: Object.freeze(capsuleIdentities),
    family: registration.family,
    registrationSha256: registration.registrationSha256,
  });
  const planGraph = Object.freeze({
    ...planGraphUnsigned,
    planGraphSha256: sha256(canonicalJsonBytes(planGraphUnsigned)),
  });
  const snapshotRootSha256 = sha256(canonicalJsonBytes({
    eligiblePredictionSetSha256,
    expectedKeySetSha256: keyPlan.reservedKeySha256,
    targetCutoffAt: shadow.targetCutoffAt,
  }));
  const entryCount = keyPlan.logicalChunks.reduce(
    // count every preregistered metric cell without reading outcomes
    (count, logical) => count + logical.expectedKeyCount,
    0,
  );
  return Object.freeze({
    contractVersion: ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUE_PLAN_VERSION,
    eligiblePredictionSetSha256,
    entryCount,
    expectedKeySetSha256: keyPlan.reservedKeySha256,
    family: registration.family,
    planGraph,
    registrationSha256: registration.registrationSha256,
    revisionCatalogWatermarkSha256,
    snapshotRootSha256,
    state: "planned",
    targetCutoffAt: shadow.targetCutoffAt,
  });
}

// plan one value-blind unsupported terminal population with explicit absent cycles
export function planAdjustmentMaintenanceUnsupportedDailyConfirmation(input) {
  requireExactKeys(input, [
    "confirmationRegistration", "due", "epochWitness", "history", "shadowRegistration",
  ], "unsupported confirmation value plan input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const registration = validateConfirmationRegistration(input.confirmationRegistration);
  const shadow = validateConfirmationShadowRegistration(
    input.shadowRegistration,
    registration.family,
    witness.witnessSha256,
  );
  validateConfirmationCrossBinding(registration, shadow);
  validateConfirmationDue(input.due);
  validateConfirmationHistory(input.history);
  const keyPlan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: shadow.family,
    intervalEndAt: shadow.intervalEndAt,
    intervalStartAt: shadow.intervalStartAt,
  });
  // preserve the complete preregistered population even when history is absent
  if (shadow.reservedKeySha256 !== keyPlan.reservedKeySha256 ||
      registration.reservedKeySha256 !== keyPlan.reservedKeySha256) {
    throw new TypeError("unsupported confirmation expected key population differs");
  }
  const expectedDueKeys = expectedDueKeySet(keyPlan);
  const entries = collectBlindedConfirmationCapsules(
    input.history,
    shadow,
    witness,
    expectedDueKeys,
  );
  const presentDueKeys = new Set(entries.map((entry) => entry.dueKey));
  const missingDueKeys = [...expectedDueKeys].filter(
    // retain exact absent preregistered cycles without opening prediction values
    (dueKey) => !presentDueKeys.has(dueKey),
  ).sort();
  const eligiblePredictionSetSha256 = sha256(canonicalJsonBytes(entries));
  const missingDueKeySetSha256 = sha256(canonicalJsonBytes(missingDueKeys));
  const planGraphUnsigned = Object.freeze({
    contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_PLAN_GRAPH_VERSION,
    eligiblePredictionSetSha256,
    entries: Object.freeze(entries),
    family: registration.family,
    missingDueKeySetSha256,
    missingDueKeys: Object.freeze(missingDueKeys),
    registrationSha256: registration.registrationSha256,
  });
  const planGraph = Object.freeze({
    ...planGraphUnsigned,
    planGraphSha256: sha256(canonicalJsonBytes(planGraphUnsigned)),
  });
  const revisionCatalogWatermarkSha256 = confirmationRevisionCatalogWatermark(input.history);
  const snapshotRootSha256 = sha256(canonicalJsonBytes({
    eligiblePredictionSetSha256,
    expectedKeySetSha256: keyPlan.reservedKeySha256,
    missingDueKeySetSha256,
    targetCutoffAt: shadow.targetCutoffAt,
  }));
  const entryCount = keyPlan.logicalChunks.reduce(
    // count every preregistered metric cell without reading outcomes
    (count, logical) => count + logical.expectedKeyCount,
    0,
  );
  return Object.freeze({
    contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_PLAN_VERSION,
    eligiblePredictionSetSha256,
    entryCount,
    expectedKeySetSha256: keyPlan.reservedKeySha256,
    family: registration.family,
    missingDueKeyCount: missingDueKeys.length,
    missingDueKeySetSha256,
    planGraph,
    registrationSha256: registration.registrationSha256,
    revisionCatalogWatermarkSha256,
    snapshotRootSha256,
    state: "unsupported_planned",
    targetCutoffAt: shadow.targetCutoffAt,
  });
}

// assemble exact temperature or wind values only after terminal burn authority
export function assembleAdjustmentMaintenanceDailyConfirmation(input) {
  requireExactKeys(input, [
    "access", "confirmationRegistration", "due", "epochWitness", "history", "plan",
    "shadowRegistration",
  ], "confirmation value assembly input");
  const currentPlan = planAdjustmentMaintenanceDailyConfirmation({
    confirmationRegistration: input.confirmationRegistration,
    due: input.due,
    epochWitness: input.epochWitness,
    history: input.history,
    shadowRegistration: input.shadowRegistration,
  });
  if (currentPlan.state === "pending") {
    return currentPlan;
  }
  requireExactKeys(input.plan, [
    "contractVersion", "eligiblePredictionSetSha256", "entryCount", "expectedKeySetSha256",
    "family", "planGraph", "registrationSha256", "revisionCatalogWatermarkSha256",
    "snapshotRootSha256", "state", "targetCutoffAt",
  ], "confirmation value plan");
  validateAdjustmentMaintenanceConfirmationPlanGraph(input.plan.planGraph);
  if (canonicalJsonBytes(input.plan) !== canonicalJsonBytes(currentPlan)) {
    throw new TypeError("confirmation value plan drifted before burn");
  }
  validateConfirmationAccess(input.access, currentPlan, input.confirmationRegistration);
  const family = input.confirmationRegistration.family;

  // require the dedicated rain assembler rather than an endless pending adapter
  if (family === "rain") {
    throw new TypeError("rain confirmation requires the dedicated fixed-gauge assembler");
  }
  const keyPlan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family,
    intervalEndAt: input.shadowRegistration.intervalEndAt,
    intervalStartAt: input.shadowRegistration.intervalStartAt,
  });
  const indexes = buildConfirmationHistoryIndexes({
    epochWitness: input.epochWitness,
    family,
    history: input.history,
    registrationSha256: input.shadowRegistration.registrationSha256,
    targetCutoffAt: currentPlan.targetCutoffAt,
  });
  const targetCache = new Map();
  const chunks = [];
  const derivedTargets = new Map();
  const graphBindings = [];
  const graphManifestSha256s = new Set();
  const requiredMemberIdentitySha256s = new Set();

  // resolve every pretarget physical part without outcome-dependent repartitioning
  for (const logical of keyPlan.logicalChunks) {
    for (const part of logical.parts) {
      const records = [];
      // resolve every expected cell or keep the whole confirmation pending
      for (const key of part.expectedKeys) {
        const selector = parseExpectedConfirmationKey(key, family);
        const capsuleEntry = indexes.capsules.get(selector.dueKey);
        if (capsuleEntry === undefined) {
          return pendingConfirmation(input.confirmationRegistration);
        }
        const resolved = resolveConfirmationRecord({
          capsuleEntry,
          family,
          indexes,
          key,
          metric: selector.metric,
          rowIndex: selector.leadHours - 1,
          targetCache,
          targetCutoffAt: currentPlan.targetCutoffAt,
          witness: input.epochWitness,
        });
        if (resolved === null) {
          return pendingConfirmation(input.confirmationRegistration);
        }
        records.push(resolved.record);
        derivedTargets.set(resolved.derivedTarget.targetMemberSha256,
          resolved.derivedTarget);
        graphBindings.push(resolved.graphBinding);
        for (const graph of resolved.graphManifestSha256s) {
          graphManifestSha256s.add(graph);
        }
        for (const identity of resolved.requiredMemberIdentitySha256s) {
          requiredMemberIdentitySha256s.add(identity);
        }
      }
      chunks.push(buildAdjustmentMaintenanceEvaluationChunkV3({
        captureLocalDate: part.captureLocalDate,
        confirmationRegistrationSha256: input.confirmationRegistration.registrationSha256,
        family,
        fromLocalDate: logical.fromLocalDate,
        logicalChunkIndex: logical.logicalChunkIndex,
        missingKeys: [],
        partCount: part.partCount,
        partIndex: part.partIndex,
        records,
        shadowRegistrationSha256: input.shadowRegistration.registrationSha256,
        toLocalDateExclusive: logical.toLocalDateExclusive,
      }));
    }
  }
  const fullManifest = assembleConfirmationManifest({
    access: input.access,
    chunks: chunks.map(
      // expose only value-blind metadata to the lifecycle journal
      (chunk) => chunk.metadata,
    ),
    registration: input.confirmationRegistration,
  });
  graphBindings.sort(
    // preserve expected-key order independently from archive page order
    (left, right) => left.key.localeCompare(right.key),
  );
  const terminalGraphUnsigned = Object.freeze({
    bindings: Object.freeze(graphBindings),
    contractVersion: ADJUSTMENT_MAINTENANCE_CONFIRMATION_TERMINAL_GRAPH_VERSION,
    derivedTargetMemberSha256s: Object.freeze([...derivedTargets.keys()].sort()),
    graphManifestSha256s: Object.freeze([...graphManifestSha256s].sort()),
  });
  const terminalGraph = Object.freeze({
    ...terminalGraphUnsigned,
    terminalGraphSha256: sha256(canonicalJsonBytes(terminalGraphUnsigned)),
  });
  return Object.freeze({
    chunks: Object.freeze(chunks),
    contractVersion: ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUES_VERSION,
    derivedTargets: Object.freeze([...derivedTargets.values()].sort(
      // address each immutable derived target by its exact member identity
      (left, right) => left.targetMemberSha256.localeCompare(right.targetMemberSha256),
    )),
    family,
    fullManifest,
    graphManifestSha256s: Object.freeze([...graphManifestSha256s].sort()),
    registrationSha256: input.confirmationRegistration.registrationSha256,
    requiredMemberIdentitySha256s: Object.freeze([...requiredMemberIdentitySha256s].sort()),
    state: "burned_complete",
    terminalGraph,
  });
}

// assemble every logical part after burn without creating qualified full-member authority
export function assembleAdjustmentMaintenanceUnsupportedDailyConfirmation(input) {
  requireExactKeys(input, [
    "access", "confirmationRegistration", "due", "epochWitness", "history", "plan",
    "shadowRegistration",
  ], "unsupported confirmation value assembly input");
  const planInput = {
    confirmationRegistration: input.confirmationRegistration,
    due: input.due,
    epochWitness: input.epochWitness,
    history: input.history,
    shadowRegistration: input.shadowRegistration,
  };
  const completeBurn = input.plan?.contractVersion ===
    ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUE_PLAN_VERSION;
  const currentPlan = completeBurn
    ? planAdjustmentMaintenanceDailyConfirmation(planInput)
    : planAdjustmentMaintenanceUnsupportedDailyConfirmation(planInput);
  // preserve the original snapshot when a complete capsule burn later finds member gaps
  if (completeBurn) {
    requireExactKeys(input.plan, [
      "contractVersion", "eligiblePredictionSetSha256", "entryCount", "expectedKeySetSha256",
      "family", "planGraph", "registrationSha256", "revisionCatalogWatermarkSha256",
      "snapshotRootSha256", "state", "targetCutoffAt",
    ], "complete confirmation value plan");
    validateAdjustmentMaintenanceConfirmationPlanGraph(input.plan.planGraph);
  } else {
    requireExactKeys(input.plan, [
      "contractVersion", "eligiblePredictionSetSha256", "entryCount", "expectedKeySetSha256",
      "family", "missingDueKeyCount", "missingDueKeySetSha256", "planGraph",
      "registrationSha256", "revisionCatalogWatermarkSha256", "snapshotRootSha256", "state",
      "targetCutoffAt",
    ], "unsupported confirmation value plan");
    validateAdjustmentMaintenanceUnsupportedPlanGraph(input.plan.planGraph);
  }
  // reject a complete-plan branch that no longer has the burned capsule population
  if (currentPlan.state !== (completeBurn ? "planned" : "unsupported_planned")) {
    throw new TypeError("unsupported confirmation capsule population drifted before burn");
  }
  if (canonicalJsonBytes(input.plan) !== canonicalJsonBytes(currentPlan)) {
    throw new TypeError("unsupported confirmation value plan drifted before burn");
  }
  validateConfirmationAccess(input.access, currentPlan, input.confirmationRegistration);
  const family = input.confirmationRegistration.family;
  // retain rain source custody through its distinct fixed-gauge assembler
  if (family === "rain") {
    throw new TypeError("rain unsupported confirmation requires the dedicated fixed-gauge assembler");
  }
  const keyPlan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family,
    intervalEndAt: input.shadowRegistration.intervalEndAt,
    intervalStartAt: input.shadowRegistration.intervalStartAt,
  });
  const indexes = buildConfirmationHistoryIndexes({
    epochWitness: input.epochWitness,
    family,
    history: input.history,
    registrationSha256: input.shadowRegistration.registrationSha256,
    targetCutoffAt: currentPlan.targetCutoffAt,
  });
  const targetCache = new Map();
  const chunks = [];
  const derivedTargets = new Map();
  const graphBindings = [];
  const graphManifestSha256s = new Set();
  const missingKeys = [];
  const requiredMemberIdentitySha256s = new Set();

  // preserve every preregistered physical part even when its source graph is absent
  for (const logical of keyPlan.logicalChunks) {
    for (const part of logical.parts) {
      const partMissingKeys = [];
      const records = [];
      // resolve only genuine complete cells and mark every other expected cell missing
      for (const key of part.expectedKeys) {
        const selector = parseExpectedConfirmationKey(key, family);
        const capsuleEntry = indexes.capsules.get(selector.dueKey);
        const resolved = capsuleEntry === undefined
          ? null
          : resolveConfirmationRecord({
              capsuleEntry,
              family,
              indexes,
              key,
              metric: selector.metric,
              rowIndex: selector.leadHours - 1,
              targetCache,
              targetCutoffAt: currentPlan.targetCutoffAt,
              witness: input.epochWitness,
            });
        // never synthesize a comparison when any required member is absent
        if (resolved === null) {
          partMissingKeys.push(key);
          missingKeys.push(key);
          continue;
        }
        records.push(resolved.record);
        derivedTargets.set(resolved.derivedTarget.targetMemberSha256, resolved.derivedTarget);
        graphBindings.push(resolved.graphBinding);
        for (const graph of resolved.graphManifestSha256s) {
          graphManifestSha256s.add(graph);
        }
        for (const identity of resolved.requiredMemberIdentitySha256s) {
          requiredMemberIdentitySha256s.add(identity);
        }
      }
      chunks.push(buildAdjustmentMaintenanceEvaluationChunkV3({
        captureLocalDate: part.captureLocalDate,
        confirmationRegistrationSha256: input.confirmationRegistration.registrationSha256,
        family,
        fromLocalDate: logical.fromLocalDate,
        logicalChunkIndex: logical.logicalChunkIndex,
        missingKeys: partMissingKeys,
        partCount: part.partCount,
        partIndex: part.partIndex,
        records,
        shadowRegistrationSha256: input.shadowRegistration.registrationSha256,
        toLocalDateExclusive: logical.toLocalDateExclusive,
      }));
    }
  }
  graphBindings.sort(
    // preserve exact expected-key order independently from archive page order
    (left, right) => left.key.localeCompare(right.key),
  );
  missingKeys.sort();
  const terminalGraphUnsigned = Object.freeze({
    bindings: Object.freeze(graphBindings),
    contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_GRAPH_VERSION,
    derivedTargetMemberSha256s: Object.freeze([...derivedTargets.keys()].sort()),
    graphManifestSha256s: Object.freeze([...graphManifestSha256s].sort()),
    missingKeySetSha256: sha256(canonicalJsonBytes(missingKeys)),
  });
  const terminalGraph = Object.freeze({
    ...terminalGraphUnsigned,
    terminalGraphSha256: sha256(canonicalJsonBytes(terminalGraphUnsigned)),
  });
  return Object.freeze({
    chunks: Object.freeze(chunks),
    contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_VALUES_VERSION,
    derivedTargets: Object.freeze([...derivedTargets.values()].sort(
      // address each genuine target by its immutable member identity
      (left, right) => left.targetMemberSha256.localeCompare(right.targetMemberSha256),
    )),
    family,
    graphManifestSha256s: Object.freeze([...graphManifestSha256s].sort()),
    missingKeyCount: missingKeys.length,
    missingKeySetSha256: terminalGraphUnsigned.missingKeySetSha256,
    registrationSha256: input.confirmationRegistration.registrationSha256,
    requiredMemberIdentitySha256s: Object.freeze([...requiredMemberIdentitySha256s].sort()),
    state: "burned_unsupported",
    terminalGraph,
  });
}

// validate one value-blind capsule graph before owner burn opens any prediction values
export function validateAdjustmentMaintenanceConfirmationPlanGraph(value) {
  requireExactKeys(value, [
    "contractVersion", "eligiblePredictionSetSha256", "entries", "family", "planGraphSha256",
    "registrationSha256",
  ], "confirmation plan graph");
  // require one closed family graph with at least one eligible capsule
  if (value.contractVersion !== ADJUSTMENT_MAINTENANCE_CONFIRMATION_PLAN_GRAPH_VERSION ||
      !["temperature", "wind", "rain"].includes(value.family) ||
      !Array.isArray(value.entries) || value.entries.length < 1) {
    throw new TypeError("confirmation plan graph identity differs");
  }
  for (const field of [
    "eligiblePredictionSetSha256", "planGraphSha256", "registrationSha256",
  ]) {
    requireHash(value[field], field);
  }
  let previousDueKey = null;
  // bind every capsule payload, receipt, source, body and comparator to its retained graph
  for (const entry of value.entries) {
    requireExactKeys(entry, [
      "comparatorMemberSha256", "dueKey", "graphManifestSha256", "payloadIdentitySha256",
      "predictionBodySha256", "receiptSha256", "sourceProjectionSha256",
      "sourceReceiptSha256",
    ], "confirmation plan graph entry");
    for (const field of [
      "comparatorMemberSha256", "graphManifestSha256", "payloadIdentitySha256",
      "predictionBodySha256", "receiptSha256", "sourceProjectionSha256",
      "sourceReceiptSha256",
    ]) {
      requireHash(entry[field], field);
    }
    // require canonical cycle ordering without duplicate capsule identities
    if (typeof entry.dueKey !== "string" ||
        !/^capture\/20\d{2}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(entry.dueKey) ||
        (previousDueKey !== null && entry.dueKey <= previousDueKey)) {
      throw new TypeError("confirmation plan graph entry order differs");
    }
    previousDueKey = entry.dueKey;
  }
  const eligiblePredictionSetSha256 = sha256(canonicalJsonBytes(value.entries));
  const unsigned = {
    contractVersion: value.contractVersion,
    eligiblePredictionSetSha256: value.eligiblePredictionSetSha256,
    entries: value.entries,
    family: value.family,
    registrationSha256: value.registrationSha256,
  };
  // recompute both the eligible population root and the archiveable graph root
  if (eligiblePredictionSetSha256 !== value.eligiblePredictionSetSha256 ||
      sha256(canonicalJsonBytes(unsigned)) !== value.planGraphSha256) {
    throw new TypeError("confirmation plan graph hash differs");
  }
  return Object.freeze(structuredClone(value));
}

// validate one value-blind partial capsule graph without granting qualification
export function validateAdjustmentMaintenanceUnsupportedPlanGraph(value) {
  requireExactKeys(value, [
    "contractVersion", "eligiblePredictionSetSha256", "entries", "family",
    "missingDueKeySetSha256", "missingDueKeys", "planGraphSha256", "registrationSha256",
  ], "unsupported confirmation plan graph");
  if (value.contractVersion !== ADJUSTMENT_MAINTENANCE_UNSUPPORTED_PLAN_GRAPH_VERSION ||
      !["temperature", "wind", "rain"].includes(value.family) ||
      !Array.isArray(value.entries) || !Array.isArray(value.missingDueKeys)) {
    throw new TypeError("unsupported confirmation plan graph identity differs");
  }
  for (const field of [
    "eligiblePredictionSetSha256", "missingDueKeySetSha256", "planGraphSha256",
    "registrationSha256",
  ]) {
    requireHash(value[field], field);
  }
  let previousDueKey = null;
  // validate each present capsule identity in canonical due order
  for (const entry of value.entries) {
    requireExactKeys(entry, [
      "comparatorMemberSha256", "dueKey", "graphManifestSha256", "payloadIdentitySha256",
      "predictionBodySha256", "receiptSha256", "sourceProjectionSha256",
      "sourceReceiptSha256",
    ], "unsupported confirmation plan graph entry");
    for (const field of [
      "comparatorMemberSha256", "graphManifestSha256", "payloadIdentitySha256",
      "predictionBodySha256", "receiptSha256", "sourceProjectionSha256",
      "sourceReceiptSha256",
    ]) {
      requireHash(entry[field], field);
    }
    if (!validCaptureDueKey(entry.dueKey) ||
        (previousDueKey !== null && entry.dueKey <= previousDueKey)) {
      throw new TypeError("unsupported confirmation present due order differs");
    }
    previousDueKey = entry.dueKey;
  }
  previousDueKey = null;
  const present = new Set(value.entries.map((entry) => entry.dueKey));
  // validate each absent cycle without allowing overlap or duplicates
  for (const dueKey of value.missingDueKeys) {
    if (!validCaptureDueKey(dueKey) || present.has(dueKey) ||
        (previousDueKey !== null && dueKey <= previousDueKey)) {
      throw new TypeError("unsupported confirmation missing due order differs");
    }
    previousDueKey = dueKey;
  }
  const unsigned = {
    contractVersion: value.contractVersion,
    eligiblePredictionSetSha256: value.eligiblePredictionSetSha256,
    entries: value.entries,
    family: value.family,
    missingDueKeySetSha256: value.missingDueKeySetSha256,
    missingDueKeys: value.missingDueKeys,
    registrationSha256: value.registrationSha256,
  };
  if (value.eligiblePredictionSetSha256 !== sha256(canonicalJsonBytes(value.entries)) ||
      value.missingDueKeySetSha256 !== sha256(canonicalJsonBytes(value.missingDueKeys)) ||
      value.planGraphSha256 !== sha256(canonicalJsonBytes(unsigned))) {
    throw new TypeError("unsupported confirmation plan graph hash differs");
  }
  return Object.freeze(structuredClone(value));
}

// collect only authenticated outer capsule identities before value access
function collectBlindedConfirmationCapsules(history, shadow, witness, expectedDueKeys) {
  const capsules = new Map();
  // inspect only published v2 capsule envelopes
  for (const occurrence of history.occurrences) {
    if (occurrence.publicationDisposition !== "published" ||
        occurrence.payloadKind !== "adjustment-shadow-revision-capsule/v2") {
      continue;
    }
    validateConfirmationOccurrenceEnvelope(occurrence);
    const capsule = parseShadowRevisionCapsule(Buffer.from(occurrence.payloadBytes));
    if (capsule.metadata.registrationSha256 !== shadow.registrationSha256 ||
        !expectedDueKeys.has(capsule.metadata.dueKey)) {
      continue;
    }
    const receipt = occurrence.receipts[0];
    if (occurrence.receipts.length !== 1 ||
        canonicalJsonBytes(receipt) !== canonicalJsonBytes(capsule.revisionReceipt) ||
        Date.parse(receipt.archiveCommittedAt) < Date.parse(witness.epochAt) ||
        Date.parse(receipt.archiveCommittedAt) > Date.parse(shadow.targetCutoffAt) ||
        Date.parse(capsule.predictionCommittedAt) > Date.parse(shadow.targetCutoffAt) ||
        capsules.has(capsule.metadata.dueKey)) {
      throw new TypeError("unsupported confirmation capsule receipt differs");
    }
    capsules.set(capsule.metadata.dueKey, Object.freeze({
      comparatorMemberSha256: capsule.comparatorSha256,
      dueKey: capsule.metadata.dueKey,
      graphManifestSha256: occurrence.graphManifestSha256,
      payloadIdentitySha256: occurrence.payloadIdentitySha256,
      predictionBodySha256: capsule.metadata.predictionBodySha256,
      receiptSha256: receipt.receiptSha256,
      sourceProjectionSha256: capsule.sourceProjectionSha256,
      sourceReceiptSha256: capsule.metadata.sourceReceiptSha256,
    }));
  }
  return [...capsules.values()].sort(
    // make historical page ordering irrelevant
    (left, right) => left.dueKey.localeCompare(right.dueKey),
  );
}

// hash the immutable cold-history terminal frontier without opening values
function confirmationRevisionCatalogWatermark(history) {
  return sha256(canonicalJsonBytes({
    archiveCommitOrdinal: history.catalog.archiveCommitOrdinal,
    catalogFrontierSha256: history.catalog.frontierRootSha256,
    historyRootSha256: history.historyRootSha256,
  }));
}

// recognize one frozen six-hour capture cycle key
function validCaptureDueKey(value) {
  return typeof value === "string" &&
    /^capture\/20\d{2}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(value);
}

// index parser-authenticated capsules and serving projections by immutable content
function buildConfirmationHistoryIndexes(input) {
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const capsules = new Map();
  const actualBestMatch = new Map();
  const nativeSource = new Map();
  const targetByValidAt = new Map();

  // decode only the already-burned historical snapshot
  for (const occurrence of input.history.occurrences) {
    if (occurrence.publicationDisposition !== "published") {
      continue;
    }
    validateConfirmationOccurrenceEnvelope(occurrence);
    if (occurrence.payloadKind === "adjustment-shadow-revision-capsule/v2") {
      const outer = parseShadowRevisionCapsule(Buffer.from(occurrence.payloadBytes));
      if (outer.metadata.registrationSha256 !== input.registrationSha256) {
        continue;
      }
      const capsule = parseForecastAdjustmentMaintenanceShadowCapsule({
        capsuleBytes: Buffer.from(occurrence.payloadBytes),
      });
      const receipt = occurrence.receipts[0];
      if (occurrence.receipts.length !== 1 ||
          canonicalJsonBytes(receipt) !== canonicalJsonBytes(capsule.revisionReceipt) ||
          Date.parse(receipt.archiveCommittedAt) < Date.parse(witness.epochAt) ||
          Date.parse(receipt.archiveCommittedAt) > Date.parse(input.targetCutoffAt) ||
          Date.parse(outer.predictionCommittedAt) > Date.parse(input.targetCutoffAt) ||
          capsules.has(capsule.body.dueKey)) {
        throw new TypeError("confirmation capsule history differs");
      }
      capsules.set(capsule.body.dueKey, Object.freeze({ capsule, occurrence, outer }));
      continue;
    }
    let document;
    try {
      document = parseForecastAdjustmentMaintenanceRevisionProjection({
        projectionBytes: Buffer.from(occurrence.payloadBytes),
      });
    } catch (error) {
      // ignore only explicitly disjoint contracts, never malformed known projections
      if ([
        "adjustment-revision-projection/v1",
        "adjustment-revision-batch-projection/v2",
        "adjustment-temperature-native-source-projection/v2",
        "adjustment-rain-gate-feature-projection/v2",
        "adjustment-rain-gate-control-projection/v3",
      ].includes(occurrence.payloadKind)) {
        throw error;
      }
      continue;
    }
    const members = confirmationProjectionMembers(
      occurrence,
      document,
      witness.epochAt,
      input.targetCutoffAt,
    );
    // retain exact content-addressed source rows and physical target groups
    for (const member of members) {
      if (document.projectionKind === "actual_best_match") {
        addUniqueProjectionMember(actualBestMatch, input.family === "temperature"
          ? temperatureComparatorIdentity(member.document.logicalKey.sourceId,
              member.document.logicalKey.productRunAt, member.row.validAt, member.row.contentSha256)
          : member.row.contentSha256, member);
      } else if (document.projectionKind === "native_source") {
        // temperature must not consume unrelated forecast-anchor bodies
        if (input.family === "temperature" && document.family !== "temperature") {
          continue;
        }
        addUniqueProjectionMember(nativeSource, input.family === "temperature"
          ? temperatureNativeIdentity(member.document.logicalKey.providerResponseSha256,
              member.document.logicalKey.runInitializedAt, member.row.validAt, member.row.contentSha256)
          : member.row.contentSha256, member);
      } else if (document.projectionKind === "target_revision") {
        const targetOccurrences = targetByValidAt.get(member.row.validAt) ?? new Map();
        targetOccurrences.set(occurrence.payloadIdentitySha256, occurrence);
        targetByValidAt.set(member.row.validAt, targetOccurrences);
      }
    }
  }
  return Object.freeze({ actualBestMatch, capsules, nativeSource, targetByValidAt });
}

// resolve one candidate/incumbent/source/target comparison record
function resolveConfirmationRecord(input) {
  const { body, comparator, comparatorBytes, source } = input.capsuleEntry.capsule;
  if (comparator === null || comparatorBytes === null || body.family !== input.family ||
      source.family !== input.family || body.dueKey !== input.capsuleEntry.outer.metadata.dueKey ||
      input.rowIndex < 0 || input.rowIndex >= body.rows.length) {
    return null;
  }
  const bodyRow = body.rows[input.rowIndex];
  const sourceRow = source.rows[input.rowIndex];
  const comparatorRow = comparator.rows[input.rowIndex];
  if (bodyRow.leadHours !== input.rowIndex + 1 || sourceRow.leadHours !== input.rowIndex + 1 ||
      comparatorRow.leadHours !== input.rowIndex + 1 || bodyRow.validAt !== sourceRow.validAt ||
      bodyRow.validAt !== comparatorRow.validAt ||
      [source.issuedAt, sourceRow.receivedAt, sourceRow.referenceAt, sourceRow.validAt]
        .some((clock) => Date.parse(clock) < Date.parse(input.witness.epochAt) ||
          Date.parse(clock) > Date.parse(input.targetCutoffAt))) {
    return null;
  }
  let nativeMember;
  let actualMember;
  let incumbentPrediction;
  if (input.family === "temperature") {
    nativeMember = input.indexes.nativeSource.get(temperatureNativeIdentity(
      sourceRow.providerResponseSha256, sourceRow.referenceAt, sourceRow.validAt,
      sourceRow.contentSha256,
    ));
    actualMember = input.indexes.actualBestMatch.get(temperatureComparatorIdentity(
      sourceRow.bestMatchSourceId, sourceRow.bestMatchProductRunAt, sourceRow.validAt,
      sourceRow.bestMatchContentSha256,
    ));
    incumbentPrediction = decodeMaintenanceBinary64(comparatorRow.incumbentTemperatureC64);
  } else {
    actualMember = input.indexes.actualBestMatch.get(sourceRow.contentSha256);
    nativeMember = actualMember;
    incumbentPrediction = decodeMaintenanceBinary64(input.metric === "windGustMps"
      ? comparatorRow.incumbentGustMps64
      : comparatorRow.incumbentSpeedMps64);
  }
  if (nativeMember === undefined || actualMember === undefined ||
      nativeMember.row.validAt !== bodyRow.validAt || actualMember.row.validAt !== bodyRow.validAt) {
    return null;
  }
  // require the complete archived native decision rather than an hourly content alias
  if (input.family === "temperature" && !adjustmentTemperatureConfirmationSourceMatchesNative({
    actualMember, nativeMember, source, sourceRow,
  })) {
    return null;
  }
  const targetKey = `${bodyRow.validAt}\0${input.metric ?? "temperatureC"}`;
  let target = input.targetCache.get(targetKey);
  if (target === undefined) {
    const occurrences = [...(input.indexes.targetByValidAt.get(bodyRow.validAt)?.values() ?? [])];
    target = buildAdjustmentMaintenanceDerivedTarget({
      epochWitness: input.witness,
      family: input.family,
      metric: input.metric ?? "temperatureC",
      occurrences,
      targetCutoffAt: input.targetCutoffAt,
      validAt: bodyRow.validAt,
    });
    input.targetCache.set(targetKey, target);
  }
  if (target.state !== "complete") {
    return null;
  }
  const firstEdgeCommittedAt = [
    input.capsuleEntry.outer.predictionCommittedAt,
    input.capsuleEntry.capsule.revisionReceipt.archiveCommittedAt,
    actualMember.receipt.archiveCommittedAt,
    nativeMember.receipt.archiveCommittedAt,
    target.value.firstEdgeCommittedAt,
  ].sort().at(-1);
  const comparatorSha256 = sha256(comparatorBytes);
  const comparison = Object.freeze({
    farmTarget: null,
    firstEdgeCommittedAt,
    incumbentPrediction,
    membership: Object.freeze({
      actualBestMatchProjectionSha256: actualMember.occurrence.payloadIdentitySha256,
      actualBestMatchReceiptSha256: actualMember.receipt.receiptSha256,
      incumbentMemberSha256: comparatorSha256,
      nativeSourceProjectionSha256: nativeMember.occurrence.payloadIdentitySha256,
      nativeSourceReceiptSha256: nativeMember.receipt.receiptSha256,
      targetMemberSha256: target.targetMemberSha256,
    }),
    nearestThree: null,
    providerFamily: null,
    stationKey: null,
    target: target.target,
  });
  const required = new Set([
    input.capsuleEntry.occurrence.payloadIdentitySha256,
    input.capsuleEntry.capsule.revisionReceipt.receiptSha256,
    input.capsuleEntry.outer.metadata.predictionBodySha256,
    input.capsuleEntry.outer.sourceProjectionSha256,
    comparatorSha256,
    comparator.servingAuthority.receiptMemberSha256,
    actualMember.memberSha256,
    actualMember.occurrence.payloadIdentitySha256,
    actualMember.receipt.receiptSha256,
    nativeMember.memberSha256,
    nativeMember.occurrence.payloadIdentitySha256,
    nativeMember.receipt.receiptSha256,
    target.targetMemberSha256,
    ...target.requiredMemberIdentitySha256s,
  ]);
  // include an actual incumbent artifact member only when serving was not raw
  if (comparator.servingAuthority.artifactMemberSha256 !== null) {
    required.add(comparator.servingAuthority.artifactMemberSha256);
  }
  return Object.freeze({
    derivedTarget: Object.freeze({
      bytes: Buffer.from(target.bytes),
      targetMemberSha256: target.targetMemberSha256,
    }),
    graphBinding: Object.freeze({
      actualBestMatch: Object.freeze({
        memberSha256: actualMember.memberSha256,
        payloadIdentitySha256: actualMember.occurrence.payloadIdentitySha256,
        receiptSha256: actualMember.receipt.receiptSha256,
      }),
      capsule: Object.freeze({
        comparatorMemberSha256: comparatorSha256,
        payloadIdentitySha256: input.capsuleEntry.occurrence.payloadIdentitySha256,
        predictionBodySha256: input.capsuleEntry.outer.metadata.predictionBodySha256,
        receiptSha256: input.capsuleEntry.capsule.revisionReceipt.receiptSha256,
        sourceProjectionSha256: input.capsuleEntry.outer.sourceProjectionSha256,
      }),
      key: input.key,
      nativeSource: Object.freeze({
        memberSha256: nativeMember.memberSha256,
        payloadIdentitySha256: nativeMember.occurrence.payloadIdentitySha256,
        receiptSha256: nativeMember.receipt.receiptSha256,
      }),
      target: Object.freeze({
        sourceMemberSha256s: target.value.rows.map(
          // link the derived member to every exact physical target row
          (row) => row.memberSha256,
        ),
        targetMemberSha256: target.targetMemberSha256,
      }),
    }),
    graphManifestSha256s: Object.freeze(sortedUnique([
      input.capsuleEntry.occurrence.graphManifestSha256,
      actualMember.occurrence.graphManifestSha256,
      nativeMember.occurrence.graphManifestSha256,
      ...target.graphManifestSha256s,
    ])),
    record: Object.freeze({
      capsuleBase64: Buffer.from(input.capsuleEntry.occurrence.payloadBytes).toString("base64"),
      comparison,
      key: input.key,
      metric: input.metric,
      rowIndex: input.rowIndex,
    }),
    requiredMemberIdentitySha256s: Object.freeze([...required].sort()),
  });
}

// project every ordered document row into its existing five-key cold member identity
function confirmationProjectionMembers(occurrence, document, epochAt, targetCutoffAt) {
  const expectedReceipts = document.contractVersion === "adjustment-revision-batch-projection/v2"
    ? document.rows.length
    : 1;
  if (occurrence.payloadKind !== document.contractVersion ||
      occurrence.receipts.length !== expectedReceipts) {
    throw new TypeError("confirmation projection receipt population differs");
  }
  const documentClocks = [document.logicalReceivedAt,
    document.logicalKey.productRunAt, document.logicalKey.runInitializedAt]
    .filter((clock) => clock !== null && clock !== undefined);
  // prohibit pre-epoch source data and post-cutoff availability
  if (documentClocks.some((clock) => Date.parse(clock) < Date.parse(epochAt) ||
      Date.parse(clock) > Date.parse(targetCutoffAt))) {
    throw new TypeError("confirmation projection clock is outside its snapshot");
  }
  return document.rows.map((row, rowIndex) => {
    const receipt = occurrence.receipts.length === 1
      ? occurrence.receipts[0]
      : occurrence.receipts[rowIndex];
    if (receipt.projectionKind !== document.projectionKind ||
        receipt.projectionIdentitySha256 !== occurrence.payloadIdentitySha256 ||
        receipt.projectionSha256 !== occurrence.payloadIdentitySha256 ||
        Date.parse(row.validAt) < Date.parse(epochAt) ||
        Date.parse(row.validAt) > Date.parse(targetCutoffAt) ||
        (row.bestMatchProductRunAt !== null && row.bestMatchProductRunAt !== undefined &&
          (Date.parse(row.bestMatchProductRunAt) < Date.parse(epochAt) ||
            Date.parse(row.bestMatchProductRunAt) > Date.parse(targetCutoffAt))) ||
        Date.parse(receipt.archiveCommittedAt) < Date.parse(epochAt) ||
        Date.parse(receipt.archiveCommittedAt) > Date.parse(targetCutoffAt)) {
      throw new TypeError("confirmation projection receipt differs");
    }
    const memberSha256 = sha256(canonicalJsonBytes({
      archiveCommitOrdinal: receipt.archiveCommitOrdinal,
      payloadIdentitySha256: occurrence.payloadIdentitySha256,
      projectionKind: document.projectionKind,
      receiptSha256: receipt.receiptSha256,
      rowIndex,
    }));
    return Object.freeze({ document, memberSha256, occurrence, receipt, row, rowIndex });
  });
}

// compare every candidate-consumed source field against authenticated native members
export function adjustmentTemperatureConfirmationSourceMatchesNative(input) {
  requireExactKeys(input, ["actualMember", "nativeMember", "source", "sourceRow"],
    "temperature confirmation source binding");
  const { actualMember, nativeMember, source, sourceRow } = input;
  // refuse any raw, comparator, lineage or causal-state mismatch
  if (
      nativeMember.document.contractVersion !== "adjustment-temperature-native-source-projection/v2" ||
      nativeMember.document.logicalReceivedAt > source.issuedAt ||
      actualMember.document.logicalReceivedAt > source.issuedAt ||
      nativeMember.document.logicalKey.runInitializedAt !== sourceRow.referenceAt ||
      nativeMember.document.logicalKey.providerResponseSha256 !== sourceRow.providerResponseSha256 ||
      nativeMember.row.modelCycle !== sourceRow.modelCycle ||
      nativeMember.document.source.adapterVersion !== sourceRow.adapterVersion ||
      nativeMember.document.source.dataset !== sourceRow.dataset ||
      nativeMember.document.source.providerKey !== sourceRow.providerKey ||
      nativeMember.document.source.upstreamModel !== sourceRow.upstreamModel ||
      canonicalJsonBytes(nativeMember.document.recentErrorState) !== canonicalJsonBytes(source.recentErrorState) ||
      nativeMember.row.modelLeadHours !== sourceRow.modelLeadHours ||
      nativeMember.row.bestMatchContentSha256 !== sourceRow.bestMatchContentSha256 ||
      nativeMember.row.bestMatchProductRunAt !== sourceRow.bestMatchProductRunAt ||
      nativeMember.row.bestMatchSourceId !== sourceRow.bestMatchSourceId ||
      nativeMember.row.bestMatchTemperatureC64 !== sourceRow.bestMatchTemperatureC64 ||
      actualMember.row.temperatureC64 !== sourceRow.bestMatchTemperatureC64 ||
      nativeMember.row.rawTemperatureC64 !== sourceRow.rawTemperatureC64 ||
      nativeMember.row.rawRelativeHumidityPercent64 !== sourceRow.rawRelativeHumidityPercent64 ||
      nativeMember.row.rawWindSpeedMps64 !== sourceRow.rawWindSpeedMps64 ||
      actualMember.document.logicalKey.sourceId !== sourceRow.bestMatchSourceId ||
      actualMember.document.logicalKey.productRunAt !== sourceRow.bestMatchProductRunAt ||
      actualMember.row.contentSha256 !== sourceRow.bestMatchContentSha256 ||
      actualMember.row.validAt !== sourceRow.validAt ||
      nativeMember.row.contentSha256 !== sourceRow.contentSha256 ||
      nativeMember.row.validAt !== sourceRow.validAt) {
    return false;
  }
  return true;
}

// bind the complete native source response and initialization tuple
function temperatureNativeIdentity(providerResponseSha256, runInitializedAt, validAt, contentSha256) {
  if (!HASH.test(providerResponseSha256) || !HASH.test(contentSha256) ||
      typeof runInitializedAt !== "string" || !INSTANT.test(runInitializedAt) ||
      typeof validAt !== "string" || !INSTANT.test(validAt)) {
    throw new TypeError("temperature confirmation native identity is invalid");
  }
  return sha256(canonicalJsonBytes({ contentSha256, providerResponseSha256, runInitializedAt, validAt }));
}

// address the complete temperature comparator tuple without content-only aliases
function temperatureComparatorIdentity(sourceId, productRunAt, validAt, contentSha256) {
  if (typeof sourceId !== "string" || !/^[1-9]\d{0,19}$/u.test(sourceId) ||
      typeof productRunAt !== "string" || !INSTANT.test(productRunAt) ||
      typeof validAt !== "string" || !INSTANT.test(validAt) || !HASH.test(contentSha256)) {
    throw new TypeError("temperature confirmation comparator identity is invalid");
  }
  return sha256(canonicalJsonBytes({ contentSha256, productRunAt, sourceId, validAt }));
}

// retain one immutable content member without arbitrary first-wins selection
function addUniqueProjectionMember(index, key, member) {
  if (typeof key !== "string" || !HASH.test(key)) {
    throw new TypeError("confirmation projection content identity is invalid");
  }
  const previous = index.get(key);
  if (previous !== undefined && (previous.memberSha256 !== member.memberSha256 ||
      previous.occurrence.payloadIdentitySha256 !== member.occurrence.payloadIdentitySha256)) {
    throw new TypeError("confirmation projection content identity is duplicated");
  }
  index.set(key, member);
}

// validate the terminal burn against the exact blinded plan
function validateConfirmationAccess(access, plan, registration) {
  if (access === null || typeof access !== "object" || Array.isArray(access)) {
    throw new TypeError("confirmation access is invalid");
  }
  for (const field of [
    "accessSha256", "expectedKeySetSha256", "revisionCatalogWatermarkSha256",
    "targetComparatorSnapshotRootSha256",
  ]) {
    requireHash(access[field], field);
  }
  requireInstant(access.accessedAt, "accessedAt");
  requireInstant(access.targetCutoffAt, "targetCutoffAt");
  const unsigned = { ...access };
  delete unsigned.accessSha256;
  if (access.accessState !== "burned" ||
      access.registrationSha256 !== registration.registrationSha256 ||
      access.family !== registration.family ||
      access.accessSha256 !== sha256(canonicalJsonBytes(unsigned)) ||
      access.expectedKeySetSha256 !== plan.expectedKeySetSha256 ||
      access.revisionCatalogWatermarkSha256 !== plan.revisionCatalogWatermarkSha256 ||
      access.targetComparatorSnapshotRootSha256 !== plan.snapshotRootSha256 ||
      access.targetCutoffAt !== plan.targetCutoffAt ||
      Date.parse(access.accessedAt) < Date.parse(registration.terminalAccessAt)) {
    throw new TypeError("confirmation access differs from its blinded plan");
  }
}

// validate the public lifecycle registration fields needed by the pure assembler
function validateConfirmationRegistration(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !["temperature", "wind", "rain"].includes(value.family)) {
    throw new TypeError("confirmation registration is invalid");
  }
  for (const field of ["registrationSha256", "reservedKeySha256", "sourceLineageSha256"]) {
    requireHash(value[field], field);
  }
  requireInstant(value.terminalAccessAt, "terminalAccessAt");
  if (typeof value.intervalStartLocalDate !== "string" ||
      typeof value.intervalEndExclusiveLocalDate !== "string") {
    throw new TypeError("confirmation registration interval differs");
  }
  return value;
}

// validate one future-only public shadow registration and its hash preimage
function validateConfirmationShadowRegistration(value, family, epochWitnessSha256) {
  const keys = [
    "artifactSha256", "candidateSha256", "cohortSha256", "epochWitnessSha256", "family",
    "intervalEndAt", "intervalStartAt", "policySha256", "predecessorRegistrationSha256",
    "registrationSha256", "reservedKeySha256", "scheduleContractSha256", "siteKey", "sourceSha256",
    "targetCutoffAt", "terminalAt",
  ];
  requireExactKeys(value, keys, "confirmation shadow registration");
  if (value.family !== family || value.siteKey !== "ballydidean" ||
      value.epochWitnessSha256 !== epochWitnessSha256) {
    throw new TypeError("confirmation shadow registration lineage differs");
  }
  for (const field of [
    "artifactSha256", "candidateSha256", "cohortSha256", "epochWitnessSha256", "policySha256",
    "registrationSha256", "reservedKeySha256", "scheduleContractSha256", "sourceSha256",
  ]) {
    requireHash(value[field], field);
  }
  if (value.predecessorRegistrationSha256 !== null) {
    requireHash(value.predecessorRegistrationSha256, "predecessorRegistrationSha256");
  }
  for (const field of ["intervalEndAt", "intervalStartAt", "targetCutoffAt", "terminalAt"]) {
    requireInstant(value[field], field);
  }
  const preimage = `${[
    "adjustment-shadow-registration/v3", value.siteKey, value.family, value.candidateSha256,
    value.artifactSha256, value.policySha256, value.cohortSha256, value.reservedKeySha256,
    value.sourceSha256, value.epochWitnessSha256, value.scheduleContractSha256,
    value.predecessorRegistrationSha256 ?? "none", value.intervalStartAt, value.intervalEndAt,
    value.targetCutoffAt, value.terminalAt,
  ].join("\n")}\n`;
  if (sha256(Buffer.from(preimage)) !== value.registrationSha256) {
    throw new TypeError("confirmation shadow registration identity differs");
  }
  return value;
}

// cross-bind both registration domains without granting lifecycle authority
function validateConfirmationCrossBinding(registration, shadow) {
  if (registration.family !== shadow.family ||
      registration.candidateSha256 !== shadow.candidateSha256 ||
      registration.sourceLineageSha256 !== shadow.sourceSha256 ||
      registration.reservedKeySha256 !== shadow.reservedKeySha256 ||
      registration.terminalAccessAt !== shadow.terminalAt) {
    throw new TypeError("confirmation registrations differ");
  }
}

// validate the scheduler's value-free daily work identity
function validateConfirmationDue(value) {
  requireExactKeys(value, ["dueKey", "family", "mode", "originalCutoffAt", "scope"],
    "confirmation daily due");
  requireInstant(value.originalCutoffAt, "originalCutoffAt");
  if (value.family !== null || value.mode !== "daily" || value.scope !== "daily" ||
      typeof value.dueKey !== "string" || !/^daily\/20\d{2}-\d{2}-\d{2}$/u.test(value.dueKey)) {
    throw new TypeError("confirmation daily due differs");
  }
}

// validate the immutable historical index shape used by both phases
function validateConfirmationHistory(history) {
  requireExactKeys(history, [
    "catalog", "contractVersion", "historyRootSha256", "occurrences", "pages", "receiptCount",
  ], "confirmation history");
  if (history.contractVersion !== "adjustment-revision-historical-archive-index/v1" ||
      !Array.isArray(history.occurrences) || history.occurrences.length < 1) {
    throw new TypeError("confirmation history differs");
  }
  requireHash(history.historyRootSha256, "historyRootSha256");
  requireHash(history.catalog.catalogRootSha256, "catalogRootSha256");
  requireHash(history.catalog.frontierRootSha256, "frontierRootSha256");
  if (typeof history.catalog.archiveCommitOrdinal !== "string" ||
      !/^\d{1,20}$/u.test(history.catalog.archiveCommitOrdinal)) {
    throw new TypeError("confirmation history watermark differs");
  }
}

// authenticate one selected occurrence before any semantic decoding
function validateConfirmationOccurrenceEnvelope(occurrence) {
  requireExactKeys(occurrence, [
    "graphManifestSha256", "pageSha256", "payloadBytes", "payloadIdentitySha256",
    "payloadKind", "publicationDisposition", "receipts",
  ], "confirmation occurrence");
  requireHash(occurrence.graphManifestSha256, "graphManifestSha256");
  requireHash(occurrence.pageSha256, "pageSha256");
  requireHash(occurrence.payloadIdentitySha256, "payloadIdentitySha256");
  if (!(occurrence.payloadBytes instanceof Uint8Array) || !Array.isArray(occurrence.receipts) ||
      sha256(occurrence.payloadBytes) !== occurrence.payloadIdentitySha256) {
    throw new TypeError("confirmation occurrence identity differs");
  }
}

// enumerate the distinct pretarget capture due keys from the frozen key plan
function expectedDueKeySet(plan) {
  const dueKeys = new Set();
  // traverse every logical and physical population without reading outcomes
  for (const logical of plan.logicalChunks) {
    for (const part of logical.parts) {
      for (const key of part.expectedKeys) {
        dueKeys.add(parseExpectedConfirmationKey(key, plan.family).dueKey);
      }
    }
  }
  return dueKeys;
}

// parse one frozen due/lead/metric key without consulting a target value
function parseExpectedConfirmationKey(value, family) {
  if (typeof value !== "string") {
    throw new TypeError("confirmation expected key is invalid");
  }
  const match = /^(capture\/20\d{2}-\d{2}-\d{2}T\d{2}:35:00\.000Z)\/(\d{1,3})\/(temperature|windGustMps|windSpeedMps|rain)$/u.exec(value);
  if (match === null) {
    throw new TypeError("confirmation expected key grammar differs");
  }
  const leadHours = Number(match[2]);
  const metric = family === "wind" ? match[3] : null;
  if (!Number.isInteger(leadHours) || leadHours < 1 ||
      (family === "temperature" && (leadHours > 12 || match[3] !== "temperature")) ||
      (family === "wind" && (leadHours > 168 ||
        !["windGustMps", "windSpeedMps"].includes(match[3]) ||
        (match[3] === "windGustMps" && leadHours >= 49 && leadHours <= 72))) ||
      (family === "rain" && (leadHours > 23 || match[3] !== "rain"))) {
    throw new TypeError("confirmation expected key selector differs");
  }
  return Object.freeze({ dueKey: match[1], leadHours, metric });
}

// return the one value-free incomplete state
function pendingConfirmation(registration) {
  return Object.freeze({
    family: registration.family,
    reason: "history_unavailable",
    registrationSha256: registration.registrationSha256,
    state: "pending",
  });
}

// derive one frozen regional target from authenticated cold target rows
export function buildAdjustmentMaintenanceDerivedTarget(input) {
  requireExactKeys(input, [
    "epochWitness", "family", "metric", "occurrences", "targetCutoffAt", "validAt",
  ], "derived target input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  requireInstant(input.targetCutoffAt, "targetCutoffAt");
  requireInstant(input.validAt, "validAt");
  const metrics = FAMILY_METRICS[input.family];

  // keep rain unavailable until its fixed-gauge target producer exists
  if (metrics === undefined || !metrics.has(input.metric) || !Array.isArray(input.occurrences)) {
    throw new TypeError("derived target family or metric is invalid");
  }
  const field = METRIC_FIELDS[input.metric];
  const stations = new Map();

  // admit only parser-authenticated published target occurrences
  for (const occurrence of input.occurrences) {
    const parsed = parseTargetOccurrence(occurrence);

    // omit unrelated target clocks without weakening their validation
    for (const [rowIndex, row] of parsed.document.rows.entries()) {
      if (row.validAt !== input.validAt || row[field] === null) {
        continue;
      }
      const lineage = targetLineage(parsed.document, input.validAt);
      const station = FORECAST_OBSERVATION_STATIONS.find(
        // bind the reviewed lineage to its one frozen physical station
        (candidate) => candidate.key === lineage.physicalStationKey,
      );

      // preserve the original regional recipe's local-station exclusion
      if (station === undefined || station.key === "ballydidean-ecowitt" ||
          !station.eligibleMetrics.includes(input.metric)) {
        continue;
      }
      if (stations.has(station.key)) {
        throw new RangeError("derived target station is duplicated");
      }
      const receipt = receiptForRow(parsed, rowIndex);
      requireReceiptClock(receipt.archiveCommittedAt, witness.epochAt, input.targetCutoffAt);
      const memberProjection = {
        archiveCommitOrdinal: receipt.archiveCommitOrdinal,
        payloadIdentitySha256: occurrence.payloadIdentitySha256,
        projectionKind: "target_revision",
        receiptSha256: receipt.receiptSha256,
        rowIndex,
      };
      const memberSha256 = sha256(canonicalJsonBytes(memberProjection));
      stations.set(station.key, Object.freeze({
        member: Object.freeze({
          archiveCommitOrdinal: receipt.archiveCommitOrdinal,
          graphManifestSha256: occurrence.graphManifestSha256,
          memberSha256,
          payloadIdentitySha256: occurrence.payloadIdentitySha256,
          receiptSha256: receipt.receiptSha256,
          rowIndex,
          sourceKey: lineage.sourceKey,
        }),
        receipt,
        station,
        value: decodeMaintenanceBinary64(row[field]),
      }));
    }
  }
  const selected = [...stations.values()].sort(
    // make archive page and occurrence order irrelevant
    (left, right) => left.member.sourceKey.localeCompare(right.member.sourceKey) ||
      left.member.memberSha256.localeCompare(right.member.memberSha256),
  );
  const actual = scalarNetworkActual(selected.map((entry) => ({
    nearestRank: entry.station.nearestRank,
    physicalStationKey: entry.station.key,
    unnormalizedSpatialWeight: entry.station.unnormalizedSpatialWeight,
    value: entry.value,
  })));

  // return a value-free diagnostic instead of substituting missing coverage
  if (actual === null) {
    const present = new Set(selected.map((entry) => entry.station.key));
    return Object.freeze({
      missingStationKeys: Object.freeze(FORECAST_OBSERVATION_STATIONS.filter(
        // diagnose only original regional stations eligible for this metric
        (station) => station.key !== "ballydidean-ecowitt" &&
          station.eligibleMetrics.includes(input.metric) && !present.has(station.key),
      ).map((station) => station.key).sort()),
      reason: "target_unavailable",
      state: "pending",
    });
  }
  const value = {
    contractVersion: ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION,
    family: input.family,
    firstEdgeCommittedAt: selected.map((entry) => entry.receipt.archiveCommittedAt).sort().at(-1),
    metric: input.metric,
    rows: selected.map((entry) => entry.member),
    target64: encodeMaintenanceBinary64(actual.value),
    validAt: input.validAt,
  };
  const bytes = Buffer.from(canonicalJsonBytes(value));
  return Object.freeze({
    bytes,
    graphManifestSha256s: Object.freeze(sortedUnique(value.rows.map(
      // expose every source graph needed for later reachability verification
      (row) => row.graphManifestSha256,
    ))),
    requiredMemberIdentitySha256s: Object.freeze(sortedUnique(value.rows.flatMap(
      // retain the row projection, payload and receipt domain identities
      (row) => [row.memberSha256, row.payloadIdentitySha256, row.receiptSha256],
    ))),
    state: "complete",
    target: actual.value,
    targetMemberSha256: sha256(bytes),
    value: Object.freeze(value),
  });
}

// parse one canonical derived target without accepting caller hash claims
export function parseAdjustmentMaintenanceDerivedTarget(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > 256 * 1_024) {
    throw new RangeError("derived target bytes are invalid");
  }
  let value;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new TypeError("derived target JSON is invalid");
  }
  validateDerivedTarget(value);
  const canonical = Buffer.from(canonicalJsonBytes(value));

  // reject alternate byte encodings of the same object
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new TypeError("derived target is not canonical");
  }
  return Object.freeze(structuredClone(value));
}

// bind one cold occurrence to its exact projection bytes and receipts
function parseTargetOccurrence(occurrence) {
  requireExactKeys(occurrence, [
    "graphManifestSha256", "pageSha256", "payloadBytes", "payloadIdentitySha256",
    "payloadKind", "publicationDisposition", "receipts",
  ], "derived target occurrence");
  requireHash(occurrence.graphManifestSha256, "graphManifestSha256");
  requireHash(occurrence.payloadIdentitySha256, "payloadIdentitySha256");
  if (!(occurrence.payloadBytes instanceof Uint8Array) ||
      occurrence.publicationDisposition !== "published" || !Array.isArray(occurrence.receipts) ||
      sha256(occurrence.payloadBytes) !== occurrence.payloadIdentitySha256) {
    throw new TypeError("derived target occurrence differs");
  }
  const document = parseForecastAdjustmentMaintenanceRevisionProjection({
    projectionBytes: Buffer.from(occurrence.payloadBytes),
  });
  const receiptCount = document.contractVersion === "adjustment-revision-batch-projection/v2"
    ? document.rows.length
    : 1;

  // require the existing target grammar and exact body/receipt population
  if (occurrence.payloadKind !== document.contractVersion ||
      document.projectionKind !== "target_revision" || occurrence.receipts.length !== receiptCount ||
      occurrence.receipts.some((receipt) => receipt.projectionKind !== "target_revision" ||
        receipt.projectionIdentitySha256 !== occurrence.payloadIdentitySha256 ||
        receipt.projectionSha256 !== occurrence.payloadIdentitySha256)) {
    throw new TypeError("derived target receipt binding differs");
  }
  return { document, occurrence };
}

// select the grouped row's own database receipt
function receiptForRow(parsed, rowIndex) {
  const receipt = parsed.occurrence.receipts.length === 1
    ? parsed.occurrence.receipts[0]
    : parsed.occurrence.receipts[rowIndex];
  requireExactKeys(receipt, [
    "archiveCommitOrdinal", "archiveCommittedAt", "contractVersion", "frontierSha256",
    "predecessorFrontierSha256", "projectionIdentitySha256", "projectionKind",
    "projectionSha256", "receiptSha256", "stageReceiptSha256",
  ], "derived target receipt");
  requireHash(receipt.receiptSha256, "receiptSha256");
  if (typeof receipt.archiveCommitOrdinal !== "string" ||
      !/^[1-9]\d{0,19}$/u.test(receipt.archiveCommitOrdinal)) {
    throw new TypeError("derived target receipt ordinal differs");
  }
  return receipt;
}

// authenticate one physical source against the frozen domain catalog
function targetLineage(document, validAt) {
  const lineage = FORECAST_OBSERVATION_SOURCE_LINEAGES.find(
    // select only the exact archived source lineage
    (candidate) => candidate.sourceKey === document.source.sourceKey,
  );
  if (lineage === undefined || document.source.adapterVersion !== lineage.adapterContract ||
      document.source.sourceConfigFingerprint !== lineage.checkedFingerprint ||
      document.source.sourceKind !== "physical_sensor" ||
      (lineage.acceptedStartInclusive !== null &&
        Date.parse(validAt) < Date.parse(lineage.acceptedStartInclusive)) ||
      (lineage.acceptedEndExclusive !== null &&
        Date.parse(validAt) >= Date.parse(lineage.acceptedEndExclusive))) {
    throw new TypeError("derived target source lineage differs");
  }
  return lineage;
}

// validate the immutable derived target member grammar
function validateDerivedTarget(value) {
  requireExactKeys(value, TARGET_KEYS, "derived target");
  const metrics = FAMILY_METRICS[value.family];
  if (value.contractVersion !== ADJUSTMENT_MAINTENANCE_DERIVED_TARGET_VERSION ||
      metrics === undefined || !metrics.has(value.metric) || !Array.isArray(value.rows) ||
      value.rows.length < 1) {
    throw new TypeError("derived target identity differs");
  }
  requireInstant(value.firstEdgeCommittedAt, "firstEdgeCommittedAt");
  requireInstant(value.validAt, "validAt");
  decodeMaintenanceBinary64(value.target64);
  let previous = null;

  // recompute every existing five-key archive row identity
  for (const row of value.rows) {
    requireExactKeys(row, TARGET_ROW_KEYS, "derived target row");
    for (const field of [
      "graphManifestSha256", "memberSha256", "payloadIdentitySha256", "receiptSha256",
    ]) {
      requireHash(row[field], field);
    }
    if (typeof row.sourceKey !== "string" || row.sourceKey.length < 1 || row.sourceKey.length > 128 ||
        !Number.isSafeInteger(row.rowIndex) || row.rowIndex < 0 ||
        typeof row.archiveCommitOrdinal !== "string" ||
        !/^[1-9]\d{0,19}$/u.test(row.archiveCommitOrdinal)) {
      throw new TypeError("derived target row differs");
    }
    const memberSha256 = sha256(canonicalJsonBytes({
      archiveCommitOrdinal: row.archiveCommitOrdinal,
      payloadIdentitySha256: row.payloadIdentitySha256,
      projectionKind: "target_revision",
      receiptSha256: row.receiptSha256,
      rowIndex: row.rowIndex,
    }));
    const key = `${row.sourceKey}\0${row.memberSha256}`;

    // enforce both exact identity and canonical row order
    if (memberSha256 !== row.memberSha256 || (previous !== null && key <= previous)) {
      throw new TypeError("derived target row identity differs");
    }
    previous = key;
  }
}

// require one clock inside the future-only frozen target snapshot
function requireReceiptClock(value, epochAt, targetCutoffAt) {
  requireInstant(value, "archiveCommittedAt");
  if (Date.parse(value) < Date.parse(epochAt) || Date.parse(value) > Date.parse(targetCutoffAt)) {
    throw new RangeError("derived target receipt is outside its snapshot");
  }
}

// return deterministic unique identity arrays
function sortedUnique(values) {
  return [...new Set(values)].sort();
}

// hash exact canonical member bytes
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

// require one exact plain-object key set
function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new TypeError(`${label} fields differ`);
  }
}

// require one lowercase sha-256 identity
function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one canonical UTC millisecond instant
function requireInstant(value, label) {
  if (typeof value !== "string" || !INSTANT.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}
