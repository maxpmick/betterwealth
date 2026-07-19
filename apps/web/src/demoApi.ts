/**
 * The web demo "backend": the single projection of the demo universe (data.ts)
 * into the API-shaped responses the pages render while demo mode is on.
 *
 * Everything here is built from exact minor-unit strings — no float ever becomes
 * money here. The only exception is forecast trajectory modeling, which is chart
 * math by nature: exact fixture inputs are scaled to display numbers via
 * minorToMajor, modeled, and rounded back to minor units for transport.
 *
 * Do not fabricate API responses inside pages; add the projection here instead.
 */

import type {
  ApiAccount,
  ApiAccountBalanceHistory,
  ApiAiSuggestion,
  ApiAsset,
  ApiBill,
  ApiBudget,
  ApiCategory,
  ApiEnvelope,
  ApiForecast,
  ApiForecastRangePoint,
  ApiGoal,
  ApiRule,
  ApiScenario,
  ApiTransaction,
  ComfortablePurchasePlan,
  CursorPage,
  DashboardReport,
  Money,
  NetWorthReport,
} from "./api";
import {
  accounts,
  type DemoTransaction,
  envelopes,
  forecastHistory,
  goals,
  netWorthHistory,
  rules,
  suggestions,
  transactions,
} from "./data";
import { minorToMajor } from "./lib/money";

function money(minorUnits: string | bigint, currency = "USD"): Money {
  return {
    minorUnits: typeof minorUnits === "bigint" ? minorUnits.toString(10) : minorUnits,
    currency,
  };
}

function page<T>(data: T[]): CursorPage<T> {
  return { data, page: { cursor: null, hasMore: false } };
}

export const demoSession = {
  user: { id: "demo", email: "alex@example.com", name: "Alex" },
  householdId: "demo",
};

export const demoDashboard: DashboardReport = {
  safeToSpend: money("61200"),
  safePerDay: money("4371"),
  coveredThrough: "2026-07-30T23:59:59.999Z",
  coveredThroughSource: "income_source",
  availableCash: money("300000"),
  reservedBills: money("84800"),
  envelopeCommitments: money("34000"),
  goalContributions: money("20000"),
  minimumBuffer: money("100000"),
  projectedLiquidNetWorth: money("22340000"),
  targetLiquidNetWorth: money("22500000"),
  targetAge: 30,
  projectionSource: "forecast",
  savingsRate: 24.6,
  trust: {
    state: "ready",
    asOf: "2026-07-16T10:42:00.000Z",
    pendingImpact: money("-4816"),
    missingInputs: [],
    confidenceLabel: "High",
  },
};

export const demoBills: CursorPage<ApiBill> = page([
  {
    id: "bill-internet",
    name: "Home internet",
    amountMin: money("6500"),
    amountMax: money("6500"),
    recurrenceConfidenceBps: 9800,
    nextDueDate: "2026-07-21",
    dueRule: { cadence: "monthly" },
    isRequired: true,
    isActive: true,
  },
  {
    id: "bill-card",
    name: "Emerald card",
    amountMin: money("41000"),
    amountMax: money("41000"),
    recurrenceConfidenceBps: 8000,
    nextDueDate: "2026-07-24",
    dueRule: { cadence: "monthly" },
    isRequired: true,
    isActive: true,
  },
  {
    id: "bill-insurance",
    name: "Renter’s insurance",
    amountMin: money("2800"),
    amountMax: money("2800"),
    recurrenceConfidenceBps: 9900,
    nextDueDate: "2026-07-27",
    dueRule: { cadence: "monthly" },
    isRequired: true,
    isActive: true,
  },
]);

export const demoEnvelopes: CursorPage<ApiEnvelope> = page(
  envelopes.map((envelope, index) => ({
    id: `demo-envelope-${index}`,
    name: envelope.name,
    planned: money(envelope.plannedMinorUnits),
    funded: money(envelope.fundedMinorUnits),
    activity: money(envelope.activityMinorUnits),
    available: money(envelope.availableMinorUnits),
    cadence: envelope.cadence,
    pacing: envelope.pacing === "on-track" ? "on_track" : envelope.pacing,
    rolloverPolicy: "positive",
    transferredIn: money("0"),
    transferredOut: money("0"),
    parentId: null,
    categoryId: null,
    categoryIds: [],
    priority: 100 - index * 10,
    minimumAmount: money(envelope.plannedMinorUnits),
    targetAmount: money(envelope.plannedMinorUnits),
    isRequired: index < 3,
    isActive: true,
  })),
);

export const demoBudgets: CursorPage<ApiBudget> = page([
  {
    id: "budget_demo",
    periodKind: "pay_cycle",
    startDate: "2026-07-16",
    endDate: "2026-07-30",
    plannedIncome: money("220000"),
    funded: money("205000"),
    spent: money("12173"),
    remaining: money("192827"),
    unassigned: money("15000"),
    totalPlanned: money("205000"),
    surplus: money("15000"),
    status: "open",
    envelopes: demoEnvelopes.data,
  },
]);

function accountIdFor(record: DemoTransaction): string {
  return accounts.find((account) => account.name === record.account)?.id ?? "demo-account";
}

/**
 * Base transaction projection shared by every demo ledger view. Individual
 * surfaces layer their own extras (transfer flags, varying dates) on top.
 */
export function demoTransaction(record: DemoTransaction): ApiTransaction {
  return {
    id: record.id,
    accountId: accountIdFor(record),
    effectiveDate: "2026-07-16",
    description: record.rawDescription,
    merchant: record.merchant,
    amount: money(record.amountMinorUnits, record.currency),
    accountName: record.account,
    categoryName: record.category,
    status: record.pending ? "pending" : "posted",
    reviewState: record.needsReview ? "needs_review" : "ready",
    source: record.provenance.startsWith("CSV") ? "import" : "simplefin",
    tags: [],
  };
}

/** Full ledger for the Transactions page: transfer/exclusion flags included. */
export const demoLedgerTransactions: CursorPage<ApiTransaction> = page(
  transactions.map((record) => {
    const isTransfer = record.category === "Transfer";
    return {
      ...demoTransaction(record),
      note: record.note ?? "",
      isTransfer,
      isExcluded: Boolean(record.excluded),
      isIncome: BigInt(record.amountMinorUnits) > 0n && record.category === "Income",
      hasSplits: false,
      ...(isTransfer ? { transferId: `demo-transfer-${record.id}` } : {}),
      refundLinkIds: [],
    };
  }),
);

/**
 * Coverage sample for Automation. Deliberately omits transfer/exclusion flags:
 * the coverage stats count every ledger entry, and the pinned demo stats
 * ("7 of 9 categorized") depend on that.
 */
export const demoCoverageTransactions: CursorPage<ApiTransaction> = page(
  transactions.map(demoTransaction),
);

/** Recent-activity slice for the Today page: first five entries, staggered dates. */
export const demoRecentTransactions: CursorPage<ApiTransaction> = page(
  transactions.slice(0, 5).map((record, index) => ({
    ...demoTransaction(record),
    accountId: `demo-account-${index}`,
    effectiveDate: new Date(2026, 6, 16 - index).toISOString(),
  })),
);

const groupTransport: Record<(typeof accounts)[number]["group"], ApiAccount["group"]> = {
  Cash: "cash",
  Investments: "investment",
  Credit: "credit",
  Loans: "loan",
};

export const demoAccounts: CursorPage<ApiAccount> = page(
  accounts.map((account) => ({
    id: account.id,
    name: account.name,
    mask: account.mask,
    group: groupTransport[account.group],
    type: account.type,
    subtype: null,
    institutionName: account.institution,
    isManual: account.status === "Manual",
    balance: money(account.balanceMinorUnits),
    syncStatus:
      account.status === "Healthy"
        ? "healthy"
        : account.status === "Manual"
          ? "manual"
          : "attention",
    updatedAt: "2026-07-16T10:42:00.000Z",
  })),
);

export function demoBalanceHistory(account: {
  id: string;
  name: string;
  balanceMinorUnits: string;
}): ApiAccountBalanceHistory {
  const current = BigInt(account.balanceMinorUnits);
  const deltas = [-185_000n, -120_000n, -78_000n, -32_000n, -9_000n, 0n];
  return {
    account: { id: account.id, name: account.name, currency: "USD" },
    data: deltas.map((delta, index) => {
      const value = (current + delta).toString(10);
      return {
        id: `demo-balance-${index}`,
        asOf: `2026-${String(index + 2).padStart(2, "0")}-01T12:00:00.000Z`,
        current: money(value),
        ledger: money(value),
        available: money(value),
        source: "fixture",
        reconciled: true,
      };
    }),
    summary: {
      current: money(current),
      change: money("185000"),
      latestAsOf: "2026-07-01T12:00:00.000Z",
      reconciled: true,
    },
  };
}

export const demoAssets: CursorPage<ApiAsset> = page([
  {
    id: "asset-civic",
    name: "2019 Honda Civic",
    type: "vehicle",
    value: money("950000"),
    valuedAt: "2026-07-01T00:00:00.000Z",
    source: "manual",
    confidence: "medium",
    liquidityClass: "illiquid",
  },
  {
    id: "asset-deposit",
    name: "Apartment security deposit",
    type: "custom",
    value: money("250000"),
    valuedAt: "2025-09-03T00:00:00.000Z",
    source: "manual",
    confidence: "high",
    liquidityClass: "illiquid",
  },
]);

const demoComposition: Array<{
  group: string;
  amountMinorUnits: string;
  changePercent: number;
  kind: "asset" | "debt";
  detail: string;
}> = [
  {
    group: "Cash",
    amountMinorUnits: "750000",
    changePercent: 4.8,
    kind: "asset",
    detail: "Checking + savings",
  },
  {
    group: "Taxable investments",
    amountMinorUnits: "650000",
    changePercent: 12.6,
    kind: "asset",
    detail: "Brokerage holdings",
  },
  {
    group: "Retirement",
    amountMinorUnits: "800000",
    changePercent: 14.1,
    kind: "asset",
    detail: "401(k)",
  },
  {
    group: "Manual assets",
    amountMinorUnits: "1200000",
    changePercent: -4.2,
    kind: "asset",
    detail: "Vehicle + security deposit",
  },
  {
    group: "Credit cards",
    amountMinorUnits: "-120000",
    changePercent: 2.4,
    kind: "debt",
    detail: "Current balance",
  },
  {
    group: "Student loans",
    amountMinorUnits: "-1200000",
    changePercent: 6.1,
    kind: "debt",
    detail: "5.4% APR",
  },
];

export const demoNetWorth: NetWorthReport = {
  total: money("1980000"),
  liquid: money("1630000"),
  investable: money("1450000"),
  retirement: money("800000"),
  assets: money("3400000"),
  debts: money("1320000"),
  series: netWorthHistory.map((row, index) => ({
    date: `2026-${String(index + 1).padStart(2, "0")}-01`,
    total: money(row.totalMinorUnits),
    liquid: money(row.liquidMinorUnits),
    investable: money(890_000n + BigInt(index) * 112_000n),
    retirement: money(525_000n + BigInt(index) * 55_000n),
    assets: money(BigInt(row.totalMinorUnits) + 1_480_000n - BigInt(index) * 32_000n),
    debts: money(1_480_000n - BigInt(index) * 32_000n),
  })),
  composition: demoComposition.map((row) => ({
    group: row.group,
    amount: money(row.amountMinorUnits),
    changePercent: row.changePercent,
    kind: row.kind,
    detail: row.detail,
  })),
};

export const demoComfortablePurchasePlan: ComfortablePurchasePlan = {
  status: "comfortable",
  comfortable: true,
  comfortableMonth: "2027-04",
  monthsUntilPurchase: 9,
  controllingConstraint: "targetNetWorth",
  limitingConstraints: [
    {
      code: "targetNetWorth",
      label: "Wealth target preserved",
      satisfied: true,
      detail:
        "Projected liquid net worth still reaches the saved age-30 target after a conservative full purchase-price write-off.",
    },
  ],
  constraints: [],
  missingInputs: [],
  inputs: {
    spendableLiquidity: money("875000"),
    unreservedLiquidity: money("299000"),
    fundingAccountBalance: money("425000"),
    verifiedPurchaseSavings: money("240000"),
    protectedMinimumBuffer: money("250000"),
    requiredMonthlyBills: money("145000"),
    requiredObligationShortfall: money("0"),
    higherPriorityMonthlyFunding: money("65000"),
    monthlySurplus: money("123000"),
    monthlySurplusSource: "explicit_budget",
    currentLiquidNetWorth: money("2490000"),
    targetLiquidNetWorth: money("10000000"),
    targetWealthDate: "2034-07-01",
    projectedLiquidNetWorthAtTarget: money("10120000"),
  },
  assumptions: [
    "A purchase before the wealth milestone is treated as a 100% liquid-net-worth write-off.",
  ],
};

export const demoGoals: CursorPage<ApiGoal> = page(
  goals.map((goal, index) => ({
    id: goal.id,
    name: goal.name,
    type: goal.type,
    target: money(goal.targetMinorUnits),
    funded: money(goal.fundedMinorUnits),
    monthlyContribution: money(goal.monthlyMinorUnits),
    earliestSafeDate: goal.earliestSafeDate,
    probability: goal.probability,
    targetDate: goal.targetDate,
    priority: index + 1,
    paused: false,
    status: "active",
    liquidityConstraint: goal.type === "investment" ? "investable" : "liquid",
    ...(goal.type === "purchase" ? { comfortablePurchase: demoComfortablePurchasePlan } : {}),
  })),
);

export const demoCategories: CursorPage<ApiCategory> = page(
  (
    [
      ["category-groceries", "Groceries", "expense"],
      ["category-dining", "Dining", "expense"],
      ["category-utilities", "Utilities", "expense"],
      ["category-shopping", "Shopping", "expense"],
      ["category-entertainment", "Entertainment", "expense"],
      ["category-transportation", "Transportation", "expense"],
      ["category-income", "Income", "income"],
      ["category-transfer", "Transfer", "transfer"],
    ] satisfies Array<[string, string, ApiCategory["kind"]]>
  ).map(([id, name, kind]) => ({
    id,
    name,
    kind,
    parentId: null,
    active: true,
  })),
);

const demoRuleConditions: unknown[] = [
  { field: "merchant", operator: "exact", value: "Whole Foods Market", caseSensitive: false },
  {
    all: [
      {
        field: "normalizedDescription",
        operator: "contains",
        value: "PAYROLL",
        caseSensitive: false,
      },
      { field: "direction", operator: "exact", value: "inflow" },
    ],
  },
  {
    field: "normalizedDescription",
    operator: "startsWith",
    value: "METRO FUEL",
    caseSensitive: false,
  },
  {
    all: [
      { field: "merchant", operator: "exact", value: "Vanguard", caseSensitive: false },
      { field: "accountId", operator: "exact", value: "acc_01", caseSensitive: false },
    ],
  },
];

const demoRuleActions: unknown[][] = [
  [
    { type: "setCategory", categoryId: "category-groceries" },
    { type: "setEnvelope", envelopeId: "demo-envelope-1" },
  ],
  [
    { type: "setCategory", categoryId: "category-income" },
    { type: "setFlag", flag: "income", value: true },
  ],
  [{ type: "setCategory", categoryId: "category-transportation" }],
  [
    { type: "setCategory", categoryId: "category-transfer" },
    { type: "setFlag", flag: "transfer", value: true },
  ],
];

export const demoRules: CursorPage<ApiRule> = page(
  rules.map((rule, index) => ({
    id: rule.id,
    name: rule.name,
    priority: rule.priority,
    enabled: rule.enabled,
    origin:
      rule.source === "System" ? "system" : rule.source === "Approved AI" ? "approved_ai" : "user",
    conditions: demoRuleConditions[index],
    actions: demoRuleActions[index] ?? [],
    matchCount: rule.matches,
    lastMatchedAt: rule.last,
  })),
);

export const demoSuggestions: CursorPage<ApiAiSuggestion> = page(
  suggestions.map((suggestion) => ({
    id: suggestion.id,
    transactionId: suggestion.id.replace("ai", "txn"),
    merchant: suggestion.merchant,
    categoryId: suggestion.category.toLowerCase(),
    categoryName: suggestion.category,
    confidence: suggestion.confidence / 100,
    rationale: suggestion.rationale,
    amount: money(suggestion.amountMinorUnits),
    rawDescription: suggestion.raw,
    proposedRule: {
      name: `${suggestion.merchant} ${suggestion.category}`,
      conditions: {},
      actions: {},
    },
    status: "pending",
  })),
);

const demoBaselineScenario: ApiScenario = {
  id: "scenario_demo_baseline",
  name: "Baseline",
  preset: "baseline",
  assumptions: {
    incomeGrowth: 3.2,
    inflation: 2.6,
    investmentReturn: 6.5,
    cashYield: 4.1,
    monthlyInvesting: money("70000"),
  },
  seed: 300122,
  isBase: true,
};

export const demoScenarios: CursorPage<ApiScenario> = page([
  {
    ...demoBaselineScenario,
    id: "scenario_demo_conservative",
    name: "Conservative",
    preset: "conservative",
    assumptions: { ...demoBaselineScenario.assumptions, investmentReturn: 4 },
    seed: 300121,
    isBase: false,
  },
  demoBaselineScenario,
  {
    ...demoBaselineScenario,
    id: "scenario_demo_ambitious",
    name: "Ambitious",
    preset: "ambitious",
    assumptions: {
      ...demoBaselineScenario.assumptions,
      incomeGrowth: 5,
      investmentReturn: 8.5,
      monthlyInvesting: money("100000"),
    },
    seed: 300123,
    isBase: false,
  },
]);

/** Modeled chart output: rounded back to minor units for transport. */
function modeledMoney(value: number): Money {
  return money(BigInt(Math.round(value * 100)));
}

export function demoForecastFor(scenario: ApiScenario): ApiForecast {
  const key =
    scenario.preset === "conservative"
      ? "conservative"
      : scenario.preset === "ambitious"
        ? "ambitious"
        : "baseline";
  const defaults =
    key === "conservative"
      ? { incomeGrowth: 3.2, inflation: 2.6, investmentReturn: 4, cashYield: 4.1, monthly: 700 }
      : key === "ambitious"
        ? {
            incomeGrowth: 5,
            inflation: 2.6,
            investmentReturn: 8.5,
            cashYield: 4.1,
            monthly: 1000,
          }
        : {
            incomeGrowth: 3.2,
            inflation: 2.6,
            investmentReturn: 6.5,
            cashYield: 4.1,
            monthly: 700,
          };
  const monthly = minorToMajor(
    scenario.assumptions.monthlyInvesting.minorUnits,
    scenario.assumptions.monthlyInvesting.currency,
  );
  const trajectory = forecastHistory.map((row, index) => {
    const base = minorToMajor(row[key], "USD");
    const value = Math.max(
      0,
      base +
        (monthly - defaults.monthly) * 12 * index * (1 + index * 0.025) +
        (scenario.assumptions.investmentReturn - defaults.investmentReturn) * base * index * 0.004 +
        (scenario.assumptions.incomeGrowth - defaults.incomeGrowth) * 180 * index ** 2 -
        (scenario.assumptions.inflation - defaults.inflation) * 110 * index ** 2 +
        (scenario.assumptions.cashYield - defaults.cashYield) * 35 * index ** 2,
    );
    return {
      month: `${2026 + index}-07`,
      liquidCash: modeledMoney(value),
      netWorth: modeledMoney(value),
    };
  });
  const ranges: ApiForecastRangePoint[] = trajectory.map((point, index) => {
    const value = minorToMajor(point.netWorth.minorUnits, point.netWorth.currency);
    const wideSpread = Math.min(0.32, index * 0.04);
    const narrowSpread = wideSpread / 2;
    const range = {
      p10: modeledMoney(value * (1 - wideSpread)),
      p25: modeledMoney(value * (1 - narrowSpread)),
      p50: modeledMoney(value),
      p75: modeledMoney(value * (1 + narrowSpread)),
      p90: modeledMoney(value * (1 + wideSpread)),
    };
    return { month: point.month, netWorth: range, liquidCash: range };
  });
  const ending = trajectory.at(-1) ?? {
    month: "2034-07",
    liquidCash: money("0"),
    netWorth: money("0"),
  };
  const finalRange = ranges.at(-1)?.netWorth ?? {};
  return {
    id: `forecast_${scenario.id}`,
    scenarioId: scenario.id,
    engineVersion: "1.0.0",
    seed: scenario.seed,
    state: "succeeded",
    horizonDate: "2034-07-01",
    liquidNetWorthAtTarget: ending.liquidCash,
    totalNetWorthAtTarget: ending.netWorth,
    lowestCashBalance: money("108400"),
    debtFreeDate: "2028-10-01",
    percentiles: ([10, 25, 50, 75, 90] as const).map((percentile) => ({
      percentile,
      amount: finalRange[`p${percentile}`] ?? ending.netWorth,
    })),
    trajectory,
    monteCarlo: {
      runs: 1000,
      goalSuccessProbability: Math.max(
        0.1,
        Math.min(
          0.95,
          minorToMajor(ending.netWorth.minorUnits, ending.netWorth.currency) / 250_000,
        ),
      ),
      ranges,
    },
    readiness: {
      score: 92,
      missingInputs: ["Confirm the next credit-card statement"],
      confidenceLabel: "High",
    },
    createdAt: "2026-07-16T10:42:00.000Z",
  };
}

export const demoForecasts: CursorPage<ApiForecast> = page(demoScenarios.data.map(demoForecastFor));
