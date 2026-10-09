import { createHash } from "node:crypto";

import {
  validateAdjustmentRevisionColdCheckpoint,
  validateAdjustmentRevisionColdTransferStart,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  parseForecastAdjustmentRainFixedGaugeTarget,
  parseForecastAdjustmentMaintenanceRevisionProjection,
  parseForecastAdjustmentMaintenanceShadowCapsule,
} from "./adjustment_maintenance_runtime_adapter.mjs";
import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";

export const ADJUSTMENT_HISTORICAL_ARCHIVE_INDEX_CONTRACT_VERSION =
  "adjustment-revision-historical-archive-index/v1";

const HASH = /^[a-f0-9]{64}$/u;
const INSTANT = /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const UINT64_MAXIMUM = 0xffff_ffff_ffff_ffffn;
const MAXIMUM_SELECTED_BYTES = 512 * 1_024 * 1_024;
const MAXIMUM_PAGE_RESTORE_BYTES = 8 * 1_024 * 1_024;
const MAXIMUM_TRANSFER_BYTES = 4_832 * 1_024;
const MAXIMUM_PAGES = 16_744;
const FAMILIES = new Set(["rain", "temperature", "wind"]);
const RECEIPT_KEYS = [
  "archiveCommitOrdinal", "archiveCommittedAt", "contractVersion", "frontierSha256",
  "predecessorFrontierSha256", "projectionIdentitySha256", "projectionKind",
  "projectionSha256", "receiptSha256", "stageReceiptSha256",
];
const REVISION_KINDS = new Set([
  "actual_best_match", "native_source", "rain_gate_input", "shadow_prediction",
  "target_revision",
]);
const RANGE_CLOCK_KEYS = new Set([
  "completedAt", "issuedAt", "logicalReceivedAt", "observedAt", "productRunAt",
  "receivedAt", "referenceAt", "runInitializedAt", "validAt",
]);

// restore one verified prefix while retaining only a bounded semantic selection
export async function restoreAdjustmentRevisionHistoricalArchive(input) {
  requireExactKeys(input, ["archive", "mappings", "selection", "start"],
    "historical archive input");
  const currentStart = validateAdjustmentRevisionColdTransferStart(input.start);
  const selection = validateSelection(input.selection);
  requireArchiveReader(input.archive);
  if (!Array.isArray(input.mappings) || input.mappings.length < 1 ||
    input.mappings.length > MAXIMUM_PAGES) {
    throw new TypeError("historical archive mappings are invalid");
  }
  const pages = await restorePageIndex(input.archive, input.mappings);
  validatePageIndex(pages, currentStart);
  return await streamHistoricalPrefix({
    archive: input.archive,
    currentStart,
    pages,
    selection,
  });
}

// restore compact checkpoints and each transfer's exact archived start member
async function restorePageIndex(archive, mappings) {
  const pages = [];
  const pageIdentities = new Set();
  const starts = new Map();

  // restore only compact page metadata during the first pass
  for (const mapping of mappings) {
    validateMapping(mapping);
    if (pageIdentities.has(mapping.pageSha256)) {
      throw new Error("historical archive page repeats");
    }
    pageIdentities.add(mapping.pageSha256);
    const checkpointFiles = await restoreMembers({
      archive,
      graphManifestSha256: mapping.graphManifestSha256,
      maximumBytes: MAXIMUM_TRANSFER_BYTES,
      targets: [{ fileName: "checkpoint.json", identitySha256: mapping.pageSha256 }],
    });
    const checkpoint = parseCanonicalDocument(
      checkpointFiles.files.get("checkpoint.json"),
      "adjustment-revision-cold-page-checkpoint/v1",
      validateAdjustmentRevisionColdCheckpoint,
    );
    if (checkpoint.pageSha256 !== mapping.pageSha256 ||
      checkpoint.startSha256 !== mapping.startSha256) {
      throw new Error("historical archive checkpoint differs");
    }
    let transferStart = starts.get(checkpoint.startSha256);

    // authenticate a new transfer epoch from its archived full start member
    if (checkpoint.startMemberSha256 !== null) {
      if (transferStart !== undefined) {
        throw new Error("historical archive transfer start repeats");
      }
      const startFiles = await restoreMembers({
        archive,
        graphManifestSha256: mapping.graphManifestSha256,
        maximumBytes: MAXIMUM_TRANSFER_BYTES,
        targets: [{ fileName: "start.json", identitySha256: checkpoint.startSha256 }],
      });
      const startBytes = startFiles.files.get("start.json");
      transferStart = parseCanonicalDocument(
        startBytes,
        "adjustment-revision-cold-transfer-start/v1",
        validateAdjustmentRevisionColdTransferStart,
      );
      if (adjustmentSha256(startBytes) !== checkpoint.startMemberSha256 ||
        transferStart.startSha256 !== checkpoint.startSha256) {
        throw new Error("historical archive transfer start differs");
      }
      starts.set(transferStart.startSha256, transferStart);
    }
    pages.push({ checkpoint, mapping, transferStart });
  }
  pages.sort(comparePageCursor);

  // resolve continuation pages after every first-page start has been restored
  for (const page of pages) {
    if (page.transferStart === undefined) {
      const transferStart = starts.get(page.checkpoint.startSha256);
      if (transferStart === undefined) {
        throw new Error("historical archive transfer start is missing");
      }
      page.transferStart = transferStart;
    }
    Object.freeze(page);
  }
  return pages;
}

// validate cursor continuity across independently authenticated transfer epochs
function validatePageIndex(pages, currentStart) {
  let priorOrdinal = "0";
  let priorFrontierSha256 = revisionFrontierGenesis();
  let priorPage = null;
  let priorStartWatermarkOrdinal = 0n;
  let priorStartWatermarkFrontierSha256 = revisionFrontierGenesis();

  // connect every page through the one global database frontier
  for (const page of pages) {
    const { checkpoint, transferStart } = page;
    const startOrdinal = BigInt(transferStart.watermarkArchiveCommitOrdinal);
    if (checkpoint.afterArchiveCommitOrdinal !== priorOrdinal ||
      checkpoint.afterFrontierSha256 !== priorFrontierSha256 ||
      checkpoint.entries.length < 1 ||
      checkpoint.watermarkArchiveCommitOrdinal !==
        transferStart.watermarkArchiveCommitOrdinal ||
      checkpoint.watermarkFrontierSha256 !== transferStart.watermarkFrontierSha256) {
      throw new Error("historical archive page frontier differs");
    }
    if (startOrdinal < priorStartWatermarkOrdinal ||
      (startOrdinal === priorStartWatermarkOrdinal &&
        transferStart.watermarkFrontierSha256 !== priorStartWatermarkFrontierSha256)) {
      throw new Error("historical archive transfer watermark regresses");
    }
    const firstPage = checkpoint.startMemberSha256 !== null;

    // bind a continuation only to the immediately preceding page of the same start
    if (firstPage) {
      if (checkpoint.previousPageSha256 !== checkpoint.startSha256) {
        throw new Error("historical archive first page predecessor differs");
      }
      priorStartWatermarkOrdinal = startOrdinal;
      priorStartWatermarkFrontierSha256 = transferStart.watermarkFrontierSha256;
    } else if (priorPage === null ||
      checkpoint.startSha256 !== priorPage.checkpoint.startSha256 ||
      checkpoint.previousPageSha256 !== priorPage.checkpoint.pageSha256) {
      throw new Error("historical archive continuation differs");
    }
    priorOrdinal = checkpoint.nextArchiveCommitOrdinal;
    priorFrontierSha256 = checkpoint.nextFrontierSha256;
    priorPage = page;
  }
  if (priorOrdinal !== currentStart.watermarkArchiveCommitOrdinal ||
    priorFrontierSha256 !== currentStart.watermarkFrontierSha256) {
    throw new Error("historical archive receipt suffix is incomplete");
  }
}

// verify every receipt incrementally and retain only selected value bytes
async function streamHistoricalPrefix(input) {
  const currentReceipts = new Map(input.currentStart.servingSnapshot.entries.map(
    // retain only the bounded current snapshot needed for exact catalog binding
    (entry) => [entry.receipt.receiptSha256, entry.receipt],
  ));
  const missingCurrentReceipts = new Set(currentReceipts.keys());
  const requestedReceipts = new Set(input.selection.receiptSha256s);
  const receiptRoot = createHash("sha256");
  receiptRoot.update("[");
  const occurrences = [];
  const pageSummary = [];
  let predecessorFrontierSha256 = revisionFrontierGenesis();
  let priorOrdinal = 0n;
  let receiptCount = 0;
  let selectedBytes = 0;

  // stream one bounded page at a time without retaining the historical population
  for (const page of input.pages) {
    const targets = [];
    for (const [entryIndex, entry] of page.checkpoint.entries.entries()) {
      const bindings = receiptBindings(entry);
      for (const [receiptIndex, binding] of bindings.entries()) {
        targets.push({
          fileName: `receipt-${entryIndex}-${receiptIndex}.json`,
          identitySha256: binding.receiptSha256,
        });
      }
      if (input.selection.family !== null || bindings.some(
        // retain a current pointer even when no historical family range is requested
        (binding) => requestedReceipts.has(binding.receiptSha256),
      )) {
        targets.push({
          fileName: `payload-${entryIndex}.json`,
          identitySha256: entry.payloadIdentitySha256,
        });
      }
    }
    const memberFiles = await restoreMembers({
      archive: input.archive,
      graphManifestSha256: page.mapping.graphManifestSha256,
      maximumBytes: MAXIMUM_PAGE_RESTORE_BYTES,
      targets,
    });
    let pageReceiptCount = 0;

    // validate receipt and payload bindings in exact checkpoint order
    for (const [entryIndex, entry] of page.checkpoint.entries.entries()) {
      const entryReceipts = [];
      for (const [receiptIndex, binding] of receiptBindings(entry).entries()) {
        const receiptBytes = memberFiles.files.get(`receipt-${entryIndex}-${receiptIndex}.json`);
        const receipt = parseRevisionReceipt(receiptBytes);
        const ordinal = BigInt(receipt.archiveCommitOrdinal);
        const expectedReceiptSha256 = adjustmentSha256(Buffer.from([
          receipt.contractVersion,
          receipt.archiveCommitOrdinal,
          receipt.archiveCommittedAt,
          receipt.projectionKind,
          receipt.projectionIdentitySha256,
          receipt.projectionSha256,
          receipt.stageReceiptSha256,
          predecessorFrontierSha256,
        ].join("\n")));
        const expectedFrontierSha256 = adjustmentSha256(Buffer.from([
          "adjustment-revision-frontier/v1",
          predecessorFrontierSha256,
          receipt.archiveCommitOrdinal,
          expectedReceiptSha256,
        ].join("\n")));

        // reject reordered, substituted, duplicated or caller-hashed receipts
        if (ordinal <= priorOrdinal ||
          receipt.predecessorFrontierSha256 !== predecessorFrontierSha256 ||
          receipt.receiptSha256 !== expectedReceiptSha256 ||
          receipt.frontierSha256 !== expectedFrontierSha256 ||
          receipt.receiptSha256 !== binding.receiptSha256 ||
          adjustmentSha256(receiptBytes) !== binding.receiptMemberSha256) {
          throw new Error("historical archive receipt mapping differs");
        }
        const currentReceipt = currentReceipts.get(receipt.receiptSha256);

        // bind every final serving pointer to the exact archived receipt bytes
        if (currentReceipt !== undefined) {
          if (!canonicalJsonBytes(currentReceipt).equals(receiptBytes)) {
            throw new Error("historical archive current receipt differs");
          }
          missingCurrentReceipts.delete(receipt.receiptSha256);
        }
        if (receiptCount > 0) {
          receiptRoot.update(",");
        }
        receiptRoot.update(JSON.stringify(receipt.receiptSha256));
        predecessorFrontierSha256 = receipt.frontierSha256;
        priorOrdinal = ordinal;
        receiptCount += 1;
        pageReceiptCount += 1;
        entryReceipts.push(receipt);
      }
      const payloadBytes = memberFiles.files.get(`payload-${entryIndex}.json`);
      const retain = payloadBytes !== undefined && shouldRetainPayload({
        entry,
        payloadBytes,
        receipts: entryReceipts,
        requestedReceipts,
        selection: input.selection,
      });

      // retain only the selected fitter/current-pointer working set
      if (retain) {
        selectedBytes += payloadBytes.length;
        if (selectedBytes > MAXIMUM_SELECTED_BYTES) {
          throw new RangeError("historical archive selection exceeds byte ceiling");
        }
        occurrences.push(Object.freeze({
          graphManifestSha256: page.mapping.graphManifestSha256,
          pageSha256: page.checkpoint.pageSha256,
          payloadBytes,
          payloadIdentitySha256: entry.payloadIdentitySha256,
          payloadKind: entry.payloadKind,
          publicationDisposition: entry.publicationDisposition,
          receipts: Object.freeze(entryReceipts),
        }));
      }
    }
    if (page.checkpoint.nextArchiveCommitOrdinal !== priorOrdinal.toString() ||
      page.checkpoint.nextFrontierSha256 !== predecessorFrontierSha256) {
      throw new Error("historical archive page receipt range differs");
    }
    pageSummary.push(Object.freeze({
      afterArchiveCommitOrdinal: page.checkpoint.afterArchiveCommitOrdinal,
      graphManifestSha256: page.mapping.graphManifestSha256,
      nextArchiveCommitOrdinal: page.checkpoint.nextArchiveCommitOrdinal,
      pageSha256: page.checkpoint.pageSha256,
      receiptCount: pageReceiptCount,
      startSha256: page.checkpoint.startSha256,
    }));
  }
  receiptRoot.update("]\n");
  if (receiptCount < 1 || missingCurrentReceipts.size !== 0 ||
    priorOrdinal.toString() !== input.currentStart.watermarkArchiveCommitOrdinal ||
    predecessorFrontierSha256 !== input.currentStart.watermarkFrontierSha256) {
    throw new Error("historical archive catalog differs from serving snapshot");
  }
  const catalog = buildColdCatalog({
    currentStart: input.currentStart,
    frontierCount: receiptCount,
    frontierRootSha256: predecessorFrontierSha256,
    receiptRootSha256: receiptRoot.digest("hex"),
  });
  const metadata = occurrences.map(
    // hash selected immutable identities without duplicating private value bytes
    (entry) => ({
      graphManifestSha256: entry.graphManifestSha256,
      pageSha256: entry.pageSha256,
      payloadIdentitySha256: entry.payloadIdentitySha256,
      payloadKind: entry.payloadKind,
      publicationDisposition: entry.publicationDisposition,
      receiptSha256s: entry.receipts.map((receipt) => receipt.receiptSha256),
    }),
  );
  return Object.freeze({
    catalog,
    contractVersion: ADJUSTMENT_HISTORICAL_ARCHIVE_INDEX_CONTRACT_VERSION,
    historyRootSha256: adjustmentSha256(canonicalJsonBytes({
      catalogRootSha256: catalog.catalogRootSha256,
      entries: metadata,
    })),
    occurrences: Object.freeze(occurrences),
    pages: Object.freeze(pageSummary),
    receiptCount,
  });
}

// build the exact cold catalog projection from the streamed frontier
function buildColdCatalog(input) {
  const snapshot = input.currentStart.servingSnapshot;
  const kindCounts = Object.fromEntries([
    "actual_best_match", "native_source", "rain_gate_input", "target_revision",
  ].map((kind) => [kind, snapshot.entries.filter(
    // count only genuine current semantic producer pointers
    (entry) => entry.receipt.projectionKind === kind,
  ).length]));
  if (Object.values(kindCounts).some((count) => count < 1)) {
    throw new Error("adjustment revision cold catalog producer population is incomplete");
  }
  const value = {
    archiveCommitOrdinal: input.currentStart.watermarkArchiveCommitOrdinal,
    contractVersion: "adjustment-revision-cold-catalog/v1",
    frontierCount: input.frontierCount,
    frontierRootSha256: input.frontierRootSha256,
    kindCounts,
    receiptRootSha256: input.receiptRootSha256,
    servingSnapshotSha256: snapshot.snapshotSha256,
  };
  return Object.freeze({
    ...value,
    catalogRootSha256: adjustmentSha256(canonicalJsonBytes(value)),
  });
}

// decide whether one verified body belongs to the bounded fitter selection
function shouldRetainPayload(input) {
  if (adjustmentSha256(input.payloadBytes) !== input.entry.payloadIdentitySha256) {
    throw new Error("historical archive payload identity differs");
  }
  const requested = input.receipts.some((receipt) =>
    input.requestedReceipts.has(receipt.receiptSha256));

  // discard unrequested gaps and unselected history before semantic decoding
  if (!requested && (input.selection.family === null ||
    input.entry.publicationDisposition !== "published")) {
    return false;
  }
  if (requested) {
    return true;
  }
  let document;

  // decode each selected contract through the installed production parser
  if (input.entry.payloadKind === "adjustment-shadow-revision-capsule/v1" ||
    input.entry.payloadKind === "adjustment-shadow-revision-capsule/v2") {
    document = parseForecastAdjustmentMaintenanceShadowCapsule({
      capsuleBytes: input.payloadBytes,
    }).source;
    if (document.family !== input.selection.family) {
      return false;
    }
  } else if (input.entry.payloadKind ===
      "adjustment-rain-fixed-gauge-target-projection/v1") {
    const parsed = parseForecastAdjustmentRainFixedGaugeTarget({
      projectionBytes: input.payloadBytes,
    });
    if (input.selection.family !== "rain") {
      return false;
    }
    document = parsed.projection;
  } else {
    document = parseForecastAdjustmentMaintenanceRevisionProjection({
      projectionBytes: input.payloadBytes,
    });
    if (!projectionIsRelevant(document, input.selection.family)) {
      return false;
    }
  }
  return hasClockInRange(document, input.selection.fromAt, input.selection.toAt);
}

// define the genuine revision classes consumed by each family fitter
function projectionIsRelevant(document, family) {
  if (document.projectionKind === "target_revision" ||
    document.projectionKind === "actual_best_match") {
    return true;
  }
  if (family === "temperature") {
    return document.projectionKind === "native_source" && document.family === "temperature";
  }
  if (family === "wind") {
    return document.projectionKind === "native_source";
  }
  return document.projectionKind === "native_source" ||
    document.projectionKind === "rain_gate_input";
}

// find a genuine causal or target clock inside the requested half-open interval
function hasClockInRange(value, fromAt, toAt, key = null) {
  if (typeof value === "string") {
    return RANGE_CLOCK_KEYS.has(key) && INSTANT.test(value) &&
      Date.parse(value) >= Date.parse(fromAt) && Date.parse(value) < Date.parse(toAt);
  }
  if (Array.isArray(value)) {
    return value.some(
      // stop once any exact row clock intersects the selected interval
      (entry) => hasClockInRange(entry, fromAt, toAt),
    );
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    // traverse only parser-validated closed evidence documents
    ([name, entry]) => hasClockInRange(entry, fromAt, toAt, name),
  );
}

// map one checkpoint entry into its ordered receipt identities
function receiptBindings(entry) {
  if (Object.hasOwn(entry, "receiptSha256")) {
    return [{
      receiptMemberSha256: entry.receiptMemberSha256,
      receiptSha256: entry.receiptSha256,
    }];
  }
  return entry.receiptSha256s.map(
    // keep grouped member hashes aligned with server ordinal order
    (receiptSha256, index) => ({
      receiptMemberSha256: entry.receiptMemberSha256s[index],
      receiptSha256,
    }),
  );
}

// restore one requested member set through the archive's verified graph reader
async function restoreMembers(input) {
  const files = new Map();
  let byteLength = 0;
  const sink = {
    // accept one verified stream under its requested safe filename
    writeExclusive: async (fileName, readable, expectedLength) => {
      const chunks = [];
      let length = 0;
      for await (const chunk of readable) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > input.maximumBytes || byteLength + length > input.maximumBytes) {
          throw new RangeError("historical archive member exceeds byte ceiling");
        }
        chunks.push(bytes);
      }
      if (length !== expectedLength || files.has(fileName)) {
        throw new Error("historical archive member length differs");
      }
      files.set(fileName, Buffer.concat(chunks, length));
      byteLength += length;
    },
  };
  await input.archive.restoreFullGraph(input.graphManifestSha256, {
    maximumBytes: input.maximumBytes,
    sink,
    targets: input.targets,
  });
  return { byteLength, files };
}

// parse one exact canonical revision receipt
function parseRevisionReceipt(bytes) {
  const receipt = parseCanonicalDocument(
    bytes,
    "adjustment-revision-commit-receipt/v1",
  );
  requireExactKeys(receipt, RECEIPT_KEYS, "historical archive receipt");
  requireUint64(receipt.archiveCommitOrdinal, "archiveCommitOrdinal");
  requireInstant(receipt.archiveCommittedAt, "archiveCommittedAt");
  if (receipt.archiveCommitOrdinal === "0" || !REVISION_KINDS.has(receipt.projectionKind)) {
    throw new TypeError("historical archive receipt is invalid");
  }
  for (const field of [
    "frontierSha256", "predecessorFrontierSha256", "projectionIdentitySha256",
    "projectionSha256", "receiptSha256", "stageReceiptSha256",
  ]) {
    requireSha256(receipt[field], field);
  }
  if (receipt.projectionKind !== "shadow_prediction" &&
    receipt.projectionSha256 !== receipt.projectionIdentitySha256) {
    throw new TypeError("historical archive receipt projection differs");
  }
  return receipt;
}

// parse one exact canonical archived document
function parseCanonicalDocument(bytes, contractVersion, validator = (value) => value) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2) {
    throw new TypeError("historical archive document is invalid");
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("historical archive document JSON is invalid");
  }
  if (value?.contractVersion !== contractVersion || !canonicalJsonBytes(value).equals(bytes)) {
    throw new TypeError("historical archive document is not canonical");
  }
  return validator(value);
}

// validate one immutable journal page mapping
function validateMapping(mapping) {
  requireExactKeys(mapping, ["graphManifestSha256", "pageSha256", "startSha256"],
    "historical archive mapping");
  for (const field of ["graphManifestSha256", "pageSha256", "startSha256"]) {
    requireSha256(mapping[field], field);
  }
}

// validate one bounded historical selection
function validateSelection(value) {
  requireExactKeys(value, ["family", "fromAt", "receiptSha256s", "toAt"],
    "historical archive selection");
  if (!Array.isArray(value.receiptSha256s) || value.receiptSha256s.length > 4_096 ||
    value.receiptSha256s.some((identity) => typeof identity !== "string" || !HASH.test(identity)) ||
    new Set(value.receiptSha256s).size !== value.receiptSha256s.length) {
    throw new TypeError("historical archive receipt selection is invalid");
  }
  if (value.family === null) {
    if (value.fromAt !== null || value.toAt !== null) {
      throw new TypeError("historical archive family selection is invalid");
    }
  } else if (!FAMILIES.has(value.family) || requireInstant(value.fromAt, "fromAt") >=
    requireInstant(value.toAt, "toAt")) {
    throw new TypeError("historical archive family selection is invalid");
  }
  return Object.freeze({
    family: value.family,
    fromAt: value.fromAt,
    receiptSha256s: Object.freeze([...value.receiptSha256s]),
    toAt: value.toAt,
  });
}

// require the archive reader operation used by this resolver
function requireArchiveReader(value) {
  if (value === null || typeof value !== "object" ||
    typeof value.restoreFullGraph !== "function") {
    throw new TypeError("historical archive reader is invalid");
  }
}

// sort page cursors without number coercion
function comparePageCursor(left, right) {
  const leftOrdinal = BigInt(left.checkpoint.afterArchiveCommitOrdinal);
  const rightOrdinal = BigInt(right.checkpoint.afterArchiveCommitOrdinal);
  return leftOrdinal < rightOrdinal ? -1 : leftOrdinal > rightOrdinal ? 1 : 0;
}

// derive the fixed global frontier genesis
function revisionFrontierGenesis() {
  return adjustmentSha256(Buffer.from("adjustment-revision-frontier/v1\n0\n"));
}

// require one canonical uint64 decimal string
function requireUint64(value, name) {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value) ||
    BigInt(value) > UINT64_MAXIMUM) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

// require one exact millisecond utc instant
function requireInstant(value, name) {
  if (typeof value !== "string" || !INSTANT.test(value) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return Date.parse(value);
}

// require one exact object key set
function requireExactKeys(value, keys, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} is invalid`);
  }
}

// require one lowercase sha-256 identity
function requireSha256(value, name) {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
}
