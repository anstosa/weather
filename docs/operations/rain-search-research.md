# Rain adjustment: fixed multi-family development search

## Status and data boundary

This is offline research, not a deployed rain correction. September 2025 through
August 2026 has already been consumed by prior model development. All results on
these dates are **development results**, never an independent holdout. The
event-guard and signed-residual experiments remain intact.

This batch compares three prespecified candidates on the same retained ECMWF
forecast and local-gauge rows:

1. **Ordinal amount:** three binary exceedance heads at 0.1, 1 and 2.5 mm/h plus a
   positive, wet-only gamma amount model.
2. **Moderate rain weighting:** direct Tweedie regression with dry/wet/heavy label
   weights 1/2/4.
3. **Strong rain weighting:** direct Tweedie regression with weights 1/3/6.

Each uses the existing 77-feature input contract, depth-three trees, 160 rounds
and the pinned single-threaded XGBoost 3.4.1 runtime. Costs are normalized to
preserve total training weight. Native fits use equal date/hour/vintage weights.
The amount forecast is 25% raw plus 75% learned, clipped to 0–30 mm/h.

## Chronology, calibration and fallback

For each target month, training stops 104 days before the month begins.
Calibration covers the 90 days from day −97 through day −7, excluding its upper
boundary. Both training/calibration and calibration/evaluation have seven-day
gaps. Evaluation remains indexed by forecast decision month, not label selection.

Global fit support requires the inherited training minima. Calibration requires
60 dates, 500 hours, five wet dates and 20 wet hours. Unsupported model-months
retain raw predictions and remain in every score; they do not count as model
support. Conditional gamma support must agree with global wet-training support.

The ordinal heads choose the largest earlier-calibration probability cutoff
meeting raw recall plus five percentage points, capped at one. A cutoff also
must meet raw false-alarm ratio plus 0.05 and raw critical-success index minus
0.01. Insufficient event support or a failed safety check uses raw event calls
at that threshold. Highest-called categories enforce nesting. The final nested
calibration calls must also preserve raw recall and the same FAR/CSI bounds at
every threshold; otherwise all three heads use raw calls, without searching
head subsets. Final bands are
exact zero, [0.1, 1), [1, 2.5) and [2.5, 30] mm/h. These deterministic categories
are not a claim that probability forecasts are calibrated.

A bounded scalar in [0.1, 3] is solved on each candidate's **final projected
amounts**, using earlier calibration labels only. Unattainable means use the
nearest bounded endpoint and are explicitly reported as saturated, including
their remaining residual; they are not reported as exact matches.

Controls are unchanged raw, zero, persistence and the original 45-day volume
scaling, plus a new 90-day volume-scaling control using the same bounded solver.

## Selection and evidence

Every candidate faces all 44 existing residual-experiment gates unchanged,
plus a requirement to beat the same-window 90-day volume baseline: **45 gates**.
This includes overall errors, wet/heavy errors, seasonal volume and support,
three lead bands, event recall/skill/false alarms and 6/12/23-hour accumulations.
Selection considers only complete gate-passers, ordered by overall MAE then
name. If none passes, the selected candidate is `null`; the best-looking failure
is not promoted.

`rain_search.py prepare` verifies inherited acquisition/retention identities and
freezes the candidate matrix, policy, input-schema identity and exact source
bytes before fitting. `run` writes new monthly native models, calibration states,
predictions and complete candidate scores to a new private experiment root.
The separate verifier refits models and recalculates predictions and screens.
Synthetic tests exercise chronology, costs, calibration saturation, category
boundaries, unsupported fallback and all-gates selection.

No production configuration, API, database or forecast bundle is changed.
Any future qualification requires a separately frozen prospective protocol and
genuinely new observations with verified availability timestamps.
The retrospective archive simulates conservative eight-hour forecast and
one-hour observation delays; it does not prove historical receipt times.

## Completed development result

All three candidates were fitted for all 12 months: 72 native models total,
scored on 32,896 paired forecasts spanning 8,641 distinct hours, 366 target dates
and 131 wet dates. All three failed the fixed screen; **none was selected**.

| Candidate/control | MAE (mm/h) | Improvement vs raw | Heavy-hour MAE (mm/h) | Volume ratio | Failed gates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw | 0.126445 | — | 1.472778 | 1.541668 | — |
| Original volume scaling | 0.103392 | 18.23% | 1.576329 | 1.051359 | — |
| 90-day volume scaling | 0.103198 | 18.39% | 1.602447 | 1.025845 | — |
| Ordinal amount | 0.107134 | 15.27% | 1.553507 | 1.115314 | 12/45 |
| Moderate weighting | 0.102884 | 18.63% | 1.591279 | 1.032927 | 10/45 |
| Strong weighting | 0.102691 | 18.79% | 1.613484 | 1.010279 | 11/45 |

The direct weighted models narrowly beat both simple scaling controls and
improved wet-hour MAE, but heavy-hour errors worsened by 8.05% and 9.55%.
Their recall at 1 mm/h fell to 14.56% and 11.74%, versus raw 34.71%; neither
detected the observed 2.5 mm/h events. Better aggregate MAE is insufficient.

Ordinal recall improved at all three thresholds: 85.14%, 38.37% and 20.19%,
versus raw 81.08%, 34.71% and 10.20%. Nevertheless, its wet-event safety,
heavy-hour error, seasonal checks and simple-baseline comparison failed.
Its final-output scalar saturated at the lower bound in four months, recorded
explicitly rather than treated as successful exact calibration. No composite
nesting fallback was needed on these development months.

All three retained winter overprediction and spring underprediction. These
failure modes remain visible in the full reports rather than being averaged
away by the improved annual volume ratios.

Independent verification refitted and matched all 48 ordinal heads and 24
weighted boosters, then reproduced every monthly state, prediction, support
flag, metric, gate and the null selection. This verifies implementation and
reporting, **not independent predictive generalization**. The 178-test rain
suite, targeted static checks and full `npm run check` passed.

Private evidence identity:

- Freeze SHA-256: `7d5f5553644fc1580b41e712ac293e38fa79341494a8b40b54f67bcd10b3532f`
- Report SHA-256: `015fdcb747747ff9852f8b72f7be7a19dcf41b46963d2bb69b51e028355e55f4`
- Prediction SHA-256: `599daccfb51e9b7f514c9c4f6bf5d001f2fdff438b9a316e7bce466092edf30a`

The batch is retained locally with encrypted round-trip verification; no remote
archive copy, model promotion or deployment is performed.

## Execution

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-sub24-20260909"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-search-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-sub24-20260909/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_search.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_search.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/verify_rain_search.py "$ROOT" /path/to/new-verification.json
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Private input, model and row-level prediction artifacts stay outside Git. The
public forecast remains at <https://weather.ballydidean.farm/forecast> with rain
unadjusted until a separately qualified model is released.
