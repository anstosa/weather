# Rain adjustment and shared administration

## October 1, 2026 control change

One persistent administrator switch now governs rain, temperature, and wind
adjustments together. Turning it off removes all three corrections from public
forecast responses. Turning it on permits each correction only when that
model's own source, integrity, and inference checks pass. A rain hour falling
back to raw does not disable an otherwise eligible temperature or wind hour.
The independent temperature and wind emergency kill switches remain available.

New permanent, content-addressed temperature and wind authorizations supersede
the expired September canary selections. Temperature keeps its fitted
coefficients but uses a new cross-month serving contract. Neither change
qualifies the research models or bypasses raw fallback. Rain's adjustment
model has no authorization expiry; its separate prospective source-capture
policy still ends on October 8, 2027 and retains finite provider/storage
budgets. That collection policy is not made permanent by this model release.
The prior
independent-checkbox and fourteen-day policies below describe historical
releases, not the current control policy.

## September 14 authorized live use (historical)

On September 14, 2026 the operator explicitly authorized using the imperfect
rain adjustment on Blueberry and requested independent temperature, wind and
rain switches in the admin UI. This is permission to serve the existing model,
not a successful qualification result. The historical wind-aware candidate
still passes 43 of 49 development gates. Its six failures, reused development
data and missing historical receipt evidence remain unchanged.

The normal forecast UI has one Raw/Adjusted switch, without experimental copy
or a separate temperature consent dialog. `/admin` has three independent,
persistent checkboxes. All three initially default to enabled for this release;
explicitly saved disabled values survive restarts. Disabling all three removes
the normal forecast switch even when a browser previously preferred Adjusted.
The authenticated edge applies these settings before returning forecasts, not
merely as a browser display preference. Forecast responses are not cached.

## Model and source boundary

The runtime uses the unchanged August 2026 monthly `hurdleWind` fit and its
calibration from the retained wind experiment. Four native XGBoost heads and
the 107-feature schema are exported into a digest-bound portable artifact;
this release does not train another method or silently substitute a scalar.
The artifact contains fitted numerical parameters, not gauge observations.
Synthetic parity fixtures exercise the original Python feature builder and
native predictions. The exporter records the exact retained source identities.

Rain uses actual retained ECMWF IFS Single Runs, not the Best Match retrieval
snapshot used by the ordinary forecast. Each decision remains initialization
plus eight hours. Only original source leads 9–31, representing the next
1–23 hours after that decision, can be adjusted. Current forecasts must have
arrived by the decision. Earlier cycles are exactly six and twelve hours older.
Gauge inputs use the original fixed catalog, backward complete interval tiling,
the original five-minute endpoint tolerance, and only receipts available by
the decision. Empty, partial or absent observations are never zero-filled.
Missing gauge predictors use the unchanged native trees' missing-value branches;
they do not necessarily disable inference, even when all gauge lags are missing.
An active model output alone does not prove gauge participation or new skill.
Cold hours outside the trained liquid-rain scope fall back to the raw forecast.

Migration `0016_rain_adjustment.sql` adds an immutable, bounded output table.
The worker may read private captured inputs and append predictions; the API
may read only the output projection. Public responses retain original raw
metrics, return rain correction separately, and identify its ECMWF source.
The API rejects mismatched models, invalid values, late source receipts,
future decisions and decisions at least twelve hours old. Other metrics and
normal ingestion remain available when rain input preparation fails.

The existing collection policy and raw evidence are unchanged. A collection
status response may now report a live model separately from qualification,
which remains false. Switching a metric on permitted its available model; it
did not bypass source validity, invalid-forecast fallback, or the then-current
temperature and wind authorization expiry.

## Validation and rollout

Run targeted rain worker/API/native parity tests, PostgreSQL projection/ACL
integration, admin authentication/persistence/shared-switch tests,
the full workspace check, browser verification and deployment integration.
Use the documented immutable Weather release process and the version-eleven
control-plane handoff; retain published prior migrations and release files.
Verify actual adjusted rain records, shared-switch persistence,
all-off toggle removal and the absence of experimental copy after deployment.

The live pages are [forecast](https://weather.ballydidean.farm/forecast) and
[administration](https://weather.ballydidean.farm/admin).
