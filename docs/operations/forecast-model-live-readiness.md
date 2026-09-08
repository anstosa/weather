# Forecast model live-integration readiness

## September 8, 2026 reviewed release 13 receipt

Release `2026.09.08-13`, source commit
`e4e4f4f529be3ed34a59e53f4e3389707dff0f51`, superseded release 11 through the
documented release process. The production API boot was
`2026-09-08T14:18:28.693Z`. The
[reviewed release workflow](https://github.com/anstosa/weather/actions/runs/34234910429)
and [main checks](https://github.com/anstosa/weather/actions/runs/34234910941)
passed repository, PostgreSQL, browser and deployment gates.

Live public HTTPS checks verified 24, 120 and 240 rows for the one-, five- and
ten-day windows, all HTTP 200 within 2.5 seconds. The five-day response included
ten eligible adaptive temperature rows and 112 adjusted wind rows. Raw Best Match
values, explicit ECMWF identity, initialization-relative lead limits and the
three-degree correction cap were preserved. The existing temperature and wind
bundle identities and September 22 UTC expiry were unchanged. This is serving
verification, not a new accuracy measurement or renewed model authorization.

The review repaired silent optional temperature failures with bounded, redacted
diagnostics and removed unused UI declarations and duplicated startup fallback
values. An isolated instance of the exact published server image verified a
simulated status-read failure emits one sanitized diagnostic while retaining
HTTP 200 HEAD semantics; no fault was injected into the live API. All five live
services were healthy, schema 0013 was unchanged, and an actual password login
reconfirmed the export role's read-only access to exactly its two existing views.

A fresh live-browser attempt was blocked before navigation because the shared
Playwright Chrome profile was already in use. No release 13 DOM or screenshot
verification was obtained. Release 13 browser end-to-end gates passed, and the
release 11 live browser matrix below remains the previous rendered evidence;
the review's UI cleanup did not change visible controls or plot behavior.

### Current release 13 recovery boundary

At `2026-09-08T14:23:34.208Z`, same-code release `2026.09.08-14` was armed as
the raw-only forward recovery for release 13. Its
[publication workflow](https://github.com/anstosa/weather/actions/runs/34234910883)
passed all gates. Isolated instances of both published server images passed all
four independent temperature/wind kill-switch combinations. Both future
release-input switches are `1`; the immutable active release 13 environment
retains both switches at `0`. The active environment and all five container
identities and start times were verified unchanged after arming recovery.

While release 13 remains current, the prepared model backout command is
`npm run remote:deploy -- 2026.09.08-14`. Revalidate current release identity and
prepared input before use. This is same-code model disablement, not prior-image
or database rollback, and cannot recover a shared code defect. The previous
staged-clone capacity limitation and lack of prior-image rollback authorization
remain unchanged. The release 11-to-12 receipt below is historical, not the
current backout pair.

## September 8, 2026 initial release 11 receipt

Release `2026.09.08-11`, source commit
`5c4c11d1663e8806cef6f7141c5d56d4eff5fd85`, was deployed through the documented
release process and verified on
[Blueberry Forecast](https://weather.ballydidean.farm/forecast). The production
API boot was `2026-09-08T04:48:37.858Z`. Both canaries were active with the
immutable bundle identities and expiry recorded below. This is operational
verification, not a prospective accuracy result or ordinary model qualification.

The [canary publication workflow](https://github.com/anstosa/weather/actions/runs/34186742773)
passed repository, database, browser and deployment gates. Live browser checks
then verified Today, five-day and ten-day forecasts, bundle-specific consent,
adjusted temperature and wind plots, exact raw restoration, source attribution
and mobile layout. Two bounded repository query repairs removed historical
forecast/provenance scans without changing the five-day response in read-only
same-snapshot comparisons. The separate paused Xweather radar path still returned
502 responses and was not part of this model release's fixes.

The dedicated forecast-export credential was installed without changing the
eleven existing credential files. Password-authenticated checks verified
`weather_training_export` has read-only access to exactly the two existing export
views, no role memberships and no writable relations. Schema migration 0013 was
applied with checksum
`e05f0397529108641ad9b9eb5381ac968f35449514fe4d8ed0ac502c9d5bf3ee`.
No rain, humidity or pressure model was activated.

### Verified recovery boundary

Recovery was armed at `2026-09-08T04:52:45.520Z`. Release `2026.09.08-12` had been
published from the same source commit as the raw-only forward recovery for
release 11. Its
[publication workflow](https://github.com/anstosa/weather/actions/runs/34186742705)
passed all gates, and isolated image checks verified all four independent
temperature/wind switch combinations. Both future release-input switches were
set to `1`; the immutable active release 11 environment and running containers
retained `0` for both switches and were unchanged.

While release 11 remains current, the prepared model backout command is
`npm run remote:deploy -- 2026.09.08-12`. Revalidate the current release and
prepared input before use. This disables the models through a new reviewed
release; it is not prior-image or database rollback, and cannot recover a defect
shared by both releases. Full staged-clone capacity was insufficient, so this
deployment did not establish prior-image rollback authorization. Do not bypass
that gate, remove production data to make room, or rewrite frozen release files.

The dated pre-authorization assessment below is retained as historical context;
its inactive-state statements do not describe the deployment receipt above.

## September 7, 2026 pre-authorization assessment

The requested delivery is temperature plus wind on Blueberry, followed by rain,
humidity, and pressure research. This document records the release prerequisites;
it is not an activation receipt or a replacement for the existing qualification
and wind-canary policies.

The production check during this assessment reports release `2026.09.06-2`,
healthy API/database/worker status, and adjustment state `disabled` with reason
`canary_killed`. Both committed adjustment registries select `activeBundle: null`.
No production mutation was performed during the assessment.

## Temperature: the tested forecast source must remain explicit

The latest learned-strength result is an ECMWF-specific, initialization-relative
research model. Its primary first-twelve-hour improvement of 21.67% is against
raw ECMWF forecasts, not against the Best Match forecasts currently served by
the application. Its separate six-hour-delay sensitivity improves 20.64% over
its own raw comparator. Neither number establishes observed issue-relative
production performance.

`packages/providers/src/open-meteo.ts` currently requests the default Best Match
forecast and records retrieval time as `productRunAt`. This is not an ECMWF run
initialization. The existing API adjustment call receives one forecast row and
has neither an explicit ECMWF run identity nor the winner's per-run recent-error
state. Substituting a retrieval timestamp or Best Match values would change the
model being evaluated.

Open-Meteo's Single Runs API accepts an explicit UTC initialization through
`run`. Its documentation distinguishes initialization from availability and
describes a typical four-to-six-hour distribution delay for global models.
Consequently, a model lead of one hour cannot be relabeled one hour after the
application receives the forecast. See the official
[Single Runs API documentation](https://open-meteo.com/en/docs/single-runs-api).

A correct live integration needs all of the following:

1. Explicit ECMWF source, model/run identity, actual receipt time, and forecast
   valid time, without changing the provenance of the existing Best Match rows.
2. A declared selection rule for forecasts actually available at request time,
   with missing/stale runs falling back to unchanged raw service.
3. Same-provider raw-error state built from accepted station observations and
   earlier runs, frozen at the model's declared boundary. Observation receipt
   and revision availability must not be inferred from valid time alone.
4. Exact inference parity for the original direct/adaptive coefficients and
   learned-strength band selection, including caps, missing-state behavior,
   calendar features, and model epochs.
5. A separately reviewed deployment artifact and application/decision contract.
   Existing qualified-v2 bundles do not represent this algorithm; the wind
   canary must not be widened silently to temperature.
6. Explicit coexistence with wind. `apps/api/src/main.ts` currently selects one
   runtime, and an active wind canary suppresses the qualified runtime.
7. Live verification of source identity, actual availability, both metrics,
   raw fallback, the adjusted/raw display, and immutable bundle identities.

The isolated `temperature-mos-runtime.ts` inference port is a prerequisite only.
It is not exported by the package entry point, loaded by the API, packaged as an
active model, or evidence of operational availability. Its scope is the frozen
ECMWF initialization-relative first-twelve-hour model, not a newly validated
issue-relative or longer-horizon model. Numerical parity applies to supported
inputs; unsupported learned-strength bands deliberately fail raw instead of
substituting the research implementation's half-strength incumbent.

A proposed alternative to ordinary qualification is a separately versioned,
operator-authorized temperature canary lasting at most fourteen days, opt-in in
the interface, with an independent kill switch, fail-raw behavior, prospective
monitoring, and rollback. This is a new policy exception, not an existing wind
authorization or a qualified-v2 model. Its exact artifact, scope, source, expiry,
and serving contract must be reviewed before activation. No such exception or
active registry is created by this readiness work.

### Inactive inference verification

The isolated port has fifteen focused tests for supported Python-reference
predictions, direct/adaptive selection, both strength bands, missing predictors,
clipping, model/run identity, exact monthly cutoffs, and stale/future error-state
receipts. The forecast-adjustment package suite passes all 271 tests.

A separate synthetic replay covers 232 cases across months, initialization
cycles, model eras, leap day, daylight-saving changes, and year rollover. Its
largest Python/TypeScript difference is `3.552713678800501e-15`, below the fixed
`1e-12` tolerance. It uses no production rows and performs no fitting. Independent
code review found no remaining issues after the receipt and cutoff guards were
repaired. These checks establish inactive inference behavior, not live forecast
quality, source availability, or authorization to activate a model.

## Wind: distinguish the retained canary from later research

The retained content-addressed wind bundle is
`sha256-8ada04b924326665b7c49be37876727e9fdc853e9b0eb3decc7fe68c62acc96b.json`.
It contains wind speed and selected gust bands, was retired September 6, and
its original authorization expires September 17. Wind direction is not enabled
in that bundle. Its transfer scores are not the later full-history diagnostic
scores reported in the research summary.

Reactivation, replacement, or renewed authorization must use the documented
reviewed image-release path. Do not silently reactivate the retired bundle while
describing it as the newer all-history model, extend its authorization in place,
edit the running registry, or bypass the production kill switch.

## Subsequent research: data semantics before fitting

### Relative humidity

The existing production export and retained multi-year datasets already include
humidity. There is no reason to request another temperature-only dataset for it.
Start with the existing robust hierarchy and a causal correction-strength
challenger, using earlier-only rolling fits and all complete evaluation dates.
Keep fixed-anchor and saved live-forecast cohorts separate, and report each lead
band, month, season, station/provider balance, bias, MAE, and large errors.

The older archive diagnostic improved 41.03%, but the separate saved live-v4
diagnostic improved only 1.15%. That discrepancy is a transfer problem to test,
not evidence that humidity is already solved.

### Rain

The raw forecast tables and adapters have precipitation fields, but the existing
sanitized training export excludes them. That is a demonstrated export-contract
gap, not proof that production history is absent. A new additive, bounded,
read-only export must establish actual per-source/date coverage first.

Define the observation target as the preceding hour's accumulated amount with
cadence and gap checks. Tempest, Netatmo, and Ecowitt provide accumulation inputs;
Ecowitt counter resets and gaps must remain explicit. Ambient and Weather
Underground expose rate-only inputs in the current adapters and should not be
treated as interval amounts without a separately validated integration rule.

Compare raw with a zero-rain control and a conservative occurrence/amount
baseline. Report wet/dry classification, wet-hour and unconditional error,
accumulation bias, and heavy-event misses so a mostly-dry model cannot win merely
by predicting zero. Probabilistic occurrence models additionally need calibration
and Brier-score evaluation.

The current live forecast stores the hourly amount as both `precipitationMm`
and `precipitationRateMmPerHour`; the chart and daily totals use different fields.
Any later serving change must keep those hourly quantities consistent.

### Pressure

Pressure likewise exists in provider/storage fields but not in the sanitized
training export. Before constructing a network target, classify pressure
reference semantics for each source and adapter version.

Open-Meteo currently supplies `surface_pressure`. Ecowitt's adapter explicitly
reads relative pressure, and Ambient reads `baromrelin`. The canonical
`pressureHpa` field records units without a surface/sea-level reference tag.
Pooling these raw levels would train against incompatible quantities.

After a compatible reference and station subset are established, compare raw
against a robust additive-bias baseline. Report pressure-level bias and MAE,
pressure-tendency error, and per-station offsets separately. Do not invent
elevations, infer a pressure reference solely from plausible values, or call a
reference-frame offset a forecast-model improvement.

## Release boundary

The documented image publication workflow is
`.github/workflows/publish-images.yml`, triggered by an immutable release tag.
It runs repository, integration, browser, and deployment checks before publishing
ARM64 server/web images. `npm run remote:deploy -- YYYY.MM.DD-N` then resolves
immutable digests and activates the release through the forced SSH wrapper.

On September 8 UTC, the operator explicitly authorized the fourteen-day opt-in
ECMWF temperature canary, independent kill switch and raw fallback, alongside
wind, including the source commit and release-tag publication required for
deployment. This does not authorize activation of rain, humidity, or pressure.
No research metric is a substitute for passing runtime validation or a release
receipt. Completion requires verification on
<https://weather.ballydidean.farm/forecast>, not a local preview.


## Authorized September 8 canary contract

The new canary is a separate, unqualified ECMWF transfer experiment. It does not
change qualified-v2 gates, Best Match v4 ingestion/provenance, or the wind metric
allowlist. The frozen September delayed-six-hour model uses initialization leads
7–18; its internal horizon is model lead minus six, not measured issue time.
The original coefficients and learned strengths are copied exactly from the
retained artifacts without refitting. Both September strengths are 1.0.

- Temperature bundle: `3e82073a266ca88c15f492f86bbefbca8b8cda029520af6cc78e0a0062ee50dd`.
- Wind bundle: `5e8b2e3932111621af6785a1b16dfd22edc0a2d26059c6e396654c70119abbe1`.
- Both authorizations begin `2026-09-08T00:22:24.734Z` and expire
  `2026-09-22T00:22:24.734Z`. The serving window may be shorter than fourteen
  days because deployment occurs after authorization.
- Wind retains the previous candidate and transfer report byte-for-byte;
  only its bounded operator authorization is renewed.
- The temperature bundle includes only the inference coefficients, strength
  bands, fixed cutoffs, calendar fingerprint, source hashes and authorization.
  It excludes training keys and station observations and is server-image-only.

The worker collects explicit Single Runs into private sidecar tables. It freezes
first receipt and the per-run recent-error state, excludes forecasts or station
values first received or revised after the target initialization, and never
backdates availability. Missing causal history uses the direct MOS branch;
unsupported, stale, killed, expired or malformed inputs preserve raw service.
The API joins one received ECMWF run to existing forecast hours without adding
rows or replacing Best Match raw metrics. The optional temperature decision
reports ECMWF raw temperature, corrected temperature, initialization and receipt
separately from the existing wind decision. The interface defaults to raw and
identifies ECMWF when the experimental adjustment is selected.

### Monitoring and independent shutdown

Inspect `/api/v1/health` and the forecast response's
`temperatureAdjustmentRuntime` for bundle identity, expiry, collection coverage
and recent-error support. Per-hour `temperatureAdjustment` records the selected
source and direct/adaptive branch. Initial direct predictions are expected until
actual collection receipts precede a later run initialization; a historical
archive timestamp cannot substitute for that evidence. Retained immutable runs
and states support later prospective scoring. Do not describe operational
coverage as measured accuracy or compare ECMWF research gains with Best Match
without scoring that comparator independently.

Unexpected sidecar reads, monitoring reads and inference exceptions emit
`temperature_canary_fallback` diagnostics with operations `sidecar_read`,
`status_read` and `inference`. Each operation emits at most once per request,
with the actual response status and only bounded error-name/code metadata. Error
messages, queries, model values and stack traces are excluded. Legitimately empty
reads emit no failure event; diagnostic sink failures cannot interrupt raw
service. These events supplement, rather than replace, the public raw-fallback
and source-coverage fields.

`WEATHER_FORECAST_ADJUSTMENT_TEMPERATURE_CANARY_KILL_SWITCH=1` disables only
temperature; `WEATHER_FORECAST_ADJUSTMENT_WIND_CANARY_KILL_SWITCH=1` disables only
wind. Temperature requires an explicit literal `0` to enable it. The release
writer preserves both switches, defaults an absent temperature switch to `1`,
and rejects duplicate or malformed declarations. Update switches through a new
reviewed release input and the documented deployment process; do not rewrite an
immutable active release environment. Prior-image rollback additionally requires
the documented compatibility and migration authorization; when authorized, it
selects retained images and environment without a down migration. For the
September 8 deployment, use the narrower verified recovery boundary above.
