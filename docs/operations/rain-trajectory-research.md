# Rain adjustment: forecast trajectory tendencies

## Frozen next hypothesis

The capacity experiment failed thirteen of the unchanged 49 gates. Reweighting
training or selecting tree counts did not resolve the accuracy, seasonal-volume
and detection tradeoff. Pressure and prior-cycle inputs produced the clearest
earlier feature improvement, so this experiment tests another small, physically
interpretable source of forecast context rather than a new calibration sweep.

Add exactly six predictors to the original 95-feature hurdle model: for each of
forecast relative humidity, cloud cover and wind speed, use the change from
source lead `L−3` to `L` and from `L` to `L+3`, where `L=8+h` and `h` is the
1–23-hour decision-relative horizon. Every value comes from the **same original
initialized forecast run**. Later forecast valid times are not later observations
or later issued runs; the entire profile is assumed available at initialization
plus eight hours under the existing simulated-availability contract.

The original byte-bound ECMWF source already retains these variables. No new
acquisition, cohort substitution or wind-direction estimate is introduced. Compute
differences in source float64 then cast to float32. Preserve the original 95
columns exactly, preserve nulls as missing features and retain every row. Do not
select feature subsets after seeing results.

Use the original uniform equal-date/hour/vintage training weights, 160 rounds,
three binary heads and wet-only gamma head, with all other native parameters
unchanged. Keep the exact outer fit, 90-day calibration, embargo and evaluation
windows. Apply the unchanged uniform event calibration, nesting safety and hurdle
category calibration to the newly fitted heads. This is **not** the failed decay
or nested-capacity learner.

Only `hurdleTrajectory` is selectable. The original hurdle (`hurdleOriginal`) and
all eleven recency arms remain unchanged controls. The evaluator keeps all 49
checks, including the original ordinal heavy-skill requirement. New native heads
may change event calls, so their empirical safety is not guaranteed by design.

## Evidence boundary

September 2025–August 2026 remains consumed development data. Repeated experiments
do not restore independence. A development pass would require a separately frozen
fresh-data confirmation and real receipt-time evidence before production
qualification. The source lacks actual historical forecast issue receipts; the
eight-hour availability delay is simulated. No production change is authorized
by a development-only result.

The parent input envelope is the independently verified, encrypted original
hurdle experiment, not a mutable best-candidate pointer. The new source freeze,
101-column feature artifact, monthly boosters/states, predictions and failed
outcomes are retained separately. Capacity and all earlier results remain intact.

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-hurdle-20260913-v1"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-trajectory-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-hurdle-20260913/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_trajectory.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_trajectory.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/test_rain_trajectory.py
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Run native jobs with one numerical thread and the established CPU/memory limits.
Private datasets and model artifacts remain outside Git. The live forecast is
unchanged: <https://weather.ballydidean.farm/forecast>.

## Development result

**Not selected: 39/49 checks pass and ten fail.** The six predictors are available
for 32,850 of 32,896 evaluation rows (99.86%); missing rows are retained.

| Model | MAE (mm/h) | Wet MAE | Heavy MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Six trajectory tendencies | 0.104011 | 0.751610 | 1.407757 | 1.213675 |
| Original hurdle | 0.103547 | 0.760097 | 1.422416 | 1.189117 |
| Unchanged ordinal | 0.104229 | 0.778934 | 1.464274 | 1.135528 |
| Recent raw-volume control | 0.102662 | 0.783990 | 1.594287 | 1.024530 |

Heavy-event detection improves: POD at 1 mm/h is 0.485957 and at 2.5 mm/h is
0.186475. The candidate passes all three overall event-safety checks and the
unchanged ordinal heavy-skill retention check. Those improvements do not offset
worse average error than the original hurdle or excessive forecast volume.
Seasonal volume ratios are winter 1.422361, spring 0.967074, summer 0.889581 and
autumn 1.298628. Spring/summer wet detection and summer intensity still fail.

Failed checks: `beatsVolumeScale`, `annualVolumeBalanced`, `seasonDJFVolume`,
`seasonJJAWetHeavy`, `seasonJJADetection`, `seasonMAMDetection`, `seasonSONVolume`,
`beatsSameWindowVolumeScale`, `beatsRecentVolumeScale`, `seasonalBalanceImproves`.

This result supports investigating calibration staleness but is not a qualified
model or evidence of independent generalization. No production change was made.

### Verification and retained identities

Independent replay reproduced all 101 feature columns over 73,744 paired rows,
48 exact native booster hashes, twelve monthly states, all 32,896 predictions
and all 49 gates. The fixed evaluator reports **FAIL with no proof errors**.
All **348 rain tests** pass, including sixteen new producer/helper/verifier tests.
Targeted Ruff, AST and whitespace checks pass. All ten prior experiment source
freezes and retained review files remain unchanged. Application sources are
unchanged; the earlier same-turn full workspace check remains applicable.

- Freeze: `2f7d1192e6416fed633482a96ac280f1d8a5ae3853d754068bb0302663906efd`
- Report: `abb5a01dba8d1fe9bfba9ab74077c84185a0a9a5e4420212b187ca1ab824a0ea`
- Predictions: `39add05775a4701025f43aef15fd66eec9a53d21375fdf93bd873ecfd4e80ff2`
- Verifier: `2b36b0317ccc3295fa79bf9088e42ecdbbf6ddf22d679a4cb6ab7873130d57af`

The first replay receipt remains retained alongside a second exact replay after
comment-only verifier changes. Final receipts are under
`.omx/evidence/rain-trajectory-20260913/`. Private models, data and failed outcomes
are retained using the existing local encrypted backup recipient; no remote
backup or independent evaluation is claimed.

## Next preregistered direction

Test daily rolling recalibration with these fixed native models and the same
90-day window and seven-day embargo. This addresses calibration staleness without
changing training, predictors, scalar bounds or event rules. Later same-month
labels may enter only after maturing through the embargo: the next experiment is
prequential development evaluation, not an untouched monthly holdout.
