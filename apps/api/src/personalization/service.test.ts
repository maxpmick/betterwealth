import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  auditEvents,
  balanceSnapshots,
  bills,
  budgetPeriods,
  categories,
  closeDatabase,
  envelopeAllocations,
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
    ]);
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
    });

    const run = () =>
      personalizeHousehold({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        apply: true,
        aiBatches: 0,
        employerHint: "Example Works",
        starterProfile: true,
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
    expect(
      await db
        .select({ fundedAmount: goals.fundedAmount })
        .from(goals)
        .where(eq(goals.type, "emergency_fund"))
        .get(),
    ).toEqual({ fundedAmount: 150_000n });
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
    const editedAllocation = firstAllocations[0]!;
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
    expect(
      repairedAllocations.reduce((sum, allocation) => sum + allocation.planned, 0n),
    ).toBeLessThanOrEqual(firstBudget.expectedIncome);
    const repairedAllocation = repairedAllocations.find(({ id }) => id === editedAllocation.id)!;
    expect(repairedAllocation).toMatchObject({
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
    expect(repaired.planOverallocatedMinorUnits).toBe("0");
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
      targetAmount: 42_424n,
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
      isIncome: true,
      isReimbursement: false,
      reviewState: "none",
    });
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
    ).toEqual({ count: 3 });
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
