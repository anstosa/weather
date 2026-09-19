# Rain adjustment: bounded spatial-input feasibility

## Why this step

The independently verified daily model still fails nine of 49 fixed development
gates. More same-source scalar, cadence or capacity tuning is poorly supported.
The observed target is a spatially weighted gauge-network median, while the
retained ECMWF forecast is requested at one location. The next step checks whether
gauge-aligned requests expose genuinely different forecast information, without
training a model or reading observation labels.

The existing request location is 47.950429954185445, −122.42797012608193. All
3,301 retained successful runs returned grid coordinate 47.97891, −122.44185,
about 3.33 km north of the site. Gauge-to-grid assignments elsewhere are unknown;
distance alone cannot establish them.

## Fixed tiny probe

Before HTTP requests, freeze a new, expiring plan and producer source hashes in a
separate private research root. Do not reuse the expired original acquisition
plan or its incompatible bulk-acquisition wrapper.

- Exactly two runs: **2026-05-12 00 UTC and 06 UTC**, straddling the documented
  ECMWF cycle boundary. Both run identities succeeded in the old site acquisition.
- Exactly three catalog locations: `tempest-126197` (47.91413, −122.41471),
  `tempest-27140` (47.98707, −122.46295), and `tempest-38270`
  (47.95293, −122.41414). These fixed coordinates test the south-east,
  north-west and central-east footprint, not favorable forecast outcomes.
- Two HTTP requests using the provider's multi-coordinate API: six location/run
  combinations total. No retries, redirects, alternative providers or bulk follow-up.
- Only `precipitation` and `wind_direction_10m`, fixed `ecmwf_ifs`, UTC/GMT,
  hours 0–48 inclusive. Total precipitation matches the existing source variable;
  the separate `rain` variable would exclude showers.
- At least two seconds between request starts; 30-second request timeout;
  2 MB response cap; recheck expiry before every request. Stop on the first HTTP,
  identity, schema or completeness error and retain the failure.
- Preserve raw response bytes, request identity and hash, local request/receipt
  UTC timestamps, safe response headers/status, returned grid/elevation, units,
  exact run/valid-hour alignment and missingness. Null precipitation is not zero.
- No observation labels, model fitting, accuracy scores or gate changes.

Map response locations by their zero-based `location_id`, not an assumed array
position. The upstream parser assigns IDs from request-coordinate offsets, and
its JSON writer omits ID zero. Accept at most one absent ID as zero and require
the complete unique set `{0,1,2}`; retain each original response index. Reject
duplicate, null, boolean or out-of-range IDs. This is pinned upstream behavior,
not a claim of a broader documented JSON-ordering guarantee.
[Coordinate parser](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Helper/ForecastapiQuery.swift#L375-L411),
[JSON identity writer](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Helper/Writer/JsonWriter.swift#L79-L89).

Multi-coordinate requests, returned grid coordinates, variable definitions and
the individual-run interface are documented by Open-Meteo.
[Forecast parameters](https://open-meteo.com/en/docs),
[Single Runs API](https://open-meteo.com/en/docs/single-runs-api).

The public endpoint has no API key in the existing acquisition path. Current free
noncommercial limits are 600 calls/minute, 5,000/hour, 10,000/day and 300,000/month.
This probe adds at most six location/run units and does not subscribe to or charge
a paid account. Shared-IP remaining quota is not independently known; an HTTP
rate-limit response stops the probe instead of triggering retries.
[Provider pricing and access](https://open-meteo.com/en/pricing).

## Interpretation boundary

Different grid cells or differing precipitation trajectories demonstrate only
source diversity, not improved model skill. The two distant gauges together
carry about 5.3% of target catalog weight; seven near-site gauges carry 80.8%.
Distinct cells found only at those distant points would therefore be weak
evidence for changing the weighted-median forecast. Check high-weight central
gauges under a separately frozen follow-up before considering bulk acquisition.

The provider describes pre-2026-05-12 06 UTC ECMWF material as Cycle 49R1
hindcasts. Its `run` is model initialization, **not publication time**. The
model-updates metadata describes latest-run availability, not a historical
per-run receipt lookup. Locally recording a historical response today cannot
establish that those bytes were available at initialization plus eight hours.
[Archive description](https://open-meteo.com/en/docs/single-runs-api),
[Availability metadata](https://open-meteo.com/en/docs/model-updates).

Operational Cycle 49R1 began on 2024-11-12; Cycle 50R1 began on 2026-05-12.
Early archive coverage is consequently retrospective, and the contemporaneous
as-issued status of all consumed development bytes is not established.
[ECMWF 49R1](https://confluence.ecmwf.int/pages/viewpage.action?navigatingVersions=true&pageId=462913270),
[ECMWF 50R1](https://confluence.ecmwf.int/spaces/FCST/pages/567162191/Implementation%2Bof%2BIFS%2BCycle%2B50r1).

New inputs on September 2025–August 2026 remain development data, not a fresh
holdout. No local untouched, receipt-backed sub-24-hour rain pairing is currently
proven. The existing forced read-only production training export omits rain;
do not bypass it with direct production SQL. Fresh rain receipt capture or a
reviewed export-scope change would be separate work before qualification.

This probe cannot satisfy the model's 49 gates and does not authorize promoting
any failed model. The live forecast remains unchanged:
<https://weather.ballydidean.farm/forecast>.

## Verified probe result

Both HTTP requests succeeded within the frozen two-request/six-location cap.
For **both runs**, all three gauges returned the original grid
**47.97891, −122.44185** and identical precipitation and wind-direction series.
Each location had 49 wind-direction values, 48 precipitation values, and an
explicit missing precipitation value at initialization hour zero. Returned
elevations are target elevations; they do not establish different model cells.

Independent audit verified request spacing, caps, raw-body/parameter hashes,
location mapping, exact UTC hours, units, missingness and summary reproduction.
All precipitation leads 1–48 at each site/run match the retained original ECMWF
source exactly: **288 numeric comparisons**, confined to these two runs. This is
not evidence of full-archive stability or historical as-issued availability.

Eight mock-only probe regressions and all **370 rain tests** pass. Repository
lint passes; the earlier same-session full lint/typecheck/test/build check remains
applicable to unchanged application sources. All earlier model failures remain
retained; the model evaluator still fails nine of 49 gates.

- Plan: `84f0194cc0fe9c772a4359cb57a6c5c55793467c27810369a22c15e151dcc82f`
- Freeze: `c408217c4a3da983c777d0a6f287c3369137040ecd7fc6df9e9bab9fddfe66bf`
- Report: `1c42d293ddf2a9b4677f6c51ecc4f4fa30e963c2f28195594e72f72a6ddc79fe`
- 00 UTC response: `40b0557fd458cac78bfee885f99b9920f8e5c366919118c8422a8a9bc4f890b1`
- 06 UTC response: `a82e33fc1506d73e7c5fedaf661fc8e1e4ba0e0cd00bfb6f4a5564c6e29f300d`

Receipts and the independent replay script are in
`.omx/evidence/rain-spatial-probe-20260913/`. The private root and raw responses
are retained through local encrypted backup. No production change was made.

## Next bounded step

Do not bulk-fetch twelve duplicate default-grid profiles. Compare `land` versus
`nearest` at the same three high-weight central gauges under a new tiny plan.
Keeping both selection modes at identical coordinates avoids attributing a
coordinate change to the grid-selection parameter. Neither mode comparison may
use labels, change the 49 model gates or establish historical issue time.
