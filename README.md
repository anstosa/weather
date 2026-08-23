# Weather Platform

Weather is a TypeScript and Node.js platform for collecting, normalizing,
storing, and presenting weather data without coupling the data model to one
station brand. The current MVP ingests Open-Meteo model data and seven public
WeatherFlow Tempest stations, supports resumable historical backfills, stores
normalized records in PostgreSQL, and serves an accessible read-only dashboard.

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
GET|HEAD /api/v1/sites/:siteSlug/history
GET|HEAD /api/v1/health
```

Current reads accept `station` and `source`. History reads accept `station`,
`source`, `sourceKind`, `from`, `to`, `cursor`, and `limit`; the default page is
100 records and the maximum is 250. All mutation methods are denied. Public
records retain bounded upstream model/timezone, device, quality, provider,
freshness, revision, and attribution fields without exposing request or
ingestion internals.

Health is allowlisted and reports application version, process liveness,
database and exact migration readiness, plus coarse worker freshness. It does
not expose credentials, database topology, or raw errors.

## Browser experience

The dashboard defaults to Ballydidean and discovers active sites, stations, and
sources from `/api/v1/sites`. It provides station/source selection, current
freshness and provenance, bounded history filters, cursor pagination,
last-good-data recovery, explicit units, and keyboard-accessible native
controls. Open-Meteo records are labeled as model-derived or reanalysis data,
never as on-site sensor readings, and retain direct Open-Meteo and CC BY 4.0
links near the data.

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
npm run remote:preflight
npm run remote:backup
npm run remote:tempest:backfill
npm run remote:stage -- 2026.08.22-7
npm run remote:activate -- 2026.08.22-7
npm run remote:rollback
npm run remote:recover
```

The current Weather tunnel origin is <https://weather.santosa.family>.

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
