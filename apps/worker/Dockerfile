# Worker image (D-116). Build from the repo root:
#   docker build -f apps/worker/Dockerfile -t datascribe-worker:local .
# ECS runs `node dist/index.js` with no port; ClamAV is a sidecar in the same task
# (infra/terraform/ecs.tf). No HEALTHCHECK: the worker has no HTTP server.

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
RUN pnpm install --frozen-lockfile --filter @datascribe/worker...
RUN pnpm --filter @datascribe/db generate
RUN pnpm --filter @datascribe/worker build
RUN pnpm --filter @datascribe/worker deploy --prod --config.shamefully-hoist=true /out

FROM base AS runtime
ENV NODE_ENV=production \
  INVOICE_STORAGE_DIR=/app/.data/invoices
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/package.json ./package.json
COPY --from=build /app/apps/worker/dist ./dist
# Code stays root-owned (read-only for the app); only the invoice scratch directory is writable.
RUN mkdir -p /app/.data/invoices && chown -R node:node /app/.data
USER node
CMD ["node", "dist/index.js"]
