import type { BetterWealthDatabase } from "./client.ts";

type TransactionCallback = Parameters<BetterWealthDatabase["transaction"]>[0];
export type BetterWealthTransaction = Parameters<TransactionCallback>[0];
export type DatabaseExecutor = BetterWealthDatabase | BetterWealthTransaction;

/** Run work atomically using SQLite's default deferred transaction. */
export function withTransaction<T>(
  db: BetterWealthDatabase,
  operation: (tx: BetterWealthTransaction) => T,
): T {
  return db.transaction(operation);
}

/**
 * Acquire the write reservation at the start of the transaction. Use for conserved allocations,
 * job leasing, reconciliation, and other read-modify-write operations.
 */
export function withImmediateTransaction<T>(
  db: BetterWealthDatabase,
  operation: (tx: BetterWealthTransaction) => T,
): T {
  return db.transaction(operation, { behavior: "immediate" });
}

/** Use an exclusive transaction for short deployment/maintenance operations. */
export function withExclusiveTransaction<T>(
  db: BetterWealthDatabase,
  operation: (tx: BetterWealthTransaction) => T,
): T {
  return db.transaction(operation, { behavior: "exclusive" });
}
