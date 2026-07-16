import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { accounts } from "@betterwealth/db/schema";
import { addMonths } from "@betterwealth/shared";
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
};

describe("goal planning API", () => {
  let application: BetterWealthApplication;
  let config: AppConfig;
  let auth: Auth;
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
        ...overrides,
      },
      "POST",
      requestAuth,
    );
    expect(response.status).toBe(201);
    return response.json() as Promise<GoalResponse>;
  }

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
