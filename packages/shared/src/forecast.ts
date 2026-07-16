import { addMonths, monthsBetween, type YearMonth, YearMonthSchema } from "./goals.ts";
import {
  type CurrencyCode,
  CurrencyCodeSchema,
  checkedInt64,
  divideAndRound,
  type Money,
  type MoneyJson,
  money,
  moneyToJson,
} from "./money.ts";

export const FORECAST_ENGINE_VERSION = "1.0.0";
export const MAX_FORECAST_MONTHS = 1_200;
export const MAX_MONTE_CARLO_RUNS = 10_000;

export type ForecastAccountType = "checking" | "savings" | "investment" | "retirement" | "asset";

export interface ForecastAccount {
  readonly id: string;
  readonly name?: string;
  readonly type: ForecastAccountType;
  readonly balance: Money;
  readonly liquid: boolean;
  readonly annualReturnBps?: number;
  readonly assetClass?: string;
}

export interface ForecastCashFlow {
  readonly id: string;
  readonly name?: string;
  readonly kind: "income" | "bill" | "envelope";
  /** Amounts are positive; kind determines whether cash is added or removed. */
  readonly amount: Money;
  readonly accountId?: string;
  readonly startMonth?: YearMonth | string;
  readonly endMonth?: YearMonth | string;
  readonly annualGrowthBps?: number;
  readonly required?: boolean;
}

export interface ForecastDebt {
  readonly id: string;
  readonly name?: string;
  /** Principal is represented as a positive amount. */
  readonly principal: Money;
  readonly annualInterestBps: number;
  readonly minimumPayment: Money;
  readonly extraPayment?: Money;
  readonly paymentAccountId?: string;
}

export interface ForecastContribution {
  readonly id: string;
  readonly name?: string;
  readonly kind: "goal" | "investment";
  readonly amount: Money;
  readonly fromAccountId?: string;
  readonly toAccountId: string;
  readonly priority: number;
  readonly required?: boolean;
  readonly startMonth?: YearMonth | string;
  readonly endMonth?: YearMonth | string;
  readonly targetAmount?: Money;
}

export interface ForecastScenario {
  readonly id?: string;
  readonly name?: string;
  readonly startMonth: YearMonth | string;
  readonly horizonMonths: number;
  readonly baseCurrency: string;
  readonly primaryCashAccountId: string;
  readonly minimumCashBuffer?: Money;
  readonly accounts: readonly ForecastAccount[];
  readonly cashFlows: readonly ForecastCashFlow[];
  readonly debts?: readonly ForecastDebt[];
  readonly contributions?: readonly ForecastContribution[];
}

export interface ForecastDebtPoint {
  readonly id: string;
  readonly principal: Money;
  readonly interest: Money;
  readonly payment: Money;
  readonly paidOff: boolean;
}

export interface ForecastContributionPoint {
  readonly id: string;
  readonly requested: Money;
  readonly contributed: Money;
  readonly shortfall: Money;
}

export interface ForecastMonth {
  readonly index: number;
  readonly month: YearMonth;
  readonly accountBalances: Readonly<Record<string, Money>>;
  readonly debts: readonly ForecastDebtPoint[];
  readonly contributions: readonly ForecastContributionPoint[];
  readonly income: Money;
  readonly requiredOutflows: Money;
  readonly debtPayments: Money;
  readonly goalAndInvestmentContributions: Money;
  readonly unmetRequired: Money;
  readonly liquidCash: Money;
  readonly investableAssets: Money;
  readonly totalAssets: Money;
  readonly totalDebt: Money;
  readonly netWorth: Money;
  readonly primaryCashLow: Money;
}

export interface ForecastResult {
  readonly engineVersion: typeof FORECAST_ENGINE_VERSION;
  readonly inputHash: string;
  readonly baseCurrency: CurrencyCode;
  readonly startMonth: YearMonth;
  readonly horizonMonths: number;
  readonly months: readonly ForecastMonth[];
  readonly series: readonly ForecastMonth[];
  readonly ending: ForecastMonth;
  readonly debtFreeMonth: YearMonth | null;
}

export interface ForecastDebtPointJson {
  readonly id: string;
  readonly principal: MoneyJson;
  readonly interest: MoneyJson;
  readonly payment: MoneyJson;
  readonly paidOff: boolean;
}

export interface ForecastContributionPointJson {
  readonly id: string;
  readonly requested: MoneyJson;
  readonly contributed: MoneyJson;
  readonly shortfall: MoneyJson;
}

export interface ForecastMonthJson {
  readonly index: number;
  readonly month: YearMonth;
  readonly accountBalances: Readonly<Record<string, MoneyJson>>;
  readonly debts: readonly ForecastDebtPointJson[];
  readonly contributions: readonly ForecastContributionPointJson[];
  readonly income: MoneyJson;
  readonly requiredOutflows: MoneyJson;
  readonly debtPayments: MoneyJson;
  readonly goalAndInvestmentContributions: MoneyJson;
  readonly unmetRequired: MoneyJson;
  readonly liquidCash: MoneyJson;
  readonly investableAssets: MoneyJson;
  readonly totalAssets: MoneyJson;
  readonly totalDebt: MoneyJson;
  readonly netWorth: MoneyJson;
  readonly primaryCashLow: MoneyJson;
}

export interface ForecastResultJson {
  readonly engineVersion: typeof FORECAST_ENGINE_VERSION;
  readonly inputHash: string;
  readonly baseCurrency: CurrencyCode;
  readonly startMonth: YearMonth;
  readonly horizonMonths: number;
  readonly months: readonly ForecastMonthJson[];
  readonly debtFreeMonth: YearMonth | null;
}

export function forecastResultToJson(result: ForecastResult): ForecastResultJson {
  return Object.freeze({
    engineVersion: result.engineVersion,
    inputHash: result.inputHash,
    baseCurrency: result.baseCurrency,
    startMonth: result.startMonth,
    horizonMonths: result.horizonMonths,
    months: Object.freeze(
      result.months.map((period) =>
        Object.freeze({
          index: period.index,
          month: period.month,
          accountBalances: Object.freeze(
            Object.fromEntries(
              Object.entries(period.accountBalances).map(([id, balance]) => [
                id,
                moneyToJson(balance),
              ]),
            ),
          ),
          debts: Object.freeze(
            period.debts.map((debt) =>
              Object.freeze({
                id: debt.id,
                principal: moneyToJson(debt.principal),
                interest: moneyToJson(debt.interest),
                payment: moneyToJson(debt.payment),
                paidOff: debt.paidOff,
              }),
            ),
          ),
          contributions: Object.freeze(
            period.contributions.map((contribution) =>
              Object.freeze({
                id: contribution.id,
                requested: moneyToJson(contribution.requested),
                contributed: moneyToJson(contribution.contributed),
                shortfall: moneyToJson(contribution.shortfall),
              }),
            ),
          ),
          income: moneyToJson(period.income),
          requiredOutflows: moneyToJson(period.requiredOutflows),
          debtPayments: moneyToJson(period.debtPayments),
          goalAndInvestmentContributions: moneyToJson(period.goalAndInvestmentContributions),
          unmetRequired: moneyToJson(period.unmetRequired),
          liquidCash: moneyToJson(period.liquidCash),
          investableAssets: moneyToJson(period.investableAssets),
          totalAssets: moneyToJson(period.totalAssets),
          totalDebt: moneyToJson(period.totalDebt),
          netWorth: moneyToJson(period.netWorth),
          primaryCashLow: moneyToJson(period.primaryCashLow),
        }),
      ),
    ),
    debtFreeMonth: result.debtFreeMonth,
  });
}

export const serializeForecastResult = forecastResultToJson;

interface ForecastRunOptions {
  readonly monthlyAnnualizedReturnBps?: (account: ForecastAccount, monthIndex: number) => number;
}

function validateBps(value: number, label: string, minimum = -10_000, maximum = 1_000_000): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum} basis points`);
  }
}

function validatePositiveAmount(reference: CurrencyCode, value: Money, label: string): void {
  if (value.currency !== reference) throw new TypeError(`${label} currency must be ${reference}`);
  if (value.minorUnits < 0n) throw new RangeError(`${label} cannot be negative`);
}

function cashFlowAmount(flow: ForecastCashFlow, monthIndex: number): bigint {
  let amount = flow.amount.minorUnits;
  const annualGrowth = flow.annualGrowthBps ?? 0;
  validateBps(annualGrowth, `Cash flow ${flow.id} growth`);
  for (let year = 0; year < Math.floor(monthIndex / 12); year++) {
    amount = checkedInt64(
      divideAndRound(amount * BigInt(10_000 + annualGrowth), 10_000n, "half-even"),
    );
  }
  return amount;
}

function activeDuring(month: YearMonth, startMonth?: string, endMonth?: string): boolean {
  return (
    (startMonth === undefined || month >= YearMonthSchema.parse(startMonth)) &&
    (endMonth === undefined || month <= YearMonthSchema.parse(endMonth))
  );
}

function canonicalize(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

export function forecastInputHash(input: ForecastScenario): string {
  const text = canonicalize(input);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index++) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function snapshotMonth(input: {
  index: number;
  month: YearMonth;
  currency: CurrencyCode;
  scenario: ForecastScenario;
  accountBalances: ReadonlyMap<string, bigint>;
  debtBalances: ReadonlyMap<string, bigint>;
  debtPoints: readonly ForecastDebtPoint[];
  contributionPoints: readonly ForecastContributionPoint[];
  income: bigint;
  requiredOutflows: bigint;
  debtPayments: bigint;
  contributions: bigint;
  unmetRequired: bigint;
  primaryCashLow: bigint;
}): ForecastMonth {
  const accountBalances = Object.freeze(
    Object.fromEntries(
      input.scenario.accounts.map((account) => [
        account.id,
        money(input.accountBalances.get(account.id)!, input.currency),
      ]),
    ),
  );
  let liquidCash = 0n;
  let investableAssets = 0n;
  let totalAssets = 0n;
  for (const account of input.scenario.accounts) {
    const balance = input.accountBalances.get(account.id)!;
    totalAssets = checkedInt64(totalAssets + balance);
    if (account.liquid) liquidCash = checkedInt64(liquidCash + balance);
    if (account.type === "investment" || account.type === "retirement") {
      investableAssets = checkedInt64(investableAssets + balance);
    }
  }
  const totalDebt = [...input.debtBalances.values()].reduce(
    (sum, principal) => checkedInt64(sum + principal),
    0n,
  );
  const netWorth = checkedInt64(totalAssets - totalDebt);
  return Object.freeze({
    index: input.index,
    month: input.month,
    accountBalances,
    debts: Object.freeze([...input.debtPoints]),
    contributions: Object.freeze([...input.contributionPoints]),
    income: money(input.income, input.currency),
    requiredOutflows: money(input.requiredOutflows, input.currency),
    debtPayments: money(input.debtPayments, input.currency),
    goalAndInvestmentContributions: money(input.contributions, input.currency),
    unmetRequired: money(input.unmetRequired, input.currency),
    liquidCash: money(liquidCash, input.currency),
    investableAssets: money(investableAssets, input.currency),
    totalAssets: money(totalAssets, input.currency),
    totalDebt: money(totalDebt, input.currency),
    netWorth: money(netWorth, input.currency),
    primaryCashLow: money(input.primaryCashLow, input.currency),
  });
}

function validateScenario(scenario: ForecastScenario): {
  currency: CurrencyCode;
  startMonth: YearMonth;
} {
  const currency = CurrencyCodeSchema.parse(scenario.baseCurrency);
  const startMonth = YearMonthSchema.parse(scenario.startMonth);
  if (
    !Number.isSafeInteger(scenario.horizonMonths) ||
    scenario.horizonMonths < 0 ||
    scenario.horizonMonths > MAX_FORECAST_MONTHS
  ) {
    throw new RangeError(`Forecast horizon must be an integer from 0 to ${MAX_FORECAST_MONTHS}`);
  }
  if (scenario.accounts.length === 0)
    throw new RangeError("Forecast requires at least one account");
  const accountIds = new Set<string>();
  for (const account of scenario.accounts) {
    if (!account.id || accountIds.has(account.id))
      throw new TypeError(`Duplicate or empty forecast account id: ${account.id}`);
    accountIds.add(account.id);
    if (account.balance.currency !== currency)
      throw new TypeError(`Account ${account.id} currency must be ${currency}`);
    validateBps(account.annualReturnBps ?? 0, `Account ${account.id} return`);
  }
  if (!accountIds.has(scenario.primaryCashAccountId))
    throw new TypeError("Primary cash account does not exist");
  const accountsById = new Map(scenario.accounts.map((account) => [account.id, account]));
  if (!accountsById.get(scenario.primaryCashAccountId)!.liquid)
    throw new TypeError("Primary cash account must be liquid");
  if (scenario.minimumCashBuffer)
    validatePositiveAmount(currency, scenario.minimumCashBuffer, "Minimum cash buffer");
  const cashFlowIds = new Set<string>();
  for (const flow of scenario.cashFlows) {
    if (!flow.id || cashFlowIds.has(flow.id))
      throw new TypeError(`Duplicate or empty cash-flow id: ${flow.id}`);
    cashFlowIds.add(flow.id);
    validatePositiveAmount(currency, flow.amount, `Cash flow ${flow.id}`);
    if (flow.accountId && !accountIds.has(flow.accountId))
      throw new TypeError(`Cash flow ${flow.id} references an unknown account`);
    if (flow.accountId && !accountsById.get(flow.accountId)!.liquid)
      throw new TypeError(`Cash flow ${flow.id} must use a liquid account`);
    if (flow.startMonth) YearMonthSchema.parse(flow.startMonth);
    if (flow.endMonth) YearMonthSchema.parse(flow.endMonth);
  }
  const debtIds = new Set<string>();
  for (const debt of scenario.debts ?? []) {
    if (!debt.id || debtIds.has(debt.id))
      throw new TypeError(`Duplicate or empty debt id: ${debt.id}`);
    debtIds.add(debt.id);
    validatePositiveAmount(currency, debt.principal, `Debt ${debt.id}`);
    validatePositiveAmount(currency, debt.minimumPayment, `Debt ${debt.id} minimum payment`);
    if (debt.extraPayment)
      validatePositiveAmount(currency, debt.extraPayment, `Debt ${debt.id} extra payment`);
    validateBps(debt.annualInterestBps, `Debt ${debt.id} interest`, 0);
    if (debt.paymentAccountId && !accountIds.has(debt.paymentAccountId))
      throw new TypeError(`Debt ${debt.id} references an unknown payment account`);
    if (debt.paymentAccountId && !accountsById.get(debt.paymentAccountId)!.liquid)
      throw new TypeError(`Debt ${debt.id} payment account must be liquid`);
  }
  const contributionIds = new Set<string>();
  for (const contribution of scenario.contributions ?? []) {
    if (!contribution.id || contributionIds.has(contribution.id))
      throw new TypeError(`Duplicate or empty contribution id: ${contribution.id}`);
    contributionIds.add(contribution.id);
    validatePositiveAmount(currency, contribution.amount, `Contribution ${contribution.id}`);
    if (!accountIds.has(contribution.toAccountId))
      throw new TypeError(`Contribution ${contribution.id} references an unknown target account`);
    if (contribution.fromAccountId && !accountIds.has(contribution.fromAccountId))
      throw new TypeError(`Contribution ${contribution.id} references an unknown source account`);
    const sourceId = contribution.fromAccountId ?? scenario.primaryCashAccountId;
    if (sourceId === contribution.toAccountId)
      throw new TypeError(`Contribution ${contribution.id} source and target must differ`);
    if (!accountsById.get(sourceId)!.liquid)
      throw new TypeError(`Contribution ${contribution.id} source account must be liquid`);
    if (contribution.targetAmount)
      validatePositiveAmount(
        currency,
        contribution.targetAmount,
        `Contribution ${contribution.id} target`,
      );
  }
  return { currency, startMonth };
}

function runForecastInternal(
  scenario: ForecastScenario,
  options: ForecastRunOptions = {},
): ForecastResult {
  const { currency, startMonth } = validateScenario(scenario);
  const accountBalances = new Map(
    scenario.accounts.map((account) => [account.id, account.balance.minorUnits]),
  );
  const debtBalances = new Map(
    (scenario.debts ?? []).map((debt) => [debt.id, debt.principal.minorUnits]),
  );
  const primaryAccountId = scenario.primaryCashAccountId;
  const minimumCashBuffer = scenario.minimumCashBuffer?.minorUnits ?? 0n;
  let primaryCashLow = accountBalances.get(primaryAccountId)!;
  const initialDebts = (scenario.debts ?? []).map((debt) => ({
    id: debt.id,
    principal: debt.principal,
    interest: money(0n, currency),
    payment: money(0n, currency),
    paidOff: debt.principal.minorUnits === 0n,
  }));
  const months: ForecastMonth[] = [
    snapshotMonth({
      index: 0,
      month: startMonth,
      currency,
      scenario,
      accountBalances,
      debtBalances,
      debtPoints: initialDebts,
      contributionPoints: [],
      income: 0n,
      requiredOutflows: 0n,
      debtPayments: 0n,
      contributions: 0n,
      unmetRequired: 0n,
      primaryCashLow,
    }),
  ];
  let debtFreeMonth: YearMonth | null = [...debtBalances.values()].every(
    (balance) => balance === 0n,
  )
    ? startMonth
    : null;

  for (let monthIndex = 1; monthIndex <= scenario.horizonMonths; monthIndex++) {
    const month = addMonths(startMonth, monthIndex);
    let income = 0n;
    let requiredOutflows = 0n;
    let debtPayments = 0n;
    let totalContributions = 0n;
    let unmetRequired = 0n;

    for (const flow of scenario.cashFlows) {
      if (!activeDuring(month, flow.startMonth, flow.endMonth)) continue;
      const amount = cashFlowAmount(flow, monthIndex - 1);
      const accountId = flow.accountId ?? primaryAccountId;
      const before = accountBalances.get(accountId)!;
      if (flow.kind === "income") {
        accountBalances.set(accountId, checkedInt64(before + amount));
        income = checkedInt64(income + amount);
      } else {
        accountBalances.set(accountId, checkedInt64(before - amount));
        requiredOutflows = checkedInt64(requiredOutflows + amount);
      }
      if (accountId === primaryAccountId && accountBalances.get(accountId)! < primaryCashLow) {
        primaryCashLow = accountBalances.get(accountId)!;
      }
    }

    const debtPoints: ForecastDebtPoint[] = [];
    for (const debt of scenario.debts ?? []) {
      let principal = debtBalances.get(debt.id)!;
      if (principal === 0n) {
        debtPoints.push({
          id: debt.id,
          principal: money(0n, currency),
          interest: money(0n, currency),
          payment: money(0n, currency),
          paidOff: true,
        });
        continue;
      }
      const interest = divideAndRound(
        principal * BigInt(debt.annualInterestBps),
        120_000n,
        "half-even",
      );
      principal = checkedInt64(principal + interest);
      const requested = checkedInt64(
        debt.minimumPayment.minorUnits + (debt.extraPayment?.minorUnits ?? 0n),
      );
      const payment = requested < principal ? requested : principal;
      const paymentAccountId = debt.paymentAccountId ?? primaryAccountId;
      accountBalances.set(
        paymentAccountId,
        checkedInt64(accountBalances.get(paymentAccountId)! - payment),
      );
      if (
        paymentAccountId === primaryAccountId &&
        accountBalances.get(paymentAccountId)! < primaryCashLow
      ) {
        primaryCashLow = accountBalances.get(paymentAccountId)!;
      }
      principal -= payment;
      debtBalances.set(debt.id, principal);
      debtPayments = checkedInt64(debtPayments + payment);
      debtPoints.push({
        id: debt.id,
        principal: money(principal, currency),
        interest: money(interest, currency),
        payment: money(payment, currency),
        paidOff: principal === 0n,
      });
    }

    const contributionPoints: ForecastContributionPoint[] = [];
    const contributions = [...(scenario.contributions ?? [])]
      .filter((contribution) => activeDuring(month, contribution.startMonth, contribution.endMonth))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    for (const contribution of contributions) {
      const sourceId = contribution.fromAccountId ?? primaryAccountId;
      const source = accountBalances.get(sourceId)!;
      const target = accountBalances.get(contribution.toAccountId)!;
      let requested = contribution.amount.minorUnits;
      if (contribution.targetAmount) {
        const remaining = contribution.targetAmount.minorUnits - target;
        if (remaining <= 0n) requested = 0n;
        else if (requested > remaining) requested = remaining;
      }
      const available = source > minimumCashBuffer ? source - minimumCashBuffer : 0n;
      const contributed = requested < available ? requested : available;
      const shortfall = requested - contributed;
      accountBalances.set(sourceId, checkedInt64(source - contributed));
      accountBalances.set(contribution.toAccountId, checkedInt64(target + contributed));
      totalContributions = checkedInt64(totalContributions + contributed);
      if (contribution.required) unmetRequired = checkedInt64(unmetRequired + shortfall);
      contributionPoints.push({
        id: contribution.id,
        requested: money(requested, currency),
        contributed: money(contributed, currency),
        shortfall: money(shortfall, currency),
      });
    }

    for (const account of scenario.accounts) {
      const balance = accountBalances.get(account.id)!;
      if (balance <= 0n) continue;
      const annualizedBps =
        options.monthlyAnnualizedReturnBps?.(account, monthIndex) ?? account.annualReturnBps ?? 0;
      validateBps(annualizedBps, `Account ${account.id} return`);
      const growth = divideAndRound(balance * BigInt(annualizedBps), 120_000n, "half-even");
      accountBalances.set(account.id, checkedInt64(balance + growth));
    }
    const primary = accountBalances.get(primaryAccountId)!;
    if (primary < primaryCashLow) primaryCashLow = primary;
    if (debtFreeMonth === null && [...debtBalances.values()].every((balance) => balance === 0n))
      debtFreeMonth = month;
    months.push(
      snapshotMonth({
        index: monthIndex,
        month,
        currency,
        scenario,
        accountBalances,
        debtBalances,
        debtPoints,
        contributionPoints,
        income,
        requiredOutflows,
        debtPayments,
        contributions: totalContributions,
        unmetRequired,
        primaryCashLow,
      }),
    );
  }

  return Object.freeze({
    engineVersion: FORECAST_ENGINE_VERSION,
    inputHash: forecastInputHash(scenario),
    baseCurrency: currency,
    startMonth,
    horizonMonths: scenario.horizonMonths,
    months: Object.freeze(months),
    series: Object.freeze(months),
    ending: months.at(-1)!,
    debtFreeMonth,
  });
}

export function runForecast(scenario: ForecastScenario): ForecastResult {
  return runForecastInternal(scenario);
}

export const deterministicMonthlyForecast = runForecast;

export interface MonteCarloAssetAssumption {
  readonly assetClass: string;
  readonly meanAnnualReturnBps: number;
  readonly annualVolatilityBps: number;
}

export interface MonteCarloInput {
  readonly scenario: ForecastScenario;
  readonly seed: string | number;
  readonly runs?: number;
  readonly assumptions: readonly MonteCarloAssetAssumption[];
  /** Correlation matrix in the same order as assumptions. Omit for independent returns. */
  readonly correlationMatrix?: readonly (readonly number[])[];
  readonly percentiles?: readonly number[];
  readonly successTarget?: Money;
  readonly successMonth?: YearMonth | string;
}

export interface MonteCarloPercentiles {
  readonly p10?: Money;
  readonly p25?: Money;
  readonly p50?: Money;
  readonly p75?: Money;
  readonly p90?: Money;
  readonly [key: `p${number}`]: Money | undefined;
}

export interface MonteCarloMonth {
  readonly month: YearMonth;
  readonly netWorth: MonteCarloPercentiles;
  readonly liquidCash: MonteCarloPercentiles;
}

export interface MonteCarloResult {
  readonly engineVersion: typeof FORECAST_ENGINE_VERSION;
  readonly seed: string;
  readonly runs: number;
  readonly percentiles: readonly number[];
  readonly months: readonly MonteCarloMonth[];
  readonly series: readonly MonteCarloMonth[];
  readonly goalSuccessProbability: number | null;
  readonly goalSuccessBasisPoints: number | null;
}

export interface MonteCarloMonthJson {
  readonly month: YearMonth;
  readonly netWorth: Readonly<Record<string, MoneyJson>>;
  readonly liquidCash: Readonly<Record<string, MoneyJson>>;
}

export interface MonteCarloResultJson {
  readonly engineVersion: typeof FORECAST_ENGINE_VERSION;
  readonly seed: string;
  readonly runs: number;
  readonly percentiles: readonly number[];
  readonly months: readonly MonteCarloMonthJson[];
  readonly goalSuccessProbability: number | null;
  readonly goalSuccessBasisPoints: number | null;
}

function percentileMoneyToJson(values: MonteCarloPercentiles): Readonly<Record<string, MoneyJson>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([percentile, value]) => [percentile, moneyToJson(value)]),
    ),
  );
}

export function monteCarloResultToJson(result: MonteCarloResult): MonteCarloResultJson {
  return Object.freeze({
    engineVersion: result.engineVersion,
    seed: result.seed,
    runs: result.runs,
    percentiles: Object.freeze([...result.percentiles]),
    months: Object.freeze(
      result.months.map((period) =>
        Object.freeze({
          month: period.month,
          netWorth: percentileMoneyToJson(period.netWorth),
          liquidCash: percentileMoneyToJson(period.liquidCash),
        }),
      ),
    ),
    goalSuccessProbability: result.goalSuccessProbability,
    goalSuccessBasisPoints: result.goalSuccessBasisPoints,
  });
}

export const serializeMonteCarloResult = monteCarloResultToJson;

function seedHash(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function makeRandom(seed: string): () => number {
  let state = seedHash(seed) || 0x6d2b79f5;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeNormal(random: () => number): () => number {
  let spare: number | undefined;
  return () => {
    if (spare !== undefined) {
      const result = spare;
      spare = undefined;
      return result;
    }
    const first = Math.max(random(), Number.EPSILON);
    const second = random();
    const magnitude = Math.sqrt(-2 * Math.log(first));
    spare = magnitude * Math.sin(2 * Math.PI * second);
    return magnitude * Math.cos(2 * Math.PI * second);
  };
}

function cholesky(matrix: readonly (readonly number[])[]): number[][] {
  const size = matrix.length;
  if (matrix.some((row) => row.length !== size))
    throw new TypeError("Correlation matrix must be square");
  const result = Array.from({ length: size }, () => Array<number>(size).fill(0));
  for (let row = 0; row < size; row++) {
    for (let column = 0; column <= row; column++) {
      const value = matrix[row]![column]!;
      if (
        !Number.isFinite(value) ||
        value < -1 ||
        value > 1 ||
        Math.abs(value - matrix[column]![row]!) > 1e-10
      ) {
        throw new RangeError(
          "Correlation matrix must be finite, symmetric, and bounded by -1 and 1",
        );
      }
      let sum = value;
      for (let index = 0; index < column; index++)
        sum -= result[row]![index]! * result[column]![index]!;
      if (row === column) {
        if (Math.abs(value - 1) > 1e-10 || sum < -1e-10)
          throw new RangeError(
            "Correlation matrix must be positive semidefinite with ones on the diagonal",
          );
        result[row]![column] = Math.sqrt(Math.max(0, sum));
      } else {
        const divisor = result[column]![column]!;
        if (divisor === 0) {
          if (Math.abs(sum) > 1e-10)
            throw new RangeError("Correlation matrix is not positive semidefinite");
          result[row]![column] = 0;
        } else result[row]![column] = sum / divisor;
      }
    }
  }
  return result;
}

function percentileValue(values: readonly bigint[], percentile: number): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const index = Math.floor(((sorted.length - 1) * percentile) / 100);
  return sorted[index]!;
}

function percentileMap(
  values: readonly bigint[],
  percentiles: readonly number[],
  currency: CurrencyCode,
): MonteCarloPercentiles {
  return Object.freeze(
    Object.fromEntries(
      percentiles.map((percentile) => [
        `p${percentile}`,
        money(percentileValue(values, percentile), currency),
      ]),
    ),
  ) as MonteCarloPercentiles;
}

export function runMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const { currency, startMonth } = validateScenario(input.scenario);
  const runs = input.runs ?? 1_000;
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_MONTE_CARLO_RUNS) {
    throw new RangeError(`Monte Carlo runs must be an integer from 1 to ${MAX_MONTE_CARLO_RUNS}`);
  }
  const percentiles = [...(input.percentiles ?? [10, 25, 50, 75, 90])];
  if (
    percentiles.length === 0 ||
    new Set(percentiles).size !== percentiles.length ||
    percentiles.some((value) => !Number.isInteger(value) || value < 0 || value > 100)
  ) {
    throw new RangeError("Percentiles must be unique integers from 0 to 100");
  }
  percentiles.sort((left, right) => left - right);
  const assumptions = new Map(
    input.assumptions.map((assumption, index) => {
      if (!assumption.assetClass) throw new TypeError("Monte Carlo asset class cannot be empty");
      validateBps(assumption.meanAnnualReturnBps, `${assumption.assetClass} mean return`);
      validateBps(assumption.annualVolatilityBps, `${assumption.assetClass} volatility`, 0);
      return [assumption.assetClass, { ...assumption, index }] as const;
    }),
  );
  if (assumptions.size !== input.assumptions.length)
    throw new TypeError("Monte Carlo asset classes must be unique");
  for (const account of input.scenario.accounts) {
    if (account.assetClass && !assumptions.has(account.assetClass))
      throw new TypeError(`Missing assumption for asset class ${account.assetClass}`);
  }
  const identity = input.assumptions.map((_, row) =>
    input.assumptions.map((__, column) => (row === column ? 1 : 0)),
  );
  const correlation = cholesky(input.correlationMatrix ?? identity);
  const seed = String(input.seed);
  const random = makeRandom(seed);
  const normal = makeNormal(random);
  const netWorthByMonth = Array.from(
    { length: input.scenario.horizonMonths + 1 },
    () => [] as bigint[],
  );
  const liquidByMonth = Array.from(
    { length: input.scenario.horizonMonths + 1 },
    () => [] as bigint[],
  );
  let successes = 0;
  let successIndex = input.scenario.horizonMonths;
  if (input.successMonth) {
    successIndex = monthsBetween(startMonth, YearMonthSchema.parse(input.successMonth));
    if (successIndex < 0 || successIndex > input.scenario.horizonMonths)
      throw new RangeError("Success month is outside the forecast horizon");
  }
  if (input.successTarget && input.successTarget.currency !== currency)
    throw new TypeError("Success target currency mismatch");

  for (let run = 0; run < runs; run++) {
    const sampledByMonth = new Map<number, readonly number[]>();
    const forecast = runForecastInternal(input.scenario, {
      monthlyAnnualizedReturnBps: (account, monthIndex) => {
        if (!account.assetClass) return account.annualReturnBps ?? 0;
        let samples = sampledByMonth.get(monthIndex);
        if (!samples) {
          const independent = input.assumptions.map(() => normal());
          samples = correlation.map((row) =>
            row.reduce((sum, coefficient, index) => sum + coefficient * independent[index]!, 0),
          );
          sampledByMonth.set(monthIndex, samples);
        }
        const assumption = assumptions.get(account.assetClass)!;
        // Sampling an annualized rate with sqrt(12) scaling yields monthly volatility of sigma/sqrt(12).
        const sampled = Math.round(
          assumption.meanAnnualReturnBps +
            samples[assumption.index]! * assumption.annualVolatilityBps * Math.sqrt(12),
        );
        // A single period cannot lose more than the full account balance; cap only impossible/extreme tails.
        return Math.max(-10_000, Math.min(1_000_000, sampled));
      },
    });
    for (let index = 0; index < forecast.months.length; index++) {
      netWorthByMonth[index]!.push(forecast.months[index]!.netWorth.minorUnits);
      liquidByMonth[index]!.push(forecast.months[index]!.liquidCash.minorUnits);
    }
    if (
      input.successTarget &&
      forecast.months[successIndex]!.netWorth.minorUnits >= input.successTarget.minorUnits
    )
      successes++;
  }

  const months = netWorthByMonth.map((netWorth, index) =>
    Object.freeze({
      month: addMonths(startMonth, index),
      netWorth: percentileMap(netWorth, percentiles, currency),
      liquidCash: percentileMap(liquidByMonth[index]!, percentiles, currency),
    }),
  );
  const successBasisPoints = input.successTarget ? Math.round((successes * 10_000) / runs) : null;
  return Object.freeze({
    engineVersion: FORECAST_ENGINE_VERSION,
    seed,
    runs,
    percentiles: Object.freeze(percentiles),
    months: Object.freeze(months),
    series: Object.freeze(months),
    goalSuccessProbability: successBasisPoints === null ? null : successBasisPoints / 10_000,
    goalSuccessBasisPoints: successBasisPoints,
  });
}

export const seededMonteCarlo = runMonteCarlo;
