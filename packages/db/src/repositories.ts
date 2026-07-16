import {
  type AnyColumn,
  and,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { BetterWealthDatabase } from "./client.ts";
import { joinEncryptedPayload, splitEncryptedPayload } from "./encrypted-payload.ts";
import { addMinorUnits } from "./money.ts";
import {
  accounts,
  allocationEntries,
  attachments,
  auditEvents,
  balanceSnapshots,
  budgetPeriods,
  connections,
  envelopeAllocations,
  envelopes,
  goalContributions,
  goals,
  householdMembers,
  jobs,
  settings,
  tags,
  transactionSplits,
  transactions,
  transactionTags,
} from "./schema.ts";
import { withImmediateTransaction } from "./transactions.ts";

export class HouseholdScopeError extends Error {
  override readonly name = "HouseholdScopeError";
}

export class AggregateNotFoundError extends Error {
  override readonly name = "AggregateNotFoundError";
}

export interface HouseholdScopedTable {
  householdId: AnyColumn;
}

function validHouseholdId(householdId: string): string {
  if (householdId.length === 0) {
    throw new HouseholdScopeError("A non-empty household ID is required");
  }
  return householdId;
}

/** Mandatory predicate used by repositories and available to custom report queries. */
export function householdScope(table: HouseholdScopedTable, householdId: string): SQL {
  return eq(table.householdId, validHouseholdId(householdId));
}

/** Combine caller filters with the mandatory household predicate. */
export function householdAnd(
  table: HouseholdScopedTable,
  householdId: string,
  ...conditions: Array<SQL | undefined>
): SQL {
  return (
    and(householdScope(table, householdId), ...conditions) ?? householdScope(table, householdId)
  );
}

type NewAccount = typeof accounts.$inferInsert;
type NewTransaction = typeof transactions.$inferInsert;
type NewSplit = typeof transactionSplits.$inferInsert;
type NewAllocationEntry = typeof allocationEntries.$inferInsert;
type NewAuditEvent = typeof auditEvents.$inferInsert;
type NewConnection = typeof connections.$inferInsert;

export type ScopedAccountInsert = Omit<NewAccount, "householdId">;
export type ScopedTransactionInsert = Omit<NewTransaction, "householdId">;
export type ScopedSplitInsert = Omit<NewSplit, "householdId" | "transactionId">;
export type ScopedAllocationInsert = Omit<NewAllocationEntry, "householdId">;
export type ScopedAuditInsert = Omit<NewAuditEvent, "householdId">;
export type EncryptedConnectionInsert = Omit<
  NewConnection,
  | "householdId"
  | "credentialsCiphertext"
  | "credentialsNonce"
  | "credentialsAuthTag"
  | "credentialsKeyVersion"
> & { encryptedCredentials: string };

type StoredConnection = typeof connections.$inferSelect;
export type ConnectionWithEncryptedCredentials = Omit<
  StoredConnection,
  "credentialsCiphertext" | "credentialsNonce" | "credentialsAuthTag" | "credentialsKeyVersion"
> & { encryptedCredentials: string };

function connectionForApi(row: StoredConnection): ConnectionWithEncryptedCredentials {
  const {
    credentialsCiphertext,
    credentialsNonce,
    credentialsAuthTag,
    credentialsKeyVersion,
    ...safeColumns
  } = row;
  return {
    ...safeColumns,
    encryptedCredentials: joinEncryptedPayload({
      version: "v1",
      keyId: credentialsKeyVersion,
      nonce: credentialsNonce,
      authTag: credentialsAuthTag,
      ciphertext: credentialsCiphertext,
    }),
  };
}

export interface TransactionListOptions {
  accountId?: string;
  categoryId?: string;
  envelopeId?: string;
  fromDate?: string;
  toDate?: string;
  reviewState?: "none" | "needs_review" | "reviewed";
  status?: "pending" | "posted" | "removed" | "void";
  cursor?: { transactedOn: string; id: string };
  limit?: number;
}

function checkedLimit(value: number | undefined): number {
  const limit = value ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new RangeError("limit must be an integer between 1 and 200");
  }
  return limit;
}

export interface LatestAccountBalance {
  account: typeof accounts.$inferSelect;
  balance: typeof balanceSnapshots.$inferSelect | null;
}

export interface CategoryAmount {
  categoryId: string | null;
  currency: string;
  amount: bigint;
}

/**
 * Construct repositories bound to exactly one household. There is intentionally no method to
 * change the household ID after construction; switching tenants creates a fresh repository set.
 */
export function createHouseholdRepositories(db: BetterWealthDatabase, householdIdInput: string) {
  const householdId = validHouseholdId(householdIdInput);

  const findMembership = (userId: string) =>
    db
      .select()
      .from(householdMembers)
      .where(
        and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)),
      )
      .get();

  const membership = {
    find: findMembership,
    require(userId: string) {
      const member = findMembership(userId);
      if (member === undefined) {
        throw new HouseholdScopeError("User is not a member of this household");
      }
      return member;
    },
  };

  const connectionRepository = {
    list(): ConnectionWithEncryptedCredentials[] {
      return db
        .select()
        .from(connections)
        .where(householdScope(connections, householdId))
        .orderBy(connections.provider, connections.displayName)
        .all()
        .map(connectionForApi);
    },
    findById(id: string): ConnectionWithEncryptedCredentials | undefined {
      const row = db
        .select()
        .from(connections)
        .where(householdAnd(connections, householdId, eq(connections.id, id)))
        .get();
      return row === undefined ? undefined : connectionForApi(row);
    },
    create(input: EncryptedConnectionInsert): ConnectionWithEncryptedCredentials {
      const encrypted = splitEncryptedPayload(input.encryptedCredentials);
      const { encryptedCredentials: _encryptedCredentials, ...columns } = input;
      const row = db
        .insert(connections)
        .values({
          ...columns,
          householdId,
          credentialsKeyVersion: encrypted.keyId,
          credentialsNonce: encrypted.nonce,
          credentialsAuthTag: encrypted.authTag,
          credentialsCiphertext: encrypted.ciphertext,
        })
        .returning()
        .get();
      return connectionForApi(row);
    },
    updateEncryptedCredentials(id: string, encryptedCredentials: string, aad: string) {
      const encrypted = splitEncryptedPayload(encryptedCredentials);
      const row = db
        .update(connections)
        .set({
          credentialsKeyVersion: encrypted.keyId,
          credentialsNonce: encrypted.nonce,
          credentialsAuthTag: encrypted.authTag,
          credentialsCiphertext: encrypted.ciphertext,
          credentialsAad: aad,
          updatedAt: new Date().toISOString(),
        })
        .where(householdAnd(connections, householdId, eq(connections.id, id)))
        .returning()
        .get();
      return row === undefined ? undefined : connectionForApi(row);
    },
  };

  const accountRepository = {
    list(options: { includeHidden?: boolean } = {}) {
      return db
        .select()
        .from(accounts)
        .where(
          householdAnd(
            accounts,
            householdId,
            options.includeHidden === true ? undefined : sql`${accounts.status} <> 'hidden'`,
          ),
        )
        .orderBy(accounts.group, accounts.name)
        .all();
    },
    findById(id: string) {
      return db
        .select()
        .from(accounts)
        .where(householdAnd(accounts, householdId, eq(accounts.id, id)))
        .get();
    },
    create(input: ScopedAccountInsert) {
      return db
        .insert(accounts)
        .values({ ...input, householdId })
        .returning()
        .get();
    },
    latestBalances(): LatestAccountBalance[] {
      const scopedAccounts = db
        .select()
        .from(accounts)
        .where(householdScope(accounts, householdId))
        .orderBy(accounts.group, accounts.name)
        .all();
      const snapshots = db
        .select()
        .from(balanceSnapshots)
        .where(householdScope(balanceSnapshots, householdId))
        .orderBy(desc(balanceSnapshots.asOf), desc(balanceSnapshots.createdAt))
        .all();
      const latest = new Map<string, typeof balanceSnapshots.$inferSelect>();
      for (const snapshot of snapshots) {
        if (!latest.has(snapshot.accountId)) latest.set(snapshot.accountId, snapshot);
      }
      return scopedAccounts.map((account) => ({
        account,
        balance: latest.get(account.id) ?? null,
      }));
    },
  };

  const findTransactionById = (id: string) =>
    db
      .select()
      .from(transactions)
      .where(householdAnd(transactions, householdId, eq(transactions.id, id)))
      .get();

  const transactionRepository = {
    list(options: TransactionListOptions = {}) {
      const cursor = options.cursor;
      const cursorFilter =
        cursor === undefined
          ? undefined
          : or(
              lt(transactions.transactedOn, cursor.transactedOn),
              and(
                eq(transactions.transactedOn, cursor.transactedOn),
                lt(transactions.id, cursor.id),
              ),
            );
      return db
        .select()
        .from(transactions)
        .where(
          householdAnd(
            transactions,
            householdId,
            options.accountId === undefined
              ? undefined
              : eq(transactions.accountId, options.accountId),
            options.categoryId === undefined
              ? undefined
              : eq(transactions.categoryId, options.categoryId),
            options.envelopeId === undefined
              ? undefined
              : eq(transactions.envelopeId, options.envelopeId),
            options.fromDate === undefined
              ? undefined
              : gte(transactions.transactedOn, options.fromDate),
            options.toDate === undefined
              ? undefined
              : lte(transactions.transactedOn, options.toDate),
            options.reviewState === undefined
              ? undefined
              : eq(transactions.reviewState, options.reviewState),
            options.status === undefined ? undefined : eq(transactions.status, options.status),
            cursorFilter,
          ),
        )
        .orderBy(desc(transactions.transactedOn), desc(transactions.id))
        .limit(checkedLimit(options.limit))
        .all();
    },
    findById: findTransactionById,
    create(input: ScopedTransactionInsert) {
      return db
        .insert(transactions)
        .values({ ...input, householdId })
        .returning()
        .get();
    },
    getAggregate(id: string) {
      const transaction = findTransactionById(id);
      if (transaction === undefined) return undefined;
      const splits = db
        .select()
        .from(transactionSplits)
        .where(
          householdAnd(transactionSplits, householdId, eq(transactionSplits.transactionId, id)),
        )
        .orderBy(transactionSplits.sequence)
        .all();
      const attachedTags = db
        .select({ tag: tags })
        .from(transactionTags)
        .innerJoin(
          tags,
          and(
            eq(tags.householdId, transactionTags.householdId),
            eq(tags.id, transactionTags.tagId),
          ),
        )
        .where(householdAnd(transactionTags, householdId, eq(transactionTags.transactionId, id)))
        .all()
        .map((row) => row.tag);
      const transactionAttachments = db
        .select()
        .from(attachments)
        .where(householdAnd(attachments, householdId, eq(attachments.transactionId, id)))
        .orderBy(attachments.createdAt)
        .all();
      return { transaction, splits, tags: attachedTags, attachments: transactionAttachments };
    },
    replaceSplits(transactionId: string, splits: ScopedSplitInsert[]) {
      return withImmediateTransaction(db, (tx) => {
        const parent = tx
          .select()
          .from(transactions)
          .where(householdAnd(transactions, householdId, eq(transactions.id, transactionId)))
          .get();
        if (parent === undefined) {
          throw new AggregateNotFoundError("Transaction does not exist in this household");
        }
        if (splits.length < 2) {
          throw new RangeError("A split transaction requires at least two splits");
        }
        let total = 0n;
        for (const split of splits) total = addMinorUnits(total, split.amount);
        if (total !== parent.amount) {
          throw new RangeError("Transaction split amounts must exactly equal the parent amount");
        }
        tx.delete(transactionSplits)
          .where(
            householdAnd(
              transactionSplits,
              householdId,
              eq(transactionSplits.transactionId, transactionId),
            ),
          )
          .run();
        return tx
          .insert(transactionSplits)
          .values(
            splits.map((split) => ({
              ...split,
              householdId,
              transactionId,
            })),
          )
          .returning()
          .all();
      });
    },
    spendingByCategory(fromDate: string, toDate: string): CategoryAmount[] {
      const rows = db
        .select({
          categoryId: transactions.categoryId,
          currency: transactions.currency,
          amount: transactions.amount,
        })
        .from(transactions)
        .where(
          householdAnd(
            transactions,
            householdId,
            eq(transactions.status, "posted"),
            eq(transactions.isExcluded, false),
            eq(transactions.isTransfer, false),
            gte(transactions.transactedOn, fromDate),
            lte(transactions.transactedOn, toDate),
          ),
        )
        .all();
      const totals = new Map<string, CategoryAmount>();
      for (const row of rows) {
        const key = `${row.categoryId ?? ""}\u0000${row.currency}`;
        const existing = totals.get(key);
        totals.set(key, {
          categoryId: row.categoryId,
          currency: row.currency,
          amount: addMinorUnits(existing?.amount ?? 0n, row.amount),
        });
      }
      return [...totals.values()];
    },
  };

  const budgetRepository = {
    listPeriods() {
      return db
        .select()
        .from(budgetPeriods)
        .where(householdScope(budgetPeriods, householdId))
        .orderBy(desc(budgetPeriods.startsOn))
        .all();
    },
    getPeriodAggregate(periodId: string) {
      const period = db
        .select()
        .from(budgetPeriods)
        .where(householdAnd(budgetPeriods, householdId, eq(budgetPeriods.id, periodId)))
        .get();
      if (period === undefined) return undefined;
      const allocations = db
        .select({ allocation: envelopeAllocations, envelope: envelopes })
        .from(envelopeAllocations)
        .innerJoin(
          envelopes,
          and(
            eq(envelopes.householdId, envelopeAllocations.householdId),
            eq(envelopes.id, envelopeAllocations.envelopeId),
          ),
        )
        .where(
          householdAnd(
            envelopeAllocations,
            householdId,
            eq(envelopeAllocations.budgetPeriodId, periodId),
          ),
        )
        .orderBy(envelopes.priority, envelopes.name)
        .all();
      const entries = db
        .select()
        .from(allocationEntries)
        .where(
          householdAnd(
            allocationEntries,
            householdId,
            eq(allocationEntries.budgetPeriodId, periodId),
          ),
        )
        .orderBy(allocationEntries.createdAt, allocationEntries.batchId, allocationEntries.sequence)
        .all();
      return { period, allocations, entries };
    },
    postAllocationBatch(entries: ScopedAllocationInsert[]) {
      if (entries.length === 0) throw new RangeError("Allocation batch cannot be empty");
      const batchId = entries[0]?.batchId;
      if (batchId === undefined || entries.some((entry) => entry.batchId !== batchId)) {
        throw new RangeError("All allocation entries must share one batch ID");
      }
      const sequences = new Set(entries.map((entry) => entry.sequence));
      if (sequences.size !== entries.length) {
        throw new RangeError("Allocation entry sequence numbers must be unique within the batch");
      }
      return withImmediateTransaction(db, (tx) =>
        tx
          .insert(allocationEntries)
          .values(entries.map((entry) => ({ ...entry, householdId })))
          .returning()
          .all(),
      );
    },
  };

  const goalRepository = {
    list() {
      return db
        .select()
        .from(goals)
        .where(householdScope(goals, householdId))
        .orderBy(goals.priority, goals.createdAt)
        .all();
    },
    getAggregate(id: string) {
      const goal = db
        .select()
        .from(goals)
        .where(householdAnd(goals, householdId, eq(goals.id, id)))
        .get();
      if (goal === undefined) return undefined;
      const contributions = db
        .select()
        .from(goalContributions)
        .where(householdAnd(goalContributions, householdId, eq(goalContributions.goalId, id)))
        .orderBy(goalContributions.contributedOn, goalContributions.createdAt)
        .all();
      let contributedAmount = 0n;
      for (const contribution of contributions) {
        contributedAmount = addMinorUnits(contributedAmount, contribution.amount);
      }
      return { goal, contributions, contributedAmount };
    },
  };

  const jobRepository = {
    claimNext(workerId: string, at: string, leaseExpiresAt: string, types?: string[]) {
      return withImmediateTransaction(db, (tx) => {
        const candidate = tx
          .select()
          .from(jobs)
          .where(
            householdAnd(
              jobs,
              householdId,
              lte(jobs.scheduledAt, at),
              sql`${jobs.attempts} < ${jobs.maxAttempts}`,
              or(
                eq(jobs.state, "queued"),
                and(eq(jobs.state, "leased"), lte(jobs.leaseExpiresAt, at)),
              ),
              types === undefined || types.length === 0 ? undefined : inArray(jobs.type, types),
            ),
          )
          .orderBy(jobs.scheduledAt, jobs.createdAt)
          .limit(1)
          .get();
        if (candidate === undefined) return undefined;
        return tx
          .update(jobs)
          .set({
            state: "leased",
            leaseOwner: workerId,
            leaseExpiresAt,
            heartbeatAt: at,
            leaseEpoch: sql`${jobs.leaseEpoch} + 1`,
            attempts: sql`${jobs.attempts} + 1`,
            updatedAt: at,
          })
          .where(
            householdAnd(
              jobs,
              householdId,
              eq(jobs.id, candidate.id),
              eq(jobs.leaseEpoch, candidate.leaseEpoch),
            ),
          )
          .returning()
          .get();
      });
    },
    heartbeat(
      id: string,
      workerId: string,
      leaseEpoch: number,
      at: string,
      leaseExpiresAt: string,
    ) {
      return (
        db
          .update(jobs)
          .set({ heartbeatAt: at, leaseExpiresAt, updatedAt: at })
          .where(
            householdAnd(
              jobs,
              householdId,
              eq(jobs.id, id),
              eq(jobs.state, "leased"),
              eq(jobs.leaseOwner, workerId),
              eq(jobs.leaseEpoch, leaseEpoch),
            ),
          )
          .returning({ id: jobs.id })
          .get() !== undefined
      );
    },
    complete(id: string, workerId: string, leaseEpoch: number, at: string) {
      return (
        db
          .update(jobs)
          .set({
            state: "succeeded",
            completedAt: at,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: at,
            updatedAt: at,
          })
          .where(
            householdAnd(
              jobs,
              householdId,
              eq(jobs.id, id),
              eq(jobs.state, "leased"),
              eq(jobs.leaseOwner, workerId),
              eq(jobs.leaseEpoch, leaseEpoch),
            ),
          )
          .returning({ id: jobs.id })
          .get() !== undefined
      );
    },
  };

  const settingsRepository = {
    get(key: string, userId?: string) {
      const scopeKey = userId ?? "household";
      return db
        .select()
        .from(settings)
        .where(
          householdAnd(
            settings,
            householdId,
            eq(settings.scopeKey, scopeKey),
            eq(settings.key, key),
          ),
        )
        .get();
    },
    set(id: string, key: string, value: unknown, userId?: string) {
      const scopeKey = userId ?? "household";
      const timestamp = new Date().toISOString();
      return db
        .insert(settings)
        .values({
          id,
          householdId,
          userId: userId ?? null,
          scopeKey,
          key,
          value,
          updatedAt: timestamp,
        })
        .onConflictDoUpdate({
          target: [settings.householdId, settings.scopeKey, settings.key],
          set: { value, updatedAt: timestamp },
        })
        .returning()
        .get();
    },
  };

  const auditRepository = {
    append(input: ScopedAuditInsert) {
      return db
        .insert(auditEvents)
        .values({ ...input, householdId })
        .returning()
        .get();
    },
    list(limit = 100) {
      return db
        .select()
        .from(auditEvents)
        .where(householdScope(auditEvents, householdId))
        .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
        .limit(checkedLimit(Math.min(limit, 200)))
        .all();
    },
  };

  return {
    householdId,
    membership,
    connections: connectionRepository,
    accounts: accountRepository,
    transactions: transactionRepository,
    budgets: budgetRepository,
    goals: goalRepository,
    jobs: jobRepository,
    settings: settingsRepository,
    audit: auditRepository,
  };
}

export type HouseholdRepositories = ReturnType<typeof createHouseholdRepositories>;
