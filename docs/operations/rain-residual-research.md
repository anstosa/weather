# Signed rain-residual development experiment

## Prespecified scope

This is a new trained learner, not another replay of the Tweedie model or a
retuning of the closed [event-guard experiment](rain-event-guard-research.md).
It is rain-only, inactive, and restricted to consumed historical **development**
data. No humidity/pressure model, production forecast, collector or service is
changed. No independent evaluation is performed or scheduled.

The previous guard protected rain detection by preserving raw-heavy amounts,
but also preserved excessive winter rainfall. This experiment deliberately
allows the learner to lower raw-heavy forecasts and suppress false wet calls.
It must nevertheless preserve measured detection, CSI and false-alarm safety
on the complete development population. There is no guarantee that each
individual raw event survives.

## One frozen candidate

Twelve new monthly XGBoost `reg:squarederror` models learn the **signed error
`observed hourly rain − raw forecast rain`**. They use the original feature
schema, depth-three trees, 160 rounds, learning rate 0.04, regularization and
date/hour/vintage weights. `base_score=0`, one numerical thread and a fixed
seed are explicit. No positive-amount model or probability multiplier is used.

The uncalibrated amount is `clip(raw + 0.5 × learned residual, 0, 30)` mm/h.
A scalar in `[0.5, 2]` then calibrates the **final clipped** amount to the
date-balanced mean observation in the earlier 45-day calibration window. The
fit/calibration and calibration/evaluation boundaries retain their seven-day
embargoes. Calibration never sees an evaluation label.

The scalar solver records lower/upper attainable means, the observed target,
its support and its outcome. It prefers unit scale when sufficient, otherwise
uses 64 monotone bisection iterations. Absolute/relative numerical tolerances
are `1e-10` and `1e-8`; a target strictly outside the attainable range is not
rescued by tolerance. Flat/infeasible curves or insufficient support yield
**exact raw fallback**, with all rows retained in scoring.

Training requires 180 dates, 1,000 unique hours, 20 wet dates and 100 wet hours.
Calibration requires 20 dates, 300 unique hours, five wet dates and 20 wet
hours. Unsupported training produces no model; a trained but uncalibrated
state retains its model and diagnostic predictions, not an active correction.

Only `residualAmount` is eligible for screening. Raw, zero, persistence and
earlier-only raw volume scaling remain controls. `uncalibratedResidual` is a
fixed attribution diagnostic, not an alternative selected after results.

## Unchanged empirical safety

All 42 empirical loss, rain-volume, event, season, lead, accumulation and
support gates from the event-guard experiment remain unchanged. In particular,
the candidate must beat raw MAE by at least 5%, beat simple volume scaling,
not worsen wet-hour MAE, keep heavy-hour MAE within 5%, and not lower detection
probability at 0.1, 1 or 2.5 mm/h. Missing required metrics fail closed.

Only the two algorithm-specific promises of unchanged raw-heavy amounts and
preserved individual raw-wet calls are replaced. The new structural gates
require finite nonnegative predictions and at least 180 candidate-supported
dates including 20 wet dates. This is not permission to relax measured event
or intensity performance. Each unsupported raw-fallback row still counts
against the primary candidate's overall scores.

## Evidence and prospective limits

The decision period remains September 2025–August 2026, already consumed by
prior studies. This is seasonal development, never a newly independent test.
The original twelve-gauge network proxy, simulated initialization-plus-eight-hour
decision, lagged observation features and source-cohort limits are unchanged.
Current-era evidence after the May 2026 archive change is still sparse.

Preparation reuses the existing byte-bound input snapshot routine. Its
`freeze.json` is the inherited **input-schema** contract; the new learner is
separately frozen in `experiment-freeze.json`, binding the input-schema hash,
new policy and exact runtime sources. Original inputs, sources and results
are not edited. Native models, predictions and row-level material stay private.

A failed screen closes this candidate without retuning or selecting the
diagnostic arm. Even a development pass would require a separately frozen,
current-era prospective protocol with real receipt timestamps and causal
source availability before any production qualification. The conditional
earliest October 1 boundary is inherited, not a running or scheduled job.

## Reproduction

```sh
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/rain_residual.py prepare ORIGINAL_PRIVATE_SUB24_ROOT NEW_PRIVATE_ROOT \
  --retention-receipt ORIGINAL_RETENTION_RECEIPT_JSON
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/rain_residual.py run NEW_PRIVATE_ROOT
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/verify_rain_residual.py NEW_PRIVATE_ROOT NEW_VERIFICATION_JSON
```

The [live forecast](https://weather.ballydidean.farm/forecast) continues to use
unadjusted rain throughout this experiment.

## Result — September 13, 2026 UTC

**Rejected in development.** The new experiment was frozen at
`2026-09-13T01:04:55Z`, then all twelve monthly residual models were trained.
The replay retained 32,896 forecasts on 8,641 distinct hours, 366 target dates,
131 wet dates and 203 heavy hours. This was a new model fit, not a native
Tweedie replay, and there was no post-outcome retuning.

| Metric | Raw | Earlier-only volume scaling | Residual candidate |
| --- | ---: | ---: | ---: |
| Hourly MAE, mm/h | 0.126445 | 0.103392 | 0.112591 |
| Hourly RMSE, mm/h | 0.519372 | 0.437963 | 0.466091 |
| Observed-wet MAE, mm/h | 0.819612 | 0.784215 | 0.792854 |
| Observed-heavy MAE, mm/h | 1.472778 | 1.576329 | 1.540464 |
| Balanced volume ratio | 1.541668 | 1.051359 | 1.239145 |
| Wet-event detection | 81.08% | 70.48% | 75.05% |
| False-alarm ratio | 67.18% | 60.37% | 63.40% |

Overall MAE improves **10.96%** and observed-wet MAE improves **3.26%** versus
raw. Heavy-hour error increases **4.60%**, within the overall 5% allowance but
not enough to rescue failed seasonal and detection checks. Detection at
1 mm/h falls from **34.71% to 25.01%**; at 2.5 mm/h it falls from **10.20% to
5.73%**. Better average error and fewer false alarms do not erase those misses.
The candidate also loses to simple earlier-only volume scaling on MAE.

Eight monthly calibration states support 22,321 forecasts on 247 dates,
including 102 wet dates and 5,875 distinct hours. The remaining **10,575 rows
retain exact raw fallback** and are included in every aggregate score:

- September 2025 and August 2026 lack the required earlier wet calibration
  support.
- January and February 2026 have observed calibration means below the minimum
  achievable with the frozen scalar bounds. Their bounds are not widened
  after seeing this failure.

The balanced volume ratio remains **1.24 overall, 1.91 in winter and 0.75 in
spring**. It is a date/hour/vintage-balanced ratio, not an unweighted hydrologic
rainfall total. Thirteen of 44 gates fail: comparison with volume scaling,
annual volume, all three threshold-event checks, winter volume/detection,
summer intensity/detection, spring volume/intensity/detection and autumn
detection. The uncalibrated residual remains diagnostic-only; it was not
selected in place of the declared candidate.

Independent verification refitted all twelve boosters from signed training
labels and reproduced their exact native JSON hashes. It independently
reconstructed all 32,896 predictions, monthly support/scalar/fallback states,
scores, event diagnostics, accumulations and gates. The fixed candidate failed
development; the computation and its evidence passed verification.

The bounded training/replay took 8.28 seconds, approximately 245 MiB peak
resident memory and no swap. Aggregate evidence is under
`.omx/evidence/rain-residual-20260913/`; private source/model/prediction material
is under
`~/.weather/research-work/weather-moisture-research-rain-residual-20260913-v1/`.
No independent evaluation was opened, and no production rain adjustment was
activated.

All 148 rain-related Python tests, Ruff error checks, AST parsing and the full
workspace `npm run check` passed. Independent verifier source/runtime hashes
are retained separately from the producer freeze. Evidence retention uses
local private disk with the existing encryption recipient and decrypted
member-checksum verification; no evidence upload or service deployment is
part of this experiment. The previous event-guard source files and report
were independently checked unchanged.
