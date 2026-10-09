import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
export const MAINTENANCE_SHADOW_VALUES_VERSION = "adjustment-shadow-prediction-values/v3";
export const MAINTENANCE_SHADOW_SOURCE_VERSION = "adjustment-shadow-source-projection/v1";
export const MAINTENANCE_SHADOW_LIMITS = Object.freeze({
    temperature: { rows: 12, bytes: 8_192 },
    wind: { rows: 168, bytes: 65_536 },
    rain: { rows: 23, bytes: 12_288 },
});
export const MAINTENANCE_SHADOW_SOURCE_LIMITS = Object.freeze({
    temperature: { bytes: 64 * 1_024 },
    wind: { bytes: 768 * 1_024 },
    rain: { bytes: 128 * 1_024 },
});
const COMMON_KEYS = ["contractVersion", "family", "registrationSha256", "candidateSha256", "sourceSha256", "dueKey",
    "issuedAt", "sourceReceiptSha256", "inputSha256", "rowCount", "rows"];
const SOURCE_KEYS = ["contractVersion", "family", "registrationSha256", "candidateSha256", "sourceSha256", "dueKey",
    "issuedAt", "rowCount", "rows"];
const TEMPERATURE_SOURCE_KEYS = ["contractVersion", "family", "registrationSha256", "candidateSha256", "sourceSha256",
    "dueKey", "issuedAt", "recentErrorState", "rowCount", "rows"];
const RAIN_SOURCE_KEYS = ["contractVersion", "family", "registrationSha256", "candidateSha256", "sourceSha256", "dueKey",
    "issuedAt", "causalInputs", "rowCount", "rows"];
const RAIN_CAUSAL_KEYS = ["contractVersion", "captureSet", "currentRun", "priorRuns", "stationHours"];
const RAIN_CAPTURE_KEYS = ["claimId", "kind", "stationId", "runInitializedAt", "windowStart", "windowEndExclusive",
    "completedAt", "bodySha256"];
const RAIN_RUN_KEYS = ["runInitializedAt", "completedAt", "contentSha256", "hours"];
const RAIN_RUN_HOUR_KEYS = ["leadHours", "precipitationMm64", "temperatureC64", "relativeHumidityPercent64",
    "cloudCoverPercent64", "pressureHpa64", "windSpeedMps64", "windDirectionDegrees64"];
const RAIN_STATION_HOUR_KEYS = ["hourAt", "receivedAt", "stationId", "precipitationMm64", "temperatureC64"];
const TEMPERATURE_RECENT_STATE_KEYS = ["b24C", "b72C", "cohort", "localDates", "mad72C",
    "maximumSourceRunInitializedAt", "maximumSourceValidAt", "n24", "n72", "sourceKeys", "supported",
    "targetRunInitializedAt", "windowEndValidAt"];
const SOURCE_ROW_KEYS = Object.freeze({
    temperature: ["validAt", "leadHours", "modelLeadHours", "referenceAt", "receivedAt", "sourceSha256",
        "contentSha256", "adapterVersion", "dataset", "providerKey", "providerResponseSha256", "modelCycle",
        "upstreamModel", "rawTemperatureC64", "rawRelativeHumidityPercent64", "rawWindSpeedMps64",
        "bestMatchContentSha256", "bestMatchProductRunAt", "bestMatchSourceId", "bestMatchTemperatureC64"],
    wind: ["validAt", "leadHours", "modelLeadHours", "referenceAt", "receivedAt", "sourceSha256",
        "contentSha256", "adapterVersion", "contractEpoch", "dataset", "providerKey", "sourceKey",
        "sourceConfigFingerprint", "upstreamModel", "revisionCount", "windSpeedMps64", "windGustMps64"],
    rain: ["validAt", "leadHours", "modelLeadHours", "referenceAt", "receivedAt", "sourceSha256",
        "contentSha256", "adapterVersion", "contractEpoch", "dataset", "providerKey", "sourceKey",
        "sourceConfigFingerprint", "upstreamModel", "revisionCount", "precipitationMm64"],
});
const ROW_KEYS = Object.freeze({
    temperature: ["validAt", "leadHours", "sourceRowSha256", "candidateTemperatureC64", "wouldApply", "fallbackCode"],
    wind: ["validAt", "leadHours", "sourceRowSha256", "candidateSpeedMps64", "candidateGustMps64", "speedWouldApply", "gustWouldApply"],
    rain: ["validAt", "leadHours", "sourceRowSha256", "occurrenceProbability64", "positiveAmountMm64",
        "candidatePrecipitationMm64", "atLeast1_0Probability64", "atLeast2_5Probability64", "wouldApply", "fallbackCode"],
});
const HASH = /^[a-f0-9]{64}$/u;
const BINARY64 = /^[a-f0-9]{16}$/u;
const FALLBACK_CODES = ["none", "missing_source", "ineligible", "physical_cap", "model_unavailable"];
// bind the exact ordered family schema and fixed limits
export const MAINTENANCE_SHADOW_SCHEMA_SHA256 = Object.freeze(Object.fromEntries(Object.keys(MAINTENANCE_SHADOW_LIMITS).map(
// use only fixed public schema inputs
(family) => [family, sha256(Buffer.from(JSON.stringify({
        contractVersion: MAINTENANCE_SHADOW_VALUES_VERSION, family, commonKeys: COMMON_KEYS,
        rowKeys: ROW_KEYS[family], limits: MAINTENANCE_SHADOW_LIMITS[family],
    }) + "\n"))])));
// encode one finite binary64 in network order without decimal ambiguity
export function encodeMaintenanceBinary64(value) {
    // nonfinite values cannot be serialized into evidence
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new RangeError("shadow value must be finite");
    }
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    return bytes.toString("hex");
}
// decode exactly one finite network-order value
export function decodeMaintenanceBinary64(value) {
    // reject decimal strings and alternate encodings
    if (typeof value !== "string" || !BINARY64.test(value)) {
        throw new RangeError("invalid shadow binary64");
    }
    const decoded = Buffer.from(value, "hex").readDoubleBE();
    // reject all infinities and nan payloads
    if (!Number.isFinite(decoded)) {
        throw new RangeError("shadow value must be finite");
    }
    return decoded;
}
// encode the closed private projection before deriving source identities
export function encodeMaintenanceShadowSourceProjection(value) {
    validateMaintenanceShadowSourceProjection(value);
    const ordered = {};
    const sourceKeys = value.family === "rain"
        ? RAIN_SOURCE_KEYS
        : value.family === "temperature"
            ? TEMPERATURE_SOURCE_KEYS
            : SOURCE_KEYS;
    // preserve source header order independently of caller insertion order
    for (const key of sourceKeys) {
        ordered[key] = key === "rows" ? value.rows.map(
        // preserve the exact source row field order
        (row) => Object.fromEntries(SOURCE_ROW_KEYS[value.family].map((field) => [field, row[field]]))) : key === "causalInputs"
            ? canonicalRainCausalInputs(value.causalInputs)
            : key === "recentErrorState"
                ? canonicalTemperatureRecentErrorState(value.recentErrorState)
                : value[key];
    }
    const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
    // reject a projection that could exceed the bounded private relay
    if (bytes.length > MAINTENANCE_SHADOW_SOURCE_LIMITS[value.family].bytes) {
        throw new RangeError("shadow source projection exceeds its cap");
    }
    return bytes;
}
// parse bounded source bytes and require one canonical projection
export function parseMaintenanceShadowSourceProjection(bytes) {
    // reject oversized input before json allocation
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAINTENANCE_SHADOW_SOURCE_LIMITS.wind.bytes) {
        throw new RangeError("invalid shadow source projection size");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const canonical = encodeMaintenanceShadowSourceProjection(value);
    // reject alternate serialization identities
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("shadow source projection is not canonical");
    }
    return value;
}
// derive source identities only from canonical raw projection bytes
export function createMaintenanceShadowSourceIdentity(bytes) {
    const source = parseMaintenanceShadowSourceProjection(bytes);
    const inputSha256 = sha256(Buffer.from(bytes));
    const sourceRowSha256 = source.rows.map((row) => {
        const canonicalRow = JSON.stringify(Object.fromEntries(SOURCE_ROW_KEYS[source.family].map((field) => [field, row[field]])));
        return sha256(Buffer.from(`adjustment-shadow-source-row/v1\n${source.family}\n${canonicalRow}\n`));
    });
    const sourceReceiptSha256 = sha256(Buffer.from([
        "adjustment-shadow-source-receipt/v1", source.registrationSha256, source.candidateSha256,
        source.sourceSha256, source.dueKey, source.issuedAt, source.rows[0].validAt,
        source.rows.at(-1).validAt, String(source.rowCount), inputSha256,
    ].join("\n")));
    return { inputSha256, sourceReceiptSha256, sourceRowSha256 };
}
// build the only accepted ordered prediction wire representation
export function encodeMaintenanceShadowValues(value, sourceProjectionBytes) {
    validateMaintenanceShadowValues(value);
    validateMaintenanceShadowSourceBinding(value, sourceProjectionBytes);
    return encodeCanonicalMaintenanceShadowValues(value);
}
// parse bounded utf8 and require one canonical closed body
export function parseMaintenanceShadowValues(bytes) {
    // reject oversized input before decoding or allocating json objects
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAINTENANCE_SHADOW_LIMITS.wind.bytes) {
        throw new RangeError("invalid shadow body size");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    validateMaintenanceShadowValues(value);
    const canonical = encodeCanonicalMaintenanceShadowValues(value);
    // duplicate keys, alternate order, numbers and whitespace cannot share an identity
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("shadow body is not canonical");
    }
    return value;
}
// derive the compact identity from the exact already-staged body
export function createMaintenanceShadowPredictionMetadata(bytes, sourceProjectionBytes) {
    const body = parseMaintenanceShadowValues(bytes);
    validateMaintenanceShadowSourceBinding(body, sourceProjectionBytes);
    const predictionBodySha256 = sha256(Buffer.from(bytes));
    const predictionSchemaSha256 = MAINTENANCE_SHADOW_SCHEMA_SHA256[body.family];
    const minValidAt = body.rows[0].validAt;
    const maxValidAt = body.rows.at(-1).validAt;
    // share the exact millisecond clocks with PostgreSQL
    const predictionSha256 = sha256(Buffer.from([
        "adjustment-shadow-prediction/v3", body.registrationSha256, body.candidateSha256,
        body.sourceSha256, body.dueKey, body.issuedAt, minValidAt, maxValidAt,
        body.sourceReceiptSha256, body.inputSha256, predictionBodySha256, predictionSchemaSha256,
        String(body.rowCount), String(bytes.byteLength),
    ].join("\n")));
    return {
        bodyByteCount: bytes.byteLength, candidateSha256: body.candidateSha256,
        dueKey: body.dueKey, inputSha256: body.inputSha256,
        issuedAt: body.issuedAt, maxValidAt, minValidAt, predictionBodySha256, predictionSchemaSha256,
        predictionSha256, registrationSha256: body.registrationSha256,
        rowCount: body.rowCount, sourceReceiptSha256: body.sourceReceiptSha256,
        sourceSha256: body.sourceSha256,
    };
}
// validate identities and before-valid family predictions without qualification
export function validateMaintenanceShadowValues(value) {
    exactKeys(value, COMMON_KEYS);
    // accept only the frozen three families and schema
    if (value.contractVersion !== MAINTENANCE_SHADOW_VALUES_VERSION ||
        !Object.hasOwn(MAINTENANCE_SHADOW_LIMITS, value.family)) {
        throw new RangeError("invalid shadow contract");
    }
    // close every portable identity
    for (const key of ["registrationSha256", "candidateSha256", "sourceSha256", "sourceReceiptSha256", "inputSha256"]) {
        requireHash(value[key]);
    }
    requireInstant(value.issuedAt);
    validateDueKey(value.dueKey);
    const limit = MAINTENANCE_SHADOW_LIMITS[value.family];
    // missing leads are gaps rather than a shortened qualifying body
    if (!Array.isArray(value.rows) || value.rowCount !== limit.rows || value.rows.length !== limit.rows) {
        throw new RangeError("invalid shadow row count");
    }
    let previousValidAt = null;
    // require each ordered lead once and before its actual valid instant
    for (const [index, row] of value.rows.entries()) {
        exactKeys(row, ROW_KEYS[value.family]);
        requireInstant(row.validAt);
        requireHash(row.sourceRowSha256);
        // a reordered, duplicated or late row cannot become prospective evidence
        if (row.leadHours !== index + 1 || row.validAt <= value.issuedAt ||
            (previousValidAt !== null && Date.parse(row.validAt) - Date.parse(previousValidAt) !== 3_600_000)) {
            throw new RangeError("shadow lead or clock differs");
        }
        previousValidAt = row.validAt;
        // temperature predictions retain the existing physical caps
        if (value.family === "temperature") {
            boundedValue(row.candidateTemperatureC64, -100, 70);
            validateFallback(row);
        }
        else if (value.family === "rain") {
            boundedValue(row.occurrenceProbability64, 0, 1);
            boundedValue(row.atLeast1_0Probability64, 0, 1);
            boundedValue(row.atLeast2_5Probability64, 0, 1);
            boundedValue(row.positiveAmountMm64, 0, 30);
            boundedValue(row.candidatePrecipitationMm64, 0, 30);
            validateFallback(row);
        }
        else {
            boundedValue(row.candidateSpeedMps64, 0, 150);
            requireBoolean(row.speedWouldApply);
            requireBoolean(row.gustWouldApply);
            // the disabled gust pair must remain structurally absent
            if (index + 1 >= 49 && index + 1 <= 72) {
                // null and false are the only disabled-gust representation
                if (row.candidateGustMps64 !== null || row.gustWouldApply !== false) {
                    throw new RangeError("disabled gust shadow is present");
                }
            }
            else {
                boundedValue(row.candidateGustMps64, 0, 150);
            }
        }
    }
}
// validate one complete private source projection before hashing
export function validateMaintenanceShadowSourceProjection(value) {
    exactKeys(value, value.family === "rain"
        ? RAIN_SOURCE_KEYS
        : value.family === "temperature"
            ? TEMPERATURE_SOURCE_KEYS
            : SOURCE_KEYS);
    // accept only the fixed projection contract and families
    if (value.contractVersion !== MAINTENANCE_SHADOW_SOURCE_VERSION ||
        !Object.hasOwn(MAINTENANCE_SHADOW_LIMITS, value.family)) {
        throw new RangeError("invalid shadow source projection contract");
    }
    // close every frozen source context identity
    for (const key of ["registrationSha256", "candidateSha256", "sourceSha256"]) {
        requireHash(value[key]);
    }
    requireInstant(value.issuedAt);
    validateDueKey(value.dueKey);
    const limit = MAINTENANCE_SHADOW_LIMITS[value.family];
    // require the complete coupled rain input graph instead of opaque caller bytes
    if (value.family === "rain") {
        validateRainCausalInputs(value.causalInputs, value.issuedAt);
    }
    else if (value.family === "temperature") {
        validateTemperatureRecentErrorState(value.recentErrorState, value.issuedAt);
    }
    // require a raw source row for every complete family lead
    if (!Array.isArray(value.rows) || value.rowCount !== limit.rows || value.rows.length !== limit.rows) {
        throw new RangeError("invalid shadow source projection row count");
    }
    let previousValidAt = null;
    // freeze the same complete lead geometry as the prediction body
    for (const [index, row] of value.rows.entries()) {
        exactKeys(row, SOURCE_ROW_KEYS[value.family]);
        requireInstant(row.validAt);
        requireInstant(row.referenceAt);
        requireInstant(row.receivedAt);
        requireHash(row.sourceSha256);
        requireHash(row.contentSha256);
        const validAt = row.validAt;
        const referenceAt = row.referenceAt;
        const receivedAt = row.receivedAt;
        // bind the upstream model lead to the exact reference and valid clocks
        const computedModelLeadHours = Math.ceil((Date.parse(validAt) - Date.parse(referenceAt)) / 3_600_000);
        // reject late receipts, wrong source identity and nonconsecutive geometry
        if (row.sourceSha256 !== value.sourceSha256 || receivedAt > value.issuedAt ||
            !Number.isInteger(row.modelLeadHours) || row.modelLeadHours !== computedModelLeadHours ||
            computedModelLeadHours < 0 || computedModelLeadHours > 384 ||
            row.leadHours !== index + 1 || validAt <= value.issuedAt ||
            (previousValidAt !== null && Date.parse(validAt) - Date.parse(previousValidAt) !== 3_600_000)) {
            throw new RangeError("shadow source projection row differs");
        }
        const lineageFields = value.family === "temperature"
            ? ["adapterVersion", "dataset", "providerKey", "modelCycle", "upstreamModel"]
            : ["adapterVersion", "contractEpoch", "dataset", "providerKey", "sourceKey",
                "sourceConfigFingerprint", "upstreamModel"];
        // close bounded raw lineage strings
        for (const field of lineageFields) {
            requireBoundedSourceString(row[field]);
        }
        // reject aliased or unbounded non-temperature revision counters
        if (value.family !== "temperature" &&
            (!Number.isSafeInteger(row.revisionCount) || row.revisionCount < 0)) {
            throw new RangeError("invalid shadow source revision");
        }
        // validate only the raw family metrics used by this candidate family
        if (value.family === "temperature") {
            requireHash(row.providerResponseSha256);
            requireHash(row.bestMatchContentSha256);
            requireInstant(row.bestMatchProductRunAt);
            // preserve the exact canonical database source and pre-decision run clock
            if (typeof row.bestMatchSourceId !== "string" || !/^[1-9]\d*$/u.test(row.bestMatchSourceId) ||
                (row.bestMatchSourceId.length > 20) || row.bestMatchProductRunAt > value.issuedAt) {
                throw new RangeError("temperature shadow comparator identity differs");
            }
            boundedValue(row.rawTemperatureC64, -100, 70);
            boundedNullableValue(row.rawRelativeHumidityPercent64, 0, 100);
            boundedNullableValue(row.rawWindSpeedMps64, 0, 150);
            boundedNullableValue(row.bestMatchTemperatureC64, -100, 70);
        }
        else if (value.family === "wind") {
            boundedNullableValue(row.windSpeedMps64, 0, 150);
            boundedNullableValue(row.windGustMps64, 0, 150);
        }
        else {
            boundedNullableValue(row.precipitationMm64, 0, 2_000);
        }
        previousValidAt = validAt;
    }
}
// order the exact temperature rolling-error state independently of caller objects
function canonicalTemperatureRecentErrorState(value) {
    return Object.fromEntries(TEMPERATURE_RECENT_STATE_KEYS.map((key) => [key, value[key]]));
}
// validate the complete causal state consumed by temperature inference
function validateTemperatureRecentErrorState(value, issuedAt) {
    exactKeys(value, TEMPERATURE_RECENT_STATE_KEYS);
    const state = value;
    requireInstant(state.targetRunInitializedAt);
    requireInstant(state.windowEndValidAt);
    // require optional causal maxima to stay normalized and before capture
    for (const instant of [state.maximumSourceRunInitializedAt, state.maximumSourceValidAt]) {
        if (instant !== null) {
            requireInstant(instant);
            // future state cannot become prospective evidence
            if (instant > issuedAt) {
                throw new RangeError("temperature recent-error clock is future");
            }
        }
    }
    // retain only the fitted cohort and bounded aggregate counts
    if (state.cohort !== "ecmwf_single_run_hindcast" || typeof state.supported !== "boolean" ||
        !Number.isSafeInteger(state.localDates) || state.localDates < 0 || state.localDates > 366 ||
        !Number.isSafeInteger(state.n24) || state.n24 < 0 || state.n24 > 10_000 ||
        !Number.isSafeInteger(state.n72) || state.n72 < 0 || state.n72 > 10_000 ||
        !Array.isArray(state.sourceKeys) || state.sourceKeys.length > 10_000) {
        throw new RangeError("temperature recent-error state is invalid");
    }
    // preserve exact bounded source keys rather than an opaque state claim
    for (const sourceKey of state.sourceKeys) {
        requireBoundedSourceString(sourceKey);
    }
    // require finite optional learned statistics
    for (const statistic of [state.b24C, state.b72C, state.mad72C]) {
        if (statistic !== null && (typeof statistic !== "number" || !Number.isFinite(statistic))) {
            throw new RangeError("temperature recent-error statistic is invalid");
        }
    }
}
// order the full compiled-rain causal graph independently of caller objects
function canonicalRainCausalInputs(value) {
    return Object.fromEntries(RAIN_CAUSAL_KEYS.map((key) => [key,
        key === "captureSet"
            ? value.captureSet.map((capture) => Object.fromEntries(RAIN_CAPTURE_KEYS.map((field) => [field, capture[field]])))
            : key === "currentRun"
                ? canonicalRainRun(value.currentRun)
                : key === "priorRuns"
                    ? value.priorRuns.map(canonicalRainRun)
                    : key === "stationHours"
                        ? value.stationHours.map((hour) => Object.fromEntries(RAIN_STATION_HOUR_KEYS.map((field) => [field, hour[field]])))
                        : value.contractVersion,
    ]));
}
// order one exact decoded forecast run
function canonicalRainRun(value) {
    return Object.fromEntries(RAIN_RUN_KEYS.map((key) => [key,
        key === "hours"
            ? value.hours.map((hour) => Object.fromEntries(RAIN_RUN_HOUR_KEYS.map((field) => [field, hour[field]])))
            : value[key],
    ]));
}
// validate every source value and raw capture identity consumed by rain inference
function validateRainCausalInputs(value, issuedAt) {
    exactKeys(value, RAIN_CAUSAL_KEYS);
    const causal = value;
    // require the one frozen compiled-input contract and bounded capture fan-in
    if (causal.contractVersion !== "adjustment-shadow-rain-causal-inputs/v1" ||
        !Array.isArray(causal.captureSet) || causal.captureSet.length < 1 || causal.captureSet.length > 350 ||
        !Array.isArray(causal.priorRuns) || causal.priorRuns.length > 2 ||
        !Array.isArray(causal.stationHours) || causal.stationHours.length > 64) {
        throw new RangeError("invalid rain causal input contract");
    }
    const captureHashes = new Set();
    const captureClaims = new Set();
    // validate each exact retained provider capture identity
    for (const capture of causal.captureSet) {
        exactKeys(capture, RAIN_CAPTURE_KEYS);
        requireBoundedSourceString(capture.claimId);
        requireInstant(capture.completedAt);
        requireHash(capture.bodySha256);
        // retain only the two reviewed capture kinds and before-issue receipts
        if (!["forecast", "station"].includes(capture.kind) ||
            (capture.stationId !== null && (!Number.isSafeInteger(capture.stationId) || capture.stationId < 1)) ||
            (capture.kind === "forecast") !== (capture.runInitializedAt !== null) ||
            (capture.kind === "station") !== (capture.windowStart !== null && capture.windowEndExclusive !== null) ||
            (capture.kind === "forecast" && (capture.stationId !== null || capture.windowStart !== null ||
                capture.windowEndExclusive !== null)) ||
            (capture.kind === "station" && (capture.stationId === null || capture.runInitializedAt !== null)) ||
            (capture.runInitializedAt !== null && !validOptionalInstant(capture.runInitializedAt)) ||
            (capture.windowStart !== null && !validOptionalInstant(capture.windowStart)) ||
            (capture.windowEndExclusive !== null && !validOptionalInstant(capture.windowEndExclusive)) ||
            capture.completedAt > issuedAt || captureClaims.has(capture.claimId)) {
            throw new RangeError("invalid rain capture identity");
        }
        captureHashes.add(capture.bodySha256);
        captureClaims.add(capture.claimId);
    }
    validateRainRun(causal.currentRun, issuedAt, captureHashes);
    // validate each causal prior forecast run
    for (const run of causal.priorRuns) {
        validateRainRun(run, issuedAt, captureHashes);
    }
    const stationKeys = new Set();
    // validate exact derived station inputs passed to the compiled feature builder
    for (const hour of causal.stationHours) {
        exactKeys(hour, RAIN_STATION_HOUR_KEYS);
        requireInstant(hour.hourAt);
        requireInstant(hour.receivedAt);
        const key = `${String(hour.stationId)}:${String(hour.hourAt)}`;
        // reject future, duplicated or unbounded station inputs
        if (!Number.isSafeInteger(hour.stationId) || hour.stationId < 1 ||
            hour.receivedAt > issuedAt || stationKeys.has(key)) {
            throw new RangeError("invalid rain station input");
        }
        boundedNullableValue(hour.precipitationMm64, 0, 500);
        boundedNullableValue(hour.temperatureC64, -100, 70);
        stationKeys.add(key);
    }
}
// validate one exact 48-hour forecast input profile
function validateRainRun(value, issuedAt, captureHashes) {
    exactKeys(value, RAIN_RUN_KEYS);
    requireInstant(value.runInitializedAt);
    requireInstant(value.completedAt);
    requireHash(value.contentSha256);
    const hours = value.hours;
    // require the raw capture hash, receipt and full one-based model geometry
    if (!captureHashes.has(value.contentSha256) || value.completedAt > issuedAt ||
        !Array.isArray(hours) || hours.length !== 48) {
        throw new RangeError("invalid rain forecast input");
    }
    // validate all forecast covariates consumed by the compiled artifact
    for (const [index, hour] of hours.entries()) {
        exactKeys(hour, RAIN_RUN_HOUR_KEYS);
        // preserve exact one-based lead order
        if (hour.leadHours !== index + 1) {
            throw new RangeError("invalid rain forecast input lead");
        }
        boundedNullableValue(hour.precipitationMm64, 0, 2_000);
        boundedNullableValue(hour.temperatureC64, -100, 70);
        boundedNullableValue(hour.relativeHumidityPercent64, 0, 100);
        boundedNullableValue(hour.cloudCoverPercent64, 0, 100);
        boundedNullableValue(hour.pressureHpa64, 100, 1_200);
        boundedNullableValue(hour.windSpeedMps64, 0, 150);
        boundedNullableValue(hour.windDirectionDegrees64, 0, 360);
    }
}
// accept only exact optional utc millisecond instants
function validOptionalInstant(value) {
    // reuse the same normalized instant contract without throwing through boolean checks
    try {
        requireInstant(value);
        return true;
    }
    catch {
        return false;
    }
}
// require body hashes and geometry to come from one exact source projection
function validateMaintenanceShadowSourceBinding(value, sourceProjectionBytes) {
    const source = parseMaintenanceShadowSourceProjection(sourceProjectionBytes);
    const identity = createMaintenanceShadowSourceIdentity(sourceProjectionBytes);
    // bind every frozen header before comparing raw row identities
    if (source.family !== value.family || source.registrationSha256 !== value.registrationSha256 ||
        source.candidateSha256 !== value.candidateSha256 || source.sourceSha256 !== value.sourceSha256 ||
        source.dueKey !== value.dueKey || source.issuedAt !== value.issuedAt ||
        identity.inputSha256 !== value.inputSha256 || identity.sourceReceiptSha256 !== value.sourceReceiptSha256) {
        throw new RangeError("shadow source projection header differs");
    }
    // prove every public row hash and lead clock from raw source bytes
    for (const [index, row] of value.rows.entries()) {
        const sourceRow = source.rows[index];
        // reject candidate geometry absent from the source projection
        if (row.validAt !== sourceRow.validAt || row.leadHours !== sourceRow.leadHours ||
            row.sourceRowSha256 !== identity.sourceRowSha256[index]) {
            throw new RangeError("shadow source projection binding differs");
        }
    }
}
// encode one already-validated public body without requiring private bytes
function encodeCanonicalMaintenanceShadowValues(value) {
    const ordered = {};
    // preserve header order independently of caller insertion order
    for (const key of COMMON_KEYS) {
        ordered[key] = key === "rows" ? value.rows.map(
        // preserve the exact family row field order
        (row) => Object.fromEntries(ROW_KEYS[value.family].map((field) => [field, row[field]]))) : value[key];
    }
    const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
    // a large legal-looking body still fails its fixed family cap
    if (bytes.length > MAINTENANCE_SHADOW_LIMITS[value.family].bytes) {
        throw new RangeError("shadow body exceeds its family cap");
    }
    return bytes;
}
// retain an explicit fallback without inventing a successful application
function validateFallback(row) {
    requireBoolean(row.wouldApply);
    // fallback classifications and application must agree
    if (!FALLBACK_CODES.includes(row.fallbackCode) || row.wouldApply !== (row.fallbackCode === "none")) {
        throw new RangeError("shadow fallback differs");
    }
}
// reject nonphysical binary64 without clipping evidence
function boundedValue(value, minimum, maximum) {
    const decoded = decodeMaintenanceBinary64(value);
    // preserve the frozen physical interval
    if (decoded < minimum || decoded > maximum) {
        throw new RangeError("shadow value exceeds its physical cap");
    }
}
// validate one nullable raw metric without decimal normalization
function boundedNullableValue(value, minimum, maximum) {
    // preserve explicit source gaps as null
    if (value === null) {
        return;
    }
    boundedValue(value, minimum, maximum);
}
// prohibit arbitrary properties at every wire boundary
function exactKeys(value, keys) {
    // allow only plain records with the exact known fields
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).sort().join() !== [...keys].sort().join()) {
        throw new RangeError("shadow fields differ");
    }
}
// reject normalized timestamps before causal comparison
function requireInstant(value) {
    // use exact millisecond utc representation
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new RangeError("invalid shadow instant");
    }
}
// require one fixed six-hour scheduler identity
function validateDueKey(value) {
    // reject caller paths outside the capture cadence
    if (typeof value !== "string" || !/^capture\/\d{4}-\d{2}-\d{2}T(?:00|06|12|18):35:00\.000Z$/u.test(value)) {
        throw new RangeError("invalid shadow due key");
    }
    requireInstant(value.slice(8));
}
// require one bounded nonempty raw lineage string
function requireBoundedSourceString(value) {
    // reject controls, unbounded text and normalization aliases
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new RangeError("invalid shadow source lineage");
    }
}
// restrict identities to lowercase content addresses
function requireHash(value) {
    // never accept unbounded labels or paths as hashes
    if (typeof value !== "string" || !HASH.test(value)) {
        throw new RangeError("invalid shadow identity");
    }
}
// retain booleans without javascript truthiness
function requireBoolean(value) {
    // reject numeric and string aliases
    if (typeof value !== "boolean") {
        throw new RangeError("invalid shadow boolean");
    }
}
// hash only the exact ordered canonical bytes
function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}
