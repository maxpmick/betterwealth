import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  auditEvents,
  balanceSnapshots,
  closeDatabase,
  createHouseholdRepositories,
  openDatabase,
  providerInstitutions,
  runMigrations,
  syncRuns,
  transactions,
  transfers,
} from "@betterwealth/db";
import { simpleFinPendingRevisionFixtures, simpleFinV2Fixture } from "@betterwealth/testkit";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import type { SimpleFinAccountSet } from "../integrations/simplefin";
import { FieldCipher } from "../lib/crypto";
import { inferAccountType, syncSimpleFinConnection } from "./simplefin-sync";
import { reconcileAccountTransfers } from "./transfer-reconcile";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

function mutableFixture(): SimpleFinAccountSet {
  const fixture = JSON.parse(JSON.stringify(simpleFinV2Fixture)) as Partial<SimpleFinAccountSet>;
  return { ...fixture, errors: fixture.errors ?? [] } as SimpleFinAccountSet;
}

describe("SimpleFIN ledger sync", () => {
  test("recognizes credit-card product names even when the provider omits a type", () => {
    expect(inferAccountType("Chase Freedom Unlimited (8997)", undefined)).toEqual({
      group: "credit",
      type: "credit_card",
      isLiability: true,
    });
  });

  test("suggests a unique exact opposite across accounts without relying on descriptions", async () => {
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
        email: "transfer-candidate@example.com",
        password: "TransferCandidate!2026",
        householdName: "Transfer candidate test",
      },
      config,
    );
    const checkingId = ulid();
    const savingsId = ulid();
    await db.insert(accounts).values([
      {
        id: checkingId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: savingsId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Savings",
        group: "cash",
        type: "savings",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
    ]);
    const outflowId = ulid();
    const inflowId = ulid();
    await db.insert(transactions).values([
      {
        id: outflowId,
        householdId: registered.householdId,
        accountId: checkingId,
        amount: -12_345n,
        currency: "USD",
        transactedOn: "2026-07-10",
        rawDescription: "ALPHA PURCHASE",
        normalizedDescription: "ALPHA PURCHASE",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
      {
        id: inflowId,
        householdId: registered.householdId,
        accountId: savingsId,
        amount: 12_345n,
        currency: "USD",
        transactedOn: "2026-07-12",
        rawDescription: "UNRELATED BETA CREDIT",
        normalizedDescription: "UNRELATED BETA CREDIT",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
    ]);
    expect(await reconcileAccountTransfers(db, registered.householdId)).toEqual({ matched: 1 });
    expect(await db.select().from(transfers)).toEqual([
      expect.objectContaining({
        outflowTransactionId: outflowId,
        inflowTransactionId: inflowId,
        status: "suggested",
        matchedBy: "fingerprint",
      }),
    ]);
    expect(
      await db
        .select({ isTransfer: transactions.isTransfer, isExcluded: transactions.isExcluded })
        .from(transactions)
        .where(inArray(transactions.id, [outflowId, inflowId])),
    ).toEqual([
      { isTransfer: false, isExcluded: false },
      { isTransfer: false, isExcluded: false },
    ]);
  });

  test("matches card payments that settle days later, but not beyond the window", async () => {
    const db = openDatabase(":memory:", { wal: false });
    databases.push(db);
    runMigrations(db);
    const config = loadConfig({
      APP_ENV: "test",
      DATABASE_URL: ":memory:",
      ENCRYPTION_KEY: "d".repeat(64),
      WEB_ORIGIN: "http://localhost:5173",
      REGISTRATION_MODE: "open",
    });
    const registered = await registerUser(
      db,
      {
        email: "settlement-lag@example.com",
        password: "SettlementLag!2026",
        householdName: "Settlement lag test",
      },
      config,
    );
    const checkingId = ulid();
    const cardId = ulid();
    await db.insert(accounts).values([
      {
        id: checkingId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Spend",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: cardId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Freedom Unlimited",
        group: "credit",
        type: "credit_card",
        currency: "USD",
        isLiability: true,
        isManual: true,
      },
    ]);
    const insert = async (description: string, accountId: string, amount: bigint, day: string) => {
      const id = ulid();
      await db.insert(transactions).values({
        id,
        householdId: registered.householdId,
        accountId,
        amount,
        currency: "USD",
        transactedOn: day,
        rawDescription: description,
        normalizedDescription: description,
        status: "posted",
        source: "manual",
        reviewState: "none",
      });
      return id;
    };
    // Four-day settlement lag: inside the widened window.
    const pairOut = await insert("PAYMENT TO CHASE", checkingId, -680_88n, "2026-05-04");
    const pairIn = await insert("PAYMENT THANK YOU MOBILE", cardId, 680_88n, "2026-04-30");
    // Eight days apart: outside the window even with a unique exact amount.
    await insert("PAYMENT TO CHASE", checkingId, -421_00n, "2026-05-20");
    await insert("PAYMENT THANK YOU MOBILE", cardId, 421_00n, "2026-05-12");

    expect(await reconcileAccountTransfers(db, registered.householdId)).toEqual({ matched: 1 });
    expect(await db.select().from(transfers)).toEqual([
      expect.objectContaining({
        outflowTransactionId: pairOut,
        inflowTransactionId: pairIn,
        status: "suggested",
        matchedBy: "fingerprint",
      }),
    ]);
  });

  test("paginates past 2,000 newer rows to find an older exact unique pair", async () => {
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
        email: "deep-transfer-candidate@example.com",
        password: "DeepTransferCandidate!2026",
        householdName: "Deep transfer candidate test",
      },
      config,
    );
    const checkingId = ulid();
    const savingsId = ulid();
    await db.insert(accounts).values([
      {
        id: checkingId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Checking",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
      {
        id: savingsId,
        householdId: registered.householdId,
        ownerUserId: registered.userId,
        name: "Savings",
        group: "cash",
        type: "savings",
        currency: "USD",
        isLiability: false,
        isManual: true,
      },
    ]);
    const recentRows = Array.from({ length: 2_001 }, (_, index) => ({
      id: ulid(),
      householdId: registered.householdId,
      accountId: checkingId,
      amount: -BigInt(index + 1),
      currency: "USD",
      transactedOn: "2026-07-15",
      rawDescription: `RECENT UNRELATED ${index}`,
      normalizedDescription: `RECENT UNRELATED ${index}`,
      status: "posted" as const,
      source: "manual" as const,
      reviewState: "none" as const,
    }));
    for (let index = 0; index < recentRows.length; index += 300) {
      await db.insert(transactions).values(recentRows.slice(index, index + 300));
    }
    const outflowId = ulid();
    const inflowId = ulid();
    await db.insert(transactions).values([
      {
        id: outflowId,
        householdId: registered.householdId,
        accountId: checkingId,
        amount: -777_777n,
        currency: "USD",
        transactedOn: "2020-01-01",
        rawDescription: "OLD ALPHA",
        normalizedDescription: "OLD ALPHA",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
      {
        id: inflowId,
        householdId: registered.householdId,
        accountId: savingsId,
        amount: 777_777n,
        currency: "USD",
        transactedOn: "2020-01-02",
        rawDescription: "OLD UNRELATED BETA",
        normalizedDescription: "OLD UNRELATED BETA",
        status: "posted",
        source: "manual",
        reviewState: "none",
      },
    ]);

    expect(await reconcileAccountTransfers(db, registered.householdId)).toEqual({ matched: 1 });
    expect(await reconcileAccountTransfers(db, registered.householdId)).toEqual({ matched: 0 });
    expect(
      await db
        .select({
          outflowTransactionId: transfers.outflowTransactionId,
          inflowTransactionId: transfers.inflowTransactionId,
          status: transfers.status,
          matchedBy: transfers.matchedBy,
        })
        .from(transfers),
    ).toEqual([
      {
        outflowTransactionId: outflowId,
        inflowTransactionId: inflowId,
        status: "suggested",
        matchedBy: "fingerprint",
      },
    ]);
    expect(
      await db
        .select({ isTransfer: transactions.isTransfer, isExcluded: transactions.isExcluded })
        .from(transactions)
        .where(inArray(transactions.id, [outflowId, inflowId])),
    ).toEqual([
      { isTransfer: false, isExcluded: false },
      { isTransfer: false, isExcluded: false },
    ]);
  });

  test("imports accounts once and reconciles a pending transaction into its posted form", async () => {
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
        email: "sync@example.com",
        password: "SyncJourney!2026",
        householdName: "Sync test",
      },
      config,
    );
    const connectionId = ulid();
    const aad = `connection:${connectionId}:credentials`;
    createHouseholdRepositories(db, registered.householdId).connections.create({
      id: connectionId,
      ownerUserId: registered.userId,
      provider: "simplefin",
      displayName: "SimpleFIN test",
      encryptedCredentials: new FieldCipher(config.ENCRYPTION_KEY).encrypt(
        "https://fixture-user:fixture-password@example.com/simplefin",
        aad,
      ),
      credentialsAad: aad,
      capabilities: ["accounts", "balances", "transactions", "pending"],
      status: "active",
    });

    const first = await syncSimpleFinConnection({
      db,
      config,
      householdId: registered.householdId,
      connectionId,
      trigger: "initial",
      fetchAccounts: async () => mutableFixture(),
    });
    expect(first).toMatchObject({
      state: "succeeded",
      accountsSeen: 3,
      balancesCreated: 3,
      transactionsCreated: 8,
      transferReconciliation: { matched: 1 },
    });
    expect(await db.select().from(accounts)).toHaveLength(3);
    expect(await db.select().from(providerInstitutions)).toHaveLength(2);
    expect(await db.select().from(balanceSnapshots)).toHaveLength(3);
    expect(await db.select().from(transactions)).toHaveLength(8);
    expect(await db.select().from(transfers)).toEqual([
      expect.objectContaining({ status: "suggested", matchedBy: "provider" }),
    ]);
    expect(
      await db
        .select({ isTransfer: transactions.isTransfer })
        .from(transactions)
        .where(eq(transactions.isTransfer, true)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.status, "pending"),
            eq(transactions.householdId, registered.householdId),
          ),
        ),
    ).toHaveLength(1);

    const legacyCard = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.externalId, "alex-card-7331"))
      .get();
    const legacySavings = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.externalId, "alex-savings-8801"))
      .get();
    const overriddenChecking = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.externalId, "alex-checking-2244"))
      .get();
    await db
      .update(accounts)
      .set({ group: "rewards", type: "rewards", isLiability: false })
      .where(eq(accounts.id, legacyCard!.id));
    await db
      .update(accounts)
      .set({ group: "cash", type: "checking", isLiability: false })
      .where(eq(accounts.id, legacySavings!.id));
    await db
      .update(accounts)
      .set({
        name: "My named operating account",
        group: "custom",
        type: "custom",
        providerMetadata: { classificationOverride: true, nameOverride: true },
      })
      .where(eq(accounts.id, overriddenChecking!.id));
    const missingAccountId = ulid();
    const hiddenOverrideAccountId = ulid();
    await db.insert(accounts).values([
      {
        id: missingAccountId,
        householdId: registered.householdId,
        connectionId,
        externalId: "provider-account-that-disappeared",
        name: "Old provider account",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: false,
        status: "active",
      },
      {
        id: hiddenOverrideAccountId,
        householdId: registered.householdId,
        connectionId,
        externalId: "provider-account-user-hidden",
        name: "Hidden provider account",
        group: "cash",
        type: "checking",
        currency: "USD",
        isLiability: false,
        isManual: false,
        status: "hidden",
        providerMetadata: { statusOverride: true },
      },
    ]);

    const removedRent = await db
      .select({ id: transactions.id, merchantId: transactions.merchantId })
      .from(transactions)
      .where(eq(transactions.externalId, "rent-2026-08"))
      .get();
    expect(removedRent?.merchantId).toBeTruthy();
    await db
      .update(transactions)
      .set({ status: "removed", userOverrideAt: new Date().toISOString() })
      .where(eq(transactions.id, removedRent!.id));
    const disappearedPendingId = ulid();
    const disappearedPostedId = ulid();
    const userRemovedId = ulid();
    const staleDuplicatePendingId = ulid();
    const currentDate = new Date().toISOString();
    const existingPostedCardTransaction = await db
      .select({
        amount: transactions.amount,
        currency: transactions.currency,
        transactedOn: transactions.transactedOn,
        rawDescription: transactions.rawDescription,
        normalizedDescription: transactions.normalizedDescription,
      })
      .from(transactions)
      .where(and(eq(transactions.accountId, legacyCard!.id), eq(transactions.status, "posted")))
      .limit(1)
      .get();
    if (!existingPostedCardTransaction) throw new Error("Posted card fixture is missing");
    await db.insert(transactions).values([
      {
        id: disappearedPendingId,
        householdId: registered.householdId,
        accountId: overriddenChecking!.id,
        connectionId,
        externalId: "provider-pending-disappeared",
        amount: -111n,
        currency: "USD",
        transactedOn: currentDate,
        rawDescription: "PENDING THAT DISAPPEARED",
        normalizedDescription: "PENDING THAT DISAPPEARED",
        status: "pending",
        source: "provider",
        reviewState: "needs_review",
      },
      {
        id: disappearedPostedId,
        householdId: registered.householdId,
        accountId: overriddenChecking!.id,
        connectionId,
        externalId: "provider-posted-retracted",
        amount: -222n,
        currency: "USD",
        postedAt: currentDate,
        transactedOn: currentDate,
        rawDescription: "POSTED THAT WAS RETRACTED",
        normalizedDescription: "POSTED THAT WAS RETRACTED",
        status: "posted",
        source: "provider",
        reviewState: "needs_review",
      },
      {
        id: userRemovedId,
        householdId: registered.householdId,
        accountId: overriddenChecking!.id,
        connectionId,
        externalId: "provider-user-removed",
        amount: -333n,
        currency: "USD",
        postedAt: currentDate,
        transactedOn: currentDate,
        rawDescription: "USER REMOVED PROVIDER ROW",
        normalizedDescription: "USER REMOVED PROVIDER ROW",
        status: "removed",
        source: "provider",
        reviewState: "needs_review",
        userOverrideAt: currentDate,
      },
      {
        id: staleDuplicatePendingId,
        householdId: registered.householdId,
        accountId: legacyCard!.id,
        connectionId,
        externalId: "provider-stale-pending-duplicate",
        amount: existingPostedCardTransaction.amount,
        currency: existingPostedCardTransaction.currency,
        transactedOn: existingPostedCardTransaction.transactedOn,
        rawDescription: existingPostedCardTransaction.rawDescription,
        normalizedDescription: existingPostedCardTransaction.normalizedDescription,
        status: "pending",
        source: "provider",
        reviewState: "needs_review",
      },
    ]);

    const postedFixture = mutableFixture();
    const checking = postedFixture.accounts.find(({ id }) => id === "alex-checking-2244");
    if (!checking) throw new Error("Checking fixture is missing");
    checking.transactions = checking.transactions.map((transaction) =>
      transaction.id === "rent-2026-08"
        ? { ...transaction, description: "PROVIDER RENAMED RENT PAYEE" }
        : transaction,
    );
    const savings = postedFixture.accounts.find(({ id }) => id === "alex-savings-8801");
    if (!savings) throw new Error("Savings fixture is missing");
    savings.name = "Individual - TOD";
    const card = postedFixture.accounts.find(({ id }) => id === "alex-card-7331");
    if (!card) throw new Error("Card fixture is missing");
    card.transactions = [
      ...card.transactions.filter(({ id }) => id !== "transit-pending-0801"),
      { ...simpleFinPendingRevisionFixtures.posted },
    ];
    const second = await syncSimpleFinConnection({
      db,
      config,
      householdId: registered.householdId,
      connectionId,
      trigger: "scheduled",
      fetchAccounts: async () => postedFixture,
    });
    expect(second).toMatchObject({
      state: "succeeded",
      accountsSeen: 3,
      balancesCreated: 0,
      transactionsCreated: 0,
      transactionsUpdated: 8,
    });
    expect(await db.select().from(balanceSnapshots)).toHaveLength(3);
    expect(await db.select().from(transactions)).toHaveLength(12);
    expect(
      await db
        .select({ id: accounts.id, status: accounts.status })
        .from(accounts)
        .where(inArray(accounts.id, [missingAccountId, hiddenOverrideAccountId])),
    ).toEqual(
      expect.arrayContaining([
        { id: missingAccountId, status: "stale" },
        { id: hiddenOverrideAccountId, status: "hidden" },
      ]),
    );
    expect(
      await db
        .select({ id: transactions.id, status: transactions.status })
        .from(transactions)
        .where(
          inArray(transactions.id, [
            disappearedPendingId,
            disappearedPostedId,
            userRemovedId,
            staleDuplicatePendingId,
          ]),
        ),
    ).toEqual(
      expect.arrayContaining([
        { id: disappearedPendingId, status: "void" },
        { id: disappearedPostedId, status: "void" },
        { id: userRemovedId, status: "removed" },
        { id: staleDuplicatePendingId, status: "pending" },
      ]),
    );
    expect(
      await db
        .select({ entityId: auditEvents.entityId })
        .from(auditEvents)
        .where(eq(auditEvents.action, "account.missing_upstream")),
    ).toEqual([{ entityId: missingAccountId }]);
    expect(
      await db
        .select({ entityId: auditEvents.entityId })
        .from(auditEvents)
        .where(eq(auditEvents.action, "transaction.removed_upstream")),
    ).toEqual(
      expect.arrayContaining([
        { entityId: disappearedPendingId },
        { entityId: disappearedPostedId },
      ]),
    );
    expect(
      await db
        .select({
          name: accounts.name,
          group: accounts.group,
          type: accounts.type,
          isLiability: accounts.isLiability,
        })
        .from(accounts)
        .where(eq(accounts.id, legacyCard!.id))
        .get(),
    ).toEqual({ name: "Rewards Card", group: "credit", type: "credit_card", isLiability: true });
    expect(
      await db
        .select({ group: accounts.group, type: accounts.type, isLiability: accounts.isLiability })
        .from(accounts)
        .where(eq(accounts.id, legacySavings!.id))
        .get(),
    ).toEqual({ group: "investment", type: "investment", isLiability: false });
    expect(
      await db
        .select({ name: accounts.name, group: accounts.group, type: accounts.type })
        .from(accounts)
        .where(eq(accounts.id, overriddenChecking!.id))
        .get(),
    ).toEqual({ name: "My named operating account", group: "custom", type: "custom" });
    expect(
      await db
        .select({
          status: transactions.status,
          merchantId: transactions.merchantId,
          rawDescription: transactions.rawDescription,
        })
        .from(transactions)
        .where(eq(transactions.externalId, "rent-2026-08"))
        .get(),
    ).toEqual({
      status: "removed",
      merchantId: removedRent!.merchantId,
      rawDescription: "PROVIDER RENAMED RENT PAYEE",
    });
    expect(
      await db
        .select({
          status: transactions.status,
          externalId: transactions.externalId,
          pendingExternalId: transactions.pendingExternalId,
        })
        .from(transactions)
        .where(eq(transactions.externalId, "transit-posted-0802"))
        .get(),
    ).toEqual({
      status: "posted",
      externalId: "transit-posted-0802",
      pendingExternalId: "transit-pending-0801",
    });
    expect(await db.select().from(syncRuns)).toHaveLength(2);
  });
});
