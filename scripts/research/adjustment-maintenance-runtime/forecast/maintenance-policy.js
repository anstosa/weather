import { FORECAST_OBSERVATION_PROVIDER_FAMILIES, } from "@weather/domain";
import { corePairedSkill } from "./algorithm-v1.js";
import { MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX, MOVING_BLOCK_BOOTSTRAP_REPLICATES, MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX, createMovingBlockBootstrapStartPlan, createSingleWindowBootstrapStartPlan, expandNonCircularBlockStarts, } from "./bootstrap-v1.js";
import { canonicalObjectSha256, canonicalSha256, deepFreeze } from "./candidate.js";
import { localCalendarFeaturesFor, } from "./calendar.js";
import { FORECAST_ADJUSTMENT_WIND_MAINTENANCE_METRIC_BANDS } from "./runtime-loader.js";
export const TEMPERATURE_MAINTENANCE_POLICY_VERSION = "temperature-maintenance-policy/v2";
export const WIND_MAINTENANCE_POLICY_VERSION = "wind-maintenance-policy/v2";
export const RAIN_MAINTENANCE_POLICY_VERSION = "rain-maintenance-policy/v2";
export const MAINTENANCE_POLICY_REPORT_EXPIRY_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000;
export const MAINTENANCE_EVALUATION_ROW_VERSION = "maintenance-evaluation-row/v1";
export const RAIN_MAINTENANCE_DEVELOPMENT_POPULATION_VERSION = "rain-maintenance-development-population/v3";
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const TEMPERATURE_HORIZONS = ["1-6", "7-12"];
const RAIN_LEAD_BANDS = ["1-6", "7-12", "13-23"];
const SEASONS = ["winter", "spring", "summer", "autumn"];
const RAIN_SEASONS = ["DJF", "MAM", "JJA", "SON"];
const DAYPARTS = ["night", "morning", "afternoon", "evening"];
const RAIN_THRESHOLDS = [0.1, 1, 2.5];
const RAIN_ACCUMULATION_HOURS = [6, 12, 23];
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
];
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
];
export const WIND_MAINTENANCE_PAIR_KEYS = deepFreeze(FORECAST_ADJUSTMENT_WIND_MAINTENANCE_METRIC_BANDS.map((pair) => `${pair.metric}:${pair.leadBand}`));
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
]);
// test one qualification receipt against the exact seven-day expiry
export function maintenancePolicyReportIsFresh(createdAt, releaseStartedAt) {
    const created = Date.parse(createdAt);
    const releaseStarted = Date.parse(releaseStartedAt);
    // reject malformed, backdated, and expired release starts
    return Number.isFinite(created) &&
        Number.isFinite(releaseStarted) &&
        releaseStarted >= created &&
        releaseStarted < created + MAINTENANCE_POLICY_REPORT_EXPIRY_MILLISECONDS;
}
// create one content-addressed evaluation row
export function createMaintenanceEvaluationRow(input) {
    requireExactKeys(input, BASE_ROW_KEYS.filter((key) => key !== "contractVersion" && key !== "rowSha256"), "maintenance row input");
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
export function createRainMaintenanceEvaluationRow(input) {
    requireExactKeys(input, RAIN_ROW_KEYS.filter((key) => key !== "contractVersion" &&
        key !== "family" &&
        key !== "pairKey" &&
        key !== "rowSha256"), "rain maintenance row input");
    const row = {
        ...input,
        contractVersion: MAINTENANCE_EVALUATION_ROW_VERSION,
        family: "rain",
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
export function evaluateTemperatureMaintenancePromotion(rows) {
    validatePopulation(rows, "temperature");
    const gates = baseEvidenceGates(rows);
    // require the complete temperature support matrix
    for (const [id, selected] of temperatureSupportSlices(rows)) {
        gates.push(supportGate(id, selected, 60, 1_000));
    }
    const population = populationReport(rows);
    gates.push(comparisonSkillGate("incumbent_skill", population.incumbent, 0.02));
    gates.push(comparisonSkillGate("native_source_skill", population.nativeSource, 0.02));
    gates.push(comparisonDifferenceGate("actual_best_match_margin", population.actualBestMatchAllRows, 0.10));
    // prevent aggregate wins from hiding any critical slice
    for (const [id, selected] of temperatureSupportSlices(rows).slice(1)) {
        gates.push(nonharmGate(`${id}_nonharm`, selected, 0.10));
    }
    return finalizePolicy(TEMPERATURE_MAINTENANCE_POLICY_VERSION, "promotion", population, gates);
}
// evaluate one complete registered temperature season
export function evaluateTemperatureMaintenanceRegression(rows, epoch) {
    validatePopulation(rows, "temperature");
    const gates = [
        ...baseEvidenceGates(rows),
        epochGate(epoch),
        supportGate("overall_support", rows, 60, 1_000),
    ];
    const population = populationReport(rows);
    gates.push(regressionSkillGate("active_native_source_harm", population.nativeSource));
    gates.push(regressionDifferenceGate("active_best_match_harm", population.actualBestMatchAllRows, 0.10));
    return finalizePolicy(TEMPERATURE_MAINTENANCE_POLICY_VERSION, "regression", population, gates);
}
// evaluate the exact thirteen-pair wind promotion contract
export function evaluateWindMaintenancePromotion(rows) {
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
        gates.push(comparisonDifferenceGate(`pair:${pairKey}:actual_best_match`, report.actualBestMatchAllRows, 0.10));
    }
    // require full support in every season present in the member
    for (const season of SEASONS) {
        const selected = rows.filter((row) => localCalendarFeaturesFor(row.validAt).season === season);
        gates.push(supportGate(`season:${season}:support`, selected, 60, 100));
    }
    // veto material harm in every supported prespecified slice
    for (const [sliceKey, selected] of windHarmSlices(rows)) {
        if (selected.length >= 100) {
            const comparison = pairedComparison(selected, "nativeSourcePrediction");
            const harmed = comparison.skill <= -0.02 && comparison.upperSkill < 0;
            gates.push(booleanGate(`slice:${sliceKey}:no_material_harm`, !harmed, `${comparison.skill}:${comparison.upperSkill}`, "skill > -0.02 or upper skill >= 0"));
        }
    }
    return finalizePolicy(WIND_MAINTENANCE_POLICY_VERSION, "promotion", populationReport(rows), gates);
}
// evaluate one registered wind regression season
export function evaluateWindMaintenanceRegression(rows, epoch) {
    validatePopulation(rows, "wind");
    validateWindPairSet(rows);
    const gates = [...baseEvidenceGates(rows), epochGate(epoch)];
    // require every enabled pair before equal-pair aggregation
    for (const pairKey of WIND_MAINTENANCE_PAIR_KEYS) {
        gates.push(supportGate(`pair:${pairKey}:support`, rows.filter((row) => row.pairKey === pairKey), 60, 100));
    }
    const nativeSource = equalGroupComparison(rows, WIND_MAINTENANCE_PAIR_KEYS, "nativeSourcePrediction");
    const actualBestMatch = equalGroupComparison(rows, WIND_MAINTENANCE_PAIR_KEYS, "actualBestMatchPrediction");
    gates.push(regressionSkillGate("equal_pair_native_source_harm", nativeSource));
    gates.push(regressionDifferenceGate("equal_pair_actual_best_match_harm", actualBestMatch, 0.10));
    return finalizePolicy(WIND_MAINTENANCE_POLICY_VERSION, "regression", populationReport(rows), gates);
}
// evaluate the rain promotion contract and all stable gates
export function evaluateRainMaintenancePromotion(rows) {
    validateRainPopulation(rows);
    const baseRows = rows;
    const gates = baseEvidenceGates(baseRows);
    const population = populationReport(baseRows);
    gates.push(comparisonSkillGate("incumbent_skill", population.incumbent, 0.02));
    gates.push(...rainStableGates(rows));
    gates.push(comparisonDifferenceGate("actual_best_match_overall", population.actualBestMatchAllRows, 0));
    // keep every season and lead within five percent of same-hour Best Match
    for (const [id, selected] of rainBestMatchSlices(rows)) {
        const comparison = comparisonOrNull(selected, "actualBestMatchPrediction");
        // keep unsupported slices pending instead of passing null metrics
        if (comparison === null) {
            gates.push(pendingGate(`${id}:actual_best_match_nonharm`, "candidate mae <= actual Best Match mae * 1.05"));
            continue;
        }
        const passing = comparison.candidateMae <= comparison.comparatorMae * 1.05;
        gates.push(booleanGate(`${id}:actual_best_match_nonharm`, passing, comparison.candidateMae - comparison.comparatorMae, "candidate mae <= actual Best Match mae * 1.05"));
    }
    gates.push(rainBrierGate(rows));
    gates.push(rainNestingGate(rows));
    gates.push(rainCoherenceGate(rows));
    return finalizePolicy(RAIN_MAINTENANCE_POLICY_VERSION, "promotion", population, gates);
}
// evaluate the frozen rain development population without promotion authority
export function evaluateRainMaintenanceDevelopment(rows) {
    validateRainPopulation(rows);
    // forbid prospective receipts from being relabelled as development evidence
    if (!rows.every((row) => row.evidenceClass === "historical_development")) {
        throw new RangeError("rain development evaluation requires historical rows");
    }
    const gates = rainStableGates(rows);
    const state = gates.some((gate) => gate.state === "fail")
        ? "fail"
        : gates.some((gate) => gate.state === "pending") ? "pending" : "pass";
    return deepFreeze({
        contractVersion: RAIN_MAINTENANCE_POLICY_VERSION,
        developmentRows: 32_896,
        gates,
        passed: state === "pass",
        populationSha256: canonicalObjectSha256({ rows: rows.map((row) => row.rowSha256), populationSha256: "" }, "populationSha256"),
        productionEligible: false,
        state,
    });
}
// evaluate one complete future-only annual development population without action authority
export function evaluateRainMaintenanceDevelopmentV3(rows, population) {
    validateRainPopulation(rows, null);
    validateRainDevelopmentPopulationV3(population, rows);
    // forbid prospective receipts from entering the historical screen
    if (!rows.every((row) => row.evidenceClass === "historical_development")) {
        throw new RangeError("rain development evaluation requires historical rows");
    }
    const gates = rainStableGates(rows);
    const state = gates.some((gate) => gate.state === "fail")
        ? "fail"
        : gates.some((gate) => gate.state === "pending") ? "pending" : "pass";
    return deepFreeze({
        contractVersion: RAIN_MAINTENANCE_POLICY_VERSION,
        developmentPopulationSha256: population.populationSha256,
        developmentRows: rows.length,
        gates,
        passed: state === "pass",
        populationSha256: canonicalObjectSha256({ rows: rows.map((row) => row.rowSha256), populationSha256: "" }, "populationSha256"),
        productionEligible: false,
        state,
    });
}
// evaluate the one authorized rain regression member
export function evaluateRainMaintenanceRegression(rows, epoch) {
    validateRainPopulation(rows);
    const baseRows = rows;
    const gates = [
        ...baseEvidenceGates(baseRows),
        epochGate(epoch),
        booleanGate("authorized_epoch", epoch.epochStartInclusive.slice(0, 10) === "2026-10-31" &&
            epoch.epochEndExclusive.slice(0, 10) === "2027-09-30" &&
            rows.every((row) => row.localDate >= "2026-10-31" && row.localDate <= "2027-09-29"), `${epoch.epochStartInclusive}/${epoch.epochEndExclusive}`, "exact authorized 2026-10-31..2027-09-29 member"),
        ...rainStableGates(rows),
    ];
    const population = populationReport(baseRows);
    gates.push(rainRegressionComparisonGate("active_native_source_harm", population.nativeSource));
    gates.push(rainRegressionComparisonGate("active_actual_best_match_harm", population.actualBestMatchAllRows));
    return finalizePolicy(RAIN_MAINTENANCE_POLICY_VERSION, "regression", population, gates);
}
// verify one immutable base row and its hash
function validateMaintenanceRowShape(row) {
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
    if (row.contractVersion !== MAINTENANCE_EVALUATION_ROW_VERSION ||
        row.key.length === 0 ||
        calendar.localDate !== row.localDate ||
        !Number.isInteger(row.horizonHours) ||
        row.horizonHours < 1 ||
        row.horizonHours > 168 ||
        numeric.some((value) => !Number.isFinite(value)) ||
        (row.farmTarget !== null && !Number.isFinite(row.farmTarget)) ||
        (row.providerFamily !== null &&
            !FORECAST_OBSERVATION_PROVIDER_FAMILIES.some((provider) => provider === row.providerFamily)) ||
        !HASH_PATTERN.test(row.sourceRowSha256) ||
        !HASH_PATTERN.test(row.targetRowSha256)) {
        throw new RangeError("maintenance evaluation row is invalid");
    }
    const prospectiveChronology = sourceReceiptAt !== null &&
        firstEdgeCommittedAt !== null &&
        Number.isFinite(sourceReceiptAt) &&
        Number.isFinite(firstEdgeCommittedAt) &&
        sourceReceiptAt <= firstEdgeCommittedAt &&
        firstEdgeCommittedAt < validAt;
    // prevent historical reads from being relabelled as fresh receipts
    if ((row.evidenceClass === "prospective_receipt" && !prospectiveChronology) ||
        (row.evidenceClass === "historical_development" &&
            (row.sourceReceiptAt !== null || row.firstEdgeCommittedAt !== null))) {
        throw new RangeError("maintenance evidence chronology is invalid");
    }
    // verify an assigned row digest without accepting caller assertions
    if (row.rowSha256.length > 0 &&
        canonicalObjectSha256(row, "rowSha256") !== row.rowSha256) {
        throw new RangeError("maintenance evaluation row hash is invalid");
    }
}
// verify one rain row and its closed numerical fields
function validateRainMaintenanceRowShape(row) {
    validateMaintenanceRowShape(row);
    const controls = [
        row.persistencePrediction,
        row.recentVolumeScalePrediction,
        row.sameWindowVolumeScalePrediction,
        row.unchangedOrdinalPrediction,
        row.volumeScalePrediction,
    ];
    // reject invalid controls, probabilities, and cold phase rows
    if (row.runKey.length === 0 ||
        controls.some((value) => !Number.isFinite(value) || value < 0) ||
        !validRainProbability(row.candidateProbability) ||
        !validRainProbability(row.incumbentProbability) ||
        !validRainProbability(row.nativeSourceProbability) ||
        row.rawTargetHourTemperatureC === null ||
        !Number.isFinite(row.rawTargetHourTemperatureC) ||
        row.rawTargetHourTemperatureC <= 2) {
        throw new RangeError("rain maintenance evaluation row is invalid");
    }
}
// validate one three-head probability record
function validRainProbability(probability) {
    return Object.keys(probability).join(",") ===
        "atLeast0_1,atLeast1_0,atLeast2_5" &&
        Object.values(probability).every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
}
// validate one complete hash-bound family population
function validatePopulation(rows, family) {
    // reject empty and cross-family evaluation inputs
    if (rows.length === 0 || rows.some((row) => row.family !== family)) {
        throw new RangeError("maintenance population has the wrong family");
    }
    const keys = new Set();
    const evidenceClasses = new Set(rows.map((row) => row.evidenceClass));
    // prohibit pooling prospective receipts with historical development rows
    if (evidenceClasses.size !== 1) {
        throw new RangeError("maintenance evidence classes cannot be pooled");
    }
    // verify every row and preserve the identical key population
    for (const row of rows) {
        requireExactKeys(row, family === "rain" ? RAIN_ROW_KEYS : BASE_ROW_KEYS, "maintenance evaluation row");
        validateMaintenanceRowShape(row);
        // reject duplicate same-hour comparison identities
        if (keys.has(row.key)) {
            throw new RangeError("maintenance population key is duplicated");
        }
        keys.add(row.key);
    }
}
// validate one rain-only population
function validateRainPopulation(rows, historicalRowCount = 32_896) {
    validatePopulation(rows, "rain");
    // verify every extended row after base population checks
    for (const row of rows) {
        validateRainMaintenanceRowShape(row);
    }
    const historical = rows.every((row) => row.evidenceClass === "historical_development");
    // preserve the frozen development population without calling it fresh
    if (historical && historicalRowCount !== null && rows.length !== historicalRowCount) {
        throw new RangeError("rain historical development population must contain 32896 rows");
    }
}
// validate one exact full-year value-blind development population
function validateRainDevelopmentPopulationV3(value, rows) {
    requireExactKeys(value, [
        "contractVersion", "cycleHours", "developmentEndAt", "developmentStartAt",
        "eligibleRowCount", "excludedColdRowCount", "expectedRowCount",
        "missingSourceRowCount", "missingTargetRowCount", "observedRowCount",
        "operationalHorizonHours", "populationMemberRootSha256",
        "populationReceiptRootSha256", "populationSha256", "sourceModelLeadHours",
        "sourcePopulation",
    ], "rain development population");
    const start = Date.parse(value.developmentStartAt);
    const end = Date.parse(value.developmentEndAt);
    const prior = new Date(end);
    prior.setUTCFullYear(prior.getUTCFullYear() - 1);
    const modelLeads = Array.from({ length: 23 }, (_unused, index) => index + 9);
    const operationalHorizons = Array.from({ length: 23 }, (_unused, index) => index + 1);
    // require one complete calendar year and the unchanged four-cycle geometry
    if (value.contractVersion !== RAIN_MAINTENANCE_DEVELOPMENT_POPULATION_VERSION ||
        !Number.isFinite(start) || !Number.isFinite(end) || start >= end ||
        prior.getTime() !== start || new Date(start).toISOString() !== value.developmentStartAt ||
        new Date(end).toISOString() !== value.developmentEndAt ||
        JSON.stringify(value.cycleHours) !== JSON.stringify([0, 6, 12, 18]) ||
        JSON.stringify(value.sourceModelLeadHours) !== JSON.stringify(modelLeads) ||
        JSON.stringify(value.operationalHorizonHours) !== JSON.stringify(operationalHorizons) ||
        !Array.isArray(value.sourcePopulation)) {
        throw new RangeError("rain development interval differs");
    }
    const expected = new Map();
    const hour = 3_600_000;
    const firstRun = Math.floor((start - 31 * hour) / (6 * hour)) * 6 * hour;
    // enumerate the issuance halo for every target-valid row in the annual interval
    for (let run = firstRun; run <= end - 9 * hour; run += 6 * hour) {
        const runInitializedAt = new Date(run).toISOString();
        const issuedAt = new Date(run + 8 * hour).toISOString();
        // preserve source leads nine through thirty-one as operational horizons one through twenty-three
        for (const modelLeadHours of modelLeads) {
            const valid = run + modelLeadHours * hour;
            // omit only targets outside the half-open development interval
            if (valid < start || valid >= end) {
                continue;
            }
            const validAt = new Date(valid).toISOString();
            expected.set(`${runInitializedAt}/${validAt}`, Object.freeze({
                issuedAt,
                modelLeadHours,
                operationalHorizonHours: modelLeadHours - 8,
                validAt,
            }));
        }
    }
    const sourceKeys = new Set();
    let eligible = 0;
    let excludedCold = 0;
    // validate every archived source identity without reading target values
    for (const member of value.sourcePopulation) {
        requireExactKeys(member, [
            "issuedAt", "key", "modelLeadHours", "operationalHorizonHours", "phaseEligible",
            "sourceMemberSha256", "sourceReceiptSha256", "targetAvailable", "validAt",
        ], "rain development population member");
        const geometry = expected.get(member.key);
        // require exact key coverage, geometry and immutable source identities
        if (geometry === undefined || sourceKeys.has(member.key) ||
            geometry.issuedAt !== member.issuedAt || geometry.validAt !== member.validAt ||
            geometry.modelLeadHours !== member.modelLeadHours ||
            geometry.operationalHorizonHours !== member.operationalHorizonHours ||
            typeof member.phaseEligible !== "boolean" || typeof member.targetAvailable !== "boolean" ||
            !HASH_PATTERN.test(member.sourceMemberSha256) ||
            !HASH_PATTERN.test(member.sourceReceiptSha256)) {
            throw new RangeError("rain development source member differs");
        }
        sourceKeys.add(member.key);
        // count only source-temperature eligibility, never target outcomes
        if (member.phaseEligible) {
            eligible += 1;
        }
        else {
            excludedCold += 1;
        }
    }
    const integers = [value.eligibleRowCount, value.excludedColdRowCount,
        value.expectedRowCount, value.missingSourceRowCount, value.missingTargetRowCount,
        value.observedRowCount];
    // reject incomplete or internally inconsistent annual source custody
    if (integers.some((count) => !Number.isSafeInteger(count) || count < 0) ||
        value.expectedRowCount !== expected.size || value.observedRowCount !== expected.size ||
        value.sourcePopulation.length !== expected.size || sourceKeys.size !== expected.size ||
        value.missingSourceRowCount !== 0 || value.missingTargetRowCount !== 0 ||
        value.eligibleRowCount !== eligible || value.excludedColdRowCount !== excludedCold ||
        eligible + excludedCold !== expected.size ||
        value.sourcePopulation.some((member) => member.phaseEligible && !member.targetAvailable) ||
        value.populationMemberRootSha256 !== canonicalSha256(value.sourcePopulation.map((member) => member.sourceMemberSha256).sort()) ||
        value.populationReceiptRootSha256 !== canonicalSha256([...new Set(value.sourcePopulation.map((member) => member.sourceReceiptSha256))].sort()) ||
        value.populationSha256 !== canonicalSha256(value.sourcePopulation)) {
        throw new RangeError("rain development population proof differs");
    }
    const eligibleKeys = value.sourcePopulation.filter((member) => member.phaseEligible)
        .map((member) => member.key).sort();
    const rowKeys = rows.map((row) => row.key).sort();
    // require the evaluator rows to equal the source-eligible target population exactly
    if (JSON.stringify(eligibleKeys) !== JSON.stringify(rowKeys)) {
        throw new RangeError("rain development evaluation population differs");
    }
}
// derive provenance and prospective-use gates
function baseEvidenceGates(rows) {
    const prospective = rows.every((row) => row.evidenceClass === "prospective_receipt");
    const provenance = rows.every((row) => row.provenanceComplete);
    return [
        booleanGate("prospective_evidence", prospective, prospective ? "prospective_receipt" : "historical_development", "all rows are prospective receipts", prospective ? "pass" : "pending"),
        booleanGate("complete_provenance", provenance, provenance ? "complete" : "incomplete", "all source and target provenance is complete", provenance ? "pass" : "pending"),
    ];
}
// enumerate the acting temperature support slices
function temperatureSupportSlices(rows) {
    const slices = [
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
function temperatureHorizon(row) {
    return row.horizonHours >= 1 && row.horizonHours <= 6
        ? "1-6"
        : row.horizonHours >= 7 && row.horizonHours <= 12 ? "7-12" : null;
}
// create one explicit support gate
function supportGate(id, rows, minimumDates, minimumRows) {
    const dateCount = new Set(rows.map((row) => row.localDate)).size;
    const passing = dateCount >= minimumDates && rows.length >= minimumRows;
    return booleanGate(id, passing, `${dateCount}/${rows.length}`, `dates >= ${minimumDates} and rows >= ${minimumRows}`, passing ? "pass" : "pending");
}
// calculate one date-balanced paired bootstrap comparison
function pairedComparison(rows, comparator) {
    const dates = [...new Set(rows.map((row) => row.localDate))].sort();
    // require enough dates for the frozen seven-day block
    if (dates.length < 7) {
        throw new RangeError("maintenance bootstrap requires seven dates");
    }
    const byDate = new Map();
    // reduce each date to equal-mass paired losses
    for (const localDate of dates) {
        const selected = rows.filter((row) => row.localDate === localDate);
        const candidate = selected.reduce((sum, row) => sum + Math.abs(row.candidatePrediction - row.target), 0) / selected.length;
        const baseline = selected.reduce((sum, row) => sum + Math.abs(row[comparator] - row.target), 0) / selected.length;
        byDate.set(localDate, { candidate, comparator: baseline });
    }
    const candidateMae = dates.reduce((sum, date) => sum + byDate.get(date).candidate / dates.length, 0);
    const comparatorMae = dates.reduce((sum, date) => sum + byDate.get(date).comparator / dates.length, 0);
    const skillReplicates = [];
    const differenceReplicates = [];
    // apply the exact frozen block-start plan
    for (const starts of createSingleWindowBootstrapStartPlan(dates.length)) {
        const selectedDates = expandNonCircularBlockStarts(starts, dates.length)
            .map((offset) => dates[offset]);
        const sampledCandidate = selectedDates.reduce((sum, date) => sum + byDate.get(date).candidate / selectedDates.length, 0);
        const sampledComparator = selectedDates.reduce((sum, date) => sum + byDate.get(date).comparator / selectedDates.length, 0);
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
    if (sortedSkills.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES ||
        lowerSkill === undefined ||
        upperSkill === undefined ||
        differenceLower === undefined ||
        differenceUpper === undefined) {
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
function equalGroupComparison(rows, groupKeys, comparator) {
    const groups = groupKeys.map((groupKey) => {
        const selected = rows.filter((row) => row.pairKey === groupKey);
        const dates = [...new Set(selected.map((row) => row.localDate))].sort();
        // require one bootstrappable population for every equal-weight group
        if (dates.length < 7) {
            throw new RangeError("equal-group bootstrap requires seven dates per group");
        }
        const losses = new Map();
        // reduce each group date before equal-group aggregation
        for (const localDate of dates) {
            const dateRows = selected.filter((row) => row.localDate === localDate);
            losses.set(localDate, {
                candidate: dateRows.reduce((sum, row) => sum + Math.abs(row.candidatePrediction - row.target), 0) /
                    dateRows.length,
                comparator: dateRows.reduce((sum, row) => sum + Math.abs(row[comparator] - row.target), 0) /
                    dateRows.length,
            });
        }
        return { dates, losses };
    });
    const candidateMae = groups.reduce((groupSum, group) => groupSum + group.dates.reduce((dateSum, date) => dateSum + group.losses.get(date).candidate / group.dates.length, 0) /
        groups.length, 0);
    const comparatorMae = groups.reduce((groupSum, group) => groupSum + group.dates.reduce((dateSum, date) => dateSum + group.losses.get(date).comparator / group.dates.length, 0) /
        groups.length, 0);
    const plan = createMovingBlockBootstrapStartPlan(groups.map((group) => group.dates.length));
    const skillReplicates = [];
    const differenceReplicates = [];
    // retain equal group weight inside every bootstrap replicate
    for (const replicate of plan) {
        let sampledCandidate = 0;
        let sampledComparator = 0;
        // resample every group independently under the shared frozen plan
        for (let index = 0; index < groups.length; index += 1) {
            const group = groups[index];
            const starts = replicate[index];
            const sampledDates = expandNonCircularBlockStarts(starts, group.dates.length).map((offset) => group.dates[offset]);
            sampledCandidate += sampledDates.reduce((sum, date) => sum + group.losses.get(date).candidate / sampledDates.length, 0) /
                groups.length;
            sampledComparator += sampledDates.reduce((sum, date) => sum + group.losses.get(date).comparator / sampledDates.length, 0) /
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
    if (sortedSkills.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES ||
        lowerSkill === undefined ||
        upperSkill === undefined ||
        differenceLower === undefined ||
        differenceUpper === undefined) {
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
function populationReport(rows) {
    const applied = rows.filter((row) => row.applied);
    const farm = rows.filter((row) => row.farmTarget !== null);
    return {
        actualBestMatchAllRows: comparisonOrNull(rows, "actualBestMatchPrediction"),
        actualBestMatchAppliedOnly: comparisonOrNull(applied, "actualBestMatchPrediction"),
        farmDiagnosticMae: farm.length === 0
            ? null
            : farm.reduce((sum, row) => sum + Math.abs(row.candidatePrediction - row.farmTarget), 0) /
                farm.length,
        incumbent: comparisonOrNull(rows, "incumbentPrediction"),
        nativeSource: comparisonOrNull(rows, "nativeSourcePrediction"),
        populationSha256: canonicalObjectSha256({ rows: rows.map((row) => row.rowSha256), populationSha256: "" }, "populationSha256"),
    };
}
// preserve unavailable bootstrap comparisons as explicit null diagnostics
function comparisonOrNull(rows, comparator) {
    return new Set(rows.map((row) => row.localDate)).size < 7
        ? null
        : pairedComparison(rows, comparator);
}
// derive one skill-plus-uncertainty promotion gate
function comparisonSkillGate(id, comparison, minimumSkill) {
    // keep unsupported comparisons pending
    if (comparison === null) {
        return pendingGate(id, `skill >= ${minimumSkill} and lower skill > 0`);
    }
    return booleanGate(id, comparison.skill >= minimumSkill && comparison.lowerSkill > 0, `${comparison.skill}:${comparison.lowerSkill}`, `skill >= ${minimumSkill} and lower skill > 0`);
}
// derive one upper-bound noninferiority gate
function comparisonDifferenceGate(id, comparison, maximumDifference) {
    // keep unsupported comparisons pending
    if (comparison === null) {
        return pendingGate(id, `difference upper <= ${maximumDifference}`);
    }
    return booleanGate(id, comparison.differenceUpper <= maximumDifference, comparison.differenceUpper, `difference upper <= ${maximumDifference}`);
}
// derive one critical-slice nonharm gate
function nonharmGate(id, rows, bestMatchMargin) {
    const candidate = meanAbsoluteError(rows, "candidatePrediction");
    const incumbent = meanAbsoluteError(rows, "incumbentPrediction");
    const source = meanAbsoluteError(rows, "nativeSourcePrediction");
    const bestMatch = meanAbsoluteError(rows, "actualBestMatchPrediction");
    // keep missing slice metrics pending
    if ([candidate, incumbent, source, bestMatch].some((value) => value === null)) {
        return pendingGate(id, "candidate no worse than incumbent, source, or Best Match margin");
    }
    return booleanGate(id, candidate <= incumbent &&
        candidate <= source &&
        candidate <= bestMatch + bestMatchMargin, candidate, `candidate <= incumbent/source and <= Best Match + ${bestMatchMargin}`);
}
// derive one date-balanced mean absolute error
function meanAbsoluteError(rows, prediction) {
    const dates = [...new Set(rows.map((row) => row.localDate))];
    // preserve unsupported empty populations
    if (dates.length === 0) {
        return null;
    }
    return dates.reduce((dateSum, localDate) => {
        const selected = rows.filter((row) => row.localDate === localDate);
        return dateSum + selected.reduce((sum, row) => sum + Math.abs(row[prediction] - row.target), 0) /
            selected.length / dates.length;
    }, 0);
}
// derive one active-versus-source regression gate
function regressionSkillGate(id, comparison) {
    // keep unsupported regression evidence pending
    if (comparison === null) {
        return pendingGate(id, "skill <= -0.02 and upper skill < 0");
    }
    return booleanGate(id, comparison.skill <= -0.02 && comparison.upperSkill < 0, `${comparison.skill}:${comparison.upperSkill}`, "skill <= -0.02 and upper skill < 0");
}
// derive one active-versus-Best-Match regression gate
function regressionDifferenceGate(id, comparison, minimumDifference) {
    // keep unsupported regression evidence pending
    if (comparison === null) {
        return pendingGate(id, `difference lower > ${minimumDifference}`);
    }
    return booleanGate(id, comparison.differenceLower > minimumDifference, comparison.differenceLower, `difference lower > ${minimumDifference}`);
}
// verify registration, close, and seven-day action delay
function epochGate(epoch) {
    const registered = Date.parse(epoch.registeredAt);
    const start = Date.parse(epoch.epochStartInclusive);
    const end = Date.parse(epoch.epochEndExclusive);
    const evaluated = Date.parse(epoch.evaluatedAt);
    const passing = [registered, start, end, evaluated].every(Number.isFinite) &&
        registered < start &&
        start < end &&
        evaluated >= end + MAINTENANCE_POLICY_REPORT_EXPIRY_MILLISECONDS;
    return booleanGate("registered_complete_epoch", passing, `${epoch.registeredAt}/${epoch.evaluatedAt}`, "registered before start and evaluated seven days after close", passing ? "pass" : "pending");
}
// enumerate all supported wind harm slices
function windHarmSlices(rows) {
    const slices = new Map();
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
    return [...slices.entries()].sort(([left], [right]) => left.localeCompare(right));
}
// reject missing, extra, direction, or gust-49-72 wind pairs
function validateWindPairSet(rows) {
    const actual = [...new Set(rows.map((row) => row.pairKey))].sort();
    const expected = [...WIND_MAINTENANCE_PAIR_KEYS].sort();
    // require exactly seven speed and six gust pairs
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new RangeError("wind maintenance population must contain exactly 13 pairs");
    }
}
// derive all forty-nine stable rain gates from row metrics
function rainStableGates(rows) {
    const gates = new Map();
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
    if (gates.size !== RAIN_ORIGINAL_STABLE_GATE_IDS.length ||
        RAIN_ORIGINAL_STABLE_GATE_IDS.some((id) => !gates.has(id))) {
        throw new Error("rain stable gate manifest is incomplete");
    }
    return RAIN_ORIGINAL_STABLE_GATE_IDS.map((id) => gates.get(id));
}
// store one derived rain gate without caller-supplied pass flags
function setRainGate(gates, id, passing, actual, criterion, state, pendingOnFailure = false) {
    // reject duplicate stable gate identities
    if (gates.has(id)) {
        throw new Error(`rain gate is duplicated: ${id}`);
    }
    gates.set(id, booleanGate(id, passing, actual, criterion, state ?? (passing ? "pass" : pendingOnFailure ? "pending" : "fail")));
}
// summarize scalar rain loss and volume metrics
function rainMetrics(rows) {
    const weights = dateBalancedWeights(rows);
    const candidateErrors = rows.map((row) => Math.abs(row.candidatePrediction - row.target));
    const rawErrors = rows.map((row) => Math.abs(row.nativeSourcePrediction - row.target));
    const observed = rows.reduce((sum, row, index) => sum + row.target * weights[index], 0);
    return {
        candidateMae: weightedSum(candidateErrors, weights),
        candidateRmse: Math.sqrt(weightedSum(rows.map((row) => (row.candidatePrediction - row.target) ** 2), weights)),
        heavyCandidateMae: conditionalRainMae(rows, "candidatePrediction", 2.5),
        heavyRawMae: conditionalRainMae(rows, "nativeSourcePrediction", 2.5),
        rawMae: weightedSum(rawErrors, weights),
        rawRmse: Math.sqrt(weightedSum(rows.map((row) => (row.nativeSourcePrediction - row.target) ** 2), weights)),
        volumeRatio: observed === 0 ? null : rows.reduce((sum, row, index) => sum + row.candidatePrediction * weights[index], 0) / observed,
        wetCandidateMae: conditionalRainMae(rows, "candidatePrediction", 0.1),
        wetRawMae: conditionalRainMae(rows, "nativeSourcePrediction", 0.1),
    };
}
// assign equal local-date then row mass
function dateBalancedWeights(rows) {
    const dates = new Map();
    // count each retained row by local date
    for (const row of rows) {
        dates.set(row.localDate, (dates.get(row.localDate) ?? 0) + 1);
    }
    return rows.map((row) => 1 / dates.size / dates.get(row.localDate));
}
// combine one weighted scalar array
function weightedSum(values, weights) {
    return values.reduce((sum, value, index) => sum + value * weights[index], 0);
}
// calculate one conditional date-balanced rain mae
function conditionalRainMae(rows, prediction, threshold) {
    const selected = rows.filter((row) => row.target >= threshold);
    // preserve unsupported event strata as null
    if (selected.length === 0) {
        return null;
    }
    const weights = dateBalancedWeights(selected);
    return weightedSum(selected.map((row) => Math.abs(row[prediction] - row.target)), weights);
}
// calculate one control mae on the identical population
function rainControlMae(rows, prediction) {
    const weights = dateBalancedWeights(rows);
    return weightedSum(rows.map((row) => Math.abs(row[prediction] - row.target)), weights);
}
// report rain support using unique dates and hours
function rainSupport(rows) {
    return {
        dates: new Set(rows.map((row) => row.localDate)).size,
        heavyHours: new Set(rows.filter((row) => row.target >= 2.5).map((row) => row.validAt)).size,
        wetDates: new Set(rows.filter((row) => row.target >= 0.1).map((row) => row.localDate)).size,
    };
}
// compare rain support with one fixed boundary
function rainSupportPass(rows, dates, wetDates, heavyHours) {
    const support = rainSupport(rows);
    return support.dates >= dates &&
        support.wetDates >= wetDates &&
        support.heavyHours >= heavyHours;
}
// serialize one rain support diagnostic
function rainSupportText(rows) {
    const support = rainSupport(rows);
    return `${support.dates}/${support.wetDates}/${support.heavyHours}`;
}
// calculate deterministic occurrence diagnostics
function eventMetrics(rows, prediction, threshold) {
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
function eventSafety(candidate, baseline) {
    // reject missing event metrics instead of passing nulls
    if (candidate.pod === null || candidate.csi === null || candidate.far === null ||
        baseline.pod === null || baseline.csi === null || baseline.far === null) {
        return false;
    }
    return candidate.pod >= baseline.pod - 1e-12 &&
        candidate.csi >= baseline.csi - 0.01 &&
        candidate.far <= baseline.far + 0.05;
}
// enumerate exact rain season slices
function rainSeasonSlices(rows) {
    return RAIN_SEASONS.map((season) => [
        season,
        rows.filter((row) => rainSeason(row.validAt) === season),
    ]);
}
// map local seasons to frozen rain labels
function rainSeason(validAt) {
    const season = localCalendarFeaturesFor(validAt).season;
    return season === "winter"
        ? "DJF"
        : season === "spring" ? "MAM" : season === "summer" ? "JJA" : "SON";
}
// enumerate exact rain operational lead slices
function rainLeadSlices(rows) {
    return RAIN_LEAD_BANDS.map((lead) => [
        lead,
        rows.filter((row) => rainLeadBand(row.horizonHours) === lead),
    ]);
}
// classify one explicit rain horizon
function rainLeadBand(horizon) {
    return horizon <= 6 ? "1-6" : horizon <= 12 ? "7-12" : horizon <= 23 ? "13-23" : null;
}
// score complete same-run rain accumulation windows
function rainAccumulation(rows, hours) {
    const byRun = new Map();
    // partition rows without crossing source runs
    for (const row of rows) {
        const selected = byRun.get(row.runKey) ?? [];
        selected.push(row);
        byRun.set(row.runKey, selected);
    }
    const candidateErrors = [];
    const rawErrors = [];
    // scan every run for exact consecutive windows
    for (const runRows of byRun.values()) {
        const sorted = [...runRows].sort((left, right) => left.validAt.localeCompare(right.validAt));
        // retain every complete sliding window
        for (let start = 0; start + hours <= sorted.length; start += 1) {
            const window = sorted.slice(start, start + hours);
            const first = Date.parse(window[0].validAt);
            const complete = window.every((row, index) => Date.parse(row.validAt) === first + index * 3_600_000);
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
function seasonalVolumeDeviation(rows, prediction) {
    const deviations = rainSeasonSlices(rows).map(([, selected]) => {
        const weights = dateBalancedWeights(selected);
        const observed = selected.reduce((sum, row, index) => sum + row.target * weights[index], 0);
        // keep dry or absent seasons maximally unsupported
        if (selected.length === 0 || observed === 0) {
            return Number.POSITIVE_INFINITY;
        }
        const forecast = selected.reduce((sum, row, index) => sum + row[prediction] * weights[index], 0);
        return Math.abs(forecast / observed - 1);
    });
    return Math.max(...deviations);
}
// preserve unchanged ordinal heavy-event skill
function rainHeavySkillRetained(rows) {
    const candidateHeavy = conditionalRainMae(rows, "candidatePrediction", 2.5);
    const ordinalHeavy = conditionalRainMae(rows, "unchangedOrdinalPrediction", 2.5);
    // reject missing heavy support
    if (candidateHeavy === null || ordinalHeavy === null || candidateHeavy > ordinalHeavy + 1e-12) {
        return false;
    }
    // require both heavy occurrence definitions
    for (const threshold of [1, 2.5]) {
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
function rainBestMatchSlices(rows) {
    return [
        ...rainSeasonSlices(rows).map(([key, selected]) => [`season:${key}`, selected]),
        ...rainLeadSlices(rows).map(([key, selected]) => [`lead:${key}`, selected]),
    ];
}
// require candidate Brier noninferiority to incumbent and source
function rainBrierGate(rows) {
    let candidate = 0;
    let incumbent = 0;
    let source = 0;
    const weights = dateBalancedWeights(rows);
    // score all three probability heads on identical rows
    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const weight = weights[index] / RAIN_THRESHOLDS.length;
        // add each named occurrence loss
        for (const threshold of RAIN_THRESHOLDS) {
            const observed = Number(row.target >= threshold);
            const key = threshold === 0.1 ? "atLeast0_1" : threshold === 1 ? "atLeast1_0" : "atLeast2_5";
            candidate += weight * (row.candidateProbability[key] - observed) ** 2;
            incumbent += weight * (row.incumbentProbability[key] - observed) ** 2;
            source += weight * (row.nativeSourceProbability[key] - observed) ** 2;
        }
    }
    return booleanGate("probability_brier_nonharm", candidate <= incumbent && candidate <= source, candidate, "candidate Brier <= incumbent and native source");
}
// require monotonically nested candidate probabilities
function rainNestingGate(rows) {
    const violations = rows.filter((row) => row.candidateProbability.atLeast0_1 < row.candidateProbability.atLeast1_0 ||
        row.candidateProbability.atLeast1_0 < row.candidateProbability.atLeast2_5).length;
    return booleanGate("probability_nesting", violations === 0, violations, "p2.5 <= p1.0 <= p0.1");
}
// require nonzero probability support for every projected amount category
function rainCoherenceGate(rows) {
    const violations = rows.filter((row) => (row.candidatePrediction >= 0.1 && row.candidateProbability.atLeast0_1 === 0) ||
        (row.candidatePrediction >= 1 && row.candidateProbability.atLeast1_0 === 0) ||
        (row.candidatePrediction >= 2.5 && row.candidateProbability.atLeast2_5 === 0)).length;
    return booleanGate("amount_probability_coherence", violations === 0, violations, "projected categories retain nonzero occurrence probability");
}
// derive the conjunctive rain regression comparison
function rainRegressionComparisonGate(id, comparison) {
    // keep unsupported regression comparisons pending
    if (comparison === null) {
        return pendingGate(id, "mae >= comparator * 1.05 and difference lower > 0");
    }
    return booleanGate(id, comparison.candidateMae >= comparison.comparatorMae * 1.05 &&
        comparison.differenceLower > 0, `${comparison.candidateMae}:${comparison.differenceLower}`, "mae >= comparator * 1.05 and difference lower > 0");
}
// require one closed object field set
function requireExactKeys(value, expected, name) {
    const actual = Object.keys(value).sort();
    const required = [...expected].sort();
    // reject missing and unknown fields together
    if (JSON.stringify(actual) !== JSON.stringify(required)) {
        throw new RangeError(`${name} fields are invalid`);
    }
}
// create one explicit boolean gate
function booleanGate(id, passing, actual, criterion, state = passing ? "pass" : "fail") {
    return { actual, criterion, id, state };
}
// create one unsupported gate that cannot pass through null
function pendingGate(id, criterion) {
    return { actual: null, criterion, id, state: "pending" };
}
// finalize conjunction state and action without null-pass behavior
function finalizePolicy(contractVersion, mode, population, gates) {
    const state = gates.some((gate) => gate.state === "fail")
        ? "fail"
        : gates.some((gate) => gate.state === "pending") ? "pending" : "pass";
    const action = state === "pending"
        ? "pending"
        : state === "pass" ? mode === "promotion" ? "promote" : "regress" : "retain";
    return deepFreeze({ action, contractVersion, gates, mode, population, state });
}
