import { createHash } from "node:crypto";

export const WORKER_CADENCE_MS = 60 * 1_000;
export const MAX_SCHEDULE_JITTER_MS = 30_000;

export interface NonOverlappingScheduler {
  readonly isRunning: () => boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly trigger: () => Promise<boolean>;
}

interface SchedulerOptions {
  readonly cadenceMs?: number;
  readonly clearTimeout?: (timeout: NodeJS.Timeout) => void;
  readonly key: string;
  readonly now?: () => Date;
  readonly onError?: (error: unknown) => void;
  readonly run: () => Promise<void>;
  readonly setTimeout?: (
    callback: () => void,
    milliseconds: number,
  ) => NodeJS.Timeout;
}

// derive stable per-worker jitter
export function deterministicJitterMilliseconds(
  key: string,
  maximum = MAX_SCHEDULE_JITTER_MS,
): number {
  // require a bounded range
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 60_000) {
    throw new RangeError("jitter maximum must be between 0 and 60000ms");
  }

  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt32BE(0) % (maximum + 1);
}

// calculate the next anchored run without drift
export function nextScheduledAt(
  now: Date,
  key: string,
  cadenceMs = WORKER_CADENCE_MS,
): Date {
  // require a positive cadence
  if (!Number.isSafeInteger(cadenceMs) || cadenceMs < 1) {
    throw new RangeError("scheduler cadence must be positive");
  }

  const jitter = deterministicJitterMilliseconds(
    key,
    Math.min(MAX_SCHEDULE_JITTER_MS, cadenceMs - 1),
  );
  const currentCycle = Math.floor(now.getTime() / cadenceMs) * cadenceMs;
  let candidate = currentCycle + jitter;

  // move past an elapsed slot
  if (candidate <= now.getTime()) {
    candidate += cadenceMs;
  }

  return new Date(candidate);
}

// schedule one non-overlapping worker loop
export function createNonOverlappingScheduler(
  options: SchedulerOptions,
): NonOverlappingScheduler {
  const cadenceMs = options.cadenceMs ?? WORKER_CADENCE_MS;
  const now = options.now ?? defaultNow;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  let stopped = true;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  // arm the next anchored slot
  function scheduleNext(): void {
    // do not arm a stopped scheduler
    if (stopped) {
      return;
    }

    const delay = Math.max(
      0,
      nextScheduledAt(now(), options.key, cadenceMs).getTime() - now().getTime(),
    );
    timer = setTimer(() => {
      // retain the scheduler after task failures
      void trigger()
        .catch((error: unknown) => {
          options.onError?.(error);
        })
        .finally(scheduleNext);
    }, delay);
  }

  // execute only when idle
  async function trigger(): Promise<boolean> {
    // skip overlapping execution
    if (running) {
      return false;
    }

    running = true;

    try {
      await options.run();
      return true;
    } finally {
      running = false;
    }
  }

  // start one scheduler
  function start(): void {
    // make startup idempotent
    if (!stopped) {
      return;
    }

    stopped = false;
    scheduleNext();
  }

  // stop future runs
  function stop(): void {
    stopped = true;

    // clear an armed slot
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    isRunning: () => running,
    start,
    stop,
    trigger,
  };
}

// read the current clock
function defaultNow(): Date {
  return new Date();
}
