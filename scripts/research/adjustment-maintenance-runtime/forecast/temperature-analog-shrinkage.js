import { createTemperatureAnalogPredictionAudit, } from "./temperature-analog-research.js";
// freeze one conservative tuning candidate
export const TEMPERATURE_ANALOG_SHRINKAGE_POLICY = Object.freeze({
    contractVersion: "temperature-analog-half-strength/v1",
    fullStrengthIncrementWeight: 0.5,
    interpolation: "after_existing_full_strength_caps_without_additional_clipping",
    maximumTargetLeadHours: 12,
    productionActivationAllowed: false,
    sourcePredictions: "unchanged_prior_boosted_hybrid_without_recursive_feedback",
});
// halve only the supported already-capped analog increment
export function createTemperatureAnalogShrinkageAudit(events) {
    const original = createTemperatureAnalogPredictionAudit(events);
    const records = original.map(
    // preserve the full-strength prediction and its complete source audit
    (record) => {
        const shrinkageWeight = record.fallbackReason === null
            ? TEMPERATURE_ANALOG_SHRINKAGE_POLICY.fullStrengthIncrementWeight
            : 0;
        const fullStrengthIncrementC = record.analogPrediction - record.priorPrediction;
        const retainedIncrementC = shrinkageWeight * fullStrengthIncrementC;
        return Object.freeze({
            ...record,
            fullStrengthIncrementC,
            retainedIncrementC,
            shrinkageWeight,
            shrunkAnalogPrediction: record.priorPrediction + retainedIncrementC,
        });
    });
    return Object.freeze(records);
}
