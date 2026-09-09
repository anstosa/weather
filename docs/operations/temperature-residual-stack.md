# Seasonal-baseline residual stacking

`scripts/research/temperature_residual_stack.py` contains inactive temperature
research candidates. No production serving, humidity, wind, or accepted
longer-horizon behavior changes. No application dependencies were added.

## Hypothesis and candidates

The previous direct short-lead model improved the multi-year ECMWF benchmark but
lost to the seasonal candidate on Best Match, including learned-only dates. This
experiment preserves the seasonal prediction rather than relearning its entire
correction around raw temperature.

- **Static residual:** fit actual minus the historical seasonal prediction using
  ten incremental lead, cycle, local-hour, baseline/raw disagreement, and model-era
  features. It does not duplicate the full seasonal/weather feature basis.
- **Adaptive residual:** add the earlier experiment's fourteen rolling-error
  features, now computed against historical seasonal predictions rather than raw.
  Unsupported rolling state uses the static residual prediction exactly.
- **Conservative blend:** fit one scalar weight between zero and 0.5 for the
  difference between historical adaptive MOS and seasonal predictions. Zero
  weight preserves seasonal; 0.5 is an equal blend, not full replacement.

Residual fits use eight Huber iterations, delta 1.5°C, mean-loss ridge penalty
0.1 on every coefficient including the intercept, and half-strength corrections
capped at ±1.5°C. The blend uses eight constrained scalar Huber updates with
penalty 0.1 toward zero. No outcome-driven parameter search or regime switches
are permitted. Each arm requires 60 earlier dates and 1,000 rows; the blend counts
only rows where the historical challenger itself was supported. Cold starts
return the seasonal prediction, never raw.

## Honest historical inputs

Every residual label uses a baseline prediction from an earlier-only monthly
model. The exact 42 established seasonal states from January 2025 onward remain
unchanged. Earlier 2024 states use the same seasonal fitter on retained production
anchor history, beginning January 19, 2024. Months without its original
180-date/1,000-row support have no baseline prediction and cannot supply residual
training labels. Later models are never substituted into those historical rows.

Seasonal fits retain their original 168-hour embargo and label selection.
Their conservative availability boundary is the original fit cutoff plus seven
hours; the latest training target's timestamp plus seven hours must not exceed
that boundary, which must precede each forecast initialization. Challenger
snapshots retain the previous short-lead model's `validAt + 7h <= cutoff` rule.
Their cold-start raw predictions remain visible as a comparator but are excluded
from blend training.

Rolling state retains same-provider source selection before reading outcomes,
model leads 7–18, 24/72-hour windows ending at initialization minus seven hours,
and the original support/median/dispersion rules. If the selected forecast lacks
a supported seasonal prediction, its hour is skipped rather than replaced with
an older forecast chosen after inspecting errors. Observation receipt/revision
times are not reconstructed, so the seven-hour availability lag remains an
explicit research assumption.

## Evaluation contract

The complete January 2025–August 2026 panel retains all 608 local-date cells;
September 1–6 is separate. ECMWF and Best Match remain separate providers. Model
leads 1–12 and the hypothetical six-hour-delay scope (model leads 7–18) are
separate fits and reports. Both freeze observations at initialization; neither
establishes actual issue-relative operational performance.

All candidates, raw, seasonal, and the unchanged adaptive MOS comparator use
identical matched rows and equal-date/hour/event weighting. Reports include all
months, seasons, dayparts, exact leads, 1–6/7–12 bands, model eras, support groups,
dates, large-error fractions, p95, and maximum error. Paired seven-day block
intervals compare against both raw and seasonal. These are reused development
dates, not an untouched holdout. Forecasts outside the declared first-twelve-hour
analysis window pass through unchanged before other inputs are inspected.

## Reproduction and evidence

The frozen plan, source identities, results, and independent verification are
under `.omx/evidence/shortlead-stacking-20260907/`. Private forecast/measurement
rows, model coefficients, and full predictions belong only in the encrypted
evidence packages, not Git.

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 \
  ~/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python \
  -m unittest discover -s scripts/research -p test_temperature_residual_stack.py
```

The production forecast remains unchanged at
<https://weather.ballydidean.farm/forecast>.

## September 7 results

### Best Match

The primary initialization-relative window contains 7,246 matched forecasts on
153 available April–August dates. Every candidate uses the same population.

| Candidate | Equal-date MAE °C | Gain over raw | Gain over seasonal |
| --- | ---: | ---: | ---: |
| Raw | 1.18008 | — | — |
| Seasonal baseline | 1.04835 | 11.16% | — |
| Previous adaptive MOS | 1.09422 | 7.28% | −4.38% |
| Static residual | 1.02812 | 12.88% | 1.93% |
| Adaptive residual | **1.02424** | **13.21%** | **2.30%** |
| Conservative blend | 1.04835 | 11.16% | 0.00% |

April–June remain exact seasonal fallbacks. On the 62 learned July–August dates,
adaptive residual reduces MAE from 1.08408°C to 1.02459°C: **5.49% better than
seasonal and 24.11% better than raw**. July and August improve over seasonal by
4.05% and 6.94%, respectively. Across the whole available panel, the paired
seven-day-block 95% development interval for gain over seasonal is 1.01–3.74%.
There are 48 daily wins, 14 losses, and 91 unchanged fallback dates versus seasonal.

Both first-six and next-six model-hour groups improve: 11.03% and 15.06% over raw,
or 2.36% and 2.25% over seasonal. Every exact model lead improves on aggregate.
The hypothetical six-hour-delay window gains 15.89% over raw and 2.47% over
seasonal, with a 1.11–3.98% paired development interval for the latter.

This is not a uniform win. The primary afternoon aggregate is 0.084% worse than
seasonal. Pooled p95 improves from 2.673°C to 2.636°C, and the equal-date fraction
of errors above 3°C falls from 3.159% to 2.914%, but the maximum miss grows from
7.310°C to 7.545°C. The separate September 1–6 primary panel is essentially tied
but slightly worse than seasonal (0.019%); the delayed window is 0.299% worse.
Those dates remain in the report rather than being dropped.

The Best Match blend **never reaches its training-support gate** in the observed
panel, including September: the historical challenger first becomes supported
in July, leaving only 55 earlier learned dates by the September embargo cutoff.
Its identical seasonal score is fallback behavior, not evidence that a learned
blend works. The stricter gate was not relaxed after observing this result.

### ECMWF

All 608 January 2025–August 2026 dates and 28,914 matched primary-window forecasts
remain in evaluation. Adaptive residual gains 12.85% over raw and 9.34% over
seasonal, improving every complete month, but loses to the previous adaptive MOS
candidate's **15.79% raw improvement**. The conservative blend gains only 10.98%
over raw. The delayed-window adaptive residual gains 12.96%, also trailing the
previous model's 15.31%.

The result supports keeping the existing ECMWF research winner and advancing
the seasonal-plus-adaptive-residual candidate for Best Match. It does not
justify replacing all providers with one model, claiming every date improves,
or deploying an initialization-conditioned research model as an operational
issue-relative correction.

## Verification and retention

Independent reconstruction reproduced all 84 monthly residual/blend training
selections and fits with zero coefficient difference, all 73,424 predictions
with zero difference, and eight report blocks containing 2,884 score cells with
zero numeric difference. It rebuilt the raw/prior rolling states, checked
55,065 exact retained seasonal predictions and 73,424 exact incumbent predictions,
and passed future-label isolation. All 278 output artifacts were byte-identical
across two complete executions; 148 frozen inputs remained unchanged.

The 56 temperature research tests, five runner tests, and 256 forecast-adjustment
package tests passed (317 total). Repository lint, targeted TypeScript typecheck,
Python AST validation, documentation lint, and whitespace checks passed. The
repository linter does not lint Python semantics; Python coverage comes from
synthetic tests, the independent reconstruction, and syntax validation.

Private evidence storage uses `~/.weather/model-evidence/shortlead-stacking-20260907/`
and `blueberry:/home/admin/.weather/model-evidence/shortlead-stacking-20260907/`.
The aggregate retention receipt binds the encrypted archive and retained-member
manifest. Verify that receipt and every member checksum before restoring data.
No commit, push, deployment, or production model activation is part of this trial.
