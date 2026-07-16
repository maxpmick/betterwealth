import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  assets,
  assetValuations,
  balanceSnapshots,
  bills,
  budgetPeriods,
  categories,
  envelopeAllocations,
  envelopes,
  forecastRuns,
  forecastScenarios,
  goals,
  households,
  incomeSources,
  settings,
  transactionSplits,
  transactions,
  users,
} from "@betterwealth/db/schema";
import { calculateSafeToSpend, money as engineMoney, MoneyJsonSchema } from "@betterwealth/shared";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireAuth, requireCsrf } from "../auth/middleware";
import type { AppConfig } from "../config";
import { ConflictError, NotFoundError } from "../lib/errors";
import type { AppEnv } from "../types";

type BalancePoint = {
  accountId: string;
  amount: bigint;
  available: bigint | null;
  currency: string;
  asOf: string;
};

const safeToSpendPreferencesSchema = z
  .object({
    spendableAccountIds: z.array(z.string()).optional(),
    minimumBufferMinorUnits: z.string().regex(/^\d+$/).optional(),
    envelopeCommitmentMinorUnits: z.string().regex(/^\d+$/).optional(),
    goalContributionMinorUnits: z.string().regex(/^\d+$/).optional(),
    reservedBillsMinorUnits: z.string().regex(/^\d+$/).optional(),
    targetLiquidNetWorthMinorUnits: z.string().regex(/^\d+$/).optional(),
  })
  .passthrough();

const nonNegativeMoneySchema = MoneyJsonSchema.refine(
  (value) => BigInt(value.minorUnits) >= 0n,
  "Planning amounts cannot be negative",
);
const positiveMoneySchema = MoneyJsonSchema.refine(
  (value) => BigInt(value.minorUnits) > 0n,
  "A positive wealth target is required",
);

const dashboardPreferencesPatchSchema = z
  .object({
    minimumBuffer: nonNegativeMoneySchema.nullable().optional(),
    targetLiquidNetWorth: positiveMoneySchema.nullable().optional(),
    reservedBills: nonNegativeMoneySchema.nullable().optional(),
  })
  .strict();

const forecastOutputSchema = z.object({
  months: z
    .array(
      z.object({
        netWorth: z.object({ minorUnits: z.string().regex(/^-?\d+$/), currency: z.string() }),
      }),
    )
    .min(1),
});

function policyContribution(value: unknown, daysToPaycheck: number): bigint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0n;
  const policy = value as Record<string, unknown>;
  for (const key of ["perPaycheckMinorUnits", "amountPerPaycheckMinorUnits"]) {
    const amount = policy[key];
    if (typeof amount === "string" && /^\d+$/.test(amount)) return BigInt(amount);
  }
  const amount = policy.amount;
  const amountMinor =
    amount && typeof amount === "object" && !Array.isArray(amount)
      ? (amount as Record<string, unknown>).minorUnits
      : (policy.monthlyAmountMinorUnits ??
        policy.monthlyContributionMinorUnits ??
        policy.monthlyMinorUnits);
  if (typeof amountMinor !== "string" || !/^\d+$/.test(amountMinor)) return 0n;
  const cadence = typeof policy.cadence === "string" ? policy.cadence : "monthly";
  if (cadence === "paycheck" || cadence === "per_paycheck") return BigInt(amountMinor);
  if (cadence === "weekly") return (BigInt(amountMinor) * BigInt(daysToPaycheck) + 6n) / 7n;
  return (BigInt(amountMinor) * BigInt(daysToPaycheck) + 29n) / 30n;
}

function money(minorUnits: bigint, currency: string) {
  return { minorUnits: minorUnits.toString(), currency };
}

function dashboardPreferencesDto(
  preference: z.infer<typeof safeToSpendPreferencesSchema>,
  currency: string,
) {
  return {
    currency,
    minimumBuffer:
      preference.minimumBufferMinorUnits === undefined
        ? null
        : money(BigInt(preference.minimumBufferMinorUnits), currency),
    targetLiquidNetWorth:
      preference.targetLiquidNetWorthMinorUnits === undefined
        ? null
        : money(BigInt(preference.targetLiquidNetWorthMinorUnits), currency),
    reservedBills:
      preference.reservedBillsMinorUnits === undefined
        ? null
        : money(BigInt(preference.reservedBillsMinorUnits), currency),
  };
}

function signedNetWorthBalance(amount: bigint, isLiability: boolean): bigint {
  if (!isLiability) return amount;
  return amount > 0n ? -amount : amount;
}

async function reportContext(db: BetterWealthDatabase, householdId: string, userId: string) {
  const [household, user, accountRows, balanceRows, assetRows, valuationRows] = await Promise.all([
    db.select().from(households).where(eq(households.id, householdId)).get(),
    db.select().from(users).where(eq(users.id, userId)).get(),
    db.select().from(accounts).where(eq(accounts.householdId, householdId)),
    db
      .select()
      .from(balanceSnapshots)
      .where(eq(balanceSnapshots.householdId, householdId))
      .orderBy(desc(balanceSnapshots.asOf)),
    db
      .select()
      .from(assets)
      .where(and(eq(assets.householdId, householdId), eq(assets.isActive, true))),
    db
      .select()
      .from(assetValuations)
      .where(eq(assetValuations.householdId, householdId))
      .orderBy(desc(assetValuations.valuedOn), desc(assetValuations.createdAt)),
  ]);
  const latest = new Map<string, BalancePoint>();
  for (const balance of balanceRows) {
    if (!latest.has(balance.accountId)) {
      latest.set(balance.accountId, {
        accountId: balance.accountId,
        amount: balance.currentBalance,
        available: balance.availableBalance,
        currency: balance.currency,
        asOf: balance.asOf,
      });
    }
  }
  return {
    household,
    user,
    accounts: accountRows,
    balanceRows,
    assets: assetRows,
    valuationRows,
    latest,
    currency: household?.baseCurrency ?? "USD",
  };
}

export function createReportRoutes(db: BetterWealthDatabase, config: AppConfig) {
  const routes = new Hono<AppEnv>();
  routes.use("*", requireAuth(db, config));

  routes.get("/dashboard/preferences", async (context) => {
    const auth = context.get("auth");
    const [household, settingRow] = await Promise.all([
      db
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, auth.householdId))
        .get(),
      db
        .select({ value: settings.value })
        .from(settings)
        .where(
          and(
            eq(settings.householdId, auth.householdId),
            eq(settings.scopeKey, "household"),
            eq(settings.key, "planning.safe_to_spend"),
          ),
        )
        .get(),
    ]);
    if (!household) throw new NotFoundError("Household");
    const parsed = safeToSpendPreferencesSchema.safeParse(settingRow?.value);
    return context.json(
      dashboardPreferencesDto(parsed.success ? parsed.data : {}, household.currency),
    );
  });

  routes.patch("/dashboard/preferences", requireCsrf(config), async (context) => {
    const auth = context.get("auth");
    const input = dashboardPreferencesPatchSchema.parse(await context.req.json());
    const [household, settingRow] = await Promise.all([
      db
        .select({ currency: households.baseCurrency })
        .from(households)
        .where(eq(households.id, auth.householdId))
        .get(),
      db
        .select({ value: settings.value })
        .from(settings)
        .where(
          and(
            eq(settings.householdId, auth.householdId),
            eq(settings.scopeKey, "household"),
            eq(settings.key, "planning.safe_to_spend"),
          ),
        )
        .get(),
    ]);
    if (!household) throw new NotFoundError("Household");
    for (const value of [input.minimumBuffer, input.targetLiquidNetWorth, input.reservedBills]) {
      if (value && value.currency !== household.currency) {
        throw new ConflictError(
          `Planning amounts must use ${household.currency}`,
          "currency_mismatch",
        );
      }
    }
    const parsed = safeToSpendPreferencesSchema.safeParse(settingRow?.value);
    const next: z.infer<typeof safeToSpendPreferencesSchema> = parsed.success
      ? { ...parsed.data }
      : {};
    for (const [field, storageKey] of [
      ["minimumBuffer", "minimumBufferMinorUnits"],
      ["targetLiquidNetWorth", "targetLiquidNetWorthMinorUnits"],
      ["reservedBills", "reservedBillsMinorUnits"],
    ] as const) {
      const value = input[field];
      if (value === undefined) continue;
      if (value === null) delete next[storageKey];
      else next[storageKey] = value.minorUnits;
    }
    const timestamp = new Date().toISOString();
    await db
      .insert(settings)
      .values({
        id: ulid(),
        householdId: auth.householdId,
        userId: null,
        scopeKey: "household",
        key: "planning.safe_to_spend",
        value: next,
        isSecret: false,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [settings.householdId, settings.scopeKey, settings.key],
        set: { value: next, updatedAt: timestamp },
      });
    return context.json(dashboardPreferencesDto(next, household.currency));
  });

  routes.get("/dashboard", async (context) => {
    const auth = context.get("auth");
    const report = await reportContext(db, auth.householdId, auth.user.id);
    const settingRow = await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.householdId, auth.householdId),
          eq(settings.scopeKey, "household"),
          eq(settings.key, "planning.safe_to_spend"),
        ),
      )
      .get();
    const preferences = safeToSpendPreferencesSchema.safeParse(settingRow?.value);
    const preference = preferences.success ? preferences.data : {};
    const defaultSpendable = report.accounts.filter(
      (account) =>
        account.group === "cash" &&
        account.includeInBudget &&
        !/saving|money.?market/i.test(`${account.type} ${account.subtype ?? ""}`),
    );
    const spendableIds = new Set(
      preference.spendableAccountIds ??
        (defaultSpendable.length > 0
          ? defaultSpendable.map(({ id }) => id)
          : report.accounts
              .filter((account) => account.group === "cash" && account.includeInBudget)
              .map(({ id }) => id)),
    );
    let availableCash = 0n;
    let liquidNetWorth = 0n;
    let latestAsOf: string | undefined;
    for (const account of report.accounts) {
      const balance = report.latest.get(account.id);
      if (!balance || balance.currency !== report.currency) continue;
      if (!latestAsOf || balance.asOf > latestAsOf) latestAsOf = balance.asOf;
      if (spendableIds.has(account.id)) {
        availableCash += balance.available ?? balance.amount;
      }
      if (
        account.includeInNetWorth &&
        ["cash", "credit", "loan", "investment", "crypto"].includes(account.group)
      ) {
        liquidNetWorth += signedNetWorthBalance(balance.amount, account.isLiability);
      }
    }

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const activeIncomeRows = await db
      .select({
        nextExpectedDate: incomeSources.nextExpectedDate,
        typicalAmount: incomeSources.typicalAmount,
        currency: incomeSources.currency,
      })
      .from(incomeSources)
      .where(
        and(eq(incomeSources.householdId, auth.householdId), eq(incomeSources.isActive, true)),
      );
    const nextIncome = activeIncomeRows
      .filter(
        (source) =>
          source.nextExpectedDate !== null && source.nextExpectedDate.slice(0, 10) >= today,
      )
      .sort((left, right) =>
        (left.nextExpectedDate ?? "").localeCompare(right.nextExpectedDate ?? ""),
      )[0];
    const fallbackCoveredThrough = new Date(Date.now() + 14 * 86_400_000);
    const coveredThroughDate = nextIncome?.nextExpectedDate
      ? new Date(`${nextIncome.nextExpectedDate.slice(0, 10)}T23:59:59.999Z`)
      : fallbackCoveredThrough;
    const daysToPaycheck = Math.max(
      1,
      Math.min(62, Math.ceil((coveredThroughDate.getTime() - Date.now()) / 86_400_000)),
    );
    const coveredThrough = coveredThroughDate.toISOString();
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const activity = await db
      .select({
        amount: transactions.amount,
        status: transactions.status,
        isExcluded: transactions.isExcluded,
        isTransfer: transactions.isTransfer,
        isIncome: transactions.isIncome,
        transactedOn: transactions.transactedOn,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          gte(transactions.transactedOn, ninetyDaysAgo),
        ),
      );
    let income = 0n;
    let expenses = 0n;
    let pendingImpact = 0n;
    for (const transaction of activity) {
      if (transaction.isExcluded || transaction.isTransfer) continue;
      if (transaction.status === "pending") pendingImpact += transaction.amount;
      if (transaction.status !== "posted") continue;
      if (transaction.amount > 0n) {
        if (transaction.isIncome) income += transaction.amount;
        else expenses -= transaction.amount;
      } else {
        expenses += -transaction.amount;
      }
    }

    const netExpenses = expenses > 0n ? expenses : 0n;
    const monthlyIncome = income / 3n;
    const monthlyExpenses = netExpenses / 3n;
    const monthlySurplus = monthlyIncome - monthlyExpenses;
    const savingsRate = income > 0n ? Number(((income - netExpenses) * 10_000n) / income) / 100 : 0;
    const billRows = await db
      .select({ amount: bills.amountMax, currency: bills.currency, envelopeId: bills.envelopeId })
      .from(bills)
      .where(
        and(
          eq(bills.householdId, auth.householdId),
          eq(bills.isActive, true),
          eq(bills.isRequired, true),
          gte(bills.nextDueDate, today),
          lte(bills.nextDueDate, coveredThrough.slice(0, 10)),
        ),
      );
    const billEnvelopeIds = new Set(
      billRows.map(({ envelopeId }) => envelopeId).filter((id): id is string => Boolean(id)),
    );
    const derivedReservedBills = billRows.reduce(
      (total, bill) => total + (bill.currency === report.currency ? bill.amount : 0n),
      0n,
    );
    const currentPeriod = await db
      .select({ id: budgetPeriods.id })
      .from(budgetPeriods)
      .where(
        and(
          eq(budgetPeriods.householdId, auth.householdId),
          lte(budgetPeriods.startsOn, today),
          gte(budgetPeriods.endsOn, today),
          eq(budgetPeriods.status, "open"),
        ),
      )
      .orderBy(desc(budgetPeriods.startsOn))
      .get();
    const allocationRows = currentPeriod
      ? await db
          .select({
            available: envelopeAllocations.availableSnapshot,
            currency: envelopeAllocations.currency,
            envelopeId: envelopeAllocations.envelopeId,
            isRequired: envelopes.isRequired,
          })
          .from(envelopeAllocations)
          .innerJoin(envelopes, eq(envelopes.id, envelopeAllocations.envelopeId))
          .where(
            and(
              eq(envelopeAllocations.householdId, auth.householdId),
              eq(envelopeAllocations.budgetPeriodId, currentPeriod.id),
              eq(envelopes.isActive, true),
            ),
          )
      : [];
    const derivedEnvelopeCommitments = allocationRows.reduce((total, allocation) => {
      if (
        allocation.currency !== report.currency ||
        allocation.available <= 0n ||
        billEnvelopeIds.has(allocation.envelopeId)
      ) {
        return total;
      }
      return total + allocation.available;
    }, 0n);
    const activeGoals = await db
      .select({ contributionPolicy: goals.contributionPolicy, currency: goals.currency })
      .from(goals)
      .where(and(eq(goals.householdId, auth.householdId), eq(goals.status, "active")));
    const derivedGoalContributions = activeGoals.reduce(
      (total, goal) =>
        total +
        (goal.currency === report.currency
          ? policyContribution(goal.contributionPolicy, daysToPaycheck)
          : 0n),
      0n,
    );
    const minimumBuffer = preference.minimumBufferMinorUnits
      ? BigInt(preference.minimumBufferMinorUnits)
      : availableCash > 0n
        ? availableCash / 4n < 100_000n
          ? availableCash / 4n
          : 100_000n
        : 0n;
    const reservedBills = preference.reservedBillsMinorUnits
      ? BigInt(preference.reservedBillsMinorUnits)
      : derivedReservedBills;
    const envelopeCommitments = preference.envelopeCommitmentMinorUnits
      ? BigInt(preference.envelopeCommitmentMinorUnits)
      : derivedEnvelopeCommitments;
    const goalContributions = preference.goalContributionMinorUnits
      ? BigInt(preference.goalContributionMinorUnits)
      : derivedGoalContributions;
    const safeCalculation = calculateSafeToSpend({
      availableCash: engineMoney(availableCash, report.currency),
      reservedBills: engineMoney(reservedBills, report.currency),
      envelopeCommitments: engineMoney(envelopeCommitments, report.currency),
      goalContributions: engineMoney(goalContributions, report.currency),
      minimumBuffer: engineMoney(minimumBuffer, report.currency),
      provisional: !preferences.success || !nextIncome,
    });
    const safeToSpend = safeCalculation.safeToSpend.minorUnits;
    const safePerDay = safeToSpend / BigInt(daysToPaycheck);
    const birthDate = report.user?.birthDate ? new Date(report.user.birthDate) : undefined;
    const currentAge = birthDate
      ? (Date.now() - birthDate.getTime()) / (365.2425 * 86_400_000)
      : undefined;
    const targetAge = report.user?.targetAge ?? undefined;
    const monthsToTarget = BigInt(
      currentAge === undefined || targetAge === undefined
        ? 0
        : Math.max(0, Math.round((targetAge - currentAge) * 12)),
    );
    let projectedLiquidNetWorth = liquidNetWorth + monthlySurplus * monthsToTarget;
    let projectionSource: "forecast" | "cash_flow_run_rate" | "current_balance" =
      monthsToTarget > 0n && monthlySurplus !== 0n ? "cash_flow_run_rate" : "current_balance";
    const latestBaseForecast = await db
      .select({ outputs: forecastRuns.outputs })
      .from(forecastRuns)
      .innerJoin(forecastScenarios, eq(forecastScenarios.id, forecastRuns.scenarioId))
      .where(
        and(
          eq(forecastRuns.householdId, auth.householdId),
          eq(forecastRuns.state, "succeeded"),
          eq(forecastScenarios.isBase, true),
        ),
      )
      .orderBy(desc(forecastRuns.createdAt))
      .get();
    const forecastOutput = forecastOutputSchema.safeParse(latestBaseForecast?.outputs);
    if (forecastOutput.success) {
      const ending = forecastOutput.data.months.at(-1)?.netWorth;
      if (ending?.currency === report.currency) {
        projectedLiquidNetWorth = BigInt(ending.minorUnits);
        projectionSource = "forecast";
      }
    }
    const targetLiquidNetWorth = preference.targetLiquidNetWorthMinorUnits
      ? BigInt(preference.targetLiquidNetWorthMinorUnits)
      : 0n;
    const missingInputs: string[] = [];
    if (report.accounts.length === 0) missingInputs.push("Connect or add at least one account");
    const hasConfirmedIncome = activeIncomeRows.some(
      (source) => source.typicalAmount > 0n && source.currency === report.currency,
    );
    if (income === 0n && !hasConfirmedIncome) {
      missingInputs.push("Confirm a paycheck or recurring income source");
    } else if (!nextIncome) {
      missingInputs.push("Set the next expected payday");
    }
    if (!report.user?.birthDate)
      missingInputs.push("Add your birth date for an exact age-30 horizon");
    if (report.user?.targetAge === null) missingInputs.push("Choose a target age");
    if (preference.targetLiquidNetWorthMinorUnits === undefined) {
      missingInputs.push("Set a liquid wealth target");
    }
    if (preference.minimumBufferMinorUnits === undefined) {
      missingInputs.push("Confirm a minimum cash buffer");
    }
    if (billRows.length === 0 && !preference.reservedBillsMinorUnits) {
      missingInputs.push("Confirm upcoming bills and due dates");
    }
    if (allocationRows.length === 0 && !preference.envelopeCommitmentMinorUnits) {
      missingInputs.push("Create or fund an envelope budget for this pay period");
    }
    const stale = latestAsOf ? Date.now() - new Date(latestAsOf).getTime() > 7 * 86_400_000 : false;
    const state = missingInputs.length > 0 ? "incomplete" : stale ? "stale" : "ready";

    return context.json({
      safeToSpend: money(safeToSpend, report.currency),
      safePerDay: money(safePerDay, report.currency),
      coveredThrough,
      coveredThroughSource: nextIncome ? "income_source" : "default_window",
      availableCash: money(availableCash, report.currency),
      reservedBills: money(reservedBills, report.currency),
      envelopeCommitments: money(envelopeCommitments, report.currency),
      goalContributions: money(goalContributions, report.currency),
      minimumBuffer: money(minimumBuffer, report.currency),
      projectedLiquidNetWorth: money(projectedLiquidNetWorth, report.currency),
      targetLiquidNetWorth: money(targetLiquidNetWorth, report.currency),
      targetAge: targetAge ?? null,
      projectionSource,
      savingsRate: Math.max(-100, Math.min(100, savingsRate)),
      trust: {
        state,
        asOf: latestAsOf ?? new Date().toISOString(),
        pendingImpact: money(pendingImpact, report.currency),
        missingInputs,
        confidenceLabel:
          state === "ready"
            ? "High confidence"
            : state === "stale"
              ? "Data is stale"
              : "Setup in progress",
        correctiveAction: missingInputs[0],
      },
    });
  });

  routes.get("/net-worth", async (context) => {
    const auth = context.get("auth");
    const report = await reportContext(db, auth.householdId, auth.user.id);
    const accountById = new Map(report.accounts.map((account) => [account.id, account]));
    const assetById = new Map(report.assets.map((asset) => [asset.id, asset]));
    const byDay = new Map<string, Map<string, BalancePoint>>();
    for (const snapshot of report.balanceRows.sort((left, right) =>
      left.asOf.localeCompare(right.asOf),
    )) {
      const day = snapshot.asOf.slice(0, 10);
      const dayAccounts = byDay.get(day) ?? new Map<string, BalancePoint>();
      dayAccounts.set(snapshot.accountId, {
        accountId: snapshot.accountId,
        amount: snapshot.currentBalance,
        available: snapshot.availableBalance,
        currency: snapshot.currency,
        asOf: snapshot.asOf,
      });
      byDay.set(day, dayAccounts);
    }
    const valuationsByDay = new Map<string, Map<string, (typeof report.valuationRows)[number]>>();
    for (const valuation of [...report.valuationRows].sort((left, right) =>
      left.valuedOn.localeCompare(right.valuedOn),
    )) {
      const day = valuation.valuedOn.slice(0, 10);
      const dayAssets = valuationsByDay.get(day) ?? new Map();
      dayAssets.set(valuation.assetId, valuation);
      valuationsByDay.set(day, dayAssets);
    }

    const retirementPattern = /retire|401.?k|403.?b|457|ira|pension/i;
    const groupLabel = (account: (typeof report.accounts)[number]) => {
      if (account.isLiability) {
        return account.group === "credit" ? "Credit cards" : "Loans & debt";
      }
      if (account.group === "cash") return "Cash";
      if (account.group === "investment") {
        return retirementPattern.test(`${account.name} ${account.type} ${account.subtype ?? ""}`)
          ? "Retirement"
          : "Taxable investments";
      }
      if (account.group === "crypto") return "Crypto";
      if (account.group === "property") return "Property";
      if (account.group === "vehicle") return "Vehicles";
      return "Other accounts";
    };
    const assetGroupLabel = (asset: (typeof report.assets)[number]) => {
      if (asset.type === "property") return "Property";
      if (asset.type === "vehicle") return "Vehicles";
      if (asset.type === "collectible") return "Collectibles";
      if (asset.type === "business") return "Business";
      return "Manual assets";
    };
    const summarize = (
      balances: Map<string, BalancePoint>,
      valuations: Map<string, (typeof report.valuationRows)[number]>,
    ) => {
      let total = 0n;
      let liquid = 0n;
      let investable = 0n;
      let retirement = 0n;
      let grossAssets = 0n;
      let debts = 0n;
      const groups = new Map<string, { amount: bigint; kind: "asset" | "debt"; detail: string }>();
      const addGroup = (group: string, amount: bigint, kind: "asset" | "debt", detail: string) => {
        const existing = groups.get(group);
        groups.set(group, {
          amount: (existing?.amount ?? 0n) + amount,
          kind,
          detail,
        });
      };
      for (const [accountId, balance] of balances) {
        const account = accountById.get(accountId);
        if (!account?.includeInNetWorth || balance.currency !== report.currency) continue;
        const signed = signedNetWorthBalance(balance.amount, account.isLiability);
        total += signed;
        const isRetirement =
          account.group === "investment" &&
          retirementPattern.test(`${account.name} ${account.type} ${account.subtype ?? ""}`);
        if (account.isLiability) {
          debts += signed < 0n ? -signed : signed;
          if (account.group === "credit") liquid += signed;
        } else {
          if (signed > 0n) grossAssets += signed;
          if (["investment", "crypto"].includes(account.group)) investable += signed;
          if (isRetirement) retirement += signed;
          if (["cash", "investment", "crypto"].includes(account.group) && !isRetirement) {
            liquid += signed;
          }
        }
        addGroup(
          groupLabel(account),
          signed,
          account.isLiability ? "debt" : "asset",
          account.isLiability ? "Synced liability accounts" : "Synced financial accounts",
        );
      }
      for (const [assetId, valuation] of valuations) {
        const asset = assetById.get(assetId);
        if (!asset || valuation.currency !== report.currency) continue;
        total += valuation.amount;
        grossAssets += valuation.amount;
        if (asset.liquidityClass === "liquid") liquid += valuation.amount;
        addGroup(
          assetGroupLabel(asset),
          valuation.amount,
          "asset",
          `${asset.liquidityClass} · manually/provider valued`,
        );
      }
      return { total, liquid, investable, retirement, assets: grossAssets, debts, groups };
    };

    const running = new Map<string, BalancePoint>();
    const runningValuations = new Map<string, (typeof report.valuationRows)[number]>();
    const allDays = [...new Set([...byDay.keys(), ...valuationsByDay.keys()])].sort();
    const completeSeries = allDays.map((day) => {
      const dayAccounts = byDay.get(day) ?? new Map<string, BalancePoint>();
      for (const [accountId, balance] of dayAccounts) running.set(accountId, balance);
      for (const [assetId, valuation] of valuationsByDay.get(day) ?? []) {
        runningValuations.set(assetId, valuation);
      }
      const summary = summarize(running, runningValuations);
      return {
        date: day,
        total: money(summary.total, report.currency),
        liquid: money(summary.liquid, report.currency),
        investable: money(summary.investable, report.currency),
        retirement: money(summary.retirement, report.currency),
        assets: money(summary.assets, report.currency),
        debts: money(summary.debts, report.currency),
        groups: summary.groups,
      };
    });

    const range = context.req.query("range") ?? "1Y";
    const rangeDays = range === "1M" ? 31 : range === "3M" ? 93 : range === "1Y" ? 366 : undefined;
    const cutoff = rangeDays
      ? new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 10)
      : undefined;
    const ranged = cutoff ? completeSeries.filter((point) => point.date >= cutoff) : completeSeries;
    const displayed = ranged.length > 0 ? ranged : completeSeries.slice(-1);

    const latestValuations = new Map<string, (typeof report.valuationRows)[number]>();
    for (const valuation of report.valuationRows) {
      if (!latestValuations.has(valuation.assetId))
        latestValuations.set(valuation.assetId, valuation);
    }
    const current = summarize(report.latest, latestValuations);
    const baselineGroups = displayed[0]?.groups ?? new Map();
    const composition = [...current.groups.entries()]
      .filter(([, value]) => value.amount !== 0n)
      .sort((left, right) => {
        const leftAbs = left[1].amount < 0n ? -left[1].amount : left[1].amount;
        const rightAbs = right[1].amount < 0n ? -right[1].amount : right[1].amount;
        return leftAbs === rightAbs ? 0 : leftAbs > rightAbs ? -1 : 1;
      })
      .map(([group, value]) => {
        const baseline = baselineGroups.get(group)?.amount ?? 0n;
        const currentAbs = value.amount < 0n ? -value.amount : value.amount;
        const baselineAbs = baseline < 0n ? -baseline : baseline;
        const changePercent =
          baselineAbs === 0n
            ? 0
            : value.kind === "debt"
              ? Number(((baselineAbs - currentAbs) * 10_000n) / baselineAbs) / 100
              : Number(((currentAbs - baselineAbs) * 10_000n) / baselineAbs) / 100;
        return {
          group,
          amount: money(value.amount, report.currency),
          changePercent: Math.max(-999, Math.min(999, changePercent)),
          kind: value.kind,
          detail: value.detail,
        };
      });
    return context.json({
      total: money(current.total, report.currency),
      liquid: money(current.liquid, report.currency),
      investable: money(current.investable, report.currency),
      retirement: money(current.retirement, report.currency),
      assets: money(current.assets, report.currency),
      debts: money(current.debts, report.currency),
      series: displayed.map(({ groups: _groups, ...point }) => point),
      composition,
    });
  });

  routes.get("/cash-flow", async (context) => {
    const auth = context.get("auth");
    const report = await reportContext(db, auth.householdId, auth.user.id);
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 11, 1);
    const rows = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          eq(transactions.status, "posted"),
          gte(transactions.transactedOn, since.toISOString()),
        ),
      )
      .orderBy(asc(transactions.transactedOn));
    const months = new Map<string, { income: bigint; expenses: bigint }>();
    for (const transaction of rows) {
      if (
        transaction.isExcluded ||
        transaction.isTransfer ||
        transaction.currency !== report.currency
      )
        continue;
      const key = transaction.transactedOn.slice(0, 7);
      const value = months.get(key) ?? { income: 0n, expenses: 0n };
      if (transaction.amount > 0n) {
        if (transaction.isIncome) value.income += transaction.amount;
        else value.expenses -= transaction.amount;
      } else {
        value.expenses += -transaction.amount;
      }
      months.set(key, value);
    }
    return context.json({
      months: [...months.entries()].map(([month, value]) => ({
        month,
        income: money(value.income, report.currency),
        expenses: money(value.expenses > 0n ? value.expenses : 0n, report.currency),
        surplus: money(value.income - (value.expenses > 0n ? value.expenses : 0n), report.currency),
      })),
    });
  });

  routes.get("/spending", async (context) => {
    const auth = context.get("auth");
    const report = await reportContext(db, auth.householdId, auth.user.id);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const rows = await db
      .select({
        id: transactions.id,
        amount: transactions.amount,
        currency: transactions.currency,
        isIncome: transactions.isIncome,
        category: categories.name,
      })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(
        and(
          eq(transactions.householdId, auth.householdId),
          eq(transactions.status, "posted"),
          eq(transactions.isExcluded, false),
          eq(transactions.isTransfer, false),
          gte(transactions.transactedOn, monthStart.toISOString()),
        ),
      );
    const transactionIds = rows.map(({ id }) => id);
    const splitRows = transactionIds.length
      ? await db
          .select({
            transactionId: transactionSplits.transactionId,
            amount: transactionSplits.amount,
            category: categories.name,
          })
          .from(transactionSplits)
          .leftJoin(categories, eq(categories.id, transactionSplits.categoryId))
          .where(
            and(
              eq(transactionSplits.householdId, auth.householdId),
              inArray(transactionSplits.transactionId, transactionIds),
            ),
          )
      : [];
    const totals = new Map<string, bigint>();
    const splitTransactionIds = new Set(splitRows.map(({ transactionId }) => transactionId));
    const addActivity = (categoryName: string | null, amount: bigint, isIncome: boolean) => {
      if (amount > 0n && isIncome) return;
      const category = categoryName ?? "Uncategorized";
      totals.set(category, (totals.get(category) ?? 0n) - amount);
    };
    for (const row of rows) {
      if (row.currency !== report.currency || splitTransactionIds.has(row.id)) continue;
      addActivity(row.category, row.amount, row.isIncome);
    }
    const transactionById = new Map(rows.map((row) => [row.id, row]));
    for (const split of splitRows) {
      const parent = transactionById.get(split.transactionId);
      if (parent?.currency !== report.currency) continue;
      addActivity(split.category, split.amount, parent.isIncome);
    }
    return context.json({
      categories: [...totals.entries()]
        .filter(([, amount]) => amount > 0n)
        .sort((left, right) => (left[1] === right[1] ? 0 : left[1] > right[1] ? -1 : 1))
        .map(([category, amount]) => ({ category, amount: money(amount, report.currency) })),
    });
  });

  return routes;
}
