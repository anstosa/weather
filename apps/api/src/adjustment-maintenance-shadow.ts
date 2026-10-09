import { createHash } from "node:crypto";
import {
  appendTemperatureAdjustmentShadow,
  appendWindAdjustmentShadow,
  isAdjustmentShadowBodyAdmitted,
  markAdjustmentRevisionGap,
  readAdjustmentEcmwfTemperatureRevisionAdmission,
  readAdjustmentForecastAnchorRevisionAdmission,
  readAdjustmentRainGateRevisionAdmission,
  readAdjustmentShadowRevisionAdmission,
  readAdjustmentShadowRegistrationSlot,
  readAdjustmentWeatherRevisionAdmission,
  registerApiAdjustmentShadow,
  type AdjustmentRevisionCommitReceipt,
  type AdjustmentShadowPrediction,
  type AdjustmentShadowRegistration,
  type AdjustmentShadowRegistrationSlot,
  type EcmwfTemperatureCanarySidecar,
  type Queryable,
  type WeatherRecordRow,
} from "@weather/database";
import {
  MAINTENANCE_SHADOW_SOURCE_VERSION,
  MAINTENANCE_SHADOW_VALUES_VERSION,
  MAINTENANCE_SHADOW_COMPARATOR_VERSION,
  applyForecastAdjustment,
  applyForecastAdjustmentTemperatureCanary,
  createMaintenanceShadowPredictionMetadata,
  createMaintenanceShadowSourceIdentity,
  decodeMaintenanceBinary64,
  encodeMaintenanceBinary64,
  encodeMaintenanceShadowSourceProjection,
  encodeMaintenanceShadowComparator,
  encodeMaintenanceShadowValues,
  parseMaintenanceShadowSourceProjection,
  parseMaintenanceShadowComparator,
  parseMaintenanceShadowValues,
  requireAdjustmentRevisionProjectionAfterCaptureEpoch,
  requireMaintenanceShadowSourceAfterCaptureEpoch,
  validateMaintenanceShadowComparatorBinding,
  adjustmentRevisionClockIsAfterCaptureEpoch,
  type AdjustmentRevisionCaptureEpochWitness,
  adjustmentRevisionLogicalKeySha256,
  adjustmentRevisionProjectionIdentity,
  adjustmentRainFixedGaugeTargetLogicalKeySha256,
  parseAdjustmentRainFixedGaugeTargetProjection,
  parseAdjustmentRevisionBatchProjection,
  parseAdjustmentRevisionProjectionDocument,
  parseAdjustmentRevisionProjection,
  parseRainMaintenanceControlState,
  applyForecastAdjustmentTemperatureMaintenanceCandidate,
  applyForecastAdjustmentWindMaintenanceCandidate,
  verifyForecastAdjustmentMaintenanceRuntimePackage,
  type ForecastAdjustmentTemperatureMaintenanceRuntimePackage,
  type ForecastAdjustmentWindMaintenanceRuntimePackage,
  type InstalledMaintenanceShadowCandidate,
  type LoadedForecastAdjustmentTemperatureCanaryRuntime,
  type LoadedForecastAdjustmentRuntimeV1,
  type LoadedForecastAdjustmentWindCanaryRuntime,
  type MaintenanceShadowComparator,
  type MaintenanceShadowServingAuthority,
  type MaintenanceShadowPredictionMetadata,
  type MaintenanceShadowSourceProjection,
  type MaintenanceShadowValues,
  type AdjustmentRevisionProjection,
  type AdjustmentRevisionBatchProjection,
  type AdjustmentRevisionProjectionDocument,
  type AdjustmentRevisionProjectionKind,
  type AdjustmentRainFixedGaugeTargetProjection,
  type AdjustmentTemperatureNativeSourceProjection,
} from "@weather/forecast-adjustment";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const HASH = /^[a-f0-9]{64}$/u;
const UTC_MILLISECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_INTERNAL_REQUEST_BYTES = 4_832 * 1_024;
const GAP_PATH = "/internal/adjustment-maintenance/shadow/gap";
const STAGE_PATH = "/internal/adjustment-maintenance/shadow/stage";
const PUBLISH_PATH = "/internal/adjustment-maintenance/shadow/publish";
const CAPTURE_PATH = "/internal/adjustment-maintenance/shadow/capture";
const REVISION_GAP_PATH = "/internal/adjustment-maintenance/revision/gap";
const REVISION_STAGE_PATH = "/internal/adjustment-maintenance/revision/stage";
const REVISION_PUBLISH_PATH = "/internal/adjustment-maintenance/revision/publish";
const SCHEDULE_SLOTS_PATH = "/internal/adjustment-maintenance/schedule-slots";
const RAIN_CONTROL_STATE_STAGE_PATH =
  "/internal/adjustment-maintenance/rain-control-state/stage";
const RAIN_CONTROL_STATE_GAP_PATH =
  "/internal/adjustment-maintenance/rain-control-state/gap";
const RAIN_FIXED_GAUGE_TARGET_GAP_PATH =
  "/internal/adjustment-maintenance/rain-fixed-gauge-target/gap";
const RAIN_FIXED_GAUGE_TARGET_GAP_STATUS_PATH =
  "/internal/adjustment-maintenance/rain-fixed-gauge-target/gap/status";
const REVISION_RECEIPT_KEYS = ["archiveCommitOrdinal", "archiveCommittedAt", "contractVersion", "frontierSha256",
  "predecessorFrontierSha256", "projectionIdentitySha256", "projectionKind", "projectionSha256",
  "receiptSha256", "stageReceiptSha256"] as const;

export type ApiMaintenanceShadowFamily = "temperature" | "wind";
export type MaintenanceShadowGapReason =
  | "candidate_unavailable"
  | "comparator_unavailable"
  | "source_incomplete"
  | "archive_stage_failed"
  | "database_append_failed"
  | "database_admission_failed"
  | "archive_publish_failed";

export type AdjustmentRevisionGapReason =
  | "archive_stage_failed"
  | "database_bind_failed"
  | "database_admission_failed"
  | "archive_publish_failed";

export interface AdjustmentRevisionStageReceipt {
  readonly contractVersion: "adjustment-revision-stage-receipt/v1";
  readonly durable: true;
  readonly durableAt: string;
  readonly projectionIdentitySha256: string;
  readonly projectionKind: AdjustmentRevisionProjectionKind;
  readonly projectionSha256: string;
  readonly stageReceiptSha256: string;
}

export interface RainMaintenanceControlStateStageReceipt {
  readonly contractVersion: "adjustment-rain-control-state-stage-receipt/v1";
  readonly durable: true;
  readonly durableAt: string;
  readonly stateSha256: string;
  readonly stageReceiptSha256: string;
}

export interface RainMaintenanceControlStateGapInput {
  readonly reason: "projection_stage_failed";
  readonly stateSha256: string;
  readonly stageReceiptSha256: string;
}

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

export interface RainFixedGaugeTargetGapStatusInput {
  readonly logicalHourAt: string;
  readonly logicalKeySha256: string;
}

export type RainFixedGaugeTargetGapStatus = Readonly<{
  contractVersion: "adjustment-rain-fixed-gauge-target-gap-status/v1";
  state: "absent";
}> | Readonly<{
  contractVersion: "adjustment-rain-fixed-gauge-target-gap-status/v1";
  gap: Readonly<{
    contractVersion: "adjustment-rain-fixed-gauge-target-gap/v1";
    gapAt: string;
    gapSha256: string;
    logicalHourAt: string;
    logicalKeySha256: string;
    qualificationDisposition: "forever_unqualified";
    reason: "target_source_oversized";
  }>;
  state: "present";
}>;

export interface AdjustmentRevisionPublishReceipt {
  readonly committed: true;
  readonly committedAt: string;
  readonly contractVersion: "adjustment-revision-publish-receipt/v1";
  readonly projectionIdentitySha256: string;
  readonly projectionKind: AdjustmentRevisionProjectionKind;
  readonly projectionSha256: string;
  readonly publishReceiptSha256: string;
  readonly revisionReceiptSha256: string;
}

export interface AdjustmentRevisionBatchPublishReceipt {
  readonly committed: true;
  readonly committedAt: string;
  readonly contractVersion: "adjustment-revision-batch-publish-receipt/v2";
  readonly projectionIdentitySha256: string;
  readonly projectionKind: "actual_best_match" | "target_revision";
  readonly projectionSha256: string;
  readonly publishReceiptSha256: string;
  readonly revisionReceiptSha256s: readonly string[];
}

export interface AdjustmentRevisionGapInput {
  readonly logicalKeySha256: string;
  readonly projectionIdentitySha256: string | null;
  readonly projectionKind: AdjustmentRevisionProjectionKind;
  readonly projectionSha256: string | null;
  readonly reason: AdjustmentRevisionGapReason;
}

export interface AdjustmentMaintenanceStageInput {
  readonly body: Uint8Array;
  readonly comparator?: Uint8Array;
  readonly metadata: MaintenanceShadowPredictionMetadata;
  readonly sourceProjection: Uint8Array;
  readonly sourceProjectionSha256: string;
}

export interface AdjustmentMaintenanceStageReceipt {
  readonly comparatorSha256?: string;
  readonly contractVersion: "adjustment-shadow-stage-receipt/v1" | "adjustment-shadow-stage-receipt/v2";
  readonly durable: true;
  readonly durableAt: string;
  readonly dueKey: string;
  readonly predictionBodySha256: string;
  readonly registrationSha256: string;
  readonly sourceProjectionSha256: string;
  readonly stageReceiptSha256: string;
}

export interface AdjustmentMaintenancePublishInput {
  readonly body: Uint8Array;
  readonly comparator?: Uint8Array;
  readonly metadata: MaintenanceShadowPredictionMetadata;
  readonly predictionCommittedAt?: string;
  readonly revisionReceipt: AdjustmentRevisionCommitReceipt;
  readonly sourceProjection: Uint8Array;
  readonly sourceProjectionSha256: string;
  readonly stageReceipt: AdjustmentMaintenanceStageReceipt;
}

export interface AdjustmentMaintenancePublishReceipt {
  readonly committed: true;
  readonly committedAt: string;
  readonly comparatorSha256?: string;
  readonly contractVersion: "adjustment-shadow-publish-receipt/v1" | "adjustment-shadow-publish-receipt/v2";
  readonly predictionSha256: string;
  readonly publishReceiptSha256: string;
}

export interface AdjustmentMaintenanceGapInput {
  readonly dueKey: string;
  readonly family: "temperature" | "wind" | "rain";
  readonly reason: MaintenanceShadowGapReason;
  readonly registrationSha256: string;
}

export interface AdjustmentMaintenanceArchiveRelay {
  readonly publish: (
    input: AdjustmentMaintenancePublishInput,
  ) => Promise<AdjustmentMaintenancePublishReceipt>;
  readonly recordGap: (input: AdjustmentMaintenanceGapInput) => Promise<void>;
  readonly stage: (
    input: AdjustmentMaintenanceStageInput,
  ) => Promise<AdjustmentMaintenanceStageReceipt>;
  readonly publishRevision: (input: Readonly<{
    revisionReceipt: AdjustmentRevisionCommitReceipt;
    stageReceipt: AdjustmentRevisionStageReceipt;
  }>) => Promise<AdjustmentRevisionPublishReceipt>;
  readonly publishRevisionBatch: (input: Readonly<{
    revisionReceipts: readonly AdjustmentRevisionCommitReceipt[];
    stageReceipt: AdjustmentRevisionStageReceipt;
  }>) => Promise<AdjustmentRevisionBatchPublishReceipt>;
  readonly recordRevisionGap: (input: AdjustmentRevisionGapInput) => Promise<void>;
  readonly recordRainControlStateGap: (
    input: RainMaintenanceControlStateGapInput,
  ) => Promise<void>;
  readonly recordRainFixedGaugeTargetGap: (
    input: RainFixedGaugeTargetGapInput,
  ) => Promise<RainFixedGaugeTargetGapReceipt>;
  readonly readRainFixedGaugeTargetGap: (
    input: RainFixedGaugeTargetGapStatusInput,
  ) => Promise<RainFixedGaugeTargetGapStatus>;
  readonly stageRainControlState: (
    state: Uint8Array,
  ) => Promise<RainMaintenanceControlStateStageReceipt>;
  readonly stageRevision: (projection: Uint8Array) => Promise<AdjustmentRevisionStageReceipt>;
}

export interface AdjustmentMaintenanceInternalClient {
  readonly capture: (input: AdjustmentMaintenanceCaptureRequest) => Promise<void>;
  readonly publish: (
    sourceProjection: Uint8Array,
    body: Uint8Array,
    comparator: Uint8Array | undefined,
    predictionCommittedAt: string | undefined,
    stageReceipt: AdjustmentMaintenanceStageReceipt,
    revisionReceipt: AdjustmentRevisionCommitReceipt,
  ) => Promise<AdjustmentMaintenancePublishReceipt>;
  readonly recordGap: (input: AdjustmentMaintenanceGapInput) => Promise<void>;
  readonly stage: (
    sourceProjection: Uint8Array,
    body: Uint8Array,
    comparator?: Uint8Array,
  ) => Promise<AdjustmentMaintenanceStageReceipt>;
  readonly publishRevision: (
    projection: Uint8Array,
    stageReceipt: AdjustmentRevisionStageReceipt,
    revisionReceipt: AdjustmentRevisionCommitReceipt,
  ) => Promise<AdjustmentRevisionPublishReceipt>;
  readonly publishRevisionBatch: (
    projection: Uint8Array,
    stageReceipt: AdjustmentRevisionStageReceipt,
    revisionReceipts: readonly AdjustmentRevisionCommitReceipt[],
  ) => Promise<AdjustmentRevisionBatchPublishReceipt>;
  readonly recordRevisionGap: (input: AdjustmentRevisionGapInput) => Promise<void>;
  readonly recordRainControlStateGap: (
    input: RainMaintenanceControlStateGapInput,
  ) => Promise<void>;
  readonly recordRainFixedGaugeTargetGap: (
    input: RainFixedGaugeTargetGapInput,
  ) => Promise<RainFixedGaugeTargetGapReceipt>;
  readonly readRainFixedGaugeTargetGap: (
    input: RainFixedGaugeTargetGapStatusInput,
  ) => Promise<RainFixedGaugeTargetGapStatus>;
  readonly stageRainControlState: (
    state: Uint8Array,
  ) => Promise<RainMaintenanceControlStateStageReceipt>;
  readonly stageRevision: (projection: Uint8Array) => Promise<AdjustmentRevisionStageReceipt>;
}

export interface AdjustmentMaintenanceCaptureRequest {
  readonly dueKey: string;
  readonly issuedAt: string;
}

export interface TemperatureMaintenanceCandidateRow {
  readonly candidateTemperatureC: number;
  readonly fallbackCode: "none" | "missing_source" | "ineligible" | "physical_cap" | "model_unavailable";
  readonly validAt: string;
  readonly wouldApply: boolean;
}

export interface WindMaintenanceCandidateRow {
  readonly candidateGustMps: number | null;
  readonly candidateSpeedMps: number;
  readonly gustWouldApply: boolean;
  readonly speedWouldApply: boolean;
  readonly validAt: string;
}

export interface TemperatureMaintenanceIncumbentRow {
  readonly applied: boolean;
  readonly incumbentTemperatureC: number;
  readonly reasonCode: string | null;
  readonly validAt: string;
}

export interface WindMaintenanceIncumbentRow {
  readonly gustApplied: boolean;
  readonly incumbentGustMps: number | null;
  readonly incumbentSpeedMps: number;
  readonly reasonCode: string | null;
  readonly speedApplied: boolean;
  readonly validAt: string;
}

export interface CaptureApiMaintenanceShadowInput<F extends ApiMaintenanceShadowFamily> {
  readonly candidate: InstalledMaintenanceShadowCandidate<F>;
  readonly captureEpoch: AdjustmentRevisionCaptureEpochWitness;
  readonly dueKey: string;
  readonly evaluate: (
    source: MaintenanceShadowSourceProjection,
  ) => Promise<F extends "temperature"
    ? readonly TemperatureMaintenanceCandidateRow[]
    : readonly WindMaintenanceCandidateRow[]>;
  readonly issuedAt: string;
  readonly incumbentRuntime: LoadedForecastAdjustmentRuntimeV1 | LoadedForecastAdjustmentWindCanaryRuntime;
  readonly queryable: Queryable;
  readonly relay: AdjustmentMaintenanceArchiveRelay;
  readonly rows: readonly WeatherRecordRow[];
}

export interface CaptureApiTemperatureMaintenanceShadowInput {
  readonly bestMatchRows: readonly WeatherRecordRow[];
  readonly candidate: InstalledMaintenanceShadowCandidate<"temperature">;
  readonly captureEpoch: AdjustmentRevisionCaptureEpochWitness;
  readonly dueKey: string;
  readonly evaluate?: (
    source: MaintenanceShadowSourceProjection,
  ) => Promise<readonly TemperatureMaintenanceCandidateRow[]>;
  readonly issuedAt: string;
  readonly incumbentRuntime: LoadedForecastAdjustmentTemperatureCanaryRuntime;
  readonly queryable: Queryable;
  readonly relay: AdjustmentMaintenanceArchiveRelay;
  readonly sidecar: EcmwfTemperatureCanarySidecar;
}

interface CaptureApiMaintenanceGapContext<F extends ApiMaintenanceShadowFamily> {
  readonly candidate: InstalledMaintenanceShadowCandidate<F>;
  readonly dueKey: string;
  readonly relay: AdjustmentMaintenanceArchiveRelay;
}

interface PreparedApiMaintenanceShadowInput<F extends ApiMaintenanceShadowFamily>
  extends CaptureApiMaintenanceGapContext<F> {
  readonly captureEpoch: AdjustmentRevisionCaptureEpochWitness;
  readonly evaluate: CaptureApiMaintenanceShadowInput<F>["evaluate"];
  readonly issuedAt: string;
  readonly incumbentRuntime: LoadedForecastAdjustmentTemperatureCanaryRuntime |
    LoadedForecastAdjustmentRuntimeV1 | LoadedForecastAdjustmentWindCanaryRuntime;
  readonly queryable: Queryable;
}

export type CaptureApiMaintenanceShadowResult =
  | Readonly<{
    predictionSha256: string;
    publishReceiptSha256: string;
    status: "published";
  }>
  | Readonly<{
    reason: MaintenanceShadowGapReason;
    status: "gap";
  }>;

// register only a candidate bound to an immutable deployed artifact proof
export async function registerDeployedApiMaintenanceCandidate<F extends ApiMaintenanceShadowFamily>(
  queryable: Queryable,
  candidate: InstalledMaintenanceShadowCandidate<F>,
): Promise<void> {
  validateInstalledCandidate(candidate);
  await registerApiAdjustmentShadow(queryable, candidate.registration);
}

// project exact selected database rows into the closed private source schema
export function buildForecastMaintenanceSourceProjection<F extends ApiMaintenanceShadowFamily>(input: {
  readonly dueKey: string;
  readonly family: F;
  readonly issuedAt: string;
  readonly registration: AdjustmentShadowRegistration<F>;
  readonly rows: readonly WeatherRecordRow[];
}): Buffer {
  // reserve forecast-row projections for the actual Best Match wind source
  if (input.family !== "wind") {
    throw new RangeError("temperature maintenance requires the ECMWF source builder");
  }
  const expectedRows = 168;
  // reject a shortened causal body instead of qualifying partial evidence
  if (input.rows.length !== expectedRows) {
    throw new RangeError("maintenance source forecast is incomplete");
  }
  const first = input.rows[0]!;
  const firstDataset = first.providerMetadata?.dataset;
  // require one exact provider cycle and lineage across the complete lead halo
  for (const row of input.rows) {
    if (row.productRunAt === null || first.productRunAt === null ||
        instant(row.productRunAt) !== instant(first.productRunAt) ||
        row.providerKey !== first.providerKey || row.sourceKey !== first.sourceKey ||
        row.sourceId !== first.sourceId || row.siteSlug !== first.siteSlug ||
        row.stationSlug !== first.stationSlug || row.adapterVersion !== first.adapterVersion ||
        row.contractEpoch !== first.contractEpoch || row.sourceConfigFingerprint !== first.sourceConfigFingerprint ||
        row.upstreamModel !== first.upstreamModel || row.providerMetadata?.dataset !== firstDataset) {
      throw new RangeError("maintenance source forecast cycle differs");
    }
  }
  const projection: MaintenanceShadowSourceProjection = {
    candidateSha256: input.registration.candidateSha256,
    contractVersion: MAINTENANCE_SHADOW_SOURCE_VERSION,
    dueKey: input.dueKey,
    family: input.family,
    issuedAt: input.issuedAt,
    registrationSha256: input.registration.registrationSha256,
    rowCount: input.rows.length,
    rows: input.rows.map(
      // preserve each authoritative storage receipt and content identity
      (row, index) => projectForecastSourceRow(
        input.family,
        row,
        index,
        input.registration.sourceSha256,
      ),
    ),
    sourceSha256: input.registration.sourceSha256,
  };
  return encodeMaintenanceShadowSourceProjection(projection);
}

// project the complete ECMWF input, rolling state and Best Match comparator
export function buildTemperatureMaintenanceSourceProjection(input: {
  readonly bestMatchRows: readonly WeatherRecordRow[];
  readonly dueKey: string;
  readonly issuedAt: string;
  readonly registration: AdjustmentShadowRegistration<"temperature">;
  readonly sidecar: EcmwfTemperatureCanarySidecar;
}): Buffer {
  // require the complete causal twelve-hour source and comparator halos
  if (input.sidecar.hours.length !== 12 || input.bestMatchRows.length !== 12) {
    throw new RangeError("temperature maintenance source is incomplete");
  }
  const comparatorByValidAt = new Map(input.bestMatchRows.map(
    // key only the exact storage valid clock
    (row) => [instant(row.validAt), row],
  ));
  const run = input.sidecar.run;
  const rows = input.sidecar.hours.map(
    // retain every numerical input consumed by the inactive temperature bundle
    (hour, index) => {
      const validAt = instant(hour.validAt);
      const comparator = comparatorByValidAt.get(validAt);
      // refuse a comparator assembled from another or duplicate geometry
      if (comparator === undefined || comparator.productRunAt === null ||
          comparator.providerMetadata?.dataset !== "best_match" ||
          !HASH.test(comparator.contentHash) || !HASH.test(hour.contentHash) ||
          !/^[1-9]\d{0,19}$/u.test(String(comparator.sourceId)) ||
          instant(comparator.productRunAt) > input.issuedAt) {
        throw new RangeError("temperature maintenance comparator differs");
      }
      return {
        adapterVersion: run.adapterVersion,
        bestMatchContentSha256: comparator.contentHash,
        bestMatchProductRunAt: instant(comparator.productRunAt),
        bestMatchSourceId: String(comparator.sourceId),
        bestMatchTemperatureC64: nullableBinary64(comparator.temperatureC),
        contentSha256: hour.contentHash,
        dataset: "single_run",
        leadHours: index + 1,
        modelCycle: run.modelCycle,
        modelLeadHours: hour.modelLeadHours,
        providerKey: "open-meteo",
        providerResponseSha256: run.providerResponseSha256,
        rawRelativeHumidityPercent64: nullableBinary64(hour.rawRelativeHumidityPercent),
        rawTemperatureC64: encodeMaintenanceBinary64(hour.rawTemperatureC),
        rawWindSpeedMps64: nullableBinary64(hour.rawWindSpeedMps),
        receivedAt: instant(run.firstReceivedAt),
        referenceAt: instant(run.runInitializedAt),
        sourceSha256: input.registration.sourceSha256,
        upstreamModel: run.upstreamModel,
        validAt,
      };
    },
  );
  const projection: MaintenanceShadowSourceProjection = {
    candidateSha256: input.registration.candidateSha256,
    contractVersion: MAINTENANCE_SHADOW_SOURCE_VERSION,
    dueKey: input.dueKey,
    family: "temperature",
    issuedAt: input.issuedAt,
    recentErrorState: run.recentErrorState,
    registrationSha256: input.registration.registrationSha256,
    rowCount: rows.length,
    rows,
    sourceSha256: input.registration.sourceSha256,
  };
  return encodeMaintenanceShadowSourceProjection(projection);
}

// evaluate one installed inactive temperature bundle on the captured raw source
export function evaluateTemperatureMaintenanceCandidate(
  candidate: InstalledMaintenanceShadowCandidate<"temperature">,
  source: MaintenanceShadowSourceProjection,
): readonly TemperatureMaintenanceCandidateRow[] {
  if (source.family !== "temperature" || source.recentErrorState === undefined) {
    throw new RangeError("temperature maintenance source differs");
  }
  const bundle = candidate.bundle as unknown as ForecastAdjustmentTemperatureMaintenanceRuntimePackage;
  verifyForecastAdjustmentMaintenanceRuntimePackage(bundle);
  return source.rows.map(
    // execute exactly the same numerical path while withholding activation authority
    (row) => {
      const rawBestMatchTemperatureC = nullableDecoded(row.bestMatchTemperatureC64);
      const rawTemperatureC = decodeMaintenanceBinary64(row.rawTemperatureC64);
      const decision = applyForecastAdjustmentTemperatureMaintenanceCandidate({
        bundleSha256: bundle.bundleSha256,
        maintenanceAuthority: null,
        model: bundle.model,
        servedForecastIdentity: {
          adapterVersion: bundle.source.adapterVersion,
          dataset: bundle.source.dataset,
          maximumReceiptAgeHours: bundle.source.maximumReceiptAgeHours,
          providerKey: bundle.source.providerKey,
          sourceDelayHours: bundle.source.sourceDelayHours,
          upstreamModel: bundle.source.upstreamModel,
        },
        trainingForecastIdentity: {
          cohort: bundle.source.cohort,
          scope: bundle.source.scope,
        },
      }, {
        evaluatedAt: source.issuedAt,
        rawBestMatchTemperatureC,
        recentErrorState: source.recentErrorState!,
        sourceForecast: {
          adapterVersion: String(row.adapterVersion),
          dataset: "single_run",
          firstReceivedAt: String(row.receivedAt),
          modelCycle: row.modelCycle as "49r1" | "50r1",
          modelLeadHours: Number(row.modelLeadHours),
          providerKey: "open-meteo",
          providerResponseSha256: String(row.providerResponseSha256),
          rawRelativeHumidityPercent: nullableDecoded(row.rawRelativeHumidityPercent64),
          rawTemperatureC,
          rawWindSpeedMps: nullableDecoded(row.rawWindSpeedMps64),
          runInitializedAt: String(row.referenceAt),
          upstreamModel: "ecmwf_ifs",
          validAt: String(row.validAt),
        },
        validAt: String(row.validAt),
      });
      const wouldApply = decision.state === "active" && decision.correctedTemperatureC !== null;
      return {
        candidateTemperatureC: wouldApply
          ? decision.correctedTemperatureC!
          : rawBestMatchTemperatureC ?? rawTemperatureC,
        fallbackCode: wouldApply ? "none" : temperatureFallbackCode(decision.reasonCode),
        validAt: String(row.validAt),
        wouldApply,
      };
    },
  );
}

// evaluate one installed inactive wind bundle on the captured Best Match rows
export function evaluateWindMaintenanceCandidate(
  candidate: InstalledMaintenanceShadowCandidate<"wind">,
  source: MaintenanceShadowSourceProjection,
): readonly WindMaintenanceCandidateRow[] {
  if (source.family !== "wind") {
    throw new RangeError("wind maintenance source differs");
  }
  const bundle = candidate.bundle as unknown as ForecastAdjustmentWindMaintenanceRuntimePackage;
  verifyForecastAdjustmentMaintenanceRuntimePackage(bundle);
  return source.rows.map(
    // preserve raw values whenever the verified candidate declines one metric
    (row, index) => {
      const rawSpeed = nullableDecoded(row.windSpeedMps64);
      const rawGust = nullableDecoded(row.windGustMps64);
      if (rawSpeed === null || (rawGust === null && (index < 48 || index >= 72))) {
        throw new RangeError("wind maintenance raw metric is missing");
      }
      const decision = applyForecastAdjustmentWindMaintenanceCandidate(
        bundle.bundleSha256,
        bundle.candidate,
        {
        evaluatedAt: source.issuedAt,
        metrics: windMetrics(rawSpeed, rawGust),
        rawForecastProvenance: {
          adapterVersion: String(row.adapterVersion),
          cohort: "legacy_v4_retrieval_snapshot",
          contractEpoch: String(row.contractEpoch),
          dataset: String(row.dataset),
          referenceAt: String(row.referenceAt),
          referenceKind: "retrieval_snapshot",
          sourceConfigFingerprint: String(row.sourceConfigFingerprint),
          sourceKey: String(row.sourceKey),
          targetLeadHours: Number(row.modelLeadHours),
          upstreamModel: String(row.upstreamModel),
          validAt: String(row.validAt),
        },
        },
      );
      const applied = decision.state === "active" ? new Set(decision.appliedMetrics) : new Set<string>();
      const gustDisabled = index >= 48 && index < 72;
      return {
        candidateGustMps: gustDisabled
          ? null
          : decision.state === "active" && applied.has("windGustMps")
            ? decision.adjustedMetrics.windGustMps!
            : rawGust!,
        candidateSpeedMps: decision.state === "active" && applied.has("windSpeedMps")
          ? decision.adjustedMetrics.windSpeedMps!
          : rawSpeed,
        gustWouldApply: !gustDisabled && applied.has("windGustMps"),
        speedWouldApply: applied.has("windSpeedMps"),
        validAt: String(row.validAt),
      };
    },
  );
}

// replay the exact startup temperature incumbent on the captured candidate source
export function evaluateTemperatureMaintenanceIncumbent(
  runtime: LoadedForecastAdjustmentTemperatureCanaryRuntime,
  source: MaintenanceShadowSourceProjection,
): readonly TemperatureMaintenanceIncumbentRow[] {
  if (source.family !== "temperature" || source.recentErrorState === undefined) {
    throw new RangeError("temperature maintenance source differs");
  }
  return source.rows.map(
    // preserve the actual served adjusted-or-raw value for every target hour
    (row) => {
      const rawBestMatchTemperatureC = nullableDecoded(row.bestMatchTemperatureC64);
      const rawTemperatureC = decodeMaintenanceBinary64(row.rawTemperatureC64);
      const decision = applyForecastAdjustmentTemperatureCanary(runtime, {
        evaluatedAt: source.issuedAt,
        rawBestMatchTemperatureC,
        recentErrorState: source.recentErrorState!,
        sourceForecast: {
          adapterVersion: String(row.adapterVersion),
          dataset: "single_run",
          firstReceivedAt: String(row.receivedAt),
          modelCycle: row.modelCycle as "49r1" | "50r1",
          modelLeadHours: Number(row.modelLeadHours),
          providerKey: "open-meteo",
          providerResponseSha256: String(row.providerResponseSha256),
          rawRelativeHumidityPercent: nullableDecoded(row.rawRelativeHumidityPercent64),
          rawTemperatureC,
          rawWindSpeedMps: nullableDecoded(row.rawWindSpeedMps64),
          runInitializedAt: String(row.referenceAt),
          upstreamModel: "ecmwf_ifs",
          validAt: String(row.validAt),
        },
        validAt: String(row.validAt),
      });
      const applied = decision.state === "active" && decision.correctedTemperatureC !== null;
      return {
        applied,
        incumbentTemperatureC: applied
          ? decision.correctedTemperatureC!
          : rawBestMatchTemperatureC ?? rawTemperatureC,
        reasonCode: decision.reasonCode,
        validAt: String(row.validAt),
      };
    },
  );
}

// replay the exact startup wind incumbent on the same complete best-match halo
export function evaluateWindMaintenanceIncumbent(
  runtime: LoadedForecastAdjustmentRuntimeV1 | LoadedForecastAdjustmentWindCanaryRuntime,
  source: MaintenanceShadowSourceProjection,
): readonly WindMaintenanceIncumbentRow[] {
  if (source.family !== "wind") {
    throw new RangeError("wind maintenance source differs");
  }
  return source.rows.map(
    // preserve actual metric-level serving decisions and raw fallback values
    (row, index) => {
      const rawSpeed = nullableDecoded(row.windSpeedMps64);
      const rawGust = nullableDecoded(row.windGustMps64);
      if (rawSpeed === null || (rawGust === null && (index < 48 || index >= 72))) {
        throw new RangeError("wind maintenance raw metric is missing");
      }
      const decision = applyForecastAdjustment(runtime, {
        evaluatedAt: source.issuedAt,
        metrics: windMetrics(rawSpeed, rawGust),
        rawForecastProvenance: {
          adapterVersion: String(row.adapterVersion),
          cohort: "legacy_v4_retrieval_snapshot",
          contractEpoch: String(row.contractEpoch),
          dataset: String(row.dataset),
          referenceAt: String(row.referenceAt),
          referenceKind: "retrieval_snapshot",
          sourceConfigFingerprint: String(row.sourceConfigFingerprint),
          sourceKey: String(row.sourceKey),
          targetLeadHours: Number(row.modelLeadHours),
          upstreamModel: String(row.upstreamModel),
          validAt: String(row.validAt),
        },
      });
      const applied = decision.state === "active" ? new Set(decision.appliedMetrics) : new Set<string>();
      const gustUnavailable = index >= 48 && index < 72;
      return {
        gustApplied: !gustUnavailable && applied.has("windGustMps"),
        incumbentGustMps: gustUnavailable
          ? null
          : applied.has("windGustMps")
            ? decision.adjustedMetrics.windGustMps!
            : rawGust!,
        incumbentSpeedMps: applied.has("windSpeedMps")
          ? decision.adjustedMetrics.windSpeedMps!
          : rawSpeed,
        reasonCode: decision.reasonCode,
        speedApplied: applied.has("windSpeedMps"),
        validAt: String(row.validAt),
      };
    },
  );
}

// run one isolated candidate without affecting the served forecast response
export async function captureApiAdjustmentMaintenanceShadow<F extends ApiMaintenanceShadowFamily>(
  input: CaptureApiMaintenanceShadowInput<F>,
): Promise<CaptureApiMaintenanceShadowResult> {
  try {
    validateInstalledCandidate(input.candidate);
  } catch {
    return await reportGap(input, "candidate_unavailable");
  }
  let sourceBytes: Buffer;
  let source: MaintenanceShadowSourceProjection;
  // classify source geometry independently from candidate execution
  try {
    sourceBytes = buildForecastMaintenanceSourceProjection({
      dueKey: input.dueKey,
      family: input.candidate.registration.family,
      issuedAt: input.issuedAt,
      registration: input.candidate.registration,
      rows: input.rows,
    });
    source = parseMaintenanceShadowSourceProjection(sourceBytes);
    requireMaintenanceShadowSourceAfterCaptureEpoch(input.captureEpoch, source);
  } catch {
    return await reportGap(input, "source_incomplete");
  }
  return await capturePreparedApiMaintenanceShadow(input, sourceBytes, source);
}

// capture one temperature shadow from the retained ECMWF sidecar and comparator
export async function captureApiTemperatureMaintenanceShadow(
  input: CaptureApiTemperatureMaintenanceShadowInput,
): Promise<CaptureApiMaintenanceShadowResult> {
  try {
    validateInstalledCandidate(input.candidate);
  } catch {
    return await reportGap(input, "candidate_unavailable");
  }
  let sourceBytes: Buffer;
  let source: MaintenanceShadowSourceProjection;
  // construct only the complete typed temperature projection
  try {
    sourceBytes = buildTemperatureMaintenanceSourceProjection({
      bestMatchRows: input.bestMatchRows,
      dueKey: input.dueKey,
      issuedAt: input.issuedAt,
      registration: input.candidate.registration,
      sidecar: input.sidecar,
    });
    source = parseMaintenanceShadowSourceProjection(sourceBytes);
    requireMaintenanceShadowSourceAfterCaptureEpoch(input.captureEpoch, source);
  } catch {
    return await reportGap(input, "source_incomplete");
  }
  return await capturePreparedApiMaintenanceShadow({
    ...input,
    evaluate: input.evaluate ?? ((projection) => Promise.resolve(
      evaluateTemperatureMaintenanceCandidate(input.candidate, projection),
    )),
  }, sourceBytes, source);
}

// stage, append and publish one already-validated complete source projection
async function capturePreparedApiMaintenanceShadow<F extends ApiMaintenanceShadowFamily>(
  input: PreparedApiMaintenanceShadowInput<F>,
  sourceBytes: Buffer,
  source: MaintenanceShadowSourceProjection,
): Promise<CaptureApiMaintenanceShadowResult> {
  let candidateRows: readonly TemperatureMaintenanceCandidateRow[] | readonly WindMaintenanceCandidateRow[];
  // contain an unavailable inactive candidate loader
  try {
    candidateRows = await input.evaluate(source);
  } catch {
    return await reportGap(input, "candidate_unavailable");
  }
  let bodyBytes: Buffer;
  let comparatorBytes: Buffer;
  let metadata: MaintenanceShadowPredictionMetadata;
  // validate candidate output against the exact source projection
  try {
    bodyBytes = createForecastMaintenanceBody(sourceBytes, candidateRows);
    metadata = createMaintenanceShadowPredictionMetadata(bodyBytes, sourceBytes);
  } catch {
    return await reportGap(input, "candidate_unavailable");
  }
  // evaluate the already-loaded serving incumbent without a second scheduler or loader
  try {
    comparatorBytes = createApiMaintenanceComparator(sourceBytes, bodyBytes, input.incumbentRuntime);
  } catch {
    return await reportGap(input, "comparator_unavailable");
  }
  let stageReceipt: AdjustmentMaintenanceStageReceipt;
  // require durable staging before any compact database append
  try {
    stageReceipt = await stageAdjustmentMaintenanceShadow(input.relay, sourceBytes, bodyBytes, comparatorBytes);
  } catch {
    return await reportGap(input, "archive_stage_failed");
  }
  let predictionCommittedAt: string;
  let revisionReceipt: AdjustmentRevisionCommitReceipt;
  // append only after immutable deployment proof and durable raw-body staging
  try {
    await registerDeployedApiMaintenanceCandidate(
      input.queryable,
      input.candidate,
    );
    const append = input.candidate.registration.family === "temperature"
      ? appendTemperatureAdjustmentShadow
      : appendWindAdjustmentShadow;
    const prediction = {
      ...metadata,
      stageReceiptSha256: stageReceipt.stageReceiptSha256,
    } as AdjustmentShadowPrediction;
    const appended = await append(input.queryable, prediction);
    predictionCommittedAt = appended.committedAt;
    revisionReceipt = appended.revisionReceipt;
  } catch {
    return await reportGap(input, "database_append_failed");
  }
  let receipt: AdjustmentMaintenancePublishReceipt;
  // publish only after the API role observes exact database admission
  try {
    receipt = await publishAdmittedAdjustmentMaintenanceShadow(
      input.queryable,
      input.relay,
      sourceBytes,
      bodyBytes,
      comparatorBytes,
      predictionCommittedAt,
      stageReceipt,
      revisionReceipt,
    );
  } catch (error) {
    return await reportGap(
      input,
      error instanceof AdmissionError
        ? "database_admission_failed"
        : "archive_publish_failed",
    );
  }
  return {
    predictionSha256: metadata.predictionSha256,
    publishReceiptSha256: receipt.publishReceiptSha256,
    status: "published",
  };
}

// stage exact canonical source and body bytes through the archive relay
export async function stageAdjustmentMaintenanceShadow(
  relay: AdjustmentMaintenanceArchiveRelay,
  sourceProjection: Uint8Array,
  body: Uint8Array,
  comparator?: Uint8Array,
): Promise<AdjustmentMaintenanceStageReceipt> {
  const metadata = createMaintenanceShadowPredictionMetadata(body, sourceProjection);
  const sourceProjectionSha256 = sha256(sourceProjection);
  // require the additive comparator to cross-bind before leaving this process
  if (comparator !== undefined) {
    validateMaintenanceShadowComparatorBinding(
      parseMaintenanceShadowComparator(comparator), sourceProjection, body,
    );
  }
  const receipt = await relay.stage({
    body,
    ...(comparator === undefined ? {} : { comparator }),
    metadata,
    sourceProjection,
    sourceProjectionSha256,
  });
  validateStageReceipt(receipt, metadata, sourceProjectionSha256, comparator);
  return receipt;
}

// require exact compact admission before making staged bytes publishable
export async function publishAdmittedAdjustmentMaintenanceShadow(
  queryable: Queryable,
  relay: AdjustmentMaintenanceArchiveRelay,
  sourceProjection: Uint8Array,
  body: Uint8Array,
  comparator: Uint8Array | undefined,
  predictionCommittedAt: string | undefined,
  stageReceipt: AdjustmentMaintenanceStageReceipt,
  revisionReceipt: AdjustmentRevisionCommitReceipt,
): Promise<AdjustmentMaintenancePublishReceipt> {
  const metadata = createMaintenanceShadowPredictionMetadata(body, sourceProjection);
  const sourceProjectionSha256 = sha256(sourceProjection);
  // reject comparator substitution before database admission is consulted
  if (comparator !== undefined) {
    validateMaintenanceShadowComparatorBinding(
      parseMaintenanceShadowComparator(comparator), sourceProjection, body,
    );
  }
  validateStageReceipt(stageReceipt, metadata, sourceProjectionSha256, comparator);
  validateRevisionReceipt(revisionReceipt, metadata, stageReceipt.stageReceiptSha256);
  // require the original compact-row commit clock only for additive v2 capsules
  if ((comparator === undefined) !== (predictionCommittedAt === undefined) ||
      (predictionCommittedAt !== undefined &&
        (!validInstant(predictionCommittedAt) ||
          Date.parse(predictionCommittedAt) < Date.parse(metadata.issuedAt) ||
          Date.parse(predictionCommittedAt) > Date.parse(revisionReceipt.archiveCommittedAt)))) {
    throw new AdmissionError();
  }
  const admitted = await isAdjustmentShadowBodyAdmitted(
    queryable,
    metadata.registrationSha256,
    metadata.dueKey,
    metadata.predictionBodySha256,
    metadata.bodyByteCount,
  );
  // a staged body is not publishable without exact database admission
  if (!admitted) {
    throw new AdmissionError();
  }
  let admittedRevision: AdjustmentRevisionCommitReceipt;
  // authenticate the worker-returned receipt against the API-only database facade
  try {
    admittedRevision = await readAdjustmentShadowRevisionAdmission(
      queryable,
      metadata.registrationSha256,
      metadata.dueKey,
      metadata.predictionBodySha256,
      metadata.bodyByteCount,
    );
    validateRevisionReceipt(admittedRevision, metadata, stageReceipt.stageReceiptSha256);
    // refuse a relay-supplied revision that differs from database authority
    if (!REVISION_RECEIPT_KEYS.every((key) => admittedRevision[key] === revisionReceipt[key])) {
      throw new AdmissionError();
    }
  } catch {
    throw new AdmissionError();
  }
  const receipt = await relay.publish({
    body,
    ...(comparator === undefined ? {} : { comparator }),
    metadata,
    ...(predictionCommittedAt === undefined ? {} : { predictionCommittedAt }),
    revisionReceipt: admittedRevision,
    sourceProjection,
    sourceProjectionSha256,
    stageReceipt,
  });
  validatePublishReceipt(receipt, metadata, comparator);
  return receipt;
}

// stage one closed normalized database revision before its pointer bind
export async function stageAdjustmentRevision(
  relay: AdjustmentMaintenanceArchiveRelay,
  projectionBytes: Uint8Array,
): Promise<AdjustmentRevisionStageReceipt> {
  const projection = parseAdjustmentRevisionTransportDocument(projectionBytes);
  const identity = sha256(projectionBytes);
  const receipt = await relay.stageRevision(projectionBytes);
  validateAdjustmentRevisionStageReceipt(receipt, projection, identity);
  return receipt;
}

// authenticate every grouped current pointer before one body publication
export async function publishAdmittedAdjustmentRevisionBatch(
  queryable: Queryable,
  relay: AdjustmentMaintenanceArchiveRelay,
  projectionBytes: Uint8Array,
  stageReceipt: AdjustmentRevisionStageReceipt,
  revisionReceipts: readonly AdjustmentRevisionCommitReceipt[],
): Promise<AdjustmentRevisionBatchPublishReceipt> {
  const projection = parseAdjustmentRevisionGroupProjection(projectionBytes);
  const identity = sha256(projectionBytes);
  validateAdjustmentRevisionStageReceipt(stageReceipt, projection, identity);
  // require one caller receipt for every ordered canonical row
  if (!Array.isArray(revisionReceipts) || revisionReceipts.length !== projection.rows.length) {
    throw new AdmissionError();
  }
  let admitted: readonly AdjustmentRevisionCommitReceipt[];
  try {
    admitted = await readAdjustmentRevisionBatchAdmissions(queryable, projection);
    validateAdjustmentDatabaseRevisionReceiptBatch(admitted, projection, stageReceipt);
    // reject caller receipts that differ from database authority at any ordinal
    if (admitted.some((receipt, index) => !REVISION_RECEIPT_KEYS.every(
      (key) => receipt[key] === revisionReceipts[index]?.[key],
    ))) {
      throw new AdmissionError();
    }
  } catch {
    await recordPersistedAdjustmentRevisionBatchGaps(
      queryable,
      relay,
      projection,
      identity,
      "database_admission_failed",
    );
    throw new AdmissionError();
  }
  let receipt: AdjustmentRevisionBatchPublishReceipt;
  try {
    receipt = await relay.publishRevisionBatch({ revisionReceipts: admitted, stageReceipt });
  } catch (error) {
    await recordPersistedAdjustmentRevisionBatchGaps(
      queryable,
      relay,
      projection,
      identity,
      "archive_publish_failed",
    );
    throw error;
  }
  validateAdjustmentRevisionBatchPublishReceipt(receipt, projection, admitted);
  return receipt;
}

// authenticate one persisted current pointer before publishing its staged bytes
export async function publishAdmittedAdjustmentRevision(
  queryable: Queryable,
  relay: AdjustmentMaintenanceArchiveRelay,
  projectionBytes: Uint8Array,
  stageReceipt: AdjustmentRevisionStageReceipt,
  revisionReceipt: AdjustmentRevisionCommitReceipt,
): Promise<AdjustmentRevisionPublishReceipt> {
  const projection = parseAdjustmentRevisionSingleProjection(projectionBytes);
  const identity = adjustmentRevisionProjectionIdentity(projectionBytes);
  validateAdjustmentRevisionStageReceipt(stageReceipt, projection, identity);
  validateAdjustmentDatabaseRevisionReceipt(revisionReceipt, projection, stageReceipt);
  let admitted: AdjustmentRevisionCommitReceipt;
  // read only the exact value-free serving pointer through the api-role facade
  try {
    admitted = await readAdjustmentRevisionAdmission(queryable, projection);
    validateAdjustmentDatabaseRevisionReceipt(admitted, projection, stageReceipt);
    // reject a worker receipt that differs from database authority
    if (!REVISION_RECEIPT_KEYS.every((key) => admitted[key] === revisionReceipt[key])) {
      throw new AdmissionError();
    }
  } catch {
    await recordPersistedAdjustmentRevisionGap(
      queryable,
      relay,
      projection,
      identity,
      "database_admission_failed",
    );
    throw new AdmissionError();
  }
  let receipt: AdjustmentRevisionPublishReceipt;
  // permanently disqualify a pointer whose durable archive publication fails
  try {
    receipt = await relay.publishRevision({ revisionReceipt: admitted, stageReceipt });
  } catch (error) {
    await recordPersistedAdjustmentRevisionGap(
      queryable,
      relay,
      projection,
      identity,
      "archive_publish_failed",
    );
    throw error;
  }
  validateAdjustmentRevisionPublishReceipt(receipt, projection, admitted);
  return receipt;
}

// mark one exact current revision permanently unqualified and archive its category
async function recordPersistedAdjustmentRevisionGap(
  queryable: Queryable,
  relay: AdjustmentMaintenanceArchiveRelay,
  projection: AdjustmentRevisionSingleProjection,
  identity: string,
  reason: Extract<AdjustmentRevisionGapReason, "database_admission_failed" | "archive_publish_failed">,
): Promise<void> {
  const gap: AdjustmentRevisionGapInput = {
    logicalKeySha256: adjustmentRevisionLogicalKeySha256(projection.projectionKind, projection.logicalKey),
    projectionIdentitySha256: identity,
    projectionKind: projection.projectionKind,
    projectionSha256: identity,
    reason,
  };
  const { key, relationKind } = adjustmentRevisionGapDatabaseKey(projection);
  // persist the database marker before attempting the cold value-free gap record
  try {
    await markAdjustmentRevisionGap(queryable, relationKind, key, gap);
  } finally {
    try {
      await relay.recordRevisionGap(gap);
    } catch {
      // preserve the permanent database marker when cold gap archival is unavailable
    }
  }
}

// persist every row marker before reporting one grouped publication failure
async function recordPersistedAdjustmentRevisionBatchGaps(
  queryable: Queryable,
  relay: AdjustmentMaintenanceArchiveRelay,
  projection: AdjustmentRevisionGroupProjection,
  identity: string,
  reason: Extract<AdjustmentRevisionGapReason, "database_admission_failed" | "archive_publish_failed">,
): Promise<void> {
  let archiveGap: AdjustmentRevisionGapInput | undefined;
  // retain the fixed twelve-gauge body under one shared value-free logical key
  if (projection.contractVersion === "adjustment-rain-fixed-gauge-target-projection/v1") {
    const logicalKeySha256 = adjustmentRainFixedGaugeTargetLogicalKeySha256({
      sourceIds: projection.rows.map((row) => row.normalizedRecord.sourceId),
      validAt: projection.validAt,
    });
    for (const row of projection.rows) {
      const gap: AdjustmentRevisionGapInput = {
        logicalKeySha256,
        projectionIdentitySha256: identity,
        projectionKind: "target_revision",
        projectionSha256: identity,
        reason,
      };
      await markAdjustmentRevisionGap(queryable, "weather_record", {
        productRunAt: null,
        sourceId: row.normalizedRecord.sourceId,
        sourceKind: "physical_sensor",
        storedContentSha256: row.storedContentSha256,
        validAt: projection.validAt,
      }, gap);
      archiveGap ??= gap;
    }
    try {
      await relay.recordRevisionGap(archiveGap!);
    } catch {
      // preserve every permanent database marker when cold gap archival is unavailable
    }
    return;
  }
  // retain every row-specific logical identity sharing the grouped body
  for (const row of projection.rows) {
    const logicalKey = {
      ...projection.logicalKey,
      validAt: String(row.validAt),
    };
    const gap: AdjustmentRevisionGapInput = {
      logicalKeySha256: adjustmentRevisionLogicalKeySha256(projection.projectionKind, logicalKey),
      projectionIdentitySha256: identity,
      projectionKind: projection.projectionKind,
      projectionSha256: identity,
      reason,
    };
    await markAdjustmentRevisionGap(queryable, "weather_record", {
      productRunAt: projection.logicalKey.productRunAt as string | null,
      sourceId: String(projection.logicalKey.sourceId),
      sourceKind: projection.logicalKey.sourceKind as "forecast" | "physical_sensor",
      storedContentSha256: String(row.contentSha256),
      validAt: String(row.validAt),
    }, gap);
    archiveGap ??= gap;
  }
  try {
    // archive one terminal disposition for the one shared grouped body
    await relay.recordRevisionGap(archiveGap!);
  } catch {
    // preserve every permanent database marker when cold gap archival is unavailable
  }
}

// derive the exact relation-specific database marker key from a validated body
function adjustmentRevisionGapDatabaseKey(projection: AdjustmentRevisionSingleProjection): Readonly<{
  key: Parameters<typeof markAdjustmentRevisionGap>[2];
  relationKind: "ecmwf_temperature" | "forecast_anchor" | "rain_gate" | "weather_record";
}> {
  const key = projection.logicalKey;
  // weather targets and comparators share one current revision relation
  if (projection.projectionKind === "actual_best_match" || projection.projectionKind === "target_revision") {
    return { key: {
      productRunAt: key.productRunAt as string | null,
      sourceId: String(key.sourceId),
      sourceKind: key.sourceKind as "forecast" | "physical_sensor",
      storedContentSha256: projection.storedContentSha256,
      validAt: String(key.validAt),
    }, relationKind: "weather_record" };
  }
  // the rain gate pointer uses its immutable run identity
  if (projection.projectionKind === "rain_gate_input") {
    return { key: {
      inputSha256: String(key.inputSha256),
      modelSha256: String(key.modelSha256),
      runInitializedAt: String(key.runInitializedAt),
      storedContentSha256: projection.storedContentSha256,
    }, relationKind: "rain_gate" };
  }
  // complete temperature runs and fixed anchors use separate relations
  if (key.sourceType === "ecmwf_temperature_run") {
    return { key: {
      providerResponseSha256: String(key.providerResponseSha256),
      runInitializedAt: String(key.runInitializedAt),
      siteId: String(key.siteId),
      storedContentSha256: projection.storedContentSha256,
    }, relationKind: "ecmwf_temperature" };
  }
  return { key: {
    leadHours: Number(key.leadHours),
    sourceId: String(key.sourceId),
    storedContentSha256: projection.storedContentSha256,
    validAt: String(key.validAt),
  }, relationKind: "forecast_anchor" };
}

// select the only admission facade corresponding to the closed logical key
async function readAdjustmentRevisionAdmission(
  queryable: Queryable,
  projection: AdjustmentRevisionSingleProjection,
): Promise<AdjustmentRevisionCommitReceipt> {
  const key = projection.logicalKey;
  // comparator and target revisions share the weather-record facade
  if (projection.projectionKind === "actual_best_match" || projection.projectionKind === "target_revision") {
    return await readAdjustmentWeatherRevisionAdmission(queryable, {
      productRunAt: key.productRunAt as string | null,
      sourceId: String(key.sourceId),
      sourceKind: key.sourceKind as "forecast" | "physical_sensor",
      storedContentSha256: projection.storedContentSha256,
      validAt: String(key.validAt),
    });
  }
  // rain gates are keyed by their immutable model/input run tuple
  if (projection.projectionKind === "rain_gate_input") {
    return await readAdjustmentRainGateRevisionAdmission(queryable, {
      inputSha256: String(key.inputSha256),
      modelSha256: String(key.modelSha256),
      runInitializedAt: String(key.runInitializedAt),
      storedContentSha256: projection.storedContentSha256,
    });
  }
  // complete ECMWF projections bind the retained run rather than one hour
  if (key.sourceType === "ecmwf_temperature_run") {
    return await readAdjustmentEcmwfTemperatureRevisionAdmission(queryable, {
      providerResponseSha256: String(key.providerResponseSha256),
      runInitializedAt: String(key.runInitializedAt),
      siteId: String(key.siteId),
      storedContentSha256: projection.storedContentSha256,
    });
  }
  return await readAdjustmentForecastAnchorRevisionAdmission(queryable, {
    leadHours: Number(key.leadHours),
    sourceId: String(key.sourceId),
    storedContentSha256: projection.storedContentSha256,
    validAt: String(key.validAt),
  });
}

// read every exact grouped weather pointer in canonical row order
async function readAdjustmentRevisionBatchAdmissions(
  queryable: Queryable,
  projection: AdjustmentRevisionGroupProjection,
): Promise<readonly AdjustmentRevisionCommitReceipt[]> {
  // authenticate each dedicated gauge row against its own live weather pointer
  if (projection.contractVersion === "adjustment-rain-fixed-gauge-target-projection/v1") {
    const receipts: AdjustmentRevisionCommitReceipt[] = [];
    for (const row of projection.rows) {
      receipts.push(await readAdjustmentWeatherRevisionAdmission(queryable, {
        productRunAt: null,
        sourceId: row.normalizedRecord.sourceId,
        sourceKind: "physical_sensor",
        storedContentSha256: row.storedContentSha256,
        validAt: projection.validAt,
      }));
    }
    return receipts;
  }
  const key = projection.logicalKey;
  const receipts: AdjustmentRevisionCommitReceipt[] = [];
  // keep row order identical to the canonical body and database receipt array
  for (const row of projection.rows) {
    receipts.push(await readAdjustmentWeatherRevisionAdmission(queryable, {
      productRunAt: key.productRunAt as string | null,
      sourceId: String(key.sourceId),
      sourceKind: key.sourceKind as "forecast" | "physical_sensor",
      storedContentSha256: String(row.contentSha256),
      validAt: String(row.validAt),
    }));
  }
  return receipts;
}

type AdjustmentRevisionGroupProjection =
  | AdjustmentRevisionBatchProjection
  | AdjustmentRainFixedGaugeTargetProjection;

type AdjustmentRevisionSingleProjection =
  | AdjustmentRevisionProjection
  | AdjustmentTemperatureNativeSourceProjection;

type AdjustmentRevisionTransportDocument =
  | AdjustmentRevisionProjectionDocument
  | AdjustmentRainFixedGaugeTargetProjection;

// select the additive large fixed-gauge body without widening the legacy parser
function parseAdjustmentRevisionTransportDocument(
  bytes: Uint8Array,
): AdjustmentRevisionTransportDocument {
  const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as
    Readonly<{ contractVersion?: unknown }>;
  return value.contractVersion === "adjustment-rain-fixed-gauge-target-projection/v1"
    ? parseAdjustmentRainFixedGaugeTargetProjection(bytes)
    : parseAdjustmentRevisionProjectionDocument(bytes);
}

// restrict grouped publication to one of the two exact reviewed body contracts
function parseAdjustmentRevisionGroupProjection(
  bytes: Uint8Array,
): AdjustmentRevisionGroupProjection {
  const projection = parseAdjustmentRevisionTransportDocument(bytes);
  if (projection.contractVersion !== "adjustment-revision-batch-projection/v2" &&
      projection.contractVersion !== "adjustment-rain-fixed-gauge-target-projection/v1") {
    throw new RangeError("adjustment revision group contract is invalid");
  }
  return projection;
}

// retain only single-pointer projection contracts at the single publication path
function parseAdjustmentRevisionSingleProjection(
  bytes: Uint8Array,
): AdjustmentRevisionSingleProjection {
  const projection = parseAdjustmentRevisionTransportDocument(bytes);
  if (projection.contractVersion !== "adjustment-revision-projection/v1" &&
      projection.contractVersion !== "adjustment-temperature-native-source-projection/v2") {
    throw new RangeError("adjustment revision single contract is invalid");
  }
  return projection;
}

// require every raw capture clock in the dedicated gauge body after genesis
function requireAdjustmentRevisionTransportAfterCaptureEpoch(
  witness: AdjustmentRevisionCaptureEpochWitness,
  projection: AdjustmentRevisionTransportDocument,
): void {
  if (projection.contractVersion !== "adjustment-rain-fixed-gauge-target-projection/v1") {
    requireAdjustmentRevisionProjectionAfterCaptureEpoch(witness, projection);
    return;
  }
  const clocks = [projection.validAt, projection.logicalReceivedAt,
    ...projection.captureBodies.flatMap((body) => body.claims.flatMap((claim) => [
      claim.completedAt, claim.windowStart, claim.windowEndExclusive,
    ]))];
  if (clocks.some((clock) => !adjustmentRevisionClockIsAfterCaptureEpoch(witness, clock))) {
    throw new RangeError("adjustment rain fixed-gauge target predates capture epoch");
  }
}

// expose the shadow protocol only on a separately-created internal server
export function createAdjustmentMaintenanceInternalServer(input: {
  readonly captureEpoch: AdjustmentRevisionCaptureEpochWitness;
  readonly capture?: (request: AdjustmentMaintenanceCaptureRequest) => Promise<void>;
  readonly queryable: Queryable;
  readonly relay: AdjustmentMaintenanceArchiveRelay;
}): ReturnType<typeof createServer> {
  return createServer(
    // contain all internal transport errors inside one redacted response
    async (request, response) => {
      await handleAdjustmentMaintenanceInternalRequest(input, request, response);
    },
  );
}

// create the worker-to-api client on the existing private data network
export function createHttpAdjustmentMaintenanceInternalClient(
  origin: string,
): AdjustmentMaintenanceInternalClient {
  const base = parseInternalOrigin(origin, ["api", "127.0.0.1", "localhost", "[::1]"]);
  return {
    // trigger one fixed private capture cycle without accepting candidate controls
    async capture(input) {
      await postJson<Readonly<{ accepted: true }>>(new URL(CAPTURE_PATH, base), input);
    },
    // submit only already-staged bytes for database admission and publication
    async publish(sourceProjection, body, comparator, predictionCommittedAt,
      stageReceipt, revisionReceipt) {
      return await postJson<AdjustmentMaintenancePublishReceipt>(
        new URL(PUBLISH_PATH, base),
        wireBytes(sourceProjection, body, comparator, predictionCommittedAt,
          stageReceipt, revisionReceipt),
      );
    },
    // submit one staged database projection for api-authenticated publication
    async publishRevision(projection, stageReceipt, revisionReceipt) {
      return await postJson<AdjustmentRevisionPublishReceipt>(
        new URL(REVISION_PUBLISH_PATH, base),
        {
          projectionBase64: Buffer.from(projection).toString("base64"),
          revisionReceipt,
          stageReceipt,
        },
      );
    },
    // submit one grouped body with every ordered database receipt
    async publishRevisionBatch(projection, stageReceipt, revisionReceipts) {
      return await postJson<AdjustmentRevisionBatchPublishReceipt>(
        new URL(REVISION_PUBLISH_PATH, base),
        {
          projectionBase64: Buffer.from(projection).toString("base64"),
          revisionReceipts,
          stageReceipt,
        },
      );
    },
    // relay one value-free categorical gap
    async recordGap(input) {
      await postJson<Readonly<{ recorded: true }>>(new URL(GAP_PATH, base), input);
    },
    // relay one value-free permanent database revision gap
    async recordRevisionGap(input) {
      await postJson<Readonly<{ recorded: true }>>(new URL(REVISION_GAP_PATH, base), input);
    },
    // relay one producer-authorized abandoned monthly state
    async recordRainControlStateGap(input) {
      await postJson<Readonly<{ recorded: true }>>(new URL(RAIN_CONTROL_STATE_GAP_PATH, base), input);
    },
    // retain one value-free oversized gauge hour before any body was staged
    async recordRainFixedGaugeTargetGap(input) {
      return await postJson<RainFixedGaugeTargetGapReceipt>(
        new URL(RAIN_FIXED_GAUGE_TARGET_GAP_PATH, base), input,
      );
    },
    // skip exact hours already carrying a permanent oversized disposition
    async readRainFixedGaugeTargetGap(input) {
      return await postJson<RainFixedGaugeTargetGapStatus>(
        new URL(RAIN_FIXED_GAUGE_TARGET_GAP_STATUS_PATH, base), input,
      );
    },
    // stage canonical bytes before the ingest role appends compact rain metadata
    async stage(sourceProjection, body, comparator) {
      return await postJson<AdjustmentMaintenanceStageReceipt>(
        new URL(STAGE_PATH, base),
        wireBytes(sourceProjection, body, comparator),
      );
    },
    // stage one root-selected monthly state before the worker evaluates controls
    async stageRainControlState(state) {
      return await postJson<RainMaintenanceControlStateStageReceipt>(
        new URL(RAIN_CONTROL_STATE_STAGE_PATH, base),
        { stateBase64: Buffer.from(state).toString("base64") },
      );
    },
    // stage one canonical database revision before binding its live pointer
    async stageRevision(projection) {
      return await postJson<AdjustmentRevisionStageReceipt>(
        new URL(REVISION_STAGE_PATH, base),
        { projectionBase64: Buffer.from(projection).toString("base64") },
      );
    },
  };
}

// create the api-to-web archive relay on the existing private web-api network
export function createHttpAdjustmentMaintenanceArchiveRelay(
  origin: string,
): AdjustmentMaintenanceArchiveRelay {
  const base = parseInternalOrigin(origin, ["web", "127.0.0.1", "localhost", "[::1]"]);
  return {
    // commit the exact staged receipt and compact admitted identity
    async publish(input) {
      return await postJson<AdjustmentMaintenancePublishReceipt>(
        new URL("/internal/adjustment-maintenance/archive/publish", base),
        {
          bodyBase64: Buffer.from(input.body).toString("base64"),
          ...(input.comparator === undefined
            ? {}
            : { comparatorBase64: Buffer.from(input.comparator).toString("base64") }),
          metadata: input.metadata,
          ...(input.predictionCommittedAt === undefined
            ? {}
            : { predictionCommittedAt: input.predictionCommittedAt }),
          revisionReceipt: input.revisionReceipt,
          sourceProjectionBase64: Buffer.from(input.sourceProjection).toString("base64"),
          sourceProjectionSha256: input.sourceProjectionSha256,
          stageReceipt: input.stageReceipt,
        },
      );
    },
    // publish only the two exact receipts after api database admission
    async publishRevision(input) {
      return await postJson<AdjustmentRevisionPublishReceipt>(
        new URL(REVISION_PUBLISH_PATH, base),
        input,
      );
    },
    // publish one body only after every grouped database receipt is admitted
    async publishRevisionBatch(input) {
      return await postJson<AdjustmentRevisionBatchPublishReceipt>(
        new URL(REVISION_PUBLISH_PATH, base),
        input,
      );
    },
    // preserve one categorical gap without raw values
    async recordGap(input) {
      await postJson<Readonly<{ recorded: true }>>(
        new URL("/internal/adjustment-maintenance/archive/gap", base),
        input,
      );
    },
    // persist one bounded value-free permanent revision gap
    async recordRevisionGap(input) {
      await postJson<Readonly<{ recorded: true }>>(
        new URL(REVISION_GAP_PATH, base),
        input,
      );
    },
    // persist one exact abandoned state without assigning a revision ordinal
    async recordRainControlStateGap(input) {
      await postJson<Readonly<{ recorded: true }>>(
        new URL(RAIN_CONTROL_STATE_GAP_PATH, base),
        input,
      );
    },
    // persist one oversized hour without source values or a database receipt
    async recordRainFixedGaugeTargetGap(input) {
      return await postJson<RainFixedGaugeTargetGapReceipt>(
        new URL(RAIN_FIXED_GAUGE_TARGET_GAP_PATH, base),
        input,
      );
    },
    // read one permanent pre-stage target disposition from the private store
    async readRainFixedGaugeTargetGap(input) {
      return await postJson<RainFixedGaugeTargetGapStatus>(
        new URL(RAIN_FIXED_GAUGE_TARGET_GAP_STATUS_PATH, base),
        input,
      );
    },
    // fsync raw canonical bytes before a compact database append
    async stage(input) {
      return await postJson<AdjustmentMaintenanceStageReceipt>(
        new URL("/internal/adjustment-maintenance/archive/stage", base),
        {
          bodyBase64: Buffer.from(input.body).toString("base64"),
          ...(input.comparator === undefined
            ? {}
            : { comparatorBase64: Buffer.from(input.comparator).toString("base64") }),
          metadata: input.metadata,
          sourceProjectionBase64: Buffer.from(input.sourceProjection).toString("base64"),
          sourceProjectionSha256: input.sourceProjectionSha256,
        },
      );
    },
    // relay exact canonical state bytes into the bounded archive spool
    async stageRainControlState(state) {
      return await postJson<RainMaintenanceControlStateStageReceipt>(
        new URL(RAIN_CONTROL_STATE_STAGE_PATH, base),
        { stateBase64: Buffer.from(state).toString("base64") },
      );
    },
    // fsync one closed revision projection before its database bind
    async stageRevision(projection) {
      return await postJson<AdjustmentRevisionStageReceipt>(
        new URL(REVISION_STAGE_PATH, base),
        { projectionBase64: Buffer.from(projection).toString("base64") },
      );
    },
  };
}

// map one storage row without replacing its first receipt or content digest
function projectForecastSourceRow(
  family: ApiMaintenanceShadowFamily,
  row: WeatherRecordRow,
  index: number,
  sourceSha256: string,
): Readonly<Record<string, string | number | null>> {
  const dataset = row.providerMetadata?.dataset;
  const referenceAt = row.productRunAt === null ? null : instant(row.productRunAt);
  // require the nonpublic provenance needed for a closed source projection
  if (referenceAt === null || typeof dataset !== "string" || row.adapterVersion === null ||
      row.contractEpoch === null || row.sourceConfigFingerprint === null || row.upstreamModel === null ||
      !HASH.test(row.contentHash)) {
    throw new RangeError("maintenance source provenance is incomplete");
  }
  const common = {
    adapterVersion: row.adapterVersion,
    contentSha256: row.contentHash,
    contractEpoch: row.contractEpoch,
    dataset,
    leadHours: index + 1,
    modelLeadHours: Math.ceil((Date.parse(instant(row.validAt)) - Date.parse(referenceAt)) / 3_600_000),
    providerKey: row.providerKey,
    receivedAt: instant(row.firstReceivedAt),
    referenceAt,
    revisionCount: row.revisionCount,
    sourceConfigFingerprint: row.sourceConfigFingerprint,
    sourceKey: row.sourceKey,
    sourceSha256,
    upstreamModel: row.upstreamModel,
    validAt: instant(row.validAt),
  };
  // select only the raw metrics used by the candidate family
  if (family === "temperature") {
    return {
      ...common,
      temperatureC64: nullableBinary64(row.temperatureC),
    };
  }
  return {
    ...common,
    windGustMps64: nullableBinary64(row.windGustMps),
    windSpeedMps64: nullableBinary64(row.windSpeedMps),
  };
}

// bind candidate rows to exact ordered source row identities
function createForecastMaintenanceBody(
  sourceBytes: Uint8Array,
  candidateRows: readonly TemperatureMaintenanceCandidateRow[] | readonly WindMaintenanceCandidateRow[],
): Buffer {
  const source = parseMaintenanceShadowSourceProjection(sourceBytes);
  const identity = createMaintenanceShadowSourceIdentity(sourceBytes);
  // require one candidate result for every causal source row
  if (candidateRows.length !== source.rowCount) {
    throw new RangeError("maintenance candidate row count differs");
  }
  const rows = candidateRows.map(
    // preserve source clocks and hashes rather than trusting candidate geometry
    (candidate, index) => {
      const raw = source.rows[index]!;
      // reject reordering or target substitution by the candidate evaluator
      if (candidate.validAt !== raw.validAt) {
        throw new RangeError("maintenance candidate geometry differs");
      }
      const common = {
        leadHours: index + 1,
        sourceRowSha256: identity.sourceRowSha256[index]!,
        validAt: raw.validAt,
      };
      // retain temperature fallback classification explicitly
      if (source.family === "temperature" && "candidateTemperatureC" in candidate) {
        return {
          ...common,
          candidateTemperatureC64: encodeMaintenanceBinary64(candidate.candidateTemperatureC),
          fallbackCode: candidate.fallbackCode,
          wouldApply: candidate.wouldApply,
        };
      }
      // require wind output only for a wind source projection
      if (source.family !== "wind" || !("candidateSpeedMps" in candidate)) {
        throw new RangeError("maintenance candidate family differs");
      }
      return {
        ...common,
        candidateGustMps64: candidate.candidateGustMps === null
          ? null
          : encodeMaintenanceBinary64(candidate.candidateGustMps),
        candidateSpeedMps64: encodeMaintenanceBinary64(candidate.candidateSpeedMps),
        gustWouldApply: candidate.gustWouldApply,
        speedWouldApply: candidate.speedWouldApply,
      };
    },
  );
  const body: MaintenanceShadowValues = {
    candidateSha256: source.candidateSha256,
    contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION,
    dueKey: source.dueKey,
    family: source.family,
    inputSha256: identity.inputSha256,
    issuedAt: source.issuedAt,
    registrationSha256: source.registrationSha256,
    rowCount: rows.length,
    rows,
    sourceReceiptSha256: identity.sourceReceiptSha256,
    sourceSha256: source.sourceSha256,
  };
  return encodeMaintenanceShadowValues(body, sourceBytes);
}

// build one canonical incumbent member from the immutable startup runtime snapshot
function createApiMaintenanceComparator(
  sourceBytes: Uint8Array,
  bodyBytes: Uint8Array,
  runtime: LoadedForecastAdjustmentTemperatureCanaryRuntime |
    LoadedForecastAdjustmentRuntimeV1 | LoadedForecastAdjustmentWindCanaryRuntime,
): Buffer {
  const source = parseMaintenanceShadowSourceProjection(sourceBytes);
  const body = parseMaintenanceShadowValues(bodyBytes);
  const identity = createMaintenanceShadowSourceIdentity(sourceBytes);
  const authority = "comparatorAuthority" in runtime
    ? runtime.comparatorAuthority as MaintenanceShadowServingAuthority | undefined
    : undefined;
  // refuse invalid, killed and inactive states without inventing serving authority
  if (authority === undefined || source.family === "rain") {
    throw new RangeError("maintenance incumbent authority is unavailable");
  }
  const rows = source.family === "temperature"
    ? evaluateTemperatureMaintenanceIncumbent(
      runtime as LoadedForecastAdjustmentTemperatureCanaryRuntime, source,
    ).map(
      // bind the exact temperature serving result to one source row
      (row, index) => ({
        validAt: row.validAt,
        leadHours: index + 1,
        sourceRowSha256: identity.sourceRowSha256[index]!,
        incumbentTemperatureC64: encodeMaintenanceBinary64(row.incumbentTemperatureC),
        applied: row.applied,
        reasonCode: row.reasonCode,
      }),
    )
    : evaluateWindMaintenanceIncumbent(
      runtime as LoadedForecastAdjustmentRuntimeV1 | LoadedForecastAdjustmentWindCanaryRuntime, source,
    ).map(
      // bind metric-level serving decisions to one source row
      (row, index) => ({
        validAt: row.validAt,
        leadHours: index + 1,
        sourceRowSha256: identity.sourceRowSha256[index]!,
        incumbentSpeedMps64: encodeMaintenanceBinary64(row.incumbentSpeedMps),
        incumbentGustMps64: row.incumbentGustMps === null
          ? null
          : encodeMaintenanceBinary64(row.incumbentGustMps),
        speedApplied: row.speedApplied,
        gustApplied: row.gustApplied,
        reasonCode: row.reasonCode,
      }),
    );
  const comparator: MaintenanceShadowComparator = {
    contractVersion: MAINTENANCE_SHADOW_COMPARATOR_VERSION,
    family: source.family,
    registrationSha256: source.registrationSha256,
    candidateSha256: source.candidateSha256,
    sourceSha256: source.sourceSha256,
    dueKey: source.dueKey,
    issuedAt: source.issuedAt,
    sourceProjectionSha256: sha256(sourceBytes),
    predictionBodySha256: sha256(bodyBytes),
    servingAuthority: authority,
    rowCount: rows.length,
    rows,
  };
  // ensure the separately parsed body identity is the one embedded above
  if (body.inputSha256 !== identity.inputSha256) {
    throw new RangeError("maintenance comparator body source differs");
  }
  return encodeMaintenanceShadowComparator(comparator, sourceBytes, bodyBytes);
}

// map a bounded public reason into the frozen evidence fallback vocabulary
function temperatureFallbackCode(
  reason: unknown,
): TemperatureMaintenanceCandidateRow["fallbackCode"] {
  // distinguish absent live inputs from numerical or policy ineligibility
  if (["missing_source_forecast", "source_not_available", "source_stale", "source_time_mismatch"]
    .includes(String(reason))) {
    return "missing_source";
  }
  // retain explicit physical-domain refusal separately
  if (["raw_value_invalid", "outside_operational_window"].includes(String(reason))) {
    return "physical_cap";
  }
  return reason === "unsupported" ? "model_unavailable" : "ineligible";
}

// construct the complete canonical metric record without inventing unused values
function windMetrics(windSpeedMps: number, windGustMps: number | null) {
  return {
    apparentTemperatureC: null,
    blackGlobeTemperatureC: null,
    cloudCoverPercent: null,
    pm25MicrogramsPerCubicMeter: null,
    precipitationMm: null,
    precipitationRateMmPerHour: null,
    pressureHpa: null,
    relativeHumidityPercent: null,
    soilElectricalConductivityMicrosiemensPerCm: null,
    soilMoisturePercent: null,
    solarRadiationWm2: null,
    temperatureC: null,
    uvIndex: null,
    waterLevelM: null,
    wetBulbGlobeTemperatureC: null,
    windDirectionDegrees: null,
    windGustMps,
    windSpeedMps,
  };
}

// decode one explicit nullable binary64 source value
function nullableDecoded(value: unknown): number | null {
  return value === null ? null : decodeMaintenanceBinary64(value);
}

// route one exact private request without public query or header controls
async function handleAdjustmentMaintenanceInternalRequest(
  input: Readonly<{
    captureEpoch: AdjustmentRevisionCaptureEpochWitness;
    capture?: (request: AdjustmentMaintenanceCaptureRequest) => Promise<void>;
    queryable: Queryable;
    relay: AdjustmentMaintenanceArchiveRelay;
  }>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const readsSchedule = request.method === "GET" && request.url === SCHEDULE_SLOTS_PATH;
    // refuse every method and path outside the fixed internal operations
    if (!readsSchedule && (request.method !== "POST" ||
        (request.url !== STAGE_PATH && request.url !== PUBLISH_PATH && request.url !== GAP_PATH &&
          request.url !== CAPTURE_PATH && request.url !== REVISION_STAGE_PATH &&
          request.url !== REVISION_PUBLISH_PATH && request.url !== REVISION_GAP_PATH &&
          request.url !== RAIN_CONTROL_STATE_STAGE_PATH &&
          request.url !== RAIN_CONTROL_STATE_GAP_PATH &&
          request.url !== RAIN_FIXED_GAUGE_TARGET_GAP_PATH &&
          request.url !== RAIN_FIXED_GAUGE_TARGET_GAP_STATUS_PATH))) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    // expose only the three server-validated value-free schedule projections
    if (readsSchedule) {
      const slots: readonly AdjustmentShadowRegistrationSlot[] = await Promise.all([
        readAdjustmentShadowRegistrationSlot(input.queryable, "temperature"),
        readAdjustmentShadowRegistrationSlot(input.queryable, "wind"),
        readAdjustmentShadowRegistrationSlot(input.queryable, "rain"),
      ]);
      writeJson(response, 200, slots);
      return;
    }
    const value = await readJson(request);
    // accept only the scheduler clock on the capture trigger
    if (request.url === CAPTURE_PATH) {
      if (input.capture === undefined) {
        throw new RangeError("adjustment capture is inactive");
      }
      const capture = validateCaptureRequest(value);
      // refuse scheduler requests from before the authenticated epoch
      if (!adjustmentRevisionClockIsAfterCaptureEpoch(input.captureEpoch, capture.issuedAt)) {
        throw new RangeError("adjustment capture request predates epoch");
      }
      await input.capture(capture);
      writeJson(response, 202, { accepted: true });
      return;
    }
    // relay only a closed value-free gap document
    if (request.url === GAP_PATH) {
      const gap = validateGap(value);
      await input.relay.recordGap(gap);
      writeJson(response, 200, { recorded: true });
      return;
    }
    // relay one closed permanent revision gap without raw values
    if (request.url === REVISION_GAP_PATH) {
      const gap = validateAdjustmentRevisionGap(value);
      await input.relay.recordRevisionGap(gap);
      writeJson(response, 200, { recorded: true });
      return;
    }
    // stage one canonical projection before the worker binds its database pointer
    if (request.url === REVISION_STAGE_PATH) {
      requireExactKeys(value, ["projectionBase64"]);
      const projection = strictBase64((value as Record<string, unknown>).projectionBase64);
      requireAdjustmentRevisionTransportAfterCaptureEpoch(
        input.captureEpoch,
        parseAdjustmentRevisionTransportDocument(projection),
      );
      const receipt = await stageAdjustmentRevision(input.relay, projection);
      writeJson(response, 200, receipt);
      return;
    }
    // stage only a canonical future-only monthly rain control state
    if (request.url === RAIN_CONTROL_STATE_STAGE_PATH) {
      requireExactKeys(value, ["stateBase64"]);
      const stateBytes = strictBase64((value as Record<string, unknown>).stateBase64);
      const state = parseRainMaintenanceControlState(stateBytes);
      if (state.epochWitnessSha256 !== input.captureEpoch.witnessSha256 ||
          !adjustmentRevisionClockIsAfterCaptureEpoch(
            input.captureEpoch,
            state.trainingMaximumValidAt,
          ) ||
          !adjustmentRevisionClockIsAfterCaptureEpoch(input.captureEpoch, state.generatedAt)) {
        throw new RangeError("rain control state predates epoch");
      }
      const receipt = await input.relay.stageRainControlState(stateBytes);
      writeJson(response, 200, receipt);
      return;
    }
    // abandon only one exact state that failed before a projection was retained
    if (request.url === RAIN_CONTROL_STATE_GAP_PATH) {
      requireExactKeys(value, ["reason", "stateSha256", "stageReceiptSha256"]);
      const gap = value as unknown as RainMaintenanceControlStateGapInput;
      if (gap.reason !== "projection_stage_failed" || !HASH.test(gap.stateSha256) ||
          !HASH.test(gap.stageReceiptSha256)) {
        throw new RangeError("rain control state gap differs");
      }
      await input.relay.recordRainControlStateGap(gap);
      writeJson(response, 200, { recorded: true });
      return;
    }
    // persist one pre-stage oversized target hour without values or an ordinal
    if (request.url === RAIN_FIXED_GAUGE_TARGET_GAP_PATH) {
      const gap = validateRainFixedGaugeTargetGapInput(value);
      const receipt = await input.relay.recordRainFixedGaugeTargetGap(gap);
      validateRainFixedGaugeTargetGapReceipt(receipt, gap);
      writeJson(response, 200, receipt);
      return;
    }
    // read only the permanent disposition for one exact target hour identity
    if (request.url === RAIN_FIXED_GAUGE_TARGET_GAP_STATUS_PATH) {
      const key = validateRainFixedGaugeTargetGapStatusInput(value);
      const status = await input.relay.readRainFixedGaugeTargetGap(key);
      validateRainFixedGaugeTargetGapStatus(status, key);
      writeJson(response, 200, status);
      return;
    }
    // publish only after authenticating the exact persisted current pointer
    if (request.url === REVISION_PUBLISH_PATH) {
      const record = value as Record<string, unknown>;
      const projection = strictBase64(record.projectionBase64);
      const parsedProjection = parseAdjustmentRevisionTransportDocument(projection);
      requireAdjustmentRevisionTransportAfterCaptureEpoch(input.captureEpoch, parsedProjection);
      // dispatch only the exact receipt grammar belonging to the parsed contract
      if (parsedProjection.contractVersion === "adjustment-revision-batch-projection/v2" ||
          parsedProjection.contractVersion ===
            "adjustment-rain-fixed-gauge-target-projection/v1") {
        requireExactKeys(value, ["projectionBase64", "revisionReceipts", "stageReceipt"]);
        const suppliedRevisions = record.revisionReceipts as readonly AdjustmentRevisionCommitReceipt[];
        // require every server-assigned grouped commit clock after the epoch
        if (!Array.isArray(suppliedRevisions) || suppliedRevisions.some((receipt) =>
          !adjustmentRevisionClockIsAfterCaptureEpoch(input.captureEpoch, receipt.archiveCommittedAt))) {
          throw new RangeError("adjustment revision receipt predates epoch");
        }
        const receipt = await publishAdmittedAdjustmentRevisionBatch(
          input.queryable,
          input.relay,
          projection,
          record.stageReceipt as AdjustmentRevisionStageReceipt,
          suppliedRevisions,
        );
        writeJson(response, 200, receipt);
        return;
      }
      requireExactKeys(value, ["projectionBase64", "revisionReceipt", "stageReceipt"]);
      const suppliedRevision = record.revisionReceipt as AdjustmentRevisionCommitReceipt;
      // require the database's server-assigned commit clock after the epoch
      if (!adjustmentRevisionClockIsAfterCaptureEpoch(input.captureEpoch, suppliedRevision.archiveCommittedAt)) {
        throw new RangeError("adjustment revision receipt predates epoch");
      }
      const receipt = await publishAdmittedAdjustmentRevision(
        input.queryable,
        input.relay,
        projection,
        record.stageReceipt as AdjustmentRevisionStageReceipt,
        suppliedRevision,
      );
      writeJson(response, 200, receipt);
      return;
    }
    const decoded = decodeWireBytes(value, request.url === PUBLISH_PATH);
    const source = parseMaintenanceShadowSourceProjection(decoded.sourceProjection);
    requireMaintenanceShadowSourceAfterCaptureEpoch(input.captureEpoch, source);
    // require the database's server-assigned shadow commit clock after the epoch
    if (decoded.revisionReceipt !== undefined &&
        !adjustmentRevisionClockIsAfterCaptureEpoch(
          input.captureEpoch,
          decoded.revisionReceipt.archiveCommittedAt,
        )) {
      throw new RangeError("adjustment shadow receipt predates epoch");
    }
    const receipt = request.url === STAGE_PATH
      ? await stageAdjustmentMaintenanceShadow(
        input.relay, decoded.sourceProjection, decoded.body, decoded.comparator,
      )
      : await publishAdmittedAdjustmentMaintenanceShadow(
        input.queryable,
        input.relay,
        decoded.sourceProjection,
        decoded.body,
        decoded.comparator,
        decoded.predictionCommittedAt,
        decoded.stageReceipt!,
        decoded.revisionReceipt!,
      );
    writeJson(response, 200, receipt);
  } catch (error) {
    // preserve only bounded spool capacity across the private api hop
    if (isAdjustmentRevisionSpoolRefusal(error)) {
      writeJson(response, 429, { error: "revision_spool_full" });
      return;
    }
    writeJson(response, 409, { error: "shadow_rejected" });
  }
}

// validate one frozen value-free revision gap document
function validateAdjustmentRevisionGap(value: unknown): AdjustmentRevisionGapInput {
  requireExactKeys(value, ["logicalKeySha256", "projectionIdentitySha256", "projectionKind",
    "projectionSha256", "reason"]);
  const gap = value as unknown as AdjustmentRevisionGapInput;
  // reject unbounded labels and noncanonical projection identities
  if (!HASH.test(gap.logicalKeySha256) ||
      (gap.projectionIdentitySha256 !== null && !HASH.test(gap.projectionIdentitySha256)) ||
      (gap.projectionSha256 !== null && !HASH.test(gap.projectionSha256)) ||
      !["actual_best_match", "native_source", "rain_gate_input", "target_revision"]
        .includes(gap.projectionKind) ||
      !["archive_stage_failed", "database_bind_failed", "database_admission_failed",
        "archive_publish_failed"].includes(gap.reason) ||
      ((gap.projectionSha256 === null) !== (gap.projectionIdentitySha256 === null)) ||
      (gap.projectionSha256 !== null && gap.projectionSha256 !== gap.projectionIdentitySha256)) {
    throw new RangeError("adjustment revision gap differs");
  }
  return gap;
}

// validate one value-free oversized fixed-gauge target disposition
function validateRainFixedGaugeTargetGapInput(value: unknown): RainFixedGaugeTargetGapInput {
  requireExactKeys(value, ["logicalHourAt", "logicalKeySha256", "reason"]);
  const gap = value as unknown as RainFixedGaugeTargetGapInput;
  if (!validClosedHour(gap.logicalHourAt) || !HASH.test(gap.logicalKeySha256) ||
      gap.reason !== "target_source_oversized") {
    throw new RangeError("rain fixed-gauge target gap differs");
  }
  return gap;
}

// validate one exact value-free gap lookup key
function validateRainFixedGaugeTargetGapStatusInput(
  value: unknown,
): RainFixedGaugeTargetGapStatusInput {
  requireExactKeys(value, ["logicalHourAt", "logicalKeySha256"]);
  const key = value as unknown as RainFixedGaugeTargetGapStatusInput;
  if (!validClosedHour(key.logicalHourAt) || !HASH.test(key.logicalKeySha256)) {
    throw new RangeError("rain fixed-gauge target gap key differs");
  }
  return key;
}

// reject relay status for another target hour or a mutated durable gap
function validateRainFixedGaugeTargetGapStatus(
  value: RainFixedGaugeTargetGapStatus,
  key: RainFixedGaugeTargetGapStatusInput,
): void {
  if (value.contractVersion !== "adjustment-rain-fixed-gauge-target-gap-status/v1" ||
      (value.state !== "absent" && value.state !== "present")) {
    throw new RangeError("rain fixed-gauge target gap status differs");
  }
  if (value.state === "present") {
    validateRainFixedGaugeTargetGapReceipt(value.gap, {
      ...key,
      reason: "target_source_oversized",
    });
  }
}

// recompute one durable value-free gap identity before trusting its status
function validateRainFixedGaugeTargetGapReceipt(
  value: RainFixedGaugeTargetGapReceipt,
  input: RainFixedGaugeTargetGapInput,
): void {
  requireExactKeys(value, ["contractVersion", "gapAt", "gapSha256", "logicalHourAt",
    "logicalKeySha256", "qualificationDisposition", "reason"]);
  const unsigned = {
    contractVersion: value.contractVersion,
    gapAt: value.gapAt,
    logicalHourAt: value.logicalHourAt,
    logicalKeySha256: value.logicalKeySha256,
    qualificationDisposition: value.qualificationDisposition,
    reason: value.reason,
  };
  if (value.contractVersion !== "adjustment-rain-fixed-gauge-target-gap/v1" ||
      !validInstant(value.gapAt) || value.logicalHourAt !== input.logicalHourAt ||
      value.logicalKeySha256 !== input.logicalKeySha256 || value.reason !== input.reason ||
      value.qualificationDisposition !== "forever_unqualified" ||
      value.gapSha256 !== sha256(Buffer.from(`${JSON.stringify(unsigned)}\n`))) {
    throw new RangeError("rain fixed-gauge target gap receipt differs");
  }
}

// accept only exact UTC hour boundaries
function validClosedHour(value: unknown): value is string {
  return typeof value === "string" && validInstant(value) && Date.parse(value) % 3_600_000 === 0;
}

// validate one fixed scheduler capture request without model or source selectors
function validateCaptureRequest(value: unknown): AdjustmentMaintenanceCaptureRequest {
  requireExactKeys(value, ["dueKey", "issuedAt"]);
  const capture = value as unknown as AdjustmentMaintenanceCaptureRequest;
  // require the exact due clock as the immutable issue clock
  if (!/^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(capture.dueKey) ||
      !validInstant(capture.issuedAt) || capture.dueKey.slice(8) !== capture.issuedAt) {
    throw new RangeError("adjustment capture request differs");
  }
  return capture;
}

// validate one bounded categorical gap without value fields
function validateGap(value: unknown): AdjustmentMaintenanceGapInput {
  requireExactKeys(value, ["dueKey", "family", "reason", "registrationSha256"]);
  const gap = value as unknown as AdjustmentMaintenanceGapInput;
  // restrict the relay to the frozen families, reasons and scheduler keys
  if (!HASH.test(gap.registrationSha256) ||
      !/^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(gap.dueKey) ||
      !["temperature", "wind", "rain"].includes(gap.family) ||
      !["candidate_unavailable", "comparator_unavailable", "source_incomplete", "archive_stage_failed", "database_append_failed",
        "database_admission_failed", "archive_publish_failed"].includes(gap.reason)) {
    throw new RangeError("adjustment shadow gap differs");
  }
  return gap;
}

// decode one exact base64 transport envelope
function decodeWireBytes(
  value: unknown,
  requireReceipt: boolean,
): Readonly<{
  body: Buffer;
  comparator?: Buffer;
  sourceProjection: Buffer;
  revisionReceipt?: AdjustmentRevisionCommitReceipt;
  predictionCommittedAt?: string;
  stageReceipt?: AdjustmentMaintenanceStageReceipt;
}> {
  const record = value as Record<string, unknown>;
  const hasComparator = typeof record?.comparatorBase64 === "string";
  const expected = requireReceipt
    ? hasComparator
      ? ["bodyBase64", "comparatorBase64", "predictionCommittedAt", "revisionReceipt", "sourceProjectionBase64", "stageReceipt"]
      : ["bodyBase64", "revisionReceipt", "sourceProjectionBase64", "stageReceipt"]
    : hasComparator
      ? ["bodyBase64", "comparatorBase64", "sourceProjectionBase64"]
      : ["bodyBase64", "sourceProjectionBase64"];
  requireExactKeys(value, expected);
  const body = strictBase64(record.bodyBase64);
  const comparator = hasComparator ? strictBase64(record.comparatorBase64) : undefined;
  const sourceProjection = strictBase64(record.sourceProjectionBase64);
  parseMaintenanceShadowSourceProjection(sourceProjection);
  parseMaintenanceShadowValues(body);
  // parse and cross-bind only the additive comparator transport
  if (comparator !== undefined) {
    validateMaintenanceShadowComparatorBinding(
      parseMaintenanceShadowComparator(comparator), sourceProjection, body,
    );
  }
  // include the receipt only for the publication operation
  if (requireReceipt) {
    return {
      body,
      ...(comparator === undefined ? {} : { comparator }),
      ...(comparator === undefined
        ? {}
        : { predictionCommittedAt: String(record.predictionCommittedAt) }),
      revisionReceipt: record.revisionReceipt as AdjustmentRevisionCommitReceipt,
      sourceProjection,
      stageReceipt: record.stageReceipt as AdjustmentMaintenanceStageReceipt,
    };
  }
  return { body, ...(comparator === undefined ? {} : { comparator }), sourceProjection };
}

// serialize exact source and body bytes for the internal api
function wireBytes(
  sourceProjection: Uint8Array,
  body: Uint8Array,
  comparator?: Uint8Array,
  predictionCommittedAt?: string,
  stageReceipt?: AdjustmentMaintenanceStageReceipt,
  revisionReceipt?: AdjustmentRevisionCommitReceipt,
): Record<string, unknown> {
  // keep the two database/archive receipts paired on publication
  if ((stageReceipt === undefined) !== (revisionReceipt === undefined)) {
    throw new RangeError("adjustment publication receipts are incomplete");
  }
  // pair the DB compact clock only with an additive comparator publication
  if (stageReceipt !== undefined &&
      ((comparator === undefined) !== (predictionCommittedAt === undefined))) {
    throw new RangeError("adjustment publication compact clock differs");
  }
  return {
    bodyBase64: Buffer.from(body).toString("base64"),
    ...(comparator === undefined ? {} : { comparatorBase64: Buffer.from(comparator).toString("base64") }),
    ...(predictionCommittedAt === undefined ? {} : { predictionCommittedAt }),
    sourceProjectionBase64: Buffer.from(sourceProjection).toString("base64"),
    ...(stageReceipt === undefined ? {} : { stageReceipt }),
    ...(revisionReceipt === undefined ? {} : { revisionReceipt }),
  };
}

// report a best-effort categorical gap without blocking served forecasts
async function reportGap<F extends ApiMaintenanceShadowFamily>(
  input: CaptureApiMaintenanceGapContext<F>,
  reason: MaintenanceShadowGapReason,
): Promise<CaptureApiMaintenanceShadowResult> {
  try {
    await input.relay.recordGap({
      dueKey: input.dueKey,
      family: input.candidate.registration.family,
      reason,
      registrationSha256: input.candidate.registration.registrationSha256,
    });
  } catch {
    // preserve serving when the evidence archive is unavailable
  }
  return { reason, status: "gap" };
}

// validate the installer-authenticated immutable deployment identity
function validateInstalledCandidate<F extends ApiMaintenanceShadowFamily>(
  candidate: InstalledMaintenanceShadowCandidate<F>,
): void {
  const registration = candidate.registration;
  const receipt = candidate.receipt;
  // require the exact root-installed receipt and independently loaded graph identities
  if (candidate.family !== registration.family || receipt.contractVersion !== "adjustment-installed-candidate-receipt/v1" ||
      receipt.registrationSha256 !== registration.registrationSha256 ||
      receipt.candidateSha256 !== registration.candidateSha256 ||
      receipt.bundleSha256 !== registration.artifactSha256 || receipt.sourceSha256 !== registration.sourceSha256 ||
      candidate.action.candidateGraphSha256 !== receipt.candidateGraphSha256 ||
      candidate.action.candidateSha256 !== receipt.candidateSha256 ||
      candidate.bundle.bundleSha256 !== receipt.bundleSha256 || !HASH.test(candidate.catalogSha256)) {
    throw new RangeError("installed adjustment candidate differs");
  }
}

// require a durable receipt for the exact staged byte identities
function validateStageReceipt(
  receipt: AdjustmentMaintenanceStageReceipt,
  metadata: MaintenanceShadowPredictionMetadata,
  sourceProjectionSha256: string,
  comparator?: Uint8Array,
): void {
  const comparatorSha256 = comparator === undefined ? undefined : sha256(comparator);
  const expectedKeys = comparatorSha256 === undefined
    ? ["contractVersion", "durable", "durableAt", "dueKey", "predictionBodySha256",
      "registrationSha256", "sourceProjectionSha256", "stageReceiptSha256"]
    : ["contractVersion", "durable", "durableAt", "dueKey", "predictionBodySha256",
      "registrationSha256", "sourceProjectionSha256", "comparatorSha256", "stageReceiptSha256"];
  requireExactKeys(receipt, expectedKeys);
  const unsigned = {
    contractVersion: receipt.contractVersion,
    durable: receipt.durable,
    durableAt: receipt.durableAt,
    dueKey: receipt.dueKey,
    predictionBodySha256: receipt.predictionBodySha256,
    registrationSha256: receipt.registrationSha256,
    sourceProjectionSha256: receipt.sourceProjectionSha256,
    ...(comparatorSha256 === undefined ? {} : { comparatorSha256: receipt.comparatorSha256 }),
  };
  // refuse acknowledgements that do not bind exact durable bytes
  if (receipt.contractVersion !== (comparatorSha256 === undefined
        ? "adjustment-shadow-stage-receipt/v1"
        : "adjustment-shadow-stage-receipt/v2") || receipt.durable !== true ||
      !validInstant(receipt.durableAt) || !HASH.test(receipt.stageReceiptSha256) ||
      Date.parse(receipt.durableAt) < Date.parse(metadata.issuedAt) ||
      receipt.dueKey !== metadata.dueKey || receipt.registrationSha256 !== metadata.registrationSha256 ||
      receipt.predictionBodySha256 !== metadata.predictionBodySha256 ||
      receipt.sourceProjectionSha256 !== sourceProjectionSha256 ||
      receipt.comparatorSha256 !== comparatorSha256 ||
      receipt.stageReceiptSha256 !== sha256(Buffer.from(JSON.stringify(unsigned) + "\n"))) {
    throw new RangeError("adjustment stage receipt differs");
  }
}

// bind one server-assigned immutable revision to the staged native source
function validateRevisionReceipt(
  receipt: AdjustmentRevisionCommitReceipt,
  metadata: MaintenanceShadowPredictionMetadata,
  stageReceiptSha256: string,
): void {
  requireExactKeys(receipt, REVISION_RECEIPT_KEYS);
  // reject a revision from another source projection or archive stage
  if (receipt.contractVersion !== "adjustment-revision-commit-receipt/v1" ||
      receipt.projectionKind !== "shadow_prediction" ||
      !/^[1-9][0-9]*$/u.test(receipt.archiveCommitOrdinal) ||
      !validInstant(receipt.archiveCommittedAt) ||
      receipt.projectionIdentitySha256 !== metadata.sourceReceiptSha256 ||
      receipt.projectionSha256 !== metadata.inputSha256 ||
      receipt.stageReceiptSha256 !== stageReceiptSha256 ||
      !HASH.test(receipt.frontierSha256) || !HASH.test(receipt.predecessorFrontierSha256) ||
      !HASH.test(receipt.receiptSha256)) {
    throw new RangeError("adjustment revision receipt differs");
  }
}

// require publication to bind the exact admitted compact identity
function validatePublishReceipt(
  receipt: AdjustmentMaintenancePublishReceipt,
  metadata: MaintenanceShadowPredictionMetadata,
  comparator?: Uint8Array,
): void {
  const comparatorSha256 = comparator === undefined ? undefined : sha256(comparator);
  requireExactKeys(receipt, comparatorSha256 === undefined
    ? ["committed", "committedAt", "contractVersion", "predictionSha256", "publishReceiptSha256"]
    : ["committed", "committedAt", "contractVersion", "predictionSha256", "comparatorSha256",
      "publishReceiptSha256"]);
  const unsigned = {
    committed: receipt.committed,
    committedAt: receipt.committedAt,
    contractVersion: receipt.contractVersion,
    predictionSha256: receipt.predictionSha256,
    ...(comparatorSha256 === undefined ? {} : { comparatorSha256: receipt.comparatorSha256 }),
  };
  // reject an archive response for another compact prediction
  if (receipt.contractVersion !== (comparatorSha256 === undefined
        ? "adjustment-shadow-publish-receipt/v1"
        : "adjustment-shadow-publish-receipt/v2") || receipt.committed !== true ||
      !validInstant(receipt.committedAt) || !HASH.test(receipt.publishReceiptSha256) ||
      Date.parse(receipt.committedAt) < Date.parse(metadata.issuedAt) ||
      receipt.predictionSha256 !== metadata.predictionSha256 ||
      receipt.comparatorSha256 !== comparatorSha256 ||
      receipt.publishReceiptSha256 !== sha256(Buffer.from(JSON.stringify(unsigned) + "\n"))) {
    throw new RangeError("adjustment publish receipt differs");
  }
}

// require a durable stage receipt for the exact canonical projection bytes
function validateAdjustmentRevisionStageReceipt(
  receipt: AdjustmentRevisionStageReceipt,
  projection: AdjustmentRevisionTransportDocument,
  identity: string,
): void {
  requireExactKeys(receipt, ["contractVersion", "durable", "durableAt", "projectionIdentitySha256",
    "projectionKind", "projectionSha256", "stageReceiptSha256"]);
  const unsigned = {
    contractVersion: receipt.contractVersion,
    durable: receipt.durable,
    durableAt: receipt.durableAt,
    projectionIdentitySha256: receipt.projectionIdentitySha256,
    projectionKind: receipt.projectionKind,
    projectionSha256: receipt.projectionSha256,
  };
  // bind both body identities and the stable fsync receipt preimage
  if (receipt.contractVersion !== "adjustment-revision-stage-receipt/v1" || receipt.durable !== true ||
      !validInstant(receipt.durableAt) || receipt.projectionKind !== projection.projectionKind ||
      receipt.projectionIdentitySha256 !== identity || receipt.projectionSha256 !== identity ||
      receipt.stageReceiptSha256 !== sha256(Buffer.from(JSON.stringify(unsigned) + "\n"))) {
    throw new RangeError("adjustment revision stage receipt differs");
  }
}

// validate every grouped database receipt and its global-frontier continuity
function validateAdjustmentDatabaseRevisionReceiptBatch(
  receipts: readonly AdjustmentRevisionCommitReceipt[],
  projection: AdjustmentRevisionGroupProjection,
  stageReceipt: AdjustmentRevisionStageReceipt,
): void {
  // require one exact body-bound receipt for every canonical row
  if (receipts.length !== projection.rows.length) {
    throw new RangeError("adjustment database revision receipt batch differs");
  }
  for (const [index, receipt] of receipts.entries()) {
    validateAdjustmentDatabaseRevisionReceipt(receipt, projection, stageReceipt);
    const previous = receipts[index - 1];
    // preserve the database's exact global-frontier order inside the body group
    if (previous !== undefined &&
        (BigInt(receipt.archiveCommitOrdinal) !== BigInt(previous.archiveCommitOrdinal) + 1n ||
          receipt.predecessorFrontierSha256 !== previous.frontierSha256)) {
      throw new RangeError("adjustment database revision receipt batch is discontinuous");
    }
  }
}

// bind one server-assigned revision receipt to the exact durable stage
function validateAdjustmentDatabaseRevisionReceipt(
  receipt: AdjustmentRevisionCommitReceipt,
  projection: AdjustmentRevisionTransportDocument,
  stageReceipt: AdjustmentRevisionStageReceipt,
): void {
  requireExactKeys(receipt, REVISION_RECEIPT_KEYS);
  // accept only the database receipt for this body, stage and projection class
  if (receipt.contractVersion !== "adjustment-revision-commit-receipt/v1" ||
      !/^[1-9][0-9]*$/u.test(receipt.archiveCommitOrdinal) ||
      !validInstant(receipt.archiveCommittedAt) || receipt.projectionKind !== projection.projectionKind ||
      receipt.projectionIdentitySha256 !== stageReceipt.projectionIdentitySha256 ||
      receipt.projectionSha256 !== stageReceipt.projectionSha256 ||
      receipt.stageReceiptSha256 !== stageReceipt.stageReceiptSha256 ||
      !HASH.test(receipt.frontierSha256) || !HASH.test(receipt.predecessorFrontierSha256) ||
      !HASH.test(receipt.receiptSha256)) {
    throw new RangeError("adjustment database revision receipt differs");
  }
}

// require one checkpoint binding every ordered grouped database receipt
function validateAdjustmentRevisionBatchPublishReceipt(
  receipt: AdjustmentRevisionBatchPublishReceipt,
  projection: AdjustmentRevisionGroupProjection,
  revisionReceipts: readonly AdjustmentRevisionCommitReceipt[],
): void {
  requireExactKeys(receipt, ["committed", "committedAt", "contractVersion", "projectionIdentitySha256",
    "projectionKind", "projectionSha256", "publishReceiptSha256", "revisionReceiptSha256s"]);
  const unsigned = {
    committed: receipt.committed,
    committedAt: receipt.committedAt,
    contractVersion: receipt.contractVersion,
    projectionIdentitySha256: receipt.projectionIdentitySha256,
    projectionKind: receipt.projectionKind,
    projectionSha256: receipt.projectionSha256,
    revisionReceiptSha256s: receipt.revisionReceiptSha256s,
  };
  const expectedReceiptSha256s = revisionReceipts.map(
    // preserve the ordered server receipt identity vector
    (revisionReceipt) => revisionReceipt.receiptSha256,
  );
  // cross-bind the grouped checkpoint to its body and every admitted receipt
  if (receipt.contractVersion !== "adjustment-revision-batch-publish-receipt/v2" ||
      receipt.committed !== true || !validInstant(receipt.committedAt) ||
      receipt.projectionKind !== projection.projectionKind ||
      receipt.projectionIdentitySha256 !== revisionReceipts[0]?.projectionIdentitySha256 ||
      receipt.projectionSha256 !== revisionReceipts[0]?.projectionSha256 ||
      JSON.stringify(receipt.revisionReceiptSha256s) !== JSON.stringify(expectedReceiptSha256s) ||
      receipt.publishReceiptSha256 !== sha256(Buffer.from(JSON.stringify(unsigned) + "\n"))) {
    throw new RangeError("adjustment revision batch publish receipt differs");
  }
}

// require one stable publish checkpoint for the admitted database receipt
function validateAdjustmentRevisionPublishReceipt(
  receipt: AdjustmentRevisionPublishReceipt,
  projection: AdjustmentRevisionSingleProjection,
  revisionReceipt: AdjustmentRevisionCommitReceipt,
): void {
  requireExactKeys(receipt, ["committed", "committedAt", "contractVersion", "projectionIdentitySha256",
    "projectionKind", "projectionSha256", "publishReceiptSha256", "revisionReceiptSha256"]);
  const unsigned = {
    committed: receipt.committed,
    committedAt: receipt.committedAt,
    contractVersion: receipt.contractVersion,
    projectionIdentitySha256: receipt.projectionIdentitySha256,
    projectionKind: receipt.projectionKind,
    projectionSha256: receipt.projectionSha256,
    revisionReceiptSha256: receipt.revisionReceiptSha256,
  };
  // cross-bind the checkpoint to the exact admitted database receipt
  if (receipt.contractVersion !== "adjustment-revision-publish-receipt/v1" || receipt.committed !== true ||
      !validInstant(receipt.committedAt) || receipt.projectionKind !== projection.projectionKind ||
      receipt.projectionIdentitySha256 !== revisionReceipt.projectionIdentitySha256 ||
      receipt.projectionSha256 !== revisionReceipt.projectionSha256 ||
      receipt.revisionReceiptSha256 !== revisionReceipt.receiptSha256 ||
      receipt.publishReceiptSha256 !== sha256(Buffer.from(JSON.stringify(unsigned) + "\n"))) {
    throw new RangeError("adjustment revision publish receipt differs");
  }
}

// read one bounded json request body
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  // cap transport allocation before parsing attacker-controlled json
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    // stop before the private combined-cycle admission ceiling
    if (length > MAX_INTERNAL_REQUEST_BYTES) {
      throw new RangeError("adjustment internal request is too large");
    }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// post one bounded private json document
async function postJson<T>(url: URL, value: unknown): Promise<T> {
  const body = JSON.stringify(value);
  // prevent accidental cross-host schemes and oversized relay messages
  if (url.protocol !== "http:" || Buffer.byteLength(body) > MAX_INTERNAL_REQUEST_BYTES) {
    throw new RangeError("adjustment internal relay is invalid");
  }
  const response = await fetch(url, {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  // treat every non-success as a categorical shadow failure
  if (!response.ok) {
    const error = new Error("adjustment internal relay failed") as Error & { code?: string };
    // preserve only the web archive's bounded capacity signal for worker retry
    if (response.status === 429) {
      error.code = "adjustment_revision_spool_refused";
    }
    throw error;
  }
  return await response.json() as T;
}

// identify the one retryable internal archive response
function isAdjustmentRevisionSpoolRefusal(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "adjustment_revision_spool_refused";
}

// accept only a credential-free private http origin
function parseInternalOrigin(value: string, allowedHosts: readonly string[]): URL {
  const url = new URL(value);
  // exclude public path controls, credentials and tls termination assumptions
  if (url.protocol !== "http:" || !allowedHosts.includes(url.hostname) ||
      url.username !== "" || url.password !== "" ||
      url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new RangeError("adjustment internal origin is invalid");
  }
  return url;
}

// decode canonical padded base64 without accepting aliases
function strictBase64(value: unknown): Buffer {
  // reject unbounded or malformed transport fields
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_INTERNAL_REQUEST_BYTES || value.length % 4 !== 0) {
    throw new RangeError("adjustment internal base64 is invalid");
  }
  const paddingLength = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const content = paddingLength === 0 ? value : value.slice(0, -paddingLength);
  if (/[^A-Za-z0-9+/]/u.test(content) ||
      (paddingLength === 1 && content.length % 4 !== 3) ||
      (paddingLength === 2 && content.length % 4 !== 2)) {
    throw new RangeError("adjustment internal base64 is invalid");
  }
  const bytes = Buffer.from(value, "base64");
  // reject alternate encodings for the same bytes
  if (bytes.toString("base64") !== value) {
    throw new RangeError("adjustment internal base64 is not canonical");
  }
  return bytes;
}

// retain null while encoding exact finite raw binary64 values
function nullableBinary64(value: number | null): string | null {
  return value === null ? null : encodeMaintenanceBinary64(value);
}

// normalize database timestamps to exact utc milliseconds
function instant(value: Date | string): string {
  const normalized = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  // refuse invalid or noncanonical dates before source projection
  if (!validInstant(normalized)) {
    throw new RangeError("adjustment source instant is invalid");
  }
  return normalized;
}

// test one exact utc millisecond instant
function validInstant(value: unknown): value is string {
  return typeof value === "string" && UTC_MILLISECOND.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

// require one exact plain-object key set
function requireExactKeys(value: unknown, expected: readonly string[]): void {
  // reject arrays, prototypes and private extension fields
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join("\n") !== [...expected].sort().join("\n")) {
    throw new RangeError("adjustment internal fields differ");
  }
}

// write one closed internal json response
function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json",
  });
  response.end(body);
}

// hash only exact bytes
function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

// distinguish exact admission refusal from archive failures
class AdmissionError extends Error {
  // construct one redacted categorical error
  constructor() {
    super("adjustment shadow body was not admitted");
    this.name = "AdmissionError";
  }
}
