import { localCalendarFeaturesFor } from "./calendar.js";
import {
  scoreTemperatureAnalogValidationRecords,
  TEMPERATURE_ANALOG_VALIDATION_POLICY,
  type TemperatureAnalogValidationRecord,
  type TemperatureAnalogValidationScore,
} from "./temperature-analog-validation.js";

// freeze diagnostic choices without authorizing another tuning pass
export const TEMPERATURE_ANALOG_STRESS_POLICY = Object.freeze({
  contractVersion: "temperature-analog-half-strength-stress/v1",
  availabilityLagHours: Object.freeze([1, 2, 3, 6, 24] as const),
  contiguousOmissionLengths: Object.freeze([3] as const),
  rollingWindowLength: 3,
  qualificationAllowed: false,
  sourceReselectionAllowed: false,
  minimumCellSizeGate: "none_report_all_counts_and_empty_cells",
  vintageTieBreak: "greatest_canonical_key_for_equal_reference",
} as const);

// accept only the frozen audit fields used by these checks
export interface TemperatureAnalogStressRecord extends TemperatureAnalogValidationRecord {
  readonly shrunkAnalogPrediction: number;
  readonly selectedSources: readonly {
    readonly key: string;
    readonly referenceAt: string;
    readonly validAt: string;
  }[];
}

const HOUR = 3_600_000;
const MODEL_KEYS = ["raw", "oldHybrid", "fullAnalog", "halfAnalog"] as const;
type Scores = Readonly<Record<(typeof MODEL_KEYS)[number], TemperatureAnalogValidationScore>>;

// compare canonical strings without locale-dependent ordering
function order(left: string, right: string): number {
  return left < right ? -1 : Number(left > right);
}

// require exact source chronology rather than silently normalizing dates
function instant(value: string): number {
  const result = Date.parse(value);
  // reject malformed evidence
  if (!Number.isFinite(result) || new Date(result).toISOString() !== value) {
    throw new RangeError("source timestamps must be canonical UTC instants");
  }
  return result;
}

// score all four frozen predictions on the same supplied population
function score(records: readonly TemperatureAnalogStressRecord[]): Scores {
  const full = scoreTemperatureAnalogValidationRecords(records);
  const half = scoreTemperatureAnalogValidationRecords(records.map(
    // substitute only the explicit challenger prediction
    (record) => ({ ...record, analogPrediction: record.shrunkAnalogPrediction }),
  ));
  return { raw: full.raw, oldHybrid: full.prior, fullAnalog: full.analog, halfAnalog: half.analog };
}

// summarize all comparator advantages without choosing a favorable comparator
function differences(scores: Scores) {
  const half = scores.halfAnalog.hourBalancedMeanAbsoluteError;
  return Object.fromEntries(MODEL_KEYS.slice(0, 3).map(
    // retain nulls for empty populations
    (key) => {
      const prior = scores[key].hourBalancedMeanAbsoluteError;
      return [key, prior === null || half === null ? null : prior - half];
    },
  ));
}

// bind frozen midpoint fields and source availability before any subgroup scoring
function prepare(records: readonly TemperatureAnalogStressRecord[]) {
  score(records);
  // reject unsupported candidate or source mutations
  for (const record of records) {
    const supported = record.fallbackReason === null;
    const expected = supported
      ? record.priorPrediction + 0.5 * (record.analogPrediction - record.priorPrediction)
      : record.priorPrediction;
    // require the exact retained half-strength candidate
    if (!Number.isFinite(record.shrunkAnalogPrediction) || record.shrunkAnalogPrediction !== expected) {
      throw new RangeError("shrunkAnalogPrediction must equal the frozen midpoint or fallback");
    }
    // require supported targets to retain all twelve distinct source hours
    if (supported && (record.targetLeadHours > 12 || record.selectedSources.length !== 12)) {
      throw new RangeError("supported first12 targets must retain twelve sources");
    }
    // preserve original fallback predictions exactly
    if (!supported && record.analogPrediction !== record.priorPrediction) {
      throw new RangeError("fallback predictions must equal the old prior");
    }
    const sourceKeys = new Set<string>();
    const sourceHours = new Set<string>();
    // validate even partially populated fallback source audits
    for (const source of record.selectedSources) {
      const valid = instant(source.validAt);
      const reference = instant(source.referenceAt);
      // enforce the original assumed one-hour availability boundary
      if (
        typeof source.key !== "string" || source.key.length === 0 || sourceKeys.has(source.key) || sourceHours.has(source.validAt) ||
        reference >= valid || reference >= Date.parse(record.referenceAt) ||
        valid + HOUR > Date.parse(record.referenceAt)
      ) {
        throw new RangeError("source identities and original availability must be valid");
      }
      sourceKeys.add(source.key);
      sourceHours.add(source.validAt);
    }
  }
  return [...records].sort(
    // match the original audit's canonical input ordering
    (left, right) => order(left.key, right.key),
  ).map(
    // derive diagnostic labels instead of trusting imported labels
    (record) => ({ ...record, ...localCalendarFeaturesFor(record.validAt) }),
  );
}

// expand only frozen-record diagnostics and explicit missing-source scenarios
export function analyzeTemperatureAnalogStress(records: readonly TemperatureAnalogStressRecord[]) {
  const ordered = prepare(records);
  const first12 = ordered.filter(
    // preserve the complete first-twelve-hour denominator
    (record) => record.targetLeadHours <= 12,
  );
  const dates = [...new Set(first12.map(
    // identify represented local dates
    (record) => record.localDate,
  ))].sort();
  // keep chronological windows meaningful without bridging missing dates
  for (let index = 1; index < dates.length; index += 1) {
    // reject gaps rather than calling adjacent observed dates contiguous
    if (Date.parse(dates[index]!) - Date.parse(dates[index - 1]!) !== 24 * HOUR) {
      throw new RangeError("stress windows require consecutive represented local dates");
    }
  }
  // score one fixed selected-date population
  const dateSubset = (selected: readonly string[], omit: boolean) => {
    const set = new Set(selected);
    const scores = score(first12.filter(
      // omit from scoring only without changing original source state
      (record) => set.has(record.localDate) !== omit,
    ));
    const supported = first12.filter(
      // count supported rows within the same scored population
      (record) => set.has(record.localDate) !== omit && record.fallbackReason === null,
    );
    return { dates: selected, scores, supportedEventCount: supported.length,
      supportedUniqueValidHours: new Set(supported.map(
        // retain distinct supported target hours
        (record) => record.validAt,
      )).size, comparatorMinusHalfMaeC: differences(scores) };
  };
  const pairOmissions = [];
  // enumerate every distinct pair rather than searching for a favorable deletion
  for (let left = 0; left < dates.length; left += 1) {
    // retain every second-date choice
    for (let right = left + 1; right < dates.length; right += 1) {
      pairOmissions.push({ ...dateSubset([dates[left]!, dates[right]!], true), consecutive: right === left + 1 });
    }
  }
  const contiguousOmissions = TEMPERATURE_ANALOG_STRESS_POLICY.contiguousOmissionLengths.map(
    // use nonwrapping calendar windows including partial boundary dates
    (length) => ({ length, rows: dates.slice(0, Math.max(0, dates.length - length + 1)).map(
      // omit each complete consecutive date window
      (_, index) => dateSubset(dates.slice(index, index + length), true),
    ) }),
  );
  const rollingWindows = dates.slice(0, Math.max(0, dates.length - 2)).map(
    // score each nonwrapping three-date window without refitting
    (_, index) => dateSubset(dates.slice(index, index + 3), false),
  );
  const daily = dates.map(
    // retain all partial-date diagnostics
    (date) => dateSubset([date], false),
  );
  const equalDateMaeC = Object.fromEntries(MODEL_KEYS.map(
    // weight each represented local date equally after its within-hour scoring
    (key) => [key, daily.length === 0 ? null : daily.reduce(
      // accumulate nonempty daily scores
      (sum, row) => sum + row.scores[key].hourBalancedMeanAbsoluteError!, 0,
    ) / daily.length],
  ));
  const vintageViews = (["earliest", "latest"] as const).map(
    // compare two fixed lead-mix-changing views without replacing the primary metric
    (vintage) => {
      const byHour = new Map<string, (typeof first12)[number]>();
      // choose one forecast vintage per distinct UTC target hour
      for (const record of first12) {
        const previous = byHour.get(record.validAt);
        const referenceOrder = previous === undefined ? 0 : order(record.referenceAt, previous.referenceAt);
        // resolve equal-reference ties by greatest canonical key
        if (previous === undefined ||
          (vintage === "latest" ? referenceOrder > 0 : referenceOrder < 0) ||
          (referenceOrder === 0 && record.key > previous.key)) {
          byHour.set(record.validAt, record);
        }
      }
      const selected = [...byHour.values()].sort(
        // restore canonical accumulation order
        (left, right) => order(left.key, right.key),
      );
      return { vintage, scores: score(selected), leadCounts: Array.from({ length: 12 },
        // report the changed lead mixture explicitly
        (_, index) => ({ lead: index + 1, eventCount: selected.filter(
          // count each selected lead
          (record) => record.targetLeadHours === index + 1,
        ).length }),
      ) };
    },
  );
  const leadByDaypart = Array.from({ length: 12 },
    // retain every exact lead including unsupported cells
    (_, index) => TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.dayparts.map(
      // retain all four dayparts and explicit empty scores
      (daypart) => ({ lead: index + 1, daypart, scores: score(first12.filter(
        // use only derived local calendar labels
        (record) => record.targetLeadHours === index + 1 && record.daypart === daypart,
      )) }),
    ),
  ).flat();
  const availability = TEMPERATURE_ANALOG_STRESS_POLICY.availabilityLagHours.map(
    // stress delayed selected-source availability without reselecting neighbors
    (lagHours) => {
      let newlyUnsupportedCount = 0;
      let changedHalfPredictionCount = 0;
      const newlyUnsupportedHours = new Set<string>();
      const retainedSupportedHours = new Set<string>();
      let retainedSupportedCount = 0;
      const stressed = ordered.map(
        // fall back symmetrically for both analog variants
        (record) => {
          const unavailable = record.fallbackReason === null && record.selectedSources.some(
            // require every original selected source at the target reference
            (source) => Date.parse(source.validAt) + lagHours * HOUR > Date.parse(record.referenceAt),
          );
          // leave original fallbacks and later leads untouched
          if (!unavailable) {
            // count unchanged supported rows separately from original fallback rows
            if (record.fallbackReason === null) {
              retainedSupportedCount += 1;
              retainedSupportedHours.add(record.validAt);
            }
            return record;
          }
          newlyUnsupportedCount += 1;
          newlyUnsupportedHours.add(record.validAt);
          changedHalfPredictionCount += Number(record.shrunkAnalogPrediction !== record.priorPrediction);
          return { ...record, analogPrediction: record.priorPrediction, shrunkAnalogPrediction: record.priorPrediction };
        },
      );
      return { lagHours, newlyUnsupportedCount, changedHalfPredictionCount,
        newlyUnsupportedUniqueHours: newlyUnsupportedHours.size,
        retainedSupportedCount, retainedSupportedUniqueHours: retainedSupportedHours.size,
        scopes: TEMPERATURE_ANALOG_VALIDATION_POLICY.scopes.map(
          // report all original horizons with unchanged targets and raw/prior controls
          (scope) => ({ key: scope.key, scores: score(stressed.filter(
            // retain the complete requested lead interval
            (record) => record.targetLeadHours >= scope.minimumLeadHours && record.targetLeadHours <= scope.maximumLeadHours,
          )) }),
        ),
      };
    },
  );
  return {
    policy: TEMPERATURE_ANALOG_STRESS_POLICY,
    qualification: false,
    productionActivationAllowed: false,
    candidateChanged: false,
    newIndependentDatesAdded: 0,
    interpretation: "post_selection_stress_diagnostics_not_cross_validation_or_latency_reconstruction",
    dateCount: dates.length,
    primary: score(first12),
    daily,
    equalDateMaeC,
    pairOmissions,
    contiguousOmissions,
    rollingWindows,
    vintageViews,
    leadByDaypart,
    availability,
  };
}
