# Multi-stage build for the SmartVest API (NestJS, npm workspaces monorepo).
# Build context = repo root.
#
# Pattern: only directory-level COPYs (apps/, packages/). No sub-path COPY
# and no file COPY mixed with directory COPYs in the same parent — this
# avoids a BuildKit "not found" cache computation error that Railway trips
# on (observed on commit 5c4ad0a and 00a9b5b). Layer caching for
# node_modules is slightly less aggressive, but for personal use builds
# are infrequent enough that correctness wins.

FROM node:20-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps apps

RUN npm install --include=dev
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
