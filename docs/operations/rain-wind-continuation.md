# Rain wind source: completion-spaced continuation

## What this plan inherits

The preceding source run failed its scheduling policy and remains unqualified.
Its independent interruption audit nevertheless verified the forecast data in
all 1,600 successful new responses, alongside 113 earlier full-horizon responses.
The 25 sub-second start gaps remain recorded; this plan does not relabel them
as compliant or erase the failed source qualification.

Inherit only those 1,713 byte-verified original forecasts, after copying and
rechecking the entire encrypted-retention manifest and interruption proof.
Request the remaining 1,588 original run IDs, derived from the frozen original
manifest rather than an assumed daily cycle schedule. The first missing run is
July 28, 2025 at 00 UTC. No observation labels or model outcomes select this set.

## Corrected scheduler and unchanged data checks

The old collector measured intervals before variable request bookkeeping. The
new scheduler starts its timer **after the preceding attempt and durable receipt
have completed**. Wait at least 1.05 seconds before another request, or 15.05
seconds before a permitted retry. The extra 50 milliseconds is a conservative
clock/precision margin; independent verification still requires at least one
second after the previous receipt's finish, or fifteen seconds for a retry.
Recheck the monotonic deadline after an early wakeup.

Reuse the frozen 35-hour, two-variable request/response contract and validators.
Allow two attempts per missing run, at most 3,176 new HTTP/location units, the
same 90-second timeout and 2 MB response cap, and the September 14, 2026 08 UTC
expiry. Preserve all attempts. Retry only the already specified transport
classes, gateway statuses and exact known streaming-timeout signature.

Only the exact second HTTP 200 streaming timeout may remain explicitly
unresolved. Keep the same strict 1% overall and per-decision-month unresolved
run bounds, computed across all original runs. Stop immediately when a fixed
bound is irreversibly exceeded. HTTP 429, other forbidden responses, changed
grid/time/units/rain/schema, expiry or source drift stop further requests.

There were 1,716 earlier direction attempts and 21 other known location units.
The conservative combined maximum is 4,913 units; shared-IP usage is unknown,
so quota refusal remains a stop condition.

## Honest source lineage and qualification

Use explicit lineage origins: `parentInherited` for the 113 full-horizon
responses, `interruptedInherited` for the 1,600 copied short-horizon responses,
`newAcquired` for new successes, and `transportUnresolved` when permitted.
Preserve the normalized 48-lead original rain and separate direction statuses.
No unrequested tail direction or failed response is called a measurement.

Current source qualification requires the complete 3,301-run union, exact
forecast integrity, unchanged missingness bounds, and compliant **new** request
timing. It must also explicitly carry `parentTransportPolicyConformant=false`,
`parentSourceQualified=false` and `inheritedSpacingViolationCount=25`. This is
acceptance of verified forecast data from a disclosed failed acquisition, not
a retroactive pass for its transport policy.

Independently replay both the inherited evidence and all new requests,
normalization and lineage, then encrypt the completed source before fitting the
single registered wind model. The original 101 columns, six vector definitions,
all paired rows, 14 arms and 49 model gates remain unchanged. Historical issue
times and fresh-data qualification remain unproven.

The [live forecast](https://weather.ballydidean.farm/forecast) is unchanged.

## Recorded result

The continuation completed on September 13, 2026 with 1,593 new attempts:
1,588 successful original runs and five transient failures recovered on retry.
No run remained transport-unresolved. The independently reconstructed union
contains all 3,301 original runs and all 158,448 original rain rows. The minimum
new completion-to-start interval was 1.057036 seconds. The parent acquisition's
25 scheduling violations remain explicitly nonconformant.

Independent source replay passed, as did 502 rain regression tests and the full
workspace lint, typecheck, tests and build. Source qualification is not a model
gate pass or fresh-data confirmation. The normalized supplement contains
113,443 available directions, 373 explicit provider nulls and 44,632 unrequested
tail leads; these distinct states are preserved rather than filled with zeros.
