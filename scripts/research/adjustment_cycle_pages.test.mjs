import assert from "node:assert/strict";
import test from "node:test";
import {
  ADJUSTMENT_CYCLE_MAXIMUM_PAGES,
  ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES,
  ADJUSTMENT_DAILY_MAXIMUM_PAGES,
  ackCyclePage,
  appendCyclePage,
  appendCyclePageFailOpen,
  createCyclePageState,
  encodeCycleCapsule,
  finalizeCyclePages,
  reconcileCyclePages,
  validateCycleCapsule,
  validateCycleFinalManifest,
  validateCyclePage,
  validateCyclePageState,
} from "./adjustment_cycle_pages.mjs";

const DUE_KEY = "capture/2026-10-08T00:35:00.000Z";

// create exact durability ports with injectable failures
function createPorts() {
  const durable = { acknowledgements: [], final: null, gaps: [], pages: [] };
  const failures = new Set();
  return {
    durable,
    failures,
    // supply one stable clock for fail-open gaps
    now: () => new Date("2026-10-08T01:00:00.000Z"),
    // persist one slot page and fsync it
    persistPage: async (value) => {
      // inject one pre-ack page crash
      if (failures.has("page")) {
        throw new Error("page crash");
      }
      durable.pages.push({ ...value, payload: Buffer.from(value.payload) });
      return { fsynced: true, pageSha256: value.pageSha256 };
    },
    // persist one acknowledgement before slot reuse
    persistAcknowledgement: async (value) => {
      // inject one acknowledgement crash
      if (failures.has("ack")) {
        throw new Error("ack crash");
      }
      durable.acknowledgements.push(value);
      return {
        acknowledgementSha256: value.acknowledgementSha256,
        fsynced: true,
      };
    },
    // persist one immutable final manifest
    persistFinalManifest: async (value) => {
      // inject one finalization crash
      if (failures.has("final")) {
        throw new Error("final crash");
      }
      durable.final = value;
      return { fsynced: true, manifestSha256: value.manifestSha256 };
    },
    // persist one permanent evidence gap
    persistGap: async (value) => {
      // inject one gap crash
      if (failures.has("gap")) {
        throw new Error("gap crash");
      }
      durable.gaps.push(value);
      return { fsynced: true, gapSha256: value.gapSha256 };
    },
  };
}

// create one empty test chain
function createState(dailyPageCount = 0) {
  return createCyclePageState({
    dailyPageCount,
    dueKey: DUE_KEY,
    generation: "7",
    localDate: "2026-10-08",
  });
}

// build one stable projection identity
function projection(index, channel = "organic") {
  return { channel, identitySha256: index.toString(16).padStart(64, "0") };
}

test("maximum 4,832 KiB skew uses exactly 19 acknowledged pages and one final manifest", async () => {
  const ports = createPorts();
  let state = createState();
  const totalBytes = 4_832 * 1_024;
  let remaining = totalBytes;

  // append and acknowledge the complete maximum-skew cycle
  while (remaining > 0) {
    const length = Math.min(remaining, ADJUSTMENT_CYCLE_PAGE_PAYLOAD_BYTES);
    state = await appendCyclePage(state, {
      payload: Buffer.alloc(length, state.pages.length),
      projections: state.pages.length === 0
        ? [projection(1, "scheduler_request")]
        : [],
    }, ports);
    state = await ackCyclePage(state, {
      acknowledgedAt: `2026-10-08T01:${String(state.pages.length).padStart(2, "0")}:00.000Z`,
      pageSha256: state.pages.at(-1).pageSha256,
    }, ports);
    remaining -= length;
  }

  assert.equal(state.pages.length, ADJUSTMENT_CYCLE_MAXIMUM_PAGES);
  assert.equal(state.acknowledgements.length, ADJUSTMENT_CYCLE_MAXIMUM_PAGES);
  assert.equal(state.slots.length, 0);
  assert.equal(state.pages.at(-1).payloadOffset + state.pages.at(-1).payloadLength, totalBytes);
  const finalized = await finalizeCyclePages(state, {
    finalizedAt: "2026-10-08T02:00:00.000Z",
  }, ports);
  assert.equal(finalized.manifest.pageCount, 19);
  assert.equal(finalized.manifest.totalPayloadBytes, totalBytes);
  assert.equal(finalized.manifest.acknowledgedProjectionCount, 1);
  assert.equal(validateCycleFinalManifest(finalized.manifest), finalized.manifest);
  const capsuleBytes = encodeCycleCapsule({
    manifest: finalized.manifest,
    manifestSha256: finalized.manifestSha256,
    pagePayloads: ports.durable.pages.map(
      // select each exact durable page payload
      (page) => page.payload,
    ),
  });
  const capsule = validateCycleCapsule(capsuleBytes);
  assert.equal(capsule.pageCount, 19);
  assert.equal(capsule.totalPayloadBytes, totalBytes);
  assert.equal(capsule.manifestSha256, finalized.manifestSha256);
  assert.equal(
    validateCyclePage({
      header: ports.durable.pages[0].header,
      pageSha256: ports.durable.pages[0].pageSha256,
      payload: ports.durable.pages[0].payload,
      projections: ports.durable.pages[0].projections,
    }).header.pageIndex,
    0,
  );
});

test("current and next are the only slots and fsync acknowledgement precedes reuse", async () => {
  const ports = createPorts();
  let state = createState();
  state = await appendCyclePage(state, {
    payload: Buffer.from("first"),
    projections: [projection(1)],
  }, ports);
  state = await appendCyclePage(state, {
    payload: Buffer.from("second"),
    projections: [projection(2)],
  }, ports);
  assert.deepEqual(state.slots.map(
    // select physical slot names
    (slot) => slot.slot,
  ), ["current", "next"]);
  await assert.rejects(
    // prohibit a hidden third-page spool
    appendCyclePage(state, { payload: Buffer.from("third"), projections: [projection(3)] }, ports),
    (error) => error.reason === "slot_unavailable",
  );

  ports.failures.add("ack");
  await assert.rejects(
    // crash before durable acknowledgement
    ackCyclePage(state, {
      acknowledgedAt: "2026-10-08T01:01:00.000Z",
      pageSha256: state.pages[0].pageSha256,
    }, ports),
    /ack crash/u,
  );
  assert.deepEqual(state.slots.map(
    // prove neither slot was reused
    (slot) => slot.slot,
  ), ["current", "next"]);

  ports.failures.delete("ack");
  state = await ackCyclePage(state, {
    acknowledgedAt: "2026-10-08T01:01:00.000Z",
    pageSha256: state.pages[0].pageSha256,
  }, ports);
  assert.deepEqual(state.slots.map(
    // prove next rotates only after fsync proof
    (slot) => slot.slot,
  ), ["current"]);
  state = await appendCyclePage(state, {
    payload: Buffer.from("third"),
    projections: [projection(3)],
  }, ports);
  assert.deepEqual(state.slots.map(
    // restore exactly two crash slots
    (slot) => slot.slot,
  ), ["current", "next"]);
});

test("page publication and finalization crashes retry to the same identities", async () => {
  const ports = createPorts();
  const initial = createState();
  ports.failures.add("page");
  await assert.rejects(
    // crash before page durability proof
    appendCyclePage(initial, {
      payload: Buffer.from("retry"),
      projections: [projection(1)],
    }, ports),
    /page crash/u,
  );
  assert.equal(initial.pages.length, 0);

  ports.failures.delete("page");
  let state = await appendCyclePage(initial, {
    payload: Buffer.from("retry"),
    projections: [projection(1)],
  }, ports);
  const pageSha256 = state.pages[0].pageSha256;
  state = await ackCyclePage(state, {
    acknowledgedAt: "2026-10-08T01:01:00.000Z",
    pageSha256,
  }, ports);
  ports.failures.add("final");
  await assert.rejects(
    // crash before immutable final-manifest proof
    finalizeCyclePages(state, { finalizedAt: "2026-10-08T02:00:00.000Z" }, ports),
    /final crash/u,
  );
  assert.equal(state.finalized, null);

  ports.failures.delete("final");
  const finalized = await finalizeCyclePages(
    state,
    { finalizedAt: "2026-10-08T02:00:00.000Z" },
    ports,
  );
  assert.equal(finalized.manifest.pages[0].pageSha256, pageSha256);
});

test("page and projection one-over refusals never block serving and record durable gaps", async () => {
  const ports = createPorts();
  let state = createState(ADJUSTMENT_DAILY_MAXIMUM_PAGES - 1);
  state = await appendCyclePage(state, {
    payload: Buffer.from("last daily page"),
    projections: [projection(1)],
  }, ports);
  state = await ackCyclePage(state, {
    acknowledgedAt: "2026-10-08T01:01:00.000Z",
    pageSha256: state.pages[0].pageSha256,
  }, ports);
  const pageRefusal = await appendCyclePageFailOpen(state, {
    payload: Buffer.from("one over"),
    projections: [projection(2)],
  }, ports);
  assert.equal(pageRefusal.status, "evidence_gap");
  assert.equal(pageRefusal.servingBlocked, false);
  assert.equal(pageRefusal.state.gaps[0].qualificationDisposition, "forever_unqualified");

  const allProjections = [
    ...Array.from({ length: 4_092 },
      // generate the complete organic allocation
      (_, index) => projection(index + 1)),
    ...Array.from({ length: 4 },
      // generate the reserved scheduler allocation
      (_, index) => projection(8_000 + index, "scheduler_request")),
  ];
  let projectionState = createState();
  projectionState = await appendCyclePage(projectionState, {
    payload: Buffer.from("all projections"),
    projections: allProjections,
  }, ports);
  projectionState = await ackCyclePage(projectionState, {
    acknowledgedAt: "2026-10-08T01:02:00.000Z",
    pageSha256: projectionState.pages[0].pageSha256,
  }, ports);
  const projectionRefusal = await appendCyclePageFailOpen(projectionState, {
    payload: Buffer.from("projection one over"),
    projections: [projection(9_000)],
  }, ports);
  assert.equal(projectionRefusal.status, "evidence_gap");
  assert.equal(projectionRefusal.servingBlocked, false);
  assert.equal(projectionRefusal.state.gaps.at(-1).reason, "projection_limit");
});

test("reconciliation accepts the exact durable prefix and rejects substitutions", async () => {
  const ports = createPorts();
  let state = createState();
  state = await appendCyclePage(state, {
    payload: Buffer.from("first"),
    projections: [projection(1)],
  }, ports);
  state = await ackCyclePage(state, {
    acknowledgedAt: "2026-10-08T01:01:00.000Z",
    pageSha256: state.pages[0].pageSha256,
  }, ports);
  const durable = {
    acknowledgements: state.acknowledgements,
    finalized: null,
    gaps: [],
    pages: state.pages,
  };
  const reconciled = reconcileCyclePages({ durable, expected: state });
  assert.equal(reconciled.status, "ready");
  assert.equal(validateCyclePageState(reconciled.state), reconciled.state);
  const substituted = structuredClone(durable);
  substituted.pages[0].payloadSha256 = "f".repeat(64);
  assert.throws(
    // reject a durable-page substitution
    () => reconcileCyclePages({ durable: substituted, expected: state }),
    /collision/u,
  );
});
