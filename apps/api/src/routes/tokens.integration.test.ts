import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { personalAccessTokens } from "@betterwealth/db/schema";
import { eq } from "drizzle-orm";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";

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

describe("personal access tokens", () => {
  let directory: string;
  let application: BetterWealthApplication;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-pat-"));
    application = createApp(
      loadConfig({
        APP_ENV: "test",
        API_HOST: "127.0.0.1",
        API_PORT: "3001",
        WEB_ORIGIN: "http://localhost:5173",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "d".repeat(64),
        COOKIE_SECURE: "false",
        REGISTRATION_MODE: "open",
        LOG_LEVEL: "error",
      }),
    );
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function registerAndLogin(email = "pat@example.com") {
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: "TokenStrong!2026", householdName: "Token plan" }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: "TokenStrong!2026" }),
    });
    const body = (await login.json()) as { csrfToken: string };
    const jar = cookieJar(login);
    return {
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:5173",
        cookie: cookieHeader(jar),
        "x-csrf-token": body.csrfToken,
      },
    };
  }

  async function createToken(
    headers: Record<string, string>,
    input: Record<string, unknown> = { name: "Phone" },
  ) {
    const response = await application.app.request("/api/v1/auth/tokens", {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
    return { response, body: (await response.json()) as Record<string, unknown> };
  }

  test("creates, lists, and revokes a token, returning the value only once", async () => {
    const { headers } = await registerAndLogin();
    const { response, body } = await createToken(headers, {
      name: "Phone",
      scopes: ["read", "write"],
      expiresInDays: 30,
    });
    expect(response.status).toBe(201);
    expect(String(body.token)).toMatch(/^bw_pat_/);
    expect(body.expiresAt).toBeTruthy();

    const list = await application.app.request("/api/v1/auth/tokens", { headers });
    const listed = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({ name: "Phone", scopes: ["read", "write"] });
    expect(listed.data[0]).not.toHaveProperty("token");
    expect(listed.data[0]).not.toHaveProperty("tokenHash");

    const id = String(body.id);
    const revoked = await application.app.request(`/api/v1/auth/tokens/${id}`, {
      method: "DELETE",
      headers,
    });
    expect(revoked.status).toBe(204);
    const afterRevoke = await application.app.request("/api/v1/auth/tokens", { headers });
    expect(((await afterRevoke.json()) as { data: unknown[] }).data).toHaveLength(0);

    const again = await application.app.request(`/api/v1/auth/tokens/${id}`, {
      method: "DELETE",
      headers,
    });
    expect(again.status).toBe(404);
  });

  test("authenticates bearer requests without CSRF and honors write scope", async () => {
    const { headers } = await registerAndLogin();
    const { body } = await createToken(headers, { name: "Phone", scopes: ["read", "write"] });
    const token = String(body.token);
    const bearer = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const session = await application.app.request("/api/v1/auth/session", { headers: bearer });
    expect(session.status).toBe(200);
    const sessionBody = (await session.json()) as { user: { email: string } };
    expect(sessionBody.user.email).toBe("pat@example.com");

    // Mutations work without the cookie+CSRF dance.
    const created = await application.app.request("/api/v1/categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Bearer category", kind: "expense" }),
    });
    expect(created.status).toBe(201);
  });

  test("rejects mutations from a read-only token with the contract error", async () => {
    const { headers } = await registerAndLogin();
    const { body } = await createToken(headers, { name: "Reports", scopes: ["read"] });
    const bearer = {
      authorization: `Bearer ${String(body.token)}`,
      "content-type": "application/json",
    };

    const reads = await application.app.request("/api/v1/accounts", { headers: bearer });
    expect(reads.status).toBe(200);

    const writes = await application.app.request("/api/v1/categories", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Nope", kind: "expense" }),
    });
    expect(writes.status).toBe(403);
    expect(await writes.json()).toMatchObject({
      error: { code: "forbidden", message: "This token cannot make changes" },
    });
  });

  test("rejects invalid, revoked, and expired tokens", async () => {
    const { headers } = await registerAndLogin();

    const garbage = await application.app.request("/api/v1/auth/session", {
      headers: { authorization: "Bearer bw_pat_not-a-real-token" },
    });
    expect(garbage.status).toBe(401);

    const { body } = await createToken(headers, { name: "Short lived" });
    const token = String(body.token);
    const id = String(body.id);
    await application.app.request(`/api/v1/auth/tokens/${id}`, { method: "DELETE", headers });
    const revoked = await application.app.request("/api/v1/auth/session", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(revoked.status).toBe(401);

    await application.db
      .update(personalAccessTokens)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z", revokedAt: null })
      .where(eq(personalAccessTokens.id, id));
    const expired = await application.db
      .select()
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, id))
      .get();
    expect(expired?.revokedAt).toBeNull();
    const expiredResponse = await application.app.request("/api/v1/auth/session", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(expiredResponse.status).toBe(401);
  });

  test("a personal access token cannot manage other tokens", async () => {
    const { headers } = await registerAndLogin();
    const { body } = await createToken(headers, { name: "Phone", scopes: ["read", "write"] });
    const bearer = {
      authorization: `Bearer ${String(body.token)}`,
      "content-type": "application/json",
    };

    const mint = await application.app.request("/api/v1/auth/tokens", {
      method: "POST",
      headers: bearer,
      body: JSON.stringify({ name: "Recursive" }),
    });
    expect(mint.status).toBe(403);

    const revoke = await application.app.request(`/api/v1/auth/tokens/${String(body.id)}`, {
      method: "DELETE",
      headers: bearer,
    });
    expect(revoke.status).toBe(403);
  });

  test("selects the household via X-BetterWealth-Household and fails closed on foreign households", async () => {
    const { headers } = await registerAndLogin("first@example.com");
    const { body } = await createToken(headers, { name: "Phone", scopes: ["read"] });
    const token = String(body.token);

    const other = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "second@example.com",
        password: "TokenStrong!2026",
        householdName: "Second plan",
      }),
    });
    const otherHousehold = (await other.json()) as { householdId: string };

    const foreign = await application.app.request("/api/v1/auth/session", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-betterwealth-household": otherHousehold.householdId,
      },
    });
    expect(foreign.status).toBe(403);
  });

  test("records token lifecycle audit events", async () => {
    const { headers } = await registerAndLogin();
    const { body } = await createToken(headers, { name: "Phone" });
    const events = await application.app.request("/api/v1/audit-events", { headers });
    const body_ = (await events.json()) as { data: Array<{ action: string }> };
    expect(body_.data.map(({ action }) => action)).toContain("token.created");
    expect(body.id).toBeTruthy();
  });
});
