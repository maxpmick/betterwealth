export type GoalPaceMoney = Readonly<{ minorUnits: bigint; currency: string }>;

export interface GoalPaceInput {
  readonly startMonth: string;
  readonly currentAmount: GoalPaceMoney;
  readonly targetAmount: GoalPaceMoney;
  readonly monthlyContribution: GoalPaceMoney;
  readonly targetMonth?: string | null;
}

export interface GoalPace {
  readonly remainingAmount: GoalPaceMoney;
  readonly monthsToGoal: number | null;
  readonly projectedMonth: string | null;
  readonly monthsUntilTarget: number | null;
  readonly requiredMonthlyContribution: GoalPaceMoney | null;
  readonly monthlyShortfall: GoalPaceMoney;
  readonly onTrack: boolean | null;
  readonly paceRatio: number | null;
}

function divideUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Goal pace denominator must be positive");
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function parseMonth(value: string): [number, number] {
  const match = /^(19|20|21)(\d{2})-(0[1-9]|1[0-2])$/.exec(value);
  if (!match) throw new RangeError("Goal month must use YYYY-MM");
  return [Number(`${match[1]}${match[2]}`), Number(match[3])];
}

function addGoalMonths(value: string, months: number): string {
  const [year, month] = parseMonth(value);
  if (!Number.isSafeInteger(months)) throw new RangeError("Month offset must be a safe integer");
  const absolute = year * 12 + month - 1 + months;
  if (absolute < 0) throw new RangeError("Projected month is outside the supported range");
  return `${Math.floor(absolute / 12)
    .toString()
    .padStart(4, "0")}-${((absolute % 12) + 1).toString().padStart(2, "0")}`;
}

function goalMonthsBetween(from: string, to: string): number {
  const [startYear, startMonth] = parseMonth(from);
  const [endYear, endMonth] = parseMonth(to);
  return endYear * 12 + endMonth - (startYear * 12 + startMonth);
}

function paceMoney(minorUnits: bigint, currency: string): GoalPaceMoney {
  return Object.freeze({ minorUnits, currency });
}

/**
 * Derives an explainable goal date and target-date pace using integer minor units only.
 * Contributions are assumed to post once per month after `startMonth`, matching projectGoal.
 */
export function deriveGoalPace(input: GoalPaceInput): GoalPace {
  parseMonth(input.startMonth);
  if (
    input.currentAmount.currency !== input.targetAmount.currency ||
    input.currentAmount.currency !== input.monthlyContribution.currency
  ) {
    throw new RangeError("Goal currencies must match");
  }
  const { currency } = input.currentAmount;
  const current = input.currentAmount.minorUnits;
  const target = input.targetAmount.minorUnits;
  const monthly = input.monthlyContribution.minorUnits;
  if (current < 0n || target <= 0n || monthly < 0n) {
    throw new RangeError("Goal amounts must have a positive target and non-negative funding");
  }

  const remaining = target > current ? target - current : 0n;
  const monthsToGoal =
    remaining === 0n ? 0 : monthly === 0n ? null : Number(divideUp(remaining, monthly));
  const projectedMonth =
    monthsToGoal === null ? null : addGoalMonths(input.startMonth, monthsToGoal);

  let monthsUntilTarget: number | null = null;
  let requiredMonthly: bigint | null = null;
  let onTrack: boolean | null = null;
  let paceRatio: number | null = null;
  if (input.targetMonth) {
    monthsUntilTarget = Math.max(0, goalMonthsBetween(input.startMonth, input.targetMonth));
    requiredMonthly =
      remaining === 0n
        ? 0n
        : monthsUntilTarget === 0
          ? remaining
          : divideUp(remaining, BigInt(monthsUntilTarget));
    onTrack = remaining === 0n || monthly >= requiredMonthly;
    paceRatio =
      requiredMonthly === 0n
        ? 1
        : Math.min(10, Number((monthly * 10_000n) / requiredMonthly) / 10_000);
  }

  const shortfall =
    requiredMonthly === null || monthly >= requiredMonthly ? 0n : requiredMonthly - monthly;
  return Object.freeze({
    remainingAmount: paceMoney(remaining, currency),
    monthsToGoal,
    projectedMonth,
    monthsUntilTarget,
    requiredMonthlyContribution:
      requiredMonthly === null ? null : paceMoney(requiredMonthly, currency),
    monthlyShortfall: paceMoney(shortfall, currency),
    onTrack,
    paceRatio,
  });
}
