import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { createRainHurdleWindPortableArtifactEvaluator } from "./adjustment-maintenance-runtime/forecast/rain-hurdle-wind.js";
import { adjustmentSha256, canonicalJsonBytes } from "./adjustment_plaintext_archive.mjs";
import { buildAdjustmentHistoricalFitProjection } from "./adjustment_historical_fit_assembler.mjs";
import { buildAdjustmentRainControlReference, buildAdjustmentRainHistoricalRows } from "./adjustment_rain_control_reference.mjs";
import { rainHistory, rainHistoryEpochWitness, rainHistoryTargetOccurrence,
  rainHistoryFeatureOccurrence } from "./fixtures/adjustment-rain-history.mjs";

const root = resolve(import.meta.dirname, "../..");
const python = join(homedir(), ".weather/research-runtimes/xgboost-cpu-3.4.1/bin/python3");
const numericalRuntime = { skip: !existsSync(python)
  ? "requires existing pinned NumPy 2.5.3/XGBoost 3.4.1 runtime" : false };

// execute actual existing numerical core without treating fixtures as model evidence
function numericalReport(extra = "") {
  const source = `
import datetime as dt,json,tempfile
from pathlib import Path
import rain_refresh as refresh
from rain_wind_features import FEATURE_NAMES
stamp=lambda value:value.isoformat(timespec='milliseconds').replace('+00:00','Z')
rows=[]
start=dt.datetime(2025,11,1,tzinfo=dt.timezone.utc)
for day in range(295):
 for hour in range(0,24,3):
  valid=start+dt.timedelta(days=day,hours=hour)
  rows.append({'key':stamp(valid),'validAt':stamp(valid),'runInitializedAt':stamp(valid-dt.timedelta(hours=9)),
   'sourceReceiptAt':stamp(valid-dt.timedelta(hours=1)),'targetMaxReceiptAt':stamp(valid+dt.timedelta(hours=1)),
   'evidenceClass':'development','features':[1.]*107,'rawTargetHourTemperatureC':10.,
   'raw':.5,'actual':[0.,.4,1.5,3.][hour//3%4]})
payload={'contractVersion':'rain-control-reference-fit-input/v1','month':'2026-09',
 'requestedAt':'2026-08-26T00:00:00.000Z','featureNames':list(FEATURE_NAMES),'trainingRows':rows}
${extra}
with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
 result=refresh.fit_rain_control_reference(payload,Path(directory),
  clock=lambda:dt.datetime(2026,8,26,1,tzinfo=dt.timezone.utc))
 print(json.dumps(result,sort_keys=True,separators=(',',':'),allow_nan=False))
`;
  return JSON.parse(execFileSync(python, ["-c", source], {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024,
    env: { ...process.env, PYTHONPATH: join(root, "scripts/research"),
      OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
  }));
}

// fit genuine native heads before the month without development or confirmation access
test("pre-month rain reference fits real retained controls and portable native parity", numericalRuntime, () => {
  const report = numericalReport();
  assert.equal(report.state, "supported");
  assert.equal(report.reason, "pre_month_reference");
  assert.equal(report.generatedAt, "2026-08-26T01:00:00.000Z");
  assert.equal(report.calibrationEndAt, "2026-08-25T00:00:00.000Z");
  assert.equal(report.calibrationStartAt, "2026-05-27T00:00:00.000Z");
  assert.equal(report.legacyCalibrationStartAt, "2026-07-11T00:00:00.000Z");
  assert.ok(report.support.trainingDates >= 180);
  assert.ok(report.support.calibrationDates >= 60);
  assert.ok(report.scales.legacy >= .5 && report.scales.legacy <= 2);
  const bytes = canonicalJsonBytes(report.ordinalArtifact);
  const evaluate = createRainHurdleWindPortableArtifactEvaluator(bytes.toString("utf8"), adjustmentSha256(bytes));
  // compare independent native arithmetic on synthetic values rather than private calibration rows
  for (const row of report.parityRows) {
    const actual = evaluate(Float32Array.from(row.features, (value) => value === null ? Number.NaN : value));
    assert.ok(Math.abs(actual.correctedPrecipitationMm - row.prediction) < 1e-5);
    for (const [index, name] of ["occurrenceProbabilityAtLeast0_1", "occurrenceProbabilityAtLeast1_0", "occurrenceProbabilityAtLeast2_5"].entries()) {
      assert.ok(Math.abs(actual[name] - row.probabilities[index]) < 1e-5);
    }
  }
});

// explicit support failure creates no fallback reference artifact
test("pre-month rain reference never invents heads for missing actual history", numericalRuntime, () => {
  const report = numericalReport("payload['trainingRows']=[]");
  assert.equal(report.state, "unsupported");
  assert.equal(report.ordinalArtifact, null);
  assert.equal(report.scales, null);
  assert.deepEqual(report.parityRows, []);
});

// past output cannot be stamped as a current successful reference
test("pre-month rain reference refuses late completion and post-cutoff receipts", numericalRuntime, () => {
  const source = `
import datetime as dt,json,tempfile
from pathlib import Path
import rain_refresh as refresh
from rain_wind_features import FEATURE_NAMES
payload={'contractVersion':'rain-control-reference-fit-input/v1','month':'2026-09',
 'requestedAt':'2026-08-26T00:00:00.000Z','featureNames':list(FEATURE_NAMES),'trainingRows':[]}
rejected=[]
with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
 for changed,clock in ((payload,lambda:dt.datetime(2026,9,1,tzinfo=dt.timezone.utc)),
  ({**payload,'requestedAt':'2026-08-24T23:59:59.999Z'},lambda:dt.datetime(2026,8,26,tzinfo=dt.timezone.utc))):
  try: refresh.fit_rain_control_reference(changed,Path(directory),clock=clock);rejected.append(False)
  except ValueError: rejected.append(True)
print(json.dumps(rejected))
`;
  const rejected = JSON.parse(execFileSync(python, ["-c", source], { cwd: root, encoding: "utf8",
    env: { ...process.env, PYTHONPATH: join(root, "scripts/research"), OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1" } }));
  assert.deepEqual(rejected, [true, true]);
});

// construct real parser-verified archive material without claiming production custody
function historicalProjection(history = rainHistory()) {
  return buildAdjustmentHistoricalFitProjection({ epochWitness: rainHistoryEpochWitness(),
    family: "rain", fitMonth: "2026-12", history });
}

// actual twelve-gauge rows and native receipt maxima supply historical training targets
test("rain historical join binds actual raw gauge targets and consumed native identities", () => {
  const projection = historicalProjection();
  assert.equal(projection.classCounts.target_revision, 12);
  assert.equal(projection.classCounts.rain_gate_input, 23);
  const value = buildAdjustmentRainHistoricalRows({ dueMonth: "2026-12",
    epochWitness: rainHistoryEpochWitness(), projection });
  assert.equal(value.rows.length, 1);
  assert.equal(value.populationMembers.length, 23);
  assert.equal(value.populationMembers[0].modelLeadHours, 9);
  assert.equal(value.populationMembers[0].operationalHorizonHours, 1);
  assert.equal(value.populationMembers[0].issuedAt, "2026-10-11T20:00:00.000Z");
  const row = value.rows[0];
  assert.equal(row.gaugeCount, 12);
  assert.equal(row.modelLeadHours, 19);
  assert.equal(row.operationalHorizonHours, 11);
  assert.equal(row.persistencePrediction, null);
  assert.ok(Math.abs(row.actual - .6) < 1e-12);
  assert.equal(row.sourceReceiptAt, "2026-10-11T20:01:00.000Z");
  assert.equal(row.targetMaxReceiptAt, "2026-10-12T07:15:00.000Z");
  assert.equal(row.features.length, 107);
  const members = projection.projectionMembers.filter((member) => member.projectionKind === "target_revision" ||
    member.row.validAt === row.validAt);
  assert.equal(value.sourceMemberRootSha256, adjustmentSha256(canonicalJsonBytes(
    members.map((member) => member.memberSha256).sort())));
  assert.equal(value.sourceReceiptRootSha256, adjustmentSha256(canonicalJsonBytes(
    [...new Set(members.map((member) => member.receipt.receiptSha256))].sort())));
  assert.equal(row.sourceRowSha256, members.find(
    (member) => member.projectionKind === "rain_gate_input").memberSha256);
  assert.equal(row.targetRowSha256, adjustmentSha256(canonicalJsonBytes(
    members.filter((member) => member.projectionKind === "target_revision")
      .map((member) => member.memberSha256).sort())));
});

// actual worker completion need not equal the nominal model decision instant
test("rain historical join accepts genuine later pre-target commits and signed-zero predictors", () => {
  const occurrence = rainHistoryFeatureOccurrence({ logicalReceivedAt: "2026-10-11T20:05:00.000Z",
    receiptAt: "2026-10-11T20:06:00.000Z", signedZero: true });
  const projection = historicalProjection(rainHistory([occurrence, rainHistoryTargetOccurrence()]));
  const value = buildAdjustmentRainHistoricalRows({ dueMonth: "2026-12",
    epochWitness: rainHistoryEpochWitness(), projection });
  assert.equal(value.rows.length, 1);
  assert.equal(value.rows[0].sourceReceiptAt, "2026-10-11T20:06:00.000Z");
  assert.equal(Object.is(value.rows[0].features[20], -0), false);
  assert.equal(value.rows[0].features[20], 0);
  assert.doesNotThrow(() => canonicalJsonBytes(value.rows));
  assert.equal(value.populationMembers[0].issuedAt, "2026-10-11T20:00:00.000Z");
});

// no later receipt may repair the earliest target group's cutoff or content
test("rain historical targets retain the first native group and reject partial populations", () => {
  const history = rainHistory();
  history.occurrences.push(rainHistoryTargetOccurrence({ ordinal: 20, completedAt: "2026-10-12T07:20:00.000Z",
    receiptAt: "2026-10-12T07:25:00.000Z" }));
  const projection = historicalProjection(history);
  const value = buildAdjustmentRainHistoricalRows({ dueMonth: "2026-12",
    epochWitness: rainHistoryEpochWitness(), projection });
  assert.equal(value.rows[0].targetMaxReceiptAt, "2026-10-12T07:15:00.000Z");
  const partial = { ...projection, projectionMembers: projection.projectionMembers.filter(
    (member) => member.memberSha256 !== projection.projectionMembers.find(
      (member) => member.projectionKind === "target_revision").memberSha256) };
  partial.memberRootSha256 = adjustmentSha256(canonicalJsonBytes(
    partial.projectionMembers.map((member) => member.memberSha256).sort()));
  assert.throws(() => buildAdjustmentRainHistoricalRows({ dueMonth: "2026-12",
    epochWitness: rainHistoryEpochWitness(), projection: partial }), /target group differs/u);
});

// the last real grouped receipt controls original cutoff admission for every gauge
test("historical fit excludes a twelve-source group if any receipt crosses the cutoff", () => {
  const history = rainHistory();
  history.occurrences[1].receipts[11].archiveCommittedAt = "2026-11-24T00:00:00.000Z";
  const projection = historicalProjection(history);
  assert.equal(projection.classCounts.target_revision, 0);
  assert.equal(buildAdjustmentRainHistoricalRows({ dueMonth: "2026-12",
    epochWitness: rainHistoryEpochWitness(), projection }).rows.length, 0);
});

// numerical support failures never create a control reference or publication authority
test("rain control composition sends exact earlier-only rows and preserves unsupported state", async () => {
  const projection = historicalProjection();
  const witness = rainHistoryEpochWitness();
  let request;
  const runFit = async (value) => {
    request = value;
    const report = { calibrationEndAt: "2026-11-24T00:00:00.000Z",
      calibrationStartAt: "2026-08-26T00:00:00.000Z", contractVersion: "rain-control-reference-fit/v1",
      generatedAt: "2026-11-25T00:01:00.000Z", legacyCalibrationStartAt: "2026-10-10T00:00:00.000Z",
      modelMonth: "2026-12", ordinalArtifact: null, parityRows: [], reason: "insufficient_control_support",
      scales: null, state: "unsupported", support: null, trainingMaximumValidAt: null };
    const candidateJson = canonicalJsonBytes(report).toString("utf8");
    return { candidateJson, candidateSha256: adjustmentSha256(Buffer.from(candidateJson)),
      codeSnapshotSha256: "a".repeat(64), contractVersion: "adjustment-fit-sandbox/v1", family: "rain",
      inputSnapshotSha256: "b".repeat(64), runtimeReadinessSha256: "c".repeat(64), stderr: "", stdout: "" };
  };
  const result = await buildAdjustmentRainControlReference({ dueMonth: "2026-12", epochWitness: witness,
    generatedAt: "2026-11-25T00:00:00.000Z", projection }, { runFit });
  assert.equal(result, null);
  assert.deepEqual(Object.keys(request), ["input"]);
  assert.equal(request.input.contractVersion, "rain-control-reference-fit-input/v1");
  assert.equal(request.input.trainingRows.length, 1);
  assert.equal(request.input.featureNames.length, 107);
  await assert.rejects(buildAdjustmentRainControlReference({ dueMonth: "2026-12", epochWitness: witness,
    generatedAt: "2026-12-01T00:00:00.000Z", projection }, { runFit }), /chronology differs/u);
});
