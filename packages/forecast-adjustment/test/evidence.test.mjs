import assert from "node:assert/strict";
import {
  copyFile,
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
  const redundancyRoot = await mkdtemp("/dev/shm/weather-evidence-redundancy-");
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
      redundancyRoot,
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
  await assert.rejects(
    promoteForecastAdjustmentEvidenceAtRoot(evidenceRoot, hashes),
    /distinct storage device/u,
  );
  assert.equal(
    (
      await promoteForecastAdjustmentEvidenceAtRoot(
        evidenceRoot,
        hashes,
        redundancyRoot,
      )
    ).state,
    "promoted",
  );
  assert.deepEqual(
    await verifyForecastAdjustmentEvidenceAtRoot(
      evidenceRoot,
      { qualificationReceiptSha256: hashes.qualificationReceiptSha256 },
      redundancyRoot,
    ),
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
    redundancyRoot,
  );
  assert.equal(
    staged.outputPath,
    join(bundleRoot, `sha256-${staged.bundleSha256}.json`),
  );
  assert.match(await readFile(staged.outputPath, "utf8"), /runtime-bundle\/v2/u);
  await rm(join(evidenceRoot, "ledger.jsonl"));
  await assert.rejects(
    verifyForecastAdjustmentEvidenceAtRoot(
      evidenceRoot,
      { qualificationReceiptSha256: hashes.qualificationReceiptSha256 },
      redundancyRoot,
    ),
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
  const redundancyRoot = await mkdtemp("/dev/shm/weather-evidence-link-redundancy-");
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
      redundancyRoot,
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
    promoteForecastAdjustmentEvidenceAtRoot(
      evidenceRoot,
      {
        candidateArtifactSha256: triple.candidate.candidateArtifactSha256,
        evaluationReportSha256: triple.evaluationReport.evaluationReportSha256,
        qualificationReceiptSha256:
          triple.qualificationReceipt.qualificationReceiptSha256,
      },
      redundancyRoot,
    ),
    /noncanonical|escapes/u,
  );
  assert.equal(
    await readFile(join(evidenceRoot, "ledger.jsonl"), "utf8"),
    ledgerBefore,
  );
});
