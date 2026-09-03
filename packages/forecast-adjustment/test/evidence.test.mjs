import assert from "node:assert/strict";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertDurableTrainingRetention,
  promoteForecastAdjustmentEvidenceAtRoot,
  stageEvidenceRedundancyAttestation,
  stageForecastAdjustmentEvidenceObject,
  stageForecastAdjustmentRuntimeBundleAtRoot,
  stageRedundantEvidenceObject,
  verifyForecastAdjustmentEvidenceAtRoot,
} from "../dist/index.js";

import { createQualifiedFixture } from "./evidence-fixtures.mjs";

test("evidence promotion requires and verifies an independent exact copy", async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "weather-evidence-"));
  const triple = await createQualifiedFixture(evidenceRoot);
  await stageEvidenceRedundancyAttestation(evidenceRoot, triple.attestation);

  for (const [kind, value] of [
    ["snapshot-manifest", triple.snapshotManifest],
    ["development-report", triple.developmentReport],
    ["preregistration", triple.preregistration],
    ["holdout-access-marker", triple.holdoutAccessMarker],
    ["candidate", triple.candidate],
    ["evaluation-report", triple.evaluationReport],
    ["qualification-receipt", triple.qualificationReceipt],
  ]) {
    await stageForecastAdjustmentEvidenceObject(evidenceRoot, kind, value);
    await stageRedundantEvidenceObject(
      evidenceRoot,
      "independent_content_addressed_copy",
      kind,
      value,
    );
  }

  const hashes = {
    candidateArtifactSha256: triple.candidate.candidateArtifactSha256,
    evaluationReportSha256: triple.evaluationReport.evaluationReportSha256,
    qualificationReceiptSha256:
      triple.qualificationReceipt.qualificationReceiptSha256,
  };
  const candidateName = `sha256-${hashes.candidateArtifactSha256}.json`;
  const primaryCandidate = join(
    evidenceRoot,
    "staging",
    "candidate",
    candidateName,
  );
  const redundantCandidate = join(
    evidenceRoot,
    "independent-copy",
    "candidate",
    candidateName,
  );
  await rm(redundantCandidate);
  await link(primaryCandidate, redundantCandidate);
  await assert.rejects(
    promoteForecastAdjustmentEvidenceAtRoot(evidenceRoot, hashes),
    /hard-link/u,
  );
  await rm(redundantCandidate);
  await copyFile(primaryCandidate, redundantCandidate);
  assert.equal(
    (await promoteForecastAdjustmentEvidenceAtRoot(evidenceRoot, hashes)).state,
    "promoted",
  );
  assert.deepEqual(
    await verifyForecastAdjustmentEvidenceAtRoot(evidenceRoot, {
      qualificationReceiptSha256: hashes.qualificationReceiptSha256,
    }),
    {
      ...hashes,
      contractVersion: "forecast-adjustment-evidence-result/v1",
      state: "verified",
    },
  );
  const bundleRoot = await mkdtemp(join(tmpdir(), "weather-bundle-staging-"));
  const staged = await stageForecastAdjustmentRuntimeBundleAtRoot(
    evidenceRoot,
    bundleRoot,
    hashes,
  );
  assert.equal(
    staged.outputPath,
    join(bundleRoot, `sha256-${staged.bundleSha256}.json`),
  );
  assert.match(await readFile(staged.outputPath, "utf8"), /runtime-bundle\/v1/u);
  await rm(join(evidenceRoot, "ledger.jsonl"));
  await assert.rejects(
    verifyForecastAdjustmentEvidenceAtRoot(evidenceRoot, {
      qualificationReceiptSha256: hashes.qualificationReceiptSha256,
    }),
    /ledger/u,
  );
});

test("sufficient local training requires durable retention", () => {
  assert.doesNotThrow(() =>
    assertDurableTrainingRetention({
      retentionVerified: false,
      state: "insufficient_data",
    }),
  );
  assert.throws(
    () =>
      assertDurableTrainingRetention({
        retentionVerified: false,
        state: "sufficient",
      }),
    /durable external retention/u,
  );
});

test("evidence reads reject an intermediate directory symlink outside the root", async () => {
  const evidenceRoot = await mkdtemp(join(tmpdir(), "weather-evidence-link-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "weather-evidence-outside-"));
  const triple = await createQualifiedFixture(evidenceRoot);
  await stageEvidenceRedundancyAttestation(evidenceRoot, triple.attestation);

  // stage the complete graph before replacing one directory
  for (const [kind, value] of [
    ["snapshot-manifest", triple.snapshotManifest],
    ["development-report", triple.developmentReport],
    ["preregistration", triple.preregistration],
    ["holdout-access-marker", triple.holdoutAccessMarker],
    ["candidate", triple.candidate],
    ["evaluation-report", triple.evaluationReport],
    ["qualification-receipt", triple.qualificationReceipt],
  ]) {
    await stageForecastAdjustmentEvidenceObject(evidenceRoot, kind, value);
    await stageRedundantEvidenceObject(
      evidenceRoot,
      "independent_content_addressed_copy",
      kind,
      value,
    );
  }

  const candidateName =
    `sha256-${triple.candidate.candidateArtifactSha256}.json`;
  const candidateDirectory = join(evidenceRoot, "staging", "candidate");
  const outsideDirectory = join(outsideRoot, "candidate");
  await mkdir(outsideDirectory);
  await copyFile(
    join(candidateDirectory, candidateName),
    join(outsideDirectory, candidateName),
  );
  await rm(candidateDirectory, { recursive: true });
  await symlink(outsideDirectory, candidateDirectory, "dir");
  const ledgerBefore = await readFile(join(evidenceRoot, "ledger.jsonl"), "utf8");

  await assert.rejects(
    promoteForecastAdjustmentEvidenceAtRoot(evidenceRoot, {
      candidateArtifactSha256: triple.candidate.candidateArtifactSha256,
      evaluationReportSha256: triple.evaluationReport.evaluationReportSha256,
      qualificationReceiptSha256:
        triple.qualificationReceipt.qualificationReceiptSha256,
    }),
    /noncanonical|escapes/u,
  );
  assert.equal(
    await readFile(join(evidenceRoot, "ledger.jsonl"), "utf8"),
    ledgerBefore,
  );
});
