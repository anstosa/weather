import { FORECAST_OBSERVATION_PROVIDER_FAMILIES } from "@weather/domain";

import { corePairedSkill } from "./algorithm-v1.js";
import {
  MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX,
  MOVING_BLOCK_BOOTSTRAP_REPLICATES,
  MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX,
  createMovingBlockBootstrapStartPlan,
  createSingleWindowBootstrapStartPlan,
  expandNonCircularBlockStarts,
} from "./bootstrap-v1.js";
import { canonicalObjectSha256, deepFreeze } from "./candidate.js";
import {
  localCalendarFeaturesFor,
  type LocalDaypart,
  type LocalMeteorologicalSeason,
} from "./calendar.js";
import { FORECAST_ADJUSTMENT_WIND_MAINTENANCE_METRIC_BANDS } from "./runtime-loader.js";

export const TEMPERATURE_MAINTENANCE_POLICY_VERSION =
  "temperature-maintenance-policy/v2" as const;
export const WIND_MAINTENANCE_POLICY_VERSION =
  "wind-maintenance-policy/v2" as const;
export const RAIN_MAINTENANCE_POLICY_VERSION =
  "rain-maintenance-policy/v2" as const;
export const MAINTENANCE_POLICY_REPORT_EXPIRY_MILLISECONDS =
  7 * 24 * 60 * 60 * 1_000;
export const MAINTENANCE_EVALUATION_ROW_VERSION =
  "maintenance-evaluation-row/v1" as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TEMPERATURE_HORIZONS = ["1-6", "7-12"] as const;
const RAIN_LEAD_BANDS = ["1-6", "7-12", "13-23"] as const;
const SEASONS = ["winter", "spring", "summer", "autumn"] as const;
const RAIN_SEASONS = ["DJF", "MAM", "JJA", "SON"] as const;
const DAYPARTS = ["night", "morning", "afternoon", "evening"] as const;
const RAIN_THRESHOLDS = [0.1, 1, 2.5] as const;
const RAIN_ACCUMULATION_HOURS = [6, 12, 23] as const;
const BASE_ROW_KEYS = [
  "actualBestMatchPrediction",
  "applied",
  "candidatePrediction",
  "contractVersion",
  "evidenceClass",
  "family",
  "farmTarget",
  "firstEdgeCommittedAt",
  "horizonHours",
  "incumbentPrediction",
  "key",
  "localDate",
  "nativeSourcePrediction",
  "nearestThree",
  "pairKey",
  "provenanceComplete",
  "providerFamily",
  "rowSha256",
  "sourceReceiptAt",
  "sourceRowSha256",
  "stationKey",
  "target",
  "targetRowSha256",
  "validAt",
] as const;
const RAIN_ROW_KEYS = [
  ...BASE_ROW_KEYS,
  "candidateProbability",
  "incumbentProbability",
  "nativeSourceProbability",
  "persistencePrediction",
  "rawTargetHourTemperatureC",
  "recentVolumeScalePrediction",
  "runKey",
  "sameWindowVolumeScalePrediction",
  "unchangedOrdinalPrediction",
  "volumeScalePrediction",
] as const;

export const WIND_MAINTENANCE_PAIR_KEYS = deepFreeze(
  FORECAST_ADJUSTMENT_WIND_MAINTENANCE_METRIC_BANDS.map(
    (pair) => `${pair.metric}:${pair.leadBand}`,
  ),
);

export const RAIN_ORIGINAL_STABLE_GATE_IDS = deepFreeze([
  "maeImprovesFivePercent",
  "beatsVolumeScale",
  "beatsPersistence",
  "rmseNoWorse",
  "wetIntensityNoWorse",
  "heavyIntensityBounded",
  "annualVolumeBalanced",
  "overallSupport",
  "allSeasonsPresent",
  "allLeadBandsPresent",
  "rawHeavyAmountsUnchanged",
  "rawWetCallsPreserved",
  "event0.1Safety",
  "event1.0Safety",
  "event2.5Safety",
  "seasonDJFSupport",
  "seasonDJFVolume",
  "seasonDJFMae",
  "seasonDJFWetHeavy",
  "seasonDJFDetection",
  "seasonMAMSupport",
  "seasonMAMVolume",
  "seasonMAMMae",
  "seasonMAMWetHeavy",
  "seasonMAMDetection",
  "seasonJJASupport",
  "seasonJJAVolume",
  "seasonJJAMae",
  "seasonJJAWetHeavy",
  "seasonJJADetection",
  "seasonSONSupport",
  "seasonSONVolume",
  "seasonSONMae",
  "seasonSONWetHeavy",
  "seasonSONDetection",
  "lead1-6Mae",
  "lead1-6Support",
  "lead7-12Mae",
  "lead7-12Support",
  "lead13-23Mae",
  "lead13-23Support",
  "accumulation6Mae",
  "accumulation12Mae",
  "accumulation23Mae",
  "beatsSameWindowVolumeScale",
  "beatsRecentVolumeScale",
  "beatsUnchangedOrdinal",
  "seasonalBalanceImproves",
  "heavySkillRetained",
] as const);

export type MaintenancePolicyState = "fail" | "pass" | "pending";
export type MaintenanceEvidenceClass =
  | "historical_development"
  | "prospective_receipt";
export type MaintenanceFamily = "rain" | "temperature" | "wind";
export type MaintenancePredictionField =
  | "actualBestMatchPrediction"
  | "candidatePrediction"
  | "incumbentPrediction"
  | "nativeSourcePrediction";

// bind one immutable same-hour comparison row
export interface MaintenanceEvaluationRowInput {
  readonly actualBestMatchPrediction: number;
  readonly applied: boolean;
  readonly candidatePrediction: number;
  readonly evidenceClass: MaintenanceEvidenceClass;
  readonly family: MaintenanceFamily;
  readonly farmTarget: number | null;
  readonly firstEdgeCommittedAt: string | null;
  readonly horizonHours: number;
  readonly incumbentPrediction: number;
  readonly key: string;
  readonly localDate: string;
  readonly nativeSourcePrediction: number;
  readonly nearestThree: boolean | null;
  readonly pairKey: string | null;
  readonly providerFamily: string | null;
  readonly provenanceComplete: boolean;
  readonly sourceRowSha256: string;
  readonly sourceReceiptAt: string | null;
  readonly stationKey: string | null;
  readonly target: number;
  readonly targetRowSha256: string;
  readonly validAt: string;
}

// retain the computed content identity beside one evaluation row
export interface MaintenanceEvaluationRow extends MaintenanceEvaluationRowInput {
  readonly contractVersion: typeof MAINTENANCE_EVALUATION_ROW_VERSION;
  readonly rowSha256: string;
}

// extend one rain row with fixed controls and probabilities
export interface RainMaintenanceEvaluationRowInput
  extends Omit<MaintenanceEvaluationRowInput, "family" | "pairKey"> {
  readonly candidateProbability: RainMaintenanceProbability;
  readonly incumbentProbability: RainMaintenanceProbability;
  readonly nativeSourceProbability: RainMaintenanceProbability;
  readonly rawTargetHourTemperatureC: number | null;
  readonly recentVolumeScalePrediction: number;
  readonly runKey: string;
  readonly sameWindowVolumeScalePrediction: number;
  readonly unchangedOrdinalPrediction: number;
  readonly volumeScalePrediction: number;
  readonly persistencePrediction: number;
}

// retain one immutable rain comparison row
export interface RainMaintenanceEvaluationRow
  extends RainMaintenanceEvaluationRowInput {
  readonly contractVersion: typeof MAINTENANCE_EVALUATION_ROW_VERSION;
  readonly family: "rain";
  readonly pairKey: null;
  readonly rowSha256: string;
}

// retain three named occurrence probabilities
export interface RainMaintenanceProbability {
  readonly atLeast0_1: number;
  readonly atLeast1_0: number;
  readonly atLeast2_5: number;
}

// report one date-balanced paired comparison
export interface MaintenancePairedComparison {
  readonly candidateMae: number;
  readonly comparator: MaintenancePredictionField;
  readonly comparatorMae: number;
  readonly difference: number;
  readonly differenceLower: number;
  readonly differenceUpper: number;
  readonly eventCount: number;
  readonly lowerSkill: number;
  readonly replicates: 2_000;
  readonly skill: number;
  readonly upperSkill: number;
}

// report one explicit policy gate
export interface MaintenancePolicyGate {
  readonly actual: number | string | null;
  readonly criterion: string;
  readonly id: string;
  readonly state: MaintenancePolicyState;
}

// report action-bearing metrics and nonacting diagnostics separately
export interface MaintenancePopulationReport {
  readonly actualBestMatchAllRows: MaintenancePairedComparison | null;
  readonly actualBestMatchAppliedOnly: MaintenancePairedComparison | null;
  readonly farmDiagnosticMae: number | null;
  readonly incumbent: MaintenancePairedComparison | null;
  readonly nativeSource: MaintenancePairedComparison | null;
  readonly populationSha256: string;
}

// report one promotion or regression policy decision
export interface MaintenancePolicyEvaluation {
  readonly action: "promote" | "regress" | "retain" | "pending";
  readonly contractVersion:
    | typeof TEMPERATURE_MAINTENANCE_POLICY_VERSION
    | typeof WIND_MAINTENANCE_POLICY_VERSION
    | typeof RAIN_MAINTENANCE_POLICY_VERSION;
  readonly gates: readonly MaintenancePolicyGate[];
  readonly mode: "promotion" | "regression";
  readonly population: MaintenancePopulationReport;
  readonly state: MaintenancePolicyState;
}

// report a nonactionable original-gate development screen
export interface RainMaintenanceDevelopmentEvaluation {
  readonly contractVersion: typeof RAIN_MAINTENANCE_POLICY_VERSION;
  readonly developmentRows: 32_896;
  readonly gates: readonly MaintenancePolicyGate[];
  readonly passed: boolean;
  readonly populationSha256: string;
  readonly productionEligible: false;
  readonly state: MaintenancePolicyState;
}

// report one prospective regression epoch boundary
export interface MaintenanceRegressionEpoch {
  readonly epochEndExclusive: string;
  readonly epochStartInclusive: string;
  readonly evaluatedAt: string;
  readonly registeredAt: string;
}

// test one qualification receipt against the exact seven-day expiry
export function maintenancePolicyReportIsFresh(
  createdAt: string,
  releaseStartedAt: string,
): boolean {
  const created = Date.parse(createdAt);
  const releaseStarted = Date.parse(releaseStartedAt);

  // reject malformed, backdated, and expired release starts
  return Number.isFinite(created) &&
    Number.isFinite(releaseStarted) &&
    releaseStarted >= created &&
    releaseStarted < created + MAINTENANCE_POLICY_REPORT_EXPIRY_MILLISECONDS;
}

// create one content-addressed evaluation row
export function createMaintenanceEvaluationRow(
  input: MaintenanceEvaluationRowInput,
): MaintenanceEvaluationRow {
  requireExactKeys(input, BASE_ROW_KEYS.filter((key) =>
    key !== "contractVersion" && key !== "rowSha256"), "maintenance row input");
  const row = {
    ...input,
    contractVersion: MAINTENANCE_EVALUATION_ROW_VERSION,
    rowSha256: "",
  };
  validateMaintenanceRowShape(row);
  return deepFreeze({
    ...input,
    contractVersion: MAINTENANCE_EVALUATION_ROW_VERSION,
    rowSha256: canonicalObjectSha256(row, "rowSha256"),
  });
}

// create one content-addressed rain evaluation row
export function createRainMaintenanceEvaluationRow(
  input: RainMaintenanceEvaluationRowInput,
): RainMaintenanceEvaluationRow {
  requireExactKeys(input, RAIN_ROW_KEYS.filter((key) =>
    key !== "contractVersion" &&
    key !== "family" &&
    key !== "pairKey" &&
    key !== "rowSha256"), "rain maintenance row input");
  const row = {
    ...input,
    contractVersion: MAINTENANCE_EVALUATION_ROW_VERSION,
    family: "rain" as const,
    pairKey: null,
    rowSha256: "",
  };
  validateRainMaintenanceRowShape(row);
  return deepFreeze({
    ...row,
    rowSha256: canonicalObjectSha256(row, "rowSha256"),
  });
}

// evaluate the complete temperature promotion contract
export function evaluateTemperatureMaintenancePromotion(
  rows: readonly MaintenanceEvaluationRow[],
): MaintenancePolicyEvaluation {
  validatePopulation(rows, "temperature");
  const gates = baseEvidenceGates(rows);
  // require the complete temperature support matrix
  for (const [id, selected] of temperatureSupportSlices(rows)) {
    gates.push(supportGate(id, selected, 60, 1_000));
  }

  const population = populationReport(rows);
  gates.push(comparisonSkillGate("incumbent_skill", population.incumbent, 0.02));
  gates.push(comparisonSkillGate("native_source_skill", population.nativeSource, 0.02));
  gates.push(comparisonDifferenceGate(
    "actual_best_match_margin",
    population.actualBestMatchAllRows,
    0.10,
  ));

  // prevent aggregate wins from hiding any critical slice
  for (const [id, selected] of temperatureSupportSlices(rows).slice(1)) {
    gates.push(nonharmGate(`${id}_nonharm`, selected, 0.10));
  }

  return finalizePolicy(
    TEMPERATURE_MAINTENANCE_POLICY_VERSION,
    "promotion",
    population,
    gates,
  );
}

// evaluate one complete registered temperature season
export function evaluateTemperatureMaintenanceRegression(
  rows: readonly MaintenanceEvaluationRow[],
  epoch: MaintenanceRegressionEpoch,
): MaintenancePolicyEvaluation {
  validatePopulation(rows, "temperature");
  const gates = [
    ...baseEvidenceGates(rows),
    epochGate(epoch),
    supportGate("overall_support", rows, 60, 1_000),
  ];
  const population = populationReport(rows);
  gates.push(regressionSkillGate("active_native_source_harm", population.nativeSource));
  gates.push(regressionDifferenceGate(
    "active_best_match_harm",
    population.actualBestMatchAllRows,
    0.10,
  ));
  return finalizePolicy(
    TEMPERATURE_MAINTENANCE_POLICY_VERSION,
    "regression",
    population,
    gates,
  );
}

// evaluate the exact thirteen-pair wind promotion contract
export function evaluateWindMaintenancePromotion(
  rows: readonly MaintenanceEvaluationRow[],
): MaintenancePolicyEvaluation {
  validatePopulation(rows, "wind");
  validateWindPairSet(rows);
  const gates = baseEvidenceGates(rows);

  // require support and promotion success in every enabled pair
  for (const pairKey of WIND_MAINTENANCE_PAIR_KEYS) {
    const selected = rows.filter((row) => row.pairKey === pairKey);
    gates.push(supportGate(`pair:${pairKey}:support`, selected, 60, 100));
    const report = populationReport(selected);
    gates.push(comparisonSkillGate(`pair:${pairKey}:incumbent`, report.incumbent, 0.02));
    gates.push(comparisonSkillGate(`pair:${pairKey}:native_source`, report.nativeSource, 0.02));
    gates.push(comparisonDifferenceGate(
      `pair:${pairKey}:actual_best_match`,
      report.actualBestMatchAllRows,
      0.10,
    ));
  }

  // require full support in every season present in the member
  for (const season of SEASONS) {
    const selected = rows.filter((row) =>
      localCalendarFeaturesFor(row.validAt).season === season);
    gates.push(supportGate(`season:${season}:support`, selected, 60, 100));
  }

  // veto material harm in every supported prespecified slice
  for (const [sliceKey, selected] of windHarmSlices(rows)) {
    if (selected.length >= 100) {
      const comparison = pairedComparison(selected, "nativeSourcePrediction");
      const harmed = comparison.skill <= -0.02 && comparison.upperSkill < 0;
      gates.push(booleanGate(
        `slice:${sliceKey}:no_material_harm`,
        !harmed,
        `${comparison.skill}:${comparison.upperSkill}`,
        "skill > -0.02 or upper skill >= 0",
      ));
    }
  }

  return finalizePolicy(
    WIND_MAINTENANCE_POLICY_VERSION,
    "promotion",
    populationReport(rows),
    gates,
  );
}

// evaluate one registered wind regression season
export function evaluateWindMaintenanceRegression(
  rows: readonly MaintenanceEvaluationRow[],
  epoch: MaintenanceRegressionEpoch,
): MaintenancePolicyEvaluation {
  validatePopulation(rows, "wind");
  validateWindPairSet(rows);
  const gates = [...baseEvidenceGates(rows), epochGate(epoch)];

  // require every enabled pair before equal-pair aggregation
  for (const pairKey of WIND_MAINTENANCE_PAIR_KEYS) {
    gates.push(supportGate(
      `pair:${pairKey}:support`,
      rows.filter((row) => row.pairKey === pairKey),
      60,
      100,
    ));
  }

  const nativeSource = equalGroupComparison(
    rows,
    WIND_MAINTENANCE_PAIR_KEYS,
    "nativeSourcePrediction",
  );
  const actualBestMatch = equalGroupComparison(
    rows,
    WIND_MAINTENANCE_PAIR_KEYS,
    "actualBestMatchPrediction",
  );
  gates.push(regressionSkillGate("equal_pair_native_source_harm", nativeSource));
  gates.push(regressionDifferenceGate(
    "equal_pair_actual_best_match_harm",
    actualBestMatch,
    0.10,
  ));

  return finalizePolicy(
    WIND_MAINTENANCE_POLICY_VERSION,
    "regression",
    populationReport(rows),
    gates,
  );
}

// evaluate the rain promotion contract and all stable gates
export function evaluateRainMaintenancePromotion(
  rows: readonly RainMaintenanceEvaluationRow[],
): MaintenancePolicyEvaluation {
  validateRainPopulation(rows);
  const baseRows: readonly MaintenanceEvaluationRow[] = rows;
  const gates = baseEvidenceGates(baseRows);
  const population = populationReport(baseRows);
  gates.push(comparisonSkillGate("incumbent_skill", population.incumbent, 0.02));
  gates.push(...rainStableGates(rows));
  gates.push(comparisonDifferenceGate(
    "actual_best_match_overall",
    population.actualBestMatchAllRows,
    0,
  ));

  // keep every season and lead within five percent of same-hour Best Match
  for (const [id, selected] of rainBestMatchSlices(rows)) {
    const comparison = comparisonOrNull(
      selected,
      "actualBestMatchPrediction",
    );

    // keep unsupported slices pending instead of passing null metrics
    if (comparison === null) {
      gates.push(pendingGate(
        `${id}:actual_best_match_nonharm`,
        "candidate mae <= actual Best Match mae * 1.05",
      ));
      continue;
    }

    const passing = comparison.candidateMae <= comparison.comparatorMae * 1.05;
    gates.push(booleanGate(
      `${id}:actual_best_match_nonharm`,
      passing,
      comparison.candidateMae - comparison.comparatorMae,
      "candidate mae <= actual Best Match mae * 1.05",
    ));
  }

  gates.push(rainBrierGate(rows));
  gates.push(rainNestingGate(rows));
  gates.push(rainCoherenceGate(rows));
  return finalizePolicy(
    RAIN_MAINTENANCE_POLICY_VERSION,
    "promotion",
    population,
    gates,
  );
}

// evaluate the frozen rain development population without promotion authority
export function evaluateRainMaintenanceDevelopment(
  rows: readonly RainMaintenanceEvaluationRow[],
): RainMaintenanceDevelopmentEvaluation {
  validateRainPopulation(rows);

  // forbid prospective receipts from being relabelled as development evidence
  if (!rows.every((row) => row.evidenceClass === "historical_development")) {
    throw new RangeError("rain development evaluation requires historical rows");
  }

  const gates = rainStableGates(rows);
  const state: MaintenancePolicyState = gates.some((gate) => gate.state === "fail")
    ? "fail"
    : gates.some((gate) => gate.state === "pending") ? "pending" : "pass";
  return deepFreeze({
    contractVersion: RAIN_MAINTENANCE_POLICY_VERSION,
    developmentRows: 32_896 as const,
    gates,
    passed: state === "pass",
    populationSha256: canonicalObjectSha256(
      { rows: rows.map((row) => row.rowSha256), populationSha256: "" },
      "populationSha256",
    ),
    productionEligible: false as const,
    state,
  });
}

// evaluate the one authorized rain regression member
export function evaluateRainMaintenanceRegression(
  rows: readonly RainMaintenanceEvaluationRow[],
  epoch: MaintenanceRegressionEpoch,
): MaintenancePolicyEvaluation {
  validateRainPopulation(rows);
  const baseRows: readonly MaintenanceEvaluationRow[] = rows;
  const gates = [
    ...baseEvidenceGates(baseRows),
    epochGate(epoch),
    booleanGate(
      "authorized_epoch",
      epoch.epochStartInclusive.slice(0, 10) === "2026-10-31" &&
        epoch.epochEndExclusive.slice(0, 10) === "2027-09-30" &&
        rows.every((row) =>
          row.localDate >= "2026-10-31" && row.localDate <= "2027-09-29"),
      `${epoch.epochStartInclusive}/${epoch.epochEndExclusive}`,
      "exact authorized 2026-10-31..2027-09-29 member",
    ),
    ...rainStableGates(rows),
  ];
  const population = populationReport(baseRows);
  gates.push(rainRegressionComparisonGate(
    "active_native_source_harm",
    population.nativeSource,
  ));
  gates.push(rainRegressionComparisonGate(
    "active_actual_best_match_harm",
    population.actualBestMatchAllRows,
  ));
  return finalizePolicy(
    RAIN_MAINTENANCE_POLICY_VERSION,
    "regression",
    population,
    gates,
  );
}

// verify one immutable base row and its hash
function validateMaintenanceRowShape(row: MaintenanceEvaluationRow): void {
  const calendar = localCalendarFeaturesFor(row.validAt);
  const numeric = [
    row.actualBestMatchPrediction,
    row.candidatePrediction,
    row.incumbentPrediction,
    row.nativeSourcePrediction,
    row.target,
  ];

  const validAt = Date.parse(row.validAt);
  const sourceReceiptAt = row.sourceReceiptAt === null
    ? null : Date.parse(row.sourceReceiptAt);
  const firstEdgeCommittedAt = row.firstEdgeCommittedAt === null
    ? null : Date.parse(row.firstEdgeCommittedAt);

  // reject malformed identities, dates, values, and provenance hashes
  if (
    row.contractVersion !== MAINTENANCE_EVALUATION_ROW_VERSION ||
    row.key.length === 0 ||
    calendar.localDate !== row.localDate ||
    !Number.isInteger(row.horizonHours) ||
    row.horizonHours < 1 ||
    row.horizonHours > 168 ||
    numeric.some((value) => !Number.isFinite(value)) ||
    (row.farmTarget !== null && !Number.isFinite(row.farmTarget)) ||
    (row.providerFamily !== null &&
      !FORECAST_OBSERVATION_PROVIDER_FAMILIES.some((provider) =>
        provider === row.providerFamily)) ||
    !HASH_PATTERN.test(row.sourceRowSha256) ||
    !HASH_PATTERN.test(row.targetRowSha256)
  ) {
    throw new RangeError("maintenance evaluation row is invalid");
  }

  const prospectiveChronology =
    sourceReceiptAt !== null &&
    firstEdgeCommittedAt !== null &&
    Number.isFinite(sourceReceiptAt) &&
    Number.isFinite(firstEdgeCommittedAt) &&
    sourceReceiptAt <= firstEdgeCommittedAt &&
    firstEdgeCommittedAt < validAt;

  // prevent historical reads from being relabelled as fresh receipts
  if (
    (row.evidenceClass === "prospective_receipt" && !prospectiveChronology) ||
    (row.evidenceClass === "historical_development" &&
      (row.sourceReceiptAt !== null || row.firstEdgeCommittedAt !== null))
  ) {
    throw new RangeError("maintenance evidence chronology is invalid");
  }

  // verify an assigned row digest without accepting caller assertions
  if (
    row.rowSha256.length > 0 &&
    canonicalObjectSha256(
      row as unknown as Readonly<Record<string, unknown>>,
      "rowSha256",
    ) !== row.rowSha256
  ) {
    throw new RangeError("maintenance evaluation row hash is invalid");
  }
}

// verify one rain row and its closed numerical fields
function validateRainMaintenanceRowShape(
  row: RainMaintenanceEvaluationRow,
): void {
  validateMaintenanceRowShape(row);
  const controls = [
    row.persistencePrediction,
    row.recentVolumeScalePrediction,
    row.sameWindowVolumeScalePrediction,
    row.unchangedOrdinalPrediction,
    row.volumeScalePrediction,
  ];

  // reject invalid controls, probabilities, and cold phase rows
  if (
    row.runKey.length === 0 ||
    controls.some((value) => !Number.isFinite(value) || value < 0) ||
    !validRainProbability(row.candidateProbability) ||
    !validRainProbability(row.incumbentProbability) ||
    !validRainProbability(row.nativeSourceProbability) ||
    row.rawTargetHourTemperatureC === null ||
    !Number.isFinite(row.rawTargetHourTemperatureC) ||
    row.rawTargetHourTemperatureC <= 2
  ) {
    throw new RangeError("rain maintenance evaluation row is invalid");
  }
}

// validate one three-head probability record
function validRainProbability(probability: RainMaintenanceProbability): boolean {
  return Object.keys(probability).join(",") ===
    "atLeast0_1,atLeast1_0,atLeast2_5" &&
    Object.values(probability).every((value) =>
      Number.isFinite(value) && value >= 0 && value <= 1);
}

// validate one complete hash-bound family population
function validatePopulation(
  rows: readonly MaintenanceEvaluationRow[],
  family: MaintenanceFamily,
): void {
  // reject empty and cross-family evaluation inputs
  if (rows.length === 0 || rows.some((row) => row.family !== family)) {
    throw new RangeError("maintenance population has the wrong family");
  }

  const keys = new Set<string>();
  const evidenceClasses = new Set(rows.map((row) => row.evidenceClass));

  // prohibit pooling prospective receipts with historical development rows
  if (evidenceClasses.size !== 1) {
    throw new RangeError("maintenance evidence classes cannot be pooled");
  }

  // verify every row and preserve the identical key population
  for (const row of rows) {
    requireExactKeys(
      row,
      family === "rain" ? RAIN_ROW_KEYS : BASE_ROW_KEYS,
      "maintenance evaluation row",
    );
    validateMaintenanceRowShape(row);

    // reject duplicate same-hour comparison identities
    if (keys.has(row.key)) {
      throw new RangeError("maintenance population key is duplicated");
    }

    keys.add(row.key);
  }
}

// validate one rain-only population
function validateRainPopulation(
  rows: readonly RainMaintenanceEvaluationRow[],
): void {
  validatePopulation(rows, "rain");

  // verify every extended row after base population checks
  for (const row of rows) {
    validateRainMaintenanceRowShape(row);
  }

  const historical = rows.every((row) =>
    row.evidenceClass === "historical_development");

  // preserve the frozen development population without calling it fresh
  if (historical && rows.length !== 32_896) {
    throw new RangeError("rain historical development population must contain 32896 rows");
  }
}

// derive provenance and prospective-use gates
function baseEvidenceGates(
  rows: readonly MaintenanceEvaluationRow[],
): MaintenancePolicyGate[] {
  const prospective = rows.every((row) =>
    row.evidenceClass === "prospective_receipt");
  const provenance = rows.every((row) => row.provenanceComplete);
  return [
    booleanGate(
      "prospective_evidence",
      prospective,
      prospective ? "prospective_receipt" : "historical_development",
      "all rows are prospective receipts",
      prospective ? "pass" : "pending",
    ),
    booleanGate(
      "complete_provenance",
      provenance,
      provenance ? "complete" : "incomplete",
      "all source and target provenance is complete",
      provenance ? "pass" : "pending",
    ),
  ];
}

// enumerate the acting temperature support slices
function temperatureSupportSlices(
  rows: readonly MaintenanceEvaluationRow[],
): readonly (readonly [string, readonly MaintenanceEvaluationRow[]])[] {
  const slices: [string, readonly MaintenanceEvaluationRow[]][] = [
    ["overall_support", rows],
  ];

  // append both operational horizon slices
  for (const horizon of TEMPERATURE_HORIZONS) {
    slices.push([
      `horizon:${horizon}:support`,
      rows.filter((row) => temperatureHorizon(row) === horizon),
    ]);
  }

  // append every meteorological season
  for (const season of SEASONS) {
    slices.push([
      `season:${season}:support`,
      rows.filter((row) => localCalendarFeaturesFor(row.validAt).season === season),
    ]);
  }

  // append every local six-hour daypart
  for (const daypart of DAYPARTS) {
    slices.push([
      `daypart:${daypart}:support`,
      rows.filter((row) => localCalendarFeaturesFor(row.validAt).daypart === daypart),
    ]);
  }

  return slices;
}

// classify one temperature operational horizon
function temperatureHorizon(
  row: MaintenanceEvaluationRow,
): (typeof TEMPERATURE_HORIZONS)[number] | null {
  return row.horizonHours >= 1 && row.horizonHours <= 6
    ? "1-6"
    : row.horizonHours >= 7 && row.horizonHours <= 12 ? "7-12" : null;
}

// create one explicit support gate
function supportGate(
  id: string,
  rows: readonly MaintenanceEvaluationRow[],
  minimumDates: number,
  minimumRows: number,
): MaintenancePolicyGate {
  const dateCount = new Set(rows.map((row) => row.localDate)).size;
  const passing = dateCount >= minimumDates && rows.length >= minimumRows;
  return booleanGate(
    id,
    passing,
    `${dateCount}/${rows.length}`,
    `dates >= ${minimumDates} and rows >= ${minimumRows}`,
    passing ? "pass" : "pending",
  );
}

// calculate one date-balanced paired bootstrap comparison
function pairedComparison(
  rows: readonly MaintenanceEvaluationRow[],
  comparator: MaintenancePredictionField,
): MaintenancePairedComparison {
  const dates = [...new Set(rows.map((row) => row.localDate))].sort();

  // require enough dates for the frozen seven-day block
  if (dates.length < 7) {
    throw new RangeError("maintenance bootstrap requires seven dates");
  }

  const byDate = new Map<string, { candidate: number; comparator: number }>();

  // reduce each date to equal-mass paired losses
  for (const localDate of dates) {
    const selected = rows.filter((row) => row.localDate === localDate);
    const candidate = selected.reduce((sum, row) =>
      sum + Math.abs(row.candidatePrediction - row.target), 0) / selected.length;
    const baseline = selected.reduce((sum, row) =>
      sum + Math.abs(row[comparator] - row.target), 0) / selected.length;
    byDate.set(localDate, { candidate, comparator: baseline });
  }

  const candidateMae = dates.reduce((sum, date) =>
    sum + byDate.get(date)!.candidate / dates.length, 0);
  const comparatorMae = dates.reduce((sum, date) =>
    sum + byDate.get(date)!.comparator / dates.length, 0);
  const skillReplicates: number[] = [];
  const differenceReplicates: number[] = [];

  // apply the exact frozen block-start plan
  for (const starts of createSingleWindowBootstrapStartPlan(dates.length)) {
    const selectedDates = expandNonCircularBlockStarts(starts, dates.length)
      .map((offset) => dates[offset]!);
    const sampledCandidate = selectedDates.reduce((sum, date) =>
      sum + byDate.get(date)!.candidate / selectedDates.length, 0);
    const sampledComparator = selectedDates.reduce((sum, date) =>
      sum + byDate.get(date)!.comparator / selectedDates.length, 0);
    skillReplicates.push(corePairedSkill(sampledComparator, sampledCandidate));
    differenceReplicates.push(sampledCandidate - sampledComparator);
  }

  const sortedSkills = skillReplicates.sort((left, right) => left - right);
  const sortedDifferences = differenceReplicates.sort((left, right) => left - right);
  const lowerSkill = sortedSkills[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
  const upperSkill = sortedSkills[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];
  const differenceLower = sortedDifferences[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
  const differenceUpper = sortedDifferences[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];

  // retain every one of the frozen two thousand replicates
  if (
    sortedSkills.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES ||
    lowerSkill === undefined ||
    upperSkill === undefined ||
    differenceLower === undefined ||
    differenceUpper === undefined
  ) {
    throw new Error("maintenance bootstrap is incomplete");
  }

  return {
    candidateMae,
    comparator,
    comparatorMae,
    difference: candidateMae - comparatorMae,
    differenceLower,
    differenceUpper,
    eventCount: rows.length,
    lowerSkill,
    replicates: 2_000,
    skill: corePairedSkill(comparatorMae, candidateMae),
    upperSkill,
  };
}

// calculate an equal-group comparison without pooled domination
function equalGroupComparison(
  rows: readonly MaintenanceEvaluationRow[],
  groupKeys: readonly string[],
  comparator: MaintenancePredictionField,
): MaintenancePairedComparison {
  const groups = groupKeys.map((groupKey) => {
    const selected = rows.filter((row) => row.pairKey === groupKey);
    const dates = [...new Set(selected.map((row) => row.localDate))].sort();

    // require one bootstrappable population for every equal-weight group
    if (dates.length < 7) {
      throw new RangeError("equal-group bootstrap requires seven dates per group");
    }

    const losses = new Map<string, { candidate: number; comparator: number }>();

    // reduce each group date before equal-group aggregation
    for (const localDate of dates) {
      const dateRows = selected.filter((row) => row.localDate === localDate);
      losses.set(localDate, {
        candidate: dateRows.reduce((sum, row) =>
          sum + Math.abs(row.candidatePrediction - row.target), 0) /
          dateRows.length,
        comparator: dateRows.reduce((sum, row) =>
          sum + Math.abs(row[comparator] - row.target), 0) /
          dateRows.length,
      });
    }

    return { dates, losses };
  });
  const candidateMae = groups.reduce((groupSum, group) =>
    groupSum + group.dates.reduce((dateSum, date) =>
      dateSum + group.losses.get(date)!.candidate / group.dates.length, 0) /
      groups.length, 0);
  const comparatorMae = groups.reduce((groupSum, group) =>
    groupSum + group.dates.reduce((dateSum, date) =>
      dateSum + group.losses.get(date)!.comparator / group.dates.length, 0) /
      groups.length, 0);
  const plan = createMovingBlockBootstrapStartPlan(
    groups.map((group) => group.dates.length),
  );
  const skillReplicates: number[] = [];
  const differenceReplicates: number[] = [];

  // retain equal group weight inside every bootstrap replicate
  for (const replicate of plan) {
    let sampledCandidate = 0;
    let sampledComparator = 0;

    // resample every group independently under the shared frozen plan
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index]!;
      const starts = replicate[index]!;
      const sampledDates = expandNonCircularBlockStarts(
        starts,
        group.dates.length,
      ).map((offset) => group.dates[offset]!);
      sampledCandidate += sampledDates.reduce((sum, date) =>
        sum + group.losses.get(date)!.candidate / sampledDates.length, 0) /
        groups.length;
      sampledComparator += sampledDates.reduce((sum, date) =>
        sum + group.losses.get(date)!.comparator / sampledDates.length, 0) /
        groups.length;
    }

    skillReplicates.push(corePairedSkill(sampledComparator, sampledCandidate));
    differenceReplicates.push(sampledCandidate - sampledComparator);
  }

  const sortedSkills = skillReplicates.sort((left, right) => left - right);
  const sortedDifferences = differenceReplicates.sort((left, right) => left - right);
  const lowerSkill = sortedSkills[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
  const upperSkill = sortedSkills[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];
  const differenceLower = sortedDifferences[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
  const differenceUpper = sortedDifferences[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];

  // retain the exact frozen replicate count and quantiles
  if (
    sortedSkills.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES ||
    lowerSkill === undefined ||
    upperSkill === undefined ||
    differenceLower === undefined ||
    differenceUpper === undefined
  ) {
    throw new Error("equal-group bootstrap is incomplete");
  }

  return {
    candidateMae,
    comparator,
    comparatorMae,
    difference: candidateMae - comparatorMae,
    differenceLower,
    differenceUpper,
    eventCount: rows.length,
    lowerSkill,
    replicates: 2_000,
    skill: corePairedSkill(comparatorMae, candidateMae),
    upperSkill,
  };
}

// summarize acting comparators and separately labelled diagnostics
function populationReport(
  rows: readonly MaintenanceEvaluationRow[],
): MaintenancePopulationReport {
  const applied = rows.filter((row) => row.applied);
  const farm = rows.filter((row) => row.farmTarget !== null);
  return {
    actualBestMatchAllRows: comparisonOrNull(rows, "actualBestMatchPrediction"),
    actualBestMatchAppliedOnly: comparisonOrNull(
      applied,
      "actualBestMatchPrediction",
    ),
    farmDiagnosticMae: farm.length === 0
      ? null
      : farm.reduce((sum, row) =>
          sum + Math.abs(row.candidatePrediction - row.farmTarget!), 0) /
        farm.length,
    incumbent: comparisonOrNull(rows, "incumbentPrediction"),
    nativeSource: comparisonOrNull(rows, "nativeSourcePrediction"),
    populationSha256: canonicalObjectSha256(
      { rows: rows.map((row) => row.rowSha256), populationSha256: "" },
      "populationSha256",
    ),
  };
}

// preserve unavailable bootstrap comparisons as explicit null diagnostics
function comparisonOrNull(
  rows: readonly MaintenanceEvaluationRow[],
  comparator: MaintenancePredictionField,
): MaintenancePairedComparison | null {
  return new Set(rows.map((row) => row.localDate)).size < 7
    ? null
    : pairedComparison(rows, comparator);
}

// derive one skill-plus-uncertainty promotion gate
function comparisonSkillGate(
  id: string,
  comparison: MaintenancePairedComparison | null,
  minimumSkill: number,
): MaintenancePolicyGate {
  // keep unsupported comparisons pending
  if (comparison === null) {
    return pendingGate(id, `skill >= ${minimumSkill} and lower skill > 0`);
  }

  return booleanGate(
    id,
    comparison.skill >= minimumSkill && comparison.lowerSkill > 0,
    `${comparison.skill}:${comparison.lowerSkill}`,
    `skill >= ${minimumSkill} and lower skill > 0`,
  );
}

// derive one upper-bound noninferiority gate
function comparisonDifferenceGate(
  id: string,
  comparison: MaintenancePairedComparison | null,
  maximumDifference: number,
): MaintenancePolicyGate {
  // keep unsupported comparisons pending
  if (comparison === null) {
    return pendingGate(id, `difference upper <= ${maximumDifference}`);
  }

  return booleanGate(
    id,
    comparison.differenceUpper <= maximumDifference,
    comparison.differenceUpper,
    `difference upper <= ${maximumDifference}`,
  );
}

// derive one critical-slice nonharm gate
function nonharmGate(
  id: string,
  rows: readonly MaintenanceEvaluationRow[],
  bestMatchMargin: number,
): MaintenancePolicyGate {
  const candidate = meanAbsoluteError(rows, "candidatePrediction");
  const incumbent = meanAbsoluteError(rows, "incumbentPrediction");
  const source = meanAbsoluteError(rows, "nativeSourcePrediction");
  const bestMatch = meanAbsoluteError(rows, "actualBestMatchPrediction");

  // keep missing slice metrics pending
  if ([candidate, incumbent, source, bestMatch].some((value) => value === null)) {
    return pendingGate(id, "candidate no worse than incumbent, source, or Best Match margin");
  }

  return booleanGate(
    id,
    candidate! <= incumbent! &&
      candidate! <= source! &&
      candidate! <= bestMatch! + bestMatchMargin,
    candidate,
    `candidate <= incumbent/source and <= Best Match + ${bestMatchMargin}`,
  );
}

// derive one date-balanced mean absolute error
function meanAbsoluteError(
  rows: readonly MaintenanceEvaluationRow[],
  prediction: MaintenancePredictionField,
): number | null {
  const dates = [...new Set(rows.map((row) => row.localDate))];

  // preserve unsupported empty populations
  if (dates.length === 0) {
    return null;
  }

  return dates.reduce((dateSum, localDate) => {
    const selected = rows.filter((row) => row.localDate === localDate);
    return dateSum + selected.reduce((sum, row) =>
      sum + Math.abs(row[prediction] - row.target), 0) /
      selected.length / dates.length;
  }, 0);
}

// derive one active-versus-source regression gate
function regressionSkillGate(
  id: string,
  comparison: MaintenancePairedComparison | null,
): MaintenancePolicyGate {
  // keep unsupported regression evidence pending
  if (comparison === null) {
    return pendingGate(id, "skill <= -0.02 and upper skill < 0");
  }

  return booleanGate(
    id,
    comparison.skill <= -0.02 && comparison.upperSkill < 0,
    `${comparison.skill}:${comparison.upperSkill}`,
    "skill <= -0.02 and upper skill < 0",
  );
}

// derive one active-versus-Best-Match regression gate
function regressionDifferenceGate(
  id: string,
  comparison: MaintenancePairedComparison | null,
  minimumDifference: number,
): MaintenancePolicyGate {
  // keep unsupported regression evidence pending
  if (comparison === null) {
    return pendingGate(id, `difference lower > ${minimumDifference}`);
  }

  return booleanGate(
    id,
    comparison.differenceLower > minimumDifference,
    comparison.differenceLower,
    `difference lower > ${minimumDifference}`,
  );
}

// verify registration, close, and seven-day action delay
function epochGate(epoch: MaintenanceRegressionEpoch): MaintenancePolicyGate {
  const registered = Date.parse(epoch.registeredAt);
  const start = Date.parse(epoch.epochStartInclusive);
  const end = Date.parse(epoch.epochEndExclusive);
  const evaluated = Date.parse(epoch.evaluatedAt);
  const passing =
    [registered, start, end, evaluated].every(Number.isFinite) &&
    registered < start &&
    start < end &&
    evaluated >= end + MAINTENANCE_POLICY_REPORT_EXPIRY_MILLISECONDS;
  return booleanGate(
    "registered_complete_epoch",
    passing,
    `${epoch.registeredAt}/${epoch.evaluatedAt}`,
    "registered before start and evaluated seven days after close",
    passing ? "pass" : "pending",
  );
}

// enumerate all supported wind harm slices
function windHarmSlices(
  rows: readonly MaintenanceEvaluationRow[],
): readonly (readonly [string, readonly MaintenanceEvaluationRow[]])[] {
  const slices = new Map<string, MaintenanceEvaluationRow[]>();

  // add each row to every prespecified categorical slice
  for (const row of rows) {
    const calendar = localCalendarFeaturesFor(row.validAt);
    const keys = [
      row.stationKey === null ? null : `station:${row.stationKey}`,
      row.providerFamily === null ? null : `provider:${row.providerFamily}`,
      row.nearestThree === true ? "nearest-three" : null,
      `season:${calendar.season}`,
      `daypart:${calendar.daypart}`,
    ];

    // retain only populated named slices
    for (const key of keys) {
      if (key !== null) {
        const selected = slices.get(key) ?? [];
        selected.push(row);
        slices.set(key, selected);
      }
    }
  }

  return [...slices.entries()].sort(([left], [right]) =>
    left.localeCompare(right));
}

// reject missing, extra, direction, or gust-49-72 wind pairs
function validateWindPairSet(rows: readonly MaintenanceEvaluationRow[]): void {
  const actual = [...new Set(rows.map((row) => row.pairKey))].sort();
  const expected = [...WIND_MAINTENANCE_PAIR_KEYS].sort();

  // require exactly seven speed and six gust pairs
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new RangeError("wind maintenance population must contain exactly 13 pairs");
  }
}

// derive all forty-nine stable rain gates from row metrics
function rainStableGates(
  rows: readonly RainMaintenanceEvaluationRow[],
): MaintenancePolicyGate[] {
  const gates = new Map<string, MaintenancePolicyGate>();
  const overall = rainMetrics(rows);
  setRainGate(gates, "maeImprovesFivePercent", overall.candidateMae <= overall.rawMae * 0.95, overall.candidateMae, "candidate mae <= raw mae * 0.95");
  setRainGate(gates, "beatsVolumeScale", overall.candidateMae <= rainControlMae(rows, "volumeScalePrediction"), overall.candidateMae, "candidate mae <= volume-scale mae");
  setRainGate(gates, "beatsPersistence", overall.candidateMae <= rainControlMae(rows, "persistencePrediction"), overall.candidateMae, "candidate mae <= persistence mae");
  setRainGate(gates, "rmseNoWorse", overall.candidateRmse <= overall.rawRmse, overall.candidateRmse, "candidate rmse <= raw rmse");
  setRainGate(gates, "wetIntensityNoWorse", overall.wetCandidateMae !== null && overall.wetRawMae !== null && overall.wetCandidateMae <= overall.wetRawMae, overall.wetCandidateMae, "wet candidate mae <= raw");
  setRainGate(gates, "heavyIntensityBounded", overall.heavyCandidateMae !== null && overall.heavyRawMae !== null && overall.heavyCandidateMae <= overall.heavyRawMae * 1.05, overall.heavyCandidateMae, "heavy candidate mae <= raw * 1.05");
  setRainGate(gates, "annualVolumeBalanced", overall.volumeRatio !== null && overall.volumeRatio >= 0.8 && overall.volumeRatio <= 1.2, overall.volumeRatio, "volume ratio within 0.8..1.2");
  setRainGate(gates, "overallSupport", rainSupportPass(rows, 300, 100, 50), rainSupportText(rows), "dates/wet dates/heavy hours >= 300/100/50", undefined, true);
  setRainGate(gates, "allSeasonsPresent", rainSeasonSlices(rows).every(([, selected]) => selected.length > 0), rainSeasonSlices(rows).filter(([, selected]) => selected.length > 0).length, "all four seasons present", undefined, true);
  setRainGate(gates, "allLeadBandsPresent", rainLeadSlices(rows).every(([, selected]) => selected.length > 0), rainLeadSlices(rows).filter(([, selected]) => selected.length > 0).length, "all three lead bands present", undefined, true);
  setRainGate(gates, "rawHeavyAmountsUnchanged", rows.filter((row) => row.nativeSourcePrediction >= 1).every((row) => row.candidatePrediction === row.nativeSourcePrediction), null, "candidate preserves raw amounts >= 1");
  setRainGate(gates, "rawWetCallsPreserved", rows.filter((row) => row.nativeSourcePrediction >= 0.1).every((row) => row.candidatePrediction >= 0.1), null, "candidate preserves raw wet calls");

  // apply original event safety at all three thresholds
  for (const threshold of RAIN_THRESHOLDS) {
    const candidate = eventMetrics(rows, "candidatePrediction", threshold);
    const raw = eventMetrics(rows, "nativeSourcePrediction", threshold);
    const passing = eventSafety(candidate, raw);
    setRainGate(gates, `event${threshold.toFixed(1)}Safety`, passing, candidate.csi, "pod nondecrease, csi delta >= -0.01, far delta <= 0.05");
  }

  // apply original season support and safety gates
  for (const [season, selected] of rainSeasonSlices(rows)) {
    const candidate = rainMetrics(selected);
    const rawEvents = eventMetrics(selected, "nativeSourcePrediction", 0.1);
    const candidateEvents = eventMetrics(selected, "candidatePrediction", 0.1);
    setRainGate(gates, `season${season}Support`, rainSupportPass(selected, 60, 10, 5), rainSupportText(selected), "dates/wet dates/heavy hours >= 60/10/5", undefined, true);
    setRainGate(gates, `season${season}Volume`, candidate.volumeRatio !== null && candidate.volumeRatio >= 0.8 && candidate.volumeRatio <= 1.2, candidate.volumeRatio, "season volume ratio within 0.8..1.2");
    setRainGate(gates, `season${season}Mae`, candidate.candidateMae <= candidate.rawMae * 1.10, candidate.candidateMae, "season candidate mae <= raw * 1.10");
    setRainGate(gates, `season${season}WetHeavy`, candidate.wetCandidateMae !== null && candidate.wetRawMae !== null && candidate.heavyCandidateMae !== null && candidate.heavyRawMae !== null && candidate.wetCandidateMae <= candidate.wetRawMae && candidate.heavyCandidateMae <= candidate.heavyRawMae * 1.05, candidate.wetCandidateMae, "season wet no worse and heavy <= raw * 1.05");
    setRainGate(gates, `season${season}Detection`, eventSafety(candidateEvents, rawEvents), candidateEvents.csi, "season pod nondecrease, csi delta >= -0.01, far delta <= 0.05");
  }

  // apply original lead support and nonharm gates
  for (const [lead, selected] of rainLeadSlices(rows)) {
    const metrics = rainMetrics(selected);
    setRainGate(gates, `lead${lead}Mae`, metrics.candidateMae <= metrics.rawMae * 1.05, metrics.candidateMae, "lead candidate mae <= raw * 1.05");
    setRainGate(gates, `lead${lead}Support`, rainSupportPass(selected, 0, 20, 5), rainSupportText(selected), "wet dates/heavy hours >= 20/5", undefined, true);
  }

  // apply complete same-run accumulation gates
  for (const hours of RAIN_ACCUMULATION_HOURS) {
    const accumulation = rainAccumulation(rows, hours);
    setRainGate(gates, `accumulation${hours}Mae`, accumulation.windows > 0 && accumulation.candidateMae <= accumulation.rawMae, accumulation.candidateMae, "complete-window candidate mae <= raw");
  }

  const ordinalMae = rainControlMae(rows, "unchangedOrdinalPrediction");
  setRainGate(gates, "beatsSameWindowVolumeScale", overall.candidateMae <= rainControlMae(rows, "sameWindowVolumeScalePrediction"), overall.candidateMae, "candidate mae <= same-window scale mae");
  setRainGate(gates, "beatsRecentVolumeScale", overall.candidateMae <= rainControlMae(rows, "recentVolumeScalePrediction"), overall.candidateMae, "candidate mae <= recent scale mae");
  setRainGate(gates, "beatsUnchangedOrdinal", overall.candidateMae < ordinalMae - 1e-12, overall.candidateMae, "candidate mae < unchanged ordinal mae - 1e-12");
  setRainGate(gates, "seasonalBalanceImproves", seasonalVolumeDeviation(rows, "candidatePrediction") < seasonalVolumeDeviation(rows, "unchangedOrdinalPrediction") - 1e-12, seasonalVolumeDeviation(rows, "candidatePrediction"), "candidate seasonal deviation improves unchanged ordinal");
  setRainGate(gates, "heavySkillRetained", rainHeavySkillRetained(rows), overall.heavyCandidateMae, "heavy mae and 1.0/2.5 detection retain ordinal skill");

  // preserve the stable complete gate identity and order
  if (
    gates.size !== RAIN_ORIGINAL_STABLE_GATE_IDS.length ||
    RAIN_ORIGINAL_STABLE_GATE_IDS.some((id) => !gates.has(id))
  ) {
    throw new Error("rain stable gate manifest is incomplete");
  }

  return RAIN_ORIGINAL_STABLE_GATE_IDS.map((id) => gates.get(id)!);
}

// store one derived rain gate without caller-supplied pass flags
function setRainGate(
  gates: Map<string, MaintenancePolicyGate>,
  id: string,
  passing: boolean,
  actual: number | string | null,
  criterion: string,
  state?: MaintenancePolicyState,
  pendingOnFailure = false,
): void {
  // reject duplicate stable gate identities
  if (gates.has(id)) {
    throw new Error(`rain gate is duplicated: ${id}`);
  }

  gates.set(id, booleanGate(
    id,
    passing,
    actual,
    criterion,
    state ?? (passing ? "pass" : pendingOnFailure ? "pending" : "fail"),
  ));
}

// summarize scalar rain loss and volume metrics
function rainMetrics(rows: readonly RainMaintenanceEvaluationRow[]): {
  readonly candidateMae: number;
  readonly candidateRmse: number;
  readonly heavyCandidateMae: number | null;
  readonly heavyRawMae: number | null;
  readonly rawMae: number;
  readonly rawRmse: number;
  readonly volumeRatio: number | null;
  readonly wetCandidateMae: number | null;
  readonly wetRawMae: number | null;
} {
  const weights = dateBalancedWeights(rows);
  const candidateErrors = rows.map((row) => Math.abs(row.candidatePrediction - row.target));
  const rawErrors = rows.map((row) => Math.abs(row.nativeSourcePrediction - row.target));
  const observed = rows.reduce((sum, row, index) => sum + row.target * weights[index]!, 0);
  return {
    candidateMae: weightedSum(candidateErrors, weights),
    candidateRmse: Math.sqrt(weightedSum(rows.map((row) => (row.candidatePrediction - row.target) ** 2), weights)),
    heavyCandidateMae: conditionalRainMae(rows, "candidatePrediction", 2.5),
    heavyRawMae: conditionalRainMae(rows, "nativeSourcePrediction", 2.5),
    rawMae: weightedSum(rawErrors, weights),
    rawRmse: Math.sqrt(weightedSum(rows.map((row) => (row.nativeSourcePrediction - row.target) ** 2), weights)),
    volumeRatio: observed === 0 ? null : rows.reduce((sum, row, index) => sum + row.candidatePrediction * weights[index]!, 0) / observed,
    wetCandidateMae: conditionalRainMae(rows, "candidatePrediction", 0.1),
    wetRawMae: conditionalRainMae(rows, "nativeSourcePrediction", 0.1),
  };
}

// assign equal local-date then row mass
function dateBalancedWeights(
  rows: readonly MaintenanceEvaluationRow[],
): readonly number[] {
  const dates = new Map<string, number>();

  // count each retained row by local date
  for (const row of rows) {
    dates.set(row.localDate, (dates.get(row.localDate) ?? 0) + 1);
  }

  return rows.map((row) => 1 / dates.size / dates.get(row.localDate)!);
}

// combine one weighted scalar array
function weightedSum(
  values: readonly number[],
  weights: readonly number[],
): number {
  return values.reduce((sum, value, index) => sum + value * weights[index]!, 0);
}

// calculate one conditional date-balanced rain mae
function conditionalRainMae(
  rows: readonly RainMaintenanceEvaluationRow[],
  prediction:
    | MaintenancePredictionField
    | "unchangedOrdinalPrediction",
  threshold: number,
): number | null {
  const selected = rows.filter((row) => row.target >= threshold);

  // preserve unsupported event strata as null
  if (selected.length === 0) {
    return null;
  }

  const weights = dateBalancedWeights(selected);
  return weightedSum(
    selected.map((row) => Math.abs(row[prediction] - row.target)),
    weights,
  );
}

// calculate one control mae on the identical population
function rainControlMae(
  rows: readonly RainMaintenanceEvaluationRow[],
  prediction:
    | "persistencePrediction"
    | "recentVolumeScalePrediction"
    | "sameWindowVolumeScalePrediction"
    | "unchangedOrdinalPrediction"
    | "volumeScalePrediction",
): number {
  const weights = dateBalancedWeights(rows);
  return weightedSum(
    rows.map((row) => Math.abs(row[prediction] - row.target)),
    weights,
  );
}

// report rain support using unique dates and hours
function rainSupport(rows: readonly RainMaintenanceEvaluationRow[]): {
  readonly dates: number;
  readonly heavyHours: number;
  readonly wetDates: number;
} {
  return {
    dates: new Set(rows.map((row) => row.localDate)).size,
    heavyHours: new Set(rows.filter((row) => row.target >= 2.5).map((row) => row.validAt)).size,
    wetDates: new Set(rows.filter((row) => row.target >= 0.1).map((row) => row.localDate)).size,
  };
}

// compare rain support with one fixed boundary
function rainSupportPass(
  rows: readonly RainMaintenanceEvaluationRow[],
  dates: number,
  wetDates: number,
  heavyHours: number,
): boolean {
  const support = rainSupport(rows);
  return support.dates >= dates &&
    support.wetDates >= wetDates &&
    support.heavyHours >= heavyHours;
}

// serialize one rain support diagnostic
function rainSupportText(rows: readonly RainMaintenanceEvaluationRow[]): string {
  const support = rainSupport(rows);
  return `${support.dates}/${support.wetDates}/${support.heavyHours}`;
}

// calculate deterministic occurrence diagnostics
function eventMetrics(
  rows: readonly RainMaintenanceEvaluationRow[],
  prediction: MaintenancePredictionField | "unchangedOrdinalPrediction",
  threshold: number,
): { readonly csi: number | null; readonly far: number | null; readonly pod: number | null } {
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;

  // count the same paired event rows
  for (const row of rows) {
    const observed = row.target >= threshold;
    const called = row[prediction] >= threshold;
    hits += Number(observed && called);
    misses += Number(observed && !called);
    falseAlarms += Number(!observed && called);
  }

  return {
    csi: hits + misses + falseAlarms === 0 ? null : hits / (hits + misses + falseAlarms),
    far: hits + falseAlarms === 0 ? null : falseAlarms / (hits + falseAlarms),
    pod: hits + misses === 0 ? null : hits / (hits + misses),
  };
}

// compare candidate event safety with one baseline
function eventSafety(
  candidate: ReturnType<typeof eventMetrics>,
  baseline: ReturnType<typeof eventMetrics>,
): boolean {
  // reject missing event metrics instead of passing nulls
  if (
    candidate.pod === null || candidate.csi === null || candidate.far === null ||
    baseline.pod === null || baseline.csi === null || baseline.far === null
  ) {
    return false;
  }

  return candidate.pod >= baseline.pod - 1e-12 &&
    candidate.csi >= baseline.csi - 0.01 &&
    candidate.far <= baseline.far + 0.05;
}

// enumerate exact rain season slices
function rainSeasonSlices(
  rows: readonly RainMaintenanceEvaluationRow[],
): readonly (readonly [typeof RAIN_SEASONS[number], readonly RainMaintenanceEvaluationRow[]])[] {
  return RAIN_SEASONS.map((season) => [
    season,
    rows.filter((row) => rainSeason(row.validAt) === season),
  ] as const);
}

// map local seasons to frozen rain labels
function rainSeason(validAt: string): typeof RAIN_SEASONS[number] {
  const season = localCalendarFeaturesFor(validAt).season;
  return season === "winter"
    ? "DJF"
    : season === "spring" ? "MAM" : season === "summer" ? "JJA" : "SON";
}

// enumerate exact rain operational lead slices
function rainLeadSlices(
  rows: readonly RainMaintenanceEvaluationRow[],
): readonly (readonly [typeof RAIN_LEAD_BANDS[number], readonly RainMaintenanceEvaluationRow[]])[] {
  return RAIN_LEAD_BANDS.map((lead) => [
      lead,
    rows.filter((row) => rainLeadBand(row.horizonHours) === lead),
  ] as const);
}

// classify one explicit rain horizon
function rainLeadBand(horizon: number): typeof RAIN_LEAD_BANDS[number] | null {
  return horizon <= 6 ? "1-6" : horizon <= 12 ? "7-12" : horizon <= 23 ? "13-23" : null;
}

// score complete same-run rain accumulation windows
function rainAccumulation(
  rows: readonly RainMaintenanceEvaluationRow[],
  hours: typeof RAIN_ACCUMULATION_HOURS[number],
): { readonly candidateMae: number; readonly rawMae: number; readonly windows: number } {
  const byRun = new Map<string, RainMaintenanceEvaluationRow[]>();

  // partition rows without crossing source runs
  for (const row of rows) {
    const selected = byRun.get(row.runKey) ?? [];
    selected.push(row);
    byRun.set(row.runKey, selected);
  }

  const candidateErrors: number[] = [];
  const rawErrors: number[] = [];

  // scan every run for exact consecutive windows
  for (const runRows of byRun.values()) {
    const sorted = [...runRows].sort((left, right) => left.validAt.localeCompare(right.validAt));

    // retain every complete sliding window
    for (let start = 0; start + hours <= sorted.length; start += 1) {
      const window = sorted.slice(start, start + hours);
      const first = Date.parse(window[0]!.validAt);
      const complete = window.every((row, index) =>
        Date.parse(row.validAt) === first + index * 3_600_000);

      // skip incomplete time tiling
      if (!complete) {
        continue;
      }

      const target = window.reduce((sum, row) => sum + row.target, 0);
      candidateErrors.push(Math.abs(window.reduce((sum, row) => sum + row.candidatePrediction, 0) - target));
      rawErrors.push(Math.abs(window.reduce((sum, row) => sum + row.nativeSourcePrediction, 0) - target));
    }
  }

  return {
    candidateMae: candidateErrors.length === 0 ? Number.POSITIVE_INFINITY : candidateErrors.reduce((sum, value) => sum + value, 0) / candidateErrors.length,
    rawMae: rawErrors.length === 0 ? Number.POSITIVE_INFINITY : rawErrors.reduce((sum, value) => sum + value, 0) / rawErrors.length,
    windows: candidateErrors.length,
  };
}

// calculate the worst four-season volume deviation
function seasonalVolumeDeviation(
  rows: readonly RainMaintenanceEvaluationRow[],
  prediction: "candidatePrediction" | "unchangedOrdinalPrediction",
): number {
  const deviations = rainSeasonSlices(rows).map(([, selected]) => {
    const weights = dateBalancedWeights(selected);
    const observed = selected.reduce((sum, row, index) => sum + row.target * weights[index]!, 0);

    // keep dry or absent seasons maximally unsupported
    if (selected.length === 0 || observed === 0) {
      return Number.POSITIVE_INFINITY;
    }

    const forecast = selected.reduce((sum, row, index) => sum + row[prediction] * weights[index]!, 0);
    return Math.abs(forecast / observed - 1);
  });
  return Math.max(...deviations);
}

// preserve unchanged ordinal heavy-event skill
function rainHeavySkillRetained(rows: readonly RainMaintenanceEvaluationRow[]): boolean {
  const candidateHeavy = conditionalRainMae(rows, "candidatePrediction", 2.5);
  const ordinalHeavy = conditionalRainMae(rows, "unchangedOrdinalPrediction", 2.5);

  // reject missing heavy support
  if (candidateHeavy === null || ordinalHeavy === null || candidateHeavy > ordinalHeavy + 1e-12) {
    return false;
  }

  // require both heavy occurrence definitions
  for (const threshold of [1, 2.5] as const) {
    const candidate = eventMetrics(rows, "candidatePrediction", threshold);
    const ordinal = eventMetrics(rows, "unchangedOrdinalPrediction", threshold);

    // reject missing or harmed heavy-event metrics
    if (!eventSafety(candidate, ordinal)) {
      return false;
    }
  }

  return true;
}

// enumerate rain Best Match nonharm slices
function rainBestMatchSlices(
  rows: readonly RainMaintenanceEvaluationRow[],
): readonly (readonly [string, readonly RainMaintenanceEvaluationRow[]])[] {
  return [
    ...rainSeasonSlices(rows).map(([key, selected]) => [`season:${key}`, selected] as const),
    ...rainLeadSlices(rows).map(([key, selected]) => [`lead:${key}`, selected] as const),
  ];
}

// require candidate Brier noninferiority to incumbent and source
function rainBrierGate(
  rows: readonly RainMaintenanceEvaluationRow[],
): MaintenancePolicyGate {
  let candidate = 0;
  let incumbent = 0;
  let source = 0;
  const weights = dateBalancedWeights(rows);

  // score all three probability heads on identical rows
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const weight = weights[index]! / RAIN_THRESHOLDS.length;

    // add each named occurrence loss
    for (const threshold of RAIN_THRESHOLDS) {
      const observed = Number(row.target >= threshold);
      const key = threshold === 0.1 ? "atLeast0_1" : threshold === 1 ? "atLeast1_0" : "atLeast2_5";
      candidate += weight * (row.candidateProbability[key] - observed) ** 2;
      incumbent += weight * (row.incumbentProbability[key] - observed) ** 2;
      source += weight * (row.nativeSourceProbability[key] - observed) ** 2;
    }
  }

  return booleanGate(
    "probability_brier_nonharm",
    candidate <= incumbent && candidate <= source,
    candidate,
    "candidate Brier <= incumbent and native source",
  );
}

// require monotonically nested candidate probabilities
function rainNestingGate(
  rows: readonly RainMaintenanceEvaluationRow[],
): MaintenancePolicyGate {
  const violations = rows.filter((row) =>
    row.candidateProbability.atLeast0_1 < row.candidateProbability.atLeast1_0 ||
    row.candidateProbability.atLeast1_0 < row.candidateProbability.atLeast2_5).length;
  return booleanGate(
    "probability_nesting",
    violations === 0,
    violations,
    "p2.5 <= p1.0 <= p0.1",
  );
}

// require nonzero probability support for every projected amount category
function rainCoherenceGate(
  rows: readonly RainMaintenanceEvaluationRow[],
): MaintenancePolicyGate {
  const violations = rows.filter((row) =>
    (row.candidatePrediction >= 0.1 && row.candidateProbability.atLeast0_1 === 0) ||
    (row.candidatePrediction >= 1 && row.candidateProbability.atLeast1_0 === 0) ||
    (row.candidatePrediction >= 2.5 && row.candidateProbability.atLeast2_5 === 0)).length;
  return booleanGate(
    "amount_probability_coherence",
    violations === 0,
    violations,
    "projected categories retain nonzero occurrence probability",
  );
}

// derive the conjunctive rain regression comparison
function rainRegressionComparisonGate(
  id: string,
  comparison: MaintenancePairedComparison | null,
): MaintenancePolicyGate {
  // keep unsupported regression comparisons pending
  if (comparison === null) {
    return pendingGate(id, "mae >= comparator * 1.05 and difference lower > 0");
  }

  return booleanGate(
    id,
    comparison.candidateMae >= comparison.comparatorMae * 1.05 &&
      comparison.differenceLower > 0,
    `${comparison.candidateMae}:${comparison.differenceLower}`,
    "mae >= comparator * 1.05 and difference lower > 0",
  );
}

// require one closed object field set
function requireExactKeys(
  value: object,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();

  // reject missing and unknown fields together
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    throw new RangeError(`${name} fields are invalid`);
  }
}

// create one explicit boolean gate
function booleanGate(
  id: string,
  passing: boolean,
  actual: number | string | null,
  criterion: string,
  state: MaintenancePolicyState = passing ? "pass" : "fail",
): MaintenancePolicyGate {
  return { actual, criterion, id, state };
}

// create one unsupported gate that cannot pass through null
function pendingGate(id: string, criterion: string): MaintenancePolicyGate {
  return { actual: null, criterion, id, state: "pending" };
}

// finalize conjunction state and action without null-pass behavior
function finalizePolicy(
  contractVersion: MaintenancePolicyEvaluation["contractVersion"],
  mode: MaintenancePolicyEvaluation["mode"],
  population: MaintenancePopulationReport,
  gates: readonly MaintenancePolicyGate[],
): MaintenancePolicyEvaluation {
  const state: MaintenancePolicyState = gates.some((gate) => gate.state === "fail")
    ? "fail"
    : gates.some((gate) => gate.state === "pending") ? "pending" : "pass";
  const action = state === "pending"
    ? "pending"
    : state === "pass" ? mode === "promotion" ? "promote" : "regress" : "retain";
  return deepFreeze({ action, contractVersion, gates, mode, population, state });
}
