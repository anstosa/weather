# Rain adjustment: matched archived wind direction

## Preregistered acquisition

Both completed spatial probes returned one identical model grid and profile.
Do not download twelve duplicate station points. Acquire a **separate wind
direction supplement** at the original point instead, without changing the
existing rain source, observations, evaluation rows or model gates.

Use the original 3,301 successful ECMWF initialization keys, not the 303 missing
original runs. The original normalized source SHA-256 is
`f70908479fea0b8c4fed548d611f1a3239addfd2b55c1dc19228211ca9e8ecc1`;
the original acquisition manifest SHA-256 is
`0a7345de730ccd2f92e6a699b8b71f58a77f47d8c6db531d31680c7b465d34fc`.
Freeze both inputs, their original producer snapshots, the new producer and
verifier, and the full request plan before making requests.

Request `ecmwf_ifs`, `precipitation,wind_direction_10m`, 49 UTC hours and the
original point (47.950429954185445, −122.42797012608193). Keep default land
selection and elevation behavior. Use only the public no-auth Single Runs
endpoint; no paid subscription, endpoint rotation or credential change.

### Pilot and bulk stages

Select six pilot initializations from chronological positions
`floor(q × (3301−1))` for `q = 0, .2, .4, .6, .8, 1`:

- 2024-03-14 00 UTC
- 2024-11-07 06 UTC
- 2025-04-21 06 UTC
- 2025-10-05 12 UTC
- 2026-03-19 12 UTC
- 2026-08-31 18 UTC

These positions are selected without observation labels. After independent
pilot verification, acquire the remaining 3,295 runs in chronological order.
The six pilot requests count toward the total; do not download them again.

The pilot identity verdict and the bulk-feasibility decision are distinct.
Bulk requires a hash-bound independent PASS and **nonnull direction for every
pilot lead 6–34 inclusive**. Those are the leads required by the next model's
six vector features. A structurally valid but insufficiently populated pilot
can pass identity verification while remaining ineligible for bulk download.

Hard limits across both stages: **3,301 HTTP requests and location units**,
one-second minimum request-start spacing, 30-second socket timeout, 2 MB body
limit, zero retries and no redirects. Expire the plan at **2026-09-14 08 UTC**.
Persist the request start before network access. Stop on the first failed
request, retain bounded failure evidence and never overwrite/retry that run.
An interrupted or failed batch is not a complete matched source.

The start-spacing minimum is approximately 55 minutes for the complete
batch. The separate quota context records the earlier six HTTP/eighteen-location
probe requests. Shared-IP usage by other clients and remaining allowance are
unknown; do not claim a complete provider-account quota ledger. Stop on HTTP 429.
The published free Single Runs limits are 600/minute, 5,000/hour, 10,000/day and
300,000/month. One-second spacing permits at most 3,600 starts/hour; the
3,301-request batch remains below the hourly cap even when completed in one
hour, excluding unknown other-client use. [Open-Meteo pricing](https://open-meteo.com/en/pricing).

## Source acceptance

For each response, independently require the exact initialization and all 49
UTC timestamps, variable names and units, original returned grid, and exact
precipitation parity against all 48 original lead-one-through-48 rows. Keep
lead-zero precipitation null distinct from zero. Do not replace or rebase the
original data if the archive has changed.

Retain raw bodies, request/response hashes, request and receipt UTC timestamps,
per-run identities and explicit direction null counts. Nullable directions in
the full batch remain missing predictors; never turn them into zero, remove
evaluation rows or borrow another initialized run. The forecast-only supplement
retains source response hashes and does not rewrite the original normalized
source. All private input/output artifacts stay outside Git and are encrypted
after verification.

## Evidence boundary and next model

The archive still does not establish historical issue or receipt times.
`actualIssueAt` remains null. The eight-hour forecast availability and one-hour
observation lag remain simulated research assumptions. Older archive sections
include hindcasts; this is not a newly independent historical evaluation.
[Single Runs documentation](https://open-meteo.com/en/docs/single-runs-api).

If the complete supplement verifies, test one preregistered monthly
`hurdleWind` model: preserve the original 101 trajectory features and append
eastward/northward forecast wind components plus their preceding/following
three-hour changes. Keep original training, calibration, fallback, fixed
controls and all 49 gates. No direction-feature outcome has been read at this
registration point. A separate fresh receipt-backed evaluation remains required
before any production qualification.

No application or production service changes are included. The live forecast
remains unchanged: <https://weather.ballydidean.farm/forecast>.

## Closed attempt: transport failure

The six-run pilot passed independent verification: all 288 original rain values
matched, all six grids matched, and all 174 required wind-direction values were
present. Bulk then stopped at the first 30-second read timeout, as registered.
The failed initialization is 2024-05-07 00 UTC (original run index 108).

The attempt retains 114 request starts, 113 successful raw responses and one
timeout receipt without a body or HTTP status. The 113 successes have exact
original precipitation/grid parity and complete direction footprints. No final
normalized source or model outcome was produced. Independent partial audit
passes preservation and provenance checks, **not acquisition completion**.

Source tests (8 producer and 18 independent verifier tests), targeted static
checks and a fresh full `npm run check` pass. Evidence and failed outcomes are
retained under `.omx/evidence/rain-direction-20260913/` and encrypted locally.

Next: a separately frozen transport-recovery plan may reuse the 113 verified
successes and request only missing initializations with bounded transient-error
retries. The zero-retry original plan remains failed and immutable; do not
restart it, silently reset request counts or weaken precipitation parity.
