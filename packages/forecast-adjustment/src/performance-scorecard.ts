import {
  FORECAST_OBSERVATION_STATIONS,
  RAIN_COLLECTION_POLICY,
  RAIN_COLLECTION_STATIONS,
  type ForecastObservationStationKey,
} from "@weather/domain";

import { corePairedSkill, scalarNetworkActual } from "./algorithm-v1.js";
import {
  MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX,
  MOVING_BLOCK_BOOTSTRAP_REPLICATES,
  MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX,
  createSingleWindowBootstrapStartPlan,
  expandNonCircularBlockStarts,
} from "./bootstrap-v1.js";
import { localCalendarFeaturesFor } from "./calendar.js";

export const FORECAST_ADJUSTMENT_PERFORMANCE_REPORT_VERSION =
  "forecast-adjustment-performance-report/v1" as const;

export type ForecastAdjustmentEvidenceClass =
  | "as_issued"
  | "prospective_receipt"
  | "retrospective_counterfactual"
  | "development";

export type ForecastAdjustmentSupportState =
  | "sufficient"
  | "insufficient"
  | "invalid";
export type ForecastAdjustmentComparisonState =
  | "unscored"
  | "better"
  | "mixed"
  | "worse";
export type ForecastAdjustmentQualificationState =
  | "development_only"
  | "counterfactual_only"
  | "pending_support"
  | "supported"
  | "rejected";
export type ForecastAdjustmentServingState =
  | "authorized_active"
  | "admin_disabled"
  | "fail_raw"
  | "pending_review";

export type ForecastAdjustmentExclusionReason =
  | "invalid_target"
  | "issued_after_valid"
  | "missing_target"
  | "receipt_chronology_missing"
  | "source_late";

export type ForecastAdjustmentDiagnosticReason = "provenance_incomplete";

// describe one already paired raw and adjusted forecast row
export interface ForecastAdjustmentPerformancePair {
  readonly adjustedPrediction: number;
  readonly evidenceClass: ForecastAdjustmentEvidenceClass;
  readonly fallback: boolean;
  readonly firstEdgeCommittedAt: string | null;
  readonly horizonHours: number;
  readonly key: string;
  readonly localDate: string;
  readonly provenanceComplete: boolean;
  readonly rawPrediction: number;
  readonly rowIdentity: string;
  readonly sourceReceiptAt: string | null;
  readonly target: number | null;
  readonly targetKey: string;
  readonly validAt: string;
  readonly vintageKey: string;
}

// summarize the deterministic date/hour/vintage weight
export interface ForecastAdjustmentWeightedPair
  extends ForecastAdjustmentPerformancePair {
  readonly weight: number;
}

// report one weighted forecast distribution
export interface ForecastAdjustmentMetricSummary {
  readonly bias: number;
  readonly mae: number;
  readonly p95AbsoluteError: number;
  readonly rmse: number;
}

// report a paired raw-versus-adjusted aggregate
export interface ForecastAdjustmentPairedMetricSummary {
  readonly adjusted: ForecastAdjustmentMetricSummary;
  readonly delta: ForecastAdjustmentMetricSummary;
  readonly raw: ForecastAdjustmentMetricSummary;
  readonly skill: number;
}

// report paired bootstrap uncertainty without retaining raw events
export interface ForecastAdjustmentBootstrapSummary {
  readonly contractVersion: "moving-block-bootstrap/v1";
  readonly lowerSkill: number;
  readonly replicates: 2_000;
  readonly upperSkill: number;
}

// retain exact scored and excluded populations
export interface ForecastAdjustmentPreparedPairs {
  readonly coalescedDuplicateCount: number;
  readonly diagnostics: Readonly<Record<ForecastAdjustmentDiagnosticReason, number>>;
  readonly exclusions: Readonly<Record<ForecastAdjustmentExclusionReason, number>>;
  readonly fallbackCount: number;
  readonly rows: readonly ForecastAdjustmentPerformancePair[];
}

// report one bounded aggregate and orthogonal review states
export interface ForecastAdjustmentPerformanceEvaluation {
  readonly bootstrap: ForecastAdjustmentBootstrapSummary | null;
  readonly comparisonState: ForecastAdjustmentComparisonState;
  readonly dateCount: number;
  readonly evidenceClass: ForecastAdjustmentEvidenceClass;
  readonly eventCount: number;
  readonly metrics: ForecastAdjustmentPairedMetricSummary | null;
  readonly qualificationState: ForecastAdjustmentQualificationState;
  readonly servingState: ForecastAdjustmentServingState;
  readonly supportState: ForecastAdjustmentSupportState;
  readonly weightedRows: readonly ForecastAdjustmentWeightedPair[];
}

// describe one physical-station target candidate
export interface ForecastAdjustmentStationTargetValue {
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly value: number;
}

// describe one fixed-catalog rain gauge contribution
export interface ForecastAdjustmentRainGaugeValue {
  readonly precipitationMm: number | null;
  readonly stationId: number;
}

// report an authorized fixed-gauge target without imputing gaps
export interface ForecastAdjustmentRainGaugeTarget {
  readonly complete: boolean;
  readonly precipitationMm: number | null;
  readonly stationCount: number;
}

export interface ForecastAdjustmentRainProbability {
  readonly atLeast0_1: number;
  readonly atLeast1_0: number;
  readonly atLeast2_5: number;
}

// extend a paired row with rain-only probability and run identities
export interface ForecastAdjustmentRainPerformancePair
  extends ForecastAdjustmentPerformancePair {
  readonly adjustedProbability: ForecastAdjustmentRainProbability;
  readonly amountParity: boolean;
  readonly runKey: string;
  readonly targetTilingComplete: boolean;
}

// report one fixed reliability decile
export interface ForecastAdjustmentReliabilityBin {
  readonly count: number;
  readonly meanProbability: number | null;
  readonly observedFrequency: number | null;
}

// report one rain event threshold
export interface ForecastAdjustmentRainThresholdSummary {
  readonly adjustedBrier: number;
  readonly csi: number | null;
  readonly falseAlarms: number;
  readonly far: number | null;
  readonly hits: number;
  readonly misses: number;
  readonly pod: number | null;
  readonly rawBrier: null;
  readonly reliability: readonly ForecastAdjustmentReliabilityBin[];
  readonly thresholdMmPerHour: 0.1 | 1 | 2.5;
}

// report one complete same-run accumulation horizon
export interface ForecastAdjustmentRainAccumulationSummary {
  readonly adjustedMae: number | null;
  readonly completeWindows: number;
  readonly hours: 6 | 12 | 23;
  readonly rawMae: number | null;
}

// report rain-specific probability, volume and accumulation diagnostics
export interface ForecastAdjustmentRainDiagnostics {
  readonly accumulations: readonly ForecastAdjustmentRainAccumulationSummary[];
  readonly annualBalancedVolumeRatio: number | null;
  readonly heavyAdjustedMae: number | null;
  readonly heavyRawMae: number | null;
  readonly probabilityOrderViolationCount: number;
  readonly thresholds: readonly ForecastAdjustmentRainThresholdSummary[];
  readonly wetAdjustedMae: number | null;
  readonly wetRawMae: number | null;
  readonly winterBalancedVolumeRatio: number | null;
}

const RAIN_GAUGE_IDS = new Set<number>(
  RAIN_COLLECTION_STATIONS.map((station) => station.locationId),
);
const RAIN_NEAREST_GAUGE_IDS = new Set<number>(
  RAIN_COLLECTION_STATIONS
    .slice(0, 3)
    .map((station) => station.locationId),
);
const RAIN_THRESHOLDS = [0.1, 1, 2.5] as const;

// parse one canonical instant before chronology comparisons
function instant(value: string, name: string): number {
  const parsed = Date.parse(value);

  // reject normalized, offset or invalid instants
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RangeError(`${name} must be a canonical UTC instant`);
  }

  return parsed;
}

// compare all scoring content that must be identical across overlap surfaces
function overlapContent(pair: ForecastAdjustmentPerformancePair): string {
  return JSON.stringify({
    adjustedPrediction: pair.adjustedPrediction,
    evidenceClass: pair.evidenceClass,
    fallback: pair.fallback,
    horizonHours: pair.horizonHours,
    key: pair.key,
    localDate: pair.localDate,
    provenanceComplete: pair.provenanceComplete,
    rawPrediction: pair.rawPrediction,
    rowIdentity: pair.rowIdentity,
    target: pair.target,
    targetKey: pair.targetKey,
    validAt: pair.validAt,
    vintageKey: pair.vintageKey,
  });
}

// coalesce overlapping response windows at the earliest committed edge response
export function coalesceForecastAdjustmentPerformancePairs(
  pairs: readonly ForecastAdjustmentPerformancePair[],
): {
  readonly duplicateCount: number;
  readonly rows: readonly ForecastAdjustmentPerformancePair[];
} {
  const byIdentity = new Map<string, ForecastAdjustmentPerformancePair>();
  let duplicateCount = 0;

  // merge only the same stable row revision, settings and bundle identity
  for (const pair of pairs) {
    const identity = `${pair.rowIdentity}\u0000${pair.targetKey}`;
    const existing = byIdentity.get(identity);

    // retain the first unique row identity
    if (existing === undefined) {
      byIdentity.set(identity, pair);
      continue;
    }

    // stop a stable-identity scoring collision rather than repairing it
    if (overlapContent(existing) !== overlapContent(pair)) {
      throw new RangeError("forecast adjustment overlap identity collision");
    }

    duplicateCount += 1;
    const existingCommit = existing.firstEdgeCommittedAt;
    const pairCommit = pair.firstEdgeCommittedAt;

    // retain the earliest proven edge commit across days surfaces
    if (
      pairCommit !== null &&
      (existingCommit === null || instant(pairCommit, "firstEdgeCommittedAt") <
        instant(existingCommit, "firstEdgeCommittedAt"))
    ) {
      byIdentity.set(identity, pair);
    }
  }

  return {
    duplicateCount,
    rows: [...byIdentity.values()].sort((left, right) =>
      left.localDate.localeCompare(right.localDate) ||
      left.validAt.localeCompare(right.validAt) ||
      left.vintageKey.localeCompare(right.vintageKey) ||
      left.key.localeCompare(right.key),
    ),
  };
}

// count one exclusion without hiding its causal class
function incrementExclusion(
  exclusions: Record<ForecastAdjustmentExclusionReason, number>,
  reason: ForecastAdjustmentExclusionReason,
): void {
  exclusions[reason] += 1;
}

// validate and filter paired rows under the first-commit causal guard
export function prepareForecastAdjustmentPerformancePairs(
  pairs: readonly ForecastAdjustmentPerformancePair[],
): ForecastAdjustmentPreparedPairs {
  const coalesced = coalesceForecastAdjustmentPerformancePairs(pairs);
  const exclusions: Record<ForecastAdjustmentExclusionReason, number> = {
    invalid_target: 0,
    issued_after_valid: 0,
    missing_target: 0,
    receipt_chronology_missing: 0,
    source_late: 0,
  };
  const diagnostics: Record<ForecastAdjustmentDiagnosticReason, number> = {
    provenance_incomplete: 0,
  };
  const rows: ForecastAdjustmentPerformancePair[] = [];
  const keys = new Set<string>();
  let fallbackCount = 0;

  // validate every paired occurrence before adding it to the score population
  for (const pair of coalesced.rows) {
    const calendar = localCalendarFeaturesFor(pair.validAt);

    // bind declared dates and finite paired predictions
    if (
      pair.key.length === 0 || pair.rowIdentity.length === 0 ||
      pair.targetKey.length === 0 || pair.vintageKey.length === 0 ||
      calendar.localDate !== pair.localDate ||
      !Number.isFinite(pair.rawPrediction) ||
      !Number.isFinite(pair.adjustedPrediction) ||
      !Number.isInteger(pair.horizonHours) || pair.horizonHours < 1
    ) {
      throw new RangeError("forecast adjustment paired row is invalid");
    }

    const pairIdentity = `${pair.key}\u0000${pair.targetKey}`;

    // reject duplicate true-vintage keys after overlap coalescing
    if (keys.has(pairIdentity)) {
      throw new RangeError("forecast adjustment paired key is duplicated");
    }

    keys.add(pairIdentity);

    // exclude missing targets from both raw and adjusted populations
    if (pair.target === null) {
      incrementExclusion(exclusions, "missing_target");
      continue;
    }

    // exclude malformed targets from both sides
    if (!Number.isFinite(pair.target)) {
      incrementExclusion(exclusions, "invalid_target");
      continue;
    }

    // preserve raw fallback equality as an auditable invariant
    if (pair.fallback && !Object.is(pair.rawPrediction, pair.adjustedPrediction)) {
      throw new RangeError("forecast adjustment fallback differs from raw");
    }

    // retain incomplete provenance for descriptive scoring only
    if (!pair.provenanceComplete) {
      diagnostics.provenance_incomplete += 1;
    }

    const usesReceiptGuard =
      pair.evidenceClass === "as_issued" ||
      pair.evidenceClass === "prospective_receipt";

    // require both sides of causal chronology for receipt-backed evidence
    if (
      usesReceiptGuard &&
      (pair.sourceReceiptAt === null || pair.firstEdgeCommittedAt === null)
    ) {
      incrementExclusion(exclusions, "receipt_chronology_missing");
      continue;
    }

    // apply chronology only when a committed edge response is claimed
    if (pair.firstEdgeCommittedAt !== null) {
      const committedAt = instant(pair.firstEdgeCommittedAt, "firstEdgeCommittedAt");
      const validAt = instant(pair.validAt, "validAt");
      let chronologyExcluded = false;

      // count past rows independently from source lateness
      if (committedAt >= validAt) {
        incrementExclusion(exclusions, "issued_after_valid");
        chronologyExcluded = true;
      }

      // require source availability no later than the first edge commit
      if (
        pair.sourceReceiptAt === null ||
        instant(pair.sourceReceiptAt, "sourceReceiptAt") > committedAt
      ) {
        incrementExclusion(exclusions, "source_late");
        chronologyExcluded = true;
      }

      // exclude the row once after preserving every causal counter
      if (chronologyExcluded) {
        continue;
      }
    }

    fallbackCount += Number(pair.fallback);
    rows.push(pair);
  }

  return {
    coalescedDuplicateCount: coalesced.duplicateCount,
    diagnostics,
    exclusions,
    fallbackCount,
    rows,
  };
}

// assign equal date, then valid-hour, then vintage mass
export function balanceForecastAdjustmentPerformancePairs(
  pairs: readonly ForecastAdjustmentPerformancePair[],
): readonly ForecastAdjustmentWeightedPair[] {
  // reject empty success instead of returning zero error
  if (pairs.length === 0) {
    throw new RangeError("forecast adjustment score population is empty");
  }

  const evidenceClasses = new Set(pairs.map((pair) => pair.evidenceClass));

  // prevent retrospective and issued populations from being pooled
  if (evidenceClasses.size !== 1) {
    throw new RangeError("forecast adjustment evidence classes cannot be aggregated");
  }

  const byDate = new Map<string, Map<string, ForecastAdjustmentPerformancePair[]>>();

  // collect true vintages under each local-date and valid-hour identity
  for (const pair of pairs) {
    const byHour = byDate.get(pair.localDate) ??
      new Map<string, ForecastAdjustmentPerformancePair[]>();
    const vintages = byHour.get(pair.validAt) ?? [];
    vintages.push(pair);
    byHour.set(pair.validAt, vintages);
    byDate.set(pair.localDate, byHour);
  }

  const weighted: ForecastAdjustmentWeightedPair[] = [];

  // grant each date equal total mass
  for (const [, byHour] of [...byDate.entries()].sort()) {
    // grant each valid hour equal mass inside its date
    for (const [, vintages] of [...byHour.entries()].sort()) {
      // grant each true vintage equal mass inside its valid hour
      for (const pair of vintages.sort((left, right) =>
        left.vintageKey.localeCompare(right.vintageKey))) {
        weighted.push({
          ...pair,
          weight: 1 / byDate.size / byHour.size / vintages.length,
        });
      }
    }
  }

  return weighted;
}

// select a deterministic weighted quantile including exact 0 and 1 endpoints
function weightedQuantile(
  values: readonly { readonly value: number; readonly weight: number }[],
  probability: number,
): number {
  const sorted = [...values].sort((left, right) => left.value - right.value);
  let cumulative = 0;

  // return the first value whose cumulative mass reaches the quantile
  for (const entry of sorted) {
    cumulative += entry.weight;

    // retain deterministic left-continuous quantiles
    if (cumulative >= probability - Number.EPSILON) {
      return entry.value;
    }
  }

  const last = sorted.at(-1);

  // retain the compiler-proven nonempty distribution
  if (last === undefined) {
    throw new RangeError("weighted quantile requires values");
  }

  return last.value;
}

// compute one weighted error distribution
function metricSummary(
  pairs: readonly ForecastAdjustmentWeightedPair[],
  prediction: "adjustedPrediction" | "rawPrediction",
): ForecastAdjustmentMetricSummary {
  let absolute = 0;
  let signed = 0;
  let squared = 0;
  const errors: { value: number; weight: number }[] = [];

  // aggregate the same paired target and weight on each side
  for (const pair of pairs) {
    const target = pair.target;

    // retain the post-filter compiler-proven target
    if (target === null) {
      throw new Error("scored pair lost its target");
    }

    const error = pair[prediction] - target;
    absolute += pair.weight * Math.abs(error);
    signed += pair.weight * error;
    squared += pair.weight * error ** 2;
    errors.push({ value: Math.abs(error), weight: pair.weight });
  }

  return {
    bias: signed,
    mae: absolute,
    p95AbsoluteError: weightedQuantile(errors, 0.95),
    rmse: Math.sqrt(squared),
  };
}

// score paired distributions with zero-safe skill and signed deltas
export function scoreBalancedForecastAdjustmentPairs(
  pairs: readonly ForecastAdjustmentPerformancePair[],
): {
  readonly metrics: ForecastAdjustmentPairedMetricSummary;
  readonly weightedRows: readonly ForecastAdjustmentWeightedPair[];
} {
  const weightedRows = balanceForecastAdjustmentPerformancePairs(pairs);
  const raw = metricSummary(weightedRows, "rawPrediction");
  const adjusted = metricSummary(weightedRows, "adjustedPrediction");

  return {
    metrics: {
      adjusted,
      delta: {
        bias: adjusted.bias - raw.bias,
        mae: adjusted.mae - raw.mae,
        p95AbsoluteError: adjusted.p95AbsoluteError - raw.p95AbsoluteError,
        rmse: adjusted.rmse - raw.rmse,
      },
      raw,
      skill: corePairedSkill(raw.mae, adjusted.mae),
    },
    weightedRows,
  };
}

// score one sampled sequence of local dates under the same nested weights
function sampledDateSkill(
  lossesByDate: ReadonlyMap<
    string,
    { readonly adjustedMae: number; readonly rawMae: number }
  >,
  selectedDates: readonly string[],
): number {
  let raw = 0;
  let adjusted = 0;

  // treat repeated bootstrap date selections as separate equal-mass slots
  for (const localDate of selectedDates) {
    const losses = lossesByDate.get(localDate);

    // retain one precomputed complete date loss
    if (losses === undefined) {
      throw new Error("bootstrap selected a missing date");
    }

    raw += losses.rawMae / selectedDates.length;
    adjusted += losses.adjustedMae / selectedDates.length;
  }

  return corePairedSkill(raw, adjusted);
}

// run the frozen 2,000-replicate seven-date moving-block bootstrap
export function bootstrapBalancedForecastAdjustmentPairs(
  pairs: readonly ForecastAdjustmentPerformancePair[],
): ForecastAdjustmentBootstrapSummary | null {
  const dates = [...new Set(pairs.map((pair) => pair.localDate))].sort();

  // expose explicit insufficient support below the frozen block length
  if (dates.length < 7) {
    return null;
  }

  const lossesByDate = new Map<
    string,
    { readonly adjustedMae: number; readonly rawMae: number }
  >();

  // precompute each date's invariant nested-weight losses once
  for (const localDate of dates) {
    const weighted = balanceForecastAdjustmentPerformancePairs(
      pairs.filter((pair) => pair.localDate === localDate),
    );
    lossesByDate.set(localDate, {
      adjustedMae: metricSummary(weighted, "adjustedPrediction").mae,
      rawMae: metricSummary(weighted, "rawPrediction").mae,
    });
  }

  const plan = createSingleWindowBootstrapStartPlan(dates.length);
  const skills: number[] = [];

  // score the exact frozen start plan without dropping replicates
  for (const starts of plan) {
    const offsets = expandNonCircularBlockStarts(starts, dates.length);
    const selectedDates = offsets.map((offset) => dates[offset]);

    // retain compiler-proven sampled date identities
    if (selectedDates.some((date) => date === undefined)) {
      throw new Error("bootstrap date plan is incomplete");
    }

    skills.push(sampledDateSkill(
      lossesByDate,
      selectedDates as readonly string[],
    ));
  }

  const sorted = skills.sort((left, right) => left - right);
  const lowerSkill = sorted[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
  const upperSkill = sorted[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];

  // retain exact frozen quantile indexes
  if (
    skills.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES ||
    lowerSkill === undefined || upperSkill === undefined
  ) {
    throw new Error("forecast adjustment bootstrap is incomplete");
  }

  return {
    contractVersion: "moving-block-bootstrap/v1",
    lowerSkill,
    replicates: 2_000,
    upperSkill,
  };
}

// classify paired skill without conflating support, qualification or serving
function comparisonState(
  metrics: ForecastAdjustmentPairedMetricSummary | null,
  bootstrap: ForecastAdjustmentBootstrapSummary | null,
): ForecastAdjustmentComparisonState {
  // insufficient support is not a comparison result
  if (metrics === null || bootstrap === null) {
    return "unscored";
  }

  // require interval-wide improvement before calling better
  if (metrics.skill > 0 && bootstrap.lowerSkill > 0) {
    return "better";
  }

  // require interval-wide harm before calling worse
  if (metrics.skill < 0 && bootstrap.upperSkill < 0) {
    return "worse";
  }

  return "mixed";
}

// produce orthogonal honest status fields for one disjoint evidence class
export function evaluateForecastAdjustmentPerformance(
  pairs: readonly ForecastAdjustmentPerformancePair[],
  options: {
    readonly minimumDates: number;
    readonly minimumRows: number;
    readonly servingState: ForecastAdjustmentServingState;
  },
): ForecastAdjustmentPerformanceEvaluation {
  // require explicit existing numeric support contracts
  if (
    !Number.isInteger(options.minimumDates) || options.minimumDates < 7 ||
    !Number.isInteger(options.minimumRows) || options.minimumRows < 1
  ) {
    throw new RangeError("forecast adjustment support contract is invalid");
  }

  const evidenceClasses = new Set(pairs.map((pair) => pair.evidenceClass));

  // reject empty success and mixed evidence before status derivation
  if (pairs.length === 0 || evidenceClasses.size !== 1) {
    throw new RangeError("forecast adjustment evaluation needs one evidence class");
  }

  const evidenceClass = pairs[0]!.evidenceClass;
  const dateCount = new Set(pairs.map((pair) => pair.localDate)).size;
  const sufficient =
    dateCount >= options.minimumDates && pairs.length >= options.minimumRows;
  const scored = scoreBalancedForecastAdjustmentPairs(pairs);
  const metrics = sufficient ? scored.metrics : null;
  const bootstrap = sufficient
    ? bootstrapBalancedForecastAdjustmentPairs(pairs)
    : null;
  const comparison = comparisonState(metrics, bootstrap);
  const provenanceComplete = pairs.every((pair) => pair.provenanceComplete);
  let qualificationState: ForecastAdjustmentQualificationState;

  // classify development bytes without prospective claims
  if (evidenceClass === "development") {
    qualificationState = "development_only";
  // classify historical forecast rows without issuance claims
  } else if (evidenceClass === "retrospective_counterfactual") {
    qualificationState = "counterfactual_only";
  // preserve pending support without relaxing existing thresholds
  } else if (!provenanceComplete || !sufficient || comparison === "mixed" || comparison === "unscored") {
    qualificationState = "pending_support";
  // reject demonstrated harm independently from serving state
  } else if (comparison === "worse") {
    qualificationState = "rejected";
  } else {
    qualificationState = "supported";
  }

  return {
    bootstrap,
    comparisonState: comparison,
    dateCount,
    evidenceClass,
    eventCount: pairs.length,
    metrics,
    qualificationState,
    servingState: options.servingState,
    supportState: sufficient ? "sufficient" : "insufficient",
    weightedRows: scored.weightedRows,
  };
}

// build the existing regional physical-station target without pooling Ecowitt
export function createRegionalPhysicalStationTarget(
  values: readonly ForecastAdjustmentStationTargetValue[],
): ReturnType<typeof scalarNetworkActual> {
  const identities = new Set<ForecastObservationStationKey>();
  const spatial = values.flatMap((value) => {
    // reject repeated physical devices before provider/source aliases can pool
    if (identities.has(value.physicalStationKey)) {
      throw new RangeError("physical station target is duplicated");
    }

    identities.add(value.physicalStationKey);
    const station = FORECAST_OBSERVATION_STATIONS.find(
      (candidate) => candidate.key === value.physicalStationKey,
    );

    // reject unknown physical identities
    if (station === undefined) {
      throw new RangeError("physical station target identity is unknown");
    }

    // keep the on-property sensor as a separately labeled diagnostic
    if (station.key === "ballydidean-ecowitt") {
      return [];
    }

    return [{
      nearestRank: station.nearestRank,
      physicalStationKey: station.key,
      unnormalizedSpatialWeight: station.unnormalizedSpatialWeight,
      value: value.value,
    }];
  });

  return scalarNetworkActual(spatial);
}

// extract the nonpooled on-property diagnostic target
export function createEcowittTargetDiagnostic(
  values: readonly ForecastAdjustmentStationTargetValue[],
): number | null {
  const ecowitt = values.filter(
    (value) => value.physicalStationKey === "ballydidean-ecowitt",
  );

  // reject aliases or duplicate on-property target rows
  if (ecowitt.length > 1) {
    throw new RangeError("Ecowitt target diagnostic is duplicated");
  }

  const value = ecowitt[0]?.value;
  return value !== undefined && Number.isFinite(value) ? value : null;
}

// build the fixed twelve-gauge target while reporting incomplete tiling
export function createFixedRainGaugeTarget(
  values: readonly ForecastAdjustmentRainGaugeValue[],
): ForecastAdjustmentRainGaugeTarget {
  const identities = new Set<number>();
  const available: { readonly id: number; readonly value: number }[] = [];

  // validate every row against the frozen gauge catalog
  for (const row of values) {
    // reject unknown or duplicate physical gauges
    if (!RAIN_GAUGE_IDS.has(row.stationId) || identities.has(row.stationId)) {
      throw new RangeError("rain gauge target identity is invalid or duplicated");
    }

    identities.add(row.stationId);

    // retain explicit gaps without imputing dry values
    if (row.precipitationMm !== null) {
      // reject malformed physical amounts
      if (!Number.isFinite(row.precipitationMm) || row.precipitationMm < 0) {
        throw new RangeError("rain gauge target amount is invalid");
      }

      available.push({ id: row.stationId, value: row.precipitationMm });
    }
  }

  const complete =
    available.length >= 3 &&
    available.some((row) => RAIN_NEAREST_GAUGE_IDS.has(row.id));

  // preserve the incomplete target rather than substituting another source
  if (!complete) {
    return { complete: false, precipitationMm: null, stationCount: available.length };
  }

  const weighted = available.map((row) => {
    const station = RAIN_COLLECTION_STATIONS.find(
      (candidate) => candidate.locationId === row.id,
    );

    // retain the frozen catalog's coordinates
    if (station === undefined) {
      throw new Error("rain gauge coordinate is unavailable");
    }

    const latitude = station.latitude * Math.PI / 180;
    const longitude = station.longitude * Math.PI / 180;
    const siteLatitude = RAIN_COLLECTION_POLICY.latitude * Math.PI / 180;
    const siteLongitude = RAIN_COLLECTION_POLICY.longitude * Math.PI / 180;
    const a = Math.sin((latitude - siteLatitude) / 2) ** 2 +
      Math.cos(latitude) * Math.cos(siteLatitude) *
      Math.sin((longitude - siteLongitude) / 2) ** 2;
    const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(a));
    return { ...row, weight: 1 / (1 + (distance / 2_000) ** 2) };
  });
  const totalWeight = weighted.reduce((sum, row) => sum + row.weight, 0);
  const precipitationMm = weighted.reduce(
    (sum, row) => sum + row.value * row.weight / totalWeight,
    0,
  );

  return { complete: true, precipitationMm, stationCount: available.length };
}

// compute one weighted conditional MAE without inventing empty support
function conditionalMae(
  rows: readonly ForecastAdjustmentWeightedPair[],
  prediction: "adjustedPrediction" | "rawPrediction",
  minimumTarget: number,
): number | null {
  const selected = rows.filter((row) => (row.target ?? Number.NaN) >= minimumTarget);
  const totalWeight = selected.reduce((sum, row) => sum + row.weight, 0);

  // preserve unsupported conditional metrics as null
  if (selected.length === 0 || totalWeight === 0) {
    return null;
  }

  return selected.reduce((sum, row) =>
    sum + row.weight / totalWeight * Math.abs(row[prediction] - row.target!), 0);
}

// compute one weighted volume ratio without a zero-observation division
function volumeRatio(
  rows: readonly ForecastAdjustmentWeightedPair[],
  prediction: "adjustedPrediction" | "rawPrediction",
): number | null {
  const observed = rows.reduce((sum, row) => sum + row.weight * row.target!, 0);

  // retain dry populations as unavailable ratios
  if (observed === 0) {
    return null;
  }

  return rows.reduce((sum, row) => sum + row.weight * row[prediction], 0) /
    observed;
}

// calculate fixed decile calibration without dropping empty bins
function reliabilityBins(
  rows: readonly (ForecastAdjustmentWeightedPair & {
    readonly probability: number;
  })[],
  threshold: number,
): readonly ForecastAdjustmentReliabilityBin[] {
  return Array.from({ length: 10 }, (_unused, index) => {
    const selected = rows.filter((row) =>
      row.probability >= index / 10 &&
      (index === 9 ? row.probability <= 1 : row.probability < (index + 1) / 10));
    const weight = selected.reduce((sum, row) => sum + row.weight, 0);

    // preserve empty bins explicitly
    if (selected.length === 0 || weight === 0) {
      return { count: 0, meanProbability: null, observedFrequency: null };
    }

    return {
      count: selected.length,
      meanProbability: selected.reduce(
        (sum, row) => sum + row.weight / weight * row.probability,
        0,
      ),
      observedFrequency: selected.reduce(
        (sum, row) => sum + row.weight / weight * Number(row.target! >= threshold),
        0,
      ),
    };
  });
}

// score one named binary occurrence head and deterministic event threshold
function rainThresholdSummary(
  rows: readonly (ForecastAdjustmentWeightedPair & {
    readonly probability: ForecastAdjustmentRainProbability;
  })[],
  threshold: 0.1 | 1 | 2.5,
): ForecastAdjustmentRainThresholdSummary {
  const probabilityName = threshold === 0.1
    ? "atLeast0_1"
    : threshold === 1 ? "atLeast1_0" : "atLeast2_5";
  const probabilities = rows.map((row) => ({
    ...row,
    probability: row.probability[probabilityName],
  }));
  let adjustedBrier = 0;
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;

  // keep probability and deterministic amount diagnostics distinct
  for (const row of probabilities) {
    const observed = Number(row.target! >= threshold);
    adjustedBrier += row.weight * (row.probability - observed) ** 2;
    hits += Number(observed === 1 && row.adjustedPrediction >= threshold);
    misses += Number(observed === 1 && row.adjustedPrediction < threshold);
    falseAlarms += Number(observed === 0 && row.adjustedPrediction >= threshold);
  }

  return {
    adjustedBrier,
    csi: hits + misses + falseAlarms === 0
      ? null : hits / (hits + misses + falseAlarms),
    falseAlarms,
    far: hits + falseAlarms === 0 ? null : falseAlarms / (hits + falseAlarms),
    hits,
    misses,
    pod: hits + misses === 0 ? null : hits / (hits + misses),
    rawBrier: null,
    reliability: reliabilityBins(probabilities, threshold),
    thresholdMmPerHour: threshold,
  };
}

// score complete consecutive same-run accumulation windows
function rainAccumulationSummary(
  rows: readonly ForecastAdjustmentWeightedPair[],
  runKeys: ReadonlyMap<string, string>,
  hours: 6 | 12 | 23,
): ForecastAdjustmentRainAccumulationSummary {
  const byRun = new Map<string, ForecastAdjustmentWeightedPair[]>();

  // partition adjusted hours without crossing model initializations
  for (const row of rows) {
    const runKey = runKeys.get(row.key);

    // retain compiler-proven rain run identity
    if (runKey === undefined) {
      throw new Error("rain performance row lost its run identity");
    }

    const runRows = byRun.get(runKey) ?? [];
    runRows.push(row);
    byRun.set(runKey, runRows);
  }

  const rawErrors: number[] = [];
  const adjustedErrors: number[] = [];

  // scan each run for complete exact-hour windows
  for (const runRows of byRun.values()) {
    const sorted = [...runRows].sort((left, right) =>
      left.validAt.localeCompare(right.validAt));

    // retain every complete sliding accumulation window
    for (let start = 0; start + hours <= sorted.length; start += 1) {
      const window = sorted.slice(start, start + hours);
      const first = instant(window[0]!.validAt, "validAt");
      const complete = window.every((row, index) =>
        instant(row.validAt, "validAt") === first + index * 3_600_000);

      // exclude incomplete or cross-gap accumulation tiling
      if (!complete) {
        continue;
      }

      const target = window.reduce((sum, row) => sum + row.target!, 0);
      const raw = window.reduce((sum, row) => sum + row.rawPrediction, 0);
      const adjusted = window.reduce(
        (sum, row) => sum + row.adjustedPrediction,
        0,
      );
      rawErrors.push(Math.abs(raw - target));
      adjustedErrors.push(Math.abs(adjusted - target));
    }
  }

  return {
    adjustedMae: adjustedErrors.length === 0
      ? null
      : adjustedErrors.reduce((sum, value) => sum + value, 0) /
        adjustedErrors.length,
    completeWindows: adjustedErrors.length,
    hours,
    rawMae: rawErrors.length === 0
      ? null
      : rawErrors.reduce((sum, value) => sum + value, 0) / rawErrors.length,
  };
}

// score only parity-proven fixed-gauge rain rows
export function evaluateForecastAdjustmentRainDiagnostics(
  pairs: readonly ForecastAdjustmentRainPerformancePair[],
): ForecastAdjustmentRainDiagnostics {
  // stop probability claims unless every amount/applied/reason replay matched
  if (pairs.some((pair) => !pair.amountParity)) {
    throw new RangeError("rain probability diagnostics require amount parity");
  }

  // report incomplete fixed-gauge tiling instead of imputing target rows
  const complete = pairs.filter((pair) => pair.targetTilingComplete);
  const prepared = prepareForecastAdjustmentPerformancePairs(complete);
  const weighted = balanceForecastAdjustmentPerformancePairs(prepared.rows);
  const probabilityByKey = new Map(
    complete.map((pair) => [pair.key, pair.adjustedProbability]),
  );
  const runKeys = new Map(complete.map((pair) => [pair.key, pair.runKey]));
  const rainRows = weighted.map((row) => {
    const probability = probabilityByKey.get(row.key);

    // require exactly the three named binary probabilities
    if (
      probability === undefined ||
      Object.values(probability).some((value) =>
        !Number.isFinite(value) || value < 0 || value > 1)
    ) {
      throw new RangeError("rain occurrence probability is invalid");
    }

    return { ...row, probability };
  });
  const winter = rainRows.filter((row) =>
    localCalendarFeaturesFor(row.validAt).season === "winter");

  return {
    accumulations: ([6, 12, 23] as const).map((hours) =>
      rainAccumulationSummary(rainRows, runKeys, hours)),
    annualBalancedVolumeRatio: volumeRatio(rainRows, "adjustedPrediction"),
    heavyAdjustedMae: conditionalMae(rainRows, "adjustedPrediction", 2.5),
    heavyRawMae: conditionalMae(rainRows, "rawPrediction", 2.5),
    probabilityOrderViolationCount: rainRows.filter((row) =>
      row.probability.atLeast0_1 < row.probability.atLeast1_0 ||
      row.probability.atLeast1_0 < row.probability.atLeast2_5).length,
    thresholds: RAIN_THRESHOLDS.map((threshold) =>
      rainThresholdSummary(rainRows, threshold)),
    wetAdjustedMae: conditionalMae(rainRows, "adjustedPrediction", 0.1),
    wetRawMae: conditionalMae(rainRows, "rawPrediction", 0.1),
    winterBalancedVolumeRatio: winter.length === 0
      ? null : volumeRatio(balanceForecastAdjustmentPerformancePairs(winter), "adjustedPrediction"),
  };
}
