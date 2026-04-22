# Multi-stage build for the SmartVest API (NestJS, npm workspaces monorepo).
# Build context = repo root.

FROM node:20-alpine AS builder

# ARG CACHEBUST invalide le cache Docker dès qu'on change sa valeur
# (doit être passé via --build-arg CACHEBUST=X ou buildArgs dans railway.toml).
ARG CACHEBUST=11
RUN echo "cachebust=$CACHEBUST"

WORKDIR /repo

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY scripts scripts
COPY supabase supabase

RUN npm install --include=dev

# Nettoyage défensif : supprime tous les artefacts stale avant compilation.
# Garantit que tsc -b compile vraiment, même si le contexte copie des dist/
# anciens (normalement bloqués par .dockerignore).
RUN rm -rf apps/api/dist apps/api/tsconfig.tsbuildinfo \
    && find . -name "*.tsbuildinfo" -not -path "*/node_modules/*" -delete \
    && find packages -type d -name "dist" -exec rm -rf {} + 2>/dev/null || true

RUN npx tsc -b apps/api/tsconfig.json

# Fail-fast : si LisaModule n'est pas dans dist, le build échoue explicitement
# au lieu de produire une image silencieusement cassée.
RUN test -f apps/api/dist/modules/lisa/lisa.module.js \
    || (echo "❌ LisaModule not compiled" && ls -la apps/api/dist/modules/ && exit 1)
RUN test -f apps/api/dist/modules/lisa/lisa.controller.js \
    || (echo "❌ LisaController not compiled" && exit 1)
RUN test -f apps/api/dist/app.module.js \
    && grep -q "lisa" apps/api/dist/app.module.js \
    || (echo "❌ LisaModule not registered in compiled app.module.js" && exit 1)
RUN echo "✅ LisaModule present in build output"

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
# ; garantit que l'API démarre même si une migration échoue.
CMD ["sh", "-c", "node /app/scripts/apply-migrations.mjs; node dist/main.js"]
