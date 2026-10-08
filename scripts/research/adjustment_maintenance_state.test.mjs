import assert from "node:assert/strict";
import test from "node:test";
import {
  ADJUSTMENT_MAINTENANCE_STATE_ROOT_KIND,
  MaintenanceJournal,
  assembleConfirmationManifest,
  createMaintenanceJournal,
  verifyJournalBytes,
} from "./adjustment_maintenance_state.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

// hold one append-only journal for deterministic tests
class MemoryJournalStore {
  constructor() {
    this.bytes = Buffer.alloc(0);
    this.heads = null;
    this.queue = Promise.resolve();
    this.failAppend = null;
  }

  // return one path-free state identity
  async initialize() {
    return { rootKind: ADJUSTMENT_MAINTENANCE_STATE_ROOT_KIND };
  }

  // serialize one exclusive transaction
  async withLock(callback) {
    const operation = this.queue.then(
      // execute inside the injected exclusive lock
      async () => await callback({
        // read exact journal bytes
        readJournal: async () => Buffer.from(this.bytes),
        // append and fsync one transaction
        append: async (bytes, heads) => {
          // inject a crash before journal mutation
          if (this.failAppend === "before") {
            this.failAppend = null;
            throw new Error("journal crash before append");
          }
          this.bytes = Buffer.concat([this.bytes, bytes]);

          // inject a crash after journal fsync but before head rotation
          if (this.failAppend === "after_journal") {
            this.failAppend = null;
            throw new Error("journal crash after append");
          }
          this.heads = structuredClone(heads);
        },
        // reconcile bounded head slots
        writeHeads: async (heads) => {
          this.heads = structuredClone(heads);
        },
      }),
    );
    this.queue = operation.catch(
      // keep later lock acquisition live after failure
      () => undefined,
    );
    return await operation;
  }
}

// add calendar days to one test date
function addDate(localDate, days) {
  return new Date(Date.parse(`${localDate}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString().slice(0, 10);
}

// build one deterministic confirmation chunk array
function buildChunks(family, start, count, intervalDays) {
  let current = start;
  return Array.from({ length: count },
    // create one exact fourteen-day or final partition
    (_, index) => {
      const days = index === count - 1 ? intervalDays - 14 * (count - 1) : 14;
      const end = addDate(current, days);
      const chunk = {
        chunkIndex: index,
        fromLocalDate: current,
        toLocalDateExclusive: end,
        chunkSha256: index.toString(16).padStart(64, "0"),
        recordCount: family === "wind" ? 224 : 64,
        expectedKeySubsetSha256: (index + 100).toString(16).padStart(64, "0"),
        eligiblePredictionSubsetSha256: (index + 200).toString(16).padStart(64, "0"),
        missingKeySubsetSha256: (index + 300).toString(16).padStart(64, "0"),
      };
      current = end;
      return chunk;
    },
  );
}

test("leases enforce durations, due collisions, expiry reconciliation and clock fencing", async () => {
  const store = new MemoryJournalStore();
  const journal = new MaintenanceJournal(store);
  assert.deepEqual(await journal.initialize(), { head: null, records: 0 });
  const acquired = await journal.acquireLease({
    dueKey: "daily/2026-10-08",
    inputHeadSha256: HASH_A,
    now: "2026-10-08T00:00:00.000Z",
    runId: "daily-1",
    scope: "daily",
  });
  assert.equal(acquired.expiresAt, "2026-10-08T03:00:00.000Z");
  assert.equal(acquired.fencingToken, null);
  const retry = await journal.acquireLease({
    dueKey: "daily/2026-10-08",
    inputHeadSha256: HASH_A,
    now: "2026-10-08T00:01:00.000Z",
    runId: "daily-1",
    scope: "daily",
  });
  assert.equal(retry.runId, "daily-1");
  await assert.rejects(
    // reject the same due key with different immutable inputs
    journal.acquireLease({
      dueKey: "daily/2026-10-08",
      inputHeadSha256: HASH_B,
      now: "2026-10-08T00:02:00.000Z",
      runId: "daily-2",
      scope: "daily",
    }),
    (error) => error.reason === "lease_occupied" || error.reason === "due_key_collision",
  );
  await journal.releaseLease({
    dueKey: "daily/2026-10-08",
    now: "2026-10-08T00:03:00.000Z",
    runId: "daily-1",
    scope: "daily",
  });

  await assert.rejects(
    // reject a wall-clock rollback greater than five minutes
    journal.acquireLease({
      dueKey: "daily/2026-10-09",
      inputHeadSha256: HASH_A,
      now: "2026-10-07T23:00:00.000Z",
      runId: "daily-rollback",
      scope: "daily",
    }),
    (error) => error.reason === "clock_untrusted",
  );

  await journal.acquireLease({
    dueKey: "capture/2026-10-08T06:35:00.000Z",
    inputHeadSha256: HASH_A,
    now: "2026-10-08T06:35:00.000Z",
    runId: "archive-1",
    scope: "archive",
  });
  await assert.rejects(
    // force reconciliation after expiry instead of blind takeover
    journal.acquireLease({
      dueKey: "daily/2026-10-09",
      inputHeadSha256: HASH_A,
      now: "2026-10-08T08:00:00.000Z",
      runId: "daily-forward",
      scope: "daily",
    }),
    (error) => error.reason === "reconciliation_required",
  );
  const reconciliation = await journal.reconcileExpiredLease({
    dueKey: "capture/2026-10-08T06:35:00.000Z",
    immutableOutputSha256: null,
    now: "2026-10-08T08:00:00.000Z",
    remoteStateSha256: HASH_B,
    resolution: "resume",
    runId: "archive-1",
    scope: "archive",
  });
  assert.deepEqual(reconciliation, { status: "reconciled", resolution: "resume" });
  assert.ok(verifyJournalBytes(store.bytes).length >= 5);
});

test("release fencing tokens increase and exact completed due keys never replay", async () => {
  const store = new MemoryJournalStore();
  const journal = new MaintenanceJournal(store);
  await journal.initialize();
  const first = await journal.acquireLease({
    dueKey: "rollback/temperature/1",
    inputHeadSha256: HASH_A,
    now: "2026-10-08T00:00:00.000Z",
    runId: "release-1",
    scope: "release",
  });
  assert.equal(first.expiresAt, "2026-10-08T08:00:00.000Z");
  assert.equal(first.fencingToken, "1");
  await journal.releaseLease({
    dueKey: "rollback/temperature/1",
    now: "2026-10-08T00:01:00.000Z",
    runId: "release-1",
    scope: "release",
  });
  const second = await journal.acquireLease({
    dueKey: "rollback/temperature/2",
    inputHeadSha256: HASH_B,
    now: "2026-10-08T00:02:00.000Z",
    runId: "release-2",
    scope: "release",
  });
  assert.equal(second.fencingToken, "2");
  await journal.completeDue({
    dueKey: "rollback/temperature/2",
    now: "2026-10-08T00:03:00.000Z",
    outputSha256: HASH_C,
  });
  const completed = await journal.acquireLease({
    dueKey: "rollback/temperature/2",
    inputHeadSha256: HASH_B,
    now: "2026-10-08T00:04:00.000Z",
    runId: "release-2",
    scope: "release",
  });
  assert.equal(completed.runId, "release-2");
  assert.equal((await journal.status()).fencingToken, "2");
});

test("journal crash retry reconciles an appended tail without duplicate authority", async () => {
  const store = new MemoryJournalStore();
  const journal = new MaintenanceJournal(store);
  await journal.initialize();
  store.failAppend = "before";
  await assert.rejects(
    // crash before any append-only mutation
    journal.acquireLease({
      dueKey: "daily/2026-10-08",
      inputHeadSha256: HASH_A,
      now: "2026-10-08T00:00:00.000Z",
      runId: "daily-crash",
      scope: "daily",
    }),
    /before append/u,
  );
  assert.equal(verifyJournalBytes(store.bytes).length, 0);

  store.failAppend = "after_journal";
  await assert.rejects(
    // crash after journal fsync but before bounded head rotation
    journal.acquireLease({
      dueKey: "daily/2026-10-08",
      inputHeadSha256: HASH_A,
      now: "2026-10-08T00:00:00.000Z",
      runId: "daily-crash",
      scope: "daily",
    }),
    /after append/u,
  );
  assert.equal(verifyJournalBytes(store.bytes).length, 2);
  const initialized = await journal.initialize();
  assert.equal(initialized.records, 2);
  const retry = await journal.acquireLease({
    dueKey: "daily/2026-10-08",
    inputHeadSha256: HASH_A,
    now: "2026-10-08T00:00:00.000Z",
    runId: "daily-crash",
    scope: "daily",
  });
  assert.equal(retry.runId, "daily-crash");
  assert.equal(verifyJournalBytes(store.bytes).length, 2);
});

test("27/27/24 confirmation members assemble deterministically without values", () => {
  const configurations = [
    ["temperature", 27, 366],
    ["wind", 27, 366],
    ["rain", 24, 334],
  ];

  // prove each family-specific complete member shape
  for (const [family, count, intervalDays] of configurations) {
    const start = "2026-10-31";
    const end = addDate(start, intervalDays);
    const registration = {
      family,
      registrationSha256: HASH_A,
      intervalStartLocalDate: start,
      intervalEndExclusiveLocalDate: end,
    };
    const access = {
      accessSha256: HASH_B,
      expectedKeySetSha256: HASH_A,
      revisionCatalogWatermarkSha256: HASH_C,
      targetComparatorSnapshotRootSha256: HASH_D,
      targetCutoffAt: "2027-10-07T07:00:00.000Z",
    };
    const chunks = buildChunks(family, start, count, intervalDays);
    const first = assembleConfirmationManifest({ access, chunks, registration });
    const second = assembleConfirmationManifest({ access, chunks, registration });
    assert.equal(first.chunkCount, count);
    assert.equal(first.intervalEndExclusiveLocalDate, end);
    assert.equal(first.fullMemberRootSha256, second.fullMemberRootSha256);
    assert.equal(JSON.stringify(first).includes("values"), false);

    const broken = structuredClone(chunks);
    broken.at(-1).fromLocalDate = addDate(broken.at(-1).fromLocalDate, 1);
    assert.throws(
      // reject a final partition gap
      () => assembleConfirmationManifest({ access, chunks: broken, registration }),
      /partition/u,
    );
  }
});

test("lifecycle preregistration, snapshot, burn, chunks, result and embargo are append only", async () => {
  const store = new MemoryJournalStore();
  const journal = new MaintenanceJournal(store);
  await journal.initialize();
  await journal.initializeLifecycle({
    now: "2026-01-01T00:00:00.000Z",
    v1LedgerSha256: HASH_A,
    v1TailSha256: HASH_B,
  });
  const registrationInput = {
    candidateKind: "temperature-delayed-mos/v1",
    candidateSha256: HASH_C,
    cohortLineageSha256: HASH_B,
    family: "temperature",
    firstTargetAt: "2026-01-02T08:00:00.000Z",
    gateManifestSha256: HASH_D,
    inputHeadSha256: HASH_A,
    intervalEndExclusiveLocalDate: "2027-01-03",
    intervalStartLocalDate: "2026-01-02",
    now: "2026-01-01T00:01:00.000Z",
    reservedKeySha256: HASH_B,
    sourceLineageSha256: HASH_A,
    terminalAccessAt: "2027-01-10T08:00:00.000Z",
  };
  const registration = await journal.preregisterConfirmation(registrationInput);
  await assert.rejects(
    // prohibit a second active same-family member
    journal.preregisterConfirmation({
      ...registrationInput,
      candidateSha256: HASH_D,
      now: "2026-01-01T00:02:00.000Z",
    }),
    (error) => error.reason === "confirmation_slot_occupied",
  );
  await journal.recordRevisionSnapshot({
    entryCount: 100,
    expectedKeySetSha256: HASH_A,
    family: "temperature",
    now: "2027-01-10T07:59:00.000Z",
    registrationSha256: registration.registrationSha256,
    revisionCatalogWatermarkSha256: HASH_B,
    snapshotRootSha256: HASH_C,
    targetCutoffAt: "2027-01-09T08:00:00.000Z",
  });
  await journal.recordRevisionSnapshot({
    entryCount: 100,
    expectedKeySetSha256: HASH_A,
    family: "temperature",
    now: "2027-01-10T07:59:30.000Z",
    registrationSha256: registration.registrationSha256,
    revisionCatalogWatermarkSha256: HASH_B,
    snapshotRootSha256: HASH_C,
    targetCutoffAt: "2027-01-09T08:00:00.000Z",
  });
  await assert.rejects(
    // reject a later revision-root substitution for the same registration
    journal.recordRevisionSnapshot({
      entryCount: 100,
      expectedKeySetSha256: HASH_A,
      family: "temperature",
      now: "2027-01-10T07:59:31.000Z",
      registrationSha256: registration.registrationSha256,
      revisionCatalogWatermarkSha256: HASH_B,
      snapshotRootSha256: HASH_D,
      targetCutoffAt: "2027-01-09T08:00:00.000Z",
    }),
    (error) => error.reason === "journal_record_collision",
  );
  await assert.rejects(
    // make premature access permanently unavailable to action code
    journal.burnConfirmation({
      family: "temperature",
      now: "2027-01-10T07:59:59.000Z",
      registrationSha256: registration.registrationSha256,
    }),
    (error) => error.reason === "confirmation_access_premature",
  );
  const burn = await journal.burnConfirmation({
    family: "temperature",
    now: "2027-01-10T08:00:00.000Z",
    registrationSha256: registration.registrationSha256,
  });
  assert.match(burn.accessSha256, /^[a-f0-9]{64}$/u);
  const chunks = buildChunks("temperature", "2026-01-02", 27, 366);

  // append every immutable chunk once
  for (const chunk of chunks) {
    await journal.appendConfirmationChunk({
      chunk,
      family: "temperature",
      now: "2027-01-10T08:01:00.000Z",
      registrationSha256: registration.registrationSha256,
    });
  }

  const complete = await journal.finalizeConfirmationMember({
    family: "temperature",
    now: "2027-01-10T08:02:00.000Z",
    registrationSha256: registration.registrationSha256,
  });
  assert.equal(complete.chunkCount, 27);
  const result = await journal.recordConfirmationResult({
    actionIdentitySha256: null,
    candidateReportSha256: HASH_D,
    disposition: "support_failed",
    family: "temperature",
    nextConfirmationEligibleAt: "2027-01-18T08:00:00.000Z",
    now: "2027-01-10T08:03:00.000Z",
    registrationSha256: registration.registrationSha256,
  });
  assert.equal(result.fullMemberRootSha256, complete.fullMemberRootSha256);
  await assert.rejects(
    // enforce the seven-full-local-date embargo projection
    journal.preregisterConfirmation({
      ...registrationInput,
      candidateSha256: HASH_D,
      firstTargetAt: "2027-01-12T08:00:00.000Z",
      intervalStartLocalDate: "2027-01-12",
      intervalEndExclusiveLocalDate: "2028-01-13",
      now: "2027-01-11T00:00:00.000Z",
      terminalAccessAt: "2028-01-20T08:00:00.000Z",
    }),
    (error) => error.reason === "confirmation_embargo_active",
  );
});

test("journal corruption fails closed and production root cannot be overridden", async () => {
  const store = new MemoryJournalStore();
  const journal = new MaintenanceJournal(store);
  await journal.initialize();
  await journal.initializeLifecycle({
    now: "2026-01-01T00:00:00.000Z",
    v1LedgerSha256: HASH_A,
    v1TailSha256: HASH_B,
  });
  const corrupted = Buffer.from(store.bytes);
  corrupted[20] ^= 1;
  assert.throws(
    // reject one corrupted append-only byte
    () => verifyJournalBytes(corrupted),
  );
  assert.throws(
    // reject an unsafe caller-selected state root
    () => createMaintenanceJournal({ root: "/tmp/state" }),
    /override is prohibited/u,
  );
});
