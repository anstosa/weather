# Rain adjustment: probability-bin mean

## Preregistered hypothesis

The wind-vector model passed 43 of 49 development gates but still overpredicted
winter volume and missed seasonal and heavy-event requirements. Its hard
category projection can force a forecast above 1 or 2.5 mm even when a category's
calibration mean is lower. Test one different amount decision using the same
forecast information: a coherent four-bin distribution and its expected amount.

Only `softOrdinalWind` is selectable. All 14 existing wind-experiment arms are
unchanged controls, with its primary renamed `windOriginal`. Preserve all 73,744
paired rows, all 32,896 development forecasts, all 107 feature columns and the
same 49 gates. A plain wet-probability times Gamma mean was already tested; this
experiment instead uses all three intensity-tail probabilities and fit-only
bin means. This does not establish that a probability mean will pass: it may
reduce heavy-rain point-event detection further.

## Fixed predictor and amount rules

Reuse the 36 byte-identical monthly wind binary heads. The 12 Gamma heads remain
retained for provenance but are unused. No tree fitting, feature selection or
parameter search is performed by the new producer. Independently refit the
inherited heads to verify their provenance.

Keep the same expanding fit windows, 90-day calibration windows, seven-day
embargo, training/calibration support and effective-support rules. Recency
weights remain only in the existing effective-support check, not in the new
amount fit or probability calibration.

For each month, assign fit labels to `[0,0.1)`, `[0.1,1)`, `[1,2.5)` and
`[2.5,infinity)` mm. Set the first support amount to zero. Estimate each other
support amount from its original full-fit equal-date/hour/vintage weights,
restricted and renormalized inside that bin. Do not rebalance a bin's dates or
clip labels before taking the mean. Clip the resulting means into `[0.1,1)`,
`[1,2.5)` and `[2.5,30]`, using the preceding representable float for exclusive
upper bounds. Every wet bin requires ten unique hours across three dates.

Clip each native probability to `[0.000001,0.999999]`, then take cumulative
minimum across the increasing thresholds to make the tails nested. Apply one
shared log-odds offset `b=k/20`, with integer `k=-30…30`. Select exactly one offset
on the earlier calibration labels by minimum equal-date/hour/vintage weighted
four-class negative log likelihood. Use `max(class_probability,1e-12)` only
inside the logarithm. Exact score ties prefer smaller absolute offset, then
smaller offset. Retain every grid score, not only the winner.

The four masses are `1-p0`, `p0-p1`, `p1-p2` and `p2`. Predict their weighted
support-amount mean, clipped to `[0,30]`. No hard event categories, raw blend,
volume scale, seasonal factor or event-gate objective is applied. Missing overall
support, any unsupported wet bin or any missing native probability head causes
the entire month to use unchanged `ordinal90`; no rows are dropped.

## Verification and qualification

Freeze the source, parent model identities and policy before any new outcome.
Independently reconstruct source joins, all feature values, native heads, fit-bin
means, the complete offset grid, monthly states, all forecasts and all 49 gates.
Retain the outcome regardless of pass or fail. No failed threshold is relaxed.

September 2025–August 2026 is reused development data, not a fresh holdout.
Historical source availability remains simulated. A development pass still
requires separately frozen receipt-backed fresh-data qualification before
production promotion. The earlier source download's 25 scheduling violations
remain disclosed in its provenance; later completion did not erase them.

The [live forecast](https://weather.ballydidean.farm/forecast) remains unchanged.

## Recorded development result

The single primary failed 13 of the unchanged 49 gates. Independent replay
verified the complete source, all 107 features, all 48 inherited native fits,
12 monthly states, all 32,896 predictions and the gate results. All months met
support requirements; the chosen offsets were interior to the frozen grid.

Mean absolute error regressed to 0.104558 mm from the wind model's 0.101821 mm.
Annual volume ratio was 1.1516, but winter worsened to 1.5439 and spring fell
to 0.7876. Detection at 1 and 2.5 mm fell to 0.2242 and 0.0683 respectively.
Replacing category floors with a probability mean did not solve the seasonal
volume/recall problem; this candidate remains unselected.

The failures were the volume-control MAE comparison, 1 and 2.5 mm event safety,
winter volume, summer detection, spring volume/intensity/detection, both
same-window volume-control comparisons, ordinal MAE improvement, seasonal
balance improvement and heavy-skill retention. All 523 regression tests and
the full workspace checks passed; these do not override failed model gates.

An upper-air supplement is not a matched next source for this cohort: the
original 9-km HRES model lacks pressure-level fields, while the separate
0.25-degree model has different grid/time resolution and insufficient archive
coverage. Do not fill the missing historical cohort with a different model and
call it matched evidence. See the official [ECMWF model documentation](https://open-meteo.com/en/docs/ecmwf-api)
and [Single Runs archive coverage](https://open-meteo.com/en/docs/single-runs-api).
