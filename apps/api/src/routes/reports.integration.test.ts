import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { balanceSnapshots } from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";

function config(databasePath: string) {
  return loadConfig({
    APP_ENV: "test",
    WEB_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databasePath,
    ENCRYPTION_KEY: "b".repeat(64),
    COOKIE_SECURE: "false",
    REGISTRATION_MODE: "open",
    LOG_LEVEL: "error",
  });
}

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .join("; ");
}

function cookieValue(header: string, name: string) {
  return header
    .split("; ")
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function dateOffset(days: number) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

describe("dashboard planning truth", () => {
  let directory: string;
  let application: BetterWealthApplication;
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-reports-"));
    application = createApp(config(join(directory, "test.sqlite")));
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "new-user@example.test",
        password: "BuildWealthByThirty!",
        householdName: "My plan",
      }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "new-user@example.test",
        password: "BuildWealthByThirty!",
      }),
    });
    cookie = cookies(login);
    csrf = cookieValue(cookie, "bw_csrf") ?? "";
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function request(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    return application.app.request(`/api/v1${path}`, {
      method,
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "x-csrf-token": csrf,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  test("requires explicit target and buffer preferences instead of inventing age-30 completion", async () => {
    const initialPreferences = await request("/reports/dashboard/preferences");
    expect(initialPreferences.status).toBe(200);
    expect(await initialPreferences.json()).toEqual({
      currency: "USD",
      minimumBuffer: null,
      targetLiquidNetWorth: null,
      reservedBills: null,
    });

    const initialDashboard = await request("/reports/dashboard");
    expect(initialDashboard.status).toBe(200);
    expect(await initialDashboard.json()).toMatchObject({
      targetAge: null,
      targetLiquidNetWorth: { minorUnits: "0", currency: "USD" },
      projectionSource: "current_balance",
      trust: {
        state: "incomplete",
        missingInputs: expect.arrayContaining([
          "Connect or add at least one account",
          "Confirm a paycheck or recurring income source",
          "Add your birth date for an exact age-30 horizon",
          "Choose a target age",
          "Set a liquid wealth target",
          "Confirm a minimum cash buffer",
        ]),
      },
    });
  });

  test("persists exact preferences and derives readiness and goal reserves from real records", async () => {
    const withoutCsrf = await application.app.request("/api/v1/reports/dashboard/preferences", {
      method: "PATCH",
      headers: {
        cookie,
        origin: "http://localhost:5173",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        minimumBuffer: { minorUnits: "100000", currency: "USD" },
      }),
    });
    expect(withoutCsrf.status).toBe(403);

    const mismatch = await request(
      "/reports/dashboard/preferences",
      { minimumBuffer: { minorUnits: "100000", currency: "EUR" } },
      "PATCH",
    );
    expect(mismatch.status).toBe(409);

    const emptyTarget = await request(
      "/reports/dashboard/preferences",
      { targetLiquidNetWorth: { minorUnits: "0", currency: "USD" } },
      "PATCH",
    );
    expect(emptyTarget.status).toBe(422);

    const preferences = await request(
      "/reports/dashboard/preferences",
      {
        minimumBuffer: { minorUnits: "100000", currency: "USD" },
        targetLiquidNetWorth: { minorUnits: "100000000", currency: "USD" },
        reservedBills: { minorUnits: "0", currency: "USD" },
      },
      "PATCH",
    );
    expect(preferences.status).toBe(200);

    await request("/profile", { birthDate: dateOffset(-22 * 365), targetAge: 30 }, "PATCH");
    await request("/accounts", {
      name: "Everyday checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      balanceMinorUnits: "500000",
      includeInBudget: true,
    });
    await request("/income-sources", {
      name: "Primary paycheck estimate",
      cadence: "biweekly",
      typicalAmount: { minorUnits: "200000", currency: "USD" },
      nextExpectedDate: dateOffset(14),
      isActive: true,
    });
    await request("/goals", {
      name: "Emergency fund",
      type: "emergency_fund",
      target: { minorUnits: "1000000", currency: "USD" },
      funded: { minorUnits: "0", currency: "USD" },
      monthlyContribution: { minorUnits: "52000", currency: "USD" },
      priority: 1,
    });

    const dashboard = await request("/reports/dashboard");
    expect(dashboard.status).toBe(200);
    const body = (await dashboard.json()) as {
      availableCash: { minorUnits: string };
      reservedBills: { minorUnits: string };
      envelopeCommitments: { minorUnits: string };
      goalContributions: { minorUnits: string };
      minimumBuffer: { minorUnits: string };
      safeToSpend: { minorUnits: string };
      coveredThroughSource: string;
      targetAge: number;
      targetLiquidNetWorth: { minorUnits: string };
      trust: { missingInputs: string[] };
    };
    expect(body.coveredThroughSource).toBe("income_source");
    expect(body.targetAge).toBe(30);
    expect(body.targetLiquidNetWorth.minorUnits).toBe("100000000");
    expect(BigInt(body.goalContributions.minorUnits)).toBeGreaterThan(0n);
    expect(BigInt(body.safeToSpend.minorUnits)).toBe(
      BigInt(body.availableCash.minorUnits) -
        BigInt(body.reservedBills.minorUnits) -
        BigInt(body.envelopeCommitments.minorUnits) -
        BigInt(body.goalContributions.minorUnits) -
        BigInt(body.minimumBuffer.minorUnits),
    );
    expect(body.trust.missingInputs).not.toContain("Confirm a paycheck or recurring income source");
    expect(body.trust.missingInputs).not.toContain("Confirm upcoming bills and due dates");
    expect(body.trust.missingInputs).not.toContain("Confirm a minimum cash buffer");
    expect(body.trust.missingInputs).not.toContain("Set a liquid wealth target");
    expect(body.trust.missingInputs).toContain(
      "Create or fund an envelope budget for this pay period",
    );
  });

  test("starts net-worth history only after every included account has balance coverage", async () => {
    const firstResponse = await request("/accounts", {
      name: "First checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      balanceMinorUnits: "100000",
      includeInBudget: true,
    });
    const secondResponse = await request("/accounts", {
      name: "Second checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      balanceMinorUnits: "200000",
      includeInBudget: true,
    });
    const first = (await firstResponse.json()) as { id: string };
    const second = (await secondResponse.json()) as { id: string };
    await application.db
      .update(balanceSnapshots)
      .set({ asOf: `${dateOffset(-10)}T12:00:00.000Z` })
      .where(eq(balanceSnapshots.accountId, first.id));
    await application.db
      .update(balanceSnapshots)
      .set({ asOf: `${dateOffset(-1)}T12:00:00.000Z` })
      .where(eq(balanceSnapshots.accountId, second.id));

    const response = await request("/reports/net-worth?range=All");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total: { minorUnits: string };
      series: Array<{
        date: string;
        total: { minorUnits: string; currency: string };
        liquid: { minorUnits: string; currency: string };
        investable: { minorUnits: string; currency: string };
        retirement: { minorUnits: string; currency: string };
        assets: { minorUnits: string; currency: string };
        debts: { minorUnits: string; currency: string };
      }>;
    };
    expect(body.total.minorUnits).toBe("300000");
    expect(body.series).toEqual([
      {
        date: dateOffset(-1),
        total: { minorUnits: "300000", currency: "USD" },
        liquid: { minorUnits: "300000", currency: "USD" },
        investable: { minorUnits: "0", currency: "USD" },
        retirement: { minorUnits: "0", currency: "USD" },
        assets: { minorUnits: "300000", currency: "USD" },
        debts: { minorUnits: "0", currency: "USD" },
      },
    ]);
  });

  test("excludes hidden and closed balances while preserving recoverable inclusion settings", async () => {
    const createAccount = async (name: string, balanceMinorUnits: string) => {
      const response = await request("/accounts", {
        name,
        group: "cash",
        type: "checking",
        currency: "USD",
        balanceMinorUnits,
        includeInBudget: true,
      });
      expect(response.status).toBe(201);
      return (await response.json()) as { id: string };
    };
    const active = await createAccount("Active checking", "100000");
    const hidden = await createAccount("Hidden vault", "900000");
    const closed = await createAccount("Closed checking", "700000");

    expect((await request(`/accounts/${hidden.id}`, { status: "hidden" }, "PATCH")).status).toBe(
      200,
    );
    expect((await request(`/accounts/${closed.id}`, { status: "closed" }, "PATCH")).status).toBe(
      200,
    );

    const dashboard = (await (await request("/reports/dashboard")).json()) as {
      availableCash: { minorUnits: string };
    };
    expect(dashboard.availableCash.minorUnits).toBe("100000");
    const netWorth = (await (await request("/reports/net-worth?range=All")).json()) as {
      total: { minorUnits: string };
      assets: { minorUnits: string };
    };
    expect(netWorth.total.minorUnits).toBe("100000");
    expect(netWorth.assets.minorUnits).toBe("100000");

    const accountList = (await (await request("/accounts")).json()) as {
      data: Array<{
        id: string;
        status: string;
        includeInBudget: boolean;
        includeInNetWorth: boolean;
      }>;
    };
    expect(accountList.data.find(({ id }) => id === hidden.id)).toMatchObject({
      status: "hidden",
      includeInBudget: true,
      includeInNetWorth: true,
    });
    expect(accountList.data.find(({ id }) => id === closed.id)).toMatchObject({
      status: "closed",
      includeInBudget: true,
      includeInNetWorth: true,
    });

    expect((await request(`/accounts/${hidden.id}`, { status: "active" }, "PATCH")).status).toBe(
      200,
    );
    const reopenedDashboard = (await (await request("/reports/dashboard")).json()) as {
      availableCash: { minorUnits: string };
    };
    expect(reopenedDashboard.availableCash.minorUnits).toBe("1000000");
    const reopenedNetWorth = (await (await request("/reports/net-worth?range=All")).json()) as {
      total: { minorUnits: string };
    };
    expect(reopenedNetWorth.total.minorUnits).toBe("1000000");

    const activeRecord = accountList.data.find(({ id }) => id === active.id);
    expect(activeRecord).toMatchObject({ status: "active" });
  });

  test("does not treat an expense-category credit as a refund before confirmation", async () => {
    const accountResponse = await request("/accounts", {
      name: "Refund safety checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      balanceMinorUnits: "100000",
      includeInBudget: true,
    });
    const account = (await accountResponse.json()) as { id: string };
    const categoryResponse = await request("/categories", {
      name: "Refund safety groceries",
      kind: "expense",
    });
    const category = (await categoryResponse.json()) as { id: string };
    const secondCategoryResponse = await request("/categories", {
      name: "Refund safety home",
      kind: "expense",
    });
    const secondCategory = (await secondCategoryResponse.json()) as { id: string };
    const effectiveDate = new Date().toISOString();
    const purchaseResponse = await request("/transactions", {
      accountId: account.id,
      amountMinorUnits: "-10000",
      currency: "USD",
      effectiveDate,
      description: "Refund safety purchase",
      categoryId: category.id,
    });
    const purchase = (await purchaseResponse.json()) as { id: string };
    const secondPurchaseResponse = await request("/transactions", {
      accountId: account.id,
      amountMinorUnits: "-5000",
      currency: "USD",
      effectiveDate,
      description: "Refund safety second purchase",
      categoryId: secondCategory.id,
    });
    const secondPurchase = (await secondPurchaseResponse.json()) as { id: string };
    const creditResponse = await request("/transactions", {
      accountId: account.id,
      amountMinorUnits: "10000",
      currency: "USD",
      effectiveDate,
      description: "Refund safety credit",
      categoryId: category.id,
    });
    const credit = (await creditResponse.json()) as { id: string };

    const beforeSpending = (await (await request("/reports/spending")).json()) as {
      categories: Array<{ category: string; amount: { minorUnits: string } }>;
    };
    expect(
      beforeSpending.categories.find(({ category: name }) => name === "Refund safety groceries")
        ?.amount.minorUnits,
    ).toBe("10000");
    const beforeCashFlow = (await (await request("/reports/cash-flow")).json()) as {
      months: Array<{ month: string; expenses: { minorUnits: string } }>;
    };
    expect(beforeCashFlow.months.at(-1)?.expenses.minorUnits).toBe("15000");

    const confirmation = await request("/refund-links", {
      refundTransactionId: credit.id,
      purchaseTransactionId: purchase.id,
      amountMinorUnits: "2500",
    });
    expect(confirmation.status).toBe(201);
    const secondConfirmation = await request("/refund-links", {
      refundTransactionId: credit.id,
      purchaseTransactionId: secondPurchase.id,
      amountMinorUnits: "5000",
    });
    expect(secondConfirmation.status).toBe(201);
    const afterSpending = (await (await request("/reports/spending")).json()) as {
      categories: Array<{ category: string; amount: { minorUnits: string } }>;
    };
    expect(
      afterSpending.categories.find(({ category: name }) => name === "Refund safety groceries")
        ?.amount.minorUnits,
    ).toBe("7500");
    expect(
      afterSpending.categories.find(({ category: name }) => name === "Refund safety home"),
    ).toBeUndefined();
    const afterCashFlow = (await (await request("/reports/cash-flow")).json()) as {
      months: Array<{ month: string; expenses: { minorUnits: string } }>;
    };
    expect(afterCashFlow.months.at(-1)?.expenses.minorUnits).toBe("7500");
  });

  test("buckets cash flow by the household timezone and validates the timezone", async () => {
    const zoneChange = await request("/profile", { timezone: "America/New_York" }, "PATCH");
    expect(zoneChange.status).toBe(200);
    const badZone = await request("/profile", { timezone: "Not/AZone" }, "PATCH");
    expect(badZone.status).toBe(422);

    const accountResponse = await request("/accounts", {
      name: "Timezone checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      balanceMinorUnits: "100000",
      includeInBudget: true,
    });
    const account = (await accountResponse.json()) as { id: string };

    // 2026-08-01T02:00:00Z is still July 31 local time in New York.
    const julyLocal = await request("/transactions", {
      accountId: account.id,
      amountMinorUnits: "-7000",
      currency: "USD",
      effectiveDate: "2026-08-01T02:00:00.000Z",
      description: "Late July in New York",
    });
    expect(julyLocal.status).toBe(201);
    const augustEverywhere = await request("/transactions", {
      accountId: account.id,
      amountMinorUnits: "-3000",
      currency: "USD",
      effectiveDate: "2026-08-01T12:00:00.000Z",
      description: "August everywhere",
    });
    expect(augustEverywhere.status).toBe(201);

    const cashFlow = (await (await request("/reports/cash-flow")).json()) as {
      months: Array<{ month: string; expenses: { minorUnits: string } }>;
    };
    const july = cashFlow.months.find(({ month }) => month === "2026-07");
    const august = cashFlow.months.find(({ month }) => month === "2026-08");
    expect(july?.expenses.minorUnits).toBe("7000");
    expect(august?.expenses.minorUnits).toBe("3000");
  });
});
