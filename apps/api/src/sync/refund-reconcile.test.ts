import { afterEach, describe, expect, test } from "bun:test";
import {
  accounts,
  closeDatabase,
  merchants,
  openDatabase,
  refundLinks,
  runMigrations,
  transactions,
} from "@betterwealth/db";
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import { registerUser } from "../auth/service";
import { loadConfig } from "../config";
import { reconcileAccountRefunds } from "./refund-reconcile";

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) closeDatabase(db);
});

async function fixture() {
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
      email: `refund-${ulid()}@example.com`,
      password: "RefundReview!2026",
      householdName: "Refund review test",
    },
    config,
  );
  const accountId = ulid();
  const merchantId = ulid();
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
  await db.insert(merchants).values({
    id: merchantId,
    householdId: registered.householdId,
    name: "Exact Merchant",
    normalizedName: "EXACT MERCHANT",
  });
  return { db, householdId: registered.householdId, accountId, merchantId };
}

describe("exact refund reconciliation", () => {
  test("does not mistake investment reinvestment activity for a merchant refund", async () => {
    const { db, householdId, accountId, merchantId } = await fixture();
    await db
      .update(accounts)
      .set({ group: "investment", type: "brokerage" })
      .where(eq(accounts.id, accountId));
    await db.insert(transactions).values([
      {
        id: ulid(),
        householdId,
        accountId,
        merchantId,
        amount: -13n,
        currency: "USD",
        transactedOn: "2026-05-01",
        rawDescription: "REINVESTMENT FDRXX",
        normalizedDescription: "REINVESTMENT FDRXX",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
      {
        id: ulid(),
        householdId,
        accountId,
        merchantId,
        amount: 13n,
        currency: "USD",
        transactedOn: "2026-06-01",
        rawDescription: "DIVIDEND RECEIVED FDRXX",
        normalizedDescription: "DIVIDEND RECEIVED FDRXX",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
    ]);

    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 0 });
    expect(await db.select().from(refundLinks)).toHaveLength(0);
  });

  test("suggests a unique same-account merchant reversal without changing reports", async () => {
    const { db, householdId, accountId, merchantId } = await fixture();
    const purchaseId = ulid();
    const refundId = ulid();
    await db.insert(transactions).values([
      {
        id: purchaseId,
        householdId,
        accountId,
        merchantId,
        amount: -12_345n,
        currency: "USD",
        transactedOn: "2026-06-01",
        rawDescription: "EXACT MERCHANT PURCHASE",
        normalizedDescription: "EXACT MERCHANT PURCHASE",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
      {
        id: refundId,
        householdId,
        accountId,
        merchantId,
        amount: 12_345n,
        currency: "USD",
        transactedOn: "2026-06-03",
        rawDescription: "EXACT MERCHANT CREDIT",
        normalizedDescription: "EXACT MERCHANT CREDIT",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
    ]);

    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 1 });
    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 0 });
    expect(await db.select().from(refundLinks)).toEqual([
      expect.objectContaining({
        refundTransactionId: refundId,
        purchaseTransactionId: purchaseId,
        amount: 12_345n,
        status: "suggested",
      }),
    ]);
    expect(
      await db
        .select({
          id: transactions.id,
          isReimbursement: transactions.isReimbursement,
          isExcluded: transactions.isExcluded,
        })
        .from(transactions),
    ).toEqual([
      { id: purchaseId, isReimbursement: false, isExcluded: false },
      { id: refundId, isReimbursement: false, isExcluded: false },
    ]);

    await db
      .update(accounts)
      .set({ group: "investment", type: "brokerage" })
      .where(eq(accounts.id, accountId));
    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 0 });
    expect(await db.select().from(refundLinks)).toHaveLength(0);
  });

  test("keeps ambiguous and permanently rejected pairs out of later syncs", async () => {
    const { db, householdId, accountId, merchantId } = await fixture();
    const purchaseIds = [ulid(), ulid()];
    const refundId = ulid();
    await db.insert(transactions).values([
      ...purchaseIds.map((id, index) => ({
        id,
        householdId,
        accountId,
        merchantId,
        amount: -5_000n,
        currency: "USD",
        transactedOn: `2026-05-0${index + 1}`,
        rawDescription: "EXACT MERCHANT PURCHASE",
        normalizedDescription: "EXACT MERCHANT PURCHASE",
        status: "posted" as const,
        source: "provider" as const,
        reviewState: "none" as const,
      })),
      {
        id: refundId,
        householdId,
        accountId,
        merchantId,
        amount: 5_000n,
        currency: "USD",
        transactedOn: "2026-05-10",
        rawDescription: "EXACT MERCHANT CREDIT",
        normalizedDescription: "EXACT MERCHANT CREDIT",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
    ]);
    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 0 });

    await db
      .update(transactions)
      .set({ status: "removed" })
      .where(eq(transactions.id, purchaseIds[1]!));
    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 1 });
    await db.update(refundLinks).set({ status: "rejected" });
    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 0 });
    expect(await db.select().from(refundLinks)).toHaveLength(1);
  });

  test("scans past the newest page instead of starving older exact matches", async () => {
    const { db, householdId, accountId, merchantId } = await fixture();
    const filler = Array.from({ length: 505 }, (_, index) => ({
      id: ulid(),
      householdId,
      accountId,
      merchantId,
      amount: BigInt(-(20_000 + index)),
      currency: "USD",
      transactedOn: `2026-07-${String((index % 15) + 1).padStart(2, "0")}`,
      rawDescription: "EXACT MERCHANT FILLER",
      normalizedDescription: "EXACT MERCHANT FILLER",
      status: "posted" as const,
      source: "provider" as const,
      reviewState: "none" as const,
    }));
    for (let index = 0; index < filler.length; index += 100) {
      await db.insert(transactions).values(filler.slice(index, index + 100));
    }
    const purchaseId = ulid();
    const refundId = ulid();
    await db.insert(transactions).values([
      {
        id: purchaseId,
        householdId,
        accountId,
        merchantId,
        amount: -9_999n,
        currency: "USD",
        transactedOn: "2025-12-01",
        rawDescription: "EXACT MERCHANT OLD PURCHASE",
        normalizedDescription: "EXACT MERCHANT OLD PURCHASE",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
      {
        id: refundId,
        householdId,
        accountId,
        merchantId,
        amount: 9_999n,
        currency: "USD",
        transactedOn: "2025-12-02",
        rawDescription: "EXACT MERCHANT OLD CREDIT",
        normalizedDescription: "EXACT MERCHANT OLD CREDIT",
        status: "posted",
        source: "provider",
        reviewState: "none",
      },
    ]);

    expect(await reconcileAccountRefunds(db, householdId)).toEqual({ matched: 1 });
    expect(await db.select().from(refundLinks)).toEqual([
      expect.objectContaining({ refundTransactionId: refundId, purchaseTransactionId: purchaseId }),
    ]);
  });
});
