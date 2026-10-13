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
COPY playwright.config.ts ./
COPY apps/backend apps/backend
COPY apps/frontend apps/frontend
COPY packages/shared packages/shared
COPY tests tests
COPY scripts/smoke-match.mjs scripts/verify-runtime.mjs ./scripts/

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
RUN --network=none npm run verify

# Browser preparation is versioned by the npm lockfile and Playwright's browser
# revision. Downloads/system packages happen here, never during test execution.
FROM build AS browser-tools
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN npm run browser:install

# Real Chromium, compiled frontend/backend and fresh per-test SQLite fixtures.
# No external network is available to either the tests or the application.
FROM browser-tools AS browser-check
RUN --network=none --mount=type=tmpfs,target=/tmp \
    npm run browser:test && touch /app/.browser-verified

FROM manifests AS production-dependencies
RUN npm ci --omit=dev --workspace=apps/backend --workspace=packages/shared --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime-base
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

# Test the exact runtime filesystem as its production user, without external services.
# Bind mounts keep the test driver and match smoke out of all runtime layers.
FROM runtime-base AS runtime-check
RUN --network=none \
    --mount=type=bind,from=build,source=/app/scripts,target=/app/release-checks \
    --mount=type=tmpfs,target=/tmp \
    node /app/release-checks/verify-runtime.mjs && touch /app/data/.release-verified

# This is the default and the only supported release target. Its dependency on
# both checks makes source/browser tests, typecheck, build, health and smoke mandatory.
FROM runtime-base AS runtime
RUN --mount=type=bind,from=runtime-check,source=/app/data/.release-verified,target=/tmp/release-verified \
    --mount=type=bind,from=browser-check,source=/app/.browser-verified,target=/tmp/browser-verified \
    test -f /tmp/release-verified && test -f /tmp/browser-verified
