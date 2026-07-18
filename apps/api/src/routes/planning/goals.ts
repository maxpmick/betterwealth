import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  allocationEntries,
  balanceSnapshots,
  bills,
  budgetPeriods,
  goalContributions,
  goals,
  incomeSources,
  transactions,
  users,
} from "@betterwealth/db/schema";
import {
  comfortablePurchaseDate,
  deriveGoalPace,
  MoneyJsonSchema,
  money,
  type PurchaseConstraint,
  projectGoal,
} from "@betterwealth/shared";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { localDateKey } from "../../lib/dates";
import { ConflictError, NotFoundError } from "../../lib/errors";
import { cappedConfirmedRefund, confirmedRefundAmounts } from "../../lib/refunds";
import type { AppEnv } from "../../types";
import {
  averageMonthlyAmount,
  budgetDtos,
  cadenceFromDueRule,
  currencySchema,
  dateSchema,
  dbJson,
  dbJsonOrNull,
  goalMonthlyAmount,
  householdTimezone,
  loadPlanningForecastDefaults,
  type MoneyJson,
  minorUnitsSchema,
  moneyJson,
  nowIso,
  optionalMoney,
  page,
  requireAccount,
  startOfCurrentMonth,
} from "./shared";

const positiveMinorUnitsSchema = minorUnitsSchema.refine((value) => BigInt(value) > 0n);

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

function goalTypeForWeb(type: typeof goals.$inferSelect.type) {
  return type === "investment_milestone" ? ("investment" as const) : type;
}

type ComfortablePurchaseConstraintDto = {
  code: PurchaseConstraint | "incompleteInputs";
  label: string;
  satisfied: boolean | null;
  detail: string;
};

type ComfortablePurchasePlanDto = {
  status: "comfortable" | "not_comfortable" | "incomplete";
  comfortable: boolean | null;
  comfortableMonth: string | null;
  monthsUntilPurchase: number | null;
  controllingConstraint: PurchaseConstraint | "incompleteInputs" | null;
  limitingConstraints: ComfortablePurchaseConstraintDto[];
  constraints: ComfortablePurchaseConstraintDto[];
  missingInputs: string[];
  inputs: {
    spendableLiquidity: MoneyJson | null;
    unreservedLiquidity: MoneyJson | null;
    fundingAccountBalance: MoneyJson | null;
    verifiedPurchaseSavings: MoneyJson | null;
    protectedMinimumBuffer: MoneyJson | null;
    requiredMonthlyBills: MoneyJson | null;
    requiredObligationShortfall: MoneyJson | null;
    higherPriorityMonthlyFunding: MoneyJson;
    monthlySurplus: MoneyJson | null;
    monthlySurplusSource: "explicit_budget" | "observed_90_day" | null;
    currentLiquidNetWorth: MoneyJson | null;
    targetLiquidNetWorth: MoneyJson | null;
    targetWealthDate: string | null;
    projectedLiquidNetWorthAtTarget: MoneyJson | null;
  };
  assumptions: string[];
};

function goalDto(
  row: typeof goals.$inferSelect,
  now: Date,
  timeZone: string,
  comfortablePurchase?: ComfortablePurchasePlanDto,
) {
  const monthly = BigInt(goalMonthlyAmount(row.contributionPolicy));
  const projection = projectGoal({
    startMonth: startOfCurrentMonth(now, timeZone),
    currentAmount: money(row.fundedAmount, row.currency),
    targetAmount: money(row.targetAmount, row.currency),
    monthlyContribution: money(monthly, row.currency),
  });
  const pace = deriveGoalPace({
    startMonth: startOfCurrentMonth(now, timeZone),
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
    ...(comfortablePurchase ? { comfortablePurchase } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const comfortableConstraintLabels: Record<PurchaseConstraint, string> = {
  purchaseFunding: "Purchase fully funded",
  emergencyFloor: "Protected cash floor",
  requiredObligations: "Required bills covered",
  checkingBuffer: "Checking buffer survives",
  higherPriorityGoals: "Higher-priority goals stay funded",
  targetNetWorth: "Wealth target preserved",
  horizon: "Planning horizon",
};

function incompleteComfortablePurchasePlan(
  currency: string,
  missingInputs: string[],
  values: {
    spendableLiquidity?: bigint;
    unreservedLiquidity?: bigint;
    fundingAccountBalance?: bigint;
    verifiedPurchaseSavings?: bigint;
    minimumBuffer?: bigint;
    requiredMonthlyBills?: bigint;
    requiredObligationShortfall?: bigint;
    higherPriorityMonthlyFunding: bigint;
    monthlySurplus?: bigint;
    monthlySurplusSource?: "explicit_budget" | "observed_90_day";
    currentLiquidNetWorth?: bigint;
    targetLiquidNetWorth?: bigint;
    targetWealthDate?: string;
  },
): ComfortablePurchasePlanDto {
  return {
    status: "incomplete",
    comfortable: null,
    comfortableMonth: null,
    monthsUntilPurchase: null,
    controllingConstraint: "incompleteInputs",
    limitingConstraints: [
      {
        code: "incompleteInputs",
        label: "Planning inputs incomplete",
        satisfied: null,
        detail: missingInputs.join("; "),
      },
    ],
    constraints: [],
    missingInputs,
    inputs: {
      spendableLiquidity:
        values.spendableLiquidity === undefined
          ? null
          : moneyJson(values.spendableLiquidity, currency),
      unreservedLiquidity:
        values.unreservedLiquidity === undefined
          ? null
          : moneyJson(values.unreservedLiquidity, currency),
      fundingAccountBalance:
        values.fundingAccountBalance === undefined
          ? null
          : moneyJson(values.fundingAccountBalance, currency),
      verifiedPurchaseSavings:
        values.verifiedPurchaseSavings === undefined
          ? null
          : moneyJson(values.verifiedPurchaseSavings, currency),
      protectedMinimumBuffer:
        values.minimumBuffer === undefined ? null : moneyJson(values.minimumBuffer, currency),
      requiredMonthlyBills:
        values.requiredMonthlyBills === undefined
          ? null
          : moneyJson(values.requiredMonthlyBills, currency),
      requiredObligationShortfall:
        values.requiredObligationShortfall === undefined
          ? null
          : moneyJson(values.requiredObligationShortfall, currency),
      higherPriorityMonthlyFunding: moneyJson(values.higherPriorityMonthlyFunding, currency),
      monthlySurplus:
        values.monthlySurplus === undefined ? null : moneyJson(values.monthlySurplus, currency),
      monthlySurplusSource: values.monthlySurplusSource ?? null,
      currentLiquidNetWorth:
        values.currentLiquidNetWorth === undefined
          ? null
          : moneyJson(values.currentLiquidNetWorth, currency),
      targetLiquidNetWorth:
        values.targetLiquidNetWorth === undefined
          ? null
          : moneyJson(values.targetLiquidNetWorth, currency),
      targetWealthDate: values.targetWealthDate ?? null,
      projectedLiquidNetWorthAtTarget: null,
    },
    assumptions: [
      "No comfortable-to-buy date is calculated until every required input is confirmed.",
    ],
  };
}

async function comfortablePurchasePlans(
  db: BetterWealthDatabase,
  householdId: string,
  userId: string,
  goalRows: readonly (typeof goals.$inferSelect)[],
  now: Date,
): Promise<Map<string, ComfortablePurchasePlanDto>> {
  const purchaseRows = goalRows.filter(
    (goal) => goal.type === "purchase" && goal.status !== "cancelled",
  );
  if (purchaseRows.length === 0) return new Map();

  const timeZone = await householdTimezone(db, householdId);
  const today = localDateKey(now, timeZone);
  const ninetyDaysAgo = localDateKey(new Date(now.getTime() - 90 * 86_400_000), timeZone);
  const sevenDaysAgo = localDateKey(new Date(now.getTime() - 7 * 86_400_000), timeZone);
  const [
    defaults,
    profile,
    accountRows,
    snapshotRows,
    requiredBillRows,
    activeIncomeRows,
    activityRows,
    monthPeriod,
  ] = await Promise.all([
    loadPlanningForecastDefaults(db, householdId),
    db
      .select({ birthDate: users.birthDate, targetAge: users.targetAge })
      .from(users)
      .where(eq(users.id, userId))
      .get(),
    db.select().from(accounts).where(eq(accounts.householdId, householdId)),
    db
      .select({
        accountId: balanceSnapshots.accountId,
        currentBalance: balanceSnapshots.currentBalance,
        availableBalance: balanceSnapshots.availableBalance,
        currency: balanceSnapshots.currency,
        asOf: balanceSnapshots.asOf,
      })
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.householdId, householdId))
      .orderBy(desc(balanceSnapshots.asOf)),
    db
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.householdId, householdId),
          eq(bills.isActive, true),
          eq(bills.isRequired, true),
        ),
      ),
    db
      .select({
        cadence: incomeSources.cadence,
        typicalAmount: incomeSources.typicalAmount,
        currency: incomeSources.currency,
      })
      .from(incomeSources)
      .where(and(eq(incomeSources.householdId, householdId), eq(incomeSources.isActive, true))),
    db
      .select({
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        transactedOn: transactions.transactedOn,
        isIncome: transactions.isIncome,
        isReimbursement: transactions.isReimbursement,
        isExcluded: transactions.isExcluded,
        isTransfer: transactions.isTransfer,
        status: transactions.status,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, householdId),
          gte(transactions.transactedOn, ninetyDaysAgo),
        ),
      ),
    db
      .select()
      .from(budgetPeriods)
      .where(
        and(
          eq(budgetPeriods.householdId, householdId),
          eq(budgetPeriods.kind, "month"),
          lte(budgetPeriods.startsOn, today),
          gte(budgetPeriods.endsOn, today),
          inArray(budgetPeriods.status, ["draft", "open"]),
        ),
      )
      .orderBy(desc(budgetPeriods.startsOn))
      .get(),
  ]);
  const confirmedRefundByTransaction = await confirmedRefundAmounts(
    db,
    householdId,
    activityRows.filter(({ amount }) => amount > 0n).map(({ id }) => id),
  );

  const firstPurchase = purchaseRows[0];
  if (!firstPurchase) return new Map();
  const currency = defaults.currency ?? firstPurchase.currency;
  const missing = new Set<string>();
  const accountById = new Map(accountRows.map((account) => [account.id, account]));
  const latestByAccount = new Map<string, (typeof snapshotRows)[number]>();
  for (const snapshot of snapshotRows) {
    if (!latestByAccount.has(snapshot.accountId)) latestByAccount.set(snapshot.accountId, snapshot);
  }
  const snapshotIsFresh = (snapshot: (typeof snapshotRows)[number]) =>
    snapshot.asOf.slice(0, 10) >= sevenDaysAgo && snapshot.asOf.slice(0, 10) <= today;
  const configuredSpendableIds = defaults.preferences.spendableAccountIds;
  const budgetCashAccounts = accountRows.filter(
    (account) =>
      account.group === "cash" &&
      account.includeInBudget &&
      account.currency === currency &&
      account.status !== "hidden" &&
      account.status !== "closed",
  );
  const defaultCheckingAccounts = budgetCashAccounts.filter(
    (account) => !/saving|money.?market/i.test(`${account.type} ${account.subtype ?? ""}`),
  );
  let spendableAccounts: typeof accountRows;
  if (configuredSpendableIds !== undefined) {
    const uniqueIds = [...new Set(configuredSpendableIds)];
    spendableAccounts = uniqueIds.flatMap((id) => {
      const account = accountById.get(id);
      if (
        !account ||
        account.group !== "cash" ||
        !account.includeInBudget ||
        account.currency !== currency
      ) {
        missing.add("Review the configured spendable-account selection");
        return [];
      }
      return [account];
    });
    if (uniqueIds.length === 0) missing.add("Choose at least one spendable cash account");
  } else {
    spendableAccounts =
      defaultCheckingAccounts.length > 0 ? defaultCheckingAccounts : budgetCashAccounts;
  }
  if (spendableAccounts.length === 0) missing.add("Add an active spendable cash account");
  let spendableLiquidity = 0n;
  for (const account of spendableAccounts) {
    if (account.status !== "active") {
      missing.add("Use only active accounts for spendable cash");
      continue;
    }
    const snapshot = latestByAccount.get(account.id);
    if (!snapshot) {
      missing.add("Sync or enter current spendable account balances");
      continue;
    }
    if (snapshot.currency !== currency) {
      missing.add("Resolve spendable account currency mismatches");
      continue;
    }
    if (!snapshotIsFresh(snapshot)) {
      missing.add("Refresh spendable balances older than seven days");
    }
    spendableLiquidity += snapshot.availableBalance ?? snapshot.currentBalance;
  }

  const liquidAccounts = accountRows.filter(
    (account) =>
      account.includeInNetWorth &&
      account.status !== "closed" &&
      account.status !== "hidden" &&
      ["cash", "credit", "loan", "investment", "crypto"].includes(account.group),
  );
  if (liquidAccounts.length === 0) missing.add("Add an account included in liquid net worth");
  let currentLiquidNetWorth = 0n;
  for (const account of liquidAccounts) {
    if (account.status === "stale") {
      missing.add("Refresh every account included in liquid net worth");
    }
    const snapshot = latestByAccount.get(account.id);
    if (!snapshot) {
      missing.add("Sync every account included in liquid net worth");
      continue;
    }
    if (snapshot.currency !== currency) {
      missing.add("Resolve liquid net-worth currency mismatches");
      continue;
    }
    if (!snapshotIsFresh(snapshot)) {
      missing.add("Refresh liquid net-worth balances older than seven days");
    }
    const amount = snapshot.currentBalance;
    currentLiquidNetWorth += account.isLiability && amount > 0n ? -amount : amount;
  }

  const minimumBufferText = defaults.preferences.minimumBufferMinorUnits;
  const minimumBuffer = minimumBufferText === undefined ? undefined : BigInt(minimumBufferText);
  if (minimumBuffer === undefined) missing.add("Confirm a protected minimum cash buffer");

  const targetLiquidNetWorthText = defaults.preferences.targetLiquidNetWorthMinorUnits;
  const targetLiquidNetWorth =
    targetLiquidNetWorthText === undefined ? undefined : BigInt(targetLiquidNetWorthText);
  if (targetLiquidNetWorth === undefined) missing.add("Confirm a liquid wealth target");
  const birthDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(profile?.birthDate ?? "");
  const targetAge = profile?.targetAge ?? undefined;
  let targetWealthMonth: string | undefined;
  if (!birthDateMatch) {
    missing.add("Add a birth date for the wealth-target horizon");
  } else if (targetAge === undefined) {
    missing.add("Choose a target age for the wealth milestone");
  } else {
    targetWealthMonth = `${Number(birthDateMatch[1]) + targetAge}-${birthDateMatch[2]}`;
    if (targetWealthMonth <= startOfCurrentMonth(now, timeZone)) {
      missing.add("Choose a future target age for the wealth milestone");
    }
  }

  const matchingBills = requiredBillRows.filter((bill) => bill.currency === currency);
  if (matchingBills.length !== requiredBillRows.length) {
    missing.add("Resolve required bill currency mismatches");
  }
  let requiredMonthlyBills: bigint | undefined;
  if (matchingBills.length > 0) {
    requiredMonthlyBills = matchingBills.reduce(
      (total, bill) =>
        total + averageMonthlyAmount(bill.amountMax, cadenceFromDueRule(bill.dueRule)),
      0n,
    );
  } else if (defaults.preferences.reservedBillsMinorUnits !== undefined) {
    requiredMonthlyBills = BigInt(defaults.preferences.reservedBillsMinorUnits);
  } else {
    missing.add("Confirm required bills, including an explicit zero when none exist");
  }

  let monthlySurplus: bigint | undefined;
  let monthlySurplusSource: "explicit_budget" | "observed_90_day" | undefined;
  let requiredObligationShortfall = 0n;
  if (monthPeriod && monthPeriod.currency === currency && monthPeriod.expectedIncome > 0n) {
    const explicitBudget = (await budgetDtos(db, householdId, monthPeriod.id))[0];
    if (explicitBudget) {
      const confirmedMonthlyIncome = activeIncomeRows
        .filter((source) => source.currency === currency && source.typicalAmount > 0n)
        .reduce(
          (total, source) => total + averageMonthlyAmount(source.typicalAmount, source.cadence),
          0n,
        );
      const incomeIsBacked =
        monthPeriod.actualIncome >= monthPeriod.expectedIncome ||
        confirmedMonthlyIncome >= monthPeriod.expectedIncome;
      if (!incomeIsBacked) {
        missing.add("Back the monthly budget income with an active income source or actual income");
      }
      const plannedByEnvelope = new Map(
        explicitBudget.envelopes.map((item) => [item.id, BigInt(item.planned.minorUnits)]),
      );
      const requiredByEnvelope = new Map<string, bigint>();
      let billsWithoutEnvelope = 0n;
      for (const bill of matchingBills) {
        const monthlyAmount = averageMonthlyAmount(
          bill.amountMax,
          cadenceFromDueRule(bill.dueRule),
        );
        if (!bill.envelopeId) {
          billsWithoutEnvelope += monthlyAmount;
          continue;
        }
        requiredByEnvelope.set(
          bill.envelopeId,
          (requiredByEnvelope.get(bill.envelopeId) ?? 0n) + monthlyAmount,
        );
      }
      requiredObligationShortfall = billsWithoutEnvelope;
      for (const [envelopeId, required] of requiredByEnvelope) {
        const planned = plannedByEnvelope.get(envelopeId) ?? 0n;
        if (planned < required) requiredObligationShortfall += required - planned;
      }
      if (matchingBills.length === 0 && (requiredMonthlyBills ?? 0n) > 0n) {
        requiredObligationShortfall = requiredMonthlyBills ?? 0n;
      }
      if (incomeIsBacked) {
        monthlySurplus = BigInt(explicitBudget.surplus.minorUnits) - requiredObligationShortfall;
        monthlySurplusSource = "explicit_budget";
      }
    }
  }
  if (monthlySurplus === undefined) {
    const posted = activityRows.filter(
      (transaction) =>
        transaction.status === "posted" &&
        !transaction.isExcluded &&
        !transaction.isTransfer &&
        transaction.currency === currency,
    );
    const oldest = posted.reduce(
      (value, transaction) =>
        value === null || transaction.transactedOn < value ? transaction.transactedOn : value,
      null as string | null,
    );
    const newest = posted.reduce(
      (value, transaction) =>
        value === null || transaction.transactedOn > value ? transaction.transactedOn : value,
      null as string | null,
    );
    let income = 0n;
    let expenses = 0n;
    for (const transaction of posted) {
      if (transaction.amount > 0n) {
        if (transaction.isIncome) income += transaction.amount;
        else {
          expenses -= cappedConfirmedRefund(
            transaction.amount,
            confirmedRefundByTransaction.get(transaction.id),
          );
        }
      } else {
        expenses += -transaction.amount;
      }
    }
    const coverageDays =
      oldest && newest
        ? Math.floor(
            (Date.parse(`${newest.slice(0, 10)}T00:00:00.000Z`) -
              Date.parse(`${oldest.slice(0, 10)}T00:00:00.000Z`)) /
              86_400_000,
          )
        : 0;
    if (
      oldest &&
      newest &&
      newest.slice(0, 10) >= sevenDaysAgo &&
      newest.slice(0, 10) <= today &&
      coverageDays >= 60 &&
      income > 0n
    ) {
      const observed =
        ((income - (expenses > 0n ? expenses : 0n)) * 30n) / BigInt(coverageDays + 1);
      // Listed obligations are reserved again because a 90-day window can miss annual or
      // quarterly bills. This intentionally biases the purchase date later, never earlier.
      monthlySurplus = observed - (requiredMonthlyBills ?? 0n);
      monthlySurplusSource = "observed_90_day";
      requiredObligationShortfall = 0n;
    }
  }
  if (monthlySurplus === undefined) {
    missing.add(
      "Create a backed monthly budget or import a fresh, continuous 60-day cash-flow history",
    );
  }

  const liquidFundingGroups = new Set(["cash", "investment", "crypto"]);
  const fundingCapacityByAccount = new Map<string, bigint>();
  for (const account of accountRows) {
    const snapshot = latestByAccount.get(account.id);
    if (
      account.status !== "active" ||
      account.isLiability ||
      account.currency !== currency ||
      !liquidFundingGroups.has(account.group) ||
      !snapshot ||
      snapshot.currency !== currency ||
      !snapshotIsFresh(snapshot)
    ) {
      continue;
    }
    const balance =
      account.group === "cash"
        ? (snapshot.availableBalance ?? snapshot.currentBalance)
        : snapshot.currentBalance;
    fundingCapacityByAccount.set(account.id, balance > 0n ? balance : 0n);
  }
  const remainingFundingCapacity = new Map(fundingCapacityByAccount);
  const verifiedFundingByGoal = new Map<string, bigint>();
  for (const goal of [...goalRows]
    .filter((row) => row.status !== "cancelled" && row.currency === currency)
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        left.name.localeCompare(right.name) ||
        left.id.localeCompare(right.id),
    )) {
    const accountId = goal.fundingAccountId;
    if (!accountId) {
      verifiedFundingByGoal.set(goal.id, 0n);
      continue;
    }
    const available = remainingFundingCapacity.get(accountId) ?? 0n;
    const claim = goal.fundedAmount < available ? goal.fundedAmount : available;
    verifiedFundingByGoal.set(goal.id, claim > 0n ? claim : 0n);
    remainingFundingCapacity.set(accountId, available > claim ? available - claim : 0n);
  }
  const spendableAccountIds = new Set(spendableAccounts.map((account) => account.id));
  const verifiedSpendableClaims = goalRows.reduce((total, goal) => {
    if (!goal.fundingAccountId || !spendableAccountIds.has(goal.fundingAccountId)) return total;
    return total + (verifiedFundingByGoal.get(goal.id) ?? 0n);
  }, 0n);
  const unreservedLiquidity =
    spendableLiquidity > verifiedSpendableClaims
      ? spendableLiquidity - verifiedSpendableClaims
      : 0n;

  const plans = new Map<string, ComfortablePurchasePlanDto>();
  for (const purchase of purchaseRows) {
    const sameCurrencyGoals = goalRows.filter(
      (goal) => goal.currency === purchase.currency && goal.status !== "cancelled",
    );
    if (purchase.currency !== currency) {
      plans.set(
        purchase.id,
        incompleteComfortablePurchasePlan(
          purchase.currency,
          ["Use the household base currency for purchase planning"],
          {
            higherPriorityMonthlyFunding: 0n,
          },
        ),
      );
      continue;
    }
    const higherPriority = sameCurrencyGoals.filter(
      (goal) =>
        goal.id !== purchase.id &&
        goal.status === "active" &&
        goal.priority < purchase.priority &&
        (verifiedFundingByGoal.get(goal.id) ?? 0n) < goal.targetAmount,
    );
    const higherPriorityMonthlyFunding = higherPriority.reduce(
      (total, goal) => total + BigInt(goalMonthlyAmount(goal.contributionPolicy)),
      0n,
    );
    const missingInputs = [...missing];
    const fundingAccount = purchase.fundingAccountId
      ? accountById.get(purchase.fundingAccountId)
      : undefined;
    const fundingSnapshot = fundingAccount ? latestByAccount.get(fundingAccount.id) : undefined;
    if (!purchase.fundingAccountId) {
      missingInputs.push("Link a liquid funding account to this purchase goal");
    } else if (
      !fundingAccount ||
      fundingAccount.status !== "active" ||
      fundingAccount.isLiability ||
      fundingAccount.currency !== currency ||
      !liquidFundingGroups.has(fundingAccount.group)
    ) {
      missingInputs.push("Use an active, currency-matched liquid purchase funding account");
    } else if (
      !fundingSnapshot ||
      fundingSnapshot.currency !== currency ||
      !snapshotIsFresh(fundingSnapshot)
    ) {
      missingInputs.push("Refresh the purchase funding account balance");
    }
    const fundingAccountBalance = purchase.fundingAccountId
      ? fundingCapacityByAccount.get(purchase.fundingAccountId)
      : undefined;
    const verifiedPurchaseSavings = verifiedFundingByGoal.get(purchase.id) ?? 0n;
    if (missingInputs.length > 0) {
      plans.set(
        purchase.id,
        incompleteComfortablePurchasePlan(currency, missingInputs, {
          spendableLiquidity,
          unreservedLiquidity,
          ...(fundingAccountBalance === undefined ? {} : { fundingAccountBalance }),
          verifiedPurchaseSavings,
          ...(minimumBuffer === undefined ? {} : { minimumBuffer }),
          ...(requiredMonthlyBills === undefined ? {} : { requiredMonthlyBills }),
          requiredObligationShortfall,
          higherPriorityMonthlyFunding,
          ...(monthlySurplus === undefined ? {} : { monthlySurplus }),
          ...(monthlySurplusSource === undefined ? {} : { monthlySurplusSource }),
          currentLiquidNetWorth,
          ...(targetLiquidNetWorth === undefined ? {} : { targetLiquidNetWorth }),
          ...(targetWealthMonth === undefined
            ? {}
            : { targetWealthDate: `${targetWealthMonth}-01` }),
        }),
      );
      continue;
    }

    if (
      minimumBuffer === undefined ||
      requiredMonthlyBills === undefined ||
      monthlySurplus === undefined ||
      monthlySurplusSource === undefined ||
      targetLiquidNetWorth === undefined ||
      targetWealthMonth === undefined ||
      targetAge === undefined
    ) {
      throw new Error("Complete purchase-planning inputs failed to narrow");
    }

    const purchaseMonthly =
      purchase.status === "active" ? BigInt(goalMonthlyAmount(purchase.contributionPolicy)) : 0n;
    const emergencyGoals = sameCurrencyGoals.filter((goal) => goal.type === "emergency_fund");
    const verifiedEmergencyFunding = emergencyGoals.reduce(
      (total, goal) => total + (verifiedFundingByGoal.get(goal.id) ?? 0n),
      0n,
    );
    const emergencyReserve =
      emergencyGoals.length > 0 ? verifiedEmergencyFunding : unreservedLiquidity;
    const higherPriorityPolicies = higherPriority.map((goal) => {
      const contribution = BigInt(goalMonthlyAmount(goal.contributionPolicy));
      const verifiedCurrent = verifiedFundingByGoal.get(goal.id) ?? 0n;
      const projection = projectGoal({
        startMonth: startOfCurrentMonth(now, timeZone),
        currentAmount: money(verifiedCurrent, currency),
        targetAmount: money(goal.targetAmount, currency),
        monthlyContribution: money(contribution, currency),
        horizonMonths: 120,
      });
      const targetMonth = goal.targetDate?.slice(0, 7) ?? projection.reachedMonth;
      return {
        id: goal.id,
        currentAmount: money(verifiedCurrent, currency),
        targetAmount: money(goal.targetAmount, currency),
        monthlyContribution: money(contribution, currency),
        ...(targetMonth ? { targetMonth } : {}),
        ...(goal.type === "emergency_fund" ? { countsTowardEmergencyReserve: true } : {}),
      };
    });
    const result = comfortablePurchaseDate({
      startMonth: startOfCurrentMonth(now, timeZone),
      purchasePrice: money(purchase.targetAmount, currency),
      currentPurchaseSavings: money(verifiedPurchaseSavings, currency),
      monthlyPurchaseContribution: money(purchaseMonthly, currency),
      emergencyReserve: money(emergencyReserve, currency),
      emergencyFloor: money(minimumBuffer, currency),
      checkingBalance: money(unreservedLiquidity, currency),
      checkingBuffer: money(minimumBuffer, currency),
      monthlyCheckingChange: money(monthlySurplus, currency),
      monthlyCashSurplusBeforeGoalContributions: money(monthlySurplus, currency),
      requiredObligationShortfall: money(requiredObligationShortfall, currency),
      lookAheadMonths: 3,
      horizonMonths: 120,
      higherPriorityGoals: higherPriorityPolicies,
      currentNetWorth: money(currentLiquidNetWorth, currency),
      targetNetWorth: money(targetLiquidNetWorth, currency),
      targetNetWorthMonth: targetWealthMonth,
      monthlyNetWorthChange: money(monthlySurplus, currency),
      purchaseNetWorthImpact: money(purchase.targetAmount, currency),
    });
    const constraintDetails: Record<PurchaseConstraint, string> = {
      purchaseFunding: "Goal savings must reach the full purchase price.",
      emergencyFloor: "Emergency reserves must remain above the confirmed protected cash floor.",
      requiredObligations:
        requiredObligationShortfall > 0n
          ? "One or more required bill maximums are not fully represented in the current budget."
          : "Every listed required bill maximum is represented before surplus is available.",
      checkingBuffer: "Unreserved checking is stress-tested through three months after purchase.",
      higherPriorityGoals:
        "Every unfinished higher-priority goal keeps a positive pace; capped transfers stop when its target is reached.",
      targetNetWorth: `Projected liquid net worth must meet the saved target by age ${targetAge}; a purchase on or before that milestone is conservatively treated as a complete write-off.`,
      horizon: "No month inside the conservative 10-year planning window clears every guardrail",
    };
    const constraintCodes: Exclude<PurchaseConstraint, "horizon">[] = [
      "purchaseFunding",
      "emergencyFloor",
      "requiredObligations",
      "checkingBuffer",
      "higherPriorityGoals",
      "targetNetWorth",
    ];
    const constraints = constraintCodes.map((code) => ({
      code,
      label: comfortableConstraintLabels[code],
      satisfied: result.finalState.constraints[code],
      detail: constraintDetails[code],
    }));
    const limitingConstraints = result.limitingConstraints.map((code) => ({
      code,
      label: comfortableConstraintLabels[code],
      satisfied: code === "horizon" ? false : result.finalState.constraints[code],
      detail: constraintDetails[code],
    }));
    plans.set(purchase.id, {
      status: result.comfortable ? "comfortable" : "not_comfortable",
      comfortable: result.comfortable,
      comfortableMonth: result.comfortableMonth,
      monthsUntilPurchase: result.monthsUntilPurchase,
      controllingConstraint: result.controllingConstraint,
      limitingConstraints,
      constraints,
      missingInputs: [],
      inputs: {
        spendableLiquidity: moneyJson(spendableLiquidity, currency),
        unreservedLiquidity: moneyJson(unreservedLiquidity, currency),
        fundingAccountBalance: moneyJson(fundingAccountBalance ?? 0n, currency),
        verifiedPurchaseSavings: moneyJson(verifiedPurchaseSavings, currency),
        protectedMinimumBuffer: moneyJson(minimumBuffer, currency),
        requiredMonthlyBills: moneyJson(requiredMonthlyBills, currency),
        requiredObligationShortfall: moneyJson(requiredObligationShortfall, currency),
        higherPriorityMonthlyFunding: moneyJson(higherPriorityMonthlyFunding, currency),
        monthlySurplus: moneyJson(monthlySurplus, currency),
        monthlySurplusSource,
        currentLiquidNetWorth: moneyJson(currentLiquidNetWorth, currency),
        targetLiquidNetWorth: moneyJson(targetLiquidNetWorth, currency),
        targetWealthDate: `${targetWealthMonth}-01`,
        projectedLiquidNetWorthAtTarget: result.finalState.projectedTargetNetWorth
          ? moneyJson(result.finalState.projectedTargetNetWorth.minorUnits, currency)
          : null,
      },
      assumptions: [
        "Recorded purchase savings are capped by a fresh liquid funding-account balance after higher-priority claims on that account.",
        "Goal contributions are modeled as transfers from unreserved cash and stop when each target is reached.",
        "The checking low is tested at monthly intervals for three months beyond each candidate month.",
        monthlySurplusSource === "explicit_budget"
          ? "Monthly surplus comes from the current month budget after its expected income is backed and required-bill shortfalls are deducted."
          : "Monthly surplus uses a fresh posted-cash-flow span of at least 60 days and reserves listed required bills again for conservatism.",
        "A purchase on or before the wealth milestone is treated as a 100% loss of liquid net worth, even if it retains resale value.",
        ...(purchase.fundedAmount > verifiedPurchaseSavings
          ? [
              "Recorded goal funding exceeded verified account capacity, so the model used the lower verified amount.",
            ]
          : []),
      ],
    });
  }
  return plans;
}

async function goalDtos(
  db: BetterWealthDatabase,
  householdId: string,
  userId: string,
  rows: readonly (typeof goals.$inferSelect)[],
  now: Date,
) {
  const [purchasePlans, timeZone] = await Promise.all([
    comfortablePurchasePlans(db, householdId, userId, rows, now),
    householdTimezone(db, householdId),
  ]);
  return rows.map((row) => goalDto(row, now, timeZone, purchasePlans.get(row.id)));
}

async function goalDtoWithComfort(
  db: BetterWealthDatabase,
  householdId: string,
  userId: string,
  row: typeof goals.$inferSelect,
  now: Date,
) {
  const allRows = await db
    .select()
    .from(goals)
    .where(eq(goals.householdId, householdId))
    .orderBy(asc(goals.priority), asc(goals.name));
  const [purchasePlans, timeZone] = await Promise.all([
    comfortablePurchasePlans(db, householdId, userId, allRows, now),
    householdTimezone(db, householdId),
  ]);
  return goalDto(row, now, timeZone, purchasePlans.get(row.id));
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

export function createGoalRoutes(db: BetterWealthDatabase, config: AppConfig, now: () => Date) {
  const routes = new Hono<AppEnv>();

  // Goals ------------------------------------------------------------------

  routes.get("/goals", async (context) => {
    const auth = context.get("auth");
    const rows = await db
      .select()
      .from(goals)
      .where(eq(goals.householdId, auth.householdId))
      .orderBy(asc(goals.priority), asc(goals.name));
    return context.json(page(await goalDtos(db, auth.householdId, auth.user.id, rows, now())));
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
    db.transaction((transaction) => {
      for (const [index, id] of orderedIds.entries()) {
        transaction
          .update(goals)
          .set({ priority: index + 1, updatedAt })
          .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, id)))
          .run();
      }
    });
    const reordered = await db
      .select()
      .from(goals)
      .where(eq(goals.householdId, auth.householdId))
      .orderBy(asc(goals.priority), asc(goals.name));
    return context.json(page(await goalDtos(db, auth.householdId, auth.user.id, reordered, now())));
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
    return context.json(
      await goalDtoWithComfort(db, auth.householdId, auth.user.id, row, now()),
      201,
    );
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
    return context.json(
      await goalDtoWithComfort(db, auth.householdId, auth.user.id, updated, now()),
    );
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
    db.transaction((transaction) => {
      const latestGoal = transaction
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
      transaction
        .insert(allocationEntries)
        .values({
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
        })
        .run();
      transaction
        .insert(goalContributions)
        .values({
          id: contributionId,
          householdId: auth.householdId,
          goalId: goal.id,
          allocationEntryId: allocationId,
          amount: amount.minor,
          currency: goal.currency,
          contributedOn: input.contributedOn,
          ...(input.note ? { note: input.note } : {}),
        })
        .run();
      const fundedAmount = latestGoal.fundedAmount + amount.minor;
      const completed = fundedAmount === latestGoal.targetAmount;
      transaction
        .update(goals)
        .set({
          fundedAmount,
          ...(completed ? { status: "completed" as const, completedAt: nowIso() } : {}),
          updatedAt: nowIso(),
        })
        .where(and(eq(goals.householdId, auth.householdId), eq(goals.id, goal.id)))
        .run();
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
        goal: await goalDtoWithComfort(db, auth.householdId, auth.user.id, updated, now()),
      },
      201,
    );
  });

  return routes;
}
