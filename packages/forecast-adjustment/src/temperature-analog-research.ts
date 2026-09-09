import { localCalendarFeaturesFor } from "./calendar.js";

// freeze the weather-conditioned analog policy
export const TEMPERATURE_ANALOG_RESEARCH_POLICY = Object.freeze({
  assumedObservationAvailabilityLagHours: 1,
  cumulativeCorrectionMaximumC: 5,
  cumulativeCorrectionMinimumC: -5,
  distanceScales: Object.freeze({
    leadHours: 6,
    localHour: 3,
    relativeHumidityPercentagePoints: 20,
    temperatureC: 5,
    windSpeedMps: 3,
  }),
  lookbackElapsedHours: 336,
  maximumCircularLocalHourDifference: 2,
  maximumSquaredDistance: 4,
  maximumTargetLeadHours: 12,
  physicalMaximumC: 70,
  physicalMinimumC: -100,
  requiredUniqueSourceHours: 12,
  sourceLeadBands: Object.freeze([
    Object.freeze([1, 6] as const),
    Object.freeze([7, 12] as const),
  ]),
} as const);

const MILLISECONDS_PER_HOUR = 3_600_000;

// describe one immutable analog input event
export interface TemperatureAnalogResearchEvent {
  readonly actual: number;
  readonly baselineEligible: boolean;
  readonly key: string;
  readonly priorPrediction: number;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// enumerate every exact-prior fallback reason
export type TemperatureAnalogFallbackReason =
  | "baseline_ineligible"
  | "fewer_than_12_analogs"
  | "missing_target_weather"
  | "outside_first12";

// retain the five signed matching differences
export interface TemperatureAnalogFeatureDifferences {
  readonly leadHours: number;
  readonly localHour: number;
  readonly relativeHumidityPercentagePoints: number;
  readonly temperatureC: number;
  readonly windSpeedMps: number;
}

// retain one ranked source for independent replay
export interface TemperatureAnalogSourceAuditRecord {
  readonly actual: number;
  readonly ageHoursAtReference: number;
  readonly availableAt: string;
  readonly baselineEligible: boolean;
  readonly distance: number;
  readonly featureDifferences: TemperatureAnalogFeatureDifferences;
  readonly key: string;
  readonly localHour: number;
  readonly priorPrediction: number;
  readonly rank: number;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number;
  readonly rawWindSpeedMps: number;
  readonly referenceAt: string;
  readonly residual: number;
  readonly scaledSquaredDifferences: TemperatureAnalogFeatureDifferences;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// retain one complete prediction audit record
export interface TemperatureAnalogPredictionAuditRecord {
  readonly actual: number;
  readonly analogPrediction: number;
  readonly availableAnalogHourCount: number;
  readonly baselineEligible: boolean;
  readonly candidateHourCount: number;
  readonly fallbackReason: TemperatureAnalogFallbackReason | null;
  readonly key: string;
  readonly localHour: number;
  readonly medianResidual: number | null;
  readonly preCapTotalCorrection: number | null;
  readonly priorPrediction: number;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string;
  readonly selectedSources: readonly TemperatureAnalogSourceAuditRecord[];
  readonly targetLeadHours: number;
  readonly totalCorrection: number | null;
  readonly validAt: string;
}

// cache validated time and calendar material
interface PreparedEvent {
  readonly event: TemperatureAnalogResearchEvent;
  readonly localHour: number;
  readonly referenceAtMilliseconds: number;
  readonly validAtMilliseconds: number;
}

// retain one fully measured source candidate
interface MeasuredCandidate {
  readonly distance: number;
  readonly leadHoursDifference: number;
  readonly leadHoursSquaredTerm: number;
  readonly localHourDifference: number;
  readonly localHourSquaredTerm: number;
  readonly relativeHumidityDifferencePercentagePoints: number;
  readonly relativeHumiditySquaredTerm: number;
  readonly source: PreparedEvent;
  readonly temperatureDifferenceC: number;
  readonly temperatureSquaredTerm: number;
  readonly windSpeedDifferenceMps: number;
  readonly windSpeedSquaredTerm: number;
}

// parse one canonical UTC instant
function instantMilliseconds(value: string, field: string): number {
  const milliseconds = Date.parse(value);

  // require canonical millisecond UTC timestamps
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return milliseconds;
}

// constrain one number inclusively
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

// compare canonical string identities
function compareStrings(left: string, right: string): number {
  // preserve exact code-unit ordering
  if (left < right) {
    return -1;
  }

  // preserve exact code-unit ordering
  if (left > right) {
    return 1;
  }

  return 0;
}

// classify one supported short-range lead
function leadBandFor(targetLeadHours: number): 0 | 1 {
  return targetLeadHours <= 6 ? 0 : 1;
}

// measure one circular wall-clock separation
function circularHourDifference(left: number, right: number): number {
  const directDifference = Math.abs(left - right);
  return Math.min(directDifference, 24 - directDifference);
}

// require one nullable finite weather predictor
function validateWeatherPredictor(value: number | null, field: string): void {
  // accept unavailable weather explicitly
  if (value === null) {
    return;
  }

  // reject invalid available weather
  if (!Number.isFinite(value)) {
    throw new RangeError(`${field} must be finite or null`);
  }
}

// prepare and validate one event once
function prepareEvent(event: TemperatureAnalogResearchEvent): PreparedEvent {
  // require finite core model material
  if (
    !Number.isFinite(event.actual) ||
    !Number.isFinite(event.priorPrediction) ||
    !Number.isFinite(event.rawForecast) ||
    !Number.isFinite(event.targetLeadHours)
  ) {
    throw new RangeError("temperature analog event numbers must be finite");
  }

  // require a literal eligibility partition
  if (typeof event.baselineEligible !== "boolean") {
    throw new RangeError("temperature analog baselineEligible must be boolean");
  }

  // require a stable nonempty identity
  if (typeof event.key !== "string" || event.key.trim().length === 0) {
    throw new RangeError("temperature analog event key must be nonempty");
  }

  // require supported integral leads
  if (
    !Number.isInteger(event.targetLeadHours) ||
    event.targetLeadHours < 1 ||
    event.targetLeadHours > 168
  ) {
    throw new RangeError("temperature analog targetLeadHours must be between 1 and 168");
  }

  validateWeatherPredictor(
    event.rawRelativeHumidityPercent,
    "rawRelativeHumidityPercent",
  );
  validateWeatherPredictor(event.rawWindSpeedMps, "rawWindSpeedMps");
  const referenceAtMilliseconds = instantMilliseconds(
    event.referenceAt,
    "referenceAt",
  );
  const validAtMilliseconds = instantMilliseconds(event.validAt, "validAt");

  // require one positive forecast horizon
  if (referenceAtMilliseconds >= validAtMilliseconds) {
    throw new RangeError("temperature analog referenceAt must precede validAt");
  }

  const elapsedLeadHours = Math.ceil(
    (validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR,
  );

  // bind the stated lead to its timestamps
  if (elapsedLeadHours !== event.targetLeadHours) {
    throw new RangeError("temperature analog targetLeadHours must match its timestamps");
  }

  return {
    event,
    localHour: localCalendarFeaturesFor(event.validAt).hour,
    referenceAtMilliseconds,
    validAtMilliseconds,
  };
}

// validate identities and shared observed labels
function prepareEvents(
  events: readonly TemperatureAnalogResearchEvent[],
): readonly PreparedEvent[] {
  const identities = new Set<string>();
  const actualByValidAt = new Map<string, number>();
  const prepared: PreparedEvent[] = [];

  // validate each event exactly once
  for (const event of events) {
    const candidate = prepareEvent(event);

    // reject duplicate prediction identities
    if (identities.has(event.key)) {
      throw new RangeError("temperature analog event keys must be unique");
    }

    identities.add(event.key);
    const previousActual = actualByValidAt.get(event.validAt);

    // reject conflicting measurements for one valid hour
    if (previousActual !== undefined && previousActual !== event.actual) {
      throw new Error("temperature analog source validAt has conflicting actual values");
    }

    actualByValidAt.set(event.validAt, event.actual);
    prepared.push(candidate);
  }

  return prepared;
}

// prefer one source vintage before measuring distance
function preferredSource(
  left: PreparedEvent,
  right: PreparedEvent,
  targetLeadHours: number,
): PreparedEvent {
  const leftLeadDifference = Math.abs(
    left.event.targetLeadHours - targetLeadHours,
  );
  const rightLeadDifference = Math.abs(
    right.event.targetLeadHours - targetLeadHours,
  );

  // prefer the closest source horizon
  if (leftLeadDifference !== rightLeadDifference) {
    return leftLeadDifference < rightLeadDifference ? left : right;
  }

  // prefer the latest eligible source vintage
  if (left.referenceAtMilliseconds !== right.referenceAtMilliseconds) {
    return left.referenceAtMilliseconds > right.referenceAtMilliseconds ? left : right;
  }

  return compareStrings(left.event.key, right.event.key) > 0 ? left : right;
}

// compute one auditable squared analog distance
function measureCandidate(
  source: PreparedEvent,
  target: PreparedEvent,
): MeasuredCandidate {
  const sourceHumidity = source.event.rawRelativeHumidityPercent;
  const sourceWind = source.event.rawWindSpeedMps;
  const targetHumidity = target.event.rawRelativeHumidityPercent;
  const targetWind = target.event.rawWindSpeedMps;

  // guard the weather-complete selection boundary
  if (
    sourceHumidity === null ||
    sourceWind === null ||
    targetHumidity === null ||
    targetWind === null
  ) {
    throw new Error("temperature analog candidate weather is missing");
  }

  const temperatureDifferenceC = source.event.rawForecast - target.event.rawForecast;
  const relativeHumidityDifferencePercentagePoints = sourceHumidity - targetHumidity;
  const windSpeedDifferenceMps = sourceWind - targetWind;
  const localHourDifference = circularHourDifference(
    source.localHour,
    target.localHour,
  );
  const leadHoursDifference = source.event.targetLeadHours -
    target.event.targetLeadHours;
  const temperatureSquaredTerm = (
    temperatureDifferenceC /
    TEMPERATURE_ANALOG_RESEARCH_POLICY.distanceScales.temperatureC
  ) ** 2;
  const relativeHumiditySquaredTerm = (
    relativeHumidityDifferencePercentagePoints /
    TEMPERATURE_ANALOG_RESEARCH_POLICY.distanceScales
      .relativeHumidityPercentagePoints
  ) ** 2;
  const windSpeedSquaredTerm = (
    windSpeedDifferenceMps /
    TEMPERATURE_ANALOG_RESEARCH_POLICY.distanceScales.windSpeedMps
  ) ** 2;
  const localHourSquaredTerm = (
    localHourDifference /
    TEMPERATURE_ANALOG_RESEARCH_POLICY.distanceScales.localHour
  ) ** 2;
  const leadHoursSquaredTerm = (
    leadHoursDifference /
    TEMPERATURE_ANALOG_RESEARCH_POLICY.distanceScales.leadHours
  ) ** 2;

  return {
    distance: temperatureSquaredTerm + relativeHumiditySquaredTerm +
      windSpeedSquaredTerm + localHourSquaredTerm + leadHoursSquaredTerm,
    leadHoursDifference,
    leadHoursSquaredTerm,
    localHourDifference,
    localHourSquaredTerm,
    relativeHumidityDifferencePercentagePoints,
    relativeHumiditySquaredTerm,
    source,
    temperatureDifferenceC,
    temperatureSquaredTerm,
    windSpeedDifferenceMps,
    windSpeedSquaredTerm,
  };
}

// choose distinct causally available analog hours
function selectAnalogCandidates(
  sources: readonly PreparedEvent[],
  target: PreparedEvent,
): {
  readonly availableAnalogHourCount: number;
  readonly candidateHourCount: number;
  readonly selected: readonly MeasuredCandidate[];
} {
  const targetHumidity = target.event.rawRelativeHumidityPercent;
  const targetWind = target.event.rawWindSpeedMps;

  // guard the weather-complete target boundary
  if (targetHumidity === null || targetWind === null) {
    return { availableAnalogHourCount: 0, candidateHourCount: 0, selected: [] };
  }

  const earliestValidMilliseconds = target.referenceAtMilliseconds -
    TEMPERATURE_ANALOG_RESEARCH_POLICY.lookbackElapsedHours *
      MILLISECONDS_PER_HOUR;
  const targetLeadBand = leadBandFor(target.event.targetLeadHours);
  const sourceByValidAt = new Map<string, PreparedEvent>();

  // filter and deduplicate all causal source vintages
  for (const source of sources) {
    const sourceHumidity = source.event.rawRelativeHumidityPercent;
    const sourceWind = source.event.rawWindSpeedMps;

    // require source weather predictors
    if (sourceHumidity === null || sourceWind === null) {
      continue;
    }

    // enforce strict issue-time precedence
    if (source.referenceAtMilliseconds >= target.referenceAtMilliseconds) {
      continue;
    }

    // enforce assumed observation maturity
    if (
      source.validAtMilliseconds +
        TEMPERATURE_ANALOG_RESEARCH_POLICY.assumedObservationAvailabilityLagHours *
          MILLISECONDS_PER_HOUR >
      target.referenceAtMilliseconds
    ) {
      continue;
    }

    // retain the inclusive elapsed-time lookback
    if (
      source.validAtMilliseconds < earliestValidMilliseconds ||
      source.validAtMilliseconds > target.referenceAtMilliseconds
    ) {
      continue;
    }

    // require the frozen short-range lead partition
    if (leadBandFor(source.event.targetLeadHours) !== targetLeadBand) {
      continue;
    }

    // retain only nearby local clock phases
    if (
      circularHourDifference(source.localHour, target.localHour) >
      TEMPERATURE_ANALOG_RESEARCH_POLICY.maximumCircularLocalHourDifference
    ) {
      continue;
    }

    const current = sourceByValidAt.get(source.event.validAt);
    sourceByValidAt.set(
      source.event.validAt,
      current === undefined
        ? source
        : preferredSource(current, source, target.event.targetLeadHours),
    );
  }

  const measured = [...sourceByValidAt.values()].map(
    // measure only the chosen vintage for each valid hour
    (source) => measureCandidate(source, target),
  );
  const available = measured.filter(
    // enforce the inclusive analog radius
    (candidate) => candidate.distance <=
      TEMPERATURE_ANALOG_RESEARCH_POLICY.maximumSquaredDistance,
  );
  available.sort(
    // rank by distance then recency then greatest key
    (left, right) => {
      const distanceOrder = left.distance - right.distance;

      // prefer the closest analog
      if (distanceOrder !== 0) {
        return distanceOrder;
      }

      // prefer the latest valid hour
      if (left.source.validAtMilliseconds !== right.source.validAtMilliseconds) {
        return right.source.validAtMilliseconds - left.source.validAtMilliseconds;
      }

      return -compareStrings(left.source.event.key, right.source.event.key);
    },
  );

  return {
    availableAnalogHourCount: available.length,
    candidateHourCount: measured.length,
    selected: available.slice(
      0,
      TEMPERATURE_ANALOG_RESEARCH_POLICY.requiredUniqueSourceHours,
    ),
  };
}

// calculate the fixed even-sized residual median
function medianResidualFor(sources: readonly MeasuredCandidate[]): number {
  // guard the exact frozen support
  if (sources.length !== TEMPERATURE_ANALOG_RESEARCH_POLICY.requiredUniqueSourceHours) {
    throw new RangeError("temperature analog median requires exactly twelve sources");
  }

  const residuals = sources.map(
    // calculate residuals against the frozen prior model
    (source) => source.source.event.actual - source.source.event.priorPrediction,
  ).sort(
    // retain numeric residual ordering
    (left, right) => left - right,
  );
  const lower = residuals[5];
  const upper = residuals[6];

  // guard the fixed even median indexes
  if (lower === undefined || upper === undefined) {
    throw new Error("temperature analog median residual is missing");
  }

  return (lower + upper) / 2;
}

// freeze one selected source audit record
function sourceAuditRecord(
  candidate: MeasuredCandidate,
  targetReferenceMilliseconds: number,
  rank: number,
): TemperatureAnalogSourceAuditRecord {
  const source = candidate.source.event;

  return Object.freeze({
    actual: source.actual,
    ageHoursAtReference:
      (targetReferenceMilliseconds - candidate.source.validAtMilliseconds) /
      MILLISECONDS_PER_HOUR,
    availableAt: new Date(
      candidate.source.validAtMilliseconds +
      TEMPERATURE_ANALOG_RESEARCH_POLICY.assumedObservationAvailabilityLagHours *
        MILLISECONDS_PER_HOUR,
    ).toISOString(),
    baselineEligible: source.baselineEligible,
    distance: candidate.distance,
    featureDifferences: Object.freeze({
      leadHours: candidate.leadHoursDifference,
      localHour: candidate.localHourDifference,
      relativeHumidityPercentagePoints:
        candidate.relativeHumidityDifferencePercentagePoints,
      temperatureC: candidate.temperatureDifferenceC,
      windSpeedMps: candidate.windSpeedDifferenceMps,
    }),
    key: source.key,
    localHour: candidate.source.localHour,
    priorPrediction: source.priorPrediction,
    rank,
    rawForecast: source.rawForecast,
    rawRelativeHumidityPercent: source.rawRelativeHumidityPercent as number,
    rawWindSpeedMps: source.rawWindSpeedMps as number,
    referenceAt: source.referenceAt,
    residual: source.actual - source.priorPrediction,
    scaledSquaredDifferences: Object.freeze({
      leadHours: candidate.leadHoursSquaredTerm,
      localHour: candidate.localHourSquaredTerm,
      relativeHumidityPercentagePoints: candidate.relativeHumiditySquaredTerm,
      temperatureC: candidate.temperatureSquaredTerm,
      windSpeedMps: candidate.windSpeedSquaredTerm,
    }),
    targetLeadHours: source.targetLeadHours,
    validAt: source.validAt,
  });
}

// build one deterministic analog prediction record
function predictEvent(
  sources: readonly PreparedEvent[],
  target: PreparedEvent,
): TemperatureAnalogPredictionAuditRecord {
  let fallbackReason: TemperatureAnalogFallbackReason | null = null;
  let candidateHourCount = 0;
  let availableAnalogHourCount = 0;
  let selected: readonly MeasuredCandidate[] = [];
  let medianResidual: number | null = null;
  let preCapTotalCorrection: number | null = null;
  let totalCorrection: number | null = null;
  let analogPrediction = target.event.priorPrediction;

  // preserve the prior model after twelve hours
  if (
    target.event.targetLeadHours >
    TEMPERATURE_ANALOG_RESEARCH_POLICY.maximumTargetLeadHours
  ) {
    fallbackReason = "outside_first12";
  } else if (!target.event.baselineEligible) {
    // preserve ineligible targets exactly
    fallbackReason = "baseline_ineligible";
  } else if (
    target.event.rawRelativeHumidityPercent === null ||
    target.event.rawWindSpeedMps === null
  ) {
    // preserve targets without complete weather
    fallbackReason = "missing_target_weather";
  } else {
    const selection = selectAnalogCandidates(sources, target);
    candidateHourCount = selection.candidateHourCount;
    availableAnalogHourCount = selection.availableAnalogHourCount;
    selected = selection.selected;

    // require the exact frozen analog support
    if (
      selected.length <
      TEMPERATURE_ANALOG_RESEARCH_POLICY.requiredUniqueSourceHours
    ) {
      fallbackReason = "fewer_than_12_analogs";
    } else {
      medianResidual = medianResidualFor(selected);
      preCapTotalCorrection = target.event.priorPrediction -
        target.event.rawForecast + medianResidual;
      totalCorrection = clamp(
        preCapTotalCorrection,
        TEMPERATURE_ANALOG_RESEARCH_POLICY.cumulativeCorrectionMinimumC,
        TEMPERATURE_ANALOG_RESEARCH_POLICY.cumulativeCorrectionMaximumC,
      );
      analogPrediction = clamp(
        target.event.rawForecast + totalCorrection,
        TEMPERATURE_ANALOG_RESEARCH_POLICY.physicalMinimumC,
        TEMPERATURE_ANALOG_RESEARCH_POLICY.physicalMaximumC,
      );
    }
  }

  const selectedSources = Object.freeze(selected.map(
    // retain complete ranked source evidence
    (candidate, index) => sourceAuditRecord(
      candidate,
      target.referenceAtMilliseconds,
      index + 1,
    ),
  ));

  return Object.freeze({
    actual: target.event.actual,
    analogPrediction,
    availableAnalogHourCount,
    baselineEligible: target.event.baselineEligible,
    candidateHourCount,
    fallbackReason,
    key: target.event.key,
    localHour: target.localHour,
    medianResidual,
    preCapTotalCorrection,
    priorPrediction: target.event.priorPrediction,
    rawForecast: target.event.rawForecast,
    rawRelativeHumidityPercent: target.event.rawRelativeHumidityPercent,
    rawWindSpeedMps: target.event.rawWindSpeedMps,
    referenceAt: target.event.referenceAt,
    selectedSources,
    targetLeadHours: target.event.targetLeadHours,
    totalCorrection,
    validAt: target.event.validAt,
  });
}

// create one deeply immutable canonical prediction audit
export function createTemperatureAnalogPredictionAudit(
  events: readonly TemperatureAnalogResearchEvent[],
): readonly TemperatureAnalogPredictionAuditRecord[] {
  // require an actual array boundary
  if (!Array.isArray(events)) {
    throw new RangeError("temperature analog events must be an array");
  }

  const ordered = [...prepareEvents(events)].sort(
    // remove input arrival-order dependence
    (left, right) => compareStrings(left.event.key, right.event.key),
  );
  const sourceCandidates = ordered.filter(
    // retain only frozen short-range source horizons
    (event) => event.event.targetLeadHours <=
      TEMPERATURE_ANALOG_RESEARCH_POLICY.maximumTargetLeadHours,
  );
  const records = ordered.map(
    // predict every original denominator row
    (target) => predictEvent(sourceCandidates, target),
  );

  return Object.freeze(records);
}
