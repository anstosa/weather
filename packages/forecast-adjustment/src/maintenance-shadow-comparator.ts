import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { JsonValue } from "@weather/domain";

import { canonicalJsonBytes } from "./candidate.js";
import {
  createMaintenanceShadowPredictionMetadata,
  createMaintenanceShadowSourceIdentity,
  decodeMaintenanceBinary64,
  parseMaintenanceShadowSourceProjection,
  parseMaintenanceShadowValues,
  type MaintenanceShadowFamily,
} from "./maintenance-shadow-values.js";
import {
  verifyForecastAdjustmentMaintenanceRuntimePackage,
} from "./maintenance-runtime-package.js";
import {
  RAIN_HURDLE_WIND_ARTIFACT_SHA256,
  RAIN_HURDLE_WIND_ARTIFACT_JSON,
} from "./rain-hurdle-wind-artifact.js";
import {
  validateRainHurdleWindPortableArtifact,
} from "./rain-hurdle-wind.js";
import { verifyForecastAdjustmentRuntimeBundle } from "./runtime-bundle.js";
import {
  verifyForecastAdjustmentTemperatureCanaryRuntimeBundle,
} from "./temperature-canary.js";
import {
  verifyForecastAdjustmentWindCanaryRuntimeBundle,
} from "./wind-canary.js";

export const MAINTENANCE_SHADOW_COMPARATOR_VERSION =
  "adjustment-shadow-incumbent-comparator/v1" as const;
export const MAINTENANCE_SHADOW_COMPARATOR_LIMIT_BYTES = 512 * 1_024;

const HASH = /^[a-f0-9]{64}$/u;
const BINARY64 = /^[a-f0-9]{16}$/u;
const UTC_MILLISECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const TOP_KEYS = ["contractVersion", "family", "registrationSha256", "candidateSha256", "sourceSha256",
  "dueKey", "issuedAt", "sourceProjectionSha256", "predictionBodySha256", "servingAuthority", "rowCount",
  "rows"] as const;
const AUTHORITY_KEYS = ["artifactBase64", "artifactIdentitySha256", "artifactMemberSha256", "authorityKind",
  "receiptBase64", "receiptMemberSha256"] as const;
export const MAINTENANCE_SHADOW_COMPARATOR_ROW_KEYS = Object.freeze({
  rain: ["validAt", "leadHours", "sourceRowSha256", "incumbentPrecipitationMm64", "occurrenceProbability64",
    "atLeast1_0Probability64", "atLeast2_5Probability64", "positiveAmountMm64", "applied", "reasonCode"],
  temperature: ["validAt", "leadHours", "sourceRowSha256", "incumbentTemperatureC64", "applied", "reasonCode"],
  wind: ["validAt", "leadHours", "sourceRowSha256", "incumbentSpeedMps64", "incumbentGustMps64",
    "speedApplied", "gustApplied", "reasonCode"],
} as const);
const QUALIFIED_RECEIPT_KEYS = ["actionKind", "actionSha256", "bundleSha256", "candidateGraphSha256",
  "candidateSha256", "contractVersion", "controlPlaneSha256", "deployedCommit", "deployedImageDigest",
  "deployedRelease", "deployedSettingsSha256", "fencingToken", "fullMemberRootSha256", "installedAt",
  "lifecycleHeadSha256", "policyDecision", "policyReportSha256", "registrationSha256", "sourceSha256"] as const;
const TEMP_RAW_REGISTRY_KEYS = ["activeBundle", "contractVersion", "rawReason", "siteKey"] as const;
const WIND_RAW_REGISTRY_KEYS = ["activeBundle", "contractVersion", "enabledMetricBands", "rawReason", "siteKey"] as const;
const MAINTENANCE_RAW_REGISTRY_KEYS = ["activePackage", "contractVersion", "rawReason", "siteKey"] as const;
const RAIN_RAW_REGISTRY_KEYS = ["activeArtifact", "contractVersion", "rawReason", "siteKey"] as const;
const RAIN_ACTIVE_REGISTRY_KEYS = ["activeArtifact", "contractVersion", "rawReason", "siteKey"] as const;
const RAIN_ACTIVE_ARTIFACT_KEYS = ["artifactSha256"] as const;
const TEMP_REASON_CODES: ReadonlySet<unknown> = new Set([null, "bundle_invalid", "bundle_missing", "canary_expired", "canary_killed",
  "registry_inactive", "registry_invalid", "policy_raw", "unsupported", "missing_source_forecast",
  "outside_operational_window", "source_identity_mismatch", "source_not_available", "source_stale",
  "source_time_mismatch"]);
const WIND_REASON_CODES: ReadonlySet<unknown> = new Set([null, "adjustment_error", "bundle_invalid", "bundle_missing", "canary_expired",
  "canary_killed", "coefficient_missing", "direction_calm", "identity_mismatch", "metric_not_enabled",
  "metric_out_of_bounds", "policy_raw", "registry_inactive", "registry_invalid", "runtime_fingerprint_mismatch",
  "unsupported_lead", "wrong_cohort"]);
const RAIN_REASON_CODES: ReadonlySet<unknown> = new Set([
  null, "phase_unsupported", "policy_raw", "prediction_invalid",
]);

export type MaintenanceShadowComparatorAuthorityKind =
  | "legacy_active"
  | "maintenance_qualified"
  | "policy_raw";

// retain exact serving material rather than caller-supplied identities
export interface MaintenanceShadowServingAuthority {
  readonly artifactBase64: string | null;
  readonly artifactIdentitySha256: string | null;
  readonly artifactMemberSha256: string | null;
  readonly authorityKind: MaintenanceShadowComparatorAuthorityKind;
  readonly receiptBase64: string;
  readonly receiptMemberSha256: string;
}

// bind one serving decision vector to the exact shadow source and candidate body
export interface MaintenanceShadowComparator {
  readonly contractVersion: typeof MAINTENANCE_SHADOW_COMPARATOR_VERSION;
  readonly family: MaintenanceShadowFamily;
  readonly registrationSha256: string;
  readonly candidateSha256: string;
  readonly sourceSha256: string;
  readonly dueKey: string;
  readonly issuedAt: string;
  readonly sourceProjectionSha256: string;
  readonly predictionBodySha256: string;
  readonly servingAuthority: MaintenanceShadowServingAuthority;
  readonly rowCount: number;
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
}

// create one validated snapshot from exact artifact and receipt bytes
export function createMaintenanceShadowServingAuthority(input: Readonly<{
  artifactBytes: Uint8Array | null;
  artifactIdentitySha256: string | null;
  authorityKind: MaintenanceShadowComparatorAuthorityKind;
  family: MaintenanceShadowFamily;
  receiptBytes: Uint8Array;
}>): MaintenanceShadowServingAuthority {
  const artifactBytes = input.artifactBytes === null ? null : Buffer.from(input.artifactBytes);
  const receiptBytes = Buffer.from(input.receiptBytes);
  const authority = {
    artifactBase64: artifactBytes?.toString("base64") ?? null,
    artifactIdentitySha256: input.artifactIdentitySha256,
    artifactMemberSha256: artifactBytes === null ? null : sha256(artifactBytes),
    authorityKind: input.authorityKind,
    receiptBase64: receiptBytes.toString("base64"),
    receiptMemberSha256: sha256(receiptBytes),
  } as const;
  validateServingAuthority(authority, input.family);
  return authority;
}

// encode one family-closed comparator after full source/body cross-binding
export function encodeMaintenanceShadowComparator(
  value: MaintenanceShadowComparator,
  sourceProjectionBytes: Uint8Array,
  predictionBodyBytes: Uint8Array,
): Buffer {
  validateMaintenanceShadowComparator(value);
  validateMaintenanceShadowComparatorBinding(value, sourceProjectionBytes, predictionBodyBytes);
  const ordered: Record<string, unknown> = {};
  // preserve one reviewed top-level byte grammar
  for (const key of TOP_KEYS) {
    if (key === "servingAuthority") {
      ordered[key] = Object.fromEntries(AUTHORITY_KEYS.map((field) => [field, value.servingAuthority[field]]));
    } else if (key === "rows") {
      ordered[key] = value.rows.map(
        // preserve the family-specific row byte grammar
        (row) => Object.fromEntries(MAINTENANCE_SHADOW_COMPARATOR_ROW_KEYS[value.family]
          .map((field) => [field, row[field]])),
      );
    } else {
      ordered[key] = value[key];
    }
  }
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
  // keep one comparator inside the bounded two-slot transport
  if (bytes.length > MAINTENANCE_SHADOW_COMPARATOR_LIMIT_BYTES) {
    throw new RangeError("shadow comparator exceeds its cap");
  }
  return bytes;
}

// parse one canonical comparator member without trusting capsule metadata
export function parseMaintenanceShadowComparator(bytes: Uint8Array): MaintenanceShadowComparator {
  // reject oversized members before allocating embedded artifacts
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAINTENANCE_SHADOW_COMPARATOR_LIMIT_BYTES) {
    throw new RangeError("invalid shadow comparator size");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as MaintenanceShadowComparator;
  validateMaintenanceShadowComparator(value);
  const canonical = encodeComparatorUnchecked(value);
  // reject alternate serialization identities
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("shadow comparator is not canonical");
  }
  return value;
}

// require the comparator to describe the same exact source and candidate body
export function validateMaintenanceShadowComparatorBinding(
  comparator: MaintenanceShadowComparator,
  sourceProjectionBytes: Uint8Array,
  predictionBodyBytes: Uint8Array,
): void {
  const source = parseMaintenanceShadowSourceProjection(sourceProjectionBytes);
  const body = parseMaintenanceShadowValues(predictionBodyBytes);
  const metadata = createMaintenanceShadowPredictionMetadata(predictionBodyBytes, sourceProjectionBytes);
  const sourceIdentity = createMaintenanceShadowSourceIdentity(sourceProjectionBytes);
  // bind every common identity and clock to the frozen capsule members
  if (comparator.family !== source.family || comparator.family !== body.family ||
      comparator.registrationSha256 !== source.registrationSha256 ||
      comparator.registrationSha256 !== body.registrationSha256 ||
      comparator.candidateSha256 !== source.candidateSha256 || comparator.candidateSha256 !== body.candidateSha256 ||
      comparator.sourceSha256 !== source.sourceSha256 || comparator.sourceSha256 !== body.sourceSha256 ||
      comparator.dueKey !== source.dueKey || comparator.dueKey !== body.dueKey ||
      comparator.issuedAt !== source.issuedAt || comparator.issuedAt !== body.issuedAt ||
      comparator.sourceProjectionSha256 !== sha256(Buffer.from(sourceProjectionBytes)) ||
      comparator.predictionBodySha256 !== metadata.predictionBodySha256 ||
      comparator.rowCount !== source.rowCount || comparator.rowCount !== body.rowCount) {
    throw new RangeError("shadow comparator capsule binding differs");
  }
  // bind every incumbent result to the exact ordered causal row
  for (let index = 0; index < comparator.rows.length; index += 1) {
    const row = comparator.rows[index]!;
    const sourceRow = source.rows[index]!;
    const bodyRow = body.rows[index]!;
    if (row.validAt !== sourceRow.validAt || row.validAt !== bodyRow.validAt || row.leadHours !== index + 1 ||
        bodyRow.leadHours !== index + 1 || row.sourceRowSha256 !== sourceIdentity.sourceRowSha256[index] ||
        bodyRow.sourceRowSha256 !== row.sourceRowSha256) {
      throw new RangeError("shadow comparator row binding differs");
    }
  }
}

// validate one comparator member and its embedded serving material
export function validateMaintenanceShadowComparator(value: MaintenanceShadowComparator): void {
  exactKeys(value, TOP_KEYS, "shadow comparator");
  if (value.contractVersion !== MAINTENANCE_SHADOW_COMPARATOR_VERSION ||
      !["temperature", "wind", "rain"].includes(value.family) ||
      !HASH.test(value.registrationSha256) || !HASH.test(value.candidateSha256) || !HASH.test(value.sourceSha256) ||
      !HASH.test(value.sourceProjectionSha256) || !HASH.test(value.predictionBodySha256) ||
      !UTC_MILLISECOND.test(value.issuedAt) || !Number.isFinite(Date.parse(value.issuedAt)) ||
      typeof value.dueKey !== "string" || value.dueKey.length < 1 || value.dueKey.length > 128 ||
      !Number.isSafeInteger(value.rowCount) || value.rowCount < 1 || !Array.isArray(value.rows) ||
      value.rows.length !== value.rowCount) {
    throw new RangeError("shadow comparator identity differs");
  }
  validateServingAuthority(value.servingAuthority, value.family);
  // validate every row without allowing arbitrary decision fields
  for (const row of value.rows) {
    validateComparatorRow(row, value.family);
  }
}

// build canonical bytes after the value has already been validated
function encodeComparatorUnchecked(value: MaintenanceShadowComparator): Buffer {
  const ordered: Record<string, unknown> = {};
  // preserve the reviewed top-level ordering
  for (const key of TOP_KEYS) {
    if (key === "servingAuthority") {
      ordered[key] = Object.fromEntries(AUTHORITY_KEYS.map((field) => [field, value.servingAuthority[field]]));
    } else if (key === "rows") {
      ordered[key] = value.rows.map(
        // preserve the family row ordering
        (row) => Object.fromEntries(MAINTENANCE_SHADOW_COMPARATOR_ROW_KEYS[value.family]
          .map((field) => [field, row[field]])),
      );
    } else {
      ordered[key] = value[key];
    }
  }
  return Buffer.from(JSON.stringify(ordered) + "\n");
}

// validate embedded exact serving artifacts and receipts by authority generation
function validateServingAuthority(
  authority: MaintenanceShadowServingAuthority,
  family: MaintenanceShadowFamily,
): void {
  exactKeys(authority, AUTHORITY_KEYS, "shadow comparator authority");
  if (!HASH.test(authority.receiptMemberSha256) ||
      !["legacy_active", "maintenance_qualified", "policy_raw"].includes(authority.authorityKind)) {
    throw new RangeError("shadow comparator authority differs");
  }
  const receiptBytes = strictBase64(authority.receiptBase64, "serving receipt");
  if (sha256(receiptBytes) !== authority.receiptMemberSha256) {
    throw new RangeError("shadow comparator receipt hash differs");
  }
  const receipt = parseCanonicalJson(receiptBytes, "serving receipt");
  // raw policy has no artifact bytes or inferred model identity
  if (authority.authorityKind === "policy_raw") {
    if (authority.artifactBase64 !== null || authority.artifactIdentitySha256 !== null ||
        authority.artifactMemberSha256 !== null) {
      throw new RangeError("raw comparator contains an artifact");
    }
    validateRawReceipt(receipt, family);
    return;
  }
  if (typeof authority.artifactBase64 !== "string" || !HASH.test(String(authority.artifactIdentitySha256)) ||
      !HASH.test(String(authority.artifactMemberSha256))) {
    throw new RangeError("active comparator artifact differs");
  }
  const artifactBytes = strictBase64(authority.artifactBase64, "serving artifact");
  if (sha256(artifactBytes) !== authority.artifactMemberSha256) {
    throw new RangeError("shadow comparator artifact hash differs");
  }
  const artifact = parseJson(artifactBytes, "serving artifact");
  if (authority.authorityKind === "maintenance_qualified") {
    validateQualifiedAuthority(artifact, artifactBytes, receipt, authority.artifactIdentitySha256!, family);
  } else {
    validateLegacyAuthority(artifact, artifactBytes, receipt, authority.artifactIdentitySha256!, family);
  }
}

// validate a root-qualified package and exact installed receipt
function validateQualifiedAuthority(
  artifact: Record<string, unknown>,
  artifactBytes: Buffer,
  receipt: Record<string, unknown>,
  artifactIdentitySha256: string,
  family: MaintenanceShadowFamily,
): void {
  exactKeys(receipt, QUALIFIED_RECEIPT_KEYS, "qualified serving receipt");
  if (receipt.contractVersion !== "adjustment-installed-candidate-receipt/v2" ||
      receipt.actionKind !== "promote" || receipt.policyDecision !== "qualified" ||
      !HASH.test(String(receipt.fullMemberRootSha256)) || receipt.bundleSha256 !== artifactIdentitySha256 ||
      !HASH.test(String(receipt.actionSha256)) || !HASH.test(String(receipt.registrationSha256)) ||
      !HASH.test(String(receipt.candidateGraphSha256)) || !HASH.test(String(receipt.candidateSha256)) ||
      !HASH.test(String(receipt.sourceSha256)) || !HASH.test(String(receipt.policyReportSha256)) ||
      !HASH.test(String(receipt.lifecycleHeadSha256))) {
    throw new RangeError("qualified serving receipt differs");
  }
  if (family === "rain") {
    validateRainHurdleWindPortableArtifact(artifactBytes.toString("utf8"), artifactIdentitySha256);
    return;
  }
  verifyForecastAdjustmentMaintenanceRuntimePackage(artifact as never);
  if (artifact.family !== family || artifact.bundleSha256 !== artifactIdentitySha256) {
    throw new RangeError("qualified serving package differs");
  }
}

// validate an actual legacy artifact and its nested or registry receipt
function validateLegacyAuthority(
  artifact: Record<string, unknown>,
  artifactBytes: Buffer,
  receipt: Record<string, unknown>,
  artifactIdentitySha256: string,
  family: MaintenanceShadowFamily,
): void {
  if (family === "temperature") {
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(artifact as never);
    if (artifact.bundleSha256 !== artifactIdentitySha256 ||
        canonicalJsonBytes(artifact.authorization as JsonValue) !== receiptBytesText(receipt)) {
      throw new RangeError("legacy temperature serving authority differs");
    }
    return;
  }
  if (family === "wind") {
    // accept either exact retained serving generation without relabelling it
    if (artifact.contractVersion === "forecast-adjustment-runtime-bundle/v2") {
      verifyForecastAdjustmentRuntimeBundle(artifact as never);
      if (artifact.bundleSha256 !== artifactIdentitySha256 ||
          canonicalJsonBytes(artifact.qualificationReceipt as JsonValue) !== receiptBytesText(receipt)) {
        throw new RangeError("legacy wind serving authority differs");
      }
      return;
    }
    verifyForecastAdjustmentWindCanaryRuntimeBundle(artifact as never);
    if (artifact.bundleSha256 !== artifactIdentitySha256 ||
        canonicalJsonBytes(artifact.authorization as JsonValue) !== receiptBytesText(receipt)) {
      throw new RangeError("legacy wind serving authority differs");
    }
    return;
  }
  // the current compiled incumbent is one exact generated artifact
  if (artifactIdentitySha256 !== RAIN_HURDLE_WIND_ARTIFACT_SHA256 ||
      artifactBytes.toString("utf8") !== RAIN_HURDLE_WIND_ARTIFACT_JSON) {
    throw new RangeError("legacy rain artifact differs");
  }
  exactKeys(receipt, RAIN_ACTIVE_REGISTRY_KEYS, "legacy rain registry");
  const activeArtifact = receipt.activeArtifact as Record<string, unknown>;
  exactKeys(activeArtifact, RAIN_ACTIVE_ARTIFACT_KEYS, "legacy rain active artifact");
  if (receipt.contractVersion !== "forecast-adjustment-rain-runtime-registry/v1" || receipt.rawReason !== null ||
      activeArtifact.artifactSha256 !== artifactIdentitySha256) {
    throw new RangeError("legacy rain registry differs");
  }
}

// validate an explicit reviewed raw registry instead of an environment toggle
function validateRawReceipt(receipt: Record<string, unknown>, family: MaintenanceShadowFamily): void {
  const contractVersion = receipt.contractVersion;
  if (family === "temperature" && contractVersion === "forecast-adjustment-temperature-canary-registry/v2") {
    exactKeys(receipt, TEMP_RAW_REGISTRY_KEYS, "temperature raw registry");
    if (receipt.activeBundle !== null || receipt.rawReason !== "policy_raw" || receipt.siteKey !== "ballydidean") {
      throw new RangeError("temperature raw registry differs");
    }
    return;
  }
  if (family === "wind" && contractVersion === "forecast-adjustment-wind-canary-registry/v2") {
    exactKeys(receipt, WIND_RAW_REGISTRY_KEYS, "wind raw registry");
    if (receipt.activeBundle !== null || receipt.rawReason !== "policy_raw" || receipt.siteKey !== "ballydidean" ||
        !Array.isArray(receipt.enabledMetricBands) || receipt.enabledMetricBands.length !== 13) {
      throw new RangeError("wind raw registry differs");
    }
    return;
  }
  if (contractVersion === `forecast-adjustment-${family}-maintenance-registry/v1`) {
    exactKeys(receipt, MAINTENANCE_RAW_REGISTRY_KEYS, "maintenance raw registry");
    if (receipt.activePackage !== null || receipt.rawReason !== "policy_raw" || receipt.siteKey !== "ballydidean") {
      throw new RangeError("maintenance raw registry differs");
    }
    return;
  }
  if (family === "rain" && contractVersion === "forecast-adjustment-rain-runtime-registry/v1") {
    exactKeys(receipt, RAIN_RAW_REGISTRY_KEYS, "rain raw registry");
    if (receipt.activeArtifact !== null || receipt.rawReason !== "policy_raw" || receipt.siteKey !== "ballydidean") {
      throw new RangeError("rain raw registry differs");
    }
    return;
  }
  throw new RangeError("raw serving receipt differs");
}

// validate one family-specific incumbent row
function validateComparatorRow(
  row: Readonly<Record<string, string | number | boolean | null>>,
  family: MaintenanceShadowFamily,
): void {
  exactKeys(row, MAINTENANCE_SHADOW_COMPARATOR_ROW_KEYS[family], "shadow comparator row");
  if (!UTC_MILLISECOND.test(String(row.validAt)) || !Number.isFinite(Date.parse(String(row.validAt))) ||
      !Number.isSafeInteger(row.leadHours) || Number(row.leadHours) < 1 || !HASH.test(String(row.sourceRowSha256))) {
    throw new RangeError("shadow comparator row geometry differs");
  }
  if (family === "temperature") {
    requireBinary64(row.incumbentTemperatureC64);
    if (typeof row.applied !== "boolean" || !TEMP_REASON_CODES.has(row.reasonCode)) {
      throw new RangeError("temperature comparator decision differs");
    }
    return;
  }
  if (family === "wind") {
    requireBinary64(row.incumbentSpeedMps64);
    if (row.incumbentGustMps64 !== null) requireBinary64(row.incumbentGustMps64);
    if (typeof row.speedApplied !== "boolean" || typeof row.gustApplied !== "boolean" ||
        !WIND_REASON_CODES.has(row.reasonCode)) {
      throw new RangeError("wind comparator decision differs");
    }
    return;
  }
  requireBinary64(row.incumbentPrecipitationMm64);
  if (row.occurrenceProbability64 !== null) requireProbability64(row.occurrenceProbability64);
  if (row.atLeast1_0Probability64 !== null) requireProbability64(row.atLeast1_0Probability64);
  if (row.atLeast2_5Probability64 !== null) requireProbability64(row.atLeast2_5Probability64);
  if (row.positiveAmountMm64 !== null) requireBinary64(row.positiveAmountMm64);
  if (typeof row.applied !== "boolean" || !RAIN_REASON_CODES.has(row.reasonCode) ||
      (row.applied && [row.occurrenceProbability64, row.atLeast1_0Probability64,
        row.atLeast2_5Probability64, row.positiveAmountMm64].some((item) => item === null))) {
    throw new RangeError("rain comparator decision differs");
  }
}

// require one finite binary64 field
function requireBinary64(value: unknown): void {
  if (typeof value !== "string" || !BINARY64.test(value)) {
    throw new RangeError("comparator binary64 differs");
  }
  decodeMaintenanceBinary64(value);
}

// require one finite probability encoding
function requireProbability64(value: unknown): void {
  requireBinary64(value);
  const decoded = decodeMaintenanceBinary64(value);
  if (decoded < 0 || decoded > 1) {
    throw new RangeError("comparator probability differs");
  }
}

// parse one exact canonical receipt document
function parseCanonicalJson(bytes: Buffer, label: string): Record<string, unknown> {
  const value = parseJson(bytes, label);
  if (canonicalJsonBytes(value as JsonValue) !== bytes.toString("utf8")) {
    throw new RangeError(`${label} is not canonical`);
  }
  return value;
}

// parse one closed json object
function parseJson(bytes: Buffer, label: string): Record<string, unknown> {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(`${label} differs`);
  }
  return value as Record<string, unknown>;
}

// compare one parsed receipt through its canonical member bytes
function receiptBytesText(receipt: Record<string, unknown>): string {
  return canonicalJsonBytes(receipt as JsonValue);
}

// decode strict canonical base64 without aliases
function strictBase64(value: unknown, label: string): Buffer {
  if (typeof value !== "string" || value.length < 4 || value.length > 1_000_000 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new RangeError(`${label} base64 differs`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new RangeError(`${label} base64 differs`);
  }
  return bytes;
}

// require exact key order and membership
function exactKeys(value: unknown, expected: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      Object.keys(value).join(",") !== expected.join(",")) {
    throw new RangeError(`${label} schema differs`);
  }
}

// hash exact member bytes
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
