import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyEcmwfTemperatureMosRuntime } from "../../packages/forecast-adjustment/dist/temperature-mos-runtime.js";

const repository = resolve(import.meta.dirname, "../..");
const importModule = `import importlib.util,json,sys,datetime as dt
from pathlib import Path
spec=importlib.util.spec_from_file_location('refresh', 'scripts/research/temperature_refresh.py')
refresh=importlib.util.module_from_spec(spec)
spec.loader.exec_module(refresh)
payload=json.load(sys.stdin)
`;

// execute stdlib safety tests without adopting another numerical dependency
function python(source, payload = {}) {
  return JSON.parse(execFileSync("python3", ["-c", importModule + source], {
    cwd: repository,
    input: JSON.stringify(payload),
    encoding: "utf8",
  }));
}

// keep target chronology and dst-aware trailing selection fixed
test("temperature refresh filters target receipts before embargo and keeps trailing local dates", () => {
  const rows = [
    { key: "eligible", validAt: "2026-08-01T08:00:00.000Z", targetMaxReceiptAt: "2026-08-02T08:00:00.000Z", actualTemperatureC: 10 },
    { key: "late", validAt: "2026-08-01T08:00:00.000Z", targetMaxReceiptAt: "2026-09-24T07:00:00.000Z", actualTemperatureC: 10 },
    { key: "unknown", validAt: "2026-08-01T08:00:00.000Z", targetMaxReceiptAt: null, actualTemperatureC: 10 },
    { key: "old", validAt: "2025-09-30T08:00:00.000Z", targetMaxReceiptAt: "2025-10-01T08:00:00.000Z", actualTemperatureC: 10 },
  ];
  const result = python(`selected,cutoff,excluded=refresh.eligible_training_rows(payload['rows'],'2026-10','month_start_trailing365')
print(json.dumps({'keys':[row['key'] for row in selected],'cutoff':cutoff,'excluded':excluded}))`, { rows });
  assert.deepEqual(result.keys, ["eligible"]);
  assert.equal(result.cutoff, "2026-09-24T07:00:00.000Z");
  assert.deepEqual(result.excluded, { target_after_cutoff: 1, missing_target_receipt: 1, outside_trailing_window: 1 });
});

// prevent duplicate rows and missing receipts from acquiring fitting support
test("temperature refresh rejects duplicate training identities", () => {
  const row = { key: "same", validAt: "2026-08-01T08:00:00.000Z", targetMaxReceiptAt: null };
  const result = python(`try:
 refresh.eligible_training_rows(payload['rows'],'2026-10','month_start_expanding')
 print(json.dumps({'rejected':False}))
except ValueError:
 print(json.dumps({'rejected':True}))`, { rows: [row, row] });
  assert.equal(result.rejected, true);
});

// require a genuinely future interval at registration
test("temperature fresh confirmation cannot relabel already opened dates", () => {
  const result = python(`now=dt.datetime(2026,10,7,tzinfo=dt.timezone.utc)
value=refresh.registration('2026-11-01','2027-01-01','fresh_confirmation',now)
rejected=False
try:
 refresh.registration('2026-09-01','2026-09-30','fresh_confirmation',now)
except ValueError:
 rejected=True
value['arms'].append('unapproved_search')
policy_rejected=False
try:
 refresh.validate_registration(value)
except ValueError:
 policy_rejected=True
print(json.dumps({'pastRejected':rejected,'policyRejected':policy_rejected}))`);
  assert.deepEqual(result, { pastRejected: true, policyRejected: true });
});

// preserve immutable burn receipts and owner-only research writes
test("temperature confirmation burns before access and cannot be reopened", async () => {
  const base = join(repository, ".weather-data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(base, { recursive: true, mode: 0o700 }));
  await chmod(base, 0o700);
  const directory = await mkdtemp(join(base, "temperature-refresh-test-"));
  await chmod(directory, 0o700);
  const registrationPath = join(directory, "registration.json");

  try {
    const result = python(`value=refresh.registration('2027-11-01','2027-12-01','fresh_confirmation',dt.datetime(2026,10,7,tzinfo=dt.timezone.utc))
refresh.write_private(Path(payload['path']),value)
first=refresh.burn_confirmation(Path(payload['path']),value)
rejected=False
try:
 refresh.burn_confirmation(Path(payload['path']),value)
except FileExistsError:
 rejected=True
print(json.dumps({'first':first['preregistrationSha256'],'rejected':rejected}))`, { path: registrationPath });
    assert.match(result.first, /^[a-f0-9]{64}$/u);
    assert.equal(result.rejected, true);
    const burn = JSON.parse(await readFile(`${registrationPath}.burn.json`, "utf8"));
    assert.equal(burn.preregistrationSha256, result.first);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// deny all registry, setting and symlink publication paths
test("temperature refresh cannot publish near serving artifacts", async () => {
  const base = join(repository, ".weather-data");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(base, { recursive: true, mode: 0o700 }));
  await chmod(base, 0o700);
  const directory = await mkdtemp(join(base, "temperature-refresh-boundary-"));
  await chmod(directory, 0o700);
  const linked = join(directory, "linked");
  await symlink(join(repository, "config"), linked);

  try {
    const result = python(`rejected=[]
for path in payload['paths']:
 try:
  refresh.validate_private_write(Path(path))
  rejected.append(False)
 except (ValueError,FileNotFoundError):
  rejected.append(True)
print(json.dumps(rejected))`, { paths: [join(repository, "config/forecast-adjustments/unapproved.json"), join(linked, "unapproved.json")] });
    assert.deepEqual(result, [true, true]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// construct exact direct and adaptive runtime states
function runtimeRow(lead, adaptive) {
  const initializedAt = "2026-10-07T06:00:00.000Z";
  const validAt = new Date(Date.parse(initializedAt) + lead * 3_600_000).toISOString();
  return {
    cohort: "ecmwf_single_run_hindcast",
    key: `temperature-${lead}-${String(adaptive)}`,
    modelCycle: "50r1",
    modelLeadHours: lead,
    operationalHorizonHours: lead - 6,
    rawRelativeHumidityPercent: 70,
    rawTemperatureC: 12,
    rawWindSpeedMps: 2,
    runInitializedAt: initializedAt,
    validAt,
    state: {
      b24C: adaptive ? 1 : null,
      b72C: adaptive ? 0.5 : null,
      cohort: "ecmwf_single_run_hindcast",
      localDates: adaptive ? 3 : 0,
      mad72C: adaptive ? 0.2 : null,
      maximumSourceRunInitializedAt: adaptive ? "2026-10-06T12:00:00.000Z" : null,
      maximumSourceValidAt: adaptive ? "2026-10-06T23:00:00.000Z" : null,
      n24: adaptive ? 24 : 0,
      n72: adaptive ? 72 : 0,
      sourceKeys: adaptive ? Array.from({ length: 72 }, (_, index) => `source-${index}`) : [],
      supported: adaptive,
      targetRunInitializedAt: initializedAt,
      windowEndValidAt: "2026-10-06T23:00:00.000Z",
    },
  };
}

// prove every scored python workflow output uses unchanged native inference
test("temperature research matches delayed native branches, strength, caps and fallbacks", () => {
  const incumbent = JSON.parse(readFileSync(join(repository, "config/forecast-adjustments/ballydidean/temperature-canary-bundles/sha256-4d4e229b42823e53d2db062ec18c625bb2d2378a8a46d641fa95fabb59501b0e.json"), "utf8")).model;
  const rows = [];
  // cover every delayed lead and both inference branches
  for (const adaptive of [false, true]) {
    // include both outer-window failures around the supported leads
    for (let lead = 6; lead <= 19; lead += 1) {
      rows.push(runtimeRow(lead, adaptive));
    }
  }
  const results = python(`print(json.dumps(refresh.infer_rows(payload['rows'],{'frozen':payload['model']})))`, { rows, model: incumbent });
  const expected = rows.map((row) => applyEcmwfTemperatureMosRuntime({
    forecast: Object.fromEntries(Object.entries(row).filter(([key]) => key !== "state" && key !== "operationalHorizonHours")),
    model: incumbent,
    recentErrorState: row.state,
  }));
  assert.deepEqual(results, expected);
  assert.ok(results.some((result) => result.applied && result.branch === "direct"));
  assert.ok(results.some((result) => result.applied && result.branch === "adaptive"));
  assert.ok(results.some((result) => !result.applied && result.reason === "outside_assumed_delay6_next12"));
});

// preserve nested package provenance and native scoring support failures
test("temperature package adapter preserves receipt identity and matched baseline diagnostics", () => {
  const row = {
    ...runtimeRow(7, false),
    actualTemperatureC: 11,
    bestMatchRawTemperatureC: 10,
    recentErrorState: runtimeRow(7, false).state,
    scoredPairMetadata: {
      key: "paired-hour",
      rowIdentity: "source-revision",
      targetKey: "target-revision",
      targetIdentity: "target-revision",
      vintageKey: "source-vintage",
      validAt: "2026-10-07T13:00:00.000Z",
      localDate: "2026-10-07",
      horizonHours: 1,
      evidenceClass: "prospective_receipt",
      provenanceComplete: false,
      sourceReceiptAt: "2026-10-07T12:00:00.000Z",
      firstEdgeCommittedAt: "2026-10-07T12:30:00.000Z",
    },
  };
  const result = python(`rows=refresh.normalized_package_rows(payload['rows'])
card=refresh.family_card(rows,[{'predictionTemperatureC':11.5,'applied':True,'reason':None}],{'targetCutoffAt':'2026-10-08T00:00:00.000Z'})
print(json.dumps({'card':card,'state':rows[0]['state'],'identity':rows[0]['rowIdentity']}))`, { rows: [row] });
  assert.equal(result.identity, "source-revision");
  assert.deepEqual(result.state, row.recentErrorState);
  assert.equal(result.card.supportState, "insufficient");
  assert.equal(result.card.qualificationState, "pending_support");
  assert.equal(result.card.metrics.rawMae, null);
  assert.equal(result.card.support.eventCount, 1);
  assert.equal(result.card.bestMatchDiagnostic.bestMatchRawMae, 1);
  assert.equal(result.card.bestMatchDiagnostic.sourceRawMae, 1);
  assert.equal(result.card.bestMatchDiagnostic.sourceAdjustedMae, 0.5);
  assert.equal(result.card.slices.length, 4);
  assert.ok(result.card.slices.every((slice) => slice.metrics.rawMae === null));
});

// keep an empty postdeploy package honest and closed
test("temperature empty package emits pending support without invented observations", () => {
  const card = python(`print(json.dumps(refresh.family_card([],[],{'targetCutoffAt':'2026-10-08T00:00:00.000Z'})))`);
  assert.equal(card.support.eventCount, 0);
  assert.equal(card.metrics.rawMae, null);
  assert.equal(card.bestMatchDiagnostic, null);
  assert.equal(card.comparisonState, "unscored");
});

// prefer recorded incumbent values without pooling source reconstructions
test("temperature incumbent separates actual issued values and ignores other bundles", () => {
  const result = python(`identity=refresh.INCUMBENT_PATH.stem.removeprefix('sha256-')
rows=[{'evidenceClass':'retrospective_counterfactual','recordedRuntimeResult':None},
 {'evidenceClass':'prospective_receipt','recordedRuntimeResult':{'applied':True,'servingBundleSha256':identity,'predictionTemperatureC':7,'reasonCode':None,'scoredPairMetadata':{'evidenceClass':'as_issued'}}},
 {'evidenceClass':'prospective_receipt','recordedRuntimeResult':{'applied':True,'servingBundleSha256':'0'*64}}]
population,predictions,excluded=refresh.incumbent_population(rows,[{'predictionTemperatureC':99}]*3)
print(json.dumps({'classes':[row['evidenceClass'] for row in population],'predictions':predictions,'excluded':excluded}))`);
  assert.deepEqual(result.classes, ["as_issued"]);
  assert.equal(result.predictions[0].predictionTemperatureC, 7);
  assert.equal(result.excluded, 2);
});

// retain source replays and public fallbacks without manufacturing issued skill
test("temperature companions separate evidence classes and reconcile omitted public fallback counts", () => {
  const rows = ["prospective_receipt", "retrospective_counterfactual"].map((evidenceClass, index) => ({
    ...runtimeRow(7, false), key: `companion-${index}`, actualTemperatureC: 11,
    evidenceClass, provenanceComplete: true,
    sourceReceiptAt: "2026-10-07T12:00:00.000Z",
    firstEdgeCommittedAt: evidenceClass === "prospective_receipt" ? "2026-10-07T12:30:00.000Z" : null,
  }));
  const result = python(`results=[{'predictionTemperatureC':11.5,'applied':True,'reason':None}]*2
populations=refresh.source_reconstruction_reports(payload['rows'],results,{'targetCutoffAt':'2026-10-08T00:00:00.000Z'})
card=populations[0]['family']
refresh.include_actual_serving_fallbacks(card,[{'state':'raw_fallback'},{'state':'disabled'}],{'missing_source':1,'canary_disabled':1})
print(json.dumps({'populations':populations,'card':card}))`, { rows });
  assert.deepEqual(result.populations.map((population) => population.evidenceClass), ["prospective_receipt", "retrospective_counterfactual"]);
  assert.ok(result.populations.every((population) => population.baseline === "ecmwf_source_run" && !population.qualificationEligible));
  assert.equal(result.card.support.exclusionReasons.actual_serving_best_match_fallback, 2);
  assert.equal(result.card.support.fallbackCount, 2);
  assert.equal(result.card.support.gapCount, 2);
  assert.deepEqual(result.card.support.fallbackReasons, { missing_source: 1, canary_disabled: 1 });
  assert.equal(result.card.qualificationState, "pending_support");
  assert.equal(result.card.recommendation, "retain");
});

// reject a result before its filesystem allocation exceeds the fixed envelope
test("temperature result allocation refuses writes without removing prior evidence", async () => {
  const base = join(repository, ".weather-data");
  const directory = await mkdtemp(join(base, "temperature-result-bound-"));
  await chmod(directory, 0o700);
  try {
    const result = python(`output=Path(payload['directory'])
refresh.MAX_RESULT_BYTES=4096
refresh.write_result(output,'first.json',{'retained':True})
rejected=False
try:
 refresh.write_result(output,'second.json',{'retained':True})
except ValueError:
 rejected=True
print(json.dumps({'rejected':rejected,'names':sorted(path.name for path in output.iterdir())}))`, { directory });
    assert.deepEqual(result, { rejected: true, names: ["first.json"] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// exercise the full command path while keeping package-loader fixtures explicit
test("temperature command retains every public fallback and binds disjoint training inputs", async () => {
  const directory = await mkdtemp(join(repository, ".weather-data/temperature-command-test-"));
  await chmod(directory, 0o700);
  try {
    const result = python(`import contextlib,io
directory=Path(payload['directory'])
policy=refresh.registration('2026-10-07','2026-10-07','retrospective_development',dt.datetime(2026,10,7,tzinfo=dt.timezone.utc))
refresh.write_private(directory/'policy.json',policy)
identity=refresh.INCUMBENT_PATH.stem.removeprefix('sha256-')
fallbacks=[{'servingIdentitySha256':bundle,'reasonCode':reason} for bundle,reason in [(identity,'prediction_invalid'),(None,'canary_disabled'),('0'*64,'source_identity_mismatch')]]
inputs={'localDateFrom':'2026-10-07','localDateTo':'2026-10-07','targetCutoffAt':'2026-10-08T00:00:00.000Z'}
calls=[]
def fixture_native(operation,**values):
 if operation=='policy':
  return refresh.POLICY
 if operation!='load':
  raise AssertionError('unexpected native operation')
 calls.append(values['options'])
 training=len(calls)==2
 return {'rows':[],'actualServingFallbacks':[] if training else fallbacks,'inputs':{**inputs,'localDateFrom':'2026-09-20','localDateTo':'2026-09-20'} if training else inputs}
refresh.native=fixture_native
sys.argv=['temperature_refresh.py','--preregistration',str(directory/'policy.json'),'--forecast-package',str(directory/'evaluation-forecast'),'--adjustment-package',str(directory/'evaluation-adjustment'),'--training-package',str(directory/'training-pair'),'--output',str(directory/'results')]
with contextlib.redirect_stdout(io.StringIO()):
 refresh.main()
companion=json.loads((directory/'results/actual-serving-best-match-fallbacks.json').read_text())
report=json.loads((directory/'results/report.json').read_text())
research=json.loads((directory/'results/research.json').read_text())
print(json.dumps({'companion':companion,'card':report['family'],'training':research['trainingSource'],'calls':calls}))`, { directory });
    assert.equal(result.companion.rows.length, 3);
    assert.deepEqual(result.companion.fallbackReasons, { prediction_invalid: 1, canary_disabled: 1, source_identity_mismatch: 1 });
    assert.equal(result.card.support.fallbackCount, 1);
    assert.equal(result.card.support.exclusionReasons.actual_serving_best_match_fallback, 1);
    assert.equal(result.card.qualificationState, "pending_support");
    assert.equal(result.training.kind, "verified_disjoint_package_pair");
    assert.equal(result.training.inputs.localDateTo, "2026-09-20");
    assert.equal(result.calls[1].forecastPackage, join(directory, "training-pair/forecast"));
    assert.equal(result.calls[1].adjustmentPackage, join(directory, "training-pair/adjustment"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
