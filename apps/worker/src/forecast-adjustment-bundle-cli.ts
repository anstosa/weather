import { pathToFileURL } from "node:url";

import { stageForecastAdjustmentRuntimeBundle } from "@weather/forecast-adjustment";

export interface ForecastAdjustmentBundleArguments {
  readonly candidateArtifactSha256: string;
  readonly evaluationReportSha256: string;
  readonly qualificationReceiptSha256: string;
}

export interface ForecastAdjustmentBundleDependencies {
  readonly stageBundle?: (
    input: ForecastAdjustmentBundleArguments,
  ) => Promise<unknown>;
  readonly writeOutput?: (value: string) => void;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

// parse the exact runtime-bundle command
export function parseForecastAdjustmentBundleArguments(
  arguments_: readonly string[],
): ForecastAdjustmentBundleArguments {
  const values = parseExactHashOptions(arguments_, [
    "--candidate-sha256",
    "--evaluation-sha256",
    "--qualification-sha256",
  ]);

  return {
    candidateArtifactSha256: requireHash(values, "--candidate-sha256"),
    evaluationReportSha256: requireHash(values, "--evaluation-sha256"),
    qualificationReceiptSha256: requireHash(values, "--qualification-sha256"),
  };
}

// stage one verified immutable triple
export async function runForecastAdjustmentBundleCli(
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: ForecastAdjustmentBundleDependencies = {},
): Promise<0> {
  const parsed = parseForecastAdjustmentBundleArguments(arguments_);
  const stageBundle =
    dependencies.stageBundle ?? stageForecastAdjustmentRuntimeBundle;
  const result = await stageBundle(parsed);
  const serialized = serializeStableJson(result);
  const writeOutput =
    dependencies.writeOutput ?? process.stdout.write.bind(process.stdout);
  writeOutput(serialized);
  return 0;
}

// parse unique hash options only
function parseExactHashOptions(
  arguments_: readonly string[],
  supportedOptions: readonly string[],
): ReadonlyMap<string, string> {
  const supported = new Set(supportedOptions);
  const values = new Map<string, string>();

  // consume every argument pair
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];

    // reject unknown or positional input
    if (option === undefined || !supported.has(option)) {
      throw new Error("unsupported forecast-adjustment bundle argument");
    }

    // require one exact digest
    if (value === undefined || !HASH_PATTERN.test(value)) {
      throw new RangeError(`${option} must be a lowercase SHA-256 digest`);
    }

    // reject ambiguous duplicate controls
    if (values.has(option)) {
      throw new Error(`${option} may be specified only once`);
    }

    values.set(option, value);
  }

  return values;
}

// require one parsed digest
function requireHash(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);

  // reject absent digests
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }

  return value;
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
      throw new TypeError("forecast-adjustment result contains a non-finite number");
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
      throw new TypeError("forecast-adjustment result must contain only plain JSON");
    }

    const normalized: Record<string, unknown> = {};

    // sort keys for stable output
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }

    return normalized;
  }

  throw new TypeError("forecast-adjustment result must be JSON serializable");
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

// run the bounded process entrypoint
async function main(): Promise<void> {
  try {
    await runForecastAdjustmentBundleCli();
  } catch {
    process.stderr.write("forecast-adjustment bundle staging failed\n");
    process.exitCode = 1;
  }
}

// execute only as the staging command
if (isEntrypoint) {
  void main();
}
