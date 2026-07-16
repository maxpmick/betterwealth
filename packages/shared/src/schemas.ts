import { z } from "zod";

import { SafeToSpendJsonSchema } from "./allocation.ts";
import { YearMonthSchema } from "./goals.ts";
import { CurrencyCodeSchema, type MinorUnitsStringSchema, MoneyJsonSchema } from "./money.ts";
import { CategorizationRuleSchema } from "./rules.ts";

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, "Expected a ULID");
export const IdSchema = UlidSchema;
export const UtcDateTimeSchema = z.string().datetime({ offset: true });
export const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ApiErrorSchema = z
  .object({
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    message: z.string().min(1).max(1_000),
    requestId: z.string().min(1).max(128).optional(),
    fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
    retryable: z.boolean().default(false),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ApiMetaSchema = z
  .object({
    requestId: z.string().min(1).max(128).optional(),
    generatedAt: UtcDateTimeSchema.optional(),
  })
  .strict();

export function ApiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, meta: ApiMetaSchema.optional() }).strict();
}

export function ApiFailureSchema() {
  return z.object({ error: ApiErrorSchema }).strict();
}

export function PaginatedResponseSchema<T extends z.ZodType>(item: T) {
  return z
    .object({
      data: z.array(item),
      page: z
        .object({
          cursor: z.string().nullable(),
          nextCursor: z.string().nullable(),
          hasMore: z.boolean(),
          total: z.number().int().nonnegative().optional(),
        })
        .strict(),
      meta: ApiMetaSchema.optional(),
    })
    .strict();
}

export const UserSchema = z
  .object({
    id: UlidSchema,
    email: z.string().email(),
    displayName: z.string().min(1).max(120),
    status: z.enum(["active", "disabled", "pendingDeletion"]),
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .strict();
export type User = z.infer<typeof UserSchema>;

export const HouseholdRoleSchema = z.enum(["owner", "admin", "member", "viewer"]);
export type HouseholdRole = z.infer<typeof HouseholdRoleSchema>;

export const HouseholdSchema = z
  .object({
    id: UlidSchema,
    name: z.string().min(1).max(120),
    baseCurrency: CurrencyCodeSchema,
    locale: z.string().min(2).max(35),
    timezone: z.string().min(1).max(100),
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .strict();
export type Household = z.infer<typeof HouseholdSchema>;

export const SessionSchema = z
  .object({
    id: UlidSchema,
    user: UserSchema,
    household: HouseholdSchema,
    role: HouseholdRoleSchema,
    expiresAt: UtcDateTimeSchema,
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

export const RegisterRequestSchema = z
  .object({
    email: z.string().email().max(320),
    password: z.string().min(12).max(256),
    displayName: z.string().trim().min(1).max(120),
    householdName: z.string().trim().min(1).max(120),
    baseCurrency: CurrencyCodeSchema.default("USD"),
    timezone: z.string().min(1).max(100),
  })
  .strict();
export type RegisterRequest = z.input<typeof RegisterRequestSchema>;

export const LoginRequestSchema = z
  .object({ email: z.string().email().max(320), password: z.string().min(1).max(256) })
  .strict();
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = ApiSuccessSchema(SessionSchema);
export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const AccountTypeSchema = z.enum([
  "checking",
  "savings",
  "cash",
  "creditCard",
  "loan",
  "mortgage",
  "investment",
  "retirement",
  "property",
  "vehicle",
  "otherAsset",
  "otherLiability",
]);
export type AccountType = z.infer<typeof AccountTypeSchema>;

export const AccountSchema = z
  .object({
    id: UlidSchema,
    householdId: UlidSchema,
    connectionId: UlidSchema.nullable(),
    institutionId: z.string().max(128).nullable(),
    name: z.string().min(1).max(160),
    mask: z.string().max(8).nullable(),
    type: AccountTypeSchema,
    subtype: z.string().max(80).nullable(),
    currency: CurrencyCodeSchema,
    currentBalance: MoneyJsonSchema,
    availableBalance: MoneyJsonSchema.nullable(),
    ownership: z.enum(["individual", "joint", "authorized", "unknown"]),
    includeInBudget: z.boolean(),
    includeInNetWorth: z.boolean(),
    archived: z.boolean(),
    lastSyncedAt: UtcDateTimeSchema.nullable(),
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((account, context) => {
    if (account.currentBalance.currency !== account.currency) {
      context.addIssue({
        code: "custom",
        path: ["currentBalance", "currency"],
        message: "Balance currency must match account",
      });
    }
    if (account.availableBalance && account.availableBalance.currency !== account.currency) {
      context.addIssue({
        code: "custom",
        path: ["availableBalance", "currency"],
        message: "Balance currency must match account",
      });
    }
  });
export type Account = z.infer<typeof AccountSchema>;
export const AccountResponseSchema = ApiSuccessSchema(AccountSchema);
export const AccountsResponseSchema = PaginatedResponseSchema(AccountSchema);

export const TransactionStatusSchema = z.enum(["pending", "posted", "stale", "removedUpstream"]);
export const TransactionSourceSchema = z.enum([
  "simplefin",
  "csv",
  "qfx",
  "ofx",
  "manual",
  "system",
]);

export const TransactionSplitSchema = z
  .object({
    id: UlidSchema,
    amount: MoneyJsonSchema,
    categoryId: UlidSchema,
    envelopeId: UlidSchema.nullable(),
    memo: z.string().max(500).nullable(),
  })
  .strict();
export type TransactionSplitDto = z.infer<typeof TransactionSplitSchema>;

export const TransactionSchema = z
  .object({
    id: UlidSchema,
    householdId: UlidSchema,
    accountId: UlidSchema,
    externalId: z.string().max(256).nullable(),
    amount: MoneyJsonSchema,
    postedDate: DateOnlySchema,
    authorizedDate: DateOnlySchema.nullable(),
    rawDescription: z.string().min(1).max(2_000),
    normalizedDescription: z.string().min(1).max(1_000),
    merchantId: UlidSchema.nullable(),
    merchantName: z.string().max(256).nullable(),
    categoryId: UlidSchema.nullable(),
    envelopeId: UlidSchema.nullable(),
    status: TransactionStatusSchema,
    source: TransactionSourceSchema,
    needsReview: z.boolean(),
    excludedFromBudget: z.boolean(),
    excludedFromReports: z.boolean(),
    isTransfer: z.boolean(),
    isIncome: z.boolean(),
    transferId: UlidSchema.nullable(),
    refundTransactionId: UlidSchema.nullable(),
    recurringSeriesId: UlidSchema.nullable(),
    note: z.string().max(5_000).nullable(),
    tagIds: z.array(UlidSchema).max(100),
    splits: z.array(TransactionSplitSchema).max(100),
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((transaction, context) => {
    for (const [index, split] of transaction.splits.entries()) {
      if (split.amount.currency !== transaction.amount.currency) {
        context.addIssue({
          code: "custom",
          path: ["splits", index, "amount", "currency"],
          message: "Split currency must match transaction",
        });
      }
    }
    if (transaction.splits.length > 0) {
      const splitTotal = transaction.splits.reduce(
        (sum, split) => sum + BigInt(split.amount.minorUnits),
        0n,
      );
      if (splitTotal !== BigInt(transaction.amount.minorUnits)) {
        context.addIssue({
          code: "custom",
          path: ["splits"],
          message: "Splits must sum exactly to the transaction",
        });
      }
    }
  });
export type Transaction = z.infer<typeof TransactionSchema>;

export const TransactionResponseSchema = ApiSuccessSchema(TransactionSchema);
export const TransactionsResponseSchema = PaginatedResponseSchema(TransactionSchema);
export const TransactionListResponseSchema = TransactionsResponseSchema;

export const CategorySchema = z
  .object({
    id: UlidSchema,
    householdId: UlidSchema,
    parentId: UlidSchema.nullable(),
    name: z.string().min(1).max(120),
    kind: z.enum(["income", "expense", "transfer"]),
    color: z
      .string()
      .regex(/^#[0-9A-F]{6}$/i)
      .nullable(),
    icon: z.string().max(80).nullable(),
    active: z.boolean(),
    system: z.boolean(),
  })
  .strict();
export type Category = z.infer<typeof CategorySchema>;

export const EnvelopeSchema = z
  .object({
    id: UlidSchema,
    householdId: UlidSchema,
    parentId: UlidSchema.nullable(),
    categoryId: UlidSchema.nullable(),
    name: z.string().min(1).max(120),
    cadence: z.enum(["payCycle", "monthly", "annual"]),
    rolloverPolicy: z.enum(["none", "positive", "full"]),
    priority: z.number().int(),
    priorityClass: z.enum([
      "requiredBills",
      "minimumDebt",
      "coreLiving",
      "buffer",
      "goals",
      "investing",
      "flexible",
    ]),
    minimum: MoneyJsonSchema,
    target: MoneyJsonSchema,
    planned: MoneyJsonSchema,
    funded: MoneyJsonSchema,
    activity: MoneyJsonSchema,
    available: MoneyJsonSchema,
    archived: z.boolean(),
  })
  .strict();
export type Envelope = z.infer<typeof EnvelopeSchema>;

export const BudgetPeriodSchema = z
  .object({
    id: UlidSchema,
    householdId: UlidSchema,
    cadence: z.enum(["payCycle", "monthly"]),
    startsOn: DateOnlySchema,
    endsOn: DateOnlySchema,
    status: z.enum(["planned", "open", "closed"]),
    expectedIncome: MoneyJsonSchema,
    actualIncome: MoneyJsonSchema,
    unassigned: MoneyJsonSchema,
    envelopes: z.array(EnvelopeSchema),
  })
  .strict();
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;
export const BudgetResponseSchema = ApiSuccessSchema(BudgetPeriodSchema);

export const GoalTypeSchema = z.enum([
  "emergencyFund",
  "purchase",
  "debtFree",
  "retirement",
  "netWorth",
  "custom",
]);
export const GoalSchema = z
  .object({
    id: UlidSchema,
    householdId: UlidSchema,
    name: z.string().min(1).max(160),
    type: GoalTypeSchema,
    priority: z.number().int(),
    currentAmount: MoneyJsonSchema,
    targetAmount: MoneyJsonSchema,
    targetDate: DateOnlySchema.nullable(),
    monthlyContribution: MoneyJsonSchema,
    status: z.enum(["active", "paused", "achieved", "archived"]),
    linkedAccountIds: z.array(UlidSchema),
    bufferPolicy: z.enum(["none", "emergencyFloor", "custom"]),
    customBuffer: MoneyJsonSchema.nullable(),
    createdAt: UtcDateTimeSchema,
    updatedAt: UtcDateTimeSchema,
  })
  .strict();
export type Goal = z.infer<typeof GoalSchema>;
export const GoalResponseSchema = ApiSuccessSchema(GoalSchema);
export const GoalsResponseSchema = PaginatedResponseSchema(GoalSchema);

export const RuleSchema = CategorizationRuleSchema;
export type Rule = z.infer<typeof RuleSchema>;
export const RuleResponseSchema = ApiSuccessSchema(RuleSchema);
export const RulesResponseSchema = PaginatedResponseSchema(RuleSchema);

export const ForecastAccountJsonSchema = z
  .object({
    id: UlidSchema,
    name: z.string().max(160).optional(),
    type: z.enum(["checking", "savings", "investment", "retirement", "asset"]),
    balance: MoneyJsonSchema,
    liquid: z.boolean(),
    annualReturnBps: z.number().int().min(-10_000).max(1_000_000).optional(),
    assetClass: z.string().min(1).max(80).optional(),
  })
  .strict();

export const ForecastScenarioSchema = z
  .object({
    id: UlidSchema.optional(),
    name: z.string().max(160).optional(),
    startMonth: YearMonthSchema,
    horizonMonths: z.number().int().min(0).max(1_200),
    baseCurrency: CurrencyCodeSchema,
    primaryCashAccountId: UlidSchema,
    minimumCashBuffer: MoneyJsonSchema.optional(),
    accounts: z.array(ForecastAccountJsonSchema).min(1),
    cashFlows: z.array(
      z
        .object({
          id: UlidSchema,
          name: z.string().max(160).optional(),
          kind: z.enum(["income", "bill", "envelope"]),
          amount: MoneyJsonSchema,
          accountId: UlidSchema.optional(),
          startMonth: YearMonthSchema.optional(),
          endMonth: YearMonthSchema.optional(),
          annualGrowthBps: z.number().int().min(-10_000).max(1_000_000).optional(),
          required: z.boolean().optional(),
        })
        .strict(),
    ),
    debts: z
      .array(
        z
          .object({
            id: UlidSchema,
            name: z.string().max(160).optional(),
            principal: MoneyJsonSchema,
            annualInterestBps: z.number().int().min(0).max(1_000_000),
            minimumPayment: MoneyJsonSchema,
            extraPayment: MoneyJsonSchema.optional(),
            paymentAccountId: UlidSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    contributions: z
      .array(
        z
          .object({
            id: UlidSchema,
            name: z.string().max(160).optional(),
            kind: z.enum(["goal", "investment"]),
            amount: MoneyJsonSchema,
            fromAccountId: UlidSchema.optional(),
            toAccountId: UlidSchema,
            priority: z.number().int(),
            required: z.boolean().optional(),
            startMonth: YearMonthSchema.optional(),
            endMonth: YearMonthSchema.optional(),
            targetAmount: MoneyJsonSchema.optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ForecastScenarioDto = z.infer<typeof ForecastScenarioSchema>;

export const ForecastMonthSchema = z
  .object({
    index: z.number().int().nonnegative(),
    month: YearMonthSchema,
    accountBalances: z.record(z.string(), MoneyJsonSchema),
    debts: z.array(
      z
        .object({
          id: z.string().min(1).max(128),
          principal: MoneyJsonSchema,
          interest: MoneyJsonSchema,
          payment: MoneyJsonSchema,
          paidOff: z.boolean(),
        })
        .strict(),
    ),
    contributions: z.array(
      z
        .object({
          id: z.string().min(1).max(128),
          requested: MoneyJsonSchema,
          contributed: MoneyJsonSchema,
          shortfall: MoneyJsonSchema,
        })
        .strict(),
    ),
    income: MoneyJsonSchema,
    requiredOutflows: MoneyJsonSchema,
    debtPayments: MoneyJsonSchema,
    goalAndInvestmentContributions: MoneyJsonSchema,
    unmetRequired: MoneyJsonSchema,
    liquidCash: MoneyJsonSchema,
    investableAssets: MoneyJsonSchema,
    totalAssets: MoneyJsonSchema,
    totalDebt: MoneyJsonSchema,
    netWorth: MoneyJsonSchema,
    primaryCashLow: MoneyJsonSchema,
  })
  .strict();

export const ForecastRunSchema = z
  .object({
    engineVersion: z.string().min(1),
    inputHash: z.string().regex(/^[0-9a-f]{16}$/),
    baseCurrency: CurrencyCodeSchema,
    startMonth: YearMonthSchema,
    horizonMonths: z.number().int().nonnegative(),
    months: z.array(ForecastMonthSchema).min(1),
    debtFreeMonth: YearMonthSchema.nullable(),
  })
  .strict();
export const ForecastResponseSchema = ApiSuccessSchema(ForecastRunSchema);

export const MonteCarloRunSchema = z
  .object({
    engineVersion: z.string().min(1),
    seed: z.string(),
    runs: z.number().int().positive().max(10_000),
    percentiles: z.array(z.number().int().min(0).max(100)).min(1),
    months: z.array(
      z
        .object({
          month: YearMonthSchema,
          netWorth: z.record(z.string().regex(/^p(?:100|\d{1,2})$/), MoneyJsonSchema),
          liquidCash: z.record(z.string().regex(/^p(?:100|\d{1,2})$/), MoneyJsonSchema),
        })
        .strict(),
    ),
    goalSuccessProbability: z.number().min(0).max(1).nullable(),
    goalSuccessBasisPoints: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();
export const MonteCarloResponseSchema = ApiSuccessSchema(MonteCarloRunSchema);

export const UpcomingBillSchema = z
  .object({
    id: UlidSchema,
    name: z.string().min(1).max(160),
    dueDate: DateOnlySchema,
    amount: MoneyJsonSchema,
    funded: z.boolean(),
    autopayAccountId: UlidSchema.nullable(),
  })
  .strict();

export const DashboardReportSchema = z
  .object({
    asOf: UtcDateTimeSchema,
    currency: CurrencyCodeSchema,
    safeToSpend: SafeToSpendJsonSchema,
    netWorth: MoneyJsonSchema,
    netWorthChange: MoneyJsonSchema,
    liquidCash: MoneyJsonSchema,
    nextPaycheckDate: DateOnlySchema.nullable(),
    runwayDays: z.number().int().nonnegative().nullable(),
    envelopeSummary: z
      .object({
        onTrack: z.number().int().nonnegative(),
        atRisk: z.number().int().nonnegative(),
        overspent: z.number().int().nonnegative(),
        available: MoneyJsonSchema,
      })
      .strict(),
    upcomingBills: z.array(UpcomingBillSchema),
    recentTransactions: z.array(TransactionSchema),
    weeklyAction: z
      .object({
        id: z.string().min(1).max(128),
        kind: z.enum(["review", "fund", "save", "payDebt", "reduceSpending", "none"]),
        title: z.string().min(1).max(160),
        rationale: z.string().min(1).max(1_000),
        amount: MoneyJsonSchema.nullable(),
      })
      .strict(),
    forecast: z
      .object({
        endingNetWorth: MoneyJsonSchema,
        targetNetWorth: MoneyJsonSchema.nullable(),
        onTrack: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();
export type DashboardReport = z.infer<typeof DashboardReportSchema>;
export const DashboardResponseSchema = ApiSuccessSchema(DashboardReportSchema);

export const NetWorthReportSchema = z
  .object({
    currency: CurrencyCodeSchema,
    from: DateOnlySchema,
    to: DateOnlySchema,
    points: z.array(
      z
        .object({
          date: DateOnlySchema,
          assets: MoneyJsonSchema,
          liabilities: MoneyJsonSchema,
          netWorth: MoneyJsonSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type NetWorthReport = z.infer<typeof NetWorthReportSchema>;

export const CashFlowReportSchema = z
  .object({
    currency: CurrencyCodeSchema,
    from: DateOnlySchema,
    to: DateOnlySchema,
    periods: z.array(
      z
        .object({
          month: YearMonthSchema,
          income: MoneyJsonSchema,
          spending: MoneyJsonSchema,
          debtPayments: MoneyJsonSchema,
          savings: MoneyJsonSchema,
          netCashFlow: MoneyJsonSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type CashFlowReport = z.infer<typeof CashFlowReportSchema>;

export const SpendingReportSchema = z
  .object({
    currency: CurrencyCodeSchema,
    from: DateOnlySchema,
    to: DateOnlySchema,
    total: MoneyJsonSchema,
    byCategory: z.array(
      z
        .object({
          categoryId: UlidSchema.nullable(),
          categoryName: z.string().min(1),
          amount: MoneyJsonSchema,
          transactionCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
export type SpendingReport = z.infer<typeof SpendingReportSchema>;

export const HealthResponseSchema = z
  .object({
    status: z.enum(["ok", "degraded"]),
    version: z.string().min(1),
    time: UtcDateTimeSchema,
    checks: z.record(z.string(), z.enum(["ok", "degraded", "down"])),
  })
  .strict();

export const IdempotencyKeySchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const CursorSchema = z.string().min(1).max(1_024);
export const LimitSchema = z.coerce.number().int().min(1).max(250).default(50);

export type MoneyAmountString = z.infer<typeof MinorUnitsStringSchema>;
