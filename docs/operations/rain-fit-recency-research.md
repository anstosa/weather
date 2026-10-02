# Rain adjustment: half-year training decay

## Frozen next hypothesis

The prior hurdle/category experiment improved heavy-hour amounts but failed wet
recall and seasonal volume. Its pre-month calibration and later evaluation had
large forecast-category prevalence shifts. Another redistribution of existing
raw-volume or weighted-context totals would inherit those baselines' winter and
spring volume failures. The next hypothesis therefore changes **native model
training weights**, not the fixed acceptance gates or calibration algorithm.

For each of the same twelve development decision months, retain all original
fit rows and the exact training/calibration/evaluation chronology. Fit the same
three 0.1/1/2.5 mm/h logistic heads and wet-only gamma head, using all 95 context
features, existing XGBoost parameters, automatic intercepts and 160 rounds.
Multiply the old equal-date/hour/vintage fit weights by:

`2 ** (-ageInUtcDates / 183)`

Age is measured from the last UTC date before the exclusive fit cutoff. Normalize
to the original number of fitted rows. Compute gamma's date/hour/vintage weights
on its wet-only fit population, apply the same date decay, and normalize to its
wet-row count. Every old fit row retains positive mass. There is no rolling
window cutoff, half-life sweep, early stopping or capacity change. The fixed
half-year timescale discounts stale regimes while retaining prior-season examples.

Apply the **unchanged hurdle calibration helper** to the new native scores:
earlier 90-day uniform event calibration and nesting safety, wet-cutoff CSI
selection, then 30-day-recency global and supported per-category amount scales.
Existing embargoes, support minima, fallback and final category projection remain.
New heavy heads may change heavy-event calls; their skill must still pass the
unchanged empirical retention gate against the original ordinal reference.

`hurdleDecay` is the sole selectable candidate. All eleven original recency arms
and the previous hurdle candidate (`hurdleOriginal`) remain exact, nonselectable
controls. The inherited original data/source freeze is retained only as an input
lineage envelope; `fit-freeze.json` separately identifies the new training policy,
sources and result. Report construction reuses the unchanged score/gate machinery
through a collision-free candidate alias, then records the new experiment metadata.

All 32,896 September 2025–August 2026 rows remain **consumed development data**.
All 49 fixed gates, independent native refit/replay, provenance and regression
checks are mandatory. A failure remains retained and can inform a separately
frozen next hypothesis, not retuning of this one. Passing development checks
would still not establish fresh-data qualification or permit deployment.

## Closed development result

**Rejected: 11 of 49 gates failed.** All 48 new native heads fitted, all twelve
months retained support, and all 32,896 development rows and twelve prior
forecast controls remained unchanged.

| Forecast | MAE (mm/h) | Wet-hour MAE | Heavy-hour MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Previous hurdle | 0.103547 | 0.760097 | 1.422416 | 1.189117 |
| **Half-year training decay** | **0.103020** | **0.770801** | **1.443968** | **1.180256** |
| Original context ordinal | 0.104229 | 0.778934 | 1.464274 | 1.135528 |
| Recent raw-volume scaling | 0.102662 | 0.783990 | 1.594287 | 1.024530 |

Average error improved 0.51% versus the matched hurdle control and now beat the
original 45-day and 90-day raw-volume baselines, but not recent raw scaling.
Heavy-hour amount error remained below the original ordinal reference, while
1 mm/h POD fell from 47.71% to 44.70%. At 2.5 mm/h POD rose from 16.02% to
18.65%. This tradeoff failed the unchanged heavy-skill retention gate.

Seasonal volume ratios were winter 1.369, spring 0.990, summer 0.778 and autumn
1.257. Winter, summer and autumn failed the original [0.8, 1.2] bounds. Wet-event
detection still failed overall and in winter, spring and summer; summer
wet/heavy error also remained too high. The complete failed list is:

`event0.1Safety`, `seasonDJFVolume`, `seasonDJFDetection`, `seasonJJAVolume`,
`seasonJJAWetHeavy`, `seasonJJADetection`, `seasonMAMDetection`,
`seasonSONVolume`, `beatsRecentVolumeScale`, `seasonalBalanceImproves`,
`heavySkillRetained`.

Independent verification reconstructed all 95 features over 73,744 rows from
3,301 source profiles, refitted all 48 new native heads to identical hashes,
matched every monthly state and prediction, and independently checked all 49
gates. The goal evaluator reproduced eleven failures with no proof errors.
All 316 rain tests and targeted static checks passed. The preceding full
`npm run check` remained applicable to unchanged application code; only Python
research files and research documentation changed in this experiment. All eight
earlier experiments' frozen sources and retained review files remained unchanged.

The evidence is locally encrypted with verified streaming roundtrip retention.
No candidate was selected or deployed. The next separately frozen hypothesis
tests tree-count selection using an embargoed validation slice **inside the fit
window**, not another half-life, cutoff or amount-scalar sweep.

Evidence identities:

- Freeze: `461afc54f989e8851fb7511cf00a71e0f1d5af220d5942fb45680f809e777b8a`
- Report: `f1b8716bd9b69e6a7e93e8a49dbdf1c2f2882f5c226482e4cdb2d8c49f2af1c6`
- Predictions: `bbe710cc8a2489ee5a003e5239980fc9ff5c5b1fa02293d02cfdf62c53856373`

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-hurdle-20260913-v1"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-fit-recency-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-hurdle-20260913/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_fit_recency.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_fit_recency.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/test_rain_fit_recency.py
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Use bounded single-thread CPU jobs in the pinned XGBoost 3.4.1 runtime. Private
models and data remain outside Git. No production or user-visible application
change is included. Live forecast: <https://weather.ballydidean.farm/forecast>.
