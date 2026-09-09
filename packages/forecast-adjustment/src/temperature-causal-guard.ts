import {
  localCalendarFeaturesFor,
  type LocalDaypart,
} from "./calendar.js";

// freeze the complete causal raw-fallback policy
export const TEMPERATURE_CAUSAL_GUARD_POLICY = Object.freeze({
  lookbackElapsedHours: 168,
  maximumSourceLeadHours: 12,
  maximumTargetLeadHours: 12,
  observationAvailabilityLagHours: 1,
  supportDistinctLocalDates: 3,
  supportUniqueValidHours: 12,
  tieAction: "raw",
} as const);

const MILLISECONDS_PER_HOUR = 3_600_000;
const UTC_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

// describe one exact frozen-prediction event
export interface TemperatureCausalGuardEvent {
  readonly actual: number;
  readonly halfStrengthPrediction: number;
  readonly key: string;
  readonly rawForecast: number;
  readonly referenceAt: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// enumerate every explicit half-strength fallback
export type TemperatureCausalGuardFallbackReason =
  | "insufficient_distinct_local_dates"
  | "insufficient_unique_source_hours"
  | "outside_first_12_hours";

// retain one complete selected-source audit
export interface TemperatureCausalGuardSourceAudit {
  readonly actual: number;
  readonly availableAt: string;
  readonly halfStrengthAbsoluteError: number;
  readonly halfStrengthPrediction: number;
  readonly key: string;
  readonly localDate: string;
  readonly rawAbsoluteError: number;
  readonly rawForecast: number;
  readonly referenceAt: string;
  readonly targetLeadHours: number;
  readonly validAt: string;
}

// retain one independently reconstructable guard decision
export interface TemperatureCausalGuardAuditRecord
  extends TemperatureCausalGuardEvent {
  readonly action: "half" | "raw";
  readonly fallbackReason: TemperatureCausalGuardFallbackReason | null;
  readonly guardedPrediction: number;
  readonly halfStrengthEqualDateMeanAbsoluteError: number | null;
  readonly rawEqualDateMeanAbsoluteError: number | null;
  readonly selectedSources: readonly TemperatureCausalGuardSourceAudit[];
  readonly supportDistinctLocalDates: number;
  readonly supportUniqueValidHours: number;
}

interface PreparedEvent extends TemperatureCausalGuardEvent {
  readonly daypart: LocalDaypart;
  readonly localDate: string;
  readonly referenceAtMilliseconds: number;
  readonly validAtMilliseconds: number;
}

interface DateLossAccumulator {
  count: number;
  halfStrengthAbsoluteErrorSum: number;
  rawAbsoluteErrorSum: number;
}

const EXACT_EVENT_KEYS = [
  "actual",
  "halfStrengthPrediction",
  "key",
  "rawForecast",
  "referenceAt",
  "targetLeadHours",
  "validAt",
] as const;

// parse one canonical millisecond UTC instant
function instantMilliseconds(value: string, field: string): number {
  // reject offsets, normalized values, and invalid instants
  if (
    typeof value !== "string" ||
    !UTC_INSTANT_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new RangeError(`${field} must be a canonical UTC instant`);
  }

  return Date.parse(value);
}

// validate and enrich one event
function prepareEvent(event: TemperatureCausalGuardEvent): PreparedEvent {
  // require one non-array object
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    throw new RangeError("temperature causal guard event must be an object");
  }

  const keys = Object.keys(event).sort();
  const expectedKeys = [...EXACT_EVENT_KEYS].sort();

  // bind inputs to the exact event contract
  if (
    keys.length !== expectedKeys.length ||
    keys.some(
      // compare each sorted schema field
      (key, index) => key !== expectedKeys[index],
    )
  ) {
    throw new RangeError("temperature causal guard event fields must match the frozen schema");
  }

  // require all numeric evidence to be finite
  if (
    !Number.isFinite(event.actual) ||
    !Number.isFinite(event.halfStrengthPrediction) ||
    !Number.isFinite(event.rawForecast)
  ) {
    throw new RangeError("temperature causal guard event numbers must be finite");
  }

  // require one stable nonempty identity
  if (typeof event.key !== "string" || event.key.trim().length === 0) {
    throw new RangeError("temperature causal guard key must be nonempty");
  }

  // require one supported integer lead
  if (
    !Number.isInteger(event.targetLeadHours) ||
    event.targetLeadHours < 1 ||
    event.targetLeadHours > 168
  ) {
    throw new RangeError("temperature causal guard targetLeadHours must be between 1 and 168");
  }

  const validAtMilliseconds = instantMilliseconds(event.validAt, "validAt");
  const referenceAtMilliseconds = instantMilliseconds(event.referenceAt, "referenceAt");

  const elapsedLeadHours =
    (validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR;

  // bind the lead label to the two event instants
  if (elapsedLeadHours <= 0 || Math.ceil(elapsedLeadHours) !== event.targetLeadHours) {
    throw new RangeError("temperature causal guard targetLeadHours must match validAt and referenceAt");
  }

  const calendar = localCalendarFeaturesFor(event.validAt);
  return {
    actual: event.actual,
    daypart: calendar.daypart,
    halfStrengthPrediction: event.halfStrengthPrediction,
    key: event.key,
    localDate: calendar.localDate,
    rawForecast: event.rawForecast,
    referenceAt: event.referenceAt,
    referenceAtMilliseconds,
    targetLeadHours: event.targetLeadHours,
    validAt: event.validAt,
    validAtMilliseconds,
  };
}

// identify one frozen six-hour source band
function sourceBand(targetLeadHours: number): "first6" | "hours7To12" | null {
  // exclude later leads as guard sources
  if (targetLeadHours > TEMPERATURE_CAUSAL_GUARD_POLICY.maximumSourceLeadHours) {
    return null;
  }

  // separate the two frozen source bands
  if (targetLeadHours <= 6) {
    return "first6";
  }

  return "hours7To12";
}

// prefer one deterministic vintage for a shared valid hour
function candidateIsPreferred(
  candidate: PreparedEvent,
  incumbent: PreparedEvent,
  target: PreparedEvent,
): boolean {
  const candidateLeadDistance = Math.abs(
    candidate.targetLeadHours - target.targetLeadHours,
  );
  const incumbentLeadDistance = Math.abs(
    incumbent.targetLeadHours - target.targetLeadHours,
  );

  // prefer the closest source lead first
  if (candidateLeadDistance !== incumbentLeadDistance) {
    return candidateLeadDistance < incumbentLeadDistance;
  }

  // prefer the latest strictly prior forecast vintage next
  if (candidate.referenceAtMilliseconds !== incumbent.referenceAtMilliseconds) {
    return candidate.referenceAtMilliseconds > incumbent.referenceAtMilliseconds;
  }

  // prefer the greatest canonical key last
  return candidate.key > incumbent.key;
}

// test one source against every causal and grouping constraint
function sourceIsEligible(source: PreparedEvent, target: PreparedEvent): boolean {
  const targetBand = sourceBand(target.targetLeadHours);
  const sourceAvailableAt =
    source.validAtMilliseconds +
    TEMPERATURE_CAUSAL_GUARD_POLICY.observationAvailabilityLagHours *
      MILLISECONDS_PER_HOUR;
  const earliestValidAt =
    target.referenceAtMilliseconds -
    TEMPERATURE_CAUSAL_GUARD_POLICY.lookbackElapsedHours * MILLISECONDS_PER_HOUR;

  // require every fixed causal grouping condition
  return targetBand !== null &&
    sourceBand(source.targetLeadHours) === targetBand &&
    source.daypart === target.daypart &&
    source.referenceAtMilliseconds < target.referenceAtMilliseconds &&
    sourceAvailableAt <= target.referenceAtMilliseconds &&
    source.validAtMilliseconds >= earliestValidAt;
}

// select one deterministic source per distinct valid hour
function selectSources(
  events: readonly PreparedEvent[],
  target: PreparedEvent,
): readonly PreparedEvent[] {
  const byValidAt = new Map<string, PreparedEvent>();

  // inspect every possible historical source
  for (const source of events) {
    // exclude events outside the frozen causal group
    if (!sourceIsEligible(source, target)) {
      continue;
    }

    const incumbent = byValidAt.get(source.validAt);

    // replace only with the frozen preferred vintage
    if (
      incumbent === undefined ||
      candidateIsPreferred(source, incumbent, target)
    ) {
      byValidAt.set(source.validAt, source);
    }
  }

  return [...byValidAt.values()].sort(
    // expose selected hours in stable chronological order
    (left, right) => left.validAtMilliseconds - right.validAtMilliseconds,
  );
}

// project one immutable source audit
function sourceAudit(source: PreparedEvent): TemperatureCausalGuardSourceAudit {
  return Object.freeze({
    actual: source.actual,
    availableAt: new Date(
      source.validAtMilliseconds +
      TEMPERATURE_CAUSAL_GUARD_POLICY.observationAvailabilityLagHours *
        MILLISECONDS_PER_HOUR,
    ).toISOString(),
    halfStrengthAbsoluteError: Math.abs(
      source.halfStrengthPrediction - source.actual,
    ),
    halfStrengthPrediction: source.halfStrengthPrediction,
    key: source.key,
    localDate: source.localDate,
    rawAbsoluteError: Math.abs(source.rawForecast - source.actual),
    rawForecast: source.rawForecast,
    referenceAt: source.referenceAt,
    targetLeadHours: source.targetLeadHours,
    validAt: source.validAt,
  });
}

// compute equal-date comparator errors from distinct selected hours
function equalDateLosses(
  sources: readonly TemperatureCausalGuardSourceAudit[],
): {
  readonly halfStrength: number | null;
  readonly raw: number | null;
} {
  // preserve explicit null evidence without any selected sources
  if (sources.length === 0) {
    return { halfStrength: null, raw: null };
  }

  const byDate = new Map<string, DateLossAccumulator>();

  // accumulate each selected hour inside its local date
  for (const source of sources) {
    let date = byDate.get(source.localDate);

    // initialize one represented local date
    if (date === undefined) {
      date = {
        count: 0,
        halfStrengthAbsoluteErrorSum: 0,
        rawAbsoluteErrorSum: 0,
      };
      byDate.set(source.localDate, date);
    }

    date.count += 1;
    date.halfStrengthAbsoluteErrorSum += source.halfStrengthAbsoluteError;
    date.rawAbsoluteErrorSum += source.rawAbsoluteError;
  }

  let halfStrengthDateMeanSum = 0;
  let rawDateMeanSum = 0;

  // weight every represented date equally
  for (const date of byDate.values()) {
    halfStrengthDateMeanSum += date.halfStrengthAbsoluteErrorSum / date.count;
    rawDateMeanSum += date.rawAbsoluteErrorSum / date.count;
  }

  return {
    halfStrength: halfStrengthDateMeanSum / byDate.size,
    raw: rawDateMeanSum / byDate.size,
  };
}

// create one immutable audit from a validated target
function createAuditRecord(
  events: readonly PreparedEvent[],
  target: PreparedEvent,
): TemperatureCausalGuardAuditRecord {
  const targetBand = sourceBand(target.targetLeadHours);

  // preserve exact later-horizon predictions without source inspection
  if (targetBand === null) {
    return Object.freeze({
      action: "half",
      actual: target.actual,
      fallbackReason: "outside_first_12_hours",
      guardedPrediction: target.halfStrengthPrediction,
      halfStrengthEqualDateMeanAbsoluteError: null,
      halfStrengthPrediction: target.halfStrengthPrediction,
      key: target.key,
      rawEqualDateMeanAbsoluteError: null,
      rawForecast: target.rawForecast,
      referenceAt: target.referenceAt,
      selectedSources: Object.freeze([]),
      supportDistinctLocalDates: 0,
      supportUniqueValidHours: 0,
      targetLeadHours: target.targetLeadHours,
      validAt: target.validAt,
    });
  }

  const selectedSources = Object.freeze(selectSources(events, target).map(
    // retain the complete chosen source evidence
    (source) => sourceAudit(source),
  ));
  const supportDistinctLocalDates = new Set(selectedSources.map(
    // count each represented local date
    (source) => source.localDate,
  )).size;
  const supportUniqueValidHours = selectedSources.length;
  const losses = equalDateLosses(selectedSources);
  let fallbackReason: TemperatureCausalGuardFallbackReason | null = null;

  // retain half below the distinct-hour floor
  if (
    supportUniqueValidHours <
    TEMPERATURE_CAUSAL_GUARD_POLICY.supportUniqueValidHours
  ) {
    fallbackReason = "insufficient_unique_source_hours";
  } else if (
    supportDistinctLocalDates <
    TEMPERATURE_CAUSAL_GUARD_POLICY.supportDistinctLocalDates
  ) {
    // retain half below the distinct-date floor
    fallbackReason = "insufficient_distinct_local_dates";
  }

  const supported = fallbackReason === null;

  // guard impossible supported null losses
  if (supported && (losses.halfStrength === null || losses.raw === null)) {
    throw new Error("temperature causal guard supported losses are missing");
  }

  // prefer raw for supported wins and ties
  const action = supported &&
    losses.halfStrength !== null &&
    losses.raw !== null &&
    losses.halfStrength >= losses.raw
    ? "raw"
    : "half";

  return Object.freeze({
    action,
    actual: target.actual,
    fallbackReason,
    // preserve the selected comparator exactly
    guardedPrediction: action === "raw"
      ? target.rawForecast
      : target.halfStrengthPrediction,
    halfStrengthEqualDateMeanAbsoluteError: losses.halfStrength,
    halfStrengthPrediction: target.halfStrengthPrediction,
    key: target.key,
    rawEqualDateMeanAbsoluteError: losses.raw,
    rawForecast: target.rawForecast,
    referenceAt: target.referenceAt,
    selectedSources,
    supportDistinctLocalDates,
    supportUniqueValidHours,
    targetLeadHours: target.targetLeadHours,
    validAt: target.validAt,
  });
}

// apply the fixed causal guard in original input order
export function createTemperatureCausalGuardAudit(
  events: readonly TemperatureCausalGuardEvent[],
): readonly TemperatureCausalGuardAuditRecord[] {
  // require an actual event array
  if (!Array.isArray(events)) {
    throw new RangeError("temperature causal guard events must be an array");
  }

  const prepared = events.map(
    // validate each caller-owned event without mutation
    (event) => prepareEvent(event),
  );
  const keys = new Set<string>();
  const actualByValidAt = new Map<string, number>();

  // bind unique identities and shared observed outcomes
  for (const event of prepared) {
    // reject duplicate event identities
    if (keys.has(event.key)) {
      throw new RangeError("temperature causal guard keys must be unique");
    }

    keys.add(event.key);
    const sharedActual = actualByValidAt.get(event.validAt);

    // reject contradictory labels for one physical hour
    if (sharedActual !== undefined && sharedActual !== event.actual) {
      throw new RangeError(
        "temperature causal guard actual values must agree within a valid hour",
      );
    }

    actualByValidAt.set(event.validAt, event.actual);
  }

  const records = prepared.map(
    // preserve the caller's original input order
    (target) => createAuditRecord(prepared, target),
  );
  return Object.freeze(records);
}
