import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AdjustmentCyclePageDiskPorts,
  AdjustmentEvidenceArchiveTransport,
} from "../../deploy/scripts/adjustment-evidence-store.mjs";

import {
  ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES,
  ADJUSTMENT_ARCHIVE_ROOT_KIND,
  ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION,
  ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS,
  canonicalJsonBytes,
  createPlaintextArchive,
  inspectCasPack,
} from "./adjustment_plaintext_archive.mjs";
import {
  ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
  ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES,
  ackCyclePage,
  appendCyclePage,
  createCyclePageState,
  finalizeCyclePages,
} from "./adjustment_cycle_pages.mjs";
import {
  ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
  adjustmentArchiveJobTestOnly,
  consumeAdjustmentArchiveTransfers,
  createAdjustmentCycleCapsuleValidator,
  createOpenCycleCheckpoint,
  executeAdjustmentArchiveSshVerb,
  measureAdjustmentArchiveBackingCapacity,
  measureImmutableLegacyCensus,
  parseAdjustmentArchiveTransfer,
  waitForAdjustmentArchivePoll,
} from "./adjustment_archive_job.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const GIBIBYTE = 1_024n ** 3n;
const GENESIS_BLOCK_BYTES = 4_096n;

// provide one exact prospective-capacity snapshot
function genesisCapacity(overrides = {}) {
  const backingOverrides = overrides.backing ?? {};
  return {
    backing: {
      allocatedBytes: backingOverrides.allocatedBytes ?? 0n,
      freeBytes: backingOverrides.freeBytes ?? 64n * GIBIBYTE,
      freeInodes: backingOverrides.freeInodes ?? 1_000_000n,
      rootKind: "backing_c",
    },
    ext4BlockSize: overrides.ext4BlockSize ?? GENESIS_BLOCK_BYTES,
    ext4FreeBytes: overrides.ext4FreeBytes ?? 64n * GIBIBYTE,
    ext4FreeInodes: overrides.ext4FreeInodes ?? 1_000_000n,
    windowsTotalBytes: 1_000n * GIBIBYTE,
  };
}

// create one isolated literal home with an empty private weather ancestor
async function createGenesisFixture() {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "weather-adjustment-genesis-"));
  const homeRoot = join(fixtureRoot, "home");
  const weatherRoot = join(homeRoot, ".weather");
  const archiveRoot = join(
    weatherRoot,
    "adjustment-maintenance",
    "v2",
    "archive-primary",
  );
  await mkdir(homeRoot, { mode: 0o700 });
  await mkdir(weatherRoot, { mode: 0o700 });
  return { archiveRoot, fixtureRoot, homeRoot, weatherRoot };
}

// retain immutable objects and pointer rotations without disk side effects
class MemoryArchiveStore {
  constructor() {
    this.objects = new Map();
    this.pointers = new Map();
    this.capacity = {
      allocatedBytes: 0n,
      backing: {
        allocatedBytes: 0n,
        freeBytes: 128n * 1_024n ** 3n,
        freeInodes: 1_000_000n,
        rootKind: "backing_c",
      },
      blockSize: 4_096n,
      fileCount: 0,
      freeBytes: 128n * 1_024n ** 3n,
      freeInodes: 1_000_000n,
      incomingCount: 0,
      objectCount: 0,
      taskInodes: 0n,
    };
  }

  // expose the fixed path-free archive identity
  async initialize() {
    return { rootKind: ADJUSTMENT_ARCHIVE_ROOT_KIND };
  }

  // describe one immutable object
  async describe(fileName) {
    const bytes = this.objects.get(fileName);
    return bytes === undefined ? null : { size: bytes.length };
  }

  // publish one object without replacement
  async publishExclusive(fileName, bytes) {
    const existing = this.objects.get(fileName);
    // reject a content-address collision
    if (existing !== undefined && !existing.equals(bytes)) {
      throw new Error("object collision");
    }
    // reuse exact bytes on retry
    if (existing !== undefined) {
      return { created: false };
    }
    this.objects.set(fileName, Buffer.from(bytes));
    this.capacity.objectCount += 1;
    this.capacity.fileCount += 1;
    this.capacity.taskInodes += 1n;
    this.capacity.allocatedBytes += BigInt(Math.ceil(bytes.length / 4_096) * 4_096);
    return { created: true };
  }

  // open one bounded random-access object
  async openObject(fileName) {
    const bytes = this.objects.get(fileName);
    // reject an unknown archive object
    if (bytes === undefined) {
      throw Object.assign(new Error("missing object"), { code: "ENOENT" });
    }
    return {
      size: bytes.length,
      // return only the requested object range
      read: async (offset, length) => bytes.subarray(offset, offset + length),
      // retain the production reader lifecycle
      close: async () => undefined,
    };
  }

  // return a fresh capacity value
  async measure() {
    return structuredClone(this.capacity);
  }

  // rotate the current and previous graph heads
  async writePointer(prefix, contents) {
    const current = this.pointers.get(`${prefix}.current`);
    // retain only an existing prior head
    if (current !== undefined) {
      this.pointers.set(`${prefix}.previous`, current);
    }
    this.pointers.set(`${prefix}.current`, contents);
  }

  // return one exact current graph identity
  readCurrent() {
    return this.pointers.get("head.current")?.trim() ?? null;
  }
}

// retain one raw pack and one sanitized atomic checkpoint
class MemoryOpenCycleStore {
  constructor() {
    this.payloadBytes = Buffer.alloc(0);
    this.metadataBytes = Buffer.alloc(0);
  }

  // report the exact current raw length
  async payloadSize() {
    return this.payloadBytes.length;
  }

  // return one exact bounded raw range
  async readPayload(offset, length) {
    return Buffer.from(this.payloadBytes.subarray(offset, offset + length));
  }

  // return one exact sanitized checkpoint
  async readMetadata() {
    return Buffer.from(this.metadataBytes);
  }

  // append one raw page
  async appendPayload(bytes) {
    this.payloadBytes = Buffer.concat([this.payloadBytes, bytes]);
  }

  // atomically replace one sanitized checkpoint
  async writeMetadata(bytes) {
    this.metadataBytes = Buffer.from(bytes);
  }

  // remove only an incomplete raw suffix
  async truncatePayload(length) {
    this.payloadBytes = this.payloadBytes.subarray(0, length);
  }

  // remove the sealed incoming representation
  async remove() {
    this.payloadBytes = Buffer.alloc(0);
    this.metadataBytes = Buffer.alloc(0);
  }
}

// retain the archive lease state needed for crash reconciliation
class MemoryJournal {
  constructor() {
    this.active = null;
    this.acquisitions = 0;
    this.releases = 0;
  }

  // expose one path-free lease projection
  async status() {
    return { activeLeases: this.active === null ? [] : [this.active] };
  }

  // acquire or reuse one exact transfer lease
  async acquireLease(input) {
    this.acquisitions += 1;
    // require retry identity stability
    if (this.active !== null) {
      assert.equal(this.active.dueKey, input.dueKey);
      assert.equal(this.active.runId, input.runId);
      return this.active;
    }
    this.active = {
      dueKey: input.dueKey,
      expiresAt: new Date(Date.parse(input.now) + 60 * 60 * 1_000).toISOString(),
      runId: input.runId,
      scope: input.scope,
    };
    return this.active;
  }

  // release only the live transfer lease
  async releaseLease(input) {
    assert.equal(this.active?.dueKey, input.dueKey);
    assert.equal(this.active?.runId, input.runId);
    this.releases += 1;
    this.active = null;
    return { status: "released" };
  }

  // close one expired lease after immutable reconciliation
  async reconcileExpiredLease(input) {
    assert.equal(this.active?.dueKey, input.dueKey);
    this.active = null;
    return { resolution: input.resolution, status: "reconciled" };
  }
}

// create one existing-protocol page and final manifest
async function createTransferFixture() {
  let persistedPage;
  let state = createCyclePageState({
    dailyPageCount: 0,
    dueKey: "capture/2026-10-08T06:35:00.000Z",
    generation: "1",
    localDate: "2026-10-08",
  });
  const payload = Buffer.from('{"contractVersion":"fixture/v1"}\n');
  state = await appendCyclePage(state, {
    payload,
    projections: [{ channel: "scheduler_request", identitySha256: HASH_A }],
  }, {
    // capture the exact durable page envelope
    persistPage: async (page) => {
      persistedPage = page;
      return { fsynced: true, pageSha256: page.pageSha256 };
    },
  });
  const page = {
    contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
    kind: "page",
    header: persistedPage.header,
    pageSha256: persistedPage.pageSha256,
    projections: persistedPage.projections,
    payloadBase64: persistedPage.payload.toString("base64"),
  };
  state = await ackCyclePage(state, {
    acknowledgedAt: "2026-10-08T06:41:00.000Z",
    pageSha256: page.pageSha256,
  }, {
    // retain the acknowledgement identity in the remote state
    persistAcknowledgement: async (value) => ({
      acknowledgementSha256: value.acknowledgementSha256,
      fsynced: true,
    }),
  });
  const finalized = await finalizeCyclePages(state, {
    finalizedAt: "2026-10-08T06:42:00.000Z",
  }, {
    // retain the exact finalized manifest identity
    persistFinalManifest: async (value) => ({
      fsynced: true,
      manifestSha256: value.manifestSha256,
    }),
  });
  const final = {
    contractVersion: ADJUSTMENT_ARCHIVE_TRANSFER_VERSION,
    kind: "final",
    manifest: finalized.manifest,
    manifestSha256: finalized.manifestSha256,
  };
  return { final, page, payload };
}

// construct a real archive over the in-memory storage port
async function createArchiveFixture() {
  const store = new MemoryArchiveStore();
  const validators = new Map([[
    "adjustment-cycle-capsule/v2",
    createAdjustmentCycleCapsuleValidator(),
  ]]);
  const archive = createPlaintextArchive({ memberValidators: validators, store });
  await archive.initialize();
  return { archive, store };
}

// provide ample deterministic capacity to the real edge disk port
function healthyEdgeStatfs() {
  return {
    bavail: 2_050_711_552n / 4_096n,
    bsize: 4_096n,
    ffree: 100_000n,
  };
}

// run exactly one transfer attempt
async function consumeOnce({ archive, journal, openCycle, store, transport }) {
  return await consumeAdjustmentArchiveTransfers({
    archive,
    clock: () => new Date("2026-10-08T06:43:00.000Z"),
    journal,
    maximumIterations: 1,
    openCycle,
    readHead: async () => store.readCurrent(),
    signal: new AbortController().signal,
    sleep: async () => undefined,
    transport,
  });
}

test("transfer parser requires canonical bounded page and real final contracts", async () => {
  const fixture = await createTransferFixture();
  const pageBytes = Buffer.from(JSON.stringify(fixture.page) + "\n");
  assert.throws(() => parseAdjustmentArchiveTransfer(pageBytes), /canonical/u);
  const page = parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.page));
  assert.equal(page.kind, "page");
  assert.ok(page.payload.length <= 256 * 1_024);

  const finalBytes = Buffer.from(JSON.stringify(fixture.final) + "\n");
  assert.throws(() => parseAdjustmentArchiveTransfer(finalBytes), /canonical/u);
  const malformed = { ...fixture.final, manifestSha256: HASH_B };
  assert.throws(
    () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(malformed)),
    /canonical|manifest/u,
  );
  assert.throws(() => parseAdjustmentArchiveTransfer(Buffer.alloc(1_048_577, "x")), /size/u);
});

test("page ack follows one fsynced checkpoint and creates no committed archive object", async () => {
  const fixture = await createTransferFixture();
  const { archive, store } = await createArchiveFixture();
  const journal = new MemoryJournal();
  const openCycle = createOpenCycleCheckpoint({ store: new MemoryOpenCycleStore() });
  let acknowledgedCheckpoint = null;

  await consumeOnce({
    archive,
    journal,
    openCycle,
    store,
    transport: {
      next: async () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.page)),
      // observe the verified local checkpoint before remote acknowledgement
      ackPage: async (pageSha256, checkpointSha256) => {
        const status = await openCycle.inspect();
        assert.equal(status.pages.at(-1).pageSha256, pageSha256);
        assert.equal(status.checkpointSha256, checkpointSha256);
        acknowledgedCheckpoint = checkpointSha256;
      },
      ackFinal: async () => assert.fail("page used final ack"),
    },
  });

  assert.match(acknowledgedCheckpoint, /^[a-f0-9]{64}$/u);
  assert.equal(store.objects.size, 0);
  assert.equal(store.readCurrent(), null);
  assert.equal(journal.releases, 1);
});

test("page retry reuses the exact checkpoint after acknowledgement transport loss", async () => {
  const fixture = await createTransferFixture();
  const { archive, store } = await createArchiveFixture();
  const journal = new MemoryJournal();
  const openStore = new MemoryOpenCycleStore();
  let openCycle = createOpenCycleCheckpoint({ store: openStore });
  let failAck = true;
  const checkpoints = [];
  const transport = {
    next: async () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.page)),
    // fail only the first exact checkpoint acknowledgement
    ackPage: async (_pageSha256, checkpointSha256) => {
      checkpoints.push(checkpointSha256);
      // inject one transport loss after local fsync
      if (failAck) {
        failAck = false;
        throw new Error("injected ack loss");
      }
    },
    ackFinal: async () => assert.fail("page used final ack"),
  };

  await assert.rejects(consumeOnce({ archive, journal, openCycle, store, transport }), /ack loss/u);
  const durablePayload = Buffer.from(openStore.payloadBytes);
  const durableMetadata = Buffer.from(openStore.metadataBytes);
  openCycle = createOpenCycleCheckpoint({ store: openStore });
  await consumeOnce({ archive, journal, openCycle, store, transport });
  assert.deepEqual(openStore.payloadBytes, durablePayload);
  assert.deepEqual(openStore.metadataBytes, durableMetadata);
  assert.equal(checkpoints[0], checkpoints[1]);
  assert.equal(store.objects.size, 0);
});

test("real final manifest seals one capsule and graph before final ack", async () => {
  const fixture = await createTransferFixture();
  const { archive, store } = await createArchiveFixture();
  const journal = new MemoryJournal();
  const openStore = new MemoryOpenCycleStore();
  const openCycle = createOpenCycleCheckpoint({ store: openStore });
  const page = parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.page));
  await openCycle.append(page);
  let finalAck = null;

  await consumeOnce({
    archive,
    journal,
    openCycle,
    store,
    transport: {
      next: async () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.final)),
      ackPage: async () => assert.fail("final used page ack"),
      // require the fully verified current graph before final acknowledgement
      ackFinal: async (manifestSha256, graphSha256) => {
        assert.equal(store.readCurrent(), graphSha256);
        const verified = await archive.verifyFullGraph(graphSha256);
        assert.equal(verified.manifest.entries[0].identitySha256, manifestSha256);
        finalAck = { graphSha256, manifestSha256 };
      },
    },
  });

  assert.deepEqual(finalAck?.manifestSha256, fixture.final.manifestSha256);
  assert.equal(store.objects.size, 2);
  assert.equal(openStore.payloadBytes.length, 0);
  assert.equal(openStore.metadataBytes.length, 0);
  assert.equal(journal.releases, 1);
});

test("final acknowledgement retry reuses the headed graph and retained incoming pack", async () => {
  const fixture = await createTransferFixture();
  const { archive, store } = await createArchiveFixture();
  const journal = new MemoryJournal();
  const openStore = new MemoryOpenCycleStore();
  let openCycle = createOpenCycleCheckpoint({ store: openStore });
  const page = parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.page));
  await openCycle.append(page);
  let failAck = true;
  const graphs = [];
  const transport = {
    next: async () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(fixture.final)),
    ackPage: async () => assert.fail("final used page ack"),
    // retain the same remote final until its exact graph acknowledgement
    ackFinal: async (_manifestSha256, graphSha256) => {
      graphs.push(graphSha256);
      // fail only the first remote final acknowledgement
      if (failAck) {
        failAck = false;
        throw new Error("injected final ack loss");
      }
    },
  };

  await assert.rejects(consumeOnce({ archive, journal, openCycle, store, transport }), /ack loss/u);
  const durablePack = Buffer.from(openStore.payloadBytes);
  assert.equal(store.objects.size, 2);
  openCycle = createOpenCycleCheckpoint({ store: openStore });
  await consumeOnce({ archive, journal, openCycle, store, transport });
  assert.equal(graphs[0], graphs[1]);
  assert.equal(store.objects.size, 2);
  assert.ok(durablePack.length > 0);
  assert.equal(openStore.payloadBytes.length, 0);
  assert.equal(openStore.metadataBytes.length, 0);
});

test("real edge restart seals nineteen maximum pages before final acknowledgement", async () => {
  const edgeRoot = await mkdtemp(join(tmpdir(), "weather-adjustment-archive-edge-"));
  const { archive, store } = await createArchiveFixture();
  const journal = new MemoryJournal();
  const openStore = new MemoryOpenCycleStore();
  let openCycle = createOpenCycleCheckpoint({ store: openStore });
  const acknowledgements = [];
  const edgeNow = new Date("2026-10-08T12:40:00.000Z");
  const edgePorts = await new AdjustmentCyclePageDiskPorts({
    now: () => edgeNow,
    root: edgeRoot,
    statfs: async () => healthyEdgeStatfs(),
  }).initialize();
  let edge = await new AdjustmentEvidenceArchiveTransport({
    now: () => edgeNow,
    root: edgeRoot,
    statfs: async () => healthyEdgeStatfs(),
  }).initialize();
  let state = createCyclePageState({
    dailyPageCount: 0,
    dueKey: "capture/2026-10-08T12:35:00.000Z",
    generation: "2",
    localDate: "2026-10-08",
  });

  try {
    // persist and consume eighteen full pages plus one 224-kib tail
    for (let index = 0; index < 19; index += 1) {
      const payloadLength = index === 18 ? 224 * 1_024 : 256 * 1_024;
      state = await appendCyclePage(state, {
        payload: Buffer.alloc(payloadLength, index + 1),
        projections: [{
          channel: "organic",
          identitySha256: (index + 1).toString(16).padStart(64, "0"),
        }],
      }, edgePorts);
      await consumeOnce({
        archive,
        journal,
        openCycle,
        store,
        transport: {
          next: async () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(await edge.next())),
          // route the workstation receipt through the actual edge acknowledgement
          ackPage: async (pageSha256, checkpointSha256) => {
            const receipt = await edge.acknowledge(pageSha256, checkpointSha256);
            acknowledgements.push({ checkpointSha256, pageSha256 });
            state = await ackCyclePage(state, {
              acknowledgedAt: receipt.acknowledgedAt,
              pageSha256,
            }, {
              // mirror the already durable edge acknowledgement into pure state
              persistAcknowledgement: async (value) => ({
                acknowledgementSha256: value.acknowledgementSha256,
                fsynced: true,
              }),
            });
          },
          ackFinal: async () => assert.fail("page used final ack"),
        },
      });
    }
    assert.equal(acknowledgements.length, 19);
    assert.equal(openStore.payloadBytes.length, 4_832 * 1_024);
    assert.equal(store.objects.size, 0);
    const finalized = await finalizeCyclePages(state, {
      finalizedAt: "2026-10-08T12:45:00.000Z",
    }, edgePorts);
    let finalAck;

    // restart both boundaries before consuming the genuine persisted final
    edge = await new AdjustmentEvidenceArchiveTransport({
      now: () => new Date("2026-10-08T12:46:00.000Z"),
      root: edgeRoot,
      statfs: async () => healthyEdgeStatfs(),
    }).initialize();
    openCycle = createOpenCycleCheckpoint({ store: openStore });
    await consumeOnce({
      archive,
      journal,
      openCycle,
      store,
      transport: {
        next: async () => parseAdjustmentArchiveTransfer(canonicalJsonBytes(await edge.next())),
        ackPage: async () => assert.fail("final used page ack"),
        // verify the graph before the actual edge final acknowledgement
        ackFinal: async (manifestSha256, graphSha256) => {
          const verified = await archive.verifyFullGraph(graphSha256);
          assert.equal(verified.predecessorCount, 0);
          assert.equal(verified.manifest.entries[0].identitySha256, manifestSha256);
          await edge.acknowledgeFinal(manifestSha256, graphSha256);
          finalAck = { graphSha256, manifestSha256 };
        },
      },
    });
    assert.equal(finalAck.manifestSha256, finalized.manifestSha256);
    assert.equal(store.objects.size, 2);
    assert.equal(store.capacity.objectCount, 2);
    assert.equal(store.capacity.fileCount, 2);
    assert.equal(store.capacity.taskInodes, 2n);
    const capsuleValidator = createAdjustmentCycleCapsuleValidator();
    const validators = new Map([[
      ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
      capsuleValidator,
    ]]);
    const framedMembers = [...store.objects.values()].map(
      // inspect both actually charged immutable archive objects
      (bytes) => ({ bytes, inspected: inspectCasPack(bytes, { validators }) }),
    );
    const kinds = framedMembers.map(
      // retain each single-member framing identity
      ({ inspected }) => inspected.members[0].kind,
    ).sort();
    const capsuleMember = framedMembers.find(
      // select the finalized payload capsule rather than its graph
      ({ inspected }) =>
        inspected.members[0].kind === ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
    ).inspected.members[0];
    const graphMember = framedMembers.find(
      // select the separate verification graph
      ({ inspected }) =>
        inspected.members[0].kind === ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION,
    ).inspected.members[0];
    const chargedBytes = framedMembers.reduce(
      // reproduce the store's exact allocated-block charging
      (total, { bytes }) => total + BigInt(Math.ceil(bytes.length / 4_096) * 4_096),
      0n,
    );
    assert.deepEqual(kinds, [
      ADJUSTMENT_CYCLE_CAPSULE_CONTRACT_VERSION,
      ADJUSTMENT_GRAPH_MANIFEST_CONTRACT_VERSION,
    ]);
    assert.equal(
      capsuleMember.memberLength,
      16 + canonicalJsonBytes(finalized.manifest).length + ADJUSTMENT_CYCLE_MAXIMUM_PAYLOAD_BYTES,
    );
    assert.ok(capsuleMember.memberLength <= capsuleValidator.maximumBytes);
    assert.ok(graphMember.memberLength <= 256 * 1_024);
    assert.equal(store.capacity.allocatedBytes, chargedBytes);
    assert.ok(chargedBytes < ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES);
    // keep the unchanged byte ceiling stricter than an all-maximum count envelope
    assert.ok(
      chargedBytes * BigInt(ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS) >
        ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES,
    );
    assert.equal(kinds.includes(ADJUSTMENT_ARCHIVE_TRANSFER_VERSION), false);
    assert.equal(store.readCurrent(), finalAck.graphSha256);
    assert.equal(openStore.payloadBytes.length, 0);
    assert.equal(openStore.metadataBytes.length, 0);
    assert.equal((await edge.next()).kind, "idle");
  } finally {
    await rm(edgeRoot, { force: true, recursive: true });
  }
});

test("idle transfer performs one bounded fifteen-second poll", async () => {
  const { archive, store } = await createArchiveFixture();
  const journal = new MemoryJournal();
  const openCycle = createOpenCycleCheckpoint({ store: new MemoryOpenCycleStore() });
  const sleeps = [];
  const idle = parseAdjustmentArchiveTransfer(Buffer.from(
    '{"contractVersion":"adjustment-archive-transfer/v1","kind":"idle"}\n',
  ));

  await consumeAdjustmentArchiveTransfers({
    archive,
    clock: () => new Date("2026-10-08T06:43:00.000Z"),
    journal,
    maximumIterations: 1,
    openCycle,
    readHead: async () => store.readCurrent(),
    signal: new AbortController().signal,
    // record the bounded idle interval
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    transport: {
      next: async () => idle,
      ackPage: async () => assert.fail("idle page ack"),
      ackFinal: async () => assert.fail("idle final ack"),
    },
  });

  assert.deepEqual(sleeps, [15_000]);
  assert.equal(store.objects.size, 0);
});

// create one closed fake child process
function fakeChild(stdoutBytes, stderrBytes = Buffer.alloc(0), exitCode = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  queueMicrotask(
    // emit bounded child output before exit
    () => {
      child.stdout.end(stdoutBytes);
      child.stderr.end(stderrBytes);
      child.emit("close", exitCode, null);
    },
  );
  return child;
}

test("ssh transport exposes only next, page ack and final ack fixed grammars", async () => {
  const idle = Buffer.from(
    '{"contractVersion":"adjustment-archive-transfer/v1","kind":"idle"}\n',
  );
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ args, file, options });
    return fakeChild(args.at(-1) === "adjustment-archive-next" ? idle : Buffer.alloc(0));
  };

  await executeAdjustmentArchiveSshVerb("next", [], { spawnImpl });
  await executeAdjustmentArchiveSshVerb("page_ack", [HASH_A, HASH_B], { spawnImpl });
  await executeAdjustmentArchiveSshVerb("final_ack", [HASH_A, HASH_B], { spawnImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].file, "/usr/bin/ssh");
  assert.deepEqual(calls[0].args.slice(-2), ["weather-pi", "adjustment-archive-next"]);
  assert.deepEqual(calls[1].args.slice(-4), ["weather-pi", "adjustment-archive-ack", HASH_A, HASH_B]);
  assert.deepEqual(calls[2].args.slice(-4), ["weather-pi", "adjustment-archive-ack-final", HASH_A, HASH_B]);
  assert.equal(calls[0].options.shell, false);
  await assert.rejects(
    executeAdjustmentArchiveSshVerb("shell", [], { spawnImpl }),
    /verb/u,
  );
});

test("ssh transport refuses stdout beyond one mib and hashes private stderr", async () => {
  const spawnImpl = () => fakeChild(
    Buffer.alloc(1_048_577, "x"),
    Buffer.from("private remote diagnostic"),
    1,
  );
  await assert.rejects(
    executeAdjustmentArchiveSshVerb("next", [], { spawnImpl }),
    (error) => error.code === "transport_output_refused" &&
      !error.message.includes("private remote diagnostic") &&
      /^[a-f0-9]{64}$/u.test(error.stderrSha256),
  );
});

test("poll and transport cancellation retain no abort listeners or child", async () => {
  const controller = new AbortController();
  // prove normal repeated polls remove every once-listener
  for (let index = 0; index < 100; index += 1) {
    await waitForAdjustmentArchivePoll(0, controller.signal);
  }
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const pending = waitForAdjustmentArchivePoll(15_000, controller.signal);
  controller.abort();
  await pending;
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  let spawned = false;
  await assert.rejects(
    executeAdjustmentArchiveSshVerb("next", [], {
      signal: controller.signal,
      spawnImpl: () => {
        spawned = true;
        return fakeChild(Buffer.alloc(0));
      },
    }),
    (error) => error.code === "transport_aborted",
  );
  assert.equal(spawned, false);
});

test("absent genesis is admitted prospectively without filesystem mutation", async () => {
  const fixture = await createGenesisFixture();

  // remove only the isolated fixture after inspection
  try {
    const before = await readdir(fixture.weatherRoot);
    const inspected = await adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
      archiveRoot: fixture.archiveRoot,
      capacity: genesisCapacity(),
      homeRoot: fixture.homeRoot,
    });
    const after = await readdir(fixture.weatherRoot);

    assert.deepEqual(before, []);
    assert.deepEqual(after, before);
    assert.equal(inspected.initializationDirectories, 5);
    assert.equal(inspected.initializationAllocatedBytes, 6n * GENESIS_BLOCK_BYTES);
    assert.equal(inspected.initializationAtomicAllocatedBytes, GENESIS_BLOCK_BYTES);
    assert.equal(inspected.initializationAtomicInodes, 1n);
    assert.equal(inspected.initializationLockFiles, 2);
    assert.equal(inspected.initializationInodes, 8n);
    assert.equal(inspected.objectCount, 0);
    // retain the absent archive root after readonly admission
    await assert.rejects(lstat(fixture.archiveRoot), (error) => error?.code === "ENOENT");
  } finally {
    await rm(fixture.fixtureRoot, { force: true, recursive: true });
  }
});

test("empty interrupted archive initialization remains prospectively admissible", async () => {
  const fixture = await createGenesisFixture();

  // remove only the isolated fixture after inspection
  try {
    await mkdir(fixture.archiveRoot, { mode: 0o700, recursive: true });
    const inspected = await adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
      archiveRoot: fixture.archiveRoot,
      capacity: genesisCapacity(),
      homeRoot: fixture.homeRoot,
    });

    assert.equal(inspected.initializationDirectories, 2);
    assert.equal(inspected.initializationAllocatedBytes, 3n * GENESIS_BLOCK_BYTES);
    assert.equal(inspected.initializationAtomicAllocatedBytes, GENESIS_BLOCK_BYTES);
    assert.equal(inspected.initializationLockFiles, 2);
    assert.equal(inspected.initializationInodes, 5n);
    assert.deepEqual(await readdir(fixture.archiveRoot), []);
  } finally {
    await rm(fixture.fixtureRoot, { force: true, recursive: true });
  }
});

test("existing genesis state still charges the atomic journal-head peak", async () => {
  const fixture = await createGenesisFixture();
  const stateRoot = join(
    fixture.weatherRoot,
    "adjustment-maintenance",
    "v2",
    "state",
  );
  const headBytes = Buffer.from('{"generation":"0","recordSha256":null}\n');

  // remove only the isolated fixture after inspection
  try {
    await mkdir(stateRoot, { mode: 0o700, recursive: true });
    await writeFile(join(stateRoot, "archive-job.lock"), Buffer.alloc(0), { mode: 0o600 });
    await writeFile(join(stateRoot, "journal.lock"), Buffer.alloc(0), { mode: 0o600 });
    await writeFile(join(stateRoot, "head.current"), headBytes, { mode: 0o600 });
    const inspected = await adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
      archiveRoot: fixture.archiveRoot,
      capacity: genesisCapacity(),
      homeRoot: fixture.homeRoot,
    });

    assert.equal(inspected.initializationDirectories, 2);
    assert.equal(inspected.initializationAllocatedBytes, 3n * GENESIS_BLOCK_BYTES);
    assert.equal(inspected.initializationAtomicAllocatedBytes, GENESIS_BLOCK_BYTES);
    assert.equal(inspected.initializationAtomicInodes, 1n);
    assert.equal(inspected.initializationLockFiles, 0);
    assert.equal(inspected.initializationInodes, 3n);
    assert.deepEqual(await readFile(join(stateRoot, "head.current")), headBytes);
  } finally {
    await rm(fixture.fixtureRoot, { force: true, recursive: true });
  }
});

test("partial archive history is not admitted as empty genesis", async () => {
  const fixture = await createGenesisFixture();

  // remove only the isolated fixture after inspection
  try {
    const objectRoot = join(fixture.archiveRoot, "objects");
    await mkdir(objectRoot, { mode: 0o700, recursive: true });
    await writeFile(join(objectRoot, `sha256-${HASH_A}.obj`), Buffer.from("partial"), {
      mode: 0o600,
    });

    // reject committed bytes without a current graph head
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: fixture.archiveRoot,
        capacity: genesisCapacity(),
        homeRoot: fixture.homeRoot,
      }),
      /history is incomplete/u,
    );
  } finally {
    await rm(fixture.fixtureRoot, { force: true, recursive: true });
  }
});

test("broad or linked archive ancestors remain refused", async () => {
  const broad = await createGenesisFixture();
  const linked = await createGenesisFixture();

  // remove both isolated fixtures after negative inspections
  try {
    const broadAncestor = join(broad.weatherRoot, "adjustment-maintenance");
    await mkdir(broadAncestor, { mode: 0o700 });
    await chmod(broadAncestor, 0o755);
    // reject a group-readable private ancestor
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: broad.archiveRoot,
        capacity: genesisCapacity(),
        homeRoot: broad.homeRoot,
      }),
      /ancestor is invalid/u,
    );

    const linkedParent = join(linked.weatherRoot, "adjustment-maintenance", "v2");
    const linkedTarget = join(linked.fixtureRoot, "linked-target");
    await mkdir(linkedParent, { mode: 0o700, recursive: true });
    await mkdir(linkedTarget, { mode: 0o700 });
    await symlink(linkedTarget, linked.archiveRoot);
    // reject a linked archive root
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: linked.archiveRoot,
        capacity: genesisCapacity(),
        homeRoot: linked.homeRoot,
      }),
      /ancestor is invalid/u,
    );
  } finally {
    await rm(broad.fixtureRoot, { force: true, recursive: true });
    await rm(linked.fixtureRoot, { force: true, recursive: true });
  }
});

test("genesis admission preserves exact byte and inode floors", async () => {
  const fixture = await createGenesisFixture();
  const initializationBytes = 6n * GENESIS_BLOCK_BYTES;
  const initializationInodes = 8n;
  const exactCapacity = genesisCapacity({
    backing: {
      allocatedBytes: 64n * GIBIBYTE - initializationBytes,
      freeBytes: 16n * GIBIBYTE + initializationBytes,
      freeInodes: 32_768n + initializationInodes,
    },
    ext4FreeBytes: 16n * GIBIBYTE + initializationBytes,
    ext4FreeInodes: 32_768n + initializationInodes,
  });

  // remove only the isolated fixture after boundary inspection
  try {
    const exact = await adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
      archiveRoot: fixture.archiveRoot,
      capacity: exactCapacity,
      homeRoot: fixture.homeRoot,
    });
    assert.equal(exact.initializationAllocatedBytes, initializationBytes);

    // refuse one ext4 byte below the post-initialization floor
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: fixture.archiveRoot,
        capacity: genesisCapacity({
          ...exactCapacity,
          ext4FreeBytes: exactCapacity.ext4FreeBytes - 1n,
        }),
        homeRoot: fixture.homeRoot,
      }),
      (error) => error?.reason === "archive_genesis_capacity_refused",
    );
    // refuse one ext4 inode below the post-initialization floor
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: fixture.archiveRoot,
        capacity: genesisCapacity({
          ...exactCapacity,
          ext4FreeInodes: exactCapacity.ext4FreeInodes - 1n,
        }),
        homeRoot: fixture.homeRoot,
      }),
      (error) => error?.reason === "archive_genesis_capacity_refused",
    );
    // refuse one aggregate byte beyond the reviewed total ceiling
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: fixture.archiveRoot,
        capacity: genesisCapacity({
          ...exactCapacity,
          backing: {
            ...exactCapacity.backing,
            allocatedBytes: exactCapacity.backing.allocatedBytes + 1n,
          },
        }),
        homeRoot: fixture.homeRoot,
      }),
      (error) => error?.reason === "archive_genesis_capacity_refused",
    );
    // refuse one backing byte below the post-initialization floor
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: fixture.archiveRoot,
        capacity: genesisCapacity({
          ...exactCapacity,
          backing: {
            ...exactCapacity.backing,
            freeBytes: exactCapacity.backing.freeBytes - 1n,
          },
        }),
        homeRoot: fixture.homeRoot,
      }),
      (error) => error?.reason === "archive_genesis_capacity_refused",
    );
    // refuse one backing inode below the post-initialization floor
    await assert.rejects(
      adjustmentArchiveJobTestOnly.inspectArchiveEnvelope({
        archiveRoot: fixture.archiveRoot,
        capacity: genesisCapacity({
          ...exactCapacity,
          backing: {
            ...exactCapacity.backing,
            freeInodes: exactCapacity.backing.freeInodes - 1n,
          },
        }),
        homeRoot: fixture.homeRoot,
      }),
      (error) => error?.reason === "archive_genesis_capacity_refused",
    );
  } finally {
    await rm(fixture.fixtureRoot, { force: true, recursive: true });
  }
});

test("ext4-only capacity output cannot impersonate backing c evidence", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "weather-backing-c-framing-"));
  // isolate response framing from the production-only native home admission
  try {
    const home = await lstat(fixtureRoot, { bigint: true });
    const ext4Only = Buffer.from(JSON.stringify({
      freeBytes: (64n * 1_024n ** 3n).toString(),
      rootKind: "home_native_ext4_primary",
    }));
    const outputs = [Buffer.from(`${home.dev}|${home.ino}\n`), ext4Only];
    await assert.rejects(
      adjustmentArchiveJobTestOnly.measureBackingCCapacity(
        // satisfy only the injected identity before substituting ext4 data
        () => fakeChild(outputs.shift()),
        home,
      ),
      /backing_c_probe_invalid/u,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

// unsupported runner homes must not receive physical workstation authority
test("backing capacity rejects a non-workstation home before spawning", {
  skip: homedir() === "/home/ubuntu" ? "requires a non-workstation home" : false,
}, async () => {
  let spawned = 0;
  await assert.rejects(
    measureAdjustmentArchiveBackingCapacity({
      // detect any unauthorized probe before native admission
      spawnImpl: () => {
        spawned += 1;
        throw new Error("unexpected backing probe");
      },
    }),
    /archive backing filesystem is invalid/u,
  );
  assert.equal(spawned, 0);
});

test("legacy census counts a symlink inode without following its target", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "weather-adjustment-census-"));
  const censusRoot = join(fixtureRoot, "legacy");
  const outsideRoot = join(fixtureRoot, "outside");

  // isolate and remove every census fixture byte
  try {
    await mkdir(censusRoot, { mode: 0o700 });
    await mkdir(outsideRoot, { mode: 0o700 });
    await writeFile(join(censusRoot, "retained.bin"), Buffer.from("retained"), { mode: 0o600 });
    await writeFile(join(outsideRoot, "must-not-count.bin"), Buffer.alloc(64 * 1_024), {
      mode: 0o600,
    });
    await symlink(outsideRoot, join(censusRoot, "legacy-link"));
    const rootDetails = await lstat(censusRoot, { bigint: true });
    const result = await measureImmutableLegacyCensus([censusRoot], rootDetails.dev);

    assert.equal(result.entryCount, 3);
    assert.ok(result.allocatedBytes >= 0n);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("reviewed counts are ready while the remote gate stays closed", async () => {
  const module = await import("./adjustment_archive_job.mjs");
  assert.equal(module.ADJUSTMENT_ARCHIVE_COUNT_CONTRACT_READY, true);
  assert.equal(module.ADJUSTMENT_ARCHIVE_REMOTE_GATE_READY, false);
});
