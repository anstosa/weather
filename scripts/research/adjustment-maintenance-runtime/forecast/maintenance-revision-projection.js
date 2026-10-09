import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS } from "@weather/domain";
import { canonicalObjectSha256 } from "./candidate.js";
import { decodeMaintenanceBinary64, encodeMaintenanceBinary64, } from "./maintenance-shadow-values.js";
export const ADJUSTMENT_REVISION_PROJECTION_VERSION = "adjustment-revision-projection/v1";
export const ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION = "adjustment-revision-batch-projection/v2";
export const ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION = "adjustment-temperature-native-source-projection/v2";
export const ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION = "adjustment-rain-gate-feature-projection/v2";
export const ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION = "adjustment-rain-gate-control-projection/v3";
export const RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION = "rain-maintenance-persistence-target/v1";
export const ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT = "96e4365f74a0fb8694944172b73a65c29d89a68ddf86b1b0a50db38bb39d52aa";
const HASH = /^[a-f0-9]{64}$/u;
const TOP_KEYS = ["contractVersion", "family", "logicalKey", "logicalReceivedAt",
    "projectionKind", "rows", "source", "storedContentSha256"];
const TEMPERATURE_NATIVE_TOP_KEYS = ["contractVersion", "family", "logicalKey",
    "logicalReceivedAt", "projectionKind", "recentErrorState", "recentErrorStateSha256",
    "rows", "source", "storedContentSha256"];
const TEMPERATURE_RECENT_STATE_KEYS = ["b24C", "b72C", "cohort", "localDates", "mad72C",
    "maximumSourceRunInitializedAt", "maximumSourceValidAt", "n24", "n72", "sourceKeys",
    "supported", "targetRunInitializedAt", "windowEndValidAt"];
const SOURCE_KEYS = ["adapterVersion", "contractEpoch", "dataset", "providerKey",
    "sourceConfigFingerprint", "sourceId", "sourceKey", "sourceKind", "upstreamModel"];
const LOGICAL_KEY_KEYS = Object.freeze({
    actual_best_match: ["productRunAt", "sourceId", "sourceKind", "validAt"],
    native_source: ["contentSha256", "leadHours", "providerResponseSha256", "runInitializedAt",
        "siteId", "sourceId", "sourceType", "validAt"],
    rain_gate_input: ["inputSha256", "modelSha256", "runInitializedAt"],
    target_revision: ["productRunAt", "sourceId", "sourceKind", "validAt"],
});
const WEATHER_ROW_KEYS = ["apparentTemperatureC64", "blackGlobeTemperatureC64", "cloudCoverPercent64",
    "contentSha256", "pm25MicrogramsPerCubicMeter64", "precipitationMm64", "precipitationRateMmPerHour64",
    "pressureHpa64", "relativeHumidityPercent64", "soilElectricalConductivityMicrosiemensPerCm64",
    "soilMoisturePercent64", "solarRadiationWm264", "temperatureC64", "uvIndex64", "validAt", "waterLevelM64",
    "wetBulbGlobeTemperatureC64", "windDirectionDegrees64", "windGustMps64", "windSpeedMps64"];
const ANCHOR_ROW_KEYS = ["apparentTemperatureC64", "cloudCoverPercent64", "contentSha256", "leadHours",
    "precipitationMm64", "pressureHpa64", "relativeHumidityPercent64", "temperatureC64", "validAt",
    "windDirectionDegrees64", "windGustMps64", "windSpeedMps64"];
const TEMPERATURE_ROW_KEYS = ["bestMatchContentSha256", "bestMatchProductRunAt",
    "bestMatchSourceId", "bestMatchTemperatureC64", "contentSha256", "modelCycle",
    "modelLeadHours", "rawRelativeHumidityPercent64", "rawTemperatureC64",
    "rawWindSpeedMps64", "validAt"];
const RAIN_GATE_ROW_KEYS = ["applied", "correctedPrecipitationMm64", "modelLeadHours",
    "rawPrecipitationMm64", "reasonCode", "validAt"];
const RAIN_GATE_FEATURE_ROW_KEYS = ["features64", "modelLeadHours", "rawPrecipitationMm64",
    "rawTargetHourTemperatureC64", "validAt"];
const RAIN_CONTROL_TOP_KEYS = ["contractVersion", "family", "logicalKey", "logicalReceivedAt",
    "ordinalArtifactSha256", "persistenceTarget", "projectionKind", "rows", "source", "stateSha256",
    "stateStageReceiptSha256", "storedContentSha256"];
const RAIN_CONTROL_ROW_KEYS = ["features64", "incumbentArtifactIdentitySha256", "incumbentPrediction64",
    "incumbentProbability", "incumbentReceiptMemberSha256", "modelLeadHours", "nativeSourceProbability",
    "persistencePrediction64", "persistenceReason", "persistenceTargetMemberSha256", "rawPrecipitationMm64",
    "rawTargetHourTemperatureC64", "recentVolumeScalePrediction64", "sameWindowVolumeScalePrediction64",
    "sourceRowSha256", "unchangedOrdinalPrediction64", "validAt", "volumeScalePrediction64"];
const PROBABILITY_KEYS = ["atLeast0_1", "atLeast1_0", "atLeast2_5"];
const PERSISTENCE_TARGET_KEYS = ["contractVersion", "decisionAt", "prediction64", "reason", "rowCount",
    "rows", "targetMemberSha256", "validAt"];
const PERSISTENCE_TARGET_ROW_KEYS = ["captureMembers", "precipitationMm64", "receivedAt", "stationId"];
const PERSISTENCE_CAPTURE_KEYS = ["bodySha256", "claimId", "completedAt"];
const FAMILY_LIMITS = Object.freeze({ rain: 128 * 1_024, shared: 768 * 1_024,
    temperature: 64 * 1_024, wind: 768 * 1_024 });
// encode one closed canonical revision projection before archive staging
export function encodeAdjustmentRevisionProjection(value) {
    validateAdjustmentRevisionProjection(value);
    return encodeRevisionProjectionDocument(value);
}
// encode one grouped same-source weather revision before archive staging
export function encodeAdjustmentRevisionBatchProjection(value) {
    validateAdjustmentRevisionBatchProjection(value);
    return encodeRevisionProjectionDocument(value);
}
// encode one complete native temperature run and its source-decision state
export function encodeAdjustmentTemperatureNativeSourceProjection(value) {
    validateAdjustmentTemperatureNativeSourceProjection(value);
    const logicalKey = value.logicalKey;
    const ordered = Object.fromEntries(TEMPERATURE_NATIVE_TOP_KEYS.map((key) => [key,
        key === "logicalKey"
            ? Object.fromEntries(LOGICAL_KEY_KEYS.native_source.map((field) => [field, logicalKey[field]]))
            : key === "recentErrorState"
                ? Object.fromEntries(TEMPERATURE_RECENT_STATE_KEYS.map((field) => [field, value.recentErrorState[field]]))
                : key === "rows"
                    ? value.rows.map((row) => Object.fromEntries(TEMPERATURE_ROW_KEYS.map((field) => [field, row[field]])))
                    : key === "source"
                        ? Object.fromEntries(SOURCE_KEYS.map((field) => [field, value.source[field]]))
                        : value[key],
    ]));
    const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
    if (bytes.byteLength > FAMILY_LIMITS.temperature) {
        throw new RangeError("adjustment temperature native projection exceeds its family cap");
    }
    return bytes;
}
// encode one complete pre-fit rain feature body before archive staging
export function encodeAdjustmentRainGateFeatureProjection(value) {
    validateAdjustmentRainGateFeatureProjection(value);
    return encodeRevisionProjectionDocument(value);
}
// encode one complete pre-target control body after state durability
export function encodeAdjustmentRainGateControlProjection(value) {
    validateAdjustmentRainGateControlProjection(value);
    const logicalKey = value.logicalKey;
    const ordered = Object.fromEntries(RAIN_CONTROL_TOP_KEYS.map((key) => [key,
        key === "logicalKey"
            ? Object.fromEntries(LOGICAL_KEY_KEYS.rain_gate_input.map((field) => [field, logicalKey[field]]))
            : key === "rows"
                ? value.rows.map((row) => Object.fromEntries(RAIN_CONTROL_ROW_KEYS.map((field) => [field,
                    field === "incumbentProbability" || field === "nativeSourceProbability"
                        ? Object.fromEntries(PROBABILITY_KEYS.map((name) => [name, row[field][name]]))
                        : row[field],
                ])))
                : key === "source"
                    ? Object.fromEntries(SOURCE_KEYS.map((field) => [field, value.source[field]]))
                    : key === "persistenceTarget"
                        ? orderedPersistenceTarget(value.persistenceTarget)
                        : value[key],
    ]));
    const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
    // preserve the existing bounded rain payload ceiling
    if (bytes.byteLength > FAMILY_LIMITS.rain) {
        throw new RangeError("adjustment rain control projection exceeds its family cap");
    }
    return bytes;
}
// serialize one already-validated projection document canonically
function encodeRevisionProjectionDocument(value) {
    const rowKeys = revisionRowKeys(value);
    const logicalKey = value.logicalKey;
    const ordered = Object.fromEntries(TOP_KEYS.map((key) => [key,
        key === "logicalKey"
            ? Object.fromEntries(LOGICAL_KEY_KEYS[value.projectionKind].map((field) => [field, logicalKey[field]]))
            : key === "rows"
                ? value.rows.map((row) => {
                    const record = row;
                    return Object.fromEntries(rowKeys.map((field) => [field, record[field]]));
                })
                : key === "source"
                    ? Object.fromEntries(SOURCE_KEYS.map((field) => [field, value.source[field]]))
                    : value[key],
    ]));
    const bytes = Buffer.from(JSON.stringify(ordered) + "\n");
    // enforce the family-specific admission cap before transport
    if (bytes.byteLength > FAMILY_LIMITS[value.family]) {
        throw new RangeError("adjustment revision projection exceeds its family cap");
    }
    return bytes;
}
// parse only the one canonical byte representation
export function parseAdjustmentRevisionProjection(bytes) {
    // cap hostile inputs before decoding
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > FAMILY_LIMITS.wind) {
        throw new RangeError("adjustment revision projection size is invalid");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const canonical = encodeAdjustmentRevisionProjection(value);
    // refuse whitespace, order, duplicate-key and number aliases
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("adjustment revision projection is not canonical");
    }
    return value;
}
// parse only the canonical grouped weather byte representation
export function parseAdjustmentRevisionBatchProjection(bytes) {
    // cap hostile inputs before decoding
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > FAMILY_LIMITS.wind) {
        throw new RangeError("adjustment revision batch projection size is invalid");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const canonical = encodeAdjustmentRevisionBatchProjection(value);
    // refuse whitespace, order, duplicate-key and number aliases
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("adjustment revision batch projection is not canonical");
    }
    return value;
}
// parse only the canonical temperature native source and state representation
export function parseAdjustmentTemperatureNativeSourceProjection(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
        bytes.byteLength > FAMILY_LIMITS.temperature) {
        throw new RangeError("adjustment temperature native projection size is invalid");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const canonical = encodeAdjustmentTemperatureNativeSourceProjection(value);
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("adjustment temperature native projection is not canonical");
    }
    return value;
}
// parse only the canonical pre-fit rain feature representation
export function parseAdjustmentRainGateFeatureProjection(bytes) {
    // cap hostile inputs before decoding feature arrays
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
        bytes.byteLength > FAMILY_LIMITS.rain) {
        throw new RangeError("adjustment rain feature projection size is invalid");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const canonical = encodeAdjustmentRainGateFeatureProjection(value);
    // refuse whitespace, order and binary64 aliases
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("adjustment rain feature projection is not canonical");
    }
    return value;
}
// parse only the canonical pre-target control representation
export function parseAdjustmentRainGateControlProjection(bytes) {
    // cap hostile inputs before decoding nested feature arrays
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 ||
        bytes.byteLength > FAMILY_LIMITS.rain) {
        throw new RangeError("adjustment rain control projection size is invalid");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const canonical = encodeAdjustmentRainGateControlProjection(value);
    // refuse whitespace, order and binary64 aliases
    if (!canonical.equals(Buffer.from(bytes))) {
        throw new RangeError("adjustment rain control projection is not canonical");
    }
    return value;
}
// parse either reviewed projection contract without weakening v1
export function parseAdjustmentRevisionProjectionDocument(bytes) {
    // select the contract from bounded canonical json before full validation
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > FAMILY_LIMITS.wind) {
        throw new RangeError("adjustment revision projection size is invalid");
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    // keep legacy parsing exact while admitting only the additive batch contract
    if (value.contractVersion === ADJUSTMENT_REVISION_PROJECTION_VERSION) {
        return parseAdjustmentRevisionProjection(bytes);
    }
    if (value.contractVersion === ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION) {
        return parseAdjustmentRevisionBatchProjection(bytes);
    }
    if (value.contractVersion === ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION) {
        return parseAdjustmentTemperatureNativeSourceProjection(bytes);
    }
    if (value.contractVersion === ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION) {
        return parseAdjustmentRainGateFeatureProjection(bytes);
    }
    if (value.contractVersion === ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION) {
        return parseAdjustmentRainGateControlProjection(bytes);
    }
    throw new RangeError("adjustment revision projection contract is invalid");
}
// hash the entire canonical body as the archive projection identity
export function adjustmentRevisionProjectionIdentity(bytes) {
    parseAdjustmentRevisionProjectionDocument(bytes);
    return createHash("sha256").update(bytes).digest("hex");
}
// hash only the canonical ordered value rows for database and archive crossbinding
export function adjustmentRevisionProjectionSha256(bytes) {
    return adjustmentRevisionProjectionIdentity(bytes);
}
// hash one exact database logical key even when body encoding later fails
export function adjustmentRevisionLogicalKeySha256(projectionKind, logicalKey) {
    // admit only the closed key grammar for its database relation
    if (!Object.hasOwn(LOGICAL_KEY_KEYS, projectionKind)) {
        throw new RangeError("adjustment revision projection kind is invalid");
    }
    exactKeys(logicalKey, LOGICAL_KEY_KEYS[projectionKind]);
    validateLogicalKey(logicalKey, projectionKind);
    const ordered = Object.fromEntries(LOGICAL_KEY_KEYS[projectionKind].map(
    // preserve the frozen per-kind database key order
    (field) => [field, logicalKey[field]]));
    return createHash("sha256").update(JSON.stringify(ordered) + "\n").digest("hex");
}
// validate every closed logical, lineage and value field
export function validateAdjustmentRevisionProjection(value) {
    exactKeys(value, TOP_KEYS);
    // restrict every top-level discriminator and clock
    if (value.contractVersion !== ADJUSTMENT_REVISION_PROJECTION_VERSION ||
        !Object.hasOwn(LOGICAL_KEY_KEYS, value.projectionKind) ||
        !Object.hasOwn(FAMILY_LIMITS, value.family)) {
        throw new RangeError("adjustment revision projection contract is invalid");
    }
    requireInstant(value.logicalReceivedAt);
    requireHash(value.storedContentSha256);
    exactKeys(value.logicalKey, LOGICAL_KEY_KEYS[value.projectionKind]);
    exactKeys(value.source, SOURCE_KEYS);
    validateSource(value.source, value.projectionKind);
    validateLogicalKey(value.logicalKey, value.projectionKind);
    const rowKeys = revisionRowKeys(value);
    const expectedRows = expectedRowCount(value);
    // require one complete immutable serving projection
    if (!Array.isArray(value.rows) || value.rows.length !== expectedRows) {
        throw new RangeError("adjustment revision projection geometry is invalid");
    }
    let previousValidAt = null;
    // validate every ordered normalized value without decimal ambiguity
    for (const [index, row] of value.rows.entries()) {
        exactKeys(row, rowKeys);
        requireInstant(row.validAt);
        // preserve hourly multirow geometry for complete native and rain runs
        if (previousValidAt !== null && expectedRows > 1 &&
            Date.parse(String(row.validAt)) - Date.parse(previousValidAt) !== 3_600_000) {
            throw new RangeError("adjustment revision projection rows are not consecutive");
        }
        previousValidAt = String(row.validAt);
        validateRevisionRow(value, row, index);
    }
    // cross-bind stored content and logical geometry to the projected database rows
    validateStoredProjectionBinding(value);
}
// validate one complete grouped weather revision body
export function validateAdjustmentRevisionBatchProjection(value) {
    exactKeys(value, TOP_KEYS);
    // restrict the additive contract to grouped comparator or target weather rows
    if (value.contractVersion !== ADJUSTMENT_REVISION_BATCH_PROJECTION_VERSION ||
        !["actual_best_match", "target_revision"].includes(value.projectionKind) ||
        (value.projectionKind === "actual_best_match" ? value.family !== "wind" : value.family !== "shared")) {
        throw new RangeError("adjustment revision batch projection contract is invalid");
    }
    requireInstant(value.logicalReceivedAt);
    requireHash(value.storedContentSha256);
    exactKeys(value.logicalKey, LOGICAL_KEY_KEYS[value.projectionKind]);
    exactKeys(value.source, SOURCE_KEYS);
    validateSource(value.source, value.projectionKind);
    validateLogicalKey(value.logicalKey, value.projectionKind);
    // bind every row to one source and one exact model-run lineage
    if (value.source.sourceId !== value.logicalKey.sourceId ||
        (value.projectionKind === "actual_best_match" &&
            (value.source.dataset !== "best_match" || value.source.upstreamModel !== "best_match"))) {
        throw new RangeError("adjustment revision batch source differs");
    }
    // retain one bounded complete causal geometry per staged body
    if (!Array.isArray(value.rows) || value.rows.length < 1 || value.rows.length > 168) {
        throw new RangeError("adjustment revision batch geometry is invalid");
    }
    let previousValidAt = null;
    for (const row of value.rows) {
        exactKeys(row, WEATHER_ROW_KEYS);
        requireInstant(row.validAt);
        requireHash(row.contentSha256);
        const elapsed = previousValidAt === null
            ? null
            : Date.parse(String(row.validAt)) - Date.parse(previousValidAt);
        // require hourly forecast geometry and strictly ordered physical samples
        if (elapsed !== null && (elapsed <= 0 ||
            (value.projectionKind === "actual_best_match" && elapsed !== 3_600_000))) {
            throw new RangeError("adjustment revision batch rows are not ordered");
        }
        previousValidAt = String(row.validAt);
        for (const [field, fieldValue] of Object.entries(row)) {
            // validate every metric through the frozen binary64 grammar
            if (field.endsWith("64")) {
                requireBinary64(fieldValue, true);
            }
        }
    }
    const first = value.rows[0];
    // bind the header key and content identity to the first ordered row
    if (first.contentSha256 !== value.storedContentSha256 ||
        first.validAt !== value.logicalKey.validAt) {
        throw new RangeError("adjustment revision batch stored content differs");
    }
}
// validate one source-decision-frozen temperature state against its run body
export function validateAdjustmentTemperatureNativeSourceProjection(value) {
    exactKeys(value, TEMPERATURE_NATIVE_TOP_KEYS);
    if (value.contractVersion !== ADJUSTMENT_TEMPERATURE_NATIVE_SOURCE_PROJECTION_VERSION ||
        value.family !== "temperature" || value.projectionKind !== "native_source") {
        throw new RangeError("adjustment temperature native projection contract is invalid");
    }
    const common = {
        contractVersion: ADJUSTMENT_REVISION_PROJECTION_VERSION,
        family: value.family,
        logicalKey: value.logicalKey,
        logicalReceivedAt: value.logicalReceivedAt,
        projectionKind: value.projectionKind,
        rows: value.rows,
        source: value.source,
        storedContentSha256: value.storedContentSha256,
    };
    validateAdjustmentRevisionProjection(common);
    exactKeys(value.recentErrorState, TEMPERATURE_RECENT_STATE_KEYS);
    requireHash(value.recentErrorStateSha256);
    const state = value.recentErrorState;
    requireInstant(state.targetRunInitializedAt);
    requireInstant(state.windowEndValidAt);
    for (const clock of [state.maximumSourceRunInitializedAt, state.maximumSourceValidAt]) {
        if (clock !== null) {
            requireInstant(clock);
        }
    }
    if (state.cohort !== "ecmwf_single_run_hindcast" ||
        state.targetRunInitializedAt !== value.logicalKey.runInitializedAt ||
        Date.parse(state.windowEndValidAt) !== Date.parse(state.targetRunInitializedAt) - 7 * 3_600_000 ||
        !Number.isSafeInteger(state.n24) || state.n24 < 0 || state.n24 > 24 ||
        !Number.isSafeInteger(state.n72) || state.n72 < state.n24 || state.n72 > 72 ||
        !Number.isSafeInteger(state.localDates) || state.localDates < 0 ||
        state.localDates > state.n72 || !Array.isArray(state.sourceKeys) ||
        state.sourceKeys.length !== state.n72 ||
        new Set(state.sourceKeys).size !== state.sourceKeys.length) {
        throw new RangeError("adjustment temperature recent-error state differs");
    }
    for (const key of state.sourceKeys) {
        if (typeof key !== "string" || key.length < 1 || key.length > 128) {
            throw new RangeError("adjustment temperature recent-error source differs");
        }
    }
    for (const statistic of [state.b24C, state.b72C, state.mad72C]) {
        if (statistic !== null && (!Number.isFinite(statistic) || Math.abs(statistic) > 6)) {
            throw new RangeError("adjustment temperature recent-error statistic differs");
        }
    }
    const orderedState = Object.fromEntries(TEMPERATURE_RECENT_STATE_KEYS.map(
    // preserve the database's fixed-order state hash preimage without an added newline
    (key) => [key, state[key]]));
    if (createHash("sha256").update(JSON.stringify(orderedState)).digest("hex") !==
        value.recentErrorStateSha256) {
        throw new RangeError("adjustment temperature recent-error identity differs");
    }
}
// validate one complete pre-fit rain feature projection
export function validateAdjustmentRainGateFeatureProjection(value) {
    exactKeys(value, TOP_KEYS);
    // keep the additive grammar on the existing rain gate receipt class
    if (value.contractVersion !== ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION ||
        value.family !== "rain" || value.projectionKind !== "rain_gate_input") {
        throw new RangeError("adjustment rain feature projection contract is invalid");
    }
    requireInstant(value.logicalReceivedAt);
    requireHash(value.storedContentSha256);
    exactKeys(value.logicalKey, LOGICAL_KEY_KEYS.rain_gate_input);
    validateLogicalKey(value.logicalKey, "rain_gate_input");
    exactKeys(value.source, SOURCE_KEYS);
    validateRainFeatureSource(value.source);
    // retain the full native 23-hour training geometry
    if (!Array.isArray(value.rows) || value.rows.length !== 23) {
        throw new RangeError("adjustment rain feature projection geometry is invalid");
    }
    const initializedAt = Date.parse(value.logicalKey.runInitializedAt);
    // validate every feature vector and its exact native source target
    for (const [index, row] of value.rows.entries()) {
        exactKeys(row, RAIN_GATE_FEATURE_ROW_KEYS);
        requireInstant(row.validAt);
        requireBinary64(row.rawPrecipitationMm64, false);
        requireBinary64(row.rawTargetHourTemperatureC64, false);
        const expectedLead = index + 9;
        // bind one-based serving lead geometry to the model-run key
        if (row.modelLeadHours !== expectedLead ||
            Date.parse(row.validAt) !== initializedAt + expectedLead * 3_600_000 ||
            !Array.isArray(row.features64) || row.features64.length !== 107) {
            throw new RangeError("adjustment rain feature projection row differs");
        }
        // retain missing predictors as explicit nulls and finite values as binary64
        for (const feature of row.features64) {
            requireBinary64(feature, true);
        }
        if (decodeMaintenanceBinary64(row.rawPrecipitationMm64) < 0) {
            throw new RangeError("adjustment rain feature source amount differs");
        }
    }
}
// validate one complete pre-target rain control projection
export function validateAdjustmentRainGateControlProjection(value) {
    exactKeys(value, RAIN_CONTROL_TOP_KEYS);
    // keep the new grammar on the existing rain gate receipt class
    if (value.contractVersion !== ADJUSTMENT_RAIN_GATE_CONTROL_PROJECTION_VERSION ||
        value.family !== "rain" || value.projectionKind !== "rain_gate_input") {
        throw new RangeError("adjustment rain control projection contract is invalid");
    }
    requireInstant(value.logicalReceivedAt);
    for (const hash of [value.ordinalArtifactSha256, value.stateSha256,
        value.stateStageReceiptSha256, value.storedContentSha256]) {
        requireHash(hash);
    }
    exactKeys(value.logicalKey, LOGICAL_KEY_KEYS.rain_gate_input);
    validateLogicalKey(value.logicalKey, "rain_gate_input");
    exactKeys(value.source, SOURCE_KEYS);
    validateRainFeatureSource(value.source);
    validateRainMaintenancePersistenceTarget(value.persistenceTarget);
    // retain the full native 23-hour training and control geometry
    if (!Array.isArray(value.rows) || value.rows.length !== 23) {
        throw new RangeError("adjustment rain control projection geometry is invalid");
    }
    const initializedAt = Date.parse(value.logicalKey.runInitializedAt);
    let artifactIdentity;
    let receiptIdentity;
    // validate every exact control and serving-comparator row
    for (const [index, row] of value.rows.entries()) {
        exactKeys(row, RAIN_CONTROL_ROW_KEYS);
        exactKeys(row.incumbentProbability, PROBABILITY_KEYS);
        exactKeys(row.nativeSourceProbability, PROBABILITY_KEYS);
        requireInstant(row.validAt);
        for (const field of ["incumbentPrediction64", "persistencePrediction64",
            "rawPrecipitationMm64", "rawTargetHourTemperatureC64", "recentVolumeScalePrediction64",
            "sameWindowVolumeScalePrediction64", "unchangedOrdinalPrediction64",
            "volumeScalePrediction64"]) {
            requireBinary64(row[field], false);
        }
        validateProbability(row.incumbentProbability);
        validateProbability(row.nativeSourceProbability);
        requireHash(row.incumbentReceiptMemberSha256);
        requireHash(row.sourceRowSha256);
        if (row.incumbentArtifactIdentitySha256 !== null) {
            requireHash(row.incumbentArtifactIdentitySha256);
        }
        const expectedLead = index + 9;
        // bind every control to the same actual native source row
        if (row.modelLeadHours !== expectedLead ||
            Date.parse(row.validAt) !== initializedAt + expectedLead * 3_600_000 ||
            !Array.isArray(row.features64) || row.features64.length !== 107 ||
            row.sourceRowSha256 !== adjustmentRainGateFeatureRowSha256(value.logicalKey, row)) {
            throw new RangeError("adjustment rain control projection row differs");
        }
        for (const feature of row.features64) {
            requireBinary64(feature, true);
        }
        validateRainControlValues(row, value.persistenceTarget);
        // one projection cannot mix incumbent serving authorities
        if (index === 0) {
            artifactIdentity = row.incumbentArtifactIdentitySha256;
            receiptIdentity = row.incumbentReceiptMemberSha256;
        }
        if (artifactIdentity !== row.incumbentArtifactIdentitySha256 ||
            receiptIdentity !== row.incumbentReceiptMemberSha256) {
            throw new RangeError("adjustment rain incumbent authority differs");
        }
    }
}
// hash one feature source row independently of later controls
export function adjustmentRainGateFeatureRowSha256(logicalKey, row) {
    exactKeys(logicalKey, LOGICAL_KEY_KEYS.rain_gate_input);
    validateLogicalKey(logicalKey, "rain_gate_input");
    const orderedRow = Object.fromEntries(RAIN_GATE_FEATURE_ROW_KEYS.map((key) => [key, row[key]]));
    const logicalRecord = logicalKey;
    const orderedKey = Object.fromEntries(LOGICAL_KEY_KEYS.rain_gate_input.map(
    // preserve the existing rain gate key order
    (key) => [key, logicalRecord[key]]));
    return createHash("sha256").update("adjustment-rain-gate-feature-row/v2\n")
        .update(JSON.stringify(orderedKey) + "\n")
        .update(JSON.stringify(orderedRow) + "\n").digest("hex");
}
// construct one causal prior-hour network member in fixed station order
export function createRainMaintenancePersistenceTarget(input) {
    requireInstant(input.decisionAt);
    const rowsByStation = new Map(input.rows.map((row) => [row.stationId, row]));
    // reject missing or duplicate station evidence before fixing catalog order
    if (input.rows.length !== RAIN_COLLECTION_STATIONS.length ||
        rowsByStation.size !== RAIN_COLLECTION_STATIONS.length) {
        throw new RangeError("rain persistence target station set differs");
    }
    const rows = RAIN_COLLECTION_STATIONS.map((station) => {
        const row = rowsByStation.get(station.locationId);
        // require one explicit row for every retained station
        if (row === undefined) {
            throw new RangeError("rain persistence target station set differs");
        }
        const captureMembers = [...row.captureMembers].sort(
        // preserve one deterministic order across overlapping provider responses
        (left, right) => left.completedAt.localeCompare(right.completedAt) ||
            left.claimId.localeCompare(right.claimId)).map((capture) => Object.freeze({ ...capture }));
        return Object.freeze({
            captureMembers: Object.freeze(captureMembers),
            precipitationMm64: row.precipitationMm === null
                ? null
                : encodeMaintenanceBinary64(row.precipitationMm),
            receivedAt: row.receivedAt,
            stationId: row.stationId,
        });
    });
    const available = rows.flatMap((row, index) => {
        // exclude only explicitly unavailable station hours
        if (row.precipitationMm64 === null) {
            return [];
        }
        const station = RAIN_COLLECTION_STATIONS[index];
        return [{
                id: station.locationId,
                value: decodeMaintenanceBinary64(row.precipitationMm64),
                weight: rainMaintenanceStationWeight(station),
            }];
    });
    const supported = available.length >= 3 && rows.slice(0, 3)
        .some((row) => row.precipitationMm64 !== null);
    const unsigned = {
        contractVersion: RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION,
        decisionAt: input.decisionAt,
        prediction64: supported
            ? encodeMaintenanceBinary64(rainMaintenanceWeightedMedian(available))
            : null,
        reason: supported ? "causal_target" : "raw_fallback_unavailable",
        rowCount: 12,
        rows: Object.freeze(rows),
        validAt: new Date(Date.parse(input.decisionAt) - 3_600_000).toISOString(),
    };
    const target = Object.freeze({
        ...unsigned,
        targetMemberSha256: canonicalObjectSha256(unsigned, "targetMemberSha256"),
    });
    validateRainMaintenancePersistenceTarget(target);
    return target;
}
// validate and self-bind one causal persistence target member
export function validateRainMaintenancePersistenceTarget(value) {
    exactKeys(value, PERSISTENCE_TARGET_KEYS);
    requireInstant(value.decisionAt);
    requireInstant(value.validAt);
    requireHash(value.targetMemberSha256);
    // keep the prior target exactly one hour before the model decision
    if (value.contractVersion !== RAIN_MAINTENANCE_PERSISTENCE_TARGET_VERSION ||
        Date.parse(value.decisionAt) - Date.parse(value.validAt) !== 3_600_000 ||
        value.rowCount !== RAIN_COLLECTION_STATIONS.length || !Array.isArray(value.rows) ||
        value.rows.length !== RAIN_COLLECTION_STATIONS.length ||
        canonicalObjectSha256(value, "targetMemberSha256") !== value.targetMemberSha256) {
        throw new RangeError("rain persistence target identity differs");
    }
    const values = [];
    // preserve all twelve fixed gauges including explicit missing rows
    for (const [index, row] of value.rows.entries()) {
        exactKeys(row, PERSISTENCE_TARGET_ROW_KEYS);
        const station = RAIN_COLLECTION_STATIONS[index];
        if (station === undefined || row.stationId !== station.locationId ||
            !Array.isArray(row.captureMembers)) {
            throw new RangeError("rain persistence target station differs");
        }
        let previousCapture = null;
        // bind every overlapping provider response used to reconstruct the gauge hour
        for (const capture of row.captureMembers) {
            exactKeys(capture, PERSISTENCE_CAPTURE_KEYS);
            requireHash(capture.bodySha256);
            requireInstant(capture.completedAt);
            const order = `${capture.completedAt}\n${capture.claimId}`;
            if (typeof capture.claimId !== "string" || capture.claimId.length < 1 ||
                capture.claimId.length > 128 || Date.parse(capture.completedAt) > Date.parse(value.decisionAt) ||
                (previousCapture !== null && order <= previousCapture)) {
                throw new RangeError("rain persistence target was received after decision");
            }
            previousCapture = order;
        }
        if (row.receivedAt !== null) {
            requireInstant(row.receivedAt);
            if (Date.parse(row.receivedAt) > Date.parse(value.decisionAt) ||
                !row.captureMembers.some((capture) => capture.completedAt === row.receivedAt)) {
                throw new RangeError("rain persistence target receipt differs");
            }
        }
        if (row.precipitationMm64 !== null) {
            if (row.captureMembers.length === 0 || row.receivedAt === null) {
                throw new RangeError("rain persistence value lacks a capture");
            }
            const precipitation = decodeMaintenanceBinary64(row.precipitationMm64);
            if (precipitation < 0) {
                throw new RangeError("rain persistence target amount differs");
            }
            values.push({ id: station.locationId, value: precipitation,
                weight: rainMaintenanceStationWeight(station) });
        }
    }
    const nearestAvailable = value.rows.slice(0, 3).some((row) => row.precipitationMm64 !== null);
    const supported = values.length >= 3 && nearestAvailable;
    // supported members carry the exact deterministic weighted median
    if (supported) {
        if (value.reason !== "causal_target" || value.prediction64 === null ||
            decodeMaintenanceBinary64(value.prediction64) !== rainMaintenanceWeightedMedian(values)) {
            throw new RangeError("rain persistence target prediction differs");
        }
        return;
    }
    // unsupported members retain no invented target value
    if (value.reason !== "raw_fallback_unavailable" || value.prediction64 !== null) {
        throw new RangeError("rain persistence target fallback differs");
    }
}
// retain only finite nested event probabilities
function validateProbability(value) {
    const decoded = PROBABILITY_KEYS.map((key) => decodeMaintenanceBinary64(value[key]));
    // reject out-of-range or nonnested event heads
    if (decoded.some((probability) => probability < 0 || probability > 1) ||
        decoded[0] < decoded[1] || decoded[1] < decoded[2]) {
        throw new RangeError("rain control probability differs");
    }
}
// bind all numerical controls to their causal persistence member
function validateRainControlValues(row, persistence) {
    const raw = decodeMaintenanceBinary64(row.rawPrecipitationMm64);
    const prediction = decodeMaintenanceBinary64(row.persistencePrediction64);
    const nonnegative = [row.incumbentPrediction64, row.recentVolumeScalePrediction64,
        row.sameWindowVolumeScalePrediction64, row.unchangedOrdinalPrediction64,
        row.volumeScalePrediction64].map(decodeMaintenanceBinary64);
    // all amount controls and the incumbent must remain physical
    if (raw < 0 || prediction < 0 || nonnegative.some((value) => value < 0)) {
        throw new RangeError("rain control amount differs");
    }
    const native = PROBABILITY_KEYS.map((key) => decodeMaintenanceBinary64(row.nativeSourceProbability[key]));
    const expectedNative = [Number(raw >= 0.1), Number(raw >= 1), Number(raw >= 2.5)];
    // retain the deterministic raw-source event baseline exactly
    if (JSON.stringify(native) !== JSON.stringify(expectedNative)) {
        throw new RangeError("rain native source probability differs");
    }
    const targetPrediction = persistence.prediction64 === null
        ? null
        : decodeMaintenanceBinary64(persistence.prediction64);
    // reference the actual causal member only when its target exists
    if (targetPrediction === null) {
        if (row.persistenceReason !== "raw_fallback_unavailable" ||
            row.persistenceTargetMemberSha256 !== null || prediction !== raw) {
            throw new RangeError("rain persistence control fallback differs");
        }
        return;
    }
    if (row.persistenceReason !== "causal_target" ||
        row.persistenceTargetMemberSha256 !== persistence.targetMemberSha256 ||
        prediction !== targetPrediction) {
        throw new RangeError("rain persistence control differs");
    }
}
// preserve canonical nested persistence member field order
function orderedPersistenceTarget(value) {
    return Object.fromEntries(PERSISTENCE_TARGET_KEYS.map((key) => [key,
        key === "rows"
            ? value.rows.map((row) => Object.fromEntries(PERSISTENCE_TARGET_ROW_KEYS.map(
            // retain all missing station members explicitly
            (field) => [field, field === "captureMembers"
                    ? row.captureMembers.map((capture) => Object.fromEntries(PERSISTENCE_CAPTURE_KEYS.map(
                    // retain exact provider capture identity order
                    (captureField) => [captureField, capture[captureField]])))
                    : row[field]])))
            : value[key],
    ]));
}
// reproduce the fixed spatial weight from the retained gauge catalog
export function rainMaintenanceStationWeight(station) {
    const radians = Math.PI / 180;
    const latitude = station.latitude * radians;
    const longitude = station.longitude * radians;
    const siteLatitude = RAIN_COLLECTION_POLICY.latitude * radians;
    const siteLongitude = RAIN_COLLECTION_POLICY.longitude * radians;
    const a = Math.sin((latitude - siteLatitude) / 2) ** 2 +
        Math.cos(latitude) * Math.cos(siteLatitude) *
            Math.sin((longitude - siteLongitude) / 2) ** 2;
    const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(a));
    return 1 / (1 + (distance / 2_000) ** 2);
}
// select the deterministic lower weighted median at an exact half-mass tie
export function rainMaintenanceWeightedMedian(values) {
    const ordered = [...values].sort((left, right) => left.value - right.value || left.id - right.id);
    const half = ordered.reduce((total, item) => total + item.weight, 0) / 2;
    let cumulative = 0;
    // return the first value reaching the half-mass boundary
    for (const item of ordered) {
        cumulative += item.weight;
        if (cumulative >= half) {
            return item.value;
        }
    }
    throw new RangeError("rain persistence target is empty");
}
// bind the pre-fit feature body to the actual reviewed causal source
function validateRainFeatureSource(source) {
    const fingerprint = source.sourceConfigFingerprint;
    // close every fixed provider and adapter field while retaining the actual claim id
    if (source.adapterVersion !== "rain-hurdle-wind-features/v1" ||
        source.contractEpoch !== "rain-prospective-capture/v1" ||
        source.dataset !== "ecmwf_ifs" || source.providerKey !== "open-meteo-single-runs" ||
        fingerprint !== ADJUSTMENT_RAIN_SOURCE_CONFIG_FINGERPRINT ||
        typeof source.sourceId !== "string" || source.sourceId.length < 1 ||
        source.sourceId.length > 128 || source.sourceKey !== "rain-prospective-forecast" ||
        source.sourceKind !== "forecast" || source.upstreamModel !== "ecmwf_ifs") {
        throw new RangeError("adjustment rain feature source differs");
    }
}
// bind the body header to the exact current database content identity
function validateStoredProjectionBinding(value) {
    const first = value.rows[0];
    // weather records and anchors expose their stored content hash on the row
    if (value.projectionKind === "actual_best_match" || value.projectionKind === "target_revision") {
        if (first.contentSha256 !== value.storedContentSha256 || first.validAt !== value.logicalKey.validAt) {
            throw new RangeError("weather revision stored content differs");
        }
        return;
    }
    // the anchor pointer binds the same content, lead and valid clock
    if (value.projectionKind === "native_source" && value.logicalKey.sourceType === "forecast_anchor") {
        if (first.contentSha256 !== value.storedContentSha256 || first.validAt !== value.logicalKey.validAt ||
            first.leadHours !== value.logicalKey.leadHours) {
            throw new RangeError("forecast anchor stored content differs");
        }
        return;
    }
    // complete ECMWF runs use their run-level aggregate content identity
    if (value.projectionKind === "native_source" &&
        value.logicalKey.contentSha256 !== value.storedContentSha256) {
        throw new RangeError("temperature run stored content differs");
    }
}
// choose one exact value schema from the closed logical source type
function revisionRowKeys(value) {
    if (value.contractVersion === ADJUSTMENT_RAIN_GATE_FEATURE_PROJECTION_VERSION) {
        return RAIN_GATE_FEATURE_ROW_KEYS;
    }
    if (value.projectionKind === "rain_gate_input") {
        return RAIN_GATE_ROW_KEYS;
    }
    if (value.projectionKind === "native_source" && value.logicalKey.sourceType === "ecmwf_temperature_run") {
        return TEMPERATURE_ROW_KEYS;
    }
    if (value.projectionKind === "native_source") {
        return ANCHOR_ROW_KEYS;
    }
    return WEATHER_ROW_KEYS;
}
// bind each projection class to its only legal complete width
function expectedRowCount(value) {
    if (value.projectionKind === "rain_gate_input") {
        return 23;
    }
    if (value.projectionKind === "native_source" && value.logicalKey.sourceType === "ecmwf_temperature_run") {
        return 18;
    }
    return 1;
}
// validate the fixed lineage record without accepting private provider fields
function validateSource(source, kind) {
    // require content-bearing lineages to name their exact source contract
    for (const field of SOURCE_KEYS) {
        const value = source[field];
        if (value !== null && (typeof value !== "string" || value.length < 1 || value.length > 128 ||
            /[\u0000-\u001f\u007f]/u.test(value))) {
            throw new RangeError("adjustment revision source lineage is invalid");
        }
    }
    // rain gates use their model/input identity rather than a provider source row
    if (kind === "rain_gate_input") {
        if (SOURCE_KEYS.some((field) => source[field] !== null)) {
            throw new RangeError("rain gate source lineage must be null");
        }
        return;
    }
    // physical targets have no upstream model but retain every actual source field
    const required = kind === "target_revision"
        ? SOURCE_KEYS.filter((field) => field !== "upstreamModel")
        : SOURCE_KEYS;
    if (required.some((field) => source[field] === null) ||
        (kind === "target_revision" && source.upstreamModel !== null)) {
        throw new RangeError("adjustment revision source lineage is incomplete");
    }
}
// validate one kind-specific serving key
function validateLogicalKey(key, kind) {
    if (kind === "actual_best_match" || kind === "target_revision") {
        requireDecimal(key.sourceId);
        requireInstant(key.validAt);
        if (kind === "actual_best_match") {
            requireInstant(key.productRunAt);
            if (key.sourceKind !== "forecast")
                throw new RangeError("actual comparator key differs");
        }
        else if (key.productRunAt !== null || key.sourceKind !== "physical_sensor") {
            throw new RangeError("target revision key differs");
        }
        return;
    }
    if (kind === "rain_gate_input") {
        requireHash(key.inputSha256);
        requireHash(key.modelSha256);
        requireInstant(key.runInitializedAt);
        return;
    }
    // admit one fixed anchor or one complete ECMWF run
    if (key.sourceType === "forecast_anchor") {
        requireDecimal(key.sourceId);
        requireInstant(key.validAt);
        requireInteger(key.leadHours, 1, 384);
        if (key.contentSha256 !== null || key.providerResponseSha256 !== null ||
            key.runInitializedAt !== null || key.siteId !== null) {
            throw new RangeError("forecast anchor key differs");
        }
    }
    else if (key.sourceType === "ecmwf_temperature_run") {
        requireHash(key.contentSha256);
        requireHash(key.providerResponseSha256);
        requireInstant(key.runInitializedAt);
        requireDecimal(key.siteId);
        if (key.leadHours !== null || key.sourceId !== null || key.validAt !== null) {
            throw new RangeError("temperature run key differs");
        }
    }
    else {
        throw new RangeError("native source type differs");
    }
}
// validate one row against its database-backed class
function validateRevisionRow(projection, row, index) {
    if (projection.projectionKind === "rain_gate_input") {
        requireInteger(row.modelLeadHours, 1, 168);
        requireBoolean(row.applied);
        requireBinary64(row.rawPrecipitationMm64, false);
        requireBinary64(row.correctedPrecipitationMm64, true);
        // retain a database null reason without inventing a categorical label
        if (row.reasonCode !== null) {
            requireText(row.reasonCode);
        }
        return;
    }
    if (projection.projectionKind === "native_source" &&
        projection.logicalKey.sourceType === "ecmwf_temperature_run") {
        requireHash(row.contentSha256);
        if (row.modelLeadHours !== index + 1) {
            throw new RangeError("temperature native lead differs");
        }
        if (row.modelCycle !== "49r1" && row.modelCycle !== "50r1") {
            throw new RangeError("temperature native model cycle differs");
        }
        // retain the exact serving comparator only for the eligible lead-seven-to-eighteen horizon
        if (index < 6) {
            if (row.bestMatchContentSha256 !== null || row.bestMatchProductRunAt !== null ||
                row.bestMatchSourceId !== null || row.bestMatchTemperatureC64 !== null) {
                throw new RangeError("temperature native pre-serving comparator differs");
            }
        }
        else {
            requireHash(row.bestMatchContentSha256);
            requireInstant(row.bestMatchProductRunAt);
            requireDecimal(row.bestMatchSourceId);
            requireBinary64(row.bestMatchTemperatureC64, true);
        }
        requireBinary64(row.rawTemperatureC64, false);
        requireBinary64(row.rawRelativeHumidityPercent64, true);
        requireBinary64(row.rawWindSpeedMps64, true);
        return;
    }
    requireHash(row.contentSha256);
    if (projection.projectionKind === "native_source") {
        requireInteger(row.leadHours, 1, 384);
    }
    // validate every metric field using the frozen binary64 representation
    for (const [field, value] of Object.entries(row)) {
        if (field.endsWith("64")) {
            requireBinary64(value, true);
        }
    }
}
// require one nullable or present finite binary64
function requireBinary64(value, nullable) {
    if (value === null && nullable)
        return;
    decodeMaintenanceBinary64(value);
}
// require one canonical millisecond UTC clock
function requireInstant(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
        !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
        throw new RangeError("adjustment revision clock is invalid");
    }
}
// require one lowercase content identity
function requireHash(value) {
    if (typeof value !== "string" || !HASH.test(value)) {
        throw new RangeError("adjustment revision identity is invalid");
    }
}
// require one positive database identity
function requireDecimal(value) {
    if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
        throw new RangeError("adjustment revision database identity is invalid");
    }
}
// require one bounded integer
function requireInteger(value, minimum, maximum) {
    if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
        throw new RangeError("adjustment revision integer is invalid");
    }
}
// require one bounded reason or lineage label
function requireText(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw new RangeError("adjustment revision text is invalid");
    }
}
// require one actual boolean
function requireBoolean(value) {
    if (typeof value !== "boolean") {
        throw new RangeError("adjustment revision boolean is invalid");
    }
}
// prohibit unknown properties at every projection boundary
function exactKeys(value, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join() !== [...keys].sort().join()) {
        throw new RangeError("adjustment revision projection fields differ");
    }
}
