import { canonicalObjectSha256, canonicalSha256, deepFreeze, } from "./candidate.js";
import { runtimeCalendarFingerprintMatches } from "./calendar.js";
import { TEMPERATURE_PERMANENT_MODEL_CONTRACT_VERSION, TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY, applyEcmwfTemperatureMosRuntime, } from "./temperature-mos-runtime.js";
export const TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION = "forecast-adjustment-temperature-canary-bundle/v1";
// identify permanent authorization contracts
export const TEMPERATURE_CANARY_AUTHORIZATION_CONTRACT_VERSION_V2 = "forecast-adjustment-temperature-canary-authorization/v2";
export const TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION_V2 = "forecast-adjustment-temperature-canary-bundle/v2";
export const TEMPERATURE_CANARY_REGISTRY_CONTRACT_VERSION = "forecast-adjustment-temperature-canary-registry/v1";
export const TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION = "forecast-temperature-canary-decision/v1";
export const TEMPERATURE_CANARY_MAXIMUM_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const BUNDLE_KEYS = [
    "artifactKind",
    "authorization",
    "bundleSha256",
    "contractVersion",
    "evidence",
    "model",
    "runtimeFingerprint",
    "servedForecastIdentity",
    "siteKey",
    "timezone",
    "trainingForecastIdentity",
];
const AUTHORIZATION_KEYS = [
    "activatedAt",
    "authorizationReason",
    "authorizationSha256",
    "authorized",
    "authorizedAt",
    "authorizedBy",
    "expiresAt",
];
const PERMANENT_AUTHORIZATION_KEYS = [
    "activatedAt",
    "artifactKind",
    "authorizationReason",
    "authorizationSha256",
    "authorized",
    "authorizedAt",
    "authorizedBy",
    "contractVersion",
    "expiresAt",
    "permanent",
];
const EVIDENCE_KEYS = [
    "modelSourceSha256",
    "researchSummarySha256",
    "retentionManifestSha256",
    "strengthSourceSha256",
];
const RUNTIME_FINGERPRINT_KEYS = ["icuVersion", "tzdataVersion"];
const SERVED_IDENTITY_KEYS = [
    "adapterVersion",
    "dataset",
    "maximumReceiptAgeHours",
    "providerKey",
    "sourceDelayHours",
    "upstreamModel",
];
const TRAINING_IDENTITY_KEYS = ["cohort", "scope"];
const MODEL_KEYS = [
    "adaptiveCoefficients",
    "cohort",
    "contractVersion",
    "directCoefficients",
    "learnedStrengthContractVersion",
    "month",
    "scope",
    "strengthBands",
    "supported",
    "trainingCutoffUtc",
];
const PERMANENT_MODEL_KEYS = [
    "adaptiveCoefficients",
    "cohort",
    "contractVersion",
    "directCoefficients",
    "effectiveFrom",
    "latestTrainingValidAt",
    "learnedStrengthContractVersion",
    "scope",
    "strengthBands",
    "supported",
    "trainingCutoffUtc",
];
const STRENGTH_KEYS = ["alpha", "supported", "trainingCutoffUtc"];
const REGISTRY_KEYS = ["activeBundle", "contractVersion"];
const ACTIVE_REGISTRY_KEYS = [
    "authorizationSha256",
    "bundleSha256",
    "modelSourceSha256",
    "path",
    "strengthSourceSha256",
];
// carry one public fail-raw classification
class TemperatureCanaryFailure extends Error {
    reasonCode;
    // retain the exact bounded reason
    constructor(reasonCode) {
        super(reasonCode);
        this.reasonCode = reasonCode;
    }
}
// create one short-lived immutable canary authorization
export function createForecastAdjustmentTemperatureCanaryAuthorization(input) {
    const unsigned = {
        activatedAt: validateUtcInstant(input.activatedAt, "activatedAt"),
        authorizationReason: validateText(input.authorizationReason, "authorizationReason"),
        authorized: true,
        authorizedAt: validateUtcInstant(input.authorizedAt, "authorizedAt"),
        authorizedBy: validateText(input.authorizedBy, "authorizedBy"),
        expiresAt: validateUtcInstant(input.expiresAt, "expiresAt"),
    };
    const authorization = deepFreeze({
        ...unsigned,
        authorizationSha256: canonicalSha256(unsigned),
    });
    validateAuthorization(authorization);
    return authorization;
}
// create one permanent immutable operator authorization
export function createPermanentForecastAdjustmentTemperatureCanaryAuthorization(input) {
    const unsigned = {
        activatedAt: validateUtcInstant(input.activatedAt, "activatedAt"),
        artifactKind: "ecmwf_temperature_transfer_canary_authorization",
        authorizationReason: validateText(input.authorizationReason, "authorizationReason"),
        authorized: true,
        authorizedAt: validateUtcInstant(input.authorizedAt, "authorizedAt"),
        authorizedBy: validateText(input.authorizedBy, "authorizedBy"),
        contractVersion: TEMPERATURE_CANARY_AUTHORIZATION_CONTRACT_VERSION_V2,
        expiresAt: null,
        permanent: true,
    };
    const authorization = deepFreeze({
        ...unsigned,
        authorizationSha256: canonicalSha256(unsigned),
    });
    validatePermanentAuthorization(authorization);
    return authorization;
}
// create one content-addressed sanitized canary bundle
export function createForecastAdjustmentTemperatureCanaryRuntimeBundle(input) {
    const unsigned = {
        artifactKind: "ecmwf_temperature_transfer_canary",
        authorization: cloneJson(input.authorization),
        contractVersion: TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION,
        evidence: cloneJson(input.evidence),
        model: cloneJson(input.model),
        runtimeFingerprint: cloneJson(input.runtimeFingerprint),
        servedForecastIdentity: cloneJson(input.servedForecastIdentity),
        siteKey: "ballydidean",
        timezone: "America/Los_Angeles",
        trainingForecastIdentity: {
            cohort: "ecmwf_single_run_hindcast",
            scope: "assumed_delay6_next12",
        },
    };
    const bundle = deepFreeze({
        ...unsigned,
        bundleSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
    return bundle;
}
// create one content-addressed permanent canary bundle
export function createPermanentForecastAdjustmentTemperatureCanaryRuntimeBundle(input) {
    const unsigned = {
        artifactKind: "ecmwf_temperature_transfer_canary",
        authorization: cloneJson(input.authorization),
        contractVersion: TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION_V2,
        evidence: cloneJson(input.evidence),
        model: cloneJson(input.model),
        runtimeFingerprint: cloneJson(input.runtimeFingerprint),
        servedForecastIdentity: cloneJson(input.servedForecastIdentity),
        siteKey: "ballydidean",
        timezone: "America/Los_Angeles",
        trainingForecastIdentity: {
            cohort: "ecmwf_single_run_hindcast",
            scope: "assumed_delay6_next12",
        },
    };
    const bundle = deepFreeze({
        ...unsigned,
        bundleSha256: canonicalSha256(unsigned),
    });
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
    return bundle;
}
// verify the closed sanitized model and authorization envelope
export function verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle) {
    requireExactKeys(bundle, BUNDLE_KEYS, "temperature canary bundle");
    // bind the separate transfer-canary identity
    if (bundle.artifactKind !== "ecmwf_temperature_transfer_canary" ||
        bundle.siteKey !== "ballydidean" ||
        bundle.timezone !== "America/Los_Angeles") {
        throw new RangeError("temperature canary bundle identity mismatch");
    }
    validateHash(bundle.bundleSha256, "bundleSha256");
    // preserve finite v1 receipts and admit only explicit permanent v2 receipts
    if (bundle.contractVersion === TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION) {
        validateAuthorization(bundle.authorization);
        // keep finite receipts tied to monthly material
        if (bundle.model.contractVersion !== "temperature-shortlead-models-research/v1") {
            throw new RangeError("temperature canary model contract mismatch");
        }
    }
    else if (bundle.contractVersion === TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION_V2) {
        validatePermanentAuthorization(bundle.authorization);
        // require permanent receipts to carry static material
        if (bundle.model.contractVersion !== TEMPERATURE_PERMANENT_MODEL_CONTRACT_VERSION) {
            throw new RangeError("temperature canary model contract mismatch");
        }
    }
    else {
        throw new RangeError("temperature canary bundle identity mismatch");
    }
    requireExactKeys(bundle.evidence, EVIDENCE_KEYS, "temperature canary evidence");
    // require immutable evidence identities
    for (const [key, value] of Object.entries(bundle.evidence)) {
        validateHash(value, key);
    }
    requireExactKeys(bundle.runtimeFingerprint, RUNTIME_FINGERPRINT_KEYS, "temperature canary runtime fingerprint");
    validateText(bundle.runtimeFingerprint.icuVersion, "icuVersion");
    validateText(bundle.runtimeFingerprint.tzdataVersion, "tzdataVersion");
    requireExactKeys(bundle.servedForecastIdentity, SERVED_IDENTITY_KEYS, "temperature canary served identity");
    // bind live serving to one explicit single-runs source
    if (bundle.servedForecastIdentity.dataset !== "single_run" ||
        bundle.servedForecastIdentity.adapterVersion !==
            "open-meteo-ecmwf-single-run/v1" ||
        bundle.servedForecastIdentity.providerKey !== "open-meteo" ||
        bundle.servedForecastIdentity.upstreamModel !== "ecmwf_ifs" ||
        bundle.servedForecastIdentity.sourceDelayHours !== 6 ||
        !Number.isInteger(bundle.servedForecastIdentity.maximumReceiptAgeHours) ||
        bundle.servedForecastIdentity.maximumReceiptAgeHours < 6 ||
        bundle.servedForecastIdentity.maximumReceiptAgeHours > 12) {
        throw new RangeError("temperature canary served identity mismatch");
    }
    requireExactKeys(bundle.trainingForecastIdentity, TRAINING_IDENTITY_KEYS, "temperature canary training identity");
    // disclose the exact hindcast-to-live transfer boundary
    if (bundle.trainingForecastIdentity.cohort !== "ecmwf_single_run_hindcast" ||
        bundle.trainingForecastIdentity.scope !== "assumed_delay6_next12") {
        throw new RangeError("temperature canary training identity mismatch");
    }
    validateSanitizedModel(bundle.model);
    // reject any nested or outer substitution
    if (canonicalObjectSha256(bundle, "bundleSha256") !== bundle.bundleSha256) {
        throw new RangeError("temperature canary bundle SHA-256 mismatch");
    }
}
// validate one content-addressed registry selection
export function validateForecastAdjustmentTemperatureCanaryRegistry(registry) {
    requireExactKeys(registry, REGISTRY_KEYS, "temperature canary registry");
    // isolate the registry contract
    if (registry.contractVersion !== TEMPERATURE_CANARY_REGISTRY_CONTRACT_VERSION) {
        throw new RangeError("unsupported temperature canary registry contract");
    }
    // permit an intentionally inactive registry
    if (registry.activeBundle === null) {
        return;
    }
    const active = registry.activeBundle;
    requireExactKeys(active, ACTIVE_REGISTRY_KEYS, "temperature canary active bundle");
    validateHash(active.authorizationSha256, "authorizationSha256");
    validateHash(active.bundleSha256, "bundleSha256");
    validateHash(active.modelSourceSha256, "modelSourceSha256");
    validateHash(active.strengthSourceSha256, "strengthSourceSha256");
    // require the one closed relative bundle path
    if (active.path !==
        `temperature-canary-bundles/sha256-${active.bundleSha256}.json`) {
        throw new RangeError("temperature canary registry path is invalid");
    }
}
// validate registry links without tolerating substituted evidence
export function validateForecastAdjustmentTemperatureCanaryRuntimeBundleLinks(registry, bundle) {
    validateForecastAdjustmentTemperatureCanaryRegistry(registry);
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
    // require one active exact selection
    if (registry.activeBundle === null) {
        throw new RangeError("temperature canary registry has no active bundle");
    }
    const active = registry.activeBundle;
    // bind every selected identity to bundle content
    if (active.bundleSha256 !== bundle.bundleSha256 ||
        active.authorizationSha256 !== bundle.authorization.authorizationSha256 ||
        active.modelSourceSha256 !== bundle.evidence.modelSourceSha256 ||
        active.strengthSourceSha256 !== bundle.evidence.strengthSourceSha256) {
        throw new RangeError("temperature canary registry cross-link mismatch");
    }
}
// report whether one instant is authorized after activation
export function forecastAdjustmentTemperatureCanaryIsActiveAt(bundle, now) {
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
    const instant = Date.parse(validateUtcInstant(now, "now"));
    return (instant >= Date.parse(bundle.authorization.activatedAt) &&
        (bundle.contractVersion === TEMPERATURE_CANARY_BUNDLE_CONTRACT_VERSION_V2 ||
            instant < Date.parse(bundle.authorization.expiresAt)));
}
// default closed unless the operator explicitly enables the canary
export function forecastAdjustmentTemperatureCanaryIsKilled(environmentValue) {
    return environmentValue !== "0";
}
// apply one independent live-source temperature decision
export function applyForecastAdjustmentTemperatureCanary(runtime, input) {
    return applyTemperatureCanaryRuntime(runtime, input, true);
}
// evaluate one verified inactive temperature candidate without activation authority
export function applyForecastAdjustmentTemperatureShadowCandidate(bundle, input) {
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
    return applyTemperatureCanaryRuntime({ bundle, reasonCode: null, state: "active" }, input, false);
}
// evaluate one authority-free monthly temperature package
export function applyForecastAdjustmentTemperatureMaintenanceCandidate(material, input) {
    validateHash(material.bundleSha256, "bundleSha256");
    return applyTemperatureCanaryRuntime({ bundle: material, reasonCode: null, state: "active" }, input, false);
}
// share source validation and numerical evaluation across active and shadow paths
function applyTemperatureCanaryRuntime(runtime, input, enforceAuthorization) {
    // keep loader failures separate from forecast availability
    if (runtime.state === "disabled") {
        return fallbackDecision(input.rawBestMatchTemperatureC, "disabled", runtime.reasonCode);
    }
    const source = input.sourceForecast;
    // fail raw when the sidecar has no matching hour
    if (source === null || input.recentErrorState === null) {
        return fallbackDecision(input.rawBestMatchTemperatureC, "raw_fallback", "missing_source_forecast", runtime.bundle.bundleSha256);
    }
    try {
        validateUtcInstant(input.evaluatedAt, "evaluatedAt");
        validateUtcInstant(input.validAt, "validAt");
        const maintenance = "maintenanceAuthority" in runtime.bundle;
        // recheck the applicable root or legacy authorization after startup caching
        if (enforceAuthorization && (maintenance
            ? runtime.bundle.maintenanceAuthority === null
            : !forecastAdjustmentTemperatureCanaryIsActiveAt(runtime.bundle, input.evaluatedAt))) {
            return fallbackDecision(input.rawBestMatchTemperatureC, "disabled", maintenance ? "registry_invalid" : "canary_expired");
        }
        validateSourceForecast(runtime.bundle, source, input);
        const operationalHorizonHours = source.modelLeadHours -
            runtime.bundle.servedForecastIdentity.sourceDelayHours;
        const sourceForecast = deepFreeze({ ...source, operationalHorizonHours });
        const recentErrorStateSha256 = canonicalSha256(input.recentErrorState);
        const result = applyEcmwfTemperatureMosRuntime({
            forecast: {
                cohort: runtime.bundle.trainingForecastIdentity.cohort,
                key: `${source.providerResponseSha256}:${source.validAt}`,
                modelCycle: source.modelCycle,
                modelLeadHours: source.modelLeadHours,
                rawRelativeHumidityPercent: source.rawRelativeHumidityPercent,
                rawTemperatureC: source.rawTemperatureC,
                rawWindSpeedMps: source.rawWindSpeedMps,
                runInitializedAt: source.runInitializedAt,
                validAt: source.validAt,
            },
            model: runtime.bundle.model,
            recentErrorState: input.recentErrorState,
        });
        // preserve raw when the numerical core rejects any input
        if (!result.applied) {
            return deepFreeze({
                branch: null,
                bundleSha256: runtime.bundle.bundleSha256,
                contractVersion: TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION,
                correctedTemperatureC: null,
                rawBestMatchTemperatureC: input.rawBestMatchTemperatureC,
                reasonCode: result.reason,
                recentErrorStateSha256,
                sourceForecast,
                state: "raw_fallback",
            });
        }
        return deepFreeze({
            branch: result.branch,
            bundleSha256: runtime.bundle.bundleSha256,
            contractVersion: TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION,
            correctedTemperatureC: result.predictionTemperatureC,
            rawBestMatchTemperatureC: input.rawBestMatchTemperatureC,
            reasonCode: null,
            recentErrorStateSha256,
            sourceForecast,
            state: "active",
        });
    }
    catch (error) {
        return fallbackDecision(input.rawBestMatchTemperatureC, "raw_fallback", error instanceof TemperatureCanaryFailure
            ? error.reasonCode
            : "source_identity_mismatch", runtime.bundle.bundleSha256);
    }
}
// validate one truthful live source receipt
function validateSourceForecast(bundle, source, input) {
    const evaluatedAt = Date.parse(validateUtcInstant(input.evaluatedAt, "evaluatedAt"));
    const runInitializedAt = Date.parse(validateUtcInstant(source.runInitializedAt, "runInitializedAt"));
    const firstReceivedAt = Date.parse(validateUtcInstant(source.firstReceivedAt, "firstReceivedAt"));
    const validAt = Date.parse(validateUtcInstant(source.validAt, "source.validAt"));
    validateHash(source.providerResponseSha256, "providerResponseSha256");
    validateText(source.adapterVersion, "adapterVersion");
    // bind the live source to the served identity
    if (source.adapterVersion !== bundle.servedForecastIdentity.adapterVersion ||
        source.providerKey !== bundle.servedForecastIdentity.providerKey ||
        source.dataset !== bundle.servedForecastIdentity.dataset ||
        source.upstreamModel !== bundle.servedForecastIdentity.upstreamModel) {
        throw new TemperatureCanaryFailure("source_identity_mismatch");
    }
    // bind this sidecar hour to exactly one requested public hour
    if (source.validAt !== input.validAt ||
        validAt - runInitializedAt !== source.modelLeadHours * 3_600_000) {
        throw new TemperatureCanaryFailure("source_time_mismatch");
    }
    const assumedAvailableAt = runInitializedAt + bundle.servedForecastIdentity.sourceDelayHours * 3_600_000;
    const availableAt = Math.max(firstReceivedAt, assumedAvailableAt);
    const maximumReceiptAgeMilliseconds = bundle.servedForecastIdentity.maximumReceiptAgeHours * 3_600_000;
    // reject backdated, future, and stale acquisition receipts
    if (firstReceivedAt < runInitializedAt || evaluatedAt < availableAt) {
        throw new TemperatureCanaryFailure("source_not_available");
    }
    // reject a run after its bounded serving lifetime
    if (evaluatedAt - availableAt > maximumReceiptAgeMilliseconds) {
        throw new TemperatureCanaryFailure("source_stale");
    }
    // constrain serving to fitted future operational hours
    if (validAt <= evaluatedAt ||
        !Number.isInteger(source.modelLeadHours) ||
        source.modelLeadHours < 7 ||
        source.modelLeadHours > 18) {
        throw new TemperatureCanaryFailure("outside_operational_window");
    }
}
// validate the sanitized exact-width delayed model
function validateSanitizedModel(model) {
    const permanent = model.contractVersion === TEMPERATURE_PERMANENT_MODEL_CONTRACT_VERSION;
    requireExactKeys(model, permanent ? PERMANENT_MODEL_KEYS : MODEL_KEYS, "temperature canary model");
    // prohibit other research scopes and unsupported material
    if ((model.contractVersion !== "temperature-shortlead-models-research/v1" &&
        model.contractVersion !== TEMPERATURE_PERMANENT_MODEL_CONTRACT_VERSION) ||
        model.learnedStrengthContractVersion !==
            "temperature-winner-extensions-research/v1" ||
        model.cohort !== "ecmwf_single_run_hindcast" ||
        model.scope !== TEMPERATURE_MOS_DELAYED_RUNTIME_POLICY.scope ||
        model.supported !== true) {
        throw new RangeError("temperature canary model identity mismatch");
    }
    const cutoff = Date.parse(validateUtcInstant(model.trainingCutoffUtc, "trainingCutoffUtc"));
    // preserve monthly identity or bind the permanent causal fit
    if (permanent) {
        const staticModel = model;
        const effectiveFrom = Date.parse(validateUtcInstant(staticModel.effectiveFrom, "effectiveFrom"));
        const latestTrainingValidAt = Date.parse(validateUtcInstant(staticModel.latestTrainingValidAt, "latestTrainingValidAt"));
        // reject future labels and serving before the frozen fit
        if (latestTrainingValidAt + 7 * 3_600_000 > cutoff || cutoff > effectiveFrom) {
            throw new RangeError("permanent temperature training boundary is invalid");
        }
    }
    else if (!/^\d{4}-\d{2}$/u.test(model.month)) {
        throw new RangeError("temperature canary model identity mismatch");
    }
    validateCoefficientVector(model.directCoefficients, 35, "directCoefficients");
    validateCoefficientVector(model.adaptiveCoefficients, 49, "adaptiveCoefficients");
    // require only the two learned operational bands
    if (model.strengthBands === null ||
        typeof model.strengthBands !== "object" ||
        Object.keys(model.strengthBands).sort().join(",") !== "1-6,7-12") {
        throw new RangeError("temperature canary strength bands are invalid");
    }
    // bind learned strengths to the same fit cutoff
    for (const key of ["1-6", "7-12"]) {
        const band = model.strengthBands[key];
        requireExactKeys(band, STRENGTH_KEYS, `temperature strength ${key}`);
        // accept only the retained fully supported learned winner
        if (band.supported !== true ||
            band.alpha !== 1 ||
            band.trainingCutoffUtc !== model.trainingCutoffUtc) {
            throw new RangeError("temperature canary strength band mismatch");
        }
    }
}
// validate one exact finite coefficient payload
function validateCoefficientVector(value, width, description) {
    // reject absent, extra, or nonfinite model content
    if (!Array.isArray(value) ||
        value.length !== width ||
        value.some((coefficient) => !Number.isFinite(coefficient))) {
        throw new RangeError(`${description} is invalid`);
    }
}
// validate one short-lived authorization receipt
function validateAuthorization(authorization) {
    requireExactKeys(authorization, AUTHORIZATION_KEYS, "temperature authorization");
    validateHash(authorization.authorizationSha256, "authorizationSha256");
    validateText(authorization.authorizedBy, "authorizedBy");
    validateText(authorization.authorizationReason, "authorizationReason");
    const authorizedAt = Date.parse(validateUtcInstant(authorization.authorizedAt, "authorizedAt"));
    const activatedAt = Date.parse(validateUtcInstant(authorization.activatedAt, "activatedAt"));
    const expiresAt = Date.parse(validateUtcInstant(authorization.expiresAt, "expiresAt"));
    // require explicit authority and no more than fourteen days
    if (authorization.authorized !== true ||
        authorizedAt > activatedAt ||
        expiresAt <= activatedAt ||
        expiresAt - activatedAt > TEMPERATURE_CANARY_MAXIMUM_DURATION_MS) {
        throw new RangeError("temperature canary authorization window is invalid");
    }
    // reject authorization mutation
    if (canonicalObjectSha256(authorization, "authorizationSha256") !== authorization.authorizationSha256) {
        throw new RangeError("temperature canary authorization SHA-256 mismatch");
    }
}
// validate one permanent authorization receipt
function validatePermanentAuthorization(authorization) {
    requireExactKeys(authorization, PERMANENT_AUTHORIZATION_KEYS, "permanent temperature authorization");
    validateHash(authorization.authorizationSha256, "authorizationSha256");
    validateText(authorization.authorizedBy, "authorizedBy");
    validateText(authorization.authorizationReason, "authorizationReason");
    const authorizedAt = Date.parse(validateUtcInstant(authorization.authorizedAt, "authorizedAt"));
    const activatedAt = Date.parse(validateUtcInstant(authorization.activatedAt, "activatedAt"));
    // require explicit permanent authority before activation
    if (authorization.artifactKind !==
        "ecmwf_temperature_transfer_canary_authorization" ||
        authorization.contractVersion !==
            TEMPERATURE_CANARY_AUTHORIZATION_CONTRACT_VERSION_V2 ||
        authorization.authorized !== true ||
        authorization.permanent !== true ||
        authorization.expiresAt !== null ||
        authorizedAt > activatedAt) {
        throw new RangeError("permanent temperature authorization is invalid");
    }
    // reject authorization mutation
    if (canonicalObjectSha256(authorization, "authorizationSha256") !== authorization.authorizationSha256) {
        throw new RangeError("temperature canary authorization SHA-256 mismatch");
    }
}
// create one schema-complete raw decision
function fallbackDecision(rawBestMatchTemperatureC, state, reasonCode, bundleSha256 = null) {
    return deepFreeze({
        branch: null,
        bundleSha256,
        contractVersion: TEMPERATURE_CANARY_DECISION_CONTRACT_VERSION,
        correctedTemperatureC: null,
        rawBestMatchTemperatureC,
        reasonCode,
        recentErrorStateSha256: null,
        sourceForecast: null,
        state,
    });
}
// require one exact closed object schema
function requireExactKeys(value, expected, description) {
    const actual = Object.keys(value).sort();
    // reject missing or added fields
    if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
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
// validate one bounded public or operator label
function validateText(value, description) {
    // reject empty, unbounded, or credential-like material
    if (typeof value !== "string" ||
        value.trim() !== value ||
        value.length < 1 ||
        value.length > 256 ||
        /[\r\n]|:\/\/|\b(?:credential|password|private[-_ ]?key|secret|token)\b/iu.test(value)) {
        throw new RangeError(`${description} must be bounded nonempty text`);
    }
    return value;
}
// validate one canonical utc instant
function validateUtcInstant(value, description) {
    const milliseconds = Date.parse(value);
    // require exact millisecond utc serialization
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        throw new RangeError(`${description} must be a canonical UTC instant`);
    }
    return value;
}
// clone one immutable json value
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
// expose loader fingerprint validation without model leakage
export function temperatureCanaryRuntimeFingerprintMatches(bundle) {
    verifyForecastAdjustmentTemperatureCanaryRuntimeBundle(bundle);
    return runtimeCalendarFingerprintMatches(bundle.runtimeFingerprint);
}
