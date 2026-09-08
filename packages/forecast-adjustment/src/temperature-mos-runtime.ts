import { localCalendarFeaturesFor } from "./calendar.js";

// provide a pure inference core with no artifact loading or external I/O
// match supported python predictions while unsupported strength fails raw instead of retaining half strength

// freeze the initialization-relative inference policy
export const TEMPERATURE_MOS_RUNTIME_POLICY = Object.freeze({
  cohort: "ecmwf_single_run_hindcast",
  correctionWeight: 0.5,
  maximumCorrectionC: 3,
  maximumModelLeadHours: 12,
  minimumModelLeadHours: 1,
  physicalMaximumC: 70,
  physicalMinimumC: -100,
  scope: "initialization_first12",
  sourceDelayHours: 7,
} as const);

// freeze the six-hour availability transfer policy
export const TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY = Object.freeze({
  cohort: "ecmwf_single_run_hindcast",
  correctionWeight: 0.5,
  maximumCorrectionC: 3,
  maximumModelLeadHours: 18,
  minimumModelLeadHours: 7,
  physicalMaximumC: 70,
  physicalMinimumC: -100,
  scope: "assumed_delay6_next12",
  sourceDelayHours: 7,
  operationalDelayHours: 6,
} as const);

const SHORT_LEAD_CONTRACT_VERSION =
  "temperature-shortlead-models-research/v1" as const;
const STRENGTH_CONTRACT_VERSION =
  "temperature-winner-extensions-research/v1" as const;
const MILLISECONDS_PER_HOUR = 3_600_000;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ALPHA_GRID = new Set([0.35, 0.5, 0.65, 0.8, 1]);
const ECMWF_CYCLE_HOURS = new Set([0, 6, 12, 18]);
const ECMWF_50R1_CUTOVER_MILLISECONDS = Date.parse(
  "2026-05-12T06:00:00.000Z",
);

// describe one initialization-relative ecmwf forecast
export interface TemperatureMosRuntimeForecast {
  readonly cohort: typeof TEMPERATURE_MOS_RUNTIME_POLICY.cohort;
  readonly key: string;
  readonly modelCycle: "49r1" | "50r1";
  readonly modelLeadHours: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawTemperatureC: number;
  readonly rawWindSpeedMps: number | null;
  readonly runInitializedAt: string;
  readonly validAt: string;
}

// describe one caller-supplied causal error-state receipt
export interface TemperatureMosRuntimeRecentErrorState {
  readonly b24C: number | null;
  readonly b72C: number | null;
  readonly cohort: typeof TEMPERATURE_MOS_RUNTIME_POLICY.cohort;
  readonly localDates: number;
  readonly mad72C: number | null;
  readonly maximumSourceRunInitializedAt: string | null;
  readonly maximumSourceValidAt: string | null;
  readonly n24: number;
  readonly n72: number;
  readonly sourceKeys: readonly string[];
  readonly supported: boolean;
  readonly targetRunInitializedAt: string;
  readonly windowEndValidAt: string;
}

// describe one learned correction-strength receipt
export interface TemperatureMosRuntimeStrengthBand {
  readonly alpha: number;
  readonly supported: boolean;
  readonly trainingCutoffUtc: string;
}

// describe the frozen winner material required for inference
export interface TemperatureMosRuntimeModel {
  readonly adaptiveCoefficients: readonly number[] | null;
  readonly cohort: typeof TEMPERATURE_MOS_RUNTIME_POLICY.cohort;
  readonly contractVersion: typeof SHORT_LEAD_CONTRACT_VERSION;
  readonly directCoefficients: readonly number[] | null;
  readonly learnedStrengthContractVersion: typeof STRENGTH_CONTRACT_VERSION;
  readonly month: string;
  readonly scope:
    | typeof TEMPERATURE_MOS_RUNTIME_POLICY.scope
    | typeof TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope;
  readonly strengthBands: {
    readonly "1-6": TemperatureMosRuntimeStrengthBand;
    readonly "7-12": TemperatureMosRuntimeStrengthBand;
  };
  readonly supported: boolean;
  readonly trainingCutoffUtc: string;
}

// bind every inference dependency explicitly
export interface TemperatureMosRuntimeInput {
  readonly forecast: TemperatureMosRuntimeForecast;
  readonly model: TemperatureMosRuntimeModel;
  readonly recentErrorState: TemperatureMosRuntimeRecentErrorState;
}

// enumerate every raw-preserving rejection
export type TemperatureMosRuntimeRawReason =
  | "invalid_forecast"
  | "inference_error"
  | "invalid_model"
  | "invalid_recent_error_state"
  | "model_identity_mismatch"
  | "model_not_supported"
  | "model_not_yet_available"
  | "outside_assumed_delay6_next12"
  | "outside_initialization_first12"
  | "recent_error_state_as_of_mismatch"
  | "recent_error_state_contains_future_data"
  | "recent_error_state_outside_window"
  | "recent_error_state_run_mismatch"
  | "recent_error_state_source_run_mismatch"
  | "strength_band_not_supported"
  | "unsupported_cohort";

// report one applied winner prediction
export interface TemperatureMosRuntimeAppliedResult {
  readonly alpha: number;
  readonly applied: true;
  readonly branch: "adaptive" | "direct";
  readonly incumbentHalfStrengthTemperatureC: number;
  readonly predictionTemperatureC: number;
  readonly rawTemperatureC: number;
  readonly reason: null;
  readonly unscaledCorrectionC: number;
}

// report one exact raw fallback
export interface TemperatureMosRuntimeRawResult {
  readonly applied: false;
  readonly predictionTemperatureC: number;
  readonly rawTemperatureC: number;
  readonly reason: TemperatureMosRuntimeRawReason;
}

export type TemperatureMosRuntimeResult =
  | TemperatureMosRuntimeAppliedResult
  | TemperatureMosRuntimeRawResult;

// carry one controlled fail-raw reason
class TemperatureMosRuntimeFailure extends Error {
  readonly reason: TemperatureMosRuntimeRawReason;

  // retain the exact public reason
  constructor(reason: TemperatureMosRuntimeRawReason) {
    super(reason);
    this.reason = reason;
  }
}

// stop validation with one controlled reason
function fail(reason: TemperatureMosRuntimeRawReason): never {
  throw new TemperatureMosRuntimeFailure(reason);
}

// preserve the supplied raw value exactly
function rawResult(
  rawTemperatureC: number,
  reason: TemperatureMosRuntimeRawReason,
): TemperatureMosRuntimeRawResult {
  return {
    applied: false,
    predictionTemperatureC: rawTemperatureC,
    rawTemperatureC,
    reason,
  };
}

// parse one canonical millisecond utc instant
function instantMilliseconds(
  value: string,
  reason: TemperatureMosRuntimeRawReason,
): number {
  // reject offsets, normalization, and invalid instants
  if (
    typeof value !== "string" ||
    !UTC_INSTANT_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail(reason);
  }

  return Date.parse(value);
}

// require one finite number
function finiteNumber(
  value: number,
  reason: TemperatureMosRuntimeRawReason,
): number {
  // reject nonnumeric and nonfinite values
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(reason);
  }

  return value;
}

// determine gregorian leap-year length
function daysInYear(year: number): number {
  // apply the gregorian leap rule
  if (year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)) {
    return 366;
  }

  return 365;
}

// calculate zero-based gregorian day-of-year
function dayOfYear(localDate: string): number {
  const year = Number(localDate.slice(0, 4));
  const start = Date.UTC(year, 0, 1);
  const current = Date.parse(`${localDate}T00:00:00.000Z`);

  // reject incomplete local-calendar output
  if (!Number.isInteger(year) || !Number.isFinite(current)) {
    fail("invalid_forecast");
  }

  return (current - start) / (24 * MILLISECONDS_PER_HOUR);
}

// validate the initialization-relative forecast identity
function validateForecast(
  forecast: TemperatureMosRuntimeForecast,
  scope: TemperatureMosRuntimeModel["scope"],
): {
  readonly runInitializedAtMilliseconds: number;
} {
  // isolate the only fitted provider cohort
  if (forecast.cohort !== TEMPERATURE_MOS_RUNTIME_POLICY.cohort) {
    fail("unsupported_cohort");
  }

  // require durable event and cycle identity
  if (
    typeof forecast.key !== "string" ||
    forecast.key.length === 0 ||
    typeof forecast.modelCycle !== "string" ||
    forecast.modelCycle.length === 0
  ) {
    fail("invalid_forecast");
  }

  const runInitializedAtMilliseconds = instantMilliseconds(
    forecast.runInitializedAt,
    "invalid_forecast",
  );
  const validAtMilliseconds = instantMilliseconds(
    forecast.validAt,
    "invalid_forecast",
  );
  finiteNumber(forecast.rawTemperatureC, "invalid_forecast");
  const initializedAt = new Date(runInitializedAtMilliseconds);

  // require an authentic six-hour ecmwf initialization boundary
  if (
    !ECMWF_CYCLE_HOURS.has(initializedAt.getUTCHours()) ||
    initializedAt.getUTCMinutes() !== 0 ||
    initializedAt.getUTCSeconds() !== 0 ||
    initializedAt.getUTCMilliseconds() !== 0
  ) {
    fail("invalid_forecast");
  }

  const expectedModelCycle =
    runInitializedAtMilliseconds >= ECMWF_50R1_CUTOVER_MILLISECONDS
      ? "50r1"
      : "49r1";

  // bind the model-era predictor to the acquisition cutover
  if (forecast.modelCycle !== expectedModelCycle) {
    fail("invalid_forecast");
  }

  // require finite optional weather features
  if (
    (forecast.rawRelativeHumidityPercent !== null &&
      !Number.isFinite(forecast.rawRelativeHumidityPercent)) ||
    (forecast.rawWindSpeedMps !== null &&
      !Number.isFinite(forecast.rawWindSpeedMps))
  ) {
    fail("invalid_forecast");
  }

  const minimumModelLeadHours = scope === TEMPERATURE_MOS_RUNTIME_POLICY.scope
    ? TEMPERATURE_MOS_RUNTIME_POLICY.minimumModelLeadHours
    : TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.minimumModelLeadHours;
  const maximumModelLeadHours = scope === TEMPERATURE_MOS_RUNTIME_POLICY.scope
    ? TEMPERATURE_MOS_RUNTIME_POLICY.maximumModelLeadHours
    : TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.maximumModelLeadHours;

  // limit inference to the selected frozen scope
  if (
    !Number.isInteger(forecast.modelLeadHours) ||
    forecast.modelLeadHours < minimumModelLeadHours ||
    forecast.modelLeadHours > maximumModelLeadHours
  ) {
    fail(
      scope === TEMPERATURE_MOS_RUNTIME_POLICY.scope
        ? "outside_initialization_first12"
        : "outside_assumed_delay6_next12",
    );
  }

  // bind the labeled lead to actual model initialization
  if (
    validAtMilliseconds - runInitializedAtMilliseconds !==
    forecast.modelLeadHours * MILLISECONDS_PER_HOUR
  ) {
    fail("invalid_forecast");
  }

  return { runInitializedAtMilliseconds };
}

// validate one original fitted coefficient vector
function validateCoefficients(
  coefficients: readonly number[] | null,
  width: number,
): readonly number[] {
  // require the exact frozen schema width
  if (!Array.isArray(coefficients) || coefficients.length !== width) {
    fail("invalid_model");
  }

  // reject any nonfinite fitted coefficient
  if (coefficients.some((coefficient) => !Number.isFinite(coefficient))) {
    fail("invalid_model");
  }

  return coefficients;
}

// validate one learned-strength band
function validateStrengthBand(
  band: TemperatureMosRuntimeStrengthBand,
  runInitializedAtMilliseconds: number,
): number {
  // require explicit support and a frozen-grid alpha
  if (
    band === null ||
    typeof band !== "object" ||
    typeof band.supported !== "boolean" ||
    !ALPHA_GRID.has(band.alpha)
  ) {
    fail("invalid_model");
  }

  const cutoff = instantMilliseconds(band.trainingCutoffUtc, "invalid_model");

  // reject same-run or future fitting data
  if (cutoff >= runInitializedAtMilliseconds) {
    fail("model_not_yet_available");
  }

  return cutoff;
}

// bind one cutoff to the exact local month embargo
function cutoffMatchesMonth(cutoff: number, month: string): boolean {
  const cutoffDate = new Date(cutoff);
  const monthStart = cutoff + 168 * MILLISECONDS_PER_HOUR;
  const localMonthStart = localCalendarFeaturesFor(
    new Date(monthStart).toISOString(),
  );

  // require an exact utc hour and local midnight on day one
  return cutoffDate.getUTCMinutes() === 0 &&
    cutoffDate.getUTCSeconds() === 0 &&
    cutoffDate.getUTCMilliseconds() === 0 &&
    localMonthStart.localDate === `${month}-01` &&
    localMonthStart.hour === 0;
}

// validate the original winner and learned-strength material
function validateModel(
  forecast: TemperatureMosRuntimeForecast,
  model: TemperatureMosRuntimeModel,
  runInitializedAtMilliseconds: number,
): void {
  // require exact frozen contract identities
  if (
    model === null ||
    typeof model !== "object" ||
    model.contractVersion !== SHORT_LEAD_CONTRACT_VERSION ||
    model.learnedStrengthContractVersion !== STRENGTH_CONTRACT_VERSION ||
    (model.scope !== TEMPERATURE_MOS_RUNTIME_POLICY.scope &&
      model.scope !== TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope)
  ) {
    fail("invalid_model");
  }

  // bind provider and target month to the fitted model
  if (
    model.cohort !== forecast.cohort ||
    !/^\d{4}-\d{2}$/u.test(model.month) ||
    localCalendarFeaturesFor(forecast.validAt).localDate.slice(0, 7) !== model.month
  ) {
    fail("model_identity_mismatch");
  }

  const cutoff = instantMilliseconds(model.trainingCutoffUtc, "invalid_model");

  // reject same-run or future fitting data
  if (cutoff >= runInitializedAtMilliseconds) {
    fail("model_not_yet_available");
  }

  // require the exact seven-day local-month embargo
  if (!cutoffMatchesMonth(cutoff, model.month)) {
    fail("invalid_model");
  }

  // preserve raw for an unsupported original winner
  if (typeof model.supported !== "boolean" || !model.supported) {
    fail("model_not_supported");
  }

  const strengthBands = model.strengthBands;

  // require exactly the two frozen alpha bands
  if (
    strengthBands === null ||
    typeof strengthBands !== "object" ||
    Array.isArray(strengthBands) ||
    Object.keys(strengthBands).sort().join(",") !== "1-6,7-12"
  ) {
    fail("invalid_model");
  }

  validateCoefficients(model.directCoefficients, 35);
  validateCoefficients(model.adaptiveCoefficients, 49);
  const firstBandCutoff = validateStrengthBand(
    strengthBands["1-6"],
    runInitializedAtMilliseconds,
  );
  const secondBandCutoff = validateStrengthBand(
    strengthBands["7-12"],
    runInitializedAtMilliseconds,
  );

  // bind every alpha state to the original monthly fit
  if (firstBandCutoff !== cutoff || secondBandCutoff !== cutoff) {
    fail("invalid_model");
  }
}

// validate one causal per-run recent-error state
function validateRecentErrorState(
  forecast: TemperatureMosRuntimeForecast,
  state: TemperatureMosRuntimeRecentErrorState,
  runInitializedAtMilliseconds: number,
): void {
  // require a same-provider serialized receipt
  if (
    state === null ||
    typeof state !== "object" ||
    state.cohort !== forecast.cohort ||
    typeof state.supported !== "boolean"
  ) {
    fail("invalid_recent_error_state");
  }

  const targetRunInitializedAtMilliseconds = instantMilliseconds(
    state.targetRunInitializedAt,
    "invalid_recent_error_state",
  );

  // bind state to this exact model run
  if (targetRunInitializedAtMilliseconds !== runInitializedAtMilliseconds) {
    fail("recent_error_state_run_mismatch");
  }

  const expectedWindowEndMilliseconds =
    runInitializedAtMilliseconds -
    TEMPERATURE_MOS_RUNTIME_POLICY.sourceDelayHours * MILLISECONDS_PER_HOUR;
  const windowEndMilliseconds = instantMilliseconds(
    state.windowEndValidAt,
    "invalid_recent_error_state",
  );

  // require the frozen seven-hour observation boundary
  if (windowEndMilliseconds !== expectedWindowEndMilliseconds) {
    fail("recent_error_state_as_of_mismatch");
  }

  // validate bounded integer support counts
  if (
    !Number.isInteger(state.n24) ||
    !Number.isInteger(state.n72) ||
    !Number.isInteger(state.localDates) ||
    state.n24 < 0 ||
    state.n24 > 24 ||
    state.n72 < state.n24 ||
    state.n72 > 72 ||
    state.localDates < 0 ||
    state.localDates > state.n72
  ) {
    fail("invalid_recent_error_state");
  }

  // bind audit keys to selected source hours
  if (
    !Array.isArray(state.sourceKeys) ||
    state.sourceKeys.length !== state.n72 ||
    state.sourceKeys.some((key) => typeof key !== "string" || key.length === 0) ||
    new Set(state.sourceKeys).size !== state.sourceKeys.length
  ) {
    fail("invalid_recent_error_state");
  }

  const shortSupported = state.n24 >= 6;
  const longSupported = state.n72 >= 24;
  const expectedSupported = shortSupported && longSupported && state.localDates >= 2;

  // recompute the exact support gate
  if (state.supported !== expectedSupported) {
    fail("invalid_recent_error_state");
  }

  // validate the capped short statistic
  if (
    (shortSupported &&
      (state.b24C === null ||
        !Number.isFinite(state.b24C) ||
        Math.abs(state.b24C) > 6)) ||
    (!shortSupported && state.b24C !== null)
  ) {
    fail("invalid_recent_error_state");
  }

  // validate the capped long statistics
  if (
    (longSupported &&
      (state.b72C === null ||
        !Number.isFinite(state.b72C) ||
        Math.abs(state.b72C) > 6 ||
        state.mad72C === null ||
        !Number.isFinite(state.mad72C) ||
        state.mad72C < 0 ||
        state.mad72C > 6)) ||
    (!longSupported && (state.b72C !== null || state.mad72C !== null))
  ) {
    fail("invalid_recent_error_state");
  }

  // require empty maxima for an empty state
  if (
    state.n72 === 0 &&
    (state.maximumSourceValidAt !== null ||
      state.maximumSourceRunInitializedAt !== null)
  ) {
    fail("invalid_recent_error_state");
  }

  // validate and bound populated maxima
  if (state.n72 > 0) {
    // require both populated causal maxima
    if (
      state.maximumSourceValidAt === null ||
      state.maximumSourceRunInitializedAt === null
    ) {
      fail("invalid_recent_error_state");
    }

    const maximumSourceValidAtMilliseconds = instantMilliseconds(
      state.maximumSourceValidAt,
      "invalid_recent_error_state",
    );
    const maximumSourceRunInitializedAtMilliseconds = instantMilliseconds(
      state.maximumSourceRunInitializedAt,
      "invalid_recent_error_state",
    );
    const maximumSourceRunInitializedAt = new Date(
      maximumSourceRunInitializedAtMilliseconds,
    );
    const longWindowStartMilliseconds =
      expectedWindowEndMilliseconds - 71 * MILLISECONDS_PER_HOUR;
    const shortWindowStartMilliseconds =
      expectedWindowEndMilliseconds - 23 * MILLISECONDS_PER_HOUR;

    // reject observations or forecast runs unavailable at initialization
    if (
      maximumSourceValidAtMilliseconds > expectedWindowEndMilliseconds ||
      maximumSourceRunInitializedAtMilliseconds >= runInitializedAtMilliseconds
    ) {
      fail("recent_error_state_contains_future_data");
    }

    // bind the maximum to the inclusive hourly rolling windows
    if (
      maximumSourceValidAtMilliseconds < longWindowStartMilliseconds ||
      (state.n24 > 0 &&
        maximumSourceValidAtMilliseconds < shortWindowStartMilliseconds) ||
      (expectedWindowEndMilliseconds - maximumSourceValidAtMilliseconds) %
        MILLISECONDS_PER_HOUR !==
        0
    ) {
      fail("recent_error_state_outside_window");
    }

    // require an authentic six-hour source initialization
    if (
      !ECMWF_CYCLE_HOURS.has(maximumSourceRunInitializedAt.getUTCHours()) ||
      maximumSourceRunInitializedAt.getUTCMinutes() !== 0 ||
      maximumSourceRunInitializedAt.getUTCSeconds() !== 0 ||
      maximumSourceRunInitializedAt.getUTCMilliseconds() !== 0
    ) {
      fail("invalid_recent_error_state");
    }

    const earliestCompatibleSourceRun =
      maximumSourceValidAtMilliseconds - 18 * MILLISECONDS_PER_HOUR;
    const latestCompatibleSourceRun =
      maximumSourceValidAtMilliseconds - 7 * MILLISECONDS_PER_HOUR;

    // enforce the original source-lead range across both maxima
    if (
      maximumSourceRunInitializedAtMilliseconds < earliestCompatibleSourceRun ||
      maximumSourceRunInitializedAtMilliseconds > latestCompatibleSourceRun
    ) {
      fail("recent_error_state_source_run_mismatch");
    }
  }
}

// derive the exact frozen seasonal feature vector
function seasonalFeatures(forecast: TemperatureMosRuntimeForecast): readonly number[] {
  const calendar = localCalendarFeaturesFor(forecast.validAt);
  const year = Number(calendar.localDate.slice(0, 4));
  const annual =
    2 *
    Math.PI *
    (dayOfYear(calendar.localDate) + calendar.hour / 24) /
    daysInYear(year);
  const daily = 2 * Math.PI * calendar.hour / 24;
  const annualBasis = [
    Math.sin(annual),
    Math.cos(annual),
    Math.sin(2 * annual),
    Math.cos(2 * annual),
  ];
  const dailyBasis = [
    Math.sin(daily),
    Math.cos(daily),
    Math.sin(2 * daily),
    Math.cos(2 * daily),
  ];
  const temperature = (forecast.rawTemperatureC - 10) / 10;
  const humidityMissing = forecast.rawRelativeHumidityPercent === null;
  const windMissing = forecast.rawWindSpeedMps === null;
  const humidity = humidityMissing
    ? 0
    : (forecast.rawRelativeHumidityPercent - 75) / 25;
  const wind = windMissing ? 0 : (forecast.rawWindSpeedMps - 2) / 3;
  const interactions: number[] = [];

  // preserve python's nested interaction ordering
  for (const annualValue of annualBasis.slice(0, 2)) {
    // append both daily terms for each annual term
    for (const dailyValue of dailyBasis.slice(0, 2)) {
      interactions.push(annualValue * dailyValue);
    }
  }

  const temperatureInteractions = [
    ...annualBasis.slice(0, 2),
    ...dailyBasis.slice(0, 2),
  ].map((value) => temperature * value);
  return [
    1,
    ...annualBasis,
    ...dailyBasis,
    ...interactions,
    temperature,
    temperature * temperature,
    humidity,
    wind,
    Number(humidityMissing),
    Number(windMissing),
    ...temperatureInteractions,
    humidity * dailyBasis[0]!,
    humidity * dailyBasis[1]!,
    wind * dailyBasis[0]!,
    wind * dailyBasis[1]!,
  ];
}

// append the exact lead, cycle, and model-era terms
function staticFeatures(forecast: TemperatureMosRuntimeForecast): readonly number[] {
  const features = seasonalFeatures(forecast);
  const leadScaled = forecast.modelLeadHours / 18;
  const localHour = localCalendarFeaturesFor(forecast.validAt).hour;
  const daily = 2 * Math.PI * localHour / 24;
  const runInitializedAt = new Date(forecast.runInitializedAt);
  const cycleAngle = 2 * Math.PI * runInitializedAt.getUTCHours() / 24;
  const result = [
    ...features,
    leadScaled,
    leadScaled * leadScaled,
    leadScaled * Math.sin(daily),
    leadScaled * Math.cos(daily),
    leadScaled * features[13]!,
    Math.sin(cycleAngle),
    Math.cos(cycleAngle),
    Number(forecast.modelCycle === "50r1"),
  ];

  // enforce the frozen direct schema
  if (result.length !== 35 || result.some((value) => !Number.isFinite(value))) {
    fail("invalid_forecast");
  }

  return result;
}

// append the exact causally frozen recent-error terms
function adaptiveFeatures(
  forecast: TemperatureMosRuntimeForecast,
  state: TemperatureMosRuntimeRecentErrorState,
  scope: TemperatureMosRuntimeModel["scope"],
): readonly number[] {
  const features = staticFeatures(forecast);
  const shortValue = state.b24C ?? 0;
  const longValue = state.b72C ?? 0;
  const difference =
    state.b24C === null || state.b72C === null ? 0 : state.b24C - state.b72C;
  const signed = [shortValue / 3, longValue / 3, difference / 3];
  const operationalHorizonHours = scope === TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope
    ? forecast.modelLeadHours -
      TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.operationalDelayHours
    : forecast.modelLeadHours;
  const result = [
    ...features,
    ...signed,
    state.mad72C === null ? 0 : state.mad72C / 3,
    state.n24 / 24,
    state.n72 / 72,
    Number(state.b24C === null),
    Number(state.b72C === null),
    ...signed.map((value) => value * Math.exp(-operationalHorizonHours / 6)),
    ...signed.map((value) => value * Math.exp(-operationalHorizonHours / 18)),
  ];

  // enforce the frozen adaptive schema
  if (result.length !== 49 || result.some((value) => !Number.isFinite(value))) {
    fail("invalid_recent_error_state");
  }

  return result;
}

// calculate one deterministic coefficient dot product
function dot(features: readonly number[], coefficients: readonly number[]): number {
  let result = 0;

  // preserve feature-order accumulation
  for (let index = 0; index < features.length; index += 1) {
    result += features[index]! * coefficients[index]!;
  }

  // reject numerical overflow
  if (!Number.isFinite(result)) {
    fail("invalid_model");
  }

  return result;
}

// apply one bounded physical correction
function adjustedTemperature(raw: number, unscaled: number, alpha: number): number {
  const correction = Math.max(
    -TEMPERATURE_MOS_RUNTIME_POLICY.maximumCorrectionC,
    Math.min(
      TEMPERATURE_MOS_RUNTIME_POLICY.maximumCorrectionC,
      alpha * unscaled,
    ),
  );
  return Math.max(
    TEMPERATURE_MOS_RUNTIME_POLICY.physicalMinimumC,
    Math.min(TEMPERATURE_MOS_RUNTIME_POLICY.physicalMaximumC, raw + correction),
  );
}

// apply the frozen winner without fetching or fabricating inputs
export function applyEcmwfTemperatureMosRuntime(
  input: TemperatureMosRuntimeInput,
): TemperatureMosRuntimeResult {
  const rawTemperatureC = input?.forecast?.rawTemperatureC;

  // retain raw even when runtime callers bypass types
  if (typeof rawTemperatureC !== "number") {
    return rawResult(rawTemperatureC as number, "invalid_forecast");
  }

  try {
    const scope = input.model?.scope;

    // reject unknown model scopes before choosing lead semantics
    if (
      scope !== TEMPERATURE_MOS_RUNTIME_POLICY.scope &&
      scope !== TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope
    ) {
      fail("invalid_model");
    }

    const { runInitializedAtMilliseconds } = validateForecast(
      input.forecast,
      scope,
    );
    validateModel(input.forecast, input.model, runInitializedAtMilliseconds);
    validateRecentErrorState(
      input.forecast,
      input.recentErrorState,
      runInitializedAtMilliseconds,
    );
    const branch = input.recentErrorState.supported ? "adaptive" : "direct";
    const features = branch === "adaptive"
      ? adaptiveFeatures(input.forecast, input.recentErrorState, scope)
      : staticFeatures(input.forecast);
    const coefficients = branch === "adaptive"
      ? validateCoefficients(input.model.adaptiveCoefficients, 49)
      : validateCoefficients(input.model.directCoefficients, 35);
    const unscaledCorrectionC = dot(features, coefficients);
    const operationalHorizonHours = scope ===
      TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope
      ? input.forecast.modelLeadHours -
        TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.operationalDelayHours
      : input.forecast.modelLeadHours;
    const band = operationalHorizonHours <= 6
      ? input.model.strengthBands["1-6"]
      : input.model.strengthBands["7-12"];

    // fail raw rather than substituting the original half-strength winner
    if (!band.supported) {
      fail("strength_band_not_supported");
    }

    return {
      alpha: band.alpha,
      applied: true,
      branch,
      incumbentHalfStrengthTemperatureC: adjustedTemperature(
        rawTemperatureC,
        unscaledCorrectionC,
        TEMPERATURE_MOS_RUNTIME_POLICY.correctionWeight,
      ),
      predictionTemperatureC: adjustedTemperature(
        rawTemperatureC,
        unscaledCorrectionC,
        band.alpha,
      ),
      rawTemperatureC,
      reason: null,
      unscaledCorrectionC,
    };
  } catch (error) {
    // preserve controlled validation failures as raw
    if (error instanceof TemperatureMosRuntimeFailure) {
      return rawResult(rawTemperatureC, error.reason);
    }

    return rawResult(rawTemperatureC, "inference_error");
  }
}
