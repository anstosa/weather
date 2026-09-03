import { constants } from "node:fs";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  FORECAST_ADJUSTMENT_CONTRACT_VERSIONS,
  type ForecastAdjustmentEvidenceTripleV1,
  type ForecastAdjustmentRuntimeBundleV1,
  validateForecastAdjustmentRuntimeBundleLinks,
  validatePromotableForecastAdjustmentEvidence,
  canonicalizeJson,
  type JsonValue,
} from "@weather/domain";

import {
  canonicalJsonBytes,
  canonicalObjectSha256,
  canonicalSha256,
  deepFreeze,
  verifyForecastAdjustmentCandidate,
} from "./candidate.js";
import {
  verifyForecastAdjustmentEvaluationReport,
  verifyForecastAdjustmentQualificationReceipt,
} from "./evaluate.js";
import {
  loadVerifiedForecastAdjustmentEvidence,
  loadVerifiedForecastAdjustmentEvidenceAtRoot,
} from "./evidence.js";

const FORBIDDEN_NORMALIZED_KEYS = new Set([
  "apikey",
  "credential",
  "credentials",
  "decryptionkey",
  "deviceid",
  "devicemac",
  "encryptedmember",
  "encryptedmembers",
  "encryptionkey",
  "eventlosses",
  "evidencepath",
  "lanaddress",
  "macaddress",
  "memberpath",
  "outputpath",
  "password",
  "pereventlosses",
  "privatekey",
  "rawrow",
  "rawrows",
  "secret",
  "secrets",
  "snapshotpath",
]);
const FORBIDDEN_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/iu,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,})\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/iu,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /postgres(?:ql)?:\/\//iu,
  /(?:^|[/\\])\.weather-(?:data|models)(?:[/\\]|$)/iu,
  /(?:^|[/\\])\.weather[/\\]model-evidence(?:[/\\]|$)/iu,
  /(?:^|[/\\])(?:evidence|members?|raw(?:[-_ ]?(?:data|rows?))?|encrypted(?:[-_ ]?(?:data|members?))?)(?:[/\\]|$)/iu,
  /\.(?:age|enc|gpg|jsonl(?:\.gz)?|p12|pem|pfx)(?:$|[?#])/iu,
  /(?:^|[^a-z0-9])(?:api[-_ ]?key|access[-_ ]?key|auth[-_ ]?token|credential|password|passwd|private[-_ ]?key|pwd|secret)(?:[^a-z0-9]|$)/iu,
  /(?:^|[^a-z0-9])(?:device[-_ ]?(?:id|mac|serial)|lan[-_ ]?(?:address|host|ip)|mac[-_ ]?address|private[-_ ]?(?:address|host|ip))(?:[^a-z0-9]|$)/iu,
  /(?:^|[^0-9a-f])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?:[^0-9a-f]|$)/iu,
  /(?:^|[^\d])(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?:[^\d]|$)/u,
  /(?:^|[^a-z0-9])localhost(?:[^a-z0-9]|$)/iu,
  /(?:^|[^a-f0-9])(?:::1|f[cd][a-f0-9]{2}:|fe[89ab][a-f0-9]:)/iu,
] as const;

// report one staged, never activated runtime bundle
export interface StagedForecastAdjustmentRuntimeBundleV1 {
  readonly bundleSha256: string;
  readonly candidateArtifactSha256: string;
  readonly contractVersion: "forecast-adjustment-runtime-bundle-staging-result/v1";
  readonly evaluationReportSha256: string;
  readonly outputPath: string;
  readonly qualificationReceiptSha256: string;
}

// build an immutable sanitized runtime bundle
export function createForecastAdjustmentRuntimeBundle(
  evidence: ForecastAdjustmentEvidenceTripleV1,
): ForecastAdjustmentRuntimeBundleV1 {
  rejectForbiddenRuntimeContent(evidence);
  verifyEmbeddedEvidence(evidence);
  validatePromotableForecastAdjustmentEvidence(evidence);
  const candidateBytes = canonicalizeJson(evidence.candidate as unknown as JsonValue);
  const reportBytes = canonicalizeJson(
    evidence.evaluationReport as unknown as JsonValue,
  );
  const receiptBytes = canonicalizeJson(
    evidence.qualificationReceipt as unknown as JsonValue,
  );
  const unsigned = {
    candidate: cloneJson(evidence.candidate),
    contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.runtimeBundle,
    evaluationReport: cloneJson(evidence.evaluationReport),
    qualificationReceipt: cloneJson(evidence.qualificationReceipt),
    siteKey: "ballydidean" as const,
    timezone: "America/Los_Angeles" as const,
  };
  const bundle = deepFreeze({
    ...unsigned,
    bundleSha256: canonicalSha256(unsigned as unknown as JsonValue),
  }) as ForecastAdjustmentRuntimeBundleV1;

  // require byte-identical embedded immutable objects
  if (
    canonicalizeJson(bundle.candidate as unknown as JsonValue) !== candidateBytes ||
    canonicalizeJson(bundle.evaluationReport as unknown as JsonValue) !== reportBytes ||
    canonicalizeJson(bundle.qualificationReceipt as unknown as JsonValue) !==
      receiptBytes
  ) {
    throw new Error("runtime bundle evidence changed during packaging");
  }

  rejectForbiddenRuntimeContent(bundle);
  return bundle;
}

// verify bundle content hash and immutable evidence links
export function verifyForecastAdjustmentRuntimeBundle(
  bundle: ForecastAdjustmentRuntimeBundleV1,
): void {
  rejectForbiddenRuntimeContent(bundle);
  const keys = Object.keys(bundle).sort();
  const expected = [
    "bundleSha256",
    "candidate",
    "contractVersion",
    "evaluationReport",
    "qualificationReceipt",
    "siteKey",
    "timezone",
  ].sort();

  // reject bundle schema drift even when the outer hash is recomputed
  if (canonicalizeJson(keys) !== canonicalizeJson(expected)) {
    throw new RangeError("runtime bundle has unexpected fields");
  }

  // reject bundle substitution
  if (
    canonicalObjectSha256(
      bundle as unknown as Readonly<Record<string, unknown>>,
      "bundleSha256",
    ) !== bundle.bundleSha256
  ) {
    throw new RangeError("runtime bundle SHA-256 mismatch");
  }

  verifyEmbeddedEvidence(bundle);
  validatePromotableForecastAdjustmentEvidence(bundle);
}

// verify every embedded immutable object and its exact cross-links
function verifyEmbeddedEvidence(evidence: ForecastAdjustmentEvidenceTripleV1): void {
  verifyForecastAdjustmentCandidate(evidence.candidate);
  verifyForecastAdjustmentEvaluationReport(evidence.evaluationReport);
  verifyForecastAdjustmentQualificationReceipt(evidence.qualificationReceipt);

  // require all immutable nested identities to agree
  if (
    evidence.evaluationReport.candidateArtifactSha256 !==
      evidence.candidate.candidateArtifactSha256 ||
    evidence.qualificationReceipt.candidateArtifactSha256 !==
      evidence.candidate.candidateArtifactSha256 ||
    evidence.qualificationReceipt.evaluationReportSha256 !==
      evidence.evaluationReport.evaluationReportSha256 ||
    evidence.qualificationReceipt.preregistrationSha256 !==
      evidence.evaluationReport.preregistrationSha256 ||
    evidence.qualificationReceipt.holdoutAccessMarkerSha256 !==
      evidence.evaluationReport.holdoutAccessMarkerSha256 ||
    canonicalizeJson(
      evidence.evaluationReport.enabledMetricBands as unknown as JsonValue,
    ) !==
      canonicalizeJson(evidence.candidate.enabledMetricBands as unknown as JsonValue) ||
    canonicalizeJson(
      evidence.qualificationReceipt.enabledMetricBands as unknown as JsonValue,
    ) !== canonicalizeJson(evidence.candidate.enabledMetricBands as unknown as JsonValue)
  ) {
    throw new RangeError("runtime bundle embedded evidence cross-link mismatch");
  }
}

// stage one verified bundle at the fixed ignored-local path
export async function stageForecastAdjustmentRuntimeBundle(input: {
  readonly candidateArtifactSha256: string;
  readonly evaluationReportSha256: string;
  readonly qualificationReceiptSha256: string;
}): Promise<StagedForecastAdjustmentRuntimeBundleV1> {
  const evidence = await loadVerifiedForecastAdjustmentEvidence(input);
  return stageBundleEvidenceAtRoot(
    resolve(".weather-models", "bundle-staging"),
    evidence,
  );
}

// stage one verified bundle with test-injected roots
export async function stageForecastAdjustmentRuntimeBundleAtRoot(
  evidenceRoot: string,
  outputRoot: string,
  input: {
    readonly candidateArtifactSha256: string;
    readonly evaluationReportSha256: string;
    readonly qualificationReceiptSha256: string;
  },
): Promise<StagedForecastAdjustmentRuntimeBundleV1> {
  const evidence = await loadVerifiedForecastAdjustmentEvidenceAtRoot(
    evidenceRoot,
    input,
  );
  return stageBundleEvidenceAtRoot(outputRoot, evidence);
}

// validate bundle and registry links with a synthetic exact registry
export function verifyRuntimeBundleSelection(
  bundle: ForecastAdjustmentRuntimeBundleV1,
): void {
  verifyForecastAdjustmentRuntimeBundle(bundle);
  validateForecastAdjustmentRuntimeBundleLinks(
    {
      activeBundle: {
        bundleSha256: bundle.bundleSha256,
        candidateArtifactSha256: bundle.candidate.candidateArtifactSha256,
        evaluationReportSha256: bundle.evaluationReport.evaluationReportSha256,
        path: `bundles/sha256-${bundle.bundleSha256}.json`,
        qualificationReceiptSha256:
          bundle.qualificationReceipt.qualificationReceiptSha256,
      },
      contractVersion: FORECAST_ADJUSTMENT_CONTRACT_VERSIONS.registry,
    },
    bundle,
  );
}

// stage exact canonical bytes without registry mutation
async function stageBundleEvidenceAtRoot(
  outputRoot: string,
  evidence: ForecastAdjustmentEvidenceTripleV1,
): Promise<StagedForecastAdjustmentRuntimeBundleV1> {
  const bundle = createForecastAdjustmentRuntimeBundle(evidence);
  const outputPath = join(outputRoot, `sha256-${bundle.bundleSha256}.json`);
  await atomicWriteExact(outputPath, canonicalJsonBytes(bundle as unknown as JsonValue));

  return deepFreeze({
    bundleSha256: bundle.bundleSha256,
    candidateArtifactSha256: bundle.candidate.candidateArtifactSha256,
    contractVersion: "forecast-adjustment-runtime-bundle-staging-result/v1",
    evaluationReportSha256: bundle.evaluationReport.evaluationReportSha256,
    outputPath,
    qualificationReceiptSha256:
      bundle.qualificationReceipt.qualificationReceiptSha256,
  });
}

// reject forbidden evidence instead of stripping it
function rejectForbiddenRuntimeContent(value: unknown): void {
  // ignore primitives other than strings
  if (value === null || typeof value !== "object") {
    // reject secret, path, URL, and private-network values
    if (
      typeof value === "string" &&
      containsForbiddenRuntimeValue(value)
    ) {
      throw new RangeError("runtime bundle contains forbidden sensitive content");
    }

    return;
  }

  // descend arrays without changing order
  if (Array.isArray(value)) {
    for (const child of value) {
      rejectForbiddenRuntimeContent(child);
    }
    return;
  }

  // inspect every object field
  for (const [key, child] of Object.entries(value)) {
    // reject closed sensitive field names
    if (FORBIDDEN_NORMALIZED_KEYS.has(normalizeRuntimeKey(key))) {
      throw new RangeError(`runtime bundle contains forbidden field: ${key}`);
    }

    rejectForbiddenRuntimeContent(child);
  }
}

// detect sensitive paths, addresses, devices, and credentials
function containsForbiddenRuntimeValue(value: string): boolean {
  // reject the first matching closed value grammar
  for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
    // stop after one sensitive shape
    if (pattern.test(value)) {
      return true;
    }
  }

  return false;
}

// normalize field-name variants before the closed-key check
function normalizeRuntimeKey(value: string): string {
  return value.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

// atomically publish or verify exact staged bytes
async function atomicWriteExact(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { mode: 0o700, recursive: true });
  const temporary = `${path}.partial-${process.pid}`;
  const handle = await open(temporary, "wx", 0o600);

  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    const published = await link(temporary, path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        // defer idempotent verification for an existing bundle
        if (error.code === "EEXIST") {
          return false;
        }

        throw error;
      },
    );

    // verify an idempotent prior publication
    if (!published) {
      const existing = await readFile(path, "utf8");

      // reject same-name different bytes
      if (existing !== bytes) {
        throw new RangeError("runtime bundle path already contains different bytes");
      }
    }

    const parent = await open(dirname(path), constants.O_RDONLY);

    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

// clone one JSON object without aliases
function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalizeJson(value as unknown as JsonValue)) as T;
}
