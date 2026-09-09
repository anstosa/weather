# Direct short-lead temperature models

`scripts/research/temperature_shortlead_models.py` implements three inactive
research candidates. Unlike the prior seasonal transfer experiment, these models
fit genuine initialization-relative short-lead archive rows directly. They do
not change production serving, humidity, wind, or the accepted longer-lead
behavior. No application dependencies were added.

## Candidate set

- **Direct MOS:** a provider-specific robust residual regression using the existing
  27 seasonal/weather features plus forecast lead, lead interactions, initialization
  cycle, and model-era terms. It has 35 features.
- **Lagged bias:** a no-fit persistence control based on recent raw forecast errors,
  with a fixed exponential horizon decay. It isolates recent-error persistence
  from static weather calibration.
- **Adaptive MOS:** the direct model plus 14 recent-error features, jointly fitted
  against actual-minus-raw temperature. It learns how much recent bias helps at
  each horizon instead of applying a hand-selected weather or date switch.

The learned models use eight fixed Huber/ridge iterations, Huber delta 1.5°C,
mean-loss ridge penalty 0.01, and half-strength corrections capped at ±3°C.
Hyperparameters and the full calendar evaluation were fixed before real fitting;
there is no outcome-driven parameter search or date deletion.

## Forecast and observation identities

ECMWF single-run hindcasts and Best Match single-run archive forecasts are fitted
and scored separately. Two separate model scopes are evaluated:

1. Model leads 1–12, with analysis horizon equal to the model lead.
2. Model leads 7–18, with analysis horizon equal to model lead minus six, as a
   hypothetical six-hour publication-delay sensitivity.

Both scopes freeze their observation information boundary at model initialization;
the sensitivity does not refresh observations at hypothetical publication. Neither
scope establishes actual issue-relative performance. Production currently persists
forecast retrieval time rather than the provider initialization identity needed
by these candidates.

Rolling state selects one same-provider forecast per prior valid hour, choosing
the latest eligible initialization and a deterministic key tie-break before
reading errors. Source model leads must be 7–18. A station-hour target is usable
only when its hour has ended and an additional assumed six hours have elapsed:
`sourceValidAt + 7h <= targetRunInitializedAt`. Actual observation receipt and
revision times are not reconstructed, so this remains an explicit research
assumption rather than proof of historical availability.

The 24-hour and 72-hour windows end at that eligibility boundary. State requires
at least six short-window hours, 24 long-window hours, and two local dates.
Unsupported adaptive predictions equal direct MOS exactly. Missing selected
forecast temperatures do not trigger substitution of an older forecast after
errors are inspected. Null observations and archive gaps remain counted.

## Fitting, evaluation, and composition

Separate provider/scope/target-month states use only targets matured before the
local month start minus a 168-hour embargo. Training requires at least 60 earlier
local dates and 1,000 rows. All arms return raw during a training cold start; cold
and learned populations are reported separately, including Best Match's shorter
archive history. Training and primary evaluation weight each date equally, then
each UTC valid hour within the date, then repeated forecasts within that hour.

Every complete month from January 2025 through August 2026 is evaluated, with all
608 local-date cells retained. September 1–6 is separate. Controls include raw,
the exact frozen prior seasonal transfer candidate, and a training-only median
offset. Reports retain every month, season, year-season, daypart, exact lead,
initialization cycle, model era, state-support cell, cold-start cell, daily
comparison, and error tail. Seven-day moving-block intervals describe development
uncertainty; previously consumed dates are not called an untouched holdout.

The prediction wrapper changes only analysis horizons 1–12 inside the declared
scope. Outside that window it returns the prior prediction without inspecting
other forecast features. This preserves later predictions, including beyond
48 hours, by construction. A real deployment needs a separately validated
provider-run identity and, for lagged arms, an observation-state runtime boundary.

## Reproduction

The frozen experiment plan and aggregate verification are under
`.omx/evidence/shortlead-models-20260907/`. The source corpus is the independently
verified `shortlead-history-20260907` encrypted evidence package. Row-level
observations, forecasts, fitted states, and prediction audits belong in private
encrypted evidence storage, never Git.

Run focused synthetic tests using the existing isolated research runtime:

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 \
  ~/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python \
  -m unittest discover -s scripts/research -p test_temperature_shortlead_models.py
```

The production forecast is unchanged at
<https://weather.ballydidean.farm/forecast>.

## September 7 experiment result

Both full executions and the independent reconstruction matched exactly: 84
provider/scope/month model states, 48 supported states containing two fitted
coefficient vectors each, 36 explicit cold starts, 3,956 causal state snapshots,
and 73,424 scoped prediction rows. All 87 model/result artifacts were byte-identical
between executions. The verifier changed 1,788 future labels and confirmed that
3,360 earlier states, 36,174 eligible training keys, and both coefficient vectors
were unaffected. The 19 new model tests, 14 prior-model tests, four runner tests,
repository lint, forecast-adjustment typecheck, and 256 package tests passed.

### ECMWF multi-year hindcast benchmark

The primary test contains 28,914 matched forecasts across all 608 dates in
January 2025–August 2026. All figures below use identical equal-date weighting.

| Candidate | MAE °C | Improvement over raw |
| --- | ---: | ---: |
| Raw | 1.29328 | — |
| Prior seasonal transfer | 1.24320 | 3.87% |
| Direct short-lead MOS | 1.10033 | 14.92% |
| Lagged-bias control | 1.21762 | 5.85% |
| Adaptive short-lead MOS | 1.08905 | 15.79% |

Adaptive MOS improves 12.40% over the prior candidate. Its seven-day moving-block
95% development interval for improvement over raw is 14.10–17.39%. It improves
all 20 months, all four seasons, all 12 exact model leads, and all four dayparts.
Seasonal gains are winter 21.10%, spring 13.23%, summer 14.67%, and autumn 13.72%.
Afternoon gain is 5.86%, correcting the earlier aggregate afternoon regression.
It still loses on 123 of 608 individual dates; this is not an every-forecast
improvement claim. Direct short-lead training supplies most of the gain; adaptive
state adds about 0.0113°C lower MAE over the simpler direct model.

The separately fitted model-leads-7–18 sensitivity improves 15.31% over raw and
11.24% over its prior comparator, with all months and seasons improving. This
remains a hypothetical publication-delay analysis, not an observed issue-time
replay. September 1–6 is retained separately in the machine-readable results.

### Best Match is a different result

The Best Match first-12 model gains 7.28% over raw across the available
April–August population, but is **4.38% worse than the prior seasonal candidate**.
April–June are explicit raw cold starts. Even on the July–August learned-only
population, the new adaptive model's 15.69% raw improvement trails the prior
model's 19.71%, making the adaptive model 5.00% worse than that comparator.
The delayed-window learned-only comparison also loses to the prior candidate.
This is not just a cold-start accounting effect.

Consequently, the experiment supports retaining the new ECMWF models for further
research while retaining the prior Best Match candidate. It does not support
replacing the live forecast's Best Match correction or pooling provider outcomes
into one deployment-improvement claim. Production remains unchanged.

### Retained artifacts

Fitted states, complete private predictions, causal state audits, replay code,
independent checker, and source identities are retained encrypted locally under
`~/.weather/model-evidence/shortlead-models-20260907/` and on Blueberry under
`/home/admin/.weather/model-evidence/shortlead-models-20260907/`. The package records
the earlier `shortlead-history-20260907` source-retention dependency. Verify
ciphertext and retained-member checksums before restoring into owned private
storage. Aggregate results and verification receipts remain under
`.omx/evidence/shortlead-models-20260907/`.
