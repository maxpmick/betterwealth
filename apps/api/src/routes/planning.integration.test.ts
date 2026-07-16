import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BetterWealthDatabase,
  balanceSnapshots,
  closeDatabase,
  openDatabase,
  runMigrations,
} from "@betterwealth/db";
import {
  accounts,
  assets,
  assetValuations,
  categories,
  envelopeCategoryLinks,
  envelopes,
  forecastRuns,
  forecastScenarios,
  incomeSources,
  refundLinks,
  settings,
  transactionSplits,
  transactions,
  users,
} from "@betterwealth/db/schema";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { ZodError } from "zod";
import { createSession, registerUser } from "../auth/service";
import { type AppConfig, loadConfig } from "../config";
import type { AppEnv } from "../types";
import { createPlanningRoutes } from "./planning";

describe("planning routes", () => {
  let db: BetterWealthDatabase;
  let config: AppConfig;
  let app: Hono<AppEnv>;
  let sessionToken: string;
  let csrfToken: string;
  let householdId: string;
  let userId: string;

  beforeEach(async () => {
    config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "0".repeat(64),
      REGISTRATION_MODE: "open",
      WEB_ORIGIN: "http://localhost:5173",
    });
    db = openDatabase(":memory:", { wal: false });
    runMigrations(db);
    const registration = await registerUser(
      db,
      {
        email: "alex@example.test",
        password: "WealthByThirty!",
        householdName: "Alex's plan",
      },
      config,
    );
    householdId = registration.householdId;
    userId = registration.userId;
    const session = await createSession(db, userId, config);
    sessionToken = session.token;
    csrfToken = session.csrfToken;
    app = new Hono<AppEnv>();
    app.route("/api/v1", createPlanningRoutes(db, config));
    app.onError((error, context) => {
      if (error instanceof ZodError) {
        return context.json({ error: { code: "validation_failed" } }, 422);
      }
      throw error;
    });
  });

  afterEach(() => closeDatabase(db));

  async function request(path: string, body?: unknown, method = body ? "POST" : "GET") {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        cookie: `bw_session=${sessionToken}; bw_household=${householdId}; bw_csrf=${csrfToken}`,
        origin: config.WEB_ORIGIN,
        "x-csrf-token": csrfToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  test("supports the web budget, goal, asset, scenario, forecast, and import flows", async () => {
    const accountId = ulid();
    await db.insert(accounts).values({
      id: accountId,
      householdId,
      ownerUserId: userId,
      name: "Primary checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      isManual: true,
    });
    await db.insert(balanceSnapshots).values({
      id: ulid(),
      householdId,
      accountId,
      ledgerBalance: 250_000n,
      currentBalance: 250_000n,
      availableBalance: 250_000n,
      currency: "USD",
      asOf: new Date().toISOString(),
      source: "manual",
    });

    const envelopeResponse = await request("/api/v1/envelopes", {
      name: "Rent",
      planned: { minorUnits: "120000", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      cadence: "Monthly",
      pacing: "on_track",
      rolloverPolicy: "monthly_reset",
    });
    expect(envelopeResponse.status).toBe(201);
    const envelope = (await envelopeResponse.json()) as { id: string };

    const budgetResponse = await request("/api/v1/budgets", {
      periodKind: "pay_cycle",
      startDate: "2026-07-16T00:00:00.000Z",
      endDate: "2026-07-31T00:00:00.000Z",
      plannedIncome: { minorUnits: "220000", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      spent: { minorUnits: "0", currency: "USD" },
      remaining: { minorUnits: "0", currency: "USD" },
      unassigned: { minorUnits: "220000", currency: "USD" },
      envelopes: [
        {
          id: envelope.id,
          planned: { minorUnits: "120000", currency: "USD" },
          funded: { minorUnits: "0", currency: "USD" },
        },
      ],
    });
    expect(budgetResponse.status).toBe(201);
    const budget = (await budgetResponse.json()) as { id: string };

    const allocationResponse = await request("/api/v1/allocations", {
      budgetId: budget.id,
      from: "Unassigned income",
      to: "Rent",
      amount: { minorUnits: "50000", currency: "USD" },
      reason: "Fund rent",
    });
    expect(allocationResponse.status).toBe(201);

    const goalResponse = await request("/api/v1/goals", {
      name: "Emergency fund",
      type: "emergency_fund",
      target: { minorUnits: "1000000", currency: "USD" },
      funded: { minorUnits: "250000", currency: "USD" },
      monthlyContribution: { minorUnits: "50000", currency: "USD" },
      priority: 1,
      paused: false,
      probability: 0.9,
      earliestSafeDate: "2027-12-01",
    });
    expect(goalResponse.status).toBe(201);
    const goal = (await goalResponse.json()) as { id: string };
    const contributionResponse = await request(`/api/v1/goals/${goal.id}/contributions`, {
      amount: { minorUnits: "10000", currency: "USD" },
      source: "Checking",
    });
    expect(contributionResponse.status).toBe(201);
    expect(await contributionResponse.json()).toHaveProperty("contributionId");

    const negativeAssetResponse = await request("/api/v1/assets", {
      name: "Impossible negative car",
      type: "vehicle",
      value: { minorUnits: "-1", currency: "USD" },
    });
    expect(negativeAssetResponse.status).toBe(422);

    const assetResponse = await request("/api/v1/assets", {
      name: "2019 Honda Civic",
      type: "vehicle",
      value: { minorUnits: "950000", currency: "USD" },
      valuedAt: "2026-07-01T00:00:00.000Z",
      source: "manual",
      confidence: "medium",
      liquidityClass: "illiquid",
    });
    expect(assetResponse.status).toBe(201);
    const createdAsset = (await assetResponse.json()) as { id: string; valuationId: string };
    expect(createdAsset).toHaveProperty("value.minorUnits", "950000");
    const repeatedValuation = await request(`/api/v1/assets/${createdAsset.id}/valuations`, {
      amount: { minorUnits: "955000", currency: "USD" },
      valuedOn: "2026-07-01",
      source: "manual",
      confidenceBps: 9_000,
    });
    expect(repeatedValuation.status).toBe(201);
    expect(await repeatedValuation.json()).toMatchObject({
      id: createdAsset.valuationId,
      amount: { minorUnits: "955000", currency: "USD" },
    });
    const valuationHistory = await request(`/api/v1/assets/${createdAsset.id}/valuations`);
    const valuationHistoryBody = (await valuationHistory.json()) as { data: unknown[] };
    expect(valuationHistoryBody.data).toHaveLength(1);

    const retirementAccountId = ulid();
    const now = new Date();
    const birthDate = `${now.getUTCFullYear() - 22}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-15`;
    await Promise.all([
      db.update(users).set({ birthDate, targetAge: 30 }).where(eq(users.id, userId)),
      db.insert(settings).values({
        id: ulid(),
        householdId,
        scopeKey: "household",
        key: "planning.safe_to_spend",
        value: {
          minimumBufferMinorUnits: "125000",
          targetLiquidNetWorthMinorUnits: "30000000",
        },
      }),
      db.insert(accounts).values({
        id: retirementAccountId,
        householdId,
        ownerUserId: userId,
        name: "401(k)",
        group: "investment",
        type: "401(k)",
        currency: "USD",
        isManual: true,
      }),
      db.insert(incomeSources).values({
        id: ulid(),
        householdId,
        name: "Paycheck",
        accountId,
        cadence: "biweekly",
        typicalAmount: 220_000n,
        currency: "USD",
      }),
    ]);
    await db.insert(balanceSnapshots).values({
      id: ulid(),
      householdId,
      accountId: retirementAccountId,
      ledgerBalance: 800_000n,
      currentBalance: 800_000n,
      availableBalance: 800_000n,
      currency: "USD",
      asOf: new Date().toISOString(),
      source: "manual",
    });

    const scenarioResponse = await request("/api/v1/scenarios", {
      name: "Baseline",
      preset: "baseline",
      assumptions: {
        incomeGrowth: 3.2,
        inflation: 2.6,
        investmentReturn: 6.5,
        cashYield: 4.1,
        monthlyInvesting: { minorUnits: "50000", currency: "USD" },
      },
      seed: 300122,
      isBase: true,
    });
    expect(scenarioResponse.status).toBe(201);
    const scenario = (await scenarioResponse.json()) as { id: string };
    const storedScenario = await db
      .select()
      .from(forecastScenarios)
      .where(eq(forecastScenarios.id, scenario.id))
      .get();
    const forecastInput = storedScenario?.assumptions as {
      scenario: {
        horizonMonths: number;
        minimumCashBuffer?: { minorUnits: string };
        accounts: Array<{ id: string; liquid: boolean }>;
        cashFlows: Array<{ name?: string; amount: { minorUnits: string } }>;
      };
    };
    expect(forecastInput.scenario.horizonMonths).toBe(96);
    expect(forecastInput.scenario.minimumCashBuffer?.minorUnits).toBe("125000");
    expect(
      forecastInput.scenario.accounts.find((account) => account.id === retirementAccountId)?.liquid,
    ).toBe(false);
    expect(
      forecastInput.scenario.cashFlows.find((cashFlow) => cashFlow.name === "Paycheck")?.amount
        .minorUnits,
    ).toBe("476667");
    const forecastResponse = await request("/api/v1/forecasts", {
      scenarioId: scenario.id,
      seed: 300122,
      monteCarloRuns: 10,
    });
    expect(forecastResponse.status).toBe(201);
    const forecast = (await forecastResponse.json()) as {
      trajectory: unknown[];
      percentiles: unknown[];
      monteCarlo: { runs: number; ranges: unknown[]; goalSuccessProbability: number | null };
    };
    expect(forecast.percentiles.length).toBeGreaterThan(0);
    expect(forecast.trajectory.length).toBeGreaterThan(1);
    expect(forecast.monteCarlo.runs).toBe(10);
    expect(forecast.monteCarlo.ranges.length).toBe(forecast.trajectory.length);
    expect(forecast.monteCarlo.goalSuccessProbability).not.toBeNull();

    const importResponse = await request("/api/v1/imports/transactions", {
      accountId,
      filename: "checking.csv",
      content: "date,description,amount,id\n2026-07-01,Coffee,-4.25,coffee-1\n",
      currency: "USD",
    });
    expect(importResponse.status).toBe(201);
    expect(await importResponse.json()).toMatchObject({
      importedRecords: 1,
      categorization: {
        candidates: 1,
        deterministic: 0,
        state: "queued",
      },
    });

    const [importedTransaction, foodCategory] = await Promise.all([
      db
        .select()
        .from(transactions)
        .where(
          and(eq(transactions.householdId, householdId), eq(transactions.externalId, "coffee-1")),
        )
        .get(),
      db
        .select()
        .from(categories)
        .where(and(eq(categories.householdId, householdId), eq(categories.slug, "food")))
        .get(),
    ]);
    expect(importedTransaction).toBeDefined();
    expect(importedTransaction?.reviewState).toBe("needs_review");
    expect(foodCategory).toBeDefined();
    const ruleBody = {
      name: "Coffee is food",
      priority: 100,
      enabled: true,
      origin: "user",
      conditions: {
        field: "normalizedDescription",
        operator: "exact",
        value: "COFFEE",
        caseSensitive: false,
      },
      actions: [{ type: "setCategory", categoryId: foodCategory!.id }],
    };
    const ruleResponse = await request("/api/v1/rules", ruleBody);
    expect(ruleResponse.status).toBe(201);
    const rule = (await ruleResponse.json()) as { id: string };
    const previewResponse = await request("/api/v1/rules/preview", {
      conditions: ruleBody.conditions,
      actions: ruleBody.actions,
      transactionIds: [importedTransaction!.id],
    });
    expect(previewResponse.status).toBe(200);
    expect(await previewResponse.json()).toHaveProperty("matchCount", 1);
    const applyResponse = await request(`/api/v1/rules/${rule.id}/apply`, {
      transactionIds: [importedTransaction!.id],
    });
    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toHaveProperty("affected", 1);
    const categorized = await db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.householdId, householdId),
          eq(transactions.id, importedTransaction!.id),
        ),
      )
      .get();
    expect(categorized?.categoryId).toBe(foodCategory!.id);
    expect(categorized?.categoryOrigin).toBe("rule");
  });

  test("derives exact envelope activity and performs real budget plan mutations", async () => {
    const overflowResponse = await request("/api/v1/envelopes", {
      name: "Impossible envelope",
      targetAmountMinorUnits: "9223372036854775808",
      cadence: "monthly",
      rolloverPolicy: "positive",
      currency: "USD",
    });
    expect(overflowResponse.status).toBe(422);
    expect(await overflowResponse.json()).toEqual({
      error: { code: "validation_failed" },
    });
    const accountId = ulid();
    await db.insert(accounts).values({
      id: accountId,
      householdId,
      ownerUserId: userId,
      name: "Budget checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      isManual: true,
    });
    const [food, shopping] = await Promise.all([
      db
        .select()
        .from(categories)
        .where(and(eq(categories.householdId, householdId), eq(categories.slug, "food")))
        .get(),
      db
        .select()
        .from(categories)
        .where(and(eq(categories.householdId, householdId), eq(categories.slug, "personal")))
        .get(),
    ]);
    expect(food).toBeDefined();
    expect(shopping).toBeDefined();

    const groceriesResponse = await request("/api/v1/envelopes", {
      name: "Groceries",
      planned: { minorUnits: "10000", currency: "USD" },
      cadence: "paycheck",
      rolloverPolicy: "positive",
      priority: 200,
      isRequired: true,
      categoryId: food!.id,
    });
    const shoppingResponse = await request("/api/v1/envelopes", {
      name: "Shopping",
      planned: { minorUnits: "10000", currency: "USD" },
      cadence: "paycheck",
      rolloverPolicy: "positive",
      priority: 50,
      categoryId: shopping!.id,
    });
    expect(groceriesResponse.status).toBe(201);
    expect(shoppingResponse.status).toBe(201);
    const groceries = (await groceriesResponse.json()) as { id: string };
    const shoppingEnvelope = (await shoppingResponse.json()) as { id: string };
    const budgetResponse = await request("/api/v1/budgets", {
      periodKind: "pay_cycle",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      plannedIncome: { minorUnits: "50000", currency: "USD" },
      status: "open",
      envelopes: [
        {
          id: groceries.id,
          planned: { minorUnits: "10000", currency: "USD" },
          funded: { minorUnits: "10000", currency: "USD" },
        },
        {
          id: shoppingEnvelope.id,
          planned: { minorUnits: "10000", currency: "USD" },
          funded: { minorUnits: "10000", currency: "USD" },
        },
      ],
    });
    expect(budgetResponse.status).toBe(201);
    const budget = (await budgetResponse.json()) as { id: string };

    const foodPurchaseId = ulid();
    const splitPurchaseId = ulid();
    const refundId = ulid();
    const baseTransaction = {
      householdId,
      accountId,
      currency: "USD",
      postedAt: "2026-07-10T12:00:00.000Z",
      transactedOn: "2026-07-10",
      status: "posted" as const,
      source: "manual" as const,
      reviewState: "reviewed" as const,
    };
    await db.insert(transactions).values([
      {
        ...baseTransaction,
        id: foodPurchaseId,
        amount: -10_000n,
        rawDescription: "NEIGHBORHOOD MARKET",
        normalizedDescription: "NEIGHBORHOOD MARKET",
        categoryId: food!.id,
      },
      {
        ...baseTransaction,
        id: splitPurchaseId,
        amount: -6_000n,
        rawDescription: "BIG BOX STORE",
        normalizedDescription: "BIG BOX STORE",
      },
      {
        ...baseTransaction,
        id: refundId,
        amount: 3_000n,
        postedAt: "2026-07-15T12:00:00.000Z",
        transactedOn: "2026-07-15",
        rawDescription: "BIG BOX REFUND",
        normalizedDescription: "BIG BOX REFUND",
        isReimbursement: true,
      },
      {
        ...baseTransaction,
        id: ulid(),
        amount: -5_000n,
        rawDescription: "PENDING FOOD",
        normalizedDescription: "PENDING FOOD",
        categoryId: food!.id,
        status: "pending",
        postedAt: null,
      },
      {
        ...baseTransaction,
        id: ulid(),
        amount: -2_500n,
        rawDescription: "TRANSFER TO SAVINGS",
        normalizedDescription: "TRANSFER TO SAVINGS",
        categoryId: food!.id,
        isTransfer: true,
      },
    ]);
    await db.insert(transactionSplits).values([
      {
        id: ulid(),
        householdId,
        transactionId: splitPurchaseId,
        sequence: 0,
        amount: -4_000n,
        categoryId: food!.id,
      },
      {
        id: ulid(),
        householdId,
        transactionId: splitPurchaseId,
        sequence: 1,
        amount: -2_000n,
        categoryId: shopping!.id,
      },
    ]);
    await db.insert(refundLinks).values({
      id: ulid(),
      householdId,
      refundTransactionId: refundId,
      purchaseTransactionId: splitPurchaseId,
      amount: 3_000n,
      confidenceBps: 10_000,
      status: "confirmed",
    });

    const liveResponse = await request(`/api/v1/budgets?view=pay_cycle`);
    expect(liveResponse.status).toBe(200);
    const liveBody = (await liveResponse.json()) as {
      data: Array<{
        id: string;
        spent: { minorUnits: string };
        remaining: { minorUnits: string };
        unassigned: { minorUnits: string };
        envelopes: Array<{
          id: string;
          activity: { minorUnits: string };
          available: { minorUnits: string };
        }>;
      }>;
    };
    const live = liveBody.data.find((item) => item.id === budget.id)!;
    expect(live.spent.minorUnits).toBe("13000");
    expect(live.remaining.minorUnits).toBe("7000");
    expect(live.unassigned.minorUnits).toBe("30000");
    expect(live.envelopes.find((item) => item.id === groceries.id)).toMatchObject({
      activity: { minorUnits: "-12000" },
      available: { minorUnits: "-2000" },
    });
    expect(live.envelopes.find((item) => item.id === shoppingEnvelope.id)).toMatchObject({
      activity: { minorUnits: "-1000" },
      available: { minorUnits: "9000" },
    });

    const coverResponse = await request("/api/v1/allocations", {
      budgetId: budget.id,
      fromEnvelopeId: null,
      toEnvelopeId: groceries.id,
      amount: { minorUnits: "2000", currency: "USD" },
      reason: "Cover exact grocery overage",
    });
    expect(coverResponse.status).toBe(201);
    const covered = (await coverResponse.json()) as {
      budget: {
        unassigned: { minorUnits: string };
        envelopes: Array<{
          id: string;
          funded: { minorUnits: string };
          available: { minorUnits: string };
        }>;
      };
    };
    expect(covered.budget.unassigned.minorUnits).toBe("28000");
    expect(covered.budget.envelopes.find((item) => item.id === groceries.id)).toMatchObject({
      funded: { minorUnits: "12000" },
      available: { minorUnits: "0" },
    });

    const buildResponse = await request(`/api/v1/budgets/${budget.id}/build-from-monthly-spend`, {
      paychecksPerYear: 26,
      monthlyIncome: { minorUnits: "520000", currency: "USD" },
      items: [
        {
          name: "Housing",
          monthlyAmount: { minorUnits: "260000", currency: "USD" },
          priority: 500,
          isRequired: true,
          categoryId: shopping!.id,
        },
      ],
    });
    expect(buildResponse.status).toBe(200);
    expect(await buildResponse.json()).toMatchObject({
      budget: { plannedIncome: { minorUnits: "240000" } },
      conversions: [
        {
          name: "Housing",
          monthlyAmount: { minorUnits: "260000" },
          perPaycheckAmount: { minorUnits: "120000" },
        },
      ],
    });

    const clearCategoryResponse = await request(
      `/api/v1/envelopes/${shoppingEnvelope.id}`,
      { categoryId: null, categoryIds: [] },
      "PATCH",
    );
    expect(clearCategoryResponse.status).toBe(200);
    expect(await clearCategoryResponse.json()).toMatchObject({ categoryId: null, categoryIds: [] });
    expect(
      await db
        .select()
        .from(envelopeCategoryLinks)
        .where(eq(envelopeCategoryLinks.envelopeId, shoppingEnvelope.id)),
    ).toHaveLength(0);
    const archiveResponse = await request(
      `/api/v1/envelopes/${shoppingEnvelope.id}`,
      undefined,
      "DELETE",
    );
    expect(archiveResponse.status).toBe(204);
    expect(
      await db
        .select({ isActive: envelopes.isActive })
        .from(envelopes)
        .where(eq(envelopes.id, shoppingEnvelope.id))
        .get(),
    ).toEqual({ isActive: false });
  });

  test("forecasts manual assets and explicit liabilities without debt-payment double counting", async () => {
    const checkingId = ulid();
    const loanId = ulid();
    const unknownCardId = ulid();
    await db.insert(accounts).values([
      {
        id: checkingId,
        householdId,
        ownerUserId: userId,
        name: "Forecast checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isManual: true,
      },
      {
        id: loanId,
        householdId,
        ownerUserId: userId,
        name: "Student loan",
        group: "loan",
        type: "student loan",
        currency: "USD",
        isLiability: true,
        includeInBudget: false,
        providerMetadata: {
          annualInterestBps: 475,
          minimumPaymentMinorUnits: "10000",
          paymentAccountId: checkingId,
        },
      },
      {
        id: unknownCardId,
        householdId,
        ownerUserId: userId,
        name: "Mystery card",
        group: "credit",
        type: "credit card",
        currency: "USD",
        isLiability: true,
        includeInBudget: false,
      },
    ]);
    const balanceTime = "2026-07-01T12:00:00.000Z";
    await db.insert(balanceSnapshots).values([
      {
        id: ulid(),
        householdId,
        accountId: checkingId,
        ledgerBalance: 100_000n,
        currentBalance: 100_000n,
        availableBalance: 100_000n,
        currency: "USD",
        asOf: balanceTime,
        source: "manual",
      },
      {
        id: ulid(),
        householdId,
        accountId: loanId,
        ledgerBalance: -400_000n,
        currentBalance: -400_000n,
        availableBalance: null,
        currency: "USD",
        asOf: balanceTime,
        source: "manual",
      },
      {
        id: ulid(),
        householdId,
        accountId: unknownCardId,
        ledgerBalance: -10_000n,
        currentBalance: -10_000n,
        availableBalance: null,
        currency: "USD",
        asOf: balanceTime,
        source: "manual",
      },
    ]);
    const houseId = ulid();
    await db.insert(assets).values({
      id: houseId,
      householdId,
      ownerUserId: userId,
      name: "Starter home",
      type: "property",
      liquidityClass: "illiquid",
      currency: "USD",
      linkedLiabilityAccountId: loanId,
      metadata: { annualAppreciationBps: 200 },
    });
    await db.insert(assetValuations).values({
      id: ulid(),
      householdId,
      assetId: houseId,
      amount: 500_000n,
      currency: "USD",
      valuedOn: "2026-07-01",
      source: "manual",
    });

    const debtCategory = await db
      .select()
      .from(categories)
      .where(and(eq(categories.householdId, householdId), eq(categories.slug, "debt")))
      .get();
    expect(debtCategory).toBeDefined();
    const debtEnvelopeResponse = await request("/api/v1/envelopes", {
      name: "Loan payment",
      planned: { minorUnits: "10000", currency: "USD" },
      cadence: "monthly",
      rolloverPolicy: "none",
      categoryId: debtCategory!.id,
      isRequired: true,
    });
    const debtEnvelope = (await debtEnvelopeResponse.json()) as { id: string };
    const billResponse = await request("/api/v1/bills", {
      name: "Student loan bill",
      envelopeId: debtEnvelope.id,
      amountMin: { minorUnits: "10000", currency: "USD" },
      amountMax: { minorUnits: "10000", currency: "USD" },
      dueRule: { cadence: "monthly" },
      isRequired: true,
    });
    expect(billResponse.status).toBe(201);
    const goalResponse = await request("/api/v1/goals", {
      name: "Kill the student loan",
      type: "debt_payoff",
      target: { minorUnits: "400000", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      monthlyContribution: { minorUnits: "5000", currency: "USD" },
      linkedDebtAccountId: loanId,
      priority: 500,
    });
    expect(goalResponse.status).toBe(201);

    const scenarioResponse = await request("/api/v1/scenarios", {
      name: "Complete balance sheet",
      preset: "baseline",
      assumptions: {
        incomeGrowth: 3,
        inflation: 2.5,
        investmentReturn: 6,
        cashYield: 3,
        monthlyInvesting: { minorUnits: "0", currency: "USD" },
      },
      seed: 42,
      isBase: true,
      horizonMonths: 12,
    });
    expect(scenarioResponse.status).toBe(201);
    const scenarioResponseBody = (await scenarioResponse.json()) as { id: string };
    const storedScenario = await db
      .select()
      .from(forecastScenarios)
      .where(eq(forecastScenarios.id, scenarioResponseBody.id))
      .get();
    const stored = storedScenario!.assumptions as unknown as {
      scenario: {
        accounts: Array<{
          id: string;
          balance: { minorUnits: string };
          annualReturnBps: number;
        }>;
        cashFlows: Array<{ id: string }>;
        debts: Array<{
          id: string;
          principal: { minorUnits: string };
          minimumPayment: { minorUnits: string };
          annualInterestBps: number;
          extraPayment?: { minorUnits: string };
        }>;
      };
    };
    expect(stored.scenario.accounts.find((account) => account.id === houseId)).toMatchObject({
      balance: { minorUnits: "500000" },
      annualReturnBps: 200,
    });
    expect(stored.scenario.debts.find((debt) => debt.id === loanId)).toMatchObject({
      principal: { minorUnits: "400000" },
      minimumPayment: { minorUnits: "10000" },
      annualInterestBps: 475,
      extraPayment: { minorUnits: "5000" },
    });
    expect(stored.scenario.cashFlows.some((flow) => flow.id === debtEnvelope.id)).toBe(false);

    const runResponse = await request("/api/v1/forecasts", {
      scenarioId: scenarioResponseBody.id,
      seed: 42,
    });
    expect(runResponse.status).toBe(201);
    const run = (await runResponse.json()) as {
      trajectory: Array<{ netWorth: { minorUnits: string } }>;
      readiness: { missingInputs: string[] };
    };
    expect(run.trajectory[0]!.netWorth.minorUnits).toBe("190000");
    expect(run.readiness.missingInputs).toContain("Mystery card APR");
    expect(run.readiness.missingInputs).toContain("Mystery card minimum payment");
    const storedRun = await db
      .select({ outputs: forecastRuns.outputs })
      .from(forecastRuns)
      .where(eq(forecastRuns.scenarioId, scenarioResponseBody.id))
      .get();
    const outputs = storedRun!.outputs as unknown as {
      months: Array<{
        totalAssets: { minorUnits: string };
        totalDebt: { minorUnits: string };
        debts: Array<{ id: string; principal: { minorUnits: string } }>;
      }>;
    };
    expect(outputs.months[0]).toMatchObject({
      totalAssets: { minorUnits: "600000" },
      totalDebt: { minorUnits: "410000" },
    });
    expect(outputs.months[0]!.debts).toHaveLength(2);
    expect(outputs.months[0]!.debts.find((debt) => debt.id === loanId)).toMatchObject({
      principal: { minorUnits: "400000" },
    });
  });
});
