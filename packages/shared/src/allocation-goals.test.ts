import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  type AllocationEntry,
  allocatePaycheck,
  allocationBalances,
  assertAllocationConservation,
  calculateEnvelopeAvailability,
  calculateSafeToSpend,
} from "./allocation.ts";
import { comfortablePurchaseDate, projectGoal } from "./goals.ts";
import { money } from "./money.ts";

describe("allocation ledger", () => {
  test("funds envelopes in policy order and conserves a paycheck", () => {
    const result = allocatePaycheck({
      paycheckId: "pay-1",
      amount: money(100_00n, "USD"),
      occurredAt: "2026-07-16T12:00:00.000Z",
      requests: [
        { envelopeId: "fun", target: money(30_00n, "USD"), priorityClass: "flexible" },
        { envelopeId: "rent", target: money(80_00n, "USD"), priorityClass: "requiredBills" },
      ],
    });
    expect(
      result.envelopeFunding.map((item) => [
        item.envelopeId,
        item.funded.minorUnits,
        item.shortfall.minorUnits,
      ]),
    ).toEqual([
      ["rent", 80_00n, 0n],
      ["fun", 20_00n, 10_00n],
    ]);
    expect(result.unassigned.minorUnits).toBe(0n);
    expect(assertAllocationConservation(result.entries, "USD")).toBeTrue();
  });

  test("arbitrary double-entry movements always net to zero", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 100_000n }), { maxLength: 100 }),
        (amounts) => {
          const entries: AllocationEntry[] = amounts.map((amount, index) => ({
            id: `entry-${index}`,
            occurredAt: "2026-07-16T00:00:00.000Z",
            from: index % 2 ? "envelope:a" : "unassigned:cash",
            to: index % 2 ? "unassigned:cash" : "envelope:a",
            amount: money(amount, "USD"),
            kind: "transfer",
          }));
          const balances = allocationBalances(entries, "USD");
          expect(Object.values(balances).reduce((sum, value) => sum + value.minorUnits, 0n)).toBe(
            0n,
          );
          expect(assertAllocationConservation(entries, "USD")).toBeTrue();
        },
      ),
    );
  });

  test("rejects duplicate immutable ledger entries", () => {
    const entry: AllocationEntry = {
      id: "duplicate",
      occurredAt: "2026-07-16T00:00:00.000Z",
      from: "unassigned:cash",
      to: "envelope:a",
      amount: money(100n, "USD"),
      kind: "fund",
    };
    expect(() => allocationBalances([entry, entry], "USD")).toThrow("Duplicate");
  });

  test("calculates exact envelope availability and safe-to-spend", () => {
    expect(
      calculateEnvelopeAvailability({
        openingBalance: money(5_00n, "USD"),
        funded: money(20_00n, "USD"),
        transferredIn: money(2_00n, "USD"),
        transferredOut: money(1_00n, "USD"),
        activity: money(12_50n, "USD"),
      }),
    ).toEqual(money(13_50n, "USD"));

    const result = calculateSafeToSpend({
      availableCash: money(2_000_00n, "USD"),
      reservedBills: money(1_100_00n, "USD"),
      envelopeCommitments: money(300_00n, "USD"),
      goalContributions: money(200_00n, "USD"),
      minimumBuffer: money(250_00n, "USD"),
    });
    expect(result.safeToSpend).toEqual(money(150_00n, "USD"));
    expect(result.shortfall.minorUnits).toBe(0n);
  });

  test("safe-to-spend never goes below zero unless explicitly requested", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.array(fc.bigInt({ min: 0n, max: 250_000n }), { minLength: 4, maxLength: 4 }),
        (cash, deductions) => {
          const [bills, envelopes, goals, buffer] = deductions as [bigint, bigint, bigint, bigint];
          const result = calculateSafeToSpend({
            availableCash: money(cash, "USD"),
            reservedBills: money(bills, "USD"),
            envelopeCommitments: money(envelopes, "USD"),
            goalContributions: money(goals, "USD"),
            minimumBuffer: money(buffer, "USD"),
          });
          expect(result.safeToSpend.minorUnits).toBeGreaterThanOrEqual(0n);
          expect(result.rawSafeToSpend.minorUnits).toBe(cash - bills - envelopes - goals - buffer);
        },
      ),
    );
  });
});

describe("goals and comfortable purchase dates", () => {
  test("projects an exact goal date", () => {
    const projection = projectGoal({
      startMonth: "2026-07",
      currentAmount: money(1_000_00n, "USD"),
      targetAmount: money(2_000_00n, "USD"),
      monthlyContribution: money(250_00n, "USD"),
    });
    expect(projection.reachedMonth).toBe("2026-11");
    expect(projection.monthsToGoal).toBe(4);
  });

  test("finds the first purchase month satisfying every guardrail", () => {
    const result = comfortablePurchaseDate({
      startMonth: "2026-07",
      purchasePrice: money(3_000_00n, "USD"),
      currentPurchaseSavings: money(500_00n, "USD"),
      monthlyPurchaseContribution: money(500_00n, "USD"),
      emergencyReserve: money(6_000_00n, "USD"),
      emergencyFloor: money(5_000_00n, "USD"),
      checkingBalance: money(2_000_00n, "USD"),
      checkingBuffer: money(1_000_00n, "USD"),
      monthlyCheckingChange: money(100_00n, "USD"),
      lookAheadMonths: 3,
    });
    expect(result.comfortableMonth).toBe("2026-12");
    expect(result.monthsUntilPurchase).toBe(5);
    expect(result.finalState.constraints.purchaseFunding).toBeTrue();
  });

  test("fails closed when a permanent constraint cannot be met", () => {
    const result = comfortablePurchaseDate({
      startMonth: "2026-07",
      purchasePrice: money(100_00n, "USD"),
      currentPurchaseSavings: money(100_00n, "USD"),
      monthlyPurchaseContribution: money(0n, "USD"),
      emergencyReserve: money(100_00n, "USD"),
      emergencyFloor: money(500_00n, "USD"),
      checkingBalance: money(2_000_00n, "USD"),
      checkingBuffer: money(1_000_00n, "USD"),
      monthlyCheckingChange: money(0n, "USD"),
      horizonMonths: 12,
    });
    expect(result.comfortable).toBeFalse();
    expect(result.controllingConstraint).toBe("horizon");
  });
});
