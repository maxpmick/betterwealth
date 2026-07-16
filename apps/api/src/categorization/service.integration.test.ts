import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  aiSuggestions,
  categories,
  closeDatabase,
  createHouseholdRepositories,
  openDatabase,
  rules,
  runMigrations,
  settings,
  transactions,
} from "@betterwealth/db";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import { FieldCipher } from "../lib/crypto";
import { categorizeHouseholdTransactions } from "./service";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

describe("AI-first categorization becomes deterministic", () => {
  test("uses the model for the first merchant pattern and the saved rule thereafter", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "c".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "rules@example.com",
        password: "RulesBecomeCertain!2026",
        householdName: "Rules test",
      },
      config,
    );
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");

    const settingId = ulid();
    const aad = `settings:${registered.householdId}:${registered.userId}:openrouter`;
    const encrypted = new FieldCipher(config.ENCRYPTION_KEY).encrypt(
      JSON.stringify({
        enabled: true,
        consent: true,
        baseUrl: "https://openrouter.ai/api/v1",
        model: "test/model",
        apiKey: "test-key-that-is-long-enough",
        confidenceThreshold: 0.9,
      }),
      aad,
    );
    createHouseholdRepositories(db, registered.householdId).settings.set(
      settingId,
      "integration.openrouter",
      { encrypted },
      registered.userId,
    );
    await db.update(settings).set({ isSecret: true }).where(eq(settings.id, settingId));

    const accountId = ulid();
    await db.insert(accounts).values({
      id: accountId,
      householdId: registered.householdId,
      ownerUserId: registered.userId,
      name: "Checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      isLiability: false,
      isManual: true,
    });
    const insertTransaction = async (description: string, day: string) => {
      const id = ulid();
      await db.insert(transactions).values({
        id,
        householdId: registered.householdId,
        accountId,
        amount: -4_267n,
        currency: "USD",
        transactedOn: day,
        postedAt: `${day}T12:00:00.000Z`,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
      return id;
    };
    const firstId = await insertTransaction("TRADER JOES STORE 149", "2026-07-15");
    let modelCalls = 0;
    const suggestCategory = async () => {
      modelCalls += 1;
      return {
        merchant: "Trader Joes",
        categoryId: food.id,
        confidence: 0.97,
        rationale: "A grocery merchant",
        proposedRule: {
          descriptionContains: "TRADER JOES",
          merchantEquals: "Trader Joes",
          direction: "outflow" as const,
        },
      };
    };

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
      }),
    ).toMatchObject({ aiCalls: 1, aiAccepted: 1, deterministic: 0 });
    expect(modelCalls).toBe(1);
    expect(
      await db
        .select({ categoryId: transactions.categoryId, reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, firstId))
        .get(),
    ).toEqual({ categoryId: food.id, reviewState: "none" });
    const savedRules = await db.select().from(rules);
    expect(savedRules).toHaveLength(1);
    expect(savedRules[0]?.origin).toBe("ai");
    expect(JSON.stringify(savedRules[0]?.conditions)).not.toContain(".*");
    expect(await db.select().from(aiSuggestions)).toHaveLength(1);

    const secondId = await insertTransaction("TRADER JOES STORE 200", "2026-07-16");
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
      }),
    ).toMatchObject({ aiCalls: 0, aiAccepted: 0, deterministic: 1 });
    expect(modelCalls).toBe(1);
    expect(
      await db
        .select({ categoryId: transactions.categoryId, reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, secondId))
        .get(),
    ).toEqual({ categoryId: food.id, reviewState: "none" });
  });
});
