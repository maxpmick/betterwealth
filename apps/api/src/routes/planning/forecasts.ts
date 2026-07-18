import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  accounts,
  assets,
  assetValuations,
  balanceSnapshots,
  bills,
  categories,
  envelopes,
  forecastRuns,
  forecastScenarios,
  goals,
  incomeSources,
  users,
} from "@betterwealth/db/schema";
import {
  type ForecastScenario,
  ForecastScenarioSchema,
  forecastResultToJson,
  MoneyJsonSchema,
  moneyFromJson,
  monteCarloResultToJson,
  runForecast,
  runMonteCarlo,
} from "@betterwealth/shared";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import { requireCsrf } from "../../auth/middleware";
import type { AppConfig } from "../../config";
import { AppError, NotFoundError } from "../../lib/errors";
import { listPageParams, paginateList } from "../../lib/pagination";
import type { AppEnv } from "../../types";
import {
  averageMonthlyAmount,
  cadenceFromDueRule,
  cadencePeriodsPerYear,
  dbJson,
  goalMonthlyAmount,
  loadPlanningForecastDefaults,
  type MoneyJson,
  minorUnitsSchema,
  moneyJson,
  normalizedCadence,
  nowIso,
  page,
  startOfCurrentMonth,
} from "./shared";

const envelopeCadenceConfigSchema = z
  .object({
    monthlyAmountMinorUnits: minorUnitsSchema.refine((value) => BigInt(value) >= 0n).optional(),
    paychecksPerYear: z.number().int().min(1).max(366).optional(),
  })
  .passthrough();

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
  horizonMonths: number,
  now: Date,
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
        const scheduledMonth = bill.nextDueDate?.slice(0, 7) ?? startOfCurrentMonth(now);
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
    startMonth: startOfCurrentMonth(now),
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

export function createForecastRoutes(db: BetterWealthDatabase, config: AppConfig, now: () => Date) {
  const routes = new Hono<AppEnv>();

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
      input.horizonMonths ?? (await defaultForecastHorizonMonths(db, auth.user.id, now()));
    const scenario = await buildLedgerForecastScenario(
      db,
      auth.householdId,
      input.name,
      input.assumptions,
      horizonMonths,
      now(),
    );
    const id = ulid();
    db.transaction((transaction) => {
      if (input.isBase) {
        transaction
          .update(forecastScenarios)
          .set({ isBase: false, updatedAt: nowIso() })
          .where(eq(forecastScenarios.householdId, auth.householdId))
          .run();
      }
      transaction
        .insert(forecastScenarios)
        .values({
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
        })
        .run();
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
      now(),
    );
    db.transaction((transaction) => {
      if (input.isBase) {
        transaction
          .update(forecastScenarios)
          .set({ isBase: false, updatedAt: nowIso() })
          .where(eq(forecastScenarios.householdId, auth.householdId))
          .run();
      }
      transaction
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
        )
        .run();
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

  routes.get("/forecasts", async (context) => {
    const auth = context.get("auth");
    const { limit, cursor } = listPageParams(context.req, 100);
    const conditions = [eq(forecastRuns.householdId, auth.householdId)];
    if (cursor) {
      const cursorCondition = or(
        lt(forecastRuns.createdAt, cursor.sortKey),
        and(eq(forecastRuns.createdAt, cursor.sortKey), lt(forecastRuns.id, cursor.id)),
      );
      if (cursorCondition) conditions.push(cursorCondition);
    }
    const fetched = await db
      .select()
      .from(forecastRuns)
      .where(and(...conditions))
      .orderBy(desc(forecastRuns.createdAt), desc(forecastRuns.id))
      .limit(limit + 1);
    const { rows, page: pageInfo } = paginateList(fetched, limit, (row) => ({
      sortKey: row.createdAt,
      id: row.id,
    }));
    return context.json({ data: rows.map(forecastRunDto), page: pageInfo });
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

  return routes;
}
