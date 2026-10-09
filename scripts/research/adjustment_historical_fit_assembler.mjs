import {
  parseForecastAdjustmentMaintenanceRevisionProjection,
  parseForecastAdjustmentMaintenanceShadowCapsule,
  parseForecastAdjustmentRainFixedGaugeTarget,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";
import {
  validateAdjustmentFutureOnlyEpochWitness,
} from "./adjustment_maintenance_state.mjs";

export const ADJUSTMENT_HISTORICAL_FIT_PROJECTION_CONTRACT_VERSION =
  "adjustment-revision-fit-projection/v2";

const FAMILIES = new Set(["temperature", "wind", "rain"]);
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MONTH = /^20\d{2}-(?:0[1-9]|1[0-2])$/u;
const DAY = 86_400_000;
const MAXIMUM_PROJECTED_ROWS = 1_000_000;
const WALL_FORMATTER = new Intl.DateTimeFormat("en-US", {
  day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit",
  month: "2-digit", second: "2-digit", timeZone: "America/Los_Angeles",
  year: "numeric",
});

// project verified historical graph members into one family fit population
export function buildAdjustmentHistoricalFitProjection(input) {
  requireExactKeys(input, ["epochWitness", "family", "fitMonth", "history"],
    "historical fit projection input");
  const epochWitness = validateAdjustmentFutureOnlyEpochWitness(input.epochWitness);
  const family = requireFamily(input.family);
  requireMonth(input.fitMonth);
  validateHistory(input.history);
  const cutoffAt = originalTrainingCutoff(family, input.fitMonth);
  const projectionMembers = [];
  const shadowMembers = [];
  let rowCount = 0;

  // inspect only published value-bearing occurrences from the verified prefix
  for (const occurrence of input.history.occurrences) {
    if (occurrence.publicationDisposition !== "published") {
      continue;
    }
    if (occurrence.payloadKind === "adjustment-shadow-revision-capsule/v1" ||
      occurrence.payloadKind === "adjustment-shadow-revision-capsule/v2") {
      const capsule = parseForecastAdjustmentMaintenanceShadowCapsule({
        capsuleBytes: occurrence.payloadBytes,
      });

      // keep only same-family post-epoch capsules earlier than the original cutoff
      if (capsule.source.family === family &&
        requirePostEpochInstant(capsule.source.issuedAt, epochWitness.epochAt) < cutoffAt) {
        validateShadowOccurrence(occurrence, capsule);
        shadowMembers.push(Object.freeze({
          capsule,
          graphManifestSha256: occurrence.graphManifestSha256,
          payloadBytes: Buffer.from(occurrence.payloadBytes),
          payloadIdentitySha256: occurrence.payloadIdentitySha256,
          receipt: occurrence.receipts[0],
        }));
        rowCount += capsule.source.rowCount;
      }
      continue;
    }
    const document = occurrence.payloadKind ===
      "adjustment-rain-fixed-gauge-target-projection/v1"
      ? parseForecastAdjustmentRainFixedGaugeTarget({
          projectionBytes: occurrence.payloadBytes,
        }).projection
      : parseForecastAdjustmentMaintenanceRevisionProjection({
          projectionBytes: occurrence.payloadBytes,
        });
    validateRevisionOccurrence(occurrence, document);
    const selected = selectProjectionRows({
      cutoffAt,
      document,
      epochAt: epochWitness.epochAt,
      family,
      occurrence,
      payloadBytes: Buffer.from(occurrence.payloadBytes),
    });

    // omit unrelated projection classes without relabelling them
    if (selected.length === 0) {
      continue;
    }
    projectionMembers.push(...selected);
    rowCount += selected.length;

    // bound decoded row material before canonical root construction
    if (rowCount > MAXIMUM_PROJECTED_ROWS) {
      throw new RangeError("historical fit projection row ceiling exceeded");
    }
  }
  projectionMembers.sort(compareProjectedMember);
  shadowMembers.sort((left, right) =>
    left.capsule.source.issuedAt.localeCompare(right.capsule.source.issuedAt));
  const identities = [
    ...projectionMembers.map((member) => member.memberSha256),
    ...shadowMembers.map((member) => member.payloadIdentitySha256),
  ].sort();
  const classCounts = projectionMembers.reduce(
    // count genuine projection kinds without inventing unused family classes
    (counts, member) => ({
      ...counts,
      [member.projectionKind]: counts[member.projectionKind] + 1,
    }),
    {
      actual_best_match: 0,
      native_source: 0,
      rain_gate_input: 0,
      target_revision: 0,
    },
  );
  const value = {
    classCounts,
    contractVersion: ADJUSTMENT_HISTORICAL_FIT_PROJECTION_CONTRACT_VERSION,
    cutoffAt: new Date(cutoffAt).toISOString(),
    dueMonth: input.fitMonth,
    epochWitnessSha256: epochWitness.witnessSha256,
    family,
    historyRootSha256: input.history.historyRootSha256,
    memberRootSha256: adjustmentSha256(canonicalJsonBytes(identities)),
    projectionMembers: Object.freeze(projectionMembers),
    rowCount,
    shadowMembers: Object.freeze(shadowMembers),
  };
  return Object.freeze(value);
}

// select one projection document's family-relevant post-epoch rows
function selectProjectionRows(input) {
  const relevant = projectionIsRelevant(input.document, input.family);

  // ignore only classes not consumed by this family's fitter
  if (!relevant) {
    return [];
  }
  const rows = [];
  const fixedGauge = input.document.contractVersion ===
    "adjustment-rain-fixed-gauge-target-projection/v1";

  // admit the twelve-source target atomically at its actual last native receipt
  if (fixedGauge && input.occurrence.receipts.some((receipt) =>
    requirePostEpochInstant(receipt.archiveCommittedAt, input.epochAt) >= input.cutoffAt)) {
    return [];
  }

  // bind grouped rows to their exact database ordinal receipts
  for (const [index, row] of input.document.rows.entries()) {
    const receipt = input.occurrence.receipts.length === 1
      ? input.occurrence.receipts[0]
      : input.occurrence.receipts[index];
    const rowClocks = revisionRowClocks(input.document, row);

    // require every causal source, target and receipt clock after the frozen epoch
    if (rowClocks.some((clock) => requirePostEpochInstant(clock, input.epochAt) >= input.cutoffAt) ||
      requirePostEpochInstant(receipt.archiveCommittedAt, input.epochAt) >= input.cutoffAt) {
      continue;
    }
    const memberIdentity = {
      archiveCommitOrdinal: receipt.archiveCommitOrdinal,
      payloadIdentitySha256: input.occurrence.payloadIdentitySha256,
      projectionKind: input.document.projectionKind,
      receiptSha256: receipt.receiptSha256,
      rowIndex: index,
    };
    rows.push(Object.freeze({
      document: input.document,
      graphManifestSha256: input.occurrence.graphManifestSha256,
      memberSha256: adjustmentSha256(canonicalJsonBytes(memberIdentity)),
      payloadBytes: input.payloadBytes,
      payloadIdentitySha256: input.occurrence.payloadIdentitySha256,
      projectionKind: input.document.projectionKind,
      receipt,
      row,
      rowIndex: index,
    }));
  }
  return rows;
}

// define only actual input classes consumed by each family fitter
function projectionIsRelevant(document, family) {
  // every family consumes physical targets
  if (document.projectionKind === "target_revision") {
    return family === "rain"
      ? document.contractVersion === "adjustment-rain-fixed-gauge-target-projection/v1"
      : document.contractVersion !== "adjustment-rain-fixed-gauge-target-projection/v1";
  }
  if (family === "temperature") {
    return document.projectionKind === "native_source" && document.family === "temperature" ||
      document.projectionKind === "actual_best_match";
  }
  if (family === "wind") {
    return document.projectionKind === "native_source" ||
      document.projectionKind === "actual_best_match";
  }
  return document.projectionKind === "native_source" ||
    document.projectionKind === "rain_gate_input" ||
    document.projectionKind === "actual_best_match";
}

// enumerate source clocks that independently enforce future-only lineage
function revisionRowClocks(document, row) {
  // retain every consumed raw gauge claim and minute clock in the future-only check
  if (document.contractVersion === "adjustment-rain-fixed-gauge-target-projection/v1") {
    return [document.logicalReceivedAt, document.validAt,
      row.normalizedRecord.validAt, row.normalizedRecord.receivedAt,
      ...document.captureBodies.flatMap((body) => body.claims.flatMap(
        // reject pre-epoch collection windows rather than repairing target history
        (claim) => [claim.completedAt, claim.windowStart, claim.windowEndExclusive],
      )), ...row.intervals.flatMap(
        // include each actual interval and collection availability
        (interval) => [interval.validAt, interval.completedAt],
      )];
  }
  const clocks = [document.logicalReceivedAt, row.validAt];
  // include the exact native comparator initialization in future-only lineage
  if (row.bestMatchProductRunAt !== null && row.bestMatchProductRunAt !== undefined) {
    clocks.push(row.bestMatchProductRunAt);
  }

  // include each kind-specific source clock without inferring absent fields
  for (const name of ["productRunAt", "runInitializedAt"]) {
    if (document.logicalKey[name] !== null && document.logicalKey[name] !== undefined) {
      clocks.push(document.logicalKey[name]);
    }
  }
  return clocks;
}

// bind one archived payload to its exact receipt population
function validateRevisionOccurrence(occurrence, document) {
  if (occurrence.payloadKind !== document.contractVersion ||
    adjustmentSha256(occurrence.payloadBytes) !== occurrence.payloadIdentitySha256 ||
    occurrence.receipts.length !== (["adjustment-revision-batch-projection/v2",
      "adjustment-rain-fixed-gauge-target-projection/v1"].includes(document.contractVersion)
      ? document.rows.length : 1) ||
    occurrence.receipts.some((receipt) =>
      receipt.projectionKind !== document.projectionKind ||
      receipt.projectionIdentitySha256 !== occurrence.payloadIdentitySha256 ||
      receipt.projectionSha256 !== occurrence.payloadIdentitySha256)) {
    throw new Error("historical fit revision occurrence differs");
  }
}

// bind one archived shadow capsule to its admitted server receipt
function validateShadowOccurrence(occurrence, capsule) {
  const receipt = occurrence.receipts[0];

  // require the single capsule receipt to equal database authority exactly
  if (occurrence.receipts.length !== 1 || receipt.projectionKind !== "shadow_prediction" ||
    canonicalJsonBytes(receipt).equals(canonicalJsonBytes(capsule.revisionReceipt)) === false) {
    throw new Error("historical fit shadow occurrence differs");
  }
}

// derive the immutable monthly fitter cutoff without catch-up sliding
function originalTrainingCutoff(family, fitMonth) {
  const monthStart = family === "rain"
    ? Date.parse(`${fitMonth}-01T00:00:00.000Z`)
    : localMidnight(`${fitMonth}-01`);

  // rain and current temperature/wind fitters all freeze seven days earlier
  if (!Number.isFinite(monthStart)) {
    throw new TypeError("historical fit month is invalid");
  }
  return monthStart - 7 * DAY;
}

// resolve los angeles midnight without assuming a fixed utc offset
function localMidnight(localDate) {
  let guess = Date.parse(`${localDate}T08:00:00.000Z`);
  const target = Date.parse(`${localDate}T00:00:00.000Z`);

  // converge the formatted wall clock across daylight-saving boundaries
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = Object.fromEntries(WALL_FORMATTER.formatToParts(new Date(guess)).map(
      // retain only named date and wall-clock fields
      (part) => [part.type, part.value],
    ));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1,
      Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += target - observed;
  }
  return guess;
}

// validate the verified archive index boundary
function validateHistory(history) {
  requireExactKeys(history, [
    "catalog", "contractVersion", "historyRootSha256", "occurrences", "pages",
    "receiptCount",
  ], "historical fit archive index");
  if (history.contractVersion !== "adjustment-revision-historical-archive-index/v1" ||
    !Array.isArray(history.occurrences) || !Array.isArray(history.pages) ||
    typeof history.historyRootSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(history.historyRootSha256)) {
    throw new TypeError("historical fit archive index is invalid");
  }
}

// require and compare one future-only causal clock
function requirePostEpochInstant(value, epochAt) {
  if (typeof value !== "string" || !INSTANT.test(value) ||
    new Date(value).toISOString() !== value || Date.parse(value) < Date.parse(epochAt)) {
    throw new RangeError("historical fit clock predates its epoch");
  }
  return Date.parse(value);
}

// order family members by valid clock, ordinal, and row position
function compareProjectedMember(left, right) {
  return String(left.row.validAt ?? left.row.normalizedRecord?.validAt)
    .localeCompare(String(right.row.validAt ?? right.row.normalizedRecord?.validAt)) ||
    compareOrdinal(left.receipt.archiveCommitOrdinal, right.receipt.archiveCommitOrdinal) ||
    left.rowIndex - right.rowIndex;
}

// compare uint64 decimal text without number coercion
function compareOrdinal(left, right) {
  const leftOrdinal = BigInt(left);
  const rightOrdinal = BigInt(right);
  return leftOrdinal < rightOrdinal ? -1 : leftOrdinal > rightOrdinal ? 1 : 0;
}

// require one supported family
function requireFamily(value) {
  if (!FAMILIES.has(value)) {
    throw new TypeError("historical fit family is invalid");
  }
  return value;
}

// require one canonical fit month
function requireMonth(value) {
  if (typeof value !== "string" || !MONTH.test(value)) {
    throw new TypeError("historical fit month is invalid");
  }
}

// require one exact object key set
function requireExactKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} is invalid`);
  }
}
