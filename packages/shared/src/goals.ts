import { z } from "zod";

import {
  assertSameCurrency,
  divideAndRound,
  type Money,
  type MoneyJson,
  money,
  moneyToJson,
} from "./money.ts";

export const YearMonthSchema = z
  .string()
  .regex(/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/, "Expected YYYY-MM");
export type YearMonth = z.infer<typeof YearMonthSchema>;

export function addMonths(yearMonth: string, months: number): YearMonth {
  const parsed = YearMonthSchema.parse(yearMonth);
  if (!Number.isSafeInteger(months)) throw new RangeError("Month offset must be a safe integer");
  const [yearText, monthText] = parsed.split("-") as [string, string];
  const absolute = Number(yearText) * 12 + Number(monthText) - 1 + months;
  if (absolute < 0) throw new RangeError("Projected month is outside the supported range");
  const year = Math.floor(absolute / 12);
  const month = (absolute % 12) + 1;
  return YearMonthSchema.parse(
    `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}`,
  );
}

export function monthsBetween(from: string, to: string): number {
  const start = YearMonthSchema.parse(from).split("-").map(Number);
  const end = YearMonthSchema.parse(to).split("-").map(Number);
  return end[0]! * 12 + end[1]! - (start[0]! * 12 + start[1]!);
}

export interface GoalProjectionInput {
  readonly startMonth: YearMonth | string;
  readonly currentAmount: Money;
  readonly targetAmount: Money;
  readonly monthlyContribution: Money;
  readonly annualYieldBps?: number;
  readonly horizonMonths?: number;
}

export interface GoalProjectionPoint {
  readonly month: YearMonth;
  readonly balance: Money;
  readonly contribution: Money;
  readonly growth: Money;
  readonly reached: boolean;
}

export interface GoalProjection {
  readonly reached: boolean;
  readonly reachedMonth: YearMonth | null;
  readonly projectedDate: YearMonth | null;
  readonly monthsToGoal: number | null;
  readonly targetAmount: Money;
  readonly endingBalance: Money;
  readonly series: readonly GoalProjectionPoint[];
}

export interface GoalProjectionJson {
  readonly reached: boolean;
  readonly reachedMonth: YearMonth | null;
  readonly projectedDate: YearMonth | null;
  readonly monthsToGoal: number | null;
  readonly targetAmount: MoneyJson;
  readonly endingBalance: MoneyJson;
  readonly series: readonly {
    readonly month: YearMonth;
    readonly balance: MoneyJson;
    readonly contribution: MoneyJson;
    readonly growth: MoneyJson;
    readonly reached: boolean;
  }[];
}

export function goalProjectionToJson(projection: GoalProjection): GoalProjectionJson {
  return Object.freeze({
    reached: projection.reached,
    reachedMonth: projection.reachedMonth,
    projectedDate: projection.projectedDate,
    monthsToGoal: projection.monthsToGoal,
    targetAmount: moneyToJson(projection.targetAmount),
    endingBalance: moneyToJson(projection.endingBalance),
    series: Object.freeze(
      projection.series.map((point) =>
        Object.freeze({
          month: point.month,
          balance: moneyToJson(point.balance),
          contribution: moneyToJson(point.contribution),
          growth: moneyToJson(point.growth),
          reached: point.reached,
        }),
      ),
    ),
  });
}

export const serializeGoalProjection = goalProjectionToJson;

function validateAnnualBps(value: number): void {
  if (!Number.isSafeInteger(value) || value < -10_000 || value > 1_000_000) {
    throw new RangeError(
      "Annual yield must be an integer basis-point value between -10,000 and 1,000,000",
    );
  }
}

function monthlyGrowth(balance: bigint, annualBps: number): bigint {
  return divideAndRound(balance * BigInt(annualBps), 120_000n, "half-even");
}

export function projectGoal(input: GoalProjectionInput): GoalProjection {
  const startMonth = YearMonthSchema.parse(input.startMonth);
  assertSameCurrency(input.currentAmount, input.targetAmount);
  assertSameCurrency(input.currentAmount, input.monthlyContribution);
  if (input.currentAmount.minorUnits < 0n || input.targetAmount.minorUnits < 0n) {
    throw new RangeError("Goal balances and targets cannot be negative");
  }
  if (input.monthlyContribution.minorUnits < 0n)
    throw new RangeError("Goal contribution cannot be negative");
  const annualYieldBps = input.annualYieldBps ?? 0;
  validateAnnualBps(annualYieldBps);
  const horizonMonths = input.horizonMonths ?? 1_200;
  if (!Number.isSafeInteger(horizonMonths) || horizonMonths < 0 || horizonMonths > 1_200) {
    throw new RangeError("Goal horizon must be an integer from 0 to 1,200 months");
  }

  const currency = input.currentAmount.currency;
  const initialReached = input.currentAmount.minorUnits >= input.targetAmount.minorUnits;
  const series: GoalProjectionPoint[] = [
    {
      month: startMonth,
      balance: input.currentAmount,
      contribution: money(0n, currency),
      growth: money(0n, currency),
      reached: initialReached,
    },
  ];
  if (initialReached) {
    return Object.freeze({
      reached: true,
      reachedMonth: startMonth,
      projectedDate: startMonth,
      monthsToGoal: 0,
      targetAmount: input.targetAmount,
      endingBalance: input.currentAmount,
      series: Object.freeze(series),
    });
  }

  let balance = input.currentAmount.minorUnits;
  let reachedMonth: YearMonth | null = null;
  let monthsToGoal: number | null = null;
  for (let index = 1; index <= horizonMonths; index++) {
    const contribution = input.monthlyContribution.minorUnits;
    balance += contribution;
    const growth = monthlyGrowth(balance, annualYieldBps);
    balance += growth;
    const reached = balance >= input.targetAmount.minorUnits;
    const month = addMonths(startMonth, index);
    series.push({
      month,
      balance: money(balance, currency),
      contribution: money(contribution, currency),
      growth: money(growth, currency),
      reached,
    });
    if (reached) {
      reachedMonth = month;
      monthsToGoal = index;
      break;
    }
    if (balance < 0n) balance = 0n;
  }
  const endingBalance = series.at(-1)!.balance;
  return Object.freeze({
    reached: reachedMonth !== null,
    reachedMonth,
    projectedDate: reachedMonth,
    monthsToGoal,
    targetAmount: input.targetAmount,
    endingBalance,
    series: Object.freeze(series),
  });
}

export type PurchaseConstraint =
  | "purchaseFunding"
  | "emergencyFloor"
  | "requiredObligations"
  | "checkingBuffer"
  | "higherPriorityGoals"
  | "targetNetWorth"
  | "horizon";

export interface HigherPriorityGoalPolicy {
  readonly id: string;
  readonly currentAmount: Money;
  readonly targetAmount: Money;
  readonly monthlyContribution: Money;
  readonly targetMonth?: YearMonth | string;
  /** When true, verified progress is also part of the protected emergency reserve. */
  readonly countsTowardEmergencyReserve?: boolean;
}

export interface ComfortablePurchaseDateInput {
  readonly startMonth: YearMonth | string;
  readonly purchasePrice: Money;
  readonly currentPurchaseSavings: Money;
  readonly monthlyPurchaseContribution: Money;
  readonly emergencyReserve: Money;
  readonly emergencyFloor: Money;
  readonly checkingBalance: Money;
  readonly checkingBuffer: Money;
  /** Cash change after required bills, debt minimums, and higher-priority contributions. */
  readonly monthlyCheckingChange: Money;
  /**
   * Cash generated after spending and required bills, but before goal transfers. When present,
   * purchase and higher-priority contributions are modeled as capped transfers that stop at each
   * target. `monthlyCheckingChange` remains the backward-compatible constant-change fallback.
   */
  readonly monthlyCashSurplusBeforeGoalContributions?: Money;
  /** A positive value means known bills/minimum debt are not fully funded. */
  readonly requiredObligationShortfall?: Money;
  readonly lookAheadMonths?: number;
  readonly horizonMonths?: number;
  readonly higherPriorityGoals?: readonly HigherPriorityGoalPolicy[];
  readonly currentNetWorth?: Money;
  readonly targetNetWorth?: Money;
  readonly monthlyNetWorthChange?: Money;
  readonly netWorthTolerance?: Money;
  /** Fixed wealth milestone month; candidate dates after it are evaluated at the candidate month. */
  readonly targetNetWorthMonth?: YearMonth | string;
  /** Conservative value permanently removed from projected net worth when the purchase occurs. */
  readonly purchaseNetWorthImpact?: Money;
}

export interface PurchaseConstraintState {
  readonly month: YearMonth;
  readonly purchaseSavings: Money;
  readonly projectedCheckingLow: Money;
  readonly projectedEmergencyReserve: Money;
  readonly projectedTargetNetWorth?: Money;
  readonly constraints: Readonly<Record<Exclude<PurchaseConstraint, "horizon">, boolean>>;
}

export interface ComfortablePurchaseDateResult {
  readonly comfortable: boolean;
  readonly date: YearMonth | null;
  readonly comfortableMonth: YearMonth | null;
  readonly monthsUntilPurchase: number | null;
  readonly controllingConstraint: PurchaseConstraint;
  /** Constraints that set the date, or remain unsatisfied at the planning horizon. */
  readonly limitingConstraints: readonly PurchaseConstraint[];
  readonly finalState: PurchaseConstraintState;
  readonly timeline: readonly PurchaseConstraintState[];
}

export interface ComfortablePurchaseDateJson {
  readonly comfortable: boolean;
  readonly date: YearMonth | null;
  readonly comfortableMonth: YearMonth | null;
  readonly monthsUntilPurchase: number | null;
  readonly controllingConstraint: PurchaseConstraint;
  readonly limitingConstraints: readonly PurchaseConstraint[];
  readonly finalState: PurchaseConstraintStateJson;
  readonly timeline: readonly PurchaseConstraintStateJson[];
}

export interface PurchaseConstraintStateJson {
  readonly month: YearMonth;
  readonly purchaseSavings: MoneyJson;
  readonly projectedCheckingLow: MoneyJson;
  readonly projectedEmergencyReserve: MoneyJson;
  readonly projectedTargetNetWorth?: MoneyJson;
  readonly constraints: Readonly<Record<Exclude<PurchaseConstraint, "horizon">, boolean>>;
}

export function comfortablePurchaseDateToJson(
  result: ComfortablePurchaseDateResult,
): ComfortablePurchaseDateJson {
  const serializeState = (state: PurchaseConstraintState): PurchaseConstraintStateJson =>
    Object.freeze({
      month: state.month,
      purchaseSavings: moneyToJson(state.purchaseSavings),
      projectedCheckingLow: moneyToJson(state.projectedCheckingLow),
      projectedEmergencyReserve: moneyToJson(state.projectedEmergencyReserve),
      ...(state.projectedTargetNetWorth
        ? { projectedTargetNetWorth: moneyToJson(state.projectedTargetNetWorth) }
        : {}),
      constraints: state.constraints,
    });
  return Object.freeze({
    comfortable: result.comfortable,
    date: result.date,
    comfortableMonth: result.comfortableMonth,
    monthsUntilPurchase: result.monthsUntilPurchase,
    controllingConstraint: result.controllingConstraint,
    limitingConstraints: result.limitingConstraints,
    finalState: serializeState(result.finalState),
    timeline: Object.freeze(result.timeline.map(serializeState)),
  });
}

export const serializeComfortablePurchaseDate = comfortablePurchaseDateToJson;

function assertCurrencies(reference: Money, values: readonly (Money | undefined)[]): void {
  for (const value of values) if (value) assertSameCurrency(reference, value);
}

export function comfortablePurchaseDate(
  input: ComfortablePurchaseDateInput,
): ComfortablePurchaseDateResult {
  const startMonth = YearMonthSchema.parse(input.startMonth);
  const reference = input.purchasePrice;
  assertCurrencies(reference, [
    input.currentPurchaseSavings,
    input.monthlyPurchaseContribution,
    input.emergencyReserve,
    input.emergencyFloor,
    input.checkingBalance,
    input.checkingBuffer,
    input.monthlyCheckingChange,
    input.monthlyCashSurplusBeforeGoalContributions,
    input.requiredObligationShortfall,
    input.currentNetWorth,
    input.targetNetWorth,
    input.monthlyNetWorthChange,
    input.netWorthTolerance,
    input.purchaseNetWorthImpact,
  ]);
  for (const goal of input.higherPriorityGoals ?? []) {
    assertCurrencies(reference, [goal.currentAmount, goal.targetAmount, goal.monthlyContribution]);
  }
  const nonnegative = [
    reference,
    input.currentPurchaseSavings,
    input.monthlyPurchaseContribution,
    input.emergencyReserve,
    input.emergencyFloor,
    input.checkingBuffer,
    ...(input.purchaseNetWorthImpact ? [input.purchaseNetWorthImpact] : []),
  ];
  if (nonnegative.some((value) => value.minorUnits < 0n))
    throw new RangeError("Purchase planning amounts cannot be negative");
  const horizon = input.horizonMonths ?? 1_200;
  const lookAhead = input.lookAheadMonths ?? 3;
  if (!Number.isSafeInteger(horizon) || horizon < 0 || horizon > 1_200)
    throw new RangeError("Purchase horizon must be 0-1,200 months");
  if (!Number.isSafeInteger(lookAhead) || lookAhead < 0 || lookAhead > 120)
    throw new RangeError("Look-ahead must be 0-120 months");

  const currency = reference.currency;
  const shortfall = input.requiredObligationShortfall?.minorUnits ?? 0n;
  if (shortfall < 0n) throw new RangeError("Required obligation shortfall cannot be negative");
  const timeline: PurchaseConstraintState[] = [];
  let lastConstraint: PurchaseConstraint = "purchaseFunding";
  let lastFailures: PurchaseConstraint[] = ["purchaseFunding"];

  const cappedProgress = (
    current: bigint,
    target: bigint,
    monthlyContribution: bigint,
    elapsedMonths: number,
  ) => {
    if (target <= current || monthlyContribution <= 0n || elapsedMonths <= 0) return 0n;
    const remaining = target - current;
    const contributed = monthlyContribution * BigInt(elapsedMonths);
    return contributed < remaining ? contributed : remaining;
  };

  const projectedGoalProgress = (index: number) =>
    (input.higherPriorityGoals ?? []).map((goal) => ({
      goal,
      progress: cappedProgress(
        goal.currentAmount.minorUnits,
        goal.targetAmount.minorUnits,
        goal.monthlyContribution.minorUnits,
        index,
      ),
    }));

  const projectedChecking = (index: number) => {
    if (!input.monthlyCashSurplusBeforeGoalContributions) {
      return (
        input.checkingBalance.minorUnits + input.monthlyCheckingChange.minorUnits * BigInt(index)
      );
    }
    const purchaseProgress = cappedProgress(
      input.currentPurchaseSavings.minorUnits,
      reference.minorUnits,
      input.monthlyPurchaseContribution.minorUnits,
      index,
    );
    const higherPriorityProgress = projectedGoalProgress(index).reduce(
      (total, item) => total + item.progress,
      0n,
    );
    return (
      input.checkingBalance.minorUnits +
      input.monthlyCashSurplusBeforeGoalContributions.minorUnits * BigInt(index) -
      purchaseProgress -
      higherPriorityProgress
    );
  };

  for (let index = 0; index <= horizon; index++) {
    const month = addMonths(startMonth, index);
    const purchaseSavings =
      input.currentPurchaseSavings.minorUnits +
      (input.monthlyCashSurplusBeforeGoalContributions
        ? cappedProgress(
            input.currentPurchaseSavings.minorUnits,
            reference.minorUnits,
            input.monthlyPurchaseContribution.minorUnits,
            index,
          )
        : input.monthlyPurchaseContribution.minorUnits * BigInt(index));
    const checking = projectedChecking(index);
    let checkingLow = checking;
    for (let offset = 1; offset <= lookAhead; offset++) {
      const projected = projectedChecking(index + offset);
      if (projected < checkingLow) checkingLow = projected;
    }

    const goalProgress = projectedGoalProgress(index);
    const goalsOnPolicy = goalProgress.every(({ goal, progress }) => {
      const projected = goal.currentAmount.minorUnits + progress;
      if (
        goal.currentAmount.minorUnits < goal.targetAmount.minorUnits &&
        goal.monthlyContribution.minorUnits <= 0n
      ) {
        return false;
      }
      if (!goal.targetMonth) return projected >= goal.currentAmount.minorUnits;
      const deadlineDistance = monthsBetween(startMonth, YearMonthSchema.parse(goal.targetMonth));
      if (deadlineDistance <= 0) return projected >= goal.targetAmount.minorUnits;
      const elapsed = BigInt(Math.min(index, deadlineDistance));
      const requiredProgress =
        goal.currentAmount.minorUnits +
        ((goal.targetAmount.minorUnits - goal.currentAmount.minorUnits) * elapsed) /
          BigInt(deadlineDistance);
      return projected >= requiredProgress;
    });
    const projectedEmergencyReserve =
      input.emergencyReserve.minorUnits +
      goalProgress.reduce(
        (total, item) => (item.goal.countsTowardEmergencyReserve ? total + item.progress : total),
        0n,
      );

    let netWorthOk = true;
    let projectedTargetNetWorth: bigint | undefined;
    if (input.currentNetWorth && input.targetNetWorth && input.monthlyNetWorthChange) {
      const tolerance = input.netWorthTolerance?.minorUnits ?? 0n;
      const targetNetWorthMonth = input.targetNetWorthMonth;
      const hasFixedMilestone = targetNetWorthMonth !== undefined;
      const targetDistance = hasFixedMilestone
        ? Math.max(0, monthsBetween(startMonth, YearMonthSchema.parse(targetNetWorthMonth)))
        : index;
      const purchaseImpact =
        !hasFixedMilestone || index <= targetDistance
          ? (input.purchaseNetWorthImpact?.minorUnits ?? 0n)
          : 0n;
      projectedTargetNetWorth =
        input.currentNetWorth.minorUnits +
        input.monthlyNetWorthChange.minorUnits * BigInt(targetDistance) -
        purchaseImpact;
      netWorthOk = projectedTargetNetWorth + tolerance >= input.targetNetWorth.minorUnits;
    }
    const constraints = Object.freeze({
      purchaseFunding: purchaseSavings >= reference.minorUnits,
      emergencyFloor: projectedEmergencyReserve >= input.emergencyFloor.minorUnits,
      requiredObligations: shortfall === 0n,
      checkingBuffer: checkingLow >= input.checkingBuffer.minorUnits,
      higherPriorityGoals: goalsOnPolicy,
      targetNetWorth: netWorthOk,
    });
    const state: PurchaseConstraintState = Object.freeze({
      month,
      purchaseSavings: money(purchaseSavings, currency),
      projectedCheckingLow: money(checkingLow, currency),
      projectedEmergencyReserve: money(projectedEmergencyReserve, currency),
      ...(projectedTargetNetWorth === undefined
        ? {}
        : { projectedTargetNetWorth: money(projectedTargetNetWorth, currency) }),
      constraints,
    });
    timeline.push(state);

    const failure = (
      Object.entries(constraints) as [Exclude<PurchaseConstraint, "horizon">, boolean][]
    ).find(([, satisfied]) => !satisfied)?.[0];
    if (!failure) {
      return Object.freeze({
        comfortable: true,
        date: month,
        comfortableMonth: month,
        monthsUntilPurchase: index,
        controllingConstraint: lastConstraint,
        limitingConstraints: Object.freeze(index === 0 ? [] : lastFailures),
        finalState: state,
        timeline: Object.freeze(timeline),
      });
    }
    lastConstraint = failure;
    lastFailures = (
      Object.entries(constraints) as [Exclude<PurchaseConstraint, "horizon">, boolean][]
    )
      .filter(([, satisfied]) => !satisfied)
      .map(([constraint]) => constraint);
  }

  const finalState = timeline.at(-1);
  if (!finalState) throw new Error("Purchase projection did not produce an initial state");
  const horizonFailures = (
    Object.entries(finalState.constraints) as [Exclude<PurchaseConstraint, "horizon">, boolean][]
  )
    .filter(([, satisfied]) => !satisfied)
    .map(([constraint]) => constraint);
  return Object.freeze({
    comfortable: false,
    date: null,
    comfortableMonth: null,
    monthsUntilPurchase: null,
    controllingConstraint: "horizon",
    limitingConstraints: Object.freeze([...horizonFailures, "horizon" as const]),
    finalState,
    timeline: Object.freeze(timeline),
  });
}

export const calculateComfortablePurchaseDate = comfortablePurchaseDate;
