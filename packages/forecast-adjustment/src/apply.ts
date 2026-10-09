import {
  FORECAST_ADJUSTMENT_METRICS,
  FORECAST_ADJUSTMENT_WIND_CANARY_METRICS,
  type CanonicalWeatherMetrics,
  type ForecastAdjustmentActiveDecision,
  type ForecastAdjustmentCandidateV2,
  type ForecastAdjustmentDecision,
  type ForecastAdjustmentMetric,
  type ForecastAdjustmentRawForecastProvenance,
  type ForecastAdjustmentReasonCode,
  type ForecastAdjustmentWindCanaryActiveDecision,
  createForecastAdjustmentFailRawDecision,
  forecastLeadBandFor,
  validateForecastAdjustmentActiveDecision,
  validateForecastAdjustmentWindCanaryActiveDecision,
} from "@weather/domain";

import {
  applyCoreAdjustment,
  calendarFingerprintEquals,
  selectHierarchyCoefficient,
  type CoreAdjustmentApplicationResult,
} from "./algorithm-v1.js";
import {
  localCalendarFeaturesFor,
  runtimeCalendarFingerprint,
  type RuntimeCalendarFingerprint,
} from "./calendar.js";
import { deepFreeze, metricBandKey, verifyForecastAdjustmentCandidate } from "./candidate.js";
import type {
  LoadedForecastAdjustmentRuntimeV1,
  LoadedForecastAdjustmentWindCanaryRuntime,
} from "./runtime-loader.js";
import {
  FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2,
  verifyForecastAdjustmentWindCanaryRuntimeBundle,
  type ForecastAdjustmentWindCanaryRuntimeBundle,
} from "./wind-canary.js";

// accept one unchanged raw v4 forecast row
export interface ApplyForecastAdjustmentInputV1 {
  readonly evaluatedAt?: string;
  readonly metrics: CanonicalWeatherMetrics;
  readonly rawForecastProvenance: ForecastAdjustmentRawForecastProvenance;
  readonly runtimeFingerprint?: RuntimeCalendarFingerprint;
}

export interface ForecastAdjustmentWindMaintenanceDecision {
  readonly adjustedMetrics: Partial<Record<ForecastAdjustmentMetric, number>>;
  readonly appliedMetrics: readonly (typeof FORECAST_ADJUSTMENT_WIND_CANARY_METRICS)[number][];
  readonly bundleSha256: string;
  readonly candidateArtifactSha256: string;
  readonly contractVersion: "forecast-adjustment-maintenance-decision/v1";
  readonly leadBand: ReturnType<typeof forecastLeadBandFor>;
  readonly rawForecastProvenance: ForecastAdjustmentRawForecastProvenance;
  readonly reasonCode: null;
  readonly state: "active";
}

export interface ForecastAdjustmentWindQualifiedMaintenanceDecision {
  readonly actionSha256: string;
  readonly activationKind: "maintenance_qualified";
  readonly adjustedMetrics: Partial<Record<ForecastAdjustmentMetric, number>>;
  readonly algorithmContractVersion: "robust-hierarchical-median/v1";
  readonly appliedMetrics: readonly (typeof FORECAST_ADJUSTMENT_WIND_CANARY_METRICS)[number][];
  readonly candidateArtifactSha256: string;
  readonly contractVersion: "forecast-adjustment-decision/v1";
  readonly fullMemberRootSha256: string;
  readonly leadBand: ReturnType<typeof forecastLeadBandFor>;
  readonly policyReportSha256: string;
  readonly rawForecastProvenance: ForecastAdjustmentRawForecastProvenance;
  readonly reasonCode: null;
  readonly state: "active";
}

type ForecastAdjustmentWindMaintenanceRuntime = Readonly<{
  bundle: Readonly<{
    candidate: ForecastAdjustmentCandidateV2;
    maintenanceAuthority: Readonly<{
      actionSha256: string;
      fullMemberRootSha256: string;
      policyReportSha256: string;
    }> | null;
    maintenanceBundleSha256: string;
  }>;
  reasonCode: null;
  state: "active";
}>;

// apply only exact enabled and in-distribution metrics
export function applyForecastAdjustment(
  runtime:
    | LoadedForecastAdjustmentRuntimeV1
    | LoadedForecastAdjustmentWindCanaryRuntime,
  input: ApplyForecastAdjustmentInputV1,
): ForecastAdjustmentDecision | ForecastAdjustmentWindQualifiedMaintenanceDecision {
  return applyForecastAdjustmentRuntime(runtime, input, true) as
    ForecastAdjustmentDecision | ForecastAdjustmentWindQualifiedMaintenanceDecision;
}

// evaluate one verified inactive wind candidate without activation authority
export function applyForecastAdjustmentWindShadowCandidate(
  bundle: ForecastAdjustmentWindCanaryRuntimeBundle,
  input: ApplyForecastAdjustmentInputV1,
): ForecastAdjustmentDecision {
  verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
  return applyForecastAdjustmentRuntime(
    { bundle, reasonCode: null, state: "active" },
    input,
    false,
  ) as ForecastAdjustmentDecision;
}

// evaluate one authority-free monthly wind package
export function applyForecastAdjustmentWindMaintenanceCandidate(
  bundleSha256: string,
  candidate: ForecastAdjustmentCandidateV2,
  input: ApplyForecastAdjustmentInputV1,
  authority: ForecastAdjustmentWindMaintenanceRuntime["bundle"]["maintenanceAuthority"] = null,
): ForecastAdjustmentDecision | ForecastAdjustmentWindMaintenanceDecision |
  ForecastAdjustmentWindQualifiedMaintenanceDecision {
  verifyForecastAdjustmentCandidate(candidate);
  return applyForecastAdjustmentRuntime({
    bundle: { candidate, maintenanceAuthority: authority, maintenanceBundleSha256: bundleSha256 },
    reasonCode: null,
    state: "active",
  }, input, false);
}

// share numerical evaluation while keeping activation checks explicit
function applyForecastAdjustmentRuntime(
  runtime:
    | LoadedForecastAdjustmentRuntimeV1
    | LoadedForecastAdjustmentWindCanaryRuntime
    | ForecastAdjustmentWindMaintenanceRuntime,
  input: ApplyForecastAdjustmentInputV1,
  enforceAuthorization: boolean,
): ForecastAdjustmentDecision | ForecastAdjustmentWindMaintenanceDecision |
  ForecastAdjustmentWindQualifiedMaintenanceDecision {
  // preserve raw service when startup loading was disabled
  if (runtime.state === "disabled") {
    return createForecastAdjustmentFailRawDecision(
      "disabled",
      runtime.reasonCode,
    );
  }

  const bundle = runtime.bundle;
  const candidate = bundle.candidate;
  const windCanary = "artifactKind" in bundle;
  const maintenance = "maintenanceBundleSha256" in bundle;

  // enforce canary authorization for every application after startup
  if (windCanary && enforceAuthorization) {
    const evaluatedAt = Date.parse(input.evaluatedAt ?? new Date().toISOString());
    const activatedAt = Date.parse(bundle.authorization.activatedAt);
    const expiresAt =
      bundle.contractVersion ===
      FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2
        ? null
        : Date.parse(bundle.authorization.expiresAt);

    // fail raw before activation or after a finite v1 deadline
    if (
      !Number.isFinite(evaluatedAt) ||
      evaluatedAt < activatedAt ||
      (expiresAt !== null && evaluatedAt >= expiresAt)
    ) {
      return createForecastAdjustmentFailRawDecision(
        "disabled",
        "canary_expired",
      );
    }
  }

  let leadBand: ReturnType<typeof forecastLeadBandFor>;

  try {
    leadBand = forecastLeadBandFor(input.rawForecastProvenance.targetLeadHours);
  } catch {
    return createForecastAdjustmentFailRawDecision(
      "not_applicable",
      "unsupported_lead",
    );
  }

  // reject invalid or non-retrieval provenance for the whole row
  const servedForecastIdentity = windCanary
    ? bundle.candidate.servedForecastIdentity
    : bundle.candidate.forecastIdentity;

  // require the exact live-v4 served identity for either runtime path
  if (!forecastIdentityMatches(servedForecastIdentity, input.rawForecastProvenance)) {
    return createForecastAdjustmentFailRawDecision(
      "not_applicable",
      input.rawForecastProvenance.cohort === "legacy_v4_retrieval_snapshot"
        ? "identity_mismatch"
        : "wrong_cohort",
    );
  }

  const calendar = localCalendarFeaturesFor(input.rawForecastProvenance.validAt);
  const fingerprintMatches = calendarFingerprintEquals(
    candidate.runtimeFingerprint,
    input.runtimeFingerprint ?? runtimeCalendarFingerprint(),
  );
  const enabledKeys = new Set(candidate.enabledMetricBands.map(metricBandKey));
  const adjustedMetrics: Partial<Record<ForecastAdjustmentMetric, number>> = {};
  const appliedMetrics: ForecastAdjustmentMetric[] = [];
  const failures: CoreAdjustmentApplicationResult["reason"][] = [];

  const adjustableMetrics = windCanary || maintenance
    ? FORECAST_ADJUSTMENT_WIND_CANARY_METRICS
    : FORECAST_ADJUSTMENT_METRICS;

  // evaluate only the hard-allowlisted canary metrics
  for (const metric of adjustableMetrics) {
    const rawValue = input.metrics[metric];

    // skip absent provider metrics without inventing values
    if (rawValue === null) {
      continue;
    }

    const pairKey = metricBandKey({ leadBand, metric });
    const rootAvailable = candidate.coefficients.some(
      (coefficient) =>
        coefficient.level === 1 &&
        coefficient.metric === metric &&
        coefficient.leadBand === leadBand,
    );
    const coefficient = selectHierarchyCoefficient(
      candidate.coefficients,
      metric,
      leadBand,
      calendar,
    );
    const envelopeRecord = candidate.trainingEnvelopes.find(
      (envelope) =>
        envelope.metric === metric && envelope.leadBand === leadBand,
    );
    const envelope =
      envelopeRecord === undefined
        ? null
        : { maximum: envelopeRecord.maximum, minimum: envelopeRecord.minimum };
    const result = applyCoreAdjustment({
      calendarFingerprintMatches: fingerprintMatches,
      coefficient,
      enabled: enabledKeys.has(pairKey),
      envelope,
      identityMatches: true,
      metric,
      rawForecastValue: rawValue,
      rawWindSpeedMps: input.metrics.windSpeedMps,
      rootAvailable,
    });

    // record only successful derived metrics
    if (result.applied) {
      adjustedMetrics[metric] = result.adjustedValue;
      appliedMetrics.push(metric);
    } else {
      failures.push(result.reason);
    }
  }

  // remain raw when no metric can be safely adjusted
  if (appliedMetrics.length === 0) {
    const firstFailure = failures[0];

    // preserve the explicit all-null public result
    if (firstFailure === undefined) {
      return createForecastAdjustmentFailRawDecision(
        "not_applicable",
        "metric_not_enabled",
      );
    }

    return createForecastAdjustmentFailRawDecision(
      "not_applicable",
      mapCoreFailure(firstFailure),
    );
  }

  // emit only runtime identities for the authority-free maintenance package
  if (maintenance) {
    const maintenanceAppliedMetrics = appliedMetrics.filter(
      // retain only the fitted wind allowlist
      (metric): metric is (typeof FORECAST_ADJUSTMENT_WIND_CANARY_METRICS)[number] =>
        metric === "windDirectionDegrees" || metric === "windGustMps" || metric === "windSpeedMps",
    );
    // reject impossible non-wind accumulation before response creation
    if (maintenanceAppliedMetrics.length !== appliedMetrics.length) {
      return createForecastAdjustmentFailRawDecision("not_applicable", "metric_not_enabled");
    }
    // keep inactive shadow evaluation free of serving authority
    if (bundle.maintenanceAuthority === null) {
      return deepFreeze({
        adjustedMetrics,
        appliedMetrics: maintenanceAppliedMetrics,
        bundleSha256: bundle.maintenanceBundleSha256,
        candidateArtifactSha256: candidate.candidateArtifactSha256,
        contractVersion: "forecast-adjustment-maintenance-decision/v1" as const,
        leadBand,
        rawForecastProvenance: input.rawForecastProvenance,
        reasonCode: null,
        state: "active" as const,
      });
    }
    return deepFreeze({
      actionSha256: bundle.maintenanceAuthority.actionSha256,
      activationKind: "maintenance_qualified" as const,
      adjustedMetrics,
      algorithmContractVersion: candidate.algorithmContractVersion,
      appliedMetrics: maintenanceAppliedMetrics,
      candidateArtifactSha256: candidate.candidateArtifactSha256,
      contractVersion: "forecast-adjustment-decision/v1" as const,
      fullMemberRootSha256: bundle.maintenanceAuthority.fullMemberRootSha256,
      leadBand,
      policyReportSha256: bundle.maintenanceAuthority.policyReportSha256,
      rawForecastProvenance: input.rawForecastProvenance,
      reasonCode: null,
      state: "active" as const,
    });
  }

  // emit honest canary evidence identities without a qualification receipt
  if (windCanary) {
    const canaryAppliedMetrics = appliedMetrics.filter(
      (metric): metric is (typeof FORECAST_ADJUSTMENT_WIND_CANARY_METRICS)[number] =>
        metric === "windDirectionDegrees" ||
        metric === "windGustMps" ||
        metric === "windSpeedMps",
    );

    // reject impossible non-wind accumulation before response creation
    if (canaryAppliedMetrics.length !== appliedMetrics.length) {
      return createForecastAdjustmentFailRawDecision(
        "not_applicable",
        "metric_not_enabled",
      );
    }

    const decision: ForecastAdjustmentWindCanaryActiveDecision = {
      activationKind: "wind_transfer_canary",
      adjustedMetrics,
      algorithmContractVersion: candidate.algorithmContractVersion,
      appliedMetrics: canaryAppliedMetrics,
      authorizationSha256: bundle.authorization.authorizationSha256,
      candidateArtifactSha256: candidate.candidateArtifactSha256,
      contractVersion: "forecast-adjustment-decision/v1",
      leadBand,
      rawForecastProvenance: input.rawForecastProvenance,
      reasonCode: null,
      state: "active",
      transferReportSha256: bundle.transferReport.transferReportSha256,
    };
    validateForecastAdjustmentWindCanaryActiveDecision(decision);
    return deepFreeze(decision);
  }

  const decision: ForecastAdjustmentActiveDecision = {
    adjustedMetrics,
    algorithmContractVersion: candidate.algorithmContractVersion,
    appliedMetrics,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    contractVersion: "forecast-adjustment-decision/v1",
    evaluationReportSha256: bundle.evaluationReport.evaluationReportSha256,
    leadBand,
    qualificationReceiptSha256:
      bundle.qualificationReceipt.qualificationReceiptSha256,
    rawForecastProvenance: input.rawForecastProvenance,
    reasonCode: null,
    state: "active",
  };
  validateForecastAdjustmentActiveDecision(decision);
  return deepFreeze(decision);
}

// compare every immutable served forecast identity
function forecastIdentityMatches(
  expected: LoadedForecastAdjustmentRuntimeV1 extends { bundle: infer _Bundle }
    ? {
        readonly adapterVersion: string;
        readonly cohort: "legacy_v4_retrieval_snapshot";
        readonly contractEpoch: string;
        readonly dataset: string;
        readonly referenceKind: "retrieval_snapshot";
        readonly sourceConfigFingerprint: string;
        readonly sourceKey: string;
        readonly upstreamModel: string;
      }
    : never,
  actual: ForecastAdjustmentRawForecastProvenance,
): boolean {
  const referenceMilliseconds = Date.parse(actual.referenceAt);
  const validMilliseconds = Date.parse(actual.validAt);
  const continuousLeadHours =
    (validMilliseconds - referenceMilliseconds) / 3_600_000;

  return (
    Number.isFinite(referenceMilliseconds) &&
    Number.isFinite(validMilliseconds) &&
    referenceMilliseconds <= validMilliseconds &&
    Math.ceil(continuousLeadHours) === actual.targetLeadHours &&
    expected.adapterVersion === actual.adapterVersion &&
    expected.cohort === actual.cohort &&
    expected.contractEpoch === actual.contractEpoch &&
    expected.dataset === actual.dataset &&
    expected.referenceKind === actual.referenceKind &&
    expected.sourceConfigFingerprint === actual.sourceConfigFingerprint &&
    expected.sourceKey === actual.sourceKey &&
    expected.upstreamModel === actual.upstreamModel
  );
}

// map pure-core reasons to the bounded public decision contract
function mapCoreFailure(
  reason: CoreAdjustmentApplicationResult["reason"],
): ForecastAdjustmentReasonCode {
  const reasons: Readonly<
    Record<CoreAdjustmentApplicationResult["reason"], ForecastAdjustmentReasonCode>
  > = {
    adjusted: "adjustment_error",
    calendar_fingerprint_mismatch: "runtime_fingerprint_mismatch",
    coefficient_missing: "coefficient_missing",
    disabled_metric_band: "metric_not_enabled",
    forecast_identity_mismatch: "identity_mismatch",
    raw_direction_calm: "direction_calm",
    raw_value_invalid: "metric_out_of_bounds",
    raw_value_ood: "training_envelope_mismatch",
    root_missing: "coefficient_missing",
  };

  return reasons[reason];
}
