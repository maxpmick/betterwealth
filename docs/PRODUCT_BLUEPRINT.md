# BetterWealth product and implementation blueprint

Status: implementation contract  
Product: clean-room personal finance and wealth-planning application  
Primary deployment: bare-metal, self-hosted, single household initially, multi-user capable  
Reference inspiration: Sure's calm wealth overview, account ledger, privacy mode, splits, rules, budgets, and self-hosting posture; no source code reused

## 1. Product promise

BetterWealth answers four questions in order:

1. What is safe to spend before the next paycheck?
2. Where did the last paycheck actually go?
3. Which one action this week most improves the plan?
4. At the current pace, what will net worth be at age 30 and when can each goal be bought comfortably?

The app is not just a transaction archive. It turns imported facts into an explainable plan: income funds envelopes, transactions consume them, surplus is assigned to buffers/goals/debt/investments, and deterministic forecasts show the effect.

“On track” is measured against an editable, inflation-adjusted target made of explicit components: emergency-cash floor, maximum acceptable high-interest debt, retirement/investment target, and optional total/liquid net-worth target. The app never invents a universal definition of “rich.”

### North-star metric

`Projected liquid net worth at target age`, supported by:

- savings rate;
- monthly investable surplus;
- emergency-fund runway;
- safe-to-spend through the next income date;
- goal dates and forecast drift;
- total net worth including property and vehicles, shown separately from liquid wealth.

## 2. Reference persona and canonical journey

The autonomous reference fixture is `Alex`, age 22, targeting financial strength by age 30.

- Net monthly pay: $4,400 across two paychecks.
- Checking: $3,000; savings: $4,500; taxable investments: $6,500; retirement: $8,000.
- Credit card: $1,200 current balance; student loan: $12,000 at 5.4%.
- Essential monthly obligations: rent, utilities, groceries, transportation, insurance, minimum debt payments.
- Flexible spending: dining, entertainment, shopping, travel.
- Goals: $12,000 emergency fund, $3,000 travel purchase, student-loan payoff, and automated investing.
- Target: grow liquid net worth aggressively without overdrafting or pretending illiquid home/vehicle value is spendable.

The canonical end-to-end journey must prove that Alex can:

1. register and create a household;
2. connect SimpleFIN or load a deterministic fixture;
3. reconcile pending and posted transactions without duplicates;
4. review AI category suggestions and approve narrow reusable rules;
5. correct one category and safely recategorize matching history;
6. detect paychecks, bills, subscriptions, transfers, refunds, and recurring spending;
7. fund envelopes from each paycheck and see safe-to-spend change immediately;
8. add an emergency fund and desired purchase and receive a comfortable date;
9. compare conservative, baseline, and ambitious paths to age 30;
10. identify overspending and apply the recommended surplus allocation;
11. export, back up, restore, and retain identical balances and forecasts.

## 3. Product principles

1. **One answer first.** Each page leads with the decision it helps make, then reveals detail.
2. **Explain every number.** Safe-to-spend, budget activity, forecasts, and categorizations expose their inputs.
3. **Automation earns trust.** Imported data is preserved, deterministic rules are previewable, and AI only proposes bounded changes.
4. **No shame.** Copy is direct and supportive: “Dining is $84 above plan; reducing the next two weeks by $42 restores the goal date.”
5. **Liquidity is explicit.** Total net worth, liquid net worth, retirement assets, and manually valued assets are never conflated.
6. **AI is optional.** Ledger, rules, budgets, and forecasts work when no model is configured or the provider fails.
7. **Local-first operations.** No analytics, no secret leakage, complete export, documented backup and restore.
8. **Mobile-ready boundary.** The browser consumes the same versioned API a future native application will use.

## 4. Information architecture

Desktop uses a compact left rail. Mobile uses a five-destination bottom bar with `More` for the remainder.

### Primary navigation

1. **Today** — safe-to-spend, payday runway, weekly action, recent activity.
2. **Transactions** — unified ledger, review inbox, splits, transfers, import provenance.
3. **Budget** — paycheck funding, envelopes, bills, monthly and pay-cycle views.
4. **Net worth** — history, account groups, assets/liabilities, currency effects.
5. **Goals** — emergency fund, purchases, debt payoff, investment milestones.
6. **Forecast** — age-30 path, scenarios, assumptions, Monte Carlo ranges.
7. **Accounts** — institutions, balances, holdings, manual assets and valuations.
8. **Automation** — categorization rules, merchants, recurring series, AI review.
9. **Settings** — household, security, currencies, integrations, data operations, appearance.

### First-run journey

The app never drops a new user onto an empty dashboard.

1. Choose `Connect SimpleFIN`, `Explore with demo data`, or `Start manually`.
2. Set current age/birth date and the age-30 target components.
3. Enter payday cadence, known essential bills, minimum cash floor, debt APR/minimums, employer match, and current contribution rates.
4. Connect/import or enter opening balances.
5. Review a readiness checklist and a clearly provisional safe-to-spend calculation.
6. Land on Today with the single next setup/action step highlighted.

### Global shell

- Wordmark and environment/sync-health indicator.
- Household selector when more than one membership exists.
- Global search/command palette for transactions, merchants, accounts, goals, and actions.
- Privacy toggle that masks every monetary value, chart tooltip, accessible label, and export preview.
- Theme toggle supporting light, dark, and system.
- Sync button with last successful time, progress, and sanitized error detail.
- Responsive quick-add button for transaction, asset, goal, envelope, or rule.

### Responsive contract

- Mobile bottom bar contains exactly `Today`, `Transactions`, `Budget`, `Goals`, and `More`; Net worth, Forecast, Accounts, Automation, and Settings live in More and remain command-searchable.
- At 320 px, every primary page reflows to one column without horizontal page scroll; metric cards stack, tables become labeled rows, and charts gain compact text summaries.
- Ledger filters use a bottom sheet on mobile; primary save/review actions stay sticky and thumb reachable.
- Minimum interactive target is 44×44 px. All hover disclosures also work with focus/tap.
- Pages reflow at 200–400% zoom, preserve logical heading/focus order, and expose visible focus rings.
- Every chart has a screen-reader summary and a tabular alternative. Status uses text/icon as well as color.
- Privacy masking hides visual numbers while accessible labels say “Amount hidden,” never the secret amount.

## 5. Screen specifications

### 5.1 Today

The first viewport contains:

- greeting plus concise status (“You are on track this pay cycle”);
- primary `Safe to spend` metric, amount per day, and covered-through date;
- expandable formula: available cash − reserved bills − envelope commitments − goal contributions − minimum buffer;
- weekly action card with a single quantified recommendation and previewable impact;
- three compact signals: pay-cycle runway, plan readiness, and age-30 trajectory;
- a trust state (`Ready`, `Incomplete`, or `Stale`) with as-of time, pending impact, missing inputs, confidence range, and corrective action;
- pay-cycle runway with last/next paycheck and days remaining;
- age-30 trajectory card with projected liquid net worth, savings rate, and variance from target;
- net-worth area chart and asset/debt composition;
- envelope progress grid emphasizing at-risk and over-plan categories;
- recent transaction review queue;
- upcoming bills/subscriptions and forecasted checking low point.

Dashboard cards can be reordered on desktop and by long-press on mobile. Critical metrics remain first. Long-press is a shortcut only; an explicit `Customize dashboard` action is always available.

### 5.2 Transactions

- Dense but calm virtualized ledger with date groups.
- Search by raw description, normalized merchant, note, tag, amount, and account.
- Filters: date, account, category, envelope, merchant, amount, status, source, pending, needs review, transfer, excluded, recurring.
- Columns adapt by width; amount and review status remain visible.
- Detail opens in a right drawer on desktop and full-height sheet on mobile.
- Drawer supports merchant rename, category, envelope, notes, tags, exclusion, transfer match, refund link, recurring series, attachments, split editor, rule creation, and audit/provenance.
- Bulk operations preview affected count and aggregate amount before applying.
- Pending-to-posted merges remain reversible and auditable.
- Review inbox separates uncertain AI suggestions, new merchants, unmatched transfers, and possible duplicates.

### 5.3 Budget

Budgeting is paycheck-aware envelope budgeting with a monthly summary.

- Header answers: funded, spent, remaining, unassigned income, and days left.
- Toggle between `This paycheck`, `Month`, and `Plan`.
- Funding plan allocates expected income in this order: required bills, minimum debt, core living, buffer, goals, investing, flexible envelopes.
- Each envelope displays planned, funded, activity, available, pacing, rollover, linked categories, and linked rules.
- Users can enter approximate monthly spend, choose cadence, and let the app convert it into per-paycheck funding.
- Bill envelopes include due date, autopay account, recurrence confidence, and amount range.
- Parent envelopes aggregate children; rollover policies are configurable.
- Overspending may be covered from unassigned money or another envelope with an explicit transfer.
- Budget math never edits transaction truth; it allocates and reports it.

### 5.4 Net worth

- Calm area chart with ranges `1M`, `3M`, `1Y`, `All` and milestone annotations.
- Toggle total, liquid, investable, retirement, assets, and debts.
- Composition table by account group with change over selected period.
- Historical values come from account/holding/asset valuation snapshots rather than reconstructing current values backward.
- Multi-currency values show native amount and reporting-currency conversion with rate/date/source.
- Property and vehicle cards show latest valuation, provider/manual source, staleness, confidence, related liability, and history.

### 5.5 Goals

Goal types: emergency fund, purchase, debt payoff, investment milestone, and custom.

- Each goal has target amount, optional target date, priority, funding source, contribution policy, liquidity constraint, and pause state.
- `Comfortable purchase date` requires the target price plus configurable buffer while preserving required envelopes, emergency floor, and projected account minimums.
- Goal cards show funded amount, monthly pace, earliest safe date, target-date probability, and impact on age-30 wealth.
- A priority waterfall allocates surplus deterministically and is fully editable.
- The default wealth-priority ladder is: cash floor → employer match → high-interest debt → emergency fund → tax-advantaged investing → lower-rate debt → taxable investing → discretionary goals. It is educational, editable, and drives weekly-action selection.
- What-if action previews compare buy now, buy at safe date, reduce price, or alter monthly contribution.

### 5.6 Forecast

- Baseline, conservative, and ambitious presets plus user-created scenarios.
- Adjustable assumptions: income growth, inflation, cash yield, investment return/volatility, debt rates, asset appreciation/depreciation, contributions, retirement match, large purchases, and horizon.
- Deterministic monthly projection is always shown.
- Seeded Monte Carlo adds percentile bands (P10/P25/P50/P75/P90) and reproducible results.
- Results: liquid and total net worth at 30, goal dates/probabilities, lowest cash balance, debt-free date, cumulative income/spend/investment growth.
- A data-readiness gate checks reconciled balances, income variability, bills, card statement obligations, debt APR/minimums, employer match, contribution rates, and staleness. Missing inputs widen ranges and reduce confidence rather than producing false precision.
- Scenario diffs translate assumptions into action (“Investing $150 more monthly adds an estimated $18,400 median wealth by 30”).
- Forecasts are educational planning estimates, clearly labeled—not promises or individualized investment advice.

### 5.7 Accounts

- Groups: cash, credit, loans, investments, property, vehicles, crypto, rewards/custom.
- Institution connections show status separately from accounts.
- Account page combines balance history, cash flow, holdings, transactions, reconciliation status, and editable classification.
- Manual accounts support transactions and dated balance adjustments.
- Investment holdings imported from provider-specific extra data when available; unsupported details remain raw metadata and can be entered manually.
- Manual assets support value history now and connector adapters later. Zillow/vehicle vendors are optional, user-configured providers; the base product never scrapes consumer websites.

### 5.8 Automation

- Rules list shows plain-language summary, priority, scope, actions, match count, last match, source, and enabled state.
- Rule builder supports AND conditions with bounded OR groups.
- Every edit includes a sample preview and historical match count.
- Conflicts show both rules and the winning precedence decision.
- AI suggestions live in a queue; rejected suggestions train only local merchant preferences, not a remote system.
- Merchant aliases and recurring series are separately manageable.

### 5.9 Settings

- Profile and age-30 target.
- Household members, roles, invitations, and account ownership/sharing.
- Base/reporting currency and enabled currencies.
- SimpleFIN, import, OpenRouter-compatible AI, valuation, and exchange-rate providers.
- AI consent and exact fields-to-be-sent disclosure.
- Security: sessions, password change, future passkeys/OAuth placeholder, personal access tokens.
- Appearance, number/date formats, reduced motion, privacy defaults.
- Export, backup, restore, delete, audit log, and health diagnostics.

## 6. Visual direction

MUI provides accessibility and interaction primitives; styling is modernized toward the restraint of shadcn/ui.

### Theme tokens

- Font: `Inter Variable`, with system fallback; tabular numerals for all money.
- Radius: 10 px controls, 14 px cards, 18 px large panels.
- Spacing: 4 px base; common card padding 20–24 px.
- Light background: warm gray `#F7F7F5`; surface `#FFFFFF`; text `#151A22`.
- Dark background: `#0B1017`; surface `#111923`; text `#F3F6F8`.
- Primary: deep ink `#1F3A5F`; accent/positive: emerald `#1F9D72`.
- Warning: amber `#D98B2B`; risk: coral `#DD625B`; info: blue `#4A7FD1`.
- Borders are subtle and neutral; elevation comes primarily from tone and a soft shadow.
- One restrained indigo-to-emerald gradient is reserved for the safe-to-spend/wealth trajectory hero.

### Component language

- Cards are information groups, not decoration.
- Metric headers pair one large figure with a trend and an explanation affordance.
- Status never relies on color alone.
- Drawers handle edit/detail work; dialogs are reserved for irreversible decisions.
- Skeletons preserve final layout; empty states explain value and offer one next action.
- Motion is 140–220 ms, transform/opacity only, and disabled under reduced-motion preference.

## 7. Domain and data model

All IDs are opaque ULIDs. All timestamps are UTC ISO strings or integer epochs at persistence boundaries. Money uses checked `BigInt` signed 64-bit integer minor units plus currency; arbitrary provider decimal strings are parsed without floating-point arithmetic. JSON transports minor units as base-10 strings, never JavaScript numbers. Currency conversion uses explicit decimal rational math and banker's rounding at reporting boundaries; overflow and unsupported precision fail closed.

### Identity and tenancy

- `users`: email, normalized email, password hash, profile, target birth/date settings, status.
- `households`: name, base currency, locale, timezone, registration policy.
- `household_members`: role (`owner`, `admin`, `member`, `viewer`), status.
- `sessions`: hashed opaque token, expiry, rotation lineage, IP/user-agent metadata.
- `personal_access_tokens`: hashed token, scopes, last used; API-ready but UI may be feature gated.
- `invitations`: household, email, role, token hash, expiry.

Every financial row is household-scoped. Authorization verifies membership and role in the API, never in the client alone.

### Connections and imports

- `connections`: provider, owner user, encrypted credentials, status, capabilities, sync cursor/timestamps.
- `provider_institutions`: provider-scoped institution/connection identity and display metadata.
- `sync_runs`: trigger, state, counts, checkpoint, sanitized errors, timing.
- `import_runs`: format, file hash, mapping, status, counts, errors.
- `raw_import_records`: minimal provider payload needed for provenance, encrypted/redacted where sensitive.

### Ledger

- `accounts`: provider/external identity, name, mask, group/type/subtype, currency, ownership, inclusion flags.
- `balance_snapshots`: ledger/current/available balance, timestamp, source.
- `transactions`: external identity, amount, dates, raw/normalized description, merchant, category, status, source, review state, exclusions, transfer/refund/recurrence links.
- `transaction_splits`: amount, category, envelope, memo; sum must equal parent amount.
- `merchants` and `merchant_aliases`.
- `categories`: parent hierarchy, kind, color/icon, active/system flags.
- `tags` and `transaction_tags`.
- `attachments`: local object path, content hash, media type, encrypted flag.
- `transfers`: both transaction sides, confidence, status.
- `refund_links`: refund and purchase transaction IDs.
- `recurring_series`: cadence, amount range, next expected date, confidence, status.

### Automation

- `rules`: name, priority, enabled, origin, condition/action JSON, match stats, timestamps.
- `rule_runs`: transaction, winning rule, competing rules, before/after snapshot, reversible batch ID.
- `ai_suggestions`: minimized input fingerprint, validated output, confidence, status; no prompt transcript required.

### Budgets and cash flow

- `income_sources`: merchant/rules, cadence, typical amount, next expected date.
- `pay_cycles`: start/end, income source, actual/expected income, status.
- `envelopes`: category/group, cadence, rollover policy, priority, minimum/target.
- `envelope_category_links` and `envelope_rule_links`.
- `budget_periods`: month/pay-cycle boundaries and status.
- `envelope_allocations`: planned, funded, transferred in/out, available snapshots.
- `allocation_entries`: immutable double-entry reservation/funding movements between unassigned cash, envelopes, goals, debt, investing, and released funds. This is the conserved source of truth that prevents a dollar being reserved twice.
- `bills`: recurring series, due rule, amount range, autopay account, envelope.

### Wealth and planning

- `goals`: type, target, target date, priority, buffer policy, linked accounts/debt, contribution policy.
- `goal_contributions`: transaction or allocation provenance.
- `assets`: property/vehicle/custom metadata, linked liability, liquidity class.
- `asset_valuations`: amount, date, source, confidence, provider reference.
- `holdings` and `holding_snapshots`: security identity, quantity as decimal string, price/value/cost basis minor units.
- `exchange_rates`: pair, rate as decimal string, effective date, source.
- `forecast_scenarios`: assumptions, seed, horizon, active/base flags.
- `forecast_runs`: input version hash, outputs, percentile series, engine version.
- `audit_events`: actor, action, entity, safe metadata, time.
- `jobs`: type, payload, state, attempts, lease, schedule, error.

## 8. Categorization and rules

### Evaluation order

1. Explicit user override on the transaction.
2. Enabled deterministic rules ordered by priority.
3. Highest specificity score: exact merchant/account > anchored regex > contains > amount/date-only.
4. Most recently updated rule as a stable tie-breaker.
5. Provider category mapping.
6. Local merchant/category history.
7. AI suggestion when enabled and no reliable match exists.
8. `Uncategorized` review queue.

The result records origin, winning rule, and explanation.

### Condition DSL

- raw/normalized description: exact, contains, starts/ends, safe regex;
- merchant or merchant alias;
- account, account group/type, institution;
- amount exact/range/absolute range and inflow/outflow direction;
- currency;
- date/day-of-week/day-of-month;
- pending/posted;
- recurring series;
- import source;
- category/tag presence.

Regex is length-limited, compiled safely, timed/bounded where possible, and rejected when invalid.

### Actions

- set category and envelope;
- normalize merchant;
- add/remove tags;
- mark/exclude transfer, income, reimbursement, or reporting exclusion;
- attach recurring series;
- set note prefix;
- create transaction split using fixed or percentage allocation;
- request review.

Rules are pure and deterministic. Applying to history is a previewed, transactional, reversible batch.

### AI workflow

The server sends only necessary fields: normalized description, direction, coarse amount/range, account type, allowed category tree, and limited examples. It never sends account credentials, access URLs, full account numbers, user email, unrelated transactions, or notes by default.

The model returns a strict validated object:

- normalized merchant;
- category ID from the supplied allowlist;
- confidence 0–1;
- short rationale;
- optional condition/action proposal using only the supported DSL.

The app revalidates every ID/operator/value, executes the proposed rule locally against samples, rejects broad/unsafe conditions, and never lets model output execute code or SQL. Every first pass is double-checked by an independent recheck (web-grounded when the model supports OpenRouter's server-side web search, otherwise a second model pass); the recheck may confirm, correct, or propose a missing category path. High-confidence verified categorization applies automatically at the user threshold (default 0.90) and mints a narrow deterministic rule (stable merchant prefix, direction-pinned) so repeat merchants never need the model again; anything lower stays pending with a concrete recommendation for one human decision. Provider errors degrade to local/manual behavior.

Default bootstrap provider is OpenRouter with `minimax/minimax-m3`. Model/base URL/key are encrypted per user and editable without migration. The starting taxonomy is a hardcoded two-level tree (`apps/api/src/categorization/taxonomy.ts`) shared by registration and rebuilds.

## 9. SimpleFIN and import behavior

- A setup token is accepted once, Base64-decoded, restricted to HTTPS, and POSTed to claim an access URL.
- The access URL is encrypted immediately and never returned to the browser or logged.
- Version 2 is requested with graceful version-1 parsing.
- Initial sync requests maximum available history with pending transactions.
- Incremental sync overlaps the previous checkpoint to capture revisions and pending-to-posted transitions.
- External transaction identity is unique per connection/account/external ID.
- Pending reconciliation uses provider linkage when available; otherwise a conservative fingerprint window with ambiguity routed to review. It never deletes a distinct same-amount transaction silently.
- Missing upstream transactions are retained and marked stale/removed upstream after safe observation rules.
- Each sync is idempotent and records counts, balance snapshots, sanitized provider errors, and last-seen timestamps.
- Manual and scheduled sync use the same leased job. Default schedule is every six hours with retry/backoff and jitter.
- CSV/QFX/OFX import uses a preview/mapping/reconciliation flow and file hashes for deduplication.

## 10. Forecast and guidance engine

### Deterministic engine

Monthly periods apply:

1. recurring/paycheck income;
2. fixed bills and envelope plan;
3. debt interest/minimum/extra payments;
4. goal and investment contributions by priority;
5. account interest and investment growth;
6. asset appreciation/depreciation;
7. exchange-rate conversion for reporting only.

It tracks account-level cash so projections cannot spend illiquid or retirement balances. Scenarios store all assumptions and engine version.

### Comfortable purchase date

The earliest month where:

- the purchase is fully funded;
- emergency reserve remains above its floor;
- all required bills/minimum debt remain funded;
- projected checking never falls below its buffer over the configured look-ahead;
- higher-priority goals remain on policy;
- optionally, the age-30 target remains within the user's tolerance.

The UI shows which constraint controls the date.

### Monte Carlo

- Seeded reproducible pseudo-random generator.
- Correlated/independent asset class assumptions kept explicit.
- Default 1,000 runs with configurable cap.
- Percentile bands and goal success probability; never a single misleading outcome.
- Property/vehicle variation is separate from liquid/investable paths.

## 11. API boundary

Base path: `/api/v1`. OpenAPI document: `/api/v1/openapi.json`; interactive docs may be disabled in production.

Resource groups:

- `/auth`: register, login, logout, session, password, CSRF.
- `/households`, `/members`, `/invitations`.
- `/connections`, `/connections/simplefin/claim`, `/sync-runs`.
- `/imports` with upload, preview, commit, status.
- `/accounts`, `/balances`, `/holdings`, `/assets`, `/valuations`.
- `/transactions`, `/transactions/bulk`, `/splits`, `/transfers`, `/recurring`.
- `/categories`, `/merchants`, `/tags`.
- `/rules`, `/rules/preview`, `/rules/apply`, `/ai/suggestions`.
- `/income-sources`, `/pay-cycles`, `/bills`.
- `/budgets`, `/envelopes`, `/allocations`.
- `/goals`, `/goals/:id/projection`.
- `/forecasts`, `/scenarios`, `/insights`.
- `/reports/dashboard`, `/reports/net-worth`, `/reports/cash-flow`, `/reports/spending`.
- `/currencies`, `/exchange-rates`.
- `/settings/integrations`, `/exports`, `/backups`, `/audit`, `/health`.

Every request and response is validated. Mutations use CSRF protection for cookies and idempotency keys for import/sync/bulk operations. Future bearer tokens are scoped and do not rely on browser CSRF semantics.

## 12. Runtime architecture

Monorepo:

```text
apps/web       React + Vite + MUI, separately served
apps/api       Bun + Hono HTTP API and job worker entry point
packages/db    Drizzle schema, migrations, repositories
packages/shared Zod contracts, money/rule/forecast engines
packages/testkit deterministic fixtures and provider fakes
```

- SQLite runs in WAL mode with foreign keys, busy timeout, and one host/writer topology.
- One API process owns all SQLite writes and a bounded in-process worker. Read-only/report processes may be added later. Jobs use fenced lease epochs, heartbeats, and compare-and-swap completion so an expired worker can never commit stale work.
- Web and API have independent ports/builds; a reverse proxy should expose one HTTPS origin in production.
- Migrations run under a deployment lock before the service starts.
- Graceful shutdown stops new work, releases/ages job leases, checkpoints WAL, and closes the database.
- `systemd` examples run as a restricted non-root user with a dedicated data directory.

## 13. Security contract

- Passwords use Bun's Argon2id implementation with explicit production parameters.
- Sessions use high-entropy opaque tokens; only a hash is stored. Cookies are HttpOnly, Secure in production, SameSite=Lax, host scoped, short idle plus bounded absolute expiry, rotated after authentication and sensitive changes.
- CSRF uses origin checks plus a session-bound double-submit token on mutations.
- Login, registration, claims, imports, AI, and exports are rate-limited.
- Field encryption uses AES-256-GCM with per-record nonce, authentication tag, key version, and contextual AAD. The master key is supplied only by the host environment and supports rotation.
- Secrets and financial payloads are redacted from logs and errors.
- Setup/Access URLs are restricted to HTTPS; outbound requests enforce timeouts, response-size limits, redirect restrictions, and SSRF protections.
- All SimpleFIN and AI traffic passes through one egress broker that resolves and pins public IPv4/IPv6 addresses, blocks private/link-local/metadata ranges, revalidates every redirect, prevents DNS rebinding, and enforces host/model allowlists where applicable.
- Security headers, exact CORS allowlist, body limits, MIME checks, safe filenames, and content hashes apply globally.
- Account deletion and export require password confirmation/step-up authentication.
- No third-party telemetry or analytics.
- Authorization is deny-by-default through a tested capability matrix covering household role, connection ownership, shared-account access, exports, AI configuration, backups, and administration. Public registration remains configurable and defaults to open per product requirements, with strong rate limits and an owner-selectable invite-only mode.

## 14. Autonomous test strategy

### Unit and property tests

- Decimal-to-minor-unit parsing across ISO and zero/three-decimal currencies.
- Signed inflow/outflow semantics for assets and liabilities.
- Rule precedence, specificity, conflicts, regex limits, actions, splits, and reversibility.
- Envelope funding, rollover, transfers, overages, pay-cycle boundaries, and safe-to-spend invariants.
- Debt amortization, goal dates, deterministic forecasts, seeded Monte Carlo, and currency conversion.
- Property-based invariants: split sums equal parent; transfers net to zero; budget funds are conserved; identical inputs/seeds yield identical forecasts.

### Database and migration tests

- Real temporary SQLite, foreign keys, constraints, indexes, transaction rollbacks, WAL behavior.
- Empty-to-latest migration and migration from every retained snapshot.
- Backup while WAL is active, integrity check, restore, and equality of financial aggregates.
- Field-encryption round trip, wrong AAD/key rejection, and key rotation.
- Concurrent/expired worker leases, deploy during sync, abrupt termination, disk-full handling, WAL corruption detection, and restart recovery.

### Provider contract tests

- SimpleFIN v1/v2 fixtures, max-history request, pending merge, duplicate IDs across accounts, missing transactions, malformed decimals, custom currencies, sanitized errors, 402/403/429/5xx/timeouts, retries, and idempotency.
- OpenRouter valid strict JSON, invalid JSON, unknown IDs, overbroad rule, injection-shaped descriptions, timeout/rate limit, unsupported structured output, and provider fallback.
- CSV/QFX/OFX encodings, locale amounts/dates, duplicates, malformed rows, and preview/commit parity.

### API tests

- Authentication/session rotation/expiry/logout, CSRF, origin, rate limit, validation, authorization, household isolation, role matrix, idempotency, pagination, and safe error shapes.
- Every documented route has success and principal failure coverage.
- OpenAPI contract is generated and checked for drift.

### UI tests

- Component behavior, keyboard operation, focus management, masks, number/date formats, responsive breakpoints, empty/loading/error states, and automated accessibility checks.
- Browser E2E runs against real API and SQLite with deterministic providers.
- Visual regression baselines for every primary page in light/dark desktop and mobile.
- Accessibility gates cover 320 px width, 200%/400% zoom, 44 px targets, keyboard-only workflows, focus order, reduced motion, screen-reader chart tables, and privacy labels.

### Canonical journey tests

The Alex fixture covers eight years of forecast behavior plus an initial realistic transaction set. Assertions include:

- exact reconciled balances and no duplicate posted transactions;
- correct paycheck attribution and transfer exclusion;
- rule proposal/approval/correction/history behavior;
- exact envelope availability and safe-to-spend math;
- forecasted emergency fund, purchase, debt-free, and age-30 dates;
- meaningful weekly action selection;
- identical results after export/backup/restore;
- full keyboard/mobile journey and privacy masking.

### Release confidence gates

1. Typecheck, lint, unit, property, database, contract, API, component, E2E, accessibility, and visual regression suites pass.
2. Production builds succeed from a clean checkout.
3. Migration on a copy and backup/restore drill pass.
4. No high/critical dependency audit finding without documented mitigation.
5. Live smoke test imports accounts without exposing secrets and aggregate balances reconcile.
6. Manual browser pass confirms layout at desktop/tablet/mobile in both themes.
7. Portable recovery captures a consistent SQLite/WAL snapshot, attachments, migration manifest, and versioned keyring wrapped by a separate recovery key; restore onto a clean host after rotation reproduces all aggregates. Default local retention is 7 daily, 5 weekly, and 12 monthly backups, with documented RPO of 24 hours and operator-tested RTO.

## 15. Vertical implementation slices

### Slice 0 — foundation

Monorepo, configuration validation, shared money/contracts, SQLite/Drizzle migrations, seed/testkit, logging/redaction, health endpoints, theme shell, CI scripts.

### Slice 1 — identity and household

Registration, login/logout/session/CSRF, household roles, protected app shell, settings/security tests.

### Slice 2 — trusted ledger

Accounts, balances, manual data, categories, transactions, search/filter/detail, splits/transfers/refunds/tags/exclusions, imports, reports, exports.

### Slice 3 — SimpleFIN

Encrypted claim, full/incremental sync, pending reconciliation, scheduled jobs, sync health and live account import.

### Slice 4 — automation

Merchant normalization, recurring detection, deterministic rule DSL/builder/preview/history, encrypted OpenRouter configuration, AI suggestion review.

### Slice 5 — paycheck envelopes

Income detection, pay cycles, bills, envelope plans/allocations/rollovers, safe-to-spend, budget pages and alert/action engine.

### Slice 6 — wealth and goals

Net worth history, holdings, manual/valued assets, multi-currency, emergency/purchase/debt/investment goals, comfortable dates.

### Slice 7 — forecasting

Scenario editor, deterministic projection, seeded Monte Carlo, age-30 trajectory, action impact comparisons.

### Slice 8 — production hardening

Full autonomous suites, accessibility/visual QA, performance/index tuning, backup/restore, key rotation, systemd/reverse-proxy documentation, final live reconciliation.

## 16. Definition of done

BetterWealth is ready when a new user can install it on bare metal, register, connect the provided SimpleFIN source, sync safely, understand and correct every imported transaction, build paycheck-funded envelopes, see reliable safe-to-spend and net-worth history, plan goals and scenarios through age 30, operate without AI, export/restore all data, and complete the Alex journey with all confidence gates passing.

## 17. Research anchors

- Sure project and current releases: <https://github.com/we-promise/sure>
- SimpleFIN protocol 2 draft and compatibility rules: <https://www.simplefin.org/protocol.html>
- OpenRouter structured outputs: <https://openrouter.ai/docs/guides/features/structured-outputs>
- OpenRouter MiniMax M3 model status: <https://openrouter.ai/minimax/minimax-m3>
- Bun SQLite: <https://bun.com/reference/bun/sqlite>
- Bun Argon2 password hashing: <https://bun.sh/docs/runtime/hashing>
- Hono OpenAPI validation: <https://hono.dev/examples/zod-openapi>
- Drizzle Bun SQLite: <https://orm.drizzle.team/docs/get-started/bun-sqlite-new>
