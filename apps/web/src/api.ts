/**
 * BetterWealth browser API boundary.
 *
 * Expected transport conventions:
 * - all endpoints are rooted at /api/v1;
 * - money is a signed base-10 minor-unit string plus ISO currency (never a JS number);
 * - dates/times are ISO-8601 strings;
 * - list responses use { data, page: { cursor, hasMore } };
 * - errors use { error: { code, message, details? } } and never contain secrets;
 * - cookie-authenticated mutations require the bw_csrf cookie mirrored in X-CSRF-Token;
 * - sync/import/bulk mutations receive an Idempotency-Key.
 *
 * These local interfaces intentionally mirror the product blueprint while the shared
 * contract package is still being assembled. Replace them with generated OpenAPI types
 * when /api/v1/openapi.json is ready.
 */

export const API_BASE = "/api/v1";

export interface Money {
  minorUnits: string;
  currency: string;
}

export type TrustState = "ready" | "incomplete" | "stale";

export interface TrustSnapshot {
  state: TrustState;
  asOf: string;
  pendingImpact: Money;
  missingInputs: string[];
  confidenceLabel: string;
  correctiveAction?: string;
}

export interface DashboardReport {
  safeToSpend: Money;
  safePerDay: Money;
  coveredThrough: string;
  coveredThroughSource: "income_source" | "default_window";
  availableCash: Money;
  reservedBills: Money;
  envelopeCommitments: Money;
  goalContributions: Money;
  minimumBuffer: Money;
  projectedLiquidNetWorth: Money;
  targetLiquidNetWorth: Money;
  targetAge: number | null;
  projectionSource: "forecast" | "cash_flow_run_rate" | "current_balance";
  savingsRate: number;
  trust: TrustSnapshot;
}

export interface DashboardPreferences {
  currency: string;
  minimumBuffer: Money | null;
  targetLiquidNetWorth: Money | null;
  reservedBills: Money | null;
}

export type DashboardPreferencesPatch = Partial<
  Pick<DashboardPreferences, "minimumBuffer" | "targetLiquidNetWorth" | "reservedBills">
>;

export interface NetWorthReport {
  total: Money;
  liquid: Money;
  investable: Money;
  retirement: Money;
  assets: Money;
  debts: Money;
  series: Array<{
    date: string;
    total: Money;
    liquid: Money;
    investable?: Money;
    retirement?: Money;
    assets?: Money;
    debts?: Money;
  }>;
  composition: Array<{
    group: string;
    amount: Money;
    changePercent: number;
    kind: "asset" | "debt";
    detail?: string;
  }>;
}

export interface ApiTransaction {
  id: string;
  accountId?: string;
  effectiveDate: string;
  description: string;
  merchant: string;
  amount: Money;
  accountName: string;
  categoryName: string;
  status: "pending" | "posted";
  reviewState: "ready" | "needs_review" | "approved";
  source: "simplefin" | "manual" | "import";
  note?: string | null;
  tags: string[];
  isTransfer?: boolean;
  isExcluded?: boolean;
  isIncome?: boolean;
  hasSplits?: boolean;
  transferId?: string;
  refundLinkIds?: string[];
}

export interface ApiTransactionSplit {
  id: string;
  sequence: number;
  amount: Money;
  categoryId: string | null;
  categoryName?: string | null;
  envelopeId: string | null;
  envelopeName?: string | null;
  memo: string | null;
}

export interface ApiTransactionDetail
  extends Omit<ApiTransaction, "status" | "hasSplits" | "transferId" | "refundLinkIds"> {
  accountId: string;
  categoryId: string | null;
  envelopeId: string | null;
  status: "pending" | "posted" | "void";
  splits: ApiTransactionSplit[];
  transfer: {
    id: string;
    outflowTransactionId: string;
    inflowTransactionId: string;
    status: "suggested" | "confirmed" | "rejected";
    matchedBy: "provider" | "rule" | "heuristic" | "user";
  } | null;
  refundLinks: Array<{
    id: string;
    refundTransactionId: string;
    purchaseTransactionId: string;
    amount: Money;
    status: "suggested" | "confirmed" | "rejected";
  }>;
}

export interface ApiTransactionImportResult {
  id: string;
  state: "succeeded";
  totalRecords: number;
  importedRecords: number;
  duplicateRecords: number;
  rejectedRecords: number;
}

export interface ApiAccount {
  id: string;
  name: string;
  mask: string;
  group: "cash" | "credit" | "loan" | "investment" | "property" | "vehicle" | "crypto" | "custom";
  balance: Money;
  availableBalance?: Money;
  syncStatus: "healthy" | "syncing" | "attention" | "manual";
  updatedAt: string;
}

export interface ApiAccountBalanceHistory {
  account: { id: string; name: string; currency: string };
  data: Array<{
    id: string;
    asOf: string;
    current: Money;
    ledger: Money;
    available: Money | null;
    source: string;
    reconciled: boolean | null;
  }>;
  summary: {
    current: Money;
    change: Money;
    latestAsOf: string | null;
    reconciled: boolean | null;
  };
}

export interface ManualAccountInput {
  name: string;
  group: ApiAccount["group"];
  type?: string;
  subtype?: string;
  currency?: string;
  balanceMinorUnits?: string;
  mask?: string;
  includeInBudget?: boolean;
}

export interface AccountUpdateInput {
  name?: string;
  mask?: string;
  group?: ApiAccount["group"];
  type?: string;
  subtype?: string;
  includeInBudget?: boolean;
  includeInNetWorth?: boolean;
  status?: "active" | "stale" | "closed";
  balanceMinorUnits?: string;
}

export interface ApiGoal {
  id: string;
  name: string;
  type: "emergency_fund" | "purchase" | "debt_payoff" | "investment" | "custom";
  target: Money;
  funded: Money;
  monthlyContribution: Money;
  earliestSafeDate?: string;
  probability?: number;
  remaining?: Money;
  monthsToGoal?: number | null;
  projectedDate?: string | null;
  monthsUntilTarget?: number | null;
  requiredMonthlyContribution?: Money | null;
  monthlyShortfall?: Money;
  onTrack?: boolean | null;
  paceRatio?: number | null;
  priority: number;
  paused: boolean;
  targetDate?: string | null;
  status?: "active" | "paused" | "completed" | "cancelled";
  fundingAccountId?: string | null;
  linkedDebtAccountId?: string | null;
  contributionPolicy?: unknown;
  bufferPolicy?: unknown;
  liquidityConstraint?: "cash" | "liquid" | "investable" | "any";
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiGoalWriteInput {
  name: string;
  type: ApiGoal["type"];
  target: Money;
  funded?: Money;
  monthlyContribution?: Money;
  targetDate?: string | null;
  priority?: number;
  fundingAccountId?: string | null;
  linkedDebtAccountId?: string | null;
  contributionPolicy?: unknown;
  bufferPolicy?: unknown;
  liquidityConstraint?: NonNullable<ApiGoal["liquidityConstraint"]>;
  status?: NonNullable<ApiGoal["status"]>;
  paused?: boolean;
}

export type ApiGoalPatch = Partial<ApiGoalWriteInput>;

export interface ApiGoalContribution {
  id: string;
  goalId: string;
  amount: Money;
  contributedOn: string;
  note?: string | null;
  createdAt?: string;
}

export interface ApiGoalContributionInput {
  amount: Money;
  source?: string;
  contributedOn?: string;
  note?: string;
}

export interface ApiEnvelope {
  id: string;
  name: string;
  planned: Money;
  funded: Money;
  activity: Money;
  available: Money;
  cadence: string;
  pacing: "on_track" | "watch" | "over";
  rolloverPolicy: string;
  transferredIn?: Money;
  transferredOut?: Money;
  parentId?: string | null;
  categoryId?: string | null;
  categoryIds?: string[];
  priority?: number;
  minimumAmount?: Money;
  targetAmount?: Money;
  isRequired?: boolean;
  isActive?: boolean;
}

export interface ApiBudget {
  id: string;
  periodKind: "pay_cycle" | "month" | "plan";
  startDate: string;
  endDate: string;
  plannedIncome: Money;
  funded: Money;
  spent: Money;
  remaining: Money;
  unassigned: Money;
  totalPlanned?: Money;
  surplus?: Money;
  status?: "planned" | "open" | "closed" | "archived";
  envelopes: ApiEnvelope[];
}

export interface MonthlyPlanInput {
  paychecksPerYear: 12 | 24 | 26 | 52;
  monthlyIncome?: Money;
  items: Array<{
    name: string;
    monthlyAmount: Money;
    categoryId?: string | null;
    priority: number;
    isRequired: boolean;
    rolloverPolicy?: "none" | "positive" | "all" | "cap";
  }>;
}

export interface ApiScenario {
  id: string;
  name: string;
  preset: "conservative" | "baseline" | "ambitious" | "custom";
  assumptions: {
    incomeGrowth: number;
    inflation: number;
    investmentReturn: number;
    cashYield: number;
    monthlyInvesting: Money;
  };
  seed: number;
  isBase: boolean;
}

export interface ApiForecastTrajectoryPoint {
  month: string;
  liquidCash: Money;
  netWorth: Money;
}

export interface ApiForecastPercentileRange {
  p10?: Money;
  p25?: Money;
  p50?: Money;
  p75?: Money;
  p90?: Money;
}

export interface ApiForecastRangePoint {
  month: string;
  netWorth: ApiForecastPercentileRange;
  liquidCash: ApiForecastPercentileRange;
}

export interface ApiAsset {
  id: string;
  name: string;
  type: "property" | "vehicle" | "collectible" | "business" | "custom";
  value: Money;
  valuedAt: string;
  source: string;
  confidence: "low" | "medium" | "high";
  liquidityClass: "liquid" | "restricted" | "illiquid";
  currency?: string;
  relatedLiabilityId?: string;
  latestValuation?: ApiAssetValuation | null;
}

export interface ApiAssetCreateInput {
  name: string;
  type: ApiAsset["type"];
  liquidityClass: ApiAsset["liquidityClass"];
  currency: string;
  value?: Money;
  valuedOn?: string;
  valuedAt?: string;
  valuationSource?: ApiAssetValuation["source"];
  source?: string;
  confidence?: ApiAsset["confidence"];
  relatedLiabilityId?: string;
  isActive?: boolean;
}

export type ApiAssetUpdateInput = Partial<ApiAssetCreateInput>;

export interface ApiAssetValuation {
  id: string;
  assetId: string;
  amount: Money;
  valuedOn: string;
  source: "manual" | "provider" | "appraisal" | "import";
  confidenceBps: number;
  providerReference?: string | null;
}

export interface ApiBill {
  id: string;
  name: string;
  amountMin: Money;
  amountMax: Money;
  recurrenceConfidenceBps: number;
  nextDueDate?: string;
  autopayAccountId?: string;
  envelopeId?: string;
  dueRule: unknown;
  isRequired: boolean;
  isActive: boolean;
}

export interface ApiAiSuggestion {
  id: string;
  transactionId: string;
  merchant: string;
  categoryId: string;
  categoryName: string;
  confidence: number;
  rationale: string;
  amount?: Money;
  rawDescription?: string;
  proposedRule?: Pick<ApiRule, "name" | "conditions" | "actions">;
  status: "pending" | "accepted" | "rejected";
}

export interface ApiRule {
  id: string;
  name: string;
  priority: number;
  enabled: boolean;
  origin: "user" | "system" | "approved_ai";
  conditions: unknown;
  actions: unknown;
  matchCount: number;
  lastMatchedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiRuleWriteInput {
  name: string;
  priority: number;
  enabled: boolean;
  origin?: ApiRule["origin"];
  conditions: unknown;
  actions: unknown;
}

export interface ApiRulePreview {
  matchCount: number;
  aggregateAmount: Money;
  samples: ApiTransaction[];
  conflicts: ApiRule[];
}

export interface ApiForecast {
  id: string;
  scenarioId: string;
  engineVersion: string;
  seed: number;
  state?: "queued" | "running" | "succeeded" | "failed";
  horizonDate: string;
  liquidNetWorthAtTarget: Money;
  totalNetWorthAtTarget: Money;
  lowestCashBalance: Money;
  debtFreeDate?: string;
  percentiles: Array<{ percentile: 10 | 25 | 50 | 75 | 90; amount: Money }>;
  trajectory: ApiForecastTrajectoryPoint[];
  monteCarlo?: {
    runs: number;
    goalSuccessProbability: number | null;
    ranges: ApiForecastRangePoint[];
  };
  readiness: { score: number; missingInputs: string[]; confidenceLabel: string };
  createdAt?: string;
}

export interface ApiConnection {
  id: string;
  provider: "simplefin" | "openrouter" | "exchange_rate" | "valuation" | "import";
  status: "healthy" | "syncing" | "attention" | "disabled";
  displayName: string;
  lastSuccessfulAt?: string;
  capabilities: string[];
}

export interface ApiCategory {
  id: string;
  name: string;
  parentId: string | null;
  kind: "income" | "expense" | "transfer" | "debt" | "investment";
  active: boolean;
}

export interface IntegrationSettings {
  ai: {
    enabled: boolean;
    provider: string | null;
    model: string | null;
    consentedFields: string[];
  };
  exchangeRates: { provider: string; enabled: boolean };
  valuations: { providers: string[] };
}

export interface AiIntegrationConfig {
  configured: boolean;
  enabled: boolean;
  baseUrl: string;
  model: string | null;
  confidenceThreshold: number;
}

export interface ApiSession {
  id: string;
  current: boolean;
  userAgent: string;
  ipAddress: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface ApiProfile {
  user: {
    id: string;
    email: string;
    displayName: string | null;
    birthDate: string | null;
    targetAge: number | null;
    emailVerifiedAt: string | null;
  };
  household: {
    id: string;
    name: string;
    baseCurrency: string;
    locale: string;
    timezone: string;
  };
  role: "owner" | "admin" | "member" | "viewer";
}

export interface ApiHouseholdMember {
  id: string;
  email: string;
  displayName: string | null;
  role: "owner" | "admin" | "member" | "viewer";
  status: "active" | "invited" | "suspended";
  joinedAt: string;
}

export interface ProfilePatch {
  displayName?: string;
  birthDate?: string | null;
  targetAge?: number | null;
  householdName?: string;
  baseCurrency?: string;
  timezone?: string;
}

export interface ApiIncomeSource {
  id: string;
  name: string;
  cadence: string;
  typicalAmount: Money;
  nextExpectedDate?: string;
  isActive: boolean;
}

export interface ApiBill {
  id: string;
  name: string;
  amountMin: Money;
  amountMax: Money;
  nextDueDate?: string;
  isRequired: boolean;
  isActive: boolean;
}

export interface ApiAuditEvent {
  id: string;
  action: string;
  entityType: string;
  safeDescription: string;
  actorLabel: string;
  createdAt: string;
}

interface ApiAuditEventWire {
  id: string;
  actorType: "user" | "system" | "job" | "token";
  action: string;
  entityType: string;
  metadata: unknown;
  occurredAt: string;
}

export interface DownloadResult {
  filename: string;
  sizeBytes: number;
}

export interface CursorPage<T> {
  data: T[];
  page: { cursor: string | null; hasMore: boolean };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

function readCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.cookie
    .split("; ")
    .find((entry) => entry.startsWith("bw_csrf="))
    ?.slice("bw_csrf=".length);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body && !(typeof FormData !== "undefined" && init.body instanceof FormData))
    headers.set("Content-Type", "application/json");

  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", decodeURIComponent(csrf));
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "BetterWealth could not reach the server.");
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // The response body is deliberately ignored when it is not the documented safe shape.
    }
    throw new ApiError(
      response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "The request could not be completed.",
      body.error?.details,
    );
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function downloadFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!match?.[1]) return fallback;
  try {
    return decodeURIComponent(match[1]).replace(/[\\/\r\n]/g, "-");
  } catch {
    return fallback;
  }
}

async function download(path: string, fallbackFilename: string): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/octet-stream, application/json" },
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "BetterWealth could not reach the server.");
  }

  if (!response.ok) {
    let body: ErrorBody = {};
    try {
      body = (await response.json()) as ErrorBody;
    } catch {
      // Binary endpoints still use the same safe JSON error envelope on failure.
    }
    throw new ApiError(
      response.status,
      body.error?.code ?? "DOWNLOAD_FAILED",
      body.error?.message ?? "The download could not be completed.",
      body.error?.details,
    );
  }

  const blob = await response.blob();
  const filename = downloadFilename(response, fallbackFilename);
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    throw new ApiError(0, "DOWNLOAD_UNAVAILABLE", "This browser cannot save the downloaded file.");
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
  return { filename, sizeBytes: blob.size };
}

function humanizeAuditAction(action: string): string {
  const words = action.replace(/[._-]+/g, " ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

function describeAuditEvent(event: ApiAuditEventWire): string {
  if (event.metadata && typeof event.metadata === "object" && "fields" in event.metadata) {
    const fields = (event.metadata as { fields?: unknown }).fields;
    if (Array.isArray(fields) && fields.every((field) => typeof field === "string")) {
      return `${event.entityType} fields changed: ${fields.join(", ")}`;
    }
  }
  return `${event.entityType} change recorded`;
}

function idempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `bw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const api = {
  register: (input: { email: string; password: string; householdName: string }) =>
    request<{ userId: string; householdId: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  login: (input: { email: string; password: string }) =>
    request<{ user: { id: string; email: string; name?: string }; csrfToken: string }>(
      "/auth/login",
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  session: () =>
    request<{ user: { id: string; email: string; name?: string }; householdId: string }>(
      "/auth/session",
    ),
  profile: () => request<ApiProfile>("/profile"),
  updateProfile: (patch: ProfilePatch) =>
    request<{ updated: true }>("/profile", { method: "PATCH", body: JSON.stringify(patch) }),
  householdMembers: () => request<CursorPage<ApiHouseholdMember>>("/household/members"),
  sessions: () => request<CursorPage<ApiSession>>("/auth/sessions"),
  revokeSession: (id: string) =>
    request<void>(`/auth/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  changePassword: (input: { currentPassword: string; newPassword: string }) =>
    request<{ changed: true }>("/profile/password", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  dashboard: () => request<DashboardReport>("/reports/dashboard"),
  dashboardPreferences: () => request<DashboardPreferences>("/reports/dashboard/preferences"),
  updateDashboardPreferences: (patch: DashboardPreferencesPatch) =>
    request<DashboardPreferences>("/reports/dashboard/preferences", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  netWorthReport: (range = "1Y") =>
    request<NetWorthReport>(`/reports/net-worth?range=${encodeURIComponent(range)}`),
  transactions: (query = "") =>
    request<CursorPage<ApiTransaction>>(`/transactions${query ? `?${query}` : ""}`),
  transaction: (id: string) =>
    request<ApiTransactionDetail>(`/transactions/${encodeURIComponent(id)}`),
  updateTransaction: (id: string, patch: Partial<ApiTransaction>) =>
    request<ApiTransaction>(`/transactions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  bulkTransactions: (input: { ids: string[]; patch: Partial<ApiTransaction> }) =>
    request<{ affected: number; reversibleBatchId: string }>("/transactions/bulk", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
      body: JSON.stringify(input),
    }),
  replaceTransactionSplits: (
    id: string,
    splits: Array<{
      amountMinorUnits: string;
      categoryId?: string;
      envelopeId?: string;
      memo?: string;
    }>,
  ) =>
    request<{ data: ApiTransactionSplit[] }>(`/transactions/${encodeURIComponent(id)}/splits`, {
      method: "PUT",
      body: JSON.stringify({ splits }),
    }),
  matchTransfer: (input: { outflowTransactionId: string; inflowTransactionId: string }) =>
    request<{ id: string; status: "confirmed" }>("/transfers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  linkRefund: (input: { refundTransactionId: string; purchaseTransactionId: string }) =>
    request<{ id: string; status: "confirmed"; amount: Money }>("/refund-links", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  createTransaction: (input: {
    accountId: string;
    amountMinorUnits: string;
    currency: string;
    effectiveDate: string;
    description: string;
    categoryId?: string;
    note?: string;
  }) =>
    request<{ id: string }>("/transactions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  importTransactions: (input: {
    accountId: string;
    filename: string;
    content: string;
    currency?: string;
  }) =>
    request<ApiTransactionImportResult>("/imports/transactions", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeTransactionSplits: (id: string) =>
    request<void>(`/transactions/${encodeURIComponent(id)}/splits`, { method: "DELETE" }),
  removeTransfer: (id: string) =>
    request<void>(`/transfers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  removeRefundLink: (id: string) =>
    request<void>(`/refund-links/${encodeURIComponent(id)}`, { method: "DELETE" }),
  accounts: () => request<CursorPage<ApiAccount>>("/accounts"),
  accountBalances: (id: string) =>
    request<ApiAccountBalanceHistory>(`/accounts/${encodeURIComponent(id)}/balances`),
  createAccount: (input: ManualAccountInput) =>
    request<{ id: string }>("/accounts", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (id: string, patch: AccountUpdateInput) =>
    request<{ id: string; updated: true }>(`/accounts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  createIncomeSource: (input: {
    name: string;
    cadence: string;
    typicalAmount: Money;
    nextExpectedDate?: string;
    isActive?: boolean;
  }) =>
    request<ApiIncomeSource>("/income-sources", { method: "POST", body: JSON.stringify(input) }),
  incomeSources: () => request<CursorPage<ApiIncomeSource>>("/income-sources"),
  updateIncomeSource: (id: string, patch: Partial<Omit<ApiIncomeSource, "id">>) =>
    request<ApiIncomeSource>(`/income-sources/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  createBill: (input: {
    name: string;
    amountMin: Money;
    amountMax: Money;
    nextDueDate?: string;
    dueRule?: unknown;
    isRequired?: boolean;
    isActive?: boolean;
  }) => request<ApiBill>("/bills", { method: "POST", body: JSON.stringify(input) }),
  updateBill: (id: string, patch: Partial<Omit<ApiBill, "id">>) =>
    request<ApiBill>(`/bills/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  budgets: (view: "pay_cycle" | "month" | "plan" = "pay_cycle") =>
    request<CursorPage<ApiBudget>>(`/budgets?view=${view}`),
  createBudget: (input: Partial<ApiBudget>) =>
    request<ApiBudget>("/budgets", { method: "POST", body: JSON.stringify(input) }),
  updateBudget: (id: string, patch: Partial<ApiBudget>) =>
    request<ApiBudget>(`/budgets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  buildBudgetFromMonthlySpend: (id: string, input: MonthlyPlanInput) =>
    request<{
      budget: ApiBudget;
      conversions: Array<{
        envelopeId: string;
        name: string;
        monthlyAmount: Money;
        perPaycheckAmount: Money;
      }>;
    }>(`/budgets/${encodeURIComponent(id)}/build-from-monthly-spend`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  envelopes: () => request<CursorPage<ApiEnvelope>>("/envelopes"),
  createEnvelope: (input: {
    name: string;
    planned: Money;
    cadence?: string;
    rolloverPolicy?: "none" | "positive" | "all" | "cap" | "monthly_reset";
    priority?: number;
    isRequired?: boolean;
    isActive?: boolean;
    categoryId?: string | null;
    categoryIds?: string[];
    minimumAmountMinorUnits?: string;
  }) => request<ApiEnvelope>("/envelopes", { method: "POST", body: JSON.stringify(input) }),
  updateEnvelope: (id: string, patch: Partial<ApiEnvelope>) =>
    request<ApiEnvelope>(`/envelopes/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  archiveEnvelope: (id: string) =>
    request<void>(`/envelopes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  createAllocation: (input: {
    budgetId: string;
    fromEnvelopeId: string | null;
    toEnvelopeId: string;
    amount: Money;
    reason: string;
  }) =>
    request<{ id: string; reversibleBatchId: string; budget: ApiBudget }>("/allocations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  bills: () => request<CursorPage<ApiBill>>("/bills"),
  goals: () => request<CursorPage<ApiGoal>>("/goals"),
  createGoal: (input: ApiGoalWriteInput) =>
    request<ApiGoal>("/goals", { method: "POST", body: JSON.stringify(input) }),
  updateGoal: (id: string, patch: ApiGoalPatch) =>
    request<ApiGoal>(`/goals/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  reorderGoals: (goalIds: string[]) =>
    request<CursorPage<ApiGoal>>("/goals/order", {
      method: "PUT",
      body: JSON.stringify({ goalIds }),
    }),
  archiveGoal: (id: string) =>
    request<void>(`/goals/${encodeURIComponent(id)}`, { method: "DELETE" }),
  goalContributions: (id: string) =>
    request<CursorPage<ApiGoalContribution>>(`/goals/${encodeURIComponent(id)}/contributions`),
  contributeToGoal: (id: string, input: ApiGoalContributionInput) =>
    request<{
      id: string;
      contributionId: string;
      allocationEntryId: string;
      amount: Money;
      contributedOn: string;
      goal: ApiGoal;
    }>(`/goals/${encodeURIComponent(id)}/contributions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  rules: () => request<CursorPage<ApiRule>>("/rules"),
  createRule: (input: ApiRuleWriteInput) =>
    request<ApiRule>("/rules", {
      method: "POST",
      body: JSON.stringify({ ...input, origin: "user" }),
    }),
  updateRule: (id: string, patch: Partial<ApiRule>) =>
    request<ApiRule>(`/rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteRule: (id: string) =>
    request<void>(`/rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  previewRule: (
    input: Pick<ApiRuleWriteInput, "conditions" | "actions"> &
      Partial<Pick<ApiRuleWriteInput, "name" | "priority">> & {
        transactionIds?: string[];
        excludeRuleId?: string;
      },
  ) =>
    request<ApiRulePreview>("/rules/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  applyRule: (id: string, transactionIds?: string[]) =>
    request<{ affected: number; reversibleBatchId: string; transactionIds: string[] }>(
      `/rules/${encodeURIComponent(id)}/apply`,
      {
        method: "POST",
        body: JSON.stringify(transactionIds ? { transactionIds } : {}),
      },
    ),
  forecasts: () => request<CursorPage<ApiForecast>>("/forecasts"),
  runForecast: (input: { scenarioId: string; seed: number; monteCarloRuns?: number }) =>
    request<ApiForecast>("/forecasts", { method: "POST", body: JSON.stringify(input) }),
  scenarios: () => request<CursorPage<ApiScenario>>("/scenarios"),
  createScenario: (input: Omit<ApiScenario, "id">) =>
    request<ApiScenario>("/scenarios", { method: "POST", body: JSON.stringify(input) }),
  updateScenario: (id: string, patch: Partial<ApiScenario>) =>
    request<ApiScenario>(`/scenarios/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  connections: () => request<CursorPage<ApiConnection>>("/connections"),
  createConnection: (input: { provider: ApiConnection["provider"]; payload: unknown }) =>
    request<ApiConnection>("/connections", { method: "POST", body: JSON.stringify(input) }),
  updateConnection: (id: string, patch: Partial<ApiConnection>) =>
    request<ApiConnection>(`/connections/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  claimSimpleFin: (input: { setupToken: string }) =>
    request<{
      connection: ApiConnection;
      sync: { syncRunId: string; state: "queued" | "leased" | "succeeded" | "failed" };
    }>("/connections/simplefin/claim", { method: "POST", body: JSON.stringify(input) }),
  assets: () => request<CursorPage<ApiAsset>>("/assets"),
  createAsset: (input: ApiAssetCreateInput) =>
    request<ApiAsset>("/assets", { method: "POST", body: JSON.stringify(input) }),
  updateAsset: (id: string, patch: ApiAssetUpdateInput) =>
    request<ApiAsset>(`/assets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  deleteAsset: (id: string) =>
    request<void>(`/assets/${encodeURIComponent(id)}`, { method: "DELETE" }),
  assetValuations: (id: string) =>
    request<CursorPage<ApiAssetValuation>>(`/assets/${encodeURIComponent(id)}/valuations`),
  createAssetValuation: (
    id: string,
    input: {
      amount: Money;
      valuedOn: string;
      source: ApiAssetValuation["source"];
      confidenceBps: number;
      providerReference?: string;
    },
  ) =>
    request<ApiAssetValuation>(`/assets/${encodeURIComponent(id)}/valuations`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  categories: () => request<CursorPage<ApiCategory>>("/categories"),
  createCategory: (input: Omit<ApiCategory, "id">) =>
    request<ApiCategory>("/categories", { method: "POST", body: JSON.stringify(input) }),
  updateCategory: (id: string, patch: Partial<ApiCategory>) =>
    request<ApiCategory>(`/categories/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  integrationSettings: () => request<IntegrationSettings>("/settings/integrations"),
  updateIntegrationSettings: (patch: Partial<IntegrationSettings>) =>
    request<{ updated: true }>("/settings/integrations", {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  aiIntegrationConfig: () => request<AiIntegrationConfig>("/settings/integrations/ai"),
  updateAiIntegrationConfig: (input: {
    enabled: boolean;
    consent: true;
    baseUrl: string;
    model: string;
    apiKey?: string;
    confidenceThreshold: number;
  }) =>
    request<AiIntegrationConfig>("/settings/integrations/ai", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  aiSuggestions: () => request<CursorPage<ApiAiSuggestion>>("/ai/suggestions"),
  reviewAiSuggestion: (
    id: string,
    input: { status: "accepted" | "rejected"; createRule: boolean },
  ) =>
    request<ApiAiSuggestion>(`/ai/suggestions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  downloadDataExport: () =>
    download("/data-export", `betterwealth-${new Date().toISOString().slice(0, 10)}.json`),
  downloadDatabaseBackup: () =>
    download("/database-backup", `betterwealth-${new Date().toISOString().slice(0, 10)}.sqlite`),
  auditEvents: async () => {
    const page = await request<CursorPage<ApiAuditEventWire>>("/audit-events");
    return {
      ...page,
      data: page.data.map(
        (event): ApiAuditEvent => ({
          id: event.id,
          action: humanizeAuditAction(event.action),
          entityType: event.entityType,
          safeDescription: describeAuditEvent(event),
          actorLabel:
            event.actorType === "user" ? "Household member" : humanizeAuditAction(event.actorType),
          createdAt: event.occurredAt,
        }),
      ),
    };
  },
  sync: () =>
    request<{
      syncRunId: string;
      syncRunIds: string[];
      state: "queued" | "leased" | "succeeded" | "failed" | "cancelled";
    }>("/sync-runs", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey() },
    }),
  health: () =>
    request<{ status: "ok"; version: string; time: string; database: "ready" }>("/health"),
};
