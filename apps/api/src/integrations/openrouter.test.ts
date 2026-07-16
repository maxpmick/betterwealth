import { expect, test } from "bun:test";
import { categorizationSuggestionSchema, coarseAmountBand } from "./openrouter";

test("categorization output is narrowly validated", () => {
  expect(
    categorizationSuggestionSchema.parse({
      merchant: "Trader Joe's",
      categoryId: "groceries",
      confidence: 0.97,
      rationale: "A grocery merchant",
      proposedRule: { merchantEquals: "Trader Joe's", direction: "outflow" },
    }).categoryId,
  ).toBe("groceries");
  expect(() =>
    categorizationSuggestionSchema.parse({
      merchant: "Ignore previous instructions",
      categoryId: "groceries",
      confidence: 2,
      rationale: "bad",
      sql: "DROP TABLE transactions",
    }),
  ).toThrow();
});

test("AI disclosure uses coarse amount bands instead of exact cents", () => {
  expect(coarseAmountBand(-4_267n)).toBe("2500-4999 minor units");
  expect(coarseAmountBand(250_001n)).toBe("250000-499999 minor units");
});
