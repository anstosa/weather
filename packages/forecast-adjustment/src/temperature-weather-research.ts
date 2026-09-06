import {
  FORECAST_LEAD_BANDS,
  forecastLeadBandFor,
  type ForecastLeadBandKey,
  type ForecastTrainingCohort,
} from "@weather/domain";

import {
  fitCoefficientCell,
  metricPolicyFor,
  type WeightedResidualObservation,
} from "./algorithm-v1.js";
import {
  localCalendarFeaturesFor,
  type LocalDaypart,
  type LocalMeteorologicalSeason,
} from "./calendar.js";
import {
  scoreTemperatureResearchPredictions,
  type TemperatureLeadResearchScore,
} from "./temperature-lead-research.js";

// freeze the non-promotable research identity
export const TEMPERATURE_WEATHER_RESEARCH_CONTRACT_VERSION =
  "temperature-weather-research/v1" as const;

// freeze the scalar cell support policy
export const TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES = 10 as const;
export const TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS = 50 as const;
export const TEMPERATURE_WEATHER_PSEUDOCOUNT = 100 as const;

const MILLISECONDS_PER_HOUR = 3_600_000;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const FIXED_ANCHOR_LEADS = new Set([24, 48, 72, 96, 120, 144, 168]);
const STRATEGIES = [
  "raw",
  "calendarBaseline",
  "calendarTemperature",
  "calendarTemperatureWeather",
  "rawTemperatureWeather",
] as const;
const DAYPARTS = [
  "night",
  "morning",
  "afternoon",
  "evening",
] as const satisfies readonly LocalDaypart[];
const HUMIDITY_BINS = ["<50", "[50,80)", ">=80", "missing"] as const;
const WIND_BINS = ["<2", "[2,5)", ">=5", "missing"] as const;

export type TemperatureWeatherStrategy = (typeof STRATEGIES)[number];
export type TemperatureWeatherScoreCohort = Extract<
  ForecastTrainingCohort,
  "fixed_lead_anchor" | "legacy_v4_retrieval_snapshot"
>;
type HumidityBin = (typeof HUMIDITY_BINS)[number];
type WindBin = (typeof WIND_BINS)[number];
type SupportedHumidityBin = Exclude<HumidityBin, "missing">;
type SupportedWindBin = Exclude<WindBin, "missing">;
type ModelPath = "calendar_start" | "raw_start";

// describe one exact retained temperature example
export interface TemperatureWeatherResearchEvent {
  readonly actual: number;
  readonly baselineAdjusted: number;
  readonly baselineEligible: boolean;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string | null;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// compare all frozen strategies on one denominator
export interface TemperatureWeatherResearchComparison {
  readonly calendarBaseline: TemperatureLeadResearchScore;
  readonly calendarTemperature: TemperatureLeadResearchScore;
  readonly calendarTemperatureWeather: TemperatureLeadResearchScore;
  readonly raw: TemperatureLeadResearchScore;
  readonly rawTemperatureWeather: TemperatureLeadResearchScore;
}

// expose one fitted temperature component without training rows
export interface TemperatureWeatherTemperatureCell {
  readonly coefficient: number;
  readonly daypart: LocalDaypart;
  readonly effectiveEventCount: number;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly path: ModelPath;
  readonly rawCoefficient: number;
  readonly season: LocalMeteorologicalSeason;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly temperatureBin: number;
  readonly temperatureMaximumExclusiveC: number;
  readonly temperatureMinimumC: number;
}

// expose one fitted weather component without training rows
export interface TemperatureWeatherWeatherCell {
  readonly coefficient: number;
  readonly daypart: LocalDaypart;
  readonly effectiveEventCount: number;
  readonly humidityBin: SupportedHumidityBin;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly path: ModelPath;
  readonly rawCoefficient: number;
  readonly season: LocalMeteorologicalSeason;
  readonly supportLocalDateCount: number;
  readonly supportUniqueValidHours: number;
  readonly windSpeedBin: SupportedWindBin;
}

// describe strategy fallbacks over the retained score denominator
export interface TemperatureWeatherFallbackCoverage {
  readonly baselineIneligibleCount: number;
  readonly baselineEligibleCount: number;
  readonly calendarBaselineAppliedCount: number;
  readonly calendarTemperature: {
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
  };
  readonly calendarTemperatureWeather: {
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly weatherFeatureMissingCount: number;
    readonly weatherSupportedCount: number;
    readonly weatherUnsupportedCount: number;
  };
  readonly rawTemperatureWeather: {
    readonly temperatureSupportedCount: number;
    readonly temperatureUnsupportedCount: number;
    readonly weatherFeatureMissingCount: number;
    readonly weatherSupportedCount: number;
    readonly weatherUnsupportedCount: number;
  };
}

// describe one lead diagnostic
export interface TemperatureWeatherLeadDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly key: string;
  readonly maximumHours: number;
  readonly minimumHours: number;
}

// describe one daypart diagnostic slice
export interface TemperatureWeatherDaypartDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly daypart: LocalDaypart;
}

// describe one local-date diagnostic slice
export interface TemperatureWeatherLocalDateDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly localDate: string;
}

// describe one forecast-temperature diagnostic slice
export interface TemperatureWeatherTemperatureBinDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly temperatureBin: {
    readonly index: number;
    readonly maximumExclusiveC: number;
    readonly minimumC: number;
  };
}

// describe one joint forecast-weather diagnostic slice
export interface TemperatureWeatherRegimeDiagnostic {
  readonly comparison: TemperatureWeatherResearchComparison;
  readonly humidityBin: HumidityBin;
  readonly windSpeedBin: WindBin;
}

// report a complete offline weather-conditioning experiment
export interface TemperatureWeatherResearchReport {
  readonly contractVersion: typeof TEMPERATURE_WEATHER_RESEARCH_CONTRACT_VERSION;
  readonly coverage: TemperatureWeatherFallbackCoverage;
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureWeatherDaypartDiagnostic[];
    readonly byLeadBand: readonly TemperatureWeatherLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureWeatherLocalDateDiagnostic[];
    readonly bySixHourBucket: readonly TemperatureWeatherLeadDiagnostic[];
    readonly byTemperatureBin: readonly TemperatureWeatherTemperatureBinDiagnostic[];
    readonly byWeatherRegime: readonly TemperatureWeatherRegimeDiagnostic[];
  };
  readonly evidenceStatus:
    | "retrospective_comparison_only"
    | "empty_score_cohort"
    | "empty_training_cohort";
  readonly first48Hours: TemperatureWeatherResearchComparison;
  readonly inputCoverage: {
    readonly baselineEligibleEventCount: number;
    readonly eventCount: number;
    readonly localDateCount: number;
    readonly uniqueValidHours: number;
  };
  readonly models: {
    readonly calendarStart: {
      readonly temperature: readonly TemperatureWeatherTemperatureCell[];
      readonly weather: readonly TemperatureWeatherWeatherCell[];
    };
    readonly rawStart: {
      readonly temperature: readonly TemperatureWeatherTemperatureCell[];
      readonly weather: readonly TemperatureWeatherWeatherCell[];
    };
  };
  readonly overall: TemperatureWeatherResearchComparison;
  readonly policy: {
    readonly componentCorrectionMaximumC: 5;
    readonly componentCorrectionMinimumC: -5;
    readonly finalCorrectionMaximumC: 5;
    readonly finalCorrectionMinimumC: -5;
    readonly finalTemperatureMaximumC: 70;
    readonly finalTemperatureMinimumC: -100;
    readonly minimumLocalDates: typeof TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES;
    readonly minimumUniqueValidHours: typeof TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS;
    readonly parentCoefficient: 0;
    readonly pseudocount: typeof TEMPERATURE_WEATHER_PSEUDOCOUNT;
    readonly scoreDenominator: "all_matched_temperature_events";
    readonly scoreInformationBoundary: "live_referenceAt_or_anchor_validAt_minus_targetLeadHours";
    readonly trainingObservationAvailableAt: "validAt_plus_1_hour";
    readonly unsupportedComponent: 0;
    readonly weatherResidualUsesUnclippedPrecedingStages: true;
  };
  readonly productionActivationAllowed: false;
  readonly promotable: false;
  readonly researchOnly: true;
  readonly runtimeBundleCreated: false;
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly trainingCoverage: {
    readonly baselineEligibleEventCount: number;
    readonly eventCount: number;
    readonly localDateCount: number;
    readonly uniqueValidHours: number;
  };
}

interface PreparedEvent extends TemperatureWeatherResearchEvent {
  readonly daypart: LocalDaypart;
  readonly humidityBin: HumidityBin;
  readonly informationBoundaryMilliseconds: number;
  readonly key: string;
  readonly leadBand: ForecastLeadBandKey;
  readonly localDate: string;
  readonly season: LocalMeteorologicalSeason;
  readonly sixHourBucket: string;
  readonly temperatureBin: number;
  readonly validAtMilliseconds: number;
  readonly windSpeedBin: WindBin;
}

interface CellSupport {
  readonly localDateCount: number;
  readonly uniqueValidHours: number;
}

interface EvaluatedEvent extends PreparedEvent {
  readonly predictions: Readonly<Record<TemperatureWeatherStrategy, number>>;
  readonly support: {
    readonly calendarTemperature: boolean;
    readonly calendarWeather: "ineligible" | "missing" | "supported" | "unsupported";
    readonly rawTemperature: boolean;
    readonly rawWeather: "ineligible" | "missing" | "supported" | "unsupported";
  };
}

interface ModelCells {
  readonly temperature: readonly TemperatureWeatherTemperatureCell[];
  readonly temperatureByKey: ReadonlyMap<string, TemperatureWeatherTemperatureCell>;
  readonly weather: readonly TemperatureWeatherWeatherCell[];
  readonly weatherByKey: ReadonlyMap<string, TemperatureWeatherWeatherCell>;
}

const EXACT_EVENT_KEYS = [
  "actual",
  "baselineAdjusted",
  "baselineEligible",
  "rawForecast",
  "rawRelativeHumidityPercent",
  "rawWindSpeedMps",
  "referenceAt",
  "targetLeadHours",
  "validAt",
] as const;

// normalize one canonical UTC instant
function normalizeUtcInstant(value: string, field: string): string {
  // reject offsets, malformed values, and invalid instants
  if (!UTC_INSTANT_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  const normalized = new Date(value).toISOString();

  // reject calendar rollover while allowing omitted zero milliseconds
  if (normalized !== value && normalized !== value.replace("Z", ".000Z")) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return normalized;
}

// require one finite numeric field
function requireFinite(value: number, field: string): number {
  // reject non-finite model material
  if (!Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

// require one nullable bounded predictor
function requireNullableRange(
  value: number | null,
  field: string,
  minimum: number,
  maximum: number,
): number | null {
  // preserve explicit missing predictors
  if (value === null) {
    return null;
  }

  // reject invalid forecast predictors
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${field} must be null or between ${minimum} and ${maximum}`,
    );
  }

  return value;
}

// reject missing or additional event fields
function validateExactEventShape(event: TemperatureWeatherResearchEvent): void {
  const keys = Object.keys(event).sort();
  const expected = [...EXACT_EVENT_KEYS].sort();

  // bind runtime inputs to the frozen event schema
  if (
    keys.length !== expected.length ||
    keys.some(
      // compare each sorted schema field
      (key, index) => key !== expected[index],
    )
  ) {
    throw new RangeError("temperature weather event fields must match the frozen schema");
  }
}

// map forecast temperature to a five-degree floor bin
function temperatureBinFor(temperatureC: number): number {
  return Math.floor(temperatureC / 5);
}

// map forecast humidity to the frozen regime
function humidityBinFor(relativeHumidityPercent: number | null): HumidityBin {
  // preserve missing forecast humidity
  if (relativeHumidityPercent === null) {
    return "missing";
  }

  // isolate dry forecast conditions
  if (relativeHumidityPercent < 50) {
    return "<50";
  }

  // isolate moderate forecast humidity
  if (relativeHumidityPercent < 80) {
    return "[50,80)";
  }

  return ">=80";
}

// map forecast wind speed to the frozen regime
function windSpeedBinFor(windSpeedMps: number | null): WindBin {
  // preserve missing forecast wind speed
  if (windSpeedMps === null) {
    return "missing";
  }

  // isolate calm forecast conditions
  if (windSpeedMps < 2) {
    return "<2";
  }

  // isolate moderate forecast wind
  if (windSpeedMps < 5) {
    return "[2,5)";
  }

  return ">=5";
}

// derive one six-hour lead bucket label
function sixHourBucketFor(targetLeadHours: number): string {
  const minimumHours = Math.floor((targetLeadHours - 1) / 6) * 6 + 1;
  const maximumHours = minimumHours + 5;
  return `${String(minimumHours).padStart(3, "0")}-${String(maximumHours).padStart(3, "0")}`;
}

// prepare and validate one frozen event
function prepareEvent(
  event: TemperatureWeatherResearchEvent,
  cohort: TemperatureWeatherScoreCohort,
  purpose: "score" | "training",
): PreparedEvent {
  validateExactEventShape(event);
  const validAt = normalizeUtcInstant(event.validAt, "validAt");
  const validAtMilliseconds = Date.parse(validAt);

  // require exact hourly forecast targets
  if (validAtMilliseconds % MILLISECONDS_PER_HOUR !== 0) {
    throw new RangeError("validAt must be aligned to an exact UTC hour");
  }

  // require all supported leads
  if (
    !Number.isInteger(event.targetLeadHours) ||
    event.targetLeadHours < 1 ||
    event.targetLeadHours > 168
  ) {
    throw new RangeError("targetLeadHours must be an integer between 1 and 168");
  }

  // require fixed training anchors and archive score anchors
  if (
    (purpose === "training" || cohort === "fixed_lead_anchor") &&
    !FIXED_ANCHOR_LEADS.has(event.targetLeadHours)
  ) {
    throw new RangeError(
      "fixed lead anchors must use 24-hour increments through 168 hours",
    );
  }

  let referenceAt: string | null = null;
  let informationBoundaryMilliseconds =
    validAtMilliseconds - event.targetLeadHours * MILLISECONDS_PER_HOUR;

  // require null references for fixed anchors
  if (purpose === "training" || cohort === "fixed_lead_anchor") {
    // reject invented archive issue timestamps
    if (event.referenceAt !== null) {
      throw new RangeError("fixed lead anchors must have a null referenceAt");
    }
  } else {
    // require a truthful live retrieval reference
    if (event.referenceAt === null) {
      throw new RangeError("legacy retrieval scores require referenceAt");
    }

    referenceAt = normalizeUtcInstant(event.referenceAt, "referenceAt");
    informationBoundaryMilliseconds = Date.parse(referenceAt);
    const continuousLeadHours =
      (validAtMilliseconds - informationBoundaryMilliseconds) /
      MILLISECONDS_PER_HOUR;

    // bind the live reference to its claimed positive lead
    if (
      continuousLeadHours <= 0 ||
      Math.ceil(continuousLeadHours) !== event.targetLeadHours
    ) {
      throw new RangeError("targetLeadHours must match validAt and referenceAt");
    }
  }

  // require one literal eligibility flag
  if (typeof event.baselineEligible !== "boolean") {
    throw new RangeError("baselineEligible must be boolean");
  }

  const actual = requireFinite(event.actual, "actual");
  const baselineAdjusted = requireFinite(event.baselineAdjusted, "baselineAdjusted");
  const rawForecast = requireFinite(event.rawForecast, "rawForecast");

  // reject temperatures outside the frozen physical domain
  if (
    actual < -100 ||
    actual > 70 ||
    baselineAdjusted < -100 ||
    baselineAdjusted > 70 ||
    rawForecast < -100 ||
    rawForecast > 70
  ) {
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
    baselineAdjusted,
    baselineEligible: event.baselineEligible,
    daypart: calendar.daypart,
    humidityBin: humidityBinFor(rawRelativeHumidityPercent),
    informationBoundaryMilliseconds,
    key: `${validAt}|${event.targetLeadHours}`,
    leadBand: forecastLeadBandFor(event.targetLeadHours),
    localDate: calendar.localDate,
    rawForecast,
    rawRelativeHumidityPercent,
    rawWindSpeedMps,
    referenceAt,
    season: calendar.season,
    sixHourBucket: sixHourBucketFor(event.targetLeadHours),
    targetLeadHours: event.targetLeadHours,
    temperatureBin: temperatureBinFor(rawForecast),
    validAt,
    validAtMilliseconds,
    windSpeedBin: windSpeedBinFor(rawWindSpeedMps),
  };
}

// sort model inputs independently from arrival order
function comparePreparedEvents(left: PreparedEvent, right: PreparedEvent): number {
  return (
    left.validAt.localeCompare(right.validAt) ||
    left.targetLeadHours - right.targetLeadHours ||
    (left.referenceAt ?? "").localeCompare(right.referenceAt ?? "")
  );
}

// prepare one cohort and reject duplicate forecast identities
function prepareEvents(
  events: readonly TemperatureWeatherResearchEvent[],
  cohort: TemperatureWeatherScoreCohort,
  purpose: "score" | "training",
): readonly PreparedEvent[] {
  // require actual arrays rather than array-like objects
  if (!Array.isArray(events)) {
    throw new RangeError(`${purpose}Events must be an array`);
  }

  const prepared = events.map(
    // validate every retained event
    (event) => prepareEvent(event, cohort, purpose),
  ).sort(comparePreparedEvents);
  const identities = new Set<string>();

  // reject unresolved valid-time and lead duplicates
  for (const event of prepared) {
    // reject duplicate model-count units
    if (identities.has(event.key)) {
      throw new RangeError(
        `${purpose}Events must have unique validAt and targetLeadHours identities`,
      );
    }

    identities.add(event.key);
  }

  return prepared;
}

// bind training availability to the earliest scoring boundary
function validateTemporalSeparation(
  trainingEvents: readonly PreparedEvent[],
  scoreEvents: readonly PreparedEvent[],
): void {
  // leave explicit empty cohorts without a fabricated separation claim
  if (trainingEvents.length === 0 || scoreEvents.length === 0) {
    return;
  }

  let latestTrainingValidAt = Number.NEGATIVE_INFINITY;
  let earliestScoreBoundary = Number.POSITIVE_INFINITY;

  // find the latest training observation without argument spreading
  for (const event of trainingEvents) {
    latestTrainingValidAt = Math.max(
      latestTrainingValidAt,
      event.validAtMilliseconds,
    );
  }

  // find the earliest score boundary without argument spreading
  for (const event of scoreEvents) {
    earliestScoreBoundary = Math.min(
      earliestScoreBoundary,
      event.informationBoundaryMilliseconds,
    );
  }

  // require all training observations to be available before scoring
  if (latestTrainingValidAt + MILLISECONDS_PER_HOUR > earliestScoreBoundary) {
    throw new RangeError("training observations cross the earliest score information boundary");
  }
}

// build one stable temperature cell key
function temperatureCellKey(event: PreparedEvent): string {
  return [
    event.leadBand,
    event.season,
    event.daypart,
    String(event.temperatureBin),
  ].join("|");
}

// build one stable supported weather cell key
function weatherCellKey(event: PreparedEvent): string | null {
  // reject incomplete weather regimes from model fitting and lookup
  if (event.humidityBin === "missing" || event.windSpeedBin === "missing") {
    return null;
  }

  return [
    event.leadBand,
    event.season,
    event.daypart,
    event.humidityBin,
    event.windSpeedBin,
  ].join("|");
}

// group eligible events by one stable cell key
function groupEvents(
  events: readonly PreparedEvent[],
  keyFor: (event: PreparedEvent) => string | null,
): ReadonlyMap<string, readonly PreparedEvent[]> {
  const groups = new Map<string, PreparedEvent[]>();

  // exclude the common baseline-ineligible mask
  for (const event of events) {
    // skip ineligible rows for every fitted path
    if (!event.baselineEligible) {
      continue;
    }

    const key = keyFor(event);

    // skip missing-feature weather cells
    if (key === null) {
      continue;
    }

    let rows = groups.get(key);

    // initialize one cell group
    if (rows === undefined) {
      rows = [];
      groups.set(key, rows);
    }

    rows.push(event);
  }

  return groups;
}

// count the frozen independent support dimensions
function cellSupport(events: readonly PreparedEvent[]): CellSupport {
  return {
    localDateCount: new Set(events.map(
      // count unique local dates
      (event) => event.localDate,
    )).size,
    uniqueValidHours: new Set(events.map(
      // count unique valid hours
      (event) => event.validAt,
    )).size,
  };
}

// create one deterministic unit-weight residual
function residualObservation(
  event: PreparedEvent,
  residual: number,
  stage: "temperature" | "weather",
): WeightedResidualObservation {
  return {
    referenceAt: null,
    residual,
    stableId: `${stage}|${event.validAt}|${event.targetLeadHours}`,
    targetLeadHours: event.targetLeadHours,
    validAt: event.validAt,
    weight: 1,
  };
}

// fit supported temperature cells for one independent path
function fitTemperatureCells(
  trainingEvents: readonly PreparedEvent[],
  path: ModelPath,
): {
  readonly cells: readonly TemperatureWeatherTemperatureCell[];
  readonly cellsByKey: ReadonlyMap<string, TemperatureWeatherTemperatureCell>;
} {
  const groups = groupEvents(trainingEvents, temperatureCellKey);
  const cells: TemperatureWeatherTemperatureCell[] = [];
  const cellsByKey = new Map<string, TemperatureWeatherTemperatureCell>();
  const policy = metricPolicyFor("temperatureC");

  // fit cells in stable lexical order
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key);

    // guard the stable group traversal
    if (rows === undefined) {
      throw new Error("temperature research group disappeared");
    }

    const support = cellSupport(rows);

    // inherit zero below either frozen support floor
    if (
      support.localDateCount < TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES ||
      support.uniqueValidHours < TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS
    ) {
      continue;
    }

    const observations = rows.map(
      // fit residuals from the independent path start
      (event) => {
        const baseDelta = path === "calendar_start"
          ? event.baselineAdjusted - event.rawForecast
          : 0;
        return residualObservation(
          event,
          event.actual - (event.rawForecast + baseDelta),
          "temperature",
        );
      },
    );
    const fitted = fitCoefficientCell(observations, {
      direction: false,
      minimumEffectiveEvents: TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS,
      parentCoefficient: 0,
      policy,
      pseudocount: TEMPERATURE_WEATHER_PSEUDOCOUNT,
    });

    // guard support already proven above
    if (fitted === null) {
      throw new Error("supported temperature research cell did not fit");
    }

    const representative = rows[0];

    // guard the nonempty supported group
    if (representative === undefined) {
      throw new Error("supported temperature research cell is empty");
    }

    const cell: TemperatureWeatherTemperatureCell = {
      coefficient: fitted.coefficient,
      daypart: representative.daypart,
      effectiveEventCount: fitted.effectiveEventCount,
      key,
      leadBand: representative.leadBand,
      path,
      rawCoefficient: fitted.rawCoefficient,
      season: representative.season,
      supportLocalDateCount: support.localDateCount,
      supportUniqueValidHours: support.uniqueValidHours,
      temperatureBin: representative.temperatureBin,
      temperatureMaximumExclusiveC: (representative.temperatureBin + 1) * 5,
      temperatureMinimumC: representative.temperatureBin * 5,
    };
    cells.push(cell);
    cellsByKey.set(key, cell);
  }

  return { cells, cellsByKey };
}

// fit supported weather cells after one path's temperature stage
function fitWeatherCells(
  trainingEvents: readonly PreparedEvent[],
  path: ModelPath,
  temperatureByKey: ReadonlyMap<string, TemperatureWeatherTemperatureCell>,
): {
  readonly cells: readonly TemperatureWeatherWeatherCell[];
  readonly cellsByKey: ReadonlyMap<string, TemperatureWeatherWeatherCell>;
} {
  const groups = groupEvents(trainingEvents, weatherCellKey);
  const cells: TemperatureWeatherWeatherCell[] = [];
  const cellsByKey = new Map<string, TemperatureWeatherWeatherCell>();
  const policy = metricPolicyFor("temperatureC");

  // fit cells in stable lexical order
  for (const key of [...groups.keys()].sort()) {
    const rows = groups.get(key);

    // guard the stable group traversal
    if (rows === undefined) {
      throw new Error("weather research group disappeared");
    }

    const support = cellSupport(rows);

    // inherit zero below either frozen support floor
    if (
      support.localDateCount < TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES ||
      support.uniqueValidHours < TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS
    ) {
      continue;
    }

    const observations = rows.map(
      // fit the unclipped residual after the preceding stages
      (event) => {
        const baseDelta = path === "calendar_start"
          ? event.baselineAdjusted - event.rawForecast
          : 0;
        const temperatureDelta =
          temperatureByKey.get(temperatureCellKey(event))?.coefficient ?? 0;
        return residualObservation(
          event,
          event.actual - (event.rawForecast + baseDelta + temperatureDelta),
          "weather",
        );
      },
    );
    const fitted = fitCoefficientCell(observations, {
      direction: false,
      minimumEffectiveEvents: TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS,
      parentCoefficient: 0,
      policy,
      pseudocount: TEMPERATURE_WEATHER_PSEUDOCOUNT,
    });

    // guard support already proven above
    if (fitted === null) {
      throw new Error("supported weather research cell did not fit");
    }

    const representative = rows[0];

    // guard the nonempty supported group
    if (
      representative === undefined ||
      representative.humidityBin === "missing" ||
      representative.windSpeedBin === "missing"
    ) {
      throw new Error("supported weather research cell is incomplete");
    }

    const cell: TemperatureWeatherWeatherCell = {
      coefficient: fitted.coefficient,
      daypart: representative.daypart,
      effectiveEventCount: fitted.effectiveEventCount,
      humidityBin: representative.humidityBin,
      key,
      leadBand: representative.leadBand,
      path,
      rawCoefficient: fitted.rawCoefficient,
      season: representative.season,
      supportLocalDateCount: support.localDateCount,
      supportUniqueValidHours: support.uniqueValidHours,
      windSpeedBin: representative.windSpeedBin,
    };
    cells.push(cell);
    cellsByKey.set(key, cell);
  }

  return { cells, cellsByKey };
}

// fit both stages for one independent path
function fitModelPath(
  trainingEvents: readonly PreparedEvent[],
  path: ModelPath,
): ModelCells {
  const temperature = fitTemperatureCells(trainingEvents, path);
  const weather = fitWeatherCells(
    trainingEvents,
    path,
    temperature.cellsByKey,
  );
  return {
    temperature: temperature.cells,
    temperatureByKey: temperature.cellsByKey,
    weather: weather.cells,
    weatherByKey: weather.cellsByKey,
  };
}

// constrain the cumulative correction and final temperature once
function finalPrediction(rawForecast: number, totalDelta: number): number {
  const cappedDelta = Math.min(5, Math.max(-5, totalDelta));
  return Math.min(70, Math.max(-100, rawForecast + cappedDelta));
}

// resolve one weather component and its fallback reason
function weatherComponent(
  event: PreparedEvent,
  model: ModelCells,
): {
  readonly coefficient: number;
  readonly state: "missing" | "supported" | "unsupported";
} {
  const key = weatherCellKey(event);

  // preserve the preceding stage when predictors are missing
  if (key === null) {
    return { coefficient: 0, state: "missing" };
  }

  const cell = model.weatherByKey.get(key);

  // preserve the preceding stage below cell support
  if (cell === undefined) {
    return { coefficient: 0, state: "unsupported" };
  }

  return { coefficient: cell.coefficient, state: "supported" };
}

// score all five strategies for one retained event
function evaluateEvent(
  event: PreparedEvent,
  calendarModel: ModelCells,
  rawModel: ModelCells,
): EvaluatedEvent {
  // force a common raw fallback outside the baseline mask
  if (!event.baselineEligible) {
    return {
      ...event,
      predictions: {
        calendarBaseline: event.rawForecast,
        calendarTemperature: event.rawForecast,
        calendarTemperatureWeather: event.rawForecast,
        raw: event.rawForecast,
        rawTemperatureWeather: event.rawForecast,
      },
      support: {
        calendarTemperature: false,
        calendarWeather: "ineligible",
        rawTemperature: false,
        rawWeather: "ineligible",
      },
    };
  }

  const baseDelta = event.baselineAdjusted - event.rawForecast;
  const calendarTemperatureCell = calendarModel.temperatureByKey.get(
    temperatureCellKey(event),
  );
  const rawTemperatureCell = rawModel.temperatureByKey.get(
    temperatureCellKey(event),
  );
  const calendarTemperatureDelta = calendarTemperatureCell?.coefficient ?? 0;
  const rawTemperatureDelta = rawTemperatureCell?.coefficient ?? 0;
  const calendarWeather = weatherComponent(event, calendarModel);
  const rawWeather = weatherComponent(event, rawModel);

  return {
    ...event,
    predictions: {
      calendarBaseline: finalPrediction(event.rawForecast, baseDelta),
      calendarTemperature: finalPrediction(
        event.rawForecast,
        baseDelta + calendarTemperatureDelta,
      ),
      calendarTemperatureWeather: finalPrediction(
        event.rawForecast,
        baseDelta + calendarTemperatureDelta + calendarWeather.coefficient,
      ),
      raw: event.rawForecast,
      rawTemperatureWeather: finalPrediction(
        event.rawForecast,
        rawTemperatureDelta + rawWeather.coefficient,
      ),
    },
    support: {
      calendarTemperature: calendarTemperatureCell !== undefined,
      calendarWeather: calendarWeather.state,
      rawTemperature: rawTemperatureCell !== undefined,
      rawWeather: rawWeather.state,
    },
  };
}

// score one strategy over an exact common event subset
function scoreStrategy(
  events: readonly EvaluatedEvent[],
  strategy: TemperatureWeatherStrategy,
): TemperatureLeadResearchScore {
  return scoreTemperatureResearchPredictions(
    events.map(
      // project one frozen strategy prediction
      (event) => ({
        event: {
          actual: event.actual,
          localDate: event.localDate,
          rawForecast: event.rawForecast,
          validAt: event.validAt,
        },
        prediction: event.predictions[strategy],
      }),
    ),
  );
}

// compare all strategies over an exact common event subset
function compareStrategies(
  events: readonly EvaluatedEvent[],
): TemperatureWeatherResearchComparison {
  return {
    calendarBaseline: scoreStrategy(events, "calendarBaseline"),
    calendarTemperature: scoreStrategy(events, "calendarTemperature"),
    calendarTemperatureWeather: scoreStrategy(events, "calendarTemperatureWeather"),
    raw: scoreStrategy(events, "raw"),
    rawTemperatureWeather: scoreStrategy(events, "rawTemperatureWeather"),
  };
}

// group events for one complete diagnostic dimension
function groupEvaluatedEvents(
  events: readonly EvaluatedEvent[],
  keyFor: (event: EvaluatedEvent) => string,
): ReadonlyMap<string, readonly EvaluatedEvent[]> {
  const groups = new Map<string, EvaluatedEvent[]>();

  // retain every score event in one diagnostic cell
  for (const event of events) {
    const key = keyFor(event);
    let rows = groups.get(key);

    // initialize one diagnostic group
    if (rows === undefined) {
      rows = [];
      groups.set(key, rows);
    }

    rows.push(event);
  }

  return groups;
}

// summarize one input cohort without retaining rows
function inputCoverage(events: readonly PreparedEvent[]): {
  readonly baselineEligibleEventCount: number;
  readonly eventCount: number;
  readonly localDateCount: number;
  readonly uniqueValidHours: number;
} {
  return {
    baselineEligibleEventCount: events.filter(
      // count the shared model eligibility mask
      (event) => event.baselineEligible,
    ).length,
    eventCount: events.length,
    localDateCount: new Set(events.map(
      // count unique local dates
      (event) => event.localDate,
    )).size,
    uniqueValidHours: new Set(events.map(
      // count unique valid hours
      (event) => event.validAt,
    )).size,
  };
}

// count explicit score fallbacks over the common denominator
function fallbackCoverage(
  events: readonly EvaluatedEvent[],
): TemperatureWeatherFallbackCoverage {
  const eligible = events.filter(
    // isolate the shared baseline mask
    (event) => event.baselineEligible,
  );
  // count one weather fallback state
  const countWeatherState = (
    path: "calendarWeather" | "rawWeather",
    state: "missing" | "supported" | "unsupported",
  ): number => eligible.filter(
    // count one explicit path fallback state
    (event) => event.support[path] === state,
  ).length;

  return {
    baselineEligibleCount: eligible.length,
    baselineIneligibleCount: events.length - eligible.length,
    calendarBaselineAppliedCount: eligible.length,
    calendarTemperature: {
      temperatureSupportedCount: eligible.filter(
        // count supported calendar temperature cells
        (event) => event.support.calendarTemperature,
      ).length,
      temperatureUnsupportedCount: eligible.filter(
        // count unsupported calendar temperature cells
        (event) => !event.support.calendarTemperature,
      ).length,
    },
    calendarTemperatureWeather: {
      temperatureSupportedCount: eligible.filter(
        // count supported calendar temperature cells
        (event) => event.support.calendarTemperature,
      ).length,
      temperatureUnsupportedCount: eligible.filter(
        // count unsupported calendar temperature cells
        (event) => !event.support.calendarTemperature,
      ).length,
      weatherFeatureMissingCount: countWeatherState(
        "calendarWeather",
        "missing",
      ),
      weatherSupportedCount: countWeatherState("calendarWeather", "supported"),
      weatherUnsupportedCount: countWeatherState(
        "calendarWeather",
        "unsupported",
      ),
    },
    rawTemperatureWeather: {
      temperatureSupportedCount: eligible.filter(
        // count supported raw-start temperature cells
        (event) => event.support.rawTemperature,
      ).length,
      temperatureUnsupportedCount: eligible.filter(
        // count unsupported raw-start temperature cells
        (event) => !event.support.rawTemperature,
      ).length,
      weatherFeatureMissingCount: countWeatherState("rawWeather", "missing"),
      weatherSupportedCount: countWeatherState("rawWeather", "supported"),
      weatherUnsupportedCount: countWeatherState("rawWeather", "unsupported"),
    },
  };
}

// run the frozen offline weather-conditioning experiment
export function analyzeTemperatureWeatherResearch(input: {
  readonly scoreCohort: TemperatureWeatherScoreCohort;
  readonly scoreEvents: readonly TemperatureWeatherResearchEvent[];
  readonly trainingEvents: readonly TemperatureWeatherResearchEvent[];
}): TemperatureWeatherResearchReport {
  // require one frozen score cohort
  if (
    input.scoreCohort !== "fixed_lead_anchor" &&
    input.scoreCohort !== "legacy_v4_retrieval_snapshot"
  ) {
    throw new RangeError("scoreCohort must be a supported forecast cohort");
  }

  const trainingEvents = prepareEvents(
    input.trainingEvents,
    "fixed_lead_anchor",
    "training",
  );
  const scoreEvents = prepareEvents(
    input.scoreEvents,
    input.scoreCohort,
    "score",
  );
  validateTemporalSeparation(trainingEvents, scoreEvents);
  const calendarModel = fitModelPath(trainingEvents, "calendar_start");
  const rawModel = fitModelPath(trainingEvents, "raw_start");
  const evaluated = scoreEvents.map(
    // score one retained event under every strategy
    (event) => evaluateEvent(event, calendarModel, rawModel),
  );
  const byDaypart = groupEvaluatedEvents(
    evaluated,
    // group by forecast-valid local daypart
    (event) => event.daypart,
  );
  const byLeadBand = groupEvaluatedEvents(
    evaluated,
    // group by frozen forecast lead band
    (event) => event.leadBand,
  );
  const byLocalDate = groupEvaluatedEvents(
    evaluated,
    // group by forecast-valid local date
    (event) => event.localDate,
  );
  const bySixHourBucket = groupEvaluatedEvents(
    evaluated,
    // group by frozen six-hour lead bucket
    (event) => event.sixHourBucket,
  );
  const byTemperatureBin = groupEvaluatedEvents(
    evaluated,
    // group by forecast temperature only
    (event) => String(event.temperatureBin),
  );
  const byWeatherRegime = groupEvaluatedEvents(
    evaluated,
    // group by exact-row forecast humidity and wind
    (event) => `${event.humidityBin}|${event.windSpeedBin}`,
  );
  const localDates = [...byLocalDate.keys()].sort();
  const temperatureBins = [...byTemperatureBin.keys()].sort(
    // preserve numeric temperature-bin order
    (left, right) => Number(left) - Number(right),
  );
  const weatherRegimes = HUMIDITY_BINS.flatMap(
    // emit every frozen humidity and wind combination
    (humidityBin) => WIND_BINS.map(
      // bind one complete joint regime
      (windBin) => `${humidityBin}|${windBin}`,
    ),
  );
  const evidenceStatus = scoreEvents.length === 0
    ? "empty_score_cohort"
    : trainingEvents.length === 0
      ? "empty_training_cohort"
      : "retrospective_comparison_only";

  return {
    contractVersion: TEMPERATURE_WEATHER_RESEARCH_CONTRACT_VERSION,
    coverage: fallbackCoverage(evaluated),
    diagnostics: {
      byDaypart: DAYPARTS.map(
        // emit every frozen daypart
        (daypart) => ({
          comparison: compareStrategies(byDaypart.get(daypart) ?? []),
          daypart,
        }),
      ),
      byLeadBand: FORECAST_LEAD_BANDS.map(
        // emit every frozen broad lead band
        (band) => ({
          comparison: compareStrategies(byLeadBand.get(band.key) ?? []),
          key: band.key,
          maximumHours: band.maximumHours,
          minimumHours: band.minimumHours,
        }),
      ),
      byLocalDate: localDates.map(
        // emit each observed local date
        (localDate) => ({
          comparison: compareStrategies(byLocalDate.get(localDate) ?? []),
          localDate,
        }),
      ),
      bySixHourBucket: Array.from(
        { length: 28 },
        // emit every frozen six-hour bucket
        (_unused, index) => {
          const minimumHours = index * 6 + 1;
          const maximumHours = minimumHours + 5;
          const key = sixHourBucketFor(minimumHours);
          return {
            comparison: compareStrategies(bySixHourBucket.get(key) ?? []),
            key,
            maximumHours,
            minimumHours,
          };
        },
      ),
      byTemperatureBin: temperatureBins.map(
        // emit each observed forecast-temperature bin
        (temperatureBinText) => {
          const index = Number(temperatureBinText);
          return {
            comparison: compareStrategies(
              byTemperatureBin.get(temperatureBinText) ?? [],
            ),
            temperatureBin: {
              index,
              maximumExclusiveC: (index + 1) * 5,
              minimumC: index * 5,
            },
          };
        },
      ),
      byWeatherRegime: weatherRegimes.map(
        // emit every forecast humidity and wind regime
        (key) => {
          const [humidityBin, windSpeedBin] = key.split("|") as [
            HumidityBin,
            WindBin,
          ];
          return {
            comparison: compareStrategies(byWeatherRegime.get(key) ?? []),
            humidityBin,
            windSpeedBin,
          };
        },
      ),
    },
    evidenceStatus,
    first48Hours: compareStrategies(evaluated.filter(
      // isolate the near-term forecast window
      (event) => event.targetLeadHours <= 48,
    )),
    inputCoverage: inputCoverage(scoreEvents),
    models: {
      calendarStart: {
        temperature: calendarModel.temperature,
        weather: calendarModel.weather,
      },
      rawStart: {
        temperature: rawModel.temperature,
        weather: rawModel.weather,
      },
    },
    overall: compareStrategies(evaluated),
    policy: {
      componentCorrectionMaximumC: 5,
      componentCorrectionMinimumC: -5,
      finalCorrectionMaximumC: 5,
      finalCorrectionMinimumC: -5,
      finalTemperatureMaximumC: 70,
      finalTemperatureMinimumC: -100,
      minimumLocalDates: TEMPERATURE_WEATHER_MINIMUM_LOCAL_DATES,
      minimumUniqueValidHours: TEMPERATURE_WEATHER_MINIMUM_UNIQUE_VALID_HOURS,
      parentCoefficient: 0,
      pseudocount: TEMPERATURE_WEATHER_PSEUDOCOUNT,
      scoreDenominator: "all_matched_temperature_events",
      scoreInformationBoundary: "live_referenceAt_or_anchor_validAt_minus_targetLeadHours",
      trainingObservationAvailableAt: "validAt_plus_1_hour",
      unsupportedComponent: 0,
      weatherResidualUsesUnclippedPrecedingStages: true,
    },
    productionActivationAllowed: false,
    promotable: false,
    researchOnly: true,
    runtimeBundleCreated: false,
    scoreCohort: input.scoreCohort,
    trainingCoverage: inputCoverage(trainingEvents),
  };
}
