# syntax=docker/dockerfile:1
# BetterWealth web image: builds the Vite bundle and serves it through
# apps/web/server.ts, which also proxies /api/v1 to the API container.
# Build context is the repository root:
#   docker build -f apps/web/Dockerfile .

FROM oven/bun:1.3.14 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/testkit/package.json packages/testkit/package.json
RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN bun run --cwd apps/web build

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

# server.ts only uses Bun built-ins, so the runtime needs no node_modules.
COPY --from=build /app/apps/web/dist ./dist
COPY apps/web/server.ts ./server.ts

USER bun

EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:4173/').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "server.ts"]
