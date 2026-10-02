# Rain research: prospective collection boundary

## Status

The bounded raw-rain monotonicity experiment independently passed 43 of 49
development gates, failing the same six as its wind parent. No candidate is
selected. See [the retained result](rain-monotone-research.md). The current
fixed-population performance goal is incomplete; a different cohort cannot
silently replace its evaluator inputs or be counted as its passing result.

The preregistered same-cohort tuning sequence is closed. This is an
evidence-quality stopping boundary, not a proof that no model could pass those
development gates. Credible independent qualification needs observations that
have not already driven candidate design and actual source receipt evidence.

## Existing collection does not satisfy the rain contract

- `packages/providers/src/open-meteo-single-runs.ts` requests 19 forecast hours
  containing temperature, humidity and wind speed only. It does not collect
  rain, cloud, pressure, direction or the required longer forecast trajectory.
- `packages/database/migrations/0013_ecmwf_temperature_canary.sql` stores leads
  1–18 for that temperature canary. Its authorization and storage must not be
  reused as an implicit rain-collection authorization.
- `apps/worker/src/worker.ts` runs the single-run sidecar within the temperature
  canary boundary. A persistent rain collector would be new backend scope.
- `packages/database/migrations/0010_forecast_training_export.sql` and
  `deploy/scripts/forecast-training-export.sh` retain receipt metadata but omit
  precipitation from the exported fields. Their forecast cohorts are not the
  complete matched single-run rain cohort.
- The export's seven research stations do not provide a receipt-complete
  equivalent of the twelve-gauge target defined in `rain_sub24.py` and
  `build_rain_sub24.py`. Hourly summaries cannot substitute for the complete
  interval tiling and causal receipt checks required by that target.

No direct production SQL bypass or unmatched archive substitution is justified.

## Minimum new capture boundary

Before new requests, freeze a bounded source protocol, supported model/grid,
station catalog, request schedule and limits, failure handling, retention and
evaluation cutoffs. Preserve original forecast bodies and receipt timestamps,
not just initialization time or normalized values. Capture the same run's rain,
temperature, humidity, cloud, pressure, wind speed and direction over the
required trajectory, including earlier cycles needed by the 107 features.

Capture complete interval-level rain observations and real receipt timestamps
for the same twelve physical gauges. Forecasts must be available by the fixed
decision time; station features must satisfy both event-time and receipt-time
cutoffs. Late receipts and missing intervals remain explicit, not backfilled
into earlier decisions. Retain immutable append-only evidence and independently
replay feature and target construction before fitting or scoring.

A private research-only collector avoids production migrations, but requires
its own bounded scheduling, retention and operational lifetime. A durable
Blueberry collector requires surgical provider/storage/worker changes, separate
rain authorization, integration tests, documented deployment and live
verification. Neither is an already configured rain service. Selecting this
operational scope is distinct from running another local model experiment.

## Fresh evaluation timing

The existing future-confirmation policy in `rain_event_guard.py` sets an earliest
decision of October 1, 2026. Retain its event and season support requirements:
at least 300 represented dates, 100 wet dates, 50 heavy hours, and at least 60
dates, 10 wet dates and five heavy hours in each season. These are observed-data
requirements, not a promised calendar completion date.

With uninterrupted collection and sufficient events, the seasonal calendar
alone cannot satisfy the summer minimum before late July 2027. A clean proposed
twelve-month envelope is October 2026 through September 2027; it is not yet an
activated or frozen qualification study. Actual missingness and rain support
may require longer. A new prospective evaluator must preserve gate definitions
while explicitly identifying its new cohort rather than modifying the frozen
32,896-row development evaluator.

Collection has not started, no production change was made, and no new cohort
has been scored. The [live forecast](https://weather.ballydidean.farm/forecast)
remains unchanged.
