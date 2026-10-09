import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";

import { canonicalObjectSha256 } from "./candidate.js";
import {
  decodeMaintenanceBinary64,
  encodeMaintenanceBinary64,
  type MaintenanceShadowTemperatureRecentErrorState,
} from "./maintenance-shadow-values.js";

export const ADJUSTMENT_REVISION_PROJECTION_VERSION =
  "adjustment-revision-projection/v1" as const;
export const ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION =
  "adjustment-revision-batch-projection/v2" as const;
export const ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION =
  "adjustment-temperature-native-source-projection/v2" as const;
export const ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION =
  "adjustment-rain-gate-feature-projection/v2" as const;
export const ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION =
  "adjustment-rain-gate-control-projection/v3" as const;
export const RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION =
  "rain-maintenance-persistence-target/v1" as const;
export const ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT =
  "96e4365f74a0fb8694944172b73a65c29d89a68ddf86b1b0a50db38bb39d52aa" as const;

const HASH = /^[a-f0-9]{64}$/u;
const TOP_KEYS = ["contractVersion", "family", "logicalKey", "logicalReceivedAt",
  "projectionKind", "rows", "source", "storedContentSha256"] as const;
const TEMPERATURE_NATIVE_TOP_KEYS = ["contractVersion", "family", "logicalKey",
  "logicalReceivedAt", "projectionKind", "recentErrorState", "recentErrorStateSha256",
  "rows", "source", "storedContentSha256"] as const;
const TEMPERATURE_RECENT_STATE_KEYS = ["b24C", "b72C", "cohort", "localDates", "mad72C",
  "maximumSourceRunInitializedAt", "maximumSourceValidAt", "n24", "n72", "sourceKeys",
  "supported", "targetRunInitializedAt", "windowEndValidAt"] as const;
const SOURCE_KEYS = ["adapterVersion", "contractEpoch", "dataset", "providerKey",
  "sourceConfigFingerprint", "sourceId", "sourceKey", "sourceKind", "upstreamModel"] as const;
const LOGICAL_KEY_KEYS = Object.freeze({
  actual_best_match: ["productRunAt", "sourceId", "sourceKind", "validAt"],
  native_source: ["contentSha256", "leadHours", "providerResponseSha256", "runInitializedAt",
    "siteId", "sourceId", "sourceType", "validAt"],
  rain_gate_input: ["inputSha256", "modelSha256", "runInitializedAt"],
  target_revision: ["productRunAt", "sourceId", "sourceKind", "validAt"],
});
const WEATHER_ROW_KEYS = ["apparentTemperatureC64", "blackGlobeTemperatureC64", "cloudCoverPercent64",
  "contentSha256", "pm25MicrogramsPerCubicMeter64", "precipitationMm64", "precipitationRateMmPerHour64",
  "pressureHpa64", "relativeHumidityPercent64", "soilElectricalConductivityMicrosiemensPerCm64",
  "soilMoisturePercent64", "solarRadiationWm264", "temperatureC64", "uvIndex64", "validAt", "waterLevelM64",
  "wetBulbGlobeTemperatureC64", "windDirectionDegrees64", "windGustMps64", "windSpeedMps64"] as const;
const ANCHOR_ROW_KEYS = ["apparentTemperatureC64", "cloudCoverPercent64", "contentSha256", "leadHours",
  "precipitationMm64", "pressureHpa64", "relativeHumidityPercent64", "temperatureC64", "validAt",
  "windDirectionDegrees64", "windGustMps64", "windSpeedMps64"] as const;
const TEMPERATURE_ROW_KEYS = ["bestMatchContentSha256", "bestMatchProductRunAt",
  "bestMatchSourceId", "bestMatchTemperatureC64", "contentSha256", "modelCycle",
  "modelLeadHours", "rawRelativeHumidityPercent64", "rawTemperatureC64",
  "rawWindSpeedMps64", "validAt"] as const;
const RAIN_GATE_ROW_KEYS = ["applied", "correctedPrecipitationMm64", "modelLeadHours",
  "rawPrecipitationMm64", "reasonCode", "validAt"] as const;
const RAIN_GATE_FEATURE_ROW_KEYS = ["features64", "modelLeadHours", "rawPrecipitationMm64",
  "rawTargetHourTemperatureC64", "validAt"] as const;
const RAIN_CONTROL_TOP_KEYS = ["contractVersion", "family", "logicalKey", "logicalReceivedAt",
  "ordinalArtifactSha256", "persistenceTarget", "projectionKind", "rows", "source", "stateSha256",
  "stateStageReceiptSha256", "storedContentSha256"] as const;
const RAIN_CONTROL_ROW_KEYS = ["features64", "incumbentArtifactIdentitySha256", "incumbentPrediction64",
  "incumbentProbability", "incumbentReceiptMemberSha256", "modelLeadHours", "nativeSourceProbability",
  "persistencePrediction64", "persistenceReason", "persistenceTargetMemberSha256", "rawPrecipitationMm64",
  "rawTargetHourTemperatureC64", "recentVolumeScalePrediction64", "sameWindowVolumeScalePrediction64",
  "sourceRowSha256", "unchangedOrdinalPrediction64", "validAt", "volumeScalePrediction64"] as const;
const PROBABILITY_KEYS = ["atLeast0_1", "atLeast1_0", "atLeast2_5"] as const;
const PERSISTENCE_TARGET_KEYS = ["contractVersion", "decisionAt", "prediction64", "reason", "rowCount",
  "rows", "targetMemberSha256", "validAt"] as const;
const PERSISTENCE_TARGET_ROW_KEYS = ["captureMembers", "precipitationMm64", "receivedAt", "stationId"] as const;
const PERSISTENCE_CAPTURE_KEYS = ["bodySha256", "claimId", "completedAt"] as const;
const FAMILY_LIMITS = Object.freeze({ rain: 128 * 1_024, shared: 768 * 1_024,
  temperature: 64 * 1_024, wind: 768 * 1_024 });

export type AdjustmentRevisionProjectionKind =
  | "actual_best_match"
  | "native_source"
  | "rain_gate_input"
  | "target_revision";
export type AdjustmentRevisionProjectionFamily = "rain" | "shared" | "temperature" | "wind";

// retain only closed database-backed revision projection fields
export interface AdjustmentRevisionProjection {
  readonly contractVersion: typeof ADJUSTMENT_REVISION_PROJECTION_VERSION;
  readonly family: AdjustmentRevisionProjectionFamily;
  readonly logicalKey: Readonly<Record<string, string | number | null>>;
  readonly logicalReceivedAt: string;
  readonly projectionKind: AdjustmentRevisionProjectionKind;
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  readonly source: Readonly<Record<string, string | null>>;
  readonly storedContentSha256: string;
}

// retain one grouped same-source weather revision body
export interface AdjustmentRevisionBatchProjection {
  readonly contractVersion: typeof ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION;
  readonly family: "shared" | "wind";
  readonly logicalKey: Readonly<Record<string, string | number | null>>;
  readonly logicalReceivedAt: string;
  readonly projectionKind: "actual_best_match" | "target_revision";
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  readonly source: Readonly<Record<string, string | null>>;
  readonly storedContentSha256: string;
}

// retain the source-decision-frozen rolling state with its complete native run
export interface AdjustmentTemperatureNativeSourceProjection {
  readonly contractVersion: typeof ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION;
  readonly family: "temperature";
  readonly logicalKey: AdjustmentRevisionProjection["logicalKey"];
  readonly logicalReceivedAt: string;
  readonly projectionKind: "native_source";
  readonly recentErrorState: MaintenanceShadowTemperatureRecentErrorState;
  readonly recentErrorStateSha256: string;
  readonly rows: AdjustmentRevisionProjection["rows"];
  readonly source: AdjustmentRevisionProjection["source"];
  readonly storedContentSha256: string;
}

// retain the exact pre-fit numerical rain rows on the existing gate receipt
export interface AdjustmentRainGateFeatureProjection {
  readonly contractVersion: typeof ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION;
  readonly family: "rain";
  readonly logicalKey: Readonly<{
    inputSha256: string;
    modelSha256: string;
    runInitializedAt: string;
  }>;
  readonly logicalReceivedAt: string;
  readonly projectionKind: "rain_gate_input";
  readonly rows: readonly Readonly<{
    features64: readonly (string | null)[];
    modelLeadHours: number;
    rawPrecipitationMm64: string;
    rawTargetHourTemperatureC64: string;
    validAt: string;
  }>[];
  readonly source: Readonly<Record<string, string | null>>;
  readonly storedContentSha256: string;
}

// retain one complete causal prior-hour network target member
export interface RainMaintenancePersistenceCaptureMember {
  readonly bodySha256: string;
  readonly claimId: string;
  readonly completedAt: string;
}

export interface RainMaintenancePersistenceTargetRow {
  readonly captureMembers: readonly RainMaintenancePersistenceCaptureMember[];
  readonly precipitationMm64: string | null;
  readonly receivedAt: string | null;
  readonly stationId: number;
}

export interface RainMaintenancePersistenceTarget {
  readonly contractVersion: typeof RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION;
  readonly decisionAt: string;
  readonly prediction64: string | null;
  readonly reason: "causal_target" | "raw_fallback_unavailable";
  readonly rowCount: 12;
  readonly rows: readonly RainMaintenancePersistenceTargetRow[];
  readonly targetMemberSha256: string;
  readonly validAt: string;
}

// retain the feature graph and all pre-target policy controls on one gate receipt
export interface AdjustmentRainGateControlProjection {
  readonly contractVersion: typeof ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION;
  readonly family: "rain";
  readonly logicalKey: Readonly<{
    inputSha256: string;
    modelSha256: string;
    runInitializedAt: string;
  }>;
  readonly logicalReceivedAt: string;
  readonly ordinalArtifactSha256: string;
  readonly persistenceTarget: RainMaintenancePersistenceTarget;
  readonly projectionKind: "rain_gate_input";
  readonly rows: readonly Readonly<{
    features64: readonly (string | null)[];
    incumbentArtifactIdentitySha256: string | null;
    incumbentPrediction64: string;
    incumbentProbability: Readonly<Record<"atLeast0_1" | "atLeast1_0" | "atLeast2_5", string>>;
    incumbentReceiptMemberSha256: string;
    modelLeadHours: number;
    nativeSourceProbability: Readonly<Record<"atLeast0_1" | "atLeast1_0" | "atLeast2_5", string>>;
    persistencePrediction64: string;
    persistenceReason: "causal_target" | "raw_fallback_unavailable";
    persistenceTargetMemberSha256: string | null;
    rawPrecipitationMm64: string;
    rawTargetHourTemperatureC64: string;
    recentVolumeScalePrediction64: string;
    sameWindowVolumeScalePrediction64: string;
    sourceRowSha256: string;
    unchangedOrdinalPrediction64: string;
    validAt: string;
    volumeScalePrediction64: string;
  }>[];
  readonly source: Readonly<Record<string, string | null>>;
  readonly stateSha256: string;
  readonly stateStageReceiptSha256: string;
  readonly storedContentSha256: string;
}

export type AdjustmentRevisionProjectionDocument =
  | AdjustmentRevisionProjection
  | AdjustmentRevisionBatchProjection
  | AdjustmentTemperatureNativeSourceProjection
  | AdjustmentRainGateFeatureProjection
  | AdjustmentRainGateControlProjection;

// encode one closed canonical revision projection before archive staging
export function encodeAdjustmentRevisionProjection(value: AdjustmentRevisionProjection): Buffer {
  validateAdjustmentRevisionProjection(value);
  return encodeRevisionProjectionDocument(value);
}

// encode one grouped same-source weather revision before archive staging
export function encodeAdjustmentRevisionBatchProjection(
  value: AdjustmentRevisionBatchProjection,
): Buffer {
  validateAdjustmentRevisionBatchProjection(value);
  return encodeRevisionProjectionDocument(value);
}

// encode one complete native temperature run and its source-decision state
export function encodeAdjustmentTemperatureNativeSourceProjection(
  value: AdjustmentTemperatureNativeSourceProjection,
): Buffer {
  validateAdjustmentTemperatureNativeSourceProjection(value);
  const logicalKey = value.logicalKey as Readonly<Record<string, unknown>>;
  const ordered = Object.fromEntries(TEMPERATURE_NATIVE_TOP_KEYS.map((key) => [key,
    key === "logicalKey"
      ? Object.fromEntries(LOGICAL_KEY_KEYS.native_source.map((field) => [field, logicalKey[field]]))
      : key === "recentErrorState"
        ? Object.fromEntries(TEMPERATURE_RECENT_STATE_KEYS.map((field) =>
            [field, value.recentErrorState[field]]))
        : key === "rows"
          ? value.rows.map((row) => Object.fromEntries(TEMPERATURE_ROW_KEYS.map(
              (field) => [field, row[field]],
            )))
          : key === "source"
            ? Object.fromEntries(SOURCE_KEYS.map((field) => [field, value.source[field]]))
            : value[key],
  ]));
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
  if (bytes.byteLength > FAMILY_LIMITS.temperature) {
    throw new RangeError("adjustment temperature native projection exceeds its family cap");
  }
  return bytes;
}

// encode one complete pre-fit rain feature body before archive staging
export function encodeAdjustmentRainGateFeatureProjection(
  value: AdjustmentRainGateFeatureProjection,
): Buffer {
  validateAdjustmentRainGateFeatureProjection(value);
  return encodeRevisionProjectionDocument(value);
}

// encode one complete pre-target control body after state durability
export function encodeAdjustmentRainGateControlProjection(
  value: AdjustmentRainGateControlProjection,
): Buffer {
  validateAdjustmentRainGateControlProjection(value);
  const logicalKey = value.logicalKey as Readonly<Record<string, unknown>>;
  const ordered = Object.fromEntries(RAIN_CONTROL_TOP_KEYS.map((key) => [key,
    key === "logicalKey"
      ? Object.fromEntries(LOGICAL_KEY_KEYS.rain_gate_input.map((field) => [field, logicalKey[field]]))
      : key === "rows"
        ? value.rows.map((row) => Object.fromEntries(RAIN_CONTROL_ROW_KEYS.map((field) => [field,
            field === "incumbentProbability" || field === "nativeSourceProbability"
              ? Object.fromEntries(PROBABILITY_KEYS.map((name) => [name, row[field][name]]))
              : row[field],
          ])))
        : key === "source"
          ? Object.fromEntries(SOURCE_KEYS.map((field) => [field, value.source[field]]))
          : key === "persistenceTarget"
            ? orderedPersistenceTarget(value.persistenceTarget)
            : value[key],
  ]));
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
  // preserve the existing bounded rain payload ceiling
  if (bytes.byteLength > FAMILY_LIMITS.rain) {
    throw new RangeError("adjustment rain control projection exceeds its family cap");
  }
  return bytes;
}

// serialize one already-validated projection document canonically
function encodeRevisionProjectionDocument(value: AdjustmentRevisionProjectionDocument): Buffer {
  const rowKeys = revisionRowKeys(value);
  const logicalKey = value.logicalKey as Readonly<Record<string, unknown>>;
  const ordered = Object.fromEntries(TOP_KEYS.map((key) => [key,
    key === "logicalKey"
      ? Object.fromEntries(LOGICAL_KEY_KEYS[value.projectionKind].map((field) => [field, logicalKey[field]]))
      : key === "rows"
        ? value.rows.map((row) => {
            const record = row as Readonly<Record<string, unknown>>;
            return Object.fromEntries(rowKeys.map((field) => [field, record[field]]));
          })
        : key === "source"
          ? Object.fromEntries(SOURCE_KEYS.map((field) => [field, value.source[field]]))
          : value[key],
  ]));
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
  // enforce the family-specific admission cap before transport
  if (bytes.byteLength > FAMILY_LIMITS[value.family]) {
    throw new RangeError("adjustment revision projection exceeds its family cap");
  }
  return bytes;
}

// parse only the one canonical byte representation
export function parseAdjustmentRevisionProjection(bytes: Uint8Array): AdjustmentRevisionProjection {
  // cap hostile inputs before decoding
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > FAMILY_LIMITS.wind) {
    throw new RangeError("adjustment revision projection size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as AdjustmentRevisionProjection;
  const canonical = encodeAdjustmentRevisionProjection(value);
  // refuse whitespace, order, duplicate-key and number aliases
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("adjustment revision projection is not canonical");
  }
  return value;
}

// parse only the canonical grouped weather byte representation
export function parseAdjustmentRevisionBatchProjection(
  bytes: Uint8Array,
): AdjustmentRevisionBatchProjection {
  // cap hostile inputs before decoding
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > FAMILY_LIMITS.wind) {
    throw new RangeError("adjustment revision batch projection size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    AdjustmentRevisionBatchProjection;
  const canonical = encodeAdjustmentRevisionBatchProjection(value);
  // refuse whitespace, order, duplicate-key and number aliases
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("adjustment revision batch projection is not canonical");
  }
  return value;
}

// parse only the canonical temperature native source and state representation
export function parseAdjustmentTemperatureNativeSourceProjection(
  bytes: Uint8Array,
): AdjustmentTemperatureNativeSourceProjection {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
      bytes.byteLength > FAMILY_LIMITS.temperature) {
    throw new RangeError("adjustment temperature native projection size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    AdjustmentTemperatureNativeSourceProjection;
  const canonical = encodeAdjustmentTemperatureNativeSourceProjection(value);
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("adjustment temperature native projection is not canonical");
  }
  return value;
}

// parse only the canonical pre-fit rain feature representation
export function parseAdjustmentRainGateFeatureProjection(
  bytes: Uint8Array,
): AdjustmentRainGateFeatureProjection {
  // cap hostile inputs before decoding feature arrays
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
      bytes.byteLength > FAMILY_LIMITS.rain) {
    throw new RangeError("adjustment rain feature projection size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    AdjustmentRainGateFeatureProjection;
  const canonical = encodeAdjustmentRainGateFeatureProjection(value);
  // refuse whitespace, order and binary64 aliases
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("adjustment rain feature projection is not canonical");
  }
  return value;
}

// parse only the canonical pre-target control representation
export function parseAdjustmentRainGateControlProjection(
  bytes: Uint8Array,
): AdjustmentRainGateControlProjection {
  // cap hostile inputs before decoding nested feature arrays
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
      bytes.byteLength > FAMILY_LIMITS.rain) {
    throw new RangeError("adjustment rain control projection size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    AdjustmentRainGateControlProjection;
  const canonical = encodeAdjustmentRainGateControlProjection(value);
  // refuse whitespace, order and binary64 aliases
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("adjustment rain control projection is not canonical");
  }
  return value;
}

// parse either reviewed projection contract without weakening v1
export function parseAdjustmentRevisionProjectionDocument(
  bytes: Uint8Array,
): AdjustmentRevisionProjectionDocument {
  // select the contract from bounded canonical json before full validation
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > FAMILY_LIMITS.wind) {
    throw new RangeError("adjustment revision projection size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    Readonly<{ contractVersion?: unknown }>;
  // keep legacy parsing exact while admitting only the additive batch contract
  if (value.contractVersion === ADJUSTMENT_REVISION_PROJECTION_VERSION) {
    return parseAdjustmentRevisionProjection(bytes);
  }
  if (value.contractVersion === ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION) {
    return parseAdjustmentRevisionBatchProjection(bytes);
  }
  if (value.contractVersion === ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION) {
    return parseAdjustmentTemperatureNativeSourceProjection(bytes);
  }
  if (value.contractVersion === ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION) {
    return parseAdjustmentRainGateFeatureProjection(bytes);
  }
  if (value.contractVersion === ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION) {
    return parseAdjustmentRainGateControlProjection(bytes);
  }
  throw new RangeError("adjustment revision projection contract is invalid");
}

// hash the entire canonical body as the archive projection identity
export function adjustmentRevisionProjectionIdentity(bytes: Uint8Array): string {
  parseAdjustmentRevisionProjectionDocument(bytes);
  return createHash("sha256").update(bytes).digest("hex");
}

// hash only the canonical ordered value rows for database and archive crossbinding
export function adjustmentRevisionProjectionSha256(bytes: Uint8Array): string {
  return adjustmentRevisionProjectionIdentity(bytes);
}

// hash one exact database logical key even when body encoding later fails
export function adjustmentRevisionLogicalKeySha256(
  projectionKind: AdjustmentRevisionProjectionKind,
  logicalKey: AdjustmentRevisionProjection["logicalKey"],
): string {
  // admit only the closed key grammar for its database relation
  if (!Object.hasOwn(LOGICAL_KEY_KEYS, projectionKind)) {
    throw new RangeError("adjustment revision projection kind is invalid");
  }
  exactKeys(logicalKey, LOGICAL_KEY_KEYS[projectionKind]);
  validateLogicalKey(logicalKey, projectionKind);
  const ordered = Object.fromEntries(LOGICAL_KEY_KEYS[projectionKind].map(
    // preserve the frozen per-kind database key order
    (field) => [field, logicalKey[field]],
  ));
  return createHash("sha256").update(JSON.stringify(ordered) + "\n").digest("hex");
}

// validate every closed logical, lineage and value field
export function validateAdjustmentRevisionProjection(value: AdjustmentRevisionProjection): void {
  exactKeys(value, TOP_KEYS);
  // restrict every top-level discriminator and clock
  if (value.contractVersion !== ADJUSTMENT_REVISION_PROJECTION_VERSION ||
      !Object.hasOwn(LOGICAL_KEY_KEYS, value.projectionKind) ||
      !Object.hasOwn(FAMILY_LIMITS, value.family)) {
    throw new RangeError("adjustment revision projection contract is invalid");
  }
  requireInstant(value.logicalReceivedAt);
  requireHash(value.storedContentSha256);
  exactKeys(value.logicalKey, LOGICAL_KEY_KEYS[value.projectionKind]);
  exactKeys(value.source, SOURCE_KEYS);
  validateSource(value.source, value.projectionKind);
  validateLogicalKey(value.logicalKey, value.projectionKind);
  const rowKeys = revisionRowKeys(value);
  const expectedRows = expectedRowCount(value);
  // require one complete immutable serving projection
  if (!Array.isArray(value.rows) || value.rows.length !== expectedRows) {
    throw new RangeError("adjustment revision projection geometry is invalid");
  }
  let previousValidAt: string | null = null;
  // validate every ordered normalized value without decimal ambiguity
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, rowKeys);
    requireInstant(row.validAt);
    // preserve hourly multirow geometry for complete native and rain runs
    if (previousValidAt !== null && expectedRows > 1 &&
        Date.parse(String(row.validAt)) - Date.parse(previousValidAt) !== 3_600_000) {
      throw new RangeError("adjustment revision projection rows are not consecutive");
    }
    previousValidAt = String(row.validAt);
    validateRevisionRow(value, row, index);
  }
  // cross-bind stored content and logical geometry to the projected database rows
  validateStoredProjectionBinding(value);
}

// validate one complete grouped weather revision body
export function validateAdjustmentRevisionBatchProjection(
  value: AdjustmentRevisionBatchProjection,
): void {
  exactKeys(value, TOP_KEYS);
  // restrict the additive contract to grouped comparator or target weather rows
  if (value.contractVersion !== ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION ||
      !["actual_best_match", "target_revision"].includes(value.projectionKind) ||
      (value.projectionKind === "actual_best_match" ? value.family !== "wind" : value.family !== "shared")) {
    throw new RangeError("adjustment revision batch projection contract is invalid");
  }
  requireInstant(value.logicalReceivedAt);
  requireHash(value.storedContentSha256);
  exactKeys(value.logicalKey, LOGICAL_KEY_KEYS[value.projectionKind]);
  exactKeys(value.source, SOURCE_KEYS);
  validateSource(value.source, value.projectionKind);
  validateLogicalKey(value.logicalKey, value.projectionKind);
  // bind every row to one source and one exact model-run lineage
  if (value.source.sourceId !== value.logicalKey.sourceId ||
      (value.projectionKind === "actual_best_match" &&
        (value.source.dataset !== "best_match" || value.source.upstreamModel !== "best_match"))) {
    throw new RangeError("adjustment revision batch source differs");
  }
  // retain one bounded complete causal geometry per staged body
  if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 168) {
    throw new RangeError("adjustment revision batch geometry is invalid");
  }
  let previousValidAt: string | null = null;
  for (const row of value.rows) {
    exactKeys(row, WEATHER_ROW_KEYS);
    requireInstant(row.validAt);
    requireHash(row.contentSha256);
    const elapsed = previousValidAt === null
      ? null
      : Date.parse(String(row.validAt)) - Date.parse(previousValidAt);
    // require hourly forecast geometry and strictly ordered physical samples
    if (elapsed !== null && (elapsed <= 0 ||
        (value.projectionKind === "actual_best_match" && elapsed !== 3_600_000))) {
      throw new RangeError("adjustment revision batch rows are not ordered");
    }
    previousValidAt = String(row.validAt);
    for (const [field, fieldValue] of Object.entries(row)) {
      // validate every metric through the frozen binary64 grammar
      if (field.endsWith("64")) {
        requireBinary64(fieldValue, true);
      }
    }
  }
  const first = value.rows[0]!;
  // bind the header key and content identity to the first ordered row
  if (first.contentSha256 !== value.storedContentSha256 ||
      first.validAt !== value.logicalKey.validAt) {
    throw new RangeError("adjustment revision batch stored content differs");
  }
}

// validate one source-decision-frozen temperature state against its run body
export function validateAdjustmentTemperatureNativeSourceProjection(
  value: AdjustmentTemperatureNativeSourceProjection,
): void {
  exactKeys(value, TEMPERATURE_NATIVE_TOP_KEYS);
  if (value.contractVersion !== ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION ||
      value.family !== "temperature" || value.projectionKind !== "native_source") {
    throw new RangeError("adjustment temperature native projection contract is invalid");
  }
  const common: AdjustmentRevisionProjection = {
    contractVersion: ADJUSTMENT_REVISION_PROJECTION_VERSION,
    family: value.family,
    logicalKey: value.logicalKey,
    logicalReceivedAt: value.logicalReceivedAt,
    projectionKind: value.projectionKind,
    rows: value.rows,
    source: value.source,
    storedContentSha256: value.storedContentSha256,
  };
  validateAdjustmentRevisionProjection(common);
  exactKeys(value.recentErrorState, TEMPERATURE_RECENT_STATE_KEYS);
  requireHash(value.recentErrorStateSha256);
  const state = value.recentErrorState;
  requireInstant(state.targetRunInitializedAt);
  requireInstant(state.windowEndValidAt);
  for (const clock of [state.maximumSourceRunInitializedAt, state.maximumSourceValidAt]) {
    if (clock !== null) {
      requireInstant(clock);
    }
  }
  if (state.cohort !== "ecmwf_single_run_hindcast" ||
      state.targetRunInitializedAt !== value.logicalKey.runInitializedAt ||
      Date.parse(state.windowEndValidAt) !== Date.parse(state.targetRunInitializedAt) - 7 * 3_600_000 ||
      !Number.isSafeInteger(state.n24) || state.n24 < 0 || state.n24 > 24 ||
      !Number.isSafeInteger(state.n72) || state.n72 < state.n24 || state.n72 > 72 ||
      !Number.isSafeInteger(state.localDates) || state.localDates < 0 ||
      state.localDates > state.n72 || !Array.isArray(state.sourceKeys) ||
      state.sourceKeys.length !== state.n72 ||
      new Set(state.sourceKeys).size !== state.sourceKeys.length) {
    throw new RangeError("adjustment temperature recent-error state differs");
  }
  for (const key of state.sourceKeys) {
    if (typeof key !== "string" || key.length < 1 || key.length > 128) {
      throw new RangeError("adjustment temperature recent-error source differs");
    }
  }
  for (const statistic of [state.b24C, state.b72C, state.mad72C]) {
    if (statistic !== null && (!Number.isFinite(statistic) || Math.abs(statistic) > 6)) {
      throw new RangeError("adjustment temperature recent-error statistic differs");
    }
  }
  const orderedState = Object.fromEntries(TEMPERATURE_RECENT_STATE_KEYS.map(
    // preserve the database's fixed-order state hash preimage without an added newline
    (key) => [key, state[key]],
  ));
  if (createHash("sha256").update(JSON.stringify(orderedState)).digest("hex") !==
      value.recentErrorStateSha256) {
    throw new RangeError("adjustment temperature recent-error identity differs");
  }
}

// validate one complete pre-fit rain feature projection
export function validateAdjustmentRainGateFeatureProjection(
  value: AdjustmentRainGateFeatureProjection,
): void {
  exactKeys(value, TOP_KEYS);
  // keep the additive grammar on the existing rain gate receipt class
  if (value.contractVersion !== ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION ||
      value.family !== "rain" || value.projectionKind !== "rain_gate_input") {
    throw new RangeError("adjustment rain feature projection contract is invalid");
  }
  requireInstant(value.logicalReceivedAt);
  requireHash(value.storedContentSha256);
  exactKeys(value.logicalKey, LOGICAL_KEY_KEYS.rain_gate_input);
  validateLogicalKey(value.logicalKey, "rain_gate_input");
  exactKeys(value.source, SOURCE_KEYS);
  validateRainFeatureSource(value.source);
  // retain the full native 23-hour training geometry
  if (!Array.isArray(value.rows) || value.rows.length !== 23) {
    throw new RangeError("adjustment rain feature projection geometry is invalid");
  }
  const initializedAt = Date.parse(value.logicalKey.runInitializedAt);
  // validate every feature vector and its exact native source target
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, RAIN_GATE_FEATURE_ROW_KEYS);
    requireInstant(row.validAt);
    requireBinary64(row.rawPrecipitationMm64, false);
    requireBinary64(row.rawTargetHourTemperatureC64, false);
    const expectedLead = index + 9;
    // bind one-based serving lead geometry to the model-run key
    if (row.modelLeadHours !== expectedLead ||
        Date.parse(row.validAt) !== initializedAt + expectedLead * 3_600_000 ||
        !Array.isArray(row.features64) || row.features64.length !== 107) {
      throw new RangeError("adjustment rain feature projection row differs");
    }
    // retain missing predictors as explicit nulls and finite values as binary64
    for (const feature of row.features64) {
      requireBinary64(feature, true);
    }
    if (decodeMaintenanceBinary64(row.rawPrecipitationMm64) < 0) {
      throw new RangeError("adjustment rain feature source amount differs");
    }
  }
}

// validate one complete pre-target rain control projection
export function validateAdjustmentRainGateControlProjection(
  value: AdjustmentRainGateControlProjection,
): void {
  exactKeys(value, RAIN_CONTROL_TOP_KEYS);
  // keep the new grammar on the existing rain gate receipt class
  if (value.contractVersion !== ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION ||
      value.family !== "rain" || value.projectionKind !== "rain_gate_input") {
    throw new RangeError("adjustment rain control projection contract is invalid");
  }
  requireInstant(value.logicalReceivedAt);
  for (const hash of [value.ordinalArtifactSha256, value.stateSha256,
    value.stateStageReceiptSha256, value.storedContentSha256]) {
    requireHash(hash);
  }
  exactKeys(value.logicalKey, LOGICAL_KEY_KEYS.rain_gate_input);
  validateLogicalKey(value.logicalKey, "rain_gate_input");
  exactKeys(value.source, SOURCE_KEYS);
  validateRainFeatureSource(value.source);
  validateRainMaintenancePersistenceTarget(value.persistenceTarget);
  // retain the full native 23-hour training and control geometry
  if (!Array.isArray(value.rows) || value.rows.length !== 23) {
    throw new RangeError("adjustment rain control projection geometry is invalid");
  }
  const initializedAt = Date.parse(value.logicalKey.runInitializedAt);
  let artifactIdentity: string | null | undefined;
  let receiptIdentity: string | undefined;
  // validate every exact control and serving-comparator row
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, RAIN_CONTROL_ROW_KEYS);
    exactKeys(row.incumbentProbability, PROBABILITY_KEYS);
    exactKeys(row.nativeSourceProbability, PROBABILITY_KEYS);
    requireInstant(row.validAt);
    for (const field of ["incumbentPrediction64", "persistencePrediction64",
      "rawPrecipitationMm64", "rawTargetHourTemperatureC64", "recentVolumeScalePrediction64",
      "sameWindowVolumeScalePrediction64", "unchangedOrdinalPrediction64",
      "volumeScalePrediction64"] as const) {
      requireBinary64(row[field], false);
    }
    validateProbability(row.incumbentProbability);
    validateProbability(row.nativeSourceProbability);
    requireHash(row.incumbentReceiptMemberSha256);
    requireHash(row.sourceRowSha256);
    if (row.incumbentArtifactIdentitySha256 !== null) {
      requireHash(row.incumbentArtifactIdentitySha256);
    }
    const expectedLead = index + 9;
    // bind every control to the same actual native source row
    if (row.modelLeadHours !== expectedLead ||
        Date.parse(row.validAt) !== initializedAt + expectedLead * 3_600_000 ||
        !Array.isArray(row.features64) || row.features64.length !== 107 ||
        row.sourceRowSha256 !== adjustmentRainGateFeatureRowSha256(value.logicalKey, row)) {
      throw new RangeError("adjustment rain control projection row differs");
    }
    for (const feature of row.features64) {
      requireBinary64(feature, true);
    }
    validateRainControlValues(row, value.persistenceTarget);
    // one projection cannot mix incumbent serving authorities
    if (index === 0) {
      artifactIdentity = row.incumbentArtifactIdentitySha256;
      receiptIdentity = row.incumbentReceiptMemberSha256;
    }
    if (artifactIdentity !== row.incumbentArtifactIdentitySha256 ||
        receiptIdentity !== row.incumbentReceiptMemberSha256) {
      throw new RangeError("adjustment rain incumbent authority differs");
    }
  }
}

// hash one feature source row independently of later controls
export function adjustmentRainGateFeatureRowSha256(
  logicalKey: AdjustmentRainGateControlProjection["logicalKey"],
  row: Pick<AdjustmentRainGateControlProjection["rows"][number],
    "features64" | "modelLeadHours" | "rawPrecipitationMm64" |
    "rawTargetHourTemperatureC64" | "validAt">,
): string {
  exactKeys(logicalKey, LOGICAL_KEY_KEYS.rain_gate_input);
  validateLogicalKey(logicalKey, "rain_gate_input");
  const orderedRow = Object.fromEntries(RAIN_GATE_FEATURE_ROW_KEYS.map((key) => [key, row[key]]));
  const logicalRecord = logicalKey as Readonly<Record<string, unknown>>;
  const orderedKey = Object.fromEntries(LOGICAL_KEY_KEYS.rain_gate_input.map(
    // preserve the existing rain gate key order
    (key) => [key, logicalRecord[key]],
  ));
  return createHash("sha256").update("adjustment-rain-gate-feature-row/v2\n")
    .update(JSON.stringify(orderedKey) + "\n")
    .update(JSON.stringify(orderedRow) + "\n").digest("hex");
}

// construct one causal prior-hour network member in fixed station order
export function createRainMaintenancePersistenceTarget(input: Readonly<{
  decisionAt: string;
  rows: readonly Readonly<{
    captureMembers: readonly RainMaintenancePersistenceCaptureMember[];
    precipitationMm: number | null;
    receivedAt: string | null;
    stationId: number;
  }>[];
}>): RainMaintenancePersistenceTarget {
  requireInstant(input.decisionAt);
  const rowsByStation = new Map(input.rows.map((row) => [row.stationId, row]));
  // reject missing or duplicate station evidence before fixing catalog order
  if (input.rows.length !== RAIN_COLLECTION_STATIONS.length ||
      rowsByStation.size !== RAIN_COLLECTION_STATIONS.length) {
    throw new RangeError("rain persistence target station set differs");
  }
  const rows = RAIN_COLLECTION_STATIONS.map((station) => {
    const row = rowsByStation.get(station.locationId);
    // require one explicit row for every retained station
    if (row === undefined) {
      throw new RangeError("rain persistence target station set differs");
    }
    const captureMembers = [...row.captureMembers].sort(
      // preserve one deterministic order across overlapping provider responses
      (left, right) => left.completedAt.localeCompare(right.completedAt) ||
        left.claimId.localeCompare(right.claimId),
    ).map((capture) => Object.freeze({ ...capture }));
    return Object.freeze({
      captureMembers: Object.freeze(captureMembers),
      precipitationMm64: row.precipitationMm === null
        ? null
        : encodeMaintenanceBinary64(row.precipitationMm),
      receivedAt: row.receivedAt,
      stationId: row.stationId,
    });
  });
  const available = rows.flatMap((row, index) => {
    // exclude only explicitly unavailable station hours
    if (row.precipitationMm64 === null) {
      return [];
    }
    const station = RAIN_COLLECTION_STATIONS[index]!;
    return [{
      id: station.locationId,
      value: decodeMaintenanceBinary64(row.precipitationMm64),
      weight: rainMaintenanceStationWeight(station),
    }];
  });
  const supported = available.length >= 3 && rows.slice(0, 3)
    .some((row) => row.precipitationMm64 !== null);
  const unsigned = {
    contractVersion: RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION,
    decisionAt: input.decisionAt,
    prediction64: supported
      ? encodeMaintenanceBinary64(rainMaintenanceWeightedMedian(available))
      : null,
    reason: supported ? "causal_target" : "raw_fallback_unavailable",
    rowCount: 12,
    rows: Object.freeze(rows),
    validAt: new Date(Date.parse(input.decisionAt) - 3_600_000).toISOString(),
  } as const;
  const target = Object.freeze({
    ...unsigned,
    targetMemberSha256: canonicalObjectSha256(
      unsigned as unknown as Readonly<Record<string, unknown>>,
      "targetMemberSha256",
    ),
  });
  validateRainMaintenancePersistenceTarget(target);
  return target;
}

// validate and self-bind one causal persistence target member
export function validateRainMaintenancePersistenceTarget(
  value: RainMaintenancePersistenceTarget,
): void {
  exactKeys(value, PERSISTENCE_TARGET_KEYS);
  requireInstant(value.decisionAt);
  requireInstant(value.validAt);
  requireHash(value.targetMemberSha256);
  // keep the prior target exactly one hour before the model decision
  if (value.contractVersion !== RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION ||
      Date.parse(value.decisionAt) - Date.parse(value.validAt) !== 3_600_000 ||
      value.rowCount !== RAIN_COLLECTION_STATIONS.length || !Array.isArray(value.rows) ||
      value.rows.length !== RAIN_COLLECTION_STATIONS.length ||
      canonicalObjectSha256(value as unknown as Readonly<Record<string, unknown>>,
        "targetMemberSha256") !== value.targetMemberSha256) {
    throw new RangeError("rain persistence target identity differs");
  }
  const values: { id: number; value: number; weight: number }[] = [];
  // preserve all twelve fixed gauges including explicit missing rows
  for (const [index, row] of value.rows.entries()) {
    exactKeys(row, PERSISTENCE_TARGET_ROW_KEYS);
    const station = RAIN_COLLECTION_STATIONS[index];
    if (station === undefined || row.stationId !== station.locationId ||
        !Array.isArray(row.captureMembers)) {
      throw new RangeError("rain persistence target station differs");
    }
    let previousCapture: string | null = null;
    // bind every overlapping provider response used to reconstruct the gauge hour
    for (const capture of row.captureMembers) {
      exactKeys(capture, PERSISTENCE_CAPTURE_KEYS);
      requireHash(capture.bodySha256);
      requireInstant(capture.completedAt);
      const order = `${capture.completedAt}\n${capture.claimId}`;
      if (typeof capture.claimId !== "string" || capture.claimId.length < 1 ||
          capture.claimId.length > 128 || Date.parse(capture.completedAt) > Date.parse(value.decisionAt) ||
          (previousCapture !== null && order <= previousCapture)) {
        throw new RangeError("rain persistence target was received after decision");
      }
      previousCapture = order;
    }
    if (row.receivedAt !== null) {
      requireInstant(row.receivedAt);
      if (Date.parse(row.receivedAt) > Date.parse(value.decisionAt) ||
          !row.captureMembers.some((capture: RainMaintenancePersistenceCaptureMember) =>
            capture.completedAt === row.receivedAt)) {
        throw new RangeError("rain persistence target receipt differs");
      }
    }
    if (row.precipitationMm64 !== null) {
      if (row.captureMembers.length === 0 || row.receivedAt === null) {
        throw new RangeError("rain persistence value lacks a capture");
      }
      const precipitation = decodeMaintenanceBinary64(row.precipitationMm64);
      if (precipitation < 0) {
        throw new RangeError("rain persistence target amount differs");
      }
      values.push({ id: station.locationId, value: precipitation,
        weight: rainMaintenanceStationWeight(station) });
    }
  }
  const nearestAvailable = value.rows.slice(0, 3).some((row) => row.precipitationMm64 !== null);
  const supported = values.length >= 3 && nearestAvailable;
  // supported members carry the exact deterministic weighted median
  if (supported) {
    if (value.reason !== "causal_target" || value.prediction64 === null ||
        decodeMaintenanceBinary64(value.prediction64) !== rainMaintenanceWeightedMedian(values)) {
      throw new RangeError("rain persistence target prediction differs");
    }
    return;
  }
  // unsupported members retain no invented target value
  if (value.reason !== "raw_fallback_unavailable" || value.prediction64 !== null) {
    throw new RangeError("rain persistence target fallback differs");
  }
}

// retain only finite nested event probabilities
function validateProbability(value: Readonly<Record<string, string>>): void {
  const decoded = PROBABILITY_KEYS.map((key) => decodeMaintenanceBinary64(value[key]));
  // reject out-of-range or nonnested event heads
  if (decoded.some((probability) => probability < 0 || probability > 1) ||
      decoded[0]! < decoded[1]! || decoded[1]! < decoded[2]!) {
    throw new RangeError("rain control probability differs");
  }
}

// bind all numerical controls to their causal persistence member
function validateRainControlValues(
  row: AdjustmentRainGateControlProjection["rows"][number],
  persistence: RainMaintenancePersistenceTarget,
): void {
  const raw = decodeMaintenanceBinary64(row.rawPrecipitationMm64);
  const prediction = decodeMaintenanceBinary64(row.persistencePrediction64);
  const nonnegative = [row.incumbentPrediction64, row.recentVolumeScalePrediction64,
    row.sameWindowVolumeScalePrediction64, row.unchangedOrdinalPrediction64,
    row.volumeScalePrediction64].map(decodeMaintenanceBinary64);
  // all amount controls and the incumbent must remain physical
  if (raw < 0 || prediction < 0 || nonnegative.some((value) => value < 0)) {
    throw new RangeError("rain control amount differs");
  }
  const native = PROBABILITY_KEYS.map((key) => decodeMaintenanceBinary64(row.nativeSourceProbability[key]));
  const expectedNative = [Number(raw >= 0.1), Number(raw >= 1), Number(raw >= 2.5)];
  // retain the deterministic raw-source event baseline exactly
  if (JSON.stringify(native) !== JSON.stringify(expectedNative)) {
    throw new RangeError("rain native source probability differs");
  }
  const targetPrediction = persistence.prediction64 === null
    ? null
    : decodeMaintenanceBinary64(persistence.prediction64);
  // reference the actual causal member only when its target exists
  if (targetPrediction === null) {
    if (row.persistenceReason !== "raw_fallback_unavailable" ||
        row.persistenceTargetMemberSha256 !== null || prediction !== raw) {
      throw new RangeError("rain persistence control fallback differs");
    }
    return;
  }
  if (row.persistenceReason !== "causal_target" ||
      row.persistenceTargetMemberSha256 !== persistence.targetMemberSha256 ||
      prediction !== targetPrediction) {
    throw new RangeError("rain persistence control differs");
  }
}

// preserve canonical nested persistence member field order
function orderedPersistenceTarget(value: RainMaintenancePersistenceTarget): Record<string, unknown> {
  return Object.fromEntries(PERSISTENCE_TARGET_KEYS.map((key) => [key,
    key === "rows"
      ? value.rows.map((row) => Object.fromEntries(PERSISTENCE_TARGET_ROW_KEYS.map(
          // retain all missing station members explicitly
          (field) => [field, field === "captureMembers"
            ? row.captureMembers.map((capture) => Object.fromEntries(PERSISTENCE_CAPTURE_KEYS.map(
                // retain exact provider capture identity order
                (captureField) => [captureField, capture[captureField]],
              )))
            : row[field]],
        )))
      : value[key],
  ]));
}

// reproduce the fixed spatial weight from the retained gauge catalog
export function rainMaintenanceStationWeight(
  station: typeof RAIN_COLLECTION_STATIONS[number],
): number {
  const radians = Math.PI / 180;
  const latitude = station.latitude * radians;
  const longitude = station.longitude * radians;
  const siteLatitude = RAIN_COLLECTION_POLICY.latitude * radians;
  const siteLongitude = RAIN_COLLECTION_POLICY.longitude * radians;
  const a = Math.sin((latitude - siteLatitude) / 2) ** 2 +
    Math.cos(latitude) * Math.cos(siteLatitude) *
      Math.sin((longitude - siteLongitude) / 2) ** 2;
  const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(a));
  return 1 / (1 + (distance / 2_000) ** 2);
}

// select the deterministic lower weighted median at an exact half-mass tie
export function rainMaintenanceWeightedMedian(
  values: readonly { id: number; value: number; weight: number }[],
): number {
  const ordered = [...values].sort((left, right) => left.value - right.value || left.id - right.id);
  const half = ordered.reduce((total, item) => total + item.weight, 0) / 2;
  let cumulative = 0;
  // return the first value reaching the half-mass boundary
  for (const item of ordered) {
    cumulative += item.weight;
    if (cumulative >= half) {
      return item.value;
    }
  }
  throw new RangeError("rain persistence target is empty");
}

// bind the pre-fit feature body to the actual reviewed causal source
function validateRainFeatureSource(source: AdjustmentRainGateFeatureProjection["source"]): void {
  const fingerprint = source.sourceConfigFingerprint;
  // close every fixed provider and adapter field while retaining the actual claim id
  if (source.adapterVersion !== "rain-hurdle-wind-features/v1" ||
      source.contractEpoch !== "rain-prospective-capture/v1" ||
      source.dataset !== "ecmwf_ifs" || source.providerKey !== "open-meteo-single-runs" ||
      fingerprint !== ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT ||
      typeof source.sourceId !== "string" || source.sourceId.length < 1 ||
      source.sourceId.length > 128 || source.sourceKey !== "rain-prospective-forecast" ||
      source.sourceKind !== "forecast" || source.upstreamModel !== "ecmwf_ifs") {
    throw new RangeError("adjustment rain feature source differs");
  }
}

// bind the body header to the exact current database content identity
function validateStoredProjectionBinding(value: AdjustmentRevisionProjection): void {
  const first = value.rows[0]!;
  // weather records and anchors expose their stored content hash on the row
  if (value.projectionKind === "actual_best_match" || value.projectionKind === "target_revision") {
    if (first.contentSha256 !== value.storedContentSha256 || first.validAt !== value.logicalKey.validAt) {
      throw new RangeError("weather revision stored content differs");
    }
    return;
  }
  // the anchor pointer binds the same content, lead and valid clock
  if (value.projectionKind === "native_source" && value.logicalKey.sourceType === "forecast_anchor") {
    if (first.contentSha256 !== value.storedContentSha256 || first.validAt !== value.logicalKey.validAt ||
        first.leadHours !== value.logicalKey.leadHours) {
      throw new RangeError("forecast anchor stored content differs");
    }
    return;
  }
  // complete ECMWF runs use their run-level aggregate content identity
  if (value.projectionKind === "native_source" &&
      value.logicalKey.contentSha256 !== value.storedContentSha256) {
    throw new RangeError("temperature run stored content differs");
  }
}

// choose one exact value schema from the closed logical source type
function revisionRowKeys(value: AdjustmentRevisionProjectionDocument): readonly string[] {
  if (value.contractVersion === ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION) {
    return RAIN_GATE_FEATURE_ROW_KEYS;
  }
  if (value.projectionKind === "rain_gate_input") {
    return RAIN_GATE_ROW_KEYS;
  }
  if (value.projectionKind === "native_source" && value.logicalKey.sourceType === "ecmwf_temperature_run") {
    return TEMPERATURE_ROW_KEYS;
  }
  if (value.projectionKind === "native_source") {
    return ANCHOR_ROW_KEYS;
  }
  return WEATHER_ROW_KEYS;
}

// bind each projection class to its only legal complete width
function expectedRowCount(value: AdjustmentRevisionProjection): number {
  if (value.projectionKind === "rain_gate_input") {
    return 23;
  }
  if (value.projectionKind === "native_source" && value.logicalKey.sourceType === "ecmwf_temperature_run") {
    return 18;
  }
  return 1;
}

// validate the fixed lineage record without accepting private provider fields
function validateSource(
  source: AdjustmentRevisionProjection["source"],
  kind: AdjustmentRevisionProjectionKind,
): void {
  // require content-bearing lineages to name their exact source contract
  for (const field of SOURCE_KEYS) {
    const value = source[field];
    if (value !== null && (typeof value !== "string" || value.length < 1 || value.length > 128 ||
        /[\u0000-\u001f\u007f]/u.test(value))) {
      throw new RangeError("adjustment revision source lineage is invalid");
    }
  }
  // rain gates use their model/input identity rather than a provider source row
  if (kind === "rain_gate_input") {
    if (SOURCE_KEYS.some((field) => source[field] !== null)) {
      throw new RangeError("rain gate source lineage must be null");
    }
    return;
  }
  // physical targets have no upstream model but retain every actual source field
  const required = kind === "target_revision"
    ? SOURCE_KEYS.filter((field) => field !== "upstreamModel")
    : SOURCE_KEYS;
  if (required.some((field) => source[field] === null) ||
      (kind === "target_revision" && source.upstreamModel !== null)) {
    throw new RangeError("adjustment revision source lineage is incomplete");
  }
}

// validate one kind-specific serving key
function validateLogicalKey(
  key: AdjustmentRevisionProjection["logicalKey"],
  kind: AdjustmentRevisionProjectionKind,
): void {
  if (kind === "actual_best_match" || kind === "target_revision") {
    requireDecimal(key.sourceId);
    requireInstant(key.validAt);
    if (kind === "actual_best_match") {
      requireInstant(key.productRunAt);
      if (key.sourceKind !== "forecast") throw new RangeError("actual comparator key differs");
    } else if (key.productRunAt !== null || key.sourceKind !== "physical_sensor") {
      throw new RangeError("target revision key differs");
    }
    return;
  }
  if (kind === "rain_gate_input") {
    requireHash(key.inputSha256);
    requireHash(key.modelSha256);
    requireInstant(key.runInitializedAt);
    return;
  }
  // admit one fixed anchor or one complete ECMWF run
  if (key.sourceType === "forecast_anchor") {
    requireDecimal(key.sourceId);
    requireInstant(key.validAt);
    requireInteger(key.leadHours, 1, 384);
    if (key.contentSha256 !== null || key.providerResponseSha256 !== null ||
        key.runInitializedAt !== null || key.siteId !== null) {
      throw new RangeError("forecast anchor key differs");
    }
  } else if (key.sourceType === "ecmwf_temperature_run") {
    requireHash(key.contentSha256);
    requireHash(key.providerResponseSha256);
    requireInstant(key.runInitializedAt);
    requireDecimal(key.siteId);
    if (key.leadHours !== null || key.sourceId !== null || key.validAt !== null) {
      throw new RangeError("temperature run key differs");
    }
  } else {
    throw new RangeError("native source type differs");
  }
}

// validate one row against its database-backed class
function validateRevisionRow(
  projection: AdjustmentRevisionProjection,
  row: Readonly<Record<string, unknown>>,
  index: number,
): void {
  if (projection.projectionKind === "rain_gate_input") {
    requireInteger(row.modelLeadHours, 1, 168);
    requireBoolean(row.applied);
    requireBinary64(row.rawPrecipitationMm64, false);
    requireBinary64(row.correctedPrecipitationMm64, true);
    // retain a database null reason without inventing a categorical label
    if (row.reasonCode !== null) {
      requireText(row.reasonCode);
    }
    return;
  }
  if (projection.projectionKind === "native_source" &&
      projection.logicalKey.sourceType === "ecmwf_temperature_run") {
    requireHash(row.contentSha256);
    if (row.modelLeadHours !== index + 1) {
      throw new RangeError("temperature native lead differs");
    }
    if (row.modelCycle !== "49r1" && row.modelCycle !== "50r1") {
      throw new RangeError("temperature native model cycle differs");
    }
    // retain the exact serving comparator only for the eligible lead-seven-to-eighteen horizon
    if (index < 6) {
      if (row.bestMatchContentSha256 !== null || row.bestMatchProductRunAt !== null ||
          row.bestMatchSourceId !== null || row.bestMatchTemperatureC64 !== null) {
        throw new RangeError("temperature native pre-serving comparator differs");
      }
    } else {
      requireHash(row.bestMatchContentSha256);
      requireInstant(row.bestMatchProductRunAt);
      requireDecimal(row.bestMatchSourceId);
      requireBinary64(row.bestMatchTemperatureC64, true);
    }
    requireBinary64(row.rawTemperatureC64, false);
    requireBinary64(row.rawRelativeHumidityPercent64, true);
    requireBinary64(row.rawWindSpeedMps64, true);
    return;
  }
  requireHash(row.contentSha256);
  if (projection.projectionKind === "native_source") {
    requireInteger(row.leadHours, 1, 384);
  }
  // validate every metric field using the frozen binary64 representation
  for (const [field, value] of Object.entries(row)) {
    if (field.endsWith("64")) {
      requireBinary64(value, true);
    }
  }
}

// require one nullable or present finite binary64
function requireBinary64(value: unknown, nullable: boolean): void {
  if (value === null && nullable) return;
  decodeMaintenanceBinary64(value);
}

// require one canonical millisecond UTC clock
function requireInstant(value: unknown): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new RangeError("adjustment revision clock is invalid");
  }
}

// require one lowercase content identity
function requireHash(value: unknown): void {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new RangeError("adjustment revision identity is invalid");
  }
}

// require one positive database identity
function requireDecimal(value: unknown): void {
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new RangeError("adjustment revision database identity is invalid");
  }
}

// require one bounded integer
function requireInteger(value: unknown, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new RangeError("adjustment revision integer is invalid");
  }
}

// require one bounded reason or lineage label
function requireText(value: unknown): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RangeError("adjustment revision text is invalid");
  }
}

// require one actual boolean
function requireBoolean(value: unknown): void {
  if (typeof value !== "boolean") {
    throw new RangeError("adjustment revision boolean is invalid");
  }
}

// prohibit unknown properties at every projection boundary
function exactKeys(value: unknown, keys: readonly string[]): void {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()) {
    throw new RangeError("adjustment revision projection fields differ");
  }
}
