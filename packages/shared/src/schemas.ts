import { z } from "zod";

import { YearMonthSchema } from "./goals.ts";
import { CurrencyCodeSchema, type MinorUnitsStringSchema, MoneyJsonSchema } from "./money.ts";

/**
 * Domain and engine schemas shared across packages and the canonical fixture.
 * These are NOT the HTTP API contract — the API contract is served from
 * /api/v1/openapi.json and pinned to the live route table by
 * apps/api/src/openapi.test.ts. Do not add API envelope or response DTO
 * schemas here; validate domain invariants and engine inputs only.
 */

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, "Expected a ULID");
export const UtcDateTimeSchema = z.string().datetime({ offset: true });
export const DateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

export type MoneyAmountString = z.infer<typeof MinorUnitsStringSchema>;
