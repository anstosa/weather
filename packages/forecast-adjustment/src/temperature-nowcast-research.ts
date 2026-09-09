// freeze the recent-error persistence parameters
export const TEMPERATURE_NOWCAST_LOOKBACK_HOURS = 6 as const;
export const TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS = 6 as const;
export const TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS = 12 as const;
export const TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS = 3 as const;
export const TEMPERATURE_NOWCAST_HALF_LIFE_HOURS = 6 as const;
export const TEMPERATURE_NOWCAST_OBSERVATION_LAG_HOURS = 1 as const;
export const TEMPERATURE_NOWCAST_MINIMUM_CORRECTION_C = -5 as const;
export const TEMPERATURE_NOWCAST_MAXIMUM_CORRECTION_C = 5 as const;
export const TEMPERATURE_NOWCAST_PHYSICAL_MINIMUM_C = -100 as const;
export const TEMPERATURE_NOWCAST_PHYSICAL_MAXIMUM_C = 70 as const;

const MILLISECONDS_PER_HOUR = 3_600_000;

// describe one canonical live event for the pure nowcast model
export interface TemperatureNowcastResearchEvent {
  readonly actual: number;
  readonly baselineEligible: boolean;
  readonly daypart: string;
  readonly humidityBin: string;
  readonly key: string;
  readonly leadBand: string;
  readonly localDate: string;
  readonly priorPrediction: number;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string;
  readonly season: string;
  readonly sixHourBucket: string;
  readonly targetLeadHours: number;
  readonly temperatureBin: number;
  readonly validAt: string;
  readonly windSpeedBin: string;
}

// enumerate every complete fallback reason
export type TemperatureNowcastFallbackReason =
  | "baseline_ineligible"
  | "insufficient_unique_source_hours"
  | "outside_first_12_hours";

// retain one selected source for private verification
export interface TemperatureNowcastPrivateSourceRecord {
  readonly actual: number;
  readonly ageHoursAtReference: number;
  readonly availableAt: string;
  readonly error: number;
  readonly key: string;
  readonly rawForecast: number;
  readonly referenceAt: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// retain one complete private prediction audit record
export interface TemperatureNowcastPrivateAuditRecord {
  readonly actual: number;
  readonly baselineEligible: boolean;
  readonly daypart: string;
  readonly decay: number | null;
  readonly fallbackReason: TemperatureNowcastFallbackReason | null;
  readonly humidityBin: string;
  readonly key: string;
  readonly latestSourceAgeToTargetHours: number | null;
  readonly leadBand: string;
  readonly localDate: string;
  readonly medianBias: number | null;
  readonly nearNowcastPrediction: number;
  readonly nowcastCorrection: number | null;
  readonly priorBoostedHybridPrediction: number;
  readonly rawForecast: number;
  readonly rawRelativeHumidityPercent: number | null;
  readonly rawWindSpeedMps: number | null;
  readonly referenceAt: string;
  readonly season: string;
  readonly selectedSources: readonly TemperatureNowcastPrivateSourceRecord[];
  readonly sixHourBucket: string;
  readonly targetLeadHours: number;
  readonly temperatureBin: number;
  readonly validAt: string;
  readonly windSpeedBin: string;
}

// expose deterministic predictions and private evidence
export interface TemperatureNowcastPredictionAudit {
  readonly records: readonly TemperatureNowcastPrivateAuditRecord[];
  readonly predictionByKey: ReadonlyMap<string, number>;
}

// parse one canonical event instant
function instantMilliseconds(value: string, field: string): number {
  const milliseconds = Date.parse(value);

  // require canonical UTC timestamps
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return milliseconds;
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

// constrain one number inclusively
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

// choose the middle of exactly three values
function medianOfThree(values: readonly number[]): number {
  // guard the frozen support contract
  if (values.length !== TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS) {
    throw new RangeError("temperature nowcast median requires exactly three values");
  }

  const ordered = [...values].sort(
    // retain numeric ordering
    (left, right) => left - right,
  );
  const median = ordered[1];

  // guard the fixed three-value median
  if (median === undefined) {
    throw new Error("temperature nowcast median is missing");
  }

  return median;
}

// validate one pure event before selection
function validateEvent(event: TemperatureNowcastResearchEvent): void {
  const numerics = [
    event.actual,
    event.priorPrediction,
    event.rawForecast,
    event.targetLeadHours,
    event.temperatureBin,
  ];

  // require finite numeric model material
  if (numerics.some(
    // reject one invalid number
    (value) => !Number.isFinite(value),
  )) {
    throw new RangeError("temperature nowcast event numbers must be finite");
  }

  // require a literal eligibility partition
  if (typeof event.baselineEligible !== "boolean") {
    throw new RangeError("temperature nowcast baselineEligible must be boolean");
  }

  // require supported integral leads
  if (
    !Number.isInteger(event.targetLeadHours) ||
    event.targetLeadHours < 1 ||
    event.targetLeadHours > 168
  ) {
    throw new RangeError("temperature nowcast targetLeadHours must be between 1 and 168");
  }

  const referenceAtMilliseconds = instantMilliseconds(
    event.referenceAt,
    "referenceAt",
  );
  const validAtMilliseconds = instantMilliseconds(event.validAt, "validAt");
  const elapsedLeadHours =
    (validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR;

  // bind the lead label to the event instants
  if (elapsedLeadHours <= 0 || Math.ceil(elapsedLeadHours) !== event.targetLeadHours) {
    throw new RangeError("temperature nowcast targetLeadHours must match validAt and referenceAt");
  }
}

// reject duplicate identities and conflicting observed values
function validateEvents(events: readonly TemperatureNowcastResearchEvent[]): void {
  const identities = new Set<string>();
  const actualByValidAt = new Map<string, number>();

  // validate each canonical event once
  for (const event of events) {
    validateEvent(event);

    // reject duplicate prediction identities
    if (identities.has(event.key)) {
      throw new RangeError("temperature nowcast event keys must be unique");
    }

    identities.add(event.key);

    const previousActual = actualByValidAt.get(event.validAt);

    // reject inconsistent observations for one source hour
    if (previousActual !== undefined && previousActual !== event.actual) {
      throw new Error("temperature nowcast source validAt has conflicting actual values");
    }

    actualByValidAt.set(event.validAt, event.actual);
  }
}

// prefer the latest vintage and deterministic greatest-key tie
function preferredSource(
  left: TemperatureNowcastResearchEvent,
  right: TemperatureNowcastResearchEvent,
): TemperatureNowcastResearchEvent {
  const referenceOrder = compareStrings(left.referenceAt, right.referenceAt);

  // retain the later source reference
  if (referenceOrder !== 0) {
    return referenceOrder > 0 ? left : right;
  }

  return compareStrings(left.key, right.key) > 0 ? left : right;
}

// select the latest three causally available source hours
function selectSources(
  events: readonly TemperatureNowcastResearchEvent[],
  target: TemperatureNowcastResearchEvent,
): readonly TemperatureNowcastResearchEvent[] {
  const targetReferenceMilliseconds = instantMilliseconds(
    target.referenceAt,
    "target.referenceAt",
  );
  const earliestValidMilliseconds = targetReferenceMilliseconds -
    TEMPERATURE_NOWCAST_LOOKBACK_HOURS * MILLISECONDS_PER_HOUR;
  const sourceByValidAt = new Map<string, TemperatureNowcastResearchEvent>();

  // retain only causally mature candidate rows
  for (const source of events) {
    const sourceReferenceMilliseconds = instantMilliseconds(
      source.referenceAt,
      "source.referenceAt",
    );
    const sourceValidMilliseconds = instantMilliseconds(
      source.validAt,
      "source.validAt",
    );
    const availableMilliseconds = sourceValidMilliseconds +
      TEMPERATURE_NOWCAST_OBSERVATION_LAG_HOURS * MILLISECONDS_PER_HOUR;

    // exclude unsupported source horizons
    if (source.targetLeadHours > TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS) {
      continue;
    }

    // enforce strict issue-time precedence
    if (sourceReferenceMilliseconds >= targetReferenceMilliseconds) {
      continue;
    }

    // enforce assumed observation maturity
    if (availableMilliseconds > targetReferenceMilliseconds) {
      continue;
    }

    // retain the inclusive six-hour valid-time window
    if (
      sourceValidMilliseconds < earliestValidMilliseconds ||
      sourceValidMilliseconds > targetReferenceMilliseconds
    ) {
      continue;
    }

    const current = sourceByValidAt.get(source.validAt);
    sourceByValidAt.set(
      source.validAt,
      current === undefined ? source : preferredSource(current, source),
    );
  }

  return [...sourceByValidAt.values()].sort(
    // choose the latest distinct valid hours
    (left, right) => compareStrings(right.validAt, left.validAt),
  ).slice(0, TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS);
}

// project one selected source into private evidence
function sourceAuditRecord(
  source: TemperatureNowcastResearchEvent,
  targetReferenceMilliseconds: number,
): TemperatureNowcastPrivateSourceRecord {
  const sourceValidMilliseconds = instantMilliseconds(
    source.validAt,
    "source.validAt",
  );

  return {
    actual: source.actual,
    ageHoursAtReference:
      (targetReferenceMilliseconds - sourceValidMilliseconds) /
      MILLISECONDS_PER_HOUR,
    availableAt: new Date(
      sourceValidMilliseconds +
      TEMPERATURE_NOWCAST_OBSERVATION_LAG_HOURS * MILLISECONDS_PER_HOUR,
    ).toISOString(),
    error: source.actual - source.rawForecast,
    key: source.key,
    rawForecast: source.rawForecast,
    referenceAt: source.referenceAt,
    targetLeadHours: source.targetLeadHours,
    validAt: source.validAt,
  };
}

// build one private record from one deterministic prediction
function predictEvent(
  events: readonly TemperatureNowcastResearchEvent[],
  target: TemperatureNowcastResearchEvent,
): TemperatureNowcastPrivateAuditRecord {
  const targetReferenceMilliseconds = instantMilliseconds(
    target.referenceAt,
    "target.referenceAt",
  );
  const targetValidMilliseconds = instantMilliseconds(
    target.validAt,
    "target.validAt",
  );
  let fallbackReason: TemperatureNowcastFallbackReason | null = null;
  let sources: readonly TemperatureNowcastResearchEvent[] = [];
  let medianBias: number | null = null;
  let decay: number | null = null;
  let nowcastCorrection: number | null = null;
  let latestSourceAgeToTargetHours: number | null = null;
  let nearNowcastPrediction = target.priorPrediction;

  // preserve the old hybrid after twelve hours
  if (target.targetLeadHours > TEMPERATURE_NOWCAST_MAXIMUM_TARGET_LEAD_HOURS) {
    fallbackReason = "outside_first_12_hours";
  } else if (!target.baselineEligible) {
    // preserve ineligible target rows exactly
    fallbackReason = "baseline_ineligible";
  } else {
    sources = selectSources(events, target);

    // require exactly three distinct mature hours
    if (sources.length < TEMPERATURE_NOWCAST_REQUIRED_UNIQUE_HOURS) {
      fallbackReason = "insufficient_unique_source_hours";
    } else {
      medianBias = medianOfThree(sources.map(
        // retain one raw forecast error per selected hour
        (source) => source.actual - source.rawForecast,
      ));
      const latestSource = sources[0];

      // guard the fixed nonempty support
      if (latestSource === undefined) {
        throw new Error("temperature nowcast latest source is missing");
      }

      latestSourceAgeToTargetHours =
        (targetValidMilliseconds - instantMilliseconds(
          latestSource.validAt,
          "latestSource.validAt",
        )) / MILLISECONDS_PER_HOUR;
      decay = 2 ** (
        -latestSourceAgeToTargetHours / TEMPERATURE_NOWCAST_HALF_LIFE_HOURS
      );
      nowcastCorrection = clamp(
        medianBias * decay,
        TEMPERATURE_NOWCAST_MINIMUM_CORRECTION_C,
        TEMPERATURE_NOWCAST_MAXIMUM_CORRECTION_C,
      );
      nearNowcastPrediction = clamp(
        target.rawForecast + nowcastCorrection,
        TEMPERATURE_NOWCAST_PHYSICAL_MINIMUM_C,
        TEMPERATURE_NOWCAST_PHYSICAL_MAXIMUM_C,
      );
    }
  }

  return {
    actual: target.actual,
    baselineEligible: target.baselineEligible,
    daypart: target.daypart,
    decay,
    fallbackReason,
    humidityBin: target.humidityBin,
    key: target.key,
    latestSourceAgeToTargetHours,
    leadBand: target.leadBand,
    localDate: target.localDate,
    medianBias,
    nearNowcastPrediction,
    nowcastCorrection,
    priorBoostedHybridPrediction: target.priorPrediction,
    rawForecast: target.rawForecast,
    rawRelativeHumidityPercent: target.rawRelativeHumidityPercent,
    rawWindSpeedMps: target.rawWindSpeedMps,
    referenceAt: target.referenceAt,
    season: target.season,
    selectedSources: sources.map(
      // retain auditable causal source material
      (source) => sourceAuditRecord(source, targetReferenceMilliseconds),
    ),
    sixHourBucket: target.sixHourBucket,
    targetLeadHours: target.targetLeadHours,
    temperatureBin: target.temperatureBin,
    validAt: target.validAt,
    windSpeedBin: target.windSpeedBin,
  };
}

// produce one deterministic recent-error prediction audit
export function createTemperatureNowcastPredictionAudit(
  events: readonly TemperatureNowcastResearchEvent[],
): TemperatureNowcastPredictionAudit {
  // require an actual immutable-compatible array boundary
  if (!Array.isArray(events)) {
    throw new RangeError("temperature nowcast events must be an array");
  }

  const ordered = [...events].sort(
    // remove source arrival-order dependence
    (left, right) => compareStrings(left.key, right.key),
  );
  validateEvents(ordered);
  const sourceCandidates = ordered.filter(
    // avoid scanning rows that can never supply recent errors
    (event) => event.targetLeadHours <= TEMPERATURE_NOWCAST_MAXIMUM_SOURCE_LEAD_HOURS,
  );
  const records = ordered.map(
    // predict every complete denominator row
    (event) => predictEvent(sourceCandidates, event),
  );

  return {
    records,
    predictionByKey: new Map(records.map(
      // bind each prediction to its canonical key
      (record) => [record.key, record.nearNowcastPrediction],
    )),
  };
}
