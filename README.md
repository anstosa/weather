# Weather Platform

Weather is a TypeScript and Node.js platform for collecting, normalizing,
storing, and presenting weather data without coupling the data model to one
station brand. The current MVP ingests Open-Meteo model-current data, supports
resumable historical reanalysis backfills, stores normalized records in
PostgreSQL, and serves an accessible read-only dashboard.

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
