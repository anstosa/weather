import {
  localCalendarFeaturesFor,
  type LocalDaypart,
  type LocalMeteorologicalSeason,
} from "./calendar.js";

// freeze expanded retrospective validation choices
export const TEMPERATURE_ANALOG_VALIDATION_POLICY = Object.freeze({
  bootstrap: Object.freeze({
    blockLengths: Object.freeze([1, 2, 3] as const),
    confidenceIntervalPercentiles: Object.freeze([0.025, 0.975] as const),
    dateAggregate: "sum_of_within_hour_event_mean_losses_and_valid_hour_counts",
    dateDraw: "ceil_n_over_l_circular_blocks_concatenated_and_truncated_to_n",
    generatorReset: "independent_for_each_block_length",
    intervalInterpolation: "linear_sorted_rank_p_times_n_minus_1",
    primaryScope: "first12",
    randomGenerator: "xorshift32_13_17_5_unsigned_divide_2_to_32",
    replicateCount: 20_000,
    seedBase: 20_260_907,
  }),
  contractVersion: "temperature-analog-expanded-validation/v1",
  firstTwelveHourDiagnostics: Object.freeze({
    dayparts: Object.freeze([
      "night",
      "morning",
      "afternoon",
      "evening",
    ] as const),
    exactLeadHours: Object.freeze([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ] as const),
    seasons: Object.freeze([
      "winter",
      "spring",
      "summer",
      "autumn",
    ] as const),
  }),
  qualificationAllowed: false,
  scopes: Object.freeze([
    Object.freeze({ key: "first6", maximumLeadHours: 6, minimumLeadHours: 1 }),
    Object.freeze({ key: "hours7To12", maximumLeadHours: 12, minimumLeadHours: 7 }),
    Object.freeze({ key: "first12", maximumLeadHours: 12, minimumLeadHours: 1 }),
    Object.freeze({ key: "hours13To48", maximumLeadHours: 48, minimumLeadHours: 13 }),
    Object.freeze({ key: "first48", maximumLeadHours: 48, minimumLeadHours: 1 }),
    Object.freeze({ key: "after48", maximumLeadHours: 168, minimumLeadHours: 49 }),
    Object.freeze({ key: "overall", maximumLeadHours: 168, minimumLeadHours: 1 }),
  ]),
} as const);

const MILLISECONDS_PER_HOUR = 3_600_000;
const TWO_TO_THE_THIRTY_SECOND_POWER = 4_294_967_296;

// name one frozen validation scope
export type TemperatureAnalogValidationScopeKey =
  (typeof TEMPERATURE_ANALOG_VALIDATION_POLICY.scopes)[number]["key"];

// retain only structural prediction evidence
export interface TemperatureAnalogValidationRecord {
  readonly actual: number;
  readonly analogPrediction: number;
  readonly baselineEligible: boolean;
  readonly fallbackReason: string | null;
  readonly key: string;
  readonly priorPrediction: number;
  readonly rawForecast: number;
  readonly referenceAt: string;
  readonly selectedSources?: readonly unknown[];
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// describe one hourly-error percentile summary
export interface TemperatureAnalogHourlyPercentiles {
  readonly maximum: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
}

// describe one complete aggregate prediction score
export interface TemperatureAnalogValidationScore {
  readonly eventCount: number;
  readonly eventWeightedMeanAbsoluteError: number | null;
  readonly hourBalancedFractionAbsoluteErrorAbove2C: number | null;
  readonly hourBalancedFractionAbsoluteErrorAbove3C: number | null;
  readonly hourBalancedMeanAbsoluteError: number | null;
  readonly hourBalancedRootMeanSquaredError: number | null;
  readonly hourBalancedSignedBias: number | null;
  readonly hourlyMeanAbsoluteErrorPercentiles: TemperatureAnalogHourlyPercentiles;
  readonly localDateCount: number;
  readonly uniqueValidHours: number;
}

// compare every frozen prediction on one shared cohort
export interface TemperatureAnalogValidationComparison {
  readonly analog: TemperatureAnalogValidationScore;
  readonly prior: TemperatureAnalogValidationScore;
  readonly raw: TemperatureAnalogValidationScore;
}

// describe one frozen lead scope
export interface TemperatureAnalogValidationScope {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly key: TemperatureAnalogValidationScopeKey;
  readonly maximumLeadHours: number;
  readonly minimumLeadHours: number;
}

// describe one aggregate confidence interval
export interface TemperatureAnalogConfidenceInterval {
  readonly lower: number;
  readonly upper: number;
}

// describe paired improvement over one comparator
export interface TemperatureAnalogBootstrapImprovement {
  readonly absoluteMeanAbsoluteErrorC: {
    readonly confidenceInterval95: TemperatureAnalogConfidenceInterval | null;
    readonly point: number | null;
  };
  readonly relativePercent: {
    readonly confidenceInterval95: TemperatureAnalogConfidenceInterval | null;
    readonly point: number | null;
  };
}

// describe one independently seeded bootstrap length
export interface TemperatureAnalogBootstrapBlockResult {
  readonly blockLengthLocalDates: 1 | 2 | 3;
  readonly completedReplicateCount: number;
  readonly configuredReplicateCount: number;
  readonly priorMinusAnalog: TemperatureAnalogBootstrapImprovement;
  readonly rawMinusAnalog: TemperatureAnalogBootstrapImprovement;
  readonly representedLocalDateCount: number;
  readonly seed: number;
}

// compare per-date wins without selecting dates
export interface TemperatureAnalogDateOutcome {
  readonly tieCount: number;
  readonly winCount: number;
  readonly worseCount: number;
}

// describe one local-date aggregate diagnostic
export interface TemperatureAnalogLocalDateDiagnostic {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly localDate: string;
  readonly priorMinusAnalogMeanAbsoluteErrorC: number | null;
  readonly rawMinusAnalogMeanAbsoluteErrorC: number | null;
}

// describe one exact-lead aggregate diagnostic
export interface TemperatureAnalogExactLeadDiagnostic {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly targetLeadHours: number;
}

// describe one season aggregate diagnostic
export interface TemperatureAnalogSeasonDiagnostic {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly season: LocalMeteorologicalSeason;
}

// describe one daypart aggregate diagnostic
export interface TemperatureAnalogDaypartDiagnostic {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly daypart: LocalDaypart;
}

// describe one frozen-prediction date omission
export interface TemperatureAnalogLeaveOneDateOutRow {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly omittedLocalDate: string;
  readonly priorMinusAnalogMeanAbsoluteErrorC: number | null;
  readonly rawMinusAnalogMeanAbsoluteErrorC: number | null;
}

// summarize one date-omission improvement range
export interface TemperatureAnalogImprovementRange {
  readonly maximum: number | null;
  readonly minimum: number | null;
}

// describe one chronological frozen-prediction partition
export interface TemperatureAnalogChronologicalPartition {
  readonly comparison: TemperatureAnalogValidationComparison;
  readonly endLocalDate: string | null;
  readonly localDateCount: number;
  readonly startLocalDate: string | null;
}

// report expanded aggregate-only retrospective validation
export interface TemperatureAnalogValidationReport {
  readonly bootstrap: readonly TemperatureAnalogBootstrapBlockResult[];
  readonly chronologicalSplit: {
    readonly earlier: TemperatureAnalogChronologicalPartition;
    readonly interpretation: "descriptive_frozen_predictions_not_holdout_validation";
    readonly later: TemperatureAnalogChronologicalPartition;
    readonly splitRule: "first_ceil_half_of_sorted_represented_local_dates";
  };
  readonly contractVersion: typeof TEMPERATURE_ANALOG_VALIDATION_POLICY.contractVersion;
  readonly diagnostics: {
    readonly byDaypart: readonly TemperatureAnalogDaypartDiagnostic[];
    readonly byExactLeadHour: readonly TemperatureAnalogExactLeadDiagnostic[];
    readonly byLocalDate: readonly TemperatureAnalogLocalDateDiagnostic[];
    readonly bySeason: readonly TemperatureAnalogSeasonDiagnostic[];
  };
  readonly first12DateOutcomes: {
    readonly versusPrior: TemperatureAnalogDateOutcome;
    readonly versusRaw: TemperatureAnalogDateOutcome;
  };
  readonly leaveOneLocalDateOut: {
    readonly interpretation: "frozen_prediction_omission_not_cross_validation_or_refitting";
    readonly priorMinusAnalogMeanAbsoluteErrorCRange: TemperatureAnalogImprovementRange;
    readonly rawMinusAnalogMeanAbsoluteErrorCRange: TemperatureAnalogImprovementRange;
    readonly rows: readonly TemperatureAnalogLeaveOneDateOutRow[];
  };
  readonly limitations: {
    readonly arrivalAndRevisionLatency: "not_perturbed_or_reconstructed";
    readonly cohort: "consumed_12_local_date_retrospective_cohort_not_unseen_dates";
    readonly dependence: "predictions_retain_original_training_and_analog_source_state";
    readonly parameterSelection: "none_all_predeclared_diagnostics_reported";
    readonly refit: "none_frozen_predictions_only";
    readonly representedLocalDateCount: number;
    readonly validationKind: "frozen_prediction_rescoring_not_cross_validation_or_an_independent_holdout";
  };
  readonly productionActivationAllowed: false;
  readonly qualification: false;
  readonly scopes: readonly TemperatureAnalogValidationScope[];
}

// cache validated calendar material
interface PreparedValidationRecord extends TemperatureAnalogValidationRecord {
  readonly daypart: LocalDaypart;
  readonly localDate: string;
  readonly season: LocalMeteorologicalSeason;
}

// accumulate three prediction errors for one UTC hour
interface HourAccumulator {
  count: number;
  analogAbsoluteErrorSum: number;
  analogErrorSum: number;
  analogSquaredErrorSum: number;
  analogAbove2Count: number;
  analogAbove3Count: number;
  priorAbsoluteErrorSum: number;
  priorErrorSum: number;
  priorSquaredErrorSum: number;
  priorAbove2Count: number;
  priorAbove3Count: number;
  rawAbsoluteErrorSum: number;
  rawErrorSum: number;
  rawSquaredErrorSum: number;
  rawAbove2Count: number;
  rawAbove3Count: number;
}

// retain per-date balanced loss sums for bootstrap sampling
interface BootstrapDateAggregate {
  readonly analogHourLossSum: number;
  readonly priorHourLossSum: number;
  readonly rawHourLossSum: number;
  readonly uniqueValidHours: number;
}

// retain mutable bootstrap improvement samples
interface BootstrapSamples {
  readonly priorAbsolute: number[];
  readonly priorRelative: number[];
  readonly rawAbsolute: number[];
  readonly rawRelative: number[];
  priorRelativeComplete: boolean;
  rawRelativeComplete: boolean;
}

// require one canonical millisecond UTC instant
function canonicalInstantMilliseconds(value: string, field: string): number {
  const milliseconds = Date.parse(value);

  // reject malformed or normalized timestamps
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return milliseconds;
}

// require one finite scoring number
function requireFinite(value: number, field: string): number {
  // reject non-finite evidence
  if (!Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite`);
  }

  return value;
}

// prepare one prediction record without source inspection
function prepareRecord(record: TemperatureAnalogValidationRecord): PreparedValidationRecord {
  requireFinite(record.actual, "actual");
  requireFinite(record.analogPrediction, "analogPrediction");
  requireFinite(record.priorPrediction, "priorPrediction");
  requireFinite(record.rawForecast, "rawForecast");

  // require a stable nonempty identity
  if (typeof record.key !== "string" || record.key.trim().length === 0) {
    throw new RangeError("key must be nonempty");
  }

  // require a literal eligibility partition
  if (typeof record.baselineEligible !== "boolean") {
    throw new RangeError("baselineEligible must be boolean");
  }

  // require a structural fallback label
  if (record.fallbackReason !== null && typeof record.fallbackReason !== "string") {
    throw new RangeError("fallbackReason must be a string or null");
  }

  // require the complete forecast horizon
  if (
    !Number.isInteger(record.targetLeadHours) ||
    record.targetLeadHours < 1 ||
    record.targetLeadHours > 168
  ) {
    throw new RangeError("targetLeadHours must be an integer between 1 and 168");
  }

  const validAtMilliseconds = canonicalInstantMilliseconds(record.validAt, "validAt");
  const referenceAtMilliseconds = canonicalInstantMilliseconds(
    record.referenceAt,
    "referenceAt",
  );

  // require a positive stated forecast horizon
  if (referenceAtMilliseconds >= validAtMilliseconds) {
    throw new RangeError("referenceAt must precede validAt");
  }

  const elapsedLeadHours = Math.ceil(
    (validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR,
  );

  // bind the lead label to both instants
  if (elapsedLeadHours !== record.targetLeadHours) {
    throw new RangeError("targetLeadHours must match validAt and referenceAt");
  }

  // preserve the accepted later-range prediction exactly
  if (record.targetLeadHours > 12 && record.analogPrediction !== record.priorPrediction) {
    throw new RangeError("analogPrediction must equal priorPrediction after 12 hours");
  }

  const calendar = localCalendarFeaturesFor(record.validAt);

  return {
    ...record,
    daypart: calendar.daypart,
    localDate: calendar.localDate,
    season: calendar.season,
  };
}

// validate shared identities and observed targets
function prepareRecords(
  records: readonly TemperatureAnalogValidationRecord[],
): readonly PreparedValidationRecord[] {
  const actualByValidAt = new Map<string, number>();
  const keys = new Set<string>();
  const prepared: PreparedValidationRecord[] = [];

  // retain and validate every supplied row
  for (const record of records) {
    const candidate = prepareRecord(record);

    // reject duplicate event identities
    if (keys.has(candidate.key)) {
      throw new RangeError("temperature analog validation keys must be unique");
    }

    const sharedActual = actualByValidAt.get(candidate.validAt);

    // reject conflicting labels within one target hour
    if (sharedActual !== undefined && sharedActual !== candidate.actual) {
      throw new RangeError("actual must be identical within each validAt");
    }

    keys.add(candidate.key);
    actualByValidAt.set(candidate.validAt, candidate.actual);
    prepared.push(candidate);
  }

  return prepared;
}

// create one empty hourly accumulator
function createHourAccumulator(): HourAccumulator {
  return {
    analogAbsoluteErrorSum: 0,
    analogAbove2Count: 0,
    analogAbove3Count: 0,
    analogErrorSum: 0,
    analogSquaredErrorSum: 0,
    count: 0,
    priorAbsoluteErrorSum: 0,
    priorAbove2Count: 0,
    priorAbove3Count: 0,
    priorErrorSum: 0,
    priorSquaredErrorSum: 0,
    rawAbsoluteErrorSum: 0,
    rawAbove2Count: 0,
    rawAbove3Count: 0,
    rawErrorSum: 0,
    rawSquaredErrorSum: 0,
  };
}

// add one model error to its hour fields
function addModelError(
  hour: HourAccumulator,
  model: "analog" | "prior" | "raw",
  error: number,
): void {
  const absoluteError = Math.abs(error);
  hour[`${model}AbsoluteErrorSum`] += absoluteError;
  hour[`${model}ErrorSum`] += error;
  hour[`${model}SquaredErrorSum`] += error * error;

  // count strict two-degree misses
  if (absoluteError > 2) {
    hour[`${model}Above2Count`] += 1;
  }

  // count strict three-degree misses
  if (absoluteError > 3) {
    hour[`${model}Above3Count`] += 1;
  }
}

// interpolate one sorted percentile
function percentile(sortedValues: readonly number[], probability: number): number | null {
  // return an explicit empty-cell value
  if (sortedValues.length === 0) {
    return null;
  }

  const rank = probability * (sortedValues.length - 1);
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];

  // guard internal percentile indexes
  if (lower === undefined || upper === undefined) {
    throw new Error("temperature analog percentile index is unavailable");
  }

  return lower + (upper - lower) * (rank - lowerIndex);
}

// score one model with equal UTC-hour primary weighting
function scoreModel(
  hours: ReadonlyMap<string, HourAccumulator>,
  localDateCount: number,
  eventCount: number,
  model: "analog" | "prior" | "raw",
): TemperatureAnalogValidationScore {
  // return explicit null metrics for empty cells
  if (eventCount === 0 || hours.size === 0) {
    return {
      eventCount: 0,
      eventWeightedMeanAbsoluteError: null,
      hourBalancedFractionAbsoluteErrorAbove2C: null,
      hourBalancedFractionAbsoluteErrorAbove3C: null,
      hourBalancedMeanAbsoluteError: null,
      hourBalancedRootMeanSquaredError: null,
      hourBalancedSignedBias: null,
      hourlyMeanAbsoluteErrorPercentiles: {
        maximum: null,
        p50: null,
        p90: null,
        p95: null,
        p99: null,
      },
      localDateCount: 0,
      uniqueValidHours: 0,
    };
  }

  const hourlyMeanAbsoluteErrors: number[] = [];
  let eventAbsoluteErrorSum = 0;
  let hourAbsoluteErrorMeanSum = 0;
  let hourAbove2FractionSum = 0;
  let hourAbove3FractionSum = 0;
  let hourErrorMeanSum = 0;
  let hourSquaredErrorMeanSum = 0;

  // balance each valid hour equally
  for (const hour of hours.values()) {
    const absoluteErrorSum = hour[`${model}AbsoluteErrorSum`];
    const meanAbsoluteError = absoluteErrorSum / hour.count;
    eventAbsoluteErrorSum += absoluteErrorSum;
    hourAbsoluteErrorMeanSum += meanAbsoluteError;
    hourErrorMeanSum += hour[`${model}ErrorSum`] / hour.count;
    hourSquaredErrorMeanSum += hour[`${model}SquaredErrorSum`] / hour.count;
    hourAbove2FractionSum += hour[`${model}Above2Count`] / hour.count;
    hourAbove3FractionSum += hour[`${model}Above3Count`] / hour.count;
    hourlyMeanAbsoluteErrors.push(meanAbsoluteError);
  }

  hourlyMeanAbsoluteErrors.sort((left, right) => left - right);
  const uniqueValidHours = hours.size;

  return {
    eventCount,
    eventWeightedMeanAbsoluteError: eventAbsoluteErrorSum / eventCount,
    hourBalancedFractionAbsoluteErrorAbove2C:
      hourAbove2FractionSum / uniqueValidHours,
    hourBalancedFractionAbsoluteErrorAbove3C:
      hourAbove3FractionSum / uniqueValidHours,
    hourBalancedMeanAbsoluteError: hourAbsoluteErrorMeanSum / uniqueValidHours,
    hourBalancedRootMeanSquaredError: Math.sqrt(
      hourSquaredErrorMeanSum / uniqueValidHours,
    ),
    hourBalancedSignedBias: hourErrorMeanSum / uniqueValidHours,
    hourlyMeanAbsoluteErrorPercentiles: {
      maximum: hourlyMeanAbsoluteErrors.at(-1) ?? null,
      p50: percentile(hourlyMeanAbsoluteErrors, 0.5),
      p90: percentile(hourlyMeanAbsoluteErrors, 0.9),
      p95: percentile(hourlyMeanAbsoluteErrors, 0.95),
      p99: percentile(hourlyMeanAbsoluteErrors, 0.99),
    },
    localDateCount,
    uniqueValidHours,
  };
}

// score all predictions on one exact shared subset
function scoreComparison(
  records: readonly PreparedValidationRecord[],
): TemperatureAnalogValidationComparison {
  const hours = new Map<string, HourAccumulator>();
  const localDates = new Set<string>();

  // retain every event regardless of fallback or eligibility
  for (const record of records) {
    let hour = hours.get(record.validAt);

    // initialize one UTC valid-hour group
    if (hour === undefined) {
      hour = createHourAccumulator();
      hours.set(record.validAt, hour);
    }

    addModelError(hour, "raw", record.rawForecast - record.actual);
    addModelError(hour, "prior", record.priorPrediction - record.actual);
    addModelError(hour, "analog", record.analogPrediction - record.actual);
    hour.count += 1;
    localDates.add(record.localDate);
  }

  return {
    analog: scoreModel(hours, localDates.size, records.length, "analog"),
    prior: scoreModel(hours, localDates.size, records.length, "prior"),
    raw: scoreModel(hours, localDates.size, records.length, "raw"),
  };
}

// compute one absolute MAE improvement
function absoluteImprovement(
  comparison: TemperatureAnalogValidationComparison,
  comparator: "prior" | "raw",
): number | null {
  const comparatorLoss = comparison[comparator].hourBalancedMeanAbsoluteError;
  const analogLoss = comparison.analog.hourBalancedMeanAbsoluteError;

  // keep empty comparisons explicit
  if (comparatorLoss === null || analogLoss === null) {
    return null;
  }

  return comparatorLoss - analogLoss;
}

// create one fixed scope report
function scopeReport(
  records: readonly PreparedValidationRecord[],
  scope: (typeof TEMPERATURE_ANALOG_VALIDATION_POLICY.scopes)[number],
): TemperatureAnalogValidationScope {
  const selected = records.filter(
    // retain the inclusive frozen lead range
    (record) =>
      record.targetLeadHours >= scope.minimumLeadHours &&
      record.targetLeadHours <= scope.maximumLeadHours,
  );

  return {
    comparison: scoreComparison(selected),
    key: scope.key,
    maximumLeadHours: scope.maximumLeadHours,
    minimumLeadHours: scope.minimumLeadHours,
  };
}

// advance one frozen xorshift32 state
function nextXorshift32(state: number): number {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return next >>> 0;
}

// build equal-hour date aggregates for paired resampling
function bootstrapDateAggregates(
  records: readonly PreparedValidationRecord[],
  localDates: readonly string[],
): readonly BootstrapDateAggregate[] {
  return localDates.map(
    // aggregate one represented local date
    (localDate) => {
      const dateRecords = records.filter(
        // isolate one local date
        (record) => record.localDate === localDate,
      );
      const hours = new Map<string, HourAccumulator>();

      // accumulate one date without retaining event output
      for (const record of dateRecords) {
        let hour = hours.get(record.validAt);

        // initialize one date-local valid hour
        if (hour === undefined) {
          hour = createHourAccumulator();
          hours.set(record.validAt, hour);
        }

        addModelError(hour, "raw", record.rawForecast - record.actual);
        addModelError(hour, "prior", record.priorPrediction - record.actual);
        addModelError(hour, "analog", record.analogPrediction - record.actual);
        hour.count += 1;
      }

      let analogHourLossSum = 0;
      let priorHourLossSum = 0;
      let rawHourLossSum = 0;

      // preserve partial-date hour weights
      for (const hour of hours.values()) {
        analogHourLossSum += hour.analogAbsoluteErrorSum / hour.count;
        priorHourLossSum += hour.priorAbsoluteErrorSum / hour.count;
        rawHourLossSum += hour.rawAbsoluteErrorSum / hour.count;
      }

      return {
        analogHourLossSum,
        priorHourLossSum,
        rawHourLossSum,
        uniqueValidHours: hours.size,
      };
    },
  );
}

// form one linear-interpolated confidence interval
function confidenceInterval(samples: readonly number[]): TemperatureAnalogConfidenceInterval {
  const sorted = [...samples].sort((left, right) => left - right);
  const lower = percentile(sorted, 0.025);
  const upper = percentile(sorted, 0.975);

  // guard a required nonempty bootstrap distribution
  if (lower === null || upper === null) {
    throw new Error("temperature analog bootstrap samples are empty");
  }

  return { lower, upper };
}

// compute a defined relative improvement percentage
function relativeImprovementPercent(
  absoluteMeanAbsoluteErrorC: number,
  comparatorMeanAbsoluteErrorC: number,
): number | null {
  // avoid an undefined perfect-comparator ratio
  if (comparatorMeanAbsoluteErrorC === 0) {
    return null;
  }

  return (absoluteMeanAbsoluteErrorC / comparatorMeanAbsoluteErrorC) * 100;
}

// run one frozen paired circular date bootstrap
function bootstrapForBlockLength(
  records: readonly PreparedValidationRecord[],
  localDates: readonly string[],
  blockLength: 1 | 2 | 3,
): TemperatureAnalogBootstrapBlockResult {
  const seed = TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.seedBase + blockLength;
  const pointComparison = scoreComparison(records);
  const rawPoint = absoluteImprovement(pointComparison, "raw");
  const priorPoint = absoluteImprovement(pointComparison, "prior");
  const rawPointRelative = rawPoint === null
    ? null
    : relativeImprovementPercent(
      rawPoint,
      pointComparison.raw.hourBalancedMeanAbsoluteError ?? 0,
    );
  const priorPointRelative = priorPoint === null
    ? null
    : relativeImprovementPercent(
      priorPoint,
      pointComparison.prior.hourBalancedMeanAbsoluteError ?? 0,
    );

  // report null intervals without enough date blocks
  if (localDates.length < 2) {
    return {
      blockLengthLocalDates: blockLength,
      completedReplicateCount: 0,
      configuredReplicateCount:
        TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount,
      priorMinusAnalog: {
        absoluteMeanAbsoluteErrorC: {
          confidenceInterval95: null,
          point: priorPoint,
        },
        relativePercent: {
          confidenceInterval95: null,
          point: priorPointRelative,
        },
      },
      rawMinusAnalog: {
        absoluteMeanAbsoluteErrorC: {
          confidenceInterval95: null,
          point: rawPoint,
        },
        relativePercent: {
          confidenceInterval95: null,
          point: rawPointRelative,
        },
      },
      representedLocalDateCount: localDates.length,
      seed,
    };
  }

  const dates = bootstrapDateAggregates(records, localDates);
  const samples: BootstrapSamples = {
    priorAbsolute: [],
    priorRelative: [],
    priorRelativeComplete: true,
    rawAbsolute: [],
    rawRelative: [],
    rawRelativeComplete: true,
  };
  let randomState = seed >>> 0;

  // produce the frozen number of paired replicates
  for (
    let replicate = 0;
    replicate < TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount;
    replicate += 1
  ) {
    let analogLossSum = 0;
    let priorLossSum = 0;
    let rawLossSum = 0;
    let selectedDateCount = 0;
    let validHourCount = 0;

    // draw circular blocks until exactly N date slots are retained
    while (selectedDateCount < dates.length) {
      randomState = nextXorshift32(randomState);
      const startIndex = Math.floor(
        (randomState / TWO_TO_THE_THIRTY_SECOND_POWER) * dates.length,
      );

      // append one wrapped moving block
      for (
        let offset = 0;
        offset < blockLength && selectedDateCount < dates.length;
        offset += 1
      ) {
        const selected = dates[(startIndex + offset) % dates.length];

        // guard the circular date lookup
        if (selected === undefined) {
          throw new Error("temperature analog bootstrap date is unavailable");
        }

        analogLossSum += selected.analogHourLossSum;
        priorLossSum += selected.priorHourLossSum;
        rawLossSum += selected.rawHourLossSum;
        validHourCount += selected.uniqueValidHours;
        selectedDateCount += 1;
      }
    }

    // guard impossible empty sampled dates
    if (validHourCount === 0) {
      throw new Error("temperature analog bootstrap replicate has no valid hours");
    }

    const analogLoss = analogLossSum / validHourCount;
    const priorLoss = priorLossSum / validHourCount;
    const rawLoss = rawLossSum / validHourCount;
    const priorAbsolute = priorLoss - analogLoss;
    const rawAbsolute = rawLoss - analogLoss;
    const priorRelative = relativeImprovementPercent(priorAbsolute, priorLoss);
    const rawRelative = relativeImprovementPercent(rawAbsolute, rawLoss);
    samples.priorAbsolute.push(priorAbsolute);
    samples.rawAbsolute.push(rawAbsolute);

    // retain a complete prior-relative distribution
    if (priorRelative === null) {
      samples.priorRelativeComplete = false;
    } else {
      samples.priorRelative.push(priorRelative);
    }

    // retain a complete raw-relative distribution
    if (rawRelative === null) {
      samples.rawRelativeComplete = false;
    } else {
      samples.rawRelative.push(rawRelative);
    }
  }

  return {
    blockLengthLocalDates: blockLength,
    completedReplicateCount:
      TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount,
    configuredReplicateCount:
      TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount,
    priorMinusAnalog: {
      absoluteMeanAbsoluteErrorC: {
        confidenceInterval95: confidenceInterval(samples.priorAbsolute),
        point: priorPoint,
      },
      relativePercent: {
        confidenceInterval95: samples.priorRelativeComplete
          ? confidenceInterval(samples.priorRelative)
          : null,
        point: priorPointRelative,
      },
    },
    rawMinusAnalog: {
      absoluteMeanAbsoluteErrorC: {
        confidenceInterval95: confidenceInterval(samples.rawAbsolute),
        point: rawPoint,
      },
      relativePercent: {
        confidenceInterval95: samples.rawRelativeComplete
          ? confidenceInterval(samples.rawRelative)
          : null,
        point: rawPointRelative,
      },
    },
    representedLocalDateCount: localDates.length,
    seed,
  };
}

// classify per-date analog outcomes against one comparator
function dateOutcome(
  diagnostics: readonly TemperatureAnalogLocalDateDiagnostic[],
  comparator: "prior" | "raw",
): TemperatureAnalogDateOutcome {
  let tieCount = 0;
  let winCount = 0;
  let worseCount = 0;

  // classify every represented date without exclusion
  for (const diagnostic of diagnostics) {
    const improvement = comparator === "raw"
      ? diagnostic.rawMinusAnalogMeanAbsoluteErrorC
      : diagnostic.priorMinusAnalogMeanAbsoluteErrorC;

    // guard impossible empty represented dates
    if (improvement === null) {
      throw new Error("temperature analog represented date has no score");
    }

    // count exact ties
    if (improvement === 0) {
      tieCount += 1;
    } else if (improvement > 0) {
      // count analog wins
      winCount += 1;
    } else {
      // count analog losses
      worseCount += 1;
    }
  }

  return { tieCount, winCount, worseCount };
}

// summarize finite omission improvements
function improvementRange(
  values: readonly (number | null)[],
): TemperatureAnalogImprovementRange {
  const finite = values.filter(
    // remove only explicit empty scores
    (value): value is number => value !== null,
  );

  // preserve an explicit empty range
  if (finite.length === 0) {
    return { maximum: null, minimum: null };
  }

  return {
    maximum: Math.max(...finite),
    minimum: Math.min(...finite),
  };
}

// score one chronological date partition
function chronologicalPartition(
  records: readonly PreparedValidationRecord[],
  localDates: readonly string[],
): TemperatureAnalogChronologicalPartition {
  const dateSet = new Set(localDates);
  const selected = records.filter(
    // retain exactly the partition dates
    (record) => dateSet.has(record.localDate),
  );

  return {
    comparison: scoreComparison(selected),
    endLocalDate: localDates.at(-1) ?? null,
    localDateCount: localDates.length,
    startLocalDate: localDates[0] ?? null,
  };
}

// score one validated subset without bootstrap work
export function scoreTemperatureAnalogValidationRecords(
  records: readonly TemperatureAnalogValidationRecord[],
): TemperatureAnalogValidationComparison {
  return scoreComparison(prepareRecords(records));
}

// analyze frozen analog predictions without refitting or source access
export function analyzeTemperatureAnalogValidation(
  records: readonly TemperatureAnalogValidationRecord[],
): TemperatureAnalogValidationReport {
  const prepared = prepareRecords(records);
  const first12 = prepared.filter(
    // isolate the primary short-range cohort
    (record) => record.targetLeadHours <= 12,
  );
  const localDates = [...new Set(first12.map(
    // project represented local dates
    (record) => record.localDate,
  ))].sort();
  const byLocalDate = localDates.map(
    // score each date independently
    (localDate): TemperatureAnalogLocalDateDiagnostic => {
      const comparison = scoreComparison(first12.filter(
        // isolate one represented date
        (record) => record.localDate === localDate,
      ));

      return {
        comparison,
        localDate,
        priorMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(
          comparison,
          "prior",
        ),
        rawMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(comparison, "raw"),
      };
    },
  );
  const leaveOneRows = localDates.map(
    // omit one date from frozen predictions only
    (omittedLocalDate): TemperatureAnalogLeaveOneDateOutRow => {
      const comparison = scoreComparison(first12.filter(
        // retain every other represented date
        (record) => record.localDate !== omittedLocalDate,
      ));

      return {
        comparison,
        omittedLocalDate,
        priorMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(
          comparison,
          "prior",
        ),
        rawMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(comparison, "raw"),
      };
    },
  );
  const splitIndex = Math.ceil(localDates.length / 2);

  return {
    bootstrap: TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.blockLengths.map(
      // reset the generator independently for each length
      (blockLength) => bootstrapForBlockLength(first12, localDates, blockLength),
    ),
    chronologicalSplit: {
      earlier: chronologicalPartition(first12, localDates.slice(0, splitIndex)),
      interpretation: "descriptive_frozen_predictions_not_holdout_validation",
      later: chronologicalPartition(first12, localDates.slice(splitIndex)),
      splitRule: "first_ceil_half_of_sorted_represented_local_dates",
    },
    contractVersion: TEMPERATURE_ANALOG_VALIDATION_POLICY.contractVersion,
    diagnostics: {
      byDaypart:
        TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.dayparts.map(
          // score one fixed daypart
          (daypart) => ({
            comparison: scoreComparison(first12.filter(
              // retain one daypart
              (record) => record.daypart === daypart,
            )),
            daypart,
          }),
        ),
      byExactLeadHour:
        TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.exactLeadHours.map(
          // score one exact lead
          (targetLeadHours) => ({
            comparison: scoreComparison(first12.filter(
              // retain one exact lead
              (record) => record.targetLeadHours === targetLeadHours,
            )),
            targetLeadHours,
          }),
        ),
      byLocalDate,
      bySeason:
        TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.seasons.map(
          // score one fixed season
          (season) => ({
            comparison: scoreComparison(first12.filter(
              // retain one season
              (record) => record.season === season,
            )),
            season,
          }),
        ),
    },
    first12DateOutcomes: {
      versusPrior: dateOutcome(byLocalDate, "prior"),
      versusRaw: dateOutcome(byLocalDate, "raw"),
    },
    leaveOneLocalDateOut: {
      interpretation: "frozen_prediction_omission_not_cross_validation_or_refitting",
      priorMinusAnalogMeanAbsoluteErrorCRange: improvementRange(leaveOneRows.map(
        // project prior omission improvements
        (row) => row.priorMinusAnalogMeanAbsoluteErrorC,
      )),
      rawMinusAnalogMeanAbsoluteErrorCRange: improvementRange(leaveOneRows.map(
        // project raw omission improvements
        (row) => row.rawMinusAnalogMeanAbsoluteErrorC,
      )),
      rows: leaveOneRows,
    },
    limitations: {
      arrivalAndRevisionLatency: "not_perturbed_or_reconstructed",
      cohort: "consumed_12_local_date_retrospective_cohort_not_unseen_dates",
      dependence: "predictions_retain_original_training_and_analog_source_state",
      parameterSelection: "none_all_predeclared_diagnostics_reported",
      refit: "none_frozen_predictions_only",
      representedLocalDateCount: localDates.length,
      validationKind: "frozen_prediction_rescoring_not_cross_validation_or_an_independent_holdout",
    },
    productionActivationAllowed: false,
    qualification: false,
    scopes: TEMPERATURE_ANALOG_VALIDATION_POLICY.scopes.map(
      // score every scope without selection
      (scope) => scopeReport(prepared, scope),
    ),
  };
}
