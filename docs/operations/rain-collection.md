# Prospective rain evidence on Blueberry

## Scope and activation

This collector stores source evidence only. It does not train, select, qualify
or enable a rain adjustment, change the existing forecast, or extend the
temperature canary's authorization. The previous development goal remains
unachieved; a successful collection job is not a passing model.

The fixed `rain-prospective-capture/v1` policy lives in
`packages/domain/src/rain-collection.ts`. Production Compose explicitly enables
the collector; local and verification Compose disable it. Worker activation
also requires the Ballydidean site, an immutable release label and no
compatibility-provider override. This is an explicit environment opt-in, not
host attestation: do not copy production activation into a disposable worker.
The policy expires October 8, 2027. A new
release can disable the collector; existing receipts must not be deleted or
rewritten to reset its budgets or history.

Station capture additionally requires confirmed provider entitlement.
`stationAccessAuthorized` is initially false: the existing Tempest credential
and earlier public access do not establish authorization for this persistent
twelve-station service. Current [Tempest access policy](https://apidocs.tempestwx.com/reference/remote-data-access-policy)
requires appropriate access to other public stations' observation data; its
[device API reference](https://apidocs.tempestwx.com/reference/getobservationsbydeviceid)
does not publish a numeric per-key quota. An authorized key/agreement and its
limits must be confirmed before enabling station polling. The collector must
report forecast-only capture honestly while that requirement is unresolved.

## Frozen capture schedule

- Forecast: the same `ecmwf_ifs` Single Runs source, fixed farm coordinates,
  original returned grid, seven variables and 49 hours including initialization.
  Retain leads 1–48 for raw precipitation, temperature, humidity, cloud,
  pressure, speed and direction, including prior-cycle feature construction.
  One attempt is eligible at initialization +6 hours; a second slot starts at
  +7 hours and closes at +12 hours. A valid earlier receipt suppresses the
  second request. Late warmup receipts remain retained but cannot establish
  availability at the fixed initialization +8-hour decision.
- Stations, when separately authorized: the original twelve physical gauges
  and frozen device identities. Each receives one two-hour observation-window
  request per hour. The endpoint is one second after the hour so the exact-hour
  observation is included. Wait at least two minutes before requesting it.
  Rotate gauge priority each hour and spread work across worker iterations.
  Retain reported interval amounts and durations; never synthesize missing rain
  as zero or promote later receipts into earlier decision features.
- At most two requests per worker iteration, with at least 1.1 seconds after
  a committed receipt before another request. Durable caps are eight forecast
  and 288 station requests per UTC day and rolling 24 hours. There is one HTTP
  attempt per claimed slot, a 45-second deadline and a two-megabyte body limit.
  These are collector ceilings, not claims about Tempest's account quota.
- Reserve storage headroom before HTTP and bound compressed body retention to
  eight MiB per day and two GiB over the collection. Storage exhaustion stops
  further capture; it does not prune prior evidence or widen limits silently.
- HTTP 429 pauses capture for at least 24 hours and longer supported
  `Retry-After` hints. An unsupported or oversized hint requires operator review
  and suspends the current policy through its expiry. HTTP 401/403 pauses the
  affected source kind for 24 hours. Normal ingestion and existing canaries
  remain isolated from this collector's failures.

[Open-Meteo's published limits](https://open-meteo.com/en/pricing) also apply to
other Weather traffic and weighted requests. Free access is noncommercial and
has no uptime guarantee. Missing or rejected responses remain explicit gaps.

## Evidence and privacy

Migration `0014_rain_collection.sql` introduces separate immutable request
claims and immutable response receipts. A claim is committed before HTTP.
The provider captures bytes, their SHA-256, response status, request start and
body-completion times before parsing; the resulting receipt is then appended
to storage. Complete invalid/error bodies are preserved;
an incomplete body is never represented as a complete source response.
Compressed bodies live in the private database and enter its normal encrypted
backups. No credential-bearing URL, API key or unfiltered diagnostic is stored
in request metadata or returned publicly.

Unknown claims after a crash remain unknown. They cannot be replayed under the
same slot or be counted as successful receipts. Database guards enforce source
identity, cadence, budgets, append-only behavior and receipt-time availability
even when the ingestion role uses SQL directly. The API and training-export
roles cannot read raw claims or response bodies. The existing forecast-training
export is unchanged; any future raw rain export needs a separately versioned,
bounded read-only contract rather than a production SQL bypass.

The [collection status endpoint](https://weather.ballydidean.farm/api/v1/sites/ballydidean/rain-collection)
exposes only aggregate counts, byte totals, last receipt times and suspension
time. It explicitly reports model and qualification disabled. A schema-valid
forecast or station response does not by itself prove complete model features,
a complete hourly target, timely availability, or season/event support.

## Release acceptance

Before deployment, verify provider byte capture, failed responses, duplicate
interval rejection, exact grid/units, deadlines, late receipt handling,
cross-worker/restart budgets, storage caps, immutable receipts and API redaction.
Run database and deployment integration against PostgreSQL 17, including an
0013-to-0014 upgrade and denial of raw access to API/export roles. Keep the
temperature canary regression suite green.

Publish an immutable release through the documented Weather release process,
deploy it to Blueberry, then inspect the live release and status endpoint.
Require an actual retained response before claiming capture works. If station
entitlement remains unresolved, report that limitation and do not claim a
twelve-gauge dataset. Fresh qualification remains a separate future protocol;
none of the frozen 49 development gates or populations is changed here.
