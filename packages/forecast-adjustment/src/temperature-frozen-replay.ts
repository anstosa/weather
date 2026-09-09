import { createHash } from "node:crypto";

import {
  FORECAST_LEAD_BANDS,
  forecastLeadBandFor,
  type ForecastAdjustmentCoefficient,
  type ForecastAdjustmentTrainingEnvelope,
  type ForecastLeadBandKey,
  type JsonValue,
} from "@weather/domain";

import {
  applyCappedCorrection,
  selectHierarchyCoefficient,
} from "./algorithm-v1.js";
import { canonicalSha256 } from "./candidate.js";
import {
  localCalendarFeaturesFor,
  type LocalDaypart,
  type LocalMeteorologicalSeason,
} from "./calendar.js";
import {
  analyzeTemperatureLeadResearch,
  type TemperatureLeadResearchCausalTrace,
} from "./temperature-lead-research.js";
import { TEMPERATURE_BOOSTED_FEATURE_NAMES } from "./temperature-weather-research.js";

// freeze the exact replay identity
export const TEMPERATURE_FROZEN_REPLAY_CONTRACT_VERSION =
  "temperature-frozen-hybrid-replay/v1" as const;

const MILLISECONDS_PER_HOUR = 3_600_000;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const DAYPARTS = new Set<LocalDaypart>([
  "afternoon",
  "evening",
  "morning",
  "night",
]);
const SEASONS = new Set<LocalMeteorologicalSeason>([
  "autumn",
  "spring",
  "summer",
  "winter",
]);
const HUMIDITY_BINS = new Set(["<50", "[50,80)", ">=80"]);
const WIND_BINS = new Set(["<2", "[2,5)", ">=5"]);
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

// describe one exact live replay event
export interface FrozenTemperatureReplayEvent {
  readonly actual: number;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// describe one retained broad-band baseline
export interface FrozenTemperatureBaselineFit {
  readonly coefficients: readonly ForecastAdjustmentCoefficient[];
  readonly pair: {
    readonly leadBand: ForecastLeadBandKey;
    readonly metric: "temperatureC";
  };
  readonly trainingEnvelope: ForecastAdjustmentTrainingEnvelope | null;
  readonly trainingEventCount: number;
}

// describe one retained raw-start temperature cell
export interface FrozenTemperatureStaticCell {
  readonly coefficient: number;
  readonly daypart: LocalDaypart;
  readonly effectiveEventCount: number;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly path: "raw_start";
  readonly rawCoefficient: number;
  readonly season: LocalMeteorologicalSeason;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly temperatureBin: number;
  readonly temperatureMaximumExclusiveC: number;
  readonly temperatureMinimumC: number;
}

// describe one retained raw-start weather cell
export interface FrozenTemperatureWeatherCell {
  readonly coefficient: number;
  readonly daypart: LocalDaypart;
  readonly effectiveEventCount: number;
  readonly humidityBin: "<50" | "[50,80)" | ">=80";
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly path: "raw_start";
  readonly rawCoefficient: number;
  readonly season: LocalMeteorologicalSeason;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly windSpeedBin: "<2" | "[2,5)" | ">=5";
}

// describe the minimum immutable replay material
export interface FrozenTemperatureReplayMaterial {
  readonly baseline: {
    readonly fitted: readonly FrozenTemperatureBaselineFit[];
  };
  readonly nativeCandidate: {
    readonly configJson: string;
    readonly configSha256: string;
    readonly featureSchemaSha256: string;
    readonly modelJson: string;
    readonly modelSha256: string;
  };
  readonly originalStaticModels: {
    readonly rawStart: {
      readonly temperature: readonly FrozenTemperatureStaticCell[];
      readonly weather: readonly FrozenTemperatureWeatherCell[];
    };
  };
}

// describe the pure native inference request
export interface FrozenTemperaturePredictRequest {
  readonly featureNames: typeof TEMPERATURE_BOOSTED_FEATURE_NAMES;
  readonly modelJson: string;
  readonly predictionFeatures: readonly (readonly (number | null)[])[];
  readonly predictionIds: readonly string[];
}

// describe the identity-bound native inference result
export interface FrozenTemperaturePredictResult {
  readonly predictedResiduals: readonly number[];
  readonly predictionIds: readonly string[];
}

// inject native prediction without fitting or filesystem access
export type FrozenTemperaturePredictor = (
  request: FrozenTemperaturePredictRequest,
) => FrozenTemperaturePredictResult;

// expose one replayed prediction without source model payloads
export interface FrozenTemperatureReplayRecord {
  readonly adaptivePrediction: number;
  readonly baselineEligible: boolean;
  readonly baselinePrediction: number;
  readonly boostedPrediction: number;
  readonly key: string;
  readonly originalInput: FrozenTemperatureReplayEvent;
  readonly priorPrediction: number;
  readonly selectedAlpha: 0 | 0.25 | 0.5 | 0.75 | 1;
  readonly staticPrediction: number;
}

// expose the complete deterministic replay
export interface FrozenTemperatureReplayResult {
  readonly causalTrace: readonly TemperatureLeadResearchCausalTrace[];
  readonly records: readonly FrozenTemperatureReplayRecord[];
}

interface PreparedReplayEvent extends FrozenTemperatureReplayEvent {
  readonly daypart: LocalDaypart;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly season: LocalMeteorologicalSeason;
  readonly temperatureBin: number;
}

interface PreparedPredictionEvent extends PreparedReplayEvent {
  readonly baselineEligible: boolean;
  readonly baselinePrediction: number;
  readonly staticPrediction: number;
}

interface ValidatedMaterial {
  readonly baselineByBand: ReadonlyMap<ForecastLeadBandKey, FrozenTemperatureBaselineFit>;
  readonly modelJson: string;
  readonly temperatureByKey: ReadonlyMap<string, FrozenTemperatureStaticCell>;
  readonly weatherByKey: ReadonlyMap<string, FrozenTemperatureWeatherCell>;
}

const EXACT_EVENT_KEYS = [
  "actual",
  "rawForecast",
  "rawRelativeHumidityPercent",
  "rawWindSpeedMps",
  "referenceAt",
  "targetLeadHours",
  "validAt",
] as const;

// require one non-array object
function requireRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  // reject null and collection material
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RangeError(`${field} must be an object`);
  }

  return value as Readonly<Record<string, unknown>>;
}

// require one finite numeric value
function requireFinite(value: unknown, field: string): number {
  // reject non-numeric model material
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

// require one nonnegative integer count
function requireCount(value: unknown, field: string): number {
  const count = requireFinite(value, field);

  // reject fractional or negative support
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`${field} must be a nonnegative integer`);
  }

  return count;
}

// normalize one canonical UTC instant
function normalizeUtcInstant(value: unknown, field: string): string {
  // reject offsets and malformed values
  if (
    typeof value !== "string" ||
    !UTC_INSTANT_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  const normalized = new Date(value).toISOString();

  // reject calendar rollover while allowing omitted zero milliseconds
  if (normalized !== value && normalized !== value.replace("Z", ".000Z")) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return normalized;
}

// require one nullable bounded feature
function requireNullableRange(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  // preserve explicit missing predictors
  if (value === null) {
    return null;
  }

  const numberValue = requireFinite(value, field);

  // reject features outside their frozen domains
  if (numberValue < minimum || numberValue > maximum) {
    throw new RangeError(`${field} must be null or between ${minimum} and ${maximum}`);
  }

  return numberValue;
}

// prepare one isolated replay event
function prepareEvent(value: unknown): PreparedReplayEvent {
  const event = requireRecord(value, "temperature replay event");
  const keys = Object.keys(event).sort();
  const expectedKeys = [...EXACT_EVENT_KEYS].sort();

  // bind inputs to the exact replay schema
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      // compare each sorted event field
      (key, index) => key !== expectedKeys[index],
    )
  ) {
    throw new RangeError("temperature replay event fields must match the frozen schema");
  }

  const validAt = normalizeUtcInstant(event.validAt, "validAt");
  const referenceAt = normalizeUtcInstant(event.referenceAt, "referenceAt");
  const validAtMilliseconds = Date.parse(validAt);
  const referenceAtMilliseconds = Date.parse(referenceAt);

  // require exact hourly targets
  if (validAtMilliseconds % MILLISECONDS_PER_HOUR !== 0) {
    throw new RangeError("validAt must be aligned to an exact UTC hour");
  }

  const targetLeadHours = requireFinite(event.targetLeadHours, "targetLeadHours");

  // require one supported integer lead
  if (!Number.isInteger(targetLeadHours) || targetLeadHours < 1 || targetLeadHours > 168) {
    throw new RangeError("targetLeadHours must be an integer between 1 and 168");
  }

  const continuousLeadHours =
    (validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR;

  // bind the observed retrieval to its claimed lead
  if (continuousLeadHours <= 0 || Math.ceil(continuousLeadHours) !== targetLeadHours) {
    throw new RangeError("targetLeadHours must match validAt and referenceAt");
  }

  const actual = requireFinite(event.actual, "actual");
  const rawForecast = requireFinite(event.rawForecast, "rawForecast");

  // constrain temperatures to the inherited physical domain
  if (actual < -100 || actual > 70 || rawForecast < -100 || rawForecast > 70) {
    throw new RangeError("temperature values must be between -100 and 70");
  }

  const rawRelativeHumidityPercent = requireNullableRange(
    event.rawRelativeHumidityPercent,
    "rawRelativeHumidityPercent",
    0,
    100,
  );
  const rawWindSpeedMps = requireNullableRange(
    event.rawWindSpeedMps,
    "rawWindSpeedMps",
    0,
    150,
  );
  const calendar = localCalendarFeaturesFor(validAt);

  return {
    actual,
    daypart: calendar.daypart,
    key: `${validAt}|${targetLeadHours}`,
    leadBand: forecastLeadBandFor(targetLeadHours),
    rawForecast,
    rawRelativeHumidityPercent,
    rawWindSpeedMps,
    referenceAt,
    season: calendar.season,
    targetLeadHours,
    temperatureBin: Math.floor(rawForecast / 5),
    validAt,
  };
}

// compare events independently from input order
function compareEvents(left: PreparedReplayEvent, right: PreparedReplayEvent): number {
  return left.validAt.localeCompare(right.validAt) ||
    left.targetLeadHours - right.targetLeadHours ||
    left.referenceAt.localeCompare(right.referenceAt);
}

// prepare one canonical event inventory
function prepareEvents(events: readonly FrozenTemperatureReplayEvent[]): readonly PreparedReplayEvent[] {
  // require a usable calibration cohort
  if (!Array.isArray(events) || events.length === 0) {
    throw new RangeError("events must be a non-empty array");
  }

  const prepared = events.map(
    // isolate each caller-owned event
    (event) => prepareEvent(event),
  ).sort(compareEvents);
  const identities = new Set<string>();

  // reject unresolved canonical duplicates
  for (const event of prepared) {
    // require one row per valid-time and lead
    if (identities.has(event.key)) {
      throw new RangeError("events must have unique validAt and targetLeadHours identities");
    }

    identities.add(event.key);
  }

  return prepared;
}

// validate one hierarchy coefficient
function validateCoefficient(
  value: unknown,
  expectedLeadBand: ForecastLeadBandKey,
  identities: Set<string>,
): ForecastAdjustmentCoefficient {
  const coefficient = requireRecord(value, "baseline coefficient") as unknown as
    ForecastAdjustmentCoefficient;
  requireFinite(coefficient.coefficient, "baseline coefficient coefficient");
  requireFinite(coefficient.effectiveEventCount, "baseline coefficient effectiveEventCount");

  // bind every coefficient to the expected metric and band
  if (coefficient.metric !== "temperatureC" || coefficient.leadBand !== expectedLeadBand) {
    throw new RangeError("baseline coefficient metric and leadBand must match its fit");
  }

  // require one frozen hierarchy level
  if (coefficient.level !== 1 && coefficient.level !== 2 && coefficient.level !== 3) {
    throw new RangeError("baseline coefficient level must be 1, 2, or 3");
  }

  // validate nullable calendar dimensions
  if (coefficient.daypart !== null && !DAYPARTS.has(coefficient.daypart)) {
    throw new RangeError("baseline coefficient daypart is invalid");
  }

  // validate nullable seasons
  if (coefficient.season !== null && !SEASONS.has(coefficient.season)) {
    throw new RangeError("baseline coefficient season is invalid");
  }

  // validate nullable months
  if (
    coefficient.month !== null &&
    (!Number.isInteger(coefficient.month) || coefficient.month < 1 || coefficient.month > 12)
  ) {
    throw new RangeError("baseline coefficient month is invalid");
  }

  const shapeValid = coefficient.level === 1
    ? coefficient.daypart === null && coefficient.season === null && coefficient.month === null
    : coefficient.level === 2
      ? coefficient.daypart !== null && coefficient.season !== null && coefficient.month === null
      : coefficient.daypart !== null && coefficient.season === null && coefficient.month !== null;

  // reject ambiguous hierarchy selectors
  if (!shapeValid) {
    throw new RangeError("baseline coefficient hierarchy shape is invalid");
  }

  const identity = [
    coefficient.level,
    coefficient.daypart,
    coefficient.season,
    coefficient.month,
  ].join("|");

  // reject duplicate hierarchy selectors
  if (identities.has(identity)) {
    throw new RangeError("baseline coefficients must have unique hierarchy identities");
  }

  identities.add(identity);
  return coefficient;
}

// validate one baseline fit
function validateBaselineFit(value: unknown): FrozenTemperatureBaselineFit {
  const fit = requireRecord(value, "baseline fit");
  const pair = requireRecord(fit.pair, "baseline pair");

  // require one temperature lead-band pair
  if (pair.metric !== "temperatureC" || typeof pair.leadBand !== "string") {
    throw new RangeError("baseline pair must identify one temperature lead band");
  }

  const leadBand = forecastLeadBandFor(
    FORECAST_LEAD_BANDS.find(
      // locate the retained band identity
      (band) => band.key === pair.leadBand,
    )?.minimumHours ?? 0,
  );

  // reject a mismatched normalized band
  if (leadBand !== pair.leadBand) {
    throw new RangeError("baseline pair leadBand is invalid");
  }

  requireCount(fit.trainingEventCount, "baseline trainingEventCount");

  // require one coefficient array
  if (!Array.isArray(fit.coefficients)) {
    throw new RangeError("baseline coefficients must be an array");
  }

  const coefficientIdentities = new Set<string>();

  // validate every retained hierarchy cell
  for (const coefficient of fit.coefficients) {
    validateCoefficient(coefficient, leadBand, coefficientIdentities);
  }

  let trainingEnvelope: ForecastAdjustmentTrainingEnvelope | null = null;

  // validate the optional raw-temperature envelope
  if (fit.trainingEnvelope !== null) {
    const envelope = requireRecord(fit.trainingEnvelope, "baseline trainingEnvelope");
    const minimum = requireFinite(envelope.minimum, "baseline envelope minimum");
    const maximum = requireFinite(envelope.maximum, "baseline envelope maximum");

    // bind the envelope to its fit and ordered range
    if (
      envelope.metric !== "temperatureC" ||
      envelope.leadBand !== leadBand ||
      minimum > maximum
    ) {
      throw new RangeError("baseline trainingEnvelope is invalid");
    }

    trainingEnvelope = envelope as unknown as ForecastAdjustmentTrainingEnvelope;
  }

  return {
    coefficients: fit.coefficients as unknown as readonly ForecastAdjustmentCoefficient[],
    pair: { leadBand, metric: "temperatureC" },
    trainingEnvelope,
    trainingEventCount: fit.trainingEventCount as number,
  };
}

// validate one common static-cell support payload
function validateStaticSupport(cell: Readonly<Record<string, unknown>>, field: string): void {
  requireFinite(cell.coefficient, `${field} coefficient`);
  requireFinite(cell.rawCoefficient, `${field} rawCoefficient`);
  requireCount(cell.effectiveEventCount, `${field} effectiveEventCount`);
  requireCount(cell.supportLocalDateCount, `${field} supportLocalDateCount`);
  requireCount(cell.supportUniqueValidHours, `${field} supportUniqueValidHours`);

  // require one raw-start frozen path
  if (cell.path !== "raw_start") {
    throw new RangeError(`${field} path must be raw_start`);
  }

  // require supported calendar labels
  if (!DAYPARTS.has(cell.daypart as LocalDaypart) || !SEASONS.has(cell.season as LocalMeteorologicalSeason)) {
    throw new RangeError(`${field} calendar fields are invalid`);
  }

  // require one supported lead-band label
  if (!FORECAST_LEAD_BANDS.some((band) => band.key === cell.leadBand)) {
    throw new RangeError(`${field} leadBand is invalid`);
  }
}

// validate raw-start temperature cells
function validateTemperatureCells(
  value: unknown,
): ReadonlyMap<string, FrozenTemperatureStaticCell> {
  // require one retained cell inventory
  if (!Array.isArray(value)) {
    throw new RangeError("raw-start temperature cells must be an array");
  }

  const byKey = new Map<string, FrozenTemperatureStaticCell>();

  // validate each exact lookup cell
  for (const item of value) {
    const cell = requireRecord(item, "raw-start temperature cell");
    validateStaticSupport(cell, "raw-start temperature cell");
    const temperatureBin = requireFinite(cell.temperatureBin, "temperatureBin");
    const minimum = requireFinite(cell.temperatureMinimumC, "temperatureMinimumC");
    const maximum = requireFinite(
      cell.temperatureMaximumExclusiveC,
      "temperatureMaximumExclusiveC",
    );

    // bind the five-degree bin boundaries
    if (
      !Number.isInteger(temperatureBin) ||
      minimum !== temperatureBin * 5 ||
      maximum !== minimum + 5
    ) {
      throw new RangeError("raw-start temperature cell bin is invalid");
    }

    const key = [cell.leadBand, cell.season, cell.daypart, temperatureBin].join("|");

    // bind and deduplicate the serialized lookup key
    if (cell.key !== key || byKey.has(key)) {
      throw new RangeError("raw-start temperature cell key is invalid or duplicate");
    }

    byKey.set(key, cell as unknown as FrozenTemperatureStaticCell);
  }

  return byKey;
}

// validate raw-start weather cells
function validateWeatherCells(
  value: unknown,
): ReadonlyMap<string, FrozenTemperatureWeatherCell> {
  // require one retained cell inventory
  if (!Array.isArray(value)) {
    throw new RangeError("raw-start weather cells must be an array");
  }

  const byKey = new Map<string, FrozenTemperatureWeatherCell>();

  // validate each exact lookup cell
  for (const item of value) {
    const cell = requireRecord(item, "raw-start weather cell");
    validateStaticSupport(cell, "raw-start weather cell");

    // require supported nonmissing regimes
    if (
      !HUMIDITY_BINS.has(cell.humidityBin as string) ||
      !WIND_BINS.has(cell.windSpeedBin as string)
    ) {
      throw new RangeError("raw-start weather cell regime is invalid");
    }

    const key = [
      cell.leadBand,
      cell.season,
      cell.daypart,
      cell.humidityBin,
      cell.windSpeedBin,
    ].join("|");

    // bind and deduplicate the serialized lookup key
    if (cell.key !== key || byKey.has(key)) {
      throw new RangeError("raw-start weather cell key is invalid or duplicate");
    }

    byKey.set(key, cell as unknown as FrozenTemperatureWeatherCell);
  }

  return byKey;
}

// reject nonfinite values in parsed native JSON
function validateFiniteJson(value: unknown, field: string): void {
  // validate numeric leaves
  if (typeof value === "number") {
    // reject nonfinite native material
    if (!Number.isFinite(value)) {
      throw new RangeError(`${field} must contain only finite numbers`);
    }

    return;
  }

  // inspect every array element
  if (Array.isArray(value)) {
    // validate nested array material
    for (const item of value) {
      validateFiniteJson(item, field);
    }

    return;
  }

  // inspect every object property
  if (value !== null && typeof value === "object") {
    // validate nested object material
    for (const item of Object.values(value)) {
      validateFiniteJson(item, field);
    }
  }
}

// validate one native JSON string without normalizing bytes
function validateNativeJson(value: unknown, field: string, requireObjectValue: boolean): string {
  // require retained JSON bytes
  if (typeof value !== "string") {
    throw new RangeError(`${field} must be a JSON string`);
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    // reject malformed native JSON
    throw new RangeError(`${field} must contain valid JSON`);
  }

  validateFiniteJson(parsed, field);

  // require the fitted model root object
  if (
    requireObjectValue &&
    (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    throw new RangeError(`${field} must contain a JSON object`);
  }

  return value;
}

// validate one lowercase SHA-256 digest
function validateSha256(value: unknown, field: string): string {
  // reject malformed retained digests
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new RangeError(`${field} must be a lowercase SHA-256 digest`);
  }

  return value;
}

// validate and index the frozen replay material
function validateMaterial(value: unknown): ValidatedMaterial {
  const material = requireRecord(value, "temperature replay material");
  const baseline = requireRecord(material.baseline, "temperature replay baseline");

  // require the complete seven-band baseline inventory
  if (!Array.isArray(baseline.fitted) || baseline.fitted.length !== FORECAST_LEAD_BANDS.length) {
    throw new RangeError("baseline fitted material must contain all seven lead bands");
  }

  const baselineByBand = new Map<ForecastLeadBandKey, FrozenTemperatureBaselineFit>();

  // validate and index each broad-band baseline
  for (const valueFit of baseline.fitted) {
    const fit = validateBaselineFit(valueFit);

    // reject duplicate retained bands
    if (baselineByBand.has(fit.pair.leadBand)) {
      throw new RangeError("baseline fitted lead bands must be unique");
    }

    baselineByBand.set(fit.pair.leadBand, fit);
  }

  // require every configured lead band
  for (const band of FORECAST_LEAD_BANDS) {
    // fail closed on incomplete retained material
    if (!baselineByBand.has(band.key)) {
      throw new RangeError("baseline fitted material omitted a lead band");
    }
  }

  const staticModels = requireRecord(
    material.originalStaticModels,
    "originalStaticModels",
  );
  const rawStart = requireRecord(staticModels.rawStart, "originalStaticModels.rawStart");
  const temperatureByKey = validateTemperatureCells(rawStart.temperature);
  const weatherByKey = validateWeatherCells(rawStart.weather);
  const nativeCandidate = requireRecord(material.nativeCandidate, "nativeCandidate");
  const modelJson = validateNativeJson(nativeCandidate.modelJson, "modelJson", true);
  const configJson = validateNativeJson(nativeCandidate.configJson, "configJson", false);
  const modelSha256 = validateSha256(nativeCandidate.modelSha256, "modelSha256");
  const configSha256 = validateSha256(nativeCandidate.configSha256, "configSha256");
  const featureSchemaSha256 = validateSha256(
    nativeCandidate.featureSchemaSha256,
    "featureSchemaSha256",
  );

  // bind exact retained native bytes
  if (createHash("sha256").update(modelJson).digest("hex") !== modelSha256) {
    throw new RangeError("modelSha256 does not match modelJson");
  }

  // bind exact retained native configuration bytes
  if (createHash("sha256").update(configJson).digest("hex") !== configSha256) {
    throw new RangeError("configSha256 does not match configJson");
  }

  // bind the native predictor schema
  if (
    canonicalSha256(TEMPERATURE_BOOSTED_FEATURE_NAMES as unknown as JsonValue) !==
    featureSchemaSha256
  ) {
    throw new RangeError("featureSchemaSha256 does not match the frozen feature schema");
  }

  return { baselineByBand, modelJson, temperatureByKey, weatherByKey };
}

// classify one humidity predictor
function humidityBinFor(value: number | null): "<50" | "[50,80)" | ">=80" | null {
  // preserve missing humidity
  if (value === null) {
    return null;
  }

  // isolate dry conditions
  if (value < 50) {
    return "<50";
  }

  // isolate moderate humidity
  if (value < 80) {
    return "[50,80)";
  }

  return ">=80";
}

// classify one wind predictor
function windBinFor(value: number | null): "<2" | "[2,5)" | ">=5" | null {
  // preserve missing wind
  if (value === null) {
    return null;
  }

  // isolate calm conditions
  if (value < 2) {
    return "<2";
  }

  // isolate moderate wind
  if (value < 5) {
    return "[2,5)";
  }

  return ">=5";
}

// constrain one cumulative residual prediction
function finalPrediction(rawForecast: number, totalDelta: number): number {
  const cappedDelta = Math.min(5, Math.max(-5, totalDelta));
  return Math.min(70, Math.max(-100, rawForecast + cappedDelta));
}

// reconstruct baseline eligibility and the raw-start static prediction
function reconstructStaticPrediction(
  event: PreparedReplayEvent,
  material: ValidatedMaterial,
): PreparedPredictionEvent {
  const fit = material.baselineByBand.get(event.leadBand);

  // guard the validated complete baseline map
  if (fit === undefined) {
    throw new Error("temperature replay baseline lead band disappeared");
  }

  const coefficient = selectHierarchyCoefficient(
    fit.coefficients,
    "temperatureC",
    event.leadBand,
    localCalendarFeaturesFor(event.validAt),
  );
  const envelope = fit.trainingEnvelope;
  const baselineEligible = coefficient !== null &&
    envelope !== null &&
    event.rawForecast >= envelope.minimum &&
    event.rawForecast <= envelope.maximum;

  // preserve the exact raw fallback outside baseline support
  if (!baselineEligible || coefficient === null) {
    return {
      ...event,
      baselineEligible: false,
      baselinePrediction: event.rawForecast,
      staticPrediction: event.rawForecast,
    };
  }

  const baselinePrediction = applyCappedCorrection(
    "temperatureC",
    event.rawForecast,
    coefficient,
  );
  const temperatureKey = [
    event.leadBand,
    event.season,
    event.daypart,
    event.temperatureBin,
  ].join("|");
  const humidityBin = humidityBinFor(event.rawRelativeHumidityPercent);
  const windBin = windBinFor(event.rawWindSpeedMps);
  const weatherKey = humidityBin === null || windBin === null
    ? null
    : [event.leadBand, event.season, event.daypart, humidityBin, windBin].join("|");
  const temperatureCorrection =
    material.temperatureByKey.get(temperatureKey)?.coefficient ?? 0;
  const weatherCorrection = weatherKey === null
    ? 0
    : material.weatherByKey.get(weatherKey)?.coefficient ?? 0;

  return {
    ...event,
    baselineEligible: true,
    baselinePrediction,
    staticPrediction: finalPrediction(
      event.rawForecast,
      temperatureCorrection + weatherCorrection,
    ),
  };
}

// encode one native feature row without its observed outcome
function featureRow(event: PreparedReplayEvent): readonly (number | null)[] {
  return [
    event.rawForecast,
    event.rawRelativeHumidityPercent,
    event.rawWindSpeedMps,
    event.targetLeadHours,
    event.season === "winter" ? 1 : 0,
    event.season === "spring" ? 1 : 0,
    event.season === "summer" ? 1 : 0,
    event.season === "autumn" ? 1 : 0,
    event.daypart === "night" ? 1 : 0,
    event.daypart === "morning" ? 1 : 0,
    event.daypart === "afternoon" ? 1 : 0,
    event.daypart === "evening" ? 1 : 0,
  ];
}

// create one immutable inference-only request
function createPredictRequest(
  events: readonly PreparedPredictionEvent[],
  modelJson: string,
): FrozenTemperaturePredictRequest {
  return Object.freeze({
    featureNames: Object.freeze([...TEMPERATURE_BOOSTED_FEATURE_NAMES]) as unknown as
      typeof TEMPERATURE_BOOSTED_FEATURE_NAMES,
    modelJson,
    predictionFeatures: Object.freeze(events.map(
      // preserve the complete original score denominator
      (event) => Object.freeze([...featureRow(event)]),
    )),
    predictionIds: Object.freeze(events.map(
      // retain every canonical result identity
      (event) => event.key,
    )),
  });
}

// validate and bind one native result
function indexNativePredictions(
  value: unknown,
  expectedIds: readonly string[],
): ReadonlyMap<string, number> {
  const result = requireRecord(value, "temperature predictor result");
  const keys = Object.keys(result).sort();

  // require the exact inference result schema
  if (
    keys.length !== 2 ||
    keys[0] !== "predictedResiduals" ||
    keys[1] !== "predictionIds"
  ) {
    throw new RangeError("temperature predictor result fields must match the frozen schema");
  }

  // bind each echoed identity to request order
  if (
    !Array.isArray(result.predictionIds) ||
    result.predictionIds.length !== expectedIds.length ||
    result.predictionIds.some(
      // compare each native identity
      (id, index) => id !== expectedIds[index],
    )
  ) {
    throw new RangeError("temperature predictor predictionIds must match request order");
  }

  // require one finite residual per identity
  if (
    !Array.isArray(result.predictedResiduals) ||
    result.predictedResiduals.length !== expectedIds.length ||
    result.predictedResiduals.some(
      // reject invalid native predictions
      (prediction) => typeof prediction !== "number" || !Number.isFinite(prediction),
    )
  ) {
    throw new RangeError("temperature predictor residuals must be finite and complete");
  }

  const byKey = new Map<string, number>();

  // index every validated native residual
  for (let index = 0; index < expectedIds.length; index += 1) {
    const key = expectedIds[index];
    const residual = result.predictedResiduals[index];

    // guard the validated parallel arrays
    if (key === undefined || residual === undefined) {
      throw new Error("temperature predictor result snapshot is incomplete");
    }

    byKey.set(key, residual as number);
  }

  return byKey;
}

// freeze one isolated original input record
function freezeOriginalInput(event: PreparedReplayEvent): FrozenTemperatureReplayEvent {
  return Object.freeze({
    actual: event.actual,
    rawForecast: event.rawForecast,
    rawRelativeHumidityPercent: event.rawRelativeHumidityPercent,
    rawWindSpeedMps: event.rawWindSpeedMps,
    referenceAt: event.referenceAt,
    targetLeadHours: event.targetLeadHours,
    validAt: event.validAt,
  });
}

// replay the immutable boosted hybrid without fitting
export function replayFrozenTemperatureHybrid(
  events: readonly FrozenTemperatureReplayEvent[],
  material: FrozenTemperatureReplayMaterial,
  predict: FrozenTemperaturePredictor,
): FrozenTemperatureReplayResult {
  const prepared = prepareEvents(events);
  const validatedMaterial = validateMaterial(material);

  // require one explicit native inference boundary
  if (typeof predict !== "function") {
    throw new RangeError("temperature predictor must be a function");
  }

  const predicted = prepared.map(
    // reconstruct each static prediction before calibration
    (event) => reconstructStaticPrediction(event, validatedMaterial),
  );
  const calibration = analyzeTemperatureLeadResearch(predicted.map(
    // expose only the inherited calibration fields
    (event) => ({
      actual: event.actual,
      baselineAdjusted: event.staticPrediction,
      rawForecast: event.rawForecast,
      referenceAt: event.referenceAt,
      targetLeadHours: event.targetLeadHours,
      validAt: event.validAt,
    }),
  ));
  const selectionByKey = new Map<string, TemperatureLeadResearchCausalTrace>();

  // bind every causal selection to its forecast identity
  for (const selection of calibration.causalTrace) {
    const key = `${selection.validAt}|${selection.targetLeadHours}`;

    // reject impossible duplicate selections
    if (selectionByKey.has(key)) {
      throw new Error("temperature replay calibration produced duplicate selections");
    }

    selectionByKey.set(key, selection);
  }

  // require one selection for every replay event
  if (selectionByKey.size !== predicted.length) {
    throw new Error("temperature replay calibration omitted selections");
  }

  const request = createPredictRequest(predicted, validatedMaterial.modelJson);
  const nativeByKey = indexNativePredictions(
    predict(request),
    request.predictionIds,
  );
  const records = predicted.map(
    // combine the frozen components at the original horizon gate
    (event): FrozenTemperatureReplayRecord => {
      const selection = selectionByKey.get(event.key);

      // guard the complete calibration map
      if (selection === undefined) {
        throw new Error("temperature replay causal selection is missing");
      }

      const residual = nativeByKey.get(event.key);

      // require native parity for every eligible event
      if (event.baselineEligible && residual === undefined) {
        throw new Error("temperature replay native prediction is missing");
      }

      const adaptivePrediction = event.rawForecast +
        selection.selectedAlpha * (event.staticPrediction - event.rawForecast);
      const boostedPrediction = event.baselineEligible && residual !== undefined
        ? finalPrediction(event.rawForecast, residual)
        : event.rawForecast;
      const priorPrediction = event.targetLeadHours <= 48
        ? adaptivePrediction
        : boostedPrediction;

      return Object.freeze({
        adaptivePrediction,
        baselineEligible: event.baselineEligible,
        baselinePrediction: event.baselinePrediction,
        boostedPrediction,
        key: event.key,
        originalInput: freezeOriginalInput(event),
        priorPrediction,
        selectedAlpha: selection.selectedAlpha,
        staticPrediction: event.staticPrediction,
      });
    },
  );
  const causalTrace = calibration.causalTrace.map(
    // isolate each trace from the source analysis
    (selection) => Object.freeze({ ...selection }),
  );

  return Object.freeze({
    causalTrace: Object.freeze(causalTrace),
    records: Object.freeze(records),
  });
}
