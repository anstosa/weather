import assert from "node:assert/strict";
import test from "node:test";
import {
  ADJUSTMENT_V1_STREAM_BUFFER_BYTES,
  classifyHistoryAvailability,
  createV1CompatibilityManifest,
  mapV1CompatibilityMembers,
  validateV1CompatibilityManifest,
  verifyV1CompatibilityManifest,
} from "./adjustment_v1_compat.mjs";

const HASH_A = "a".repeat(64);

// hold immutable old-v1 bytes behind a read-only port
class MemoryLegacyStore {
  constructor(entries) {
    this.entries = new Map(entries);
    this.rootIdentity = HASH_A;
    this.metadataOverride = null;
    this.maximumRead = 0;
  }

  // return one path-free held-root identity
  async identity() {
    return {
      heldRootIdentitySha256: this.rootIdentity,
      rootKind: "legacy_v1_local",
    };
  }

  // describe one original private member
  async describe(relativeName) {
    const bytes = this.entries.get(relativeName);

    // fail honestly when original history is absent
    if (bytes === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return this.metadataOverride ?? {
      mode: 0o600,
      nlink: 1,
      owner: "current_user",
      size: bytes.length,
      type: "file",
    };
  }

  // stream one member through caller-bounded chunks
  async *readChunks(relativeName, maximumBytes) {
    const bytes = this.entries.get(relativeName);

    // fail honestly when original bytes are absent
    if (bytes === undefined) {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }

    // yield every original byte once
    for (let offset = 0; offset < bytes.length; offset += maximumBytes) {
      const chunk = bytes.subarray(offset, offset + maximumBytes);
      this.maximumRead = Math.max(this.maximumRead, chunk.length);
      yield chunk;
    }
  }
}

// collect fixed-name compatibility mappings
class MemorySink {
  constructor() {
    this.files = new Map();
  }

  // write one selected fixed filename exclusively
  async writeExclusive(name, chunks, expectedBytes) {
    const values = [];

    // consume bounded original chunks
    for await (const chunk of chunks) {
      assert.ok(chunk.length <= ADJUSTMENT_V1_STREAM_BUFFER_BYTES);
      values.push(chunk);
    }
    const bytes = Buffer.concat(values);
    assert.equal(bytes.length, expectedBytes);
    this.files.set(name, bytes);
  }
}

test("v1 compatibility hashes original bytes and never requires a rewrite", async () => {
  const originalReceipt = Buffer.from("old receipt bytes\n");
  const originalLedger = Buffer.alloc(600_000, "l");
  const store = new MemoryLegacyStore([
    ["receipts/old.json", originalReceipt],
    ["ledger/burned.jsonl", originalLedger],
  ]);
  const created = await createV1CompatibilityManifest({
    graphLinks: [{
      fromRelativeName: "receipts/old.json",
      relation: "burned_by",
      toRelativeName: "ledger/burned.jsonl",
    }],
    members: [
      { kind: "receipt", relativeName: "receipts/old.json" },
      { kind: "burned-ledger", relativeName: "ledger/burned.jsonl" },
    ],
    oldWatermarkSha256: HASH_A,
  }, store);
  assert.equal(validateV1CompatibilityManifest(created.manifest), created.manifest);
  const verified = await verifyV1CompatibilityManifest(
    created.manifest,
    created.manifestSha256,
    store,
  );
  assert.equal(verified.status, "verified_read_only");
  assert.ok(store.maximumRead <= ADJUSTMENT_V1_STREAM_BUFFER_BYTES);
  assert.deepEqual(store.entries.get("receipts/old.json"), originalReceipt);
  assert.deepEqual(store.entries.get("ledger/burned.jsonl"), originalLedger);

  const sink = new MemorySink();
  const mapped = await mapV1CompatibilityMembers({
    manifest: created.manifest,
    manifestSha256: created.manifestSha256,
    targets: [{ fixedName: "legacy-input.bin", relativeName: "receipts/old.json" }],
  }, store, sink);
  assert.deepEqual(mapped, {
    mappedBytes: String(originalReceipt.length),
    mappedFiles: 1,
  });
  assert.deepEqual(sink.files.get("legacy-input.bin"), originalReceipt);
});

test("missing, linked, foreign and hash-mismatched v1 members fail closed", async () => {
  const store = new MemoryLegacyStore([["old/object.json", Buffer.from("immutable")]]);
  const created = await createV1CompatibilityManifest({
    graphLinks: [],
    members: [{ kind: "object", relativeName: "old/object.json" }],
    oldWatermarkSha256: HASH_A,
  }, store);

  store.metadataOverride = {
    mode: 0o600,
    nlink: 2,
    owner: "current_user",
    size: 9,
    type: "file",
  };
  await assert.rejects(
    // reject hardlinked legacy members
    verifyV1CompatibilityManifest(created.manifest, created.manifestSha256, store),
    (error) => error.code === "history_unavailable",
  );

  store.metadataOverride = null;
  store.entries.set("old/object.json", Buffer.from("mutation!"));
  await assert.rejects(
    // reject changed original bytes
    verifyV1CompatibilityManifest(created.manifest, created.manifestSha256, store),
    (error) => error.code === "history_unavailable",
  );

  store.entries.delete("old/object.json");
  await assert.rejects(
    // reject missing original history
    verifyV1CompatibilityManifest(created.manifest, created.manifestSha256, store),
    (error) => error.code === "history_unavailable",
  );
});

test("compatibility mapping rejects archive-controlled paths and mutation-capable stores", async () => {
  const store = new MemoryLegacyStore([["old/object.json", Buffer.from("immutable")]]);
  const created = await createV1CompatibilityManifest({
    graphLinks: [],
    members: [{ kind: "object", relativeName: "old/object.json" }],
    oldWatermarkSha256: HASH_A,
  }, store);
  await assert.rejects(
    // reject a target path instead of a caller-fixed filename
    mapV1CompatibilityMembers({
      manifest: created.manifest,
      manifestSha256: created.manifestSha256,
      targets: [{ fixedName: "../escape", relativeName: "old/object.json" }],
    }, store, new MemorySink()),
    /fixed mapping name/u,
  );

  const mutableStore = Object.assign(Object.create(store), {
    delete: async () => undefined,
  });
  await assert.rejects(
    // reject any compatibility port exposing deletion
    createV1CompatibilityManifest({
      graphLinks: [],
      members: [{ kind: "object", relativeName: "old/object.json" }],
      oldWatermarkSha256: HASH_A,
    }, mutableStore),
    /read only/u,
  );
});

test("anchor-only loss reports history_unavailable without invented recovery", () => {
  const result = classifyHistoryAvailability({
    anchorPresent: true,
    requirements: [
      { available: false, kind: "primary_cas", verified: false },
      { available: true, kind: "maintenance_anchor", verified: true },
      { available: false, kind: "burn_predecessor", verified: false },
    ],
  });
  assert.equal(result.status, "history_unavailable");
  assert.equal(result.anchorIsBackup, false);
  assert.equal(result.qualificationAllowed, false);
  assert.equal(result.priorReuseAllowed, false);
  assert.equal(result.rollbackEvidenceReuseAllowed, false);
  assert.equal(result.hotRetirementAllowed, false);
  assert.equal(result.recoveryDisposition, "new_causal_interval_with_discontinuity_only");
});
