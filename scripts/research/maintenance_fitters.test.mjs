import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const python = join(homedir(), ".weather/research-runtimes/xgboost-cpu-3.4.1/bin/python3");
const numericalRuntimeRequired = { skip: !existsSync(python)
  ? "requires the existing workstation NumPy 2.5.3/XGBoost 3.4.1 runtime" : false };

// use the existing pinned numerical runtime for actual fitter tests
function run(source) {
  return JSON.parse(execFileSync(existsSync(python) ? python : "python3", ["-c", source], { cwd: root,
    env: { ...process.env, PYTHONPATH: join(root, "scripts/research"),
      OMP_NUM_THREADS: "1", OPENBLAS_NUM_THREADS: "1", MKL_NUM_THREADS: "1" },
    encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024 }));
}

// actual coefficient fits must run even when no confirmation is opened
test("monthly temperature fits both real arms without confirmation or approval", numericalRuntimeRequired, () => {
  const result = run(`
import datetime as dt,json,math
import temperature_refresh as refresh
from pathlib import Path
incumbent=json.loads(refresh.INCUMBENT_PATH.read_text())['model']
def rows(start,days):
 output=[]
 for day in range(days):
  initialized=start+dt.timedelta(days=day)
  for lead in range(7,19):
   valid=initialized+dt.timedelta(hours=lead)
   stamp=refresh.format_instant
   row={'key':stamp(initialized)+':'+str(lead),'cohort':'ecmwf_single_run_hindcast',
    'runInitializedAt':stamp(initialized),'validAt':stamp(valid),
    'modelCycle':'50r1' if initialized>=dt.datetime(2026,5,12,6,tzinfo=dt.timezone.utc) else '49r1',
    'modelLeadHours':lead,
    'operationalHorizonHours':lead-6,'rawTemperatureC':10+math.sin(day/30),
    'actualTemperatureC':9+math.sin(day/30),'rawRelativeHumidityPercent':80,'rawWindSpeedMps':3,
    'evidenceClass':'development','sourceReceiptAt':stamp(initialized+dt.timedelta(hours=6)),
    'targetMaxReceiptAt':stamp(valid+dt.timedelta(hours=7))}
   row['state']={'cohort':'ecmwf_single_run_hindcast','supported':False,'n24':0,'n72':0,'localDates':0,
    'b24C':None,'b72C':None,'mad72C':None,'sourceKeys':[],
    'maximumSourceRunInitializedAt':None,'maximumSourceValidAt':None,
    'targetRunInitializedAt':stamp(initialized),'windowEndValidAt':stamp(initialized-dt.timedelta(hours=7))}
   output.append(row)
 return output
payload={'contractVersion':'temperature-maintenance-fit-input/v2','month':'2026-10',
 'trainingRows':rows(dt.datetime(2025,11,1,tzinfo=dt.timezone.utc),120),
 'developmentRows':rows(dt.datetime(2026,4,1,tzinfo=dt.timezone.utc),90),'incumbentModel':incumbent}
result=refresh.fit_monthly_temperature(payload)
print(json.dumps({'state':result['state'],'arms':result['arms'],'confirmationOpened':result['confirmationOpened'],
 'servingChanged':result['servingChanged'],'model':result['model']}))
`);
  assert.equal(result.confirmationOpened, false);
  assert.equal(result.servingChanged, false);
  for (const arm of Object.values(result.arms)) {
    assert.equal(arm.fitReceipt.trainingRows, 1_440);
    assert.equal(arm.fitReceipt.trainingDates, 120);
    assert.equal(arm.fitReceipt.strengthRefitted, false);
    assert.match(arm.fitReceipt.modelSha256, /^[a-f0-9]{64}$/u);
    assert.equal(arm.fallbackCount, 0);
  }
  assert.ok(["no_candidate", "development_candidate"].includes(result.state));
  if (result.model !== null) {
    assert.equal(result.model.contractVersion, "temperature-permanent-model/v1");
    assert.equal(result.model.directCoefficients.length, 35);
    assert.equal(result.model.adaptiveCoefficients.length, 49);
  }
});

// a due-month replay cannot acquire later targets or undeclared experiments
test("monthly fitters reject reserved, duplicate and post-cutoff training inputs", () => {
  const result = run(`
import json,temperature_refresh as temp,rain_refresh as rain
row={'key':'same','validAt':'2026-09-25T12:00:00.000Z','sourceReceiptAt':'2026-09-25T12:00:00.000Z',
 'targetMaxReceiptAt':'2026-09-25T12:00:00.000Z','evidenceClass':'development','actualTemperatureC':10}
rejected=[]
for payload in ({'contractVersion':'temperature-maintenance-fit-input/v2','month':'2026-10',
 'trainingRows':[row],'developmentRows':[],'incumbentModel':{}},):
 try: temp.fit_monthly_temperature(payload);rejected.append(False)
 except ValueError: rejected.append(True)
for changed in (dict(row,evidenceClass='prospective_receipt'),row):
 try: rain.validate_rows([changed],'2026-10');rejected.append(False)
 except ValueError: rejected.append(True)
print(json.dumps(rejected))`);
  assert.deepEqual(result, [true, true, true]);
});

// retain the approved ninety-day window and fit all four heads before screening
test("monthly rain preserves sixty-date support and fits the approved ninety-day window", numericalRuntimeRequired, () => {
  const result = run(`
import datetime as dt,json,tempfile
from pathlib import Path
import rain_refresh as refresh
from rain_wind_features import FEATURE_NAMES
rows=[]
start=dt.datetime(2025,11,1,tzinfo=dt.timezone.utc)
stamp=lambda value:value.isoformat(timespec='milliseconds').replace('+00:00','Z')
for day in range(295):
 for hour in range(0,24,3):
  valid=start+dt.timedelta(days=day,hours=hour)
  rows.append({'key':stamp(valid),'validAt':stamp(valid),'runInitializedAt':stamp(valid-dt.timedelta(hours=9)),
   'sourceReceiptAt':stamp(valid-dt.timedelta(hours=1)), 'targetMaxReceiptAt':stamp(valid+dt.timedelta(hours=1)),
   'evidenceClass':'development','features':[1.]*107,'rawTargetHourTemperatureC':10.,
   'raw':.5,'actual':[0.,.4,1.5,3.][hour//3%4]})
with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
 result=refresh.fit_monthly_rain({'contractVersion':'rain-maintenance-fit-input/v2','month':'2026-09',
  'featureNames':list(FEATURE_NAMES),'trainingRows':rows,'developmentRows':[]},Path(directory))
 files=list(Path(directory).rglob('*.json'))
 print(json.dumps({'state':result['state'],'reason':result['reason'],'supported':result['fitState']['supported'],
  'files':len(files),'confirmationOpened':result['confirmationOpened'],
  'calibrationDays':result['calibrationDays'],'support':result['fitState']['support'],
  'heads':result['fitState']['model']['heads'] if result['fitState']['model'] else None}))
`);
  assert.equal(result.state, "no_candidate");
  assert.equal(result.reason, "insufficient_development");
  assert.equal(result.confirmationOpened, false);
  assert.equal(result.calibrationDays, 90);
  assert.equal(result.supported, true);
  assert.ok(result.support.calibration.dates >= 60);
  assert.equal(result.files, 4);
  assert.ok(Object.values(result.heads).every((head) => head.reason === "fitted"));
});

test("rain v3 validates and screens one annual source population without legacy padding", numericalRuntimeRequired, () => {
  const result = run(`
import datetime as dt,hashlib,json,numpy as np
import rain_refresh as refresh
stamp=lambda value:value.isoformat(timespec='milliseconds').replace('+00:00','Z')
start=dt.datetime(2025,11,24,tzinfo=dt.timezone.utc);end=dt.datetime(2026,11,24,tzinfo=dt.timezone.utc)
first=int((start.timestamp()/3600-31)//6*6);members=[]
# enumerate the target-valid issuance halo
for run_hour in range(first,int(end.timestamp()//3600)-9+1,6):
 run=dt.datetime.fromtimestamp(run_hour*3600,dt.timezone.utc);issued=run+dt.timedelta(hours=8)
 # retain every original source lead
 for lead in range(9,32):
  valid=run+dt.timedelta(hours=lead)
  # omit only targets outside the annual interval
  if not start<=valid<end: continue
  index=len(members);members.append({'issuedAt':stamp(issued),'key':stamp(run)+'/'+stamp(valid),
   'modelLeadHours':lead,'operationalHorizonHours':lead-8,'phaseEligible':index==0,
   'sourceMemberSha256':'a'*64,'sourceReceiptSha256':'b'*64,
   'targetAvailable':index==0,'validAt':stamp(valid)})
proof={'contractVersion':'rain-maintenance-development-population/v3','cycleHours':[0,6,12,18],
 'developmentEndAt':stamp(end),'developmentStartAt':stamp(start),'eligibleRowCount':1,
 'excludedColdRowCount':len(members)-1,'expectedRowCount':len(members),'missingSourceRowCount':0,
 'missingTargetRowCount':0,'observedRowCount':len(members),'operationalHorizonHours':list(range(1,24)),
 'populationMemberRootSha256':refresh.canonical_hash(sorted([item['sourceMemberSha256'] for item in members])),
 'populationReceiptRootSha256':refresh.canonical_hash(['b'*64]),
 'populationSha256':refresh.canonical_hash(members),'sourceModelLeadHours':list(range(9,32)),
 'sourcePopulation':members}
refresh.validate_development_population(proof,[{'key':members[0]['key']}])
rejected=False
try: refresh.validate_development_population({**proof,'missingSourceRowCount':1},[{'key':members[0]['key']}])
except ValueError: rejected=True
selected=members[0];raw=.5
row={'actual':.4,'raw':raw,'rawTargetHourTemperatureC':10.,'operationalHorizonHours':selected['operationalHorizonHours'],
 'key':selected['key'],'runInitializedAt':selected['key'].split('/')[0],'validAt':selected['validAt'],
 'persistencePrediction':None,'sourceRowSha256':'a'*64,'targetRowSha256':'c'*64,'gaugeCount':12}
row['evaluationRow']=refresh.historical_evaluation_row(row,.45,np.asarray([.8,.5,.2]),
 {'legacy':1.,'recent':1.,'sameWindow':1.})
projected={name:(np.asarray([.45]),np.asarray([[.8,.5,.2]])) for name in refresh.GRID}
screen=refresh.screen_grid([row],projected,proof)
print(json.dumps({'count':len(members),'developmentRows':screen[refresh.GRID[0]]['gateReport']['developmentRows'],
 'productionEligible':screen[refresh.GRID[0]]['gateReport']['productionEligible'],'rejected':rejected}))
`);
  assert.equal(result.count, 365 * 4 * 23);
  assert.equal(result.developmentRows, 1);
  assert.equal(result.productionEligible, false);
  assert.equal(result.rejected, true);
});

// a shorter observed calibration population must not weaken the sixty-date minimum
test("rain refit refuses fifty-nine calibration dates even with enough hourly labels", numericalRuntimeRequired, () => {
  const result = run(`
import datetime as dt,json,tempfile,numpy as np
from pathlib import Path
import rain_refresh as refresh,rain_wind as wind
_,_,_,bounds=refresh.maintenance_month_masks({'hour':np.asarray([],dtype=np.int64),'initialized':np.asarray([],dtype=np.int64)},'2026-09')
start=int(dt.datetime(2025,11,1,tzinfo=dt.timezone.utc).timestamp()//3600)
stop=bounds['calibrationMaximumValidHourExclusive']
hours=np.concatenate((np.arange(start,bounds['trainingMaximumValidHourExclusive']),np.arange(stop-59*24,stop)))
actual=np.resize(np.asarray([0.,.4,1.5,3.]),len(hours))
data={'hour':hours,'initialized':hours-9,'actual':actual,'raw':np.full(len(hours),.5)}
with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
 _,_,state=wind.fit_month(Path(directory),data,np.ones((len(hours),107),dtype=np.float32),'2026-09',np.empty(0),masks=refresh.maintenance_month_masks(data,'2026-09'))
 print(json.dumps({'supported':state['supported'],'counts':state['support']['calibration'],
  'effective':state['effectiveSupport'],'files':len(list(Path(directory).rglob('*.json'))),
  'minimumDates':wind.POLICY['calibrationSupport']['dates']}))
`);
  assert.equal(result.minimumDates, 60);
  assert.equal(result.counts.dates, 59);
  assert.ok(result.counts.hours >= 500);
  assert.ok(result.counts.wetDates >= 5);
  assert.ok(result.counts.wetHours >= 20);
  assert.ok(result.effective.effectiveDates >= 30);
  assert.equal(result.supported, false);
  assert.equal(result.files, 0);
});

// the reused numerical helper still fits four real heads when support is available
test("rain native numerical core writes four real newly fitted 160-round heads", numericalRuntimeRequired, () => {
  const result = run(`
import json,tempfile,numpy as np
from pathlib import Path
import rain_context as context
from rain_wind_features import FEATURE_NAMES
hours=np.arange(24*200,24*260,dtype=np.int64)
actual=np.asarray([0.,.4,1.5,3.]*(len(hours)//4))
features=np.ones((len(hours),107),dtype=np.float32)
with tempfile.TemporaryDirectory(dir='/dev/shm') as directory:
 _,state=context.fit_ordinal(features,actual,hours,Path(directory),list(FEATURE_NAMES))
 print(json.dumps({'state':state,'files':len(list(Path(directory).glob('*.json')))}))
`);
  assert.equal(result.files, 4);
  assert.equal(result.state.rounds, 160);
  assert.equal(result.state.featureNames.length, 107);
  assert.ok(Object.values(result.state.heads).every((head) => head.reason === "fitted"));
});

// numerical monthly masks stay identical to the retained policy and both embargos
test("rain maintenance masks preserve ninety-day calibration and the legacy training floor", numericalRuntimeRequired, () => {
  const result = run(`
import json,numpy as np,rain_refresh as refresh,rain_search as search
hours=np.arange(24*19000,24*20800,dtype=np.int64)
data={'hour':hours,'initialized':hours-9}
fit,calibration,evaluation,bounds=refresh.maintenance_month_masks(data,'2026-10')
legacy=search.month_masks(data,'2026-10')
print(json.dumps({'bounds':bounds,'same':all(np.array_equal(left,right) for left,right in zip((fit,calibration,evaluation),legacy[:3]))}))`);
  assert.equal(result.same, true);
  const { bounds } = result;
  assert.equal(bounds.maintenanceCalibrationDays, 90);
  assert.equal(bounds.legacyCalibrationDays, 90);
  assert.equal(bounds.calibrationMaximumValidHourExclusive - bounds.calibrationStartHour, 90 * 24);
  assert.equal(bounds.calibrationStartHour - bounds.trainingMaximumValidHourExclusive, 7 * 24);
  assert.equal(bounds.decisionStartHour - bounds.calibrationMaximumValidHourExclusive, 7 * 24);
});

// the finite grid cannot silently become a Cartesian or probability-product search
test("rain grid exposes only the seven preregistered independent projections", () => {
  const result = run(`import json,rain_refresh as refresh
print(json.dumps({'grid':list(refresh.GRID),'policy':refresh.POLICY}))`);
  assert.equal(result.grid.length, 7);
  assert.deepEqual(result.grid, ["R0_exact_refit", "R1_winter_scale_0_90", "R2_winter_scale_0_95",
    "R3_spring_wet_logit_plus_0_20", "R4_summer_wet_logit_plus_0_20", "R5_nested_cumulative_min", "R6_heavy_raw_blend_0_25"]);
  assert.equal(result.policy.confirmationOpened, false);
});

// the selected arm cannot weaken the original wet and heavy event safety
test("rain grid guard preserves heavy amounts and wet calls before scoring", numericalRuntimeRequired, () => {
  const result = run(`
import json,numpy as np,rain_refresh as refresh
raw=np.asarray([50.,.5,.05,0.])
projected=np.asarray([2.,0.,.2,0.])
print(json.dumps(refresh.guard_projection(raw,projected).tolist()))`);
  assert.deepEqual(result, [50, 0.1, 0.2, 0]);
});
