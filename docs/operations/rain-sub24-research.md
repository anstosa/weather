# Sub-24-hour rain adjustment research

## Result — September 9, 2026 UTC

**The data expansion succeeded; the first model did not qualify.** No rain
adjustment was activated and the production forecast remains unchanged.
Humidity and pressure adjustment models are out of scope.

The selected occurrence/amount model reduces hourly MAE by **16.43%** relative
to its raw ECMWF source, but loses to simple prior-period volume calibration
and increases wet-hour and heavy-hour intensity error. It must not be described
as a good or production-ready first-day rain model.

## Data and coverage

- Production was audited read-only. Saved sub-24-hour forecasts only start on
  August 25, 2026; older production anchors at 24/48/72/96/120/144/168 hours
  cannot establish first-day performance.
- A separate ECMWF single-run archive supplies **3,301 initialized runs** on
  **all 901 dates from March 14, 2024 through August 31, 2026**. Each retained
  run has original leads 1–48: **158,448 hourly rows**. There are 303 explicit
  run gaps, mostly unsupported early 06/18 UTC cycles, not fabricated forecasts.
- Seven existing production Tempest gauges were supplemented by five distinct
  nearby gauges with older interval histories. The twelve-gauge pool is within
  **4.84 km** of the site. Additional acquisition independently reconstructed
  **6,047,763 normalized rows from retained original response bodies**. Ten
  reused discovery station-days have only their original normalized bodies;
  this exception is retained explicitly. Seventy-four missing station-days
  remain missing.
- The resulting network has **21,442 supported hourly rain targets on 904
  dates**. Pairing produces **73,744 forecast/target rows**, 21,164 distinct
  valid hours and 899 usable initialization dates.

This is **two-plus years of forecast history and twelve historically
contributing rain gauges**, not twelve simultaneously complete gauges for two
years. Only 112 hours have all twelve gauges complete. The newest gauge has
48 dates of complete-hour data. Duplicate provider feeds, rate-only stations
and non-rain sensors are not counted as additional rain gauges.

| Tempest station | Complete hours | Dates with complete hours | First complete date |
| --- | ---: | ---: | --- |
| 64255 | 16,980 | 785 | 2024-03-13 |
| 225947 | 1,051 | 48 | 2026-07-14 |
| 38270 | 20,966 | 904 | 2024-03-13 |
| 168853 | 6,635 | 521 | 2025-01-23 |
| 126537 | 18,778 | 900 | 2024-03-13 |
| 201058 | 5,117 | 237 | 2025-12-22 |
| 203055 | 5,933 | 252 | 2025-12-25 |
| 66270 | 18,273 | 879 | 2024-03-13 |
| 34768 | 15,838 | 780 | 2024-03-13 |
| 88159 | 19,697 | 890 | 2024-03-13 |
| 126197 | 20,483 | 891 | 2024-03-13 |
| 27140 | 20,349 | 891 | 2024-03-13 |

## Target and causality

The target is a local network proxy, not a directly measured farm-site truth:
the spatially weighted median of complete backward-hour gauge accumulations.
At least three complete gauges and one of the nearest three are required.
Intervals must tile 60 minutes without gaps or overlaps, with at most five
minutes of endpoint lag. An hour's accumulation in mm is numerically its
hour-average rain rate in mm/h; instantaneous rain rate is not evaluated.

The simulated decision time is initialization plus eight hours. Station
features end at least one hour before that decision. Output horizons **1–23
hours after decision** therefore use original model leads **9–31 hours**, not
the misleading first 23 hours after initialization. Historical actual
publication and observation receipt times are unavailable; simulated delays
do not establish operational as-of correctness.

Applicability uses raw forecast target-hour temperature above 2°C, available
at decision time. Future observed temperature is never an eligibility feature.
Raw forecast humidity is only a rain predictor, not a humidity adjustment.
The archive is kept as its own source cohort; older BestMatch anchors and
saved-live forecasts are not pooled into its qualification scores.

## Frozen experiment

Development decisions cover March–August 2025, with labels ending August 24.
Evaluation decisions cover September 2025–August 2026. Fixed monthly expanding
refits use only earlier labels, a seven-day gap, 45 days of calibration, and a
second seven-day embargo before evaluation. This is a prequential replay,
not one model trained through the end of the evaluation year. Some weather
outcomes overlap prior rain research, so this is not a pristine project-wide
untouched weather holdout.

Shallow CPU XGBoost 3.4.1 models predict wet occurrence (at least 0.1 mm/h),
positive gamma amount and a Tweedie alternative. A fixed development-only grid
selected `hurdle-p0.5-raw0.25`: 75% probability-gated occurrence/amount estimate
plus 25% raw, with earlier-only volume calibration. Candidate selection and
hyperparameters were not changed after evaluation.

Scores give each UTC date equal mass, then each distinct hour within that
date equal mass; overlapping forecast vintages split their hour's mass.
Conditional wet/heavy MAE rebalances within that conditional population.
The balanced volume ratio is not an unweighted hydrologic rainfall total.

## Evaluation

The replay contains 32,896 predictions, 8,641 unique valid hours, 131 wet dates
and 203 heavy hours (at least 1 mm/h). Decisions span twelve months; trailing
targets reach September 1, 2026, giving 366 represented target dates.

| Metric | Raw ECMWF | Earlier-only volume scaling | Selected model |
| --- | ---: | ---: | ---: |
| Hourly MAE, mm/h | 0.126445 | **0.103392** | 0.105668 |
| Hourly RMSE, mm/h | 0.519372 | **0.437963** | 0.454906 |
| Observed-wet MAE, mm/h | 0.819612 | **0.784215** | 0.853604 |
| Heavy-hour MAE, mm/h | **1.472778** | 1.576329 | 1.620776 |
| Balanced volume ratio | 1.541668 | **1.051359** | 1.064401 |
| Critical success index | 0.304828 | **0.339894** | 0.325569 |
| False-alarm ratio | 0.671832 | 0.603696 | **0.580632** |
| Wet-event detection probability | **0.810822** | 0.704834 | 0.592767 |

The selected model's wet-hour error rises **4.15%** and heavy-hour error rises
**10.05%** versus raw. Wet-event detection falls from 81.1% to 59.3%; improved
CSI does not erase those missed events. Seasonal volume is also unstable:
1.442 in winter and 0.594 in spring despite an apparently balanced annual
ratio. The zero-rain control has lower unconditional MAE (0.073810) but no
event detection and is not a valid rain-model candidate.

Hourly MAE improvements are 17.41% at horizons 1–6, 15.65% at 7–12, and 16.24%
at 13–23. The seven-calendar-day block bootstrap gives a 95% interval of
−0.03523 to −0.00981 mm/h for candidate-minus-raw MAE. Complete same-run
6/12/23-hour accumulation MAE also improves versus raw, but simple volume
scaling is better at all three lengths. The current archive era after the
May 12, 2026 model change has only 19 wet dates and no winter evaluation.

The prespecified failed gates are: beat simple volume calibration, preserve
wet-hour intensity, and preserve heavy-hour intensity within 5%. Other passed
gates do not override these failures. No baseline was promoted after seeing
the evaluation results.

Review also found a selection-design problem: development screening omitted
the final heavy-intensity gate. The selected candidate's development heavy
MAE was already about 10.2% worse than raw. A consistent development screen
would have stopped it before opening evaluation. This is recorded rather
than silently changing the frozen experiment or selecting another candidate.

## Verification and continuation boundary

Independent verifiers reconstructed forecast and station inputs, reloaded all
54 native boosters across 18 monthly states, replayed predictions and earlier
calibration, and recomputed selection, scores, confidence intervals,
accumulations and all qualification gates. The verifier initially exposed a
float32 accumulation reduction-order difference; only the verifier was fixed,
with a synthetic regression. Model bytes, selection, predictions, reports and
numeric comparison tolerances were unchanged. The corrected replay passed.

Sources, frozen revisions, inputs, models, predictions and aggregate evidence
are retained privately. Exact member hashes and the retention receipt identify
the encrypted archive; no raw station data or model blobs belong in a public
preview. Aggregate evidence lives under `.omx/evidence/rain-sub24-20260908/`.
The full workspace `npm run check` and targeted research tests passed.

### Forward-only review corrections

The runner now validates the forecast-temperature and complete-gauge eligibility
gates before fitting. Accumulation scores now balance window endpoints by UTC
date and distinct hour, matching the hourly scoring policy. The original
retained accumulation metrics used unweighted window means and totals; their
reported improvements above describe that historical calculation, not the
corrected weighting. Those historical reports and qualification gates have not
been regenerated, and the failed-model conclusion is not promoted or revised.

New observation receipts also identify the source-bound seven-station catalog
policy. These source changes require a new legitimate research freeze; they do
not modify existing frozen evidence or authorize reuse of consumed evaluation
dates as a new holdout.

The data-acquisition shortage is resolved for this research pool, but the
requested good first-day model remains unachieved. A next experiment needs
seasonally representative development, explicit wet/heavy and detection
safety during selection, and an honestly new evaluation boundary. Repeatedly
tuning on this consumed year cannot create independent evidence. Production
activation additionally requires a rain-capable source collector, real receipt
timestamps, causal station-feature replay, inference/qualification integration,
and the documented Blueberry release and live verification process.

Sources: [Open-Meteo single-run archive](https://open-meteo.com/en/docs/single-runs-api),
[Open-Meteo usage limits](https://open-meteo.com/en/pricing), and
[public Tempest discovery map](https://tempestwx.com/map/47.95043/-122.42797/13).
The unchanged application is at <https://weather.ballydidean.farm/forecast>.
