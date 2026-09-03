import { createHash } from "node:crypto";

import { corePairedSkill, wrap180 } from "./algorithm-v1.js";
import { addLocalCalendarDays } from "./calendar.js";

// freeze the literal bootstrap contract
export const MOVING_BLOCK_BOOTSTRAP_VERSION = "moving-block-bootstrap/v1" as const;
export const MOVING_BLOCK_BOOTSTRAP_SEED = 0x5eedb007 as const;
export const MOVING_BLOCK_BOOTSTRAP_REPLICATES = 2_000 as const;
export const MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS = 7 as const;
export const MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX = 49 as const;
export const MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX = 1_949 as const;
export const THIRTY_DATE_BOOTSTRAP_PLAN_SHA256 =
  "17c35e92d35c7e0ef1644e9c3f33c1ffb98237eadb2fd19813c203c700d447ac" as const;

// describe one paired forecast loss event
export interface BootstrapPairedEvent {
  readonly actual: number;
  readonly adjustedPrediction: number;
  readonly rawPrediction: number;
}

// retain empty local-date slots as first-class sampler units
export interface BootstrapDateSlot {
  readonly events: readonly BootstrapPairedEvent[];
  readonly localDate: string;
}

// describe one scored fold or holdout window
export interface BootstrapScoredWindow {
  readonly dateSlots: readonly BootstrapDateSlot[];
  readonly key: string;
}

// describe deterministic bootstrap evidence
export interface MovingBlockBootstrapResult {
  readonly adjustedLoss: number;
  readonly bootstrapLowerBound: number;
  readonly bootstrapUpperBound: number;
  readonly eventCount: number;
  readonly rawLoss: number;
  readonly replicateSkills: readonly number[];
  readonly skill: number;
}

// advance the literal unsigned xorshift32 state once
export function xorshift32(state: number): number {
  // require one unsigned 32-bit state
  if (!Number.isInteger(state) || state < 0 || state > 0xffff_ffff) {
    throw new RangeError("xorshift32 state must be an unsigned 32-bit integer");
  }

  let next = (state ^ (state << 13)) >>> 0;
  next = (next ^ (next >>> 17)) >>> 0;
  next = (next ^ (next << 5)) >>> 0;
  return next;
}

// validate every window before the first random draw
function validateWindowLengths(windowLengths: readonly number[]): void {
  // require at least one scored window
  if (windowLengths.length === 0) {
    throw new RangeError("bootstrap requires at least one scored window");
  }

  // reject undersized windows before creating PRNG state
  for (const length of windowLengths) {
    // enforce whole non-circular local-date slots
    if (!Number.isInteger(length) || length < MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS) {
      throw new RangeError("bootstrap scored windows require at least seven dates");
    }
  }
}

// create the replicate-outer and window-inner block-start plan
export function createMovingBlockBootstrapStartPlan(
  windowLengths: readonly number[],
): readonly (readonly (readonly number[])[])[] {
  validateWindowLengths(windowLengths);
  let state = MOVING_BLOCK_BOOTSTRAP_SEED >>> 0;
  const plan: number[][][] = [];

  // advance one continuous stream across each replicate's windows
  for (
    let replicate = 0;
    replicate < MOVING_BLOCK_BOOTSTRAP_REPLICATES;
    replicate += 1
  ) {
    const replicatePlan: number[][] = [];

    // process development folds in caller-provided chronological order
    for (const length of windowLengths) {
      const starts: number[] = [];
      let sampledSlots = 0;

      // append seven-date blocks until the window is covered
      while (sampledSlots < length) {
        state = xorshift32(state);
        const uniform = state / 4_294_967_296;
        starts.push(
          Math.floor(
            uniform * (length - MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS + 1),
          ),
        );
        sampledSlots += MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS;
      }

      replicatePlan.push(starts);
    }

    plan.push(replicatePlan);
  }

  return plan;
}

// create the frozen single-window serialization shape
export function createSingleWindowBootstrapStartPlan(
  windowLength: number,
): readonly (readonly number[])[] {
  return createMovingBlockBootstrapStartPlan([windowLength]).map(
    (replicate) => {
      const starts = replicate[0];

      // retain the compiler-proven single window
      if (starts === undefined) {
        throw new Error("single-window bootstrap plan is incomplete");
      }

      return starts;
    },
  );
}

// serialize and hash the exact single-window plan
export function singleWindowBootstrapPlanSha256(windowLength: number): string {
  const serialized = `${JSON.stringify(
    createSingleWindowBootstrapStartPlan(windowLength),
  )}\n`;
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

// expand non-circular starts and truncate to one window length
export function expandNonCircularBlockStarts(
  starts: readonly number[],
  windowLength: number,
): readonly number[] {
  validateWindowLengths([windowLength]);
  const offsets: number[] = [];
  const maximumStart = windowLength - MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS;
  const requiredStarts = Math.ceil(
    windowLength / MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS,
  );

  // require the literal stop-after-coverage draw count
  if (starts.length !== requiredStarts) {
    throw new RangeError("bootstrap block plan has the wrong draw count");
  }

  // expand every block without wrapping
  for (const start of starts) {
    // reject a start outside zero through N minus seven
    if (!Number.isInteger(start) || start < 0 || start > maximumStart) {
      throw new RangeError("bootstrap block start falls outside the scored window");
    }

    // append the exact seven consecutive date slots
    for (let offset = 0; offset < MOVING_BLOCK_BOOTSTRAP_BLOCK_DAYS; offset += 1) {
      offsets.push(start + offset);
    }
  }

  // reject plans too short to cover the window
  if (offsets.length < windowLength) {
    throw new RangeError("bootstrap block plan does not cover the scored window");
  }

  return offsets.slice(0, windowLength);
}

// compute one scalar or circular event loss
export function bootstrapEventLoss(
  actual: number,
  prediction: number,
  direction: boolean,
): number {
  // reject nonfinite score inputs
  if (!Number.isFinite(actual) || !Number.isFinite(prediction)) {
    throw new RangeError("bootstrap score inputs must be finite");
  }

  return direction
    ? Math.abs(wrap180(actual - prediction))
    : Math.abs(actual - prediction);
}

// aggregate paired loss over exact event occurrences
function aggregatePairedLoss(
  events: readonly BootstrapPairedEvent[],
  direction: boolean,
): {
  readonly adjustedLoss: number;
  readonly eventCount: number;
  readonly rawLoss: number;
  readonly skill: number;
} {
  // reject zero-event replicates rather than dropping them
  if (events.length === 0) {
    throw new RangeError("bootstrap replicate contains zero matched events");
  }

  let rawLoss = 0;
  let adjustedLoss = 0;

  // score the same paired occurrences once
  for (const event of events) {
    rawLoss += bootstrapEventLoss(event.actual, event.rawPrediction, direction);
    adjustedLoss += bootstrapEventLoss(
      event.actual,
      event.adjustedPrediction,
      direction,
    );
  }

  rawLoss /= events.length;
  adjustedLoss /= events.length;
  return {
    adjustedLoss,
    eventCount: events.length,
    rawLoss,
    skill: corePairedSkill(rawLoss, adjustedLoss),
  };
}

// collect original events in chronological window/date order
function originalEventOccurrences(
  windows: readonly BootstrapScoredWindow[],
): readonly BootstrapPairedEvent[] {
  return windows.flatMap((window) =>
    window.dateSlots.flatMap((slot) => slot.events),
  );
}

// validate chronological scored-window identities before sampling
function validateScoredWindows(windows: readonly BootstrapScoredWindow[]): void {
  validateWindowLengths(windows.map((window) => window.dateSlots.length));
  const keys = new Set<string>();

  // require unique windows with consecutive retained date slots
  for (const window of windows) {
    // reject duplicate or empty fold identities
    if (window.key.length === 0 || keys.has(window.key)) {
      throw new RangeError("bootstrap scored window keys must be nonempty and unique");
    }

    keys.add(window.key);
    const firstLocalDate = window.dateSlots[0]?.localDate;

    // retain the validated nonempty date window
    if (firstLocalDate === undefined) {
      throw new RangeError("bootstrap scored window must contain date slots");
    }

    // reject shifted, duplicated, or missing calendar labels
    for (let index = 0; index < window.dateSlots.length; index += 1) {
      const slot = window.dateSlots[index];

      // compare every explicit local-date slot
      if (
        slot === undefined ||
        slot.localDate !== addLocalCalendarDays(firstLocalDate, index)
      ) {
        throw new RangeError("bootstrap date slots must be consecutive local dates");
      }
    }
  }
}

// collect one replicate's exact resampled event occurrences
function resampledEventOccurrences(
  windows: readonly BootstrapScoredWindow[],
  replicatePlan: readonly (readonly number[])[],
): readonly BootstrapPairedEvent[] {
  const events: BootstrapPairedEvent[] = [];

  // resample each fold independently without crossing boundaries
  for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
    const window = windows[windowIndex];
    const starts = replicatePlan[windowIndex];

    // reject a plan/window mismatch
    if (window === undefined || starts === undefined) {
      throw new RangeError("bootstrap plan does not match scored windows");
    }

    const offsets = expandNonCircularBlockStarts(
      starts,
      window.dateSlots.length,
    );

    // retain empty selected dates while collecting their zero events
    for (const offset of offsets) {
      const slot = window.dateSlots[offset];

      // retain the compiler-proven selected slot
      if (slot === undefined) {
        throw new Error("bootstrap selected date offset is missing");
      }

      events.push(...slot.events);
    }
  }

  return events;
}

// run the frozen paired moving-block bootstrap
export function scoreMovingBlockBootstrapPlan(
  windows: readonly BootstrapScoredWindow[],
  plan: readonly (readonly (readonly number[])[])[],
  direction = false,
): MovingBlockBootstrapResult {
  validateScoredWindows(windows);

  // require the exact frozen replicate count
  if (plan.length !== MOVING_BLOCK_BOOTSTRAP_REPLICATES) {
    throw new RangeError("bootstrap plan must contain exactly 2000 replicates");
  }

  const original = aggregatePairedLoss(
    originalEventOccurrences(windows),
    direction,
  );
  const replicateSkills: number[] = [];

  // score every replicate without dropping invalid samples
  for (const replicatePlan of plan) {
    // require one block-start list per scored window
    if (replicatePlan.length !== windows.length) {
      throw new RangeError("bootstrap replicate does not match scored windows");
    }

    const replicate = aggregatePairedLoss(
      resampledEventOccurrences(windows, replicatePlan),
      direction,
    );

    // reject nonfinite bootstrap skill
    if (!Number.isFinite(replicate.skill)) {
      throw new RangeError("bootstrap replicate skill must be finite");
    }

    replicateSkills.push(replicate.skill);
  }

  const sortedSkills = [...replicateSkills].sort((left, right) => left - right);
  const bootstrapLowerBound = sortedSkills[MOVING_BLOCK_BOOTSTRAP_LOWER_INDEX];
  const bootstrapUpperBound = sortedSkills[MOVING_BLOCK_BOOTSTRAP_UPPER_INDEX];

  // retain the exact 2,000-replicate quantiles
  if (bootstrapLowerBound === undefined || bootstrapUpperBound === undefined) {
    throw new Error("bootstrap quantile indexes are unavailable");
  }

  return {
    adjustedLoss: original.adjustedLoss,
    bootstrapLowerBound,
    bootstrapUpperBound,
    eventCount: original.eventCount,
    rawLoss: original.rawLoss,
    replicateSkills,
    skill: original.skill,
  };
}

// run an independently reset frozen paired moving-block bootstrap
export function movingBlockBootstrap(
  windows: readonly BootstrapScoredWindow[],
  direction = false,
): MovingBlockBootstrapResult {
  validateScoredWindows(windows);
  const plan = createMovingBlockBootstrapStartPlan(
    windows.map((window) => window.dateSlots.length),
  );
  return scoreMovingBlockBootstrapPlan(windows, plan, direction);
}
