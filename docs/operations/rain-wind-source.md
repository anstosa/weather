# Rain adjustment: qualified short-horizon wind source

## Preregistered source boundary

The original direction acquisition and its separate recovery are closed
failures, with all attempts and independent evidence encrypted locally. A
subsequent bounded diagnostic retrieved the previously failing initialization
with 35 forecast hours, matching the original rain for leads 1–34 and returning
all required direction hours. This proves a feasible request, not that shortening
caused recovery. Its invalid comparison initialization remains documented.

This new acquisition derives **every initialization from the exact original
3,301-run manifest**. Preserve 113 independently verified full-horizon responses;
request only the 3,188 remaining runs, chronologically. Diagnostic responses are
not model inputs. Copy and hash-bind the entire retained failed-recovery
envelope, including its failed response and the original acquisition lineage.

Keep the original point, model, endpoint, units, grid and default land selection.
Request precipitation and wind direction together, with `forecast_hours=35`.
Validate exact UTC hours, units, original grid and original precipitation at
every returned lead 1–34. No observation labels or model outcomes select requests.

## Fixed transport and qualification policy

Freeze this policy, all run IDs, producer and independent verifier before any
new request. Allow at most two attempts per missing run, 6,376 new HTTP/location
units overall, at least one second between starts, a 90-second socket timeout,
2 MB capture limit and the September 14, 2026 08 UTC expiry. A permitted retry
waits fifteen seconds after the preceding attempt ends.

Only specified transport exceptions, HTTP 502/503/504, or the exact retained
53-byte HTTP 200 streaming-timeout message may retry. After a second failure,
**only that exact HTTP 200 message** may become `transportUnresolved`. Other
exhausted failures stop the source. HTTP 429, other status codes, changed grid,
time, units, precipitation or schema, source drift and expiry stop it without
further requests. Retain every request, response body and receipt.

Unresolved transport is not a provider-reported missing value. Permit it only
when it is at most **1% of all original runs and 1% in every decision month**
(initialization plus eight hours), computed without labels. Use the exact
integer check `100 × unresolvedRuns <= totalRuns`, including small early
months. Failure of either source-quality bound prevents the model experiment;
it does not change any of the 49 model gates.

The known earlier quota consumption is 115 direction attempts plus 21 location
units from spatial/timeout diagnostics. The conservative combined known cap
is 6,512 units. Shared-IP consumption is unknown; a 429 is a stop condition,
not an invitation to rotate endpoints. [Provider limits](https://open-meteo.com/en/pricing).

## Explicit normalized provenance

Retain every original run and all 48 original rain leads in 158,448 normalized
rows. For a new successful response, direction leads 1–34 are `available` or
`providerNull`; unrequested leads 35–48 are null and `notRequested`. An inherited
full-horizon response retains its actual 48 direction leads. An unresolved run
has null directions and `transportUnresolved` at all 48 leads. These four states
must never be conflated or replaced with zeros.

The original rain always comes from the byte-pinned original archive. Concurrent
rain parity is proved for 48 inherited leads, 34 newly acquired leads, and zero
unresolved leads; no tail or failed response receives an invented parity claim.
Per-run lineage binds the selected raw response or final exact timeout receipt.

All six proposed vector features use only direction leads 6–34. An unresolved
run therefore retains all paired rows and original 101 feature columns, with
only the six new columns left NaN. No source-status predictor is added. Report
source missingness by month separately from genuine nullable forecast cells.

Require independent raw-response, retry, source-quality, lineage and normalized
replay, then encrypted retention, before preparing the wind model. A source
qualification pass is not a model pass, historical as-issued proof or fresh
holdout qualification. Provider outages may be nonrandom; any development
success remains a hypothesis for separate prospective testing.

## Interrupted outcome

This acquisition was stopped after 1,601 new attempts: 1,600 valid responses
and one transport retry followed by success. Together with the 113 inherited
responses, 1,713 original runs have verified forecast data; 1,588 remain.

The scheduler measured its interval before request bookkeeping. Variable
bookkeeping latency caused 25 recorded start intervals shorter than the frozen
one-second minimum (shortest 0.990233 seconds). This is a producer scheduling
bug, not a provider or forecast-value failure. Do not restart or qualify this
acquisition. It produced no terminal source report or normalized source.

Independent interruption review verifies forecast integrity while explicitly
marking transport-policy compliance and source qualification false. Preserve
both the 1,600 valid responses and the scheduling failure. A separate successor
may inherit those byte-verified forecasts with the failure disclosed, but must
freeze a corrected completion-based scheduler and independently verify the
remaining acquisition. No model has been fit on this partial source.

The [live forecast](https://weather.ballydidean.farm/forecast) is unchanged.
