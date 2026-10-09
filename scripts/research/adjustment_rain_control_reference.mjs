import {
  createRainMaintenanceControlState,
  encodeRainMaintenanceControlState,
  RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256,
  RAIN_MAINTENANCE_CONTROL_STATE_VERSION,
  validateRainMaintenanceControlArtifact,
} from "./adjustment-maintenance-runtime/forecast/rain-maintenance-controls.js";
import {
  decodeMaintenanceBinary64,
  encodeMaintenanceBinary64,
} from "./adjustment-maintenance-runtime/forecast/maintenance-shadow-values.js";
import {
  createRainHurdleWindPortableArtifactEvaluator,
} from "./adjustment-maintenance-runtime/forecast/rain-hurdle-wind.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
} from "./adjustment-maintenance-runtime/forecast/rain-hurdle-wind-artifact.js";
import {
  parseForecastAdjustmentMaintenanceRevisionProjection,
  parseForecastAdjustmentRainFixedGaugeTarget,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import { validateAdjustmentFutureOnlyEpochWitness } from "./adjustment_maintenance_state.mjs";
import { ADJUSTMENT_ROLLING_SCHEDULE_SHA256 } from "./adjustment_rolling_schedule.mjs";
import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";

const DAY = 86_400_000;
const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONTH = /^20\d{2}-(?:0[1-9]|1[0-2])$/u;
const FEATURE_NAMES = Object.freeze(JSON.parse(RAIN_HURDLE_WIND_ARTIFACT_JSON).featureNames);
const MAXIMUM_ROWS = 250_000;

// join genuine forecast feature rows to the first twelve-gauge native target revision
export function buildAdjustmentRainHistoricalRows(input) {
  exact(input, ["dueMonth", "epochWitness", "projection"], "rain historical input");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  month(input.dueMonth);
  const projection = input.projection;
  const cutoffAt = new Date(Date.parse(`${input.dueMonth}-01T00:00:00.000Z`) - 7 * DAY).toISOString();
  // independently bind the authenticated projection to the original monthly cutoff
  if (projection?.contractVersion !== "adjustment-revision-fit-projection/v2" ||
    projection.family !== "rain" || projection.dueMonth !== input.dueMonth ||
    projection.epochWitnessSha256 !== witness.witnessSha256 || projection.cutoffAt !== cutoffAt ||
    !Array.isArray(projection.projectionMembers) || !Array.isArray(projection.shadowMembers) ||
    projection.projectionMembers.length > 1_000_000) {
    throw new TypeError("rain historical projection differs");
  }
  const identities = [...projection.projectionMembers.map((member) => member.memberSha256),
    ...projection.shadowMembers.map((member) => member.payloadIdentitySha256)].sort();
  // do not accept a caller-supplied population root without its actual member identities
  if (projection.memberRootSha256 !== adjustmentSha256(canonicalJsonBytes(identities))) {
    throw new Error("rain historical member root differs");
  }
  const targetGroups = new Map();
  const featureMembers = [];
  // replay each consumed member through its original closed production parser
  for (const member of projection.projectionMembers) {
    const fixedGauge = member.document?.contractVersion === "adjustment-rain-fixed-gauge-target-projection/v1";
    const feature = ["adjustment-rain-gate-feature-projection/v2",
      "adjustment-rain-gate-control-projection/v3"].includes(member.document?.contractVersion);
    // unrelated classes cannot be used to fabricate rain target or feature support
    if (!fixedGauge && !feature) continue;
    validateMember(member, witness.epochAt, cutoffAt);
    const document = fixedGauge
      ? parseForecastAdjustmentRainFixedGaugeTarget({ projectionBytes: member.payloadBytes }).projection
      : parseForecastAdjustmentMaintenanceRevisionProjection({ projectionBytes: member.payloadBytes });
    // bind decoded rows to their exact archived bytes rather than mutable projection objects
    if (!canonicalJsonBytes(document).equals(canonicalJsonBytes(member.document)) ||
      document.projectionKind !== member.projectionKind ||
      document.rows[member.rowIndex] === undefined ||
      !canonicalJsonBytes(document.rows[member.rowIndex]).equals(canonicalJsonBytes(member.row))) {
      throw new Error("rain historical decoded member differs");
    }
    // collect every gauge, including explicit missing gauges, under the same native body
    if (fixedGauge) {
      causal(document.logicalReceivedAt, witness.epochAt, cutoffAt);
      causal(document.validAt, witness.epochAt, cutoffAt);
      // independently enforce the original raw collection clocks, not only normalized target time
      for (const body of document.captureBodies) {
        for (const claim of body.claims) {
          causal(claim.completedAt, witness.epochAt, cutoffAt);
          causal(claim.windowStart, witness.epochAt, cutoffAt);
          causal(claim.windowEndExclusive, witness.epochAt, cutoffAt);
        }
      }
      // all consumed physical intervals must also be post-epoch
      for (const interval of member.row.intervals) {
        causal(interval.validAt, witness.epochAt, cutoffAt);
        causal(interval.completedAt, witness.epochAt, cutoffAt);
      }
      const group = targetGroups.get(member.payloadIdentitySha256) ?? [];
      group.push(member);
      targetGroups.set(member.payloadIdentitySha256, group);
    } else {
      featureMembers.push(member);
    }
  }
  const targets = new Map();
  // require whole twelve-source populations before deriving the fixed weighted median
  for (const members of targetGroups.values()) {
    members.sort((left, right) => left.rowIndex - right.rowIndex);
    // never turn a partial group or repeated row into apparent gauge support
    if (members.length !== 12 || members.some((member, index) => member.rowIndex !== index) ||
      new Set(members.map((member) => member.receipt.receiptSha256)).size !== 12) {
      throw new Error("rain historical target group differs");
    }
    const document = members[0].document;
    const actual = parseForecastAdjustmentRainFixedGaugeTarget({
      projectionBytes: members[0].payloadBytes,
    }).actual;
    const lastOrdinal = members.reduce((maximum, member) =>
      BigInt(member.receipt.archiveCommitOrdinal) > maximum
        ? BigInt(member.receipt.archiveCommitOrdinal) : maximum, 0n);
    const previous = targets.get(document.validAt);
    // freeze the first native group, including unsupported groups, without target-sensitive repair
    if (previous === undefined || lastOrdinal < previous.lastOrdinal) {
      targets.set(document.validAt, { actual, lastOrdinal, members });
    }
  }
  featureMembers.sort((left, right) => compareOrdinal(left.receipt, right.receipt) ||
    left.rowIndex - right.rowIndex);
  const consumed = new Map();
  const populationMembers = [];
  const rows = [];
  const seen = new Map();
  // retain the first genuine pre-target feature revision for every run and target hour
  for (const member of featureMembers) {
    const { document, row, receipt } = member;
    const runInitializedAt = document.logicalKey.runInitializedAt;
    const issuedAt = new Date(Date.parse(runInitializedAt) + 8 * 3_600_000).toISOString();
    causal(runInitializedAt, witness.epochAt, cutoffAt);
    causal(document.logicalReceivedAt, witness.epochAt, cutoffAt);
    causal(row.validAt, witness.epochAt, cutoffAt);
    const identity = `${runInitializedAt}/${row.validAt}`;
    const operationalHorizonHours = row.modelLeadHours - 8;
    // timing eligibility is independent of the eventual gauge outcome
    if (receipt.archiveCommittedAt >= row.validAt || document.logicalReceivedAt >= row.validAt ||
      Date.parse(row.validAt) - Date.parse(runInitializedAt) !== row.modelLeadHours * 3_600_000 ||
      document.logicalReceivedAt < issuedAt || receipt.archiveCommittedAt < document.logicalReceivedAt ||
      operationalHorizonHours < 1 ||
      operationalHorizonHours > 23) continue;
    const numerical = { features: row.features64.map((value) => value === null
      ? null : numericalBinary64(value)), raw: numericalBinary64(row.rawPrecipitationMm64),
      rawTargetHourTemperatureC: numericalBinary64(row.rawTargetHourTemperatureC64) };
    const previous = seen.get(identity);
    // contradictory revisions cannot be hidden behind a reused forecast key
    if (previous !== undefined) {
      // preserve every immutable predictor across repeated capture occurrences
      if (!canonicalJsonBytes(previous).equals(canonicalJsonBytes(numerical))) {
        throw new Error("rain historical feature revision differs");
      }
      continue;
    }
    seen.set(identity, numerical);
    const target = targets.get(row.validAt);
    populationMembers.push(Object.freeze({
      issuedAt,
      key: identity,
      modelLeadHours: row.modelLeadHours,
      operationalHorizonHours,
      phaseEligible: numerical.rawTargetHourTemperatureC > 2,
      sourceMemberSha256: member.memberSha256,
      sourceReceiptSha256: receipt.receiptSha256,
      targetAvailable: target?.actual !== null && target !== undefined,
      validAt: row.validAt,
    }));
    // phase eligibility uses only the original forecast temperature
    if (numerical.rawTargetHourTemperatureC <= 2) continue;
    // unsupported actual gauge groups remain unavailable rather than receiving synthetic targets
    if (target?.actual === null || target === undefined) continue;
    const previousTarget = targets.get(new Date(Date.parse(issuedAt) - 3_600_000).toISOString());
    // historical persistence uses only target groups genuinely available at the original decision
    const persistence = previousTarget !== undefined && previousTarget.members.every(
      (targetMember) => targetMember.receipt.archiveCommittedAt < issuedAt,
    ) ? previousTarget : undefined;
    const targetMaxReceiptAt = target.members.reduce((maximum, targetMember) =>
      targetMember.receipt.archiveCommittedAt > maximum
        ? targetMember.receipt.archiveCommittedAt : maximum, witness.epochAt);
    const value = { actual: target.actual.target, evidenceClass: "development", ...numerical,
      gaugeCount: target.actual.gaugeCount, key: identity, modelLeadHours: row.modelLeadHours,
      operationalHorizonHours, persistencePrediction: persistence?.actual?.target ?? null,
      runInitializedAt, sourceReceiptAt: receipt.archiveCommittedAt,
      sourceRowSha256: member.memberSha256, targetMaxReceiptAt,
      targetRowSha256: adjustmentSha256(canonicalJsonBytes(
        target.members.map((targetMember) => targetMember.memberSha256).sort())),
      validAt: row.validAt };
    rows.push(Object.freeze(value));
    // cap native matrix rows separately from projected archive proof rows
    if (rows.length > MAXIMUM_ROWS) throw new RangeError("rain historical numerical row ceiling exceeded");
    consumed.set(member.memberSha256, member);
    // bind the actual target support and explicit missing gauges to consumed roots
    for (const targetMember of target.members) consumed.set(targetMember.memberSha256, targetMember);
    // retain the exact causal persistence population when one exists
    if (persistence !== undefined) {
      for (const targetMember of persistence.members) {
        consumed.set(targetMember.memberSha256, targetMember);
      }
    }
  }
  rows.sort((left, right) => left.validAt.localeCompare(right.validAt) || left.key.localeCompare(right.key));
  populationMembers.sort((left, right) => left.validAt.localeCompare(right.validAt) ||
    left.key.localeCompare(right.key));
  const sourceMemberRootSha256 = adjustmentSha256(canonicalJsonBytes([...consumed.keys()].sort()));
  const sourceReceiptRootSha256 = adjustmentSha256(canonicalJsonBytes(
    [...new Set([...consumed.values()].map((member) => member.receipt.receiptSha256))].sort()));
  return Object.freeze({ populationMembers: Object.freeze(populationMembers), rows: Object.freeze(rows),
    sourceMemberRootSha256, sourceReceiptRootSha256 });
}

// fit an independent earlier-only control reference through the existing isolated numerical runner
export async function buildAdjustmentRainControlReference(input, options) {
  exact(input, ["dueMonth", "epochWitness", "generatedAt", "projection"], "rain reference input");
  exact(options, ["runFit"], "rain reference options");
  const witness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const assembled = buildAdjustmentRainHistoricalRows({ dueMonth: input.dueMonth,
    epochWitness: witness, projection: input.projection });
  instant(input.generatedAt);
  const monthStart = Date.parse(`${input.dueMonth}-01T00:00:00.000Z`);
  // enforce the pre-month publication window before running native fitting
  if (typeof options.runFit !== "function" || Date.parse(input.generatedAt) < monthStart - 7 * DAY ||
    Date.parse(input.generatedAt) >= monthStart) throw new RangeError("rain reference request chronology differs");
  const fit = await options.runFit({ input: { contractVersion: "rain-control-reference-fit-input/v1",
    featureNames: FEATURE_NAMES, month: input.dueMonth, requestedAt: input.generatedAt,
    trainingRows: assembled.rows } });
  exact(fit, ["candidateJson", "candidateSha256", "codeSnapshotSha256", "contractVersion",
    "family", "inputSnapshotSha256", "runtimeReadinessSha256", "stderr", "stdout"], "rain reference fit receipt");
  // accept only the actual isolated fitter receipt and its exact output bytes
  if (fit?.contractVersion !== "adjustment-fit-sandbox/v1" || fit.family !== "rain" ||
    typeof fit.candidateJson !== "string" || fit.candidateSha256 !==
      adjustmentSha256(Buffer.from(fit.candidateJson, "utf8")) ||
    ["codeSnapshotSha256", "inputSnapshotSha256", "runtimeReadinessSha256"].some(
      (field) => !HASH.test(fit[field]))) throw new Error("rain reference isolated fit receipt differs");
  const report = JSON.parse(fit.candidateJson);
  exact(report, ["calibrationEndAt", "calibrationStartAt", "contractVersion", "generatedAt",
    "legacyCalibrationStartAt", "modelMonth", "ordinalArtifact", "parityRows", "reason",
    "scales", "state", "support", "trainingMaximumValidAt"], "rain reference report");
  instant(report.generatedAt);
  // the actual post-fit clock cannot be backdated to the request or across the due month
  if (report.contractVersion !== "rain-control-reference-fit/v1" || report.modelMonth !== input.dueMonth ||
    report.generatedAt < input.generatedAt || Date.parse(report.generatedAt) >= monthStart) {
    throw new Error("rain reference completion chronology differs");
  }
  // supported history is mandatory; no raw-only control artifact is fabricated
  if (report.state === "unsupported") {
    if (!["insufficient_control_support", "insufficient_ordinal_head_support"].includes(report.reason) ||
      report.ordinalArtifact !== null || report.scales !== null || report.support !== null ||
      report.trainingMaximumValidAt !== null || !Array.isArray(report.parityRows) || report.parityRows.length !== 0) {
      throw new Error("rain reference unsupported report differs");
    }
    return null;
  }
  if (report.state !== "supported" || report.reason !== "pre_month_reference") {
    throw new Error("rain reference state differs");
  }
  exact(report.scales, ["legacy", "recent", "recentSupported", "sameWindow"], "rain reference scales");
  exact(report.support, ["calibrationDates", "calibrationHours", "calibrationRows", "calibrationWetDates",
    "calibrationWetHours", "effectiveDates", "effectiveWetDates", "legacyCalibrationRows", "legacyTrainingRows",
    "legacyTrainingWetRows", "trainingDates", "trainingHours", "trainingRows", "trainingWetDates",
    "trainingWetHours"], "rain reference support");
  const { effectiveDates, effectiveWetDates, ...support } = report.support;
  const ordinalArtifactBytes = canonicalJsonBytes(report.ordinalArtifact);
  const state = createRainMaintenanceControlState({ calibrationEndAt: report.calibrationEndAt,
    calibrationStartAt: report.calibrationStartAt, contractVersion: RAIN_MAINTENANCE_CONTROL_STATE_VERSION,
    epochWitnessSha256: adjustmentSha256(canonicalJsonBytes(witness)), generatedAt: report.generatedAt,
    legacyCalibrationStartAt: report.legacyCalibrationStartAt, legacyRawScale: report.scales.legacy,
    modelMonth: input.dueMonth, ordinalArtifactSha256: adjustmentSha256(ordinalArtifactBytes),
    recentFallbackReason: report.scales.recentSupported ? "recent_calibration" : "insufficient_effective_support",
    recentRawScale: report.scales.recent, recentSupported: report.scales.recentSupported,
    recipeSha256: RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256, sameWindowRawScale: report.scales.sameWindow,
    scheduleContractSha256: ADJUSTMENT_ROLLING_SCHEDULE_SHA256, ...assembledRoots(assembled),
    support: { ...support, effectiveDates64: encodeMaintenanceBinary64(effectiveDates),
      effectiveWetDates64: encodeMaintenanceBinary64(effectiveWetDates) },
    trainingMaximumValidAt: report.trainingMaximumValidAt });
  validateRainMaintenanceControlArtifact(state, ordinalArtifactBytes);
  const evaluate = createRainHurdleWindPortableArtifactEvaluator(ordinalArtifactBytes.toString("utf8"),
    state.ordinalArtifactSha256);
  // independently replay only fixed synthetic parity rows without exposing private training outcomes
  if (!Array.isArray(report.parityRows) || report.parityRows.length !== 3) {
    throw new Error("rain reference parity geometry differs");
  }
  for (const [index, row] of report.parityRows.entries()) {
    exact(row, ["features", "prediction", "probabilities", "raw"], "rain reference parity row");
    const raw = [.5, 2, 4][index];
    // parity inputs are immutable synthetic values, not caller-selected favorable rows
    if (row.raw !== raw || !Array.isArray(row.features) || row.features.length !== 107 ||
      row.features.some((value, position) => value !== (position === 5 ? raw : index === 2 ? null : index)) ||
      !Array.isArray(row.probabilities) || row.probabilities.length !== 3) {
      throw new Error("rain reference synthetic parity differs");
    }
    const prediction = evaluate(Float32Array.from(row.features,
      (value) => value === null ? Number.NaN : value));
    const actual = [prediction.correctedPrecipitationMm, prediction.occurrenceProbabilityAtLeast0_1,
      prediction.occurrenceProbabilityAtLeast1_0, prediction.occurrenceProbabilityAtLeast2_5];
    const native = [row.prediction, ...row.probabilities];
    // compare genuine native arithmetic to the independent serving evaluator
    if (native.some((value, position) => !Number.isFinite(value) || Math.abs(value - actual[position]) >= 1e-5)) {
      throw new Error("rain reference native parity differs");
    }
  }
  return Object.freeze({ controlStateBytes: encodeRainMaintenanceControlState(state), ordinalArtifactBytes,
    ...assembledRoots(assembled) });
}

// retain only actual consumed identities in the public control state
function assembledRoots(value) {
  return { sourceMemberRootSha256: value.sourceMemberRootSha256,
    sourceReceiptRootSha256: value.sourceReceiptRootSha256 };
}

// normalize signed zero only in numerical json while preserving original source bits and identities
function numericalBinary64(value) {
  const number = decodeMaintenanceBinary64(value);
  return number === 0 ? 0 : number;
}

// independently rederive the existing native row identity and causal receipt binding
function validateMember(member, epochAt, cutoffAt) {
  const receipt = member.receipt;
  // do not accept a receipt or decoded payload detached from its archived byte identity
  if (!Buffer.isBuffer(member.payloadBytes) || adjustmentSha256(member.payloadBytes) !== member.payloadIdentitySha256 ||
    receipt.projectionIdentitySha256 !== member.payloadIdentitySha256 ||
    receipt.projectionSha256 !== member.payloadIdentitySha256 || receipt.projectionKind !== member.projectionKind ||
    !Number.isSafeInteger(member.rowIndex) || member.rowIndex < 0 || !HASH.test(receipt.receiptSha256) ||
    !/^[1-9]\d*$/u.test(receipt.archiveCommitOrdinal)) throw new Error("rain historical native member differs");
  const identity = { archiveCommitOrdinal: receipt.archiveCommitOrdinal,
    payloadIdentitySha256: member.payloadIdentitySha256, projectionKind: member.projectionKind,
    receiptSha256: receipt.receiptSha256, rowIndex: member.rowIndex };
  // row roots use the frozen native five-field identity rather than caller-selected metadata
  if (member.memberSha256 !== adjustmentSha256(canonicalJsonBytes(identity))) {
    throw new Error("rain historical row identity differs");
  }
  causal(receipt.archiveCommittedAt, epochAt, cutoffAt);
}

// require each consumed causal clock inside the approved future-only historical interval
function causal(value, epochAt, cutoffAt) {
  instant(value);
  if (value < epochAt || value >= cutoffAt) throw new RangeError("rain historical clock differs");
}

// preserve native ordinal ordering without floating-point conversion
function compareOrdinal(left, right) {
  return BigInt(left.archiveCommitOrdinal) < BigInt(right.archiveCommitOrdinal) ? -1
    : BigInt(left.archiveCommitOrdinal) > BigInt(right.archiveCommitOrdinal) ? 1 : 0;
}

// reject normalized instants at every clock boundary
function instant(value) {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError("rain reference instant is invalid");
  }
}

// keep due months canonical before deriving original cutoff clocks
function month(value) {
  if (typeof value !== "string" || !MONTH.test(value)) throw new TypeError("rain reference month is invalid");
}

// keep all caller-facing grammar surfaces closed
function exact(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} is invalid`);
  }
}
