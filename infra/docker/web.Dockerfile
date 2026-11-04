# AthosBet web (Next.js). On Vercel this file is not used.
FROM node:22-alpine AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @athosbet/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
ARG API_URL=http://api:4000
ENV API_URL=$API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @athosbet/shared build && pnpm --filter @athosbet/web build

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /repo
RUN addgroup -S athos && adduser -S athos -G athos
COPY --from=build --chown=athos:athos /repo /repo
USER athos
WORKDIR /repo/apps/web
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-p", "3000"]
