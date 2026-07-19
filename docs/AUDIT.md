# BetterWealth Repository Audit

Date: 2026-07-17
Scope: entire repository — `apps/`, `packages/`, `e2e/`, `deploy/`, `.github/`, `docs/`, root configs. Read-only audit; no code was changed.
Method: verification baseline (every release-gate command run locally), four deep-dive area reviews with path:line evidence, spot re-verification of all critical/high findings by a second reader, and a live runtime probe of the API error contract.

## Verification baseline

All release-gate commands were run locally on 2026-07-17 against this working tree:

| Check | Command | Result |
| --- | --- | --- |
| Dependency audit | `bun run audit` | PASS — no vulnerabilities found |
| Migration journal | `bun run db:check` | PASS — "Everything's fine" |
| Lint/format | `bun run lint` | PASS (exit 0) — 0 errors, **271 warnings** (composition verified below) |
| Typecheck | `bun run typecheck` | PASS — all 5 workspaces exit 0 |
| Unit/integration | `bun test packages apps/api/src` | PASS — 199 tests, 37 files, 0 fail |
| Web component | `bun run test:web` | PASS — 85 tests, 12 files |
| Production build | `bun run build` | PASS — all workspaces; Vite warns main chunk is 796 kB (>500 kB) |
| Browser journeys | `bun run test:e2e` | PASS — 34 tests (17 journeys × desktop + mobile Chromium), 3.2 min |

Composition of the 271 lint warnings (verified with `biome check --max-diagnostics=400`): 268 × `lint/style/noNonNullAssertion`, 2 × `lint/complexity/useOptionalChain`, 1 × `lint/correctness/noUnusedVariables`. Concentration: `packages/shared/src/forecast.ts` (42), `apps/api/src/personalization/service.ts` (42), `apps/api/src/personalization/service.test.ts` (37), `apps/api/src/routes/planning.ts` (32). Biome is configured to treat these as warnings, so the gate is green while the style rule is effectively unenforced.

Runtime probe (live API booted via `e2e/start-api.ts`, then killed): malformed JSON body on `POST /api/v1/auth/login` returned **HTTP 500 `internal_error`** (expected 400); a 3 MB body returned **HTTP 500 `internal_error`** (expected 413); a correct-shape wrong-credentials login returned the canonical HTTP 401 error envelope. This confirms finding A3-5 below at runtime, not just by static inference.

## How to read severity

- **critical** — blocks or actively misleads a second API client, or is a live security/correctness hazard.
- **high** — structural debt that will compound; security-sensitive behavior without a safety net.
- **medium** — real inconsistency or gap with a bounded blast radius.
- **low** — polish, hygiene, or documentation drift.

---

## Area 1 — Architecture & repo structure

### Findings

- **[high] A1-1: The API contract is maintained in three hand-synced places — and the canonical one is dead code.**
  - Where: `packages/shared/src/schemas.ts:517-616`, `apps/web/src/api.ts:13-16`, `apps/api/src/app.ts:37-143`
  - Evidence: `schemas.ts` defines a full response contract (`DashboardReportSchema`, `NetWorthReportSchema`, `CashFlowReportSchema`, `AuthResponseSchema`, `ApiSuccessSchema`, `PaginatedResponseSchema`) that **nothing in `apps/` imports** (grep-verified; the file's only consumers are engine/rule/money schemas). The web client header admits the situation: *"These local interfaces intentionally mirror the product blueprint while the shared contract package is still being assembled"* (`api.ts:13-15`) and parses responses with unchecked casts (`(await response.json()) as T`, `api.ts:748`). The OpenAPI document is generated from a hand-typed `documentedOperations` array (`app.ts:37-143`) with summaries only — no request/response body schemas. `@hono/zod-openapi` is a declared dependency (`apps/api/package.json:21`) with zero imports. Colliding type names already exist: `DashboardReport` is defined independently at `schemas.ts:555` and `api.ts:36`.
  - Why it matters: with multiple first-party clients planned, the contract living in three manually-synced places with no runtime validation on either side makes drift a certainty. See A3-1/A3-2 for the concrete contradictions.

- **[high] A1-2: `planning.ts` is a god file: 5,851 lines, 108 route registrations across ~10 resource domains, with business logic inline in handlers.**
  - Where: `apps/api/src/routes/planning.ts` (line count verified; route table at `planning.ts:2921-5057+`; representative handler `planning.ts:3405-3582`)
  - Evidence: one file serves envelopes, budgets, budget-periods, allocations, bills, goals, goal contributions, rules, rule preview/apply, scenarios, forecast-scenarios, forecasts, imports, assets, income sources, and profile/household endpoints; it imports 30+ Drizzle tables (`planning.ts:2-34`). The `build-from-monthly-spend` handler alone is ~180 lines doing envelope upserts, category-link replacement, and allocation inserts inside `db.transaction` (`planning.ts:3451-3577`).
  - Why it matters: merge-conflict epicenter and the main reason no service layer exists for the planning domain (unlike categorization/personalization, which have one). Splitting by resource would match the structure the app already uses elsewhere.

- **[high] A1-3: Web money handling contradicts the system's exact-money discipline.**
  - Where: 70 occurrences of `Number(...)/100` across 11 files in `apps/web/src` (grep-verified), e.g. `apps/web/src/pages/TodayPage.tsx:237`, `apps/web/src/pages/BudgetPage.tsx:78`, `apps/web/src/components/ui.tsx:30-37`
  - Evidence: every page converts minor units via `Number(money.minorUnits) / 100` — an IEEE-754 float with a hardcoded 2-fraction-digit assumption — then formats via local helpers; charts hardcode `$` (`TodayPage.tsx:734`, `AccountsPage.tsx:457`, `ForecastPage.tsx:341-368`). `packages/shared` already has `CURRENCY_METADATA` with per-currency `fractionDigits` (JPY=0, KWD=3, BTC=8 — `packages/shared/src/currency.ts:29-47`) and `formatMinorUnits` (`packages/shared/src/money.ts:259-268`); the web uses neither. README:106 promises money "never a floating-point amount"; `packages/db/src/money.ts:50-64` enforces it at persistence.
  - Why it matters: float conversion of int64 minor units loses precision past 2^53 and mis-formats every non-2-digit currency. The conversion/formatting belongs in one shared helper consumed by web, not 70 inline copies.

- **[medium] A1-4: The repository layer exists but is bypassed by most routes; household isolation is enforced by convention.**
  - Where: `packages/db/src/repositories.ts:58-72` vs `apps/api/src/routes/ledger.ts`, `apps/api/src/routes/reports.ts`, `apps/api/src/routes/operations.ts`, `apps/api/src/routes/planning.ts`
  - Evidence: the db package provides `householdScope`/`householdAnd` mandatory predicates and `createHouseholdRepositories`, but among route files only `integrations.ts` uses them (34 references total). Other routes hand-write `eq(table.householdId, auth.householdId)` — 442 `householdId` occurrences in `planning.ts` alone, 178 in `ledger.ts`.
  - Why it matters: tenant isolation depends on every query author remembering the predicate, in the two largest files in the codebase. The repository pattern's value is making the scoped path the easy path; today it is the exception.

- **[medium] A1-5: Validation schemas and DTO helpers are re-implemented per route file with divergent rules.**
  - Where: `apps/api/src/routes/planning.ts:77-91`, `apps/api/src/routes/ledger.ts:57-65,96-100`, `apps/api/src/routes/reports.ts:52-56`
  - Evidence: currency validation exists three ways — shared `CurrencyCodeSchema` (`packages/shared/src/money.ts:7-11`), planning's local regex (`planning.ts:81-85`), ledger's `z.string().length(3)` (`ledger.ts:96-100`). Minor-unit validation in reports rejects negatives that shared `MinorUnitsStringSchema` accepts. `ledger.ts:57-65` hand-rolls `queryAmountMinorUnits` with a hardcoded `* 100n`, duplicating `parseDecimalToMinorUnits` without its precision handling. Money JSON serializers are duplicated (`ledger.ts:30-32` vs `planning.ts:218`).
  - Why it matters: the same field accepts different values depending on the endpoint — exactly what a shared contract package exists to prevent.

- **[medium] A1-6: Oversized functions and page components concentrate too many responsibilities.**
  - Where: `apps/api/src/personalization/service.ts` (3,338 lines; `analyzePersonalizationLedger` ~700 lines from `:550`), `apps/api/src/categorization/service.ts:773` (`categorizeHouseholdTransactions` ~730 lines), `apps/web/src/pages/TransactionsPage.tsx` (3,348 lines), `apps/web/src/pages/WealthPages.tsx` (3,021), `apps/web/src/pages/AutomationPage.tsx` (2,352)
  - Evidence: `wc -l` verified. `TransactionsPage.tsx` mixes infinite queries, drawer editing, bulk operations, splits, transfer/refund linking, demo fixtures, and its own `Intl.NumberFormat` helper (`:277-280`). Web has only 4 component files against 10 pages, so nearly all UI lives in monolithic pages.
  - Why it matters: these files are touched by every feature; their size raises review cost and defect-hiding surface, and eager imports of Today/Transactions/Budget (`apps/web/src/App.tsx:10-12`) contribute to the 796 kB main chunk.

- **[medium] A1-7: Dead dependencies and duplicated money primitives across db/shared.**
  - Where: `apps/api/package.json:21` (`@hono/zod-openapi`, zero imports), `packages/testkit/package.json:13` (`@betterwealth/db`, zero imports in testkit source), `packages/db/package.json` (`@betterwealth/shared` declared; zero imports in `packages/db/src`), `packages/db/src/money.ts:3-48` vs `packages/shared/src/money.ts`
  - Evidence: greps for each package name in the corresponding source trees returned only manifest/lockfile hits. `db/src/money.ts` re-defines int64 bounds and canonical-integer parsing that shared already has.
  - Why it matters: dead deps mislead readers about the real module graph; the db/shared duplication is a small two-sources-of-truth for financial bounds checking.

- **[medium] A1-8: Demo/fixture data exists in three independent representations.**
  - Where: `packages/testkit/src/alex.ts` (720-line canonical fixture), `apps/web/src/data.ts` (441 lines, float-based separate interfaces), `apps/web/src/pages/TodayPage.tsx:90-170` (inline demo fixture assembly), `apps/api/src/seed/canonical-alex.ts:47`
  - Evidence: web demo mode fabricates API-shaped responses client-side from `data.ts` instead of reusing the canonical testkit fixture the API seeds. The API declares `@betterwealth/testkit` as a **runtime** dependency because the production-callable `db:seed` CLI imports it (`canonical-alex.ts:47`, `cli/seed.ts:4`).
  - Why it matters: three fixture sources drift independently (web demo already uses floats vs the API's strings). The runtime dependency on testkit blurs the test/prod boundary, though it is deliberate for the documented demo seed.

- **[low] A1-9: Orphaned tooling and unreferenced artifacts.** `e2e/capture-screenshots.ts` (75-line standalone script) and `docs/screenshots/` (6 committed PNGs) are referenced by no script, CI job, playwright config, or markdown (grep-verified). The script hardcodes credentials and `127.0.0.1:5173`. Stale-asset risk; either wire into a script or delete.

- **[low] A1-10: README command list drift.** Root scripts `ops:preflight`, `personalize:dry-run`, `personalize:apply`, `start:api`, `start:web`, `db:generate`, `test:unit`, `test:web` are undocumented in README:67-88; the api's `recategorize` script has no root alias. Undocumented ops commands are the ones operators need most.

- **[low] A1-11: Minor web/API structural inconsistencies.** Session-guard logic is copy-pasted into `ProtectedAppShell`, `ProtectedOnboarding`, `SessionAwareRoot` (`apps/web/src/App.tsx:55-104`); `apps/web/server.ts:38` hardcodes upstream `http://127.0.0.1:3001` duplicating `apps/api/src/config.ts:44`; `e2e/start-api.ts:2-4` imports `../apps/api/src/...` by relative path, bypassing package names; `date-fns` is imported exactly once (`apps/web/src/components/ui.tsx:24`) while pages use raw `new Date` 76 times.

### Verified strengths

- **Clean workspace dependency direction**: `shared` imports nothing internal; `api` imports `shared`/`db`/`testkit`; `web` imports only `@betterwealth/shared`; no `packages/*` → `apps/*` imports and no web → api-source imports (grep over all workspaces).
- **Shared engines are genuinely reused server-side and stay pure**: `calculateSafeToSpend` (`reports.ts:23`), `runForecast`/`runMonteCarlo`/`evaluateRules` (`planning.ts:41-58`).
- **Single API client in web**: one `request<T>` wrapper handling CSRF mirroring, credentials, error envelope, 204s (`api.ts:701-749`); only two raw `fetch(` call sites in the app.
- **Exact-money persistence done right**: Drizzle custom type stores canonical base-10 text with checked bigint conversion (`packages/db/src/money.ts:50-64`); shared money math is fully checked with explicit rounding modes (`packages/shared/src/money.ts:163-209`).
- **Security cross-cutting concerns centralized**: CORS allowlist, secure headers, body limit, per-endpoint rate limits, `Cache-Control: no-store` all in one place (`app.ts:203-270`); route factories receive `db`/`config` by injection (`app.ts:330-335`).
- **Job worker uses proper lease semantics** with epoch-based optimistic claiming (`apps/api/src/jobs/worker.ts:28-64`).
- **Repo hygiene**: `.gitignore` covers `data/`, `backups/`, sqlite sidecars; zero `biome-ignore` suppressions; CI split into focused parallel jobs.

---

## Area 2 — Test quality & structure

Baseline re-verified during the audit: `bun test packages apps/api/src` → 199 pass / 0 fail across 37 files; `bun run --cwd apps/web test` → 85 pass across 12 files; e2e 34 pass.

### Findings

- **[high] A2-1: The password-change route has zero server-side test coverage.**
  - Where: `apps/api/src/routes/operations.ts:157-206`
  - Evidence: `POST /profile/password` verifies the current password, re-hashes with argon2id, revokes all other sessions (`:185-189`), and writes an audit event. Grep for `profile/password` across all server test files returns nothing; the only reference is `apps/web/src/test/api.test.ts:31`, which stubs `fetch` and asserts the client hits the right URL.
  - Why it matters: wrong-password rejection and cross-session revocation are security-critical; a regression (dropping the `ne(sessions.id, auth.sessionId)` guard) would ship green.

- **[high] A2-2: Session lifecycle branches untested: idle/absolute expiry, logout.**
  - Where: `apps/api/src/auth/service.ts:196-266` (expiry filters `:219-220`, `touchSession` idle rollover `:253-266`)
  - Evidence: `auth/service.ts` has no dedicated test file; it is exercised only via happy-path register/login/session tests. No test creates a session with a past `idleExpiresAt`/`absoluteExpiresAt` and asserts 401; no test asserts `touchSession` extends idle without exceeding the absolute cap; `POST /auth/logout` matches no test file (grep-verified).
  - Why it matters: session expiry is the primary defense-in-depth for a self-hosted finance app; the SQL `gt(...)` filters and the `Math.min` cap are exactly the kind of code that silently breaks during refactors.

- **[medium] A2-3: Rate limiter's overflow/eviction logic untested.**
  - Where: `apps/api/src/lib/rate-limit.ts:14-56` (no `rate-limit.test.ts` exists)
  - Evidence: only end-to-end coverage through login throttling (`security.integration.test.ts:163-187`, which does verify X-Forwarded-For can't reset the bucket — good). Untested: the `MAX_BUCKETS = 10_000` overflow bucket path (`:37-47`), window reset, per-key isolation, and the `RateLimit-*` response headers (`:48-50`).
  - Why it matters: the overflow bucket is the least-obvious code in the module and could fail open (no limiting under pressure) or fail closed (one attacker throttles everyone).

- **[medium] A2-4: Import parsers have ~8 untested error branches for untrusted-file input.**
  - Where: `apps/api/src/imports/parsers.test.ts` (32 lines) vs `apps/api/src/imports/parsers.ts` (142 lines)
  - Evidence: only two happy-path tests. None of the explicit `AppError` branches are asserted: unterminated quote (`parsers.ts:37-38`), missing columns (`:56-66`), invalid date (`:70-71`), invalid amount (`:79-81`), empty OFX (`:104-105`), incomplete OFX row (`:110-111`), bad OFX date (`:114-115`), unsupported extension (`:141`). Parenthesized negatives (`:78`) and BOM stripping (`:45`) are unexercised.
  - Why it matters: this parser ingests arbitrary user files; the fail-closed 400s are the documented contract, and e2e covers only the success path plus duplicate-ID 409.

- **[medium] A2-5: The canonical fixture (testkit) is used in only 5 of 37 bun test files — ad-hoc row building dominates.**
  - Where: e.g. `apps/api/src/sync/simplefin-sync.integration.test.ts:65-120`, `apps/api/src/categorization/service.integration.test.ts:90-122`
  - Evidence: `@betterwealth/testkit` imports appear in just 5 test files. Elsewhere tests hand-insert rows with `ulid()`, repeating the same column lists. The testkit's provider edge-case fixtures (`packages/testkit/src/simplefin.ts`, `openrouter.ts`) are validated but consumed by only one integration test.
  - Why it matters: every schema change requires editing N inline insert blocks instead of one fixture; drift between hand-rolled shapes and the canonical seed is how tests start passing against unrealistic data. (Mitigation: the duplication is type-checked by Drizzle.)

- **[low] A2-6: Wall-clock coupling in goals/planning integration tests.** Expected values computed from real time at assertion time (`goals.integration.test.ts:356` and ~10 similar sites; `planning.integration.test.ts:145,244,286`). A test crossing a month/UTC-day boundary between request and assertion fails spuriously. Once-a-month red CI erodes trust.

- **[low] A2-7: Job worker tests use real short timers** (`worker.test.ts:101-153`: `leaseDurationMs: 80`, `Bun.sleep(110)`). Well-mitigated (bounded polling loops) but still wall-clock scheduling; a fake clock would remove it.

- **[low] A2-8: Tautological test in the web API suite.** `apps/web/src/test/api.test.ts:9-13` constructs a local object literal and asserts `typeof transport.minorUnits === "string"` — no production code is invoked; it tests its own fixture (and uses the `Number()/100` float pattern, ironically).

- **[low] A2-9: CLI entry points untested.** `cli/backup.ts`, `bootstrap.ts`, `migrate.ts`, `seed.ts`, `personalize.ts`, `recategorize.ts` — underlying logic is tested (`backup.test.ts`, `canonical-alex.test.ts` idempotency), but the argument-parsing/env-wiring layer has no coverage. `data/seed-smoke.sqlite` exists in the working tree but nothing references `seed-smoke` — appears to be a manual artifact.

- **[low] A2-10: Crypto test misses the tampered-ciphertext case; AuthPages has no unit test.** `crypto.test.ts:15-18` tests AAD-mismatch (good) but not bit-flipped ciphertext/authTag rejection. `AuthPages.tsx` is covered only by e2e.

### Coverage map

- **packages/shared** — all engines covered by colocated property-based tests (`money.test.ts`, `rules.test.ts`, `allocation-goals.test.ts`, `forecast.test.ts`, `goal-insights.test.ts`). `schemas.ts` only partially exercised (mostly via testkit parsing — consistent with A1-1).
- **packages/db** — fully covered: client, migrations (idempotent + 0000→latest upgrade), repositories, transactions, money, encrypted-payload, backup (`db.integration.test.ts`, `backup.test.ts`).
- **apps/api covered**: app assembly, categorization (4 test files incl. a 2,009-line integration suite), sync, jobs/worker, openrouter, crypto/egress/logger/net-worth libs, personalization, routes ledger/planning/reports/integrations, seed.
- **apps/api NOT or weakly covered**: `routes/operations.ts` (password change, members, logout), `auth/service.ts` expiry branches, `lib/rate-limit.ts` internals, `integrations/simplefin.ts` (only `decodeSetupToken` — 27 test lines for a 193-line module), `imports/parsers.ts` error branches, `lib/errors.ts`, all CLI entry points.
- **apps/web**: all pages have dedicated tests except `AuthPages.tsx`; `api.ts` tested with canned responses.
- **e2e** (3 specs × desktop + mobile): Today/safe-to-spend, merchant review, budget funding, goals + forecast, goal CRUD, manual transaction + exact split (BigInt assertion), CSV import + duplicate 409, transfer match + refund link, envelope + rule, asset revaluation, automation rule lifecycle, AI key storage/export exclusion, cross-context session revocation, privacy masking, keyboard/focus, axe on 8 routes, login-failure uniformity. **Missing vs README core workflow**: SimpleFIN connect journey (real network — understandably absent), pending→posted reconciliation journey, onboarding journey. Axe gates only serious/critical violations (`security-privacy-accessibility.spec.ts:184-201`).

### Verified strengths

- **Property-based money tests**: full-int64 JSON round-trip (`money.test.ts:36-45`), add/sub inverse, banker's-rounding symmetry, canonical-form rejection of `"01"`/`"-0"`.
- **Conservation properties**: percentage splits always sum to the parent (`rules.test.ts:120-138`); double-entry conservation (`allocation-goals.test.ts:40-61`).
- **Monte Carlo determinism**: identical-seed byte equality (`forecast.test.ts:104-120`), percentile ordering, correlation-matrix validation.
- **Real-DB discipline**: migrations tested idempotently and as an upgrade from a synthetic 0000 journal (`db.integration.test.ts:112-148`); cross-household read AND write isolation (`:188-254`); rollback on throw (`:424-443`).
- **Genuinely hostile security integration tests**: XFF spoofing can't reset throttling, hostile origin 403, non-JSON 415, viewer-role 403 with DB unchanged, db file perms 0600/0700 (`security.integration.test.ts:95-192`).
- **AI pipeline tests check the privacy claims**: coarse amount bands, prompt-injection kept in the data message, malicious feedback never enters the system prompt, cross-household category id rejected (`openrouter.test.ts:36-217`).
- **No global fetch mocking in API tests** — network/AI are injected; the only raw `fetch` is `lib/egress.ts:130`, which has SSRF/blocklist tests.
- **Web tests use real DOM** via Testing Library + userEvent: exact-cent split validation (`TransactionsPage.test.tsx:210-241`), transfer candidate exclusion from the DOM (`:243-292`).
- **Test isolation**: in-memory or `mkdtempSync` SQLite per test with cleanup; e2e rebuilds `data/e2e.sqlite` from scratch; vitest `restoreMocks: true`; JUnit reporters wired in CI for all three suites.

---

## Area 3 — Multi-client API readiness

The owner plans multiple first-party clients (e.g. mobile) against the same `/api/v1` API. This section judges the API as a versioned public contract, not as a private backend for the SPA.

### Endpoint inventory

All six route modules mount under `/api/v1` (`app.ts:330-335`); the only unversioned endpoint is `GET /health` (`app.ts:278`). App-level discovery endpoints: `/api/v1/health`, `/api/v1/capabilities`, `/api/v1/openapi.json`.

- **auth.ts**: register, login, session, sessions list/revoke, logout
- **ledger.ts**: accounts, categories, transactions (CRUD + restore + tags + splits + bulk), transfers, refund-links
- **integrations.ts**: connections, SimpleFIN claim, sync-runs, integration settings, AI suggestions
- **operations.ts**: profile (+password), household members, audit-events, data-export, database-backup
- **planning.ts**: envelopes, budgets, **budget-periods (duplicate family)**, allocations, bills, goals (+order, contributions), rules (+preview/apply), scenarios, **forecast-scenarios (duplicate family)**, forecasts, assets (+valuations), income-sources, imports
- **reports.ts**: dashboard (+preferences), net-worth, cash-flow, spending

### Findings

- **[critical] A3-1: The published contract package is dead and contradicts the live API.**
  - Where: `packages/shared/src/schemas.ts:13-54,173,281,321-328`
  - Evidence: `ApiErrorSchema` requires SCREAMING_SNAKE `code`, `requestId`, `retryable` — the live error shape is `{ error: { code: "snake_case", message, details? } }` (`app.ts:342-363`). `PaginatedResponseSchema` declares `page.nextCursor`/`total` — live pages are `{ cursor, hasMore }`. `TransactionStatusSchema` is `["pending","posted","stale","removedUpstream"]` — live is `"pending"|"posted"|"removed"|"void"` (`ledger.ts:776`). `GoalTypeSchema` (`emergencyFund`, `debtFree`) doesn't match live (`emergency_fund`, `debt_payoff` — `planning.ts:963-970`). Grep confirms nothing in apps imports these DTO/envelope schemas (see A1-1).
  - Why it matters: a second client that trusts `@betterwealth/shared` as the API contract — the natural thing to do in this monorepo — would codegen types that fail at runtime on errors, pages, and core enums. Either fix or delete this file before onboarding clients.

- **[critical] A3-2: `openapi.json` is hand-maintained, schema-less, and already stale.**
  - Where: `apps/api/src/app.ts:37-143,289-328`
  - Evidence: `documentedOperations` omits at least 10 live endpoints — the entire `/budget-periods` family (5 routes) and `/forecast-scenarios` family (4 routes), plus `/openapi.json` itself (grep-verified: neither string appears in `app.ts`). Operations carry no request/response schemas — only generic 200/400/401/422 descriptions; no 403/404/409/413/415/429. The `Money` component says `currency` is `^[A-Z]{3}$` (`app.ts:311`) but the real `CurrencyCodeSchema` accepts `[A-Za-z][A-Za-z0-9_-]{2,11}` (`money.ts:7-11`).
  - Why it matters: the spec is the only machine-readable contract a new client gets, and it is neither complete nor accurate. The web client's own comment admits types are hand-mirrored pending generated OpenAPI types (`apps/web/src/api.ts:13-16`).

- **[high] A3-3: Auth is cookie-only with a mandatory double-cookie CSRF dance on every mutation.**
  - Where: `apps/api/src/auth/middleware.ts:66-107`, `apps/api/src/routes/auth.ts:46-52`
  - Evidence: `requireAuth` resolves sessions exclusively from `bw_session`/`bw_household` cookies; no `Authorization`/bearer path exists inbound (grep-verified). `requireCsrf` demands the `bw_csrf` cookie AND a matching `X-CSRF-Token` header on all non-GETs. Mitigations: origin-less clients are deliberately allowed (`middleware.ts:41-50`) and login returns `csrfToken` in the JSON body (`auth.ts:52`), so a native client *can* authenticate today — but only by reimplementing browser cookie semantics, a flow documented nowhere (OpenAPI declares only `sessionCookie`). Notably, the schema already has a `personal_access_tokens` table (`packages/db/src/schema.ts:180-197`) and audit events support `actorType: "token"` (`schema.ts:2028`), but **nothing in `apps/api/src` references `personalAccessTokens`** (grep-verified) — the table is dormant.
  - Why it matters: a mobile client must store cookies and mirror CSRF tokens exactly like a browser; there is no token credential to put in a keychain. The dormant PAT table is the natural foundation.

- **[high] A3-4: `Idempotency-Key` is advertised but honored on exactly one endpoint.**
  - Where: `apps/api/src/app.ts:228` (CORS allow-headers), `apps/api/src/routes/integrations.ts:406-435` (sync-runs honors it), `apps/api/src/routes/ledger.ts:1893-1974` (bulk ignores it), `apps/web/src/api.ts:896-901`
  - Evidence: web sends `Idempotency-Key` on `POST /transactions/bulk` and `POST /sync-runs`; only sync-runs reads the header. Other creates (`POST /transactions`, `/goals`, `/accounts`…) have no idempotency. Imports dedupe by file hash with 409 — a different mechanism.
  - Why it matters: retry-safe mutation is a baseline expectation for mobile clients on flaky networks; today a retried create double-posts, and the header's presence in CORS implies support that doesn't exist.

- **[high] A3-5: Two error paths bypass the canonical error contract entirely — runtime-verified.**
  - Where: `apps/api/src/app.ts:239` (bodyLimit), `app.ts:340-378` (onError lacks an `HTTPException` branch)
  - Evidence: **verified live during this audit** — a malformed JSON body on `POST /api/v1/auth/login` returns HTTP 500 `internal_error` (the custom `onError` only knows `AppError`/`ZodError`; Hono's `context.req.json()` throws `SyntaxError`), and a body over the 2 MB limit returns HTTP 500 `internal_error` instead of 413 (bodyLimit throws `HTTPException(413)` which the custom handler doesn't special-case). A correct control request returns the canonical 401 envelope. Secondary inconsistency: imports accept `content` up to 10 MB (`planning.ts:2907-2910`) while the global body cap is 2 MB — any import >2 MB hits the 500.
  - Why it matters: client-untriggerable 500s for routine bad input make error handling on a new client guesswork, and the 2 MB/10 MB mismatch makes large imports fail with the least informative error in the system.

- **[medium] A3-6: Duplicate route families with divergent behavior and DTOs.** `/budgets` vs `/budget-periods` (`planning.ts:3125-3141`; `PATCH /budget-periods/:id` silently ignores fields `PATCH /budgets/:id` handles, `:3584-3608`); `/scenarios` vs `/forecast-scenarios` — same rows, one returns UI-shaped DTOs, the other engine-shaped (`:4737-4745` vs `:4921-4929`). Both live, undocumented, non-interchangeable. Freezing v1 means either documenting both or deprecating one — decide before external clients pick one at random.

- **[medium] A3-7: Bounded list endpoints lie about pagination.** `audit-events` (limit 250), `sync-runs` (50), `ai/suggestions` (1000), `forecasts` (100), `imports` (100) all return `page: { cursor: null, hasMore: false }` while truncating (`operations.ts:233-234`, `integrations.ts:456-457,715,760`, `planning.ts:5064-5065,5663-5664`). Only `GET /transactions` has a real cursor (`ledger.ts:168-185,796-805`). A client cannot detect or recover missing rows; `hasMore: false` falsely claims completeness.

- **[medium] A3-8: Validation failures split across 400 and 422 by accident of mechanism.** Zod failures → 422 `validation_failed` (`app.ts:353-364`); domain checks throw 400 `invalid_budget`/`invalid_allocation`/`invalid_rule` (`planning.ts:3149,3664-3668,4511`) or 422 `invalid_ledger_operation` (`ledger.ts:233-235`). Clients can't key logic off status codes and must parse `error.code` strings — which are undocumented.

- **[medium] A3-9: Write schemas accept two parallel money representations, and some accepted fields are silently ignored.** `target` Money OR `targetAmountMinorUnits` (`planning.ts:986-991`); `budgetWriteSchema` accepts `spent`/`remaining`/`unassigned` (`planning.ts:378-380`) but no handler reads them — accepted-but-ignored fields return success. Dual input forms double the contract surface forever; silently ignored fields are worse than 422s.

- **[medium] A3-10: Household timezone is stored but never used; all date bucketing is UTC.** Dashboard "today", cash-flow months, spending boundaries all use `new Date().toISOString()` UTC slicing (`reports.ts:338,883-885`, `planning.ts:238-240`) regardless of `households.timezone` (only read/written in `operations.ts:63,92,133`). Any client displaying household-local dates will disagree with the API around midnight; fixing later is a behavior change for all clients.

- **[low] A3-11: Response-shape inconsistencies.** Creates return `{ id }` (`ledger.ts:403`) vs full DTO (`planning.ts:3902`) vs `{ id, updated: true }` vs `{ updated: true }`; `GET /accounts/:id/balances` has no `page` envelope (`ledger.ts:335-362`); duplicate fields in one payload (`transferMatch` AND `transfer`, `ledger.ts:788-789`; `syncRunId` AND `syncRunIds`, `integrations.ts:439-446`).

- **[low] A3-12: Web-legacy translation layer baked into the public contract.** The API exposes display-oriented aliases over DB enums: "rewards"→"custom", "reviewed"→"approved", "provider"→"simplefin" (`ledger.ts:34-55`), "ai"→"approved_ai" (`planning.ts:2048-2050`), "active"→"healthy" (`integrations.ts:97-102`). Harmless if frozen and documented as the v1 vocabulary; "cleaning it up" later would be the v2 trigger.

- **[low] A3-13: Misc contract warts.** `GET /auth/session` *sets* the `bw_household` cookie (side effect on a safe method, `auth.ts:55-58`); unknown `range` values silently mean "all" (`reports.ts:774-775`); `/health` reports hardcoded `database: "ready"` without checking the DB (`app.ts:272-279`); `REGISTRATION_MODE=invite` yields 403 with no invite endpoints existing (`auth/service.ts:64-66`); CORS trusts exactly one `WEB_ORIGIN` — a second browser client needs a config change + restart (`app.ts:226-234`, `middleware.ts:17-25`).

- **[low] A3-14: The one existing client already drifts from the API.** `apps/web/src/api.ts:1118-1120` calls `POST /connections` — no such route exists (only `/connections/simplefin/claim`). Direct evidence that without a generated contract, even the in-repo first-party client diverges.

### Verified strengths

- **Uniform versioning**: every resource route under `/api/v1`; only `/health` unversioned.
- **One canonical error envelope** for all route-thrown errors via `app.onError` + typed `AppError`/`Unauthorized`/`Forbidden`/`NotFound`/`Conflict` hierarchy (`errors.ts:1-35`); even unknown routes get the same envelope (`app.ts:337-339`).
- **Zod on every write**, parsed in handlers with consistent 422 + field paths; money inputs go through the shared int64-bounded `MinorUnitsStringSchema`.
- **Money serialization claim holds**: every module emits `{ minorUnits: string, currency }` — no float money anywhere in API responses.
- **Real opaque-cursor pagination** on the heaviest collection (`GET /transactions`).
- **Rate limiting** on credential + high-cost endpoints with `RateLimit-*` headers and a 429 JSON envelope.
- **Deliberate native-client affordances**: origin-less requests allowed, `csrfToken` in the login body, `sameSite=Lax` host-only cookies.
- **Uniform `Cache-Control: no-store`**, security headers, JSON 401s (no HTML redirects), `/capabilities` discovery endpoint.
- **Systematic tenant isolation**: `requireAuth` on every module; every query scoped by `householdId`; mutations write audit events with `requestId` propagation.

---

## Area 4 — Security, ops & docs

### Findings

- **[medium] A4-1: The demo seed creates a known-credential owner account with no production guard.**
  - Where: `apps/api/src/cli/seed.ts:6-18`, credentials at `apps/api/src/seed/canonical-alex.ts:50-51`
  - Evidence: `db:seed` runs `seedCanonicalAlex(db)` unconditionally; there is no `APP_ENV`/production refusal anywhere in `apps/api/src/seed/` (grep-verified). The email/password pair is published in `README.md:102` and committed in `e2e/helpers.ts:3-6`; the seeded user is a household owner.
  - Why it matters: README says the account "must never be used as a production account," but that is a documented prohibition, not a control. One mistaken `bun run db:seed` against a production `DATABASE_URL` plants a publicly-documented owner login. A `config.isProduction` refusal would close it.

- **[medium] A4-2: The on-demand AI suggestion route bypasses the disclosure-consent invariant the rest of the pipeline enforces.**
  - Where: `apps/api/src/routes/integrations.ts:611-664` (read and verified directly during this audit)
  - Evidence: `POST /ai/suggestions/transactions/:id` sends `normalizedDescription`, direction, amount band, currency, and account type to the acting user's AI provider for *any* transaction in the household. It never applies the fail-closed ownership check (`aiDisclosureScope`, `categorization/service.ts:95-104`) that the batch path enforces, nor the equivalent check in the regenerate route (`integrations.ts:792-800`). It also silently falls back to `config.BOOTSTRAP_OPENROUTER_API_KEY` with hardcoded `consent: true` (`integrations.ts:640-650`) when the user never configured AI.
  - Why it matters: in a multi-member household, member A can disclose member B's transaction descriptions to A's model provider without B's consent — contradicting the code's own documented consent model ("ownerless/shared and conflicting owner metadata fail closed", `service.ts:92-94`).

- **[low] A4-3: `REGISTRATION_MODE` defaults to `open`** (`config.ts:54`). A deployment that forgets the variable exposes open signup. Mitigations: `.env.example:14` sets `closed`, preflight warns (`deploy/preflight.sh:95`), register is rate-limited 5/min/IP.

- **[low] A4-4: `REGISTRATION_MODE=invite` is accepted but has no mechanism** — it behaves as `closed` (`auth/service.ts:64-66`); the `invitations` table (`schema.ts:201-235`) has no routes. `.env.example:12-14` and `SELF_HOSTING.md:96` imply "invite" lets another member register; an operator choosing it silently gets `closed`.

- **[low] A4-5: Self-hosting doc's `REGISTRATION_MODE=closed` conflicts with first-run bootstrap.** `SELF_HOSTING.md:66` sets `closed`, but bootstrap throws `"First-run bootstrap requires REGISTRATION_MODE=open"` (`bootstrap.ts:43-44`). The doc never mentions temporarily setting open; an operator following the runbook literally hits a hard failure.

- **[low] A4-6: No Content-Security-Policy on API responses** (`app.ts:216-223`; the web server sets a strong CSP at `apps/web/server.ts:23-30`). API responses are JSON-only with `nosniff`, so impact is minimal.

- **[low] A4-7: The example proxy downgrades the API's stricter Referrer-Policy.** `deploy/Caddyfile.example:39` sets `strict-origin-when-cross-origin`; the API sets `no-referrer` (`app.ts:220`); Caddy's `header` block overwrites the upstream header.

- **[low] A4-8: "Supports rotation" is overstated for sessions and field encryption.** `sessions.rotatedFromId` (`schema.ts:161`) has no referencing rotation code; `FieldCipher.decrypt` rejects any `keyId !== this.#keyId` and there is no re-encryption tooling (`crypto.ts:53-63`) — changing `ENCRYPTION_KEY` bricks existing ciphertexts. `PRODUCT_BLUEPRINT.md:476` says otherwise.

- **[low] A4-9: Implicit AI consent and bootstrap-key fallback in settings PATCH.** `PATCH /settings/integrations` hardcodes `consent: true` (`integrations.ts:552`) rather than taking it as input, and sources the key from `previous?.apiKey ?? config.BOOTSTRAP_OPENROUTER_API_KEY` (`:548`). Consent is recorded without being requested; scope is per-user so blast radius is limited.

- **[low] A4-10: CI coverage gaps.** e2e runs Chromium-only (`playwright.config.ts:33-42` — Safari-specific cookie/storage behavior untested); no secrets-scanning step (gitleaks/trufflehog); no dependency-update automation (dependabot/renovate absent from `.github/`). Frozen-lockfile installs and `bun audit` are in place; these are defense-in-depth gaps, not exposures.

### Docs drift

| Claim (file:line) | Reality (evidence) | Verdict |
| --- | --- | --- |
| README Commands section (`README.md:69-88`) | All documented commands exist; 8 root scripts undocumented (A1-10) | Mostly accurate |
| "accessibility checks as parallel jobs" (`README.md:95-100`) | Axe runs inside the single e2e job; CI has 8 parallel jobs + gate | Minor wording drift |
| `REGISTRATION_MODE=closed` in prod env (`SELF_HOSTING.md:66`) | First-run bootstrap requires `open` (`bootstrap.ts:43-44`) | Drift (A4-5) |
| "invite … when you want another household member to register" (`.env.example:12-14`, `SELF_HOSTING.md:96`) | `invite` blocks registration; no invite flow exists (`auth/service.ts:64-66`) | Drift (A4-4) |
| Bootstrap idempotent, claims token once (`README.md:39`) | Existing user/connection short-circuit; no reclaim (`bootstrap.ts:35-119`) | Accurate |
| Backups: online snapshot, mode 0600, retention prune (`SELF_HOSTING.md:162-164`) | `VACUUM INTO` + umask 077 + chmod 0600 + DELETE journal + quick/FK checks + atomic rename + prune; independent verify (`packages/db/src/backup.ts:36-106`, `cli/backup.ts:50-68`, `deploy/verify-backup.ts:36-86`) | Accurate |
| Reset-password runbook (`SELF_HOSTING.md:98-115`) | Hidden TTY or env vars (deleted after read), revokes sessions + PATs, audit rows (`deploy/reset-password.ts:33-181`) | Accurate |
| "Global search/command palette" (`PRODUCT_BLUEPRINT.md:100`) | Only per-page search found; no palette | Aspirational |
| "idempotency keys for import/sync/bulk operations" (`PRODUCT_BLUEPRINT.md:449`) | Sync honors it; imports dedupe by hash; bulk has neither | Partially aspirational (A3-4) |
| Field encryption "supports rotation" (`PRODUCT_BLUEPRINT.md:476`) | `keyId` reserved; decrypt rejects other keyIds; no tooling | Overstated (A4-8) |
| JSON exports omit secrets (`README.md:125`) | `isSecret=false` filter + non-credential projection; SQLite download owner-only (`operations.ts:271-343`) | Accurate |
| Release: gate re-run + archives + SHA-256 (`README.md:97-100`) | `release.yml:15-51` re-runs full CI, tars artifacts, `sha256sum`, `gh release upload` | Accurate |

### Verified strengths

- **Argon2id production params** (m=64 MiB, t=3) via `Bun.password`; identical-work dummy hash for unknown emails closes the enumeration timing channel (`auth/service.ts:38-44,79-83,154-158`); password policy 12–128 chars everywhere.
- **Sessions**: SHA-256 token storage, idle+absolute expiry with a DB check constraint, sliding idle renewal, revocation on logout, revoke-all-others on password change, per-user session list/revoke.
- **Cookies**: `httpOnly`, `SameSite=Lax`, `secure` when `COOKIE_SECURE || production`.
- **CSRF**: session-bound double-submit with `timingSafeEqual` against `session.csrfTokenHash` (`auth/middleware.ts:82-107`); grep-verified every mutation route in all five route files carries `requireCsrf`; viewer role hard-blocked from mutations.
- **Origin/TRUST_PROXY**: exact-origin match with loopback aliases only for loopback configs; XFF honored only under `TRUST_PROXY` and validated with `isIP`; integration tests cover hostile origins and forwarded-header spoofing.
- **Encryption**: AES-256-GCM, 12-byte random nonce per record, AAD context binding, strict 64-hex key validation; connections store ciphertext/nonce/tag/keyVersion/AAD as separate columns; record binding re-checked before decrypt; AI settings encrypted per user.
- **Egress SSRF controls**: HTTPS-only, explicit host allowlists, DNS resolution with public-IP enforcement (including IPv6 6to4/mapped forms), redirect/byte/time caps; SimpleFIN claim URL path-pinned and access URL re-validated (`lib/egress.ts:56-207`, `integrations/simplefin.ts:8-142`).
- **AI data minimization matches README**: only normalized description, direction, coarse amount band, currency, account type; category allowlist + ≤12 examples; provider output strictly schema-validated; minted rules re-validated before insert; liability-income invariant the model cannot override; provider circuit breaker; prompt instructs the model to treat descriptions as untrusted.
- **Tenant isolation**: `createHouseholdRepositories` cannot issue an unscoped query; composite `(householdId, id)` unique indexes + composite FKs across the schema; sampled handlers across all five route modules filter on `auth.householdId`; household cookie validated against membership.
- **Secrets hygiene**: `.env.*`, `data/`, `backups/`, `*.sqlite*` ignored; `git ls-files` + full history contain only `.env.example`; regex scan for key material found nothing committed; logger redacts keys/URLs/Bearer values; DB files 0600 / data dir 0700 at boot; e2e secrets are inert fixed test values.
- **Ops**: backup is `VACUUM INTO` under umask 077 with integrity checks, atomic rename, retention pruning; verify-backup independently re-checks; preflight enforces production posture; systemd units strongly hardened (`NoNewPrivileges`, `ProtectSystem=strict`, empty capability set, `UMask=0077`, bootstrap secrets `UnsetEnvironment` in long-running units, backup unit `PrivateNetwork=true`).
- **CI**: frozen-lockfile installs, 8-job release gate with explicit needs-check, JUnit upload on `if: always()`, browser diagnostics on failure, release re-runs the whole gate before attaching checksummed artifacts.
- **SQLite hardening**: FK on, busy timeout bounds-checked, WAL + `synchronous=NORMAL`, `trusted_schema=OFF`, `secure_delete=FAST`, FK enablement verified at open (`packages/db/src/client.ts:46-59`).

---

## Unverified items (carried, with reasons)

- **Exhaustive tenant-scope review of `planning.ts`** — 442 scoping sites; sampled handlers and middleware coverage are uniform, but an unsampled handler could deviate. Structural risk recorded as A1-4.
- **Web XSS surface** — outside read scope; mitigated by React escaping + web-server CSP.
- **`lib/refunds.ts` branch coverage** — imported by planning/reports; reimbursement-offset behavior asserted in planning tests, but not every branch traced.
- **Runtime behavior of systemd units/Caddy on a live host** — reviewed statically only.
- **`docs/screenshots/*.png` external references** — nothing in-repo links them; may be referenced from the GitHub project page.
- **Actual displayed-amount errors from web float conversion** — architectural exposure confirmed (A1-3); live misformatting would require runtime visual testing.
- **`e2e/capture-screenshots.ts` and `data/seed-smoke.sqlite` intent** — appear to be manual owner-run artifacts; not wired into anything.
- **Whether `context.env.remoteAddress` is populated by the Bun listener in production** — affects rate-limit keying only.
