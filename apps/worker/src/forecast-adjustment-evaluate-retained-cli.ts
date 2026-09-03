import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  evaluateRetainedForecastAdjustmentSnapshot,
  MODEL_EVIDENCE_ROOT,
} from "@weather/forecast-adjustment";

export interface ForecastAdjustmentEvaluateRetainedArguments {
  readonly snapshotSha256: string;
}

export interface ForecastAdjustmentEvaluateRetainedDependencies {
  readonly evaluateSnapshot?: typeof evaluateRetainedForecastAdjustmentSnapshot;
  readonly writeOutput?: (value: string) => void;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

// parse the exact retained-evaluation command
export function parseForecastAdjustmentEvaluateRetainedArguments(
  arguments_: readonly string[],
): ForecastAdjustmentEvaluateRetainedArguments {
  // require one named digest pair
  if (arguments_.length !== 2 || arguments_[0] !== "--snapshot-sha256") {
    throw new Error(
      "forecast-adjustment retained evaluation requires exactly --snapshot-sha256",
    );
  }

  const snapshotSha256 = arguments_[1];

  // require one canonical content address
  if (snapshotSha256 === undefined || !HASH_PATTERN.test(snapshotSha256)) {
    throw new RangeError(
      "--snapshot-sha256 must be a lowercase SHA-256 digest",
    );
  }

  return { snapshotSha256 };
}

// run one durable retained evaluation
export async function runForecastAdjustmentEvaluateRetainedCli(
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: ForecastAdjustmentEvaluateRetainedDependencies = {},
): Promise<0 | 2> {
  const { snapshotSha256 } =
    parseForecastAdjustmentEvaluateRetainedArguments(arguments_);
  const evaluateSnapshot =
    dependencies.evaluateSnapshot ?? evaluateRetainedForecastAdjustmentSnapshot;
  const result = await evaluateSnapshot({
    evidenceRoot: MODEL_EVIDENCE_ROOT,
    snapshotPath: join(MODEL_EVIDENCE_ROOT, "snapshots", snapshotSha256),
  });
  const exitCode = retainedEvaluationExitCode(result);
  const serialized = serializeStableJson(result);
  const writeOutput =
    dependencies.writeOutput ?? process.stdout.write.bind(process.stdout);
  writeOutput(serialized);
  return exitCode;
}

// map the exact retained evaluator states
function retainedEvaluationExitCode(value: unknown): 0 | 2 {
  // require one plain result object
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError(
      "forecast-adjustment retained result has an invalid state",
    );
  }

  const prototype = Object.getPrototypeOf(value);

  // reject inherited or special-object states
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    !Object.hasOwn(value, "state")
  ) {
    throw new RangeError(
      "forecast-adjustment retained result has an invalid state",
    );
  }

  const state = (value as { readonly state: unknown }).state;

  // return success only after promotion
  if (state === "promoted") {
    return 0;
  }

  // return the documented non-error insufficiency status
  if (state === "insufficient_data") {
    return 2;
  }

  throw new RangeError("forecast-adjustment retained result has an invalid state");
}

// serialize deterministic operator JSON
function serializeStableJson(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value))}\n`;
}

// normalize one JSON-safe value
function normalizeJson(value: unknown): unknown {
  // preserve JSON scalars
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  // require finite JSON numbers
  if (typeof value === "number") {
    // reject non-JSON numeric values
    if (!Number.isFinite(value)) {
      throw new TypeError(
        "forecast-adjustment retained result contains a non-finite number",
      );
    }

    return value;
  }

  // normalize array members
  if (Array.isArray(value)) {
    const normalized: unknown[] = [];

    // normalize every array entry
    for (const entry of value) {
      normalized.push(normalizeJson(entry));
    }

    return normalized;
  }

  // normalize plain object keys
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);

    // reject class instances and special objects
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "forecast-adjustment retained result must contain only plain JSON",
      );
    }

    const normalized: Record<string, unknown> = {};

    // sort keys for stable output
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }

    return normalized;
  }

  throw new TypeError(
    "forecast-adjustment retained result must be JSON serializable",
  );
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

// run the bounded process entrypoint
async function main(): Promise<void> {
  try {
    process.exitCode = await runForecastAdjustmentEvaluateRetainedCli();
  } catch {
    process.stderr.write("forecast-adjustment retained evaluation failed\n");
    process.exitCode = 1;
  }
}

// execute only as the retained evaluator command
if (isEntrypoint) {
  void main();
}
