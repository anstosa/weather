import type { QueryResultRow } from "pg";

import type { Queryable } from "./pool.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const UTC_MILLISECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DUE_KEY_PATTERN =
  /^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const HOUR_MS = 3_600_000;
const MAX_INPUT_BYTES = 2_048;
const MAX_AVAILABILITY_BYTES = 512 * 1_024;
const MAX_AUTHORIZATION_BYTES = 8_192;

const FAMILY_LIMITS = Object.freeze({
  rain: Object.freeze({
    bodyBytes: 12_288,
    rows: 23,
    schemaSha256: "c7ae2f750f13970137b1b2d885f7cce81b8ecbc2720635c6716f005bc04a5e25",
  }),
  temperature: Object.freeze({
    bodyBytes: 8_192,
    rows: 12,
    schemaSha256: "4255feacfd464adf2cbbf1139ecdf30d9d00b847775c556407367ad1449d9e63",
  }),
  wind: Object.freeze({
    bodyBytes: 65_536,
    rows: 168,
    schemaSha256: "3f573c3e49ed3b97636674b0630e49508cf80533ff8edc8f31f6f0411f70d902",
  }),
} as const);

const REGISTRATION_V2_KEYS = Object.freeze([
  "artifactSha256",
  "candidateSha256",
  "cohortSha256",
  "family",
  "intervalEndAt",
  "intervalStartAt",
  "policySha256",
  "registrationSha256",
  "reservedKeySha256",
  "siteKey",
  "sourceSha256",
  "targetCutoffAt",
  "terminalAt",
] as const);

const REGISTRATION_V3_KEYS = Object.freeze([
  ...REGISTRATION_V2_KEYS,
  "epochWitnessSha256",
  "predecessorRegistrationSha256",
  "scheduleContractSha256",
] as const);

const REGISTRATION_SLOT_KEYS = Object.freeze([
  "contractVersion",
  "epochWitnessSha256",
  "family",
  "horizonEndAt",
  "registrationSha256",
  "scheduleContractSha256",
  "state",
  "terminalAt",
] as const);

const PREDICTION_KEYS = Object.freeze([
  "bodyByteCount",
  "candidateSha256",
  "dueKey",
  "inputSha256",
  "issuedAt",
  "maxValidAt",
  "minValidAt",
  "predictionBodySha256",
  "predictionSchemaSha256",
  "predictionSha256",
  "registrationSha256",
  "rowCount",
  "sourceReceiptSha256",
  "sourceSha256",
  "stageReceiptSha256",
] as const);

const AVAILABILITY_KEYS = Object.freeze([
  "contractVersion",
  "expectedKeySetSha256",
  "family",
  "finalizedMetadataRootSha256",
  "finalizedPredictionCount",
  "finalizedThroughAt",
  "hotPredictionCount",
  "hotPredictions",
  "hotSetRootSha256",
  "intervalEndAt",
  "intervalStartAt",
  "metadataGeneration",
  "missingExpectedDueKeys",
  "missingExpectedDueKeysStatus",
  "registrationSha256",
  "targetCutoffAt",
] as const);

const HOT_PREDICTION_KEYS = Object.freeze([
  "dueKey",
  "maxValidAt",
  "minValidAt",
  "predictionSha256",
  "rowCount",
] as const);

const AUTHORIZATION_KEYS = Object.freeze([
  "accessSha256",
  "chunkCount",
  "chunkIndex",
  "contractVersion",
  "eligiblePredictionSetSha256",
  "expectedKeySetSha256",
  "family",
  "fromLocalDate",
  "metadataRootSha256",
  "registrationSha256",
  "revisionCatalogWatermarkSha256",
  "targetComparatorSnapshotRootSha256",
  "targetCutoffAt",
  "toLocalDateExclusive",
] as const);

export type AdjustmentShadowFamily = "temperature" | "wind" | "rain";

// define one frozen value-free registration input
export interface AdjustmentShadowRegistrationV2<F extends AdjustmentShadowFamily> {
  readonly artifactSha256: string;
  readonly candidateSha256: string;
  readonly cohortSha256: string;
  readonly family: F;
  readonly intervalEndAt: string;
  readonly intervalStartAt: string;
  readonly policySha256: string;
  readonly registrationSha256: string;
  readonly reservedKeySha256: string;
  readonly siteKey: "ballydidean";
  readonly sourceSha256: string;
  readonly targetCutoffAt: string;
  readonly terminalAt: string;
}

// define one future-only rolling registration bound to its schedule lineage
export interface AdjustmentShadowRegistrationV3<F extends AdjustmentShadowFamily>
  extends AdjustmentShadowRegistrationV2<F> {
  readonly epochWitnessSha256: string;
  readonly predecessorRegistrationSha256: string | null;
  readonly scheduleContractSha256: string;
}

export type AdjustmentShadowRegistration<F extends AdjustmentShadowFamily> =
  AdjustmentShadowRegistrationV2<F> | AdjustmentShadowRegistrationV3<F>;

// define one compact body receipt input without value fields
export interface AdjustmentShadowPrediction {
  readonly bodyByteCount: number;
  readonly candidateSha256: string;
  readonly dueKey: string;
  readonly inputSha256: string;
  readonly issuedAt: string;
  readonly maxValidAt: string;
  readonly minValidAt: string;
  readonly predictionBodySha256: string;
  readonly predictionSchemaSha256: string;
  readonly predictionSha256: string;
  readonly registrationSha256: string;
  readonly rowCount: number;
  readonly sourceReceiptSha256: string;
  readonly sourceSha256: string;
  readonly stageReceiptSha256: string;
}

// expose one authoritative server-assigned archive receipt
export interface AdjustmentRevisionCommitReceipt {
  readonly archiveCommitOrdinal: string;
  readonly archiveCommittedAt: string;
  readonly contractVersion: "adjustment-revision-commit-receipt/v1";
  readonly frontierSha256: string;
  readonly predecessorFrontierSha256: string;
  readonly projectionIdentitySha256: string;
  readonly projectionKind: "actual_best_match" | "native_source" |
    "rain_gate_input" | "shadow_prediction" | "target_revision";
  readonly projectionSha256: string;
  readonly receiptSha256: string;
  readonly stageReceiptSha256: string;
}

// define one staged current weather-row pointer
export interface AdjustmentWeatherRevisionPointer {
  readonly productRunAt: string | null;
  readonly projectionIdentitySha256: string;
  readonly projectionSha256: string;
  readonly sourceId: string;
  readonly sourceKind: "forecast" | "physical_sensor";
  readonly stageReceiptSha256: string;
  readonly storedContentSha256: string;
  readonly validAt: string;
}

// define one staged fixed-anchor pointer
export interface AdjustmentForecastAnchorRevisionPointer {
  readonly leadHours: number;
  readonly projectionIdentitySha256: string;
  readonly projectionSha256: string;
  readonly sourceId: string;
  readonly stageReceiptSha256: string;
  readonly storedContentSha256: string;
  readonly validAt: string;
}

// define one staged rain-gate pointer
export interface AdjustmentRainGateRevisionPointer {
  readonly inputSha256: string;
  readonly modelSha256: string;
  readonly projectionIdentitySha256: string;
  readonly projectionSha256: string;
  readonly runInitializedAt: string;
  readonly stageReceiptSha256: string;
  readonly storedContentSha256: string;
}

// define one staged complete temperature-run pointer
export interface AdjustmentEcmwfTemperatureRevisionPointer {
  readonly projectionIdentitySha256: string;
  readonly projectionSha256: string;
  readonly providerResponseSha256: string;
  readonly runInitializedAt: string;
  readonly siteId: string;
  readonly stageReceiptSha256: string;
  readonly storedContentSha256: string;
}

// expose one bounded server receipt batch
export interface AdjustmentRevisionBatchReceipt {
  readonly contractVersion: "adjustment-revision-batch-receipt/v1";
  readonly receipts: readonly Readonly<Record<string, unknown>>[];
}

// expose one server receipt bound to a single serving row
export interface AdjustmentRevisionRowReceipt {
  readonly contractVersion: "adjustment-revision-row-receipt/v1";
  readonly revisionReceipt: AdjustmentRevisionCommitReceipt;
}

// expose one bounded value-free current-pointer snapshot
export interface AdjustmentRevisionServingSnapshot {
  readonly archiveCommitOrdinal: string;
  readonly contractVersion: "adjustment-revision-serving-snapshot/v1";
  readonly cutoffAt: string;
  readonly entries: readonly Readonly<{
    logicalReceivedAt: string;
    receipt: AdjustmentRevisionCommitReceipt;
    relation: "ecmwf_temperature_canary_runs" | "forecast_anchor_records" |
      "rain_adjustment_runs" | "weather_records";
  }>[];
  readonly entryCount: number;
  readonly frontierSha256: string;
  readonly snapshotSha256: string;
}

// identify one persisted comparator or target pointer
export type AdjustmentWeatherRevisionAdmissionKey = Pick<AdjustmentWeatherRevisionPointer,
  "productRunAt" | "sourceId" | "sourceKind" | "storedContentSha256" | "validAt">;

// identify one persisted fixed-anchor pointer
export type AdjustmentForecastAnchorRevisionAdmissionKey =
  Pick<AdjustmentForecastAnchorRevisionPointer,
    "leadHours" | "sourceId" | "storedContentSha256" | "validAt">;

// identify one persisted rain-gate pointer
export type AdjustmentRainGateRevisionAdmissionKey = Pick<AdjustmentRainGateRevisionPointer,
  "inputSha256" | "modelSha256" | "runInitializedAt" | "storedContentSha256">;

// identify one persisted complete-temperature pointer
export type AdjustmentEcmwfTemperatureRevisionAdmissionKey =
  Pick<AdjustmentEcmwfTemperatureRevisionPointer,
    "providerResponseSha256" | "runInitializedAt" | "siteId" | "storedContentSha256">;

// retain one value-free permanent archive failure
export interface AdjustmentRevisionGap {
  readonly logicalKeySha256: string;
  readonly projectionIdentitySha256: string | null;
  readonly projectionKind: AdjustmentRevisionCommitReceipt["projectionKind"];
  readonly projectionSha256: string | null;
  readonly reason: "archive_stage_failed" | "database_bind_failed" |
    "database_admission_failed" | "archive_publish_failed";
}

// expose only the bounded registration receipt
export interface AdjustmentShadowRegistrationReceipt {
  readonly inserted: boolean;
  readonly registrationSha256: string;
}

// expose one value-free rolling family slot and finite capture horizon
export interface AdjustmentShadowRegistrationSlot {
  readonly contractVersion: "adjustment-shadow-registration-slot/v3";
  readonly epochWitnessSha256: string;
  readonly family: AdjustmentShadowFamily;
  readonly horizonEndAt: string;
  readonly registrationSha256: string | null;
  readonly scheduleContractSha256: string;
  readonly state: "busy_v2_legacy" | "busy_v3" | "free";
  readonly terminalAt: string | null;
}

// expose only the bounded compact-row receipt
export interface AdjustmentShadowPredictionReceipt {
  readonly committedAt: string;
  readonly inserted: boolean;
  readonly predictionSha256: string;
  readonly revisionReceipt: AdjustmentRevisionCommitReceipt;
}

// expose one value-free hot prediction identity
export interface AdjustmentHotPrediction {
  readonly dueKey: string;
  readonly maxValidAt: string;
  readonly minValidAt: string;
  readonly predictionSha256: string;
  readonly rowCount: number;
}

// expose value-free availability pending cold reconstruction
export interface AdjustmentConfirmationAvailability {
  readonly contractVersion: "adjustment-confirmation-availability/v2";
  readonly expectedKeySetSha256: string;
  readonly family: AdjustmentShadowFamily;
  readonly finalizedMetadataRootSha256: string;
  readonly finalizedPredictionCount: number;
  readonly finalizedThroughAt: string | null;
  readonly hotPredictionCount: number;
  readonly hotPredictions: readonly AdjustmentHotPrediction[];
  readonly hotSetRootSha256: string;
  readonly intervalEndAt: string;
  readonly intervalStartAt: string;
  readonly metadataGeneration: number;
  readonly missingExpectedDueKeys: null;
  readonly missingExpectedDueKeysStatus: "requires_anchored_cold_reconstruction";
  readonly registrationSha256: string;
  readonly targetCutoffAt: string;
}

// expose one post-burn value-free chunk authorization
export interface AdjustmentConfirmationChunkAuthorization {
  readonly accessSha256: string;
  readonly chunkCount: 24 | 27;
  readonly chunkIndex: number;
  readonly contractVersion: "adjustment-confirmation-export-authorization/v2";
  readonly eligiblePredictionSetSha256: string;
  readonly expectedKeySetSha256: string;
  readonly family: AdjustmentShadowFamily;
  readonly fromLocalDate: string;
  readonly metadataRootSha256: string;
  readonly registrationSha256: string;
  readonly revisionCatalogWatermarkSha256: string;
  readonly targetComparatorSnapshotRootSha256: string;
  readonly targetCutoffAt: string;
  readonly toLocalDateExclusive: string;
}

interface JsonRow extends QueryResultRow {
  readonly value: unknown;
}

interface BooleanRow extends QueryResultRow {
  readonly admitted: unknown;
}

// register one API-owned temperature or wind slot
export async function registerApiAdjustmentShadow(
  queryable: Queryable,
  registration: AdjustmentShadowRegistration<"temperature" | "wind">,
): Promise<AdjustmentShadowRegistrationReceipt> {
  return registerAdjustmentShadow(queryable, registration, ["temperature", "wind"]);
}

// register the one ingest-owned rain slot
export async function registerRainAdjustmentShadow(
  queryable: Queryable,
  registration: AdjustmentShadowRegistration<"rain">,
): Promise<AdjustmentShadowRegistrationReceipt> {
  return registerAdjustmentShadow(queryable, registration, ["rain"]);
}

// read one server-owned family slot before starting any monthly fit
export async function readAdjustmentShadowRegistrationSlot(
  queryable: Queryable,
  family: AdjustmentShadowFamily,
): Promise<AdjustmentShadowRegistrationSlot> {
  // reject family aliases before the database boundary
  if (!isFamily(family)) {
    throw new RangeError("adjustment registration family is invalid");
  }
  const result = await queryable.query<JsonRow>(
    "SELECT adjustment_shadow_registration_slot_v3($1::text) AS value",
    [family],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment registration slot");
  validateRegistrationSlot(value, family);
  return value as unknown as AdjustmentShadowRegistrationSlot;
}

// append one API-owned temperature compact receipt
export async function appendTemperatureAdjustmentShadow(
  queryable: Queryable,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  return appendAdjustmentShadow(queryable, "temperature", prediction);
}

// append one API-owned wind compact receipt
export async function appendWindAdjustmentShadow(
  queryable: Queryable,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  return appendAdjustmentShadow(queryable, "wind", prediction);
}

// append one ingest-owned rain compact receipt
export async function appendRainAdjustmentShadow(
  queryable: Queryable,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  return appendAdjustmentShadow(queryable, "rain", prediction);
}

// check one exact API body relay tuple
export async function isAdjustmentShadowBodyAdmitted(
  queryable: Queryable,
  registrationSha256: string,
  dueKey: string,
  predictionBodySha256: string,
  bodyByteCount: number,
): Promise<boolean> {
  requireHash(registrationSha256, "registration identity");
  parseDueKey(dueKey);
  requireHash(predictionBodySha256, "prediction body identity");
  requireInteger(bodyByteCount, 1, FAMILY_LIMITS.wind.bodyBytes, "body byte count");
  const result = await queryable.query<BooleanRow>(
    `SELECT adjustment_shadow_body_admission_v2(
      $1::text, $2::text, $3::text, $4::integer
    ) AS admitted`,
    [registrationSha256, dueKey, predictionBodySha256, bodyByteCount],
  );
  const admitted = result.rows[0]?.admitted;
  // require the exact scalar contract
  if (typeof admitted !== "boolean" || result.rows.length !== 1) {
    throw new Error("adjustment body admission contract mismatch");
  }
  return admitted;
}

// read one exact persisted revision receipt through the API role
export async function readAdjustmentShadowRevisionAdmission(
  queryable: Queryable,
  registrationSha256: string,
  dueKey: string,
  predictionBodySha256: string,
  bodyByteCount: number,
): Promise<AdjustmentRevisionCommitReceipt> {
  requireHash(registrationSha256, "registration identity");
  parseDueKey(dueKey);
  requireHash(predictionBodySha256, "prediction body identity");
  requireInteger(bodyByteCount, 1, FAMILY_LIMITS.wind.bodyBytes, "body byte count");
  const result = await queryable.query<JsonRow>(
    `SELECT adjustment_shadow_revision_admission_v1(
      $1::text, $2::text, $3::text, $4::integer
    ) AS value`,
    [registrationSha256, dueKey, predictionBodySha256, bodyByteCount],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment revision admission");
  validateRevisionCommitReceiptShape(value);
  return value as unknown as AdjustmentRevisionCommitReceipt;
}

// bind one staged batch to exact weather serving revisions
export async function bindAdjustmentWeatherRevisions(
  queryable: Queryable,
  pointers: readonly AdjustmentWeatherRevisionPointer[],
): Promise<AdjustmentRevisionBatchReceipt> {
  validateRevisionBatch(pointers, "weather revision batch", (pointer) => {
    requireExactObject(pointer, ["productRunAt", "projectionIdentitySha256",
      "projectionSha256", "sourceId", "sourceKind", "stageReceiptSha256",
      "storedContentSha256", "validAt"],
    "weather revision pointer");
    requireDecimalIdentity(pointer.sourceId, "weather source identity");
    requireHash(pointer.storedContentSha256, "weather stored content identity");
    requireHash(pointer.projectionIdentitySha256, "weather projection identity");
    requireHash(pointer.projectionSha256, "weather projection rows identity");
    // bind both receipt identities to the exact canonical projection bytes
    if (pointer.projectionSha256 !== pointer.projectionIdentitySha256) {
      throw new RangeError("weather projection identities differ");
    }
    requireHash(pointer.stageReceiptSha256, "weather stage receipt identity");
    parseUtcMilliseconds(pointer.validAt, "weather valid time");
    // require source-kind-specific product clocks
    if (pointer.sourceKind === "forecast") {
      parseUtcMilliseconds(pointer.productRunAt, "weather product run time");
    } else if (pointer.sourceKind !== "physical_sensor" || pointer.productRunAt !== null) {
      throw new RangeError("weather revision source kind is invalid");
    }
  });
  return callRevisionBatch(queryable, "weather_bind_weather_record_revisions_v1", pointers);
}

// bind one staged batch to exact fixed-anchor revisions
export async function bindAdjustmentForecastAnchorRevisions(
  queryable: Queryable,
  pointers: readonly AdjustmentForecastAnchorRevisionPointer[],
): Promise<AdjustmentRevisionBatchReceipt> {
  validateRevisionBatch(pointers, "forecast anchor revision batch", (pointer) => {
    requireExactObject(pointer, ["leadHours", "projectionIdentitySha256",
      "projectionSha256", "sourceId", "stageReceiptSha256", "storedContentSha256",
      "validAt"],
    "forecast anchor revision pointer");
    requireDecimalIdentity(pointer.sourceId, "forecast anchor source identity");
    requireInteger(pointer.leadHours, 1, 384, "forecast anchor lead hours");
    requireHash(pointer.storedContentSha256, "forecast anchor stored content identity");
    requireHash(pointer.projectionIdentitySha256, "forecast anchor projection identity");
    requireHash(pointer.projectionSha256, "forecast anchor projection rows identity");
    // bind both receipt identities to the exact canonical projection bytes
    if (pointer.projectionSha256 !== pointer.projectionIdentitySha256) {
      throw new RangeError("forecast anchor projection identities differ");
    }
    requireHash(pointer.stageReceiptSha256, "forecast anchor stage receipt identity");
    parseUtcMilliseconds(pointer.validAt, "forecast anchor valid time");
  });
  return callRevisionBatch(queryable, "weather_bind_forecast_anchor_revisions_v1", pointers);
}

// bind one staged rain gate to its exact stored inference row
export async function bindAdjustmentRainGateRevision(
  queryable: Queryable,
  pointer: AdjustmentRainGateRevisionPointer,
): Promise<AdjustmentRevisionRowReceipt> {
  requireExactObject(pointer, ["inputSha256", "modelSha256", "projectionIdentitySha256",
    "projectionSha256", "runInitializedAt", "stageReceiptSha256", "storedContentSha256"],
  "rain gate revision pointer");
  requireHash(pointer.inputSha256, "rain gate input identity");
  requireHash(pointer.modelSha256, "rain gate model identity");
  requireHash(pointer.projectionIdentitySha256, "rain gate projection identity");
  requireHash(pointer.projectionSha256, "rain gate projection rows identity");
  requireHash(pointer.storedContentSha256, "rain gate stored content identity");
  // bind both receipt identities to the exact canonical projection bytes
  if (pointer.projectionSha256 !== pointer.projectionIdentitySha256) {
    throw new RangeError("rain gate projection identities differ");
  }
  requireHash(pointer.stageReceiptSha256, "rain gate stage receipt identity");
  parseUtcMilliseconds(pointer.runInitializedAt, "rain gate initialization");
  return callRevisionRow(queryable, "weather_bind_rain_gate_revision_v1", pointer);
}

// bind one staged complete temperature run to its exact persisted hours
export async function bindAdjustmentEcmwfTemperatureRevision(
  queryable: Queryable,
  pointer: AdjustmentEcmwfTemperatureRevisionPointer,
): Promise<AdjustmentRevisionRowReceipt> {
  requireExactObject(pointer, ["projectionIdentitySha256", "projectionSha256",
    "providerResponseSha256", "runInitializedAt", "siteId", "stageReceiptSha256",
    "storedContentSha256"],
  "temperature revision pointer");
  requireDecimalIdentity(pointer.siteId, "temperature site identity");
  requireHash(pointer.storedContentSha256, "temperature stored content identity");
  requireHash(pointer.projectionIdentitySha256, "temperature projection identity");
  requireHash(pointer.projectionSha256, "temperature projection rows identity");
  // bind both receipt identities to the exact canonical projection bytes
  if (pointer.projectionSha256 !== pointer.projectionIdentitySha256) {
    throw new RangeError("temperature projection identities differ");
  }
  requireHash(pointer.providerResponseSha256, "temperature provider response identity");
  requireHash(pointer.stageReceiptSha256, "temperature stage receipt identity");
  parseUtcMilliseconds(pointer.runInitializedAt, "temperature run initialization");
  return callRevisionRow(queryable, "weather_bind_ecmwf_temperature_revision_v1", pointer);
}

// read one frozen training-only current-pointer snapshot
export async function readTrainingAdjustmentRevisionServingSnapshot(
  queryable: Queryable,
  cutoffAt: string,
  archiveCommitOrdinal: string,
): Promise<AdjustmentRevisionServingSnapshot> {
  parseUtcMilliseconds(cutoffAt, "revision snapshot cutoff");
  // admit only the reserved genesis zero or a positive server ordinal
  if (!/^(?:0|[1-9][0-9]*)$/u.test(archiveCommitOrdinal)) {
    throw new RangeError("revision snapshot ordinal is invalid");
  }
  const result = await queryable.query<JsonRow>(
    `SELECT adjustment_revision_serving_snapshot_v1(
      $1::timestamptz, $2::bigint
    ) AS value`,
    [cutoffAt, archiveCommitOrdinal],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment revision serving snapshot");
  requireExactObject(value, ["archiveCommitOrdinal", "contractVersion", "cutoffAt", "entries",
    "entryCount", "frontierSha256", "snapshotSha256"],
  "adjustment revision serving snapshot");
  // require the exact frozen request identity and bounded result
  if (value.contractVersion !== "adjustment-revision-serving-snapshot/v1" ||
    value.cutoffAt !== cutoffAt || value.archiveCommitOrdinal !== archiveCommitOrdinal ||
    !Array.isArray(value.entries) || value.entries.length > 4096 ||
    value.entryCount !== value.entries.length) {
    throw new Error("adjustment revision serving snapshot mismatch");
  }
  requireHash(value.frontierSha256, "revision snapshot frontier");
  requireHash(value.snapshotSha256, "revision snapshot identity");
  // validate every server receipt and cutoff-bound logical clock
  for (const entry of value.entries) {
    requireExactObject(entry, ["logicalReceivedAt", "receipt", "relation"],
      "adjustment revision serving snapshot entry");
    parseUtcMilliseconds(entry.logicalReceivedAt, "revision snapshot logical receipt time");
    validateRevisionCommitReceiptShape(entry.receipt);
  }
  requireBoundedJson(value, 4 * 1024 * 1024, "adjustment revision serving snapshot");
  return value as unknown as AdjustmentRevisionServingSnapshot;
}

// read one API-authenticated comparator or target revision receipt
export async function readAdjustmentWeatherRevisionAdmission(
  queryable: Queryable,
  key: AdjustmentWeatherRevisionAdmissionKey,
): Promise<AdjustmentRevisionCommitReceipt> {
  requireExactObject(key, ["productRunAt", "sourceId", "sourceKind", "storedContentSha256",
    "validAt"], "weather revision admission key");
  requireDecimalIdentity(key.sourceId, "weather source identity");
  requireHash(key.storedContentSha256, "weather stored content identity");
  parseUtcMilliseconds(key.validAt, "weather valid time");
  // require the kind-specific product clock
  if (key.sourceKind === "forecast") {
    parseUtcMilliseconds(key.productRunAt, "weather product run time");
  } else if (key.sourceKind !== "physical_sensor" || key.productRunAt !== null) {
    throw new RangeError("weather revision admission key is invalid");
  }
  return readRevisionAdmission(queryable, "adjustment_weather_revision_admission_v1", key);
}

// read one API-authenticated fixed-anchor revision receipt
export async function readAdjustmentForecastAnchorRevisionAdmission(
  queryable: Queryable,
  key: AdjustmentForecastAnchorRevisionAdmissionKey,
): Promise<AdjustmentRevisionCommitReceipt> {
  requireExactObject(key, ["leadHours", "sourceId", "storedContentSha256", "validAt"],
    "forecast anchor revision admission key");
  requireDecimalIdentity(key.sourceId, "forecast anchor source identity");
  requireInteger(key.leadHours, 1, 384, "forecast anchor lead hours");
  requireHash(key.storedContentSha256, "forecast anchor stored content identity");
  parseUtcMilliseconds(key.validAt, "forecast anchor valid time");
  return readRevisionAdmission(queryable,
    "adjustment_forecast_anchor_revision_admission_v1", key);
}

// read one API-authenticated rain-gate revision receipt
export async function readAdjustmentRainGateRevisionAdmission(
  queryable: Queryable,
  key: AdjustmentRainGateRevisionAdmissionKey,
): Promise<AdjustmentRevisionCommitReceipt> {
  requireExactObject(key, ["inputSha256", "modelSha256", "runInitializedAt",
    "storedContentSha256"], "rain gate revision admission key");
  requireHash(key.inputSha256, "rain gate input identity");
  requireHash(key.modelSha256, "rain gate model identity");
  requireHash(key.storedContentSha256, "rain gate stored content identity");
  parseUtcMilliseconds(key.runInitializedAt, "rain gate initialization");
  return readRevisionAdmission(queryable, "adjustment_rain_gate_revision_admission_v1", key);
}

// read one API-authenticated complete-temperature revision receipt
export async function readAdjustmentEcmwfTemperatureRevisionAdmission(
  queryable: Queryable,
  key: AdjustmentEcmwfTemperatureRevisionAdmissionKey,
): Promise<AdjustmentRevisionCommitReceipt> {
  requireExactObject(key, ["providerResponseSha256", "runInitializedAt", "siteId",
    "storedContentSha256"], "temperature revision admission key");
  requireDecimalIdentity(key.siteId, "temperature site identity");
  requireHash(key.providerResponseSha256, "temperature provider response identity");
  requireHash(key.storedContentSha256, "temperature stored content identity");
  parseUtcMilliseconds(key.runInitializedAt, "temperature run initialization");
  return readRevisionAdmission(queryable,
    "adjustment_ecmwf_temperature_revision_admission_v1", key);
}

// mark one exact current serving revision permanently unqualified
export async function markAdjustmentRevisionGap(
  queryable: Queryable,
  relationKind: "weather_record" | "forecast_anchor" | "rain_gate" | "ecmwf_temperature",
  key: AdjustmentWeatherRevisionAdmissionKey |
    AdjustmentForecastAnchorRevisionAdmissionKey |
    AdjustmentRainGateRevisionAdmissionKey |
    AdjustmentEcmwfTemperatureRevisionAdmissionKey,
  gap: AdjustmentRevisionGap,
): Promise<Readonly<Record<string, unknown>>> {
  requireExactObject(gap, ["logicalKeySha256", "projectionIdentitySha256", "projectionKind",
    "projectionSha256", "reason"], "adjustment revision gap");
  requireHash(gap.logicalKeySha256, "revision gap logical key identity");
  // require both canonical-body hashes together or neither before encoding existed
  if ((gap.projectionIdentitySha256 === null) !== (gap.projectionSha256 === null) ||
    (gap.projectionIdentitySha256 !== null &&
      (gap.projectionIdentitySha256 !== gap.projectionSha256 ||
        !HASH_PATTERN.test(gap.projectionIdentitySha256))) ||
    !["actual_best_match", "native_source", "rain_gate_input", "target_revision"]
      .includes(gap.projectionKind) ||
    !["archive_stage_failed", "database_bind_failed", "database_admission_failed",
      "archive_publish_failed"].includes(gap.reason)) {
    throw new RangeError("adjustment revision gap is invalid");
  }
  const result = await queryable.query<JsonRow>(
    `SELECT weather_mark_adjustment_revision_gap_v1(
      $1::text, $2::jsonb, $3::jsonb
    ) AS value`,
    [relationKind, JSON.stringify(key), JSON.stringify(gap)],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment revision gap marker");
  requireExactObject(value, ["contractVersion", "logicalKeySha256", "projectionIdentitySha256",
    "projectionKind", "projectionSha256", "reason", "storedContentSha256"],
  "adjustment revision gap marker");
  // require the database to retain the exact permanent classification
  if (value.contractVersion !== "adjustment-revision-gap-marker/v1" ||
    value.logicalKeySha256 !== gap.logicalKeySha256 || value.reason !== gap.reason) {
    throw new Error("adjustment revision gap marker mismatch");
  }
  return value;
}

// read one training-only value-free availability document
export async function readTrainingAdjustmentConfirmationAvailability(
  queryable: Queryable,
  registrationSha256: string,
): Promise<AdjustmentConfirmationAvailability> {
  requireHash(registrationSha256, "registration identity");
  const result = await queryable.query<JsonRow>(
    "SELECT adjustment_confirmation_availability_v2($1::text) AS value",
    [registrationSha256],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment availability");
  validateAvailability(value, registrationSha256);
  return value as unknown as AdjustmentConfirmationAvailability;
}

// authorize one training-only post-burn chunk
export async function authorizeTrainingAdjustmentConfirmationChunk(
  queryable: Queryable,
  registrationSha256: string,
  accessSha256: string,
  chunkIndex: number,
): Promise<AdjustmentConfirmationChunkAuthorization> {
  requireHash(registrationSha256, "registration identity");
  requireHash(accessSha256, "access identity");
  requireInteger(chunkIndex, 0, 26, "chunk index");
  const result = await queryable.query<JsonRow>(
    `SELECT adjustment_confirmation_export_v2(
      $1::text, $2::text, $3::smallint
    ) AS value`,
    [registrationSha256, accessSha256, chunkIndex],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment chunk authorization");
  validateAuthorization(value, registrationSha256, accessSha256, chunkIndex);
  return value as unknown as AdjustmentConfirmationChunkAuthorization;
}

// register through the one closed database function
async function registerAdjustmentShadow<F extends AdjustmentShadowFamily>(
  queryable: Queryable,
  registration: AdjustmentShadowRegistration<F>,
  allowedFamilies: readonly F[],
): Promise<AdjustmentShadowRegistrationReceipt> {
  const keys = Object.keys(registration).sort().join(",");
  const isV2 = keys === [...REGISTRATION_V2_KEYS].sort().join(",");
  const isV3 = keys === [...REGISTRATION_V3_KEYS].sort().join(",");

  // reject partial rolling extensions and unknown registration versions
  if (!isV2 && !isV3) {
    throw new RangeError("adjustment registration is not a closed object");
  }
  // keep role-shaped methods from crossing family authority
  if (!allowedFamilies.includes(registration.family)) {
    throw new RangeError("adjustment registration family is invalid");
  }
  // keep the registration fixed to the deployed site
  if (registration.siteKey !== "ballydidean") {
    throw new RangeError("adjustment registration site is invalid");
  }
  // validate every frozen registration identity
  for (const [value, label] of [
    [registration.artifactSha256, "artifact identity"],
    [registration.candidateSha256, "candidate identity"],
    [registration.cohortSha256, "cohort identity"],
    [registration.policySha256, "policy identity"],
    [registration.registrationSha256, "registration identity"],
    [registration.reservedKeySha256, "reserved key identity"],
    [registration.sourceSha256, "source identity"],
  ] as const) {
    requireHash(value, label);
  }
  // bind future-only members to the exact schedule and predecessor identity
  if (isV3) {
    const rolling = registration as AdjustmentShadowRegistrationV3<F>;
    requireHash(rolling.epochWitnessSha256, "epoch witness identity");
    requireHash(rolling.scheduleContractSha256, "schedule contract identity");

    // accept only one nullable exact predecessor identity
    if (rolling.predecessorRegistrationSha256 !== null) {
      requireHash(rolling.predecessorRegistrationSha256,
        "predecessor registration identity");
    }
  }
  const intervalStart = parseUtcMilliseconds(registration.intervalStartAt, "interval start");
  const intervalEnd = parseUtcMilliseconds(registration.intervalEndAt, "interval end");
  const targetCutoff = parseUtcMilliseconds(registration.targetCutoffAt, "target cutoff");
  const terminal = parseUtcMilliseconds(registration.terminalAt, "terminal time");
  // require closed chronological interval clocks
  if (!(intervalStart < intervalEnd && intervalEnd <= targetCutoff && targetCutoff <= terminal)) {
    throw new RangeError("adjustment registration clocks are invalid");
  }
  const registrationKeys = isV3 ? REGISTRATION_V3_KEYS : REGISTRATION_V2_KEYS;
  const canonical = canonicalFlatJson(
    registration as unknown as Record<string, unknown>,
    registrationKeys,
    "adjustment registration",
  );
  const result = await queryable.query<JsonRow>(
    `SELECT weather_register_adjustment_shadow_v${isV3 ? "3" : "2"}($1::jsonb) AS value`,
    [canonical],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment registration receipt");
  requireExactObject(value, ["inserted", "registrationSha256"], "adjustment registration receipt");
  // require the database to bind the supplied identity
  if (typeof value.inserted !== "boolean" || value.registrationSha256 !== registration.registrationSha256) {
    throw new Error("adjustment registration receipt mismatch");
  }
  return value as unknown as AdjustmentShadowRegistrationReceipt;
}

// append through one fixed family function
async function appendAdjustmentShadow(
  queryable: Queryable,
  family: AdjustmentShadowFamily,
  prediction: AdjustmentShadowPrediction,
): Promise<AdjustmentShadowPredictionReceipt> {
  requireExactObject(prediction, PREDICTION_KEYS, "adjustment prediction");
  // validate every compact prediction identity
  for (const [value, label] of [
    [prediction.candidateSha256, "candidate identity"],
    [prediction.inputSha256, "input identity"],
    [prediction.predictionBodySha256, "prediction body identity"],
    [prediction.predictionSchemaSha256, "prediction schema identity"],
    [prediction.predictionSha256, "prediction identity"],
    [prediction.registrationSha256, "registration identity"],
    [prediction.sourceReceiptSha256, "source receipt identity"],
    [prediction.sourceSha256, "source identity"],
    [prediction.stageReceiptSha256, "stage receipt identity"],
  ] as const) {
    requireHash(value, label);
  }
  const limits = FAMILY_LIMITS[family];
  // require the exact public family schema
  if (prediction.predictionSchemaSha256 !== limits.schemaSha256) {
    throw new RangeError("adjustment prediction schema is invalid");
  }
  // complete lead bodies cannot qualify through a shortened row set
  if (prediction.rowCount !== limits.rows) {
    throw new RangeError("adjustment prediction row count is invalid");
  }
  requireInteger(prediction.bodyByteCount, 1, limits.bodyBytes, "prediction body byte count");
  const dueAt = parseDueKey(prediction.dueKey);
  const issuedAt = parseUtcMilliseconds(prediction.issuedAt, "prediction issue time");
  const minValidAt = parseUtcMilliseconds(prediction.minValidAt, "minimum valid time");
  const maxValidAt = parseUtcMilliseconds(prediction.maxValidAt, "maximum valid time");
  // preserve jitter while bounding it to the exact due window
  if (issuedAt < dueAt || issuedAt > dueAt + 12 * HOUR_MS) {
    throw new RangeError("adjustment prediction issue time is outside its due window");
  }
  // preserve actual source clocks before the prediction validity range
  if (issuedAt >= minValidAt || minValidAt > maxValidAt) {
    throw new RangeError("adjustment prediction validity clocks are invalid");
  }
  const canonical = canonicalFlatJson(prediction, PREDICTION_KEYS, "adjustment prediction");
  const functionName = {
    rain: "weather_append_adjustment_rain_shadow_v2",
    temperature: "weather_append_adjustment_temperature_shadow_v2",
    wind: "weather_append_adjustment_wind_shadow_v2",
  }[family];
  const result = await queryable.query<JsonRow>(
    `SELECT ${functionName}($1::jsonb) AS value`,
    [canonical],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment prediction receipt");
  requireExactObject(
    value,
    ["committedAt", "inserted", "predictionSha256", "revisionReceipt"],
    "adjustment prediction receipt",
  );
  parseUtcMilliseconds(value.committedAt, "prediction commit time");
  validateRevisionCommitReceipt(value.revisionReceipt, prediction);
  // require the database to bind the supplied identity
  if (typeof value.inserted !== "boolean" || value.predictionSha256 !== prediction.predictionSha256) {
    throw new Error("adjustment prediction receipt mismatch");
  }
  return value as unknown as AdjustmentShadowPredictionReceipt;
}

// validate one exact server-owned revision receipt
function validateRevisionCommitReceipt(
  value: unknown,
  prediction: AdjustmentShadowPrediction,
): void {
  validateRevisionCommitReceiptShape(value);
  // bind the receipt to the distinct staged shadow projection grammar
  if (value.projectionKind !== "shadow_prediction" ||
    value.projectionIdentitySha256 !== prediction.sourceReceiptSha256 ||
    value.projectionSha256 !== prediction.inputSha256 ||
    value.stageReceiptSha256 !== prediction.stageReceiptSha256) {
    throw new Error("adjustment revision receipt mismatch");
  }
}

// validate the closed persisted revision receipt shape
function validateRevisionCommitReceiptShape(value: unknown): asserts value is Record<string, unknown> {
  requireExactObject(value, [
    "archiveCommitOrdinal",
    "archiveCommittedAt",
    "contractVersion",
    "frontierSha256",
    "predecessorFrontierSha256",
    "projectionIdentitySha256",
    "projectionKind",
    "projectionSha256",
    "receiptSha256",
    "stageReceiptSha256",
  ], "adjustment revision receipt");
  if (value.contractVersion !== "adjustment-revision-commit-receipt/v1" ||
    !["actual_best_match", "native_source", "rain_gate_input", "shadow_prediction",
      "target_revision"]
      .includes(String(value.projectionKind)) ||
    typeof value.archiveCommitOrdinal !== "string" ||
    !/^[1-9][0-9]*$/u.test(value.archiveCommitOrdinal)) {
    throw new Error("adjustment revision receipt mismatch");
  }
  parseUtcMilliseconds(value.archiveCommittedAt, "revision archive commit time");
  // validate every server-owned chain identity
  for (const [candidate, label] of [
    [value.frontierSha256, "revision frontier"],
    [value.predecessorFrontierSha256, "revision predecessor frontier"],
    [value.projectionIdentitySha256, "revision projection identity"],
    [value.projectionSha256, "revision projection"],
    [value.receiptSha256, "revision receipt identity"],
    [value.stageReceiptSha256, "revision stage receipt identity"],
  ] as const) {
    requireHash(candidate, label);
  }
}

// call one bounded server-owned revision batch binder
async function callRevisionBatch<T>(
  queryable: Queryable,
  functionName: "weather_bind_weather_record_revisions_v1" |
    "weather_bind_forecast_anchor_revisions_v1",
  pointers: readonly T[],
): Promise<AdjustmentRevisionBatchReceipt> {
  const result = await queryable.query<JsonRow>(
    `SELECT ${functionName}($1::jsonb) AS value`,
    [JSON.stringify(pointers)],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment revision batch receipt");
  requireExactObject(value, ["contractVersion", "receipts"],
    "adjustment revision batch receipt");
  // require one returned receipt per exact staged pointer
  if (value.contractVersion !== "adjustment-revision-batch-receipt/v1" ||
    !Array.isArray(value.receipts) || value.receipts.length !== pointers.length) {
    throw new Error("adjustment revision batch receipt mismatch");
  }
  // validate every nested server receipt without accepting value fields
  for (const entry of value.receipts) {
    requireExactObject(entry, functionName === "weather_bind_weather_record_revisions_v1"
      ? ["projectionKind", "revisionReceipt", "sourceId", "storedContentSha256", "validAt"]
      : ["leadHours", "revisionReceipt", "sourceId", "storedContentSha256", "validAt"],
    "adjustment revision batch entry");
    validateRevisionCommitReceiptShape(entry.revisionReceipt);
  }
  return value as unknown as AdjustmentRevisionBatchReceipt;
}

// call one server-owned single-row revision binder
async function callRevisionRow<T>(
  queryable: Queryable,
  functionName: "weather_bind_rain_gate_revision_v1" |
    "weather_bind_ecmwf_temperature_revision_v1",
  pointer: T,
): Promise<AdjustmentRevisionRowReceipt> {
  const result = await queryable.query<JsonRow>(
    `SELECT ${functionName}($1::jsonb) AS value`,
    [JSON.stringify(pointer)],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment revision row receipt");
  requireExactObject(value, ["contractVersion", "revisionReceipt"],
    "adjustment revision row receipt");
  // require the fixed row wrapper before returning the server receipt
  if (value.contractVersion !== "adjustment-revision-row-receipt/v1") {
    throw new Error("adjustment revision row receipt mismatch");
  }
  validateRevisionCommitReceiptShape(value.revisionReceipt);
  return value as unknown as AdjustmentRevisionRowReceipt;
}

// read one persisted pointer through a closed API-role admission function
async function readRevisionAdmission<T>(
  queryable: Queryable,
  functionName: "adjustment_weather_revision_admission_v1" |
    "adjustment_forecast_anchor_revision_admission_v1" |
    "adjustment_rain_gate_revision_admission_v1" |
    "adjustment_ecmwf_temperature_revision_admission_v1",
  key: T,
): Promise<AdjustmentRevisionCommitReceipt> {
  const result = await queryable.query<JsonRow>(
    `SELECT ${functionName}($1::jsonb) AS value`,
    [JSON.stringify(key)],
  );
  const value = requireSingleJsonRow(result.rows, "adjustment revision admission");
  validateRevisionCommitReceiptShape(value);
  return value as unknown as AdjustmentRevisionCommitReceipt;
}

// validate one bounded client batch before database admission
function validateRevisionBatch<T>(
  pointers: readonly T[],
  label: string,
  validate: (pointer: T) => void,
): void {
  // reject empty, oversized, or mutable aliases at the facade edge
  if (!Array.isArray(pointers) || pointers.length < 1 || pointers.length > 4096) {
    throw new RangeError(`${label} is invalid`);
  }
  // validate every exact pointer before issuing any database call
  for (const pointer of pointers) {
    validate(pointer);
  }
  // preserve the database's four-megabyte metadata envelope
  if (Buffer.byteLength(JSON.stringify(pointers), "utf8") > 4 * 1024 * 1024) {
    throw new RangeError(`${label} exceeds the canonical byte bound`);
  }
}

// require one positive decimal database identity
function requireDecimalIdentity(value: unknown, label: string): asserts value is string {
  // reject zero, signs, whitespace, and numeric aliases
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
}

// validate one bounded server-owned registration slot projection
function validateRegistrationSlot(
  value: Record<string, unknown>,
  family: AdjustmentShadowFamily,
): void {
  requireExactObject(value, REGISTRATION_SLOT_KEYS, "adjustment registration slot");
  requireBoundedJson(value, MAX_INPUT_BYTES, "adjustment registration slot");
  requireHash(value.epochWitnessSha256, "epoch witness identity");
  requireHash(value.scheduleContractSha256, "schedule contract identity");
  requireNullableHash(value.registrationSha256, "registration identity");
  parseUtcMilliseconds(value.horizonEndAt, "registration horizon end");

  // bind occupancy fields to the requested family and one closed state
  if (value.contractVersion !== "adjustment-shadow-registration-slot/v3" ||
    value.family !== family ||
    !new Set(["busy_v2_legacy", "busy_v3", "free"]).has(value.state as string)) {
    throw new Error("adjustment registration slot contract mismatch");
  }
  // require clocks and identities together only for an occupied slot
  if (value.state === "free") {
    if (value.registrationSha256 !== null || value.terminalAt !== null) {
      throw new Error("adjustment registration free slot differs");
    }
  } else {
    requireHash(value.registrationSha256, "registration identity");
    parseUtcMilliseconds(value.terminalAt, "registration terminal time");
  }
}


// validate one value-free availability document
function validateAvailability(value: Record<string, unknown>, registrationSha256: string): void {
  requireExactObject(value, AVAILABILITY_KEYS, "adjustment availability");
  requireBoundedJson(value, MAX_AVAILABILITY_BYTES, "adjustment availability");
  // require the fixed availability contract and requested identity
  if (value.contractVersion !== "adjustment-confirmation-availability/v2" ||
    value.registrationSha256 !== registrationSha256 ||
    !isFamily(value.family) ||
    value.missingExpectedDueKeys !== null ||
    value.missingExpectedDueKeysStatus !== "requires_anchored_cold_reconstruction") {
    throw new Error("adjustment availability contract mismatch");
  }
  // validate every availability root
  for (const [candidate, label] of [
    [value.expectedKeySetSha256, "expected key set identity"],
    [value.finalizedMetadataRootSha256, "finalized metadata root"],
    [value.hotSetRootSha256, "hot set root"],
  ] as const) {
    requireHash(candidate, label);
  }
  requireInteger(value.finalizedPredictionCount, 0, Number.MAX_SAFE_INTEGER,
    "finalized prediction count");
  requireInteger(value.metadataGeneration, 0, Number.MAX_SAFE_INTEGER,
    "metadata generation");
  parseUtcMilliseconds(value.intervalStartAt, "interval start");
  parseUtcMilliseconds(value.intervalEndAt, "interval end");
  parseUtcMilliseconds(value.targetCutoffAt, "target cutoff");
  // validate an optional finalized clock
  if (value.finalizedThroughAt !== null) {
    parseUtcMilliseconds(value.finalizedThroughAt, "finalized through time");
  }
  // require one closed sorted hot projection array
  if (!Array.isArray(value.hotPredictions)) {
    throw new Error("adjustment availability hot predictions are invalid");
  }
  requireInteger(value.hotPredictionCount, 0, 8_192, "hot prediction count");
  // bind the declared count to every sorted projection
  if (value.hotPredictionCount !== value.hotPredictions.length) {
    throw new Error("adjustment availability hot prediction count differs");
  }
  let previousIdentity = "";
  // validate every sorted hot projection
  for (const prediction of value.hotPredictions) {
    requireExactObject(prediction, HOT_PREDICTION_KEYS, "hot prediction");
    requireHash(prediction.predictionSha256, "hot prediction identity");
    parseDueKey(prediction.dueKey);
    parseUtcMilliseconds(prediction.minValidAt, "hot minimum valid time");
    parseUtcMilliseconds(prediction.maxValidAt, "hot maximum valid time");
    requireInteger(prediction.rowCount, 1, FAMILY_LIMITS[value.family].rows,
      "hot prediction row count");
    // require the database's canonical identity ordering
    if (prediction.predictionSha256 <= previousIdentity) {
      throw new Error("adjustment availability hot predictions are unordered");
    }
    previousIdentity = prediction.predictionSha256;
  }
}

// validate one value-free chunk authorization
function validateAuthorization(
  value: Record<string, unknown>,
  registrationSha256: string,
  accessSha256: string,
  chunkIndex: number,
): void {
  requireExactObject(value, AUTHORIZATION_KEYS, "adjustment chunk authorization");
  requireBoundedJson(value, MAX_AUTHORIZATION_BYTES, "adjustment chunk authorization");
  // require the requested immutable authorization identity
  if (value.contractVersion !== "adjustment-confirmation-export-authorization/v2" ||
    value.registrationSha256 !== registrationSha256 || value.accessSha256 !== accessSha256 ||
    value.chunkIndex !== chunkIndex || !isFamily(value.family)) {
    throw new Error("adjustment chunk authorization contract mismatch");
  }
  const expectedChunkCount = value.family === "rain" ? 24 : 27;
  // require the family partition and exact index bound
  if (value.chunkCount !== expectedChunkCount || chunkIndex >= expectedChunkCount) {
    throw new Error("adjustment chunk authorization range mismatch");
  }
  // validate every immutable authorization root
  for (const [candidate, label] of [
    [value.eligiblePredictionSetSha256, "eligible prediction set identity"],
    [value.expectedKeySetSha256, "expected key set identity"],
    [value.metadataRootSha256, "metadata root identity"],
    [value.revisionCatalogWatermarkSha256, "revision catalog watermark"],
    [value.targetComparatorSnapshotRootSha256, "target comparator snapshot root"],
  ] as const) {
    requireHash(candidate, label);
  }
  const fromDate = parseLocalDate(value.fromLocalDate, "chunk start date");
  const toDate = parseLocalDate(value.toLocalDateExclusive, "chunk end date");
  parseUtcMilliseconds(value.targetCutoffAt, "target cutoff");
  // require a nonempty bounded local-date range
  if (toDate <= fromDate || toDate - fromDate > 14 * 24 * HOUR_MS) {
    throw new Error("adjustment chunk authorization dates are invalid");
  }
}

// require one exact JSON object
function requireExactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  // reject arrays, null, aliases, and missing keys
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw new RangeError(`${label} is not a closed object`);
  }
}

// encode one flat closed object with sorted keys
function canonicalFlatJson(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): string {
  const canonical = JSON.stringify(Object.fromEntries(
    [...keys].sort().map((key) => [key, value[key]]),
  ));
  // enforce the fixed canonical input envelope
  if (Buffer.byteLength(canonical, "utf8") > MAX_INPUT_BYTES) {
    throw new RangeError(`${label} exceeds the canonical byte bound`);
  }
  return canonical;
}

// require one lowercase SHA-256 identity
function requireHash(value: unknown, label: string): asserts value is string {
  // reject aliases and non-string identities
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new RangeError(`${label} is invalid`);
  }
}

// require one nullable lowercase SHA-256 identity
function requireNullableHash(value: unknown, label: string): asserts value is string | null {
  // reject undefined and non-hash aliases while retaining explicit absence
  if (value !== null) {
    requireHash(value, label);
  }
}

// parse one canonical millisecond UTC instant
function parseUtcMilliseconds(value: unknown, label: string): number {
  // reject offsets, normalized aliases, and invalid calendar clocks
  if (typeof value !== "string" || !UTC_MILLISECOND_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError(`${label} is not canonical UTC milliseconds`);
  }
  return Date.parse(value);
}

// parse one fixed cycle due key
function parseDueKey(value: unknown): number {
  // reject non-cycle and noncanonical due identities
  if (typeof value !== "string" || !DUE_KEY_PATTERN.test(value)) {
    throw new RangeError("adjustment due key is invalid");
  }
  return parseUtcMilliseconds(value.slice("capture/".length), "adjustment due time");
}

// parse one exact local calendar date
function parseLocalDate(value: unknown, label: string): number {
  // reject normalized aliases and invalid calendar dates
  if (typeof value !== "string" || !LOCAL_DATE_PATTERN.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${label} is invalid`);
  }
  return Date.parse(`${value}T00:00:00.000Z`);
}

// require one bounded integer
function requireInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  // reject fractions, unsafe integers, and out-of-range counts
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
}

// require one known adjustment family
function isFamily(value: unknown): value is AdjustmentShadowFamily {
  return value === "temperature" || value === "wind" || value === "rain";
}

// require one bounded JSON result
function requireBoundedJson(value: Record<string, unknown>, maximum: number, label: string): void {
  // reject oversized server receipts before returning them
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) {
    throw new Error(`${label} exceeds its server receipt bound`);
  }
}

// require one JSON result row
function requireSingleJsonRow(rows: readonly JsonRow[], label: string): Record<string, unknown> {
  const value = rows[0]?.value;
  // reject missing, duplicate, scalar, or array results
  if (rows.length !== 1 || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} contract mismatch`);
  }
  return value as Record<string, unknown>;
}
