import {
  FORECAST_ADJUSTMENT_CONTRACT_VERSIONS,
  FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES,
  FORECAST_OBSERVATION_STATIONS,
  PROVIDER_BALANCED_LOSO_CONTRACT_V1,
  type ForecastAdjustmentCandidateV2,
  type ForecastAdjustmentCriticalSliceScore,
  type ForecastAdjustmentEvaluationReportV2,
  type ForecastAdjustmentEvidenceRedundancy,
  type ForecastAdjustmentMetricBand,
  type ForecastAdjustmentMetricBandEvaluation,
  type ForecastAdjustmentPairedScore,
  type ForecastAdjustmentQualificationGate,
  type ForecastAdjustmentQualificationGateName,
  type ForecastAdjustmentQualificationReceiptV2,
  type ForecastObservationProviderFamily,
  type ForecastObservationStationKey,
  canonicalizeJson,
  type JsonValue,
} from "@weather/domain";

import { corePairedSkill } from "./algorithm-v1.js";
import {
  canonicalObjectSha256,
  canonicalSha256,
  deepFreeze,
  metricBandKey,
  sortEnabledMetricBands,
  type ForecastAdjustmentPreregistrationV1,
  verifyForecastAdjustmentCandidate,
  verifyForecastAdjustmentPreregistration,
} from "./candidate.js";
import {
  type HoldoutAccessMarkerV1,
  verifyHoldoutAccessMarker,
} from "./holdout-ledger.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

// describe one development LOSO station score
export interface DevelopmentLosoStationScoreV1 {
  readonly adjustedLoss: number;
  readonly eventCount: number;
  readonly physicalStationKey: ForecastObservationStationKey;
  readonly pointSkill: number;
  readonly providerFamily: ForecastObservationProviderFamily;
  readonly rawLoss: number;
  readonly remainingNetworkScoreEvents: number;
  readonly scoreMatches: number;
  readonly trainingMatches: number;
}

// describe one frozen development fold result
export interface DevelopmentLosoFoldResultV1 {
  readonly auxiliaryModelSha256s: readonly string[];
  readonly bootstrapLowerBound: number;
  readonly contractVersion: "forecast-adjustment-development-loso-fold/v1";
  readonly fold: 1 | 2 | 3 | 4 | 5;
  readonly materialHarmSliceKeys: readonly string[];
  readonly metricBand: ForecastAdjustmentMetricBand;
  readonly nonnegativeStationFraction: number;
  readonly passed: boolean;
  readonly providerBalancedAdjustedLoss: number;
  readonly providerBalancedRawLoss: number;
  readonly providerBalancedSkill: number;
  readonly providerFamilies: readonly ForecastObservationProviderFamily[];
  readonly scoreableStationKeys: readonly ForecastObservationStationKey[];
}

// bind all development-only auxiliary evidence
export interface ForecastAdjustmentDevelopmentReportV1 {
  readonly contractVersion: "forecast-adjustment-development-report/v1";
  readonly developmentReportSha256: string;
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly folds: readonly DevelopmentLosoFoldResultV1[];
  readonly generatedBeforeHoldout: true;
}

// verify one immutable development report
export function verifyDevelopmentReport(
  report: ForecastAdjustmentDevelopmentReportV1,
): void {
  // reject report substitution
  if (
    canonicalObjectSha256(
      report as unknown as Readonly<Record<string, unknown>>,
      "developmentReportSha256",
    ) !== report.developmentReportSha256
  ) {
    throw new RangeError("development report SHA-256 mismatch");
  }

  for (const fold of report.folds) {
    validateDevelopmentFold(fold);
  }

  // reapply the frozen fold promotion rule
  createDevelopmentReport({
    enabledMetricBands: report.enabledMetricBands,
    folds: report.folds,
  });
}

// accept immutable holdout scoring output
export interface CreateEvaluationReportInputV1 {
  readonly candidate: ForecastAdjustmentCandidateV2;
  readonly holdoutAccessMarker: HoldoutAccessMarkerV1;
  readonly metricBandEvaluations: readonly ForecastAdjustmentMetricBandEvaluation[];
  readonly preregistration: ForecastAdjustmentPreregistrationV1;
}

// qualify non-holdout gates fixed before scoring
export interface QualificationContextV1 {
  readonly coefficientCoverageAndCapsPassed: boolean;
  readonly criticalSlicesPassed: boolean;
  readonly developmentFoldSkillPassed: boolean;
  readonly productionIdentityPassed: boolean;
}

// score one provider-balanced LOSO fold
export function evaluateDevelopmentLosoFold(input: {
  readonly auxiliaryModelSha256s: readonly string[];
  readonly bootstrapLowerBound: number;
  readonly fold: 1 | 2 | 3 | 4 | 5;
  readonly materialHarmSliceKeys: readonly string[];
  readonly metricBand: ForecastAdjustmentMetricBand;
  readonly stationScores: readonly DevelopmentLosoStationScoreV1[];
}): DevelopmentLosoFoldResultV1 {
  const stationKeys = input.stationScores.map((score) => score.physicalStationKey);

  // reject duplicate or inconsistent station scores
  if (
    new Set(stationKeys).size !== stationKeys.length ||
    !Number.isFinite(input.bootstrapLowerBound) ||
    new Set(input.auxiliaryModelSha256s).size !==
      input.auxiliaryModelSha256s.length ||
    input.auxiliaryModelSha256s.some((hash) => !HASH_PATTERN.test(hash)) ||
    input.stationScores.some(
      (score) =>
        FORECAST_OBSERVATION_STATIONS.find(
          (station) => station.key === score.physicalStationKey,
        )?.providerFamily !== score.providerFamily ||
        !Number.isFinite(score.rawLoss) ||
        score.rawLoss < 0 ||
        !Number.isFinite(score.adjustedLoss) ||
        score.adjustedLoss < 0 ||
        !Number.isSafeInteger(score.eventCount) ||
        score.eventCount < 1 ||
        !Number.isSafeInteger(score.trainingMatches) ||
        score.trainingMatches < 0 ||
        !Number.isSafeInteger(score.scoreMatches) ||
        score.scoreMatches < 0 ||
        !Number.isSafeInteger(score.remainingNetworkScoreEvents) ||
        score.remainingNetworkScoreEvents < 0 ||
        Math.abs(pairedSkill(score.rawLoss, score.adjustedLoss) - score.pointSkill) >
          Number.EPSILON * 8,
    )
  ) {
    throw new RangeError("development LOSO station scores are invalid");
  }

  const scoreable = input.stationScores.filter(
    (score) =>
      score.trainingMatches >=
        PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumStationTrainingMatches &&
      score.scoreMatches >=
        PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumStationScoreMatches &&
      score.remainingNetworkScoreEvents >=
        PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumRemainingNetworkScoreEvents,
  ).sort((left, right) =>
    compareText(left.physicalStationKey, right.physicalStationKey),
  );

  // require complete auxiliary fit and score evidence without silent filtering
  if (
    scoreable.length !== input.stationScores.length ||
    input.auxiliaryModelSha256s.length !== scoreable.length
  ) {
    throw new RangeError("development LOSO auxiliary coverage is incomplete");
  }
  const families = [...new Set(scoreable.map((score) => score.providerFamily))].sort();
  const providerBalancedRawLoss = equalProviderLoss(scoreable, "rawLoss");
  const providerBalancedAdjustedLoss = equalProviderLoss(scoreable, "adjustedLoss");
  const providerBalancedSkill = pairedSkill(
    providerBalancedRawLoss,
    providerBalancedAdjustedLoss,
  );
  const nonnegativeStationFraction =
    scoreable.length === 0
      ? 0
      : scoreable.filter((score) => score.pointSkill >= 0).length / scoreable.length;
  const passed =
    scoreable.length >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumScoreableStationsPerFold &&
    families.length >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumProviderFamiliesPerFold &&
    providerBalancedSkill >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumImprovementFraction &&
    input.bootstrapLowerBound >
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.bootstrapLowerBoundExclusive &&
    nonnegativeStationFraction >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumNonnegativeStationFraction &&
    input.materialHarmSliceKeys.length === 0;

  return deepFreeze({
    auxiliaryModelSha256s: [...input.auxiliaryModelSha256s].sort(),
    bootstrapLowerBound: input.bootstrapLowerBound,
    contractVersion: "forecast-adjustment-development-loso-fold/v1",
    fold: input.fold,
    materialHarmSliceKeys: [...input.materialHarmSliceKeys].sort(),
    metricBand: cloneJson(input.metricBand),
    nonnegativeStationFraction,
    passed,
    providerBalancedAdjustedLoss,
    providerBalancedRawLoss,
    providerBalancedSkill,
    providerFamilies: families,
    scoreableStationKeys: scoreable
      .map((score) => score.physicalStationKey)
      .sort(),
  });
}

// create one immutable development report
export function createDevelopmentReport(input: {
  readonly enabledMetricBands: readonly ForecastAdjustmentMetricBand[];
  readonly folds: readonly DevelopmentLosoFoldResultV1[];
}): ForecastAdjustmentDevelopmentReportV1 {
  const folds = [...input.folds].sort((left, right) => {
    const pairOrder = compareText(metricBandKey(left.metricBand), metricBandKey(right.metricBand));
    return pairOrder === 0 ? left.fold - right.fold : pairOrder;
  });
  const enabledMetricBands = sortEnabledMetricBands(input.enabledMetricBands);

  for (const fold of folds) {
    validateDevelopmentFold(fold);
  }

  // require exact five-fold coverage and the frozen promotion rule
  if (
    folds.length !== enabledMetricBands.length * 5 ||
    enabledMetricBands.some((pair, pairIndex) => {
      const pairFolds = folds.slice(pairIndex * 5, pairIndex * 5 + 5);
      const coverageInvalid = [1, 2, 3, 4, 5].some((fold, foldIndex) => {
        const result = folds[pairIndex * 5 + foldIndex];
        return (
          result === undefined ||
          result.fold !== fold ||
          metricBandKey(result.metricBand) !== metricBandKey(pair)
        );
      });
      const passingCount = pairFolds.filter((result) => result.passed).length;
      return coverageInvalid || passingCount < 4 || pairFolds[4]?.passed !== true;
    })
  ) {
    throw new RangeError("development report requires four passing folds including fold five");
  }
  const unsigned = {
    contractVersion: "forecast-adjustment-development-report/v1" as const,
    enabledMetricBands,
    folds,
    generatedBeforeHoldout: true as const,
  };

  return deepFreeze({
    ...unsigned,
    developmentReportSha256: canonicalSha256(unsigned as unknown as JsonValue),
  });
}

// rederive one fold verdict from its immutable aggregate evidence
function validateDevelopmentFold(fold: DevelopmentLosoFoldResultV1): void {
  const stationFamilies = fold.scoreableStationKeys.map((key) => {
    const station = FORECAST_OBSERVATION_STATIONS.find((item) => item.key === key);

    // reject unknown station identities
    if (station === undefined) {
      throw new RangeError("development fold contains an unknown station");
    }

    return station.providerFamily;
  });
  const expectedFamilies = [...new Set(stationFamilies)].sort();
  const derivedPassed =
    fold.scoreableStationKeys.length >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumScoreableStationsPerFold &&
    expectedFamilies.length >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumProviderFamiliesPerFold &&
    fold.providerBalancedSkill >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumImprovementFraction &&
    fold.bootstrapLowerBound > 0 &&
    fold.nonnegativeStationFraction >=
      PROVIDER_BALANCED_LOSO_CONTRACT_V1.minimumNonnegativeStationFraction &&
    fold.materialHarmSliceKeys.length === 0;

  // reject caller-selected verdicts, ownership, or auxiliary omissions
  if (
    fold.passed !== derivedPassed ||
    fold.auxiliaryModelSha256s.length !== fold.scoreableStationKeys.length ||
    new Set(fold.scoreableStationKeys).size !== fold.scoreableStationKeys.length ||
    canonicalizeJson(fold.providerFamilies as unknown as JsonValue) !==
      canonicalizeJson(expectedFamilies as unknown as JsonValue)
  ) {
    throw new RangeError("development fold aggregate evidence is inconsistent");
  }
}

// create a separate immutable locked-holdout report
export function createForecastAdjustmentEvaluationReport(
  input: CreateEvaluationReportInputV1,
): ForecastAdjustmentEvaluationReportV2 {
  const candidateBytesBefore = canonicalizeJson(
    input.candidate as unknown as JsonValue,
  );
  verifyForecastAdjustmentPreregistration(input.preregistration, input.candidate);
  verifyHoldoutAccessMarker(input.holdoutAccessMarker);

  // require marker linkage before accepting scores
  if (
    input.holdoutAccessMarker.candidateArtifactSha256 !==
      input.candidate.candidateArtifactSha256 ||
    input.holdoutAccessMarker.preregistrationSha256 !==
      input.preregistration.preregistrationSha256 ||
    input.holdoutAccessMarker.evaluationEpochId !==
      input.candidate.evaluationEpochId
  ) {
    throw new RangeError("holdout marker does not match immutable candidate evidence");
  }

  const evaluations = [...input.metricBandEvaluations]
    .map((evaluation) => cloneJson(evaluation))
    .sort((left, right) =>
      compareText(metricBandKey(left.metricBand), metricBandKey(right.metricBand)),
    );

  // reject enabled-set stripping after holdout
  if (
    canonicalizeJson(evaluations.map((item) => item.metricBand) as unknown as JsonValue) !==
    canonicalizeJson(input.candidate.enabledMetricBands as unknown as JsonValue)
  ) {
    throw new RangeError("holdout evaluation must cover the unchanged enabled set");
  }

  const unsigned = {
    candidateArtifactSha256: input.candidate.candidateArtifactSha256,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.evaluationReport,
    enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
    evaluationEpochId: input.candidate.evaluationEpochId,
    holdoutAccessMarkerSha256: input.holdoutAccessMarker.markerSha256,
    holdoutEndExclusive: input.holdoutAccessMarker.endExclusive,
    holdoutEndLocalDate: input.holdoutAccessMarker.endLocalDate,
    holdoutStartInclusive: input.holdoutAccessMarker.startInclusive,
    holdoutStartLocalDate: input.holdoutAccessMarker.startLocalDate,
    metricBandEvaluations: evaluations,
    preregistrationSha256: input.preregistration.preregistrationSha256,
    trainingProvenance: cloneJson(input.candidate.trainingProvenance),
  };
  const report = deepFreeze({
    ...unsigned,
    evaluationReportSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentEvaluationReportV2;

  // prove report construction never mutates candidate bytes
  if (
    canonicalizeJson(input.candidate as unknown as JsonValue) !== candidateBytesBefore
  ) {
    throw new Error("immutable candidate changed during holdout evaluation");
  }

  return report;
}

// verify a report's immutable hash
export function verifyForecastAdjustmentEvaluationReport(
  report: ForecastAdjustmentEvaluationReportV2,
): void {
  requireExactKeys(report, [
    "candidateArtifactSha256",
    "contractVersion",
    "enabledMetricBands",
    "evaluationEpochId",
    "evaluationReportSha256",
    "holdoutAccessMarkerSha256",
    "holdoutEndExclusive",
    "holdoutEndLocalDate",
    "holdoutStartInclusive",
    "holdoutStartLocalDate",
    "metricBandEvaluations",
    "preregistrationSha256",
    "trainingProvenance",
  ], "evaluation report");
  // reject report substitution
  if (
    canonicalObjectSha256(
      report as unknown as Readonly<Record<string, unknown>>,
      "evaluationReportSha256",
    ) !== report.evaluationReportSha256
  ) {
    throw new RangeError("evaluation report SHA-256 mismatch");
  }
}

// create a separate immutable qualification receipt
export function createForecastAdjustmentQualificationReceipt(input: {
  readonly candidate: ForecastAdjustmentCandidateV2;
  readonly contextByMetricBand: Readonly<Record<string, QualificationContextV1>>;
  readonly evaluationReport: ForecastAdjustmentEvaluationReportV2;
  readonly evidenceRedundancy: ForecastAdjustmentEvidenceRedundancy;
}): ForecastAdjustmentQualificationReceiptV2 {
  verifyForecastAdjustmentCandidate(input.candidate);
  verifyForecastAdjustmentEvaluationReport(input.evaluationReport);

  // require immutable candidate-report links
  if (
    input.evaluationReport.candidateArtifactSha256 !==
      input.candidate.candidateArtifactSha256 ||
    canonicalizeJson(input.evaluationReport.enabledMetricBands as unknown as JsonValue) !==
      canonicalizeJson(input.candidate.enabledMetricBands as unknown as JsonValue)
  ) {
    throw new RangeError("evaluation report candidate cross-link mismatch");
  }

  const gates: ForecastAdjustmentQualificationGate[] = [];
  for (const evaluation of input.evaluationReport.metricBandEvaluations) {
    const context = input.contextByMetricBand[metricBandKey(evaluation.metricBand)];

    // require all preregistered development context
    if (context === undefined) {
      throw new RangeError("qualification context is missing for an enabled pair");
    }

    const outcomes: Readonly<Record<ForecastAdjustmentQualificationGateName, boolean>> = {
      bootstrap_lower_bound: evaluation.network.bootstrapLowerBound > 0,
      coefficient_coverage_and_caps: context.coefficientCoverageAndCapsPassed,
      critical_slice_no_harm:
        context.criticalSlicesPassed && !hasMaterialHarm(evaluation.criticalSlices),
      development_fold_skill: context.developmentFoldSkillPassed,
      locked_holdout: !isMaterialHarm(evaluation.providerBalanced),
      pooled_network_improvement: evaluation.network.skill >= 0.02,
      production_identity: context.productionIdentityPassed,
    };

    for (const name of FORECAST_ADJUSTMENT_QUALIFICATION_GATE_NAMES) {
      const passed = outcomes[name];
      gates.push({
        metricBand: cloneJson(evaluation.metricBand),
        name,
        passed,
        reasonCode: passed ? null : "qualification_failed",
      });
    }
  }

  const passed =
    gates.every((gate) => gate.passed) && input.evidenceRedundancy.verified;
  const unsigned = {
    candidateArtifactSha256: input.candidate.candidateArtifactSha256,
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.qualificationReceipt,
    enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
    evaluationEpochId: input.candidate.evaluationEpochId,
    evaluationReportSha256: input.evaluationReport.evaluationReportSha256,
    evidenceRedundancy: cloneJson(input.evidenceRedundancy),
    gates,
    holdoutAccessMarkerSha256:
      input.evaluationReport.holdoutAccessMarkerSha256,
    lifecycleState: passed ? ("qualified" as const) : ("rejected" as const),
    passed,
    preregistrationSha256: input.evaluationReport.preregistrationSha256,
    trainingProvenance: cloneJson(input.candidate.trainingProvenance),
  };

  return deepFreeze({
    ...unsigned,
    qualificationReceiptSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentQualificationReceiptV2;
}

// verify a receipt's immutable hash
export function verifyForecastAdjustmentQualificationReceipt(
  receipt: ForecastAdjustmentQualificationReceiptV2,
): void {
  requireExactKeys(receipt, [
    "candidateArtifactSha256",
    "contractVersion",
    "enabledMetricBands",
    "evaluationEpochId",
    "evaluationReportSha256",
    "evidenceRedundancy",
    "gates",
    "holdoutAccessMarkerSha256",
    "lifecycleState",
    "passed",
    "preregistrationSha256",
    "qualificationReceiptSha256",
    "trainingProvenance",
  ], "qualification receipt");
  // reject receipt substitution
  if (
    canonicalObjectSha256(
      receipt as unknown as Readonly<Record<string, unknown>>,
      "qualificationReceiptSha256",
    ) !== receipt.qualificationReceiptSha256
  ) {
    throw new RangeError("qualification receipt SHA-256 mismatch");
  }
}

// require one closed top-level evidence schema
function requireExactKeys(
  value: object,
  expected: readonly string[],
  description: string,
): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();

  // reject missing or extra fields
  if (canonicalizeJson(actual) !== canonicalizeJson(required)) {
    throw new RangeError(`${description} has unexpected fields`);
  }
}

// compute equal-station then equal-provider loss
function equalProviderLoss(
  scores: readonly DevelopmentLosoStationScoreV1[],
  field: "adjustedLoss" | "rawLoss",
): number {
  const familyMeans: number[] = [];
  const families = [...new Set(scores.map((score) => score.providerFamily))].sort();

  for (const family of families) {
    const values = scores
      .filter((score) => score.providerFamily === family)
      .map((score) => score[field]);
    familyMeans.push(mean(values));
  }

  return mean(familyMeans);
}

// compute the literal zero-loss skill
export function pairedSkill(rawLoss: number, adjustedLoss: number): number {
  return corePairedSkill(rawLoss, adjustedLoss);
}

// detect any adequately sized material-harm slice
function hasMaterialHarm(
  slices: readonly ForecastAdjustmentCriticalSliceScore[],
): boolean {
  return slices.some(
    (slice) =>
      slice.eventCount >=
        PROVIDER_BALANCED_LOSO_CONTRACT_V1.materialHarmMinimumEvents &&
      isMaterialHarm(slice),
  );
}

// detect the frozen material-harm condition
function isMaterialHarm(score: ForecastAdjustmentPairedScore): boolean {
  return score.skill <= -0.02 && score.bootstrapUpperBound < 0;
}

// average one nonempty finite set
function mean(values: readonly number[]): number {
  // fail closed for missing scores
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    return Number.NaN;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// compare strings by code unit
function compareText(left: string, right: string): number {
  // order lower values first
  if (left < right) {
    return -1;
  }

  // order higher values last
  if (left > right) {
    return 1;
  }

  return 0;
}

// clone one JSON value without aliases
function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as T;
}
