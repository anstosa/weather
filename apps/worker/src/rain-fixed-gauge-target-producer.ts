import { createHash } from "node:crypto";

import {
  commitRainFixedGaugeTargetRevisionGroup,
  markRainFixedGaugeTargetRevisionGroupGap,
  readPendingRainFixedGaugeTargetHour,
  readRainFixedGaugeTargetCapturesForHour,
  readRainFixedGaugeTargetSourceCatalog,
  type AdjustmentRevisionCommitReceipt,
  type RainFixedGaugeTargetCapture,
  type RainFixedGaugeTargetRevisionGroup,
  type RainFixedGaugeTargetRevisionResult,
  type RainFixedGaugeTargetSourceCatalog,
  type createDatabasePool,
} from "@weather/database";
import {
  adjustmentRainFixedGaugeTargetLogicalKeySha256,
  type AdjustmentRainFixedGaugeTargetProjection,
  type AdjustmentRevisionCaptureEpochWitness,
} from "@weather/forecast-adjustment";

import {
  buildRainFixedGaugeTargetProjection,
} from "./rain-fixed-gauge-target.js";
import {
  stageAdjustmentRevisionWithBackpressure,
  type AdjustmentRevisionGap,
  type AdjustmentRevisionStageReceipt,
  type RainAdjustmentMaintenanceClient,
} from "./rain-adjustment.js";

type Pool = ReturnType<typeof createDatabasePool>;
const HASH = /^[a-f0-9]{64}$/u;

export interface RainFixedGaugeTargetGapInput {
  readonly logicalHourAt: string;
  readonly logicalKeySha256: string;
  readonly reason: "target_source_oversized";
}

export interface RainFixedGaugeTargetGapReceipt extends RainFixedGaugeTargetGapInput {
  readonly contractVersion: "adjustment-rain-fixed-gauge-target-gap/v1";
  readonly gapAt: string;
  readonly gapSha256: string;
  readonly qualificationDisposition: "forever_unqualified";
}

export type RainFixedGaugeTargetGapStatus =
  | Readonly<{
      contractVersion: "adjustment-rain-fixed-gauge-target-gap-status/v1";
      state: "absent";
    }>
  | Readonly<{
      contractVersion: "adjustment-rain-fixed-gauge-target-gap-status/v1";
      gap: RainFixedGaugeTargetGapReceipt;
      state: "present";
    }>;

export interface RainFixedGaugeTargetProducerClient extends Pick<
  RainAdjustmentMaintenanceClient,
  "publishRevisionBatch" | "readRainFixedGaugeTargetGap" | "recordRevisionGap" |
    "stageRevision"
> {
  readonly recordRainFixedGaugeTargetGap: (
    input: RainFixedGaugeTargetGapInput,
  ) => Promise<RainFixedGaugeTargetGapReceipt>;
  readonly readRainFixedGaugeTargetGap: (
    input: Omit<RainFixedGaugeTargetGapInput, "reason">,
  ) => Promise<RainFixedGaugeTargetGapStatus>;
}

export interface RainFixedGaugeTargetProducerRepository {
  readonly commitRevisionGroup: typeof commitRainFixedGaugeTargetRevisionGroup;
  readonly markRevisionGroupGap: typeof markRainFixedGaugeTargetRevisionGroupGap;
  readonly readCapturesForHour: typeof readRainFixedGaugeTargetCapturesForHour;
  readonly readPendingHour: typeof readPendingRainFixedGaugeTargetHour;
  readonly readSourceCatalog: typeof readRainFixedGaugeTargetSourceCatalog;
}

export type RainFixedGaugeTargetProducerResult =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "published"; revisionCount: 12 }>
  | Readonly<{
      reason: AdjustmentRevisionGap["reason"] | "target_source_oversized";
      state: "gap";
    }>;

const databaseRepository: RainFixedGaugeTargetProducerRepository = {
  commitRevisionGroup: commitRainFixedGaugeTargetRevisionGroup,
  markRevisionGroupGap: markRainFixedGaugeTargetRevisionGroupGap,
  readCapturesForHour: readRainFixedGaugeTargetCapturesForHour,
  readPendingHour: readPendingRainFixedGaugeTargetHour,
  readSourceCatalog: readRainFixedGaugeTargetSourceCatalog,
};

// publish one complete closed-hour fixed-gauge target group
export async function publishRainFixedGaugeTarget(
  pool: Pool,
  captureEpoch: AdjustmentRevisionCaptureEpochWitness,
  client: RainFixedGaugeTargetProducerClient,
  options: Readonly<{
    pause?: (milliseconds: number) => Promise<void>;
    repository?: RainFixedGaugeTargetProducerRepository;
  }> = {},
): Promise<RainFixedGaugeTargetProducerResult> {
  const repository = options.repository ?? databaseRepository;
  const [catalog, validAt] = await Promise.all([
    repository.readSourceCatalog(pool),
    repository.readPendingHour(pool, captureEpoch.epochAt),
  ]);

  // preserve no-work without archive or serving mutations
  if (validAt === null) {
    return { state: "idle" };
  }
  const sourceIds = catalog.sources.map((source) => source.sourceId);
  const logicalKeySha256 = adjustmentRainFixedGaugeTargetLogicalKeySha256({
    sourceIds,
    validAt,
  });
  const existingGap = await client.readRainFixedGaugeTargetGap({
    logicalHourAt: validAt,
    logicalKeySha256,
  });
  validateRainFixedGaugeTargetGapStatus(existingGap, validAt, logicalKeySha256);

  // avoid reinflating raw source bodies after one durable permanent gap
  if (existingGap.state === "present") {
    return { reason: existingGap.gap.reason, state: "gap" };
  }
  const captures = await repository.readCapturesForHour(
    pool,
    captureEpoch.epochAt,
    validAt,
  );
  const built = buildRainFixedGaugeTargetProjection({
    captures: captures.map(rainFixedGaugeTargetCapture),
    sources: catalog.sources.map((source) => ({
      sourceId: source.sourceId,
      stationId: source.locationId,
    })),
    targetCutoffAt: latestRainFixedGaugeTargetClock(captures),
    validAt,
  });

  // retain an oversized source graph only as a permanent value-free gap
  if (built.state === "gap") {
    const gapInput = {
      logicalHourAt: built.logicalHourAt,
      logicalKeySha256,
      reason: built.reason,
    } as const;
    validateRainFixedGaugeTargetGapReceipt(
      await client.recordRainFixedGaugeTargetGap(gapInput),
      gapInput.logicalHourAt,
      gapInput.logicalKeySha256,
    );
    return { reason: built.reason, state: "gap" };
  }
  const identity = createHash("sha256").update(built.bytes).digest("hex");
  const baseGroup = rainFixedGaugeTargetRevisionGroup(
    built.projection,
    logicalKeySha256,
    identity,
  );
  let stageReceipt: AdjustmentRevisionStageReceipt;

  // require durable body custody before assigning any server ordinal
  try {
    stageReceipt = options.pause === undefined
      ? await stageAdjustmentRevisionWithBackpressure(client, built.bytes)
      : await stageAdjustmentRevisionWithBackpressure(client, built.bytes, options.pause);
    validateRainFixedGaugeTargetStageReceipt(stageReceipt, identity);
  } catch {
    const result = await repository.commitRevisionGroup(pool, {
      ...baseGroup,
      stageReceiptSha256: null,
    });
    const gap = requireRainFixedGaugeTargetGap(result, "archive_stage_failed");
    await recordRainFixedGaugeTargetGapBestEffort(client, gap);
    return { reason: gap.reason, state: "gap" };
  }
  const group: RainFixedGaugeTargetRevisionGroup = {
    ...baseGroup,
    stageReceiptSha256: stageReceipt.stageReceiptSha256,
  };
  const committed = await repository.commitRevisionGroup(pool, group);

  // publish only a complete exact twelve-receipt transaction
  if (committed.state === "gap") {
    const gap = requireRainFixedGaugeTargetGap(committed, "database_bind_failed");
    await recordRainFixedGaugeTargetGapBestEffort(client, gap);
    return { reason: gap.reason, state: "gap" };
  }
  validateRainFixedGaugeTargetReceipts(
    committed.revisionReceipts,
    identity,
    stageReceipt.stageReceiptSha256,
  );
  try {
    await client.publishRevisionBatch(
      built.bytes,
      stageReceipt,
      committed.revisionReceipts,
    );
  } catch {
    let gap: AdjustmentRevisionGap | null = null;
    // preserve a stricter api admission marker when it won the race
    try {
      gap = requireRainFixedGaugeTargetGap({
        gap: await repository.markRevisionGroupGap(pool, group, "archive_publish_failed"),
        state: "gap",
      }, "archive_publish_failed");
    } catch {
      // leave the database's existing permanent category authoritative
    }
    // archive only the exact category persisted by this producer
    if (gap !== null) {
      await recordRainFixedGaugeTargetGapBestEffort(client, gap);
      return { reason: gap.reason, state: "gap" };
    }
    return { reason: "database_admission_failed", state: "gap" };
  }
  return { revisionCount: 12, state: "published" };
}

// validate one authenticated value-free permanent-gap status response
function validateRainFixedGaugeTargetGapStatus(
  status: RainFixedGaugeTargetGapStatus,
  logicalHourAt: string,
  logicalKeySha256: string,
): void {
  // keep the absent response closed and value free
  if (status.contractVersion !== "adjustment-rain-fixed-gauge-target-gap-status/v1" ||
      (status.state === "absent" && Object.keys(status).sort().join() !==
        "contractVersion,state")) {
    throw new RangeError("rain fixed-gauge target gap status differs");
  }
  // accept the exact closed absent response without inspecting a gap
  if (status.state === "absent") {
    return;
  }
  // reject unknown or widened present envelopes before reading their receipt
  if (status.state !== "present" || Object.keys(status).sort().join() !==
      "contractVersion,gap,state") {
    throw new RangeError("rain fixed-gauge target gap status differs");
  }
  const gap = status.gap;
  validateRainFixedGaugeTargetGapReceipt(gap, logicalHourAt, logicalKeySha256);
}

// validate one exact durable permanent-gap receipt
function validateRainFixedGaugeTargetGapReceipt(
  gap: RainFixedGaugeTargetGapReceipt,
  logicalHourAt: string,
  logicalKeySha256: string,
): void {
  const unsigned = {
    contractVersion: gap.contractVersion,
    gapAt: gap.gapAt,
    logicalHourAt: gap.logicalHourAt,
    logicalKeySha256: gap.logicalKeySha256,
    qualificationDisposition: gap.qualificationDisposition,
    reason: gap.reason,
  };

  // bind the durable receipt to the queried logical hour and permanent disposition
  if (Object.keys(gap).sort().join() !==
      "contractVersion,gapAt,gapSha256,logicalHourAt,logicalKeySha256,qualificationDisposition,reason" ||
      gap.contractVersion !== "adjustment-rain-fixed-gauge-target-gap/v1" ||
      gap.logicalHourAt !== logicalHourAt || gap.logicalKeySha256 !== logicalKeySha256 ||
      gap.qualificationDisposition !== "forever_unqualified" ||
      gap.reason !== "target_source_oversized" || !exactUtcInstant(gap.gapAt) ||
      gap.gapSha256 !== createHash("sha256")
        .update(`${JSON.stringify(unsigned)}\n`).digest("hex")) {
    throw new RangeError("rain fixed-gauge target durable gap differs");
  }
}

// adapt one retained raw response to the independent replay codec
function rainFixedGaugeTargetCapture(capture: RainFixedGaugeTargetCapture) {
  return {
    ...capture,
    kind: "station" as const,
    runInitializedAt: null,
  };
}

// select the final actual availability clock across all retained bodies
function latestRainFixedGaugeTargetClock(
  captures: readonly RainFixedGaugeTargetCapture[],
): string {
  const latest = captures.map((capture) => capture.completedAt).sort().at(-1);

  // refuse an empty repository result before constructing target bytes
  if (latest === undefined) {
    throw new Error("rain fixed-gauge target capture set is empty");
  }
  return latest;
}

// construct the database group from parser-authenticated canonical rows
function rainFixedGaugeTargetRevisionGroup(
  projection: AdjustmentRainFixedGaugeTargetProjection,
  logicalKeySha256: string,
  identity: string,
): Omit<RainFixedGaugeTargetRevisionGroup, "stageReceiptSha256"> {
  return {
    logicalKeySha256,
    projectionIdentitySha256: identity,
    projectionSha256: identity,
    rows: projection.rows.map((row) => ({
      normalizedRecord: row.normalizedRecord,
      stationId: row.stationId,
      storedContentSha256: row.storedContentSha256,
    })),
    validAt: projection.validAt,
  };
}

// require the repository's exact permanent stage failure result
function requireRainFixedGaugeTargetGap(
  result: RainFixedGaugeTargetRevisionResult,
  reason: AdjustmentRevisionGap["reason"],
): AdjustmentRevisionGap {
  // reject a receipt issuance after the caller supplied no durable stage
  if (result.state !== "gap" || result.gap.reason !== reason) {
    throw new Error("rain fixed-gauge target gap result differs");
  }
  // narrow the database-wide union to this target-only transport
  if (result.gap.projectionKind !== "target_revision") {
    throw new Error("rain fixed-gauge target gap kind differs");
  }
  return result.gap as AdjustmentRevisionGap;
}

// relay one already-persisted permanent group gap without blocking serving
async function recordRainFixedGaugeTargetGapBestEffort(
  client: Pick<RainFixedGaugeTargetProducerClient, "recordRevisionGap">,
  gap: AdjustmentRevisionGap,
): Promise<void> {
  try {
    await client.recordRevisionGap(gap);
  } catch {
    // retain the database marker as the permanent unqualified authority
  }
}

// validate one durable body receipt before opening the database transaction
function validateRainFixedGaugeTargetStageReceipt(
  receipt: AdjustmentRevisionStageReceipt,
  identity: string,
): void {
  const unsigned = {
    contractVersion: receipt.contractVersion,
    durable: receipt.durable,
    durableAt: receipt.durableAt,
    projectionIdentitySha256: receipt.projectionIdentitySha256,
    projectionKind: receipt.projectionKind,
    projectionSha256: receipt.projectionSha256,
  };

  // bind exact body identity, kind, clock and canonical unsigned receipt
  if (receipt.contractVersion !== "adjustment-revision-stage-receipt/v1" ||
      receipt.durable !== true || receipt.projectionKind !== "target_revision" ||
      receipt.projectionIdentitySha256 !== identity || receipt.projectionSha256 !== identity ||
      !exactUtcInstant(receipt.durableAt) || receipt.stageReceiptSha256 !==
        createHash("sha256").update(`${JSON.stringify(unsigned)}\n`).digest("hex")) {
    throw new RangeError("rain fixed-gauge target stage receipt differs");
  }
}

// require one contiguous global-frontier vector for the shared body
function validateRainFixedGaugeTargetReceipts(
  receipts: readonly AdjustmentRevisionCommitReceipt[],
  identity: string,
  stageReceiptSha256: string,
): void {
  // require every frozen gauge to have one server-issued receipt
  if (receipts.length !== 12) {
    throw new RangeError("rain fixed-gauge target receipt count differs");
  }
  let previous: AdjustmentRevisionCommitReceipt | null = null;
  // validate exact identities and successor linkage in station order
  for (const receipt of receipts) {
    const ordinal = BigInt(receipt.archiveCommitOrdinal);
    if (receipt.contractVersion !== "adjustment-revision-commit-receipt/v1" ||
        receipt.projectionKind !== "target_revision" ||
        receipt.projectionIdentitySha256 !== identity ||
        receipt.projectionSha256 !== identity ||
        receipt.stageReceiptSha256 !== stageReceiptSha256 ||
        !exactUtcInstant(receipt.archiveCommittedAt) ||
        !HASH.test(receipt.frontierSha256) ||
        !HASH.test(receipt.predecessorFrontierSha256) ||
        !HASH.test(receipt.receiptSha256) ||
        (previous !== null && (ordinal !== BigInt(previous.archiveCommitOrdinal) + 1n ||
          receipt.predecessorFrontierSha256 !== previous.frontierSha256))) {
      throw new RangeError("rain fixed-gauge target receipt vector differs");
    }
    previous = receipt;
  }
}

// accept only canonical utc millisecond clocks
function exactUtcInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
