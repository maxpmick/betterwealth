import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { BetterWealthDatabase } from "./client.ts";
import { closeDatabase, foreignKeysEnabled, getJournalMode, openDatabase } from "./client.ts";
import { joinEncryptedPayload } from "./encrypted-payload.ts";
import { DEFAULT_MIGRATIONS_FOLDER, runMigrations } from "./migrations.ts";
import { MAX_MINOR_UNITS, MIN_MINOR_UNITS, parseMinorUnits } from "./money.ts";
import { createHouseholdRepositories } from "./repositories.ts";
import {
  categories,
  householdMembers,
  households,
  transactionSplits,
  transfers,
  users,
} from "./schema.ts";
import { withTransaction } from "./transactions.ts";

let directory: string;
let db: BetterWealthDatabase;

function seedIdentity(): void {
  db.insert(users)
    .values([
      {
        id: "usr_alex",
        email: "alex@example.test",
        normalizedEmail: "alex@example.test",
        passwordHash: "argon2id-test",
        displayName: "Alex",
      },
      {
        id: "usr_blair",
        email: "blair@example.test",
        normalizedEmail: "blair@example.test",
        passwordHash: "argon2id-test",
        displayName: "Blair",
      },
    ])
    .run();
  db.insert(households)
    .values([
      { id: "hh_alex", name: "Alex household", baseCurrency: "USD" },
      { id: "hh_blair", name: "Blair household", baseCurrency: "USD" },
    ])
    .run();
  db.insert(householdMembers)
    .values([
      { householdId: "hh_alex", userId: "usr_alex", role: "owner" },
      { householdId: "hh_blair", userId: "usr_blair", role: "owner" },
    ])
    .run();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "betterwealth-db-"));
  db = openDatabase(join(directory, "test.sqlite"));
  runMigrations(db);
});

afterEach(() => {
  closeDatabase(db);
  rmSync(directory, { recursive: true, force: true });
});

describe("database connection and migrations", () => {
  test("enables WAL, foreign keys, busy timeout, and applies the initial migration idempotently", () => {
    expect(getJournalMode(db)).toBe("wal");
    expect(foreignKeysEnabled(db)).toBe(true);
    expect(db.$client.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
      5000,
    );
    expect(
      db.$client.query<{ temp_store: number }, []>("PRAGMA temp_store").get()?.temp_store,
    ).toBe(2);
    expect(
      db.$client.query<{ secure_delete: number }, []>("PRAGMA secure_delete").get()?.secure_delete,
    ).toBe(2);

    runMigrations(db);
    const tableCount = db.$client
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get();
    expect(tableCount?.count).toBe(49);
    expect(db.$client.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("creates the household/date and review indexes used by the ledger", () => {
    const indexes = db.$client
      .query<{ name: string }, []>("PRAGMA index_list('transactions')")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("transactions_household_date_id_idx");
    expect(indexes).toContain("transactions_household_review_date_idx");
    expect(indexes).toContain("transactions_connection_account_external_uq");

    const queryPlan = db.$client
      .query<{ detail: string }, [string]>(
        "EXPLAIN QUERY PLAN SELECT * FROM transactions WHERE household_id = ? ORDER BY transacted_on DESC, id DESC LIMIT 50",
      )
      .all("hh_alex")
      .map((row) => row.detail)
      .join(" ");
    expect(queryPlan).toContain("transactions_household_date_id_idx");
  });

  test("upgrades a database at migration 0000 through the transfer guards", () => {
    const legacyMigrations = join(directory, "legacy-migrations");
    mkdirSync(join(legacyMigrations, "meta"), { recursive: true });
    copyFileSync(
      join(DEFAULT_MIGRATIONS_FOLDER, "0000_initial.sql"),
      join(legacyMigrations, "0000_initial.sql"),
    );
    const journal = JSON.parse(
      readFileSync(join(DEFAULT_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    writeFileSync(
      join(legacyMigrations, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }),
    );

    const upgradeDb = openDatabase(join(directory, "upgrade.sqlite"), { wal: false });
    try {
      runMigrations(upgradeDb, { migrationsFolder: legacyMigrations });
      expect(
        upgradeDb.$client
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'transfers_active_transaction_%_guard'",
          )
          .get()?.count,
      ).toBe(0);
      runMigrations(upgradeDb);
      expect(
        upgradeDb.$client
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'transfers_active_transaction_%_guard'",
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      closeDatabase(upgradeDb);
    }
  });
});

describe("constraints and household isolation", () => {
  beforeEach(seedIdentity);

  test("enforces global identity uniqueness, enum checks, and foreign keys", () => {
    expect(() =>
      db
        .insert(users)
        .values({
          id: "usr_duplicate",
          email: "ALEX@example.test",
          normalizedEmail: "alex@example.test",
          passwordHash: "hash",
          displayName: "Duplicate",
        })
        .run(),
    ).toThrow();

    expect(() =>
      db
        .insert(householdMembers)
        .values({
          householdId: "hh_alex",
          userId: "missing-user",
          role: "owner",
        })
        .run(),
    ).toThrow();

    expect(() =>
      db.$client
        .query(
          "INSERT INTO household_members (household_id, user_id, role, status) VALUES (?, ?, ?, ?)",
        )
        .run("hh_alex", "usr_blair", "superuser", "active"),
    ).toThrow();
  });

  test("prevents cross-household financial references at the database boundary", () => {
    const alex = createHouseholdRepositories(db, "hh_alex");
    const blair = createHouseholdRepositories(db, "hh_blair");
    alex.accounts.create({
      id: "acct_alex",
      name: "Alex checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });
    blair.accounts.create({
      id: "acct_blair",
      name: "Blair checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });

    expect(() =>
      alex.transactions.create({
        id: "txn_cross_tenant",
        accountId: "acct_blair",
        amount: -100n,
        currency: "USD",
        transactedOn: "2026-07-01",
        rawDescription: "Cross tenant",
        normalizedDescription: "cross tenant",
        status: "posted",
        source: "manual",
      }),
    ).toThrow();
  });

  test("repository reads cannot return another household's rows", () => {
    const alex = createHouseholdRepositories(db, "hh_alex");
    const blair = createHouseholdRepositories(db, "hh_blair");
    alex.accounts.create({
      id: "acct_alex",
      name: "Alex checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });
    blair.accounts.create({
      id: "acct_blair",
      name: "Blair checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });
    blair.transactions.create({
      id: "txn_blair",
      accountId: "acct_blair",
      amount: -2500n,
      currency: "USD",
      transactedOn: "2026-07-03",
      rawDescription: "Blair purchase",
      normalizedDescription: "blair purchase",
      status: "posted",
      source: "manual",
    });

    expect(alex.accounts.list().map((account) => account.id)).toEqual(["acct_alex"]);
    expect(alex.transactions.findById("txn_blair")).toBeUndefined();
    expect(alex.transactions.list()).toEqual([]);
    expect(blair.transactions.list().map((transaction) => transaction.id)).toEqual(["txn_blair"]);
  });

  test("prevents active transfers from reusing a transaction on the opposite side", () => {
    const alex = createHouseholdRepositories(db, "hh_alex");
    alex.accounts.create({
      id: "acct_transfer_guard",
      name: "Transfer guard checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });
    for (const [id, amount] of [
      ["txn_transfer_a", -1_000n],
      ["txn_transfer_b", 1_000n],
      ["txn_transfer_c", 1_000n],
    ] as const) {
      alex.transactions.create({
        id,
        accountId: "acct_transfer_guard",
        amount,
        currency: "USD",
        transactedOn: "2026-07-08",
        rawDescription: id,
        normalizedDescription: id,
        status: "posted",
        source: "manual",
      });
    }
    db.insert(transfers)
      .values({
        id: "transfer_active",
        householdId: "hh_alex",
        outflowTransactionId: "txn_transfer_a",
        inflowTransactionId: "txn_transfer_b",
        confidenceBps: 10_000,
        status: "confirmed",
        matchedBy: "user",
      })
      .run();

    expect(() =>
      db
        .insert(transfers)
        .values({
          id: "transfer_cross_role",
          householdId: "hh_alex",
          outflowTransactionId: "txn_transfer_b",
          inflowTransactionId: "txn_transfer_c",
          confidenceBps: 9_000,
          status: "suggested",
          matchedBy: "fingerprint",
        })
        .run(),
    ).toThrow("transaction already belongs to an active transfer");

    db.insert(transfers)
      .values({
        id: "transfer_tombstone",
        householdId: "hh_alex",
        outflowTransactionId: "txn_transfer_b",
        inflowTransactionId: "txn_transfer_c",
        confidenceBps: 9_000,
        status: "rejected",
        matchedBy: "fingerprint",
      })
      .run();
    expect(() =>
      db
        .update(transfers)
        .set({ status: "suggested" })
        .where(eq(transfers.id, "transfer_tombstone"))
        .run(),
    ).toThrow("transaction already belongs to an active transfer");

    db.update(transfers)
      .set({ status: "rejected" })
      .where(eq(transfers.id, "transfer_active"))
      .run();
    db.update(transfers)
      .set({ status: "suggested" })
      .where(eq(transfers.id, "transfer_tombstone"))
      .run();
    expect(
      db
        .select({ id: transfers.id, status: transfers.status })
        .from(transfers)
        .where(eq(transfers.status, "suggested"))
        .all(),
    ).toEqual([{ id: "transfer_tombstone", status: "suggested" }]);
  });

  test("stores signed 64-bit minor units as canonical text and rejects malformed raw values", () => {
    const alex = createHouseholdRepositories(db, "hh_alex");
    alex.accounts.create({
      id: "acct_alex",
      name: "Alex checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });
    alex.transactions.create({
      id: "txn_max",
      accountId: "acct_alex",
      amount: MAX_MINOR_UNITS,
      currency: "USD",
      transactedOn: "2026-07-04",
      rawDescription: "Maximum",
      normalizedDescription: "maximum",
      status: "posted",
      source: "manual",
    });
    alex.transactions.create({
      id: "txn_min",
      accountId: "acct_alex",
      amount: MIN_MINOR_UNITS,
      currency: "USD",
      transactedOn: "2026-07-05",
      rawDescription: "Minimum",
      normalizedDescription: "minimum",
      status: "posted",
      source: "manual",
    });

    expect(alex.transactions.findById("txn_max")?.amount).toBe(MAX_MINOR_UNITS);
    expect(alex.transactions.findById("txn_min")?.amount).toBe(MIN_MINOR_UNITS);
    const storage = db.$client
      .query<{ amount: string; storage: string }, [string]>(
        "SELECT amount, typeof(amount) AS storage FROM transactions WHERE id = ?",
      )
      .get("txn_max");
    expect(storage).toEqual({ amount: "9223372036854775807", storage: "text" });
    expect(() => parseMinorUnits("01")).toThrow();
    expect(() => parseMinorUnits("9223372036854775808")).toThrow();

    expect(() =>
      db.$client
        .query(
          `INSERT INTO transactions
            (id, household_id, account_id, amount, currency, transacted_on, raw_description,
             normalized_description, status, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "txn_bad_money",
          "hh_alex",
          "acct_alex",
          "01",
          "USD",
          "2026-07-06",
          "Invalid",
          "invalid",
          "posted",
          "manual",
        ),
    ).toThrow();
  });
});

describe("atomic aggregate operations", () => {
  beforeEach(() => {
    seedIdentity();
    createHouseholdRepositories(db, "hh_alex").accounts.create({
      id: "acct_alex",
      name: "Alex checking",
      group: "cash",
      type: "checking",
      currency: "USD",
    });
  });

  test("rolls back every write when a transaction callback throws", () => {
    expect(() =>
      withTransaction(db, (tx) => {
        tx.insert(categories)
          .values({
            id: "cat_rolled_back",
            householdId: "hh_alex",
            name: "Rolled back",
            slug: "rolled-back",
            kind: "expense",
          })
          .run();
        throw new Error("force rollback");
      }),
    ).toThrow("force rollback");

    expect(
      db.select().from(categories).where(eq(categories.id, "cat_rolled_back")).get(),
    ).toBeUndefined();
  });

  test("replaces transaction splits atomically and validates the conserved sum", () => {
    const alex = createHouseholdRepositories(db, "hh_alex");
    alex.transactions.create({
      id: "txn_split",
      accountId: "acct_alex",
      amount: -10000n,
      currency: "USD",
      transactedOn: "2026-07-07",
      rawDescription: "Split purchase",
      normalizedDescription: "split purchase",
      status: "posted",
      source: "manual",
    });
    const saved = alex.transactions.replaceSplits("txn_split", [
      { id: "split_1", sequence: 0, amount: -6000n },
      { id: "split_2", sequence: 1, amount: -4000n },
    ]);
    expect(saved.map((split) => split.amount)).toEqual([-6000n, -4000n]);

    expect(() =>
      alex.transactions.replaceSplits("txn_split", [
        { id: "split_bad_1", sequence: 0, amount: -5000n },
        { id: "split_bad_2", sequence: 1, amount: -4000n },
      ]),
    ).toThrow("exactly equal");
    expect(
      db
        .select()
        .from(transactionSplits)
        .where(eq(transactionSplits.transactionId, "txn_split"))
        .all()
        .map((split) => split.id),
    ).toEqual(["split_1", "split_2"]);
  });

  test("round-trips combined encrypted connection credentials without exposing split storage", () => {
    const alex = createHouseholdRepositories(db, "hh_alex");
    const encryptedCredentials = joinEncryptedPayload({
      version: "v1",
      keyId: "primary-key",
      nonce: Buffer.alloc(12, 1),
      authTag: Buffer.alloc(16, 2),
      ciphertext: Buffer.from("ciphertext"),
    });
    const connection = alex.connections.create({
      id: "conn_simplefin",
      ownerUserId: "usr_alex",
      provider: "simplefin",
      displayName: "SimpleFIN",
      encryptedCredentials,
      credentialsAad: "connection:conn_simplefin:hh_alex",
      capabilities: ["accounts", "transactions"],
    });
    expect(connection.encryptedCredentials).toBe(encryptedCredentials);
    expect(alex.connections.findById("conn_simplefin")?.encryptedCredentials).toBe(
      encryptedCredentials,
    );
    expect("credentialsCiphertext" in connection).toBe(false);
  });
});
