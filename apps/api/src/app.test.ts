import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alexFixture } from "@betterwealth/testkit";
import type { BetterWealthApplication } from "./app";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { sha256 } from "./lib/crypto";
import { ALEX_DEMO_EMAIL, ALEX_DEMO_PASSWORD, seedCanonicalAlex } from "./seed/canonical-alex";

function testConfig(databasePath: string, registrationMode: "open" | "invite" | "closed" = "open") {
  return loadConfig({
    APP_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    WEB_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databasePath,
    ENCRYPTION_KEY: "a".repeat(64),
    COOKIE_SECURE: "false",
    REGISTRATION_MODE: registrationMode,
    SESSION_IDLE_DAYS: "14",
    SESSION_ABSOLUTE_DAYS: "30",
    SYNC_INTERVAL_MINUTES: "360",
    OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
    BOOTSTRAP_OPENROUTER_MODEL: "test/model",
    LOG_LEVEL: "error",
  });
}

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

describe("BetterWealth API", () => {
  let directory: string;
  let application: BetterWealthApplication;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-api-"));
    application = createApp(testConfig(join(directory, "test.sqlite")));
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("health is public and reports readiness", async () => {
    const response = await application.app.request("/api/v1/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", database: "ready" });
  });

  test("publishes registration capability without authentication or private configuration", async () => {
    const openResponse = await application.app.request("/api/v1/capabilities");
    expect(openResponse.status).toBe(200);
    expect(await openResponse.json()).toEqual({
      registration: { mode: "open", selfService: true },
    });

    const closedDirectory = mkdtempSync(join(tmpdir(), "betterwealth-capabilities-"));
    const closedApplication = createApp(
      testConfig(join(closedDirectory, "closed.sqlite"), "closed"),
    );
    try {
      const closedResponse = await closedApplication.app.request("/api/v1/capabilities");
      expect(closedResponse.status).toBe(200);
      expect(await closedResponse.json()).toEqual({
        registration: { mode: "closed", selfService: false },
      });
    } finally {
      closedApplication.close();
      rmSync(closedDirectory, { recursive: true, force: true });
    }
  });

  test("publishes a mobile-client-ready OpenAPI surface", async () => {
    const response = await application.app.request("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: Record<string, unknown> };
    };
    expect(document.openapi).toBe("3.1.0");
    expect(Object.keys(document.paths).length).toBeGreaterThan(50);
    expect(document.paths).toHaveProperty("/connections/simplefin/claim");
    expect(document.paths).toHaveProperty("/capabilities");
    expect(document.paths).toHaveProperty("/settings/integrations/ai");
    expect(document.paths).toHaveProperty("/reports/net-worth");
    expect(document.paths).toHaveProperty("/assets/{id}/valuations");
    expect(document.components.securitySchemes).toHaveProperty("sessionCookie");
  });

  test("auth, CSRF, ledger creation, and household isolation work together", async () => {
    const register = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "alex@example.com",
        password: "WealthBy30!2026",
        householdName: "Alex's plan",
      }),
    });
    expect(register.status).toBe(201);
    const registered = (await register.json()) as { householdId: string };

    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "alex@example.com", password: "WealthBy30!2026" }),
    });
    expect(login.status).toBe(200);
    const loginBody = (await login.json()) as { csrfToken: string };
    const cookies = cookieJar(login);
    expect(cookies.bw_session).toBeTruthy();
    expect(cookies.bw_csrf).toBe(loginBody.csrfToken);

    const session = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ householdId: registered.householdId });

    const secondLogin = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        "user-agent": "BetterWealth test phone",
      },
      body: JSON.stringify({ email: "alex@example.com", password: "WealthBy30!2026" }),
    });
    expect(secondLogin.status).toBe(200);
    const secondCookies = cookieJar(secondLogin);
    const activeSessions = await application.app.request("/api/v1/auth/sessions", {
      headers: { cookie: cookieHeader(secondCookies) },
    });
    const activeSessionBody = (await activeSessions.json()) as {
      data: Array<{ id: string; current: boolean; userAgent: string }>;
    };
    expect(activeSessionBody.data).toHaveLength(2);
    expect(activeSessionBody.data.find(({ current }) => current)?.userAgent).toBe(
      "BetterWealth test phone",
    );
    const otherSession = activeSessionBody.data.find(({ current }) => !current);
    expect(otherSession).toBeDefined();
    const revokedSession = await application.app.request(
      `/api/v1/auth/sessions/${otherSession?.id}`,
      {
        method: "DELETE",
        headers: {
          cookie: cookieHeader(secondCookies),
          origin: "http://localhost:5173",
          "x-csrf-token": secondCookies.bw_csrf ?? "",
        },
      },
    );
    expect(revokedSession.status).toBe(204);
    Object.assign(cookies, secondCookies);
    loginBody.csrfToken = secondCookies.bw_csrf ?? loginBody.csrfToken;

    const rejected = await application.app.request("/api/v1/accounts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(cookies),
        origin: "http://localhost:5173",
      },
      body: JSON.stringify({ name: "Checking", group: "cash", balanceMinorUnits: "100000" }),
    });
    expect(rejected.status).toBe(403);

    const created = await application.app.request("/api/v1/accounts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(cookies),
        origin: "http://localhost:5173",
        "x-csrf-token": loginBody.csrfToken,
      },
      body: JSON.stringify({ name: "Checking", group: "cash", balanceMinorUnits: "100000" }),
    });
    expect(created.status).toBe(201);

    const accounts = await application.app.request("/api/v1/accounts", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(accounts.status).toBe(200);
    const accountBody = (await accounts.json()) as { data: Array<{ name: string }> };
    expect(accountBody.data.map(({ name }) => name)).toEqual(["Checking"]);

    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "other@example.com",
        password: "AnotherStrong!2026",
        householdName: "Other plan",
      }),
    });
    const otherLogin = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "other@example.com", password: "AnotherStrong!2026" }),
    });
    const otherCookies = cookieJar(otherLogin);
    otherCookies.bw_household = registered.householdId;
    const isolated = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: cookieHeader(otherCookies) },
    });
    expect(isolated.status).toBe(403);
  });

  test("validation failures never leak internals", async () => {
    const response = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bad", password: "short" }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed", message: "The request did not pass validation" },
    });
  });

  test("owner profile, secret-free export, and online database backup are usable", async () => {
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "owner@example.com",
        password: "OwnerStrong!2026",
        householdName: "Owner plan",
      }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "owner@example.com", password: "OwnerStrong!2026" }),
    });
    const auth = (await login.json()) as { csrfToken: string };
    const cookies = cookieJar(login);

    const profile = await application.app.request("/api/v1/profile", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      user: { email: "owner@example.com" },
      household: { name: "Owner plan", baseCurrency: "USD" },
      role: "owner",
    });

    const update = await application.app.request("/api/v1/profile", {
      method: "PATCH",
      headers: {
        cookie: cookieHeader(cookies),
        origin: "http://localhost:5173",
        "content-type": "application/json",
        "x-csrf-token": auth.csrfToken,
      },
      body: JSON.stringify({ birthDate: "2004-07-16", targetAge: 30 }),
    });
    expect(update.status).toBe(200);

    const exported = await application.app.request("/api/v1/data-export", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(exported.status).toBe(200);
    const exportText = await exported.text();
    expect(exportText).toContain("betterwealth-export-v1");
    expect(exportText).not.toContain("passwordHash");
    expect(exportText).not.toContain("credentialsCiphertext");
    const parsedExport = JSON.parse(exportText) as Record<string, unknown> & {
      integrity: { digest: string };
    };
    const { integrity, ...unsignedExport } = parsedExport;
    expect(integrity.digest).toBe(sha256(JSON.stringify(unsignedExport)));

    const backup = await application.app.request("/api/v1/database-backup", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(backup.status).toBe(200);
    expect(backup.headers.get("content-type")).toBe("application/vnd.sqlite3");
    const backupBytes = await backup.arrayBuffer();
    const header = new TextDecoder().decode(backupBytes.slice(0, 15));
    expect(header).toBe("SQLite format 3");
    const downloadedPath = join(directory, "downloaded.sqlite");
    writeFileSync(downloadedPath, Buffer.from(backupBytes));
    const downloaded = new Database(downloadedPath, {
      create: false,
      readonly: true,
      strict: true,
    });
    try {
      expect(
        downloaded.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
      ).toBe("delete");
      expect(downloaded.query("PRAGMA quick_check").values()).toEqual([["ok"]]);
      expect(
        downloaded.query<{ count: number }, []>("SELECT count(*) AS count FROM users").get()?.count,
      ).toBe(1);
    } finally {
      downloaded.close();
    }
    expect(existsSync(`${downloadedPath}-wal`)).toBe(false);
    expect(existsSync(`${downloadedPath}-shm`)).toBe(false);
  });

  test("canonical age-22 dashboard and net worth report exact live planning data", async () => {
    await seedCanonicalAlex(application.db);
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: ALEX_DEMO_EMAIL, password: ALEX_DEMO_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookies = cookieJar(login);

    const dashboard = await application.app.request("/api/v1/reports/dashboard", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      safeToSpend: alexFixture.expected.safeToSpend,
      projectedLiquidNetWorth: alexFixture.expected.age30NetWorth,
      reservedBills: { minorUnits: "145000", currency: "USD" },
      minimumBuffer: { minorUnits: "100000", currency: "USD" },
    });

    const netWorth = await application.app.request("/api/v1/reports/net-worth?range=All", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(netWorth.status).toBe(200);
    const netWorthBody = (await netWorth.json()) as {
      total: { minorUnits: string };
      series: Array<{ date: string; total: { minorUnits: string } }>;
      composition: Array<{ group: string; amount: { minorUnits: string }; kind: string }>;
    };
    expect(BigInt(netWorthBody.total.minorUnits)).toBeGreaterThan(
      BigInt(alexFixture.expected.startingNetWorth.minorUnits),
    );
    expect(netWorthBody.series.length).toBeGreaterThanOrEqual(3);
    expect(netWorthBody.composition).toContainEqual(
      expect.objectContaining({
        group: "Vehicles",
        amount: { minorUnits: "950000", currency: "USD" },
        kind: "asset",
      }),
    );
  });
});
