import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdjustmentRevisionArchiveStore,
  buildAdjustmentRevisionColdGraphSegment,
  readAdjustmentRevisionColdPage,
  readAdjustmentRevisionColdTransferStart,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import {
  adjustmentSha256,
  canonicalJsonBytes,
} from "./adjustment_plaintext_archive.mjs";
import {
  ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES,
  ADJUSTMENT_REVISION_CUSTODY_TRANSFER_MAXIMUM_BYTES,
  createAdjustmentRevisionCustodyPack,
} from "./adjustment_revision_custody_pack.mjs";

const CUTOFF = "2026-10-10T08:00:00.000Z";
const GENESIS = adjustmentSha256(Buffer.from("adjustment-revision-frontier/v1\n0\n"));

test("custody pack reserves at least four maximum transfer envelopes", () => {
  assert.ok(ADJUSTMENT_REVISION_CUSTODY_PACK_MAXIMUM_BYTES >=
    4 * ADJUSTMENT_REVISION_CUSTODY_TRANSFER_MAXIMUM_BYTES);
});

// retain one crash-injectable in-memory storage boundary
class MemoryPackStore {
  metadata = Buffer.alloc(0);
  payload = Buffer.alloc(0);

  // report the exact retained raw length
  async payloadSize() {
    return this.payload.length;
  }

  // restore one exact raw range
  async readPayload(offset, length) {
    return Buffer.from(this.payload.subarray(offset, offset + length));
  }

  // restore one exact metadata checkpoint
  async readMetadata() {
    return Buffer.from(this.metadata);
  }

  // append one raw range before metadata publication
  async appendPayload(bytes) {
    this.payload = Buffer.concat([this.payload, bytes]);
  }

  // atomically replace one metadata checkpoint
  async writeMetadata(bytes) {
    this.metadata = Buffer.from(bytes);
  }

  // reconcile only an uncheckpointed suffix
  async truncatePayload(length) {
    this.payload = Buffer.from(this.payload.subarray(0, length));
  }

  // remove the exact sealed pack
  async remove() {
    this.payload = Buffer.alloc(0);
    this.metadata = Buffer.alloc(0);
  }
}

// build one database-shaped receipt from a real producer stage
function receiptForStage(stage) {
  const receipt = {
    archiveCommitOrdinal: "1",
    archiveCommittedAt: "2026-10-10T07:59:00.000Z",
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: "",
    predecessorFrontierSha256: GENESIS,
    projectionIdentitySha256: stage.projectionIdentitySha256,
    projectionKind: stage.projectionKind,
    projectionSha256: stage.projectionSha256,
    receiptSha256: "",
    stageReceiptSha256: stage.stageReceiptSha256,
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

// bind one serving snapshot to its exact receipt
function snapshotForReceipt(receipt) {
  const snapshot = {
    archiveCommitOrdinal: receipt.archiveCommitOrdinal,
    contractVersion: "adjustment-revision-serving-snapshot/v1",
    cutoffAt: CUTOFF,
    entries: [{
      logicalReceivedAt: "2026-10-10T07:59:00.000Z",
      receipt,
      relation: "weather_records",
    }],
    entryCount: 1,
    frontierSha256: receipt.frontierSha256,
    snapshotSha256: "",
  };
  snapshot.snapshotSha256 = adjustmentSha256(Buffer.from([
    snapshot.contractVersion,
    snapshot.cutoffAt,
    snapshot.archiveCommitOrdinal,
    snapshot.frontierSha256,
    receipt.receiptSha256,
  ].join("\n")));
  return snapshot;
}

// construct one genuine nonempty cold transfer page
async function coldTransferFixture() {
  const root = await mkdtemp(join(tmpdir(), "weather-custody-pack-"));

  // initialize the real producer's fixed private directories
  for (const directory of [
    "revision-commit-receipts",
    "revision-frontier-successors",
    "revision-projections",
    "shadow-revision-capsules",
  ]) {
    await mkdir(join(root, directory), { mode: 0o700 });
  }
  const archive = new AdjustmentRevisionArchiveStore({
    parseProjection: (bytes) => JSON.parse(bytes.toString("utf8")),
    root,
  });
  const stage = await archive.stageProjection(canonicalJsonBytes({
    contractVersion: "adjustment-revision-projection/v1",
    family: "shared",
    logicalKey: { id: "fixture" },
    logicalReceivedAt: "2026-10-10T07:58:00.000Z",
    projectionKind: "actual_best_match",
    rows: [{ id: "fixture" }],
    source: { id: "fixture" },
    storedContentSha256: "a".repeat(64),
  }));
  const receipt = receiptForStage(stage);
  await archive.publishRevision({ revisionReceipt: receipt, stageReceipt: stage });
  const start = await readAdjustmentRevisionColdTransferStart({
    root,
    servingSnapshot: snapshotForReceipt(receipt),
  });
  const page = await readAdjustmentRevisionColdPage({
    afterArchiveCommitOrdinal: "0",
    afterFrontierSha256: GENESIS,
    previousPageSha256: start.startSha256,
    root,
    startSha256: start.startSha256,
    watermarkArchiveCommitOrdinal: start.watermarkArchiveCommitOrdinal,
    watermarkFrontierSha256: start.watermarkFrontierSha256,
  });
  return { page, root, start };
}

// prove custody can retire after a private checkpoint and seal later as one graph
test("custody pack reopens exact pages before bounded graph sealing", async () => {
  const fixture = await coldTransferFixture();
  const store = new MemoryPackStore();
  const pack = createAdjustmentRevisionCustodyPack({ store });
  try {
    const appended = await pack.append({ page: fixture.page, start: fixture.start });
    assert.match(appended.checkpointSha256, /^[a-f0-9]{64}$/u);
    assert.equal(appended.pages.length, 1);
    assert.equal(appended.pages[0].page.pageSha256, fixture.page.pageSha256);
    const retainedBytes = appended.byteLength;

    // emulate a crash after raw append but before atomic metadata replacement
    store.payload = Buffer.concat([store.payload, Buffer.from("uncommitted-tail")]);
    const recovered = await pack.inspect();
    assert.equal(recovered.byteLength, retainedBytes);
    assert.equal(store.payload.length, retainedBytes);
    assert.equal(recovered.checkpointSha256, appended.checkpointSha256);
    assert.equal((await pack.append({ page: fixture.page, start: fixture.start }))
      .checkpointSha256, appended.checkpointSha256);

    const sealed = await pack.buildSealedSegment();
    const direct = buildAdjustmentRevisionColdGraphSegment({
      page: fixture.page,
      start: fixture.start,
    });
    assert.equal(sealed.checkpointSha256, appended.checkpointSha256);
    assert.deepEqual(sealed.segment.members, direct.members);
    assert.deepEqual(sealed.segment.crossLinks, direct.crossLinks);
    assert.deepEqual(sealed.pageCheckpoints, [{
      memberRootSha256: JSON.parse(direct.members[0].payload).memberRootSha256,
      pageSha256: fixture.page.pageSha256,
      startMemberSha256: adjustmentSha256(canonicalJsonBytes(fixture.start)),
      startSha256: fixture.start.startSha256,
    }]);
    await pack.removeSealed(sealed.checkpointSha256);
    assert.deepEqual(await pack.inspect(), {
      byteLength: 0,
      checkpointSha256: null,
      metadataByteLength: 0,
      pages: [],
    });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

// prohibit empty custody records and deletion under a changed identity
test("custody pack refuses empty pages and mismatched sealed removal", async () => {
  const fixture = await coldTransferFixture();
  const store = new MemoryPackStore();
  const pack = createAdjustmentRevisionCustodyPack({ store });
  try {
    await pack.append({ page: fixture.page, start: fixture.start });
    await assert.rejects(pack.removeSealed("f".repeat(64)), /checkpoint differs/u);
    const emptyPage = {
      ...fixture.page,
      entries: [],
    };
    await assert.rejects(pack.append({ page: emptyPage, start: fixture.start }));
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
