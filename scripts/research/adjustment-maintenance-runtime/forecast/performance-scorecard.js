import { FORECAST_OBSERVATION_STATIONS, RAIN_COLLECTION_POLICY, RAIN_COLLECTION_STATIONS, } from "@weather/domain";
import { corePairedSkill, scalarNetworkActual } from "./algorithm-v1.js";
import { MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX, MOVING_BLOCK_BOOTSTRAP_REPLICATES, MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX, createSingleWindowBootstrapStartPlan, expandNonCircularBlockStarts, } from "./bootstrap-v1.js";
import { localCalendarFeaturesFor } from "./calendar.js";
export const FORECAST_ADJUSTMENT_PERFORMANCE_REPORT_VERSION = "forecast-adjustment-performance-report/v1";
export const FORECAST_ADJUSTMENT_RAIN_FROZEN_DEVELOPMENT_ROWS = 32_896;
const RAIN_GAUGE_IDS = new Set(RAIN_COLLECTION_STATIONS.map((station) => station.locationId));
const RAIN_NEAREST_GAUGE_IDS = new Set(RAIN_COLLECTION_STATIONS
    .slice(0, 3)
    .map((station) => station.locationId));
const RAIN_THRESHOLDS = [0.1, 1, 2.5];
// parse one canonical instant before chronology comparisons
function instant(value, name) {
    const parsed = Date.parse(value);
    // reject normalized, offset or invalid instants
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
        throw new RangeError(`${name} must be a canonical UTC instant`);
    }
    return parsed;
}
// compare all scoring content that must be identical across overlap surfaces
function overlapContent(pair) {
    return JSON.stringify({
        adjustedPrediction: pair.adjustedPrediction,
        evidenceClass: pair.evidenceClass,
        fallback: pair.fallback,
        horizonHours: pair.horizonHours,
        key: pair.key,
        localDate: pair.localDate,
        provenanceComplete: pair.provenanceComplete,
        rawPrediction: pair.rawPrediction,
        rowIdentity: pair.rowIdentity,
        target: pair.target,
        targetKey: pair.targetKey,
        validAt: pair.validAt,
        vintageKey: pair.vintageKey,
    });
}
// coalesce overlapping response windows at the earliest committed edge response
export function coalesceForecastAdjustmentPerformancePairs(pairs) {
    const byIdentity = new Map();
    let duplicateCount = 0;
    // merge only the same stable row revision, settings and bundle identity
    for (const pair of pairs) {
        const identity = `${pair.rowIdentity}\u0000${pair.targetKey}`;
        const existing = byIdentity.get(identity);
        // retain the first unique row identity
        if (existing === undefined) {
            byIdentity.set(identity, pair);
            continue;
        }
        // stop a stable-identity scoring collision rather than repairing it
        if (overlapContent(existing) !== overlapContent(pair)) {
            throw new RangeError("forecast adjustment overlap identity collision");
        }
        duplicateCount += 1;
        const existingCommit = existing.firstEdgeCommittedAt;
        const pairCommit = pair.firstEdgeCommittedAt;
        // retain the earliest proven edge commit across days surfaces
        if (pairCommit !== null &&
            (existingCommit === null || instant(pairCommit, "firstEdgeCommittedAt") <
                instant(existingCommit, "firstEdgeCommittedAt"))) {
            byIdentity.set(identity, pair);
        }
    }
    return {
        duplicateCount,
        rows: [...byIdentity.values()].sort((left, right) => left.localDate.localeCompare(right.localDate) ||
            left.validAt.localeCompare(right.validAt) ||
            left.vintageKey.localeCompare(right.vintageKey) ||
            left.key.localeCompare(right.key)),
    };
}
// count one exclusion without hiding its causal class
function incrementExclusion(exclusions, reason) {
    exclusions[reason] += 1;
}
// validate and filter paired rows under the first-commit causal guard
export function prepareForecastAdjustmentPerformancePairs(pairs) {
    const coalesced = coalesceForecastAdjustmentPerformancePairs(pairs);
    const exclusions = {
        invalid_target: 0,
        issued_after_valid: 0,
        missing_target: 0,
        receipt_chronology_missing: 0,
        source_late: 0,
    };
    const diagnostics = {
        provenance_incomplete: 0,
    };
    const rows = [];
    const keys = new Set();
    let fallbackCount = 0;
    // validate every paired occurrence before adding it to the score population
    for (const pair of coalesced.rows) {
        const calendar = localCalendarFeaturesFor(pair.validAt);
        // bind declared dates and finite paired predictions
        if (pair.key.length === 0 || pair.rowIdentity.length === 0 ||
            pair.targetKey.length === 0 || pair.vintageKey.length === 0 ||
            calendar.localDate !== pair.localDate ||
            !Number.isFinite(pair.rawPrediction) ||
            !Number.isFinite(pair.adjustedPrediction) ||
            !Number.isInteger(pair.horizonHours) || pair.horizonHours < 1) {
            throw new RangeError("forecast adjustment paired row is invalid");
        }
        const pairIdentity = `${pair.key}\u0000${pair.targetKey}`;
        // reject duplicate true-vintage keys after overlap coalescing
        if (keys.has(pairIdentity)) {
            throw new RangeError("forecast adjustment paired key is duplicated");
        }
        keys.add(pairIdentity);
        // exclude missing targets from both raw and adjusted populations
        if (pair.target === null) {
            incrementExclusion(exclusions, "missing_target");
            continue;
        }
        // exclude malformed targets from both sides
        if (!Number.isFinite(pair.target)) {
            incrementExclusion(exclusions, "invalid_target");
            continue;
        }
        // preserve raw fallback equality as an auditable invariant
        if (pair.fallback && !Object.is(pair.rawPrediction, pair.adjustedPrediction)) {
            throw new RangeError("forecast adjustment fallback differs from raw");
        }
        // retain incomplete provenance for descriptive scoring only
        if (!pair.provenanceComplete) {
            diagnostics.provenance_incomplete += 1;
        }
        const usesReceiptGuard = pair.evidenceClass === "as_issued" ||
            pair.evidenceClass === "prospective_receipt";
        // require both sides of causal chronology for receipt-backed evidence
        if (usesReceiptGuard &&
            (pair.sourceReceiptAt === null || pair.firstEdgeCommittedAt === null)) {
            incrementExclusion(exclusions, "receipt_chronology_missing");
            continue;
        }
        // apply chronology only when a committed edge response is claimed
        if (pair.firstEdgeCommittedAt !== null) {
            const committedAt = instant(pair.firstEdgeCommittedAt, "firstEdgeCommittedAt");
            const validAt = instant(pair.validAt, "validAt");
            let chronologyExcluded = false;
            // count past rows independently from source lateness
            if (committedAt >= validAt) {
                incrementExclusion(exclusions, "issued_after_valid");
                chronologyExcluded = true;
            }
            // require source availability no later than the first edge commit
            if (pair.sourceReceiptAt === null ||
                instant(pair.sourceReceiptAt, "sourceReceiptAt") > committedAt) {
                incrementExclusion(exclusions, "source_late");
                chronologyExcluded = true;
            }
            // exclude the row once after preserving every causal counter
            if (chronologyExcluded) {
                continue;
            }
        }
        fallbackCount += Number(pair.fallback);
        rows.push(pair);
    }
    return {
        coalescedDuplicateCount: coalesced.duplicateCount,
        diagnostics,
        exclusions,
        fallbackCount,
        rows,
    };
}
// assign equal date, then valid-hour, then vintage mass
export function balanceForecastAdjustmentPerformancePairs(pairs) {
    // reject empty success instead of returning zero error
    if (pairs.length === 0) {
        throw new RangeError("forecast adjustment score population is empty");
    }
    const evidenceClasses = new Set(pairs.map((pair) => pair.evidenceClass));
    // prevent retrospective and issued populations from being pooled
    if (evidenceClasses.size !== 1) {
        throw new RangeError("forecast adjustment evidence classes cannot be aggregated");
    }
    const byDate = new Map();
    // collect true vintages under each local-date and valid-hour identity
    for (const pair of pairs) {
        const byHour = byDate.get(pair.localDate) ??
            new Map();
        const vintages = byHour.get(pair.validAt) ?? [];
        vintages.push(pair);
        byHour.set(pair.validAt, vintages);
        byDate.set(pair.localDate, byHour);
    }
    const weighted = [];
    // grant each date equal total mass
    for (const [, byHour] of [...byDate.entries()].sort()) {
        // grant each valid hour equal mass inside its date
        for (const [, vintages] of [...byHour.entries()].sort()) {
            // grant each true vintage equal mass inside its valid hour
            for (const pair of vintages.sort((left, right) => left.vintageKey.localeCompare(right.vintageKey))) {
                weighted.push({
                    ...pair,
                    weight: 1 / byDate.size / byHour.size / vintages.length,
                });
            }
        }
    }
    return weighted;
}
// select a deterministic weighted quantile including exact 0 and 1 endpoints
function weightedQuantile(values, probability) {
    const sorted = [...values].sort((left, right) => left.value - right.value);
    let cumulative = 0;
    // return the first value whose cumulative mass reaches the quantile
    for (const entry of sorted) {
        cumulative += entry.weight;
        // retain deterministic left-continuous quantiles
        if (cumulative >= probability - Number.EPSILON) {
            return entry.value;
        }
    }
    const last = sorted.at(-1);
    // retain the compiler-proven nonempty distribution
    if (last === undefined) {
        throw new RangeError("weighted quantile requires values");
    }
    return last.value;
}
// compute one weighted error distribution
function metricSummary(pairs, prediction) {
    let absolute = 0;
    let signed = 0;
    let squared = 0;
    const errors = [];
    // aggregate the same paired target and weight on each side
    for (const pair of pairs) {
        const target = pair.target;
        // retain the post-filter compiler-proven target
        if (target === null) {
            throw new Error("scored pair lost its target");
        }
        const error = pair[prediction] - target;
        absolute += pair.weight * Math.abs(error);
        signed += pair.weight * error;
        squared += pair.weight * error ** 2;
        errors.push({ value: Math.abs(error), weight: pair.weight });
    }
    return {
        bias: signed,
        mae: absolute,
        p95AbsoluteError: weightedQuantile(errors, 0.95),
        rmse: Math.sqrt(squared),
    };
}
// score paired distributions with zero-safe skill and signed deltas
export function scoreBalancedForecastAdjustmentPairs(pairs) {
    const weightedRows = balanceForecastAdjustmentPerformancePairs(pairs);
    const raw = metricSummary(weightedRows, "rawPrediction");
    const adjusted = metricSummary(weightedRows, "adjustedPrediction");
    return {
        metrics: {
            adjusted,
            delta: {
                bias: adjusted.bias - raw.bias,
                mae: adjusted.mae - raw.mae,
                p95AbsoluteError: adjusted.p95AbsoluteError - raw.p95AbsoluteError,
                rmse: adjusted.rmse - raw.rmse,
            },
            raw,
            skill: corePairedSkill(raw.mae, adjusted.mae),
        },
        weightedRows,
    };
}
// score one sampled sequence of local dates under the same nested weights
function sampledDateSkill(lossesByDate, selectedDates) {
    let raw = 0;
    let adjusted = 0;
    // treat repeated bootstrap date selections as separate equal-mass slots
    for (const localDate of selectedDates) {
        const losses = lossesByDate.get(localDate);
        // retain one precomputed complete date loss
        if (losses === undefined) {
            throw new Error("bootstrap selected a missing date");
        }
        raw += losses.rawMae / selectedDates.length;
        adjusted += losses.adjustedMae / selectedDates.length;
    }
    return corePairedSkill(raw, adjusted);
}
// run the frozen 2,000-replicate seven-date moving-block bootstrap
export function bootstrapBalancedForecastAdjustmentPairs(pairs) {
    const dates = [...new Set(pairs.map((pair) => pair.localDate))].sort();
    // expose explicit insufficient support below the frozen block length
    if (dates.length < 7) {
        return null;
    }
    const lossesByDate = new Map();
    // precompute each date's invariant nested-weight losses once
    for (const localDate of dates) {
        const weighted = balanceForecastAdjustmentPerformancePairs(pairs.filter((pair) => pair.localDate === localDate));
        lossesByDate.set(localDate, {
            adjustedMae: metricSummary(weighted, "adjustedPrediction").mae,
            rawMae: metricSummary(weighted, "rawPrediction").mae,
        });
    }
    const plan = createSingleWindowBootstrapStartPlan(dates.length);
    const skills = [];
    // score the exact frozen start plan without dropping replicates
    for (const starts of plan) {
        const offsets = expandNonCircularBlockStarts(starts, dates.length);
        const selectedDates = offsets.map((offset) => dates[offset]);
        // retain compiler-proven sampled date identities
        if (selectedDates.some((date) => date === undefined)) {
            throw new Error("bootstrap date plan is incomplete");
        }
        skills.push(sampledDateSkill(lossesByDate, selectedDates));
    }
    const sorted = skills.sort((left, right) => left - right);
    const lowerSkill = sorted[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
    const upperSkill = sorted[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];
    // retain exact frozen quantile indexes
    if (skills.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES ||
        lowerSkill === undefined || upperSkill === undefined) {
        throw new Error("forecast adjustment bootstrap is incomplete");
    }
    return {
        contractVersion: "moving-block-bootstrap/v1",
        lowerSkill,
        replicates: 2_000,
        upperSkill,
    };
}
// classify paired skill without conflating support, qualification or serving
function comparisonState(metrics, bootstrap) {
    // insufficient support is not a comparison result
    if (metrics === null || bootstrap === null) {
        return "unscored";
    }
    // require interval-wide improvement before calling better
    if (metrics.skill > 0 && bootstrap.lowerSkill > 0) {
        return "better";
    }
    // require interval-wide harm before calling worse
    if (metrics.skill < 0 && bootstrap.upperSkill < 0) {
        return "worse";
    }
    return "mixed";
}
// produce orthogonal honest status fields for one disjoint evidence class
export function evaluateForecastAdjustmentPerformance(pairs, options) {
    // require explicit existing numeric support contracts
    if (!Number.isInteger(options.minimumDates) || options.minimumDates < 7 ||
        !Number.isInteger(options.minimumRows) || options.minimumRows < 1) {
        throw new RangeError("forecast adjustment support contract is invalid");
    }
    const evidenceClasses = new Set(pairs.map((pair) => pair.evidenceClass));
    // reject empty success and mixed evidence before status derivation
    if (pairs.length === 0 || evidenceClasses.size !== 1) {
        throw new RangeError("forecast adjustment evaluation needs one evidence class");
    }
    const evidenceClass = pairs[0].evidenceClass;
    const dateCount = new Set(pairs.map((pair) => pair.localDate)).size;
    const sufficient = dateCount >= options.minimumDates && pairs.length >= options.minimumRows;
    const scored = scoreBalancedForecastAdjustmentPairs(pairs);
    const metrics = sufficient ? scored.metrics : null;
    const bootstrap = sufficient
        ? bootstrapBalancedForecastAdjustmentPairs(pairs)
        : null;
    const comparison = comparisonState(metrics, bootstrap);
    const provenanceComplete = pairs.every((pair) => pair.provenanceComplete);
    let qualificationState;
    // classify development bytes without prospective claims
    if (evidenceClass === "development") {
        qualificationState = "development_only";
        // classify historical forecast rows without issuance claims
    }
    else if (evidenceClass === "retrospective_counterfactual") {
        qualificationState = "counterfactual_only";
        // preserve pending support without relaxing existing thresholds
    }
    else if (!provenanceComplete || !sufficient || comparison === "mixed" || comparison === "unscored") {
        qualificationState = "pending_support";
        // reject demonstrated harm independently from serving state
    }
    else if (comparison === "worse") {
        qualificationState = "rejected";
    }
    else {
        qualificationState = "supported";
    }
    return {
        bootstrap,
        comparisonState: comparison,
        dateCount,
        evidenceClass,
        eventCount: pairs.length,
        metrics,
        qualificationState,
        servingState: options.servingState,
        supportState: sufficient ? "sufficient" : "insufficient",
        weightedRows: scored.weightedRows,
    };
}
// build the existing regional physical-station target without pooling Ecowitt
export function createRegionalPhysicalStationTarget(values) {
    const identities = new Set();
    const spatial = values.flatMap((value) => {
        // reject repeated physical devices before provider/source aliases can pool
        if (identities.has(value.physicalStationKey)) {
            throw new RangeError("physical station target is duplicated");
        }
        identities.add(value.physicalStationKey);
        const station = FORECAST_OBSERVATION_STATIONS.find((candidate) => candidate.key === value.physicalStationKey);
        // reject unknown physical identities
        if (station === undefined) {
            throw new RangeError("physical station target identity is unknown");
        }
        // keep the on-property sensor as a separately labeled diagnostic
        if (station.key === "ballydidean-ecowitt") {
            return [];
        }
        return [{
                nearestRank: station.nearestRank,
                physicalStationKey: station.key,
                unnormalizedSpatialWeight: station.unnormalizedSpatialWeight,
                value: value.value,
            }];
    });
    return scalarNetworkActual(spatial);
}
// extract the nonpooled on-property diagnostic target
export function createEcowittTargetDiagnostic(values) {
    const ecowitt = values.filter((value) => value.physicalStationKey === "ballydidean-ecowitt");
    // reject aliases or duplicate on-property target rows
    if (ecowitt.length > 1) {
        throw new RangeError("Ecowitt target diagnostic is duplicated");
    }
    const value = ecowitt[0]?.value;
    return value !== undefined && Number.isFinite(value) ? value : null;
}
// build the fixed twelve-gauge weighted-median target
export function createFixedRainGaugeTarget(values) {
    const identities = new Set();
    const available = [];
    // validate every row against the frozen gauge catalog
    for (const row of values) {
        // reject unknown or duplicate physical gauges
        if (!RAIN_GAUGE_IDS.has(row.stationId) || identities.has(row.stationId)) {
            throw new RangeError("rain gauge target identity is invalid or duplicated");
        }
        identities.add(row.stationId);
        // retain explicit gaps without imputing dry values
        if (row.precipitationMm !== null) {
            // reject malformed physical amounts
            if (!Number.isFinite(row.precipitationMm) || row.precipitationMm < 0) {
                throw new RangeError("rain gauge target amount is invalid");
            }
            available.push({ id: row.stationId, value: row.precipitationMm });
        }
    }
    const complete = available.length >= 3 &&
        available.some((row) => RAIN_NEAREST_GAUGE_IDS.has(row.id));
    // preserve the incomplete target rather than substituting another source
    if (!complete) {
        return { complete: false, precipitationMm: null, stationCount: available.length };
    }
    const weighted = available.map((row) => {
        const station = RAIN_COLLECTION_STATIONS.find((candidate) => candidate.locationId === row.id);
        // retain the frozen catalog's coordinates
        if (station === undefined) {
            throw new Error("rain gauge coordinate is unavailable");
        }
        const latitude = station.latitude * Math.PI / 180;
        const longitude = station.longitude * Math.PI / 180;
        const siteLatitude = RAIN_COLLECTION_POLICY.latitude * Math.PI / 180;
        const siteLongitude = RAIN_COLLECTION_POLICY.longitude * Math.PI / 180;
        const a = Math.sin((latitude - siteLatitude) / 2) ** 2 +
            Math.cos(latitude) * Math.cos(siteLatitude) *
                Math.sin((longitude - siteLongitude) / 2) ** 2;
        const distance = 6_371_000 * 2 * Math.asin(Math.sqrt(a));
        return { ...row, weight: 1 / (1 + (distance / 2_000) ** 2) };
    });
    const ordered = weighted.sort((left, right) => left.value - right.value || left.id - right.id);
    const totalWeight = ordered.reduce((sum, row) => sum + row.weight, 0);
    let cumulativeWeight = 0;
    let precipitationMm = null;
    // choose the lower value at the first half-mass boundary
    for (const row of ordered) {
        cumulativeWeight += row.weight;
        // retain the served left-continuous weighted median
        if (cumulativeWeight >= totalWeight / 2) {
            precipitationMm = row.value;
            break;
        }
    }
    // retain the compiler-proven nonempty supported gauge set
    if (precipitationMm === null) {
        throw new Error("rain gauge weighted median is empty");
    }
    return { complete: true, precipitationMm, stationCount: available.length };
}
// tile one exact backward hour for every supplied gauge
export function tileBackwardRainGaugeHour(intervals, validAt) {
    const target = instant(validAt, "validAt");
    const byStation = new Map();
    // require one exact forecast target hour
    if (target % 3_600_000 !== 0) {
        throw new RangeError("rain gauge target must be an exact UTC hour");
    }
    // validate and partition retained physical intervals
    for (const interval of intervals) {
        // reject unknown gauges and malformed interval amounts
        if (!RAIN_GAUGE_IDS.has(interval.stationId) ||
            !Number.isFinite(interval.precipitationMm) ||
            interval.precipitationMm < 0 ||
            !Number.isInteger(interval.reportIntervalMinutes) ||
            interval.reportIntervalMinutes < 1 ||
            interval.reportIntervalMinutes > 5) {
            throw new RangeError("rain gauge interval is invalid");
        }
        const reportedAt = instant(interval.reportedAt, "reportedAt");
        // preserve exact provider minute endpoints
        if (reportedAt % 60_000 !== 0) {
            throw new RangeError("rain gauge interval endpoint must be an exact minute");
        }
        const stationRows = byStation.get(interval.stationId) ?? [];
        stationRows.push(interval);
        byStation.set(interval.stationId, stationRows);
    }
    const values = [];
    // retain one explicit complete-or-missing value per supplied station
    for (const [stationId, stationRows] of byStation) {
        const byEnd = new Map();
        // bind every station endpoint to one physical interval
        for (const interval of stationRows) {
            const end = instant(interval.reportedAt, "reportedAt");
            // reject inconsistent duplicate interval endpoints
            if (byEnd.has(end)) {
                throw new RangeError("rain gauge interval endpoint is duplicated");
            }
            byEnd.set(end, interval);
        }
        const eligibleEnds = [...byEnd.keys()].filter((end) => end <= target && target - end <= 5 * 60_000);
        const end = eligibleEnds.sort((left, right) => right - left)[0];
        // preserve missing endpoint support without filling dry values
        if (end === undefined) {
            values.push({ precipitationMm: null, stationId });
            continue;
        }
        const start = end - 60 * 60_000;
        let wanted = end;
        let amount = 0;
        let complete = true;
        // walk exact nonoverlapping intervals backward from the retained endpoint
        while (wanted > start) {
            const interval = byEnd.get(wanted);
            // reject gaps and interval overhangs without prorating
            if (interval === undefined ||
                wanted - interval.reportIntervalMinutes * 60_000 < start) {
                complete = false;
                break;
            }
            amount += interval.precipitationMm;
            wanted -= interval.reportIntervalMinutes * 60_000;
        }
        values.push({ precipitationMm: complete ? amount : null, stationId });
    }
    return values.sort((left, right) => left.stationId - right.stationId);
}
// apply the raw issued target-hour liquid-phase gate
export function createEligibleFixedRainGaugeHourlyTarget(input) {
    const target = createFixedRainGaugeTarget(tileBackwardRainGaugeHour(input.intervals, input.validAt));
    // keep incomplete fixed-gauge tiling pending before phase eligibility
    if (!target.complete) {
        return { ...target, eligible: false, reason: "unsupported_target" };
    }
    const eligible = input.rawTargetHourTemperatureC !== null &&
        Number.isFinite(input.rawTargetHourTemperatureC) &&
        input.rawTargetHourTemperatureC > 2;
    return {
        ...target,
        eligible,
        reason: eligible ? "eligible" : "cold_or_unknown_forecast_phase",
    };
}
// compute one weighted conditional MAE without inventing empty support
function conditionalMae(rows, prediction, minimumTarget) {
    const selected = rows.filter((row) => (row.target ?? Number.NaN) >= minimumTarget);
    const totalWeight = selected.reduce((sum, row) => sum + row.weight, 0);
    // preserve unsupported conditional metrics as null
    if (selected.length === 0 || totalWeight === 0) {
        return null;
    }
    return selected.reduce((sum, row) => sum + row.weight / totalWeight * Math.abs(row[prediction] - row.target), 0);
}
// compute one weighted volume ratio without a zero-observation division
function volumeRatio(rows, prediction) {
    const observed = rows.reduce((sum, row) => sum + row.weight * row.target, 0);
    // retain dry populations as unavailable ratios
    if (observed === 0) {
        return null;
    }
    return rows.reduce((sum, row) => sum + row.weight * row[prediction], 0) /
        observed;
}
// calculate fixed decile calibration without dropping empty bins
function reliabilityBins(rows, threshold) {
    return Array.from({ length: 10 }, (_unused, index) => {
        const selected = rows.filter((row) => row.probability >= index / 10 &&
            (index === 9 ? row.probability <= 1 : row.probability < (index + 1) / 10));
        const weight = selected.reduce((sum, row) => sum + row.weight, 0);
        // preserve empty bins explicitly
        if (selected.length === 0 || weight === 0) {
            return { count: 0, meanProbability: null, observedFrequency: null };
        }
        return {
            count: selected.length,
            meanProbability: selected.reduce((sum, row) => sum + row.weight / weight * row.probability, 0),
            observedFrequency: selected.reduce((sum, row) => sum + row.weight / weight * Number(row.target >= threshold), 0),
        };
    });
}
// score one named binary occurrence head and deterministic event threshold
function rainThresholdSummary(rows, threshold) {
    const probabilityName = threshold === 0.1
        ? "atLeast0_1"
        : threshold === 1 ? "atLeast1_0" : "atLeast2_5";
    const probabilities = rows.map((row) => ({
        ...row,
        probability: row.probability[probabilityName],
    }));
    let adjustedBrier = 0;
    let hits = 0;
    let misses = 0;
    let falseAlarms = 0;
    // keep probability and deterministic amount diagnostics distinct
    for (const row of probabilities) {
        const observed = Number(row.target >= threshold);
        adjustedBrier += row.weight * (row.probability - observed) ** 2;
        hits += Number(observed === 1 && row.adjustedPrediction >= threshold);
        misses += Number(observed === 1 && row.adjustedPrediction < threshold);
        falseAlarms += Number(observed === 0 && row.adjustedPrediction >= threshold);
    }
    return {
        adjustedBrier,
        csi: hits + misses + falseAlarms === 0
            ? null : hits / (hits + misses + falseAlarms),
        falseAlarms,
        far: hits + falseAlarms === 0 ? null : falseAlarms / (hits + falseAlarms),
        hits,
        misses,
        pod: hits + misses === 0 ? null : hits / (hits + misses),
        rawBrier: null,
        reliability: reliabilityBins(probabilities, threshold),
        thresholdMmPerHour: threshold,
    };
}
// score complete consecutive same-run accumulation windows
function rainAccumulationSummary(rows, runKeys, hours) {
    const byRun = new Map();
    // partition adjusted hours without crossing model initializations
    for (const row of rows) {
        const runKey = runKeys.get(row.key);
        // retain compiler-proven rain run identity
        if (runKey === undefined) {
            throw new Error("rain performance row lost its run identity");
        }
        const runRows = byRun.get(runKey) ?? [];
        runRows.push(row);
        byRun.set(runKey, runRows);
    }
    const rawErrors = [];
    const adjustedErrors = [];
    // scan each run for complete exact-hour windows
    for (const runRows of byRun.values()) {
        const sorted = [...runRows].sort((left, right) => left.validAt.localeCompare(right.validAt));
        // retain every complete sliding accumulation window
        for (let start = 0; start + hours <= sorted.length; start += 1) {
            const window = sorted.slice(start, start + hours);
            const first = instant(window[0].validAt, "validAt");
            const complete = window.every((row, index) => instant(row.validAt, "validAt") === first + index * 3_600_000);
            // exclude incomplete or cross-gap accumulation tiling
            if (!complete) {
                continue;
            }
            const target = window.reduce((sum, row) => sum + row.target, 0);
            const raw = window.reduce((sum, row) => sum + row.rawPrediction, 0);
            const adjusted = window.reduce((sum, row) => sum + row.adjustedPrediction, 0);
            rawErrors.push(Math.abs(raw - target));
            adjustedErrors.push(Math.abs(adjusted - target));
        }
    }
    return {
        adjustedMae: adjustedErrors.length === 0
            ? null
            : adjustedErrors.reduce((sum, value) => sum + value, 0) /
                adjustedErrors.length,
        completeWindows: adjustedErrors.length,
        hours,
        rawMae: rawErrors.length === 0
            ? null
            : rawErrors.reduce((sum, value) => sum + value, 0) / rawErrors.length,
    };
}
// score only parity-proven fixed-gauge rain rows
export function evaluateForecastAdjustmentRainDiagnostics(pairs) {
    // stop probability claims unless every amount/applied/reason replay matched
    if (pairs.some((pair) => !pair.amountParity)) {
        throw new RangeError("rain probability diagnostics require amount parity");
    }
    // report incomplete fixed-gauge tiling instead of imputing target rows
    const complete = pairs.filter((pair) => pair.targetTilingComplete);
    const prepared = prepareForecastAdjustmentPerformancePairs(complete);
    const weighted = balanceForecastAdjustmentPerformancePairs(prepared.rows);
    const probabilityByKey = new Map(complete.map((pair) => [pair.key, pair.adjustedProbability]));
    const runKeys = new Map(complete.map((pair) => [pair.key, pair.runKey]));
    const rainRows = weighted.map((row) => {
        const probability = probabilityByKey.get(row.key);
        // require exactly the three named binary probabilities
        if (probability === undefined ||
            Object.values(probability).some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
            throw new RangeError("rain occurrence probability is invalid");
        }
        return { ...row, probability };
    });
    const winter = rainRows.filter((row) => localCalendarFeaturesFor(row.validAt).season === "winter");
    return {
        accumulations: [6, 12, 23].map((hours) => rainAccumulationSummary(rainRows, runKeys, hours)),
        annualBalancedVolumeRatio: volumeRatio(rainRows, "adjustedPrediction"),
        heavyAdjustedMae: conditionalMae(rainRows, "adjustedPrediction", 2.5),
        heavyRawMae: conditionalMae(rainRows, "rawPrediction", 2.5),
        probabilityOrderViolationCount: rainRows.filter((row) => row.probability.atLeast0_1 < row.probability.atLeast1_0 ||
            row.probability.atLeast1_0 < row.probability.atLeast2_5).length,
        thresholds: RAIN_THRESHOLDS.map((threshold) => rainThresholdSummary(rainRows, threshold)),
        wetAdjustedMae: conditionalMae(rainRows, "adjustedPrediction", 0.1),
        wetRawMae: conditionalMae(rainRows, "rawPrediction", 0.1),
        winterBalancedVolumeRatio: winter.length === 0
            ? null : volumeRatio(balanceForecastAdjustmentPerformancePairs(winter), "adjustedPrediction"),
    };
}
