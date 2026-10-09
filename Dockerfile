# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS manifests
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
COPY packages/shared/package.json packages/shared/package.json

FROM manifests AS dependencies
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig.json ./
COPY apps/backend apps/backend
COPY apps/frontend apps/frontend
COPY packages/shared packages/shared

# Vite embeds these public details into the frontend at build time.
# Runtime secrets (especially ADMIN_TOKEN) must never be build arguments.
ARG VITE_LEGAL_PROVIDER_NAME
ARG VITE_LEGAL_PROVIDER_ADDRESS
ARG VITE_LEGAL_PROVIDER_EMAIL
ARG VITE_LEGAL_REPRESENTED_BY
ARG VITE_LEGAL_VAT_ID
ARG VITE_LEGAL_CONTENT_RESPONSIBLE
ARG VITE_LEGAL_DPO
ARG VITE_LEGAL_HOSTING_PROVIDER
ARG VITE_LEGAL_HOSTING_REGION
ARG VITE_LEGAL_HOSTING_DPA
ARG VITE_LEGAL_LOG_RETENTION
ARG VITE_LEGAL_ACCOUNT_RETENTION
RUN npm run build

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --workspace=apps/backend --workspace=packages/shared --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_PATH=/app/data/pixelfleet.sqlite \
    TRUST_PROXY=true

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY --from=build /app/apps/backend/dist ./apps/backend/dist
COPY packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/apps/frontend/dist ./apps/frontend/dist
COPY scripts/healthcheck.mjs scripts/admin.mjs ./scripts/

# Docker initializes a new named volume from this directory, including ownership.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "apps/backend/dist/server.js"]
