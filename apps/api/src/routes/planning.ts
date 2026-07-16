import { type BetterWealthDatabase, splitEncryptedPayload } from "@betterwealth/db";
import {
  accounts,
  allocationEntries,
  assets,
  assetValuations,
  balanceSnapshots,
  bills,
  budgetPeriods,
  categories,
  envelopeAllocations,
  envelopeCategoryLinks,
  envelopes,
  forecastRuns,
  forecastScenarios,
  goalContributions,
  goals,
  households,
  importRuns,
  incomeSources,
  type JsonObject,
  jobs,
  merchants,
  rawImportRecords,
  refundLinks,
  ruleRuns,
  rules,
  settings,
  tags,
  transactionSplits,
  transactions,
  transactionTags,
  users,
} from "@betterwealth/db/schema";
import {
  type CategorizationRule,
  CategorizationRuleSchema,
  deriveGoalPace,
  divideAndRound,
  evaluateRules,
  type ForecastScenario,
  ForecastScenarioSchema,
  forecastResultToJson,
  MinorUnitsStringSchema,
  MoneyJsonSchema,
  money,
  moneyFromJson,
  monteCarloResultToJson,
  parseDecimalToMinorUnits,
  projectGoal,
  RuleActionSchema,
  RuleConditionSchema,
  type RuleTransaction,
  ruleSpecificity,
  runForecast,
  runMonteCarlo,
  transactionRulePatchToJson,
} from "@betterwealth/shared";
import { and, asc, desc, eq, gte, inArray, lte, or } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../auth/middleware";
import { categorizeHouseholdTransactions } from "../categorization/service";
import type { AppConfig } from "../config";
import { parseTransactionFile } from "../imports/parsers";
import { FieldCipher, sha256 } from "../lib/crypto";
import { AppError, ConflictError, NotFoundError } from "../lib/errors";
import { normalizeDescription, transactionFingerprint } from "../sync/reconcile";
import type { AppEnv } from "../types";

type MoneyJson = { minorUnits: string; currency: string };

const dateSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.slice(0, 10) : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
);
const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{2,11}$/)
  .transform((value) => value.toUpperCase());
const minorUnitsSchema = MinorUnitsStringSchema;
const positiveMinorUnitsSchema = minorUnitsSchema.refine((value) => BigInt(value) > 0n);
const nonNegativeMoneyJsonSchema = MoneyJsonSchema.refine(
  (value) => BigInt(value.minorUnits) >= 0n,
  "Asset values cannot be negative",
);

const planningForecastPreferencesSchema = z
  .object({
    minimumBufferMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    targetLiquidNetWorthMinorUnits: minorUnitsSchema
      .refine((value) => BigInt(value) > 0n)
      .optional(),
  })
  .passthrough();

const envelopeCadenceConfigSchema = z
  .object({
    monthlyAmountMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    paychecksPerYear: z.number().int().min(1).max(366).optional(),
  })
  .passthrough();

function normalizedCadence(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function cadencePeriodsPerYear(value: string, payCycleFallback = 12): number {
  switch (normalizedCadence(value)) {
    case "weekly":
      return 52;
    case "biweekly":
    case "fortnightly":
      return 26;
    case "semimonthly":
    case "twicemonthly":
      return 24;
    case "quarterly":
      return 4;
    case "annual":
    case "annually":
    case "yearly":
      return 1;
    case "paycycle":
    case "paycheck":
    case "perpaycheck":
      return payCycleFallback;
    default:
      return 12;
  }
}

function averageMonthlyAmount(amount: bigint, cadence: string, payCycleFallback = 12): bigint {
  return divideAndRound(
    amount * BigInt(cadencePeriodsPerYear(cadence, payCycleFallback)),
    12n,
    "half-even",
  );
}

function averageMonthlyEnvelopeAmount(
  envelope: typeof envelopes.$inferSelect,
  payCycleFallback: number,
) {
  const config = envelopeCadenceConfigSchema.safeParse(envelope.cadenceConfig);
  if (config.success && config.data.monthlyAmountMinorUnits !== undefined) {
    return BigInt(config.data.monthlyAmountMinorUnits);
  }
  return averageMonthlyAmount(
    envelope.targetAmount,
    envelope.cadence,
    config.success ? (config.data.paychecksPerYear ?? payCycleFallback) : payCycleFallback,
  );
}

function cadenceFromDueRule(value: unknown) {
  const parsed = z
    .object({ cadence: z.string().trim().min(1).max(80) })
    .passthrough()
    .safeParse(value);
  return parsed.success ? parsed.data.cadence : "monthly";
}

async function loadPlanningForecastDefaults(db: BetterWealthDatabase, householdId: string) {
  const [household, preferenceRow] = await Promise.all([
    db
      .select({ currency: households.baseCurrency })
      .from(households)
      .where(eq(households.id, householdId))
      .get(),
    db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.householdId, householdId),
          eq(settings.scopeKey, "household"),
          eq(settings.key, "planning.safe_to_spend"),
        ),
      )
      .get(),
  ]);
  const preferences = planningForecastPreferencesSchema.safeParse(preferenceRow?.value);
  return {
    currency: household?.currency,
    preferences: preferences.success ? preferences.data : {},
  };
}

async function defaultForecastHorizonMonths(
  db: BetterWealthDatabase,
  userId: string,
  now = new Date(),
) {
  const profile = await db
    .select({ birthDate: users.birthDate, targetAge: users.targetAge })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(profile?.birthDate ?? "");
  if (!match || profile?.targetAge === null || profile?.targetAge === undefined) return 96;
  const targetYear = Number(match[1]) + profile.targetAge;
  const targetMonth = Number(match[2]) - 1;
  const months = targetYear * 12 + targetMonth - (now.getUTCFullYear() * 12 + now.getUTCMonth());
  return Math.max(1, Math.min(1_200, months));
}

function moneyJson(minorUnits: bigint, currency: string): MoneyJson {
  return { minorUnits: minorUnits.toString(), currency };
}

function page<T>(data: T[]) {
  return { data, page: { cursor: null, hasMore: false } };
}

function nowIso() {
  return new Date().toISOString();
}

function dbJson(value: unknown): JsonObject {
  return value as JsonObject;
}

function dbJsonOrNull(value: unknown): JsonObject | null {
  return value === null ? null : dbJson(value);
}

function startOfCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function optionalMoney(
  value: { minorUnits: string; currency: string } | undefined,
  fallbackMinor: string | undefined,
  fallbackCurrency: string,
) {
  if (value) return { minor: BigInt(value.minorUnits), currency: value.currency };
  return { minor: BigInt(fallbackMinor ?? "0"), currency: fallbackCurrency };
}

async function requireAccount(db: BetterWealthDatabase, householdId: string, accountId: string) {
  const account = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.id, accountId)))
    .get();
  if (!account) throw new NotFoundError("Account");
  return account;
}

async function requireEnvelope(db: BetterWealthDatabase, householdId: string, envelopeId: string) {
  const envelope = await db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.householdId, householdId), eq(envelopes.id, envelopeId)))
    .get();
  if (!envelope) throw new NotFoundError("Envelope");
  return envelope;
}

async function requireCategories(
  db: BetterWealthDatabase,
  householdId: string,
  categoryIds: readonly string[],
) {
  const uniqueIds = [...new Set(categoryIds)];
  if (!uniqueIds.length) return;
  const rows = await db
    .select({ id: categories.id })
    .from(categories)
    .where(and(eq(categories.householdId, householdId), inArray(categories.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) throw new NotFoundError("Category");
}

async function requireBudgetPeriod(
  db: BetterWealthDatabase,
  householdId: string,
  periodId: string,
) {
  const period = await db
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.householdId, householdId), eq(budgetPeriods.id, periodId)))
    .get();
  if (!period) throw new NotFoundError("Budget period");
  return period;
}

const envelopeCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    parentId: z.string().optional(),
    categoryId: z.string().nullable().optional(),
    categoryIds: z.array(z.string()).max(50).optional(),
    cadence: z.string().trim().min(1).max(80).default("monthly"),
    cadenceConfig: z.unknown().optional(),
    rolloverPolicy: z.enum(["none", "positive", "all", "cap", "monthly_reset"]).default("positive"),
    rolloverCapMinorUnits: minorUnitsSchema.optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
    minimumAmountMinorUnits: minorUnitsSchema.default("0"),
    targetAmountMinorUnits: minorUnitsSchema.default("0"),
    planned: MoneyJsonSchema.optional(),
    funded: MoneyJsonSchema.optional(),
    pacing: z.enum(["on_track", "watch", "over"]).optional(),
    currency: currencySchema.default("USD"),
    isRequired: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.rolloverPolicy === "cap" && input.rolloverCapMinorUnits === undefined) {
      context.addIssue({
        code: "custom",
        path: ["rolloverCapMinorUnits"],
        message: "A rollover cap is required for capped envelopes",
      });
    }
  });

const envelopePatchSchema = z.object(envelopeCreateSchema.shape).partial().strict();

function dbRolloverPolicy(
  policy: z.infer<typeof envelopeCreateSchema>["rolloverPolicy"],
): "none" | "positive" | "all" | "cap" {
  return policy === "monthly_reset" ? "none" : policy;
}

function standaloneEnvelopeDto(
  row: typeof envelopes.$inferSelect,
  linkedCategoryIds: readonly string[] = row.categoryId ? [row.categoryId] : [],
) {
  const categoryIds = [
    ...new Set([...(row.categoryId ? [row.categoryId] : []), ...linkedCategoryIds]),
  ];
  return {
    id: row.id,
    name: row.name,
    planned: moneyJson(row.targetAmount, row.currency),
    funded: moneyJson(0n, row.currency),
    activity: moneyJson(0n, row.currency),
    available: moneyJson(0n, row.currency),
    cadence: row.cadence,
    pacing: "on_track" as const,
    rolloverPolicy: row.rolloverPolicy,
    parentId: row.parentId,
    categoryId: row.categoryId,
    categoryIds,
    priority: row.priority,
    minimumAmount: moneyJson(row.minimumAmount, row.currency),
    targetAmount: moneyJson(row.targetAmount, row.currency),
    isRequired: row.isRequired,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const budgetWriteSchema = z
  .object({
    periodKind: z.enum(["pay_cycle", "month", "plan"]).optional(),
    kind: z.enum(["pay_cycle", "month", "custom"]).optional(),
    startDate: dateSchema.optional(),
    startsOn: dateSchema.optional(),
    endDate: dateSchema.optional(),
    endsOn: dateSchema.optional(),
    plannedIncome: MoneyJsonSchema.optional(),
    funded: MoneyJsonSchema.optional(),
    spent: MoneyJsonSchema.optional(),
    remaining: MoneyJsonSchema.optional(),
    unassigned: MoneyJsonSchema.optional(),
    expectedIncomeMinorUnits: minorUnitsSchema.optional(),
    actualIncome: MoneyJsonSchema.optional(),
    actualIncomeMinorUnits: minorUnitsSchema.optional(),
    currency: currencySchema.optional(),
    status: z.enum(["draft", "planned", "open", "closed", "archived"]).optional(),
    payCycleId: z.string().optional(),
    envelopes: z
      .array(
        z.object({
          id: z.string(),
          planned: MoneyJsonSchema.optional(),
          plannedMinorUnits: minorUnitsSchema.optional(),
          funded: MoneyJsonSchema.optional(),
          fundedMinorUnits: minorUnitsSchema.optional(),
        }),
      )
      .max(500)
      .optional(),
  })
  .strict();

const monthlyPlanSchema = z
  .object({
    paychecksPerYear: z.union([z.literal(12), z.literal(24), z.literal(26), z.literal(52)]),
    monthlyIncome: MoneyJsonSchema.optional(),
    items: z
      .array(
        z
          .object({
            name: z.string().trim().min(1).max(160),
            monthlyAmount: MoneyJsonSchema,
            categoryId: z.string().nullable().optional(),
            priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
            isRequired: z.boolean().default(false),
            rolloverPolicy: z.enum(["none", "positive", "all", "cap"]).default("positive"),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((input, context) => {
    const names = new Set<string>();
    for (const [index, item] of input.items.entries()) {
      const key = item.name.toLocaleLowerCase();
      if (names.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "name"],
          message: "Envelope names must be unique",
        });
      }
      names.add(key);
      if (BigInt(item.monthlyAmount.minorUnits) < 0n) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "monthlyAmount"],
          message: "Monthly spending cannot be negative",
        });
      }
    }
    if (input.monthlyIncome && BigInt(input.monthlyIncome.minorUnits) < 0n) {
      context.addIssue({
        code: "custom",
        path: ["monthlyIncome"],
        message: "Monthly income cannot be negative",
      });
    }
  });

function monthlyToPaycheck(monthlyMinorUnits: bigint, paychecksPerYear: 12 | 24 | 26 | 52) {
  const annual = monthlyMinorUnits * 12n;
  const divisor = BigInt(paychecksPerYear);
  return (annual + divisor / 2n) / divisor;
}

const allocationWriteSchema = z
  .object({
    envelopeId: z.string(),
    planned: MoneyJsonSchema.optional(),
    plannedMinorUnits: minorUnitsSchema.optional(),
    funded: MoneyJsonSchema.optional(),
    fundedMinorUnits: minorUnitsSchema.optional(),
    activityMinorUnits: minorUnitsSchema.optional(),
    transferredInMinorUnits: minorUnitsSchema.optional(),
    transferredOutMinorUnits: minorUnitsSchema.optional(),
  })
  .strict();

function normalizePeriodStatus(status: z.infer<typeof budgetWriteSchema>["status"]) {
  return status === "planned" ? ("draft" as const) : status;
}

async function budgetDtos(db: BetterWealthDatabase, householdId: string, requestedId?: string) {
  const periods = await db
    .select()
    .from(budgetPeriods)
    .where(
      and(
        eq(budgetPeriods.householdId, householdId),
        requestedId ? eq(budgetPeriods.id, requestedId) : undefined,
      ),
    )
    .orderBy(desc(budgetPeriods.startsOn), desc(budgetPeriods.id));
  const ids = periods.map((period) => period.id);
  const allocationRows = ids.length
    ? await db
        .select({ allocation: envelopeAllocations, envelope: envelopes })
        .from(envelopeAllocations)
        .innerJoin(envelopes, eq(envelopes.id, envelopeAllocations.envelopeId))
        .where(
          and(
            eq(envelopeAllocations.householdId, householdId),
            eq(envelopes.householdId, householdId),
            inArray(envelopeAllocations.budgetPeriodId, ids),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name))
    : [];
  const activeEnvelopes = await db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.householdId, householdId), eq(envelopes.isActive, true)))
    .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
  const linkRows = await db
    .select()
    .from(envelopeCategoryLinks)
    .where(eq(envelopeCategoryLinks.householdId, householdId));
  const categoryIdsByEnvelope = new Map<string, string[]>();
  for (const link of linkRows) {
    const values = categoryIdsByEnvelope.get(link.envelopeId) ?? [];
    values.push(link.categoryId);
    categoryIdsByEnvelope.set(link.envelopeId, values);
  }
  const byPeriod = new Map<string, typeof allocationRows>();
  for (const item of allocationRows) {
    const items = byPeriod.get(item.allocation.budgetPeriodId) ?? [];
    items.push(item);
    byPeriod.set(item.allocation.budgetPeriodId, items);
  }
  return Promise.all(
    periods.map(async (period) => {
      const persisted = byPeriod.get(period.id) ?? [];
      const persistedIds = new Set(persisted.map((item) => item.envelope.id));
      const items: Array<{
        allocation: typeof envelopeAllocations.$inferSelect | null;
        envelope: typeof envelopes.$inferSelect;
      }> = [...persisted];
      if (period.status === "open" || period.status === "draft") {
        for (const envelope of activeEnvelopes) {
          if (envelope.currency === period.currency && !persistedIds.has(envelope.id)) {
            items.push({ allocation: null, envelope });
          }
        }
      }
      items.sort(
        (left, right) =>
          Number(right.envelope.isRequired) - Number(left.envelope.isRequired) ||
          right.envelope.priority - left.envelope.priority ||
          left.envelope.name.localeCompare(right.envelope.name),
      );
      const activityByEnvelope = await calculateBudgetActivity(
        db,
        householdId,
        period,
        items.map((item) => item.envelope),
        linkRows,
      );
      const funded = items.reduce((sum, item) => sum + (item.allocation?.funded ?? 0n), 0n);
      const totalPlanned = items.reduce(
        (sum, item) => sum + (item.allocation?.planned ?? item.envelope.targetAmount),
        0n,
      );
      const spent = items.reduce((sum, item) => {
        const activity = activityByEnvelope.get(item.envelope.id) ?? 0n;
        return sum + (activity < 0n ? -activity : 0n);
      }, 0n);
      const remaining = items.reduce((sum, item) => {
        const allocation = item.allocation;
        const activity = activityByEnvelope.get(item.envelope.id) ?? 0n;
        return (
          sum +
          (allocation?.funded ?? 0n) +
          activity +
          (allocation?.transferredIn ?? 0n) -
          (allocation?.transferredOut ?? 0n)
        );
      }, 0n);
      return {
        id: period.id,
        periodKind:
          period.kind === "month"
            ? ("month" as const)
            : period.kind === "pay_cycle"
              ? ("pay_cycle" as const)
              : ("plan" as const),
        startDate: period.startsOn,
        endDate: period.endsOn,
        plannedIncome: moneyJson(period.expectedIncome, period.currency),
        actualIncome: moneyJson(period.actualIncome, period.currency),
        funded: moneyJson(funded, period.currency),
        spent: moneyJson(spent, period.currency),
        remaining: moneyJson(remaining, period.currency),
        unassigned: moneyJson(period.expectedIncome - funded, period.currency),
        totalPlanned: moneyJson(totalPlanned, period.currency),
        surplus: moneyJson(period.expectedIncome - totalPlanned, period.currency),
        status: period.status === "draft" ? "planned" : period.status,
        envelopes: items.map(({ allocation, envelope }) => {
          const planned = allocation?.planned ?? envelope.targetAmount;
          const fundedAmount = allocation?.funded ?? 0n;
          const activity = activityByEnvelope.get(envelope.id) ?? 0n;
          const transferredIn = allocation?.transferredIn ?? 0n;
          const transferredOut = allocation?.transferredOut ?? 0n;
          const available = fundedAmount + activity + transferredIn - transferredOut;
          const envelopeSpent = activity < 0n ? -activity : 0n;
          const pacing =
            available < 0n
              ? ("over" as const)
              : planned > 0n && envelopeSpent * 100n >= planned * 80n
                ? ("watch" as const)
                : ("on_track" as const);
          return {
            id: envelope.id,
            name: envelope.name,
            planned: moneyJson(planned, period.currency),
            funded: moneyJson(fundedAmount, period.currency),
            activity: moneyJson(activity, period.currency),
            available: moneyJson(available, period.currency),
            transferredIn: moneyJson(transferredIn, period.currency),
            transferredOut: moneyJson(transferredOut, period.currency),
            cadence: envelope.cadence,
            pacing,
            rolloverPolicy: envelope.rolloverPolicy,
            parentId: envelope.parentId,
            categoryId: envelope.categoryId,
            categoryIds: [
              ...new Set([
                ...(envelope.categoryId ? [envelope.categoryId] : []),
                ...(categoryIdsByEnvelope.get(envelope.id) ?? []),
              ]),
            ],
            priority: envelope.priority,
            minimumAmount: moneyJson(envelope.minimumAmount, envelope.currency),
            targetAmount: moneyJson(envelope.targetAmount, envelope.currency),
            isRequired: envelope.isRequired,
            isActive: envelope.isActive,
          };
        }),
      };
    }),
  );
}

type BudgetActivityPiece = {
  sequence: number;
  amount: bigint;
  envelopeId: string | null;
  categoryId: string | null;
};

async function calculateBudgetActivity(
  db: BetterWealthDatabase,
  householdId: string,
  period: typeof budgetPeriods.$inferSelect,
  periodEnvelopes: readonly (typeof envelopes.$inferSelect)[],
  linkRows?: readonly (typeof envelopeCategoryLinks.$inferSelect)[],
) {
  const activity = new Map<string, bigint>();
  const eligibleEnvelopeIds = new Set(periodEnvelopes.map((envelope) => envelope.id));
  const links =
    linkRows ??
    (await db
      .select()
      .from(envelopeCategoryLinks)
      .where(eq(envelopeCategoryLinks.householdId, householdId)));
  const envelopeById = new Map(periodEnvelopes.map((envelope) => [envelope.id, envelope]));
  const byCategory = new Map<string, string[]>();
  for (const link of links) {
    if (!eligibleEnvelopeIds.has(link.envelopeId)) continue;
    const values = byCategory.get(link.categoryId) ?? [];
    values.push(link.envelopeId);
    byCategory.set(link.categoryId, values);
  }
  for (const envelope of periodEnvelopes) {
    if (!envelope.categoryId) continue;
    const values = byCategory.get(envelope.categoryId) ?? [];
    if (!values.includes(envelope.id)) values.push(envelope.id);
    byCategory.set(envelope.categoryId, values);
  }
  for (const values of byCategory.values()) {
    values.sort((left, right) => {
      const leftEnvelope = envelopeById.get(left)!;
      const rightEnvelope = envelopeById.get(right)!;
      return (
        Number(rightEnvelope.isRequired) - Number(leftEnvelope.isRequired) ||
        rightEnvelope.priority - leftEnvelope.priority ||
        left.localeCompare(right)
      );
    });
  }
  const resolveEnvelope = (envelopeId: string | null, categoryId: string | null) => {
    if (envelopeId && eligibleEnvelopeIds.has(envelopeId)) return envelopeId;
    return categoryId ? (byCategory.get(categoryId)?.[0] ?? null) : null;
  };
  const currentTransactions = await db
    .select()
    .from(transactions)
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(transactions.status, "posted"),
        eq(transactions.isExcluded, false),
        eq(transactions.isTransfer, false),
        eq(transactions.isIncome, false),
        eq(transactions.currency, period.currency),
        gte(transactions.transactedOn, period.startsOn),
        lte(transactions.transactedOn, period.endsOn),
      ),
    );
  const currentIds = currentTransactions.map((transaction) => transaction.id);
  const confirmedRefunds = currentIds.length
    ? await db
        .select()
        .from(refundLinks)
        .where(
          and(
            eq(refundLinks.householdId, householdId),
            eq(refundLinks.status, "confirmed"),
            inArray(refundLinks.refundTransactionId, currentIds),
          ),
        )
        .orderBy(asc(refundLinks.createdAt), asc(refundLinks.id))
    : [];
  const purchaseIds = [...new Set(confirmedRefunds.map((link) => link.purchaseTransactionId))];
  const purchaseRows = purchaseIds.length
    ? await db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.householdId, householdId), inArray(transactions.id, purchaseIds)),
        )
    : [];
  const transactionById = new Map(
    [...currentTransactions, ...purchaseRows].map((transaction) => [transaction.id, transaction]),
  );
  const allIds = [...transactionById.keys()];
  const splitRows = allIds.length
    ? await db
        .select()
        .from(transactionSplits)
        .where(
          and(
            eq(transactionSplits.householdId, householdId),
            inArray(transactionSplits.transactionId, allIds),
          ),
        )
        .orderBy(asc(transactionSplits.sequence), asc(transactionSplits.id))
    : [];
  const splitsByTransaction = new Map<string, BudgetActivityPiece[]>();
  for (const split of splitRows) {
    const values = splitsByTransaction.get(split.transactionId) ?? [];
    values.push({
      sequence: split.sequence,
      amount: split.amount,
      envelopeId: split.envelopeId,
      categoryId: split.categoryId,
    });
    splitsByTransaction.set(split.transactionId, values);
  }
  const piecesFor = (transaction: typeof transactions.$inferSelect): BudgetActivityPiece[] =>
    splitsByTransaction.get(transaction.id) ?? [
      {
        sequence: 0,
        amount: transaction.amount,
        envelopeId: transaction.envelopeId,
        categoryId: transaction.categoryId,
      },
    ];
  const addActivity = (envelopeId: string, amount: bigint) => {
    activity.set(envelopeId, (activity.get(envelopeId) ?? 0n) + amount);
  };
  const refundByTransaction = new Map<string, (typeof confirmedRefunds)[number]>();
  for (const link of confirmedRefunds) {
    if (!refundByTransaction.has(link.refundTransactionId)) {
      refundByTransaction.set(link.refundTransactionId, link);
    }
  }
  for (const transaction of currentTransactions) {
    const pieces = piecesFor(transaction);
    const directlyMapped = pieces
      .map((piece) => ({ piece, envelopeId: resolveEnvelope(piece.envelopeId, piece.categoryId) }))
      .filter((item): item is { piece: BudgetActivityPiece; envelopeId: string } =>
        Boolean(item.envelopeId),
      );
    if (directlyMapped.length) {
      for (const item of directlyMapped) addActivity(item.envelopeId, item.piece.amount);
      continue;
    }
    if (transaction.amount <= 0n) continue;
    const refundLink = refundByTransaction.get(transaction.id);
    const purchase = refundLink ? transactionById.get(refundLink.purchaseTransactionId) : undefined;
    if (!refundLink || !purchase) continue;
    const purchasePieces = piecesFor(purchase)
      .map((piece) => ({ piece, envelopeId: resolveEnvelope(piece.envelopeId, piece.categoryId) }))
      .filter((item): item is { piece: BudgetActivityPiece; envelopeId: string } =>
        Boolean(item.envelopeId),
      );
    const denominator = purchasePieces.reduce(
      (sum, item) => sum + (item.piece.amount < 0n ? -item.piece.amount : item.piece.amount),
      0n,
    );
    if (denominator === 0n) continue;
    const refundable =
      refundLink.amount < transaction.amount ? refundLink.amount : transaction.amount;
    const apportioned = purchasePieces.map((item) => {
      const weight = item.piece.amount < 0n ? -item.piece.amount : item.piece.amount;
      const numerator = refundable * weight;
      return { ...item, amount: numerator / denominator, remainder: numerator % denominator };
    });
    let centsLeft = refundable - apportioned.reduce((sum, item) => sum + item.amount, 0n);
    apportioned.sort((left, right) =>
      left.remainder === right.remainder
        ? left.piece.sequence - right.piece.sequence
        : left.remainder > right.remainder
          ? -1
          : 1,
    );
    for (const item of apportioned) {
      const extra = centsLeft > 0n ? 1n : 0n;
      centsLeft -= extra;
      addActivity(item.envelopeId, item.amount + extra);
    }
  }
  return activity;
}

async function writeAllocation(
  db: BetterWealthDatabase,
  householdId: string,
  periodId: string,
  input: z.infer<typeof allocationWriteSchema>,
) {
  const [period, envelope] = await Promise.all([
    requireBudgetPeriod(db, householdId, periodId),
    requireEnvelope(db, householdId, input.envelopeId),
  ]);
  if (period.currency !== envelope.currency) {
    throw new ConflictError(
      "Envelope and budget period currencies must match",
      "currency_mismatch",
    );
  }
  const existing = await db
    .select()
    .from(envelopeAllocations)
    .where(
      and(
        eq(envelopeAllocations.householdId, householdId),
        eq(envelopeAllocations.budgetPeriodId, periodId),
        eq(envelopeAllocations.envelopeId, input.envelopeId),
      ),
    )
    .get();
  const planned = optionalMoney(
    input.planned,
    input.plannedMinorUnits ?? existing?.planned.toString() ?? envelope.targetAmount.toString(),
    period.currency,
  );
  const funded = optionalMoney(
    input.funded,
    input.fundedMinorUnits ?? existing?.funded.toString() ?? "0",
    period.currency,
  );
  if (planned.currency !== period.currency || funded.currency !== period.currency) {
    throw new ConflictError(
      "Allocation currency must match its budget period",
      "currency_mismatch",
    );
  }
  const activity = BigInt(input.activityMinorUnits ?? existing?.activity.toString() ?? "0");
  const transferredIn = BigInt(
    input.transferredInMinorUnits ?? existing?.transferredIn.toString() ?? "0",
  );
  const transferredOut = BigInt(
    input.transferredOutMinorUnits ?? existing?.transferredOut.toString() ?? "0",
  );
  const available = funded.minor + activity + transferredIn - transferredOut;
  const values = {
    planned: planned.minor,
    funded: funded.minor,
    activity,
    transferredIn,
    transferredOut,
    availableSnapshot: available,
    currency: period.currency,
    calculatedAt: nowIso(),
    updatedAt: nowIso(),
  };
  if (existing) {
    await db
      .update(envelopeAllocations)
      .set(values)
      .where(
        and(
          eq(envelopeAllocations.householdId, householdId),
          eq(envelopeAllocations.id, existing.id),
        ),
      );
    return existing.id;
  }
  const id = ulid();
  await db.insert(envelopeAllocations).values({
    id,
    householdId,
    budgetPeriodId: periodId,
    envelopeId: input.envelopeId,
    ...values,
  });
  return id;
}

const billCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    recurringSeriesId: z.string().optional(),
    envelopeId: z.string().optional(),
    autopayAccountId: z.string().optional(),
    dueRule: z.unknown().default({ cadence: "monthly" }),
    amountMin: MoneyJsonSchema.optional(),
    amountMinMinorUnits: minorUnitsSchema.optional(),
    amountMax: MoneyJsonSchema.optional(),
    amountMaxMinorUnits: minorUnitsSchema.optional(),
    currency: currencySchema.default("USD"),
    recurrenceConfidenceBps: z.number().int().min(0).max(10_000).default(0),
    nextDueDate: dateSchema.optional(),
    isRequired: z.boolean().default(true),
    isActive: z.boolean().default(true),
  })
  .strict()
  .superRefine((input, context) => {
    const minimum = BigInt(input.amountMin?.minorUnits ?? input.amountMinMinorUnits ?? "0");
    const maximum = BigInt(input.amountMax?.minorUnits ?? input.amountMaxMinorUnits ?? minimum);
    if (minimum > maximum) {
      context.addIssue({
        code: "custom",
        path: ["amountMax"],
        message: "Maximum must not be below minimum",
      });
    }
  });

const billPatchSchema = z.object(billCreateSchema.shape).partial().strict();

function billDto(row: typeof bills.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    recurringSeriesId: row.recurringSeriesId,
    envelopeId: row.envelopeId,
    autopayAccountId: row.autopayAccountId,
    dueRule: row.dueRule,
    amountMin: moneyJson(row.amountMin, row.currency),
    amountMax: moneyJson(row.amountMax, row.currency),
    recurrenceConfidenceBps: row.recurrenceConfidenceBps,
    nextDueDate: row.nextDueDate,
    isRequired: row.isRequired,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const goalTypeSchema = z.enum([
  "emergency_fund",
  "purchase",
  "debt_payoff",
  "investment",
  "investment_milestone",
  "custom",
]);

const nonNegativeMinorUnitsSchema = minorUnitsSchema.refine((value) => BigInt(value) >= 0n);
const positiveGoalMoneySchema = MoneyJsonSchema.refine(
  (value) => BigInt(value.minorUnits) > 0n,
  "Goal target must be positive",
);
const nonNegativeGoalMoneySchema = MoneyJsonSchema.refine(
  (value) => BigInt(value.minorUnits) >= 0n,
  "Goal amount cannot be negative",
);

const goalCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: goalTypeSchema,
    target: positiveGoalMoneySchema.optional(),
    targetAmountMinorUnits: positiveMinorUnitsSchema.optional(),
    funded: nonNegativeGoalMoneySchema.optional(),
    fundedAmountMinorUnits: nonNegativeMinorUnitsSchema.optional(),
    monthlyContribution: nonNegativeGoalMoneySchema.optional(),
    monthlyContributionMinorUnits: nonNegativeMinorUnitsSchema.optional(),
    currency: currencySchema.default("USD"),
    targetDate: dateSchema.nullable().optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
    fundingAccountId: z.string().min(1).nullable().optional(),
    linkedDebtAccountId: z.string().min(1).nullable().optional(),
    contributionPolicy: z.unknown().optional(),
    bufferPolicy: z.unknown().optional(),
    liquidityConstraint: z.enum(["cash", "liquid", "investable", "any"]).default("liquid"),
    status: z.enum(["active", "paused", "completed", "cancelled"]).optional(),
    paused: z.boolean().optional(),
    earliestSafeDate: z.string().optional(),
    probability: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const target = input.target?.minorUnits ?? input.targetAmountMinorUnits;
    if (!target || BigInt(target) <= 0n) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "A positive goal target is required",
      });
    }
  });

const goalPatchSchema = z.object(goalCreateSchema.shape).partial().strict();

function goalMonthlyAmount(policy: unknown): string {
  const result = z
    .object({ monthlyAmountMinorUnits: minorUnitsSchema.optional() })
    .passthrough()
    .safeParse(policy);
  return result.success ? (result.data.monthlyAmountMinorUnits ?? "0") : "0";
}

function goalTypeForWeb(type: typeof goals.$inferSelect.type) {
  return type === "investment_milestone" ? ("investment" as const) : type;
}

function goalDto(row: typeof goals.$inferSelect) {
  const monthly = BigInt(goalMonthlyAmount(row.contributionPolicy));
  const projection = projectGoal({
    startMonth: startOfCurrentMonth(),
    currentAmount: money(row.fundedAmount, row.currency),
    targetAmount: money(row.targetAmount, row.currency),
    monthlyContribution: money(monthly, row.currency),
  });
  const pace = deriveGoalPace({
    startMonth: startOfCurrentMonth(),
    currentAmount: { minorUnits: row.fundedAmount, currency: row.currency },
    targetAmount: { minorUnits: row.targetAmount, currency: row.currency },
    monthlyContribution: { minorUnits: monthly, currency: row.currency },
    ...(row.targetDate ? { targetMonth: row.targetDate.slice(0, 7) } : {}),
  });
  return {
    id: row.id,
    name: row.name,
    type: goalTypeForWeb(row.type),
    target: moneyJson(row.targetAmount, row.currency),
    funded: moneyJson(row.fundedAmount, row.currency),
    monthlyContribution: moneyJson(monthly, row.currency),
    ...(projection.reachedMonth ? { earliestSafeDate: `${projection.reachedMonth}-01` } : {}),
    remaining: moneyJson(pace.remainingAmount.minorUnits, row.currency),
    monthsToGoal: pace.monthsToGoal,
    projectedDate: pace.projectedMonth ? `${pace.projectedMonth}-01` : null,
    monthsUntilTarget: pace.monthsUntilTarget,
    requiredMonthlyContribution: pace.requiredMonthlyContribution
      ? moneyJson(pace.requiredMonthlyContribution.minorUnits, row.currency)
      : null,
    monthlyShortfall: moneyJson(pace.monthlyShortfall.minorUnits, row.currency),
    onTrack: pace.onTrack,
    paceRatio: pace.paceRatio,
    priority: row.priority,
    paused: row.status === "paused",
    targetDate: row.targetDate,
    status: row.status,
    fundingAccountId: row.fundingAccountId,
    linkedDebtAccountId: row.linkedDebtAccountId,
    contributionPolicy: row.contributionPolicy,
    bufferPolicy: row.bufferPolicy,
    liquidityConstraint: row.liquidityConstraint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const goalContributionSchema = z
  .object({
    amount: MoneyJsonSchema.optional(),
    amountMinorUnits: positiveMinorUnitsSchema.optional(),
    currency: currencySchema.optional(),
    contributedOn: dateSchema.default(() => new Date().toISOString().slice(0, 10)),
    note: z.string().trim().max(1_000).optional(),
    source: z.string().trim().max(160).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const amount = input.amount?.minorUnits ?? input.amountMinorUnits;
    if (!amount || BigInt(amount) <= 0n) {
      context.addIssue({
        code: "custom",
        path: ["amount"],
        message: "A positive contribution is required",
      });
    }
  });

const goalOrderSchema = z
  .object({ goalIds: z.array(z.string().min(1)).min(1).max(1_000) })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.goalIds).size !== input.goalIds.length) {
      context.addIssue({
        code: "custom",
        path: ["goalIds"],
        message: "Goal order cannot contain duplicate ids",
      });
    }
  });

const ruleWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    priority: z.number().int().min(-1_000_000).max(1_000_000).default(100),
    enabled: z.boolean().default(true),
    origin: z.literal("user").optional().default("user"),
    conditions: RuleConditionSchema.optional(),
    condition: RuleConditionSchema.optional(),
    actions: z.array(RuleActionSchema).min(1).max(50),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.conditions && !input.condition) {
      context.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "A rule condition is required",
      });
    }
    if (input.conditions && input.condition) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: "Use either condition or conditions, not both",
      });
    }
  });

const rulePatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
    conditions: RuleConditionSchema.optional(),
    condition: RuleConditionSchema.optional(),
    actions: z.array(RuleActionSchema).min(1).max(50).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({ code: "custom", message: "At least one rule change is required" });
    }
    if (input.conditions && input.condition) {
      context.addIssue({
        code: "custom",
        path: ["condition"],
        message: "Use either condition or conditions, not both",
      });
    }
  });

type ParsedRuleCondition = z.infer<typeof RuleConditionSchema>;
type ParsedRuleAction = z.infer<typeof RuleActionSchema>;

function collectRuleReferenceIds(
  condition: ParsedRuleCondition,
  actions: readonly ParsedRuleAction[],
) {
  const accountIds = new Set<string>();
  const categoryIds = new Set<string>();
  const envelopeIds = new Set<string>();
  const tagIds = new Set<string>();

  const visit = (node: ParsedRuleCondition) => {
    if ("all" in node) {
      for (const child of node.all) visit(child);
      return;
    }
    if ("any" in node) {
      for (const child of node.any) visit(child);
      return;
    }
    if ("not" in node) {
      visit(node.not);
      return;
    }
    if (node.field === "accountId") {
      for (const value of typeof node.value === "string" ? [node.value] : node.value) {
        accountIds.add(value);
      }
    }
    if (node.field === "hasCategory" && node.categoryId) categoryIds.add(node.categoryId);
    if (node.field === "hasTag") tagIds.add(node.tagId);
  };
  visit(condition);

  for (const action of actions) {
    if (action.type === "setCategory") categoryIds.add(action.categoryId);
    if (action.type === "setEnvelope") envelopeIds.add(action.envelopeId);
    if (action.type === "addTags" || action.type === "removeTags") {
      for (const tagId of action.tagIds) tagIds.add(tagId);
    }
    if (action.type === "createFixedSplits" || action.type === "createPercentageSplits") {
      for (const split of action.splits) {
        categoryIds.add(split.categoryId);
        if (split.envelopeId) envelopeIds.add(split.envelopeId);
      }
    }
  }
  return { accountIds, categoryIds, envelopeIds, tagIds };
}

async function validateRuleReferences(
  db: BetterWealthDatabase,
  householdId: string,
  condition: ParsedRuleCondition,
  actions: readonly ParsedRuleAction[],
) {
  const references = collectRuleReferenceIds(condition, actions);
  const checks = [
    {
      label: "account",
      ids: references.accountIds,
      load: (ids: string[]) =>
        db
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.householdId, householdId), inArray(accounts.id, ids))),
    },
    {
      label: "category",
      ids: references.categoryIds,
      load: (ids: string[]) =>
        db
          .select({ id: categories.id })
          .from(categories)
          .where(and(eq(categories.householdId, householdId), inArray(categories.id, ids))),
    },
    {
      label: "envelope",
      ids: references.envelopeIds,
      load: (ids: string[]) =>
        db
          .select({ id: envelopes.id })
          .from(envelopes)
          .where(and(eq(envelopes.householdId, householdId), inArray(envelopes.id, ids))),
    },
    {
      label: "tag",
      ids: references.tagIds,
      load: (ids: string[]) =>
        db
          .select({ id: tags.id })
          .from(tags)
          .where(and(eq(tags.householdId, householdId), inArray(tags.id, ids))),
    },
  ] as const;

  for (const check of checks) {
    const ids = [...check.ids];
    if (!ids.length) continue;
    const found = await check.load(ids);
    if (found.length !== ids.length) {
      throw new AppError(
        `Rule references an unavailable ${check.label}`,
        400,
        "invalid_rule_reference",
      );
    }
  }
}

function mapRuleOriginForWeb(origin: typeof rules.$inferSelect.origin) {
  return origin === "ai" ? ("approved_ai" as const) : origin;
}

function ruleDto(row: typeof rules.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.isEnabled,
    origin: mapRuleOriginForWeb(row.origin),
    conditions: row.conditions,
    condition: row.conditions,
    actions: row.actions,
    matchCount: row.matchCount,
    ...(row.lastMatchedAt ? { lastMatchedAt: row.lastMatchedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function engineRule(row: typeof rules.$inferSelect): CategorizationRule {
  return CategorizationRuleSchema.parse({
    id: row.id,
    name: row.name,
    priority: row.priority,
    enabled: row.isEnabled,
    origin: row.origin === "ai" ? "approvedAi" : row.origin,
    condition: row.conditions,
    actions: row.actions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

type RuleTransactionRecord = {
  ruleTransaction: RuleTransaction;
  transaction: typeof transactions.$inferSelect;
  account: typeof accounts.$inferSelect;
  merchantName: string | null;
  tagIds: string[];
};

async function loadRuleTransactions(
  db: BetterWealthDatabase,
  householdId: string,
  transactionIds?: string[],
  maximum = 2_000,
): Promise<RuleTransactionRecord[]> {
  if (transactionIds?.length === 0) return [];
  const rows = await db
    .select({ transaction: transactions, account: accounts, merchantName: merchants.name })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(merchants, eq(merchants.id, transactions.merchantId))
    .where(
      and(
        eq(transactions.householdId, householdId),
        eq(accounts.householdId, householdId),
        transactionIds ? inArray(transactions.id, transactionIds) : undefined,
      ),
    )
    .orderBy(desc(transactions.transactedOn), desc(transactions.id))
    .limit(maximum);
  const ids = rows.map((row) => row.transaction.id);
  const tagRows = ids.length
    ? await db
        .select({ transactionId: transactionTags.transactionId, tagId: transactionTags.tagId })
        .from(transactionTags)
        .where(
          and(
            eq(transactionTags.householdId, householdId),
            inArray(transactionTags.transactionId, ids),
          ),
        )
    : [];
  const tagsByTransaction = new Map<string, string[]>();
  for (const tag of tagRows) {
    const values = tagsByTransaction.get(tag.transactionId) ?? [];
    values.push(tag.tagId);
    tagsByTransaction.set(tag.transactionId, values);
  }
  return rows.map(({ transaction, account, merchantName }) => {
    const tagIds = tagsByTransaction.get(transaction.id) ?? [];
    const ruleTransaction: RuleTransaction = {
      id: transaction.id,
      rawDescription: transaction.rawDescription,
      normalizedDescription: transaction.normalizedDescription,
      ...(merchantName ? { merchant: merchantName } : {}),
      accountId: account.id,
      accountGroup: account.group,
      accountType: account.type,
      ...(account.institutionId ? { institutionId: account.institutionId } : {}),
      amount: money(transaction.amount, transaction.currency),
      date: transaction.postedAt ?? transaction.authorizedAt ?? transaction.transactedOn,
      status: transaction.status === "pending" ? "pending" : "posted",
      ...(transaction.recurringSeriesId
        ? { recurringSeriesId: transaction.recurringSeriesId }
        : {}),
      importSource: transaction.source,
      ...(transaction.categoryId ? { categoryId: transaction.categoryId } : {}),
      tagIds,
      ...(transaction.note ? { note: transaction.note } : {}),
    };
    return { ruleTransaction, transaction, account, merchantName, tagIds };
  });
}

async function ensureMerchant(db: BetterWealthDatabase, householdId: string, merchantName: string) {
  const normalizedName = normalizeDescription(merchantName);
  const existing = await db
    .select({ id: merchants.id })
    .from(merchants)
    .where(
      and(eq(merchants.householdId, householdId), eq(merchants.normalizedName, normalizedName)),
    )
    .get();
  if (existing) return existing.id;
  const id = ulid();
  await db.insert(merchants).values({ id, householdId, name: merchantName, normalizedName });
  return id;
}

const monteCarloAssumptionSchema = z
  .object({
    assetClass: z.string().trim().min(1).max(80),
    meanAnnualReturnBps: z.number().int().min(-10_000).max(1_000_000),
    annualVolatilityBps: z.number().int().min(0).max(1_000_000),
  })
  .strict();

const monteCarloSettingsSchema = z
  .object({
    assumptions: z.array(monteCarloAssumptionSchema).max(100).default([]),
    correlationMatrix: z.array(z.array(z.number())).max(100).optional(),
    successTarget: MoneyJsonSchema.optional(),
    successMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
  })
  .strict();

const uiForecastAssumptionsSchema = z
  .object({
    incomeGrowth: z.number().finite().min(-100).max(1_000),
    inflation: z.number().finite().min(-100).max(1_000),
    investmentReturn: z.number().finite().min(-100).max(10_000),
    cashYield: z.number().finite().min(-100).max(10_000),
    monthlyInvesting: MoneyJsonSchema,
  })
  .strict();

const forecastScenarioWriteSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    preset: z.enum(["conservative", "baseline", "ambitious", "custom"]).default("baseline"),
    seed: z.union([z.string(), z.number().finite()]).default("betterwealth"),
    horizonMonths: z.number().int().min(1).max(1_200).optional(),
    reportingCurrency: currencySchema.optional(),
    isBase: z.boolean().default(false),
    isActive: z.boolean().default(true),
    scenario: ForecastScenarioSchema,
    monteCarlo: monteCarloSettingsSchema.optional(),
  })
  .strict();

const forecastScenarioPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    preset: z.enum(["conservative", "baseline", "ambitious", "custom"]).optional(),
    seed: z.union([z.string(), z.number().finite()]).optional(),
    horizonMonths: z.number().int().min(1).max(1_200).optional(),
    reportingCurrency: currencySchema.optional(),
    isBase: z.boolean().optional(),
    isActive: z.boolean().optional(),
    scenario: ForecastScenarioSchema.optional(),
    monteCarlo: monteCarloSettingsSchema.optional(),
  })
  .strict();

const forecastRunRequestSchema = z
  .object({
    scenarioId: z.string(),
    seed: z.union([z.string(), z.number().finite()]).optional(),
    monteCarloRuns: z.number().int().min(0).max(10_000).optional(),
    successTarget: MoneyJsonSchema.optional(),
    successMonth: z
      .string()
      .regex(/^\d{4}-\d{2}$/)
      .optional(),
  })
  .strict();

const storedForecastAssumptionsSchema = z
  .object({
    scenario: ForecastScenarioSchema,
    monteCarlo: monteCarloSettingsSchema.optional(),
    uiAssumptions: uiForecastAssumptionsSchema.optional(),
  })
  .strict();

function parseStoredForecastAssumptions(value: unknown) {
  const wrapped = storedForecastAssumptionsSchema.safeParse(value);
  if (wrapped.success) return wrapped.data;
  return { scenario: ForecastScenarioSchema.parse(value) };
}

const forecastDebtMetadataSchema = z
  .object({
    annualInterestBps: z.number().int().min(0).max(1_000_000).optional(),
    minimumPaymentMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    minimumPayment: MoneyJsonSchema.optional(),
    paymentAccountId: z.string().optional(),
  })
  .passthrough();

const forecastAssetMetadataSchema = z
  .object({
    annualAppreciationBps: z.number().int().min(-10_000).max(1_000_000).optional(),
  })
  .passthrough();

function debtForecastMetadata(value: unknown, currency: string) {
  const parsed = forecastDebtMetadataSchema.safeParse(value);
  if (!parsed.success) {
    return { annualInterestBps: 0, minimumPayment: 0n, paymentAccountId: undefined };
  }
  const payment = parsed.data.minimumPayment;
  return {
    annualInterestBps: parsed.data.annualInterestBps ?? 0,
    minimumPayment: (() => {
      const value =
        payment?.currency === currency
          ? BigInt(payment.minorUnits)
          : BigInt(parsed.data.minimumPaymentMinorUnits ?? "0");
      return value > 0n ? value : 0n;
    })(),
    paymentAccountId: parsed.data.paymentAccountId,
  };
}

async function buildLedgerForecastScenario(
  db: BetterWealthDatabase,
  householdId: string,
  name: string,
  assumptions: z.infer<typeof uiForecastAssumptionsSchema>,
  horizonMonths = 96,
) {
  const currency = assumptions.monthlyInvesting.currency;
  const [
    accountRows,
    balanceRows,
    incomes,
    billRows,
    envelopeRows,
    goalRows,
    assetRows,
    valuationRows,
    categoryRows,
    planningDefaults,
  ] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(and(eq(accounts.householdId, householdId), eq(accounts.status, "active")))
      .orderBy(asc(accounts.name)),
    db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.householdId, householdId))
      .orderBy(desc(balanceSnapshots.asOf)),
    db
      .select()
      .from(incomeSources)
      .where(and(eq(incomeSources.householdId, householdId), eq(incomeSources.isActive, true))),
    db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, householdId), eq(bills.isActive, true))),
    db
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.householdId, householdId), eq(envelopes.isActive, true))),
    db
      .select()
      .from(goals)
      .where(and(eq(goals.householdId, householdId), eq(goals.status, "active"))),
    db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, householdId), eq(assets.isActive, true))),
    db
      .select()
      .from(assetValuations)
      .where(eq(assetValuations.householdId, householdId))
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt)),
    db.select().from(categories).where(eq(categories.householdId, householdId)),
    loadPlanningForecastDefaults(db, householdId),
  ]);
  const latestBalances = new Map<string, (typeof balanceRows)[number]>();
  for (const balance of balanceRows) {
    if (!latestBalances.has(balance.accountId)) latestBalances.set(balance.accountId, balance);
  }
  const latestValuations = new Map<string, (typeof valuationRows)[number]>();
  for (const valuation of valuationRows) {
    if (!latestValuations.has(valuation.assetId))
      latestValuations.set(valuation.assetId, valuation);
  }
  const eligible = accountRows.filter(
    (account) => !account.isLiability && account.currency === currency && account.includeInNetWorth,
  );
  const liabilities = accountRows.filter(
    (account) => account.isLiability && account.currency === currency && account.includeInNetWorth,
  );
  let primary = eligible.find((account) => account.group === "cash");
  if (!primary) primary = eligible[0];
  if (!primary) {
    throw new AppError(
      `Add a ${currency} cash account before creating a forecast scenario`,
      409,
      "forecast_needs_cash_account",
    );
  }
  const investmentAccount = eligible.find((account) => account.group === "investment");
  const syntheticInvestmentId = investmentAccount ? undefined : ulid();
  const accountInputs: z.infer<typeof ForecastScenarioSchema>["accounts"][number][] = eligible.map(
    (account) => {
      const balance = latestBalances.get(account.id);
      const isInvestment = account.group === "investment" || account.group === "crypto";
      const normalizedType = normalizedCadence(account.type);
      const isRetirement =
        normalizedType.includes("retire") ||
        normalizedType.includes("401") ||
        normalizedType.includes("403") ||
        normalizedType.includes("457") ||
        normalizedType.includes("ira") ||
        normalizedType.includes("pension");
      const type = isInvestment
        ? isRetirement
          ? ("retirement" as const)
          : ("investment" as const)
        : account.group === "cash"
          ? account.type.toLowerCase().includes("saving")
            ? ("savings" as const)
            : ("checking" as const)
          : ("asset" as const);
      return {
        id: account.id,
        name: account.name,
        type,
        balance: moneyJson(balance?.currentBalance ?? 0n, currency),
        liquid:
          account.group === "cash" ||
          account.group === "crypto" ||
          (account.group === "investment" && !isRetirement),
        annualReturnBps: Math.round(
          (isInvestment
            ? assumptions.investmentReturn
            : account.group === "cash"
              ? assumptions.cashYield
              : 0) * 100,
        ),
        ...(isInvestment ? { assetClass: "growth" } : {}),
      };
    },
  );
  for (const asset of assetRows) {
    if (asset.currency !== currency) continue;
    const valuation = latestValuations.get(asset.id);
    const metadata = forecastAssetMetadataSchema.safeParse(asset.metadata);
    accountInputs.push({
      id: asset.id,
      name: asset.name,
      type: "asset",
      balance: moneyJson(valuation?.amount ?? 0n, currency),
      liquid: asset.liquidityClass === "liquid",
      annualReturnBps: metadata.success ? (metadata.data.annualAppreciationBps ?? 0) : 0,
    });
  }
  if (syntheticInvestmentId) {
    accountInputs.push({
      id: syntheticInvestmentId,
      name: "Planned investments",
      type: "investment",
      balance: moneyJson(0n, currency),
      liquid: true,
      annualReturnBps: Math.round(assumptions.investmentReturn * 100),
      assetClass: "growth",
    });
  }
  const linkedBillEnvelopeIds = new Set(
    billRows.map((bill) => bill.envelopeId).filter((id): id is string => Boolean(id)),
  );
  const debtCategoryIds = new Set(
    categoryRows.filter((category) => category.kind === "debt").map((category) => category.id),
  );
  const debtEnvelopeIds = new Set(
    envelopeRows
      .filter((envelope) => {
        if (envelope.categoryId && debtCategoryIds.has(envelope.categoryId)) return true;
        const cadence = z
          .object({ priorityClass: z.literal("minimumDebt") })
          .passthrough()
          .safeParse(envelope.cadenceConfig);
        return cadence.success;
      })
      .map((envelope) => envelope.id),
  );
  const primaryIncome = incomes
    .filter((income) => income.currency === currency)
    .sort(
      (left, right) =>
        Number(right.accountId === primary.id) - Number(left.accountId === primary.id) ||
        left.id.localeCompare(right.id),
    )[0];
  const payCyclePeriodsPerYear = primaryIncome ? cadencePeriodsPerYear(primaryIncome.cadence) : 12;
  const cashFlows = [
    ...incomes
      .filter((income) => income.currency === currency)
      .map((income) => ({
        id: income.id,
        name: income.name,
        kind: "income" as const,
        amount: moneyJson(
          averageMonthlyAmount(
            income.typicalAmount < 0n ? -income.typicalAmount : income.typicalAmount,
            income.cadence,
          ),
          currency,
        ),
        accountId: income.accountId ?? primary.id,
        annualGrowthBps: Math.round(assumptions.incomeGrowth * 100),
        required: true,
      })),
    ...billRows
      .filter(
        (bill) =>
          bill.currency === currency && (!bill.envelopeId || !debtEnvelopeIds.has(bill.envelopeId)),
      )
      .map((bill) => {
        const cadence = cadenceFromDueRule(bill.dueRule);
        const oneTime = normalizedCadence(cadence) === "onetimeestimate";
        const scheduledMonth = bill.nextDueDate?.slice(0, 7) ?? startOfCurrentMonth();
        return {
          id: bill.id,
          name: bill.name,
          kind: "bill" as const,
          amount: moneyJson(
            oneTime
              ? bill.amountMax < 0n
                ? -bill.amountMax
                : bill.amountMax
              : averageMonthlyAmount(
                  bill.amountMax < 0n ? -bill.amountMax : bill.amountMax,
                  cadence,
                ),
            currency,
          ),
          accountId: bill.autopayAccountId ?? primary.id,
          ...(oneTime ? { startMonth: scheduledMonth, endMonth: scheduledMonth } : {}),
          annualGrowthBps: Math.round(assumptions.inflation * 100),
          required: bill.isRequired,
        };
      }),
    ...envelopeRows
      .filter(
        (envelope) =>
          envelope.currency === currency &&
          envelope.targetAmount > 0n &&
          !linkedBillEnvelopeIds.has(envelope.id) &&
          !debtEnvelopeIds.has(envelope.id),
      )
      .map((envelope) => ({
        id: envelope.id,
        name: envelope.name,
        kind: "envelope" as const,
        amount: moneyJson(averageMonthlyEnvelopeAmount(envelope, payCyclePeriodsPerYear), currency),
        accountId: primary.id,
        annualGrowthBps: Math.round(assumptions.inflation * 100),
        required: envelope.isRequired,
      })),
  ];
  const investmentDestination = investmentAccount?.id ?? syntheticInvestmentId!;
  const forecastAccountIds = new Set(accountInputs.map((account) => account.id));
  const contributions = [
    ...(BigInt(assumptions.monthlyInvesting.minorUnits) > 0n
      ? [
          {
            id: ulid(),
            name: "Monthly investing",
            kind: "investment" as const,
            amount: assumptions.monthlyInvesting,
            fromAccountId: primary.id,
            toAccountId: investmentDestination,
            priority: 100,
          },
        ]
      : []),
    ...goalRows
      .filter(
        (goal) =>
          goal.type !== "debt_payoff" &&
          goal.currency === currency &&
          goal.fundingAccountId &&
          forecastAccountIds.has(goal.fundingAccountId),
      )
      .map((goal) => ({
        id: goal.id,
        name: goal.name,
        kind: goal.type === "investment_milestone" ? ("investment" as const) : ("goal" as const),
        amount: moneyJson(BigInt(goalMonthlyAmount(goal.contributionPolicy)), currency),
        fromAccountId: primary.id,
        toAccountId: goal.fundingAccountId!,
        priority: goal.priority,
        targetAmount: moneyJson(goal.targetAmount, currency),
      }))
      .filter((contribution) => BigInt(contribution.amount.minorUnits) > 0n),
  ];
  const liquidAccountIds = new Set(
    accountInputs.filter((account) => account.liquid).map((account) => account.id),
  );
  const debtInputs = liabilities.flatMap((account) => {
    const balance = latestBalances.get(account.id)?.currentBalance ?? 0n;
    const principal = balance < 0n ? -balance : balance;
    if (principal === 0n) return [];
    const metadata = debtForecastMetadata(account.providerMetadata, currency);
    const linkedGoal = goalRows
      .filter(
        (goal) =>
          goal.type === "debt_payoff" &&
          goal.currency === currency &&
          goal.linkedDebtAccountId === account.id,
      )
      .sort((left, right) => right.priority - left.priority)[0];
    const configuredExtraPayment = linkedGoal
      ? BigInt(goalMonthlyAmount(linkedGoal.contributionPolicy))
      : 0n;
    const extraPayment = configuredExtraPayment > 0n ? configuredExtraPayment : 0n;
    return [
      {
        id: account.id,
        name: account.name,
        principal: moneyJson(principal, currency),
        annualInterestBps: metadata.annualInterestBps,
        minimumPayment: moneyJson(metadata.minimumPayment, currency),
        ...(extraPayment > 0n ? { extraPayment: moneyJson(extraPayment, currency) } : {}),
        paymentAccountId:
          metadata.paymentAccountId && liquidAccountIds.has(metadata.paymentAccountId)
            ? metadata.paymentAccountId
            : primary.id,
      },
    ];
  });
  return ForecastScenarioSchema.parse({
    name,
    startMonth: startOfCurrentMonth(),
    horizonMonths,
    baseCurrency: currency,
    primaryCashAccountId: primary.id,
    ...(planningDefaults.currency === currency &&
    planningDefaults.preferences.minimumBufferMinorUnits !== undefined
      ? {
          minimumCashBuffer: moneyJson(
            BigInt(planningDefaults.preferences.minimumBufferMinorUnits),
            currency,
          ),
        }
      : {}),
    accounts: accountInputs,
    cashFlows,
    debts: debtInputs,
    contributions,
  });
}

function engineScenario(input: z.infer<typeof ForecastScenarioSchema>): ForecastScenario {
  return {
    ...(input.id ? { id: input.id } : {}),
    ...(input.name ? { name: input.name } : {}),
    startMonth: input.startMonth,
    horizonMonths: input.horizonMonths,
    baseCurrency: input.baseCurrency,
    primaryCashAccountId: input.primaryCashAccountId,
    ...(input.minimumCashBuffer
      ? { minimumCashBuffer: moneyFromJson(input.minimumCashBuffer) }
      : {}),
    accounts: input.accounts.map((account) => ({
      id: account.id,
      ...(account.name ? { name: account.name } : {}),
      type: account.type,
      balance: moneyFromJson(account.balance),
      liquid: account.liquid,
      ...(account.annualReturnBps === undefined
        ? {}
        : { annualReturnBps: account.annualReturnBps }),
      ...(account.assetClass ? { assetClass: account.assetClass } : {}),
    })),
    cashFlows: input.cashFlows.map((cashFlow) => ({
      id: cashFlow.id,
      ...(cashFlow.name ? { name: cashFlow.name } : {}),
      kind: cashFlow.kind,
      amount: moneyFromJson(cashFlow.amount),
      ...(cashFlow.accountId ? { accountId: cashFlow.accountId } : {}),
      ...(cashFlow.startMonth ? { startMonth: cashFlow.startMonth } : {}),
      ...(cashFlow.endMonth ? { endMonth: cashFlow.endMonth } : {}),
      ...(cashFlow.annualGrowthBps === undefined
        ? {}
        : { annualGrowthBps: cashFlow.annualGrowthBps }),
      ...(cashFlow.required === undefined ? {} : { required: cashFlow.required }),
    })),
    ...(input.debts
      ? {
          debts: input.debts.map((debt) => ({
            id: debt.id,
            ...(debt.name ? { name: debt.name } : {}),
            principal: moneyFromJson(debt.principal),
            annualInterestBps: debt.annualInterestBps,
            minimumPayment: moneyFromJson(debt.minimumPayment),
            ...(debt.extraPayment ? { extraPayment: moneyFromJson(debt.extraPayment) } : {}),
            ...(debt.paymentAccountId ? { paymentAccountId: debt.paymentAccountId } : {}),
          })),
        }
      : {}),
    ...(input.contributions
      ? {
          contributions: input.contributions.map((contribution) => ({
            id: contribution.id,
            ...(contribution.name ? { name: contribution.name } : {}),
            kind: contribution.kind,
            amount: moneyFromJson(contribution.amount),
            ...(contribution.fromAccountId ? { fromAccountId: contribution.fromAccountId } : {}),
            toAccountId: contribution.toAccountId,
            priority: contribution.priority,
            ...(contribution.required === undefined ? {} : { required: contribution.required }),
            ...(contribution.startMonth ? { startMonth: contribution.startMonth } : {}),
            ...(contribution.endMonth ? { endMonth: contribution.endMonth } : {}),
            ...(contribution.targetAmount
              ? { targetAmount: moneyFromJson(contribution.targetAmount) }
              : {}),
          })),
        }
      : {}),
  };
}

function forecastScenarioDto(row: typeof forecastScenarios.$inferSelect) {
  const stored = parseStoredForecastAssumptions(row.assumptions);
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    seed: row.seed,
    horizonMonths: row.horizonMonths,
    reportingCurrency: row.reportingCurrency,
    isBase: row.isBase,
    isActive: row.isActive,
    scenario: stored.scenario,
    monteCarlo: stored.monteCarlo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function uiScenarioDto(row: typeof forecastScenarios.$inferSelect) {
  const stored = parseStoredForecastAssumptions(row.assumptions);
  const fallbackCurrency = stored.scenario.baseCurrency;
  const assumptions =
    stored.uiAssumptions ??
    ({
      incomeGrowth: 3,
      inflation: 2.5,
      investmentReturn: 6.5,
      cashYield: 3,
      monthlyInvesting: moneyJson(0n, fallbackCurrency),
    } satisfies z.infer<typeof uiForecastAssumptionsSchema>);
  const numericSeed = Number(row.seed);
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    assumptions,
    seed: Number.isSafeInteger(numericSeed) ? numericSeed : 0,
    isBase: row.isBase,
  };
}

type StoredForecastOutput = ReturnType<typeof forecastResultToJson>;
type StoredMonteCarloOutput = ReturnType<typeof monteCarloResultToJson>;

/**
 * Keep forecast list responses useful for charts without returning as many as
 * 1,200 full engine snapshots. The first and final months are always present,
 * and the points between them are selected deterministically.
 */
function sampledForecastIndices(length: number, maximumPoints = 25): number[] {
  if (length <= 0) return [];
  if (length <= maximumPoints) return Array.from({ length }, (_, index) => index);
  return Array.from(
    new Set(
      Array.from({ length: maximumPoints }, (_, index) =>
        Math.round((index * (length - 1)) / (maximumPoints - 1)),
      ),
    ),
  );
}

function sampledPercentiles(values: Readonly<Record<string, MoneyJson>>) {
  return {
    ...(values.p10 ? { p10: values.p10 } : {}),
    ...(values.p25 ? { p25: values.p25 } : {}),
    ...(values.p50 ? { p50: values.p50 } : {}),
    ...(values.p75 ? { p75: values.p75 } : {}),
    ...(values.p90 ? { p90: values.p90 } : {}),
  };
}

function forecastRunDto(row: typeof forecastRuns.$inferSelect) {
  if (row.state !== "succeeded" || !row.outputs) {
    return {
      id: row.id,
      scenarioId: row.scenarioId,
      engineVersion: row.engineVersion,
      seed: 0,
      state: row.state,
      readiness: row.readiness,
      createdAt: row.createdAt,
    };
  }
  const output = row.outputs as unknown as StoredForecastOutput;
  const monte = row.percentileSeries as unknown as StoredMonteCarloOutput | null;
  const ending = output.months.at(-1)!;
  const lowestCash = output.months.reduce(
    (lowest, month) =>
      BigInt(month.primaryCashLow.minorUnits) < BigInt(lowest.minorUnits)
        ? month.primaryCashLow
        : lowest,
    output.months[0]!.primaryCashLow,
  );
  const lastMonteMonth = monte?.months.at(-1);
  const percentiles = ([10, 25, 50, 75, 90] as const)
    .map((percentile) => {
      const amount = lastMonteMonth?.netWorth[`p${percentile}`];
      return amount ? { percentile, amount } : undefined;
    })
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  if (percentiles.length === 0) percentiles.push({ percentile: 50, amount: ending.netWorth });
  const seedText = monte?.seed ?? "0";
  const seedNumber = Number(seedText);
  const sampledMonths = sampledForecastIndices(output.months.length).flatMap((index) => {
    const month = output.months[index];
    return month ? [month] : [];
  });
  const monteMonths = new Map(monte?.months.map((month) => [month.month, month]) ?? []);
  return {
    id: row.id,
    scenarioId: row.scenarioId,
    engineVersion: row.engineVersion,
    seed: Number.isSafeInteger(seedNumber) ? seedNumber : 0,
    state: row.state,
    horizonDate: `${ending.month}-01`,
    liquidNetWorthAtTarget: ending.liquidCash,
    totalNetWorthAtTarget: ending.netWorth,
    lowestCashBalance: lowestCash,
    ...(output.debtFreeMonth ? { debtFreeDate: `${output.debtFreeMonth}-01` } : {}),
    percentiles,
    trajectory: sampledMonths.map((month) => ({
      month: month.month,
      liquidCash: month.liquidCash,
      netWorth: month.netWorth,
    })),
    ...(monte
      ? {
          monteCarlo: {
            runs: monte.runs,
            goalSuccessProbability: monte.goalSuccessProbability,
            ranges: sampledMonths.flatMap((deterministicMonth) => {
              const month = monteMonths.get(deterministicMonth.month);
              return month
                ? [
                    {
                      month: month.month,
                      netWorth: sampledPercentiles(month.netWorth),
                      liquidCash: sampledPercentiles(month.liquidCash),
                    },
                  ]
                : [];
            }),
          },
        }
      : {}),
    readiness: row.readiness,
    createdAt: row.createdAt,
  };
}

const assetCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    type: z.enum(["property", "vehicle", "collectible", "business", "custom"]),
    liquidityClass: z.enum(["illiquid", "restricted", "liquid"]).default("illiquid"),
    currency: currencySchema.default("USD"),
    linkedLiabilityAccountId: z.string().optional(),
    relatedLiabilityId: z.string().optional(),
    metadata: z.unknown().optional(),
    isActive: z.boolean().default(true),
    value: nonNegativeMoneyJsonSchema.optional(),
    valuedOn: dateSchema.optional(),
    valuedAt: z.string().datetime({ offset: true }).optional(),
    valuationSource: z.enum(["manual", "provider", "appraisal", "import"]).default("manual"),
    source: z.string().trim().max(160).optional(),
    confidence: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();

const assetPatchSchema = assetCreateSchema.partial();

const valuationCreateSchema = z
  .object({
    amount: nonNegativeMoneyJsonSchema.optional(),
    amountMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    currency: currencySchema.optional(),
    valuedOn: dateSchema.default(() => new Date().toISOString().slice(0, 10)),
    source: z.enum(["manual", "provider", "appraisal", "import"]).default("manual"),
    confidenceBps: z.number().int().min(0).max(10_000).default(10_000),
    providerReference: z.string().trim().max(500).optional(),
    metadata: z.unknown().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.amount && input.amountMinorUnits === undefined) {
      context.addIssue({ code: "custom", path: ["amount"], message: "An asset value is required" });
    }
  });

const incomeSourceCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    merchantId: z.string().optional(),
    accountId: z.string().optional(),
    recurringSeriesId: z.string().optional(),
    cadence: z.string().trim().min(1).max(80).default("monthly"),
    cadenceConfig: z.unknown().optional(),
    typicalAmount: MoneyJsonSchema.optional(),
    typicalAmountMinorUnits: minorUnitsSchema.optional(),
    currency: currencySchema.default("USD"),
    nextExpectedDate: dateSchema.optional(),
    variabilityBps: z.number().int().min(0).max(100_000).default(0),
    isActive: z.boolean().default(true),
    detectionRule: z.unknown().optional(),
  })
  .strict();

const incomeSourcePatchSchema = incomeSourceCreateSchema.partial();

const importTransactionsSchema = z
  .object({
    accountId: z.string(),
    filename: z.string().trim().min(1).max(255),
    content: z
      .string()
      .min(1)
      .max(10 * 1024 * 1024),
    currency: currencySchema.optional(),
  })
  .strict();

export function createPlanningRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAuth(db, config));

  // Envelope budgets -------------------------------------------------------

  routes.get("/envelopes", async (context) => {
    const auth = context.get("auth");
    const [rows, links] = await Promise.all([
      db
        .select()
        .from(envelopes)
        .where(eq(envelopes.householdId, auth.householdId))
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name)),
      db
        .select()
        .from(envelopeCategoryLinks)
        .where(eq(envelopeCategoryLinks.householdId, auth.householdId)),
    ]);
    const categoriesByEnvelope = new Map<string, string[]>();
    for (const link of links) {
      const values = categoriesByEnvelope.get(link.envelopeId) ?? [];
      values.push(link.categoryId);
      categoriesByEnvelope.set(link.envelopeId, values);
    }
    return context.json(
      page(rows.map((row) => standaloneEnvelopeDto(row, categoriesByEnvelope.get(row.id)))),
    );
  });

  routes.post("/envelopes", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = envelopeCreateSchema.parse(await context.req.json());
    if (input.parentId) await requireEnvelope(db, auth.householdId, input.parentId);
    const categoryIds = [
      ...(input.categoryId ? [input.categoryId] : []),
      ...(input.categoryIds ?? []),
    ];
    await requireCategories(db, auth.householdId, categoryIds);
    const id = ulid();
    await db.transaction(async (transaction) => {
      await transaction.insert(envelopes).values({
        id,
        householdId: auth.householdId,
        ...(input.parentId ? { parentId: input.parentId } : {}),
        ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        name: input.name,
        cadence: input.cadence,
        ...(input.cadenceConfig === undefined
          ? {}
          : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
        rolloverPolicy: dbRolloverPolicy(input.rolloverPolicy),
        ...(input.rolloverCapMinorUnits === undefined
          ? {}
          : { rolloverCap: BigInt(input.rolloverCapMinorUnits) }),
        priority: input.priority,
        minimumAmount: BigInt(input.minimumAmountMinorUnits),
        targetAmount: input.planned
          ? BigInt(input.planned.minorUnits)
          : BigInt(input.targetAmountMinorUnits),
        currency: input.currency,
        isRequired: input.isRequired,
        isActive: input.isActive,
      });
      if (categoryIds.length) {
        await transaction.insert(envelopeCategoryLinks).values(
          [...new Set(categoryIds)].map((categoryId) => ({
            householdId: auth.householdId,
            envelopeId: id,
            categoryId,
          })),
        );
      }
    });
    const row = await db
      .select()
      .from(envelopes)
      .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, id)))
      .get();
    if (!row) throw new NotFoundError("Envelope");
    return context.json(
      {
        ...standaloneEnvelopeDto(row, categoryIds),
        ...(input.funded ? { funded: input.funded, available: input.funded } : {}),
      },
      201,
    );
  });

  routes.patch("/envelopes/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireEnvelope(db, auth.householdId, context.req.param("id"));
    const input = envelopePatchSchema.parse(await context.req.json());
    if (input.parentId) {
      if (input.parentId === current.id) {
        throw new ConflictError("An envelope cannot contain itself", "invalid_parent");
      }
      await requireEnvelope(db, auth.householdId, input.parentId);
    }
    const categoryIds =
      input.categoryId === undefined && input.categoryIds === undefined
        ? undefined
        : [...(input.categoryId ? [input.categoryId] : []), ...(input.categoryIds ?? [])];
    if (categoryIds) await requireCategories(db, auth.householdId, categoryIds);
    await db.transaction(async (transaction) => {
      await transaction
        .update(envelopes)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
          ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
          ...(input.cadence === undefined ? {} : { cadence: input.cadence }),
          ...(input.cadenceConfig === undefined
            ? {}
            : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
          ...(input.rolloverPolicy === undefined
            ? {}
            : { rolloverPolicy: dbRolloverPolicy(input.rolloverPolicy) }),
          ...(input.rolloverCapMinorUnits === undefined
            ? {}
            : { rolloverCap: BigInt(input.rolloverCapMinorUnits) }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.minimumAmountMinorUnits === undefined
            ? {}
            : { minimumAmount: BigInt(input.minimumAmountMinorUnits) }),
          ...(input.planned
            ? { targetAmount: BigInt(input.planned.minorUnits), currency: input.planned.currency }
            : input.targetAmountMinorUnits === undefined
              ? {}
              : { targetAmount: BigInt(input.targetAmountMinorUnits) }),
          ...(input.currency === undefined ? {} : { currency: input.currency }),
          ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          updatedAt: nowIso(),
        })
        .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, current.id)));
      if (categoryIds) {
        await transaction
          .delete(envelopeCategoryLinks)
          .where(
            and(
              eq(envelopeCategoryLinks.householdId, auth.householdId),
              eq(envelopeCategoryLinks.envelopeId, current.id),
            ),
          );
        if (categoryIds.length) {
          await transaction.insert(envelopeCategoryLinks).values(
            [...new Set(categoryIds)].map((categoryId) => ({
              householdId: auth.householdId,
              envelopeId: current.id,
              categoryId,
            })),
          );
        }
      }
      if (input.planned || input.targetAmountMinorUnits !== undefined) {
        const planned = input.planned
          ? BigInt(input.planned.minorUnits)
          : BigInt(input.targetAmountMinorUnits!);
        await transaction
          .update(envelopeAllocations)
          .set({ planned, updatedAt: nowIso() })
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.envelopeId, current.id),
            ),
          );
      }
    });
    const updated = await requireEnvelope(db, auth.householdId, current.id);
    const updatedLinks = await db
      .select({ categoryId: envelopeCategoryLinks.categoryId })
      .from(envelopeCategoryLinks)
      .where(
        and(
          eq(envelopeCategoryLinks.householdId, auth.householdId),
          eq(envelopeCategoryLinks.envelopeId, current.id),
        ),
      );
    return context.json(
      standaloneEnvelopeDto(
        updated,
        updatedLinks.map((link) => link.categoryId),
      ),
    );
  });

  routes.delete("/envelopes/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const row = await requireEnvelope(db, auth.householdId, context.req.param("id"));
    await db
      .update(envelopes)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, row.id)));
    return context.body(null, 204);
  });

  routes.get("/budgets", async (context) => {
    const auth = context.get("auth");
    const requestedView = context.req.query("view");
    const data = await budgetDtos(db, auth.householdId);
    return context.json(
      page(
        requestedView && requestedView !== "plan"
          ? data.filter((period) => period.periodKind === requestedView)
          : data,
      ),
    );
  });

  routes.get("/budget-periods", async (context) => {
    const auth = context.get("auth");
    return context.json(page(await budgetDtos(db, auth.householdId)));
  });

  routes.post("/budgets", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = budgetWriteSchema.parse(await context.req.json());
    const startsOn = input.startDate ?? input.startsOn;
    const endsOn = input.endDate ?? input.endsOn;
    if (!startsOn || !endsOn) {
      throw new AppError("Budget start and end dates are required", 400, "invalid_budget");
    }
    if (startsOn > endsOn) {
      throw new AppError("Budget start date must not be after its end date", 400, "invalid_budget");
    }
    const kind =
      input.kind ?? (input.periodKind === "plan" ? "custom" : input.periodKind) ?? "month";
    const expected = optionalMoney(
      input.plannedIncome,
      input.expectedIncomeMinorUnits,
      input.currency ?? "USD",
    );
    const actual = optionalMoney(
      input.actualIncome,
      input.actualIncomeMinorUnits,
      expected.currency,
    );
    if (expected.currency !== actual.currency) {
      throw new ConflictError("Budget income currencies must match", "currency_mismatch");
    }
    const id = ulid();
    await db.insert(budgetPeriods).values({
      id,
      householdId: auth.householdId,
      ...(input.payCycleId ? { payCycleId: input.payCycleId } : {}),
      kind,
      startsOn,
      endsOn,
      currency: expected.currency,
      expectedIncome: expected.minor,
      actualIncome: actual.minor,
      status: normalizePeriodStatus(input.status) ?? "draft",
    });
    for (const allocation of input.envelopes ?? []) {
      await writeAllocation(db, auth.householdId, id, {
        envelopeId: allocation.id,
        ...(allocation.planned ? { planned: allocation.planned } : {}),
        ...(allocation.plannedMinorUnits
          ? { plannedMinorUnits: allocation.plannedMinorUnits }
          : {}),
        ...(allocation.funded ? { funded: allocation.funded } : {}),
        ...(allocation.fundedMinorUnits ? { fundedMinorUnits: allocation.fundedMinorUnits } : {}),
      });
    }
    return context.json((await budgetDtos(db, auth.householdId, id))[0]!, 201);
  });

  routes.post("/budget-periods", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = budgetWriteSchema.parse(await context.req.json());
    const startsOn = input.startDate ?? input.startsOn;
    const endsOn = input.endDate ?? input.endsOn;
    if (!startsOn || !endsOn) {
      throw new AppError("Budget start and end dates are required", 400, "invalid_budget");
    }
    const expected = optionalMoney(
      input.plannedIncome,
      input.expectedIncomeMinorUnits,
      input.currency ?? "USD",
    );
    const actual = optionalMoney(
      input.actualIncome,
      input.actualIncomeMinorUnits,
      expected.currency,
    );
    const id = ulid();
    await db.insert(budgetPeriods).values({
      id,
      householdId: auth.householdId,
      kind: input.kind ?? (input.periodKind === "plan" ? "custom" : input.periodKind) ?? "month",
      startsOn,
      endsOn,
      currency: expected.currency,
      expectedIncome: expected.minor,
      actualIncome: actual.minor,
      status: normalizePeriodStatus(input.status) ?? "draft",
      ...(input.payCycleId ? { payCycleId: input.payCycleId } : {}),
    });
    return context.json((await budgetDtos(db, auth.householdId, id))[0]!, 201);
  });

  routes.patch("/budgets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    const input = budgetWriteSchema.parse(await context.req.json());
    const expected = input.plannedIncome
      ? BigInt(input.plannedIncome.minorUnits)
      : input.expectedIncomeMinorUnits === undefined
        ? undefined
        : BigInt(input.expectedIncomeMinorUnits);
    const actual = input.actualIncome
      ? BigInt(input.actualIncome.minorUnits)
      : input.actualIncomeMinorUnits === undefined
        ? undefined
        : BigInt(input.actualIncomeMinorUnits);
    const nextCurrency =
      input.plannedIncome?.currency ??
      input.actualIncome?.currency ??
      input.currency ??
      current.currency;
    await db
      .update(budgetPeriods)
      .set({
        ...(input.periodKind || input.kind
          ? {
              kind:
                input.kind ??
                (input.periodKind === "plan" ? "custom" : input.periodKind) ??
                current.kind,
            }
          : {}),
        ...(input.startDate || input.startsOn
          ? { startsOn: input.startDate ?? input.startsOn }
          : {}),
        ...(input.endDate || input.endsOn ? { endsOn: input.endDate ?? input.endsOn } : {}),
        ...(expected === undefined ? {} : { expectedIncome: expected }),
        ...(actual === undefined ? {} : { actualIncome: actual }),
        currency: nextCurrency,
        ...(input.status === undefined ? {} : { status: normalizePeriodStatus(input.status) }),
        updatedAt: nowIso(),
      })
      .where(
        and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, current.id)),
      );
    if (input.funded && !input.envelopes) {
      const requestedFunding = BigInt(input.funded.minorUnits);
      const fundingPeriod = await requireBudgetPeriod(db, auth.householdId, current.id);
      if (
        input.funded.currency !== nextCurrency ||
        requestedFunding < 0n ||
        requestedFunding > fundingPeriod.expectedIncome
      ) {
        throw new AppError(
          "Funding must be between zero and the period's expected income and use its currency",
          400,
          "invalid_budget_funding",
        );
      }
      const persisted = await db
        .select({ allocation: envelopeAllocations, envelope: envelopes })
        .from(envelopeAllocations)
        .innerJoin(envelopes, eq(envelopes.id, envelopeAllocations.envelopeId))
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, current.id),
            eq(envelopes.householdId, auth.householdId),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
      const existingIds = new Set(persisted.map((item) => item.envelope.id));
      const activeRows = await db
        .select()
        .from(envelopes)
        .where(
          and(
            eq(envelopes.householdId, auth.householdId),
            eq(envelopes.isActive, true),
            eq(envelopes.currency, fundingPeriod.currency),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
      for (const envelope of activeRows) {
        if (existingIds.has(envelope.id)) continue;
        await writeAllocation(db, auth.householdId, fundingPeriod.id, {
          envelopeId: envelope.id,
          plannedMinorUnits: envelope.targetAmount.toString(),
          fundedMinorUnits: "0",
        });
      }
      const allocations = await db
        .select({ allocation: envelopeAllocations, envelope: envelopes })
        .from(envelopeAllocations)
        .innerJoin(envelopes, eq(envelopes.id, envelopeAllocations.envelopeId))
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, fundingPeriod.id),
            eq(envelopes.householdId, auth.householdId),
          ),
        )
        .orderBy(desc(envelopes.isRequired), desc(envelopes.priority), asc(envelopes.name));
      const activityByEnvelope = await calculateBudgetActivity(
        db,
        auth.householdId,
        fundingPeriod,
        allocations.map((item) => item.envelope),
      );
      let remainingFunding = requestedFunding;
      const desired = allocations.map((item) => {
        const fundedAmount =
          remainingFunding > item.allocation.planned ? item.allocation.planned : remainingFunding;
        remainingFunding -= fundedAmount;
        return { ...item, fundedAmount };
      });
      const batchId = ulid();
      await db.transaction(async (transaction) => {
        let sequence = 0;
        for (const { allocation, envelope, fundedAmount } of desired) {
          const liveActivity = activityByEnvelope.get(envelope.id) ?? 0n;
          await transaction
            .update(envelopeAllocations)
            .set({
              funded: fundedAmount,
              activity: liveActivity,
              availableSnapshot:
                fundedAmount + liveActivity + allocation.transferredIn - allocation.transferredOut,
              calculatedAt: nowIso(),
              updatedAt: nowIso(),
            })
            .where(
              and(
                eq(envelopeAllocations.householdId, auth.householdId),
                eq(envelopeAllocations.id, allocation.id),
              ),
            );
          const delta = fundedAmount - allocation.funded;
          if (delta === 0n) continue;
          await transaction.insert(allocationEntries).values({
            id: ulid(),
            householdId: auth.householdId,
            budgetPeriodId: fundingPeriod.id,
            batchId,
            sequence: sequence++,
            fromBucketType: delta > 0n ? "unassigned" : "envelope",
            fromBucketId: delta > 0n ? "cash" : envelope.id,
            toBucketType: delta > 0n ? "envelope" : "unassigned",
            toBucketId: delta > 0n ? envelope.id : "cash",
            amount: delta > 0n ? delta : -delta,
            currency: fundingPeriod.currency,
            kind: delta > 0n ? "fund" : "release",
            sourceType: "paycheck_plan",
            memo: `Fund ${envelope.name} by priority`,
            createdByUserId: auth.user.id,
          });
        }
      });
    }
    for (const allocation of input.envelopes ?? []) {
      await writeAllocation(db, auth.householdId, current.id, {
        envelopeId: allocation.id,
        ...(allocation.planned ? { planned: allocation.planned } : {}),
        ...(allocation.plannedMinorUnits
          ? { plannedMinorUnits: allocation.plannedMinorUnits }
          : {}),
        ...(allocation.funded ? { funded: allocation.funded } : {}),
        ...(allocation.fundedMinorUnits ? { fundedMinorUnits: allocation.fundedMinorUnits } : {}),
      });
    }
    return context.json((await budgetDtos(db, auth.householdId, current.id))[0]!);
  });

  routes.post("/budgets/:id/build-from-monthly-spend", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const period = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    if (period.status === "closed" || period.status === "archived") {
      throw new ConflictError("A closed budget plan cannot be rebuilt", "budget_closed");
    }
    const input = monthlyPlanSchema.parse(await context.req.json());
    const currencies = [
      ...(input.monthlyIncome ? [input.monthlyIncome.currency] : []),
      ...input.items.map((item) => item.monthlyAmount.currency),
    ];
    if (currencies.some((currency) => currency !== period.currency)) {
      throw new ConflictError(
        "Monthly plan amounts must use the budget currency",
        "currency_mismatch",
      );
    }
    await requireCategories(
      db,
      auth.householdId,
      input.items.flatMap((item) => (item.categoryId ? [item.categoryId] : [])),
    );
    const [existingEnvelopes, existingAllocations] = await Promise.all([
      db.select().from(envelopes).where(eq(envelopes.householdId, auth.householdId)),
      db
        .select()
        .from(envelopeAllocations)
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, period.id),
          ),
        ),
    ]);
    const envelopeByName = new Map(
      existingEnvelopes.map((envelope) => [envelope.name.toLocaleLowerCase(), envelope]),
    );
    const allocationByEnvelope = new Map(
      existingAllocations.map((allocation) => [allocation.envelopeId, allocation]),
    );
    const conversions: Array<{
      envelopeId: string;
      name: string;
      monthlyAmount: MoneyJson;
      perPaycheckAmount: MoneyJson;
    }> = [];
    await db.transaction(async (transaction) => {
      if (input.monthlyIncome) {
        await transaction
          .update(budgetPeriods)
          .set({
            expectedIncome: monthlyToPaycheck(
              BigInt(input.monthlyIncome.minorUnits),
              input.paychecksPerYear,
            ),
            updatedAt: nowIso(),
          })
          .where(
            and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, period.id)),
          );
      }
      for (const item of input.items) {
        const target = monthlyToPaycheck(
          BigInt(item.monthlyAmount.minorUnits),
          input.paychecksPerYear,
        );
        const existing = envelopeByName.get(item.name.toLocaleLowerCase());
        const envelopeId = existing?.id ?? ulid();
        if (existing) {
          await transaction
            .update(envelopes)
            .set({
              name: item.name,
              categoryId: item.categoryId ?? null,
              cadence: "paycheck",
              cadenceConfig: {
                source: "monthly_spend_builder",
                monthlyAmountMinorUnits: item.monthlyAmount.minorUnits,
                paychecksPerYear: input.paychecksPerYear,
              },
              rolloverPolicy: item.rolloverPolicy,
              priority: item.priority,
              minimumAmount: item.isRequired ? target : 0n,
              targetAmount: target,
              isRequired: item.isRequired,
              isActive: true,
              updatedAt: nowIso(),
            })
            .where(and(eq(envelopes.householdId, auth.householdId), eq(envelopes.id, envelopeId)));
        } else {
          await transaction.insert(envelopes).values({
            id: envelopeId,
            householdId: auth.householdId,
            name: item.name,
            categoryId: item.categoryId ?? null,
            cadence: "paycheck",
            cadenceConfig: {
              source: "monthly_spend_builder",
              monthlyAmountMinorUnits: item.monthlyAmount.minorUnits,
              paychecksPerYear: input.paychecksPerYear,
            },
            rolloverPolicy: item.rolloverPolicy,
            priority: item.priority,
            minimumAmount: item.isRequired ? target : 0n,
            targetAmount: target,
            currency: period.currency,
            isRequired: item.isRequired,
            isActive: true,
          });
        }
        await transaction
          .delete(envelopeCategoryLinks)
          .where(
            and(
              eq(envelopeCategoryLinks.householdId, auth.householdId),
              eq(envelopeCategoryLinks.envelopeId, envelopeId),
            ),
          );
        if (item.categoryId) {
          await transaction.insert(envelopeCategoryLinks).values({
            householdId: auth.householdId,
            envelopeId,
            categoryId: item.categoryId,
          });
        }
        const allocation = allocationByEnvelope.get(envelopeId);
        if (allocation) {
          await transaction
            .update(envelopeAllocations)
            .set({ planned: target, updatedAt: nowIso() })
            .where(
              and(
                eq(envelopeAllocations.householdId, auth.householdId),
                eq(envelopeAllocations.id, allocation.id),
              ),
            );
        } else {
          await transaction.insert(envelopeAllocations).values({
            id: ulid(),
            householdId: auth.householdId,
            budgetPeriodId: period.id,
            envelopeId,
            planned: target,
            funded: 0n,
            activity: 0n,
            transferredIn: 0n,
            transferredOut: 0n,
            availableSnapshot: 0n,
            currency: period.currency,
            calculatedAt: nowIso(),
          });
        }
        conversions.push({
          envelopeId,
          name: item.name,
          monthlyAmount: moneyJson(BigInt(item.monthlyAmount.minorUnits), period.currency),
          perPaycheckAmount: moneyJson(target, period.currency),
        });
      }
    });
    return context.json({
      budget: (await budgetDtos(db, auth.householdId, period.id))[0]!,
      conversions,
    });
  });

  routes.patch("/budget-periods/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    const input = budgetWriteSchema.parse(await context.req.json());
    await db
      .update(budgetPeriods)
      .set({
        ...(input.startDate || input.startsOn
          ? { startsOn: input.startDate ?? input.startsOn }
          : {}),
        ...(input.endDate || input.endsOn ? { endsOn: input.endDate ?? input.endsOn } : {}),
        ...(input.status ? { status: normalizePeriodStatus(input.status) } : {}),
        ...(input.expectedIncomeMinorUnits
          ? { expectedIncome: BigInt(input.expectedIncomeMinorUnits) }
          : {}),
        ...(input.actualIncomeMinorUnits
          ? { actualIncome: BigInt(input.actualIncomeMinorUnits) }
          : {}),
        updatedAt: nowIso(),
      })
      .where(
        and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, current.id)),
      );
    return context.json((await budgetDtos(db, auth.householdId, current.id))[0]!);
  });

  routes.delete("/budgets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await requireBudgetPeriod(db, auth.householdId, context.req.param("id"));
    await db
      .update(budgetPeriods)
      .set({ status: "archived", updatedAt: nowIso() })
      .where(
        and(eq(budgetPeriods.householdId, auth.householdId), eq(budgetPeriods.id, current.id)),
      );
    return context.body(null, 204);
  });

  routes.put("/budget-periods/:id/allocations", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = allocationWriteSchema.parse(await context.req.json());
    const id = await writeAllocation(db, auth.householdId, context.req.param("id"), input);
    return context.json({
      id,
      budget: (await budgetDtos(db, auth.householdId, context.req.param("id")))[0]!,
    });
  });

  routes.post("/allocations", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        budgetId: z.string(),
        from: z.string().trim().min(1).max(160).optional(),
        to: z.string().trim().min(1).max(160).optional(),
        fromEnvelopeId: z.string().nullable().optional(),
        toEnvelopeId: z.string().optional(),
        amount: MoneyJsonSchema,
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .superRefine((value, issueContext) => {
        if (!value.toEnvelopeId && !value.to) {
          issueContext.addIssue({
            code: "custom",
            path: ["toEnvelopeId"],
            message: "A destination envelope is required",
          });
        }
        if (value.fromEnvelopeId === undefined && !value.from) {
          issueContext.addIssue({
            code: "custom",
            path: ["fromEnvelopeId"],
            message: "Choose unassigned income or a source envelope",
          });
        }
      })
      .parse(await context.req.json());
    const period = await requireBudgetPeriod(db, auth.householdId, input.budgetId);
    if (input.amount.currency !== period.currency || BigInt(input.amount.minorUnits) <= 0n) {
      throw new AppError(
        "Allocation must be positive and use the budget currency",
        400,
        "invalid_allocation",
      );
    }
    const requestedIds = [
      ...(input.toEnvelopeId ? [input.toEnvelopeId] : []),
      ...(input.fromEnvelopeId ? [input.fromEnvelopeId] : []),
    ];
    const envelopeRows = requestedIds.length
      ? await db
          .select()
          .from(envelopes)
          .where(
            and(eq(envelopes.householdId, auth.householdId), inArray(envelopes.id, requestedIds)),
          )
      : await db
          .select()
          .from(envelopes)
          .where(
            and(
              eq(envelopes.householdId, auth.householdId),
              or(
                input.from ? eq(envelopes.name, input.from) : undefined,
                input.to ? eq(envelopes.name, input.to) : undefined,
              ),
            ),
          );
    const toEnvelope = input.toEnvelopeId
      ? envelopeRows.find((envelope) => envelope.id === input.toEnvelopeId)
      : envelopeRows.find((envelope) => envelope.name === input.to);
    if (!toEnvelope) throw new NotFoundError("Destination envelope");
    const fromEnvelope = input.fromEnvelopeId
      ? envelopeRows.find((envelope) => envelope.id === input.fromEnvelopeId)
      : input.fromEnvelopeId === null || input.from === "Unassigned income"
        ? undefined
        : envelopeRows.find((envelope) => envelope.name === input.from);
    if (input.fromEnvelopeId && !fromEnvelope) throw new NotFoundError("Source envelope");
    if (fromEnvelope?.id === toEnvelope.id) {
      throw new ConflictError("Source and destination must be different", "same_envelope");
    }
    const amount = BigInt(input.amount.minorUnits);
    const currentAllocations = await db
      .select()
      .from(envelopeAllocations)
      .where(
        and(
          eq(envelopeAllocations.householdId, auth.householdId),
          eq(envelopeAllocations.budgetPeriodId, period.id),
          inArray(envelopeAllocations.envelopeId, [
            toEnvelope.id,
            ...(fromEnvelope ? [fromEnvelope.id] : []),
          ]),
        ),
      );
    const byEnvelope = new Map(
      currentAllocations.map((allocation) => [allocation.envelopeId, allocation]),
    );
    const toAllocation = byEnvelope.get(toEnvelope.id);
    let fromAllocation = fromEnvelope ? byEnvelope.get(fromEnvelope.id) : undefined;
    const liveBudget = (await budgetDtos(db, auth.householdId, period.id))[0];
    if (!liveBudget) throw new NotFoundError("Budget period");
    const fromLive = fromEnvelope
      ? liveBudget.envelopes.find((envelope) => envelope.id === fromEnvelope.id)
      : undefined;
    const toLive = liveBudget.envelopes.find((envelope) => envelope.id === toEnvelope.id);
    const sourceAvailable = fromEnvelope
      ? BigInt(fromLive?.available.minorUnits ?? "0")
      : BigInt(liveBudget.unassigned.minorUnits);
    if (sourceAvailable < amount) {
      throw new ConflictError(
        fromEnvelope
          ? "Source envelope does not have enough available"
          : "Unassigned income does not have enough available",
        "insufficient_funds",
      );
    }
    if (fromEnvelope && !fromAllocation) {
      await writeAllocation(db, auth.householdId, period.id, {
        envelopeId: fromEnvelope.id,
        plannedMinorUnits: fromEnvelope.targetAmount.toString(),
        fundedMinorUnits: "0",
        activityMinorUnits: fromLive?.activity.minorUnits ?? "0",
      });
      fromAllocation = await db
        .select()
        .from(envelopeAllocations)
        .where(
          and(
            eq(envelopeAllocations.householdId, auth.householdId),
            eq(envelopeAllocations.budgetPeriodId, period.id),
            eq(envelopeAllocations.envelopeId, fromEnvelope.id),
          ),
        )
        .get();
    }
    const entryId = ulid();
    const batchId = ulid();
    await db.transaction(async (transaction) => {
      await transaction.insert(allocationEntries).values({
        id: entryId,
        householdId: auth.householdId,
        budgetPeriodId: period.id,
        batchId,
        sequence: 0,
        fromBucketType: fromEnvelope ? "envelope" : "unassigned",
        fromBucketId: fromEnvelope?.id ?? "cash",
        toBucketType: "envelope",
        toBucketId: toEnvelope.id,
        amount,
        currency: period.currency,
        kind: fromEnvelope ? "transfer" : "fund",
        sourceType: "user_allocation",
        memo: input.reason,
        createdByUserId: auth.user.id,
      });
      if (fromEnvelope && fromAllocation) {
        await transaction
          .update(envelopeAllocations)
          .set({
            transferredOut: fromAllocation.transferredOut + amount,
            activity: BigInt(fromLive?.activity.minorUnits ?? "0"),
            availableSnapshot: sourceAvailable - amount,
            calculatedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.id, fromAllocation.id),
            ),
          );
      }
      if (toAllocation) {
        const currentToAvailable = BigInt(toLive?.available.minorUnits ?? "0");
        await transaction
          .update(envelopeAllocations)
          .set({
            ...(fromEnvelope
              ? { transferredIn: toAllocation.transferredIn + amount }
              : { funded: toAllocation.funded + amount }),
            activity: BigInt(toLive?.activity.minorUnits ?? "0"),
            availableSnapshot: currentToAvailable + amount,
            calculatedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.id, toAllocation.id),
            ),
          );
      } else {
        const liveActivity = BigInt(toLive?.activity.minorUnits ?? "0");
        const liveAvailable = BigInt(toLive?.available.minorUnits ?? "0");
        await transaction.insert(envelopeAllocations).values({
          id: ulid(),
          householdId: auth.householdId,
          budgetPeriodId: period.id,
          envelopeId: toEnvelope.id,
          planned: toEnvelope.targetAmount,
          funded: fromEnvelope ? 0n : amount,
          activity: liveActivity,
          transferredIn: fromEnvelope ? amount : 0n,
          transferredOut: 0n,
          availableSnapshot: liveAvailable + amount,
          currency: period.currency,
          calculatedAt: nowIso(),
        });
      }
    });
    return context.json(
      {
        id: entryId,
        reversibleBatchId: batchId,
        budget: (await budgetDtos(db, auth.householdId, period.id))[0],
      },
      201,
    );
  });

  // Bills ------------------------------------------------------------------

  routes.get("/bills", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(bills)
      .where(eq(bills.householdId, auth.householdId))
      .orderBy(asc(bills.nextDueDate), asc(bills.name));
    return context.json(page(rows.map(billDto)));
  });

  routes.post("/bills", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = billCreateSchema.parse(await context.req.json());
    if (input.envelopeId) await requireEnvelope(db, auth.householdId, input.envelopeId);
    if (input.autopayAccountId) await requireAccount(db, auth.householdId, input.autopayAccountId);
    const minimum = optionalMoney(input.amountMin, input.amountMinMinorUnits, input.currency);
    const maximum = optionalMoney(
      input.amountMax,
      input.amountMaxMinorUnits ?? minimum.minor.toString(),
      minimum.currency,
    );
    if (minimum.currency !== maximum.currency) {
      throw new ConflictError("Bill amount currencies must match", "currency_mismatch");
    }
    const id = ulid();
    await db.insert(bills).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      ...(input.recurringSeriesId ? { recurringSeriesId: input.recurringSeriesId } : {}),
      ...(input.envelopeId ? { envelopeId: input.envelopeId } : {}),
      ...(input.autopayAccountId ? { autopayAccountId: input.autopayAccountId } : {}),
      dueRule: dbJson(input.dueRule),
      amountMin: minimum.minor,
      amountMax: maximum.minor,
      currency: minimum.currency,
      recurrenceConfidenceBps: input.recurrenceConfidenceBps,
      ...(input.nextDueDate ? { nextDueDate: input.nextDueDate } : {}),
      isRequired: input.isRequired,
      isActive: input.isActive,
    });
    const row = await db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, id)))
      .get();
    return context.json(billDto(row!), 201);
  });

  routes.patch("/bills/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Bill");
    const input = billPatchSchema.parse(await context.req.json());
    await db
      .update(bills)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.envelopeId === undefined ? {} : { envelopeId: input.envelopeId }),
        ...(input.autopayAccountId === undefined
          ? {}
          : { autopayAccountId: input.autopayAccountId }),
        ...(input.dueRule === undefined ? {} : { dueRule: dbJson(input.dueRule) }),
        ...(input.amountMin
          ? { amountMin: BigInt(input.amountMin.minorUnits), currency: input.amountMin.currency }
          : input.amountMinMinorUnits === undefined
            ? {}
            : { amountMin: BigInt(input.amountMinMinorUnits) }),
        ...(input.amountMax
          ? { amountMax: BigInt(input.amountMax.minorUnits), currency: input.amountMax.currency }
          : input.amountMaxMinorUnits === undefined
            ? {}
            : { amountMax: BigInt(input.amountMaxMinorUnits) }),
        ...(input.recurrenceConfidenceBps === undefined
          ? {}
          : { recurrenceConfidenceBps: input.recurrenceConfidenceBps }),
        ...(input.nextDueDate === undefined ? {} : { nextDueDate: input.nextDueDate }),
        ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: nowIso(),
      })
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, current.id)));
    const updated = await db
      .select()
      .from(bills)
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, current.id)))
      .get();
    return context.json(billDto(updated!));
  });

  routes.delete("/bills/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(bills)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(and(eq(bills.householdId, auth.householdId), eq(bills.id, context.req.param("id"))))
      .returning({ id: bills.id })
      .get();
    if (!result) throw new NotFoundError("Bill");
    return context.body(null, 204);
  });

  // Goals ------------------------------------------------------------------

  routes.get("/goals", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(goals)
      .where(eq(goals.householdId, auth.householdId))
      .orderBy(asc(goals.priority), asc(goals.name));
    return context.json(page(rows.map(goalDto)));
  });

  routes.put("/goals/order", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = goalOrderSchema.parse(await context.req.json());
    const rows = await db
      .select()
      .from(goals)
      .where(eq(goals.householdId, auth.householdId))
      .orderBy(asc(goals.priority), asc(goals.name));
    const householdIds = new Set(rows.map((goal) => goal.id));
    if (input.goalIds.some((id) => !householdIds.has(id))) throw new NotFoundError("Goal");
    const requestedIds = new Set(input.goalIds);
    const orderedIds = [
      ...input.goalIds,
      ...rows.filter((goal) => !requestedIds.has(goal.id)).map((goal) => goal.id),
    ];
    const updatedAt = nowIso();
    await db.transaction(async (transaction) => {
      for (const [index, id] of orderedIds.entries()) {
        await transaction
          .update(goals)
          .set({ priority: index + 1, updatedAt })
          .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, id)));
      }
    });
    const reordered = await db
      .select()
      .from(goals)
      .where(eq(goals.householdId, auth.householdId))
      .orderBy(asc(goals.priority), asc(goals.name));
    return context.json(page(reordered.map(goalDto)));
  });

  routes.post("/goals", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = goalCreateSchema.parse(await context.req.json());
    if (input.fundingAccountId) {
      await requireAccount(db, auth.householdId, input.fundingAccountId);
    }
    if (input.linkedDebtAccountId) {
      if (input.type !== "debt_payoff") {
        throw new ConflictError(
          "Only debt payoff goals can link a debt account",
          "linked_debt_requires_payoff_goal",
        );
      }
      const debtAccount = await requireAccount(db, auth.householdId, input.linkedDebtAccountId);
      if (debtAccount.group !== "credit" && debtAccount.group !== "loan") {
        throw new ConflictError(
          "A debt payoff goal must link to a credit or loan account",
          "invalid_debt_account",
        );
      }
    }
    const target = optionalMoney(input.target, input.targetAmountMinorUnits, input.currency);
    const funded = optionalMoney(input.funded, input.fundedAmountMinorUnits, target.currency);
    const monthly = optionalMoney(
      input.monthlyContribution,
      input.monthlyContributionMinorUnits,
      target.currency,
    );
    if (target.currency !== funded.currency || target.currency !== monthly.currency) {
      throw new ConflictError("Goal currencies must match", "currency_mismatch");
    }
    if (funded.minor > target.minor) {
      throw new ConflictError(
        "Goal funding cannot exceed its target",
        "goal_funding_exceeds_target",
      );
    }
    const id = ulid();
    const requestedStatus = input.paused ? "paused" : (input.status ?? "active");
    if (requestedStatus === "completed" && funded.minor < target.minor) {
      throw new ConflictError(
        "A goal cannot be completed before its target is funded",
        "goal_not_funded",
      );
    }
    const status =
      requestedStatus === "cancelled"
        ? "cancelled"
        : funded.minor === target.minor
          ? "completed"
          : requestedStatus;
    const basePolicy = {
      strategy: "fixed_monthly",
      monthlyAmountMinorUnits: monthly.minor.toString(),
    };
    const customPolicy =
      input.contributionPolicy && typeof input.contributionPolicy === "object"
        ? input.contributionPolicy
        : {};
    await db.insert(goals).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      type: input.type === "investment" ? "investment_milestone" : input.type,
      targetAmount: target.minor,
      fundedAmount: funded.minor,
      currency: target.currency,
      ...(input.targetDate ? { targetDate: input.targetDate } : {}),
      priority: input.priority,
      ...(input.fundingAccountId ? { fundingAccountId: input.fundingAccountId } : {}),
      ...(input.linkedDebtAccountId ? { linkedDebtAccountId: input.linkedDebtAccountId } : {}),
      contributionPolicy: dbJson({ ...customPolicy, ...basePolicy }),
      ...(input.bufferPolicy === undefined
        ? {}
        : { bufferPolicy: dbJsonOrNull(input.bufferPolicy) }),
      liquidityConstraint: input.liquidityConstraint,
      status,
      ...(status === "completed" ? { completedAt: nowIso() } : {}),
    });
    const row = await db
      .select()
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, id)))
      .get();
    if (!row) throw new NotFoundError("Goal");
    return context.json(goalDto(row), 201);
  });

  routes.patch("/goals/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Goal");
    const input = goalPatchSchema.parse(await context.req.json());
    const nextType = input.type ?? goalTypeForWeb(current.type);
    const nextLinkedDebtAccountId =
      input.linkedDebtAccountId === undefined
        ? current.linkedDebtAccountId
        : input.linkedDebtAccountId;
    if (nextLinkedDebtAccountId && nextType !== "debt_payoff") {
      throw new ConflictError(
        "Only debt payoff goals can link a debt account",
        "linked_debt_requires_payoff_goal",
      );
    }
    if (input.fundingAccountId) {
      await requireAccount(db, auth.householdId, input.fundingAccountId);
    }
    if (input.linkedDebtAccountId) {
      const debtAccount = await requireAccount(db, auth.householdId, input.linkedDebtAccountId);
      if (debtAccount.group !== "credit" && debtAccount.group !== "loan") {
        throw new ConflictError(
          "A debt payoff goal must link to a credit or loan account",
          "invalid_debt_account",
        );
      }
    }
    const target = input.target
      ? { amount: BigInt(input.target.minorUnits), currency: input.target.currency }
      : input.targetAmountMinorUnits === undefined
        ? undefined
        : { amount: BigInt(input.targetAmountMinorUnits), currency: current.currency };
    const funded = input.funded
      ? { amount: BigInt(input.funded.minorUnits), currency: input.funded.currency }
      : input.fundedAmountMinorUnits === undefined
        ? undefined
        : { amount: BigInt(input.fundedAmountMinorUnits), currency: current.currency };
    const monthly = input.monthlyContribution
      ? input.monthlyContribution.minorUnits
      : input.monthlyContributionMinorUnits;
    if (
      (target && target.currency !== current.currency) ||
      (funded && funded.currency !== current.currency) ||
      (input.monthlyContribution && input.monthlyContribution.currency !== current.currency)
    ) {
      throw new ConflictError("Goal currency cannot be changed", "currency_mismatch");
    }
    const nextTarget = target?.amount ?? current.targetAmount;
    const nextFunded = funded?.amount ?? current.fundedAmount;
    if (nextFunded > nextTarget) {
      throw new ConflictError(
        "Goal funding cannot exceed its target",
        "goal_funding_exceeds_target",
      );
    }
    const existingPolicy =
      current.contributionPolicy && typeof current.contributionPolicy === "object"
        ? current.contributionPolicy
        : {};
    const customPolicy =
      input.contributionPolicy && typeof input.contributionPolicy === "object"
        ? input.contributionPolicy
        : {};
    const requestedStatus =
      input.paused === true
        ? "paused"
        : input.paused === false && current.status === "paused"
          ? "active"
          : input.status;
    if (requestedStatus === "completed" && nextFunded < nextTarget) {
      throw new ConflictError(
        "A goal cannot be completed before its target is funded",
        "goal_not_funded",
      );
    }
    const priorOrRequestedStatus = requestedStatus ?? current.status;
    const status =
      priorOrRequestedStatus === "cancelled"
        ? "cancelled"
        : nextFunded === nextTarget
          ? "completed"
          : priorOrRequestedStatus === "completed"
            ? "active"
            : priorOrRequestedStatus;
    await db
      .update(goals)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.type === undefined
          ? {}
          : { type: input.type === "investment" ? "investment_milestone" : input.type }),
        ...(target === undefined ? {} : { targetAmount: target.amount, currency: target.currency }),
        ...(funded === undefined ? {} : { fundedAmount: funded.amount, currency: funded.currency }),
        ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.fundingAccountId === undefined
          ? {}
          : { fundingAccountId: input.fundingAccountId }),
        ...(input.linkedDebtAccountId === undefined
          ? {}
          : { linkedDebtAccountId: input.linkedDebtAccountId }),
        ...(monthly === undefined && input.contributionPolicy === undefined
          ? {}
          : {
              contributionPolicy: dbJson({
                ...existingPolicy,
                ...customPolicy,
                ...(monthly === undefined ? {} : { monthlyAmountMinorUnits: monthly }),
              }),
            }),
        ...(input.bufferPolicy === undefined
          ? {}
          : { bufferPolicy: dbJsonOrNull(input.bufferPolicy) }),
        ...(input.liquidityConstraint === undefined
          ? {}
          : { liquidityConstraint: input.liquidityConstraint }),
        status,
        completedAt: status === "completed" ? (current.completedAt ?? nowIso()) : null,
        updatedAt: nowIso(),
      })
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, current.id)));
    const updated = await db
      .select()
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, current.id)))
      .get();
    if (!updated) throw new NotFoundError("Goal");
    return context.json(goalDto(updated));
  });

  routes.delete("/goals/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(goals)
      .set({ status: "cancelled", updatedAt: nowIso() })
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, context.req.param("id"))))
      .returning({ id: goals.id })
      .get();
    if (!result) throw new NotFoundError("Goal");
    return context.body(null, 204);
  });

  routes.get("/goals/:id/contributions", async (context) => {
    const auth = context.get("auth");
    const goal = await db
      .select({ id: goals.id })
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, context.req.param("id"))))
      .get();
    if (!goal) throw new NotFoundError("Goal");
    const rows = await db
      .select()
      .from(goalContributions)
      .where(
        and(
          eq(goalContributions.householdId, auth.householdId),
          eq(goalContributions.goalId, goal.id),
        ),
      )
      .orderBy(desc(goalContributions.contributedOn), desc(goalContributions.id));
    return context.json(
      page(
        rows.map((row) => ({
          ...row,
          amount: moneyJson(row.amount, row.currency),
        })),
      ),
    );
  });

  routes.post("/goals/:id/contributions", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const goal = await db
      .select()
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, context.req.param("id"))))
      .get();
    if (!goal) throw new NotFoundError("Goal");
    const input = goalContributionSchema.parse(await context.req.json());
    const amount = optionalMoney(
      input.amount,
      input.amountMinorUnits,
      input.currency ?? goal.currency,
    );
    if (amount.currency !== goal.currency) {
      throw new ConflictError("Contribution currency must match the goal", "currency_mismatch");
    }
    if (goal.status === "cancelled") {
      throw new ConflictError("Archived goals cannot receive funding", "goal_archived");
    }
    if (goal.status === "completed") {
      throw new ConflictError("This goal is already fully funded", "goal_already_funded");
    }
    const remaining = goal.targetAmount - goal.fundedAmount;
    if (amount.minor > remaining) {
      throw new ConflictError(
        "Contribution cannot exceed the goal's remaining amount",
        "contribution_exceeds_remaining",
      );
    }
    const contributionId = ulid();
    const allocationId = ulid();
    const batchId = ulid();
    await db.transaction(async (transaction) => {
      const latestGoal = await transaction
        .select()
        .from(goals)
        .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, goal.id)))
        .get();
      if (!latestGoal || latestGoal.status === "cancelled") {
        throw new ConflictError("Archived goals cannot receive funding", "goal_archived");
      }
      const latestRemaining = latestGoal.targetAmount - latestGoal.fundedAmount;
      if (latestGoal.status === "completed" || latestRemaining <= 0n) {
        throw new ConflictError("This goal is already fully funded", "goal_already_funded");
      }
      if (amount.minor > latestRemaining) {
        throw new ConflictError(
          "Contribution cannot exceed the goal's remaining amount",
          "contribution_exceeds_remaining",
        );
      }
      await transaction.insert(allocationEntries).values({
        id: allocationId,
        householdId: auth.householdId,
        batchId,
        sequence: 0,
        fromBucketType: "unassigned",
        fromBucketId: "cash",
        toBucketType: "goal",
        toBucketId: goal.id,
        amount: amount.minor,
        currency: goal.currency,
        kind: "contribution",
        sourceType: "manual_goal_contribution",
        sourceId: contributionId,
        ...(input.note ? { memo: input.note } : {}),
        createdByUserId: auth.user.id,
      });
      await transaction.insert(goalContributions).values({
        id: contributionId,
        householdId: auth.householdId,
        goalId: goal.id,
        allocationEntryId: allocationId,
        amount: amount.minor,
        currency: goal.currency,
        contributedOn: input.contributedOn,
        ...(input.note ? { note: input.note } : {}),
      });
      const fundedAmount = latestGoal.fundedAmount + amount.minor;
      const completed = fundedAmount === latestGoal.targetAmount;
      await transaction
        .update(goals)
        .set({
          fundedAmount,
          ...(completed ? { status: "completed" as const, completedAt: nowIso() } : {}),
          updatedAt: nowIso(),
        })
        .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, goal.id)));
    });
    const updated = await db
      .select()
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, goal.id)))
      .get();
    if (!updated) throw new NotFoundError("Goal");
    return context.json(
      {
        id: contributionId,
        contributionId,
        allocationEntryId: allocationId,
        amount: moneyJson(amount.minor, amount.currency),
        contributedOn: input.contributedOn,
        goal: goalDto(updated),
      },
      201,
    );
  });

  // Deterministic categorization rules ------------------------------------

  routes.get("/rules", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(rules)
      .where(eq(rules.householdId, auth.householdId))
      .orderBy(desc(rules.priority), desc(rules.specificityScore), asc(rules.name));
    return context.json(page(rows.map(ruleDto)));
  });

  routes.post("/rules", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = ruleWriteSchema.parse(await context.req.json());
    const condition = input.conditions ?? input.condition!;
    await validateRuleReferences(db, auth.householdId, condition, input.actions);
    const id = ulid();
    await db.insert(rules).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      priority: input.priority,
      isEnabled: input.enabled,
      origin: "user",
      conditions: dbJson(condition),
      actions: dbJson(input.actions),
      specificityScore: ruleSpecificity(condition),
      createdByUserId: auth.user.id,
    });
    const row = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, id)))
      .get();
    return context.json(ruleDto(row!), 201);
  });

  routes.patch("/rules/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Rule");
    const input = rulePatchSchema.parse(await context.req.json());
    const condition = input.conditions ?? input.condition;
    if (current.origin === "system" && Object.keys(input).some((key) => key !== "enabled")) {
      throw new AppError(
        "System rules can be enabled or disabled, but their logic cannot be edited",
        409,
        "system_rule_read_only",
      );
    }
    const nextCondition = RuleConditionSchema.parse(condition ?? current.conditions);
    const nextActions = z.array(RuleActionSchema).parse(input.actions ?? current.actions);
    await validateRuleReferences(db, auth.householdId, nextCondition, nextActions);
    await db
      .update(rules)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.enabled === undefined ? {} : { isEnabled: input.enabled }),
        ...(condition === undefined
          ? {}
          : { conditions: dbJson(condition), specificityScore: ruleSpecificity(condition) }),
        ...(input.actions === undefined ? {} : { actions: dbJson(input.actions) }),
        updatedAt: nowIso(),
      })
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, current.id)));
    const updated = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, current.id)))
      .get();
    return context.json(ruleDto(updated!));
  });

  routes.delete("/rules/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const selected = await db
      .select({ id: rules.id, origin: rules.origin })
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, context.req.param("id"))))
      .get();
    if (!selected) throw new NotFoundError("Rule");
    if (selected.origin === "system") {
      throw new AppError(
        "System rules can be disabled, but not deleted",
        409,
        "system_rule_read_only",
      );
    }
    await db.transaction(async (transaction) => {
      await transaction
        .update(ruleRuns)
        .set({ winningRuleId: null })
        .where(
          and(eq(ruleRuns.householdId, auth.householdId), eq(ruleRuns.winningRuleId, selected.id)),
        );
      await transaction
        .delete(rules)
        .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, selected.id)));
    });
    return context.body(null, 204);
  });

  routes.post("/rules/preview", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        name: z.string().trim().min(1).max(160).default("Rule preview"),
        priority: z.number().int().default(100),
        conditions: RuleConditionSchema.optional(),
        condition: RuleConditionSchema.optional(),
        actions: z.array(RuleActionSchema).min(1).max(50),
        transactionIds: z.array(z.string()).max(2_000).optional(),
        excludeRuleId: z.string().min(1).max(128).optional(),
      })
      .strict()
      .parse(await context.req.json());
    const condition = input.conditions ?? input.condition;
    if (!condition) throw new AppError("A rule condition is required", 400, "invalid_rule");
    await validateRuleReferences(db, auth.householdId, condition, input.actions);
    const candidate = CategorizationRuleSchema.parse({
      id: ulid(),
      name: input.name,
      priority: input.priority,
      enabled: true,
      origin: "user",
      condition,
      actions: input.actions,
      updatedAt: nowIso(),
    });
    const records = await loadRuleTransactions(db, auth.householdId, input.transactionIds, 2_000);
    const matching = records.filter((record) => evaluateRules(record.ruleTransaction, [candidate]));
    const currency = matching[0]?.transaction.currency ?? "USD";
    const aggregate = matching.reduce(
      (sum, record) =>
        record.transaction.currency === currency ? sum + record.transaction.amount : sum,
      0n,
    );
    const existing = (
      await db
        .select()
        .from(rules)
        .where(and(eq(rules.householdId, auth.householdId), eq(rules.isEnabled, true)))
    ).filter((rule) => rule.id !== input.excludeRuleId);
    const conflictIds = new Set<string>();
    for (const record of matching) {
      for (const rule of existing) {
        if (evaluateRules(record.ruleTransaction, [engineRule(rule)])) conflictIds.add(rule.id);
      }
    }
    return context.json({
      matchCount: matching.length,
      aggregateAmount: moneyJson(aggregate, currency),
      samples: matching.slice(0, 20).map((record) => ({
        id: record.transaction.id,
        effectiveDate:
          record.transaction.postedAt ??
          record.transaction.authorizedAt ??
          record.transaction.transactedOn,
        description: record.transaction.rawDescription,
        merchant: record.merchantName ?? record.transaction.normalizedDescription,
        amount: moneyJson(record.transaction.amount, record.transaction.currency),
        accountName: record.account.name,
        categoryName: "Preview",
        status: record.transaction.status === "pending" ? "pending" : "posted",
        reviewState: record.transaction.reviewState === "needs_review" ? "needs_review" : "ready",
        source: record.transaction.source === "provider" ? "simplefin" : record.transaction.source,
        tags: record.tagIds,
      })),
      conflicts: existing.filter((rule) => conflictIds.has(rule.id)).map(ruleDto),
    });
  });

  routes.post("/rules/:id/apply", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const selected = await db
      .select()
      .from(rules)
      .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, context.req.param("id"))))
      .get();
    if (!selected) throw new NotFoundError("Rule");
    const input = z
      .object({ transactionIds: z.array(z.string()).min(1).max(2_000).optional() })
      .strict()
      .parse(await context.req.json().catch(() => ({})));
    const records = await loadRuleTransactions(db, auth.householdId, input.transactionIds, 2_000);
    const selectedEngineRule = engineRule(selected);
    await validateRuleReferences(
      db,
      auth.householdId,
      RuleConditionSchema.parse(selected.conditions),
      z.array(RuleActionSchema).parse(selected.actions),
    );
    const matches = records
      .map((record) => ({
        record,
        evaluation: evaluateRules(record.ruleTransaction, [selectedEngineRule]),
      }))
      .filter((item): item is typeof item & { evaluation: NonNullable<typeof item.evaluation> } =>
        Boolean(item.evaluation),
      );
    const tagIds = [...new Set(matches.flatMap(({ evaluation }) => evaluation.patch.tagIds))];
    if (tagIds.length) {
      const validTags = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.householdId, auth.householdId), inArray(tags.id, tagIds)));
      if (validTags.length !== tagIds.length) {
        throw new AppError("Rule references an unavailable tag", 400, "invalid_rule_reference");
      }
    }
    const merchantIds = new Map<string, string>();
    for (const { evaluation } of matches) {
      if (evaluation.patch.merchant && !merchantIds.has(evaluation.patch.merchant)) {
        merchantIds.set(
          evaluation.patch.merchant,
          await ensureMerchant(db, auth.householdId, evaluation.patch.merchant),
        );
      }
    }
    const batchId = ulid();
    await db.transaction(async (transaction) => {
      for (const { record, evaluation } of matches) {
        const patch = evaluation.patch;
        const merchantId = patch.merchant ? merchantIds.get(patch.merchant) : undefined;
        await transaction
          .update(transactions)
          .set({
            ...(patch.categoryId
              ? { categoryId: patch.categoryId, categoryOrigin: "rule" as const }
              : {}),
            ...(patch.envelopeId ? { envelopeId: patch.envelopeId } : {}),
            ...(merchantId ? { merchantId } : {}),
            ...(patch.flags.transfer === undefined ? {} : { isTransfer: patch.flags.transfer }),
            ...(patch.flags.income === undefined ? {} : { isIncome: patch.flags.income }),
            ...(patch.flags.reimbursement === undefined
              ? {}
              : { isReimbursement: patch.flags.reimbursement }),
            ...(patch.flags.reportingExcluded === undefined
              ? {}
              : { isExcluded: patch.flags.reportingExcluded }),
            ...(patch.recurringSeriesId ? { recurringSeriesId: patch.recurringSeriesId } : {}),
            ...(patch.note === undefined ? {} : { note: patch.note }),
            ...(patch.needsReview === undefined
              ? {}
              : { reviewState: patch.needsReview ? ("needs_review" as const) : ("none" as const) }),
            updatedAt: nowIso(),
          })
          .where(
            and(
              eq(transactions.householdId, auth.householdId),
              eq(transactions.id, record.transaction.id),
            ),
          );
        await transaction
          .delete(transactionTags)
          .where(
            and(
              eq(transactionTags.householdId, auth.householdId),
              eq(transactionTags.transactionId, record.transaction.id),
            ),
          );
        if (patch.tagIds.length) {
          await transaction.insert(transactionTags).values(
            patch.tagIds.map((tagId) => ({
              householdId: auth.householdId,
              transactionId: record.transaction.id,
              tagId,
            })),
          );
        }
        if (patch.splits) {
          await transaction
            .delete(transactionSplits)
            .where(
              and(
                eq(transactionSplits.householdId, auth.householdId),
                eq(transactionSplits.transactionId, record.transaction.id),
              ),
            );
          await transaction.insert(transactionSplits).values(
            patch.splits.map((split, sequence) => ({
              id: ulid(),
              householdId: auth.householdId,
              transactionId: record.transaction.id,
              sequence,
              amount: split.amount.minorUnits,
              categoryId: split.categoryId,
              ...(split.envelopeId ? { envelopeId: split.envelopeId } : {}),
              ...(split.memo ? { memo: split.memo } : {}),
            })),
          );
        }
        await transaction.insert(ruleRuns).values({
          id: ulid(),
          householdId: auth.householdId,
          transactionId: record.transaction.id,
          winningRuleId: selected.id,
          competingRuleIds: [],
          beforeSnapshot: dbJson({
            categoryId: record.transaction.categoryId,
            envelopeId: record.transaction.envelopeId,
            merchantId: record.transaction.merchantId,
            amountMinorUnits: record.transaction.amount.toString(),
            tagIds: record.tagIds,
          }),
          afterSnapshot: dbJson(transactionRulePatchToJson(patch)),
          explanation: evaluation.explanation,
          reversibleBatchId: batchId,
        });
      }
      if (matches.length) {
        await transaction
          .update(rules)
          .set({
            matchCount: selected.matchCount + matches.length,
            lastMatchedAt: nowIso(),
            updatedAt: nowIso(),
          })
          .where(and(eq(rules.householdId, auth.householdId), eq(rules.id, selected.id)));
      }
    });
    return context.json({
      affected: matches.length,
      reversibleBatchId: batchId,
      transactionIds: matches.map(({ record }) => record.transaction.id),
    });
  });

  // Wealth forecasts -------------------------------------------------------

  routes.get("/scenarios", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(forecastScenarios)
      .where(eq(forecastScenarios.householdId, auth.householdId))
      .orderBy(desc(forecastScenarios.isBase), asc(forecastScenarios.name));
    return context.json(page(rows.filter((row) => row.isActive).map(uiScenarioDto)));
  });

  routes.post("/scenarios", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = z
      .object({
        name: z.string().trim().min(1).max(160),
        preset: z.enum(["conservative", "baseline", "ambitious", "custom"]),
        assumptions: uiForecastAssumptionsSchema,
        seed: z.union([z.number().finite(), z.string()]),
        isBase: z.boolean().default(false),
        horizonMonths: z.number().int().min(1).max(1_200).optional(),
      })
      .strict()
      .parse(await context.req.json());
    const horizonMonths =
      input.horizonMonths ?? (await defaultForecastHorizonMonths(db, auth.user.id));
    const scenario = await buildLedgerForecastScenario(
      db,
      auth.householdId,
      input.name,
      input.assumptions,
      horizonMonths,
    );
    const id = ulid();
    await db.transaction(async (transaction) => {
      if (input.isBase) {
        await transaction
          .update(forecastScenarios)
          .set({ isBase: false, updatedAt: nowIso() })
          .where(eq(forecastScenarios.householdId, auth.householdId));
      }
      await transaction.insert(forecastScenarios).values({
        id,
        householdId: auth.householdId,
        name: input.name,
        preset: input.preset,
        assumptions: dbJson({
          scenario,
          uiAssumptions: input.assumptions,
          monteCarlo: {
            assumptions: [
              {
                assetClass: "growth",
                meanAnnualReturnBps: Math.round(input.assumptions.investmentReturn * 100),
                annualVolatilityBps: 1_800,
              },
            ],
          },
        }),
        seed: String(input.seed),
        horizonMonths: scenario.horizonMonths,
        reportingCurrency: scenario.baseCurrency,
        isBase: input.isBase,
        isActive: true,
        createdByUserId: auth.user.id,
      });
    });
    const row = await db
      .select()
      .from(forecastScenarios)
      .where(and(eq(forecastScenarios.householdId, auth.householdId), eq(forecastScenarios.id, id)))
      .get();
    if (!row) throw new NotFoundError("Forecast scenario");
    return context.json(uiScenarioDto(row), 201);
  });

  routes.patch("/scenarios/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(forecastScenarios)
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, context.req.param("id")),
        ),
      )
      .get();
    if (!current) throw new NotFoundError("Forecast scenario");
    const input = z
      .object({
        name: z.string().trim().min(1).max(160).optional(),
        preset: z.enum(["conservative", "baseline", "ambitious", "custom"]).optional(),
        assumptions: uiForecastAssumptionsSchema.optional(),
        seed: z.union([z.number().finite(), z.string()]).optional(),
        isBase: z.boolean().optional(),
      })
      .strict()
      .parse(await context.req.json());
    const stored = parseStoredForecastAssumptions(current.assumptions);
    const currentUi = uiScenarioDto(current).assumptions;
    const uiAssumptions = input.assumptions ?? currentUi;
    const scenario = await buildLedgerForecastScenario(
      db,
      auth.householdId,
      input.name ?? current.name,
      uiAssumptions,
      current.horizonMonths,
    );
    await db.transaction(async (transaction) => {
      if (input.isBase) {
        await transaction
          .update(forecastScenarios)
          .set({ isBase: false, updatedAt: nowIso() })
          .where(eq(forecastScenarios.householdId, auth.householdId));
      }
      await transaction
        .update(forecastScenarios)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.preset === undefined ? {} : { preset: input.preset }),
          assumptions: dbJson({
            scenario,
            uiAssumptions,
            monteCarlo: {
              ...(stored.monteCarlo ?? {}),
              assumptions: [
                {
                  assetClass: "growth",
                  meanAnnualReturnBps: Math.round(uiAssumptions.investmentReturn * 100),
                  annualVolatilityBps: 1_800,
                },
              ],
            },
          }),
          ...(input.seed === undefined ? {} : { seed: String(input.seed) }),
          ...(input.isBase === undefined ? {} : { isBase: input.isBase }),
          horizonMonths: scenario.horizonMonths,
          reportingCurrency: scenario.baseCurrency,
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(forecastScenarios.householdId, auth.householdId),
            eq(forecastScenarios.id, current.id),
          ),
        );
    });
    const row = await db
      .select()
      .from(forecastScenarios)
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, current.id),
        ),
      )
      .get();
    if (!row) throw new NotFoundError("Forecast scenario");
    return context.json(uiScenarioDto(row));
  });

  routes.delete("/scenarios/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(forecastScenarios)
      .set({ isActive: false, isBase: false, updatedAt: nowIso() })
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, context.req.param("id")),
        ),
      )
      .returning({ id: forecastScenarios.id })
      .get();
    if (!result) throw new NotFoundError("Forecast scenario");
    return context.body(null, 204);
  });

  routes.get("/forecast-scenarios", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(forecastScenarios)
      .where(eq(forecastScenarios.householdId, auth.householdId))
      .orderBy(desc(forecastScenarios.isBase), asc(forecastScenarios.name));
    return context.json(page(rows.map(forecastScenarioDto)));
  });

  routes.post("/forecast-scenarios", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = forecastScenarioWriteSchema.parse(await context.req.json());
    if (input.horizonMonths && input.horizonMonths !== input.scenario.horizonMonths) {
      throw new ConflictError("Scenario horizon fields must match", "forecast_horizon_mismatch");
    }
    if (input.reportingCurrency && input.reportingCurrency !== input.scenario.baseCurrency) {
      throw new ConflictError("Scenario currencies must match", "currency_mismatch");
    }
    const id = ulid();
    await db.transaction(async (transaction) => {
      if (input.isBase) {
        await transaction
          .update(forecastScenarios)
          .set({ isBase: false, updatedAt: nowIso() })
          .where(eq(forecastScenarios.householdId, auth.householdId));
      }
      await transaction.insert(forecastScenarios).values({
        id,
        householdId: auth.householdId,
        name: input.name,
        preset: input.preset,
        assumptions: dbJson({
          scenario: input.scenario,
          ...(input.monteCarlo ? { monteCarlo: input.monteCarlo } : {}),
        }),
        seed: String(input.seed),
        horizonMonths: input.scenario.horizonMonths,
        reportingCurrency: input.scenario.baseCurrency,
        isBase: input.isBase,
        isActive: input.isActive,
        createdByUserId: auth.user.id,
      });
    });
    const row = await db
      .select()
      .from(forecastScenarios)
      .where(and(eq(forecastScenarios.householdId, auth.householdId), eq(forecastScenarios.id, id)))
      .get();
    return context.json(forecastScenarioDto(row!), 201);
  });

  routes.patch("/forecast-scenarios/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(forecastScenarios)
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, context.req.param("id")),
        ),
      )
      .get();
    if (!current) throw new NotFoundError("Forecast scenario");
    const input = forecastScenarioPatchSchema.parse(await context.req.json());
    const stored = parseStoredForecastAssumptions(current.assumptions);
    const scenario = input.scenario ?? stored.scenario;
    await db.transaction(async (transaction) => {
      if (input.isBase) {
        await transaction
          .update(forecastScenarios)
          .set({ isBase: false, updatedAt: nowIso() })
          .where(eq(forecastScenarios.householdId, auth.householdId));
      }
      await transaction
        .update(forecastScenarios)
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.preset === undefined ? {} : { preset: input.preset }),
          assumptions: dbJson({
            scenario,
            ...((input.monteCarlo ?? stored.monteCarlo)
              ? { monteCarlo: input.monteCarlo ?? stored.monteCarlo }
              : {}),
          }),
          ...(input.seed === undefined ? {} : { seed: String(input.seed) }),
          horizonMonths: scenario.horizonMonths,
          reportingCurrency: scenario.baseCurrency,
          ...(input.isBase === undefined ? {} : { isBase: input.isBase }),
          ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
          updatedAt: nowIso(),
        })
        .where(
          and(
            eq(forecastScenarios.householdId, auth.householdId),
            eq(forecastScenarios.id, current.id),
          ),
        );
    });
    const updated = await db
      .select()
      .from(forecastScenarios)
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, current.id),
        ),
      )
      .get();
    return context.json(forecastScenarioDto(updated!));
  });

  routes.delete("/forecast-scenarios/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(forecastScenarios)
      .set({ isActive: false, isBase: false, updatedAt: nowIso() })
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, context.req.param("id")),
        ),
      )
      .returning({ id: forecastScenarios.id })
      .get();
    if (!result) throw new NotFoundError("Forecast scenario");
    return context.body(null, 204);
  });

  routes.get("/forecasts", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(forecastRuns)
      .where(eq(forecastRuns.householdId, auth.householdId))
      .orderBy(desc(forecastRuns.createdAt))
      .limit(100);
    return context.json(page(rows.map(forecastRunDto)));
  });

  routes.post("/forecasts", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = forecastRunRequestSchema.parse(await context.req.json());
    const scenarioRow = await db
      .select()
      .from(forecastScenarios)
      .where(
        and(
          eq(forecastScenarios.householdId, auth.householdId),
          eq(forecastScenarios.id, input.scenarioId),
          eq(forecastScenarios.isActive, true),
        ),
      )
      .get();
    if (!scenarioRow) throw new NotFoundError("Active forecast scenario");
    const stored = parseStoredForecastAssumptions(scenarioRow.assumptions);
    const scenario = engineScenario(stored.scenario);
    const planningDefaults = await loadPlanningForecastDefaults(db, auth.householdId);
    const deterministic = runForecast(scenario);
    const deterministicJson = forecastResultToJson(deterministic);
    const runSeed = String(input.seed ?? scenarioRow.seed);
    let monteCarloJson: StoredMonteCarloOutput | null = null;
    if (input.monteCarloRuns) {
      const configuredAssumptions = stored.monteCarlo?.assumptions ?? [];
      const assumptionsByClass = new Map(
        configuredAssumptions.map((assumption) => [assumption.assetClass, assumption]),
      );
      for (const account of scenario.accounts) {
        if (!account.assetClass || assumptionsByClass.has(account.assetClass)) continue;
        assumptionsByClass.set(account.assetClass, {
          assetClass: account.assetClass,
          meanAnnualReturnBps: account.annualReturnBps ?? 700,
          annualVolatilityBps: 1_500,
        });
      }
      const defaultSuccessTarget =
        planningDefaults.currency === scenario.baseCurrency &&
        planningDefaults.preferences.targetLiquidNetWorthMinorUnits !== undefined
          ? moneyJson(
              BigInt(planningDefaults.preferences.targetLiquidNetWorthMinorUnits),
              scenario.baseCurrency,
            )
          : undefined;
      const successTarget =
        input.successTarget ?? stored.monteCarlo?.successTarget ?? defaultSuccessTarget;
      const successMonth = input.successMonth ?? stored.monteCarlo?.successMonth;
      const monte = runMonteCarlo({
        scenario,
        seed: runSeed,
        runs: input.monteCarloRuns,
        assumptions: [...assumptionsByClass.values()],
        ...(stored.monteCarlo?.correlationMatrix
          ? { correlationMatrix: stored.monteCarlo.correlationMatrix }
          : {}),
        ...(successTarget ? { successTarget: moneyFromJson(successTarget) } : {}),
        ...(successMonth ? { successMonth } : {}),
      });
      monteCarloJson = monteCarloResultToJson(monte);
    }
    const missingInputs = [
      ...(scenario.accounts.length === 0 ? ["accounts"] : []),
      ...(scenario.cashFlows.length === 0 ? ["cash flows"] : []),
      ...(scenario.minimumCashBuffer ? [] : ["minimum cash buffer"]),
      ...(scenario.debts ?? []).flatMap((debt) => [
        ...(debt.annualInterestBps === 0 ? [`${debt.name ?? debt.id} APR`] : []),
        ...(debt.minimumPayment.minorUnits === 0n
          ? [`${debt.name ?? debt.id} minimum payment`]
          : []),
      ]),
    ];
    const readiness = {
      score: Math.max(0, 100 - missingInputs.length * 20),
      missingInputs,
      confidenceLabel:
        missingInputs.length === 0 ? "high" : missingInputs.length === 1 ? "medium" : "low",
    };
    const runId = ulid();
    await db.insert(forecastRuns).values({
      id: runId,
      householdId: auth.householdId,
      scenarioId: scenarioRow.id,
      inputVersionHash: deterministic.inputHash,
      engineVersion: deterministic.engineVersion,
      state: "succeeded",
      runCount: input.monteCarloRuns ?? 1,
      outputs: dbJson(deterministicJson),
      ...(monteCarloJson ? { percentileSeries: dbJson(monteCarloJson) } : {}),
      readiness: dbJson(readiness),
      startedAt: nowIso(),
      finishedAt: nowIso(),
    });
    const row = await db
      .select()
      .from(forecastRuns)
      .where(and(eq(forecastRuns.householdId, auth.householdId), eq(forecastRuns.id, runId)))
      .get();
    return context.json(forecastRunDto(row!), 201);
  });

  routes.get("/forecast-runs/:id", async (context) => {
    const auth = context.get("auth");
    const row = await db
      .select()
      .from(forecastRuns)
      .where(
        and(
          eq(forecastRuns.householdId, auth.householdId),
          eq(forecastRuns.id, context.req.param("id")),
        ),
      )
      .get();
    if (!row) throw new NotFoundError("Forecast run");
    return context.json({
      ...forecastRunDto(row),
      deterministic: row.outputs,
      monteCarlo: row.percentileSeries,
    });
  });

  // Manually tracked assets and valuations -------------------------------

  routes.get("/assets", async (context) => {
    const auth = context.get("auth");
    const [assetRows, valuationRows] = await Promise.all([
      db
        .select()
        .from(assets)
        .where(and(eq(assets.householdId, auth.householdId), eq(assets.isActive, true)))
        .orderBy(asc(assets.type), asc(assets.name)),
      db
        .select()
        .from(assetValuations)
        .where(eq(assetValuations.householdId, auth.householdId))
        .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt)),
    ]);
    const latest = new Map<string, (typeof valuationRows)[number]>();
    for (const valuation of valuationRows) {
      if (!latest.has(valuation.assetId)) latest.set(valuation.assetId, valuation);
    }
    return context.json(
      page(
        assetRows.map((asset) => {
          const valuation = latest.get(asset.id);
          return {
            ...asset,
            value: moneyJson(valuation?.amount ?? 0n, valuation?.currency ?? asset.currency),
            valuedAt: valuation ? `${valuation.valuedOn}T00:00:00.000Z` : asset.createdAt,
            source: valuation?.source ?? "manual",
            confidence:
              !valuation || valuation.confidenceBps >= 9_000
                ? ("high" as const)
                : valuation.confidenceBps >= 6_000
                  ? ("medium" as const)
                  : ("low" as const),
            liquidityClass: asset.liquidityClass === "liquid" ? "liquid" : "illiquid",
            ...(asset.linkedLiabilityAccountId
              ? { relatedLiabilityId: asset.linkedLiabilityAccountId }
              : {}),
            ...(valuation
              ? {
                  latestValuation: {
                    id: valuation.id,
                    amount: moneyJson(valuation.amount, valuation.currency),
                    valuedOn: valuation.valuedOn,
                    source: valuation.source,
                    confidenceBps: valuation.confidenceBps,
                  },
                }
              : { latestValuation: null }),
          };
        }),
      ),
    );
  });

  routes.post("/assets", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = assetCreateSchema.parse(await context.req.json());
    const linkedLiabilityAccountId = input.linkedLiabilityAccountId ?? input.relatedLiabilityId;
    if (linkedLiabilityAccountId) {
      await requireAccount(db, auth.householdId, linkedLiabilityAccountId);
    }
    if (input.value && input.value.currency !== input.currency) {
      throw new ConflictError("Asset and valuation currencies must match", "currency_mismatch");
    }
    const id = ulid();
    const valuationId = input.value ? ulid() : undefined;
    await db.transaction(async (transaction) => {
      await transaction.insert(assets).values({
        id,
        householdId: auth.householdId,
        name: input.name,
        type: input.type,
        liquidityClass: input.liquidityClass,
        currency: input.currency,
        ...(linkedLiabilityAccountId ? { linkedLiabilityAccountId } : {}),
        ownerUserId: auth.user.id,
        ...(input.metadata === undefined ? {} : { metadata: dbJsonOrNull(input.metadata) }),
        isActive: input.isActive,
      });
      if (input.value && valuationId) {
        await transaction.insert(assetValuations).values({
          id: valuationId,
          householdId: auth.householdId,
          assetId: id,
          amount: BigInt(input.value.minorUnits),
          currency: input.currency,
          valuedOn:
            input.valuedOn ?? input.valuedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
          source: input.valuationSource,
          confidenceBps:
            input.confidence === "low" ? 4_000 : input.confidence === "medium" ? 7_500 : 10_000,
        });
      }
    });
    return context.json(
      {
        id,
        ...(valuationId ? { valuationId } : {}),
        name: input.name,
        type: input.type,
        liquidityClass: input.liquidityClass,
        currency: input.currency,
        value: input.value ?? moneyJson(0n, input.currency),
        valuedAt:
          input.valuedAt ??
          `${input.valuedOn ?? new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
        source: input.source ?? input.valuationSource,
        confidence: input.confidence ?? "high",
        ...(linkedLiabilityAccountId ? { relatedLiabilityId: linkedLiabilityAccountId } : {}),
      },
      201,
    );
  });

  routes.patch("/assets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .get();
    if (!current) throw new NotFoundError("Asset");
    const input = assetPatchSchema.parse(await context.req.json());
    const linkedLiabilityAccountId = input.linkedLiabilityAccountId ?? input.relatedLiabilityId;
    if (linkedLiabilityAccountId) {
      const liability = await requireAccount(db, auth.householdId, linkedLiabilityAccountId);
      if (!liability.isLiability) {
        throw new ConflictError("Linked asset account must be a liability", "invalid_liability");
      }
    }
    const nextCurrency = input.currency ?? current.currency;
    if (input.value && input.value.currency !== nextCurrency) {
      throw new ConflictError("Asset and valuation currencies must match", "currency_mismatch");
    }
    if (input.currency && input.currency !== current.currency) {
      const existingValuation = await db
        .select({ id: assetValuations.id })
        .from(assetValuations)
        .where(
          and(
            eq(assetValuations.householdId, auth.householdId),
            eq(assetValuations.assetId, current.id),
          ),
        )
        .get();
      if (existingValuation) {
        throw new ConflictError(
          "An asset with valuation history cannot change currency",
          "currency_history_conflict",
        );
      }
    }
    await db
      .update(assets)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.type === undefined ? {} : { type: input.type }),
        ...(input.liquidityClass === undefined ? {} : { liquidityClass: input.liquidityClass }),
        ...(input.currency === undefined ? {} : { currency: input.currency }),
        ...(linkedLiabilityAccountId === undefined ? {} : { linkedLiabilityAccountId }),
        ...(input.metadata === undefined ? {} : { metadata: dbJsonOrNull(input.metadata) }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        updatedAt: nowIso(),
      })
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, current.id)));
    if (input.value) {
      await db.insert(assetValuations).values({
        id: ulid(),
        householdId: auth.householdId,
        assetId: current.id,
        amount: BigInt(input.value.minorUnits),
        currency: input.value.currency,
        valuedOn:
          input.valuedOn ?? input.valuedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        source: input.valuationSource ?? "manual",
        confidenceBps:
          input.confidence === "low" ? 4_000 : input.confidence === "medium" ? 7_500 : 10_000,
      });
    }
    const updated = await db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, current.id)))
      .get();
    const latest = await db
      .select()
      .from(assetValuations)
      .where(
        and(
          eq(assetValuations.householdId, auth.householdId),
          eq(assetValuations.assetId, current.id),
        ),
      )
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt))
      .get();
    return context.json({
      ...updated!,
      value: moneyJson(latest?.amount ?? 0n, latest?.currency ?? updated!.currency),
      valuedAt: latest ? `${latest.valuedOn}T00:00:00.000Z` : updated!.updatedAt,
      source: latest?.source ?? "manual",
      confidence:
        !latest || latest.confidenceBps >= 9_000
          ? "high"
          : latest.confidenceBps >= 6_000
            ? "medium"
            : "low",
      liquidityClass: updated!.liquidityClass === "liquid" ? "liquid" : "illiquid",
      ...(updated!.linkedLiabilityAccountId
        ? { relatedLiabilityId: updated!.linkedLiabilityAccountId }
        : {}),
    });
  });

  routes.delete("/assets/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(assets)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .returning({ id: assets.id })
      .get();
    if (!result) throw new NotFoundError("Asset");
    return context.body(null, 204);
  });

  routes.get("/assets/:id/valuations", async (context) => {
    const auth = context.get("auth");
    const asset = await db
      .select({ id: assets.id })
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .get();
    if (!asset) throw new NotFoundError("Asset");
    const rows = await db
      .select()
      .from(assetValuations)
      .where(
        and(
          eq(assetValuations.householdId, auth.householdId),
          eq(assetValuations.assetId, asset.id),
        ),
      )
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt));
    return context.json(
      page(rows.map((row) => ({ ...row, amount: moneyJson(row.amount, row.currency) }))),
    );
  });

  routes.post("/assets/:id/valuations", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const asset = await db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, auth.householdId), eq(assets.id, context.req.param("id"))))
      .get();
    if (!asset) throw new NotFoundError("Asset");
    const input = valuationCreateSchema.parse(await context.req.json());
    const amount = optionalMoney(
      input.amount,
      input.amountMinorUnits,
      input.currency ?? asset.currency,
    );
    if (amount.currency !== asset.currency) {
      throw new ConflictError("Valuation currency must match the asset", "currency_mismatch");
    }
    const proposedId = ulid();
    const saved = await db
      .insert(assetValuations)
      .values({
        id: proposedId,
        householdId: auth.householdId,
        assetId: asset.id,
        amount: amount.minor,
        currency: amount.currency,
        valuedOn: input.valuedOn,
        source: input.source,
        confidenceBps: input.confidenceBps,
        ...(input.providerReference ? { providerReference: input.providerReference } : {}),
        ...(input.metadata === undefined ? {} : { metadata: dbJsonOrNull(input.metadata) }),
      })
      .onConflictDoUpdate({
        target: [assetValuations.assetId, assetValuations.valuedOn, assetValuations.source],
        set: {
          amount: amount.minor,
          currency: amount.currency,
          confidenceBps: input.confidenceBps,
          providerReference: input.providerReference ?? null,
          metadata: input.metadata === undefined ? null : dbJsonOrNull(input.metadata),
        },
      })
      .returning({ id: assetValuations.id })
      .get();
    if (!saved) throw new NotFoundError("Asset valuation");
    return context.json(
      {
        id: saved.id,
        assetId: asset.id,
        amount: moneyJson(amount.minor, amount.currency),
        valuedOn: input.valuedOn,
        source: input.source,
        confidenceBps: input.confidenceBps,
        ...(input.providerReference ? { providerReference: input.providerReference } : {}),
      },
      201,
    );
  });

  // Income sources ---------------------------------------------------------

  routes.get("/income-sources", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(incomeSources)
      .where(eq(incomeSources.householdId, auth.householdId))
      .orderBy(desc(incomeSources.isActive), asc(incomeSources.name));
    return context.json(
      page(
        rows.map((row) => ({
          ...row,
          typicalAmount: moneyJson(row.typicalAmount, row.currency),
        })),
      ),
    );
  });

  routes.post("/income-sources", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = incomeSourceCreateSchema.parse(await context.req.json());
    if (input.accountId) await requireAccount(db, auth.householdId, input.accountId);
    const amount = optionalMoney(
      input.typicalAmount,
      input.typicalAmountMinorUnits,
      input.currency,
    );
    const id = ulid();
    await db.insert(incomeSources).values({
      id,
      householdId: auth.householdId,
      name: input.name,
      ...(input.merchantId ? { merchantId: input.merchantId } : {}),
      ...(input.accountId ? { accountId: input.accountId } : {}),
      ...(input.recurringSeriesId ? { recurringSeriesId: input.recurringSeriesId } : {}),
      cadence: input.cadence,
      ...(input.cadenceConfig === undefined
        ? {}
        : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
      typicalAmount: amount.minor,
      currency: amount.currency,
      ...(input.nextExpectedDate ? { nextExpectedDate: input.nextExpectedDate } : {}),
      variabilityBps: input.variabilityBps,
      isActive: input.isActive,
      ...(input.detectionRule === undefined
        ? {}
        : { detectionRule: dbJsonOrNull(input.detectionRule) }),
    });
    return context.json(
      {
        id,
        name: input.name,
        cadence: input.cadence,
        typicalAmount: moneyJson(amount.minor, amount.currency),
        nextExpectedDate: input.nextExpectedDate,
        isActive: input.isActive,
      },
      201,
    );
  });

  routes.patch("/income-sources/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const current = await db
      .select()
      .from(incomeSources)
      .where(
        and(
          eq(incomeSources.householdId, auth.householdId),
          eq(incomeSources.id, context.req.param("id")),
        ),
      )
      .get();
    if (!current) throw new NotFoundError("Income source");
    const input = incomeSourcePatchSchema.parse(await context.req.json());
    if (input.accountId) await requireAccount(db, auth.householdId, input.accountId);
    await db
      .update(incomeSources)
      .set({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.merchantId === undefined ? {} : { merchantId: input.merchantId }),
        ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
        ...(input.recurringSeriesId === undefined
          ? {}
          : { recurringSeriesId: input.recurringSeriesId }),
        ...(input.cadence === undefined ? {} : { cadence: input.cadence }),
        ...(input.cadenceConfig === undefined
          ? {}
          : { cadenceConfig: dbJsonOrNull(input.cadenceConfig) }),
        ...(input.typicalAmount
          ? {
              typicalAmount: BigInt(input.typicalAmount.minorUnits),
              currency: input.typicalAmount.currency,
            }
          : input.typicalAmountMinorUnits === undefined
            ? {}
            : { typicalAmount: BigInt(input.typicalAmountMinorUnits) }),
        ...(input.nextExpectedDate === undefined
          ? {}
          : { nextExpectedDate: input.nextExpectedDate }),
        ...(input.variabilityBps === undefined ? {} : { variabilityBps: input.variabilityBps }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.detectionRule === undefined
          ? {}
          : { detectionRule: dbJsonOrNull(input.detectionRule) }),
        updatedAt: nowIso(),
      })
      .where(
        and(eq(incomeSources.householdId, auth.householdId), eq(incomeSources.id, current.id)),
      );
    const updated = await db
      .select()
      .from(incomeSources)
      .where(and(eq(incomeSources.householdId, auth.householdId), eq(incomeSources.id, current.id)))
      .get();
    return context.json({
      ...updated!,
      typicalAmount: moneyJson(updated!.typicalAmount, updated!.currency),
    });
  });

  routes.delete("/income-sources/:id", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const result = await db
      .update(incomeSources)
      .set({ isActive: false, updatedAt: nowIso() })
      .where(
        and(
          eq(incomeSources.householdId, auth.householdId),
          eq(incomeSources.id, context.req.param("id")),
        ),
      )
      .returning({ id: incomeSources.id })
      .get();
    if (!result) throw new NotFoundError("Income source");
    return context.body(null, 204);
  });

  // Local CSV / OFX / QFX imports -----------------------------------------

  routes.get("/imports", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select({
        id: importRuns.id,
        format: importRuns.format,
        originalFilename: importRuns.originalFilename,
        state: importRuns.state,
        totalRecords: importRuns.totalRecords,
        importedRecords: importRuns.importedRecords,
        duplicateRecords: importRuns.duplicateRecords,
        rejectedRecords: importRuns.rejectedRecords,
        committedAt: importRuns.committedAt,
        createdAt: importRuns.createdAt,
      })
      .from(importRuns)
      .where(eq(importRuns.householdId, auth.householdId))
      .orderBy(desc(importRuns.createdAt))
      .limit(100);
    return context.json(page(rows));
  });

  routes.post("/imports/transactions", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = importTransactionsSchema.parse(await context.req.json());
    const account = await requireAccount(db, auth.householdId, input.accountId);
    const currency = input.currency ?? account.currency;
    const parsed = parseTransactionFile(input.filename, input.content);
    if (parsed.length > 100_000) {
      throw new AppError("Import contains too many transactions", 413, "import_too_large");
    }
    const fileHash = sha256(input.content);
    const existingRun = await db
      .select({ id: importRuns.id, state: importRuns.state })
      .from(importRuns)
      .where(and(eq(importRuns.householdId, auth.householdId), eq(importRuns.fileHash, fileHash)))
      .get();
    if (existingRun) {
      throw new ConflictError(
        `This file was already imported as ${existingRun.id}`,
        "duplicate_import_file",
      );
    }
    const existingTransactions = await db
      .select({ externalId: transactions.externalId, fingerprint: transactions.fingerprint })
      .from(transactions)
      .where(
        and(eq(transactions.householdId, auth.householdId), eq(transactions.accountId, account.id)),
      );
    const externalIds = new Set(
      existingTransactions
        .map((transaction) => transaction.externalId)
        .filter((value): value is string => Boolean(value)),
    );
    const fingerprints = new Set(
      existingTransactions
        .map((transaction) => transaction.fingerprint)
        .filter((value): value is string => Boolean(value)),
    );
    const extension = input.filename.toLowerCase().split(".").at(-1);
    const format = extension === "csv" ? "csv" : extension === "qfx" ? "qfx" : "ofx";
    const runId = ulid();
    const cipher = new FieldCipher(config.ENCRYPTION_KEY);
    let imported = 0;
    let duplicates = 0;
    await db.transaction(async (transaction) => {
      await transaction.insert(importRuns).values({
        id: runId,
        householdId: auth.householdId,
        createdByUserId: auth.user.id,
        format,
        fileHash,
        originalFilename: input.filename,
        state: "running",
        totalRecords: parsed.length,
      });
      for (const [index, record] of parsed.entries()) {
        const amount = parseDecimalToMinorUnits(record.amount, 2, "reject");
        const fingerprint = transactionFingerprint({
          accountId: account.id,
          ...(record.externalId ? { externalId: record.externalId } : {}),
          amountMinor: amount.toString(),
          description: record.description,
          occurredAt: record.postedAt,
        });
        const recordHash = sha256(
          `${record.externalId ?? ""}\u001f${fingerprint}\u001f${record.postedAt}`,
        );
        const duplicate =
          (record.externalId ? externalIds.has(record.externalId) : false) ||
          fingerprints.has(fingerprint);
        const rawRecordId = ulid();
        const payloadAad = `raw-import:${auth.householdId}:${runId}:${rawRecordId}`;
        const encryptedPayload = splitEncryptedPayload(
          cipher.encrypt(
            JSON.stringify({
              postedAt: record.postedAt,
              amount: record.amount,
              description: record.description,
              ...(record.memo ? { memo: record.memo } : {}),
            }),
            payloadAad,
          ),
        );
        await transaction.insert(rawImportRecords).values({
          id: rawRecordId,
          householdId: auth.householdId,
          importRunId: runId,
          rowNumber: index + 1,
          ...(record.externalId ? { externalId: record.externalId } : {}),
          payloadCiphertext: encryptedPayload.ciphertext,
          payloadNonce: encryptedPayload.nonce,
          payloadAuthTag: encryptedPayload.authTag,
          payloadKeyVersion: encryptedPayload.keyId,
          payloadAad,
          recordHash,
          status: duplicate ? "duplicate" : "accepted",
        });
        if (duplicate) {
          duplicates += 1;
          continue;
        }
        const transactionId = ulid();
        await transaction.insert(transactions).values({
          id: transactionId,
          householdId: auth.householdId,
          accountId: account.id,
          importRunId: runId,
          ...(record.externalId ? { externalId: record.externalId } : {}),
          amount,
          currency,
          postedAt: record.postedAt,
          transactedOn: record.postedAt,
          rawDescription: record.description,
          normalizedDescription: normalizeDescription(record.description),
          status: record.pending ? "pending" : "posted",
          source: "import",
          reviewState: "needs_review",
          ...(record.memo ? { note: record.memo } : {}),
          fingerprint,
        });
        imported += 1;
        if (record.externalId) externalIds.add(record.externalId);
        fingerprints.add(fingerprint);
      }
      await transaction
        .update(importRuns)
        .set({
          state: "succeeded",
          importedRecords: imported,
          duplicateRecords: duplicates,
          committedAt: nowIso(),
          updatedAt: nowIso(),
        })
        .where(and(eq(importRuns.householdId, auth.householdId), eq(importRuns.id, runId)));
    });
    const deterministicCategorization = await categorizeHouseholdTransactions({
      db,
      config,
      householdId: auth.householdId,
      userId: auth.user.id,
      aiLimit: 0,
    });
    const needsAi =
      deterministicCategorization.candidates > deterministicCategorization.deterministic;
    const categorizationJobId = needsAi ? ulid() : undefined;
    if (categorizationJobId) {
      await db.insert(jobs).values({
        id: categorizationJobId,
        householdId: auth.householdId,
        type: "categorization.run",
        payload: { userId: auth.user.id, aiLimit: 25, trigger: "file_import" },
        state: "queued",
        scheduledAt: nowIso(),
        idempotencyKey: `categorization:import:${runId}`,
      });
    }
    return context.json(
      {
        id: runId,
        state: "succeeded" as const,
        totalRecords: parsed.length,
        importedRecords: imported,
        duplicateRecords: duplicates,
        rejectedRecords: 0,
        categorization: {
          ...deterministicCategorization,
          state: needsAi ? ("queued" as const) : ("succeeded" as const),
          ...(categorizationJobId ? { jobId: categorizationJobId } : {}),
        },
      },
      201,
    );
  });

  return routes;
}
