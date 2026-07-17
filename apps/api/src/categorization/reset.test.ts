import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  aiSuggestions,
  auditEvents,
  categories,
  closeDatabase,
  envelopeRuleLinks,
  envelopes,
  merchants,
  openDatabase,
  refundLinks,
  ruleRuns,
  rules,
  runMigrations,
  tags,
  transactionSplits,
  transactions,
  transactionTags,
  transfers,
} from "@betterwealth/db";
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import { resetHouseholdCategorization } from "./reset";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

function testConfig() {
  return loadConfig({
    APP_ENV: "test",
    DATABASE_URL: ":memory:",
    ENCRYPTION_KEY: "7".repeat(64),
    WEB_ORIGIN: "http://localhost:5173",
    REGISTRATION_MODE: "open",
  });
}

describe("full categorization reset", () => {
  test("previews then atomically clears categorization without touching ledger or movement truth", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = testConfig();
    const owner = await registerUser(
      db,
      {
        email: "reset-owner@example.com",
        password: "ResetEverything!2026",
        householdName: "Reset household",
      },
      config,
    );
    const outsider = await registerUser(
      db,
      {
        email: "reset-outsider@example.com",
        password: "ResetOutsider!2026",
        householdName: "Untouched household",
      },
      config,
    );
    const [food, outsiderFood] = await Promise.all([
      db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.householdId, owner.householdId), eq(categories.name, "Food")))
        .get(),
      db
        .select({ id: categories.id })
        .from(categories)
        .where(and(eq(categories.householdId, outsider.householdId), eq(categories.name, "Food")))
        .get(),
    ]);
    if (!food || !outsiderFood) throw new Error("Default categories are missing");
    const accountId = ulid();
    const outsiderAccountId = ulid();
    await db.insert(accounts).values([
      {
        id: accountId,
        householdId: owner.householdId,
        ownerUserId: owner.userId,
        name: "Checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: outsiderAccountId,
        householdId: outsider.householdId,
        ownerUserId: outsider.userId,
        name: "Other checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
    ]);
    const envelopeId = ulid();
    const outsiderEnvelopeId = ulid();
    await db.insert(envelopes).values([
      {
        id: envelopeId,
        householdId: owner.householdId,
        categoryId: food.id,
        name: "Food budget",
        cadence: "monthly",
        currency: "USD",
      },
      {
        id: outsiderEnvelopeId,
        householdId: outsider.householdId,
        categoryId: outsiderFood.id,
        name: "Other food budget",
        cadence: "monthly",
        currency: "USD",
      },
    ]);
    const derivedMerchantId = ulid();
    const providerMerchantId = ulid();
    await db.insert(merchants).values([
      {
        id: derivedMerchantId,
        householdId: owner.householdId,
        name: "AI Merchant",
        normalizedName: "AI MERCHANT",
      },
      {
        id: providerMerchantId,
        householdId: owner.householdId,
        name: "Provider Merchant",
        normalizedName: "PROVIDER MERCHANT",
      },
    ]);
    const ids = {
      ai: ulid(),
      transferOut: ulid(),
      transferIn: ulid(),
      purchase: ulid(),
      refund: ulid(),
      removed: ulid(),
      outsider: ulid(),
    };
    const overrideAt = "2026-07-17T12:00:00.000Z";
    await db.insert(transactions).values([
      {
        id: ids.ai,
        householdId: owner.householdId,
        accountId,
        amount: -500n,
        currency: "USD",
        transactedOn: "2026-07-01",
        rawDescription: "RAW AI PURCHASE",
        normalizedDescription: "RAW AI PURCHASE",
        merchantId: derivedMerchantId,
        categoryId: food.id,
        categoryOrigin: "ai",
        envelopeId,
        status: "posted",
        source: "provider",
        reviewState: "reviewed",
        isIncome: true,
        isTransfer: true,
        isExcluded: true,
        isReimbursement: true,
        note: "Keep this note",
        providerMetadata: { providerTransactionId: "provider-1" },
        externalId: "external-1",
        userOverrideAt: overrideAt,
      },
      ...[
        { id: ids.transferOut, amount: -1_000n },
        { id: ids.transferIn, amount: 1_000n },
      ].map(({ id, amount }) => ({
        id,
        householdId: owner.householdId,
        accountId,
        amount,
        currency: "USD",
        transactedOn: "2026-07-02",
        rawDescription: "CONFIRMED TRANSFER",
        normalizedDescription: "CONFIRMED TRANSFER",
        merchantId: derivedMerchantId,
        categoryId: food.id,
        categoryOrigin: "rule" as const,
        envelopeId,
        status: "posted" as const,
        source: "manual" as const,
        reviewState: "reviewed" as const,
        isTransfer: false,
        isExcluded: false,
        userOverrideAt: overrideAt,
      })),
      {
        id: ids.purchase,
        householdId: owner.householdId,
        accountId,
        amount: -2_500n,
        currency: "USD",
        transactedOn: "2026-07-03",
        rawDescription: "PROVIDER PURCHASE",
        normalizedDescription: "PROVIDER PURCHASE",
        merchantId: providerMerchantId,
        categoryId: food.id,
        categoryOrigin: "provider",
        envelopeId,
        status: "posted",
        source: "provider",
        reviewState: "reviewed",
        userOverrideAt: overrideAt,
      },
      {
        id: ids.refund,
        householdId: owner.householdId,
        accountId,
        amount: 2_500n,
        currency: "USD",
        transactedOn: "2026-07-04",
        rawDescription: "MANUAL REFUND",
        normalizedDescription: "MANUAL REFUND",
        merchantId: providerMerchantId,
        categoryId: food.id,
        categoryOrigin: "user",
        envelopeId,
        status: "posted",
        source: "manual",
        reviewState: "reviewed",
        isReimbursement: false,
        userOverrideAt: overrideAt,
      },
      {
        id: ids.removed,
        householdId: owner.householdId,
        accountId,
        amount: -700n,
        currency: "USD",
        transactedOn: "2026-07-05",
        rawDescription: "REMOVED PURCHASE",
        normalizedDescription: "REMOVED PURCHASE",
        categoryId: food.id,
        categoryOrigin: "user",
        status: "removed",
        source: "provider",
        reviewState: "reviewed",
        note: "Removal note stays",
        userOverrideAt: overrideAt,
      },
      {
        id: ids.outsider,
        householdId: outsider.householdId,
        accountId: outsiderAccountId,
        amount: -900n,
        currency: "USD",
        transactedOn: "2026-07-01",
        rawDescription: "OTHER HOUSEHOLD",
        normalizedDescription: "OTHER HOUSEHOLD",
        categoryId: outsiderFood.id,
        categoryOrigin: "ai",
        envelopeId: outsiderEnvelopeId,
        status: "posted",
        source: "manual",
        reviewState: "reviewed",
      },
    ]);
    const splitId = ulid();
    await db.insert(transactionSplits).values({
      id: splitId,
      householdId: owner.householdId,
      transactionId: ids.ai,
      sequence: 0,
      amount: -500n,
      categoryId: food.id,
      envelopeId,
      memo: "Split memo stays",
    });
    const tagId = ulid();
    await db.insert(tags).values({
      id: tagId,
      householdId: owner.householdId,
      name: "Tax deductible",
      normalizedName: "TAX DEDUCTIBLE",
    });
    await db.insert(transactionTags).values({
      householdId: owner.householdId,
      transactionId: ids.ai,
      tagId,
    });
    await db.insert(transfers).values({
      id: ulid(),
      householdId: owner.householdId,
      outflowTransactionId: ids.transferOut,
      inflowTransactionId: ids.transferIn,
      confidenceBps: 10_000,
      status: "confirmed",
      matchedBy: "user",
      confirmedByUserId: owner.userId,
    });
    await db.insert(refundLinks).values({
      id: ulid(),
      householdId: owner.householdId,
      refundTransactionId: ids.refund,
      purchaseTransactionId: ids.purchase,
      amount: 2_500n,
      confidenceBps: 10_000,
      status: "confirmed",
    });
    const ruleId = ulid();
    const outsiderRuleId = ulid();
    await db.insert(rules).values([
      {
        id: ruleId,
        householdId: owner.householdId,
        name: "Reset me",
        origin: "user",
        conditions: { all: [] },
        actions: [{ type: "setCategory", categoryId: food.id }] as unknown as Record<
          string,
          unknown
        >,
        createdByUserId: owner.userId,
      },
      {
        id: outsiderRuleId,
        householdId: outsider.householdId,
        name: "Keep me",
        origin: "ai",
        conditions: { all: [] },
        actions: [{ type: "setCategory", categoryId: outsiderFood.id }] as unknown as Record<
          string,
          unknown
        >,
        createdByUserId: outsider.userId,
      },
    ]);
    await db.insert(envelopeRuleLinks).values({
      householdId: owner.householdId,
      envelopeId,
      ruleId,
    });
    await db.insert(ruleRuns).values([
      {
        id: ulid(),
        householdId: owner.householdId,
        transactionId: ids.ai,
        winningRuleId: ruleId,
        competingRuleIds: [],
        beforeSnapshot: { categoryId: null },
        afterSnapshot: { categoryId: food.id },
        explanation: "Applied reset rule",
      },
      {
        id: ulid(),
        householdId: outsider.householdId,
        transactionId: ids.outsider,
        winningRuleId: outsiderRuleId,
        competingRuleIds: [],
        beforeSnapshot: { categoryId: null },
        afterSnapshot: { categoryId: outsiderFood.id },
        explanation: "Keep outsider run",
      },
    ]);
    await db.insert(aiSuggestions).values([
      {
        id: ulid(),
        householdId: owner.householdId,
        transactionId: ids.ai,
        inputFingerprint: "reset-fingerprint",
        suggestedMerchantName: "AI Merchant",
        suggestedMerchantId: derivedMerchantId,
        suggestedCategoryId: food.id,
        confidenceBps: 9_000,
        rationale: "Reset suggestion",
        model: "test-model",
      },
      {
        id: ulid(),
        householdId: outsider.householdId,
        transactionId: ids.outsider,
        inputFingerprint: "outsider-fingerprint",
        suggestedCategoryId: outsiderFood.id,
        confidenceBps: 9_000,
        rationale: "Keep suggestion",
        model: "test-model",
      },
    ]);

    const categoryCount = (
      await db.select().from(categories).where(eq(categories.householdId, owner.householdId))
    ).length;
    const beforeDryRun = {
      transactions: await db.select().from(transactions),
      splits: await db.select().from(transactionSplits),
      rules: await db.select().from(rules),
      runs: await db.select().from(ruleRuns),
      suggestions: await db.select().from(aiSuggestions),
      audits: await db.select().from(auditEvents),
    };
    const preview = await resetHouseholdCategorization({
      db,
      householdId: owner.householdId,
      userId: owner.userId,
    });
    expect(preview).toMatchObject({
      mode: "dry-run",
      transactionsScanned: 6,
      transactionsChanged: 6,
      transactionCategoriesCleared: 6,
      transactionMerchantsCleared: 3,
      transactionEnvelopesCleared: 5,
      transactionIncomeFlagsCleared: 1,
      transactionReviewsQueued: 3,
      unconfirmedTransferFlagsCleared: 1,
      unconfirmedRefundFlagsCleared: 1,
      confirmedMovementFlagsRepaired: 3,
      userOverridesCleared: 6,
      splitsChanged: 1,
      splitCategoriesCleared: 1,
      splitEnvelopesCleared: 1,
      aiSuggestionsDeleted: 1,
      ruleRunsDeleted: 1,
      envelopeRuleLinksDeleted: 1,
      rulesDeleted: 1,
      categoriesPreserved: categoryCount,
      confirmedTransfersPreserved: 1,
      confirmedRefundsPreserved: 1,
      auditEventId: null,
    });
    expect({
      transactions: await db.select().from(transactions),
      splits: await db.select().from(transactionSplits),
      rules: await db.select().from(rules),
      runs: await db.select().from(ruleRuns),
      suggestions: await db.select().from(aiSuggestions),
      audits: await db.select().from(auditEvents),
    }).toEqual(beforeDryRun);
    await expect(
      resetHouseholdCategorization({
        db,
        householdId: owner.householdId,
        userId: outsider.userId,
        apply: true,
      }),
    ).rejects.toThrow("Only an active household owner or admin");

    const applied = await resetHouseholdCategorization({
      db,
      householdId: owner.householdId,
      userId: owner.userId,
      apply: true,
    });
    const appliedAuditEventId = applied.auditEventId;
    expect(applied).toMatchObject({
      ...preview,
      mode: "applied",
      auditEventId: expect.any(String),
    });
    if (!appliedAuditEventId) throw new Error("Applied reset did not return an audit event ID");
    expect(
      await db
        .select({
          actorUserId: auditEvents.actorUserId,
          actorType: auditEvents.actorType,
          action: auditEvents.action,
          entityId: auditEvents.entityId,
          metadata: auditEvents.metadata,
        })
        .from(auditEvents)
        .where(eq(auditEvents.id, appliedAuditEventId))
        .get(),
    ).toMatchObject({
      actorUserId: owner.userId,
      actorType: "user",
      action: "categorization.reset",
      entityId: owner.householdId,
      metadata: {
        transactionsChanged: 6,
        splitCategoriesCleared: 1,
        splitEnvelopesCleared: 1,
        rulesDeleted: 1,
        explicitAllRulesAuthorization: true,
        userOverridesClearedForRecategorization: true,
        preserved: expect.arrayContaining([
          "raw_imported_ledger",
          "confirmed_movement_links_and_flags",
          "category_taxonomy",
        ]),
      },
    });
    expect(
      await db.select().from(transactions).where(eq(transactions.id, ids.ai)).get(),
    ).toMatchObject({
      amount: -500n,
      status: "posted",
      rawDescription: "RAW AI PURCHASE",
      normalizedDescription: "RAW AI PURCHASE",
      merchantId: null,
      categoryId: null,
      categoryOrigin: "none",
      envelopeId: null,
      reviewState: "needs_review",
      isIncome: false,
      isTransfer: false,
      isExcluded: false,
      isReimbursement: false,
      note: "Keep this note",
      providerMetadata: { providerTransactionId: "provider-1" },
      externalId: "external-1",
      userOverrideAt: null,
    });
    expect(
      await db
        .select({
          merchantId: transactions.merchantId,
          categoryId: transactions.categoryId,
          categoryOrigin: transactions.categoryOrigin,
          reviewState: transactions.reviewState,
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          isIncome: transactions.isIncome,
          isReimbursement: transactions.isReimbursement,
          userOverrideAt: transactions.userOverrideAt,
        })
        .from(transactions)
        .where(eq(transactions.id, ids.transferOut))
        .get(),
    ).toEqual({
      merchantId: null,
      categoryId: null,
      categoryOrigin: "none",
      reviewState: "reviewed",
      isTransfer: true,
      isExcluded: true,
      isIncome: false,
      isReimbursement: false,
      userOverrideAt: null,
    });
    expect(
      await db
        .select({
          merchantId: transactions.merchantId,
          categoryId: transactions.categoryId,
          reviewState: transactions.reviewState,
          isReimbursement: transactions.isReimbursement,
          userOverrideAt: transactions.userOverrideAt,
        })
        .from(transactions)
        .where(eq(transactions.id, ids.refund))
        .get(),
    ).toEqual({
      merchantId: providerMerchantId,
      categoryId: null,
      reviewState: "needs_review",
      isReimbursement: true,
      userOverrideAt: null,
    });
    expect(
      await db
        .select({ merchantId: transactions.merchantId })
        .from(transactions)
        .where(eq(transactions.id, ids.purchase))
        .get(),
    ).toEqual({ merchantId: providerMerchantId });
    expect(
      await db
        .select({
          status: transactions.status,
          note: transactions.note,
          reviewState: transactions.reviewState,
          userOverrideAt: transactions.userOverrideAt,
        })
        .from(transactions)
        .where(eq(transactions.id, ids.removed))
        .get(),
    ).toEqual({
      status: "removed",
      note: "Removal note stays",
      reviewState: "reviewed",
      userOverrideAt: null,
    });
    expect(
      await db.select().from(transactionSplits).where(eq(transactionSplits.id, splitId)).get(),
    ).toMatchObject({
      id: splitId,
      amount: -500n,
      sequence: 0,
      categoryId: null,
      envelopeId: null,
      memo: "Split memo stays",
    });
    expect(await db.select().from(transactionTags)).toEqual([
      expect.objectContaining({ transactionId: ids.ai, tagId }),
    ]);
    expect(await db.select().from(transfers)).toHaveLength(1);
    expect(await db.select().from(refundLinks)).toHaveLength(1);
    expect(
      await db.select().from(categories).where(eq(categories.householdId, owner.householdId)),
    ).toHaveLength(categoryCount);
    expect(
      await db.select().from(rules).where(eq(rules.householdId, owner.householdId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(ruleRuns).where(eq(ruleRuns.householdId, owner.householdId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(aiSuggestions).where(eq(aiSuggestions.householdId, owner.householdId)),
    ).toHaveLength(0);
    expect(
      await db.select().from(rules).where(eq(rules.householdId, outsider.householdId)),
    ).toHaveLength(1);
    expect(
      await db.select().from(ruleRuns).where(eq(ruleRuns.householdId, outsider.householdId)),
    ).toHaveLength(1);
    expect(
      await db
        .select({ categoryId: transactions.categoryId, envelopeId: transactions.envelopeId })
        .from(transactions)
        .where(eq(transactions.id, ids.outsider))
        .get(),
    ).toEqual({ categoryId: outsiderFood.id, envelopeId: outsiderEnvelopeId });

    const repeated = await resetHouseholdCategorization({
      db,
      householdId: owner.householdId,
      userId: owner.userId,
      apply: true,
    });
    expect(repeated).toMatchObject({
      mode: "applied",
      transactionsChanged: 0,
      splitsChanged: 0,
      aiSuggestionsDeleted: 0,
      ruleRunsDeleted: 0,
      envelopeRuleLinksDeleted: 0,
      rulesDeleted: 0,
      categoriesPreserved: categoryCount,
      confirmedTransfersPreserved: 1,
      confirmedRefundsPreserved: 1,
      auditEventId: expect.any(String),
    });
    expect(
      await db
        .select({ action: auditEvents.action, metadata: auditEvents.metadata })
        .from(auditEvents)
        .where(eq(auditEvents.action, "categorization.reset")),
    ).toHaveLength(2);
  });

  test("rolls back transaction, split, rule, suggestion, and audit changes on a late failure", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = testConfig();
    const owner = await registerUser(
      db,
      {
        email: "reset-rollback@example.com",
        password: "ResetRollback!2026",
        householdName: "Reset rollback",
      },
      config,
    );
    const food = await db
      .select({ id: categories.id })
      .from(categories)
      .where(and(eq(categories.householdId, owner.householdId), eq(categories.name, "Food")))
      .get();
    if (!food) throw new Error("Default Food category is missing");
    const accountId = ulid();
    await db.insert(accounts).values({
      id: accountId,
      householdId: owner.householdId,
      ownerUserId: owner.userId,
      name: "Checking",
      group: "cash",
      type: "checking",
      currency: "USD",
      isLiability: false,
      isManual: true,
    });
    const transactionId = ulid();
    await db.insert(transactions).values({
      id: transactionId,
      householdId: owner.householdId,
      accountId,
      amount: -1_000n,
      currency: "USD",
      transactedOn: "2026-07-01",
      rawDescription: "ROLLBACK PURCHASE",
      normalizedDescription: "ROLLBACK PURCHASE",
      categoryId: food.id,
      categoryOrigin: "ai",
      status: "posted",
      source: "manual",
      reviewState: "reviewed",
      userOverrideAt: "2026-07-17T12:00:00.000Z",
    });
    const splitId = ulid();
    await db.insert(transactionSplits).values({
      id: splitId,
      householdId: owner.householdId,
      transactionId,
      sequence: 0,
      amount: -1_000n,
      categoryId: food.id,
      memo: "Rollback split",
    });
    const ruleId = ulid();
    await db.insert(rules).values({
      id: ruleId,
      householdId: owner.householdId,
      name: "Rollback rule",
      origin: "ai",
      conditions: { all: [] },
      actions: [{ type: "setCategory", categoryId: food.id }] as unknown as Record<string, unknown>,
      createdByUserId: owner.userId,
    });
    await db.insert(ruleRuns).values({
      id: ulid(),
      householdId: owner.householdId,
      transactionId,
      winningRuleId: ruleId,
      competingRuleIds: [],
      beforeSnapshot: {},
      afterSnapshot: { categoryId: food.id },
      explanation: "Rollback run",
    });
    await db.insert(aiSuggestions).values({
      id: ulid(),
      householdId: owner.householdId,
      transactionId,
      inputFingerprint: "rollback-fingerprint",
      suggestedCategoryId: food.id,
      confidenceBps: 9_000,
      rationale: "Rollback suggestion",
      model: "test-model",
    });
    const snapshot = async () => ({
      transaction: await db.select().from(transactions),
      split: await db.select().from(transactionSplits),
      rules: await db.select().from(rules),
      runs: await db.select().from(ruleRuns),
      suggestions: await db.select().from(aiSuggestions),
      audits: await db.select().from(auditEvents),
    });
    const before = await snapshot();
    await expect(
      resetHouseholdCategorization({
        db,
        householdId: owner.householdId,
        userId: owner.userId,
        apply: true,
        testHooks: {
          beforeCommit: () => {
            throw new Error("injected reset failure");
          },
        },
      }),
    ).rejects.toThrow("injected reset failure");
    expect(db.$client.inTransaction).toBeFalse();
    expect(await snapshot()).toEqual(before);
  });
});
