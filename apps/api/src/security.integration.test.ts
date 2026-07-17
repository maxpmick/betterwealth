import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accounts, householdMembers, households } from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import type { BetterWealthApplication } from "./app";
import { createApp } from "./app";
import { loadConfig } from "./config";

function testConfig(databasePath: string) {
  return loadConfig({
    APP_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    WEB_ORIGIN: "http://localhost:5173",
    DATABASE_URL: databasePath,
    ENCRYPTION_KEY: "e".repeat(64),
    REGISTRATION_MODE: "open",
    TRUST_PROXY: "false",
    LOG_LEVEL: "error",
  });
}

function cookies(response: Response): Record<string, string> {
  return Object.fromEntries(
    response.headers.getSetCookie().flatMap((header) => {
      const pair = header.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      return pair && separator > 0 ? [[pair.slice(0, separator), pair.slice(separator + 1)]] : [];
    }),
  );
}

function cookieHeader(values: Record<string, string>) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("; ");
}

describe("production security boundaries", () => {
  let directory: string;
  let databasePath: string;
  let application: BetterWealthApplication;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-security-"));
    databasePath = join(directory, "test.sqlite");
    application = createApp(testConfig(databasePath));
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const register = async (email: string, householdName: string) => {
    const response = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: "SecurityBoundary!2026", householdName }),
    });
    expect(response.status).toBe(201);
    return (await response.json()) as { userId: string; householdId: string };
  };

  const login = async (email: string) => {
    const response = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: "SecurityBoundary!2026" }),
    });
    expect(response.status).toBe(200);
    return { response, jar: cookies(response) };
  };

  test("viewer sessions are read-only and suspended households fail closed", async () => {
    const owner = await register("owner-security@example.com", "Secure household");
    const viewer = await register("viewer-security@example.com", "Viewer household");
    await application.db.insert(householdMembers).values({
      householdId: owner.householdId,
      userId: viewer.userId,
      role: "viewer",
      status: "active",
    });
    const viewerLogin = await login("viewer-security@example.com");
    viewerLogin.jar.bw_household = owner.householdId;

    const readable = await application.app.request("/api/v1/accounts", {
      headers: { cookie: cookieHeader(viewerLogin.jar) },
    });
    expect(readable.status).toBe(200);
    expect(readable.headers.get("cache-control")).toBe("no-store");

    const mutation = await application.app.request("/api/v1/accounts", {
      method: "POST",
      headers: {
        cookie: cookieHeader(viewerLogin.jar),
        origin: "http://localhost:5173",
        "content-type": "application/json",
        "x-csrf-token": viewerLogin.jar.bw_csrf ?? "",
      },
      body: JSON.stringify({ name: "Forbidden account", group: "cash" }),
    });
    expect(mutation.status).toBe(403);
    expect(await application.db.select().from(accounts)).toHaveLength(0);

    const ownerLogin = await login("owner-security@example.com");
    await application.db
      .update(households)
      .set({ status: "suspended" })
      .where(eq(households.id, owner.householdId));
    const suspended = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: cookieHeader(ownerLogin.jar) },
    });
    expect(suspended.status).toBe(403);
  });

  test("browser auth accepts literal loopback aliases but rejects hostile origins and non-JSON bodies", async () => {
    await register("origin-security@example.com", "Origin test");
    const loopbackAlias = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:5173",
        cookie: "bw_household=stale-household-from-an-older-local-instance",
      },
      body: JSON.stringify({
        email: "origin-security@example.com",
        password: "SecurityBoundary!2026",
      }),
    });
    expect(loopbackAlias.status).toBe(200);
    expect(loopbackAlias.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5173");
    const aliasCookies = cookies(loopbackAlias);
    expect(aliasCookies.bw_household).toBe("");
    const aliasSession = await application.app.request("/api/v1/auth/session", {
      headers: { cookie: cookieHeader(aliasCookies) },
    });
    expect(aliasSession.status).toBe(200);

    const hostile = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({
        email: "origin-security@example.com",
        password: "SecurityBoundary!2026",
      }),
    });
    expect(hostile.status).toBe(403);

    const simpleBody = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "origin-security@example.com",
        password: "SecurityBoundary!2026",
      }),
    });
    expect(simpleBody.status).toBe(415);
  });

  test("untrusted forwarded headers cannot bypass login throttling", async () => {
    await register("rate-security@example.com", "Rate test");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await application.app.request("/api/v1/auth/login", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:5173",
          "x-forwarded-for": `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ email: "missing@example.com", password: "wrong" }),
      });
      expect(response.status).toBe(401);
    }
    const throttled = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        "x-forwarded-for": "203.0.113.250",
      },
      body: JSON.stringify({ email: "missing@example.com", password: "wrong" }),
    });
    expect(throttled.status).toBe(429);
  });

  test("database files are permission-restricted at creation", () => {
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });
});
