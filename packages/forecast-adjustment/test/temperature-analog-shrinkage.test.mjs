import assert from "node:assert/strict";
import test from "node:test";

import { createTemperatureAnalogPredictionAudit } from "../dist/temperature-analog-research.js";
import {
  createTemperatureAnalogShrinkageAudit,
  TEMPERATURE_ANALOG_SHRINKAGE_POLICY,
} from "../dist/temperature-analog-shrinkage.js";

const HOUR = 3_600_000;

// create one exact positive-horizon forecast
function event(input = {}) {
  const validAt = input.validAt ?? "2025-04-20T18:00:00.000Z";
  const targetLeadHours = input.targetLeadHours ?? 6;
  return {
    actual: 10,
    baselineEligible: true,
    key: "target",
    priorPrediction: 9,
    rawForecast: 8,
    rawRelativeHumidityPercent: 60,
    rawWindSpeedMps: 3,
    ...input,
    referenceAt: new Date(Date.parse(validAt) - targetLeadHours * HOUR).toISOString(),
    targetLeadHours,
    validAt,
  };
}

// create twelve independent prior valid hours with one fixed residual
function sources(target, residual = 2) {
  return Array.from({ length: 12 },
    // preserve matching weather and lead while moving back whole days
    (_, index) => event({
      actual: 20 + residual,
      key: `source-${index}`,
      priorPrediction: 20,
      rawForecast: target.rawForecast,
      targetLeadHours: target.targetLeadHours,
      validAt: new Date(Date.parse(target.validAt) - (index + 1) * 24 * HOUR).toISOString(),
    }),
  );
}

// find one target without hiding missing records
function targetRecord(records) {
  const result = records.find(
    // select the synthetic target identity
    (record) => record.key === "target",
  );
  assert.ok(result);
  return result;
}

// lock midpoint arithmetic and the original source selection
test("halves the supported analog increment without changing the original audit", () => {
  const target = event();
  const inputs = [...sources(target), target];
  const full = createTemperatureAnalogPredictionAudit(inputs);
  const shrunk = createTemperatureAnalogShrinkageAudit(inputs);
  const result = targetRecord(shrunk);
  assert.equal(result.analogPrediction, 11);
  assert.equal(result.shrunkAnalogPrediction, 10);
  assert.equal(result.shrinkageWeight, 0.5);
  assert.equal(result.fullStrengthIncrementC, 2);
  assert.equal(result.retainedIncrementC, 1);
  // preserve every original field on every target and source event
  for (const [index, record] of shrunk.entries()) {
    const { fullStrengthIncrementC, retainedIncrementC, shrinkageWeight, shrunkAnalogPrediction, ...original } = record;
    assert.deepEqual(original, full[index]);
  }
});

// distinguish interpolation after caps from shrinking the uncapped residual
test("interpolates after cumulative and physical caps without clipping again", () => {
  // retain both kinds of already-applied bounds
  for (const [target, residual, full, shrunk] of [
    [event({ rawForecast: 10, priorPrediction: 14 }), 4, 15, 14.5],
    [event({ rawForecast: 68, priorPrediction: 69 }), 10, 70, 69.5],
    [event({ rawForecast: -98, priorPrediction: -99 }), -10, -100, -99.5],
  ]) {
    const result = targetRecord(createTemperatureAnalogShrinkageAudit([...sources(target, residual), target]));
    assert.equal(result.analogPrediction, full);
    assert.equal(result.shrunkAnalogPrediction, shrunk);
  }
});

// preserve unsupported and ineligible predictions even outside physical bounds
test("retains every original fallback exactly without new clipping", () => {
  // exercise all first-twelve-hour fallback reasons
  for (const target of [
    event({ rawForecast: 100, priorPrediction: 90 }),
    event({ rawForecast: 100, priorPrediction: 90, baselineEligible: false }),
    event({ rawForecast: 100, priorPrediction: 90, rawRelativeHumidityPercent: null }),
    event({ rawForecast: 100, priorPrediction: 90, rawWindSpeedMps: null }),
  ]) {
    const result = targetRecord(createTemperatureAnalogShrinkageAudit([target]));
    assert.equal(result.shrunkAnalogPrediction, 90);
    assert.equal(result.analogPrediction, 90);
    assert.equal(result.shrinkageWeight, 0);
    assert.equal(result.retainedIncrementC, 0);
    assert.notEqual(result.fallbackReason, null);
  }
});

// lock the inclusive twelve-hour tuning boundary
test("changes supported hour twelve but preserves all later forecasts", () => {
  const target = event({ targetLeadHours: 12 });
  const changed = targetRecord(createTemperatureAnalogShrinkageAudit([...sources(target), target]));
  assert.equal(changed.shrunkAnalogPrediction, 10);
  // keep both previously accepted horizon components exact
  for (const targetLeadHours of [13, 24, 48, 49, 168]) {
    const later = event({ priorPrediction: 90, targetLeadHours });
    const result = targetRecord(createTemperatureAnalogShrinkageAudit([later]));
    assert.equal(result.shrunkAnalogPrediction, 90);
    assert.equal(result.shrinkageWeight, 0);
    assert.equal(result.fallbackReason, "outside_first12");
  }
});

// preserve deterministic causality without target-label feedback
test("is deterministic and independent of target and future labels", () => {
  const target = event();
  const inputs = [...sources(target), target];
  const original = createTemperatureAnalogShrinkageAudit(inputs);
  assert.deepEqual(createTemperatureAnalogShrinkageAudit([...inputs].reverse()), original);
  const changed = targetRecord(createTemperatureAnalogShrinkageAudit([
    ...sources(target),
    { ...target, actual: 40 },
    event({ key: "future", actual: -40, validAt: "2025-04-21T18:00:00.000Z" }),
  ]));
  assert.equal(changed.shrunkAnalogPrediction, targetRecord(original).shrunkAnalogPrediction);
  assert.deepEqual(changed.selectedSources, targetRecord(original).selectedSources);
});

// retain immutable output and inherited validation failures
test("deep freezes the audit and rejects malformed inputs", () => {
  const target = event();
  const records = createTemperatureAnalogShrinkageAudit([...sources(target), target]);
  const result = targetRecord(records);
  assert.ok(Object.isFrozen(records));
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.selectedSources));
  assert.ok(Object.isFrozen(result.selectedSources[0].scaledSquaredDifferences));
  assert.ok(Object.isFrozen(TEMPERATURE_ANALOG_SHRINKAGE_POLICY));
  assert.deepEqual(createTemperatureAnalogShrinkageAudit([]), []);
  assert.throws(
    // inherit finite input validation
    () => createTemperatureAnalogShrinkageAudit([event({ actual: NaN })]),
    /finite/,
  );
  assert.throws(
    // inherit duplicate identity rejection
    () => createTemperatureAnalogShrinkageAudit([target, target]),
    /unique/,
  );
});
