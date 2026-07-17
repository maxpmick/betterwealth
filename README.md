# BetterWealth

BetterWealth is a self-hosted, household-scoped personal finance app built to answer two questions clearly:

1. What is actually safe to spend before the next paycheck?
2. If I keep following this plan, where will my wealth be by age 30?

It combines a double-entry-style allocation trail with an imported transaction ledger, envelope budgets, savings and purchase goals, manual assets, deterministic and Monte Carlo forecasts, SimpleFIN account sync, and explainable AI-assisted categorization.

The implementation is clean-room and uses Sure Finance only as product inspiration. The API and React application are separate processes so another client—such as a mobile app—can use the same versioned API later.

## Stack

- Bun runtime and workspace package manager
- React, Vite, TypeScript, MUI, and MUI X Charts
- Hono JSON API under `/api/v1`
- Drizzle ORM and SQLite in WAL mode
- Argon2id password hashing, cookie sessions, CSRF/origin checks, and AES-256-GCM field encryption
- SimpleFIN Bridge and an OpenAI-compatible model endpoint (OpenRouter by default)
- Bun Test, Testing Library, Vitest, and Playwright

## Start locally

Requirements: Bun 1.3 or newer.

```bash
cp .env.example .env.local
openssl rand -hex 32
```

Put the generated 64-character value in `ENCRYPTION_KEY`, then set a bootstrap email and a password of at least 12 characters. A SimpleFIN setup token and AI key are optional at first run.

```bash
bun install --frozen-lockfile
bun run bootstrap
bun run dev
```

Open [http://localhost:5173](http://localhost:5173). The API listens on `127.0.0.1:3001` by default. `bootstrap` is idempotent: it creates the initial household only when needed, configures the per-user encrypted AI integration, claims an unclaimed SimpleFIN setup token once, and performs the initial sync.

Never commit `.env.local`. A SimpleFIN setup token is single-use. The resulting access URL and AI key are encrypted before being stored in SQLite.

## Production build

The supported bare-metal layout, hardened systemd units, Caddy TLS proxy, preflight checks, update procedure, and tested restore drill are documented in [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md). Do not use the development environment file or expose the Bun listeners directly on a production host.

```bash
bun install --frozen-lockfile
bun run test:all
bun run build
sudo bash deploy/preflight.sh /etc/betterwealth.env
```

The supplied systemd services keep the API and web processes on loopback, apply migrations before API start, perform readiness checks, remove bootstrap secrets from the long-running environment, and expose only Caddy on HTTPS. Run initial setup through the one-shot bootstrap unit, then clear the bootstrap password and provider tokens from `/etc/betterwealth.env`.

## Docker Compose

`docker-compose.yml` builds both Bun images (`apps/api/Dockerfile`, `apps/web/Dockerfile`), applies migrations every time the API container starts, and publishes only the web process on `127.0.0.1:4173`. The API stays on the internal network; the web server proxies `/api/v1` to it.

```bash
printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > .env
docker compose up --build -d
```

Open [http://localhost:4173](http://localhost:4173). Optional one-shot bootstrap (owner account, SimpleFIN claim, first sync):

```bash
docker compose run --rm \
  -e BOOTSTRAP_USER_EMAIL=you@example.com \
  -e BOOTSTRAP_USER_PASSWORD='a-long-password' \
  api bun apps/api/src/cli/bootstrap.ts
```

SQLite lives in the `betterwealth-data` volume and backup snapshots in `betterwealth-backups`. For a public deployment, keep the published port on loopback, put a TLS proxy such as Caddy in front, and set `WEB_ORIGIN`, `COOKIE_SECURE=true`, and `TRUST_PROXY=true` in `.env`.

## Core workflow

- Connect SimpleFIN or create/import accounts manually.
- Imported records remain the transaction truth. Pending transactions reconcile conservatively and ambiguous matches stay separate.
- Existing deterministic rules run first. The AI sees a minimized transaction description, direction, amount, account type, and an allowlist of category IDs—not credentials or balances.
- A high-confidence first-seen pattern can be categorized automatically and converted into a narrow deterministic rule. Lower-confidence output stays in review. Every rule is visible, editable, previewable, disableable, and auditable.
- Create monthly or paycheck envelopes, enter approximate category/bill spending, and attach category or transaction rules. The dashboard subtracts protected bills, envelopes, goal contributions, and the minimum cash buffer from spendable cash.
- Create emergency-fund, purchase, payoff, and investing goals. Comfortable-purchase dates preserve the emergency floor and higher-priority goals.
- Compare conservative, baseline, ambitious, or custom scenarios through age 30. Deterministic forecasts are reproducible; Monte Carlo forecasts use an explicit seed and show percentile ranges.
- Add a home, vehicle, business, or other manual asset and append valuations over time. Provider references and confidence are recorded without pretending an estimate is an appraisal.

## Commands

```bash
bun run dev            # API + web development servers
bun run build          # production builds
bun run typecheck      # every workspace
bun run lint           # Biome
bun run format         # Biome auto-fix
bun run test           # unit/integration + web component tests
bun run test:e2e       # Playwright browser journeys
bun run audit          # dependency vulnerability audit
bun run test:all       # full release gate, including dependency audit
bun run db:check       # validate the Drizzle migration journal
bun run db:migrate     # apply SQLite migrations
bun run db:seed        # idempotent canonical age-22 demo fixture
bun run db:backup      # timestamped online SQLite backup
bun run ops:backup     # online backup followed by integrity verification
bun run ops:verify-backup -- /path/to/backup.sqlite
bun run ops:health     # local API + web readiness check
bun run auth:reset-password -- --email user@example.com
bun run bootstrap      # initial user/integrations/sync
```

A pre-commit hook in `.githooks/` runs `biome check` on staged files so lint and format issues
are caught before they reach CI. `bun install` activates it automatically by setting git
`core.hooksPath`; fix findings with `bun run format`, or bypass in an emergency with
`git commit --no-verify`.

GitHub Actions runs the audit, migration, lint, type, unit, integration, production-build,
desktop-browser, mobile-browser, and accessibility checks as parallel jobs on every pull request
and push to `main`; the `Release gate` check passes only when all of them pass. Publishing a
GitHub release re-runs the full gate, then attaches verified web and API build archives with
SHA-256 checksums to the release. JUnit test reports are uploaded for every run, and browser
traces, screenshots, and videos are retained when browser tests fail.

The canonical E2E user is `alex@example.com` with password `WealthBy30!2026`; it is created only by the demo/test seed and must never be used as a production account.

## Data and backups

The default database is `data/betterwealth.sqlite`. SQLite foreign keys, WAL, busy timeout, and tenant constraints are enabled at connection time. Money is stored as checked signed 64-bit minor-unit text and crosses JSON boundaries as a base-10 string, never a floating-point amount.

Create a consistent online backup:

```bash
bun run ops:backup
bun run --cwd apps/api db:backup -- /secure/path/wealth.sqlite
bun run ops:verify-backup -- /secure/path/wealth.sqlite
```

The managed command uses SQLite's online snapshot mechanism and produces one verified, mode-0600, DELETE-journal database file. Do not copy the live main database while it is in WAL mode. Local backups do not protect against disk failure or host compromise, so copy verified snapshots to encrypted off-host storage. Test restoration before relying on it. The exact stop, preserve-WAL, restore, migrate, and application-validation procedure is in [`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md#6-restore-drill).

For a non-destructive migration check on a disposable copy:

```bash
cp /secure/path/wealth.sqlite data/restore-test.sqlite
DATABASE_URL=./data/restore-test.sqlite bun run db:migrate
```

The Settings API also exposes a secret-free JSON export and an owner-only standalone SQLite download. JSON exports omit password hashes, sessions, access URLs, and encrypted integration settings; SQLite backups necessarily contain the complete database and must be protected like the live data directory.

## Security notes

- Serve production only behind HTTPS and set `APP_ENV=production`, `COOKIE_SECURE=true`, and the exact public `WEB_ORIGIN`. Set `TRUST_PROXY=true` only when the API remains loopback-only behind the trusted reverse proxy.
- Keep the API and web listeners on loopback. Do not expose port 3001 directly.
- Store the environment file with mode `0600`; store data and backups with restrictive ownership.
- Back up the encryption key separately from the database. Losing it makes encrypted provider credentials unrecoverable; leaking both defeats field encryption.
- Remove bootstrap passwords and one-time provider tokens from the production environment immediately after bootstrap.
- Rotate an AI key if it was ever pasted into a public issue, shell history, or committed file.
- BetterWealth provides educational projections, not financial, tax, legal, appraisal, or investment advice.

## Repository map

```text
apps/api          Hono API, auth, sync, AI pipeline, jobs, and CLI
apps/web          React/MUI browser application
packages/db       Drizzle schema, migrations, repositories, SQLite helpers
packages/shared   exact money, rule, allocation, goal, and forecast engines
packages/testkit  canonical age-22 fixtures and provider edge cases
e2e               Playwright user journeys
docs              product and architecture blueprint
deploy            bare-metal service and reverse-proxy examples
```

See [`docs/PRODUCT_BLUEPRINT.md`](docs/PRODUCT_BLUEPRINT.md) for the full domain model, screen states, trust model, prioritization policy, and test matrix.
