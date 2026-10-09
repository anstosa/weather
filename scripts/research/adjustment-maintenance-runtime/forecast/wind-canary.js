import { FORECAST_ADJUSTMENT_CONTRACT_VERSIONS, FORECAST_LEAD_BANDS, FORECAST_ADJUSTMENT_METRIC_POLICIES_V1, FORECAST_ADJUSTMENT_WIND_CANARY_METRICS, canonicalizeJson, } from "@weather/domain";
import { FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1, FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1, canonicalObjectSha256, canonicalSha256, deepFreeze, metricBandKey, sortEnabledMetricBands, } from "./candidate.js";
// freeze the previous-runs lineage used for canary fitting
export const FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1 = {
    adapterVersion: "open-meteo-previous-runs/v1",
    cohort: "fixed_lead_anchor",
    contractEpoch: "open-meteo-previous-runs-best-match/2026-09",
    dataset: "previous_runs",
    referenceKind: "fixed_lead_anchor",
    sourceConfigFingerprint: "3a311d67d08aa3f9dedc2dbb8382d4cf11f945439d50c328a93874fc0a44538e",
    sourceKey: "open-meteo-previous-runs-v1",
    upstreamModel: "best_match",
};
// cap one canary activation window
export const FORECAST_ADJUSTMENT_WIND_CANARY_MAXIMUM_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
// identify permanent authorization contracts
export const FORECAST_ADJUSTMENT_WIND_CANARY_AUTHORIZATION_CONTRACT_VERSION_V2 = "forecast-adjustment-wind-canary-authorization/v2";
export const FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2 = "forecast-adjustment-wind-canary-runtime-bundle/v2";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CANDIDATE_KEYS = [
    "algorithmContractVersion",
    "artifactKind",
    "candidateArtifactSha256",
    "coefficientPayloadSha256",
    "coefficients",
    "contractVersion",
    "enabledMetricBands",
    "exportManifestSha256",
    "finalTrainingCutoff",
    "runtimeFingerprint",
    "servedForecastIdentity",
    "siteKey",
    "timezone",
    "trainingEnvelopes",
    "trainingForecastIdentity",
    "trainingProvenance",
];
const TRANSFER_REPORT_KEYS = [
    "artifactKind",
    "bridgeEndExclusive",
    "bridgeEvaluations",
    "bridgeStartInclusive",
    "candidateArtifactSha256",
    "contractVersion",
    "enabledMetricBands",
    "passed",
    "servedForecastIdentity",
    "trainingForecastIdentity",
    "transferReportSha256",
];
const AUTHORIZATION_KEYS = [
    "activatedAt",
    "artifactKind",
    "authorizationReason",
    "authorizationSha256",
    "authorized",
    "authorizedAt",
    "authorizedBy",
    "candidateArtifactSha256",
    "contractVersion",
    "enabledMetricBands",
    "expiresAt",
    "transferReportSha256",
];
const PERMANENT_AUTHORIZATION_KEYS = [
    "activatedAt",
    "artifactKind",
    "authorizationReason",
    "authorizationSha256",
    "authorized",
    "authorizedAt",
    "authorizedBy",
    "candidateArtifactSha256",
    "contractVersion",
    "enabledMetricBands",
    "expiresAt",
    "permanent",
    "transferReportSha256",
];
const BUNDLE_KEYS = [
    "artifactKind",
    "authorization",
    "bundleSha256",
    "candidate",
    "contractVersion",
    "siteKey",
    "timezone",
    "transferReport",
];
const REGISTRY_KEYS = ["activeBundle", "contractVersion"];
const REGISTRY_ACTIVE_KEYS = [
    "authorizationSha256",
    "bundleSha256",
    "candidateArtifactSha256",
    "path",
    "transferReportSha256",
];
const METRIC_BAND_KEYS = ["leadBand", "metric"];
const COEFFICIENT_KEYS = [
    "coefficient",
    "daypart",
    "effectiveEventCount",
    "leadBand",
    "level",
    "metric",
    "month",
    "season",
];
const TRAINING_ENVELOPE_KEYS = [
    "leadBand",
    "maximum",
    "metric",
    "minimum",
];
const RUNTIME_FINGERPRINT_KEYS = ["icuVersion", "tzdataVersion"];
const BRIDGE_EVALUATION_KEYS = ["metricBand", "network"];
const BRIDGE_SCORE_KEYS = [
    "adjustedLoss",
    "eventCount",
    "rawLoss",
    "skill",
];
// create one immutable wind-only transfer candidate
export function createForecastAdjustmentWindCanaryCandidate(input) {
    validateHash(input.exportManifestSha256, "exportManifestSha256");
    validateUtcInstant(input.finalTrainingCutoff, "finalTrainingCutoff");
    validateCanonicalLineage(input.trainingForecastIdentity, input.servedForecastIdentity, input.trainingProvenance);
    const enabledMetricBands = sortEnabledMetricBands(input.enabledMetricBands);
    const coefficients = sortCoefficients(input.coefficients);
    const trainingEnvelopes = sortTrainingEnvelopes(input.trainingEnvelopes);
    const unsigned = {
        algorithmContractVersion: "robust-hierarchical-median/v1",
        artifactKind: "wind_transfer_canary_candidate",
        coefficientPayloadSha256: canonicalSha256(coefficients),
        coefficients,
        contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryCandidate,
        enabledMetricBands,
        exportManifestSha256: input.exportManifestSha256,
        finalTrainingCutoff: input.finalTrainingCutoff,
        runtimeFingerprint: cloneJson(input.runtimeFingerprint),
        servedForecastIdentity: cloneJson(input.servedForecastIdentity),
        siteKey: "ballydidean",
        timezone: "America/Los_Angeles",
        trainingEnvelopes,
        trainingForecastIdentity: cloneJson(input.trainingForecastIdentity),
        trainingProvenance: cloneJson(input.trainingProvenance),
    };
    const candidate = deepFreeze({
        ...unsigned,
        candidateArtifactSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentWindCanaryCandidate(candidate);
    return candidate;
}
// reject candidate substitution and non-wind fitted material
export function verifyForecastAdjustmentWindCanaryCandidate(candidate) {
    requireExactKeys(candidate, CANDIDATE_KEYS, "wind canary candidate");
    // require the separate canary contract
    if (candidate.artifactKind !== "wind_transfer_canary_candidate" ||
        candidate.contractVersion !==
            FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryCandidate ||
        candidate.algorithmContractVersion !== "robust-hierarchical-median/v1" ||
        candidate.siteKey !== "ballydidean" ||
        candidate.timezone !== "America/Los_Angeles") {
        throw new RangeError("wind canary candidate identity mismatch");
    }
    validateHash(candidate.candidateArtifactSha256, "candidateArtifactSha256");
    validateHash(candidate.coefficientPayloadSha256, "coefficientPayloadSha256");
    validateHash(candidate.exportManifestSha256, "exportManifestSha256");
    validateUtcInstant(candidate.finalTrainingCutoff, "finalTrainingCutoff");
    validateText(candidate.runtimeFingerprint.icuVersion, "icuVersion");
    validateText(candidate.runtimeFingerprint.tzdataVersion, "tzdataVersion");
    requireExactKeys(candidate.runtimeFingerprint, RUNTIME_FINGERPRINT_KEYS, "wind canary runtime fingerprint");
    // reject any rehashed candidate mutation
    if (canonicalObjectSha256(candidate, "candidateArtifactSha256") !== candidate.candidateArtifactSha256 ||
        canonicalSha256(candidate.coefficients) !==
            candidate.coefficientPayloadSha256) {
        throw new RangeError("wind canary candidate SHA-256 mismatch");
    }
    validateCanonicalLineage(candidate.trainingForecastIdentity, candidate.servedForecastIdentity, candidate.trainingProvenance);
    validateWindCandidateMaterial(candidate);
}
// create immutable bridge evidence for the fitted candidate
export function createForecastAdjustmentWindCanaryTransferReport(input) {
    verifyForecastAdjustmentWindCanaryCandidate(input.candidate);
    const bridgeEvaluations = [...input.bridgeEvaluations]
        .map(cloneJson)
        .sort((left, right) => metricBandKey(left.metricBand).localeCompare(metricBandKey(right.metricBand)));
    const unsigned = {
        artifactKind: "wind_transfer_canary_transfer_report",
        bridgeEndExclusive: validateUtcInstant(input.bridgeEndExclusive, "bridgeEndExclusive"),
        bridgeEvaluations,
        bridgeStartInclusive: validateUtcInstant(input.bridgeStartInclusive, "bridgeStartInclusive"),
        candidateArtifactSha256: input.candidate.candidateArtifactSha256,
        contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryTransferReport,
        enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
        passed: true,
        servedForecastIdentity: cloneJson(input.candidate.servedForecastIdentity),
        trainingForecastIdentity: cloneJson(input.candidate.trainingForecastIdentity),
    };
    const report = deepFreeze({
        ...unsigned,
        transferReportSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentWindCanaryTransferReport(report, input.candidate);
    return report;
}
// reject transfer evidence substitution or nonpositive bridge skill
export function verifyForecastAdjustmentWindCanaryTransferReport(report, candidate) {
    verifyForecastAdjustmentWindCanaryCandidate(candidate);
    requireExactKeys(report, TRANSFER_REPORT_KEYS, "wind canary transfer report");
    // require the separate passing report identity
    if (report.artifactKind !== "wind_transfer_canary_transfer_report" ||
        report.contractVersion !==
            FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryTransferReport ||
        report.passed !== true ||
        report.candidateArtifactSha256 !== candidate.candidateArtifactSha256) {
        throw new RangeError("wind canary transfer report identity mismatch");
    }
    validateHash(report.transferReportSha256, "transferReportSha256");
    const bridgeStart = Date.parse(validateUtcInstant(report.bridgeStartInclusive, "bridgeStartInclusive"));
    const bridgeEnd = Date.parse(validateUtcInstant(report.bridgeEndExclusive, "bridgeEndExclusive"));
    // require a nonempty ordered bridge window
    if (bridgeStart >= bridgeEnd ||
        Date.parse(candidate.finalTrainingCutoff) >= bridgeStart) {
        throw new RangeError("wind canary bridge window is invalid");
    }
    // require exact candidate linkage and complete pair coverage
    if (canonicalizeJson(report.enabledMetricBands) !==
        canonicalizeJson(candidate.enabledMetricBands) ||
        canonicalizeJson(report.trainingForecastIdentity) !==
            canonicalizeJson(candidate.trainingForecastIdentity) ||
        canonicalizeJson(report.servedForecastIdentity) !==
            canonicalizeJson(candidate.servedForecastIdentity) ||
        canonicalizeJson(report.bridgeEvaluations.map((evaluation) => evaluation.metricBand)) !== canonicalizeJson(candidate.enabledMetricBands)) {
        throw new RangeError("wind canary transfer report cross-link mismatch");
    }
    // require positive finite live-v4 evidence for every enabled pair
    for (const evaluation of report.bridgeEvaluations) {
        requireExactKeys(evaluation, BRIDGE_EVALUATION_KEYS, "wind canary bridge evaluation");
        requireExactKeys(evaluation.metricBand, METRIC_BAND_KEYS, "wind canary bridge metric band");
        requireExactKeys(evaluation.network, BRIDGE_SCORE_KEYS, "wind canary bridge score");
        validateBridgeScore(evaluation.network);
    }
    // reject any fully rehashed report mutation
    if (canonicalObjectSha256(report, "transferReportSha256") !== report.transferReportSha256) {
        throw new RangeError("wind canary transfer report SHA-256 mismatch");
    }
}
// create one explicit bounded operator authorization
export function createForecastAdjustmentWindCanaryAuthorization(input) {
    verifyForecastAdjustmentWindCanaryTransferReport(input.transferReport, input.candidate);
    const unsigned = {
        activatedAt: validateUtcInstant(input.activatedAt, "activatedAt"),
        artifactKind: "wind_transfer_canary_authorization",
        authorizationReason: validateText(input.authorizationReason, "authorizationReason"),
        authorized: true,
        authorizedAt: validateUtcInstant(input.authorizedAt, "authorizedAt"),
        authorizedBy: validateText(input.authorizedBy, "authorizedBy"),
        candidateArtifactSha256: input.candidate.candidateArtifactSha256,
        contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryAuthorization,
        enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
        expiresAt: validateUtcInstant(input.expiresAt, "expiresAt"),
        transferReportSha256: input.transferReport.transferReportSha256,
    };
    const authorization = deepFreeze({
        ...unsigned,
        authorizationSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentWindCanaryAuthorization(authorization, input.candidate, input.transferReport);
    return authorization;
}
// create one explicit permanent operator authorization
export function createPermanentForecastAdjustmentWindCanaryAuthorization(input) {
    verifyForecastAdjustmentWindCanaryTransferReport(input.transferReport, input.candidate);
    const unsigned = {
        activatedAt: validateUtcInstant(input.activatedAt, "activatedAt"),
        artifactKind: "wind_transfer_canary_authorization",
        authorizationReason: validateText(input.authorizationReason, "authorizationReason"),
        authorized: true,
        authorizedAt: validateUtcInstant(input.authorizedAt, "authorizedAt"),
        authorizedBy: validateText(input.authorizedBy, "authorizedBy"),
        candidateArtifactSha256: input.candidate.candidateArtifactSha256,
        contractVersion: FORECAST_ADJUSTMENT_WIND_CANARY_AUTHORIZATION_CONTRACT_VERSION_V2,
        enabledMetricBands: cloneJson(input.candidate.enabledMetricBands),
        expiresAt: null,
        permanent: true,
        transferReportSha256: input.transferReport.transferReportSha256,
    };
    const authorization = deepFreeze({
        ...unsigned,
        authorizationSha256: canonicalSha256(unsigned),
    });
    verifyPermanentForecastAdjustmentWindCanaryAuthorization(authorization, input.candidate, input.transferReport);
    return authorization;
}
// verify exact operator authorization links and duration
export function verifyForecastAdjustmentWindCanaryAuthorization(authorization, candidate, report) {
    verifyForecastAdjustmentWindCanaryCandidate(candidate);
    verifyForecastAdjustmentWindCanaryTransferReport(report, candidate);
    requireExactKeys(authorization, AUTHORIZATION_KEYS, "wind canary authorization");
    // require one explicit immutable authorization
    if (authorization.artifactKind !== "wind_transfer_canary_authorization" ||
        authorization.contractVersion !==
            FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryAuthorization ||
        authorization.authorized !== true ||
        authorization.candidateArtifactSha256 !== candidate.candidateArtifactSha256 ||
        authorization.transferReportSha256 !== report.transferReportSha256 ||
        canonicalizeJson(authorization.enabledMetricBands) !==
            canonicalizeJson(candidate.enabledMetricBands)) {
        throw new RangeError("wind canary authorization cross-link mismatch");
    }
    validateHash(authorization.authorizationSha256, "authorizationSha256");
    validateText(authorization.authorizationReason, "authorizationReason");
    validateText(authorization.authorizedBy, "authorizedBy");
    const authorizedAt = Date.parse(validateUtcInstant(authorization.authorizedAt, "authorizedAt"));
    const activatedAt = Date.parse(validateUtcInstant(authorization.activatedAt, "activatedAt"));
    const expiresAt = Date.parse(validateUtcInstant(authorization.expiresAt, "expiresAt"));
    // require one forward-only activation no longer than fourteen days
    if (authorizedAt < Date.parse(report.bridgeEndExclusive) ||
        activatedAt < authorizedAt ||
        expiresAt <= activatedAt ||
        expiresAt - activatedAt > FORECAST_ADJUSTMENT_WIND_CANARY_MAXIMUM_DURATION_MS) {
        throw new RangeError("wind canary authorization window is invalid");
    }
    // reject any fully rehashed authorization mutation
    if (canonicalObjectSha256(authorization, "authorizationSha256") !== authorization.authorizationSha256) {
        throw new RangeError("wind canary authorization SHA-256 mismatch");
    }
}
// verify exact permanent operator authorization links
export function verifyPermanentForecastAdjustmentWindCanaryAuthorization(authorization, candidate, report) {
    verifyForecastAdjustmentWindCanaryCandidate(candidate);
    verifyForecastAdjustmentWindCanaryTransferReport(report, candidate);
    requireExactKeys(authorization, PERMANENT_AUTHORIZATION_KEYS, "permanent wind canary authorization");
    // require one explicit immutable permanent authorization
    if (authorization.artifactKind !== "wind_transfer_canary_authorization" ||
        authorization.contractVersion !==
            FORECAST_ADJUSTMENT_WIND_CANARY_AUTHORIZATION_CONTRACT_VERSION_V2 ||
        authorization.authorized !== true ||
        authorization.permanent !== true ||
        authorization.expiresAt !== null ||
        authorization.candidateArtifactSha256 !== candidate.candidateArtifactSha256 ||
        authorization.transferReportSha256 !== report.transferReportSha256 ||
        canonicalizeJson(authorization.enabledMetricBands) !==
            canonicalizeJson(candidate.enabledMetricBands)) {
        throw new RangeError("permanent wind canary authorization cross-link mismatch");
    }
    validateHash(authorization.authorizationSha256, "authorizationSha256");
    validateText(authorization.authorizationReason, "authorizationReason");
    validateText(authorization.authorizedBy, "authorizedBy");
    const authorizedAt = Date.parse(validateUtcInstant(authorization.authorizedAt, "authorizedAt"));
    const activatedAt = Date.parse(validateUtcInstant(authorization.activatedAt, "activatedAt"));
    // require authority after evidence and before activation
    if (authorizedAt < Date.parse(report.bridgeEndExclusive) ||
        activatedAt < authorizedAt) {
        throw new RangeError("permanent wind canary authorization timing is invalid");
    }
    // reject any fully rehashed authorization mutation
    if (canonicalObjectSha256(authorization, "authorizationSha256") !== authorization.authorizationSha256) {
        throw new RangeError("wind canary authorization SHA-256 mismatch");
    }
}
// package separately reviewed canary artifacts
export function createForecastAdjustmentWindCanaryRuntimeBundle(input) {
    verifyForecastAdjustmentWindCanaryCandidate(input.candidate);
    verifyForecastAdjustmentWindCanaryTransferReport(input.transferReport, input.candidate);
    verifyForecastAdjustmentWindCanaryAuthorization(input.authorization, input.candidate, input.transferReport);
    const unsigned = {
        artifactKind: "wind_transfer_canary_runtime_bundle",
        authorization: cloneJson(input.authorization),
        candidate: cloneJson(input.candidate),
        contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRuntimeBundle,
        siteKey: "ballydidean",
        timezone: "America/Los_Angeles",
        transferReport: cloneJson(input.transferReport),
    };
    const bundle = deepFreeze({
        ...unsigned,
        bundleSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
    return bundle;
}
// package separately reviewed artifacts with permanent authority
export function createPermanentForecastAdjustmentWindCanaryRuntimeBundle(input) {
    verifyForecastAdjustmentWindCanaryCandidate(input.candidate);
    verifyForecastAdjustmentWindCanaryTransferReport(input.transferReport, input.candidate);
    verifyPermanentForecastAdjustmentWindCanaryAuthorization(input.authorization, input.candidate, input.transferReport);
    const unsigned = {
        artifactKind: "wind_transfer_canary_runtime_bundle",
        authorization: cloneJson(input.authorization),
        candidate: cloneJson(input.candidate),
        contractVersion: FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2,
        siteKey: "ballydidean",
        timezone: "America/Los_Angeles",
        transferReport: cloneJson(input.transferReport),
    };
    const bundle = deepFreeze({
        ...unsigned,
        bundleSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
    return bundle;
}
// verify every nested canary artifact and content hash
export function verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle) {
    requireExactKeys(bundle, BUNDLE_KEYS, "wind canary runtime bundle");
    // require the isolated runtime identity
    if (bundle.artifactKind !== "wind_transfer_canary_runtime_bundle" ||
        bundle.siteKey !== "ballydidean" ||
        bundle.timezone !== "America/Los_Angeles") {
        throw new RangeError("wind canary runtime bundle identity mismatch");
    }
    validateHash(bundle.bundleSha256, "bundleSha256");
    verifyForecastAdjustmentWindCanaryCandidate(bundle.candidate);
    verifyForecastAdjustmentWindCanaryTransferReport(bundle.transferReport, bundle.candidate);
    // preserve finite v1 receipts and admit only explicit permanent v2 receipts
    if (bundle.contractVersion ===
        FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRuntimeBundle) {
        verifyForecastAdjustmentWindCanaryAuthorization(bundle.authorization, bundle.candidate, bundle.transferReport);
    }
    else if (bundle.contractVersion ===
        FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2) {
        verifyPermanentForecastAdjustmentWindCanaryAuthorization(bundle.authorization, bundle.candidate, bundle.transferReport);
    }
    else {
        throw new RangeError("wind canary runtime bundle identity mismatch");
    }
    // reject outer bundle substitution
    if (canonicalObjectSha256(bundle, "bundleSha256") !== bundle.bundleSha256) {
        throw new RangeError("wind canary runtime bundle SHA-256 mismatch");
    }
}
// validate a separately selected canary bundle
export function validateForecastAdjustmentWindCanaryRegistry(registry) {
    requireExactKeys(registry, REGISTRY_KEYS, "wind canary registry");
    // require the isolated registry contract
    if (registry.contractVersion !==
        FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.windCanaryRegistry) {
        throw new RangeError("unsupported wind canary registry contract");
    }
    // permit a reviewed inactive canary registry
    if (registry.activeBundle === null) {
        return;
    }
    const active = registry.activeBundle;
    requireExactKeys(active, REGISTRY_ACTIVE_KEYS, "wind canary active bundle");
    validateHash(active.authorizationSha256, "activeBundle.authorizationSha256");
    validateHash(active.bundleSha256, "activeBundle.bundleSha256");
    validateHash(active.candidateArtifactSha256, "activeBundle.candidateArtifactSha256");
    validateHash(active.transferReportSha256, "activeBundle.transferReportSha256");
    // require one exact content-addressed relative path
    if (active.path !== `wind-canary-bundles/sha256-${active.bundleSha256}.json`) {
        throw new RangeError("wind canary registry path is invalid");
    }
}
// validate a separately selected canary bundle
export function validateForecastAdjustmentWindCanaryRuntimeBundleLinks(registry, bundle) {
    validateForecastAdjustmentWindCanaryRegistry(registry);
    verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
    // require an active registry selection
    if (registry.activeBundle === null) {
        throw new RangeError("wind canary registry has no active bundle");
    }
    const active = registry.activeBundle;
    // require exact registry-to-bundle cross-links
    if (active.bundleSha256 !== bundle.bundleSha256 ||
        active.authorizationSha256 !== bundle.authorization.authorizationSha256 ||
        active.candidateArtifactSha256 !==
            bundle.candidate.candidateArtifactSha256 ||
        active.transferReportSha256 !== bundle.transferReport.transferReportSha256) {
        throw new RangeError("wind canary registry cross-link mismatch");
    }
}
// report whether the current instant is authorized after activation
export function forecastAdjustmentWindCanaryIsActiveAt(bundle, now) {
    verifyForecastAdjustmentWindCanaryRuntimeBundle(bundle);
    const instant = Date.parse(validateUtcInstant(now, "now"));
    return (instant >= Date.parse(bundle.authorization.activatedAt) &&
        (bundle.contractVersion ===
            FORECAST_ADJUSTMENT_WIND_CANARY_RUNTIME_BUNDLE_CONTRACT_VERSION_V2 ||
            instant < Date.parse(bundle.authorization.expiresAt)));
}
// interpret only the literal one-way disable value
export function forecastAdjustmentWindCanaryIsKilled(environmentValue) {
    return environmentValue === "1";
}
// validate exact canonical source and station lineage
function validateCanonicalLineage(trainingIdentity, servedIdentity, trainingProvenance) {
    // reject parallel rehashed source identities
    if (canonicalizeJson(trainingIdentity) !==
        canonicalizeJson(FORECAST_ADJUSTMENT_WIND_CANARY_TRAINING_IDENTITY_V1) ||
        canonicalizeJson(servedIdentity) !==
            canonicalizeJson(FORECAST_ADJUSTMENT_CANONICAL_FORECAST_IDENTITY_V1) ||
        canonicalizeJson(trainingProvenance) !==
            canonicalizeJson(FORECAST_ADJUSTMENT_CANONICAL_TRAINING_PROVENANCE_V1)) {
        throw new RangeError("wind canary lineage is not canonical");
    }
}
// validate the closed wind-only candidate material
function validateWindCandidateMaterial(candidate) {
    const sortedBands = sortEnabledMetricBands(candidate.enabledMetricBands);
    const enabledKeys = new Set(sortedBands.map(metricBandKey));
    // require exact enabled pair schemas
    for (const pair of candidate.enabledMetricBands) {
        requireExactKeys(pair, METRIC_BAND_KEYS, "wind canary metric band");
    }
    // require nonempty canonical unique wind-only enabled pairs
    if (sortedBands.length === 0 ||
        enabledKeys.size !== sortedBands.length ||
        canonicalizeJson(sortedBands) !==
            canonicalizeJson(candidate.enabledMetricBands) ||
        sortedBands.some((pair) => !isWindCanaryMetric(pair.metric) ||
            !FORECAST_LEAD_BANDS.some((band) => band.key === pair.leadBand))) {
        throw new RangeError("wind canary enabled set is invalid");
    }
    const rootCounts = new Map([...enabledKeys].map((key) => [key, 0]));
    const coefficientCells = new Set();
    // reject non-wind, disabled, malformed, or out-of-cap coefficients
    for (const coefficient of candidate.coefficients) {
        requireExactKeys(coefficient, COEFFICIENT_KEYS, "wind canary coefficient");
        const key = metricBandKey(coefficient);
        const policy = FORECAST_ADJUSTMENT_METRIC_POLICIES_V1.find((item) => item.metric === coefficient.metric);
        // require one enabled wind coefficient cell
        if (!isWindCanaryMetric(coefficient.metric) ||
            !enabledKeys.has(key) ||
            policy === undefined ||
            !Number.isFinite(coefficient.coefficient) ||
            !Number.isFinite(coefficient.effectiveEventCount) ||
            coefficient.effectiveEventCount < 0 ||
            coefficient.coefficient < policy.correctionMinimum ||
            coefficient.coefficient > policy.correctionMaximum) {
            throw new RangeError("wind canary coefficient is invalid");
        }
        validateCoefficientShape(coefficient);
        const cell = canonicalizeJson({
            daypart: coefficient.daypart,
            leadBand: coefficient.leadBand,
            level: coefficient.level,
            metric: coefficient.metric,
            month: coefficient.month,
            season: coefficient.season,
        });
        // reject duplicate fitted hierarchy cells
        if (coefficientCells.has(cell)) {
            throw new RangeError("wind canary contains a duplicate coefficient cell");
        }
        coefficientCells.add(cell);
        // count required root cells
        if (coefficient.level === 1) {
            rootCounts.set(key, (rootCounts.get(key) ?? 0) + 1);
        }
    }
    // require one fitted root for every enabled pair
    if ([...rootCounts.values()].some((count) => count !== 1)) {
        throw new RangeError("wind canary enabled pair lacks one root coefficient");
    }
    const expectedEnvelopes = sortedBands
        .filter((pair) => pair.metric !== "windDirectionDegrees")
        .map(metricBandKey);
    const actualEnvelopes = candidate.trainingEnvelopes.map(metricBandKey);
    // require exact scalar envelope schemas
    for (const envelope of candidate.trainingEnvelopes) {
        requireExactKeys(envelope, TRAINING_ENVELOPE_KEYS, "wind canary training envelope");
    }
    // require exact scalar envelope coverage without direction envelopes
    if (canonicalizeJson(actualEnvelopes) !== canonicalizeJson(expectedEnvelopes) ||
        canonicalizeJson(candidate.coefficients) !==
            canonicalizeJson(sortCoefficients(candidate.coefficients)) ||
        canonicalizeJson(candidate.trainingEnvelopes) !==
            canonicalizeJson(sortTrainingEnvelopes(candidate.trainingEnvelopes)) ||
        candidate.trainingEnvelopes.some((envelope) => !Number.isFinite(envelope.minimum) ||
            !Number.isFinite(envelope.maximum) ||
            envelope.minimum > envelope.maximum)) {
        throw new RangeError("wind canary training envelopes are invalid");
    }
}
// narrow one adjustable metric to the canary allowlist
function isWindCanaryMetric(metric) {
    return (metric === "windDirectionDegrees" ||
        metric === "windGustMps" ||
        metric === "windSpeedMps");
}
// validate one fitted hierarchy cell
function validateCoefficientShape(coefficient) {
    // require the root shape
    if (coefficient.level === 1) {
        if (coefficient.daypart !== null ||
            coefficient.month !== null ||
            coefficient.season !== null ||
            coefficient.effectiveEventCount < 200) {
            throw new RangeError("wind canary root coefficient is invalid");
        }
        return;
    }
    // require one valid refined shape
    if ((coefficient.level !== 2 && coefficient.level !== 3) ||
        coefficient.daypart === null ||
        !["afternoon", "evening", "morning", "night"].includes(coefficient.daypart) ||
        (coefficient.level === 2 &&
            (coefficient.month !== null ||
                coefficient.season === null ||
                !["autumn", "spring", "summer", "winter"].includes(coefficient.season) ||
                coefficient.effectiveEventCount < 100)) ||
        (coefficient.level === 3 &&
            (coefficient.season !== null ||
                coefficient.month === null ||
                !Number.isInteger(coefficient.month) ||
                coefficient.month < 1 ||
                coefficient.month > 12 ||
                coefficient.effectiveEventCount < 50))) {
        throw new RangeError("wind canary refined coefficient is invalid");
    }
}
// validate one immutable positive bridge score
function validateBridgeScore(score) {
    const values = [
        score.adjustedLoss,
        score.eventCount,
        score.rawLoss,
        score.skill,
    ];
    const derivedSkill = score.rawLoss === 0
        ? score.adjustedLoss === 0
            ? 0
            : Number.NEGATIVE_INFINITY
        : (score.rawLoss - score.adjustedLoss) / score.rawLoss;
    // require literal positive transfer evidence
    if (values.some((value) => !Number.isFinite(value)) ||
        !Number.isSafeInteger(score.eventCount) ||
        score.eventCount < 30 ||
        score.adjustedLoss < 0 ||
        score.rawLoss <= 0 ||
        score.skill <= 0 ||
        Math.abs(derivedSkill - score.skill) > Number.EPSILON * 16) {
        throw new RangeError("wind canary bridge score is not positive finite evidence");
    }
}
// sort fitted cells deterministically
function sortCoefficients(coefficients) {
    return [...coefficients].map(cloneJson).sort((left, right) => metricBandKey(left).localeCompare(metricBandKey(right)) ||
        left.level - right.level ||
        (left.season ?? "").localeCompare(right.season ?? "") ||
        (left.month ?? 0) - (right.month ?? 0) ||
        (left.daypart ?? "").localeCompare(right.daypart ?? ""));
}
// sort scalar envelopes deterministically
function sortTrainingEnvelopes(envelopes) {
    return [...envelopes].map(cloneJson).sort((left, right) => metricBandKey(left).localeCompare(metricBandKey(right)));
}
// require one exact closed object schema
function requireExactKeys(value, expected, description) {
    const actual = Object.keys(value).sort();
    // reject missing or added fields
    if (canonicalizeJson(actual) !== canonicalizeJson([...expected].sort())) {
        throw new RangeError(`${description} has unexpected fields`);
    }
}
// validate one lowercase content hash
function validateHash(value, description) {
    // reject malformed immutable identities
    if (!HASH_PATTERN.test(value)) {
        throw new RangeError(`${description} must be a SHA-256 hex value`);
    }
    return value;
}
// validate one bounded nonempty label
function validateText(value, description) {
    // reject empty or unbounded operator material
    if (value.trim() !== value ||
        value.length < 1 ||
        value.length > 256 ||
        /[\r\n]|:\/\/|\b(?:credential|password|private[-_ ]?key|secret|token)\b/iu.test(value)) {
        throw new RangeError(`${description} must be bounded nonempty text`);
    }
    return value;
}
// validate one canonical UTC instant
function validateUtcInstant(value, description) {
    const milliseconds = Date.parse(value);
    // require exact millisecond UTC serialization
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        throw new RangeError(`${description} must be a canonical UTC instant`);
    }
    return value;
}
// clone canonical JSON without aliases
function cloneJson(value) {
    return JSON.parse(canonicalizeJson(value));
}
