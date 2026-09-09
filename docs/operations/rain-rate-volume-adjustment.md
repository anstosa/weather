# Rain-rate volume continuation

## Scope

This research-only continuation preserves the [V1 rain-rate experiment](rain-rate-adjustment.md), including its input, models, four candidate predictions, targets, and native evaluation population. It does not change forecasts, deploy a model, fit humidity or pressure adjustments, or alter data-recovery jobs.

The target remains complete-hour liquid rain rate in mm/h. A **balanced volume ratio** is the ratio of date/hour/vintage-balanced means, not an unweighted hydrologic rainfall total. The same historical development period was already examined for V1; this continuation is not an independent holdout or accuracy qualification.

## Frozen experiment

Two predeclared arms supplement all four V1 candidates:

- **Volume-neutral guard (diagnostic):** match the earlier out-of-sample raw forecast's balanced mean.
- **Volume-calibrated guard (primary):** match the earlier out-of-sample observed balanced mean.

Neither arm is selected after examining outcomes. For scalar `s`, the calibration curve is the balanced mean of `intensity_guard(raw, min(500, s * tweedieBlend))`. Exactly dry raw forecasts remain zero; wet/heavy categories at 0.1, 1 and 2.5 mm/h remain unchanged. The observed-target arm can therefore compensate missed raw-zero rainfall by inflating other, raw-positive hours; it cannot repair missed storms.

Each target issue month, source cohort and literal lead band has its own scalar state. Calibration uses only **native, supported, earlier V1 out-of-sample predictions** whose valid times fall in the 365 elapsed days strictly before local issue-month start minus 168 elapsed hours. The verified V1 prediction population supplies the available history; there is no invented earlier prediction history or hard-coded target-month warm-up.

Minimum calibration support is 60 local dates and 500 distinct valid hours, including 10 observed-wet dates and 50 observed-wet hours. Weights split equally among local dates, valid hours within dates, and forecast vintages within hours. An unsupported current V1 model forces exact raw fallback regardless of calibration support.

The scalar lies in `[0.5, 2]`. Numerical tolerance is `1e-10 + 1e-8 * abs(target)` mm/h, used only for root precision. A curve narrower than this tolerance is unsupported. A target strictly outside its attainable endpoint means is unsupported without a tolerance rescue. An adequate unit scale is preferred; exact endpoint roots are retained. Otherwise, 64 bisection iterations choose the endpoint minimizing absolute residual, distance from one, then scale. A residual above tolerance falls back to raw. Every fallback is retained with its reason.

## Reporting and acceptance

All six arms are scored on exactly the same rows, including exact raw fallbacks. The original error and event gates remain unchanged. Continuation screening additionally requires:

1. At least 2% lower hourly MAE than raw.
2. Strictly smaller absolute balanced-volume error than V1 intensity guard.
3. At least 180 **candidate-supported** dates and 20 candidate-supported wet dates, plus all original gates.

Reports separate complete months from partial September, source cohorts, and literal lead bands. They include per-candidate support, fallback reasons by month/band, and observed/predicted volume contributions by raw forecast category using **global** weights, not favorable within-category renormalization. Sensitivity targets and accumulation rules are inherited unchanged. No 1–12-hour or other intervening-lead claim can be inferred from fixed 24/48/72/96/120/144/168-hour anchors.

If this single frozen replay fails, do not retune it on the consumed period. A later occurrence/amount model would be a separate preregistered experiment and would require new prospective evaluation to support a qualified claim.

## September 8, 2026 result

Both new arms fail the **overall** continuation screen. The single replay retained all 101,864 V1 prediction rows and fitted 118 calibration states. Complete-month fixed-anchor scoring contains 76,825 forecasts, 10,975 distinct hours, 598 dates and 171 wet dates.

| Candidate | MAE mm/h | RMSE mm/h | Observed-wet MAE mm/h | Balanced volume ratio |
| --- | ---: | ---: | ---: | ---: |
| Raw | 0.094383 | 0.433804 | 0.878285 | 0.776451 |
| V1 Tweedie blend | 0.094330 | 0.394118 | 0.835922 | 0.745828 |
| V1 intensity guard | 0.085854 | 0.402311 | 0.853492 | 0.596460 |
| Volume-neutral guard | 0.094441 | 0.421527 | 0.865016 | 0.789742 |
| Volume-calibrated guard | 0.095477 | 0.430653 | 0.873372 | 0.802298 |
| Zero control | 0.066586 | 0.402410 | 0.931281 | 0.000000 |

The primary arm improves balanced rain volume relative to V1 guard but worsens overall hourly MAE by **1.16% versus raw**. The diagnostic arm is effectively flat on MAE (+0.06% versus raw). Threshold detection is exactly raw for both arms; neither repairs a missed event. The zero control's apparently favorable overall MAE accompanies zero wet-event detection and is not a model candidate for deployment.

The primary arm applies to 40,331 anchor rows across 512 supported dates. Another 9,504 rows fall back for insufficient calibration support, and 26,990 because the observed target lies outside the attainable range. The neutral arm applies to 67,321 rows across 513 supported dates and falls back on the same 9,504 insufficient-support rows. The 144/168-hour primary arm has no supported application; all its predictions remain raw. Supported dates must not be pooled across bands to qualify one band.

The literal **72-hour primary arm alone passes its continuation screen**: MAE 0.098853 versus raw 0.106551 (7.22% lower), balanced volume ratio 0.991851, and 511 supported dates. This is a reported development slice, not a selected deployment or an independent accuracy claim; its MAE is still worse than V1 guard at that lead.

Under the full scoring weights, **52.24% of observed rain volume occurs on exactly raw-zero rows**. A category-preserving intensity correction cannot recover that rain at the hours it occurred. Moving closer to aggregate volume by increasing other rainy hours does not solve occurrence. The frozen scaling experiment is therefore closed without retuning.

Saved-live predictions remain entirely unsupported and raw for both new arms. Complete months and partial September stay separate. The missing short-lead archive and previously scheduled recovery job are unchanged; no near-term forecast improvement is established.

## Reproduction and evidence

The existing isolated numerical runtime is reused without new application dependencies:

```sh
PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/run_rain_rate_volume.py \
  VERIFIED_V1_DIRECTORY V1_INDEPENDENT_VERIFICATION_JSON NEW_PRIVATE_OUTPUT_DIRECTORY

PYTHONDONTWRITEBYTECODE=1 "$HOME/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python" \
  scripts/research/verify_rain_rate_volume.py \
  NEW_PRIVATE_OUTPUT_DIRECTORY --output NEW_INDEPENDENT_VERIFICATION_JSON
```

The runner binds the original full-refit receipt and copies its exact artifacts before fitting. New sources and policy are frozen before root fitting. The independent verifier reselects source rows, reconstructs scalar roots and predictions, and recomputes scores, support, fallbacks and category-volume diagnostics. Baseline input/model replay remains covered by its unchanged SHA-bound full-refit evidence.

Private rows and model material remain outside Git. Aggregate evidence is stored under `.omx/evidence/rain-rate-volume-20260908/`; immutable evidence is encrypted using the existing backup recipient and copied to Blueberry with decrypted-member and remote-cipher checksums verified. No private rows or model blobs are served in review previews.

The independent replay passed for all 101,864 rows and 118 calibration states, including baseline parity, source selection, roots, fallbacks, event categories, every reported score and screening decision. The 65 rain-related regression tests, Python Ruff error checks, workspace lint/typecheck, AST parsing and diff checks passed. Fitting took 139 seconds with 714 MiB peak memory; independent verification took 148 seconds with approximately 1.0 GiB peak memory. These establish reproducibility, not forecast qualification.
