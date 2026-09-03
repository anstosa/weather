import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  canonicalJsonBytes,
  createForecastAdjustmentRuntimeBundle,
  canonicalObjectSha256,
  verifyForecastAdjustmentRuntimeBundle,
} from "../dist/index.js";

import { createQualifiedFixture } from "./evidence-fixtures.mjs";

// cascade one allowed-field mutation through every immutable hash
function rehashBundleEvaluationEpoch(bundle, evaluationEpochId) {
  const candidate = { ...bundle.candidate, evaluationEpochId };
  candidate.candidateArtifactSha256 = canonicalObjectSha256(
    candidate,
    "candidateArtifactSha256",
  );
  const evaluationReport = {
    ...bundle.evaluationReport,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    evaluationEpochId,
  };
  evaluationReport.evaluationReportSha256 = canonicalObjectSha256(
    evaluationReport,
    "evaluationReportSha256",
  );
  const qualificationReceipt = {
    ...bundle.qualificationReceipt,
    candidateArtifactSha256: candidate.candidateArtifactSha256,
    evaluationEpochId,
    evaluationReportSha256: evaluationReport.evaluationReportSha256,
  };
  qualificationReceipt.qualificationReceiptSha256 = canonicalObjectSha256(
    qualificationReceipt,
    "qualificationReceiptSha256",
  );
  const mutated = {
    ...bundle,
    candidate,
    evaluationReport,
    qualificationReceipt,
  };
  mutated.bundleSha256 = canonicalObjectSha256(mutated, "bundleSha256");
  return mutated;
}

test("runtime bundle embeds the exact immutable evidence triple", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-bundle-"));
  const triple = await createQualifiedFixture(directory);
  const candidateBytes = canonicalJsonBytes(triple.candidate);
  const reportBytes = canonicalJsonBytes(triple.evaluationReport);
  const receiptBytes = canonicalJsonBytes(triple.qualificationReceipt);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  verifyForecastAdjustmentRuntimeBundle(bundle);
  assert.equal(canonicalJsonBytes(bundle.candidate), candidateBytes);
  assert.equal(canonicalJsonBytes(bundle.evaluationReport), reportBytes);
  assert.equal(canonicalJsonBytes(bundle.qualificationReceipt), receiptBytes);
  assert.equal(Object.isFrozen(bundle.candidate.coefficients), true);
  assert.equal(bundle.candidate.evaluationEpochId, "epoch-2026-01");
});

test("runtime bundle rejects forbidden evidence rather than stripping it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-bundle-leak-"));
  const triple = await createQualifiedFixture(directory);
  assert.throws(
    () =>
      createForecastAdjustmentRuntimeBundle({
        ...triple,
        candidate: {
          ...triple.candidate,
          rawRows: [{ actual: 17 }],
        },
      }),
    /exact schema|unexpected field|forbidden/u,
  );
  assert.throws(
    () =>
      createForecastAdjustmentRuntimeBundle({
        ...triple,
        candidate: {
          ...triple.candidate,
          forecastIdentity: {
            ...triple.candidate.forecastIdentity,
            sourceKey: "postgresql://production.example/weather",
          },
        },
      }),
    /forbidden|mismatch/u,
  );
  assert.throws(
    () =>
      createForecastAdjustmentRuntimeBundle({
        ...triple,
        candidate: {
          ...triple.candidate,
          evaluationEpochId: "AKIA1234567890ABCDEF",
        },
      }),
    /forbidden/u,
  );
});

test("fully rehashed allowed fields cannot carry sensitive runtime values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-bundle-value-leak-"));
  const triple = await createQualifiedFixture(directory);
  const bundle = createForecastAdjustmentRuntimeBundle(triple);
  const forbiddenValues = [
    "/home/operator/.weather-models/run-123",
    ".weather-data/manifest/member.jsonl.gz",
    "${HOME}/.weather/model-evidence/candidate",
    "/evidence/encrypted-members/part-0001.age",
    "device-serial=01:23:45:67:89:ab",
    "lan_address=192.168.1.25",
    "private-key=/tmp/server.pem",
    "credential=postgresql://operator:password@database/weather",
    "AKIA1234567890ABCDEF",
  ];

  // reject every value after a complete hash cascade
  for (const forbiddenValue of forbiddenValues) {
    const mutated = rehashBundleEvaluationEpoch(bundle, forbiddenValue);
    assert.throws(
      () => verifyForecastAdjustmentRuntimeBundle(mutated),
      /forbidden sensitive content/u,
      forbiddenValue,
    );
  }
});

test("recomputed outer bundle cannot conceal a stale nested candidate hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "weather-bundle-nested-"));
  const triple = await createQualifiedFixture(directory);
  const original = createForecastAdjustmentRuntimeBundle(triple);
  const substituted = {
    ...original,
    candidate: { ...original.candidate, developmentReportSha256: "f".repeat(64) },
  };
  substituted.bundleSha256 = canonicalObjectSha256(substituted, "bundleSha256");
  assert.throws(
    () => verifyForecastAdjustmentRuntimeBundle(substituted),
    /candidate artifact SHA-256 mismatch/u,
  );
});
