import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { access, mkdir, open, readFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  type ForecastAdjustmentCandidateV2,
  canonicalizeJson,
  type JsonValue,
} from "@weather/domain";

import {
  canonicalJsonBytes,
  canonicalObjectSha256,
  canonicalSha256,
  deepFreeze,
  FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1,
  FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1,
  type ForecastAdjustmentPreregistrationV1,
  verifyForecastAdjustmentPreregistration,
} from "./candidate.js";

const ZERO_HASH = "0".repeat(64);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const localInstantFormatter = new Intl.DateTimeFormat("en-US", {
  calendar: "gregory",
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  numberingSystem: "latn",
  second: "2-digit",
  timeZone: "America/Los_Angeles",
  year: "numeric",
});

export const HOLDOUT_EVIDENCE_DIRECTORY = join(
  homedir(),
  ".weather",
  "model-evidence",
);
export const HOLDOUT_LEDGER_PATH = join(HOLDOUT_EVIDENCE_DIRECTORY, "ledger.jsonl");
export const HOLDOUT_LEDGER_LOCK_PATH = join(
  HOLDOUT_EVIDENCE_DIRECTORY,
  "ledger.lock",
);

// identify all evidence sharing one chronological holdout lineage
export interface HoldoutLineageV1 {
  readonly aggregationContractVersion: string;
  readonly cohort: "legacy_v4_retrieval_snapshot";
  readonly contractEpoch: string;
  readonly dataset: string;
  readonly forecastSourceConfigFingerprint: string;
  readonly forecastSourceKey: string;
  readonly metricEligibilitySha256: string;
  readonly observationSourceLineageSha256: string;
  readonly observationStationManifestSha256: string;
  readonly referenceKind: "retrieval_snapshot";
  readonly siteKey: "ballydidean";
  readonly spatialWeightSha256: string;
  readonly upstreamModel: string;
}

// record one irrevocable holdout access
export interface HoldoutAccessMarkerV1 {
  readonly accessedAtUtc: string;
  readonly candidateArtifactSha256: string;
  readonly contractVersion: "holdout_accessed/v1";
  readonly enabledMetricBandsSha256: string;
  readonly endExclusive: string;
  readonly endLocalDate: string;
  readonly evaluationEpochId: string;
  readonly lineage: HoldoutLineageV1;
  readonly lineageId: string;
  readonly markerSha256: string;
  readonly predecessorSha256: string;
  readonly preregistrationSha256: string;
  readonly siteKey: "ballydidean";
  readonly snapshotManifestSha256: string;
  readonly startInclusive: string;
  readonly startLocalDate: string;
}

// record one complete qualified evidence lifecycle transition
export interface ForecastAdjustmentEvidenceLifecycleRecordV1 {
  readonly candidateArtifactSha256: string;
  readonly contractVersion: "forecast-adjustment-evidence-promoted/v1";
  readonly developmentReportSha256: string;
  readonly evaluationReportSha256: string;
  readonly holdoutAccessMarkerSha256: string;
  readonly predecessorSha256: string;
  readonly preregistrationSha256: string;
  readonly qualificationReceiptSha256: string;
  readonly recordSha256: string;
  readonly snapshotManifestSha256: string;
}

type LedgerRecordV1 =
  | ForecastAdjustmentEvidenceLifecycleRecordV1
  | HoldoutAccessMarkerV1;

// configure one guarded holdout read
export interface GuardedHoldoutAccessInputV1 {
  readonly afterDurableAppendBeforeLockRelease?: (
    marker: HoldoutAccessMarkerV1,
  ) => void | Promise<void>;
  readonly candidate: ForecastAdjustmentCandidateV2;
  readonly directory?: string;
  readonly lineage: HoldoutLineageV1;
  readonly now?: () => string;
  readonly onDurableMarker?: (marker: HoldoutAccessMarkerV1) => void | Promise<void>;
  readonly preregistration: ForecastAdjustmentPreregistrationV1;
}

// derive the exact chronological lineage identity
export function createHoldoutLineageId(lineage: HoldoutLineageV1): string {
  validateLineage(lineage);
  return canonicalSha256(lineage as unknown as JsonValue);
}

// derive lineage only from verified immutable candidate evidence
export function deriveHoldoutLineage(
  candidate: ForecastAdjustmentCandidateV2,
): HoldoutLineageV1 {
  const identity = candidate.forecastIdentity;
  const provenance = candidate.trainingProvenance;

  return deepFreeze({
    aggregationContractVersion: "physical-station-network/v1",
    cohort: identity.cohort,
    contractEpoch: identity.contractEpoch,
    dataset: identity.dataset,
    forecastSourceConfigFingerprint: identity.sourceConfigFingerprint,
    forecastSourceKey: identity.sourceKey,
    metricEligibilitySha256: provenance.metricEligibilitySha256,
    observationSourceLineageSha256: provenance.observationSourceLineageSha256,
    observationStationManifestSha256:
      provenance.observationStationManifestSha256,
    referenceKind: identity.referenceKind,
    siteKey: candidate.siteKey,
    spatialWeightSha256: provenance.spatialWeightSha256,
    upstreamModel: identity.upstreamModel,
  });
}

// write a durable burn marker before opening designated members
export async function withGuardedHoldoutAccess<T>(
  input: GuardedHoldoutAccessInputV1,
  openMembers: (marker: HoldoutAccessMarkerV1) => Promise<T>,
): Promise<T> {
  verifyForecastAdjustmentPreregistration(input.preregistration, input.candidate);
  const lineage = deriveHoldoutLineage(input.candidate);

  // reject caller-controlled parallel lineage before filesystem mutation
  if (
    canonicalizeJson(input.lineage as unknown as JsonValue) !==
    canonicalizeJson(lineage as unknown as JsonValue)
  ) {
    throw new RangeError("holdout lineage does not match immutable candidate evidence");
  }
  const directory = input.directory ?? HOLDOUT_EVIDENCE_DIRECTORY;
  const ledgerPath = join(directory, "ledger.jsonl");
  const lockPath = join(directory, "ledger.lock");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const lock = await acquireLedgerLock(lockPath);
  let marker: HoldoutAccessMarkerV1;

  try {
    const existingBytes = await readFile(ledgerPath, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        // treat only an absent ledger as genesis
        if (error.code === "ENOENT") {
          return "";
        }

        throw boundedFilesystemError(error, "holdout ledger cannot be read");
      },
    );
    const records = parseLedgerRecords(existingBytes);
    const existing = records.filter(isHoldoutAccessMarker);
    assertHoldoutIntervalAvailable(
      existing,
      lineage,
      input.preregistration.holdoutStartLocalDate,
      input.preregistration.holdoutEndLocalDate,
    );
    marker = createHoldoutAccessMarker({
      accessedAtUtc: (input.now ?? (() => new Date().toISOString()))(),
      candidate: input.candidate,
      lineage,
      predecessorSha256:
        ledgerRecordHash(records.at(-1)) ?? ZERO_HASH,
      preregistration: input.preregistration,
    });
    const ledger = await open(ledgerPath, "a+", 0o600);

    try {
      await ledger.writeFile(canonicalJsonBytes(marker as unknown as JsonValue), "utf8");
      await ledger.sync();
      const parent = await open(dirname(ledgerPath), constants.O_RDONLY);

      try {
        await parent.sync();
      } finally {
        await parent.close();
      }

      const durableBytes = await readFile(ledgerPath, "utf8");
      const durable = parseLedgerRecords(durableBytes);
      const durableTail = durable.at(-1);

      // require the exact marker to be durable before access
      if (ledgerRecordHash(durableTail) !== marker.markerSha256) {
        throw new Error("holdout ledger durable-tail verification failed");
      }

      // expose only the crash boundary before lock release
      if (input.afterDurableAppendBeforeLockRelease !== undefined) {
        await input.afterDurableAppendBeforeLockRelease(marker);
      }
    } finally {
      await ledger.close();
    }
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error: unknown) => {
      throw boundedFilesystemError(error, "holdout ledger lock cannot be released");
    });
    await syncDirectory(directory);
  }

  // prove release before any member-open callback
  if (await isHoldoutLedgerLocked(directory)) {
    throw new Error("holdout ledger lock release verification failed");
  }

  // allow fault injection only after the interval is burned
  if (input.onDurableMarker !== undefined) {
    await input.onDurableMarker(marker);
  }

  // open designated data only after durable verification and lock release
  return openMembers(marker);
}

// acquire a durable owner lock or recover one proven dead owner
async function acquireLedgerLock(lockPath: string) {
  const owner = {
    nonce: randomBytes(16).toString("hex"),
    pid: process.pid,
  };

  // retry once after safe stale-owner recovery
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.writeFile(canonicalJsonBytes(owner as unknown as JsonValue), "utf8");
      await lock.sync();
      await syncDirectory(dirname(lockPath));
      return lock;
    } catch (error: unknown) {
      // recover only a complete lock owned by a dead process
      if (attempt === 0 && await recoverStaleLedgerLock(lockPath)) {
        continue;
      }

      throw boundedFilesystemError(error, "holdout ledger lock is unavailable");
    }
  }

  throw new Error("holdout ledger lock is unavailable");
}

// remove an unchanged lock only when its recorded process is gone
async function recoverStaleLedgerLock(lockPath: string): Promise<boolean> {
  let before: string;

  try {
    before = await readFile(lockPath, "utf8");
    const owner = JSON.parse(before) as { readonly nonce?: unknown; readonly pid?: unknown };

    // reject incomplete or live ownership
    if (
      typeof owner.nonce !== "string" ||
      !/^[a-f0-9]{32}$/u.test(owner.nonce) ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) < 1 ||
      processIsAlive(owner.pid as number)
    ) {
      return false;
    }
  } catch {
    return false;
  }

  // re-read immediately before unlink to reject ownership replacement
  if (await readFile(lockPath, "utf8").catch(() => "") !== before) {
    return false;
  }

  await unlink(lockPath);
  await syncDirectory(dirname(lockPath));
  return true;
}

// check lock ownership without signaling the process
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // treat only a missing process as stale
    return !(
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

// fsync one directory metadata boundary
async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

// parse and verify the append-only holdout chain
export function parseHoldoutLedger(bytes: string): readonly HoldoutAccessMarkerV1[] {
  return deepFreeze(parseLedgerRecords(bytes).filter(isHoldoutAccessMarker));
}

// append one complete immutable evidence transition
export async function appendEvidenceLifecycleRecord(
  directory: string,
  hashes: Omit<
    ForecastAdjustmentEvidenceLifecycleRecordV1,
    "contractVersion" | "predecessorSha256" | "recordSha256"
  >,
): Promise<ForecastAdjustmentEvidenceLifecycleRecordV1> {
  const ledgerPath = join(directory, "ledger.jsonl");
  const lockPath = join(directory, "ledger.lock");
  await mkdir(directory, { mode: 0o700, recursive: true });
  const lock = await acquireLedgerLock(lockPath);

  try {
    const existingBytes = await readFile(ledgerPath, "utf8");
    const records = parseLedgerRecords(existingBytes);
    const unsigned = {
      ...hashes,
      contractVersion: "forecast-adjustment-evidence-promoted/v1" as const,
      predecessorSha256: ledgerRecordHash(records.at(-1)) ?? ZERO_HASH,
    };
    const record = deepFreeze({
      ...unsigned,
      recordSha256: canonicalSha256(unsigned as unknown as JsonValue),
    });
    const ledger = await open(ledgerPath, "a", 0o600);

    try {
      await ledger.writeFile(canonicalJsonBytes(record as unknown as JsonValue), "utf8");
      await ledger.sync();
      await syncDirectory(directory);
    } finally {
      await ledger.close();
    }

    const durable = parseLedgerRecords(await readFile(ledgerPath, "utf8"));

    // require the exact lifecycle record as durable tail
    if (ledgerRecordHash(durable.at(-1)) !== record.recordSha256) {
      throw new Error("evidence lifecycle durable-tail verification failed");
    }

    return record;
  } finally {
    await lock.close();
    await unlink(lockPath).catch((error: unknown) => {
      throw boundedFilesystemError(error, "holdout ledger lock cannot be released");
    });
    await syncDirectory(directory);
  }
}

// require one exact complete lifecycle record in the durable chain
export async function verifyEvidenceLifecycleRecord(
  directory: string,
  hashes: Omit<
    ForecastAdjustmentEvidenceLifecycleRecordV1,
    "contractVersion" | "predecessorSha256" | "recordSha256"
  >,
): Promise<void> {
  const records = parseLedgerRecords(
    await readFile(join(directory, "ledger.jsonl"), "utf8"),
  );
  const expected = canonicalizeJson(hashes as unknown as JsonValue);

  // require an exact immutable promotion transition
  if (
    !records.some(
      (record) =>
        record.contractVersion === "forecast-adjustment-evidence-promoted/v1" &&
        canonicalizeJson(
          Object.fromEntries(
            Object.entries(record).filter(
              ([key]) =>
                !["contractVersion", "predecessorSha256", "recordSha256"].includes(key),
            ),
          ) as JsonValue,
        ) === expected,
    )
  ) {
    throw new RangeError("complete evidence lifecycle record is absent");
  }
}

// parse and verify every append-only ledger record
function parseLedgerRecords(bytes: string): readonly LedgerRecordV1[] {
  // reject a nonterminated partial append
  if (bytes.length > 0 && !bytes.endsWith("\n")) {
    throw new RangeError("holdout ledger has a partial final record");
  }

  const records: LedgerRecordV1[] = [];
  const lines = bytes.split("\n").filter((line) => line.length > 0);

  for (const line of lines) {
    let record: LedgerRecordV1;

    try {
      record = JSON.parse(line) as LedgerRecordV1;
    } catch {
      throw new RangeError("holdout ledger contains invalid JSON");
    }

    verifyLedgerRecord(record);
    const expectedPredecessor = ledgerRecordHash(records.at(-1)) ?? ZERO_HASH;

    // detect deletion, mutation, or reordering
    if (record.predecessorSha256 !== expectedPredecessor) {
      throw new RangeError("holdout ledger predecessor chain is invalid");
    }

    records.push(deepFreeze(record));
  }

  return deepFreeze(records);
}

// verify one ledger record by its closed contract
function verifyLedgerRecord(record: LedgerRecordV1): void {
  // dispatch the irreversible access marker
  if (record.contractVersion === "holdout_accessed/v1") {
    verifyHoldoutAccessMarker(record);
    return;
  }

  const keys = [
    "candidateArtifactSha256",
    "contractVersion",
    "developmentReportSha256",
    "evaluationReportSha256",
    "holdoutAccessMarkerSha256",
    "predecessorSha256",
    "preregistrationSha256",
    "qualificationReceiptSha256",
    "recordSha256",
    "snapshotManifestSha256",
  ];
  requireExactKeys(record, keys, "evidence lifecycle record");

  // reject unknown lifecycle contracts
  if (record.contractVersion !== "forecast-adjustment-evidence-promoted/v1") {
    throw new RangeError("unsupported evidence lifecycle contract");
  }

  for (const [name, value] of Object.entries(record)) {
    // validate every identity other than the contract literal
    if (name !== "contractVersion") {
      validateHash(value, name);
    }
  }

  // reject lifecycle substitution
  if (
    canonicalObjectSha256(
      record as unknown as Readonly<Record<string, unknown>>,
      "recordSha256",
    ) !== record.recordSha256
  ) {
    throw new RangeError("evidence lifecycle record SHA-256 mismatch");
  }
}

// identify an access marker record
function isHoldoutAccessMarker(record: LedgerRecordV1): record is HoldoutAccessMarkerV1 {
  return record.contractVersion === "holdout_accessed/v1";
}

// select one record chain identity
function ledgerRecordHash(record: LedgerRecordV1 | undefined): string | undefined {
  // preserve an absent genesis tail
  if (record === undefined) {
    return undefined;
  }

  return isHoldoutAccessMarker(record) ? record.markerSha256 : record.recordSha256;
}

// verify one marker schema, hash, and lineage
export function verifyHoldoutAccessMarker(marker: HoldoutAccessMarkerV1): void {
  const requiredKeys = [
    "accessedAtUtc",
    "candidateArtifactSha256",
    "contractVersion",
    "enabledMetricBandsSha256",
    "endExclusive",
    "endLocalDate",
    "evaluationEpochId",
    "lineage",
    "lineageId",
    "markerSha256",
    "predecessorSha256",
    "preregistrationSha256",
    "siteKey",
    "snapshotManifestSha256",
    "startInclusive",
    "startLocalDate",
  ];
  requireExactKeys(marker, requiredKeys, "holdout access marker");

  // require the frozen marker identity
  if (marker.contractVersion !== "holdout_accessed/v1") {
    throw new RangeError("unsupported holdout access marker contract");
  }

  validateLineage(marker.lineage);

  // require one canonical access instant
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      marker.accessedAtUtc,
    ) ||
    !Number.isFinite(Date.parse(marker.accessedAtUtc))
  ) {
    throw new RangeError("holdout marker access time is invalid");
  }
  for (const [name, hash] of [
    ["candidateArtifactSha256", marker.candidateArtifactSha256],
    ["enabledMetricBandsSha256", marker.enabledMetricBandsSha256],
    ["lineageId", marker.lineageId],
    ["markerSha256", marker.markerSha256],
    ["predecessorSha256", marker.predecessorSha256],
    ["preregistrationSha256", marker.preregistrationSha256],
    ["snapshotManifestSha256", marker.snapshotManifestSha256],
  ] as const) {
    validateHash(hash, name);
  }

  // require marker site and computed lineage identity
  if (
    marker.siteKey !== marker.lineage.siteKey ||
    marker.lineageId !== createHoldoutLineageId(marker.lineage)
  ) {
    throw new RangeError("holdout marker lineage mismatch");
  }

  validateInterval(
    marker.startLocalDate,
    marker.endLocalDate,
    marker.startInclusive,
    marker.endExclusive,
  );

  // reject marker byte substitution
  if (
    canonicalObjectSha256(
      marker as unknown as Readonly<Record<string, unknown>>,
      "markerSha256",
    ) !== marker.markerSha256
  ) {
    throw new RangeError("holdout access marker SHA-256 mismatch");
  }
}

// expose whether the exclusive lock is currently held
export async function isHoldoutLedgerLocked(directory?: string): Promise<boolean> {
  const lockPath = join(directory ?? HOLDOUT_EVIDENCE_DIRECTORY, "ledger.lock");

  try {
    await access(lockPath, constants.F_OK);
    return true;
  } catch (error: unknown) {
    // treat only an absent lock as released
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }

    throw boundedFilesystemError(
      error,
      "holdout ledger lock status cannot be read",
    );
  }
}

// create one marker from preregistered evidence
function createHoldoutAccessMarker(input: {
  readonly accessedAtUtc: string;
  readonly candidate: ForecastAdjustmentCandidateV2;
  readonly lineage: HoldoutLineageV1;
  readonly predecessorSha256: string;
  readonly preregistration: ForecastAdjustmentPreregistrationV1;
}): HoldoutAccessMarkerV1 {
  const preregistration = input.preregistration;
  const unsigned = {
    accessedAtUtc: input.accessedAtUtc,
    candidateArtifactSha256: input.candidate.candidateArtifactSha256,
    contractVersion: "holdout_accessed/v1" as const,
    enabledMetricBandsSha256: canonicalSha256(
      input.candidate.enabledMetricBands as unknown as JsonValue,
    ),
    endExclusive: preregistration.holdoutEndExclusive,
    endLocalDate: preregistration.holdoutEndLocalDate,
    evaluationEpochId: input.candidate.evaluationEpochId,
    lineage: cloneJson(input.lineage),
    lineageId: createHoldoutLineageId(input.lineage),
    predecessorSha256: input.predecessorSha256,
    preregistrationSha256: preregistration.preregistrationSha256,
    siteKey: "ballydidean" as const,
    snapshotManifestSha256: preregistration.snapshotManifestSha256,
    startInclusive: preregistration.holdoutStartInclusive,
    startLocalDate: preregistration.holdoutStartLocalDate,
  };

  return deepFreeze({
    ...unsigned,
    markerSha256: canonicalSha256(unsigned as unknown as JsonValue),
  });
}

// reject reuse or overlap in one lineage
function assertHoldoutIntervalAvailable(
  markers: readonly HoldoutAccessMarkerV1[],
  lineage: HoldoutLineageV1,
  proposedStartDate: string,
  proposedEndDate: string,
): void {
  validateLocalDate(proposedStartDate, "proposedStartDate");
  validateLocalDate(proposedEndDate, "proposedEndDate");
  let maximumPriorEnd: string | null = null;
  const burnScopeId = createHoldoutBurnScopeId(lineage);

  for (const marker of markers) {
    // compare immutable observation scope across forecast epoch changes
    if (createHoldoutBurnScopeId(marker.lineage) !== burnScopeId) {
      continue;
    }

    // retain the latest burned end
    if (maximumPriorEnd === null || marker.endLocalDate > maximumPriorEnd) {
      maximumPriorEnd = marker.endLocalDate;
    }
  }

  // require a strictly later, fully disjoint interval
  if (maximumPriorEnd !== null && proposedStartDate <= maximumPriorEnd) {
    throw new RangeError(
      "proposed holdout must start strictly after every prior lineage interval",
    );
  }
}

// bind interval burns to observation evidence independent of forecast epoch aliases
function createHoldoutBurnScopeId(lineage: HoldoutLineageV1): string {
  return canonicalSha256({
    aggregationContractVersion: lineage.aggregationContractVersion,
    cohort: lineage.cohort,
    metricEligibilitySha256: lineage.metricEligibilitySha256,
    observationSourceLineageSha256: lineage.observationSourceLineageSha256,
    observationStationManifestSha256: lineage.observationStationManifestSha256,
    referenceKind: lineage.referenceKind,
    siteKey: lineage.siteKey,
    spatialWeightSha256: lineage.spatialWeightSha256,
  });
}

// validate one complete 30-label holdout interval
function validateInterval(
  startLocalDate: string,
  endLocalDate: string,
  startInclusive: string,
  endExclusive: string,
): void {
  const startDate = validateLocalDate(startLocalDate, "startLocalDate");
  const endDate = validateLocalDate(endLocalDate, "endLocalDate");
  const startInstant = Date.parse(startInclusive);
  const endInstant = Date.parse(endExclusive);
  const expectedStart = localMidnightUtc(startLocalDate);
  const nextLocalDate = new Date(endDate + 86_400_000).toISOString().slice(0, 10);
  const expectedEnd = localMidnightUtc(nextLocalDate);

  // require 30 local labels and exact Los Angeles UTC bounds
  if (
    (endDate - startDate) / 86_400_000 !== 29 ||
    !Number.isFinite(startInstant) ||
    !Number.isFinite(endInstant) ||
    startInstant >= endInstant ||
    new Date(startInstant).toISOString() !== expectedStart ||
    new Date(endInstant).toISOString() !== expectedEnd
  ) {
    throw new RangeError("holdout interval must contain 30 local dates");
  }
}

// map one Los Angeles local midnight to its exact UTC instant
function localMidnightUtc(localDate: string): string {
  const targetMilliseconds = validateLocalDate(localDate, "localDate");
  let candidate = targetMilliseconds;

  // converge from UTC midnight to the requested local wall time
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = new Map(
      localInstantFormatter
        .formatToParts(new Date(candidate))
        .map((part) => [part.type, part.value]),
    );
    const represented = Date.UTC(
      Number(parts.get("year")),
      Number(parts.get("month")) - 1,
      Number(parts.get("day")),
      Number(parts.get("hour")),
      Number(parts.get("minute")),
      Number(parts.get("second")),
    );
    candidate += targetMilliseconds - represented;
  }

  return new Date(candidate).toISOString();
}

// validate one lineage tuple
function validateLineage(lineage: HoldoutLineageV1): void {
  const requiredKeys = [
    "aggregationContractVersion",
    "cohort",
    "contractEpoch",
    "dataset",
    "forecastSourceConfigFingerprint",
    "forecastSourceKey",
    "metricEligibilitySha256",
    "observationSourceLineageSha256",
    "observationStationManifestSha256",
    "referenceKind",
    "siteKey",
    "spatialWeightSha256",
    "upstreamModel",
  ];
  requireExactKeys(lineage, requiredKeys, "holdout lineage");

  // require the only served cohort and frozen v1 identities
  if (
    lineage.siteKey !== "ballydidean" ||
    lineage.aggregationContractVersion !== "physical-station-network/v1" ||
    lineage.cohort !== FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.cohort ||
    lineage.contractEpoch !==
      FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.contractEpoch ||
    lineage.dataset !== FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.dataset ||
    lineage.forecastSourceConfigFingerprint !==
      FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.sourceConfigFingerprint ||
    lineage.forecastSourceKey !==
      FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.sourceKey ||
    lineage.referenceKind !==
      FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.referenceKind ||
    lineage.upstreamModel !==
      FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1.upstreamModel ||
    lineage.metricEligibilitySha256 !==
      FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.metricEligibilitySha256 ||
    lineage.observationSourceLineageSha256 !==
      FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.observationSourceLineageSha256 ||
    lineage.observationStationManifestSha256 !==
      FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.observationStationManifestSha256 ||
    lineage.spatialWeightSha256 !==
      FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1.spatialWeightSha256
  ) {
    throw new RangeError("holdout lineage forecast identity is invalid");
  }

  for (const [name, hash] of [
    ["forecastSourceConfigFingerprint", lineage.forecastSourceConfigFingerprint],
    ["metricEligibilitySha256", lineage.metricEligibilitySha256],
    ["observationSourceLineageSha256", lineage.observationSourceLineageSha256],
    ["observationStationManifestSha256", lineage.observationStationManifestSha256],
    ["spatialWeightSha256", lineage.spatialWeightSha256],
  ] as const) {
    validateHash(hash, name);
  }

  for (const [name, value] of [
    ["aggregationContractVersion", lineage.aggregationContractVersion],
    ["contractEpoch", lineage.contractEpoch],
    ["dataset", lineage.dataset],
    ["forecastSourceKey", lineage.forecastSourceKey],
    ["upstreamModel", lineage.upstreamModel],
  ] as const) {
    // require bounded lineage text
    if (value.trim().length === 0 || value.length > 256) {
      throw new RangeError(`${name} must be bounded nonempty text`);
    }
  }
}

// require one exact object schema
function requireExactKeys(
  value: object,
  expectedKeys: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();

  // reject schema drift
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) {
    throw new RangeError(`${description} has unexpected fields`);
  }
}

// parse one real local calendar label
function validateLocalDate(value: string, fieldName: string): number {
  // require canonical date grammar
  if (!LOCAL_DATE_PATTERN.test(value)) {
    throw new RangeError(`${fieldName} must be YYYY-MM-DD`);
  }

  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);

  // reject calendar rollover
  if (new Date(milliseconds).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${fieldName} must be a real calendar date`);
  }

  return milliseconds;
}

// validate one SHA-256 identity
function validateHash(value: string, fieldName: string): void {
  // require lowercase hexadecimal
  if (!HASH_PATTERN.test(value)) {
    throw new RangeError(`${fieldName} must be a SHA-256 hex value`);
  }
}

// clone one JSON value without aliases
function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as T;
}

// convert filesystem failures to bounded diagnostics
function boundedFilesystemError(error: unknown, message: string): Error {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String(error.code)
      : "unknown";
  return new Error(`${message} (${code})`);
}
