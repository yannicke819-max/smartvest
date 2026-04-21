# Multi-stage build for the SmartVest API (NestJS, npm workspaces monorepo).
# Build context = repo root. The API depends on several @smartvest/* workspaces,
# so we copy the whole workspace tree for the install + build phase.
#
# COPY paths are explicit (no `COPY apps/api/ apps/api/` wildcard) to sidestep
# a BuildKit edge case where a directory-as-source fails with "not found"
# when combined with .dockerignore rules that use negations.

FROM node:20-alpine AS builder
WORKDIR /repo

# Install-layer inputs — changes here invalidate the npm cache.
COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages packages

RUN npm install --include=dev

# Build-layer inputs — copied after install so code edits don't re-install.
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json

RUN npm run -w @smartvest/api build

# =========================================================================
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/api/dist ./dist
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json

EXPOSE 3001
CMD ["node", "dist/main.js"]
