import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  accounts,
  balanceSnapshots,
  bills,
  budgetPeriods,
  envelopeAllocations,
  envelopes,
  incomeSources,
  settings,
  transactions,
  users,
} from "@betterwealth/db/schema";
import { addMonths } from "@betterwealth/shared";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";

import { type BetterWealthApplication, createApp } from "../app";
import { createSession, registerUser } from "../auth/service";
import { type AppConfig, loadConfig } from "../config";

type Auth = { householdId: string; sessionToken: string; csrfToken: string };
type GoalResponse = {
  id: string;
  remaining: { minorUnits: string; currency: string };
  requiredMonthlyContribution: { minorUnits: string; currency: string } | null;
  monthlyShortfall: { minorUnits: string; currency: string };
  monthsToGoal: number | null;
  projectedDate: string | null;
  onTrack: boolean | null;
  fundingAccountId: string | null;
  linkedDebtAccountId: string | null;
  status: "active" | "paused" | "completed" | "cancelled";
  comfortablePurchase?: {
    status: "comfortable" | "not_comfortable" | "incomplete";
    comfortable: boolean | null;
    comfortableMonth: string | null;
    monthsUntilPurchase: number | null;
    controllingConstraint: string | null;
    missingInputs: string[];
    limitingConstraints: Array<{
      code: string;
      label: string;
      satisfied: boolean | null;
      detail: string;
    }>;
    inputs: {
      spendableLiquidity: { minorUnits: string; currency: string } | null;
      unreservedLiquidity: { minorUnits: string; currency: string } | null;
      fundingAccountBalance: { minorUnits: string; currency: string } | null;
      verifiedPurchaseSavings: { minorUnits: string; currency: string } | null;
      protectedMinimumBuffer: { minorUnits: string; currency: string } | null;
      requiredMonthlyBills: { minorUnits: string; currency: string } | null;
      requiredObligationShortfall: { minorUnits: string; currency: string } | null;
      higherPriorityMonthlyFunding: { minorUnits: string; currency: string };
      monthlySurplus: { minorUnits: string; currency: string } | null;
      monthlySurplusSource: "explicit_budget" | "observed_90_day" | null;
      currentLiquidNetWorth: { minorUnits: string; currency: string } | null;
      targetLiquidNetWorth: { minorUnits: string; currency: string } | null;
      targetWealthDate: string | null;
      projectedLiquidNetWorthAtTarget: { minorUnits: string; currency: string } | null;
    };
  };
};

describe("goal planning API", () => {
  let application: BetterWealthApplication;
  let config: AppConfig;
  let auth: Auth;
  let userId: string;
  let foreignAuth: Auth;
  let cashAccountId: string;
  let debtAccountId: string;
  let foreignAccountId: string;

  beforeEach(async () => {
    config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "0".repeat(64),
      REGISTRATION_MODE: "open",
      WEB_ORIGIN: "http://localhost:5173",
    });
    application = createApp(config);
    const primary = await registerUser(
      application.db,
      {
        email: "alex.goals@example.test",
        password: "WealthByThirty!",
        householdName: "Alex's plan",
      },
      config,
    );
    const outsider = await registerUser(
      application.db,
      {
        email: "outsider.goals@example.test",
        password: "AnotherWealthPlan!",
        householdName: "Outside plan",
      },
      config,
    );
    const [primarySession, foreignSession] = await Promise.all([
      createSession(application.db, primary.userId, config),
      createSession(application.db, outsider.userId, config),
    ]);
    auth = {
      householdId: primary.householdId,
      sessionToken: primarySession.token,
      csrfToken: primarySession.csrfToken,
    };
    userId = primary.userId;
    foreignAuth = {
      householdId: outsider.householdId,
      sessionToken: foreignSession.token,
      csrfToken: foreignSession.csrfToken,
    };

    cashAccountId = ulid();
    debtAccountId = ulid();
    foreignAccountId = ulid();
    await application.db.insert(accounts).values([
      {
        id: cashAccountId,
        householdId: primary.householdId,
        ownerUserId: primary.userId,
        name: "Primary checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isManual: true,
      },
      {
        id: debtAccountId,
        householdId: primary.householdId,
        ownerUserId: primary.userId,
        name: "Student loan",
        group: "loan",
        type: "student_loan",
        currency: "USD",
        isLiability: true,
        isManual: true,
      },
      {
        id: foreignAccountId,
        householdId: outsider.householdId,
        ownerUserId: outsider.userId,
        name: "Outside checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isManual: true,
      },
    ]);
  });

  afterEach(() => application.close());

  function request(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    requestAuth = auth,
  ) {
    return application.app.request(`http://localhost${path}`, {
      method,
      headers: {
        cookie: `bw_session=${requestAuth.sessionToken}; bw_household=${requestAuth.householdId}; bw_csrf=${requestAuth.csrfToken}`,
        origin: config.WEB_ORIGIN,
        "x-csrf-token": requestAuth.csrfToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createGoal(
    overrides: Record<string, unknown> = {},
    requestAuth = auth,
  ): Promise<GoalResponse> {
    const response = await request(
      "/api/v1/goals",
      {
        name: "Emergency fund",
        type: "emergency_fund",
        target: { minorUnits: "100000", currency: "USD" },
        funded: { minorUnits: "0", currency: "USD" },
        monthlyContribution: { minorUnits: "10000", currency: "USD" },
        priority: 1,
        paused: false,
        fundingAccountId: requestAuth === foreignAuth ? foreignAccountId : cashAccountId,
        ...overrides,
      },
      "POST",
      requestAuth,
    );
    expect(response.status).toBe(201);
    return response.json() as Promise<GoalResponse>;
  }

  async function seedComfortablePurchaseInputs(
    minimumBufferMinorUnits: string,
    targetLiquidNetWorthMinorUnits = "20000000",
  ) {
    const now = new Date();
    const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))
      .toISOString()
      .slice(0, 10);
    const wealthMonth = addMonths(start.slice(0, 7), 96);
    const [wealthYear, wealthMonthNumber] = wealthMonth.split("-");
    await application.db
      .update(users)
      .set({
        birthDate: `${Number(wealthYear) - 30}-${wealthMonthNumber}-01`,
        targetAge: 30,
      })
      .where(eq(users.id, userId));
    await application.db.insert(settings).values({
      id: ulid(),
      householdId: auth.householdId,
      userId: null,
      scopeKey: "household",
      key: "planning.safe_to_spend",
      value: {
        minimumBufferMinorUnits,
        targetLiquidNetWorthMinorUnits,
      },
      isSecret: false,
    });
    const asOf = new Date().toISOString();
    await application.db.insert(balanceSnapshots).values([
      {
        id: ulid(),
        householdId: auth.householdId,
        accountId: cashAccountId,
        ledgerBalance: 400_000n,
        currentBalance: 400_000n,
        availableBalance: 400_000n,
        currency: "USD",
        asOf,
        source: "manual",
      },
      {
        id: ulid(),
        householdId: auth.householdId,
        accountId: debtAccountId,
        ledgerBalance: 0n,
        currentBalance: 0n,
        availableBalance: null,
        currency: "USD",
        asOf,
        source: "manual",
      },
    ]);
    const envelopeId = ulid();
    const budgetPeriodId = ulid();
    await application.db.insert(incomeSources).values({
      id: ulid(),
      householdId: auth.householdId,
      name: "Confirmed paycheck",
      cadence: "monthly",
      typicalAmount: 400_000n,
      currency: "USD",
      nextExpectedDate: end,
      isActive: true,
    });
    await application.db.insert(envelopes).values({
      id: envelopeId,
      householdId: auth.householdId,
      name: "Required housing",
      cadence: "monthly",
      targetAmount: 100_000n,
      minimumAmount: 100_000n,
      currency: "USD",
      isRequired: true,
      isActive: true,
    });
    await application.db.insert(bills).values({
      id: ulid(),
      householdId: auth.householdId,
      name: "Required housing",
      envelopeId,
      dueRule: { cadence: "monthly" },
      amountMin: 100_000n,
      amountMax: 100_000n,
      currency: "USD",
      isRequired: true,
      isActive: true,
    });
    await application.db.insert(budgetPeriods).values({
      id: budgetPeriodId,
      householdId: auth.householdId,
      kind: "month",
      startsOn: start,
      endsOn: end,
      currency: "USD",
      expectedIncome: 400_000n,
      actualIncome: 0n,
      status: "open",
    });
    await application.db.insert(envelopeAllocations).values({
      id: ulid(),
      householdId: auth.householdId,
      budgetPeriodId,
      envelopeId,
      planned: 100_000n,
      currency: "USD",
    });
    return { budgetPeriodId, envelopeId };
  }

  test("fails closed when comfortable-purchase inputs are incomplete", async () => {
    const purchase = await createGoal({
      name: "Used car in cash",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
    });

    expect(purchase.comfortablePurchase).toMatchObject({
      status: "incomplete",
      comfortable: null,
      comfortableMonth: null,
      controllingConstraint: "incompleteInputs",
    });
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Confirm a protected minimum cash buffer",
    );
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Sync or enter current spendable account balances",
    );
  });

  test("keeps funding projection separate and delays a funded purchase until guardrails recover", async () => {
    await seedComfortablePurchaseInputs("200000");
    await createGoal({
      name: "Emergency reserve",
      type: "emergency_fund",
      target: { minorUnits: "300000", currency: "USD" },
      funded: { minorUnits: "200000", currency: "USD" },
      monthlyContribution: { minorUnits: "50000", currency: "USD" },
      priority: 1,
    });
    const purchase = await createGoal({
      name: "Used car in cash",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.projectedDate).toBe(`${new Date().toISOString().slice(0, 7)}-01`);
    expect(purchase.comfortablePurchase).toMatchObject({
      status: "comfortable",
      comfortable: true,
      comfortableMonth: addMonths(new Date().toISOString().slice(0, 7), 1),
      monthsUntilPurchase: 1,
      controllingConstraint: "checkingBuffer",
      missingInputs: [],
      inputs: {
        protectedMinimumBuffer: { minorUnits: "200000", currency: "USD" },
        requiredMonthlyBills: { minorUnits: "100000", currency: "USD" },
        higherPriorityMonthlyFunding: { minorUnits: "50000", currency: "USD" },
        monthlySurplus: { minorUnits: "300000", currency: "USD" },
        monthlySurplusSource: "explicit_budget",
        currentLiquidNetWorth: { minorUnits: "400000", currency: "USD" },
        targetLiquidNetWorth: { minorUnits: "20000000", currency: "USD" },
      },
    });
    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toEqual([
      "checkingBuffer",
    ]);
  });

  test("grows the protected reserve and stops its transfer at target", async () => {
    await seedComfortablePurchaseInputs("300000");
    await createGoal({
      name: "Emergency reserve",
      type: "emergency_fund",
      target: { minorUnits: "300000", currency: "USD" },
      funded: { minorUnits: "200000", currency: "USD" },
      monthlyContribution: { minorUnits: "50000", currency: "USD" },
      priority: 1,
    });
    const purchase = await createGoal({
      name: "Used car in cash",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase).toMatchObject({
      status: "comfortable",
      comfortable: true,
      comfortableMonth: addMonths(new Date().toISOString().slice(0, 7), 2),
      monthsUntilPurchase: 2,
      controllingConstraint: "emergencyFloor",
      missingInputs: [],
    });
    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toEqual([
      "emergencyFloor",
    ]);
  });

  test("delays purchase comfort until the conservative age-30 wealth target recovers", async () => {
    await seedComfortablePurchaseInputs("200000", "29200000");
    await createGoal({
      name: "Emergency reserve",
      type: "emergency_fund",
      target: { minorUnits: "300000", currency: "USD" },
      funded: { minorUnits: "200000", currency: "USD" },
      monthlyContribution: { minorUnits: "50000", currency: "USD" },
      priority: 1,
    });
    const purchase = await createGoal({
      name: "Used car in cash",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });
    const targetMonth = addMonths(new Date().toISOString().slice(0, 7), 96);

    expect(purchase.comfortablePurchase).toMatchObject({
      status: "comfortable",
      comfortable: true,
      comfortableMonth: addMonths(targetMonth, 1),
      monthsUntilPurchase: 97,
      controllingConstraint: "targetNetWorth",
      inputs: {
        targetLiquidNetWorth: { minorUnits: "29200000", currency: "USD" },
        targetWealthDate: `${targetMonth}-01`,
        projectedLiquidNetWorthAtTarget: {
          minorUnits: "29200000",
          currency: "USD",
        },
      },
    });
    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toEqual([
      "targetNetWorth",
    ]);
  });

  test("fails closed when the age-30 target cannot survive the full purchase write-off", async () => {
    await seedComfortablePurchaseInputs("200000", "50000000");
    await createGoal({
      name: "Emergency reserve",
      type: "emergency_fund",
      target: { minorUnits: "300000", currency: "USD" },
      funded: { minorUnits: "200000", currency: "USD" },
      monthlyContribution: { minorUnits: "50000", currency: "USD" },
      priority: 1,
    });
    const purchase = await createGoal({
      name: "Used car in cash",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase).toMatchObject({
      status: "not_comfortable",
      comfortable: false,
      comfortableMonth: null,
      controllingConstraint: "horizon",
    });
    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toEqual([
      "targetNetWorth",
      "horizon",
    ]);
  });

  test("honors an explicit spendable-account selection instead of falling back to every cash account", async () => {
    await seedComfortablePurchaseInputs("200000");
    const savingsAccountId = ulid();
    await application.db.insert(accounts).values({
      id: savingsAccountId,
      householdId: auth.householdId,
      ownerUserId: userId,
      name: "Selected cash",
      group: "cash",
      type: "savings",
      currency: "USD",
      isManual: true,
    });
    await application.db.insert(balanceSnapshots).values({
      id: ulid(),
      householdId: auth.householdId,
      accountId: savingsAccountId,
      ledgerBalance: 50_000n,
      currentBalance: 50_000n,
      availableBalance: 50_000n,
      currency: "USD",
      asOf: new Date().toISOString(),
      source: "manual",
    });
    await application.db
      .update(settings)
      .set({
        value: {
          spendableAccountIds: [savingsAccountId],
          minimumBufferMinorUnits: "200000",
          targetLiquidNetWorthMinorUnits: "20000000",
        },
      })
      .where(eq(settings.key, "planning.safe_to_spend"));

    const purchase = await createGoal({
      name: "Selected-account purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.inputs.spendableLiquidity).toEqual({
      minorUnits: "50000",
      currency: "USD",
    });
  });

  test("fails closed for an invalid configured spendable account", async () => {
    await seedComfortablePurchaseInputs("200000");
    await application.db
      .update(settings)
      .set({
        value: {
          spendableAccountIds: ["missing-account"],
          minimumBufferMinorUnits: "200000",
          targetLiquidNetWorthMinorUnits: "20000000",
        },
      })
      .where(eq(settings.key, "planning.safe_to_spend"));

    const purchase = await createGoal({
      name: "Invalid selection purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.status).toBe("incomplete");
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Review the configured spendable-account selection",
    );
  });

  test("requires a fresh snapshot for every account included in liquid net worth", async () => {
    await seedComfortablePurchaseInputs("200000");
    await application.db
      .update(balanceSnapshots)
      .set({ asOf: "2020-01-01T00:00:00.000Z" })
      .where(eq(balanceSnapshots.accountId, debtAccountId));

    const purchase = await createGoal({
      name: "Fresh-data purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.status).toBe("incomplete");
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Refresh liquid net-worth balances older than seven days",
    );
  });

  test("caps purchase savings at fresh funding-account capacity after higher-priority claims", async () => {
    await seedComfortablePurchaseInputs("200000");
    await createGoal({
      name: "Emergency reserve",
      type: "emergency_fund",
      target: { minorUnits: "200000", currency: "USD" },
      funded: { minorUnits: "200000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 1,
    });
    const purchase = await createGoal({
      name: "Over-recorded purchase savings",
      type: "purchase",
      target: { minorUnits: "300000", currency: "USD" },
      funded: { minorUnits: "300000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.inputs.fundingAccountBalance).toEqual({
      minorUnits: "400000",
      currency: "USD",
    });
    expect(purchase.comfortablePurchase?.inputs.verifiedPurchaseSavings).toEqual({
      minorUnits: "200000",
      currency: "USD",
    });
    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toContain(
      "purchaseFunding",
    );
  });

  test("requires a liquid funding account before modeling purchase comfort", async () => {
    await seedComfortablePurchaseInputs("200000");
    const purchase = await createGoal({
      name: "Unlinked purchase savings",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      fundingAccountId: null,
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.status).toBe("incomplete");
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Link a liquid funding account to this purchase goal",
    );
  });

  test("blocks an unfinished higher-priority goal with no contribution pace", async () => {
    await seedComfortablePurchaseInputs("200000");
    await createGoal({
      name: "Higher priority without a pace",
      type: "custom",
      target: { minorUnits: "1000000", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 1,
    });
    const purchase = await createGoal({
      name: "Lower-priority purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toEqual([
      "higherPriorityGoals",
      "horizon",
    ]);
  });

  test("keeps under-reserved required bill maximums blocking and out of surplus", async () => {
    const { budgetPeriodId } = await seedComfortablePurchaseInputs("200000");
    await application.db
      .update(envelopeAllocations)
      .set({ planned: 50_000n })
      .where(eq(envelopeAllocations.budgetPeriodId, budgetPeriodId));
    const purchase = await createGoal({
      name: "Under-reserved purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.inputs.requiredObligationShortfall).toEqual({
      minorUnits: "50000",
      currency: "USD",
    });
    expect(purchase.comfortablePurchase?.inputs.monthlySurplus).toEqual({
      minorUnits: "300000",
      currency: "USD",
    });
    expect(purchase.comfortablePurchase?.limitingConstraints.map(({ code }) => code)).toEqual([
      "requiredObligations",
      "horizon",
    ]);
    expect(
      purchase.comfortablePurchase?.limitingConstraints.find(
        ({ code }) => code === "requiredObligations",
      )?.detail,
    ).toBe("One or more required bill maximums are not fully represented in the current budget.");
  });

  test("does not trust an explicit budget whose income is unbacked", async () => {
    await seedComfortablePurchaseInputs("200000");
    await application.db
      .delete(incomeSources)
      .where(eq(incomeSources.householdId, auth.householdId));
    const purchase = await createGoal({
      name: "Unbacked-budget purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.status).toBe("incomplete");
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Back the monthly budget income with an active income source or actual income",
    );
  });

  test("rejects an observed fallback with only one old transaction and no fresh endpoint", async () => {
    await seedComfortablePurchaseInputs("200000");
    await application.db
      .delete(budgetPeriods)
      .where(eq(budgetPeriods.householdId, auth.householdId));
    await application.db
      .delete(incomeSources)
      .where(eq(incomeSources.householdId, auth.householdId));
    const oldDate = new Date(Date.now() - 70 * 86_400_000).toISOString().slice(0, 10);
    await application.db.insert(transactions).values({
      id: ulid(),
      householdId: auth.householdId,
      accountId: cashAccountId,
      amount: 400_000n,
      currency: "USD",
      transactedOn: oldDate,
      rawDescription: "Old paycheck",
      normalizedDescription: "old paycheck",
      status: "posted",
      source: "fixture",
      isIncome: true,
    });
    const purchase = await createGoal({
      name: "Thin-history purchase",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "100000", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
      priority: 2,
    });

    expect(purchase.comfortablePurchase?.status).toBe("incomplete");
    expect(purchase.comfortablePurchase?.missingInputs).toContain(
      "Create a backed monthly budget or import a fresh, continuous 60-day cash-flow history",
    );
  });

  test("derives exact pace, links valid accounts, and reorders goals atomically", async () => {
    const startMonth = new Date().toISOString().slice(0, 7);
    const targetMonth = addMonths(startMonth, 10);
    const emergency = await createGoal({ priority: 1 });
    const debt = await createGoal({
      name: "Student debt free",
      type: "debt_payoff",
      target: { minorUnits: "100000", currency: "USD" },
      funded: { minorUnits: "12345", currency: "USD" },
      monthlyContribution: { minorUnits: "10000", currency: "USD" },
      targetDate: `${targetMonth}-01`,
      fundingAccountId: cashAccountId,
      linkedDebtAccountId: debtAccountId,
      priority: 2,
    });

    expect(debt.remaining.minorUnits).toBe("87655");
    expect(debt.requiredMonthlyContribution?.minorUnits).toBe("8766");
    expect(debt.monthlyShortfall.minorUnits).toBe("0");
    expect(debt.monthsToGoal).toBe(9);
    expect(debt.projectedDate).toBe(`${addMonths(startMonth, 9)}-01`);
    expect(debt.onTrack).toBe(true);
    expect(debt.fundingAccountId).toBe(cashAccountId);
    expect(debt.linkedDebtAccountId).toBe(debtAccountId);

    const reorder = await request(
      "/api/v1/goals/order",
      { goalIds: [debt.id, emergency.id] },
      "PUT",
    );
    expect(reorder.status).toBe(200);
    const ordered = (await reorder.json()) as { data: Array<{ id: string; priority: number }> };
    expect(ordered.data.map((goal) => goal.id)).toEqual([debt.id, emergency.id]);
    expect(ordered.data.map((goal) => goal.priority)).toEqual([1, 2]);

    const duplicate = await request("/api/v1/goals/order", { goalIds: [debt.id, debt.id] }, "PUT");
    expect(duplicate.status).toBe(422);
    expect(await duplicate.json()).toHaveProperty("error.code", "validation_failed");

    const foreignGoal = await createGoal({ name: "Outside goal" }, foreignAuth);
    const crossHousehold = await request(
      "/api/v1/goals/order",
      { goalIds: [foreignGoal.id, debt.id] },
      "PUT",
    );
    expect(crossHousehold.status).toBe(404);
    const stillOrdered = (await (await request("/api/v1/goals")).json()) as {
      data: Array<{ id: string }>;
    };
    expect(stillOrdered.data.slice(0, 2).map((goal) => goal.id)).toEqual([debt.id, emergency.id]);
  });

  test("validates patch references and supports clearing optional planning fields", async () => {
    const goal = await createGoal({
      name: "Debt payoff",
      type: "debt_payoff",
      funded: { minorUnits: "25000", currency: "USD" },
      targetDate: "2028-12-31",
      fundingAccountId: cashAccountId,
      linkedDebtAccountId: debtAccountId,
    });

    const foreignAccount = await request(
      `/api/v1/goals/${goal.id}`,
      { fundingAccountId: foreignAccountId },
      "PATCH",
    );
    expect(foreignAccount.status).toBe(404);

    const nonDebt = await request(
      `/api/v1/goals/${goal.id}`,
      { linkedDebtAccountId: cashAccountId },
      "PATCH",
    );
    expect(nonDebt.status).toBe(409);
    expect(await nonDebt.json()).toHaveProperty("error.code", "invalid_debt_account");

    const wrongGoalType = await request(`/api/v1/goals/${goal.id}`, { type: "purchase" }, "PATCH");
    expect(wrongGoalType.status).toBe(409);
    expect(await wrongGoalType.json()).toHaveProperty(
      "error.code",
      "linked_debt_requires_payoff_goal",
    );

    const currencyChange = await request(
      `/api/v1/goals/${goal.id}`,
      { target: { minorUnits: "100000", currency: "EUR" } },
      "PATCH",
    );
    expect(currencyChange.status).toBe(409);
    expect(await currencyChange.json()).toHaveProperty("error.code", "currency_mismatch");

    const belowFunding = await request(
      `/api/v1/goals/${goal.id}`,
      { target: { minorUnits: "24999", currency: "USD" } },
      "PATCH",
    );
    expect(belowFunding.status).toBe(409);
    expect(await belowFunding.json()).toHaveProperty("error.code", "goal_funding_exceeds_target");

    const prematureCompletion = await request(
      `/api/v1/goals/${goal.id}`,
      { status: "completed" },
      "PATCH",
    );
    expect(prematureCompletion.status).toBe(409);
    expect(await prematureCompletion.json()).toHaveProperty("error.code", "goal_not_funded");

    const cleared = await request(
      `/api/v1/goals/${goal.id}`,
      {
        targetDate: null,
        fundingAccountId: null,
        linkedDebtAccountId: null,
        monthlyContribution: { minorUnits: "12500", currency: "USD" },
      },
      "PATCH",
    );
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({
      targetDate: null,
      fundingAccountId: null,
      linkedDebtAccountId: null,
      monthlyContribution: { minorUnits: "12500", currency: "USD" },
    });

    const negative = await request(
      `/api/v1/goals/${goal.id}`,
      { monthlyContribution: { minorUnits: "-1", currency: "USD" } },
      "PATCH",
    );
    expect(negative.status).toBe(422);
  });

  test("records exact contributions, prevents overfunding, and enforces lifecycle state", async () => {
    const goal = await createGoal({
      name: "Laptop without debt",
      type: "purchase",
      target: { minorUnits: "10000", currency: "USD" },
      funded: { minorUnits: "2000", currency: "USD" },
      monthlyContribution: { minorUnits: "1000", currency: "USD" },
    });

    const tooMuch = await request(`/api/v1/goals/${goal.id}/contributions`, {
      amount: { minorUnits: "8001", currency: "USD" },
      source: "unassigned",
    });
    expect(tooMuch.status).toBe(409);
    expect(await tooMuch.json()).toHaveProperty("error.code", "contribution_exceeds_remaining");

    const contribution = await request(`/api/v1/goals/${goal.id}/contributions`, {
      amount: { minorUnits: "8000", currency: "USD" },
      contributedOn: "2026-07-16",
      note: "Paycheck surplus",
      source: "unassigned",
    });
    expect(contribution.status).toBe(201);
    expect(await contribution.json()).toMatchObject({
      amount: { minorUnits: "8000", currency: "USD" },
      contributedOn: "2026-07-16",
      goal: {
        funded: { minorUnits: "10000", currency: "USD" },
        remaining: { minorUnits: "0", currency: "USD" },
        status: "completed",
      },
    });

    const contributions = await request(`/api/v1/goals/${goal.id}/contributions`);
    expect(contributions.status).toBe(200);
    expect(await contributions.json()).toMatchObject({
      data: [
        {
          goalId: goal.id,
          amount: { minorUnits: "8000", currency: "USD" },
          contributedOn: "2026-07-16",
          note: "Paycheck surplus",
        },
      ],
    });

    const afterCompletion = await request(`/api/v1/goals/${goal.id}/contributions`, {
      amount: { minorUnits: "1", currency: "USD" },
    });
    expect(afterCompletion.status).toBe(409);
    expect(await afterCompletion.json()).toHaveProperty("error.code", "goal_already_funded");

    const reopened = await request(
      `/api/v1/goals/${goal.id}`,
      { target: { minorUnits: "20000", currency: "USD" } },
      "PATCH",
    );
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({
      status: "active",
      funded: { minorUnits: "10000", currency: "USD" },
      remaining: { minorUnits: "10000", currency: "USD" },
    });

    const archived = await request(`/api/v1/goals/${goal.id}`, undefined, "DELETE");
    expect(archived.status).toBe(204);
    const archivedContribution = await request(`/api/v1/goals/${goal.id}/contributions`, {
      amount: { minorUnits: "100", currency: "USD" },
    });
    expect(archivedContribution.status).toBe(409);
    expect(await archivedContribution.json()).toHaveProperty("error.code", "goal_archived");

    const overfundedCreate = await request("/api/v1/goals", {
      name: "Impossible state",
      type: "custom",
      target: { minorUnits: "100", currency: "USD" },
      funded: { minorUnits: "101", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
    });
    expect(overfundedCreate.status).toBe(409);
    expect(await overfundedCreate.json()).toHaveProperty(
      "error.code",
      "goal_funding_exceeds_target",
    );

    const fullyFunded = await createGoal({
      name: "Already there",
      target: { minorUnits: "100", currency: "USD" },
      funded: { minorUnits: "100", currency: "USD" },
      monthlyContribution: { minorUnits: "0", currency: "USD" },
    });
    expect(fullyFunded.status).toBe("completed");
    expect(fullyFunded.remaining.minorUnits).toBe("0");
  });
});
