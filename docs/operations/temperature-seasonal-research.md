# Smooth seasonal temperature experiment

`scripts/research/temperature_seasonal_ridge.py` is an inactive research model.
It does not change forecast serving, model activation, or the existing adjustment
configuration. It uses NumPy from the already-established isolated research
runtime; no application dependency was added.

## Model and validation

The model learns forecast temperature residuals using 27 continuous calendar and
weather features: daily and annual harmonics, their interactions, raw temperature,
humidity, and wind. Separate 24-hour and 48-hour models use eight fixed Huber/ridge
updates. Predictions retain half of the learned correction, capped at three
degrees Celsius, with the existing physical temperature bounds.

The September 7, 2026 experiment uses the freshly exported production dataset
covering January 2024 through September 6, 2026. Every complete month from January
2025 through August 2026 is scored, using only earlier training observations with
a 168-hour embargo. September 1–6 is reported separately. There is no parameter
search or favorable-date selection.

Primary error is averaged across forecasts within each valid UTC hour, then
across hours within each local date, then across dates. Raw forecasts, a simple
training-only median-offset control, and the challenger share identical scored
events. Per-month, season, date, lead, daypart, large-error frequency, and
equal-lead diagnostics are retained, including missing date cells.

For genuine short-lead retrievals, the experiment uses the model from the issue
month. Leads through 24 hours use the 24-hour model; leads between 24 and 48 hours
interpolate the two residual predictions. This is an explicit cross-lead transfer
test, not reconstructed historical short-lead forecasts. Every prediction after
48 hours preserves the prior research comparator exactly.

## Limits and reproduction

All-season evidence applies only to the available 24-hour and 48-hour archive
anchors. Genuine first-12-hour records cover August 26–September 6, 2026 only.
These historical development dates have been consumed previously; they are not
an untouched qualification holdout. Observation arrival and revision timing is
not reconstructed. Passing development gates does not authorize production
activation or establish improvement on every individual date or forecast.

The frozen plan, source identities, test results, and aggregate results are under
`.omx/evidence/temperature-seasonal-model-20260907/`. Private inputs, monthly model
states, predictions, runner, and independent checker are retained encrypted under
`~/.weather/model-evidence/temperature-seasonal-model-20260907/` and on Blueberry.
Decrypt only into owned private temporary storage and verify retained checksums
before reuse. Do not place row-level production observations or forecasts in Git.

Run the focused synthetic tests with the existing research interpreter:

```bash
PYTHONDONTWRITEBYTECODE=1 OPENBLAS_NUM_THREADS=1 \
  ~/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python \
  -m unittest discover -s scripts/research -p test_temperature_seasonal_ridge.py
```

## Expanded short-lead validation

A subsequent September 7 replay fixes the narrow date coverage for short-lead
research. The production Previous Runs backfill imported only day1–day7 anchors;
it did not import historical first-12-hour runs. A fresh read-only inventory of
all four forecast source generations found retrieval history beginning in August
2026, not an unqueried multi-year short-lead corpus.

The expanded corpus pairs the existing production measurements with Open-Meteo
Single Runs forecasts: ECMWF initialization dates March 14, 2024–September 6,
2026 and a separate Best Match archive beginning April 2, 2026. Acquisition
accounted for all 4,260 requested initialization cycles: 3,956 valid responses,
303 explicit unavailable runs, and one malformed HTTP 200 response. Missing
runs, null forecasts, and missing observation targets remain counted; no values
are imputed. The retained inputs contain 59,868 ECMWF and 11,340 Best Match
forecast-hour rows at model leads 1–18.

The exact existing monthly model states were replayed without fitting or tuning.
The multi-year test uses all 608 local dates across January 2025–August 2026 and
all four seasons. September 1–6 remains a separate partial-month report. Primary
results use equal-date MAE after averaging repeated forecasts within valid hours.

| Archived cohort and window | Compared forecasts | Scored dates | Raw MAE °C | Candidate MAE °C | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| ECMWF model leads 1–12 | 28,914 | 608 | 1.29328 | 1.24320 | 3.87% |
| ECMWF model leads 7–18 | 28,914 | 608 | 1.33202 | 1.27096 | 4.58% |
| Best Match model leads 1–12 | 7,246 | 153 | 1.18008 | 1.04835 | 11.16% |
| Best Match model leads 7–18 | 7,234 | 152 | 1.33299 | 1.14950 | 13.77% |

For ECMWF leads 1–12, the candidate improves all 12 exact lead-hour aggregates
and 16 of 20 months, but it is **not uniformly better**. March and April regress
in both 2025 and 2026. Spring MAE worsens 1.54%, afternoon MAE worsens 0.84%, and
216 of 608 daily comparisons are worse than raw. Winter improves 8.40%, summer
4.92%, and autumn 3.70%. The frozen median-offset control improves overall MAE
2.73% versus raw; the candidate improves 1.18% versus that control.

The archive's multi-year ECMWF segment is hindcast data. Model initialization
is not an observed historical issue time. Leads 7–18 are reported only as a
hypothetical six-hour publication-delay sensitivity check, not proof of actual
issuance-relative first-12-hour performance. Best Match is a separate April–August
2026 transfer check; it must not be pooled with ECMWF or described as multi-year
Best Match validation. See the [Single Runs documentation](https://open-meteo.com/en/docs/single-runs-api).

Independent verification reconstructed all production network targets, archive
response and normalized forecast rows, frozen training-key sets and cutoffs, and
55,065 distinct scored predictions. Both full replays are byte-identical; focused
model and replay tests passed. This expanded development evidence is not a new
untouched holdout and does not activate the candidate. Production adjustments,
including behavior beyond 48 hours, remain unchanged.

Use this expanded corpus for subsequent short-lead experiments rather than
reverting to the August-only retrieval cohort. Aggregate results, missingness,
plans, provenance corrections, and independent checks are under
`.omx/evidence/shortlead-history-20260907/`. Private source responses, inputs,
network targets, model states, replay code, predictions, and manifests are
retained encrypted under `~/.weather/model-evidence/shortlead-history-20260907/`
and the corresponding Blueberry evidence directory. The package references the
independently retained original production exports; verify both retention chains
before reuse. Keep initialization, publication assumptions, provider cohorts,
and later genuinely untouched validation dates separate in future experiments.
