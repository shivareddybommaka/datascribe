# Web image (Next standalone server, D-116). Build from the repo root:
#   docker build -f apps/web/Dockerfile --build-arg API_URL=https://app.example.com -t datascribe-web:local .
# ECS runs `node apps/web/server.js` on port 3010, infra/terraform/ecs.tf.
# API_URL is needed at build time too: Next bakes the /api/v1 rewrite into the build. In AWS the
# ALB sends /api/v1/* straight to the API, so the rewrite is only a fallback. Server code
# (lib/plans.ts) reads API_URL again at run time from the task environment.
# No HEALTHCHECK: the web app has no health route (the ALB checks `/`).

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS base
WORKDIR /app

FROM base AS pnpm
RUN npm install -g pnpm@9.15.9 && npm cache clean --force

FROM pnpm AS build
ARG API_URL=http://localhost:4000
ENV NEXT_TELEMETRY_DISABLED=1 \
  API_URL=${API_URL}
COPY . .
# A checkout made with a strict umask has 0600 files; the app runs as `node`, so open them up.
RUN chmod -R a+rX /app
RUN pnpm install --frozen-lockfile --filter @datascribe/web...
RUN pnpm --filter @datascribe/web build

# The standalone output holds only the traced production files (server, used node_modules).
FROM base AS runtime
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=3010 \
  HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
# Code stays root-owned; Next writes its image/fetch cache here.
RUN mkdir -p /app/apps/web/.next/cache && chown -R node:node /app/apps/web/.next/cache
USER node
EXPOSE 3010
CMD ["node", "apps/web/server.js"]
