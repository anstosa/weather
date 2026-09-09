# ECMWF winner extensions

`scripts/research/temperature_winner_extensions.py` contains two separate,
inactive experiments on the existing ECMWF adaptive MOS temperature winner.
The baseline remains unchanged, as do Best Match, other metrics, and forecasts
outside the declared first-twelve-hour analysis window. No application
dependencies or production serving behavior change.

## Experiment A: same-run trajectory

The original model uses the target hour's forecast temperature, humidity, wind,
calendar/lead/cycle features, and recent raw forecast errors. This experiment
adds nine temperature-trajectory features computed only from the same provider
and initialization:

1. One-hour temperature slope, divided by three.
2. Three-hour temperature slope, divided by three.
3. Three-hour second difference, divided by nine.
4. Target temperature minus the nearby window mean, divided by three.
5. Nearby window range, divided by three.
6. Whether the one-hour slope uses the forward boundary stencil.
7. Whether the three-hour slope uses the forward boundary stencil.
8. Curvature direction: forward, centered, or backward.
9. Nearby window width divided by seven.

Slopes use preceding forecast hours where available, otherwise following hours
at the beginning of the run. Curvature is centered at leads 4–15 and uses a
one-sided six-hour stencil at the boundaries. The nearby window is target lead
±3, clipped to the retained leads 1–18. Lead zero is not assumed. All values are
forecasts from one run, not future observations or values from another run.

Required source identities are selected before reading temperatures. A missing
required row or temperature makes the trajectory unsupported; no different run
is substituted. Such rows are excluded from trajectory fitting but remain in
scoring with the exact incumbent prediction. Duplicate run/lead identities and
contradictory model cycles fail closed.

The added features extend direct/adaptive schemas from 35/49 to 44/58 terms.
Fitting retains the original eight Huber iterations, delta 1.5°C, ridge penalty
0.01 with an unpenalized intercept, and nested date/hour/event weights. Corrections
remain half-strength, capped at ±3°C, with physical bounds −100°C to 70°C.
Unsupported raw-error state uses the augmented direct model; unsupported
trajectory/model/incumbent support returns the incumbent exactly.

## Experiment B: learned correction strength

This arm leaves the original winner's fitted coefficients and feature schema
unchanged. Each historical calibration row uses its own original monthly winner
snapshot. The unscaled correction is computed directly from the appropriate
coefficient vector and features; it is not inferred by doubling the clipped
prediction-minus-raw difference.

For each target month, scope, and analysis-horizon band (1–6 or 7–12), choose
alpha from the fixed grid `0.35, 0.5, 0.65, 0.8, 1.0`. The objective is earlier-only,
date/hour/event-weighted MAE after clipping and physical bounds, plus
`0.01 * (alpha - 0.5)^2`. Ties favor the value closest to 0.5, then the smaller
value. The forecast becomes `raw + clip(alpha * unscaledCorrection, -3, 3)`
before physical bounds.

Each band requires 60 earlier dates and 1,000 supported historical incumbent
rows, otherwise it returns the incumbent exactly. This selection never uses the
month being evaluated. All grid costs, support counts, and selected alphas are
retained. Learned strength is not applied to the trajectory arm; there is no
combined or post-hoc best-of model in this experiment.

## Temporal and validation boundaries

Both arms use the original monthly cutoff of local month start minus 168 elapsed
hours, and train only on targets with `validAt + 7h <= cutoff`. Historical winner
snapshots must precede each row's initialization. Recent-error state remains the
same-provider 24/72-hour raw-error state ending at initialization minus seven
hours. Observation receipt/revision times are not reconstructed, so this remains
an explicit research availability assumption.

The primary scope is model leads 1–12. The separate hypothetical six-hour-delay
scope uses model leads 7–18. Both freeze observation information at initialization;
neither establishes actual issue-relative operational performance.

Every complete January 2025–August 2026 date is retained: 608 local-date cells,
with 28,914 matched forecasts in each scope. September 1–6 is separate. Scoring
compares raw, the exact unchanged incumbent, trajectory, and learned strength on
identical rows. Missing forecasts, unavailable targets, archive gaps, and all
fallback cases remain counted. Reports include months, seasons, dayparts, exact
leads, horizon bands, cycles, model eras, support groups, every date, error tails,
and paired seven-day block intervals against raw and incumbent. The dates were
previously consumed as development data, not an untouched holdout.

## Reproduction

The frozen plan and aggregate evidence are under
`.omx/evidence/winner-extensions-20260907/`. Private input rows, coefficients,
trajectories, and predictions belong in encrypted evidence storage, never Git.
The source-retention dependency is the prior verified stacking evidence package;
its selected historical ECMWF winner states cover March 2024–September 2026.

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 \
  ~/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python \
  -m unittest discover -s scripts/research -p test_temperature_winner_extensions.py
```

The production forecast remains unchanged at
<https://weather.ballydidean.farm/forecast>.

## September 7 results

### Complete 608-date primary benchmark

| Candidate | Equal-date MAE °C | Gain over raw | Gain over incumbent |
| --- | ---: | ---: | ---: |
| Raw | 1.29328 | — | — |
| Unchanged adaptive MOS | 1.08905 | 15.79% | — |
| Trajectory extension | 1.07628 | 16.78% | 1.17% |
| Learned strength | **1.01297** | **21.67%** | **6.99%** |

The first-six-hour and next-six-hour results remain separate:

| Candidate | Hours 1–6 gain over raw | Hours 7–12 gain over raw |
| --- | ---: | ---: |
| Unchanged adaptive MOS | 16.49% | 15.11% |
| Trajectory extension | 17.24% | 16.33% |
| Learned strength | **22.53%** | **20.86%** |

The trajectory extension improves over the incumbent in all 20 complete months,
all four seasons, and all four dayparts. Its paired seven-day-block 95%
development interval for improvement over the incumbent is 0.86–1.51%.
It wins 395 dates and loses 213 versus incumbent; against raw it wins 501 and
loses 107. Afternoon gain over raw increases modestly from 5.86% to 6.36%, while
the largest daypart improvement over incumbent is evening, at 3.24%.

Learned strength has a larger 5.19–8.74% paired development interval for gain over
the incumbent, but is less consistent. It loses to the incumbent in March 2025
(−2.86%) and August 2025 (−1.56%), and in the aggregate afternoon slice (−1.62%).
All complete months and seasons still improve over raw. It wins 369 dates and
loses 239 versus incumbent; against raw it wins 429 and loses 179, compared with
the incumbent's 485 wins and 123 losses. Lower average error is not an
across-the-board daily improvement.

The earlier-only calibration chooses alpha 1.0 in all 21 first-six-hour monthly
states. The next-six-hour band chooses 1.0 in 20 states and 0.8 in one. These are
historical inner-training selections, not alphas chosen after evaluating those
months. No new grid values or combined trajectory/strength arm were introduced
after observing the result.

### Tails and separate delay sensitivity

Primary learned-strength p95 absolute error improves from 3.032°C to 2.710°C,
and the equal-date fraction of errors above 3°C falls from 5.171% to 3.256%.
However, the single worst miss increases from 7.052°C to 7.827°C. Trajectory
p95 improves to 3.001°C, with a slightly larger maximum of 7.143°C.

The hypothetical six-hour-delay scope has the same 608 dates and 28,914 matched
forecasts. Trajectory gains 16.60% over raw and 1.53% over incumbent, improving
all 20 complete months. Learned strength gains 20.64% over raw and 6.30% over
incumbent, again losing March/August 2025 and the afternoon aggregate versus
incumbent. Its p95 improves from 3.117°C to 2.819°C, while maximum error increases
from 8.432°C to 8.526°C. This scope remains a sensitivity, not an observed
issue-time replay.

### September remains separate

On September 1–6, primary trajectory is 1.61% worse than incumbent, while primary
learned strength is essentially tied (+0.012%). In the delayed scope, trajectory
is 0.26% worse and learned strength is 5.34% worse. Those six days remain visible
and are not pooled into the complete-month benchmark.

The evidence supports retaining trajectory as a modest, more consistent
complete-month improvement and learned strength as the stronger average-error
candidate with explicit regressions. It does not establish a uniformly superior
model or qualify either research artifact for operational deployment.

## Verification and retention

Independent reconstruction reproduced 3,326 raw-error states, all 59,868
trajectory receipts, 79,824 prepared rows, the 62 historical winner snapshots,
and all 42 extension states with zero numeric difference. It reproduced both
coefficient schemas, all per-band alpha grid costs/selections, every one of the
58,386 predictions, and all four complete report blocks exactly. All original
incumbent controls matched. The 126 unsupported historical trajectories remain
explicit; neither arm falls back on any otherwise scoreable evaluation row.

Changing future labels by +100°C left 3,152 protected states and the protected
August fits unchanged. Both complete executions produced 48 byte-identical
artifacts, with all 80 frozen inputs unchanged. The 69 temperature research tests,
six runner tests, and 256 forecast-adjustment package tests passed (331 total).
Repository lint, targeted TypeScript typecheck, Python AST validation,
documentation lint, and whitespace checks passed. Python semantics are covered
by tests and independent reconstruction; the repository linter does not lint
Python files.

Private evidence storage uses `~/.weather/model-evidence/winner-extensions-20260907/`
and `blueberry:/home/admin/.weather/model-evidence/winner-extensions-20260907/`.
The retention receipt binds the encrypted archive and retained-member manifest.
No commit, push, deployment, or production model activation is part of this trial.
