import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { categories, idempotencyKeys } from "@betterwealth/db/schema";
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

describe("idempotency middleware", () => {
  let directory: string;
  let application: BetterWealthApplication;
  let headers: Record<string, string>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-idem-"));
    application = createApp(
      loadConfig({
        APP_ENV: "test",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "e".repeat(64),
        WEB_ORIGIN: "http://localhost:5173",
        COOKIE_SECURE: "false",
        REGISTRATION_MODE: "open",
        LOG_LEVEL: "error",
      }),
    );
    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "idem@example.com",
        password: "IdemStrong!2026",
        householdName: "Idem plan",
      }),
    });
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "idem@example.com", password: "IdemStrong!2026" }),
    });
    const body = (await login.json()) as { csrfToken: string };
    headers = {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie: cookieHeader(cookieJar(login)),
      "x-csrf-token": body.csrfToken,
    };
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function createCategory(key?: string, name = "Idempotent category") {
    return application.app.request("/api/v1/categories", {
      method: "POST",
      headers: key ? { ...headers, "idempotency-key": key } : headers,
      body: JSON.stringify({ name, kind: "expense" }),
    });
  }

  test("replays the stored response for a retried key without double-writing", async () => {
    const first = await createCategory("retry-1");
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { id: string };

    const second = await createCategory("retry-1");
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBe("true");
    const secondBody = (await second.json()) as { id: string };
    expect(secondBody.id).toBe(firstBody.id);

    const rows = await application.db
      .select({ name: categories.name })
      .from(categories)
      .where(eq(categories.name, "Idempotent category"));
    expect(rows).toHaveLength(1);
  });

  test("treats different keys as independent requests", async () => {
    const first = await createCategory("key-a", "Category A");
    const second = await createCategory("key-b", "Category B");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotency-replayed")).toBeNull();
    const [a, b] = [
      ((await first.json()) as { id: string }).id,
      ((await second.json()) as { id: string }).id,
    ];
    expect(a).not.toBe(b);
  });

  test("releases the claim when the handler fails so the client can retry", async () => {
    // First attempt fails validation (missing kind) — the key must not be stuck.
    const failed = await application.app.request("/api/v1/categories", {
      method: "POST",
      headers: { ...headers, "idempotency-key": "retry-after-failure" },
      body: JSON.stringify({ name: "Broken" }),
    });
    expect(failed.status).toBe(422);

    const succeeded = await createCategory("retry-after-failure");
    expect(succeeded.status).toBe(201);
    const stored = await application.db
      .select({ status: idempotencyKeys.status })
      .from(idempotencyKeys);
    expect(stored.map(({ status }) => status)).toEqual([201]);
  });

  test("scopes keys per household so another tenant cannot replay them", async () => {
    const first = await createCategory("tenant-key");
    expect(first.status).toBe(201);

    await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "other@example.com",
        password: "IdemStrong!2026",
        householdName: "Other plan",
      }),
    });
    const otherLogin = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "other@example.com", password: "IdemStrong!2026" }),
    });
    const otherBody = (await otherLogin.json()) as { csrfToken: string };
    const otherHeaders = {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie: cookieHeader(cookieJar(otherLogin)),
      "x-csrf-token": otherBody.csrfToken,
      "idempotency-key": "tenant-key",
    };
    const replay = await application.app.request("/api/v1/categories", {
      method: "POST",
      headers: otherHeaders,
      body: JSON.stringify({ name: "Other tenant category", kind: "expense" }),
    });
    // Same key string from a different household is a fresh request, not a replay.
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotency-replayed")).toBeNull();
  });

  test("rejects over-length keys with a contract error", async () => {
    const response = await createCategory("x".repeat(200));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "bad_request", message: "Idempotency-Key must be 160 characters or fewer" },
    });
  });
});
