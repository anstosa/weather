import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  statfs,
  unlink,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ensureAdjustmentPrivateDirectory } from "./adjustment_private_directory.mjs";

export const ADJUSTMENT_JOURNAL_CONTRACT_VERSION =
  "forecast-adjustment-maintenance-journal/v2";
export const ADJUSTMENT_LIFECYCLE_LEDGER_CONTRACT_VERSION =
  "forecast-adjustment-lifecycle-ledger/v2";
export const ADJUSTMENT_MAINTENANCE_STATE_ROOT_KIND = "home_native_ext4_state";
export const ADJUSTMENT_DEFAULT_STATE_ROOT = join(
  homedir(),
  ".weather",
  "adjustment-maintenance",
  "v2",
  "state",
);
export const ADJUSTMENT_MAXIMUM_FENCING_TOKEN = 0xffff_ffff_ffff_ffffn;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1_000;
const MAXIMUM_JOURNAL_BYTES = 64 * 1_024 * 1_024;
const EXT4_MAGIC = 0xef53n;
const LEASE_MILLISECONDS = new Map([
  ["archive", 60 * 60 * 1_000],
  ["daily", 3 * 60 * 60 * 1_000],
  ["confirmation", 3 * 60 * 60 * 1_000],
  ["monthly", 6 * 60 * 60 * 1_000],
  ["release", 8 * 60 * 60 * 1_000],
]);
const FAMILY_CANDIDATE_KINDS = new Map([
  ["temperature", "temperature-delayed-mos/v1"],
  ["wind", "wind-robust-hierarchical-median/v1"],
  ["rain", "rain-hurdle-wind-occurrence-amount/v1"],
]);
const CONFIRMATION_CHUNK_COUNTS = new Map([
  ["temperature", 27],
  ["wind", 27],
  ["rain", 24],
]);
const CONFIRMATION_INTERVAL_DAYS = new Map([
  ["temperature", 366],
  ["wind", 366],
  ["rain", 334],
]);
const FORBIDDEN_VALUE_KEYS = /(?:^|_)(?:body|bytes|payload|row|rows|value|values)(?:$|_)/iu;

// create the fixed-root journal or an injected test journal
export function createMaintenanceJournal(options = {}) {
  // prohibit configurable production state roots
  if (Object.hasOwn(options, "root")) {
    throw new TypeError("maintenance state root override is prohibited");
  }
  return new MaintenanceJournal(options.store ?? new FixedRootJournalStore());
}

// own append-only journal and lifecycle transitions
export class MaintenanceJournal {
  #store;

  // retain only one exclusive durable store
  constructor(store) {
    // require the journal storage port
    if (store === null || typeof store !== "object" ||
      typeof store.initialize !== "function" || typeof store.withLock !== "function") {
      throw new TypeError("maintenance journal store is invalid");
    }
    this.#store = store;
  }

  // initialize and reconcile the durable head slots
  async initialize() {
    const identity = await this.#store.initialize();

    // reject path disclosure or an unexpected root identity
    if (identity.rootKind !== ADJUSTMENT_MAINTENANCE_STATE_ROOT_KIND ||
      Object.hasOwn(identity, "path")) {
      throw new TypeError("maintenance state identity is invalid");
    }

    return await this.#store.withLock(
      // verify the full journal and repair only bounded head projections
      async (transaction) => {
        const records = verifyJournalBytes(await transaction.readJournal());
        await transaction.writeHeads(headsForRecords(records));
        return { head: records.at(-1)?.recordSha256 ?? null, records: records.length };
      },
    );
  }

  // return one path-free verified journal projection
  async status() {
    return await this.#read(
      // project bounded authority state
      (records) => {
        const activeLeases = deriveActiveLeases(records);
        const maxSeenUtc = deriveMaxSeenUtc(records);
        const fencingToken = deriveMaximumFencingToken(records);
        return {
          headSha256: records.at(-1)?.recordSha256 ?? null,
          generation: records.at(-1)?.generation ?? "0",
          maxSeenUtc,
          fencingToken: fencingToken.toString(),
          activeLeases: [...activeLeases.values()].map(
            // omit private payload details from status
            (lease) => ({
              dueKey: lease.payload.dueKey,
              expiresAt: lease.payload.expiresAt,
              runId: lease.payload.runId,
              scope: lease.payload.scope,
            }),
          ),
        };
      },
    );
  }

  // acquire one fixed-duration fenced lease
  async acquireLease(input) {
    requireExactKeys(input, [
      "dueKey",
      "inputHeadSha256",
      "now",
      "runId",
      "scope",
    ], "lease input");
    requireDueKey(input.dueKey);
    requireSha256(input.inputHeadSha256, "inputHeadSha256");
    requireInstant(input.now, "now");
    requireRunId(input.runId);
    const scopeClass = leaseScopeClass(input.scope);
    const durationMs = LEASE_MILLISECONDS.get(scopeClass);

    return await this.#mutate(
      // enforce due identity, clock and lease fencing under one lock
      (records) => {
        enforceTrustedClock(records, input.now);
        const activeLeases = deriveActiveLeases(records);
        const active = activeLeases.get(input.scope);
        const due = findDueRegistration(records, input.dueKey);

        // reject due-key reuse with different immutable inputs
        if (due !== undefined && due.payload.inputHeadSha256 !== input.inputHeadSha256) {
          throw stateError("due_key_collision");
        }

        // require reconciliation before expired lease reuse
        if (active !== undefined && Date.parse(active.payload.expiresAt) <= Date.parse(input.now)) {
          throw stateError("reconciliation_required");
        }

        // serialize one active lease per exact scope
        if (active !== undefined) {
          // return only an exact idempotent acquisition
          if (active.payload.runId === input.runId && active.payload.dueKey === input.dueKey &&
            active.payload.inputHeadSha256 === input.inputHeadSha256) {
            return { records: [], result: active.payload };
          }
          throw stateError("lease_occupied");
        }

        // return terminal due work without replay
        if (findDueCompletion(records, input.dueKey) !== undefined) {
          return { records: [], result: { status: "already_complete", dueKey: input.dueKey } };
        }

        const fencingToken = scopeClass === "release"
          ? allocateFencingToken(records)
          : null;
        const expiresAt = new Date(Date.parse(input.now) + durationMs).toISOString();
        const payload = {
          scope: input.scope,
          runId: input.runId,
          dueKey: input.dueKey,
          acquiredAt: input.now,
          expiresAt,
          inputHeadSha256: input.inputHeadSha256,
          fencingToken: fencingToken === null ? null : fencingToken.toString(),
        };
        const additions = [];

        // register one immutable due input before its lease
        if (due === undefined) {
          additions.push({
            dueKey: input.dueKey,
            kind: "due_registered",
            payload: { inputHeadSha256: input.inputHeadSha256 },
            recordKey: `due/${input.dueKey}`,
            recordedAt: input.now,
          });
        }
        additions.push({
          dueKey: input.dueKey,
          kind: "lease_acquired",
          payload,
          recordKey: `lease/${input.scope}/${input.runId}/acquired`,
          recordedAt: input.now,
        });
        return { records: additions, result: payload };
      },
    );
  }

  // release one exact live lease without deleting history
  async releaseLease(input) {
    requireExactKeys(input, ["dueKey", "now", "runId", "scope"], "lease release");
    requireDueKey(input.dueKey);
    requireInstant(input.now, "now");
    requireRunId(input.runId);
    leaseScopeClass(input.scope);

    return await this.#mutate(
      // bind one release to the current active lease
      (records) => {
        enforceTrustedClock(records, input.now);
        const active = deriveActiveLeases(records).get(input.scope);

        // reject release of an unknown or replaced lease
        if (active === undefined || active.payload.runId !== input.runId ||
          active.payload.dueKey !== input.dueKey) {
          throw stateError("unknown_lease");
        }

        // require expiry reconciliation instead of ordinary release
        if (Date.parse(active.payload.expiresAt) <= Date.parse(input.now)) {
          throw stateError("reconciliation_required");
        }
        return {
          records: [{
            dueKey: input.dueKey,
            kind: "lease_released",
            payload: {
              scope: input.scope,
              runId: input.runId,
              dueKey: input.dueKey,
              releasedAt: input.now,
            },
            recordKey: `lease/${input.scope}/${input.runId}/released`,
            recordedAt: input.now,
          }],
          result: { status: "released" },
        };
      },
    );
  }

  // reconcile one expired lease against immutable external evidence
  async reconcileExpiredLease(input) {
    requireExactKeys(input, [
      "dueKey",
      "immutableOutputSha256",
      "now",
      "remoteStateSha256",
      "resolution",
      "runId",
      "scope",
    ], "lease reconciliation");
    requireDueKey(input.dueKey);
    requireInstant(input.now, "now");
    requireRunId(input.runId);
    leaseScopeClass(input.scope);
    requireNullableSha256(input.immutableOutputSha256, "immutableOutputSha256");
    requireNullableSha256(input.remoteStateSha256, "remoteStateSha256");

    // require one closed reconciliation outcome
    if (!new Set(["blocked", "complete", "resume"]).has(input.resolution)) {
      throw new TypeError("reconciliation resolution is invalid");
    }

    return await this.#mutate(
      // resolve only the exact known expired lease
      (records) => {
        enforceTrustedClock(records, input.now, { allowExpired: true });
        const active = deriveActiveLeases(records).get(input.scope);

        // require one exact expired lease
        if (active === undefined || active.payload.runId !== input.runId ||
          active.payload.dueKey !== input.dueKey ||
          Date.parse(active.payload.expiresAt) > Date.parse(input.now)) {
          throw stateError("expired_lease_not_found");
        }
        return {
          records: [{
            dueKey: input.dueKey,
            kind: "lease_reconciled",
            payload: {
              scope: input.scope,
              runId: input.runId,
              dueKey: input.dueKey,
              reconciledAt: input.now,
              resolution: input.resolution,
              immutableOutputSha256: input.immutableOutputSha256,
              remoteStateSha256: input.remoteStateSha256,
            },
            recordKey: `lease/${input.scope}/${input.runId}/reconciled`,
            recordedAt: input.now,
          }],
          result: { status: "reconciled", resolution: input.resolution },
        };
      },
    );
  }

  // mark one exact due key terminal
  async completeDue(input) {
    requireExactKeys(input, ["dueKey", "now", "outputSha256"], "due completion");
    requireDueKey(input.dueKey);
    requireInstant(input.now, "now");
    requireSha256(input.outputSha256, "outputSha256");

    return await this.#mutate(
      // append one immutable due completion
      (records) => {
        const existing = findDueCompletion(records, input.dueKey);

        // prohibit terminal output without immutable due registration
        if (findDueRegistration(records, input.dueKey) === undefined) {
          throw stateError("due_key_unregistered");
        }

        // reuse only one exact completion
        if (existing !== undefined) {
          // reject changing one terminal due output
          if (existing.payload.outputSha256 !== input.outputSha256) {
            throw stateError("due_completion_collision");
          }
          return { records: [], result: { status: "already_complete" } };
        }
        return {
          records: [{
            dueKey: input.dueKey,
            kind: "due_completed",
            payload: { outputSha256: input.outputSha256 },
            recordKey: `due/${input.dueKey}/complete`,
            recordedAt: input.now,
          }],
          result: { status: "complete" },
        };
      },
    );
  }

  // bind immutable v1 history into one ledger-v2 genesis
  async initializeLifecycle(input) {
    requireExactKeys(input, ["now", "v1LedgerSha256", "v1TailSha256"], "lifecycle genesis");
    requireInstant(input.now, "now");
    requireSha256(input.v1LedgerSha256, "v1LedgerSha256");
    requireSha256(input.v1TailSha256, "v1TailSha256");

    return await this.#appendUnique({
      dueKey: null,
      kind: "lifecycle_genesis",
      payload: {
        contractVersion: ADJUSTMENT_LIFECYCLE_LEDGER_CONTRACT_VERSION,
        v1LedgerSha256: input.v1LedgerSha256,
        v1TailSha256: input.v1TailSha256,
      },
      recordKey: "lifecycle/genesis",
      recordedAt: input.now,
    });
  }

  // preregister one blinded action-bearing confirmation member
  async preregisterConfirmation(input) {
    requireExactKeys(input, [
      "candidateKind",
      "candidateSha256",
      "cohortLineageSha256",
      "family",
      "firstTargetAt",
      "gateManifestSha256",
      "inputHeadSha256",
      "intervalEndExclusiveLocalDate",
      "intervalStartLocalDate",
      "now",
      "reservedKeySha256",
      "sourceLineageSha256",
      "terminalAccessAt",
    ], "confirmation registration");
    validateConfirmationRegistrationInput(input);

    return await this.#mutate(
      // enforce genesis, embargo and one active member per family
      (records) => {
        requireLifecycleGenesis(records);
        const familyRecords = confirmationRecords(records, input.family);
        const active = findActiveConfirmation(familyRecords);

        // prohibit concurrent action-bearing family members
        if (active !== null) {
          throw stateError("confirmation_slot_occupied");
        }

        const embargo = findLatestKind(familyRecords, "confirmation_result");

        // enforce the full post-disposition embargo
        if (embargo !== undefined &&
          Date.parse(input.now) < Date.parse(embargo.payload.nextConfirmationEligibleAt)) {
          throw stateError("confirmation_embargo_active");
        }

        const priorRegistrations = records.filter(
          // select every retained confirmation registration
          (record) => record.kind === "confirmation_registered",
        );
        const reused = priorRegistrations.some(
          // reject reserved-key reuse and overlapping same-lineage members
          (record) => record.payload.reservedKeySha256 === input.reservedKeySha256 ||
            (record.payload.sourceLineageSha256 === input.sourceLineageSha256 &&
              localDateIntervalsOverlap(
                record.payload.intervalStartLocalDate,
                record.payload.intervalEndExclusiveLocalDate,
                input.intervalStartLocalDate,
                input.intervalEndExclusiveLocalDate,
              )),
        );

        // prohibit reused or overlapping designated members
        if (reused) {
          throw stateError("confirmation_member_reused");
        }

        const registrationPayload = {
          contractVersion: ADJUSTMENT_LIFECYCLE_LEDGER_CONTRACT_VERSION,
          family: input.family,
          candidateKind: input.candidateKind,
          candidateSha256: input.candidateSha256,
          cohortLineageSha256: input.cohortLineageSha256,
          sourceLineageSha256: input.sourceLineageSha256,
          reservedKeySha256: input.reservedKeySha256,
          intervalStartLocalDate: input.intervalStartLocalDate,
          intervalEndExclusiveLocalDate: input.intervalEndExclusiveLocalDate,
          firstTargetAt: input.firstTargetAt,
          terminalAccessAt: input.terminalAccessAt,
          gateManifestSha256: input.gateManifestSha256,
          inputHeadSha256: input.inputHeadSha256,
        };
        const registrationSha256 = sha256(canonicalJsonBytes(registrationPayload));
        const lifecyclePayload = {
          ...registrationPayload,
          registrationSha256,
          candidateReportSha256: null,
          actionIdentitySha256: null,
          accessState: "registered",
          actionState: "none",
        };
        return {
          records: [{
            dueKey: `confirmation/${input.family}/${input.candidateSha256}`,
            kind: "confirmation_registered",
            payload: lifecyclePayload,
            recordKey: `confirmation/${input.family}/${registrationSha256}/registered`,
            recordedAt: input.now,
          }],
          result: { registrationSha256, status: "registered" },
        };
      },
    );
  }

  // record one value-blind immutable comparator snapshot
  async recordRevisionSnapshot(input) {
    requireExactKeys(input, [
      "entryCount",
      "expectedKeySetSha256",
      "family",
      "now",
      "registrationSha256",
      "revisionCatalogWatermarkSha256",
      "snapshotRootSha256",
      "targetCutoffAt",
    ], "revision snapshot");
    requireFamily(input.family);
    requireInstant(input.now, "now");
    requireInstant(input.targetCutoffAt, "targetCutoffAt");
    requireSha256(input.registrationSha256, "registrationSha256");
    requireSha256(input.expectedKeySetSha256, "expectedKeySetSha256");
    requireSha256(input.revisionCatalogWatermarkSha256, "revisionCatalogWatermarkSha256");
    requireSha256(input.snapshotRootSha256, "snapshotRootSha256");

    // require one bounded value-free key count
    if (!Number.isSafeInteger(input.entryCount) || input.entryCount < 0 ||
      input.entryCount > 9_500_000) {
      throw new TypeError("snapshot entryCount is invalid");
    }
    assertValueBlind(input);
    return await this.#mutate(
      // append one value-blind lifecycle snapshot record
      (records) => {
        const registration = findRegistration(records, input.family, input.registrationSha256);

        // reject unknown or cross-family registrations
        if (registration === undefined) {
          throw stateError("confirmation_registration_unknown");
        }
        return uniqueMutation(records, {
          dueKey: registration.dueKey,
          kind: "confirmation_revision_snapshot",
          payload: {
            ...lifecycleContext(registration.payload, "snapshot_frozen", "none"),
            entryCount: input.entryCount,
            expectedKeySetSha256: input.expectedKeySetSha256,
            revisionCatalogWatermarkSha256: input.revisionCatalogWatermarkSha256,
            snapshotRootSha256: input.snapshotRootSha256,
            targetCutoffAt: input.targetCutoffAt,
          },
          recordKey: `confirmation/${input.family}/${input.registrationSha256}/confirmation_revision_snapshot`,
          recordedAt: input.now,
        });
      },
    );
  }

  // burn one registered member after terminal access
  async burnConfirmation(input) {
    requireExactKeys(input, ["family", "now", "registrationSha256"], "confirmation burn");
    requireFamily(input.family);
    requireInstant(input.now, "now");
    requireSha256(input.registrationSha256, "registrationSha256");

    return await this.#mutate(
      // bind access to the exact preregistration and frozen snapshot
      (records) => {
        const registration = findRegistration(records, input.family, input.registrationSha256);
        const snapshot = findConfirmationKind(
          records,
          input.registrationSha256,
          "confirmation_revision_snapshot",
        );

        // require exact registration and snapshot before access
        if (registration === undefined || snapshot === undefined) {
          throw stateError("confirmation_snapshot_unavailable");
        }

        // permanently refuse premature designated-member access
        if (Date.parse(input.now) < Date.parse(registration.payload.terminalAccessAt)) {
          throw stateError("confirmation_access_premature");
        }

        const existing = findConfirmationKind(
          records,
          input.registrationSha256,
          "confirmation_burned",
        );

        // preserve one immutable burn identity
        if (existing !== undefined) {
          return { records: [], result: existing.payload };
        }

        const payload = {
          ...lifecycleContext(registration.payload, "burned", "none"),
          targetComparatorSnapshotRootSha256: snapshot.payload.snapshotRootSha256,
          revisionCatalogWatermarkSha256: snapshot.payload.revisionCatalogWatermarkSha256,
          expectedKeySetSha256: snapshot.payload.expectedKeySetSha256,
          targetCutoffAt: snapshot.payload.targetCutoffAt,
          accessedAt: input.now,
        };
        const accessSha256 = sha256(canonicalJsonBytes(payload));
        return {
          records: [{
            dueKey: registration.dueKey,
            kind: "confirmation_burned",
            payload: { ...payload, accessSha256 },
            recordKey: `confirmation/${input.family}/${input.registrationSha256}/burned`,
            recordedAt: input.now,
          }],
          result: { ...payload, accessSha256 },
        };
      },
    );
  }

  // append one deterministic immutable confirmation chunk
  async appendConfirmationChunk(input) {
    requireExactKeys(input, ["chunk", "family", "now", "registrationSha256"], "confirmation chunk input");
    requireFamily(input.family);
    requireInstant(input.now, "now");
    requireSha256(input.registrationSha256, "registrationSha256");
    const normalizedChunk = validateConfirmationChunk(input.chunk, input.family);
    assertValueBlind(normalizedChunk);

    return await this.#mutate(
      // append only the first absent ordered chunk
      (records) => {
        const registration = findRegistration(records, input.family, input.registrationSha256);
        const burn = findConfirmationKind(records, input.registrationSha256, "confirmation_burned");

        // require durable burn before chunk assembly
        if (registration === undefined || burn === undefined) {
          throw stateError("confirmation_not_burned");
        }

        const chunks = confirmationChunks(records, input.registrationSha256);
        const existing = chunks.find(
          // locate an exact chunk retry
          (record) => record.payload.chunk.chunkIndex === normalizedChunk.chunkIndex,
        );

        // reuse only byte-identical chunk metadata
        if (existing !== undefined) {
          // reject changing one immutable chunk
          if (!canonicalJsonBytes(existing.payload.chunk).equals(canonicalJsonBytes(normalizedChunk))) {
            throw stateError("confirmation_chunk_collision");
          }
          return { records: [], result: { status: "already_present" } };
        }

        // require deterministic first-absent resume order
        if (normalizedChunk.chunkIndex !== chunks.length) {
          throw stateError("confirmation_chunk_order_refused");
        }
        return {
          records: [{
            dueKey: registration.dueKey,
            kind: "confirmation_chunk",
            payload: {
              ...lifecycleContext(registration.payload, "burned", "none"),
              chunk: normalizedChunk,
            },
            recordKey: `confirmation/${input.family}/${input.registrationSha256}/chunk/${normalizedChunk.chunkIndex}`,
            recordedAt: input.now,
          }],
          result: { status: "appended", chunkIndex: normalizedChunk.chunkIndex },
        };
      },
    );
  }

  // finalize one complete 27/27/24 member manifest
  async finalizeConfirmationMember(input) {
    requireExactKeys(input, ["family", "now", "registrationSha256"], "confirmation finalization");
    requireFamily(input.family);
    requireInstant(input.now, "now");
    requireSha256(input.registrationSha256, "registrationSha256");

    return await this.#mutate(
      // assemble only from immutable registration, burn and chunks
      (records) => {
        const registration = findRegistration(records, input.family, input.registrationSha256);
        const burn = findConfirmationKind(records, input.registrationSha256, "confirmation_burned");
        const chunks = confirmationChunks(records, input.registrationSha256).map(
          // select immutable chunk metadata
          (record) => record.payload.chunk,
        );

        // require exact chronology records
        if (registration === undefined || burn === undefined) {
          throw stateError("confirmation_not_burned");
        }

        const manifest = assembleConfirmationManifest({
          access: burn.payload,
          chunks,
          registration: registration.payload,
        });
        const completePayload = {
          ...lifecycleContext(registration.payload, "member_complete", "none"),
          ...manifest,
        };
        const existing = findConfirmationKind(
          records,
          input.registrationSha256,
          "confirmation_member_complete",
        );

        // reuse only the exact deterministic full root
        if (existing !== undefined) {
          // reject a divergent repeat assembly
          if (existing.payload.fullMemberRootSha256 !== manifest.fullMemberRootSha256) {
            throw stateError("confirmation_manifest_collision");
          }
          return { records: [], result: existing.payload };
        }
        return {
          records: [{
            dueKey: registration.dueKey,
            kind: "confirmation_member_complete",
            payload: completePayload,
            recordKey: `confirmation/${input.family}/${input.registrationSha256}/complete`,
            recordedAt: input.now,
          }],
          result: completePayload,
        };
      },
    );
  }

  // record exactly one terminal family result and embargo
  async recordConfirmationResult(input) {
    requireExactKeys(input, [
      "actionIdentitySha256",
      "candidateReportSha256",
      "disposition",
      "family",
      "nextConfirmationEligibleAt",
      "now",
      "registrationSha256",
    ], "confirmation result");
    requireFamily(input.family);
    requireInstant(input.now, "now");
    requireInstant(input.nextConfirmationEligibleAt, "nextConfirmationEligibleAt");
    requireSha256(input.registrationSha256, "registrationSha256");
    requireSha256(input.candidateReportSha256, "candidateReportSha256");
    requireNullableSha256(input.actionIdentitySha256, "actionIdentitySha256");

    // require one closed terminal disposition
    if (!new Set(["promoted", "rejected", "resource_refused", "support_failed"]).has(input.disposition)) {
      throw new TypeError("confirmation disposition is invalid");
    }

    // require at least the seven-day post-disposition embargo
    if (Date.parse(input.nextConfirmationEligibleAt) < Date.parse(input.now) + 7 * 86_400_000) {
      throw stateError("confirmation_embargo_invalid");
    }

    return await this.#mutate(
      // score only one complete immutable member
      (records) => {
        const complete = findConfirmationKind(
          records,
          input.registrationSha256,
          "confirmation_member_complete",
        );

        // prohibit partial or repeated-look scoring
        if (complete === undefined) {
          throw stateError("confirmation_member_incomplete");
        }

        const existing = findConfirmationKind(records, input.registrationSha256, "confirmation_result");
        const payload = {
          ...lifecycleContext(
            findRegistration(records, input.family, input.registrationSha256).payload,
            "opened",
            input.disposition === "promoted" ? "action_pending" : "terminal_no_action",
          ),
          fullMemberRootSha256: complete.payload.fullMemberRootSha256,
          candidateReportSha256: input.candidateReportSha256,
          actionIdentitySha256: input.actionIdentitySha256,
          disposition: input.disposition,
          nextConfirmationEligibleAt: input.nextConfirmationEligibleAt,
        };

        // reuse only one exact terminal result
        if (existing !== undefined) {
          // reject rescoring or redisposition
          if (!canonicalJsonBytes(existing.payload).equals(canonicalJsonBytes(payload))) {
            throw stateError("confirmation_result_collision");
          }
          return { records: [], result: existing.payload };
        }
        return {
          records: [{
            dueKey: complete.dueKey,
            kind: "confirmation_result",
            payload,
            recordKey: `confirmation/${input.family}/${input.registrationSha256}/result`,
            recordedAt: input.now,
          }],
          result: payload,
        };
      },
    );
  }

  // append one exact unique journal event
  async #appendUnique(event) {
    return await this.#mutate(
      // enforce record-key idempotence
      (records) => uniqueMutation(records, event),
    );
  }

  // run one exclusive append transaction
  async #mutate(builder) {
    return await this.#store.withLock(
      // verify, decide and durably append under one held lock
      async (transaction) => {
        const existing = verifyJournalBytes(await transaction.readJournal());
        const mutation = builder(existing);

        // return idempotent results without filesystem mutation
        if (mutation.records.length === 0) {
          return mutation.result;
        }

        const appended = appendJournalRecords(existing, mutation.records);
        const newRecords = appended.slice(existing.length);
        await transaction.append(
          Buffer.concat(newRecords.map(
            // encode one append-only journal line
            (record) => canonicalJsonBytes(record),
          )),
          headsForRecords(appended),
        );
        return mutation.result;
      },
    );
  }

  // read one verified journal projection
  async #read(project) {
    return await this.#store.withLock(
      // read under the same exclusive journal lock
      async (transaction) => project(verifyJournalBytes(await transaction.readJournal())),
    );
  }
}

// deterministically assemble one full confirmation manifest
export function assembleConfirmationManifest(input) {
  requireExactKeys(input, ["access", "chunks", "registration"], "confirmation assembly");
  const registration = input.registration;
  const access = input.access;
  requireFamily(registration.family);
  requireSha256(registration.registrationSha256, "registrationSha256");
  requireSha256(access.accessSha256, "accessSha256");
  requireSha256(access.targetComparatorSnapshotRootSha256, "targetComparatorSnapshotRootSha256");
  requireSha256(access.revisionCatalogWatermarkSha256, "revisionCatalogWatermarkSha256");
  requireSha256(access.expectedKeySetSha256, "expectedKeySetSha256");
  requireInstant(access.targetCutoffAt, "targetCutoffAt");
  const chunkCount = CONFIRMATION_CHUNK_COUNTS.get(registration.family);

  // require the exact complete family chunk count
  if (!Array.isArray(input.chunks) || input.chunks.length !== chunkCount) {
    throw stateError("confirmation_chunk_count_incomplete");
  }

  const chunks = input.chunks.map(
    // validate each ordered immutable chunk
    (chunk, index) => {
      const normalized = validateConfirmationChunk(chunk, registration.family);

      // require consecutive chunk order
      if (normalized.chunkIndex !== index) {
        throw stateError("confirmation_chunk_order_refused");
      }
      return normalized;
    },
  );
  let expectedStart = registration.intervalStartLocalDate;

  // prove exact no-gap local-date partitions
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const expectedDays = index === chunks.length - 1
      ? CONFIRMATION_INTERVAL_DAYS.get(registration.family) - 14 * (chunks.length - 1)
      : 14;
    const expectedEnd = addLocalDates(expectedStart, expectedDays);

    // reject a gap, overlap or wrong final partition
    if (chunk.fromLocalDate !== expectedStart ||
      chunk.toLocalDateExclusive !== expectedEnd) {
      throw stateError("confirmation_partition_invalid");
    }
    expectedStart = expectedEnd;
  }

  // require exact registration interval coverage
  if (expectedStart !== registration.intervalEndExclusiveLocalDate) {
    throw stateError("confirmation_interval_invalid");
  }

  const projectedChunks = chunks.map(
    // bind only immutable ordered chunk metadata
    (chunk) => ({
      chunkIndex: chunk.chunkIndex,
      fromLocalDate: chunk.fromLocalDate,
      toLocalDateExclusive: chunk.toLocalDateExclusive,
      chunkSha256: chunk.chunkSha256,
      recordCount: chunk.recordCount,
      expectedKeySubsetSha256: chunk.expectedKeySubsetSha256,
    }),
  );
  const eligiblePredictionSetSha256 = sha256(canonicalJsonBytes(chunks.map(
    // bind every ordered eligible subset root
    (chunk) => chunk.eligiblePredictionSubsetSha256,
  )));
  const missingKeySetSha256 = sha256(canonicalJsonBytes(chunks.map(
    // bind every ordered missing subset root
    (chunk) => chunk.missingKeySubsetSha256,
  )));
  const manifestWithoutRoot = {
    contractVersion: "adjustment-confirmation-member/v2",
    family: registration.family,
    registrationSha256: registration.registrationSha256,
    accessSha256: access.accessSha256,
    intervalStartLocalDate: registration.intervalStartLocalDate,
    intervalEndExclusiveLocalDate: registration.intervalEndExclusiveLocalDate,
    targetCutoffAt: access.targetCutoffAt,
    targetComparatorSnapshotRootSha256: access.targetComparatorSnapshotRootSha256,
    revisionCatalogWatermarkSha256: access.revisionCatalogWatermarkSha256,
    expectedKeySetSha256: access.expectedKeySetSha256,
    eligiblePredictionSetSha256,
    missingKeySetSha256,
    chunkCount,
    chunks: projectedChunks,
  };
  return {
    ...manifestWithoutRoot,
    fullMemberRootSha256: sha256(canonicalJsonBytes(manifestWithoutRoot)),
  };
}

// hold the one fixed production journal root
class FixedRootJournalStore {
  #root = ADJUSTMENT_DEFAULT_STATE_ROOT;

  // create and prove the owner-private state root
  async initialize() {
    await ensureAdjustmentPrivateDirectory("state");
    await assertPrivateDirectory(this.#root);
    const resolvedRoot = await realpath(this.#root);

    // require the exact fixed HOME root without symlink drift
    if (resolvedRoot !== resolve(this.#root)) {
      throw stateError("state_path_refused");
    }
    const filesystem = await statfs(resolvedRoot, { bigint: true });

    // require the same native ext4 boundary as the archive
    if (BigInt(filesystem.type) !== EXT4_MAGIC) {
      throw stateError("state_filesystem_refused");
    }
    return { rootKind: ADJUSTMENT_MAINTENANCE_STATE_ROOT_KIND };
  }

  // execute one callback while a kernel flock holder remains alive
  async withLock(callback) {
    const lockPath = join(this.#root, "journal.lock");
    const lockHandle = await open(
      lockPath,
      fsConstants.O_CREAT | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const holder = spawn(
      "flock",
      ["--exclusive", "--nonblock", lockPath, "sh", "-c", "printf ready; cat >/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    try {
      const ready = await waitForLockHolder(holder);

      // refuse an unavailable exclusive lock
      if (ready !== "ready") {
        throw stateError("journal_lock_occupied");
      }

      const transaction = this.#transaction();
      return await callback(transaction);
    } finally {
      holder.stdin.end();
      await waitForExit(holder).catch(() => undefined);
      await lockHandle.close();
    }
  }

  // create one lock-scoped durable transaction port
  #transaction() {
    return {
      // read the complete bounded append-only journal
      readJournal: async () => {
        const path = join(this.#root, "journal.jsonl");

        try {
          const details = await assertPrivateFile(path);

          // reject an unbounded journal read
          if (details.size > MAXIMUM_JOURNAL_BYTES) {
            throw stateError("journal_size_refused");
          }
          return await readFile(path);
        } catch (error) {
          // treat only absence as genesis
          if (error?.code === "ENOENT") {
            return Buffer.alloc(0);
          }
          throw error;
        }
      },
      // append, fsync and rotate both head slots
      append: async (bytes, heads) => {
        const path = join(this.#root, "journal.jsonl");
        const handle = await open(
          path,
          fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );

        try {
          const details = await handle.stat();

          // reject linked, foreign, broad or oversized append targets
          if (!details.isFile() || details.uid !== process.getuid() ||
            (details.mode & 0o777) !== 0o600 || details.nlink !== 1 ||
            details.size + bytes.length > MAXIMUM_JOURNAL_BYTES) {
            throw stateError("journal_append_refused");
          }
          await handle.writeFile(bytes);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await this.#writeHeads(heads);
      },
      // reconcile bounded head projections
      writeHeads: async (heads) => await this.#writeHeads(heads),
    };
  }

  // atomically write current and previous journal heads
  async #writeHeads(heads) {
    const currentPath = join(this.#root, "head.current");
    const previousPath = join(this.#root, "head.previous");
    await writeAtomicPrivateFile(currentPath, canonicalJsonBytes(heads.current));

    // write or remove only the bounded previous projection
    if (heads.previous === null) {
      try {
        await unlink(previousPath);
      } catch (error) {
        // ignore only an absent genesis slot
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    } else {
      await writeAtomicPrivateFile(previousPath, canonicalJsonBytes(heads.previous));
    }
    await syncDirectory(this.#root);
  }
}

// append canonical hash-chained journal records
function appendJournalRecords(existing, additions) {
  const records = [...existing];
  let previousSha256 = records.at(-1)?.recordSha256 ?? null;
  let generation = BigInt(records.at(-1)?.generation ?? "0");

  // append every requested record in one deterministic order
  for (const addition of additions) {
    validateJournalAddition(addition);
    generation += 1n;

    // stop rather than wrap the unsigned generation
    if (generation > ADJUSTMENT_MAXIMUM_FENCING_TOKEN) {
      throw stateError("journal_generation_exhausted");
    }
    const payloadSha256 = sha256(canonicalJsonBytes(addition.payload));
    const withoutHash = {
      contractVersion: ADJUSTMENT_JOURNAL_CONTRACT_VERSION,
      generation: generation.toString(),
      kind: addition.kind,
      recordKey: addition.recordKey,
      dueKey: addition.dueKey,
      recordedAt: addition.recordedAt,
      previousSha256,
      payloadSha256,
      payload: addition.payload,
    };
    const record = { ...withoutHash, recordSha256: sha256(canonicalJsonBytes(withoutHash)) };
    records.push(record);
    previousSha256 = record.recordSha256;
  }
  return records;
}

// verify the complete append-only journal chain
export function verifyJournalBytes(bytes) {
  // require one bounded immutable byte buffer
  if (!Buffer.isBuffer(bytes) || bytes.length > MAXIMUM_JOURNAL_BYTES) {
    throw new TypeError("journal bytes are invalid");
  }

  // return the exact empty genesis journal
  if (bytes.length === 0) {
    return [];
  }

  // require one newline-terminated canonical journal
  if (bytes.at(-1) !== 0x0a) {
    throw new TypeError("journal is not newline terminated");
  }
  const lines = bytes.toString("utf8").slice(0, -1).split("\n");
  let previousSha256 = null;
  const records = [];

  // verify every generation and predecessor hash
  for (let index = 0; index < lines.length; index += 1) {
    let record;

    try {
      record = JSON.parse(lines[index]);
    } catch {
      throw new TypeError("journal JSON is invalid");
    }
    validateJournalRecord(record, index + 1, previousSha256);

    // require exact canonical line bytes
    if (canonicalJsonBytes(record).toString("utf8").slice(0, -1) !== lines[index]) {
      throw new TypeError("journal record is not canonical");
    }
    records.push(record);
    previousSha256 = record.recordSha256;
  }
  return records;
}

// validate one complete journal record
function validateJournalRecord(record, expectedGeneration, previousSha256) {
  requireExactKeys(record, [
    "contractVersion",
    "generation",
    "kind",
    "recordKey",
    "dueKey",
    "recordedAt",
    "previousSha256",
    "payloadSha256",
    "payload",
    "recordSha256",
  ], "journal record");

  // require exact contract, generation and predecessor
  if (record.contractVersion !== ADJUSTMENT_JOURNAL_CONTRACT_VERSION ||
    record.generation !== String(expectedGeneration) ||
    record.previousSha256 !== previousSha256) {
    throw new TypeError("journal chain is invalid");
  }
  requireRecordKey(record.recordKey);
  requireNullableDueKey(record.dueKey);
  requireInstant(record.recordedAt, "recordedAt");
  requireSha256(record.payloadSha256, "payloadSha256");
  requireSha256(record.recordSha256, "recordSha256");
  requirePlainObject(record.payload, "journal payload");

  // bind the exact payload bytes
  if (sha256(canonicalJsonBytes(record.payload)) !== record.payloadSha256) {
    throw new TypeError("journal payload hash is invalid");
  }
  const withoutHash = { ...record };
  delete withoutHash.recordSha256;

  // bind the exact record bytes
  if (sha256(canonicalJsonBytes(withoutHash)) !== record.recordSha256) {
    throw new TypeError("journal record hash is invalid");
  }
}

// validate one pending journal addition
function validateJournalAddition(addition) {
  requireExactKeys(addition, ["dueKey", "kind", "payload", "recordKey", "recordedAt"], "journal addition");
  requireNullableDueKey(addition.dueKey);
  requireRecordKey(addition.recordKey);
  requireInstant(addition.recordedAt, "recordedAt");
  requirePlainObject(addition.payload, "journal payload");

  // require one bounded closed event kind
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(addition.kind)) {
    throw new TypeError("journal kind is invalid");
  }
}

// derive bounded current and previous head projections
function headsForRecords(records) {
  const current = records.at(-1);
  const previous = records.at(-2);
  return {
    current: current === undefined
      ? { generation: "0", recordSha256: null }
      : { generation: current.generation, recordSha256: current.recordSha256 },
    previous: previous === undefined
      ? null
      : { generation: previous.generation, recordSha256: previous.recordSha256 },
  };
}

// derive active leases without removing unknown history
function deriveActiveLeases(records) {
  const active = new Map();

  // apply append-only lease transitions in order
  for (const record of records) {
    // open one exact lease scope
    if (record.kind === "lease_acquired") {
      active.set(record.payload.scope, record);
    }

    // close only the matching retained lease
    if (record.kind === "lease_released" || record.kind === "lease_reconciled") {
      const current = active.get(record.payload.scope);

      // retain unrelated or mismatched lease evidence
      if (current !== undefined && current.payload.runId === record.payload.runId &&
        current.payload.dueKey === record.payload.dueKey) {
        active.delete(record.payload.scope);
      }
    }
  }
  return active;
}

// enforce monotonic clock trust and expired reconciliation
function enforceTrustedClock(records, now, options = {}) {
  const maxSeenUtc = deriveMaxSeenUtc(records);

  // stop acquisitions after a material clock rollback
  if (maxSeenUtc !== null &&
    Date.parse(now) < Date.parse(maxSeenUtc) - CLOCK_ROLLBACK_TOLERANCE_MS) {
    throw stateError("clock_untrusted");
  }

  // force reconciliation for any expired active lease after a forward jump
  if (options.allowExpired !== true) {
    const expired = [...deriveActiveLeases(records).values()].some(
      // detect any lease whose maximum interval passed
      (record) => Date.parse(record.payload.expiresAt) <= Date.parse(now),
    );

    // refuse blind takeover after a forward jump
    if (expired) {
      throw stateError("reconciliation_required");
    }
  }
}

// derive the greatest observed journal instant
function deriveMaxSeenUtc(records) {
  return records.reduce(
    // retain the later canonical timestamp
    (maximum, record) => maximum === null || record.recordedAt > maximum
      ? record.recordedAt
      : maximum,
    null,
  );
}

// allocate one monotonic unsigned release fencing token
function allocateFencingToken(records) {
  const maximum = deriveMaximumFencingToken(records);

  // stop permanently rather than wrap
  if (maximum === ADJUSTMENT_MAXIMUM_FENCING_TOKEN) {
    throw stateError("fencing_token_exhausted");
  }
  return maximum + 1n;
}

// derive the greatest durable fencing token
function deriveMaximumFencingToken(records) {
  return records.reduce(
    // retain only release lease token maxima
    (maximum, record) => record.kind === "lease_acquired" &&
      record.payload.fencingToken !== null && BigInt(record.payload.fencingToken) > maximum
      ? BigInt(record.payload.fencingToken)
      : maximum,
    0n,
  );
}

// return one idempotent unique mutation
function uniqueMutation(records, event) {
  const existing = records.find(
    // find one exact logical record key
    (record) => record.recordKey === event.recordKey,
  );

  // reuse only an exact immutable event
  if (existing !== undefined) {
    const payloadSha256 = sha256(canonicalJsonBytes(event.payload));

    // reject record-key collision
    if (existing.kind !== event.kind || existing.dueKey !== event.dueKey ||
      existing.payloadSha256 !== payloadSha256) {
      throw stateError("journal_record_collision");
    }
    return { records: [], result: existing };
  }
  return { records: [event], result: { status: "appended" } };
}

// find one due registration
function findDueRegistration(records, dueKey) {
  return records.find(
    // match one immutable due key
    (record) => record.kind === "due_registered" && record.dueKey === dueKey,
  );
}

// find one due completion
function findDueCompletion(records, dueKey) {
  return records.find(
    // match one terminal due key
    (record) => record.kind === "due_completed" && record.dueKey === dueKey,
  );
}

// require one lifecycle genesis
function requireLifecycleGenesis(records) {
  // refuse a v2 lifecycle without its immutable v1 tail
  if (!records.some((record) => record.kind === "lifecycle_genesis")) {
    throw stateError("lifecycle_genesis_missing");
  }
}

// select one family's confirmation records
function confirmationRecords(records, family) {
  return records.filter(
    // retain records carrying the exact family registration
    (record) => record.payload.family === family ||
      record.dueKey?.startsWith(`confirmation/${family}/`) === true,
  );
}

// find one active family registration
function findActiveConfirmation(records) {
  const registrations = records.filter(
    // select preregistered confirmation members
    (record) => record.kind === "confirmation_registered",
  );

  return registrations.find(
    // retain a registration without a terminal result
    (registration) => !records.some((record) =>
      record.kind === "confirmation_result" &&
      record.payload.registrationSha256 === registration.payload.registrationSha256),
  ) ?? null;
}

// find one exact registration
function findRegistration(records, family, registrationSha256) {
  return records.find(
    // bind family and registration identity
    (record) => record.kind === "confirmation_registered" &&
      record.payload.family === family &&
      record.payload.registrationSha256 === registrationSha256,
  );
}

// find one confirmation-scoped kind
function findConfirmationKind(records, registrationSha256, kind) {
  return records.find(
    // bind kind and registration identity
    (record) => record.kind === kind &&
      record.payload.registrationSha256 === registrationSha256,
  );
}

// list ordered confirmation chunk records
function confirmationChunks(records, registrationSha256) {
  return records.filter(
    // select exact registration chunks
    (record) => record.kind === "confirmation_chunk" &&
      record.payload.registrationSha256 === registrationSha256,
  ).sort(
    // restore deterministic chunk order
    (left, right) => left.payload.chunk.chunkIndex - right.payload.chunk.chunkIndex,
  );
}

// find the latest record of one kind
function findLatestKind(records, kind) {
  return records.findLast(
    // match one event kind
    (record) => record.kind === kind,
  );
}

// project one complete ledger-v2 lifecycle context
function lifecycleContext(registration, accessState, actionState) {
  return {
    contractVersion: ADJUSTMENT_LIFECYCLE_LEDGER_CONTRACT_VERSION,
    family: registration.family,
    candidateKind: registration.candidateKind,
    candidateSha256: registration.candidateSha256,
    cohortLineageSha256: registration.cohortLineageSha256,
    sourceLineageSha256: registration.sourceLineageSha256,
    reservedKeySha256: registration.reservedKeySha256,
    intervalStartLocalDate: registration.intervalStartLocalDate,
    intervalEndExclusiveLocalDate: registration.intervalEndExclusiveLocalDate,
    firstTargetAt: registration.firstTargetAt,
    terminalAccessAt: registration.terminalAccessAt,
    gateManifestSha256: registration.gateManifestSha256,
    inputHeadSha256: registration.inputHeadSha256,
    registrationSha256: registration.registrationSha256,
    candidateReportSha256: null,
    actionIdentitySha256: null,
    accessState,
    actionState,
  };
}

// validate registration chronology and identities
function validateConfirmationRegistrationInput(input) {
  requireFamily(input.family);

  // require the one family-specific candidate kind
  if (input.candidateKind !== FAMILY_CANDIDATE_KINDS.get(input.family)) {
    throw new TypeError("candidateKind is invalid");
  }
  requireSha256(input.candidateSha256, "candidateSha256");
  requireSha256(input.cohortLineageSha256, "cohortLineageSha256");
  requireSha256(input.gateManifestSha256, "gateManifestSha256");
  requireSha256(input.inputHeadSha256, "inputHeadSha256");
  requireSha256(input.reservedKeySha256, "reservedKeySha256");
  requireSha256(input.sourceLineageSha256, "sourceLineageSha256");
  requireInstant(input.firstTargetAt, "firstTargetAt");
  requireInstant(input.now, "now");
  requireInstant(input.terminalAccessAt, "terminalAccessAt");
  requireLocalDate(input.intervalStartLocalDate, "intervalStartLocalDate");
  requireLocalDate(input.intervalEndExclusiveLocalDate, "intervalEndExclusiveLocalDate");

  // require preregistration before first target and access after it
  if (Date.parse(input.now) >= Date.parse(input.firstTargetAt) ||
    Date.parse(input.terminalAccessAt) <= Date.parse(input.firstTargetAt) ||
    daysBetween(input.intervalStartLocalDate, input.intervalEndExclusiveLocalDate) !==
      CONFIRMATION_INTERVAL_DAYS.get(input.family)) {
    throw stateError("confirmation_chronology_invalid");
  }

  // freeze the one causally reachable rain confirmation interval
  if (input.family === "rain" &&
    (input.intervalStartLocalDate !== "2026-10-31" ||
      input.intervalEndExclusiveLocalDate !== "2027-09-30")) {
    throw stateError("rain_confirmation_slot_invalid");
  }
}

// validate one value-blind chunk manifest
function validateConfirmationChunk(chunk, family) {
  requireExactKeys(chunk, [
    "chunkIndex",
    "fromLocalDate",
    "toLocalDateExclusive",
    "chunkSha256",
    "recordCount",
    "expectedKeySubsetSha256",
    "eligiblePredictionSubsetSha256",
    "missingKeySubsetSha256",
  ], "confirmation chunk");
  const count = CONFIRMATION_CHUNK_COUNTS.get(family);

  // require one exact family chunk index and bounded reference count
  if (!Number.isInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 ||
    chunk.chunkIndex >= count || !Number.isSafeInteger(chunk.recordCount) ||
    chunk.recordCount < 0 || chunk.recordCount > 8_192) {
    throw new TypeError("confirmation chunk bounds are invalid");
  }
  requireLocalDate(chunk.fromLocalDate, "fromLocalDate");
  requireLocalDate(chunk.toLocalDateExclusive, "toLocalDateExclusive");
  requireSha256(chunk.chunkSha256, "chunkSha256");
  requireSha256(chunk.expectedKeySubsetSha256, "expectedKeySubsetSha256");
  requireSha256(chunk.eligiblePredictionSubsetSha256, "eligiblePredictionSubsetSha256");
  requireSha256(chunk.missingKeySubsetSha256, "missingKeySubsetSha256");
  return { ...chunk };
}

// reject value-bearing fields from blinded journal events
function assertValueBlind(value) {
  const stack = [value];

  // inspect every nested object without parsing designated values
  while (stack.length > 0) {
    const current = stack.pop();

    // traverse array containers only
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }

    // ignore scalar identity metadata
    if (current === null || typeof current !== "object") {
      continue;
    }

    // reject forbidden keys and traverse metadata values
    for (const [key, nested] of Object.entries(current)) {
      // reject body, row, payload and value exposure
      if (FORBIDDEN_VALUE_KEYS.test(key)) {
        throw stateError("blinded_value_exposure_refused");
      }
      stack.push(nested);
    }
  }
}

// classify one lease scope into a fixed duration
function leaseScopeClass(scope) {
  // require one exact supported scope grammar
  if (scope === "archive" || scope === "daily" || scope === "release") {
    return scope;
  }

  // recognize family-scoped monthly and confirmation leases
  if (/^monthly\/(?:temperature|wind|rain)$/u.test(scope)) {
    return "monthly";
  }

  // recognize one confirmation family scope
  if (/^confirmation\/(?:temperature|wind|rain)$/u.test(scope)) {
    return "confirmation";
  }
  throw new TypeError("lease scope is invalid");
}

// wait until the flock-held command confirms acquisition
async function waitForLockHolder(child) {
  return await new Promise(
    // settle on readiness, error or early exit
    (resolvePromise, rejectPromise) => {
      let output = "";

      // collect the bounded readiness word
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("ascii");

        // resolve only the exact lock readiness marker
        if (output === "ready") {
          resolvePromise(output);
        }
      });
      child.once("error", rejectPromise);
      child.once("exit", () => resolvePromise(output));
    },
  );
}

// wait for one child process exit
async function waitForExit(child) {
  // return immediately after an already observed exit
  if (child.exitCode !== null) {
    return child.exitCode;
  }
  return await new Promise(
    // resolve one process exit
    (resolvePromise, rejectPromise) => {
      child.once("error", rejectPromise);
      child.once("exit", resolvePromise);
    },
  );
}

// atomically replace one owner-private state file
async function writeAtomicPrivateFile(path, bytes) {
  const temporaryPath = join(dirname(path), `.state-${randomUUID()}.tmp`);
  const handle = await open(
    temporaryPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );

  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, path);
}

// fsync one held private directory
async function syncDirectory(path) {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );

  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// prove one owner-private directory
async function assertPrivateDirectory(path) {
  const details = await lstat(path);

  // reject links, foreign ownership and broad access
  if (!details.isDirectory() || details.isSymbolicLink() ||
    details.uid !== process.getuid() || (details.mode & 0o777) !== 0o700) {
    throw stateError("state_directory_refused");
  }
}

// prove one owner-private single-link file
async function assertPrivateFile(path) {
  const details = await lstat(path);

  // reject links, special files, foreign ownership and broad access
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1 ||
    details.uid !== process.getuid() || (details.mode & 0o777) !== 0o600) {
    throw stateError("state_file_refused");
  }
  return details;
}

// calculate one local-date delta
function daysBetween(start, end) {
  return (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) /
    (24 * 60 * 60 * 1_000);
}

// add exact calendar days to one local-date label
function addLocalDates(start, days) {
  return new Date(Date.parse(`${start}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1_000)
    .toISOString().slice(0, 10);
}

// detect overlap between two local-date intervals
function localDateIntervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && rightStart < leftEnd;
}

// encode recursively sorted canonical JSON
function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonicalValue(value))}\n`, "utf8");
}

// recursively normalize canonical JSON values
function canonicalValue(value) {
  // retain JSON scalar values
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  // retain only finite nonnegative-zero numbers
  if (typeof value === "number") {
    // reject nonfinite and negative-zero encodings
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("canonical JSON number is invalid");
    }
    return value;
  }

  // preserve semantic array order
  if (Array.isArray(value)) {
    return value.map(
      // normalize one array member
      (entry) => canonicalValue(entry),
    );
  }

  requirePlainObject(value, "canonical JSON object");
  return Object.fromEntries(Object.keys(value).sort().map(
    // sort and normalize each object field
    (key) => [key, canonicalValue(value[key])],
  ));
}

// calculate one lowercase SHA-256 digest
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

// create one categorical state refusal
function stateError(reason) {
  const error = new Error(reason);
  error.code = "adjustment_state_refused";
  error.reason = reason;
  return error;
}

// require one family
function requireFamily(value) {
  // reject cross-family aliases
  if (!FAMILY_CANDIDATE_KINDS.has(value)) {
    throw new TypeError("family is invalid");
  }
}

// require one canonical local date
function requireLocalDate(value, label) {
  // reject noncanonical or impossible dates
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one canonical UTC millisecond instant
function requireInstant(value, label) {
  // reject noncanonical or impossible instants
  if (typeof value !== "string" || !INSTANT_PATTERN.test(value) ||
    new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one lowercase SHA-256 value
function requireSha256(value, label) {
  // reject noncanonical hashes
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}

// require one nullable SHA-256 value
function requireNullableSha256(value, label) {
  // validate only present hashes
  if (value !== null) {
    requireSha256(value, label);
  }
}

// require one canonical due key
function requireDueKey(value) {
  // reject path escape and unbounded due keys
  if (typeof value !== "string" || value.length > 256 ||
    !/^(?:capture|daily|monthly|confirmation|rollback)\/[a-zA-Z0-9:._/-]+$/u.test(value) ||
    value.includes("..") || value.includes("//")) {
    throw new TypeError("dueKey is invalid");
  }
}

// require one nullable due key
function requireNullableDueKey(value) {
  // validate only present due keys
  if (value !== null) {
    requireDueKey(value);
  }
}

// require one bounded run identity
function requireRunId(value) {
  // reject ambiguous run identifiers
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError("runId is invalid");
  }
}

// require one bounded journal record key
function requireRecordKey(value) {
  // reject path traversal and unbounded keys
  if (typeof value !== "string" || value.length > 512 || value.includes("..") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/u.test(value)) {
    throw new TypeError("recordKey is invalid");
  }
}

// require one plain object
function requirePlainObject(value, label) {
  // reject null, arrays and custom prototypes
  if (value === null || Array.isArray(value) || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

// require one exact closed key set
function requireExactKeys(value, keys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  // reject unknown or missing fields
  if (actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has invalid keys`);
  }
}
