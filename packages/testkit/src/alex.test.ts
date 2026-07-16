import { describe, expect, test } from "bun:test";

import {
  AccountSchema,
  EnvelopeSchema,
  GoalSchema,
  moneyFromJson,
  projectGoal,
  runForecast,
  TransactionSchema,
} from "@betterwealth/shared";

import { alexBaseForecastScenario, alexFixture, fixtureUlid } from "./alex.ts";

describe("canonical Alex age-22-to-30 fixture", () => {
  test("uses stable, unique ULIDs and validates all shared contracts", () => {
    const ids = Object.values(alexFixture.ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(fixtureUlid(123)).toHaveLength(26);
    for (const account of alexFixture.accounts)
      expect(AccountSchema.parse(account)).toEqual(account);
    for (const transaction of alexFixture.transactions)
      expect(TransactionSchema.parse(transaction)).toEqual(transaction);
    for (const envelope of alexFixture.envelopes)
      expect(EnvelopeSchema.parse(envelope)).toEqual(envelope);
    for (const goal of alexFixture.goals) expect(GoalSchema.parse(goal)).toEqual(goal);
  });

  test("reconciles account net worth and paired transfers exactly", () => {
    const assets = alexFixture.accounts
      .filter(
        (account) => !["loan", "creditCard", "mortgage", "otherLiability"].includes(account.type),
      )
      .reduce((sum, account) => sum + BigInt(account.currentBalance.minorUnits), 0n);
    const liabilities = alexFixture.accounts
      .filter((account) =>
        ["loan", "creditCard", "mortgage", "otherLiability"].includes(account.type),
      )
      .reduce((sum, account) => sum + BigInt(account.currentBalance.minorUnits), 0n);
    expect((assets + liabilities).toString()).toBe(
      alexFixture.expected.startingNetWorth.minorUnits,
    );

    const transfers = alexFixture.transactions.filter((transaction) => transaction.isTransfer);
    expect(transfers).toHaveLength(2);
    expect(new Set(transfers.map((transaction) => transaction.transferId)).size).toBe(1);
    expect(
      transfers
        .reduce((sum, transaction) => sum + BigInt(transaction.amount.minorUnits), 0n)
        .toString(),
    ).toBe(alexFixture.expected.transferNet.minorUnits);
    expect(
      transfers.every(
        (transaction) => transaction.excludedFromBudget && transaction.excludedFromReports,
      ),
    ).toBeTrue();
  });

  test("attributes the paycheck and preserves pending review state", () => {
    const paycheck = alexFixture.transactions.find(
      (transaction) => transaction.id === alexFixture.ids.txPaycheck,
    )!;
    expect(paycheck.isIncome).toBeTrue();
    expect(paycheck.categoryId).toBe(alexFixture.ids.categoryIncome);
    expect(paycheck.amount.minorUnits).toBe("260000");
    const pending = alexFixture.transactions.find(
      (transaction) => transaction.status === "pending",
    )!;
    expect(pending.needsReview).toBeTrue();
    expect(pending.categoryId).toBeNull();
  });

  test("keeps exact envelope and safe-to-spend math", () => {
    for (const envelope of alexFixture.envelopes) {
      expect(BigInt(envelope.available.minorUnits)).toBe(
        BigInt(envelope.funded.minorUnits) - BigInt(envelope.activity.minorUnits),
      );
    }
    expect(alexFixture.expected.safeToSpend).toEqual({ minorUnits: "60025", currency: "USD" });
  });

  test("locks canonical emergency, purchase, debt-free, and age-30 outcomes", () => {
    const forecast = runForecast(alexBaseForecastScenario);
    expect(forecast.horizonMonths).toBe(alexFixture.expected.forecastMonths);
    expect(forecast.ending.month).toBe(alexFixture.expected.age30Month);
    expect(forecast.ending.netWorth.minorUnits.toString()).toBe(
      alexFixture.expected.age30NetWorth.minorUnits,
    );
    expect(forecast.debtFreeMonth).toBe(alexFixture.expected.debtFreeMonth);
    expect(
      forecast.months.find((month) => month.accountBalances.emergency!.minorUnits >= 1_200_000n)
        ?.month,
    ).toBe(alexFixture.expected.emergencyFundMonth);

    const purchase = alexFixture.goals.find((goal) => goal.id === alexFixture.ids.goalCar)!;
    const projection = projectGoal({
      startMonth: alexFixture.profile.startMonth,
      currentAmount: moneyFromJson(purchase.currentAmount),
      targetAmount: moneyFromJson(purchase.targetAmount),
      monthlyContribution: moneyFromJson(purchase.monthlyContribution),
    });
    expect(projection.reachedMonth).toBe(alexFixture.expected.comfortablePurchaseFundingMonth);
  });

  test("all three scenarios are deterministic and ordered by outcome", () => {
    const results = alexFixture.scenarios.map((scenario) => runForecast(scenario));
    for (let index = 0; index < results.length; index++)
      expect(runForecast(alexFixture.scenarios[index]!)).toEqual(results[index]!);
    expect(results[1]!.ending.netWorth.minorUnits).toBeLessThan(
      results[0]!.ending.netWorth.minorUnits,
    );
    expect(results[0]!.ending.netWorth.minorUnits).toBeLessThan(
      results[2]!.ending.netWorth.minorUnits,
    );
  });
});
