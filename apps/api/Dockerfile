# Multi-stage build for the SmartVest API (NestJS, npm workspaces monorepo).
# Build context = repo root.
#
# .dockerignore exclut dist/, *.tsbuildinfo, node_modules locaux → tsc -b
# compile toujours proprement sans artefacts stale.

FROM node:20-alpine AS builder
# cache-bust: 8
ENV CACHE_BUST=8
WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY scripts scripts
COPY supabase supabase

RUN npm install --include=dev
# Compile packages + API en une seule passe (composite project references).
# tsc -b compile les références dans l'ordre de dépendance, puis l'API.
RUN npx tsc -b apps/api/tsconfig.json

# =========================================================================
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /repo/package.json /repo/package-lock.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
COPY --from=builder /repo/apps/api/package.json ./apps/api/package.json
COPY --from=builder /repo/apps/api/dist ./apps/api/dist
COPY --from=builder /repo/scripts ./scripts
COPY --from=builder /repo/supabase/migrations ./supabase/migrations

WORKDIR /app/apps/api
EXPOSE 3001
# Toujours démarrer l'API (;) même si une migration échoue.
CMD ["sh", "-c", "node /app/scripts/apply-migrations.mjs; node dist/main.js"]
