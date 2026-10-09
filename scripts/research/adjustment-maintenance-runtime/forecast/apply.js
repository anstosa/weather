import { FORECAST_ADJUSTMENT_METRICS, FORECAST_ADJUSTMENT_WIND_CANARY_METRICS, createForecastAdjustmentFailRawDecision, forecastLeadBandFor, validateForecastAdjustmentActiveDecision, validateForecastAdjustmentWindCanaryActiveDecision, } from "@weather/domain";
import { applyCoreAdjustment, calendarFingerprintEquals, selectHierarchyCoefficient, } from "./algorithm-v1.js";
import { localCalendarFeaturesFor, runtimeCalendarFingerprint, } from "./calendar.js";
import { deepFreeze, metricBandKey, verifyForecastAdjustmentCandidate } from "./candidate.js";
import { FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2, verifyForecastAdjustmentWindCanaryRuntimeBundle, } from "./wind-canary.js";
// apply only exact enabled and in-distribution metrics
export function applyForecastAdjustment(runtime, input) {
    return applyForecastAdjustmentRuntime(runtime, input, true);
}
// evaluate one verified inactive wind candidate without activation authority
export function applyForecastAdjustmentWindShadowCandidate(bundle, input) {
    verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
    return applyForecastAdjustmentRuntime({ bundle, reasonCode: null, state: "active" }, input, false);
}
// evaluate one authority-free monthly wind package
export function applyForecastAdjustmentWindMaintenanceCandidate(bundleSha256, candidate, input, authority = null) {
    verifyForecastAdjustmentCandidate(candidate);
    return applyForecastAdjustmentRuntime({
        bundle: { candidate, maintenanceAuthority: authority, maintenanceBundleSha256: bundleSha256 },
        reasonCode: null,
        state: "active",
    }, input, false);
}
// share numerical evaluation while keeping activation checks explicit
function applyForecastAdjustmentRuntime(runtime, input, enforceAuthorization) {
    // preserve raw service when startup loading was disabled
    if (runtime.state === "disabled") {
        return createForecastAdjustmentFailRawDecision("disabled", runtime.reasonCode);
    }
    const bundle = runtime.bundle;
    const candidate = bundle.candidate;
    const windCanary = "artifactKind" in bundle;
    const maintenance = "maintenanceBundleSha256" in bundle;
    // enforce canary authorization for every application after startup
    if (windCanary && enforceAuthorization) {
        const evaluatedAt = Date.parse(input.evaluatedAt ?? new Date().toISOString());
        const activatedAt = Date.parse(bundle.authorization.activatedAt);
        const expiresAt = bundle.contractVersion ===
            FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2
            ? null
            : Date.parse(bundle.authorization.expiresAt);
        // fail raw before activation or after a finite v1 deadline
        if (!Number.isFinite(evaluatedAt) ||
            evaluatedAt < activatedAt ||
            (expiresAt !== null && evaluatedAt >= expiresAt)) {
            return createForecastAdjustmentFailRawDecision("disabled", "canary_expired");
        }
    }
    let leadBand;
    try {
        leadBand = forecastLeadBandFor(input.rawForecastProvenance.targetLeadHours);
    }
    catch {
        return createForecastAdjustmentFailRawDecision("not_applicable", "unsupported_lead");
    }
    // reject invalid or non-retrieval provenance for the whole row
    const servedForecastIdentity = windCanary
        ? bundle.candidate.servedForecastIdentity
        : bundle.candidate.forecastIdentity;
    // require the exact live-v4 served identity for either runtime path
    if (!forecastIdentityMatches(servedForecastIdentity, input.rawForecastProvenance)) {
        return createForecastAdjustmentFailRawDecision("not_applicable", input.rawForecastProvenance.cohort === "legacy_v4_retrieval_snapshot"
            ? "identity_mismatch"
            : "wrong_cohort");
    }
    const calendar = localCalendarFeaturesFor(input.rawForecastProvenance.validAt);
    const fingerprintMatches = calendarFingerprintEquals(candidate.runtimeFingerprint, input.runtimeFingerprint ?? runtimeCalendarFingerprint());
    const enabledKeys = new Set(candidate.enabledMetricBands.map(metricBandKey));
    const adjustedMetrics = {};
    const appliedMetrics = [];
    const failures = [];
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
        const rootAvailable = candidate.coefficients.some((coefficient) => coefficient.level === 1 &&
            coefficient.metric === metric &&
            coefficient.leadBand === leadBand);
        const coefficient = selectHierarchyCoefficient(candidate.coefficients, metric, leadBand, calendar);
        const envelopeRecord = candidate.trainingEnvelopes.find((envelope) => envelope.metric === metric && envelope.leadBand === leadBand);
        const envelope = envelopeRecord === undefined
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
        }
        else {
            failures.push(result.reason);
        }
    }
    // remain raw when no metric can be safely adjusted
    if (appliedMetrics.length === 0) {
        const firstFailure = failures[0];
        // preserve the explicit all-null public result
        if (firstFailure === undefined) {
            return createForecastAdjustmentFailRawDecision("not_applicable", "metric_not_enabled");
        }
        return createForecastAdjustmentFailRawDecision("not_applicable", mapCoreFailure(firstFailure));
    }
    // emit only runtime identities for the authority-free maintenance package
    if (maintenance) {
        const maintenanceAppliedMetrics = appliedMetrics.filter(
        // retain only the fitted wind allowlist
        (metric) => metric === "windDirectionDegrees" || metric === "windGustMps" || metric === "windSpeedMps");
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
                contractVersion: "forecast-adjustment-maintenance-decision/v1",
                leadBand,
                rawForecastProvenance: input.rawForecastProvenance,
                reasonCode: null,
                state: "active",
            });
        }
        return deepFreeze({
            actionSha256: bundle.maintenanceAuthority.actionSha256,
            activationKind: "maintenance_qualified",
            adjustedMetrics,
            algorithmContractVersion: candidate.algorithmContractVersion,
            appliedMetrics: maintenanceAppliedMetrics,
            candidateArtifactSha256: candidate.candidateArtifactSha256,
            contractVersion: "forecast-adjustment-decision/v1",
            fullMemberRootSha256: bundle.maintenanceAuthority.fullMemberRootSha256,
            leadBand,
            policyReportSha256: bundle.maintenanceAuthority.policyReportSha256,
            rawForecastProvenance: input.rawForecastProvenance,
            reasonCode: null,
            state: "active",
        });
    }
    // emit honest canary evidence identities without a qualification receipt
    if (windCanary) {
        const canaryAppliedMetrics = appliedMetrics.filter((metric) => metric === "windDirectionDegrees" ||
            metric === "windGustMps" ||
            metric === "windSpeedMps");
        // reject impossible non-wind accumulation before response creation
        if (canaryAppliedMetrics.length !== appliedMetrics.length) {
            return createForecastAdjustmentFailRawDecision("not_applicable", "metric_not_enabled");
        }
        const decision = {
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
    const decision = {
        adjustedMetrics,
        algorithmContractVersion: candidate.algorithmContractVersion,
        appliedMetrics,
        candidateArtifactSha256: candidate.candidateArtifactSha256,
        contractVersion: "forecast-adjustment-decision/v1",
        evaluationReportSha256: bundle.evaluationReport.evaluationReportSha256,
        leadBand,
        qualificationReceiptSha256: bundle.qualificationReceipt.qualificationReceiptSha256,
        rawForecastProvenance: input.rawForecastProvenance,
        reasonCode: null,
        state: "active",
    };
    validateForecastAdjustmentActiveDecision(decision);
    return deepFreeze(decision);
}
// compare every immutable served forecast identity
function forecastIdentityMatches(expected, actual) {
    const referenceMilliseconds = Date.parse(actual.referenceAt);
    const validMilliseconds = Date.parse(actual.validAt);
    const continuousLeadHours = (validMilliseconds - referenceMilliseconds) / 3_600_000;
    return (Number.isFinite(referenceMilliseconds) &&
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
        expected.upstreamModel === actual.upstreamModel);
}
// map pure-core reasons to the bounded public decision contract
function mapCoreFailure(reason) {
    const reasons = {
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
