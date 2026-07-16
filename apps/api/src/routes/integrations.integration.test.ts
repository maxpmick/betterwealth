import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHouseholdRepositories } from "@betterwealth/db";
import { jobs, settings } from "@betterwealth/db/schema";
import { ulid } from "ulid";
import type { BetterWealthApplication } from "../app";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { FieldCipher } from "../lib/crypto";

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

describe("per-user integration settings", () => {
  let directory: string;
  let application: BetterWealthApplication;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "betterwealth-integrations-"));
    application = createApp(
      loadConfig({
        APP_ENV: "test",
        API_HOST: "127.0.0.1",
        API_PORT: "3001",
        WEB_ORIGIN: "http://localhost:5173",
        DATABASE_URL: join(directory, "test.sqlite"),
        ENCRYPTION_KEY: "b".repeat(64),
        COOKIE_SECURE: "false",
        REGISTRATION_MODE: "open",
        OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
        BOOTSTRAP_OPENROUTER_MODEL: "test/default",
        LOG_LEVEL: "error",
      }),
    );
  });

  afterEach(() => {
    application.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("encrypts an AI key, preserves it on edits, and never returns it", async () => {
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
    const mutationHeaders = {
      "content-type": "application/json",
      origin: "http://localhost:5173",
      cookie: cookieHeader(cookies),
      "x-csrf-token": auth.csrfToken,
    };
    const syntheticKey = "sk-test-never-store-in-plaintext";

    const configured = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/first",
        apiKey: syntheticKey,
        confidenceThreshold: 0.91,
      }),
    });
    expect(configured.status).toBe(200);
    const configuredBody = await configured.json();
    expect(configuredBody).toMatchObject({
      configured: true,
      enabled: true,
      model: "test/first",
      confidenceThreshold: 0.91,
    });
    expect(configuredBody).not.toHaveProperty("apiKey");

    const stored = await application.db.select().from(settings);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0]?.value)).not.toContain(syntheticKey);
    expect(stored[0]?.isSecret).toBe(true);

    const edited = await application.app.request("/api/v1/settings/integrations/ai", {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        enabled: false,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/second",
        confidenceThreshold: 0.95,
      }),
    });
    expect(edited.status).toBe(200);

    const fetched = await application.app.request("/api/v1/settings/integrations/ai", {
      headers: { cookie: cookieHeader(cookies) },
    });
    expect(fetched.status).toBe(200);
    const fetchedBody = await fetched.json();
    expect(fetchedBody).toEqual({
      configured: true,
      enabled: false,
      baseUrl: "https://openrouter.ai/api/v1",
      model: "test/second",
      confidenceThreshold: 0.95,
    });
    expect(JSON.stringify(fetchedBody)).not.toContain(syntheticKey);
  });

  test("queues every active SimpleFIN connection once when Sync all is requested", async () => {
    const registration = await application.app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({
        email: "sync@example.com",
        password: "SyncAllStrong!2026",
        householdName: "Sync plan",
      }),
    });
    const identity = (await registration.json()) as { userId: string; householdId: string };
    const repositories = createHouseholdRepositories(application.db, identity.householdId);
    const cipher = new FieldCipher("b".repeat(64));
    const connectionIds = [ulid(), ulid()];
    for (const [index, id] of connectionIds.entries()) {
      const aad = `connection:${id}:credentials`;
      repositories.connections.create({
        id,
        ownerUserId: identity.userId,
        provider: "simplefin",
        displayName: `SimpleFIN ${index + 1}`,
        encryptedCredentials: cipher.encrypt(
          `https://user:password@bridge.example.test/simplefin-${index + 1}`,
          aad,
        ),
        credentialsAad: aad,
        capabilities: ["accounts", "balances", "transactions"],
        status: "active",
      });
    }
    const login = await application.app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify({ email: "sync@example.com", password: "SyncAllStrong!2026" }),
    });
    const auth = (await login.json()) as { csrfToken: string };
    const cookies = cookieJar(login);
    const sync = () =>
      application.app.request("/api/v1/sync-runs", {
        method: "POST",
        headers: {
          cookie: cookieHeader(cookies),
          origin: "http://localhost:5173",
          "x-csrf-token": auth.csrfToken,
          "idempotency-key": "sync-all-test",
        },
      });

    const first = await sync();
    expect(first.status).toBe(202);
    const firstBody = (await first.json()) as {
      syncRunId: string;
      syncRunIds: string[];
      state: string;
    };
    expect(firstBody.syncRunIds).toHaveLength(2);
    expect(firstBody.syncRunIds).toContain(firstBody.syncRunId);
    expect(firstBody.state).toBe("queued");
    const queued = await application.db.select().from(jobs);
    expect(queued).toHaveLength(2);
    expect(
      new Set(queued.map((job) => (job.payload as { connectionId: string }).connectionId)),
    ).toEqual(new Set(connectionIds));

    const repeated = await sync();
    expect(repeated.status).toBe(202);
    const repeatedBody = (await repeated.json()) as { syncRunIds: string[] };
    expect(new Set(repeatedBody.syncRunIds)).toEqual(new Set(firstBody.syncRunIds));
    expect(await application.db.select().from(jobs)).toHaveLength(2);
  });
});
