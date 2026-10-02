# Rain adjustment: controlled coastal grid-selection probe

## Preregistered next step

The first two-run probe returned one identical model grid and precipitation
trajectory across three gauges under default grid selection. Do not expand that
request into twelve-point bulk acquisition. Instead, compare **both `land` and
`nearest` at the same three high-weight central gauges**, so coordinate changes
cannot be mistaken for the effect of grid selection.

Fixed locations from the existing observation catalog:

| Gauge | Latitude | Longitude |
| --- | ---: | ---: |
| `tempest-225947` | 47.94215 | −122.42542 |
| `tempest-38270` | 47.95293 | −122.41414 |
| `tempest-126537` | 47.95820 | −122.44274 |

Use the same two initialization times, 2026-05-12 00 UTC and 06 UTC. Each mode/run
combination is one three-location request: **four HTTP requests and twelve
location/run units maximum**, no retries or redirects. Freeze exact sites, modes,
runs, source hashes and the **2026-09-13 08:00 UTC** expiry before requests.
Keep the earlier two-second spacing, 30-second timeout, 2 MB body limit, strict
49-hour UTC identity/unit/null checks, ID-based response mapping, bounded raw
failure retention, and one-shot request accounting.

Request only total precipitation and 10 m wind direction with `ecmwf_ifs`; leave
elevation and every other provider parameter unchanged. Compare returned grid
coordinates and forecast profiles, never observation labels or model scores.
Stop on the first failed request and retain it. This new cap is separate from
the completed two-request/six-location first probe; it does not reset or erase
that earlier usage.

## Confirmed provider semantics

Single Runs supports Forecast API parameters. `nearest` chooses the closest
model grid point without a land filter. Default `land` searches for a suitable
land/elevation match but can also fall back to water. Coastal `nearest` results
may therefore be sea cells and must not be described as land observations.
[Single Runs API](https://open-meteo.com/en/docs/single-runs-api),
[Pinned grid-selection implementation](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Domains/Gridable.swift#L89-L108).

Returned latitude/longitude identify the selected model grid center. Returned
elevation is the **target elevation**, not necessarily grid elevation. Do not
also set `elevation=nan`: that changes downscaling and would confound this probe.
[Pinned response path](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Controllers/ForecastapiController.swift#L433-L447).

## Interpretation and stop rules

Distinct profiles would establish only new source information. Map all twelve
catalog gauges once under a separately bounded plan before proposing any
full-history acquisition. If high-weight gauges remain duplicates, spatial bulk
is not justified; investigate the newly confirmed wind-direction field and
receipt-backed prospective collection instead.

Both runs remain retrospective archive probes. They cannot prove historical
publication time, turn the consumed development year into a holdout, or satisfy
any model gate. The latest rain candidate still fails nine of the fixed 49
checks. No model fitting, production export change, service change or deployment
is included here. The live forecast remains unchanged:
<https://weather.ballydidean.farm/forecast>.

## Retained outcome

All four requests succeeded within the frozen cap. Every mode/run pair returned
one grid center (47.97891, −122.44185), one precipitation profile and one wind
direction profile across the three sites. The six matched site/run comparisons
between `land` and `nearest` have zero grid, precipitation or direction
differences. Each location retains 48 nonnull rain hours plus the null lead zero,
and 49 nonnull direction hours.

Independent reconstruction validates request timing, IDs, units, all body and
parameter hashes, and 288 exact land-mode precipitation comparisons against the
original frozen source. These two runs do not establish full-archive parity.

All 379 rain tests and fresh workspace lint pass. No model was fit or selected.
The larger station-point download is rejected at this feasibility stage. Next,
acquire the missing wind-direction field at the original single point under a
new bounded, staged plan, requiring original precipitation parity before model
use. Preserve both completed probes and the failed model gates.

Evidence: `.omx/evidence/rain-nearest-probe-20260913/`.
