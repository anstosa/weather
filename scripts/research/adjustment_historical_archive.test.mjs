import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  verifyAdjustmentRevisionColdCatalog,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  restoreAdjustmentRevisionHistoricalArchive,
} from "./adjustment_historical_archive.mjs";
import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";

// build one exact server receipt in the global frontier chain
function coldReceipt(input) {
  const receipt = {
    archiveCommitOrdinal: input.archiveCommitOrdinal,
    archiveCommittedAt: input.archiveCommittedAt,
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: "",
    predecessorFrontierSha256: input.predecessorFrontierSha256,
    projectionIdentitySha256: input.projectionIdentitySha256,
    projectionKind: input.projectionKind,
    projectionSha256: input.projectionIdentitySha256,
    receiptSha256: "",
    stageReceiptSha256: input.stageReceiptSha256,
  };
  receipt.receiptSha256 = adjustmentSha256(Buffer.from([
    receipt.contractVersion,
    receipt.archiveCommitOrdinal,
    receipt.archiveCommittedAt,
    receipt.projectionKind,
    receipt.projectionIdentitySha256,
    receipt.projectionSha256,
    receipt.stageReceiptSha256,
    receipt.predecessorFrontierSha256,
  ].join("\n")));
  receipt.frontierSha256 = adjustmentSha256(Buffer.from([
    "adjustment-revision-frontier/v1",
    receipt.predecessorFrontierSha256,
    receipt.archiveCommitOrdinal,
    receipt.receiptSha256,
  ].join("\n")));
  return receipt;
}

// build one exact current-pointer snapshot at a transfer watermark
function servingSnapshot(receipts, watermarkReceipt, cutoffAt) {
  const snapshot = {
    archiveCommitOrdinal: watermarkReceipt.archiveCommitOrdinal,
    contractVersion: "adjustment-revision-serving-snapshot/v1",
    cutoffAt,
    entries: receipts.map(
      // retain the producer relation used by the source table
      (receipt, index) => ({
        logicalReceivedAt: new Date(Date.parse(cutoffAt) - (index + 1) * 1_000).toISOString(),
        receipt,
        relation: receipt.projectionKind === "native_source"
          ? "forecast_anchor_records"
          : receipt.projectionKind === "rain_gate_input"
            ? "rain_adjustment_runs"
            : "weather_records",
      }),
    ),
    entryCount: receipts.length,
    frontierSha256: watermarkReceipt.frontierSha256,
    snapshotSha256: "",
  };
  snapshot.snapshotSha256 = adjustmentSha256(Buffer.from([
    snapshot.contractVersion,
    snapshot.cutoffAt,
    snapshot.archiveCommitOrdinal,
    snapshot.frontierSha256,
    receipts.map((receipt) => receipt.receiptSha256).join("\n"),
  ].join("\n")));
  return snapshot;
}

// build one authenticated transfer start around a snapshot
function transferStart(snapshot) {
  const unsigned = {
    contractVersion: "adjustment-revision-cold-transfer-start/v1",
    servingSnapshot: snapshot,
    watermarkArchiveCommitOrdinal: snapshot.archiveCommitOrdinal,
    watermarkFrontierSha256: snapshot.frontierSha256,
  };
  return { ...unsigned, startSha256: adjustmentSha256(canonicalJsonBytes(unsigned)) };
}

// hash one checkpoint's exact archived member population
function checkpointMemberRoot(entries, startMemberSha256) {
  return adjustmentSha256(canonicalJsonBytes({
    entries: entries.map(
      // preserve the frozen single-receipt checkpoint member tuple
      (entry) => ({
        payloadMemberSha256: entry.payloadIdentitySha256,
        publicationDisposition: entry.publicationDisposition,
        publicationIdentitySha256: entry.publicationIdentitySha256,
        publicationMemberSha256: entry.publicationMemberSha256,
        receiptMemberSha256: entry.receiptMemberSha256,
        stageReceiptMemberSha256: entry.stageReceiptMemberSha256,
        successorMemberSha256: entry.successorMemberSha256,
      }),
    ),
    startMemberSha256,
  }));
}

// project one receipt into its compact checkpoint entry
function checkpointEntry(receipt, payloadBytes, label) {
  const successorSha256 = adjustmentSha256(Buffer.from(`${label}-successor`));
  return {
    payloadIdentitySha256: adjustmentSha256(payloadBytes),
    payloadKind: "adjustment-revision-projection/v1",
    publicationDisposition: "published",
    publicationIdentitySha256: adjustmentSha256(Buffer.from(`${label}-publication-id`)),
    publicationMemberSha256: adjustmentSha256(Buffer.from(`${label}-publication-member`)),
    receiptMemberSha256: adjustmentSha256(canonicalJsonBytes(receipt)),
    receiptSha256: receipt.receiptSha256,
    stageReceiptMemberSha256: adjustmentSha256(Buffer.from(`${label}-stage-member`)),
    stageReceiptSha256: receipt.stageReceiptSha256,
    successorMemberSha256: successorSha256,
    successorSha256,
  };
}

// restore requested members from multiple packed in-memory graphs
function packedArchive(graphs) {
  return {
    // honor the production archive reader's target and sink boundary
    restoreFullGraph: async (requestedGraphSha256, { sink, targets }) => {
      const members = graphs.get(requestedGraphSha256);
      assert.ok(members instanceof Map);

      // stream each exact content-addressed member once
      for (const target of targets) {
        const bytes = members.get(target.identitySha256);
        assert.ok(bytes instanceof Buffer,
          `missing ${target.identitySha256} from ${requestedGraphSha256}`);
        const readable = new PassThrough();
        readable.end(bytes);
        await sink.writeExclusive(target.fileName, readable, bytes.length);
      }
    },
  };
}

// build three genuine starts across two immutable packed graphs
function packedFixture() {
  const genesis = adjustmentSha256(Buffer.from(
    "adjustment-revision-frontier/v1\n0\n",
  ));
  const kinds = [
    "actual_best_match", "native_source", "actual_best_match", "native_source",
    "rain_gate_input", "target_revision",
  ];
  const payloads = kinds.map(
    // retain canonical distinct bytes without requiring unused bodies to parse
    (kind, index) => canonicalJsonBytes({
      contractVersion: "adjustment-revision-projection/v1",
      index,
      kind,
    }),
  );
  const receipts = [];
  let predecessorFrontierSha256 = genesis;

  // construct one genuine monotonic server frontier
  for (const [index, projectionKind] of kinds.entries()) {
    const receipt = coldReceipt({
      archiveCommitOrdinal: String(index + 1),
      archiveCommittedAt: `2026-10-10T08:0${index + 1}:00.000Z`,
      predecessorFrontierSha256,
      projectionIdentitySha256: adjustmentSha256(payloads[index]),
      projectionKind,
      stageReceiptSha256: adjustmentSha256(Buffer.from(`stage-${index}`)),
    });
    receipts.push(receipt);
    predecessorFrontierSha256 = receipt.frontierSha256;
  }
  const currentReceipts = receipts.slice(2);
  const starts = [
    transferStart(servingSnapshot(receipts.slice(0, 2), receipts[1],
      "2026-10-10T08:10:00.000Z")),
    transferStart(servingSnapshot(receipts.slice(2, 4), receipts[3],
      "2026-10-10T08:20:00.000Z")),
    transferStart(servingSnapshot(currentReceipts, receipts[5],
      "2026-10-10T08:30:00.000Z")),
  ];
  const freshStart = transferStart(servingSnapshot(currentReceipts, receipts[5],
    "2026-10-10T09:00:00.000Z"));
  const pages = [];

  // make every poll a distinct first page with its own genuine start member
  for (let index = 0; index < starts.length; index += 1) {
    const pairStart = index * 2;
    const entries = receipts.slice(pairStart, pairStart + 2).map(
      // retain the exact two source bodies in this bounded page
      (receipt, entryIndex) => checkpointEntry(
        receipt,
        payloads[pairStart + entryIndex],
        `page-${index}-${entryIndex}`,
      ),
    );
    const pageSha256 = adjustmentSha256(Buffer.from(`page-${index}`));
    const startMemberSha256 = adjustmentSha256(canonicalJsonBytes(starts[index]));
    pages.push({
      afterArchiveCommitOrdinal: String(pairStart),
      afterFrontierSha256: pairStart === 0
        ? genesis
        : receipts[pairStart - 1].frontierSha256,
      contractVersion: "adjustment-revision-cold-page-checkpoint/v1",
      entries,
      eof: true,
      memberRootSha256: checkpointMemberRoot(entries, startMemberSha256),
      nextArchiveCommitOrdinal: String(pairStart + 2),
      nextFrontierSha256: receipts[pairStart + 1].frontierSha256,
      pageSha256,
      previousPageSha256: starts[index].startSha256,
      startMemberSha256,
      startSha256: starts[index].startSha256,
      watermarkArchiveCommitOrdinal: starts[index].watermarkArchiveCommitOrdinal,
      watermarkFrontierSha256: starts[index].watermarkFrontierSha256,
    });
  }
  const graphSha256s = [
    adjustmentSha256(Buffer.from("packed-graph-one")),
    adjustmentSha256(Buffer.from("packed-graph-two")),
  ];
  const graphMembers = [new Map(), new Map()];

  // pack two independent transfer epochs together and one in a successor graph
  for (const [index, page] of pages.entries()) {
    const members = graphMembers[index < 2 ? 0 : 1];
    members.set(page.pageSha256, canonicalJsonBytes(page));
    members.set(starts[index].startSha256, canonicalJsonBytes(starts[index]));
    for (let receiptIndex = index * 2; receiptIndex < index * 2 + 2; receiptIndex += 1) {
      members.set(receipts[receiptIndex].receiptSha256,
        canonicalJsonBytes(receipts[receiptIndex]));
      members.set(adjustmentSha256(payloads[receiptIndex]), payloads[receiptIndex]);
    }
  }
  return {
    archive: packedArchive(new Map([
      [graphSha256s[0], graphMembers[0]],
      [graphSha256s[1], graphMembers[1]],
    ])),
    currentReceipts,
    freshStart,
    mappings: pages.map((page, index) => ({
      graphManifestSha256: graphSha256s[index < 2 ? 0 : 1],
      pageSha256: page.pageSha256,
      startSha256: page.startSha256,
    })),
    payloads,
    receipts,
    starts,
  };
}

test("historical resolver streams contiguous pages across distinct starts and packs", async () => {
  const fixture = packedFixture();
  const result = await restoreAdjustmentRevisionHistoricalArchive({
    archive: fixture.archive,
    mappings: fixture.mappings,
    selection: {
      family: null,
      fromAt: null,
      receiptSha256s: fixture.currentReceipts.map((receipt) => receipt.receiptSha256),
      toAt: null,
    },
    start: fixture.freshStart,
  });
  assert.equal(result.contractVersion, "adjustment-revision-historical-archive-index/v1");
  assert.equal(result.catalog.frontierCount, 6);
  assert.equal(result.pages.length, 3);
  assert.equal(new Set(result.pages.map((page) => page.startSha256)).size, 3);
  assert.notEqual(result.pages.at(-1).startSha256, fixture.freshStart.startSha256);
  assert.equal(result.receiptCount, 6);
  assert.deepEqual(result.catalog, verifyAdjustmentRevisionColdCatalog({
    receipts: fixture.receipts,
    servingSnapshot: fixture.freshStart.servingSnapshot,
  }));
  assert.equal(result.occurrences.length, 4);
  assert.deepEqual(
    result.occurrences.map((entry) => entry.receipts[0].receiptSha256),
    fixture.currentReceipts.map((receipt) => receipt.receiptSha256),
  );
  assert.deepEqual(result.occurrences.map((entry) => entry.payloadBytes),
    fixture.payloads.slice(2));
  assert.match(result.historyRootSha256, /^[a-f0-9]{64}$/u);
});

test("historical resolver rejects duplicate page mappings", async () => {
  const fixture = packedFixture();
  await assert.rejects(restoreAdjustmentRevisionHistoricalArchive({
    archive: fixture.archive,
    mappings: [fixture.mappings[0], fixture.mappings[0]],
    selection: {
      family: null,
      fromAt: null,
      receiptSha256s: fixture.currentReceipts.map((receipt) => receipt.receiptSha256),
      toAt: null,
    },
    start: fixture.freshStart,
  }), /page repeats/u);
});
