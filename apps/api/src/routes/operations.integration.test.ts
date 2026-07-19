import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { users } from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";

function testConfig(databasePath: string) {
  return loadConfig({
    APP_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    WEB_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databasePath,
    ENCRYPTION_KEY: "a".repeat(64),
    COOKIE_SECURE: "false",
    REGISTRATION_MODE: "open",
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

const ORIGINAL_PASSWORD = "OriginalStrong!2026";
const NEW_PASSWORD = "UpdatedStrong!2026";

describe("password change", () => {
  let directory: string;
  let application: BetterWealthApplication;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-operations-"));
    application = createApp(testConfig(join(directory, "test.sqlite")));
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function loginWith(email: string, password: string) {
    return application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password }),
    });
  }

  async function registerAndLogin(email: string) {
    const registration = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: ORIGINAL_PASSWORD, householdName: `${email} plan` }),
    });
    expect(registration.status).toBe(201);
    const identity = (await registration.json()) as { userId: string; householdId: string };
    const login = await loginWith(email, ORIGINAL_PASSWORD);
    expect(login.status).toBe(200);
    const auth = (await login.json()) as { csrfToken: string };
    return { ...identity, cookies: cookieJar(login), csrfToken: auth.csrfToken };
  }

  function changePassword(
    account: { cookies: Record<string, string>; csrfToken: string },
    body: unknown,
  ) {
    return application.app.request("/api/v1/profile/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        cookie: cookieHeader(account.cookies),
        "x-csrf-token": account.csrfToken,
      },
      body: JSON.stringify(body),
    });
  }

  async function storedPasswordHash(userId: string) {
    const row = await application.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    return row?.passwordHash;
  }

  test("rejects an incorrect current password without touching the stored hash", async () => {
    const account = await registerAndLogin("change-wrong@example.com");
    const hashBefore = await storedPasswordHash(account.userId);

    const response = await changePassword(account, {
      currentPassword: "NotThePassword!123",
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Current password is incorrect" },
    });

    expect(await storedPasswordHash(account.userId)).toBe(hashBefore);
    const login = await loginWith("change-wrong@example.com", ORIGINAL_PASSWORD);
    expect(login.status).toBe(200);
  });

  test("applies a correct change: the new password signs in and the old one fails", async () => {
    const account = await registerAndLogin("change-success@example.com");

    const response = await changePassword(account, {
      currentPassword: ORIGINAL_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ changed: true });

    const oldLogin = await loginWith("change-success@example.com", ORIGINAL_PASSWORD);
    expect(oldLogin.status).toBe(401);
    const newLogin = await loginWith("change-success@example.com", NEW_PASSWORD);
    expect(newLogin.status).toBe(200);
  });

  test("revokes every other session but keeps the changing session valid", async () => {
    const account = await registerAndLogin("change-sessions@example.com");
    const secondLogin = await loginWith("change-sessions@example.com", ORIGINAL_PASSWORD);
    expect(secondLogin.status).toBe(200);
    const secondCookies = cookieJar(secondLogin);

    const response = await changePassword(account, {
      currentPassword: ORIGINAL_PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(response.status).toBe(200);

    const other = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: cookieHeader(secondCookies) },
    });
    expect(other.status).toBe(401);

    const current = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: cookieHeader(account.cookies) },
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({ householdId: account.householdId });
  });

  test("enforces the new-password policy and leaves the hash untouched", async () => {
    const account = await registerAndLogin("change-policy@example.com");
    const hashBefore = await storedPasswordHash(account.userId);

    const response = await changePassword(account, {
      currentPassword: ORIGINAL_PASSWORD,
      newPassword: "Shorty!1234",
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed", message: "The request did not pass validation" },
    });

    expect(await storedPasswordHash(account.userId)).toBe(hashBefore);
  });

  test("requires an authenticated session and a valid CSRF token", async () => {
    const account = await registerAndLogin("change-guards@example.com");
    const hashBefore = await storedPasswordHash(account.userId);
    const body = JSON.stringify({ currentPassword: ORIGINAL_PASSWORD, newPassword: NEW_PASSWORD });

    const anonymous = await application.app.request("/api/v1/profile/password", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body,
    });
    expect(anonymous.status).toBe(401);

    const withoutCsrf = await application.app.request("/api/v1/profile/password", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        cookie: cookieHeader(account.cookies),
      },
      body,
    });
    expect(withoutCsrf.status).toBe(403);
    expect(await storedPasswordHash(account.userId)).toBe(hashBefore);
  });
});
