# Rain adjustment: issued wind-vector context

## Preregistered next hypothesis

The monthly trajectory candidate retained heavy-event skill but failed ten
fixed checks; daily recalibration still failed nine and lost heavy-event skill.
Both spatial probes found duplicate grids. The next experiment therefore adds
wind direction as new forecast information rather than repeating scalar or
cadence adjustments on the same inputs.

Require the separately frozen 3,301-run direction supplement to pass its
independent source-quality audit and encrypted retention first. Preserve the
original archive, observation labels, 73,744 paired rows and 32,896 development
forecasts. A partial download or changed original precipitation is not an
acceptable replacement source. The first acquisition and its recovery stopped
on transport/streaming timeouts. The [short-horizon source](rain-wind-source.md)
then stopped on a scheduling bug; its 1,600 verified new responses and 113 earlier
responses remain retained alongside that failure. A separately registered
[completion-spaced continuation](rain-wind-continuation.md) acquires only the
1,588 remaining original runs. The inherited scheduling failure stays explicit,
not retroactively qualified. It may mark only tightly bounded,
explicitly unresolved streaming failures as missing directions, never provider
nulls or zero. The source must meet its 1% overall and per-month unresolved-run
bounds before any model fit. The six feature definitions, learner, observations
and 49 model gates remain unchanged; all failed attempts remain retained.

Only `hurdleWind` is selectable. The eleven recency arms, original hurdle and
original monthly trajectory candidate are unchanged controls. September
2025–August 2026 remains consumed development data; repeated experiments do not
restore a holdout.

## Exact feature change

Preserve the first 101 trajectory columns and append exactly six columns:

1. eastward component `u(L)`
2. northward component `v(L)`
3. `u(L) − u(L−3)`
4. `v(L) − v(L−3)`
5. `u(L+3) − u(L)`
6. `v(L+3) − v(L)`

Here `L=8+h` for decision-relative horizon `h=1…23`. All values come from the
same original initialized forecast run, and initialization plus `L` must equal
the paired valid hour. The required source leads range from 6 through 34.
Future valid times within that already available run are not future
observations or later initialized runs.

Using the original archived wind speed `s` and supplemental meteorological
direction `d`, compute `u=−s×sin(d)` and `v=−s×cos(d)`. Normalize 360 degrees to
zero, convert degrees to radians, perform vector and difference calculations in
float64, then cast the six finished columns to float32. The convention follows
[ECMWF/Copernicus guidance](https://confluence.ecmwf.int/spaces/CKB/pages/133262398/ERA5%2BHow%2Bto%2Bcalculate%2Bwind%2Bspeed%2Band%2Bwind%2Bdirection%2Bfrom%2Bu%2Band%2Bv%2Bcomponents%2Bof%2Bthe%2Bwind). Missing speed or
direction remains NaN, including at calm speed. Reject infinity, out-of-range
inputs, incorrect run/hour identities and incomplete source-run coverage. A
source-qualified unresolved run leaves only these six new columns NaN, with
all original 101 columns and paired rows unchanged. Unrequested direction tail
leads 35–48 are explicitly marked and never used. Do not remove rows, substitute
another run, add source-status predictors or select a feature subset after
seeing outcomes.

## Unchanged learner and screen

Use the original monthly trajectory learner: uniform equal-date/hour/vintage
fit weights, wet-only rebalanced gamma weights, three binary heads plus one
gamma head, 160 rounds and unchanged native parameters. This is not the failed
training-decay, nested-capacity or daily-calibration experiment.

Keep the original outer fit, 90-day calibration window, seven-day embargo,
support rules, uniform event calibration, nesting safety and hurdle-category
amount calibration. Unsupported months fall back to unchanged `ordinal90`, as
in the original monthly trajectory runner. Use a feature-width-aware native
loader; the older 95-column recency loader is not suitable for 107 columns.

Evaluate the single new primary against all unchanged 49 gates and controls.
Require independent reconstruction of source joins, all features, all native
fits, monthly states, predictions and gates, plus regression/static checks.
Retain failures without loosening thresholds or promoting a control post hoc.

## Qualification boundary

Historical forecast issue receipts are missing. Initialization plus eight hours
and observation availability at decision minus one hour are simulated. Even an
all-gates development pass requires a separately frozen fresh-data,
receipt-backed confirmation before production promotion.

No service or application change is included. The live forecast is unchanged:
<https://weather.ballydidean.farm/forecast>.

## Recorded development result

The single wind-vector primary passed 43 of the 49 fixed gates and remains
unselected. Independent reconstruction verified all 48 native fits, 12 monthly
states, 32,896 development predictions, unchanged controls and all 49 gates.
The complete source union had no transport-unresolved runs; wind vectors were
available on 32,873 development rows, with the other rows retained unchanged.

Mean absolute error was 0.101821 mm, improving on the recent-volume control's
0.102662 mm. Annual volume ratio was 1.1463. Winter volume remained excessive
at 1.3955; the other seasonal ratios were 0.9523 (summer), 0.9596 (spring) and
1.1072 (autumn). Detection at 1 mm fell to 0.4168 versus the unchanged ordinal
control's 0.4771, although detection at 2.5 mm improved to 0.2175.

The six failed gates were winter volume, summer wet/heavy intensity, summer
detection, spring detection, seasonal balance improvement and heavy-skill
retention. This is useful predictor evidence, not a qualified rain model.

The next bounded hypothesis is a coherent probability-bin mean instead of hard
category floors. A plain wet-probability times Gamma-mean model was already
tested earlier and is not a new experiment. Any successor must be separately
preregistered and retain the same development population and gates.
