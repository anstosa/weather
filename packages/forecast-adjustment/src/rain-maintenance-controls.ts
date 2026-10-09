import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { JsonValue } from "@weather/domain";

import {
  canonicalJsonBytes,
  canonicalObjectSha256,
  canonicalSha256,
} from "./candidate.js";
import {
  decodeMaintenanceBinary64,
  encodeMaintenanceBinary64,
} from "./maintenance-shadow-values.js";
import {
  createRainHurdleWindPortableArtifactEvaluator,
  validateRainHurdleWindPortableArtifact,
} from "./rain-hurdle-wind.js";

export const RAIN_MAINTENANCE_CONTROL_STATE_VERSION =
  "rain-maintenance-control-state/v1" as const;
export const RAIN_MAINTENANCE_CONTROL_STATE_LIMIT_BYTES = 32 * 1_024;

const HASH = /^[a-f0-9]{64}$/u;
const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const UTC_MILLISECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const STATE_KEYS = [
  "calibrationEndAt",
  "calibrationStartAt",
  "contractVersion",
  "epochWitnessSha256",
  "generatedAt",
  "legacyCalibrationStartAt",
  "legacyRawScale64",
  "modelMonth",
  "ordinalArtifactSha256",
  "recentFallbackReason",
  "recentRawScale64",
  "recentSupported",
  "recipeSha256",
  "sameWindowRawScale64",
  "scheduleContractSha256",
  "sourceMemberRootSha256",
  "sourceReceiptRootSha256",
  "stateSha256",
  "support",
  "trainingMaximumValidAt",
] as const;
const SUPPORT_KEYS = [
  "calibrationDates",
  "calibrationHours",
  "calibrationRows",
  "calibrationWetDates",
  "calibrationWetHours",
  "effectiveDates64",
  "effectiveWetDates64",
  "legacyCalibrationRows",
  "legacyTrainingRows",
  "legacyTrainingWetRows",
  "trainingDates",
  "trainingHours",
  "trainingRows",
  "trainingWetDates",
  "trainingWetHours",
] as const;

// freeze the retained 45-day, 90-day and recency control recipes
export const RAIN_MAINTENANCE_CONTROL_RECIPE = Object.freeze({
  calibrationGapDays: 7,
  contractVersion: "rain-maintenance-control-recipe/v1",
  legacyCalibrationDays: 45,
  legacyRawScaleBounds: [0.5, 2],
  legacyScaleFallback: "unit_when_weighted_raw_mean_lte_1e-12",
  maximumPredictionMm: 30,
  ordinalAmountScaleBounds: [0.1, 3],
  ordinalEventThresholdsMm: [0.1, 1, 2.5],
  ordinalNestingFallback: "all_raw_event_rules",
  recentFallback: "same_window_volume_scale",
  recentHalfLifeDays: 30,
  recentMinimumEffectiveDates: 30,
  recentMinimumEffectiveWetDates: 3,
  sameWindowCalibrationDays: 90,
  scalarIterations: 64,
  scalarScaleBounds: [0.1, 3],
  support: {
    calibrationDates: 60,
    calibrationHours: 500,
    calibrationWetDates: 5,
    calibrationWetHours: 20,
    trainingDates: 180,
    trainingHours: 1_000,
    trainingWetDates: 20,
    trainingWetHours: 100,
  },
  weight: "equal_date_hour_vintage",
} as const);

export const RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256 = canonicalSha256(
  RAIN_MAINTENANCE_CONTROL_RECIPE as unknown as JsonValue,
);

// retain exact numerical support without an open metadata object
export interface RainMaintenanceControlSupport {
  readonly calibrationDates: number;
  readonly calibrationHours: number;
  readonly calibrationRows: number;
  readonly calibrationWetDates: number;
  readonly calibrationWetHours: number;
  readonly effectiveDates64: string;
  readonly effectiveWetDates64: string;
  readonly legacyCalibrationRows: number;
  readonly legacyTrainingRows: number;
  readonly legacyTrainingWetRows: number;
  readonly trainingDates: number;
  readonly trainingHours: number;
  readonly trainingRows: number;
  readonly trainingWetDates: number;
  readonly trainingWetHours: number;
}

// bind one earlier-only monthly control state to its archived inputs
export interface RainMaintenanceControlState {
  readonly calibrationEndAt: string;
  readonly calibrationStartAt: string;
  readonly contractVersion: typeof RAIN_MAINTENANCE_CONTROL_STATE_VERSION;
  readonly epochWitnessSha256: string;
  readonly generatedAt: string;
  readonly legacyCalibrationStartAt: string;
  readonly legacyRawScale64: string;
  readonly modelMonth: string;
  readonly ordinalArtifactSha256: string;
  readonly recentFallbackReason: "insufficient_effective_support" | "recent_calibration";
  readonly recentRawScale64: string;
  readonly recentSupported: boolean;
  readonly recipeSha256: string;
  readonly sameWindowRawScale64: string;
  readonly scheduleContractSha256: string;
  readonly sourceMemberRootSha256: string;
  readonly sourceReceiptRootSha256: string;
  readonly stateSha256: string;
  readonly support: RainMaintenanceControlSupport;
  readonly trainingMaximumValidAt: string;
}

// retain the four fixed controls and deterministic native event baseline
export interface RainMaintenanceControlValues {
  readonly nativeSourceProbability: Readonly<{
    atLeast0_1: number;
    atLeast1_0: number;
    atLeast2_5: number;
  }>;
  readonly persistencePrediction: number;
  readonly persistenceReason: "causal_target" | "raw_fallback_unavailable";
  readonly recentVolumeScalePrediction: number;
  readonly sameWindowVolumeScalePrediction: number;
  readonly unchangedOrdinalPrediction: number;
  readonly volumeScalePrediction: number;
}

// encode one closed state before the archive assigns its durable stage receipt
export function encodeRainMaintenanceControlState(
  value: RainMaintenanceControlState,
): Buffer {
  validateRainMaintenanceControlState(value);
  const ordered = Object.fromEntries(STATE_KEYS.map((key) => [key,
    key === "support"
      ? Object.fromEntries(SUPPORT_KEYS.map((field) => [field, value.support[field]]))
      : value[key],
  ]));
  const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
  // bound the one monthly auxiliary spool slot
  if (bytes.byteLength > RAIN_MAINTENANCE_CONTROL_STATE_LIMIT_BYTES) {
    throw new RangeError("rain control state exceeds its cap");
  }
  return bytes;
}

// parse only the canonical monthly state byte representation
export function parseRainMaintenanceControlState(
  bytes: Uint8Array,
): RainMaintenanceControlState {
  // reject oversized or empty state before decoding
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
      bytes.byteLength > RAIN_MAINTENANCE_CONTROL_STATE_LIMIT_BYTES) {
    throw new RangeError("rain control state size is invalid");
  }
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as
    RainMaintenanceControlState;
  const canonical = encodeRainMaintenanceControlState(value);
  // prohibit whitespace, key-order and numeric aliases
  if (!canonical.equals(Buffer.from(bytes))) {
    throw new RangeError("rain control state is not canonical");
  }
  return value;
}

// validate state chronology, support, scales and self-addressed identity
export function validateRainMaintenanceControlState(
  value: RainMaintenanceControlState,
): void {
  exactKeys(value, STATE_KEYS, "rain control state");
  exactKeys(value.support, SUPPORT_KEYS, "rain control support");
  const monthStart = Date.parse(`${value.modelMonth}-01T00:00:00.000Z`);
  const calibrationStart = Date.parse(value.calibrationStartAt);
  const calibrationEnd = Date.parse(value.calibrationEndAt);
  const legacyStart = Date.parse(value.legacyCalibrationStartAt);
  const trainingMaximum = Date.parse(value.trainingMaximumValidAt);
  const generated = Date.parse(value.generatedAt);
  const legacyScale = decodeMaintenanceBinary64(value.legacyRawScale64);
  const sameWindowScale = decodeMaintenanceBinary64(value.sameWindowRawScale64);
  const recentScale = decodeMaintenanceBinary64(value.recentRawScale64);
  // require one self-addressed reviewed contract and source graph
  if (value.contractVersion !== RAIN_MAINTENANCE_CONTROL_STATE_VERSION ||
      !MONTH.test(value.modelMonth) || !HASH.test(value.epochWitnessSha256) ||
      !HASH.test(value.ordinalArtifactSha256) ||
      value.recipeSha256 !== RAIN_MAINTENANCE_CONTROL_RECIPE_SHA256 ||
      !HASH.test(value.scheduleContractSha256) || !HASH.test(value.sourceMemberRootSha256) ||
      !HASH.test(value.sourceReceiptRootSha256) || !HASH.test(value.stateSha256) ||
      canonicalObjectSha256(value as unknown as Readonly<Record<string, unknown>>, "stateSha256") !==
        value.stateSha256) {
    throw new RangeError("rain control state identity differs");
  }
  // preserve the exact 90-day, 45-day and two seven-day embargo boundaries
  if (![value.calibrationStartAt, value.calibrationEndAt, value.legacyCalibrationStartAt,
    value.trainingMaximumValidAt, value.generatedAt].every(validInstant) ||
      calibrationEnd - calibrationStart !== 90 * DAY_MILLISECONDS ||
      calibrationEnd - legacyStart !== 45 * DAY_MILLISECONDS ||
      monthStart - calibrationEnd !== 7 * DAY_MILLISECONDS ||
      trainingMaximum >= calibrationStart - 7 * DAY_MILLISECONDS ||
      generated < calibrationEnd || generated >= monthStart) {
    throw new RangeError("rain control state chronology differs");
  }
  // retain the exact reviewed scalar bounds and fallback value
  if (legacyScale < 0.5 || legacyScale > 2 || sameWindowScale < 0.1 ||
      sameWindowScale > 3 || recentScale < 0.1 || recentScale > 3 ||
      value.recentSupported !== (value.recentFallbackReason === "recent_calibration") ||
      (!value.recentSupported && recentScale !== sameWindowScale)) {
    throw new RangeError("rain control state scales differ");
  }
  validateSupport(value.support, value.recentSupported);
}

// bind one state to its exact portable ordinal artifact
export function validateRainMaintenanceControlArtifact(
  state: RainMaintenanceControlState,
  artifactBytes: Uint8Array,
): void {
  const bytes = Buffer.from(artifactBytes);
  const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = validateRainHurdleWindPortableArtifact(
    bytes.toString("utf8"),
    artifactSha256,
  );
  // keep the monthly state and fixed ordinal runtime on the same due month
  if (artifactSha256 !== state.ordinalArtifactSha256 ||
      artifact.modelMonth !== state.modelMonth ||
      !Buffer.from(canonicalJsonBytes(artifact as unknown as JsonValue)).equals(bytes)) {
    throw new RangeError("rain control ordinal artifact differs");
  }
}

// apply the retained controls without reading the future target
export function evaluateRainMaintenanceControls(input: Readonly<{
  artifactBytes: Uint8Array;
  features: Float32Array;
  persistencePrediction: number | null;
  rawPrecipitationMm: number;
  state: RainMaintenanceControlState;
}>): RainMaintenanceControlValues {
  validateRainMaintenanceControlState(input.state);
  validateRainMaintenanceControlArtifact(input.state, input.artifactBytes);
  const raw = input.rawPrecipitationMm;
  // reject invalid native rows before a fallback can conceal them
  if (!Number.isFinite(raw) || raw < 0 || input.features.length !== 107 ||
      input.features[5] !== Math.fround(raw) ||
      (input.persistencePrediction !== null &&
        (!Number.isFinite(input.persistencePrediction) || input.persistencePrediction < 0))) {
    throw new RangeError("rain control input differs");
  }
  const evaluateOrdinal = createRainHurdleWindPortableArtifactEvaluator(
    Buffer.from(input.artifactBytes).toString("utf8"),
    input.state.ordinalArtifactSha256,
  );
  const legacyScale = decodeMaintenanceBinary64(input.state.legacyRawScale64);
  const sameWindowScale = decodeMaintenanceBinary64(input.state.sameWindowRawScale64);
  const recentScale = decodeMaintenanceBinary64(input.state.recentRawScale64);
  return Object.freeze({
    nativeSourceProbability: Object.freeze({
      atLeast0_1: Number(raw >= 0.1),
      atLeast1_0: Number(raw >= 1),
      atLeast2_5: Number(raw >= 2.5),
    }),
    persistencePrediction: input.persistencePrediction ?? raw,
    persistenceReason: input.persistencePrediction === null
      ? "raw_fallback_unavailable"
      : "causal_target",
    recentVolumeScalePrediction: Math.min(30, raw * recentScale),
    sameWindowVolumeScalePrediction: Math.min(30, raw * sameWindowScale),
    unchangedOrdinalPrediction: evaluateOrdinal(input.features).correctedPrecipitationMm,
    volumeScalePrediction: raw * legacyScale,
  });
}

// validate exact closed support and retained fallback requirements
function validateSupport(
  value: RainMaintenanceControlSupport,
  recentSupported: boolean,
): void {
  const integerFields = SUPPORT_KEYS.filter((key) => !key.endsWith("64"));
  // keep all support counters nonnegative safe integers
  for (const field of integerFields) {
    const count = value[field];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new RangeError("rain control support differs");
    }
  }
  const effectiveDates = decodeMaintenanceBinary64(value.effectiveDates64);
  const effectiveWetDates = decodeMaintenanceBinary64(value.effectiveWetDates64);
  const minimum = RAIN_MAINTENANCE_CONTROL_RECIPE.support;
  const commonSupported = value.trainingDates >= minimum.trainingDates &&
    value.trainingHours >= minimum.trainingHours &&
    value.trainingWetDates >= minimum.trainingWetDates &&
    value.trainingWetHours >= minimum.trainingWetHours &&
    value.calibrationDates >= minimum.calibrationDates &&
    value.calibrationHours >= minimum.calibrationHours &&
    value.calibrationWetDates >= minimum.calibrationWetDates &&
    value.calibrationWetHours >= minimum.calibrationWetHours &&
    value.legacyTrainingRows >= 1_000 && value.legacyTrainingWetRows >= 100 &&
    value.legacyCalibrationRows >= 200;
  const effectiveSupported = effectiveDates >= 30 && effectiveWetDates >= 3;
  const expectedRecentSupport = commonSupported && effectiveSupported;
  // preserve fallback across every retained recent-support threshold
  if (recentSupported !== expectedRecentSupport ||
      value.trainingRows < value.trainingHours || value.calibrationRows < value.calibrationHours) {
    throw new RangeError("rain control support differs");
  }
}

// require one exact plain-object key set
function exactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  // reject arrays, custom prototypes and extension fields
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).sort().join("\n") !== [...keys].sort().join("\n")) {
    throw new RangeError(`${label} fields differ`);
  }
}

// recognize one canonical utc-millisecond instant
function validInstant(value: string): boolean {
  return UTC_MILLISECOND.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

// construct one validated state with canonical binary64 scalars and self hash
export function createRainMaintenanceControlState(input: Readonly<
  Omit<RainMaintenanceControlState, "legacyRawScale64" | "recentRawScale64" |
    "sameWindowRawScale64" | "stateSha256"> & {
      readonly legacyRawScale: number;
      readonly recentRawScale: number;
      readonly sameWindowRawScale: number;
    }
>): RainMaintenanceControlState {
  const unsigned = {
    calibrationEndAt: input.calibrationEndAt,
    calibrationStartAt: input.calibrationStartAt,
    contractVersion: input.contractVersion,
    epochWitnessSha256: input.epochWitnessSha256,
    generatedAt: input.generatedAt,
    legacyCalibrationStartAt: input.legacyCalibrationStartAt,
    legacyRawScale64: encodeMaintenanceBinary64(input.legacyRawScale),
    modelMonth: input.modelMonth,
    ordinalArtifactSha256: input.ordinalArtifactSha256,
    recentFallbackReason: input.recentFallbackReason,
    recentRawScale64: encodeMaintenanceBinary64(input.recentRawScale),
    recentSupported: input.recentSupported,
    recipeSha256: input.recipeSha256,
    sameWindowRawScale64: encodeMaintenanceBinary64(input.sameWindowRawScale),
    scheduleContractSha256: input.scheduleContractSha256,
    sourceMemberRootSha256: input.sourceMemberRootSha256,
    sourceReceiptRootSha256: input.sourceReceiptRootSha256,
    support: input.support,
    trainingMaximumValidAt: input.trainingMaximumValidAt,
  } as const;
  const state = Object.freeze({
    ...unsigned,
    stateSha256: canonicalSha256(unsigned as unknown as JsonValue),
  });
  validateRainMaintenanceControlState(state);
  return state;
}
