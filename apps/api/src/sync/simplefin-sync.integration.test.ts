import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
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
import { syncSimpleFinConnection } from "./simplefin-sync";
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

    const postedFixture = mutableFixture();
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
    expect(await db.select().from(transactions)).toHaveLength(8);
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
