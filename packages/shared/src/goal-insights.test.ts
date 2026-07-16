import { describe, expect, test } from "bun:test";
import { deriveGoalPace } from "./goal-insights.ts";
import { money } from "./money.ts";

describe("deriveGoalPace", () => {
  test("uses exact cents and rounds the required target-date pace upward", () => {
    const pace = deriveGoalPace({
      startMonth: "2026-07",
      currentAmount: money(12_345n, "USD"),
      targetAmount: money(100_000n, "USD"),
      monthlyContribution: money(20_000n, "USD"),
      targetMonth: "2026-11",
    });

    expect(pace.remainingAmount.minorUnits).toBe(87_655n);
    expect(pace.requiredMonthlyContribution?.minorUnits).toBe(21_914n);
    expect(pace.monthlyShortfall.minorUnits).toBe(1_914n);
    expect(pace.monthsToGoal).toBe(5);
    expect(pace.projectedMonth).toBe("2026-12");
    expect(pace.onTrack).toBeFalse();
  });

  test("reports no projection for an unfunded goal with no monthly pace", () => {
    const pace = deriveGoalPace({
      startMonth: "2026-07",
      currentAmount: money(0n, "USD"),
      targetAmount: money(300_000n, "USD"),
      monthlyContribution: money(0n, "USD"),
    });

    expect(pace.monthsToGoal).toBeNull();
    expect(pace.projectedMonth).toBeNull();
    expect(pace.requiredMonthlyContribution).toBeNull();
    expect(pace.onTrack).toBeNull();
  });

  test("treats an already funded goal as complete without inventing a shortfall", () => {
    const pace = deriveGoalPace({
      startMonth: "2026-07",
      currentAmount: money(105_000n, "USD"),
      targetAmount: money(100_000n, "USD"),
      monthlyContribution: money(0n, "USD"),
      targetMonth: "2026-07",
    });

    expect(pace.remainingAmount.minorUnits).toBe(0n);
    expect(pace.monthsToGoal).toBe(0);
    expect(pace.projectedMonth).toBe("2026-07");
    expect(pace.requiredMonthlyContribution?.minorUnits).toBe(0n);
    expect(pace.onTrack).toBeTrue();
  });

  test("rejects mixed currencies", () => {
    expect(() =>
      deriveGoalPace({
        startMonth: "2026-07",
        currentAmount: money(0n, "USD"),
        targetAmount: money(100n, "EUR"),
        monthlyContribution: money(10n, "USD"),
      }),
    ).toThrow(/currenc/i);
  });
});
