# Rain direction: shorter-request feasibility

Both earlier acquisitions are closed and retained. The original client timed
out on the May 7, 2024 00 UTC run; the separate recovery received HTTP 200 with
53 plaintext bytes, `Unexpected error while streaming data: timeoutReached`.
Neither returned usable new forecast data for that initialization.

The upstream streaming writer can emit this text after an exception; archive
range reads have a 30-second retry deadline. That is consistent with the
observed response, not proof that the direction is missing. Server logs and the
deployed server revision are unavailable. [Stream writer](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Helper/Writer/JsonWriter.swift#L4-L24),
[archive retry implementation](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/OmFileIO/HttpClient%2BRetry.swift#L152-L203).

Freeze three diagnostic requests before any new retrieval:

1. May 7, 2024 00 UTC, precipitation plus direction, 35 hours.
2. The same initialization, direction only, 35 hours.
3. May 6, 2024 18 UTC, precipitation plus direction, 35 hours.

Use the exact original point, endpoint, model, default grid selection and units.
Keep a three-request/three-location cap, no retries, at least one second between
requests, 90-second socket timeout, 2 MB capture limit and the existing September
14, 2026 08 UTC expiry. Stop on HTTP 429; otherwise record all three fixed
diagnostics even if a preceding one fails. No labels or model outcomes are read.

Thirty-five hours covers leads 0–34, including every required direction lead
6–34. Compare precipitation only for requested leads 1–34. Direction-only
cannot prove rain parity; neither query establishes the unrequested tail.
Preserve every request, raw response and receipt. This probe cannot normalize
or authorize a complete model source. Upstream irregular-timestamp reads may
still fetch the whole stored run, so the shorter query is not a guaranteed
remedy. [Range construction](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Helper/ForecastapiQuery.swift#L510-L522),
[whole-run fallback](https://github.com/open-meteo/open-meteo/blob/9701689dd81ebef2d478800366c586c8a02c0c19/Sources/App/Helper/OmFileSplitter.swift#L86-L107).

Any later acquisition or explicit unresolved-transport missing-feature policy
must be separately preregistered before the wind model is fit. Do not call a
transport timeout a provider null, drop paired rows or loosen the 49 gates.

## Retained outcome

The two May 7 requests returned valid HTTP 200 forecast data. The combined
query matched all 34 requested original rain leads and supplied all 29 required
direction hours; direction-only supplied the same direction profile. This
establishes feasibility of the shorter request, **not that shortening caused
the recovery** rather than a transient backend condition clearing.

The third request returned HTTP 400 because May 6 at 18 UTC was not among the
original successful run set. The intended previous successful control was
12 UTC. This was a diagnostic run-selection error; preserve it and do not
claim a valid control comparison. Future source plans must derive every run
from the original manifest, not assume four daily cycles throughout history.

Independent replay verified all three outcomes, hashes and source boundaries.
Four targeted tests, 455 aggregate rain tests and Ruff passed. No diagnostic
response is promoted directly into the model source.

The [live forecast](https://weather.ballydidean.farm/forecast) is unchanged.
