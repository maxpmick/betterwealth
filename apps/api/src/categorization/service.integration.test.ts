import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  aiSuggestions,
  categories,
  closeDatabase,
  createHouseholdRepositories,
  householdMembers,
  merchants,
  openDatabase,
  refundLinks,
  ruleRuns,
  rules,
  runMigrations,
  settings,
  transactions,
} from "@betterwealth/db";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import { FieldCipher } from "../lib/crypto";
import { AppError } from "../lib/errors";
import { categorizeHouseholdTransactions } from "./service";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

async function configureAiForUser(
  db: ReturnType<typeof openDatabase>,
  config: ReturnType<typeof loadConfig>,
  householdId: string,
  userId: string,
) {
  const settingId = ulid();
  const aad = `settings:${householdId}:${userId}:openrouter`;
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
  createHouseholdRepositories(db, householdId).settings.set(
    settingId,
    "integration.openrouter",
    { encrypted },
    userId,
  );
  await db.update(settings).set({ isSecret: true }).where(eq(settings.id, settingId));
}

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

    await configureAiForUser(db, config, registered.householdId, registered.userId);

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
    const insertTransaction = async (description: string, day: string, staleFlags = false) => {
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
        isExcluded: staleFlags,
        isIncome: staleFlags,
        isReimbursement: staleFlags,
      });
      return id;
    };
    const firstId = await insertTransaction("TRADER JOES STORE 149", "2026-07-15", true);
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
        .select({
          categoryId: transactions.categoryId,
          reviewState: transactions.reviewState,
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          isIncome: transactions.isIncome,
          isReimbursement: transactions.isReimbursement,
        })
        .from(transactions)
        .where(eq(transactions.id, firstId))
        .get(),
    ).toEqual({
      categoryId: food.id,
      reviewState: "none",
      isTransfer: false,
      isExcluded: false,
      isIncome: false,
      isReimbursement: false,
    });
    const savedRules = await db.select().from(rules);
    expect(savedRules).toHaveLength(1);
    expect(savedRules[0]?.origin).toBe("ai");
    expect(JSON.stringify(savedRules[0]?.conditions)).not.toContain(".*");
    expect(await db.select().from(aiSuggestions)).toHaveLength(1);

    const secondId = await insertTransaction("TRADER JOES STORE 200", "2026-07-16", true);
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
        .select({
          categoryId: transactions.categoryId,
          reviewState: transactions.reviewState,
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          isIncome: transactions.isIncome,
          isReimbursement: transactions.isReimbursement,
        })
        .from(transactions)
        .where(eq(transactions.id, secondId))
        .get(),
    ).toEqual({
      categoryId: food.id,
      reviewState: "none",
      isTransfer: false,
      isExcluded: false,
      isIncome: false,
      isReimbursement: false,
    });
  });

  test("preserves confirmed refund reporting truth through AI and deterministic categorization", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "f".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "confirmed-refund-categorization@example.com",
        password: "RefundTruthSurvives!2026",
        householdName: "Confirmed refund test",
      },
      config,
    );
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
    await configureAiForUser(db, config, registered.householdId, registered.userId);
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
    const refundIds: string[] = [];
    for (const [index, day] of ["2026-07-10", "2026-07-12"].entries()) {
      const purchaseId = ulid();
      const refundId = ulid();
      refundIds.push(refundId);
      await db.insert(transactions).values([
        {
          id: purchaseId,
          householdId: registered.householdId,
          accountId,
          amount: -4_267n,
          currency: "USD",
          transactedOn: `2026-07-0${index + 1}`,
          rawDescription: "MERCHANT PURCHASE",
          normalizedDescription: "MERCHANT PURCHASE",
          status: "posted",
          source: "manual",
          reviewState: "none",
        },
        {
          id: refundId,
          householdId: registered.householdId,
          accountId,
          amount: 4_267n,
          currency: "USD",
          transactedOn: day,
          rawDescription: "MERCHANT REFUND",
          normalizedDescription: "MERCHANT REFUND",
          status: "posted",
          source: "manual",
          reviewState: "needs_review",
          isReimbursement: true,
        },
      ]);
      await db.insert(refundLinks).values({
        id: ulid(),
        householdId: registered.householdId,
        refundTransactionId: refundId,
        purchaseTransactionId: purchaseId,
        amount: 4_267n,
        confidenceBps: 10_000,
        status: "confirmed",
      });
    }
    let calls = 0;
    const result = await categorizeHouseholdTransactions({
      db,
      config,
      householdId: registered.householdId,
      userId: registered.userId,
      suggestCategory: async () => {
        calls += 1;
        return {
          merchant: "Merchant",
          categoryId: food.id,
          confidence: 0.97,
          rationale: "A confirmed merchant refund",
          proposedRule: { descriptionContains: "MERCHANT REFUND", direction: "inflow" as const },
        };
      },
    });
    expect(result).toMatchObject({ aiCalls: 1, aiAccepted: 1, deterministic: 1 });
    expect(calls).toBe(1);
    const categorizedRefunds = await db
      .select({
        id: transactions.id,
        categoryId: transactions.categoryId,
        isIncome: transactions.isIncome,
        isTransfer: transactions.isTransfer,
        isExcluded: transactions.isExcluded,
        isReimbursement: transactions.isReimbursement,
      })
      .from(transactions)
      .where(inArray(transactions.id, refundIds));
    expect(categorizedRefunds).toHaveLength(2);
    expect(categorizedRefunds).toEqual(
      expect.arrayContaining(
        refundIds.map((id) => ({
          id,
          categoryId: food.id,
          isIncome: false,
          isTransfer: false,
          isExcluded: false,
          isReimbursement: true,
        })),
      ),
    );
  });

  test("web-verifies a fresh result and expands a deduplicated parent/child taxonomy", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "a".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "verified-rules@example.com",
        password: "WebGroundedRules!2026",
        householdName: "Verification test",
      },
      config,
    );
    const fallback = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!fallback) throw new Error("Default Food category was not created");
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const accountId = ulid();
    const transactionId = ulid();
    const parkedTransactionId = ulid();
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
    await db.insert(transactions).values([
      {
        id: parkedTransactionId,
        householdId: registered.householdId,
        accountId,
        amount: -4_000n,
        currency: "USD",
        transactedOn: "2026-07-15",
        rawDescription: "PARKED BEFORE TAXONOMY EXPANSION",
        normalizedDescription: "PARKED BEFORE TAXONOMY EXPANSION",
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      },
      {
        id: transactionId,
        householdId: registered.householdId,
        accountId,
        amount: -12_500n,
        currency: "USD",
        transactedOn: "2026-07-16",
        rawDescription: "MYSTERY FLIGHT CLUB MEMBERSHIP",
        normalizedDescription: "MYSTERY FLIGHT CLUB MEMBERSHIP",
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      },
    ]);

    const result = await categorizeHouseholdTransactions({
      db,
      config,
      householdId: registered.householdId,
      userId: registered.userId,
      suggestCategory: async () => ({
        merchant: "Mystery Flight Club",
        categoryId: fallback.id,
        confidence: 0.82,
        rationale: "The first pass had no exact category.",
      }),
      verifyCategory: async (providerInput) => {
        expect(providerInput.previousSuggestion.categoryId).toBe(fallback.id);
        expect(providerInput.transaction).not.toHaveProperty("amount");
        if (providerInput.transaction.normalizedDescription.startsWith("PARKED")) {
          return {
            merchant: "Parked Merchant",
            categoryId: fallback.id,
            confidence: 0.5,
            rationale: "This transaction still needs a person.",
            research: {
              requested: true,
              citationCount: 1,
              citationHosts: ["parked-merchant.test"],
            },
          };
        }
        return {
          merchant: "Mystery Flight Club",
          proposedCategory: {
            topLevelName: "Aviation",
            childName: "Flight Training",
            kind: "expense" as const,
          },
          confidence: 0.96,
          rationale: "Independent public evidence identifies a flight-training membership.",
          proposedRule: {
            descriptionContains: "MYSTERY FLIGHT CLUB",
            direction: "outflow" as const,
          },
          research: {
            requested: true,
            citationCount: 2,
            citationHosts: ["example-flight-school.test"],
          },
        };
      },
    });

    expect(result).toMatchObject({
      aiCalls: 2,
      aiVerificationCalls: 2,
      aiVerified: 2,
      aiVerificationFailed: 0,
      aiResearchCitations: 3,
      aiResearchHosts: ["example-flight-school.test", "parked-merchant.test"],
      aiCreatedCategories: 2,
      aiAccepted: 1,
      aiPending: 1,
    });
    const created = await db
      .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
      .from(categories)
      .where(eq(categories.householdId, registered.householdId));
    const parent = created.find(({ name }) => name === "Aviation");
    const child = created.find(({ name }) => name === "Flight Training");
    expect(parent?.parentId).toBeNull();
    expect(child?.parentId).toBe(parent?.id);
    if (!child) throw new Error("Verified child category was not materialized");
    expect(
      await db
        .select({ categoryId: transactions.categoryId })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .get(),
    ).toEqual({ categoryId: child.id });
    expect((await db.select().from(rules)).some(({ origin }) => origin === "ai")).toBeTrue();

    let duplicateCalls = 0;
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: async () => {
          duplicateCalls += 1;
          return {
            merchant: "Should not be called",
            categoryId: fallback.id,
            confidence: 0.5,
            rationale: "Duplicate",
          };
        },
      }),
    ).toMatchObject({ aiCalls: 0, aiPreviouslyAttempted: 1 });
    expect(duplicateCalls).toBe(0);
    expect(
      await db
        .select({ id: aiSuggestions.id })
        .from(aiSuggestions)
        .where(eq(aiSuggestions.transactionId, parkedTransactionId)),
    ).toHaveLength(1);

    const laterTransactionId = ulid();
    await db.insert(transactions).values({
      id: laterTransactionId,
      householdId: registered.householdId,
      accountId,
      amount: -8_000n,
      currency: "USD",
      transactedOn: "2026-07-17",
      rawDescription: "AIRFIELD LESSON PACKAGE",
      normalizedDescription: "AIRFIELD LESSON PACKAGE",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    const secondResult = await categorizeHouseholdTransactions({
      db,
      config,
      householdId: registered.householdId,
      userId: registered.userId,
      suggestCategory: async () => ({
        merchant: "Airfield Lessons",
        categoryId: fallback.id,
        confidence: 0.75,
        rationale: "First pass remained uncertain.",
      }),
      verifyCategory: async (providerInput) => {
        expect(
          providerInput.categories.some(
            ({ id, path }) => id === child.id && path === "Aviation / Flight Training",
          ),
        ).toBeTrue();
        return {
          merchant: "Airfield Lessons",
          categoryId: child.id,
          confidence: 0.95,
          rationale: "The expanded taxonomy now contains the exact category.",
          research: { requested: true, citationCount: 1, citationHosts: ["airfield.test"] },
        };
      },
    });
    expect(secondResult).toMatchObject({ aiVerified: 1, aiCreatedCategories: 0, aiAccepted: 1 });
    expect((await db.select().from(categories)).length).toBe(created.length);
  });

  test("skips a parked fingerprint so bounded AI batches keep moving", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "d".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
      BOOTSTRAP_OPENROUTER_API_KEY: "test-key-that-is-long-enough",
    });
    const registered = await registerUser(
      db,
      {
        email: "progress@example.com",
        password: "ProgressIsBounded!2026",
        householdName: "Progress test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
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
    for (const [index, description] of [
      "UNCERTAIN ONE",
      "UNCERTAIN TWO",
      "UNCERTAIN TWO",
    ].entries()) {
      await db.insert(transactions).values({
        id: ulid(),
        householdId: registered.householdId,
        accountId,
        amount: -1_000n - BigInt(index),
        currency: "USD",
        transactedOn: `2026-07-${String(index + 1).padStart(2, "0")}`,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
    }
    let calls = 0;
    const lowConfidence = async () => {
      calls += 1;
      return {
        merchant: `Uncertain ${calls}`,
        categoryId: food.id,
        confidence: 0.5,
        rationale: "Needs review",
        proposedRule: { direction: "outflow" as const },
      };
    };

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 1,
        suggestCategory: lowConfidence,
      }),
    ).toMatchObject({ aiCalls: 1, aiPending: 1 });
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 10,
        suggestCategory: lowConfidence,
      }),
    ).toMatchObject({ aiCalls: 1, aiPending: 1, aiPreviouslyAttempted: 2 });
    expect(calls).toBe(2);
    expect(await db.select().from(aiSuggestions)).toHaveLength(2);
  });

  test("a new deterministic rule can still resolve a previously parked suggestion", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "e".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
      BOOTSTRAP_OPENROUTER_API_KEY: "test-key-that-is-long-enough",
    });
    const registered = await registerUser(
      db,
      {
        email: "parked@example.com",
        password: "ParkedCanRecover!2026",
        householdName: "Parked test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
    const accountId = ulid();
    const transactionId = ulid();
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
    await db.insert(transactions).values({
      id: transactionId,
      householdId: registered.householdId,
      accountId,
      amount: -1_234n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "PARKED MERCHANT",
      normalizedDescription: "PARKED MERCHANT",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    await categorizeHouseholdTransactions({
      db,
      config,
      householdId: registered.householdId,
      userId: registered.userId,
      aiLimit: 1,
      suggestCategory: async () => ({
        merchant: "Parked Merchant",
        categoryId: food.id,
        confidence: 0.5,
        rationale: "Needs review",
        proposedRule: { direction: "outflow" as const },
      }),
    });
    await db.insert(rules).values({
      id: ulid(),
      householdId: registered.householdId,
      name: "Resolve parked merchant",
      priority: 500,
      origin: "user",
      conditions: {
        field: "normalizedDescription",
        operator: "exact",
        value: "PARKED MERCHANT",
        caseSensitive: false,
      } as unknown as Record<string, unknown>,
      actions: [{ type: "setCategory", categoryId: food.id }] as unknown as Record<string, unknown>,
      specificityScore: 100,
      createdByUserId: registered.userId,
    });

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 1,
      }),
    ).toMatchObject({ deterministic: 1, aiCalls: 0 });
    expect(
      await db
        .select({ categoryId: transactions.categoryId, reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .get(),
    ).toEqual({ categoryId: food.id, reviewState: "none" });
  });

  test("a failed provider pattern is attempted only once across in-memory batches", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "a".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
      BOOTSTRAP_OPENROUTER_API_KEY: "test-key-that-is-long-enough",
    });
    const registered = await registerUser(
      db,
      {
        email: "failed-pattern@example.com",
        password: "FailedPatternStops!2026",
        householdName: "Failed pattern test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
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
    await db.insert(transactions).values({
      id: ulid(),
      householdId: registered.householdId,
      accountId,
      amount: -999n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "PROVIDER TIMEOUT PATTERN",
      normalizedDescription: "PROVIDER TIMEOUT PATTERN",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    let calls = 0;
    const attemptedFingerprints = new Set<string>();
    const failingProvider = async (): Promise<never> => {
      calls += 1;
      throw new Error("synthetic timeout");
    };
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 25,
        suggestCategory: failingProvider,
        attemptedFingerprints,
      }),
    ).toMatchObject({ aiCalls: 1, aiFailed: 1 });
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 25,
        suggestCategory: failingProvider,
        attemptedFingerprints,
      }),
    ).toMatchObject({ aiCalls: 0, aiFailed: 0, aiPreviouslyAttempted: 1 });
    expect(calls).toBe(1);
  });

  test("does not treat a bootstrap key as per-user disclosure consent", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "b".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
      BOOTSTRAP_OPENROUTER_API_KEY: "global-key-without-user-consent",
    });
    const registered = await registerUser(
      db,
      {
        email: "no-consent@example.com",
        password: "NoImplicitConsent!2026",
        householdName: "Consent test",
      },
      config,
    );
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
    await db.insert(transactions).values({
      id: ulid(),
      householdId: registered.householdId,
      accountId,
      amount: -1_000n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "PRIVATE TRANSACTION",
      normalizedDescription: "PRIVATE TRANSACTION",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    let calls = 0;

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: async () => {
          calls += 1;
          throw new Error("must not be called");
        },
      }),
    ).toMatchObject({ aiCalls: 0, aiFailed: 0 });
    expect(calls).toBe(0);
  });

  test("scopes AI disclosure and parked fingerprints to the configured account owner", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "6".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const owner = await registerUser(
      db,
      {
        email: "owner-scope@example.com",
        password: "OwnerScopedConsent!2026",
        householdName: "Scoped household",
      },
      config,
    );
    const member = await registerUser(
      db,
      {
        email: "member-scope@example.com",
        password: "MemberScopedConsent!2026",
        householdName: "Temporary member household",
      },
      config,
    );
    await db.insert(householdMembers).values({
      householdId: owner.householdId,
      userId: member.userId,
      role: "member",
      status: "active",
    });
    await configureAiForUser(db, config, owner.householdId, owner.userId);
    await configureAiForUser(db, config, owner.householdId, member.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, owner.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");

    const accountRows = [
      { id: ulid(), name: "Owner private", ownerUserId: owner.userId },
      { id: ulid(), name: "Member private", ownerUserId: member.userId },
      { id: ulid(), name: "Ownerless household", ownerUserId: null },
    ];
    await db.insert(accounts).values(
      accountRows.map((account) => ({
        ...account,
        householdId: owner.householdId,
        group: "cash" as const,
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      })),
    );
    const transactionIds = new Map<string, string>();
    for (const [index, account] of accountRows.entries()) {
      const description = `${account.name.toUpperCase()} PATTERN`;
      const id = ulid();
      transactionIds.set(description, id);
      await db.insert(transactions).values({
        id,
        householdId: owner.householdId,
        accountId: account.id,
        amount: -1_000n - BigInt(index),
        currency: "USD",
        transactedOn: `2026-07-0${index + 1}`,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
    }
    const disclosures: string[] = [];
    const lowConfidence = async (providerInput: {
      transaction: { normalizedDescription: string };
    }) => {
      disclosures.push(providerInput.transaction.normalizedDescription);
      return {
        merchant: providerInput.transaction.normalizedDescription,
        categoryId: food.id,
        confidence: 0.5,
        rationale: "Owner-scoped review",
        proposedRule: { direction: "outflow" as const },
      };
    };

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: owner.householdId,
        userId: owner.userId,
        suggestCategory: lowConfidence,
      }),
    ).toMatchObject({ aiCalls: 1, aiPending: 1 });
    expect(disclosures).toEqual(["OWNER PRIVATE PATTERN"]);

    disclosures.length = 0;
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: owner.householdId,
        userId: member.userId,
        suggestCategory: lowConfidence,
      }),
    ).toMatchObject({ aiCalls: 1, aiPending: 1 });
    expect(disclosures).toEqual(["MEMBER PRIVATE PATTERN"]);
    expect(
      (await db.select().from(aiSuggestions)).map(({ transactionId }) => transactionId).sort(),
    ).toEqual(
      [transactionIds.get("OWNER PRIVATE PATTERN"), transactionIds.get("MEMBER PRIVATE PATTERN")]
        .filter((id): id is string => Boolean(id))
        .sort(),
    );
    expect(
      await db
        .select({ reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, transactionIds.get("OWNERLESS HOUSEHOLD PATTERN") ?? ""))
        .get(),
    ).toEqual({ reviewState: "needs_review" });
  });

  test("rejects every stale AI snapshot predicate without persisting partial acceptance", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "7".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "stale-ai-snapshot@example.com",
        password: "EverySnapshotField!2026",
        householdName: "Stale snapshot test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
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
    const ids = new Map<string, string>();
    for (const [index, field] of [
      "STATUS",
      "REVIEW STATE",
      "DESCRIPTION",
      "AMOUNT",
      "USER OVERRIDE",
    ].entries()) {
      const description = `STALE ${field}`;
      const id = ulid();
      ids.set(description, id);
      await db.insert(transactions).values({
        id,
        householdId: registered.householdId,
        accountId,
        amount: -2_000n - BigInt(index),
        currency: "USD",
        transactedOn: `2026-07-${String(index + 1).padStart(2, "0")}`,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
    }
    let calls = 0;
    const staleProvider: NonNullable<
      Parameters<typeof categorizeHouseholdTransactions>[0]["suggestCategory"]
    > = async ({ transaction }) => {
      calls += 1;
      const id = ids.get(transaction.normalizedDescription);
      if (!id) throw new Error("Missing stale test transaction");
      if (transaction.normalizedDescription === "STALE STATUS") {
        await db.update(transactions).set({ status: "pending" }).where(eq(transactions.id, id));
      } else if (transaction.normalizedDescription === "STALE REVIEW STATE") {
        await db.update(transactions).set({ reviewState: "none" }).where(eq(transactions.id, id));
      } else if (transaction.normalizedDescription === "STALE DESCRIPTION") {
        await db
          .update(transactions)
          .set({ normalizedDescription: "CHANGED WHILE AI RAN" })
          .where(eq(transactions.id, id));
      } else if (transaction.normalizedDescription === "STALE AMOUNT") {
        await db.update(transactions).set({ amount: -2_999n }).where(eq(transactions.id, id));
      } else {
        await db
          .update(transactions)
          .set({ userOverrideAt: "2026-07-16T12:00:00.000Z" })
          .where(eq(transactions.id, id));
      }
      return {
        merchant: "Stale Merchant",
        categoryId: food.id,
        confidence: 0.99,
        rationale: "This result must lose the race",
        proposedRule: { direction: "outflow" },
      };
    };

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: staleProvider,
      }),
    ).toMatchObject({ aiCalls: 5, aiAccepted: 0, aiPending: 0 });
    expect(calls).toBe(5);
    expect(await db.select().from(aiSuggestions)).toHaveLength(0);
    expect(await db.select().from(rules).where(eq(rules.origin, "ai"))).toHaveLength(0);
    expect(
      await db.select().from(merchants).where(eq(merchants.normalizedName, "STALE MERCHANT")),
    ).toHaveLength(0);
  });

  test("rolls back and retries an interrupted accepted AI write as one unit", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "8".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "atomic-ai-accept@example.com",
        password: "AtomicAcceptance!2026",
        householdName: "Atomic acceptance test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
    const accountId = ulid();
    const transactionId = ulid();
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
    await db.insert(transactions).values({
      id: transactionId,
      householdId: registered.householdId,
      accountId,
      amount: -3_200n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "ATOMIC ACCEPTANCE",
      normalizedDescription: "ATOMIC ACCEPTANCE",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    let calls = 0;
    const acceptedProvider = async () => {
      calls += 1;
      return {
        merchant: "Atomic Merchant",
        categoryId: food.id,
        confidence: 0.99,
        rationale: "High-confidence atomic result",
        proposedRule: { descriptionContains: "ATOMIC ACCEPTANCE", direction: "outflow" as const },
      };
    };
    const run = () =>
      categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: acceptedProvider,
      });

    db.$client.exec(`
      CREATE TRIGGER fail_atomic_ai_update
      BEFORE UPDATE OF category_origin ON transactions
      WHEN NEW.category_origin = 'ai'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic accepted write failure');
      END
    `);
    await expect(run()).rejects.toThrow();
    expect(await db.select().from(aiSuggestions)).toHaveLength(0);
    expect(await db.select().from(rules).where(eq(rules.origin, "ai"))).toHaveLength(0);
    expect(
      await db.select().from(merchants).where(eq(merchants.normalizedName, "ATOMIC MERCHANT")),
    ).toHaveLength(0);
    expect(
      await db
        .select({ categoryId: transactions.categoryId, reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .get(),
    ).toEqual({ categoryId: null, reviewState: "needs_review" });

    db.$client.exec("DROP TRIGGER fail_atomic_ai_update");
    expect(await run()).toMatchObject({ aiCalls: 1, aiAccepted: 1 });
    expect(calls).toBe(2);
    expect(await db.select().from(aiSuggestions)).toEqual([
      expect.objectContaining({ status: "accepted", reviewedByUserId: registered.userId }),
    ]);
    expect(await db.select().from(rules).where(eq(rules.origin, "ai"))).toHaveLength(1);
    expect(
      await db
        .select({ categoryId: transactions.categoryId, reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .get(),
    ).toEqual({ categoryId: food.id, reviewState: "none" });
  });

  test("evaluates pending status truthfully and excludes removed or void transactions", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "1".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "status-filter@example.com",
        password: "PendingIsNotPosted!2026",
        householdName: "Status filter test",
      },
      config,
    );
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
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
    const ids = {
      pending: ulid(),
      posted: ulid(),
      removed: ulid(),
      void: ulid(),
    };
    await db.insert(transactions).values(
      Object.entries(ids).map(([status, id]) => ({
        id,
        householdId: registered.householdId,
        accountId,
        amount: -500n,
        currency: "USD",
        transactedOn: "2026-07-01",
        rawDescription: "STATUS SENSITIVE",
        normalizedDescription: "STATUS SENSITIVE",
        status: status as "pending" | "posted" | "removed" | "void",
        source: "manual" as const,
        reviewState: "needs_review" as const,
      })),
    );
    await db.insert(rules).values({
      id: ulid(),
      householdId: registered.householdId,
      name: "Pending-only categorization",
      priority: 500,
      origin: "user",
      conditions: {
        all: [
          {
            field: "normalizedDescription",
            operator: "exact",
            value: "STATUS SENSITIVE",
            caseSensitive: false,
          },
          { field: "status", operator: "exact", value: "pending" },
        ],
      } as unknown as Record<string, unknown>,
      actions: [{ type: "setCategory", categoryId: food.id }] as unknown as Record<string, unknown>,
      specificityScore: 1_000,
      createdByUserId: registered.userId,
    });

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 0,
      }),
    ).toMatchObject({ candidates: 2, deterministic: 1, aiCalls: 0 });
    const rows = await db
      .select({ id: transactions.id, categoryId: transactions.categoryId })
      .from(transactions);
    const categoryByTransaction = new Map(rows.map((row) => [row.id, row.categoryId]));
    expect(categoryByTransaction.get(ids.pending)).toBe(food.id);
    expect(categoryByTransaction.get(ids.posted)).toBeNull();
    expect(categoryByTransaction.get(ids.removed)).toBeNull();
    expect(categoryByTransaction.get(ids.void)).toBeNull();
  });

  test("stores distinct deterministic rules for opposite directions with the same display name", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "2".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "rule-identity@example.com",
        password: "ConditionsAreIdentity!2026",
        householdName: "Rule identity test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
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
    const insert = async (amount: bigint, date: string) => {
      const id = ulid();
      await db.insert(transactions).values({
        id,
        householdId: registered.householdId,
        accountId,
        amount,
        currency: "USD",
        transactedOn: date,
        rawDescription: "DUAL MERCHANT",
        normalizedDescription: "DUAL MERCHANT",
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
      return id;
    };
    let calls = 0;
    const suggestCategory = async (providerInput: {
      transaction: { direction: "inflow" | "outflow" };
    }) => {
      calls += 1;
      return {
        merchant: "Dual Merchant",
        categoryId: food.id,
        confidence: 0.99,
        rationale: "Direction-scoped pattern",
        proposedRule: {
          descriptionContains: "DUAL MERCHANT",
          direction: providerInput.transaction.direction,
        },
      };
    };
    await insert(-2_000n, "2026-07-01");
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
      }),
    ).toMatchObject({ aiCalls: 1, aiAccepted: 1 });
    const firstInflowId = await insert(2_000n, "2026-07-02");
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
      }),
    ).toMatchObject({ aiCalls: 1, aiAccepted: 1 });
    expect(
      await db
        .select({
          reviewState: transactions.reviewState,
          isReimbursement: transactions.isReimbursement,
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
        })
        .from(transactions)
        .where(eq(transactions.id, firstInflowId))
        .get(),
    ).toEqual({
      reviewState: "needs_review",
      isReimbursement: false,
      isTransfer: false,
      isExcluded: false,
    });
    expect(await db.select().from(rules).where(eq(rules.origin, "ai"))).toHaveLength(2);
    await insert(2_100n, "2026-07-03");
    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
      }),
    ).toMatchObject({ deterministic: 2, aiCalls: 0 });
    expect(calls).toBe(2);
  });

  test("a review-requesting deterministic rule records only its first state change", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "3".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "rule-run-idempotency@example.com",
        password: "OneRuleRunPerChange!2026",
        householdName: "Rule run idempotency test",
      },
      config,
    );
    const income = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Income")))
      .get();
    if (!income) throw new Error("Default Income category was not created");
    const accountId = ulid();
    const transactionId = ulid();
    const ruleId = ulid();
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
    await db.insert(transactions).values({
      id: transactionId,
      householdId: registered.householdId,
      accountId,
      amount: -10_000n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "PAYROLL REVERSAL",
      normalizedDescription: "PAYROLL REVERSAL",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    await db.insert(rules).values({
      id: ruleId,
      householdId: registered.householdId,
      name: "Review payroll reversals",
      priority: 500,
      origin: "user",
      conditions: {
        field: "normalizedDescription",
        operator: "exact",
        value: "PAYROLL REVERSAL",
        caseSensitive: false,
      } as unknown as Record<string, unknown>,
      actions: [
        { type: "setCategory", categoryId: income.id },
        { type: "setFlag", flag: "transfer", value: false },
        { type: "setFlag", flag: "reportingExcluded", value: false },
        { type: "setFlag", flag: "income", value: false },
        { type: "setFlag", flag: "reimbursement", value: false },
        { type: "requestReview", value: true },
      ] as unknown as Record<string, unknown>,
      specificityScore: 900,
      createdByUserId: registered.userId,
    });
    const run = () =>
      categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        aiLimit: 0,
      });

    expect(await run()).toMatchObject({ deterministic: 1 });
    expect(await run()).toMatchObject({ deterministic: 0 });
    expect(await db.select().from(ruleRuns)).toHaveLength(1);
    expect(
      await db
        .select({ matchCount: rules.matchCount })
        .from(rules)
        .where(eq(rules.id, ruleId))
        .get(),
    ).toEqual({ matchCount: 1 });
  });

  test("rate limiting opens the provider circuit for the rest of the bounded run", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "4".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "provider-circuit@example.com",
        password: "StopOnRateLimit!2026",
        householdName: "Provider circuit test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
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
    await db.insert(transactions).values(
      Array.from({ length: 5 }, (_, index) => ({
        id: ulid(),
        householdId: registered.householdId,
        accountId,
        amount: -1_000n,
        currency: "USD",
        transactedOn: `2026-07-${String(index + 1).padStart(2, "0")}`,
        rawDescription: `RATE LIMITED ${index}`,
        normalizedDescription: `RATE LIMITED ${index}`,
        status: "posted" as const,
        source: "manual" as const,
        reviewState: "needs_review" as const,
      })),
    );
    let calls = 0;
    const rateLimited = async (): Promise<never> => {
      calls += 1;
      throw new AppError("Rate limited", 429, "ai_rate_limited");
    };
    const attemptedFingerprints = new Set<string>();
    const run = () =>
      categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: rateLimited,
        attemptedFingerprints,
      });

    expect(await run()).toMatchObject({ candidates: 5, aiCalls: 1, aiFailed: 1 });
    expect(await run()).toMatchObject({ candidates: 5, aiCalls: 0, aiFailed: 0 });
    expect(calls).toBe(1);
  });

  test("invalid provider output is parked by default and retried once per explicit recovery run", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "5".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "invalid-output@example.com",
        password: "InvalidOutputIsParked!2026",
        householdName: "Invalid output test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
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
    await db.insert(transactions).values({
      id: ulid(),
      householdId: registered.householdId,
      accountId,
      amount: -1_000n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "INVALID MODEL OUTPUT",
      normalizedDescription: "INVALID MODEL OUTPUT",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });
    let calls = 0;
    const invalidProvider = async (): Promise<never> => {
      calls += 1;
      throw new AppError("Invalid output", 502, "ai_invalid_response", {
        validationReason: [
          "rationale:too_big",
          "categoryId:not_allowlisted",
          "unsafe raw provider value <script>",
        ],
      });
    };
    const run = () =>
      categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: invalidProvider,
      });

    expect(await run()).toMatchObject({ aiCalls: 1, aiFailed: 1 });
    expect(await run()).toMatchObject({ aiCalls: 0, aiPreviouslyAttempted: 1 });
    expect(calls).toBe(1);
    expect(await db.select().from(aiSuggestions)).toEqual([
      expect.objectContaining({
        status: "invalid",
        confidenceBps: 0,
        rationale:
          "AI output rejected (ai_invalid_response: rationale:too_big, categoryId:not_allowlisted)",
      }),
    ]);

    const recoveryFingerprints = new Set<string>();
    const recover = () =>
      categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: invalidProvider,
        attemptedFingerprints: recoveryFingerprints,
        retryInvalidSuggestions: true,
      });
    expect(await recover()).toMatchObject({ aiCalls: 1, aiFailed: 1 });
    expect(await recover()).toMatchObject({ aiCalls: 0, aiPreviouslyAttempted: 1 });
    expect(calls).toBe(2);
    expect(await db.select().from(aiSuggestions)).toHaveLength(1);
  });

  test("income labels on liability-account inflows always wait for a human decision", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "b".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "liability@example.com",
        password: "LiabilityIncome!2026",
        householdName: "Liability test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const income = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Income")))
      .get();
    if (!income) throw new Error("Default Income category was not created");
    const accountId = ulid();
    await db.insert(accounts).values({
      id: accountId,
      householdId: registered.householdId,
      ownerUserId: registered.userId,
      name: "Visa",
      group: "credit",
      type: "credit_card",
      currency: "USD",
      isLiability: true,
      isManual: true,
    });
    const transactionId = ulid();
    await db.insert(transactions).values({
      id: transactionId,
      householdId: registered.householdId,
      accountId,
      amount: 89_231n,
      currency: "USD",
      transactedOn: "2026-07-15",
      rawDescription: "PAYMENT THANK YOU MOBILE",
      normalizedDescription: "PAYMENT THANK YOU MOBILE",
      status: "posted",
      source: "manual",
      reviewState: "needs_review",
    });

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory: async () => ({
          merchant: "Payment Thank You",
          categoryId: income.id,
          confidence: 0.99,
          rationale: "Looks like inbound money.",
        }),
      }),
    ).toMatchObject({ aiCalls: 1, aiAccepted: 0, aiPending: 1 });
    expect(
      await db
        .select({
          categoryId: transactions.categoryId,
          isIncome: transactions.isIncome,
          reviewState: transactions.reviewState,
        })
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .get(),
    ).toEqual({ categoryId: null, isIncome: false, reviewState: "needs_review" });
    expect(await db.select().from(rules)).toHaveLength(0);
  });

  test("same merchant in different statement forms mints exactly one rule, even in parallel", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "9".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "dedupe@example.com",
        password: "OneMerchantOneRule!2026",
        householdName: "Dedupe test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category was not created");
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
        amount: -1_500n,
        currency: "USD",
        transactedOn: day,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
      return id;
    };
    // The second description does not textually match the first rule's condition, so without
    // merchant-similarity dedupe it would mint a twin rule.
    await insertTransaction("BEREA BEVERAGE", "2026-07-15");
    await insertTransaction("BEREA BEV MARKETPLACE", "2026-07-16");

    const suggestCategory = async (providerInput: {
      transaction: { normalizedDescription: string };
    }) => ({
      merchant: "Berea Beverage",
      categoryId: food.id,
      confidence: 0.97,
      rationale: `Beverage store: ${providerInput.transaction.normalizedDescription}`,
    });

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
        maxClusterConcurrency: 4,
      }),
    ).toMatchObject({ aiCalls: 2, aiAccepted: 2, aiPending: 0 });
    expect(await db.select().from(rules)).toHaveLength(1);
    expect(
      (await db.select().from(transactions)).every(
        (transaction) => transaction.categoryId === food.id && transaction.reviewState === "none",
      ),
    ).toBeTrue();
  });

  test("a conflicting category for an already-ruled merchant parks a pending suggestion, no twin rule", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "8".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "conflict@example.com",
        password: "ConflictResolvedByHuman!2026",
        householdName: "Conflict test",
      },
      config,
    );
    await configureAiForUser(db, config, registered.householdId, registered.userId);
    const findCategory = async (name: string) => {
      const row = await db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.householdId, registered.householdId), eq(categories.name, name)))
        .get();
      if (!row) throw new Error(`Default ${name} category was not created`);
      return row;
    };
    const food = await findCategory("Food");
    const housing = await findCategory("Housing");
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
        amount: -2_500n,
        currency: "USD",
        transactedOn: day,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "needs_review",
      });
      return id;
    };
    await insertTransaction("CORNER COFFEE", "2026-07-15");
    const conflictTransactionId = await insertTransaction("CORNER BEVERAGE ROASTERS", "2026-07-16");

    const suggestCategory = async (providerInput: {
      transaction: { normalizedDescription: string };
    }) => ({
      merchant: "Corner Coffee",
      categoryId: providerInput.transaction.normalizedDescription.startsWith("CORNER COFFEE")
        ? food.id
        : housing.id,
      confidence: 0.97,
      rationale: "Confident but conflicting second opinion.",
    });

    expect(
      await categorizeHouseholdTransactions({
        db,
        config,
        householdId: registered.householdId,
        userId: registered.userId,
        suggestCategory,
      }),
    ).toMatchObject({ aiCalls: 2, aiAccepted: 1, aiPending: 1 });
    expect(await db.select().from(rules)).toHaveLength(1);
    expect(
      await db
        .select({ categoryId: transactions.categoryId, reviewState: transactions.reviewState })
        .from(transactions)
        .where(eq(transactions.id, conflictTransactionId))
        .get(),
    ).toEqual({ categoryId: null, reviewState: "needs_review" });
    expect(
      await db
        .select({ status: aiSuggestions.status, rationale: aiSuggestions.rationale })
        .from(aiSuggestions)
        .where(eq(aiSuggestions.transactionId, conflictTransactionId))
        .get(),
    ).toEqual({
      status: "pending",
      rationale: expect.stringContaining("Corner Coffee → Food") as unknown as string,
    });
  });
});
