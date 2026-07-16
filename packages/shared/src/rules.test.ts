import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { money } from "./money.ts";
import {
  applyRuleActions,
  type CategorizationRule,
  CategorizationRuleSchema,
  compileSafeRegex,
  evaluateCategorization,
  evaluateRules,
  matchesRuleCondition,
  type RuleTransaction,
  validateSafeRegex,
} from "./rules.ts";

const transaction: RuleTransaction = {
  id: "tx-1",
  rawDescription: "SQ *CORNER COFFEE #42",
  normalizedDescription: "Corner Coffee",
  merchant: "Corner Coffee",
  merchantAliases: ["SQ CORNER COFFEE"],
  accountId: "checking",
  accountGroup: "cash",
  accountType: "checking",
  institutionId: "bank",
  amount: money(-425n, "USD"),
  date: "2026-07-16",
  status: "posted",
  importSource: "simplefin",
  tagIds: ["existing"],
};

function rule(
  overrides: Partial<CategorizationRule> & Pick<CategorizationRule, "id" | "condition">,
): CategorizationRule {
  return CategorizationRuleSchema.parse({
    name: overrides.id,
    priority: 0,
    enabled: true,
    origin: "user",
    actions: [{ type: "setCategory", categoryId: `category-${overrides.id}` }],
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  });
}

describe("categorization rule DSL", () => {
  test("matches nested conditions deterministically", () => {
    const condition = CategorizationRuleSchema.parse({
      id: "coffee",
      name: "Coffee",
      enabled: true,
      priority: 10,
      origin: "user",
      updatedAt: "2026-07-01T00:00:00.000Z",
      condition: {
        all: [
          { field: "description", operator: "contains", value: "coffee" },
          { field: "amount", operator: "absoluteBetween", minimum: "300", maximum: "600" },
          { not: { field: "pending", operator: "is", value: true } },
        ],
      },
      actions: [{ type: "setCategory", categoryId: "dining" }],
    });
    expect(matchesRuleCondition(transaction, condition.condition)).toBeTrue();
  });

  test("orders by priority, then specificity, recency, and stable id", () => {
    const contains = rule({
      id: "contains",
      priority: 2,
      condition: {
        field: "description",
        operator: "contains",
        value: "coffee",
        caseSensitive: false,
      },
    });
    const merchant = rule({
      id: "merchant",
      priority: 2,
      condition: {
        field: "merchant",
        operator: "exact",
        value: "Corner Coffee",
        caseSensitive: false,
      },
    });
    const higherPriority = rule({
      id: "higher",
      priority: 3,
      condition: { field: "amount", operator: "absoluteBetween", minimum: "1", maximum: "1000" },
    });
    expect(evaluateRules(transaction, [contains, merchant])?.ruleId).toBe("merchant");
    expect(evaluateRules(transaction, [contains, merchant, higherPriority])?.ruleId).toBe("higher");

    const older = rule({
      id: "older",
      condition: merchant.condition,
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const newer = rule({
      id: "newer",
      condition: merchant.condition,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    expect(evaluateRules(transaction, [older, newer])?.ruleId).toBe("newer");
  });

  test("rejects unsafe or invalid regular expressions", () => {
    for (const pattern of ["(a+)+$", "(.*)+", "(a|aa)+", "(?=secret)", "(a)\\1", "[abc+"]) {
      expect(validateSafeRegex(pattern).safe).toBeFalse();
      expect(() => compileSafeRegex(pattern)).toThrow();
    }
    expect(validateSafeRegex("^CORNER [A-Z]{1,8}$").safe).toBeTrue();
    expect(compileSafeRegex("^corner [a-z]{1,8}$").test("CORNER COFFEE")).toBeTrue();
  });

  test("percentage splits conserve every minor unit for positive and negative amounts", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -1_000_000n, max: 1_000_000n }), (minorUnits) => {
        const result = applyRuleActions({ ...transaction, amount: money(minorUnits, "USD") }, [
          {
            type: "createPercentageSplits",
            splits: [
              { basisPoints: 3_333, categoryId: "one" },
              { basisPoints: 3_333, categoryId: "two" },
              { basisPoints: 3_334, categoryId: "three" },
            ],
          },
        ]);
        expect(result.splits!.reduce((sum, split) => sum + split.amount.minorUnits, 0n)).toBe(
          minorUnits,
        );
      }),
    );
  });

  test("actions are pure and tag application is idempotent", () => {
    const patch = applyRuleActions(transaction, [
      { type: "addTags", tagIds: ["coffee", "existing"] },
      { type: "removeTags", tagIds: ["existing"] },
      { type: "normalizeMerchant", merchant: "Corner Coffee" },
      { type: "requestReview", value: true },
    ]);
    expect(patch.tagIds).toEqual(["coffee"]);
    expect(patch.merchant).toBe("Corner Coffee");
    expect(patch.needsReview).toBeTrue();
    expect(transaction.tagIds).toEqual(["existing"]);
  });

  test("an explicit user override always takes precedence", () => {
    const matching = rule({
      id: "merchant",
      priority: 1_000,
      condition: {
        field: "merchant",
        operator: "exact",
        value: "Corner Coffee",
        caseSensitive: false,
      },
    });
    const override = {
      categoryId: "user-category",
      tagIds: [],
      flags: {},
    } as const;
    const evaluation = evaluateCategorization(transaction, [matching], {
      explicitOverride: override,
    });
    expect(evaluation?.origin).toBe("userOverride");
    expect(evaluation?.patch).toBe(override);
  });
});
