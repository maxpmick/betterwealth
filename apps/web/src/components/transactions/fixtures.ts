import type { ApiAccount, ApiCategory, ApiEnvelope, ApiTransaction, CursorPage } from "../../api";
import { accounts as fixtureAccounts, transactions as fixtureTransactions } from "../../data";

export const demoApiTransactions: CursorPage<ApiTransaction> = {
  data: fixtureTransactions.map((transaction) => ({
    id: transaction.id,
    accountId:
      fixtureAccounts.find(({ name }) => name === transaction.account)?.id ?? "demo-account",
    effectiveDate: "2026-07-16",
    description: transaction.rawDescription,
    merchant: transaction.merchant,
    amount: {
      minorUnits: String(Math.round(transaction.amount * 100)),
      currency: "USD",
    },
    accountName: transaction.account,
    categoryName: transaction.category,
    status: transaction.pending ? "pending" : "posted",
    reviewState: transaction.needsReview ? "needs_review" : "ready",
    source: transaction.provenance.startsWith("CSV") ? "import" : "simplefin",
    note: transaction.note ?? "",
    tags: [],
    isTransfer: transaction.category === "Transfer",
    isExcluded: Boolean(transaction.excluded),
    isIncome: transaction.amount > 0 && transaction.category === "Income",
    hasSplits: false,
    ...(transaction.category === "Transfer"
      ? { transferId: `demo-transfer-${transaction.id}` }
      : {}),
    refundLinkIds: [],
  })),
  page: { cursor: null, hasMore: false },
};

export const demoCategories: CursorPage<ApiCategory> = {
  data: (
    [
      ["category-groceries", "Groceries", "expense"],
      ["category-dining", "Dining", "expense"],
      ["category-utilities", "Utilities", "expense"],
      ["category-shopping", "Shopping", "expense"],
      ["category-entertainment", "Entertainment", "expense"],
      ["category-transportation", "Transportation", "expense"],
      ["category-income", "Income", "income"],
      ["category-transfer", "Transfer", "transfer"],
    ] satisfies Array<[string, string, ApiCategory["kind"]]>
  ).map(([id, name, kind]) => ({
    id,
    name,
    kind: kind as ApiCategory["kind"],
    parentId: null,
    active: true,
  })),
  page: { cursor: null, hasMore: false },
};

export const demoEnvelopes: CursorPage<ApiEnvelope> = {
  data: ["Groceries", "Dining out", "Utilities", "Investing", "Home", "Subscriptions"].map(
    (name, index) => ({
      id: `demo-envelope-${index}`,
      name,
      planned: { minorUnits: "0", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      activity: { minorUnits: "0", currency: "USD" },
      available: { minorUnits: "0", currency: "USD" },
      cadence: "month",
      pacing: "on_track",
      rolloverPolicy: "reset",
      transferredIn: { minorUnits: "0", currency: "USD" },
      transferredOut: { minorUnits: "0", currency: "USD" },
      parentId: null,
      categoryId: null,
      categoryIds: [],
      priority: index,
      minimumAmount: { minorUnits: "0", currency: "USD" },
      targetAmount: { minorUnits: "0", currency: "USD" },
      isRequired: false,
      isActive: true,
    }),
  ),
  page: { cursor: null, hasMore: false },
};

export const demoAccounts: CursorPage<ApiAccount> = {
  data: fixtureAccounts.map((account) => ({
    id: account.id,
    name: account.name,
    mask: account.mask,
    group:
      account.group === "Investments"
        ? "investment"
        : account.group === "Credit"
          ? "credit"
          : account.group === "Loans"
            ? "loan"
            : "cash",
    balance: {
      minorUnits: String(Math.round(account.balance * 100)),
      currency: "USD",
    },
    syncStatus:
      account.status === "Attention"
        ? "attention"
        : account.status === "Manual"
          ? "manual"
          : "healthy",
    updatedAt: "2026-07-16T12:00:00.000Z",
  })),
  page: { cursor: null, hasMore: false },
};
