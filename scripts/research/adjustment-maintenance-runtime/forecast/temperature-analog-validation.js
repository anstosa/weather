import { localCalendarFeaturesFor, } from "./calendar.js";
// freeze expanded retrospective validation choices
export const TEMPERATURE_ANALOG_VALIDATION_POLICY = Object.freeze({
    bootstrap: Object.freeze({
        blockLengths: Object.freeze([1, 2, 3]),
        confidenceIntervalPercentiles: Object.freeze([0.025, 0.975]),
        dateAggregate: "sum_of_within_hour_event_mean_losses_and_valid_hour_counts",
        dateDraw: "ceil_n_over_l_circular_blocks_concatenated_and_truncated_to_n",
        generatorReset: "independent_for_each_block_length",
        intervalInterpolation: "linear_sorted_rank_p_times_n_minus_1",
        primaryScope: "first12",
        randomGenerator: "xorshift32_13_17_5_unsigned_divide_2_to_32",
        replicateCount: 20_000,
        seedBase: 20_260_907,
    }),
    contractVersion: "temperature-analog-expanded-validation/v1",
    firstTwelveHourDiagnostics: Object.freeze({
        dayparts: Object.freeze([
            "night",
            "morning",
            "afternoon",
            "evening",
        ]),
        exactLeadHours: Object.freeze([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
        ]),
        seasons: Object.freeze([
            "winter",
            "spring",
            "summer",
            "autumn",
        ]),
    }),
    qualificationAllowed: false,
    scopes: Object.freeze([
        Object.freeze({ key: "first6", maximumLeadHours: 6, minimumLeadHours: 1 }),
        Object.freeze({ key: "hours7To12", maximumLeadHours: 12, minimumLeadHours: 7 }),
        Object.freeze({ key: "first12", maximumLeadHours: 12, minimumLeadHours: 1 }),
        Object.freeze({ key: "hours13To48", maximumLeadHours: 48, minimumLeadHours: 13 }),
        Object.freeze({ key: "first48", maximumLeadHours: 48, minimumLeadHours: 1 }),
        Object.freeze({ key: "after48", maximumLeadHours: 168, minimumLeadHours: 49 }),
        Object.freeze({ key: "overall", maximumLeadHours: 168, minimumLeadHours: 1 }),
    ]),
});
const MILLISECONDS_PER_HOUR = 3_600_000;
const TWO_TO_THE_THIRTY_SECOND_POWER = 4_294_967_296;
// require one canonical millisecond UTC instant
function canonicalInstantMilliseconds(value, field) {
    const milliseconds = Date.parse(value);
    // reject malformed or normalized timestamps
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
        throw new RangeError(`${field} must be a canonical UTC instant`);
    }
    return milliseconds;
}
// require one finite scoring number
function requireFinite(value, field) {
    // reject non-finite evidence
    if (!Number.isFinite(value)) {
        throw new RangeError(`${field} must be finite`);
    }
    return value;
}
// prepare one prediction record without source inspection
function prepareRecord(record) {
    requireFinite(record.actual, "actual");
    requireFinite(record.analogPrediction, "analogPrediction");
    requireFinite(record.priorPrediction, "priorPrediction");
    requireFinite(record.rawForecast, "rawForecast");
    // require a stable nonempty identity
    if (typeof record.key !== "string" || record.key.trim().length === 0) {
        throw new RangeError("key must be nonempty");
    }
    // require a literal eligibility partition
    if (typeof record.baselineEligible !== "boolean") {
        throw new RangeError("baselineEligible must be boolean");
    }
    // require a structural fallback label
    if (record.fallbackReason !== null && typeof record.fallbackReason !== "string") {
        throw new RangeError("fallbackReason must be a string or null");
    }
    // require the complete forecast horizon
    if (!Number.isInteger(record.targetLeadHours) ||
        record.targetLeadHours < 1 ||
        record.targetLeadHours > 168) {
        throw new RangeError("targetLeadHours must be an integer between 1 and 168");
    }
    const validAtMilliseconds = canonicalInstantMilliseconds(record.validAt, "validAt");
    const referenceAtMilliseconds = canonicalInstantMilliseconds(record.referenceAt, "referenceAt");
    // require a positive stated forecast horizon
    if (referenceAtMilliseconds >= validAtMilliseconds) {
        throw new RangeError("referenceAt must precede validAt");
    }
    const elapsedLeadHours = Math.ceil((validAtMilliseconds - referenceAtMilliseconds) / MILLISECONDS_PER_HOUR);
    // bind the lead label to both instants
    if (elapsedLeadHours !== record.targetLeadHours) {
        throw new RangeError("targetLeadHours must match validAt and referenceAt");
    }
    // preserve the accepted later-range prediction exactly
    if (record.targetLeadHours > 12 && record.analogPrediction !== record.priorPrediction) {
        throw new RangeError("analogPrediction must equal priorPrediction after 12 hours");
    }
    const calendar = localCalendarFeaturesFor(record.validAt);
    return {
        ...record,
        daypart: calendar.daypart,
        localDate: calendar.localDate,
        season: calendar.season,
    };
}
// validate shared identities and observed targets
function prepareRecords(records) {
    const actualByValidAt = new Map();
    const keys = new Set();
    const prepared = [];
    // retain and validate every supplied row
    for (const record of records) {
        const candidate = prepareRecord(record);
        // reject duplicate event identities
        if (keys.has(candidate.key)) {
            throw new RangeError("temperature analog validation keys must be unique");
        }
        const sharedActual = actualByValidAt.get(candidate.validAt);
        // reject conflicting labels within one target hour
        if (sharedActual !== undefined && sharedActual !== candidate.actual) {
            throw new RangeError("actual must be identical within each validAt");
        }
        keys.add(candidate.key);
        actualByValidAt.set(candidate.validAt, candidate.actual);
        prepared.push(candidate);
    }
    return prepared;
}
// create one empty hourly accumulator
function createHourAccumulator() {
    return {
        analogAbsoluteErrorSum: 0,
        analogAbove2Count: 0,
        analogAbove3Count: 0,
        analogErrorSum: 0,
        analogSquaredErrorSum: 0,
        count: 0,
        priorAbsoluteErrorSum: 0,
        priorAbove2Count: 0,
        priorAbove3Count: 0,
        priorErrorSum: 0,
        priorSquaredErrorSum: 0,
        rawAbsoluteErrorSum: 0,
        rawAbove2Count: 0,
        rawAbove3Count: 0,
        rawErrorSum: 0,
        rawSquaredErrorSum: 0,
    };
}
// add one model error to its hour fields
function addModelError(hour, model, error) {
    const absoluteError = Math.abs(error);
    hour[`${model}AbsoluteErrorSum`] += absoluteError;
    hour[`${model}ErrorSum`] += error;
    hour[`${model}SquaredErrorSum`] += error * error;
    // count strict two-degree misses
    if (absoluteError > 2) {
        hour[`${model}Above2Count`] += 1;
    }
    // count strict three-degree misses
    if (absoluteError > 3) {
        hour[`${model}Above3Count`] += 1;
    }
}
// interpolate one sorted percentile
function percentile(sortedValues, probability) {
    // return an explicit empty-cell value
    if (sortedValues.length === 0) {
        return null;
    }
    const rank = probability * (sortedValues.length - 1);
    const lowerIndex = Math.floor(rank);
    const upperIndex = Math.ceil(rank);
    const lower = sortedValues[lowerIndex];
    const upper = sortedValues[upperIndex];
    // guard internal percentile indexes
    if (lower === undefined || upper === undefined) {
        throw new Error("temperature analog percentile index is unavailable");
    }
    return lower + (upper - lower) * (rank - lowerIndex);
}
// score one model with equal UTC-hour primary weighting
function scoreModel(hours, localDateCount, eventCount, model) {
    // return explicit null metrics for empty cells
    if (eventCount === 0 || hours.size === 0) {
        return {
            eventCount: 0,
            eventWeightedMeanAbsoluteError: null,
            hourBalancedFractionAbsoluteErrorAbove2C: null,
            hourBalancedFractionAbsoluteErrorAbove3C: null,
            hourBalancedMeanAbsoluteError: null,
            hourBalancedRootMeanSquaredError: null,
            hourBalancedSignedBias: null,
            hourlyMeanAbsoluteErrorPercentiles: {
                maximum: null,
                p50: null,
                p90: null,
                p95: null,
                p99: null,
            },
            localDateCount: 0,
            uniqueValidHours: 0,
        };
    }
    const hourlyMeanAbsoluteErrors = [];
    let eventAbsoluteErrorSum = 0;
    let hourAbsoluteErrorMeanSum = 0;
    let hourAbove2FractionSum = 0;
    let hourAbove3FractionSum = 0;
    let hourErrorMeanSum = 0;
    let hourSquaredErrorMeanSum = 0;
    // balance each valid hour equally
    for (const hour of hours.values()) {
        const absoluteErrorSum = hour[`${model}AbsoluteErrorSum`];
        const meanAbsoluteError = absoluteErrorSum / hour.count;
        eventAbsoluteErrorSum += absoluteErrorSum;
        hourAbsoluteErrorMeanSum += meanAbsoluteError;
        hourErrorMeanSum += hour[`${model}ErrorSum`] / hour.count;
        hourSquaredErrorMeanSum += hour[`${model}SquaredErrorSum`] / hour.count;
        hourAbove2FractionSum += hour[`${model}Above2Count`] / hour.count;
        hourAbove3FractionSum += hour[`${model}Above3Count`] / hour.count;
        hourlyMeanAbsoluteErrors.push(meanAbsoluteError);
    }
    hourlyMeanAbsoluteErrors.sort((left, right) => left - right);
    const uniqueValidHours = hours.size;
    return {
        eventCount,
        eventWeightedMeanAbsoluteError: eventAbsoluteErrorSum / eventCount,
        hourBalancedFractionAbsoluteErrorAbove2C: hourAbove2FractionSum / uniqueValidHours,
        hourBalancedFractionAbsoluteErrorAbove3C: hourAbove3FractionSum / uniqueValidHours,
        hourBalancedMeanAbsoluteError: hourAbsoluteErrorMeanSum / uniqueValidHours,
        hourBalancedRootMeanSquaredError: Math.sqrt(hourSquaredErrorMeanSum / uniqueValidHours),
        hourBalancedSignedBias: hourErrorMeanSum / uniqueValidHours,
        hourlyMeanAbsoluteErrorPercentiles: {
            maximum: hourlyMeanAbsoluteErrors.at(-1) ?? null,
            p50: percentile(hourlyMeanAbsoluteErrors, 0.5),
            p90: percentile(hourlyMeanAbsoluteErrors, 0.9),
            p95: percentile(hourlyMeanAbsoluteErrors, 0.95),
            p99: percentile(hourlyMeanAbsoluteErrors, 0.99),
        },
        localDateCount,
        uniqueValidHours,
    };
}
// score all predictions on one exact shared subset
function scoreComparison(records) {
    const hours = new Map();
    const localDates = new Set();
    // retain every event regardless of fallback or eligibility
    for (const record of records) {
        let hour = hours.get(record.validAt);
        // initialize one UTC valid-hour group
        if (hour === undefined) {
            hour = createHourAccumulator();
            hours.set(record.validAt, hour);
        }
        addModelError(hour, "raw", record.rawForecast - record.actual);
        addModelError(hour, "prior", record.priorPrediction - record.actual);
        addModelError(hour, "analog", record.analogPrediction - record.actual);
        hour.count += 1;
        localDates.add(record.localDate);
    }
    return {
        analog: scoreModel(hours, localDates.size, records.length, "analog"),
        prior: scoreModel(hours, localDates.size, records.length, "prior"),
        raw: scoreModel(hours, localDates.size, records.length, "raw"),
    };
}
// compute one absolute MAE improvement
function absoluteImprovement(comparison, comparator) {
    const comparatorLoss = comparison[comparator].hourBalancedMeanAbsoluteError;
    const analogLoss = comparison.analog.hourBalancedMeanAbsoluteError;
    // keep empty comparisons explicit
    if (comparatorLoss === null || analogLoss === null) {
        return null;
    }
    return comparatorLoss - analogLoss;
}
// create one fixed scope report
function scopeReport(records, scope) {
    const selected = records.filter(
    // retain the inclusive frozen lead range
    (record) => record.targetLeadHours >= scope.minimumLeadHours &&
        record.targetLeadHours <= scope.maximumLeadHours);
    return {
        comparison: scoreComparison(selected),
        key: scope.key,
        maximumLeadHours: scope.maximumLeadHours,
        minimumLeadHours: scope.minimumLeadHours,
    };
}
// advance one frozen xorshift32 state
function nextXorshift32(state) {
    let next = state >>> 0;
    next ^= next << 13;
    next ^= next >>> 17;
    next ^= next << 5;
    return next >>> 0;
}
// build equal-hour date aggregates for paired resampling
function bootstrapDateAggregates(records, localDates) {
    return localDates.map(
    // aggregate one represented local date
    (localDate) => {
        const dateRecords = records.filter(
        // isolate one local date
        (record) => record.localDate === localDate);
        const hours = new Map();
        // accumulate one date without retaining event output
        for (const record of dateRecords) {
            let hour = hours.get(record.validAt);
            // initialize one date-local valid hour
            if (hour === undefined) {
                hour = createHourAccumulator();
                hours.set(record.validAt, hour);
            }
            addModelError(hour, "raw", record.rawForecast - record.actual);
            addModelError(hour, "prior", record.priorPrediction - record.actual);
            addModelError(hour, "analog", record.analogPrediction - record.actual);
            hour.count += 1;
        }
        let analogHourLossSum = 0;
        let priorHourLossSum = 0;
        let rawHourLossSum = 0;
        // preserve partial-date hour weights
        for (const hour of hours.values()) {
            analogHourLossSum += hour.analogAbsoluteErrorSum / hour.count;
            priorHourLossSum += hour.priorAbsoluteErrorSum / hour.count;
            rawHourLossSum += hour.rawAbsoluteErrorSum / hour.count;
        }
        return {
            analogHourLossSum,
            priorHourLossSum,
            rawHourLossSum,
            uniqueValidHours: hours.size,
        };
    });
}
// form one linear-interpolated confidence interval
function confidenceInterval(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const lower = percentile(sorted, 0.025);
    const upper = percentile(sorted, 0.975);
    // guard a required nonempty bootstrap distribution
    if (lower === null || upper === null) {
        throw new Error("temperature analog bootstrap samples are empty");
    }
    return { lower, upper };
}
// compute a defined relative improvement percentage
function relativeImprovementPercent(absoluteMeanAbsoluteErrorC, comparatorMeanAbsoluteErrorC) {
    // avoid an undefined perfect-comparator ratio
    if (comparatorMeanAbsoluteErrorC === 0) {
        return null;
    }
    return (absoluteMeanAbsoluteErrorC / comparatorMeanAbsoluteErrorC) * 100;
}
// run one frozen paired circular date bootstrap
function bootstrapForBlockLength(records, localDates, blockLength) {
    const seed = TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.seedBase + blockLength;
    const pointComparison = scoreComparison(records);
    const rawPoint = absoluteImprovement(pointComparison, "raw");
    const priorPoint = absoluteImprovement(pointComparison, "prior");
    const rawPointRelative = rawPoint === null
        ? null
        : relativeImprovementPercent(rawPoint, pointComparison.raw.hourBalancedMeanAbsoluteError ?? 0);
    const priorPointRelative = priorPoint === null
        ? null
        : relativeImprovementPercent(priorPoint, pointComparison.prior.hourBalancedMeanAbsoluteError ?? 0);
    // report null intervals without enough date blocks
    if (localDates.length < 2) {
        return {
            blockLengthLocalDates: blockLength,
            completedReplicateCount: 0,
            configuredReplicateCount: TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount,
            priorMinusAnalog: {
                absoluteMeanAbsoluteErrorC: {
                    confidenceInterval95: null,
                    point: priorPoint,
                },
                relativePercent: {
                    confidenceInterval95: null,
                    point: priorPointRelative,
                },
            },
            rawMinusAnalog: {
                absoluteMeanAbsoluteErrorC: {
                    confidenceInterval95: null,
                    point: rawPoint,
                },
                relativePercent: {
                    confidenceInterval95: null,
                    point: rawPointRelative,
                },
            },
            representedLocalDateCount: localDates.length,
            seed,
        };
    }
    const dates = bootstrapDateAggregates(records, localDates);
    const samples = {
        priorAbsolute: [],
        priorRelative: [],
        priorRelativeComplete: true,
        rawAbsolute: [],
        rawRelative: [],
        rawRelativeComplete: true,
    };
    let randomState = seed >>> 0;
    // produce the frozen number of paired replicates
    for (let replicate = 0; replicate < TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount; replicate += 1) {
        let analogLossSum = 0;
        let priorLossSum = 0;
        let rawLossSum = 0;
        let selectedDateCount = 0;
        let validHourCount = 0;
        // draw circular blocks until exactly N date slots are retained
        while (selectedDateCount < dates.length) {
            randomState = nextXorshift32(randomState);
            const startIndex = Math.floor((randomState / TWO_TO_THE_THIRTY_SECOND_POWER) * dates.length);
            // append one wrapped moving block
            for (let offset = 0; offset < blockLength && selectedDateCount < dates.length; offset += 1) {
                const selected = dates[(startIndex + offset) % dates.length];
                // guard the circular date lookup
                if (selected === undefined) {
                    throw new Error("temperature analog bootstrap date is unavailable");
                }
                analogLossSum += selected.analogHourLossSum;
                priorLossSum += selected.priorHourLossSum;
                rawLossSum += selected.rawHourLossSum;
                validHourCount += selected.uniqueValidHours;
                selectedDateCount += 1;
            }
        }
        // guard impossible empty sampled dates
        if (validHourCount === 0) {
            throw new Error("temperature analog bootstrap replicate has no valid hours");
        }
        const analogLoss = analogLossSum / validHourCount;
        const priorLoss = priorLossSum / validHourCount;
        const rawLoss = rawLossSum / validHourCount;
        const priorAbsolute = priorLoss - analogLoss;
        const rawAbsolute = rawLoss - analogLoss;
        const priorRelative = relativeImprovementPercent(priorAbsolute, priorLoss);
        const rawRelative = relativeImprovementPercent(rawAbsolute, rawLoss);
        samples.priorAbsolute.push(priorAbsolute);
        samples.rawAbsolute.push(rawAbsolute);
        // retain a complete prior-relative distribution
        if (priorRelative === null) {
            samples.priorRelativeComplete = false;
        }
        else {
            samples.priorRelative.push(priorRelative);
        }
        // retain a complete raw-relative distribution
        if (rawRelative === null) {
            samples.rawRelativeComplete = false;
        }
        else {
            samples.rawRelative.push(rawRelative);
        }
    }
    return {
        blockLengthLocalDates: blockLength,
        completedReplicateCount: TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount,
        configuredReplicateCount: TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.replicateCount,
        priorMinusAnalog: {
            absoluteMeanAbsoluteErrorC: {
                confidenceInterval95: confidenceInterval(samples.priorAbsolute),
                point: priorPoint,
            },
            relativePercent: {
                confidenceInterval95: samples.priorRelativeComplete
                    ? confidenceInterval(samples.priorRelative)
                    : null,
                point: priorPointRelative,
            },
        },
        rawMinusAnalog: {
            absoluteMeanAbsoluteErrorC: {
                confidenceInterval95: confidenceInterval(samples.rawAbsolute),
                point: rawPoint,
            },
            relativePercent: {
                confidenceInterval95: samples.rawRelativeComplete
                    ? confidenceInterval(samples.rawRelative)
                    : null,
                point: rawPointRelative,
            },
        },
        representedLocalDateCount: localDates.length,
        seed,
    };
}
// classify per-date analog outcomes against one comparator
function dateOutcome(diagnostics, comparator) {
    let tieCount = 0;
    let winCount = 0;
    let worseCount = 0;
    // classify every represented date without exclusion
    for (const diagnostic of diagnostics) {
        const improvement = comparator === "raw"
            ? diagnostic.rawMinusAnalogMeanAbsoluteErrorC
            : diagnostic.priorMinusAnalogMeanAbsoluteErrorC;
        // guard impossible empty represented dates
        if (improvement === null) {
            throw new Error("temperature analog represented date has no score");
        }
        // count exact ties
        if (improvement === 0) {
            tieCount += 1;
        }
        else if (improvement > 0) {
            // count analog wins
            winCount += 1;
        }
        else {
            // count analog losses
            worseCount += 1;
        }
    }
    return { tieCount, winCount, worseCount };
}
// summarize finite omission improvements
function improvementRange(values) {
    const finite = values.filter(
    // remove only explicit empty scores
    (value) => value !== null);
    // preserve an explicit empty range
    if (finite.length === 0) {
        return { maximum: null, minimum: null };
    }
    return {
        maximum: Math.max(...finite),
        minimum: Math.min(...finite),
    };
}
// score one chronological date partition
function chronologicalPartition(records, localDates) {
    const dateSet = new Set(localDates);
    const selected = records.filter(
    // retain exactly the partition dates
    (record) => dateSet.has(record.localDate));
    return {
        comparison: scoreComparison(selected),
        endLocalDate: localDates.at(-1) ?? null,
        localDateCount: localDates.length,
        startLocalDate: localDates[0] ?? null,
    };
}
// score one validated subset without bootstrap work
export function scoreTemperatureAnalogValidationRecords(records) {
    return scoreComparison(prepareRecords(records));
}
// analyze frozen analog predictions without refitting or source access
export function analyzeTemperatureAnalogValidation(records) {
    const prepared = prepareRecords(records);
    const first12 = prepared.filter(
    // isolate the primary short-range cohort
    (record) => record.targetLeadHours <= 12);
    const localDates = [...new Set(first12.map(
        // project represented local dates
        (record) => record.localDate))].sort();
    const byLocalDate = localDates.map(
    // score each date independently
    (localDate) => {
        const comparison = scoreComparison(first12.filter(
        // isolate one represented date
        (record) => record.localDate === localDate));
        return {
            comparison,
            localDate,
            priorMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(comparison, "prior"),
            rawMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(comparison, "raw"),
        };
    });
    const leaveOneRows = localDates.map(
    // omit one date from frozen predictions only
    (omittedLocalDate) => {
        const comparison = scoreComparison(first12.filter(
        // retain every other represented date
        (record) => record.localDate !== omittedLocalDate));
        return {
            comparison,
            omittedLocalDate,
            priorMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(comparison, "prior"),
            rawMinusAnalogMeanAbsoluteErrorC: absoluteImprovement(comparison, "raw"),
        };
    });
    const splitIndex = Math.ceil(localDates.length / 2);
    return {
        bootstrap: TEMPERATURE_ANALOG_VALIDATION_POLICY.bootstrap.blockLengths.map(
        // reset the generator independently for each length
        (blockLength) => bootstrapForBlockLength(first12, localDates, blockLength)),
        chronologicalSplit: {
            earlier: chronologicalPartition(first12, localDates.slice(0, splitIndex)),
            interpretation: "descriptive_frozen_predictions_not_holdout_validation",
            later: chronologicalPartition(first12, localDates.slice(splitIndex)),
            splitRule: "first_ceil_half_of_sorted_represented_local_dates",
        },
        contractVersion: TEMPERATURE_ANALOG_VALIDATION_POLICY.contractVersion,
        diagnostics: {
            byDaypart: TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.dayparts.map(
            // score one fixed daypart
            (daypart) => ({
                comparison: scoreComparison(first12.filter(
                // retain one daypart
                (record) => record.daypart === daypart)),
                daypart,
            })),
            byExactLeadHour: TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.exactLeadHours.map(
            // score one exact lead
            (targetLeadHours) => ({
                comparison: scoreComparison(first12.filter(
                // retain one exact lead
                (record) => record.targetLeadHours === targetLeadHours)),
                targetLeadHours,
            })),
            byLocalDate,
            bySeason: TEMPERATURE_ANALOG_VALIDATION_POLICY.firstTwelveHourDiagnostics.seasons.map(
            // score one fixed season
            (season) => ({
                comparison: scoreComparison(first12.filter(
                // retain one season
                (record) => record.season === season)),
                season,
            })),
        },
        first12DateOutcomes: {
            versusPrior: dateOutcome(byLocalDate, "prior"),
            versusRaw: dateOutcome(byLocalDate, "raw"),
        },
        leaveOneLocalDateOut: {
            interpretation: "frozen_prediction_omission_not_cross_validation_or_refitting",
            priorMinusAnalogMeanAbsoluteErrorCRange: improvementRange(leaveOneRows.map(
            // project prior omission improvements
            (row) => row.priorMinusAnalogMeanAbsoluteErrorC)),
            rawMinusAnalogMeanAbsoluteErrorCRange: improvementRange(leaveOneRows.map(
            // project raw omission improvements
            (row) => row.rawMinusAnalogMeanAbsoluteErrorC)),
            rows: leaveOneRows,
        },
        limitations: {
            arrivalAndRevisionLatency: "not_perturbed_or_reconstructed",
            cohort: "consumed_12_local_date_retrospective_cohort_not_unseen_dates",
            dependence: "predictions_retain_original_training_and_analog_source_state",
            parameterSelection: "none_all_predeclared_diagnostics_reported",
            refit: "none_frozen_predictions_only",
            representedLocalDateCount: localDates.length,
            validationKind: "frozen_prediction_rescoring_not_cross_validation_or_an_independent_holdout",
        },
        productionActivationAllowed: false,
        qualification: false,
        scopes: TEMPERATURE_ANALOG_VALIDATION_POLICY.scopes.map(
        // score every scope without selection
        (scope) => scopeReport(prepared, scope)),
    };
}
