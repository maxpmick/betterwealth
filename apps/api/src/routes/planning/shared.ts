import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  budgetPeriods,
  envelopeAllocations,
  envelopeCategoryLinks,
  envelopes,
  households,
  type JsonObject,
  refundLinks,
  settings,
  transactionSplits,
  transactions,
} from "@betterwealth/db/schema";
import { divideAndRound, MinorUnitsStringSchema } from "@betterwealth/shared";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import { localMonthKey } from "../../lib/dates";
import { NotFoundError } from "../../lib/errors";

export type MoneyJson = { minorUnits: string; currency: string };

export const dateSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.slice(0, 10) : value),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
);
export const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{2,11}$/)
  .transform((value) => value.toUpperCase());
export const minorUnitsSchema = MinorUnitsStringSchema;

const planningForecastPreferencesSchema = z
  .object({
    spendableAccountIds: z.array(z.string().min(1)).max(1_000).optional(),
    minimumBufferMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    reservedBillsMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    targetLiquidNetWorthMinorUnits: minorUnitsSchema
      .refine((value) => BigInt(value) > 0n)
      .optional(),
  })
  .passthrough();

export function normalizedCadence(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function cadencePeriodsPerYear(value: string, payCycleFallback = 12): number {
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

export function averageMonthlyAmount(
  amount: bigint,
  cadence: string,
  payCycleFallback = 12,
): bigint {
  return divideAndRound(
    amount * BigInt(cadencePeriodsPerYear(cadence, payCycleFallback)),
    12n,
    "half-even",
  );
}

export function cadenceFromDueRule(value: unknown) {
  const parsed = z
    .object({ cadence: z.string().trim().min(1).max(80) })
    .passthrough()
    .safeParse(value);
  return parsed.success ? parsed.data.cadence : "monthly";
}

export async function householdTimezone(db: BetterWealthDatabase, householdId: string) {
  const household = await db
    .select({ timezone: households.timezone })
    .from(households)
    .where(eq(households.id, householdId))
    .get();
  return household?.timezone ?? "UTC";
}

export async function loadPlanningForecastDefaults(db: BetterWealthDatabase, householdId: string) {
  const [household, preferenceRow] = await Promise.all([
    db
      .select({ currency: households.baseCurrency, timezone: households.timezone })
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
    timezone: household?.timezone ?? "UTC",
    preferences: preferences.success ? preferences.data : {},
  };
}

export function moneyJson(minorUnits: bigint, currency: string): MoneyJson {
  return { minorUnits: minorUnits.toString(), currency };
}

export function page<T>(data: T[]) {
  return { data, page: { cursor: null, hasMore: false } };
}

export function nowIso() {
  return new Date().toISOString();
}

export function dbJson(value: unknown): JsonObject {
  return value as JsonObject;
}

export function dbJsonOrNull(value: unknown): JsonObject | null {
  return value === null ? null : dbJson(value);
}

export function startOfCurrentMonth(now: Date, timeZone = "UTC") {
  return localMonthKey(now, timeZone);
}

export function optionalMoney(
  value: { minorUnits: string; currency: string } | undefined,
  fallbackMinor: string | undefined,
  fallbackCurrency: string,
) {
  if (value) return { minor: BigInt(value.minorUnits), currency: value.currency };
  return { minor: BigInt(fallbackMinor ?? "0"), currency: fallbackCurrency };
}

export async function requireAccount(
  db: BetterWealthDatabase,
  householdId: string,
  accountId: string,
) {
  const account = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.householdId, householdId), eq(accounts.id, accountId)))
    .get();
  if (!account) throw new NotFoundError("Account");
  return account;
}

export async function requireEnvelope(
  db: BetterWealthDatabase,
  householdId: string,
  envelopeId: string,
) {
  const envelope = await db
    .select()
    .from(envelopes)
    .where(and(eq(envelopes.householdId, householdId), eq(envelopes.id, envelopeId)))
    .get();
  if (!envelope) throw new NotFoundError("Envelope");
  return envelope;
}

export async function budgetDtos(
  db: BetterWealthDatabase,
  householdId: string,
  requestedId?: string,
) {
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

export async function calculateBudgetActivity(
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
  const refundsByTransaction = new Map<string, (typeof confirmedRefunds)[number][]>();
  for (const link of confirmedRefunds) {
    refundsByTransaction.set(link.refundTransactionId, [
      ...(refundsByTransaction.get(link.refundTransactionId) ?? []),
      link,
    ]);
  }
  for (const transaction of currentTransactions) {
    if (transaction.amount <= 0n) {
      const directlyMapped = piecesFor(transaction)
        .map((piece) => ({
          piece,
          envelopeId: resolveEnvelope(piece.envelopeId, piece.categoryId),
        }))
        .filter((item): item is { piece: BudgetActivityPiece; envelopeId: string } =>
          Boolean(item.envelopeId),
        );
      for (const item of directlyMapped) addActivity(item.envelopeId, item.piece.amount);
      continue;
    }
    if (transaction.isIncome) continue;
    let remainingCredit = transaction.amount;
    for (const refundLink of refundsByTransaction.get(transaction.id) ?? []) {
      if (remainingCredit <= 0n) break;
      const purchase = transactionById.get(refundLink.purchaseTransactionId);
      if (!purchase) continue;
      const purchasePieces = piecesFor(purchase)
        .map((piece) => ({
          piece,
          envelopeId: resolveEnvelope(piece.envelopeId, piece.categoryId),
        }))
        .filter((item): item is { piece: BudgetActivityPiece; envelopeId: string } =>
          Boolean(item.envelopeId),
        );
      const denominator = purchasePieces.reduce(
        (sum, item) => sum + (item.piece.amount < 0n ? -item.piece.amount : item.piece.amount),
        0n,
      );
      if (denominator === 0n) continue;
      const refundable = refundLink.amount < remainingCredit ? refundLink.amount : remainingCredit;
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
      remainingCredit -= refundable;
    }
  }
  return activity;
}

export function goalMonthlyAmount(policy: unknown): string {
  const result = z
    .object({ monthlyAmountMinorUnits: minorUnitsSchema.optional() })
    .passthrough()
    .safeParse(policy);
  return result.success ? (result.data.monthlyAmountMinorUnits ?? "0") : "0";
}
