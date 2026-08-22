# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS dependencies
WORKDIR /opt/weather

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY apps apps
COPY packages packages
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /opt/weather
RUN groupadd --gid 10002 weather \
  && useradd --uid 10002 --gid 10002 --no-create-home --shell /usr/sbin/nologin weather
COPY --from=production-dependencies /opt/weather/node_modules node_modules
COPY --from=production-dependencies /opt/weather/package.json package.json

FROM runtime AS server
COPY --from=build --chown=10002:10002 /opt/weather/apps/api/dist apps/api/dist
COPY --from=build --chown=10002:10002 /opt/weather/apps/worker/dist apps/worker/dist
COPY --from=build --chown=10002:10002 /opt/weather/packages/database/dist packages/database/dist
COPY --from=build --chown=10002:10002 /opt/weather/packages/domain/dist packages/domain/dist
COPY --from=build --chown=10002:10002 /opt/weather/packages/providers/dist packages/providers/dist
COPY --chown=10002:10002 apps/api/package.json apps/api/package.json
COPY --chown=10002:10002 apps/worker/package.json apps/worker/package.json
COPY --chown=10002:10002 packages/database/package.json packages/database/package.json
COPY --chown=10002:10002 packages/domain/package.json packages/domain/package.json
COPY --chown=10002:10002 packages/providers/package.json packages/providers/package.json
COPY --chown=10002:10002 packages/database/migrations packages/database/migrations
COPY --chown=10002:10002 config config
COPY --chown=10002:10002 deploy/scripts/*.mjs deploy/scripts/
USER 10002:10002
CMD ["node", "apps/api/dist/index.js"]

FROM runtime AS web
COPY --from=build --chown=10002:10002 /opt/weather/apps/web/dist apps/web/dist
COPY --chown=10002:10002 apps/web/package.json apps/web/package.json
USER 10002:10002
CMD ["node", "apps/web/dist/index.js"]
