import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalJsonBytes,
  canonicalObjectSha256,
  createForecastAdjustmentCandidate,
  verifyForecastAdjustmentCandidate,
} from "../dist/index.js";

import { createCandidateFixture } from "./evidence-fixtures.mjs";

test("candidate is canonical, immutable, and excludes holdout results", () => {
  const candidate = createCandidateFixture();
  const bytes = canonicalJsonBytes(candidate);
  verifyForecastAdjustmentCandidate(candidate);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.coefficients), true);
  assert.equal(
    candidate.forecastIdentity.adapterVersion,
    "open-meteo-forecast-daily/v4",
  );
  assert.equal(
    candidate.forecastIdentity.contractEpoch,
    "legacy-v4/9d26d9c46dcaacc422c28e854327b11cd710625e092110786010f0687a100d83",
  );
  assert.equal(candidate.forecastIdentity.dataset, "forecast");
  assert.equal(candidate.forecastIdentity.upstreamModel, "best_match");
  assert.equal("evaluationReportSha256" in candidate, false);
  assert.equal("holdoutAccessMarkerSha256" in candidate, false);
  assert.throws(() => {
    candidate.coefficients[0].coefficient = 9;
  }, TypeError);
  assert.equal(canonicalJsonBytes(candidate), bytes);
});

test("candidate rejects cascading rehashes of frozen lineage provenance", () => {
  const candidate = createCandidateFixture();
  const forgedEpoch = {
    ...candidate,
    forecastIdentity: {
      ...candidate.forecastIdentity,
      contractEpoch: "legacy-v4/forged",
    },
  };
  forgedEpoch.candidateArtifactSha256 = canonicalObjectSha256(
    forgedEpoch,
    "candidateArtifactSha256",
  );
  assert.throws(
    () => verifyForecastAdjustmentCandidate(forgedEpoch),
    /forecast identity is not canonical/u,
  );

  const forgedSpatial = {
    ...candidate,
    trainingProvenance: {
      ...candidate.trainingProvenance,
      spatialWeightSha256: "f".repeat(64),
    },
  };
  forgedSpatial.candidateArtifactSha256 = canonicalObjectSha256(
    forgedSpatial,
    "candidateArtifactSha256",
  );
  assert.throws(
    () => verifyForecastAdjustmentCandidate(forgedSpatial),
    /training provenance is not canonical/u,
  );
});

test("candidate hash changes with fitted coefficients and rejects extra input", () => {
  const candidate = createCandidateFixture();
  const changed = createForecastAdjustmentCandidate({
    coefficients: [
      { ...candidate.coefficients[0], coefficient: 2.5 },
    ],
    developmentReportSha256: candidate.developmentReportSha256,
    enabledMetricBands: candidate.enabledMetricBands,
    evaluationEpochId: candidate.evaluationEpochId,
    exportManifestSha256: candidate.exportManifestSha256,
    finalTrainingCutoff: candidate.finalTrainingCutoff,
    forecastIdentity: candidate.forecastIdentity,
    runtimeFingerprint: candidate.runtimeFingerprint,
    trainingEnvelopes: candidate.trainingEnvelopes,
    trainingProvenance: candidate.trainingProvenance,
  });
  assert.notEqual(changed.candidateArtifactSha256, candidate.candidateArtifactSha256);
  assert.throws(
    () =>
      createForecastAdjustmentCandidate({
        coefficients: candidate.coefficients,
        developmentReportSha256: candidate.developmentReportSha256,
        enabledMetricBands: candidate.enabledMetricBands,
        evaluationEpochId: candidate.evaluationEpochId,
        evaluationReport: {},
        exportManifestSha256: candidate.exportManifestSha256,
        finalTrainingCutoff: candidate.finalTrainingCutoff,
        forecastIdentity: candidate.forecastIdentity,
        runtimeFingerprint: candidate.runtimeFingerprint,
        trainingEnvelopes: candidate.trainingEnvelopes,
        trainingProvenance: candidate.trainingProvenance,
      }),
    /unexpected field/u,
  );
});
