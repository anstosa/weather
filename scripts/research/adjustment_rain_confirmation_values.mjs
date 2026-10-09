import { createHash } from "node:crypto";

import {
  parseShadowRevisionCapsule,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  canonicalJsonBytes,
} from "./adjustment-maintenance-runtime/forecast/candidate.js";
import {
  decodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";
import {
  buildAdjustmentMaintenanceEvaluationChunkV3,
  buildAdjustmentMaintenanceExpectedKeyPlanV3,
} from "./adjustment_daily_evaluation.mjs";
import {
  ADJUSTMENT_MAINTENANCE_CONFIRMATION_PLAN_GRAPH_VERSION,
  ADJUSTMENT_MAINTENANCE_CONFIRMATION_TERMINAL_GRAPH_VERSION,
  ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUE_PLAN_VERSION,
  ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUES_VERSION,
  ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_PLAN_VERSION,
  ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_VALUES_VERSION,
  ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_GRAPH_VERSION,
  planAdjustmentMaintenanceDailyConfirmation,
  planAdjustmentMaintenanceUnsupportedDailyConfirmation,
  validateAdjustmentMaintenanceConfirmationPlanGraph,
  validateAdjustmentMaintenanceUnsupportedPlanGraph,
} from "./adjustment_confirmation_values.mjs";
import {
  parseForecastAdjustmentMaintenanceShadowCapsule,
  parseForecastAdjustmentMaintenanceRevisionProjection,
  parseForecastAdjustmentRainFixedGaugeTarget,
  parseForecastAdjustmentRainMaintenanceControlProjection,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  assembleConfirmationManifest,
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";

const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DECIMAL = /^[1-9]\d{0,19}$/u;
const HOUR = 3_600_000;
const TARGET_VERSION = "adjustment-rain-fixed-gauge-target-projection/v1";
const CONTROL_VERSION = "adjustment-rain-gate-control-projection/v3";
const CAPSULE_VERSION = "adjustment-shadow-revision-capsule/v2";
const REVISION_V1_VERSION = "adjustment-revision-projection/v1";
const REVISION_V2_VERSION = "adjustment-revision-batch-projection/v2";

// assemble a fully qualified rain member or one explicit post-burn unsupported member
export function assembleAdjustmentRainDailyConfirmation(input) {
  return assembleRainConfirmation(input, false);
}

// retain the original burn while resolving every genuine rain member still available
export function assembleAdjustmentRainUnsupportedDailyConfirmation(input) {
  return assembleRainConfirmation(input, true);
}

// execute the common complete and unsupported post-burn path
function assembleRainConfirmation(input, unsupported) {
  requireExactKeys(input, [
    "access", "confirmationRegistration", "due", "epochWitness", "history", "plan",
    "shadowRegistration",
  ], "rain confirmation assembly input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const planInput = {
    confirmationRegistration: input.confirmationRegistration,
    due: input.due,
    epochWitness: witness,
    history: input.history,
    shadowRegistration: input.shadowRegistration,
  };
  const completeBurn = input.plan?.contractVersion ===
    ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUE_PLAN_VERSION;
  const currentPlan = completeBurn
    ? planAdjustmentMaintenanceDailyConfirmation(planInput)
    : planAdjustmentMaintenanceUnsupportedDailyConfirmation(planInput);

  // reject value access when the blinded capsule population drifted after planning
  if (currentPlan.state !== (completeBurn ? "planned" : "unsupported_planned")) {
    throw new TypeError("rain confirmation capsule population drifted before burn");
  }
  validateRainPlan(input.plan, completeBurn);
  if (canonicalJsonBytes(input.plan) !== canonicalJsonBytes(currentPlan)) {
    throw new TypeError("rain confirmation value plan drifted before burn");
  }
  validateRainAccess(input.access, currentPlan, input.confirmationRegistration);
  if (!unsupported && !completeBurn) {
    throw new TypeError("rain complete assembly requires a complete burn plan");
  }

  // decode values only after the exact owner-authorized burn has been verified
  const keyPlan = buildAdjustmentMaintenanceExpectedKeyPlanV3({
    family: "rain",
    intervalEndAt: input.shadowRegistration.intervalEndAt,
    intervalStartAt: input.shadowRegistration.intervalStartAt,
  });
  const indexes = buildRainHistoryIndexes({
    epochWitness: witness,
    history: input.history,
    registrationSha256: input.shadowRegistration.registrationSha256,
    targetCutoffAt: currentPlan.targetCutoffAt,
  });
  const chunks = [];
  const graphBindings = [];
  const graphManifestSha256s = new Set();
  const missingKeys = [];
  const rainGateInputMemberSha256s = new Set();
  const requiredMemberIdentitySha256s = new Set();
  const targetMemberSha256s = new Set();

  // preserve every preregistered physical part regardless of source completeness
  for (const logical of keyPlan.logicalChunks) {
    for (const part of logical.parts) {
      const partMissingKeys = [];
      const records = [];

      // resolve every expected rain cell against the same burned archive snapshot
      for (const key of part.expectedKeys) {
        const selector = parseRainExpectedKey(key);
        const capsule = indexes.capsules.get(selector.dueKey);
        const control = capsule === undefined
          ? undefined
          : selectRainControl(capsule, indexes.controls.get(
              capsule.parsed.source.rows[selector.rowIndex]?.referenceAt,
            ) ?? []);
        const targets = indexes.targets.get(
          capsule?.parsed.source.rows[selector.rowIndex]?.validAt,
        ) ?? [];
        const actualBestMatches = indexes.actualBestMatches.get(
          capsule?.parsed.source.rows[selector.rowIndex]?.validAt,
        ) ?? [];
        const resolved = capsule === undefined || control === undefined
          ? null
          : resolveRainRecord({ actualBestMatches, capsule, control, key, selector, targets });

        // keep missing evidence explicit rather than retrying or substituting a later value
        if (resolved === null) {
          partMissingKeys.push(key);
          missingKeys.push(key);
          continue;
        }
        records.push(resolved.record);
        graphBindings.push(resolved.graphBinding);
        targetMemberSha256s.add(resolved.targetMemberSha256);
        rainGateInputMemberSha256s.add(resolved.rainGateInputMemberSha256);
        for (const identity of resolved.requiredMemberIdentitySha256s) {
          requiredMemberIdentitySha256s.add(identity);
        }
        for (const graph of resolved.graphManifestSha256s) {
          graphManifestSha256s.add(graph);
        }
      }
      chunks.push(buildAdjustmentMaintenanceEvaluationChunkV3({
        captureLocalDate: part.captureLocalDate,
        confirmationRegistrationSha256: input.confirmationRegistration.registrationSha256,
        family: "rain",
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
    // retain preregistered key order independently from archive page order
    (left, right) => left.key.localeCompare(right.key),
  );
  missingKeys.sort();
  const graphManifestList = Object.freeze([...graphManifestSha256s].sort());
  const rainGateMembers = Object.freeze([...rainGateInputMemberSha256s].sort());
  const targetMembers = Object.freeze([...targetMemberSha256s].sort());
  const requiredMembers = Object.freeze([...requiredMemberIdentitySha256s].sort());

  // close every permanent source gap under the same burn without granting C/T/F authority
  if (missingKeys.length > 0) {
    const missingKeySetSha256 = sha256(canonicalJsonBytes(missingKeys));
    const terminalUnsigned = Object.freeze({
      bindings: Object.freeze(graphBindings),
      contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_TERMINAL_GRAPH_VERSION,
      derivedTargetMemberSha256s: targetMembers,
      graphManifestSha256s: graphManifestList,
      missingKeySetSha256,
    });
    return Object.freeze({
      chunks: Object.freeze(chunks),
      contractVersion: ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_VALUES_VERSION,
      derivedTargets: Object.freeze([]),
      family: "rain",
      graphManifestSha256s: graphManifestList,
      missingKeyCount: missingKeys.length,
      missingKeySetSha256,
      rainGateInputMemberSha256s: rainGateMembers,
      registrationSha256: input.confirmationRegistration.registrationSha256,
      requiredMemberIdentitySha256s: requiredMembers,
      state: "burned_unsupported",
      terminalGraph: Object.freeze({
        ...terminalUnsigned,
        terminalGraphSha256: sha256(canonicalJsonBytes(terminalUnsigned)),
      }),
    });
  }
  const fullManifest = assembleConfirmationManifest({
    access: input.access,
    chunks: chunks.map(
      // expose only blinded part metadata to the lifecycle journal
      (chunk) => chunk.metadata,
    ),
    registration: input.confirmationRegistration,
  });
  const terminalUnsigned = Object.freeze({
    bindings: Object.freeze(graphBindings),
    contractVersion: ADJUSTMENT_MAINTENANCE_CONFIRMATION_TERMINAL_GRAPH_VERSION,
    derivedTargetMemberSha256s: targetMembers,
    graphManifestSha256s: graphManifestList,
  });
  return Object.freeze({
    chunks: Object.freeze(chunks),
    contractVersion: ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUES_VERSION,
    derivedTargets: Object.freeze([]),
    family: "rain",
    fullManifest,
    graphManifestSha256s: graphManifestList,
    rainGateInputMemberSha256s: rainGateMembers,
    registrationSha256: input.confirmationRegistration.registrationSha256,
    requiredMemberIdentitySha256s: requiredMembers,
    state: "burned_complete",
    terminalGraph: Object.freeze({
      ...terminalUnsigned,
      terminalGraphSha256: sha256(canonicalJsonBytes(terminalUnsigned)),
    }),
  });
}

// index parser-authenticated capsules, controls and fixed targets after burn
function buildRainHistoryIndexes(input) {
  const actualBestMatches = new Map();
  const capsules = new Map();
  const controls = new Map();
  const targets = new Map();

  // retain only the rain and canonical Best Match contracts used by terminal comparison
  for (const occurrence of input.history.occurrences) {
    if (occurrence.publicationDisposition !== "published") {
      continue;
    }
    if (occurrence.payloadKind === CAPSULE_VERSION) {
      const capsule = parseRainCapsuleOccurrence(
        occurrence,
        input.epochWitness,
        input.targetCutoffAt,
      );
      if (capsule.parsed.body.registrationSha256 !== input.registrationSha256) {
        continue;
      }
      addUnique(capsules, capsule.parsed.body.dueKey, capsule,
        "rain confirmation capsule due");
      continue;
    }
    if (occurrence.payloadKind === CONTROL_VERSION) {
      const control = parseRainControlOccurrence(
        occurrence,
        input.epochWitness,
        input.targetCutoffAt,
      );
      const runControls = controls.get(control.document.logicalKey.runInitializedAt) ?? [];
      runControls.push(control);
      controls.set(control.document.logicalKey.runInitializedAt, runControls);
      continue;
    }
    if (occurrence.payloadKind === TARGET_VERSION) {
      const target = parseRainTargetOccurrence(
        occurrence,
        input.epochWitness,
        input.targetCutoffAt,
      );
      const groups = targets.get(target.document.validAt) ?? [];
      groups.push(target);
      targets.set(target.document.validAt, groups);
      continue;
    }
    if ([REVISION_V1_VERSION, REVISION_V2_VERSION].includes(occurrence.payloadKind)) {
      const members = parseRainActualBestMatchOccurrence(
        occurrence,
        input.epochWitness,
        input.targetCutoffAt,
      );
      for (const member of members) {
        const matches = actualBestMatches.get(member.row.validAt) ?? [];
        matches.push(member);
        actualBestMatches.set(member.row.validAt, matches);
      }
    }
  }

  // freeze target order by first complete native archive receipt, never by outcome
  for (const [validAt, groups] of targets) {
    targets.set(validAt, sortRainTargets(groups));
  }
  return Object.freeze({ actualBestMatches, capsules, controls, targets });
}

// parse canonical serving Best Match rows into their genuine five-key archive members
function parseRainActualBestMatchOccurrence(occurrence, witness, targetCutoffAt) {
  validateOccurrence(occurrence);
  const document = parseForecastAdjustmentMaintenanceRevisionProjection({
    projectionBytes: Buffer.from(occurrence.payloadBytes),
  });
  const correctVersionFamily =
    document.contractVersion === REVISION_V2_VERSION && document.family === "wind" ||
    document.contractVersion === REVISION_V1_VERSION && document.family === "shared";
  if (document.projectionKind !== "actual_best_match") {
    return Object.freeze([]);
  }
  if (!correctVersionFamily || occurrence.payloadKind !== document.contractVersion ||
    occurrence.receipts.length !== (document.contractVersion === REVISION_V2_VERSION
      ? document.rows.length
      : 1)) {
    throw new TypeError("rain Best Match archive envelope differs");
  }
  if (!rainBestMatchSourceIsCanonical(document)) {
    return Object.freeze([]);
  }
  requireClock(document.logicalKey.productRunAt, witness.epochAt, targetCutoffAt,
    "rain Best Match productRunAt");
  requireClock(document.logicalReceivedAt, witness.epochAt, targetCutoffAt,
    "rain Best Match logicalReceivedAt");
  if (document.logicalKey.productRunAt > document.logicalReceivedAt) {
    throw new TypeError("rain Best Match logical receipt predates its source");
  }
  return Object.freeze(document.rows.map((row, rowIndex) => {
    const receipt = occurrence.receipts.length === 1
      ? occurrence.receipts[0]
      : occurrence.receipts[rowIndex];
    validateReceipt(receipt, "actual_best_match", witness.epochAt, targetCutoffAt,
      occurrence.payloadIdentitySha256, occurrence.payloadIdentitySha256);
    requireClock(row.validAt, witness.epochAt, targetCutoffAt, "rain Best Match validAt");
    if (receipt.archiveCommittedAt < document.logicalReceivedAt) {
      throw new TypeError("rain Best Match receipt predates its normalized row");
    }
    return Object.freeze({
      document,
      memberSha256: archiveRowMemberSha256(
        receipt,
        occurrence.payloadIdentitySha256,
        "actual_best_match",
        rowIndex,
      ),
      occurrence,
      receipt,
      row,
      rowIndex,
    });
  }));
}

// accept only the production v4 Best Match source lineage, independent from outcome values
function rainBestMatchSourceIsCanonical(document) {
  const canonical = FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1;
  return document.source.adapterVersion === canonical.adapterVersion &&
    document.source.contractEpoch === canonical.contractEpoch &&
    document.source.dataset === "best_match" &&
    document.source.providerKey === "open-meteo" &&
    document.source.sourceConfigFingerprint === canonical.sourceConfigFingerprint &&
    document.source.sourceId === document.logicalKey.sourceId &&
    document.source.sourceKey === canonical.sourceKey &&
    document.source.sourceKind === "forecast" &&
    document.source.upstreamModel === canonical.upstreamModel;
}

// parse one archived capsule while preserving its genuine shadow receipt
function parseRainCapsuleOccurrence(occurrence, witness, targetCutoffAt) {
  validateOccurrence(occurrence);
  const outer = parseShadowRevisionCapsule(Buffer.from(occurrence.payloadBytes));
  const parsed = parseForecastAdjustmentMaintenanceShadowCapsule({
    capsuleBytes: Buffer.from(occurrence.payloadBytes),
  });
  const receipt = occurrence.receipts[0];
  if (occurrence.payloadKind !== CAPSULE_VERSION || outer.contractVersion !== CAPSULE_VERSION ||
    parsed.body.family !== "rain" || parsed.source.family !== "rain" || parsed.comparator === null ||
    occurrence.receipts.length !== 1 ||
    canonicalJsonBytes(receipt) !== canonicalJsonBytes(parsed.revisionReceipt) ||
    outer.metadata.dueKey !== parsed.body.dueKey ||
    outer.metadata.predictionBodySha256 !== sha256(parsed.bodyBytes) ||
    outer.sourceProjectionSha256 !== sha256(parsed.sourceBytes)) {
    throw new TypeError("rain confirmation capsule differs");
  }
  validateReceipt(receipt, "shadow_prediction", witness.epochAt, targetCutoffAt,
    parsed.sourceIdentity.sourceReceiptSha256, parsed.sourceIdentity.inputSha256);
  validateRainSourceClocks(parsed.source, witness.epochAt, targetCutoffAt);
  requireClock(outer.predictionCommittedAt, witness.epochAt, targetCutoffAt,
    "rain prediction committedAt");
  if (outer.predictionCommittedAt > receipt.archiveCommittedAt) {
    throw new TypeError("rain prediction archive clock differs");
  }
  return Object.freeze({ occurrence, outer, parsed, receipt });
}

// parse one pre-target control projection and its one database-owned receipt
function parseRainControlOccurrence(occurrence, witness, targetCutoffAt) {
  validateOccurrence(occurrence);
  const document = parseForecastAdjustmentRainMaintenanceControlProjection({
    projectionBytes: Buffer.from(occurrence.payloadBytes),
  });
  const receipt = occurrence.receipts[0];
  if (occurrence.payloadKind !== CONTROL_VERSION || document.contractVersion !== CONTROL_VERSION ||
    document.projectionKind !== "rain_gate_input" || occurrence.receipts.length !== 1) {
    throw new TypeError("rain confirmation control differs");
  }
  validateReceipt(receipt, "rain_gate_input", witness.epochAt, targetCutoffAt,
    occurrence.payloadIdentitySha256, occurrence.payloadIdentitySha256);
  for (const clock of [document.logicalKey.runInitializedAt, document.logicalReceivedAt]) {
    requireClock(clock, witness.epochAt, targetCutoffAt, "rain control clock");
  }
  if (document.logicalReceivedAt > receipt.archiveCommittedAt ||
    document.rows.some((row) => document.logicalReceivedAt >= row.validAt ||
      receipt.archiveCommittedAt >= row.validAt)) {
    throw new TypeError("rain confirmation control is not pre-target");
  }
  return Object.freeze({ document, occurrence, receipt });
}

// parse one complete twelve-gauge target and all twelve native receipts
function parseRainTargetOccurrence(occurrence, witness, targetCutoffAt) {
  validateOccurrence(occurrence);
  const parsed = parseForecastAdjustmentRainFixedGaugeTarget({
    projectionBytes: Buffer.from(occurrence.payloadBytes),
  });
  const document = parsed.projection;
  if (occurrence.payloadKind !== TARGET_VERSION || document.contractVersion !== TARGET_VERSION ||
    document.projectionKind !== "target_revision" || occurrence.receipts.length !== 12) {
    throw new TypeError("rain confirmation target differs");
  }
  requireClock(document.logicalReceivedAt, witness.epochAt, targetCutoffAt,
    "rain target logicalReceivedAt");
  requireClock(document.validAt, witness.epochAt, targetCutoffAt, "rain target validAt");
  const members = occurrence.receipts.map((receipt, rowIndex) => {
    validateReceipt(receipt, "target_revision", witness.epochAt, targetCutoffAt,
      occurrence.payloadIdentitySha256, occurrence.payloadIdentitySha256);
    if (receipt.archiveCommittedAt < document.logicalReceivedAt) {
      throw new TypeError("rain confirmation target receipt predates its raw graph");
    }
    return Object.freeze({
      memberSha256: archiveRowMemberSha256(
        receipt,
        occurrence.payloadIdentitySha256,
        "target_revision",
        rowIndex,
      ),
      receipt,
      rowIndex,
    });
  });

  // require every embedded raw claim and interval to remain future-only
  for (const body of document.captureBodies) {
    for (const claim of body.claims) {
      for (const clock of [claim.completedAt, claim.windowStart, claim.windowEndExclusive]) {
        requireClock(clock, witness.epochAt, targetCutoffAt, "rain target claim clock");
      }
    }
  }
  for (const row of document.rows) {
    for (const interval of row.intervals) {
      requireClock(interval.completedAt, witness.epochAt, targetCutoffAt,
        "rain target interval completedAt");
      requireClock(interval.validAt, witness.epochAt, targetCutoffAt,
        "rain target interval validAt");
    }
  }
  return Object.freeze({
    actual: parsed.actual,
    document,
    maximumArchiveOrdinal: members.reduce(
      // select the first whole target group by its terminal native ordinal
      (maximum, member) => BigInt(member.receipt.archiveCommitOrdinal) > maximum
        ? BigInt(member.receipt.archiveCommitOrdinal)
        : maximum,
      0n,
    ),
    members: Object.freeze(members),
    occurrence,
  });
}

// join one candidate row to its exact control, nested source and first fixed target
function resolveRainRecord(input) {
  const { body, bodyBytes, comparator, comparatorBytes, source, sourceBytes, sourceIdentity } =
    input.capsule.parsed;
  // require the full control/source/comparator population before selecting one row
  if (!rainControlMatchesCapsule(input.capsule, input.control)) {
    return null;
  }
  const rowIndex = input.selector.rowIndex;
  const bodyRow = body.rows[rowIndex];
  const sourceRow = source.rows[rowIndex];
  const comparatorRow = comparator.rows[rowIndex];
  const controlRow = input.control.document.rows[rowIndex];
  if (bodyRow === undefined || sourceRow === undefined || comparatorRow === undefined ||
    controlRow === undefined || body.dueKey !== input.selector.dueKey ||
    bodyRow.leadHours !== input.selector.leadHours ||
    sourceRow.leadHours !== input.selector.leadHours ||
    comparatorRow.leadHours !== input.selector.leadHours ||
    sourceRow.modelLeadHours !== input.selector.leadHours + 8 ||
    controlRow.modelLeadHours !== sourceRow.modelLeadHours ||
    new Set([bodyRow.validAt, sourceRow.validAt, comparatorRow.validAt,
      controlRow.validAt]).size !== 1) {
    return null;
  }
  if (input.capsule.outer.predictionCommittedAt >= bodyRow.validAt) {
    return null;
  }
  const runInitializedAt = sourceRow.referenceAt;
  const minimumIssuedAt = new Date(Date.parse(runInitializedAt) + 8 * HOUR).toISOString();
  const expectedDueKey = `capture/${new Date(Date.parse(runInitializedAt) + 35 * 60_000)
    .toISOString()}`;
  const forecastCapture = source.causalInputs.captureSet.find(
    // bind the selected source row to its actual raw provider capture
    (capture) => capture.kind === "forecast" &&
      capture.runInitializedAt === runInitializedAt &&
      capture.bodySha256 === sourceRow.contentSha256,
  );
  if (source.issuedAt < minimumIssuedAt || source.issuedAt >= bodyRow.validAt ||
    body.dueKey !== expectedDueKey ||
    Date.parse(sourceRow.validAt) !== Date.parse(runInitializedAt) +
      sourceRow.modelLeadHours * HOUR ||
    source.causalInputs.currentRun.runInitializedAt !== runInitializedAt ||
    source.causalInputs.currentRun.contentSha256 !== sourceRow.contentSha256 ||
    source.causalInputs.currentRun.completedAt !== sourceRow.receivedAt ||
    forecastCapture === undefined || forecastCapture.completedAt !== sourceRow.receivedAt ||
    input.control.document.logicalKey.runInitializedAt !== runInitializedAt ||
    input.control.document.source.contractEpoch !== sourceRow.contractEpoch ||
    input.control.document.source.dataset !== sourceRow.dataset ||
    input.control.document.source.providerKey !== sourceRow.providerKey ||
    input.control.document.source.sourceConfigFingerprint !== sourceRow.sourceConfigFingerprint ||
    input.control.document.source.sourceKey !== sourceRow.sourceKey ||
    input.control.document.source.upstreamModel !== sourceRow.upstreamModel ||
    controlRow.rawPrecipitationMm64 !== sourceRow.precipitationMm64 ||
    input.control.document.logicalReceivedAt < source.issuedAt ||
    input.control.document.logicalReceivedAt > input.capsule.outer.predictionCommittedAt ||
    input.control.receipt.archiveCommittedAt < input.control.document.logicalReceivedAt ||
    input.control.receipt.archiveCommittedAt > input.capsule.outer.predictionCommittedAt ||
    input.capsule.receipt.archiveCommittedAt >= bodyRow.validAt) {
    return null;
  }
  const authority = comparator.servingAuthority;
  if (comparatorRow.incumbentPrecipitationMm64 !== controlRow.incumbentPrediction64 ||
    comparatorRow.occurrenceProbability64 !== controlRow.incumbentProbability.atLeast0_1 ||
    comparatorRow.atLeast1_0Probability64 !== controlRow.incumbentProbability.atLeast1_0 ||
    comparatorRow.atLeast2_5Probability64 !== controlRow.incumbentProbability.atLeast2_5 ||
    authority.artifactIdentitySha256 !== controlRow.incumbentArtifactIdentitySha256 ||
    authority.receiptMemberSha256 !== controlRow.incumbentReceiptMemberSha256) {
    return null;
  }
  const target = input.targets[0];
  if (target === undefined || target.actual === null ||
    target.document.validAt !== bodyRow.validAt) {
    return null;
  }
  const actualBestMatch = selectRainActualBestMatch(
    input.actualBestMatches,
    input.capsule,
    target,
  );
  if (actualBestMatch === undefined || actualBestMatch.row.precipitationMm64 === null) {
    return null;
  }
  const controlMemberSha256 = archiveRowMemberSha256(
    input.control.receipt,
    input.control.occurrence.payloadIdentitySha256,
    "rain_gate_input",
    rowIndex,
  );
  const nativeSourceMemberSha256 = sourceIdentity.sourceRowSha256[rowIndex];
  const comparatorMemberSha256 = sha256(comparatorBytes);
  const firstEdgeCommittedAt = [
    actualBestMatch.receipt.archiveCommittedAt,
    input.capsule.outer.predictionCommittedAt,
    input.capsule.receipt.archiveCommittedAt,
    input.control.receipt.archiveCommittedAt,
    ...target.members.map((member) => member.receipt.archiveCommittedAt),
  ].sort().at(-1);
  const comparison = Object.freeze({
    actualBestMatchPrediction:
      decodeMaintenanceBinary64(actualBestMatch.row.precipitationMm64),
    farmTarget: null,
    firstEdgeCommittedAt,
    incumbentPrediction: decodeMaintenanceBinary64(controlRow.incumbentPrediction64),
    incumbentProbability: decodeProbability(controlRow.incumbentProbability),
    membership: Object.freeze({
      actualBestMatchProjectionSha256: actualBestMatch.occurrence.payloadIdentitySha256,
      actualBestMatchReceiptSha256: actualBestMatch.receipt.receiptSha256,
      incumbentMemberSha256: comparatorMemberSha256,
      nativeSourceProjectionSha256: sha256(sourceBytes),
      nativeSourceReceiptSha256: input.capsule.receipt.receiptSha256,
      rainGateProjectionSha256: input.control.occurrence.payloadIdentitySha256,
      rainGateReceiptSha256: input.control.receipt.receiptSha256,
      targetMemberSha256: target.occurrence.payloadIdentitySha256,
    }),
    nativeSourceProbability: decodeProbability(controlRow.nativeSourceProbability),
    nearestThree: null,
    persistencePrediction: decodeMaintenanceBinary64(controlRow.persistencePrediction64),
    providerFamily: null,
    rawTargetHourTemperatureC:
      decodeMaintenanceBinary64(controlRow.rawTargetHourTemperatureC64),
    recentVolumeScalePrediction:
      decodeMaintenanceBinary64(controlRow.recentVolumeScalePrediction64),
    runKey: `${runInitializedAt}/${bodyRow.validAt}`,
    sameWindowVolumeScalePrediction:
      decodeMaintenanceBinary64(controlRow.sameWindowVolumeScalePrediction64),
    stationKey: null,
    target: target.actual.target,
    unchangedOrdinalPrediction:
      decodeMaintenanceBinary64(controlRow.unchangedOrdinalPrediction64),
    volumeScalePrediction: decodeMaintenanceBinary64(controlRow.volumeScalePrediction64),
  });
  const required = new Set([
    actualBestMatch.memberSha256,
    actualBestMatch.occurrence.payloadIdentitySha256,
    actualBestMatch.receipt.receiptSha256,
    input.capsule.occurrence.payloadIdentitySha256,
    input.capsule.receipt.receiptSha256,
    sha256(bodyBytes),
    sha256(sourceBytes),
    comparatorMemberSha256,
    authority.receiptMemberSha256,
    controlMemberSha256,
    input.control.occurrence.payloadIdentitySha256,
    input.control.receipt.receiptSha256,
    nativeSourceMemberSha256,
    target.occurrence.payloadIdentitySha256,
    ...target.members.flatMap((member) => [member.memberSha256, member.receipt.receiptSha256]),
  ]);
  if (authority.artifactIdentitySha256 !== null) {
    required.add(authority.artifactIdentitySha256);
  }
  return Object.freeze({
    graphBinding: Object.freeze({
      actualBestMatch: Object.freeze({
        memberSha256: actualBestMatch.memberSha256,
        payloadIdentitySha256: actualBestMatch.occurrence.payloadIdentitySha256,
        receiptSha256: actualBestMatch.receipt.receiptSha256,
      }),
      capsule: Object.freeze({
        comparatorMemberSha256,
        payloadIdentitySha256: input.capsule.occurrence.payloadIdentitySha256,
        predictionBodySha256: sha256(bodyBytes),
        receiptSha256: input.capsule.receipt.receiptSha256,
        sourceProjectionSha256: sha256(sourceBytes),
      }),
      key: input.key,
      nativeSource: Object.freeze({
        memberSha256: nativeSourceMemberSha256,
        payloadIdentitySha256: sha256(sourceBytes),
        receiptSha256: input.capsule.receipt.receiptSha256,
      }),
      target: Object.freeze({
        sourceMemberSha256s: Object.freeze(target.members.map(
          // retain all twelve genuine target rows, including explicit missing gauges
          (member) => member.memberSha256,
        )),
        targetMemberSha256: target.occurrence.payloadIdentitySha256,
      }),
    }),
    graphManifestSha256s: Object.freeze([
      actualBestMatch.occurrence.graphManifestSha256,
      input.capsule.occurrence.graphManifestSha256,
      input.control.occurrence.graphManifestSha256,
      target.occurrence.graphManifestSha256,
    ].sort()),
    rainGateInputMemberSha256: controlMemberSha256,
    record: Object.freeze({
      capsuleBase64: Buffer.from(input.capsule.occurrence.payloadBytes).toString("base64"),
      comparison,
      key: input.key,
      metric: null,
      rowIndex,
    }),
    requiredMemberIdentitySha256s: Object.freeze([...required].sort()),
    targetMemberSha256: target.occurrence.payloadIdentitySha256,
  });
}

// choose the first genuine normalized source revision available before prediction and target
function selectRainActualBestMatch(members, capsule, target) {
  const matches = members.filter((member) =>
    member.document.logicalReceivedAt <= capsule.outer.predictionCommittedAt &&
    member.receipt.archiveCommittedAt <= capsule.outer.predictionCommittedAt &&
    member.document.logicalReceivedAt <= target.document.logicalReceivedAt &&
    member.receipt.archiveCommittedAt <= target.document.logicalReceivedAt);
  matches.sort((left, right) => {
    const ordinalOrder = BigInt(left.receipt.archiveCommitOrdinal) <
      BigInt(right.receipt.archiveCommitOrdinal)
      ? -1
      : BigInt(left.receipt.archiveCommitOrdinal) > BigInt(right.receipt.archiveCommitOrdinal)
        ? 1
        : 0;
    return ordinalOrder || left.memberSha256.localeCompare(right.memberSha256);
  });
  if (matches.length > 1 && matches[0].receipt.archiveCommitOrdinal ===
    matches[1].receipt.archiveCommitOrdinal && matches[0].memberSha256 !==
    matches[1].memberSha256) {
    throw new TypeError("rain Best Match first archive ordinal is ambiguous");
  }
  return matches[0];
}

// select the first complete native target group independently from archive page order
function sortRainTargets(groups) {
  const sorted = [...groups].sort((left, right) =>
    left.maximumArchiveOrdinal < right.maximumArchiveOrdinal
      ? -1
      : left.maximumArchiveOrdinal > right.maximumArchiveOrdinal
        ? 1
        : left.occurrence.payloadIdentitySha256.localeCompare(
            right.occurrence.payloadIdentitySha256,
          ));
  if (sorted.length > 1 && sorted[0].maximumArchiveOrdinal ===
    sorted[1].maximumArchiveOrdinal && sorted[0].occurrence.payloadIdentitySha256 !==
    sorted[1].occurrence.payloadIdentitySha256) {
    throw new TypeError("rain confirmation target archive ordinal is duplicated");
  }
  return sorted;
}

// select the one control whose full source and incumbent tuples match the capsule
function selectRainControl(capsule, controls) {
  const matches = controls.filter(
    // resolve by all twenty-three rows, never by an unshared content hash
    (control) => rainControlMatchesCapsule(capsule, control),
  );
  if (matches.length > 1) {
    throw new TypeError("rain confirmation control source is ambiguous");
  }
  return matches[0];
}

// cross-bind one archived control to the nested source and comparator population
function rainControlMatchesCapsule(capsule, control) {
  const { comparator, source } = capsule.parsed;
  const authority = comparator.servingAuthority;
  const forecastCapture = source.causalInputs.captureSet.find(
    // identify the exact current raw forecast claim retained in the capsule
    (capture) => capture.kind === "forecast" &&
      capture.runInitializedAt === source.causalInputs.currentRun.runInitializedAt &&
      capture.bodySha256 === source.causalInputs.currentRun.contentSha256,
  );
  if (forecastCapture === undefined ||
    control.document.logicalKey.runInitializedAt !==
      source.causalInputs.currentRun.runInitializedAt ||
    control.document.source.sourceId !== forecastCapture.claimId ||
    control.document.source.contractEpoch !== source.rows[0].contractEpoch ||
    control.document.source.dataset !== source.rows[0].dataset ||
    control.document.source.providerKey !== source.rows[0].providerKey ||
    control.document.source.sourceConfigFingerprint !== source.rows[0].sourceConfigFingerprint ||
    control.document.source.sourceKey !== source.rows[0].sourceKey ||
    control.document.source.upstreamModel !== source.rows[0].upstreamModel ||
    authority.artifactIdentitySha256 !==
      control.document.rows[0].incumbentArtifactIdentitySha256 ||
    authority.receiptMemberSha256 !== control.document.rows[0].incumbentReceiptMemberSha256 ||
    control.document.logicalReceivedAt < source.issuedAt ||
    control.document.logicalReceivedAt > capsule.outer.predictionCommittedAt ||
    control.receipt.archiveCommittedAt < control.document.logicalReceivedAt ||
    control.receipt.archiveCommittedAt > capsule.outer.predictionCommittedAt) {
    return false;
  }
  return source.rows.every((sourceRow, index) => {
    const comparatorRow = comparator.rows[index];
    const controlRow = control.document.rows[index];
    return comparatorRow !== undefined && controlRow !== undefined &&
      sourceRow.referenceAt === control.document.logicalKey.runInitializedAt &&
      sourceRow.modelLeadHours === controlRow.modelLeadHours &&
      sourceRow.validAt === controlRow.validAt &&
      sourceRow.precipitationMm64 === controlRow.rawPrecipitationMm64 &&
      comparatorRow.incumbentPrecipitationMm64 === controlRow.incumbentPrediction64 &&
      comparatorRow.occurrenceProbability64 === controlRow.incumbentProbability.atLeast0_1 &&
      comparatorRow.atLeast1_0Probability64 === controlRow.incumbentProbability.atLeast1_0 &&
      comparatorRow.atLeast2_5Probability64 === controlRow.incumbentProbability.atLeast2_5;
  });
}

// validate the complete or partial blinded graph before opening any values
function validateRainPlan(plan, complete) {
  if (complete) {
    requireExactKeys(plan, [
      "contractVersion", "eligiblePredictionSetSha256", "entryCount", "expectedKeySetSha256",
      "family", "planGraph", "registrationSha256", "revisionCatalogWatermarkSha256",
      "snapshotRootSha256", "state", "targetCutoffAt",
    ], "rain complete confirmation plan");
    if (plan.contractVersion !== ADJUSTMENT_MAINTENANCE_CONFIRMATION_VALUE_PLAN_VERSION ||
      plan.planGraph.contractVersion !== ADJUSTMENT_MAINTENANCE_CONFIRMATION_PLAN_GRAPH_VERSION) {
      throw new TypeError("rain complete confirmation plan differs");
    }
    validateAdjustmentMaintenanceConfirmationPlanGraph(plan.planGraph);
    return;
  }
  requireExactKeys(plan, [
    "contractVersion", "eligiblePredictionSetSha256", "entryCount", "expectedKeySetSha256",
    "family", "missingDueKeyCount", "missingDueKeySetSha256", "planGraph",
    "registrationSha256", "revisionCatalogWatermarkSha256", "snapshotRootSha256", "state",
    "targetCutoffAt",
  ], "rain unsupported confirmation plan");
  if (plan.contractVersion !== ADJUSTMENT_MAINTENANCE_UNSUPPORTED_CONFIRMATION_PLAN_VERSION) {
    throw new TypeError("rain unsupported confirmation plan differs");
  }
  validateAdjustmentMaintenanceUnsupportedPlanGraph(plan.planGraph);
}

// bind the owner burn to the exact blinded plan before value parsing
function validateRainAccess(access, plan, registration) {
  if (access === null || typeof access !== "object" || Array.isArray(access)) {
    throw new TypeError("rain confirmation access is invalid");
  }
  for (const field of [
    "accessSha256", "expectedKeySetSha256", "revisionCatalogWatermarkSha256",
    "targetComparatorSnapshotRootSha256",
  ]) {
    requireHash(access[field], `rain confirmation ${field}`);
  }
  requireInstant(access.accessedAt, "rain confirmation accessedAt");
  requireInstant(access.targetCutoffAt, "rain confirmation targetCutoffAt");
  const unsigned = { ...access };
  delete unsigned.accessSha256;
  if (access.accessState !== "burned" || access.family !== "rain" ||
    registration.family !== "rain" || access.registrationSha256 !== registration.registrationSha256 ||
    access.accessSha256 !== sha256(canonicalJsonBytes(unsigned)) ||
    access.expectedKeySetSha256 !== plan.expectedKeySetSha256 ||
    access.revisionCatalogWatermarkSha256 !== plan.revisionCatalogWatermarkSha256 ||
    access.targetComparatorSnapshotRootSha256 !== plan.snapshotRootSha256 ||
    access.targetCutoffAt !== plan.targetCutoffAt ||
    Date.parse(access.accessedAt) < Date.parse(registration.terminalAccessAt)) {
    throw new TypeError("rain confirmation access differs from its plan");
  }
}

// require all nested causal clocks to be post-epoch and available at issue time
function validateRainSourceClocks(source, epochAt, targetCutoffAt) {
  requireClock(source.issuedAt, epochAt, targetCutoffAt, "rain source issuedAt");
  const clocks = [source.causalInputs.currentRun.runInitializedAt,
    source.causalInputs.currentRun.completedAt];
  for (const run of source.causalInputs.priorRuns) {
    clocks.push(run.runInitializedAt, run.completedAt);
  }
  for (const capture of source.causalInputs.captureSet) {
    clocks.push(capture.completedAt);
    if (capture.runInitializedAt !== null) clocks.push(capture.runInitializedAt);
    if (capture.windowStart !== null) clocks.push(capture.windowStart);
    if (capture.windowEndExclusive !== null) clocks.push(capture.windowEndExclusive);
  }
  for (const station of source.causalInputs.stationHours) {
    clocks.push(station.hourAt, station.receivedAt);
  }
  for (const row of source.rows) {
    clocks.push(row.referenceAt, row.receivedAt, row.validAt);
  }
  for (const clock of clocks) {
    requireClock(clock, epochAt, targetCutoffAt, "rain source causal clock");
  }
  if (source.causalInputs.currentRun.completedAt > source.issuedAt ||
    source.causalInputs.captureSet.some((capture) => capture.completedAt > source.issuedAt) ||
    source.causalInputs.stationHours.some((row) => row.receivedAt > source.issuedAt) ||
    source.rows.some((row) => row.receivedAt > source.issuedAt || row.validAt <= source.issuedAt)) {
    throw new TypeError("rain source causal availability differs");
  }
}

// validate one archive occurrence envelope before contract-specific parsing
function validateOccurrence(occurrence) {
  requireExactKeys(occurrence, [
    "graphManifestSha256", "pageSha256", "payloadBytes", "payloadIdentitySha256",
    "payloadKind", "publicationDisposition", "receipts",
  ], "rain confirmation occurrence");
  requireHash(occurrence.graphManifestSha256, "rain confirmation graphManifestSha256");
  requireHash(occurrence.pageSha256, "rain confirmation pageSha256");
  requireHash(occurrence.payloadIdentitySha256, "rain confirmation payloadIdentitySha256");
  if (!(occurrence.payloadBytes instanceof Uint8Array) || !Array.isArray(occurrence.receipts) ||
    occurrence.publicationDisposition !== "published" ||
    sha256(occurrence.payloadBytes) !== occurrence.payloadIdentitySha256) {
    throw new TypeError("rain confirmation occurrence identity differs");
  }
}

// bind one database receipt to its exact archived projection and snapshot clocks
function validateReceipt(receipt, kind, epochAt, targetCutoffAt, identity, projectionSha256) {
  if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new TypeError("rain confirmation receipt is invalid");
  }
  requireHash(receipt.receiptSha256, "rain confirmation receiptSha256");
  if (!DECIMAL.test(receipt.archiveCommitOrdinal) || receipt.projectionKind !== kind ||
    receipt.projectionIdentitySha256 !== identity || receipt.projectionSha256 !== projectionSha256) {
    throw new TypeError("rain confirmation receipt binding differs");
  }
  requireClock(receipt.archiveCommittedAt, epochAt, targetCutoffAt,
    "rain confirmation archiveCommittedAt");
}

// derive the existing five-key archive member identity for one projected row
function archiveRowMemberSha256(receipt, payloadIdentitySha256, projectionKind, rowIndex) {
  return sha256(canonicalJsonBytes({
    archiveCommitOrdinal: receipt.archiveCommitOrdinal,
    payloadIdentitySha256,
    projectionKind,
    receiptSha256: receipt.receiptSha256,
    rowIndex,
  }));
}

// reject ambiguous duplicate archive identities instead of choosing by value
function addUnique(index, key, value, label) {
  const previous = index.get(key);
  if (previous !== undefined &&
    previous.occurrence.payloadIdentitySha256 !== value.occurrence.payloadIdentitySha256) {
    throw new TypeError(`${label} is duplicated`);
  }
  index.set(key, value);
}

// parse one preregistered rain cycle, operational lead and target selector
function parseRainExpectedKey(value) {
  const match = /^(capture\/20\d{2}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z)\/(\d{1,2})\/rain$/u
    .exec(value);
  const leadHours = Number(match?.[2]);
  if (match === null || !Number.isInteger(leadHours) || leadHours < 1 || leadHours > 23) {
    throw new TypeError("rain confirmation expected key differs");
  }
  return Object.freeze({ dueKey: match[1], leadHours, rowIndex: leadHours - 1 });
}

// decode one nested probability vector without decimal serialization drift
function decodeProbability(value) {
  return Object.freeze({
    atLeast0_1: decodeMaintenanceBinary64(value.atLeast0_1),
    atLeast1_0: decodeMaintenanceBinary64(value.atLeast1_0),
    atLeast2_5: decodeMaintenanceBinary64(value.atLeast2_5),
  });
}

// require one future-only clock inside the burned snapshot
function requireClock(value, epochAt, targetCutoffAt, label) {
  requireInstant(value, label);
  if (Date.parse(value) < Date.parse(epochAt) || Date.parse(value) > Date.parse(targetCutoffAt)) {
    throw new RangeError(`${label} is outside the future-only snapshot`);
  }
}

// require one canonical UTC millisecond clock
function requireInstant(value, label) {
  if (typeof value !== "string" || !INSTANT.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one lowercase SHA-256 identity
function requireHash(value, label) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// reject open-ended objects at every public and archive boundary
function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new TypeError(`${label} fields differ`);
  }
}

// hash one exact byte identity
function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
