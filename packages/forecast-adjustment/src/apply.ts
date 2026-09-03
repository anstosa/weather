import {
  FORECAST_ADJUSTMENT_METRICS,
  FORECAST_ADJUSTMENT_WIND_CANARY_METRICS,
  type CanonicalWeatherMetrics,
  type ForecastAdjustmentActiveDecision,
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
import { deepFreeze, metricBandKey } from "./candidate.js";
import type {
  LoadedForecastAdjustmentRuntimeV1,
  LoadedForecastAdjustmentWindCanaryRuntimeV1,
} from "./runtime-loader.js";

// accept one unchanged raw v4 forecast row
export interface ApplyForecastAdjustmentInputV1 {
  readonly evaluatedAt?: string;
  readonly metrics: CanonicalWeatherMetrics;
  readonly rawForecastProvenance: ForecastAdjustmentRawForecastProvenance;
  readonly runtimeFingerprint?: RuntimeCalendarFingerprint;
}

// apply only exact enabled and in-distribution metrics
export function applyForecastAdjustment(
  runtime:
    | LoadedForecastAdjustmentRuntimeV1
    | LoadedForecastAdjustmentWindCanaryRuntimeV1,
  input: ApplyForecastAdjustmentInputV1,
): ForecastAdjustmentDecision {
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

  // enforce the canary window for every application after startup
  if (windCanary) {
    const evaluatedAt = Date.parse(input.evaluatedAt ?? new Date().toISOString());
    const activatedAt = Date.parse(bundle.authorization.activatedAt);
    const expiresAt = Date.parse(bundle.authorization.expiresAt);

    // fail raw outside the authorized half-open interval
    if (
      !Number.isFinite(evaluatedAt) ||
      evaluatedAt < activatedAt ||
      evaluatedAt >= expiresAt
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

  const adjustableMetrics = windCanary
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
