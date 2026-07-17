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
    categoryName: "Dining & takeout",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(matchesRuleCondition(transaction, rule.condition)).toBeTrue();
  expect(rule.name).toBe("Corner Coffee → Dining & takeout");
  expect(rule.actions).toContainEqual({ type: "setCategory", categoryId: "dining" });
  expect(rule.actions).toContainEqual({ type: "setFlag", flag: "transfer", value: false });
  expect(rule.actions).toContainEqual({
    type: "setFlag",
    flag: "reportingExcluded",
    value: false,
  });
  expect(rule.actions).toContainEqual({ type: "setFlag", flag: "income", value: false });
  expect(rule.actions).toContainEqual({ type: "setFlag", flag: "reimbursement", value: false });
  expect(JSON.stringify(rule.condition)).not.toContain(".*");
});

test("AI expense inflows remain reviewable until an exact refund is confirmed", () => {
  const rule = buildAiRule({
    id: "rule-refund",
    transaction: {
      id: "tx-refund",
      rawDescription: "STORE CREDIT",
      normalizedDescription: "STORE CREDIT",
      merchant: "Store",
      accountId: "account-1",
      amount: money(2_500n, "USD"),
      date: "2026-07-16",
      status: "posted",
      tagIds: [],
    },
    suggestion: {
      merchant: "Store",
      categoryId: "shopping",
      confidence: 0.98,
      rationale: "A returned purchase",
      proposedRule: { merchantEquals: "Store", direction: "inflow" },
    },
    categoryName: "Shopping",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(rule.actions).toContainEqual({ type: "setFlag", flag: "income", value: false });
  expect(rule.actions).toContainEqual({ type: "setFlag", flag: "reimbursement", value: false });
  expect(rule.actions).toContainEqual({ type: "requestReview", value: true });
});

test("AI income outflows never inflate income and remain reviewable", () => {
  const rule = buildAiRule({
    id: "rule-income-outflow",
    transaction: {
      id: "tx-income-outflow",
      rawDescription: "PAYROLL REVERSAL",
      normalizedDescription: "PAYROLL REVERSAL",
      merchant: "Employer",
      accountId: "account-1",
      amount: money(-10_000n, "USD"),
      date: "2026-07-16",
      status: "posted",
      tagIds: [],
    },
    suggestion: {
      merchant: "Employer",
      categoryId: "paycheck",
      confidence: 0.98,
      rationale: "An income-looking reversal",
      proposedRule: { merchantEquals: "Employer", direction: "outflow" },
    },
    categoryName: "Paycheck",
    categoryKind: "income",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(rule.actions).toContainEqual({ type: "setFlag", flag: "income", value: false });
  expect(rule.actions).toContainEqual({ type: "requestReview", value: true });
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

test("AI-proposed constraints that exclude their source transaction are discarded", () => {
  const transaction = {
    id: "tx-mismatched-constraints",
    rawDescription: "CORNER COFFEE",
    normalizedDescription: "CORNER COFFEE",
    merchant: "Corner Coffee",
    accountId: "account-1",
    amount: money(-425n, "USD"),
    date: "2026-07-16",
    status: "pending" as const,
    tagIds: [],
  };
  const rule = buildAiRule({
    id: "rule-mismatched-constraints",
    transaction,
    suggestion: {
      merchant: "Corner Coffee",
      categoryId: "dining",
      confidence: 0.99,
      rationale: "Known coffee merchant",
      proposedRule: {
        merchantEquals: "Corner Coffee",
        direction: "inflow",
        minAmountMinor: "1000",
        maxAmountMinor: "2000",
      },
    },
    categoryName: "Dining",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });

  expect(matchesRuleCondition(transaction, rule.condition)).toBeTrue();
  expect(JSON.stringify(rule.condition)).not.toContain('"value":"inflow"');
  expect(JSON.stringify(rule.condition)).not.toContain('"minimum":"1000"');
});

test("AI transfer categories stay reportable until an exact pair is confirmed", () => {
  const rule = buildAiRule({
    id: "rule-transfer",
    transaction: {
      id: "tx-transfer",
      rawDescription: "TRANSFER TO SAVINGS",
      normalizedDescription: "TRANSFER TO SAVINGS",
      accountId: "account-1",
      amount: money(-10_000n, "USD"),
      date: "2026-07-16",
      status: "posted",
      tagIds: [],
    },
    suggestion: {
      merchant: "Internal transfer",
      categoryId: "transfer",
      confidence: 0.99,
      rationale: "Owned-account transfer",
      proposedRule: { descriptionContains: "TRANSFER TO SAVINGS", direction: "outflow" },
    },
    categoryName: "Transfer",
    categoryKind: "transfer",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });

  expect(rule.actions).toEqual(
    expect.arrayContaining([
      { type: "setFlag", flag: "transfer", value: false },
      { type: "setFlag", flag: "reportingExcluded", value: false },
      { type: "setFlag", flag: "income", value: false },
      { type: "setFlag", flag: "reimbursement", value: false },
      { type: "requestReview", value: true },
    ]),
  );
});

test("AI rules generalize order IDs and store numbers into stable prefix patterns", () => {
  const amazon = buildAiRule({
    id: "rule-amazon",
    transaction: {
      id: "tx-amazon",
      rawDescription: "AMAZON MKTPL BS8HH6UF0",
      normalizedDescription: "AMAZON MKTPL BS8HH6UF0",
      accountId: "account-1",
      amount: money(-4_500n, "USD"),
      date: "2026-07-16",
      status: "posted" as const,
      tagIds: [],
    },
    suggestion: {
      merchant: "Amazon Marketplace",
      categoryId: "shopping",
      confidence: 0.95,
      rationale: "Online marketplace purchase",
    },
    categoryName: "Shopping",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(amazon.condition).toMatchObject({
    all: [
      { field: "normalizedDescription", operator: "contains", value: "AMAZON MKTPL" },
      { field: "direction", operator: "exact", value: "outflow" },
    ],
  });
  expect(
    matchesRuleCondition(
      {
        id: "tx-amazon-2",
        rawDescription: "AMAZON MKTPL ZZ99YY88",
        normalizedDescription: "AMAZON MKTPL ZZ99YY88",
        accountId: "account-1",
        amount: money(-9_999n, "USD"),
        date: "2026-07-17",
        status: "posted" as const,
        tagIds: [],
      },
      amazon.condition,
    ),
  ).toBeTrue();

  const chain = buildAiRule({
    id: "rule-chain",
    transaction: {
      id: "tx-chain",
      rawDescription: "TRADER JOES STORE 149",
      normalizedDescription: "TRADER JOES STORE 149",
      accountId: "account-1",
      amount: money(-4_267n, "USD"),
      date: "2026-07-16",
      status: "posted" as const,
      tagIds: [],
    },
    suggestion: {
      merchant: "Trader Joes",
      categoryId: "groceries",
      confidence: 0.97,
      rationale: "Grocery chain",
    },
    categoryName: "Groceries",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(chain.condition).toMatchObject({
    all: [
      { field: "normalizedDescription", operator: "contains", value: "Trader Joes" },
      { field: "direction", operator: "exact", value: "outflow" },
    ],
  });
});

test("merchant names contained in the description become stable contains patterns", () => {
  const rule = buildAiRule({
    id: "rule-brand",
    transaction: {
      id: "tx-brand",
      rawDescription: "365 MARKET FP",
      normalizedDescription: "365 MARKET FP",
      accountId: "account-1",
      amount: money(-962n, "USD"),
      date: "2026-07-16",
      status: "posted" as const,
      tagIds: [],
    },
    suggestion: {
      merchant: "365 Market",
      categoryId: "groceries",
      confidence: 0.95,
      rationale: "Small-format grocery",
    },
    categoryName: "Groceries",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(rule.condition).toMatchObject({
    all: [
      { field: "normalizedDescription", operator: "contains", value: "365 Market" },
      { field: "direction", operator: "exact", value: "outflow" },
    ],
  });
  expect(
    matchesRuleCondition(
      {
        id: "tx-brand-2",
        rawDescription: "365 MARKET FP",
        normalizedDescription: "365 MARKET FP",
        accountId: "account-1",
        amount: money(-500n, "USD"),
        date: "2026-07-17",
        status: "posted" as const,
        tagIds: [],
      },
      rule.condition,
    ),
  ).toBeTrue();
});

test("direction pinning separates merchant refunds from purchases", () => {
  const purchase = buildAiRule({
    id: "rule-direction",
    transaction: {
      id: "tx-direction",
      rawDescription: "SQ ROCKY RIVER SHOP",
      normalizedDescription: "SQ ROCKY RIVER SHOP",
      merchant: "Rocky River Shop",
      accountId: "account-1",
      amount: money(-1_800n, "USD"),
      date: "2026-07-16",
      status: "posted" as const,
      tagIds: [],
    },
    suggestion: {
      merchant: "Rocky River Shop",
      categoryId: "shopping",
      confidence: 0.95,
      rationale: "Retail purchase",
    },
    categoryName: "Shopping",
    categoryKind: "expense",
    updatedAt: "2026-07-16T12:00:00.000Z",
  });
  expect(JSON.stringify(purchase.condition)).toContain('"value":"outflow"');
  const refundTransaction = {
    id: "tx-direction-refund",
    rawDescription: "SQ ROCKY RIVER SHOP",
    normalizedDescription: "SQ ROCKY RIVER SHOP",
    merchant: "Rocky River Shop",
    accountId: "account-1",
    amount: money(1_800n, "USD"),
    date: "2026-07-17",
    status: "posted" as const,
    tagIds: [],
  };
  expect(matchesRuleCondition(refundTransaction, purchase.condition)).toBeFalse();
});
