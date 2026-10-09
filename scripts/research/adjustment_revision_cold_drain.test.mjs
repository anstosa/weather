import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AdjustmentRevisionArchiveStore,
  acknowledgeAdjustmentRevisionColdCustodyCheckpoint,
  buildAdjustmentRevisionColdGraphSegment,
  readAdjustmentRevisionColdPage,
  readAdjustmentRevisionColdTransferStart,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";
import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";
import { drainAdjustmentRevisionColdPage } from "./adjustment_revision_cold_drain.mjs";

const GENESIS = adjustmentSha256(Buffer.from("adjustment-revision-frontier/v1\n0\n"));
const GRAPH = "a".repeat(64);
const CUTOFF = "2026-10-09T01:10:00.000Z";

// bind deterministic database-shaped receipts to real durable producer stages
function receiptForStage(stage, ordinal, predecessorFrontierSha256) {
  const receipt = {
    archiveCommitOrdinal: String(ordinal),
    archiveCommittedAt: `2026-10-09T01:0${ordinal}:00.000Z`,
    contractVersion: "adjustment-revision-commit-receipt/v1",
    frontierSha256: "",
    predecessorFrontierSha256,
    projectionIdentitySha256: stage.projectionIdentitySha256,
    projectionKind: stage.projectionKind,
    projectionSha256: stage.projectionSha256,
    receiptSha256: "",
    stageReceiptSha256: stage.stageReceiptSha256,
  };
  receipt.receiptSha256 = adjustmentSha256(Buffer.from([
    receipt.contractVersion, receipt.archiveCommitOrdinal, receipt.archiveCommittedAt,
    receipt.projectionKind, receipt.projectionIdentitySha256, receipt.projectionSha256,
    receipt.stageReceiptSha256, receipt.predecessorFrontierSha256,
  ].join("\n")));
  receipt.frontierSha256 = adjustmentSha256(Buffer.from([
    "adjustment-revision-frontier/v1", predecessorFrontierSha256,
    receipt.archiveCommitOrdinal, receipt.receiptSha256,
  ].join("\n")));
  return receipt;
}

// construct a genuine content-addressed serving snapshot from exact receipts
function snapshotForReceipts(receipts) {
  const snapshot = {
    archiveCommitOrdinal: receipts.at(-1)?.archiveCommitOrdinal ?? "0",
    contractVersion: "adjustment-revision-serving-snapshot/v1",
    cutoffAt: CUTOFF,
    entries: receipts.map(
      // preserve exact ordered pointers without value-bearing rows
      (receipt) => ({
        logicalReceivedAt: "2026-10-09T00:00:00.000Z",
        receipt,
        relation: "weather_records",
      }),
    ),
    entryCount: receipts.length,
    frontierSha256: receipts.at(-1)?.frontierSha256 ?? GENESIS,
    snapshotSha256: "",
  };
  snapshot.snapshotSha256 = adjustmentSha256(Buffer.from([
    snapshot.contractVersion, CUTOFF, snapshot.archiveCommitOrdinal,
    snapshot.frontierSha256, receipts.map((receipt) => receipt.receiptSha256).join("\n"),
  ].join("\n")));
  return snapshot;
}

// exercise real server stage and successor codecs with an isolated custody boundary
async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "weather-cold-drain-"));
  // model the explicit root bootstrap before the first producer stage exists
  for (const directory of [
    "revision-commit-receipts", "revision-frontier-successors",
    "revision-projections", "shadow-revision-capsules", "rain-control-states",
    "rain-control-state-stage-receipts",
  ]) {
    await mkdir(join(root, directory), { mode: 0o700 });
  }
  const store = new AdjustmentRevisionArchiveStore({
    parseProjection: (bytes) => JSON.parse(bytes.toString("utf8")),
    root,
  });
  const receipts = [];
  let cursor = { archiveCommitOrdinal: "0", frontierSha256: GENESIS };
  let pending = null;
  const events = [];
  const ports = {
    // exercise actual server checkpoint and exact hash-bound retirement
    acknowledge: async (request) => {
      events.push("acknowledge");
      return await acknowledgeAdjustmentRevisionColdCustodyCheckpoint({ ...request, root });
    },
    // record the exact graph member closure before allowing cursor mutation
    archivePage: async (input) => {
      events.push("archive");
      const segment = buildAdjustmentRevisionColdGraphSegment(input);
      assert.ok(segment.members.some((member) => member.identitySha256 === input.page.pageSha256));
      const checkpoint = JSON.parse(segment.members[0].payload.toString("utf8"));
      return {
        custodyCheckpointSha256: GRAPH,
        memberRootSha256: checkpoint.memberRootSha256,
        startMemberSha256: checkpoint.startMemberSha256,
      };
    },
    clock: () => new Date("2026-10-09T01:11:00.000Z"),
    cutoffAt: CUTOFF,
    fetchPage: async (input) => await readAdjustmentRevisionColdPage({ ...input, root }),
    fetchStart: async () => await readAdjustmentRevisionColdTransferStart({
      root, servingSnapshot: snapshotForReceipts(receipts),
    }),
    journal: {
      // expose only the durable predecessor for every transfer
      readRevisionCursor: async () => cursor,
      // preserve the exact intent across a simulated process failure
      readPendingRevisionCustody: async () => pending,
      // retain only this verified page and its intended successor
      recordRevisionCustodyIntent: async ({ now, ...intent }) => {
        assert.equal(now, "2026-10-09T01:11:00.000Z");
        events.push("intent");
        pending = intent;
        return pending;
      },
      // mark custody complete only after its server acknowledgement validates
      completeRevisionCustodyV2: async (input) => {
        assert.equal(input.acknowledgement.pageSha256, pending.request.pageSha256);
        events.push("complete");
        pending = null;
      },
      // emulate the production journal compare-and-swap boundary
      advanceRevisionCursor: async (input) => {
        events.push("cursor");
        assert.equal(input.custodyCheckpointSha256, GRAPH);
        assert.equal(input.afterArchiveCommitOrdinal, cursor.archiveCommitOrdinal);
        assert.equal(input.afterFrontierSha256, cursor.frontierSha256);
        cursor = {
          archiveCommitOrdinal: input.nextArchiveCommitOrdinal,
          frontierSha256: input.nextFrontierSha256,
        };
        return cursor;
      },
    },
    // defer immutable graph sealing until the pack reaches its fixed threshold
    sealPack: async () => {
      events.push("seal");
      return { state: "pending" };
    },
  };

  // publish no more than the real online producer slot ceiling
  const publish = async (projectionKind) => {
    const index = receipts.length;
    const stage = await store.stageProjection(canonicalJsonBytes({
      contractVersion: "adjustment-revision-projection/v1",
      family: "shared",
      logicalKey: { index },
      logicalReceivedAt: "2026-10-09T00:00:00.000Z",
      projectionKind,
      rows: [{ index }],
      source: { index: String(index) },
      storedContentSha256: String(index + 1).repeat(64),
    }));
    const receipt = receiptForStage(stage, index + 1, receipts.at(-1)?.frontierSha256 ?? GENESIS);
    await store.publishRevision({ revisionReceipt: receipt, stageReceipt: stage });
    receipts.push(receipt);
  };

  try {
    await run({ events, ports, publish, receipts });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

// prove two real bodies and all auxiliary members precede custody advancement
test("cold drain archives actual successor bytes before advancing the durable cursor", async () => {
  await withFixture(async ({ events, ports, publish, receipts }) => {
    await publish("actual_best_match");
    await publish("target_revision");
    const result = await drainAdjustmentRevisionColdPage(ports);
    assert.equal(result.state, "captured_through_watermark");
    assert.equal(result.eof, true);
    assert.equal(result.pages.length, 1);
    assert.equal(result.publishedEntries.length, 2);
    assert.equal(result.cursor.frontierSha256, receipts.at(-1).frontierSha256);
    assert.ok(result.transferBytes <= 4_832 * 1_024);
    assert.deepEqual(events, [
      "archive", "intent", "cursor", "acknowledge", "complete", "seal",
    ]);
  });
});

// authenticate unchanged frontier without consuming lifetime archive counts
test("empty EOF proves its snapshot without archiving or advancing custody", async () => {
  await withFixture(async ({ events, ports }) => {
    const result = await drainAdjustmentRevisionColdPage(ports);
    assert.equal(result.eof, true);
    assert.equal(result.cursor.archiveCommitOrdinal, "0");
    assert.deepEqual(result.pages, []);
    assert.deepEqual(events, []);
  });
});

// lock fail-before-cursor behavior for archive and caller-bound reply failures
test("archive failure or a mismatched original cutoff cannot advance custody", async () => {
  await withFixture(async ({ events, ports, publish }) => {
    await publish("actual_best_match");
    await assert.rejects(drainAdjustmentRevisionColdPage({
      ...ports,
      // simulate a failed full-graph verification boundary
      archivePage: async () => { throw new Error("graph verification failed"); },
    }), /graph verification failed/u);
    assert.equal((await ports.journal.readRevisionCursor()).archiveCommitOrdinal, "0");
    await assert.rejects(drainAdjustmentRevisionColdPage({
      ...ports, cutoffAt: "2026-10-09T01:09:00.000Z",
    }), /cutoff differs/u);
    assert.deepEqual(events, []);
  });
});

// retain a newer cursor while requiring historical semantics to use archived graphs
test("historical cutoffs never rewind the captured global frontier", async () => {
  await withFixture(async ({ events, ports, publish }) => {
    await publish("actual_best_match");
    await drainAdjustmentRevisionColdPage(ports);
    const emptyStart = await ports.fetchStart(CUTOFF);
    const unsigned = {
      contractVersion: emptyStart.contractVersion,
      servingSnapshot: snapshotForReceipts([]),
      watermarkArchiveCommitOrdinal: "0",
      watermarkFrontierSha256: GENESIS,
    };
    const result = await drainAdjustmentRevisionColdPage({
      ...ports,
      fetchStart: async () => ({ ...unsigned, startSha256: adjustmentSha256(canonicalJsonBytes(unsigned)) }),
      // historical retrieval must never ask the server to replay or rewind its cursor
      fetchPage: async () => { throw new Error("unexpected page request"); },
    });
    assert.equal(result.state, "archived_cursor_ahead");
    assert.equal(result.cursor.archiveCommitOrdinal, "1");
    assert.deepEqual(result.pages, []);
    assert.deepEqual(events, [
      "archive", "intent", "cursor", "acknowledge", "complete", "seal",
    ]);
  });
});

// retry the original ten-coordinate request after the local cursor is already committed
test("acknowledgement failure resumes durable intent instead of stranding hot slots", async () => {
  await withFixture(async ({ events, ports, publish }) => {
    await publish("actual_best_match");
    let fail = true;
    const acknowledge = ports.acknowledge;
    const request = {
      ...ports,
      // inject a transport outage before any server retirement
      acknowledge: async (input) => {
        if (fail) {
          fail = false;
          throw new Error("transport unavailable");
        }
        return await acknowledge(input);
      },
    };
    await assert.rejects(drainAdjustmentRevisionColdPage(request), /transport unavailable/u);
    assert.equal((await ports.journal.readRevisionCursor()).archiveCommitOrdinal, "1");
    assert.notEqual(await ports.journal.readPendingRevisionCustody(), null);
    const resumed = await drainAdjustmentRevisionColdPage({
      ...request,
      // recovery cannot invent a new snapshot or ask for the next empty page
      fetchStart: async () => { throw new Error("unexpected new snapshot"); },
    });
    assert.equal(resumed.state, "custody_reconciled");
    assert.equal(await ports.journal.readPendingRevisionCustody(), null);
    assert.deepEqual(events, [
      "archive", "intent", "cursor", "acknowledge", "complete", "seal",
    ]);
  });
});

// replay the durable intent before acknowledging when cursor commit failed
test("crash after intent persistence advances the exact archived cursor before acknowledgement", async () => {
  await withFixture(async ({ events, ports, publish }) => {
    await publish("target_revision");
    const advance = ports.journal.advanceRevisionCursor;
    let fail = true;
    ports.journal.advanceRevisionCursor = async (input) => {
      if (fail) {
        fail = false;
        throw new Error("cursor write failed");
      }
      return await advance(input);
    };
    await assert.rejects(drainAdjustmentRevisionColdPage(ports), /cursor write failed/u);
    assert.equal((await ports.journal.readRevisionCursor()).archiveCommitOrdinal, "0");
    assert.deepEqual(events, ["archive", "intent"]);
    assert.equal((await drainAdjustmentRevisionColdPage(ports)).state, "custody_reconciled");
    assert.deepEqual(events, [
      "archive", "intent", "cursor", "acknowledge", "complete", "seal",
    ]);
  });
});
