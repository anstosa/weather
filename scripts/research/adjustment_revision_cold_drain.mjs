import {
  validateAdjustmentRevisionColdCustodyAcknowledgementV2,
  validateAdjustmentRevisionColdPage,
  validateAdjustmentRevisionColdTransferStart,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import { canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";

export const ADJUSTMENT_REVISION_COLD_CYCLE_MAXIMUM_BYTES = 4_832 * 1_024;
const CUSTODY_ACK_MAXIMUM_BYTES = 16 * 1_024;

// transfer one bounded page and advance custody only after durable graph verification
export async function drainAdjustmentRevisionColdPage(input) {
  requireExactKeys(input, [
    "acknowledge", "archivePage", "clock", "cutoffAt", "fetchPage", "fetchStart", "journal",
    "sealPack",
  ], "revision cold drain input");
  requireInstant(input.cutoffAt);

  // require explicit authenticated transport and durable journal boundaries
  if ([input.acknowledge, input.archivePage, input.clock, input.fetchPage, input.fetchStart,
    input.sealPack]
    .some((value) => typeof value !== "function") ||
    ["readRevisionCursor", "advanceRevisionCursor", "readPendingRevisionCustody",
      "recordRevisionCustodyIntent", "completeRevisionCustodyV2"]
      .some((name) => typeof input.journal?.[name] !== "function")) {
    throw new TypeError("revision cold drain ports are invalid");
  }
  const cursor = validateCursor(await input.journal.readRevisionCursor());
  const pending = await input.journal.readPendingRevisionCustody();

  // reconcile the exact archived request instead of stranding slots after a failed acknowledgement
  if (pending !== null) {
    const custody = await finishCustody(input, pending);
    await input.sealPack({ force: false });
    return {
      cursor: custody.cursor,
      eof: false,
      pages: [],
      publishedEntries: [],
      start: null,
      state: "custody_reconciled",
      transferBytes: custody.transferBytes,
    };
  }
  const start = validateAdjustmentRevisionColdTransferStart(
    await input.fetchStart(input.cutoffAt),
  );

  // preserve the original due cutoff instead of silently scoring a newer snapshot
  if (start.servingSnapshot.cutoffAt !== input.cutoffAt) {
    throw new Error("revision cold drain cutoff differs");
  }
  const startBytes = canonicalJsonBytes(start).length;

  // historical due work must use retained graphs and cannot rewind global custody
  if (BigInt(start.watermarkArchiveCommitOrdinal) < BigInt(cursor.archiveCommitOrdinal)) {
    return {
      cursor,
      eof: false,
      pages: [],
      publishedEntries: [],
      start,
      state: "archived_cursor_ahead",
      transferBytes: startBytes,
    };
  }
  const request = {
    afterArchiveCommitOrdinal: cursor.archiveCommitOrdinal,
    afterFrontierSha256: cursor.frontierSha256,
    previousPageSha256: start.startSha256,
    startSha256: start.startSha256,
    watermarkArchiveCommitOrdinal: start.watermarkArchiveCommitOrdinal,
    watermarkFrontierSha256: start.watermarkFrontierSha256,
  };
  const page = validateAdjustmentRevisionColdPage(await input.fetchPage(request));

  // bind the reply to every requested cursor coordinate before writing anything
  for (const [name, value] of Object.entries(request)) {
    if (page[name] !== value) {
      throw new Error("revision cold drain page response differs");
    }
  }
  let transferBytes = startBytes + canonicalJsonBytes(page).length;

  // charge both snapshot and payload wire bytes against the combined cycle ceiling
  if (transferBytes + (page.entries.length === 0 ? 0 : CUSTODY_ACK_MAXIMUM_BYTES) >
    ADJUSTMENT_REVISION_COLD_CYCLE_MAXIMUM_BYTES) {
    throw new RangeError("revision cold drain cycle exceeds byte ceiling");
  }
  // unchanged authenticated frontiers do not create per-poll archive objects
  if (page.entries.length === 0) {
    return {
      cursor,
      eof: page.eof,
      pages: [],
      publishedEntries: [],
      start,
      state: "captured_through_watermark",
      transferBytes,
    };
  }
  const publication = await input.archivePage({ page, start });
  requireSha256(publication?.custodyCheckpointSha256);
  requireSha256(publication?.memberRootSha256);
  requireSha256(publication?.startMemberSha256);
  let nextCursor = cursor;

  // only genuine successor bytes can authorize custody advancement
  if (page.entries.length !== 0) {
    const custodyRequest = {
      ...request,
      custodyCheckpointSha256: publication.custodyCheckpointSha256,
      memberRootSha256: publication.memberRootSha256,
      pageSha256: page.pageSha256,
      startMemberSha256: publication.startMemberSha256,
    };
    const intent = await input.journal.recordRevisionCustodyIntent({
      nextArchiveCommitOrdinal: page.nextArchiveCommitOrdinal,
      nextFrontierSha256: page.nextFrontierSha256,
      now: clockAt(input),
      request: custodyRequest,
    });
    const custody = await finishCustody(input, intent);
    nextCursor = custody.cursor;
    transferBytes += custody.transferBytes;
    await input.sealPack({ force: false });
    // include the bounded acknowledgement document in total cycle wire accounting
    if (transferBytes > ADJUSTMENT_REVISION_COLD_CYCLE_MAXIMUM_BYTES) {
      throw new RangeError("revision cold drain cycle exceeds byte ceiling");
    }
  }
  return {
    cursor: nextCursor,
    eof: page.eof,
    pages: [{ custodyCheckpointSha256: publication.custodyCheckpointSha256, page }],
    publishedEntries: page.entries.filter(
      // terminal publish failures remain captured custody but never semantic evidence
      (entry) => entry.publication.disposition === "published",
    ),
    start,
    state: page.eof ? "captured_through_watermark" : "page_captured",
    transferBytes,
  };
}

// resume only a durable page intent and expose no qualification or promotion authority
async function finishCustody(input, intent) {
  requireExactKeys(intent, ["nextArchiveCommitOrdinal", "nextFrontierSha256", "request"],
    "revision cold custody intent");
  const request = intent.request;
  let cursor = validateCursor(await input.journal.readRevisionCursor());
  // repair a crash after intent persistence but before cursor commit
  if (cursor.archiveCommitOrdinal === request.afterArchiveCommitOrdinal &&
    cursor.frontierSha256 === request.afterFrontierSha256) {
    cursor = validateCursor(await input.journal.advanceRevisionCursor({
      afterArchiveCommitOrdinal: request.afterArchiveCommitOrdinal,
      afterFrontierSha256: request.afterFrontierSha256,
      custodyCheckpointSha256: request.custodyCheckpointSha256,
      nextArchiveCommitOrdinal: intent.nextArchiveCommitOrdinal,
      nextFrontierSha256: intent.nextFrontierSha256,
      now: clockAt(input),
      pageSha256: request.pageSha256,
      startSha256: request.startSha256,
    }));
  }
  // require durable exact successor visibility before retiring any server bytes
  if (cursor.archiveCommitOrdinal !== intent.nextArchiveCommitOrdinal ||
    cursor.frontierSha256 !== intent.nextFrontierSha256 ||
    !canonicalJsonBytes(await input.journal.readRevisionCursor())
      .equals(canonicalJsonBytes(cursor))) {
    throw new Error("revision cold drain durable cursor differs");
  }
  const acknowledgement = validateAdjustmentRevisionColdCustodyAcknowledgementV2(
    await input.acknowledge(request),
  );
  // bind the server's custody-only reply to every archived request and successor coordinate
  for (const [name, value] of Object.entries({
    ...request,
    nextArchiveCommitOrdinal: intent.nextArchiveCommitOrdinal,
    nextFrontierSha256: intent.nextFrontierSha256,
  })) {
    if (acknowledgement[name] !== value) {
      throw new Error("revision cold custody acknowledgement differs");
    }
  }
  await input.journal.completeRevisionCustodyV2({
    acknowledgement,
    now: clockAt(input),
  });
  return { cursor, transferBytes: canonicalJsonBytes(acknowledgement).length };
}

// use the actual local commit clock for each append-only custody transition
function clockAt(input) {
  const now = input.clock();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("revision cold drain clock is invalid");
  }
  return now.toISOString();
}

// accept only a retained unsigned database ordinal and its exact frontier hash
function validateCursor(value) {
  requireExactKeys(value, ["archiveCommitOrdinal", "frontierSha256"],
    "revision cold drain cursor");

  // reject overflow and noncanonical ordinal encodings before remote requests
  if (typeof value.archiveCommitOrdinal !== "string" ||
    !/^(?:0|[1-9]\d{0,19})$/u.test(value.archiveCommitOrdinal) ||
    BigInt(value.archiveCommitOrdinal) > 0xffff_ffff_ffff_ffffn) {
    throw new TypeError("revision cold drain cursor ordinal is invalid");
  }
  requireSha256(value.frontierSha256);
  return Object.freeze({ ...value });
}

// reject caller knobs and incomplete evidence surfaces
function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} fields are invalid`);
  }
}

// require a content-addressed graph or frontier identity
function requireSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("revision cold drain sha256 is invalid");
  }
}

// retain canonical utc precision at the frozen due boundary
function requireInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
    .test(value) || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError("revision cold drain cutoff is invalid");
  }
}
