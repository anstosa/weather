import { pathToFileURL } from "node:url";

import {
  promoteForecastAdjustmentEvidence,
  verifyForecastAdjustmentEvidence,
} from "@weather/forecast-adjustment";

export type ForecastAdjustmentEvidenceArguments =
  | Readonly<{
      candidateArtifactSha256: string;
      command: "promote";
      evaluationReportSha256: string;
      qualificationReceiptSha256: string;
    }>
  | Readonly<{
      command: "verify";
      qualificationReceiptSha256: string;
    }>;

export interface ForecastAdjustmentEvidenceDependencies {
  readonly promoteEvidence?: (
    input: Omit<
      Extract<ForecastAdjustmentEvidenceArguments, { command: "promote" }>,
      "command"
    >,
  ) => Promise<unknown>;
  readonly verifyEvidence?: (
    input: Omit<
      Extract<ForecastAdjustmentEvidenceArguments, { command: "verify" }>,
      "command"
    >,
  ) => Promise<unknown>;
  readonly writeOutput?: (value: string) => void;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

// parse the fixed evidence command contract
export function parseForecastAdjustmentEvidenceArguments(
  arguments_: readonly string[],
): ForecastAdjustmentEvidenceArguments {
  const command = arguments_[0];

  // route the durable promotion command
  if (command === "promote") {
    const values = parseExactHashOptions(arguments_.slice(1), [
      "--candidate-sha256",
      "--evaluation-sha256",
      "--qualification-sha256",
    ]);
    return {
      candidateArtifactSha256: requireHash(values, "--candidate-sha256"),
      command,
      evaluationReportSha256: requireHash(values, "--evaluation-sha256"),
      qualificationReceiptSha256: requireHash(values, "--qualification-sha256"),
    };
  }

  // route the immutable verification command
  if (command === "verify") {
    const values = parseExactHashOptions(arguments_.slice(1), [
      "--qualification-sha256",
    ]);
    return {
      command,
      qualificationReceiptSha256: requireHash(values, "--qualification-sha256"),
    };
  }

  throw new Error("forecast-adjustment evidence command must be promote or verify");
}

// run one evidence-store operation
export async function runForecastAdjustmentEvidenceCli(
  arguments_: readonly string[] = process.argv.slice(2),
  dependencies: ForecastAdjustmentEvidenceDependencies = {},
): Promise<0> {
  const parsed = parseForecastAdjustmentEvidenceArguments(arguments_);
  let result: unknown;

  // promote one exact immutable triple
  if (parsed.command === "promote") {
    const promoteEvidence =
      dependencies.promoteEvidence ?? promoteForecastAdjustmentEvidence;
    result = await promoteEvidence({
      candidateArtifactSha256: parsed.candidateArtifactSha256,
      evaluationReportSha256: parsed.evaluationReportSha256,
      qualificationReceiptSha256: parsed.qualificationReceiptSha256,
    });
  } else {
    const verifyEvidence =
      dependencies.verifyEvidence ?? verifyForecastAdjustmentEvidence;
    result = await verifyEvidence({
      qualificationReceiptSha256: parsed.qualificationReceiptSha256,
    });
  }

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
      throw new Error("unsupported forecast-adjustment evidence argument");
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
    await runForecastAdjustmentEvidenceCli();
  } catch {
    process.stderr.write("forecast-adjustment evidence operation failed\n");
    process.exitCode = 1;
  }
}

// execute only as the evidence command
if (isEntrypoint) {
  void main();
}
