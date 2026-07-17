# syntax=docker/dockerfile:1
# BetterWealth API image. Build context is the repository root:
#   docker build -f apps/api/Dockerfile .
# Bun version matches packageManager in the root package.json.

FROM oven/bun:1.3.14 AS deps
WORKDIR /app

# Install with every workspace manifest present so bun can resolve the graph.
COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/testkit/package.json packages/testkit/package.json
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages
COPY apps/api ./apps/api

# The API writes SQLite to ./data and backup snapshots to ./backups, both
# resolved from the workspace root (/app). Run as the image's unprivileged user.
RUN mkdir -p /app/data /app/backups && chown -R bun:bun /app/data /app/backups
USER bun

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3001/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Apply migrations before every start, mirroring the systemd unit's ExecStartPre.
CMD ["sh", "-c", "bun apps/api/src/cli/migrate.ts && exec bun apps/api/src/index.ts"]
