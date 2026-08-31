# Weather Platform

Weather is a TypeScript and Node.js platform for collecting, normalizing,
storing, and presenting weather data without coupling the data model to one
station brand. The current MVP ingests the farm's first-party Ecowitt gateway,
Open-Meteo model data, seven public WeatherFlow Tempest stations, and nearby
Ambient Weather, Weather Underground, Netatmo, and PurpleAir stations. It
supports resumable historical backfills, stores normalized records in
PostgreSQL, and serves an accessible read-only dashboard.

The normalized point schema covers the purchased Ecowitt equipment without
duplicating measurements by sensor model. See the
[`sensor measurement inventory`](docs/sensor-measurements.md) for the field,
unit, device, and derived-data boundaries.

## Requirements

- Node.js 24
- npm 11 or newer
- Docker with Compose for PostgreSQL, browser, integration, and deployment tests

Install the pinned dependency graph from the committed lockfile:

```bash
npm ci
```

## Repository commands

```bash
npm run build
npm run check
npm run clean
npm run lint
npm test
npm run test:integration
npm run test:e2e
npm run test:deploy
npm run typecheck
```

`npm run check` runs linting, strict TypeScript checks, deterministic tests, and
the workspace build. The three explicit test gates are substantive:

- `test:integration` runs the database, worker/provider, and API suites against
  disposable PostgreSQL and deterministic provider fixtures.
- `test:e2e` runs the built web application in a real Playwright Chromium
  browser for desktop and mobile behavior.
- `test:deploy` runs static deployment verification and opt-in disposable
  Compose lifecycle, persistence, network, secret, and backup/restore checks.

Generated `dist/` directories are ignored and must not be committed.

## Read-only API

The public same-origin API exposes only these routes:

```text
GET|HEAD /api/v1/sites
GET|HEAD /api/v1/sites/:siteSlug/current
GET|HEAD /api/v1/sites/:siteSlug/forecast
GET|HEAD /api/v1/sites/:siteSlug/trends
GET|HEAD /api/v1/sites/:siteSlug/history
GET|HEAD /api/v1/health
```

Current reads accept `station` and `source`. History reads accept `station`,
`source`, `sourceKind`, `from`, `to`, `cursor`, and `limit`; the default page is
100 records and the maximum is 250. Forecast reads return the next 48 hours from
the latest normalized Open-Meteo product. Trend reads accept the reviewed
`24h`, `7d`, and `30d` ranges. All mutation methods are denied. Public
records retain bounded upstream model/timezone, device, quality, provider,
freshness, revision, and attribution fields without exposing request or
ingestion internals.

Health is allowlisted and reports application version, process liveness,
database and exact migration readiness, plus coarse worker freshness. It does
not expose credentials, database topology, or raw errors.

## Browser experience

The single-location dashboard defaults to Ballydidean and discovers active
stations and sources from `/api/v1/sites`. The homepage presents current
conditions, local threshold watches, a 24-hour forecast timeline, recent trend
charts, and a tiled map of nearby public stations. `/logs` provides bounded
history filters and cursor pagination. Both routes retain last-good-data
recovery, configurable locally persisted units, and keyboard-accessible native
controls. Open-Meteo records are labeled as model-derived, forecast, or
reanalysis data, never as on-site sensor readings, and retain direct Open-Meteo
and CC BY 4.0 links near the data.

The nearby-station map uses a dependency-free Web Mercator tile renderer. Users
can switch between labeled OpenStreetMap roads, USGS topographic tiles, and
USGS aerial imagery. Only the visible tile set is requested, and the selected
provider attribution remains attached to the map.

The local Compose override publishes the web app only on loopback at
<http://127.0.0.1:3000> by default. See
[`docs/operations/raspberry-pi.md`](docs/operations/raspberry-pi.md) for the
isolated deployment lifecycle and
[`docs/operations/backup-restore.md`](docs/operations/backup-restore.md) for
encrypted backup and disposable restore verification.

## Runtime targets

Checked, non-secret local and remote targets live in
[`config/runtime-targets.json`](config/runtime-targets.json). Test URLs prefer
the configured tunnel and fall back to the local origin only when the tunnel is
absent:

```bash
npm run test:urls
npm run test:urls:remote
npm run test:urls:local
npm run remote:tunnel:check
```

The configured remote stack uses the `weather-pi` host from the ignored
`deploy/config/ssh_config`. These wrappers preserve the forced-command SSH
boundary and require a loaded SSH agent:

```bash
npm run remote:status
npm run remote:deploy -- 2026.08.25-1
npm run remote:backup:pull
npm run remote:tempest:backfill
npm run remote:public-stations:backfill
npm run remote:recover
```

`remote:deploy` is the production default. It resolves immutable ARM64 image
digests, pulls them, applies forward migrations, and starts the stack directly.
It intentionally does not run the legacy capacity preflight, compatibility
database clone, or pre-migration backup. `remote:backup:pull` streams an
encrypted dump to the ignored `deploy/backups/weather-nightly.dump.age`, fully
decrypts it, validates it through `pg_restore --list` without writing plaintext,
and atomically replaces the prior local backup only after verification. A user
systemd timer runs that same command nightly at 02:30.

The current Weather tunnel origin is <https://weather.ballydidean.farm>.

## First-party Ecowitt ingestion

The checked gateway catalog is
[`config/ecowitt/gateways.json`](config/ecowitt/gateways.json). The worker polls
the GW3000 local HTTP API once per minute over the farm LAN and verifies the
gateway MAC before accepting each snapshot. The local live-data API does not
require the gateway UI password, so no Ecowitt credential is stored in Git,
Compose, or the database.

The adapter currently normalizes the primary outdoor temperature, apparent
temperature, humidity, relative pressure, wind, rain, solar, UV, black-globe,
wet-bulb-globe, PM2.5, and first soil channel measurements. The dedicated WH40H
rain gauge is preferred automatically when it appears; the WS90 piezo gauge is
the fallback. Optional PM2.5 and traditional-rain fields remain absent until
their sensors report through the gateway. Other repeated temperature, humidity,
and soil channels remain available at the gateway boundary but are intentionally
not duplicated into one normalized point.

## Tempest ingestion

The checked station catalog is
[`config/tempest/stations.json`](config/tempest/stations.json). It records only
public station/device identity and material source configuration. Keep the API
key outside Git in `deploy/secrets/weather_tempest_api_key`; the worker mounts
that file and polls every active Tempest source once per completed UTC hour.
Each provider range is limited to one day because longer historical requests
are bucketed by Tempest. The adapter retains every distinct one-minute provider
observation. Hourly polling therefore preserves minute-resolution data without
increasing the provider request rate.

Build and plan all configured station history without provider or database
writes:

```bash
docker compose --env-file deploy/.env.example \
  -f deploy/compose.yaml -f deploy/compose.local.yaml run --rm --no-deps worker \
  node apps/worker/dist/tempest-backfill-cli.js \
  --site ballydidean --from 2026-01-01 --to 2026-08-21 --dry-run
```

Import all configured history using each station's checked start date, skipping
only exact chunks that already succeeded:

```bash
docker compose --env-file deploy/.env.example \
  -f deploy/compose.yaml -f deploy/compose.local.yaml run --rm --no-deps worker \
  node apps/worker/dist/tempest-backfill-cli.js \
  --site ballydidean --resume
```

Repeat `--station LOCATION_ID` to select a subset. `--from`, `--to`,
`--chunk-days 1`, `--resume`, `--dry-run`, and `--report PATH` are supported.
The default `--to` is yesterday so the hourly worker owns the partial current
day. A repository-shell invocation is also available as
`npm run weather:tempest:backfill -- --site ballydidean ...` when the required
database and Tempest file environment variables are set.

Open-Meteo reanalysis remains hourly because the Historical Weather API exposes
native hourly model output. It is not interpolated into artificial one-minute
points; rerunning that backfill refreshes the complete hourly archive instead.

## Nearby public-station ingestion

The checked nearby-station catalog is
[`config/public-stations/stations.json`](config/public-stations/stations.json).
It currently defines five normalized sources across four physical stations:

- Ambient Weather Network supplies live and historical five-minute observations
  for Merlin beginning January 1, 2021.
- Ambient Weather Network supplies live five-minute observations for MaxWeather.
- Weather Underground supplies MaxWeather history from November 29, 2024,
  through August 23, 2026. The fixed cutoff keeps that archive from overlapping
  Ambient Weather's live ownership after deployment.
- Netatmo Weathermap supplies live and historical five-minute observations from
  the nearby public station beginning June 21, 2022. Module timestamps are
  merged into five-minute buckets without inventing values for missing modules.
- PurpleAir supplies live and historical raw two-minute observations from
  Samara (The Headlands). The import requests history back to January 1, 2019;
  the sensor's available observations begin in May 2019. PM2.5 uses the mean of
  the two particulate channels while temperature, humidity, and pressure retain
  the available enclosure-sensor measurements.

Run a no-write plan for every historical public source:

```bash
docker compose --env-file deploy/.env.example \
  -f deploy/compose.yaml -f deploy/compose.local.yaml run --rm --no-deps worker \
  node apps/worker/dist/public-stations-backfill-cli.js \
  --site ballydidean --dry-run
```

Import or resume every available archive:

```bash
npm run weather:public-stations:backfill -- \
  --site ballydidean --resume
```

Repeat `--source SOURCE_KEY` to select sources. `--from`, `--to`, `--resume`,
`--dry-run`, and `--report PATH` are supported. Source-specific availability and
chunk sizes remain checked configuration, so command-line ranges cannot query
before a known start or beyond the Weather Underground handoff cutoff.

Ambient Weather, Weather Underground, and PurpleAir map data are public
web-client interfaces rather than contractual bulk-data APIs. Their adapters
are isolated behind immutable source contracts, bounded retries, response-size
limits, exact range filters, provider-specific pacing, and resumable chunks so
an upstream change fails closed without affecting other providers. PurpleAir
uses a short-lived public map token and stores no token. Netatmo uses the
official public Weathermap visitor-token flow and likewise stores no visitor
token.

## Workspaces

| Workspace | Responsibility | Allowed project dependencies |
| --- | --- | --- |
| `@weather/domain` | Shared domain contracts | None |
| `@weather/database` | PostgreSQL boundary | `@weather/domain` |
| `@weather/providers` | Weather-provider adapters | `@weather/domain` |
| `@weather/worker` | Ingestion composition | Domain, database, providers |
| `@weather/api` | Read-only API | Domain, database |
| `@weather/web` | Browser experience over JSON contracts | None |

The root linter enforces manifest dependencies and project-local source imports
against these boundaries.

## Dependencies

- TypeScript 6 provides compilation and strict type checking.
- `@types/node` supplies Node.js 24 platform declarations.
- `pg` is scoped to the database workspace.
- Playwright is development-only and runs the real-browser acceptance gate.

No ORM, scheduler framework, UI framework, or charting library is present.

## Safety boundary

Default repository checks are local and deterministic. Explicit integration,
browser, and deployment tests use disposable local containers and fixtures;
they do not use production credentials, publish artifacts, deploy services, or
alter the neighboring Actionable installation.

## NOAA tide data

The production stack normalizes two NOAA CO-OPS feeds into `weather_records.water_level_m` using MLLW and UTC timestamps:

- Port Townsend station `9444900`: verified six-minute observed water levels
- Glendale station `9447814`: local high/low tide predictions

The worker refreshes both sources on their configured cadence. Historical imports are resumable and chunked within NOAA's published request limits:

```bash
npm run weather:tides:backfill -- --site ballydidean --from 2019-01-01 --resume
npm run remote:tides:backfill
```

Recent observations and the next seven days of predictions are available at:

```text
https://weather.ballydidean.farm/api/v1/sites/ballydidean/tides
```
