import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BetterWealthApplication } from "./app";
import { createApp } from "./app";
import { loadConfig } from "./config";

function cookieJar(response: Response): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";", 1);
    const separator = pair?.indexOf("=") ?? -1;
    if (pair && separator > 0) result[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return result;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

/**
 * Tenant-isolation sweep: one household must never observe another's data,
 * whether through list endpoints, direct id access, or search. This is the
 * structural guarantee the repository layer exists to make easy — the test
 * fails loudly if any route forgets a household predicate (A1-4).
 */
describe("tenant isolation", () => {
  let directory: string;
  let application: BetterWealthApplication;
  let householdBHeaders: Record<string, string>;
  let householdAHeaders: Record<string, string>;
  let householdBAccountId: string;
  let householdBTransactionId: string;
  let householdBCategoryId: string;
  let householdBGoalId: string;

  async function registerAndLogin(email: string, householdName: string) {
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: "IsolationStrong!2026", householdName }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: "IsolationStrong!2026" }),
    });
    const body = (await login.json()) as { csrfToken: string };
    const jar = cookieJar(login);
    return {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie: cookieHeader(jar),
      "x-csrf-token": body.csrfToken,
    };
  }

  async function post(headers: Record<string, string>, path: string, body: unknown) {
    const response = await application.app.request(`/api/v1${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    return response;
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-tenant-"));
    application = createApp(
      loadConfig({
        APP_ENV: "test",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "f".repeat(64),
        WEB_ORIGIN: "http://localhost:5173",
        COOKIE_SECURE: "false",
        REGISTRATION_MODE: "open",
        LOG_LEVEL: "error",
      }),
    );
    householdAHeaders = await registerAndLogin("tenant-a@example.com", "Household A");
    householdBHeaders = await registerAndLogin("tenant-b@example.com", "Household B");

    const account = await post(householdBHeaders, "/accounts", {
      name: "B secret account",
      group: "cash",
      type: "checking",
      currency: "USD",
      balanceMinorUnits: "777000",
    });
    householdBAccountId = ((await account.json()) as { id: string }).id;

    const category = await post(householdBHeaders, "/categories", {
      name: "B secret category",
      kind: "expense",
    });
    householdBCategoryId = ((await category.json()) as { id: string }).id;

    const transaction = await post(householdBHeaders, "/transactions", {
      accountId: householdBAccountId,
      amountMinorUnits: "-77700",
      currency: "USD",
      effectiveDate: "2026-07-15T12:00:00.000Z",
      description: "B SECRET MERCHANT NAME",
      categoryId: householdBCategoryId,
    });
    householdBTransactionId = ((await transaction.json()) as { id: string }).id;

    const goal = await post(householdBHeaders, "/goals", {
      name: "B secret goal",
      type: "purchase",
      target: { minorUnits: "100000", currency: "USD" },
    });
    householdBGoalId = ((await goal.json()) as { id: string }).id;
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("list endpoints return only the caller's household data", async () => {
    const secretNeedles = [
      "B secret account",
      "B secret category",
      "B SECRET MERCHANT NAME",
      "B secret goal",
      householdBAccountId,
      householdBTransactionId,
      householdBCategoryId,
      householdBGoalId,
    ];
    const listEndpoints = [
      "/accounts",
      "/categories",
      "/transactions",
      "/envelopes",
      "/budgets",
      "/bills",
      "/goals",
      "/rules",
      "/scenarios",
      "/assets",
      "/income-sources",
      "/imports",
      "/sync-runs",
      "/ai/suggestions",
      "/audit-events",
      "/reports/dashboard",
      "/reports/net-worth",
      "/reports/cash-flow",
      "/reports/spending",
      "/forecasts",
      "/household/members",
    ];
    for (const endpoint of listEndpoints) {
      const response = await application.app.request(`/api/v1${endpoint}`, {
        headers: { cookie: householdAHeaders.cookie },
      });
      expect(response.status, endpoint).toBe(200);
      const body = await response.text();
      for (const needle of secretNeedles) {
        expect(body, `${endpoint} leaked ${needle}`).not.toContain(needle);
      }
    }
  });

  test("search cannot surface another household's transactions", async () => {
    const response = await application.app.request(
      `/api/v1/transactions?query=${encodeURIComponent("B SECRET MERCHANT")}`,
      { headers: { cookie: householdAHeaders.cookie } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });

  test("direct id access to another household's resources fails closed", async () => {
    const foreignTargets: Array<{ path: string; patch: Record<string, unknown> }> = [
      { path: `/accounts/${householdBAccountId}`, patch: { name: "cross-tenant write" } },
      { path: `/transactions/${householdBTransactionId}`, patch: { reviewState: "approved" } },
      { path: `/goals/${householdBGoalId}`, patch: { name: "cross-tenant write" } },
      { path: `/categories/${householdBCategoryId}`, patch: { name: "cross-tenant write" } },
    ];
    for (const { path, patch } of foreignTargets) {
      const read = await application.app.request(`/api/v1${path}`, {
        headers: { cookie: householdAHeaders.cookie },
      });
      expect([403, 404], `GET ${path} should not succeed`).toContain(read.status);

      const write = await application.app.request(`/api/v1${path}`, {
        method: "PATCH",
        headers: householdAHeaders,
        body: JSON.stringify(patch),
      });
      expect([403, 404], `PATCH ${path} should not succeed`).toContain(write.status);
    }
  });

  test("the household cookie cannot switch a session into a foreign household", async () => {
    // Build a cookie jar without the empty bw_household placeholder login
    // leaves behind, so the foreign id is the value the server actually reads.
    const sessionCookie = householdAHeaders.cookie
      .split("; ")
      .filter((entry) => !entry.startsWith("bw_household="))
      .join("; ");
    const foreignSession = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: `${sessionCookie}; bw_household=nonexistent-household` },
    });
    expect(foreignSession.status).toBe(403);
  });
});
