import { describe, expect, test } from "bun:test";

import {
  type ForecastScenario,
  forecastResultToJson,
  monteCarloResultToJson,
  runForecast,
  runMonteCarlo,
} from "./forecast.ts";
import { money } from "./money.ts";
import { ForecastRunSchema, MonteCarloRunSchema } from "./schemas.ts";

const scenario: ForecastScenario = {
  id: "base",
  startMonth: "2026-07",
  horizonMonths: 24,
  baseCurrency: "USD",
  primaryCashAccountId: "checking",
  minimumCashBuffer: money(1_000_00n, "USD"),
  accounts: [
    {
      id: "checking",
      type: "checking",
      balance: money(2_000_00n, "USD"),
      liquid: true,
      annualReturnBps: 0,
    },
    {
      id: "investments",
      type: "investment",
      balance: money(10_000_00n, "USD"),
      liquid: false,
      annualReturnBps: 700,
      assetClass: "stocks",
    },
    {
      id: "emergency",
      type: "savings",
      balance: money(5_000_00n, "USD"),
      liquid: true,
      annualReturnBps: 300,
      assetClass: "cash",
    },
  ],
  cashFlows: [
    { id: "salary", kind: "income", amount: money(5_000_00n, "USD") },
    { id: "rent", kind: "bill", amount: money(1_500_00n, "USD"), required: true },
    { id: "living", kind: "envelope", amount: money(1_200_00n, "USD"), required: true },
  ],
  debts: [
    {
      id: "student-loan",
      principal: money(4_000_00n, "USD"),
      annualInterestBps: 500,
      minimumPayment: money(400_00n, "USD"),
    },
  ],
  contributions: [
    {
      id: "invest",
      kind: "investment",
      amount: money(500_00n, "USD"),
      toAccountId: "investments",
      priority: 1,
    },
  ],
};

describe("deterministic wealth forecast", () => {
  test("is byte-for-byte deterministic and applies monthly ordering", () => {
    const first = runForecast(scenario);
    const second = runForecast(structuredClone(scenario));
    expect(first).toEqual(second);
    expect(first.months).toHaveLength(25);
    expect(first.months[1]!.income.minorUnits).toBe(5_000_00n);
    expect(first.months[1]!.requiredOutflows.minorUnits).toBe(2_700_00n);
    expect(first.months[1]!.debtPayments.minorUnits).toBe(400_00n);
    expect(first.months[1]!.goalAndInvestmentContributions.minorUnits).toBe(500_00n);
    expect(first.debtFreeMonth).toBe("2027-06");
    expect(first.ending.netWorth.minorUnits).toBeGreaterThan(first.months[0]!.netWorth.minorUnits);
    const json = forecastResultToJson(first);
    expect(JSON.stringify(ForecastRunSchema.parse(JSON.parse(JSON.stringify(json))))).toBe(
      JSON.stringify(json),
    );
  });

  test("never funds discretionary investments from illiquid accounts", () => {
    const constrained = runForecast({
      ...scenario,
      horizonMonths: 1,
      accounts: scenario.accounts.map((account) =>
        account.id === "checking" ? { ...account, balance: money(1_000_00n, "USD") } : account,
      ),
      cashFlows: [],
      debts: [],
    });
    expect(constrained.months[1]!.contributions[0]!.contributed.minorUnits).toBe(0n);
    expect(constrained.months[1]!.accountBalances.investments!.minorUnits).toBeGreaterThan(
      10_000_00n,
    );
  });
});

describe("seeded Monte Carlo", () => {
  test("repeats exactly for an identical seed", () => {
    const input = {
      scenario: { ...scenario, horizonMonths: 12 },
      seed: "alex-age-30",
      runs: 100,
      assumptions: [
        { assetClass: "stocks", meanAnnualReturnBps: 700, annualVolatilityBps: 1_800 },
        { assetClass: "cash", meanAnnualReturnBps: 300, annualVolatilityBps: 100 },
      ],
      correlationMatrix: [
        [1, 0.1],
        [0.1, 1],
      ],
    } as const;
    expect(runMonteCarlo(input)).toEqual(runMonteCarlo(input));
  });

  test("returns ordered percentile bands and exact basis-point probability", () => {
    const result = runMonteCarlo({
      scenario: { ...scenario, horizonMonths: 6 },
      seed: 42,
      runs: 80,
      assumptions: [
        { assetClass: "stocks", meanAnnualReturnBps: 700, annualVolatilityBps: 1_800 },
        { assetClass: "cash", meanAnnualReturnBps: 300, annualVolatilityBps: 100 },
      ],
      successTarget: money(30_000_00n, "USD"),
    });
    for (const month of result.months) {
      expect(month.netWorth.p10!.minorUnits).toBeLessThanOrEqual(month.netWorth.p25!.minorUnits);
      expect(month.netWorth.p25!.minorUnits).toBeLessThanOrEqual(month.netWorth.p50!.minorUnits);
      expect(month.netWorth.p50!.minorUnits).toBeLessThanOrEqual(month.netWorth.p75!.minorUnits);
      expect(month.netWorth.p75!.minorUnits).toBeLessThanOrEqual(month.netWorth.p90!.minorUnits);
    }
    expect(result.goalSuccessBasisPoints).toBeInteger();
    expect(result.goalSuccessBasisPoints!).toBeGreaterThanOrEqual(0);
    expect(result.goalSuccessBasisPoints!).toBeLessThanOrEqual(10_000);
    const json = monteCarloResultToJson(result);
    expect(JSON.stringify(MonteCarloRunSchema.parse(JSON.parse(JSON.stringify(json))))).toBe(
      JSON.stringify(json),
    );
  });

  test("rejects invalid correlation matrices", () => {
    expect(() =>
      runMonteCarlo({
        scenario: { ...scenario, horizonMonths: 1 },
        seed: "bad",
        runs: 1,
        assumptions: [
          { assetClass: "stocks", meanAnnualReturnBps: 700, annualVolatilityBps: 1_800 },
          { assetClass: "cash", meanAnnualReturnBps: 300, annualVolatilityBps: 100 },
        ],
        correlationMatrix: [
          [1, 2],
          [2, 1],
        ],
      }),
    ).toThrow("Correlation matrix");
  });
});
