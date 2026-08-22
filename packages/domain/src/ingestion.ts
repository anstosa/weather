import {
  canonicalizeJson,
  type JsonValue,
} from "./provenance.js";
import { validateUtcInstant } from "./weather-record.js";

export const INGESTION_MODES = ["scheduled", "backfill"] as const;
export type IngestionMode = (typeof INGESTION_MODES)[number];

export const INGESTION_STATES = [
  "running",
  "succeeded",
  "failed",
  "abandoned",
] as const;
export type IngestionState = (typeof INGESTION_STATES)[number];

export const INGESTION_ERROR_CLASSIFICATIONS = [
  "retryable",
  "rate_limited",
  "permanent",
  "invalid_payload",
] as const;
export type IngestionErrorClassification =
  (typeof INGESTION_ERROR_CLASSIFICATIONS)[number];

export interface IngestionError {
  readonly classification: IngestionErrorClassification;
  readonly code: string;
  readonly message: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface IngestionRun {
  readonly adapterVersion: string;
  readonly attempts: number;
  readonly chunkPlanVersion: string | null;
  readonly deadlineAt: string;
  readonly error: IngestionError | null;
  readonly id: string;
  readonly mode: IngestionMode;
  readonly recordCount: number;
  readonly requestedEndExclusive: string;
  readonly requestedStart: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
  readonly startedAt: string;
  readonly state: IngestionState;
}

export interface ScheduledCheckpoint {
  readonly lastCommittedAt: string;
  readonly lastValidAt: string;
  readonly providerCursor: Readonly<Record<string, JsonValue>> | null;
  readonly sourceId: string;
  readonly version: number;
}

export interface BackfillChunkIdentity {
  readonly adapterVersion: string;
  readonly chunkPlanVersion: string;
  readonly intervalEndExclusive: string;
  readonly intervalStart: string;
  readonly requestedFromDate: string;
  readonly requestedToDate: string;
  readonly sourceConfigFingerprint: string;
  readonly sourceId: string;
}

export interface BackfillChunkOutcome extends BackfillChunkIdentity {
  readonly completedAt: string;
  readonly ingestionRunId: string;
  readonly outcome: "failed" | "succeeded";
}

// create an exact chunk identity
export function createBackfillChunkIdentity(
  identity: BackfillChunkIdentity,
): BackfillChunkIdentity {
  const intervalStart = validateUtcInstant(
    identity.intervalStart,
    "intervalStart",
  );
  const intervalEndExclusive = validateUtcInstant(
    identity.intervalEndExclusive,
    "intervalEndExclusive",
  );

  // require a forward half-open interval
  if (intervalStart >= intervalEndExclusive) {
    throw new RangeError("backfill interval must be non-empty and increasing");
  }

  validateFingerprint(identity.sourceConfigFingerprint);
  validateVersion(identity.adapterVersion, "adapterVersion");
  validateVersion(identity.chunkPlanVersion, "chunkPlanVersion");
  validateDate(identity.requestedFromDate, "requestedFromDate");
  validateDate(identity.requestedToDate, "requestedToDate");

  // require bounded source identity
  if (identity.sourceId.trim().length === 0 || identity.sourceId.length > 128) {
    throw new RangeError("backfill sourceId must be non-empty and bounded");
  }

  // require ordered local dates
  if (identity.requestedFromDate > identity.requestedToDate) {
    throw new RangeError("requested local date range must be ordered");
  }

  return { ...identity, intervalEndExclusive, intervalStart };
}

// serialize exact resume identity
export function backfillChunkKey(identity: BackfillChunkIdentity): string {
  const validated = createBackfillChunkIdentity(identity);

  return canonicalizeJson({
    adapterVersion: validated.adapterVersion,
    chunkPlanVersion: validated.chunkPlanVersion,
    intervalEndExclusive: validated.intervalEndExclusive,
    intervalStart: validated.intervalStart,
    sourceConfigFingerprint: validated.sourceConfigFingerprint,
    sourceId: validated.sourceId,
  });
}

// validate a run lifecycle snapshot
export function validateIngestionRun(run: IngestionRun): IngestionRun {
  const requestedStart = validateUtcInstant(
    run.requestedStart,
    "requestedStart",
  );
  const requestedEndExclusive = validateUtcInstant(
    run.requestedEndExclusive,
    "requestedEndExclusive",
  );
  const startedAt = validateUtcInstant(run.startedAt, "startedAt");
  const deadlineAt = validateUtcInstant(run.deadlineAt, "deadlineAt");

  // require increasing request bounds
  if (requestedStart >= requestedEndExclusive) {
    throw new RangeError("ingestion request interval must be increasing");
  }

  // require recovery after start
  if (deadlineAt <= startedAt) {
    throw new RangeError("ingestion deadline must follow start time");
  }

  // require bounded counts
  if (
    !Number.isSafeInteger(run.attempts) ||
    run.attempts < 0 ||
    !Number.isSafeInteger(run.recordCount) ||
    run.recordCount < 0
  ) {
    throw new RangeError("ingestion counts must be non-negative integers");
  }

  // require plan only for backfill
  if (run.mode === "backfill" && run.chunkPlanVersion === null) {
    throw new RangeError("backfill runs require chunkPlanVersion");
  }

  validateFingerprint(run.sourceConfigFingerprint);
  validateVersion(run.adapterVersion, "adapterVersion");

  // validate optional plan version
  if (run.chunkPlanVersion !== null) {
    validateVersion(run.chunkPlanVersion, "chunkPlanVersion");
  }

  // validate bounded errors
  if (run.error !== null) {
    validateIngestionError(run.error);
  }

  return {
    ...run,
    deadlineAt,
    requestedEndExclusive,
    requestedStart,
    startedAt,
  };
}

// validate error details
export function validateIngestionError(error: IngestionError): IngestionError {
  // enforce bounded stable code
  if (!/^[a-z0-9_:-]{1,64}$/u.test(error.code)) {
    throw new RangeError("ingestion error code must be stable and bounded");
  }

  // enforce bounded diagnosis
  if (error.message.trim().length === 0 || error.message.length > 512) {
    throw new RangeError("ingestion error message must be non-empty and bounded");
  }

  // enforce bounded metadata
  if (
    error.metadata !== undefined &&
    canonicalizeJson(error.metadata).length > 2_048
  ) {
    throw new RangeError("ingestion error metadata is too large");
  }

  return { ...error };
}

// validate source fingerprints
export function validateFingerprint(value: string): string {
  // require lowercase sha-256 hex
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw new RangeError("source fingerprint must be lowercase SHA-256 hex");
  }

  return value;
}

// validate version identifiers
export function validateVersion(value: string, fieldName: string): string {
  // require bounded printable identifiers
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u.test(value)) {
    throw new RangeError(`${fieldName} must be a bounded version identifier`);
  }

  return value;
}

// validate local dates
function validateDate(value: string, fieldName: string): string {
  // require calendar date shape
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new RangeError(`${fieldName} must use YYYY-MM-DD`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  // reject rollover dates
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${fieldName} must be a valid calendar date`);
  }

  return value;
}
