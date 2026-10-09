import assert from "node:assert/strict";
import test from "node:test";
import {
  ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT,
  ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
  buildAdjustmentRollingScheduleBootstrap,
  buildAdjustmentRollingWindow,
  extendAdjustmentRollingCaptureHorizon,
} from "./adjustment_rolling_schedule.mjs";
import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";

const EPOCH = "2026-10-09T04:10:45.000Z";
const WITNESS = "a".repeat(64);

// bind every request to one explicit future-only epoch fixture
function windowInput(overrides = {}) {
  return {
    epochAt: EPOCH,
    epochWitnessSha256: WITNESS,
    family: "rain",
    fitMonth: "2027-08",
    predecessorTerminalAt: null,
    requestedAt: "2027-08-02T12:00:00.000Z",
    ...overrides,
  };
}

// preserve complete training, calibration, confirmation and closure spans
test("rolling bootstrap is finite and keeps every existing family gate", () => {
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.rainMinimumTrainingDates, 180);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.rainCalibrationDays, 90);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.rainMinimumCalibrationDates, 60);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.trainingGapDays, 7);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.calibrationGapDays, 7);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.temperatureConfirmationDays, 366);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.windConfirmationDays, 366);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT.rainConfirmationDays, 334);
  assert.equal(ADJUSTMENT_ROLLING_SCHEDULE_SHA256,
    adjustmentSha256(canonicalJsonBytes(ADJUSTMENT_ROLLING_SCHEDULE_CONTRACT)));
  const bootstrap = buildAdjustmentRollingScheduleBootstrap({ epochAt: EPOCH, epochWitnessSha256: WITNESS });
  assert.equal(bootstrap.firstCompleteLocalDate, "2026-10-09");
  assert.equal(bootstrap.horizonEndAt, "2029-08-27T07:00:00.000Z");
  const { bootstrapSha256, ...unsigned } = bootstrap;
  assert.equal(bootstrapSha256, adjustmentSha256(canonicalJsonBytes(unsigned)));
  assert.throws(() => buildAdjustmentRollingScheduleBootstrap({
    epochAt: EPOCH, epochWitnessSha256: WITNESS, horizonEndAt: "2099-01-01T00:00:00.000Z",
  }), /fields/u);
});

// use the fitter's actual utc month masks and a later preregistered local interval
test("rain rolling window preserves ninety-day calibration and both embargoes", () => {
  const plan = buildAdjustmentRollingWindow(windowInput());
  assert.equal(plan.sourceFloorAt, "2026-10-09T07:00:00.000Z");
  assert.equal(plan.trainingEndAt, "2027-04-19T00:00:00.000Z");
  assert.equal(plan.calibrationStartAt, "2027-04-26T00:00:00.000Z");
  assert.equal(plan.calibrationEndAt, "2027-07-25T00:00:00.000Z");
  assert.equal(plan.intervalStartAt, "2027-09-01T07:00:00.000Z");
  assert.equal(plan.intervalEndAt, "2028-07-31T07:00:00.000Z");
  assert.equal(plan.terminalAt, "2028-08-07T07:00:00.000Z");
  assert.equal((Date.parse(plan.calibrationEndAt) - Date.parse(plan.calibrationStartAt)) / 86_400_000, 90);
  assert.equal((Date.parse(plan.calibrationStartAt) - Date.parse(plan.trainingEndAt)) / 86_400_000, 7);
  assert.ok(Date.parse(plan.intervalStartAt) - Date.parse(plan.calibrationEndAt) >= 7 * 86_400_000);
  const { planSha256, ...unsigned } = plan;
  assert.equal(planSha256, adjustmentSha256(canonicalJsonBytes(unsigned)));
  assert.throws(() => buildAdjustmentRollingWindow(windowInput({
    fitMonth: "2027-05", requestedAt: "2027-05-02T12:00:00.000Z",
  })), /calendar support/u);
});

// local-date widths remain unchanged even when leap years and offsets differ
test("temperature and wind retain 366 local dates across daylight saving and leap years", () => {
  const plan = buildAdjustmentRollingWindow(windowInput({
    family: "temperature", fitMonth: "2027-10", requestedAt: "2027-10-02T12:00:00.000Z",
  }));
  assert.equal(plan.intervalStartAt, "2027-11-01T07:00:00.000Z");
  assert.equal(plan.intervalEndAt, "2028-11-01T07:00:00.000Z");
  assert.equal(plan.calibrationStartAt, null);
  const winter = buildAdjustmentRollingWindow(windowInput({
    family: "wind", fitMonth: "2027-01", requestedAt: "2027-01-02T12:00:00.000Z",
  }));
  assert.equal(winter.intervalStartAt, "2027-02-01T08:00:00.000Z");
  assert.equal(winter.intervalEndAt, "2028-02-02T08:00:00.000Z");
  const offsetChange = buildAdjustmentRollingWindow(windowInput({
    family: "wind", fitMonth: "2036-10", requestedAt: "2036-10-02T12:00:00.000Z",
  }));
  assert.equal(offsetChange.intervalStartAt, "2036-11-01T07:00:00.000Z");
  assert.equal(offsetChange.intervalEndAt, "2037-11-02T08:00:00.000Z");
  assert.throws(() => buildAdjustmentRollingWindow(windowInput({
    family: "wind", fitMonth: "2026-11", requestedAt: "2026-11-02T12:00:00.000Z",
  })), /calendar support/u);
});

// successors preserve prior burns and cannot relabel old training as future data
test("successor source history starts after the predecessor terminal", () => {
  const predecessorTerminalAt = "2028-08-07T07:00:00.000Z";
  assert.throws(() => buildAdjustmentRollingWindow(windowInput({
    fitMonth: "2028-09", requestedAt: "2028-09-02T12:00:00.000Z", predecessorTerminalAt,
  })), /calendar support/u);
  const plan = buildAdjustmentRollingWindow(windowInput({
    fitMonth: "2029-07", requestedAt: "2029-07-02T12:00:00.000Z", predecessorTerminalAt,
  }));
  assert.equal(plan.sourceFloorAt, predecessorTerminalAt);
  assert.ok(Date.parse(plan.trainingEndAt) - Date.parse(plan.sourceFloorAt) >= 180 * 86_400_000);
  assert.throws(() => buildAdjustmentRollingWindow(windowInput({
    predecessorTerminalAt: "2028-08-07T07:00:00.000Z",
  })), /predecessor clock/u);
});

// horizon advancement is tied to member closure rather than current wall time
test("capture cutoff extends monotonically to the actual member terminal only", () => {
  const currentEndAt = "2028-08-26T07:00:00.000Z";
  assert.equal(extendAdjustmentRollingCaptureHorizon({
    currentEndAt, memberTerminalAt: "2028-08-07T07:00:00.000Z",
  }), currentEndAt);
  assert.equal(extendAdjustmentRollingCaptureHorizon({
    currentEndAt, memberTerminalAt: "2029-08-07T07:00:00.000Z",
  }), "2029-08-07T07:00:00.000Z");
  assert.throws(() => extendAdjustmentRollingCaptureHorizon({
    currentEndAt, memberTerminalAt: currentEndAt, now: "2029-01-01T00:00:00.000Z",
  }), /fields/u);
  assert.throws(() => buildAdjustmentRollingWindow(windowInput({ fitMonth: "2027-09" })), /future/u);
});
