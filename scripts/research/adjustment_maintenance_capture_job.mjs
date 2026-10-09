import { pathToFileURL } from "node:url";
import { inspectAdjustmentMaintenanceCaptureReadiness } from "./adjustment_capture_readiness.mjs";
import { ADJUSTMENT_ARCHIVE_POLL_MILLISECONDS } from "./adjustment_archive_job.mjs";
import {
  createProductionAdjustmentMaintenanceControllerPorts,
  runAdjustmentRevisionCaptureCycle,
} from "./adjustment_maintenance_controller.mjs";

// drain only canonical revision custody including its exact incumbent comparators
export async function runAdjustmentMaintenanceCaptureJob(options = {}) {
  const allowed = new Set(["maximumIterations", "ports", "signal", "sleep"]);

  // keep production paths fixed while permitting isolated process boundary tests
  if (options === null || typeof options !== "object" || Array.isArray(options) ||
    Object.keys(options).some((key) => !allowed.has(key)) ||
    (options.maximumIterations !== undefined &&
      (!Number.isSafeInteger(options.maximumIterations) || options.maximumIterations < 1))) {
    throw new TypeError("maintenance capture job options are invalid");
  }
  const ports = options.ports ?? createProductionAdjustmentMaintenanceControllerPorts();
  const controller = new AbortController();
  // combine inherited cancellation with service signals for in-flight remote requests
  const signal = options.signal === undefined ? controller.signal
    : options.signal instanceof AbortSignal
      ? AbortSignal.any([options.signal, controller.signal])
      : null;
  const sleep = options.sleep ?? waitForCapturePoll;

  // require real stop and process-lock boundaries before entering the canonical writer
  if (!(signal instanceof AbortSignal) || typeof sleep !== "function" ||
    typeof ports.withProcessLock !== "function") {
    throw new TypeError("maintenance capture job ports are invalid");
  }
  const stop = () => controller.abort();
  let iterations = 0;
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  try {
    // serialize each complete operation with daily and monthly controller writers
    while (!signal.aborted && !controller.signal.aborted &&
      iterations < (options.maximumIterations ?? Infinity)) {
      await runAdjustmentRevisionCaptureCycle({ ports });
      iterations += 1;

      // do not delay explicit test completion or an observed stop request
      if (iterations < (options.maximumIterations ?? Infinity) &&
        !signal.aborted && !controller.signal.aborted) {
        await sleep(ADJUSTMENT_ARCHIVE_POLL_MILLISECONDS,
          AbortSignal.any([signal, controller.signal]));
      }
    }
    return { iterations, stopped: signal.aborted || controller.signal.aborted };
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

// wait between complete custody operations and wake promptly on shutdown
async function waitForCapturePoll(milliseconds, signal) {
  if (signal.aborted) {
    return;
  }
  await new Promise((resolvePromise) => {
    // close either wake path and remove the temporary abort listener
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

// expose the fixed service entrypoint without accepting caller modes or paths
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // inspect only installed bytes and live authorities without initializing state
  if (process.argv.length === 3 && process.argv[2] === "--readiness") {
    const readiness = await inspectAdjustmentMaintenanceCaptureReadiness();
    process.stdout.write(`${JSON.stringify(readiness)}\n`);
    // preserve the closed refusal document while failing the installation gate
    if (!readiness.ready) process.exitCode = 3;
  } else {
    // reject caller-selected paths or activation switches
    if (process.argv.length !== 2) {
      throw new TypeError("maintenance capture job accepts only --readiness");
    }
    await runAdjustmentMaintenanceCaptureJob();
  }
}
