# Rain adjustment: conditional raw-rain shape constraint

## One bounded exploratory hypothesis

The wind model remains the development lead at 43 of 49 gates. The subsequent
probability-bin mean failed 13 gates and substantially reduced heavy-event
detection. Test one remaining learner-shape hypothesis, not another calibration
or threshold search: constrain the native response to be nondecreasing in
`rawRain` and its deterministic duplicate `log1pRawRain`, holding other inputs
fixed.

This is a weak, falsifiable prior, not a claim that local rain must always track
grid rainfall. The existing wind trees rarely used these two columns, and other
rain-history and trajectory predictors remain unconstrained. A coordinate-wise
constraint therefore does not guarantee monotonicity along an actual evolving
forecast trajectory. Both duplicate columns are constrained so either cannot
evade the prior through the other. Refitting can change the whole learned tree
structure, so existing split importance alone does not prove a zero effect.

Only `hurdleWindMonotoneRaw` is selectable. Preserve all 14 wind arms as unchanged
controls, with its primary renamed `windOriginal`. The parent is the frozen wind
experiment, not the failed probability-bin model. Keep the 107 feature columns,
all 73,744 paired rows, all 32,896 development forecasts, all 49 gates, and the
same source-availability and qualification limitations.

## Exact learner change

Fit 48 new native models: three binary logistic heads and one wet-only Gamma
head for each of 12 months. Keep the original uniform date/hour/vintage fit
weights, wet-only rebalanced Gamma weights, expanding fit window, 160 rounds,
depth three, histogram learner, automatic intercept, seed and single-thread
runtime. Keep `max_bin` at its existing default of 256.

Add exactly one parameter: a 107-entry `monotone_constraints` vector whose only
nonzero entries are `+1` at indices 5 (`rawRain`) and 6 (`log1pRawRain`). Apply the
same vector to all four objectives. Do not alter any remaining feature, weight,
fit parameter, early-stopping rule or amount model.

Use the original wind model's 90-day calibration, seven-day embargo, support
checks, uniform event calibration, nesting safety and recent hurdle-category
amount projection. Unsupported months retain the unchanged `ordinal90` control
for every original row. This experiment does not use the soft-ordinal means or
log-odds offsets.

XGBoost documents positive monotonic constraints and warns that histogram
constraints can leave fewer valid splits and produce shallower trees. That risk
is accepted here without increasing the bin count or tuning another vector.
See the official [monotonic-constraint guide](https://xgboost.readthedocs.io/en/stable/tutorials/monotonic.html)
and [tree parameters](https://xgboost.readthedocs.io/en/stable/parameter.html).

## Verification and stopping boundary

Before any historical fit, test constraint order and both native objectives on
synthetic data. Verify coordinate-wise prediction behavior and model roundtrip
predictions. The pinned runtime preserves the constraint in the freshly trained
booster's configuration, but a model-only reload resets that training option.
Consequently, a reloaded configuration is not proof of constrained training.
Record the live fitted configuration, frozen parameter vector and model hash,
then independently refit all 48 models and compare exact serialized models.

Independently reconstruct the complete copied source and feature matrix, all
monthly fits/calibrations/states, every prediction and all 49 gates. Retain the
result regardless of failure. Do not run a second vector, bin-count, cutoff or
round-count experiment after inspecting this result.

If this bounded arm fails, stop this same-cohort tuning sequence and record the
remaining data/qualification work rather than searching indefinitely for a
lucky development pass. Even a pass here is exploratory: the repeatedly consumed
September 2025–August 2026 cohort is not an untouched evaluation. Separately
frozen receipt-backed fresh-data qualification is required before promotion.

No production change is included. The [live forecast](https://weather.ballydidean.farm/forecast)
is unchanged.

## Recorded development result

The constrained primary passed 43 of 49 gates, failing the same six as its
unconstrained wind parent. All 12 months met support requirements; all 48 new
native fits were independently reproduced exactly. The verifier reconstructed
the source, 107 features, monthly calibration states, 32,896 predictions and
all 49 gate results. The fixed evaluator returned `FAIL` with no proof errors.

| Metric | Wind parent | Constrained primary |
| --- | ---: | ---: |
| Hourly MAE, mm | 0.101821 | 0.102087 |
| Heavy-hour MAE, mm | 1.446627 | 1.442403 |
| Annual balanced volume ratio | 1.1463 | 1.1523 |
| Winter balanced volume ratio | 1.3955 | 1.3919 |
| Detection at 1 mm | 0.4168 | 0.4212 |
| Detection at 2.5 mm | 0.2175 | 0.2088 |

The failed gates are `seasonDJFVolume`, `seasonJJAWetHeavy`,
`seasonJJADetection`, `seasonMAMDetection`, `seasonalBalanceImproves` and
`heavySkillRetained`. Winter remains 39.2% too wet in the date-balanced metric,
outside the unchanged 0.8–1.2 range. Overall 1 mm detection remains below the
ordinal control's 0.4771. Small improvements in heavy-hour error and winter
volume do not outweigh the remaining failures or justify selecting this arm.

All 534 rain tests, the full workspace check, focused Ruff and AST checks
passed. The native run took 54.4 seconds; independent replay took 67.2 seconds.
The frozen evidence is under `.omx/evidence/rain-monotone-20260913/`; private
inputs and model files remain outside Git. Neither successful software tests
nor successful evidence retention mean that the model qualified.

## Next boundary

This closes the preregistered same-cohort tuning sequence. No model has passed
all 49 gates, and this result does not prove that a passing model is impossible.
The wind parent remains a research lead, not a selected or deployable model.

The next defensible work is a separately frozen prospective rain-data capture
and qualification protocol: retain as-issued forecast bodies, real receipt
times and complete local-gauge intervals before opening future labels. Preserve
causal feature replay, source identity, the safety thresholds and season/event
support requirements. A new data cohort must not silently replace the current
goal's pinned development population or be scored as its passing result.

The existing historical receipt limitations cannot be repaired by another
parameter search. Starting collection and obtaining a seasonally representative
fresh evaluation are separate milestones; the latter requires future weather
and adequate wet/heavy support, not merely a successful collection job.
