# API image (D-116). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t datascribe-api:local .
# The one-off migration task uses the `migrate` target (Prisma CLI and migrations, no app code):
#   docker build -f apps/api/Dockerfile --target migrate -t datascribe-migrate:local .
# ECS runs the default target with `node dist/server.js` on port 4000 (infra/terraform/ecs.tf).

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS base
# Prisma's query engine needs OpenSSL 3; the slim image only has the library without the probe.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS pnpm
RUN npm install -g pnpm@9.15.9 && npm cache clean --force

# Full install, Prisma client for this platform, bundle (workspace packages inlined, tsup.node.ts),
# then `pnpm deploy` of production dependencies only. Hoisted, so the bundle also finds the
# packages that only its workspace code imports; the Prisma client comes along in @datascribe/db.
FROM pnpm AS build
COPY . .
# A checkout made with a strict umask has 0600 files; the app runs as `node`, so open them up.
RUN chmod -R a+rX /app
RUN pnpm install --frozen-lockfile --filter @datascribe/api...
RUN pnpm --filter @datascribe/db generate
RUN pnpm --filter @datascribe/api build
RUN pnpm --filter @datascribe/api deploy --prod --config.shamefully-hoist=true /out
# packages/db with its dev dependencies: the Prisma CLI and the migrations.
RUN pnpm --filter @datascribe/db deploy /migrate

FROM base AS migrate
ENV NODE_ENV=production
COPY --from=build /migrate/node_modules ./node_modules
COPY --from=build /migrate/package.json ./package.json
COPY --from=build /migrate/prisma ./prisma
USER node
CMD ["/app/node_modules/.bin/prisma", "migrate", "deploy"]

FROM base AS runtime
ENV NODE_ENV=production \
  API_PORT=4000 \
  INVOICE_STORAGE_DIR=/app/.data/invoices
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/api/dist ./dist
# Code stays root-owned (read-only for the app); only the invoice scratch directory is writable.
RUN mkdir -p /app/.data/invoices && chown -R node:node /app/.data
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
