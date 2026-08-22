# Weather Platform

Weather is a greenfield TypeScript and Node.js platform for collecting,
normalizing, storing, and presenting weather data without coupling the data
model to a single station brand. The current repository is the Phase 1
workspace foundation only; it does not yet provide ingestion, persistence, API,
web, deployment, or production behavior.

## Requirements

- Node.js 24
- npm 11 or newer

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
npm run typecheck
```

`npm run check` runs linting, strict TypeScript checks, deterministic tests, and
the workspace build. Generated `dist/` directories are ignored and must not be
committed.

## Workspaces

| Workspace | Responsibility | Allowed project dependencies |
| --- | --- | --- |
| `@weather/domain` | Shared domain contracts | None |
| `@weather/database` | PostgreSQL boundary | `@weather/domain` |
| `@weather/providers` | Weather-provider adapters | `@weather/domain` |
| `@weather/worker` | Ingestion composition | Domain, database, providers |
| `@weather/api` | Read-only API | Domain, database |
| `@weather/web` | Browser experience over JSON contracts | None |

The root linter enforces both manifest dependencies and project-local source
imports against these boundaries. Workspace entrypoints are intentionally empty
in this foundation phase so later stories can add product behavior behind stable
package boundaries.

## Dependencies

- TypeScript 6 provides compilation and strict type checking.
- `@types/node` supplies Node.js 24 platform declarations.
- `pg` is the only planned non-platform runtime library and is scoped to the
  database workspace. No ORM, scheduler, validation, or UI framework is present.

## Safety boundary

Repository checks are local and deterministic. They do not use production
credentials, contact weather providers, start containers, publish artifacts,
deploy services, or alter the neighboring Actionable installation.
