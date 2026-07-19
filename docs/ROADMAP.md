# BetterWealth Roadmap

Date: 2026-07-17
Source: [`docs/AUDIT.md`](AUDIT.md) — findings are referenced below as `A<area>-<n>` (e.g. A3-1 = AUDIT.md, Area 3, finding 1).
Posture: the foundation is strong — all release gates pass, security engineering is genuinely deep, and the domain engines are well-tested. This roadmap is about consolidating what exists before the surface area grows, not rebuilding anything.

## Strategic context

Two commitments shape the ordering:

1. **Multiple first-party clients are planned against `/api/v1`.** Everything that makes v1 a contract worth freezing comes first. Once a second client ships, every wart in the current contract becomes permanent or becomes a breaking change.
2. **The codebase is about to grow.** The god files (`planning.ts`, `TransactionsPage.tsx`, `personalization/service.ts`) and the hand-synced contract are the two places where every future feature will pay interest. Fix the interest rate before adding principal.

## Phase 0 — Freeze-worthy contract (block any second client)

Goal: `/api/v1` becomes a contract a new client can code against without reading the server source. Items are ordered by dependency.

1. **Resolve the contract source of truth** (A3-1, A3-2, A1-1). Pick one:
   - *Recommended:* adopt `@hono/zod-openapi` (already a dependency, zero imports) so routes declare their schemas and `openapi.json` is generated from the same zod that validates requests. Then regenerate the client-facing types in `packages/shared/src/schemas.ts` from the live route definitions — or delete the dead DTO/envelope schemas and keep only what the engines use.
   - Either way, the three hand-synced contract copies (shared schemas, web `api.ts` interfaces, hand-typed OpenAPI) collapse into one generated pipeline. Success test: `apps/web/src/api.ts` imports its response types instead of "intentionally mirroring" them, and the stale `POST /connections` call (A3-14) is caught by the type system.
2. **Fix the error-contract bypasses** (A3-5). Teach `app.onError` to handle Hono `HTTPException` (→ its real status, e.g. 413) and JSON `SyntaxError` (→ 400 `invalid_json`). Align the 2 MB global body cap with the 10 MB import payload limit. Add integration tests asserting 400/413 envelopes — the audit verified both 500s live, so a regression test is cheap to write now.
3. **Decide the duplicate route families** (A3-6). Keep one of `/budgets` vs `/budget-periods` and one of `/scenarios` vs `/forecast-scenarios`; deprecate the other in docs and OpenAPI. Cheapest now, most expensive after a second client picks the wrong one.
4. **Make pagination honest** (A3-7). Either implement cursors on the five bounded list endpoints or return `hasMore: true` when truncating. One afternoon of work; prevents silent data loss in sync-style clients.
5. **Normalize validation semantics** (A3-8, A1-5). One convention for 400 vs 422, one `CurrencyCodeSchema`, one minor-unit schema, one money serializer — all from `packages/shared`. Remove the silently-ignored write fields (A3-9) or implement them.
6. **Document the native-client auth flow** (A3-3). Short-term: write down the cookie + CSRF-header flow in the OpenAPI security schemes so a mobile developer doesn't have to reverse-engineer it. (Token auth is Phase 2 — don't block v1 on it.)

Exit criteria: `openapi.json` is generated, complete (covers the ~10 currently-missing endpoints), and validated in CI against the live routes; error contract has regression tests; `apps/web` consumes generated types.

## Phase 1 — Pay down the structural debt that taxes every feature

1. **Split `planning.ts`** (A1-2) by resource into `routes/planning/{envelopes,budgets,goals,rules,scenarios,forecasts,imports,assets}.ts`, extracting application logic (e.g. `build-from-monthly-spend`) into a planning service module mirroring `categorization/service.ts`. Pure refactor — 108 route registrations move, no behavior changes; the existing integration suite is the safety net.
2. **Adopt the repository layer as the default query path** (A1-4). Migrate `ledger.ts` and the split planning routes to `createHouseholdRepositories` so unscoped queries become unrepresentable instead of merely discouraged. Follow with a one-time audit of the remaining hand-written `householdId` predicates.
3. **One money helper for the web** (A1-3). Replace the 70 `Number(...)/100` sites with a shared `formatMinorUnits` + `CURRENCY_METADATA`-driven formatter; remove hardcoded `$` and 2-digit assumptions. Aligns the UI with the exact-money discipline the README promises and non-USD users will need.
4. **Break up the web god components** (A1-6). Extract `TransactionsPage.tsx` concerns (drawer editing, bulk ops, splits, transfer/refund linking) into the `components/` layer; lazy-load Today/Transactions/Budget to attack the 796 kB main chunk. Do after 3 so the money formatting lands once.
5. **Consolidate fixtures** (A1-8, A2-5). Web demo mode should consume the canonical testkit fixture (or a shared projection of it) instead of `apps/web/src/data.ts`'s parallel float-based universe; migrate ad-hoc test row-building to testkit builders where schema churn hurts most.
6. **Hygiene sweep** (A1-7, A1-9, A1-10, A1-11): remove dead deps (`@hono/zod-openapi` if Phase 0 chose otherwise, `@betterwealth/db` from testkit, `@betterwealth/shared` from db), import money primitives from shared in `db/src/money.ts`, wire or delete `capture-screenshots.ts` + `docs/screenshots/`, document the 8 undocumented root scripts, dedupe the session-guard components, and either enforce or consciously relax the 268 `noNonNullAssertion` lint warnings.

Exit criteria: no route file over ~1,000 lines; repository layer is the only query path in routes; zero `Number()/100` in `apps/web/src`; biome warnings trending to zero or the rule explicitly downgraded.

## Phase 2 — Multi-client enablement

1. **Personal access tokens** (A3-3). The schema already has `personal_access_tokens` with token-hash storage and revocation indexes, and audit events already accept `actorType: "token"` — the table is simply unwired. Add token create/list/revoke routes, accept `Authorization: Bearer` in `requireAuth` (CSRF not required for bearer clients), and scope tokens per-user. This is the mobile-client unlock.
2. **Idempotency on mutations** (A3-4). Generalize the sync-runs `Idempotency-Key` mechanism into middleware applied to all POST creates; persist keys per household with response replay.
3. **Household timezone** (A3-10). Apply `households.timezone` to dashboard "today" and month bucketing. Do this before external clients exist — it changes report semantics.
4. **Contract polish** (A3-11, A3-12, A3-13): one create-response convention, drop duplicate payload fields, document the enum-alias vocabulary as the frozen v1 language, make `/health` actually probe the database, multi-origin CORS support if a second browser client appears.
5. **Client SDK seed**: once `openapi.json` is generated (Phase 0), publish a thin generated TypeScript client package in `packages/` that both web and future clients consume — the forcing function that keeps the spec honest.

Exit criteria: a non-browser client can authenticate with a token, paginate truthfully, retry mutations safely, and codegen its types from the committed spec.

## Phase 3 — Security-critical test coverage

The test suite is strong on engines and hostile-path integration; the gaps are concentrated in auth-adjacent routes. Ordered by risk:

1. Password change: wrong-current-password rejection, cross-session revocation (A2-1).
2. Session lifecycle: idle expiry 401, absolute cap on sliding renewal, logout revocation (A2-2).
3. Rate limiter internals: overflow bucket, window reset, per-key isolation, `RateLimit-*` headers (A2-3).
4. Import parsers: the ~8 fail-closed error branches + parenthesized negatives + BOM (A2-4).
5. Clock coupling: inject a clock into goals/planning tests (A2-6) and a fake timer into worker tests (A2-7).
6. Small stuff: delete or fix the tautological web test (A2-8), CLI arg-parsing smoke tests (A2-9), tampered-ciphertext crypto case + AuthPages unit test (A2-10).

Exit criteria: every auth/session mutation has at least one hostile-path server-side test; parser error contract fully pinned.

## Phase 4 — Security & ops hardening

1. **Production guard on the demo seed** (A4-1): `db:seed` refuses when `APP_ENV=production` unless an explicit `--i-know-this-is-demo-data` flag is passed.
2. **Close the AI consent bypass** (A4-2, A4-9): apply `aiDisclosureScope` to the on-demand suggestion route, take consent as explicit input in settings PATCH, and make the bootstrap-key fallback opt-in rather than silent.
3. **Resolve `REGISTRATION_MODE=invite`** (A4-4): either wire the dormant `invitations` table into token-based invite routes or remove the enum value. Fix the `SELF_HOSTING.md` first-run bootstrap ordering conflict (A4-5) either way.
4. **Header parity** (A4-6, A4-7): CSP on API responses; align `Caddyfile.example` Referrer-Policy with the API's `no-referrer`.
5. **Honest rotation docs or real rotation** (A4-8): either implement session rotation on login + key-version re-encryption tooling, or correct `PRODUCT_BLUEPRINT.md:476` to say rotate-by-rebuild.
6. **CI additions** (A4-10): secrets scanning (gitleaks), dependabot/renovate for the lockfile, and consider a WebKit e2e project once a second browser client matters.
7. **Docs alignment**: refresh the blueprint's aspirational sections (global search, bulk idempotency) to match shipped reality, and add the 8 undocumented ops commands to the README (with A1-10).

Exit criteria: known-credential demo account cannot reach production by accident; AI disclosure consent is uniform on every path; docs match code on every row of the audit's drift table.

## Explicitly not on the roadmap

- **No framework/ORM/language changes.** The stack is coherent and the gates are green.
- **No speculative multi-tenancy work.** Household isolation is sound; Phase 1.2 makes it structural rather than conventional, which is sufficient.
- **No coverage-percentage target.** The gaps found are specific and listed in Phase 3; a global number would incentivize the wrong tests.
- **No `/api/v2` planning.** Every contract wart found is fixable inside v1 while there is exactly one client; v2 becomes necessary only if the Phase 0/2 decisions are deferred past the second client's launch.

## Suggested sequencing at a glance

| Phase | Theme | Blocks | Effort shape |
| --- | --- | --- | --- |
| 0 | Contract source of truth + error contract | Second client | Days; mostly wiring + decisions |
| 1 | God files, repositories, money formatting | Feature velocity | Weeks; pure refactors behind existing tests |
| 2 | PATs, idempotency, timezone, SDK | Mobile client | Weeks; new surface on a frozen contract |
| 3 | Auth/session/parser test gaps | Confidence in 1–2 | Days; additive tests |
| 4 | Seed guard, consent, invites, CI/docs | Production trust | Days; small targeted changes |

Phases 0 and 3 are independent and can run in parallel; Phase 1 should land before Phase 2 builds on the contract; Phase 4 is unblocked anytime and A4-1/A4-2 are worth doing first because they are small and security-relevant.
