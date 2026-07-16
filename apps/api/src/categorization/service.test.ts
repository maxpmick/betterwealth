import { expect, test } from "bun:test";
import { matchesRuleCondition, money } from "@betterwealth/shared";
import { buildAiRule } from "./service";

test("AI suggestions become narrow deterministic rules", () => {
  const transaction = {
    id: "tx-1",
    rawDescription: "SQ *CORNER COFFEE #42",
    normalizedDescription: "CORNER COFFEE",
    merchant: "Corner Coffee",
    accountId: "account-1",
    accountGroup: "credit",
    accountType: "credit_card",
    amount: money(-425n, "USD"),
    date: "2026-07-16",
    status: "posted" as const,
    tagIds: [],
  };
  const rule = buildAiRule({
    id: "rule-1",
    transaction,
    suggestion: {
      merchant: "Corner Coffee",
      categoryId: "dining",
      confidence: 0.97,
      rationale: "Known coffee merchant",
      proposedRule: { merchantEquals: "Corner Coffee", direction: "outflow" },
    },
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(matchesRuleCondition(transaction, rule.condition)).toBeTrue();
  expect(rule.actions).toContainEqual({ type: "setCategory", categoryId: "dining" });
  expect(JSON.stringify(rule.condition)).not.toContain(".*");
});

test("overbroad proposed text falls back to an exact normalized description", () => {
  const transaction = {
    id: "tx-2",
    rawDescription: "X",
    normalizedDescription: "KNOWN SAFE DESCRIPTION",
    accountId: "account-1",
    amount: money(-100n, "USD"),
    date: "2026-07-16",
    status: "posted" as const,
    tagIds: [],
  };
  const rule = buildAiRule({
    id: "rule-2",
    transaction,
    suggestion: {
      merchant: "--",
      categoryId: "other",
      confidence: 0.95,
      rationale: "Fallback",
      proposedRule: { descriptionContains: "*" },
    },
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(rule.condition).toMatchObject({
    field: "normalizedDescription",
    operator: "exact",
    value: "KNOWN SAFE DESCRIPTION",
  });
});
