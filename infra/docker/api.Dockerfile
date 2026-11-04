# AthosBet API / worker image
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/odds-engine/package.json packages/odds-engine/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @athosbet/api...
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @athosbet/shared build && pnpm --filter @athosbet/odds-engine build && pnpm --filter @athosbet/api build
RUN pnpm deploy --legacy --filter @athosbet/api --prod /out && cp -r apps/api/dist apps/api/migrations /out/

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S athos && adduser -S athos -G athos
COPY --from=build --chown=athos:athos /out /app
USER athos
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/api/health || exit 1
CMD ["node", "--enable-source-maps", "dist/main.js"]
