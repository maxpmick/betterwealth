import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  assets,
  assetValuations,
  auditEvents,
  balanceSnapshots,
  bills,
  budgetPeriods,
  categories,
  closeDatabase,
  envelopeAllocations,
  envelopeCategoryLinks,
  envelopeRuleLinks,
  envelopes,
  goals,
  householdMembers,
  incomeSources,
  merchants,
  openDatabase,
  payCycles,
  recurringSeries,
  refundLinks,
  rules,
  runMigrations,
  settings,
  transactionSplits,
  transactions,
  transfers,
  users,
} from "@betterwealth/db";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import {
  analyzePersonalizationLedger,
  detectCadence,
  PERSONALIZATION_CATEGORY_BLUEPRINT,
  type PersonalizationLedgerRow,
  paychecksPerYear,
  personalizeHousehold,
} from "./service";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

test("detects exact biweekly cadence without floating-point money", () => {
  expect(
    detectCadence(["2026-05-02", "2026-05-16", "2026-05-30", "2026-06-13", "2026-06-27"]),
  ).toMatchObject({
    cadence: "biweekly",
    intervalDays: 14,
    nextExpectedDate: "2026-07-11",
  });
  expect(paychecksPerYear("weekly")).toBe(52);
  expect(paychecksPerYear("biweekly")).toBe(26);
  expect(paychecksPerYear("semimonthly")).toBe(24);
  expect(paychecksPerYear("monthly")).toBe(12);
  expect(paychecksPerYear("quarterly")).toBe(4);
});

test("analysis identifies payroll, recurring obligations, duplicates, and exact refund candidates", () => {
  const base = {
    accountId: "checking",
    accountGroup: "cash",
    accountType: "checking",
    currency: "USD",
    fingerprint: null,
    categoryId: null,
    categorySlug: null,
    categoryKind: null,
    categoryOrigin: "provider" as const,
    rootCategorySlug: null,
    status: "posted" as const,
    isTransfer: false,
    isIncome: false,
    isExcluded: false,
    isReimbursement: false,
    reviewState: "needs_review" as const,
    userOverrideAt: null,
  };
  const rows: PersonalizationLedgerRow[] = [
    ...["2026-05-02", "2026-05-16", "2026-05-30"].map((date, index) => ({
      ...base,
      id: `pay-${index}`,
      merchantId: "employer",
      merchantName: "Example Employer",
      amount: 150_001n + BigInt(index),
      transactedOn: date,
      normalizedDescription: "EXAMPLE EMPLOYER PAYROLL",
    })),
    ...["2026-04-20", "2026-05-20", "2026-06-20"].map((date, index) => ({
      ...base,
      id: `bill-${index}`,
      merchantId: "utility",
      merchantName: "Example Utility",
      amount: -12_345n,
      transactedOn: date,
      normalizedDescription: "EXAMPLE UTILITY",
      categoryId: "utilities",
      categorySlug: "utilities",
      categoryKind: "expense" as const,
      rootCategorySlug: "utilities",
    })),
    {
      ...base,
      id: "purchase",
      merchantId: "shop",
      merchantName: "Example Shop",
      amount: -2_500n,
      transactedOn: "2026-06-01",
      normalizedDescription: "EXAMPLE SHOP",
      fingerprint: "same",
    },
    {
      ...base,
      id: "duplicate",
      merchantId: "shop",
      merchantName: "Example Shop",
      amount: -2_500n,
      transactedOn: "2026-06-01",
      normalizedDescription: "EXAMPLE SHOP",
      fingerprint: "same",
    },
    {
      ...base,
      id: "refund",
      merchantId: "shop",
      merchantName: "Example Shop",
      amount: 2_500n,
      transactedOn: "2026-06-05",
      normalizedDescription: "EXAMPLE SHOP CREDIT",
    },
    {
      ...base,
      id: "cross-account-refund",
      accountId: "savings",
      merchantId: "shop",
      merchantName: "Example Shop",
      amount: 2_500n,
      transactedOn: "2026-06-06",
      normalizedDescription: "EXAMPLE SHOP CREDIT",
    },
    {
      ...base,
      id: "dividend-reinvestment",
      accountId: "brokerage",
      accountGroup: "investment",
      accountType: "brokerage",
      merchantId: "brokerage-merchant",
      merchantName: "Example Brokerage",
      amount: -13n,
      transactedOn: "2026-06-07",
      normalizedDescription: "DIVIDEND REINVESTMENT",
    },
    {
      ...base,
      id: "dividend-credit",
      accountId: "brokerage",
      accountGroup: "investment",
      accountType: "brokerage",
      merchantId: "brokerage-merchant",
      merchantName: "Example Brokerage",
      amount: 13n,
      transactedOn: "2026-06-08",
      normalizedDescription: "DIVIDEND",
    },
  ];
  const analysis = analyzePersonalizationLedger(rows, { employerHint: "Example Employer" });
  expect(analysis.payroll?.cadence?.cadence).toBe("biweekly");
  expect(analysis.payroll?.typicalAmount).toBe(150_002n);
  expect(analysis.recurringExpenses).toHaveLength(1);
  expect(analysis.duplicateCandidateGroups).toBe(1);
  expect(analysis.refundCandidatePairs).toHaveLength(1);
  expect(
    analysis.refundCandidatePairs.some(({ refundId }) => refundId === "cross-account-refund"),
  ).toBeFalse();
  expect(
    analysis.refundCandidatePairs.some(({ refundId }) => refundId === "dividend-credit"),
  ).toBeFalse();
  expect(analysis.refundCandidatePairs[0]?.amount).toBe(2_500n);
  expect(
    analysis.merchantPatterns.find(
      ({ merchantId, direction }) => merchantId === "shop" && direction === "outflow",
    )?.rows,
  ).toHaveLength(1);
  expect(
    analyzePersonalizationLedger(rows, { employerHint: "Unrelated Company" }).payroll,
  ).toBeNull();

  const otherCurrency = rows.map((row) =>
    row.id.startsWith("pay-") ? { ...row, currency: row.id === "pay-0" ? "EUR" : "USD" } : row,
  );
  expect(
    analyzePersonalizationLedger(otherCurrency, {
      employerHint: "Example Employer",
      currency: "EUR",
    }).payroll,
  ).toBeNull();

  const changedPayroll = analyzePersonalizationLedger(
    [
      ...["2026-05-01", "2026-05-15", "2026-05-29"].map((transactedOn, index) => ({
        ...base,
        id: `old-pay-${index}`,
        merchantId: "employer-old-description",
        merchantName: "XX6486 Park Place Techn Payroll",
        amount: 132_046n,
        transactedOn,
        normalizedDescription: "XX6486 PARK PLACE TECHN PAYROLL",
      })),
      {
        ...base,
        id: "new-pay-1",
        merchantId: "employer-old-description",
        merchantName: "XX6486 Park Place Techn Payroll",
        amount: 311_453n,
        transactedOn: "2026-06-12",
        normalizedDescription: "XX6486 PARK PLACE TECHN PAYROLL",
      },
      {
        ...base,
        id: "new-pay-2",
        merchantId: "employer-new-description",
        merchantName: "XX6486 Park Place Techn Payroll Paychecks",
        amount: 310_784n,
        transactedOn: "2026-06-26",
        normalizedDescription: "XX6486 PARK PLACE TECHN PAYROLL PAYCHECKS",
      },
    ],
    { employerHint: "Park Place Tech" },
  );
  expect(changedPayroll.payroll?.cadence?.cadence).toBe("biweekly");
  expect(changedPayroll.payroll?.typicalAmount).toBe(311_118n);
});

describe("idempotent household personalization", () => {
  test("creates a paycheck plan once, preserves exact units, and records reusable assumptions", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "f".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "personalize@example.com",
        password: "PersonalizeSafely!2026",
        householdName: "Personalization test",
      },
      config,
    );
    const categoryRows = await db
      .select()
      .from(categories)
      .where(eq(categories.householdId, registered.householdId));
    const categoryBySlug = new Map(categoryRows.map((category) => [category.slug, category]));
    const checkingId = ulid();
    const savingsId = ulid();
    const secondSavingsId = ulid();
    const taxableInvestmentId = ulid();
    const retirementId = ulid();
    const cryptoId = ulid();
    const creditId = ulid();
    const loanId = ulid();
    await db.insert(accounts).values([
      {
        id: checkingId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Primary checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: savingsId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Emergency savings",
        group: "cash",
        type: "savings",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: secondSavingsId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Second savings",
        group: "cash",
        type: "savings",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: taxableInvestmentId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Taxable brokerage",
        group: "investment",
        type: "brokerage",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: retirementId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Roth IRA",
        group: "investment",
        type: "ira",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: cryptoId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Crypto",
        group: "crypto",
        type: "wallet",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: creditId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Credit card",
        group: "credit",
        type: "credit_card",
        currency: "USD",
        isLiability: true,
        isManual: true,
      },
      {
        id: loanId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Student loan",
        group: "loan",
        type: "student_loan",
        currency: "USD",
        isLiability: true,
        isManual: true,
      },
    ]);
    await db.insert(balanceSnapshots).values([
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: checkingId,
        ledgerBalance: 250_000n,
        currentBalance: 250_000n,
        availableBalance: 250_000n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: secondSavingsId,
        ledgerBalance: 50_000n,
        currentBalance: 50_000n,
        availableBalance: 50_000n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: savingsId,
        ledgerBalance: 100_000n,
        currentBalance: 100_000n,
        availableBalance: 100_000n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: taxableInvestmentId,
        ledgerBalance: 123_400n,
        currentBalance: 123_400n,
        availableBalance: 123_400n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: retirementId,
        ledgerBalance: 4_831_300n,
        currentBalance: 4_831_300n,
        availableBalance: 4_831_300n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: cryptoId,
        ledgerBalance: 10_000n,
        currentBalance: 10_000n,
        availableBalance: 10_000n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: creditId,
        ledgerBalance: 20_000n,
        currentBalance: 20_000n,
        availableBalance: 20_000n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        accountId: loanId,
        ledgerBalance: 70_000n,
        currentBalance: 70_000n,
        availableBalance: 70_000n,
        currency: "USD",
        asOf: "2026-07-16T12:00:00.000Z",
        source: "manual",
      },
    ]);
    const liquidAssetId = ulid();
    await db.insert(assets).values({
      id: liquidAssetId,
      householdId: registered.householdId,
      ownerUserId: registered.userId,
      name: "Liquid manual asset",
      type: "custom",
      liquidityClass: "liquid",
      currency: "USD",
    });
    await db.insert(assetValuations).values({
      id: ulid(),
      householdId: registered.householdId,
      assetId: liquidAssetId,
      amount: 45_000n,
      currency: "USD",
      valuedOn: "2026-07-16",
      source: "manual",
    });
    const employerId = ulid();
    const utilityId = ulid();
    const grocerId = ulid();
    const storeId = ulid();
    await db.insert(merchants).values([
      {
        id: employerId,
        householdId: registered.householdId,
        name: "Example Works",
        normalizedName: "EXAMPLE WORKS",
      },
      {
        id: utilityId,
        householdId: registered.householdId,
        name: "Example Utility",
        normalizedName: "EXAMPLE UTILITY",
      },
      {
        id: grocerId,
        householdId: registered.householdId,
        name: "Example Grocer",
        normalizedName: "EXAMPLE GROCER",
      },
      {
        id: storeId,
        householdId: registered.householdId,
        name: "Example Store",
        normalizedName: "EXAMPLE STORE",
      },
    ]);
    const insertTransaction = async (input: {
      merchantId: string;
      amount: bigint;
      date: string;
      description: string;
      categoryId?: string;
      origin?: "provider" | "ai";
      fingerprint?: string;
    }) => {
      const id = ulid();
      await db.insert(transactions).values({
        id,
        householdId: registered.householdId,
        accountId: checkingId,
        merchantId: input.merchantId,
        amount: input.amount,
        currency: "USD",
        transactedOn: input.date,
        rawDescription: input.description,
        normalizedDescription: input.description,
        categoryId: input.categoryId ?? null,
        categoryOrigin: input.categoryId ? (input.origin ?? "provider") : "none",
        fingerprint: input.fingerprint,
        status: "posted",
        source: "manual",
        reviewState: "none",
        isIncome: input.amount > 0n,
      });
      return id;
    };
    for (const [index, date] of [
      "2026-05-02",
      "2026-05-16",
      "2026-05-30",
      "2026-06-13",
      "2026-06-27",
      "2026-07-11",
    ].entries()) {
      await insertTransaction({
        merchantId: employerId,
        amount: [150_001n, 150_003n, 150_002n, 150_004n, 150_002n, 150_003n][index]!,
        date,
        description: "EXAMPLE WORKS PAYROLL",
        categoryId: categoryBySlug.get("income")!.id,
      });
    }
    for (const date of ["2026-04-20", "2026-05-20", "2026-06-20"]) {
      await insertTransaction({
        merchantId: utilityId,
        amount: -12_345n,
        date,
        description: "EXAMPLE UTILITY",
        categoryId: categoryBySlug.get("utilities")!.id,
      });
    }
    for (const date of ["2026-05-06", "2026-05-20", "2026-06-03", "2026-06-17"]) {
      await insertTransaction({
        merchantId: grocerId,
        amount: -8_765n,
        date,
        description: "EXAMPLE GROCER",
        categoryId: categoryBySlug.get("food")!.id,
      });
    }
    const purchaseId = await insertTransaction({
      merchantId: storeId,
      amount: -2_500n,
      date: "2026-06-01",
      description: "EXAMPLE STORE",
      categoryId: categoryBySlug.get("personal")!.id,
    });
    const refundId = await insertTransaction({
      merchantId: storeId,
      amount: 2_500n,
      date: "2026-06-05",
      description: "EXAMPLE STORE CREDIT",
      categoryId: categoryBySlug.get("personal")!.id,
    });
    const suggestedTransferCategoryId = ulid();
    const userExcludedTransferCategoryId = ulid();
    await db.insert(transactions).values([
      {
        id: suggestedTransferCategoryId,
        householdId: registered.householdId,
        accountId: checkingId,
        amount: -4_321n,
        currency: "USD",
        transactedOn: "2026-06-08",
        rawDescription: "POSSIBLE ACCOUNT MOVEMENT",
        normalizedDescription: "POSSIBLE ACCOUNT MOVEMENT",
        categoryId: categoryBySlug.get("transfers")!.id,
        categoryOrigin: "ai",
        status: "posted",
        source: "manual",
        isTransfer: true,
        isExcluded: true,
        reviewState: "none",
      },
      {
        id: userExcludedTransferCategoryId,
        householdId: registered.householdId,
        accountId: checkingId,
        amount: -5_432n,
        currency: "USD",
        transactedOn: "2026-06-09",
        rawDescription: "USER EXCLUDED MOVEMENT",
        normalizedDescription: "USER EXCLUDED MOVEMENT",
        categoryId: categoryBySlug.get("transfers")!.id,
        categoryOrigin: "user",
        status: "posted",
        source: "manual",
        isTransfer: true,
        isExcluded: true,
        reviewState: "reviewed",
        userOverrideAt: "2026-06-09T12:00:00.000Z",
      },
    ]);
    const unsafeActions = [
      { type: "setCategory", categoryId: categoryBySlug.get("transfers")!.id },
      { type: "setFlag", flag: "transfer", value: true },
      { type: "setFlag", flag: "reportingExcluded", value: true },
    ];
    await db.insert(rules).values([
      {
        id: "legacy-ai-movement-rule",
        householdId: registered.householdId,
        name: "Legacy AI movement",
        priority: 25,
        origin: "ai",
        conditions: {
          all: [{ field: "description", operator: "contains", value: "MOVEMENT" }],
        },
        actions: unsafeActions as unknown as Record<string, unknown>,
        specificityScore: 10,
      },
      {
        id: "user-movement-rule",
        householdId: registered.householdId,
        name: "User movement",
        priority: 20,
        origin: "user",
        conditions: {
          all: [{ field: "description", operator: "contains", value: "MOVEMENT" }],
        },
        actions: unsafeActions as unknown as Record<string, unknown>,
        specificityScore: 10,
        createdByUserId: registered.userId,
      },
    ]);

    const run = (rebaseManagedBudget = false) =>
      personalizeHousehold({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        apply: true,
        aiBatches: 0,
        employerHint: "Example Works",
        starterProfile: true,
        rebaseManagedBudget,
        now: new Date("2026-07-16T12:00:00.000Z"),
      });
    const first = await run();
    expect(first).toMatchObject({
      mode: "applied",
      payrollDetected: true,
      payrollCadence: "biweekly",
      incomeSources: 1,
      bills: 1,
      envelopes: 10,
      budgetPeriods: 1,
      goals: 2,
      expectedPaycheckMinorUnits: "150002",
      planOverallocatedMinorUnits: "0",
    });
    const firstBudget = (await db.select().from(budgetPeriods))[0]!;
    const firstAllocations = await db
      .select()
      .from(envelopeAllocations)
      .where(eq(envelopeAllocations.budgetPeriodId, firstBudget.id));
    const firstPlanned = firstAllocations.reduce((sum, allocation) => sum + allocation.planned, 0n);
    expect(firstPlanned).toBeLessThanOrEqual(firstBudget.expectedIncome);
    expect(first.plannedPerPaycheckMinorUnits).toBe(firstPlanned.toString());
    expect(first.planSurplusMinorUnits).toBe(
      (firstBudget.expectedIncome - firstPlanned).toString(),
    );
    const rewrittenAiRule = await db
      .select({ actions: rules.actions })
      .from(rules)
      .where(eq(rules.id, "legacy-ai-movement-rule"))
      .get();
    if (!rewrittenAiRule) throw new Error("Rewritten AI rule is missing");
    const rewrittenAiActions = Array.isArray(rewrittenAiRule.actions)
      ? rewrittenAiRule.actions
      : [];
    expect(
      rewrittenAiActions.some(
        (action) =>
          action &&
          typeof action === "object" &&
          (action as Record<string, unknown>).type === "setFlag" &&
          (action as Record<string, unknown>).value === true &&
          ["transfer", "reportingExcluded", "reimbursement"].includes(
            String((action as Record<string, unknown>).flag),
          ),
      ),
    ).toBeFalse();
    expect(rewrittenAiActions).toContainEqual({ type: "requestReview", value: true });
    expect(
      await db
        .select({ actions: rules.actions })
        .from(rules)
        .where(eq(rules.id, "user-movement-rule"))
        .get(),
    ).toEqual({ actions: unsafeActions as unknown as Record<string, unknown> });
    expect(
      await db
        .select({
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          reviewState: transactions.reviewState,
        })
        .from(transactions)
        .where(eq(transactions.id, suggestedTransferCategoryId))
        .get(),
    ).toEqual({ isTransfer: false, isExcluded: false, reviewState: "needs_review" });
    expect(
      await db
        .select({
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          reviewState: transactions.reviewState,
        })
        .from(transactions)
        .where(eq(transactions.id, userExcludedTransferCategoryId))
        .get(),
    ).toEqual({ isTransfer: true, isExcluded: true, reviewState: "reviewed" });
    expect(
      await db
        .select({ fundedAmount: goals.fundedAmount })
        .from(goals)
        .where(eq(goals.type, "emergency_fund"))
        .get(),
    ).toEqual({ fundedAmount: 150_000n });
    const liquidWealthGoal = await db
      .select({
        id: goals.id,
        fundedAmount: goals.fundedAmount,
        fundingAccountId: goals.fundingAccountId,
      })
      .from(goals)
      .where(eq(goals.type, "investment_milestone"))
      .get();
    // Shared with the reports definition: cash + taxable investment + crypto +
    // liquid manual assets - revolving credit; Roth/loan balances are excluded.
    expect(liquidWealthGoal).toEqual({
      id: expect.any(String),
      fundedAmount: 558_400n,
      fundingAccountId: taxableInvestmentId,
    });
    await db
      .update(goals)
      .set({ fundedAmount: 5_389_700n })
      .where(eq(goals.id, liquidWealthGoal!.id));
    const countsAfterFirst = {
      categories: (await db.select().from(categories)).length,
      rules: (await db.select().from(rules)).length,
      series: (await db.select().from(recurringSeries)).length,
      income: (await db.select().from(incomeSources)).length,
      bills: (await db.select().from(bills)).length,
      envelopes: (await db.select().from(envelopes)).length,
      budgets: (await db.select().from(budgetPeriods)).length,
      allocations: (await db.select().from(envelopeAllocations)).length,
      goals: (await db.select().from(goals)).length,
      refunds: (await db.select().from(refundLinks)).length,
    };
    await db
      .update(transactions)
      .set({ amount: 15_000n })
      .where(
        and(
          eq(transactions.householdId, registered.householdId),
          eq(transactions.merchantId, employerId),
        ),
      );
    const generatedLowerPayroll = await run();
    expect(generatedLowerPayroll.expectedPaycheckMinorUnits).toBe("15000");
    expect(
      await db
        .select({ fundedAmount: goals.fundedAmount })
        .from(goals)
        .where(eq(goals.id, liquidWealthGoal!.id))
        .get(),
    ).toEqual({ fundedAmount: 558_400n });
    const generatedLowerAllocations = await db
      .select()
      .from(envelopeAllocations)
      .where(eq(envelopeAllocations.budgetPeriodId, firstBudget.id));
    expect(
      generatedLowerAllocations.reduce((sum, allocation) => sum + allocation.planned, 0n),
    ).toBeLessThanOrEqual(15_000n);
    expect(
      generatedLowerAllocations.some(
        (allocation) =>
          allocation.planned !== firstAllocations.find(({ id }) => id === allocation.id)?.planned,
      ),
    ).toBeTrue();
    await db
      .update(transactions)
      .set({ amount: 150_002n })
      .where(
        and(
          eq(transactions.householdId, registered.householdId),
          eq(transactions.merchantId, employerId),
        ),
      );
    expect((await run()).expectedPaycheckMinorUnits).toBe("150002");
    await db.delete(settings).where(eq(settings.key, "planning.personalization_budget_provenance"));
    const latestPersonalizationAudit = await db
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(eq(auditEvents.action, "planning.personalized"))
      .orderBy(sql`${auditEvents.occurredAt} desc`, sql`${auditEvents.id} desc`)
      .get();
    if (!latestPersonalizationAudit) throw new Error("Personalization audit is missing");
    await db
      .update(auditEvents)
      .set({
        metadata: {
          version: "betterwealth-personalization-v1",
          postedTransactions: 12,
          categoryCoverageBps: 9_000,
        },
      })
      .where(eq(auditEvents.id, latestPersonalizationAudit.id));
    const editedAllocation = firstAllocations.find(({ planned }) => planned > 0n)!;
    await db
      .update(envelopeAllocations)
      .set({
        planned: firstBudget.expectedIncome * 2n,
        funded: 1_234n,
        transferredIn: 500n,
        transferredOut: 200n,
        availableSnapshot: 999_999n,
      })
      .where(eq(envelopeAllocations.id, editedAllocation.id));
    const editedEnvelope = (await db.select().from(envelopes))[0]!;
    await db
      .update(envelopes)
      .set({ name: "My edited envelope", targetAmount: 42_424n, isActive: false })
      .where(eq(envelopes.id, editedEnvelope.id));
    const editedSeries = (await db.select().from(recurringSeries))[0]!;
    await db
      .update(recurringSeries)
      .set({ name: "My edited recurrence", status: "paused" })
      .where(eq(recurringSeries.id, editedSeries.id));
    const editedIncome = (await db.select().from(incomeSources))[0]!;
    await db
      .update(incomeSources)
      .set({ name: "My edited income", isActive: false })
      .where(eq(incomeSources.id, editedIncome.id));
    const editedBill = (await db.select().from(bills))[0]!;
    await db
      .update(bills)
      .set({ name: "My edited bill", isActive: false })
      .where(eq(bills.id, editedBill.id));
    const editedGoal = (await db.select().from(goals))[0]!;
    await db
      .update(goals)
      .set({
        name: "My edited goal",
        targetAmount: 9_999_999n,
        fundedAmount: 7_777n,
        targetDate: "2032-01-02",
        priority: 77,
        status: "paused",
        contributionPolicy: { cadence: "manual", userEdited: true },
      })
      .where(eq(goals.id, editedGoal.id));
    const editedRule = (await db.select().from(rules).where(like(rules.id, "autoplan_rule_%")))[0]!;
    await db
      .update(rules)
      .set({ name: "My disabled rule", isEnabled: false })
      .where(eq(rules.id, editedRule.id));

    const legacyTransferIds = [ulid(), ulid()];
    const userConfirmedTransferIds = [ulid(), ulid()];
    await db.insert(transactions).values([
      {
        id: legacyTransferIds[0]!,
        householdId: registered.householdId,
        accountId: checkingId,
        amount: -25_000n,
        currency: "USD",
        transactedOn: "2026-07-15",
        rawDescription: "Old automatic guess",
        normalizedDescription: "OLD AUTOMATIC GUESS",
        status: "posted",
        source: "manual",
        isTransfer: true,
        isExcluded: true,
        reviewState: "none",
      },
      {
        id: legacyTransferIds[1]!,
        householdId: registered.householdId,
        accountId: savingsId,
        amount: 25_000n,
        currency: "USD",
        transactedOn: "2026-07-15",
        rawDescription: "Old automatic guess",
        normalizedDescription: "OLD AUTOMATIC GUESS",
        status: "posted",
        source: "manual",
        isTransfer: true,
        isExcluded: true,
        reviewState: "none",
      },
      {
        id: userConfirmedTransferIds[0]!,
        householdId: registered.householdId,
        accountId: checkingId,
        amount: -30_000n,
        currency: "USD",
        transactedOn: "2026-07-14",
        rawDescription: "Confirmed transfer",
        normalizedDescription: "CONFIRMED TRANSFER",
        status: "posted",
        source: "manual",
        isTransfer: true,
        isExcluded: true,
        reviewState: "reviewed",
        userOverrideAt: "2026-07-14T12:00:00.000Z",
      },
      {
        id: userConfirmedTransferIds[1]!,
        householdId: registered.householdId,
        accountId: savingsId,
        amount: 30_000n,
        currency: "USD",
        transactedOn: "2026-07-14",
        rawDescription: "Confirmed transfer",
        normalizedDescription: "CONFIRMED TRANSFER",
        status: "posted",
        source: "manual",
        isTransfer: true,
        isExcluded: true,
        reviewState: "reviewed",
        userOverrideAt: "2026-07-14T12:00:00.000Z",
      },
    ]);
    await db.insert(transfers).values([
      {
        id: "legacy-unconfirmed-transfer",
        householdId: registered.householdId,
        outflowTransactionId: legacyTransferIds[0]!,
        inflowTransactionId: legacyTransferIds[1]!,
        confidenceBps: 9_800,
        status: "confirmed",
        matchedBy: "fingerprint",
      },
      {
        id: "user-confirmed-transfer",
        householdId: registered.householdId,
        outflowTransactionId: userConfirmedTransferIds[0]!,
        inflowTransactionId: userConfirmedTransferIds[1]!,
        confidenceBps: 10_000,
        status: "confirmed",
        matchedBy: "user",
        confirmedByUserId: registered.userId,
      },
    ]);

    const repaired = await run();
    const repairedAllocations = await db
      .select()
      .from(envelopeAllocations)
      .where(eq(envelopeAllocations.budgetPeriodId, firstBudget.id));
    const repairedPlannedTotal = repairedAllocations.reduce(
      (sum, allocation) => sum + allocation.planned,
      0n,
    );
    expect(repairedPlannedTotal).toBeGreaterThan(firstBudget.expectedIncome);
    const repairedAllocation = repairedAllocations.find(({ id }) => id === editedAllocation.id)!;
    expect(repairedAllocation).toMatchObject({
      planned: firstBudget.expectedIncome * 2n,
      funded: 1_234n,
      transferredIn: 500n,
      transferredOut: 200n,
    });
    expect(repairedAllocation.availableSnapshot).toBe(
      repairedAllocation.funded +
        repairedAllocation.activity +
        repairedAllocation.transferredIn -
        repairedAllocation.transferredOut,
    );
    expect(repaired.planOverallocatedMinorUnits).toBe(
      (repairedPlannedTotal - firstBudget.expectedIncome).toString(),
    );
    const userEditedPlanned = repairedAllocation.planned + 7_777n;
    await db
      .update(envelopeAllocations)
      .set({ planned: userEditedPlanned })
      .where(eq(envelopeAllocations.id, repairedAllocation.id));
    await db
      .update(transactions)
      .set({ amount: 120_000n })
      .where(
        and(
          eq(transactions.householdId, registered.householdId),
          eq(transactions.merchantId, employerId),
        ),
      );
    const lowerPayrollRun = await run();
    expect(lowerPayrollRun.expectedPaycheckMinorUnits).toBe("120000");
    expect(
      await db
        .select({ expectedIncome: budgetPeriods.expectedIncome })
        .from(budgetPeriods)
        .where(eq(budgetPeriods.id, firstBudget.id))
        .get(),
    ).toEqual({ expectedIncome: 120_000n });
    expect(
      await db
        .select({ expectedIncome: payCycles.expectedIncome })
        .from(payCycles)
        .where(eq(payCycles.householdId, registered.householdId))
        .get(),
    ).toEqual({ expectedIncome: 120_000n });
    const loweredAllocation = await db
      .select()
      .from(envelopeAllocations)
      .where(eq(envelopeAllocations.id, repairedAllocation.id))
      .get();
    expect(loweredAllocation).toMatchObject({
      planned: userEditedPlanned,
      funded: 1_234n,
      transferredIn: 500n,
      transferredOut: 200n,
    });
    const loweredPlannedTotal = (
      await db
        .select({ planned: envelopeAllocations.planned })
        .from(envelopeAllocations)
        .where(eq(envelopeAllocations.budgetPeriodId, firstBudget.id))
    ).reduce((sum, allocation) => sum + allocation.planned, 0n);
    expect(lowerPayrollRun.planOverallocatedMinorUnits).toBe(
      (loweredPlannedTotal - 120_000n).toString(),
    );
    expect(
      await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "planning.personalization_budget_provenance"))
        .get(),
    ).toEqual({
      value: expect.objectContaining({
        expectedIncomeMinorUnits: "120000",
        preservedAllocationIds: expect.arrayContaining([repairedAllocation.id]),
      }),
    });
    const rebased = await run(true);
    const rebasedAllocations = await db
      .select()
      .from(envelopeAllocations)
      .where(eq(envelopeAllocations.budgetPeriodId, firstBudget.id));
    expect(rebasedAllocations.reduce((sum, allocation) => sum + allocation.planned, 0n)).toBe(
      BigInt(rebased.plannedPerPaycheckMinorUnits!),
    );
    expect(BigInt(rebased.plannedPerPaycheckMinorUnits!)).toBeLessThanOrEqual(120_000n);
    expect(rebasedAllocations.find(({ id }) => id === repairedAllocation.id)).toMatchObject({
      funded: 1_234n,
      transferredIn: 500n,
      transferredOut: 200n,
    });
    const rebasedEditedEnvelope = await db
      .select()
      .from(envelopes)
      .where(eq(envelopes.id, editedEnvelope.id))
      .get();
    expect(rebasedEditedEnvelope).toMatchObject({
      name: "My edited envelope",
      isActive: false,
    });
    expect(rebasedEditedEnvelope?.targetAmount).not.toBe(42_424n);
    expect(
      await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "planning.personalization_budget_provenance"))
        .get(),
    ).toEqual({
      value: expect.objectContaining({ preservedAllocationIds: [] }),
    });
    await db
      .update(budgetPeriods)
      .set({ expectedIncome: 119_999n })
      .where(eq(budgetPeriods.id, firstBudget.id));
    await expect(run()).rejects.toThrow(
      "Managed paycheck income was edited after generation; refusing to overwrite it",
    );
    expect(
      await db
        .select({ expectedIncome: budgetPeriods.expectedIncome })
        .from(budgetPeriods)
        .where(eq(budgetPeriods.id, firstBudget.id))
        .get(),
    ).toEqual({ expectedIncome: 119_999n });
    await db
      .update(budgetPeriods)
      .set({ expectedIncome: 120_000n })
      .where(eq(budgetPeriods.id, firstBudget.id));
    expect(
      await db
        .select({ status: transfers.status })
        .from(transfers)
        .where(eq(transfers.id, "legacy-unconfirmed-transfer"))
        .get(),
    ).toEqual({ status: "suggested" });
    expect(
      await db
        .select({ isTransfer: transactions.isTransfer, isExcluded: transactions.isExcluded })
        .from(transactions)
        .where(inArray(transactions.id, legacyTransferIds)),
    ).toEqual([
      { isTransfer: false, isExcluded: false },
      { isTransfer: false, isExcluded: false },
    ]);
    expect(
      await db
        .select({ status: transfers.status })
        .from(transfers)
        .where(eq(transfers.id, "user-confirmed-transfer"))
        .get(),
    ).toEqual({ status: "confirmed" });
    expect(
      await db.select().from(envelopes).where(eq(envelopes.id, editedEnvelope.id)).get(),
    ).toMatchObject({
      name: "My edited envelope",
      isActive: false,
    });
    expect(
      await db.select().from(recurringSeries).where(eq(recurringSeries.id, editedSeries.id)).get(),
    ).toMatchObject({
      name: "My edited recurrence",
      status: "paused",
    });
    expect(
      await db.select().from(incomeSources).where(eq(incomeSources.id, editedIncome.id)).get(),
    ).toMatchObject({
      name: "My edited income",
      isActive: false,
    });
    expect(await db.select().from(bills).where(eq(bills.id, editedBill.id)).get()).toMatchObject({
      name: "My edited bill",
      isActive: false,
    });
    expect(await db.select().from(goals).where(eq(goals.id, editedGoal.id)).get()).toMatchObject({
      name: "My edited goal",
      targetAmount: 9_999_999n,
      fundedAmount: 7_777n,
      targetDate: "2032-01-02",
      priority: 77,
      status: "paused",
      contributionPolicy: { cadence: "manual", userEdited: true },
    });
    expect(await db.select().from(rules).where(eq(rules.id, editedRule.id)).get()).toMatchObject({
      name: "My disabled rule",
      isEnabled: false,
    });

    await db
      .update(budgetPeriods)
      .set({ status: "closed", closedAt: "2026-07-17T00:00:00.000Z" })
      .where(eq(budgetPeriods.id, firstBudget.id));
    const payCycle = (await db.select().from(payCycles))[0]!;
    await db
      .update(payCycles)
      .set({ status: "closed", closedAt: "2026-07-17T00:00:00.000Z" })
      .where(eq(payCycles.id, payCycle.id));
    await db
      .update(envelopeAllocations)
      .set({ planned: firstBudget.expectedIncome * 2n })
      .where(eq(envelopeAllocations.id, editedAllocation.id));
    const closedRun = await run();
    expect(closedRun.planOverallocatedMinorUnits).not.toBe("0");
    expect(
      await db.select().from(budgetPeriods).where(eq(budgetPeriods.id, firstBudget.id)).get(),
    ).toMatchObject({
      status: "closed",
      closedAt: "2026-07-17T00:00:00.000Z",
    });
    expect(
      await db.select().from(payCycles).where(eq(payCycles.id, payCycle.id)).get(),
    ).toMatchObject({
      status: "closed",
      closedAt: "2026-07-17T00:00:00.000Z",
    });
    expect({
      categories: (await db.select().from(categories)).length,
      rules: (await db.select().from(rules)).length,
      series: (await db.select().from(recurringSeries)).length,
      income: (await db.select().from(incomeSources)).length,
      bills: (await db.select().from(bills)).length,
      envelopes: (await db.select().from(envelopes)).length,
      budgets: (await db.select().from(budgetPeriods)).length,
      allocations: (await db.select().from(envelopeAllocations)).length,
      goals: (await db.select().from(goals)).length,
      refunds: (await db.select().from(refundLinks)).length,
    }).toEqual(countsAfterFirst);
    expect(countsAfterFirst.categories).toBe(12 + PERSONALIZATION_CATEGORY_BLUEPRINT.length);
    expect(countsAfterFirst.allocations).toBe(10);

    const source = (await db.select().from(incomeSources))[0]!;
    expect(source.typicalAmount).toBe(150_002n);
    expect(source.name).toBe("My edited income");
    const profile = await db
      .select({ birthDate: users.birthDate, targetAge: users.targetAge })
      .from(users)
      .where(eq(users.id, registered.userId))
      .get();
    expect(profile).toEqual({ birthDate: "2004-07-16", targetAge: 30 });
    const preference = await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.householdId, registered.householdId),
          eq(settings.key, "planning.safe_to_spend"),
        ),
      )
      .get();
    expect(preference?.value).toMatchObject({ targetLiquidNetWorthMinorUnits: "25000000" });
    const personalization = await db
      .select({ value: settings.value })
      .from(settings)
      .where(
        and(
          eq(settings.householdId, registered.householdId),
          eq(settings.key, "planning.personalization"),
        ),
      )
      .get();
    expect(personalization?.value).toMatchObject({ employerHint: "Example Works" });
    const goalPriorities = await db
      .select({ name: goals.name, priority: goals.priority })
      .from(goals)
      .where(eq(goals.householdId, registered.householdId));
    expect(goalPriorities).toEqual(
      expect.arrayContaining([
        { name: "My edited goal", priority: 77 },
        { name: "$250k liquid by 30", priority: 2 },
      ]),
    );
    expect(
      await db
        .select({ targetDate: goals.targetDate })
        .from(goals)
        .where(eq(goals.type, "investment_milestone"))
        .get(),
    ).toEqual({ targetDate: "2034-07-16" });
    const refund = await db
      .select({
        isIncome: transactions.isIncome,
        isReimbursement: transactions.isReimbursement,
        reviewState: transactions.reviewState,
      })
      .from(transactions)
      .where(eq(transactions.id, refundId))
      .get();
    expect(refund).toEqual({
      isIncome: false,
      isReimbursement: false,
      reviewState: "needs_review",
    });
    expect(
      await db
        .select({
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          reviewState: transactions.reviewState,
        })
        .from(transactions)
        .where(eq(transactions.id, suggestedTransferCategoryId))
        .get(),
    ).toEqual({ isTransfer: false, isExcluded: false, reviewState: "needs_review" });
    expect(
      await db
        .select({ actions: rules.actions })
        .from(rules)
        .where(eq(rules.id, "legacy-ai-movement-rule"))
        .get(),
    ).toEqual({ actions: rewrittenAiRule.actions });
    expect(
      await db
        .select()
        .from(refundLinks)
        .where(
          and(
            eq(refundLinks.refundTransactionId, refundId),
            eq(refundLinks.purchaseTransactionId, purchaseId),
          ),
        )
        .get(),
    ).toMatchObject({ status: "suggested", amount: 2_500n });
    const generatedRules = await db.select().from(rules).where(like(rules.id, "autoplan_rule_%"));
    expect(generatedRules.length).toBeGreaterThan(0);
    expect(generatedRules.every(({ name }) => !/autoplan_|[0-9A-HJKMNP-TV-Z]{26}/.test(name))).toBe(
      true,
    );
    expect(
      await db
        .select({ count: sql<number>`count(*)` })
        .from(auditEvents)
        .where(eq(auditEvents.action, "planning.personalized"))
        .get(),
    ).toEqual({ count: 7 });
  });

  test("only confirmed refund amounts offset the purchase envelopes and splits", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "9".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "refund-budget@example.com",
        password: "RefundBudget!2026",
        householdName: "Refund budget test",
      },
      config,
    );
    const categoryRows = await db
      .select()
      .from(categories)
      .where(eq(categories.householdId, registered.householdId));
    const categoryBySlug = new Map(categoryRows.map((category) => [category.slug, category]));
    const checkingId = ulid();
    const investmentId = ulid();
    const employerId = ulid();
    const storeId = ulid();
    const brokerId = ulid();
    await db.insert(accounts).values([
      {
        id: checkingId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: investmentId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Brokerage",
        group: "investment",
        type: "brokerage",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
    ]);
    await db.insert(merchants).values([
      {
        id: employerId,
        householdId: registered.householdId,
        name: "Refund Employer",
        normalizedName: "REFUND EMPLOYER",
      },
      {
        id: storeId,
        householdId: registered.householdId,
        name: "Split Store",
        normalizedName: "SPLIT STORE",
      },
      {
        id: brokerId,
        householdId: registered.householdId,
        name: "Brokerage Activity",
        normalizedName: "BROKERAGE ACTIVITY",
      },
    ]);
    const payrollRows = ["2026-06-01", "2026-06-15", "2026-06-29"].map((transactedOn) => ({
      id: ulid(),
      householdId: registered.householdId,
      accountId: checkingId,
      merchantId: employerId,
      amount: 100_000n,
      currency: "USD",
      transactedOn,
      rawDescription: "REFUND EMPLOYER PAYROLL",
      normalizedDescription: "REFUND EMPLOYER PAYROLL",
      categoryId: categoryBySlug.get("income")!.id,
      categoryOrigin: "provider" as const,
      status: "posted" as const,
      source: "manual" as const,
      reviewState: "none" as const,
      isIncome: true,
    }));
    const purchaseId = ulid();
    const refundId = ulid();
    const reinvestmentId = ulid();
    const dividendId = ulid();
    await db.insert(transactions).values([
      ...payrollRows,
      {
        id: purchaseId,
        householdId: registered.householdId,
        accountId: checkingId,
        merchantId: storeId,
        amount: -6_000n,
        currency: "USD",
        transactedOn: "2026-06-30",
        rawDescription: "SPLIT STORE PURCHASE",
        normalizedDescription: "SPLIT STORE PURCHASE",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
      {
        id: refundId,
        householdId: registered.householdId,
        accountId: checkingId,
        merchantId: storeId,
        amount: 5_000n,
        currency: "USD",
        transactedOn: "2026-07-01",
        rawDescription: "SPLIT STORE CREDIT",
        normalizedDescription: "SPLIT STORE CREDIT",
        categoryId: categoryBySlug.get("utilities")!.id,
        categoryOrigin: "provider",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
      {
        id: reinvestmentId,
        householdId: registered.householdId,
        accountId: investmentId,
        merchantId: brokerId,
        amount: -13n,
        currency: "USD",
        transactedOn: "2026-06-25",
        rawDescription: "BROKERAGE DIVIDEND REINVESTMENT",
        normalizedDescription: "BROKERAGE DIVIDEND REINVESTMENT",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
      {
        id: dividendId,
        householdId: registered.householdId,
        accountId: investmentId,
        merchantId: brokerId,
        amount: 13n,
        currency: "USD",
        transactedOn: "2026-06-26",
        rawDescription: "BROKERAGE DIVIDEND",
        normalizedDescription: "BROKERAGE DIVIDEND",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
    ]);
    await db.insert(transactionSplits).values([
      {
        id: ulid(),
        householdId: registered.householdId,
        transactionId: purchaseId,
        sequence: 0,
        amount: -4_000n,
        categoryId: categoryBySlug.get("food")!.id,
      },
      {
        id: ulid(),
        householdId: registered.householdId,
        transactionId: purchaseId,
        sequence: 1,
        amount: -2_000n,
        categoryId: categoryBySlug.get("personal")!.id,
      },
    ]);
    const linkId = ulid();
    const obsoleteInvestmentLinkId = "autoplan_refund_obsolete_investment";
    await db.insert(refundLinks).values([
      {
        id: linkId,
        householdId: registered.householdId,
        refundTransactionId: refundId,
        purchaseTransactionId: purchaseId,
        amount: 3_000n,
        confidenceBps: 10_000,
        status: "suggested",
      },
      {
        id: obsoleteInvestmentLinkId,
        householdId: registered.householdId,
        refundTransactionId: dividendId,
        purchaseTransactionId: reinvestmentId,
        amount: 13n,
        confidenceBps: 9_000,
        status: "suggested",
      },
    ]);
    const run = () =>
      personalizeHousehold({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        apply: true,
        aiBatches: 0,
        employerHint: "Refund Employer",
        starterProfile: false,
        now: new Date("2026-07-01T12:00:00.000Z"),
      });
    const activityByName = async () => {
      const envelopeRows = await db
        .select({ id: envelopes.id, name: envelopes.name })
        .from(envelopes)
        .where(eq(envelopes.householdId, registered.householdId));
      const nameById = new Map(envelopeRows.map(({ id, name }) => [id, name]));
      const allocationRows = await db
        .select({
          envelopeId: envelopeAllocations.envelopeId,
          activity: envelopeAllocations.activity,
        })
        .from(envelopeAllocations)
        .where(eq(envelopeAllocations.householdId, registered.householdId));
      return new Map(
        allocationRows.flatMap(({ envelopeId, activity }) => {
          const name = nameById.get(envelopeId);
          return name ? [[name, activity] as const] : [];
        }),
      );
    };

    await run();
    expect(
      await db
        .select({ id: refundLinks.id })
        .from(refundLinks)
        .where(eq(refundLinks.id, obsoleteInvestmentLinkId))
        .get(),
    ).toBeUndefined();
    expect(
      await db
        .select({ status: refundLinks.status })
        .from(refundLinks)
        .where(eq(refundLinks.id, linkId))
        .get(),
    ).toEqual({ status: "suggested" });
    let activities = await activityByName();
    expect(activities.get("Groceries")).toBe(-4_000n);
    expect(activities.get("Personal & shopping")).toBe(-2_000n);
    expect(activities.get("Utilities & connectivity")).toBe(0n);
    await run();
    activities = await activityByName();
    expect(activities.get("Groceries")).toBe(-4_000n);
    expect(activities.get("Personal & shopping")).toBe(-2_000n);

    await db.update(refundLinks).set({ status: "confirmed" }).where(eq(refundLinks.id, linkId));
    await run();
    activities = await activityByName();
    expect(activities.get("Groceries")).toBe(-2_000n);
    expect(activities.get("Personal & shopping")).toBe(-1_000n);
    expect(activities.get("Utilities & connectivity")).toBe(0n);
    expect(
      await db
        .select({ isReimbursement: transactions.isReimbursement })
        .from(transactions)
        .where(eq(transactions.id, refundId))
        .get(),
    ).toEqual({ isReimbursement: true });
  });

  test("rolls back every local domain write after a deterministic late failure", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "d".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "atomic-personalization@example.com",
        password: "AtomicPersonalization!2026",
        householdName: "Atomic personalization test",
      },
      config,
    );
    const checkingId = ulid();
    const employerId = ulid();
    await db.insert(accounts).values({
      id: checkingId,
      householdId: registered.householdId,
      ownerUserId: registered.userId,
      name: "Checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      isLiability: false,
      isManual: true,
    });
    await db.insert(merchants).values({
      id: employerId,
      householdId: registered.householdId,
      name: "Atomic Employer",
      normalizedName: "ATOMIC EMPLOYER",
    });
    const incomeCategory = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.slug, "income")))
      .get();
    if (!incomeCategory) throw new Error("Income category is missing");
    await db.insert(transactions).values(
      ["2026-06-01", "2026-06-15", "2026-06-29"].map((transactedOn) => ({
        id: ulid(),
        householdId: registered.householdId,
        accountId: checkingId,
        merchantId: employerId,
        amount: 100_000n,
        currency: "USD",
        transactedOn,
        rawDescription: "ATOMIC EMPLOYER PAYROLL",
        normalizedDescription: "ATOMIC EMPLOYER PAYROLL",
        categoryId: incomeCategory.id,
        categoryOrigin: "provider" as const,
        status: "posted" as const,
        source: "manual" as const,
        reviewState: "none" as const,
        isIncome: true,
      })),
    );
    const domainSnapshot = async () => ({
      users: await db.select().from(users),
      categories: await db.select().from(categories),
      transactions: await db.select().from(transactions),
      rules: await db.select().from(rules),
      recurringSeries: await db.select().from(recurringSeries),
      incomeSources: await db.select().from(incomeSources),
      bills: await db.select().from(bills),
      envelopes: await db.select().from(envelopes),
      envelopeCategoryLinks: await db.select().from(envelopeCategoryLinks),
      envelopeRuleLinks: await db.select().from(envelopeRuleLinks),
      payCycles: await db.select().from(payCycles),
      budgetPeriods: await db.select().from(budgetPeriods),
      envelopeAllocations: await db.select().from(envelopeAllocations),
      goals: await db.select().from(goals),
      refundLinks: await db.select().from(refundLinks),
      auditEvents: await db.select().from(auditEvents),
      settings: (await db.select().from(settings)).filter(
        ({ key }) => key !== "planning.personalization_journal",
      ),
    });
    const before = await domainSnapshot();
    await expect(
      personalizeHousehold({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        apply: true,
        aiBatches: 0,
        employerHint: "Atomic Employer",
        now: new Date("2026-07-01T12:00:00.000Z"),
        testHooks: {
          beforeLocalCommit: () => {
            throw new Error("injected late personalization failure");
          },
        },
      }),
    ).rejects.toThrow("injected late personalization failure");
    expect(db.$client.inTransaction).toBeFalse();
    expect(await domainSnapshot()).toEqual(before);
    expect(
      await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "planning.personalization_journal"))
        .get(),
    ).toEqual({ value: expect.objectContaining({ phase: "local_pending" }) });

    const recovered = await personalizeHousehold({
      db,
      config,
      householdId: registered.householdId,
      userId: registered.userId,
      apply: true,
      aiBatches: 0,
      employerHint: "Atomic Employer",
      now: new Date("2026-07-01T12:00:00.000Z"),
    });
    expect(recovered.mode).toBe("applied");
    expect(await db.select().from(budgetPeriods)).toHaveLength(1);
    expect(
      await db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, "planning.personalization_journal"))
        .get(),
    ).toEqual({ value: expect.objectContaining({ phase: "local_complete" }) });
  });

  test("fails closed before writes when payroll evidence or owner/admin authority is missing", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "e".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "preflight@example.com",
        password: "PreflightSafely!2026",
        householdName: "Preflight test",
      },
      config,
    );
    const checkingId = ulid();
    const employerId = ulid();
    await db.insert(accounts).values({
      id: checkingId,
      householdId: registered.householdId,
      ownerUserId: registered.userId,
      name: "Checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      isLiability: false,
      isManual: true,
    });
    await db.insert(merchants).values({
      id: employerId,
      householdId: registered.householdId,
      name: "Trusted Employer",
      normalizedName: "TRUSTED EMPLOYER",
    });
    const incomeCategory = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.slug, "income")))
      .get();
    if (!incomeCategory) throw new Error("Income category is missing");
    await db.insert(transactions).values(
      ["2026-06-01", "2026-06-15", "2026-06-29"].map((transactedOn) => ({
        id: ulid(),
        householdId: registered.householdId,
        accountId: checkingId,
        merchantId: employerId,
        amount: 100_000n,
        currency: "USD",
        transactedOn,
        rawDescription: "TRUSTED EMPLOYER PAYROLL",
        normalizedDescription: "TRUSTED EMPLOYER PAYROLL",
        categoryId: incomeCategory.id,
        categoryOrigin: "provider" as const,
        status: "posted" as const,
        source: "manual" as const,
        reviewState: "none" as const,
        isIncome: true,
      })),
    );
    const categoryCountBefore = (await db.select().from(categories)).length;
    await expect(
      personalizeHousehold({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        apply: true,
        aiBatches: 0,
        employerHint: "Wrong Employer",
      }),
    ).rejects.toThrow("No clean recurring payroll evidence matched");
    expect((await db.select().from(categories)).length).toBe(categoryCountBefore);
    expect(
      await db.select().from(settings).where(eq(settings.key, "planning.personalization_journal")),
    ).toHaveLength(0);

    let providerSawManagedChildTaxonomy = false;
    await personalizeHousehold({
      db,
      config,
      householdId: registered.householdId,
      userId: registered.userId,
      apply: true,
      aiBatches: 1,
      employerHint: "Trusted Employer",
      categorizeTransactions: async (categorizationInput) => {
        const visibleCategories = await categorizationInput.db
          .select({ parentId: categories.parentId })
          .from(categories)
          .where(eq(categories.householdId, categorizationInput.householdId));
        providerSawManagedChildTaxonomy = visibleCategories.some(
          ({ parentId }) => parentId !== null,
        );
        return {
          candidates: 0,
          deterministic: 0,
          aiCalls: 0,
          aiVerificationCalls: 0,
          aiVerified: 0,
          aiVerificationFailed: 0,
          aiResearchCitations: 0,
          aiResearchHosts: [],
          aiCreatedCategories: 0,
          aiAccepted: 0,
          aiPending: 0,
          aiFailed: 0,
          aiPreviouslyAttempted: 0,
        };
      },
    });
    expect(providerSawManagedChildTaxonomy).toBeTrue();
    const managedRuleRows = await db.select().from(rules).where(like(rules.id, "autoplan_rule_%"));
    const managedRuleCategoryIds = managedRuleRows.flatMap((rule) => {
      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      return actions.flatMap((action) => {
        if (
          action &&
          typeof action === "object" &&
          (action as Record<string, unknown>).type === "setCategory" &&
          typeof (action as Record<string, unknown>).categoryId === "string"
        ) {
          return [(action as Record<string, string>).categoryId!];
        }
        return [];
      });
    });
    const managedRuleCategories = managedRuleCategoryIds.length
      ? await db
          .select({ id: categories.id, parentId: categories.parentId })
          .from(categories)
          .where(inArray(categories.id, managedRuleCategoryIds))
      : [];
    expect(managedRuleCategories.length).toBeGreaterThan(0);
    expect(managedRuleCategories.every(({ parentId }) => parentId !== null)).toBeTrue();

    await db
      .update(householdMembers)
      .set({ role: "member" })
      .where(
        and(
          eq(householdMembers.householdId, registered.householdId),
          eq(householdMembers.userId, registered.userId),
        ),
      );
    await expect(
      personalizeHousehold({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        apply: false,
        employerHint: "Trusted Employer",
      }),
    ).rejects.toThrow("active owner or admin membership");
    expect((await db.select().from(categories)).length).toBe(
      categoryCountBefore + PERSONALIZATION_CATEGORY_BLUEPRINT.length,
    );
  });
});
