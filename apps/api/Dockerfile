# Multi-stage build for the SmartVest API (NestJS, npm workspaces monorepo).
# Build context = repo root. The API depends on several @smartvest/* workspaces,
# so we copy the whole workspace tree for the install + build phase.

FROM node:20-alpine AS builder
WORKDIR /repo

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/ packages/
COPY apps/api/ apps/api/

RUN npm install --include=dev
RUN npm run -w @smartvest/api build

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
