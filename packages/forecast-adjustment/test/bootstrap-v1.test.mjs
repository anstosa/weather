import assert from "node:assert/strict";
import test from "node:test";

import {
  MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX,
  MOVING_BLOCK_BOOTSTRAP_REPLICATES,
  MOVING_BLOCK_BOOTSTRAP_SEED,
  THIRTY_DATE_BOOTSTRAP_PLAN_SHA256,
  bootstrapEventLoss,
  createMovingBlockBootstrapStartPlan,
  createSingleWindowBootstrapStartPlan,
  expandNonCircularBlockStarts,
  movingBlockBootstrap,
  scoreMovingBlockBootstrapPlan,
  singleWindowBootstrapPlanSha256,
  xorshift32,
} from "../dist/index.js";

// create one deterministic date slot fixture
function dateSlot(offset, events) {
  return {
    events,
    localDate: `2025-01-${String(offset + 1).padStart(2, "0")}`,
  };
}

// verify the literal xorshift bit sequence and unsigned conversion
test("matches the frozen xorshift32 hand oracle", () => {
  const first = xorshift32(MOVING_BLOCK_BOOTSTRAP_SEED);
  const second = xorshift32(first);
  assert.equal(first, 0xf549aa51);
  assert.equal(second, 0xc07ea050);
  assert.throws(() => xorshift32(-1), /unsigned/u);
});

// verify undersized windows reject before any sampler plan exists
test("rejects N below seven before drawing", () => {
  assert.throws(
    () => createMovingBlockBootstrapStartPlan([6]),
    /at least seven/u,
  );
  assert.throws(
    () => createMovingBlockBootstrapStartPlan([30, 6]),
    /at least seven/u,
  );
});

// verify the exact canonical 30-date plan hash and leading starts
test("matches the frozen 30-date 2000-replicate plan", () => {
  const plan = createSingleWindowBootstrapStartPlan(30);
  assert.equal(plan.length, MOVING_BLOCK_BOOTSTRAP_REPLICATES);
  assert.deepEqual(plan[0], [22, 18, 14, 9, 5]);
  assert.deepEqual(plan[1], [12, 15, 7, 18, 1]);
  assert.equal(
    singleWindowBootstrapPlanSha256(30),
    THIRTY_DATE_BOOTSTRAP_PLAN_SHA256,
  );
  assert.deepEqual(createSingleWindowBootstrapStartPlan(30), plan);
});

// verify replicate-outer fold-inner continuous draw ordering
test("continues draws across folds inside each replicate", () => {
  const pooled = createMovingBlockBootstrapStartPlan([30, 30]);
  assert.deepEqual(pooled[0]?.[0], [22, 18, 14, 9, 5]);
  assert.deepEqual(pooled[0]?.[1], [12, 15, 7, 18, 1]);
  assert.notDeepEqual(pooled[1]?.[0], [12, 15, 7, 18, 1]);
});

// verify non-circular concatenation and truncation for the eight-date oracle
test("expands the eight-date hand-oracle block starts", () => {
  assert.deepEqual(expandNonCircularBlockStarts([1, 1], 8), [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    1,
  ]);
  assert.throws(() => expandNonCircularBlockStarts([2, 1], 8), /outside/u);
});

// verify empty dates remain slots and paired occurrences retain exact skill
test("matches the eight-date empty-slot paired-loss oracle", () => {
  const pairedEvent = { actual: 0, adjustedPrediction: 1, rawPrediction: 2 };
  const dateSlots = Array.from({ length: 8 }, (_unused, offset) =>
    dateSlot(offset, offset === 3 ? [] : [pairedEvent]),
  );
  const result = movingBlockBootstrap([{ dateSlots, key: "oracle" }]);
  assert.equal(result.eventCount, 7);
  assert.equal(result.rawLoss, 2);
  assert.equal(result.adjustedLoss, 1);
  assert.equal(result.skill, 0.5);
  assert.equal(result.bootstrapLowerBound, 0.5);
  assert.equal(result.replicateSkills.length, 2_000);
  assert.equal(
    [...result.replicateSkills].sort((left, right) => left - right)[
      MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX
    ],
    result.bootstrapLowerBound,
  );
  const plan = createMovingBlockBootstrapStartPlan([8]);
  assert.deepEqual(scoreMovingBlockBootstrapPlan(
    [{ dateSlots, key: "oracle" }],
    plan,
  ), result);
});

// verify direction loss uses circular error while sampling dates normally
test("scores circular direction loss without circular date blocks", () => {
  assert.equal(bootstrapEventLoss(1, 359, true), 2);
  assert.equal(bootstrapEventLoss(1, 359, false), 358);
  const dateSlots = Array.from({ length: 7 }, (_unused, offset) =>
    dateSlot(offset, [
      { actual: 1, adjustedPrediction: 0, rawPrediction: 359 },
    ]),
  );
  const result = movingBlockBootstrap([{ dateSlots, key: "direction" }], true);
  assert.equal(result.rawLoss, 2);
  assert.equal(result.adjustedLoss, 1);
  assert.equal(result.skill, 0.5);
});

// verify zero-event original and replicate samples reject instead of imputing
test("rejects zero-event bootstrap windows", () => {
  const dateSlots = Array.from({ length: 7 }, (_unused, offset) =>
    dateSlot(offset, []),
  );
  assert.throws(
    () => movingBlockBootstrap([{ dateSlots, key: "empty" }]),
    /zero matched events/u,
  );
});

// verify retained window slots must be consecutive local calendar labels
test("rejects missing local-date slots", () => {
  const pairedEvent = { actual: 0, adjustedPrediction: 1, rawPrediction: 2 };
  const dateSlots = Array.from({ length: 7 }, (_unused, offset) =>
    dateSlot(offset, [pairedEvent]),
  );
  dateSlots[3] = { ...dateSlots[3], localDate: "2025-01-05" };
  assert.throws(
    () => movingBlockBootstrap([{ dateSlots, key: "gap" }]),
    /consecutive/u,
  );
});
