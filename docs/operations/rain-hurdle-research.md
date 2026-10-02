# Rain adjustment: wet-cutoff and category-amount recalibration

## Preregistered hypothesis

The amount-only recency ablation preserved the improved heavy-event calls, but
fixed wet calls could not repair its autumn detection and summer recall failures.
This experiment therefore changes only the wet cutoff and amount calibration.
It reuses all 95 context features and the exact retained native models. No tree
training, new acquisition, cohort change or production write is performed.

September 2025–August 2026 remains **consumed development data**, not an
independent holdout. The previous recency result and all failures remain intact.

For each of the same twelve evaluation months:

1. Preserve the original uniform-calibrated 1 and 2.5 mm/h event rules exactly.
2. On the earlier 90-day calibration window, ending seven days before the month,
   choose the 0.1 mm/h cutoff maximizing uniform date/hour/vintage-weighted CSI
   of the **final nested calls**. Require POD at least raw and FAR at most
   raw +0.05. Resolve ties by the highest cutoff; preserve the original wet rule
   if support or feasibility fails. No evaluation outcome enters this choice.
3. Fit the same 30-day-recency-weighted global scalar on the new final categories.
4. Within each forecast wet category, fit a separate [0.1, 3] scalar to that
   category's recent-weighted observed mean, including its dry outcomes. Require
   at least 20 observed wet hours over five wet dates in that forecast category;
   otherwise use the global recent scalar. Preserve the disjoint category bounds
   and explicit endpoint saturation. Do not rescale globally afterward.

The only selectable candidate is `hurdleCategory`. Every previous recency arm
is an unchanged control. Both heavy-event call masks must remain bit-identical
to `ordinal90`; heavy-hour amount error remains an empirical gate, not a claim
implied by preserving calls. Support failures preserve complete forecasts rather
than dropping rows.

## Fixed goal evaluator

All **49 recency gates** remain unchanged, including comparisons with raw,
persistence, both raw-volume calibration baselines, original ordinal error,
every season/lead band/accumulation and retention of heavy-event skill. The
ongoing performance goal additionally requires byte-bound provenance, independent
prediction replay and regression evidence. A verified failing implementation is
still a failed model; controls cannot be selected after reading outcomes.

All 32,896 development rows must match the retained reference population exactly.
The evaluator recomputes scores from predictions, compares controls bit-for-bit,
and rejects stale or absent verification and regression receipts. Preregistration
and this machine check do not undo repeated use of the development year.

The recursive research goal may proceed to another separately frozen hypothesis
after a failure. It cannot relax these checks or authorize production promotion.
A development pass still needs a separate fresh-data protocol and real forecast
and observation receipt times; historical availability here remains simulated.

## Closed development result

**Rejected: 10 of 49 gates failed.** All twelve months were supported, all
32,896 rows remained, and all eleven prior arms matched their retained forecasts
exactly. No candidate was selected.

| Forecast | MAE (mm/h) | Wet-hour MAE | Heavy-hour MAE | Volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Original context ordinal | 0.104229 | 0.778934 | 1.464274 | 1.135528 |
| Previous recent amount only | 0.103465 | 0.778994 | 1.463976 | 1.123054 |
| **Hurdle/category recalibration** | **0.103547** | **0.760097** | **1.422416** | **1.189117** |
| Recent raw-volume scaling | 0.102662 | 0.783990 | 1.594287 | 1.024530 |

Heavy-hour error improved by 2.86% relative to the original ordinal model, with
both heavy-event call masks unchanged. Spring wet/heavy error and autumn wet
detection passed, but overall wet detection and spring/summer recall regressed.
Wet POD was 0.761 versus raw 0.822 in spring and 0.641 versus raw 0.723 in summer.
Winter volume ratio worsened to 1.428; autumn remained high at 1.227. Average
error remained worse than the volume-scaling baselines. The full failed list is:

`beatsVolumeScale`, `event0.1Safety`, `seasonDJFVolume`, `seasonJJAWetHeavy`,
`seasonJJADetection`, `seasonMAMDetection`, `seasonSONVolume`,
`beatsSameWindowVolumeScale`, `beatsRecentVolumeScale`, `seasonalBalanceImproves`.

Post-result diagnostics found large forecast-category prevalence shifts between
the earlier calibration and evaluation periods. Wet-call row prevalence rose
from 3.7% to 22.5% in October, 8.7% to 37.0% in November, and 15.9% to 34.9% in
December. Current category floors still permit the *seasonal* volume gates
mathematically, but some individual months exceed 1.2 even at their floors.
These are consumed-development diagnostics, not independently established causes.
The next separately frozen hypothesis changes training/ranking rather than
retuning this experiment's cutoffs, category support or scalars.

Independent verification reconstructed 3,301 profiles and all 73,744 × 95 feature
values, refitted 60 native boosters to identical hashes, reproduced all twelve
new calibration states and predictions, and independently checked every score
partition and all 49 gates. The goal evaluator reproduced the ten failures with
no remaining proof errors. All 303 rain tests, targeted static checks and full
`npm run check` passed. All seven earlier experiments' frozen producer and
retained review bytes remained unchanged. Private evidence is retained locally
with encrypted streaming roundtrip verification; no production change occurred.

Evidence identities:

- Freeze: `a4d25b08fbc9b19303d8193ef8e53ad2a86207d36ed491ea5d2ee6717d3ef7e1`
- Report: `34d46077d62b8f9eca69f57578a73e50ad5a685e10deba6ff7fe1645e4d266d2`
- Predictions: `a9dbc08b3499857213acfc2c67670ad110a5b3200b0ed48c54faaba9a03b93a9`

## Reproduction

```sh
PY="$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python"
SOURCE="$HOME/.weather/research-work/weather-moisture-research-rain-sub24-20260909"
ROOT="$HOME/.weather/research-work/weather-moisture-research-rain-hurdle-20260913-v1"
RECEIPT="$HOME/.weather/model-evidence/rain-sub24-20260909/retention-receipt.json"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_hurdle.py prepare "$SOURCE" "$ROOT" --retention-receipt "$RECEIPT"
PYTHONDONTWRITEBYTECODE=1 "$PY" scripts/research/rain_hurdle.py run "$ROOT"
PYTHONDONTWRITEBYTECODE=1 "$PY" -m unittest discover -s scripts/research -p 'test_*rain*.py'
```

Use the pinned CPU runtime with one numerical thread and bounded resources.
Private data, models, predictions and receipts remain outside Git. No local
application services are needed. The public forecast remains unchanged:
<https://weather.ballydidean.farm/forecast>.
