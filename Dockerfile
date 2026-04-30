# Multi-stage build for the SmartVest API (NestJS, npm workspaces monorepo).
# Build context = repo root.

FROM node:20-alpine AS builder

# ARG CACHEBUST invalide le cache Docker dès qu'on change sa valeur
# (doit être passé via --build-arg CACHEBUST=X ou buildArgs dans railway.toml).
# P19x.11 (29/04/2026) — bumped 11 → 12 pour forcer un rebuild complet avec
# build args propagés. Constat : git_sha=null observé sur image
# 539628cb..., probablement build sans --build-arg GIT_SHA (manual flyctl
# deploy ou cache layer hit). Bump CACHEBUST = invalidation totale → nouvelle
# build via workflow fly.yml passe tous les build args correctement.
ARG CACHEBUST=12
RUN echo "cachebust=$CACHEBUST"

# P18h — Build metadata exposée via GET /version. Passées par fly.yml :
#   --build-arg GIT_SHA=${{ github.sha }} --build-arg BUILD_TIME=$(date -u +%FT%TZ)
#
# P19w (29/04/2026) — git_sha + build_time retournaient `null` en prod malgré
# workflow run #204 SUCCESS pour ce62853. Cause probable : Docker layer cache
# avec `--remote-only` builder ne respecte pas toujours --build-arg invalidation
# → ENV layer reste cached avec valeur vide. Fix structurel défensif :
#
#   1. ARG CACHEBUST_GIT_SHA juste avant les ARG/ENV pour invalider la chaîne
#      de layers à partir de ce point (workflow passe ce GIT_SHA, donc la
#      valeur varie à chaque commit → cache miss garanti).
#   2. RUN echo écrit GIT_SHA/BUILD_TIME dans /build_meta/*.txt — bake les
#      valeurs dans le filesystem de l'image. Le /version controller lit ces
#      fichiers en fallback si process.env est vide. Immune au layer caching.
#   3. RUN echo au stdout → traçable dans Fly build logs.
ARG CACHEBUST_GIT_SHA=
ARG GIT_SHA=
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME
RUN mkdir -p /build_meta \
    && echo "${GIT_SHA}" > /build_meta/git_sha.txt \
    && echo "${BUILD_TIME}" > /build_meta/build_time.txt \
    && echo "[build_meta] git_sha=${GIT_SHA} build_time=${BUILD_TIME} cachebust=${CACHEBUST_GIT_SHA}"

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

# P18h — re-declare build args in runner stage (ARG doesn't cross stages)
# and bake into runtime ENV. Runtime container reads via process.env.
# P19w (29/04/2026) — Add CACHEBUST_GIT_SHA + COPY /build_meta from builder
# stage so /version controller has a file fallback when ENV layer caches.
ARG CACHEBUST_GIT_SHA=
ARG GIT_SHA=
ARG BUILD_TIME=
ENV GIT_SHA=$GIT_SHA
ENV BUILD_TIME=$BUILD_TIME

# P19w — Copie les fichiers meta baked au build pour fallback read côté runtime
COPY --from=builder /build_meta /build_meta

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
