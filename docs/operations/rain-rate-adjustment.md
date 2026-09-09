# Rain-rate adjustment research

## Scope and target

This is a rain-only, inactive model experiment. It does not activate a model,
change the forecast API or UI, alter humidity or pressure models, or replace the
existing temperature and wind bundles. Existing moisture-recovery jobs and their
immutable runtime snapshots are unchanged.

The target is **mean rain rate over a complete reporting hour, in mm/h**, not
instantaneous intensity. The existing recovered rain pairs contain complete
nonoverlapping sixty-minute Tempest gauge accumulations. An hourly accumulation
of one millimeter corresponds numerically to a mean rate of one millimeter per
hour. Do not divide by the polling cadence, substitute the latest instantaneous
sensor rate, or treat missing intervals as zero.

The inherited target requires three complete gauges, including one of the
nearest three, and a spatial weighted median gauge temperature above 2°C.
Snow/cold hours and temperature-unknown hours are not liquid-rain labels.
Reporting-hour endpoint lag, spatial representativeness, and missing gauges
remain limitations. The same fixed primary predictions are additionally scored
against the five-minute alignment shift and the weighted-mean gauge target.
See [the original target contract](rain-humidity-pressure-research.md).

## Frozen candidates

`scripts/research/rain_rate_model.py` adds two candidates alongside raw and the
explicit zero-rain failure control:

- **Tweedie blend:** a shallow regularized boosted conditional-mean rain model,
  blended equally with raw. The nonlinear model uses raw precipitation,
  forecast humidity, temperature, wind, cloud, literal lead and calendar
  features. Humidity is only a forecast covariate; no humidity adjustment model
  is fitted. No pressure variable or observed target enters inference.
- **Intensity guard:** the same blend, constrained to the raw rate's intervals
  `[0, 0.1)`, `[0.1, 1)`, `[1, 2.5)`, and `[2.5, 500]` mm/h, with exactly dry raw
  forecasts kept at zero. Open upper bounds use the immediately preceding
  representable float. This preserves raw wet/heavy-event decisions at the
  three declared thresholds; it cannot repair missed storms or claim improved
  event detection. Other thresholds and UI rounding do not inherit this
  guarantee.

The existing isolated XGBoost 3.4.1 research runtime is reused; no application
package dependency is added. The fixed learner uses Tweedie variance power
1.5, depth 2, 120 boosting rounds, learning rate 0.05, minimum child weight 25,
L2 regularization 20, all rows and features, CPU histogram trees, and one
numerical thread. The positive mean is capped at 30 mm/h before blending.
These are two frozen development candidates, not a parameter search. Existing
rain research has already consumed this evaluation period; it is not a new
independent holdout.

## Chronology and support

Monthly models use only labels strictly before the local issue-month start
minus 168 elapsed hours. Training is isolated by source cohort and literal lead
band. Minimum support is 180 local dates and 1,000 distinct valid hours, including
20 observed-wet dates and 100 observed-wet valid hours. Repeated vintages share
valid-hour weight; hours share local-date weight. Total fit weight is scaled to
the number of distinct valid hours, not the number of repeated forecasts.

Unsupported cells retain exact raw predictions. Native inference binds the
model's cohort, issue month and lead band. The only explicit source transfer
reuses an ECMWF fit for Best Match in the same issue month and lead band,
without refitting. Saved live forecasts are not relabeled as ECMWF. Fixed
Previous Runs anchors retain their nominal valid-minus-lead reference; they
cannot supply subdaily issue history or same-initialization rain trajectories.

## Evaluation and reproducibility

`scripts/research/run_rain_rate_research.py` requires the expected compressed
input SHA-256 and a new output directory. It freezes policy, development gates,
source hashes and input identity before fitting, retains serialized model
states and private row-level predictions, and rejects source/input changes
during execution. Outputs contain no production eligibility or activation.

All candidates share identical scoring populations. Event errors average first
across vintages within a valid hour, then hours within a local date, then dates.
January 2025 through August 2026 is the complete-month evaluation; September
1–6 is separate. Native source cohorts and ECMWF-to-Best-Match transfer are
never pooled. All lead, month and season results are retained, as are genuine
same-reference contiguous 3/6/12/24-hour accumulations. Missing hours invalidate
an accumulation; fixed anchors have no reconstructed same-run accumulations.

The frozen development screen requires adequate date/wet-date support, strictly
lower overall MAE, no worse RMSE, observed-wet MAE or absolute volume-ratio
error, and no worse detection probability, equitable threat score or false
alarm ratio at every declared threshold. Missing metrics fail closed. A screen
pass is not a qualification receipt: it cannot establish prospective accuracy,
all-season live-product transfer, or authorization to deploy.

Run with the existing private runtime and a bounded six-gigabyte/no-swap process:

```sh
~/.weather/research-runtimes/xgboost-cpu-3.4.1/bin/python \
  scripts/research/run_rain_rate_research.py \
  /private/path/rain.jsonl.gz /private/path/new-rain-rate-output \
  --input-sha256 VERIFIED_COMPRESSED_INPUT_SHA256
```

Retain inputs, serialized models, predictions, sources and verification evidence
in an owned private disk directory and a member-verified encrypted archive.
Only aggregate reports belong in the repository. No short-lead result should be
claimed until the separate archive recovery and its source-verification gates
complete. Production remains unchanged at
[Weather forecast](https://weather.ballydidean.farm/forecast).

### Method references

XGBoost documents `reg:tweedie` as regression with a log link and variance
power strictly between one and two. This experiment trains on nonnegative
observed accumulation, not signed residuals. The positive conditional-mean
prediction is not a wet-event probability.
[XGBoost parameters](https://xgboost.readthedocs.io/en/stable/parameter.html).

Open-Meteo's `precipitation` includes preceding-hour rain, showers and snow;
it is not interchangeable with its `rain` field. This experiment retains the
original total-precipitation forecast predictor against liquid-only gauge
labels. The observed-temperature gate does not establish that the model
forecast itself was liquid-only; this phase mismatch remains a limitation.
[Open-Meteo weather variables](https://open-meteo.com/en/docs).
Tempest's displayed rain rate extrapolates the latest one-minute accumulation,
which differs from this experiment's complete-hour mean rate.
[Tempest derived metrics](https://apidocs.tempestwx.com/reference/derived-metrics).

## September 8 production-history experiment

The source-bound run consumed 143,355 recovered input rows, retained 118 monthly
model states and 101,864 scoring predictions, and completed in 95 seconds with
654 MiB peak memory and no swap. The full-month fixed-anchor population contains
76,825 forecasts, 10,975 distinct valid hours, 598 local dates and 171 wet dates.
Every scored anchor row had model support. The raw baseline reproduces the
previous independently verified report across 952 metric comparisons.

| Candidate | MAE (mm/h) | RMSE (mm/h) | Observed-wet MAE (mm/h) | Balanced rain ratio | Wet detection |
| --- | ---: | ---: | ---: | ---: | ---: |
| Raw | 0.094383 | 0.433804 | 0.878285 | 0.7765 | 43.75% |
| Tweedie blend | 0.094330 | 0.394118 | 0.835922 | 0.7458 | 39.54% |
| Intensity guard | 0.085854 | 0.402311 | 0.853492 | 0.5965 | 43.75% |
| Zero control | 0.066585 | 0.402410 | 0.931281 | 0.0000 | 0.00% |

**Neither candidate passes the overall development screen.** The intensity
guard reduces MAE by 9.0% and preserves every declared wet/heavy decision, but
worsens the existing rain underestimation. The rain ratio is the ratio of
predicted to observed means under equal-date/hour/vintage weighting; it is not
a literal unweighted hydrologic total. The ordinary blend also loses event
detection. The zero control illustrates why mostly-dry MAE alone is inadequate.

Only the intensity guard's **literal 72-hour anchor** passes its individual
lead-band development screen: MAE improves from 0.106551 to 0.093866 mm/h
(11.9%), RMSE from 0.438666 to 0.398635 mm/h (9.1%), and observed-wet MAE from
0.845884 to 0.819785 mm/h (3.1%). Its balanced rain ratio shifts from 1.1512 to
0.8821, closer to one in absolute error, with unchanged event decisions.
This is one favorable slice among all reported bands, not evidence for hours
49–71, a selected deployment model, or a new holdout. No model was changed or
retuned after reading these results.

The saved-live complete-month fragment contains only six dates, with one wet
date and **zero supported model rows**; all candidates retain raw. Partial
September is separately reported: five anchor dates and six saved-live dates.
No short-lead ECMWF/Best-Match archive input was available in this run. No
first-twelve-hour improvement or live-source transfer has been demonstrated.

Aggregate receipts and validation evidence live under
`.omx/evidence/rain-rate-adjustment-20260908/`. Private inputs, model states and
predictions remain outside Git. Production rain remains unadjusted; a later
candidate needs adequate source-specific evidence, not relaxed gates or a
promotion based on the favorable 72-hour slice.

### Independent verification

The separate verifier passed exact input/forecast population binding, independent
reconstruction of every aggregate and development screen, frozen-model
prediction replay, and deterministic refitting of all 118 states (106 supported
anchor models and 12 unsupported live states). Refit serialized model JSON
matched the retained material. This reproduces the frozen learner rather than
independently implementing XGBoost; the scoring and chronology checks use a
separate implementation. It is not an accuracy qualification.

The full refit verification completed in 126 seconds with 671 MiB peak memory
under a six-gigabyte/no-swap bound. All 33 rain-related regression tests passed,
as did repository lint, TypeScript typecheck, Python syntax checks, and diff
whitespace checks. Humidity/pressure research code, queued recovery jobs, and
production behavior were not changed.

The 30-member private research snapshot was encrypted, decrypted for exact
member-by-member checksum verification, and copied to Blueberry with a matching
ciphertext checksum. The encrypted archive is retained under
`~/.weather/model-evidence/rain-rate-adjustment-20260908/` locally and the
corresponding `/home/admin/.weather/model-evidence/` directory on Blueberry.
The aggregate `retention-receipt.json` records the archive identity and checks.
This evidence upload did not deploy or modify a Weather service.
