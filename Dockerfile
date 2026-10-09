# syntax=docker/dockerfile:1.7
# Multi-stage build for the Universal AI Form Assistant web app (Next.js standalone)
# and the one-shot database migrator. Targets:
#   runner   -> production web server (small image, non-root)
#   migrator -> runs `packages/db/src/cli.ts migrate` then exits

ARG NODE_IMAGE=node:22-alpine

# ---- deps: install the whole workspace once (cached on lockfile) -------------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/security/package.json packages/security/
COPY packages/profile-engine/package.json packages/profile-engine/
COPY packages/db/package.json packages/db/
COPY packages/storage/package.json packages/storage/
COPY packages/document-engine/package.json packages/document-engine/
COPY packages/ai/package.json packages/ai/
COPY packages/form-engine/package.json packages/form-engine/
COPY apps/extension/package.json apps/extension/
RUN npm ci --no-audit --no-fund

# ---- builder ------------------------------------------------------------------
FROM deps AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 NODE_ENV=production
RUN npm run build -w @ufa/web

# ---- migrator -----------------------------------------------------------------
FROM builder AS migrator
ENV NODE_ENV=production
CMD ["npx", "tsx", "packages/db/src/cli.ts", "migrate"]

# ---- runner -------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 STORAGE_LOCAL_DIR=/app/storage
COPY --from=builder --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=node:node /app/apps/web/public ./apps/web/public
RUN mkdir -p /app/storage && chown node:node /app/storage
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
