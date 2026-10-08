import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ADJUSTMENT_ACTIVE_BUCKET_CEILING_BYTES,
  ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES,
  ADJUSTMENT_ARCHIVE_ROOT_KIND,
  ADJUSTMENT_CATALOG_STATE_CEILING_BYTES,
  ADJUSTMENT_CATALOG_ENTRY_BYTES,
  ADJUSTMENT_EXISTING_CENSUS_BYTES,
  ADJUSTMENT_FREE_SPACE_FLOOR_BYTES,
  ADJUSTMENT_MAXIMUM_ARCHIVE_FILES,
  ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES,
  ADJUSTMENT_MAXIMUM_CATALOG_SHARDS,
  ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS,
  ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES,
  ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES,
  ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES,
  ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS,
  ADJUSTMENT_MAXIMUM_STAGING_FILES,
  ADJUSTMENT_MAXIMUM_TASK_INODES,
  ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS,
  ADJUSTMENT_PRIMARY_GROWTH_BYTES,
  ADJUSTMENT_RELEASE_CONTROL_CEILING_BYTES,
  ADJUSTMENT_RESERVED_UNUSABLE_BYTES,
  ADJUSTMENT_STAGING_CEILING_BYTES,
  ADJUSTMENT_STREAM_BUFFER_BYTES,
  ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES,
  ADJUSTMENT_UNASSIGNED_HEADROOM_BYTES,
  adjustmentSha256,
  buildGraphManifest,
  canonicalJsonBytes,
  createPlaintextArchive,
  encodeCasPack,
  encodeCatalogEntry,
  encodeCatalogShard,
  inspectCatalogShard,
  inspectCasPack,
} from "./adjustment_plaintext_archive.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// provide one closed test-member validator
function createValidator(maximumBytes = 2 * 1_024 * 1_024) {
  // validate one exact test payload prefix
  const validator = (payload) => {
    assert.ok(Buffer.isBuffer(payload));
    assert.match(payload.subarray(0, Math.min(payload.length, 8)).toString("ascii"), /^(?:alpha|beta|x*)/u);
  };
  validator.maximumBytes = maximumBytes;
  return validator;
}

// provide one streaming prefix validator
function createStreamingValidator(maximumBytes = 2 * 1_024 * 1_024) {
  const validator = createValidator(maximumBytes);
  validator.createStream = () => {
    let byteLength = 0;
    let prefix = "";

    return {
      // retain only the bounded validation prefix
      write(chunk) {
        byteLength += chunk.length;

        // decode at most the first eight ascii bytes
        if (prefix.length < 8) {
          prefix += chunk.subarray(0, 8 - prefix.length).toString("ascii");
        }
      },
      // validate the streamed member summary
      finish() {
        assert.ok(byteLength <= maximumBytes);
        assert.match(prefix, /^(?:alpha|beta|x*)/u);
      },
    };
  };
  return validator;
}

// hold immutable objects for injected archive tests
class MemoryArchiveStore {
  constructor() {
    this.objects = new Map();
    this.reads = [];
    this.readLengths = [];
    this.publishCalls = 0;
    this.failPublish = false;
    this.capacity = {
      allocatedBytes: 0n,
      backing: {
        allocatedBytes: 16n * 1_024n ** 3n,
        freeBytes: 64n * 1_024n ** 3n,
        freeInodes: 1_000_000n,
        rootKind: "backing_c",
      },
      blockSize: 4_096n,
      fileCount: 0,
      freeBytes: 64n * 1_024n ** 3n,
      freeInodes: 1_000_000n,
      incomingCount: 0,
      objectCount: 0,
      taskInodes: 0n,
    };
  }

  // return one path-free archive identity
  async initialize() {
    return { rootKind: ADJUSTMENT_ARCHIVE_ROOT_KIND };
  }

  // describe one stored object
  async describe(fileName) {
    const bytes = this.objects.get(fileName);
    return bytes === undefined ? null : { size: bytes.length };
  }

  // publish one immutable object or inject a crash
  async publishExclusive(fileName, bytes) {
    this.publishCalls += 1;

    // fail before any mutation when requested
    if (this.failPublish) {
      throw Object.assign(new Error("injected crash"), { code: "EIO" });
    }

    const existing = this.objects.get(fileName);

    // reject content-address collisions
    if (existing !== undefined && !existing.equals(bytes)) {
      throw new Error("collision");
    }

    // reuse exact immutable bytes
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

  // open one bounded random-access reader
  async openObject(fileName) {
    const bytes = this.objects.get(fileName);

    // reject an absent object
    if (bytes === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return {
      size: bytes.length,
      // record every bounded read
      read: async (offset, length) => {
        this.reads.push({ fileName, length, offset });
        this.readLengths.push(length);
        return bytes.subarray(offset, offset + length);
      },
      // close the memory reader
      close: async () => undefined,
    };
  }

  // return one exact capacity snapshot
  async measure() {
    return structuredClone(this.capacity);
  }

  // retain one hash-only pointer pair
  async writePointer(prefix, contents) {
    this.pointer = { contents, prefix };
  }
}

// validate canonical json through bounded read chunks
function createStreamingJsonValidator(maximumBytes, observations) {
  // validate the existing write-side buffer contract
  const validator = (payload) => {
    const value = JSON.parse(payload.toString("utf8"));
    assert.deepEqual(canonicalJsonBytes(value), payload);
  };
  validator.maximumBytes = maximumBytes;
  validator.createStream = () => {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts = [];
    let byteLength = 0;

    return {
      // consume one bounded raw chunk
      write(chunk) {
        assert.ok(Buffer.isBuffer(chunk));
        assert.ok(chunk.length <= ADJUSTMENT_STREAM_BUFFER_BYTES);
        byteLength += chunk.length;
        observations.maximumChunkBytes = Math.max(
          observations.maximumChunkBytes,
          chunk.length,
        );
        parts.push(decoder.decode(chunk, { stream: true }));
      },
      // validate only bounded decoded text state
      finish() {
        parts.push(decoder.decode());
        const text = parts.join("");
        const value = JSON.parse(text);
        assert.equal(`${JSON.stringify(value)}\n`, text);
        observations.finishedBytes.push(byteLength);
      },
    };
  };
  return validator;
}

// publish one large json member and large graph manifest
async function createLargeStreamingGraphFixture() {
  const store = new MemoryArchiveStore();
  const observations = { finishedBytes: [], maximumChunkBytes: 0 };
  const validators = new Map([
    ["large-json/v1", createStreamingJsonValidator(2 * 1_024 * 1_024, observations)],
    ["test-record/v1", createValidator()],
  ]);
  const archive = createPlaintextArchive({ memberValidators: validators, store });
  await archive.initialize();
  const payload = canonicalJsonBytes({
    contractVersion: "large-json/v1",
    padding: "x".repeat(700_000),
  });
  const members = [{
    identitySha256: adjustmentSha256(payload),
    kind: "large-json/v1",
    payload,
  }];

  // enlarge the graph with valid independently hashed members
  for (let index = 0; index < 1_200; index += 1) {
    const filler = Buffer.from(`alpha-${index}`, "ascii");
    members.push({
      identitySha256: adjustmentSha256(`filler:${index}`),
      kind: "test-record/v1",
      payload: filler,
    });
  }

  const published = await archive.publishCasObject(members);
  const largeIdentitySha256 = adjustmentSha256(payload);
  const linkedIdentitySha256 = adjustmentSha256("filler:0");
  const manifest = buildGraphManifest({
    crossLinks: [{
      fromIdentitySha256: largeIdentitySha256,
      relation: "validated_by",
      toIdentitySha256: linkedIdentitySha256,
    }],
    entries: published.members.map(
      // bind every published member to the graph
      (member) => ({
        kind: member.kind,
        identitySha256: member.identitySha256,
        objectSha256: published.objectSha256,
        memberOffset: member.memberOffset,
        memberLength: member.memberLength,
        memberSha256: member.memberSha256,
      }),
    ),
    predecessorGraphSha256: null,
  });
  assert.ok(canonicalJsonBytes(manifest).length > ADJUSTMENT_STREAM_BUFFER_BYTES);
  const graph = await archive.publishGraphManifest(manifest);
  return { archive, graph, observations, payload, store };
}

// collect one streamed restore without whole-member materialization
class CountingRestoreSink {
  constructor() {
    this.files = new Map();
  }

  // hash every bounded restore chunk
  async writeExclusive(name, chunks, expectedBytes) {
    const hash = createHash("sha256");
    let byteLength = 0;

    // consume only archive-sized chunks
    for await (const chunk of chunks) {
      assert.ok(chunk.length <= ADJUSTMENT_STREAM_BUFFER_BYTES);
      hash.update(chunk);
      byteLength += chunk.length;
    }
    assert.equal(byteLength, expectedBytes);
    this.files.set(name, { byteLength, sha256: hash.digest("hex") });
  }
}

// reject any observed raw buffer allocation above one ceiling
async function withRawBufferAllocationCeiling(maximumBytes, operation) {
  const originalAlloc = Buffer.alloc;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const originalConcat = Buffer.concat;
  const originalFrom = Buffer.from;

  // enforce direct buffer sizes
  function requireBounded(length) {
    // reject only positive whole-buffer allocations above the contract
    if (Number.isInteger(length) && length > maximumBytes) {
      throw new RangeError("raw Buffer allocation exceeds the test ceiling");
    }
  }

  Buffer.alloc = function patchedAlloc(size, ...arguments_) {
    requireBounded(size);
    return originalAlloc.call(Buffer, size, ...arguments_);
  };
  Buffer.allocUnsafe = function patchedAllocUnsafe(size) {
    requireBounded(size);
    return originalAllocUnsafe.call(Buffer, size);
  };
  Buffer.concat = function patchedConcat(list, totalLength) {
    const length = totalLength ?? list.reduce((sum, chunk) => sum + chunk.length, 0);
    requireBounded(length);
    return originalConcat.call(Buffer, list, totalLength);
  };
  Buffer.from = function patchedFrom(value, ...arguments_) {
    const length = typeof value === "string"
      ? Buffer.byteLength(value, arguments_[0])
      : value?.byteLength;
    requireBounded(length);
    return originalFrom.call(Buffer, value, ...arguments_);
  };

  try {
    return await operation();
  } finally {
    Buffer.alloc = originalAlloc;
    Buffer.allocUnsafe = originalAllocUnsafe;
    Buffer.concat = originalConcat;
    Buffer.from = originalFrom;
  }
}

// collect one streamed restore sink
class MemoryRestoreSink {
  constructor() {
    this.files = new Map();
  }

  // write one caller-named file exclusively
  async writeExclusive(name, chunks, expectedBytes) {
    assert.equal(this.files.has(name), false);
    const collected = [];

    // consume bounded restore chunks
    for await (const chunk of chunks) {
      assert.ok(chunk.length <= ADJUSTMENT_STREAM_BUFFER_BYTES);
      collected.push(chunk);
    }
    const bytes = Buffer.concat(collected);
    assert.equal(bytes.length, expectedBytes);
    this.files.set(name, bytes);
  }
}

test("CAS pack uses the exact header and canonical member order", () => {
  const validators = new Map([["test-record/v1", createValidator()]]);
  const bytes = encodeCasPack([
    { kind: "test-record/v1", identitySha256: HASH_B, payload: Buffer.from("beta") },
    { kind: "test-record/v1", identitySha256: HASH_A, payload: Buffer.from("alpha") },
  ], { validators });

  assert.equal(bytes.subarray(0, 8).toString("ascii"), "WXACAS01");
  assert.equal(bytes.readUInt32BE(8), 2);
  assert.equal(bytes.readUInt32BE(12), 0);
  const inspected = inspectCasPack(bytes, { validators });
  assert.deepEqual(inspected.members.map(
    // select canonical identity order
    (member) => member.identitySha256,
  ), [HASH_A, HASH_B]);
  assert.throws(
    // reject unknown member kinds
    () => encodeCasPack([
      { kind: "unknown/v1", identitySha256: HASH_A, payload: Buffer.from("alpha") },
    ]),
    /not registered/u,
  );
  assert.throws(
    // reject duplicate identities across kinds
    () => encodeCasPack([
      { kind: "test-record/v1", identitySha256: HASH_A, payload: Buffer.from("alpha") },
      { kind: "test-record/v1", identitySha256: HASH_A, payload: Buffer.from("beta") },
    ], { validators }),
    /duplicated/u,
  );
  assert.throws(
    // reject trailing object bytes
    () => inspectCasPack(Buffer.concat([bytes, Buffer.from([0])]), { validators }),
    /trailing/u,
  );
});

test("full graph verification and restore stream through at most 256 KiB", async () => {
  const store = new MemoryArchiveStore();
  const validators = new Map([["test-record/v1", createStreamingValidator()]]);
  const archive = createPlaintextArchive({ memberValidators: validators, store });
  await archive.initialize();
  const payload = Buffer.concat([Buffer.from("alpha"), Buffer.alloc(600_000, "x")]);
  const published = await archive.publishCasObject([{
    identitySha256: HASH_A,
    kind: "test-record/v1",
    payload,
  }]);
  const member = published.members[0];
  const manifest = buildGraphManifest({
    crossLinks: [],
    entries: [{
      kind: member.kind,
      identitySha256: member.identitySha256,
      objectSha256: published.objectSha256,
      memberOffset: member.memberOffset,
      memberLength: member.memberLength,
      memberSha256: member.memberSha256,
    }],
    predecessorGraphSha256: null,
  });
  const graph = await archive.publishGraphManifest(manifest);
  const verified = await archive.verifyFullGraph(graph.objectSha256);
  assert.equal(verified.memberCount, 1);
  assert.ok(Math.max(...store.readLengths) <= ADJUSTMENT_STREAM_BUFFER_BYTES);

  const sink = new MemoryRestoreSink();
  const restored = await archive.restoreFullGraph(graph.objectSha256, {
    sink,
    targets: [{ fileName: "selected.bin", identitySha256: HASH_A }],
  });
  assert.deepEqual(restored, { restoredBytes: String(payload.length), restoredFiles: 1 });
  assert.deepEqual(sink.files.get("selected.bin"), payload);
  await assert.rejects(
    // reject archive-controlled restore paths
    archive.restoreFullGraph(graph.objectSha256, {
      sink: new MemoryRestoreSink(),
      targets: [{ fileName: "../escape", identitySha256: HASH_A }],
    }),
    /filename/u,
  );
});

test("large json and graph reads avoid whole-member raw buffers", async () => {
  const fixture = await createLargeStreamingGraphFixture();
  fixture.store.readLengths.length = 0;
  fixture.observations.finishedBytes.length = 0;
  fixture.observations.maximumChunkBytes = 0;
  const sink = new CountingRestoreSink();

  await withRawBufferAllocationCeiling(
    ADJUSTMENT_STREAM_BUFFER_BYTES,
    // verify and restore only through bounded raw chunks
    async () => {
      const verified = await fixture.archive.verifyFullGraph(
        fixture.graph.objectSha256,
      );
      assert.equal(verified.memberCount, 1_201);
      assert.equal(verified.manifest.crossLinks.length, 1);
      const restored = await fixture.archive.restoreFullGraph(
        fixture.graph.objectSha256,
        {
          sink,
          targets: [{
            fileName: "large.json",
            identitySha256: adjustmentSha256(fixture.payload),
          }],
        },
      );
      assert.deepEqual(restored, {
        restoredBytes: String(fixture.payload.length),
        restoredFiles: 1,
      });
    },
  );

  assert.ok(Math.max(...fixture.store.readLengths) <= ADJUSTMENT_STREAM_BUFFER_BYTES);
  assert.ok(fixture.observations.maximumChunkBytes <= ADJUSTMENT_STREAM_BUFFER_BYTES);
  assert.ok(fixture.observations.finishedBytes.length >= 2);
  assert.deepEqual(sink.files.get("large.json"), {
    byteLength: fixture.payload.length,
    sha256: adjustmentSha256(fixture.payload),
  });
});

test("large members require an explicit streaming validator before payload reads", async () => {
  const store = new MemoryArchiveStore();
  const validators = new Map([["test-record/v1", createValidator()]]);
  const payload = Buffer.alloc(ADJUSTMENT_STREAM_BUFFER_BYTES + 1, "x");
  const objectBytes = encodeCasPack([{
    identitySha256: HASH_A,
    kind: "test-record/v1",
    payload,
  }], { validators });
  const objectSha256 = adjustmentSha256(objectBytes);
  const inspected = inspectCasPack(objectBytes, { validators });
  const member = inspected.members[0];
  store.objects.set(`sha256-${objectSha256}.obj`, objectBytes);
  const archive = createPlaintextArchive({ memberValidators: validators, store });
  await archive.initialize();
  const manifest = buildGraphManifest({
    crossLinks: [],
    entries: [{
      kind: member.kind,
      identitySha256: member.identitySha256,
      objectSha256,
      memberOffset: member.memberOffset,
      memberLength: member.memberLength,
      memberSha256: member.memberSha256,
    }],
    predecessorGraphSha256: null,
  });
  const graph = await archive.publishGraphManifest(manifest);
  store.reads.length = 0;

  await assert.rejects(
    // refuse buffering before reading the unsupported payload
    archive.verifyFullGraph(graph.objectSha256),
    /streaming validator/u,
  );
  assert.equal(
    store.reads.some((read) =>
      read.fileName === `sha256-${objectSha256}.obj` &&
      read.offset >= member.memberOffset),
    false,
  );
});

test("streamed graph inspection rejects malformed and truncated bytes", async () => {
  const entryIdentity = adjustmentSha256("missing-entry");
  const manifest = buildGraphManifest({
    crossLinks: [],
    entries: [{
      kind: "test-record/v1",
      identitySha256: entryIdentity,
      objectSha256: HASH_A,
      memberOffset: 64,
      memberLength: 1,
      memberSha256: HASH_B,
    }],
    predecessorGraphSha256: null,
  });
  const validBytes = encodeCasPack([{
    identitySha256: adjustmentSha256(canonicalJsonBytes(manifest)),
    kind: "adjustment-graph-manifest/v2",
    payload: canonicalJsonBytes(manifest),
  }]);
  const member = inspectCasPack(validBytes).members[0];
  const malformed = Buffer.from(validBytes);
  malformed[member.memberOffset] = 0xff;
  const truncated = validBytes.subarray(0, validBytes.length - 1);
  const store = new MemoryArchiveStore();
  const malformedSha256 = adjustmentSha256(malformed);
  const truncatedSha256 = adjustmentSha256(truncated);
  store.objects.set(`sha256-${malformedSha256}.obj`, malformed);
  store.objects.set(`sha256-${truncatedSha256}.obj`, truncated);
  const archive = createPlaintextArchive({ store });
  await archive.initialize();

  await assert.rejects(
    // reject invalid streamed utf-8 or json
    archive.verifyFullGraph(malformedSha256),
    /JSON|encoded data/u,
  );
  await assert.rejects(
    // reject declared bytes absent from the object
    archive.verifyFullGraph(truncatedSha256),
    /truncated/u,
  );
});

test("capacity refusal happens before object or pointer mutation", async () => {
  const store = new MemoryArchiveStore();
  const validators = new Map([["test-record/v1", createValidator()]]);
  const archive = createPlaintextArchive({ memberValidators: validators, store });
  await archive.initialize();

  store.capacity.objectCount = ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS - 1;
  store.capacity.fileCount = ADJUSTMENT_MAXIMUM_ARCHIVE_FILES - 2;
  store.capacity.taskInodes = BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES - 1);
  await archive.publishCasObject([{
    identitySha256: HASH_A,
    kind: "test-record/v1",
    payload: Buffer.from("alpha"),
  }]);
  assert.equal(store.capacity.objectCount, ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS);
  assert.equal(store.capacity.fileCount, ADJUSTMENT_MAXIMUM_ARCHIVE_FILES - 1);
  assert.equal(store.capacity.taskInodes, BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES));

  await assert.rejects(
    // attempt one object beyond the reviewed committed-object frontier
    archive.publishCasObject([{
      identitySha256: HASH_B,
      kind: "test-record/v1",
      payload: Buffer.from("beta"),
    }]),
    (error) => error.code === "resource_refused" && error.reason === "archive_count_refused",
  );
  assert.equal(store.publishCalls, 1);
  assert.equal(store.objects.size, 1);

  store.capacity.objectCount = 0;
  store.capacity.fileCount = 0;
  store.capacity.taskInodes = 0n;
  store.capacity.allocatedBytes = ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES;
  await assert.rejects(
    // refuse allocated bytes even when the logical object is small
    archive.publishCasObject([{
      identitySha256: HASH_B,
      kind: "test-record/v1",
      payload: Buffer.from("beta"),
    }]),
    (error) => error.reason === "archive_bytes_refused",
  );

  store.capacity.allocatedBytes = 0n;
  store.capacity.freeBytes = ADJUSTMENT_FREE_SPACE_FLOOR_BYTES;
  await assert.rejects(
    // preserve the exact 16 GiB ext4 floor after next allocation
    archive.publishCasObject([{
      identitySha256: HASH_B,
      kind: "test-record/v1",
      payload: Buffer.from("beta"),
    }]),
    (error) => error.reason === "ext4_floor_refused",
  );

  store.capacity.freeBytes = 64n * 1_024n ** 3n;
  store.capacity.backing.allocatedBytes = 64n * 1_024n ** 3n;
  await assert.rejects(
    // refuse one allocated block beyond the aggregate authorization
    archive.publishCasObject([{
      identitySha256: HASH_B,
      kind: "test-record/v1",
      payload: Buffer.from("beta"),
    }]),
    (error) => error.reason === "aggregate_bytes_refused",
  );
});

test("five-year count arithmetic includes payload and verification objects", () => {
  assert.equal(ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS, 8_372);
  assert.equal(
    ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS,
    ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS,
  );
  assert.equal(
    ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS,
    ADJUSTMENT_MAXIMUM_PAYLOAD_OBJECTS +
      ADJUSTMENT_MAXIMUM_VERIFICATION_MANIFEST_OBJECTS,
  );
  assert.equal(ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS, 16_744);
  assert.equal(
    ADJUSTMENT_MAXIMUM_ARCHIVE_FILES,
    ADJUSTMENT_MAXIMUM_COMMITTED_OBJECTS +
      ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES +
      ADJUSTMENT_MAXIMUM_HEAD_POINTER_FILES,
  );
  assert.equal(ADJUSTMENT_MAXIMUM_ARCHIVE_FILES, 16_747);
  assert.equal(
    ADJUSTMENT_MAXIMUM_TASK_INODES,
    ADJUSTMENT_MAXIMUM_ARCHIVE_FILES +
      ADJUSTMENT_MAXIMUM_CATALOG_SHARDS +
      ADJUSTMENT_MAXIMUM_JOURNAL_CONTROL_FILES +
      ADJUSTMENT_MAXIMUM_STAGING_FILES,
  );
  assert.equal(ADJUSTMENT_MAXIMUM_TASK_INODES, 17_899);

  // preserve the reviewed byte ceilings and floors independently of counts
  assert.equal(ADJUSTMENT_ARCHIVE_MAXIMUM_BYTES, 18n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_TOTAL_STORAGE_CEILING_BYTES, 64n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_FREE_SPACE_FLOOR_BYTES, 16n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_EXISTING_CENSUS_BYTES, 16n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_STAGING_CEILING_BYTES, 4n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_RELEASE_CONTROL_CEILING_BYTES, 4n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_CATALOG_STATE_CEILING_BYTES, 1n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_ACTIVE_BUCKET_CEILING_BYTES, 43n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_UNASSIGNED_HEADROOM_BYTES, 18n * 1_024n ** 3n);
  assert.equal(ADJUSTMENT_RESERVED_UNUSABLE_BYTES, 3n * 1_024n ** 3n);
});

test("archive file peak accepts its exact limit and refuses one over", async () => {
  const store = new MemoryArchiveStore();
  store.capacity.fileCount = ADJUSTMENT_MAXIMUM_ARCHIVE_FILES - 2;
  const archive = createPlaintextArchive({
    memberValidators: new Map([["test-record/v1", createValidator()]]),
    store,
  });
  await archive.initialize();
  await archive.publishCasObject([{
    identitySha256: HASH_A,
    kind: "test-record/v1",
    payload: Buffer.from("alpha"),
  }]);
  assert.equal(store.capacity.fileCount, ADJUSTMENT_MAXIMUM_ARCHIVE_FILES - 1);

  await assert.rejects(
    // account for both incoming and final names at publication peak
    archive.publishCasObject([{
      identitySha256: HASH_B,
      kind: "test-record/v1",
      payload: Buffer.from("beta"),
    }]),
    (error) => error.reason === "archive_count_refused",
  );
});

test("archive publication refuses a second incoming object", async () => {
  const store = new MemoryArchiveStore();
  store.capacity.incomingCount = ADJUSTMENT_MAXIMUM_INCOMING_OBJECT_FILES;
  const archive = createPlaintextArchive({
    memberValidators: new Map([["test-record/v1", createValidator()]]),
    store,
  });
  await archive.initialize();

  await assert.rejects(
    // preserve the single reconciled incoming-object allowance
    archive.publishCasObject([{
      identitySha256: HASH_A,
      kind: "test-record/v1",
      payload: Buffer.from("alpha"),
    }]),
    (error) => error.reason === "archive_count_refused",
  );
  assert.equal(store.publishCalls, 0);
});

test("task inode admission accepts its exact limit and refuses one over", async () => {
  const store = new MemoryArchiveStore();
  store.capacity.taskInodes = BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES - 1);
  const archive = createPlaintextArchive({
    memberValidators: new Map([["test-record/v1", createValidator()]]),
    store,
  });
  await archive.initialize();
  await archive.publishCasObject([{
    identitySha256: HASH_A,
    kind: "test-record/v1",
    payload: Buffer.from("alpha"),
  }]);
  assert.equal(store.capacity.taskInodes, BigInt(ADJUSTMENT_MAXIMUM_TASK_INODES));

  await assert.rejects(
    // refuse one inode beyond the complete task allocation
    archive.publishCasObject([{
      identitySha256: HASH_B,
      kind: "test-record/v1",
      payload: Buffer.from("beta"),
    }]),
    (error) => error.reason === "archive_count_refused",
  );
});

test("publication crash leaves no fabricated committed object", async () => {
  const store = new MemoryArchiveStore();
  store.failPublish = true;
  const validators = new Map([["test-record/v1", createValidator()]]);
  const archive = createPlaintextArchive({ memberValidators: validators, store });
  await archive.initialize();
  await assert.rejects(
    // inject failure before publication mutation
    archive.publishCasObject([{
      identitySha256: HASH_A,
      kind: "test-record/v1",
      payload: Buffer.from("alpha"),
    }]),
    /injected crash/u,
  );
  assert.equal(store.objects.size, 0);
});

test("catalog entries are fixed 96-byte strong-hash records", () => {
  const entry = encodeCatalogEntry({
    identitySha256: HASH_A,
    kind: "test-record/v1",
    memberSha256: HASH_B,
  });
  assert.equal(entry.length, ADJUSTMENT_CATALOG_ENTRY_BYTES);
  const shard = encodeCatalogShard({
    entries: [{
      identitySha256: HASH_A,
      kind: "test-record/v1",
      memberSha256: HASH_B,
    }],
    generation: "1",
    objectSha256: HASH_A,
    shardIndex: 0,
  });
  assert.equal(shard.length, 64 + ADJUSTMENT_CATALOG_ENTRY_BYTES);
  const inspected = inspectCatalogShard(shard);
  assert.equal(inspected.entryCount, 1);
  assert.equal(inspected.objectSha256, HASH_A);
  assert.equal(inspected.entries[0].identitySha256, HASH_A);
  assert.equal(ADJUSTMENT_PRIMARY_GROWTH_BYTES, 12_963_872_768n);
  assert.equal(ADJUSTMENT_MAXIMUM_ARCHIVE_FILES, 16_747);
  assert.equal(ADJUSTMENT_MAXIMUM_TASK_INODES, 17_899);
  assert.equal(ADJUSTMENT_MAXIMUM_CATALOG_ENTRIES, 9_500_000);
});

test("production root cannot be overridden", () => {
  assert.throws(
    // reject an unsafe caller-selected production root
    () => createPlaintextArchive({ root: "/tmp/archive" }),
    /override is prohibited/u,
  );
});
