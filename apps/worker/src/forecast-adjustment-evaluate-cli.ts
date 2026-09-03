import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { evaluateForecastAdjustmentSnapshot } from "@weather/forecast-adjustment";

export interface ForecastAdjustmentEvaluateArguments {
  readonly outputPath: string;
  readonly snapshotPath: string;
}

export interface ForecastAdjustmentEvaluateDependencies {
  readonly evaluateSnapshot?: (
    input: ForecastAdjustmentEvaluateArguments,
  ) => Promise<unknown>;
  readonly workingDirectory?: string;
  readonly writeOutput?: (value: string) => void;
}

const SNAPSHOT_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const OUTPUT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// parse the file-only evaluation contract
export function parseForecastAdjustmentEvaluateArguments(
  arguments_: readonly string[],
  workingDirectory = REPOSITORY_ROOT,
): ForecastAdjustmentEvaluateArguments {
  const values = parseExactValueOptions(arguments_, ["--snapshot", "--output"]);
  const snapshotPath = resolveIgnoredChild(
    workingDirectory,
    ".weather-data",
    requireArgument(values, "--snapshot"),
    SNAPSHOT_HASH_PATTERN,
    "snapshot",
  );
  const outputPath = resolveIgnoredChild(
    workingDirectory,
    ".weather-models",
    requireArgument(values, "--output"),
    OUTPUT_ID_PATTERN,
    "output",
  );

  // reserve the bundle publication namespace
  if (outputPath === resolve(workingDirectory, ".weather-models/bundle-staging")) {
    throw new RangeError("evaluation output must not use bundle staging");
  }

  return { outputPath, snapshotPath };
}

// run one injected file-only evaluation
export async function runForecastAdjustmentEvaluateCli(
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: ForecastAdjustmentEvaluateDependencies = {},
): Promise<0 | 2> {
  const parsed = parseForecastAdjustmentEvaluateArguments(
    arguments_,
    dependencies.workingDirectory ?? REPOSITORY_ROOT,
  );
  const evaluateSnapshot =
    dependencies.evaluateSnapshot ?? evaluateForecastAdjustmentSnapshot;
  const result = await evaluateSnapshot(parsed);
  const exitCode = evaluationExitCode(result);
  const serialized = serializeStableJson(result);
  const writeOutput =
    dependencies.writeOutput ?? process.stdout.write.bind(process.stdout);
  writeOutput(serialized);
  return exitCode;
}

// parse unique named values only
function parseExactValueOptions(
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
      throw new Error("unsupported forecast-adjustment evaluation argument");
    }

    // require one material value
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      throw new Error(`${option} requires a value`);
    }

    // reject ambiguous duplicate controls
    if (values.has(option)) {
      throw new Error(`${option} may be specified only once`);
    }

    values.set(option, value);
  }

  return values;
}

// require one named argument
function requireArgument(
  values: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = values.get(name);

  // reject absent values
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }

  return value;
}

// constrain one ignored local child
function resolveIgnoredChild(
  workingDirectory: string,
  directoryName: ".weather-data" | ".weather-models",
  value: string,
  childPattern: RegExp,
  label: string,
): string {
  const root = resolve(workingDirectory, directoryName);
  const target = resolve(workingDirectory, value);
  const child = relative(root, target);

  // require one canonical descendant
  if (
    child.length === 0 ||
    child.startsWith(`..${sep}`) ||
    child === ".." ||
    isAbsolute(child) ||
    child.includes(sep) ||
    !childPattern.test(child)
  ) {
    throw new RangeError(`${label} must be one valid child of ${directoryName}`);
  }

  return target;
}

// serialize deterministic operator JSON
function serializeStableJson(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value))}\n`;
}

// preserve only exact evaluator status values
function evaluationExitCode(value: unknown): 0 | 2 {
  // require one non-array object result
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RangeError("forecast-adjustment result has an invalid exit code");
  }

  const prototype = Object.getPrototypeOf(value);

  // require a plain object with an own status
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    !Object.hasOwn(value, "exitCode")
  ) {
    throw new RangeError("forecast-adjustment result has an invalid exit code");
  }

  const exitCode = (value as { readonly exitCode: unknown }).exitCode;

  // permit only documented status codes
  if (exitCode !== 0 && exitCode !== 2) {
    throw new RangeError("forecast-adjustment result has an invalid exit code");
  }

  return exitCode;
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
    process.exitCode = await runForecastAdjustmentEvaluateCli();
  } catch {
    process.stderr.write("forecast-adjustment evaluation failed\n");
    process.exitCode = 1;
  }
}

// execute only as the evaluator command
if (isEntrypoint) {
  void main();
}
