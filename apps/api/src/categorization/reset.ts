import type { BetterWealthDatabase } from "@betterwealth/db";
import {
  aiSuggestions,
  auditEvents,
  categories,
  envelopeRuleLinks,
  householdMembers,
  refundLinks,
  ruleRuns,
  rules,
  transactionSplits,
  transactions,
  transfers,
} from "@betterwealth/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { ConflictError, ForbiddenError } from "../lib/errors";

const RESET_BATCH_SIZE = 400;

export interface ResetCategorizationInput {
  db: BetterWealthDatabase;
  householdId: string;
  userId: string;
  apply?: boolean;
  testHooks?: {
    beforeCommit?: () => void | Promise<void>;
  };
}

export interface ResetCategorizationSummary {
  mode: "dry-run" | "applied";
  transactionsScanned: number;
  transactionsChanged: number;
  transactionCategoriesCleared: number;
  transactionMerchantsCleared: number;
  transactionEnvelopesCleared: number;
  transactionIncomeFlagsCleared: number;
  transactionReviewsQueued: number;
  unconfirmedTransferFlagsCleared: number;
  unconfirmedRefundFlagsCleared: number;
  confirmedMovementFlagsRepaired: number;
  userOverridesCleared: number;
  splitsChanged: number;
  splitCategoriesCleared: number;
  splitEnvelopesCleared: number;
  aiSuggestionsDeleted: number;
  ruleRunsDeleted: number;
  envelopeRuleLinksDeleted: number;
  rulesDeleted: number;
  categoriesPreserved: number;
  confirmedTransfersPreserved: number;
  confirmedRefundsPreserved: number;
  auditEventId: string | null;
}

type ResetTransaction = Pick<
  typeof transactions.$inferSelect,
  | "id"
  | "categoryId"
  | "categoryOrigin"
  | "merchantId"
  | "envelopeId"
  | "isIncome"
  | "isTransfer"
  | "isExcluded"
  | "isReimbursement"
  | "reviewState"
  | "status"
  | "userOverrideAt"
>;

type ResetSplit = Pick<typeof transactionSplits.$inferSelect, "id" | "categoryId" | "envelopeId">;

interface ResetInspection {
  changedTransactions: ResetTransaction[];
  changedSplits: ResetSplit[];
  confirmedTransferTransactionIds: Set<string>;
  confirmedRefundTransactionIds: Set<string>;
  summary: Omit<ResetCategorizationSummary, "mode" | "auditEventId">;
}

function chunks<T>(values: readonly T[], size = RESET_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function merchantWasCategorizationDerived(transaction: ResetTransaction): boolean {
  return (
    transaction.merchantId !== null &&
    (transaction.categoryOrigin === "ai" || transaction.categoryOrigin === "rule")
  );
}

function shouldQueueForReview(
  transaction: ResetTransaction,
  confirmedTransferTransactionIds: ReadonlySet<string>,
): boolean {
  return (
    (transaction.status === "pending" || transaction.status === "posted") &&
    !confirmedTransferTransactionIds.has(transaction.id)
  );
}

function confirmedMovementFlagsNeedRepair(
  transaction: ResetTransaction,
  confirmedTransferTransactionIds: ReadonlySet<string>,
  confirmedRefundTransactionIds: ReadonlySet<string>,
) {
  if (confirmedTransferTransactionIds.has(transaction.id)) {
    return (
      !transaction.isTransfer ||
      !transaction.isExcluded ||
      transaction.isIncome ||
      transaction.isReimbursement
    );
  }
  if (confirmedRefundTransactionIds.has(transaction.id)) {
    return (
      transaction.isTransfer ||
      transaction.isExcluded ||
      transaction.isIncome ||
      !transaction.isReimbursement
    );
  }
  return false;
}

function transactionNeedsReset(
  transaction: ResetTransaction,
  confirmedTransferTransactionIds: ReadonlySet<string>,
  confirmedRefundTransactionIds: ReadonlySet<string>,
): boolean {
  return (
    transaction.categoryId !== null ||
    transaction.categoryOrigin !== "none" ||
    merchantWasCategorizationDerived(transaction) ||
    transaction.envelopeId !== null ||
    transaction.isIncome ||
    (transaction.isTransfer && !confirmedTransferTransactionIds.has(transaction.id)) ||
    (transaction.isReimbursement && !confirmedRefundTransactionIds.has(transaction.id)) ||
    confirmedMovementFlagsNeedRepair(
      transaction,
      confirmedTransferTransactionIds,
      confirmedRefundTransactionIds,
    ) ||
    transaction.userOverrideAt !== null ||
    (shouldQueueForReview(transaction, confirmedTransferTransactionIds) &&
      transaction.reviewState !== "needs_review")
  );
}

async function assertResetAuthority(
  db: BetterWealthDatabase,
  householdId: string,
  userId: string,
): Promise<void> {
  const membership = await db
    .select({ role: householdMembers.role, status: householdMembers.status })
    .from(householdMembers)
    .where(and(eq(householdMembers.householdId, householdId), eq(householdMembers.userId, userId)))
    .get();
  const authorized =
    membership?.status === "active" && (membership.role === "owner" || membership.role === "admin");
  if (!authorized) {
    throw new ForbiddenError("Only an active household owner or admin can reset categorization");
  }
}

async function inspectReset(
  db: BetterWealthDatabase,
  householdId: string,
): Promise<ResetInspection> {
  const [transactionRows, splitRows, countRows, confirmedTransferRows, confirmedRefundRows] =
    await Promise.all([
      db
        .select({
          id: transactions.id,
          categoryId: transactions.categoryId,
          categoryOrigin: transactions.categoryOrigin,
          merchantId: transactions.merchantId,
          envelopeId: transactions.envelopeId,
          isIncome: transactions.isIncome,
          isTransfer: transactions.isTransfer,
          isExcluded: transactions.isExcluded,
          isReimbursement: transactions.isReimbursement,
          reviewState: transactions.reviewState,
          status: transactions.status,
          userOverrideAt: transactions.userOverrideAt,
        })
        .from(transactions)
        .where(eq(transactions.householdId, householdId)),
      db
        .select({
          id: transactionSplits.id,
          categoryId: transactionSplits.categoryId,
          envelopeId: transactionSplits.envelopeId,
        })
        .from(transactionSplits)
        .where(eq(transactionSplits.householdId, householdId)),
      Promise.all([
        db
          .select({ count: sql<number>`count(*)` })
          .from(aiSuggestions)
          .where(eq(aiSuggestions.householdId, householdId))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(ruleRuns)
          .where(eq(ruleRuns.householdId, householdId))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(envelopeRuleLinks)
          .where(eq(envelopeRuleLinks.householdId, householdId))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(rules)
          .where(eq(rules.householdId, householdId))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(categories)
          .where(eq(categories.householdId, householdId))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(transfers)
          .where(and(eq(transfers.householdId, householdId), eq(transfers.status, "confirmed")))
          .get(),
        db
          .select({ count: sql<number>`count(*)` })
          .from(refundLinks)
          .where(and(eq(refundLinks.householdId, householdId), eq(refundLinks.status, "confirmed")))
          .get(),
      ]),
      db
        .select({
          outflowTransactionId: transfers.outflowTransactionId,
          inflowTransactionId: transfers.inflowTransactionId,
        })
        .from(transfers)
        .where(and(eq(transfers.householdId, householdId), eq(transfers.status, "confirmed"))),
      db
        .select({ refundTransactionId: refundLinks.refundTransactionId })
        .from(refundLinks)
        .where(and(eq(refundLinks.householdId, householdId), eq(refundLinks.status, "confirmed"))),
    ]);
  const confirmedTransferTransactionIds = new Set(
    confirmedTransferRows.flatMap(({ outflowTransactionId, inflowTransactionId }) => [
      outflowTransactionId,
      inflowTransactionId,
    ]),
  );
  const confirmedRefundTransactionIds = new Set(
    confirmedRefundRows.map(({ refundTransactionId }) => refundTransactionId),
  );
  if ([...confirmedTransferTransactionIds].some((id) => confirmedRefundTransactionIds.has(id))) {
    throw new ConflictError(
      "A transaction cannot be both a confirmed transfer and confirmed refund",
      "categorization_reset_movement_conflict",
    );
  }
  const changedTransactions = transactionRows.filter((transaction) =>
    transactionNeedsReset(
      transaction,
      confirmedTransferTransactionIds,
      confirmedRefundTransactionIds,
    ),
  );
  const changedSplits = splitRows.filter(
    ({ categoryId, envelopeId }) => categoryId !== null || envelopeId !== null,
  );
  const countAt = (index: number) => Number(countRows[index]?.count ?? 0);
  return {
    changedTransactions,
    changedSplits,
    confirmedTransferTransactionIds,
    confirmedRefundTransactionIds,
    summary: {
      transactionsScanned: transactionRows.length,
      transactionsChanged: changedTransactions.length,
      transactionCategoriesCleared: transactionRows.filter(({ categoryId }) => categoryId !== null)
        .length,
      transactionMerchantsCleared: transactionRows.filter(merchantWasCategorizationDerived).length,
      transactionEnvelopesCleared: transactionRows.filter(({ envelopeId }) => envelopeId !== null)
        .length,
      transactionIncomeFlagsCleared: transactionRows.filter(({ isIncome }) => isIncome).length,
      transactionReviewsQueued: transactionRows.filter(
        (transaction) =>
          shouldQueueForReview(transaction, confirmedTransferTransactionIds) &&
          transaction.reviewState !== "needs_review",
      ).length,
      unconfirmedTransferFlagsCleared: transactionRows.filter(
        ({ id, isTransfer }) => isTransfer && !confirmedTransferTransactionIds.has(id),
      ).length,
      unconfirmedRefundFlagsCleared: transactionRows.filter(
        ({ id, isReimbursement }) => isReimbursement && !confirmedRefundTransactionIds.has(id),
      ).length,
      confirmedMovementFlagsRepaired: transactionRows.filter((transaction) =>
        confirmedMovementFlagsNeedRepair(
          transaction,
          confirmedTransferTransactionIds,
          confirmedRefundTransactionIds,
        ),
      ).length,
      userOverridesCleared: transactionRows.filter(({ userOverrideAt }) => userOverrideAt !== null)
        .length,
      splitsChanged: changedSplits.length,
      splitCategoriesCleared: splitRows.filter(({ categoryId }) => categoryId !== null).length,
      splitEnvelopesCleared: splitRows.filter(({ envelopeId }) => envelopeId !== null).length,
      aiSuggestionsDeleted: countAt(0),
      ruleRunsDeleted: countAt(1),
      envelopeRuleLinksDeleted: countAt(2),
      rulesDeleted: countAt(3),
      categoriesPreserved: countAt(4),
      confirmedTransfersPreserved: countAt(5),
      confirmedRefundsPreserved: countAt(6),
    },
  };
}

async function applyTransactionReset(
  db: BetterWealthDatabase,
  householdId: string,
  rows: readonly ResetTransaction[],
  timestamp: string,
  confirmedTransferTransactionIds: ReadonlySet<string>,
  confirmedRefundTransactionIds: ReadonlySet<string>,
): Promise<void> {
  const groups = new Map<string, ResetTransaction[]>();
  for (const row of rows) {
    const movement = confirmedTransferTransactionIds.has(row.id)
      ? "transfer"
      : confirmedRefundTransactionIds.has(row.id)
        ? "refund"
        : "ordinary";
    const clearTransferExclusion = movement === "ordinary" && row.isTransfer && row.isExcluded;
    const key = `${merchantWasCategorizationDerived(row) ? "merchant" : "keep"}:${shouldQueueForReview(row, confirmedTransferTransactionIds) ? "review" : "keep"}:${movement}:${clearTransferExclusion ? "clear-exclusion" : "keep-exclusion"}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, group] of groups) {
    const clearMerchant = key.startsWith("merchant:");
    const [, review, movement, exclusion] = key.split(":");
    const queueForReview = review === "review";
    const movementFlags =
      movement === "transfer"
        ? {
            isTransfer: true,
            isExcluded: true,
            isIncome: false,
            isReimbursement: false,
          }
        : movement === "refund"
          ? {
              isTransfer: false,
              isExcluded: false,
              isIncome: false,
              isReimbursement: true,
            }
          : {
              isTransfer: false,
              isIncome: false,
              isReimbursement: false,
              ...(exclusion === "clear-exclusion" ? { isExcluded: false } : {}),
            };
    for (const batch of chunks(group)) {
      await db
        .update(transactions)
        .set({
          categoryId: null,
          categoryOrigin: "none",
          ...(clearMerchant ? { merchantId: null } : {}),
          envelopeId: null,
          ...movementFlags,
          ...(queueForReview ? { reviewState: "needs_review" as const } : {}),
          userOverrideAt: null,
          updatedAt: timestamp,
        })
        .where(
          and(
            eq(transactions.householdId, householdId),
            inArray(
              transactions.id,
              batch.map(({ id }) => id),
            ),
          ),
        );
    }
  }
}

async function applySplitReset(
  db: BetterWealthDatabase,
  householdId: string,
  rows: readonly ResetSplit[],
): Promise<void> {
  for (const batch of chunks(rows)) {
    await db
      .update(transactionSplits)
      .set({ categoryId: null, envelopeId: null })
      .where(
        and(
          eq(transactionSplits.householdId, householdId),
          inArray(
            transactionSplits.id,
            batch.map(({ id }) => id),
          ),
        ),
      );
  }
}

async function withImmediateTransaction<T>(
  db: BetterWealthDatabase,
  operation: () => Promise<T>,
): Promise<T> {
  if (db.$client.inTransaction) {
    throw new ConflictError(
      "Categorization reset requires exclusive ownership of its SQLite connection",
      "categorization_reset_connection_busy",
    );
  }
  db.$client.exec("BEGIN IMMEDIATE");
  try {
    const result = await operation();
    db.$client.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.$client.inTransaction) db.$client.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Destructively clears household categorization state after explicit user
 * authorization. Imported ledger truth, movement flags/linkage, notes, tags,
 * splits themselves, taxonomy, budgets, and recurrences are intentionally kept.
 */
export async function resetHouseholdCategorization(
  input: ResetCategorizationInput,
): Promise<ResetCategorizationSummary> {
  if (!input.apply) {
    await assertResetAuthority(input.db, input.householdId, input.userId);
    const inspection = await inspectReset(input.db, input.householdId);
    return { mode: "dry-run", ...inspection.summary, auditEventId: null };
  }

  return withImmediateTransaction(input.db, async () => {
    await assertResetAuthority(input.db, input.householdId, input.userId);
    const inspection = await inspectReset(input.db, input.householdId);
    const timestamp = new Date().toISOString();
    await applyTransactionReset(
      input.db,
      input.householdId,
      inspection.changedTransactions,
      timestamp,
      inspection.confirmedTransferTransactionIds,
      inspection.confirmedRefundTransactionIds,
    );
    await applySplitReset(input.db, input.householdId, inspection.changedSplits);

    // rule_runs restrict deletion of winning rules; envelope links cascade but
    // are removed explicitly so the audit summary matches the executed work.
    await input.db.delete(aiSuggestions).where(eq(aiSuggestions.householdId, input.householdId));
    await input.db.delete(ruleRuns).where(eq(ruleRuns.householdId, input.householdId));
    await input.db
      .delete(envelopeRuleLinks)
      .where(eq(envelopeRuleLinks.householdId, input.householdId));
    await input.db.delete(rules).where(eq(rules.householdId, input.householdId));

    const auditEventId = ulid();
    await input.db.insert(auditEvents).values({
      id: auditEventId,
      householdId: input.householdId,
      actorUserId: input.userId,
      actorType: "user",
      action: "categorization.reset",
      entityType: "household",
      entityId: input.householdId,
      metadata: {
        ...inspection.summary,
        explicitAllRulesAuthorization: true,
        userOverridesClearedForRecategorization: true,
        preserved: [
          "raw_imported_ledger",
          "transaction_status_and_amounts",
          "provider_metadata",
          "notes_and_tags",
          "confirmed_movement_links_and_flags",
          "split_structure_amounts_and_memos",
          "category_taxonomy",
          "budgets_and_recurrences",
        ],
      },
      occurredAt: timestamp,
    });
    await input.testHooks?.beforeCommit?.();
    return { mode: "applied", ...inspection.summary, auditEventId };
  });
}
