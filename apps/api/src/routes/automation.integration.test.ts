import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type BetterWealthDatabase,
  closeDatabase,
  openDatabase,
  runMigrations,
} from "@betterwealth/db";
import {
  accounts,
  categories,
  type JsonObject,
  ruleRuns,
  rules,
  transactions,
} from "@betterwealth/db/schema";
import { ruleSpecificity } from "@betterwealth/shared";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { ulid } from "ulid";
import { ZodError } from "zod";
import { createSession, registerUser } from "../auth/service";
import { type AppConfig, loadConfig } from "../config";
import { AppError } from "../lib/errors";
import type { AppEnv } from "../types";
import { createPlanningRoutes } from "./planning";

describe("automation rule routes", () => {
  let db: BetterWealthDatabase;
  let config: AppConfig;
  let app: Hono<AppEnv>;
  let householdId: string;
  let userId: string;
  let otherHouseholdId: string;
  let sessionToken: string;
  let csrfToken: string;

  beforeEach(async () => {
    config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "0".repeat(64),
      REGISTRATION_MODE: "open",
      WEB_ORIGIN: "http://localhost:5173",
    });
    db = openDatabase(":memory:", { wal: false });
    runMigrations(db);
    const registration = await registerUser(
      db,
      {
        email: "rules@example.test",
        password: "RulesByThirty!",
        householdName: "Rule builders",
      },
      config,
    );
    const otherRegistration = await registerUser(
      db,
      {
        email: "other-rules@example.test",
        password: "OtherRulesByThirty!",
        householdName: "Other household",
      },
      config,
    );
    householdId = registration.householdId;
    userId = registration.userId;
    otherHouseholdId = otherRegistration.householdId;
    const session = await createSession(db, userId, config);
    sessionToken = session.token;
    csrfToken = session.csrfToken;
    app = new Hono<AppEnv>();
    app.route("/api/v1", createPlanningRoutes(db, config));
    app.onError((error, context) => {
      if (error instanceof AppError) {
        return context.json(
          { error: { code: error.code, message: error.message } },
          error.status as 400,
        );
      }
      if (error instanceof ZodError) {
        return context.json({ error: { code: "validation_failed" } }, 422);
      }
      throw error;
    });
  });

  afterEach(() => closeDatabase(db));

  async function request(path: string, body?: unknown, method = body ? "POST" : "GET") {
    return app.request(`http://localhost${path}`, {
      method,
      headers: {
        cookie: `bw_session=${sessionToken}; bw_household=${householdId}; bw_csrf=${csrfToken}`,
        origin: config.WEB_ORIGIN,
        "x-csrf-token": csrfToken,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  test("previews, scopes, protects provenance, applies, and deletes deterministic rules", async () => {
    const accountId = ulid();
    const otherAccountId = ulid();
    await db.insert(accounts).values([
      {
        id: accountId,
        householdId,
        ownerUserId: userId,
        name: "Rule checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isManual: true,
      },
      {
        id: otherAccountId,
        householdId: otherHouseholdId,
        ownerUserId: null,
        name: "Other checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isManual: true,
      },
    ]);
    const transactionId = ulid();
    const otherTransactionId = ulid();
    await db.insert(transactions).values([
      {
        id: transactionId,
        householdId,
        accountId,
        amount: -525n,
        currency: "USD",
        transactedOn: "2026-07-15",
        postedAt: "2026-07-15T12:00:00.000Z",
        rawDescription: "COFFEE SHOP",
        normalizedDescription: "COFFEE SHOP",
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      },
      {
        id: otherTransactionId,
        householdId: otherHouseholdId,
        accountId: otherAccountId,
        amount: -525n,
        currency: "USD",
        transactedOn: "2026-07-15",
        postedAt: "2026-07-15T12:00:00.000Z",
        rawDescription: "COFFEE SHOP",
        normalizedDescription: "COFFEE SHOP",
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      },
    ]);
    const [food, otherFood] = await Promise.all([
      db
        .select()
        .from(categories)
        .where(and(eq(categories.householdId, householdId), eq(categories.slug, "food")))
        .get(),
      db
        .select()
        .from(categories)
        .where(and(eq(categories.householdId, otherHouseholdId), eq(categories.slug, "food")))
        .get(),
    ]);
    expect(food).toBeDefined();
    expect(otherFood).toBeDefined();

    const condition = {
      field: "normalizedDescription",
      operator: "exact",
      value: "COFFEE SHOP",
      caseSensitive: false,
    };
    const actions = [{ type: "setCategory", categoryId: food?.id }];

    const forgedOrigin = await request("/api/v1/rules", {
      name: "Forged system rule",
      priority: 900,
      enabled: true,
      origin: "system",
      conditions: condition,
      actions,
    });
    expect(forgedOrigin.status).toBe(422);

    const createResponse = await request("/api/v1/rules", {
      name: "Coffee is food",
      priority: 700,
      enabled: true,
      origin: "user",
      conditions: condition,
      actions,
    });
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as { id: string; origin: string };
    expect(created.origin).toBe("user");

    const crossHouseholdCategory = await request("/api/v1/rules/preview", {
      conditions: condition,
      actions: [{ type: "setCategory", categoryId: otherFood?.id }],
    });
    expect(crossHouseholdCategory.status).toBe(400);
    expect(await crossHouseholdCategory.json()).toHaveProperty(
      "error.code",
      "invalid_rule_reference",
    );

    const crossHouseholdAccount = await request("/api/v1/rules/preview", {
      conditions: {
        field: "accountId",
        operator: "exact",
        value: otherAccountId,
        caseSensitive: false,
      },
      actions,
    });
    expect(crossHouseholdAccount.status).toBe(400);

    const overlappingResponse = await request("/api/v1/rules", {
      name: "Coffee overlap",
      priority: 600,
      enabled: true,
      conditions: condition,
      actions,
    });
    expect(overlappingResponse.status).toBe(201);
    const overlapping = (await overlappingResponse.json()) as { id: string };

    const previewResponse = await request("/api/v1/rules/preview", {
      name: "Coffee edit preview",
      priority: 700,
      conditions: condition,
      actions,
      excludeRuleId: created.id,
    });
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()) as {
      matchCount: number;
      samples: Array<{ id: string }>;
      conflicts: Array<{ id: string }>;
    };
    expect(preview.matchCount).toBe(1);
    expect(preview.samples.map((sample) => sample.id)).toEqual([transactionId]);
    expect(preview.conflicts.map((rule) => rule.id)).toEqual([overlapping.id]);

    const forgedPatch = await request(`/api/v1/rules/${created.id}`, { origin: "system" }, "PATCH");
    expect(forgedPatch.status).toBe(422);

    const systemRuleId = ulid();
    const systemCondition = {
      field: "normalizedDescription" as const,
      operator: "exact" as const,
      value: "PAYROLL",
      caseSensitive: false,
    };
    await db.insert(rules).values({
      id: systemRuleId,
      householdId,
      name: "Payroll guardrail",
      priority: 1_000,
      isEnabled: true,
      origin: "system",
      conditions: systemCondition as unknown as JsonObject,
      actions: [{ type: "requestReview", value: false }] as unknown as JsonObject,
      specificityScore: ruleSpecificity(systemCondition),
    });
    const rewriteSystem = await request(
      `/api/v1/rules/${systemRuleId}`,
      { name: "Browser rewrote system" },
      "PATCH",
    );
    expect(rewriteSystem.status).toBe(409);
    const pauseSystem = await request(`/api/v1/rules/${systemRuleId}`, { enabled: false }, "PATCH");
    expect(pauseSystem.status).toBe(200);
    const deleteSystem = await request(`/api/v1/rules/${systemRuleId}`, undefined, "DELETE");
    expect(deleteSystem.status).toBe(409);

    const applyResponse = await request(`/api/v1/rules/${created.id}/apply`, {});
    expect(applyResponse.status).toBe(200);
    expect(await applyResponse.json()).toHaveProperty("affected", 1);
    const [primaryTransaction, otherTransaction] = await Promise.all([
      db.select().from(transactions).where(eq(transactions.id, transactionId)).get(),
      db.select().from(transactions).where(eq(transactions.id, otherTransactionId)).get(),
    ]);
    expect(primaryTransaction?.categoryId).toBe(food?.id);
    expect(otherTransaction?.categoryId).toBeNull();

    const deleteResponse = await request(`/api/v1/rules/${created.id}`, undefined, "DELETE");
    expect(deleteResponse.status).toBe(204);
    expect(await db.select().from(rules).where(eq(rules.id, created.id)).get()).toBeUndefined();
    const preservedRun = await db
      .select()
      .from(ruleRuns)
      .where(eq(ruleRuns.transactionId, transactionId))
      .get();
    expect(preservedRun).toBeDefined();
    expect(preservedRun?.winningRuleId).toBeNull();

    const missingDelete = await request(`/api/v1/rules/${ulid()}`, undefined, "DELETE");
    expect(missingDelete.status).toBe(404);
  });
});
