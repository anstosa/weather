import {
  FORECAST_LEAD_BANDS,
  forecastLeadBandFor,
  type ForecastLeadBandKey,
} from "@weather/domain";

import {
  localCalendarFeaturesFor,
  type LocalDaypart,
} from "./calendar.js";

// freeze the non-promotable research identity
export const TEMPERATURE_LEAD_RESEARCH_CONTRACT_VERSION =
  "temperature-lead-research/v1" as const;

// freeze the descriptive calibration choices
export const TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID = [
  0,
  0.25,
  0.5,
  0.75,
  1,
] as const;

// freeze the retrospective availability assumption
export const TEMPERATURE_LEAD_RESEARCH_OBSERVATION_LAG_HOURS = 1 as const;

// freeze the causal support floor
export const TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES = 3 as const;
export const TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS = 30 as const;

// freeze six-hour experimental lead buckets
export const TEMPERATURE_LEAD_RESEARCH_SIX_HOUR_BUCKETS = Array.from(
  { length: 28 },
  // derive each contiguous bucket
  (_unused, index) => {
    const minimumHours = index * 6 + 1;
    const maximumHours = minimumHours + 5;

    return {
      key: `${String(minimumHours).padStart(3, "0")}-${String(maximumHours).padStart(3, "0")}`,
      maximumHours,
      minimumHours,
    } as const;
  },
);

const LOCAL_DAYPARTS = [
  "night",
  "morning",
  "afternoon",
  "evening",
] as const satisfies readonly LocalDaypart[];
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MILLISECONDS_PER_HOUR = 3_600_000;
const ALPHA_TIE_TOLERANCE = 1e-12;

// describe one canonical live-v4 temperature event
export interface TemperatureLeadResearchEvent {
  readonly actual: number;
  readonly baselineAdjusted: number;
  readonly rawForecast: number;
  readonly referenceAt: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// score one strategy without hiding event weighting
export interface TemperatureLeadResearchScore {
  readonly correctionUseCount: number;
  readonly eventCount: number;
  readonly eventWeightedMeanAbsoluteError: number | null;
  readonly eventWeightedPointSkillVersusRaw: number | null;
  readonly localDateCount: number;
  readonly uniqueHourBalancedMeanAbsoluteError: number | null;
  readonly uniqueHourBalancedPointSkillVersusRaw: number | null;
  readonly uniqueValidHours: number;
}

// compare the four experimental strategies on one common event set
export interface TemperatureLeadResearchComparison {
  readonly baselineFull: TemperatureLeadResearchScore;
  readonly causalAdaptive: TemperatureLeadResearchScore;
  readonly raw: TemperatureLeadResearchScore;
  readonly staticLinearTaper: TemperatureLeadResearchScore;
}

// score one fixed-alpha experiment
export interface TemperatureLeadResearchFixedAlphaScore {
  readonly alpha: (typeof TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID)[number];
  readonly score: TemperatureLeadResearchScore;
}

// describe one exact-hour diagnostic cell
export interface TemperatureLeadResearchExactHourDiagnostic {
  readonly comparison: TemperatureLeadResearchComparison;
  readonly targetLeadHours: number;
}

// describe one six-hour diagnostic cell
export interface TemperatureLeadResearchSixHourDiagnostic {
  readonly comparison: TemperatureLeadResearchComparison;
  readonly fixedAlphaScores: readonly TemperatureLeadResearchFixedAlphaScore[];
  readonly key: string;
  readonly maximumHours: number;
  readonly minimumHours: number;
}

// describe one daypart diagnostic cell
export interface TemperatureLeadResearchDaypartDiagnostic {
  readonly comparison: TemperatureLeadResearchComparison;
  readonly daypart: LocalDaypart;
}

// describe one lead-band diagnostic cell
export interface TemperatureLeadResearchLeadBandDiagnostic {
  readonly comparison: TemperatureLeadResearchComparison;
  readonly leadBand: ForecastLeadBandKey;
  readonly maximumHours: number;
  readonly minimumHours: number;
}

// compare all strategies on one isolated local date
export interface TemperatureLeadResearchLocalDateDiagnostic {
  readonly comparison: TemperatureLeadResearchComparison;
  readonly localDate: string;
}

// expose causal choices without retaining temperatures or event losses
export interface TemperatureLeadResearchCausalTrace {
  readonly calibrated: boolean;
  readonly calibrationCutoff: string;
  readonly latestConsumedObservationAvailableAt: string | null;
  readonly leadBucket: string;
  readonly referenceAt: string;
  readonly selectedAlpha: (typeof TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID)[number];
  readonly supportEventCount: number;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// report a complete non-promotable analysis
export interface TemperatureLeadResearchReport {
  readonly alphaGrid: {
    readonly interpretation: "descriptive_only_not_validation_or_model_selection";
    readonly scores: readonly TemperatureLeadResearchFixedAlphaScore[];
    readonly tiePolicy: "prefer_smaller_alpha";
  };
  readonly availabilityAssumption: {
    readonly evidenceStatus: "pseudo_real_time_retrospective_not_independently_validated";
    readonly observationAvailableAtRule: "validAt_plus_1_hour";
    readonly observationLagHours: typeof TEMPERATURE_LEAD_RESEARCH_OBSERVATION_LAG_HOURS;
  };
  readonly calibratedSubset: TemperatureLeadResearchComparison;
  readonly causalTrace: readonly TemperatureLeadResearchCausalTrace[];
  readonly contractVersion: typeof TEMPERATURE_LEAD_RESEARCH_CONTRACT_VERSION;
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureLeadResearchDaypartDiagnostic[];
    readonly byExactLeadHour: readonly TemperatureLeadResearchExactHourDiagnostic[];
    readonly byLeadBand: readonly TemperatureLeadResearchLeadBandDiagnostic[];
    readonly byLocalDate: readonly TemperatureLeadResearchLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureLeadResearchSixHourDiagnostic[];
    readonly daypartUse: "descriptive_only_not_a_selection_dimension";
  };
  readonly inputCohort: "legacy_v4_retrieval_snapshot";
  readonly inputCoverage: {
    readonly eventCount: number;
    readonly localDateCount: number;
    readonly uniqueValidHours: number;
  };
  readonly overall: TemperatureLeadResearchComparison;
  readonly productionActivationAllowed: false;
  readonly researchOnly: true;
  readonly staticLinearTaper: {
    readonly alphaFormula: "targetLeadHours / leadBand.maximumHours";
    readonly bandBoundaryTreatment: "24_to_25_hour_reset_is_intentional_experimental_behavior_not_recommended_policy";
  };
  readonly supportPolicy: {
    readonly alphaTiePolicy: "prefer_smaller_alpha";
    readonly bucketWidthHours: 6;
    readonly minimumPriorLocalDates: typeof TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES;
    readonly minimumPriorUniqueValidHours: typeof TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS;
    readonly unsupportedAlpha: 0;
  };
}

interface PreparedEvent extends TemperatureLeadResearchEvent {
  readonly availableAt: string;
  readonly availableAtMilliseconds: number;
  readonly baselineCorrection: number;
  readonly daypart: LocalDaypart;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly leadBucket: string;
  readonly localDate: string;
  readonly referenceAtMilliseconds: number;
  readonly validAtMilliseconds: number;
}

interface EvaluatedEvent extends PreparedEvent {
  readonly causalAdaptive: number;
  readonly causalCalibrated: boolean;
  readonly staticLinearTaper: number;
}

interface HourLossAccumulator {
  count: number;
  readonly lossSums: number[];
}

interface CalibrationState {
  eventCount: number;
  latestAvailableAt: string | null;
  readonly localDates: Set<string>;
  readonly totalHourLosses: number[];
  readonly validHours: Map<string, HourLossAccumulator>;
}

interface StrategyPrediction {
  readonly event: EvaluatedEvent;
  readonly prediction: number;
}

// normalize one strict UTC instant
function normalizeUtcInstant(value: string, field: string): string {
  // reject offset, malformed, and non-finite instants
  if (!UTC_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  const normalized = new Date(value).toISOString();

  // reject calendar or clock rollover while allowing omitted zero milliseconds
  if (normalized !== value && normalized !== value.replace("Z", ".000Z")) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return normalized;
}

// require one finite temperature value
function requireFinite(value: number, field: string): number {
  // reject non-finite scoring material
  if (!Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

// locate the frozen six-hour lead bucket
function sixHourBucketFor(targetLeadHours: number): string {
  const bucketIndex = Math.floor((targetLeadHours - 1) / 6);
  const bucket = TEMPERATURE_LEAD_RESEARCH_SIX_HOUR_BUCKETS[bucketIndex];

  // reject impossible internal lookup failures
  if (bucket === undefined) {
    throw new RangeError("targetLeadHours must be between 1 and 168");
  }

  return bucket.key;
}

// validate and enrich one live-v4 temperature event
function prepareEvent(event: TemperatureLeadResearchEvent): PreparedEvent {
  const validAt = normalizeUtcInstant(event.validAt, "validAt");
  const referenceAt = normalizeUtcInstant(event.referenceAt, "referenceAt");
  const validAtMilliseconds = Date.parse(validAt);
  const referenceAtMilliseconds = Date.parse(referenceAt);

  // require one whole supported application lead
  if (
    !Number.isInteger(event.targetLeadHours) ||
    event.targetLeadHours < 1 ||
    event.targetLeadHours > 168
  ) {
    throw new RangeError("targetLeadHours must be an integer between 1 and 168");
  }

  const continuousLeadHours =
    (validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR;

  // bind the claimed lead to its forecast reference
  if (
    continuousLeadHours <= 0 ||
    Math.ceil(continuousLeadHours) !== event.targetLeadHours
  ) {
    throw new RangeError("targetLeadHours must match validAt and referenceAt");
  }

  // require exact hourly forecast targets
  if (validAtMilliseconds % MILLISECONDS_PER_HOUR !== 0) {
    throw new RangeError("validAt must be aligned to an exact UTC hour");
  }

  const calendar = localCalendarFeaturesFor(validAt);
  const availableAtMilliseconds =
    validAtMilliseconds +
    TEMPERATURE_LEAD_RESEARCH_OBSERVATION_LAG_HOURS * MILLISECONDS_PER_HOUR;

  return {
    actual: requireFinite(event.actual, "actual"),
    availableAt: new Date(availableAtMilliseconds).toISOString(),
    availableAtMilliseconds,
    baselineAdjusted: requireFinite(
      event.baselineAdjusted,
      "baselineAdjusted",
    ),
    baselineCorrection:
      requireFinite(event.baselineAdjusted, "baselineAdjusted") -
      requireFinite(event.rawForecast, "rawForecast"),
    daypart: calendar.daypart,
    key: `${validAt}|${event.targetLeadHours}`,
    leadBand: forecastLeadBandFor(event.targetLeadHours),
    leadBucket: sixHourBucketFor(event.targetLeadHours),
    localDate: calendar.localDate,
    rawForecast: requireFinite(event.rawForecast, "rawForecast"),
    referenceAt,
    referenceAtMilliseconds,
    targetLeadHours: event.targetLeadHours,
    validAt,
    validAtMilliseconds,
  };
}

// order events by issue time before causal scoring
function compareByReference(left: PreparedEvent, right: PreparedEvent): number {
  return (
    left.referenceAtMilliseconds - right.referenceAtMilliseconds ||
    left.validAtMilliseconds - right.validAtMilliseconds ||
    left.targetLeadHours - right.targetLeadHours
  );
}

// order observations by assumed availability
function compareByAvailability(left: PreparedEvent, right: PreparedEvent): number {
  return (
    left.availableAtMilliseconds - right.availableAtMilliseconds ||
    left.validAtMilliseconds - right.validAtMilliseconds ||
    left.targetLeadHours - right.targetLeadHours
  );
}

// create one empty six-hour calibration state
function createCalibrationState(): CalibrationState {
  return {
    eventCount: 0,
    latestAvailableAt: null,
    localDates: new Set<string>(),
    totalHourLosses: TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.map(
      // initialize each alpha total
      () => 0,
    ),
    validHours: new Map<string, HourLossAccumulator>(),
  };
}

// project one alpha-scaled baseline correction
function alphaPrediction(event: PreparedEvent, alpha: number): number {
  return event.rawForecast + alpha * event.baselineCorrection;
}

// add one newly available observation in constant grid time
function addCalibrationObservation(
  state: CalibrationState,
  event: PreparedEvent,
): void {
  let hour = state.validHours.get(event.validAt);

  // initialize a newly consumed valid hour
  if (hour === undefined) {
    hour = {
      count: 0,
      lossSums: TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.map(
        // initialize each hour loss
        () => 0,
      ),
    };
    state.validHours.set(event.validAt, hour);
  }

  // replace each balanced hour contribution
  for (
    let alphaIndex = 0;
    alphaIndex < TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.length;
    alphaIndex += 1
  ) {
    const alpha = TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID[alphaIndex];

    // guard the frozen grid lookup
    if (alpha === undefined) {
      throw new Error("temperature alpha grid lookup failed");
    }

    const previousHourMean =
      hour.count === 0 ? 0 : (hour.lossSums[alphaIndex] ?? 0) / hour.count;
    const loss = Math.abs(alphaPrediction(event, alpha) - event.actual);
    const nextLossSum = (hour.lossSums[alphaIndex] ?? 0) + loss;
    const nextHourMean = nextLossSum / (hour.count + 1);
    hour.lossSums[alphaIndex] = nextLossSum;
    state.totalHourLosses[alphaIndex] =
      (state.totalHourLosses[alphaIndex] ?? 0) -
      previousHourMean +
      nextHourMean;
  }

  hour.count += 1;
  state.eventCount += 1;
  state.localDates.add(event.localDate);
  state.latestAvailableAt = event.availableAt;
}

// choose the lowest-loss supported alpha with a conservative tie break
function selectCausalAlpha(state: CalibrationState): {
  readonly calibrated: boolean;
  readonly selectedAlpha: (typeof TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID)[number];
} {
  // retain raw output below the frozen support floor
  if (
    state.localDates.size < TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES ||
    state.validHours.size < TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS
  ) {
    return { calibrated: false, selectedAlpha: 0 };
  }

  let bestAlpha: (typeof TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID)[number] =
    TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID[0];
  let bestLoss = Number.POSITIVE_INFINITY;

  // scan the tiny frozen grid in ascending tie order
  for (
    let alphaIndex = 0;
    alphaIndex < TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.length;
    alphaIndex += 1
  ) {
    const alpha = TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID[alphaIndex];
    const totalLoss = state.totalHourLosses[alphaIndex];

    // guard the frozen state layout
    if (alpha === undefined || totalLoss === undefined) {
      throw new Error("temperature calibration state is incomplete");
    }

    const balancedLoss = totalLoss / state.validHours.size;

    // replace only a materially smaller score
    if (balancedLoss < bestLoss - ALPHA_TIE_TOLERANCE) {
      bestAlpha = alpha;
      bestLoss = balancedLoss;
    }
  }

  return { calibrated: true, selectedAlpha: bestAlpha };
}

// resolve one lead-band upper boundary
function leadBandMaximumHours(leadBand: ForecastLeadBandKey): number {
  const band = FORECAST_LEAD_BANDS.find(
    // match the frozen lead band
    (candidate) => candidate.key === leadBand,
  );

  // guard the frozen domain contract
  if (band === undefined) {
    throw new Error("forecast lead band is unavailable");
  }

  return band.maximumHours;
}

// score causal choices from strictly available prior observations
function evaluateCausalStrategies(events: readonly PreparedEvent[]): {
  readonly events: readonly EvaluatedEvent[];
  readonly trace: readonly TemperatureLeadResearchCausalTrace[];
} {
  const issueOrder = [...events].sort(compareByReference);
  const availabilityOrder = [...events].sort(compareByAvailability);
  const states = new Map<string, CalibrationState>();
  const evaluated: EvaluatedEvent[] = [];
  const trace: TemperatureLeadResearchCausalTrace[] = [];
  let availabilityIndex = 0;

  // score each forecast against only observations available when issued
  for (const event of issueOrder) {
    // consume every observation available by this issue time
    while (availabilityIndex < availabilityOrder.length) {
      const availableEvent = availabilityOrder[availabilityIndex];

      // guard the sorted availability queue
      if (availableEvent === undefined) {
        throw new Error("temperature availability queue is incomplete");
      }

      // stop before observations unavailable at issue time
      if (availableEvent.availableAtMilliseconds > event.referenceAtMilliseconds) {
        break;
      }

      let state = states.get(availableEvent.leadBucket);

      // initialize one six-hour bucket on first use
      if (state === undefined) {
        state = createCalibrationState();
        states.set(availableEvent.leadBucket, state);
      }

      addCalibrationObservation(state, availableEvent);
      availabilityIndex += 1;
    }

    const state = states.get(event.leadBucket) ?? createCalibrationState();
    const selection = selectCausalAlpha(state);
    const staticAlpha =
      event.targetLeadHours / leadBandMaximumHours(event.leadBand);
    evaluated.push({
      ...event,
      causalAdaptive: alphaPrediction(event, selection.selectedAlpha),
      causalCalibrated: selection.calibrated,
      staticLinearTaper: alphaPrediction(event, staticAlpha),
    });
    trace.push({
      calibrated: selection.calibrated,
      calibrationCutoff: event.referenceAt,
      latestConsumedObservationAvailableAt: state.latestAvailableAt,
      leadBucket: event.leadBucket,
      referenceAt: event.referenceAt,
      selectedAlpha: selection.selectedAlpha,
      supportEventCount: state.eventCount,
      supportLocalDateCount: state.localDates.size,
      supportUniqueValidHours: state.validHours.size,
      targetLeadHours: event.targetLeadHours,
      validAt: event.validAt,
    });
  }

  return { events: evaluated, trace };
}

// project one named strategy prediction
function strategyPrediction(
  event: EvaluatedEvent,
  strategy: keyof TemperatureLeadResearchComparison,
): number {
  // select the raw forecast
  if (strategy === "raw") {
    return event.rawForecast;
  }

  // select the complete baseline correction
  if (strategy === "baselineFull") {
    return event.baselineAdjusted;
  }

  // select the fixed taper experiment
  if (strategy === "staticLinearTaper") {
    return event.staticLinearTaper;
  }

  return event.causalAdaptive;
}

// compute a stable point-skill value
function pointSkill(adjustedLoss: number, rawLoss: number): number | null {
  // avoid an undefined zero-loss ratio
  if (rawLoss === 0) {
    return null;
  }

  return (rawLoss - adjustedLoss) / rawLoss;
}

// score predictions with both event and unique-hour weighting
function scorePredictions(
  predictions: readonly StrategyPrediction[],
): TemperatureLeadResearchScore {
  const localDates = new Set<string>();
  const hourLosses = new Map<
    string,
    { count: number; lossSum: number; rawLossSum: number }
  >();
  let correctionUseCount = 0;
  let eventLossSum = 0;
  let eventRawLossSum = 0;

  // accumulate every prediction once
  for (const item of predictions) {
    const loss = Math.abs(item.prediction - item.event.actual);
    const rawLoss = Math.abs(item.event.rawForecast - item.event.actual);
    let hour = hourLosses.get(item.event.validAt);

    // initialize one balanced valid hour
    if (hour === undefined) {
      hour = { count: 0, lossSum: 0, rawLossSum: 0 };
      hourLosses.set(item.event.validAt, hour);
    }

    hour.count += 1;
    hour.lossSum += loss;
    hour.rawLossSum += rawLoss;
    eventLossSum += loss;
    eventRawLossSum += rawLoss;
    localDates.add(item.event.localDate);

    // count only nonzero applied corrections
    if (item.prediction !== item.event.rawForecast) {
      correctionUseCount += 1;
    }
  }

  // return explicit zero-support cells
  if (predictions.length === 0) {
    return {
      correctionUseCount: 0,
      eventCount: 0,
      eventWeightedMeanAbsoluteError: null,
      eventWeightedPointSkillVersusRaw: null,
      localDateCount: 0,
      uniqueHourBalancedMeanAbsoluteError: null,
      uniqueHourBalancedPointSkillVersusRaw: null,
      uniqueValidHours: 0,
    };
  }

  let balancedLossSum = 0;
  let balancedRawLossSum = 0;

  // give each valid hour one equal contribution
  for (const hour of hourLosses.values()) {
    balancedLossSum += hour.lossSum / hour.count;
    balancedRawLossSum += hour.rawLossSum / hour.count;
  }

  const eventWeightedMeanAbsoluteError = eventLossSum / predictions.length;
  const eventWeightedRawMeanAbsoluteError =
    eventRawLossSum / predictions.length;
  const uniqueHourBalancedMeanAbsoluteError =
    balancedLossSum / hourLosses.size;
  const uniqueHourBalancedRawMeanAbsoluteError =
    balancedRawLossSum / hourLosses.size;

  return {
    correctionUseCount,
    eventCount: predictions.length,
    eventWeightedMeanAbsoluteError,
    eventWeightedPointSkillVersusRaw: pointSkill(
      eventWeightedMeanAbsoluteError,
      eventWeightedRawMeanAbsoluteError,
    ),
    localDateCount: localDates.size,
    uniqueHourBalancedMeanAbsoluteError,
    uniqueHourBalancedPointSkillVersusRaw: pointSkill(
      uniqueHourBalancedMeanAbsoluteError,
      uniqueHourBalancedRawMeanAbsoluteError,
    ),
    uniqueValidHours: hourLosses.size,
  };
}

// score one strategy over a common event set
function scoreStrategy(
  events: readonly EvaluatedEvent[],
  strategy: keyof TemperatureLeadResearchComparison,
): TemperatureLeadResearchScore {
  return scorePredictions(
    events.map(
      // project one requested strategy
      (event) => ({ event, prediction: strategyPrediction(event, strategy) }),
    ),
  );
}

// compare every strategy over exactly the same events
function compareStrategies(
  events: readonly EvaluatedEvent[],
): TemperatureLeadResearchComparison {
  return {
    baselineFull: scoreStrategy(events, "baselineFull"),
    causalAdaptive: scoreStrategy(events, "causalAdaptive"),
    raw: scoreStrategy(events, "raw"),
    staticLinearTaper: scoreStrategy(events, "staticLinearTaper"),
  };
}

// score every fixed alpha over one common event set
function scoreFixedAlphaGrid(
  events: readonly EvaluatedEvent[],
): readonly TemperatureLeadResearchFixedAlphaScore[] {
  return TEMPERATURE_LEAD_RESEARCH_ALPHA_GRID.map(
    // score each fixed alpha descriptively
    (alpha) => ({
      alpha,
      score: scorePredictions(
        events.map(
          // apply one fixed alpha
          (event) => ({
            event,
            prediction: alphaPrediction(event, alpha),
          }),
        ),
      ),
    }),
  );
}

// append one event to a diagnostic group
function appendGroupedEvent<K>(
  groups: Map<K, EvaluatedEvent[]>,
  key: K,
  event: EvaluatedEvent,
): void {
  let group = groups.get(key);

  // initialize one diagnostic group
  if (group === undefined) {
    group = [];
    groups.set(key, group);
  }

  group.push(event);
}

// analyze temperature lead calibration without producing a runtime candidate
export function analyzeTemperatureLeadResearch(
  events: readonly TemperatureLeadResearchEvent[],
): TemperatureLeadResearchReport {
  // reject absent research material
  if (!Array.isArray(events) || events.length === 0) {
    throw new RangeError("events must be a non-empty array");
  }

  const prepared = events.map(
    // validate each input event
    (event) => prepareEvent(event),
  );
  const identities = new Set<string>();

  // reject unresolved forecast jitter duplicates
  for (const event of prepared) {
    // fail on duplicate valid-time and target-lead identities
    if (identities.has(event.key)) {
      throw new RangeError(
        "events must be canonicalized to one validAt and targetLeadHours identity",
      );
    }

    identities.add(event.key);
  }

  const causal = evaluateCausalStrategies(prepared);
  const evaluated = causal.events;
  const calibratedEvents = evaluated.filter(
    // retain only forecasts with supported causal selection
    (event) => event.causalCalibrated,
  );
  const coverage = scoreStrategy(evaluated, "raw");
  const byDaypart = new Map<LocalDaypart, EvaluatedEvent[]>();
  const byExactLeadHour = new Map<number, EvaluatedEvent[]>();
  const byLeadBand = new Map<ForecastLeadBandKey, EvaluatedEvent[]>();
  const byLocalDate = new Map<string, EvaluatedEvent[]>();
  const bySixHourBucket = new Map<string, EvaluatedEvent[]>();

  // index all diagnostic dimensions in one linear pass
  for (const event of evaluated) {
    appendGroupedEvent(byDaypart, event.daypart, event);
    appendGroupedEvent(byExactLeadHour, event.targetLeadHours, event);
    appendGroupedEvent(byLeadBand, event.leadBand, event);
    appendGroupedEvent(byLocalDate, event.localDate, event);
    appendGroupedEvent(bySixHourBucket, event.leadBucket, event);
  }

  const localDates = [...byLocalDate.keys()].sort();

  return {
    alphaGrid: {
      interpretation: "descriptive_only_not_validation_or_model_selection",
      scores: scoreFixedAlphaGrid(evaluated),
      tiePolicy: "prefer_smaller_alpha",
    },
    availabilityAssumption: {
      evidenceStatus:
        "pseudo_real_time_retrospective_not_independently_validated",
      observationAvailableAtRule: "validAt_plus_1_hour",
      observationLagHours: TEMPERATURE_LEAD_RESEARCH_OBSERVATION_LAG_HOURS,
    },
    calibratedSubset: compareStrategies(calibratedEvents),
    causalTrace: causal.trace,
    contractVersion: TEMPERATURE_LEAD_RESEARCH_CONTRACT_VERSION,
    diagnostics: {
      byDaypart: LOCAL_DAYPARTS.map(
        // emit every frozen daypart cell
        (daypart) => ({
          comparison: compareStrategies(byDaypart.get(daypart) ?? []),
          daypart,
        }),
      ),
      byExactLeadHour: Array.from(
        { length: 168 },
        // emit every supported exact lead
        (_unused, index) => {
          const targetLeadHours = index + 1;

          return {
            comparison: compareStrategies(
              byExactLeadHour.get(targetLeadHours) ?? [],
            ),
            targetLeadHours,
          };
        },
      ),
      byLeadBand: FORECAST_LEAD_BANDS.map(
        // emit every frozen lead band
        (band) => ({
          comparison: compareStrategies(byLeadBand.get(band.key) ?? []),
          leadBand: band.key,
          maximumHours: band.maximumHours,
          minimumHours: band.minimumHours,
        }),
      ),
      byLocalDate: localDates.map(
        // isolate one observed local date
        (localDate) => ({
          comparison: compareStrategies(byLocalDate.get(localDate) ?? []),
          localDate,
        }),
      ),
      bySixHourBucket: TEMPERATURE_LEAD_RESEARCH_SIX_HOUR_BUCKETS.map(
        // emit every experimental six-hour bucket
        (bucket) => {
          const bucketEvents = bySixHourBucket.get(bucket.key) ?? [];

          return {
            comparison: compareStrategies(bucketEvents),
            fixedAlphaScores: scoreFixedAlphaGrid(bucketEvents),
            key: bucket.key,
            maximumHours: bucket.maximumHours,
            minimumHours: bucket.minimumHours,
          };
        },
      ),
      daypartUse: "descriptive_only_not_a_selection_dimension",
    },
    inputCohort: "legacy_v4_retrieval_snapshot",
    inputCoverage: {
      eventCount: coverage.eventCount,
      localDateCount: coverage.localDateCount,
      uniqueValidHours: coverage.uniqueValidHours,
    },
    overall: compareStrategies(evaluated),
    productionActivationAllowed: false,
    researchOnly: true,
    staticLinearTaper: {
      alphaFormula: "targetLeadHours / leadBand.maximumHours",
      bandBoundaryTreatment:
        "24_to_25_hour_reset_is_intentional_experimental_behavior_not_recommended_policy",
    },
    supportPolicy: {
      alphaTiePolicy: "prefer_smaller_alpha",
      bucketWidthHours: 6,
      minimumPriorLocalDates:
        TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_LOCAL_DATES,
      minimumPriorUniqueValidHours:
        TEMPERATURE_LEAD_RESEARCH_MINIMUM_PRIOR_VALID_HOURS,
      unsupportedAlpha: 0,
    },
  };
}
